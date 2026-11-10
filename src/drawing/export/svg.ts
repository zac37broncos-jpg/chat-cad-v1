/**
 * SVG rendering of paper primitives. Used both on screen and for SVG
 * export. The document is sized in millimetres (width="279.4mm" with a
 * matching viewBox), so it prints and imports at true scale.
 */
import { arcPoint, ellipsePoint, TAU, type Curve2, type V2 } from '../geom2d';
import type { Prim } from '../prims';
import { STANDARDS, type DraftStandard, type LineStyle } from '../standards';
import { CAP_HEIGHT, textWidth } from '../text';

export interface SvgOptions {
  standard: DraftStandard;
  /** Override colour (e.g. selection highlight). */
  color?: string;
  warnColor?: string;
  /** Extra stroke width added on screen for picking/highlight. */
  widthBoost?: number;
}

const f = (n: number) => (Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(4)).toString());

function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function curvePath(cv: Curve2, H: number): string {
  const P = (p: V2) => `${f(p[0])} ${f(H - p[1])}`;
  switch (cv.k) {
    case 'line': return `M${P(cv.a)}L${P(cv.b)}`;
    case 'poly': return 'M' + cv.pts.map(P).join('L');
    case 'arc': {
      const sweep = cv.a1 - cv.a0;
      if (sweep >= TAU - 1e-9) {
        const a = arcPoint(cv.c, cv.r, 0), b = arcPoint(cv.c, cv.r, Math.PI);
        return `M${P(a)}A${f(cv.r)} ${f(cv.r)} 0 1 0 ${P(b)}A${f(cv.r)} ${f(cv.r)} 0 1 0 ${P(a)}`;
      }
      const a = arcPoint(cv.c, cv.r, cv.a0), b = arcPoint(cv.c, cv.r, cv.a1);
      return `M${P(a)}A${f(cv.r)} ${f(cv.r)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${P(b)}`;
    }
    case 'ellipse': {
      const rotDeg = (-cv.rot * 180) / Math.PI;
      const sweep = cv.t1 - cv.t0;
      if (sweep >= TAU - 1e-9) {
        const a = ellipsePoint(cv, 0), b = ellipsePoint(cv, Math.PI);
        return `M${P(a)}A${f(cv.rx)} ${f(cv.ry)} ${f(rotDeg)} 1 0 ${P(b)}A${f(cv.rx)} ${f(cv.ry)} ${f(rotDeg)} 1 0 ${P(a)}`;
      }
      const a = ellipsePoint(cv, cv.t0), b = ellipsePoint(cv, cv.t1);
      return `M${P(a)}A${f(cv.rx)} ${f(cv.ry)} ${f(rotDeg)} ${sweep > Math.PI ? 1 : 0} 0 ${P(b)}`;
    }
  }
}

function strokeAttrs(ls: LineStyle, color: string, boost = 0): string {
  const dash = ls.dash ? ` stroke-dasharray="${ls.dash.map(f).join(' ')}"` : '';
  return `fill="none" stroke="${color}" stroke-width="${f(ls.width + boost)}" stroke-linecap="${ls.dash ? 'butt' : 'round'}" stroke-linejoin="round"${dash}`;
}

/** Baseline anchor of a text primitive (handles vertical alignment and rotation). */
export function textBaseline(p: Extract<Prim, { t: 'text' }>): V2 {
  const off = p.ay === 'b' ? 0 : p.ay === 'm' ? -p.h / 2 : -p.h;
  const r = p.rot ?? 0;
  return [p.p[0] - off * Math.sin(r), p.p[1] + off * Math.cos(r)];
}

/** Inner SVG markup (no <svg> wrapper) for primitives on a sheet of height H (mm). */
export function primsToSvg(prims: Prim[], H: number, opt: SvgOptions): string {
  const std = STANDARDS[opt.standard];
  const out: string[] = [];
  // Group curves with identical style into one <path> for speed.
  const groups = new Map<string, string[]>();
  for (const p of prims) {
    const color = opt.color ?? (p.warn && opt.warnColor ? opt.warnColor : '#000');
    if (p.t === 'curve') {
      const key = `${p.lt}|${color}`;
      const g = groups.get(key) ?? [];
      g.push(curvePath(p.cv, H));
      groups.set(key, g);
    } else if (p.t === 'fill') {
      out.push(`<polygon points="${p.pts.map((q) => `${f(q[0])},${f(H - q[1])}`).join(' ')}" fill="${color}" stroke="none"/>`);
    } else if (p.t === 'fillCircle') {
      out.push(`<circle cx="${f(p.c[0])}" cy="${f(H - p.c[1])}" r="${f(p.r)}" fill="${color}"/>`);
    } else {
      const b = textBaseline(p);
      const anchor = p.ax === 'l' ? 'start' : p.ax === 'c' ? 'middle' : 'end';
      const rot = p.rot ? ` transform="rotate(${f((-p.rot * 180) / Math.PI)} ${f(b[0])} ${f(H - b[1])})"` : '';
      // textLength pins the advance width to our Helvetica metrics so layout matches PDF exactly.
      const tl = textWidth(p.s, p.h);
      out.push(`<text x="${f(b[0])}" y="${f(H - b[1])}" font-family="Helvetica, Arial, sans-serif" font-size="${f(p.h / CAP_HEIGHT)}"${p.bold ? ' font-weight="bold"' : ''} text-anchor="${anchor}" textLength="${f(tl)}" lengthAdjust="spacingAndGlyphs" fill="${color}"${rot}>${esc(p.s)}</text>`);
    }
  }
  const curveMarkup: string[] = [];
  for (const [key, paths] of groups) {
    const [lt, color] = key.split('|');
    curveMarkup.push(`<path d="${paths.join('')}" ${strokeAttrs(std.lines[lt as keyof typeof std.lines], color, opt.widthBoost)}/>`);
  }
  return curveMarkup.join('') + out.join('');
}

/** Complete, standalone SVG document at true scale. */
export function sheetSvg(prims: Prim[], w: number, h: number, standard: DraftStandard, title = 'ChatCAD drawing'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">
<title>${esc(title)}</title>
<rect x="0" y="0" width="${f(w)}" height="${f(h)}" fill="#fff"/>
${primsToSvg(prims, h, { standard })}
</svg>
`;
}
