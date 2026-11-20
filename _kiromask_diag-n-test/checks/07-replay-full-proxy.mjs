// Simulation: replay every REAL Kiro chat request through the FULL proxy (CONNECT → TLS interception →
// header-based routing → translation → mock provider → event stream back), the way Kiro sends them now
// (POST / on the runtime host with X-Amz-Target). Chat is switched to a custom model; session-title requests
// must be answered locally. Reports latency and asserts a sane ceiling.
import { createCheck, skip } from '../lib/check.mjs';
import { captureFiles, readRequest, isTitleBody } from '../lib/paths.mjs';
import { startApp, rpc, viaProxy, mockServer, providerConfig, sseHead, sseWrite, RUNTIME_HOST } from '../tests/harness.js';
import { decodeAll, payloadJson } from '../../_kiromask-src/aws/eventstream.mjs';

const c = captureFiles();
if (!c?.requests.length) skip('KIROMASK_CAPTURES not set');
const t = createCheck(`Full-proxy replay of ${c.requests.length} real chat requests`);

let providerCalls = 0, maxBody = 0, sawToolDefs = 0, sawSystem = 0;
const provider = await mockServer((req, res, rec) => {
  providerCalls++; maxBody = Math.max(maxBody, rec.body.length);
  const body = JSON.parse(rec.body);
  if (body.tools?.length) sawToolDefs++;
  if (body.messages?.[0]?.role === 'system') sawSystem++;
  sseHead(res);
  sseWrite(res, { choices: [{ delta: { content: 'Checking ' } }] });
  const tool = body.tools?.[0]?.function?.name;
  if (tool) sseWrite(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: tool, arguments: '{"path":"README.md"}' } }] } }] });
  sseWrite(res, { choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 120000, completion_tokens: 30 } });
  sseWrite(res, '[DONE]'); res.end();
});
const h = await startApp({ ...providerConfig(provider.port), defaults: { context_window: 200000 } });

let ok = 0, titles = 0, bytes = 0;
const times = [], failures = [];
const sseEvents = (buf) => [...buf.toString('utf8').matchAll(/^event: (\S+)\ndata: (.*)$/gm)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
for (const f of c.requests) {
  const { headers, kiro, target, format } = readRequest(f);
  const isTitle = isTitleBody(kiro);
  if (!isTitle) { if (format === 'aws') kiro.conversationState.currentMessage.userInputMessage.modelId = 'my-model'; else kiro.model = 'my-model'; }
  const payload = JSON.stringify(kiro); bytes += payload.length;
  const t0 = performance.now();
  try {
    const extra = Object.fromEntries(['x-amzn-kiro-mode-identifier', 'x-amzn-codewhisperer-optout'].filter((k) => headers[k]).map((k) => [k, headers[k]]));
    if (format === 'responses') {
      // the way current Kiro builds send chat: POST /v1/responses, answered with Server-Sent Events
      const r = await viaProxy(h.port, h.caPem, RUNTIME_HOST, { method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: 'Bearer real-token', ...extra }, body: payload });
      times.push(performance.now() - t0);
      const evs = sseEvents(r.body);
      const names = evs.map((e) => e.type);
      const done = evs.find((e) => e.type === 'response.completed')?.data.response;
      const text = evs.filter((e) => e.type === 'response.output_text.delta').map((e) => e.data.delta).join('');
      const calls = done?.output?.filter((i) => i.type === 'function_call') || [];
      const good = r.status === 200 && /text\/event-stream/.test(r.headers['content-type']) && names[0] === 'response.created' && !!done && r.body.toString().trimEnd().endsWith('data: [DONE]')
        && done.status === (calls.length ? 'requires_action' : 'completed') && calls.every((i) => { try { JSON.parse(i.arguments); return !!i.call_id && !!i.name; } catch { return false; } });
      if (!good) failures.push(`${f.split('/').pop()}: status ${r.status} events ${names.join(',')}`);
      else if (isTitle) { titles++; if (!text || text.split(/\s+/).length > 8) failures.push(`${f}: unusable title "${text}"`); else ok++; }
      else ok++;
      continue;
    }
    const r = await rpc(h, RUNTIME_HOST, target || 'KiroRuntimeService.GenerateAssistantResponse', payload, { headers: extra });
    times.push(performance.now() - t0);
    const evs = decodeAll(r.body);
    const names = evs.map((e) => e.eventType);
    const good = r.status === 200 && names[0] === 'initial-response' && names.includes('assistantResponseEvent') && names.at(-2) === 'metadataEvent' && names.at(-1) === 'contextUsageEvent';
    if (!good) failures.push(`${f.split('/').pop()}: status ${r.status} events ${names.join(',')}`);
    else if (isTitle) {
      titles++;
      const title = evs.filter((e) => e.eventType === 'assistantResponseEvent').map((e) => payloadJson(e).content).join('');
      if (!title || title.split(/\s+/).length > 8) failures.push(`${f}: unusable title "${title}"`); else ok++;
    } else {
      const stop = payloadJson(evs.at(-2)).stopReason;
      if (!['TOOL_USE', 'END_TURN'].includes(stop)) failures.push(`${f}: bad stopReason ${stop}`); else ok++;
    }
  } catch (e) { failures.push(`${f.split('/').pop()}: ${e.message}`); }
}
times.sort((a, b) => a - b);
const pct = (p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]);
t.info(`${(bytes / 1e6).toFixed(1)} MB of requests · ${titles} title request(s) answered locally · largest provider body ${Math.round(maxBody / 1024)} KB · latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${pct(1)} ms`);
t.eq(failures.slice(0, 5), [], `all requests answered with a well-formed event stream (${failures.length} failures)`);
t.eq(ok, c.requests.length, 'every request succeeded');
t.eq(providerCalls + titles, c.requests.length, 'title requests were answered locally; every chat request reached the provider');
t.eq(sawSystem, providerCalls, 'every provider request carries the system prompt as a system message');
t.ok(sawToolDefs > 0, 'tool definitions were forwarded to the provider');
t.ok(pct(0.95) < 2000, `p95 latency ${pct(0.95)} ms is under the 2000 ms sanity ceiling`);
t.eq(h.logs.filter((l) => l.startsWith('error')), [], 'no error-level log lines');
await h.stop(); provider.close();
t.finish();
