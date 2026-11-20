// Anthropic Messages stream (parsed `data:` JSON events) → Kiro event frames.
import { KiroStreamBase, StreamError } from './stream-base.mjs';

export class AnthropicStreamTranslator extends KiroStreamBase {
  constructor(opts) {
    super(opts);
    this.blocks = new Map(); // content block index -> tool slot (or null for text/thinking)
    this.inputTokens = 0;
  }

  push(evt) {
    switch (evt?.type) {
      case 'message_start': {
        const u = evt.message?.usage || {};
        this.inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        this.setUsage(this.inputTokens, u.output_tokens || 0);
        break;
      }
      case 'content_block_start': {
        const b = evt.content_block || {};
        if (b.type === 'tool_use') {
          const slot = { id: b.id, name: b.name, args: '', started: false, done: false };
          this.slots.push(slot);
          this.blocks.set(evt.index, slot);
          this.toolBegin(slot);
        } else {
          this.blocks.set(evt.index, null);
          if (b.type === 'text' && b.text) this.onContent(b.text);
        }
        break;
      }
      case 'content_block_delta': {
        const d = evt.delta || {};
        if (d.type === 'text_delta') this.onContent(d.text || '');
        else if (d.type === 'thinking_delta') this.onReasoning(d.thinking || '');
        else if (d.type === 'input_json_delta') {
          const slot = this.blocks.get(evt.index);
          if (slot) this.toolArgs(slot, d.partial_json || '');
        }
        break;
      }
      case 'content_block_stop': {
        const slot = this.blocks.get(evt.index);
        if (slot) this.toolEnd(slot);
        break;
      }
      case 'message_delta':
        if (evt.delta?.stop_reason) this.setFinish(evt.delta.stop_reason === 'max_tokens' ? 'length' : evt.delta.stop_reason);
        if (evt.usage) this.setUsage(this.inputTokens || evt.usage.input_tokens || 0, evt.usage.output_tokens || 0);
        break;
      case 'error':
        throw new StreamError(evt.error?.message || 'provider stream error', { type: evt.error?.type });
      default: // ping, message_stop
    }
    return this.drain();
  }
}
