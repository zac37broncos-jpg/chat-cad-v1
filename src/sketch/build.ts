/**
 * Builders for the drawing tools: each returns new working entities plus
 * the relations a professional sketcher adds automatically (a rectangle's
 * corners are coincident and its sides horizontal/vertical, a tangent arc
 * is tangent, ...). All coordinates in mm.
 */
import type { PointRef, SketchConstraint } from '../core/model';
import { newId } from '../core/model';
import { type P2, type WEntity, sub, add, mul, dot, cross, dist, norm, perp, TAU, wrap2pi } from './geom';

export interface Built { entities: WEntity[]; constraints: SketchConstraint[]; /** Where each picked input point ended up. */ picks: PointRef[] }

const cid = () => newId('cn');
const co = (a: PointRef, b: PointRef): SketchConstraint => ({ id: cid(), type: 'coincident', a, b });

export function buildLine(a: P2, b: P2, construction = false): Built {
  const id = newId('ln');
  return { entities: [{ id, kind: 'line', a, b, construction }], constraints: [], picks: [{ e: id, p: 'start' }, { e: id, p: 'end' }] };
}

export function buildPoint(p: P2): Built {
  const id = newId('pt');
  return { entities: [{ id, kind: 'point', p, construction: false }], constraints: [], picks: [{ e: id, p: 'point' }] };
}

/** Axis-aligned rectangle from two opposite corners. picks[0] = first corner, picks[1] = opposite corner. */
export function buildCornerRect(p1: P2, p2: P2, construction = false): Built {
  const c: P2[] = [p1, [p2[0], p1[1]], p2, [p1[0], p2[1]]];
  const ids = [0, 1, 2, 3].map(() => newId('ln'));
  const entities: WEntity[] = ids.map((id, i) => ({ id, kind: 'line', a: c[i], b: c[(i + 1) % 4], construction }));
  const constraints: SketchConstraint[] = [];
  for (let i = 0; i < 4; i++) constraints.push(co({ e: ids[i], p: 'end' }, { e: ids[(i + 1) % 4], p: 'start' }));
  constraints.push(
    { id: cid(), type: 'horizontal', e: ids[0] }, { id: cid(), type: 'horizontal', e: ids[2] },
    { id: cid(), type: 'vertical', e: ids[1] }, { id: cid(), type: 'vertical', e: ids[3] },
  );
  return { entities, constraints, picks: [{ e: ids[0], p: 'start' }, { e: ids[2], p: 'start' }] };
}

/** Rectangle from its center and one corner, with construction diagonals and a center point (picks[0]). */
export function buildCenterRect(center: P2, corner: P2, construction = false): Built {
  const opp: P2 = [2 * center[0] - corner[0], 2 * center[1] - corner[1]];
  const r = buildCornerRect(opp, corner, construction);
  const [l1, , l3] = r.entities.map((e) => e.id);
  const d1 = newId('ln'), d2 = newId('ln'), pc = newId('pt');
  const e = r.entities as Extract<WEntity, { kind: 'line' }>[];
  r.entities.push(
    { id: d1, kind: 'line', a: e[0].a, b: e[2].a, construction: true },
    { id: d2, kind: 'line', a: e[1].a, b: e[3].a, construction: true },
    { id: pc, kind: 'point', p: center, construction: false },
  );
  r.constraints.push(
    co({ e: d1, p: 'start' }, { e: l1, p: 'start' }), co({ e: d1, p: 'end' }, { e: l3, p: 'start' }),
    co({ e: d2, p: 'start' }, { e: e[1].id, p: 'start' }), co({ e: d2, p: 'end' }, { e: e[3].id, p: 'start' }),
    { id: cid(), type: 'midpoint', p: { e: pc, p: 'point' }, line: d1 },
  );
  return { ...r, picks: [{ e: pc, p: 'point' }, { e: l3, p: 'start' }] };
}

export function buildCircle(center: P2, through: P2, construction = false): Built {
  const id = newId('ci');
  return { entities: [{ id, kind: 'circle', c: center, r: dist(center, through), construction }], constraints: [], picks: [{ e: id, p: 'center' }] };
}

/** Circle through three points (null if collinear). */
export function circleThrough(p1: P2, p2: P2, p3: P2): { c: P2; r: number } | null {
  const d = 2 * (p1[0] * (p2[1] - p3[1]) + p2[0] * (p3[1] - p1[1]) + p3[0] * (p1[1] - p2[1]));
  const scale = Math.max(dist(p1, p2), dist(p2, p3), dist(p1, p3));
  if (Math.abs(d) < 1e-9 * scale * scale) return null;
  const s1 = dot(p1, p1), s2 = dot(p2, p2), s3 = dot(p3, p3);
  const c: P2 = [
    (s1 * (p2[1] - p3[1]) + s2 * (p3[1] - p1[1]) + s3 * (p1[1] - p2[1])) / d,
    (s1 * (p3[0] - p2[0]) + s2 * (p1[0] - p3[0]) + s3 * (p2[0] - p1[0])) / d,
  ];
  return { c, r: dist(c, p1) };
}

/** Arc from p1 to p2 passing through p3. picks: [p1 end, p2 end]. */
export function buildArc3(p1: P2, p2: P2, p3: P2, construction = false): Built | null {
  const k = circleThrough(p1, p2, p3);
  if (!k) return null;
  const t1 = Math.atan2(p1[1] - k.c[1], p1[0] - k.c[0]);
  const t2 = Math.atan2(p2[1] - k.c[1], p2[0] - k.c[0]);
  const t3 = Math.atan2(p3[1] - k.c[1], p3[0] - k.c[0]);
  const ccw = wrap2pi(t3 - t1) < wrap2pi(t2 - t1); // p3 lies on the CCW path p1 -> p2
  const id = newId('ar');
  const [a0, a1] = ccw ? [t1, t2] : [t2, t1];
  return {
    entities: [{ id, kind: 'arc', c: k.c, r: k.r, a0, a1: a0 + wrap2pi(a1 - a0), construction }],
    constraints: [],
    picks: ccw ? [{ e: id, p: 'start' }, { e: id, p: 'end' }] : [{ e: id, p: 'end' }, { e: id, p: 'start' }],
  };
}

/** Center-point arc: radius from the start point; the end only sets the angle. ccw chooses the direction. */
export function buildCenterArc(c: P2, start: P2, end: P2, ccw: boolean, construction = false): Built | null {
  const r = dist(c, start);
  if (r < 1e-9) return null;
  const ts = Math.atan2(start[1] - c[1], start[0] - c[0]);
  const te = Math.atan2(end[1] - c[1], end[0] - c[0]);
  const id = newId('ar');
  const [a0, a1] = ccw ? [ts, te] : [te, ts];
  const sweep = wrap2pi(a1 - a0) || TAU;
  return {
    entities: [{ id, kind: 'arc', c, r, a0, a1: a0 + sweep, construction }],
    constraints: [],
    picks: [{ e: id, p: 'center' }, ccw ? { e: id, p: 'start' } : { e: id, p: 'end' }, ccw ? { e: id, p: 'end' } : { e: id, p: 'start' }],
  };
}

/**
 * Tangent arc leaving point `from` (an endpoint of `fromEntity`) in direction
 * `t`, ending at `to`. Adds coincident + tangent relations.
 */
export function buildTangentArc(from: PointRef, fromPos: P2, t: P2, to: P2, fromEntity: string, construction = false): Built | null {
  const d = sub(to, fromPos);
  const n = perp(norm(t));
  const den = 2 * dot(n, d);
  if (Math.abs(den) < 1e-9 * Math.max(1, dot(d, d))) return null; // straight ahead: use a line
  const s = dot(d, d) / den;
  const c = add(fromPos, mul(n, s));
  const r = Math.abs(s);
  const ccw = cross(t, d) > 0;
  const tf = Math.atan2(fromPos[1] - c[1], fromPos[0] - c[0]);
  const tt = Math.atan2(to[1] - c[1], to[0] - c[0]);
  const id = newId('ar');
  const [a0, a1] = ccw ? [tf, tt] : [tt, tf];
  const fromEnd: PointRef = { e: id, p: ccw ? 'start' : 'end' };
  return {
    entities: [{ id, kind: 'arc', c, r, a0, a1: a0 + (wrap2pi(a1 - a0) || TAU), construction }],
    constraints: [co(from, fromEnd), { id: cid(), type: 'tangent', a: fromEntity, b: id }],
    picks: [fromEnd, { e: id, p: ccw ? 'end' : 'start' }],
  };
}

/** Direction a curve is travelling when it arrives at one of its endpoints (for tangent arcs). */
export function exitDirection(e: WEntity, end: 'start' | 'end'): P2 | null {
  if (e.kind === 'line') return norm(end === 'end' ? sub(e.b, e.a) : sub(e.a, e.b));
  if (e.kind === 'arc') {
    const a = end === 'end' ? e.a1 : e.a0;
    const tan: P2 = [-Math.sin(a), Math.cos(a)]; // CCW travel direction
    return end === 'end' ? tan : mul(tan, -1);
  }
  return null;
}

/**
 * Straight Slot from its two arc centers (mainstream CAD "Straight Slot": click
 * the two ends, then the width). Two semicircles joined by two tangent
 * lines, plus a construction centerline between the arc centers. Free DOF:
 * the two centers and the width (5). picks: [first center, second center].
 */
export function buildSlot(c1: P2, c2: P2, halfWidth: number, construction = false): Built | null {
  const len = dist(c1, c2);
  if (len < 1e-9 || !(halfWidth > 1e-9)) return null;
  const u = norm(sub(c2, c1)), n = perp(u);
  const w = halfWidth;
  const an = Math.atan2(n[1], n[0]);
  const l1 = newId('ln'), l2 = newId('ln'), a1 = newId('ar'), a2 = newId('ar'), cl = newId('ln');
  const entities: WEntity[] = [
    { id: l1, kind: 'line', a: add(c1, mul(n, w)), b: add(c2, mul(n, w)), construction },
    { id: l2, kind: 'line', a: sub(c2, mul(n, w)), b: sub(c1, mul(n, w)), construction },
    // Arc at c1 from +n round through -u to -n; arc at c2 from -n round through +u to +n (both counter-clockwise).
    { id: a1, kind: 'arc', c: c1, r: w, a0: an, a1: an + Math.PI, construction },
    { id: a2, kind: 'arc', c: c2, r: w, a0: an + Math.PI, a1: an + TAU, construction },
    { id: cl, kind: 'line', a: c1, b: c2, construction: true },
  ];
  const constraints: SketchConstraint[] = [
    co({ e: l1, p: 'start' }, { e: a1, p: 'start' }), co({ e: l2, p: 'end' }, { e: a1, p: 'end' }),
    co({ e: l2, p: 'start' }, { e: a2, p: 'start' }), co({ e: l1, p: 'end' }, { e: a2, p: 'end' }),
    co({ e: cl, p: 'start' }, { e: a1, p: 'center' }), co({ e: cl, p: 'end' }, { e: a2, p: 'center' }),
    { id: cid(), type: 'tangent', a: l1, b: a1 }, { id: cid(), type: 'tangent', a: l1, b: a2 },
    { id: cid(), type: 'tangent', a: l2, b: a1 }, { id: cid(), type: 'tangent', a: l2, b: a2 },
    { id: cid(), type: 'equal', a: a1, b: a2 },
  ];
  return { entities, constraints, picks: [{ e: cl, p: 'start' }, { e: cl, p: 'end' }] };
}

/**
 * Regular polygon with a construction circle that sets its size (mainstream CAD
 * Polygon command panel): click the center, then a second point.
 *
 * - 'circumscribed' (mainstream CAD "Circumscribed circle", the circle outside
 *   the polygon): the second click is a vertex; every vertex is on the
 *   circle and all sides are equal.
 * - 'inscribed' (mainstream CAD "Inscribed circle", the circle inside the
 *   polygon): the second click is the middle of a side; every side is
 *   tangent to the circle and all sides are equal. With an even number of
 *   sides that still allows a "rhombus" shear, so a construction line from
 *   the center meets side 1 square at its middle, and one equal relation,
 *   implied by the rest (Pitot's theorem), is left out.
 *
 * Either way it stays regular when you drag or dimension it. Free DOF:
 * center (2), size (1), rotation (1). picks: [center, second click] (an
 * odd inscribed polygon has no point at the second click, so only [center]).
 */
export function buildPolygon(center: P2, second: P2, sides: number, construction = false, circle: 'inscribed' | 'circumscribed' = 'circumscribed'): Built | null {
  const d = dist(center, second);
  if (d < 1e-9 || !Number.isInteger(sides) || sides < 3 || sides > 40) return null;
  const t0 = Math.atan2(second[1] - center[1], second[0] - center[0]);
  const inscribed = circle === 'inscribed';
  // Inscribed: `second` is the middle of side 0, so the vertices sit half a step either side of it.
  const R = inscribed ? d / Math.cos(Math.PI / sides) : d;
  const start = inscribed ? t0 - Math.PI / sides : t0;
  const pts: P2[] = Array.from({ length: sides }, (_, k) => {
    const t = start + (TAU * k) / sides;
    return [center[0] + R * Math.cos(t), center[1] + R * Math.sin(t)];
  });
  const ci = newId('ci');
  const ids = pts.map(() => newId('ln'));
  const entities: WEntity[] = [
    ...ids.map((id, k): WEntity => ({ id, kind: 'line', a: pts[k], b: pts[(k + 1) % sides], construction })),
    { id: ci, kind: 'circle', c: center, r: d, construction: true },
  ];
  const constraints: SketchConstraint[] = [];
  const even = sides % 2 === 0;
  for (let k = 0; k < sides; k++) {
    constraints.push(co({ e: ids[k], p: 'end' }, { e: ids[(k + 1) % sides], p: 'start' }));
    if (inscribed) constraints.push({ id: cid(), type: 'tangent', a: ids[k], b: ci });
    else constraints.push({ id: cid(), type: 'pointOn', p: { e: ids[k], p: 'start' }, on: ci });
    if (k > 0 && !(inscribed && even && k === sides - 1)) constraints.push({ id: cid(), type: 'equal', a: ids[0], b: ids[k] });
  }
  const picks: PointRef[] = [{ e: ci, p: 'center' }];
  if (!inscribed) picks.push({ e: ids[0], p: 'start' });
  if (inscribed && even) {
    // A construction line from the center to the middle of side 1, square to it.
    const ap = newId('ln');
    picks.push({ e: ap, p: 'end' });
    entities.push({ id: ap, kind: 'line', a: [...center] as P2, b: [...second] as P2, construction: true });
    constraints.push(co({ e: ap, p: 'start' }, { e: ci, p: 'center' }));
    constraints.push({ id: cid(), type: 'midpoint', p: { e: ap, p: 'end' }, line: ids[0] } as SketchConstraint);
    constraints.push({ id: cid(), type: 'perpendicular', a: ap, b: ids[0] } as SketchConstraint);
  }
  return { entities, constraints, picks };
}
