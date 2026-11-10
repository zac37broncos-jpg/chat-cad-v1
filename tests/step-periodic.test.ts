/**
 * STEP export of organic parts: faces on closed (periodic) B-spline surfaces.
 *
 * Found in the full code review (2026-11-05) through a random CI failure of the Easter Island head
 * ("The STEP export does not read back as the same solid"). A smooth loft's skin is a periodic
 * B-spline; after the booleans a face on it can run across the place where the surface's
 * parameters start over. OpenCascade allows that, but STEP has no periodic B-splines, so in the
 * file that face's trimming ran past the end of its surface: OpenCascade's own reader then measured
 * the head up to 0.7% too small, and CAM systems may reject or mis-trim such a face. Whether it happened depended on the loft seams, which come from the features' random
 * ids. The exporter now splits such faces where the parameters start over (stepReady).
 *
 * The same seams also exposed a wrong read-back count: the splitter kept the leftover pieces of
 * its splitting lines as loose edges, which the file (rightly) does not hold, so the export panel
 * reported "Read back ... edges" and refused to save the head.
 *
 * Found right after: the cartoon bear example could not be exported to STEP at all (every seam).
 * Its eye loft is a smooth loft of circles, a closed but not periodic (rational) surface; a face
 * on it running from pole to pole with holes was not split like the periodic ones, so the file's
 * reader rebuilt the wrong region (a different face count, sometimes an invalid solid). The
 * panel refused to save, so nothing wrong was written, but the bear could not be exported.
 * Splitting it then showed one more detail: where a splitting line only touches a face, the
 * splitter leaves a loose point inside the face, which the file does not hold either (2 vertices
 * short on read-back for 3 of 24 seams); such faces are rebuilt from their boundaries.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { regenerate, releaseRegen, exactVolume, type OC } from '../src/kernel/regen';
import { listSubShapes } from '../src/kernel/query';
import { partQuality } from '../src/kernel/quality';
import { exportStepFile, readStep, facesOutsideRange, periodicCrossings } from '../src/kernel/exporters';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { free } from '../src/kernel/mem';
import { withRecordedSeams } from './helpers/seams';

let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

/** Loft and mirror ids (their seams) of builds that failed. */
const HEAD_SEAMS: Record<string, string> = {
  Chest: 'lo_vltf0l60', Head: 'lo_wdkewnn9', Nose: 'lo_p8zbfu2n', 'Left Eye Socket': 'lo_ay22jy9x', 'Right Eye Socket': 'mi_7yasok3q',
  'Left Nostril': 'lo_tbwdn59t', 'Right Nostril': 'mi_cnefl7c7', Mouth: 'lo_pwyj61ue', 'Mouth Line': 'lo_bu5ty7k0',
  'Left Ear': 'lo_0yz27x0n', 'Left Ear Groove': 'lo_g2mhsi68', 'Right Ear': 'mi_fhzivvie',
};
/** A head build where, after the split, a face lies wholly one period past its surface's range (exports fine). */
const HEAD_SEAMS_SHIFTED: Record<string, string> = {
  Chest: 'lo_iji1tlej', Head: 'lo_fqzrabnw', Nose: 'lo_p0io8mz4', 'Left Eye Socket': 'lo_061lu6lb', 'Right Eye Socket': 'mi_6oj8qhe9',
  'Left Nostril': 'lo_ulthb29m', 'Right Nostril': 'mi_qc8e14hb', Mouth: 'lo_725jbt5e', 'Mouth Line': 'lo_u5o6uu40',
  'Left Ear': 'lo_oev0vb68', 'Left Ear Groove': 'lo_7cfsrtv1', 'Right Ear': 'mi_e6qmo37t',
};
const BEAR_SEAMS: Record<string, string> = {
  Body: 'lo_qsvdcskq', Head: 'lo_uzi64j90', Muzzle: 'lo_x4q0hgve', Nose: 'lo_molqruxx', 'Mouth Line': 'lo_67soxfew', 'Mouth Center Line': 'lo_metitdmm',
  'Left Eye': 'lo_5hu2lmec', 'Right Eye': 'mi_ujth0sta', 'Left Ear': 'lo_g5hnldy4', 'Left Inner Ear': 'lo_y5o55bes', 'Right Ear': 'mi_92419ghg',
  'Left Arm': 'lo_a3s54c5v', 'Right Arm': 'mi_njfuv2lp', 'Left Leg': 'lo_70hwjhlm', 'Left Foot Pad': 'lo_o878o0yu', 'Right Leg': 'mi_ms3omv95',
};

/** A bear build whose split left a loose point inside a face (the read-back was 2 vertices short). */
const BEAR_SEAMS_LOOSE_POINT: Record<string, string> = {
  Body: 'lo_lzenktl6', Head: 'lo_x0l5iu0g', Muzzle: 'lo_o3fyf47i', Nose: 'lo_8op8ioml', 'Mouth Line': 'lo_txzceeha', 'Mouth Center Line': 'lo_mx1fcpnf',
  'Left Eye': 'lo_cou4yont', 'Right Eye': 'mi_i1kh0i0k', 'Left Ear': 'lo_j0oy0jmr', 'Left Inner Ear': 'lo_0e7nb96g', 'Right Ear': 'mi_lobhd24x',
  'Left Arm': 'lo_mstrgb4x', 'Right Arm': 'mi_5b48oron', 'Left Leg': 'lo_hsn9nee1', 'Left Foot Pad': 'lo_hocthjni', 'Right Leg': 'mi_1741xmm8',
};

/** A worked example from the reference library, built with the given seams. */
async function example(subject: string, seams: Record<string, string>) {
  const store = new DocumentStore();
  const ctx: ExecutorContext = { store, regen: async () => ({ mesh: null, status: [], sketches: [], mass: null, topology: null, ms: 0 }), selection: () => [], info: async () => { throw new Error('not used'); } };
  const ref: any = await executeTool(ctx, 'get_reference', { subject });
  await executeTool(ctx, 'build_model', { steps: ref.example.steps });
  return regenerate(oc, withRecordedSeams(store.state, seams), { solver });
}

/** The export check passes, and the file reads back with the same exact volume. */
function expectCleanStep(shape: any, name: string) {
  const { text, report } = exportStepFile(oc, shape, { unit: 'mm', schema: 'AP214', name });
  expect(report.problems).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.readBack).toMatchObject({ solids: 1, valid: true, openEdges: 0, faces: report.faces, edges: report.edges, vertices: report.vertices });
  const back = readStep(oc, text);
  try {
    // The exact volume agrees to a millionth (before the fix: up to 0.7% off). Surface area is
    // not compared here: OpenCascade's area integration is itself unsteady (4e-5) on the model's
    // own faces whose parameters run past the surface's start (see the review report).
    const va = exactVolume(oc, shape, true), vb = exactVolume(oc, back, true);
    expect(Math.abs(vb - va) / va).toBeLessThan(1e-6);
  } finally { back.delete(); }
}

/** Faces running from pole to pole on a surface closed around but not periodic. */
function closedPoleFaces(s: any): number {
  let n = 0;
  for (const f of listSubShapes(oc, s, 'TopAbs_FACE')) {
    const face = oc.TopoDS.Face(f);
    const ad = new oc.BRepAdaptor_Surface(face, false);
    const edges = listSubShapes(oc, f, 'TopAbs_EDGE');
    const poles = edges.filter((e) => { const ed = oc.TopoDS.Edge(e); const d = (oc.BRep_Tool as any).Degenerated(ed); ed.delete(); return d; }).length;
    edges.forEach((e) => e.delete());
    if (poles >= 2 && ad.IsUClosed() && !ad.IsUPeriodic()) n++;
    free(ad, face, f);
  }
  return n;
}

/** Faces of the model that cross the start of their periodic surface's parameters. */
function crossingFaces(s: any): number {
  let n = 0;
  for (const f of listSubShapes(oc, s, 'TopAbs_FACE')) {
    const face = oc.TopoDS.Face(f);
    const ad = new oc.BRepAdaptor_Surface(face, false);
    if (String(ad.GetType()).includes('BSplineSurface') && (ad.IsUPeriodic() || ad.IsVPeriodic()) && periodicCrossings(oc, face, ad).length) n++;
    free(ad, face, f);
  }
  return n;
}

describe('STEP export of the organic worked examples', () => {
  for (const [label, seams] of [['seams that failed: a face across the start of a periodic surface', HEAD_SEAMS], ['a split face lying one period past its surface\'s range', HEAD_SEAMS_SHIFTED]] as const)
  it(`the Easter Island head, ${label}`, async () => {
    const r = await example('easter island head', seams);
    try {
      expect(r.status.every((s) => s.ok), JSON.stringify(r.status.filter((s) => !s.ok))).toBe(true);
      // This build really has a face across the parameter start (if a kernel update changes that, pick new seams, keep the test).
      expect(crossingFaces(r.shape!)).toBeGreaterThanOrEqual(1);
      expectCleanStep(r.shape!, 'Moai');
      // The good-part check that failed in CI.
      expect(partQuality(oc, r.shape!).stepRoundTrip).toBe(true);
      if (seams === HEAD_SEAMS_SHIFTED) {
        // OpenCascade's reader leaves one face's p-curves a period past the range here, and the solid is still the same.
        const back = readStep(oc, exportStepFile(oc, r.shape!, { unit: 'mm', schema: 'AP214', name: 'Moai' }).text);
        try { expect(facesOutsideRange(oc, back)).toBeGreaterThanOrEqual(1); } finally { back.delete(); }
      }
    } finally { releaseRegen(r); }
  }, 300000);

  for (const [label, seams] of [['a face from pole to pole on a closed, not periodic surface', BEAR_SEAMS], ['a split that leaves a loose point inside a face', BEAR_SEAMS_LOOSE_POINT]] as const)
  it(`the cartoon bear: ${label}`, async () => {
    const r = await example('cartoon bear', seams);
    try {
      expect(r.status.every((s) => s.ok), JSON.stringify(r.status.filter((s) => !s.ok))).toBe(true);
      expect(closedPoleFaces(r.shape!)).toBeGreaterThanOrEqual(1);
      expectCleanStep(r.shape!, 'Bear');
      // The good-part check now runs the same read-back check (before, it compared volumes only and passed this bear).
      expect(partQuality(oc, r.shape!).stepRoundTrip).toBe(true);
    } finally { releaseRegen(r); }
  }, 300000);
});
