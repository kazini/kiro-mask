// Client-compatibility matrix. Mock upstreams + a set of client behaviours that real applications exhibit
// (HTTP/1.1, HTTP/2-only, WebSocket, no SNI, IP targets, plaintext in a tunnel, certificate rejection…).
// Run against any HTTP(S) proxy to see which behaviours it handles. Used by the tests and by doctor.mjs.
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { encodeEvent } from './eventstream.mjs';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const readAll = async (s) => { const c = []; for await (const x of s) c.push(x); return Buffer.concat(c); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the mock upstreams. `ca` issues their certificates. Returns { ports, hosts, upstreamMap, close }. */
export async function startMocks(ca) {
  const servers = [];
  const echo = async (req, res, proto) => {
    const body = await readAll(req);
    if (req.url.startsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      res.write(encodeEvent('assistantResponseEvent', { content: 'first' }));
      await sleep(350);
      res.write(encodeEvent('assistantResponseEvent', { content: 'second' }));
      res.end(encodeEvent('contextUsageEvent', { contextUsagePercentage: 1.5 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-mock-proto': proto });
    res.end(JSON.stringify({ proto, method: req.method, url: req.url, bytes: body.length, auth: req.headers.authorization || null }));
  };

  const h1 = https.createServer({ ...ca.issue('h1.test'), ALPNProtocols: ['http/1.1'] }, (q, s) => echo(q, s, 'h1'));
  const h2 = http2.createSecureServer({ ...ca.issue('h2.test'), allowHTTP1: true }, (q, s) => echo(q, s, q.httpVersion === '2.0' ? 'h2' : 'h1'));
  const ws = https.createServer({ ...ca.issue('ws.test') }, (q, s) => { s.writeHead(426); s.end(); });
  ws.on('upgrade', (req, sock) => {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dGVzdA==\r\n\r\n');
    sock.on('data', (d) => sock.write(Buffer.from(d.toString().toUpperCase())));
  });
  const plain = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`plain ${req.method} ${req.url}`); });
  const ports = {};
  const live = new Set(); // every accepted socket, so close() can't hang on idle keep-alive / HTTP/2 sessions
  for (const [name, srv] of Object.entries({ h1, h2, ws, plain })) {
    servers.push(srv);
    srv.on(name === 'plain' ? 'connection' : 'secureConnection', (s) => { live.add(s); s.on('close', () => live.delete(s)); });
    ports[name] = await listen(srv);
  }
  return {
    ports,
    hosts: { h1: 'h1.test', h2: 'h2.test', ws: 'ws.test' },
    upstreamMap: { 'h1.test': { host: '127.0.0.1', port: ports.h1 }, 'h2.test': { host: '127.0.0.1', port: ports.h2 }, 'ws.test': { host: '127.0.0.1', port: ports.ws } },
    close: () => { for (const s of live) s.destroy(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } },
  };
}

// ── client building blocks ──
export function connectTunnel(proxyPort, target, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.setTimeout(timeout, () => req.destroy(new Error('CONNECT timeout')));
    req.on('connect', (res, socket) => (res.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT → ${res.statusCode}`))));
    req.on('error', reject);
    req.end();
  });
}
export const secure = (socket, { servername, alpn, ca, reject = false }) =>
  new Promise((resolve, rej) => {
    const t = tls.connect({ socket, servername, ALPNProtocols: alpn, ca, rejectUnauthorized: reject });
    t.once('secureConnect', () => resolve(t));
    t.once('error', (e) => { socket.destroy(); rej(e); });
  });
export function h1Req(tlsSock, host, { method = 'GET', path = '/echo', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({ method, path, host, headers: { host, ...headers }, createConnection: () => tlsSock }, async (res) => resolve({ status: res.statusCode, headers: res.headers, body: await readAll(res) }));
    r.on('error', reject); r.end(body);
  });
}
export function h2Req(tlsSock, host, { method = 'GET', path = '/echo', body } = {}) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`, { createConnection: () => tlsSock });
    client.on('error', reject);
    const r = client.request({ ':method': method, ':path': path });
    let status; const chunks = [];
    r.on('response', (h) => { status = h[':status']; });
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => { client.close(); resolve({ status, body: Buffer.concat(chunks) }); });
    r.on('error', reject);
    r.end(body);
  });
}
const json = (b) => JSON.parse(b.toString());

/** Each case: { id, desc, run(ctx) → {ok, detail} }.  ctx = { proxyPort, mocks, caPem } */
export const CASES = [
  { id: 'h1-basic', mock: 'h1', desc: 'HTTP/1.1 client through CONNECT (Node https, ALPN http/1.1)', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h1}:443`), { servername: mocks.hosts.h1, alpn: ['http/1.1'] });
    const r = await h1Req(s, mocks.hosts.h1, { headers: { authorization: 'Bearer secret-token-value-123' } }); s.destroy();
    return { ok: r.status === 200 && json(r.body).proto === 'h1', detail: `status ${r.status}, alpn ${s.alpnProtocol}` };
  } },
  { id: 'h1-no-alpn', mock: 'h1', desc: 'Client that sends no ALPN extension at all', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h1}:443`), { servername: mocks.hosts.h1 });
    const r = await h1Req(s, mocks.hosts.h1); s.destroy();
    return { ok: r.status === 200, detail: `status ${r.status}` };
  } },
  { id: 'h1-offer-h2', mock: 'h1', desc: 'Client offers h2+http/1.1 to an HTTP/1.1-only server (must fall back)', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h1}:443`), { servername: mocks.hosts.h1, alpn: ['h2', 'http/1.1'] });
    const r = s.alpnProtocol === 'h2' ? await h2Req(s, mocks.hosts.h1) : await h1Req(s, mocks.hosts.h1); s.destroy();
    return { ok: r.status === 200, detail: `negotiated ${s.alpnProtocol}, status ${r.status}` };
  } },
  { id: 'h2-basic', mock: 'h2', desc: 'HTTP/2 client (Node http2, ALPN h2) to an HTTP/2 server', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h2}:443`), { servername: mocks.hosts.h2, alpn: ['h2'] });
    const r = await h2Req(s, mocks.hosts.h2); s.destroy();
    return { ok: r.status === 200 && json(r.body).proto === 'h2', detail: `negotiated ${s.alpnProtocol}, status ${r.status}` };
  } },
  { id: 'h2-post', mock: 'h2', desc: 'HTTP/2 POST with a request body', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h2}:443`), { servername: mocks.hosts.h2, alpn: ['h2'] });
    const r = await h2Req(s, mocks.hosts.h2, { method: 'POST', body: Buffer.alloc(50_000, 1) }); s.destroy();
    return { ok: r.status === 200 && json(r.body).bytes === 50_000, detail: `echoed ${json(r.body).bytes} bytes` };
  } },
  { id: 'h2-only-vs-h1-upstream', mock: 'h1', desc: 'HTTP/2-only client, but the real server only speaks HTTP/1.1', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h1}:443`), { servername: mocks.hosts.h1, alpn: ['h2'] });
    const r = await h2Req(s, mocks.hosts.h1); s.destroy();
    return { ok: r.status === 200, detail: `negotiated ${s.alpnProtocol}, status ${r.status}` };
  } },
  { id: 'streaming', mock: 'h1', desc: 'Event-stream response arrives incrementally (not buffered)', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h1}:443`), { servername: mocks.hosts.h1, alpn: ['http/1.1'] });
    const t0 = Date.now(); let first = null;
    await new Promise((resolve, reject) => {
      const r = https.request({ method: 'GET', path: '/stream', host: mocks.hosts.h1, headers: { host: mocks.hosts.h1 }, createConnection: () => s }, (res) => { res.on('data', () => { first ??= Date.now() - t0; }); res.on('end', resolve); });
      r.on('error', reject); r.end();
    });
    s.destroy();
    return { ok: first !== null && first < 300, detail: `first chunk after ${first} ms (server delays the rest by 350 ms)` };
  } },
  { id: 'large-body', mock: 'h1', desc: 'POST a 3 MB body (no truncation)', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h1}:443`), { servername: mocks.hosts.h1, alpn: ['http/1.1'] });
    const r = await h1Req(s, mocks.hosts.h1, { method: 'POST', body: Buffer.alloc(3 * 1024 * 1024, 7) }); s.destroy();
    return { ok: r.status === 200 && json(r.body).bytes === 3 * 1024 * 1024, detail: `server received ${json(r.body).bytes} bytes` };
  } },
  { id: 'keepalive', mock: 'h1', desc: 'Two sequential requests on one connection', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h1}:443`), { servername: mocks.hosts.h1, alpn: ['http/1.1'] });
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 }); agent.createConnection = () => s;
    const get = () => new Promise((resolve, reject) => { const r = https.request({ method: 'GET', path: '/echo', host: mocks.hosts.h1, agent, headers: { host: mocks.hosts.h1 } }, async (res) => { await readAll(res); resolve(res.statusCode); }); r.on('error', reject); r.end(); });
    const a = await get(), b = await get(); s.destroy(); agent.destroy();
    return { ok: a === 200 && b === 200, detail: `statuses ${a}, ${b}` };
  } },
  { id: 'websocket', mock: 'ws', desc: 'WebSocket upgrade over TLS, then bidirectional bytes', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.ws}:443`), { servername: mocks.hosts.ws, alpn: ['http/1.1'] });
    const head = await new Promise((resolve, reject) => {
      let buf = ''; s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) resolve(buf); }); s.on('error', reject);
      s.write(`GET /socket HTTP/1.1\r\nHost: ${mocks.hosts.ws}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    s.write('ping');
    const echoed = await new Promise((resolve) => s.once('data', (d) => resolve(d.toString())));
    s.destroy();
    return { ok: /101/.test(head.split('\r\n')[0]) && echoed === 'PING', detail: `${head.split('\r\n')[0]}; echoed "${echoed}"` };
  } },
  { id: 'ip-literal', mock: 'h1', desc: 'CONNECT to an IP address; client sends no SNI', async run({ proxyPort, mocks }) {
    const s = await secure(await connectTunnel(proxyPort, `127.0.0.1:${mocks.ports.h1}`), { alpn: ['http/1.1'] });
    const r = await h1Req(s, '127.0.0.1'); s.destroy();
    return { ok: r.status === 200, detail: `status ${r.status}` };
  } },
  { id: 'plaintext-in-connect', mock: 'plain', desc: 'CONNECT to a plain-HTTP port; client speaks cleartext inside the tunnel', async run({ proxyPort, mocks }) {
    const sock = await connectTunnel(proxyPort, `127.0.0.1:${mocks.ports.plain}`);
    const out = await new Promise((resolve, reject) => { let b = ''; sock.on('data', (d) => { b += d; if (b.includes('plain GET')) resolve(b); }); sock.on('error', reject); sock.write('GET /x HTTP/1.1\r\nHost: plain\r\nConnection: close\r\n\r\n'); setTimeout(() => resolve(b), 4000); });
    sock.destroy();
    return { ok: /200/.test(out) && /plain GET \/x/.test(out), detail: out.split('\r\n')[0] || 'no response' };
  } },
  { id: 'plain-http-proxy', mock: 'plain', desc: 'Plain http:// request using absolute-URI proxying', async run({ proxyPort, mocks }) {
    const body = await new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://127.0.0.1:${mocks.ports.plain}/via-proxy`, headers: { host: `127.0.0.1:${mocks.ports.plain}` } }, async (res) => resolve({ status: res.statusCode, text: (await readAll(res)).toString() })); r.on('error', reject); r.end(); });
    return { ok: body.status === 200 && body.text.includes('/via-proxy'), detail: `${body.status} ${body.text}` };
  } },
  { id: 'cert-validation', mock: 'h1', desc: 'Strict client (verifies certificates, does not trust the proxy CA) must refuse — and the proxy should record why', expectFailure: true, async run({ proxyPort, mocks }) {
    try {
      const s = await secure(await connectTunnel(proxyPort, `${mocks.hosts.h1}:443`), { servername: mocks.hosts.h1, alpn: ['http/1.1'], reject: true });
      s.destroy();
      return { ok: false, detail: 'strict client was NOT stopped (it connected)' };
    } catch (e) { return { ok: true, detail: `refused as expected: ${e.code || e.message}` }; }
  } },
];

export async function runCase(c, ctx, timeoutMs = 10_000) {
  const t0 = Date.now();
  try {
    const r = await Promise.race([c.run(ctx), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return { id: c.id, desc: c.desc, ...r, ms: Date.now() - t0 };
  } catch (e) {
    return { id: c.id, desc: c.desc, ok: false, detail: `error: ${e.code || e.message}`, ms: Date.now() - t0 };
  }
}
