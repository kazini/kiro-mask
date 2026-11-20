// Credential redaction for everything written to disk by the capture feature. Structure and key names are kept;
// secret values become "[redacted len=N]" so request/response SHAPES can be analysed without exposing tokens.
// (Same rules as _kiromask_diag-n-test/lib/redact.mjs: the product stays self-contained, the diagnostic tools stay standalone.)

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-amz-security-token|x-amz-sso_bearer_token|x-amzn-.*(token|auth).*|x-auth.*|x-csrf.*|.*-token|.*-secret|.*api-?key.*)$/i;
const SECRET_KEY = /(token(?!s|limit)|secret|passw|authorization|api[_-]?key|credential|assertion|refresh|cookie|signature|verifier|session[_-]?id|bearer)/i;
const SECRET_QUERY = /^(.*token.*|.*secret.*|.*signature.*|x-amz-(credential|signature|security-token)|code|state|key|sig|password|api[_-]?key|session.*)$/i;
const mark = (v) => `[redacted len=${String(v).length}]`;

export function redactHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!SECRET_HEADER.test(k)) { out[k] = v; continue; }
    const one = (x) => (/^authorization$|^proxy-authorization$/i.test(k) && /^\w+\s/.test(String(x)) ? `${String(x).split(/\s/)[0]} ${mark(String(x).replace(/^\w+\s/, ''))}` : mark(x));
    out[k] = Array.isArray(v) ? v.map(one) : one(v);
  }
  return out;
}

export function redactUrl(u) {
  try {
    const url = new URL(u, 'http://placeholder.invalid');
    for (const [k, v] of [...url.searchParams]) if (SECRET_QUERY.test(k)) url.searchParams.set(k, mark(v));
    const rel = url.pathname + url.search;
    return /^https?:\/\//i.test(u) ? `${url.origin}${rel}` : rel;
  } catch { return u; }
}

const TEXT_PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, (m, a) => `${a}[redacted]`],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => '[redacted-jwt]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => '[redacted-aws-key]'],
  [/\b(sk-|nvapi-|AIza)[A-Za-z0-9_-]{16,}/g, () => '[redacted-key]'],
];

export function redactText(s) {
  let out = String(s);
  for (const [re, fn] of TEXT_PATTERNS) out = out.replace(re, fn);
  return out;
}

const walk = (o) => {
  if (Array.isArray(o)) return o.map(walk);
  if (o && typeof o === 'object') {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => (typeof v === 'string' && SECRET_KEY.test(k) ? [k, mark(v)] : [k, walk(v)])));
  }
  return typeof o === 'string' && o.length > 12 ? redactText(o) : o; // tokens pasted into ordinary strings
};

/** Redact a body buffer given its content-type. Returns a Buffer. */
export function redactBody(buf, contentType = '') {
  const ct = String(contentType).toLowerCase();
  if (!buf?.length) return buf;
  const asText = buf.toString('utf8');
  if (/json|javascript/.test(ct) || /^\s*[[{]/.test(asText)) {
    try { return Buffer.from(JSON.stringify(walk(JSON.parse(asText)), null, 1)); } catch { /* fall through */ }
  }
  if (/x-www-form-urlencoded/.test(ct)) {
    return Buffer.from(asText.split('&').map((kv) => { const [k, ...r] = kv.split('='); return SECRET_KEY.test(decodeURIComponent(k)) ? `${k}=${mark(r.join('='))}` : kv; }).join('&'));
  }
  if (/text|xml|html|event-stream/.test(ct)) return Buffer.from(redactText(asText));
  return buf; // binary: nothing textual to scrub
}
