// Process and TCP-connection inspection without dependencies, for every platform.
// The parse* functions are pure (tested against sample output); list* call the OS.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

export const run = (cmd, args = [], { timeout = 15000 } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
  });

// ── address helpers ──
export function splitAddr(a) {
  const m = /^\[?([^\]]*?)\]?:(\d+|\*)$/.exec(String(a).trim());
  return m ? { ip: m[1], port: m[2] === '*' ? 0 : Number(m[2]) } : { ip: String(a), port: 0 };
}
export const isLoopback = (ip) => /^(127\.|::1$|0:0:0:0:0:0:0:1$|::ffff:127\.)/.test(ip) || ip === 'localhost';

// ── processes ──
export function parseTasklistCsv(text) {
  return String(text).split(/\r?\n/).map((l) => /^"([^"]*)","(\d+)"/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[2]), ppid: null, name: m[1], exe: null, cmd: null }));
}
export function parseCimJson(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  return (Array.isArray(j) ? j : [j]).filter(Boolean).map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: p.Name || '', exe: p.ExecutablePath || null, cmd: null }));
}
export function parsePs(text) {
  return String(text).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].split('/').pop(), exe: m[4].split(' ')[0] || null, cmd: m[4] }));
}

function listProcessesProc() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const rest = stat.slice(close + 2).split(' ');
      const read = (f) => { try { return fs.readFileSync(`/proc/${d}/${f}`, 'utf8'); } catch { return ''; } };
      let exe = null; try { exe = fs.readlinkSync(`/proc/${d}/exe`); } catch { /* permission */ }
      out.push({ pid: Number(d), ppid: Number(rest[1]), name: read('comm').trim(), exe, cmd: read('cmdline').replace(/\0/g, ' ').trim() });
    } catch { /* process vanished */ }
  }
  return out;
}

export async function listProcesses(platform = process.platform) {
  if (platform === 'win32') {
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress'], { timeout: 25000 });
    const parsed = ps ? parseCimJson(ps) : [];
    if (parsed.length) return parsed;
    return parseTasklistCsv((await run('tasklist', ['/FO', 'CSV', '/NH'])) || '');
  }
  if (platform === 'linux' && fs.existsSync('/proc/self/stat')) return listProcessesProc();
  return parsePs((await run('ps', ['-axo', 'pid=,ppid=,comm=,args='])) || '');
}

/** PIDs that belong to Kiro: by name, by executable under the install dir, plus all descendants. */
export function kiroPids(procs, { installDir = null, selfPid = process.pid, nameRe = /kiro/i } = {}) {
  const dir = installDir ? installDir.toLowerCase() : null;
  const seeds = procs.filter((p) => p.pid !== selfPid && (nameRe.test(p.name || '') || (dir && ((p.exe || '').toLowerCase().startsWith(dir) || (p.cmd || '').toLowerCase().includes(dir)))));
  const set = new Set(seeds.map((p) => p.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs) if (p.pid !== selfPid && !set.has(p.pid) && p.ppid && set.has(p.ppid)) { set.add(p.pid); grew = true; }
  }
  return set;
}

// ── connections ──
export function parseNetstatWin(text) {
  const out = [];
  for (const l of String(text).split(/\r?\n/)) {
    const c = l.trim().split(/\s+/);
    if (c[0] === 'TCP' && c.length >= 5) out.push({ local: c[1], remote: c[2], state: c[3], pid: Number(c[4]) });
  }
  return out;
}
export function parseSs(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = /^(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s*(.*)$/.exec(l.trim());
    if (!m || /^State$/i.test(m[1])) continue;
    const pid = /pid=(\d+)/.exec(m[4]);
    out.push({ local: m[2], remote: m[3], state: m[1].toUpperCase().replace('ESTAB', 'ESTABLISHED'), pid: pid ? Number(pid[1]) : null });
  }
  return out;
}
export function parseLsof(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = /^(\S+)\s+(\d+)\s+.*?TCP\s+(\S+?)->(\S+)\s+\((\w+)\)/.exec(l);
    if (m) out.push({ local: m[3], remote: m[4], state: m[5], pid: Number(m[2]) });
  }
  return out;
}
const hexIp = (h) => {
  if (h.length === 8) return h.match(/../g).reverse().map((x) => parseInt(x, 16)).join('.');
  const words = h.match(/.{8}/g).map((w) => w.match(/../g).reverse().join(''));
  return `[${words.join('').match(/.{4}/g).map((x) => parseInt(x, 16).toString(16)).join(':')}]`;
};
const TCP_STATE = { '01': 'ESTABLISHED', '02': 'SYN_SENT', '06': 'TIME_WAIT', '08': 'CLOSE_WAIT', '0A': 'LISTEN' };
export function parseProcNet(text) {
  const out = [];
  for (const l of String(text).split('\n').slice(1)) {
    const c = l.trim().split(/\s+/);
    if (c.length < 10) continue;
    const [lh, lp] = c[1].split(':'), [rh, rp] = c[2].split(':');
    out.push({ local: `${hexIp(lh)}:${parseInt(lp, 16)}`, remote: `${hexIp(rh)}:${parseInt(rp, 16)}`, state: TCP_STATE[c[3]] || c[3], inode: c[9] });
  }
  return out;
}

function listConnectionsProc() {
  const sockets = [...parseProcNet(fs.readFileSync('/proc/net/tcp', 'utf8')), ...(fs.existsSync('/proc/net/tcp6') ? parseProcNet(fs.readFileSync('/proc/net/tcp6', 'utf8')) : [])];
  const byInode = new Map(sockets.map((s) => [s.inode, s]));
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let fds; try { fds = fs.readdirSync(`/proc/${d}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link; try { link = fs.readlinkSync(`/proc/${d}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      const s = m && byInode.get(m[1]);
      if (s) out.push({ local: s.local, remote: s.remote, state: s.state, pid: Number(d) });
    }
  }
  return out;
}

export async function listConnections(platform = process.platform) {
  if (platform === 'win32') return parseNetstatWin((await run('netstat', ['-ano', '-p', 'tcp'])) || '');
  if (platform === 'linux') {
    if (fs.existsSync('/proc/net/tcp')) { try { return listConnectionsProc(); } catch { /* fall through */ } }
    return parseSs((await run('ss', ['-H', '-tnp'])) || '');
  }
  return parseLsof((await run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED'])) || '');
}
