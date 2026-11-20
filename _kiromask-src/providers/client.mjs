// HTTP client for OpenAI-compatible and Anthropic-compatible providers (built on global fetch).

export class ProviderError extends Error {
  constructor(message, { status, retryable = false, provider } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.provider = provider;
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });

export function endpointFor(entry) {
  return `${entry.provider.apiBase}${entry.provider.type === 'anthropic' ? '/messages' : '/chat/completions'}`;
}

export function headersFor(entry, { stream = true } = {}) {
  const { provider } = entry;
  const h = { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' };
  if (provider.apiKey) {
    if (provider.auth === 'x-api-key') h['x-api-key'] = provider.apiKey;
    else if (provider.auth !== 'none') h.authorization = `Bearer ${provider.apiKey}`;
  }
  if (provider.type === 'anthropic') h['anthropic-version'] = '2023-06-01';
  return { ...h, ...entry.headers };
}

/** Pull a human-readable message out of a provider error body. */
export function errorMessage(text, status) {
  try {
    const j = JSON.parse(text);
    const e = j.error ?? j;
    const m = typeof e === 'string' ? e : e.message ?? e.detail ?? j.message ?? j.detail;
    if (m) return typeof m === 'string' ? m : JSON.stringify(m);
  } catch { /* not JSON */ }
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 300) : `HTTP ${status}`;
}

function retryDelay(res, attempt) {
  const ra = res?.headers?.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(ra) - Date.now();
    if (ms > 0) return Math.min(ms, 30_000);
  }
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.random() * base * 0.25;
}

/**
 * POST `body` and return the live Response once headers arrive and look healthy.
 * Retries only before any body bytes are consumed. `signal` aborts everything.
 */
export async function postWithRetry(entry, body, { signal, stream = true, log = () => {} } = {}) {
  const { provider } = entry;
  const url = endpointFor(entry);
  const attempts = Math.max(0, provider.retries) + 1;
  let lastErr;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    // On success the link stays in place for the whole stream: aborting `signal` must still cancel
    // the upstream body while the model is silent. Only failed attempts are unlinked.
    const unlink = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(new Error(`no response headers from ${provider.name} within ${provider.timeoutMs / 1000}s`)), provider.timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers: headersFor(entry, { stream }), body: JSON.stringify(body), signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) return { res, abort: (r) => ctl.abort(r) };
      const text = await res.text().catch(() => '');
      unlink();
      const retryable = RETRY_STATUS.has(res.status);
      const err = new ProviderError(errorMessage(text, res.status), { status: res.status, retryable, provider: provider.name });
      if (!retryable || attempt === attempts - 1) throw err;
      lastErr = err;
      const wait = retryDelay(res, attempt);
      log('warn', `${provider.name} → ${res.status}; retry ${attempt + 1}/${attempts - 1} in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait, signal);
    } catch (e) {
      clearTimeout(timer);
      unlink();
      if (e instanceof ProviderError) throw e;
      if (signal?.aborted) throw signal.reason ?? e;
      const cause = e.cause?.code || e.cause?.message || e.message;
      const err = new ProviderError(`${e.name === 'AbortError' ? ctl.signal.reason?.message || 'request timed out' : `network error: ${cause}`}`, { retryable: true, provider: provider.name });
      if (attempt === attempts - 1) throw err;
      lastErr = err;
      const wait = retryDelay(null, attempt);
      log('warn', `${provider.name} ${err.message}; retry ${attempt + 1}/${attempts - 1} in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait, signal);
    }
  }
  throw lastErr;
}

/** Iterate a body, throwing if no chunk arrives for `ms`. */
export async function* idleGuard(source, ms, onTimeout) {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { onTimeout?.(); reject(new ProviderError(`provider stream stalled (no data for ${Math.round(ms / 1000)}s)`, { retryable: false })); }, ms);
      });
      let r;
      try { r = await Promise.race([it.next(), timeout]); } finally { clearTimeout(timer); }
      if (r.done) return;
      yield r.value;
    }
  } finally {
    it.return?.();
  }
}

/** Non-streaming call; returns the assistant's text. Used for autocomplete and session titles. */
export async function completeOnce(entry, { system, user, maxTokens = 128, temperature = 0 }, opts = {}) {
  let body;
  if (entry.provider.type === 'anthropic') {
    body = { model: entry.upstreamModel, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: user }], ...(system ? { system } : {}) };
  } else {
    body = {
      model: entry.upstreamModel, temperature, [entry.provider.maxTokensParam]: maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
    };
  }
  Object.assign(body, entry.extraBody, { stream: false });
  const { res } = await postWithRetry(entry, body, { ...opts, stream: false });
  const j = await res.json();
  return entry.provider.type === 'anthropic'
    ? (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    : textFromOpenAI(j);
}

export const textFromOpenAI = (j) => {
  const c = j?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '';
};
