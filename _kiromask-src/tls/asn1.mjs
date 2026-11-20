// Just enough ASN.1 DER to build X.509 certificates. No dependencies.
import { Buffer } from 'node:buffer';

const lenBytes = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

export const tlv = (tag, content) => {
  const c = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), lenBytes(c.length), c]);
};

export const seq = (...parts) => tlv(0x30, parts);
export const set = (...parts) => tlv(0x31, parts);
export const nul = () => Buffer.from([0x05, 0x00]);
export const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const octet = (buf) => tlv(0x04, buf);
export const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
export const ia5 = (s) => tlv(0x16, Buffer.from(s, 'ascii'));

/** Unsigned big-endian INTEGER from a Buffer or a non-negative number. */
export const int = (v) => {
  let b;
  if (typeof v === 'number') {
    const hex = v.toString(16);
    b = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  } else {
    b = Buffer.from(v);
  }
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};

export const oid = (dotted) => {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
};

/** BIT STRING from whole bytes; `unused` = number of unused trailing bits. */
export const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));

const pad = (n) => String(n).padStart(2, '0');
/** UTCTime for years < 2050, GeneralizedTime afterwards (RFC 5280 §4.1.2.5). */
export const time = (d) => {
  const y = d.getUTCFullYear();
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + rest)) : tlv(0x18, Buffer.from(String(y) + rest));
};

/** [n] EXPLICIT wrapper (constructed, context-specific). */
export const explicit = (n, content) => tlv(0xa0 | n, content);
/** [n] IMPLICIT primitive (context-specific). */
export const implicit = (n, content) => tlv(0x80 | n, content);

// ── Reading (only what we need to extract the key bits from an SPKI) ───────

export function readTlv(buf, offset = 0) {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i];
    hdr = 2 + n;
  }
  return { tag, start: offset + hdr, end: offset + hdr + len, next: offset + hdr + len };
}

/** Extract the subjectPublicKey BIT STRING contents from a DER SPKI. */
export function spkiKeyBits(spkiDer) {
  const outer = readTlv(spkiDer, 0); // SEQUENCE
  const alg = readTlv(spkiDer, outer.start); // AlgorithmIdentifier
  const bits = readTlv(spkiDer, alg.next); // BIT STRING
  return spkiDer.subarray(bits.start + 1, bits.end); // skip the "unused bits" byte
}
