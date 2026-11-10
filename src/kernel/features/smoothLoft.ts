/**
 * Exact smooth loft for organic sections.
 *
 * When every loft profile is one closed spline with equal parameter steps
 * (uniform) and the same number of points (what loft_sections, profile_body
 * and ovals make), all sections share one knot vector. The loft surface is
 * then built directly: each section's poles form one row of a bicubic
 * B-spline surface (periodic around the section), and the rows are joined by
 * cubic interpolation along the loft. Every section lies exactly on the
 * surface, the surface is C2, and it stays light (rows x points poles), so it
 * meshes and integrates fast.
 *
 * Tip points close the body: a 'round' tip (domed end) leaves the tip with a
 * tangent plane square to the body's direction, so a head's crown or a
 * fingertip is smooth through the pole; OpenCascade's general loft
 * (ThruSections) instead overshoots badly next to a tip point.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { OC } from '../regen';
import { to3d, type Frame, type Loop, type Gc } from '../regen';
import { splineCurve } from '../../sketch/geom';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

export interface SmoothSection { frame: Frame; loop: Loop }

/**
 * How each section runs around: every ring of one loft shares it, so the
 * surface's U direction is exactly each section curve.
 *  - uniform closed spline, n points: periodic cubic, knots 0..n;
 *  - circle: the exact rational quadratic circle (9 poles, weights 1 and
 *    sqrt(2)/2), starting on the sketch's x axis.
 */
export interface RingKind { kind: 'spline' | 'circle'; count: number }
export interface Rings { kind: RingKind; rings: V3[][] }

const W45 = Math.SQRT1_2;
const CIRCLE_UNIT: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]];

function ringOf(s: SmoothSection): { kind: RingKind; ring: V3[] } | null {
  const ents = s.loop.entities;
  if (ents.length !== 1) return null;
  const e = ents[0];
  if (e.kind === 'circle') {
    const [cx, cy] = e.c;
    return { kind: { kind: 'circle', count: 9 }, ring: CIRCLE_UNIT.map(([x, y]) => to3d(s.frame, cx + e.r * x, cy + e.r * y)) };
  }
  if (e.kind !== 'spline' || !e.closed || !e.uniform) return null;
  const c = splineCurve(e);
  const n = e.pts.length;
  // Periodic form: the first n poles (the rest repeat them), knots 0..n.
  return { kind: { kind: 'spline', count: n }, ring: c.poles.slice(0, n).map((p) => to3d(s.frame, p[0], p[1])) };
}

/**
 * Where the closed surface's seam runs, as a fraction of a turn from the
 * section's first point. The surface is exactly the same wherever the seam
 * is (a cyclic shift of a periodic spline's poles, or a quarter turn of the
 * circle's poles), but OpenCascade's booleans can fail silently when two
 * organic bodies' seams meet on their intersection, so each loft picks its
 * own seam and moves it if a boolean fails.
 */
export function seamPositions(kind: RingKind): number {
  return kind.kind === 'circle' ? 4 : kind.count;
}
function moveSeam(ring: V3[], kind: RingKind, seam: number): V3[] {
  const positions = seamPositions(kind);
  const k = (((Math.round(seam * positions) % positions) + positions) % positions);
  if (!k) return ring;
  if (kind.kind === 'circle') {
    const base = ring.slice(0, 8);
    const r = [...base.slice(2 * k), ...base.slice(0, 2 * k)];
    return [...r, r[0]];
  }
  return [...ring.slice(k), ...ring.slice(0, k)];
}

/** Can these sections use the exact smooth loft? (All one kind, same point count.) */
export function smoothLoftRings(sections: SmoothSection[]): Rings | null {
  const rings: V3[][] = [];
  let kind: RingKind | null = null;
  for (const s of sections) {
    const r = ringOf(s);
    if (!r) return null;
    if (kind && (r.kind.kind !== kind.kind || r.kind.count !== kind.count)) return null;
    kind = r.kind;
    rings.push(r.ring);
  }
  return kind ? { kind, rings } : null;
}

/**
 * Join the rows along the loft with shape-preserving cubic Hermite spans
 * (Fritsch-Carlson slopes per pole coordinate, The NURBS Book 9.3.4 style
 * local interpolation): the surface passes exactly through every row, is
 * tangent-continuous, and never swings past the sections it is given (a
 * global C2 fit rings: a straight tube ending in a dome would ripple along
 * its whole length). d0 / d1: given end derivatives per column (round tips).
 * Returns pole rows (2 per span + 2) and the knot vector (interior knots doubled: C1).
 */
function interpolateRows(rows: V3[][], v: number[], d0?: V3[], d1?: V3[]): { poles: V3[][]; knots: number[]; degree: number } {
  const m = rows.length, ncol = rows[0].length;
  const h = v.slice(1).map((x, i) => x - v[i]);
  if (m === 2 && !d0 && !d1) return { poles: rows, knots: [v[0], v[0], v[1], v[1]], degree: 1 };
  const slopes: V3[][] = rows.map(() => new Array(ncol));
  for (let j = 0; j < ncol; j++) {
    for (let c = 0; c < 3; c++) {
      const y = rows.map((r) => r[j][c]);
      const d = h.map((hi, i) => (y[i + 1] - y[i]) / hi);
      const s = new Array(m).fill(0);
      for (let i = 1; i < m - 1; i++) {
        if (d[i - 1] * d[i] <= 0) s[i] = 0;
        else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; s[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
      }
      const endSlope = (i0: number, i1: number, hh0: number, hh1: number, dd0: number, dd1: number) => {
        if (m === 2) return dd0;
        const e = ((2 * hh0 + hh1) * dd0 - hh0 * dd1) / (hh0 + hh1);
        if (Math.sign(e) !== Math.sign(dd0)) return 0;
        if (Math.sign(dd0) !== Math.sign(dd1) && Math.abs(e) > Math.abs(3 * dd0)) return 3 * dd0;
        return e;
      };
      s[0] = d0 ? d0[j][c] : endSlope(0, 1, h[0], h[1] ?? h[0], d[0], d[1] ?? d[0]);
      s[m - 1] = d1 ? d1[j][c] : endSlope(m - 1, m - 2, h[m - 2], h[m - 3] ?? h[m - 2], d[m - 2], d[m - 3] ?? d[m - 2]);
      for (let i = 0; i < m; i++) (slopes[i][j] ??= [0, 0, 0])[c] = s[i];
    }
  }
  // Bezier spans joined C1; with doubled interior knots the shared junction rows are implied, so they are left out.
  const poles: V3[][] = [rows[0]];
  for (let i = 0; i < m - 1; i++) {
    poles.push(rows[i].map((q, j) => addv(q, mul(slopes[i][j], h[i] / 3))));
    poles.push(rows[i + 1].map((q, j) => sub(q, mul(slopes[i + 1][j], h[i] / 3))));
  }
  poles.push(rows[m - 1]);
  const knots = [v[0], v[0], v[0], v[0]];
  for (let i = 1; i < m - 1; i++) knots.push(v[i], v[i]);
  knots.push(v[m - 1], v[m - 1], v[m - 1], v[m - 1]);
  return { poles, knots, degree: 3 };
}

export type TipKind = 'round' | 'point';

/**
 * Build the closed solid: the lofted surface, flat caps where the loft ends
 * at a section, and nothing where it ends at a tip (the surface closes there).
 */
export function buildSmoothLoft(
  oc: OC, gc: Gc,
  ringSet: Rings, start?: { at: V3; kind: TipKind }, end?: { at: V3; kind: TipKind }, seam = 0,
): { shape: TopoDS_Shape; side: TopoDS_Shape | null; startCap: TopoDS_Shape | null; endCap: TopoDS_Shape | null } {
  const { kind } = ringSet;
  const rings = ringSet.rings.map((r) => moveSeam(r, kind, seam));
  const circle = kind.kind === 'circle';
  const n = rings[0].length;
  // Rational circle rings: weights per column, the same on every row.
  const wts = circle ? CIRCLE_UNIT.map((_, i) => (i % 2 ? W45 : 1)) : null;
  // Points on the section (not poles) for the tip directions: circle corner poles lie outside the circle.
  const onRing = (ring: V3[]) => (circle ? ring.map((q, i) => (i % 2 ? mul(addv(addv(ring[i - 1], ring[(i + 1) % n]), mul(q, 2 * W45)), 1 / (2 + 2 * W45)) : q)) : ring);
  const rows: V3[][] = [...(start ? [rings[0].map(() => start.at)] : []), ...rings, ...(end ? [rings[0].map(() => end.at)] : [])];
  if (rows.length < 2) throw new Error('A loft needs at least two profiles (or one profile and a start/end point)');
  // Parameters along the loft: chord length, averaged over the columns.
  const v = [0];
  for (let i = 1; i < rows.length; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += len(sub(rows[i][j], rows[i - 1][j]));
    if (!(s > 1e-9)) throw new Error('Two loft profiles are in the same place');
    v.push(v[i - 1] + s / n);
  }
  const V = v[v.length - 1];
  const vn = v.map((x) => x / V);
  // Round tips: the surface leaves the tip square to the body's direction (a dome, smooth through the pole).
  const tipDerivs = (tip: V3, ring: V3[], dv: number, sign: 1 | -1): V3[] => {
    const on = circle ? onRing(ring).slice(0, n - 1) : ring;
    const c = mul(on.reduce((a, q) => addv(a, q), [0, 0, 0] as V3), 1 / on.length);
    const axis = sub(tip, c);
    const al = len(axis);
    if (!(al > 1e-9)) throw new Error('A round loft end must lie off its last profile');
    const ax = mul(axis, 1 / al);
    return ring.map((q) => {
      const o = sub(q, tip);
      const h = sub(o, mul(ax, dot(o, ax)));
      const hl = len(h);
      if (!(hl > 1e-12)) return [0, 0, 0] as V3;
      return mul(h, (sign * len(o)) / (dv * hl));
    });
  };
  const d0 = start?.kind === 'round' ? tipDerivs(start.at, rings[0], vn[1] - vn[0], 1) : undefined;
  const d1 = end?.kind === 'round' ? tipDerivs(end.at, rings[rings.length - 1], vn[vn.length - 1] - vn[vn.length - 2], -1) : undefined;
  const { poles, knots, degree } = interpolateRows(rows, vn, d0, d1);

  // Geom_BSplineSurface: U around the section, V along the loft (clamped).
  const P = gc.t(new oc.NCollection_Array2_gp_Pnt(1, n, 1, poles.length));
  poles.forEach((row, jv) => row.forEach((q, iu) => P.SetValue(iu + 1, jv + 1, gc.t(new oc.gp_Pnt(q[0], q[1], q[2])))));
  // Spline rings: periodic, knots 0..n. Circle: knots 0, 1/4, 1/2, 3/4, 1 with multiplicities 3, 2, 2, 2, 3.
  const uk = circle ? [0, 1, 2, 3, 4] : Array.from({ length: n + 1 }, (_, i) => i);
  const um = circle ? [3, 2, 2, 2, 3] : uk.map(() => 1);
  const uMax = uk[uk.length - 1];
  const UK = gc.t(new oc.NCollection_Array1_double(1, uk.length));
  const UM = gc.t(new oc.NCollection_Array1_int(1, um.length));
  uk.forEach((k, i) => { UK.SetValue(i + 1, k); UM.SetValue(i + 1, um[i]); });
  const vk: number[] = [], vm: number[] = [];
  for (const k of knots) { if (vk.length && Math.abs(k - vk[vk.length - 1]) < 1e-12) vm[vm.length - 1]++; else { vk.push(k); vm.push(1); } }
  const VK = gc.t(new oc.NCollection_Array1_double(1, vk.length));
  const VM = gc.t(new oc.NCollection_Array1_int(1, vm.length));
  vk.forEach((k, i) => { VK.SetValue(i + 1, k); VM.SetValue(i + 1, vm[i]); });
  let surf: any;
  if (wts) {
    const W = gc.t(new oc.NCollection_Array2_double(1, n, 1, poles.length));
    for (let iu = 0; iu < n; iu++) for (let jv = 0; jv < poles.length; jv++) W.SetValue(iu + 1, jv + 1, wts[iu]);
    surf = new oc.Geom_BSplineSurface(P, W, UK, VK, UM, VM, 2, degree, false, false);
  } else surf = new oc.Geom_BSplineSurface(P, UK, VK, UM, VM, 3, degree, true, false);
  const mf = gc.t(new oc.BRepBuilderAPI_MakeFace(surf, 0, uMax, 0, 1, 1e-7));
  if (!mf.IsDone()) throw new Error('Loft failed: could not build the lofted surface');
  const side = gc.t(mf.Face());

  // Flat caps on section ends, from the side face's own boundary edges at v = 0 and v = 1.
  const capAt = (vEnd: number): TopoDS_Shape | null => {
    const ex = new oc.TopExp_Explorer(side, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
    let found: TopoDS_Shape | null = null;
    const q = surf.Value(uMax / 2 + 0.37, vEnd);
    const qv = gc.t(gc.t(new oc.BRepBuilderAPI_MakeVertex(q)).Vertex());
    for (; ex.More() && !found; ex.Next()) {
      const c = ex.Current();
      const e = gc.t(oc.TopoDS.Edge(c));
      c.delete();
      if (oc.BRep_Tool.Degenerated(e)) continue;
      // The iso edge at vEnd passes through the surface point there; the seam does not (it runs along v).
      const pr = new oc.Message_ProgressRange();
      const ext = new oc.BRepExtrema_DistShapeShape(e, qv, (oc as any).Extrema_ExtFlag?.Extrema_ExtFlag_MIN, (oc as any).Extrema_ExtAlgo?.Extrema_ExtAlgo_Grad, pr);
      if (ext.IsDone() && ext.Value() < 1e-6) found = e;
      ext.delete(); pr.delete();
    }
    ex.delete();
    q.delete();
    if (!found) throw new Error('Loft failed: could not find the end of the lofted surface');
    const w = gc.t(gc.t(new oc.BRepBuilderAPI_MakeWire(found)).Wire());
    const cf = gc.t(new oc.BRepBuilderAPI_MakeFace(w, true));
    if (!cf.IsDone()) throw new Error('Loft failed: an end profile is not flat');
    return gc.t(cf.Face());
  };
  const startCap = start ? null : capAt(0);
  const endCap = end ? null : capAt(1);
  surf.delete();

  // Sew (consistent face orientation), make the solid, and orient it outward.
  const sew = gc.t(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
  sew.Add(side);
  if (startCap) sew.Add(startCap);
  if (endCap) sew.Add(endCap);
  sew.Perform(gc.t(new oc.Message_ProgressRange()));
  const sewed = gc.t(sew.SewedShape());
  const T = oc.TopAbs_ShapeEnum as any;
  const b = gc.t(new oc.TopoDS_Builder());
  let shell: any;
  if (sewed.ShapeType() === T.TopAbs_SHELL) shell = gc.t(oc.TopoDS.Shell(sewed));
  else {
    shell = gc.t(new oc.TopoDS_Shell());
    b.MakeShell(shell);
    const ex = new oc.TopExp_Explorer(sewed, T.TopAbs_FACE, T.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) { const c = ex.Current(); b.Add(shell, c); c.delete(); }
    ex.delete();
  }
  const solid = new oc.TopoDS_Solid();
  b.MakeSolid(solid);
  b.Add(solid, shell);
  oc.BRepLib.OrientClosedSolid(solid);
  // The faces after sewing (new objects when sewing changed them; the caller only compares them, gc frees them).
  const modified = (f: TopoDS_Shape | null) => { if (!f) return null; try { return sew.IsModified(f) ? gc.t(sew.Modified(f)) : f; } catch { return f; } };
  return { shape: solid, side: modified(side), startCap: modified(startCap), endCap: modified(endCap) };
}
