#!/usr/bin/env node
// Kiro Mask doctor — run this on the machine where Kiro runs and send back the report.
//
// It checks, WITHOUT needing Kiro to be running:
//   • your system: proxy settings, TLS inspection, ports
//   • your Kiro install: version, launcher (cli.js), bundled native executables
//   • whether the real servers speak HTTP/2, and who signs their certificates on your network
//   • a client-compatibility matrix against (a) the recording proxy and (b) Kiro Mask's own proxy,
//     so we can see exactly which client behaviours Kiro Mask's proxy handles and which it does not
//   • the same real hosts through both proxies (needs internet)
//
//   node doctor.mjs              run everything
//   node doctor.mjs --help
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeUpstream } from './lib/mitm.mjs';
import { startRecorderRig, startProductProxy } from './lib/rig.mjs';
import { CASES, runCase, connectTunnel, secure, h1Req, h2Req } from './lib/matrix.mjs';
import { systemProxy } from './lib/sysproxy.mjs';
import { resolveKiroExe, explainMissing, resolveCli, installDir, readVersions, listExecutables, appDir } from './lib/kiroinfo.mjs';
import { normalizeArgv, parseMatch, processRegex } from './lib/argv.mjs';
import { listProcesses, kiroPids, run } from './lib/procs.mjs';
import { tarGz } from './lib/tar.mjs';
import { redactText } from './lib/redact.mjs';

const VERSION = '1.4';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELP = `kiromask-doctor ${VERSION}

Usage: node doctor.mjs [options]

  --exe <path>        Kiro to test: the .exe, its install folder, a macOS .app, or a .lnk shortcut
                      (also --exe=PATH, or set KIRO_EXE; default: auto-detect)
  --cli <path>        use this cli.js launcher script instead of <install>/resources/app/out/cli.js
  --no-cli            do not use or test a cli.js launcher
  --match <regex>     extra process-name pattern for finding running Kiro processes (default: kiro + the exe's name)
  --product <dir>     Kiro Mask product folder to test side by side (default: the folder that contains _kiromask_diag-n-test/)
  --hosts <a,b,...>   extra hostnames to probe on the real network
  --skip-network      do not contact the internet
  --skip-matrix       skip the proxy compatibility matrix
  --out <dir>         output folder (default <this folder>/output/kiromask-doctor-<timestamp>)
  -q, --quiet
  -h, --help
`;

const DEFAULT_HOSTS = [
  'q.us-east-1.amazonaws.com', 'codewhisperer.us-east-1.amazonaws.com', 'oidc.us-east-1.amazonaws.com',
  'prod.us-east-1.auth.desktop.kiro.dev', 'prod.download.desktop.kiro.dev', 'desktop.kiro.dev', 'kiro.dev', 'app.kiro.dev',
  'github.com', // control: a well-known non-Kiro host
];
const TRUSTED_ISSUER = /amazon|starfield|digicert|google|let'?s encrypt|isrg|cloudflare|sectigo|globalsign|microsoft|baltimore|comodo|usertrust|entrust|godaddy|zerossl/i;

export function parseArgs(argvIn) {
  const argv = normalizeArgv(argvIn);
  const o = { hosts: [] };
  const need = (i, n) => { if (i + 1 >= argv.length) throw new Error(`${n} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exe') o.exe = need(i++, a);
    else if (a === '--cli') o.cli = need(i++, a);
    else if (a === '--no-cli') o.noCli = true;
    else if (a === '--match') { o.match = need(i++, a); parseMatch(o.match); }
    else if (a === '--product') o.product = need(i++, a);
    else if (a === '--hosts') o.hosts = need(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--skip-network') o.skipNetwork = true;
    else if (a === '--skip-matrix') o.skipMatrix = true;
    else if (a === '--out') o.out = need(i++, a);
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

class Report {
  constructor(quiet) { this.items = []; this.quiet = quiet; }
  add(id, title, status, detail = '', data = undefined) {
    const item = { id, title, status, detail, ...(data !== undefined ? { data } : {}) };
    this.items.push(item);
    if (!this.quiet) console.log(`  ${{ ok: '✓', warn: '!', fail: '✗', info: '·', skip: '–' }[status]} ${title}${detail ? ` — ${detail}` : ''}`);
    return item;
  }
  section(name) { if (!this.quiet) console.log(`\n▶ ${name}`); this.items.push({ section: name }); }
}

const withTimeout = (p, ms, label = 'timeout') => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(label)), ms))]);

/** Run Kiro's own launcher script with --version (no window opens) to prove the launch mechanism works. */
export function launcherSelfTest(exe, cli) {
  return new Promise((resolve) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' };
    const child = spawn(exe, [cli, '--version'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'timed out after 25 s', out, err }); }, 25_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out: out.trim().slice(0, 500), err: err.trim().slice(0, 500) }); });
  });
}

const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

export async function probeHost(host) {
  const out = { host };
  try { out.addresses = (await withTimeout(dns.promises.lookup(host, { all: true }), 5000)).map((a) => a.address); }
  catch (e) { out.dnsError = e.code || e.message; return out; }
  out.tls = await probeUpstream({ connectHost: host, connectPort: 443, servername: host }, 8000);
  if (out.tls.ok) {
    out.http = await new Promise((resolve) => {
      const r = https.request({ host, path: '/', method: 'GET', headers: { host, 'user-agent': 'kiromask-doctor' }, timeout: 8000, agent: false }, (res) => { res.resume(); resolve({ status: res.statusCode, server: res.headers.server || null, via: res.headers.via || null }); });
      r.on('error', (e) => resolve({ error: e.code || e.message })); r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); }); r.end();
    });
  }
  return out;
}

export async function realThroughProxy(proxyPort, host, kind) {
  try {
    const sock = await withTimeout(connectTunnel(proxyPort, `${host}:443`), 8000, 'CONNECT timeout');
    const s = await withTimeout(secure(sock, { servername: host, alpn: kind === 'h2' ? ['h2', 'http/1.1'] : ['http/1.1'] }), 10_000, 'TLS timeout');
    const r = s.alpnProtocol === 'h2' ? await withTimeout(h2Req(s, host, { path: '/' }), 10_000, 'request timeout') : await withTimeout(h1Req(s, host, { path: '/' }), 10_000, 'request timeout');
    s.destroy();
    const text = r.body?.toString('utf8') || '';
    // a 502 written by the PROXY (it could not reach the real server) is a failure, not a server answer
    if (r.status === 502 && /upstream error/i.test(text)) return { ok: false, error: text.replace(/\s+/g, ' ').replace(/^\{?"?message"?:?\s*"?/, '').slice(0, 160), alpn: s.alpnProtocol || 'http/1.1' };
    return { ok: true, status: r.status, alpn: s.alpnProtocol || 'http/1.1' };
  } catch (e) { return { ok: false, error: e.code || e.message }; }
}

export async function curlThrough(proxyPort, host, version) {
  const out = await run('curl', ['-sS', '-m', '12', '-x', `http://127.0.0.1:${proxyPort}`, '-k', version, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code} http/%{http_version}', `https://${host}/`], { timeout: 20_000 });
  return out === null ? { ok: false, error: 'curl failed or unavailable' } : { ok: true, result: out.trim() };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return console.log(HELP);
  const R = new Report(args.quiet);
  const t0 = Date.now();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const outDir = path.resolve(args.out || path.join(path.resolve(process.env.KMDIAG_OUT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'output')), `kiromask-doctor-${stamp}`));
  fs.mkdirSync(outDir, { recursive: true });
  const meta = { tool: `kiromask-doctor ${VERSION}`, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, release: os.release(), node: process.version };
  const productCandidates = args.product ? [path.resolve(args.product)] : [path.join(HERE, '..'), path.join(HERE, '..', 'kiromask')];
  const productDir = productCandidates.find((d) => fs.existsSync(path.join(d, '_kiromask-src', 'app.mjs'))) || productCandidates[0];
  const hasProduct = fs.existsSync(path.join(productDir, '_kiromask-src', 'app.mjs'));

  console.log(`Kiro Mask doctor ${VERSION} — ${process.platform}/${process.arch}, Node ${process.version}`);

  // ── 1. system ──
  R.section('System and proxy settings');
  R.add('node', 'Node.js version', Number(process.versions.node.split('.')[0]) >= 18 ? 'ok' : 'fail', process.version);
  const sp = await systemProxy();
  R.add('sysproxy', 'Proxy settings imposed on applications', 'info', JSON.stringify(sp).slice(0, 400), sp);
  const winEnabled = sp.windowsInternetSettings?.ProxyEnable && /1$/.test(sp.windowsInternetSettings.ProxyEnable);
  if (winEnabled || Object.keys(sp.env).some((k) => /^(https?|all)_proxy$/i.test(k))) R.add('sysproxy-active', 'A system/environment proxy is configured', 'warn', 'Kiro traffic may chain through it; a VPN/corporate proxy can also inspect TLS');
  if (sp.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') R.add('tls-env', 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set in your shell', 'warn', 'certificate checking is disabled for every Node program started from here');
  for (const port of [8899, 29974]) R.add(`port-${port}`, `Local port ${port} is free`, (await portFree(port)) ? 'ok' : 'warn', (await portFree(port)) ? '' : 'something is already listening (another capture/proxy instance?)');

  // ── 2. Kiro install ──
  R.section('Kiro installation');
  const found = await resolveKiroExe(args.exe);
  const exe = found.exe;
  let cli = null;
  if (!exe) R.add('kiro-exe', 'Kiro executable', 'fail', explainMissing(found).replace(/\n/g, ' '), found);
  else {
    R.add('kiro-exe', 'Kiro executable', 'ok', `${exe}  (${found.via})${found.alternatives?.length ? `; other candidates in that folder: ${found.alternatives.slice(0, 3).join(', ')}` : ''}`, found);
    const v = readVersions(exe);
    R.add('kiro-version', 'Kiro version', v.product ? 'ok' : 'warn', v.product ? JSON.stringify(v.product) : 'product.json not found', v);
    const ci = resolveCli(exe, { cliOverride: args.cli, noCli: args.noCli });
    cli = ci.cli;
    R.add('kiro-cli', 'Launcher script (cli.js)', ci.error ? 'fail' : cli ? 'ok' : args.noCli ? 'info' : 'fail', ci.error || (cli ? `${cli} (${ci.via})` : args.noCli ? 'not used (--no-cli)' : 'missing — the launch method used by Kiro Mask relies on it; the app layout may have changed. If your build keeps it elsewhere, pass --cli <path>'));
    const app = appDir(exe);
    if (app) { try { R.add('kiro-layout', 'resources/app layout', 'info', fs.readdirSync(app).slice(0, 40).join(', '), { app: fs.readdirSync(app), out: fs.existsSync(path.join(app, 'out')) ? fs.readdirSync(path.join(app, 'out')).slice(0, 80) : null }); } catch { /* unreadable */ } }
    const execs = listExecutables(installDir(exe));
    const native = execs.filter((e) => !/^(Kiro\.exe|kiro|Electron)$/i.test(path.basename(e.path)) && /\.exe$|^[^.]+$/.test(path.basename(e.path)));
    R.add('kiro-natives', 'Bundled executables other than the main app', native.length ? 'info' : 'ok', native.length ? `${native.length}: ${native.slice(0, 12).map((e) => e.path).join(', ')}` : 'none found', execs);
    if (cli) {
      const t = await launcherSelfTest(exe, cli);
      R.add('kiro-launch-selftest', 'Launcher self-test (cli.js --version, no window)', t.ok ? 'ok' : 'fail', t.ok ? `printed: ${redactText(t.out).replace(/\s+/g, ' ').slice(0, 120)}` : `${t.error || `exit ${t.code}`} ${redactText(t.err || '')}`.slice(0, 300), t);
    }
  }
  const procs = await listProcesses();
  const procRe = processRegex(exe, args.match);
  const running = kiroPids(procs, { installDir: exe ? installDir(exe) : null, nameRe: procRe });
  R.add('kiro-running', 'Kiro processes running right now', running.size ? 'warn' : 'ok', running.size ? `${running.size} process(es) — close Kiro completely before capturing, or it ignores proxy flags` : 'none', procs.filter((p) => running.has(p.pid)).map((p) => ({ pid: p.pid, name: p.name })));

  // ── 3. real network ──
  let directOk = false;
  if (args.skipNetwork) R.section('Real network (skipped)');
  else {
    R.section('Real network, direct (no proxy)');
    const hosts = [...new Set([...DEFAULT_HOSTS, ...args.hosts])];
    const results = [];
    for (const h of hosts) {
      const r = await probeHost(h);
      results.push(r);
      if (r.dnsError) { R.add(`net-${h}`, h, 'info', `does not resolve (${r.dnsError})`); continue; }
      if (!r.tls.ok) { R.add(`net-${h}`, h, 'warn', `TLS failed: ${r.tls.error}`, r); continue; }
      directOk = true;
      const issuerOk = TRUSTED_ISSUER.test(r.tls.issuer || '') && r.tls.authorized;
      R.add(`net-${h}`, h, issuerOk ? 'ok' : 'warn', `${r.tls.alpn}, ${r.tls.tls}, HTTP ${r.http?.status ?? r.http?.error}, issuer: ${r.tls.issuer || '?'}${issuerOk ? '' : `  ← unexpected issuer / not trusted here (${r.tls.authorizationError || 'unknown issuer'}): TLS inspection?`}`, r);
    }
    meta.directProbe = results;
    if (results.every((r) => r.dnsError)) R.add('net-offline', 'No host could be resolved', 'warn', 'DNS or internet access is not working from this machine, so the real-server tests were skipped');
    const h2hosts = results.filter((r) => r.tls?.alpn === 'h2').map((r) => r.host);
    if (h2hosts.length) R.add('net-h2', 'These real servers negotiate HTTP/2', 'info', h2hosts.join(', ') + ' — a proxy must support HTTP/2 for clients that insist on it');
  }

  // ── 4. proxy compatibility matrix ──
  let recorderResults = null; const productResults = {};
  if (args.skipMatrix) R.section('Proxy compatibility matrix (skipped)');
  else {
    R.section('Proxy compatibility matrix: recording proxy');
    const rig = await startRecorderRig({ keyType: 'rsa' });
    try {
      recorderResults = [];
      for (const c of CASES) { const r = await runCase(c, rig, 8000); recorderResults.push(r); R.add(`rec-${c.id}`, `${c.id}: ${c.desc}`, r.ok ? 'ok' : 'fail', r.detail); }
    } finally { /* keep mocks for the product run */ }

    if (hasProduct) {
      R.section(`Proxy compatibility matrix: Kiro Mask's proxy (${path.relative(process.cwd(), productDir) || productDir})`);
      for (const c of CASES) {
        const prod = await startProductProxy(productDir, { connectHost: '127.0.0.1', port: rig.mocks.ports[c.mock], insecure: true });
        if (prod.error) { R.add('prod-load', 'Load Kiro Mask', 'fail', prod.error); break; }
        try { const r = await runCase(c, { proxyPort: prod.port, mocks: rig.mocks, caPem: prod.caPem }, 3000); productResults[c.id] = r; R.add(`prod-${c.id}`, `${c.id}`, r.ok ? 'ok' : 'fail', r.detail); }
        finally { await prod.stop(); }
      }
    } else R.add('prod', "Kiro Mask's own proxy", 'skip', `product not found at ${productDir} (use --product <dir>)`);
    await rig.stop();
  }

  // ── 5. real hosts through the proxies ──
  const throughResults = [];
  if (!args.skipNetwork && directOk && !args.skipMatrix) {
    R.section('Real servers through each proxy');
    const targets = ['q.us-east-1.amazonaws.com', 'prod.us-east-1.auth.desktop.kiro.dev', 'kiro.dev'].filter((h) => meta.directProbe?.some((r) => r.host === h && r.tls?.ok));
    const rec = await startRecorderRig({ keyType: 'rsa', recOpts: { upstreamMap: {}, insecureUpstream: false } });
    const prod = hasProduct ? await startProductProxy(productDir, {}, { interceptHosts: ['*.amazonaws.com', '*.kiro.dev', 'kiro.dev'] }) : null;
    try {
      for (const h of targets) {
        for (const kind of ['h1', 'h2']) {
          const direct = meta.directProbe.find((r) => r.host === h);
          const a = await realThroughProxy(rec.proxyPort, h, kind);
          const b = prod && !prod.error ? await realThroughProxy(prod.port, h, kind) : null;
          throughResults.push({ host: h, client: kind, directStatus: direct?.http?.status, recorder: a, product: b });
          R.add(`real-${h}-${kind}`, `${h} (${kind} client)`, a.ok && (!b || b.ok) ? 'ok' : 'warn',
            `direct ${direct?.http?.status ?? '?'} · recorder ${a.ok ? `${a.status} via ${a.alpn}` : `FAILED ${a.error}`}${b ? ` · Kiro Mask ${b.ok ? `${b.status} via ${b.alpn}` : `FAILED ${b.error}`}` : ''}`);
        }
        if (await run('curl', ['--version'])) {
          for (const v of ['--http1.1', '--http2']) { const c1 = await curlThrough(rec.proxyPort, h, v); R.add(`curl-${h}${v}`, `curl ${v} via recorder: ${h}`, c1.ok ? 'ok' : 'warn', c1.result || c1.error); }
        }
      }
    } finally { await rec.stop(); if (prod && !prod.error) await prod.stop(); }
  }

  // ── conclusions ──
  R.section('What this suggests');
  const concl = [];
  const prodFails = Object.entries(productResults).filter(([, r]) => !r.ok).map(([id]) => id);
  const recFails = (recorderResults || []).filter((r) => !r.ok && !CASES.find((c) => c.id === r.id)?.expectFailure).map((r) => r.id);
  if (prodFails.length) concl.push(`Kiro Mask's proxy cannot handle: ${prodFails.join(', ')}. Any Kiro client that behaves like these would not be intercepted (the recording proxy handles them).`);
  if (recFails.length) concl.push(`The recording proxy itself failed: ${recFails.join(', ')} — send this report, the capture tool will be unreliable on this machine.`);
  const odd = (meta.directProbe || []).filter((r) => r.tls?.ok && !(TRUSTED_ISSUER.test(r.tls.issuer || '') && r.tls.authorized));
  if (odd.length) concl.push(`TLS inspection is likely on this network (unexpected issuers for: ${odd.map((r) => r.host).join(', ')}). Interception chains through it and can break either proxy.`);
  if (exe && !cli) concl.push('Kiro has no resources/app/out/cli.js: the launch method no longer applies to this version.');
  if (running.size) concl.push('Kiro is running now. Close it fully before any capture.');
  if (!concl.length) concl.push('Nothing wrong was found by these tests. The next step is the traffic capture (capture.mjs) while using Kiro.');
  for (const c of concl) R.add('conclusion', c, 'info');

  meta.durationSeconds = Math.round((Date.now() - t0) / 1000);
  const report = { meta, productDir: hasProduct ? productDir : null, results: R.items, matrix: { recorder: recorderResults, product: productResults }, throughProxies: throughResults, conclusions: concl };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const text = [`Kiro Mask doctor ${VERSION} — ${meta.platform}/${meta.arch} ${meta.release}, Node ${meta.node}`, ''];
  for (const it of R.items) text.push(it.section ? `\n== ${it.section} ==` : `[${it.status.toUpperCase().padEnd(4)}] ${it.title}${it.detail ? ` — ${it.detail}` : ''}`);
  fs.writeFileSync(path.join(outDir, 'report.txt'), redactText(text.join('\n')) + '\n');
  const archive = await tarGz(outDir, `${outDir}.tar.gz`, path.basename(outDir));
  console.log('\n' + '─'.repeat(72));
  console.log(`Report folder : ${outDir}`);
  console.log(`Send this file: ${archive} (${(fs.statSync(archive).size / 1024).toFixed(0)} KB)`);
  console.log('It holds no prompts, code or credentials: only environment facts, hostnames and test outcomes.');
  console.log('─'.repeat(72));
  return { outDir, archive, report };
}

if (process.argv[1]?.endsWith('doctor.mjs')) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(`\nError: ${e.message}`); process.exit(1); });
}
