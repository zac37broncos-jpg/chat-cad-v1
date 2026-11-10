/**
 * Our own equations for every sketch constraint. They are independent of
 * planegcs and are used to:
 *  1. verify every solve (a sketch is only accepted when all driving
 *     constraints hold to RESIDUAL_TOL, see docs/ARCHITECTURE.md, Precision), and
 *  2. find which entities are fully defined (rank / null-space analysis of
 *     the constraint Jacobian), which drives the under/fully/over colouring.
 *
 * All residuals are in millimeters: angle-type residuals are multiplied by a
 * characteristic sketch length so one tolerance applies everywhere.
 */
import type { PointRef, SketchConstraint } from '../core/model';
import { isDimension } from '../core/model';
import {
  type P2, type WEntity, type WSketch, sub, cross, dot, dist, constraintRefs, norm, wrapPi, pointOf, entityBounds, BUILTIN, polar,
} from './geom';

/** Largest residual (mm) a solved sketch may have. 1e-7 mm = 4e-9 in. */
export const RESIDUAL_TOL = 1e-7;

export interface EqContext {
  values: Map<string, number>;
  /** Geometry before solving: fixes hold these values; one-sided dimensions take their side from it. */
  base: Map<string, WEntity>;
  /** Characteristic length (mm) for scaling angle residuals. */
  scale: number;
  /** Tangent constraint id -> the shared point where the two curves touch (endpoint tangency). */
  tangentAt: Map<string, PointRef>;
}

export type Getter = (id: string) => WEntity;

function line(E: Getter, id: string): { a: P2; b: P2 } {
  const e = E(id);
  if (e.kind !== 'line') throw new Error(`${id} is not a line`);
  return e;
}
function round(E: Getter, id: string): { c: P2; r: number } {
  const e = E(id);
  if (e.kind !== 'circle' && e.kind !== 'arc') throw new Error(`${id} is not a circle or arc`);
  return e;
}
const P = (E: Getter, r: { e: string; p: any }) => pointOf(E(r.e), r.p);
const sgn = (x: number) => (x < 0 ? -1 : 1);

/** Signed distance from p to the infinite line a-b. */
function lineDist(p: P2, a: P2, b: P2): number { return cross(sub(p, a), norm(sub(b, a))); }

/** Sign used by one-sided constraints (h/v distance, offset radius), taken from the pre-solve geometry. */
export function constraintSign(c: SketchConstraint, base: Getter): number {
  if (c.type === 'distance' && c.dir) {
    const d = sub(P(base, c.b), P(base, c.a));
    return sgn(c.dir === 'h' ? d[0] : d[1]);
  }
  return 1;
}
export function offsetPairSign(src: WEntity, dst: WEntity): number {
  if ((src.kind === 'circle' || src.kind === 'arc') && (dst.kind === 'circle' || dst.kind === 'arc')) return sgn(dst.r - src.r);
  return 1;
}

/** Residuals of one constraint (empty for reference dimensions). Throws on invalid references. */
export function residuals(c: SketchConstraint, E: Getter, ctx: EqContext): number[] {
  if (isDimension(c) && c.driven) return [];
  const S = ctx.scale;
  const B: Getter = (id) => ctx.base.get(id) ?? E(id);
  const v = ctx.values.get(c.id) ?? NaN;
  switch (c.type) {
    case 'coincident': { const a = P(E, c.a), b = P(E, c.b); return [b[0] - a[0], b[1] - a[1]]; }
    case 'pointOn': {
      const p = P(E, c.p), t = E(c.on);
      if (t.kind === 'line') return [lineDist(p, t.a, t.b)];
      if (t.kind === 'circle' || t.kind === 'arc') return [dist(p, t.c) - t.r];
      throw new Error('A point can only lie on a line, circle or arc');
    }
    case 'horizontal': { const l = line(E, c.e); return [l.b[1] - l.a[1]]; }
    case 'vertical': { const l = line(E, c.e); return [l.b[0] - l.a[0]]; }
    case 'horizontalPoints': return [P(E, c.b)[1] - P(E, c.a)[1]];
    case 'verticalPoints': return [P(E, c.b)[0] - P(E, c.a)[0]];
    case 'parallel': { const a = line(E, c.a), b = line(E, c.b); return [S * cross(norm(sub(a.b, a.a)), norm(sub(b.b, b.a)))]; }
    case 'perpendicular': { const a = line(E, c.a), b = line(E, c.b); return [S * dot(norm(sub(a.b, a.a)), norm(sub(b.b, b.a)))]; }
    case 'collinear': { const a = line(E, c.a), b = line(E, c.b); return [lineDist(a.a, b.a, b.b), lineDist(a.b, b.a, b.b)]; }
    case 'equal': {
      const a = E(c.a), b = E(c.b);
      if (a.kind === 'line' && b.kind === 'line') return [dist(a.a, a.b) - dist(b.a, b.b)];
      return [round(E, c.a).r - round(E, c.b).r];
    }
    case 'concentric': { const a = round(E, c.a).c, b = round(E, c.b).c; return [b[0] - a[0], b[1] - a[1]]; }
    case 'tangent': {
      const at = ctx.tangentAt.get(c.id);
      if (at) {
        // Endpoint tangency: the curves' normals at the shared point are parallel.
        const p = P(E, at);
        return [S * cross(norm(curveNormal(E(c.a), p)), norm(curveNormal(E(c.b), p)))];
      }
      const a = E(c.a), b = E(c.b);
      if (a.kind === 'line' || b.kind === 'line') {
        const l = a.kind === 'line' ? a : (b as Extract<WEntity, { kind: 'line' }>);
        const k = round(E, a.kind === 'line' ? c.b : c.a);
        return [Math.abs(lineDist(k.c, l.a, l.b)) - k.r];
      }
      const ka = round(E, c.a), kb = round(E, c.b);
      const d = dist(ka.c, kb.c);
      return [c.internal ? d - Math.abs(ka.r - kb.r) : d - (ka.r + kb.r)];
    }
    case 'midpoint': {
      const p = P(E, c.p), l = line(E, c.line);
      return [p[0] - (l.a[0] + l.b[0]) / 2, p[1] - (l.a[1] + l.b[1]) / 2];
    }
    case 'symmetric': {
      const a = P(E, c.a), b = P(E, c.b), l = line(E, c.line);
      const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return [lineDist(m, l.a, l.b), dot(sub(b, a), norm(sub(l.b, l.a)))];
    }
    case 'fix': {
      const e = E(c.e), o = B(c.e);
      if (e.kind === 'point' && o.kind === 'point') return [e.p[0] - o.p[0], e.p[1] - o.p[1]];
      if (e.kind === 'line' && o.kind === 'line') return [e.a[0] - o.a[0], e.a[1] - o.a[1], e.b[0] - o.b[0], e.b[1] - o.b[1]];
      if (e.kind === 'circle' && o.kind === 'circle') return [e.c[0] - o.c[0], e.c[1] - o.c[1], e.r - o.r];
      if (e.kind === 'arc' && o.kind === 'arc') return [e.c[0] - o.c[0], e.c[1] - o.c[1], e.r - o.r, o.r * wrapPi(e.a0 - o.a0), o.r * wrapPi(e.a1 - o.a1)];
      return [];
    }
    case 'distance': {
      const a = P(E, c.a), b = P(E, c.b);
      if (!c.dir) return [dist(a, b) - v];
      const s = constraintSign(c, B);
      return [s * (c.dir === 'h' ? b[0] - a[0] : b[1] - a[1]) - v];
    }
    case 'pointLineDistance': {
      const p = P(E, c.p), l = line(E, c.line);
      const d = lineDist(p, l.a, l.b);
      return [v === 0 ? d : Math.abs(d) - v];
    }
    case 'radius': return [round(E, c.e).r - v];
    case 'diameter': return [2 * round(E, c.e).r - v];
    case 'angle': {
      const a = line(E, c.a), b = line(E, c.b);
      const da = sub(a.b, a.a), db = sub(b.b, b.a);
      const t = angleTarget(c.sense, !!c.supplement, v);
      return [S * wrapPi(Math.atan2(cross(da, db), dot(da, db)) - t)];
    }
    case 'offset': {
      const out: number[] = [];
      for (const pr of c.pairs) {
        const s = E(pr.src), d = E(pr.dst);
        if (s.kind === 'line' && d.kind === 'line') {
          out.push(S * cross(norm(sub(s.b, s.a)), norm(sub(d.b, d.a))), Math.abs(lineDist(d.a, s.a, s.b)) - v);
          const u = norm(sub(s.b, s.a));
          for (const end of pr.pin ?? []) out.push(end === 'start' ? dot(sub(d.a, s.a), u) : dot(sub(d.b, s.b), u));
        } else if ((s.kind === 'circle' || s.kind === 'arc') && (d.kind === 'circle' || d.kind === 'arc')) {
          const sign = offsetPairSign(B(pr.src), B(pr.dst));
          out.push(d.c[0] - s.c[0], d.c[1] - s.c[1], sign * (d.r - s.r) - v);
          if (s.kind === 'arc' && d.kind === 'arc') {
            for (const end of pr.pin ?? []) {
              const ps = pointOf(s, end), pd = pointOf(d, end);
              out.push(lineDist(pd, s.c, ps));
            }
          }
        } else throw new Error('Offset pairs must be line-line or arc/circle-arc/circle');
      }
      return out;
    }
  }
}

/** Directed CCW angle from line a to line b (rad) that an angle dimension enforces. */
export function angleTarget(sense: 1 | -1, supplement: boolean, value: number): number {
  return sense * (supplement ? Math.PI - value : value);
}

export function sketchScale(ents: WEntity[]): number {
  const b = entityBounds(ents);
  return b ? Math.max(1, dist(b.min, b.max)) : 1;
}

export function makeContext(ws: WSketch, base: WEntity[] = ws.entities): EqContext {
  const m = new Map<string, WEntity>();
  for (const e of base) m.set(e.id, e);
  return { values: ws.values, base: m, scale: sketchScale(base), tangentAt: tangentPoints(ws.constraints) };
}

/**
 * Normal of a curve at a point on it, using planegcs' convention (line:
 * direction rotated +90 degrees; circle/arc: from the point toward the center).
 */
export function curveNormal(e: WEntity, p: P2): P2 {
  if (e.kind === 'line') { const d = sub(e.b, e.a); return [-d[1], d[0]]; }
  if (e.kind === 'circle' || e.kind === 'arc') return sub(e.c, p);
  throw new Error(`${e.id} is not a curve`);
}

/**
 * A tangency between two curves that also share a point (an endpoint of one
 * coincident with an endpoint of the other, or an endpoint lying on the
 * other curve) is written as "normals parallel at that point". The plain
 * curve-tangency equation is singular there (its gradient vanishes when the
 * point is already on both curves), which would make the solver slow and the
 * degrees-of-freedom count wrong. This mirrors how FreeCAD treats endpoint
 * tangency.
 */
export function tangentPoints(constraints: SketchConstraint[]): Map<string, PointRef> {
  const parent = new Map<string, string>();
  const find = (k: string): string => { let r = k; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const key = (r: PointRef) => `${r.e}:${r.p}`;
  const pointOn: { p: PointRef; on: string }[] = [];
  for (const c of constraints) {
    if (c.type === 'coincident') union(key(c.a), key(c.b));
    if (c.type === 'pointOn') pointOn.push({ p: c.p, on: c.on });
  }
  const ends = (id: string): PointRef[] => [{ e: id, p: 'start' }, { e: id, p: 'end' }];
  const out = new Map<string, PointRef>();
  for (const c of constraints) {
    if (c.type !== 'tangent') continue;
    let found: PointRef | undefined;
    for (const ra of ends(c.a)) for (const rb of ends(c.b)) if (!found && find(key(ra)) === find(key(rb))) found = ra;
    if (!found) {
      const po = pointOn.find((q) => (q.on === c.b && q.p.e === c.a && q.p.p !== 'center') || (q.on === c.a && q.p.e === c.b && q.p.p !== 'center'));
      if (po) found = po.p;
    }
    if (found) out.set(c.id, found);
  }
  return out;
}

/** Largest residual over all driving constraints, and which constraint has it. */
export function maxResidual(ws: WSketch, ctx: EqContext): { max: number; worst?: string } {
  const byId = new Map<string, WEntity>(Object.values(BUILTIN).map((b) => [b.id, b]));
  for (const e of ws.entities) byId.set(e.id, e);
  const E: Getter = (id) => { const e = byId.get(id); if (!e) throw new Error(`Missing entity ${id}`); return e; };
  let max = 0; let worst: string | undefined;
  for (const c of ws.constraints) {
    for (const r of residuals(c, E, ctx)) {
      const a = Math.abs(r);
      if (!(a <= max)) { max = a; worst = c.id; } // NaN counts as worst
    }
  }
  return { max, worst };
}

// ------------------------------------------------------------------ parameters

/** Number of free parameters of an entity and how to read/write them. */
export function paramCount(e: WEntity): number {
  // Splines are not solver geometry: they keep their fit points (no free parameters).
  return e.kind === 'point' ? 2 : e.kind === 'line' ? 4 : e.kind === 'circle' ? 3 : e.kind === 'spline' ? 0 : 5;
}
export function getParams(e: WEntity): number[] {
  switch (e.kind) {
    case 'point': return [...e.p];
    case 'line': return [...e.a, ...e.b];
    case 'circle': return [...e.c, e.r];
    case 'arc': return [...e.c, e.r, e.a0, e.a1];
    case 'spline': return [];
  }
}
export function withParams(e: WEntity, x: number[]): WEntity {
  switch (e.kind) {
    case 'point': return { ...e, p: [x[0], x[1]] };
    case 'line': return { ...e, a: [x[0], x[1]], b: [x[2], x[3]] };
    case 'circle': return { ...e, c: [x[0], x[1]], r: x[2] };
    case 'arc': return { ...e, c: [x[0], x[1]], r: x[2], a0: x[3], a1: x[4] };
    case 'spline': return e;
  }
}
/** Angle parameters are scaled by the radius so every column is in mm. */
function paramScale(e: WEntity, i: number): number { return e.kind === 'arc' && i >= 3 ? Math.max(e.r, 1e-9) : 1; }

/** Geometric quantities that must all be determined for an entity to be fully defined. */
function quantities(e: WEntity): number[] {
  switch (e.kind) {
    case 'point': return [...e.p];
    case 'line': return [...e.a, ...e.b];
    case 'circle': return [...e.c, e.r];
    case 'arc': return [...e.c, e.r, ...polar(e.c, e.r, e.a0), ...polar(e.c, e.r, e.a1)];
    case 'spline': return [];
  }
}

export interface Analysis {
  /** Remaining degrees of freedom (free parameters minus independent equations). */
  dof: number;
  equations: number;
  rank: number;
  /** Entity ids whose position, size and extent are fully determined. */
  defined: Set<string>;
  /** refKey()s of points whose position is determined. */
  definedPoints: Set<string>;
}

/**
 * Rank / null-space analysis of the constraint Jacobian at the current
 * (solved) geometry. An entity is fully defined when every quantity that
 * describes it has zero component along every remaining free motion.
 */
export function analyze(ws: WSketch, ctx: EqContext = makeContext(ws)): Analysis {
  const ents = ws.entities;
  const offset = new Map<string, number>();
  let n = 0;
  for (const e of ents) { offset.set(e.id, n); n += paramCount(e); }
  const X = ents.flatMap(getParams);
  const colScale: number[] = [];
  for (const e of ents) for (let i = 0; i < paramCount(e); i++) colScale.push(paramScale(e, i));
  const byId = new Map<string, WEntity>(Object.values(BUILTIN).map((b) => [b.id, b]));
  ents.forEach((e) => byId.set(e.id, e));

  // Jacobian rows by central differences, touching only the entities each constraint uses.
  const rows: number[][] = [];
  const hBase = 1e-6;
  for (const c of ws.constraints) {
    const ids = [...new Set(constraintRefs(c))].filter((id) => offset.has(id));
    const E0: Getter = (id) => byId.get(id)!;
    const r0 = residuals(c, E0, ctx);
    if (!r0.length) continue;
    const local: number[][] = r0.map(() => new Array(n).fill(0));
    for (const id of ids) {
      const e = byId.get(id)!;
      const off = offset.get(id)!;
      const k = paramCount(e);
      for (let i = 0; i < k; i++) {
        const h = hBase * (paramScale(e, i) === 1 ? Math.max(1, ctx.scale) : 1);
        const xp = X.slice(off, off + k); xp[i] += h;
        const xm = X.slice(off, off + k); xm[i] -= h;
        const ep = withParams(e, xp), em = withParams(e, xm);
        const rp = residuals(c, (q) => (q === id ? ep : byId.get(q)!), ctx);
        const rm = residuals(c, (q) => (q === id ? em : byId.get(q)!), ctx);
        for (let j = 0; j < r0.length; j++) local[j][off + i] = ((rp[j] - rm[j]) / (2 * h)) * colScale[off + i];
      }
    }
    for (const row of local) {
      const m = Math.max(...row.map(Math.abs));
      rows.push(m > 0 ? row.map((x) => x / m) : row);
    }
  }

  // Gauss-Jordan with complete pivoting -> reduced row echelon form.
  const A = rows.map((r) => r.slice());
  const pivCols: number[] = [];
  const tol = 1e-8;
  let rank = 0;
  const colUsed = new Array(n).fill(false);
  for (let r = 0; r < A.length && rank < n; ) {
    let best = 0, bi = -1, bj = -1;
    for (let i = rank; i < A.length; i++) for (let j = 0; j < n; j++) {
      if (colUsed[j]) continue;
      const a = Math.abs(A[i][j]);
      if (a > best) { best = a; bi = i; bj = j; }
    }
    if (best < tol) break;
    [A[rank], A[bi]] = [A[bi], A[rank]];
    const piv = A[rank][bj];
    for (let j = 0; j < n; j++) A[rank][j] /= piv;
    for (let i = 0; i < A.length; i++) {
      if (i === rank) continue;
      const f = A[i][bj];
      if (f !== 0) for (let j = 0; j < n; j++) A[i][j] -= f * A[rank][j];
    }
    colUsed[bj] = true;
    pivCols.push(bj);
    rank++;
    r++;
  }
  const free = [...Array(n).keys()].filter((j) => !colUsed[j]);

  // A quantity q is determined iff grad(q) . v = 0 for every null-space vector v.
  // Null-space vector for free column f: v_f = 1, v_pivot(k) = -A[k][f] (columns scaled).
  const determined = (grad: Map<number, number>): boolean => {
    let gmax = 0;
    for (const g of grad.values()) gmax = Math.max(gmax, Math.abs(g));
    if (gmax === 0) return true;
    for (const f of free) {
      let s = (grad.get(f) ?? 0);
      for (let k = 0; k < pivCols.length; k++) { const g = grad.get(pivCols[k]); if (g) s -= g * A[k][f]; }
      if (Math.abs(s) > 1e-6 * gmax) return false;
    }
    return true;
  };
  const defined = new Set<string>();
  const definedPoints = new Set<string>();
  for (const e of ents) {
    const off = offset.get(e.id)!, k = paramCount(e);
    const x0 = X.slice(off, off + k);
    const q0 = quantities(e);
    const grads: Map<number, number>[] = q0.map(() => new Map());
    for (let i = 0; i < k; i++) {
      const h = 1e-6 * (paramScale(e, i) === 1 ? Math.max(1, ctx.scale) : 1);
      const xp = x0.slice(); xp[i] += h; const xm = x0.slice(); xm[i] -= h;
      const qp = quantities(withParams(e, xp)), qm = quantities(withParams(e, xm));
      q0.forEach((_, j) => grads[j].set(off + i, ((qp[j] - qm[j]) / (2 * h)) * colScale[off + i]));
    }
    const ok = grads.map(determined);
    if (ok.every(Boolean)) defined.add(e.id);
    // point determinacy for markers
    const pts = pointQuantityIndex(e);
    for (const [pos, idx] of pts) if (idx.every((j) => ok[j])) definedPoints.add(`${e.id}:${pos}`);
  }
  return { dof: n - rank, equations: rows.length, rank, defined, definedPoints };
}

function pointQuantityIndex(e: WEntity): [string, number[]][] {
  switch (e.kind) {
    case 'point': return [['point', [0, 1]]];
    case 'line': return [['start', [0, 1]], ['end', [2, 3]]];
    case 'circle': return [['center', [0, 1]]];
    case 'arc': return [['center', [0, 1]], ['start', [3, 4]], ['end', [5, 6]]];
    case 'spline': return [];
  }
}

