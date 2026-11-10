/**
 * Sketch editing operations: trim, extend, offset, sketch fillet, delete,
 * construction toggle. Each takes a working sketch (mm) and returns the new
 * entities and constraints; nothing is committed here (see commands.ts).
 * Relations that no longer make sense (they referred to a point that moved
 * or disappeared) are dropped; new relations keep the result connected.
 */
import type { PointRef, SketchConstraint, OffsetPair } from '../core/model';
import { newId } from '../core/model';
import {
  type P2, type WEntity, type WSketch, add, sub, mul, dot, cross, dist, norm, perp, polar, TAU,
  wrap2pi, arcSweep, closestOnLine, curveIntersections, extentIntersections, onExtent, curveParam, pointOf,
  constraintRefs, constraintPointRefs, entityMap, isBuiltin, sameRef,
} from './geom';
import { tangentPoints } from './equations';

export interface Edit { entities: WEntity[]; constraints: SketchConstraint[] }
export class SketchOpError extends Error {}

const cid = () => newId('cn');
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** Remove entities and every constraint that refers to them. */
export function deleteItems(ws: WSketch, entityIds: Iterable<string>, constraintIds: Iterable<string> = []): Edit {
  const del = new Set(entityIds), delC = new Set(constraintIds);
  return {
    entities: ws.entities.filter((e) => !del.has(e.id)),
    constraints: ws.constraints.filter((c) => !delC.has(c.id) && !constraintRefs(c).some((r) => del.has(r))),
  };
}

export function toggleConstruction(ws: WSketch, ids: Iterable<string>): Edit {
  const s = new Set(ids);
  const ents = ws.entities.filter((e) => s.has(e.id));
  const make = !ents.every((e) => e.construction); // mixed or all solid -> make construction
  return { entities: ws.entities.map((e) => (s.has(e.id) && e.kind !== 'point' ? { ...e, construction: make } : e)), constraints: ws.constraints };
}

/** Drop constraints that use any of the given points (a point that moved to a new place). */
function dropPointConstraints(cs: SketchConstraint[], refs: PointRef[]): SketchConstraint[] {
  return cs.filter((c) => !constraintPointRefs(c).some((r) => refs.some((q) => sameRef(q, r))));
}

/** Rename point references (when a split moves an end to a new entity). */
function remapPoint(cs: SketchConstraint[], from: PointRef, to: PointRef): SketchConstraint[] {
  const m = (r: PointRef) => (sameRef(r, from) ? to : r);
  return cs.map((c) => {
    const x: any = clone(c);
    if ('a' in x && typeof x.a === 'object') x.a = m(x.a);
    if ('b' in x && typeof x.b === 'object') x.b = m(x.b);
    if ('p' in x && typeof x.p === 'object') x.p = m(x.p);
    return x;
  });
}

/** Relation for a new endpoint that sits on another entity: coincident with its point, or on it. */
function attach(ref: PointRef, q: P2, other: WEntity): SketchConstraint {
  if (other.kind === 'line' || other.kind === 'arc') {
    for (const p of ['start', 'end'] as const) if (dist(pointOf(other, p), q) < 1e-7) return { id: cid(), type: 'coincident', a: ref, b: { e: other.id, p } };
  }
  return { id: cid(), type: 'pointOn', p: ref, on: other.id };
}

interface Cut { t: number; q: P2; by: WEntity }

/** Where other entities cross this one, as curve parameters (lines 0..1, arcs 0..sweep, circles 0..2π). */
function cutsOn(ws: WSketch, e: WEntity): Cut[] {
  const out: Cut[] = [];
  for (const o of ws.entities) {
    if (o.id === e.id || o.kind === 'point') continue;
    for (const q of extentIntersections(e, o)) out.push({ t: curveParam(e, q), q, by: o });
  }
  // Sketch points lying on the entity also split it (as in other CAD tools).
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Power trim: remove the piece of `id` between the nearest crossings on
 * either side of the picked point. With no crossings, the whole entity goes.
 */
export function trim(ws: WSketch, id: string, pick: P2): Edit {
  const e = ws.entities.find((x) => x.id === id);
  if (!e || e.kind === 'point') throw new SketchOpError('Pick a line, circle or arc to trim');
  if (e.kind === 'spline') throw new SketchOpError('Splines cannot be trimmed yet; edit their points instead');
  const tp = curveParam(e, pick);
  const eps = e.kind === 'line' ? 1e-9 : 1e-9;
  const end = e.kind === 'line' ? 1 : e.kind === 'arc' ? arcSweep(e.a0, e.a1) : TAU;
  const cuts = cutsOn(ws, e).filter((c) => c.t > eps && c.t < end - eps);
  let cs = ws.constraints;
  let ents = ws.entities.slice();
  const idx = ents.findIndex((x) => x.id === id);

  if (e.kind === 'circle') {
    if (cuts.length < 2) return deleteItems(ws, [id]);
    // Remaining arc: from the first crossing after the pick round to the last crossing before it.
    const after = cuts.find((c) => c.t > tp) ?? cuts[0];
    const before = [...cuts].reverse().find((c) => c.t < tp) ?? cuts[cuts.length - 1];
    const a0 = after.t, a1 = before.t;
    const arc: WEntity = { id, kind: 'arc', c: e.c, r: e.r, a0: wrapPi0(a0), a1: wrapPi0(a0) + (wrap2pi(a1 - a0) || TAU), construction: e.construction };
    ents[idx] = arc;
    cs = cs.concat(attach({ e: id, p: 'start' }, after.q, after.by), attach({ e: id, p: 'end' }, before.q, before.by));
    return { entities: ents, constraints: cs };
  }

  const left = [...cuts].reverse().find((c) => c.t < tp);
  const right = cuts.find((c) => c.t > tp);
  if (!left && !right) return deleteItems(ws, [id]);
  const at = (t: number): P2 => (e.kind === 'line' ? add(e.a, mul(sub(e.b, e.a), t)) : polar(e.c, e.r, e.a0 + t));
  const startRef: PointRef = { e: id, p: 'start' }, endRef: PointRef = { e: id, p: 'end' };

  const piece = (t0: number, t1: number, keepId: string): WEntity => (e.kind === 'line'
    ? { ...e, id: keepId, a: at(t0), b: at(t1) }
    : { ...e, id: keepId, a0: e.a0 + t0, a1: e.a0 + t1 });

  if (left && right) {
    // Split: this entity keeps [0, left]; a new one gets [right, end].
    const nid = newId(e.kind === 'line' ? 'ln' : 'ar');
    ents[idx] = piece(0, left.t, id);
    ents.splice(idx + 1, 0, piece(right.t, end, nid));
    cs = remapPoint(cs, endRef, { e: nid, p: 'end' });
    // Whole-entity relations stay on the first piece; keep the second aligned with it.
    const keep: SketchConstraint[] = e.kind === 'line'
      ? [{ id: cid(), type: 'collinear', a: nid, b: id }]
      : [{ id: cid(), type: 'concentric', a: nid, b: id }, { id: cid(), type: 'equal', a: nid, b: id }];
    // Dimensions/relations measuring this entity's length or using both its ends no longer apply.
    cs = cs.filter((c) => !(c.type === 'distance' && ((c.a.e === id && c.b.e === nid) || (c.a.e === nid && c.b.e === id))));
    cs = cs.concat(keep, attach(endRef, left.q, left.by), attach({ e: nid, p: 'start' }, right.q, right.by));
    return { entities: ents, constraints: cs };
  }
  if (right) { // remove [0, right]
    ents[idx] = piece(right.t, end, id);
    cs = dropPointConstraints(cs, [startRef]).concat(attach(startRef, right.q, right.by));
  } else { // remove [left, end]
    ents[idx] = piece(0, left!.t, id);
    cs = dropPointConstraints(cs, [endRef]).concat(attach(endRef, left!.q, left!.by));
  }
  return { entities: ents, constraints: cs };
}

const wrapPi0 = (a: number) => { const x = wrap2pi(a); return x > Math.PI ? x - TAU : x; };

/** Extend the end of a line or arc nearest the pick to the next entity it would reach. */
export function extend(ws: WSketch, id: string, pick: P2): Edit {
  const e = ws.entities.find((x) => x.id === id);
  if (!e || (e.kind !== 'line' && e.kind !== 'arc')) throw new SketchOpError('Pick a line or arc to extend');
  const useEnd = dist(pick, pointOf(e, 'end')) <= dist(pick, pointOf(e, 'start'));
  const ref: PointRef = { e: id, p: useEnd ? 'end' : 'start' };
  let best: { q: P2; by: WEntity; d: number } | null = null;
  for (const o of ws.entities) {
    if (o.id === id || o.kind === 'point') continue;
    for (const q of curveIntersections(e, o)) {
      if (!onExtent(q, o)) continue;
      let d: number;
      if (e.kind === 'line') {
        const { t } = closestOnLine(q, e.a, e.b);
        d = useEnd ? t - 1 : -t;
      } else {
        const t = wrap2pi(Math.atan2(q[1] - e.c[1], q[0] - e.c[0]) - (useEnd ? e.a1 : e.a0));
        d = useEnd ? t : TAU - t; // travel beyond the end along the arc direction
        if (t === 0) d = 0;
        d = d * e.r;
      }
      if (d > 1e-9 && (!best || d < best.d)) best = { q, by: o, d };
    }
  }
  if (!best) throw new SketchOpError('Nothing to extend to in that direction');
  const ents = ws.entities.map((x) => {
    if (x.id !== id) return x;
    if (x.kind === 'line') return useEnd ? { ...x, b: best!.q } : { ...x, a: best!.q };
    const arc = x as Extract<WEntity, { kind: 'arc' }>;
    const t = Math.atan2(best!.q[1] - arc.c[1], best!.q[0] - arc.c[0]);
    if (useEnd) return { ...arc, a1: arc.a0 + (wrap2pi(t - arc.a0) || TAU) };
    const a0 = t; return { ...arc, a0, a1: a0 + (wrap2pi(arc.a1 - a0) || TAU) };
  });
  const cs = dropPointConstraints(ws.constraints, [ref]).concat(attach(ref, best.q, best.by));
  return { entities: ents, constraints: cs };
}

// ------------------------------------------------------------------ offset

interface ChainItem { e: WEntity; reversed: boolean }

/** Order connected entities into a chain (open or closed). Throws on branching. */
export function orderChain(ws: WSketch, ids: string[]): { items: ChainItem[]; closed: boolean } {
  const m = entityMap(ws.entities);
  const ents = ids.map((id) => m.get(id)!).filter((e) => e && (e.kind === 'line' || e.kind === 'arc' || e.kind === 'circle'));
  if (ents.length === 1 && ents[0].kind === 'circle') return { items: [{ e: ents[0], reversed: false }], closed: true };
  if (ents.some((e) => e.kind === 'circle')) throw new SketchOpError('Offset a circle on its own');
  const tol = 1e-6;
  const ends = (e: WEntity): [P2, P2] => [pointOf(e, 'start'), pointOf(e, 'end')];
  const left = ents.slice();
  // Start from an entity with a free end if there is one (open chain).
  const degree = (p: P2) => ents.reduce((n, e) => n + ends(e).filter((q) => dist(q, p) < tol).length, 0);
  let startIdx = left.findIndex((e) => degree(ends(e)[0]) === 1 || degree(ends(e)[1]) === 1);
  if (startIdx < 0) startIdx = 0;
  const first = left.splice(startIdx, 1)[0];
  const firstRev = degree(ends(first)[1]) === 1 && degree(ends(first)[0]) !== 1;
  const items: ChainItem[] = [{ e: first, reversed: firstRev }];
  let cur = firstRev ? ends(first)[0] : ends(first)[1];
  while (left.length) {
    const i = left.findIndex((e) => ends(e).some((q) => dist(q, cur) < tol));
    if (i < 0) throw new SketchOpError('Selected entities are not one connected chain');
    const e = left.splice(i, 1)[0];
    const rev = dist(ends(e)[1], cur) < tol;
    items.push({ e, reversed: rev });
    cur = rev ? ends(e)[0] : ends(e)[1];
  }
  const startPt = items[0].reversed ? ends(items[0].e)[1] : ends(items[0].e)[0];
  return { items, closed: items.length > 1 && dist(cur, startPt) < tol };
}

/** Entities connected end-to-end with `id` (the whole chain), for picking a chain with one click. */
export function connectedChain(ws: WSketch, id: string): string[] {
  const tol = 1e-6;
  const curves = ws.entities.filter((e) => e.kind === 'line' || e.kind === 'arc');
  const start = ws.entities.find((e) => e.id === id);
  if (!start || start.kind === 'point') return [];
  if (start.kind === 'circle') return [id];
  const out = new Set([id]);
  const queue = [start];
  while (queue.length) {
    const e = queue.pop()!;
    for (const p of [pointOf(e, 'start'), pointOf(e, 'end')]) {
      const touching = curves.filter((o) => !out.has(o.id) && [pointOf(o, 'start'), pointOf(o, 'end')].some((q) => dist(q, p) < tol));
      // Stop at branch points (more than one continuation).
      if (touching.length === 1) { out.add(touching[0].id); queue.push(touching[0]); }
    }
  }
  return [...out];
}

/**
 * Offset a chain by distance d (mm) to the side of `sidePoint`. Corners are
 * re-joined by extending/trimming the offset curves to meet. Adds an offset
 * constraint whose value is the dimension shown to the user.
 */
export function offset(ws: WSketch, ids: string[], d: number, sidePoint: P2, valueExpr: number | string): Edit {
  if (!(d > 0)) throw new SketchOpError('Offset distance must be greater than zero');
  const { items, closed } = orderChain(ws, ids);
  // Which side: left of the chain's travel direction, measured at the entity nearest the side point.
  const leftNormal = (it: ChainItem, q: P2): P2 => {
    const e = it.e;
    let t: P2;
    if (e.kind === 'line') t = norm(sub(e.b, e.a));
    else t = norm(perp(sub(q, (e as any).c)));
    return it.reversed ? perp(mul(t, -1)) : perp(t);
  };
  let nearest = items[0], nd = Infinity, nq: P2 = [0, 0];
  for (const it of items) {
    const q = closestOnLineOrCurve(it.e, sidePoint);
    const dd = dist(q, sidePoint);
    if (dd < nd) { nd = dd; nearest = it; nq = q; }
  }
  const side = dot(sub(sidePoint, nq), leftNormal(nearest, nq)) >= 0 ? 1 : -1;

  const out: WEntity[] = items.map((it) => {
    const e = it.e;
    if (e.kind === 'line') {
      const n = mul(leftNormal(it, e.a), side * d);
      return { id: newId('ln'), kind: 'line', a: add(e.a, n), b: add(e.b, n), construction: e.construction };
    }
    const k = e as Extract<WEntity, { kind: 'arc' | 'circle' }>;
    // Left of CCW travel points to the center.
    const towardCenter = (it.reversed ? -1 : 1) * side;
    const r = k.r - towardCenter * d;
    if (!(r > 1e-9)) throw new SketchOpError(`Offset ${d.toFixed(4)} mm is larger than the radius of ${e.id}`);
    return { ...k, id: newId(k.kind === 'arc' ? 'ar' : 'ci'), r } as WEntity;
  });

  // Join consecutive pieces. Smooth joins already meet; sharp corners are extended/trimmed to meet.
  const tangentAt = tangentPoints(ws.constraints);
  const tangentPair = (a: string, b: string) => ws.constraints.some((c) => c.type === 'tangent' && ((c.a === a && c.b === b) || (c.a === b && c.b === a)) && tangentAt.has(c.id));
  const pins: Map<string, Set<'start' | 'end'>> = new Map(out.map((e) => [e.id, new Set()]));
  const joins: SketchConstraint[] = [];
  const endName = (it: ChainItem, leaving: boolean): 'start' | 'end' => (leaving !== it.reversed ? 'end' : 'start');
  const n = items.length;
  const pairs = closed ? n : n - 1;
  for (let i = 0; i < pairs; i++) {
    const j = (i + 1) % n;
    const A = out[i], Bn = out[j];
    const ea = endName(items[i], true), eb = endName(items[j], false);
    const smooth = tangentPair(items[i].e.id, items[j].e.id) || collinearJoin(items[i].e, items[j].e);
    if (smooth) { pins.get(A.id)!.add(ea); pins.get(Bn.id)!.add(eb); continue; }
    const corner = pointOf(items[i].e, endName(items[i], true));
    const cands = curveIntersections(A, Bn);
    if (!cands.length) throw new SketchOpError('The offset curves do not meet at a corner; try a smaller distance');
    const q = cands.reduce((b, c) => (dist(c, corner) < dist(b, corner) ? c : b));
    setEnd(out, i, ea, q); setEnd(out, j, eb, q);
    joins.push({ id: cid(), type: 'coincident', a: { e: A.id, p: ea }, b: { e: Bn.id, p: eb } });
  }
  if (!closed) {
    pins.get(out[0].id)!.add(endName(items[0], false));
    pins.get(out[n - 1].id)!.add(endName(items[n - 1], true));
  }
  for (const e of out) if (e.kind === 'line' && dist(e.a, e.b) < 1e-6) throw new SketchOpError('The offset is too large: a side collapses to zero length');
  const offPairs: OffsetPair[] = items.map((it, i) => {
    const pin = [...pins.get(out[i].id)!];
    return { src: it.e.id, dst: out[i].id, ...(pin.length && out[i].kind !== 'circle' ? { pin } : {}) };
  });
  const offC: SketchConstraint = { id: cid(), type: 'offset', pairs: offPairs, value: valueExpr };
  return { entities: ws.entities.concat(out), constraints: ws.constraints.concat(joins, offC) };
}

function collinearJoin(a: WEntity, b: WEntity): boolean {
  if (a.kind === 'line' && b.kind === 'line') return Math.abs(cross(norm(sub(a.b, a.a)), norm(sub(b.b, b.a)))) < 1e-9;
  return false;
}

function closestOnLineOrCurve(e: WEntity, p: P2): P2 {
  if (e.kind === 'line') return closestOnLine(p, e.a, e.b).q;
  if (e.kind === 'arc' || e.kind === 'circle') return polar(e.c, e.r, Math.atan2(p[1] - e.c[1], p[0] - e.c[0]));
  return (e as any).p;
}

function setEnd(ents: WEntity[], i: number, end: 'start' | 'end', q: P2) {
  const e = ents[i];
  if (e.kind === 'line') ents[i] = end === 'start' ? { ...e, a: q } : { ...e, b: q };
  else if (e.kind === 'arc') {
    const t = Math.atan2(q[1] - e.c[1], q[0] - e.c[0]);
    ents[i] = end === 'start' ? { ...e, a0: t, a1: t + (wrap2pi(e.a1 - t) || TAU) } : { ...e, a1: e.a0 + (wrap2pi(t - e.a0) || TAU) };
  }
}

// ------------------------------------------------------------------ fillet

/**
 * Sketch fillet at a corner where two lines meet: trims both lines back and
 * inserts a tangent arc with a radius dimension.
 */
export function fillet(ws: WSketch, corner: P2, radiusMM: number, radiusExpr: number | string, pickTolMM: number): Edit {
  if (!(radiusMM > 0)) throw new SketchOpError('Fillet radius must be greater than zero');
  const lines = ws.entities.filter((e): e is Extract<WEntity, { kind: 'line' }> => e.kind === 'line' && !e.construction);
  const at: { e: Extract<WEntity, { kind: 'line' }>; end: 'start' | 'end'; p: P2 }[] = [];
  for (const l of lines) for (const end of ['start', 'end'] as const) {
    const p = pointOf(l, end);
    if (dist(p, corner) <= pickTolMM) at.push({ e: l, end, p });
  }
  if (at.length !== 2) throw new SketchOpError(at.length < 2 ? 'Pick a corner where two lines meet' : 'More than two lines meet at that corner');
  const [A, B] = at;
  if (dist(A.p, B.p) > 1e-6) throw new SketchOpError('Those line ends do not meet');
  const P = A.p;
  const ua = norm(sub(pointOf(A.e, A.end === 'start' ? 'end' : 'start'), P));
  const ub = norm(sub(pointOf(B.e, B.end === 'start' ? 'end' : 'start'), P));
  const cosT = Math.max(-1, Math.min(1, dot(ua, ub)));
  const theta = Math.acos(cosT);
  if (theta < 1e-6 || Math.PI - theta < 1e-6) throw new SketchOpError('The lines are parallel; there is no corner to round');
  const t = radiusMM / Math.tan(theta / 2);
  if (t > dist(A.e.a, A.e.b) - 1e-9 || t > dist(B.e.a, B.e.b) - 1e-9) throw new SketchOpError('The radius is too large for these lines');
  const Ta = add(P, mul(ua, t)), Tb = add(P, mul(ub, t));
  const bis = norm(add(ua, ub));
  const c = add(P, mul(bis, radiusMM / Math.sin(theta / 2)));
  const angA = Math.atan2(Ta[1] - c[1], Ta[0] - c[0]), angB = Math.atan2(Tb[1] - c[1], Tb[0] - c[0]);
  // Short way round from Ta to Tb.
  const ccw = wrap2pi(angB - angA) < Math.PI;
  const [a0, a1] = ccw ? [angA, angB] : [angB, angA];
  const arcId = newId('ar');
  const arc: WEntity = { id: arcId, kind: 'arc', c, r: radiusMM, a0, a1: a0 + wrap2pi(a1 - a0), construction: false };
  const refA: PointRef = { e: A.e.id, p: A.end }, refB: PointRef = { e: B.e.id, p: B.end };
  const arcA: PointRef = { e: arcId, p: ccw ? 'start' : 'end' }, arcB: PointRef = { e: arcId, p: ccw ? 'end' : 'start' };
  const ents = ws.entities.map((e) => {
    if (e.id === A.e.id) return A.end === 'start' ? { ...A.e, a: Ta } : { ...A.e, b: Ta };
    if (e.id === B.e.id) return B.end === 'start' ? { ...B.e, a: Tb } : { ...B.e, b: Tb };
    return e;
  });
  ents.push(arc);
  // The sharp corner is gone: relations on it are dropped (the corner point no longer exists).
  const cs = dropPointConstraints(ws.constraints, [refA, refB]).concat(
    { id: cid(), type: 'coincident', a: refA, b: arcA },
    { id: cid(), type: 'coincident', a: refB, b: arcB },
    { id: cid(), type: 'tangent', a: A.e.id, b: arcId },
    { id: cid(), type: 'tangent', a: B.e.id, b: arcId },
    { id: cid(), type: 'radius', e: arcId, value: radiusExpr },
  );
  return { entities: ents, constraints: cs };
}

/** Points where the curve ends of a sketch meet (for fillet picking): returns the nearest corner. */
export function nearestCorner(ws: WSketch, p: P2): P2 | null {
  let best: P2 | null = null, bd = Infinity;
  for (const e of ws.entities) {
    if (e.kind !== 'line') continue;
    for (const q of [e.a, e.b]) { const d = dist(q, p); if (d < bd) { bd = d; best = q; } }
  }
  return best;
}

export { isBuiltin };
