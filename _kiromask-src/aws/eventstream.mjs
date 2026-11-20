// AWS binary event-stream codec (application/vnd.amazon.eventstream).
//
// Frame layout (all integers big-endian):
//   [4] total length   [4] headers length   [4] CRC32 of the first 8 bytes
//   [headers]          [payload]            [4] CRC32 of everything before it
// Header entry: [1] name length, [name], [1] value type, then a type-specific value.
//
// Zero dependencies. CRC32 is table driven so it works on any Node version.

import { Buffer } from 'node:buffer';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE). Pass a previous result as `prev` to continue incrementally. */
export function crc32(buf, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class EventStreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventStreamError';
  }
}

const MAX_FRAME = 16 * 1024 * 1024 + 16; // AWS caps a message at 16 MiB

// ── Encoding ────────────────────────────────────────────────────────────────

/** Encode string-typed headers ({name: 'value'}) into the wire format. */
export function encodeHeaders(headers) {
  const parts = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(String(value), 'utf8');
    if (n.length > 255) throw new EventStreamError(`header name too long: ${name}`);
    if (v.length > 0xffff) throw new EventStreamError(`header value too long: ${name}`);
    const h = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = 0;
    h[o++] = n.length;
    n.copy(h, o); o += n.length;
    h[o++] = 7; // string
    h.writeUInt16BE(v.length, o); o += 2;
    v.copy(h, o);
    parts.push(h);
  }
  return Buffer.concat(parts);
}

/** Build one complete frame from already-encoded header bytes and a payload. */
export function encodeFrameRaw(headerBytes, payload) {
  const total = 12 + headerBytes.length + payload.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBytes.length, 4);
  out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  headerBytes.copy(out, 12);
  payload.copy(out, 12 + headerBytes.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
  return out;
}

export function encodeFrame(headers, payload) {
  return encodeFrameRaw(encodeHeaders(headers), Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
}

/** Encode a JSON event, the shape Kiro's AWS SDK expects. */
export function encodeEvent(eventType, payload, contentType = 'application/json') {
  return encodeFrame(
    { ':event-type': eventType, ':content-type': contentType, ':message-type': 'event' },
    Buffer.from(JSON.stringify(payload), 'utf8'),
  );
}

/** Encode an in-band exception frame (what AWS sends for mid-stream service errors). */
export function encodeException(exceptionType, message) {
  return encodeFrame(
    { ':exception-type': exceptionType, ':content-type': 'application/json', ':message-type': 'exception' },
    Buffer.from(JSON.stringify({ message }), 'utf8'),
  );
}

/** Convenience constructors for every event Kiro's chat stream understands. */
export const ev = {
  /** First event of every response (Kiro's service sends it with an empty conversation id). */
  initialResponse: () => encodeEvent('initial-response', { conversationId: '' }, 'application/x-amz-json-1.0'),
  /** Assistant text. `modelId` (the model Kiro asked for) is attached as the real service does. */
  text: (content, modelId) => encodeEvent('assistantResponseEvent', modelId ? { content, modelId } : { content }),
  toolStart: (name, toolUseId) => encodeEvent('toolUseEvent', { name, toolUseId }),
  toolInput: (name, toolUseId, input) => encodeEvent('toolUseEvent', { input, name, toolUseId }),
  toolStop: (name, toolUseId) => encodeEvent('toolUseEvent', { name, toolUseId, stop: true }),
  /** Why the turn ended: END_TURN | TOOL_USE | MAX_TOKENS. */
  metadata: (stopReason) => encodeEvent('metadataEvent', { stopReason }),
  /** Thinking text (Kiro shows it as reasoning). */
  reasoning: (text) => encodeEvent('reasoningContentEvent', { text }),
  contextUsage: (pct) => encodeEvent('contextUsageEvent', { contextUsagePercentage: pct }),
  metering: (usage) => encodeEvent('meteringEvent', { unit: 'credit', unitPlural: 'credits', usage }),
};

// ── Decoding ────────────────────────────────────────────────────────────────

function parseHeaders(buf) {
  const headers = {};
  let i = 0;
  const need = (n) => {
    if (i + n > buf.length) throw new EventStreamError('truncated header block');
  };
  while (i < buf.length) {
    need(1);
    const nameLen = buf[i++];
    need(nameLen);
    const name = buf.toString('utf8', i, i + nameLen); i += nameLen;
    need(1);
    const type = buf[i++];
    switch (type) {
      case 0: headers[name] = true; break;
      case 1: headers[name] = false; break;
      case 2: need(1); headers[name] = buf.readInt8(i); i += 1; break;
      case 3: need(2); headers[name] = buf.readInt16BE(i); i += 2; break;
      case 4: need(4); headers[name] = buf.readInt32BE(i); i += 4; break;
      case 5: need(8); headers[name] = buf.readBigInt64BE(i); i += 8; break;
      case 6: { need(2); const l = buf.readUInt16BE(i); i += 2; need(l); headers[name] = buf.subarray(i, i + l); i += l; break; }
      case 7: { need(2); const l = buf.readUInt16BE(i); i += 2; need(l); headers[name] = buf.toString('utf8', i, i + l); i += l; break; }
      case 8: need(8); headers[name] = new Date(Number(buf.readBigInt64BE(i))); i += 8; break;
      case 9: need(16); headers[name] = buf.subarray(i, i + 16).toString('hex'); i += 16; break;
      default: throw new EventStreamError(`unknown header type ${type}`);
    }
  }
  return headers;
}

/**
 * Incremental frame decoder. Feed it arbitrary chunks; it returns every frame
 * that became complete. `raw` is the untouched frame bytes (CRCs intact), which
 * lets callers forward or drop frames byte-for-byte.
 */
export class FrameDecoder {
  constructor({ verifyCrc = true } = {}) {
    this.verifyCrc = verifyCrc;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    for (;;) {
      if (this.buf.length < 12) break;
      const total = this.buf.readUInt32BE(0);
      const hlen = this.buf.readUInt32BE(4);
      if (total < 16 || total > MAX_FRAME || hlen > total - 16) {
        throw new EventStreamError(`invalid frame lengths (total=${total}, headers=${hlen})`);
      }
      if (this.verifyCrc && crc32(this.buf.subarray(0, 8)) !== this.buf.readUInt32BE(8)) {
        throw new EventStreamError('prelude CRC mismatch');
      }
      if (this.buf.length < total) break;
      const raw = this.buf.subarray(0, total);
      if (this.verifyCrc && crc32(raw.subarray(0, total - 4)) !== raw.readUInt32BE(total - 4)) {
        throw new EventStreamError('message CRC mismatch');
      }
      const headers = parseHeaders(raw.subarray(12, 12 + hlen));
      frames.push({
        headers,
        payload: raw.subarray(12 + hlen, total - 4),
        raw: Buffer.from(raw), // detach from the rolling buffer
        eventType: headers[':event-type'] ?? headers[':exception-type'],
        messageType: headers[':message-type'],
      });
      this.buf = this.buf.subarray(total);
    }
    return frames;
  }

  /** Bytes buffered that do not yet form a complete frame. */
  get pending() {
    return this.buf.length;
  }
}

/** Decode a complete buffer. Throws if it ends mid-frame. */
export function decodeAll(buffer, opts) {
  const d = new FrameDecoder(opts);
  const frames = d.push(buffer);
  if (d.pending) throw new EventStreamError(`${d.pending} trailing bytes do not form a frame`);
  return frames;
}

/** Parse a frame's JSON payload (null when empty or not JSON). */
export function payloadJson(frame) {
  if (!frame.payload.length) return null;
  try { return JSON.parse(frame.payload.toString('utf8')); } catch { return null; }
}

/**
 * Streaming filter: returns `(chunk) => Buffer` that forwards only frames whose
 * event type is NOT in `dropTypes`, byte-for-byte. Partial frames are held until
 * complete. Use for pass-through responses (e.g. stripping metering events).
 */
export function createFrameFilter(dropTypes) {
  const drop = new Set(dropTypes);
  const dec = new FrameDecoder({ verifyCrc: false });
  return (chunk) => {
    const keep = dec.push(chunk).filter((f) => !drop.has(f.eventType)).map((f) => f.raw);
    return keep.length ? Buffer.concat(keep) : Buffer.alloc(0);
  };
}
