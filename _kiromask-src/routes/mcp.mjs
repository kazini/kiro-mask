// /mcp (JSON-RPC): customise or replace Kiro's built-in `web_search` tool.
import { execFile } from 'node:child_process';
import { readBody } from '../util.mjs';
import { jsonFor } from './common.mjs';

export const DEFAULT_WEB_SEARCH = {
  name: 'web_search',
  description: "Look up information that is outside the model's training data or cannot be inferred from the codebase. Use it for current or up-to-date information (pricing, versions, specs) or when the user asks for a web search. Provide inline links to sources.",
  inputSchema: { additionalProperties: false, type: 'object', properties: { query: { type: 'string', description: 'The search query to execute. Must be 200 characters or less.' } }, required: ['query'] },
};

export function normalizeWebSearch(v) {
  if (v == null || v === 'default' || v === true) return { mode: 'default' };
  if (['enforce', 'enforced', 'aws-enforce'].includes(v)) return { mode: 'enforce' };
  if (['disabled', 'none', 'off', false].includes(v)) return { mode: 'disabled' };
  if (typeof v === 'object') return { mode: 'custom', ...v };
  return { mode: 'default' };
}

/** Pure: rewrite a tools/list result's tool array for the given web_search setting. */
export function modifyTools(tools, ws) {
  const list = Array.isArray(tools) ? tools : [];
  const aws = list.find((t) => t.name === 'web_search');
  const rest = list.filter((t) => t.name !== 'web_search');
  switch (ws.mode) {
    case 'disabled': return rest;
    case 'enforce': return [...rest, aws ?? DEFAULT_WEB_SEARCH];
    case 'custom': return [...rest, {
      ...(aws ?? DEFAULT_WEB_SEARCH),
      ...(ws.description ? { description: ws.description } : {}),
      ...((ws.inputSchema ?? ws.input_schema) ? { inputSchema: ws.inputSchema ?? ws.input_schema } : {}),
    }];
    default: return list;
  }
}

const textResult = (id, payload) => ({ jsonrpc: '2.0', id, error: null, result: { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] } });
const rpcError = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } });

const run = (cmd, args, input, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
    if (input != null) p.stdin.end(input); else p.stdin?.end();
  });

/** Execute a configured search backend. Returns a JSON-RPC response object. */
export async function executeSearch(execute, rpc, fetchImpl = fetch) {
  const query = rpc.params?.arguments?.query ?? '';
  const id = rpc.id ?? 'web_search_1';
  const type = execute.type || 'http';
  const headers = { 'content-type': 'application/json', ...(execute.api_key ? { authorization: `Bearer ${execute.api_key}` } : {}), ...(execute.headers || {}) };
  const timeout = AbortSignal.timeout((execute.timeout_s ?? 30) * 1000);

  if (type === 'mcp_server') {
    const r = await fetchImpl(execute.url, { method: 'POST', headers, body: JSON.stringify(rpc), signal: timeout });
    return await r.json();
  }
  if (type === 'binary' || type === 'command') {
    const cmd = execute.command ?? execute.url;
    const argv = Array.isArray(cmd) ? cmd : [cmd];
    const out = await run(argv[0], [...argv.slice(1), ...(execute.args || []), ...(execute.stdin ? [] : [query])], execute.stdin ? query : null, (execute.timeout_s ?? 30) * 1000);
    try { const j = JSON.parse(out); return textResult(id, { results: (j && !Array.isArray(j) && j.results) || j }); }
    catch { return textResult(id, { results: [{ text: out }] }); }
  }
  // http: POST {query}
  const r = await fetchImpl(execute.url, { method: 'POST', headers, body: JSON.stringify({ query }), signal: timeout });
  if (!r.ok) return textResult(id, { error: `HTTP ${r.status}`, results: [] });
  const j = await r.json();
  return textResult(id, { results: (j && !Array.isArray(j) && j.results) || j });
}

export async function handleMcp(ctx) {
  const { app, cfg, req, res, log } = ctx;
  const raw = await readBody(req);
  let rpc = {};
  try { rpc = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
  const ws = normalizeWebSearch(cfg.get('web_search'));
  const fake = cfg.get('kiro_endpoint.auth_fake_login');

  if (rpc.method === 'tools/list' && ws.mode !== 'default') {
    const rewrite = (tools) => modifyTools(tools, ws);
    if (fake) return jsonFor(ctx, 200, { jsonrpc: '2.0', id: rpc.id, result: { tools: rewrite([]) } });
    return app.pass(ctx, {
      body: raw,
      transform: (buf) => {
        const j = JSON.parse(buf.toString('utf8'));
        if (!j?.result) return buf;
        j.result.tools = rewrite(j.result.tools);
        log('info', `mcp tools/list → web_search ${ws.mode}`);
        return Buffer.from(JSON.stringify(j));
      },
    });
  }

  if (rpc.method === 'tools/call' && rpc.params?.name === 'web_search') {
    if (ws.mode === 'custom' && ws.execute) {
      try {
        log('info', `web_search → ${ws.execute.type || 'http'}: ${JSON.stringify(rpc.params?.arguments?.query ?? '').slice(0, 80)}`);
        return jsonFor(ctx, 200, await executeSearch(ws.execute, rpc));
      } catch (e) {
        log('warn', `web_search backend failed: ${e.message}`);
        return jsonFor(ctx, 200, rpcError(rpc.id, `web search failed: ${e.message}`));
      }
    }
    if (ws.mode === 'disabled' || fake) return jsonFor(ctx, 200, rpcError(rpc.id, 'web_search is not available'));
  }
  return fake ? jsonFor(ctx, 200, { jsonrpc: '2.0', id: rpc.id, result: {} }) : app.pass(ctx, { body: raw });
}
