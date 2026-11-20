// OpenAI Chat Completions stream (parsed `data:` JSON chunks) → Kiro event frames.
import { KiroStreamBase, StreamError } from './stream-base.mjs';

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '');
const isCompleteJson = (s) => { try { JSON.parse(s); return true; } catch { return false; } };

export class OpenAIStreamTranslator extends KiroStreamBase {
  constructor(opts) {
    super(opts);
    this.byIndex = new Map(); // provider tool index -> slot
  }

  /** @param {object} chunk one parsed streaming chunk. Returns frames to send. */
  push(chunk) {
    if (chunk?.error) {
      const e = chunk.error;
      throw new StreamError(typeof e === 'string' ? e : e.message || JSON.stringify(e), { type: e.type || e.code });
    }
    const u = chunk?.usage;
    if (u) this.setUsage(u.prompt_tokens ?? u.input_tokens ?? 0, u.completion_tokens ?? u.output_tokens ?? 0);

    const choice = chunk?.choices?.[0];
    if (choice) {
      const d = choice.delta ?? choice.message ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning
        ?? (Array.isArray(d.reasoning_details) ? d.reasoning_details.map((x) => x?.text ?? '').join('') : undefined);
      if (reasoning) this.onReasoning(typeof reasoning === 'string' ? reasoning : '');
      const text = textOf(d.content);
      if (text) this.onContent(text);
      for (const tc of d.tool_calls || []) this.#toolDelta(tc);
      if (choice.finish_reason) {
        this.setFinish(choice.finish_reason);
        this.endAllTools();
      }
    }
    return this.drain();
  }

  #toolDelta(tc) {
    const idx = tc.index ?? 0;
    const fn = tc.function || {};
    let slot = this.byIndex.get(idx);
    // Some providers (notably Gemini's OpenAI shim) reuse index 0 for every parallel call.
    const newCall = slot && ((tc.id && slot.id && tc.id !== slot.id) || (fn.name && slot.args && isCompleteJson(slot.args)));
    if (!slot || newCall) {
      if (slot && !slot.done) this.toolEnd(slot);
      slot = { id: null, name: '', args: '', started: false, done: false };
      this.slots.push(slot);
      this.byIndex.set(idx, slot);
    }
    if (tc.id) slot.id = tc.id;
    if (fn.name) slot.name = fn.name;
    if (slot.name) this.toolBegin(slot);
    if (fn.arguments !== undefined && fn.arguments !== null) {
      this.toolArgs(slot, typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments));
    }
  }
}
