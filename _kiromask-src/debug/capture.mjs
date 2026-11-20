// Recording of the traffic Kiro sends through the proxy (config: debug.capture_traffic).
//
// Every intercepted request is recorded, whoever answered it (Kiro's servers, your provider, or Kiro Mask itself),
// into one folder per run:   <data_dir>/captures/<YYYYMMDD-HHMMSS>/
//
//   session.json                       what ran: kiromask + Kiro versions, platform, providers (never keys), …
//   summary.json                       counts by route / host / handler, and the chat requests in order
//   flows/NNNN_<host>_<METHOD>_<path>.json            one metadata file per exchange (headers, status, timings, who handled it)
//                                .req.json|.txt|.bin    the request Kiro sent               (credentials redacted)
//                                .res.json|.txt|.bin    the response Kiro received          (credentials redacted)
//                                .res.events.jsonl      …decoded, for AWS binary event streams
//                                .provider.req.json     what was sent to YOUR provider      (custom models only)
//                                .provider.res.txt|json what your provider answered         (custom models only)
//
// This is the same layout `_kiromask_diag-n-test/capture.mjs` writes, so the same tools and tests read both. The files
// contain your prompts and code: treat them as sensitive. Nothing in here ever throws into the request path.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FrameDecoder, payloadJson } from '../aws/eventstream.mjs';
import { redactHeaders, redactBody, redactText, redactUrl } from './redact.mjs';

export { redactHeaders };

const MAX_TEXT = 16 * 1024 * 1024; // stored per body (textual)
const MAX_BIN = 256 * 1024;        // stored per body (anything else: update packages and the like)
const TEXTUAL = /json|text|xml|javascript|event-stream|x-www-form-urlencoded/i;

const slug = (s, n) => String(s).replace(/[^a-zA-Z0-9.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, n) || 'x';
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

function decodeBody(buf, encoding) {
  try {
    switch (String(encoding || '').toLowerCase()) {
      case 'gzip': case 'x-gzip': return zlib.gunzipSync(buf);
      case 'br': return zlib.brotliDecompressSync(buf);
      case 'deflate': return zlib.inflateSync(buf);
      default: return buf;
    }
  } catch { return buf; }
}

/** Collects body chunks up to a cap while still counting every byte. */
class BodyRec {
  constructor(cap) { this.cap = cap; this.chunks = []; this.total = 0; this.kept = 0; }
  push(chunk) {
    if (chunk == null || typeof chunk === 'function') return;
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.total += b.length;
    if (this.kept < this.cap) { const take = b.subarray(0, this.cap - this.kept); this.chunks.push(take); this.kept += take.length; }
  }
  get truncated() { return this.total > this.kept; }
  buffer() { return Buffer.concat(this.chunks); }
}

/** One recorded exchange. Created by CaptureStore.begin(); the App feeds it as the response is produced. */
export class Flow {
  constructor(store, seq, { method, url, host, headers, body, route }) {
    this.store = store;
    this.seq = seq;
    this.startedAt = new Date().toISOString();
    this.t0 = Date.now();
    this.method = method;
    this.url = url;
    this.host = host;
    this.route = route;
    this.reqHeaders = { ...headers };
    this.reqBody = body ?? Buffer.alloc(0);
    this.status = null;
    this.resHeaders = null;
    this.res = new BodyRec(MAX_TEXT);
    this.notes = {};
    this.provider = null;
    this.done = false;
  }

  /** Attach facts about this exchange (handled, model, format…). */
  note(obj) { Object.assign(this.notes, obj); }
  setResponse(status, headers) { this.status = status; this.resHeaders = { ...headers }; }
  write(chunk) { this.res.push(chunk); }

  /** The call made to your provider on behalf of this exchange (custom models). */
  providerRequest({ url, body }) {
    this.provider = { url, request: body, status: null, error: null, chunks: new BodyRec(MAX_TEXT), json: null };
  }
  providerStatus(status) { if (this.provider) this.provider.status = status; }
  providerChunk(chunk) { this.provider?.chunks.push(chunk); }
  providerJson(obj) { if (this.provider) this.provider.json = obj; }
  providerError(message) { if (this.provider) this.provider.error = message; }

  finish({ aborted = false } = {}) {
    if (this.done) return;
    this.done = true;
    try { this.store._write(this, aborted); } catch (e) { this.store.log?.('debug', `capture: could not write flow ${this.seq}: ${e.message}`); }
  }
}

export class CaptureStore {
  /**
   * @param {string} root  e.g. <data_dir>/captures (a session folder is created inside it on first use)
   * @param {boolean} enabled
   * @param {{log?: Function, session?: object}} [o]
   */
  constructor(root, enabled = false, { log, session = {} } = {}) {
    this.root = root;
    this.enabled = enabled;
    this.log = log;
    this.sessionInfo = { startedAt: new Date().toISOString(), ...session };
    this.dir = null;
    this.seq = 0;
    this.index = [];
    this.open = new Set();
  }

  /** Update what session.json says (e.g. once Kiro's version is known). */
  setSession(info) { Object.assign(this.sessionInfo, info); if (this.dir) this.writeSession(); } // write-through: survives a killed process

  #ensure() {
    if (this.dir) return true;
    try {
      let dir = path.join(this.root, stamp());
      for (let n = 2; fs.existsSync(dir); n++) dir = path.join(this.root, `${stamp()}-${n}`);
      fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
      this.dir = dir;
      this.writeSession();
      this.log?.('info', `recording Kiro traffic to ${dir}`);
      return true;
    } catch (e) { this.log?.('warn', `capture: cannot create ${this.root}: ${e.message}`); this.enabled = false; return false; }
  }

  /** Start recording one exchange (null when capture is off). Never throws. */
  begin({ req, host, route }) {
    if (!this.enabled || !this.#ensure()) return null;
    try {
      const body = req.rawBody ?? Buffer.alloc(0);
      const flow = new Flow(this, ++this.seq, { method: req.method, url: `https://${req.headers.host || host}${req.url}`, host, headers: req.headers, body, route });
      this.open.add(flow);
      return flow;
    } catch { return null; }
  }

  #store(flow, side, rec, headers, base, { omitted } = {}) {
    const ct = String(headers?.['content-type'] || '');
    const info = { bytes: rec.total, stored: 0, truncated: rec.truncated || false };
    if (!rec.total) return info;
    if (omitted) return { ...info, omitted };
    let buf = rec.buffer();
    const enc = headers?.['content-encoding'];
    if (enc) { const d = decodeBody(buf, enc); if (d !== buf) { buf = d; info.decodedFrom = enc; } }
    const looksJson = /^\s*[[{]/.test(buf.subarray(0, 64).toString('utf8'));
    const eventStream = /eventstream/i.test(ct);
    const textual = TEXTUAL.test(ct) || looksJson;
    if (!textual && !eventStream && rec.total > MAX_BIN) return { ...info, omitted: `binary body larger than ${MAX_BIN} bytes` };
    const ext = eventStream ? 'bin' : /json/i.test(ct) || looksJson ? 'json' : textual ? 'txt' : 'bin';
    if (eventStream) {
      try {
        const lines = [];
        for (const f of new FrameDecoder({ verifyCrc: false }).push(buf)) {
          const p = payloadJson(f);
          lines.push(JSON.stringify({ type: f.eventType, messageType: f.messageType, payload: p ?? (f.payload.length ? f.payload.toString('base64').slice(0, 400) : null) }));
        }
        fs.writeFileSync(`${base}.${side}.events.jsonl`, redactText(lines.join('\n')) + '\n');
        info.eventsFile = path.basename(`${base}.${side}.events.jsonl`);
        info.events = lines.length;
      } catch (e) { info.eventsError = e.message; }
    } else {
      buf = redactBody(buf, ct);
    }
    const file = `${base}.${side}.${ext}`;
    fs.writeFileSync(file, buf);
    return { ...info, stored: buf.length, file: path.basename(file) };
  }

  /** @private called by Flow.finish() */
  _write(flow, aborted) {
    this.open.delete(flow);
    const u = new URL(flow.url);
    const base = path.join(this.dir, 'flows', `${String(flow.seq).padStart(4, '0')}_${slug(flow.host, 30)}_${flow.method}_${slug(u.pathname.split('/').slice(1).join('_') || 'root', 40)}`);
    const reqRec = new BodyRec(MAX_TEXT);
    reqRec.push(flow.reqBody);
    const skipBodies = flow.route === 'telemetry' ? 'telemetry bodies are not recorded' : undefined;
    const doc = {
      seq: flow.seq, startedAt: flow.startedAt, durationMs: Date.now() - flow.t0, protocol: 'h1',
      host: flow.host, method: flow.method, url: redactUrl(flow.url), route: flow.route, ...flow.notes,
      aborted: aborted || undefined,
      request: { headers: redactHeaders(flow.reqHeaders), body: this.#store(flow, 'req', reqRec, flow.reqHeaders, base, { omitted: skipBodies }) },
      response: flow.status == null ? null : { status: flow.status, headers: redactHeaders(flow.resHeaders || {}), body: this.#store(flow, 'res', flow.res, flow.resHeaders, base, { omitted: skipBodies }) },
    };
    if (flow.provider) {
      const p = flow.provider;
      const pdoc = { url: redactUrl(p.url), status: p.status, error: p.error || undefined };
      try {
        fs.writeFileSync(`${base}.provider.req.json`, redactBody(Buffer.from(JSON.stringify(p.request, null, 1)), 'application/json'));
        pdoc.request = { file: path.basename(`${base}.provider.req.json`) };
        if (p.json) {
          fs.writeFileSync(`${base}.provider.res.json`, redactBody(Buffer.from(JSON.stringify(p.json, null, 1)), 'application/json'));
          pdoc.response = { file: path.basename(`${base}.provider.res.json`) };
        } else if (p.chunks.total) {
          fs.writeFileSync(`${base}.provider.res.txt`, redactText(p.chunks.buffer().toString('utf8')));
          pdoc.response = { bytes: p.chunks.total, truncated: p.chunks.truncated, file: path.basename(`${base}.provider.res.txt`) };
        }
      } catch (e) { pdoc.writeError = e.message; }
      doc.provider = pdoc;
    }
    fs.writeFileSync(`${base}.json`, JSON.stringify(doc, null, 2));
    this.index.push({
      seq: flow.seq, t: flow.startedAt, host: flow.host, method: flow.method, path: u.pathname, route: flow.route, handled: flow.notes.handled ?? null,
      model: flow.notes.model ?? null, format: flow.notes.format ?? null, status: flow.status, ms: doc.durationMs,
      reqBytes: reqRec.total, resBytes: flow.res.total, file: path.basename(base) + '.json',
    });
    if (flow.route === 'chat') this.writeSummary(); // keep a usable summary on disk even if the process is killed
  }

  writeSession() {
    if (!this.dir) return;
    try { fs.writeFileSync(path.join(this.dir, 'session.json'), JSON.stringify(this.sessionInfo, null, 2)); } catch { /* ignore */ }
  }

  summary() {
    const count = (key) => this.index.reduce((m, f) => { const k = f[key] ?? '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
    return {
      flows: this.index.length,
      byRoute: count('route'),
      byHost: count('host'),
      byHandler: count('handled'),
      chats: this.index.filter((f) => f.route === 'chat').map(({ seq, t, model, format, handled, status, ms, file }) => ({ seq, t, model, format, handled, status, ms, file })),
    };
  }

  writeSummary() {
    if (!this.dir) return;
    try { fs.writeFileSync(path.join(this.dir, 'summary.json'), JSON.stringify(this.summary(), null, 2)); } catch { /* ignore */ }
  }

  /** Finish exchanges still in flight (the process is ending) and write the summary. Returns the session folder or null. */
  close() {
    for (const f of [...this.open]) f.finish({ aborted: true });
    if (!this.dir) return null;
    this.setSession({ endedAt: new Date().toISOString() });
    this.writeSession();
    this.writeSummary();
    return this.dir;
  }
}
