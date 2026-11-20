// Application core: owns state, config, and wires the proxy to the route handlers.
import fs from 'node:fs';
import path from 'node:path';
import { CertAuthority } from './tls/ca.mjs';
import { createProxy } from './proxy/server.mjs';
import { forward } from './proxy/upstream.mjs';
import { classify, HANDLERS } from './routes/index.mjs';
import { CaptureStore, redactHeaders } from './debug/capture.mjs';
import { UsageTracker } from './usage.mjs';
import { hostMatcher, readBody } from './util.mjs';
import { DEFAULT_PREAMBLE } from './translate/preamble.mjs';
import { resolveDataDir } from './paths.mjs';

/** Where Kiro Mask keeps its files by default: `data/` inside the kiromask folder (see paths.mjs). */
export const defaultDataDir = () => resolveDataDir().dir;

export class App {
  /**
   * @param {object} o
   * @param {import('./config/load.mjs').Config} o.config
   * @param {Function} o.log
   * @param {string} [o.dataDir]
   * @param {string} [o.version]  kiromask's version (recorded in capture sessions)
   * @param {{connectHost?: string, port?: number, insecure?: boolean}} [o.upstream]  override where pass-through goes (tests)
   */
  constructor({ config, log, dataDir = defaultDataDir(), version = null, upstream = {} }) {
    this.log = log;
    this.dataDir = dataDir;
    this.version = version;
    this.upstream = upstream;
    this.state = { customActive: false, lastModel: null, kiroVersion: null, chatFormat: null, adapt: new Map() };
    this.capture = new CaptureStore(path.join(dataDir, 'captures'), false, {
      log,
      session: { tool: 'kiromask', version, node: process.version, platform: `${process.platform}/${process.arch}` },
    });
    this.usage = new UsageTracker(dataDir);
    this.promptCache = { file: null, mtime: 0, text: null };
    this.setConfig(config);
  }

  get cfg() { return this.config; }

  setConfig(config) {
    this.config = config;
    this.isIntercepted = hostMatcher(config.get('proxy.intercept_hosts'));
    this.capture.enabled = !!config.get('debug.capture_traffic');
    this.capture.setSession({
      config: config.source,
      tlsMode: config.get('tls.mode'),
      providers: [...config.providers.values()].map((p) => ({ name: p.name, type: p.type, apiBase: p.apiBase, models: config.customModels.filter((m) => m.provider === p).map((m) => m.id) })), // never the keys
    });
    if (config.get('kiro_endpoint.start_blocking')) this.state.customActive = true;
  }

  /** Prompt customisation (override file is re-read when it changes). */
  async promptOptions() {
    const p = this.config.get('prompt', {});
    let override;
    if (p.system_override_file) {
      try {
        const st = fs.statSync(p.system_override_file);
        if (this.promptCache.file !== p.system_override_file || this.promptCache.mtime !== st.mtimeMs) {
          this.promptCache = { file: p.system_override_file, mtime: st.mtimeMs, text: fs.readFileSync(p.system_override_file, 'utf8') };
        }
        override = this.promptCache.text;
      } catch (e) { this.log('warn', `prompt.system_override_file: ${e.message}`); }
    }
    const preamble = p.preamble === 'default' || p.preamble === undefined ? DEFAULT_PREAMBLE : String(p.preamble || '');
    return { override, prepend: p.prepend, append: p.append, preamble, asSystem: p.as_system_message !== false };
  }

  /** Pass a request through to the real upstream (or the test override). */
  pass(ctx, opts = {}) {
    ctx.flow?.note({ handled: opts.transform ? 'passthrough (rewritten)' : opts.frameFilter || opts.sseFilter ? 'passthrough (filtered)' : 'passthrough' });
    // The body was buffered up front (handle()), so it is replayed rather than piped.
    return forward(ctx.req, ctx.res, { hostname: ctx.info.host, log: this.log, body: ctx.req.rawBody, ...this.upstream, ...opts });
  }

  /** Record what is written back to Kiro, whichever handler produces it (Kiro's servers, your provider, or us). */
  #tap(res, flow) {
    const { writeHead, write, end } = res;
    res.writeHead = function (status, ...rest) {
      const named = rest.find((x) => x && typeof x === 'object' && !Array.isArray(x)) ?? (Array.isArray(rest[0]) ? Object.fromEntries(rest[0].reduce((a, v, i, arr) => (i % 2 ? a : [...a, [v, arr[i + 1]]]), [])) : {});
      flow.setResponse(status, { ...this.getHeaders(), ...named });
      return writeHead.call(this, status, ...rest);
    };
    res.write = function (chunk, ...rest) { flow.write(typeof chunk === 'string' ? Buffer.from(chunk, typeof rest[0] === 'string' ? rest[0] : 'utf8') : chunk); return write.call(this, chunk, ...rest); };
    res.end = function (chunk, ...rest) { if (chunk) flow.write(typeof chunk === 'string' ? Buffer.from(chunk, typeof rest[0] === 'string' ? rest[0] : 'utf8') : chunk); return end.call(this, chunk, ...rest); };
    res.on('close', () => flow.finish({ aborted: !res.writableEnded }));
  }

  async handle(req, res) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    let pathname = req.url || '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* keep raw */ }
    const ua = req.headers['user-agent'] || '';
    const v = /Kiro(?:IDE)?[\/-](\d+(?:\.\d+)+)/.exec(ua);
    if (v && this.state.kiroVersion !== v[1]) { this.state.kiroVersion = v[1]; this.capture.setSession({ kiroVersion: v[1] }); }

    const target = String(req.headers['x-amz-target'] || '');
    const info = { host, pathname, method: req.method, target };
    const kind = classify(info);
    this.log('debug', `${req.method} ${host}${pathname}${target ? ` [${target}]` : ''} → ${kind}`);

    // Buffer the request body once, up front: handlers replay it, and the capture feature can record it.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try { req.rawBody = await readBody(req); } catch (e) {
        this.log('warn', `${req.method} ${host}${pathname}: ${e.message}`);
        res.writeHead(413, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: e.message }));
      }
    }
    const flow = this.capture.begin({ req, host, route: kind });
    if (flow) { flow.note({ handled: 'kiromask', target: target || undefined }); this.#tap(res, flow); }
    const ctx = { app: this, cfg: this.config, req, res, info, flow, log: this.log, redactedHeaders: () => redactHeaders(req.headers) };
    await HANDLERS[kind](ctx);
  }

  /** Create the CA and start listening. Returns { port, host, caCertPath, caPin }. */
  async start() {
    this.ca = new CertAuthority({ dir: path.join(this.dataDir, 'ca') });
    const { created } = this.ca.init();
    if (created) this.log('info', `generated a new local CA at ${this.ca.certPath}`);
    this.proxy = createProxy({
      ca: this.ca,
      shouldIntercept: (h) => this.isIntercepted(h),
      handler: (req, res) => this.handle(req, res),
      log: this.log,
    });
    const host = this.config.get('proxy.host');
    const addr = await this.proxy.listen(this.config.get('proxy.port'), host);
    return { port: addr.port, host, caCertPath: this.ca.certPath, caPin: this.ca.spkiPin };
  }

  async stop() {
    await this.proxy?.close();
    return this.capture.close(); // the folder the session was recorded to (null when capture was off)
  }
}
