// Replays REAL Kiro traffic (not shipped — it contains personal data and tokens).
// Run with:  KIROMASK_CAPTURES=/path/to/capture-folder  node --test tests/real-captures.test.js
// Both capture layouts are understood (see lib/paths.mjs): the _kiromask_diag-n-test/capture.mjs folder and debug.capture_traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../_kiromask-src/config/load.mjs';
import { translateRequest } from '../../_kiromask-src/translate/request.mjs';
import { decodeAll, encodeFrameRaw } from '../../_kiromask-src/aws/eventstream.mjs';
import { CAPTURES, captureFiles, readRequest } from '../lib/paths.mjs';

const skip = !CAPTURES || !fs.existsSync(CAPTURES) ? 'set KIROMASK_CAPTURES to run' : false;
const ACK = /^\s*I will follow these instructions\.?\s*$/i;

test('real captures: every AWS response frame decodes, CRCs verify, and re-encodes byte-identically', { skip }, (t) => {
  const c = captureFiles();
  if (!c.responses.length) return t.skip('no AWS event-stream responses in this capture (a Responses-protocol recording)');
  let frames = 0;
  for (const f of c.responses) {
    for (const fr of decodeAll(fs.readFileSync(f))) {
      frames++;
      const rebuilt = encodeFrameRaw(fr.raw.subarray(12, 12 + fr.raw.readUInt32BE(4)), fr.payload);
      assert.ok(rebuilt.equals(fr.raw), `${path.basename(f)}: frame not byte-identical`);
    }
  }
  assert.ok(frames > 0);
});

test('real captures: every request translates to valid OpenAI and Anthropic bodies, with a system message exactly when Kiro sent its system prompt', { skip }, () => {
  const c = captureFiles();
  assert.ok(c.requests.length > 0, 'the capture contains chat requests');
  const cfg = new Config({ providers: { o: { enabled: true, type: 'openai', models: [{ name: 'o' }] }, a: { enabled: true, type: 'anthropic', models: [{ name: 'a' }] } } });
  for (const f of c.requests) {
    const name = path.basename(f);
    const { kiro, format } = readRequest(f);
    const ackText = format === 'aws'
      ? kiro.conversationState.history?.[1]?.assistantResponseMessage?.content
      : (typeof kiro.input?.[1]?.content === 'string' ? kiro.input[1].content : kiro.input?.[1]?.content?.map?.((p) => p.text).join('') );
    const hasSystemPrompt = ACK.test(ackText || '');
    const oa = translateRequest(kiro, cfg.resolve('o')).body.messages;
    const an = translateRequest(kiro, cfg.resolve('a')).body.messages;
    assert.equal(oa[0].role === 'system', hasSystemPrompt, `${name}: system message iff Kiro sent its system prompt`);
    for (let i = 0; i < oa.length; i++) {
      if (!oa[i].tool_calls) continue;
      const ids = oa[i].tool_calls.map((x) => x.id).sort();
      const got = []; for (let j = i + 1; oa[j]?.role === 'tool'; j++) got.push(oa[j].tool_call_id);
      assert.deepEqual(got.sort(), ids, `${name}: tool_calls/tool pairing`);
    }
    assert.equal(an[0].role, 'user', `${name}: anthropic starts with a user turn`);
    an.forEach((m, i) => { if (i) assert.notEqual(m.role, an[i - 1].role, `${name}: anthropic roles alternate`); });
  }
});
