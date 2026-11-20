import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, launcherSelfTest, realThroughProxy, curlThrough, main } from '../doctor.mjs';
import { startRecorderRig } from '../lib/rig.mjs';
import { run } from '../lib/procs.mjs';

test('doctor: argument parsing', () => {
  assert.deepEqual(parseArgs(['--hosts', 'a.com, b.com', '--skip-network', '--out', 'x']), { hosts: ['a.com', 'b.com'], skipNetwork: true, out: 'x' });
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--exe']), /needs a value/);
});

test('doctor: launcher self-test runs cli.js --version through ELECTRON_RUN_AS_NODE and reports success/failure', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-doc-'));
  const exe = path.join(d, 'Kiro');
  fs.writeFileSync(exe, '#!/usr/bin/env node\nif (process.env.ELECTRON_RUN_AS_NODE !== "1") process.exit(3);\nif (process.argv[3] === "--version") { console.log("1.2.3\\nabcdef\\nx64"); process.exit(0); }\nprocess.exit(2);\n', { mode: 0o755 });
  const ok = await launcherSelfTest(exe, path.join(d, 'cli.js'));
  assert.equal(ok.ok, true); assert.match(ok.out, /^1\.2\.3/);
  const bad = await launcherSelfTest(path.join(d, 'does-not-exist'), 'cli.js');
  assert.equal(bad.ok, false); assert.ok(bad.error);
});

test('doctor: real-server-through-proxy and curl paths work (against local mocks standing in for real hosts)', async () => {
  const rig = await startRecorderRig();
  try {
    const h1 = await realThroughProxy(rig.proxyPort, 'h1.test', 'h1'); assert.deepEqual([h1.ok, h1.status, h1.alpn], [true, 200, 'http/1.1']);
    const h2 = await realThroughProxy(rig.proxyPort, 'h2.test', 'h2'); assert.deepEqual([h2.ok, h2.status, h2.alpn], [true, 200, 'h2']);
    const fallback = await realThroughProxy(rig.proxyPort, 'h1.test', 'h2'); assert.deepEqual([fallback.ok, fallback.alpn], [true, 'http/1.1'], 'client offering h2 falls back for an h1-only server');
    const bad = await realThroughProxy(rig.proxyPort, 'nope.invalid', 'h1'); assert.equal(bad.ok, false);
    if (await run('curl', ['--version'])) {
      const c1 = await curlThrough(rig.proxyPort, 'h1.test', '--http1.1'); assert.match(c1.result, /^200 http\/1\.1/);
      const c2 = await curlThrough(rig.proxyPort, 'h2.test', '--http2'); assert.match(c2.result, /^200 http\/2/, 'curl negotiates HTTP/2 through the recorder');
    }
  } finally { await rig.stop(); }
});

test('doctor: full run offline completes, degrades gracefully, and writes a small credential-free archive', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-docrun-'));
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  let res;
  try { res = await main(['--out', path.join(out, 'r'), '--quiet', '--skip-network']); } finally { console.log = orig; }
  const report = res.report;
  assert.ok(report.results.some((r) => r.id === 'kiro-exe' && r.status === 'fail'), 'missing Kiro is reported, not thrown');
  assert.equal(report.matrix.recorder.filter((r) => !r.ok && r.id !== 'cert-validation').length, 0);
  assert.equal(report.matrix.recorder.find((r) => r.id === 'cert-validation').ok, true);
  assert.ok(fs.existsSync(res.archive) && fs.statSync(res.archive).size < 200_000);
  const txt = fs.readFileSync(path.join(res.outDir, 'report.txt'), 'utf8');
  assert.match(txt, /== Proxy compatibility matrix: recording proxy ==/);
  assert.ok(!/Bearer|PRIVATE KEY/.test(txt + JSON.stringify(report)));
});
