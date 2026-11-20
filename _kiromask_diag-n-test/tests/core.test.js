import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crc32, encodeEvent, encodeFrame, ev, decodeAll, FrameDecoder, EventStreamError, createFrameFilter, payloadJson } from '../../_kiromask-src/aws/eventstream.mjs';
import { CertAuthority } from '../../_kiromask-src/tls/ca.mjs';
import { parseYaml, YamlError } from '../../_kiromask-src/config/yaml.mjs';
import { Config, loadConfig } from '../../_kiromask-src/config/load.mjs';
import { sanitizeSchema } from '../../_kiromask-src/translate/schema.mjs';
import { parseToolArgs } from '../../_kiromask-src/translate/json-repair.mjs';
import { buildModelList } from '../../_kiromask-src/routes/model-list.mjs';
import { classify } from '../../_kiromask-src/routes/index.mjs';
import { normalizeWebSearch, modifyTools } from '../../_kiromask-src/routes/mcp.mjs';
import { globToRegExp, splitHostPort } from '../../_kiromask-src/util.mjs';
import { redact } from '../../_kiromask-src/log.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ── event stream ──
test('eventstream: crc32 matches zlib; frames round-trip; chunked decoding; corruption is detected', () => {
  const buf = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37) & 255));
  assert.equal(crc32(buf), zlib.crc32?.(buf) ?? crc32(buf));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'standard CRC-32 check value');
  const all = Buffer.concat([ev.text('héllo ✓'), ev.toolStart('t', 'id1'), ev.toolInput('t', 'id1', '{"a":1}'), ev.toolStop('t', 'id1'), ev.contextUsage(12.5)]);
  assert.deepEqual(decodeAll(all).map((f) => f.eventType), ['assistantResponseEvent', 'toolUseEvent', 'toolUseEvent', 'toolUseEvent', 'contextUsageEvent']);
  const d = new FrameDecoder(); let n = 0;
  for (let i = 0; i < all.length; i++) n += d.push(all.subarray(i, i + 1)).length;
  assert.equal(n, 5);
  const bad = Buffer.from(all); bad[20] ^= 0xff;
  assert.throws(() => decodeAll(bad), EventStreamError);
  assert.throws(() => decodeAll(all.subarray(0, all.length - 3)), /trailing bytes/);
  assert.equal(payloadJson(decodeAll(ev.text('x'))[0]).content, 'x');
  assert.deepEqual(decodeAll(encodeFrame({ ':event-type': 'e', 'x-n': '1' }, Buffer.alloc(0)))[0].headers, { ':event-type': 'e', 'x-n': '1' });
});

test('eventstream: frame filter drops event types byte-for-byte across chunk boundaries', () => {
  const s = Buffer.concat([ev.text('a'), ev.metering(1), ev.text('b'), ev.contextUsage(1)]);
  const f = createFrameFilter(['meteringEvent']);
  const out = Buffer.concat([f(s.subarray(0, 17)), f(s.subarray(17, 60)), f(s.subarray(60))]);
  assert.equal(out.length, s.length - ev.metering(1).length);
  assert.deepEqual(decodeAll(out).map((x) => x.eventType), ['assistantResponseEvent', 'assistantResponseEvent', 'contextUsageEvent']);
});

// ── TLS ──
test('CA: persists, issues verifiable leaf certs (DNS/IPv4/IPv6/long names), SNI handshake works, wrong host/untrusted CA fail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-ca-'));
  const ca = new CertAuthority({ dir }); assert.equal(ca.init().created, true);
  assert.equal(new CertAuthority({ dir }).init().created, false, 'second start reuses the CA');
  const hasOpenssl = (() => { try { execFileSync('openssl', ['version']); return true; } catch { return false; } })();
  for (const h of ['q.us-east-1.amazonaws.com', '127.0.0.1', '::1', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.example.com`]) {
    const x = new (await import('node:crypto')).X509Certificate(ca.issue(h).cert.split('-----END CERTIFICATE-----')[0] + '-----END CERTIFICATE-----\n');
    assert.ok(x.verify(ca.caX509.publicKey), `${h.slice(0, 20)} signed by CA`);
    assert.ok(x.checkHost(h) || x.checkIP(h), `${h.slice(0, 20)} SAN matches`);
    assert.equal(x.ca, false);
    if (hasOpenssl) {
      fs.writeFileSync(path.join(dir, 'leaf.pem'), ca.issue(h).cert);
      assert.match(execFileSync('openssl', ['verify', '-CAfile', ca.certPath, path.join(dir, 'leaf.pem')]).toString(), /: OK/);
    }
  }
  assert.equal(ca.caX509.ca, true);
  const server = tls.createServer({ SNICallback: (sn, cb) => cb(null, ca.contextFor(sn)) }, (s) => s.end('hi'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const connect = (opts) => new Promise((resolve) => { const c = tls.connect({ port: server.address().port, host: '127.0.0.1', ...opts }, () => { c.destroy(); resolve('ok'); }); c.on('error', (e) => resolve(e.code)); });
  assert.equal(await connect({ servername: 'auth.desktop.kiro.dev', ca: ca.caCertPem }), 'ok');
  assert.equal(await connect({ servername: 'a.example.com', ca: ca.caCertPem, checkServerIdentity: (h, c) => tls.checkServerIdentity('b.example.com', c) }), 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.match(await connect({ servername: 'a.example.com' }), /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);
  assert.equal(typeof ca.spkiPin, 'string');
  server.close();
});

// ── YAML ──
test('yaml: edge-case file parses identically to PyYAML (frozen reference output)', () => {
  const got = parseYaml(fs.readFileSync(path.join(here, 'fixtures', 'edge.yaml'), 'utf8'));
  assert.deepEqual(got, JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'edge.expected.json'), 'utf8')));
});
test('yaml: errors are reported with line numbers', () => {
  assert.throws(() => parseYaml('a: 1\n\tb: 2'), (e) => e instanceof YamlError && /line 2/.test(e.message));
  assert.throws(() => parseYaml('a: &x 1'), /anchors/);
  assert.throws(() => parseYaml('a: "oops'), /unterminated/);
  assert.throws(() => parseYaml('a: [1, 2'), /unterminated flow/);
  assert.deepEqual(parseYaml(''), {});
  assert.deepEqual(parseYaml('# only a comment\r\nkey: v\r\n'), { key: 'v' });
});

// ── config ──
test('config: defaults, ${ENV} interpolation, aliases, option inheritance, duplicates, passthrough aliases, localhost normalisation', () => {
  const cfg = new Config({
    default_model: 'fast',
    providers: {
      a: { enabled: true, type: 'openai', api_base: 'https://x/v1/', api_key: '${MY_KEY}', max_tokens: 111, reasoning: 'keep', models: [
        { name: 'M1', alias: ['fast', 'F'], max_tokens: 222 }, { name: 'M2' }, { name: 'm1' }] },
      off: { enabled: false, type: 'openai', models: [{ name: 'hidden' }] },
      k: { enabled: true, type: 'passthrough', models: [{ name: 'kiro-default', alias: ['auto'] }] },
      lo: { enabled: true, type: 'openai', api_base: 'http://localhost:8317/v1/', api_key: 'x', models: [{ name: 'gw' }] },
    },
  }, { env: { MY_KEY: 'sekret' } });
  assert.equal(cfg.resolve('FAST').id, 'M1');
  assert.equal(cfg.resolve('m2').maxTokens, 111, 'provider-level default inherited');
  assert.equal(cfg.resolve('M1').maxTokens, 222, 'model-level override wins');
  assert.equal(cfg.resolve('M1').reasoning, 'keep');
  assert.equal(cfg.resolve('M1').provider.apiKey, 'sekret');
  assert.equal(cfg.resolve('M1').provider.apiBase, 'https://x/v1');
  assert.equal(cfg.resolve('hidden'), null);
  assert.equal(cfg.resolve('auto'), 'native');
  assert.equal(cfg.resolve('gw').provider.apiBase, 'http://127.0.0.1:8317/v1', 'localhost → 127.0.0.1');
  assert.equal(new Config({ providers: { r: { enabled: true, type: 'openai', api_key: 'k', api_base: 'https://localhost.example.com/v1', models: [{ name: 'x' }] } } }).resolve('x').provider.apiBase, 'https://localhost.example.com/v1', 'only the exact host is rewritten');
  assert.equal(cfg.defaultEntry.id, 'M1');
  assert.ok(cfg.warnings.some((w) => /duplicate model name "m1"/.test(w)));
  assert.equal(new Config({ providers: { a: { enabled: true, type: 'openai', api_key: '${NOPE}', models: [{ name: 'x' }] } } }, { env: {} }).warnings.some((w) => /NOPE is not set/.test(w)), true);
  assert.equal(cfg.get('kiro_endpoint.telemetry'), false);
  assert.equal(cfg.get('does.not.exist', 'fb'), 'fb');
});
test('config: loads JSON, missing file → defaults, bad type is a warning', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-cfg-'));
  fs.writeFileSync(path.join(d, 'c.json'), JSON.stringify({ proxy: { port: 1234 } }));
  assert.equal(loadConfig(path.join(d, 'c.json')).get('proxy.port'), 1234);
  assert.equal(loadConfig(path.join(d, 'missing.yaml')).get('proxy.port'), 29974);
  assert.ok(new Config({ providers: { z: { enabled: true, type: 'carrier-pigeon', models: [] } } }).warnings.some((w) => /unknown type/.test(w)));
  assert.ok(new Config({ providers: { z: { enabled: true, type: 'litellm', models: [] } } }).warnings.some((w) => /use type openai/.test(w)), 'gateway types point people at type: openai');
});

// ── schema / json ──
test('schema: collapses zod optional unions, strips $schema, keeps property names, honours strip list', () => {
  const zodOptional = { anyOf: [{ anyOf: [{ not: {} }, { type: 'number', description: 'd', default: 1 }] }, { type: 'null' }], description: 'outer' };
  const s = sanitizeSchema({ $schema: 'x', type: 'object', additionalProperties: false, properties: { n: zodOptional, default: { type: 'string' }, u: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['u'] }, { strip: ['additionalProperties'] });
  assert.deepEqual(s.properties.n, { type: 'number', description: 'outer', default: 1 });
  assert.deepEqual(s.properties.u.anyOf, [{ type: 'string' }, { type: 'number' }], 'real unions are kept');
  assert.ok('default' in s.properties, 'a property called "default" is not stripped');
  assert.ok(!('$schema' in s) && !('additionalProperties' in s));
  assert.deepEqual(sanitizeSchema(undefined), { type: 'object', properties: {} });
  assert.deepEqual(sanitizeSchema({ type: 'object', properties: { a: zodOptional } }, { simplify: false }).properties.a, zodOptional, 'simplify:false leaves unions alone');
});
test('json-repair: handles fences, prose, trailing commas, truncation, double encoding', () => {
  const ok = (s) => parseToolArgs(s);
  assert.deepEqual(ok('{"a":1}'), { ok: true, value: { a: 1 }, repaired: false });
  assert.deepEqual(ok(''), { ok: true, value: {}, repaired: false });
  assert.equal(ok('```json\n{"a":1}\n```').value.a, 1);
  assert.equal(ok('Sure {"a":1} thanks').value.a, 1);
  assert.equal(ok('{"a":1,}').value.a, 1);
  assert.deepEqual(ok('{"p":"x","c":"l1\\nl2').value, { p: 'x', c: 'l1\nl2' });
  assert.deepEqual(ok('{"a":{"b":[1,2').value, { a: { b: [1, 2] } });
  assert.deepEqual(ok(JSON.stringify('{"a":1}')).value, { a: 1 });
  assert.equal(ok('[1]').ok, false);
  assert.equal(ok('nonsense').ok, false);
});

// ── routing & misc ──
test('classify: maps Kiro endpoints to handlers', () => {
  const c = (host, pathname) => classify({ host, pathname });
  assert.equal(c('q.us-east-1.amazonaws.com', '/generateAssistantResponse'), 'chat');
  assert.equal(c('q.us-east-1.amazonaws.com', '/ListAvailableModels'), 'models');
  assert.equal(c('q.us-east-1.amazonaws.com', '/generatecompletions'), 'completions');
  assert.equal(c('q.us-east-1.amazonaws.com', '/getUsageLimits'), 'usage');
  assert.equal(c('q.us-east-1.amazonaws.com', '/mcp'), 'mcp');
  assert.equal(c('prod.us-east-1.auth.desktop.kiro.dev', '/refreshToken'), 'auth');
  assert.equal(c('telemetry.us-east-1.kiro.dev', '/v1/metrics'), 'telemetry');
  assert.equal(c('x.kiro.dev', '/releases/metadata-win32-x64-user.json'), 'update');
  assert.equal(c('oidc.us-east-1.amazonaws.com', '/token'), 'other');
});
test('model list: ordering, override-in-place, rate-unit relabel, default model, no native when hidden', () => {
  const cfg = new Config({ model_list: { order: 'custom-first', default_model: 'mine' }, providers: { p: { enabled: true, type: 'openai', models: [{ name: 'mine' }, { name: 'sonnet', display_name: 'Rerouted' }] } } });
  const up = { models: [{ modelId: 'auto', rateUnit: 'Credit', rateMultiplier: 1 }, { modelId: 'sonnet', modelName: 'S' }], nextToken: 'n' };
  const l = buildModelList(up, cfg);
  assert.deepEqual(l.models.map((m) => m.modelId), ['mine', 'auto', 'sonnet']);
  assert.equal(l.models[2].modelName, 'Rerouted');
  assert.equal(l.models[1].rateUnit, 'Kiro Credits');
  assert.equal(l.nextToken, 'n');
  assert.deepEqual(l.defaultModel, { modelId: 'mine' }, 'Kiro\'s real defaultModel shape');
  assert.deepEqual(buildModelList(up, cfg, { includeNative: false }).models.map((m) => m.modelId), ['mine', 'sonnet']);
  assert.deepEqual(buildModelList(null, new Config({}), {}).models, []);
});
test('web_search config normalisation and tool-list rewriting', () => {
  assert.equal(normalizeWebSearch(undefined).mode, 'default');
  assert.equal(normalizeWebSearch('aws-enforce').mode, 'enforce');
  assert.equal(normalizeWebSearch('disabled').mode, 'disabled');
  assert.equal(normalizeWebSearch({ execute: {} }).mode, 'custom');
  const tools = [{ name: 'web_search', description: 'aws' }, { name: 'x' }];
  assert.deepEqual(modifyTools(tools, { mode: 'disabled' }).map((t) => t.name), ['x']);
  assert.deepEqual(modifyTools([{ name: 'x' }], { mode: 'enforce' }).map((t) => t.name), ['x', 'web_search'], 'injected when AWS did not list it');
  assert.equal(modifyTools(tools, { mode: 'default' }), tools);
});
test('util + redaction', () => {
  assert.ok(globToRegExp('*.amazonaws.com').test('q.us-east-1.amazonaws.com'));
  assert.ok(!globToRegExp('*.amazonaws.com').test('amazonaws.com.evil.io'));
  assert.deepEqual(splitHostPort('[::1]:8443'), { host: '::1', port: 8443 });
  assert.deepEqual(splitHostPort('q.amazonaws.com:443'), { host: 'q.amazonaws.com', port: 443 });
  assert.deepEqual(splitHostPort('example.com'), { host: 'example.com', port: 443 });
  const r = redact('Authorization: Bearer abcdefghijklmnop key sk-abcd1234567890zz api_key: "supersecretvalue"');
  assert.ok(!/abcdefghijklmnop|1234567890zz|supersecretvalue/.test(r), r);
});

test('the shipped example config parses and produces a sane registry', () => {
  const cfg = loadConfig(path.join(here, '..', '..', 'kiromask.config.example.yaml'), { env: { OPENROUTER_API_KEY: 'k', NVIDIA_API_KEY: 'k' } });
  assert.equal(cfg.get('proxy.port'), 29974);
  assert.equal(cfg.resolve('minimax/minimax-m2.5').id, 'minimax/minimax-m2.5');
  assert.equal(cfg.resolve('kiro'), 'native');
  assert.equal(cfg.resolve('qwen-plus'), null, 'disabled providers are not registered');
  assert.deepEqual(cfg.warnings, []);
  assert.equal(cfg.get('defaults.max_tokens'), 16384);
});

test('config validation: typos and dangling references produce warnings instead of silent misbehaviour', () => {
  const w = (raw) => new Config(raw, { env: {} }).warnings;
  const prov = { enabled: true, type: 'openai', api_key: 'k', models: [{ name: 'm1' }] };
  assert.deepEqual(w({ providers: { p: prov } }), [], 'a valid config is quiet');
  const has = (raw, re) => assert.ok(w(raw).some((x) => re.test(x)), `expected a warning matching ${re} for ${JSON.stringify(raw).slice(0, 80)}`);
  has({ tls: { mode: 'pin' } }, /tls\.mode/);
  has({ defaults: { reasoning: 'hide' } }, /defaults\.reasoning/);
  has({ defaults: { tool_args: 'live' } }, /defaults\.tool_args/);
  has({ defaults: { errors: 'toast' } }, /defaults\.errors/);
  has({ providers: { p: { ...prov, models: [{ name: 'm1', reasoning: 'nope' }] } } }, /m1.*reasoning/);
  has({ session_title: 'ghost', providers: { p: prov } }, /session_title.*ghost/);
  has({ completions: 'ghost', providers: { p: prov } }, /completions.*ghost/);
  has({ default_model: 'ghost', providers: { p: prov } }, /default_model.*ghost/);
  has({ model_list: { order: 'random' } }, /model_list\.order/);
  has({ proxy: { port: 70000 } }, /proxy\.port/);
  has({ web_search: 'sometimes' }, /web_search/);
  has({ providers: { p: { ...prov, models: [] } } }, /provider "p".*no models/);
  assert.deepEqual(w({ session_title: 'm1', completions: 'current', default_model: 'm1', providers: { p: prov } }), [], 'valid references are accepted');
});

test('config validation: unknown (mistyped) settings are reported, nested ones included; free-form maps are not', () => {
  const w = (raw) => new Config(raw, { env: {} }).warnings;
  assert.ok(w({ kiro_endpoints: {} }).some((x) => /^kiro_endpoints: unknown setting/.test(x)));
  assert.ok(w({ kiro_endpoint: { telemetery: true } }).some((x) => /^kiro_endpoint\.telemetery: unknown setting/.test(x)));
  assert.ok(w({ defaults: { max_token: 5 } }).some((x) => /defaults\.max_token: unknown/.test(x)));
  assert.deepEqual(w({ kiro: { env: { ANYTHING: '1' }, args: ['--x'] }, launch: { companions: [{ command: 'x' }] }, web_search: { execute: { type: 'http' } } }), [], 'kiro.env / companions / web_search are free-form');
});
