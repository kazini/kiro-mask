#!/usr/bin/env node
// Runs everything and prints a summary:  diag tests, kiromask suite, then every script in checks/.
//   node run-tests.mjs                 all of it
//   node run-tests.mjs --only 05,07    selected checks by number; "suite" and "diag" select those two groups
//   node run-tests.mjs --skip-diag     skip the capture/doctor tests (the slow ones, about a minute)
//   node run-tests.mjs --skip-suite    skip the kiromask suite
//   node run-tests.mjs --list          just list what would run
// Env: KIROMASK_DIR (kiromask folder), KIROMASK_CAPTURES (real recorded Kiro traffic), KIROMASK_EXTRA_YAML
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const tests = fs.readdirSync(path.join(HERE, 'tests')).filter((f) => /\.test\.m?js$/.test(f)).sort();
// the capture/doctor tests are the *.test.mjs ones, the kiromask suite is the *.test.js ones
const groups = [
  { name: 'diag tests (node:test)', key: 'diag', skip: '--skip-diag', files: tests.filter((f) => f.endsWith('.mjs')) },
  { name: 'suite (node:test)', key: 'suite', skip: '--skip-suite', files: tests.filter((f) => f.endsWith('.js')) },
];
const checks = fs.readdirSync(path.join(HERE, 'checks')).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort();

const plan = [];
for (const g of groups) if (!args.includes(g.skip) && (!only || only.includes(g.key))) plan.push({ ...g, node: true });
for (const c of checks) if (!only || only.some((o) => c.startsWith(o))) plan.push({ name: c, file: path.join('checks', c) });
if (args.includes('--list')) { plan.forEach((p) => console.log(p.name)); process.exit(0); }

const results = [];
for (const p of plan) {
  const t0 = Date.now();
  const r = p.node
    ? spawnSync(process.execPath, ['--test', '--test-timeout=150000', ...p.files.map((f) => path.join('tests', f))], { cwd: HERE, encoding: 'utf8', env: process.env, maxBuffer: 256 * 1024 * 1024 })
    : spawnSync(process.execPath, [p.file], { cwd: HERE, encoding: 'utf8', env: process.env, maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  let status = r.status === 0 ? 'PASS' : r.status === 3 ? 'SKIP' : 'FAIL';
  let detail = '';
  if (p.node) {
    const grab = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(out) || [])[1] || 0);
    detail = `${grab('pass')} passed, ${grab('fail')} failed, ${grab('skipped')} skipped`;
    if (grab('fail') > 0) status = 'FAIL';
  } else {
    detail = (out.match(/^(✓|✗) .*$/m) || out.match(/^SKIP.*$/m) || [''])[0].replace(/^(✓|✗) /, '');
  }
  results.push({ ...p, status, ms: Date.now() - t0, detail });
  if (status === 'FAIL') console.log(out.split('\n').filter((l) => /✗|not ok|Error|expected|actual/.test(l)).slice(0, 25).join('\n'));
  else if (!p.node && status === 'PASS') console.log(out.split('\n').filter((l) => /^▶|^  ·/.test(l)).join('\n'));
}
console.log('\n' + '─'.repeat(78));
for (const r of results) console.log(`${{ PASS: '✓', FAIL: '✗', SKIP: '–' }[r.status]} ${r.status.padEnd(4)} ${r.name.padEnd(32)} ${String(r.ms).padStart(6)} ms  ${r.detail}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log('─'.repeat(78) + `\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped`);
process.exit(failed ? 1 : 0);
