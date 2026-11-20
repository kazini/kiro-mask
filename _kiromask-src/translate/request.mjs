// Translate a Kiro chat request into an OpenAI Chat Completions or Anthropic Messages request.
// Kiro sends chat in one of two wire formats (see _kiromask_diag-n-test/network-protocol-notes.md); both are understood:
//   • AWS      { conversationState: { history, currentMessage… } }   → GenerateAssistantResponse
//   • Responses { model, input: [ …messages, function_call, function_call_output ], tools }  → POST /v1/responses
//
// Two stages keep this simple and testable:
//   1. parseKiroRequest() / parseResponsesRequest() → provider-neutral IR  (system, turns, tools)
//   2. toOpenAI() / toAnthropic() → provider body
//
// Everything is derived from the request itself — no cross-request state. (Kiro always includes the
// assistant turn that issued a tool call in the history, so no cache of earlier calls is needed.)

import { sanitizeSchema } from './schema.mjs';

export const ACK_RE = /^\s*I will follow these instructions\.?\s*$/i;
const SAFE_NAME = /[^a-zA-Z0-9_-]/g;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// ── parsing helpers ─────────────────────────────────────────────────────────

function resultText(r) {
  const c = r?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return c == null ? '' : JSON.stringify(c);
  return c
    .map((p) => (typeof p === 'string' ? p : p?.text !== undefined ? p.text : p?.json !== undefined ? JSON.stringify(p.json) : ''))
    .filter((s) => s !== '')
    .join('\n');
}

function normalizeBytes(bytes) {
  if (typeof bytes === 'string') return bytes;
  if (Array.isArray(bytes)) return Buffer.from(bytes).toString('base64');
  if (bytes && typeof bytes === 'object') return Buffer.from(Object.values(bytes)).toString('base64'); // JSON-ified Uint8Array
  return '';
}

function normalizeImages(images) {
  return (images || [])
    .map((img) => {
      const fmt = String(img?.format || 'png').toLowerCase();
      return { mediaType: MIME[fmt] || `image/${fmt}`, data: normalizeBytes(img?.source?.bytes ?? img?.bytes) };
    })
    .filter((i) => i.data);
}

export function normalizeInput(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input === 'string' && input.trim()) {
    try { const v = JSON.parse(input); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  return {};
}

const userTurn = (u) => {
  const ctx = u?.userInputMessageContext || {};
  return {
    role: 'user',
    text: u?.content || '',
    images: normalizeImages(u?.images),
    toolResults: (ctx.toolResults || []).map((r) => ({
      id: r.toolUseId,
      text: resultText(r),
      isError: !!r.status && !/^(success|ok)$/i.test(r.status),
    })),
  };
};

const assistantTurn = (a, text) => ({
  role: 'assistant',
  text,
  toolUses: (a?.toolUses ?? a?.toolUse ?? []).map((t) => ({ id: t.toolUseId, name: t.name, input: normalizeInput(t.input) })),
});

/** Drop tool calls without results and re-home results without calls, so providers never see a broken pair. */
export function repairPairing(turns) {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role === 'assistant' && t.toolUses.length) {
      const next = turns[i + 1];
      const answered = new Set(next?.role === 'user' ? next.toolResults.map((r) => r.id) : []);
      t.toolUses = t.toolUses.filter((u) => answered.has(u.id));
    }
    if (t.role === 'user' && t.toolResults.length) {
      const prev = turns[i - 1];
      const called = new Set(prev?.role === 'assistant' ? prev.toolUses.map((u) => u.id) : []);
      const orphans = t.toolResults.filter((r) => !called.has(r.id));
      if (orphans.length) {
        t.toolResults = t.toolResults.filter((r) => called.has(r.id));
        const note = orphans.map((r) => `[Earlier tool result]\n${r.text}`).join('\n\n');
        t.text = t.text ? `${note}\n\n${t.text}` : note;
      }
    }
  }
  return turns.filter((t) => t.role === 'user' || t.text.trim() || t.toolUses.length);
}

export function mergeSameRole(turns) {
  const out = [];
  for (const t of turns) {
    const last = out.at(-1);
    if (last && last.role === t.role) {
      last.text = [last.text, t.text].filter((s) => s && s.trim()).join('\n\n');
      if (t.role === 'user') { last.images.push(...t.images); last.toolResults.push(...t.toolResults); }
      else last.toolUses.push(...t.toolUses);
    } else {
      out.push({ ...t, ...(t.role === 'user' ? { images: [...t.images], toolResults: [...t.toolResults] } : { toolUses: [...t.toolUses] }) });
    }
  }
  return out;
}

/**
 * @param {object} body  parsed Kiro request body
 * @param {{extractSystem?: boolean}} [opts]
 */
export function parseKiroRequest(body, { extractSystem = true } = {}) {
  const cs = body?.conversationState;
  if (!cs?.currentMessage?.userInputMessage) throw new Error('not a Kiro conversation request (no currentMessage.userInputMessage)');
  const current = cs.currentMessage.userInputMessage;
  const history = cs.history || [];

  // Kiro opens every conversation with its system prompt as a user turn, answered by a canned acknowledgement.
  const first = history[0]?.userInputMessage;
  const second = history[1]?.assistantResponseMessage;
  const hasSystem = extractSystem && !!first && !first.userInputMessageContext?.toolResults?.length
    && ((second && ACK_RE.test(second.content || '')) || /^\s*# Kiro - System Prompt/.test(first.content || ''));
  let system = null;
  let skipAck = false;
  let turns = [];
  history.forEach((item, idx) => {
    if (item.userInputMessage) {
      const u = item.userInputMessage;
      if (hasSystem && idx === 0) {
        system = u.content;
        skipAck = true;
        return;
      }
      turns.push(userTurn(u));
    } else if (item.assistantResponseMessage) {
      const a = item.assistantResponseMessage;
      let text = a.content || '';
      if (skipAck && idx === 1 && ACK_RE.test(text)) text = '';
      turns.push(assistantTurn(a, text));
    }
  });
  turns.push(userTurn(current));

  turns = mergeSameRole(repairPairing(turns));
  if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', text: '(start of conversation)', images: [], toolResults: [] });

  const last = turns.at(-1);
  if (!last.text.trim() && !last.images.length && !last.toolResults.length) last.text = 'Continue.';

  const ctx = current.userInputMessageContext || {};
  const tools = (ctx.tools || []).map((t) => {
    const spec = t.toolSpecification || t;
    return { name: spec.name, description: spec.description || '', schema: spec.inputSchema?.json ?? spec.inputSchema ?? {} };
  });

  return { conversationId: cs.conversationId, modelId: current.modelId, agentMode: body.agentMode ?? null, system, turns, tools };
}

// ── Responses format (POST /v1/responses) ──────────────────────────────────

/** Does this look like a Responses-API chat request (as opposed to the AWS `conversationState` one)? */
export function isResponsesRequest(body) {
  return !!body && typeof body === 'object' && !body.conversationState && typeof body.model === 'string'
    && (Array.isArray(body.input) || typeof body.input === 'string');
}

const partText = (p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : typeof p?.refusal === 'string' ? p.refusal : '');

/** The text of a message `content` (a string, or an array of input_text / output_text / … parts). */
export function responsesText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(partText).filter((t) => t !== '').join('\n');
}

function responsesImages(content) {
  if (!Array.isArray(content)) return { images: [], notes: [] };
  const images = [];
  const notes = [];
  for (const p of content) {
    if (p?.type !== 'input_image' && p?.type !== 'image_url') continue;
    const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url ?? p.url;
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
    if (m) images.push({ mediaType: m[1], data: m[2] });
    else if (url) notes.push(`[image: ${url}]`); // a remote URL cannot be inlined; at least tell the model it exists
  }
  return { images, notes };
}

function outputText(o) {
  if (typeof o === 'string') return o;
  if (o == null) return '';
  if (Array.isArray(o)) return o.map((p) => (typeof p === 'string' ? p : p?.text !== undefined ? p.text : JSON.stringify(p))).join('\n');
  return typeof o === 'object' && typeof o.text === 'string' ? o.text : JSON.stringify(o);
}

/**
 * @param {object} body  parsed `/v1/responses` request body
 * @param {{extractSystem?: boolean}} [opts]
 */
export function parseResponsesRequest(body, { extractSystem = true } = {}) {
  if (!isResponsesRequest(body)) throw new Error('not a Responses request (need "model" and "input")');
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input.filter((i) => i && typeof i === 'object');
  const isMsg = (it, role) => !!it && (it.type === undefined || it.type === 'message') && it.role === role;

  // Kiro opens every conversation with its system prompt as a user message, answered by a canned acknowledgement.
  const first = items[0];
  const second = items[1];
  const hasSystem = extractSystem && isMsg(first, 'user')
    && ((isMsg(second, 'assistant') && ACK_RE.test(responsesText(second.content))) || /^\s*# Kiro - System Prompt/.test(responsesText(first.content)));

  let system = null;
  const extra = [];
  let turns = [];
  items.forEach((it, idx) => {
    if (hasSystem && idx === 0) { system = responsesText(it.content); return; }
    if (hasSystem && idx === 1 && isMsg(it, 'assistant') && ACK_RE.test(responsesText(it.content))) return;

    if (it.type === 'function_call') {
      turns.push({ role: 'assistant', text: '', toolUses: [{ id: it.call_id ?? it.id, name: it.name, input: normalizeInput(it.arguments) }] });
    } else if (it.type === 'function_call_output') {
      const status = String(it.status ?? '');
      turns.push({ role: 'user', text: '', images: [], toolResults: [{ id: it.call_id, text: outputText(it.output), isError: it.is_error === true || /^(error|failed|incomplete)$/i.test(status) }] });
    } else if (it.type === undefined || it.type === 'message') {
      if (it.role === 'assistant') {
        turns.push({ role: 'assistant', text: responsesText(it.content), toolUses: [] });
      } else if (it.role === 'system' || it.role === 'developer') {
        const t = responsesText(it.content);
        if (t.trim()) extra.push(t);
      } else {
        const { images, notes } = responsesImages(it.content);
        turns.push({ role: 'user', text: [responsesText(it.content), ...notes].filter(Boolean).join('\n'), images, toolResults: [] });
      }
    } // reasoning items, item references, built-in tool calls: nothing a Chat Completions provider could use
  });

  // Every function_call / function_call_output is its own item here, so group them into turns BEFORE checking the
  // call/result pairing (the AWS format arrives pre-grouped).
  turns = mergeSameRole(repairPairing(mergeSameRole(turns)));
  if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', text: '(start of conversation)', images: [], toolResults: [] });
  const last = turns.at(-1);
  if (!last.text.trim() && !last.images.length && !last.toolResults.length) last.text = 'Continue.';

  const sys = [system, typeof body.instructions === 'string' ? body.instructions : null, ...extra].filter((x) => x && String(x).trim());
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t) => t && (t.type === 'function' || (t.type === undefined && t.name)))
    .map((t) => ({ name: t.name ?? t.function?.name, description: t.description ?? t.function?.description ?? '', schema: t.parameters ?? t.function?.parameters ?? {} }))
    .filter((t) => t.name);

  const md = body.metadata || {};
  return {
    conversationId: md['kiro:conversation_id'] ?? md['kiro:root_conversation_id'] ?? null,
    modelId: body.model,
    agentMode: md['kiro:agent_mode'] ?? null,
    system: sys.length ? sys.join('\n\n') : null,
    turns,
    tools,
  };
}

/** Parse a chat request in either wire format. */
export const parseChatRequest = (body, opts) => (isResponsesRequest(body) ? parseResponsesRequest(body, opts) : parseKiroRequest(body, opts));

/** Add prompt customisations from config to the IR's system prompt. */
export function applyPrompt(ir, { override, prepend, append, preamble } = {}) {
  const base = override ?? ir.system ?? '';
  // The preamble stands in for Kiro's server-side main prompt, so it only applies next to the short "(contd.)"
  // supplement (or when there is no system prompt at all) and never on top of a full prompt or an override.
  const supplementOnly = !ir.system || /\(contd\.?\)/i.test(ir.system.slice(0, 200));
  const parts = [prepend, preamble && override == null && supplementOnly ? preamble : '', base, append].filter((p) => p && String(p).trim());
  ir.system = parts.length ? parts.join('\n\n') : null;
  return ir;
}

// ── naming ──────────────────────────────────────────────────────────────────

/** Providers restrict tool names to [A-Za-z0-9_-]{1,64}. Build a reversible mapping. */
export function makeNameMap(names) {
  const toSafe = new Map();
  const toOriginal = new Map();
  for (const original of new Set(names.filter(Boolean))) {
    let safe = original.replace(SAFE_NAME, '_').slice(0, 64) || 'tool';
    for (let n = 2; toOriginal.has(safe) && toOriginal.get(safe) !== original; n++) safe = `${safe.slice(0, 60)}_${n}`;
    toSafe.set(original, safe);
    toOriginal.set(safe, original);
  }
  return { toSafe, toOriginal, safe: (n) => toSafe.get(n) ?? String(n).replace(SAFE_NAME, '_').slice(0, 64) };
}

const safeId = (id) => String(id ?? '').replace(SAFE_NAME, '_');

function prepare(ir, entry) {
  const names = [...ir.tools.map((t) => t.name), ...ir.turns.flatMap((t) => (t.toolUses || []).map((u) => u.name))];
  const nameMap = makeNameMap(names);
  const tools = ir.tools.map((t) => ({
    name: nameMap.safe(t.name),
    description: t.description,
    schema: sanitizeSchema(t.schema, entry.schema),
  }));
  return { nameMap, tools };
}

const errText = (r) => (r.isError && !/^error\b/i.test(r.text) ? `Error: ${r.text || 'tool execution failed'}` : r.text || (r.isError ? 'Error: tool execution failed' : '(empty result)'));

// ── OpenAI Chat Completions ─────────────────────────────────────────────────

export function toOpenAI(ir, entry) {
  const q = entry.quirks || {};
  const { nameMap, tools } = prepare(ir, entry);
  const messages = [];
  if (ir.system) messages.push({ role: 'system', content: ir.system });

  for (const t of ir.turns) {
    if (t.role === 'assistant') {
      const m = { role: 'assistant', content: t.text || (t.toolUses.length && !q.assistant_empty_content ? null : '') };
      if (t.toolUses.length) {
        m.tool_calls = t.toolUses.map((u) => ({
          id: safeId(u.id),
          type: 'function',
          function: { name: nameMap.safe(u.name), arguments: JSON.stringify(u.input ?? {}) },
        }));
      }
      messages.push(m);
      continue;
    }
    const toolMsgs = t.toolResults.map((r) => ({ role: 'tool', tool_call_id: safeId(r.id), content: errText(r) }));
    messages.push(...toolMsgs);

    const images = entry.supportsImages === false ? [] : t.images;
    const text = entry.supportsImages === false && t.images.length ? `${t.text}\n[${t.images.length} image(s) omitted: model has no vision]`.trim() : t.text;
    if (!text.trim() && !images.length) continue;
    if (toolMsgs.length && q.fold_user_after_tool) {
      toolMsgs.at(-1).content += `\n\n${text}`;
    } else if (images.length) {
      messages.push({
        role: 'user',
        content: [
          ...(text.trim() ? [{ type: 'text', text }] : []),
          ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })),
        ],
      });
    } else {
      messages.push({ role: 'user', content: text });
    }
  }

  const body = { model: entry.upstreamModel, messages, stream: true };
  if (!q.no_stream_usage) body.stream_options = { include_usage: true };
  if (entry.maxTokens) body[entry.provider.maxTokensParam] = entry.maxTokens;
  if (entry.temperature != null) body.temperature = entry.temperature;
  if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  Object.assign(body, entry.extraBody);
  return { body, nameMap };
}

// ── Anthropic Messages ──────────────────────────────────────────────────────

export function toAnthropic(ir, entry) {
  const { nameMap, tools } = prepare(ir, entry);
  const cache = entry.promptCaching ? { cache_control: { type: 'ephemeral' } } : {};
  const messages = [];

  for (const t of ir.turns) {
    const content = [];
    if (t.role === 'assistant') {
      if (t.text.trim()) content.push({ type: 'text', text: t.text });
      for (const u of t.toolUses) content.push({ type: 'tool_use', id: safeId(u.id), name: nameMap.safe(u.name), input: u.input ?? {} });
      if (!content.length) continue;
      messages.push({ role: 'assistant', content });
      continue;
    }
    // Anthropic requires tool_result blocks first in the user message.
    for (const r of t.toolResults) {
      content.push({ type: 'tool_result', tool_use_id: safeId(r.id), content: errText(r), ...(r.isError ? { is_error: true } : {}) });
    }
    if (entry.supportsImages !== false) {
      for (const i of t.images) content.push({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } });
    }
    if (t.text.trim()) content.push({ type: 'text', text: t.text });
    if (!content.length) content.push({ type: 'text', text: '(empty message)' });
    messages.push({ role: 'user', content });
  }

  if (entry.promptCaching && messages.length) {
    const lastBlock = messages.at(-1).content.at(-1);
    if (lastBlock && lastBlock.type !== 'tool_result') Object.assign(lastBlock, cache);
  }

  const body = { model: entry.upstreamModel, max_tokens: entry.maxTokens || 16384, stream: true, messages };
  if (ir.system) body.system = [{ type: 'text', text: ir.system, ...cache }];
  if (tools.length) {
    body.tools = tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
      ...(i === tools.length - 1 ? cache : {}),
    }));
  }
  if (entry.temperature != null) body.temperature = entry.temperature;
  Object.assign(body, entry.extraBody);
  return { body, nameMap };
}

/** Translate for the model's provider type. Returns { body, nameMap, ir }. */
export function translateRequest(kiroBody, entry, promptOpts = {}) {
  const ir = parseChatRequest(kiroBody, { extractSystem: promptOpts.asSystem !== false });
  applyPrompt(ir, promptOpts);
  const out = entry.provider.type === 'anthropic' ? toAnthropic(ir, entry) : toOpenAI(ir, entry);
  return { ...out, ir };
}
