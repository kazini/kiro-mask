// Read the target of a Windows shortcut (.lnk) without any dependency, by parsing the documented
// Shell Link format (MS-SHLLINK). A PowerShell fallback is used on Windows if the file cannot be parsed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');

/** @returns {{target: string|null, relative: string|null, workingDir: string|null}|null} null when `buf` is not a shortcut */
export function parseLnk(buf) {
  try {
    if (buf.length < 0x4c || buf.readUInt32LE(0) !== 0x4c || !buf.subarray(4, 20).equals(CLSID)) return null;
    const flags = buf.readUInt32LE(0x14);
    const unicode = !!(flags & 0x80);
    let pos = 0x4c;
    if (flags & 0x1) pos += 2 + buf.readUInt16LE(pos); // LinkTargetIDList

    const cstr = (off) => { let e = off; while (e < buf.length && buf[e] !== 0) e++; return buf.toString('latin1', off, e); };
    const wstr = (off) => { let e = off; while (e + 1 < buf.length && (buf[e] !== 0 || buf[e + 1] !== 0)) e += 2; return buf.toString('utf16le', off, e); };

    let target = null;
    if (flags & 0x2) { // LinkInfo
      const start = pos;
      const size = buf.readUInt32LE(start);
      const headerSize = buf.readUInt32LE(start + 4);
      const infoFlags = buf.readUInt32LE(start + 8);
      if (infoFlags & 0x1) { // VolumeIDAndLocalBasePath
        let base = null;
        let suffix = null;
        if (headerSize >= 0x24) { // optional Unicode variants (exact for non-ASCII paths)
          const bu = buf.readUInt32LE(start + 28);
          const su = buf.readUInt32LE(start + 32);
          if (bu) base = wstr(start + bu);
          if (su) suffix = wstr(start + su);
        }
        base ??= cstr(start + buf.readUInt32LE(start + 16));
        suffix ??= cstr(start + buf.readUInt32LE(start + 24));
        target = base + suffix;
      }
      pos = start + size;
    }

    let relative = null;
    let workingDir = null;
    const readStr = () => {
      const n = buf.readUInt16LE(pos); pos += 2;
      const bytes = unicode ? n * 2 : n;
      const s = unicode ? buf.toString('utf16le', pos, pos + bytes) : buf.toString('latin1', pos, pos + bytes);
      pos += bytes;
      return s;
    };
    if (flags & 0x4) readStr();            // NAME_STRING
    if (flags & 0x8) relative = readStr(); // RELATIVE_PATH
    if (flags & 0x10) workingDir = readStr();
    return { target: target || null, relative, workingDir };
  } catch { return null; } // truncated / corrupt
}

function viaPowerShell(file) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject WScript.Shell).CreateShortcut($env:KM_LNK).TargetPath'],
      { env: { ...process.env, KM_LNK: file }, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch { return null; }
}

/** Every plausible target of a shortcut, best first. The caller keeps the first one that turns out to be Kiro. */
export function shortcutTargets(file, { platform = process.platform } = {}) {
  const out = [];
  let info = null;
  try { const st = fs.statSync(file); if (st.isFile() && st.size < 1024 * 1024) info = parseLnk(fs.readFileSync(file)); } catch { /* unreadable */ }
  if (info?.target) out.push(info.target);
  if (info?.relative) out.push(path.resolve(path.dirname(file), info.relative));
  if (!info && platform === 'win32') { const t = viaPowerShell(file); if (t) out.push(t); }
  return out;
}
