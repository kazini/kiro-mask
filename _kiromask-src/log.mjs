// Minimal leveled logger with ANSI colour (no dependencies), secret redaction and an optional log file.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

export const redact = (s) =>
  String(s)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/\b(nvapi-|AIza)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/("?(?:api[_-]?key|authorization|refreshToken|accessToken)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi, '$1***');

/**
 * A log file. Lines are written synchronously (appendFileSync-style) so the tail survives `process.exit()` —
 * Kiro Mask exits the moment Kiro closes, which is exactly when you want to read the log.
 */
export function openLogFile(dir, { keep = 20, now = new Date(), prefix = 'kiromask' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const file = path.join(dir, `${prefix}-${stamp}.log`);
  const fd = fs.openSync(file, 'a');
  // Keep only the newest `keep` log files (names sort chronologically).
  try {
    const old = fs.readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.log')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - Math.max(1, keep)))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* pruning is best effort */ }
  let closed = false;
  return {
    file,
    write: (line) => { if (!closed) try { fs.writeSync(fd, line + '\n'); } catch { /* a full disk must not take the proxy down */ } },
    close: () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch { /* ignore */ } } },
  };
}

export function createLogger({ level = 'info', color = process.stdout.isTTY, write = (line) => process.stdout.write(line + '\n') } = {}) {
  let min = LEVELS[level] ?? 20;
  let sink = null;
  const log = (lvl, msg) => {
    const rank = LEVELS[lvl] ?? 20;
    const consoleOn = rank >= min;
    if (!consoleOn && !sink) return;
    const clean = redact(msg);
    const tag = lvl.toUpperCase().padEnd(5);
    if (consoleOn) {
      const t = new Date().toTimeString().slice(0, 8);
      write(color ? `\x1b[90m${t}${RESET} ${COLORS[lvl]}${tag}${RESET} ${clean}` : `${t} ${tag} ${clean}`);
    }
    // The file always gets everything (debug included) with full timestamps, whatever the console shows.
    if (sink) sink.write(`${new Date().toISOString()} ${tag} ${clean}`);
  };
  log.setLevel = (l) => { min = LEVELS[l] ?? min; };
  log.level = () => Object.keys(LEVELS).find((k) => LEVELS[k] === min);
  log.attachFile = (s) => { sink = s; };
  log.detachFile = () => { sink?.close?.(); sink = null; };
  log.logFile = () => sink?.file ?? null;
  return log;
}
