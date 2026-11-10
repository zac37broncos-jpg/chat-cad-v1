/**
 * Reference geometry: planes, axes and points. They make no solid; they are
 * evaluated in history order and used by later sketches, holes, patterns,
 * mirrors and drafts (and drawn in the viewport).
 */
import type { RefPlaneFeature, RefAxisFeature, RefPointFeature, Vec3 } from '../../core/featureTypes';
import { resolveEdge, resolveFace } from '../naming';
import { free, takeXyz } from '../mem';
import { chainEnd } from './sweep';
import { type FeatureContext, type FeatureResult, planeOf, axisOf, vec3, L, A, add, sub, scale, dot, cross, unit, rotate, norm, displaySize } from './index';


/** Right-handed in-plane axes for a normal, preferring world X as the x axis. */
function axesFor(n: Vec3, xHint?: Vec3): { x: Vec3; y: Vec3 } {
  let ref = xHint ?? [1, 0, 0];
  if (Math.abs(dot(ref, n)) > 0.999) ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
  const x = unit(sub(ref, scale(n, dot(ref, n))));
  return { x, y: cross(n, x) };
}

export function refPlaneFeature(ctx: FeatureContext, f: RefPlaneFeature): FeatureResult {
  const d = f.def;
  let o: Vec3, n: Vec3, x: Vec3;
  if (d.kind === 'offset') {
    const fr = planeOf(ctx, d.from);
    n = fr.n; x = fr.x;
    o = add(fr.o, scale(n, L(ctx, d.distance) * (d.flip ? -1 : 1)));
  } else if (d.kind === 'angle') {
    const fr = planeOf(ctx, d.from);
    const ax = axisOf(ctx, d.axis);
    const k = unit(ax.d);
    if (Math.abs(dot(k, fr.n)) > 1e-6) throw new Error('The axis must lie in (be parallel to) the reference plane');
    const t = A(ctx, d.angle);
    // The rotated plane passes through the axis.
    o = add(ax.o, scale(fr.n, -dot(sub(ax.o, fr.o), fr.n)));
    n = rotate(fr.n, k, t); x = rotate(fr.x, k, t);
  } else if (d.kind === 'threePoints') {
    const [p1, p2, p3] = d.points.map((p) => vec3(ctx, p));
    n = cross(sub(p2, p1), sub(p3, p1));
    if (norm(n) < 1e-9) throw new Error('The three points are on one line');
    n = unit(n); o = p1; x = unit(sub(p2, p1));
  } else if (d.kind === 'normalToCurve') {
    const e = chainEnd(ctx, d.sketch, d.at);
    o = e.p; n = e.t;
    // x axis: the curve's sketch-plane normal when it is square to the tangent (keeps the plane "upright").
    const sk = ctx.evalSketches.get(d.sketch);
    x = sk && Math.abs(dot(sk.frame.n, n)) < 1e-9 ? sk.frame.n : [1, 0, 0];
  } else if (d.kind === 'parallelAtPoint') {
    const fr = planeOf(ctx, d.from);
    n = fr.n; x = fr.x;
    if ('refPoint' in d.point) {
      const id = d.point.refPoint;
      const g = ctx.refGeometry.find((r) => r.id === id);
      if (!g || g.kind !== 'point') throw new Error('Its reference point is missing, suppressed, failed, or after it in the history');
      o = g.p;
    } else o = vec3(ctx, d.point);
  } else {
    const a = planeOf(ctx, d.a), b = planeOf(ctx, d.b);
    if (Math.abs(Math.abs(dot(a.n, b.n)) - 1) > 1e-9) throw new Error('A mid plane needs two parallel planes or faces');
    const gap = dot(sub(b.o, a.o), a.n);
    o = add(a.o, scale(a.n, gap / 2)); n = a.n; x = a.x;
  }
  const ax = axesFor(n, x);
  ctx.refGeometry.push({ id: f.id, kind: 'plane', origin: o, x: ax.x, y: ax.y, normal: n, size: displaySize(ctx) });
  return { body: ctx.body };
}

export function refAxisFeature(ctx: FeatureContext, f: RefAxisFeature): FeatureResult {
  const d = f.def;
  let o: Vec3, dir: Vec3;
  if (d.kind === 'twoPoints') {
    o = vec3(ctx, d.p1); dir = unit(sub(vec3(ctx, d.p2), o), 'The axis (two equal points)');
  } else if (d.kind === 'twoPlanes') {
    const a = planeOf(ctx, d.a), b = planeOf(ctx, d.b);
    const u = cross(a.n, b.n);
    if (norm(u) < 1e-9) throw new Error('The two planes are parallel: they have no intersection line');
    dir = unit(u);
    // Point on both planes: solve n_a.p = d_a, n_b.p = d_b, u.p = 0.
    const da = dot(a.n, a.o), db = dot(b.n, b.o);
    o = scale(add(scale(cross(b.n, u), da), scale(cross(u, a.n), db)), 1 / dot(u, u));
  } else {
    const r = axisOf(ctx, d.of); o = r.o; dir = unit(r.d);
  }
  ctx.refGeometry.push({ id: f.id, kind: 'axis', origin: o, dir, length: displaySize(ctx) });
  return { body: ctx.body };
}

export function refPointFeature(ctx: FeatureContext, f: RefPointFeature): FeatureResult {
  const { oc } = ctx;
  const d = f.def;
  let p: Vec3;
  if (d.kind === 'coords') p = vec3(ctx, d.p);
  else {
    const body = ctx.body;
    if (!body) throw new Error('This point needs an existing solid');
    if (d.kind === 'arcCenter') {
      const { edge } = resolveEdge(oc, body, d.edge);
      const ed = oc.TopoDS.Edge(edge);
      const ad = new oc.BRepAdaptor_Curve(ed);
      try {
        if (!String(ad.GetType()).endsWith('Circle')) throw new Error('The edge is not an arc or circle');
        const c = ad.Circle();
        p = takeXyz(c.Location());
        c.delete();
      } finally { free(ad, ed, edge); }
    } else {
      const fi = resolveFace(oc, body, d.face);
      const gp = new oc.GProp_GProps();
      oc.BRepGProp.SurfaceProperties(body.faces[fi], gp, 1e-9, false);
      p = takeXyz(gp.CentreOfMass()); gp.delete();
    }
  }
  ctx.refGeometry.push({ id: f.id, kind: 'point', p });
  return { body: ctx.body };
}
