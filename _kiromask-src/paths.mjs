// Where Kiro Mask keeps the files it writes (local CA, logs, captures, caches).
//
// Default: a `data/` folder INSIDE the kiromask folder, so nothing is scattered into your user profile.
// Override, highest priority first:  --data-dir <dir>  >  $KIROMASK_HOME  >  `data_dir` in the config  >  <kiromask>/data
// A relative path (from the config or $KIROMASK_HOME) is resolved against the kiromask folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The kiromask folder (the one that contains kiromask.mjs and _kiromask-src/; no package.json needed). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isWritableDir = (dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
};

/**
 * @param {{cli?: string|null, env?: string|null, config?: string|null}} [o]
 * @returns {{dir: string, source: string, fellBack: boolean}}
 */
export function resolveDataDir({ cli, env = process.env.KIROMASK_HOME, config } = {}) {
  const pick = cli ? ['--data-dir', cli, process.cwd()] : env ? ['KIROMASK_HOME', env, ROOT] : config ? ['data_dir', config, ROOT] : ['default', 'data', ROOT];
  const [source, value, base] = pick;
  const dir = path.resolve(base, String(value));
  if (isWritableDir(dir)) return { dir, source, fellBack: false };
  // e.g. kiromask installed somewhere read-only (a global npm install): fall back to the user profile rather than crash.
  const home = path.join(os.homedir(), '.kiromask');
  return { dir: home, source: `${source} (not writable: ${dir})`, fellBack: true };
}
