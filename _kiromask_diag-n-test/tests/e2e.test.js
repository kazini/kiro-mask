import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAll, payloadJson, ev } from '../../_kiromask-src/aws/eventstream.mjs';
import { startApp, viaProxy, mockServer, AWS_HOST, RUNTIME_HOST, kiroRequest, SYSTEM_HISTORY, SYSTEM_TEXT, titleRequest, rpc, tool, sseHead, sseWrite, sleep, providerConfig } from './harness.js';
import { events, textOf, toolsOf } from './helpers.js';

const CHAT = 'KiroRuntimeService.GenerateAssistantResponse';
const post = (h, req, extra = {}) => rpc(h, RUNTIME_HOST, CHAT, req, extra);
const frames = (r) => decodeAll(r.body).map((f) => ({ type: f.eventType, ...payloadJson(f) }));

test('chat → custom OpenAI provider: system extracted, schemas cleaned, response streamed back as event stream', async () => {
  const provider = await mockServer((req, res) => {
    sseHead(res);
    sseWrite(res, { choices: [{ delta: { content: 'Let me ' } }] });
    sseWrite(res, { choices: [{ delta: { content: 'look.' } }] });
    sseWrite(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'readFile', arguments: '{"path":"a.ts"}' } }] } }] });
    sseWrite(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 12 } });
    sseWrite(res, '[DONE]'); res.end();
  });
  const h = await startApp(providerConfig(provider.port));
  try {
    const r = await post(h, kiroRequest({ history: SYSTEM_HISTORY, content: 'read a.ts' }));
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/vnd.amazon.eventstream');
    const evs = frames(r);
    assert.equal(textOf([r.body]), 'Let me look.');
    assert.deepEqual(toolsOf([r.body]).map((t) => [t.name, t.id, JSON.parse(t.input)]), [['readFile', 'call_9', { path: 'a.ts' }]]);
    assert.equal(evs.at(-1).contextUsagePercentage, 40);

    const sent = JSON.parse(provider.seen[0].body);
    assert.equal(provider.seen[0].headers.authorization, 'Bearer k-test');
    assert.equal(provider.seen[0].url, '/v1/chat/completions');
    assert.equal(sent.model, 'my-model');
    assert.equal(sent.max_tokens, 2048);
    assert.equal(sent.messages[0].role, 'system');
    assert.match(sent.messages[0].content, /You are Kiro/);
    assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user']);
    assert.equal(sent.tools[0].function.name, 'readFile');
    assert.ok(!('$schema' in sent.tools[0].function.parameters), 'schema sanitized');
    assert.ok(!('json' in sent.tools[0].function.parameters), 'inputSchema.json unwrapped');
    assert.equal(h.app.state.customActive, true);
  } finally { await h.stop(); provider.close(); }
});

test('streaming is live: first text arrives before the provider finishes', async () => {
  const provider = await mockServer(async (req, res) => {
    sseHead(res);
    sseWrite(res, { choices: [{ delta: { content: 'first' } }] });
    await sleep(400);
    sseWrite(res, { choices: [{ delta: { content: ' second' }, finish_reason: 'stop' }] });
    sseWrite(res, '[DONE]'); res.end();
  });
  const h = await startApp(providerConfig(provider.port));
  try {
    const arrivals = [];
    await post(h, kiroRequest(), { onChunk: (d, t) => arrivals.push([decodeAll(d)[0]?.eventType, t]) });
    assert.ok(arrivals[0][1] < 300, `first frame after ${arrivals[0][1]}ms, expected well under the provider's 400ms delay`);
    assert.ok(arrivals.at(-1)[1] >= 350, 'later frames arrive after the delay');
  } finally { await h.stop(); provider.close(); }
});

test('multi-turn tool round trip is translated with proper tool_calls / tool messages', async () => {
  const provider = await mockServer((req, res) => { sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }); res.end(); });
  const h = await startApp(providerConfig(provider.port));
  try {
    const history = [
      ...SYSTEM_HISTORY,
      { userInputMessage: { content: 'read a.ts', modelId: 'my-model', origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: 'Reading.', toolUses: [{ toolUseId: 'tooluse_A', name: 'readFile', input: { path: 'a.ts' } }] } },
    ];
    await post(h, kiroRequest({ history, content: '', toolResults: [{ toolUseId: 'tooluse_A', status: 'success', content: [{ text: 'file body' }] }] }));
    const m = JSON.parse(provider.seen[0].body).messages;
    assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(m[2].tool_calls[0].id, 'tooluse_A');
    assert.deepEqual(JSON.parse(m[2].tool_calls[0].function.arguments), { path: 'a.ts' });
    assert.deepEqual({ id: m[3].tool_call_id, content: m[3].content }, { id: 'tooluse_A', content: 'file body' });
  } finally { await h.stop(); provider.close(); }
});

test('provider 429 is retried (Retry-After honoured) and then succeeds', async () => {
  let n = 0;
  const provider = await mockServer((req, res) => {
    if (n++ === 0) { res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }); return res.end('{"error":{"message":"slow down"}}'); }
    sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] }); res.end();
  });
  const h = await startApp(providerConfig(provider.port));
  try {
    const r = await post(h, kiroRequest());
    assert.equal(textOf([r.body]), 'recovered');
    assert.equal(provider.seen.length, 2);
  } finally { await h.stop(); provider.close(); }
});

test('persistent provider error is shown inside the conversation (HTTP 200 + text), not as a broken stream', async () => {
  const provider = await mockServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Invalid API key"}}'); });
  const h = await startApp(providerConfig(provider.port));
  try {
    const r = await post(h, kiroRequest());
    assert.equal(r.status, 200);
    assert.match(textOf([r.body]), /kiromask.*mock.*HTTP 401.*Invalid API key/s);
    assert.equal(provider.seen.length, 1, '401 is not retried');
  } finally { await h.stop(); provider.close(); }
});

test('`errors: http` returns an AWS-style error instead', async () => {
  const provider = await mockServer((req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad"}}'); });
  const h = await startApp({ ...providerConfig(provider.port), defaults: { errors: 'http' } });
  try {
    const r = await post(h, kiroRequest());
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).__type, 'ValidationException');
  } finally { await h.stop(); provider.close(); }
});

test('client disconnect cancels the upstream generation', async () => {
  let providerSawClose = false;
  const provider = await mockServer((req, res) => {
    sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'start' } }] });
    res.on('close', () => { providerSawClose = true; });
    const t = setInterval(() => { if (!res.destroyed) sseWrite(res, { choices: [{ delta: { content: '.' } }] }); }, 50);
    res.on('close', () => clearInterval(t));
  });
  const h = await startApp(providerConfig(provider.port));
  try {
    const ctl = new AbortController();
    const p = post(h, kiroRequest(), { signal: ctl.signal, onChunk: () => setTimeout(() => ctl.abort(), 100) }).catch(() => {});
    await p; await sleep(400);
    assert.ok(providerSawClose, 'provider connection was closed after Kiro went away');
  } finally { await h.stop(); provider.close(); }
});

test('session title (simple-task / agentMode session-title) is answered locally — no AWS or provider traffic', async () => {
  const provider = await mockServer(() => assert.fail('provider must not be called'));
  const h = await startApp(providerConfig(provider.port), { awsHandler: () => assert.fail('AWS must not be called') });
  try {
    const r = await post(h, titleRequest());
    assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'application/vnd.amazon.eventstream');
    const evs = events([r.body]);
    assert.deepEqual(evs.map((e) => e.type), ['initial-response', 'assistantResponseEvent', 'assistantResponseEvent', 'metadataEvent', 'contextUsageEvent']);
    assert.equal(textOf([r.body]), 'Look into the Current Project', 'the instructions inside the request are not mistaken for the message');
    assert.equal(evs.find((e) => e.type === 'metadataEvent').stopReason, 'END_TURN');
    assert.equal(provider.seen.length + h.aws.seen.length, 0);
    assert.equal(h.app.state.customActive, false, 'a title request does not count as using a custom model');
  } finally { await h.stop(); provider.close(); }
});

test('native Kiro model → transparent pass-through to AWS; metering stripped only when asked', async () => {
  const awsHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    res.write(Buffer.concat([ev.text('from aws'), ev.contextUsage(5), ev.metering(0.1)])); res.end();
  };
  const h = await startApp({ kiro_endpoint: { models: true } }, { awsHandler });
  const h2 = await startApp({ kiro_endpoint: { models: true, strip_metering: true } }, { awsHandler });
  try {
    const r = await post(h, kiroRequest({ modelId: 'auto' }));
    assert.deepEqual(events([r.body]).map((e) => e.type), ['assistantResponseEvent', 'contextUsageEvent', 'meteringEvent']);
    assert.equal(h.aws.seen[0].headers.authorization, 'Bearer real-token', 'auth header forwarded');
    assert.equal(h.app.state.customActive, false);
    const r2 = await post(h2, kiroRequest({ modelId: 'auto' }));
    assert.deepEqual(events([r2.body]).map((e) => e.type), ['assistantResponseEvent', 'contextUsageEvent']);
  } finally { await h.stop(); await h2.stop(); }
});

test('ListAvailableModels: Kiro models + custom injected; custom id can override a Kiro id; AWS outage falls back to cache', async () => {
  const native = { models: [{ modelId: 'auto', modelName: 'Auto', rateMultiplier: 1, rateUnit: 'Credit', tokenLimits: { maxInputTokens: 200000 } }, { modelId: 'claude-sonnet-4.5', modelName: 'Sonnet', rateMultiplier: 1.3, rateUnit: 'Credit' }], defaultModel: { modelId: 'auto' }, nextToken: null };
  let up = true;
  const awsHandler = (req, res) => { if (!up) return req.socket.destroy(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(native)); };
  const provider = await mockServer(() => {});
  const cfg = providerConfig(provider.port);
  cfg.providers.mock.models.push({ name: 'claude-sonnet-4.5', display_name: 'Sonnet (rerouted)' });
  const h = await startApp(cfg, { awsHandler });
  try {
    const get = () => viaProxy(h.port, h.caPem, AWS_HOST, { path: '/ListAvailableModels?origin=AI_EDITOR' });
    const j = JSON.parse((await get()).body);
    assert.deepEqual(j.models.map((m) => m.modelId), ['auto', 'claude-sonnet-4.5', 'my-model']);
    assert.equal(j.models[1].modelName, 'Sonnet (rerouted)', 'custom model replaced the Kiro entry in place');
    assert.equal(j.models[0].rateUnit, 'Kiro Credits');
    assert.equal(j.models[2].rateMultiplier, null);
    assert.deepEqual(j.models[2].tokenLimits, { maxInputTokens: 1000, maxOutputTokens: 2048 });
    assert.deepEqual(j.defaultModel, { modelId: 'auto' }, 'other upstream fields preserved');
    up = false; // AWS goes away
    const j2 = JSON.parse((await get()).body);
    assert.deepEqual(j2.models.map((m) => m.modelId), ['auto', 'claude-sonnet-4.5', 'my-model'], 'served from the on-disk cache');
  } finally { await h.stop(); provider.close(); }
});

test('Kiro models disabled / fake login: only custom models, unknown model ids fall back to default_model', async () => {
  const provider = await mockServer((req, res) => { sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }); res.end(); });
  const h = await startApp({ ...providerConfig(provider.port), default_model: 'my-model', kiro_endpoint: { models: false } }, { awsHandler: () => assert.fail('AWS must not be contacted') });
  try {
    const j = JSON.parse((await viaProxy(h.port, h.caPem, AWS_HOST, { path: '/ListAvailableModels' })).body);
    assert.deepEqual(j.models.map((m) => m.modelId), ['my-model']);
    const r = await post(h, kiroRequest({ modelId: 'auto' }));
    assert.equal(textOf([r.body]), 'hi', 'persisted "auto" selection is rerouted to the default custom model');
  } finally { await h.stop(); provider.close(); }
});

test('fake login: synthetic tokens, everything else blocked locally', async () => {
  const h = await startApp({ kiro_endpoint: { auth_fake_login: true } }, { awsHandler: () => assert.fail('nothing may reach AWS') });
  try {
    const tok = JSON.parse((await viaProxy(h.port, h.caPem, 'prod.us-east-1.auth.desktop.kiro.dev', { method: 'POST', path: '/refreshToken', body: '{}' })).body);
    assert.match(tok.accessToken, /^kiromask\./);
    assert.ok(tok.expiresIn > 86400 && tok.profileArn.startsWith('arn:aws:codewhisperer'));
    const other = await viaProxy(h.port, h.caPem, AWS_HOST, { path: '/GetProfile' });
    assert.deepEqual(JSON.parse(other.body), { status: 'ok' });
    const lim = JSON.parse((await viaProxy(h.port, h.caPem, AWS_HOST, { path: '/getUsageLimits?origin=AI_EDITOR' })).body);
    assert.equal(lim.limits, null); assert.ok(Array.isArray(lim.usageBreakdownList) && lim.subscriptionInfo.subscriptionTitle, 'a structurally valid "nothing used" answer');
  } finally { await h.stop(); }
});

test('telemetry / usage-limits / other AWS calls follow config and custom-model state', async () => {
  const awsHandler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"from":"aws"}'); };
  const h = await startApp({ kiro_endpoint: { telemetry: true, updates: true } }, { awsHandler });
  try {
    const get = (host, p, method = 'GET') => viaProxy(h.port, h.caPem, host, { method, path: p, body: method === 'POST' ? '{}' : undefined }).then((r) => JSON.parse(r.body));
    assert.deepEqual(await get(AWS_HOST, '/getUsageLimits'), { from: 'aws' });
    assert.deepEqual(await get('telemetry.us-east-1.kiro.dev', '/v1/traces', 'POST'), { from: 'aws' });
    h.app.state.customActive = true; // a custom model was just used
    assert.deepEqual(await get(AWS_HOST, '/getUsageLimits'), { from: 'aws' }, 'usage is Kiro\'s real data, so it is passed through');
    assert.deepEqual(await get('telemetry.us-east-1.kiro.dev', '/v1/traces', 'POST'), { status: 'ok' }, 'telemetry is swallowed while a custom model is active');
    assert.deepEqual(await get(AWS_HOST, '/SomethingElse'), { status: 'ok' }, 'other AWS calls swallowed while a custom model is active');
  } finally { await h.stop(); }
  const h2 = await startApp({ kiro_endpoint: { force_toggle_usage_limits: false } }, { awsHandler: () => assert.fail('must not reach AWS') });
  try {
    const u = JSON.parse((await rpc(h2, 'management.us-east-1.kiro.dev', 'KiroControlPlaneBearerService.GetUsageLimits', {})).body);
    assert.equal(u.usageBreakdownList[0].currentUsage, 0); assert.ok(!('limits' in u), 'the JSON-RPC shape has no legacy fields');
  } finally { await h2.stop(); }
});

test('update check is suppressed with a well-formed empty response', async () => {
  const h = await startApp({});
  try {
    const r = JSON.parse((await viaProxy(h.port, h.caPem, 'prod.download.desktop.kiro.dev', { path: '/releases/stable/metadata-win32-x64-user.json', headers: { 'user-agent': 'KiroIDE-0.9.40-abc' } })).body);
    assert.deepEqual(r, { currentRelease: '0.9.40', releases: [] }, 'reports the running version (learned from the user-agent) so Kiro sees "up to date"');
    const again = JSON.parse((await viaProxy(h.port, h.caPem, 'prod.download.desktop.kiro.dev', { path: '/x/metadata-win32-x64-user.json' })).body);
    assert.equal(again.currentRelease, '0.9.40', 'and remembers it');
  } finally { await h.stop(); }
});

test('MCP: web_search definition rewritten, and tools/call routed to a configured HTTP backend', async () => {
  const awsTools = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'web_search', description: 'aws', inputSchema: { type: 'object' } }, { name: 'other', description: 'o' }] } };
  const backend = await mockServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [{ title: 'T', url: 'http://x' }] })); });
  const h = await startApp({ web_search: { description: 'custom desc', execute: { type: 'http', url: `http://127.0.0.1:${backend.port}/s`, api_key: 'sk-x' } } }, { awsHandler: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(awsTools)); } });
  try {
    const list = JSON.parse((await viaProxy(h.port, h.caPem, AWS_HOST, { method: 'POST', path: '/mcp', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).body);
    assert.deepEqual(list.result.tools.map((t) => [t.name, t.description]), [['other', 'o'], ['web_search', 'custom desc']]);
    const call = JSON.parse((await viaProxy(h.port, h.caPem, AWS_HOST, { method: 'POST', path: '/mcp', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'node 22' } } }) })).body);
    assert.equal(call.id, 7);
    assert.deepEqual(JSON.parse(call.result.content[0].text), { results: [{ title: 'T', url: 'http://x' }] });
    assert.deepEqual(JSON.parse(backend.seen[0].body), { query: 'node 22' });
    assert.equal(backend.seen[0].headers.authorization, 'Bearer sk-x');
    assert.equal(h.aws.seen.length, 1, 'only tools/list reached AWS');
  } finally { await h.stop(); backend.close(); }
});

test('hosts outside the intercept list are tunnelled byte-for-byte (never decrypted)', async () => {
  const net = await import('node:net');
  const echo = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d])))); 
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const h = await startApp({});
  try {
    const http = await import('node:http');
    const got = await new Promise((resolve, reject) => {
      const c = http.request({ host: '127.0.0.1', port: h.port, method: 'CONNECT', path: `127.0.0.1:${echo.address().port}` });
      c.on('connect', (res, socket) => { socket.write('ping'); socket.once('data', (d) => { socket.destroy(); resolve(d.toString()); }); });
      c.on('error', reject); c.end();
    });
    assert.equal(got, 'echo:ping');
    assert.ok(h.app.proxy.stats.tunnelled >= 1);
  } finally { await h.stop(); echo.close(); }
});

test('Stop during a SILENT provider (no further chunks) cancels the upstream request promptly', async () => {
  let providerSawClose = false;
  const provider = await mockServer((req, res) => {
    sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'thinking…' } }] }); // then total silence
    res.on('close', () => { providerSawClose = true; });
  });
  const h = await startApp(providerConfig(provider.port));
  try {
    const ctl = new AbortController();
    const p = post(h, kiroRequest(), { signal: ctl.signal, onChunk: () => setTimeout(() => ctl.abort(), 50) }).catch(() => {});
    await p; await sleep(500);
    assert.ok(providerSawClose, 'provider connection closed even though it never sent another chunk');
  } finally { await h.stop(); provider.close(); }
});

test('ListAvailableModels: an AWS 5xx still shows your models (cache + custom); a 401 is passed through so Kiro can re-login', async () => {
  let status = 200;
  const awsHandler = (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 200 ? JSON.stringify({ models: [{ modelId: 'auto', modelName: 'Auto' }] }) : '{"message":"nope"}'); };
  const provider = await mockServer(() => {});
  const h = await startApp(providerConfig(provider.port), { awsHandler });
  try {
    const get = () => viaProxy(h.port, h.caPem, AWS_HOST, { path: '/ListAvailableModels' });
    assert.deepEqual(JSON.parse((await get()).body).models.map((m) => m.modelId), ['auto', 'my-model']);
    status = 503;
    const r5 = await get();
    assert.equal(r5.status, 200);
    assert.deepEqual(JSON.parse(r5.body).models.map((m) => m.modelId), ['auto', 'my-model'], 'cached Kiro models + custom during the outage');
    status = 401;
    const r4 = await get();
    assert.equal(r4.status, 401, 'auth errors reach Kiro untouched');
  } finally { await h.stop(); provider.close(); }
});
