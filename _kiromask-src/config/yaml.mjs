// A small, dependency-free YAML parser covering what configuration files use:
//   • block mappings and sequences (incl. "- key: value" and sequences at the key's indent)
//   • flow collections  [a, b]  {a: 1}  (may span lines)
//   • plain / 'single' / "double" quoted scalars, null/bool/number resolution (YAML 1.1 booleans)
//   • | and > block scalars with -/+ chomping, folded plain scalars, # comments
// Not supported (throws a clear error): anchors/aliases, tags, multi-document streams, complex keys.

export class YamlError extends Error {
  constructor(msg, line) {
    super(line ? `YAML error on line ${line}: ${msg}` : `YAML error: ${msg}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

const TRUE = /^(true|yes|on)$/i;
const FALSE = /^(false|no|off)$/i;

function unescapeDouble(s, line) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'e': return '\x1b';
      case 'f': return '\f';
      case 'v': return '\v';
      case ' ': return ' ';
      case '/': return '/';
      case '"': return '"';
      case '\\': return '\\';
      case 'x': case 'u': case 'U': return String.fromCodePoint(parseInt(e.slice(1), 16));
      default: throw new YamlError(`unknown escape \\${e}`, line);
    }
  });
}

function resolvePlain(s) {
  if (s === '' || s === '~' || /^null$/i.test(s)) return null;
  if (TRUE.test(s)) return true;
  if (FALSE.test(s)) return false;
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function scalar(text, line) {
  const s = text.trim();
  if (s[0] === '"') {
    if (s.length < 2 || s.at(-1) !== '"') throw new YamlError('unterminated double-quoted string', line);
    return unescapeDouble(s.slice(1, -1), line);
  }
  if (s[0] === "'") {
    if (s.length < 2 || s.at(-1) !== "'") throw new YamlError('unterminated single-quoted string', line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!]/.test(s)) throw new YamlError('anchors, aliases and tags are not supported', line);
  return resolvePlain(s);
}

/** Remove a trailing # comment, respecting quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else q = null;
      }
    } else if (c === '"' || c === "'") {
      // a quote only opens a string at the start of a token
      if (i === 0 || /[\s[{,:]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

/** Index of the ':' that ends a mapping key, or -1. */
function keyColon(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if ((c === '"' || c === "'") && i === 0) q = c;
    else if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ' || s[i + 1] === '\t')) return i;
  }
  return -1;
}

// ── flow collections ────────────────────────────────────────────────────────

function parseFlow(src, line) {
  let p = 0;
  const ws = () => { while (p < src.length && /\s/.test(src[p])) p++; };
  const value = (inMap) => {
    ws();
    const c = src[p];
    if (c === '[') return seqf();
    if (c === '{') return mapf();
    if (c === '"' || c === "'") {
      const start = p++;
      while (p < src.length && src[p] !== c) { if (c === '"' && src[p] === '\\') p++; else if (c === "'" && src[p] === "'" && src[p + 1] === "'") p++; p++; }
      p++;
      return scalar(src.slice(start, p), line);
    }
    const start = p;
    while (p < src.length) {
      const ch = src[p];
      if (ch === ',' || ch === ']' || ch === '}') break;
      if (inMap && ch === ':' && (src[p + 1] === ' ' || p + 1 === src.length)) break;
      p++;
    }
    return scalar(src.slice(start, p), line);
  };
  const seqf = () => {
    p++; const out = [];
    for (;;) {
      ws();
      if (src[p] === ']') { p++; return out; }
      out.push(value(false)); ws();
      if (src[p] === ',') p++;
      else if (src[p] !== ']') throw new YamlError("expected ',' or ']' in flow sequence", line);
    }
  };
  const mapf = () => {
    p++; const out = {};
    for (;;) {
      ws();
      if (src[p] === '}') { p++; return out; }
      const k = value(true); ws();
      let v = null;
      if (src[p] === ':') { p++; v = value(false); ws(); }
      out[String(k)] = v;
      if (src[p] === ',') p++;
      else if (src[p] !== '}') throw new YamlError("expected ',' or '}' in flow mapping", line);
    }
  };
  const result = value(false);
  ws();
  if (p < src.length) throw new YamlError('unexpected trailing characters after flow collection', line);
  return result;
}

const depthOf = (s) => {
  let d = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
};

// ── block structure ─────────────────────────────────────────────────────────

export function parseYaml(source) {
  const raw = String(source).replace(/^\uFEFF/, '').split(/\r?\n/);
  let i = 0;

  const peek = () => {
    while (i < raw.length) {
      if (/^\t/.test(raw[i]) && raw[i].trim() && !raw[i].trim().startsWith('#')) {
        throw new YamlError('tabs are not allowed for indentation', i + 1);
      }
      const t = stripComment(raw[i]).replace(/\s+$/, '');
      if (t.trim() === '' || /^---\s*$/.test(t.trim()) || /^\.\.\.\s*$/.test(t.trim())) { i++; continue; }
      const indent = t.length - t.trimStart().length;
      return { indent, text: t.trimStart(), line: i + 1 };
    }
    return null;
  };

  const isDash = (t) => t === '-' || t.startsWith('- ');

  function node(minIndent) {
    const ln = peek();
    if (!ln || ln.indent < minIndent) return null;
    if (isDash(ln.text)) return seqBlock(ln.indent);
    if (keyColon(ln.text) !== -1 && !/^[[{]/.test(ln.text)) return mapBlock(ln.indent);
    // a lone scalar / flow collection
    i++;
    return inlineValue(ln.text, ln.indent - 1, ln.line);
  }

  function seqBlock(indent) {
    const out = [];
    for (;;) {
      const ln = peek();
      if (!ln || ln.indent !== indent || !isDash(ln.text)) break;
      const rest = ln.text.slice(1).trimStart();
      if (rest === '') { i++; out.push(node(indent + 1)); continue; }
      // Re-indent the remainder so "- k: v" becomes a mapping at the right column.
      const newIndent = indent + (ln.text.length - rest.length);
      raw[i] = ' '.repeat(newIndent) + rest;
      out.push(node(indent + 1));
    }
    return out;
  }

  function mapBlock(indent) {
    const out = {};
    for (;;) {
      const ln = peek();
      if (!ln || ln.indent !== indent || isDash(ln.text)) break;
      const c = keyColon(ln.text);
      if (c === -1) throw new YamlError(`expected "key: value", got "${ln.text}"`, ln.line);
      const key = String(scalar(ln.text.slice(0, c), ln.line) ?? '');
      const rest = ln.text.slice(c + 1).trim();
      i++;
      if (rest === '') {
        const nx = peek();
        if (nx && nx.indent > indent) out[key] = node(nx.indent);
        else if (nx && nx.indent === indent && isDash(nx.text)) out[key] = seqBlock(indent);
        else out[key] = null;
      } else {
        out[key] = inlineValue(rest, indent, ln.line);
      }
    }
    return out;
  }

  /** Value that began on the same line as its key (or a bare scalar). */
  function inlineValue(text, parentIndent, line) {
    if (/^[|>][-+]?\d*$/.test(text)) return blockScalar(text, parentIndent);
    if (/^[[{]/.test(text)) {
      let acc = text;
      while (depthOf(acc) > 0 && i < raw.length) acc += ' ' + stripComment(raw[i++]).trim();
      if (depthOf(acc) !== 0) throw new YamlError('unterminated flow collection', line);
      return parseFlow(acc, line);
    }
    if (/^["']/.test(text)) {
      let acc = text;
      const q = text[0];
      const closed = (s) => { let k = 1; while (k < s.length) { if (q === '"' && s[k] === '\\') k += 2; else if (s[k] === q) { if (q === "'" && s[k + 1] === "'") k += 2; else return true; } else k++; } return false; };
      while (!closed(acc) && i < raw.length) acc += ' ' + raw[i++].trim();
      return scalar(acc.replace(/\s+#.*$/, (m) => (closed(acc.slice(0, acc.length - m.length)) ? '' : m)), line);
    }
    // Folded plain scalar: following, more-indented lines continue it.
    let acc = text;
    for (;;) {
      const nx = peek();
      if (!nx || nx.indent <= parentIndent) break;
      acc += ' ' + nx.text;
      i++;
    }
    return scalar(acc, line);
  }

  function blockScalar(header, parentIndent) {
    const folded = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const lines = [];
    let blockIndent = null;
    while (i < raw.length) {
      const l = raw[i];
      if (l.trim() === '') { lines.push(''); i++; continue; }
      const ind = l.length - l.trimStart().length;
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) break;
      lines.push(l.slice(blockIndent));
      i++;
    }
    let trailing = 0;
    while (lines.length && lines.at(-1) === '') { lines.pop(); trailing++; }
    let text = folded ? lines.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : lines.join('\n');
    if (chomp === 'strip') return text;
    if (chomp === 'keep') return text + '\n'.repeat(Math.max(1, trailing + 1));
    return lines.length ? text + '\n' : '';
  }

  const result = node(0);
  const rest = peek();
  if (rest) throw new YamlError(`unexpected content "${rest.text}"`, rest.line);
  return result ?? {};
}
