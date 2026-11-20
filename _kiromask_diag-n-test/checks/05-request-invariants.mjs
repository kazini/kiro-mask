// Every REAL Kiro request is translated to OpenAI and Anthropic bodies and the structural rules those
// APIs enforce are asserted: tool-call/result pairing, role alternation, user-first, tool_result ordering,
// valid names, sanitised schemas, system prompt extracted, nothing silently dropped.
import { createCheck, skip } from '../lib/check.mjs';
import { imp, captureFiles, readRequest, isTitleBody } from '../lib/paths.mjs';

const c = captureFiles();
if (!c?.requests.length) skip('KIROMASK_CAPTURES not set');
const { Config } = await imp('config/load.mjs');
const { translateRequest } = await imp('translate/request.mjs');
const t = createCheck(`Request translation invariants over ${c.requests.length} real requests`);

const cfg = new Config({ providers: {
  oa: { enabled: true, type: 'openai', api_base: 'http://x/v1', api_key: 'k', models: [{ name: 'm-oa' }] },
  an: { enabled: true, type: 'anthropic', api_key: 'k', models: [{ name: 'm-an' }] } } });
const OA = cfg.resolve('m-oa'), AN = cfg.resolve('m-an');
let toolCalls = 0, withSystem = 0, translations = 0, sourceUses = 0, outUses = 0, chats = 0, titles = 0, expectedSystem = 0;
const problems = [];
const bad = (f, m) => problems.push(`${f.split('/').pop()}: ${m}`);

for (const f of c.requests) {
  const { kiro, format } = readRequest(f);
  // The two wire formats carry the same facts differently: system prompt + canned ack, and the tool calls made so far.
  let ack, sysText, srcUses;
  if (format === 'aws') {
    const hist = kiro.conversationState.history || [];
    ack = /^\s*I will follow these instructions\.?\s*$/i.test(hist[1]?.assistantResponseMessage?.content || '');
    sysText = hist[0]?.userInputMessage?.content || '';
    srcUses = hist.reduce((n, h) => n + (h.assistantResponseMessage?.toolUses?.length || 0), 0);
  } else {
    const items = Array.isArray(kiro.input) ? kiro.input : [];
    const txt = (c) => (typeof c === 'string' ? c : (c || []).map((p) => p.text || '').join('\n'));
    ack = /^\s*I will follow these instructions\.?\s*$/i.test(txt(items[1]?.content));
    sysText = txt(items[0]?.content);
    srcUses = items.filter((i) => i.type === 'function_call').length;
  }
  const isTitle = isTitleBody(kiro);
  if (isTitle) titles++; else chats++;
  sourceUses += srcUses;

  const oa = translateRequest(kiro, OA).body; translations++;
  const ms = oa.messages;
  if (ack) expectedSystem++;
  if (ms[0].role === 'system') withSystem++;
  if (ms.find((m) => m.role !== 'system')?.role !== 'user') bad(f, 'openai: first non-system message is not user');
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.tool_calls) {
      const ids = m.tool_calls.map((x) => x.id).sort(); toolCalls += ids.length; outUses += ids.length;
      const got = []; for (let j = i + 1; ms[j]?.role === 'tool'; j++) got.push(ms[j].tool_call_id);
      if (ids.join() !== got.sort().join()) bad(f, `openai: tool_calls ${ids} != tool messages ${got}`);
      for (const x of m.tool_calls) { try { JSON.parse(x.function.arguments); } catch { bad(f, 'openai: tool_call arguments not valid JSON'); } }
    }
    if (m.role === 'tool' && !(ms[i - 1]?.role === 'tool' || ms[i - 1]?.tool_calls)) bad(f, 'openai: orphan tool message');
    if (i && ['user', 'assistant'].includes(m.role) && m.role === ms[i - 1].role) bad(f, `openai: consecutive ${m.role}`);
    if (m.role === 'user' && !(typeof m.content === 'string' ? m.content.trim() : m.content.length)) bad(f, 'openai: empty user message');
  }
  for (const tl of oa.tools || []) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tl.function.name)) bad(f, `openai: invalid tool name ${tl.function.name}`);
    if (/"anyOf"|"\$schema"|"not"/.test(JSON.stringify(tl.function.parameters))) bad(f, 'openai: schema not sanitised');
    if ('json' in tl.function.parameters && Object.keys(tl.function.parameters).length === 1) bad(f, 'openai: schema still wrapped in {json:…}');
  }

  const an = translateRequest(kiro, AN).body;
  if (an.messages[0].role !== 'user') bad(f, 'anthropic: first message is not user');
  an.messages.forEach((m, i) => {
    if (i && m.role === an.messages[i - 1].role) bad(f, `anthropic: roles do not alternate at ${i}`);
    if (!Array.isArray(m.content) || !m.content.length) bad(f, 'anthropic: empty content');
    if (m.role === 'assistant') {
      const uses = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id).sort();
      if (uses.length) {
        const res = (an.messages[i + 1]?.content || []).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id).sort();
        if (uses.join() !== res.join()) bad(f, 'anthropic: tool_use/tool_result mismatch');
      }
    } else {
      const types = m.content.map((b) => b.type); const first = types.findIndex((x) => x !== 'tool_result');
      if (first !== -1 && types.slice(first).includes('tool_result')) bad(f, 'anthropic: tool_result after other blocks');
    }
  });
  if (ack && !an.system?.[0]?.text?.startsWith(sysText.slice(0, 40))) bad(f, 'anthropic: system prompt not extracted');
  if (ack && ms[0].role !== 'system') bad(f, 'openai: system prompt not extracted');
  if (!ack && ms[0].role === 'system') bad(f, 'openai: system message invented for a conversation without one');
}

t.info(`${chats} chat + ${titles} title requests → ${translations * 2} translations, ${toolCalls} tool calls paired, ${withSystem}/${expectedSystem} system prompts extracted`);
t.eq(withSystem, expectedSystem, 'a system message exists exactly when Kiro sent its system prompt (user turn + ack)');
t.eq(problems.slice(0, 10), [], `no structural problems (${problems.length} found)`);
t.eq(outUses, sourceUses, 'every tool call in Kiro history survives translation (none dropped by pairing repair)');
t.finish();
