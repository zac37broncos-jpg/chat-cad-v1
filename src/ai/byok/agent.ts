/**
 * The in-browser chat loop for bring-your-own-key providers: send the conversation and CHAD's
 * tools to the model (through /api/proxy), run each tool call with the same executor the
 * Claude Code path uses, send the results back, repeat until the model is done.
 *
 * The usage guards are the same as the Claude Code path's (bridge/hub.mjs LIMITS, item E5), so
 * one request can never run away with the user's API credit:
 *  - maxTurns: model round trips per request.
 *  - maxToolCalls: CAD tool calls per request (build_model counts once).
 *  - maxViews: view_model renders per request (images cost the most).
 *  - repeatFailures: the same call failing this many times in a row stops the request.
 */
import SYSTEM_PROMPT from '../../../bridge/system-prompt.md?raw';
import { executeTool, TOOL_DEFS, type ExecutorContext } from '../executor';
import {
  appendModelTurn, appendToolResults, appendUser, BAD_ARGUMENTS, fitPayload, parseResponse, providerErrorMessage, MAX_REQUEST_BYTES,
  type ProxyRequest, type ToolCall, type ToolOutcome,
} from './providers';
import { PROVIDER_LABELS, type ByokProvider } from './settings';

/** Same numbers as bridge/hub.mjs LIMITS (tests/byok.test.ts checks they stay equal). */
export interface ByokLimits { maxTurns: number; maxToolCalls: number; maxViews: number; repeatFailures: number }
export const BYOK_LIMITS: Readonly<ByokLimits> = Object.freeze({ maxTurns: 60, maxToolCalls: 150, maxViews: 6, repeatFailures: 3 });

export const PROXY_PATH = '/api/proxy';
/** Header that carries the user's key to the proxy (the proxy turns it into the provider's own header). */
export const KEY_HEADER = 'X-Chad-Api-Key';

const PREFIX_LINE = '- The chatcad tools are named with their server prefix: call mcp__chatcad__build_model, mcp__chatcad__view_model, mcp__chatcad__get_reference, mcp__chatcad__check_part and so on (a bare name like build_model does not exist).';
const PREFIX_LINE_BYOK = '- Call the tools by their plain names: build_model, view_model, get_reference, check_part and so on.';
const RESEARCH = 'you must research it before modelling (never skip this, not even for a simple or familiar subject): one to three WebSearch queries and WebFetch on one or two good pages (an encyclopedia article, a sculpting or modelling guide) for its real shape and proportions, then';
const RESEARCH_BYOK = 'you must work out its real shape and proportions before modelling (never skip this, not even for a simple or familiar subject; this chat has no web search, so use what you know about the subject and say if you are unsure of a detail), then';

/**
 * The same instructions Claude Code gets (bridge/system-prompt.md), with the two lines that
 * only make sense there (tool-name prefix, web research tools) rewritten for this chat.
 * Throws if the prompt file changed so a rewrite no longer applies (a test catches that).
 */
export function byokSystemPrompt(base: string = SYSTEM_PROMPT): string {
  if (!base.includes(PREFIX_LINE) || !base.includes(RESEARCH)) throw new Error('bridge/system-prompt.md changed: update the rewrites in src/ai/byok/agent.ts');
  return base.replace(PREFIX_LINE, PREFIX_LINE_BYOK).replace(RESEARCH, RESEARCH_BYOK);
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall; ok: boolean; detail?: string };

export interface AgentOptions {
  provider: ByokProvider;
  model: string;
  apiKey: string;
  ctx: ExecutorContext;
  /** Conversation so far (provider-native), or [] for a new chat. */
  history: unknown[];
  text: string;
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  limits?: Partial<ByokLimits>;
  tools?: typeof TOOL_DEFS;
}

export interface AgentResult {
  ok: boolean;
  /** Plain-words reason when ok is false. */
  error?: string;
  /** The conversation to continue from next time. */
  history: unknown[];
}

/** An error the chat shows as it is. */
export class ChatError extends Error {}

const LIMIT_KEPT = 'Everything built so far is kept (one undo step). Ask again to continue.';
export const byokLimitMessage = (which: 'turns' | 'calls' | 'repeat', l: Readonly<ByokLimits> = BYOK_LIMITS) => {
  if (which === 'turns') return `Stopped at the safety limit of ${l.maxTurns} AI replies for one request, so a single request cannot use up your API credit. ${LIMIT_KEPT}`;
  if (which === 'calls') return `Stopped at the safety limit of ${l.maxToolCalls} CAD tool calls for one request, so a single request cannot use up your API credit. ${LIMIT_KEPT}`;
  return `Stopped because the same step failed ${l.repeatFailures} times in a row (it would keep failing and use up your API credit). ${LIMIT_KEPT}`;
};
const viewLimitError = (l: Readonly<ByokLimits> = BYOK_LIMITS) => `view_model limit reached: at most ${l.maxViews} renders per request (renders cost the user the most). Do not call view_model again in this request. Finish with what you have, and tell the user they can ask for another look.`;

const TOO_LARGE = `This chat has grown too large to send (over ${MAX_REQUEST_BYTES / 1_000_000} MB, the most the website's AI proxy accepts). Everything built so far is kept. Click New chat to continue in a fresh conversation.`;

/** Send one request to the proxy and return the provider's JSON, or throw a plain-words ChatError. */
export async function callProxy(req: ProxyRequest, apiKey: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<any> {
  const name = PROVIDER_LABELS[req.provider];
  let res: Response;
  try {
    res = await fetchFn(PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [KEY_HEADER]: apiKey },
      body: JSON.stringify(req),
      signal,
      credentials: 'same-origin',
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ChatError(`Could not reach the AI proxy (${PROXY_PATH}). Check your internet connection and try again.`);
  }
  const raw = await res.text();
  let json: any = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON: handled below */ }
  if (res.ok && json) return json;
  // Vercel answers an oversized body itself (413 FUNCTION_PAYLOAD_TOO_LARGE), before the proxy runs.
  if (res.status === 413) throw new ChatError(json?.proxyError ? String(json.proxyError) : TOO_LARGE);
  if (!json) {
    // A static host with no proxy answers with its own page (404 or the app's index.html).
    throw new ChatError(`The AI proxy is not set up on this website (${PROXY_PATH} answered with ${res.status} and no AI reply). See docs/BYOK_AI.md, "Deploy the proxy".`);
  }
  const msg = providerErrorMessage(json);
  if (json?.proxyError) throw new ChatError(String(json.proxyError));
  // Gemini answers a wrong key with 400 API_KEY_INVALID, not 401.
  const keyRejected = res.status === 401 || res.status === 403 || (res.status === 400 && /api[ _-]?key/i.test(msg ?? '') && /invalid|not valid|incorrect/i.test(msg ?? ''));
  if (keyRejected) throw new ChatError(`${name} did not accept your API key${msg ? ` (${msg})` : ''}. Open AI Settings (the gear in the chat) and check the key and the provider.`);
  if (res.status === 429) throw new ChatError(`${name} says you are over a limit (too many requests, or no credit left on that account)${msg ? `: ${msg}` : ''}. Wait a minute, or check your plan and billing with ${name}.`);
  if (res.status === 404) throw new ChatError(`${name} does not know that model${msg ? ` (${msg})` : ''}. Open AI Settings and pick another model, or leave the model empty for the default.`);
  if (res.status >= 500) throw new ChatError(`${name} had a problem on their side (${res.status})${msg ? `: ${msg}` : ''}. Try again in a moment.`);
  throw new ChatError(`${name} refused the request (${res.status})${msg ? `: ${msg}` : ''}.`);
}

/** Run one tool call; never throws (a failure goes back to the model as an error result). */
async function runTool(ctx: ExecutorContext, call: ToolCall): Promise<ToolOutcome> {
  if (BAD_ARGUMENTS in call.args) return { call, ok: false, text: `Error: the arguments were not valid JSON (${String(call.args[BAD_ARGUMENTS])}). Send the call again with valid JSON.`, images: [] };
  try {
    const result: any = await executeTool(ctx, call.name, call.args ?? {});
    const images = result && typeof result === 'object' && Array.isArray(result.images) ? result.images : [];
    const rest = images.length ? { ...result, images: undefined } : result;
    return { call, ok: !(rest && typeof rest === 'object' && rest.ok === false), text: JSON.stringify(rest ?? null, null, 1), images };
  } catch (e) {
    return { call, ok: false, text: `Error: ${e instanceof Error ? e.message : String(e)}`, images: [] };
  }
}

const toolErrorDetail = (o: ToolOutcome): string | undefined => {
  if (o.ok) return undefined;
  if (o.text.startsWith('Error:')) return o.text.replace(/^Error:\s*/, '');
  try { const r = JSON.parse(o.text); return typeof r?.message === 'string' ? r.message : undefined; } catch { return undefined; }
};

/** Run one chat request to the end (or until a guard, an error or the Stop button ends it). */
export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const limits = { ...BYOK_LIMITS, ...(o.limits ?? {}) };
  const tools = o.tools ?? TOOL_DEFS;
  const system = byokSystemPrompt();
  const fetchFn = o.fetchFn ?? fetch.bind(globalThis);
  let history = appendUser(o.provider, o.history, o.text);
  let toolCalls = 0;
  let views = 0;
  let lastFailKey: string | null = null;
  let failStreak = 0;
  const name = PROVIDER_LABELS[o.provider];
  const fail = (error: string): AgentResult => ({ ok: false, error, history });

  for (let turn = 0; turn < limits.maxTurns; turn++) {
    if (o.signal?.aborted) return fail('Stopped. Everything built so far is kept (one undo step).');
    let json: any;
    const fitted = fitPayload({ provider: o.provider, model: o.model, system, tools, history });
    if (!fitted) return fail(TOO_LARGE);
    history = fitted.history;
    try {
      json = await callProxy(fitted.payload, o.apiKey, fetchFn, o.signal);
    } catch (e) {
      if (o.signal?.aborted) return fail('Stopped. Everything built so far is kept (one undo step).');
      return fail(e instanceof Error ? e.message : String(e));
    }
    let parsed;
    try { parsed = parseResponse(o.provider, json); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
    for (const t of parsed.texts) o.onEvent({ type: 'text', text: t });

    if (parsed.stop === 'continue') { history = appendModelTurn(history, parsed.modelTurn); continue; }
    if (parsed.stop === 'end') return { ok: true, history: appendModelTurn(history, parsed.modelTurn) };
    if (parsed.stop === 'max_tokens') return fail(`${name} hit its reply length limit before finishing. Everything built so far is kept (one undo step). Ask again, or ask for the part in smaller steps.`);
    if (parsed.stop === 'refusal' || parsed.stop === 'blocked') return fail(`${name} declined this request${parsed.detail ? `: ${parsed.detail}` : '.'}`);

    // Tool calls: run them in order, then hand back every result together.
    const outcomes: ToolOutcome[] = [];
    let stopWith: string | null = null;
    for (const call of parsed.calls) {
      o.onEvent({ type: 'tool_start', call });
      let out: ToolOutcome;
      if (stopWith || o.signal?.aborted) {
        out = { call, ok: false, text: 'Error: This request was stopped.', images: [] };
      } else if (++toolCalls > limits.maxToolCalls) {
        stopWith = byokLimitMessage('calls', limits);
        out = { call, ok: false, text: `Error: ${stopWith}`, images: [] };
      } else if (call.name === 'view_model' && ++views > limits.maxViews) {
        out = { call, ok: false, text: `Error: ${viewLimitError(limits)}`, images: [] };
      } else {
        out = await runTool(o.ctx, call);
      }
      outcomes.push(out);
      o.onEvent({ type: 'tool_end', call, ok: out.ok, detail: toolErrorDetail(out) });
      // Loop detection: the same call failing again and again.
      let key: string;
      try { key = `${call.name} ${JSON.stringify(call.args ?? {})}`; } catch { key = call.name; }
      if (out.ok) { lastFailKey = null; failStreak = 0; } else {
        failStreak = lastFailKey === key ? failStreak + 1 : 1;
        lastFailKey = key;
        if (failStreak >= limits.repeatFailures && !stopWith) stopWith = byokLimitMessage('repeat', limits);
      }
    }
    // Keep the conversation valid for the next message even when a guard stops here.
    history = appendToolResults(o.provider, history, parsed.modelTurn, outcomes);
    if (o.signal?.aborted) return fail('Stopped. Everything built so far is kept (one undo step).');
    if (stopWith) return fail(stopWith);
  }
  return fail(byokLimitMessage('turns', limits));
}
