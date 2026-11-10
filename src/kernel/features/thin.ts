/**
 * Thin features: turn sketch curves into a constant-thickness wall region
 * (mainstream CAD "Thin Feature" on revolves, and later extrudes).
 *
 * Pure 2D math on evaluated sketch entities (mm, radians), no kernel calls.
 * Offsets are exact: lines are shifted, arcs keep their center and change
 * radius. Corners that are not tangent are joined sharp, by intersecting
 * the two offset curves (lines extended, arcs as full circles). Open chains
 * are capped square at both ends (the cap is the end point's normal).
 *
 * Thickness sides: t1 is on the LEFT of the chain's direction, t2 on the
 * right. Closed loops are first turned counter-clockwise, so for them t1 is
 * inside and t2 is outside. Splines cannot be offset exactly and are refused.
 */
import { type EvalEntity, type Loop, findLoops } from '../regen';
import { chainEntities } from './sweep';

type P2 = [number, number];
type Seg =
  | { kind: 'line'; id: string; a: P2; b: P2 }
  /** Arc from angle s0 sweeping `sweep` radians (positive = counter-clockwise). */
  | { kind: 'arc'; id: string; c: P2; r: number; s0: number; sweep: number };

const TAU = 2 * Math.PI;
const EPS = 1e-9;
const sub = (p: P2, q: P2): P2 => [p[0] - q[0], p[1] - q[1]];
const addv = (p: P2, q: P2): P2 => [p[0] + q[0], p[1] + q[1]];
const mul = (p: P2, k: number): P2 => [p[0] * k, p[1] * k];
const dot = (p: P2, q: P2) => p[0] * q[0] + p[1] * q[1];
const dist = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const unit = (p: P2): P2 => { const l = Math.hypot(p[0], p[1]); return [p[0] / l, p[1] / l]; };
const perp = (p: P2): P2 => [-p[1], p[0]];
const polar = (c: P2, r: number, a: number): P2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
const wrapPi = (a: number) => { let x = ((a % TAU) + TAU) % TAU; if (x > Math.PI) x -= TAU; return x; };

function segOf(e: EvalEntity, rev: boolean): Seg {
  if (e.kind === 'line') return rev ? { kind: 'line', id: e.id, a: e.b, b: e.a } : { kind: 'line', id: e.id, a: e.a, b: e.b };
  if (e.kind === 'arc') {
    let a1 = e.a1; while (a1 <= e.a0) a1 += TAU;
    const s = a1 - e.a0;
    return rev ? { kind: 'arc', id: e.id, c: e.c, r: e.r, s0: a1, sweep: -s } : { kind: 'arc', id: e.id, c: e.c, r: e.r, s0: e.a0, sweep: s };
  }
  if (e.kind === 'circle') return { kind: 'arc', id: e.id, c: e.c, r: e.r, s0: 0, sweep: rev ? -TAU : TAU };
  if (e.kind === 'spline') throw new Error('A thin feature cannot offset a spline exactly; use lines and arcs');
  throw new Error('A sketch point cannot be part of a thin feature');
}

const start = (s: Seg): P2 => (s.kind === 'line' ? s.a : polar(s.c, s.r, s.s0));
const end = (s: Seg): P2 => (s.kind === 'line' ? s.b : polar(s.c, s.r, s.s0 + s.sweep));
/** The curve shifted by d to its left. */
function offsetSeg(s: Seg, d: number, newId: string): Seg {
  if (d === 0) return { ...s };
  if (s.kind === 'line') {
    const n = mul(perp(unit(sub(s.b, s.a))), d);
    return { kind: 'line', id: newId, a: addv(s.a, n), b: addv(s.b, n) };
  }
  // Left of a counter-clockwise arc is toward its center.
  const r = s.r - d * Math.sign(s.sweep);
  if (!(r > 1e-7)) throw new Error(`The thickness is larger than the radius of arc ${s.id}`);
  return { kind: 'arc', id: newId, c: s.c, r, s0: s.s0, sweep: s.sweep };
}

/** Intersections of the two segments' carrier curves (infinite line / full circle). */
function intersect(p: Seg, q: Seg): P2[] {
  if (p.kind === 'line' && q.kind === 'line') {
    const u = sub(p.b, p.a), v = sub(q.b, q.a);
    const den = u[0] * v[1] - u[1] * v[0];
    if (Math.abs(den) < EPS * Math.hypot(...u) * Math.hypot(...v)) return [];
    const w = sub(q.a, p.a);
    const t = (w[0] * v[1] - w[1] * v[0]) / den;
    return [addv(p.a, mul(u, t))];
  }
  if (p.kind === 'arc' && q.kind === 'arc') {
    const d = dist(p.c, q.c);
    if (d < EPS) return [];
    const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
    const h2 = p.r * p.r - a * a;
    if (h2 < -1e-9) return [];
    const h = Math.sqrt(Math.max(0, h2));
    const ex = unit(sub(q.c, p.c));
    const m = addv(p.c, mul(ex, a));
    return [addv(m, mul(perp(ex), h)), addv(m, mul(perp(ex), -h))];
  }
  const [ln, ar] = p.kind === 'line' ? [p, q as Extract<Seg, { kind: 'arc' }>] : [q as Extract<Seg, { kind: 'line' }>, p];
  const u = unit(sub(ln.b, ln.a));
  const f = sub(ln.a, ar.c);
  const b = dot(f, u), c = dot(f, f) - ar.r * ar.r;
  const disc = b * b - c;
  if (disc < -1e-9) return [];
  const s = Math.sqrt(Math.max(0, disc));
  return [addv(ln.a, mul(u, -b + s)), addv(ln.a, mul(u, -b - s))];
}

function setStart(s: Seg, p: P2) {
  if (s.kind === 'line') { s.a = p; return; }
  const a = Math.atan2(p[1] - s.c[1], p[0] - s.c[0]);
  const d = wrapPi(a - s.s0);
  s.s0 += d; s.sweep -= d;
}
function setEnd(s: Seg, p: P2) {
  if (s.kind === 'line') { s.b = p; return; }
  const e0 = s.s0 + s.sweep;
  const a = Math.atan2(p[1] - s.c[1], p[0] - s.c[0]);
  s.sweep += wrapPi(a - e0);
}

/** Join offset segment p (ending) to q (starting) where the originals met at `corner`. */
function join(p: Seg, q: Seg, corner: P2) {
  const e = end(p), b = start(q);
  if (dist(e, b) < 1e-9) { setEnd(p, e); setStart(q, e); return; }
  const cands = intersect(p, q);
  if (!cands.length) throw new Error(`The thin wall cannot be joined at the corner between ${p.id.split('~')[0]} and ${q.id.split('~')[0]}; reduce the thickness or round the corner`);
  const mid = mul(addv(e, b), 0.5);
  let best = cands[0];
  for (const c of cands) if (dist(c, mid) + dist(c, corner) < dist(best, mid) + dist(best, corner)) best = c;
  setEnd(p, best); setStart(q, best);
}

/** Check a trimmed offset segment still runs the same way as its original (not turned inside out). */
function checkSeg(orig: Seg, s: Seg) {
  if (s.kind === 'line' && orig.kind === 'line') {
    if (dot(sub(s.b, s.a), sub(orig.b, orig.a)) <= 1e-9) throw new Error(`The thickness is too large for ${orig.id} (its offset turns inside out)`);
  } else if (s.kind === 'arc' && orig.kind === 'arc') {
    if (Math.sign(s.sweep) !== Math.sign(orig.sweep) || Math.abs(s.sweep) < 1e-9) throw new Error(`The thickness is too large for arc ${orig.id} (its offset turns inside out)`);
  }
}

function offsetChain(segs: Seg[], d: number, closed: boolean, tag: string): Seg[] {
  if (d === 0) return segs.map((s) => ({ ...s }));
  const out = segs.map((s) => offsetSeg(s, d, `${s.id}~${tag}`));
  const n = segs.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    if (closed && n === 1) break; // a lone circle needs no join
    join(out[i], out[(i + 1) % n], end(segs[i]));
  }
  out.forEach((s, i) => checkSeg(segs[i], s));
  return out;
}

function toEntity(s: Seg): EvalEntity {
  if (s.kind === 'line') return { id: s.id, kind: 'line', a: s.a, b: s.b, construction: false };
  if (Math.abs(Math.abs(s.sweep) - TAU) < 1e-12) return { id: s.id, kind: 'circle', c: s.c, r: s.r, construction: false };
  const a0 = s.sweep > 0 ? s.s0 : s.s0 + s.sweep;
  return { id: s.id, kind: 'arc', c: s.c, r: s.r, a0, a1: a0 + Math.abs(s.sweep), construction: false };
}

function signedArea(segs: Seg[]): number {
  // Shoelace over a fine sampling (orientation only).
  const pts: P2[] = [];
  for (const s of segs) {
    if (s.kind === 'line') pts.push(s.a);
    else for (let k = 0; k < 32; k++) pts.push(polar(s.c, s.r, s.s0 + (s.sweep * k) / 32));
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

/**
 * The wall region of a thin feature. `entities`: the sketch's profile curves
 * (construction geometry and points are ignored). Returns closed Loops for
 * sweepRegion: one per open chain, or an inner and outer loop per closed loop.
 */
export function thinLoops(entities: EvalEntity[], t1: number, t2: number, autoFillet?: number): Loop[] {
  if (!(t1 >= 0) || !(t2 >= 0) || !(t1 + t2 > 0)) throw new Error('Thin feature thickness must be greater than zero');
  const curves = entities.filter((e) => !e.construction && e.kind !== 'point');
  if (!curves.length) throw new Error('The sketch has no lines or arcs for the thin feature');
  if (curves.some((e) => e.kind === 'spline')) throw new Error('A thin feature cannot offset a spline exactly; use lines and arcs');
  let closedLoops: Loop[] | null = null;
  try { closedLoops = findLoops(curves); } catch { closedLoops = null; }
  const ents: EvalEntity[] = [];
  if (closedLoops && closedLoops.length) {
    for (const L of closedLoops) {
      let segs = chainEntities(L.entities).map(({ e, rev }) => segOf(e, rev));
      if (signedArea(segs) < 0) segs = segs.slice().reverse().map(flip);
      ents.push(...offsetChain(segs, t1, true, 'in').map(toEntity));
      ents.push(...offsetChain(segs, -t2, true, 'out').map(toEntity));
    }
  } else {
    let segs = chainEntities(curves).map(({ e, rev }) => segOf(e, rev));
    if (autoFillet !== undefined) segs = filletCorners(segs, autoFillet, t1, t2);
    const first = segs[0], last = segs[segs.length - 1];
    const sA = start(first), eA = end(last);
    if (dist(sA, eA) < 1e-6) throw new Error('The thin feature profile must be one open chain or closed loops');
    const A = offsetChain(segs, t1, false, 'left');
    const B = offsetChain(segs, -t2, false, 'right');
    ents.push(...A.map(toEntity), ...B.map(toEntity));
    ents.push({ id: `${last.id}~capEnd`, kind: 'line', a: end(A[A.length - 1]), b: end(B[B.length - 1]), construction: false });
    ents.push({ id: `${first.id}~capStart`, kind: 'line', a: start(B[0]), b: start(A[0]), construction: false });
  }
  const loops = findLoops(ents);
  if (!loops.length) throw new Error('The thin feature did not make a closed region');
  return loops;
}

/**
 * Auto-fillet corners (mainstream CAD thin feature, open profiles): round every
 * corner where two lines meet at an angle so the wall's INSIDE radius is `r`.
 * The chain itself is rounded with r plus the thickness on the inside of the
 * bend (t1 = left side, so a left turn gets r + t1), which makes the inner
 * wall exactly r and the outer wall r + t1 + t2, both tangent and concentric.
 */
function filletCorners(segs: Seg[], r: number, t1: number, t2: number): Seg[] {
  if (!(r > 0)) throw new Error('Auto-fillet radius must be greater than zero');
  const work = segs.map((s) => ({ ...s })) as Seg[];
  const dirs = segs.map((s) => (s.kind === 'line' ? unit(sub(s.b, s.a)) : null));
  const out: Seg[] = [];
  for (let i = 0; i < work.length; i++) {
    out.push(work[i]);
    const p = work[i], q = work[i + 1];
    if (!q || p.kind !== 'line' || q.kind !== 'line') continue;
    const u = dirs[i]!, v = dirs[i + 1]!;
    const cr = u[0] * v[1] - u[1] * v[0];
    const c = Math.max(-1, Math.min(1, dot(u, v)));
    if (Math.abs(cr) < 1e-12 && c > 0) continue; // straight on: no corner
    if (c < -1 + 1e-12) throw new Error(`Lines ${p.id} and ${q.id} fold back on each other; there is no corner to round`);
    const left = cr > 0;
    const R = r + (left ? t1 : t2);
    const turn = Math.acos(c);
    const back = R * Math.tan(turn / 2);
    const corner = p.b;
    const A = addv(corner, mul(u, -back)), B = addv(corner, mul(v, back));
    p.b = A; q.a = B;
    const center = addv(A, mul(perp(u), left ? R : -R));
    out.push({ kind: 'arc', id: `${p.id}~round`, c: center, r: R, s0: Math.atan2(A[1] - center[1], A[0] - center[0]), sweep: left ? turn : -turn });
  }
  work.forEach((s, i) => {
    if (s.kind === 'line' && dot(sub(s.b, s.a), dirs[i]!) <= 1e-9) throw new Error(`The auto-fillet radius is too large for line ${s.id}`);
  });
  return out;
}

function flip(s: Seg): Seg {
  if (s.kind === 'line') return { ...s, a: s.b, b: s.a };
  return { ...s, s0: s.s0 + s.sweep, sweep: -s.sweep };
}
