/**
 * The geometry worker client: one request at a time, newer rebuilds and
 * previews replace queued ones, and a crashed (or too large) worker is
 * replaced by a fresh one without losing the model. Uses a fake worker.
 */
import { describe, it, expect, vi } from 'vitest';
import { KernelClient, KernelCrash, Superseded, type WorkerLike, type RestartInfo } from '../src/kernel/client';
import { emptyDocument } from '../src/core/model';

class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent | Event) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  sent: { id: number; req: any }[] = [];
  terminated = false;
  postMessage(msg: any) { this.sent.push(msg); }
  terminate() { this.terminated = true; }
  /** Answer the oldest unanswered request. */
  answer(over: Record<string, unknown> = {}) {
    const m = this.sent[this.answered++];
    this.onmessage?.({ data: { id: m.id, ok: true, result: `${m.req.op}:${m.req.doc?.n ?? ''}`, heap: 1e8, ...over } } as MessageEvent);
  }
  answered = 0;
  get waiting() { return this.sent.length - this.answered; }
}

function setup(opts: { heapLimit?: number } = {}) {
  const workers: FakeWorker[] = [];
  const restarts: RestartInfo[] = [];
  const client = new KernelClient({ createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, onRestart: (i) => restarts.push(i), ...opts });
  return { client, workers, restarts, w: () => workers[workers.length - 1] };
}
const regen = (n: number) => ({ op: 'regen' as const, doc: { n } as any });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('kernel client queue', () => {
  it('sends one request at a time, in order', async () => {
    const { client, w } = setup();
    const a = client.call(regen(1));
    const b = client.call({ op: 'info', ref: { kind: 'face', index: 0 } });
    expect(w().sent.map((m) => m.req.op)).toEqual(['regen']);
    w().answer();
    expect(await a).toBe('regen:1');
    expect(w().sent.map((m) => m.req.op)).toEqual(['regen', 'info']);
    w().answer();
    expect(await b).toBe('info:');
  });

  it('typing 5 values quickly rebuilds at most twice: the one running and the newest', async () => {
    const { client, w } = setup();
    const ps = [1, 2, 3, 4, 5].map((n) => client.call(regen(n), { supersede: 'viewport' }));
    const settled = ps.map((p) => p.then((v) => v, (e) => e));
    w().answer();
    await flush();
    w().answer();
    const out = await Promise.all(settled);
    expect(w().sent.map((m) => m.req.doc.n)).toEqual([1, 5]);
    expect(out[0]).toBe('regen:1');
    expect(out[4]).toBe('regen:5');
    for (const e of out.slice(1, 4)) expect(e).toBeInstanceOf(Superseded);
  });

  it('a superseding key only replaces requests with the same key', async () => {
    const { client, w } = setup();
    client.call(regen(1), { supersede: 'viewport' });
    const chat = client.call(regen(2));
    const pv = client.call({ op: 'preview', doc: { n: 3 } as any, featureId: 'f' }, { supersede: 'preview' });
    client.call(regen(4), { supersede: 'viewport' });
    for (let i = 0; i < 4 && w().waiting; i++) { w().answer(); await flush(); }
    expect(w().sent.map((m) => m.req.doc.n)).toEqual([1, 2, 3, 4]);
    expect(await chat).toBe('regen:2');
    expect(await pv).toBe('preview:3');
  });
});

describe('kernel client watchdog', () => {
  it('a fatal kernel error fails the running request, starts a fresh worker, and the queue carries on', async () => {
    const { client, workers, restarts, w } = setup();
    const good = client.call(regen(1));
    w().answer();
    await good;
    const bad = client.call(regen(2));
    const next = client.call(regen(3));
    w().answer({ ok: false, error: 'RuntimeError: Aborted(OOM)', fatal: true });
    await expect(bad).rejects.toBeInstanceOf(KernelCrash);
    expect(workers.length).toBe(2);
    expect(workers[0].terminated).toBe(true);
    await flush();
    expect(restarts).toEqual([{ reason: 'crash', repeated: false }]);
    // The queued rebuild runs on the fresh worker (a rebuild needs no replay).
    expect(w().sent.map((m) => m.req.doc.n)).toEqual([3]);
    w().answer();
    expect(await next).toBe('regen:3');
  });

  it('an uncaught worker error is a crash too; a request that reads the model gets the last model rebuilt first', async () => {
    const { client, restarts, w } = setup();
    const r = client.call({ op: 'regen', doc: { n: 7 } as any, mass: true });
    w().answer();
    await r;
    const q = client.call({ op: 'quality' });
    const info = client.call({ op: 'info', ref: { kind: 'face', index: 0 } });
    w().onerror?.(new Event('error'));
    await expect(q).rejects.toBeInstanceOf(KernelCrash);
    await flush();
    expect(restarts).toEqual([{ reason: 'crash', repeated: false }]);
    // Replay of the last rebuild (no mesh), then the info request.
    expect(w().sent.map((m) => m.req)).toEqual([{ op: 'regen', doc: { n: 7 }, mass: true, mesh: false }]);
    w().answer();
    await flush();
    expect(w().sent.map((m) => m.req.op)).toEqual(['regen', 'info']);
    w().answer();
    expect(await info).toBe('info:');
  });

  it('a second crash before any rebuild succeeds is reported as repeated and fails what was waiting', async () => {
    const { client, workers, restarts, w } = setup();
    const a = client.call(regen(1));
    const b = client.call(regen(1));
    const c = client.call({ op: 'quality' });
    w().answer({ ok: false, error: 'memory access out of bounds', fatal: true });
    await expect(a).rejects.toBeInstanceOf(KernelCrash);
    w().answer({ ok: false, error: 'memory access out of bounds', fatal: true });
    await expect(b).rejects.toBeInstanceOf(KernelCrash);
    await expect(c).rejects.toThrow(/keeps crashing/);
    await flush();
    expect(restarts).toEqual([{ reason: 'crash', repeated: false }, { reason: 'crash', repeated: true }]);
    // No worker is started until the next request (a worker that fails at startup cannot loop).
    expect(workers.length).toBe(2);
    const d = client.call(regen(2));
    expect(workers.length).toBe(3);
    w().answer();
    expect(await d).toBe('regen:2');
  });

  it('replaces the worker before the next request once the heap is too large, rebuilding the model when it is read', async () => {
    const { client, workers, restarts, w } = setup({ heapLimit: 1e9 });
    const r = client.call(regen(1));
    w().answer({ heap: 1.2e9 });
    await r;
    expect(workers.length).toBe(1);
    const s = client.call({ op: 'exportStep', doc: emptyDocument(), unit: 'in', schema: 'AP214', name: 'Part' });
    expect(workers.length).toBe(2);
    expect(workers[0].terminated).toBe(true);
    expect(w().sent.map((m) => m.req.op)).toEqual(['regen']);
    w().answer();
    await flush();
    w().answer();
    expect(await s).toBe('exportStep:');
    await flush();
    expect(restarts).toEqual([{ reason: 'memory', repeated: false }]);
  });

  it('replays the last model once: a replay that fails does not repeat', async () => {
    const { client, w } = setup();
    const r = client.call(regen(1));
    w().answer();
    await r;
    w().onerror?.(new Event('error'));
    const q = client.call({ op: 'quality' });
    expect(w().sent.map((m) => m.req.op)).toEqual(['regen']);
    w().answer({ ok: false, error: 'Some modelling error' });
    await flush();
    expect(w().sent.map((m) => m.req.op)).toEqual(['regen', 'quality']);
    w().answer();
    expect(await q).toBe('quality:');
  });

  it('ignores messages from a worker that was replaced', async () => {
    const { client, workers, w } = setup();
    const a = client.call(regen(1));
    const old = w();
    old.onerror?.(new Event('error'));
    await expect(a).rejects.toBeInstanceOf(KernelCrash);
    const b = client.call(regen(2));
    const spy = vi.fn();
    b.then(spy);
    old.onmessage?.({ data: { id: 2, ok: true, result: 'stale' } } as MessageEvent);
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(workers.length).toBe(2);
    workers[1].answer();
    expect(await b).toBe('regen:2');
  });
});
