/**
 * Extruded Boss/Base and Extruded Cut tool bodies, with the mainstream CAD
 * Extrude command panel options (published CAD documentation, "End Condition
 * Extrude" and "Extrude command panel"):
 *
 * - From: Sketch Plane, or Offset (start a distance away from the sketch plane).
 * - Direction 1 end condition: Blind, Through All, Up To Next (the nearest
 *   face ahead that intercepts the entire profile), Up To Vertex (the plane
 *   parallel to the sketch plane through the vertex), Up To Surface, Offset
 *   From Surface, Mid Plane. Through All - Both = Through All in Direction 1
 *   and Direction 2.
 * - Direction 2: the same list without Mid Plane, the other way.
 * - Draft On/Off with Draft outward, separately for each direction.
 * - Flip side to cut (handled in regen: the material outside the profile goes).
 * - Thin Feature with Cap ends (closed profiles) and Auto-fillet corners
 *   (open profiles, in thin.ts).
 *
 * Up To Surface on planes, reference planes and planar faces ends exactly on
 * that (infinite) plane, also when it is tilted to the sketch. On a curved
 * face the extrusion is split by the face itself, which must therefore cover
 * the whole profile; Up To Next does the same with each face ahead of the
 * sketch and keeps the nearest one that works.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { ExtrudeFeature, ExtrudeUpTo, VertexSpec, ValueExpr, PlaneSpec } from '../core/model';
import type { Vec3 } from '../core/featureTypes';
import { evalLength, evalAngle } from '../core/units';
import { type Named, nameShape, track, resolveEdge, resolveFace, indexShapes } from './naming';
import { type FeatureContext, planeOf } from './features';
import { thinLoops } from './features/thin';
import { type Frame, type Loop, type OC, type EvalEntity, sweepRegion, sweepHistory, hasBSplineEdge, splinePrism, bboxInfo, checkDone, trackedBool, to3d, loopDepths } from './regen';
import { free, freeAll, takeXyz } from './mem';

type Gc = FeatureContext['gc'];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const shiftFrame = (fr: Frame, d: Vec3, k: number): Frame => ({ ...fr, o: addv(fr.o, scale(d, k)) });

/** Geometric tolerance for "on the plane" checks, mm (OCCT Precision::Confusion is 1e-7). */
const EPS = 1e-6;

/** The vertex an Up To Vertex end condition names, in mm. */
export function vertexPoint(ctx: FeatureContext, v: VertexSpec): Vec3 {
  if ('refPoint' in v) {
    const g = ctx.refGeometry.find((r) => r.id === v.refPoint);
    if (!g) throw new Error('Its reference point is missing, suppressed, failed, or after it in the history');
    if (g.kind !== 'point') throw new Error('The reference is not a point');
    return g.p;
  }
  const { oc } = ctx;
  if (!ctx.body) throw new Error('Up To Vertex needs a vertex of an existing solid');
  const { edge } = resolveEdge(oc, ctx.body, v.edge);
  const ed = oc.TopoDS.Edge(edge);
  const ad = new oc.BRepAdaptor_Curve(ed);
  try {
    const a = takeXyz(ad.Value(ad.FirstParameter())), b = takeXyz(ad.Value(ad.LastParameter()));
    const da = dot(sub(a, v.at), sub(a, v.at)), db = dot(sub(b, v.at), sub(b, v.at));
    return da <= db ? a : b;
  } finally { free(ad, ed, edge); }
}

/** Points on the profile (loop polygons plus the exact extremes of arcs and circles along `g`). */
function profileExtremes(fr: Frame, loops: Loop[], m: Vec3): Vec3[] {
  const g: [number, number] = [dot(m, fr.x), dot(m, fr.y)];
  const gl = Math.hypot(g[0], g[1]);
  const pts: Vec3[] = [];
  for (const L of loops) {
    for (const p of L.poly) pts.push(to3d(fr, p[0], p[1]));
    for (const e of L.entities) {
      if (e.kind === 'line') { pts.push(to3d(fr, ...e.a), to3d(fr, ...e.b)); continue; }
      if ((e.kind === 'circle' || e.kind === 'arc') && gl > 1e-12) {
        const t = Math.atan2(g[1], g[0]);
        for (const a of [t, t + Math.PI]) {
          if (e.kind === 'arc') {
            const s = ((e.a1 - e.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
            const d = ((a - e.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
            if (d > s) continue;
          }
          pts.push(to3d(fr, e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)));
        }
      }
    }
  }
  return pts;
}

/** One direction's end condition, as stored on the feature. */
interface EndSpec { depth?: ValueExpr; throughAll?: boolean; upTo?: ExtrudeUpTo; reverse?: boolean }

/**
 * Where one direction of the extrusion ends: unit direction d and length;
 * a tilted plane that cuts it off; a face of the part that ends it (curved
 * Up To Surface); or Up To Next (the nearest face that covers the profile).
 * For endFace / next, `len` is a length that surely reaches past the end.
 */
interface DirEnd { d: Vec3; len: number; endPlane?: { o: Vec3; n: Vec3; keep: Vec3 }; endFace?: TopoDS_Shape; next?: boolean }

const plainEnd = (e: DirEnd) => !e.endPlane && !e.endFace && !e.next;

/** The 8 corners of a shape's bounding box (mm). */
function boxCorners(oc: OC, s: TopoDS_Shape): Vec3[] {
  const b = new oc.Bnd_Box();
  oc.BRepBndLib.Add(s, b, false);
  const l: Vec3 = takeXyz(b.CornerMin()), h: Vec3 = takeXyz(b.CornerMax());
  b.delete();
  const out: Vec3[] = [];
  for (const x of [l[0], h[0]]) for (const y of [l[1], h[1]]) for (const z of [l[2], h[2]]) out.push([x, y, z]);
  return out;
}
const along = (pts: Vec3[], o: Vec3, d: Vec3) => pts.map((p) => dot(sub(p, o), d));

/** A planar target as a plane, or a curved face of the part. */
function surfaceTarget(ctx: FeatureContext, s: PlaneSpec): { plane: Frame } | { face: TopoDS_Shape } {
  if (!('face' in s)) return { plane: planeOf(ctx, s) };
  const { oc } = ctx;
  if (!ctx.body) throw new Error('A face reference needs an existing solid');
  const face = ctx.body.faces[resolveFace(oc, ctx.body, s.face)];
  const fc = oc.TopoDS.Face(face);
  const ad = new oc.BRepAdaptor_Surface(fc, true);
  const planar = String(ad.GetType()).endsWith('Plane');
  ad.delete(); fc.delete();
  return planar ? { plane: planeOf(ctx, s) } : { face };
}

/**
 * The end of one direction. Direction 1 (forced undefined) goes along the
 * sketch normal, or toward its vertex / surface; Direction 2 is forced the
 * opposite way to Direction 1, and its target must be on that side.
 */
function directionEnd(ctx: FeatureContext, e: EndSpec, fr: Frame, loops: Loop[], throughLen: () => number, forced: Vec3 | undefined, label: string): DirEnd {
  const n = fr.n;
  const L = (v: string | number) => evalLength(v, ctx.doc.units, ctx.params);
  const base = forced ?? (e.reverse ? scale(n, -1) : n);
  const toward = (d: Vec3, what: string): Vec3 => {
    if (forced && dot(d, forced) < 0) throw new Error(`${label}: the ${what} is on the Direction 1 side of the sketch. Direction 2 goes the other way`);
    return d;
  };
  const u = e.upTo;
  if (!u) {
    const len = e.throughAll ? throughLen() : L(e.depth ?? 0);
    if (!(len > 0)) throw new Error(`${label} depth must be greater than zero`);
    return { d: base, len };
  }
  if (u.kind === 'next') {
    if (!ctx.body) throw new Error('Up To Next needs an existing solid');
    const reach = Math.max(...along(boxCorners(ctx.oc, ctx.body.shape), fr.o, base));
    if (!(reach > EPS)) throw new Error(`${label}: Up To Next found no part ahead of the sketch (try Reverse Direction)`);
    return { d: base, len: reach * 1.01 + 1, next: true };
  }
  if (u.kind === 'vertex') {
    const p = vertexPoint(ctx, u.vertex);
    const s = dot(sub(p, fr.o), n);
    if (Math.abs(s) < EPS) throw new Error('The vertex is on the start plane: pick a vertex in front of or behind the sketch');
    return { d: toward(s > 0 ? n : scale(n, -1), 'vertex'), len: Math.abs(s) };
  }
  const off = u.offset !== undefined ? L(u.offset) : 0;
  if (u.offset !== undefined && !(off >= 0)) throw new Error('Offset distance must be zero or more');
  const target = surfaceTarget(ctx, u.surface);
  if ('face' in target) {
    if (u.offset !== undefined) throw new Error('Offset From Surface needs a plane or a flat face (Up To Surface works on curved faces)');
    const proj = along(boxCorners(ctx.oc, target.face), fr.o, n);
    const lo = Math.min(...proj), hi = Math.max(...proj);
    const d = forced ?? (lo > EPS ? n : hi < -EPS ? scale(n, -1) : base);
    const reach = Math.max(...along(boxCorners(ctx.oc, target.face), fr.o, d));
    if (!(reach > EPS)) throw new Error(`${label}: the surface is not ahead of the sketch in this direction`);
    return { d, len: reach * 1.01 + 1, endFace: target.face };
  }
  const pl = target.plane;
  const m = pl.n, q = pl.o;
  const c = dot(n, m);
  if (Math.abs(c) > 1 - 1e-12) {
    // Parallel to the sketch: a plain depth.
    const s = dot(sub(q, fr.o), n);
    if (Math.abs(s) < EPS) throw new Error('The surface is the start plane: pick a surface in front of or behind the sketch');
    const len = u.reverseOffset ? Math.abs(s) + off : Math.abs(s) - off;
    if (!(len > EPS)) throw new Error('The offset puts the end at or behind the start plane');
    return { d: toward(s > 0 ? n : scale(n, -1), 'surface'), len };
  }
  if (Math.abs(c) < 1e-9) throw new Error('The surface is parallel to the extrude direction, so the extrusion never reaches it');
  // Tilted plane: every profile point must be on one side; extrude toward it, then cut off on the plane.
  const pts = profileExtremes(fr, loops, m);
  const s0 = pts.map((p) => dot(sub(p, q), m));
  const side = Math.sign(s0.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0));
  if (!side || s0.some((s) => s * side < EPS)) throw new Error('The surface crosses the sketch profile: pick a surface that is fully in front of or behind the profile');
  // Offset From Surface: the end plane moves back toward the sketch (Reverse offset: past the surface).
  const q2 = addv(q, scale(m, side * (u.reverseOffset ? -off : off)));
  const s2 = pts.map((p) => dot(sub(p, q2), m));
  if (s2.some((s) => s * side < EPS)) throw new Error('The offset puts the end plane across the sketch profile');
  const d = toward(c * side < 0 ? n : scale(n, -1), 'surface');
  const reach = Math.max(...s2.map((s) => Math.abs(s))) / Math.abs(c);
  return { d, len: reach, endPlane: { o: q2, n: m, keep: pts[0] } };
}

/** Exact volume of a shape (mm³). */
function volumeOf(oc: OC, s: TopoDS_Shape): number {
  const vp = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(s, vp, 1e-9, false, false);
  const v = vp.Mass();
  vp.delete();
  return v;
}

/**
 * Split the long extrusion `part` with a face and keep the pieces that touch
 * the start plane (faces tagged `${fid}:start`). Null when the face does not
 * cut every region off before the old end cap (`${fid}:end-before`), i.e. it
 * does not intercept the entire profile. The new end faces are `${fid}:end`.
 */
function splitKeep(oc: OC, gc: Gc, part: Named, face: TopoDS_Shape, fid: string): Named | null {
  const sp = gc.t(new oc.BRepAlgoAPI_Splitter());
  const args = gc.t(new oc.NCollection_List_TopoDS_Shape()); free(args.Append(part.shape));
  const tools = gc.t(new oc.NCollection_List_TopoDS_Shape()); free(tools.Append(face));
  sp.SetArguments(args); sp.SetTools(tools);
  sp.SetNonDestructive(true);
  const pr = gc.t(new oc.Message_ProgressRange());
  sp.Build(pr);
  if (!sp.IsDone()) return null;
  const tool: Named = { shape: face, faces: [face], tags: [[`${fid}:end`]] };
  const all = track(oc, sp, [part, tool], sp.Shape(), `${fid}:split`);
  const tagsOf = (f: TopoDS_Shape) => all.tags[all.faces.findIndex((x) => x.IsSame(f))] ?? [];
  const solids = indexShapes(oc, all.shape, 'TopAbs_SOLID').list;
  // Whether a solid has a face tagged `tag`.
  const hasTag = (s: TopoDS_Shape, tag: string) => { const fs = indexShapes(oc, s, 'TopAbs_FACE').list; const r = fs.some((f) => tagsOf(f).includes(tag)); freeAll(fs); return r; };
  const keep = solids.filter((s) => hasTag(s, `${fid}:start`));
  if (!keep.length || keep.length === solids.length || keep.some((s) => hasTag(s, `${fid}:end-before`))) { freeAll(solids); return null; }
  let shape = keep[0];
  if (keep.length > 1) {
    const b = gc.t(new oc.TopoDS_Builder()); const comp = new oc.TopoDS_Compound(); b.MakeCompound(comp);
    for (const k of keep) b.Add(comp, k);
    shape = comp;
  }
  freeAll(solids.filter((x) => x !== shape));
  return nameShape(oc, shape, (f) => {
    const t = tagsOf(f).filter((x) => !x.startsWith(`${fid}:split:`));
    return t.length ? t : [`${fid}:end`];
  });
}

/**
 * Up To Next: of the part's faces ahead of the start plane, the one that
 * intercepts the entire profile nearest to the sketch (smallest result).
 */
function upToNext(ctx: FeatureContext, long: Named, d: Vec3, start: Frame, fid: string, label: string): Named {
  const { oc, gc } = ctx;
  const body = ctx.body!;
  const pb = boxCorners(oc, long.shape);
  const pmin = [0, 1, 2].map((k) => Math.min(...pb.map((p) => p[k]))), pmax = [0, 1, 2].map((k) => Math.max(...pb.map((p) => p[k])));
  let best: Named | null = null; let bestV = Infinity;
  for (const face of body.faces) {
    const fb = boxCorners(oc, face);
    const fmin = [0, 1, 2].map((k) => Math.min(...fb.map((p) => p[k]))), fmax = [0, 1, 2].map((k) => Math.max(...fb.map((p) => p[k])));
    if ([0, 1, 2].some((k) => fmin[k] > pmax[k] + EPS || fmax[k] < pmin[k] - EPS)) continue;
    if (Math.max(...along(fb, start.o, d)) <= EPS) continue; // on or behind the start plane
    const r = splitKeep(oc, gc, long, face, fid);
    if (!r) continue;
    const v = volumeOf(oc, r.shape);
    if (v > 1e-9 && v < bestV) { best = r; bestV = v; }
  }
  if (!best) throw new Error(`${label}: Up To Next found no face ahead of the sketch that intercepts the entire profile`);
  return best;
}

/** Prism of the profile from `fr` along d (length len), faces named like every extrude. */
function prism(oc: OC, gc: Gc, fr: Frame, loops: Loop[], d: Vec3, len: number, fid: string): Named {
  const vec = gc.t(new oc.gp_Vec(d[0] * len, d[1] * len, d[2] * len));
  return sweepRegion(oc, gc, fr, loops, (face) => {
    if (hasBSplineEdge(oc, face)) return splinePrism(oc, gc, face, vec);
    const p = gc.t(new oc.BRepPrimAPI_MakePrism(face, vec, false, true));
    checkDone(p, 'Extrude');
    return sweepHistory(oc, p);
  }, fid);
}

/** Taper the side faces about the start plane (pull = direction the part gets smaller toward). */
function draftSides(oc: OC, gc: Gc, body: Named, fr: Frame, pull: Vec3, angle: number, fid: string): Named {
  const pln = gc.t(new oc.gp_Pln(gc.t(new oc.gp_Pnt(...fr.o)), gc.t(new oc.gp_Dir(...fr.n))));
  const dir = gc.t(new oc.gp_Dir(...pull));
  const mk = new oc.BRepOffsetAPI_DraftAngle(body.shape);
  try {
    body.faces.forEach((face, i) => {
      if (!body.tags[i].some((t) => t.startsWith(`${fid}:side:`))) return;
      const fc = oc.TopoDS.Face(face);
      mk.Add(fc, dir, angle, pln, true);
      fc.delete();
      if (!mk.AddDone()) throw new Error('This profile cannot be drafted (a spline or a side face the draft cannot tilt)');
    });
    const pr = new oc.Message_ProgressRange();
    mk.Build(pr); pr.delete();
    if (!mk.IsDone()) throw new Error('Draft failed in the geometry kernel: the angle is probably too large for this depth');
    return track(oc, mk, [body], mk.Shape(), `${fid}:face`);
  } finally { mk.delete(); }
}

/** Keep the part of `body` on the `keep` side of a plane; the new face is named `${fid}:end`. */
function trimByPlane(oc: OC, gc: Gc, body: Named, plane: { o: Vec3; n: Vec3; keep: Vec3 }, size: number, fid: string): Named {
  const pln = gc.t(new oc.gp_Pln(gc.t(new oc.gp_Pnt(...plane.o)), gc.t(new oc.gp_Dir(...plane.n))));
  const face = gc.t(gc.t(new oc.BRepBuilderAPI_MakeFace(pln, -size, size, -size, size)).Face());
  const hs = gc.t(new oc.BRepPrimAPI_MakeHalfSpace(face, gc.t(new oc.gp_Pnt(...plane.keep))));
  const half = nameShape(oc, hs.Solid(), () => [`${fid}:end`]);
  return trackedBool(oc, 'common', body, half, fid);
}

/** Rename tag `from` to `to` on every face (e.g. a Direction 2 cap). */
function retag(n: Named, from: string, to: string): Named {
  return { ...n, tags: n.tags.map((ts) => ts.map((t) => (t === from ? to : t))) };
}

/** The regions to extrude: the sketch's closed profiles, or the Thin Feature wall made from its curves. */
function profileLoops(ctx: FeatureContext, f: ExtrudeFeature, sk: { loops: Loop[]; entities: EvalEntity[] }): Loop[] {
  if (!f.thin) {
    if (!sk.loops.length) throw new Error('Its sketch has no closed profile (use Thin Feature for an open profile)');
    return sk.loops;
  }
  const T = (v: string | number | undefined, what: string) => {
    if (v === undefined || v === '') throw new Error(`${what} is required`);
    const t = evalLength(v, ctx.doc.units, ctx.params);
    if (!(t > 0)) throw new Error(`${what} must be greater than zero`);
    return t;
  };
  const t = T(f.thin.thickness, 'Thin feature thickness');
  let [t1, t2] = f.thin.type === 'midPlane' ? [t / 2, t / 2] : f.thin.type === 'twoDirection' ? [t, T(f.thin.thickness2, 'Thin feature Direction 2 thickness')] : [t, 0];
  if (f.thin.reverse && f.thin.type !== 'midPlane') [t1, t2] = [t2, t1];
  const curves = sk.entities.filter((e) => !e.construction && e.kind !== 'point');
  if (!curves.length) throw new Error('Its sketch has no curves to thicken');
  let fillet: number | undefined;
  if (f.thin.autoFillet !== undefined) {
    fillet = evalLength(f.thin.autoFillet, ctx.doc.units, ctx.params);
    if (!(fillet > 0)) throw new Error('Auto-fillet radius must be greater than zero');
    if (sk.loops.length) throw new Error('Auto-fillet corners is for open profiles (round the corners in the sketch instead)');
  }
  return thinLoops(curves, t1, t2, fillet);
}

/** curvedEnd: an end is a face of the part (Up To Next, Up To Surface on a curved face). */
export interface ExtrudeTool { tool: Named; start: Frame; d: Vec3; len1: number; len2: number; endPlane?: DirEnd['endPlane']; curvedEnd?: boolean }

/**
 * The extrude's tool body. Faces: `${fid}:side:<entity>`, `${fid}:start`
 * (the cap at the Direction 2 end, or at the start plane without Direction 2)
 * and `${fid}:end` (the Direction 1 end).
 */
export function extrudeTool(ctx: FeatureContext, f: ExtrudeFeature, sk: { frame: Frame; loops: Loop[]; entities: EvalEntity[] }): ExtrudeTool {
  const { oc, gc } = ctx;
  const loops = profileLoops(ctx, f, sk);
  const body = ctx.body?.shape ?? null;
  const L = (v: string | number) => evalLength(v, ctx.doc.units, ctx.params);
  const n = sk.frame.n;
  // From: Offset.
  let start = sk.frame;
  if (f.startOffset !== undefined) {
    const so = L(f.startOffset);
    if (!(so >= 0)) throw new Error('Start offset must be zero or more');
    start = shiftFrame(sk.frame, n, f.startOffsetReverse ? -so : so);
  }
  const throughLen = () => {
    if (!body) throw new Error('Through All needs an existing solid');
    const b = bboxInfo(oc, body);
    return b.diagonal * 2 + Math.hypot(...sub(b.center, start.o)) + 10;
  };
  const angle = (v: ValueExpr | undefined, what: string) => {
    if (v === undefined) return 0;
    const a = evalAngle(v, ctx.params);
    if (!(a > 0 && a < Math.PI / 2)) throw new Error(`${what} must be between 0 and 90 degrees`);
    return a;
  };
  if (f.draft !== undefined && f.direction === 'symmetric') throw new Error('Draft is not available with Mid Plane');
  const draft = angle(f.draft, 'Draft angle');
  if (f.direction === 'symmetric') {
    if (f.upTo) throw new Error('Mid Plane has no vertex or surface to end at');
    const total = f.throughAll ? throughLen() : L(f.depth);
    if (!(total > 0)) throw new Error('Depth must be greater than zero');
    const fr = shiftFrame(start, n, -total / 2);
    const tool = prism(oc, gc, fr, loops, n, total, f.id);
    return { tool: capEnds(ctx, f, sk, loops, tool, fr, n, total), start, d: n, len1: total / 2, len2: total / 2 };
  }
  const e1 = directionEnd(ctx, { depth: f.depth, throughAll: f.throughAll, upTo: f.upTo, reverse: f.direction === 'reverse' }, start, loops, throughLen, undefined, 'Direction 1');
  const has2 = f.upTo2 !== undefined || f.depth2 !== undefined || !!f.throughAll2;
  const e2 = has2 ? directionEnd(ctx, { depth: f.depth2, throughAll: f.throughAll2, upTo: f.upTo2 }, start, loops, throughLen, scale(e1.d, -1), 'Direction 2') : null;
  const draft2 = e2 ? angle(f.draft2, 'Direction 2 draft angle') : 0;
  const len2 = e2?.len ?? 0;
  const plain = plainEnd(e1) && (!e2 || plainEnd(e2));
  if (!draft && !draft2 && plain) {
    // One straight prism from the Direction 2 end to the Direction 1 end.
    const fr = shiftFrame(start, e1.d, -len2);
    const tool = prism(oc, gc, fr, loops, e1.d, e1.len + len2, f.id);
    return { tool: capEnds(ctx, f, sk, loops, tool, fr, e1.d, e1.len + len2), start, d: e1.d, len1: e1.len, len2 };
  }
  if (f.thin?.capEnds) throw new Error('Cap ends needs straight ends without draft (Blind, Mid Plane, Up To Vertex or a parallel plane)');
  let part = directionPiece(ctx, f.id, start, loops, e1, draft, !!f.draftOutward, 'Direction 1');
  if (e2) {
    // Direction 2 is its own piece; its far cap is the tool's start cap.
    const p2 = directionPiece(ctx, f.id, start, loops, e2, draft2, !!f.draftOutward2, 'Direction 2');
    const p2n = retag(retag(retag(p2, `${f.id}:end`, '__far'), `${f.id}:start`, `${f.id}:mid`), '__far', `${f.id}:start`);
    const p1n = retag(part, `${f.id}:start`, `${f.id}:mid`);
    part = trackedBool(oc, 'fuse', p1n, p2n, f.id);
  }
  return { tool: part, start, d: e1.d, len1: e1.len, len2, endPlane: e1.endPlane, ...(plain ? {} : { curvedEnd: !plainEnd(e1) && !e1.endPlane || !!e2 && !plainEnd(e2) }) };
}

/**
 * One direction from the start plane: a prism (drafted when `draft`), cut
 * off on a tilted end plane or split by the end face. Faces: `${fid}:start`
 * on the start plane, `${fid}:end` at the far end.
 */
function directionPiece(ctx: FeatureContext, fid: string, start: Frame, loops: Loop[], e: DirEnd, draft: number, outward: boolean, label: string): Named {
  const { oc, gc } = ctx;
  // Draft: inward = the profile gets smaller away from the start plane (along d), outward = larger.
  const build = (len: number) => {
    const p = prism(oc, gc, start, loops, e.d, len, fid);
    return draft ? draftSides(oc, gc, p, start, outward ? scale(e.d, -1) : e.d, draft, fid) : p;
  };
  if (e.endPlane) {
    // Long enough to pass the tilted end plane everywhere, then trimmed exactly on it.
    // A drafted side can lean away from the plane, so lengthen until the old end cap is gone.
    const radius = Math.max(...loops.flatMap((Lp) => Lp.poly.map((p) => Math.hypot(p[0], p[1]))));
    let len = e.len * 1.01 + 1;
    for (let k = 0; ; k++) {
      const size = len * 4 + radius * 4 + 100;
      const part = trimByPlane(oc, gc, retag(build(len), `${fid}:end`, `${fid}:end-before`), e.endPlane, size, fid);
      if (!part.tags.some((ts) => ts.includes(`${fid}:end-before`))) return part;
      if (k === 3) throw new Error(`${label}: the extrusion does not reach the surface (the draft leans it away)`);
      len *= 2;
    }
  }
  if (e.endFace || e.next) {
    const long = retag(build(e.len), `${fid}:end`, `${fid}:end-before`);
    if (e.next) return upToNext(ctx, long, e.d, start, fid, label);
    const r = splitKeep(oc, gc, long, e.endFace!, fid);
    if (!r) throw new Error(`${label}: the surface does not intercept the entire profile. Pick a face the whole profile runs into, or a plane`);
    return r;
  }
  return build(e.len);
}

/**
 * Thin Feature Cap ends: close both ends of a thin closed-profile boss with
 * `capThickness` of material inside its length (the part becomes hollow).
 * `lo` is the frame at the far Direction 2 end (or the start), extruded
 * `total` along d.
 */
function capEnds(ctx: FeatureContext, f: ExtrudeFeature, sk: { loops: Loop[] }, loops: Loop[], tool: Named, lo: Frame, d: Vec3, total: number): Named {
  const th = f.thin;
  if (!th?.capEnds) return tool;
  if (f.operation === 'cut') throw new Error('Cap ends is for bosses (thin cuts have no caps)');
  if (!sk.loops.length) throw new Error('Cap ends needs a closed sketch profile');
  if (th.capThickness === undefined || th.capThickness === '') throw new Error('Cap thickness is required');
  const ct = evalLength(th.capThickness, ctx.doc.units, ctx.params);
  if (!(ct > 0)) throw new Error('Cap thickness must be greater than zero');
  if (!(2 * ct < total - EPS)) throw new Error('Cap thickness must be less than half the extrude depth');
  // The caps fill the outer boundary of the wall (the outermost loops).
  const depths = loopDepths(loops);
  const outer = loops.filter((_, i) => depths[i] === 0);
  const { oc, gc } = ctx;
  const capA = prism(oc, gc, lo, outer, d, ct, `${f.id}:cap1`);
  const capB = prism(oc, gc, shiftFrame(lo, d, total - ct), outer, d, ct, `${f.id}:cap2`);
  return trackedBool(oc, 'fuse', trackedBool(oc, 'fuse', tool, capA, f.id), capB, f.id);
}

/**
 * Flip side to cut: the region outside the profile over the same extent
 * (a large slab minus the tool). Subtracting it keeps only what is inside
 * the profile within the cut's depth; material beyond the depth stays.
 */
export function flipSideTool(ctx: FeatureContext, f: ExtrudeFeature, t: ExtrudeTool): Named {
  const { oc, gc } = ctx;
  if (!ctx.body) throw new Error('Nothing to cut: create a solid first');
  if (t.curvedEnd) throw new Error('Flip side to cut works with Blind, Through All, Up To Vertex and planes; not with Up To Next or a curved surface');
  const b = bboxInfo(oc, ctx.body.shape);
  const fr = t.start;
  const cu = dot(sub(b.center, fr.o), fr.x), cv = dot(sub(b.center, fr.o), fr.y);
  const R = b.diagonal + 10;
  const corners: [number, number][] = [[cu - R, cv - R], [cu + R, cv - R], [cu + R, cv + R], [cu - R, cv + R]];
  const rect: Loop = {
    entities: corners.map((a, i) => ({ id: `${f.id}-flip${i}`, kind: 'line' as const, a, b: corners[(i + 1) % 4], construction: false })),
    poly: corners, area: 4 * R * R,
  };
  const slabFid = `${f.id}:outside`;
  let slab = prism(oc, gc, shiftFrame(fr, t.d, -t.len2), [rect], t.d, t.len1 + t.len2, slabFid);
  if (t.endPlane) slab = trimByPlane(oc, gc, slab, t.endPlane, t.len1 * 4 + R * 4 + 100, slabFid);
  return trackedBool(oc, 'cut', slab, t.tool, f.id);
}

export type { TopoDS_Shape };
