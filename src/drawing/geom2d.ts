/**
 * Exact 2D curve types for drawing views, plus the small set of exact
 * operations the drawing needs: bounds, transforms, overlap removal,
 * clipping to a circle (detail views) and sampling for display/export.
 *
 * Curves keep their analytic form (line / circular arc / elliptic arc) so
 * PDF, SVG and DXF exports stay exact. Only true free-form curves (splines)
 * arrive as fine polylines from the kernel.
 *
 * Pure TypeScript, no DOM.
 */

export type V2 = [number, number];
export type V3 = [number, number, number];

/**
 * - line: segment a→b
 * - arc: circle arc from angle a0 counter-clockwise to a1 (a1 > a0, a1 - a0 <= 2π; full circle when equal to 2π)
 * - ellipse: elliptic arc, centre c, semi-axes rx (along angle `rot`) and ry, eccentric-anomaly parameter t0→t1 ccw
 * - poly: open polyline (splines, already sampled finely in the kernel)
 */
export type Curve2 =
  | { k: 'line'; a: V2; b: V2 }
  | { k: 'arc'; c: V2; r: number; a0: number; a1: number }
  | { k: 'ellipse'; c: V2; rx: number; ry: number; rot: number; t0: number; t1: number }
  | { k: 'poly'; pts: V2[] };

export const TAU = Math.PI * 2;
/** Geometric tolerance for "same point / same line" decisions on projected geometry (mm). */
export const EPS = 1e-6;

export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: V2, s: number): V2 => [a[0] * s, a[1] * s];
export const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
export const len = (a: V2) => Math.hypot(a[0], a[1]);
export const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a: V2): V2 => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const perp = (a: V2): V2 => [-a[1], a[0]];
export const lerp = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Normalise an angle into [0, 2π). */
export function normAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

export function ellipsePoint(e: { c: V2; rx: number; ry: number; rot: number }, t: number): V2 {
  const cr = Math.cos(e.rot), sr = Math.sin(e.rot);
  const x = e.rx * Math.cos(t), y = e.ry * Math.sin(t);
  return [e.c[0] + x * cr - y * sr, e.c[1] + x * sr + y * cr];
}

export function arcPoint(c: V2, r: number, a: number): V2 { return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; }

export function curveEnds(cv: Curve2): [V2, V2] {
  switch (cv.k) {
    case 'line': return [cv.a, cv.b];
    case 'arc': return [arcPoint(cv.c, cv.r, cv.a0), arcPoint(cv.c, cv.r, cv.a1)];
    case 'ellipse': return [ellipsePoint(cv, cv.t0), ellipsePoint(cv, cv.t1)];
    case 'poly': return [cv.pts[0], cv.pts[cv.pts.length - 1]];
  }
}

/** Is angle `a` inside the ccw sweep [a0, a1]? */
export function angleInSweep(a: number, a0: number, a1: number, tol = 1e-12): boolean {
  if (a1 - a0 >= TAU - tol) return true;
  const d = normAngle(a - a0);
  return d <= a1 - a0 + tol || d >= TAU - tol;
}

/** Exact axis-aligned bounds of a curve. */
export function curveBounds(cv: Curve2): { min: V2; max: V2 } {
  const pts: V2[] = [];
  switch (cv.k) {
    case 'line': pts.push(cv.a, cv.b); break;
    case 'poly': pts.push(...cv.pts); break;
    case 'arc': {
      pts.push(...curveEnds(cv));
      for (let q = 0; q < 4; q++) { const a = (q * Math.PI) / 2; if (angleInSweep(a, cv.a0, cv.a1)) pts.push(arcPoint(cv.c, cv.r, a)); }
      break;
    }
    case 'ellipse': {
      pts.push(...curveEnds(cv));
      // Extremes in x: dx/dt = 0 → tan t = -(ry sin rot)/(rx cos rot); in y: tan t = (ry cos rot)/(rx sin rot)
      const cr = Math.cos(cv.rot), sr = Math.sin(cv.rot);
      const tx = Math.atan2(-cv.ry * sr, cv.rx * cr), ty = Math.atan2(cv.ry * cr, cv.rx * sr);
      for (const t of [tx, tx + Math.PI, ty, ty + Math.PI]) if (angleInSweep(t, cv.t0, cv.t1)) pts.push(ellipsePoint(cv, t));
      break;
    }
  }
  const min: V2 = [Infinity, Infinity], max: V2 = [-Infinity, -Infinity];
  for (const p of pts) { min[0] = Math.min(min[0], p[0]); min[1] = Math.min(min[1], p[1]); max[0] = Math.max(max[0], p[0]); max[1] = Math.max(max[1], p[1]); }
  return { min, max };
}

export function boundsOf(curves: Curve2[]): { min: V2; max: V2 } | null {
  if (!curves.length) return null;
  const min: V2 = [Infinity, Infinity], max: V2 = [-Infinity, -Infinity];
  for (const c of curves) {
    const b = curveBounds(c);
    min[0] = Math.min(min[0], b.min[0]); min[1] = Math.min(min[1], b.min[1]);
    max[0] = Math.max(max[0], b.max[0]); max[1] = Math.max(max[1], b.max[1]);
  }
  return { min, max };
}

/** Similarity transform p → origin + (p - pivot) * s (uniform scale, no rotation). */
export function transformCurve(cv: Curve2, pivot: V2, s: number, origin: V2): Curve2 {
  const T = (p: V2): V2 => [origin[0] + (p[0] - pivot[0]) * s, origin[1] + (p[1] - pivot[1]) * s];
  switch (cv.k) {
    case 'line': return { k: 'line', a: T(cv.a), b: T(cv.b) };
    case 'arc': return { ...cv, c: T(cv.c), r: cv.r * s };
    case 'ellipse': return { ...cv, c: T(cv.c), rx: cv.rx * s, ry: cv.ry * s };
    case 'poly': return { k: 'poly', pts: cv.pts.map(T) };
  }
}

/**
 * Sample a curve so the chordal error is at most `tol` (same units as the curve).
 * Used for hit testing, hatching and DXF ellipses; analytic curves are still
 * exported analytically wherever the format supports it.
 */
export function sampleCurve(cv: Curve2, tol = 0.001): V2[] {
  switch (cv.k) {
    case 'line': return [cv.a, cv.b];
    case 'poly': return cv.pts;
    case 'arc': {
      const sweep = cv.a1 - cv.a0;
      const step = cv.r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / cv.r)) : sweep;
      const n = Math.max(2, Math.ceil(sweep / Math.max(step, 1e-4)));
      const out: V2[] = [];
      for (let i = 0; i <= n; i++) out.push(arcPoint(cv.c, cv.r, cv.a0 + (sweep * i) / n));
      return out;
    }
    case 'ellipse': {
      const sweep = cv.t1 - cv.t0;
      const rmax = Math.max(cv.rx, cv.ry);
      const step = rmax > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / rmax)) : sweep;
      const n = Math.max(2, Math.ceil(sweep / Math.max(step, 1e-4)));
      const out: V2[] = [];
      for (let i = 0; i <= n; i++) out.push(ellipsePoint(cv, cv.t0 + (sweep * i) / n));
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Interval helpers (for overlap removal)

type Interval = [number, number];

/** Subtract a set of intervals from [lo, hi]. */
function subtractIntervals(lo: number, hi: number, cut: Interval[], tol: number): Interval[] {
  let parts: Interval[] = [[lo, hi]];
  for (const [c0, c1] of cut) {
    const next: Interval[] = [];
    for (const [p0, p1] of parts) {
      if (c1 <= p0 + tol || c0 >= p1 - tol) { next.push([p0, p1]); continue; }
      if (c0 > p0 + tol) next.push([p0, c0]);
      if (c1 < p1 - tol) next.push([c1, p1]);
    }
    parts = next;
  }
  return parts.filter(([a, b]) => b - a > tol);
}

/** Angular coverage of a ccw sweep, unrolled relative to `base` into [base, base + 2π]. */
function sweepIntervals(a0: number, a1: number, base: number): Interval[] {
  if (a1 - a0 >= TAU - 1e-12) return [[base - 1, base + TAU + 1]];
  const s = base + normAngle(a0 - base);
  const e = s + (a1 - a0);
  return e <= base + TAU ? [[s, e]] : [[s, base + TAU], [base, e - TAU]];
}

const sameLine = (a: { a: V2; b: V2 }, b: { a: V2; b: V2 }, tol: number) => {
  const d = norm(sub(a.b, a.a));
  return Math.abs(cross(d, sub(b.a, a.a))) < tol && Math.abs(cross(d, sub(b.b, a.a))) < tol;
};

/**
 * Remove the parts of `curves` already covered by `cover` (e.g. hidden lines
 * that coincide with visible lines: a visible line takes precedence, per
 * ASME Y14.2 / ISO 128 line precedence). Also removes duplicates within
 * `curves` itself. Lines, arcs and ellipses are handled exactly; polylines
 * are kept unless an identical polyline exists.
 */
export function removeCovered(curves: Curve2[], cover: Curve2[], tol = 1e-5): Curve2[] {
  const out: Curve2[] = [];
  const accepted: Curve2[] = [...cover];
  for (const cv of curves) {
    let pieces: Curve2[] = [cv];
    if (cv.k === 'line') {
      const L = dist(cv.a, cv.b);
      if (L < tol) continue;
      const d = norm(sub(cv.b, cv.a));
      const cuts: Interval[] = [];
      for (const o of accepted) {
        if (o.k !== 'line' || !sameLine(cv, o, tol)) continue;
        const t0 = dot(sub(o.a, cv.a), d), t1 = dot(sub(o.b, cv.a), d);
        cuts.push([Math.min(t0, t1), Math.max(t0, t1)]);
      }
      pieces = subtractIntervals(0, L, cuts, tol).map(([s, e]) => ({ k: 'line', a: add(cv.a, mul(d, s)), b: add(cv.a, mul(d, e)) }));
    } else if (cv.k === 'arc') {
      const atol = tol / Math.max(cv.r, tol);
      const cuts: Interval[] = [];
      for (const o of accepted) {
        if (o.k !== 'arc' || dist(o.c, cv.c) > tol || Math.abs(o.r - cv.r) > tol) continue;
        cuts.push(...sweepIntervals(o.a0, o.a1, cv.a0));
      }
      pieces = subtractIntervals(cv.a0, cv.a1, cuts, atol).map(([s, e]) => ({ ...cv, a0: s, a1: e }));
    } else if (cv.k === 'ellipse') {
      const atol = tol / Math.max(cv.ry, tol);
      const cuts: Interval[] = [];
      for (const o of accepted) {
        if (o.k !== 'ellipse' || dist(o.c, cv.c) > tol || Math.abs(o.rx - cv.rx) > tol || Math.abs(o.ry - cv.ry) > tol) continue;
        // Same ellipse with the same major-axis direction (rot mod π). A rot difference of π flips the parameter by π.
        const dr = normAngle(o.rot - cv.rot);
        let shift: number;
        if (dr < 1e-9 || dr > TAU - 1e-9) shift = 0;
        else if (Math.abs(dr - Math.PI) < 1e-9) shift = Math.PI;
        else continue;
        cuts.push(...sweepIntervals(o.t0 + shift, o.t1 + shift, cv.t0));
      }
      pieces = subtractIntervals(cv.t0, cv.t1, cuts, atol).map(([s, e]) => ({ ...cv, t0: s, t1: e }));
    } else {
      const dup = accepted.some((o) => o.k === 'poly' && o.pts.length === cv.pts.length && o.pts.every((p, i) => dist(p, cv.pts[i]) < tol));
      if (dup) pieces = [];
    }
    for (const p of pieces) { out.push(p); accepted.push(p); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clipping to a circle (detail views). Exact for lines, arcs and ellipses.

function lineCircleParams(a: V2, b: V2, c: V2, r: number): number[] {
  const d = sub(b, a), f = sub(a, c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0 || A === 0) return [];
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => t > 0 && t < 1);
}

/** Angles on circle (c1, r1) where it meets circle (c2, r2). */
function circleCircleAngles(c1: V2, r1: number, c2: V2, r2: number): number[] {
  const d = dist(c1, c2);
  if (d < 1e-12 || d > r1 + r2 || d < Math.abs(r1 - r2)) return [];
  const base = Math.atan2(c2[1] - c1[1], c2[0] - c1[0]);
  const cosA = (r1 * r1 + d * d - r2 * r2) / (2 * r1 * d);
  const h = Math.acos(Math.max(-1, Math.min(1, cosA)));
  return [base - h, base + h];
}

/**
 * Parameters t where an ellipse meets a circle. Solved numerically on the
 * analytic curves (root bracketing on a dense parameter grid, then bisection
 * to 1e-14), so the result is exact to double precision.
 */
function ellipseCircleParams(e: Extract<Curve2, { k: 'ellipse' }>, c: V2, r: number): number[] {
  const f = (t: number) => { const p = ellipsePoint(e, t); return (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 - r * r; };
  const out: number[] = [];
  const N = 720;
  let t0 = e.t0, f0 = f(t0);
  for (let i = 1; i <= N; i++) {
    const t1 = e.t0 + ((e.t1 - e.t0) * i) / N, f1 = f(t1);
    if (f0 === 0) out.push(t0);
    else if (f0 * f1 < 0) {
      let lo = t0, hi = t1, flo = f0;
      for (let k = 0; k < 80 && hi - lo > 1e-14; k++) { const m = (lo + hi) / 2, fm = f(m); if (flo * fm <= 0) hi = m; else { lo = m; flo = fm; } }
      out.push((lo + hi) / 2);
    }
    t0 = t1; f0 = f1;
  }
  return out.filter((t) => t > e.t0 && t < e.t1);
}

/** Keep only the parts of a curve inside the circle (c, r). */
export function clipToCircle(cv: Curve2, c: V2, r: number): Curve2[] {
  const inside = (p: V2) => dist(p, c) <= r;
  switch (cv.k) {
    case 'line': {
      const ts = [0, ...lineCircleParams(cv.a, cv.b, c, r), 1];
      const out: Curve2[] = [];
      for (let i = 0; i + 1 < ts.length; i++) {
        const m = lerp(cv.a, cv.b, (ts[i] + ts[i + 1]) / 2);
        if (inside(m)) out.push({ k: 'line', a: lerp(cv.a, cv.b, ts[i]), b: lerp(cv.a, cv.b, ts[i + 1]) });
      }
      return out;
    }
    case 'arc': {
      const cuts = circleCircleAngles(cv.c, cv.r, c, r).map((a) => cv.a0 + normAngle(a - cv.a0)).filter((a) => a > cv.a0 && a < cv.a1);
      const ts = [cv.a0, ...cuts.sort((x, y) => x - y), cv.a1];
      const out: Curve2[] = [];
      for (let i = 0; i + 1 < ts.length; i++) if (inside(arcPoint(cv.c, cv.r, (ts[i] + ts[i + 1]) / 2))) out.push({ ...cv, a0: ts[i], a1: ts[i + 1] });
      // A full circle cut at two points must be rejoined into one arc across a0.
      if (cv.a1 - cv.a0 >= TAU - 1e-12 && out.length >= 2) {
        const first = out[0] as typeof cv, last = out[out.length - 1] as typeof cv;
        if (first.a0 === cv.a0 && last.a1 === cv.a1) return [{ ...cv, a0: last.a0, a1: first.a1 + TAU }, ...out.slice(1, -1)];
      }
      return out;
    }
    case 'ellipse': {
      const ts = [cv.t0, ...ellipseCircleParams(cv, c, r).sort((x, y) => x - y), cv.t1];
      const out: Curve2[] = [];
      for (let i = 0; i + 1 < ts.length; i++) if (inside(ellipsePoint(cv, (ts[i] + ts[i + 1]) / 2))) out.push({ ...cv, t0: ts[i], t1: ts[i + 1] });
      if (cv.t1 - cv.t0 >= TAU - 1e-12 && out.length >= 2) {
        const first = out[0] as typeof cv, last = out[out.length - 1] as typeof cv;
        if (first.t0 === cv.t0 && last.t1 === cv.t1) return [{ ...cv, t0: last.t0, t1: first.t1 + TAU }, ...out.slice(1, -1)];
      }
      return out;
    }
    case 'poly': {
      const out: Curve2[] = [];
      let run: V2[] = [];
      for (let i = 0; i + 1 < cv.pts.length; i++) {
        const segs = clipToCircle({ k: 'line', a: cv.pts[i], b: cv.pts[i + 1] }, c, r) as Extract<Curve2, { k: 'line' }>[];
        for (const s of segs) {
          if (run.length && dist(run[run.length - 1], s.a) < 1e-12) run.push(s.b);
          else { if (run.length > 1) out.push({ k: 'poly', pts: run }); run = [s.a, s.b]; }
        }
      }
      if (run.length > 1) out.push({ k: 'poly', pts: run });
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Hatching (section views). The section boundary is given as polylines that
// together form closed loops (a "segment soup": order and direction do not
// matter). Hatch lines are clipped with the even-odd rule.

export function hatchSegments(chains: V2[][], angle: number, spacing: number, phase = 0): [V2, V2][] {
  if (!(spacing > 0)) return [];
  const d: V2 = [Math.cos(angle), Math.sin(angle)];
  const n: V2 = perp(d);
  let lo = Infinity, hi = -Infinity;
  for (const L of chains) for (const p of L) { const s = dot(p, n); lo = Math.min(lo, s); hi = Math.max(hi, s); }
  if (!isFinite(lo)) return [];
  const out: [V2, V2][] = [];
  const k0 = Math.ceil((lo - phase) / spacing), k1 = Math.floor((hi - phase) / spacing);
  if (k1 - k0 > 20000) return [];
  for (let k = k0; k <= k1; k++) {
    const s = phase + k * spacing;
    const ts: number[] = [];
    for (const L of chains) {
      for (let i = 0; i + 1 < L.length; i++) {
        const p = L[i], q = L[i + 1];
        const sp = dot(p, n) - s, sq = dot(q, n) - s;
        if ((sp > 0) === (sq > 0)) continue; // half-open rule avoids double counting shared vertices
        const t = sp / (sp - sq);
        ts.push(dot(lerp(p, q, t), d));
      }
    }
    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i += 2) {
      if (ts[i + 1] - ts[i] < 1e-9) continue;
      const base = mul(n, s);
      out.push([add(base, mul(d, ts[i])), add(base, mul(d, ts[i + 1]))]);
    }
  }
  return out;
}

/** Point inside a region bounded by polylines (even-odd rule, segment soup). */
export function insideChains(p: V2, chains: V2[][]): boolean {
  let inside = false;
  for (const L of chains) {
    for (let i = 0; i + 1 < L.length; i++) {
      const a = L[i], b = L[i + 1];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from point p to a curve (for picking). */
export function distanceToCurve(p: V2, cv: Curve2): number {
  if (cv.k === 'line') return distToSeg(p, cv.a, cv.b);
  if (cv.k === 'arc') {
    const a = Math.atan2(p[1] - cv.c[1], p[0] - cv.c[0]);
    if (angleInSweep(a, cv.a0, cv.a1)) return Math.abs(dist(p, cv.c) - cv.r);
    const [e0, e1] = curveEnds(cv);
    return Math.min(dist(p, e0), dist(p, e1));
  }
  const pts = sampleCurve(cv, 0.01);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, distToSeg(p, pts[i], pts[i + 1]));
  return best;
}

export function distToSeg(p: V2, a: V2, b: V2): number {
  const d = sub(b, a), L2 = dot(d, d);
  const t = L2 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / L2)) : 0;
  return dist(p, add(a, mul(d, t)));
}
