// Watches Kiro's process tree and its TCP connections while a capture runs, to find traffic that does NOT
// go through the proxy (processes that ignore --proxy-server) and to notice when Kiro has exited.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { listProcesses, listConnections, kiroPids, splitAddr, isLoopback } from './procs.mjs';

export class Monitor extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} o.proxyPort
   * @param {string} [o.installDir]
   * @param {RegExp} [o.nameRe]   process-name pattern that marks a process as Kiro's (default /kiro/i)
   * @param {string} o.outDir
   * @param {number} [o.intervalMs]
   * @param {boolean} [o.loopbackIsExternal]   tests only: treat 127.0.0.1 targets as "external"
   */
  constructor(o) {
    super();
    Object.assign(this, { intervalMs: 3000, loopbackIsExternal: false }, o);
    this.processes = new Map(); // pid → {pid, ppid, name, exe, firstSeen, proxiedConns, directConns}
    this.direct = new Map(); // `${pid}|${remote}` → entry
    this.everSeen = false;
    this.emptyTicks = 0;
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  /** Run once; safe to call concurrently (skips if a previous tick is still running). */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const procs = await listProcesses();
      const pids = kiroPids(procs, { installDir: this.installDir, ...(this.nameRe ? { nameRe: this.nameRe } : {}) });
      const byPid = new Map(procs.map((p) => [p.pid, p]));
      for (const pid of pids) {
        if (!this.processes.has(pid)) {
          const p = byPid.get(pid) || {};
          this.processes.set(pid, { pid, ppid: p.ppid ?? null, name: p.name || '?', exe: p.exe || null, firstSeen: new Date().toISOString(), proxiedConns: 0, directConns: 0 });
          this.emit('process', this.processes.get(pid));
        }
      }
      if (pids.size) { this.everSeen = true; this.emptyTicks = 0; } else if (this.everSeen && ++this.emptyTicks >= 2) this.emit('kiro-exited');
      this.alive = pids.size;
      if (!pids.size) return;

      const conns = await listConnections();
      for (const c of conns) {
        if (!pids.has(c.pid) || !/ESTAB|SYN_SENT/i.test(c.state || '')) continue;
        const remote = splitAddr(c.remote), local = splitAddr(c.local);
        const proc = this.processes.get(c.pid);
        if (isLoopback(remote.ip) && remote.port === this.proxyPort) { if (proc) proc.proxiedConns++; continue; }
        if (isLoopback(remote.ip) && !this.loopbackIsExternal) continue; // Kiro's own helper processes talking to each other
        const key = `${c.pid}|${c.remote}`;
        if (this.direct.has(key)) continue;
        if (proc) proc.directConns++;
        const entry = { t: new Date().toISOString(), pid: c.pid, process: proc?.name || '?', exe: proc?.exe || null, remote: c.remote, remoteIp: remote.ip, remotePort: remote.port, localPort: local.port };
        this.direct.set(key, entry);
        try { fs.appendFileSync(path.join(this.outDir, 'bypass.jsonl'), JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
        this.emit('direct', entry);
      }
    } catch (e) { this.emit('error', e); } finally { this.busy = false; }
  }

  snapshot() {
    return { processes: [...this.processes.values()], direct: [...this.direct.values()] };
  }
}
