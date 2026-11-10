/**
 * Regeneration of the modelling features (everything except sketch, extrude
 * and revolve, which live in ../regen.ts). Each feature takes the current
 * named solid and returns the new one, keeping face names (../naming.ts).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { CadDocument, ValueExpr } from '../../core/model';
import type { ModelingFeature, PlaneSpec, AxisSpec, Vec3, Vec3Expr } from '../../core/featureTypes';
import { evalLength, evalAngle, evaluate, MM_PER, type Quantity } from '../../core/units';
import { type OC, type Gc, type Frame, type EvalEntity, type Loop, planeFrame } from '../regen';
import { type Named, resolveFace, resolveEdge } from '../naming';
import { free, takeXyz } from '../mem';
import { filletFeature, chamferFeature } from './fillet';
import { holeFeature } from './hole';
import { linearPatternFeature, circularPatternFeature, mirrorFeature } from './pattern';
import { shellFeature, draftFeature } from './shell';
import { sweepFeature, loftFeature, ribFeature } from './sweep';
import { refPlaneFeature, refAxisFeature, refPointFeature } from './refgeom';

/** A feature's tool body and how it was combined, kept so patterns and mirror can re-apply it. */
/**
 * A feature's tool body, for patterns and mirrors. `variants`: the same
 * geometry built another way (a smooth loft with its seam elsewhere), tried
 * when the kernel fails to combine a copy (BooleanFailure).
 */
export interface CapturedTool { tool: Named; op: 'add' | 'cut'; variants?: (gc: Gc) => Named[] }

export type RefGeometry =
  | { id: string; kind: 'plane'; origin: Vec3; x: Vec3; y: Vec3; normal: Vec3; size: number }
  | { id: string; kind: 'axis'; origin: Vec3; dir: Vec3; length: number }
  | { id: string; kind: 'point'; p: Vec3 };

export interface FeatureContext {
  oc: OC;
  gc: Gc;
  doc: CadDocument;
  params: Record<string, Quantity>;
  evalSketches: Map<string, { frame: Frame; entities: EvalEntity[]; loops: Loop[] }>;
  tools: Map<string, CapturedTool>;
  refGeometry: RefGeometry[];
  /** The solid before this feature. */
  body: Named | null;
}

export interface FeatureResult { body: Named | null; tool?: Named | null; message?: string }

export function applyModelingFeature(ctx: FeatureContext, f: ModelingFeature): FeatureResult {
  switch (f.type) {
    case 'fillet': return filletFeature(ctx, f);
    case 'chamfer': return chamferFeature(ctx, f);
    case 'hole': return holeFeature(ctx, f);
    case 'linearPattern': return linearPatternFeature(ctx, f);
    case 'circularPattern': return circularPatternFeature(ctx, f);
    case 'mirror': return mirrorFeature(ctx, f);
    case 'shell': return shellFeature(ctx, f);
    case 'draft': return draftFeature(ctx, f);
    case 'rib': return ribFeature(ctx, f);
    case 'sweep': return sweepFeature(ctx, f);
    case 'loft': return loftFeature(ctx, f);
    case 'refPlane': return refPlaneFeature(ctx, f);
    case 'refAxis': return refAxisFeature(ctx, f);
    case 'refPoint': return refPointFeature(ctx, f);
  }
}

// ------------------------------------------------------------------ values

export const L = (ctx: FeatureContext, v: ValueExpr) => evalLength(v, ctx.doc.units, ctx.params);
export const A = (ctx: FeatureContext, v: ValueExpr) => evalAngle(v, ctx.params);
/** A positive length, with a clear error. */
export function posLength(ctx: FeatureContext, v: ValueExpr | undefined, what: string): number {
  if (v === undefined || v === '') throw new Error(`${what} is required`);
  const x = L(ctx, v);
  if (!(x > 0)) throw new Error(`${what} must be greater than zero`);
  return x;
}
/** A whole number such as a pattern count (may be an expression of parameters). */
export function count(ctx: FeatureContext, v: ValueExpr, what: string): number {
  const n = typeof v === 'number' ? v : evaluate(String(v), ctx.params, MM_PER[ctx.doc.units]).v;
  if (!Number.isInteger(Math.round(n * 1e9) / 1e9) || n < 1) throw new Error(`${what} must be a whole number of at least 1`);
  return Math.round(n);
}
export function vec3(ctx: FeatureContext, p: Vec3Expr): Vec3 { return [L(ctx, p.x), L(ctx, p.y), L(ctx, p.z)]; }

export function needBody(ctx: FeatureContext, what: string): Named {
  if (!ctx.body) throw new Error(`${what} needs an existing solid`);
  return ctx.body;
}

// ------------------------------------------------------------------ vector math

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export function unit(a: Vec3, what = 'Direction'): Vec3 {
  const n = norm(a);
  if (!(n > 1e-12)) throw new Error(`${what} has zero length`);
  return scale(a, 1 / n);
}
/** Rotate v about unit axis k by angle t (Rodrigues). */
export function rotate(v: Vec3, k: Vec3, t: number): Vec3 {
  const c = Math.cos(t), s = Math.sin(t);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** X, Y, Z of a point or direction, which is then deleted (getters return new objects). */
const xyz = (p: { X(): number; Y(): number; Z(): number; delete(): void }): Vec3 => takeXyz(p);
/** The location and direction of an axis object, which is then deleted. */
const axisParts = (ax: { Location(): any; Direction(): any; delete(): void }) => { const o = xyz(ax.Location()), d = xyz(ax.Direction()); ax.delete(); return { o, d }; };

// ------------------------------------------------------------------ planes and axes

/**
 * Frame of a PlaneSpec. For a planar face the 2D axes are world axes, so hole
 * positions on a face are plain world coordinates: faces facing up/down use
 * (X, Y), faces facing front/back use (X, Z), faces facing left/right use
 * (Y, Z). `n` is the face's outward normal.
 */
export function planeOf(ctx: FeatureContext, p: PlaneSpec): Frame {
  if ('base' in p) return planeFrame(p.base, p.offset !== undefined ? L(ctx, p.offset) : 0);
  if ('refPlane' in p) return refPlaneFrame(ctx, p.refPlane, 0);
  const { oc } = ctx;
  const body = needBody(ctx, 'A face reference');
  const fi = resolveFace(oc, body, p.face);
  const face = oc.TopoDS.Face(body.faces[fi]);
  const ad = new oc.BRepAdaptor_Surface(face, true);
  try {
    if (!String(ad.GetType()).endsWith('Plane')) throw new Error('The selected face is not planar');
    const pl = ad.Plane();
    let n = axisParts(pl.Axis()).d;
    if (String(face.Orientation()).includes('REVERSED')) n = scale(n, -1);
    const loc = xyz(pl.Location());
    pl.delete();
    return faceFrame(n, loc);
  } finally { ad.delete(); face.delete(); }
}

/** World-axis-aligned 2D frame on a plane with normal n through point q. */
export function faceFrame(n: Vec3, q: Vec3): Frame {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let x: Vec3, y: Vec3;
  const E = 1e-9;
  if (ax < E && ay < E) { x = [1, 0, 0]; y = [0, 1, 0]; }
  else if (ax < E && az < E) { x = [1, 0, 0]; y = [0, 0, 1]; }
  else if (ay < E && az < E) { x = [0, 1, 0]; y = [0, 0, 1]; }
  else {
    // General orientation: x = world X (or Y) projected onto the plane, y = n x x.
    const ref: Vec3 = ax < 0.9 ? [1, 0, 0] : [0, 1, 0];
    x = unit(sub(ref, scale(n, dot(ref, n))));
    y = cross(n, x);
  }
  // Origin: where 2D (0,0) lands, i.e. the projection of the world origin along n.
  return { o: scale(n, dot(q, n)), x, y, n };
}

export function refPlaneFrame(ctx: FeatureContext, id: string, offset: number): Frame {
  const g = ctx.refGeometry.find((r) => r.id === id);
  if (!g) throw new Error('Its reference plane is missing, suppressed, failed, or after it in the history');
  if (g.kind !== 'plane') throw new Error('The reference is not a plane');
  return { o: add(g.origin, scale(g.normal, offset)), x: g.x, y: g.y, n: g.normal };
}

/** A point and unit direction for an AxisSpec. */
export function axisOf(ctx: FeatureContext, a: AxisSpec): { o: Vec3; d: Vec3 } {
  if ('axis' in a) return { o: [0, 0, 0], d: a.axis === 'X' ? [1, 0, 0] : a.axis === 'Y' ? [0, 1, 0] : [0, 0, 1] };
  if ('refAxis' in a) {
    const g = ctx.refGeometry.find((r) => r.id === a.refAxis);
    if (!g) throw new Error('Its reference axis is missing, suppressed, failed, or after it in the history');
    if (g.kind !== 'axis') throw new Error('The reference is not an axis');
    return { o: g.origin, d: g.dir };
  }
  const { oc } = ctx;
  const body = needBody(ctx, 'An edge/face reference');
  if ('edge' in a) {
    const { edge } = resolveEdge(oc, body, a.edge);
    const ed = oc.TopoDS.Edge(edge);
    const ad = new oc.BRepAdaptor_Curve(ed);
    try {
      const t = String(ad.GetType());
      if (t.endsWith('Line')) {
        const p0 = xyz(ad.Value(ad.FirstParameter())), p1 = xyz(ad.Value(ad.LastParameter()));
        return { o: p0, d: unit(sub(p1, p0)) };
      }
      if (t.endsWith('Circle')) { const c = ad.Circle(); const r = axisParts(c.Axis()); c.delete(); return r; }
      throw new Error('The edge is neither straight nor circular');
    } finally { free(ad, ed, edge); }
  }
  const fi = resolveFace(oc, body, a.face);
  const face = oc.TopoDS.Face(body.faces[fi]);
  const ad = new oc.BRepAdaptor_Surface(face, true);
  try {
    const t = String(ad.GetType());
    if (t.endsWith('Cylinder')) { const cy = ad.Cylinder(); const r = axisParts(cy.Axis()); cy.delete(); return r; }
    if (t.endsWith('Cone')) { const co = (ad as any).Cone(); const r = axisParts(co.Axis()); co.delete(); return r; }
    if (t.endsWith('Plane')) {
      // A planar face as a direction: its normal (useful for linear patterns).
      const pl = ad.Plane(); const o = xyz(pl.Location()); const d = axisParts(pl.Axis()).d; pl.delete(); return { o, d };
    }
    throw new Error('The face has no axis (pick a cylindrical face)');
  } finally { ad.delete(); face.delete(); }
}

/** Size used to draw reference geometry: a bit larger than the part. */
export function displaySize(ctx: FeatureContext): number {
  if (!ctx.body) return ctx.doc.units === 'in' ? 50.8 : 50;
  const b = new ctx.oc.Bnd_Box();
  ctx.oc.BRepBndLib.Add(ctx.body.shape, b, false);
  const lo = xyz(b.CornerMin()), hi = xyz(b.CornerMax());
  const d = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  b.delete();
  return d * 0.6;
}

export type { TopoDS_Shape };
