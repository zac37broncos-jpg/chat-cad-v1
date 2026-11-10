/**
 * Hole: simple (clearance), counterbore, countersink and tapped holes
 * from standard tables (src/core/holeTables.ts), at one or more points on a
 * plane or planar face. Each hole is an exact revolved profile cut from the
 * solid. Tapped holes are modelled at the tap drill diameter (the thread is
 * recorded for drawings as a cosmetic thread, like pro CAD).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { HoleFeature } from '../../core/featureTypes';
import { holeSpec, type HoleSpec } from '../../core/holeTables';
import { MM_PER } from '../../core/units';
import { checkDone, bboxInfo, trackedBool, checkedBool, to3d } from '../regen';
import { type Named, nameShape, listOf } from '../naming';
import { freeAll } from '../mem';
import { type FeatureContext, type FeatureResult, needBody, planeOf, L, A, posLength, add, scale, type RefGeometry } from './index';
import type { Vec3 } from '../../core/featureTypes';

/** The resolved hole: every size in mm. */
export interface HoleDims {
  spec: HoleSpec;
  diameter: number;
  through: boolean;
  depth: number;
  threadDepth?: number;
  drillPoint: number;
  cboreDiameter?: number;
  cboreDepth?: number;
  cskDiameter?: number;
  cskAngle?: number;
}

export function holeDims(ctx: FeatureContext, f: HoleFeature, throughLen: () => number): HoleDims {
  const spec = holeSpec(f.standard, f.holeType, f.size, f.fit);
  const k = MM_PER[spec.unit];
  const opt = (v: HoleFeature['diameter'], table: number | undefined, what: string) => (v !== undefined && v !== '' ? posLength(ctx, v, what) : table !== undefined ? table * k : undefined);
  const diameter = opt(f.diameter, spec.diameter, 'Hole diameter')!;
  const through = f.end === 'through';
  let threadDepth: number | undefined;
  let depth: number;
  if (through) depth = throughLen();
  else if (f.holeType === 'tapped') {
    threadDepth = f.threadDepth !== undefined ? posLength(ctx, f.threadDepth, 'Thread depth') : 2 * spec.nominal * k;
    // Default drill depth: thread depth plus 3 thread pitches of run-out for the tap.
    depth = f.depth !== undefined ? posLength(ctx, f.depth, 'Tap drill depth') : threadDepth + 3 * (spec.thread?.pitch ?? 0) * k;
    if (depth < threadDepth - 1e-9) throw new Error('Tap drill depth must be at least the thread depth');
  } else depth = posLength(ctx, f.depth, 'Hole depth');
  const drillPoint = through ? 0 : f.drillPoint !== undefined ? A(ctx, f.drillPoint) : (118 * Math.PI) / 180;
  if (drillPoint < 0 || drillPoint >= Math.PI) throw new Error('Drill point angle must be between 0 (flat) and 180 degrees');
  const d: HoleDims = { spec, diameter, through, depth, drillPoint, ...(threadDepth !== undefined ? { threadDepth } : {}) };
  if (f.holeType === 'counterbore') {
    d.cboreDiameter = opt(f.cboreDiameter, spec.cboreDiameter, 'Counterbore diameter');
    d.cboreDepth = opt(f.cboreDepth, spec.cboreDepth, 'Counterbore depth');
    if (!d.cboreDiameter || !d.cboreDepth) throw new Error('Counterbore diameter and depth are required');
    if (d.cboreDiameter <= diameter) throw new Error('Counterbore diameter must be larger than the hole');
    if (!through && d.cboreDepth >= depth) throw new Error('Counterbore depth must be less than the hole depth');
  }
  if (f.holeType === 'countersink') {
    d.cskDiameter = opt(f.cskDiameter, spec.cskDiameter, 'Countersink diameter');
    d.cskAngle = f.cskAngle !== undefined ? A(ctx, f.cskAngle) : ((spec.cskAngle ?? 82) * Math.PI) / 180;
    if (!d.cskDiameter) throw new Error('Countersink diameter is required');
    if (d.cskDiameter <= diameter) throw new Error('Countersink diameter must be larger than the hole');
    if (!(d.cskAngle > 0 && d.cskAngle < Math.PI)) throw new Error('Countersink angle must be between 0 and 180 degrees');
    if (!through && (d.cskDiameter - diameter) / 2 / Math.tan(d.cskAngle / 2) >= depth) throw new Error('The countersink is deeper than the hole');
  }
  return d;
}

/** Hole profile in (radius, depth-below-surface), closed along the axis, with a name per segment. */
export function holeProfile(d: HoleDims): { pts: [number, number][]; names: string[] } {
  const r = d.diameter / 2;
  const pts: [number, number][] = [[0, 0]];
  const names: string[] = [];
  if (d.cboreDiameter !== undefined && d.cboreDepth !== undefined) {
    const rc = d.cboreDiameter / 2;
    pts.push([rc, 0], [rc, d.cboreDepth], [r, d.cboreDepth]);
    names.push('top', 'cbore', 'cbore-floor');
  } else if (d.cskDiameter !== undefined && d.cskAngle !== undefined) {
    const rk = d.cskDiameter / 2;
    pts.push([rk, 0], [r, (rk - r) / Math.tan(d.cskAngle / 2)]);
    names.push('top', 'csk');
  } else {
    pts.push([r, 0]);
    names.push('top');
  }
  pts.push([r, d.depth]);
  names.push('wall');
  if (d.drillPoint > 0) { pts.push([0, d.depth + r / Math.tan(d.drillPoint / 2)]); names.push('drill-point'); }
  else { pts.push([0, d.depth]); names.push('bottom'); }
  names.push('axis');
  return { pts, names };
}

export function holeFeature(ctx: FeatureContext, f: HoleFeature): FeatureResult {
  const { oc, gc } = ctx;
  const body = needBody(ctx, 'A hole');
  if (!f.points?.length) throw new Error('Give at least one hole position');
  const fr = planeOf(ctx, f.placement);
  const into: Vec3 = f.flip ? fr.n : scale(fr.n, -1);
  const throughLen = () => { const b = bboxInfo(oc, body.shape); return b.diagonal * 2 + Math.hypot(b.center[0] - fr.o[0], b.center[1] - fr.o[1], b.center[2] - fr.o[2]) + 10; };
  const d = holeDims(ctx, f, throughLen);
  const { pts, names } = holeProfile(d);
  let tool: Named | null = null;
  f.points.forEach((p, i) => {
    const c = to3d(fr, L(ctx, p.x), L(ctx, p.y));
    const P = (q: [number, number]): Vec3 => add(add(c, scale(fr.x, q[0])), scale(into, q[1]));
    const mw = gc.t(new oc.BRepBuilderAPI_MakeWire());
    const edges: TopoDS_Shape[] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = P(pts[k]), b = P(pts[(k + 1) % pts.length]);
      const me = gc.t(new oc.BRepBuilderAPI_MakeEdge(gc.t(new oc.gp_Pnt(...a)), gc.t(new oc.gp_Pnt(...b))));
      if (!me.IsDone()) throw new Error('Hole profile is degenerate');
      const e = gc.t(me.Edge());
      edges.push(e);
      mw.Add(e);
    }
    const mf = gc.t(new oc.BRepBuilderAPI_MakeFace(gc.t(mw.Wire()), true));
    if (!mf.IsDone()) throw new Error('Could not build the hole profile');
    const profile = gc.t(mf.Face());
    const ax = gc.t(new oc.gp_Ax1(gc.t(new oc.gp_Pnt(...c)), gc.t(new oc.gp_Dir(...into))));
    const rv = gc.t(new oc.BRepPrimAPI_MakeRevol(profile, ax, 2 * Math.PI, false));
    checkDone(rv, 'Hole');
    const shape = rv.Shape();
    const tagOf = new Map<number, string>();
    const named = nameShape(oc, shape, () => []);
    const ex = new oc.TopExp_Explorer(profile, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
      const e = ex.Current();
      const k = edges.findIndex((x) => x.IsSame(e));
      let gen: TopoDS_Shape[] = [];
      try { gen = listOf(oc, rv.Generated(e)); } catch { /* axis edge */ }
      for (const g of gen) { const j = named.faces.findIndex((x) => x.IsSame(g)); if (j >= 0 && k >= 0) tagOf.set(j, names[k]); }
      freeAll(gen); e.delete();
    }
    ex.delete();
    named.tags = named.faces.map((_, j) => [`${f.id}:${tagOf.get(j) ?? 'face'}:${i}`, `${f.id}:${tagOf.get(j) ?? 'face'}`]);
    tool = tool ? trackedBool(oc, 'fuse', tool, named, f.id) : named;
  });
  ctx.tools.set(f.id, { tool: tool!, op: 'cut' });
  return { body: checkedBool(oc, 'cut', body, tool!, f.id, f.name), tool };
}

export type { RefGeometry };
