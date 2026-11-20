// Find a Kiro installation, read its (non-sensitive) version info, list bundled executables, find its logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { redactText } from './redact.mjs';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

export function candidatePaths({ platform = process.platform, env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  if (platform === 'win32') {
    return [path.join(cwd, 'Kiro', 'Kiro.exe'), path.join(cwd, 'Kiro.exe'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Kiro', 'Kiro.exe'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Kiro', 'Kiro.exe'), env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Kiro', 'Kiro.exe')].filter(Boolean);
  }
  if (platform === 'darwin') return ['/Applications', path.join(home, 'Applications')].flatMap((b) => ['Electron', 'Kiro'].map((n) => path.join(b, 'Kiro.app', 'Contents', 'MacOS', n)));
  return ['/usr/share/kiro/kiro', '/opt/Kiro/kiro', '/opt/kiro/kiro', path.join(home, '.local', 'share', 'kiro', 'kiro'), path.join(cwd, 'Kiro', 'kiro')];
}

export function findKiroExe(explicit, opts = {}) {
  if (explicit) return isFile(explicit) ? path.resolve(explicit) : null;
  return candidatePaths(opts).find(isFile) || null;
}

export const appDir = (exe) => [path.join(path.dirname(exe), 'resources', 'app'), path.join(path.dirname(exe), '..', 'Resources', 'app')].find(isDir) || null;
export const findCliJs = (exe) => { const a = appDir(exe); return a && isFile(path.join(a, 'out', 'cli.js')) ? path.join(a, 'out', 'cli.js') : null; };
export const installDir = (exe) => (exe ? path.dirname(exe) : null);

/** Safe subset of version metadata (never copies keys or endpoints from product.json). */
export function readVersions(exe) {
  const a = appDir(exe);
  const out = { exe, appDir: a };
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(a, f), 'utf8')); } catch { return null; } };
  if (a) {
    const prod = read('product.json'), pkg = read('package.json');
    if (prod) Object.assign(out, { product: Object.fromEntries(['nameShort', 'nameLong', 'applicationName', 'version', 'kiroVersion', 'commit', 'date', 'quality', 'electronVersion'].filter((k) => prod[k] !== undefined).map((k) => [k, prod[k]])) });
    if (pkg) out.package = Object.fromEntries(['name', 'version', 'main'].filter((k) => pkg[k] !== undefined).map((k) => [k, pkg[k]]));
  }
  return out;
}

/** Names of executables/native binaries shipped with Kiro (candidates for clients that ignore Chromium's proxy flag). */
export function listExecutables(dir, { depth = 5, max = 300 } = {}) {
  const out = [];
  const EXE = /\.(exe|dll|node|so|dylib)$|^[^.]+$/i;
  const walk = (d, lvl) => {
    if (lvl > depth || out.length >= max) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(locales|node_modules\.asar|\.git)$/.test(e.name)) walk(full, lvl + 1); }
      else if (EXE.test(e.name) && !/\.(dll|so|dylib)$/.test(e.name)) {
        try { const st = fs.statSync(full); if (/\.(exe|node)$/i.test(e.name) || (st.mode & 0o111 && st.size > 100_000)) out.push({ path: path.relative(dir, full).split(path.sep).join('/'), bytes: st.size }); } catch { /* ignore */ }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function logsRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, 'Kiro', 'logs') : null;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Kiro', 'logs');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Kiro', 'logs');
}

/** Copy the tail of Kiro log files touched since `sinceMs` into destDir (credentials scrubbed). */
export function collectLogs(destDir, sinceMs, { root = logsRoot(), perFile = 300_000, total = 8_000_000 } = {}) {
  const result = { root, files: [], skipped: 0 };
  if (!root || !isDir(root)) return result;
  let used = 0;
  const files = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(log|txt|json)$/i.test(e.name)) { const st = fs.statSync(full); if (st.mtimeMs >= sinceMs - 60_000) files.push({ full, st }); }
    }
  };
  try { walk(root, 0); } catch { /* unreadable */ }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  for (const { full, st } of files) {
    if (used >= total) { result.skipped++; continue; }
    try {
      const fd = fs.openSync(full, 'r');
      const len = Math.min(st.size, perFile);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const rel = path.relative(root, full);
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, redactText(buf.toString('utf8')));
      used += len;
      result.files.push({ file: rel.split(path.sep).join('/'), bytes: len, truncated: st.size > perFile });
    } catch { result.skipped++; }
  }
  return result;
}

// ── resolving what the user typed for --exe ─────────────────────────────────

/** Strip pasted quotes, expand ~ / %VAR% / $VAR / ${VAR}, make absolute. */
export function expandPath(input, { env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  let p = String(input).trim();
  p = p.replace(/^["'\u201c\u2018]+/, '').replace(/["'\u201d\u2019]+$/, ''); // quotes pasted in, or a stray one from a trailing backslash ("C:\dir\")
  p = p.replace(/%([^%]+)%/g, (m, n) => env[n] ?? env[Object.keys(env).find((k) => k.toLowerCase() === n.toLowerCase())] ?? m);
  p = p.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => env[a || b] ?? m);
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(1));
  return path.resolve(cwd, p);
}

/** Resolve a Windows .lnk shortcut to its target (PowerShell + WScript.Shell). */
export function resolveLnk(file) {
  return new Promise((resolve) => {
    const script = `(New-Object -ComObject WScript.Shell).CreateShortcut('${file.replace(/'/g, "''")}').TargetPath`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

const exeNamesFor = (platform) => (platform === 'win32' ? ['Kiro.exe', 'kiro.exe'] : platform === 'darwin' ? ['Electron', 'Kiro', 'kiro'] : ['kiro', 'Kiro']);

function looksExecutable(file, platform) {
  if (platform === 'win32') return /\.exe$/i.test(file);
  try { return (fs.statSync(file).mode & 0o111) !== 0 && fs.statSync(file).size > 100_000; } catch { return false; }
}

/** Find an executable inside a folder the user pointed at (an install dir, a .app bundle, a parent of either). */
function searchFolder(dir, platform) {
  const hits = [];
  const add = (f) => { if (isFile(f) && !hits.includes(f)) hits.push(f); };
  for (const n of exeNamesFor(platform)) add(path.join(dir, n));
  if (/\.app$/i.test(dir) || isDir(path.join(dir, 'Contents', 'MacOS'))) {
    for (const n of exeNamesFor('darwin')) add(path.join(dir, 'Contents', 'MacOS', n));
    try { for (const e of fs.readdirSync(path.join(dir, 'Contents', 'MacOS'))) add(path.join(dir, 'Contents', 'MacOS', e)); } catch { /* none */ }
  }
  for (const sub of ['Kiro', 'kiro', 'bin', path.join('Programs', 'Kiro')]) for (const n of exeNamesFor(platform)) add(path.join(dir, sub, n));
  if (!hits.length) { // any executable whose name mentions kiro, up to two levels down
    const walk = (d, depth) => {
      if (depth > 2) return;
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && !/^(node_modules|locales|resources)$/i.test(e.name)) walk(full, depth + 1);
        else if (e.isFile() && /kiro/i.test(e.name) && looksExecutable(full, platform) && !/(uninst|update|crash|helper|cli)/i.test(e.name)) add(full);
      }
    };
    walk(dir, 0);
  }
  return hits;
}

/**
 * Work out which executable the user means. Accepts: nothing (auto-detect), the file, an install folder,
 * a macOS .app bundle, a Windows .lnk shortcut; quotes, ~, %VAR% and $VAR are handled.
 * @returns {Promise<{exe: string|null, via: string, input?: string, resolved?: string, alternatives?: string[], tried: string[], hint?: string}>}
 */
export async function resolveKiroExe(input, { platform = process.platform, env = process.env, cwd = process.cwd(), home = os.homedir(), lnkResolver = resolveLnk } = {}) {
  const fromEnv = env.KIRO_EXE || env.KIROMASK_KIRO_EXE;
  const given = input || fromEnv;
  if (!given) {
    const tried = candidatePaths({ platform, env, cwd, home });
    const exe = tried.find(isFile);
    return exe ? { exe, via: 'auto-detected', tried } : { exe: null, via: 'auto-detect', tried, hint: 'Kiro was not found in the usual places. Pass --exe "<path to Kiro.exe or its folder>" (or set KIRO_EXE).' };
  }
  const via = input ? '--exe' : (env.KIRO_EXE ? 'KIRO_EXE' : 'KIROMASK_KIRO_EXE');
  let p = expandPath(given, { env, home, cwd });
  const tried = [p];
  if (platform === 'win32' && !isFile(p) && !isDir(p) && isFile(`${p}.exe`)) { p = `${p}.exe`; tried.push(p); }
  if (isFile(p) && /\.lnk$/i.test(p) && platform === 'win32') {
    const target = await lnkResolver(p);
    if (!target) return { exe: null, via, input: given, resolved: p, tried, hint: 'This is a shortcut (.lnk) and its target could not be read. Right-click it → Properties → copy "Target" and pass that to --exe.' };
    tried.push(target);
    p = target;
  }
  if (isFile(p)) return { exe: p, via, input: given, resolved: p, tried };
  if (isDir(p)) {
    const hits = searchFolder(p, platform);
    if (hits.length) return { exe: hits[0], via: `${via} (folder)`, input: given, resolved: p, alternatives: hits.slice(1), tried: [...tried, ...hits] };
    return { exe: null, via, input: given, resolved: p, tried, hint: `That folder exists but no Kiro executable was found in it (looked for ${exeNamesFor(platform).join(', ')} and any "*kiro*" program up to two levels down). Pass the executable itself.` };
  }
  // does not exist: suggest what is near it
  let near = [];
  try { near = fs.readdirSync(path.dirname(p)).filter((n) => /kiro/i.test(n) || n.toLowerCase().startsWith(path.basename(p).toLowerCase().slice(0, 3))).slice(0, 8); } catch { /* parent missing too */ }
  const parentExists = isDir(path.dirname(p));
  return { exe: null, via, input: given, resolved: p, tried, hint: `${parentExists ? `The folder exists but has no "${path.basename(p)}"${near.length ? ` — did you mean: ${near.join(', ')}?` : '.'}` : `Neither the file nor its folder exists (${path.dirname(p)}).`}` };
}

/** One readable block explaining a failed resolution. */
export function explainMissing(r) {
  const lines = [r.input ? `Could not use ${r.via} "${r.input}"${r.resolved && r.resolved !== r.input ? ` (resolved to ${r.resolved})` : ''}.` : 'Kiro executable not found.'];
  if (r.hint) lines.push(r.hint);
  if (!r.input && r.tried?.length) lines.push(`Looked in: ${r.tried.slice(0, 6).join(' ; ')}`);
  lines.push('Tips: put the path in double quotes if it has spaces; in cmd/PowerShell do not end a quoted path with a backslash ("C:\\Kiro\\" breaks quoting — drop the final \\); `--exe=PATH` also works; you can give the install folder instead of the .exe.');
  return lines.join('\n');
}

/** Locate cli.js: explicit override, else the standard place; `noCli` forces a direct launch. */
export function resolveCli(exe, { cliOverride = null, noCli = false } = {}) {
  if (noCli) return { cli: null, via: '--no-cli' };
  if (cliOverride) { const p = path.resolve(String(cliOverride).replace(/^["']|["']$/g, '')); return isFile(p) ? { cli: p, via: '--cli' } : { cli: null, via: '--cli', error: `--cli file not found: ${p}` }; }
  const c = exe ? findCliJs(exe) : null;
  return { cli: c, via: c ? 'standard location' : 'not found' };
}
