import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startRecorderRig, startProductProxy } from '../lib/rig.mjs';
import { CASES, runCase } from '../lib/matrix.mjs';

const PRODUCT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // this folder lives inside the product folder

test('every matrix case names the mock it needs', () => { assert.ok(CASES.every((c) => ['h1', 'h2', 'ws', 'plain'].includes(c.mock))); });

test('rig: recorder passes the whole matrix', async () => {
  const rig = await startRecorderRig();
  try { const r = []; for (const c of CASES) r.push(await runCase(c, rig)); assert.deepEqual(r.filter((x) => !x.ok).map((x) => x.id), []); } finally { await rig.stop(); }
});

test('rig: product proxy is measurable on the same matrix (documents which behaviours it lacks)', { skip: !fs.existsSync(PRODUCT) && 'product folder not found' }, async () => {
  const rig = await startRecorderRig(); // only for its mock servers
  const results = {};
  try {
    for (const c of CASES) {
      const prod = await startProductProxy(PRODUCT, { connectHost: '127.0.0.1', port: rig.mocks.ports[c.mock], insecure: true });
      assert.ok(!prod.error, prod.error);
      try { results[c.id] = (await runCase(c, { proxyPort: prod.port, mocks: rig.mocks, caPem: prod.caPem }, 2500)).ok; } finally { await prod.stop(); }
    }
  } finally { await rig.stop(); }
  // what the product handles today (HTTP/1.1 path)
  for (const id of ['h1-basic', 'h1-no-alpn', 'h1-offer-h2', 'streaming', 'large-body', 'keepalive', 'plain-http-proxy', 'cert-validation']) assert.equal(results[id], true, id);
  // HTTP/2, WebSocket upgrades: expected to be unsupported by the product — this assertion documents the gap the diagnostics exist to expose
  for (const id of ['h2-basic', 'h2-post', 'h2-only-vs-h1-upstream', 'websocket']) assert.equal(results[id], false, `${id} unexpectedly works: update the product docs`);
});
