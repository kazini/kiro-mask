import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CertAuthority } from '../lib/ca.mjs';
import { startMocks } from '../lib/matrix.mjs';
import { parseArgs, buildLaunch } from '../capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_URL = pathToFileURL(path.join(ROOT, 'lib', 'matrix.mjs')).href;

/** A stand-in for Kiro: honours --proxy-server, talks h1 + h2 through it, has a strict client, and one connection that bypasses the proxy. */
function makeFakeKiro(dir) {
  fs.mkdirSync(path.join(dir, 'resources', 'app', 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'out', 'cli.js'), '// cli');
  fs.writeFileSync(path.join(dir, 'resources', 'app', 'product.json'), JSON.stringify({ nameShort: 'Kiro', version: '9.9.9', commit: 'abcdef1234567890', apiKey: 'MUST-NOT-BE-COPIED', extensionsGallery: { serviceUrl: 'https://secret.example' } }));
  const exe = path.join(dir, 'Kiro');
  fs.writeFileSync(exe, `#!/usr/bin/env node
const fs = require('fs'), net = require('net');
(async () => {
  const m = await import(${JSON.stringify(MATRIX_URL)});
  const port = Number(process.argv.find((a) => a.startsWith('--proxy-server=')).split(':').pop());
  const tls = require('tls'), https = require('https');
  const out = { env: { HTTPS_PROXY: process.env.HTTPS_PROXY, CA: !!process.env.NODE_EXTRA_CA_CERTS } };
  const secure = (socket, o) => new Promise((res, rej) => { const t = tls.connect({ socket, rejectUnauthorized: false, ...o }, () => res(t)); t.on('error', rej); });
  { // HTTP/1.1 with a secret header
    const s = await secure(await m.connectTunnel(port, 'h1.test:443'), { servername: 'h1.test', ALPNProtocols: ['http/1.1'] });
    await new Promise((res) => { const r = https.request({ host: 'h1.test', path: '/echo', headers: { host: 'h1.test', authorization: 'Bearer secret-token-value-123' }, createConnection: () => s }, (x) => { x.resume(); x.on('end', res); }); r.end(); });
    s.destroy();
    global.keepOpen = await secure(await m.connectTunnel(port, 'h1.test:443'), { servername: 'h1.test', ALPNProtocols: ['http/1.1'] }); // like real Kiro: a persistent idle connection
  }
  { // HTTP/2
    const http2 = require('http2');
    const s = await secure(await m.connectTunnel(port, 'h2.test:443'), { servername: 'h2.test', ALPNProtocols: ['h2'] });
    await new Promise((res) => { const c = http2.connect('https://h2.test', { createConnection: () => s }); const r = c.request({ ':path': '/echo' }); r.resume(); r.on('end', () => { c.close(); res(); }); r.end(); });
  }
  { // strict client: refuses the proxy's certificate
    try { await secure(await m.connectTunnel(port, 'h1.test:443'), { servername: 'h1.test', ALPNProtocols: ['http/1.1'], rejectUnauthorized: true, ca: tls.rootCertificates }); } catch (e) { out.strictError = e.code; } // pins the public roots only, like a client with its own trust store
  }
  // a connection that does NOT go through the proxy
  const direct = net.connect(Number(process.env.FAKE_BYPASS_PORT), '127.0.0.1');
  direct.on('error', () => {});
  fs.writeFileSync(process.env.FAKE_READY, JSON.stringify(out));
  const t0 = Date.now();
  while (!fs.existsSync(process.env.FAKE_STOP) && Date.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
})();
`, { mode: 0o755 });
  return exe;
}

test('capture: argument parsing and launch plan', () => {
  const o = parseArgs(['--port', '9000', '--mode', 'tunnel', '--passthrough', 'a.com, b.com', '--no-env-proxy', '--env', 'X=1=2', '--extra-arg', '--foo', '--meta-only', '--duration', '5']);
  assert.deepEqual([o.port, o.mode, o.passthrough, o.envProxy, o.env, o.extraArgs, o.metaOnly, o.duration], [9000, 'tunnel', ['a.com', 'b.com'], false, { X: '1=2' }, ['--foo'], true, 5]);
  assert.throws(() => parseArgs(['--mode', 'x']), /--mode/);
  assert.throws(() => parseArgs(['--port', '99999']), /invalid --port/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-l-')); const exe = makeFakeKiro(d);
  const on = buildLaunch({ exe, port: 8899, tlsMode: 'permissive', caCertPath: '/ca.pem', envProxyOn: true, extraArgs: [], extraEnv: {}, baseEnv: {} });
  assert.deepEqual(on.args.slice(1), ['--ignore-certificate-errors', '--proxy-server=127.0.0.1:8899']);
  assert.equal(on.env.HTTPS_PROXY, 'http://127.0.0.1:8899'); assert.equal(on.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(on.env.SSL_CERT_FILE, undefined, 'trust roots are not replaced by default');
  const off = buildLaunch({ exe, port: 1, tlsMode: 'spki', caCertPath: '/ca.pem', caPin: 'PIN=', envProxyOn: false, extraArgs: ['--x'], extraEnv: {}, baseEnv: {} });
  assert.ok(off.args.includes('--ignore-certificate-errors-spki-list=PIN=') && off.args.includes('--x') && !off.env.HTTPS_PROXY && !off.env.NODE_TLS_REJECT_UNAUTHORIZED);
});

test('capture: full run with a fake Kiro — records h1+h2, handshake failure, bypass; redacts; packs a tar.gz', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-cap-'));
  const mockCa = new CertAuthority({ dir: path.join(work, 'mockca'), keyType: 'ec' }); mockCa.init();
  const mocks = await startMocks(mockCa);
  const bypass = net.createServer((s) => s.on('error', () => {})); await new Promise((r) => bypass.listen(0, '127.0.0.1', r));
  const exe = makeFakeKiro(path.join(work, 'KiroInstall'));
  const out = path.join(work, 'out'), ready = path.join(work, 'ready'), stop = path.join(work, 'stop');
  const child = spawn(process.execPath, [path.join(ROOT, 'capture.mjs'), '--exe', exe, '--out', out, '--port', '0', '--no-logs'], {
    env: { ...process.env, KMDIAG_CA_DIR: path.join(work, 'ca'), KMDIAG_UPSTREAM_MAP: JSON.stringify(mocks.upstreamMap), KMDIAG_LOOPBACK_EXTERNAL: '1', KMDIAG_MONITOR_INTERVAL_MS: '300', FAKE_BYPASS_PORT: String(bypass.address().port), FAKE_READY: ready, FAKE_STOP: stop },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (b) => (log += b)); child.stderr.on('data', (b) => (log += b));
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 150 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(ready), `fake Kiro never became ready.\n${log}`);
    const fake = JSON.parse(fs.readFileSync(ready, 'utf8'));
    assert.equal(fake.env.CA, true); assert.match(fake.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/); assert.ok(fake.strictError, 'the strict client refused the certificate');
    await new Promise((r) => setTimeout(r, 1200)); // let the monitor see the direct connection
    fs.writeFileSync(stop, '1'); // fake Kiro exits → capture notices and finishes by itself
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('TIMEOUT'), 25000))]);
    assert.equal(code, 0, `capture did not finish by itself (${code}).\n${log}`);

    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    assert.ok(summary.totals.connections >= 3); assert.equal(summary.totals.handshakeFailures, 1); assert.equal(summary.totals.flows, 2);
    const hs = summary.hosts.find((h) => h.host === 'h2.test'); assert.deepEqual(hs.negotiated, ['h2']); assert.equal(hs.known, false);
    const texts = summary.hints.map((h) => h.text).join('\n');
    assert.match(texts, /outside Kiro Mask's default intercept list.*h1\.test/s, 'hosts outside the default intercept list are called out');
    assert.match(texts, /h1\.test: 1 TLS handshake failure.*rejected the certificate.*ALPN \["http\/1\.1"\]/s, 'a failed handshake says why, and what the client had offered');
    assert.match(texts, /Process "(Kiro|node)".*DIRECTLY.*bypassing the proxy/s, 'the bypassing connection is reported against the process that made it');
    assert.match(texts, /Processes that DID use the proxy: (Kiro|node)/);
    assert.ok(summary.bypass.direct.some((d) => d.remotePort === bypass.address().port));

    const session = JSON.parse(fs.readFileSync(path.join(out, 'session.json'), 'utf8'));
    assert.equal(session.kiro.product.version, '9.9.9'); assert.equal(session.endReason, 'Kiro closed');
    assert.ok(session.launch.environmentVariablesSet.includes('HTTPS_PROXY'));
    assert.ok(!JSON.stringify(session).includes('MUST-NOT-BE-COPIED') && !JSON.stringify(session).includes('secret.example'), 'only safe version fields are copied from product.json');

    const archive = `${out}.tar.gz`; assert.ok(fs.existsSync(archive));
    const listing = execFileSync('tar', ['-tzf', archive]).toString();
    for (const f of ['summary.md', 'summary.json', 'session.json', 'connections.jsonl', 'flows.jsonl', 'bypass.jsonl']) assert.ok(listing.includes(`/${f}`), `${f} is in the archive`);
    const everything = execFileSync('tar', ['-xzOf', archive]).toString();
    assert.ok(!everything.includes('secret-token-value-123'), 'no credential anywhere in the archive');
    assert.ok(!listing.includes('ca.rsa.key') && !everything.includes('PRIVATE KEY'), 'the CA private key is never archived');
    assert.match(log, /Send this file/);
  } finally { child.kill(); mocks.close(); bypass.close(); }
});
