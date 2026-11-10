/**
 * Sweep (profile along a path), loft (through two or more profiles) and rib
 * (a thin wall grown from an open sketch line until it meets the part).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { SweepFeature, LoftFeature, RibFeature, Vec3, Vec3Expr } from '../../core/featureTypes';
import { type Frame, type Gc, type EvalEntity, type Loop, findLoops, sweepRegion, trackedBool, checkedBool, BooleanFailure, checkDone, loopWire, entityForEdge, to3d, bboxInfo, curveEnds, splineGeom } from '../regen';
import { type Named, nameShape, indexShapes, listOf } from '../naming';
import { type FeatureContext, type FeatureResult, posLength, add, sub, scale, dot, unit, cross, vec3 } from './index';
import { smoothLoftRings, buildSmoothLoft, type TipKind } from './smoothLoft';
import { free, freeAll } from '../mem';
import { loftSeam } from '../../core/loftSeam';

type Sk = { frame: Frame; entities: EvalEntity[]; loops: Loop[] };

function sketchOf(ctx: FeatureContext, id: string, role: string): Sk {
  const s = ctx.evalSketches.get(id);
  if (!s) throw new Error(`Its ${role} sketch is missing, suppressed, or after it in the history`);
  return s;
}

const nameOf = (ctx: FeatureContext, fid: string) => ctx.doc.features.find((x) => x.id === fid)?.name ?? 'This feature';

/** Combine a new tool solid with the body by the feature's operation. */
function combine(ctx: FeatureContext, op: 'new' | 'add' | 'cut', tool: Named, fid: string): FeatureResult {
  const body = ctx.body;
  ctx.tools.set(fid, { tool, op: op === 'cut' ? 'cut' : 'add' });
  if (op === 'cut') {
    if (!body) throw new Error('Nothing to cut: create a solid first');
    return { body: checkedBool(ctx.oc, 'cut', body, tool, fid, nameOf(ctx, fid)), tool };
  }
  if (op === 'new' && body) throw new Error('Multiple bodies are not supported yet; use "Add"');
  return { body: body ? checkedBool(ctx.oc, 'fuse', body, tool, fid, nameOf(ctx, fid)) : tool, tool };
}

type P2 = [number, number];
const ends = (e: EvalEntity): [P2, P2] | null => curveEnds(e);
const d2 = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Order a sketch's non-construction lines/arcs into one chain (open or closed). Returns entities with their direction. */
export function chainEntities(entities: EvalEntity[]): { e: EvalEntity; rev: boolean }[] {
  const open = entities.filter((e) => !e.construction && (e.kind === 'line' || e.kind === 'arc' || (e.kind === 'spline' && !e.closed)));
  const circles = entities.filter((e) => !e.construction && (e.kind === 'circle' || (e.kind === 'spline' && e.closed)));
  if (circles.length && !open.length) return [{ e: circles[0], rev: false }];
  if (!open.length) throw new Error('The sketch has no lines or arcs');
  const TOL = 1e-6;
  const degree = (p: P2) => open.filter((e) => ends(e)!.some((q) => d2(p, q) < TOL)).length;
  let start = open[0]; let startRev = false;
  for (const e of open) {
    const [a, b] = ends(e)!;
    if (degree(a) === 1) { start = e; startRev = false; break; }
    if (degree(b) === 1) { start = e; startRev = true; break; }
  }
  const out = [{ e: start, rev: startRev }];
  const used = new Set([start.id]);
  let cur = ends(start)![startRev ? 0 : 1];
  for (;;) {
    const next = open.find((e) => !used.has(e.id) && ends(e)!.some((q) => d2(q, cur) < TOL));
    if (!next) break;
    const [a, b] = ends(next)!;
    const rev = d2(b, cur) < TOL && d2(a, cur) >= TOL;
    out.push({ e: next, rev });
    used.add(next.id);
    cur = rev ? a : b;
  }
  if (used.size !== open.length) throw new Error('The path must be one connected chain of lines and arcs (no branches or gaps)');
  return out;
}

/** The path as a wire, running from the end nearest `startNear` (the profile). */
function chainWire(ctx: FeatureContext, sk: Sk, startNear?: Vec3, firstEdge?: { edge: any; last?: any }): any {
  const { oc, gc } = ctx;
  let chain = chainEntities(sk.entities);
  const fr = sk.frame;
  if (startNear && chain.length && curveEnds(chain[0].e)) {
    const endOf = (c: { e: EvalEntity; rev: boolean }, last: boolean) => { const [a, b] = ends(c.e)!; return to3d(fr, ...((c.rev !== last) ? b : a)); };
    const head = endOf(chain[0], false), tail = endOf(chain[chain.length - 1], true);
    const dist3 = (p: Vec3) => Math.hypot(...sub(p, startNear));
    if (dist3(tail) < dist3(head) - 1e-9) chain = chain.slice().reverse().map((c) => ({ e: c.e, rev: !c.rev }));
  }
  const mw = gc.t(new oc.BRepBuilderAPI_MakeWire());
  for (const { e, rev } of chain) {
    let me: any;
    const ax2 = (c: P2) => gc.t(new oc.gp_Ax2(gc.t(new oc.gp_Pnt(...to3d(fr, c[0], c[1]))), gc.t(new oc.gp_Dir(...fr.n)), gc.t(new oc.gp_Dir(...fr.x))));
    if (e.kind === 'line') me = gc.t(new oc.BRepBuilderAPI_MakeEdge(gc.t(new oc.gp_Pnt(...to3d(fr, ...e.a))), gc.t(new oc.gp_Pnt(...to3d(fr, ...e.b)))));
    else if (e.kind === 'arc') { let a1 = e.a1; while (a1 <= e.a0) a1 += 2 * Math.PI; me = gc.t(new oc.BRepBuilderAPI_MakeEdge(gc.t(new oc.gp_Circ(ax2(e.c), e.r)), e.a0, a1)); }
    else if (e.kind === 'circle') me = gc.t(new oc.BRepBuilderAPI_MakeEdge(gc.t(new oc.gp_Circ(ax2(e.c), e.r))));
    else if (e.kind === 'spline') me = gc.t(new oc.BRepBuilderAPI_MakeEdge(splineGeom(oc, gc, fr, e)));
    else continue;
    let edge: any;
    if (rev) { const e0 = me.Edge(), r0 = e0.Reversed(); edge = gc.t(oc.TopoDS.Edge(r0)); e0.delete(); r0.delete(); } else edge = gc.t(me.Edge());
    if (firstEdge && !firstEdge.edge) firstEdge.edge = edge;
    if (firstEdge) firstEdge.last = edge;
    mw.Add(edge);
    if (!mw.IsDone()) throw new Error('The path edges do not connect');
  }
  return gc.t(mw.Wire());
}

/**
 * Sweep / Cut-Sweep. Profile: a closed sketch, or (mainstream CAD "Circular
 * Profile") a circle of a given diameter centred on the path start, square
 * to it. Orientation: Follow Path (corrected Frenet frame: the profile stays
 * square to the path) or Keep Normal Constant (a fixed frame: the profile
 * keeps its starting orientation and is translated along the path).
 */
export function sweepFeature(ctx: FeatureContext, f: SweepFeature): FeatureResult {
  const { oc, gc } = ctx;
  const path = sketchOf(ctx, f.path, 'path');
  let prof: Sk;
  let spine: any;
  if (f.circular) {
    const r = posLength(ctx, f.circular.diameter, 'Circular profile diameter') / 2;
    const first: { edge: any } = { edge: null };
    spine = chainWire(ctx, path, undefined, first);
    const { p, t } = edgeStart(ctx, first.edge);
    // Any x axis square to the tangent; the circle is the same whichever is chosen.
    const ref: Vec3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const x = unit(sub(ref, scale(t, dot(ref, t))));
    const frame: Frame = { o: p, x, y: cross(t, x), n: t };
    const circle: EvalEntity = { id: 'circle', kind: 'circle', c: [0, 0], r, construction: false };
    prof = { frame, entities: [circle], loops: findLoops([circle]) };
  } else {
    prof = sketchOf(ctx, f.profile, 'profile');
    if (!prof.loops.length) throw new Error('The profile sketch has no closed profile');
    // The path runs from the end nearest the profile (its first loop's start point).
    const l0 = prof.loops[0].entities[0];
    const p0: [number, number] = l0.kind === 'line' ? l0.a : l0.kind === 'circle' || l0.kind === 'arc' ? l0.c : l0.kind === 'spline' ? [l0.pts.reduce((a, q) => a + q[0], 0) / l0.pts.length, l0.pts.reduce((a, q) => a + q[1], 0) / l0.pts.length] : [0, 0];
    spine = chainWire(ctx, path, to3d(prof.frame, ...p0));
  }
  const keepNormal = f.orientation === 'keepNormal';
  const tool = sweepRegion(oc, gc, prof.frame, prof.loops, (face) => {
    const wire = gc.t(oc.BRepTools.OuterWire(gc.t(oc.TopoDS.Face(face))));
    const mk = gc.t(new oc.BRepOffsetAPI_MakePipeShell(spine));
    if (keepNormal) {
      // Fixed trihedron = the profile's own plane: no rotation along the path.
      const fr = prof.frame;
      mk.SetMode(gc.t(new oc.gp_Ax2(gc.t(new oc.gp_Pnt(...fr.o)), gc.t(new oc.gp_Dir(...fr.n)), gc.t(new oc.gp_Dir(...fr.x)))));
    } else {
      mk.SetMode(false); // corrected Frenet: the profile stays square to the path
    }
    mk.Add(wire, false, false);
    const pr = gc.t(new oc.Message_ProgressRange());
    mk.Build(pr);
    if (!mk.IsDone()) throw new Error('Sweep failed: the path may be too tight for the profile, or not start at the profile');
    if (!mk.MakeSolid()) throw new Error('Sweep did not produce a closed solid');
    checkDone(mk, 'Sweep');
    return {
      shape: mk.Shape(),
      generated: (s: TopoDS_Shape) => { try { return listOf(oc, mk.Generated(s)); } catch { return []; } },
      first: mk.FirstShape(), last: mk.LastShape(),
    };
  }, f.id);
  return combine(ctx, f.operation, tool, f.id);
}

/**
 * Where a sketch's curve chain starts or ends, and its unit tangent there
 * (in the chain's direction): for planes normal to a path (sweep profiles).
 */
export function chainEnd(ctx: FeatureContext, sketchId: string, at: 'start' | 'end'): { p: Vec3; t: Vec3 } {
  const sk = sketchOf(ctx, sketchId, 'curve');
  const rec: { edge: any; last?: any } = { edge: null };
  chainWire(ctx, sk, undefined, rec);
  return at === 'start' ? edgeStart(ctx, rec.edge) : edgeStart(ctx, rec.last, true);
}

/** Start (or end) point and unit tangent of an edge, in its own direction (orientation included). */
function edgeStart(ctx: FeatureContext, edge: any, atEnd = false): { p: Vec3; t: Vec3 } {
  const { oc } = ctx;
  if (!edge) throw new Error('The path is empty');
  const ed = oc.TopoDS.Edge(edge);
  const ad = new oc.BRepAdaptor_Curve(ed);
  const reversed = String(edge.Orientation()).includes('REVERSED');
  const u = (reversed !== atEnd) ? ad.LastParameter() : ad.FirstParameter();
  const P = new oc.gp_Pnt(0, 0, 0), V = new oc.gp_Vec(0, 0, 0);
  ad.D1(u, P, V);
  const t: Vec3 = reversed ? [-V.X(), -V.Y(), -V.Z()] : [V.X(), V.Y(), V.Z()];
  const out = { p: [P.X(), P.Y(), P.Z()] as Vec3, t: unit(t, 'Path tangent') };
  P.delete(); V.delete(); ad.delete(); ed.delete();
  return out;
}

export function loftFeature(ctx: FeatureContext, f: LoftFeature): FeatureResult {
  const { oc, gc } = ctx;
  const tips = (f.startPoint ? 1 : 0) + (f.endPoint ? 1 : 0);
  if (f.profiles.length + tips < 2 || f.profiles.length < 1) throw new Error('A loft needs at least two profiles (or one profile and a start/end point)');
  // Organic sections (closed uniform splines, equal point counts): the exact, light smooth loft.
  if (!f.ruled) {
    const secs = f.profiles.map((id, k) => {
      const sk = sketchOf(ctx, id, `profile ${k + 1}`);
      if (sk.loops.length !== 1) throw new Error(`Loft profile ${k + 1} must have exactly one closed loop (it has ${sk.loops.length})`);
      return { frame: sk.frame, loop: sk.loops[0] };
    });
    const rings = smoothLoftRings(secs);
    if (rings) {
      const tipOf = (p: Vec3Expr | undefined, k: TipKind | undefined) => (p ? { at: vec3(ctx, p) as [number, number, number], kind: k ?? 'point' } : undefined);
      const spline = secs[0].loop.entities[0];
      // Each loft starts its seam at its own place (stored when it was made, see core/loftSeam.ts),
      // and moves it if the kernel fails to combine it.
      const base = loftSeam(f);
      const build = (seam: number, g: Gc = gc): Named => {
        const r = buildSmoothLoft(oc, g, rings, tipOf(f.startPoint, f.startTip), tipOf(f.endPoint, f.endTip), seam);
        const named = nameShape(oc, r.shape, (fc) => {
          if (r.side && fc.IsSame(r.side)) return [`${f.id}:side:${spline.id}`];
          if (r.startCap && fc.IsSame(r.startCap)) return [`${f.id}:start`];
          if (r.endCap && fc.IsSame(r.endCap)) return [`${f.id}:end`];
          return [];
        });
        named.tags.forEach((t, i) => { if (!t.length) t.push(`${f.id}:face${i}`); });
        return named;
      };
      const SHIFTS = [0, 1 / 3, 2 / 3, 1 / 6];
      let failure: Error | null = null;
      for (const shift of SHIFTS) {
        try {
          const out = combine(ctx, f.operation, build(base + shift), f.id);
          // Mirrors and patterns of this loft can try the other seams too.
          const cap = ctx.tools.get(f.id);
          if (cap) cap.variants = (g) => SHIFTS.filter((x) => x !== shift).map((x) => build(base + x, g));
          return out;
        } catch (e) {
          if (!(e instanceof BooleanFailure)) throw e;
          failure = e;
        }
      }
      throw new Error(`${failure!.message}. Try moving or resizing it slightly so it meets the part differently.`);
    }
  }
  const mk = gc.t(new oc.BRepOffsetAPI_ThruSections(true, !!f.ruled, 1e-6));
  const tip = (p: Vec3Expr) => gc.t(gc.t(new oc.BRepBuilderAPI_MakeVertex(gc.t(new oc.gp_Pnt(...vec3(ctx, p))))).Vertex());
  if (f.startPoint) mk.AddVertex(tip(f.startPoint));
  const wires: { wire: any; sk: Sk; loop: Loop }[] = [];
  f.profiles.forEach((id, k) => {
    const sk = sketchOf(ctx, id, `profile ${k + 1}`);
    if (sk.loops.length !== 1) throw new Error(`Loft profile ${k + 1} must have exactly one closed loop (it has ${sk.loops.length})`);
    const wire = loopWire(oc, gc, sk.frame, sk.loops[0]);
    wires.push({ wire, sk, loop: sk.loops[0] });
    mk.AddWire(wire);
  });
  if (f.endPoint) mk.AddVertex(tip(f.endPoint));
  const pr = gc.t(new oc.Message_ProgressRange());
  mk.Build(pr);
  if (!mk.IsDone()) throw new Error('Loft failed: check that the profiles are similar (same number of sides works best) and do not cross');
  const shape = mk.Shape();
  const named = nameShape(oc, shape, () => []);
  const { sk: s0, loop: l0, wire: w0 } = wires[0];
  const ex = new oc.TopExp_Explorer(w0, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const e = ex.Current();
    let g: TopoDS_Shape | null = null;
    try { g = mk.GeneratedFace(e); } catch { g = null; }
    if (g && !g.IsNull()) {
      const i = named.faces.findIndex((x) => x.IsSame(g!));
      if (i >= 0) named.tags[i].push(`${f.id}:side:${entityForEdge(oc, s0.frame, l0, e) ?? 'edge'}`);
    }
    free(g, e);
  }
  ex.delete();
  const safe = (g: () => TopoDS_Shape | null) => { try { return g(); } catch { return null; } };
  const first = safe(() => mk.FirstShape()), last = safe(() => mk.LastShape());
  named.faces.forEach((fc, i) => {
    if (named.tags[i].length) return;
    if (first && !first.IsNull() && fc.IsSame(first)) named.tags[i].push(`${f.id}:start`);
    else if (last && !last.IsNull() && fc.IsSame(last)) named.tags[i].push(`${f.id}:end`);
    else named.tags[i].push(`${f.id}:face${i}`);
  });
  free(first, last);
  return combine(ctx, f.operation, named, f.id);
}

// ------------------------------------------------------------------ rib

function distance(ctx: FeatureContext, a: TopoDS_Shape, b: TopoDS_Shape): number {
  const { oc } = ctx;
  const pr = new oc.Message_ProgressRange();
  const d = new oc.BRepExtrema_DistShapeShape(a, b, (oc as any).Extrema_ExtFlag?.Extrema_ExtFlag_MIN, (oc as any).Extrema_ExtAlgo?.Extrema_ExtAlgo_Grad, pr);
  const v = d.IsDone() ? d.Value() : Infinity;
  d.delete(); pr.delete();
  return v;
}

function prismFromPolygon(ctx: FeatureContext, pts: Vec3[], v: Vec3): TopoDS_Shape {
  const { oc, gc } = ctx;
  const mw = gc.t(new oc.BRepBuilderAPI_MakeWire());
  for (let i = 0; i < pts.length; i++) mw.Add(gc.t(gc.t(new oc.BRepBuilderAPI_MakeEdge(gc.t(new oc.gp_Pnt(...pts[i])), gc.t(new oc.gp_Pnt(...pts[(i + 1) % pts.length])))).Edge()));
  const face = gc.t(gc.t(new oc.BRepBuilderAPI_MakeFace(gc.t(mw.Wire()), true)).Face());
  const p = gc.t(new oc.BRepPrimAPI_MakePrism(face, gc.t(new oc.gp_Vec(...v)), false, true));
  checkDone(p, 'Rib');
  return p.Shape();
}

/**
 * Rib: each straight segment of the sketch is grown into a slab (extended past
 * its ends), the part is subtracted from it, and the piece that touches the
 * sketch line and is closed off by the part on the far side is kept and joined.
 */
export function ribFeature(ctx: FeatureContext, f: RibFeature): FeatureResult {
  const { oc } = ctx;
  const body = ctx.body;
  if (!body) throw new Error('A rib needs an existing solid');
  const sk = sketchOf(ctx, f.sketch, 'rib');
  const chain = chainEntities(sk.entities).filter((c) => c.e.kind === 'line');
  if (!chain.length) throw new Error('A rib sketch needs at least one straight line');
  const T = posLength(ctx, f.thickness, 'Thickness');
  const fr = sk.frame;
  const bb = bboxInfo(oc, body.shape);
  const B = bb.diagonal * 2 + Math.hypot(...sub(bb.center, fr.o)) + 10;
  const side = f.side ?? 'both';
  const segs = chain.map(({ e, rev }) => {
    const l = e as Extract<EvalEntity, { kind: 'line' }>;
    const a = to3d(fr, ...(rev ? l.b : l.a)), b = to3d(fr, ...(rev ? l.a : l.b));
    return { a, b, t: unit(sub(b, a)) };
  });
  const probe = (() => { const s = segs[0]; return scale(add(s.a, s.b), 0.5); })();
  const { gc } = ctx;
  const vertexAt = (p: Vec3) => gc.t(gc.t(new oc.BRepBuilderAPI_MakeVertex(gc.t(new oc.gp_Pnt(...p)))).Vertex());

  const attempt = (sgn: 1 | -1): TopoDS_Shape | null => {
    let tool: Named | null = null;
    segs.forEach((s, i) => {
      const a = i === 0 ? sub(s.a, scale(s.t, B)) : s.a;
      const b = i === segs.length - 1 ? add(s.b, scale(s.t, B)) : s.b;
      let pts: Vec3[]; let v: Vec3;
      if (f.direction === 'parallel') {
        // Thickness across the sketch plane; grows in the plane, perpendicular to the line.
        const p = scale(cross(fr.n, s.t), sgn);
        const [z0, z1] = side === 'both' ? [-T / 2, T / 2] : side === 'left' ? [0, T] : [-T, 0];
        const lift = (q: Vec3) => add(q, scale(fr.n, z0));
        pts = [lift(a), lift(b), lift(add(b, scale(p, B))), lift(add(a, scale(p, B)))];
        v = scale(fr.n, z1 - z0);
      } else {
        // Thickness in the plane, across the line; grows along the sketch normal.
        const p = cross(fr.n, s.t);
        const [w0, w1] = side === 'both' ? [-T / 2, T / 2] : side === 'left' ? [0, T] : [-T, 0];
        pts = [add(a, scale(p, w0)), add(b, scale(p, w0)), add(b, scale(p, w1)), add(a, scale(p, w1))];
        v = scale(fr.n, B * sgn);
      }
      const slab = nameShape(oc, prismFromPolygon(ctx, pts, v), () => [`${f.id}:rib`]);
      tool = tool ? trackedBool(oc, 'fuse', tool, slab, f.id) : slab;
    });
    const rest = trackedBool(oc, 'cut', tool!, body, f.id);
    const solids = indexShapes(oc, rest.shape, 'TopAbs_SOLID').list;
    const pv = vertexAt(probe);
    const growDir = f.direction === 'parallel' ? scale(cross(fr.n, segs[0].t), sgn) : scale(fr.n, sgn);
    let found: TopoDS_Shape | null = null;
    for (const s of solids) {
      if (distance(ctx, pv, s) > 1e-6) continue;
      if (distance(ctx, s, body.shape) > 1e-6) continue;
      // Closed off by the part: it must not reach the far end of the slab.
      const sb = bboxInfo(oc, s);
      if (dot(sub(sb.center, probe), growDir) + sb.diagonal / 2 > B * 0.5) continue;
      found = s;
      break;
    }
    freeAll(solids.filter((x) => x !== found));
    return found;
  };
  let piece = attempt(f.flip ? -1 : 1);
  if (!piece && f.flip === undefined) piece = attempt(-1);
  if (!piece) throw new Error('The rib does not meet the part on that side. Flip the material side, or move the sketch line closer to the walls.');
  const rib = nameShape(oc, piece, () => [`${f.id}:rib`]);
  ctx.tools.set(f.id, { tool: rib, op: 'add' });
  return { body: checkedBool(oc, 'fuse', body, rib, f.id, f.name), tool: rib };
}
