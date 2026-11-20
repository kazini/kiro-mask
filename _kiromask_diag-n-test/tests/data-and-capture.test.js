// Where Kiro Mask writes its files, the log file, and the capture feature (debug.capture_traffic).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, ROOT } from '../../_kiromask-src/paths.mjs';
import { defaultDataDir } from '../../_kiromask-src/app.mjs';
import { createLogger, openLogFile } from '../../_kiromask-src/log.mjs';
import { CaptureStore } from '../../_kiromask-src/debug/capture.mjs';
import { redactBody, redactHeaders } from '../../_kiromask-src/debug/redact.mjs';
import { ev } from '../../_kiromask-src/aws/eventstream.mjs';
import { startApp, viaProxy, mockServer, rpc, RUNTIME_HOST, providerConfig, sseHead, sseWrite } from './harness.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kmtest-'));
const walk = (d, pre = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIN = path.join(ROOT, 'kiromask.mjs');

// ── data directory ─────────────────────────────────────────────────────────
test('data dir: defaults to <kiromask folder>/data — never the user profile', () => {
  const saved = process.env.KIROMASK_HOME; delete process.env.KIROMASK_HOME;
  try {
    const d = resolveDataDir({});
    assert.equal(d.dir, path.join(ROOT, 'data'));
    assert.equal(d.source, 'default');
    assert.ok(!d.dir.startsWith(path.join(os.homedir(), '.kiromask')));
    assert.equal(defaultDataDir(), path.join(ROOT, 'data'));
  } finally { if (saved !== undefined) process.env.KIROMASK_HOME = saved; fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true }); }
});

test('data dir: --data-dir beats $KIROMASK_HOME beats config data_dir; relative config paths are relative to the kiromask folder', () => {
  const a = tmp(); const b = tmp();
  assert.equal(resolveDataDir({ cli: a, env: b, config: 'x' }).dir, a);
  assert.equal(resolveDataDir({ env: b, config: 'x' }).dir, b);
  const rel = resolveDataDir({ env: null, config: path.relative(ROOT, path.join(b, 'rel')) });
  assert.equal(rel.dir, path.join(b, 'rel'));
  assert.equal(rel.source, 'data_dir');
  assert.ok(fs.existsSync(rel.dir), 'created on demand');
});

test('data dir: an unwritable location falls back to ~/.kiromask with a flag instead of crashing', () => {
  const file = path.join(tmp(), 'iam-a-file');
  fs.writeFileSync(file, 'x');
  const d = resolveDataDir({ cli: path.join(file, 'sub') });
  assert.equal(d.fellBack, true);
  assert.equal(d.dir, path.join(os.homedir(), '.kiromask'));
});

// ── log file ───────────────────────────────────────────────────────────────
test('log file: gets every level (debug included) with full timestamps and redaction; console honours verbosity', () => {
  const dir = tmp(); const lines = [];
  const log = createLogger({ color: false, level: 'info', write: (l) => lines.push(l) });
  log.attachFile(openLogFile(dir));
  log('debug', 'only in the file Bearer abcdefghijklmnopqrstuv');
  log('info', 'in both');
  log('error', 'boom');
  const file = log.logFile();
  log.detachFile();
  assert.equal(lines.length, 2, 'debug not on the console');
  const text = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(text.length, 3);
  assert.match(text[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z DEBUG only in the file Bearer \*\*\*$/);
  assert.match(path.basename(file), /^kiromask-\d{8}-\d{6}\.log$/);
});

test('log file: only the newest `keep` files are kept; writing after close is a no-op', () => {
  const dir = tmp();
  for (let i = 0; i < 5; i++) openLogFile(dir, { keep: 3, now: new Date(Date.UTC(2026, 0, 1 + i)) }).close();
  assert.deepEqual(fs.readdirSync(dir).sort().map((f) => f.slice(9, 17)), ['20260103', '20260104', '20260105']);
  const f = openLogFile(dir, { keep: 3 }); f.close(); f.write('late');
});

// ── capture ────────────────────────────────────────────────────────────────
const awsHandler = (req, res) => { res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' }); res.end(Buffer.concat([ev.text('native reply'), ev.contextUsage(1)])); };
const respBody = (model) => ({ model, input: [{ role: 'user', content: 'hello' }], tools: [], stream: true, metadata: { 'kiro:agent_mode': 'default-v2', 'kiro:conversation_id': 'sess_t' } });
const postResp = (h, body, headers = {}) => viaProxy(h.port, h.caPem, RUNTIME_HOST, { method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: 'Bearer real-token-abcdefghijklmnop', ...headers }, body: JSON.stringify(body) });

test('capture: records every exchange (Responses chat, AWS chat, telemetry, other) in the diag layout, credentials redacted', async () => {
  const provider = await mockServer((req, res) => { sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }); res.end(); });
  const h = await startApp({ ...providerConfig(provider.port), debug: { capture_traffic: true } }, { awsHandler });
  try {
    await postResp(h, respBody('my-model'));                                    // custom, Responses
    await postResp(h, respBody('auto'), { 'x-api-key': 'sk-supersecret-1234567890abcdef' }); // native, Responses (answered by the AWS stub)
    await rpc(h, RUNTIME_HOST, 'KiroRuntimeService.GenerateAssistantResponse', JSON.stringify({ conversationState: { conversationId: 'c', currentMessage: { userInputMessage: { content: 'hi', modelId: 'my-model' } }, history: [] } })); // custom, AWS
    await viaProxy(h.port, h.caPem, 'telemetry.us-east-1.kiro.dev', { method: 'POST', path: '/v1/traces', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spans: [1, 2, 3] }) });
    await sleep(150);
    const root = path.join(h.dataDir, 'captures');
    const [session] = fs.readdirSync(root);
    const dir = path.join(root, session);
    const files = walk(dir);
    const metaFiles = files.filter((f) => /^flows\/\d{4}_[^/]+\.json$/.test(f) && !/\.(req|res|provider\.\w+)\.json$/.test(f));
    assert.equal(metaFiles.length, 4, `one metadata file per exchange: ${metaFiles}`);
    const meta = (n) => JSON.parse(fs.readFileSync(path.join(dir, metaFiles.find((f) => f.includes(`/${String(n).padStart(4, '0')}_`))), 'utf8'));

    const m1 = meta(1);
    assert.deepEqual([m1.route, m1.format, m1.model, m1.status ?? m1.response.status], ['chat', 'responses', 'my-model', 200]);
    assert.match(m1.handled, /^model mock\/my-model$/);
    assert.equal(m1.provider.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'flows', m1.provider.request.file), 'utf8')).model, 'my-model', 'what was sent to your provider');
    assert.match(fs.readFileSync(path.join(dir, 'flows', m1.provider.response.file), 'utf8'), /hello/, 'what your provider answered');
    assert.match(fs.readFileSync(path.join(dir, 'flows', m1.response.body.file), 'utf8'), /response\.completed/, 'what Kiro received');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'flows', m1.request.body.file), 'utf8')).model, 'my-model');

    const m2 = meta(2);
    assert.equal(m2.handled, 'passthrough');
    const m3 = meta(3);
    assert.equal(m3.format, 'aws');
    assert.ok(m3.response.body.eventsFile && m3.response.body.events > 0, 'AWS event stream decoded to .events.jsonl');
    assert.match(fs.readFileSync(path.join(dir, 'flows', m3.response.body.eventsFile), 'utf8'), /assistantResponseEvent/);
    const m4 = meta(4);
    assert.equal(m4.route, 'telemetry');
    assert.match(m4.request.body.omitted, /telemetry/);

    // no credential anywhere on disk
    const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.ok(!/real-token-abcdefghijklmnop|sk-supersecret/.test(all), 'tokens never written');
    assert.match(m1.request.headers.authorization, /^Bearer \[redacted len=\d+\]$/);

    const sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    assert.equal(sum.chats.length, 3);
    const session1 = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    assert.equal(session1.chatFormat, 'aws', 'last format seen');
    assert.ok(!JSON.stringify(session1).includes('mock-key') && !JSON.stringify(session1).includes('apiKey'), 'no provider keys in session.json');
  } finally { await h.stop(); provider.close(); }
});

test('capture: off by default (no folder created); turning it on at runtime starts recording; stop() reports the folder', async () => {
  const h = await startApp({}, { awsHandler });
  try {
    await postResp(h, respBody('auto'));
    assert.ok(!fs.existsSync(path.join(h.dataDir, 'captures')), 'nothing written while off');
    h.app.capture.enabled = true;
    await postResp(h, respBody('auto'));
    await sleep(100);
    const dir = h.app.capture.dir;
    assert.ok(dir && fs.existsSync(path.join(dir, 'flows')));
    assert.equal(h.app.capture.close(), dir);
  } finally { await h.stop(); }
});

test('capture: an exchange cut off mid-flight is still written, marked aborted; sessions never overwrite each other', () => {
  const root = tmp();
  const mk = () => new CaptureStore(root, true);
  const a = mk();
  const f = a.begin({ req: { method: 'POST', url: '/x', headers: { host: 'h.example' }, rawBody: Buffer.from('{"a":1}') }, host: 'h.example', route: 'other' });
  f.setResponse(200, { 'content-type': 'text/plain' }); f.write('partial');
  a.close();
  const b = mk(); b.begin({ req: { method: 'GET', url: '/', headers: { host: 'h.example' } }, host: 'h.example', route: 'other' }).finish();
  assert.equal(fs.readdirSync(root).length, 2, 'two separate session folders');
  const meta = JSON.parse(fs.readFileSync(path.join(a.dir, 'flows', fs.readdirSync(path.join(a.dir, 'flows')).find((x) => x.endsWith('.json') && !x.includes('.req.') && !x.includes('.res.'))), 'utf8'));
  assert.equal(meta.aborted, true);
});

test('redact: secrets in headers, JSON keys, tokens pasted in text; structure preserved', () => {
  assert.match(redactHeaders({ authorization: 'Bearer abcdef0123456789', 'content-type': 'x' }).authorization, /^Bearer \[redacted/);
  assert.equal(redactHeaders({ 'content-type': 'x' })['content-type'], 'x');
  const out = JSON.parse(redactBody(Buffer.from(JSON.stringify({ refreshToken: 'a'.repeat(40), nested: { api_key: 'k'.repeat(20), keep: 'fine', note: 'use Bearer abcdefghijklmnopqrstu please' }, tokens: 5 })), 'application/json'));
  assert.match(out.refreshToken, /redacted/);
  assert.match(out.nested.api_key, /redacted/);
  assert.equal(out.nested.keep, 'fine');
  assert.ok(!out.nested.note.includes('abcdefghijklmnopqrstu'));
  assert.equal(out.tokens, 5, 'a counter named "tokens" is not a secret');
});

// ── the real CLI ───────────────────────────────────────────────────────────
function runCli(args, { cwd, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  return { child, out: () => out.replace(/\x1b\[[0-9;]*m/g, ''), done: new Promise((r) => child.on('exit', (code) => r(code))) };
}

test('CLI: writes logs, captures and the CA ONLY under the data dir; `pack` bundles them without secrets', async () => {
  const work = tmp(); const data = path.join(work, 'mydata'); const fakeHome = path.join(work, 'home');
  fs.mkdirSync(fakeHome);
  const provider = await mockServer((req, res) => { sseHead(res); sseWrite(res, { choices: [{ delta: { content: 'hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }); res.end(); });
  fs.writeFileSync(path.join(work, 'kiromask.config.yaml'), `proxy: {port: 0}
debug: {capture_traffic: true}
kiro_endpoint: {models: false}
providers:
  mock: {enabled: true, type: openai, api_base: "http://127.0.0.1:${provider.port}/v1", api_key: sk-cli-secret-1234567890, models: [{name: my-model}]}
`);
  const env = { HOME: fakeHome, USERPROFILE: fakeHome, KIROMASK_HOME: '' };
  const cli = runCli(['--no-launch', '--data-dir', data], { cwd: work, env });
  try {
    let port; for (let i = 0; i < 100 && !port; i++) { port = /listening on 127\.0\.0\.1:(\d+)/.exec(cli.out())?.[1]; if (!port) await sleep(50); }
    assert.ok(port, `proxy started:\n${cli.out()}`);
    const caPem = fs.readFileSync(path.join(data, 'ca', 'ca.cert.pem'), 'utf8');
    const r = await viaProxy(Number(port), caPem, RUNTIME_HOST, { method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: 'Bearer cli-real-token-abcdefghijkl' }, body: JSON.stringify(respBody('my-model')) });
    assert.match(r.body.toString(), /hi there/);
    cli.child.kill('SIGINT');
    assert.equal(await cli.done, 0);
    const o = cli.out();
    assert.match(o, /data: .*mydata.*log: .*mydata.*logs.*kiromask-/);
    assert.match(o, /capture saved: .*mydata/);
    const files = walk(data);
    assert.ok(files.some((f) => /^logs\/kiromask-.*\.log$/.test(f)), 'log file written');
    assert.ok(files.some((f) => /^captures\/[^/]+\/flows\/0001_.*\.provider\.req\.json$/.test(f)), 'capture written');
    assert.ok(files.includes('ca/ca.cert.pem') && files.includes('usage.jsonl'));
    assert.deepEqual(fs.readdirSync(fakeHome), [], 'nothing written to the user profile');
    const log = fs.readFileSync(path.join(data, 'logs', files.find((f) => f.startsWith('logs/')).slice(5)), 'utf8');
    assert.match(log, /DEBUG POST runtime\.us-east-1\.kiro\.dev\/v1\/responses → chat/, 'debug lines are in the file although the console was at info');
    for (const f of files.filter((x) => !x.startsWith('ca/'))) assert.ok(!/cli-real-token|sk-cli-secret/.test(fs.readFileSync(path.join(data, f), 'utf8')), `${f} has no credentials`);

    const pk = runCli(['pack', '--data-dir', data], { cwd: work, env });
    assert.equal(await pk.done, 0, pk.out());
    const archive = fs.readdirSync(data).find((f) => /^kiromask-report-.*\.tar\.gz$/.test(f));
    assert.ok(archive, `archive created: ${pk.out()}`);
    const tar = zlib.gunzipSync(fs.readFileSync(path.join(data, archive))).toString('latin1');
    assert.match(tar, /environment\.json/);
    assert.match(tar, /\.log/);
    assert.match(tar, /provider\.req\.json/);
    assert.ok(!/sk-cli-secret|cli-real-token/.test(tar), 'archive has no credentials');
    assert.ok(!fs.readdirSync(data).some((f) => f.startsWith('kiromask-report-') && !f.endsWith('.tar.gz')), 'temp folder cleaned up');
  } finally { cli.child.kill('SIGKILL'); provider.close(); }
});

test('CLI: an invalid value is reported, and the old intent_classifier name is a rename warning (not an error)', async () => {
  const work = tmp();
  fs.writeFileSync(path.join(work, 'kiromask.config.yaml'), 'intent_classifier: {enabled: true}\ndebug: {log_keep: 0}\n');
  const c = runCli(['check', '--data-dir', path.join(work, 'd')], { cwd: work });
  await c.done;
  assert.match(c.out(), /intent_classifier was renamed to session_title/);
  assert.match(c.out(), /debug\.log_keep/);
});
