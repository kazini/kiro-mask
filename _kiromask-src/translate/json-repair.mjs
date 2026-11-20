// Parse tool-call arguments produced by (sometimes sloppy) models.
// Returns { ok, value, repaired } — never throws.

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Close an unterminated JSON document: open string, dangling key/comma, unclosed brackets. */
function closeTruncated(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (esc) out = out.slice(0, -1);
  if (inStr) out += '"';
  out = out.replace(/[\s,]+$/, '');
  if (/:\s*$/.test(out)) out += 'null';
  return out + stack.reverse().join('');
}

export function parseToolArgs(input) {
  if (input && typeof input === 'object') return isPlainObject(input) ? { ok: true, value: input, repaired: false } : { ok: false };
  let s = String(input ?? '').trim();
  if (s === '') return { ok: true, value: {}, repaired: false };

  const attempt = (text) => {
    try {
      let v = JSON.parse(text);
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep string */ } } // double-encoded
      return isPlainObject(v) ? v : undefined;
    } catch { return undefined; }
  };

  let v = attempt(s);
  if (v) return { ok: true, value: v, repaired: false };

  // strip markdown fences and surrounding prose
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const first = s.indexOf('{');
  if (first > 0) s = s.slice(first);
  v = attempt(s);
  if (v) return { ok: true, value: v, repaired: true };

  const last = s.lastIndexOf('}');
  if (last !== -1) {
    v = attempt(s.slice(0, last + 1));
    if (v) return { ok: true, value: v, repaired: true };
  }
  v = attempt(closeTruncated(s)) ?? attempt(closeTruncated(s).replace(/,\s*([}\]])/g, '$1'));
  if (v) return { ok: true, value: v, repaired: true };
  return { ok: false };
}
