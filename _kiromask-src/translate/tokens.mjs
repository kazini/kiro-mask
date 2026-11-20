// Cheap token estimation, used when a provider does not report usage.
// ~3.5 bytes/token is a decent average across code and prose for modern tokenizers.
export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3.5);
export const estimateJsonTokens = (obj) => estimateTokens(JSON.stringify(obj));
