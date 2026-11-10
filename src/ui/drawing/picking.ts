/**
 * Hit testing and snapping on composed drawing sheets (paper mm).
 */
import { add, dist, distanceToCurve, distToSeg, mul, sub, type V2 } from '../../drawing/geom2d';
import type { ComposeResult, ResolvedView, Snap } from '../../drawing/compose';
import { textBox } from '../../drawing/prims';

/** Owner id under the cursor: annotations first, then view geometry, then inside a view's box. */
export function pickOwner(res: ComposeResult, p: V2, tol: number): string | null {
  let best: { id: string; d: number; pri: number } | null = null;
  const consider = (id: string | undefined, d: number, pri: number) => {
    if (!id || id === 'format' || d > tol) return;
    if (!best || pri < best.pri || (pri === best.pri && d < best.d)) best = { id, d, pri };
  };
  const isView = (id: string) => res.views.some((v) => v.view.id === id);
  for (const pr of res.prims) {
    if (!pr.owner || pr.owner === 'format') continue;
    const pri = isView(pr.owner) ? 2 : 1;
    if (pr.t === 'curve') consider(pr.owner, distanceToCurve(p, pr.cv), pri);
    else if (pr.t === 'text') {
      const b = textBox(pr);
      const inside = p[0] >= b.min[0] - tol && p[0] <= b.max[0] + tol && p[1] >= b.min[1] - tol && p[1] <= b.max[1] + tol;
      if (inside && !pr.rot) consider(pr.owner, 0, pri);
    } else if (pr.t === 'fill') consider(pr.owner, Math.min(...pr.pts.map((q) => dist(q, p))), pri);
  }
  for (const [id, b] of Object.entries(res.annotationBoxes)) {
    if (p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1]) consider(id, tol * 0.99, 1);
  }
  if (best) return (best as { id: string }).id;
  for (const v of res.views) {
    const m = 3;
    if (p[0] >= v.box.min[0] - m && p[0] <= v.box.max[0] + m && p[1] >= v.box.min[1] - m && p[1] <= v.box.max[1] + m) return v.view.id;
  }
  return null;
}

/** View whose box contains p (smallest wins, so details inside bigger views are found). */
export function viewAt(res: ComposeResult, p: V2, margin = 4): ResolvedView | null {
  let best: ResolvedView | null = null, area = Infinity;
  for (const v of res.views) {
    const b = v.box;
    if (p[0] >= b.min[0] - margin && p[0] <= b.max[0] + margin && p[1] >= b.min[1] - margin && p[1] <= b.max[1] + margin) {
      const a = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]);
      if (a < area) { area = a; best = v; }
    }
  }
  return best;
}

export type SnapHit =
  | { kind: 'point'; p: V2; snap: Extract<Snap, { kind: 'vertex' | 'center' }> }
  | { kind: 'circle'; p: V2; snap: Extract<Snap, { kind: 'center' }> }
  | { kind: 'edge'; p: V2; snap: Extract<Snap, { kind: 'edge' }> };

/** Nearest snap: points (vertices, centres) beat circles, circles beat edges. */
export function findSnap(res: ComposeResult, p: V2, tol: number, viewId?: string): SnapHit | null {
  let pt: SnapHit | null = null, pd = tol * 1.4;
  let ci: SnapHit | null = null, cd = tol;
  let ed: SnapHit | null = null, edd = tol;
  for (const s of res.snaps) {
    if (viewId && s.view !== viewId) continue;
    if (s.kind === 'vertex' || s.kind === 'center') {
      const d = dist(s.p, p);
      if (d < pd) { pd = d; pt = { kind: 'point', p: s.p, snap: s }; }
    }
    if (s.kind === 'center' && s.trueShape) {
      const d = Math.abs(dist(s.p, p) - s.r);
      if (d < cd) { cd = d; const dir = sub(p, s.p); const l = Math.hypot(dir[0], dir[1]) || 1; ci = { kind: 'circle', p: add(s.p, mul(dir, s.r / l)), snap: s }; }
    }
    if (s.kind === 'edge') {
      const d = distToSeg(p, s.a, s.b);
      if (d < edd) { edd = d; ed = { kind: 'edge', p, snap: s }; }
    }
  }
  return pt ?? ci ?? ed;
}
