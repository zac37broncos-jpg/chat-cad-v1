import type { KernelRequest, KernelResponseMap } from './protocol';

/** The part of a Worker the client uses (tests pass a fake). */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent | Event) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

/** A queued request that a newer request with the same `supersede` key replaced. Callers ignore it. */
export class Superseded extends Error {
  constructor() { super('Superseded by a newer request'); this.name = 'Superseded'; }
}

/** The worker crashed while running this request. */
export class KernelCrash extends Error {
  constructor(msg = 'The geometry kernel crashed (out of memory or an internal error) and was restarted. Try that step again.') { super(msg); this.name = 'KernelCrash'; }
}

export type RestartReason = 'crash' | 'memory';
export interface RestartInfo {
  reason: RestartReason;
  /** A second crash with no successful rebuild in between: the model itself probably crashes the kernel, so do not rebuild it automatically. */
  repeated: boolean;
}

export interface KernelClientOptions {
  createWorker?: () => WorkerLike;
  /** Called after the worker was replaced. */
  onRestart?: (info: RestartInfo) => void;
  /** Replace the worker before the next request once its heap passes this many bytes. */
  heapLimit?: number;
}

interface Job { id: number; req: KernelRequest; key?: string; resolve: (v: any) => void; reject: (e: Error) => void; internal?: boolean }

/**
 * The OpenCascade WASM heap only grows (freed memory is reused but never given
 * back; see mem.ts for what still leaks), the limit is 4 GB, and past about
 * 2.5 GB a boolean was seen to fail and the kernel to crash (seen in testing).
 * Past this size the worker is replaced by a fresh one (about a second plus a
 * rebuild) before the next request.
 */
const HEAP_LIMIT = 1.5e9;
/** Requests that read the last rebuilt shape: after a restart the last rebuild is replayed first. */
const NEEDS_SHAPE = new Set<KernelRequest['op']>(['info', 'distance', 'exportStep', 'exportStl', 'quality']);

const defaultWorker = (): WorkerLike => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;

/**
 * Promise-based client for the geometry worker.
 *
 * - One request runs at a time, in order. A request with a `supersede` key
 *   replaces a queued (not yet started) request with the same key, whose
 *   promise rejects with `Superseded`: typing 5 values quickly rebuilds the
 *   model at most twice (the one running and the newest).
 * - Watchdog: if the worker crashes (a fatal kernel error such as running out
 *   of memory, or an uncaught worker error) the running request fails with a
 *   plain message, a fresh worker starts and `onRestart` is called; queued
 *   requests carry on. The worker is also replaced when its heap gets too big.
 *   A fresh worker has no model: before a request that reads the model, the
 *   last successful rebuild is replayed.
 */
export class KernelClient {
  /** null after repeated crashes: a fresh worker starts with the next request. */
  private worker: WorkerLike | null;
  private seq = 0;
  private queue: Job[] = [];
  private running: Job | null = null;
  private lastRegen: Extract<KernelRequest, { op: 'regen' }> | null = null;
  /** The worker has no model yet (fresh after a restart). */
  private needsReplay = false;
  private restartBeforeNext = false;
  /** A crash happened and no rebuild has succeeded since. */
  private crashedSinceRebuild = false;
  private readonly opts: Required<Omit<KernelClientOptions, 'onRestart'>> & Pick<KernelClientOptions, 'onRestart'>;

  constructor(opts: KernelClientOptions = {}) {
    this.opts = { createWorker: opts.createWorker ?? defaultWorker, heapLimit: opts.heapLimit ?? HEAP_LIMIT, onRestart: opts.onRestart };
    this.worker = this.start();
  }

  set onRestart(fn: ((info: RestartInfo) => void) | undefined) { this.opts.onRestart = fn; }

  call<K extends KernelRequest['op']>(req: Extract<KernelRequest, { op: K }>, opts: { supersede?: string } = {}): Promise<KernelResponseMap[K]> {
    return new Promise((resolve, reject) => {
      const key = opts.supersede;
      if (key) {
        for (const old of this.queue.filter((j) => j.key === key)) old.reject(new Superseded());
        this.queue = this.queue.filter((j) => j.key !== key);
      }
      this.queue.push({ id: ++this.seq, req, key, resolve, reject });
      this.pump();
    });
  }

  private start(): WorkerLike {
    const w = this.opts.createWorker();
    w.onmessage = (ev) => { if (w === this.worker) this.receive(ev.data); };
    w.onerror = () => { if (w === this.worker) this.crash(); };
    w.onmessageerror = () => { if (w === this.worker) this.crash(); };
    return w;
  }

  private pump(): void {
    if (this.running || !this.queue.length) return;
    if (this.restartBeforeNext) this.restart('memory');
    this.worker ??= this.start();
    let job = this.queue[0];
    if (this.needsReplay && this.lastRegen && NEEDS_SHAPE.has(job.req.op)) {
      // Rebuild the last model on the fresh worker first (no mesh needed: the viewport has it).
      job = { id: ++this.seq, req: { ...this.lastRegen, mesh: false }, resolve: () => {}, reject: () => {}, internal: true };
    } else this.queue.shift();
    this.running = job;
    this.worker.postMessage({ id: job.id, req: job.req });
  }

  private receive(data: { id: number; ok: boolean; result?: unknown; error?: string; fatal?: boolean; heap?: number }): void {
    const job = this.running;
    if (!job || data.id !== job.id) return;
    this.running = null;
    if (data.fatal) {
      job.reject(new KernelCrash());
      this.crash();
      return;
    }
    // A replay is tried once, whatever its outcome (a failing replay must not repeat forever).
    if (job.internal) this.needsReplay = false;
    if (data.ok && job.req.op === 'regen') {
      this.lastRegen = job.req; this.needsReplay = false;
      if (!job.internal) this.crashedSinceRebuild = false;
    }
    if ((data.heap ?? 0) > this.opts.heapLimit) this.restartBeforeNext = true;
    if (data.ok) job.resolve(data.result); else job.reject(new Error(data.error));
    this.pump();
  }

  /** The worker died or its kernel is broken: fail the running request, start a fresh worker, carry on. */
  private crash(): void {
    const job = this.running;
    this.running = null;
    job?.reject(new KernelCrash());
    // Replaying the last model crashed a fresh kernel: do not replay it again.
    if (job?.internal) this.lastRegen = null;
    const repeated = this.crashedSinceRebuild;
    this.crashedSinceRebuild = true;
    if (repeated) {
      // Probably the model itself: fail what was waiting; the user changes the model to go on.
      const waiting = this.queue; this.queue = [];
      for (const j of waiting) j.reject(new KernelCrash('The geometry kernel keeps crashing on this model and was restarted. Undo the last change (Ctrl+Z) or change it, and the model rebuilds.'));
    }
    this.restart('crash', repeated);
    this.pump();
  }

  /**
   * Replace the worker. After repeated crashes the new worker starts only with
   * the next request, so a worker that fails at startup cannot loop by itself.
   * `onRestart` runs after the current call returns (it may queue requests).
   */
  private restart(reason: RestartReason, repeated = false): void {
    try { this.worker?.terminate(); } catch { /* already gone */ }
    this.restartBeforeNext = false;
    this.needsReplay = true;
    this.worker = repeated ? null : this.start();
    console.info(`[kernel] ${reason === 'memory' ? 'heap is large' : 'the kernel crashed'}: starting a fresh geometry worker`);
    const cb = this.opts.onRestart;
    if (cb) queueMicrotask(() => cb({ reason, repeated }));
  }
}
