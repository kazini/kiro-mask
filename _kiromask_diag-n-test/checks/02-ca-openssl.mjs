// Certificate authority: leaf certs must verify under OpenSSL (an independent implementation),
// SANs must be right for DNS/IPv4/IPv6/long names, and real TLS handshakes must accept/reject correctly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createCheck, skip } from '../lib/check.mjs';
import { imp } from '../lib/paths.mjs';
import { tryRun } from '../lib/exec.mjs';

if (!tryRun('openssl', ['version'])) skip('openssl not installed');
const { CertAuthority } = await imp('tls/ca.mjs');
const t = createCheck('Local CA verified by OpenSSL and real TLS handshakes');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-ca-'));
const ca = new CertAuthority({ dir });
t.ok(ca.init().created, 'CA created on first init');
t.ok(!new CertAuthority({ dir }).init().created, 'CA reused on second init');

const caText = tryRun('openssl', ['x509', '-in', ca.certPath, '-noout', '-ext', 'basicConstraints,keyUsage']);
t.ok(/CA:TRUE/.test(caText) && /Certificate Sign/.test(caText), 'CA has CA:TRUE and keyCertSign');

const sanOf = (host) => { fs.writeFileSync(path.join(dir, 'l.pem'), ca.issue(host).cert); return tryRun('openssl', ['x509', '-in', path.join(dir, 'l.pem'), '-noout', '-ext', 'subjectAltName']).split('\n')[1].trim(); };
const cases = [
  ['q.us-east-1.amazonaws.com', 'DNS:q.us-east-1.amazonaws.com'],
  ['127.0.0.1', 'IP Address:127.0.0.1'],
  ['::1', 'IP Address:0:0:0:0:0:0:0:1'],
  ['2001:db8::7', 'IP Address:2001:DB8:0:0:0:0:0:7'],
  ['::ffff:1.2.3.4', 'IP Address:0:0:0:0:0:FFFF:102:304'],
];
for (const [h, san] of cases) t.eq(sanOf(h), san, `SAN for ${h}`);
const long = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example.com`;
t.eq(sanOf(long), `DNS:${long}`, 'SAN for a 194-character name (multi-byte DER length)');

for (const h of ['auth.desktop.kiro.dev', '127.0.0.1', long]) {
  fs.writeFileSync(path.join(dir, 'l.pem'), ca.issue(h).cert);
  const out = tryRun('openssl', ['verify', '-CAfile', ca.certPath, path.join(dir, 'l.pem')]);
  t.ok(/: OK/.test(out ?? ''), `openssl verify accepts leaf for ${h.slice(0, 30)}`);
  const ext = tryRun('openssl', ['x509', '-in', path.join(dir, 'l.pem'), '-noout', '-ext', 'basicConstraints,extendedKeyUsage']);
  t.ok(/CA:FALSE/.test(ext) && /TLS Web Server Authentication/.test(ext), `leaf for ${h.slice(0, 20)} is CA:FALSE + serverAuth`);
}

const server = tls.createServer({ SNICallback: (sn, cb) => cb(null, ca.contextFor(sn)) }, (s) => s.end('hi'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const connect = (opts) => new Promise((resolve) => { const c = tls.connect({ port: server.address().port, host: '127.0.0.1', ...opts }, () => { c.destroy(); resolve('ok'); }); c.on('error', (e) => resolve(e.code)); });
t.eq(await connect({ servername: 'q.us-east-1.amazonaws.com', ca: ca.caCertPem }), 'ok', 'handshake validates with only our CA trusted');
t.eq(await connect({ servername: 'a.example.com', ca: ca.caCertPem, checkServerIdentity: (h, c) => tls.checkServerIdentity('b.example.com', c) }), 'ERR_TLS_CERT_ALTNAME_INVALID', 'wrong hostname is rejected');
t.ok(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/.test(await connect({ servername: 'a.example.com' })), 'untrusted CA is rejected');
server.close();

const pin = tryRun('sh', ['-c', `openssl x509 -in "${ca.certPath}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`]);
t.eq(ca.spkiPin, pin, 'SPKI pin equals the independently computed OpenSSL value');
fs.rmSync(dir, { recursive: true, force: true });
t.finish();
