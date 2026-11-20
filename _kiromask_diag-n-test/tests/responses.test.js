// The `POST /v1/responses` chat protocol ("create_response") that current Kiro builds use.
// Fixtures in fixtures/responses/ are REAL recordings from Kiro 1.4.178 (paths/ids sanitised).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../../_kiromask-src/routes/index.mjs';
import { describeChat } from '../../_kiromask-src/routes/describe.mjs';
import { isTitleRequest } from '../../_kiromask-src/routes/title.mjs';
import { parseResponsesRequest, parseChatRequest, isResponsesRequest, translateRequest } from '../../_kiromask-src/translate/request.mjs';
import { sanitizeSchema } from '../../_kiromask-src/translate/schema.mjs';
import { ResponsesEncoder, responsesTextStream } from '../../_kiromask-src/translate/encoders.mjs';
import { OpenAIStreamTranslator } from '../../_kiromask-src/translate/stream-openai.mjs';
import { createUsageFilter } from '../../_kiromask-src/routes/chat.mjs';
import { Config } from '../../_kiromask-src/config/load.mjs';
import { startApp, viaProxy, mockServer, RUNTIME_HOST, providerConfig, sseHead, sseWrite } from './harness.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'responses');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const req = (name) => JSON.parse(fixture(`${name}.req.json`));
const sse = (text) => [...String(text).matchAll(/^event: (\S+)\ndata: (.*)$/gm)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
const completed = (evs) => evs.find((e) => e.type === 'response.completed').data.response;

const OA = new Config({ providers: { oa: { enabled: true, type: 'openai', api_base: 'http://x/v1', api_key: 'k', models: [{ name: 'm' }] } } }, { env: {} }).resolve('m');
const AN = new Config({ providers: { an: { enabled: true, type: 'anthropic', api_key: 'k', models: [{ name: 'm' }] } } }, { env: {} }).resolve('m');

const post = (h, body, headers = {}) => viaProxy(h.port, h.caPem, RUNTIME_HOST, { method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: 'Bearer real-token', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ── routing & detection ────────────────────────────────────────────────────
test('classify: POST /v1/responses is chat, whatever the host', () => {
  assert.equal(classify({ host: RUNTIME_HOST, pathname: '/v1/responses', target: '' }), 'chat');
  assert.equal(classify({ host: 'q.us-east-1.amazonaws.com', pathname: '/responses', target: '' }), 'chat');
  assert.equal(classify({ host: 'telemetry.us-east-1.kiro.dev', pathname: '/v1/traces', target: '' }), 'telemetry');
  assert.equal(classify({ host: RUNTIME_HOST, pathname: '/v1/something-else', target: '' }), 'other');
});

test('describeChat / isTitleRequest: both wire formats, real title request', () => {
  const t = describeChat(req('title'));
  assert.deepEqual([t.format, t.modelId, t.agentMode], ['responses', 'simple-task', 'session-title']);
  assert.match(t.userText, /<first_message>/);
  assert.ok(isTitleRequest(req('title')), 'raw Responses body');
  assert.ok(isTitleRequest(t), 'summary');
  assert.ok(!isTitleRequest(req('chat-first')));
  const c = describeChat(req('chat-first'));
  assert.equal(c.modelId, 'qwen3-coder-next');
  assert.match(c.conversationId, /^sess_/);
  assert.equal(c.tools.length, 8);
  assert.equal(describeChat({ hello: 1 }), null);
  assert.equal(describeChat({ conversationState: { currentMessage: { userInputMessage: { modelId: 'x', content: 'hi' } } } }).format, 'aws');
  assert.ok(isTitleRequest({ model: 'simple-task', input: [{ role: 'user', content: 'You write a short title for a coding assistant session. <first_message>\nhi\n</first_message>' }] }), 'by model + prompt, without metadata');
});

// ── request parsing ────────────────────────────────────────────────────────
test('parse: real request with three tool rounds → paired turns, system extracted, tools unwrapped', () => {
  const body = JSON.parse(fixture('chat-tools.req.json'));
  assert.ok(isResponsesRequest(body));
  const ir = parseChatRequest(body);
  assert.match(ir.system, /^# Kiro - System Prompt/);
  assert.deepEqual(ir.turns.map((t) => `${t.role}${t.toolUses?.length ? `:${t.toolUses.length}calls` : ''}${t.toolResults?.length ? `:${t.toolResults.length}results` : ''}`), ['user', 'assistant:3calls', 'user:3results']);
  const uses = ir.turns[1].toolUses.map((u) => u.id).sort();
  assert.deepEqual(ir.turns[2].toolResults.map((r) => r.id).sort(), uses, 'every call has its result');
  assert.equal(ir.turns[1].text.trim().startsWith('Let me explore'), true, 'assistant text kept with its calls');
  assert.equal(ir.tools.length, 8);
  assert.deepEqual(ir.tools[0].schema.required, ['command']);
  assert.equal(ir.agentMode, 'default-v2');
  assert.equal(ir.turns[1].toolUses[0].input.description, 'List root directory contents', 'arguments JSON string parsed');
});

test('parse: function_call items are grouped into turns BEFORE pairing is checked (regression)', () => {
  const ir = parseResponsesRequest({ model: 'm', input: [
    { role: 'user', content: 'go' },
    { type: 'function_call', call_id: 'a', name: 't', arguments: '{"x":1}' },
    { type: 'function_call', call_id: 'b', name: 't', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: 'ra' },
    { type: 'function_call_output', call_id: 'b', output: 'rb' },
  ] });
  assert.equal(ir.turns[1].toolUses.length, 2);
  assert.equal(ir.turns[2].toolResults.length, 2);
});

test('parse: unanswered calls are dropped, orphan results become text, roles may be system/developer, instructions kept', () => {
  const ir = parseResponsesRequest({ model: 'm', instructions: 'Be brief.', input: [
    { role: 'developer', content: 'dev rule' },
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_image', image_url: { url: 'https://x/y.png' } }] },
    { type: 'function_call', call_id: 'lost', name: 't', arguments: '{}' },
    { type: 'function_call_output', call_id: 'orphan', output: [{ type: 'input_text', text: 'late result' }] },
    { type: 'reasoning', summary: [] },
  ] });
  assert.match(ir.system, /Be brief\.[\s\S]*dev rule|dev rule[\s\S]*Be brief/);
  assert.deepEqual(ir.turns.map((t) => t.role), ['user']);
  assert.deepEqual(ir.turns[0].images, [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.match(ir.turns[0].text, /hello/);
  assert.match(ir.turns[0].text, /\[image: https:\/\/x\/y\.png\]/);
  assert.match(ir.turns[0].text, /late result/);
  assert.equal(ir.turns[0].toolResults.length, 0);
});

test('parse: string input, empty last turn, tool output flagged as error, chat-completions style tools', () => {
  assert.equal(parseResponsesRequest({ model: 'm', input: 'just text' }).turns[0].text, 'just text');
  const ir = parseResponsesRequest({ model: 'm', tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }, { type: 'web_search_preview' }], input: [
    { role: 'user', content: 'x' }, { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: 'boom', status: 'incomplete' },
  ] });
  assert.equal(ir.turns[2].toolResults[0].isError, true);
  assert.deepEqual(ir.tools.map((t) => t.name), ['f'], 'non-function tools are ignored');
  assert.throws(() => parseResponsesRequest({ model: 'm' }), /not a Responses request/);
});

test('translate: real request → OpenAI and Anthropic bodies keep every call/result pair', () => {
  const body = JSON.parse(fixture('chat-tools.req.json'));
  const oa = translateRequest(body, OA, { preamble: 'PRE', asSystem: true }).body;
  assert.deepEqual(oa.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'tool']);
  assert.match(oa.messages[0].content, /^PRE/);
  assert.equal(oa.messages[2].tool_calls.length, 3);
  assert.equal(oa.tools.length, 8);
  const an = translateRequest(body, AN, { asSystem: true }).body;
  assert.deepEqual(an.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(an.messages[2].content.filter((b) => b.type === 'tool_result').length, 3);
});

test('schema: nullable type arrays from the Responses tool format collapse to plain types', () => {
  const s = sanitizeSchema({ type: 'object', properties: { a: { type: ['string', 'null'] }, b: { type: ['string', 'number'] }, c: { type: ['null', 'number'], description: 'x' } } });
  assert.equal(s.properties.a.type, 'string');
  assert.deepEqual(s.properties.b.type, ['string', 'number']);
  assert.deepEqual(s.properties.c, { type: 'number', description: 'x' });
  for (const t of parseResponsesRequest(JSON.parse(fixture('chat-first.req.json'))).tools) {
    assert.ok(!/\["[a-z]+","null"\]/.test(JSON.stringify(sanitizeSchema(t.schema))), `${t.name}: no nullable type arrays left`);
  }
});

// ── the encoder vs. the REAL server's stream ───────────────────────────────
test('encoder: every event type has exactly the fields the real service sends', () => {
  const shape = (v, d = 0) => Array.isArray(v) ? [v.length && d < 3 ? shape(v[0], d + 1) : []] : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, d > 3 ? typeof v[k] : shape(v[k], d + 1)])) : v === null ? 'null' : typeof v;
  const real = {};
  for (const f of ['chat-first.res.txt', 'chat-tools.res.txt', 'title.res.txt']) for (const e of sse(fixture(f))) real[e.type] ??= shape(e.data);
  const tools = req('chat-first').tools;
  const enc = new ResponsesEncoder({ model: 'm', metadata: { k: 1 }, tools });
  const out = [...enc.initial(), ...enc.text('hi'), ...enc.toolStart('read_file', 'c1'), ...enc.toolInput('read_file', 'c1', '{"a":1}'), ...enc.toolStop('read_file', 'c1'), ...enc.metadata('TOOL_USE'), ...enc.contextUsage(2), ...enc.end()];
  const mine = {};
  for (const e of sse(Buffer.concat(out).toString())) mine[e.type] ??= shape(e.data);
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); if (c.response) { delete c.response.metadata; delete c.response.tools; } return c; };
  for (const k of Object.keys(real)) assert.deepEqual(strip(mine[k]), strip(real[k]), `event ${k}`);
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(real).sort(), 'same set of event types');
});

test('encoder: sequence numbers, item ids, output indexes, statuses', () => {
  const enc = new ResponsesEncoder({ model: 'm' });
  const out = [...enc.initial(), ...enc.text('Hel'), ...enc.text('lo'), ...enc.toolStart('a', 'c1'), ...enc.toolInput('a', 'c1', '{'), ...enc.toolInput('a', 'c1', '}'), ...enc.toolStop('a', 'c1'),
    ...enc.text('after'), ...enc.metadata('TOOL_USE'), ...enc.end()];
  const evs = sse(Buffer.concat(out).toString());
  assert.deepEqual(evs.map((e) => e.data.sequence_number), evs.map((_, i) => i), 'sequence_number counts up from 0');
  assert.deepEqual(evs.map((e) => e.type).slice(0, 2), ['response.created', 'response.in_progress']);
  const r = completed(evs);
  assert.equal(r.status, 'requires_action');
  assert.deepEqual(r.output.map((i) => i.type), ['message', 'function_call', 'message'], 'text, call, text — in order, as separate items');
  assert.equal(r.output[0].content[0].text, 'Hello');
  assert.deepEqual([r.output[1].call_id, r.output[1].name, r.output[1].arguments, r.output[1].status], ['c1', 'a', '{}', 'completed']);
  assert.deepEqual(evs.filter((e) => e.type === 'response.output_item.added').map((e) => e.data.output_index), [0, 1, 2]);
  assert.ok(Buffer.concat(out).toString().endsWith('data: [DONE]\n\n'));
  assert.equal(r.usage['kiro:credits'].value, 0);
});

test('encoder: text-only turn is `completed`; an empty text event opens nothing; interleaved tool calls stay separate', () => {
  const e1 = new ResponsesEncoder({ model: 'm' });
  assert.deepEqual(e1.text(''), []);
  const r1 = completed(sse(Buffer.concat([...e1.initial(), ...e1.text('x'), ...e1.metadata('END_TURN'), ...e1.end()]).toString()));
  assert.equal(r1.status, 'completed');
  const e2 = new ResponsesEncoder({ model: 'm' });
  const out = [...e2.toolStart('a', 'c1'), ...e2.toolStart('b', 'c2'), ...e2.toolInput('a', 'c1', '{"p":'), ...e2.toolInput('b', 'c2', '{"q":2}'), ...e2.toolInput('a', 'c1', '1}'), ...e2.toolStop('b', 'c2'), ...e2.toolStop('a', 'c1'), ...e2.end()];
  const r2 = completed(sse(Buffer.concat(out).toString()));
  assert.deepEqual(r2.output.map((i) => [i.name, i.arguments]), [['a', '{"p":1}'], ['b', '{"q":2}']]);
});

test('encoder: end() is idempotent and closes a call that never stopped', () => {
  const e = new ResponsesEncoder({ model: 'm' });
  const out = [...e.toolStart('a', 'c1'), ...e.toolInput('a', 'c1', '{"z":1}'), ...e.end(), ...e.end()];
  const evs = sse(Buffer.concat(out).toString());
  assert.equal(evs.filter((x) => x.type === 'response.completed').length, 1);
  assert.equal(completed(evs).output[0].arguments, '{"z":1}');
});

test('stream translator drives the Responses encoder: text, <think> filtering, buffered tool call with repaired JSON', () => {
  const enc = new ResponsesEncoder({ model: 'my-model' });
  const tx = new OpenAIStreamTranslator({ encoder: enc, modelId: 'my-model', contextWindow: 1000, nameMap: undefined });
  const out = [];
  for (const c of [
    { choices: [{ delta: { content: '<think>hmm</think>Looking' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.ts",}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 250, completion_tokens: 5 } },
  ]) out.push(...tx.push(c));
  out.push(...tx.finish());
  const evs = sse(Buffer.concat(out).toString());
  const r = completed(evs);
  assert.equal(r.status, 'requires_action');
  assert.equal(r.output[0].content[0].text, 'Looking');
  assert.deepEqual(JSON.parse(r.output[1].arguments), { path: 'a.ts' });
  assert.equal(r.usage['kiro:context_usage_percentage'], 25);
  assert.equal(r.model, 'my-model');
});

test('stream: `reasoning: native` has no Responses counterpart and is dropped (no crash, no leak into the answer)', () => {
  const enc = new ResponsesEncoder({ model: 'm' });
  const tx = new OpenAIStreamTranslator({ encoder: enc, reasoning: 'native' });
  const out = [...tx.push({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }), ...tx.push({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }), ...tx.finish()];
  assert.equal(completed(sse(Buffer.concat(out).toString())).output[0].content[0].text, 'answer');
});

test('responsesTextStream is a complete, valid stream', () => {
  const evs = sse(Buffer.concat(responsesTextStream('⚠️ boom', { model: 'm', contextPct: 1.5 })).toString());
  assert.equal(completed(evs).output[0].content[0].text, '⚠️ boom');
  assert.equal(completed(evs).usage['kiro:context_usage_percentage'], 1.5);
});

test('createUsageFilter removes kiro:credits from SSE events, across chunk boundaries', () => {
  const stream = fixture('title.res.txt');
  const f = createUsageFilter();
  const mid = Math.floor(stream.length / 2);
  const out = Buffer.concat([f(Buffer.from(stream.slice(0, mid))), f(Buffer.from(stream.slice(mid)))]).toString();
  assert.ok(!out.includes('kiro:credits'));
  assert.ok(out.includes('kiro:context_usage_percentage'));
  assert.equal(sse(out).length, sse(stream).length, 'no events lost or duplicated');
});

// ── through the real proxy ─────────────────────────────────────────────────
const toolProvider = () => mockServer((rq, res) => {
  sseHead(res);
  sseWrite(res, { choices: [{ delta: { content: 'Let me ' } }] });
  sseWrite(res, { choices: [{ delta: { content: 'look.' } }] });
  sseWrite(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }] });
  sseWrite(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 12 } });
  sseWrite(res, '[DONE]'); res.end();
});

test('proxy: a custom model on /v1/responses is answered from the provider, as SSE, and never reaches Kiro', async () => {
  const provider = await toolProvider();
  let awsHits = 0;
  const h = await startApp(providerConfig(provider.port), { awsHandler: (rq, res) => { awsHits++; res.writeHead(500); res.end(); } });
  try {
    const body = req('chat-tools');
    body.model = 'my-model';
    const r = await post(h, body);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/event-stream/);
    const evs = sse(r.body.toString());
    const resp = completed(evs);
    assert.equal(resp.status, 'requires_action');
    assert.equal(resp.model, 'my-model');
    assert.equal(resp.output[0].content[0].text, 'Let me look.');
    assert.deepEqual([resp.output[1].call_id, resp.output[1].name, JSON.parse(resp.output[1].arguments)], ['call_9', 'read_file', { path: 'a.ts' }]);
    assert.deepEqual(resp.metadata, body.metadata, 'Kiro metadata echoed back');
    assert.equal(awsHits, 0, 'nothing went to Kiro servers');
    assert.equal(h.app.state.customActive, true);
    assert.equal(h.app.state.chatFormat, 'responses');
    const sent = JSON.parse(provider.seen[0].body);
    assert.equal(sent.model, 'my-model');
    assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'tool']);
    assert.equal(sent.tools.length, 8);
    assert.ok(h.logs.some((l) => /chat protocol: Responses/.test(l)));
  } finally { await h.stop(); provider.close(); }
});

test('proxy: Kiro-model chat on /v1/responses passes through untouched (and `customActive` resets)', async () => {
  const provider = await toolProvider();
  const real = fixture('chat-first.res.txt');
  const h = await startApp(providerConfig(provider.port), { awsHandler: (rq, res, rec) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(real); } });
  try {
    h.app.state.customActive = true;
    const r = await post(h, req('chat-first')); // model qwen3-coder-next = a Kiro model
    assert.equal(r.body.toString(), real);
    assert.equal(h.aws.seen.length, 1);
    assert.equal(JSON.parse(h.aws.seen[0].body).model, 'qwen3-coder-next', 'forwarded byte-for-byte');
    assert.equal(h.app.state.customActive, false);
    assert.equal(provider.seen.length, 0);
  } finally { await h.stop(); provider.close(); }
});

test('proxy: session title on /v1/responses is written locally in the Responses format', async () => {
  const provider = await toolProvider();
  const h = await startApp(providerConfig(provider.port), { awsHandler: (rq, res) => { res.writeHead(500); res.end(); } });
  try {
    const r = await post(h, req('title'));
    const evs = sse(r.body.toString());
    const resp = completed(evs);
    assert.equal(resp.model, 'simple-task');
    assert.equal(resp.output[0].content[0].text, 'Explain This Codebase');
    assert.equal(h.aws.seen.length, 0, 'the first message never left the machine');
    assert.equal(provider.seen.length, 0);
  } finally { await h.stop(); provider.close(); }
});

test('proxy: provider errors appear in the conversation as a valid Responses stream (and as HTTP with errors: http)', async () => {
  const provider = await mockServer((rq, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Invalid API key"}}'); });
  const h = await startApp(providerConfig(provider.port));
  try {
    const body = { ...req('chat-first'), model: 'my-model' };
    const r = await post(h, body);
    assert.equal(r.status, 200);
    assert.match(completed(sse(r.body.toString())).output[0].content[0].text, /kiromask.*mock.*HTTP 401.*Invalid API key/s);
    h.app.setConfig(new Config({ ...providerConfig(provider.port), proxy: { port: 0 }, defaults: { errors: 'http' } }, { env: {} }));
    const r2 = await post(h, body);
    assert.equal(r2.status, 401);
  } finally { await h.stop(); provider.close(); }
});

test('proxy: unknown model with Kiro models hidden falls back to default_model, answered as Responses', async () => {
  const provider = await toolProvider();
  const h = await startApp({ ...providerConfig(provider.port), kiro_endpoint: { models: false }, default_model: 'my-model' });
  try {
    const r = await post(h, { ...req('chat-first'), model: 'auto' });
    assert.equal(completed(sse(r.body.toString())).model, 'auto', 'echoes the model Kiro asked for');
    assert.equal(JSON.parse(provider.seen[0].body).model, 'my-model');
    assert.ok(h.logs.some((l) => /fallback for "auto"/.test(l)));
  } finally { await h.stop(); provider.close(); }
});

test('proxy: strip_metering drops kiro:credits from a passed-through Responses stream', async () => {
  const h = await startApp({ kiro_endpoint: { strip_metering: true } }, { awsHandler: (rq, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(fixture('chat-first.res.txt')); } });
  try {
    const r = await post(h, req('chat-first'));
    assert.ok(!r.body.toString().includes('kiro:credits'));
    assert.equal(sse(r.body.toString()).length, sse(fixture('chat-first.res.txt')).length, 'no events lost');
  } finally { await h.stop(); }
});

test('proxy: a body that is not a chat request on /v1/responses is passed through, not crashed on', async () => {
  const h = await startApp({}, { awsHandler: (rq, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); } });
  try {
    const r = await post(h, { hello: 'world' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
    const r2 = await post(h, 'not json at all');
    assert.equal(r2.status, 200);
  } finally { await h.stop(); }
});
