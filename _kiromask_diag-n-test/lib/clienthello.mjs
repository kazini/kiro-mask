// Parse a TLS ClientHello from the first bytes a client sends. Used to learn WHAT a client offers
// (SNI, ALPN, TLS versions, ciphers, extensions) — decisive when a handshake fails or a host is missed.
import crypto from 'node:crypto';

const isGrease = (v) => (v & 0x0f0f) === 0x0a0a;
const hex4 = (v) => v.toString(16).padStart(4, '0');
const CIPHERS = { 0x1301: 'TLS_AES_128_GCM_SHA256', 0x1302: 'TLS_AES_256_GCM_SHA384', 0x1303: 'TLS_CHACHA20_POLY1305_SHA256', 0xc02b: 'ECDHE_ECDSA_AES128_GCM', 0xc02f: 'ECDHE_RSA_AES128_GCM', 0xc02c: 'ECDHE_ECDSA_AES256_GCM', 0xc030: 'ECDHE_RSA_AES256_GCM', 0xcca8: 'ECDHE_RSA_CHACHA20', 0xcca9: 'ECDHE_ECDSA_CHACHA20' };
const VERSIONS = { 0x0300: 'SSL3', 0x0301: 'TLS1.0', 0x0302: 'TLS1.1', 0x0303: 'TLS1.2', 0x0304: 'TLS1.3' };
const EXT_NAMES = { 0: 'server_name', 5: 'status_request', 10: 'supported_groups', 11: 'ec_point_formats', 13: 'signature_algorithms', 16: 'alpn', 18: 'sct', 21: 'padding', 23: 'extended_master_secret', 27: 'compress_certificate', 35: 'session_ticket', 43: 'supported_versions', 45: 'psk_key_exchange_modes', 51: 'key_share', 65281: 'renegotiation_info', 17513: 'alps', 65037: 'ech' };

/** @returns {object} { ok: true, sni, alpn[], versions[], ... } or { ok: false, reason, preview } */
export function parseClientHello(buf) {
  if (!buf || buf.length < 5) return { ok: false, reason: 'short' };
  if (buf[0] !== 0x16) return { ok: false, reason: 'not-tls', preview: buf.subarray(0, 48).toString('latin1').replace(/[^\x20-\x7e]/g, '.') };
  try {
    let p = 5;
    if (buf[p] !== 1) return { ok: false, reason: 'not-clienthello' };
    p += 4; // handshake type + 3-byte length
    const legacyVersion = buf.readUInt16BE(p); p += 2 + 32;
    p += 1 + buf[p]; // session id
    const csLen = buf.readUInt16BE(p); p += 2;
    const ciphers = [];
    for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(p + i));
    p += csLen;
    p += 1 + buf[p]; // compression
    const out = { ok: true, legacyVersion: VERSIONS[legacyVersion] || hex4(legacyVersion), sni: null, alpn: [], versions: [], sigAlgs: [], groups: [], pointFormats: [], extensions: [], truncated: false };
    if (p + 2 > buf.length) { out.truncated = true; return finish(out, ciphers); }
    const extEnd = Math.min(p + 2 + buf.readUInt16BE(p), buf.length);
    if (p + 2 + buf.readUInt16BE(p) > buf.length) out.truncated = true;
    p += 2;
    const extIds = [];
    while (p + 4 <= extEnd) {
      const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2);
      const d = buf.subarray(p + 4, Math.min(p + 4 + len, extEnd));
      extIds.push(type);
      if (type === 0 && d.length >= 5) out.sni = d.toString('ascii', 5, 5 + d.readUInt16BE(3));
      else if (type === 16 && d.length >= 2) { for (let i = 2; i < d.length;) { const l = d[i]; out.alpn.push(d.toString('ascii', i + 1, i + 1 + l)); i += 1 + l; } }
      else if (type === 43 && d.length >= 1) { for (let i = 1; i + 1 < d.length; i += 2) out.versions.push(d.readUInt16BE(i)); }
      else if (type === 13 && d.length >= 2) { for (let i = 2; i + 1 < d.length; i += 2) out.sigAlgs.push(d.readUInt16BE(i)); }
      else if (type === 10 && d.length >= 2) { for (let i = 2; i + 1 < d.length; i += 2) out.groups.push(d.readUInt16BE(i)); }
      else if (type === 11 && d.length >= 1) { for (let i = 1; i < d.length; i++) out.pointFormats.push(d[i]); }
      p += 4 + len;
    }
    out.extensions = extIds;
    return finish(out, ciphers, legacyVersion);
  } catch (e) {
    return { ok: false, reason: `parse-error: ${e.message}` };
  }
}

function finish(out, ciphers, legacyVersion = 0x0303) {
  const real = (a) => a.filter((v) => !isGrease(v));
  out.cipherCount = ciphers.length;
  out.ciphers = real(ciphers).slice(0, 8).map((c) => CIPHERS[c] || hex4(c));
  out.versions = out.versions.filter((v) => !isGrease(v)).map((v) => VERSIONS[v] || hex4(v));
  out.extensionNames = real(out.extensions).map((e) => EXT_NAMES[e] || String(e));
  out.sigAlgs = real(out.sigAlgs).map(hex4);
  out.groups = real(out.groups).map(hex4);
  // JA3: stable client fingerprint (Chromium vs Node vs Rust/Go clients differ)
  const ja3 = [legacyVersion, real(ciphers).join('-'), real(out.extensions).join('-'), out.groups.map((g) => parseInt(g, 16)).join('-'), out.pointFormats.join('-')].join(',');
  out.ja3 = crypto.createHash('md5').update(ja3).digest('hex');
  delete out.pointFormats;
  delete out.extensions;
  return out;
}
