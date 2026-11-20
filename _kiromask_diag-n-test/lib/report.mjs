// Turns the raw recording into a readable summary and a list of diagnostic hints.
import dns from 'node:dns';
import net from 'node:net';
import { hostMatcher } from './mitm.mjs';

/** The hosts Kiro Mask decrypts by default (proxy.intercept_hosts). Anything else is merely tunnelled. */
export const KIRO_MASK_DEFAULT_INTERCEPT = ['*.amazonaws.com', '*.kiro.dev', 'kiro.dev'];

export const normalizePath = (p) => String(p).split('/').map((seg) => (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /^\d{4,}$/.test(seg) ? '{id}' : seg)).join('/');

const uniq = (a) => [...new Set(a.filter((x) => x !== undefined && x !== null))];

function classifyHandshakeError(c) {
  const e = `${c.handshake?.error || ''} ${c.handshake?.message || ''}`;
  if (/NO_APPLICATION_PROTOCOL/i.test(e)) return { kind: 'alpn', text: 'the client offered an application protocol (ALPN) this proxy did not' };
  if (/UNKNOWN_CA|BAD_CERTIFICATE|CERTIFICATE_UNKNOWN|CERTIFICATE_VERIFY|CERT/i.test(e)) return { kind: 'cert', text: 'the client rejected the proxy certificate (strict validation or certificate pinning)' };
  if (/NO_SUITABLE_SIGNATURE|NO_SHARED_CIPHER|HANDSHAKE_FAILURE|NO_CIPHERS|WRONG_VERSION|UNSUPPORTED_PROTOCOL|VERSION/i.test(e)) return { kind: 'params', text: 'client and proxy could not agree on TLS parameters (cipher / signature algorithm / version)' };
  if (/closed-before|ECONNRESET|EPIPE/i.test(e)) return { kind: 'closed', text: 'the client closed the connection during the handshake, most often because it rejected the certificate' };
  return { kind: 'other', text: 'handshake failed' };
}

export async function reverseNames(ips, { timeoutMs = 1500, max = 40 } = {}) {
  const out = {};
  await Promise.all(uniq(ips).filter((ip) => net.isIP(ip)).slice(0, max).map(async (ip) => {
    try { out[ip] = (await Promise.race([dns.promises.reverse(ip), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), timeoutMs))]))[0]; } catch { /* no PTR */ }
  }));
  return out;
}

/** Map IPs that Kiro connected to directly onto hostnames the proxy saw (forward-resolving those hostnames). */
export async function forwardMap(hosts, { timeoutMs = 1500, max = 60 } = {}) {
  const map = {};
  await Promise.all(uniq(hosts).filter((h) => !net.isIP(h)).slice(0, max).map(async (h) => {
    try {
      const r = await Promise.race([dns.promises.lookup(h, { all: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
      for (const a of r) (map[a.address] ||= new Set()).add(h);
    } catch { /* unresolvable */ }
  }));
  return map;
}

/** @returns {{data: object, markdown: string}} */
export function buildSummary({ conns, flows, monitor = null, session = {}, names = {}, forward = {} }) {
  const isKnown = hostMatcher(KIRO_MASK_DEFAULT_INTERCEPT);
  const byHost = new Map();
  const H = (h) => byHost.get(h) || byHost.set(h, { host: h, conns: 0, decisions: new Set(), clientAlpn: new Set(), negotiated: new Set(), upstreamAlpn: new Set(), upstreamIssuers: new Set(), handshakeFailures: [], flows: 0, statuses: {}, protos: new Set(), errors: new Set(), ja3: new Set(), ips: false, ws: false }).get(h);
  for (const c of conns) {
    const h = H(c.host);
    h.conns++; h.decisions.add(c.decision || '?'); h.ips ||= c.isIP; h.ws ||= c.ws;
    for (const a of c.hello?.alpn?.length ? c.hello.alpn : c.hello?.ok ? ['(none)'] : []) h.clientAlpn.add(a);
    if (c.hello?.ja3) h.ja3.add(c.hello.ja3);
    if (c.handshake?.ok && c.handshake.alpn) h.negotiated.add(c.handshake.alpn);
    if (c.upstream?.alpn) h.upstreamAlpn.add(c.upstream.alpn);
    if (c.upstream?.ok && c.upstream.authorized === false) h.upstreamIssuers.add(`${c.upstream.issuer || '?'} (${c.upstream.authorizationError})`);
    if (c.handshake && !c.handshake.ok) h.handshakeFailures.push({ conn: c.id, ...classifyHandshakeError(c), error: c.handshake.error, offered: c.hello?.alpn || null, sni: c.hello?.sni || null });
    for (const e of c.errors || []) h.errors.add(e);
  }
  for (const f of flows) {
    const h = H(f.host);
    h.flows++; h.protos.add(f.proto); h.statuses[f.status ?? 'none'] = (h.statuses[f.status ?? 'none'] || 0) + 1;
    if (f.err) h.errors.add(f.err);
  }

  const endpoints = new Map();
  for (const f of flows) {
    // JSON-RPC style services call everything `POST /`; the operation is in X-Amz-Target
    const op = f.target ? String(f.target).split('.').pop() : null;
    const shownPath = op ? `${normalizePath(f.path)} [${f.target}]` : normalizePath(f.path);
    const key = `${f.host} ${f.method} ${shownPath}`;
    const e = endpoints.get(key) || { host: f.host, method: f.method, path: shownPath, count: 0, statuses: new Set(), contentTypes: new Set(), protos: new Set(), bytesOut: 0, bytesIn: 0 };
    e.count++; e.statuses.add(f.status ?? 'none'); if (f.ct) e.contentTypes.add(String(f.ct).split(';')[0]); e.protos.add(f.proto); e.bytesOut += f.reqBytes || 0; e.bytesIn += f.resBytes || 0;
    endpoints.set(key, e);
  }

  // ── hints ──
  const hints = [];
  const hint = (severity, text, extra = {}) => hints.push({ severity, text, ...extra });
  const hosts = [...byHost.values()];
  if (!conns.length) hint('critical', 'Nothing connected through the proxy. Either Kiro was not started with the proxy flags (an already-running Kiro instance ignores them), Kiro does not honour --proxy-server any more, or it was closed immediately.');
  const unknown = hosts.filter((h) => !isKnown(h.host) && !(net.isIP(h.host) && false));
  if (unknown.length) hint('important', `${unknown.length} host(s) were contacted that are outside Kiro Mask's default intercept list (*.amazonaws.com, *.kiro.dev), so Kiro Mask would only tunnel them blind: ${unknown.map((h) => h.host).slice(0, 25).join(', ')}. If Kiro's traffic moved to such a host, it must be added to proxy.intercept_hosts.`, { hosts: unknown.map((h) => h.host) });
  for (const h of hosts) {
    for (const [kind, items] of Object.entries(groupBy(h.handshakeFailures, (x) => x.kind))) {
      hint('important', `${h.host}: ${items.length} TLS handshake failure(s) — ${items[0].text}. Client offered ALPN ${JSON.stringify(items[0].offered)}; error ${items[0].error}.`, { host: h.host, kind });
    }
    if (h.clientAlpn.size === 1 && h.clientAlpn.has('h2')) hint('important', `${h.host}: the client offers ONLY HTTP/2 (h2). A proxy that forces HTTP/1.1 cannot talk to it.`, { host: h.host });
    if (h.negotiated.has('h2')) hint('info', `${h.host}: HTTP/2 was negotiated (${h.flows} request(s)). A proxy without HTTP/2 support would have failed or missed these.`, { host: h.host });
    if (h.ws) hint('important', `${h.host}: WebSocket upgrade(s) observed — a proxy that does not handle upgrades would drop these.`, { host: h.host });
    if (h.ips) hint('info', `${h.host}: connection made to an IP address (no hostname). Proxies that skip IP targets would tunnel it blind.`, { host: h.host });
    if (h.decisions.has('tunnel(non-tls)')) hint('info', `${h.host}: plaintext (non-TLS) traffic inside CONNECT.`, { host: h.host });
    if (h.upstreamIssuers.size) hint('important', `${h.host}: the REAL server's certificate does not validate on this machine (${[...h.upstreamIssuers][0]}). Something between you and the internet inspects TLS (corporate proxy, antivirus, VPN).`, { host: h.host });
    if (h.errors.size) hint('info', `${h.host}: errors during the session: ${[...h.errors].slice(0, 3).join('; ')}`, { host: h.host });
  }
  const chat = flows.filter((f) => /generateassistantresponse/i.test(f.path) || /generateassistantresponse/i.test(f.target || ''));
  if (chat.length) hint('info', `Chat endpoint seen: ${uniq(chat.map((f) => `${f.host}${f.target ? ` [${f.target}]` : normalizePath(f.path)} [${f.proto}]`)).join(', ')} (${chat.length} request(s)).`);
  else if (conns.length) hint('important', 'No GenerateAssistantResponse request was recorded (neither by path nor by X-Amz-Target). If you sent a chat message during the capture, the chat traffic is either going somewhere that bypasses the proxy (see the bypass section) or uses a different path/protocol (see the endpoint table).');

  // bypass
  const bypass = { processes: [], direct: [], byProcess: [] };
  if (monitor) {
    bypass.processes = monitor.processes;
    bypass.direct = monitor.direct.map((d) => ({ ...d, names: uniq([names[d.remoteIp], ...(forward[d.remoteIp] ? [...forward[d.remoteIp]] : [])]) }));
    for (const [proc, items] of Object.entries(groupBy(bypass.direct, (d) => d.process))) {
      bypass.byProcess.push({ process: proc, exe: items[0].exe, connections: items.length, remotes: uniq(items.map((i) => `${i.names.length ? i.names.join('|') + ' ' : ''}${i.remote}`)).slice(0, 30) });
    }
    for (const b of bypass.byProcess) hint('critical', `Process "${b.process}" opened ${b.connections} connection(s) DIRECTLY to the internet, bypassing the proxy: ${b.remotes.slice(0, 6).join(', ')}. This process ignores --proxy-server, so no proxy-based tool (this one or Kiro Mask) can see its traffic.`, { process: b.process });
    const proxiedProcs = bypass.processes.filter((p) => p.proxiedConns > 0).map((p) => p.name);
    if (proxiedProcs.length) hint('info', `Processes that DID use the proxy: ${uniq(proxiedProcs).join(', ')}.`);
    if (!bypass.processes.length) hint('important', 'No Kiro processes were detected by the process monitor (cannot tell whether anything bypassed the proxy).');
  }
  const order = { critical: 0, important: 1, info: 2 };
  hints.sort((a, b) => order[a.severity] - order[b.severity]);

  const data = {
    session,
    totals: { connections: conns.length, intercepted: conns.filter((c) => c.decision === 'intercept').length, tunnelled: conns.filter((c) => String(c.decision).startsWith('tunnel')).length, handshakeFailures: conns.filter((c) => c.handshake && !c.handshake.ok).length, flows: flows.length, hosts: hosts.length },
    hints,
    hosts: hosts.map((h) => ({ host: h.host, known: isKnown(h.host), conns: h.conns, decisions: [...h.decisions], clientAlpn: [...h.clientAlpn], negotiated: [...h.negotiated], upstreamAlpn: [...h.upstreamAlpn], handshakeFailures: h.handshakeFailures.length, flows: h.flows, statuses: h.statuses, protocols: [...h.protos], ja3: [...h.ja3] })),
    endpoints: [...endpoints.values()].map((e) => ({ ...e, statuses: [...e.statuses], contentTypes: [...e.contentTypes], protos: [...e.protos] })).sort((a, b) => b.count - a.count),
    bypass,
  };
  return { data, markdown: toMarkdown(data) };
}

function groupBy(arr, fn) { const o = {}; for (const x of arr) (o[fn(x)] ||= []).push(x); return o; }

function toMarkdown(d) {
  const L = [];
  const t = d.totals;
  L.push('# Kiro Mask capture summary', '');
  L.push(`- Connections through the proxy: **${t.connections}** (intercepted ${t.intercepted}, tunnelled ${t.tunnelled}, handshake failures **${t.handshakeFailures}**)`);
  L.push(`- Requests recorded: **${t.flows}** across **${t.hosts}** host(s)`);
  if (d.session.kiro?.product?.version) L.push(`- Kiro version: ${d.session.kiro.product.version}${d.session.kiro.product.commit ? ` (${String(d.session.kiro.product.commit).slice(0, 8)})` : ''}`);
  L.push('', '## Findings', '');
  if (!d.hints.length) L.push('_No findings._');
  for (const h of d.hints) L.push(`- **${h.severity.toUpperCase()}** — ${h.text}`);
  L.push('', '## Hosts', '', '| host | in Kiro Mask default list | conns | decision | client ALPN | negotiated | upstream ALPN | handshake fails | requests | statuses |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const h of d.hosts.sort((a, b) => b.conns - a.conns)) L.push(`| ${h.host} | ${h.known ? 'yes' : '**NO**'} | ${h.conns} | ${h.decisions.join(', ')} | ${h.clientAlpn.join(', ') || '-'} | ${h.negotiated.join(', ') || '-'} | ${h.upstreamAlpn.join(', ') || '-'} | ${h.handshakeFailures} | ${h.flows} | ${Object.entries(h.statuses).map(([k, v]) => `${k}×${v}`).join(' ') || '-'} |`);
  L.push('', '## Endpoints', '', '| host | method | path | n | status | content-type | proto |', '|---|---|---|---|---|---|---|');
  for (const e of d.endpoints.slice(0, 80)) L.push(`| ${e.host} | ${e.method} | \`${e.path}\` | ${e.count} | ${e.statuses.join(',')} | ${e.contentTypes.join(', ') || '-'} | ${e.protos.join(',')} |`);
  if (d.bypass.processes.length) {
    L.push('', '## Kiro processes', '', '| pid | name | via proxy | direct (bypass) | exe |', '|---|---|---|---|---|');
    for (const p of d.bypass.processes) L.push(`| ${p.pid} | ${p.name} | ${p.proxiedConns} | ${p.directConns} | ${p.exe || ''} |`);
  }
  if (d.bypass.direct.length) {
    L.push('', '## Direct connections that bypassed the proxy', '', '| process | remote | name(s) |', '|---|---|---|');
    for (const x of d.bypass.direct.slice(0, 100)) L.push(`| ${x.process} (${x.pid}) | ${x.remote} | ${x.names.join(', ') || '?'} |`);
  }
  return L.join('\n') + '\n';
}
