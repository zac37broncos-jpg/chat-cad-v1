/**
 * Dimension and leader graphics in paper space (mm), following ASME Y14.5
 * (unidirectional text, dimension line broken for the text) or ISO 129-1
 * (aligned text above an unbroken dimension line).
 */
import { add, cross, dist, dot, len, mul, norm, normAngle, perp, sub, TAU, type V2 } from './geom2d';
import type { DimText } from './format';
import { PrimList } from './prims';
import type { StandardSpec } from './standards';
import { textWidth } from './text';

const L = 'dims' as const;

export interface DimStyle { std: StandardSpec; h: number }

/** Width of a dimension text block. */
export function dimTextWidth(t: DimText, h: number): number {
  const sh = h * 0.85;
  let w = t.limitsOnly ? textWidth(t.main, h) : textWidth(t.main, h);
  if (t.stack) w += (t.limitsOnly ? 0 : h * 0.4) + Math.max(textWidth(t.stack[0], sh), textWidth(t.stack[1], sh));
  if (t.after) w += textWidth(t.after, h);
  return w;
}

export function dimTextHeight(t: DimText, h: number): number { return t.stack ? h * 0.85 * 2 + h * 0.5 : h; }

/** Draw dimension text centred at c; rot rotates the whole block (radians, ISO aligned text). */
export function drawDimText(pl: PrimList, t: DimText, c: V2, h: number, rot = 0) {
  const w = dimTextWidth(t, h);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const P = (x: number, y: number): V2 => [c[0] + x * cr - y * sr, c[1] + x * sr + y * cr];
  let x = -w / 2;
  const sh = h * 0.85;
  if (t.main) { pl.text(P(x, 0), h, t.main, 'l', 'm', L, rot); x += textWidth(t.main, h); }
  if (t.stack) {
    if (!t.limitsOnly) x += h * 0.4;
    const sw = Math.max(textWidth(t.stack[0], sh), textWidth(t.stack[1], sh));
    const off = sh / 2 + h * 0.25;
    // Limits: upper limit on top; stacked tolerances: plus on top. Left-aligned per ASME figures.
    pl.text(P(x, off), sh, t.stack[0], 'l', 'm', L, rot);
    pl.text(P(x, -off), sh, t.stack[1], 'l', 'm', L, rot);
    x += sw;
  }
  if (t.after) { pl.text(P(x, 0), h, t.after, 'l', 'm', L, rot); }
  if (t.boxed) {
    const m = h * 0.35, hh = dimTextHeight(t, h) / 2 + m;
    const corners = [P(-w / 2 - m, -hh), P(w / 2 + m, -hh), P(w / 2 + m, hh), P(-w / 2 - m, hh)];
    for (let i = 0; i < 4; i++) pl.line(corners[i], corners[(i + 1) % 4], 'thin', L);
  }
}

/** Readable rotation for aligned (ISO) text along direction u: within (-90°, 90°]. */
function readableAngle(u: V2): number {
  let a = Math.atan2(u[1], u[0]);
  if (a > Math.PI / 2 + 1e-9) a -= Math.PI;
  if (a <= -Math.PI / 2 + 1e-9) a += Math.PI;
  return a;
}

/**
 * Linear dimension between paper points p1, p2 measured along `u`
 * (horizontal, vertical or aligned). T = text centre (also fixes the
 * dimension line position).
 */
export function drawLinearDim(pl: PrimList, p1: V2, p2: V2, T: V2, u: V2, text: DimText, st: DimStyle) {
  const { std, h } = st;
  const ud = norm(u);
  const n = perp(ud);
  const off1 = dot(sub(T, p1), n), off2 = dot(sub(T, p2), n);
  const D1 = add(p1, mul(n, off1)), D2 = add(p2, mul(n, off2));
  // Extension lines with the standard visible gap and overshoot.
  for (const [p, D, off] of [[p1, D1, off1], [p2, D2, off2]] as [V2, V2, number][]) {
    const s = Math.sign(off) || 1;
    if (Math.abs(off) > std.ext.gap) pl.line(add(p, mul(n, s * std.ext.gap)), add(D, mul(n, s * std.ext.overshoot)), 'thin', L);
  }
  const dl = dist(D1, D2);
  if (dl < 1e-9) return;
  const ax = norm(sub(D2, D1));
  const tpos = dot(sub(T, D1), ax); // text position along the dimension line
  const aligned = std.textMode === 'aligned';
  const tw = dimTextWidth(text, h), th = dimTextHeight(text, h);
  const pad = h * 0.4;
  // Extent of the text along the dimension line (horizontal text across a sloped line).
  const along = aligned ? tw : Math.abs(tw * ax[0]) + Math.abs(th * ax[1]);
  const textInside = tpos > 0 && tpos < dl;
  const arrowsInside = dl >= 2 * std.arrow.length + (aligned ? 1 : along + 2 * pad) + 1;
  const A = std.arrow;
  if (arrowsInside) {
    pl.arrow(D1, mul(ax, -1), A.length, A.width, L);
    pl.arrow(D2, ax, A.length, A.width, L);
    if (aligned || !textInside) {
      const lo = Math.min(0, tpos - along / 2 - pad), hi = Math.max(dl, tpos + along / 2 + pad);
      pl.line(add(D1, mul(ax, textInside ? 0 : Math.min(0, lo))), add(D1, mul(ax, textInside ? dl : Math.max(dl, hi))), 'thin', L);
    } else {
      const g0 = tpos - along / 2 - pad, g1 = tpos + along / 2 + pad;
      if (g0 > 0) pl.line(D1, add(D1, mul(ax, g0)), 'thin', L);
      if (g1 < dl) pl.line(add(D1, mul(ax, g1)), D2, 'thin', L);
    }
  } else {
    // Arrows outside, pointing inward, with short dimension line stubs.
    const stub = A.length + 2 * h;
    pl.arrow(D1, ax, A.length, A.width, L);
    pl.arrow(D2, mul(ax, -1), A.length, A.width, L);
    let lo = -stub, hi = dl + stub;
    if (tpos < 0) lo = Math.min(lo, tpos + (aligned ? -tw / 2 : along / 2 + pad));
    if (tpos > dl) hi = Math.max(hi, tpos - (aligned ? -tw / 2 : along / 2 + pad));
    pl.line(add(D1, mul(ax, lo)), D1, 'thin', L);
    pl.line(D2, add(D1, mul(ax, hi)), 'thin', L);
    if (aligned) pl.line(D1, D2, 'thin', L);
  }
  const mid = add(D1, mul(ax, tpos));
  if (aligned) {
    const rot = readableAngle(ax);
    const up: V2 = [-Math.sin(rot), Math.cos(rot)];
    drawDimText(pl, text, add(mid, mul(up, th / 2 + h * 0.3)), h, rot);
  } else drawDimText(pl, text, mid, h);
}

/**
 * Diameter / radius dimension with a leader (ASME: leader points at the
 * centre, arrow touches the circle, horizontal shoulder to the text).
 * `full` = diameter (text prefix Ø, already in `text`).
 */
export function drawRadialDim(pl: PrimList, c: V2, r: number, T: V2, text: DimText, st: DimStyle) {
  const { std, h } = st;
  const tw = dimTextWidth(text, h);
  const A = std.arrow;
  const inside = dist(T, c) < r;
  if (inside) {
    // Text inside a large circle: dimension line through the text toward the circle.
    const d = norm(sub(T, c));
    const tip = add(c, mul(d, r));
    pl.line(c, tip, 'thin', L);
    pl.arrow(tip, d, A.length, A.width, L);
    drawDimText(pl, text, T, h);
    return;
  }
  const sgn = T[0] >= c[0] ? 1 : -1;
  const shoulder = Math.max(0.25 * 25.4 * (std.id === 'ASME' ? 1 : 0.6), h * 2);
  const E: V2 = [T[0] - sgn * (tw / 2 + h * 0.4), T[1]];
  const S: V2 = [E[0] - sgn * shoulder, E[1]];
  const d = norm(sub(S, c));
  const tip = add(c, mul(d, r));
  pl.line(S, E, 'thin', L);
  pl.line(tip, S, 'thin', L);
  pl.arrow(tip, mul(d, -1), A.length, A.width, L);
  drawDimText(pl, text, T, h);
}

/** Leader with arrow from text/frame point `from` to `to`, with optional horizontal shoulder. */
export function drawLeader(pl: PrimList, from: V2, to: V2, st: DimStyle, terminator: 'arrow' | 'dot' = 'arrow') {
  pl.line(from, to, 'thin', L);
  const d = sub(to, from);
  if (len(d) < 1e-9) return;
  if (terminator === 'arrow') pl.arrow(to, d, st.std.arrow.length, st.std.arrow.width, L);
  else pl.dot(to, st.std.arrow.width * 0.75, L);
}

function lineIntersect(a1: V2, d1: V2, a2: V2, d2: V2): V2 | null {
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(a2, a1), d2) / den;
  return add(a1, mul(d1, t));
}

/**
 * Angular dimension between two paper segments; the arc passes through T.
 * Returns the measured angle (radians) or null for parallel lines.
 */
export function angleBetween(l1: [V2, V2], l2: [V2, V2], T: V2): { O: V2; a0: number; a1: number } | null {
  const d1 = norm(sub(l1[1], l1[0])), d2 = norm(sub(l2[1], l2[0]));
  const O = lineIntersect(l1[0], d1, l2[0], d2);
  if (!O) return null;
  const tA = Math.atan2(T[1] - O[1], T[0] - O[0]);
  const rays1 = [Math.atan2(d1[1], d1[0]), Math.atan2(-d1[1], -d1[0])];
  const rays2 = [Math.atan2(d2[1], d2[0]), Math.atan2(-d2[1], -d2[0])];
  let best: { a0: number; a1: number } | null = null;
  for (const r1 of rays1) for (const r2 of rays2) {
    for (const [s, e] of [[r1, r2], [r2, r1]]) {
      const sweep = normAngle(e - s);
      if (sweep <= 0 || sweep >= Math.PI) continue;
      if (normAngle(tA - s) <= sweep && (!best || sweep < best.a1 - best.a0)) best = { a0: s, a1: s + sweep };
    }
  }
  return best ? { O, ...best } : null;
}

export function drawAngleDim(pl: PrimList, l1: [V2, V2], l2: [V2, V2], T: V2, text: DimText, st: DimStyle): number | null {
  const g = angleBetween(l1, l2, T);
  if (!g) return null;
  const { O, a0, a1 } = g;
  const R = dist(T, O);
  const A = st.std.arrow;
  pl.curve({ k: 'arc', c: O, r: R, a0, a1 }, 'thin', L);
  const e0: V2 = [O[0] + R * Math.cos(a0), O[1] + R * Math.sin(a0)];
  const e1: V2 = [O[0] + R * Math.cos(a1), O[1] + R * Math.sin(a1)];
  pl.arrow(e0, [Math.sin(a0), -Math.cos(a0)], A.length, A.width, L);
  pl.arrow(e1, [-Math.sin(a1), Math.cos(a1)], A.length, A.width, L);
  // Extension lines where the arc lies beyond the selected segments.
  for (const [seg, a, e] of [[l1, a0, e0], [l2, a1, e1]] as [[V2, V2], number, V2][]) {
    const dir: V2 = [Math.cos(a), Math.sin(a)];
    const far = Math.max(dot(sub(seg[0], O), dir), dot(sub(seg[1], O), dir));
    if (R > far + st.std.ext.gap) pl.line(add(O, mul(dir, far + st.std.ext.gap)), add(e, mul(dir, st.std.ext.overshoot)), 'thin', L);
  }
  const mid = (a0 + a1) / 2;
  const tp: V2 = [O[0] + (R + st.h) * Math.cos(mid), O[1] + (R + st.h) * Math.sin(mid)];
  drawDimText(pl, text, dist(T, O) > 0 ? tp : T, st.h);
  return a1 - a0;
}

export { TAU };
