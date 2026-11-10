/**
 * Tool input schemas for each provider. CHAD's tool definitions (src/ai/*.json) are standard
 * JSON Schema, the same ones the MCP server gives Claude Code. Anthropic takes them as they are.
 * For OpenAI and Gemini they are made self-contained ($ref inlined) so no provider has to
 * resolve references, and for Gemini they are limited to the JSON Schema keywords its
 * parametersJsonSchema field documents. The app checks every argument itself anyway
 * (executor.ts), so a dropped keyword (a minimum, a pattern) only means the model is told a
 * little less up front; a wrong value is still refused with a clear error it can fix.
 */
type Json = any;

/** Replace every local "#/$defs/name" reference with a copy of the definition. */
export function inlineRefs(schema: Json): Json {
  const defs: Record<string, Json> = schema?.$defs ?? schema?.definitions ?? {};
  const walk = (node: Json, seen: string[]): Json => {
    if (Array.isArray(node)) return node.map((n) => walk(n, seen));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
      const m = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(node.$ref);
      if (!m || !(m[2] in defs)) throw new Error(`Tool schema: unsupported reference ${node.$ref}`);
      if (seen.includes(m[2])) throw new Error(`Tool schema: recursive reference ${node.$ref}`);
      const { $ref: _ref, ...rest } = node;
      const target = walk(defs[m[2]], [...seen, m[2]]);
      // Keywords next to $ref (usually a description) win over the definition's own.
      return { ...target, ...walk(rest, seen) };
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$defs' || k === 'definitions') continue;
      // "properties" maps names to schemas: walk each value, keep every name.
      out[k] = walk(v, seen);
    }
    return out;
  };
  return walk(schema, []);
}

/**
 * Keywords the Gemini API documents for parametersJsonSchema (checked 2026-11-10). Everything
 * else is dropped. "type": [a, b] becomes anyOf, which means the same thing.
 */
const GEMINI_KEYWORDS = new Set([
  'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems',
  'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'nullable',
]);

export function forGemini(schema: Json): Json {
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (!GEMINI_KEYWORDS.has(k)) continue;
      if (k === 'properties' && v && typeof v === 'object') {
        out.properties = Object.fromEntries(Object.entries(v as Record<string, Json>).map(([name, s]) => [name, walk(s)]));
      } else if (k === 'additionalProperties') {
        // A boolean is fine; a schema is walked like any other.
        out[k] = typeof v === 'boolean' ? v : walk(v);
      } else out[k] = walk(v);
    }
    if (Array.isArray(out.type)) {
      const types: string[] = out.type;
      delete out.type;
      const alts = types.map((t) => ({ type: t }));
      out.anyOf = out.anyOf ? [...out.anyOf, ...alts] : alts;
    }
    return out;
  };
  return walk(inlineRefs(schema));
}
