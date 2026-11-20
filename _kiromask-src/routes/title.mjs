// Session titles. Kiro sends a "simple-task" request (agentMode "session-title") asking for a 3–6 word title for the
// conversation, built from the user's first message. Answered locally by default: instant, free, and nothing about
// your first message is sent to Kiro's servers. Optionally ask a model, or pass through to Kiro.
import { ev } from '../aws/eventstream.mjs';
import { completeOnce } from '../providers/client.mjs';
import { responsesTextStream } from '../translate/encoders.mjs';
import { startStream } from './common.mjs';
import { describeChat } from './describe.mjs';

const GREETING = /^(?:hi|hello|hey|hiya|howdy|yo|greetings|good (?:morning|afternoon|evening)|dear [\w .-]{1,30}?)\b(?:[\s,]+(?:there|team|kiro|everyone|all|folks|assistant))?[\s!,.:;-]*/i;
const LEADS = [
  /^(?:could|can|would|will) you (?:please |kindly )?(?:help me (?:to )?)?/i,
  /^(?:please|kindly)\s+/i,
  /^i(?:'d| would| want| need)?\s*(?:like |love )?(?:for )?(?:you )?to\s+/i,
  /^i (?:want|need|'d like|would like)(?: for)?\s+(?:you\s+)?(?:to\s+)?/i,
  /^(?:let'?s|let us)\s+/i,
  /^help me (?:to )?/i,
  /^(?:i'm|i am) (?:trying|looking|working) (?:to|on|for)\s+/i,
];
const FILLER = new Set(['please', 'kindly', 'just', 'really', 'actually', 'basically', 'me', 'you', 'my', 'your', 'our', 'us', 'thanks', 'thank']);
const TRAIL = new Set(['and', 'or', 'to', 'the', 'a', 'an', 'of', 'in', 'for', 'with', 'that', 'what', 'which', 'is', 'are', 'it', 'on', 'at', 'by', 'as', 'into', 'from', 'about', 'where', 'when', 'why', 'how', 'who', 'because', 'if', 'so', 'but', 'then', 'also']);
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with', 'into', 'from']);

const bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Kiro appends the user's first message after the LAST <first_message> tag (its own instructions mention the tag
 * earlier in the text). Falls back to the whole text when the tag is absent.
 */
export function firstMessage(content) {
  const text = String(content || '');
  const tag = '<first_message>';
  const open = text.toLowerCase().lastIndexOf(tag);
  if (open === -1) return text.trim();
  let t = text.slice(open + tag.length);
  const close = t.toLowerCase().indexOf('</first_message>');
  if (close !== -1) t = t.slice(0, close);
  return t.trim();
}

const TITLE_PROMPT = /short title for a coding assistant session/i;

/** Accepts a describeChat() summary or the raw request body (either wire format). */
export function isTitleRequest(bodyOrChat, headers = {}) {
  const chat = bodyOrChat && 'format' in bodyOrChat ? bodyOrChat : describeChat(bodyOrChat);
  return chat?.agentMode === 'session-title'
    || /session-title/i.test(String(headers['x-amzn-kiro-mode-identifier'] || ''))
    || (chat?.modelId === 'simple-task' && TITLE_PROMPT.test(chat?.userText || ''));
}

/** A short Title-Case title from the user's first message: drops greetings/politeness, keeps the gist. */
export function localTitle(text, { maxWords = 6, maxChars = 60 } = {}) {
  let t = String(text || '').replace(/[\u2018\u2019]/g, "'")
    .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/[*_#>~|]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(GREETING, '');
  for (let pass = 0; pass < 3; pass++) for (const re of LEADS) t = t.replace(re, '');
  let sentence = t.split(/[.!?]+(?:\s|$)|\n/)[0] || t;
  let words = sentence.split(' ').map((w) => w.replace(/^[^\p{L}\p{N}./\\_-]+|[^\p{L}\p{N}]+$/gu, '')).filter((w) => w && !FILLER.has(bare(w)));
  words = words.slice(0, maxWords);
  while (words.length > 1 && TRAIL.has(bare(words.at(-1)))) words.pop();
  if (!words.length) return 'New Chat';
  const cased = words.map((w, i) => {
    if (/[./\\_]/.test(w) || /^[A-Z0-9]{2,}$/.test(w) || /[a-z][A-Z]/.test(w)) return w; // file names, acronyms, camelCase
    if (i > 0 && SMALL.has(w.toLowerCase())) return w.toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  let title = cased.join(' ');
  if (title.length > maxChars) title = title.slice(0, maxChars).replace(/\s+\S*$/, '');
  return title;
}

const TITLE_SYSTEM = 'You write a short title for a coding assistant session: 3 to 6 words, Title Case, no quotes, no trailing punctuation. Reply with the title only.';

/** Tidy a model's answer into a title. Returns null if it is unusable. */
export function cleanModelTitle(text) {
  const t = String(text || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim().split('\n').find((l) => l.trim()) || '';
  const c = t.replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').replace(/^title:\s*/i, '').trim();
  return c && c.split(/\s+/).length <= 12 ? c : null;
}

export const titleFrames = (title, modelId = 'simple-task') => [
  ev.initialResponse(), ev.text('', modelId), ev.text(title, modelId), ev.metadata('END_TURN'), ev.contextUsage(1.5),
];

export const titleResponse = (title, chat) => (chat?.format === 'responses'
  ? responsesTextStream(title, { model: chat.modelId, metadata: chat.metadata, contextPct: 1.5 })
  : titleFrames(title));

export async function handleTitle(ctx, raw) {
  const { app, cfg, res, log, chat } = ctx;
  const mode = String(cfg.get('session_title', 'local'));
  const nativeOk = cfg.get('kiro_endpoint.models') && !cfg.get('kiro_endpoint.auth_fake_login');

  if (mode === 'passthrough' && nativeOk) {
    log('info', 'session title → Kiro (passthrough)');
    return app.pass(ctx, { body: raw });
  }

  const first = firstMessage(chat.userText);
  let title = null;
  let source = 'local';
  if (mode !== 'local' && mode !== 'passthrough') {
    const r = mode === 'current' ? cfg.resolve(app.state.lastModel) : cfg.resolve(mode);
    const entry = r && r !== 'native' ? r : cfg.defaultEntry;
    if (entry) {
      try {
        title = cleanModelTitle(await completeOnce(entry, { system: TITLE_SYSTEM, user: first.slice(0, 2000), maxTokens: 40 }, { log }));
        if (title) source = entry.id; else log('warn', `session title: ${entry.id} gave no usable title; using the local one`);
      } catch (e) { log('warn', `session title: ${entry.id} failed (${e.message}); using the local one`); }
    }
  }
  title ||= localTitle(first);
  log('info', `session title → "${title}" (${source})`);
  ctx.flow?.note({ handled: `title (${source})` });
  startStream(res, chat.format);
  await ctx.send(titleResponse(title, chat));
  res.end();
}
