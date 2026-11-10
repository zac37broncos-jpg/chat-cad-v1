/**
 * Surface area and volume of faces that OpenCascade integrates wrong.
 *
 * A face on a periodic B-spline surface (the skin of a smooth loft) can run past the end of its
 * surface's parameter range: the face's (u, v) bounds reach beyond the surface's first or last knot
 * (it crosses the place where the parameters start over, or lies wholly one period further on).
 * OpenCascade allows that, but its integrations then split the face at the surface's knots, which do
 * not cover the face, and the result is wrong while the reported error is tiny. Found 2026-11-10
 * with an independent calculation (verify/print): on the Easter Island head two such faces were
 * each 0.28 mm² (0.12%) too large, the part's area 0.6 mm² to 1.5 mm² off, and its plain volume up
 * to 4.5 mm³ (1.3e-5) off. The slower Gauss-Kronrod volume integration (IsUseSpan) is right on them.
 *
 * So for those faces only:
 * - area: Gauss quadrature of the exact surface (|dS/du x dS/dv| from the surface's own derivatives)
 *   over the face's triangulation in (u, v), each triangle split into 4 for the rule, plus the
 *   exact thin slivers between each boundary chord of the triangulation and the face's true boundary
 *   curve. It does not use OpenCascade's integrator at all. On faces OpenCascade gets right it agrees
 *   with it to about 1e-6 of the face's area on organic faces and to 1e-14 on planes, cylinders,
 *   cones and tori.
 * - volume: Gauss-Kronrod, face by face (see massProperties in ./query.ts).
 */
import type { OC } from './regen';
import { free, freeAll } from './mem';

/** Dunavant's 7-point rule on a triangle (exact for polynomials up to degree 5): barycentric (a, b, b) and weight. */
const A1 = 0.059715871789770, B1 = 0.470142064105115, A2 = 0.797426985353087, B2 = 0.101286507323456;
const W0 = 0.225, W1 = 0.132394152788506, W2 = 0.125939180544827;
const TRI_RULE: [number, number, number, number][] = [
  [1 / 3, 1 / 3, 1 / 3, W0],
  [A1, B1, B1, W1], [B1, A1, B1, W1], [B1, B1, A1, W1],
  [A2, B2, B2, W2], [B2, A2, B2, W2], [B2, B2, A2, W2],
];
/** 8-point Gauss-Legendre on [-1, 1]. */
const GL_X = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498, 0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620, 0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
/** 4-point Gauss-Legendre on [-1, 1] (across a sliver). */
const FAN_X = [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526];
const FAN_W = [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538];

/** What the quadrature covered (for tests): interior and sliver parts, boundary chords, how they were matched. */
export interface QuadratureStats { interior: number; slivers: number; chords: number; matched: number; straight: number }

/**
 * Area of one face by quadrature over its current triangulation (it must be meshed, with UV nodes),
 * or null when the triangulation cannot be used: no UV nodes, or a boundary chord that is not on a
 * known boundary curve and not a straight parameter line. `split`: each triangle is cut into 4^split
 * for the rule (the surface's area factor is not smooth across knot lines of reduced continuity).
 */
export function faceAreaByQuadrature(oc: OC, face: any, stats?: QuadratureStats, split = 1): number | null {
  const loc = new oc.TopLoc_Location();
  const objs: { delete(): void }[] = [loc];
  try {
    const h: any = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (!h || h.IsNull?.()) return null;
    objs.push(h);
    const T = h.get ? h.get() : h;
    if (!T.HasUVNodes()) return null;
    const n = T.NbNodes(), m = T.NbTriangles();
    if (m === 0) return null;
    const uv = new Float64Array(2 * n);
    for (let i = 1; i <= n; i++) { const q = T.UVNode(i); uv[2 * i - 2] = q.X(); uv[2 * i - 1] = q.Y(); q.delete(); }
    const tri = new Int32Array(3 * m);
    for (let i = 1; i <= m; i++) { const t = T.Triangle(i); tri[3 * i - 3] = t.Value(1) - 1; tri[3 * i - 2] = t.Value(2) - 1; tri[3 * i - 1] = t.Value(3) - 1; t.delete(); }
    const ad = new oc.BRepAdaptor_Surface(face, false);
    const P = new oc.gp_Pnt(), Du = new oc.gp_Vec(), Dv = new oc.gp_Vec();
    objs.push(ad, P, Du, Dv);
    const jac = (u: number, v: number) => {
      ad.D1(u, v, P, Du, Dv);
      const x = Du.Y() * Dv.Z() - Du.Z() * Dv.Y(), y = Du.Z() * Dv.X() - Du.X() * Dv.Z(), z = Du.X() * Dv.Y() - Du.Y() * Dv.X();
      return Math.sqrt(x * x + y * y + z * z);
    };
    // Interior: the rule on every (u, v) triangle.
    let area = 0;
    const third = new Map<number, number>(); // boundary chord (used by one triangle) -> its triangle's third node
    const count = new Map<number, number>();
    const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
    for (let t = 0; t < m; t++) {
      const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
      const ua = uv[2 * a], va = uv[2 * a + 1], ub = uv[2 * b], vb = uv[2 * b + 1], uc = uv[2 * c], vc = uv[2 * c + 1];
      const auv = 0.5 * Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va));
      let s = 0;
      const N = 1 << split;
      for (let i = 0; i < N; i++) for (let j = 0; j < N - i; j++) for (const up of [false, true]) {
        if (up && i + j >= N - 1) continue;
        // sub-triangle corners in barycentric (i, j) grid steps
        const cs: [number, number][] = up ? [[i + 1, j], [i, j + 1], [i + 1, j + 1]] : [[i, j], [i + 1, j], [i, j + 1]];
        for (const [la, lb, lc, w] of TRI_RULE) {
          const x = (la * cs[0][0] + lb * cs[1][0] + lc * cs[2][0]) / N, y = (la * cs[0][1] + lb * cs[1][1] + lc * cs[2][1]) / N;
          s += (w / (N * N)) * jac(ua + x * (ub - ua) + y * (uc - ua), va + x * (vb - va) + y * (vc - va));
        }
      }
      area += s * auv;
      for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]]) {
        const k = key(p, q);
        count.set(k, (count.get(k) ?? 0) + 1);
        third.set(k, r);
      }
    }
    const boundary = new Set<number>();
    for (const [k, c] of count) if (c === 1) boundary.add(k);
    // Boundary: the sliver between each chord and the true curve, area = 1/2 integral of
    // cross(c(t) - c(t0), c'(t)) dt in (u, v), weighted by the surface's area factor there.
    let span = 1;
    for (let i = 0; i < uv.length; i++) span = Math.max(span, Math.abs(uv[i]));
    const interior = area;
    let slivers = 0, chords = 0, matched = 0;
    const ex = new oc.TopExp_Explorer(face, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
    objs.push(ex);
    const p2 = new oc.gp_Pnt2d(), v2 = new oc.gp_Vec2d();
    objs.push(p2, v2);
    for (; ex.More(); ex.Next()) {
      const cur = ex.Current();
      const e = oc.TopoDS.Edge(cur);
      objs.push(cur, e);
      let poly: any = null;
      try { poly = (oc.BRep_Tool as any).PolygonOnTriangulation(e, h, loc); } catch { poly = null; }
      const PP = poly && !(poly.IsNull?.()) ? (poly.get ? poly.get() : poly) : null;
      if (poly) objs.push(poly);
      if (!PP) continue; // its chords stay unmatched; checked below
      const nodes: number[] = [];
      for (let i = 1; i <= PP.NbNodes(); i++) nodes.push(PP.Node(i) - 1);
      if (oc.BRep_Tool.Degenerated(e) || !PP.HasParameters()) {
        // A pole (degenerate edge) is a straight parameter line with no area; without parameters the
        // chords cannot be measured, so they stay unmatched unless they are straight parameter lines.
        if (oc.BRep_Tool.Degenerated(e)) for (let i = 0; i + 1 < nodes.length; i++) boundary.delete(key(nodes[i], nodes[i + 1]));
        continue;
      }
      const pc = new oc.BRepAdaptor_Curve2d(e, face);
      objs.push(pc);
      const isLine = String(pc.GetType()).endsWith('Line');
      for (let i = 0; i + 1 < nodes.length; i++) {
        const ia = nodes[i], ib = nodes[i + 1];
        const k = key(ia, ib);
        if (!boundary.has(k)) continue;
        chords++;
        const ta = PP.Parameter(i + 1), tb = PP.Parameter(i + 2);
        const a = pc.Value(ta);
        const au = a.X(), av = a.Y();
        a.delete();
        // The chord's ends must be this curve's own points (a closed seam edge is listed for both of
        // its sides; the side this curve is not on is matched by the other listing).
        if (Math.abs(au - uv[2 * ia]) > 1e-9 * span || Math.abs(av - uv[2 * ia + 1]) > 1e-9 * span) continue;
        boundary.delete(k);
        matched++;
        if (isLine) continue; // a straight curve has no sliver
        // The sliver as a fan from the chord's start: the points a + r (c(t) - a), r in [0, 1], t
        // along the curve; dA(u, v) = r cross(c(t) - a, c'(t)) dr dt, weighted by the area factor.
        // The side of the chord the face's triangle is on says whether the sliver adds or subtracts.
        const r3 = third.get(k)!;
        const bu = uv[2 * ib], bv = uv[2 * ib + 1];
        const side = Math.sign((bu - au) * (uv[2 * r3 + 1] - av) - (bv - av) * (uv[2 * r3] - au));
        const hh = (tb - ta) / 2, mid = (tb + ta) / 2;
        let add = 0;
        for (let g = 0; g < 8; g++) {
          pc.D1(mid + hh * GL_X[g], p2, v2);
          const dx = p2.X() - au, dy = p2.Y() - av;
          const cr = dx * v2.Y() - dy * v2.X();
          if (cr === 0) continue;
          let inner = 0;
          for (let q = 0; q < 4; q++) {
            const r = (1 + FAN_X[q]) / 2;
            inner += FAN_W[q] * r * jac(au + r * dx, av + r * dy);
          }
          add += GL_W[g] * cr * inner / 2;
        }
        add *= hh * side;
        area += add; slivers += add;
      }
    }
    // Chords no curve accounted for: fine only if they are straight parameter lines (a seam of a
    // closed surface, a pole, the untrimmed side of a patch), whose true boundary is the chord itself.
    for (const k of boundary) {
      const a = Math.floor(k / n), b = k % n;
      const du = Math.abs(uv[2 * a] - uv[2 * b]), dv = Math.abs(uv[2 * a + 1] - uv[2 * b + 1]);
      if (du > 1e-12 * span && dv > 1e-12 * span) return null;
    }
    if (stats) Object.assign(stats, { interior, slivers, chords, matched, straight: boundary.size });
    return area;
  } finally { freeAll(objs.reverse()); }
}

/**
 * True when the face lies on a periodic B-spline surface and its (u, v) bounds reach past the
 * surface's knot range in a periodic direction by more than a millionth of it.
 */
export function pastKnotRange(oc: OC, face: any): boolean {
  const ad = new oc.BRepAdaptor_Surface(face, false);
  try {
    if (!String(ad.GetType()).includes('BSplineSurface')) return false;
    const h: any = ad.BSpline();
    const bs = h.get ? h.get() : h;
    try {
      if (!bs.IsUPeriodic() && !bs.IsVPeriodic()) return false;
      const b = (oc.BRepTools as any).UVBounds(face, 0, 0, 0, 0);
      const out = (lo: number, hi: number, k0: number, k1: number) => { const m = 1e-6 * (k1 - k0); return lo < k0 - m || hi > k1 + m; };
      return (bs.IsUPeriodic() && out(b.UMin, b.UMax, bs.UKnot(1), bs.UKnot(bs.NbUKnots())))
        || (bs.IsVPeriodic() && out(b.VMin, b.VMax, bs.VKnot(1), bs.VKnot(bs.NbVKnots())));
    } finally { free(h); }
  } finally { ad.delete(); }
}
