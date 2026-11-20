// Output encoders: what a provider's stream is turned INTO.
//
// Kiro talks to its backend in one of two ways, chosen by server-side feature flags:
//   • "aws"       GenerateAssistantResponse → binary application/vnd.amazon.eventstream   (older builds / flags)
//   • "responses" POST /v1/responses        → Server-Sent Events in the OpenAI *Responses* shape ("create_response")
// The stream translators (stream-openai.mjs / stream-anthropic.mjs via stream-base.mjs) are written against ONE small
// encoder interface, so everything about provider quirks (think-filtering, tool-argument repair, usage…) is shared.
//
// Interface — every method returns an array of Buffers to write to Kiro (possibly empty):
//   initial()                     first bytes of the response
//   text(content, modelId)        assistant text
//   toolStart(name, id)  toolInput(name, id, chunk)  toolStop(name, id)
//   reasoning(text)               Kiro's native reasoning events (AWS only; the Responses encoder drops them)
//   metadata(stopReason)          END_TURN | TOOL_USE | MAX_TOKENS
//   contextUsage(pct)  metering(credits)
//   end()                         closing bytes (the Responses encoder emits response.completed + [DONE] here)

import { randomBytes } from 'node:crypto';
import { ev } from '../aws/eventstream.mjs';

/** The binary AWS event stream (the original protocol). */
export const awsEncoder = () => ({
  format: 'aws',
  contentType: 'application/vnd.amazon.eventstream',
  initial: () => [ev.initialResponse()],
  text: (content, modelId) => [ev.text(content, modelId)],
  toolStart: (name, id) => [ev.toolStart(name, id)],
  toolInput: (name, id, chunk) => [ev.toolInput(name, id, chunk)],
  toolStop: (name, id) => [ev.toolStop(name, id)],
  reasoning: (text) => [ev.reasoning(text)],
  metadata: (stop) => [ev.metadata(stop)],
  contextUsage: (pct) => [ev.contextUsage(pct)],
  metering: (usage) => [ev.metering(usage)],
  end: () => [],
});

const hex = () => randomBytes(16).toString('hex');

/**
 * Server-Sent Events in the shape Kiro's `/v1/responses` endpoint returns (recorded from Kiro 1.4.178):
 *
 *   response.created, response.in_progress
 *   per text item:     output_item.added(message) · content_part.added · output_text.delta* · output_text.done ·
 *                      content_part.done · output_item.done
 *   per tool call:     output_item.added(function_call: id, call_id, name) · function_call_arguments.delta* ·
 *                      function_call_arguments.done · output_item.done(… arguments, status)
 *   response.completed  status "requires_action" when the turn ended with tool calls, else "completed";
 *                      usage {"kiro:credits": {…}, "kiro:context_usage_percentage": n}
 *   data: [DONE]
 */
export class ResponsesEncoder {
  /**
   * @param {{model?: string, metadata?: object, tools?: object[]}} o  echoed back in the response object, as the real service does
   */
  constructor({ model = 'unknown', metadata = {}, tools = [] } = {}) {
    this.format = 'responses';
    this.contentType = 'text/event-stream';
    this.model = model;
    this.meta = metadata;
    this.tools = tools;
    this.id = `resp_${hex()}`;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.seq = 0;
    this.nextIndex = 0;
    this.items = [];          // finished output items, by output_index
    this.msg = null;          // the open text item
    this.calls = new Map();   // tool id → open function_call item
    this.started = false;
    this.ended = false;
    this.stop = 'END_TURN';
    this.contextPct = null;
    this.credits = 0;
  }

  #e(type, data = {}) {
    return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...data })}\n\n`);
  }

  #response(status, extra = {}) {
    return {
      object: 'response', model: this.model, previous_response_id: null, instructions: null, tools: this.tools, tool_choice: 'auto',
      truncation: 'disabled', temperature: 1.0, top_p: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0, top_logprobs: 0,
      parallel_tool_calls: true, max_output_tokens: null, max_tool_calls: null, reasoning: null, text: { format: { type: 'text' } },
      store: false, background: false, service_tier: 'default', metadata: this.meta, safety_identifier: null, prompt_cache_key: null,
      id: this.id, created_at: this.createdAt, completed_at: null, status, incomplete_details: null, output: [], error: null, usage: null,
      ...extra,
    };
  }

  initial() {
    if (this.started) return [];
    this.started = true;
    return [this.#e('response.created', { response: this.#response('in_progress') }), this.#e('response.in_progress', { response: this.#response('in_progress') })];
  }

  // ── text ──
  text(content) {
    if (!content) return []; // the AWS protocol opens with an empty text event; here an empty item would be noise
    const out = [...this.initial()];
    if (!this.msg) {
      const index = this.nextIndex++;
      const id = `msg_${hex()}`;
      this.msg = { id, index, text: '' };
      out.push(this.#e('response.output_item.added', { output_index: index, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] } }));
      out.push(this.#e('response.content_part.added', { item_id: id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
    }
    this.msg.text += content;
    out.push(this.#e('response.output_text.delta', { item_id: this.msg.id, output_index: this.msg.index, content_index: 0, delta: content }));
    return out;
  }

  #closeMessage() {
    if (!this.msg) return [];
    const { id, index, text } = this.msg;
    this.msg = null;
    const part = { type: 'output_text', text, annotations: [] };
    const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [part] };
    this.items[index] = item;
    return [
      this.#e('response.output_text.done', { item_id: id, output_index: index, content_index: 0, text }),
      this.#e('response.content_part.done', { item_id: id, output_index: index, content_index: 0, part }),
      this.#e('response.output_item.done', { output_index: index, item }),
    ];
  }

  // ── tools ──
  toolStart(name, callId) {
    const out = [...this.initial(), ...this.#closeMessage()];
    if (this.calls.has(callId)) return out;
    const index = this.nextIndex++;
    const id = `fc_${hex()}`;
    this.calls.set(callId, { id, index, callId, name, args: '' });
    out.push(this.#e('response.output_item.added', { output_index: index, item: { type: 'function_call', id, call_id: callId, name } }));
    return out;
  }

  toolInput(name, callId, chunk) {
    const out = this.calls.has(callId) ? [] : this.toolStart(name, callId);
    const c = this.calls.get(callId);
    if (!chunk) return out;
    c.args += chunk;
    out.push(this.#e('response.function_call_arguments.delta', { item_id: c.id, output_index: c.index, delta: chunk }));
    return out;
  }

  toolStop(name, callId) {
    const out = this.calls.has(callId) ? [] : this.toolStart(name, callId);
    const c = this.calls.get(callId);
    this.calls.delete(callId);
    const args = c.args || '{}';
    const item = { type: 'function_call', id: c.id, call_id: c.callId, name: c.name, arguments: args, status: 'completed' };
    this.items[c.index] = item;
    out.push(this.#e('response.function_call_arguments.done', { item_id: c.id, output_index: c.index, arguments: args }));
    out.push(this.#e('response.output_item.done', { output_index: c.index, item }));
    return out;
  }

  // Kiro's reasoning events have no Responses counterpart that is known to be accepted: reasoning is dropped.
  reasoning() { return []; }

  metadata(stop) { this.stop = stop || this.stop; return []; }
  contextUsage(pct) { this.contextPct = pct; return []; }
  metering(credits) { this.credits = credits; return []; }

  end() {
    if (this.ended) return [];
    this.ended = true;
    const out = [...this.initial(), ...this.#closeMessage()];
    for (const [id, c] of [...this.calls]) out.push(...this.toolStop(c.name, id)); // a call that never closed
    const output = this.items.filter(Boolean);
    const hasCalls = output.some((i) => i.type === 'function_call');
    const usage = { 'kiro:credits': { value: this.credits, unit: 'credit', unit_plural: 'credits' } };
    if (this.contextPct != null) usage['kiro:context_usage_percentage'] = this.contextPct;
    out.push(this.#e('response.completed', {
      response: this.#response(hasCalls || this.stop === 'TOOL_USE' ? 'requires_action' : 'completed', { completed_at: Math.floor(Date.now() / 1000), output, usage }),
    }));
    out.push(Buffer.from('data: [DONE]\n\n'));
    return out;
  }
}

/** A complete, self-contained Responses stream carrying one text answer (error notices, session titles). */
export function responsesTextStream(text, { model, metadata, tools, contextPct } = {}) {
  const e = new ResponsesEncoder({ model, metadata, tools });
  return [...e.initial(), ...e.text(text), ...e.metadata('END_TURN'), ...(contextPct != null ? e.contextUsage(contextPct) : []), ...e.end()];
}
