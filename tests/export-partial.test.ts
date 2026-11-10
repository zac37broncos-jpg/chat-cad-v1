/**
 * Exports write exactly the document open now, and say which features are missing.
 *
 * The worker's export requests (src/kernel/regenOp.ts modelForExport) rebuild the document they
 * are given through the history cache instead of exporting whatever the worker built last: after
 * a worker restart that was the last *successful* rebuild, an older document. They also name every
 * feature that failed to rebuild, because the file would silently be missing it (a hole that is
 * not drilled, a boss that is not printed). The export panels hold such a file back until the
 * user explicitly saves without those features (e2e/export-partial.spec.ts checks the panel).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, type CadDocument } from '../src/core/model';
import { type OC } from '../src/kernel/regen';
import { massProperties } from '../src/kernel/query';
import { regenOp, newModelState, modelForExport, failedFeatures } from '../src/kernel/regenOp';
import { exportStlFile, exportStepFile, readStep } from '../src/kernel/exporters';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';

const IN3 = 25.4 ** 3;
let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

/** 4 x 2 x 0.5 in plate; with `hole`, a 0.5 in diameter through hole at its center. */
function plate(hole: boolean): DocumentStore {
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Plate Sketch' }), 0.5, { name: 'Plate' });
  if (hole) {
    const hs = st.addSketch('XY', [{ id: 'c1', kind: 'circle', center: { x: 2, y: 1 }, radius: 0.25 }], { name: 'Hole Sketch' });
    st.addExtrude(hs, 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Center Hole' });
  }
  return st;
}
const PLATE = 4 * 2 * 0.5;
const WITH_HOLE = PLATE - Math.PI * 0.25 ** 2 * 0.5;
const volIn3 = (shape: Parameters<typeof massProperties>[1]) => massProperties(oc, shape).volume / IN3;

describe('exports write the document open now', () => {
  it('exports the document it is given, not the one the worker rebuilt last', () => {
    const model = newModelState();
    const a = plate(false).state as CadDocument;
    regenOp(oc, model, { op: 'regen', doc: a, mesh: false }, solver);
    expect(volIn3(model.current!)).toBeCloseTo(PLATE, 9);

    const b = plate(true).state as CadDocument;
    const m = modelForExport(oc, model, b, solver);
    expect(m.failed).toEqual([]);
    expect(Math.abs(volIn3(m.shape) - WITH_HOLE) / WITH_HOLE).toBeLessThan(1e-9);
    // Later reads (info, distance, quality) see the exported model too.
    expect(model.current).toBe(m.shape);
    // And the STEP file holds that model.
    const { text, report } = exportStepFile(oc, m.shape, { unit: 'in', schema: 'AP214', name: 'Plate', fileName: 'Plate.step' });
    expect(report.ok).toBe(true);
    const back = readStep(oc, text);
    expect(Math.abs(volIn3(back) - WITH_HOLE) / WITH_HOLE).toBeLessThan(1e-9);
    back.delete();
  });

  it('works on a fresh worker (after a restart) without any earlier rebuild', () => {
    const model = newModelState();
    const m = modelForExport(oc, model, plate(true).state as CadDocument, solver);
    expect(Math.abs(volIn3(m.shape) - WITH_HOLE) / WITH_HOLE).toBeLessThan(1e-9);
  });

  it('an unchanged document comes from the history cache: the very same solid as the viewport rebuild', () => {
    const model = newModelState();
    const doc = plate(true).state as CadDocument;
    regenOp(oc, model, { op: 'regen', doc, mesh: false }, solver);
    const shown = model.current;
    expect(modelForExport(oc, model, doc, solver).shape).toBe(shown);
  });
});

describe('exports name the features that failed to rebuild', () => {
  it('a feature that failed is named with its reason; the solid without it is what would be written', () => {
    const st = plate(true);
    // An open line cannot be extruded: this boss fails to rebuild.
    const open = st.addSketch('XY', [{ id: 'l1', kind: 'line', p1: { x: 0.5, y: 0.5 }, p2: { x: 1.5, y: 0.5 } }], { name: 'Boss Sketch' });
    st.addExtrude(open, 0.25, { operation: 'add', name: 'Boss' });
    const doc = st.state as CadDocument;
    const m = modelForExport(oc, newModelState(), doc, solver);
    expect(m.failed.map((f) => f.name)).toEqual(['Boss']);
    expect(m.failed[0].message).toMatch(/closed profile/);
    expect(m.failed[0].id).toBe(doc.features.at(-1)!.id);
    // The solid that would be written is the part without the boss: exactly what the panel warns about.
    expect(Math.abs(volIn3(m.shape) - WITH_HOLE) / WITH_HOLE).toBeLessThan(1e-9);
    const { report } = exportStlFile(oc, m.shape, { linearDeflection: 0.01, angularDeflection: 0.1, unit: 'mm', format: 'binary', name: 'P' });
    // The mesh itself is fine, which is why the file check alone could never catch the missing feature.
    expect(report.watertight).toBe(true);
  });

  it('suppressed features are not failures (the user turned them off on purpose)', () => {
    const st = plate(true);
    st.setSuppressed(st.state.features.at(-1)!.id, true);
    const m = modelForExport(oc, newModelState(), st.state as CadDocument, solver);
    expect(m.failed).toEqual([]);
    expect(volIn3(m.shape)).toBeCloseTo(PLATE, 9);
  });

  it('with no solid at all, the export fails and says why', () => {
    const st = new DocumentStore();
    const open = st.addSketch('XY', [{ id: 'l1', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }], { name: 'Open Sketch' });
    st.addExtrude(open, 0.25, { name: 'Base' });
    expect(() => modelForExport(oc, newModelState(), st.state as CadDocument, solver)).toThrow(/no solid to export \(Base: .*closed profile/);
  });

  it('failedFeatures names by the tree name and keeps the kernel message', () => {
    const doc = plate(false).state as CadDocument;
    const id = doc.features[1].id;
    expect(failedFeatures(doc, [{ id: doc.features[0].id, ok: true }, { id, ok: false, message: 'Boom' }])).toEqual([{ id, name: 'Plate', message: 'Boom' }]);
    expect(failedFeatures(doc, [{ id, ok: false }])[0].message).toBe('It did not rebuild.');
  });
});
