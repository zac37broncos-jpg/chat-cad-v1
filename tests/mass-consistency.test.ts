/**
 * Mass Properties never shows a stale or partial number.
 *
 * Background: during the demo recording, Mass Properties once showed the L-bracket's volume
 * without its 22 mm wall hole. The most likely cause is that the hole had been deleted by hand
 * in that window (and autosave brings that part back at the next start), so the number matched
 * the part that was open. The investigation also found real gaps, fixed and tested here:
 *  - while a rebuild was running (an edit, undo/redo, a typed parameter, the chat building) the
 *    panel kept showing the previous model's number with no sign that it was old;
 *  - after the newest rebuild failed (for example the kernel crashed twice) it kept showing the
 *    last good model's number for a document that could not be built;
 *  - features that failed to rebuild were silently left out of the numbers;
 *  - the document store changed document objects it had already handed out, so a request
 *    waiting in the kernel queue, or the model the kernel replays after a restart, could hold
 *    a different document than the one it was made for.
 *
 * These tests run the real kernel code of the worker's 'regen' request (src/kernel/regenOp.ts)
 * behind the real KernelClient and the viewport's rebuild logic (src/ui/rebuilds.ts), with the
 * request copied when it is sent like a browser worker does, and compare every number the
 * panel would show with the closed-form volume of the document open at that moment.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { emptyDocument, rectangleEntities, newId, type CadDocument } from '../src/core/model';
import * as F from '../src/core/featureCommands';
import { holeSpec } from '../src/core/holeTables';
import { regenerate, type OC } from '../src/kernel/regen';
import { edgeRefFrom } from '../src/kernel/naming';
import { regenOp, newModelState, type ModelState } from '../src/kernel/regenOp';
import { KernelClient, type WorkerLike } from '../src/kernel/client';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { ViewportRebuilds } from '../src/ui/rebuilds';
import { massPanelState } from '../src/ui/massStatus';
import { massText } from '../src/ui/CommandPanel';
import { Autosaver, loadAutosave, type AutosaveDb, type SavedCopy, type LocalStore } from '../src/ui/autosave';
import type { RegenResponse } from '../src/kernel/protocol';

let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

/** Relative agreement with the closed-form volume (the exact B-rep integrates to about 1e-12). */
const EXACT = 1e-9;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

// ----------------------------------------------------------------- the demo's L-bracket
const M6_NORMAL = 6.6; // ISO 273 normal clearance hole for M6
const WALL_T = 8, WALL_H = 50, HOLE_D = 22, FILLET_R = 6;

/**
 * Closed-form volume (mm³) of the bracket: 100 x 60 x T plate, a 100 x 8 x 50 wall standing on
 * its back edge, four M6 clearance holes through the plate, a 22 mm hole through the wall and a
 * 6 mm fillet in the inside corner (it adds (1 - pi/4) r² of material per mm of corner).
 */
function bracketVolume(T: number, wallHole = true): number {
  return 100 * 60 * T + 100 * WALL_T * WALL_H
    - (wallHole ? Math.PI * (HOLE_D / 2) ** 2 * WALL_T : 0)
    - 4 * Math.PI * (M6_NORMAL / 2) ** 2 * T
    + (1 - Math.PI / 4) * FILLET_R ** 2 * 100;
}

/** The volume the open document must have: from its plate thickness and whether the wall hole is in it. */
function expectedVolume(doc: Readonly<CadDocument>): number {
  const T = Number(doc.params.find((p) => p.name === 'T')!.expr);
  const hole = doc.features.some((f) => f.name === 'Wall Hole' && !f.suppressed);
  return bracketVolume(T, hole);
}

/** The demo bracket, built the way the chat builds it: named features driven by parameters. */
function bracket(): DocumentStore {
  const st = new DocumentStore(emptyDocument('L-Mounting-Bracket', 'mm'));
  st.setParameter('T', '8');
  st.setParameter('WT', String(WALL_T));
  st.setParameter('WH', String(WALL_H));
  const plate = st.addSketch('XY', rectangleEntities(0, 0, 100, 60), { name: 'Base Plate Sketch' });
  st.addExtrude(plate, 'T', { name: 'Base Plate' });
  const wall = st.addSketch('XY', rectangleEntities(0, '60 - WT', 100, 'WT'), { name: 'Wall Sketch', offset: 'T' });
  st.addExtrude(wall, 'WH', { name: 'Wall' });
  const hole = F.addHole(st, { holeType: 'simple', standard: 'iso-metric', size: 'M6', end: 'through', placement: { base: 'XY', offset: 'T' }, points: [{ x: 10, y: 10 }], name: 'M6 Mounting Hole' });
  F.addLinearPattern(st, { features: [hole], dir1: { axis: 'X' }, spacing1: 80, count1: 2, dir2: { axis: 'Y' }, spacing2: 30, count2: 2, name: 'Mounting Hole Pattern' });
  const wh = st.addSketch('XZ', [{ id: newId('c'), kind: 'circle', center: { x: 50, y: 'T + WH/2' }, radius: HOLE_D / 2 }], { name: 'Wall Hole Sketch' });
  st.addExtrude(wh, 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Wall Hole' });
  // The inside corner: the edge where the plate's top meets the wall's front face.
  const t = regenerate(oc, st.state, { solver }).topology!;
  const i = t.edges.findIndex((e) => Math.hypot(e.mid[0] - 50, e.mid[1] - (60 - WALL_T), e.mid[2] - 8) < 1e-6);
  if (i < 0) throw new Error('inside corner edge not found');
  F.addFillet(st, { edges: [edgeRefFrom(t, i)], radius: FILLET_R, name: 'Corner Fillet' });
  return st;
}

const featureId = (st: DocumentStore, name: string) => st.state.features.find((f) => f.name === name)!.id;

// ----------------------------------------------------------------- the worker, in this process
/**
 * Runs the worker's real 'regen' code. Like a browser worker, the message is copied when it is
 * posted (structuredClone) and answered later (a macrotask per request), so requests really
 * queue and race with edits. `crash` makes the worker die on matching requests (like the WASM
 * kernel running out of memory).
 */
class InProcessWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent | Event) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  readonly model: ModelState = newModelState();
  readonly received: { id: number; req: any }[] = [];
  dead = false;
  constructor(private readonly crash: (req: any) => boolean) {}
  postMessage(msg: unknown) {
    const m = structuredClone(msg) as { id: number; req: any };
    this.received.push(m);
    setTimeout(() => {
      if (this.dead) return;
      if (this.crash(m.req)) { this.onmessage?.({ data: { id: m.id, ok: false, error: 'Aborted(OOM)', fatal: true } } as MessageEvent); return; }
      try {
        if (m.req.op !== 'regen') throw new Error(`test worker only rebuilds (got ${m.req.op})`);
        const { result } = regenOp(oc, this.model, m.req, solver);
        this.onmessage?.({ data: { id: m.id, ok: true, result } } as MessageEvent);
      } catch (e) {
        this.onmessage?.({ data: { id: m.id, ok: false, error: (e as Error).message } } as MessageEvent);
      }
    }, 0);
  }
  terminate() { this.dead = true; }
}

/** The app's wiring: a kernel client, the viewport rebuilds, a rebuild on every change and after a crash. */
function app(st: DocumentStore, crash: (req: any) => boolean = () => false) {
  const workers: InProcessWorker[] = [];
  const kernel = new KernelClient({ createWorker: () => { const w = new InProcessWorker(crash); workers.push(w); return w; } });
  const rebuilds = new ViewportRebuilds(kernel);
  let mass = true; // the Mass Properties panel is open
  kernel.onRestart = ({ reason, repeated }) => { if (reason === 'crash' && !repeated) void rebuilds.request(st.state, mass); };
  st.subscribe((d) => void rebuilds.request(d, mass));
  return {
    kernel, rebuilds, workers,
    setMassPanel(open: boolean) { mass = open; if (open) void rebuilds.request(st.state, true); },
    state: () => rebuilds.massState(st.state),
    /** Wait until no rebuild is queued or running. */
    async settle() { for (let i = 0; i < 10_000 && (rebuilds.busy || i < 2); i++) await tick(); },
  };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Seeded random numbers, so a failure always replays the same sequence. */
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

/** Every number the panel can show at this moment is the open document's exact volume. */
function checkShown(st: DocumentStore, a: ReturnType<typeof app>): 'ready' | 'other' {
  const s = a.state();
  if (s.kind !== 'ready') return 'other';
  expect(s.failed).toEqual([]);
  expect(rel(s.mass.volume, expectedVolume(st.state))).toBeLessThan(EXACT);
  return 'ready';
}

describe('the demo L-bracket: exact volume', () => {
  it('matches the closed form at 8 and 10 mm, and without the wall hole, through the worker code', () => {
    expect(holeSpec('iso-metric', 'simple', 'M6').diameter).toBeCloseTo(M6_NORMAL, 12);
    // The values in the demo report.
    expect(bracketVolume(8)).toBeCloseTo(84636.72, 2);
    expect(bracketVolume(10)).toBeCloseTo(96363.03, 2);
    const st = bracket();
    const model = newModelState();
    const vol = () => {
      const { result } = regenOp(oc, model, { op: 'regen', doc: st.state, mesh: false }, solver);
      expect(result.status.filter((s) => !s.ok)).toEqual([]);
      return result.mass!.volume;
    };
    expect(rel(vol(), bracketVolume(8))).toBeLessThan(EXACT);
    st.setParameter('T', '10');
    expect(rel(vol(), bracketVolume(10))).toBeLessThan(EXACT);
    // Deleting the wall hole leaves its material in: exactly the number seen in the demo.
    st.deleteFeature(featureId(st, 'Wall Hole'));
    expect(rel(vol(), bracketVolume(10, false))).toBeLessThan(EXACT);
    st.undo();
    expect(rel(vol(), bracketVolume(10))).toBeLessThan(EXACT);
    st.undo();
    expect(rel(vol(), bracketVolume(8))).toBeLessThan(EXACT);
    st.redo();
    expect(rel(vol(), bracketVolume(10))).toBeLessThan(EXACT);
  });

  it('a mass computed for one model is never reused for another (the per-shape cache)', () => {
    const st = bracket();
    const model = newModelState();
    const run = (mass: boolean) => regenOp(oc, model, { op: 'regen', doc: st.state, mesh: false, mass }, solver).result;
    expect(rel(run(true).mass!.volume, bracketVolume(8))).toBeLessThan(EXACT);
    // The same model again (the chat and the viewport asking): the cached mass, still right.
    expect(rel(run(false).mass!.volume, bracketVolume(8))).toBeLessThan(EXACT);
    // A changed model without mass asked for: no mass at all, never the old one.
    st.setParameter('T', '10');
    expect(run(false).mass).toBeNull();
    expect(rel(run(true).mass!.volume, bracketVolume(10))).toBeLessThan(EXACT);
    // Back to a model the history cache still holds: computed for that model.
    st.undo();
    expect(rel(run(true).mass!.volume, bracketVolume(8))).toBeLessThan(EXACT);
  });
});

describe('Mass Properties shows only the finished rebuild of the open document', () => {
  it('shows Updating while a rebuild runs, never the previous model\'s number', async () => {
    const st = bracket();
    const a = app(st);
    a.setMassPanel(true);
    expect(a.state().kind).toBe('updating');
    await a.settle();
    expect(checkShown(st, a)).toBe('ready');
    st.setParameter('T', '10');
    // The 8 mm result is still the last one that finished (the old panel showed it, with no sign
    // that it was old): it must not be shown for the 10 mm part.
    expect(rel(a.rebuilds.shown!.result.mass!.volume, bracketVolume(8))).toBeLessThan(EXACT);
    expect(a.state().kind).toBe('updating');
    await a.settle();
    const s = a.state();
    expect(s.kind === 'ready' && rel(s.mass.volume, bracketVolume(10))).toBeLessThan(EXACT);
    // Delete the wall hole, then undo it at once: neither the hole-less number nor any other shows in between.
    st.deleteFeature(featureId(st, 'Wall Hole'));
    expect(a.state().kind).toBe('updating');
    st.undo();
    expect(a.state().kind).toBe('updating');
    await a.settle();
    expect(checkShown(st, a)).toBe('ready');
    expect(rel((a.state() as any).mass.volume, bracketVolume(10))).toBeLessThan(EXACT);
  });

  it('rapid edits, undo/redo, deleting and suppressing the wall hole: every number shown is exact', async () => {
    for (const seed of [1, 2, 3]) {
      const rand = rng(seed);
      const st = bracket();
      const a = app(st);
      a.setMassPanel(true);
      await a.settle();
      let ready = 0, updating = 0;
      for (let step = 0; step < 30; step++) {
        const r = rand();
        try {
          if (r < 0.4) st.setParameter('T', String([8, 9, 10, 12][Math.floor(rand() * 4)]));
          else if (r < 0.55) { const h = st.state.features.find((f) => f.name === 'Wall Hole'); if (h) st.deleteFeature(h.id); }
          else if (r < 0.7) { const h = st.state.features.find((f) => f.name === 'Wall Hole'); if (h) st.setSuppressed(h.id, !h.suppressed); }
          else if (r < 0.85) st.undo();
          else st.redo();
        } catch { /* nothing to undo / redo */ }
        // Right after a change nothing old may show.
        if (a.state().kind === 'updating') updating++;
        else expect(checkShown(st, a)).toBe('ready'); // only when the change was a no-op (e.g. nothing to redo)
        // Let a random amount of work happen (sometimes none, sometimes all of it), checking as it goes.
        const waits = Math.floor(rand() * 4) === 0 ? -1 : Math.floor(rand() * 3);
        if (waits < 0) await a.settle();
        else for (let k = 0; k < waits; k++) await tick();
        if (checkShown(st, a) === 'ready') ready++;
      }
      await a.settle();
      expect(checkShown(st, a)).toBe('ready');
      // The sequence really exercised both cases.
      expect(ready).toBeGreaterThan(0);
      expect(updating).toBeGreaterThan(10);
    }
  });

  it('opening the panel after rebuilds that skipped mass properties shows Updating, then the exact number', async () => {
    const st = bracket();
    const a = app(st);
    a.setMassPanel(false);
    await a.settle();
    st.setParameter('T', '12');
    await a.settle();
    expect(a.rebuilds.shown?.result.mass).toBeNull();
    a.setMassPanel(true);
    expect(a.state().kind).toBe('updating');
    await a.settle();
    expect(checkShown(st, a)).toBe('ready');
  });

  it('after a kernel crash it rebuilds and shows the exact number; when the model keeps crashing it shows no number', async () => {
    const st = bracket();
    let crashT: string | null = null;
    let crashesLeft = 0;
    const tOf = (req: any) => req.doc?.params.find((p: any) => p.name === 'T')?.expr;
    const a = app(st, (req) => req.op === 'regen' && tOf(req) === crashT && crashesLeft-- > 0);
    a.setMassPanel(true);
    await a.settle();
    expect(checkShown(st, a)).toBe('ready');
    // One crash: the fresh worker rebuilds the model.
    crashT = '10'; crashesLeft = 1;
    const w0 = a.workers.length;
    st.setParameter('T', '10');
    await a.settle();
    expect(a.workers.length).toBe(w0 + 1);
    expect(checkShown(st, a)).toBe('ready');
    expect(rel((a.state() as any).mass.volume, bracketVolume(10))).toBeLessThan(EXACT);
    // A model that always crashes: no number at all (the old one belongs to another model).
    crashT = '12'; crashesLeft = Infinity;
    st.setParameter('T', '12');
    await a.settle();
    const s = a.state();
    expect(s.kind).toBe('failed');
    // Undo goes back to a model that builds: exact again.
    st.undo();
    await a.settle();
    expect(checkShown(st, a)).toBe('ready');
    expect(rel((a.state() as any).mass.volume, bracketVolume(10))).toBeLessThan(EXACT);
  });

  it('names features that failed to rebuild, because the numbers leave them out', async () => {
    const st = bracket();
    const a = app(st);
    a.setMassPanel(true);
    await a.settle();
    // A wall hole bigger than the wall is tall still cuts, so instead break it: a sketch circle with a bad radius.
    const sk = st.state.features.find((f) => f.name === 'Wall Hole Sketch')!;
    st.updateFeature(sk.id, { entities: [{ id: 'c1', kind: 'circle', center: { x: 50, y: 'T + WH/2' }, radius: 'NoSuchParam' }] });
    await a.settle();
    const s = a.state();
    expect(s.kind).toBe('ready');
    if (s.kind !== 'ready') return;
    expect(s.failed.length).toBeGreaterThan(0);
    expect(s.failed.some((n) => /Wall Hole/.test(n))).toBe(true);
    // The number is that of the part without the hole, and the panel says so.
    expect(rel(s.mass.volume, bracketVolume(8, false))).toBeLessThan(EXACT);
  });
});

describe('panel states (unit)', () => {
  const doc = emptyDocument('P', 'mm');
  const res = (over: Partial<RegenResponse> = {}): RegenResponse => ({ mesh: null, status: [], sketches: [], mass: { volume: 1000, area: 600, centroid: [0, 0, 0], bboxMin: [0, 0, 0], bboxMax: [10, 10, 10] }, ms: 1, ...over });
  it('decides from identity, busy, failure and whether mass was computed', () => {
    const other = { ...doc };
    expect(massPanelState({ current: doc, shown: null, busy: false, failure: null }).kind).toBe('updating');
    expect(massPanelState({ current: doc, shown: { doc, massRequested: true, result: res() }, busy: false, failure: null }).kind).toBe('ready');
    expect(massPanelState({ current: doc, shown: { doc, massRequested: true, result: res() }, busy: true, failure: null }).kind).toBe('updating');
    // A content-equal but different document object is not "the same document".
    expect(massPanelState({ current: other, shown: { doc, massRequested: true, result: res() }, busy: false, failure: null }).kind).toBe('updating');
    expect(massPanelState({ current: doc, shown: { doc, massRequested: false, result: res() }, busy: false, failure: null }).kind).toBe('updating');
    expect(massPanelState({ current: doc, shown: { doc, massRequested: true, result: res({ mass: null }) }, busy: false, failure: null }).kind).toBe('noSolid');
    expect(massPanelState({ current: doc, shown: { doc, massRequested: true, result: res() }, busy: false, failure: { doc, message: 'x' } })).toEqual({ kind: 'failed', message: 'x' });
    expect(massPanelState({ current: doc, shown: { doc, massRequested: true, result: res() }, busy: false, failure: { doc: other, message: 'x' } }).kind).toBe('ready');
    expect(massText(res().mass, doc)?.volume).toBe('1000.000000 mm³');
    expect(massText(null, doc)).toBeNull();
  });
});

describe('documents handed out are never changed afterwards (copy on write)', () => {
  it('an edit leaves earlier document objects exactly as they were; a no-op keeps the same object', () => {
    const st = new DocumentStore(emptyDocument('P', 'mm'));
    st.setParameter('T', '8');
    const before = st.state;
    const json = JSON.stringify(before);
    st.setParameter('T', '10');
    expect(JSON.stringify(before)).toBe(json);
    expect(st.state).not.toBe(before);
    // A command that fails changes nothing and keeps the current object.
    const cur = st.state;
    expect(() => st.setParameter('T', 'nope +')).toThrow();
    expect(st.state).toBe(cur);
    // Moving the rollback bar to where it is already is not a change.
    st.setRollback(null);
    expect(st.state).toBe(cur);
    st.undo();
    expect(JSON.stringify(st.state)).toBe(json);
    expect(JSON.stringify(cur)).not.toBe(json);
  });

  it('after a worker restart the kernel replays the model that was really built, not a later edit', async () => {
    // A fake worker that records what it was sent.
    const sent: any[] = [];
    const make = (): WorkerLike => {
      const w: WorkerLike = {
        onmessage: null, onerror: null, onmessageerror: null,
        postMessage(msg: any) {
          const m = structuredClone(msg);
          sent.push(m.req);
          // The first rebuild leaves a big heap, so the worker is replaced before the next request.
          const heap = sent.length === 1 ? 2e9 : 1e8;
          setTimeout(() => w.onmessage?.({ data: { id: m.id, ok: true, result: {}, heap } } as MessageEvent), 0);
        },
        terminate() {},
      };
      return w;
    };
    const kernel = new KernelClient({ createWorker: make, heapLimit: 1e9 });
    const st = new DocumentStore(emptyDocument('P', 'mm'));
    st.setParameter('T', '8');
    await kernel.call({ op: 'regen', doc: st.state });
    // The user edits; the edit's rebuild has not been asked for yet when the chat reads the model.
    st.setParameter('T', '10');
    await kernel.call({ op: 'quality' });
    const replay = sent.at(-2);
    expect(replay.op).toBe('regen');
    expect(replay.doc.params.find((p: any) => p.name === 'T').expr).toBe('8');
  });
});

describe('the deleted-hole explanation: autosave brings back the part as it was left', () => {
  it('a part closed with its wall hole deleted reopens without it, and its volume is exactly that part\'s', async () => {
    const m = new Map<string, string>();
    const local: LocalStore = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
    const slots: (SavedCopy | null)[] = [null, null, null];
    const db: AutosaveDb = {
      async read() { return slots.map((s) => (s ? { ...s } : null)); },
      async write(copy, rotate) { if (rotate) { slots[2] = slots[1]; slots[1] = slots[0]; } slots[0] = { ...copy }; },
    };
    const st = bracket();
    const saver = new Autosaver(local, db);
    saver.save(st.state);
    st.deleteFeature(featureId(st, 'Wall Hole'));
    saver.save(st.state); // every change is saved; then the window is closed
    await saver.flush();
    const reopened = await loadAutosave(local, db);
    expect(reopened.doc!.features.some((f) => f.name === 'Wall Hole')).toBe(false);
    const st2 = new DocumentStore(reopened.doc!);
    const a = app(st2);
    a.setMassPanel(true);
    await a.settle();
    expect(checkShown(st2, a)).toBe('ready');
    expect(rel((a.state() as any).mass.volume, bracketVolume(8, false))).toBeLessThan(EXACT);
    expect(bracketVolume(8, false) - bracketVolume(8)).toBeCloseTo(Math.PI * 11 ** 2 * 8, 9);
  });
});
