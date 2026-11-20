import { randomUUID } from 'node:crypto';

export const uuid = randomUUID;

/** Compile a host glob ("*.example.com", "example.com") into a RegExp. */
export function globToRegExp(glob) {
  const esc = glob.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

export function hostMatcher(globs) {
  const res = (globs || []).map(globToRegExp);
  return (host) => { const h = String(host || '').toLowerCase(); return res.some((r) => r.test(h)); };
}

/** "host:port" / "[::1]:443" / "host" → { host, port } */
export function splitHostPort(s, defaultPort = 443) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (m) return { host: m[1], port: Number(m[2]) || defaultPort };
  const i = s.lastIndexOf(':');
  if (i > -1 && /^\d+$/.test(s.slice(i + 1)) && s.indexOf(':') === i) return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
  return { host: s, port: defaultPort };
}

export async function readBody(req, limit = 64 * 1024 * 1024) {
  if (req.rawBody) return req.rawBody; // already buffered by App.handle() (so it can be recorded and replayed)
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
