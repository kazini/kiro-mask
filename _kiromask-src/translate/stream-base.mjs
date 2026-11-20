// Shared machinery for turning provider streams into Kiro's event stream:
// reasoning handling, <think> filtering, tool-call emission (with JSON repair),
// and the closing usage / context events.

import { randomBytes } from 'node:crypto';
import { awsEncoder } from './encoders.mjs';
import { parseToolArgs } from './json-repair.mjs';

export class StreamError extends Error {
  constructor(message, { status, type } = {}) {
    super(message);
    this.name = 'StreamError';
    this.status = status;
    this.type = type;
  }
}

export const newToolId = () => `tooluse_${randomBytes(11).toString('base64url')}`;

const OPEN_TAGS = ['<think>', '<thinking>'];
const CLOSE_TAGS = ['</think>', '</thinking>'];

/** Longest suffix of `s` that is a proper prefix of any tag (it might be completed by the next chunk). */
function partialSuffix(s, tags) {
  let best = 0;
  for (const tag of tags) {
    for (let k = Math.min(tag.length - 1, s.length); k > best; k--) {
      if (tag.startsWith(s.slice(-k))) { best = k; break; }
    }
  }
  return best;
}

/** Streaming remover for <think>…</think> spans, safe against tags split across chunks. */
export class ThinkFilter {
  constructor() { this.buf = ''; this.inThink = false; this.trimLead = false; }

  push(text) {
    this.buf += text;
    let out = '';
    for (;;) {
      if (!this.inThink) {
        const i = this.buf.indexOf('<think');
        if (i === -1) {
          const keep = partialSuffix(this.buf, OPEN_TAGS);
          out += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          break;
        }
        const rest = this.buf.slice(i);
        const m = /^<think(?:ing)?>/.exec(rest);
        if (m) { out += this.buf.slice(0, i); this.buf = rest.slice(m[0].length); this.inThink = true; continue; }
        if ('<thinking>'.startsWith(rest)) { out += this.buf.slice(0, i); this.buf = rest; break; } // tag not complete yet
        out += this.buf.slice(0, i + 6); this.buf = this.buf.slice(i + 6); // e.g. "<thinker>" — not a tag
      } else {
        const m = /<\/think(?:ing)?>/.exec(this.buf);
        if (m) { this.buf = this.buf.slice(m.index + m[0].length); this.inThink = false; this.trimLead = true; continue; }
        const keep = partialSuffix(this.buf, CLOSE_TAGS);
        this.buf = this.buf.slice(this.buf.length - keep);
        break;
      }
    }
    if (this.trimLead && out) { out = out.replace(/^\s+/, ''); if (out) this.trimLead = false; }
    return out;
  }

  /** End of stream: release held-back text (unless we're inside a think span). */
  flush() {
    const rest = this.inThink ? '' : this.buf;
    this.buf = '';
    return this.trimLead ? rest.replace(/^\s+/, '') : rest;
  }
}

const chunkString = (s, size = 8192) => {
  const parts = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts.length ? parts : [''];
};

/**
 * Base class: subclasses parse one provider's chunks and call
 * onContent / onReasoning / toolBegin / toolArgs / toolEnd / setUsage / setFinish.
 */
export class KiroStreamBase {
  /**
   * @param {object} o
   * @param {{toOriginal: Map<string,string>}} [o.nameMap]
   * @param {'drop'|'keep'|'native'} [o.reasoning]  drop = hide, keep = fenced block in the answer, native = Kiro's own reasoning events (experimental)
   * @param {string} [o.modelId]  the model id Kiro asked for; echoed on text events like the real service
   * @param {'buffer'|'stream'} [o.toolArgs]
   * @param {number} [o.contextWindow]
   * @param {number} [o.estimatedPromptTokens]  used when the provider reports no usage
   * @param {boolean} [o.metering]
   * @param {object} [o.encoder]  what to encode into (translate/encoders.mjs): the AWS event stream (default) or Responses SSE
   */
  constructor({ nameMap, reasoning = 'drop', toolArgs = 'buffer', contextWindow = 200000, estimatedPromptTokens = 0, metering = false, modelId = null, encoder = awsEncoder() } = {}) {
    this.enc = encoder;
    this.nameMap = nameMap;
    this.modelId = modelId;
    this.started = false;
    this.reasoningMode = reasoning;
    this.toolMode = toolArgs;
    this.contextWindow = contextWindow;
    this.estimatedPromptTokens = estimatedPromptTokens;
    this.metering = metering;
    this.think = reasoning === 'keep' ? null : new ThinkFilter(); // <think> spans are never shown as answer text unless reasoning: keep
    this.out = [];
    this.slots = [];
    this.inReasoning = false;
    this.stats = { textChars: 0, toolCalls: 0, repairedToolCalls: 0, droppedToolCalls: 0, finishReason: null };
    this.usage = { prompt: 0, completion: 0, reported: false };
  }

  /** Frames produced so far. The first call prepends the response preamble the real service sends. */
  drain() {
    if (!this.started) { this.started = true; this.out.unshift(...this.enc.initial(), ...this.enc.text('', this.modelId)); }
    const o = this.out; this.out = []; return o;
  }

  // ── text & reasoning ──
  emitText(s) {
    if (!s) return;
    this.#closeReasoning();
    this.out.push(...this.enc.text(s, this.modelId));
    this.stats.textChars += s.length;
  }
  onContent(raw) { this.emitText(this.think ? this.think.push(raw) : raw); }
  onReasoning(r) {
    if (!r) return;
    if (this.reasoningMode === 'native') { this.out.push(...this.enc.reasoning(r)); return; }
    if (this.reasoningMode !== 'keep') return;
    if (!this.inReasoning) { this.inReasoning = true; this.out.push(...this.enc.text('```thinking\n', this.modelId)); }
    this.out.push(...this.enc.text(r, this.modelId));
  }
  #closeReasoning() {
    if (this.inReasoning) { this.inReasoning = false; this.out.push(...this.enc.text('\n```\n\n', this.modelId)); }
  }

  // ── tools ──
  #name(slot) { return this.nameMap?.toOriginal?.get(slot.name) ?? slot.name; }

  toolBegin(slot) {
    if (slot.started || !slot.name) return;
    slot.id ||= newToolId();
    slot.started = true;
    if (this.toolMode === 'stream') {
      this.out.push(...this.enc.toolStart(this.#name(slot), slot.id));
      // arguments that arrived before the name was known
      if (slot.args) this.out.push(...this.enc.toolInput(this.#name(slot), slot.id, slot.args));
    }
  }
  toolArgs(slot, s) {
    slot.args += s;
    if (this.toolMode === 'stream' && slot.started && s) this.out.push(...this.enc.toolInput(this.#name(slot), slot.id, s));
  }
  toolEnd(slot) {
    if (slot.done || !slot.name) { slot.done = true; return; }
    slot.done = true;
    this.toolBegin(slot);
    const name = this.#name(slot);
    if (this.toolMode === 'stream') {
      if (!slot.args.trim()) this.out.push(...this.enc.toolInput(name, slot.id, '{}'));
      this.stats.toolCalls++;
      this.out.push(...this.enc.toolStop(name, slot.id));
      return;
    }
    const parsed = parseToolArgs(slot.args);
    if (!parsed.ok) {
      this.stats.droppedToolCalls++;
      const why = this.stats.finishReason === 'length' ? 'the response hit the output token limit mid-call' : 'its arguments were not valid JSON';
      this.emitText(`\n\n[kiromask] Dropped tool call "${name}": ${why}.\n`);
      return;
    }
    if (parsed.repaired) this.stats.repairedToolCalls++;
    const json = parsed.repaired || !slot.args.trim() ? JSON.stringify(parsed.value) : slot.args;
    this.stats.toolCalls++;
    this.out.push(...this.enc.toolStart(name, slot.id));
    for (const part of chunkString(json)) this.out.push(...this.enc.toolInput(name, slot.id, part));
    this.out.push(...this.enc.toolStop(name, slot.id));
  }
  endAllTools() { for (const s of this.slots) if (!s.done) this.toolEnd(s); }

  // ── usage / completion ──
  setUsage(prompt, completion) {
    if (prompt > 0) this.usage.prompt = prompt;
    if (completion > 0) this.usage.completion = completion;
    if (prompt > 0 || completion > 0) this.usage.reported = true;
  }
  setFinish(reason) { if (reason) this.stats.finishReason = reason; }

  /** Kiro's stop reasons: TOOL_USE when tools were called, MAX_TOKENS when cut off, else END_TURN. */
  stopReason() {
    if (this.stats.toolCalls > 0) return 'TOOL_USE';
    const r = this.stats.finishReason;
    return r === 'length' || r === 'max_tokens' ? 'MAX_TOKENS' : 'END_TURN';
  }

  /** Flush everything and append the closing events. Returns all remaining frames. */
  finish() {
    if (this.think) this.emitText(this.think.flush());
    this.endAllTools();
    this.#closeReasoning();
    if (!this.stats.textChars && !this.stats.toolCalls && !this.stats.droppedToolCalls) {
      this.emitText('(The model returned an empty response.)');
    } else if (this.stats.finishReason === 'length' && !this.stats.droppedToolCalls) {
      this.emitText('\n\n[kiromask] Output was cut off by the max_tokens limit.');
    }
    this.out.push(...this.enc.metadata(this.stopReason()));
    const prompt = this.usage.prompt || this.estimatedPromptTokens;
    if (!this.usage.prompt) this.usage.prompt = prompt;
    if (prompt > 0 && this.contextWindow > 0) {
      this.out.push(...this.enc.contextUsage(Math.min(100, Math.round((prompt / this.contextWindow) * 1e6) / 1e4)));
    }
    if (this.metering && this.usage.reported) this.out.push(...this.enc.metering((this.usage.prompt + this.usage.completion) / 10000));
    this.out.push(...this.enc.end());
    return this.drain();
  }
}
