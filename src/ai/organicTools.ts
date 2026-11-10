/**
 * Shorthand tools for organic shapes. They do not create anything special:
 * each one expands into ordinary, named, editable features (one sketch per
 * cross-section plus one smooth loft), exactly what a user would make by hand.
 * They exist so Claude can describe a whole smooth body or limb in a few
 * hundred tokens instead of thousands, which is what makes whole-model
 * builds fast.
 */
import type { ExecutorContext } from './executor';
import type { SketchEntity, ValueExpr, BasePlane } from '../core/model';
import { newId } from '../core/model';
import { MM_PER } from '../core/units';
import * as F from '../core/featureCommands';
import TOOLS from './organicTools.json';

export const ORGANIC_TOOL_DEFS = TOOLS as { name: string; description: string; inputSchema: Record<string, unknown> }[];
export const ORGANIC_TOOL_NAMES = new Set(ORGANIC_TOOL_DEFS.map((t) => t.name));

type Args = Record<string, any>;
type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a); if (!(l > 1e-12)) throw new Error('tube: two path points are at the same place'); return mul(a, 1 / l); };

function checkFreeNames(ctx: ExecutorContext, names: string[]) {
  const taken = new Set(ctx.store.state.features.map((f) => f.name.trim().toLowerCase()));
  for (const n of names) if (taken.has(n.trim().toLowerCase())) throw new Error(`A feature named "${n}" already exists; pick another name`);
}

export async function executeOrganicTool(
  ctx: ExecutorContext, name: string, a: Args,
  toEntities: (list: Args[]) => SketchEntity[],
  finish: (featureId?: string, extra?: Args) => Promise<unknown>,
): Promise<unknown> {
  if (name === 'loft_sections') return loftSections(ctx, a, toEntities, finish);
  if (name === 'tube') return tube(ctx, a, finish);
  if (name === 'profile_body') return profileBody(ctx, a, toEntities, finish);
  throw new Error(`Unknown tool ${name}`);
}

async function loftSections(ctx: ExecutorContext, a: Args, toEntities: (list: Args[]) => SketchEntity[], finish: (id?: string, extra?: Args) => Promise<unknown>) {
  const { store } = ctx;
  const name = String(a.name ?? '').trim();
  if (!name) throw new Error('loft_sections: name is required');
  const plane: BasePlane = a.plane ?? 'XY';
  if (!['XY', 'XZ', 'YZ'].includes(plane)) throw new Error('loft_sections: plane must be XY, XZ or YZ');
  const given: Args[] = a.sections;
  if (!Array.isArray(given) || !given.length) throw new Error('loft_sections: sections is required');
  const tips = (a.start_point ? 1 : 0) + (a.end_point ? 1 : 0);
  if (given.length + tips < 2) throw new Error('loft_sections: give at least two sections, or one section and a start/end point');
  // Round ends: two dome sections (at 30 and 60 degrees of an elliptical dome) between the end section and its tip,
  // so the end is a true dome instead of the whole body bulging to reach the tip smoothly.
  const startRings = a.start_point && (a.start_tip ?? 'round') === 'round' && a.dome_rings !== false ? domeRings(plane, given[0], a.start_point) : [];
  const endRings = a.end_point && (a.end_tip ?? 'round') === 'round' && a.dome_rings !== false ? domeRings(plane, given[given.length - 1], a.end_point) : [];
  const sections = [...[...startRings].reverse(), ...given, ...endRings];
  const names = [
    ...startRings.map((_, i) => `${name} Start Dome ${startRings.length - i}`),
    ...given.map((_, i) => `${name} Section ${i + 1}`),
    ...endRings.map((_, i) => `${name} End Dome ${i + 1}`),
  ];
  checkFreeNames(ctx, [name, ...names]);
  const v3 = (p: unknown, what: string) => {
    if (!Array.isArray(p) || p.length !== 3) throw new Error(`loft_sections: ${what} must be [x, y, z]`);
    return { x: p[0] as ValueExpr, y: p[1] as ValueExpr, z: p[2] as ValueExpr };
  };
  const ids = store.transaction(`Add ${name}`, () => {
    const sk = sections.map((s, i) => {
      const where = `section ${i + 1}`;
      if (s.offset === undefined || s.offset === '') throw new Error(`loft_sections: ${where} needs an offset`);
      let ent: Args;
      if (s.oval) ent = { type: 'oval', ...s.oval };
      else if (Array.isArray(s.points)) ent = { type: 'spline', closed: true, uniform: true, points: s.points };
      else throw new Error(`loft_sections: ${where} needs an oval or points`);
      return store.addSketch(plane, toEntities([ent]), { name: names[i], offset: s.offset });
    });
    const loft = F.addLoft(store, {
      profiles: sk, name, ...(a.operation ? { operation: a.operation } : {}),
      ...(a.start_point ? { startPoint: v3(a.start_point, 'start_point') } : {}),
      ...(a.end_point ? { endPoint: v3(a.end_point, 'end_point') } : {}),
      startTip: a.start_tip ?? 'round', endTip: a.end_tip ?? 'round',
    });
    return { sk, loft };
  });
  return finish(ids.loft, { feature_id: ids.loft, name, sketches: names });
}

/** a + (b - a) * h for numbers or expressions. */
function lerpE(a: ValueExpr, b: ValueExpr, h: number): ValueExpr {
  if (typeof a === 'number' && typeof b === 'number') return +(a + (b - a) * h).toFixed(9);
  return `(${a})*${+(1 - h).toFixed(9)} + (${b})*${+h.toFixed(9)}`;
}
function scaleE(a: ValueExpr, k: number): ValueExpr {
  return typeof a === 'number' ? +(a * k).toFixed(9) : `(${a})*${+k.toFixed(9)}`;
}

/**
 * The dome sections between an end section and its tip point: smaller copies
 * of the section at 30 and 60 degrees round an ellipse whose top is the tip.
 * Empty when the section cannot be scaled (points with expressions).
 */
function domeRings(plane: BasePlane, s: Args, tip: unknown): Args[] {
  if (!Array.isArray(tip) || tip.length !== 3) return [];
  const [x, y, z] = tip as ValueExpr[];
  const local: [ValueExpr, ValueExpr, ValueExpr] = plane === 'XY' ? [x, y, z] : plane === 'XZ' ? [x, z, typeof y === 'number' ? -y : `-(${y})`] : [y, z, x];
  const [tu, tv, toff] = local;
  const rings: Args[] = [];
  for (const [h, k] of [[0.5, Math.cos(Math.PI / 6)], [Math.sin(Math.PI / 3), 0.5]]) {
    const offset = lerpE(s.offset, toff, h);
    if (s.oval) {
      const o = s.oval;
      rings.push({ offset, oval: { ...o, cx: lerpE(o.cx ?? 0, tu, h), cy: lerpE(o.cy ?? 0, tv, h), rx: scaleE(o.rx, k), ry: scaleE(o.ry, k) } });
    } else if (Array.isArray(s.points) && s.points.every((p: unknown[]) => typeof p?.[0] === 'number' && typeof p?.[1] === 'number') && typeof tu === 'number' && typeof tv === 'number') {
      const pts = s.points as [number, number][];
      const c = [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
      const cu = c[0] + (tu - c[0]) * h, cv = c[1] + (tv - c[1]) * h;
      rings.push({ offset, points: pts.map((p) => [+(cu + (p[0] - c[0]) * k).toFixed(9), +(cv + (p[1] - c[1]) * k).toFixed(9)]) });
    } else return [];
  }
  return rings;
}

type EndKind = 'round' | 'flat' | 'point';

async function tube(ctx: ExecutorContext, a: Args, finish: (id?: string, extra?: Args) => Promise<unknown>) {
  const { store } = ctx;
  const name = String(a.name ?? '').trim();
  if (!name) throw new Error('tube: name is required');
  const path: V3[] = a.path;
  if (!Array.isArray(path) || path.length < 2 || path.some((p) => !Array.isArray(p) || p.length !== 3 || p.some((c) => typeof c !== 'number' || !Number.isFinite(c)))) {
    throw new Error('tube: path must be at least two [x, y, z] points (numbers in document units)');
  }
  const n = path.length;
  let radii: number[];
  if (Array.isArray(a.radii)) {
    if (a.radii.length !== n) throw new Error(`tube: radii needs one value per path point (${n})`);
    radii = a.radii.map(Number);
  } else radii = new Array(n).fill(Number(a.radius));
  if (radii.some((r) => !(r > 0))) throw new Error('tube: give radius (or radii) greater than zero');
  const k = MM_PER[store.state.units];
  const P = path.map((p) => mul(p as V3, k)); // mm
  // Tangents: central differences (one-sided at the ends).
  const T = P.map((_, i) => unit(sub(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)])));
  // Rotation-minimizing frames so the circles' seams do not twist the loft.
  const pick = (t: V3): V3 => { const ax: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; ax.sort((u, v) => Math.abs(dot(u, t)) - Math.abs(dot(v, t))); return unit(sub(ax[0], mul(t, dot(ax[0], t)))); };
  const X: V3[] = [pick(T[0])];
  for (let i = 1; i < n; i++) {
    const prev = X[i - 1];
    let x = sub(prev, mul(T[i], dot(prev, T[i])));
    if (len(x) < 1e-9) x = pick(T[i]);
    X.push(unit(x));
  }
  const kindAt = (which: 'start' | 'finish'): EndKind => (which === 'start' ? a.start_end : a.finish_end) ?? a.ends ?? 'round';
  const startKind = kindAt('start'), endKind = kindAt('finish');
  const sectionNames = P.map((_, i) => `${name} Section ${i + 1}`);
  const startDome = startKind === 'round' ? [`${name} Start Dome 2`, `${name} Start Dome 1`] : [];
  const endDome = endKind === 'round' ? [`${name} End Dome 1`, `${name} End Dome 2`] : [];
  const capNames = [...startDome, ...endDome];
  checkFreeNames(ctx, [name, ...sectionNames, ...capNames]);
  const toDoc = (mm: V3) => mm.map((v) => +(v / k).toFixed(9)) as V3;
  const circleSketch = (nm: string, o: V3, x: V3, t: V3, rDoc: number, label: string) => store.addSketch('face', [
    { id: newId('ci'), kind: 'circle', center: { x: 0, y: 0 }, radius: +rDoc.toFixed(9) },
  ], { name: nm, frame: { origin: o, xDir: x, normal: t }, faceLabel: label });

  const ids = store.transaction(`Add ${name}`, () => {
    const profiles: string[] = [];
    // Domed cap: sections at 30 and 60 degrees round the end sphere, then the pole as the loft's (round) end point.
    const cap = (i: number, dir: -1 | 1, nm: string, deg: number) => {
      const r = radii[i] * k, a = (deg * Math.PI) / 180;
      const o = add(P[i], mul(T[i], dir * r * Math.sin(a)));
      return circleSketch(nm, o, X[i], T[i], radii[i] * Math.cos(a), `${name} end`);
    };
    if (startKind === 'round') { profiles.push(cap(0, -1, startDome[0], 60)); profiles.push(cap(0, -1, startDome[1], 30)); }
    P.forEach((p, i) => profiles.push(circleSketch(sectionNames[i], p, X[i], T[i], radii[i], `${name} path point ${i + 1}`)));
    if (endKind === 'round') { profiles.push(cap(n - 1, 1, endDome[0], 30)); profiles.push(cap(n - 1, 1, endDome[1], 60)); }
    const tipAt = (i: number, dir: -1 | 1, kind: EndKind) => {
      const reach = kind === 'round' ? 1 : 1.6;
      const q = toDoc(add(P[i], mul(T[i], dir * radii[i] * k * reach)));
      return { x: q[0], y: q[1], z: q[2] };
    };
    const loft = F.addLoft(store, {
      profiles, name, ...(a.operation ? { operation: a.operation } : {}),
      ...(startKind !== 'flat' ? { startPoint: tipAt(0, -1, startKind) } : {}),
      ...(endKind !== 'flat' ? { endPoint: tipAt(n - 1, 1, endKind) } : {}),
      startTip: startKind === 'round' ? 'round' : 'point', endTip: endKind === 'round' ? 'round' : 'point',
    });
    return { loft, count: profiles.length };
  });
  return finish(ids.loft, { feature_id: ids.loft, name, sketches: [...startDome, ...sectionNames, ...endDome] });
}

// ---------------------------------------------------------------- profile_body

/**
 * Monotone cubic (Fritsch-Carlson / PCHIP) interpolation through (xs, ys):
 * smooth, and never overshoots between keys, so a silhouette does not bulge
 * past the sizes it was given. Constant beyond the first/last key.
 */
export function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const d = h.map((hi, i) => (ys[i + 1] - ys[i]) / hi);
  const m = new Array(n).fill(0);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  if (n > 2) {
    // Shape-preserving end slopes.
    const end = (m0: number, d0: number, d1: number) => (Math.sign(m0) !== Math.sign(d0) ? 0 : Math.sign(d0) !== Math.sign(d1) && Math.abs(m0) > Math.abs(3 * d0) ? 3 * d0 : m0);
    m[0] = end(((2 * h[0] + h[1]) * d[0] - h[0] * d[1]) / (h[0] + h[1]), d[0], d[1]);
    m[n - 1] = end(((2 * h[n - 2] + h[n - 3]) * d[n - 2] - h[n - 2] * d[n - 3]) / (h[n - 2] + h[n - 3]), d[n - 2], d[n - 3]);
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

type Axis = 'X' | 'Y' | 'Z';
/** For each axis: the sketch plane, how a station maps to the plane offset, and which world axes are the section's u and v. */
const AXES: Record<Axis, { plane: BasePlane; offset: (at: number) => number; u: 'x' | 'y' | 'z'; v: 'x' | 'y' | 'z' }> = {
  Z: { plane: 'XY', offset: (at) => at, u: 'x', v: 'y' },
  Y: { plane: 'XZ', offset: (at) => -at, u: 'x', v: 'z' },
  X: { plane: 'YZ', offset: (at) => at, u: 'y', v: 'z' },
};

/** Superellipse points, 24 of them, starting at +u and going counter-clockwise; the half with v below the center may use its own squareness. */
function sectionPoints(cu: number, cv: number, ru: number, rv: number, s: number, sLow: number): [number, number][] {
  const N = 24;
  const out: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    const c = Math.cos(t), sn = Math.sin(t);
    const e = sn < 0 ? sLow : s;
    out.push([+(cu + ru * Math.sign(c) * Math.abs(c) ** (2 / e)).toFixed(6), +(cv + rv * Math.sign(sn) * Math.abs(sn) ** (2 / e)).toFixed(6)]);
  }
  return out;
}

async function profileBody(ctx: ExecutorContext, a: Args, toEntities: (list: Args[]) => SketchEntity[], finish: (id?: string, extra?: Args) => Promise<unknown>) {
  const where = 'profile_body';
  const name = String(a.name ?? '').trim();
  if (!name) throw new Error(`${where}: name is required`);
  const axis: Axis = (a.axis ?? 'Z').toUpperCase();
  const ax = AXES[axis];
  if (!ax) throw new Error(`${where}: axis must be X, Y or Z`);
  const stations: Args[] = a.stations;
  if (!Array.isArray(stations) || stations.length < 2) throw new Error(`${where}: give at least two stations`);
  const num = (v: unknown, what: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${where}: ${what} must be a number`); return n; };
  const st: Args[] = stations.map((s, i) => ({ ...s, at: num(s.at, `stations[${i}].at`) })).sort((p, q) => p.at - q.at);
  for (let i = 1; i < st.length; i++) if (st[i].at - st[i - 1].at < 1e-6) throw new Error(`${where}: two stations at ${st[i].at}`);
  // Keys per quantity: lo/hi of the u extent, lo/hi of the v extent, squareness, low-side squareness.
  const keys = (pick: (s: Args) => number | undefined, what: string, fallback?: number) => {
    const xs: number[] = [], ys: number[] = [];
    for (const s of st) { const v = pick(s); if (v !== undefined) { xs.push(s.at); ys.push(v); } }
    if (!xs.length) {
      if (fallback === undefined) throw new Error(`${where}: no station gives ${what}`);
      return () => fallback;
    }
    return pchip(xs, ys);
  };
  const extent = (s: Args, k: 'x' | 'y' | 'z', side: 0 | 1) => {
    const v = s[k];
    if (v === undefined) return undefined;
    if (typeof v === 'number' || typeof v === 'string') { const h = num(v, `${k} at ${s.at}`); if (!(h > 0)) throw new Error(`${where}: half-size ${k} at ${s.at} must be > 0`); return side ? h : -h; }
    if (Array.isArray(v) && v.length === 2) { const lo = num(v[0], `${k}[0] at ${s.at}`), hi = num(v[1], `${k}[1] at ${s.at}`); if (!(hi > lo)) throw new Error(`${where}: ${k} at ${s.at} must be [min, max] with max > min`); return side ? hi : lo; }
    throw new Error(`${where}: ${k} at ${s.at} must be a half-size or [min, max]`);
  };
  const uLo = keys((s) => extent(s, ax.u, 0), `${ax.u} (the section's ${ax.u} extent)`);
  const uHi = keys((s) => extent(s, ax.u, 1), ax.u);
  const vLo = keys((s) => extent(s, ax.v, 0), `${ax.v} (the section's ${ax.v} extent)`);
  const vHi = keys((s) => extent(s, ax.v, 1), ax.v);
  const sqOf = (v: unknown) => { if (v === undefined) return undefined; const n = num(v, 'squareness'); if (!(n >= 1.5 && n <= 12)) throw new Error(`${where}: squareness must be between 1.5 and 12`); return n; };
  const sq = keys((s) => sqOf(s.squareness), 'squareness', sqOf(a.squareness) ?? 2.5);
  const lowKey = ax.v === 'y' ? 'front_squareness' : 'bottom_squareness';
  const hasLow = st.some((s) => s[lowKey] !== undefined) || a[lowKey] !== undefined;
  const sqLow = hasLow ? keys((s) => sqOf(s[lowKey]), lowKey, sqOf(a[lowKey]) ?? undefined) : sq;

  // Section positions: every station, plus evenly spaced in-betweens so no gap exceeds span / detail.
  const a0 = st[0].at, a1 = st[st.length - 1].at, span = a1 - a0;
  const detail = Math.min(40, Math.max(4, Math.round(Number(a.detail ?? 14))));
  const gapMax = span / detail;
  const at: number[] = [a0];
  for (let i = 1; i < st.length; i++) {
    const g = st[i].at - st[i - 1].at, k = Math.max(1, Math.ceil(g / gapMax - 1e-9));
    for (let j = 1; j <= k; j++) at.push(st[i - 1].at + (g * j) / k);
  }
  const shape = (t: number) => {
    const lo = uLo(t), hi = uHi(t), vl = vLo(t), vh = vHi(t);
    if (!(hi - lo > 1e-6) || !(vh - vl > 1e-6)) throw new Error(`${where}: the section at ${+t.toFixed(4)} has no size (check its extents)`);
    return { cu: (lo + hi) / 2, cv: (vl + vh) / 2, ru: (hi - lo) / 2, rv: (vh - vl) / 2, s: sq(t), sl: sqLow(t) };
  };
  const sections: Args[] = at.map((t) => { const p = shape(t); return { offset: +ax.offset(t).toFixed(9), points: sectionPoints(p.cu, p.cv, p.ru, p.rv, p.s, p.sl) }; });

  // Ends: flat, round (a dome: sections at 30 and 60 degrees, then the pole) or point.
  const world = (t: number, u: number, v: number): V3 => {
    const w: Record<'x' | 'y' | 'z', number> = { x: 0, y: 0, z: 0 };
    w[axis.toLowerCase() as 'x' | 'y' | 'z'] = t; w[ax.u] = u; w[ax.v] = v;
    return [+w.x.toFixed(9), +w.y.toFixed(9), +w.z.toFixed(9)];
  };
  let startPoint: V3 | undefined, endPoint: V3 | undefined;
  const capSections = (t: number, dir: -1 | 1, kind: string, domeArg: unknown) => {
    const p = shape(t);
    const d = domeArg !== undefined ? num(domeArg, 'dome') : (kind === 'point' ? 1 : 0.6) * Math.min(p.ru, p.rv);
    if (!(d > 0)) throw new Error(`${where}: dome height must be > 0`);
    const extra: Args[] = kind === 'round'
      ? [[0.5, 0.866], [0.866, 0.5]].map(([h, k]) => ({ offset: +ax.offset(t + dir * h * d).toFixed(9), points: sectionPoints(p.cu, p.cv, p.ru * k, p.rv * k, p.s, p.sl) }))
      : [];
    return { extra, tip: world(t + dir * d, p.cu, p.cv) };
  };
  const startKind = a.start ?? 'flat', endKind = a.end ?? 'flat';
  for (const k of [startKind, endKind]) if (!['flat', 'round', 'point'].includes(k)) throw new Error(`${where}: start/end must be flat, round or point`);
  if (startKind !== 'flat') { const c = capSections(a0, -1, startKind, a.start_dome); sections.unshift(...c.extra.reverse()); startPoint = c.tip; }
  if (endKind !== 'flat') { const c = capSections(a1, 1, endKind, a.end_dome); sections.push(...c.extra); endPoint = c.tip; }
  return loftSections(ctx, {
    name, plane: ax.plane, sections,
    dome_rings: false, // profile_body adds its own dome sections
    ...(startPoint ? { start_point: startPoint, start_tip: startKind === 'round' ? 'round' : 'point' } : {}),
    ...(endPoint ? { end_point: endPoint, end_tip: endKind === 'round' ? 'round' : 'point' } : {}),
    ...(a.operation ? { operation: a.operation } : {}),
  }, toEntities, finish);
}
