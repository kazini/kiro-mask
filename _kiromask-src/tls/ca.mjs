// A tiny local certificate authority. Generates a persistent root CA once, then
// mints short-lived leaf certificates per hostname on demand (for TLS interception).
//
// ECDSA P-256 throughout: key generation is instant and every modern TLS stack
// (BoringSSL/Chromium, OpenSSL/Node) accepts it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { Buffer } from 'node:buffer';
import { seq, set, int, oid, utf8, bool, octet, bitString, time, explicit, implicit, spkiKeyBits } from './asn1.mjs';

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  ski: '2.5.29.14',
  keyUsage: '2.5.29.15',
  san: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  aki: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const DAY = 86_400_000;
const sha1 = (b) => crypto.createHash('sha1').update(b).digest();

const name = (cn, org) =>
  seq(
    ...(org ? [set(seq(oid(OID.organization), utf8(org)))] : []),
    set(seq(oid(OID.commonName), utf8(cn))),
  );

const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));

function ipv6ToBytes(addr) {
  // Expand "::" and an optional trailing dotted IPv4 into 16 bytes.
  let [head, tail] = addr.split('::');
  const toGroups = (part) => (part ? part.split(':') : []);
  let h = toGroups(head);
  let t = tail === undefined ? [] : toGroups(tail);
  const last = (tail === undefined ? h : t).at(-1);
  if (last && last.includes('.')) {
    const v4 = last.split('.').map(Number);
    const repl = [((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16)];
    if (tail === undefined) h = [...h.slice(0, -1), ...repl]; else t = [...t.slice(0, -1), ...repl];
  }
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  const groups = [...h, ...fill, ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

function sanEntry(host) {
  if (net.isIPv4(host)) return implicit(7, Buffer.from(host.split('.').map(Number)));
  if (net.isIPv6(host)) return implicit(7, ipv6ToBytes(host));
  return implicit(2, Buffer.from(host, 'ascii')); // dNSName
}

function serialNumber() {
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f; // keep it positive
  return b;
}

function buildCert({ subject, issuer, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const sigAlg = seq(oid(OID.ecdsaSha256)); // ECDSA: parameters MUST be absent
  const tbs = seq(
    explicit(0, int(2)), // v3
    int(serialNumber()),
    sigAlg,
    issuer,
    seq(time(notBefore), time(notAfter)),
    subject,
    spki,
    explicit(3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, { key: signingKey, dsaEncoding: 'der' });
  const der = seq(tbs, sigAlg, bitString(signature));
  return { der, spki };
}

const pem = (der, label) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

export class CertAuthority {
  /** @param {{dir: string, log?: Function}} opts */
  constructor({ dir, commonName = 'Kiro Mask Local CA' }) {
    this.dir = dir;
    this.commonName = commonName;
    this.keyPath = path.join(dir, 'ca.key.pem');
    this.certPath = path.join(dir, 'ca.cert.pem');
    this.contexts = new Map();
    this.leafKey = null;
  }

  /** Load the CA from disk, creating (or renewing when near expiry) as needed. */
  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    let created = false;
    if (fs.existsSync(this.keyPath) && fs.existsSync(this.certPath)) {
      try {
        this.caKey = crypto.createPrivateKey(fs.readFileSync(this.keyPath));
        this.caCertPem = fs.readFileSync(this.certPath, 'utf8');
        const x = new crypto.X509Certificate(this.caCertPem);
        if (new Date(x.validTo).getTime() - Date.now() < 30 * DAY) throw new Error('CA expiring');
      } catch {
        this.caKey = null;
      }
    }
    if (!this.caKey) {
      this.#createRoot();
      created = true;
    }
    this.caX509 = new crypto.X509Certificate(this.caCertPem);
    this.caDer = this.caX509.raw;
    this.caSpki = this.caX509.publicKey.export({ type: 'spki', format: 'der' });
    this.caKeyId = sha1(spkiKeyBits(this.caSpki));
    // One shared ECDSA key for every leaf — signing a cert then costs ~1 ms.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.leafKey = privateKey;
    this.leafPub = publicKey;
    this.leafKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    return { created, certPath: this.certPath };
  }

  #createRoot() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const subject = name(this.commonName, 'Kiro Mask');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const keyId = sha1(spkiKeyBits(spki));
    const now = Date.now();
    const { der } = buildCert({
      subject,
      issuer: subject,
      publicKey,
      signingKey: privateKey,
      notBefore: new Date(now - DAY),
      notAfter: new Date(now + 3650 * DAY),
      extensions: [
        ext(OID.basicConstraints, true, seq(bool(true), int(0))), // CA, no sub-CAs
        ext(OID.keyUsage, true, bitString(Buffer.from([0x06]), 1)), // keyCertSign | cRLSign
        ext(OID.ski, false, octet(keyId)),
      ],
    });
    this.caKey = privateKey;
    this.caCertPem = pem(der, 'CERTIFICATE');
    fs.writeFileSync(this.keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(this.certPath, this.caCertPem);
  }

  /** Issue a leaf certificate for `host`. Returns PEM chain + shared key. */
  issue(host) {
    const now = Date.now();
    const { der } = buildCert({
      subject: name(host),
      issuer: name(this.commonName, 'Kiro Mask'),
      publicKey: this.leafPub,
      signingKey: this.caKey,
      notBefore: new Date(now - DAY),
      notAfter: new Date(now + 365 * DAY),
      extensions: [
        ext(OID.basicConstraints, true, seq()),
        ext(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
        ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
        ext(OID.san, false, seq(sanEntry(host))),
        ext(OID.ski, false, octet(sha1(spkiKeyBits(this.leafPub.export({ type: 'spki', format: 'der' }))))),
        ext(OID.aki, false, seq(implicit(0, this.caKeyId))),
      ],
    });
    return { cert: pem(der, 'CERTIFICATE') + this.caCertPem, key: this.leafKeyPem };
  }

  /** Cached TLS secure context for a hostname (what an SNI callback needs). */
  contextFor(host) {
    const key = host.toLowerCase();
    let ctx = this.contexts.get(key);
    if (!ctx) {
      if (this.contexts.size >= 512) this.contexts.clear(); // bound memory; certs are cheap to re-issue
      ctx = tls.createSecureContext(this.issue(key));
      this.contexts.set(key, ctx);
    }
    return ctx;
  }

  /** base64(SHA-256(SPKI)) of the root — for Chromium's --ignore-certificate-errors-spki-list. */
  get spkiPin() {
    return crypto.createHash('sha256').update(this.caSpki).digest('base64');
  }
}
