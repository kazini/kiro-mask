// Self-test of the test kit: copy the product, deliberately reintroduce known bugs, and confirm the
// matching check FAILS for each. Proves the checks can actually catch regressions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCheck } from '../lib/check.mjs';
import { KM, KIT, CAPTURES, captureFiles, readRequest } from '../lib/paths.mjs';
import { tryRun, pythonBin, hasPyYaml } from '../lib/exec.mjs';

const t = createCheck('Mutation self-test: the checks must catch reintroduced bugs');
const py = pythonBin();
const MUTATIONS = [
  { name: 'wrong CRC-32 polynomial', file: '_kiromask-src/aws/eventstream.mjs', from: '0xedb88320 ^', to: '0xedb88321 ^', check: '01-eventstream-real.mjs' },
  { name: 'wrong CRC-32 polynomial (cross-impl)', file: '_kiromask-src/aws/eventstream.mjs', from: '0xedb88320 ^', to: '0xedb88321 ^', check: '09-python-crosscheck.mjs', needs: ['python'] },
  { name: 'schema: $schema no longer stripped', file: '_kiromask-src/translate/schema.mjs', from: "if (simplify) stripSet.add('$schema');", to: '', check: '04-schema-and-repair.mjs' },
  { name: 'schema: JSON repair loses truncation handling', file: '_kiromask-src/translate/json-repair.mjs', from: "if (inStr) out += '\"';", to: '', check: '04-schema-and-repair.mjs' },
  { name: 'tool history read from `toolUse` instead of `toolUses`', file: '_kiromask-src/translate/request.mjs', from: 'a?.toolUses ?? a?.toolUse ?? []', to: 'a?.toolUse ?? []', check: '05-request-invariants.mjs', needs: ['awscaptures'] },
  { name: 'Responses: function_call items checked for pairing before being grouped into turns', file: '_kiromask-src/translate/request.mjs', from: 'turns = mergeSameRole(repairPairing(mergeSameRole(turns)));', to: 'turns = mergeSameRole(repairPairing(turns));', check: '05-request-invariants.mjs', needs: ['respcaptures'] },
  { name: 'Anthropic: text placed before tool_result blocks', file: '_kiromask-src/translate/request.mjs', from: "    for (const r of t.toolResults) {\n      content.push({ type: 'tool_result'", to: "    if (t.text.trim()) content.push({ type: 'text', text: t.text });\n    for (const r of t.toolResults) {\n      content.push({ type: 'tool_result'", check: '05-request-invariants.mjs', needs: ['captures'] },
  { name: 'CA: wrong SAN tag for DNS names', file: '_kiromask-src/tls/ca.mjs', from: "implicit(2, Buffer.from(host, 'ascii'))", to: "implicit(1, Buffer.from(host, 'ascii'))", check: '02-ca-openssl.mjs', needs: ['openssl'] },
  { name: "YAML: '' escape ignored in single-quoted strings", file: '_kiromask-src/config/yaml.mjs', from: ".replace(/''/g, \"'\")", to: '', check: '03-yaml-vs-pyyaml.mjs', needs: ['pyyaml'] },
];
const fmts = (() => { try { return new Set((captureFiles()?.requests || []).map((f) => readRequest(f).format)); } catch { return new Set(); } })();
const have = { captures: !!CAPTURES, awscaptures: fmts.has('aws'), respcaptures: fmts.has('responses'), python: !!py, openssl: !!tryRun('openssl', ['version']), pyyaml: hasPyYaml(py) };

for (const m of MUTATIONS) {
  const missing = (m.needs || []).filter((n) => !have[n]);
  if (missing.length) { t.info(`skipped "${m.name}" (needs ${missing.join(', ')})`); continue; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-mut-'));
  fs.cpSync(KM, dir, { recursive: true, filter: (src) => !src.split(path.sep).includes('_kiromask_diag-n-test') }); // the product only, not these test folders
  const target = path.join(dir, m.file);
  const src = fs.readFileSync(target, 'utf8');
  if (!t.ok(src.includes(m.from), `mutation "${m.name}": pattern still exists in the product (update this self-test if the code moved)`)) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
  fs.writeFileSync(target, src.replace(m.from, m.to));
  const r = spawnSync(process.execPath, [path.join(KIT, 'checks', m.check)], { cwd: KIT, env: { ...process.env, KIROMASK_DIR: dir }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  t.ok(r.status === 1, `"${m.name}" is caught by ${m.check} (exit ${r.status})`);
  fs.rmSync(dir, { recursive: true, force: true });
}
t.finish();
