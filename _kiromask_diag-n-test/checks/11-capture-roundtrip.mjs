// Round trip: record a session with Kiro Mask's own capture feature (debug.capture_traffic), then feed the
// recording back into the real-traffic checks. Proves recordings made on your machine can be replayed here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCheck } from '../lib/check.mjs';
import { KIT } from '../lib/paths.mjs';
import { startApp, viaProxy, mockServer, AWS_HOST, providerConfig, kiroRequest, SYSTEM_HISTORY, tool, sseHead, sseWrite } from '../tests/harness.js';
import { ev, decodeAll } from '../../_kiromask-src/aws/eventstream.mjs';

const t = createCheck('Capture round trip: Kiro Mask recordings are usable by the test kit');
const provider = await mockServer((req, res) => {
  sseHead(res);
  sseWrite(res, { choices: [{ delta: { content: 'Looking. ' } }] });
  sseWrite(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'readFile', arguments: '{"path":"a.ts"}' } }] } }] });
  sseWrite(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 500, completion_tokens: 9 } });
  sseWrite(res, '[DONE]'); res.end();
});
const awsHandler = (req, res) => { res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' }); res.end(Buffer.concat([ev.text('from kiro'), ev.contextUsage(2), ev.metering(0.1)])); };
const h = await startApp({ ...providerConfig(provider.port), kiro_endpoint: { models: true }, debug: { capture_traffic: true } }, { awsHandler });

const history = [...SYSTEM_HISTORY,
  { userInputMessage: { content: 'read a.ts', modelId: 'my-model', origin: 'AI_EDITOR' } },
  { assistantResponseMessage: { content: 'Reading.', toolUses: [{ toolUseId: 'tooluse_A', name: 'readFile', input: { path: 'a.ts' } }] } }];
const send = (modelId, extra = {}) => viaProxy(h.port, h.caPem, AWS_HOST, { method: 'POST', path: '/generateAssistantResponse', headers: { 'content-type': 'application/json', 'x-amzn-kiro-agent-mode': 'vibe', authorization: 'Bearer top-secret-token' }, body: JSON.stringify(kiroRequest({ modelId, history, tools: [tool('readFile'), tool('fsWrite')], ...extra })) });
const toolResults = [{ toolUseId: 'tooluse_A', status: 'success', content: [{ text: 'file body' }] }];
await send('my-model', { content: '', toolResults });
await send('auto', { content: '', toolResults });
// …and the same conversation in the newer wire format (POST /v1/responses)
await viaProxy(h.port, h.caPem, 'runtime.us-east-1.kiro.dev', { method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: 'Bearer top-secret-token' }, body: JSON.stringify({
  model: 'my-model', stream: true, metadata: { 'kiro:agent_mode': 'default-v2', 'kiro:conversation_id': 'sess_rt' },
  tools: [{ type: 'function', name: 'readFile', description: 'read', parameters: { type: 'object', properties: { path: { type: ['string', 'null'] } }, required: ['path'] } }],
  input: [{ role: 'user', content: '# Kiro - System Prompt\nrules' }, { role: 'assistant', content: 'I will follow these instructions.' }, { role: 'user', content: 'read a.ts' },
    { type: 'function_call', call_id: 'tooluse_A', name: 'readFile', arguments: '{"path":"a.ts"}' }, { type: 'function_call_output', call_id: 'tooluse_A', output: 'file body' }],
}) });
await new Promise((r) => setTimeout(r, 150));

const root = path.join(h.dataDir, 'captures');
const dir = path.join(root, fs.readdirSync(root)[0]);          // one folder per run, in the same layout as capture.mjs
const flows = fs.readdirSync(path.join(dir, 'flows'));
t.eq(flows.filter((f) => /\.req\.json$/.test(f) && !f.includes('.provider.')).length, 3, 'three chat requests recorded');
t.eq(flows.filter((f) => /\.res\.bin$/.test(f)).length, 2, 'two AWS event-stream responses recorded');
t.eq(flows.filter((f) => /\.res\.txt$/.test(f) && !f.includes('.provider.')).length, 1, `one Responses (SSE) response recorded (${flows.filter((f) => /v1_responses/.test(f)).join(', ')})`);
t.eq(flows.filter((f) => /\.provider\.req\.json$/.test(f)).length, 2, 'what was sent to your provider is recorded for the two custom-model calls');
const all = fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
t.ok(!all.some((f) => fs.readFileSync(f).includes('top-secret-token')), 'the bearer token appears in no recorded file');
t.ok(flows.filter((f) => f.endsWith('.res.events.jsonl')).some((f) => fs.readFileSync(path.join(dir, 'flows', f), 'utf8').includes('meteringEvent')), 'native response recorded exactly as Kiro received it');
t.ok(fs.existsSync(path.join(dir, 'session.json')) && fs.existsSync(path.join(dir, 'summary.json')), 'session.json and summary.json written');

for (const check of ['01-eventstream-real.mjs', '05-request-invariants.mjs', '07-replay-full-proxy.mjs']) {
  const r = spawnSync(process.execPath, [path.join(KIT, 'checks', check)], { cwd: KIT, encoding: 'utf8', env: { ...process.env, KIROMASK_CAPTURES: dir } });
  t.ok(r.status === 0, `${check} accepts the recording${r.status ? `\n${(r.stdout + r.stderr).split('\n').filter((l) => /✗|Error/.test(l)).slice(0, 4).join('\n')}` : ''}`);
}
await h.stop(); provider.close();
t.finish();
