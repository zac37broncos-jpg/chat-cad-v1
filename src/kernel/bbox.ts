/**
 * Exact axis-aligned bounding box of a B-rep, in mm.
 *
 * OpenCascade's "optimal" box (BRepBndLib.AddOptimal without triangulation) is exact for planes,
 * cylinders, cones, spheres, tori, lines and conics, but on free-form (B-spline) faces it finds
 * the extremes with a sampled local search that can miss one. Measured on an organic figure with
 * an arm: when the arm loft's seam put the arm tip's extreme near the end of the surface's
 * parameter range, AddOptimal reported the part 0.131 mm (0.0052 in) too short, past the project's
 * 0.005 in promise (tests/bbox.test.ts reproduces it).
 *
 * So the box here is AddOptimal's box, checked and extended where it can be wrong:
 *  - Only faces and edges that could reach past the box are looked at: their control-point
 *    (pole) box always contains them, so one that stays inside the current box cannot extend it.
 *  - Such a free-form face is sampled on a grid over its parameter range; from every grid point
 *    that is a local maximum in a direction, Newton steps on the exact surface walk to the true
 *    local extreme. A point found that way is added only when it is on the face (inside its
 *    trimmed boundary, checked by OpenCascade's exact distance to the face); an extreme beyond
 *    the boundary means the face's extreme is on its boundary, which the edges cover.
 *  - Free-form edges get the same 1D search along their exact curve.
 * Every point added lies on the shape, so the box never grows past the part; and every interior
 * or boundary extreme of a free-form face or edge is searched exactly, so it no longer comes out
 * short.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { OC } from './regen';
import { free, freeAll, takeXyz } from './mem';

export type Box = { min: [number, number, number]; max: [number, number, number] };

/** Surfaces and curves AddOptimal bounds analytically (exactly). */
const EXACT_SURFACE = /Plane|Cylinder|Cone|Sphere|Torus/;
const EXACT_CURVE = /Line|Circle|Ellipse|Hyperbola|Parabola/;
/** A candidate counts only when it extends the box by more than this (mm): far below anything measurable. */
const GAIN = 1e-10;
/** A point this close to a face (mm) is on it. */
const ON_FACE = 1e-7;
/** Local maxima refined per face (or edge) and direction, best first. */
const MAX_STARTS = 8;

function subShapes(oc: OC, s: TopoDS_Shape, kind: 'TopAbs_FACE' | 'TopAbs_EDGE'): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  const ex = new oc.TopExp_Explorer(s, (oc.TopAbs_ShapeEnum as any)[kind], (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const c = ex.Current();
    if (!out.some((o) => o.IsSame(c))) out.push(c); else c.delete();
  }
  ex.delete();
  return out;
}

/** Directions (axis k, sign) in which `sub`'s control-point box reaches past `box`. */
function directionsPast(oc: OC, sub: TopoDS_Shape, box: Box): [number, 1 | -1][] {
  const b = new oc.Bnd_Box();
  try {
    oc.BRepBndLib.Add(sub, b, false);
    if (b.IsVoid()) return [];
    const lo = takeXyz(b.CornerMin()), hi = takeXyz(b.CornerMax());
    const out: [number, 1 | -1][] = [];
    for (let k = 0; k < 3; k++) {
      if (hi[k] > box.max[k] + GAIN) out.push([k, 1]);
      if (lo[k] < box.min[k] - GAIN) out.push([k, -1]);
    }
    return out;
  } finally { b.delete(); }
}

function include(box: Box, p: [number, number, number]) {
  for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], p[k]); box.max[k] = Math.max(box.max[k], p[k]); }
}

/** Grid indices that are local maxima of `val` (no neighbour, including diagonals, is larger), best first. */
function gridMaxima(val: Float64Array, nu: number, nv: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const x = val[i * nv + j];
      let isMax = true;
      for (let di = -1; di <= 1 && isMax; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const a = i + di, c = j + dj;
        if (a < 0 || c < 0 || a >= nu || c >= nv) continue;
        if (val[a * nv + c] > x) { isMax = false; break; }
      }
      if (isMax) out.push(i * nv + j);
    }
  }
  return out.sort((a, b) => val[b] - val[a]).slice(0, MAX_STARTS);
}

/** Grid size along one parameter: a few samples per control point, within limits. */
const gridSize = (poles: number) => Math.max(16, Math.min(120, 3 * poles + 3));

export function exactBox(oc: OC, s: TopoDS_Shape): Box {
  const b = new oc.Bnd_Box();
  oc.BRepBndLib.AddOptimal(s, b, false, false);
  const box: Box = { min: takeXyz(b.CornerMin()), max: takeXyz(b.CornerMax()) };
  const empty = b.IsVoid();
  b.delete();
  if (empty) return box;

  const P = new oc.gp_Pnt(0, 0, 0), Du = new oc.gp_Vec(0, 0, 0), Dv = new oc.gp_Vec(0, 0, 0);
  const Duu = new oc.gp_Vec(0, 0, 0), Dvv = new oc.gp_Vec(0, 0, 0), Duv = new oc.gp_Vec(0, 0, 0);
  const pr = new oc.Message_ProgressRange();
  const xyz = (v: any) => [v.X(), v.Y(), v.Z()];
  const faces = subShapes(oc, s, 'TopAbs_FACE');
  const doneEdges: TopoDS_Shape[] = [];
  try {
    for (const f of faces) {
      const face = oc.TopoDS.Face(f);
      const ad = new oc.BRepAdaptor_Surface(face, true);
      try {
        if (!EXACT_SURFACE.test(String(ad.GetType()))) {
          const dirs = directionsPast(oc, face, box);
          if (dirs.length) searchFace(face, ad, dirs);
        }
      } finally { free(ad, face); }
      // Its free-form edges (an extreme of the face on its boundary lies on one of them).
      const edges = subShapes(oc, f, 'TopAbs_EDGE');
      for (const e of edges) {
        if (doneEdges.some((d) => d.IsSame(e))) { e.delete(); continue; }
        doneEdges.push(e);
        const ed = oc.TopoDS.Edge(e);
        if ((oc.BRep_Tool as any).Degenerated(ed)) { ed.delete(); continue; }
        const ac = new oc.BRepAdaptor_Curve(ed);
        try {
          if (!EXACT_CURVE.test(String(ac.GetType()))) {
            const dirs = directionsPast(oc, ed, box);
            if (dirs.length) searchEdge(ac, dirs);
          }
        } finally { free(ac, ed); }
      }
    }
  } finally {
    freeAll(faces); freeAll(doneEdges);
    free(P, Du, Dv, Duu, Dvv, Duv, pr);
  }
  return box;

  /** Is the surface point at P on the face (inside its trimmed boundary)? */
  function onFace(face: any): boolean {
    const mv = new oc.BRepBuilderAPI_MakeVertex(P);
    const v = mv.Vertex();
    const d = new oc.BRepExtrema_DistShapeShape(v, face, (oc as any).Extrema_ExtFlag?.Extrema_ExtFlag_MIN, (oc as any).Extrema_ExtAlgo?.Extrema_ExtAlgo_Grad, pr);
    const ok = d.IsDone() && d.Value() <= ON_FACE;
    free(d, v, mv);
    return ok;
  }

  function searchFace(face: any, ad: any, dirs: [number, 1 | -1][]) {
    const uv = oc.BRepTools.UVBounds(face, 0, 0, 0, 0);
    const u0 = uv.UMin, u1 = uv.UMax, v0 = uv.VMin, v1 = uv.VMax;
    if (!(u1 > u0 && v1 > v0)) return;
    let pu = 0, pv = 0;
    try { pu = ad.NbUPoles(); pv = ad.NbVPoles(); } catch { /* not a B-spline / Bezier: default grid */ }
    const nu = gridSize(pu || 10), nv = gridSize(pv || 10);
    const coord = [new Float64Array(nu * nv), new Float64Array(nu * nv), new Float64Array(nu * nv)];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        ad.D0(u0 + ((u1 - u0) * i) / (nu - 1), v0 + ((v1 - v0) * j) / (nv - 1), P);
        coord[0][i * nv + j] = P.X(); coord[1][i * nv + j] = P.Y(); coord[2][i * nv + j] = P.Z();
      }
    }
    const clampU = (u: number) => Math.min(u1, Math.max(u0, u)), clampV = (v: number) => Math.min(v1, Math.max(v0, v));
    const range = Math.max(u1 - u0, v1 - v0);
    for (const [k, sg] of dirs) {
      const val = coord[k].map((x) => sg * x);
      for (const idx of gridMaxima(val, nu, nv)) {
        let u = u0 + ((u1 - u0) * Math.floor(idx / nv)) / (nu - 1), v = v0 + ((v1 - v0) * (idx % nv)) / (nv - 1);
        ad.D2(u, v, P, Du, Dv, Duu, Dvv, Duv);
        let fv = sg * xyz(P)[k];
        // Newton on the gradient of the coordinate (ascent with backtracking where the surface is not concave).
        for (let it = 0; it < 60; it++) {
          const g0 = sg * xyz(Du)[k], g1 = sg * xyz(Dv)[k];
          const h00 = sg * xyz(Duu)[k], h11 = sg * xyz(Dvv)[k], h01 = sg * xyz(Duv)[k];
          const det = h00 * h11 - h01 * h01;
          let du: number, dv: number;
          if (h00 < 0 && det > 0) { du = -(h11 * g0 - h01 * g1) / det; dv = -(h00 * g1 - h01 * g0) / det; }
          else { const gn = Math.hypot(g0, g1); if (!(gn > 0)) break; du = (g0 / gn) * 0.05 * range; dv = (g1 / gn) * 0.05 * range; }
          let t = 1, moved = false;
          for (let bt = 0; bt < 50; bt++, t /= 2) {
            const nu2 = clampU(u + t * du), nv2 = clampV(v + t * dv);
            ad.D0(nu2, nv2, P);
            const nf = sg * xyz(P)[k];
            if (nf > fv) { moved = Math.abs(nu2 - u) + Math.abs(nv2 - v) > 1e-15 * (1 + range); u = nu2; v = nv2; fv = nf; break; }
          }
          ad.D2(u, v, P, Du, Dv, Duu, Dvv, Duv);
          if (!moved) break;
        }
        const p = xyz(P) as [number, number, number];
        const past = sg > 0 ? p[k] > box.max[k] + GAIN : p[k] < box.min[k] - GAIN;
        if (past && onFace(face)) include(box, p);
      }
    }
  }

  function searchEdge(ac: any, dirs: [number, 1 | -1][]) {
    const t0 = ac.FirstParameter(), t1 = ac.LastParameter();
    if (!(t1 > t0)) return;
    let poles = 0;
    try { poles = ac.NbPoles(); } catch { /* not a B-spline / Bezier curve */ }
    const n = Math.max(32, Math.min(256, 4 * (poles || 16)));
    const coord = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    for (let i = 0; i < n; i++) { ac.D0(t0 + ((t1 - t0) * i) / (n - 1), P); coord[0][i] = P.X(); coord[1][i] = P.Y(); coord[2][i] = P.Z(); }
    const clampT = (t: number) => Math.min(t1, Math.max(t0, t));
    for (const [k, sg] of dirs) {
      const val = coord[k].map((x) => sg * x);
      const starts: number[] = [];
      for (let i = 0; i < n; i++) if ((i === 0 || val[i - 1] <= val[i]) && (i === n - 1 || val[i + 1] <= val[i])) starts.push(i);
      starts.sort((a, b) => val[b] - val[a]);
      for (const i of starts.slice(0, MAX_STARTS)) {
        let t = t0 + ((t1 - t0) * i) / (n - 1);
        ac.D2(t, P, Du, Duu);
        let fv = sg * xyz(P)[k];
        for (let it = 0; it < 60; it++) {
          const g = sg * xyz(Du)[k], h = sg * xyz(Duu)[k];
          const step = h < 0 ? -g / h : Math.sign(g) * 0.05 * (t1 - t0);
          if (!step) break;
          let s = 1, moved = false;
          for (let bt = 0; bt < 50; bt++, s /= 2) {
            const nt = clampT(t + s * step);
            ac.D0(nt, P);
            const nf = sg * xyz(P)[k];
            if (nf > fv) { moved = Math.abs(nt - t) > 1e-15 * (1 + Math.abs(t1 - t0)); t = nt; fv = nf; break; }
          }
          ac.D2(t, P, Du, Duu);
          if (!moved) break;
        }
        include(box, xyz(P) as [number, number, number]);
      }
    }
  }
}
