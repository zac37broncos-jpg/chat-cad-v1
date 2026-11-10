/**
 * STEP and STL export, verified the hard way: every file is read back by
 * methods that do not share code with the writer, and compared with the
 * exact solid and with sizes and volumes calculated by hand.
 *
 *  - STL files are parsed from their bytes here (binary and ASCII), welded on
 *    exact float values and checked: closed, manifold, consistently oriented,
 *    outward normals, no degenerate triangles, the right number of through
 *    holes (Euler's formula), size, volume, and the real chord error measured
 *    against the exact surface.
 *  - STEP files are read back by OpenCascade's STEP reader (volume, size,
 *    topology, validity) AND parsed as text here (schema, declared unit,
 *    product name, one manifold solid, vertex coordinates in the file's unit).
 *
 * Tolerances: 0.005 in = 0.127 mm is the project's accuracy promise. STEP
 * must agree with the model to 1e-6 relative (in practice it is exact to
 * 13 digits). STL must stay within its chord tolerance (default 0.01 mm =
 * 0.0004 in, 1/12 of the promise).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, newId, type SketchEntity } from '../src/core/model';
import { regenerate, isValid, type OC } from '../src/kernel/regen';
import { massProperties, listSubShapes } from '../src/kernel/query';
import { exportStlFile, exportStepFile, readStep, safeFileBase, stepString, checkMesh, fixSlivers, type StlOptions } from '../src/kernel/exporters';
import { STL_DEFAULT, STL_PRESETS } from '../src/kernel/exportDefaults';
import { edgeRefFrom, type Topology } from '../src/kernel/naming';
import * as F from '../src/core/featureCommands';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { free, freeAll, takeXyz } from '../src/kernel/mem';
import { selfIntersections } from '../src/kernel/meshIntersect';

const IN = 25.4;
const IN3 = IN ** 3;
const PROMISE_MM = 0.005 * IN;
let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

// ------------------------------------------------------------------ test parts (inches unless noted)

interface Part {
  name: string;
  shape: TopoDS_Shape;
  /** Hand-calculated volume (mm^3) and bounding box (mm), when the part has one. */
  volume?: number;
  box?: { min: [number, number, number]; max: [number, number, number] };
  throughHoles: number;
  faces?: number;
}
const parts: Record<string, Part> = {};
const shapeOf = (st: DocumentStore) => {
  const r = regenerate(oc, st.state, { solver });
  const bad = r.status.filter((s) => !s.ok);
  expect(bad, JSON.stringify(bad)).toEqual([]);
  return r;
};
const inBox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ min: [x0 * IN, y0 * IN, z0 * IN] as [number, number, number], max: [x1 * IN, y1 * IN, z1 * IN] as [number, number, number] });

function plateWithHoles(): Part {
  // 4 x 2 x 0.5 plate, two 1/4" through holes 0.5 in from the ends.
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Plate Sketch' }), 0.5, { name: 'Plate' });
  const holes = st.addSketch('XY', [
    { id: newId('c'), kind: 'circle', center: { x: 0.5, y: 1 }, radius: 0.125 },
    { id: newId('c'), kind: 'circle', center: { x: 3.5, y: 1 }, radius: 0.125 },
  ], { name: 'Hole Sketch' });
  st.addExtrude(holes, 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Holes' });
  return { name: 'Plate With Holes', shape: shapeOf(st).shape!, volume: (4 * 2 * 0.5 - 2 * Math.PI * 0.125 ** 2 * 0.5) * IN3, box: inBox(0, 0, 0, 4, 2, 0.5), throughHoles: 2, faces: 8 };
}

function filletChamferBlock(): Part {
  // 4 x 2 x 1 block, four vertical edges R0.25, then one top long edge chamfered 0.1 x 0.1.
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2)), 1, { name: 'Block' });
  let t = shapeOf(st).topology! as Topology;
  const vertical = t.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.mid[2] - 0.5 * IN) < 1e-6);
  expect(vertical.length).toBe(4);
  F.addFillet(st, { edges: vertical.map(({ i }) => edgeRefFrom(t, i)), radius: 0.25, name: 'Corner Rounds' });
  t = shapeOf(st).topology! as Topology;
  // Top edge along X at y = 0. Like mainstream CAD, the chamfer follows tangent edges: all around the top.
  const top = t.edges.findIndex((e) => Math.abs(e.mid[0] - 2 * IN) < 1e-6 && Math.abs(e.mid[1]) < 1e-6 && Math.abs(e.mid[2] - IN) < 1e-6);
  expect(top).toBeGreaterThanOrEqual(0);
  F.addChamfer(st, { edges: [edgeRefFrom(t, top)], distance: 0.1, name: 'Edge Break' });
  const shape = shapeOf(st).shape!;
  // By hand: the rounds remove 4 (r^2 - pi r^2 / 4) x 1. The chamfer's 0.1 x 0.1 triangle (area 0.005) runs
  // along 2 (3.5 + 1.5) = 10 in of straight edge and, by Pappus, around four quarter rounds whose
  // triangle centroid sits 0.1/3 inside the R0.25 edge: 0.005 x 2 pi (0.25 - 0.1/3).
  const volume = (8 - 4 * (0.25 ** 2 - (Math.PI * 0.25 ** 2) / 4) - 0.005 * (10 + 2 * Math.PI * (0.25 - 0.1 / 3))) * IN3;
  return { name: 'Fillet And Chamfer Block', shape, volume, box: inBox(0, 0, 0, 4, 2, 1), throughHoles: 0 };
}

function boltCircleFlange(): Part {
  // Ø4 x 0.25 disc with six #10 clearance holes (Ø0.221) patterned on a Ø3 bolt circle.
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: 2 }]), 0.25, { name: 'Flange' });
  const hole = F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '#10', end: 'through', placement: { base: 'XY', offset: 0.25 }, points: [{ x: 1.5, y: 0 }], name: 'Bolt Hole' });
  F.addCircularPattern(st, { features: [hole], axis: { axis: 'Z' }, count: 6, angle: 360, name: 'Bolt Pattern' });
  const r = 0.221 / 2;
  return { name: 'Bolt Circle Flange', shape: shapeOf(st).shape!, volume: (Math.PI * 4 * 0.25 - 6 * Math.PI * r * r * 0.25) * IN3, box: inBox(-2, -2, 0, 2, 2, 0.25), throughHoles: 6 };
}

function revolvedTorus(): Part {
  // Circle r = 0.25 at 1 in from the axis, revolved 360: torus, V = 2 pi^2 R r^2 (Pappus).
  const st = new DocumentStore();
  const ents: SketchEntity[] = [
    { id: 'ax', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 }, construction: true },
    { id: newId('c'), kind: 'circle', center: { x: 1, y: 0 }, radius: 0.25 },
  ];
  st.addRevolve(st.addSketch('XY', ents, { name: 'Ring Profile' }), 'ax', 360, { name: 'Ring' });
  // The sketch is on the Top plane (XY), its Y axis is the revolve axis: the ring lies around world Y.
  return { name: 'Revolved Ring', shape: shapeOf(st).shape!, volume: 2 * Math.PI ** 2 * 1 * 0.25 ** 2 * IN3, box: inBox(-1.25, -0.25, -1.25, 1.25, 0.25, 1.25), throughHoles: 1 };
}

async function organicFigure(): Promise<Part> {
  // The chat's organic path in mm: spline sections lofted to a tip, a nose, a blend fillet.
  const store = new DocumentStore(); store.setUnits('mm');
  const ctx: ExecutorContext = {
    store,
    regen: async () => { const r = regenerate(oc, store.state, { solver, cache: false }); return { mesh: null, status: r.status, sketches: r.sketches, mass: null, topology: r.topology ?? null, ms: 0 }; },
    selection: () => [],
    info: async () => { throw new Error('not used'); },
  };
  const ring = (n: number, rx: number, ry: number): [number, number][] => Array.from({ length: n }, (_, i) => { const q = (2 * Math.PI * i) / n; return [+(rx * Math.cos(q)).toFixed(6), +(ry * Math.sin(q)).toFixed(6)]; });
  const sec = (i: number, z: number, s: number) => ({ tool: 'create_sketch', args: { plane: 'XY', offset: z, name: `Body Section ${i}`, entities: [{ type: 'spline', closed: true, points: ring(10, 14 * s, 10 * s) }] } });
  const res: any = await executeTool(ctx, 'build_model', { steps: [
    sec(1, 0, 1), sec(2, 15, 1.25), sec(3, 30, 1.1), sec(4, 45, 0.7),
    { tool: 'loft', args: { profile_sketch_ids: ['Body Section 1', 'Body Section 2', 'Body Section 3', 'Body Section 4'], end_point: [0, 0, 55], name: 'Body' } },
    { tool: 'create_sketch', args: { plane: 'XZ', offset: 5, name: 'Nose Profile', entities: [{ type: 'circle', cx: 0, cy: 28, diameter: 7 }] } },
    { tool: 'extrude', args: { sketch_id: 'Nose Profile', depth: 12, direction: 'normal', operation: 'add', name: 'Nose' } },
    { tool: 'fillet', args: { edges: [{ between: ['Body', 'Nose'] }], radius: 2, name: 'Nose Blend' } },
  ] });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return { name: 'Organic Figure', shape: shapeOf(store).shape!, throughHoles: 0 };
}

async function figureWithArm(): Promise<Part> {
  // The chat's sculpting tools in inches: a body from silhouettes with a round top, and an arm tube
  // joined to it (trimmed free-form faces meeting along a curve: the hardest case for the mesher).
  const store = new DocumentStore();
  const ctx: ExecutorContext = {
    store,
    regen: async () => { const r = regenerate(oc, store.state, { solver }); return { mesh: null, status: r.status, sketches: r.sketches, mass: null, topology: r.topology ?? null, ms: 0 }; },
    selection: () => [],
    info: async () => { throw new Error('not used'); },
  };
  await executeTool(ctx, 'profile_body', { name: 'Body', end: 'round', stations: [{ at: 0, x: 1, y: [-0.8, 0.8] }, { at: 1.5, x: 1.2, y: [-1, 0.9] }, { at: 3, x: 0.9, y: [-0.7, 0.7] }] });
  await executeTool(ctx, 'tube', { name: 'Arm', path: [[0.8, 0, 2], [1.5, -0.3, 1.4], [1.7, -0.5, 0.8]], radii: [0.3, 0.22, 0.18], start_end: 'flat', finish_end: 'round' });
  return { name: 'Figure With Arm', shape: shapeOf(store).shape!, throughHoles: 0 };
}

beforeAll(async () => {
  parts.arm = await figureWithArm();
  parts.plate = plateWithHoles();
  parts.block = filletChamferBlock();
  parts.flange = boltCircleFlange();
  parts.ring = revolvedTorus();
  parts.organic = await organicFigure();
}, 120000);

// ------------------------------------------------------------------ independent STL reader

interface StlFile { tris: Float64Array /* 9 per triangle */; normals: Float64Array; header?: string; name?: string }

function parseBinaryStl(b: Uint8Array): StlFile {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint32(80, true);
  expect(b.byteLength).toBe(84 + 50 * n);
  const tris = new Float64Array(9 * n), normals = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const o = 84 + 50 * i;
    for (let k = 0; k < 3; k++) normals[3 * i + k] = dv.getFloat32(o + 4 * k, true);
    for (let k = 0; k < 9; k++) tris[9 * i + k] = dv.getFloat32(o + 12 + 4 * k, true);
    expect(dv.getUint16(o + 48, true)).toBe(0);
  }
  return { tris, normals, header: new TextDecoder('latin1').decode(b.subarray(0, 80)) };
}

function parseAsciiStl(b: Uint8Array): StlFile {
  const text = new TextDecoder().decode(b);
  expect(text.startsWith('solid ')).toBe(true);
  expect(text.trimEnd().split('\n').pop()!.startsWith('endsolid')).toBe(true);
  const facets = text.split('endfacet');
  facets.pop();
  const tris = new Float64Array(9 * facets.length), normals = new Float64Array(3 * facets.length);
  const num = (s: string) => { const x = Number(s); expect(Number.isFinite(x), s).toBe(true); return Math.fround(x); };
  facets.forEach((f, i) => {
    const nm = /facet normal (\S+) (\S+) (\S+)/.exec(f)!;
    for (let k = 0; k < 3; k++) normals[3 * i + k] = num(nm[k + 1]);
    const vs = [...f.matchAll(/vertex (\S+) (\S+) (\S+)/g)];
    expect(vs.length).toBe(3);
    vs.forEach((v, j) => { for (let k = 0; k < 3; k++) tris[9 * i + 3 * j + k] = num(v[k + 1]); });
    expect(f).toContain('outer loop');
    expect(f).toContain('endloop');
  });
  return { tris, normals, name: /^solid (\S*)/.exec(text)![1] };
}

/** Weld on exact coordinates (what every slicer does) into an indexed mesh. */
function indexed(f: StlFile) {
  const map = new Map<string, number>();
  const pos: number[] = [];
  const tri: number[] = [];
  for (let i = 0; i < f.tris.length; i += 3) {
    const k = `${f.tris[i]},${f.tris[i + 1]},${f.tris[i + 2]}`;
    let v = map.get(k);
    if (v === undefined) { v = pos.length / 3; map.set(k, v); pos.push(f.tris[i], f.tris[i + 1], f.tris[i + 2]); }
    tri.push(v);
  }
  return { pos, tri };
}

/** Everything a slicer needs: closed, manifold, oriented outward, no degenerate facets, normals agree. */
function expectPrintable(f: StlFile, throughHoles: number) {
  const { pos, tri } = indexed(f);
  const n = tri.length / 3;
  expect(n).toBeGreaterThan(0);
  // Independent edge count (not checkMesh): each undirected edge exactly twice, once each way.
  const dir = new Map<string, number>();
  for (let t = 0; t < n; t++) {
    const v = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
    expect(new Set(v).size, 'triangle with a repeated corner').toBe(3);
    for (let k = 0; k < 3; k++) { const key = `${v[k]}>${v[(k + 1) % 3]}`; dir.set(key, (dir.get(key) ?? 0) + 1); }
  }
  let bad = 0;
  for (const [key, c] of dir) { const [a, b] = key.split('>'); if (c !== 1 || dir.get(`${b}>${a}`) !== 1) bad++; }
  expect(bad, 'open, non-manifold or flipped edges').toBe(0);
  // Stored normals agree with the right-hand winding, and the volume is positive (normals outward).
  let vol = 0, minDot = 1;
  for (let t = 0; t < n; t++) {
    const p = (k: number) => [f.tris[9 * t + 3 * k], f.tris[9 * t + 3 * k + 1], f.tris[9 * t + 3 * k + 2]];
    const [a, b, c] = [p(0), p(1), p(2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...cr);
    expect(l, 'zero-area facet').toBeGreaterThan(0);
    const nn = [f.normals[3 * t], f.normals[3 * t + 1], f.normals[3 * t + 2]];
    expect(Math.abs(Math.hypot(...nn) - 1)).toBeLessThan(1e-6);
    minDot = Math.min(minDot, (nn[0] * cr[0] + nn[1] * cr[1] + nn[2] * cr[2]) / l);
    vol += (a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]) / 6;
  }
  expect(minDot, 'stored normal disagrees with the winding').toBeGreaterThan(0.999);
  expect(vol).toBeGreaterThan(0);
  // Euler: V - E + F = 2 - 2 * holes for one closed piece.
  const E = dir.size / 2;
  expect(pos.length / 3 - E + n).toBe(2 - 2 * throughHoles);
  // And the exporter's own checker says the same on the same data.
  const c = checkMesh(pos, tri);
  expect([c.openEdges, c.nonManifoldEdges, c.flippedEdges, c.zeroAreaTriangles, c.pieces, c.throughHoles]).toEqual([0, 0, 0, 0, 1, throughHoles]);
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < pos.length; i++) { const k = i % 3; box.min[k] = Math.min(box.min[k], pos[i]); box.max[k] = Math.max(box.max[k], pos[i]); }
  return { pos, tri, volume: vol, box };
}

/** Skin of the solid (faces only), so distances are to the surface, not 0 inside the solid. */
function skinOf(s: TopoDS_Shape) {
  const comp = new oc.TopoDS_Compound(); const b = new oc.TopoDS_Builder(); b.MakeCompound(comp);
  const faces = listSubShapes(oc, s, 'TopAbs_FACE');
  for (const f of faces) b.Add(comp, f);
  freeAll(faces); b.delete();
  return comp;
}
/** Distance from a point (mm) to the exact surface. */
function distToSkin(skin: TopoDS_Shape, p: [number, number, number]) {
  const pt = new oc.gp_Pnt(p[0], p[1], p[2]);
  const mv = new oc.BRepBuilderAPI_MakeVertex(pt);
  const v = mv.Vertex();
  const d = new oc.BRepExtrema_DistShapeShape(v, skin);
  const out = d.IsDone() ? d.Value() : NaN;
  free(d, v, mv, pt);
  return out;
}
/**
 * Largest chord error, measured: distance from the exact surface to the
 * middle of triangle edges and to triangle centroids, on the largest
 * triangles plus an even spread of others (150 + 250 by default).
 */
function measuredChordError(shape: TopoDS_Shape, f: StlFile, mmPerUnit: number, largest = 150, spread = 250) {
  const n = f.tris.length / 9;
  const area = (t: number) => { const q = f.tris.subarray(9 * t, 9 * t + 9); const u = [q[3] - q[0], q[4] - q[1], q[5] - q[2]], w = [q[6] - q[0], q[7] - q[1], q[8] - q[2]]; return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]); };
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => area(b) - area(a));
  const k = Math.min(spread, n);
  const pick = new Set([...order.slice(0, largest), ...Array.from({ length: k }, (_, i) => Math.floor((i * n) / k))]);
  const skin = skinOf(shape);
  let worst = 0;
  try {
    for (const t of pick) {
      const q = Array.from(f.tris.subarray(9 * t, 9 * t + 9), (x) => x * mmPerUnit);
      const P = (k: number) => [q[3 * k], q[3 * k + 1], q[3 * k + 2]];
      const samples: [number, number, number][] = [[0, 1], [1, 2], [2, 0]].map(([i, j]) => P(i).map((x, k) => (x + P(j)[k]) / 2) as [number, number, number]);
      samples.push(P(0).map((x, k) => (x + P(1)[k] + P(2)[k]) / 3) as [number, number, number]);
      for (const s of samples) worst = Math.max(worst, distToSkin(skin, s));
    }
  } finally { skin.delete(); }
  return worst;
}

const stl = (p: Part, o: Partial<StlOptions> = {}) => exportStlFile(oc, p.shape, { ...STL_DEFAULT, unit: 'mm', format: 'binary', name: p.name, ...o });

// ------------------------------------------------------------------ STL

describe('STL export for printing', () => {
  it('the default tolerance is far inside the 0.005 in promise', () => {
    expect(STL_DEFAULT.linearDeflection).toBeLessThanOrEqual(PROMISE_MM / 10);
    for (const p of STL_PRESETS) expect(p.linearDeflection).toBeLessThan(PROMISE_MM);
  });

  for (const key of ['plate', 'block', 'flange', 'ring', 'organic', 'arm']) {
    it(`${key}: binary mm STL is watertight, the right size and volume, within its chord tolerance`, () => {
      const p = parts[key];
      const { data, report } = stl(p);
      expect(report.problems).toEqual([]);
      expect(report.watertight).toBe(true);
      const f = parseBinaryStl(data);
      expect(f.header!.startsWith('solid')).toBe(false); // would make readers take it for ASCII
      expect(f.header).toContain('units: mm');
      const m = expectPrintable(f, p.throughHoles);
      expect(report.triangles).toBe(f.tris.length / 9);
      // No triangle passes through another: the exporter says so, and so does the check on the file read back.
      expect(report.crossingTriangles).toBe(0);
      expect(selfIntersections(m.pos, m.tri).triangles).toBe(0);

      // Every corner is ON the surface, so the mesh lies within the exact box, and reaches it to within the chord tolerance.
      const lin = STL_DEFAULT.linearDeflection;
      const exact = massProperties(oc, p.shape);
      const box = p.box ?? { min: exact.bboxMin, max: exact.bboxMax };
      for (let k = 0; k < 3; k++) {
        const eps = 1e-6 * Math.max(1, Math.abs(box.min[k]), Math.abs(box.max[k]));
        expect(m.box.min[k]).toBeGreaterThanOrEqual(box.min[k] - eps);
        expect(m.box.max[k]).toBeLessThanOrEqual(box.max[k] + eps);
        expect(m.box.min[k] - box.min[k]).toBeLessThanOrEqual(lin + eps);
        expect(box.max[k] - m.box.max[k]).toBeLessThanOrEqual(lin + eps);
      }
      if (p.box) for (let k = 0; k < 3; k++) { expect(Math.abs(exact.bboxMin[k] - p.box.min[k])).toBeLessThan(1e-6); expect(Math.abs(exact.bboxMax[k] - p.box.max[k])).toBeLessThan(1e-6); }

      // Volume: every point of the skin moves by at most the chord error, so |dV| <= area x error.
      const v = p.volume ?? exact.volume;
      if (p.volume) expect(Math.abs(exact.volume - p.volume) / p.volume).toBeLessThan(1e-9);
      expect(Math.abs(m.volume - v)).toBeLessThanOrEqual(exact.area * lin);

      // The chord error itself, measured against the exact surface (independently of the exporter's own measurement).
      expect(report.measuredDeviation).toBeLessThanOrEqual(lin);
      const err = measuredChordError(p.shape, f, 1);
      expect(err).toBeLessThanOrEqual(lin * 1.0001 + 1e-6);
      expect(err).toBeLessThan(PROMISE_MM / 10);
    }, 120000);
  }

  it('holes print round: hole wall points are exactly on the radius, with enough segments', () => {
    const p = parts.plate;
    const f = parseBinaryStl(stl(p).data);
    const { pos } = indexed(f);
    // Vertices on the hole at x = 0.5 in, y = 1 in (r = 0.125 in): all at the radius to float precision.
    const r = 0.125 * IN;
    const onHole: number[] = [];
    for (let i = 0; i < pos.length; i += 3) {
      const d = Math.hypot(pos[i] - 0.5 * IN, pos[i + 1] - IN);
      if (d < r * 1.5) { expect(Math.abs(d - r)).toBeLessThan(1e-5); onHole.push(Math.atan2(pos[i + 1] - IN, pos[i] - 0.5 * IN)); }
    }
    // Segments around the hole at the top face: the angle between neighbours.
    const angles = [...new Set(onHole.map((a) => a.toFixed(9)))].map(Number).sort((a, b) => a - b);
    expect(angles.length).toBeGreaterThanOrEqual(60);
    const gaps = angles.map((a, i) => (i ? a - angles[i - 1] : a + 2 * Math.PI - angles[angles.length - 1]));
    // Mid-segment sag = r (1 - cos(gap / 2)) is within the chord tolerance.
    expect(r * (1 - Math.cos(Math.max(...gaps) / 2))).toBeLessThanOrEqual(STL_DEFAULT.linearDeflection);
  });

  it('inch and ASCII files hold the same mesh as the mm binary file', () => {
    const p = parts.flange;
    const mm = parseBinaryStl(stl(p).data);
    const inch = stl(p, { unit: 'in' });
    expect(inch.report.problems).toEqual([]);
    const fi = parseBinaryStl(inch.data);
    expect(fi.header).toContain('units: in');
    expect(fi.tris.length).toBe(mm.tris.length);
    let worst = 0;
    for (let i = 0; i < mm.tris.length; i++) worst = Math.max(worst, Math.abs(fi.tris[i] * IN - mm.tris[i]));
    expect(worst).toBeLessThan(1e-4); // float32 rounding of numbers up to 50 mm
    expectPrintable(fi, p.throughHoles);
    const box = expectPrintable(fi, p.throughHoles).box;
    expect(box.max[0] - box.min[0]).toBeCloseTo(4, 3);
    // ASCII: same triangles, written with enough digits to give back the same float values.
    const asc = stl(p, { format: 'ascii' });
    expect(asc.report.problems).toEqual([]);
    const fa = parseAsciiStl(asc.data);
    expect(fa.name).toBe('Bolt_Circle_Flange');
    expect(Array.from(fa.tris)).toEqual(Array.from(mm.tris));
    expectPrintable(fa, p.throughHoles);
  });

  it('the result does not depend on what was meshed before (display or another export)', () => {
    const p = parts.flange;
    const fine = stl(p, { linearDeflection: 0.002, angularDeflection: 0.035 });
    const a = stl(p);
    const coarse = stl(p, { linearDeflection: 0.05, angularDeflection: 0.26 });
    const b = stl(p);
    expect(fine.report.triangles).toBeGreaterThan(a.report.triangles);
    expect(coarse.report.triangles).toBeLessThan(a.report.triangles);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });

  it('every preset gives a printable file within its own tolerance', () => {
    const p = parts.organic;
    for (const pr of STL_PRESETS) {
      const { data, report } = stl(p, pr);
      expect(report.problems, pr.id).toEqual([]);
      const f = parseBinaryStl(data);
      expectPrintable(f, 0);
      expect(report.measuredDeviation).toBeLessThanOrEqual(pr.linearDeflection);
      expect(measuredChordError(p.shape, f, 1, 60, 100)).toBeLessThanOrEqual(pr.linearDeflection * 1.0001 + 1e-6);
    }
  }, 240000);

  it('flips a flat sliver triangle into its neighbour, keeping the mesh closed and its winding', () => {
    // A unit square seen from the front (0, 1, 2, 3) with point 4 in the middle of its bottom side. The
    // mesher-style sliver (0, 4, 1) lies flat on that side; its neighbour across 1 -> 0 is (0, 1, 2).
    // A pyramid to apex 5 below the square closes the mesh.
    const P = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0, 0, 0.5, 0.5, -1];
    const tri = [0, 1, 2, 0, 2, 3, /* sliver */ 0, 4, 1, /* pyramid */ 4, 0, 5, 1, 4, 5, 2, 1, 5, 3, 2, 5, 0, 3, 5];
    const before = checkMesh(P, tri);
    expect([before.zeroAreaTriangles, before.openEdges, before.nonManifoldEdges, before.flippedEdges]).toEqual([1, 0, 0, 0]);
    expect(fixSlivers(P, tri)).toBe(1);
    const after = checkMesh(P, tri);
    expect([after.zeroAreaTriangles, after.openEdges, after.nonManifoldEdges, after.flippedEdges, after.pieces, after.throughHoles]).toEqual([0, 0, 0, 0, 1, 0]);
    expect(after.volume).toBeCloseTo(before.volume, 12);
    expect(after.volume).toBeGreaterThan(0);
    // The two new triangles face the same way as the old neighbour (+Z, counter-clockwise from the front).
    for (let t = 0; t < 9; t += 3) {
      const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]];
      const z = (P[3 * b] - P[3 * a]) * (P[3 * c + 1] - P[3 * a + 1]) - (P[3 * b + 1] - P[3 * a + 1]) * (P[3 * c] - P[3 * a]);
      expect(z).toBeGreaterThan(0);
    }
  });

  it('refuses a zero or negative tolerance instead of writing a broken file', () => {
    expect(() => stl(parts.plate, { linearDeflection: 0 })).toThrow();
    expect(() => stl(parts.plate, { angularDeflection: -1 })).toThrow();
  });
});

// ------------------------------------------------------------------ STEP

/** Minimal ISO 10303-21 reader: entity text by id (enough to check what other CAD will read). */
function parseStep(text: string) {
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
  const header = text.slice(text.indexOf('HEADER;'), text.indexOf('ENDSEC;'));
  const data = text.slice(text.indexOf('DATA;') + 5, text.lastIndexOf('ENDSEC;'));
  const ents = new Map<number, string>();
  // Entities end with ';' outside quotes.
  let q = false, start = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === "'") q = !q;
    else if (c === ';' && !q) {
      const e = data.slice(start, i).replace(/\s+/g, ' ').trim();
      start = i + 1;
      const m = /^#(\d+)\s*=\s*(.*)$/s.exec(e);
      if (m) ents.set(+m[1], m[2]);
    }
  }
  const ofType = (t: string) => [...ents.entries()].filter(([, e]) => e.startsWith(`${t}(`));
  return { header, ents, ofType };
}

/** Vertex coordinates as written in the file (file units). */
function stepVertices(s: ReturnType<typeof parseStep>) {
  return s.ofType('VERTEX_POINT').map(([, e]) => {
    const ref = +/#(\d+)\s*\)\s*$/.exec(e)![1];
    const pt = s.ents.get(ref)!;
    expect(pt.startsWith('CARTESIAN_POINT(')).toBe(true);
    return /\(([^()]*)\)\s*\)$/.exec(pt)![1].split(',').map(Number) as [number, number, number];
  });
}

/** The model's vertices in mm. */
function modelVertices(s: TopoDS_Shape) {
  const vs = listSubShapes(oc, s, 'TopAbs_VERTEX');
  const out = vs.map((v) => { const vx = oc.TopoDS.Vertex(v); const p = takeXyz(oc.BRep_Tool.Pnt(vx)); vx.delete(); return p; });
  freeAll(vs);
  return out;
}

describe('STEP export for CAD and CAM', () => {
  const step = (p: Part, unit: 'mm' | 'in', schema: 'AP214' | 'AP242' = 'AP214', name = p.name) => exportStepFile(oc, p.shape, { unit, schema, name, fileName: `${safeFileBase(name)}.step` });

  for (const key of ['plate', 'block', 'flange', 'ring', 'organic', 'arm']) {
    for (const unit of ['in', 'mm'] as const) {
      it(`${key} (${unit}): one valid closed solid that reads back with the same size, volume and topology`, () => {
        const p = parts[key];
        const { text, report } = step(p, unit);
        expect(report.problems).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.solids).toBe(1);

        // Text: schema, unit, product name, exactly one manifold solid, no surface-only bodies.
        const s = parseStep(text);
        expect(s.header).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'))");
        expect(s.header).toContain(`FILE_NAME(${stepString(`${safeFileBase(p.name)}.step`)}`);
        expect(s.header).toContain("'CHAD'");
        expect(s.ofType('MANIFOLD_SOLID_BREP').length + s.ofType('BREP_WITH_VOIDS').length).toBe(1);
        expect(s.ofType('SHELL_BASED_SURFACE_MODEL').length).toBe(0);
        expect(s.ofType('CLOSED_SHELL').length).toBe(1);
        expect(s.ofType('OPEN_SHELL').length).toBe(0);
        const products = s.ofType('PRODUCT');
        expect(products.length).toBe(1);
        expect(products[0][1].startsWith(`PRODUCT(${stepString(p.name)},${stepString(p.name)},`)).toBe(true);
        const units = [...s.ents.values()].filter((e) => e.includes('LENGTH_UNIT()'));
        if (unit === 'in') {
          expect(units.some((e) => /CONVERSION_BASED_UNIT\('INCH',#\d+\)/.test(e))).toBe(true);
          expect(s.ofType('LENGTH_MEASURE_WITH_UNIT').some(([, e]) => /^LENGTH_MEASURE_WITH_UNIT\(25\.4,#\d+\)$/.test(e) || /LENGTH_MEASURE\(25\.4\)/.test(e))).toBe(true);
        } else {
          expect(units.length).toBe(1);
          expect(units[0]).toContain('SI_UNIT(.MILLI.,.METRE.)');
        }
        // Vertex coordinates in the file, times the declared unit, are the model's vertices.
        const k = unit === 'in' ? IN : 1;
        const fileV = stepVertices(s).map((v) => v.map((x) => x * k));
        const modelV = modelVertices(p.shape);
        expect(fileV.length).toBe(report.vertices);
        for (const v of modelV) expect(Math.min(...fileV.map((w) => Math.hypot(w[0] - v[0], w[1] - v[1], w[2] - v[2])))).toBeLessThan(1e-9 * Math.max(1, Math.hypot(...v)) + 1e-9);

        // Read back with OpenCascade's STEP reader: same solid.
        const back = readStep(oc, text);
        try {
          expect(isValid(oc, back)).toBe(true);
          const a = massProperties(oc, p.shape), b = massProperties(oc, back);
          const v = p.volume ?? a.volume;
          expect(Math.abs(b.volume - v) / v).toBeLessThan(1e-6);
          expect(Math.abs(b.area - a.area) / a.area).toBeLessThan(1e-6);
          for (let i = 0; i < 3; i++) {
            expect(Math.abs(b.bboxMin[i] - a.bboxMin[i])).toBeLessThan(1e-6);
            expect(Math.abs(b.bboxMax[i] - a.bboxMax[i])).toBeLessThan(1e-6);
            if (p.box) { expect(Math.abs(b.bboxMin[i] - p.box.min[i])).toBeLessThan(1e-6); expect(Math.abs(b.bboxMax[i] - p.box.max[i])).toBeLessThan(1e-6); }
            expect(Math.abs(b.centroid[i] - a.centroid[i])).toBeLessThan(1e-6);
          }
          expect(report.readBack).toMatchObject({ solids: 1, valid: true, openEdges: 0 });
          if (p.faces) expect(report.faces).toBe(p.faces);
        } finally { back.delete(); }
      }, 120000);
    }
  }

  it('holes and the plate stay exact analytic geometry (cylinders and planes) for CAM', () => {
    const s = parseStep(step(parts.plate, 'in').text);
    expect(s.ofType('CYLINDRICAL_SURFACE').length).toBe(2);
    expect(s.ofType('PLANE').length).toBe(6);
    expect(s.ofType('B_SPLINE_SURFACE_WITH_KNOTS').length).toBe(0);
    // Hole radius in the file's unit (inches): exactly 0.125.
    for (const [, e] of s.ofType('CYLINDRICAL_SURFACE')) expect(Number(/,\s*([-\d.E+]+)\)$/.exec(e)![1])).toBeCloseTo(0.125, 12);
    for (const [, e] of s.ofType('CIRCLE')) expect(Number(/,\s*([-\d.E+]+)\)$/.exec(e)![1])).toBeCloseTo(0.125, 12);
  });

  it('AP242 is available too and reads back the same', () => {
    const p = parts.flange;
    const { text, report } = step(p, 'in', 'AP242');
    expect(report.problems).toEqual([]);
    expect(parseStep(text).header).toMatch(/FILE_SCHEMA\(\(\s*'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF \{\s*1 0 10303 442 1 1 4 \}'/);
    const back = readStep(oc, text);
    try { expect(Math.abs(massProperties(oc, back).volume - p.volume!) / p.volume!).toBeLessThan(1e-6); } finally { back.delete(); }
  });

  it('part names with quotes, slashes and non-English letters are written correctly', () => {
    const name = `Bracket 'A' 1/4" Ø6 — Rev 2`;
    const { text, report } = step(parts.plate, 'in', 'AP214', name);
    expect(report.problems).toEqual([]);
    const s = parseStep(text);
    const prod = s.ofType('PRODUCT')[0][1];
    // ISO 10303-21: ' doubled, non-ASCII as \X2\hhhh\X0\ (UTF-16).
    expect(prod.startsWith(`PRODUCT('Bracket ''A'' 1/4" \\X2\\00D8\\X0\\6 \\X2\\2014\\X0\\ Rev 2'`)).toBe(true);
    expect(s.header).toContain(`FILE_NAME('Bracket ''A'' 1_4_ \\X2\\00D8\\X0\\6 \\X2\\2014\\X0\\ Rev 2.step'`);
    // Still parses (the reader would fail on a broken string).
    const back = readStep(oc, text);
    back.delete();
  });
});

describe('export helpers', () => {
  it('makes file names that are safe on Windows', () => {
    expect(safeFileBase('Bracket')).toBe('Bracket');
    expect(safeFileBase('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeFileBase('  name.  ')).toBe('name');
    expect(safeFileBase('CON')).toBe('CON_part');
    expect(safeFileBase('')).toBe('Part');
    expect(safeFileBase('x'.repeat(300)).length).toBe(120);
  });
  it('writes ISO 10303-21 strings', () => {
    expect(stepString("it's")).toBe("'it''s'");
    expect(stepString('a\\b')).toBe("'a\\\\b'");
    expect(stepString('µm')).toBe("'\\X2\\00B5\\X0\\m'");
  });
});

