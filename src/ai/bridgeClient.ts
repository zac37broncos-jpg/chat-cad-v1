/**
 * The AI chat client. Two ways to run the chat, chosen in AI Settings (src/ui/AiSettingsModal.tsx):
 *
 *  - Bring your own key (the published app): the user's own Anthropic, OpenAI or Google Gemini
 *    key, read from localStorage for each request and sent only to this site's /api/proxy,
 *    which forwards it to that provider (proxy/core.mjs). The chat loop runs here in the
 *    browser (src/ai/byok/agent.ts). No key, secret or default token is in the code.
 *  - Claude Code on this computer (local dev server only): the local bridge (bridge/hub.mjs)
 *    runs Claude Code with the user's Claude subscription; this file receives its tool calls
 *    over a WebSocket and executes them, and turns Claude Code's stream-json events into chat items.
 *
 * Either way every tool call runs through the same executor, so each step is a real, named,
 * editable feature, and the whole request is one undo step.
 */
import { executeTool, type ExecutorContext } from './executor';
import { runAgent, type AgentEvent } from './byok/agent';
import type { ToolCall } from './byok/providers';
import { effectiveModel, isByok, PROVIDER_LABELS, readAiSettings, subscribeAiSettings, type AiProvider, type ByokProvider } from './byok/settings';

/** loggedIn: true / false, or null when it could not be checked (then the chat is allowed and Claude Code reports problems itself). */
export interface ClaudeStatus { found: boolean; path: string | null; version: string | null; loggedIn?: boolean | null }

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'step'; toolUseId: string; tool: string; label: string; state: 'running' | 'ok' | 'error'; detail?: string }
  | { kind: 'error'; text: string }
  | { kind: 'info'; text: string };

export interface BridgeState {
  /** Connected to the local Claude Code bridge (only when CHAD runs from `npm run dev`). */
  connected: boolean;
  claude: ClaudeStatus | null;
  externalClient: boolean;
  running: boolean;
  items: ChatItem[];
  sessionId: string | null;
  /** The sign-in window is open and the hub is waiting for the sign-in to finish. */
  signingIn: boolean;
  /** What the next request runs on (AI Settings, or Claude Code when nothing was chosen and the local bridge is there). */
  provider: AiProvider;
  /** A bring-your-own-key provider is chosen but no key is saved. */
  needsKey: boolean;
}

/** Is this page served from this computer (where the local Claude Code bridge can exist)? */
export function isLocalPage(): boolean {
  try { return typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname); } catch { return false; }
}

const STEP_LABELS: Record<string, string> = {
  get_model_state: 'Reading the model',
  set_units: 'Setting units',
  set_part_name: 'Naming the part',
  set_material: 'Setting material',
  set_parameter: 'Setting parameter',
  create_sketch: 'Creating sketch',
  add_to_sketch: 'Adding to sketch',
  extrude: 'Extruding',
  revolve: 'Revolving',
  update_feature: 'Editing feature',
  delete_feature: 'Deleting feature',
  undo: 'Undoing',
  build_model: 'Building',
  view_model: 'Looking at the model',
  loft_sections: 'Lofting body',
  tube: 'Making tube',
  profile_body: 'Sculpting body',
  loft: 'Lofting',
  sweep: 'Sweeping',
  fillet: 'Filleting',
  mirror: 'Mirroring',
  get_topology: 'Reading faces and edges',
};

function stepLabel(tool: string, input: any): string {
  const base = STEP_LABELS[tool] ?? tool;
  const named = input?.name ? ` "${input.name}"` : '';
  if (tool === 'set_parameter' && input?.name) return `${base} ${input.name} = ${input.value}`;
  if (tool === 'set_part_name' && input?.name) return `${base} "${input.name}"`;
  if (tool === 'set_material' && input?.name) return `${base}: ${input.name}`;
  if (tool === 'create_sketch' && input?.plane) return `${base}${named} on ${({ XY: 'Top', XZ: 'Front', YZ: 'Right' } as any)[input.plane] ?? input.plane} plane`;
  if (tool === 'extrude') {
    const how = input?.through_all ? ' through all' : input?.depth !== undefined ? ` ${input.depth}` : '';
    return input?.operation === 'cut' ? `Cutting${named}${how}` : `${base}${named}${how}`;
  }
  if (tool === 'revolve') return `${input?.operation === 'cut' ? 'Cutting (revolve)' : base}${named}`;
  if (tool === 'set_units') return `${base} to ${input?.units}`;
  if (tool === 'build_model' && Array.isArray(input?.steps)) {
    const names = input.steps.map((st: any) => st?.args?.name ?? st?.name).filter((n: unknown) => typeof n === 'string');
    const shown = names.slice(0, 6).join(', ');
    return `${base} ${input.steps.length} steps${shown ? `: ${shown}${names.length > 6 ? ', …' : ''}` : ''}`;
  }
  if (named) return `${base}${named}`;
  return base;
}

export interface BridgeOptions {
  /** fetch for bring-your-own-key requests (tests pass a fake). */
  fetchFn?: typeof fetch;
  /** Shown when the user sends without a key (default: the browser's alert). */
  alert?: (message: string) => void;
}

export const NO_KEY_MESSAGE = 'Add your API key first: open AI Settings (the gear in the chat), choose your AI provider and paste your key. Your key stays in this browser.';

export class BridgeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<(s: BridgeState) => void>();
  private chatSeq = 0;
  private activeRun: { id: string; checkpoint: number; text: string; abort?: AbortController } | null = null;
  private retry = 0;
  private url: string | null;
  /** Bring-your-own-key conversation (provider-native), and which provider/model it belongs to. */
  private byok: { provider: ByokProvider; model: string; history: unknown[] } | null = null;
  private stepSeq = 0;
  /** Called when the chat needs AI Settings opened (no key yet). Set by the chat panel. */
  onOpenSettings: (() => void) | null = null;
  state: BridgeState = { connected: false, claude: null, externalClient: false, running: false, items: [], sessionId: null, signingIn: false, provider: 'anthropic', needsKey: true };

  /**
   * @param url the local bridge WebSocket. Default: this page's own dev server, but only when the
   *   page is served from this computer (the bridge only accepts loopback connections anyway).
   */
  constructor(private ctx: ExecutorContext, url?: string, private opts: BridgeOptions = {}) {
    this.url = url ?? (isLocalPage() ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chatcad-bridge?role=app` : null);
    this.refreshMode();
    subscribeAiSettings(() => this.refreshMode());
    if (this.url) this.connect();
  }

  /** Which way the next request runs, from AI Settings and whether the local bridge is there. */
  private resolveMode(): { provider: AiProvider; needsKey: boolean } {
    const st = readAiSettings();
    // Nothing chosen yet: Claude Code where the local bridge exists (as before), else your own key.
    const provider: AiProvider = st.provider ?? (this.url ? 'claude-code' : 'anthropic');
    return { provider, needsKey: isByok(provider) && !st.apiKey };
  }
  private refreshMode() {
    const m = this.resolveMode();
    if (m.provider !== this.state.provider || m.needsKey !== this.state.needsKey) this.set(m);
  }

  subscribe(fn: (s: BridgeState) => void) { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn); }; }
  private set(patch: Partial<BridgeState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }
  private push(item: ChatItem) { this.set({ items: [...this.state.items, item] }); }
  private updateStep(toolUseId: string, patch: Partial<Extract<ChatItem, { kind: 'step' }>>) {
    this.set({ items: this.state.items.map((i) => (i.kind === 'step' && i.toolUseId === toolUseId ? { ...i, ...patch } : i)) });
  }

  private connect() {
    if (!this.url) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.set({ connected: true }); };
    ws.onclose = () => {
      this.set({ connected: false });
      if (this.activeRun && !this.activeRun.abort) this.finishRun(false, 'Lost connection to the dev server');
      setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.retry++));
    };
    ws.onmessage = (ev) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'status') this.set({ claude: m.claude, externalClient: m.mcpConnected && !this.activeRun, ...(m.claude?.loggedIn ? { signingIn: false } : {}) });
      else if (m.type === 'tool_call') this.onToolCall(m);
      else if (m.type === 'login_started') {
        this.set({ signingIn: !!m.ok });
        if (!m.ok) this.push({ kind: 'error', text: `Could not open the sign-in window. Open a terminal and run: ${m.command ?? 'claude auth login'}` });
      }
      else if (m.type === 'chat_event' && m.id === this.activeRun?.id) this.onEvent(m.event);
      else if (m.type === 'chat_done' && m.id === this.activeRun?.id) {
        if (m.sessionId) this.set({ sessionId: m.sessionId });
        this.finishRun(m.ok, m.error);
      }
    };
  }

  private async onToolCall(m: { callId: string; name: string; args: any }) {
    let reply: any;
    try {
      const result = await executeTool(this.ctx, m.name, m.args ?? {});
      reply = { type: 'tool_result', callId: m.callId, ok: true, result };
    } catch (e) {
      reply = { type: 'tool_result', callId: m.callId, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.ws?.send(JSON.stringify(reply));
    // Calls from an external client (e.g. Claude desktop) show up in the log too.
    if (!this.activeRun) this.push({ kind: 'info', text: `${STEP_LABELS[m.name] ?? m.name} (from Claude desktop)${reply.ok ? '' : `: ${reply.error}`}` });
  }

  private onEvent(ev: any) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      const srv = (ev.mcp_servers ?? []).find((s: any) => s.name === 'chatcad');
      if (srv && srv.status !== 'connected') this.push({ kind: 'error', text: `CAD tools failed to load (${srv.status}).` });
      return;
    }
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) this.push({ kind: 'assistant', text: c.text.trim() });
        if (c.type === 'tool_use') {
          const tool = String(c.name).replace(/^mcp__chatcad__/, '');
          this.push({ kind: 'step', toolUseId: c.id, tool, label: stepLabel(tool, c.input), state: 'running' });
        }
      }
      return;
    }
    if (ev.type === 'user') {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('') : String(c.content ?? '');
        let failed = !!c.is_error;
        let detail: string | undefined = failed ? text.replace(/^Error:\s*/, '') : undefined;
        if (!failed) {
          try { const r = JSON.parse(text); if (r.ok === false) { failed = true; detail = r.message; } } catch { /* plain text */ }
        }
        this.updateStep(c.tool_use_id, { state: failed ? 'error' : 'ok', ...(detail ? { detail } : {}) });
      }
      return;
    }
    if (ev.type === 'result' && ev.is_error && ev.result) this.push({ kind: 'error', text: String(ev.result) });
  }

  send(text: string) {
    const t = text.trim();
    if (!t || this.activeRun) return;
    const { provider } = this.resolveMode();
    if (isByok(provider)) { this.sendByok(provider, t); return; }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!this.url) this.push({ kind: 'error', text: 'Claude Code only works when CHAD runs on your own computer (npm run dev). Open AI Settings and choose a provider with your own API key.' });
      return;
    }
    const id = `r${++this.chatSeq}_${Date.now().toString(36)}`;
    // Every step of this request is kept (even past the history limit) until it is merged into one undo step.
    this.activeRun = { id, checkpoint: this.ctx.store.openCheckpoint(), text: t };
    this.push({ kind: 'user', text: t });
    this.set({ running: true });
    this.ws.send(JSON.stringify({ type: 'chat', id, text: t, sessionId: this.state.sessionId }));
  }

  /** Bring-your-own-key request: the chat loop runs here, with the key read from AI Settings now. */
  private sendByok(provider: ByokProvider, t: string) {
    const settings = readAiSettings();
    if (!settings.apiKey) {
      this.push({ kind: 'error', text: NO_KEY_MESSAGE });
      const show = this.opts.alert ?? ((m: string) => { if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(m); });
      show(NO_KEY_MESSAGE);
      this.onOpenSettings?.();
      return;
    }
    const model = effectiveModel(provider, settings.model);
    // A different provider or model starts a new conversation (the formats differ).
    if (!this.byok || this.byok.provider !== provider || this.byok.model !== model) {
      if (this.byok && this.state.items.length) this.push({ kind: 'info', text: `New conversation with ${PROVIDER_LABELS[provider]} (${model}).` });
      this.byok = { provider, model, history: [] };
    }
    const id = `r${++this.chatSeq}_${Date.now().toString(36)}`;
    const abort = new AbortController();
    this.activeRun = { id, checkpoint: this.ctx.store.openCheckpoint(), text: t, abort };
    this.push({ kind: 'user', text: t });
    this.set({ running: true });
    const stepIds = new WeakMap<ToolCall, string>();
    const onEvent = (e: AgentEvent) => {
      if (this.activeRun?.id !== id) return;
      if (e.type === 'text') this.push({ kind: 'assistant', text: e.text });
      else if (e.type === 'tool_start') {
        const sid = `s${++this.stepSeq}`;
        stepIds.set(e.call, sid);
        this.push({ kind: 'step', toolUseId: sid, tool: e.call.name, label: stepLabel(e.call.name, e.call.args), state: 'running' });
      } else {
        const sid = stepIds.get(e.call);
        if (sid) this.updateStep(sid, { state: e.ok ? 'ok' : 'error', ...(e.detail ? { detail: e.detail } : {}) });
      }
    };
    const conv = this.byok;
    runAgent({ provider, model, apiKey: settings.apiKey, ctx: this.ctx, history: conv.history, text: t, onEvent, signal: abort.signal, fetchFn: this.opts.fetchFn })
      .then((r) => {
        if (this.byok === conv) conv.history = r.history;
        if (this.activeRun?.id === id) this.finishRun(r.ok, r.error);
      }, (e) => { if (this.activeRun?.id === id) this.finishRun(false, e instanceof Error ? e.message : String(e)); });
  }

  stop() {
    if (!this.activeRun) return;
    if (this.activeRun.abort) { this.activeRun.abort.abort(); return; }
    this.ws?.send(JSON.stringify({ type: 'stop', id: this.activeRun.id }));
  }

  recheck() { this.ws?.send(JSON.stringify({ type: 'recheck' })); }

  /** Open the one-time Claude sign-in (a small window that opens the browser). The status turns green by itself afterwards. */
  login() { this.ws?.send(JSON.stringify({ type: 'login' })); }

  newChat() { if (!this.activeRun) { this.byok = null; this.set({ items: [], sessionId: null }); } }

  private finishRun(ok: boolean, error?: string) {
    const run = this.activeRun;
    if (!run) return;
    this.activeRun = null;
    // Whole request = one undo step.
    const who = run.abort ? 'AI' : 'Claude';
    this.ctx.store.squashSince(run.checkpoint, `${who}: ${run.text.length > 40 ? `${run.text.slice(0, 40)}…` : run.text}`);
    // Any step still "running" did not finish.
    this.set({ items: this.state.items.map((i) => (i.kind === 'step' && i.state === 'running' ? { ...i, state: 'error', detail: 'Interrupted' } : i)), running: false });
    if (!ok && error) this.push({ kind: 'error', text: error });
  }
}
