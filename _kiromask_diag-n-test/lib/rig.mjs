// Test rigs: the recorder + mock upstreams, and Kiro Mask's own proxy (the product) for side-by-side comparison.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CertAuthority } from './ca.mjs';
import { Recorder } from './mitm.mjs';
import { startMocks } from './matrix.mjs';

export async function startRecorderRig({ keyType = 'rsa', recOpts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-rig-'));
  const ca = new CertAuthority({ dir: path.join(dir, 'ca'), keyType }); ca.init();
  const mockCa = new CertAuthority({ dir: path.join(dir, 'mockca'), keyType: 'ec' }); mockCa.init();
  const mocks = await startMocks(mockCa);
  const rec = new Recorder({ outDir: path.join(dir, 'out'), ca, insecureUpstream: true, upstreamMap: mocks.upstreamMap, ...recOpts });
  const { port } = await rec.listen(0);
  return { dir, rec, mocks, proxyPort: port, caPem: ca.caCertPem, async stop() { await rec.close(); mocks.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Load Kiro Mask's proxy from `productDir` and start it pointed at one mock upstream. Returns null if unavailable. */
export async function startProductProxy(productDir, upstream = {}, { interceptHosts = ['*.test'] } = {}) {
  const url = (rel) => pathToFileURL(path.join(productDir, '_kiromask-src', rel)).href;
  let App, Config;
  try { ({ App } = await import(url('app.mjs'))); ({ Config } = await import(url('config/load.mjs'))); }
  catch (e) { return { error: `cannot load the product from ${productDir}: ${e.message}` }; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-prod-'));
  const config = new Config({ proxy: { port: 0, intercept_hosts: interceptHosts } }, { env: {} });
  const app = new App({ config, log: () => {}, dataDir, upstream });
  const info = await app.start();
  return { port: info.port, caPem: app.ca.caCertPem, app, async stop() { await app.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
