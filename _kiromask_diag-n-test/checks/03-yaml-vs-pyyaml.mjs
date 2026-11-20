// The built-in YAML parser must produce exactly what PyYAML (the reference) produces.
// Files checked: the bundled edge-case file, the product's example config, and any in KIROMASK_EXTRA_YAML
// (comma-separated paths — e.g. your own config; secrets are never printed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCheck, skip } from '../lib/check.mjs';
import { imp, KIT, KM } from '../lib/paths.mjs';
import { pythonBin, hasPyYaml } from '../lib/exec.mjs';

const py = pythonBin();
if (!hasPyYaml(py)) skip('python3 with PyYAML not available');
const { parseYaml } = await imp('config/yaml.mjs');
const t = createCheck('YAML parser vs PyYAML');

const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
const files = [
  path.join(KIT, 'tests', 'fixtures', 'edge.yaml'),
  path.join(KM, 'kiromask.config.example.yaml'),
  ...(process.env.KIROMASK_EXTRA_YAML || '').split(',').map((s) => s.trim()).filter(Boolean),
].filter((f) => fs.existsSync(f));

for (const f of files) {
  const expected = JSON.parse(execFileSync(py, [path.join(KIT, 'py', 'py_yaml_dump.py'), f], { encoding: 'utf8' }));
  let got;
  try { got = parseYaml(fs.readFileSync(f, 'utf8')); } catch (e) { t.ok(false, `${path.basename(f)} threw: ${e.message}`); continue; }
  const same = canon(expected) === canon(got);
  t.ok(same, `${path.basename(f)} parses identically to PyYAML`);
  if (!same) for (const [k, v] of Object.entries(expected)) if (canon(v) !== canon(got[k])) console.log(`      differs at top-level key "${k}"`);
}
t.finish();
