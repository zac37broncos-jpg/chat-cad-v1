/**
 * Precision checks found in the full code review (2026-11-05).
 *
 * 1. Exact bounding box (src/kernel/bbox.ts). OpenCascade's "optimal" box missed the tip of an
 *    organic arm by 0.131 mm (0.0052 in, past the 0.005 in promise) whenever the arm loft's seam,
 *    which comes from the feature's random id, put the tip's extreme near the end of the surface's
 *    parameter range: Mass Properties, the chat's part size and the export checks then reported
 *    the part too short, and the export tests failed at random. Checked here against a fine mesh
 *    whose every corner lies exactly on the surface, for many seams, and against hand-calculated
 *    boxes.
 * 2. The second volume witness of checked booleans (regen.ts wholeBodyAgrees): it accepts a correct
 *    result the first witness mis-measured, but never a wrong one, and only when it is decisive.
 *    (The model that failed at random is in tests/organic.test.ts, "a correct join at a dome's pole".)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, type CadDocument } from '../src/core/model';
import { regenerate, releaseRegen, wholeBodyAgrees, type OC } from '../src/kernel/regen';
import { massProperties } from '../src/kernel/query';
import { exactBox } from '../src/kernel/bbox';
import { exportStlFile } from '../src/kernel/exporters';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { free } from '../src/kernel/mem';
import { withRecordedSeams } from './helpers/seams';

const IN = 25.4;
let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

/** OpenCascade's own optimal box (what CHAD used before), for comparison. */
function optimalBox(s: TopoDS_Shape) {
  const b = new oc.Bnd_Box();
  oc.BRepBndLib.AddOptimal(s, b, false, false);
  const hi = b.CornerMax(), lo = b.CornerMin();
  const out = { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] };
  free(hi, lo, b);
  return out;
}

/**
 * Independent check: a fine STL mesh (0.005 mm) has every corner exactly on the surface, so it lies
 * inside the true box and reaches each side to within its chord tolerance.
 */
function expectAgreesWithMesh(s: TopoDS_Shape, box: ReturnType<typeof exactBox>) {
  const lin = 0.005;
  const { report } = exportStlFile(oc, s, { linearDeflection: lin, angularDeflection: 0.05, unit: 'mm', format: 'binary', name: 'check' });
  for (let k = 0; k < 3; k++) {
    // float32 rounding of the file's coordinates: below 1e-5 mm at these sizes.
    expect(report.bboxMax[k]).toBeLessThanOrEqual(box.max[k] + 1e-5);
    expect(report.bboxMin[k]).toBeGreaterThanOrEqual(box.min[k] - 1e-5);
    expect(box.max[k] - report.bboxMax[k]).toBeLessThanOrEqual(lin + 1e-5);
    expect(report.bboxMin[k] - box.min[k]).toBeLessThanOrEqual(lin + 1e-5);
  }
}

/** The figure with an arm from tests/export.test.ts, with the arm loft's id (its seam) chosen. */
async function figureWithArm(armId: string): Promise<{ doc: CadDocument }> {
  const store = new DocumentStore();
  const ctx: ExecutorContext = {
    store,
    regen: async () => { const r = regenerate(oc, store.state, { solver }); try { return { mesh: null, status: r.status, sketches: r.sketches, mass: null, topology: null, ms: 0 }; } finally { releaseRegen(r); } },
    selection: () => [],
    info: async () => { throw new Error('not used'); },
  };
  await executeTool(ctx, 'profile_body', { name: 'Body', end: 'round', stations: [{ at: 0, x: 1, y: [-0.8, 0.8] }, { at: 1.5, x: 1.2, y: [-1, 0.9] }, { at: 3, x: 0.9, y: [-0.7, 0.7] }] });
  await executeTool(ctx, 'tube', { name: 'Arm', path: [[0.8, 0, 2], [1.5, -0.3, 1.4], [1.7, -0.5, 0.8]], radii: [0.3, 0.22, 0.18], start_end: 'flat', finish_end: 'round' });
  return { doc: withRecordedSeams(store.state, { Arm: armId }) };
}

describe('exact bounding box', () => {
  it('the organic arm: the same box for every seam, matching a fine mesh, where the old box came out 0.13 mm short', async () => {
    // lo_eiu8h32k and lo_3ni57k3u are seams for which OpenCascade's box missed the arm tip.
    const ids = ['lo_eiu8h32k', 'lo_3ni57k3u', 'lo_fd0uiu1a', 'lo_a'];
    const boxes: ReturnType<typeof exactBox>[] = [];
    let oldShort = 0;
    for (const id of ids) {
      const { doc } = await figureWithArm(id);
      const r = regenerate(oc, doc, { solver });
      try {
        expect(r.status.every((s) => s.ok), JSON.stringify(r.status.filter((s) => !s.ok))).toBe(true);
        const box = exactBox(oc, r.shape!);
        expectAgreesWithMesh(r.shape!, box);
        // Mass Properties (and so the chat's part size and the panel) report this box.
        const m = massProperties(oc, r.shape!);
        expect(m.bboxMax).toEqual(box.max);
        expect(m.bboxMin).toEqual(box.min);
        const old = optimalBox(r.shape!);
        if (box.max[0] - old.max[0] > 0.1) oldShort++;
        boxes.push(box);
      } finally { releaseRegen(r); }
    }
    // The surface is the same wherever its seam is, so is the box.
    for (const b of boxes) for (let k = 0; k < 3; k++) {
      expect(Math.abs(b.max[k] - boxes[0].max[k])).toBeLessThan(1e-6);
      expect(Math.abs(b.min[k] - boxes[0].min[k])).toBeLessThan(1e-6);
    }
    // This test really covers the miss (if a kernel update fixes it, pick a new case, keep the test).
    expect(oldShort, 'OpenCascade\'s optimal box no longer misses the arm tip for these seams').toBeGreaterThanOrEqual(1);
  }, 600000);

  it('hand-calculated boxes stay exact: plate with holes, a revolved ring, a smooth lofted cylinder', () => {
    // 4 x 2 x 0.5 in plate with a hole.
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2)), 0.5, { name: 'Plate' });
    st.addExtrude(st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 2, y: 1 }, radius: 0.25 }]), 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Hole' });
    // A torus: tube radius 0.25 at 1 in around world Y.
    const ring = new DocumentStore();
    ring.addRevolve(ring.addSketch('XY', [
      { id: 'ax', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 }, construction: true },
      { id: 'c', kind: 'circle', center: { x: 1, y: 0 }, radius: 0.25 },
    ]), 'ax', 360, { name: 'Ring' });
    const cases: [DocumentStore, number[], number[]][] = [
      [st, [0, 0, 0], [4, 2, 0.5]],
      [ring, [-1.25, -0.25, -1.25], [1.25, 0.25, 1.25]],
    ];
    for (const [s, lo, hi] of cases) {
      const r = regenerate(oc, s.state, { solver });
      try {
        const b = exactBox(oc, r.shape!);
        // OpenCascade pads its box by its confusion tolerance (1e-7 mm).
        for (let k = 0; k < 3; k++) { expect(Math.abs(b.min[k] - lo[k] * IN)).toBeLessThan(2e-7); expect(Math.abs(b.max[k] - hi[k] * IN)).toBeLessThan(2e-7); }
      } finally { releaseRegen(r); }
    }
  });

  it('a smooth loft of circles (a rational B-spline cylinder): radius exactly, for every seam', async () => {
    for (const id of ['lo_s0', 'lo_s1', 'lo_s2', 'lo_s3', 'lo_s4', 'lo_s5']) {
      const store = new DocumentStore();
      const ctx: ExecutorContext = { store, regen: async () => ({ mesh: null, status: [], sketches: [], mass: null, topology: null, ms: 0 }), selection: () => [], info: async () => { throw new Error('not used'); } };
      await executeTool(ctx, 'loft_sections', { name: 'Can', sections: [{ offset: 0, oval: { rx: 0.5, ry: 0.5 } }, { offset: 1, oval: { rx: 0.5, ry: 0.5 } }, { offset: 2, oval: { rx: 0.5, ry: 0.5 } }] });
      const r = regenerate(oc, withRecordedSeams(store.state, { Can: id }), { solver });
      try {
        expect(r.status.every((s) => s.ok)).toBe(true);
        const b = exactBox(oc, r.shape!);
        for (let k = 0; k < 2; k++) { expect(Math.abs(b.max[k] - 0.5 * IN)).toBeLessThan(1e-6); expect(Math.abs(b.min[k] + 0.5 * IN)).toBeLessThan(1e-6); }
        expect(Math.abs(b.min[2])).toBeLessThan(1e-6);
        expect(Math.abs(b.max[2] - 2 * IN)).toBeLessThan(1e-6);
      } finally { releaseRegen(r); }
    }
  }, 120000);
});

describe('checked booleans: the whole-body volume witness', () => {
  const box = (x: number, y: number, z: number, dx: number, dy: number, dz: number) => {
    const p1 = new oc.gp_Pnt(x, y, z), p2 = new oc.gp_Pnt(x + dx, y + dy, z + dz);
    const mk = new oc.BRepPrimAPI_MakeBox(p1, p2);
    const s = mk.Shape();
    free(mk, p1, p2);
    return s;
  };
  const fuse = (a: TopoDS_Shape, b: TopoDS_Shape) => {
    const pr = new oc.Message_ProgressRange();
    const op = new oc.BRepAlgoAPI_Fuse(a, b, pr);
    const s = op.Shape();
    free(op, pr);
    return s;
  };

  it('accepts a correct union, rejects one that dropped the tool or kept only part of it', () => {
    const body = box(0, 0, 0, 100, 60, 8);         // 48,000 mm^3
    const tool = box(90, 10, 4, 20, 20, 10);       // 4,000 mm^3, 400 inside the body
    const vt = 4000, expected = vt - 10 * 20 * 4;  // adds 3,600 mm^3
    const right = fuse(body, tool);
    const half = fuse(body, box(90, 10, 4, 15, 20, 10));
    try {
      expect(wholeBodyAgrees(oc, body, right, vt, expected)).toBe(true);
      expect(wholeBodyAgrees(oc, body, body, vt, expected)).toBe(false);   // tool silently dropped
      expect(wholeBodyAgrees(oc, body, half, vt, expected)).toBe(false);   // only 2,600 of 3,600 added
    } finally { free(body, tool, right, half); }
  });

  it('does not decide when it cannot tell a failure from noise (tiny tool on a big body)', () => {
    const body = box(0, 0, 0, 1000, 1000, 100);    // 1e8 mm^3: its tolerance alone is 400 mm^3
    const tool = box(500, 500, 99, 2, 2, 2);       // 8 mm^3
    const right = fuse(body, tool);
    try {
      expect(wholeBodyAgrees(oc, body, right, 8, 4)).toBe(false);
    } finally { free(body, tool, right); }
  });
});
