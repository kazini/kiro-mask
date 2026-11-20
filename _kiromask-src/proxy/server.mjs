// Forward proxy with selective TLS interception.
//   CONNECT host:443  →  if host matches an intercept glob: terminate TLS with a cert from our CA
//                        and serve the decrypted HTTP/1.1 requests ourselves;
//                        otherwise: a transparent TCP tunnel (never touched, never decrypted).
//   plain HTTP (absolute-URI) requests are forwarded untouched.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { splitHostPort } from '../util.mjs';

export function createProxy({ ca, shouldIntercept, handler, log = () => {} }) {
  const stats = { connects: 0, intercepted: 0, tunnelled: 0, requests: 0 };
  const sockets = new Set(); // CONNECT-upgraded sockets are no longer tracked by http.Server.closeAllConnections()

  // Server for decrypted traffic.
  const inner = http.createServer((req, res) => {
    stats.requests++;
    Promise.resolve(handler(req, res)).catch((e) => {
      log('error', `handler crashed: ${e.stack || e.message}`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'kiromask internal error' })); }
      else res.destroy();
    });
  });
  inner.requestTimeout = 0; // long-running streams
  inner.timeout = 0;
  inner.keepAliveTimeout = 65_000;
  inner.on('clientError', (err, sock) => { if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

  const fallback = tls.createSecureContext(ca.issue('kiromask.invalid'));
  const tlsServer = tls.createServer(
    {
      ALPNProtocols: ['http/1.1'], // keep Chromium/Node on HTTP/1.1 so we never need an HTTP/2 stack
      minVersion: 'TLSv1.2',
      SNICallback: (servername, cb) => {
        try { cb(null, servername ? ca.contextFor(servername) : fallback); } catch (e) { cb(e); }
      },
    },
    (socket) => inner.emit('connection', socket),
  );
  tlsServer.on('tlsClientError', (err) => log('debug', `TLS handshake failed: ${err.message}`));

  const proxy = http.createServer((req, res) => {
    // Plain-HTTP proxying (absolute-form request target).
    let target;
    try { target = new URL(req.url); } catch { /* not absolute */ }
    if (!target || target.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('kiromask proxy: point an HTTP(S) proxy setting at this port; it is not a web server.\n');
    }
    const up = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  proxy.requestTimeout = 0;

  proxy.on('connect', (req, clientSocket, head) => {
    stats.connects++;
    const { host, port } = splitHostPort(req.url);
    clientSocket.on('error', () => {});
    clientSocket.setNoDelay(true);
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));

    if (!net.isIP(host) && shouldIntercept(host)) {
      stats.intercepted++;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: kiromask\r\n\r\n');
      if (head?.length) clientSocket.unshift(head);
      tlsServer.emit('connection', clientSocket);
      return;
    }

    stats.tunnelled++;
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.setNoDelay(true);
    upstream.on('error', (e) => {
      log('debug', `tunnel ${host}:${port} failed: ${e.code || e.message}`);
      if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    });
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
  });

  return {
    server: proxy,
    stats,
    listen: (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(port, host, () => { proxy.off('error', reject); resolve(proxy.address()); });
    }),
    close: () => new Promise((resolve) => { proxy.close(() => resolve()); for (const s of sockets) s.destroy(); proxy.closeAllConnections?.(); inner.closeAllConnections?.(); }),
  };
}
