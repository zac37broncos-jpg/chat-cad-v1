/**
 * Interpolating cubic B-spline curves for sketch splines.
 *
 * A sketch spline passes exactly through its points ("fit points", like a
 * Mainstream CAD spline). Open splines are clamped cubic B-splines (Piegl &
 * Tiller, The NURBS Book, algorithm A9.1: chord-length parameters, knots by
 * averaging). Closed splines are C2 everywhere, including the seam: a
 * periodic cubic interpolant with the knots at the chord-length parameters,
 * written out as an unclamped B-spline over one period.
 *
 * The same poles and knots are handed to OpenCascade (Geom_BSplineCurve), so
 * what the sketcher draws, what the AI is told and what the kernel builds is
 * one and the same curve. Pure TypeScript, no DOM, no WASM.
 */
export type P2 = [number, number];

export interface BSpline2 {
  degree: number;
  /** Control points (mm). */
  poles: P2[];
  /** Flat knot vector, length poles.length + degree + 1. */
  knots: number[];
  /** Parameter range of the curve. */
  t0: number;
  t1: number;
  closed: boolean;
  /** Parameter of each fit point (closed: the first point is at t0 and again at t1). */
  params: number[];
}

/** Smallest distance between consecutive fit points (mm). */
export const SPLINE_MIN_GAP = 1e-6;

/** Solve A x = b (dense, partial pivoting) for several right-hand sides. */
export function solve(A: number[][], B: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...B[i]]);
  const w = M[0].length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) throw new Error('Spline: the points cannot be interpolated (singular system)');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k < w; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row.slice(n).map((v) => v / M[i][i]));
}

/** Index of the knot span containing t (knots[i] <= t < knots[i+1]), within [degree, nPoles-1]. */
export function findSpan(knots: number[], degree: number, nPoles: number, t: number): number {
  if (t >= knots[nPoles]) return nPoles - 1;
  if (t <= knots[degree]) return degree;
  let lo = degree, hi = nPoles;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < knots[mid]) hi = mid; else lo = mid; }
  return lo;
}

/** Nonzero basis functions and their first derivatives at t (The NURBS Book A2.2 / A2.3, k = 1). */
export function basis(knots: number[], degree: number, span: number, t: number): { N: number[]; dN: number[] } {
  const p = degree;
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
  const left = new Array(p + 1).fill(0), right = new Array(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - knots[span + 1 - j];
    right[j] = knots[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const tmp = ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    ndu[j][j] = saved;
  }
  const N = ndu.map((row) => row[p]);
  const dN = new Array(p + 1).fill(0);
  if (p > 0) {
    for (let r = 0; r <= p; r++) {
      let d = 0;
      if (r >= 1) d += ndu[r - 1][p - 1] / ndu[p][r - 1];
      if (r <= p - 1) d -= ndu[r][p - 1] / ndu[p][r];
      dN[r] = d * p;
    }
  }
  return { N, dN };
}

/** Point and first derivative at parameter t. */
export function splineEval(c: BSpline2, t: number): { p: P2; d: P2 } {
  const n = c.poles.length;
  const span = findSpan(c.knots, c.degree, n, t);
  const { N, dN } = basis(c.knots, c.degree, span, t);
  let x = 0, y = 0, dx = 0, dy = 0;
  for (let j = 0; j <= c.degree; j++) {
    const P = c.poles[span - c.degree + j];
    x += N[j] * P[0]; y += N[j] * P[1];
    dx += dN[j] * P[0]; dy += dN[j] * P[1];
  }
  return { p: [x, y], d: [dx, dy] };
}

export const splinePoint = (c: BSpline2, t: number): P2 => splineEval(c, t).p;

/** The interpolating spline through `pts` (mm). Open: >= 2 points; closed: >= 3 points. */
export function interpolateSpline(pts: P2[], closed: boolean, uniform = false): BSpline2 {
  const n = pts.length;
  if (closed ? n < 3 : n < 2) throw new Error(`A ${closed ? 'closed' : 'open'} spline needs at least ${closed ? 3 : 2} points`);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < SPLINE_MIN_GAP) throw new Error(`Spline points ${i + 1} and ${((i + 1) % n) + 1} are at the same place`);
  }
  return closed ? periodicInterp(pts, uniform) : clampedInterp(pts, uniform);
}

/**
 * Parameter of each point: chord length (the curve follows uneven spacing
 * well), or uniform = one unit per point, so curves with the same number of
 * points share one knot vector (generated loft sections).
 */
function chordParams(pts: P2[], closed: boolean, uniform = false): number[] {
  const t = [0];
  const m = closed ? pts.length : pts.length - 1;
  if (uniform) { for (let i = 0; i < m; i++) t.push(i + 1); return t; }
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    t.push(t[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return t;
}

function clampedInterp(pts: P2[], uniform = false): BSpline2 {
  const n = pts.length;
  const p = Math.min(3, n - 1);
  const raw = chordParams(pts, false, uniform);
  const L = raw[raw.length - 1];
  const t = raw.map((v) => v / L);
  t[n - 1] = 1;
  const knots: number[] = [];
  for (let i = 0; i <= p; i++) knots.push(0);
  for (let j = 1; j <= n - 1 - p; j++) {
    let s = 0;
    for (let i = j; i < j + p; i++) s += t[i];
    knots.push(s / p);
  }
  for (let i = 0; i <= p; i++) knots.push(1);
  const A: number[][] = [];
  for (let k = 0; k < n; k++) {
    const row = new Array(n).fill(0);
    const span = findSpan(knots, p, n, t[k]);
    const { N } = basis(knots, p, span, t[k]);
    for (let j = 0; j <= p; j++) row[span - p + j] = N[j];
    A.push(row);
  }
  const X = solve(A, pts.map((q) => [q[0], q[1]]));
  // Scale the parameter to the curve's length so derivatives are near unit speed.
  const scaled = knots.map((k) => k * L);
  return { degree: p, poles: X.map((r) => [r[0], r[1]] as P2), knots: scaled, t0: 0, t1: L, closed: false, params: t.map((v) => v * L) };
}

/**
 * Closed C2 cubic through every point. Knots u_k = t_(k mod n) + floor(k/n)*T
 * (T = closed polygon length). With the curve defined on [u_3, u_(n+3)], the
 * point Q_i sits at u_(i+3) where only poles i, i+1, i+2 (mod n) act.
 */
function periodicInterp(pts: P2[], uniform = false): BSpline2 {
  const n = pts.length;
  const p = 3;
  const t = chordParams(pts, true, uniform); // t[0..n], t[n] = T
  const T = t[n];
  const u = (k: number) => { const q = Math.floor(k / n); return t[((k % n) + n) % n] + q * T; };
  // Flat knots u_0 .. u_(n+2p) shifted so the domain starts at t_0 = 0: index k -> u(k - p).
  const knots: number[] = [];
  for (let k = 0; k <= n + 2 * p; k++) knots.push(u(k - p));
  const nPoles = n + p;
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(0);
    const ti = t[i];
    const span = findSpan(knots, p, nPoles, ti);
    const { N } = basis(knots, p, span, ti);
    for (let j = 0; j <= p; j++) row[(span - p + j) % n] += N[j];
    A.push(row);
  }
  const X = solve(A, pts.map((q) => [q[0], q[1]]));
  const poles: P2[] = [];
  for (let j = 0; j < nPoles; j++) poles.push([X[j % n][0], X[j % n][1]]);
  return { degree: p, poles, knots, t0: knots[p], t1: knots[nPoles], closed: true, params: t };
}

/** Distinct knots and multiplicities (for OpenCascade). */
export function knotsAndMults(c: BSpline2): { knots: number[]; mults: number[] } {
  const knots: number[] = [], mults: number[] = [];
  for (const k of c.knots) {
    if (knots.length && Math.abs(k - knots[knots.length - 1]) < 1e-12) mults[mults.length - 1]++;
    else { knots.push(k); mults.push(1); }
  }
  return { knots, mults };
}

/** Points along the curve (for display, inside tests and extents). `perSpan` samples per fit-point interval. */
export function sampleSpline(c: BSpline2, perSpan = 16): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < c.params.length - 1; i++) {
    const a = c.params[i], b = c.params[i + 1];
    for (let k = 0; k < perSpan; k++) out.push(splinePoint(c, a + ((b - a) * k) / perSpan));
  }
  out.push(splinePoint(c, c.t1));
  return out;
}

/** Closest point on the curve to q: dense sampling, then Newton steps on the exact curve. */
export function closestOnSpline(c: BSpline2, q: P2): { t: number; p: P2; dist: number } {
  let bestT = c.t0, bestD = Infinity;
  const N = Math.max(64, (c.params.length - 1) * 32);
  for (let i = 0; i <= N; i++) {
    const t = c.t0 + ((c.t1 - c.t0) * i) / N;
    const p = splinePoint(c, t);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  let t = bestT;
  const h = (c.t1 - c.t0) * 1e-6;
  for (let it = 0; it < 30; it++) {
    const { p, d } = splineEval(c, t);
    const e: P2 = [p[0] - q[0], p[1] - q[1]];
    const f = e[0] * d[0] + e[1] * d[1];
    const d2 = splineEval(c, Math.min(c.t1, t + h)).d;
    const dd: P2 = [(d2[0] - d[0]) / h, (d2[1] - d[1]) / h];
    const fp = d[0] * d[0] + d[1] * d[1] + e[0] * dd[0] + e[1] * dd[1];
    if (!(Math.abs(fp) > 1e-18)) break;
    let nt = t - f / fp;
    if (c.closed) { const P = c.t1 - c.t0; nt = c.t0 + ((((nt - c.t0) % P) + P) % P); } else nt = Math.max(c.t0, Math.min(c.t1, nt));
    if (Math.abs(nt - t) < 1e-13 * (c.t1 - c.t0)) { t = nt; break; }
    t = nt;
  }
  const p = splinePoint(c, t);
  const dist = Math.hypot(p[0] - q[0], p[1] - q[1]);
  return dist <= bestD ? { t, p, dist } : { t: bestT, p: splinePoint(c, bestT), dist: bestD };
}

/** Axis-aligned box of the curve: exact for the control polygon hull, refined by dense sampling. */
export function splineBounds(c: BSpline2): { min: P2; max: P2 } {
  const pts = sampleSpline(c, 48);
  const min: P2 = [Infinity, Infinity], max: P2 = [-Infinity, -Infinity];
  for (const p of pts) { min[0] = Math.min(min[0], p[0]); min[1] = Math.min(min[1], p[1]); max[0] = Math.max(max[0], p[0]); max[1] = Math.max(max[1], p[1]); }
  return { min, max };
}

const cache = new Map<string, BSpline2>();
/** Memoized interpolateSpline (sketches are re-evaluated often). */
export function splineFor(pts: P2[], closed: boolean, uniform = false): BSpline2 {
  const key = `${closed ? 'c' : 'o'}${uniform ? 'u' : ''}${pts.map((p) => `${p[0]},${p[1]}`).join(';')}`;
  let c = cache.get(key);
  if (!c) {
    c = interpolateSpline(pts, closed, uniform);
    if (cache.size > 2000) cache.clear();
    cache.set(key, c);
  }
  return c;
}
