// Cross-implementation check of the event-stream codec: an independent Python implementation
// (py/py_eventstream.py) must decode what the Node code encodes, and vice versa.
// With captures: Python and Node must decode every real AWS response to identical events.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCheck, skip } from '../lib/check.mjs';
import { imp, KIT, captureFiles } from '../lib/paths.mjs';
import { pythonBin } from '../lib/exec.mjs';

const py = pythonBin();
if (!py) skip('python not available');
const { ev, decodeAll, payloadJson } = await imp('aws/eventstream.mjs');
const tool = path.join(KIT, 'py', 'py_eventstream.py');
const t = createCheck('Event-stream codec: Node ⇄ independent Python implementation');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'km-py-'));

// Node → Python
const events = [
  ['assistantResponseEvent', { content: 'héllo ✓ 日本語 😀' }],
  ['toolUseEvent', { name: 'readFile', toolUseId: 'tooluse_x1' }],
  ['toolUseEvent', { input: '{"path":"a.ts"}', name: 'readFile', toolUseId: 'tooluse_x1' }],
  ['toolUseEvent', { name: 'readFile', toolUseId: 'tooluse_x1', stop: true }],
  ['contextUsageEvent', { contextUsagePercentage: 33.3 }],
];
const nodeBin = Buffer.concat([ev.text(events[0][1].content), ev.toolStart('readFile', 'tooluse_x1'), ev.toolInput('readFile', 'tooluse_x1', '{"path":"a.ts"}'), ev.toolStop('readFile', 'tooluse_x1'), ev.contextUsage(33.3)]);
const f = path.join(tmp, 'node.bin'); fs.writeFileSync(f, nodeBin);
const d = spawnSync(py, [tool, 'decode', f], { encoding: 'utf8' });
t.ok(d.status === 0, `Python decodes Node-encoded frames (CRCs valid)${d.status ? `: ${d.stderr}` : ''}`);
t.eq(d.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((o) => [o.type, o.payload]), events, 'Python sees exactly the events Node encoded');

// Python → Node
const lines = events.map(([type, payload]) => JSON.stringify({ type, payload })).join('\n');
const e = spawnSync(py, [tool, 'encode'], { input: lines }); // stdout stays a Buffer (binary)
t.ok(e.status === 0, 'Python encodes frames');
const back = decodeAll(e.stdout).map((x) => [x.eventType, payloadJson(x)]);
t.eq(back, events, 'Node decodes Python-encoded frames (CRCs valid) to the same events');

// Real captures: both decoders agree
const c = captureFiles();
if (c?.responses.length) {
  let same = 0, frames = 0;
  for (const r of c.responses) {
    const pyOut = spawnSync(py, [tool, 'decode', r], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (pyOut.status !== 0) { t.ok(false, `${path.basename(r)}: python failed: ${pyOut.stderr.slice(0, 120)}`); continue; }
    const a = pyOut.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const b = decodeAll(fs.readFileSync(r)).map((x) => ({ type: x.eventType, payload: payloadJson(x) }));
    frames += b.length;
    if (JSON.stringify(a) === JSON.stringify(b)) same++;
  }
  t.info(`${frames} real frames compared`);
  t.eq(same, c.responses.length, `Node and Python decode all ${c.responses.length} real responses identically`);
} else t.info('no real responses — synthetic cross-check only');
fs.rmSync(tmp, { recursive: true, force: true });
t.finish();
