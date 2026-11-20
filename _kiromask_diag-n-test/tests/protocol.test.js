// The Kiro service protocol as observed in Kiro 1.4.x: JSON-RPC style calls (POST / + X-Amz-Target), session titles,
// the system-prompt supplement, and the richer event stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../_kiromask-src/routes/index.mjs';
import { OpenAIStreamTranslator } from '../../_kiromask-src/translate/stream-openai.mjs';
import { AnthropicStreamTranslator } from '../../_kiromask-src/translate/stream-anthropic.mjs';
import { firstMessage, localTitle, cleanModelTitle, isTitleRequest, titleFrames } from '../../_kiromask-src/routes/title.mjs';
import { syntheticUsage } from '../../_kiromask-src/routes/misc.mjs';
import { ev, decodeAll, payloadJson } from '../../_kiromask-src/aws/eventstream.mjs';
import { startApp, viaProxy, mockServer, rpc, titleRequest, kiroRequest, SYSTEM_HISTORY, SYSTEM_TEXT, RUNTIME_HOST, MANAGEMENT_HOST, AWS_HOST, providerConfig, tool, sseHead, sseWrite } from './harness.js';
import { events, textOf, toolsOf, run, oaChunk } from './helpers.js';

const CHAT = 'KiroRuntimeService.GenerateAssistantResponse';

test('routing: operations are recognised by X-Amz-Target (any host) and by path (fallback)', () => {
  const c = (host, pathname, target = '') => classify({ host, pathname, target });
  assert.equal(c(RUNTIME_HOST, '/', CHAT), 'chat');
  assert.equal(c(MANAGEMENT_HOST, '/', 'KiroControlPlaneBearerService.ListAvailableModels'), 'models');
  assert.equal(c(MANAGEMENT_HOST, '/', 'KiroControlPlaneBearerService.GetUsageLimits'), 'usage');
  assert.equal(c(RUNTIME_HOST, '/', 'KiroRuntimeService.InvokeMCP'), 'mcp');
  assert.equal(c(RUNTIME_HOST, '/mcp'), 'mcp');
  assert.equal(c(MANAGEMENT_HOST, '/getUsageLimits'), 'usage');
  assert.equal(c('telemetry.us-east-1.kiro.dev', '/v1/traces'), 'telemetry');
  assert.equal(c('prod.us-east-1.auth.desktop.kiro.dev', '/refreshToken'), 'auth');
  assert.equal(c('prod.download.desktop.kiro.dev', '/stable/metadata-win32-x64-system-stable.json'), 'update');
  assert.equal(c(MANAGEMENT_HOST, '/', 'KiroControlPlaneBearerService.GetFeatureConfiguration'), 'other');
  assert.equal(c('app.kiro.dev', '/service/KiroWebBearerService/operation/GetUserSettings'), 'other');
  assert.equal(c(AWS_HOST, '/generateAssistantResponse'), 'chat', 'path-addressed chat still works');
  assert.equal(c(AWS_HOST, '/ListAvailableModels'), 'models');
});

test('stream: every response begins with initial-response + an empty text event, text carries the model id', () => {
  const t = new OpenAIStreamTranslator({ modelId: 'minimax-m2.1', contextWindow: 1000, estimatedPromptTokens: 100 });
  const evs = events(run(t, [oaChunk({ content: 'hi' }), oaChunk({}, 'stop')]));
  assert.deepEqual(evs.map((e) => e.type), ['initial-response', 'assistantResponseEvent', 'assistantResponseEvent', 'metadataEvent', 'contextUsageEvent']);
  assert.deepEqual([evs[0].conversationId, evs[1].content, evs[1].modelId, evs[2].content, evs[2].modelId], ['', '', 'minimax-m2.1', 'hi', 'minimax-m2.1']);
  assert.ok(decodeAll(Buffer.concat(run(new OpenAIStreamTranslator({}), [])))[0].headers[':content-type'] === 'application/x-amz-json-1.0', 'initial-response is JSON 1.0 like the real service');
});

test('stream: stopReason is END_TURN, TOOL_USE or MAX_TOKENS, and comes before the usage events', () => {
  const stop = (chunks, Tr = OpenAIStreamTranslator) => { const e = events(run(new Tr({ contextWindow: 1000, estimatedPromptTokens: 100 }), chunks)); const i = e.findIndex((x) => x.type === 'metadataEvent'); assert.ok(i > -1 && e[i + 1].type === 'contextUsageEvent'); return e[i].stopReason; };
  assert.equal(stop([oaChunk({ content: 'x' }, 'stop')]), 'END_TURN');
  assert.equal(stop([oaChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 't', arguments: '{}' } }] }, 'tool_calls')]), 'TOOL_USE');
  assert.equal(stop([oaChunk({ content: 'x' }, 'length')]), 'MAX_TOKENS');
  assert.equal(stop([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 't' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }], AnthropicStreamTranslator), 'TOOL_USE');
  assert.equal(stop([{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'x' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }], AnthropicStreamTranslator), 'MAX_TOKENS');
});

test('stream: reasoning "native" emits Kiro\'s own reasoning events; drop hides; keep fences', () => {
  const chunks = [oaChunk({ reasoning_content: 'think ' }), oaChunk({ reasoning_content: 'more' }), oaChunk({ content: 'Answer' }, 'stop')];
  const native = events(run(new OpenAIStreamTranslator({ reasoning: 'native' }), chunks));
  assert.deepEqual(native.filter((e) => e.type === 'reasoningContentEvent').map((e) => e.text), ['think ', 'more']);
  assert.equal(textOf(run(new OpenAIStreamTranslator({ reasoning: 'native' }), chunks)), 'Answer', 'reasoning is not mixed into the answer');
  assert.equal(events(run(new OpenAIStreamTranslator({ reasoning: 'drop' }), chunks)).some((e) => e.type === 'reasoningContentEvent'), false);
  assert.equal(textOf(run(new OpenAIStreamTranslator({ reasoning: 'keep' }), chunks)), '```thinking\nthink more\n```\n\nAnswer');
});

test('title: the user\'s message is taken after the LAST <first_message> tag (Kiro\'s own instructions mention the tag too)', () => {
  const content = titleRequest('Add a dark mode toggle').conversationState.currentMessage.userInputMessage.content;
  assert.equal(firstMessage(content), 'Add a dark mode toggle');
  assert.equal(firstMessage('no tags here'), 'no tags here');
  assert.equal(firstMessage('x <first_message>a</first_message> y <first_message>real'), 'real', 'tolerates a missing closing tag');
  assert.equal(firstMessage(''), '');
});

test('title: local titles are short Title Case phrases without greetings or politeness', () => {
  const t = localTitle;
  assert.equal(t("Greetings! I'd like for you to look into the current project and explain what it is for."), 'Look into the Current Project');
  assert.equal(t("Hi there, could you please fix the failing login test in auth.ts"), 'Fix the Failing Login Test', 'trailing connectors are trimmed');
  assert.equal(t('fix the bug in src/auth.ts where login fails'), 'Fix the Bug in src/auth.ts');
  assert.equal(t('Refactor the PaymentService class'), 'Refactor the PaymentService Class');
  assert.equal(t('Can you help me to set up CI with GitHub Actions?'), 'Set Up CI with GitHub Actions');
  assert.equal(t('```js\nconsole.log(1)\n```\nwhy does this print twice'), 'Why Does This Print Twice');
  assert.match(t('Écris une fonction qui trie la liste'), /^Écris Une Fonction Qui/, 'other languages are kept, not translated');
  assert.equal(t(''), 'New Chat'); assert.equal(t('!!! ???'), 'New Chat');
  assert.ok(t('word '.repeat(40)).split(' ').length <= 6);
  assert.ok(t('x'.repeat(200)).length <= 60);
  assert.ok(!/[.!?]$/.test(t('Explain how recursion works.')), 'no trailing punctuation');
});

test('title: model answers are cleaned into titles; unusable ones are rejected', () => {
  assert.equal(cleanModelTitle('"Fix Login Bug"'), 'Fix Login Bug');
  assert.equal(cleanModelTitle('Title: Fix Login Bug.'), 'Fix Login Bug');
  assert.equal(cleanModelTitle('<think>hmm\nlet me see</think>\nRefactor Auth Module\nextra line'), 'Refactor Auth Module');
  assert.equal(cleanModelTitle('**Add Tests**'), 'Add Tests');
  assert.equal(cleanModelTitle(''), null); assert.equal(cleanModelTitle('one two three four five six seven eight nine ten eleven twelve thirteen'), null);
  assert.deepEqual(events(titleFrames('Hello')).map((e) => e.type), ['initial-response', 'assistantResponseEvent', 'assistantResponseEvent', 'metadataEvent', 'contextUsageEvent']);
});

test('title: detection by agentMode, by mode header, and by prompt; ordinary chats are not mistaken for titles', () => {
  assert.ok(isTitleRequest(titleRequest()));
  assert.ok(isTitleRequest({ conversationState: { currentMessage: { userInputMessage: { modelId: 'x', content: 'hi' } } } }, { 'x-amzn-kiro-mode-identifier': 'session-title' }));
  const noMode = titleRequest(); delete noMode.agentMode;
  assert.ok(isTitleRequest(noMode), 'recognised by the simple-task model + instruction text');
  assert.ok(!isTitleRequest(kiroRequest({ modelId: 'simple-task', content: 'something else' })));
  assert.ok(!isTitleRequest(kiroRequest()));
});

test('e2e title modes: a model can write the title (cleaned), a failing model falls back to local, passthrough reaches Kiro', async () => {
  let fail = false;
  const provider = await mockServer((req, res) => {
    if (fail) { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '"Investigate Project Purpose"\n' } }] }));
  });
  const h = await startApp({ ...providerConfig(provider.port, { retries: 0 }), session_title: 'my-model' });
  try {
    assert.equal(textOf([(await rpc(h, RUNTIME_HOST, CHAT, titleRequest())).body]), 'Investigate Project Purpose');
    const sent = JSON.parse(provider.seen[0].body);
    assert.equal(sent.stream, false); assert.match(sent.messages.at(-1).content, /look into the current project/i); assert.ok(sent.max_tokens <= 64);
    fail = true;
    assert.equal(textOf([(await rpc(h, RUNTIME_HOST, CHAT, titleRequest())).body]), 'Look into the Current Project', 'local fallback');
  } finally { await h.stop(); provider.close(); }
  const h2 = await startApp({ session_title: 'passthrough' }, { awsHandler: (req, res) => { res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' }); res.end(Buffer.concat([ev.text('From Kiro'), ev.contextUsage(1)])); } });
  try {
    assert.equal(textOf([(await rpc(h2, RUNTIME_HOST, CHAT, titleRequest())).body]), 'From Kiro');
    assert.equal(h2.aws.seen[0].headers['x-amz-target'], CHAT, 'headers reach Kiro unchanged');
  } finally { await h2.stop(); }
});

test('e2e chat to a custom model over the RPC protocol: preamble + supplement as system, tools cleaned, events well-formed', async () => {
  const provider = await mockServer((req, res) => {
    sseHead(res);
    sseWrite(res, { choices: [{ delta: { content: 'Checking.' } }] });
    sseWrite(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }] });
    sseWrite(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
    sseWrite(res, '[DONE]'); res.end();
  });
  const h = await startApp(providerConfig(provider.port));
  try {
    const r = await rpc(h, RUNTIME_HOST, CHAT, kiroRequest({ history: SYSTEM_HISTORY, content: 'read a.ts', tools: [tool('read_file')] }));
    const types = events([r.body]).map((e) => e.type);
    assert.deepEqual([types[0], types.at(-3), types.at(-2), types.at(-1)], ['initial-response', 'toolUseEvent', 'metadataEvent', 'contextUsageEvent']);
    assert.equal(events([r.body]).find((e) => e.type === 'metadataEvent').stopReason, 'TOOL_USE');
    assert.ok(events([r.body]).filter((e) => e.type === 'assistantResponseEvent').every((e) => e.modelId === 'my-model'), 'the requested model id is echoed');
    assert.deepEqual(toolsOf([r.body]).map((t) => [t.name, JSON.parse(t.input)]), [['read_file', { path: 'a.ts' }]]);
    const sys = JSON.parse(provider.seen[0].body).messages[0];
    assert.equal(sys.role, 'system'); assert.match(sys.content, /^You are Kiro/); assert.ok(sys.content.endsWith(SYSTEM_TEXT), 'Kiro\'s own supplement follows the preamble');
  } finally { await h.stop(); provider.close(); }
  // the preamble can be turned off or replaced
  const provider2 = await mockServer((req, res) => { sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }); res.end(); });
  for (const [preamble, expected] of [['', SYSTEM_TEXT], ['My own preamble', `My own preamble\n\n${SYSTEM_TEXT}`]]) {
    const h2 = await startApp({ ...providerConfig(provider2.port), prompt: { preamble } });
    try {
      await rpc(h2, RUNTIME_HOST, CHAT, kiroRequest({ history: SYSTEM_HISTORY }));
      assert.equal(JSON.parse(provider2.seen.at(-1).body).messages[0].content, expected, `preamble ${JSON.stringify(preamble)}`);
    } finally { await h2.stop(); }
  }
  provider2.close();
});

test('e2e models over RPC: POST target on the management host; content-type is AWS JSON 1.0; defaultModel and other fields survive', async () => {
  const native = { models: [{ modelId: 'auto', modelName: 'Auto', rateUnit: 'Credit', rateMultiplier: 1 }, { modelId: 'minimax-m2.1', modelName: 'MiniMax' }], defaultModel: { modelId: 'auto' } };
  const provider = await mockServer(() => {});
  const cfg = providerConfig(provider.port); cfg.providers.mock.models.push({ name: 'minimax-m2.1', display_name: 'MiniMax (rerouted)' });
  const h = await startApp(cfg, { awsHandler: (req, res) => { res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' }); res.end(JSON.stringify(native)); } });
  try {
    const r = await rpc(h, MANAGEMENT_HOST, 'KiroControlPlaneBearerService.ListAvailableModels', { origin: 'AI_EDITOR', profileArn: 'arn:x' });
    assert.equal(r.headers['content-type'], 'application/x-amz-json-1.0');
    const j = JSON.parse(r.body);
    assert.deepEqual(j.models.map((m) => m.modelId), ['auto', 'minimax-m2.1', 'my-model']);
    assert.equal(j.models[1].modelName, 'MiniMax (rerouted)', 'a custom model replaces the Kiro model with the same id');
    assert.deepEqual(j.defaultModel, { modelId: 'auto' });
    assert.equal(JSON.parse(h.aws.seen[0].body).origin, 'AI_EDITOR', 'the request body reached Kiro intact');
    // and with Kiro down, the cached list + custom models are still served in the same content type
    h.aws.close();
    const down = await rpc(h, MANAGEMENT_HOST, 'KiroControlPlaneBearerService.ListAvailableModels', {});
    assert.equal(down.headers['content-type'], 'application/x-amz-json-1.0'); assert.equal(JSON.parse(down.body).models.length, 3);
  } finally { await h.stop(); provider.close(); }
});

test('e2e MCP: InvokeMCP (target) and /mcp (path) are both handled; web_search can be rewritten or answered locally', async () => {
  const tools = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'web_search', description: 'aws' }, { name: 'hidden_one' }] } };
  const backend = await mockServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"results":[{"title":"T"}]}'); });
  const h = await startApp({ web_search: { description: 'mine', execute: { type: 'http', url: `http://127.0.0.1:${backend.port}/s` } } }, { awsHandler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(tools)); } });
  try {
    const list = JSON.parse((await rpc(h, RUNTIME_HOST, 'KiroRuntimeService.InvokeMCP', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { includeHidden: true }, profileArn: 'arn:x' })).body);
    assert.deepEqual(list.result.tools.map((t) => [t.name, t.description]), [['hidden_one', undefined], ['web_search', 'mine']], 'hidden tools are preserved');
    const call = await rpc(h, RUNTIME_HOST, 'KiroRuntimeService.InvokeMCP', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'q' } } });
    assert.equal(call.headers['content-type'], 'application/x-amz-json-1.0');
    assert.deepEqual(JSON.parse(JSON.parse(call.body).result.content[0].text), { results: [{ title: 'T' }] });
    const viaPath = JSON.parse((await viaProxy(h.port, h.caPem, RUNTIME_HOST, { method: 'POST', path: '/mcp', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).body);
    assert.equal(viaPath.result.tools.find((t) => t.name === 'web_search').description, 'mine');
  } finally { await h.stop(); backend.close(); }
});

test('e2e other calls: swallowed CBOR calls get a valid empty CBOR map; the old path-addressed chat still works', async () => {
  const provider = await mockServer((req, res) => { sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }); res.end(); });
  const h = await startApp({ ...providerConfig(provider.port), kiro_endpoint: { auth_fake_login: true } }, { awsHandler: () => assert.fail('nothing may reach Kiro') });
  try {
    const cbor = await viaProxy(h.port, h.caPem, 'app.kiro.dev', { method: 'POST', path: '/service/KiroWebBearerService/operation/GetUserSettings', headers: { 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor' }, body: Buffer.from([0xa0]) });
    assert.equal(cbor.headers['content-type'], 'application/cbor'); assert.deepEqual([...cbor.body], [0xa0]);
    const rpcBlocked = await rpc(h, MANAGEMENT_HOST, 'KiroControlPlaneBearerService.GetFeatureConfiguration', {});
    assert.equal(rpcBlocked.headers['content-type'], 'application/x-amz-json-1.0'); assert.deepEqual(JSON.parse(rpcBlocked.body), { status: 'ok' });
    const legacy = await viaProxy(h.port, h.caPem, AWS_HOST, { method: 'POST', path: '/generateAssistantResponse', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kiroRequest()) });
    assert.equal(textOf([legacy.body]), 'ok');
  } finally { await h.stop(); provider.close(); }
});

test('usage: the synthetic answer has the real response\'s shape (and legacy fields only for the path-style call)', () => {
  const u = syntheticUsage({ now: new Date('2026-11-16T10:00:00Z') });
  assert.equal(u.nextDateReset, Date.UTC(2026, 11, 1) / 1000);
  assert.deepEqual(Object.keys(u).sort(), ['nextDateReset', 'overageConfiguration', 'subscriptionInfo', 'usageBreakdownList', 'userInfo']);
  assert.deepEqual([u.usageBreakdownList[0].currentUsage, u.usageBreakdownList[0].resourceType, u.usageBreakdownList[0].displayNamePlural], [0, 'CREDIT', 'Credits']);
  assert.ok('limits' in syntheticUsage({ legacyFields: true }));
});
