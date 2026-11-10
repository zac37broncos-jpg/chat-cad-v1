/**
 * Inference while sketching: snapping the cursor to existing points,
 * midpoints, curves and alignments, and the relations that snapping implies
 * (coincident, point-on, midpoint, horizontal, vertical). Holding Ctrl
 * turns inference off, as in other professional CAD tools. No DOM.
 */
import type { PointRef, SketchConstraint } from '../core/model';
import { newId } from '../core/model';
import {
  type P2, type WEntity, dist, closestOnEntity, distanceToEntity, extentIntersections, entityPoints, pointOf, lerp, BUILTIN,
} from './geom';

export type SnapKind = 'endpoint' | 'center' | 'midpoint' | 'origin' | 'point' | 'intersection' | 'on' | 'none';

export interface Snap {
  p: P2;
  kind: SnapKind;
  /** Snapped onto this existing point. */
  ref?: PointRef;
  /** Snapped onto this curve (or the midpoint of this line). */
  on?: string;
  /** For intersections: the two curves. */
  on2?: [string, string];
  /** Dashed alignment guides to draw (from an existing point to the cursor). */
  guides: { from: P2; to: P2 }[];
}

export interface SnapOptions {
  /** Snap radius in mm (about 10 screen pixels). */
  tol: number;
  /** Entities to ignore (the one being drawn). */
  exclude?: Set<string>;
  /** Point refs to ignore (e.g. the start of the line being drawn, to allow closing elsewhere). */
  excludeRefs?: PointRef[];
  /** No snapping at all (Ctrl held). */
  off?: boolean;
}

/** Find the best snap for the cursor. Priority: points, midpoints, intersections, curves, alignment. */
export function snap(entities: WEntity[], cursor: P2, o: SnapOptions): Snap {
  if (o.off) return { p: cursor, kind: 'none', guides: [] };
  const ents = entities.filter((e) => !o.exclude?.has(e.id));
  const pts: { ref: PointRef; p: P2; kind: SnapKind }[] = [{ ref: { e: 'origin', p: 'point' }, p: [0, 0], kind: 'origin' }];
  for (const e of ents) {
    for (const r of entityPoints(e)) {
      if (o.excludeRefs?.some((x) => x.e === r.e && x.p === r.p)) continue;
      pts.push({ ref: r, p: pointOf(e, r.p), kind: r.p === 'center' ? 'center' : e.kind === 'point' ? 'point' : 'endpoint' });
    }
  }
  // 1. existing points
  let best: { d: number; s: Snap } | null = null;
  for (const q of pts) {
    const d = dist(q.p, cursor);
    if (d <= o.tol && (!best || d < best.d)) best = { d, s: { p: q.p, kind: q.kind, ref: q.ref, guides: [] } };
  }
  if (best) return best.s;
  // 2. line midpoints
  for (const e of ents) {
    if (e.kind !== 'line') continue;
    const m = lerp(e.a, e.b, 0.5);
    const d = dist(m, cursor);
    if (d <= o.tol * 0.8 && (!best || d < best.d)) best = { d, s: { p: m, kind: 'midpoint', on: e.id, guides: [] } };
  }
  if (best) return best.s;
  // 3. intersections of two curves
  const curves = ents.filter((e) => e.kind !== 'point');
  for (let i = 0; i < curves.length; i++) for (let j = i + 1; j < curves.length; j++) {
    for (const q of extentIntersections(curves[i], curves[j])) {
      const d = dist(q, cursor);
      if (d <= o.tol && (!best || d < best.d)) best = { d, s: { p: q, kind: 'intersection', on2: [curves[i].id, curves[j].id], guides: [] } };
    }
  }
  if (best) return best.s;
  // 4. on a curve (also the sketch axes)
  for (const e of [...curves, BUILTIN.axisH, BUILTIN.axisV]) {
    const isAxis = e.id === 'axisH' || e.id === 'axisV';
    const d = isAxis ? axisDistance(e, cursor) : distanceToEntity(cursor, e);
    if (d <= o.tol * 0.6 && (!best || d < best.d)) {
      const p = isAxis ? (e.id === 'axisH' ? [cursor[0], 0] as P2 : [0, cursor[1]] as P2) : closestOnEntity(cursor, e);
      best = { d, s: { p, kind: 'on', on: e.id, guides: [] } };
    }
  }
  if (best) return best.s;
  // 5. horizontal / vertical alignment with existing points (no relation is added)
  let p: P2 = cursor;
  const guides: { from: P2; to: P2 }[] = [];
  let bx: { d: number; q: P2 } | null = null, by: { d: number; q: P2 } | null = null;
  for (const q of pts) {
    const dx = Math.abs(q.p[0] - cursor[0]), dy = Math.abs(q.p[1] - cursor[1]);
    if (dx <= o.tol * 0.6 && (!bx || dx < bx.d)) bx = { d: dx, q: q.p };
    if (dy <= o.tol * 0.6 && (!by || dy < by.d)) by = { d: dy, q: q.p };
  }
  if (bx) p = [bx.q[0], p[1]];
  if (by) p = [p[0], by.q[1]];
  if (bx) guides.push({ from: bx.q, to: p });
  if (by) guides.push({ from: by.q, to: p });
  return { p, kind: 'none', guides };
}

function axisDistance(e: WEntity, p: P2): number { return e.id === 'axisH' ? Math.abs(p[1]) : Math.abs(p[0]); }

/** Relations implied by placing point `ref` at a snap. */
export function snapRelations(ref: PointRef, s: Snap): SketchConstraint[] {
  const id = () => newId('cn');
  if (s.ref) return [{ id: id(), type: 'coincident', a: ref, b: s.ref }];
  if (s.kind === 'midpoint' && s.on) return [{ id: id(), type: 'midpoint', p: ref, line: s.on }];
  if (s.kind === 'intersection' && s.on2) return s.on2.map((on) => ({ id: id(), type: 'pointOn', p: ref, on }) as SketchConstraint);
  if (s.kind === 'on' && s.on) return [{ id: id(), type: 'pointOn', p: ref, on: s.on }];
  return [];
}

/**
 * Horizontal / vertical inference for a line being drawn from `from`: if the
 * cursor is within `tol` (mm) of level or plumb, lock it there.
 */
export function lineInference(from: P2, cursor: P2, tol: number, off = false): { p: P2; rel: 'horizontal' | 'vertical' | null } {
  if (off) return { p: cursor, rel: null };
  const dx = cursor[0] - from[0], dy = cursor[1] - from[1];
  if (Math.abs(dy) <= tol && Math.abs(dx) > tol) return { p: [cursor[0], from[1]], rel: 'horizontal' };
  if (Math.abs(dx) <= tol && Math.abs(dy) > tol) return { p: [from[0], cursor[1]], rel: 'vertical' };
  return { p: cursor, rel: null };
}

/** Entity nearest the cursor within tol (points win over curves), for hover/selection. */
export function pickEntity(entities: WEntity[], cursor: P2, tol: number): { id: string; point?: PointRef } | null {
  let best: { d: number; id: string; point?: PointRef } | null = null;
  for (const e of entities) {
    for (const r of entityPoints(e)) {
      const d = dist(pointOf(e, r.p), cursor);
      if (d <= tol && (!best || d < best.d)) best = { d, id: e.id, point: r };
    }
  }
  if (best) return { id: best.id, point: best.point };
  for (const e of entities) {
    if (e.kind === 'point') continue;
    const d = distanceToEntity(cursor, e);
    if (d <= tol && (!best || d < best.d)) best = { d, id: e.id };
  }
  return best ? { id: best.id } : null;
}
