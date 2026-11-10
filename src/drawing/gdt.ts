/**
 * Geometric tolerancing graphics: feature control frames and datum feature
 * symbols per ASME Y14.5-2018 (and ISO 1101 for the ISO standard).
 *
 * Symbols are drawn as vector geometry (not font glyphs) so they look the
 * same on screen, in PDF and in DXF. Frame height = 2 × letter height.
 *
 * ASME Y14.5-2018 removed concentricity and symmetry; they remain available
 * only for the ISO standard (ISO 1101 keeps them).
 */
import { add, mul, norm, perp, sub, type V2 } from './geom2d';
import type { FcfRow, GdtSymbol } from './model';
import { PrimList, type Layer } from './prims';
import { textWidth } from './text';
import type { DraftStandard } from './standards';

export const GDT_SYMBOLS: { id: GdtSymbol; label: string; group: string; iso?: boolean; datums: boolean }[] = [
  { id: 'straightness', label: 'Straightness', group: 'Form', datums: false },
  { id: 'flatness', label: 'Flatness', group: 'Form', datums: false },
  { id: 'circularity', label: 'Circularity', group: 'Form', datums: false },
  { id: 'cylindricity', label: 'Cylindricity', group: 'Form', datums: false },
  { id: 'profileLine', label: 'Profile of a line', group: 'Profile', datums: true },
  { id: 'profileSurface', label: 'Profile of a surface', group: 'Profile', datums: true },
  { id: 'angularity', label: 'Angularity', group: 'Orientation', datums: true },
  { id: 'perpendicularity', label: 'Perpendicularity', group: 'Orientation', datums: true },
  { id: 'parallelism', label: 'Parallelism', group: 'Orientation', datums: true },
  { id: 'position', label: 'Position', group: 'Location', datums: true },
  { id: 'concentricity', label: 'Concentricity (ISO only)', group: 'Location', iso: true, datums: true },
  { id: 'symmetry', label: 'Symmetry (ISO only)', group: 'Location', iso: true, datums: true },
  { id: 'circularRunout', label: 'Circular runout', group: 'Runout', datums: true },
  { id: 'totalRunout', label: 'Total runout', group: 'Runout', datums: true },
];

export const symbolsFor = (std: DraftStandard) => GDT_SYMBOLS.filter((s) => std === 'ISO' || !s.iso);

const L: Layer = 'dims';

/** Draw a characteristic symbol centred at c; H = frame height. */
export function drawSymbol(pl: PrimList, sym: GdtSymbol, c: V2, H: number) {
  const s = 0.3 * H;
  const P = (x: number, y: number): V2 => [c[0] + x * s, c[1] + y * s];
  const ln = (x0: number, y0: number, x1: number, y1: number) => pl.line(P(x0, y0), P(x1, y1), 'thin', L);
  const circ = (x: number, y: number, r: number) => pl.circle(P(x, y), r * s, 'thin', L);
  switch (sym) {
    case 'straightness': ln(-1, 0, 1, 0); break;
    case 'flatness': ln(-1, -0.45, 0.55, -0.45); ln(0.55, -0.45, 1, 0.45); ln(1, 0.45, -0.55, 0.45); ln(-0.55, 0.45, -1, -0.45); break;
    case 'circularity': circ(0, 0, 0.8); break;
    case 'cylindricity': {
      circ(0, 0, 0.6);
      const d: V2 = [0.5, Math.sqrt(3) / 2];
      const n = perp(d);
      for (const sg of [1, -1]) {
        const o = mul(n, 0.6 * sg);
        ln(o[0] - d[0] * 1.05, o[1] - d[1] * 1.05, o[0] + d[0] * 1.05, o[1] + d[1] * 1.05);
      }
      break;
    }
    case 'profileLine': pl.curve({ k: 'arc', c: P(0, -0.4), r: 0.85 * s, a0: 0, a1: Math.PI }, 'thin', L); break;
    case 'profileSurface': pl.curve({ k: 'arc', c: P(0, -0.4), r: 0.85 * s, a0: 0, a1: Math.PI }, 'thin', L); ln(-0.85, -0.4, 0.85, -0.4); break;
    case 'angularity': ln(-1, -0.6, 1, -0.6); ln(-1, -0.6, -1 + 2 * Math.cos(Math.PI / 6), -0.6 + 2 * Math.sin(Math.PI / 6)); break;
    case 'perpendicularity': ln(-0.9, -0.7, 0.9, -0.7); ln(0, -0.7, 0, 0.9); break;
    case 'parallelism': ln(-0.85, -0.75, -0.05, 0.75); ln(0.05, -0.75, 0.85, 0.75); break;
    case 'position': circ(0, 0, 0.6); ln(-1, 0, 1, 0); ln(0, -1, 0, 1); break;
    case 'concentricity': circ(0, 0, 0.42); circ(0, 0, 0.85); break;
    case 'symmetry': ln(-1, 0, 1, 0); ln(-0.6, 0.45, 0.6, 0.45); ln(-0.6, -0.45, 0.6, -0.45); break;
    case 'circularRunout': {
      const a = P(-0.55, -0.8), b = P(0.55, 0.8);
      pl.line(a, b, 'thin', L);
      pl.arrow(b, sub(b, a), 0.55 * s, 0.4 * s, L);
      break;
    }
    case 'totalRunout': {
      ln(-0.95, -0.8, 0.45, -0.8);
      for (const x of [-0.95, 0.05]) { const a = P(x, -0.8), b = P(x + 0.7, 0.75); pl.line(a, b, 'thin', L); pl.arrow(b, sub(b, a), 0.5 * s, 0.38 * s, L); }
      break;
    }
  }
}

/** Letter in a circle (material condition and other modifiers). */
function circledLetter(pl: PrimList, letter: string, c: V2, h: number) {
  pl.circle(c, h * 0.62, 'thin', L);
  pl.text(c, h * 0.72, letter, 'c', 'm', L);
}

const modWidth = (h: number) => h * 1.45;

/** Width of the tolerance compartment contents. */
function tolCellWidth(row: FcfRow, h: number): number {
  let w = textWidth((row.dia ? 'Ø' : '') + row.tol, h);
  if (row.mod) w += modWidth(h);
  if (row.extra) w += row.extra === 'ST' ? textWidth(' ST', h) : modWidth(h);
  return w;
}

/**
 * Feature control frame. `at` is the frame's top-left corner. Returns the
 * frame's box and its left/right mid points for leaders.
 */
export function drawFcf(pl: PrimList, rows: FcfRow[], at: V2, h: number): { min: V2; max: V2 } {
  const H = 2 * h, pad = h * 0.5;
  // Common column widths across rows so stacked frames line up.
  const cols: number[] = [H, 0, 0, 0, 0];
  for (const r of rows) {
    cols[1] = Math.max(cols[1], tolCellWidth(r, h) + 2 * pad);
    r.datums.forEach((d, i) => { cols[2 + i] = Math.max(cols[2 + i], Math.max(H, textWidth(d.letter, h) + (d.mod ? modWidth(h) : 0) + 2 * pad)); });
  }
  let maxRight = at[0];
  rows.forEach((r, ri) => {
    const y1 = at[1] - ri * H, y0 = y1 - H, cy = (y0 + y1) / 2;
    let x = at[0];
    const widths = [cols[0], cols[1], ...r.datums.map((_, i) => cols[2 + i])];
    const x0 = x;
    for (let i = 0; i < widths.length; i++) {
      const w = widths[i];
      if (i === 0) drawSymbol(pl, r.sym, [x + w / 2, cy], H);
      else if (i === 1) {
        let tx = x + pad;
        const t = (r.dia ? 'Ø' : '') + r.tol;
        pl.text([tx, cy], h, t, 'l', 'm', L);
        tx += textWidth(t, h);
        if (r.mod) { circledLetter(pl, r.mod, [tx + modWidth(h) / 2, cy], h); tx += modWidth(h); }
        if (r.extra === 'ST') pl.text([tx, cy], h, ' ST', 'l', 'm', L);
        else if (r.extra) circledLetter(pl, r.extra, [tx + modWidth(h) / 2, cy], h);
      } else {
        const d = r.datums[i - 2];
        const tw = textWidth(d.letter, h) + (d.mod ? modWidth(h) : 0);
        const tx = x + (w - tw) / 2;
        pl.text([tx, cy], h, d.letter, 'l', 'm', L);
        if (d.mod) circledLetter(pl, d.mod, [tx + textWidth(d.letter, h) + modWidth(h) / 2, cy], h);
      }
      if (i > 0) pl.line([x, y0], [x, y1], 'thin', L);
      x += w;
    }
    pl.rect(x0, y0, x, y1, 'thin', L);
    maxRight = Math.max(maxRight, x);
  });
  return { min: [at[0], at[1] - rows.length * H], max: [maxRight, at[1]] };
}

/**
 * Datum feature symbol (ASME Y14.5-2018 §3.3.2): the letter in a square
 * frame joined by a leader to a filled datum triangle on the feature.
 * `at` is the centre of the square, `attach` the triangle base point.
 */
export function drawDatum(pl: PrimList, letter: string, at: V2, attach: V2, h: number): { min: V2; max: V2 } {
  const H = 2 * h;
  pl.rect(at[0] - H / 2, at[1] - H / 2, at[0] + H / 2, at[1] + H / 2, 'thin', L);
  pl.text(at, h, letter, 'c', 'm', L);
  const d = norm(sub(at, attach));
  const tri = H * 0.5;
  const n = mul(perp(d), tri * 0.577);
  const apex = add(attach, mul(d, tri));
  pl.push({ t: 'fill', pts: [add(attach, n), sub(attach, n), apex], layer: L });
  // Leader from triangle apex to the nearest edge of the frame.
  const ex = Math.abs(d[0]) > Math.abs(d[1]) ? [at[0] - Math.sign(d[0]) * H / 2, at[1]] as V2 : [at[0], at[1] - Math.sign(d[1]) * H / 2] as V2;
  pl.line(apex, ex, 'thin', L);
  return { min: [at[0] - H / 2, at[1] - H / 2], max: [at[0] + H / 2, at[1] + H / 2] };
}
