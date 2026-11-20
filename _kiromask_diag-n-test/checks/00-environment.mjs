// Environment check: is this machine able to run the test kit, and what will be skipped?
import fs from 'node:fs';
import path from 'node:path';
import { createCheck } from '../lib/check.mjs';
import { KM, KIT, CAPTURES, captureFiles } from '../lib/paths.mjs';
import { tryRun, pythonBin, hasPyYaml } from '../lib/exec.mjs';

const t = createCheck('Environment');
const [maj, min] = process.versions.node.split('.').map(Number);
t.ok(maj > 18 || (maj === 18 && min >= 18), `Node ${process.versions.node} satisfies >= 18.18`);
t.info(`node ${process.version} on ${process.platform}/${process.arch}`);
t.ok(typeof fetch === 'function', 'global fetch is available');
t.ok(typeof (await import('node:test')).test === 'function', 'node:test is available');

const prodPkg = [path.join(KM, '.dev', 'package.json'), path.join(KM, 'package.json')].find((p) => fs.existsSync(p));
if (prodPkg) {
  const pkg = JSON.parse(fs.readFileSync(prodPkg, 'utf8'));
  t.info(`product: ${pkg.name}@${pkg.version} (metadata: ${path.relative(KM, prodPkg)})`);
  t.eq(Object.keys(pkg.dependencies || {}), [], 'product declares zero runtime dependencies');
  t.ok(!fs.existsSync(path.join(KM, 'node_modules')), 'product has no node_modules');
} else {
  t.info(`product has no package.json (local metadata in .dev/ is optional — the code does not need it) at ${KM}`);
}
t.ok(fs.existsSync(path.join(KM, 'kiromask.mjs')), 'product entry point kiromask.mjs found');

const ssl = tryRun('openssl', ['version']);
t.info(ssl ? `openssl: ${ssl}` : 'openssl: not found (certificate check 02 will be skipped)');
const py = pythonBin();
t.info(py ? `python: ${tryRun(py, ['--version'])}` : 'python: not found (checks 03 and 09 will be skipped)');
if (py) t.info(hasPyYaml(py) ? 'PyYAML: present' : 'PyYAML: missing — `pip install pyyaml` enables check 03');

if (CAPTURES) {
  const c = captureFiles();
  t.ok(!!c && c.requests.length > 0, `captures: ${c?.requests.length ?? 0} requests, ${c?.responses.length ?? 0} responses in ${CAPTURES}`);
} else {
  t.info('KIROMASK_CAPTURES not set — real-traffic checks (01, 04-real, 05, 07, 08, 09-real) will be skipped/partial');
}
t.info(`testkit: ${KIT}`);
t.finish();
