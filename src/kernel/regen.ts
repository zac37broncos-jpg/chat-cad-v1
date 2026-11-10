/**
 * Regeneration: turn the feature history into an exact B-rep solid using
 * OpenCascade. Runs in a Web Worker in the app and directly in Node tests.
 *
 * Nothing here approximates geometry: lines, circles and arcs become exact
 * OCCT curves, extrusions/revolutions are exact sweeps, and booleans are
 * OCCT's exact boolean operations.
 */
import { exactBox } from './bbox';
import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import type { CadDocument, SketchFeature, BasePlane, ExtrudeFeature, RevolveFeature } from '../core/model';
import { evalLength, evalAngle, type Quantity } from '../core/units';
import { resolveParams } from '../core/store';
import { type Named, nameShape, track, topology, indexShapes, listOf, type Topology } from './naming';
import { applyModelingFeature, type FeatureContext, type RefGeometry, type CapturedTool, refPlaneFrame } from './features';
import { extrudeTool, flipSideTool } from './extrude';
import { evalWorking, type WEntity } from '../sketch/geom';
import type { SketchSolver, SketchState } from '../sketch/solver';
import { splineCurve } from '../sketch/geom';
import { knotsAndMults, sampleSpline, closestOnSpline, splineBounds } from '../sketch/spline';
import { thinLoops } from './features/thin';
import { own, free, freeAll, takeXyz, beginLedger, endLedger, namedObjects, freeExcept } from './mem';

export type OC = OpenCascadeInstance;

/** Points closer than this (mm) are treated as the same sketch point. */
export const SKETCH_POINT_TOL = 1e-6;

export interface Extent { min: [number, number, number]; max: [number, number, number] }
/**
 * Per-feature rebuild result. `extent` (mm, world axes) says where a feature
 * is and how big it is, so a user or the AI can refer to it by name
 * ("make the left wing longer"): sketches = their non-construction geometry,
 * bosses = the added body, cuts = the cut tool clipped to the body it cuts.
 * `sketch`: sketches with constraints, their solve state.
 */
export interface FeatureStatus { id: string; ok: boolean; message?: string; extent?: Extent; sketch?: { state: SketchState; dof: number } }

export interface RegenResult {
  shape: TopoDS_Shape | null;
  /** Present when RegenOptions.captureToolFor was given. */
  tool?: TopoDS_Shape | null;
  status: FeatureStatus[];
  /** Evaluated sketch geometry in 3D, for drawing sketches in the viewport. */
  sketches: SketchGeometry[];
  /** The solid with its face names (topological naming), for features that reference faces/edges. */
  named?: Named | null;
  /** Face names and edge adjacency by index (matches listSubShapes), for UI picks and the AI. */
  topology?: Topology | null;
  /** Evaluated reference planes / axes / points, for display and picking. */
  refGeometry?: RefGeometry[];
}

export interface Frame { o: [number, number, number]; x: [number, number, number]; y: [number, number, number]; n: [number, number, number] }

/** Sketch frame for a sketch feature: a base plane (with offset) or an explicit face frame. */
export function sketchFrame(sk: SketchFeature, offsetMM: number): Frame {
  if (sk.plane !== 'face') return planeFrame(sk.plane, offsetMM);
  if (!sk.frame) throw new Error('Sketch on a face is missing its plane');
  const { origin: o0, xDir: x, normal: n } = sk.frame;
  const y: [number, number, number] = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
  const o: [number, number, number] = [o0[0] + n[0] * offsetMM, o0[1] + n[1] * offsetMM, o0[2] + n[2] * offsetMM];
  return { o, x, y, n };
}

export function planeFrame(plane: BasePlane, offset = 0): Frame {
  // Z-up convention. "Front" = XZ (normal -Y), "Top" = XY, "Right" = YZ.
  switch (plane) {
    case 'XY': return { o: [0, 0, offset], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };
    case 'XZ': return { o: [0, -offset, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] };
    case 'YZ': return { o: [offset, 0, 0], x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] };
  }
}

export function to3d(fr: Frame, u: number, v: number): [number, number, number] {
  return [
    fr.o[0] + fr.x[0] * u + fr.y[0] * v,
    fr.o[1] + fr.x[1] * u + fr.y[1] * v,
    fr.o[2] + fr.x[2] * u + fr.y[2] * v,
  ];
}

type P2 = [number, number];

/** A sketch entity with all expressions evaluated to mm / radians (see src/sketch/geom.ts). */
export type EvalEntity = WEntity;

export interface SketchGeometry { id: string; frame: Frame; entities: EvalEntity[]; loops: number }

/**
 * Evaluate a sketch to exact numbers. A sketch with constraints is solved
 * (planegcs) from its stored positions using current parameter values;
 * a sketch that cannot be solved exactly is an error, never approximated.
 */
export function evalSketch(sk: SketchFeature, doc: CadDocument, params: Record<string, Quantity>, solver?: SketchSolver): { frame: Frame; entities: EvalEntity[]; solve?: { state: SketchState; dof: number } } {
  const L = (v: string | number) => evalLength(v, doc.units, params);
  const frame = sketchFrame(sk, sk.offset !== undefined ? L(sk.offset) : 0);
  const ws = evalWorking(sk, doc.units, params);
  let entities = ws.entities;
  let solve: { state: SketchState; dof: number } | undefined;
  if (sk.constraints?.length) {
    if (!solver) throw new Error('The sketch solver is not loaded');
    const st = solver.status(ws);
    if (!st.result.ok) throw new Error(`Sketch could not be solved: ${st.result.message}`);
    entities = st.result.entities;
    solve = { state: st.status.state, dof: st.status.dof };
  }
  for (const e of entities) {
    if (e.kind === 'line' && dist(e.a, e.b) < SKETCH_POINT_TOL) throw new Error(`Line ${e.id} has zero length`);
    if ((e.kind === 'circle' || e.kind === 'arc') && !(e.r > 0)) throw new Error(`${e.kind === 'circle' ? 'Circle' : 'Arc'} radius must be > 0`);
    if (e.kind === 'spline') {
      try { splineCurve(e); } catch (err) { throw new Error(`Spline ${e.id}: ${(err as Error).message}`); }
    }
  }
  return { frame, entities, ...(solve ? { solve } : {}) };
}

const dist = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);

function arcEnds(e: Extract<EvalEntity, { kind: 'arc' }>): [P2, P2] {
  return [
    [e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)],
    [e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)],
  ];
}

/** End points of an open curve (line, arc, open spline). */
export function curveEnds(e: EvalEntity): [P2, P2] | null {
  if (e.kind === 'line') return [e.a, e.b];
  if (e.kind === 'arc') return arcEnds(e);
  if (e.kind === 'spline' && !e.closed) return [e.pts[0], e.pts[e.pts.length - 1]];
  return null;
}

/** A closed loop of entities, plus a polygon approximation used ONLY for inside/outside tests. */
export interface Loop { entities: EvalEntity[]; poly: P2[]; area: number }

/** Find closed profiles among non-construction entities. Throws on open or branching geometry. */
export function findLoops(entities: EvalEntity[]): Loop[] {
  const loops: Loop[] = [];
  const open: { e: EvalEntity; ends: [P2, P2] }[] = [];
  for (const e of entities) {
    if (e.construction || e.kind === 'point') continue;
    if (e.kind === 'circle') {
      const poly: P2[] = [];
      for (let i = 0; i < 64; i++) { const t = (i / 64) * 2 * Math.PI; poly.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]); }
      loops.push({ entities: [e], poly, area: Math.PI * e.r * e.r });
    } else if (e.kind === 'spline' && e.closed) {
      const poly = sampleSpline(splineCurve(e), 16);
      poly.pop(); // last sample repeats the first
      loops.push({ entities: [e], poly, area: Math.abs(polyArea(poly)) });
    } else {
      open.push({ e, ends: curveEnds(e)! });
    }
  }
  const used = new Set<number>();
  for (let start = 0; start < open.length; start++) {
    if (used.has(start)) continue;
    used.add(start);
    const chain = [open[start]];
    const first = open[start].ends[0];
    let cur = open[start].ends[1];
    const poly: P2[] = [first, ...samplePts(open[start].e, false)];
    while (dist(cur, first) > SKETCH_POINT_TOL) {
      let found = -1; let flip = false;
      for (let j = 0; j < open.length; j++) {
        if (used.has(j)) continue;
        if (dist(open[j].ends[0], cur) <= SKETCH_POINT_TOL) { found = j; flip = false; break; }
        if (dist(open[j].ends[1], cur) <= SKETCH_POINT_TOL) { found = j; flip = true; break; }
      }
      if (found < 0) throw new Error(`Sketch profile is not closed near (${cur[0].toFixed(4)}, ${cur[1].toFixed(4)}) mm`);
      used.add(found);
      chain.push(open[found]);
      poly.push(...samplePts(open[found].e, flip));
      cur = flip ? open[found].ends[0] : open[found].ends[1];
    }
    loops.push({ entities: chain.map((c) => c.e), poly, area: Math.abs(polyArea(poly)) });
  }
  return loops;
}

function samplePts(e: EvalEntity, reversed: boolean): P2[] {
  if (e.kind === 'line') return [reversed ? e.a : e.b];
  if (e.kind === 'spline') {
    const pts = sampleSpline(splineCurve(e), 16);
    if (reversed) pts.reverse();
    pts.shift();
    return pts;
  }
  if (e.kind === 'arc') {
    let a0 = e.a0, a1 = e.a1;
    while (a1 <= a0) a1 += 2 * Math.PI;
    const pts: P2[] = [];
    for (let i = 1; i <= 32; i++) { const t = a0 + ((a1 - a0) * i) / 32; pts.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]); }
    if (reversed) { pts.reverse(); pts.shift(); pts.push([e.c[0] + e.r * Math.cos(a0), e.c[1] + e.r * Math.sin(a0)]); }
    return pts;
  }
  return [];
}

function polyArea(p: P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

function pointInPoly(pt: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Nesting depth of each loop (0 = outermost). Even depth = material, odd = hole. */
export function loopDepths(loops: Loop[]): number[] {
  return loops.map((L, i) => {
    // Use the centroid of a small interior sample: average of polygon vertices is fine for convex-ish; fall back to first vertex.
    const probe = interiorProbe(L.poly);
    let d = 0;
    loops.forEach((M, j) => { if (j !== i && M.area > L.area && pointInPoly(probe, M.poly)) d++; });
    return d;
  });
}

function interiorProbe(poly: P2[]): P2 {
  // A point just inside the loop near its first vertex, robust for non-convex loops.
  const c: P2 = poly.reduce<P2>((acc, p) => [acc[0] + p[0] / poly.length, acc[1] + p[1] / poly.length], [0, 0]);
  if (pointInPoly(c, poly)) return c;
  const a = poly[0], b = poly[1];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const nx = -(b[1] - a[1]), ny = b[0] - a[0];
  const len = Math.hypot(nx, ny) || 1;
  for (const s of [1e-4, -1e-4]) { const q: P2 = [mx + (s * nx) / len, my + (s * ny) / len]; if (pointInPoly(q, poly)) return q; }
  return a;
}

// ------------------------------------------------------------------ OCCT

export class Gc { private items: { delete(): void }[] = []; t<T extends { delete(): void }>(o: T): T { this.items.push(o); return o; } free() { freeAll(this.items); this.items = []; } }

export function pnt(oc: OC, p: [number, number, number]) { return new oc.gp_Pnt(p[0], p[1], p[2]); }
export function dir(oc: OC, p: [number, number, number]) { return new oc.gp_Dir(p[0], p[1], p[2]); }

export function loopWire(oc: OC, gc: Gc, fr: Frame, loop: Loop): any {
  const mw = gc.t(new oc.BRepBuilderAPI_MakeWire());
  const ax2 = (c: P2) => gc.t(new oc.gp_Ax2(gc.t(pnt(oc, to3d(fr, c[0], c[1]))), gc.t(dir(oc, fr.n)), gc.t(dir(oc, fr.x))));
  for (const e of loop.entities) {
    let edge: any;
    if (e.kind === 'line') {
      edge = gc.t(new oc.BRepBuilderAPI_MakeEdge(gc.t(pnt(oc, to3d(fr, ...e.a))), gc.t(pnt(oc, to3d(fr, ...e.b)))));
    } else if (e.kind === 'circle') {
      edge = gc.t(new oc.BRepBuilderAPI_MakeEdge(gc.t(new oc.gp_Circ(ax2(e.c), e.r))));
    } else if (e.kind === 'arc') {
      let a1 = e.a1; while (a1 <= e.a0) a1 += 2 * Math.PI;
      edge = gc.t(new oc.BRepBuilderAPI_MakeEdge(gc.t(new oc.gp_Circ(ax2(e.c), e.r)), e.a0, a1));
    } else if (e.kind === 'spline') {
      edge = gc.t(new oc.BRepBuilderAPI_MakeEdge(splineGeom(oc, gc, fr, e)));
    } else {
      throw new Error('A sketch point cannot be part of a profile');
    }
    if (!edge.IsDone()) throw new Error(`Could not build edge for ${e.id}`);
    const ed = edge.Edge();
    mw.Add(ed);
    ed.delete();
    if (!mw.IsDone()) throw new Error(`Sketch edges do not connect into a wire (at ${e.id})`);
  }
  return gc.t(mw.Wire());
}

/**
 * The exact 3D B-spline of a sketch spline: the 2D poles mapped onto the
 * sketch plane (an affine map, so the curve is the same curve).
 */
export function splineGeom(oc: OC, gc: Gc, fr: Frame, e: Extract<EvalEntity, { kind: 'spline' }>): any {
  const c = splineCurve(e);
  const P = gc.t(new oc.NCollection_Array1_gp_Pnt(1, c.poles.length));
  c.poles.forEach((p, i) => P.SetValue(i + 1, gc.t(pnt(oc, to3d(fr, p[0], p[1])))));
  const { knots, mults } = knotsAndMults(c);
  const K = gc.t(new oc.NCollection_Array1_double(1, knots.length));
  knots.forEach((k, i) => K.SetValue(i + 1, k));
  const M = gc.t(new oc.NCollection_Array1_int(1, mults.length));
  mults.forEach((m, i) => M.SetValue(i + 1, m));
  return new oc.Geom_BSplineCurve(P, K, M, c.degree, false);
}

export function loopFace(oc: OC, gc: Gc, fr: Frame, loop: Loop): TopoDS_Shape {
  const w = loopWire(oc, gc, fr, loop);
  const mf = gc.t(new oc.BRepBuilderAPI_MakeFace(w, true));
  if (!mf.IsDone()) throw new Error('Could not build a planar face from the profile');
  return gc.t(mf.Face());
}

export function checkDone(op: any, what: string) {
  if (op.HasErrors && op.HasErrors()) throw new Error(`${what} failed in the geometry kernel`);
  if (op.IsDone && !op.IsDone()) throw new Error(`${what} failed in the geometry kernel`);
}

/** A plain boolean (no face names). The caller deletes the result. */
function plainBool(oc: OC, kind: 'fuse' | 'cut' | 'common', a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const pr = new oc.Message_ProgressRange();
  const op = kind === 'fuse' ? new oc.BRepAlgoAPI_Fuse(a, b, pr) : kind === 'cut' ? new oc.BRepAlgoAPI_Cut(a, b, pr) : new oc.BRepAlgoAPI_Common(a, b, pr);
  try {
    checkDone(op, kind === 'fuse' ? 'Union' : kind === 'cut' ? 'Cut' : 'Intersection');
    return op.Shape();
  } finally { free(op, pr); }
}
export function fuse(oc: OC, a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape { return plainBool(oc, 'fuse', a, b); }
export function cut(oc: OC, a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape { return plainBool(oc, 'cut', a, b); }
/** Shared volume of two solids (used to show only the material a cut removes). */
export function common(oc: OC, a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape { return plainBool(oc, 'common', a, b); }

/** Merge coplanar faces / collinear edges left by booleans, so the model stays clean. */
export function unify(oc: OC, s: TopoDS_Shape): TopoDS_Shape {
  const u = new oc.ShapeUpgrade_UnifySameDomain(s, true, true, false);
  u.Build();
  const out = u.Shape();
  u.delete();
  return out;
}

export function isValid(oc: OC, s: TopoDS_Shape): boolean {
  const a = new oc.BRepCheck_Analyzer(s, true, false, false);
  try {
    return a.IsValid(s);
  } finally {
    // The analyzer's destructor is empty in these bindings (see mem.ts): re-aiming it at an empty
    // compound drops its per-sub-shape results (~50 KB on a small part) before it is deleted.
    const c = new oc.TopoDS_Compound(); const b = new oc.TopoDS_Builder();
    b.MakeCompound(c); a.Init(c, false);
    free(b, c, a);
  }
}

/**
 * Boolean with face-name tracking. The result is simplified (coplanar faces
 * merged, like UnifySameDomain) inside the same operation, so its history
 * stays complete.
 */
export function trackedBool(oc: OC, kind: 'fuse' | 'cut' | 'common', a: Named, b: Named, fid: string): Named {
  const pr = new oc.Message_ProgressRange();
  const op = kind === 'fuse' ? new oc.BRepAlgoAPI_Fuse(a.shape, b.shape, pr) : kind === 'cut' ? new oc.BRepAlgoAPI_Cut(a.shape, b.shape, pr) : new oc.BRepAlgoAPI_Common(a.shape, b.shape, pr);
  try {
    checkDone(op, kind === 'fuse' ? 'Union' : kind === 'cut' ? 'Cut' : 'Intersection');
    op.SimplifyResult(true, true, 1e-9);
    return track(oc, op, [a, b], op.Shape(), fid);
  } finally { free(op, pr); }
}

/**
 * The kernel finished a boolean but the result is wrong (a known OpenCascade
 * weakness, e.g. two organic surfaces whose seams meet on the intersection):
 * pieces left unjoined, or a body / cut silently dropped. Features that can
 * rebuild their tool another way (lofts: another seam) catch this and retry.
 */
export class BooleanFailure extends Error {}

export function countSolids(oc: OC, s: TopoDS_Shape): number {
  let n = 0;
  const ex = new oc.TopExp_Explorer(s, (oc.TopAbs_ShapeEnum as any).TopAbs_SOLID, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) n++;
  ex.delete();
  return n;
}

export function countShells(oc: OC, s: TopoDS_Shape): number {
  let n = 0;
  const ex = new oc.TopExp_Explorer(s, (oc.TopAbs_ShapeEnum as any).TopAbs_SHELL, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) n++;
  ex.delete();
  return n;
}

/**
 * Edges of the skin not shared by exactly two face uses (a seam counts as two
 * uses of its own face; degenerate pole edges are skipped). 0 = closed skin.
 */
export function freeEdgeCount(oc: OC, s: TopoDS_Shape): number {
  const edges = indexShapes(oc, s, 'TopAbs_EDGE').list;
  const uses = edges.map(() => 0);
  const fx = new oc.TopExp_Explorer(s, (oc.TopAbs_ShapeEnum as any).TopAbs_FACE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  const seenFaces: TopoDS_Shape[] = [];
  for (; fx.More(); fx.Next()) {
    const f = fx.Current();
    if (seenFaces.some((g) => g.IsSame(f))) { f.delete(); continue; }
    seenFaces.push(f);
    const ex = new oc.TopExp_Explorer(f, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) { const c = ex.Current(); const i = edges.findIndex((e) => e.IsSame(c)); if (i >= 0) uses[i]++; c.delete(); }
    ex.delete();
  }
  fx.delete();
  let n = 0;
  edges.forEach((e, i) => { const ed = oc.TopoDS.Edge(e); if (!(oc.BRep_Tool as any).Degenerated(ed) && uses[i] !== 2) n++; ed.delete(); });
  for (const x of [...edges, ...seenFaces]) x.delete();
  return n;
}

/** Smallest distance between two shapes (0 when they touch or overlap). */
export function shapeDistance(oc: OC, a: TopoDS_Shape, b: TopoDS_Shape): number {
  const pr = new oc.Message_ProgressRange();
  const d = new oc.BRepExtrema_DistShapeShape(a, b, (oc as any).Extrema_ExtFlag?.Extrema_ExtFlag_MIN, (oc as any).Extrema_ExtAlgo?.Extrema_ExtAlgo_Grad, pr);
  const v = d.IsDone() ? d.Value() : Infinity;
  d.delete(); pr.delete();
  return v;
}

/**
 * Volume by exact B-rep integration. The plain adaptive integration is fast but on large organic
 * bodies can be off by several 1e-4 of the volume; `precise` uses Gauss-Kronrod (about 1e-5,
 * a few seconds on a whole figurine).
 */
export function exactVolume(oc: OC, s: TopoDS_Shape, precise = false): number {
  const p = new oc.GProp_GProps();
  if (precise) oc.BRepGProp.VolumePropertiesGK(s, p, 1e-6, false, true, false, false, false);
  else oc.BRepGProp.VolumeProperties(s, p, 1e-6, false, false);
  const v = p.Mass();
  p.delete();
  return v;
}

/** Gauss-Kronrod volume of a set of faces against a fixed plane (comparable between calls, unlike the per-call reference point of the whole-shape integrations). */
function planeVolume(oc: OC, s: TopoDS_Shape, pln: any, eps: number): number {
  const p = new oc.GProp_GProps();
  oc.BRepGProp.VolumePropertiesGK(s, p, pln, eps, false, true, false, false, false);
  const v = p.Mass();
  p.delete();
  return v;
}

/**
 * How much volume `after` gained over `before` (negative when it lost some), integrating only the
 * faces that differ: faces the two share cancel exactly, so the result is as accurate as the
 * changed region, not the whole body (whole-body integration of a big organic part is noisier than
 * a small feature's volume). `magnitude` is the size of the integrals, for the tolerance: at the
 * default `eps` the error is up to about 1e-5 of it, at 1e-8 a few 1e-7.
 */
export function volumeChange(oc: OC, before: TopoDS_Shape, after: TopoDS_Shape, near: TopoDS_Shape, eps = 1e-6): { dv: number; magnitude: number } {
  const fa = indexShapes(oc, after, 'TopAbs_FACE').list, fb = indexShapes(oc, before, 'TopAbs_FACE').list;
  const builder = new oc.TopoDS_Builder();
  const only = (xs: TopoDS_Shape[], ys: TopoDS_Shape[]) => {
    const c = new oc.TopoDS_Compound();
    builder.MakeCompound(c);
    for (const f of xs) if (!ys.some((g) => g.IsEqual(f))) builder.Add(c, f);
    return c;
  };
  const added = only(fa, fb), removed = only(fb, fa);
  const { center } = bboxInfo(oc, near);
  const o = new oc.gp_Pnt(center[0], center[1], center[2]), z = new oc.gp_Dir(0, 0, 1);
  const pln = new oc.gp_Pln(o, z);
  const va = planeVolume(oc, added, pln, eps), vr = planeVolume(oc, removed, pln, eps);
  for (const x of [...fa, ...fb, added, removed, o, z, pln, builder]) x.delete();
  return { dv: va - vr, magnitude: Math.abs(va) + Math.abs(vr) };
}

/**
 * Second witness for checkedBool's volume test, used only when the first one disagrees: the change
 * of the whole body's volume (Gauss-Kronrod at 1e-9). The first witness integrates only the faces
 * that changed against one plane, which is usually the more accurate; but where the tool meets the
 * body at a singular point (a dome's pole, a pointed tip) it was measured 0.45% of the change off
 * on a correct result (a horn joined at the top of a torso: the boolean was right by whole-body
 * integration and by a fine mesh, both within 0.1 mm^3), which made correct models fail at random
 * (the loft seam, which moves the singular point, came from the feature's random id then).
 * The whole-body witness only counts when it is decisive: its tolerance must stay below 2% of the
 * tool's volume, so a real failure (seen: 8% to several times the tool's volume) is still caught.
 */
export function wholeBodyAgrees(oc: OC, before: TopoDS_Shape, after: TopoDS_Shape, vt: number, expected: number): boolean {
  const gk = (s: TopoDS_Shape) => {
    const p = new oc.GProp_GProps();
    oc.BRepGProp.VolumePropertiesGK(s, p, 1e-9, false, true, false, false, false);
    const v = p.Mass();
    p.delete();
    return v;
  };
  const vb = gk(before), va = gk(after);
  const tol = 1e-3 * Math.abs(vt) + 2e-6 * (Math.abs(vb) + Math.abs(va)) + 1e-6;
  if (!(tol < 0.02 * Math.abs(vt))) return false;
  return Math.abs(va - vb - expected) <= tol;
}

/** Notes from checkedBool for the feature being built (separate bodies, hidden hollows), shown on its status. */
let boolNotes: string[] | null = null;

/**
 * trackedBool on the part body, with the result checked so a part never
 * silently comes out wrong (OpenCascade sometimes returns a wrong boolean
 * without an error, e.g. when two organic surfaces' seams or a dome's pole
 * meet the intersection):
 *  - the volume the operation added (or removed) must equal the tool's volume
 *    outside (or inside) the body, measured by a separate intersection;
 *  - extra solids only where a piece really does not touch the body;
 *  - no hole in the skin (an edge with only one face).
 * Separate bodies and hidden hollows are valid modelling (as in mainstream CAD)
 * but not a part to print or machine: they become notes on the feature.
 * Kernel failures throw BooleanFailure (features that can rebuild their tool
 * another way retry).
 * `what` names the feature in messages.
 */
export function checkedBool(oc: OC, kind: 'fuse' | 'cut', body: Named, tool: Named, fid: string, what = 'This feature'): Named {
  const out = trackedBool(oc, kind, body, tool, fid);
  const nb = countSolids(oc, body.shape), no = countSolids(oc, out.shape);
  const fail = () => new BooleanFailure(`${what}: the geometry kernel could not ${kind === 'fuse' ? 'join it to' : 'cut'} the part cleanly`);
  if (kind === 'fuse' && no > nb) {
    // Separate bodies are allowed (multibody modelling), but only for pieces that really do not touch.
    const pieces = indexShapes(oc, tool.shape, 'TopAbs_SOLID').list;
    const loose = pieces.filter((p) => shapeDistance(oc, body.shape, p) > 1e-4).length;
    for (const p of pieces) p.delete();
    if (no - nb > loose) throw fail();
    boolNotes?.push(`${what} does not touch the part, so it is a separate body (the part is now ${no} bodies). A part to print or machine must be one solid: move or size it to overlap the body.`);
  }
  // A result with a hole in its skin (an edge left with one face) is never right, even when BRepCheck passes.
  if (freeEdgeCount(oc, out.shape) > freeEdgeCount(oc, body.shape)) throw fail();
  if (kind === 'cut' && no > nb) boolNotes?.push(`${what} cuts the part into ${no} separate bodies. A part to print or machine must be one solid: make the cut shallower or smaller.`);
  if (kind === 'cut' && countShells(oc, out.shape) > countShells(oc, body.shape)) boolNotes?.push(`${what} lies completely inside the part, so it leaves a hidden hollow inside. For a part to print or machine, move it out to the surface so it cuts in from outside (for a groove, put its center line on or just under the surface).`);
  const vt = exactVolume(oc, tool.shape, true);
  // The tool's volume inside the body, from a separate intersection: the witness for the change.
  const cpr = new oc.Message_ProgressRange();
  const op = new oc.BRepAlgoAPI_Common(body.shape, tool.shape, cpr);
  if (op.HasErrors()) { free(op, cpr); throw fail(); }
  const both = op.Shape();
  const overlap = exactVolume(oc, both, true);
  free(both, op, cpr);
  const expected = kind === 'fuse' ? vt - overlap : -overlap;
  // A tool that really changed the body leaves some of its own faces in the result.
  const toolTags = new Set(tool.tags.flat());
  const toolFacesLeft = out.tags.some((t) => t.some((x) => toolTags.has(x)));
  const changes = kind === 'fuse' ? vt - overlap : overlap;
  if (changes > 1e-3 * Math.abs(vt) + 1e-9 && !toolFacesLeft) throw fail();
  // The body's change must match: real failures lose or keep whole pieces (seen: 8% to several
  // times the tool's volume). A near miss is measured again more precisely before it counts.
  let { dv, magnitude } = volumeChange(oc, body.shape, out.shape, tool.shape);
  const tol = () => 1e-3 * Math.abs(vt) + 2e-6 * magnitude + 1e-6;
  if (Math.abs(dv - expected) > tol()) ({ dv, magnitude } = volumeChange(oc, body.shape, out.shape, tool.shape, 1e-8));
  if (Math.abs(dv - expected) > tol() && !wholeBodyAgrees(oc, body.shape, out.shape, vt, expected)) throw fail();
  return out;
}

/** Which sketch entity a profile edge came from (by exact geometry: the edge midpoint lies on it). */
export function entityForEdge(oc: OC, fr: Frame, loop: Loop, edge: TopoDS_Shape): string | undefined {
  const ed = oc.TopoDS.Edge(edge);
  const ad = new oc.BRepAdaptor_Curve(ed);
  const p = ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2);
  const d = [p.X() - fr.o[0], p.Y() - fr.o[1], p.Z() - fr.o[2]];
  ad.delete(); p.delete(); ed.delete();
  const u = d[0] * fr.x[0] + d[1] * fr.x[1] + d[2] * fr.x[2];
  const v = d[0] * fr.y[0] + d[1] * fr.y[1] + d[2] * fr.y[2];
  let best: string | undefined; let bestD = Infinity;
  for (const e of loop.entities) {
    let dd = Infinity;
    if (e.kind === 'line') {
      const ax = e.b[0] - e.a[0], ay = e.b[1] - e.a[1];
      const t = Math.max(0, Math.min(1, ((u - e.a[0]) * ax + (v - e.a[1]) * ay) / (ax * ax + ay * ay)));
      dd = Math.hypot(u - (e.a[0] + t * ax), v - (e.a[1] + t * ay));
    } else if (e.kind === 'circle' || e.kind === 'arc') {
      dd = Math.abs(Math.hypot(u - e.c[0], v - e.c[1]) - e.r);
    } else if (e.kind === 'spline') {
      dd = closestOnSpline(splineCurve(e), [u, v]).dist;
    }
    if (dd < bestD) { bestD = dd; best = e.id; }
  }
  return bestD < 1e-4 ? best : undefined;
}

/**
 * What a sweep of one profile face returns: the solid plus its history (to name faces).
 * `generated` results, `first` and `last` are new shape objects that sweepRegion deletes.
 */
export interface SweepResult { shape: TopoDS_Shape; generated: (s: TopoDS_Shape) => TopoDS_Shape[]; first?: TopoDS_Shape | null; last?: TopoDS_Shape | null }

/**
 * Profile region (with holes) swept by `sweep`, combining loops by nesting
 * depth. Faces are named `${fid}:side:<entity id>` (swept from that sketch
 * entity), `${fid}:start` and `${fid}:end` (caps).
 */
export function sweepRegion(oc: OC, gc: Gc, fr: Frame, loops: Loop[], sweep: (face: TopoDS_Shape) => SweepResult, fid: string): Named {
  if (loops.length === 0) throw new Error('Sketch has no closed profile');
  const depths = loopDepths(loops);
  const maxD = Math.max(...depths);
  const sweepLoop = (L: Loop): Named => {
    const face = loopFace(oc, gc, fr, L);
    const r = sweep(face);
    const sideOf = new Map<number, string>();
    const n = nameShape(oc, r.shape, () => []);
    const ex = new oc.TopExp_Explorer(face, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
      const e = ex.Current();
      const ent = entityForEdge(oc, fr, L, e) ?? 'edge';
      const gens = r.generated(e);
      for (const g of gens) { const i = n.faces.findIndex((x) => x.IsSame(g)); if (i >= 0) sideOf.set(i, ent); }
      freeAll(gens); e.delete();
    }
    ex.delete();
    n.faces.forEach((f, i) => {
      if (sideOf.has(i)) n.tags[i].push(`${fid}:side:${sideOf.get(i)}`);
      else if (r.first && !r.first.IsNull() && f.IsSame(r.first)) n.tags[i].push(`${fid}:start`);
      else if (r.last && !r.last.IsNull() && f.IsSame(r.last)) n.tags[i].push(`${fid}:end`);
      else n.tags[i].push(`${fid}:face${i}`);
    });
    free(r.first, r.last);
    return n;
  };
  let result: Named | null = null;
  for (let d = 0; d <= maxD; d++) {
    let level: Named | null = null;
    loops.forEach((L, i) => { if (depths[i] === d) { const s = sweepLoop(L); level = level ? trackedBool(oc, 'fuse', level, s, fid) : s; } });
    if (!level) continue;
    result = result === null ? level : trackedBool(oc, d % 2 === 0 ? 'fuse' : 'cut', result, level, fid);
  }
  return result!;
}

/** The sweep callback for a prism or revolution (both expose Generated / FirstShape / LastShape). */
export function sweepHistory(oc: OC, op: any): SweepResult {
  return {
    shape: op.Shape(),
    generated: (s) => { try { return listOfShapes(oc, op.Generated(s)); } catch { return []; } },
    first: (() => { try { return op.FirstShape(); } catch { return null; } })(),
    last: (() => { try { return op.LastShape(); } catch { return null; } })(),
  };
}

function listOfShapes(oc: OC, l: unknown): TopoDS_Shape[] { return listOf(oc, l); }

export function bboxInfo(oc: OC, s: TopoDS_Shape): { diagonal: number; center: [number, number, number] } {
  const b = new oc.Bnd_Box();
  oc.BRepBndLib.Add(s, b, false);
  const lo = takeXyz(b.CornerMin()), hi = takeXyz(b.CornerMax());
  const out = {
    diagonal: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
    center: [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2] as [number, number, number],
  };
  b.delete();
  return out;
}

/** Exact axis-aligned box of a shape, in mm (checked on free-form faces: ./bbox.ts). */
function shapeExtent(oc: OC, s: TopoDS_Shape): Extent {
  return exactBox(oc, s);
}

function clipExtent(a: Extent, b: Extent): Extent | undefined {
  const min = a.min.map((v, i) => Math.max(v, b.min[i])) as Extent['min'];
  const max = a.max.map((v, i) => Math.min(v, b.max[i])) as Extent['max'];
  return min.every((v, i) => v <= max[i]) ? { min, max } : undefined;
}

/** Exact box of a sketch's real (non-construction) geometry in world coordinates. */
/**
 * Extent of a modelling feature: its tool body (clipped to the part for cuts),
 * or for in-place features (fillet, chamfer, shell, draft) the faces it made.
 */
function modelingExtent(oc: OC, fid: string, tool: Named | null, before: Named | null, after: Named | null): Extent | undefined {
  try {
    if (tool) {
      const e = shapeExtent(oc, tool.shape);
      return before ? clipExtent(e, shapeExtent(oc, before.shape)) ?? e : e;
    }
    if (!after) return undefined;
    const mine = after.faces.filter((_, i) => after.tags[i].some((t) => t.startsWith(`${fid}:`)));
    if (!mine.length) return undefined;
    const b = new oc.Bnd_Box();
    for (const f of mine) oc.BRepBndLib.Add(f, b, false);
    const e: Extent = { min: takeXyz(b.CornerMin()), max: takeXyz(b.CornerMax()) };
    b.delete();
    return e;
  } catch { return undefined; }
}

export function sketchExtent(frame: Frame, entities: EvalEntity[]): Extent | undefined {
  const pts: P2[] = [];
  for (const e of entities) {
    if (e.construction || e.kind === 'point') continue; // sketch points are reference only
    if (e.kind === 'line') { pts.push(e.a, e.b); continue; }
    if (e.kind === 'circle') { pts.push([e.c[0] - e.r, e.c[1]], [e.c[0] + e.r, e.c[1]], [e.c[0], e.c[1] - e.r], [e.c[0], e.c[1] + e.r]); continue; }
    if (e.kind === 'spline') { const b = splineBounds(splineCurve(e)); pts.push(b.min, b.max, [b.min[0], b.max[1]], [b.max[0], b.min[1]]); continue; }
    pts.push(...arcEnds(e));
    // Axis extremes (0, 90, 180, 270 degrees) that fall inside the counter-clockwise sweep.
    let a1 = e.a1; while (a1 <= e.a0) a1 += 2 * Math.PI;
    for (let k = Math.ceil(e.a0 / (Math.PI / 2)); k * (Math.PI / 2) < a1; k++) {
      const t = k * (Math.PI / 2);
      pts.push([e.c[0] + e.r * Math.round(Math.cos(t)), e.c[1] + e.r * Math.round(Math.sin(t))]);
    }
  }
  if (!pts.length) return undefined;
  const w = pts.map(([u, v]) => to3d(frame, u, v));
  return {
    min: [0, 1, 2].map((i) => Math.min(...w.map((p) => p[i]))) as Extent['min'],
    max: [0, 1, 2].map((i) => Math.max(...w.map((p) => p[i]))) as Extent['max'],
  };
}

export interface RegenOptions {
  /** Also return the tool body (the swept solid before the boolean) of this feature, for previews. */
  captureToolFor?: string;
  /** Set false to skip computing the topology summary (faster previews). */
  topology?: boolean;
  /** planegcs solver for sketches with constraints (required when any sketch has them). */
  solver?: SketchSolver;
  /**
   * Reuse the results of the previous regeneration for the unchanged start of
   * the history (same units, parameters and features up to the first change).
   * Adding a feature then only computes that feature. Off for previews that
   * capture a tool body.
   */
  cache?: boolean;
}

/** State of a regeneration right after one feature (everything later features read). */
interface Snap {
  body: Named | null;
  status: FeatureStatus[];
  sketches: SketchGeometry[];
  evalSketches: Map<string, { frame: Frame; entities: EvalEntity[]; loops: Loop[] }>;
  tools: Map<string, CapturedTool>;
  refGeometry: RefGeometry[];
}
/** The last cached history: exact JSON of the inputs, and the state after each feature. */
let historyCache: { oc: OC; base: string; feats: string[]; snaps: Snap[] } | null = null;
/** The shape objects the history cache holds (it owns them: see ./mem.ts, rule 2). */
let cacheOwned: { oc: OC; objs: Set<TopoDS_Shape> } | null = null;
const topologyCache = new WeakMap<Named, Topology | null>();
/** Results of uncached regenerations, which belong to the caller (see releaseRegen). */
const callerOwned = new WeakSet<RegenResult>();

/**
 * Forget cached regeneration results and free their shapes. When the kernel
 * instance itself is being dropped, pass free = false (its memory goes with it).
 */
export function clearRegenCache(opts: { free?: boolean } = {}) {
  if (cacheOwned && opts.free !== false) freeAll(cacheOwned.objs);
  cacheOwned = null;
  historyCache = null;
}

/**
 * Free the shapes of an uncached regeneration's result once the caller is done
 * with it (a cached result belongs to the history cache: this does nothing).
 */
export function releaseRegen(r: RegenResult | null | undefined) {
  if (!r || !callerOwned.has(r)) return;
  callerOwned.delete(r);
  if (r.named) freeAll(namedObjects(r.named));
  free(r.shape, r.tool);
}

/** Shape objects a history snapshot holds: its body and the captured tools. */
function snapObjects(sn: Snap): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = sn.body ? namedObjects(sn.body) : [];
  for (const t of sn.tools.values()) out.push(...namedObjects(t.tool));
  return out;
}

export function regenerate(oc: OC, doc: CadDocument, opts: RegenOptions = {}): RegenResult {
  let capturedTool: TopoDS_Shape | null = null;
  const solver = opts.solver;
  const status: FeatureStatus[] = [];
  const sketches: SketchGeometry[] = [];
  const evalSketches = new Map<string, { frame: Frame; entities: EvalEntity[]; loops: Loop[] }>();
  let body: Named | null = null;
  let params: Record<string, Quantity> = {};
  try { params = resolveParams(doc); } catch (e) {
    return { shape: null, status: doc.features.map((f) => ({ id: f.id, ok: false, message: `Parameter error: ${(e as Error).message}` })), sketches };
  }
  const count = doc.rollback ?? doc.features.length;
  const gc = new Gc();
  // Tool bodies of solid features (for patterns / mirror), and reference geometry.
  const tools = new Map<string, CapturedTool>();
  const refGeometry: RefGeometry[] = [];
  const ctx: FeatureContext = { oc, gc, doc, params, evalSketches, tools, refGeometry, body: null };
  // Resume after the longest unchanged start of the history.
  const useCache = !!opts.cache && !opts.captureToolFor;
  const base = useCache ? JSON.stringify({ units: doc.units, params: doc.params }) : '';
  const feats = useCache ? doc.features.slice(0, count).map((f) => JSON.stringify(f)) : [];
  let start = 0;
  if (useCache && historyCache && historyCache.oc === oc && historyCache.base === base) {
    const hc = historyCache;
    while (start < feats.length && start < hc.feats.length && hc.feats[start] === feats[start]) start++;
    if (start > 0) {
      const sn = hc.snaps[start - 1];
      body = sn.body;
      status.push(...sn.status);
      sketches.push(...sn.sketches);
      for (const [k, v] of sn.evalSketches) evalSketches.set(k, v);
      for (const [k, v] of sn.tools) tools.set(k, v);
      refGeometry.push(...sn.refGeometry);
    }
    hc.feats.length = start; hc.snaps.length = start;
  }
  if (useCache && (!historyCache || historyCache.oc !== oc || historyCache.base !== base)) historyCache = { oc, base, feats: [], snaps: [] };
  const remember = (i: number) => {
    if (!useCache || !historyCache) return;
    historyCache.feats[i] = feats[i];
    historyCache.snaps[i] = { body, status: status.slice(), sketches: sketches.slice(), evalSketches: new Map(evalSketches), tools: new Map(tools), refGeometry: refGeometry.slice() };
  };
  // Every Named made from here on is recorded; settle() frees the ones nothing keeps (./mem.ts, rule 2).
  const settle = (created: Set<Named>) => {
    const keep = new Set<TopoDS_Shape>();
    const fin = body as Named | null;
    if (fin) for (const x of namedObjects(fin)) keep.add(x);
    if (capturedTool) keep.add(capturedTool);
    const candidates: TopoDS_Shape[] = [];
    for (const n of created) candidates.push(...namedObjects(n));
    if (useCache && historyCache) {
      for (const sn of historyCache.snaps) if (sn) for (const x of snapObjects(sn)) keep.add(x);
      // Shapes of history entries this rebuild replaced (or of another kernel's cache) are no longer held.
      if (cacheOwned?.oc === oc) candidates.push(...cacheOwned.objs);
      cacheOwned = { oc, objs: keep };
    } else if (cacheOwned?.oc === oc) {
      for (const x of cacheOwned.objs) keep.add(x);
    }
    freeExcept(candidates, keep);
  };
  beginLedger();
  try {
    doc.features.slice(0, count).forEach((f, i) => {
      if (i < start) return;
      try { applyOne(f); } finally { remember(i); }
    });
    // eslint-disable-next-line no-inner-declarations
    function applyOne(f: CadDocument['features'][number]) {
      if (f.suppressed) { status.push({ id: f.id, ok: true, message: 'Suppressed' }); return; }
      boolNotes = [];
      const notes = () => { const n = [...new Set(boolNotes ?? [])]; boolNotes = null; return n.length ? n.join(' ') : undefined; };
      try {
        if (f.type === 'sketch') {
          const s = evalSketch(f, doc, params, solver);
          if (f.refPlane) {
            // Sketch on a reference plane: same 2D geometry, placed on that plane (plus its offset).
            const off = f.offset !== undefined ? evalLength(f.offset, doc.units, params) : 0;
            s.frame = refPlaneFrame(ctx, f.refPlane, off);
          }
          let loops: Loop[] = [];
          let loopErr: string | undefined;
          try { loops = findLoops(s.entities); } catch (e) { loopErr = (e as Error).message; }
          evalSketches.set(f.id, { ...s, loops });
          sketches.push({ id: f.id, frame: s.frame, entities: s.entities, loops: loops.length });
          const extent = sketchExtent(s.frame, s.entities);
          status.push({ id: f.id, ok: true, ...(loopErr ? { message: loopErr } : {}), ...(extent ? { extent } : {}), ...(s.solve ? { sketch: s.solve } : {}) });
          return;
        }
        if (f.type !== 'extrude' && f.type !== 'revolve') {
          ctx.body = body;
          const r = applyModelingFeature(ctx, f);
          own(r.body); own(r.tool);
          if (opts.captureToolFor === f.id) capturedTool = r.tool?.shape ?? null;
          const before = body as Named | null;
          body = r.body;
          if (body && !isValid(oc, body.shape)) throw new Error('Result is not a valid solid');
          const extent = modelingExtent(oc, f.id, r.tool ?? null, before, body);
          const message = [r.message, notes()].filter(Boolean).join(' ');
          status.push({ id: f.id, ok: true, ...(message ? { message } : {}), ...(extent ? { extent } : {}) });
          return;
        }
        const sk = evalSketches.get(f.sketch);
        if (!sk) throw new Error('Its sketch is missing, suppressed, or after it in the history');
        ctx.body = body;
        const tool = own(f.type === 'extrude' ? extrudeBody(ctx, f, sk) : revolveTool(oc, gc, f, sk, doc, params));
        if (opts.captureToolFor === f.id) capturedTool = tool.shape;
        tools.set(f.id, { tool, op: f.operation === 'cut' ? 'cut' : 'add' });
        let extent: Extent | undefined;
        try {
          extent = shapeExtent(oc, tool.shape);
          if (f.operation === 'cut' && body && extent) extent = clipExtent(extent, shapeExtent(oc, (body as Named).shape));
        } catch { extent = undefined; }
        if (f.operation === 'cut') {
          if (!body) throw new Error('Nothing to cut: create a solid first');
          body = checkedBool(oc, 'cut', body, tool, f.id, f.name);
        } else if (f.operation === 'add' || (f.operation === 'new' && body)) {
          if (f.operation === 'new' && body) throw new Error('Multiple bodies are not supported yet; use "Add"');
          body = body ? checkedBool(oc, 'fuse', body, tool, f.id, f.name) : tool;
        } else {
          body = tool;
        }
        if (!isValid(oc, body.shape)) throw new Error('Result is not a valid solid');
        const message = notes();
        status.push({ id: f.id, ok: true, ...(message ? { message } : {}), ...(extent ? { extent } : {}) });
      } catch (e) {
        boolNotes = null;
        status.push({ id: f.id, ok: false, message: (e as Error).message });
      }
    }
  } finally {
    gc.free();
    settle(endLedger());
  }
  for (const f of doc.features.slice(count)) status.push({ id: f.id, ok: true, message: 'Rolled back' });
  const final = body as Named | null; // assigned inside the loop callback
  let topo: Topology | null = null;
  if (final && opts.topology !== false) {
    if (topologyCache.has(final)) topo = topologyCache.get(final)!;
    else { try { topo = topology(oc, final); } catch { topo = null; } topologyCache.set(final, topo); }
  }
  const result: RegenResult = { shape: final?.shape ?? null, named: final, topology: topo, refGeometry, status, sketches, ...(opts.captureToolFor ? { tool: capturedTool } : {}) };
  if (!useCache) callerOwned.add(result);
  return result;
}

/** Extrude tool body (see ./extrude.ts); with Flip side to cut, the region outside the profile. */
function extrudeBody(ctx: FeatureContext, f: ExtrudeFeature, sk: { frame: Frame; loops: Loop[]; entities: EvalEntity[] }): Named {
  const t = extrudeTool(ctx, f, sk);
  return f.operation === 'cut' && f.flipSide ? flipSideTool(ctx, f, t) : t.tool;
}

/** Does the face's boundary contain a B-spline edge (a sketch spline)? */
export function hasBSplineEdge(oc: OC, face: TopoDS_Shape): boolean {
  const ex = new oc.TopExp_Explorer(face, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  let found = false;
  for (; ex.More() && !found; ex.Next()) {
    const c = ex.Current(), ed = oc.TopoDS.Edge(c);
    const ad = new oc.BRepAdaptor_Curve(ed);
    found = String(ad.GetType()).endsWith('BSplineCurve');
    ad.delete(); ed.delete(); c.delete();
  }
  ex.delete();
  return found;
}

/**
 * Straight extrusion of a profile that has spline edges, built as a loft
 * between the profile and its translated copy. The side faces are then true
 * B-spline surfaces instead of "surfaces of linear extrusion" of a B-spline:
 * same exact geometry, but OpenCascade integrates mass properties of the
 * latter wrongly (up to a few % on trimmed faces) and very slowly.
 */
export function splinePrism(oc: OC, gc: Gc, face: TopoDS_Shape, vec: any): SweepResult {
  const w0 = gc.t(oc.BRepTools.OuterWire(gc.t(oc.TopoDS.Face(face))));
  const moved = (k: number) => {
    const tr = gc.t(new oc.gp_Trsf());
    tr.SetTranslation(gc.t(new oc.gp_Vec(vec.X() * k, vec.Y() * k, vec.Z() * k)));
    return gc.t(oc.TopoDS.Wire(gc.t(gc.t(new oc.BRepBuilderAPI_Transform(w0, tr, true, false)).Shape())));
  };
  // Three equal sections: the smooth loft through them is exactly straight
  // (two sections are rejected by both ruled and smooth modes for identical wires).
  const mk = gc.t(new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6));
  mk.AddWire(w0); mk.AddWire(moved(0.5)); mk.AddWire(moved(1));
  mk.Build(gc.t(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw new Error('Extrude failed in the geometry kernel');
  return {
    shape: mk.Shape(),
    generated: (e) => { try { const g = mk.GeneratedFace(e); return g && !g.IsNull() ? [g] : []; } catch { return []; } },
    first: (() => { try { return mk.FirstShape(); } catch { return null; } })(),
    last: (() => { try { return mk.LastShape(); } catch { return null; } })(),
  };
}

/**
 * Revolve / Cut-Revolve, like the mainstream CAD Revolve command panel:
 * Direction 1 Blind or Mid Plane (angle split equally both sides of the
 * sketch plane), Reverse Direction, an optional blind Direction 2 the other
 * way round the axis, and Thin Feature (open or closed sketch curves become a
 * wall of constant thickness). The axis is any line of the sketch: a
 * centerline, or a solid line, which may also be an edge of the profile
 * (a half-section drawn against the axis).
 */
function revolveTool(oc: OC, gc: Gc, f: RevolveFeature, sk: { frame: Frame; entities: EvalEntity[]; loops: Loop[] }, doc: CadDocument, params: Record<string, Quantity>): Named {
  const axis = sk.entities.find((e) => e.id === f.axisLine);
  if (!axis || axis.kind !== 'line') throw new Error('Revolve axis line not found');
  const ang = (v: string | number, what: string) => {
    const a = evalAngle(v, params);
    if (!(a > 0) || a > 2 * Math.PI + 1e-12) throw new Error(`${what} must be in (0, 360] degrees`);
    return Math.min(a, 2 * Math.PI);
  };
  const mid = f.end === 'midPlane';
  if (mid && f.angle2 !== undefined) throw new Error('Direction 2 is not used with Mid Plane');
  const a1 = ang(f.angle, mid ? 'Revolve angle' : 'Direction 1 angle');
  const a2 = mid ? 0 : f.angle2 !== undefined ? ang(f.angle2, 'Direction 2 angle') : 0;
  if (a1 + a2 > 2 * Math.PI + 1e-9) throw new Error('Direction 1 and Direction 2 together cannot be more than 360 degrees');
  const total = Math.min(a1 + a2, 2 * Math.PI);
  // Rotation starts this far back from the sketch plane (Direction 2 or half the Mid Plane angle).
  const back = mid ? a1 / 2 : a2;
  const pa = to3d(sk.frame, ...axis.a), pb = to3d(sk.frame, ...axis.b);
  const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
  const sgn = f.reverse ? -1 : 1;
  const k: [number, number, number] = [sgn * (pb[0] - pa[0]) / len, sgn * (pb[1] - pa[1]) / len, sgn * (pb[2] - pa[2]) / len];
  const ax1 = gc.t(new oc.gp_Ax1(gc.t(pnt(oc, pa)), gc.t(dir(oc, k))));
  // Profile curves: every real curve except a stand-alone axis line.
  const curves = sk.entities.filter((e) => !e.construction && e.kind !== 'point');
  let loops: Loop[];
  if (f.thin) {
    const T = (v: string | number | undefined, what: string) => {
      if (v === undefined || v === '') throw new Error(`${what} is required`);
      const t = evalLength(v, doc.units, params);
      if (!(t > 0)) throw new Error(`${what} must be greater than zero`);
      return t;
    };
    const t = T(f.thin.thickness, 'Thin feature thickness');
    let [t1, t2] = f.thin.type === 'midPlane' ? [t / 2, t / 2] : f.thin.type === 'twoDirection' ? [t, T(f.thin.thickness2, 'Thin feature Direction 2 thickness')] : [t, 0];
    if (f.thin.reverse) [t1, t2] = [t2, t1];
    const withoutAxis = curves.filter((e) => e.id !== f.axisLine);
    loops = thinLoops(withoutAxis.length ? withoutAxis : curves, t1, t2);
  } else {
    loops = sk.loops;
    if (!loops.length && !axis.construction) {
      // A solid axis line that is not part of the profile: find the profile without it.
      try { loops = findLoops(curves.filter((e) => e.id !== f.axisLine)); } catch { loops = []; }
    }
    if (!loops.length) throw new Error('Its sketch has no closed profile (use Thin Feature for an open profile)');
  }
  const fr = back > 0 ? rotateFrame(sk.frame, pa, k, -back) : sk.frame;
  return sweepRegion(oc, gc, fr, loops, (face) => {
    const r = gc.t(new oc.BRepPrimAPI_MakeRevol(face, ax1, total, false));
    checkDone(r, 'Revolve');
    return sweepHistory(oc, r);
  }, f.id);
}

/** A sketch frame rotated by angle t about the axis through p with unit direction k. */
function rotateFrame(fr: Frame, p: [number, number, number], k: [number, number, number], t: number): Frame {
  const c = Math.cos(t), s = Math.sin(t);
  const rot = (v: [number, number, number]): [number, number, number] => {
    const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
    const x: [number, number, number] = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
    return [v[0] * c + x[0] * s + k[0] * kv * (1 - c), v[1] * c + x[1] * s + k[1] * kv * (1 - c), v[2] * c + x[2] * s + k[2] * kv * (1 - c)];
  };
  const o = rot([fr.o[0] - p[0], fr.o[1] - p[1], fr.o[2] - p[2]]);
  return { o: [o[0] + p[0], o[1] + p[1], o[2] + p[2]], x: rot(fr.x), y: rot(fr.y), n: rot(fr.n) };
}
