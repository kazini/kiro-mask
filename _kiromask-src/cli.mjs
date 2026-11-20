import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createLogger, openLogFile } from './log.mjs';
import { App } from './app.mjs';
import { resolveDataDir } from './paths.mjs';
import { tarGz } from './debug/tar.mjs';
import { loadConfig, findConfigFile, watchConfig } from './config/load.mjs';
import { locateKiro, buildLaunchPlan, launch, isKiroRunning, waitForKiroExit, startCompanions } from './launcher/kiro.mjs';
import { endpointFor, headersFor } from './providers/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_META = Object.freeze({ name: 'kiromask', version: '2.1' });

const HELP = ({ name, version }) => `${name} ${version} — use any OpenAI/Anthropic-compatible model in the Kiro IDE

Usage:
  kiromask [run] [options]     start the proxy and launch Kiro (default)
  kiromask check [--ping]      validate the config and list providers/models
  kiromask init                write an example config to ./kiromask.config.yaml
  kiromask ca                  print the local CA certificate path
  kiromask pack                bundle the latest log + capture + config summary into ONE .tar.gz to send for support
  kiromask capture [options]   record everything Kiro does, with the standalone capture tool (_kiromask_diag-n-test/capture.mjs)
  kiromask doctor [options]    test your environment and proxy compatibility (_kiromask_diag-n-test/doctor.mjs)

Options:
  -c, --config <file>   config file (default: ./kiromask.config.yaml)
  -p, --port <n>        proxy port (overrides config)
      --exe <path>      Kiro executable (overrides config / auto-detection)
      --no-launch       only run the proxy; print how to start Kiro yourself
      --force           launch even if Kiro is already running
      --data-dir <dir>  where logs, captures, the local CA and caches go (default: ./data inside the kiromask folder;
                        also $KIROMASK_HOME or \`data_dir\` in the config)
  -v, --verbose         debug logging
  -h, --help            show this help
`;

export function parseArgs(argv) {
  const o = { cmd: 'run', ping: false };
  // capture / doctor hand every remaining argument to the diagnostic tool untouched
  if (['capture', 'doctor'].includes(argv[0])) return { ...o, cmd: argv[0], rest: argv.slice(1), help: false };
  const need = (i, name) => { if (i + 1 >= argv.length) throw new Error(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['run', 'check', 'init', 'ca', 'pack'].includes(a) && i === 0) o.cmd = a;
    else if (a === '-c' || a === '--config') o.config = need(i++, a);
    else if (a === '-p' || a === '--port') { o.port = Number(need(i++, a)); if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('invalid port'); }
    else if (a === '--exe') o.exe = need(i++, a);
    else if (a === '--data-dir') o.dataDir = need(i++, a);
    else if (a === '--no-launch') o.noLaunch = true;
    else if (a === '--force') o.force = true;
    else if (a === '--ping') o.ping = true;
    else if (a === '-v' || a === '--verbose') o.verbose = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--version') o.version = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function describeConfig(cfg, log) {
  for (const w of cfg.warnings) log('warn', w);
  const byProv = new Map();
  for (const m of cfg.customModels) (byProv.get(m.provider.name) ?? byProv.set(m.provider.name, []).get(m.provider.name)).push(m);
  if (!byProv.size) log('warn', 'no custom models configured — only Kiro\'s own models will be available');
  for (const [name, models] of byProv) {
    const p = models[0].provider;
    log('info', `provider ${name} (${p.type}) ${p.apiBase} — ${models.length} model(s): ${models.map((m) => m.id).join(', ')}`);
  }
}

async function ping(cfg, log) {
  for (const p of cfg.providers.values()) {
    const entry = [...cfg.models.values()].find((m) => m.provider === p);
    if (!entry) continue;
    const url = `${p.apiBase}/models`;
    try {
      const res = await fetch(url, { headers: headersFor(entry, { stream: false }), signal: AbortSignal.timeout(8000) });
      log(res.ok ? 'info' : 'warn', `ping ${p.name}: GET ${url} → HTTP ${res.status}`);
    } catch (e) { log('error', `ping ${p.name}: ${e.cause?.code || e.message}`); }
  }
}

const NOT_FOUND = (k) => `Kiro executable not found${k.searched?.length ? ` (looked in: ${k.searched.join(', ')})` : ''} — set kiro.exe_path in the config (the exe, its folder or a shortcut), pass --exe, or put a shortcut to Kiro in the kiromask folder`;
const SKIPPED = (k) => `kiro.exe_path "${k.skipped}" does not exist${k.exe ? ` — using ${k.exe} (${k.via}) instead` : ' — tried auto-detection too'}`;

/** Run one of the standalone diagnostic tools from _kiromask_diag-n-test/ with the same Node. */
function runDiag(script, args, log) {
  const file = path.join(ROOT, '_kiromask_diag-n-test', script);
  if (!fs.existsSync(file)) throw new Error(`${script} not found (expected ${file}); the _kiromask_diag-n-test folder is optional and may have been removed`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: 'inherit' });
    child.on('error', (e) => { log('error', `could not start ${script}: ${e.message}`); resolve(1); });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const newest = (dir, filter = () => true) => {
  try { return fs.readdirSync(dir).filter(filter).sort().map((f) => path.join(dir, f)).at(-1) ?? null; } catch { return null; }
};

/** kiromask pack: one archive with everything needed to understand a problem. No keys, no credentials. */
async function pack({ cfg, file, dataDir, log, version }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const work = path.join(dataDir, `kiromask-report-${stamp}`);
  fs.mkdirSync(work, { recursive: true });
  const added = [];
  const logFile = newest(path.join(dataDir, 'logs'), (f) => f.endsWith('.log'));
  if (logFile) { fs.copyFileSync(logFile, path.join(work, path.basename(logFile))); added.push(`log ${path.basename(logFile)}`); }
  const cap = newest(path.join(dataDir, 'captures'), (f) => fs.statSync(path.join(dataDir, 'captures', f)).isDirectory());
  if (cap) { fs.cpSync(cap, path.join(work, 'capture', path.basename(cap)), { recursive: true }); added.push(`capture ${path.basename(cap)}`); }
  fs.writeFileSync(path.join(work, 'environment.json'), JSON.stringify({
    kiromask: version, node: process.version, platform: `${process.platform}/${process.arch}`, os: os.release(), config: file ?? null,
    options: { tls: cfg.get('tls.mode'), kiro_endpoint: cfg.get('kiro_endpoint'), session_title: cfg.get('session_title'), debug: cfg.get('debug') },
    providers: [...cfg.providers.values()].map((p) => ({ name: p.name, type: p.type, apiBase: p.apiBase, hasKey: !!p.apiKey, models: cfg.customModels.filter((m) => m.provider === p).map((m) => m.id) })),
    warnings: cfg.warnings,
  }, null, 2));
  const archive = await tarGz(work, `${work}.tar.gz`, path.basename(work));
  fs.rmSync(work, { recursive: true, force: true });
  log('info', `report: ${archive}`);
  log('info', `contains: ${added.join(', ') || '(no log or capture found yet — run kiromask first)'}${cap ? '' : '; enable debug.capture_traffic to include Kiro traffic'}`);
  log('info', 'capture files hold your prompts and code (credentials are redacted); review before sharing');
}

export async function main(argv, meta = DEFAULT_META) {
  const { name, version } = meta;
  const args = parseArgs(argv);
  if (args.help) return console.log(HELP(meta));
  if (args.version) return console.log(version);
  const log = createLogger({ level: args.verbose ? 'debug' : 'info' });

  if (args.cmd === 'init') {
    const dest = path.resolve('kiromask.config.yaml');
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
    fs.copyFileSync(path.join(ROOT, 'kiromask.config.example.yaml'), dest);
    return log('info', `wrote ${dest} — edit it, then run: kiromask`);
  }

  const file = findConfigFile(args.config);
  if (args.config && !fs.existsSync(file)) throw new Error(`config file not found: ${file}`);
  const cfg = loadConfig(file);
  if (cfg.get('debug.verbose')) log.setLevel('debug');
  if (args.port !== undefined) cfg.raw.proxy.port = args.port;
  const data = resolveDataDir({ cli: args.dataDir, config: cfg.get('data_dir') });
  const dataDir = data.dir;
  const openLog = (c = cfg) => {
    if (!c.get('debug.log_file')) return;
    try { log.attachFile(openLogFile(path.join(dataDir, 'logs'), { keep: c.get('debug.log_keep') })); } catch (e) { log('warn', `cannot write a log file in ${dataDir}: ${e.message}`); }
  };

  if (args.cmd === 'capture' || args.cmd === 'doctor') {
    const rest = [...args.rest];
    const has = (f) => rest.some((a) => a === f || a.startsWith(`${f}=`));
    if (args.cmd === 'capture') {
      const exe = cfg.get('kiro.exe_path');
      if (exe && !has('--exe')) rest.push('--exe', String(exe));          // the same Kiro your config points at
      if (!has('--out')) rest.push('--out', path.join(dataDir, 'captures', `diag-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}`));
    } else if (!has('--out')) rest.push('--out', path.join(dataDir, 'doctor', `kiromask-doctor-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}`));
    process.exitCode = await runDiag(`${args.cmd}.mjs`, rest, log);
    return;
  }
  if (args.cmd === 'pack') return pack({ cfg, file, dataDir, log, version });

  if (args.cmd === 'ca') {
    const { CertAuthority } = await import('./tls/ca.mjs');
    const ca = new CertAuthority({ dir: path.join(dataDir, 'ca') });
    ca.init();
    return console.log(ca.certPath);
  }
  if (args.cmd === 'check') {
    log('info', file ? `config: ${file}` : 'no config file found (using defaults) — run "kiromask init"');
    describeConfig(cfg, log);
    const kiro = locateKiro(args.exe || cfg.get('kiro.exe_path'));
    const exe = kiro.exe;
    if (kiro.skipped) log('warn', SKIPPED(kiro));
    log(exe ? 'info' : 'warn', exe ? `Kiro found: ${exe}${kiro.via ? ` (${kiro.via})` : ''}` : NOT_FOUND(kiro));
    if (args.ping) await ping(cfg, log);
    return;
  }

  // ── run ──
  openLog();
  log('info', `${name} ${version} · config: ${file ?? '(defaults)'}`);
  log('info', `data: ${dataDir}${data.source === 'default' ? '' : ` (from ${data.source})`}${log.logFile() ? ` · log: ${log.logFile()}` : ' · log file: off'}`);
  if (data.fellBack) log('warn', `the data folder is not writable, using ${dataDir} instead — set data_dir in the config or pass --data-dir`);
  describeConfig(cfg, log);
  const app = new App({ config: cfg, log, dataDir, version });
  const info = await app.start().catch((e) => { throw new Error(e.code === 'EADDRINUSE' ? `port ${cfg.get('proxy.port')} is already in use (another kiromask running?)` : e.message); });
  log('info', `proxy listening on ${info.host}:${info.port} · intercepting ${cfg.get('proxy.intercept_hosts').join(', ')}`);
  log('info', cfg.get('debug.capture_traffic') ? `capture: ON → ${path.join(dataDir, 'captures')} (every request Kiro makes is recorded; files contain your prompts and code)` : 'capture: off (debug.capture_traffic)');
  const ke = cfg.get('kiro_endpoint');
  log('info', `kiro models: ${ke.models ? 'shown' : 'hidden'} · telemetry: ${ke.telemetry ? 'allowed' : 'blocked'} · updates: ${ke.updates ? 'allowed' : 'blocked'}${ke.auth_fake_login ? ' · FAKE LOGIN' : ''}`);

  const stopWatch = watchConfig(file, cfg, {
    onChange: (next) => {
      if (args.port !== undefined) next.raw.proxy.port = args.port;
      app.setConfig(next);
      log.setLevel(next.get('debug.verbose') ? 'debug' : 'info');
      if (next.get('debug.log_file') && !log.logFile()) openLog(next); else if (!next.get('debug.log_file') && log.logFile()) log.detachFile();
      log('info', `config reloaded (${next.customModels.length} custom models${next.get('debug.capture_traffic') ? ', capture on' : ''})`);
      for (const w of next.warnings) log('warn', w);
      if (next.get('proxy.port') !== info.port && next.get('proxy.port') !== 0) log('warn', 'proxy.port changed — restart kiromask to apply');
    },
    onError: (e) => log('error', `config reload failed, keeping previous config: ${e.message}`),
  });
  const stopCompanions = startCompanions(cfg.get('launch.companions'), log);

  let shuttingDown = false;
  const shutdown = async (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `shutting down (${why})`);
    stopWatch(); stopCompanions();
    const t = app.usage.totals;
    if (t.requests) log('info', `session: ${t.requests} custom request(s), ${t.prompt} prompt + ${t.completion} completion tokens`);
    const captured = await app.stop();
    if (captured) log('info', `capture saved: ${captured}`);
    if (log.logFile()) log('info', `log saved: ${log.logFile()}`);
    log.detachFile();
    process.exit(0);
  };
  // A bug in a rarely-used path must not take the proxy (and your session) down.
  process.on('uncaughtException', (e) => log('error', `unexpected error (continuing): ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log('error', `unhandled rejection (continuing): ${e?.stack || e}`));
  process.on('SIGINT', () => shutdown('Ctrl+C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const kiro = locateKiro(args.exe || cfg.get('kiro.exe_path'));
  const exe = kiro.exe;
  const plan = exe && buildLaunchPlan({
    exe, port: info.port, host: info.host, tlsMode: cfg.get('tls.mode'), caCertPath: info.caCertPath, caPin: info.caPin,
    extraArgs: cfg.get('kiro.args') || [], extraEnv: cfg.get('kiro.env') || {},
  });

  if (args.noLaunch || !exe) {
    if (!args.noLaunch) log('warn', NOT_FOUND(kiro));
    log('info', 'start Kiro yourself with:');
    const flags = cfg.get('tls.mode') === 'pinned' ? `--ignore-certificate-errors-spki-list=${info.caPin}` : '--ignore-certificate-errors';
    console.log(`  Kiro --proxy-server=${info.host}:${info.port} ${flags}`);
    if (cfg.get('tls.mode') !== 'pinned') console.log('  (environment: NODE_TLS_REJECT_UNAUTHORIZED=0 ELECTRON_IGNORE_CERTIFICATE_ERRORS=1)');
    return; // keep serving
  }

  if (!args.force && !cfg.get('launch.allow_running') && (await isKiroRunning()) === true) {
    log('error', 'Kiro is already running — it would ignore the proxy settings. Close it first (or use --force).');
    return shutdown('Kiro already running');
  }
  if (!plan.cli) log('warn', 'cli.js not found next to Kiro; launching the app directly');
  log('info', `launching ${exe}`);
  const child = launch(plan, { onExit: (code, err) => { if (err) { log('error', `could not start Kiro: ${err.message}`); shutdown('launch failed'); } } });
  log('info', `Kiro started (pid ${child.pid}) — TLS mode: ${cfg.get('tls.mode')}`);

  if (cfg.get('launch.exit_with_kiro')) {
    const r = await waitForKiroExit();
    if (r === 'never-started') log('warn', 'could not detect a running Kiro; staying up (Ctrl+C to quit)');
    else await shutdown(r === 'exited' ? 'Kiro closed' : r);
  }
}
