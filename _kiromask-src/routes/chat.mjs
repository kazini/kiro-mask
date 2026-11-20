// Chat: route to Kiro (pass-through) or to a configured provider. Kiro asks in one of two wire formats:
//   aws        GenerateAssistantResponse  { conversationState: … }           → binary event stream back
//   responses  POST /v1/responses         { model, input: […], tools: […] }  → Server-Sent Events back
import { createFrameFilter } from '../aws/eventstream.mjs';
import { translateRequest } from '../translate/request.mjs';
import { describeChat, wireOf } from './describe.mjs';
import { ResponsesEncoder, awsEncoder } from '../translate/encoders.mjs';
import { OpenAIStreamTranslator } from '../translate/stream-openai.mjs';
import { AnthropicStreamTranslator } from '../translate/stream-anthropic.mjs';
import { sseEvents } from '../translate/sse.mjs';
import { estimateJsonTokens } from '../translate/tokens.mjs';
import { StreamError } from '../translate/stream-base.mjs';
import { postWithRetry, idleGuard, ProviderError, endpointFor } from '../providers/client.mjs';
import { adaptRequest, applyPatch } from '../providers/adapt.mjs';
import { readBody } from '../util.mjs';
import { startStream, chatError, httpError, describeError, makeSender } from './common.mjs';
import { handleTitle, isTitleRequest } from './title.mjs';

/** Where should this model id go? */
export function pickTarget(cfg, modelId) {
  const r = cfg.resolve(modelId);
  if (r && r !== 'native') return { kind: 'custom', entry: r };
  const nativeOk = cfg.get('kiro_endpoint.models') && !cfg.get('kiro_endpoint.auth_fake_login');
  if (nativeOk) return { kind: 'native' };
  const d = cfg.defaultEntry;
  if (d) return { kind: 'custom', entry: d, fallback: true };
  return { kind: 'none' };
}

/** Turn a non-streaming provider JSON response into the chunks the stream translators expect. */
export function* synthesizeChunks(j, type) {
  if (type === 'anthropic') {
    yield { type: 'message_start', message: { usage: j.usage || {} } };
    let i = 0;
    for (const b of j.content || []) {
      if (b.type === 'text') {
        yield { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } };
      } else if (b.type === 'tool_use') {
        yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name } };
        yield { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } };
      }
      yield { type: 'content_block_stop', index: i++ };
    }
    yield { type: 'message_delta', delta: { stop_reason: j.stop_reason }, usage: j.usage };
    return;
  }
  const msg = j.choices?.[0]?.message || {};
  yield {
    choices: [{ delta: { content: msg.content, reasoning_content: msg.reasoning_content, tool_calls: (msg.tool_calls || []).map((t, i) => ({ index: i, ...t })) }, finish_reason: j.choices?.[0]?.finish_reason || 'stop' }],
    usage: j.usage,
  };
}

/** Wrap an async iterable, calling `tap(chunk)` on each item (used to record the provider's raw stream). */
async function* tapped(source, tap) {
  for await (const c of source) { try { tap(c); } catch { /* recording must never break a request */ } yield c; }
}

export async function handleChat(ctx) {
  const { app, cfg, req, res, log } = ctx;
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return app.pass(ctx, { body: raw }); }
  const chat = describeChat(body);
  if (!chat) {
    log('debug', `${req.method} ${ctx.info.host}${ctx.info.pathname}: not a recognised chat request body; passing through`);
    return app.pass(ctx, { body: raw });
  }

  ctx.chat = chat;
  if (app.state.chatFormat !== chat.format) {
    app.state.chatFormat = chat.format;
    log('info', `chat protocol: ${chat.format === 'responses' ? 'Responses (POST /v1/responses)' : 'AWS GenerateAssistantResponse'}`);
    app.capture.setSession({ chatFormat: chat.format });
  }
  ctx.flow?.note({ model: chat.modelId, format: chat.format, conversationId: chat.conversationId ?? undefined });
  ctx.send = makeSender(ctx);

  if (isTitleRequest(chat, req.headers)) return handleTitle(ctx, raw);

  const target = pickTarget(cfg, chat.modelId);

  if (target.kind === 'native') {
    app.state.customActive = false;
    app.state.lastModel = chat.modelId;
    log('info', `chat → Kiro (${chat.modelId})`);
    const strip = cfg.get('kiro_endpoint.strip_metering');
    const filters = !strip ? {} : chat.format === 'responses' ? { sseFilter: createUsageFilter() } : { frameFilter: createFrameFilter(['meteringEvent']) };
    return app.pass(ctx, { body: raw, ...filters });
  }
  if (target.kind === 'none') {
    return chatError(res, `No usable model for "${chat.modelId}". Kiro models are disabled (or you are using fake login) and no custom default_model is configured.`, wireOf(chat));
  }

  const { entry } = target;
  ctx.requestedModel = chat.modelId;
  app.state.customActive = true;
  app.state.lastModel = entry.id;
  return streamFromProvider(ctx, body, entry, { note: target.fallback ? ` (fallback for "${chat.modelId}")` : '' });
}

/**
 * Streaming filter for Responses SSE (kiro_endpoint.strip_metering): removes the `kiro:credits` usage field from
 * each event, the counterpart of dropping `meteringEvent` frames from the AWS event stream.
 */
export function createUsageFilter() {
  let buf = '';
  const clean = (ev) => {
    if (!ev.includes('kiro:credits')) return ev;
    return ev.replace(/^data: (.*)$/m, (line, json) => {
      try {
        const j = JSON.parse(json);
        if (j?.response?.usage) delete j.response.usage['kiro:credits'];
        return `data: ${JSON.stringify(j)}`;
      } catch { return line; }
    });
  };
  return (chunk) => {
    buf += chunk.toString('utf8');
    const parts = buf.split('\n\n');
    buf = parts.pop();
    return Buffer.from(parts.map((p) => `${clean(p)}\n\n`).join(''));
  };
}

/** Translate + stream a conversation to a configured provider and relay it as an AWS event stream. */
export async function streamFromProvider(ctx, kiroBody, entry, { note = '', overrides } = {}) {
  const { app, cfg, req, res, log } = ctx;
  const started = Date.now();
  const errorMode = cfg.get('defaults.errors');
  const wire = wireOf(ctx.chat);
  const fail = (e) => (errorMode === 'http' ? httpError(res, e.status || 502, describeError(entry, e)) : chatError(res, describeError(entry, e), wire));

  let tr;
  try {
    tr = translateRequest(kiroBody, entry, await app.promptOptions());
  } catch (e) {
    log('error', `translation failed: ${e.message}`);
    return chatError(res, `could not translate the request: ${e.message}`, wire);
  }
  if (overrides) Object.assign(tr.body, overrides);
  const estimated = estimateJsonTokens(tr.body.messages) + estimateJsonTokens(tr.body.tools || []) + estimateJsonTokens(tr.body.system || '');
  ctx.flow?.note({ handled: `model ${entry.provider.name}/${entry.id}` });
  ctx.flow?.providerRequest({ url: endpointFor(entry), body: tr.body });
  log('info', `chat → ${entry.provider.name}/${entry.id}${note} · ${tr.ir.turns.length} msgs · ${tr.body.tools?.length || 0} tools · ~${estimated} tok`);

  // Abort the upstream generation as soon as Kiro stops listening (user pressed stop, window closed…).
  const ctl = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) ctl.abort(new Error('client disconnected')); });

  // Apply fixes learned from earlier rejections, and learn new ones from this one (see providers/adapt.mjs).
  tr.body = applyPatch(tr.body, app.state.adapt.get(entry.id));
  let resp;
  for (let round = 0; ; round++) {
    try {
      resp = await postWithRetry(entry, tr.body, { signal: ctl.signal, log });
      ctx.flow?.providerStatus(resp.res.status);
      break;
    } catch (e) {
      ctx.flow?.providerError(e.message);
      if (e.status) ctx.flow?.providerStatus(e.status);
      if (ctl.signal.aborted) return;
      const fix = (e.status === 400 || e.status === 422) && round < 3 ? adaptRequest(tr.body, e.message, entry.provider) : null;
      if (fix) {
        tr.body = fix.body;
        app.state.adapt.set(entry.id, { ...app.state.adapt.get(entry.id), ...fix.patch });
        log('warn', `${entry.provider.name}: ${fix.note}`);
        continue;
      }
      log('error', describeError(entry, e));
      return fail(e);
    }
  }

  startStream(res, wire.format);
  const encoder = wire.format === 'responses' ? new ResponsesEncoder({ model: ctx.requestedModel || entry.id, metadata: wire.metadata, tools: wire.tools }) : awsEncoder();
  const Translator = entry.provider.type === 'anthropic' ? AnthropicStreamTranslator : OpenAIStreamTranslator;
  const tx = new Translator({
    nameMap: tr.nameMap, reasoning: entry.reasoning, toolArgs: entry.toolArgs, modelId: ctx.requestedModel || entry.id,
    contextWindow: entry.contextWindow, estimatedPromptTokens: estimated, metering: false, encoder,
  });
  const isAnthropic = entry.provider.type === 'anthropic';
  let streamError = null;
  try {
    const ct = resp.res.headers.get('content-type') || '';
    if (/json/i.test(ct) && !/event-stream/i.test(ct)) {
      const pj = await resp.res.json();
      ctx.flow?.providerJson(pj);
      for (const c of synthesizeChunks(pj, entry.provider.type)) await ctx.send(tx.push(c));
    } else {
      const guarded = tapped(idleGuard(resp.res.body, entry.provider.timeoutMs, () => ctl.abort()), (c) => ctx.flow?.providerChunk(c));
      for await (const e of sseEvents(guarded)) {
        if (e.data === '[DONE]') break;
        let j;
        try { j = JSON.parse(e.data); } catch { continue; }
        if (isAnthropic && e.event && !j.type) j.type = e.event;
        await ctx.send(tx.push(j));
        if (res.destroyed) break;
      }
    }
  } catch (e) {
    if (ctl.signal.aborted && res.destroyed) { finished = true; return; }
    streamError = e;
    ctx.flow?.providerError(e.message);
    const msg = e instanceof StreamError || e instanceof ProviderError ? e.message : `stream error: ${e.message}`;
    log('error', `${entry.provider.name} stream failed: ${msg}`);
    tx.emitText(`\n\n⚠️ **kiromask:** ${entry.provider.name} stream interrupted: ${msg}`);
  }

  finished = true;
  if (!res.destroyed) {
    await ctx.send([...tx.drain(), ...tx.finish()]);
    res.end();
  }
  ctl.abort(); // release the upstream connection
  const ms = Date.now() - started;
  const u = tx.usage;
  log('info', `  ↳ done in ${(ms / 1000).toFixed(1)}s · ${tx.stats.textChars} chars · ${tx.stats.toolCalls} tool call(s)${tx.stats.repairedToolCalls ? ` (${tx.stats.repairedToolCalls} repaired)` : ''} · ${u.prompt}+${u.completion} tok${u.reported ? '' : ' (estimated)'}`);
  app.usage.record({ model: entry.id, provider: entry.provider.name, conversationId: ctx.chat?.conversationId ?? undefined, prompt: u.prompt, completion: u.completion, estimated: !u.reported, ms, error: streamError?.message });
}
