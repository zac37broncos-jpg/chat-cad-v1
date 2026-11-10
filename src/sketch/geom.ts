/**
 * Working sketch geometry in millimeters and radians, plus the 2D math the
 * sketcher needs (closest points, intersections, parameters on curves).
 * Pure TypeScript: no DOM, no WASM. Used by the solver, the kernel regen,
 * the interactive sketcher and the AI bridge alike.
 */
import type { PointRef, SketchConstraint, SketchEntity, SketchFeature, ValueExpr } from '../core/model';
import { SKETCH_AXIS_H, SKETCH_AXIS_V, SKETCH_ORIGIN, isDimension } from '../core/model';
import { evalAngle, evalLength, MM_PER, type LengthUnit, type Quantity } from '../core/units';
import { splineFor, closestOnSpline, sampleSpline, splineEval, type BSpline2 } from './spline';

export type P2 = [number, number];

/** A sketch entity with every expression evaluated (mm, radians). Arcs run counter-clockwise from a0 to a1. */
export type WEntity =
  | { id: string; kind: 'point'; p: P2; construction: boolean }
  | { id: string; kind: 'line'; a: P2; b: P2; construction: boolean }
  | { id: string; kind: 'circle'; c: P2; r: number; construction: boolean }
  | { id: string; kind: 'arc'; c: P2; r: number; a0: number; a1: number; construction: boolean }
  /** Interpolating spline through `pts` (see spline.ts). Not moved by the solver. */
  | { id: string; kind: 'spline'; pts: P2[]; closed: boolean; construction: boolean; uniform?: boolean };

/** The exact B-spline of a spline entity (memoized). */
export const splineCurve = (e: Extract<WEntity, { kind: 'spline' }>): BSpline2 => splineFor(e.pts, e.closed, !!e.uniform);

/** A sketch ready for solving: geometry in mm, constraints as stored, dimension values evaluated (mm or rad). */
export interface WSketch {
  entities: WEntity[];
  constraints: SketchConstraint[];
  /** Evaluated value of each dimension constraint, by constraint id (mm, or rad for angles). */
  values: Map<string, number>;
}

export const TAU = 2 * Math.PI;
export const add = (p: P2, q: P2): P2 => [p[0] + q[0], p[1] + q[1]];
export const sub = (p: P2, q: P2): P2 => [p[0] - q[0], p[1] - q[1]];
export const mul = (p: P2, s: number): P2 => [p[0] * s, p[1] * s];
export const dot = (p: P2, q: P2) => p[0] * q[0] + p[1] * q[1];
export const cross = (p: P2, q: P2) => p[0] * q[1] - p[1] * q[0];
export const len = (p: P2) => Math.hypot(p[0], p[1]);
export const dist = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
export const norm = (p: P2): P2 => { const l = len(p) || 1; return [p[0] / l, p[1] / l]; };
export const perp = (p: P2): P2 => [-p[1], p[0]];
export const lerp = (p: P2, q: P2, t: number): P2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
export const polar = (c: P2, r: number, a: number): P2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

/** Angle normalized into [0, 2π). */
export function wrap2pi(a: number): number { const x = a % TAU; return x < 0 ? x + TAU : x; }
/** Angle normalized into (-π, π]. */
export function wrapPi(a: number): number { let x = wrap2pi(a); if (x > Math.PI) x -= TAU; return x; }
/** Counter-clockwise sweep of an arc, in (0, 2π]. */
export function arcSweep(a0: number, a1: number): number { const s = wrap2pi(a1 - a0); return s === 0 ? TAU : s; }
/** Is angle t inside the counter-clockwise arc a0 -> a1 (with tolerance in radians)? */
export function angleOnArc(t: number, a0: number, a1: number, tol = 1e-12): boolean {
  const s = arcSweep(a0, a1);
  const d = wrap2pi(t - a0);
  return d <= s + tol || d >= TAU - tol;
}

// ------------------------------------------------------------------ built-ins

/** Fixed references every sketch has. The axes are infinite lines through the origin. */
export const BUILTIN: Record<string, WEntity> = {
  [SKETCH_ORIGIN]: { id: SKETCH_ORIGIN, kind: 'point', p: [0, 0], construction: true },
  [SKETCH_AXIS_H]: { id: SKETCH_AXIS_H, kind: 'line', a: [0, 0], b: [1, 0], construction: true },
  [SKETCH_AXIS_V]: { id: SKETCH_AXIS_V, kind: 'line', a: [0, 0], b: [0, 1], construction: true },
};
export const isBuiltin = (id: string) => id in BUILTIN;

export function entityMap(ents: WEntity[]): Map<string, WEntity> {
  const m = new Map<string, WEntity>();
  for (const b of Object.values(BUILTIN)) m.set(b.id, b);
  for (const e of ents) m.set(e.id, e);
  return m;
}

export const refKey = (r: PointRef) => `${r.e}:${r.p}`;
export const sameRef = (a: PointRef, b: PointRef) => a.e === b.e && a.p === b.p;

/** Every point reference an entity owns. */
export function entityPoints(e: WEntity): PointRef[] {
  switch (e.kind) {
    case 'point': return [{ e: e.id, p: 'point' }];
    case 'line': return [{ e: e.id, p: 'start' }, { e: e.id, p: 'end' }];
    case 'circle': return [{ e: e.id, p: 'center' }];
    case 'arc': return [{ e: e.id, p: 'center' }, { e: e.id, p: 'start' }, { e: e.id, p: 'end' }];
    case 'spline': return e.closed ? [] : [{ e: e.id, p: 'start' }, { e: e.id, p: 'end' }];
  }
}

export function pointOf(e: WEntity, p: PointRef['p']): P2 {
  switch (e.kind) {
    case 'point': if (p === 'point') return e.p; break;
    case 'line': if (p === 'start') return e.a; if (p === 'end') return e.b; break;
    case 'circle': if (p === 'center') return e.c; break;
    case 'arc':
      if (p === 'center') return e.c;
      if (p === 'start') return polar(e.c, e.r, e.a0);
      if (p === 'end') return polar(e.c, e.r, e.a1);
      break;
    case 'spline':
      if (!e.closed && p === 'start') return e.pts[0];
      if (!e.closed && p === 'end') return e.pts[e.pts.length - 1];
      break;
  }
  throw new Error(`${e.kind} ${e.id} has no ${p} point`);
}

export function refPoint(m: Map<string, WEntity>, r: PointRef): P2 {
  const e = m.get(r.e);
  if (!e) throw new Error(`Sketch references missing entity ${r.e}`);
  return pointOf(e, r.p);
}

/** Entity ids a constraint refers to. */
export function constraintRefs(c: SketchConstraint): string[] {
  switch (c.type) {
    case 'coincident': case 'horizontalPoints': case 'verticalPoints': case 'distance': return [c.a.e, c.b.e];
    case 'pointOn': return [c.p.e, c.on];
    case 'horizontal': case 'vertical': case 'fix': case 'radius': case 'diameter': return [c.e];
    case 'parallel': case 'perpendicular': case 'collinear': case 'equal': case 'concentric': case 'tangent': case 'angle': return [c.a, c.b];
    case 'midpoint': return [c.p.e, c.line];
    case 'symmetric': return [c.a.e, c.b.e, c.line];
    case 'pointLineDistance': return [c.p.e, c.line];
    case 'offset': return c.pairs.flatMap((p) => [p.src, p.dst]);
  }
}

/** Point references a constraint uses (for dropping constraints when a point disappears, e.g. on trim). */
export function constraintPointRefs(c: SketchConstraint): PointRef[] {
  switch (c.type) {
    case 'coincident': case 'horizontalPoints': case 'verticalPoints': case 'distance': case 'symmetric': return [c.a, c.b];
    case 'pointOn': case 'midpoint': case 'pointLineDistance': return [c.p];
    default: return [];
  }
}

// ------------------------------------------------------------------ evaluation

/** Evaluate a stored sketch into working geometry (mm/rad). Throws on bad expressions. */
export function evalWorking(sk: SketchFeature, units: LengthUnit, params: Record<string, Quantity>): WSketch {
  const L = (v: ValueExpr) => evalLength(v, units, params);
  const A = (v: ValueExpr) => evalAngle(v, params);
  const entities = sk.entities.map((e): WEntity => {
    const construction = !!e.construction;
    switch (e.kind) {
      case 'point': return { id: e.id, kind: 'point', p: [L(e.p.x), L(e.p.y)], construction };
      case 'line': return { id: e.id, kind: 'line', a: [L(e.p1.x), L(e.p1.y)], b: [L(e.p2.x), L(e.p2.y)], construction };
      case 'circle': return { id: e.id, kind: 'circle', c: [L(e.center.x), L(e.center.y)], r: L(e.radius), construction };
      case 'arc': return { id: e.id, kind: 'arc', c: [L(e.center.x), L(e.center.y)], r: L(e.radius), a0: A(e.startAngle), a1: A(e.endAngle), construction };
      case 'spline': return { id: e.id, kind: 'spline', pts: e.points.map((q) => [L(q.x), L(q.y)] as P2), closed: !!e.closed, construction, ...(e.uniform ? { uniform: true } : {}) };
    }
  });
  const constraints = sk.constraints ?? [];
  const values = evalValues(constraints, units, params);
  return { entities, constraints, values };
}

/** Evaluate every dimension's value expression (mm, or rad for angles). */
export function evalValues(constraints: SketchConstraint[], units: LengthUnit, params: Record<string, Quantity>): Map<string, number> {
  const values = new Map<string, number>();
  for (const c of constraints) {
    if (!isDimension(c)) continue;
    try {
      values.set(c.id, c.type === 'angle' ? evalAngle(c.value, params) : evalLength(c.value, units, params));
    } catch (e) {
      throw new Error(`Dimension ${c.id}: ${(e as Error).message}`);
    }
  }
  return values;
}

/** Convert working geometry back to stored entities (numbers in document units, angles in degrees). */
export function toStoredEntities(ents: WEntity[], units: LengthUnit): SketchEntity[] {
  const k = MM_PER[units];
  const u = (mm: number) => mm / k;
  const deg = (r: number) => (r * 180) / Math.PI;
  return ents.map((e): SketchEntity => {
    const c = e.construction ? { construction: true } : {};
    switch (e.kind) {
      case 'point': return { id: e.id, kind: 'point', p: { x: u(e.p[0]), y: u(e.p[1]) }, ...c };
      case 'line': return { id: e.id, kind: 'line', p1: { x: u(e.a[0]), y: u(e.a[1]) }, p2: { x: u(e.b[0]), y: u(e.b[1]) }, ...c };
      case 'circle': return { id: e.id, kind: 'circle', center: { x: u(e.c[0]), y: u(e.c[1]) }, radius: u(e.r), ...c };
      case 'arc': return { id: e.id, kind: 'arc', center: { x: u(e.c[0]), y: u(e.c[1]) }, radius: u(e.r), startAngle: deg(e.a0), endAngle: deg(e.a1), ...c };
      case 'spline': return { id: e.id, kind: 'spline', points: e.pts.map((q) => ({ x: u(q[0]), y: u(q[1]) })), ...(e.closed ? { closed: true } : {}), ...(e.uniform ? { uniform: true } : {}), ...c };
    }
  });
}

/** True when any stored coordinate is an expression rather than a plain number. */
export function hasExpressionCoordinates(sk: SketchFeature): boolean {
  const isExpr = (v: ValueExpr) => typeof v === 'string' && !/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v);
  return sk.entities.some((e) => {
    switch (e.kind) {
      case 'point': return isExpr(e.p.x) || isExpr(e.p.y);
      case 'line': return [e.p1.x, e.p1.y, e.p2.x, e.p2.y].some(isExpr);
      case 'circle': return [e.center.x, e.center.y, e.radius].some(isExpr);
      case 'arc': return [e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle].some(isExpr);
      case 'spline': return e.points.some((q) => isExpr(q.x) || isExpr(q.y));
    }
  });
}

// ------------------------------------------------------------------ curve math

/** Closest point on a segment (clamped) and its parameter t in [0,1]. */
export function closestOnSegment(p: P2, a: P2, b: P2): { q: P2; t: number } {
  const d = sub(b, a);
  const l2 = dot(d, d);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), d) / l2));
  return { q: lerp(a, b, t), t };
}

/** Closest point on the infinite line through a, b. */
export function closestOnLine(p: P2, a: P2, b: P2): { q: P2; t: number } {
  const d = sub(b, a);
  const l2 = dot(d, d);
  const t = l2 === 0 ? 0 : dot(sub(p, a), d) / l2;
  return { q: lerp(a, b, t), t };
}

/** Distance from p to the drawn extent of an entity (segment, full circle, arc). */
export function distanceToEntity(p: P2, e: WEntity): number {
  switch (e.kind) {
    case 'point': return dist(p, e.p);
    case 'line': return dist(p, closestOnSegment(p, e.a, e.b).q);
    case 'circle': return Math.abs(dist(p, e.c) - e.r);
    case 'arc': {
      const t = Math.atan2(p[1] - e.c[1], p[0] - e.c[0]);
      if (angleOnArc(t, e.a0, e.a1)) return Math.abs(dist(p, e.c) - e.r);
      return Math.min(dist(p, polar(e.c, e.r, e.a0)), dist(p, polar(e.c, e.r, e.a1)));
    }
    case 'spline': return closestOnSpline(splineCurve(e), p).dist;
  }
}

/** Closest point on the drawn extent of a curve entity. */
export function closestOnEntity(p: P2, e: WEntity): P2 {
  switch (e.kind) {
    case 'point': return e.p;
    case 'line': return closestOnSegment(p, e.a, e.b).q;
    case 'circle': return polar(e.c, e.r, Math.atan2(p[1] - e.c[1], p[0] - e.c[0]));
    case 'arc': {
      const t = Math.atan2(p[1] - e.c[1], p[0] - e.c[0]);
      if (angleOnArc(t, e.a0, e.a1)) return polar(e.c, e.r, t);
      const s = polar(e.c, e.r, e.a0), f = polar(e.c, e.r, e.a1);
      return dist(p, s) <= dist(p, f) ? s : f;
    }
    case 'spline': return closestOnSpline(splineCurve(e), p).p;
  }
}

/** Intersections of the full underlying curves (infinite line / full circle) of two entities. */
export function curveIntersections(e1: WEntity, e2: WEntity): P2[] {
  if (e1.kind === 'point' || e2.kind === 'point') return [];
  // Spline intersections are not computed yet (no trim/extend against splines).
  if (e1.kind === 'spline' || e2.kind === 'spline') return [];
  if (e1.kind === 'line' && e2.kind === 'line') {
    const d1 = sub(e1.b, e1.a), d2 = sub(e2.b, e2.a);
    const den = cross(d1, d2);
    if (Math.abs(den) < 1e-14 * len(d1) * len(d2)) return [];
    const t = cross(sub(e2.a, e1.a), d2) / den;
    return [lerp(e1.a, e1.b, t)];
  }
  if (e1.kind === 'line') return lineCircle(e1.a, e1.b, (e2 as any).c, (e2 as any).r);
  if (e2.kind === 'line') return lineCircle(e2.a, e2.b, (e1 as any).c, (e1 as any).r);
  return circleCircle((e1 as any).c, (e1 as any).r, (e2 as any).c, (e2 as any).r);
}

export function lineCircle(a: P2, b: P2, c: P2, r: number): P2[] {
  const { q } = closestOnLine(c, a, b);
  const h = dist(q, c);
  if (h > r * (1 + 1e-12)) return [];
  const dir = norm(sub(b, a));
  const s = Math.sqrt(Math.max(0, r * r - h * h));
  if (s < 1e-12 * r) return [q];
  return [add(q, mul(dir, -s)), add(q, mul(dir, s))];
}

export function circleCircle(c1: P2, r1: number, c2: P2, r2: number): P2[] {
  const d = dist(c1, c2);
  if (d < 1e-14 || d > r1 + r2 + 1e-12 * (r1 + r2) || d < Math.abs(r1 - r2) - 1e-12 * (r1 + r2)) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = norm(sub(c2, c1));
  const m = add(c1, mul(u, a));
  if (h < 1e-12 * r1) return [m];
  return [add(m, mul(perp(u), h)), add(m, mul(perp(u), -h))];
}

/** Is point q (known to be on the underlying curve) within the drawn extent of e? */
export function onExtent(q: P2, e: WEntity, tol = 1e-9): boolean {
  switch (e.kind) {
    case 'point': return dist(q, e.p) <= tol;
    case 'line': { const { t } = closestOnLine(q, e.a, e.b); const l = dist(e.a, e.b); return t >= -tol / l && t <= 1 + tol / l; }
    case 'circle': return true;
    case 'arc': return angleOnArc(Math.atan2(q[1] - e.c[1], q[0] - e.c[0]), e.a0, e.a1, tol / e.r);
    case 'spline': return closestOnSpline(splineCurve(e), q).dist <= tol;
  }
}

/** Intersections of the drawn extents of two entities. */
export function extentIntersections(e1: WEntity, e2: WEntity): P2[] {
  return curveIntersections(e1, e2).filter((q) => onExtent(q, e1) && onExtent(q, e2));
}

/** Parameter of a point along a curve: lines 0..1 from a to b, arcs 0..sweep from a0, circles 0..2π. */
export function curveParam(e: WEntity, q: P2): number {
  if (e.kind === 'line') return closestOnLine(q, e.a, e.b).t;
  if (e.kind === 'arc') return wrap2pi(Math.atan2(q[1] - e.c[1], q[0] - e.c[0]) - e.a0);
  if (e.kind === 'circle') return wrap2pi(Math.atan2(q[1] - e.c[1], q[0] - e.c[0]));
  if (e.kind === 'spline') return closestOnSpline(splineCurve(e), q).t;
  return 0;
}

export function entityBounds(ents: WEntity[]): { min: P2; max: P2 } | null {
  let min: P2 = [Infinity, Infinity], max: P2 = [-Infinity, -Infinity];
  const grow = (p: P2) => { min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])]; max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])]; };
  for (const e of ents) {
    if (e.kind === 'point') grow(e.p);
    else if (e.kind === 'line') { grow(e.a); grow(e.b); }
    else if (e.kind === 'spline') { for (const q of sampleSpline(splineCurve(e), 24)) grow(q); }
    else { grow([e.c[0] - e.r, e.c[1] - e.r]); grow([e.c[0] + e.r, e.c[1] + e.r]); }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** Sample points along an entity for drawing (display only, never used for geometry). */
export function samplePolyline(e: WEntity, segs = 96): P2[] {
  switch (e.kind) {
    case 'point': return [e.p];
    case 'line': return [e.a, e.b];
    case 'circle': return Array.from({ length: segs + 1 }, (_, i) => polar(e.c, e.r, (i / segs) * TAU));
    case 'arc': {
      const s = arcSweep(e.a0, e.a1);
      const n = Math.max(8, Math.ceil((segs * s) / TAU));
      return Array.from({ length: n + 1 }, (_, i) => polar(e.c, e.r, e.a0 + (s * i) / n));
    }
    case 'spline': {
      const c = splineCurve(e);
      return sampleSpline(c, Math.max(8, Math.ceil(segs / Math.max(1, c.params.length - 1))));
    }
  }
}

/** Unit tangent direction of a curve at a point on it, in the curve's natural direction. */
export function tangentAt(e: WEntity, q: P2): P2 {
  if (e.kind === 'line') return norm(sub(e.b, e.a));
  if (e.kind === 'arc' || e.kind === 'circle') return norm(perp(sub(q, e.c)));
  if (e.kind === 'spline') { const c = splineCurve(e); return norm(splineEval(c, closestOnSpline(c, q).t).d); }
  return [1, 0];
}
