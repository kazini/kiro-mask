import { execFileSync, spawnSync } from 'node:child_process';

/** Run a command, return trimmed stdout or null if it is unavailable/fails. */
export function tryRun(cmd, args = [], opts = {}) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); } catch { return null; }
}
export const pythonBin = () => ['python3', 'python'].find((p) => tryRun(p, ['--version']) !== null) ?? null;
export const hasPyYaml = (py) => !!py && tryRun(py, ['-c', 'import yaml']) !== null;
export { spawnSync };
