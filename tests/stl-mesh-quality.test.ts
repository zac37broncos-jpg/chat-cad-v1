/**
 * STL files of organic parts: no triangles crossing each other, and an honest deviation where the
 * model's own joints are only approximately exact.
 *
 * Found in the independent print verification (2026-11-06, docs/PRINT_VERIFICATION.md), which judges
 * CHAD's files with MeshLab, Manifold, trimesh, ADMesh, PrusaSlicer and a separate OpenCascade:
 *  - The Easter Island head's Draft STL had 14 triangles passing through other triangles (MeshLab:
 *    "self-intersecting faces") at the nostrils, a sharp spot thinner than the 0.05 mm tolerance. With
 *    the seams of an older build it had 28, and a fold where the mesher put triangles 0.088 mm past a
 *    face's real border, while the exporter reported at most 0.05 mm. Every check the exporter had
 *    (closed, manifold, oriented, no flat triangles) passed: crossing triangles were not checked.
 *  - With those older seams the Fine STL could never pass: one joint edge of the head lies 0.036 mm
 *    from its faces (OpenCascade's intersection curves are approximations; the edge's tolerance says
 *    so), the exporter counted that as mesh sag, meshed the part ever finer (1.26 million triangles,
 *    almost 3 minutes) and still refused to save.
 * Now every STL is checked for crossing triangles (src/kernel/meshIntersect.ts, the same count as
 * MeshLab's on these files) and meshed finer when some are found; border links are measured against
 * their B-rep edge's own curve, and the joint's tolerance is reported as the model's accuracy.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities } from '../src/core/model';
import * as F from '../src/core/featureCommands';
import { regenerate, releaseRegen, shapeDistance, type OC } from '../src/kernel/regen';
import { listSubShapes } from '../src/kernel/query';
import { exportStlFile, checkMesh, quadraticMax, sideGapMax, triangleGapMax } from '../src/kernel/exporters';
import { STL_PRESETS } from '../src/kernel/exportDefaults';
import { selfIntersections } from '../src/kernel/meshIntersect';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { withRecordedSeams } from './helpers/seams';
import { free, freeAll } from '../src/kernel/mem';

let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

const draft = STL_PRESETS.find((p) => p.id === 'draft')!;
const fine = STL_PRESETS.find((p) => p.id === 'fine')!;
const extra = STL_PRESETS.find((p) => p.id === 'extra')!;

// ------------------------------------------------------------------ the crossing check itself

/** A closed box as an indexed mesh, outward winding. */
function box(x0: number, y0: number, z0: number, s: number, pos: number[], tri: number[]) {
  const b = pos.length / 3;
  for (const [x, y, z] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]) pos.push(x0 + s * x, y0 + s * y, z0 + s * z);
  for (const f of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]) tri.push(...f.map((i) => b + i));
}

describe('crossing triangles (self-intersections)', () => {
  it('a closed box has none; two boxes passing through each other do', () => {
    const pos: number[] = [], tri: number[] = [];
    box(0, 0, 0, 1, pos, tri);
    expect(checkMesh(pos, tri).openEdges).toBe(0);
    expect(selfIntersections(pos, tri).triangles).toBe(0);
    // (In general position: touching exactly along an edge or a corner is not counted as crossing.)
    box(0.37, 0.41, 0.29, 1, pos, tri);
    const r = selfIntersections(pos, tri);
    expect(r.triangles).toBeGreaterThan(0);
    expect(r.pairs).toBeGreaterThan(0);
    // Boxes that only touch along a face are not crossing.
    const p2: number[] = [], t2: number[] = [];
    box(0, 0, 0, 1, p2, t2); box(1, 0, 0, 1, p2, t2);
    expect(selfIntersections(p2, t2).triangles).toBe(0);
  });

  it('crossing with a shared corner counts; neighbours across an edge do not', () => {
    // Two triangles sharing corner 0; the second one's far edge passes through the first one.
    const pos = [0, 0, 0, 2, 0, 0, 0, 2, 0, /* second */ 1, 0.5, -1, 0.5, 1, 1];
    expect(selfIntersections(pos, [0, 1, 2, 0, 3, 4]).pairs).toBe(1);
    // Folded flat over each other across a shared edge: that is checkMesh's flipped-edge business.
    const fold = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.5, 0];
    expect(selfIntersections(fold, [0, 1, 2, 0, 1, 3]).pairs).toBe(0);
    // Far apart: nothing.
    expect(selfIntersections([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5], [0, 1, 2, 3, 4, 5]).pairs).toBe(0);
  });

  it('is fast enough for big files', () => {
    // A 300 x 300 grid of boxes' worth of triangles: about 100k triangles, no crossings.
    const pos: number[] = [], tri: number[] = [];
    for (let i = 0; i < 90; i++) for (let j = 0; j < 90; j++) box(i * 2, j * 2, 0, 1, pos, tri);
    const t0 = performance.now();
    expect(selfIntersections(pos, tri).triangles).toBe(0);
    expect(performance.now() - t0).toBeLessThan(20000);
  });
});

describe('largest gap inside a triangle', () => {
  it('equals a brute-force search over the triangle for any signed midpoint gaps, and bounds them when signs are unknown', () => {
    // The gap of a flat triangle to a locally quadratic surface: 4 x (e01 l0 l1 + e12 l1 l2 + e20 l2 l0).
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    expect(quadraticMax(1, 1, 1, 1, 1, 1)).toBeCloseTo(4 / 3, 12); // sphere, equilateral: center, 4/3 of the midpoints
    expect(quadraticMax(1, 0, 0, 1, 1, 1)).toBe(1); // a cylinder across one side: that side's midpoint
    for (let k = 0; k < 2000; k++) {
      const e = [rnd(), rnd(), rnd()], s = e.map(() => (rnd() < 0.5 ? -1 : 1));
      let brute = 0, bruteUnsigned = 0;
      const N = 120;
      for (let i = 0; i <= N; i++) for (let j = 0; i + j <= N; j++) {
        const l0 = i / N, l1 = j / N, l2 = 1 - l0 - l1;
        brute = Math.max(brute, Math.abs(4 * (s[0] * e[0] * l0 * l1 + s[1] * e[1] * l1 * l2 + s[2] * e[2] * l2 * l0)));
        bruteUnsigned = Math.max(bruteUnsigned, 4 * (e[0] * l0 * l1 + e[1] * l1 * l2 + e[2] * l2 * l0));
      }
      const q = quadraticMax(e[0], e[1], e[2], s[0], s[1], s[2]);
      expect(q).toBeGreaterThanOrEqual(brute - 1e-12);
      expect(q).toBeLessThanOrEqual(brute * 1.001 + 1e-12); // the grid can only find less
      const u = quadraticMax(e[0], e[1], e[2], 0, s[1], s[2]); // a sign unknown: the all-one-sign bound
      expect(u).toBeGreaterThanOrEqual(bruteUnsigned - 1e-12);
      expect(u).toBeGreaterThanOrEqual(q - 1e-12);
    }
  });
  // The 12 lattice points (i, j, k) / 4 in the exporter's order: sides v0-v1, v1-v2, v2-v0 at 1/4, 1/2, 3/4, then inside.
  const LAT = [[3, 1, 0], [2, 2, 0], [1, 3, 0], [0, 3, 1], [0, 2, 2], [0, 1, 3], [1, 0, 3], [2, 0, 2], [3, 0, 1], [2, 1, 1], [1, 2, 1], [1, 1, 2]];
  const maxOn = (f: (l0: number, l1: number, l2: number) => number, N = 150) => {
    let m = 0;
    for (let i = 0; i <= N; i++) for (let j = 0; i + j <= N; j++) m = Math.max(m, Math.abs(f(i / N, j / N, 1 - (i + j) / N)));
    return m;
  };
  const latticeOf = (f: (l0: number, l1: number, l2: number) => number) => LAT.map(([i, j, k]) => f(i / 4, j / 4, k / 4));

  it('agrees with the quadratic on a quadratic surface (nothing added) and never reports less than the true largest gap of a degree-4 gap', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    // Sphere, equilateral triangle: exactly quadratic, 4/3 of the midpoint gap, both ways.
    const sphere = (l0: number, l1: number, l2: number) => 4 * (l0 * l1 + l1 * l2 + l2 * l0);
    expect(triangleGapMax(latticeOf(sphere), true)).toBeCloseTo(4 / 3, 9);
    expect(sideGapMax(0.75, 1, 0.75)).toBeCloseTo(1, 12); // a parabola along a side: its midpoint
    for (let n = 0; n < 1500; n++) {
      // Any polynomial up to degree 4 that is zero at the corners (a gap of a flat triangle to a smooth surface).
      const c = Array.from({ length: 9 }, rnd);
      const f = (l0: number, l1: number, l2: number) =>
        l0 * l1 * (c[0] + c[1] * l0 + c[2] * l1 + c[3] * l0 * l1) + l1 * l2 * (c[4] + c[5] * l1 + c[6] * l2) + l2 * l0 * (c[7] + c[8] * l2 * l0) + c[0] * l0 * l1 * l2;
      const truth = maxOn(f);
      const est = triangleGapMax(latticeOf(f), true);
      expect(est).toBeGreaterThanOrEqual(truth - 1e-9);
      // Along one side: g(t) = t (1 - t) (a + b t + c t^2).
      const [a, b, cc] = [rnd(), rnd(), rnd()];
      const g = (t: number) => t * (1 - t) * (a + b * t + cc * t * t);
      let sideTruth = 0;
      for (let k = 0; k <= 400; k++) sideTruth = Math.max(sideTruth, Math.abs(g(k / 400)));
      expect(sideGapMax(g(0.25), g(0.5), g(0.75))).toBeGreaterThanOrEqual(sideTruth - 1e-12);
    }
  });

  it('catches a lopsided gap along a side that the midpoint misses', () => {
    // Zero at the midpoint, yet 0.048 x b at t = 0.21 and 0.79: the old midpoint-only measure said 0.
    const g = (t: number) => t * (1 - t) * (t - 0.5);
    expect(Math.abs(g(0.5))).toBe(0);
    expect(sideGapMax(g(0.25), g(0.5), g(0.75))).toBeGreaterThanOrEqual(0.048);
    const f = (l0: number, l1: number) => l0 * l1 * (l0 - l1); // the same along side v0-v1 of a triangle
    expect(triangleGapMax(latticeOf((l0, l1) => f(l0, l1)), true)).toBeGreaterThanOrEqual(maxOn((l0, l1) => f(l0, l1)) - 1e-12);
  });
});

// ------------------------------------------------------------------ the organic examples

/** The chat's worked example, as the chat builds it today, or with recorded seams. */
async function example(subject: string, seams?: Record<string, string>) {
  const store = new DocumentStore();
  const ctx: ExecutorContext = { store, regen: async () => ({ mesh: null, status: [], sketches: [], mass: null, topology: null, ms: 0 }), selection: () => [], info: async () => { throw new Error('not used'); } };
  const ref: any = await executeTool(ctx, 'get_reference', { subject });
  await executeTool(ctx, 'build_model', { steps: ref.example.steps });
  const r = regenerate(oc, seams ? withRecordedSeams(store.state, seams) : store.state, { solver });
  expect(r.status.filter((s) => !s.ok)).toEqual([]);
  return r;
}

/** Seams of the head build whose Fine STL could not be saved (tests/step-periodic.test.ts, HEAD_SEAMS). */
const HEAD_SEAMS: Record<string, string> = {
  Chest: 'lo_vltf0l60', Head: 'lo_wdkewnn9', Nose: 'lo_p8zbfu2n', 'Left Eye Socket': 'lo_ay22jy9x', 'Right Eye Socket': 'mi_7yasok3q',
  'Left Nostril': 'lo_tbwdn59t', 'Right Nostril': 'mi_cnefl7c7', Mouth: 'lo_pwyj61ue', 'Mouth Line': 'lo_bu5ty7k0',
  'Left Ear': 'lo_0yz27x0n', 'Left Ear Groove': 'lo_g2mhsi68', 'Right Ear': 'mi_fhzivvie',
};

/** Read the binary STL back from its bytes (no exporter code) as an indexed mesh, welded on exact values. */
function readBack(data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = dv.getUint32(80, true);
  const map = new Map<string, number>(); const pos: number[] = []; const tri: number[] = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const o = 84 + 50 * i + 12 + 12 * k;
    const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
    const key = `${x},${y},${z}`; let v = map.get(key);
    if (v === undefined) { v = pos.length / 3; map.set(key, v); pos.push(x, y, z); }
    tri.push(v);
  }
  return { pos, tri };
}

/** Largest exact distance from sample points of the file (corners and centers of `count` triangles spread over it) to the solid's skin. */
function sampledDeviation(shape: any, pos: number[], tri: number[], count: number, extra: number[] = []) {
  const faces = listSubShapes(oc, shape, 'TopAbs_FACE');
  const comp = new oc.TopoDS_Compound(); const b = new oc.TopoDS_Builder(); b.MakeCompound(comp);
  for (const f of faces) b.Add(comp, f);
  const n = tri.length / 3;
  const pick = [...extra, ...Array.from({ length: count }, (_, i) => Math.floor((i * n) / count))];
  let worst = 0;
  for (const t of pick) {
    const c = [0, 1, 2].map((k) => [pos[3 * tri[3 * t + k]], pos[3 * tri[3 * t + k] + 1], pos[3 * tri[3 * t + k] + 2]]);
    for (const p of [...c, [0, 1, 2].map((a) => (c[0][a] + c[1][a] + c[2][a]) / 3)]) {
      const g = new oc.gp_Pnt(p[0], p[1], p[2]); const mv = new oc.BRepBuilderAPI_MakeVertex(g); const v = mv.Vertex();
      worst = Math.max(worst, shapeDistance(oc, comp, v));
      free(v, mv, g);
    }
  }
  freeAll(faces); free(b, comp);
  return worst;
}

describe('organic STL export', () => {
  it('the Easter Island head (as the chat builds it): Draft has no crossing triangles and keeps its tolerance', async () => {
    const r = await example('easter island head');
    try {
      const { data, report } = exportStlFile(oc, r.shape!, { linearDeflection: draft.linearDeflection, angularDeflection: draft.angularDeflection, unit: 'mm', format: 'binary', name: 'Head' });
      expect(report.problems).toEqual([]);
      expect(report.watertight).toBe(true);
      expect(report.crossingTriangles).toBe(0);
      expect(report.measuredDeviation).toBeLessThanOrEqual(draft.linearDeflection);
      // Independently: the file read back from its bytes has no crossing triangles, and points on it lie
      // within the tolerance of the exact solid (where the old file crossed itself: x = ±4, y = -30.4, z = 88.9 mm).
      const { pos, tri } = readBack(data);
      expect(selfIntersections(pos, tri).triangles).toBe(0);
      const nose: number[] = [];
      for (let t = 0; t < tri.length / 3; t++) {
        const c = tri[3 * t];
        if (Math.abs(Math.abs(pos[3 * c]) - 4) < 1 && Math.abs(pos[3 * c + 1] + 30.4) < 1 && Math.abs(pos[3 * c + 2] - 88.9) < 1) nose.push(t);
      }
      expect(nose.length).toBeGreaterThan(0);
      expect(sampledDeviation(r.shape, pos, tri, 150, nose.slice(0, 150))).toBeLessThanOrEqual(draft.linearDeflection + 1e-5);
    } finally { releaseRegen(r); }
  }, 300000);

  it('the Easter Island head with older seams: Fine saves, without crossing triangles or a runaway mesh, and names the joint tolerance', async () => {
    const r = await example('easter island head', HEAD_SEAMS);
    try {
      const t0 = performance.now();
      const { data, report } = exportStlFile(oc, r.shape!, { linearDeflection: fine.linearDeflection, angularDeflection: fine.angularDeflection, unit: 'mm', format: 'binary', name: 'Head' });
      const ms = performance.now() - t0;
      expect(report.problems).toEqual([]);
      expect(report.crossingTriangles).toBe(0);
      expect(report.measuredDeviation).toBeLessThanOrEqual(fine.linearDeflection);
      // The joint edges' 3D curves lie up to about 0.02 mm off their faces (the kernel's intersection
      // curves are approximations); the file follows them, and the panel says so in a Note. Their
      // tolerance is 0.036 mm, but that also covers the mismatch between each edge's curve on the face and
      // its 3D curve: an earlier version allowed for that larger number and so hid gaps of up to
      // 0.018 mm next to the joints (found by the independent check, verify/print). The corner's real
      // distance from the surface is used now.
      expect(report.jointTolerance).toBeGreaterThan(fine.linearDeflection);
      expect(report.jointTolerance).toBeLessThan(0.025);
      expect(report.notes.join(' ')).toMatch(/model itself is exact to 0\.0[12]\d\d mm/);
      const { pos, tri } = readBack(data);
      expect(selfIntersections(pos, tri).triangles).toBe(0);
      // Before: 1,257,584 triangles in 4 passes. A part this size at Fine needs about 300k.
      expect(report.triangles).toBeLessThan(600_000);
      expect(ms).toBeLessThan(120_000);
    } finally { releaseRegen(r); }
  }, 400000);

  it('the Easter Island head with older seams: Extra fine finishes in at most two passes, with no crossing triangles', async () => {
    // Found in the verification run: refining only the marked links of needle triangles never got
    // finer (about 20 links stayed over 0.005 mm after every round), so the part was meshed again and
    // again (1.35 million triangles) until the kernel ran out of memory; with longest-edge bisection it
    // converged, but then 37 triangles near the loft tips crossed, because halfway in parameters
    // between a pole and another corner is on the far side of the tip. Both are fixed in refineFace.
    const r = await example('easter island head', HEAD_SEAMS);
    try {
      const t0 = performance.now();
      const { data, report } = exportStlFile(oc, r.shape!, { linearDeflection: extra.linearDeflection, angularDeflection: extra.angularDeflection, unit: 'mm', format: 'binary', name: 'Head' });
      const ms = performance.now() - t0;
      expect(report.problems).toEqual([]);
      expect(report.crossingTriangles).toBe(0);
      expect(report.measuredDeviation).toBeLessThanOrEqual(extra.linearDeflection);
      expect(report.meshPasses).toBeLessThanOrEqual(2);
      expect(report.triangles).toBeLessThan(900_000);
      // Since border links are measured at three points (2026-11-06), the mesher's own border lines are
      // found up to 0.0059 mm off at this setting, so a second, finer whole-part pass runs: about 175 s
      // here (one pass, measuring only midpoints, took 70 s but missed those gaps).
      expect(ms).toBeLessThan(260_000);
      const { pos, tri } = readBack(data);
      expect(selfIntersections(pos, tri).triangles).toBe(0);
    } finally { releaseRegen(r); }
  }, 600000);
});

describe('prismatic STL export', () => {
  it('a part of two bodies that do not touch says so in a note (a valid file, but often a surprise)', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Plate Sketch' }), 0.5, { name: 'Plate' });
    // A boss on the plate, mirrored about the Front plane: the copy lands at y < 0, off the plate, in the air.
    const boss = st.addExtrude(st.addSketch('XY', rectangleEntities(3, 0.5, 0.5, 1), { offset: 0.5, name: 'Boss Sketch' }), 1, { name: 'Boss' });
    F.addMirror(st, { features: [boss], plane: { base: 'XZ' }, name: 'Mirror Boss' });
    const r = regenerate(oc, st.state, { solver });
    try {
      expect(r.status.filter((x) => !x.ok)).toEqual([]);
      const { report } = exportStlFile(oc, r.shape!, { linearDeflection: fine.linearDeflection, angularDeflection: fine.angularDeflection, unit: 'mm', format: 'binary', name: 'Plate' });
      expect(report.problems).toEqual([]);
      expect(report.pieces).toBe(2);
      expect(report.notes.join(' ')).toMatch(/2 separate bodies/);
    } finally { releaseRegen(r); }
  }, 60000);

  it('a countersink and a tapped blind hole with a drill point (cone tips): no crossing triangles at any preset', () => {
    // The verification run found 23 to 221 crossing triangles at the drill point's tip of this part
    // (an earlier build of the exporter, all three presets).
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Plate Sketch' }), 1, { name: 'Plate' });
    F.addHole(st, { holeType: 'countersink', standard: 'ansi-inch', size: '#10', end: 'through', placement: { base: 'XY', offset: 1 }, points: [{ x: 1, y: 1 }], name: 'CSK #10' });
    F.addHole(st, { holeType: 'tapped', standard: 'ansi-inch', size: '1/4-20', end: 'blind', placement: { base: 'XY', offset: 1 }, points: [{ x: 3, y: 1 }], name: 'Tapped 1/4-20' });
    const r = regenerate(oc, st.state, { solver });
    try {
      expect(r.status.filter((x) => !x.ok)).toEqual([]);
      for (const p of [draft, fine, extra]) {
        const { data, report } = exportStlFile(oc, r.shape!, { linearDeflection: p.linearDeflection, angularDeflection: p.angularDeflection, unit: 'mm', format: 'binary', name: 'Plate' });
        expect(report.problems, p.id).toEqual([]);
        expect(report.crossingTriangles, p.id).toBe(0);
        expect(report.measuredDeviation, p.id).toBeLessThanOrEqual(p.linearDeflection);
        const { pos, tri } = readBack(data);
        expect(selfIntersections(pos, tri).triangles, p.id).toBe(0);
      }
    } finally { releaseRegen(r); }
  }, 120000);
});
