/**
 * The chat window with a bring-your-own-key provider (src/ai/bridgeClient.ts): it reads the
 * provider and key from localStorage for each request, refuses to send without a key (with an
 * alert and AI Settings opened), sends only to /api/proxy, and keeps a whole request one undo step.
 * The provider is faked: nothing here calls a real AI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DocumentStore } from '../src/core/store';
import { BridgeClient, NO_KEY_MESSAGE } from '../src/ai/bridgeClient';
import { saveAiSettings, STORAGE_KEYS, _resetAiSettingsCache } from '../src/ai/byok/settings';
import { PROXY_PATH, KEY_HEADER } from '../src/ai/byok/agent';

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
beforeEach(() => { g.localStorage = new MemStorage(); _resetAiSettingsCache(); });
afterEach(() => { delete g.localStorage; _resetAiSettingsCache(); });

const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

describe('bring-your-own-key chat window', () => {
  it('outside the local dev server, with nothing chosen, asks for a key instead of connecting anywhere', async () => {
    const calls: unknown[] = [];
    const alerts: string[] = [];
    const client = new BridgeClient({ store: new DocumentStore() } as any, undefined, { fetchFn: (async (...a: unknown[]) => { calls.push(a); return new Response('{}'); }) as any, alert: (m) => alerts.push(m) });
    let opened = 0;
    client.onOpenSettings = () => { opened++; };
    expect(client.state.provider).toBe('anthropic');
    expect(client.state.needsKey).toBe(true);
    client.send('make a plate');
    expect(alerts).toEqual([NO_KEY_MESSAGE]);
    expect(opened).toBe(1);
    expect(calls).toHaveLength(0);
    expect(client.state.running).toBe(false);
    expect(client.state.items.at(-1)).toEqual({ kind: 'error', text: NO_KEY_MESSAGE });
  });

  it('reads the key at send time, posts only to /api/proxy, shows the reply, and is one undo step', async () => {
    const store = new DocumentStore();
    const seen: { url: string; init: RequestInit }[] = [];
    const answers = [
      { content: [{ type: 'tool_use', id: 't1', name: 'set_part_name', input: { name: 'Bracket' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'tool_use', id: 't2', name: 'set_units', input: { units: 'mm' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Named the part and set mm.' }], stop_reason: 'end_turn' },
    ];
    const fetchFn = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify(answers.shift()), { status: 200 }); }) as any;
    const ctx = { store, regen: async () => ({ status: [], sketches: [], mass: null, mesh: null, ms: 0 }), selection: () => [], info: async () => ({}) } as any;
    const client = new BridgeClient(ctx, undefined, { fetchFn, alert: () => { throw new Error('no alert expected'); } });
    saveAiSettings({ provider: 'anthropic', apiKey: 'my-own-key', model: '' });
    expect(client.state.needsKey).toBe(false);
    const before = store.state.name;
    client.send('name it Bracket, in mm');
    expect(client.state.running).toBe(true);
    await until(() => !client.state.running);
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.url).toBe(PROXY_PATH);
      expect((s.init.headers as any)[KEY_HEADER]).toBe('my-own-key');
      expect(String(s.init.body)).not.toContain('my-own-key');
      expect(JSON.parse(String(s.init.body)).model).toBe('claude-opus-5-5');
    }
    expect(store.state.name).toBe('Bracket');
    expect(store.state.units).toBe('mm');
    const items = client.state.items;
    expect(items.filter((i) => i.kind === 'step').map((i: any) => [i.tool, i.state])).toEqual([['set_part_name', 'ok'], ['set_units', 'ok']]);
    expect(items.at(-1)).toEqual({ kind: 'assistant', text: 'Named the part and set mm.' });
    // The whole request undoes in one step.
    expect(store.undoLabel).toMatch(/^AI: name it Bracket/);
    store.undo();
    expect(store.state.name).toBe(before);
    expect(store.state.units).not.toBe('mm');
  });

  it('the next message continues the same conversation; New chat and another provider start fresh', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 }); }) as any;
    const client = new BridgeClient({ store: new DocumentStore() } as any, undefined, { fetchFn });
    saveAiSettings({ provider: 'anthropic', apiKey: 'k1', model: 'claude-sonnet-5-5' });
    client.send('one'); await until(() => !client.state.running);
    client.send('two'); await until(() => !client.state.running);
    expect(bodies[1].body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(bodies[1].model).toBe('claude-sonnet-5-5');
    client.newChat();
    client.send('three'); await until(() => !client.state.running);
    expect(bodies[2].body.messages).toHaveLength(1);
    saveAiSettings({ provider: 'openai', apiKey: 'k2', model: '' });
    // The openai answer shape this time.
    const f2 = client as any;
    f2.opts.fetchFn = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }] }), { status: 200 }); }) as any;
    client.send('four'); await until(() => !client.state.running);
    expect(bodies[3].provider).toBe('openai');
    expect(bodies[3].body.messages.map((m: any) => m.role)).toEqual(['developer', 'user']);
  });

  it('Stop ends a running request and keeps what it built', async () => {
    let release: () => void = () => {};
    const fetchFn = ((_u: string, init: RequestInit) => new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      release = () => resolve(new Response('{}'));
    })) as any;
    const client = new BridgeClient({ store: new DocumentStore() } as any, undefined, { fetchFn });
    saveAiSettings({ provider: 'gemini', apiKey: 'k', model: '' });
    client.send('build');
    expect(client.state.running).toBe(true);
    client.stop();
    await until(() => !client.state.running);
    expect(client.state.items.at(-1)).toMatchObject({ kind: 'error', text: expect.stringMatching(/^Stopped/) });
    release();
  });

  it('a stored provider choice is used even where the local bridge exists, and "Claude Code" keeps the old path', () => {
    g.localStorage.setItem(STORAGE_KEYS.provider, 'openai');
    _resetAiSettingsCache();
    const sockets: any[] = [];
    g.WebSocket = class { static OPEN = 1; readyState = 0; constructor(public url: string) { sockets.push(this); } send() {} };
    try {
      const a = new BridgeClient({ store: new DocumentStore() } as any, 'ws://test/chatcad-bridge?role=app');
      expect(a.state.provider).toBe('openai');
      g.localStorage.removeItem(STORAGE_KEYS.provider);
      _resetAiSettingsCache();
      const b = new BridgeClient({ store: new DocumentStore() } as any, 'ws://test/chatcad-bridge?role=app');
      expect(b.state.provider).toBe('claude-code');
      expect(sockets.length).toBe(2);
    } finally { delete g.WebSocket; }
  });
});
