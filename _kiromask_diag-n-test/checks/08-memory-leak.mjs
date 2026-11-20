// Simulation: push real requests through the proxy repeatedly and assert the heap (after forced GC) stays flat.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createCheck, skip } from '../lib/check.mjs';
import { captureFiles, readRequest } from '../lib/paths.mjs';

if (!globalThis.gc) { // re-run ourselves with --expose-gc
  const r = spawnSync(process.execPath, ['--expose-gc', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const c = captureFiles();
if (!c?.requests.length) skip('KIROMASK_CAPTURES not set');
const { startApp, rpc, viaProxy, RUNTIME_HOST, providerConfig, sseHead, sseWrite } = await import('../tests/harness.js');
const { isTitleBody } = await import('../lib/paths.mjs');
const t = createCheck('Heap stays flat across repeated real-traffic passes');

// a provider that retains nothing, so any growth is the proxy's
const provider = http.createServer((req, res) => { req.resume(); req.on('end', () => { sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }); sseWrite(res, '[DONE]'); res.end(); }); });
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const h = await startApp(providerConfig(provider.address().port));
const bodies = c.requests.slice(0, 60).filter((f) => !isTitleBody(readRequest(f).kiro)).map((f) => {
  const { kiro, format } = readRequest(f);
  if (format === 'aws') kiro.conversationState.currentMessage.userInputMessage.modelId = 'my-model'; else kiro.model = 'my-model';
  return { format, body: JSON.stringify(kiro) };
});
const send = ({ format, body }) => (format === 'aws'
  ? rpc(h, RUNTIME_HOST, 'KiroRuntimeService.GenerateAssistantResponse', body)
  : viaProxy(h.port, h.caPem, RUNTIME_HOST, { method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body }));

const PASSES = 6, heap = [];
for (let p = 0; p < PASSES; p++) {
  for (const b of bodies) await send(b);
  h.logs.length = 0; gc(); await new Promise((r) => setTimeout(r, 80)); gc();
  heap.push(Math.round(process.memoryUsage().heapUsed / 1e6));
}
t.info(`heapUsed after each pass (MB): ${heap.join(' → ')}  (${bodies.length * PASSES} requests)`);
t.ok(heap.at(-1) - heap[1] <= 15, `heap grew ${heap.at(-1) - heap[1]} MB between pass 2 and ${PASSES} (limit 15 MB)`);
t.eq(h.app.proxy.stats.intercepted, bodies.length * PASSES, 'every request went through interception');
await h.stop(); provider.close();
t.finish();
