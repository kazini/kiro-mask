// Server-Sent Events parser over any async iterable of bytes (fetch bodies, Node streams).
// Tolerates: CRLF, ':' comment/heartbeat lines, multi-line data, and bare JSON lines
// (some local proxies emit '{...}' without the 'data:' prefix).

export async function* sseEvents(source) {
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let event = null;
  let data = [];

  const dispatch = () => {
    if (!data.length) { event = null; return null; }
    const out = { event, data: data.join('\n') };
    event = null; data = [];
    return out;
  };
  const line = (l) => {
    if (l === '') return dispatch();
    if (l[0] === ':') return null;
    const c = l.indexOf(':');
    const field = c === -1 ? l : l.slice(0, c);
    let value = c === -1 ? '' : l.slice(c + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (l[0] === '{' && !data.length) return { event: null, data: l }; // bare JSON line
    return null;
  };

  for await (const chunk of source) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (l.endsWith('\r')) l = l.slice(0, -1);
      const ev = line(l);
      if (ev) yield ev;
    }
  }
  buf += dec.decode();
  if (buf) { const ev = line(buf.replace(/\r$/, '')); if (ev) yield ev; }
  const last = dispatch();
  if (last) yield last;
}
