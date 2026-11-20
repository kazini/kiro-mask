import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CertAuthority } from '../lib/ca.mjs';
import { Recorder } from '../lib/mitm.mjs';
import { startMocks, CASES, runCase } from '../lib/matrix.mjs';

async function setup(keyType = 'ec', recOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-mitm-'));
  const ca = new CertAuthority({ dir: path.join(dir, 'ca'), keyType }); ca.init();
  const mockCa = new CertAuthority({ dir: path.join(dir, 'mockca'), keyType: 'ec' }); mockCa.init();
  const mocks = await startMocks(mockCa);
  const out = path.join(dir, 'out');
  const rec = new Recorder({ outDir: out, ca, insecureUpstream: true, upstreamMap: mocks.upstreamMap, ...recOpts });
  const { port } = await rec.listen(0);
  return { dir, out, rec, mocks, proxyPort: port, caPem: ca.caCertPem, async stop() { await rec.close(); mocks.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const readJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

for (const keyType of ['ec', 'rsa']) {
  test(`recorder (${keyType} certificates): every client scenario works`, async () => {
    const h = await setup(keyType);
    try {
      const results = [];
      for (const c of CASES) results.push(await runCase(c, h));
      const failed = results.filter((r) => !r.ok);
      assert.deepEqual(failed.map((r) => `${r.id}: ${r.detail}`), [], 'all scenarios succeed');
      assert.equal(results.length, 14);
    } finally { await h.stop(); }
  });
}

test('recorder: connection log says what each client offered and what was negotiated', async () => {
  const h = await setup();
  try {
    for (const id of ['h1-basic', 'h2-basic', 'h1-no-alpn', 'ip-literal', 'cert-validation', 'plaintext-in-connect']) await runCase(CASES.find((c) => c.id === id), h);
    await h.rec.close();
    const conns = readJsonl(path.join(h.out, 'connections.jsonl'));
    const by = (pred) => conns.find(pred);
    const h1 = by((c) => c.host === 'h1.test' && c.handshake?.ok && c.handshake.alpn === 'http/1.1');
    assert.ok(h1, 'h1 connection negotiated http/1.1');
    assert.equal(h1.hello.sni, 'h1.test'); assert.deepEqual(h1.hello.alpn, ['http/1.1']); assert.equal(h1.decision, 'intercept');
    assert.match(h1.hello.ja3, /^[0-9a-f]{32}$/);
    assert.equal(h1.upstream.ok, true); assert.equal(h1.upstream.alpn, 'http/1.1');
    const h2 = by((c) => c.host === 'h2.test' && c.handshake?.alpn === 'h2');
    assert.ok(h2, 'h2 connection negotiated h2'); assert.deepEqual(h2.hello.alpn, ['h2']); assert.equal(h2.upstream.alpn, 'h2');
    assert.ok(by((c) => c.host === 'h1.test' && c.hello.alpn.length === 0), 'a client without ALPN was seen as such');
    const ip = by((c) => c.isIP && c.hello?.ok); assert.equal(ip.hello.sni, null, 'IP target: no SNI recorded'); assert.ok(ip.handshake.ok);
    const rejected = by((c) => c.host === 'h1.test' && c.handshake && !c.handshake.ok);
    assert.ok(rejected, 'the strict client\'s failed handshake is recorded'); assert.ok(rejected.handshake.error, 'with a reason');
    assert.deepEqual(rejected.hello.alpn, ['http/1.1'], 'and what the client had offered');
    const plain = by((c) => c.decision === 'tunnel(non-tls)'); assert.ok(plain, 'cleartext inside CONNECT is tunnelled and flagged'); assert.match(plain.notes.join(' '), /not a TLS ClientHello.*GET \/x/);
  } finally { await h.stop(); }
});

test('recorder: flows are written with redacted credentials; event streams are decoded; HTTP/2 and WebSocket are recorded', async () => {
  const h = await setup();
  try {
    for (const id of ['h1-basic', 'h2-post', 'streaming', 'websocket']) await runCase(CASES.find((c) => c.id === id), h);
    await h.rec.close();
    const flows = readJsonl(path.join(h.out, 'flows.jsonl'));
    assert.deepEqual(flows.map((f) => f.proto).sort(), ['h1', 'h1', 'h2', 'ws']);
    const ws = flows.find((f) => f.proto === 'ws'); assert.equal(ws.status, 101);
    const files = fs.readdirSync(path.join(h.out, 'flows'));
    const all = files.map((f) => fs.readFileSync(path.join(h.out, 'flows', f), 'utf8')).join('\n');
    assert.ok(!all.includes('secret-token-value-123'), 'bearer token never written');
    assert.match(all, /Bearer \[redacted len=\d+\]/, 'but its presence/shape is recorded');
    const ev = files.find((f) => f.endsWith('.res.events.jsonl'));
    assert.ok(ev, 'event stream decoded'); const lines = fs.readFileSync(path.join(h.out, 'flows', ev), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.type), ['assistantResponseEvent', 'assistantResponseEvent', 'contextUsageEvent']);
    assert.equal(lines[0].payload.content, 'first');
    const post = JSON.parse(fs.readFileSync(path.join(h.out, 'flows', files.find((f) => f.includes('_POST_') && f.endsWith('.json'))), 'utf8'));
    assert.equal(post.request.body.bytes, 50_000); assert.equal(post.protocol, 'h2'); assert.equal(post.response.status, 200);
  } finally { await h.stop(); }
});

test('recorder: tunnel-only mode never decrypts but still logs hosts, ClientHello and byte counts', async () => {
  const h = await setup('ec', { mode: 'tunnel' });
  try {
    const net = await import('node:net'); const http = await import('node:http'); const tls = await import('node:tls');
    // upstream TLS server reachable at 127.0.0.1:<h1 port>; tunnel there and handshake end-to-end (client sees the REAL server cert)
    const sock = await new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port: h.proxyPort, method: 'CONNECT', path: `127.0.0.1:${h.mocks.ports.h1}` }); r.on('connect', (rs, s) => res(s)); r.on('error', rej); r.end(); });
    const t = await new Promise((res, rej) => { const c = tls.connect({ socket: sock, servername: 'h1.test', rejectUnauthorized: false }, () => res(c)); c.on('error', rej); });
    assert.equal(t.getPeerCertificate().subject.CN, 'h1.test', 'certificate comes from the real upstream, not from the recorder CA');
    t.destroy(); await new Promise((r) => setTimeout(r, 100)); await h.rec.close();
    const c = readJsonl(path.join(h.out, 'connections.jsonl'))[0];
    assert.equal(c.decision, 'tunnel(mode)'); assert.equal(c.hello.sni, 'h1.test'); assert.ok(c.bytesUp > 0 && c.bytesDown > 0);
  } finally { await h.stop(); }
});

test('recorder: passthrough globs tunnel only the matching hosts; metadata-only mode stores no bodies', async () => {
  const h = await setup('ec', { passthrough: ['h2.test'], noBodies: true });
  try {
    await runCase(CASES.find((c) => c.id === 'h1-basic'), h);
    const r2 = await runCase(CASES.find((c) => c.id === 'h2-basic'), h); // h2.test is tunnelled: client talks to the real mock directly (cert from mock CA, client doesn't verify)
    assert.ok(r2.ok);
    await h.rec.close();
    const conns = readJsonl(path.join(h.out, 'connections.jsonl'));
    assert.equal(conns.find((c) => c.host === 'h1.test').decision, 'intercept');
    assert.equal(conns.find((c) => c.host === 'h2.test').decision, 'tunnel(passthrough)');
    const flowFiles = fs.readdirSync(path.join(h.out, 'flows'));
    assert.ok(!flowFiles.some((f) => /\.(req|res)\./.test(f)), 'no body files in metadata-only mode');
  } finally { await h.stop(); }
});

test('recorder: upstream failure is reported to the client (502) and recorded', async () => {
  const h = await setup('ec', { upstreamMap: { 'dead.test': { host: '127.0.0.1', port: 1 } } });
  try {
    const { connectTunnel } = await import('../lib/matrix.mjs'); const tls = await import('node:tls'); const https = await import('node:https');
    const sock = await connectTunnel(h.proxyPort, 'dead.test:443');
    // probe fails (nothing listening) → recorder still intercepts, falls back to HTTP/1.1, and reports the 502 itself
    const s = await new Promise((res, rej) => { const t = tls.connect({ socket: sock, servername: 'dead.test', rejectUnauthorized: false }, () => res(t)); t.on('error', rej); });
    const status = await new Promise((res, rej) => { const r = https.request({ host: 'dead.test', path: '/', headers: { host: 'dead.test' }, createConnection: () => s }, (rs) => { rs.resume(); res(rs.statusCode); }); r.on('error', rej); r.end(); });
    assert.equal(status, 502);
    await h.rec.close();
    const conn = readJsonl(path.join(h.out, 'connections.jsonl')).find((c) => c.host === 'dead.test');
    assert.equal(conn.upstream.ok, false); assert.match(conn.errors.join(' '), /ECONNREFUSED/);
  } finally { await h.stop(); }
});
