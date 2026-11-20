#!/usr/bin/env node
// Decode an AWS event-stream capture (e.g. a saved Kiro response .bin) into readable form.
//   node _kiromask-src/aws/decode_capture.mjs response.bin            summary: text, tool calls, usage
//   node _kiromask-src/aws/decode_capture.mjs response.bin --raw      every frame as JSON
import fs from 'node:fs';
import { decodeAll, payloadJson } from './eventstream.mjs';

const [file, flag] = process.argv.slice(2);
if (!file) { console.error('usage: decode_capture.mjs <file.bin> [--raw]'); process.exit(2); }
const frames = decodeAll(fs.readFileSync(file));

if (flag === '--raw') {
  for (const f of frames) console.log(JSON.stringify({ type: f.eventType, ...payloadJson(f) }));
  process.exit(0);
}
let text = '';
const tools = new Map();
const other = [];
for (const f of frames) {
  const p = payloadJson(f) ?? {};
  if (f.eventType === 'assistantResponseEvent') text += p.content ?? '';
  else if (f.eventType === 'toolUseEvent') {
    const t = tools.get(p.toolUseId) ?? { name: p.name, input: '' };
    t.input += p.input ?? '';
    tools.set(p.toolUseId, t);
  } else other.push(`${f.eventType}: ${JSON.stringify(p)}`);
}
console.log(`${frames.length} frames`);
if (text) console.log(`\n── text ──\n${text}`);
for (const [id, t] of tools) console.log(`\n── tool call ${t.name} (${id}) ──\n${t.input}`);
if (other.length) console.log(`\n── other ──\n${other.join('\n')}`);
