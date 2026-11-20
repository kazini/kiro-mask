import { ev, encodeException } from '../aws/eventstream.mjs';
import { responsesTextStream } from '../translate/encoders.mjs';
import { uuid } from '../util.mjs';

export const json = (res, status, obj, headers = {}) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers });
  res.end(body);
};

/** Begin a streamed reply in the wire format Kiro asked in: 'aws' (binary event stream) or 'responses' (SSE). */
export const startStream = (res, format = 'aws') => {
  res.writeHead(200, {
    'content-type': format === 'responses' ? 'text/event-stream' : 'application/vnd.amazon.eventstream',
    'x-amzn-requestid': uuid(),
    'cache-control': format === 'responses' ? 'no-cache, no-cache' : 'no-cache',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
};
export const startEventStream = (res) => startStream(res, 'aws');

/** Write frames honouring backpressure, without hanging if the client went away. */
export async function writeFrames(res, frames) {
  for (const f of frames) {
    if (res.destroyed || res.writableEnded) return;
    if (!res.write(f)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
  }
}

/**
 * Show an error inside the conversation (HTTP 200 stream) so the user sees what went wrong.
 * `wire` = { format: 'aws' | 'responses', model?, metadata? } describes the reply format Kiro expects.
 */
export async function chatError(res, message, wire = { format: 'aws' }) {
  const text = `⚠️ **kiromask:** ${message}`;
  if (!res.headersSent) startStream(res, wire.format);
  await writeFrames(res, wire.format === 'responses' ? responsesTextStream(text, wire) : [ev.text(text)]);
  res.end();
}

/** Or as an AWS-style HTTP error (config `defaults.errors: http`). */
export function httpError(res, status, message) {
  const type = status === 429 ? 'ThrottlingException' : status >= 500 ? 'InternalServerException' : 'ValidationException';
  json(res, status >= 400 ? status : 500, { message, __type: type }, { 'x-amzn-errortype': type });
}

export const describeError = (entry, e) =>
  `${entry.provider.name} (${entry.upstreamModel}) ${e.status ? `returned HTTP ${e.status}` : 'failed'}: ${e.message}`;

export { encodeException };

/** Per-request sender: writes frames to Kiro (with backpressure). Recording happens in App (it taps the response). */
export const makeSender = (ctx) => (frames) => writeFrames(ctx.res, frames);

/** Kiro's JSON-RPC style calls (X-Amz-Target) expect the AWS JSON 1.0 content type on replies. */
export const isRpc = (req) => !!req.headers['x-amz-target'];
export const jsonFor = (ctx, status, obj) => json(ctx.res, status, obj, isRpc(ctx.req) ? { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-requestid': uuid() } : {});
