/**
 * The undo history is capped (2026-11-06; the code review found it unbounded: every step keeps a
 * whole copy of the part). These tests check that the cap only ever removes the ability to go
 * further back, never the correctness of what is kept:
 * - every kept undo step restores exactly the document it was taken from, and redo returns exactly;
 * - an AI request or a sketch edit that makes more steps than the limit still undoes as one step,
 *   and a sketch Cancel still restores the sketch exactly (their steps are held, not trimmed);
 * - checkpoints stay right after old steps are dropped;
 * - a part too large for the size budget still keeps the newest steps.
 */
import { describe, it, expect } from 'vitest';
import { DocumentStore, HISTORY_LIMITS } from '../src/core/store';
import { rectangleEntities, type CadDocument } from '../src/core/model';

const json = (d: Readonly<CadDocument>) => JSON.stringify(d);

/** A store with one sketch whose width parameter is edited `n` times; returns the document after every edit. */
function edits(st: DocumentStore, n: number, from = 0): string[] {
  const docs: string[] = [];
  for (let i = 1; i <= n; i++) { st.setParameter('W', `${from + i} in`); docs.push(json(st.state)); }
  return docs;
}

describe('undo history limit', () => {
  it('the defaults are a sensible size', () => {
    expect(HISTORY_LIMITS.maxSteps).toBe(200);
    expect(HISTORY_LIMITS.minSteps).toBeGreaterThanOrEqual(10);
    expect(HISTORY_LIMITS.maxChars).toBeGreaterThanOrEqual(16_000_000);
  });

  it('keeps at most maxSteps; every kept step undoes and redoes exactly', () => {
    const st = new DocumentStore(undefined, { maxSteps: 10, minSteps: 3 });
    st.addSketch('XY', rectangleEntities(0, 0, 'W', 1), { name: 'Base' });
    const start = json(st.state);
    const after = edits(st, 25);
    expect(st.undoDepth).toBe(10);
    // Undo walks back through exactly the last 10 states, then stops.
    const states = [start, ...after];
    for (let k = 1; k <= 10; k++) {
      st.undo();
      expect(json(st.state)).toBe(states[states.length - 1 - k]);
    }
    expect(st.canUndo).toBe(false);
    const oldest = json(st.state);
    st.undo(); // nothing left: no change
    expect(json(st.state)).toBe(oldest);
    // Redo all the way returns exactly to the newest state, one state at a time.
    for (let k = 9; k >= 0; k--) {
      st.redo();
      expect(json(st.state)).toBe(states[states.length - 1 - k]);
    }
    expect(st.canRedo).toBe(false);
    expect(json(st.state)).toBe(after.at(-1));
  });

  it('drops the oldest steps by size, but always keeps the newest minSteps', () => {
    const st = new DocumentStore(undefined, { maxSteps: 1000, maxChars: 1, minSteps: 4 });
    st.addSketch('XY', rectangleEntities(0, 0, 'W', 1));
    const after = edits(st, 12);
    expect(st.undoDepth).toBe(4);
    for (let k = 1; k <= 4; k++) { st.undo(); expect(json(st.state)).toBe(after[after.length - 1 - k]); }
    expect(st.canUndo).toBe(false);
    // A budget the steps fit in keeps them all.
    const roomy = new DocumentStore(undefined, { maxSteps: 1000, maxChars: 10_000_000, minSteps: 4 });
    roomy.addSketch('XY', rectangleEntities(0, 0, 'W', 1));
    edits(roomy, 12);
    expect(roomy.undoDepth).toBe(13);
  });

  it('random edits, undos, redos and AI requests: always the same document as an unlimited history', () => {
    // A seeded run checked step by step against a store with no limit: the capped history may
    // refuse an undo the unlimited one could still do, but never gives a different document.
    let seed = 20261106;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const base = new DocumentStore();
    base.addSketch('XY', rectangleEntities(0, 0, 'W', 1), { name: 'Base' });
    const capped = new DocumentStore(base.state as CadDocument, { maxSteps: 7, maxChars: 4000, minSteps: 2 });
    const full = new DocumentStore(base.state as CadDocument, { maxSteps: Infinity, maxChars: Infinity, minSteps: 0 });
    const both = (fn: (s: DocumentStore) => void) => { fn(capped); fn(full); };
    let open: [number, number] | null = null;
    let refused = 0;
    for (let i = 0; i < 1500; i++) {
      const r = rnd();
      if (r < 0.45) {
        const v = `${(rnd() * 10).toFixed(3)} in`;
        const depth = capped.undoDepth, was = capped.state;
        // Some edits make the part bigger, so the size budget matters too.
        if (rnd() < 0.2) both((s) => s.addSketchEntities(s.state.features[0].id, [{ id: `c${i}`, kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.1 }]));
        else both((s) => s.setParameter('W', v));
        // A change never trims below the newest minSteps steps.
        if (capped.state !== was) expect(capped.undoDepth).toBeGreaterThanOrEqual(Math.min(2, depth + 1));
      } else if (r < 0.7) {
        if (capped.canUndo) both((s) => s.undo()); else if (full.canUndo) refused++;
      } else if (r < 0.9) {
        expect(capped.canRedo).toBe(full.canRedo);
        if (capped.canRedo) both((s) => s.redo());
      } else if (!open) open = [capped.openCheckpoint(), full.openCheckpoint()];
      else { capped.squashSince(open[0], `Claude ${i}`); full.squashSince(open[1], `Claude ${i}`); open = null; }
      expect(json(capped.state)).toBe(json(full.state));
      expect(capped.undoLabel === full.undoLabel || !capped.canUndo).toBe(true);
      if (!open) expect(capped.undoDepth).toBeLessThanOrEqual(7);
    }
    // The run really hit the limit.
    expect(refused).toBeGreaterThan(0);
  });

  it('a new edit after undo clears redo, as before', () => {
    const st = new DocumentStore(undefined, { maxSteps: 5, minSteps: 1 });
    st.addSketch('XY', rectangleEntities(0, 0, 'W', 1));
    edits(st, 8);
    st.undo(); st.undo();
    expect(st.canRedo).toBe(true);
    st.setParameter('W', '99 in');
    expect(st.canRedo).toBe(false);
    expect(st.undoDepth).toBeLessThanOrEqual(5);
  });

  it('an AI request with more steps than the limit still undoes as one step to exactly the state before it', () => {
    const st = new DocumentStore(undefined, { maxSteps: 10, minSteps: 3 });
    st.addSketch('XY', rectangleEntities(0, 0, 'W', 1), { name: 'Base' });
    edits(st, 15); // the history is already full
    const before = json(st.state);
    const cp = st.openCheckpoint();
    const during = edits(st, 40, 100); // 40 tool calls: four times the limit
    expect(st.undoDepth).toBeGreaterThanOrEqual(40); // held, not trimmed
    st.squashSince(cp, 'Claude: build it');
    expect(st.undoLabel).toBe('Claude: build it');
    expect(json(st.state)).toBe(during.at(-1));
    expect(st.undoDepth).toBeLessThanOrEqual(10); // trimmed again once merged
    st.undo();
    expect(json(st.state)).toBe(before);
    st.redo();
    expect(json(st.state)).toBe(during.at(-1));
  });

  it('a checkpoint taken before old steps were dropped still squashes the right steps', () => {
    const st = new DocumentStore(undefined, { maxSteps: 6, minSteps: 2 });
    st.addSketch('XY', rectangleEntities(0, 0, 'W', 1));
    edits(st, 3);
    const before = json(st.state);
    const cp = st.openCheckpoint();
    edits(st, 3, 10);
    st.squashSince(cp, 'Claude: three');
    // Later edits push the old steps (from before the checkpoint) out of the history.
    const later = edits(st, 10, 20);
    expect(st.undoDepth).toBe(6);
    for (let k = 1; k <= 5; k++) { st.undo(); expect(json(st.state)).toBe(later[later.length - 1 - k]); }
    // The sixth (last) undo reaches the state after the 4th later edit; older steps, the merged request among them, were dropped.
    st.undo();
    expect(json(st.state)).toBe(later[3]);
    // A request checkpoint is an absolute position: the merged step is found where it was.
    const st2 = new DocumentStore(undefined, { maxSteps: 4, minSteps: 1 });
    st2.addSketch('XY', rectangleEntities(0, 0, 'W', 1));
    edits(st2, 10);
    const b2 = json(st2.state);
    const cp2 = st2.openCheckpoint();
    edits(st2, 2, 50);
    st2.squashSince(cp2, 'Claude: two');
    st2.undo();
    expect(json(st2.state)).toBe(b2);
    expect(before).not.toBe(json(st.state));
  });

  it('sketch Cancel after more edits than the limit restores the sketch exactly', () => {
    // The sketcher's Cancel: undo while the position is past the checkpoint (SketchUI.tsx).
    const st = new DocumentStore(undefined, { maxSteps: 5, minSteps: 1 });
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 2, 1), { name: 'Profile' });
    edits(st, 8);
    const before = json(st.state);
    const cp = st.openCheckpoint();
    for (let i = 0; i < 30; i++) st.addSketchEntities(sk, [{ id: `c${i}`, kind: 'circle', center: { x: i * 0.01, y: 0.5 }, radius: 0.1 }]);
    while (st.checkpoint() > cp && st.canUndo) st.undo();
    st.releaseCheckpoint(cp);
    expect(json(st.state)).toBe(before);
    // Once released, the history is trimmed again on the next change.
    st.setParameter('W', '7 in');
    expect(st.undoDepth).toBeLessThanOrEqual(5);
  });

  it('a released checkpoint no longer holds steps; squashing a plain checkpoint whose start was dropped merges what is left', () => {
    const st = new DocumentStore(undefined, { maxSteps: 4, minSteps: 1 });
    st.addSketch('XY', rectangleEntities(0, 0, 'W', 1));
    const cp = st.openCheckpoint();
    edits(st, 9);
    expect(st.undoDepth).toBe(9); // only the step before the checkpoint could go
    st.releaseCheckpoint(cp);
    expect(st.undoDepth).toBe(4);
    // A plain (not held) checkpoint whose first steps were dropped: what is left merges into one step.
    const plain = st.checkpoint();
    const after = edits(st, 6, 40);
    st.squashSince(plain, 'merged');
    expect(st.undoLabel).toBe('merged');
    expect(json(st.state)).toBe(after.at(-1));
    st.undo();
    expect(st.canUndo).toBe(false);
  });

  it('opening a file starts a new history; an old checkpoint never reaches into it', () => {
    const st = new DocumentStore(undefined, { maxSteps: 10, minSteps: 1 });
    st.addSketch('XY', rectangleEntities(0, 0, 'W', 1));
    edits(st, 3);
    const cp = st.openCheckpoint();
    edits(st, 2, 10);
    const other = new DocumentStore();
    other.addSketch('XZ', rectangleEntities(0, 0, 3, 3), { name: 'Other' });
    st.load(other.state as CadDocument);
    const loaded = json(st.state);
    expect(st.canUndo).toBe(false);
    const after = edits(st, 2, 20);
    st.squashSince(cp, 'Claude: across a file open');
    st.undo();
    expect(json(st.state)).toBe(loaded); // never a document from before the file was opened
    st.redo();
    expect(json(st.state)).toBe(after.at(-1));
  });

  it('the default limits keep 200 steps of a small part', () => {
    const st = new DocumentStore();
    st.addSketch('XY', rectangleEntities(0, 0, 'W', 1));
    edits(st, 260);
    expect(st.undoDepth).toBe(200);
  });
});
