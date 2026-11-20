// Event-stream codec vs. REAL AWS responses: CRCs verify, every frame re-encodes byte-identically,
// and decoding is chunk-boundary safe (fed one byte at a time).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createCheck, skip } from '../lib/check.mjs';
import { imp, captureFiles } from '../lib/paths.mjs';

const { FrameDecoder, decodeAll, encodeFrameRaw, crc32, payloadJson } = await imp('aws/eventstream.mjs');
const t = createCheck('Event-stream codec vs real AWS responses');

// synthetic always-on part
t.eq(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 standard check value');
if (zlib.crc32) { const b = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 255)); t.ok(crc32(b) === zlib.crc32(b), 'crc32 equals zlib.crc32'); }

const c = captureFiles();
if (!c?.responses.length) { t.info('no real responses available — synthetic part only'); t.finish(); }

let frames = 0, identical = 0, chunkedOk = 0;
const types = {};
for (const f of c.responses) {
  const buf = fs.readFileSync(f);
  let all;
  try { all = decodeAll(buf); } catch (e) { t.ok(false, `${f}: ${e.message}`); continue; }
  frames += all.length;
  for (const fr of all) {
    const rebuilt = encodeFrameRaw(fr.raw.subarray(12, 12 + fr.raw.readUInt32BE(4)), fr.payload);
    if (rebuilt.equals(fr.raw)) identical++;
    types[fr.eventType] = (types[fr.eventType] || 0) + 1;
    if (fr.eventType !== 'toolUseEvent') t.ok(payloadJson(fr) !== undefined, 'payload parses');
  }
  const d = new FrameDecoder(); let n = 0;
  for (let i = 0; i < buf.length; i++) n += d.push(buf.subarray(i, i + 1)).length;
  if (n === all.length && d.pending === 0) chunkedOk++;
}
t.info(`${c.responses.length} responses, ${frames} frames: ${JSON.stringify(types)}`);
t.ok(frames > 0, 'frames were decoded');
t.eq(identical, frames, `all ${frames} frames re-encode byte-identically`);
t.eq(chunkedOk, c.responses.length, 'byte-at-a-time decoding yields identical results for every response');
const KNOWN = ['initial-response', 'assistantResponseEvent', 'toolUseEvent', 'metadataEvent', 'reasoningContentEvent', 'contextUsageEvent', 'meteringEvent'];
t.eq(Object.keys(types).filter((k) => !KNOWN.includes(k)), [], 'only known event types occur (an unknown one would need handling)');
t.finish();
