/**
 * Mass Properties on faces that run past their surface's parameter range (src/kernel/area.ts).
 *
 * Found 2026-11-10 by the independent print verification run on CHAD (verify/print): on the Easter
 * Island head, OpenCascade's area integration put two faces at 231.26 mm² each where they are
 * 230.976 mm² (their (u, v) bounds run from 19.3 to 30.7 on a periodic loft skin whose knots end at
 * 24), so Mass Properties showed the head's area 0.58 mm² too large, and 1.5 mm² with the seams of
 * an older build; its plain volume integration was 0.72 mm³ and 4.5 mm³ off. The reference values
 * below were measured with tools that share no code with this path:
 *  - area 34735.59 mm²: Gauss quadrature of the exact surface over a fine triangulation of every
 *    face, with the boundary slivers (Python, OpenCascade 7.8, on the STEP file: 34735.592 and
 *    34735.597 for the two builds), and the same faces split into in-range pieces integrated by
 *    OpenCascade 7.8 (230.97612 mm² for each of the two faces above);
 *  - volume 357259.10 mm³: Gauss-Kronrod integration of the STEP file in OpenCascade 7.8
 *    (357259.098 for both builds).
 * The two builds are the same geometry with different loft seams, so they must also agree.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, newId, type SketchEntity } from '../src/core/model';
import * as F from '../src/core/featureCommands';
import { regenerate, releaseRegen, type OC } from '../src/kernel/regen';
import { edgeRefFrom } from '../src/kernel/naming';
import { listSubShapes, massProperties, displayTess } from '../src/kernel/query';
import { faceAreaByQuadrature, pastKnotRange, type QuadratureStats } from '../src/kernel/area';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { free } from '../src/kernel/mem';
import { withRecordedSeams } from './helpers/seams';

let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

/** Every face: OpenCascade's area and the quadrature's (on the display mesh), with what the quadrature covered. */
function faceAreas(s: any) {
  const t = displayTess(oc, s);
  (oc.BRepTools as any).Clean(s, false);
  const m = new oc.BRepMesh_IncrementalMesh(s, t.linearDeflection, false, t.angularDeflection, false);
  m.delete();
  return listSubShapes(oc, s, 'TopAbs_FACE').map((f) => {
    const face = oc.TopoDS.Face(f);
    const g = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, g, 1e-12, false);
    const stats = {} as QuadratureStats;
    const out = { occ: g.Mass(), quad: faceAreaByQuadrature(oc, face, stats), stats, past: pastKnotRange(oc, face) };
    free(g, face, f);
    return out;
  });
}

describe('surface area by quadrature (the independent second calculation)', () => {
  it('is exact on planes, cylinders, cones and a torus (matches OpenCascade and the closed form)', () => {
    // Torus R1 x r0.25 in: area 4 pi^2 R r.
    const ring = new DocumentStore();
    const ents: SketchEntity[] = [
      { id: 'ax', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 }, construction: true },
      { id: newId('c'), kind: 'circle', center: { x: 1, y: 0 }, radius: 0.25 },
    ];
    ring.addRevolve(ring.addSketch('XY', ents), 'ax', 360);
    // Block with rounds (cylinders), a chamfer, a countersink (cone) and holes.
    const block = new DocumentStore();
    block.addExtrude(block.addSketch('XY', rectangleEntities(0, 0, 4, 2)), 1);
    let r = regenerate(oc, block.state, { solver });
    const t = r.topology!;
    const vertical = t.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.mid[2] - 12.7) < 1e-6);
    F.addFillet(block, { edges: vertical.map(({ i }) => edgeRefFrom(t, i)), radius: 0.25 });
    releaseRegen(r);
    F.addHole(block, { holeType: 'countersink', standard: 'ansi-inch', size: '#10', end: 'through', placement: { base: 'XY', offset: 1 }, points: [{ x: 1, y: 1 }] });
    F.addHole(block, { holeType: 'tapped', standard: 'ansi-inch', size: '1/4-20', end: 'blind', placement: { base: 'XY', offset: 1 }, points: [{ x: 3, y: 1 }] });
    for (const [st, check] of [[ring, (a: number) => expect(Math.abs(a - 4 * Math.PI ** 2 * 25.4 * 6.35) / a).toBeLessThan(1e-12)], [block, null]] as const) {
      r = regenerate(oc, st.state, { solver });
      try {
        expect(r.status.every((s) => s.ok)).toBe(true);
        const faces = faceAreas(r.shape!);
        for (const f of faces) {
          expect(f.quad).not.toBeNull();
          expect(Math.abs(f.quad! - f.occ) / f.occ).toBeLessThan(1e-9);
        }
        if (check) check(faces.reduce((s, f) => s + f.quad!, 0));
      } finally { releaseRegen(r); }
    }
  });

  it('agrees with OpenCascade on free-form faces it integrates right (spline loft, blend)', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const ring = (n: number, rx: number, ry: number) => Array.from({ length: n }, (_, i) => { const q = (2 * Math.PI * i) / n; return [+(rx * Math.cos(q)).toFixed(6), +(ry * Math.sin(q)).toFixed(6)]; });
    const sec = (i: number, z: number, s: number) => ({ tool: 'create_sketch', args: { plane: 'XY', offset: z, name: `S${i}`, entities: [{ type: 'spline', closed: true, points: ring(10, 14 * s, 10 * s) }] } });
    const built: any[] = [];
    const ctx: ExecutorContext = {
      store, selection: () => [], info: async () => { throw new Error('not used'); },
      // The blend picks its edges from the rebuilt model, so the build needs real rebuilds.
      regen: async () => { const b = regenerate(oc, store.state, { solver }); built.push(b); return { mesh: null, status: b.status, sketches: b.sketches, mass: null, topology: b.topology ?? null, ms: 0 }; },
    };
    const res: any = await executeTool(ctx, 'build_model', { steps: [
      sec(1, 0, 1), sec(2, 15, 1.25), sec(3, 30, 1.1), sec(4, 45, 0.7),
      { tool: 'loft', args: { profile_sketch_ids: ['S1', 'S2', 'S3', 'S4'], end_point: [0, 0, 55], name: 'Body' } },
      { tool: 'create_sketch', args: { plane: 'XZ', offset: 5, name: 'Nose Profile', entities: [{ type: 'circle', cx: 0, cy: 28, diameter: 7 }] } },
      { tool: 'extrude', args: { sketch_id: 'Nose Profile', depth: 12, direction: 'normal', operation: 'add', name: 'Nose' } },
      { tool: 'fillet', args: { edges: [{ between: ['Body', 'Nose'] }], radius: 2, name: 'Nose Blend' } },
    ] });
    built.forEach(releaseRegen);
    expect(res.ok).toBe(true);
    const r = regenerate(oc, store.state, { solver });
    try {
      const faces = faceAreas(r.shape!);
      expect(faces.some((f) => f.stats.slivers !== 0)).toBe(true); // curved borders were measured, not skipped
      for (const f of faces) {
        expect(f.past).toBe(false);
        expect(f.quad).not.toBeNull();
        expect(Math.abs(f.quad! - f.occ) / f.occ).toBeLessThan(2e-6);
      }
    } finally { releaseRegen(r); }
  }, 120_000);
});

/** The Easter Island head from the chat's reference library: as it builds today, or with recorded seams. */
async function head(seams: Record<string, string> | null) {
  const store = new DocumentStore();
  const ctx: ExecutorContext = { store, regen: async () => ({ mesh: null, status: [], sketches: [], mass: null, topology: null, ms: 0 }), selection: () => [], info: async () => { throw new Error('not used'); } };
  const ref: any = await executeTool(ctx, 'get_reference', { subject: 'easter island head' });
  await executeTool(ctx, 'build_model', { steps: ref.example.steps });
  return regenerate(oc, seams ? withRecordedSeams(store.state, seams) : store.state, { solver });
}
/** Seams of an older build (verify/print part 14b). */
const HEAD_SEAMS: Record<string, string> = {
  Chest: 'lo_vltf0l60', Head: 'lo_wdkewnn9', Nose: 'lo_p8zbfu2n', 'Left Eye Socket': 'lo_ay22jy9x', 'Right Eye Socket': 'mi_7yasok3q',
  'Left Nostril': 'lo_tbwdn59t', 'Right Nostril': 'mi_cnefl7c7', Mouth: 'lo_pwyj61ue', 'Mouth Line': 'lo_bu5ty7k0',
  'Left Ear': 'lo_0yz27x0n', 'Left Ear Groove': 'lo_g2mhsi68', 'Right Ear': 'mi_fhzivvie',
};
const HEAD_AREA = 34735.59, HEAD_VOLUME = 357259.10;

describe('Mass Properties of the Easter Island head (faces past their surface range)', () => {
  const got: { area: number; volume: number }[] = [];
  for (const [label, seams] of [['as the chat builds it today', null], ['with the seams of an older build', HEAD_SEAMS]] as const) {
    it(`area and volume match the independent reference, ${label}`, async () => {
      const r = await head(seams);
      try {
        expect(r.status.every((s) => s.ok)).toBe(true);
        const s = r.shape!;
        // The case this guards: faces whose (u, v) bounds run past their periodic surface's knots.
        const past = listSubShapes(oc, s, 'TopAbs_FACE').filter((f) => { const face = oc.TopoDS.Face(f); const p = pastKnotRange(oc, face); free(face, f); return p; });
        expect(past.length).toBeGreaterThan(0);
        const m = massProperties(oc, s);
        // Before the fix: +0.58 mm² and +1.52 mm²; +0.72 mm³ and +4.55 mm³.
        expect(Math.abs(m.area - HEAD_AREA)).toBeLessThan(0.03);
        expect(Math.abs(m.volume - HEAD_VOLUME)).toBeLessThan(0.05);
        got.push({ area: m.area, volume: m.volume });
        if (got.length === 2) {
          expect(Math.abs(got[0].area - got[1].area)).toBeLessThan(0.02);
          expect(Math.abs(got[0].volume - got[1].volume)).toBeLessThan(0.01);
        }
      } finally { releaseRegen(r); }
    }, 300_000);
  }
});
