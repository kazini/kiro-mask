// JSON-Schema clean-up for tool definitions.
//
// Kiro's tool schemas come from zod and look like:
//   { anyOf: [ { anyOf: [ {not: {}}, {type: "number", ...} ] }, {type: "null"} ] }   (an optional param)
// plus "$schema" and "additionalProperties". Plenty of providers (Gemini, several NIM/vLLM
// models) reject or mishandle `not`, nested `anyOf` and `$schema`, which makes models emit
// arguments that fail Kiro's own validation. We collapse them to the plain schema.

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isNever = (n) => isObj(n) && Object.keys(n).length === 1 && isObj(n.not) && Object.keys(n.not).length === 0;
const isNull = (n) => isObj(n) && n.type === 'null' && Object.keys(n).length === 1;

/**
 * @param {object} schema  JSON schema (Kiro's `inputSchema.json`)
 * @param {{simplify?: boolean, strip?: string[]}} opts
 *   simplify: drop $schema, collapse optional/nullable unions
 *   strip:    additional schema keywords to remove everywhere (e.g. ['additionalProperties','default'])
 */
export function sanitizeSchema(schema, { simplify = true, strip = [] } = {}) {
  const stripSet = new Set(strip);
  if (simplify) stripSet.add('$schema');

  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObj(node)) return node;

    let n = { ...node };

    if (simplify) {
      for (const kw of ['anyOf', 'oneOf']) {
        if (!Array.isArray(n[kw])) continue;
        const variants = n[kw].map(walk);
        const real = variants.filter((v) => !isNever(v) && !isNull(v));
        const hadNull = variants.some(isNull);
        const { [kw]: _drop, ...rest } = n;
        if (real.length === 1) {
          // outer keywords (description, default…) win over the inner variant's
          n = { ...real[0], ...rest };
        } else if (real.length === 0) {
          n = rest;
        } else {
          n = { ...rest, [kw]: hadNull ? [...real, { type: 'null' }] : real };
        }
      }
    }

    // The Responses format marks optional parameters as  type: ["string", "null"]. Many providers choke on type arrays.
    if (simplify && Array.isArray(n.type)) {
      const real = n.type.filter((t) => t !== 'null');
      if (real.length === 1) n = { ...n, type: real[0] };
      else if (real.length > 1) n = { ...n, type: real };
    }

    const out = {};
    for (const [k, v] of Object.entries(n)) {
      if (stripSet.has(k)) continue;
      if (k === 'properties' && isObj(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv)]));
      } else if (k === 'definitions' || k === '$defs') {
        out[k] = Object.fromEntries(Object.entries(v || {}).map(([dk, dv]) => [dk, walk(dv)]));
      } else if (k === 'enum' || k === 'required' || k === 'default' || k === 'const' || k === 'examples') {
        out[k] = v; // data, not schema
      } else if (isObj(v) || Array.isArray(v)) {
        out[k] = walk(v);
      } else {
        out[k] = v;
      }
    }
    return out; // a bare {not:{}} is left for the enclosing union to filter out
  };

  const result = walk(isObj(schema) ? schema : {});
  // Providers want an object schema at the root.
  if (result.type === undefined && result.properties === undefined) result.type = 'object';
  if (result.type === 'object' && result.properties === undefined) result.properties = {};
  return result;
}
