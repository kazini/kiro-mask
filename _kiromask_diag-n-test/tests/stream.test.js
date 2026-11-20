import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIStreamTranslator } from '../../_kiromask-src/translate/stream-openai.mjs';
import { AnthropicStreamTranslator } from '../../_kiromask-src/translate/stream-anthropic.mjs';
import { ThinkFilter, StreamError } from '../../_kiromask-src/translate/stream-base.mjs';
import { sseEvents } from '../../_kiromask-src/translate/sse.mjs';
import { events, textOf, toolsOf, run, oaChunk } from './helpers.js';

const mk = (o = {}) => new OpenAIStreamTranslator({ contextWindow: 1000, ...o });

test('openai: text stream, usage arrives after finish_reason, context % is emitted last', () => {
  const frames = run(mk(), [
    oaChunk({ role: 'assistant', content: '' }),
    oaChunk({ content: 'Hel' }), oaChunk({ content: 'lo' }),
    oaChunk({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 250, completion_tokens: 7, total_tokens: 257 } },
  ]);
  assert.equal(textOf(frames), 'Hello');
  const evs = events(frames);
  assert.deepEqual(evs.at(-1), { type: 'contextUsageEvent', contextUsagePercentage: 25 });
  assert.ok(!evs.some((e) => e.type === 'meteringEvent'), 'no credits for custom models');
});

test('openai: tool call split across chunks (buffered) → start, input, stop', () => {
  const frames = run(mk(), [
    oaChunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'readFile', arguments: '' } }] }),
    oaChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
    oaChunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
    oaChunk({}, 'tool_calls'),
  ]);
  const tools = toolsOf(frames);
  assert.equal(tools.length, 1);
  assert.deepEqual({ name: tools[0].name, id: tools[0].id, stopped: tools[0].stopped }, { name: 'readFile', id: 'call_1', stopped: true });
  assert.deepEqual(JSON.parse(tools[0].input), { path: 'a.ts' });
  // order: start (no input) → input → stop
  const seq = events(frames).filter((e) => e.type === 'toolUseEvent').map((e) => (e.stop ? 'stop' : 'input' in e ? 'input' : 'start'));
  assert.deepEqual(seq, ['start', 'input', 'stop']);
});

test('openai: stream mode emits start immediately and forwards argument chunks live', () => {
  const t = mk({ toolArgs: 'stream' });
  const first = t.push(oaChunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'grepSearch', arguments: '{"q' } }] }));
  const e = events(first).filter((x) => x.type === 'toolUseEvent');
  assert.equal(e.length, 2, 'start + first fragment already sent');
  const rest = [...t.push(oaChunk({ tool_calls: [{ index: 0, function: { arguments: '":1}' } }] }, 'stop')), ...t.finish()];
  assert.equal(toolsOf([...first, ...rest])[0].input, '{"q":1}');
});

test('openai: Gemini-style parallel calls all on index 0 become separate calls', () => {
  const frames = run(mk(), [
    oaChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x":1}' } }] }),
    oaChunk({ tool_calls: [{ index: 0, id: 'b', function: { name: 'two', arguments: '{"y":2}' } }] }),
    oaChunk({ tool_calls: [{ index: 0, function: { name: 'three', arguments: '{"z":3}' } }] }), // no id at all
    oaChunk({}, 'tool_calls'),
  ]);
  const tools = toolsOf(frames);
  assert.deepEqual(tools.map((c) => c.name), ['one', 'two', 'three']);
  assert.deepEqual(tools.map((c) => JSON.parse(c.input)), [{ x: 1 }, { y: 2 }, { z: 3 }]);
  assert.ok(tools[2].id.startsWith('tooluse_'), 'missing id is generated');
  assert.equal(new Set(tools.map((c) => c.id)).size, 3);
});

test('openai: providers that repeat the name in every fragment do not split the call', () => {
  const frames = run(mk(), [
    oaChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'fsWrite', arguments: '{"path":"x",' } }] }),
    oaChunk({ tool_calls: [{ index: 0, function: { name: 'fsWrite', arguments: '"text":"hi"}' } }] }),
    oaChunk({}, 'stop'),
  ]);
  const tools = toolsOf(frames);
  assert.equal(tools.length, 1);
  assert.deepEqual(JSON.parse(tools[0].input), { path: 'x', text: 'hi' });
});

test('openai: sloppy JSON is repaired; truncated call is dropped with a visible note', () => {
  const repaired = run(mk(), [
    oaChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 't', arguments: '```json\n{"a":1,}\n```' } }] }),
    oaChunk({}, 'stop'),
  ]);
  assert.deepEqual(JSON.parse(toolsOf(repaired)[0].input), { a: 1 });

  const t = mk();
  const dropped = run(t, [
    oaChunk({ content: 'Writing…' }),
    oaChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'fsWrite', arguments: 'garbage <<<' } }] }),
    oaChunk({}, 'length'),
  ]);
  assert.equal(toolsOf(dropped).length, 0);
  assert.match(textOf(dropped), /Dropped tool call "fsWrite".*token limit/s);
  assert.equal(t.stats.droppedToolCalls, 1);
});

test('openai: tool names are mapped back to the originals Kiro knows', () => {
  const nameMap = { toOriginal: new Map([['mcp_srv_tool', 'mcp.srv/tool']]) };
  const frames = run(mk({ nameMap }), [
    oaChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'mcp_srv_tool', arguments: '{}' } }] }), oaChunk({}, 'stop'),
  ]);
  assert.equal(toolsOf(frames)[0].name, 'mcp.srv/tool');
});

test('openai: <think> blocks are removed even when tags are split across chunks', () => {
  const frames = run(mk(), ['<th', 'ink>secret reasoning</thi', 'nk>\n\nThe ', 'answer is <thinker> ok'].map((c) => oaChunk({ content: c })));
  assert.equal(textOf(frames), 'The answer is <thinker> ok');
});

test('openai: reasoning_content is dropped by default, shown in a fenced block when kept', () => {
  const chunks = [oaChunk({ reasoning_content: 'hmm ' }), oaChunk({ reasoning_content: 'ok' }), oaChunk({ content: 'Answer' }), oaChunk({}, 'stop')];
  assert.equal(textOf(run(mk(), chunks)), 'Answer');
  assert.equal(textOf(run(mk({ reasoning: 'keep' }), chunks)), '```thinking\nhmm ok\n```\n\nAnswer');
});

test('openai: no usage reported → context % estimated from the request; empty reply is explained', () => {
  const frames = run(mk({ estimatedPromptTokens: 500 }), [oaChunk({}, 'stop')]);
  assert.match(textOf(frames), /empty response/);
  assert.equal(events(frames).at(-1).contextUsagePercentage, 50);
});

test('openai: max_tokens cut-off is flagged; provider error chunks throw StreamError', () => {
  assert.match(textOf(run(mk(), [oaChunk({ content: 'abc' }, 'length')])), /cut off by the max_tokens/);
  assert.throws(() => mk().push({ error: { message: 'rate limited', type: 'rate_limit' } }), (e) => e instanceof StreamError && e.message === 'rate limited');
});

test('openai: metering is only emitted when explicitly enabled', () => {
  const chunks = [oaChunk({ content: 'x' }, 'stop', { usage: { prompt_tokens: 100, completion_tokens: 100 } })];
  assert.ok(!events(run(mk(), chunks)).some((e) => e.type === 'meteringEvent'));
  assert.ok(events(run(mk({ metering: true }), chunks)).some((e) => e.type === 'meteringEvent'));
});

test('anthropic: text + thinking + tool_use blocks, usage incl. cache tokens', () => {
  const t = new AnthropicStreamTranslator({ contextWindow: 1000 });
  const frames = run(t, [
    { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 100, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'planning' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'readFile', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"x"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]);
  assert.equal(textOf(frames), 'Reading');
  assert.deepEqual(toolsOf(frames).map((c) => [c.name, c.id, JSON.parse(c.input)]), [['readFile', 'toolu_1', { path: 'x' }]]);
  assert.equal(events(frames).at(-1).contextUsagePercentage, 20); // (100 + 100 cached) / 1000
  assert.throws(() => new AnthropicStreamTranslator().push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), /Overloaded/);
});

test('ThinkFilter: unterminated think span is discarded at flush', () => {
  const f = new ThinkFilter();
  assert.equal(f.push('hello <think>never closed'), 'hello ');
  assert.equal(f.flush(), '');
});

test('sse: CRLF, comments, multi-line data, bare JSON lines, split multibyte UTF-8, [DONE]', async () => {
  const text = ': keep-alive\r\n\r\nevent: x\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\n{"bare":true}\n\ndata: {"u":"héllo ✓"}\n\ndata: [DONE]\n\n';
  const bytes = Buffer.from(text);
  async function* pieces() { for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3); } // splits UTF-8 sequences
  const got = [];
  for await (const e of sseEvents(pieces())) got.push(e);
  assert.deepEqual(got, [
    { event: 'x', data: '{"a":1}' }, { event: null, data: 'line1\nline2' }, { event: null, data: '{"bare":true}' },
    { event: null, data: '{"u":"héllo ✓"}' }, { event: null, data: '[DONE]' },
  ]);
});

test('openai (stream mode): arguments that arrive BEFORE the tool name are not lost', () => {
  const frames = run(mk({ toolArgs: 'stream' }), [
    oaChunk({ tool_calls: [{ index: 0, id: 'c1', function: { arguments: '{"path":' } }] }),
    oaChunk({ tool_calls: [{ index: 0, function: { name: 'readFile', arguments: '"a.ts"}' } }] }),
    oaChunk({}, 'tool_calls'),
  ]);
  const t = toolsOf(frames);
  assert.equal(t.length, 1);
  assert.deepEqual(JSON.parse(t[0].input), { path: 'a.ts' });
  assert.ok(t[0].stopped);
});
