import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptRequest, applyPatch } from '../../_kiromask-src/providers/adapt.mjs';
import { startApp, viaProxy, mockServer, AWS_HOST, kiroRequest, sseHead, sseWrite, providerConfig } from './harness.js';
import { textOf } from './helpers.js';

const base = { model: 'm', stream: true, stream_options: { include_usage: true }, max_tokens: 16384, messages: [] };

test('adapt: drops stream_options when the provider rejects it', () => {
  const r = adaptRequest(base, "Unknown parameter: 'stream_options'.");
  assert.ok(r && !('stream_options' in r.body)); assert.deepEqual(r.patch, { noStreamOptions: true });
  assert.equal(adaptRequest({ ...base, stream_options: undefined }, 'stream_options'), null, 'nothing to drop');
});
test('adapt: switches between max_tokens and max_completion_tokens', () => {
  const a = adaptRequest(base, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
  assert.equal(a.body.max_completion_tokens, 16384); assert.ok(!('max_tokens' in a.body));
  const { max_tokens, ...noMax } = base;
  const b = adaptRequest({ ...noMax, max_completion_tokens: 8000 }, "Unrecognized request argument supplied: max_completion_tokens. Please use max_tokens");
  assert.equal(b.body.max_tokens, 8000); assert.ok(!('max_completion_tokens' in b.body));
});
test('adapt: clamps to the provider output cap, in several real-world phrasings', () => {
  const cases = [
    ['max_tokens is too large: 16384. This model supports at most 4096 completion tokens, whereas you provided 16384.', 4096],
    ['max_tokens: 40000 > 32000, which is the maximum allowed number of output tokens for this model', 32000],
    ['Invalid max_tokens value, must be less than or equal to 8,192.', 8192],
  ];
  for (const [msg, n] of cases) {
    const body = { ...base, max_tokens: msg.includes('40000') ? 40000 : 16384 };
    assert.equal(adaptRequest(body, msg, { type: msg.includes('40000') ? 'anthropic' : 'openai' })?.body.max_tokens, n, msg.slice(0, 40));
  }
});
test('adapt: leaves unrelated errors alone (context overflow, auth, garbage)', () => {
  for (const m of ["This model's maximum context length is 131072 tokens. However, your messages resulted in 150000 tokens.", 'Invalid API key', '', null]) {
    assert.equal(adaptRequest(base, m), null, String(m).slice(0, 40));
  }
});
test('applyPatch re-applies learned fixes to later requests', () => {
  const b = applyPatch(base, { noStreamOptions: true, maxTokensParam: 'max_completion_tokens', maxTokens: 4096 });
  assert.deepEqual([b.stream_options, b.max_tokens, b.max_completion_tokens], [undefined, undefined, 4096]);
  assert.equal(applyPatch(base, undefined), base);
});

test('e2e: provider rejects stream_options then max_tokens; Kiro Mask adapts, answers, and remembers for the next request', async () => {
  const provider = await mockServer((req, res, rec) => {
    const b = JSON.parse(rec.body);
    if (b.stream_options) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Unknown parameter: stream_options"}}'); }
    if (b.max_tokens > 1000) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"max_tokens is too large. This model supports at most 1000 completion tokens."}}'); }
    sseHead(res); sseWrite(res, { choices: [{ delta: { content: `ok(${b.max_tokens})` }, finish_reason: 'stop' }] }); res.end();
  });
  const h = await startApp({ ...providerConfig(provider.port), providers: { mock: { ...providerConfig(provider.port).providers.mock, models: [{ name: 'my-model', max_tokens: 5000 }] } } });
  try {
    const ask = () => viaProxy(h.port, h.caPem, AWS_HOST, { method: 'POST', path: '/generateAssistantResponse', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kiroRequest()) });
    assert.equal(textOf([(await ask()).body]), 'ok(1000)');
    assert.equal(provider.seen.length, 3, 'rejected twice, then accepted');
    assert.ok(h.logs.some((l) => /warn: mock: provider caps output at 1000/.test(l)), 'user is told how to avoid the extra round trip');
    assert.equal(textOf([(await ask()).body]), 'ok(1000)');
    assert.equal(provider.seen.length, 4, 'the next request is right first time');
    const last = JSON.parse(provider.seen.at(-1).body);
    assert.ok(!('stream_options' in last));
  } finally { await h.stop(); provider.close(); }
});
