// Tool-schema sanitising (against Kiro's REAL tool definitions when captures are available)
// and tool-argument JSON repair.
import fs from 'node:fs';
import { createCheck } from '../lib/check.mjs';
import { imp, captureFiles, readRequest } from '../lib/paths.mjs';

const { sanitizeSchema } = await imp('translate/schema.mjs');
const { parseToolArgs } = await imp('translate/json-repair.mjs');
const t = createCheck('Schema sanitising and JSON repair');

const has = (o, k) => JSON.stringify(o).includes(`"${k}"`);
const BAD = ['anyOf', 'oneOf', 'not', '$schema'];

// Real tools: take the request with the most tools from the captures.
const c = captureFiles();
let tools = null;
if (c?.requests.length) {
  for (const f of c.requests) {
    const ts = readRequest(f).kiro.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools;
    if (ts && (!tools || ts.length > tools.length)) tools = ts;
  }
}
if (tools) {
  const specs = tools.map((x) => x.toolSpecification);
  const before = Object.fromEntries(BAD.map((k) => [k, specs.filter((s) => has(s.inputSchema.json, k)).length]));
  t.info(`${specs.length} real tools; tools containing keyword before sanitising: ${JSON.stringify(before)}`);
  t.ok(Object.values(before).some((n) => n > 0), 'the real schemas do contain the problematic keywords (otherwise this check proves nothing)');
  for (const s of specs) {
    const out = sanitizeSchema(s.inputSchema.json);
    for (const k of BAD) t.ok(!has(out, k), `${s.name}: no "${k}" after sanitising`);
    t.ok(out.type === 'object' && typeof out.properties === 'object', `${s.name}: object schema with properties`);
    const orig = Object.keys(s.inputSchema.json.properties || {}).sort();
    t.eq(Object.keys(out.properties).sort(), orig, `${s.name}: no parameters lost`);
    t.eq((out.required || []).sort(), (s.inputSchema.json.required || []).sort(), `${s.name}: required list preserved`);
  }
} else {
  t.info('no captures — synthetic zod-style schema only');
}
// synthetic, independent of any capture: $schema / additionalProperties handling
const withMeta = sanitizeSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } });
t.ok(!('$schema' in withMeta), '$schema is removed');
t.eq(sanitizeSchema({ type: 'object', additionalProperties: false, properties: {} }, { strip: ['additionalProperties'] }).additionalProperties, undefined, 'extra keywords can be stripped on request');
const zod = { anyOf: [{ anyOf: [{ not: {} }, { type: 'number', description: 'd', default: 1 }] }, { type: 'null' }], description: 'outer' };
t.eq(sanitizeSchema({ type: 'object', properties: { n: zod } }).properties.n, { type: 'number', description: 'outer', default: 1 }, 'zod optional-number collapses to a plain number schema');

// JSON repair table
const rows = [
  ['{"a":1}', { a: 1 }], ['', {}], ['   ', {}], ['"{\\"a\\":1}"', { a: 1 }],
  ['```json\n{"a":1}\n```', { a: 1 }], ['Sure! {"a":1} done', { a: 1 }], ['{"a":1,}', { a: 1 }],
  ['{"path":"x.ts","content":"line1\\nline2', { path: 'x.ts', content: 'line1\nline2' }],
  ['{"a":{"b":[1,2', { a: { b: [1, 2] } }], ['{"a":', { a: null }], ['{"a":1', { a: 1 }],
];
for (const [input, want] of rows) { const r = parseToolArgs(input); t.ok(r.ok, `repairs ${JSON.stringify(input).slice(0, 40)}`); if (r.ok) t.eq(r.value, want, `value for ${JSON.stringify(input).slice(0, 40)}`); }
for (const bad of ['[1,2]', 'not json', '42']) t.ok(!parseToolArgs(bad).ok, `rejects ${JSON.stringify(bad)}`);
t.finish();
