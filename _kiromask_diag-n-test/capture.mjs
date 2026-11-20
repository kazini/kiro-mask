#!/usr/bin/env node
// Kiro Mask traffic capture.
//
// Starts a mitmproxy-style recording proxy, launches Kiro behind it, watches Kiro's processes for traffic that
// bypasses the proxy, and writes everything (credentials redacted) into one .tar.gz you can send for analysis.
//
//   node capture.mjs                    launch Kiro and capture until it closes (or Ctrl+C)
//   node capture.mjs --help
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CertAuthority } from './lib/ca.mjs';
import { Recorder } from './lib/mitm.mjs';
import { Monitor } from './lib/monitor.mjs';
import { buildSummary, reverseNames, forwardMap } from './lib/report.mjs';
import { systemProxy, envProxy } from './lib/sysproxy.mjs';
import { resolveKiroExe, explainMissing, resolveCli, findCliJs, installDir, readVersions, listExecutables, collectLogs } from './lib/kiroinfo.mjs';
import { normalizeArgv, parseMatch, processRegex } from './lib/argv.mjs';
import { tarGz } from './lib/tar.mjs';
import { redactText } from './lib/redact.mjs';

const VERSION = '1.4';
// Everything this tool writes (results folders, .tar.gz archives, its local CA) goes under ./output next to this script,
// i.e. inside the kiromask folder, never into your user profile. Override with KMDIAG_OUT_DIR (or --out for one run).
export const OUTPUT_ROOT = path.resolve(process.env.KMDIAG_OUT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'output'));
const HELP = `kiromask-capture ${VERSION} — record what Kiro sends and receives, and find traffic that bypasses a proxy

Usage: node capture.mjs [options]

  --exe <path>           Kiro to launch: the .exe, its install folder, a macOS .app, or a .lnk shortcut
                         (also --exe=PATH, or set KIRO_EXE; default: auto-detect)
  --cli <path>           use this cli.js launcher script instead of <install>/resources/app/out/cli.js
  --no-cli               start the executable directly with the proxy flags (no cli.js wrapper)
  --match <regex>        extra process-name pattern for the process monitor (default: kiro, plus the exe's own name)
  --no-launch            only run the proxy; start Kiro yourself (flags are printed)
  --port <n>             proxy port (default 8899)
  --out <dir>            output folder (default <this folder>/output/kiromask-capture-<timestamp>)
  --duration <seconds>   stop automatically after this long
  --force                launch even if Kiro is already running (its proxy flags would be ignored)

What is intercepted
  --mode intercept|tunnel   intercept = decrypt and record everything (default, like mitmproxy);
                            tunnel = never decrypt, only log hosts / ClientHello / byte counts
  --passthrough <globs>     comma-separated host globs to tunnel instead of decrypting
  --key-type rsa|ec         certificate key type (default rsa, like mitmproxy)
  --tls-mode permissive|spki   how Kiro is told to accept our certificates (default permissive)
  --insecure-upstream       do not validate real servers' certificates

What is recorded
  --meta-only            no request/response bodies at all (hosts, headers, timings only)
  --no-redact            keep credentials in the recording (NOT recommended)
  --full-hosts <globs>   hosts whose bodies are stored in full (default: all)
  --no-bypass            do not watch Kiro's processes for direct (proxy-bypassing) connections
  --no-logs              do not copy Kiro's own log files

Launch
  --no-env-proxy         do not set HTTPS_PROXY/HTTP_PROXY for Kiro (launch exactly like the old tool did)
  --env-ca-bundles       also set SSL_CERT_FILE, AWS_CA_BUNDLE, … (REPLACES trust roots; breaks direct connections)
  --extra-arg <arg>      extra argument for Kiro (repeatable)
  --env <K=V>            extra environment variable for Kiro (repeatable)
  -q, --quiet            less console output
  -v, --verbose          also print every new connection as it opens
  -h, --help
`;

export function parseArgs(argvIn) {
  const argv = normalizeArgv(argvIn);
  const o = { port: 8899, mode: 'intercept', keyType: 'rsa', tlsMode: 'permissive', envProxy: true, extraArgs: [], env: {}, passthrough: [], fullHosts: ['*'] };
  const need = (i, n) => { if (i + 1 >= argv.length) throw new Error(`${n} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exe') o.exe = need(i++, a);
    else if (a === '--cli') o.cli = need(i++, a);
    else if (a === '--no-cli') o.noCli = true;
    else if (a === '--match') { o.match = need(i++, a); parseMatch(o.match); }
    else if (a === '--no-launch') o.noLaunch = true;
    else if (a === '--port') { o.port = Number(need(i++, a)); if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('invalid --port'); }
    else if (a === '--out') o.out = need(i++, a);
    else if (a === '--duration') { o.duration = Number(need(i++, a)); if (!(o.duration > 0)) throw new Error('invalid --duration'); }
    else if (a === '--force') o.force = true;
    else if (a === '--mode') { o.mode = need(i++, a); if (!['intercept', 'tunnel'].includes(o.mode)) throw new Error('--mode must be intercept or tunnel'); }
    else if (a === '--passthrough') o.passthrough = need(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--key-type') { o.keyType = need(i++, a); if (!['rsa', 'ec'].includes(o.keyType)) throw new Error('--key-type must be rsa or ec'); }
    else if (a === '--tls-mode') { o.tlsMode = need(i++, a); if (!['permissive', 'spki'].includes(o.tlsMode)) throw new Error('--tls-mode must be permissive or spki'); }
    else if (a === '--insecure-upstream') o.insecureUpstream = true;
    else if (a === '--meta-only') o.metaOnly = true;
    else if (a === '--no-redact') o.noRedact = true;
    else if (a === '--full-hosts') o.fullHosts = need(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--no-bypass') o.noBypass = true;
    else if (a === '--no-logs') o.noLogs = true;
    else if (a === '--no-env-proxy') o.envProxy = false;
    else if (a === '--env-ca-bundles') o.envCaBundles = true;
    else if (a === '--extra-arg') o.extraArgs.push(need(i++, a));
    else if (a === '--env') { const kv = need(i++, a); const j = kv.indexOf('='); if (j < 1) throw new Error('--env needs K=V'); o.env[kv.slice(0, j)] = kv.slice(j + 1); }
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a === '-v' || a === '--verbose') o.verbose = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/** Build the command that starts Kiro behind the proxy. */
export function buildLaunch({ exe, port, tlsMode, caCertPath, caPin, envProxyOn, envCaBundles, extraArgs, extraEnv, baseEnv = process.env, cli: cliOpt }) {
  const cli = cliOpt !== undefined ? cliOpt : findCliJs(exe);
  const env = { ...baseEnv, VSCODE_DEV: '', ...extraEnv, NODE_EXTRA_CA_CERTS: caCertPath };
  const flags = [`--proxy-server=127.0.0.1:${port}`];
  if (tlsMode === 'spki') flags.unshift(`--ignore-certificate-errors-spki-list=${caPin}`);
  else { flags.unshift('--ignore-certificate-errors'); env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; env.ELECTRON_IGNORE_CERTIFICATE_ERRORS = '1'; }
  const added = ['VSCODE_DEV', 'NODE_EXTRA_CA_CERTS', ...(tlsMode === 'spki' ? [] : ['NODE_TLS_REJECT_UNAUTHORIZED', 'ELECTRON_IGNORE_CERTIFICATE_ERRORS'])];
  if (envProxyOn) {
    const url = `http://127.0.0.1:${port}`;
    Object.assign(env, { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url, https_proxy: url, http_proxy: url, all_proxy: url, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' });
    added.push('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY');
  }
  if (envCaBundles) { for (const k of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'AWS_CA_BUNDLE']) env[k] = caCertPath; added.push('SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'AWS_CA_BUNDLE'); }
  if (cli) { env.ELECTRON_RUN_AS_NODE = '1'; added.push('ELECTRON_RUN_AS_NODE'); return { command: exe, args: [cli, ...flags, ...extraArgs], env, cli, added }; }
  delete env.ELECTRON_RUN_AS_NODE;
  return { command: exe, args: [...flags, ...extraArgs], env, cli: null, added };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return console.log(HELP);
  const say = (m = '') => { if (!args.quiet) console.log(m); };
  const startedAt = Date.now();
  const outDir = path.resolve(args.out || path.join(OUTPUT_ROOT, `kiromask-capture-${stamp()}`));
  fs.mkdirSync(outDir, { recursive: true });

  // Testing hooks (documented in the test suite, not for normal use)
  const upstreamMap = process.env.KMDIAG_UPSTREAM_MAP ? JSON.parse(process.env.KMDIAG_UPSTREAM_MAP) : {};
  const loopbackIsExternal = process.env.KMDIAG_LOOPBACK_EXTERNAL === '1';

  const found = await resolveKiroExe(args.exe);
  const exe = found.exe;
  if (!args.noLaunch && !exe) throw new Error(`${explainMissing(found)}\nOr use --no-launch and start Kiro yourself.`);
  const cliInfo = resolveCli(exe, { cliOverride: args.cli, noCli: args.noCli });
  if (cliInfo.error) throw new Error(cliInfo.error);
  const procRe = processRegex(exe, args.match);

  const ca = new CertAuthority({ dir: process.env.KMDIAG_CA_DIR || path.join(OUTPUT_ROOT, 'ca'), keyType: args.keyType });
  ca.init();

  const recorder = new Recorder({
    outDir, ca, mode: args.mode, passthrough: args.passthrough, fullHosts: args.fullHosts, redact: !args.noRedact, noBodies: !!args.metaOnly,
    insecureUpstream: !!args.insecureUpstream, upstreamMap,
    log: (lvl, msg) => { if (lvl !== 'debug') console.error(`  [${lvl}] ${redactText(msg)}`); },
  });
  let addr;
  try { addr = await recorder.listen(args.port); } catch (e) { throw new Error(e.code === 'EADDRINUSE' ? `port ${args.port} is already in use — pick another with --port` : e.message); }
  const port = addr.port;

  recorder.on('connection', (c) => { if (!args.quiet && args.verbose) console.log(`  conn #${c.id} ${c.target}`); });
  recorder.on('connection-closed', (c) => {
    if (args.quiet) return;
    const hs = c.handshake;
    const bad = c.decision?.startsWith('intercept') && (!hs || !hs.ok);
    const tag = bad ? '✗ TLS FAILED' : c.decision;
    const detail = bad ? ` (${hs?.error || 'closed before handshake'}; client offered ALPN ${JSON.stringify(c.hello?.alpn ?? null)})` : hs?.alpn ? ` [${hs.alpn}]` : '';
    console.log(`  ${bad ? '!' : '·'} ${c.target.padEnd(44)} ${tag}${detail}${c.requests ? ` — ${c.requests} request(s)` : ''}`);
  });
  recorder.on('flow', (f) => { if (!args.quiet) console.log(`    ${String(f.status ?? '---').padEnd(3)} ${f.method.padEnd(6)} ${f.host}${f.path.slice(0, 70)} [${f.proto}] ${f.ms}ms`); });

  const kiroInfo = exe ? { ...readVersions(exe), resolution: { via: found.via, input: found.input ?? null, resolved: found.resolved ?? exe, alternatives: found.alternatives ?? [] }, cliJs: cliInfo.cli, cliVia: cliInfo.via, executables: listExecutables(installDir(exe)).slice(0, 200) } : null;
  const monitor = args.noBypass ? null : new Monitor({ proxyPort: port, installDir: exe ? installDir(exe) : null, nameRe: procRe, outDir, loopbackIsExternal, intervalMs: Number(process.env.KMDIAG_MONITOR_INTERVAL_MS) || 3000 });
  const session = {
    tool: `kiromask-capture ${VERSION}`, startedAt: new Date(startedAt).toISOString(), args: { ...args, env: Object.keys(args.env) },
    platform: { os: process.platform, arch: process.arch, release: os.release(), node: process.version },
    proxy: { host: '127.0.0.1', port, mode: args.mode, keyType: args.keyType, passthrough: args.passthrough },
    kiro: kiroInfo, systemProxy: await systemProxy(),
  };
  const writeSession = () => fs.writeFileSync(path.join(outDir, 'session.json'), JSON.stringify(session, null, 2));
  writeSession();

  say(`Kiro Mask capture ${VERSION} — recording to ${outDir}`);
  say(`Proxy listening on 127.0.0.1:${port} (${args.mode}, ${args.keyType} certificates)`);

  let child = null;
  if (monitor) {
    await monitor.tick();
    if (monitor.alive > 0 && !args.noLaunch && !args.force) {
      await recorder.close();
      throw new Error('Kiro is already running — it would ignore the proxy flags and nothing would be captured. Close Kiro completely first (or use --force).');
    }
  }

  if (!args.noLaunch) {
    const plan = buildLaunch({ exe, cli: cliInfo.cli, port, tlsMode: args.tlsMode, caCertPath: ca.certPath, caPin: ca.spkiPin, envProxyOn: args.envProxy, envCaBundles: args.envCaBundles, extraArgs: args.extraArgs, extraEnv: args.env });
    session.launch = { command: plan.command, args: plan.args, usedCliJs: !!plan.cli, environmentVariablesSet: plan.added };
    writeSession();
    say(`Kiro: ${exe}  (${found.via})`);
    if (found.alternatives?.length) say(`   (other candidates in that folder: ${found.alternatives.slice(0, 4).join(', ')} — use --exe to choose one)`);
    say(`   launcher: ${plan.cli ? `${plan.cli} (${cliInfo.via})` : 'none — starting the executable directly'}`);
    say(`Launching: ${plan.command}`);
    say(`   args: ${plan.args.join(' ')}`);
    say(`   env set: ${plan.added.join(', ')}`);
    child = spawn(plan.command, plan.args, { env: plan.env, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => console.error(`Could not start Kiro: ${e.message}`));
    say('');
    say('Now USE Kiro the way you normally do: sign in if needed, open a project, pick a model, send a chat message');
    say('(ideally one that triggers a tool call). Close Kiro when done, or press Ctrl+C here.');
    say('');
  } else {
    say('Start Kiro yourself with:');
    say(`  Kiro --proxy-server=127.0.0.1:${port} ${args.tlsMode === 'spki' ? `--ignore-certificate-errors-spki-list=${ca.spkiPin}` : '--ignore-certificate-errors'}`);
    say(`  (environment: NODE_EXTRA_CA_CERTS=${ca.certPath}${args.tlsMode === 'spki' ? '' : ' NODE_TLS_REJECT_UNAUTHORIZED=0 ELECTRON_IGNORE_CERTIFICATE_ERRORS=1'})`);
    say('Press Ctrl+C when done.');
  }

  if (monitor) {
    monitor.on('direct', (d) => { if (!args.quiet) console.log(`  ⚠ BYPASS: ${d.process} (pid ${d.pid}) → ${d.remote} directly, not through the proxy`); });
    monitor.on('error', () => {});
    monitor.start();
  }

  // wait for: Kiro exiting, Ctrl+C, or --duration
  const reason = await new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    process.once('SIGINT', () => finish('Ctrl+C'));
    process.once('SIGTERM', () => finish('SIGTERM'));
    monitor?.once('kiro-exited', () => finish('Kiro closed'));
    if (args.duration) setTimeout(() => finish(`${args.duration}s elapsed`), args.duration * 1000).unref?.();
    if (monitor && child) setTimeout(() => { if (!monitor.everSeen) console.error('  [warn] no Kiro process detected 45 s after launch — it may have failed to start or handed off to an existing instance'); }, 45_000).unref?.();
  });

  say(`\nStopping (${reason}) — writing results…`);
  monitor?.stop();
  if (monitor) await monitor.tick();
  await new Promise((r) => setTimeout(r, 400));
  await recorder.close();

  const snap = monitor?.snapshot() ?? null;
  const names = snap ? await reverseNames(snap.direct.map((d) => d.remoteIp)) : {};
  const forward = snap ? await forwardMap(recorder.conns.map((c) => c.host)) : {};
  session.endedAt = new Date().toISOString();
  session.endReason = reason;
  session.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const { data, markdown } = buildSummary({ conns: recorder.conns, flows: recorder.flows, monitor: snap, session, names, forward });
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(data, null, 2));
  if (snap) fs.writeFileSync(path.join(outDir, 'processes.json'), JSON.stringify(snap.processes, null, 2));
  if (!args.noLogs) {
    const logs = collectLogs(path.join(outDir, 'kiro-logs'), startedAt);
    session.kiroLogs = { root: logs.root, copied: logs.files.length, files: logs.files.slice(0, 100) };
  }
  writeSession();

  const archive = await tarGz(outDir, `${outDir}.tar.gz`, path.basename(outDir));
  const mb = (fs.statSync(archive).size / 1048576).toFixed(1);
  console.log('\n' + '─'.repeat(72));
  console.log(`Connections: ${data.totals.connections} (handshake failures: ${data.totals.handshakeFailures}) · requests: ${data.totals.flows} · hosts: ${data.totals.hosts}`);
  const top = data.hints.filter((h) => h.severity !== 'info').slice(0, 8);
  if (top.length) { console.log('\nKey findings:'); for (const h of top) console.log(`  • [${h.severity}] ${h.text}`); }
  console.log(`\nResults folder : ${outDir}`);
  console.log(`Send this file : ${archive} (${mb} MB)`);
  console.log(args.metaOnly ? '(metadata only: no request/response bodies were stored)' : 'It contains Kiro\'s requests/responses, i.e. your prompts and code. Credentials are redacted; use --meta-only to omit bodies.');
  console.log('─'.repeat(72));
  return { outDir, archive, data };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('capture.mjs')) {
  main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(`\nError: ${e.message}`); process.exit(1); });
}
