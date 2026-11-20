// Forward an intercepted request to the real upstream server (pass-through),
// optionally buffering+transforming the response or filtering event-stream frames.

import https from 'node:https';
import zlib from 'node:zlib';

const HOP = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'upgrade', 'transfer-encoding']);

const stripHop = (headers) => {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
  return out;
};

function decode(buf, encoding) {
  switch ((encoding || '').toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(buf);
    case 'br': return zlib.brotliDecompressSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    default: return buf;
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} o
 * @param {string} o.hostname
 * @param {number} [o.port]
 * @param {Buffer} [o.body]      already-read request body (else req is piped)
 * @param {(buf: Buffer, upstream: import('http').IncomingMessage) => Buffer|Promise<Buffer>} [o.transform]
 *        buffer + rewrite a 200 response body (non-200 responses are piped untouched)
 * @param {(chunk: Buffer) => Buffer} [o.frameFilter]  streaming filter for AWS event-stream responses
 * @param {(chunk: Buffer) => Buffer} [o.sseFilter]    streaming filter for text/event-stream (SSE) responses
 * @param {string} [o.connectHost]  connect here instead of resolving `hostname` (SNI/Host stay as-is)
 * @param {number} [o.timeoutMs]  fail if the upstream is silent this long
 * @param {(status: number) => boolean|void} [o.onStatus]  return true to discard this upstream response and handle it yourself
 * @param {(err: Error) => boolean|void} [o.onError]  return true to take over error handling (nothing sent yet)
 * @param {(chunk: Buffer) => void} [o.tap]  observe the raw upstream response bytes (capture)
 * @param {boolean} [o.insecure]  skip upstream certificate validation
 */
export function forward(req, res, { hostname, connectHost, port = 443, body, transform, frameFilter, sseFilter, tap, insecure = false, timeoutMs, onError, onStatus, log = () => {} }) {
  return new Promise((resolve) => {
    const headers = stripHop(req.headers);
    headers.host = req.headers.host || hostname;
    if (transform || sseFilter || frameFilter) headers['accept-encoding'] = 'identity'; // filters need to read the bytes
    if (body) { headers['content-length'] = String(body.length); }

    const fail = (err) => {
      if (!res.headersSent && onError?.(err) === true) return resolve();
      log('error', `upstream ${hostname}${req.url?.slice(0, 60)}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `kiromask: upstream error: ${err.message}`, __type: 'BadGateway' }));
      } else res.destroy();
      resolve();
    };

    const up = https.request(
      { host: connectHost || hostname, port, method: req.method, path: req.url, headers, servername: hostname, rejectUnauthorized: !insecure },
      (ur) => {
        const rh = stripHop(ur.headers);
        if (onStatus?.(ur.statusCode) === true) { ur.resume(); return resolve(); }
        const done = () => resolve();
        if (transform && ur.statusCode === 200) {
          const parts = [];
          ur.on('data', (c) => parts.push(c));
          ur.on('error', fail);
          ur.on('end', async () => {
            try {
              const raw = decode(Buffer.concat(parts), ur.headers['content-encoding']);
              const out = await transform(raw, ur);
              delete rh['content-encoding'];
              rh['content-length'] = String(out.length);
              res.writeHead(ur.statusCode, rh);
              res.end(out);
            } catch (e) {
              log('error', `response transform failed (${e.message}); sending original`);
              res.writeHead(ur.statusCode, rh);
              res.end(Buffer.concat(parts));
            }
            done();
          });
          return;
        }
        const ct = String(ur.headers['content-type'] || '');
        const filter = frameFilter && /eventstream/i.test(ct) ? frameFilter : sseFilter && /text\/event-stream/i.test(ct) ? sseFilter : null;
        if (filter) delete rh['content-length'];
        res.writeHead(ur.statusCode, ur.statusMessage, rh);
        if (tap) ur.on('data', tap);
        if (filter) {
          ur.on('data', (c) => { const o = filter(c); if (o.length) res.write(o); });
          ur.on('end', () => { res.end(); done(); });
        } else {
          ur.pipe(res);
          ur.on('end', done);
        }
        ur.on('error', fail);
      },
    );
    up.on('error', fail);
    if (timeoutMs) up.setTimeout(timeoutMs, () => up.destroy(new Error(`timed out after ${timeoutMs / 1000}s`)));
    res.on('close', () => { if (!res.writableEnded) up.destroy(); resolve(); });
    if (body) up.end(body);
    else req.pipe(up);
  });
}
