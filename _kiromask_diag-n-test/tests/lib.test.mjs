import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { parseClientHello } from '../lib/clienthello.mjs';
import { redactHeaders, redactUrl, redactBody, redactText } from '../lib/redact.mjs';
import { tarGz } from '../lib/tar.mjs';
import { parseTasklistCsv, parseCimJson, parsePs, parseNetstatWin, parseSs, parseLsof, parseProcNet, kiroPids, splitAddr, isLoopback, listProcesses, listConnections } from '../lib/procs.mjs';
import { envProxy } from '../lib/sysproxy.mjs';
import { readVersions, listExecutables, collectLogs, candidatePaths, findKiroExe } from '../lib/kiroinfo.mjs';
import { buildSummary, normalizePath } from '../lib/report.mjs';
import { run } from '../lib/procs.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kd-lib-'));

async function captureHello(clientCmd) {
  const srv = net.createServer(); let got; 
  const done = new Promise((r) => srv.on('connection', (s) => { s.once('data', (d) => { got = d; s.destroy(); r(); }); s.on('error', () => {}); }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const child = clientCmd(srv.address().port); child.on?.('error', () => {});
  await Promise.race([done, new Promise((r) => setTimeout(r, 4000))]);
  child.kill?.(); srv.close();
  return got;
}

test('clienthello: parses Node and curl ClientHellos (SNI, ALPN, versions, JA3) and rejects non-TLS', async () => {
  const tls = await import('node:tls');
  const nodeHello = await captureHello((port) => { const s = tls.connect({ port, host: '127.0.0.1', servername: 'q.us-east-1.amazonaws.com', ALPNProtocols: ['h2', 'http/1.1'] }); s.on('error', () => {}); return s; });
  const h = parseClientHello(nodeHello);
  assert.equal(h.ok, true); assert.equal(h.sni, 'q.us-east-1.amazonaws.com'); assert.deepEqual(h.alpn, ['h2', 'http/1.1']);
  assert.ok(h.versions.includes('TLS1.3')); assert.match(h.ja3, /^[0-9a-f]{32}$/); assert.ok(h.cipherCount > 5);
  if (await run('curl', ['--version'])) {
    const curlHello = await captureHello((port) => spawn('curl', ['-sk', '--max-time', '3', '--http2', '--resolve', `kiro.example:${port}:127.0.0.1`, `https://kiro.example:${port}/`], { stdio: 'ignore' }));
    const c = parseClientHello(curlHello); assert.equal(c.sni, 'kiro.example'); assert.ok(c.alpn.includes('h2'));
    assert.notEqual(c.ja3, h.ja3, 'different TLS stacks have different fingerprints');
  }
  const plain = parseClientHello(Buffer.from('GET /x HTTP/1.1\r\nHost: a\r\n\r\n')); assert.deepEqual([plain.ok, plain.reason], [false, 'not-tls']); assert.match(plain.preview, /GET \/x/);
  assert.equal(parseClientHello(Buffer.from([0x16, 3, 1, 0, 50, 1])).ok, false);
  assert.equal(parseClientHello(Buffer.alloc(0)).ok, false);
});

test('redact: headers, urls, JSON/form/text bodies — shapes kept, secrets gone, counts untouched', () => {
  const h = redactHeaders({ authorization: 'Bearer abcdefghijklmnop', Cookie: 'a=b', 'x-amz-security-token': 'zz', 'content-type': 'json', 'x-api-key': 'k' });
  assert.equal(h.authorization, 'Bearer [redacted len=16]'); assert.match(h.Cookie, /^\[redacted/); assert.equal(h['content-type'], 'json');
  assert.equal(redactUrl('https://h/p?X-Amz-Signature=abc&q=1&access_token=t'), 'https://h/p?X-Amz-Signature=%5Bredacted+len%3D3%5D&q=1&access_token=%5Bredacted+len%3D1%5D');
  const j = JSON.parse(redactBody(Buffer.from(JSON.stringify({ accessToken: 'secret', tokenLimits: { maxInputTokens: 5 }, nested: { clientSecret: 'x', keep: 'y' }, arr: [{ refreshToken: 'r' }] })), 'application/json'));
  assert.deepEqual(j, { accessToken: '[redacted len=6]', tokenLimits: { maxInputTokens: 5 }, nested: { clientSecret: '[redacted len=1]', keep: 'y' }, arr: [{ refreshToken: '[redacted len=1]' }] });
  assert.equal(redactBody(Buffer.from('a=1&client_secret=xyz&b=2'), 'application/x-www-form-urlencoded').toString(), 'a=1&client_secret=[redacted len=3]&b=2');
  assert.ok(!redactText('x AKIAABCDEFGHIJKLMNOP y sk-abcdefghijklmnopqrstuv z').match(/AKIA|sk-abc/));
});

test('tar: produces a valid archive that system tar can list and extract byte-for-byte', async () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  const big = Buffer.alloc(100_003, 9); fs.writeFileSync(path.join(d, 'a', 'b', 'big.bin'), big); fs.writeFileSync(path.join(d, 'empty.txt'), '');
  fs.writeFileSync(path.join(d, 'é ünï.txt'), 'unicode name');
  const out = path.join(tmp(), 'x.tar.gz'); await tarGz(d, out, 'root');
  const listing = execFileSync('tar', ['--quoting-style=literal', '-tzf', out]).toString().split('\n').filter(Boolean).sort();
  assert.deepEqual(listing, ['root/', 'root/a/', 'root/a/b/', 'root/a/b/big.bin', 'root/empty.txt', 'root/é ünï.txt']);
  assert.ok(execFileSync('tar', ['-xzOf', out, 'root/a/b/big.bin']).equals(big));
});

test('procs: Windows/macOS/Linux output parsers', () => {
  assert.deepEqual(parseNetstatWin('  Proto  Local Address  Foreign Address  State  PID\r\n  TCP    127.0.0.1:50021   127.0.0.1:8899   ESTABLISHED   12345\r\n  TCP    [::1]:1   [::1]:2   ESTABLISHED   4\r\n  UDP    0.0.0.0:5353   *:*   1\r\n'),
    [{ local: '127.0.0.1:50021', remote: '127.0.0.1:8899', state: 'ESTABLISHED', pid: 12345 }, { local: '[::1]:1', remote: '[::1]:2', state: 'ESTABLISHED', pid: 4 }]);
  assert.deepEqual(parseTasklistCsv('"Kiro.exe","1234","Console","1","123,456 K"\r\n'), [{ pid: 1234, ppid: null, name: 'Kiro.exe', exe: null, cmd: null }]);
  assert.deepEqual(parseCimJson('{"ProcessId":2,"ParentProcessId":1,"Name":"x","ExecutablePath":null}'), [{ pid: 2, ppid: 1, name: 'x', exe: null, cmd: null }]);
  assert.equal(parseCimJson('[{"ProcessId":10,"ParentProcessId":1,"Name":"Kiro.exe","ExecutablePath":"C:\\\\K\\\\Kiro.exe"}]')[0].exe, 'C:\\K\\Kiro.exe');
  assert.deepEqual(parseCimJson('not json'), []);
  assert.deepEqual(parsePs('  55 1234 kiro-cli /usr/share/kiro/resources/kiro-cli chat\n')[0], { pid: 55, ppid: 1234, name: 'kiro-cli', exe: '/usr/share/kiro/resources/kiro-cli', cmd: '/usr/share/kiro/resources/kiro-cli chat' });
  assert.deepEqual(parseSs('ESTAB 0 0 127.0.0.1:41234 127.0.0.1:8899 users:(("node",pid=1234,fd=23))\n'), [{ local: '127.0.0.1:41234', remote: '127.0.0.1:8899', state: 'ESTABLISHED', pid: 1234 }]);
  assert.deepEqual(parseLsof('Kiro      1234 user   27u  IPv4 0xabc      0t0  TCP 127.0.0.1:50000->52.1.2.3:443 (ESTABLISHED)\n'), [{ local: '127.0.0.1:50000', remote: '52.1.2.3:443', state: 'ESTABLISHED', pid: 1234 }]);
  const pn = parseProcNet('  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:C350 0100007F:22C3 01 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0\n');
  assert.deepEqual(pn, [{ local: '127.0.0.1:50000', remote: '127.0.0.1:8899', state: 'ESTABLISHED', inode: '99999' }]);
  assert.deepEqual([splitAddr('[::1]:443'), splitAddr('1.2.3.4:80')], [{ ip: '::1', port: 443 }, { ip: '1.2.3.4', port: 80 }]);
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && !isLoopback('52.1.2.3'));
});

test('procs: Kiro process tree = by name, by install dir, plus all descendants; unrelated apps excluded', () => {
  const procs = [{ pid: 1, ppid: 0, name: 'init' }, { pid: 10, ppid: 1, name: 'Kiro.exe', exe: 'C:/K/Kiro.exe' }, { pid: 11, ppid: 10, name: 'agent.exe', exe: 'C:/K/resources/agent.exe' }, { pid: 12, ppid: 11, name: 'git.exe' }, { pid: 20, ppid: 1, name: 'chrome.exe' }, { pid: 30, ppid: 1, name: 'helper', exe: 'C:/K/resources/h.exe' }, { pid: 40, ppid: 1, name: 'node', cmd: 'node /x/kiromask-capture.mjs', exe: '/usr/bin/node' }];
  assert.deepEqual([...kiroPids(procs, { installDir: 'C:/K', selfPid: 40 })].sort((a, b) => a - b), [10, 11, 12, 30]);
  assert.deepEqual([...kiroPids(procs, { installDir: null, selfPid: 40 })].sort((a, b) => a - b), [10, 11, 12], 'without an install dir: by name and descendants only');
});

test('procs (live): this machine\'s own process and a real listening+connected socket pair are found', async () => {
  const procs = await listProcesses(); assert.ok(procs.some((p) => p.pid === process.pid));
  if (process.platform !== 'linux') return;
  const srv = net.createServer((s) => s.on('error', () => {})); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = net.connect(srv.address().port, '127.0.0.1'); await new Promise((r) => c.once('connect', r));
  const conns = await listConnections();
  assert.ok(conns.some((x) => x.pid === process.pid && x.state === 'ESTABLISHED' && x.remote === `127.0.0.1:${srv.address().port}`), 'live /proc connection found with its owning pid');
  c.destroy(); srv.close();
});

test('sysproxy: env proxies are reported with credentials stripped', () => {
  assert.equal(envProxy({ HTTPS_PROXY: 'http://user:pa55@proxy.corp:8080', NODE_TLS_REJECT_UNAUTHORIZED: '0', PATH: 'x' }).HTTPS_PROXY, 'http://***@proxy.corp:8080');
  assert.deepEqual(Object.keys(envProxy({ PATH: 'x' })), []);
});

test('kiroinfo: copies only safe version fields, lists bundled executables, finds installs, scrubs collected logs', () => {
  const d = tmp(); const app = path.join(d, 'resources', 'app');
  fs.mkdirSync(path.join(app, 'out'), { recursive: true }); fs.mkdirSync(path.join(d, 'resources', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify({ nameShort: 'Kiro', version: '1.2.3', commit: 'abc', apiKey: 'NOPE', telemetryKey: 'NOPE2' }));
  fs.writeFileSync(path.join(d, 'Kiro.exe'), 'x'); fs.writeFileSync(path.join(d, 'resources', 'bin', 'kiro-agent.exe'), 'x');
  const v = readVersions(path.join(d, 'Kiro.exe')); assert.deepEqual(v.product, { nameShort: 'Kiro', version: '1.2.3', commit: 'abc' });
  assert.deepEqual(listExecutables(d).map((e) => e.path), ['Kiro.exe', 'resources/bin/kiro-agent.exe']);
  assert.equal(findKiroExe(path.join(d, 'Kiro.exe')), path.join(d, 'Kiro.exe')); assert.equal(findKiroExe(path.join(d, 'x.exe')), null);
  assert.ok(candidatePaths({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, cwd: 'C:\\w' }).some((p) => /Programs.*Kiro.*Kiro\.exe/.test(p)));
  const logs = path.join(d, 'logs', '20250101T000000', 'window1'); fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'renderer.log'), 'ok line\nAuthorization: Bearer abcdefghijklmnopqrst\nsecond');
  fs.writeFileSync(path.join(d, 'logs', 'old.log'), 'ancient'); fs.utimesSync(path.join(d, 'logs', 'old.log'), new Date('2020-01-01'), new Date('2020-01-01'));
  const dest = path.join(d, 'copy'); const r = collectLogs(dest, Date.now() - 1000, { root: path.join(d, 'logs') });
  assert.deepEqual(r.files.map((f) => f.file), ['20250101T000000/window1/renderer.log'], 'only logs touched during the session');
  const copied = fs.readFileSync(path.join(dest, '20250101T000000', 'window1', 'renderer.log'), 'utf8');
  assert.ok(copied.includes('ok line') && !copied.includes('abcdefghijklmnopqrst'));
});

test('report: findings for new hosts, h2-only clients, handshake failures, TLS inspection, websockets, bypass and missing chat', () => {
  const conn = (o) => ({ id: 1, host: 'x', port: 443, decision: 'intercept', hello: { ok: true, alpn: ['http/1.1'], sni: 'x', ja3: 'j' }, handshake: { ok: true, alpn: 'http/1.1' }, upstream: { ok: true, alpn: 'http/1.1', authorized: true }, errors: [], ws: false, isIP: false, requests: 1, ...o });
  const { data } = buildSummary({
    conns: [
      conn({ host: 'q.us-east-1.amazonaws.com' }),
      conn({ host: 'new.kiro.example', hello: { ok: true, alpn: ['h2'] }, handshake: { ok: true, alpn: 'h2' } }),
      conn({ host: 'pinned.example.com', handshake: { ok: false, error: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA' }, hello: { ok: true, alpn: ['http/1.1'] } }),
      conn({ host: 'alpn.example.com', handshake: { ok: false, error: 'ERR_SSL_NO_APPLICATION_PROTOCOL' }, hello: { ok: true, alpn: ['grpc'] } }),
      conn({ host: 'inspected.example.com', upstream: { ok: true, alpn: 'http/1.1', authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN', issuer: 'Corp Proxy CA' } }),
      conn({ host: 'ws.kiro.dev', ws: true }), conn({ host: '52.1.2.3', isIP: true }),
    ],
    flows: [{ host: 'q.us-east-1.amazonaws.com', method: 'GET', path: '/ListAvailableModels', status: 200, proto: 'h1', ms: 5 }],
    monitor: { processes: [{ pid: 9, name: 'kiro-agent.exe', exe: 'C:/K/agent.exe', proxiedConns: 0, directConns: 2 }], direct: [{ pid: 9, process: 'kiro-agent.exe', exe: 'C:/K/agent.exe', remote: '3.4.5.6:443', remoteIp: '3.4.5.6', remotePort: 443 }] },
    names: { '3.4.5.6': 'ec2-3-4-5-6.compute.amazonaws.com' },
  });
  const t = data.hints.map((h) => `${h.severity}|${h.text}`).join('\n');
  assert.match(t, /critical\|Process "kiro-agent\.exe".*DIRECTLY.*3\.4\.5\.6:443/s);
  assert.match(t, /outside Kiro Mask's default intercept list.*new\.kiro\.example.*pinned\.example\.com/s);
  assert.match(t, /pinned\.example\.com: 1 TLS handshake failure.*rejected the proxy certificate/s);
  assert.match(t, /alpn\.example\.com: 1 TLS handshake failure.*application protocol \(ALPN\)/s);
  assert.match(t, /new\.kiro\.example: the client offers ONLY HTTP\/2/);
  assert.match(t, /inspected\.example\.com: the REAL server's certificate does not validate.*Corp Proxy CA/s);
  assert.match(t, /ws\.kiro\.dev: WebSocket/); assert.match(t, /52\.1\.2\.3: connection made to an IP address/);
  assert.match(t, /No GenerateAssistantResponse request was recorded/);
  assert.equal(data.hints[0].severity, 'critical', 'most severe first');
  assert.equal(data.hosts.find((h) => h.host === 'q.us-east-1.amazonaws.com').known, true);
  assert.equal(buildSummary({ conns: [], flows: [] }).data.hints[0].severity, 'critical', 'zero connections is the top finding');
  assert.equal(normalizePath('/a/123456/b/0f8fad5b-d9cb-469f-a165-70867728950e/c'), '/a/{id}/b/{id}/c');
});

test('report: JSON-RPC style calls (POST / + X-Amz-Target) are shown per operation and count as chat', () => {
  const conn = { id: 1, host: 'runtime.us-east-1.kiro.dev', port: 443, decision: 'intercept', hello: { ok: true, alpn: [], sni: 'x' }, handshake: { ok: true, alpn: 'http/1.1' }, upstream: { ok: true, alpn: 'h2', authorized: true }, errors: [], requests: 3 };
  const flow = (target) => ({ host: 'runtime.us-east-1.kiro.dev', method: 'POST', path: '/', target, status: 200, proto: 'h1', ms: 5, reqBytes: 10, resBytes: 20 });
  const { data } = buildSummary({ conns: [conn], flows: [flow('KiroRuntimeService.GenerateAssistantResponse'), flow('KiroRuntimeService.GenerateAssistantResponse'), flow('KiroRuntimeService.InvokeMCP')] });
  assert.deepEqual(data.endpoints.map((e) => [e.path, e.count]), [['/ [KiroRuntimeService.GenerateAssistantResponse]', 2], ['/ [KiroRuntimeService.InvokeMCP]', 1]]);
  const t = data.hints.map((h) => h.text).join('\n');
  assert.match(t, /Chat endpoint seen: runtime\.us-east-1\.kiro\.dev \[KiroRuntimeService\.GenerateAssistantResponse\]/);
  assert.doesNotMatch(t, /No GenerateAssistantResponse request/);
});
