// Self-healing for provider quirks. When a provider rejects a request (HTTP 400/422) for a reason we can
// fix mechanically, adapt the request once and remember the fix per model so later requests are right first time.
//
//   • stream_options / include_usage not supported      → drop stream_options
//   • max_tokens vs max_completion_tokens               → switch the parameter name
//   • "supports at most N completion tokens"            → clamp max tokens to N

const LIMIT_WORDS = /\b(maximum|at most|must be|less than|no more than|exceeds?|too (?:large|high|big)|limit|supports?)\b|<=/i;
const TOKEN_FIELD = /max(?:imum)?[_ ]?(?:completion[_ ])?tokens|output tokens|completion tokens/i;
const REJECT = /unsupported|not supported|unknown|unrecognized|unexpected|invalid|use|instead|not allowed|extra/i;
const KEYS = ['max_tokens', 'max_completion_tokens'];

const tokenKey = (body) => KEYS.find((k) => k in body);

/** @returns {{body: object, patch: object, note: string} | null} */
export function adaptRequest(body, message, { type = 'openai' } = {}) {
  const msg = String(message || '');

  if (body.stream_options && /stream_options|include_usage/i.test(msg)) {
    const { stream_options: _drop, ...rest } = body;
    return { body: rest, patch: { noStreamOptions: true }, note: 'provider rejected stream_options; retrying without it' };
  }

  const key = tokenKey(body);
  if (type === 'openai' && key) {
    const other = key === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    const mentionsOther = new RegExp(`\\b${other}\\b`, 'i').test(msg);
    const mentionsKey = new RegExp(`\\b${key}\\b`, 'i').test(msg);
    if (mentionsOther && REJECT.test(msg) && (!mentionsKey || /unsupported|not supported|instead|use/i.test(msg))) {
      const { [key]: v, ...rest } = body;
      return { body: { ...rest, [other]: v }, patch: { maxTokensParam: other }, note: `provider wants ${other} instead of ${key}; retrying` };
    }
  }

  const cur = key ? body[key] : undefined;
  if (Number.isInteger(cur) && TOKEN_FIELD.test(msg) && LIMIT_WORDS.test(msg)) {
    const nums = (msg.match(/\d[\d,]*/g) || []).map((n) => Number(n.replace(/,/g, ''))).filter((n) => n >= 256 && n < cur);
    if (nums.length) {
      const n = Math.max(...nums);
      return { body: { ...body, [key]: n }, patch: { maxTokens: n }, note: `provider caps output at ${n} tokens; retrying (set max_tokens: ${n} for this model to skip this step)` };
    }
  }
  return null;
}

/** Re-apply fixes learned earlier to a freshly translated body. */
export function applyPatch(body, patch) {
  if (!patch) return body;
  const b = { ...body };
  if (patch.noStreamOptions) delete b.stream_options;
  let key = tokenKey(b);
  if (key && patch.maxTokensParam && key !== patch.maxTokensParam) { b[patch.maxTokensParam] = b[key]; delete b[key]; key = patch.maxTokensParam; }
  if (key && patch.maxTokens && b[key] > patch.maxTokens) b[key] = patch.maxTokens;
  return b;
}
