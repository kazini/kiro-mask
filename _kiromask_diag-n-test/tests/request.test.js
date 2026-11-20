import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../../_kiromask-src/config/load.mjs';
import { parseKiroRequest, translateRequest, makeNameMap, applyPrompt } from '../../_kiromask-src/translate/request.mjs';
import { DEFAULT_PREAMBLE } from '../../_kiromask-src/translate/preamble.mjs';
import { kiroRequest, SYSTEM_HISTORY, SYSTEM_TEXT, tool } from './harness.js';

const cfg = new Config({
  providers: {
    oa: { enabled: true, type: 'openai', api_key: 'k', models: [{ name: 'oa' }, { name: 'oa-fold', quirks: { fold_user_after_tool: true } }, { name: 'oa-novision', supports_images: false }, { name: 'oa-strip', schema: { strip: ['additionalProperties'] } }] },
    an: { enabled: true, type: 'anthropic', api_key: 'k', models: [{ name: 'an' }] },
  },
});
const OA = cfg.resolve('oa'); const AN = cfg.resolve('an');
const user = (content, extra = {}) => ({ userInputMessage: { content, modelId: 'x', origin: 'AI_EDITOR', ...extra } });
const asst = (content, toolUses) => ({ assistantResponseMessage: { content, ...(toolUses ? { toolUses } : {}) } });
const use = (id, name = 'readFile', input = { path: 'a' }) => ({ toolUseId: id, name, input });
const res = (id, text, status = 'success') => ({ toolUseId: id, status, content: [{ text }] });

test('system prompt becomes a real system message; the "I will follow" ack is dropped but its tool call is kept', () => {
  const history = [
    ...SYSTEM_HISTORY.slice(0, 1),
    asst('I will follow these instructions.', [use('t1', 'listDirectory', { path: '.' })]),
    user('workspace listing', { userInputMessageContext: { toolResults: [res('t1', 'a.ts\nb.ts')] } }),
    asst('understood'),
  ];
  const { body } = translateRequest(kiroRequest({ history, content: 'go' }), OA);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user', 'assistant', 'user']);
  assert.equal(body.messages[0].content, SYSTEM_TEXT);
  assert.equal(body.messages[1].content, '(start of conversation)', 'providers need a leading user turn');
  assert.equal(body.messages[2].content, null, 'ack text removed');
  assert.equal(body.messages[2].tool_calls[0].function.name, 'listDirectory');
  assert.equal(body.messages[3].content, 'a.ts\nb.ts');
});

test('the singular `toolUse` spelling and string-encoded input are also accepted', () => {
  const history = [user('q'), { assistantResponseMessage: { content: '', toolUse: [{ toolUseId: 't', name: 'f', input: '{"x":1}' }] } }, user('', { userInputMessageContext: { toolResults: [res('t', 'r')] } })];
  const { body } = translateRequest(kiroRequest({ history, content: 'next' }), OA);
  assert.deepEqual(JSON.parse(body.messages.find((m) => m.tool_calls).tool_calls[0].function.arguments), { x: 1 });
});

test('unanswered tool calls are dropped; orphan tool results become plain text — providers never see a broken pair', () => {
  const history = [user('go'), asst('trying', [use('lost1'), use('ok1')]), user('', { userInputMessageContext: { toolResults: [res('ok1', 'fine'), res('ghost', 'from nowhere')] } })];
  const { body } = translateRequest(kiroRequest({ history, content: 'and now' }), OA);
  const a = body.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(a.tool_calls.map((c) => c.id), ['ok1']);
  const tools = body.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((t) => t.tool_call_id), ['ok1']);
  assert.ok(body.messages.some((m) => m.role === 'user' && /from nowhere/.test(m.content)));
});

test('tool errors are flagged; empty results get a placeholder', () => {
  const history = [user('go'), asst('', [use('e'), use('z')]), user('', { userInputMessageContext: { toolResults: [res('e', 'boom', 'error'), res('z', '')] } })];
  const oa = translateRequest(kiroRequest({ history, content: '' }), OA).body.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(oa.map((t) => t.content), ['Error: boom', '(empty result)']);
  const an = translateRequest(kiroRequest({ history, content: '' }), AN).body.messages.at(-1).content;
  assert.deepEqual(an.map((b) => [b.type, b.is_error]), [['tool_result', true], ['tool_result', undefined]]);
});

test('anthropic: tool_result blocks come first, roles alternate, system is a cached block, last tool carries cache_control', () => {
  const history = [...SYSTEM_HISTORY, user('read'), asst('ok', [use('t1')]), user('extra context', { userInputMessageContext: { toolResults: [res('t1', 'data')] } }), asst('done'), user('hi'), user('second hi')];
  const { body } = translateRequest(kiroRequest({ history, content: 'thanks', tools: [tool('a'), tool('b')] }), AN);
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(body.messages[2].content.map((b) => b.type), ['tool_result', 'text'], 'results before text');
  assert.equal(body.messages.at(-1).content.at(-1).text, 'hi\n\nsecond hi\n\nthanks', 'consecutive user turns merged');
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(body.tools[1].cache_control && !body.tools[0].cache_control);
  assert.ok(body.messages.at(-1).content.at(-1).cache_control);
  assert.equal(body.max_tokens, 16384);
  assert.deepEqual(body.tools[0].input_schema.properties, { path: { type: 'string' } }, 'inputSchema.json unwrapped');
});

test('images: Kiro blobs → data URLs (OpenAI) / base64 sources (Anthropic); text-only models get a note', () => {
  const png = Buffer.from('PNGDATA').toString('base64');
  const req = kiroRequest({ content: 'what is this?' });
  req.conversationState.currentMessage.userInputMessage.images = [{ format: 'png', source: { bytes: png } }, { format: 'jpg', source: { bytes: [1, 2, 3] } }];
  const oa = translateRequest(req, OA).body.messages.at(-1);
  assert.equal(oa.content[0].type, 'text');
  assert.equal(oa.content[1].image_url.url, `data:image/png;base64,${png}`);
  assert.equal(oa.content[2].image_url.url, `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  const an = translateRequest(req, AN).body.messages.at(-1).content;
  assert.deepEqual(an.map((b) => b.type), ['image', 'image', 'text']);
  assert.equal(an[0].source.media_type, 'image/png');
  const nv = translateRequest(req, cfg.resolve('oa-novision')).body.messages.at(-1);
  assert.match(nv.content, /2 image\(s\) omitted/);
});

test('tool names are sanitised reversibly; collisions are disambiguated', () => {
  const m = makeNameMap(['mcp.srv/tool', 'mcp_srv_tool', 'ok-name', 'x'.repeat(80)]);
  assert.equal(m.toOriginal.get(m.safe('mcp.srv/tool')), 'mcp.srv/tool');
  assert.notEqual(m.safe('mcp.srv/tool'), m.safe('mcp_srv_tool'));
  assert.equal(m.safe('ok-name'), 'ok-name');
  assert.equal(m.safe('x'.repeat(80)).length, 64);
  const { body, nameMap } = translateRequest(kiroRequest({ tools: [tool('a.b')] }), OA);
  assert.equal(body.tools[0].function.name, 'a_b');
  assert.equal(nameMap.toOriginal.get('a_b'), 'a.b');
});

test('OpenAI body: max_tokens param name, stream usage, quirks, extra_body, temperature, schema strip', () => {
  const c2 = new Config({ providers: { p: { enabled: true, type: 'openai', max_tokens_param: 'max_completion_tokens', quirks: { no_stream_usage: true }, extra_body: { reasoning_effort: 'low' }, models: [{ name: 'm', temperature: 0.2, max_tokens: 99, extra_body: { top_k: 5 } }] } } });
  const { body } = translateRequest(kiroRequest(), c2.resolve('m'));
  assert.equal(body.max_completion_tokens, 99); assert.ok(!('max_tokens' in body));
  assert.ok(!('stream_options' in body));
  assert.deepEqual([body.reasoning_effort, body.top_k, body.temperature], ['low', 5, 0.2]);
  assert.equal('additionalProperties' in translateRequest(kiroRequest(), cfg.resolve('oa-strip')).body.tools[0].function.parameters, false);
  assert.equal('additionalProperties' in translateRequest(kiroRequest(), OA).body.tools[0].function.parameters, true);
});

test('fold_user_after_tool quirk: user text rides on the last tool message', () => {
  const history = [user('go'), asst('', [use('t')]), user('also this', { userInputMessageContext: { toolResults: [res('t', 'out')] } })];
  const m = translateRequest(kiroRequest({ history, content: '' }), cfg.resolve('oa-fold')).body.messages;
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'tool']);
  assert.equal(m[2].content, 'out\n\nalso this');
});

test('prompt customisation: override file text, prepend, append; as_system_message=false keeps the system prompt as a user turn', () => {
  const k = kiroRequest({ history: SYSTEM_HISTORY });
  const { body } = translateRequest(k, OA, { override: 'MY PROMPT', prepend: 'PRE', append: 'POST' });
  assert.equal(body.messages[0].content, 'PRE\n\nMY PROMPT\n\nPOST');
  const asUser = translateRequest(k, OA, { asSystem: false }).body.messages;
  assert.notEqual(asUser[0].role, 'system');
  assert.match(asUser[0].content, /System Prompt \(contd\.\)/);
});

test('requests without a current message are rejected; empty turn becomes "Continue."', () => {
  assert.throws(() => parseKiroRequest({}), /not a Kiro conversation request/);
  const ir = parseKiroRequest(kiroRequest({ content: '', tools: [] }));
  assert.equal(ir.turns.at(-1).text, 'Continue.');
});

test('system prompt is recognised by the ack pair (any text), not by a marker; ordinary first turns are left alone', () => {
  const custom = [{ userInputMessage: { content: 'Some other house prompt', modelId: 'x' } }, { assistantResponseMessage: { content: 'I will follow these instructions.' } }];
  assert.equal(parseKiroRequest(kiroRequest({ history: custom })).system, 'Some other house prompt');
  const ordinary = [{ userInputMessage: { content: 'fix the bug', modelId: 'x' } }, { assistantResponseMessage: { content: 'Sure, looking now.' } }];
  const ir = parseKiroRequest(kiroRequest({ history: ordinary }));
  assert.equal(ir.system, null); assert.equal(ir.turns[0].text, 'fix the bug');
  assert.equal(parseKiroRequest(kiroRequest({ history: [] })).system, null);
  assert.equal(parseKiroRequest(kiroRequest({ agentMode: 'default-v2' })).agentMode, 'default-v2');
});

test('preamble stands in for the server-side main prompt: only beside the "(contd.)" supplement, never on a full prompt or an override', () => {
  const ir = (system) => ({ system, turns: [] });
  assert.equal(applyPrompt(ir(SYSTEM_TEXT), { preamble: 'PRE' }).system, `PRE\n\n${SYSTEM_TEXT}`);
  assert.equal(applyPrompt(ir(null), { preamble: 'PRE' }).system, 'PRE', 'no system prompt at all: preamble alone');
  const full = `<identity>${'x'.repeat(5000)}`;
  assert.equal(applyPrompt(ir(full), { preamble: 'PRE' }).system, full, 'a full prompt is left alone');
  assert.equal(applyPrompt(ir(SYSTEM_TEXT), { preamble: 'PRE', override: 'MINE' }).system, 'MINE', 'an override replaces everything');
  assert.equal(applyPrompt(ir(SYSTEM_TEXT), { preamble: 'PRE', prepend: 'A', append: 'Z' }).system, `A\n\nPRE\n\n${SYSTEM_TEXT}\n\nZ`);
  assert.equal(applyPrompt(ir(SYSTEM_TEXT), { preamble: '' }).system, SYSTEM_TEXT, 'empty preamble disables it');
  assert.match(DEFAULT_PREAMBLE, /^You are Kiro/);
});
