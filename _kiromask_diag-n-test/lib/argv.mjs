// Small CLI helpers shared by the scripts.

/** Turn `--key=value` into `--key value` (first '=' only), leaving values and short flags alone. */
export function normalizeArgv(argv) {
  const out = [];
  for (const a of argv) {
    const m = /^(--[A-Za-z][\w-]*)=(.*)$/s.exec(a);
    if (m) out.push(m[1], m[2]); else out.push(a);
  }
  return out;
}

/** Compile a user-supplied process-name pattern (case-insensitive). Throws a readable error if invalid. */
export function parseMatch(src) {
  try { return new RegExp(src, 'i'); } catch (e) { throw new Error(`--match is not a valid regular expression: ${e.message}`); }
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Process-name pattern marking a process as Kiro's: "kiro", the executable's own name, plus the user's --match. */
export function processRegex(exe, match) {
  const parts = ['kiro'];
  if (exe) { const base = exe.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''); if (base) parts.push(escapeRe(base)); }
  if (match) parts.push(`(?:${match})`);
  return new RegExp(parts.join('|'), 'i');
}
