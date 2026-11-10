/**
 * The three providers' request and response formats, in one place.
 *
 * Each conversation is kept in the provider's own message format and only ever appended to,
 * and every model turn is stored exactly as the provider returned it. That keeps Anthropic
 * thinking blocks and Gemini thought signatures intact, which both providers require during
 * tool use. The one exception is fitPayload: when a long chat would be too large to send, it
 * swaps the oldest renders (in user turns only, never in model turns) for a short text note.
 *
 * Formats (checked against the official docs on 2026-11-10, sources in docs/BYOK_AI.md):
 *  - Anthropic Messages API: POST https://api.anthropic.com/v1/messages
 *  - OpenAI Chat Completions: POST https://api.openai.com/v1/chat/completions
 *  - Gemini generateContent: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * The browser never calls those addresses itself: everything goes to the app's own /api/proxy,
 * which adds the key header the provider expects (proxy/core.mjs).
 */
import { forGemini, inlineRefs } from './schema';
import type { ByokProvider } from './settings';

export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }

/** One tool call the model asked for. */
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }

/** What a tool returned, ready to hand back to the model. */
export interface ToolOutcome {
  call: ToolCall;
  ok: boolean;
  /** JSON (or plain error text) for the model. */
  text: string;
  /** Renders from view_model (base64 PNG). */
  images: { data: string; mimeType: string }[];
}

export type StopKind = 'tool_use' | 'end' | 'max_tokens' | 'refusal' | 'continue' | 'blocked';

/** A provider response in neutral terms, plus the provider's own model turn to append. */
export interface ParsedTurn {
  texts: string[];
  calls: ToolCall[];
  stop: StopKind;
  /** Plain-words reason for a refusal or block, when the provider gave one. */
  detail?: string;
  /** The model's turn exactly as returned (appended to the history unchanged). */
  modelTurn: unknown;
}

/** Output tokens per model reply. Non-streaming requests stay well inside HTTP time limits. */
export const MAX_OUTPUT_TOKENS = 16000;

/** Anthropic models that accept the server-side refusal fallback ("fallbacks": "default"). */
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1']);
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** What the browser sends to /api/proxy. The key travels in a header, never in the body. */
export interface ProxyRequest {
  provider: ByokProvider;
  model: string;
  /** Extra provider headers the proxy may forward (only anthropic-beta, checked by the proxy). */
  headers?: Record<string, string>;
  body: unknown;
}

export interface PayloadInput {
  provider: ByokProvider;
  model: string;
  system: string;
  tools: ToolDef[];
  /** The provider-native message history (see newHistory / appendUser / appendToolResults). */
  history: unknown[];
}

/** Build the provider-specific JSON body for the next model turn. */
export function buildPayload(p: PayloadInput): ProxyRequest {
  switch (p.provider) {
    case 'anthropic': {
      const fallback = ANTHROPIC_FALLBACK_MODELS.has(p.model);
      return {
        provider: 'anthropic',
        model: p.model,
        ...(fallback ? { headers: { 'anthropic-beta': ANTHROPIC_FALLBACK_BETA } } : {}),
        body: {
          model: p.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: p.system,
          tools: p.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
          messages: p.history,
          // CAD precision work: think carefully (Claude Opus 5.5 defaults to medium).
          output_config: { effort: 'high' },
          // Caches tools + instructions + the conversation so far: each tool round trip re-reads it cheaply.
          cache_control: { type: 'ephemeral' },
          // A rare safety decline is retried on another Claude model inside the same request.
          ...(fallback ? { fallbacks: 'default' } : {}),
        },
      };
    }
    case 'openai':
      return {
        provider: 'openai',
        model: p.model,
        body: {
          model: p.model,
          messages: [{ role: 'developer', content: p.system }, ...p.history],
          tools: p.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: inlineRefs(t.inputSchema) } })),
          tool_choice: 'auto',
          // Calls change the part in order, so they run one after another anyway.
          parallel_tool_calls: false,
          // OpenAI's docs: in Chat Completions, GPT-6 Sol / Luna call tools only with reasoning_effort "none".
          reasoning_effort: 'none',
          max_completion_tokens: MAX_OUTPUT_TOKENS,
        },
      };
    case 'gemini':
      return {
        provider: 'gemini',
        model: p.model,
        body: {
          systemInstruction: { parts: [{ text: p.system }] },
          contents: p.history,
          tools: [{ functionDeclarations: p.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: forGemini(t.inputSchema) })) }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        },
      };
    default: {
      const never: never = p.provider;
      throw new Error(`Unknown AI provider: ${String(never)}`);
    }
  }
}

/** Start a conversation, or add the user's next message to it. */
export function appendUser(provider: ByokProvider, history: unknown[], text: string): unknown[] {
  switch (provider) {
    case 'anthropic': return [...history, { role: 'user', content: [{ type: 'text', text }] }];
    case 'openai': return [...history, { role: 'user', content: text }];
    case 'gemini': {
      // A request that was stopped can leave the last turn as the user's: add to that turn, so
      // user and model turns keep alternating.
      const last: any = history.at(-1);
      if (last?.role === 'user' && Array.isArray(last.parts)) return [...history.slice(0, -1), { ...last, parts: [...last.parts, { text }] }];
      return [...history, { role: 'user', parts: [{ text }] }];
    }
    default: throw new Error(`Unknown AI provider: ${String(provider)}`);
  }
}

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  const v = JSON.parse(raw); // a malformed call is reported to the model (see agent.ts)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('tool arguments must be a JSON object');
  return v as Record<string, unknown>;
};

/** Set on a call whose arguments were not valid JSON (the model is told, and can retry). */
export const BAD_ARGUMENTS = '__bad_arguments';

/** Read a provider response. Throws a plain-words error for a response without a usable turn. */
export function parseResponse(provider: ByokProvider, json: any): ParsedTurn {
  switch (provider) {
    case 'anthropic': {
      const content: any[] = Array.isArray(json?.content) ? json.content : [];
      const texts = content.filter((c) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim()).map((c) => c.text.trim());
      const calls: ToolCall[] = content.filter((c) => c?.type === 'tool_use').map((c) => ({ id: String(c.id), name: String(c.name), args: c.input && typeof c.input === 'object' ? c.input : {} }));
      const sr = json?.stop_reason;
      const stop: StopKind = sr === 'tool_use' ? 'tool_use'
        : sr === 'max_tokens' ? 'max_tokens'
        : sr === 'refusal' ? 'refusal'
        : sr === 'pause_turn' ? 'continue'
        : 'end';
      const detail = sr === 'refusal' ? (json?.stop_details?.explanation ?? undefined) : undefined;
      // Exactly what came back (thinking and fallback blocks included).
      return { texts, calls: stop === 'tool_use' ? calls : [], stop, detail, modelTurn: { role: 'assistant', content } };
    }
    case 'openai': {
      const choice = json?.choices?.[0];
      if (!choice?.message) throw new Error('OpenAI sent back an answer with no message.');
      const m = choice.message;
      const texts = typeof m.content === 'string' && m.content.trim() ? [m.content.trim()] : [];
      const toolCalls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls.filter((t: any) => t?.type === 'function') : [];
      const calls = toolCalls.map((t) => {
        try { return { id: String(t.id), name: String(t.function?.name), args: parseArgs(t.function?.arguments) }; } catch (e) {
          return { id: String(t.id), name: String(t.function?.name), args: { [BAD_ARGUMENTS]: (e as Error).message } };
        }
      });
      const fr = choice.finish_reason;
      const stop: StopKind = calls.length ? 'tool_use' : fr === 'length' ? 'max_tokens' : fr === 'content_filter' ? 'blocked' : m.refusal ? 'refusal' : 'end';
      const modelTurn: any = { role: 'assistant', content: m.content ?? null };
      if (toolCalls.length) modelTurn.tool_calls = toolCalls;
      return { texts, calls, stop, detail: m.refusal ?? undefined, modelTurn };
    }
    case 'gemini': {
      const cand = json?.candidates?.[0];
      if (!cand) {
        const why = json?.promptFeedback?.blockReason;
        return { texts: [], calls: [], stop: 'blocked', detail: why ? `Gemini blocked the request (${why}).` : 'Gemini sent back no answer.', modelTurn: null };
      }
      const content = cand.content && Array.isArray(cand.content.parts) ? cand.content : { role: 'model', parts: [] };
      const parts: any[] = content.parts;
      const texts = parts.filter((x) => typeof x?.text === 'string' && !x.thought && x.text.trim()).map((x) => x.text.trim());
      let n = 0;
      const calls: ToolCall[] = parts.filter((x) => x?.functionCall).map((x) => ({
        id: typeof x.functionCall.id === 'string' && x.functionCall.id ? x.functionCall.id : `gemini_call_${++n}`,
        name: String(x.functionCall.name),
        args: x.functionCall.args && typeof x.functionCall.args === 'object' ? x.functionCall.args : {},
      }));
      const fr = cand.finishReason;
      const stop: StopKind = calls.length ? 'tool_use'
        : fr === 'MAX_TOKENS' ? 'max_tokens'
        : fr === 'CONTINUATION' ? 'continue'
        : fr === 'STOP' || fr === undefined || fr === 'FINISH_REASON_UNSPECIFIED' ? 'end'
        : 'blocked';
      const detail = stop === 'blocked' ? `Gemini stopped (${String(fr)}).` : undefined;
      // The model turn exactly as returned (thought signatures stay in their parts).
      return { texts, calls, stop, detail, modelTurn: { ...content, role: 'model' } };
    }
    default: throw new Error(`Unknown AI provider: ${String(provider)}`);
  }
}

const imageNote = (o: ToolOutcome) => `Renders from ${o.call.name} (call ${o.call.id}), in the order listed in its result:`;

/**
 * Append the model's turn and the results of all its tool calls (one turn of results, in call order).
 * Images go where each provider accepts them: inside the Anthropic tool result; for OpenAI (tool
 * messages are text only) in one user message after the tool messages; for Gemini as image parts
 * after the function responses in the same turn.
 */
export function appendToolResults(provider: ByokProvider, history: unknown[], modelTurn: unknown, results: ToolOutcome[]): unknown[] {
  switch (provider) {
    case 'anthropic': {
      const content = results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.call.id,
        ...(r.ok ? {} : { is_error: true }),
        content: [
          { type: 'text', text: r.text },
          ...r.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mimeType, data: im.data } })),
        ],
      }));
      return [...history, modelTurn, { role: 'user', content }];
    }
    case 'openai': {
      const out: unknown[] = [...history, modelTurn, ...results.map((r) => ({ role: 'tool', tool_call_id: r.call.id, content: r.text }))];
      const withImages = results.filter((r) => r.images.length);
      if (withImages.length) {
        out.push({
          role: 'user',
          content: withImages.flatMap((r) => [
            { type: 'text', text: imageNote(r) },
            ...r.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mimeType};base64,${im.data}` } })),
          ]),
        });
      }
      return out;
    }
    case 'gemini': {
      const parts: unknown[] = results.map((r) => {
        let value: unknown = r.text;
        if (r.ok) { try { value = JSON.parse(r.text); } catch { /* plain text */ } }
        const fr: Record<string, unknown> = { name: r.call.name, response: r.ok ? { output: value } : { error: r.text } };
        // Gemini gives calls an id on some models; echo it back when it did.
        if (!r.call.id.startsWith('gemini_call_')) fr.id = r.call.id;
        return { functionResponse: fr };
      });
      for (const r of results) {
        if (!r.images.length) continue;
        parts.push({ text: imageNote(r) });
        for (const im of r.images) parts.push({ inlineData: { mimeType: im.mimeType, data: im.data } });
      }
      return [...history, modelTurn, { role: 'user', parts }];
    }
    default: throw new Error(`Unknown AI provider: ${String(provider)}`);
  }
}

/** Append a final model turn that had no tool calls (so the next message continues the chat). */
export function appendModelTurn(history: unknown[], modelTurn: unknown): unknown[] {
  return modelTurn ? [...history, modelTurn] : history;
}

/** The provider's error message from an error response body, if it has one. */
export function providerErrorMessage(json: any): string | null {
  const m = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : null) ?? json?.message;
  return typeof m === 'string' && m.trim() ? m.trim() : null;
}

/**
 * The largest request the browser sends to /api/proxy, in bytes. Vercel Functions refuse request
 * bodies over 4.5 MB (413 FUNCTION_PAYLOAD_TOO_LARGE, https://vercel.com/docs/functions/limitations),
 * so this stays under that with room to spare. Renders are by far the largest part of a chat.
 */
export const MAX_REQUEST_BYTES = 4_000_000;
export const IMAGE_REMOVED_NOTE = '(An earlier render was removed here to keep the request small. Call view_model again if you need to see the part.)';

const isImage = (provider: ByokProvider, x: any): boolean => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  switch (provider) {
    case 'anthropic': return x.type === 'image';
    case 'openai': return x.type === 'image_url';
    case 'gemini': return 'inlineData' in x;
    default: return false;
  }
};
const imageNoteBlock = (provider: ByokProvider) => (provider === 'gemini' ? { text: IMAGE_REMOVED_NOTE } : { type: 'text', text: IMAGE_REMOVED_NOTE });
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** Every image block in the user turns of a history, oldest first. */
function imageSlots(provider: ByokProvider, history: unknown[]): { list: unknown[]; i: number; bytes: number }[] {
  const out: { list: unknown[]; i: number; bytes: number }[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => { if (isImage(provider, v)) out.push({ list: node, i, bytes: utf8Bytes(JSON.stringify(v)) }); else visit(v); });
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) visit(v);
    }
  };
  for (const turn of history) if ((turn as any)?.role === 'user') visit(turn);
  return out;
}

/**
 * Build the payload, and if it is larger than maxBytes, replace the oldest renders with a short
 * note until it fits. Returns the payload and the history to keep using (a copy when anything
 * was removed), or null when even without any render the chat is still too large.
 */
export function fitPayload(p: PayloadInput, maxBytes: number = MAX_REQUEST_BYTES): { payload: ProxyRequest; history: unknown[]; removed: number } | null {
  let payload = buildPayload(p);
  let size = utf8Bytes(JSON.stringify(payload));
  if (size <= maxBytes) return { payload, history: p.history, removed: 0 };
  const history = structuredClone(p.history);
  const noteBytes = utf8Bytes(JSON.stringify(imageNoteBlock(p.provider)));
  let removed = 0;
  for (const slot of imageSlots(p.provider, history)) {
    if (size <= maxBytes) break;
    slot.list[slot.i] = imageNoteBlock(p.provider);
    size -= slot.bytes - noteBytes;
    removed++;
  }
  if (!removed) return null;
  payload = buildPayload({ ...p, history });
  if (utf8Bytes(JSON.stringify(payload)) > maxBytes) return null;
  return { payload, history, removed };
}
