import { Buffer } from 'node:buffer';
import { decodeAll, payloadJson } from '../../_kiromask-src/aws/eventstream.mjs';

/** Decode an array of frames (Buffers) into [{type, ...payload}]. */
export function events(frames) {
  return decodeAll(Buffer.concat(frames)).map((f) => ({ type: f.eventType, ...payloadJson(f) }));
}

/** Concatenate all assistant text from frames. */
export const textOf = (frames) => events(frames).filter((e) => e.type === 'assistantResponseEvent').map((e) => e.content).join('');

/** Collect tool calls: [{name, id, input(string), stopped}] */
export function toolsOf(frames) {
  const calls = new Map();
  for (const e of events(frames)) {
    if (e.type !== 'toolUseEvent') continue;
    const c = calls.get(e.toolUseId) ?? { name: e.name, id: e.toolUseId, input: '', stopped: false };
    if (e.input) c.input += e.input;
    if (e.stop) c.stopped = true;
    calls.set(e.toolUseId, c);
  }
  return [...calls.values()];
}

export const run = (translator, chunks) => {
  const out = [];
  for (const c of chunks) out.push(...translator.push(c));
  out.push(...translator.finish());
  return out;
};

export const oaChunk = (delta, finish = null, extra = {}) => ({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
