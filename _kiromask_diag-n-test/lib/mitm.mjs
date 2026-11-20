// A recording MITM proxy that aims to behave like mitmproxy, so that traffic is not missed:
//   • intercepts EVERY host by default (not a fixed list), including IP-literal targets
//   • speaks HTTP/1.1 and HTTP/2 to the client (ALPN negotiated against what the real upstream supports)
//   • passes WebSocket upgrades through, tunnels non-TLS / passthrough hosts, handles plain-HTTP proxying
//   • records WHY a connection failed (ClientHello contents + handshake error), not just that it did
// Everything is written under outDir; credentials are redacted before anything touches the disk.

import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseClientHello } from './clienthello.mjs';
import { redactHeaders, redactUrl, redactBody, redactText } from './redact.mjs';
import { FrameDecoder, payloadJson } from './eventstream.mjs';

const HOP = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'http2-settings']);
const globRe = (g) => new RegExp(`^${g.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
export const hostMatcher = (globs = []) => { const r = globs.map(globRe); return (h) => r.some((x) => x.test(String(h).toLowerCase())); };

export function splitHostPort(s, def = 443) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (m) return { host: m[1], port: Number(m[2]) || def };
  const i = s.lastIndexOf(':');
  return i > -1 && /^\d+$/.test(s.slice(i + 1)) && s.indexOf(':') === i ? { host: s.slice(0, i), port: Number(s.slice(i + 1)) } : { host: s, port: def };
}

const slug = (s, n = 40) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, n) || 'x';

/** Collect the initial bytes of a client connection (enough for a whole TLS record). */
function peek(sock, head, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    const finish = (b) => { cleanup(); resolve(b && b.length ? b : null); };
    const check = () => {
      if (buf.length < 5) return;
      if (buf[0] !== 0x16) return finish(buf);
      if (buf.length >= 5 + buf.readUInt16BE(3) || buf.length > 70_000) finish(buf);
    };
    const onData = (c) => { buf = Buffer.concat([buf, c]); check(); };
    const onEnd = () => finish(buf);
    const timer = setTimeout(() => finish(buf), timeoutMs);
    const cleanup = () => { clearTimeout(timer); sock.off('data', onData); sock.off('end', onEnd); sock.off('close', onEnd); sock.off('error', onEnd); sock.pause(); };
    sock.on('data', onData); sock.once('end', onEnd); sock.once('close', onEnd); sock.once('error', onEnd);
    check();
  });
}

/** Ask the REAL upstream what it supports (ALPN) and who vouches for its certificate. */
export function probeUpstream(target, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (r) => { try { sock.destroy(); } catch { /* closed */ } resolve({ ms: Date.now() - t0, ...r }); };
    const sock = tls.connect({ host: target.connectHost, port: target.connectPort, servername: target.servername, ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate();
      done({
        ok: true, alpn: sock.alpnProtocol || 'http/1.1', tls: sock.getProtocol(),
        authorized: sock.authorized, authorizationError: sock.authorizationError ? String(sock.authorizationError) : null,
        subject: c?.subject?.CN || null, issuer: [c?.issuer?.O, c?.issuer?.CN].filter(Boolean).join(' / ') || null, validTo: c?.valid_to || null,
      });
    });
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'timeout' }));
    sock.on('error', (e) => done({ ok: false, error: e.code || e.message }));
  });
}

class BodyRec {
  constructor(limit) { this.chunks = []; this.size = 0; this.total = 0; this.limit = limit; this.truncated = false; }
  push(c) {
    this.total += c.length;
    if (this.size + c.length <= this.limit) { this.chunks.push(c); this.size += c.length; }
    else { const room = Math.max(0, this.limit - this.size); if (room) { this.chunks.push(c.subarray(0, room)); this.size += room; } this.truncated = true; }
  }
  buffer() { return Buffer.concat(this.chunks); }
}

const decodeBody = (buf, enc) => {
  try {
    switch (String(enc || '').toLowerCase()) {
      case 'gzip': case 'x-gzip': return { buf: zlib.gunzipSync(buf), decoded: 'gzip' };
      case 'br': return { buf: zlib.brotliDecompressSync(buf), decoded: 'br' };
      case 'deflate': return { buf: zlib.inflateSync(buf), decoded: 'deflate' };
      default: return { buf };
    }
  } catch (e) { return { buf, decodeError: e.message }; }
};

const TEXTUAL = /json|text|xml|javascript|x-www-form-urlencoded|html|yaml|graphql/i;

export class Recorder extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.outDir
   * @param {import('./ca.mjs').CertAuthority} o.ca
   * @param {'intercept'|'tunnel'} [o.mode]            tunnel = never decrypt, only log hosts/bytes
   * @param {string[]} [o.passthrough]                 host globs to tunnel instead of intercept
   * @param {string[]} [o.fullHosts]                   host globs whose bodies are stored in full
   * @param {number} [o.bodyLimit]                     bytes of body kept for fullHosts
   * @param {number} [o.otherBodyLimit]                bytes of (textual) body kept for other hosts
   * @param {boolean} [o.redact]
   * @param {boolean} [o.noBodies]                     metadata only
   * @param {object} [o.upstreamMap]                   tests: {"host[:port]": {host, port}} → connect there instead
   * @param {boolean} [o.insecureUpstream]
   */
  constructor(o) {
    super();
    this.outDir = o.outDir;
    this.ca = o.ca;
    this.mode = o.mode || 'intercept';
    this.isPassthrough = hostMatcher(o.passthrough || []);
    this.isFull = hostMatcher(o.fullHosts || ['*']);
    this.bodyLimit = o.bodyLimit ?? 32 * 1024 * 1024;
    this.otherBodyLimit = o.otherBodyLimit ?? 64 * 1024;
    this.redact = o.redact !== false;
    this.noBodies = !!o.noBodies;
    this.upstreamMap = o.upstreamMap || {};
    this.insecureUpstream = !!o.insecureUpstream;
    this.log = o.log || (() => {});
    this.connSeq = 0;
    this.flowSeq = 0;
    this.open = new Map();
    this.sockets = new Set();
    this.pending = new Set(); // finalisers for in-flight upgraded (WebSocket) flows
    this.tlsServers = new Map();
    this.conns = [];
    this.flows = [];
    fs.mkdirSync(path.join(this.outDir, 'flows'), { recursive: true });

    this.h1 = http.createServer((req, res) => this.#safe(() => this.#onH1(req, res), res));
    this.h1.requestTimeout = 0; this.h1.timeout = 0;
    this.h1.on('upgrade', (req, sock, head) => this.#safe(() => this.#onUpgrade(req, sock, head)));
    this.h1.on('clientError', (e, s) => { if (s.writable) s.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
    this.h2 = http2.createServer({ allowHTTP1: false });
    this.h2.on('stream', (stream, headers) => this.#safe(() => this.#onH2Stream(stream, headers)));
    this.h2.on('sessionError', (e) => this.log('debug', `h2 session error: ${e.code || e.message}`));
    this.proxy = http.createServer((req, res) => this.#safe(() => this.#onPlain(req, res), res));
    this.proxy.requestTimeout = 0;
    this.proxy.on('connect', (req, sock, head) => this.#safe(() => this.#onConnect(req, sock, head)));
  }

  #safe(fn, res) {
    Promise.resolve().then(fn).catch((e) => {
      this.log('error', `recorder error: ${e.stack || e.message}`);
      if (res && !res.headersSent) { try { res.writeHead(500); res.end('recorder error'); } catch { /* gone */ } }
    });
  }

  listen(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => { this.proxy.once('error', reject); this.proxy.listen(port, host, () => { this.proxy.off('error', reject); resolve(this.proxy.address()); }); });
  }

  close() {
    for (const finish of [...this.pending]) finish('recorder shut down while the connection was still open');
    for (const c of [...this.open.values()]) this.#closeConn(c, 'recorder-shutdown');
    for (const sock of this.sockets) sock.destroy();
    this.h2.close();
    return new Promise((resolve) => { this.proxy.close(() => resolve()); this.proxy.closeAllConnections?.(); });
  }

  // ── bookkeeping ──
  #jsonl(file, obj) { try { fs.appendFileSync(path.join(this.outDir, file), JSON.stringify(obj) + '\n'); } catch { /* disk full etc. */ } }

  #newConn(host, port, client) {
    const conn = { id: ++this.connSeq, t: new Date().toISOString(), target: `${host}:${port}`, host, port, isIP: net.isIP(host) !== 0, decision: null, hello: null, upstream: null, handshake: null, requests: 0, bytesUp: 0, bytesDown: 0, notes: [], errors: [], ws: false, client: `${client.remoteAddress}:${client.remotePort}` };
    this.open.set(conn.id, conn);
    conn._t0 = Date.now();
    this.emit('connection', conn);
    return conn;
  }

  #closeConn(conn, why) {
    if (!this.open.has(conn.id)) return;
    this.open.delete(conn.id);
    if (conn.decision?.startsWith('intercept') && !conn.handshake) conn.handshake = { ok: false, error: conn.errors[0] || 'closed-before-handshake-completed' };
    conn.durationMs = Date.now() - conn._t0;
    conn.closed = why || 'closed';
    try { conn._h2up?.destroy(); } catch { /* already gone */ }
    delete conn._t0; delete conn._hs0; delete conn._h2up;
    this.conns.push(conn);
    this.#jsonl('connections.jsonl', conn);
    this.emit('connection-closed', conn);
  }

  #target(host, port) {
    const m = this.upstreamMap[`${host}:${port}`] || this.upstreamMap[host];
    if (m) return { connectHost: m.host, connectPort: m.port, servername: net.isIP(host) ? undefined : host, insecure: true };
    return { connectHost: host, connectPort: port, servername: net.isIP(host) ? undefined : host, insecure: this.insecureUpstream };
  }

  // ── CONNECT ──
  async #onConnect(req, client, head) {
    const { host, port } = splitHostPort(req.url);
    const conn = this.#newConn(host, port, client);
    this.sockets.add(client);
    client.on('error', (e) => conn.errors.push(`client: ${e.code || e.message}`));
    client.on('close', () => { this.sockets.delete(client); this.#closeConn(conn); });
    client.setNoDelay(true);

    if (this.mode === 'tunnel' || this.isPassthrough(host)) {
      conn.decision = this.mode === 'tunnel' ? 'tunnel(mode)' : 'tunnel(passthrough)';
      return this.#tunnel(conn, client, head, true);
    }
    conn.decision = 'intercept';
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const first = await peek(client, head);
    if (!first) { conn.decision = 'no-data'; conn.notes.push('client sent nothing after CONNECT'); return client.destroy(); }
    const hello = parseClientHello(first);
    conn.hello = hello;
    if (!hello.ok) {
      conn.decision = 'tunnel(non-tls)';
      conn.notes.push(`first bytes are not a TLS ClientHello (${hello.reason}): ${hello.preview || ''}`);
      client.unshift(first);
      return this.#tunnel(conn, client, null, false);
    }

    const target = this.#target(host, port);
    const probe = await probeUpstream(target);
    conn.upstream = probe;
    conn.upstreamAlpn = probe.alpn || 'http/1.1';
    const offered = hello.alpn || [];
    const protocols = [];
    if (offered.includes('h2') && (probe.alpn === 'h2' || !offered.includes('http/1.1'))) protocols.push('h2');
    if (offered.includes('http/1.1') || !offered.length) protocols.push('http/1.1');

    // Terminate TLS with a real tls.Server (HTTP/2 does not work on hand-built server-side TLSSockets).
    // ALPN depends on the client AND the real upstream, so there is one server per (host, protocol set).
    client.__conn = conn;
    conn._hs0 = Date.now();
    client.unshift(first);
    this.#tlsServer(host, protocols).emit('connection', client);
  }

  #connOf(sock) { return sock._parent?.__conn || sock.__conn || null; }

  #tlsServer(host, protocols) {
    const key = `${host}|${protocols.join(',')}`;
    let srv = this.tlsServers.get(key);
    if (srv) return srv;
    srv = tls.createServer({
      ...this.ca.issue(host), // default certificate for clients that send no SNI (e.g. IP targets)
      ALPNProtocols: protocols.length ? protocols : undefined,
      SNICallback: (sn, cb) => { try { cb(null, this.ca.contextFor(sn || host)); } catch (e) { cb(e); } },
    });
    srv.on('secureConnection', (sock) => {
      const conn = this.#connOf(sock);
      if (!conn) return sock.destroy();
      sock.__conn = conn;
      conn.handshake = { ok: true, ms: Date.now() - conn._hs0, alpn: sock.alpnProtocol || null, version: sock.getProtocol(), cipher: sock.getCipher()?.name, servername: sock.servername || null };
      sock.on('error', (e) => conn.errors.push(`tls: ${e.code || e.message}`));
      (sock.alpnProtocol === 'h2' ? this.h2 : this.h1).emit('connection', sock);
    });
    srv.on('tlsClientError', (err, sock) => {
      const conn = this.#connOf(sock);
      if (conn && !conn.handshake) conn.handshake = { ok: false, ms: Date.now() - conn._hs0, error: err.code || err.message, message: err.message };
    });
    this.tlsServers.set(key, srv);
    return srv;
  }

  #tunnel(conn, client, head, sendOk) {
    const target = this.#target(conn.host, conn.port);
    const up = net.connect(target.connectPort, target.connectHost);
    up.setNoDelay(true);
    up.once('connect', () => {
      if (sendOk) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      client.on('data', (c) => { conn.bytesUp += c.length; if (!conn.hello) conn.hello = parseClientHello(c); });
      up.on('data', (c) => { conn.bytesDown += c.length; });
      up.pipe(client); client.pipe(up);
    });
    up.on('error', (e) => { conn.errors.push(`upstream: ${e.code || e.message}`); if (sendOk && client.writable && !client.destroyed) client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); client.destroy(); });
    up.on('close', () => client.destroy());
    client.on('close', () => up.destroy());
  }

  // ── flow recording ──
  #newFlow(conn, proto, method, host, url, headers) {
    const flow = { seq: ++this.flowSeq, connId: conn.id, startedAt: new Date().toISOString(), proto, host, port: conn.port, method, url, hostHeader: null, _t0: Date.now(), reqHeaders: headers, req: new BodyRec(this.#limit(host)), res: new BodyRec(this.#limit(host)), status: null, resHeaders: null, error: null };
    conn.requests++;
    return flow;
  }
  #limit(host) { return this.noBodies ? 0 : this.isFull(host) ? this.bodyLimit : this.otherBodyLimit; }

  #store(flow, side, rec, headers, base) {
    const ct = String(headers?.['content-type'] || '');
    const info = { bytes: rec.total, stored: 0, truncated: rec.truncated || false };
    if (this.noBodies) return { ...info, omitted: 'metadata-only mode' };
    if (!rec.total) return info;
    if (!this.isFull(flow.host) && (!TEXTUAL.test(ct) && ct)) return { ...info, omitted: `non-textual body (${ct}) on a non-Kiro host` };
    if (!this.isFull(flow.host) && rec.total > this.otherBodyLimit) return { ...info, omitted: `body larger than ${this.otherBodyLimit} bytes on a non-Kiro host` };
    let { buf, decoded, decodeError } = decodeBody(rec.buffer(), headers?.['content-encoding']);
    if (decoded) info.decodedFrom = decoded;
    if (decodeError) info.decodeError = decodeError;
    const eventStream = /eventstream/i.test(ct);
    let ext = eventStream ? 'bin' : /json/i.test(ct) || /^\s*[[{]/.test(buf.subarray(0, 64).toString('utf8')) ? 'json' : TEXTUAL.test(ct) ? 'txt' : 'bin';
    if (eventStream) {
      const lines = [];
      try {
        const dec = new FrameDecoder({ verifyCrc: false });
        for (const f of dec.push(buf)) {
          if (lines.length >= 50_000) break;
          const p = payloadJson(f);
          lines.push(JSON.stringify({ type: f.eventType, messageType: f.messageType, payload: p ?? (f.payload.length ? f.payload.toString('base64').slice(0, 400) : null) }));
        }
        fs.writeFileSync(`${base}.${side}.events.jsonl`, redactText(lines.join('\n')) + '\n');
        info.eventsFile = path.basename(`${base}.${side}.events.jsonl`);
        info.events = lines.length;
      } catch (e) { info.eventsError = e.message; }
    }
    if (this.redact && !eventStream) buf = redactBody(buf, ct);
    const file = `${base}.${side}.${ext}`;
    fs.writeFileSync(file, buf);
    return { ...info, stored: buf.length, file: path.basename(file) };
  }

  #finishFlow(flow, aborted = false) {
    if (flow._done) return;
    flow._done = true;
    const base = path.join(this.outDir, 'flows', `${String(flow.seq).padStart(4, '0')}_${slug(flow.host, 30)}_${flow.method}_${slug(flow.url.split('?')[0].split('/').slice(3).join('_') || 'root', 40)}`);
    const reqH = this.redact ? redactHeaders(flow.reqHeaders) : flow.reqHeaders;
    const resH = flow.resHeaders && (this.redact ? redactHeaders(flow.resHeaders) : flow.resHeaders);
    const doc = {
      seq: flow.seq, connId: flow.connId, startedAt: flow.startedAt, durationMs: Date.now() - flow._t0, protocol: flow.proto,
      host: flow.host, port: flow.port, hostHeader: flow.hostHeader, method: flow.method, url: this.redact ? redactUrl(flow.url) : flow.url,
      aborted: aborted || undefined, error: flow.error || undefined,
      request: { headers: reqH, body: this.#store(flow, 'req', flow.req, flow.reqHeaders, base) },
      response: flow.status == null ? null : { status: flow.status, headers: resH, body: this.#store(flow, 'res', flow.res, flow.resHeaders, base) },
    };
    try { fs.writeFileSync(`${base}.json`, JSON.stringify(doc, null, 2)); } catch { /* ignore */ }
    const idx = { seq: flow.seq, t: flow.startedAt, connId: flow.connId, proto: flow.proto, host: flow.host, method: flow.method, path: doc.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0], target: flow.reqHeaders?.['x-amz-target'] || null, status: flow.status, ms: doc.durationMs, reqBytes: flow.req.total, resBytes: flow.res.total, ct: flow.resHeaders?.['content-type'] || null, err: flow.error || undefined, file: path.basename(base) + '.json' };
    this.flows.push(idx);
    this.#jsonl('flows.jsonl', idx);
    this.emit('flow', idx);
  }

  // ── HTTP/1.1 (decrypted) ──
  #onH1(req, res) {
    const conn = req.socket.__conn;
    const host = conn.host;
    const flow = this.#newFlow(conn, 'h1', req.method, host, `https://${req.headers.host || host}${req.url}`, { ...req.headers });
    if (req.headers.host && req.headers.host.replace(/:\d+$/, '') !== host) flow.hostHeader = req.headers.host;
    const target = this.#target(host, conn.port);
    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) { const k = req.rawHeaders[i]; if (!HOP.has(k.toLowerCase())) headers[k] = headers[k] ? [].concat(headers[k], req.rawHeaders[i + 1]) : req.rawHeaders[i + 1]; }
    const up = https.request({ host: target.connectHost, port: target.connectPort, method: req.method, path: req.url, headers, servername: target.servername, rejectUnauthorized: !target.insecure, agent: false }, (ur) => {
      flow.status = ur.statusCode; flow.resHeaders = { ...ur.headers };
      const out = {};
      for (let i = 0; i < ur.rawHeaders.length; i += 2) { const k = ur.rawHeaders[i]; if (!HOP.has(k.toLowerCase())) out[k] = out[k] ? [].concat(out[k], ur.rawHeaders[i + 1]) : ur.rawHeaders[i + 1]; }
      res.writeHead(ur.statusCode, ur.statusMessage, out);
      ur.on('data', (c) => { flow.res.push(c); res.write(c); });
      ur.on('end', () => { res.end(); this.#finishFlow(flow); });
      ur.on('error', (e) => { flow.error = `upstream response: ${e.code || e.message}`; res.destroy(); this.#finishFlow(flow, true); });
    });
    up.on('error', (e) => {
      flow.error = `upstream: ${e.code || e.message}`;
      conn.errors.push(flow.error);
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`recorder: upstream error: ${e.code || e.message}\n`); }
      else res.destroy();
      this.#finishFlow(flow, true);
    });
    res.on('close', () => { if (!res.writableEnded) { up.destroy(); flow.error ||= 'client closed before response completed'; this.#finishFlow(flow, true); } });
    req.on('data', (c) => { flow.req.push(c); up.write(c); });
    req.on('end', () => up.end());
  }

  // ── WebSocket / Upgrade ──
  #onUpgrade(req, sock, head) {
    const conn = sock.__conn;
    conn.ws = true;
    const host = conn.host;
    const flow = this.#newFlow(conn, 'ws', req.method, host, `wss://${req.headers.host || host}${req.url}`, { ...req.headers });
    const target = this.#target(host, conn.port);
    const up = tls.connect({ host: target.connectHost, port: target.connectPort, servername: target.servername, rejectUnauthorized: !target.insecure, ALPNProtocols: ['http/1.1'] });
    const sample = { up: Buffer.alloc(0), down: Buffer.alloc(0) };
    let respHead = Buffer.alloc(0), headDone = false;
    up.once('secureConnect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      sock.on('data', (c) => { conn.bytesUp += c.length; if (sample.up.length < 2048) sample.up = Buffer.concat([sample.up, c]).subarray(0, 2048); up.write(c); });
      up.on('data', (c) => {
        conn.bytesDown += c.length;
        if (!headDone) { respHead = Buffer.concat([respHead, c]); const i = respHead.indexOf('\r\n\r\n'); if (i > -1) { headDone = true; const lines2 = respHead.subarray(0, i).toString('latin1').split('\r\n'); flow.status = Number(/ (\d{3})/.exec(lines2[0])?.[1]) || null; flow.resHeaders = Object.fromEntries(lines2.slice(1).map((l) => { const j = l.indexOf(':'); return [l.slice(0, j).toLowerCase(), l.slice(j + 1).trim()]; })); } }
        else if (sample.down.length < 2048) sample.down = Buffer.concat([sample.down, c]).subarray(0, 2048);
        sock.write(c);
      });
    });
    const end = (why) => { this.pending.delete(end); if (flow._done) return; flow.error ||= why; flow.ws = { upBytes: conn.bytesUp, downBytes: conn.bytesDown, firstFrameUpHex: sample.up.toString('hex').slice(0, 200), firstFrameDownHex: sample.down.toString('hex').slice(0, 200) }; this.#finishFlow(flow); try { up.destroy(); sock.destroy(); } catch { /* gone */ } };
    this.pending.add(end);
    up.on('error', (e) => end(`upstream: ${e.code || e.message}`));
    up.on('close', () => end(undefined));
    sock.on('close', () => end(undefined));
    sock.on('error', () => {});
  }

  // ── HTTP/2 (decrypted) ──
  #h2Upstream(conn) {
    if (conn._h2up && !conn._h2up.destroyed && !conn._h2up.closed) return conn._h2up;
    const t = this.#target(conn.host, conn.port);
    conn._h2up = http2.connect(`https://${conn.host}:${conn.port}`, { createConnection: () => tls.connect({ host: t.connectHost, port: t.connectPort, servername: t.servername, ALPNProtocols: ['h2'], rejectUnauthorized: !t.insecure }) });
    conn._h2up.on('error', (e) => conn.errors.push(`h2 upstream: ${e.code || e.message}`));
    return conn._h2up;
  }

  #onH2Stream(stream, headers) {
    const conn = stream.session.socket.__conn;
    const host = conn.host;
    const flow = this.#newFlow(conn, 'h2', headers[':method'], host, `https://${headers[':authority'] || host}${headers[':path']}`, Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith(':'))));
    if (headers[':authority'] && headers[':authority'].replace(/:\d+$/, '') !== host) flow.hostHeader = headers[':authority'];
    // connection-specific headers are illegal in HTTP/2, except `te: trailers` (gRPC-style clients need it)
    const reqHeaders = Object.fromEntries(Object.entries(headers).filter(([k, v]) => !HOP.has(k) || (k === 'te' && v === 'trailers')));
    const sendErr = (e) => { flow.error = e; if (!stream.headersSent) { stream.respond({ ':status': 502, 'content-type': 'text/plain' }); stream.end(`recorder: ${e}\n`); } else stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); this.#finishFlow(flow, true); };

    if (conn.upstreamAlpn === 'h2') {
      const up = this.#h2Upstream(conn);
      const ureq = up.request(reqHeaders, { endStream: false });
      let trailers = {};
      ureq.on('response', (rh) => {
        flow.status = rh[':status']; flow.resHeaders = Object.fromEntries(Object.entries(rh).filter(([k]) => !k.startsWith(':')));
        const out = Object.fromEntries(Object.entries(rh).filter(([k]) => !HOP.has(k)));
        stream.respond(out, { waitForTrailers: true });
      });
      stream.on('wantTrailers', () => { try { stream.sendTrailers(trailers); } catch { /* closed */ } });
      ureq.on('trailers', (t) => { trailers = Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith(':'))); });
      ureq.on('data', (c) => { flow.res.push(c); stream.write(c); });
      ureq.on('end', () => { stream.end(); this.#finishFlow(flow); });
      ureq.on('error', (e) => sendErr(`upstream h2: ${e.code || e.message}`));
      stream.on('data', (c) => { flow.req.push(c); ureq.write(c); });
      stream.on('end', () => ureq.end());
      stream.on('close', () => { if (!flow._done) { ureq.close(); flow.error ||= 'client reset stream'; this.#finishFlow(flow, true); } });
      return;
    }
    // upstream only speaks HTTP/1.1: translate
    const t = this.#target(host, conn.port);
    const h1h = Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith(':') && !HOP.has(k)));
    h1h.host = headers[':authority'] || host;
    const up = https.request({ host: t.connectHost, port: t.connectPort, method: headers[':method'], path: headers[':path'], headers: h1h, servername: t.servername, rejectUnauthorized: !t.insecure, agent: false }, (ur) => {
      flow.status = ur.statusCode; flow.resHeaders = { ...ur.headers };
      stream.respond({ ':status': ur.statusCode, ...Object.fromEntries(Object.entries(ur.headers).filter(([k]) => !HOP.has(k))) });
      ur.on('data', (c) => { flow.res.push(c); stream.write(c); });
      ur.on('end', () => { stream.end(); this.#finishFlow(flow); });
    });
    up.on('error', (e) => sendErr(`upstream: ${e.code || e.message}`));
    stream.on('data', (c) => { flow.req.push(c); up.write(c); });
    stream.on('end', () => up.end());
    stream.on('close', () => { if (!flow._done) { up.destroy(); this.#finishFlow(flow, true); } });
  }

  // ── plain HTTP proxying (absolute-form request target) ──
  #onPlain(req, res) {
    let u; try { u = new URL(req.url); } catch { /* not absolute */ }
    if (!u || u.protocol !== 'http:') { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('recorder proxy: this is an HTTP proxy port, not a web server.\n'); }
    const conn = this.#newConn(u.hostname, Number(u.port) || 80, req.socket);
    conn.decision = 'http-proxy';
    const flow = this.#newFlow(conn, 'http-proxy', req.method, u.hostname, req.url, { ...req.headers });
    const up = http.request({ host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: req.headers, agent: false }, (ur) => {
      flow.status = ur.statusCode; flow.resHeaders = { ...ur.headers };
      res.writeHead(ur.statusCode, ur.headers);
      ur.on('data', (c) => { flow.res.push(c); res.write(c); });
      ur.on('end', () => { res.end(); this.#finishFlow(flow); this.#closeConn(conn); });
    });
    up.on('error', (e) => { flow.error = `upstream: ${e.code || e.message}`; if (!res.headersSent) { res.writeHead(502); res.end(); } this.#finishFlow(flow, true); this.#closeConn(conn); });
    req.on('data', (c) => { flow.req.push(c); up.write(c); });
    req.on('end', () => up.end());
  }
}
