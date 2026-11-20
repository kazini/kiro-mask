// Locate and launch Kiro with the proxy wired in: run `Kiro.exe resources/app/out/cli.js` under
// ELECTRON_RUN_AS_NODE (VS Code's own launcher pattern) so the flags below reach the real Electron process.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { ROOT } from '../paths.mjs';
import { shortcutTargets } from './shortcut.mjs';

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

export function candidatePaths({ platform = process.platform, env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const out = [];
  if (platform === 'win32') {
    out.push(path.join(cwd, 'Kiro', 'Kiro.exe'), path.join(cwd, 'Kiro.exe'));
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'Kiro', 'Kiro.exe'));
    for (const k of ['ProgramFiles', 'ProgramFiles(x86)']) if (env[k]) out.push(path.join(env[k], 'Kiro', 'Kiro.exe'));
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', path.join(home, 'Applications')]) {
      for (const bin of ['Electron', 'Kiro']) out.push(path.join(base, 'Kiro.app', 'Contents', 'MacOS', bin));
    }
  } else {
    out.push('/usr/share/kiro/kiro', '/opt/Kiro/kiro', '/opt/kiro/kiro', path.join(home, '.local', 'share', 'kiro', 'kiro'), path.join(cwd, 'Kiro', 'kiro'));
  }
  return out;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const lower = (s) => String(s).toLowerCase();
const exeNames = (platform) => (platform === 'win32' ? ['kiro.exe'] : platform === 'darwin' ? ['electron', 'kiro'] : ['kiro']);

/** The Kiro executable directly inside `dir` (case-insensitive; on macOS also a Kiro.app bundle), or null. */
function exeInDir(dir, platform) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  if (platform === 'darwin') {
    const app = lower(dir).endsWith('.app') ? dir : entries.find((e) => lower(e) === 'kiro.app') && path.join(dir, entries.find((e) => lower(e) === 'kiro.app'));
    if (app) for (const bin of ['Electron', 'Kiro']) if (exists(path.join(app, 'Contents', 'MacOS', bin))) return path.join(app, 'Contents', 'MacOS', bin);
  }
  const hit = entries.find((e) => exeNames(platform).includes(lower(e)) && exists(path.join(dir, e)));
  return hit ? path.join(dir, hit) : null;
}

/**
 * Turn something a person might point at into the Kiro executable: the executable itself, the folder that contains it,
 * a Windows shortcut (.lnk) to either, or a symlink. `strict` (auto-detection) rejects files that are not named like Kiro.
 */
function resolveTarget(p, { platform, strict, depth = 0 }) {
  if (depth > 3) return null;
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (st.isDirectory()) return exeInDir(p, platform) ?? exeInDir(path.join(p, 'Kiro'), platform);
  if (/\.lnk$/i.test(p)) {
    for (const t of shortcutTargets(p, { platform })) { const r = resolveTarget(t, { platform, strict, depth: depth + 1 }); if (r) return r; }
    return null;
  }
  if (!st.isFile()) return null;
  return strict && !exeNames(platform).includes(lower(path.basename(p))) ? null : p;
}

/** Shortcuts and symlinks sitting directly in `dir`, those with "kiro" in their name first. */
function linksIn(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => (e.isFile() && /\.lnk$/i.test(e.name)) || e.isSymbolicLink())
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => Number(!/kiro/i.test(path.basename(a))) - Number(!/kiro/i.test(path.basename(b))) || a.localeCompare(b));
}

/**
 * Find the Kiro executable and say how it was found.
 *   1. the configured path (kiro.exe_path / --exe): the executable, its folder, or a shortcut to either; %VARS% and ~ are expanded.
 *      If it does not exist, everything below is tried anyway (and `skipped` tells you which path was ignored)
 *   2. the kiromask folder: Kiro.exe next to it (kiromask copied INTO the Kiro folder), a Kiro folder inside it,
 *      or a shortcut (.lnk) / symlink to Kiro.exe or to the Kiro folder
 *   3. the folders ABOVE kiromask (kiromask placed inside the Kiro folder, e.g. Kiro/kiromask)
 *   4. the usual install locations, then PATH
 * @returns {{exe: string|null, via: string|null, searched: string[], skipped?: string}}
 */
export function locateKiro(configured, opts = {}) {
  if (!configured) return autoDetect(opts, []);
  const platform = opts.platform || process.platform;
  const abs = path.resolve(expandPath(configured, { env: opts.env ?? process.env, home: opts.home ?? os.homedir(), platform }));
  const exe = resolveTarget(abs, { platform, strict: false });
  if (exe) return { exe, via: exe === abs ? 'kiro.exe_path' : `kiro.exe_path → ${path.basename(abs)}`, searched: [abs] };
  // The configured path is not usable (moved, uninstalled, another PC): try every other method instead of giving up.
  return { ...autoDetect(opts, [abs]), skipped: abs };
}

/** `%LOCALAPPDATA%`-style variables and a leading `~`, so one config line works for every user. Unknown variables stay as written. */
function expandPath(p, { env, home, platform }) {
  const find = (n) => Object.keys(env).find((k) => (platform === 'win32' ? lower(k) === lower(n) : k === n));
  return String(p).replace(/%([^%\\/]+)%/g, (m, n) => (find(n) ? env[find(n)] : m)).replace(/^~(?=$|[\\/])/, home);
}

function autoDetect(opts, searched) {
  const platform = opts.platform || process.platform;
  const root = opts.root ?? ROOT;
  const cwd = opts.cwd ?? process.cwd();
  const dirs = [...new Set([root, cwd])];
  for (const d of dirs) {
    searched.push(d);
    let exe = exeInDir(d, platform);
    if (exe) return { exe, via: 'kiromask is inside the Kiro folder', searched };
    exe = exeInDir(path.join(d, 'Kiro'), platform);
    if (exe) return { exe, via: 'Kiro folder inside the kiromask folder', searched };
    for (const link of linksIn(d)) {
      exe = resolveTarget(link, { platform, strict: true });
      if (exe) return { exe, via: `shortcut ${path.basename(link)}`, searched };
    }
  }
  let up = path.dirname(root);
  for (let i = 0; i < 6 && up !== path.dirname(up); i++, up = path.dirname(up)) {
    searched.push(up);
    const exe = exeInDir(up, platform);
    if (exe) return { exe, via: 'kiromask is inside the Kiro folder', searched };
  }
  for (const c of candidatePaths({ ...opts, platform, cwd })) if (exists(c)) return { exe: c, via: 'standard install location', searched };
  if (platform !== 'win32') {
    try {
      const w = execFileSync('which', ['kiro'], { encoding: 'utf8' }).trim();
      if (w) { const real = fs.realpathSync(w); if (exists(real)) return { exe: real, via: 'PATH', searched }; }
    } catch { /* not on PATH */ }
  }
  return { exe: null, via: null, searched };
}

/** Same as locateKiro(), just the path. */
export const findKiroExe = (configured, opts = {}) => locateKiro(configured, opts).exe;

/** Where VS Code-style cli.js lives relative to the executable. */
export function findCliJs(exe) {
  const dir = path.dirname(exe);
  return [path.join(dir, 'resources', 'app', 'out', 'cli.js'), path.join(dir, '..', 'Resources', 'app', 'out', 'cli.js')].find(exists) || null;
}

/**
 * Build the spawn command. `tlsMode`:
 *   permissive → ignore all certificate errors (inside this Kiro process only)
 *   pinned     → accept only certificates chaining to our CA
 */
export function buildLaunchPlan({ exe, port, host = '127.0.0.1', tlsMode = 'permissive', caCertPath, caPin, extraArgs = [], extraEnv = {}, baseEnv = process.env }) {
  const cli = findCliJs(exe);
  const env = { ...baseEnv, VSCODE_DEV: '', ...extraEnv };
  if (caCertPath) env.NODE_EXTRA_CA_CERTS = caCertPath;
  const flags = [`--proxy-server=${host}:${port}`];
  if (tlsMode === 'pinned') {
    flags.unshift(`--ignore-certificate-errors-spki-list=${caPin}`);
  } else {
    flags.unshift('--ignore-certificate-errors');
    env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    env.ELECTRON_IGNORE_CERTIFICATE_ERRORS = '1';
  }
  if (cli) {
    env.ELECTRON_RUN_AS_NODE = '1';
    return { command: exe, args: [cli, ...flags, ...extraArgs], env, cli };
  }
  delete env.ELECTRON_RUN_AS_NODE; // no wrapper available: start the app directly
  return { command: exe, args: [...flags, ...extraArgs], env, cli: null };
}

export function launch(plan, { onExit } = {}) {
  const child = spawn(plan.command, plan.args, { env: plan.env, stdio: 'ignore', detached: false, windowsHide: false });
  child.on('exit', (code) => onExit?.(code));
  child.on('error', (e) => onExit?.(null, e));
  return child;
}

/** Is any Kiro process alive? (no dependencies: tasklist / ps) */
export function isKiroRunning(platform = process.platform) {
  return new Promise((resolve) => {
    const [cmd, args] = platform === 'win32'
      ? ['tasklist', ['/FI', 'IMAGENAME eq Kiro.exe', '/FO', 'CSV', '/NH']]
      : ['ps', ['-A', '-o', 'comm=']];
    execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null); // unknown
      resolve(platform === 'win32' ? /"Kiro\.exe"/i.test(stdout) : stdout.split('\n').some((l) => /(^|\/)kiro( helper.*)?$/i.test(l.trim())));
    });
  });
}

/** Resolve once Kiro has appeared and then fully exited. */
export async function waitForKiroExit({ appearTimeoutMs = 30_000, pollMs = 2000, isRunning = isKiroRunning, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal } = {}) {
  const t0 = Date.now();
  let seen = false;
  while (!signal?.aborted) {
    const r = await isRunning();
    if (r === true) seen = true;
    else if (r === false && seen) return 'exited';
    else if (r === false && !seen && Date.now() - t0 > appearTimeoutMs) return 'never-started';
    await sleep(pollMs);
  }
  return 'aborted';
}

/** Start helper processes (e.g. a local OpenAI-compatible gateway) and return a stop function. */
export function startCompanions(list, log) {
  const children = [];
  for (const c of list || []) {
    if (!c?.command || c.enabled === false) continue;
    try {
      const child = spawn(c.command, c.args || [], { cwd: c.cwd, env: { ...process.env, ...(c.env || {}) }, stdio: 'ignore', windowsHide: true });
      child.on('error', (e) => log('warn', `companion "${c.name || c.command}" failed: ${e.message}`));
      child.on('exit', (code) => log('debug', `companion "${c.name || c.command}" exited (${code})`));
      children.push(child);
      log('info', `started companion "${c.name || c.command}" (pid ${child.pid})`);
    } catch (e) {
      log('warn', `companion "${c.name || c.command}" failed: ${e.message}`);
    }
  }
  return () => { for (const ch of children) { try { ch.kill(); } catch { /* gone */ } } };
}
