/**
 * Loft seams are deterministic (2026-11-06).
 *
 * Before: a smooth loft's seam (where its closed surface starts) came from a hash of its random
 * feature id, so the same steps built a differently-seamed part on every run: the same shape, but
 * different faces, edges and vertices, and seam-sensitive kernel steps passed or failed at random
 * (the code review traced its flaky tests to this). Now each new loft stores its seam, chosen from
 * how many lofts the part already has (src/core/loftSeam.ts).
 *
 * Checked here:
 * - the store gives successive lofts spread-out seams, the same for the same steps, and keeps a
 *   loft's seam through edits, deletes of other lofts, undo and redo;
 * - the Loft edit panel's patch keeps the seam (and the tips it does not show);
 * - documents saved before (no stored seam) rebuild exactly as they did, with the old id seam;
 * - repeat-run equality: the reference worked examples (Easter Island head, cartoon bear), built
 *   twice from the same steps with different random ids, give identical B-reps (same STEP data,
 *   bit for bit, same exact volume and box), and both export cleanly to STEP. This fails before
 *   the change (the two builds had different seams).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import type { CadDocument } from '../src/core/model';
import type { LoftFeature } from '../src/core/featureTypes';
import { loftSeamAt, nextLoftSeam, legacyLoftSeam, loftSeam } from '../src/core/loftSeam';
import { regenerate, releaseRegen, exactVolume, type OC } from '../src/kernel/regen';
import { exactBox } from '../src/kernel/bbox';
import { exportStepFile } from '../src/kernel/exporters';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { loftKept, patchFor } from '../src/ui/FeaturePMs';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';

let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

const ctxFor = (store: DocumentStore): ExecutorContext => ({ store, regen: async () => ({ mesh: null, status: [], sketches: [], mass: null, topology: null, ms: 0 }), selection: () => [], info: async () => { throw new Error('not used'); } });
const lofts = (d: Readonly<CadDocument>) => d.features.filter((f): f is LoftFeature => f.type === 'loft');

/** Three ovals on offset planes, lofted (one AI tool call). */
async function can(store: DocumentStore, name: string, x = 0) {
  await executeTool(ctxFor(store), 'loft_sections', { name, sections: [{ offset: 0, center: [x, 0], oval: { rx: 0.5, ry: 0.4 } }, { offset: 1, center: [x, 0], oval: { rx: 0.6, ry: 0.5 } }, { offset: 2, center: [x, 0], oval: { rx: 0.4, ry: 0.3 } }] });
}

/** The STEP file's data section (the header holds the time), and the exact volume and box. */
function fingerprint(shape: any) {
  const { text, report } = exportStepFile(oc, shape, { unit: 'mm', schema: 'AP214', name: 'Part' });
  return { data: text.slice(text.indexOf('DATA;')), volume: exactVolume(oc, shape, true), box: exactBox(oc, shape), report };
}

describe('loft seams are stored and deterministic', () => {
  it('successive lofts get spread-out seams from the golden-ratio sequence', () => {
    expect(loftSeamAt(0)).toBe(0);
    expect(loftSeamAt(1)).toBeCloseTo(0.6180339887, 9);
    expect(loftSeamAt(2)).toBeCloseTo(0.2360679775, 9);
    for (let k = 0; k < 50; k++) { expect(loftSeamAt(k)).toBeGreaterThanOrEqual(0); expect(loftSeamAt(k)).toBeLessThan(1); }
    // Any two of the first 8 are at least 1/13 of a turn apart.
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
      const d = Math.abs(loftSeamAt(a) - loftSeamAt(b));
      expect(Math.min(d, 1 - d)).toBeGreaterThan(1 / 13);
    }
    // A value an existing loft uses is skipped.
    expect(nextLoftSeam([{ type: 'loft', seam: loftSeamAt(1) }])).toBe(loftSeamAt(2));
    expect(nextLoftSeam([{ type: 'sketch' }, { type: 'loft', seam: 0.5 }])).toBe(loftSeamAt(1));
  });

  it('the same steps give the same seams; a seam stays through edits, deletes, undo and redo', async () => {
    const a = new DocumentStore(), b = new DocumentStore();
    for (const st of [a, b]) { await can(st, 'One'); await can(st, 'Two', 3); await can(st, 'Three', 6); }
    const seams = lofts(a.state).map((f) => f.seam);
    expect(seams).toEqual([loftSeamAt(0), loftSeamAt(1), loftSeamAt(2)]);
    expect(lofts(b.state).map((f) => f.seam)).toEqual(seams);
    // The ids are still random (they are names, not geometry).
    expect(lofts(a.state)[0].id).not.toBe(lofts(b.state)[0].id);
    const three = lofts(a.state)[2];
    a.updateFeature(three.id, { name: 'Third', operation: 'add' });
    expect(a.feature(three.id)).toMatchObject({ seam: loftSeamAt(2) });
    a.deleteFeature(lofts(a.state)[0].id);
    expect(a.feature(three.id)).toMatchObject({ seam: loftSeamAt(2) });
    // A new loft after a delete does not take a seam another loft has.
    await can(a, 'Four', 9);
    const now = lofts(a.state).map((f) => f.seam);
    expect(new Set(now).size).toBe(now.length);
    expect(now.at(-1)).toBe(loftSeamAt(3));
    a.undo(); a.undo(); a.redo();
    expect(a.feature(three.id)).toMatchObject({ seam: loftSeamAt(2) });
  });

  it('the Loft edit panel keeps the seam and the tips it does not show', async () => {
    // FeaturePMs.tsx sends updateFeature a patch where keys missing from the panel's feature are null.
    const st = new DocumentStore();
    await executeTool(ctxFor(st), 'tube', { name: 'Arm', path: [[0, 0, 0], [1, 0, 1], [2, 0, 1.5]], radii: [0.3, 0.25, 0.2], start_end: 'round', finish_end: 'round' });
    const before = lofts(st.state)[0];
    expect(before.seam).toBe(0);
    expect(before.startPoint && before.endPoint && before.startTip && before.endTip).toBeTruthy();
    // What the panel sends on OK after renaming it and ticking nothing else.
    const panel = { type: 'loft', name: 'Renamed', profiles: before.profiles, operation: before.operation, ...loftKept(before, st.state.features) };
    st.updateFeature(before.id, patchFor(before, panel));
    const after = st.feature(before.id) as LoftFeature;
    expect(after.name).toBe('Renamed');
    expect({ ...after, name: before.name }).toEqual(before);
    // A new loft's preview uses the seam the loft will be given.
    expect(loftKept(undefined, st.state.features).seam).toBe(loftSeamAt(1));
  });

  it('a document saved before seams were stored rebuilds exactly as before (the old id seam)', async () => {
    const st = new DocumentStore();
    await can(st, 'Old');
    const saved: CadDocument = JSON.parse(JSON.stringify(st.state));
    const f = lofts(saved)[0];
    delete f.seam; // as saved before 2026-11-06
    expect(loftSeam(f)).toBe(legacyLoftSeam(f.id));
    // The same numbers as the old hashFraction(id) in sweep.ts (values from the code before the change).
    expect(legacyLoftSeam('lo_eiu8h32k')).toBe(0.20312207657843828);
    expect(legacyLoftSeam('lo_s4xt8b14')).toBe(0.8800012471619993);
    expect(legacyLoftSeam('lo_a')).toBe(0.8023366313427687);
    const pinned: CadDocument = JSON.parse(JSON.stringify(saved));
    lofts(pinned)[0].seam = legacyLoftSeam(f.id);
    const r1 = regenerate(oc, saved, { solver }), r2 = regenerate(oc, pinned, { solver });
    try {
      expect(r1.status.every((s) => s.ok) && r2.status.every((s) => s.ok)).toBe(true);
      expect(fingerprint(r1.shape!).data).toBe(fingerprint(r2.shape!).data);
    } finally { releaseRegen(r1); releaseRegen(r2); }
    // A seam that is not a number is refused with a plain message.
    const bad: any = JSON.parse(JSON.stringify(saved)); (lofts(bad)[0] as any).seam = 'left';
    const r3 = regenerate(oc, bad, { solver });
    try { expect(r3.status.find((s) => !s.ok)?.message ?? '').toMatch(/seam position must be a number/); } finally { releaseRegen(r3); }
  });
});

describe('repeat-run equality: the same steps build the same part', () => {
  for (const subject of ['easter island head', 'cartoon bear'])
  it(`${subject}: two builds give identical geometry and a clean STEP file`, async () => {
    const builds: ReturnType<typeof fingerprint>[] = [];
    const ids: string[] = [];
    for (let run = 0; run < 2; run++) {
      const store = new DocumentStore();
      const c = ctxFor(store);
      const ref: any = await executeTool(c, 'get_reference', { subject });
      const res: any = await executeTool(c, 'build_model', { steps: ref.example.steps });
      expect(res.ok, JSON.stringify(res.errors ?? res.message)).toBe(true);
      ids.push(lofts(store.state)[0].id);
      const r = regenerate(oc, store.state, { solver });
      try {
        expect(r.status.every((s) => s.ok), JSON.stringify(r.status.filter((s) => !s.ok))).toBe(true);
        builds.push(fingerprint(r.shape!));
      } finally { releaseRegen(r); }
    }
    expect(ids[0]).not.toBe(ids[1]); // different random ids...
    const [a, b] = builds;
    expect(b.data === a.data, 'the two builds wrote different STEP data').toBe(true); // ...the same B-rep, bit for bit
    expect(b.volume).toBe(a.volume);
    expect(b.box).toEqual(a.box);
    // The default seams export cleanly (read back with the same counts, valid, closed).
    expect(a.report.problems).toEqual([]);
    expect(a.report.ok).toBe(true);
    expect(a.report.readBack).toMatchObject({ solids: 1, valid: true, openEdges: 0, faces: a.report.faces, edges: a.report.edges, vertices: a.report.vertices });
  }, 600000);
});
