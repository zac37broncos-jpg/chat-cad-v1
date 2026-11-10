/**
 * Bring-your-own-key AI chat (docs/BYOK_AI.md): the three providers' request and response
 * formats, the in-browser tool loop (each step still a real, named, editable feature, the whole
 * request one undo step), the usage guards, the settings, and that no key is ever in the code.
 * Every provider is faked: nothing here calls a real AI or spends anyone's credit.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { regenerate, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo } from '../src/kernel/query';
import { TOOL_DEFS, type ExecutorContext } from '../src/ai/executor';
import { inlineRefs, forGemini } from '../src/ai/byok/schema';
import { buildPayload, parseResponse, appendToolResults, appendUser, fitPayload, MAX_REQUEST_BYTES, IMAGE_REMOVED_NOTE, MAX_OUTPUT_TOKENS, ANTHROPIC_FALLBACK_BETA, type ToolOutcome } from '../src/ai/byok/providers';
import { runAgent, byokSystemPrompt, BYOK_LIMITS, PROXY_PATH, KEY_HEADER, callProxy } from '../src/ai/byok/agent';
import { DEFAULT_MODELS, STORAGE_KEYS, readAiSettings, saveAiSettings, keyProblem, modelProblem, effectiveModel, _resetAiSettingsCache, type ByokProvider } from '../src/ai/byok/settings';
// @ts-expect-error plain JS module
import { LIMITS } from '../bridge/hub.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let oc: OC;
beforeAll(async () => { oc = await init(); });

function ctx(store: DocumentStore): ExecutorContext {
  return {
    store,
    regen: async () => {
      const r = regenerate(oc, store.state);
      return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, ms: 0 } as any;
    },
    selection: () => [],
    info: async (ref) => { const r = regenerate(oc, store.state); return entityInfo(oc, r.shape!, ref.kind, ref.index); },
  };
}

/** An in-memory localStorage for the settings tests. */
class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
const g = globalThis as any;
afterEach(() => { delete g.localStorage; _resetAiSettingsCache(); });

const PROVIDERS: ByokProvider[] = ['anthropic', 'openai', 'gemini'];
const walk = (n: any, f: (k: string, v: any, parent: any) => void) => {
  if (Array.isArray(n)) n.forEach((x) => walk(x, f));
  else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) { f(k, v, n); walk(v, f); }
};

describe('tool schemas per provider', () => {
  it('inlines every $ref so OpenAI and Gemini get self-contained schemas', () => {
    for (const t of TOOL_DEFS) {
      const s = inlineRefs(t.inputSchema);
      walk(s, (k) => { expect(k, t.name).not.toBe('$ref'); expect(k, t.name).not.toBe('$defs'); });
      expect(s.type, t.name).toBe('object');
    }
  });

  it('keeps every property name and required list (only the $ref plumbing changes)', () => {
    for (const t of TOOL_DEFS) {
      const s = inlineRefs(t.inputSchema);
      expect(Object.keys(s.properties ?? {}), t.name).toEqual(Object.keys((t.inputSchema as any).properties ?? {}));
      expect(s.required, t.name).toEqual((t.inputSchema as any).required);
    }
  });

  it('gives Gemini only the JSON Schema keywords its parametersJsonSchema documents, and no type arrays', () => {
    const allowed = new Set(['type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'nullable']);
    for (const t of TOOL_DEFS) {
      const s = forGemini(t.inputSchema);
      const check = (n: any) => {
        if (Array.isArray(n)) { n.forEach(check); return; }
        if (!n || typeof n !== 'object') return;
        for (const [k, v] of Object.entries(n)) {
          expect(allowed.has(k), `${t.name}: ${k}`).toBe(true);
          if (k === 'type') expect(typeof v, `${t.name}: type`).toBe('string');
          if (k === 'properties') Object.values(v as object).forEach(check); else check(v);
        }
      };
      check(s);
    }
    // "number or expression string" stays a choice of the two.
    const fillet = forGemini(TOOL_DEFS.find((t) => t.name === 'create_sketch')!.inputSchema);
    expect(JSON.stringify(fillet)).toContain('"anyOf":[{"type":"number"},{"type":"string"}]');
  });

  it('refuses recursive or unknown references instead of looping', () => {
    expect(() => inlineRefs({ type: 'object', $defs: { a: { $ref: '#/$defs/a' } }, properties: { x: { $ref: '#/$defs/a' } } })).toThrow(/recursive/);
    expect(() => inlineRefs({ type: 'object', properties: { x: { $ref: 'https://example.com/x' } } })).toThrow(/unsupported/);
  });
});

describe('request formats (one switch, three providers)', () => {
  const tools = TOOL_DEFS.slice(0, 3);
  const history = appendUser('anthropic', [], 'hi');

  it('Anthropic: Messages API body with tools, effort, caching and the refusal fallback', () => {
    const r = buildPayload({ provider: 'anthropic', model: 'claude-opus-5-5', system: 'S', tools, history });
    const b = r.body as any;
    expect(r.provider).toBe('anthropic');
    expect(r.headers).toEqual({ 'anthropic-beta': ANTHROPIC_FALLBACK_BETA });
    expect(b).toMatchObject({ model: 'claude-opus-5-5', max_tokens: MAX_OUTPUT_TOKENS, system: 'S', output_config: { effort: 'high' }, cache_control: { type: 'ephemeral' }, fallbacks: 'default' });
    expect(b.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(b.tools[0]).toEqual({ name: tools[0].name, description: tools[0].description, input_schema: tools[0].inputSchema });
    // No sampling settings (rejected by the current API version) and no thinking budget.
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(b).not.toHaveProperty(k);
    // A model without the fallback feature gets neither the header nor the field.
    const old = buildPayload({ provider: 'anthropic', model: 'claude-haiku-4-5', system: 'S', tools, history });
    expect(old.headers).toBeUndefined();
    expect(old.body).not.toHaveProperty('fallbacks');
  });

  it('OpenAI: v1/chat/completions body with function tools', () => {
    const r = buildPayload({ provider: 'openai', model: 'gpt-6-sol', system: 'S', tools, history: appendUser('openai', [], 'hi') });
    const b = r.body as any;
    expect(b.model).toBe('gpt-6-sol');
    expect(b.messages).toEqual([{ role: 'developer', content: 'S' }, { role: 'user', content: 'hi' }]);
    expect(b.tools[0]).toEqual({ type: 'function', function: { name: tools[0].name, description: tools[0].description, parameters: inlineRefs(tools[0].inputSchema) } });
    expect(b).toMatchObject({ tool_choice: 'auto', reasoning_effort: 'none', max_completion_tokens: MAX_OUTPUT_TOKENS, parallel_tool_calls: false });
    expect(b).not.toHaveProperty('max_tokens');
  });

  it('Gemini: generateContent body with functionDeclarations', () => {
    const r = buildPayload({ provider: 'gemini', model: 'gemini-3.8-flash', system: 'S', tools, history: appendUser('gemini', [], 'hi') });
    const b = r.body as any;
    expect(r.model).toBe('gemini-3.8-flash');
    expect(b.systemInstruction).toEqual({ parts: [{ text: 'S' }] });
    expect(b.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(b.tools[0].functionDeclarations[0]).toEqual({ name: tools[0].name, description: tools[0].description, parametersJsonSchema: forGemini(tools[0].inputSchema) });
    expect(b.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(b.generationConfig).toEqual({ maxOutputTokens: MAX_OUTPUT_TOKENS });
    expect(b).not.toHaveProperty('model'); // the model is in the URL (the proxy builds it)
  });

  it('never puts an API key in a request body', () => {
    for (const p of PROVIDERS) {
      const s = JSON.stringify(buildPayload({ provider: p, model: DEFAULT_MODELS[p], system: 'S', tools, history: appendUser(p, [], 'hi') }));
      expect(s).not.toMatch(/api[-_]?key|authorization|x-goog/i);
    }
  });

  it('Gemini: a second user message after a stopped request joins the last user turn', () => {
    const h = appendUser('gemini', appendUser('gemini', [], 'one'), 'two');
    expect(h).toEqual([{ role: 'user', parts: [{ text: 'one' }, { text: 'two' }] }]);
  });
});

const png = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const outcome = (id: string, name: string, ok: boolean, text: string, images: typeof png[] = []): ToolOutcome => ({ call: { id, name, args: {} }, ok, text, images });

describe('tool results go back in each provider\'s format', () => {
  it('Anthropic: one user turn of tool_result blocks, errors flagged, images inside the result', () => {
    const turn = { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'view_model', input: {} }, { type: 'tool_use', id: 't2', name: 'extrude', input: {} }] };
    const h = appendToolResults('anthropic', [], turn, [outcome('t1', 'view_model', true, '{"ok":true}', [png]), outcome('t2', 'extrude', false, 'Error: bad')]);
    expect(h[0]).toBe(turn); // the model turn exactly as returned (thinking block and signature untouched)
    expect(h[1]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"ok":true}' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.data } }] },
      { type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'Error: bad' }] },
    ] });
  });

  it('OpenAI: one tool message per call (text only), then the renders as a user message', () => {
    const turn = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view_model', arguments: '{}' } }] };
    const h = appendToolResults('openai', [], turn, [outcome('c1', 'view_model', true, '{"ok":true}', [png])]);
    expect(h).toEqual([
      turn,
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'user', content: [{ type: 'text', text: expect.stringContaining('c1') }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.data}` } }] },
    ]);
  });

  it('Gemini: all function responses in one user turn after the model turn (signatures untouched)', () => {
    const turn = { role: 'model', parts: [{ functionCall: { name: 'view_model', args: {} }, thoughtSignature: 'SIG' }, { functionCall: { name: 'extrude', args: {} } }] };
    const h = appendToolResults('gemini', [], turn, [outcome('gemini_call_1', 'view_model', true, '{"ok":true,"views":["front"]}', [png]), outcome('gemini_call_2', 'extrude', false, 'Error: bad')]);
    expect(h[0]).toBe(turn);
    expect(h[1]).toEqual({ role: 'user', parts: [
      { functionResponse: { name: 'view_model', response: { output: { ok: true, views: ['front'] } } } },
      { functionResponse: { name: 'extrude', response: { error: 'Error: bad' } } },
      { text: expect.stringContaining('view_model') },
      { inlineData: { mimeType: 'image/png', data: png.data } },
    ] });
  });

  it('Gemini: a call id given by the model is echoed back', () => {
    const h = appendToolResults('gemini', [], { role: 'model', parts: [] }, [outcome('abc123', 'undo', true, '{}')]);
    expect((h[1] as any).parts[0].functionResponse.id).toBe('abc123');
  });
});

describe('reading responses', () => {
  it('Anthropic: text, tool calls and stop reasons; the whole content is kept', () => {
    const json = { content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: ' Building. ' }, { type: 'tool_use', id: 'tu1', name: 'set_units', input: { units: 'mm' } }], stop_reason: 'tool_use' };
    const r = parseResponse('anthropic', json);
    expect(r).toMatchObject({ texts: ['Building.'], calls: [{ id: 'tu1', name: 'set_units', args: { units: 'mm' } }], stop: 'tool_use' });
    expect((r.modelTurn as any).content).toBe(json.content);
    expect(parseResponse('anthropic', { content: [], stop_reason: 'refusal', stop_details: { explanation: 'no' } })).toMatchObject({ stop: 'refusal', detail: 'no' });
    expect(parseResponse('anthropic', { content: [], stop_reason: 'max_tokens' }).stop).toBe('max_tokens');
    expect(parseResponse('anthropic', { content: [], stop_reason: 'pause_turn' }).stop).toBe('continue');
    expect(parseResponse('anthropic', { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' }).stop).toBe('end');
  });

  it('OpenAI: tool_calls with JSON-string arguments; bad JSON is reported, not thrown', () => {
    const r = parseResponse('openai', { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_units', arguments: '{"units":"mm"}' } }, { id: 'c2', type: 'function', function: { name: 'undo', arguments: '{oops' } }] } }] });
    expect(r.stop).toBe('tool_use');
    expect(r.calls[0]).toEqual({ id: 'c1', name: 'set_units', args: { units: 'mm' } });
    expect(Object.keys(r.calls[1].args)).toEqual(['__bad_arguments']);
    expect(parseResponse('openai', { choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stop).toBe('max_tokens');
    expect(parseResponse('openai', { choices: [{ finish_reason: 'content_filter', message: { content: null } }] }).stop).toBe('blocked');
    expect(() => parseResponse('openai', { choices: [] })).toThrow(/no message/);
  });

  it('Gemini: functionCall parts, thought text skipped, blocks explained', () => {
    const r = parseResponse('gemini', { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text: 'OK' }, { functionCall: { name: 'set_units', args: { units: 'mm' } }, thoughtSignature: 'S' }] } }] });
    expect(r).toMatchObject({ texts: ['OK'], calls: [{ id: 'gemini_call_1', name: 'set_units', args: { units: 'mm' } }], stop: 'tool_use' });
    expect((r.modelTurn as any).parts[2].thoughtSignature).toBe('S');
    expect(parseResponse('gemini', { promptFeedback: { blockReason: 'SAFETY' } })).toMatchObject({ stop: 'blocked', detail: expect.stringContaining('SAFETY') });
    expect(parseResponse('gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }).stop).toBe('max_tokens');
    expect(parseResponse('gemini', { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }] }).stop).toBe('blocked');
  });
});

describe('instructions and guards', () => {
  it('uses the same instructions as Claude Code, without its tool prefix or web tools', () => {
    const p = byokSystemPrompt();
    expect(p).not.toContain('mcp__chatcad__');
    expect(p).not.toMatch(/WebSearch|WebFetch/);
    expect(p).toContain('Call the tools by their plain names');
    expect(p.length).toBeGreaterThan(read('bridge/system-prompt.md').length - 400);
    expect(() => byokSystemPrompt('changed prompt')).toThrow(/system-prompt.md changed/);
  });

  it('has the same usage guards as the Claude Code path', () => {
    expect(BYOK_LIMITS).toEqual(LIMITS);
  });
});

/** A fake provider: answers in turn from a script, recording each request the proxy would get. */
function fakeProxy(answers: any[]) {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const a = answers.shift();
    if (!a) throw new Error('no more scripted answers');
    return new Response(JSON.stringify(a.json ?? a), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

/** The same two tool calls (a sketch, then an extrude) in each provider's own format. */
function plateScript(p: ByokProvider): any[] {
  const sketchArgs = { name: 'Base Plate Sketch', plane: 'XY', entities: [{ type: 'rectangle', x: 0, y: 0, width: 4, height: 2 }] };
  const extrudeArgs = (id: string) => ({ name: 'Base Plate', sketch_id: id, depth: 0.5, operation: 'new' });
  // The sketch id is not known in advance: the second answer is built from the first result.
  if (p === 'anthropic') return [
    { content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'text', text: 'Sketching the plate.' }, { type: 'tool_use', id: 'tu_1', name: 'create_sketch', input: sketchArgs }], stop_reason: 'tool_use' },
    (id: string) => ({ content: [{ type: 'tool_use', id: 'tu_2', name: 'extrude', input: extrudeArgs(id) }], stop_reason: 'tool_use' }),
    { content: [{ type: 'text', text: 'Built a 4 x 2 x 0.5 plate.' }], stop_reason: 'end_turn' },
  ];
  if (p === 'openai') return [
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Sketching the plate.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_sketch', arguments: JSON.stringify(sketchArgs) } }] } }] },
    (id: string) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'extrude', arguments: JSON.stringify(extrudeArgs(id)) } }] } }] }),
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Built a 4 x 2 x 0.5 plate.' } }] },
  ];
  return [
    { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Sketching the plate.' }, { functionCall: { name: 'create_sketch', args: sketchArgs }, thoughtSignature: 'SIG1' }] } }] },
    (id: string) => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'extrude', args: extrudeArgs(id) }, thoughtSignature: 'SIG2' }] } }] }),
    { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Built a 4 x 2 x 0.5 plate.' }] } }] },
  ];
}

describe('the chat loop builds real, editable features with every provider', () => {
  for (const p of PROVIDERS) {
    it(`${p}: sketch + extrude through /api/proxy, key only in the header, features named and editable`, async () => {
      const store = new DocumentStore();
      const script = plateScript(p);
      const seen: any[] = [];
      let sketchId = '';
      const fetchFn = (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
        let a = script.shift();
        if (typeof a === 'function') {
          sketchId = store.state.features.find((f) => f.type === 'sketch')!.id;
          a = a(sketchId);
        }
        return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch;
      const events: any[] = [];
      const r = await runAgent({ provider: p, model: DEFAULT_MODELS[p], apiKey: 'test-key-123', ctx: ctx(store), history: [], text: 'Make a 4 x 2 x 0.5 plate', onEvent: (e) => events.push(e), fetchFn });
      expect(r, JSON.stringify(r.error)).toMatchObject({ ok: true });
      // Real features in the tree, with the names the AI gave them.
      const names = store.state.features.map((f) => f.name);
      expect(names).toEqual(expect.arrayContaining(['Base Plate Sketch', 'Base Plate']));
      const reg = await ctx(store).regen();
      expect(reg.status.every((s: any) => s.ok)).toBe(true);
      // Every request went to the relative proxy path, with the key only in the header.
      expect(seen).toHaveLength(3);
      for (const s of seen) {
        expect(s.url).toBe(PROXY_PATH);
        expect(s.headers[KEY_HEADER]).toBe('test-key-123');
        expect(JSON.stringify(s.body)).not.toContain('test-key-123');
        expect(s.body.provider).toBe(p);
      }
      // The model's own turns went back unchanged (thinking signatures, thought signatures).
      const last = JSON.stringify(seen[2].body.body);
      if (p === 'anthropic') expect(last).toContain('"signature":"sig-1"');
      if (p === 'gemini') { expect(last).toContain('"thoughtSignature":"SIG1"'); expect(last).toContain('"thoughtSignature":"SIG2"'); }
      if (p === 'openai') expect(last).toContain('"tool_call_id":"call_2"');
      // The chat showed the text and both steps.
      expect(events.filter((e) => e.type === 'text').map((e) => e.text)).toEqual(['Sketching the plate.', 'Built a 4 x 2 x 0.5 plate.']);
      expect(events.filter((e) => e.type === 'tool_end').map((e) => [e.call.name, e.ok])).toEqual([['create_sketch', true], ['extrude', true]]);
      // The history carries on for the next message.
      expect(r.history.length).toBeGreaterThanOrEqual(5);
    });
  }

  it('the plate really is 4 x 2 x 0.5 in (exact kernel volume)', async () => {
    const store = new DocumentStore();
    const script = plateScript('anthropic');
    const fetchFn = (async () => {
      let a = script.shift();
      if (typeof a === 'function') a = a(store.state.features.find((f) => f.type === 'sketch')!.id);
      return new Response(JSON.stringify(a), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runAgent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', ctx: ctx(store), history: [], text: 'plate', onEvent: () => {}, fetchFn });
    expect(r.ok).toBe(true);
    const reg = await ctx(store).regen();
    const mm3PerIn3 = 25.4 ** 3;
    expect(Math.abs(reg.mass!.volume - 4 * 2 * 0.5 * mm3PerIn3)).toBeLessThan(1e-6 * mm3PerIn3);
  });
});

describe('usage guards and errors', () => {
  const failing = (n: number) => Array.from({ length: n }, (_, i) => ({ content: [{ type: 'tool_use', id: `t${i}`, name: 'delete_feature', input: { id: 'nope' } }], stop_reason: 'tool_use' }));

  it('stops when the same call fails 3 times in a row', async () => {
    const { seen, fetchFn } = fakeProxy(failing(10));
    const r = await runAgent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', ctx: ctx(new DocumentStore()), history: [], text: 'x', onEvent: () => {}, fetchFn });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/failed 3 times in a row/);
    expect(seen).toHaveLength(3);
  });

  it('stops at the reply limit', async () => {
    const answers = Array.from({ length: 5 }, (_, i) => ({ content: [{ type: 'tool_use', id: `t${i}`, name: 'get_model_state', input: {} }], stop_reason: 'tool_use' }));
    const { seen, fetchFn } = fakeProxy(answers);
    const r = await runAgent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', ctx: ctx(new DocumentStore()), history: [], text: 'x', onEvent: () => {}, fetchFn, limits: { maxTurns: 3 } });
    expect(r.error).toMatch(/safety limit of 3 AI replies/);
    expect(seen).toHaveLength(3);
  });

  it('stops at the tool-call limit and refuses renders over the view limit', async () => {
    const calls = Array.from({ length: 4 }, (_, i) => ({ type: 'tool_use', id: `v${i}`, name: 'view_model', input: {} }));
    const { fetchFn } = fakeProxy([{ content: calls, stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
    const ends: any[] = [];
    const store = new DocumentStore();
    const c = { ...ctx(store), snapshot: async () => [{ view: 'front', png: 'AAAA' }] };
    const r = await runAgent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', ctx: c, history: [], text: 'x', onEvent: (e) => { if (e.type === 'tool_end') ends.push(e); }, fetchFn, limits: { maxViews: 2 } });
    expect(r.ok).toBe(true);
    expect(ends.map((e) => e.ok)).toEqual([true, true, false, false]);
    expect(ends[2].detail).toMatch(/view_model limit reached/);
    const { fetchFn: f2 } = fakeProxy([{ content: calls, stop_reason: 'tool_use' }]);
    const r2 = await runAgent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', ctx: c, history: [], text: 'x', onEvent: () => {}, fetchFn: f2, limits: { maxToolCalls: 2 } });
    expect(r2.error).toMatch(/safety limit of 2 CAD tool calls/);
  });

  it('explains a rejected key, a rate limit, an unknown model and a missing proxy in plain words', async () => {
    const req = buildPayload({ provider: 'openai', model: 'gpt-6-sol', system: 'S', tools: [], history: [] });
    const call = (status: number, body: string) => callProxy(req, 'k', (async () => new Response(body, { status })) as any);
    await expect(call(401, '{"error":{"message":"Incorrect API key"}}')).rejects.toThrow(/OpenAI did not accept your API key \(Incorrect API key\)/);
    await expect(call(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}')).rejects.toThrow(/did not accept your API key/);
    await expect(call(429, '{"error":{"message":"quota"}}')).rejects.toThrow(/over a limit/);
    await expect(call(404, '{"error":{"message":"no such model"}}')).rejects.toThrow(/does not know that model/);
    await expect(call(404, '<!doctype html><html></html>')).rejects.toThrow(/proxy is not set up/);
    await expect(call(200, '<!doctype html>')).rejects.toThrow(/proxy is not set up/);
    await expect(call(400, '{"proxyError":"No API key was sent."}')).rejects.toThrow('No API key was sent.');
    await expect(call(413, 'Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE')).rejects.toThrow(/too large to send.*New chat/);
    await expect(callProxy(req, 'k', (async () => { throw new TypeError('net'); }) as any)).rejects.toThrow(/Could not reach the AI proxy/);
  });

  it('Stop ends the request between replies', async () => {
    const abort = new AbortController();
    const fetchFn = (async () => {
      abort.abort();
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 't', name: 'get_model_state', input: {} }], stop_reason: 'tool_use' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runAgent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', ctx: ctx(new DocumentStore()), history: [], text: 'x', onEvent: () => {}, fetchFn, signal: abort.signal });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Stopped/);
  });
});

describe('request size (Vercel Functions accept at most 4.5 MB)', () => {
  // One render's base64 (a real 640 px render is roughly 50 to 300 KB).
  const png = (n: number) => `render${n}x`.padEnd(300_000, 'A');
  const chat = (p: ByokProvider, renders: number) => {
    let h = appendUser(p, [], 'make a bracket');
    for (let n = 0; n < renders; n++) {
      const call = { id: `c${n}`, name: 'view_model', args: {} };
      const turn = p === 'anthropic' ? { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: {} }] }
        : p === 'openai' ? { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: '{}' } }] }
        : { role: 'model', parts: [{ functionCall: { name: call.name, args: {} } }] };
      h = appendToolResults(p, h, turn, [{ call, ok: true, text: '{"ok":true}', images: [{ data: png(n), mimeType: 'image/png' }] }]);
    }
    return h;
  };
  const size = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
  const images = (h: unknown[]) => { const out: string[] = []; walk(h, (k, v) => { if ((k === 'data' || k === 'url') && typeof v === 'string' && v.length > 1000) out.push(v); }); return out; };

  it('stays under the limit, with room for headers below Vercel\'s 4.5 MB', () => {
    expect(MAX_REQUEST_BYTES).toBeLessThanOrEqual(4_000_000);
  });

  for (const p of PROVIDERS) {
    it(`${p}: a small chat is sent unchanged`, () => {
      const history = chat(p, 3);
      const r = fitPayload({ provider: p, model: 'm', system: 'S', tools: TOOL_DEFS, history })!;
      expect(r.removed).toBe(0);
      expect(r.history).toBe(history);
    });

    it(`${p}: a long chat drops its oldest renders first, keeps the newest, and fits`, () => {
      const history = chat(p, 30);
      const before = JSON.stringify(history);
      const r = fitPayload({ provider: p, model: 'm', system: 'S', tools: TOOL_DEFS, history })!;
      expect(r).not.toBeNull();
      expect(size(r.payload)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
      expect(r.removed).toBeGreaterThan(0);
      // The caller's history is not changed; the returned one has notes where renders were.
      expect(JSON.stringify(history)).toBe(before);
      expect(JSON.stringify(r.history).split(IMAGE_REMOVED_NOTE).length - 1).toBe(r.removed);
      const kept = images(r.history);
      expect(kept.length).toBe(30 - r.removed);
      // The newest render is the last one kept, the oldest is gone.
      expect(kept.at(-1)).toContain('render29x');
      expect(kept.some((d) => d.includes('render0x'))).toBe(false);
      // Model turns are untouched (thinking blocks / thought signatures must stay as returned).
      const modelTurns = (h: any[]) => JSON.stringify(h.filter((t) => t?.role !== 'user' && t?.role !== 'tool'));
      expect(modelTurns(r.history)).toBe(modelTurns(history));
    });
  }

  it('a chat too large even without renders stops with a plain message, before calling the proxy', async () => {
    let called = 0;
    const fetchFn = (async () => { called++; return new Response('{}'); }) as unknown as typeof fetch;
    const huge = appendUser('anthropic', [], 'x'.repeat(MAX_REQUEST_BYTES));
    expect(fitPayload({ provider: 'anthropic', model: 'm', system: 'S', tools: [], history: huge })).toBeNull();
    const r = await runAgent({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k', ctx: ctx(new DocumentStore()), history: huge, text: 'go', onEvent: () => {}, fetchFn });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large to send.*New chat/);
    expect(called).toBe(0);
  });
});

describe('settings (localStorage)', () => {
  it('saves and reads the provider, key and model; empty model means the default', () => {
    g.localStorage = new MemStorage();
    expect(readAiSettings()).toEqual({ provider: null, apiKey: '', model: '' });
    saveAiSettings({ provider: 'gemini', apiKey: '  my-key  ', model: '' });
    expect(g.localStorage.getItem(STORAGE_KEYS.provider)).toBe('gemini');
    expect(g.localStorage.getItem(STORAGE_KEYS.apiKey)).toBe('my-key');
    expect(g.localStorage.getItem(STORAGE_KEYS.model)).toBeNull();
    expect(readAiSettings()).toEqual({ provider: 'gemini', apiKey: 'my-key', model: '' });
    expect(effectiveModel('gemini', '')).toBe('gemini-3.8-flash');
    expect(effectiveModel('gemini', 'gemini-4-argon')).toBe('gemini-4-argon');
  });

  it('refuses keys and model names that are paste mistakes', () => {
    g.localStorage = new MemStorage();
    expect(keyProblem('sk test')).toMatch(/spaces/);
    expect(keyProblem('x'.repeat(600))).toMatch(/too long/);
    expect(keyProblem('abc-DEF_123')).toBeNull();
    expect(modelProblem('gpt 6')).toMatch(/letters, digits/);
    expect(modelProblem('../../x')).toMatch(/letters, digits/);
    expect(() => saveAiSettings({ provider: 'openai', apiKey: 'a b', model: '' })).toThrow(/spaces/);
  });

  it('says so in plain words when the browser blocks saving', () => {
    expect(() => saveAiSettings({ provider: 'openai', apiKey: 'k', model: '' })).toThrow(/blocks saving settings/);
  });
});

describe('no keys or secrets in the code', () => {
  const files = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(join(root, p)).isDirectory() ? files(p) : [p];
  });
  it('no API keys, secrets or default tokens anywhere in the app, the proxy or the deploy files', () => {
    const KEY_LIKE = /sk-ant-[A-Za-z0-9_-]{8,}|sk-(proj-)?[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|Bearer [A-Za-z0-9._-]{16,}|xai-[A-Za-z0-9]{20,}/;
    const all = [...files('src'), ...files('proxy'), ...files('functions'), ...files('api'), 'vercel.json', 'vite.config.ts'].filter((f) => /\.(ts|tsx|js|mjs|json|md)$/.test(f));
    for (const f of all) expect(read(f), f).not.toMatch(KEY_LIKE);
  });
});
