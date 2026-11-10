/**
 * Paper-space primitives: the single output of drawing composition. The
 * screen, SVG, PDF and DXF all render this same list, so what you see is
 * exactly what is exported. Units: mm, origin lower-left, y up.
 */
import { add, mul, norm, perp, sub, type Curve2, type V2 } from './geom2d';
import type { LineType } from './standards';
import { textWidth } from './text';

export type Layer = 'geometry' | 'hidden' | 'center' | 'dims' | 'notes' | 'hatch' | 'format' | 'title';

export type Prim =
  | { t: 'curve'; cv: Curve2; lt: LineType; layer: Layer; owner?: string; warn?: boolean }
  | { t: 'text'; p: V2; h: number; s: string; ax: 'l' | 'c' | 'r'; ay: 'b' | 'm' | 't'; rot?: number; layer: Layer; owner?: string; bold?: boolean; warn?: boolean }
  | { t: 'fill'; pts: V2[]; layer: Layer; owner?: string; warn?: boolean }
  | { t: 'fillCircle'; c: V2; r: number; layer: Layer; owner?: string; warn?: boolean };

export class PrimList {
  items: Prim[] = [];
  /** Mark everything added as a warning (e.g. a dimension whose geometry no longer exists). */
  warn = false;
  constructor(public owner?: string) {}
  private add(p: Prim) { if (this.warn) (p as any).warn = true; this.items.push(p); }
  line(a: V2, b: V2, lt: LineType, layer: Layer) { this.add({ t: 'curve', cv: { k: 'line', a, b }, lt, layer, owner: this.owner }); }
  curve(cv: Curve2, lt: LineType, layer: Layer) { this.add({ t: 'curve', cv, lt, layer, owner: this.owner }); }
  circle(c: V2, r: number, lt: LineType, layer: Layer) { this.curve({ k: 'arc', c, r, a0: 0, a1: Math.PI * 2 }, lt, layer); }
  rect(x0: number, y0: number, x1: number, y1: number, lt: LineType, layer: Layer) {
    this.line([x0, y0], [x1, y0], lt, layer); this.line([x1, y0], [x1, y1], lt, layer);
    this.line([x1, y1], [x0, y1], lt, layer); this.line([x0, y1], [x0, y0], lt, layer);
  }
  text(p: V2, h: number, s: string, ax: 'l' | 'c' | 'r', ay: 'b' | 'm' | 't', layer: Layer, rot = 0, bold = false) {
    if (s) this.add({ t: 'text', p, h, s, ax, ay, rot: rot || undefined, layer, owner: this.owner, bold: bold || undefined });
  }
  /** Filled arrowhead with its tip at `tip`, pointing along `dir`. */
  arrow(tip: V2, dir: V2, length: number, width: number, layer: Layer) {
    const d = norm(dir);
    const base = sub(tip, mul(d, length));
    const n = mul(perp(d), width / 2);
    this.add({ t: 'fill', pts: [tip, add(base, n), sub(base, n)], layer, owner: this.owner });
  }
  dot(c: V2, r: number, layer: Layer) { this.add({ t: 'fillCircle', c, r, layer, owner: this.owner }); }
  push(...p: Prim[]) { for (const x of p) this.add(this.owner && !x.owner ? { ...x, owner: this.owner } : { ...x }); }
}

/** Axis-aligned box of a text primitive (unrotated). */
export function textBox(p: Extract<Prim, { t: 'text' }>): { min: V2; max: V2 } {
  const w = textWidth(p.s, p.h);
  const x0 = p.ax === 'l' ? p.p[0] : p.ax === 'c' ? p.p[0] - w / 2 : p.p[0] - w;
  const y0 = p.ay === 'b' ? p.p[1] : p.ay === 'm' ? p.p[1] - p.h / 2 : p.p[1] - p.h;
  return { min: [x0, y0], max: [x0 + w, y0 + p.h] };
}
