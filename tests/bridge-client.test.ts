/**
 * The chat window never re-sends a message by itself,
 * and a request that a usage guard stopped is still one undo step.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DocumentStore } from '../src/core/store';

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void; onclose?: () => void; onmessage?: (ev: { data: string }) => void;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  receive(m: object) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

const g = globalThis as any;
let saved: any;
beforeAll(() => { saved = g.WebSocket; g.WebSocket = FakeSocket; });
afterAll(() => { g.WebSocket = saved; });

describe('chat window (E5)', () => {
  it('does not re-send a request after the connection drops and comes back', async () => {
    const { BridgeClient } = await import('../src/ai/bridgeClient');
    const store = new DocumentStore();
    const client = new BridgeClient({ store } as any, 'ws://test/chatcad-bridge?role=app');
    FakeSocket.all[0].open();
    client.send('make a plate');
    client.send('make a plate'); // a double click while running is ignored
    expect(FakeSocket.all[0].sent.filter((m) => m.type === 'chat')).toHaveLength(1);
    FakeSocket.all[0].drop();
    await new Promise((r) => setTimeout(r, 700)); // reconnect timer
    expect(FakeSocket.all.length).toBe(2);
    FakeSocket.all[1].open();
    await new Promise((r) => setTimeout(r, 50));
    expect(FakeSocket.all[1].sent.filter((m) => m.type === 'chat')).toHaveLength(0);
    expect(client.state.running).toBe(false);
  });

  it('keeps everything a stopped request built as one undo step, and shows why it stopped', async () => {
    const { BridgeClient } = await import('../src/ai/bridgeClient');
    const store = new DocumentStore();
    const client = new BridgeClient({ store } as any, 'ws://test/chatcad-bridge?role=app');
    const ws = FakeSocket.all.at(-1)!;
    ws.open();
    client.send('build a bracket');
    const id = ws.sent.find((m) => m.type === 'chat').id;
    store.setParameter('w', '2');
    store.setParameter('h', '3');
    ws.receive({ type: 'chat_done', id, ok: false, limit: 'repeat', error: 'Stopped because the same step failed 3 times in a row.' });
    expect(store.state.params.length).toBe(2);
    expect(store.undoLabel).toMatch(/^Claude: build a bracket/);
    store.undo();
    expect(store.state.params.length).toBe(0);
    expect(client.state.items.at(-1)).toEqual({ kind: 'error', text: 'Stopped because the same step failed 3 times in a row.' });
  });
});
