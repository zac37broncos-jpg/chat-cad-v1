/**
 * DXF export (AutoCAD R12 / AC1009 ASCII: the most widely readable DXF
 * flavour) at true scale: 1 drawing unit = 1 inch for ANSI sheets, 1 mm for
 * ISO sheets, paper drawn at 1:1. R12 has no units header variable, so the
 * unit is also written in a 999 comment and in the layer names' companion
 * note; importers should be set to inches (ANSI) or millimetres (ISO).
 *
 * Lines, circles and arcs are exact DXF entities. R12 has no ELLIPSE
 * entity, so elliptic arcs and splines become polylines with ≤ 0.001 mm
 * chordal error. Filled arrowheads are SOLID entities.
 */
import { sampleCurve, TAU, type Curve2 } from '../geom2d';
import type { Prim } from '../prims';
import { STANDARDS, type DraftStandard, type LineType } from '../standards';
import { textWidth } from '../text';
import { textBaseline } from './svg';

interface LayerDef { name: string; color: number; ltype: string }

/** Layers by line type. Colours follow common pen-table habits: thick lines white/black (7). */
const LAYER_OF: Record<LineType, LayerDef> = {
  visible: { name: 'VISIBLE', color: 7, ltype: 'CONTINUOUS' },
  tangent: { name: 'TANGENT', color: 8, ltype: 'CONTINUOUS' },
  hidden: { name: 'HIDDEN', color: 2, ltype: 'HIDDEN' },
  center: { name: 'CENTER', color: 4, ltype: 'CENTER' },
  phantom: { name: 'PHANTOM', color: 6, ltype: 'PHANTOM' },
  cutting: { name: 'CUTTING', color: 1, ltype: 'PHANTOM' },
  thin: { name: 'THIN', color: 3, ltype: 'CONTINUOUS' },
  hatch: { name: 'HATCH', color: 8, ltype: 'CONTINUOUS' },
  border: { name: 'BORDER', color: 7, ltype: 'CONTINUOUS' },
  frame: { name: 'FORMAT', color: 9, ltype: 'CONTINUOUS' },
};
const TEXT_LAYER: LayerDef = { name: 'TEXT', color: 7, ltype: 'CONTINUOUS' };
const FILL_LAYER: LayerDef = { name: 'THIN', color: 3, ltype: 'CONTINUOUS' };

const g = (code: number, v: string | number) => `${code}\n${v}\n`;
const fx = (v: number) => (Math.abs(v) < 1e-12 ? '0.0' : v.toFixed(6));

function dxfText(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === 'Ø') out += '%%c';
    else if (ch === '±') out += '%%p';
    else if (ch === '°') out += '%%d';
    else if (ch === '%') out += '%%%';
    else { const c = ch.codePointAt(0)!; out += c >= 32 && c < 127 ? ch : '?'; }
  }
  return out;
}

export function buildDxf(prims: Prim[], w: number, h: number, standard: DraftStandard): string {
  const units: 'in' | 'mm' = standard === 'ASME' ? 'in' : 'mm';
  const k = units === 'in' ? 1 / 25.4 : 1;
  const X = (v: number) => fx(v * k);
  const std = STANDARDS[standard];
  const ltDefs: [string, string, number[]][] = [
    ['CONTINUOUS', 'Solid line', []],
    ['HIDDEN', 'Hidden __ __ __', std.lines.hidden.dash ?? []],
    ['CENTER', 'Center ____ _ ____', std.lines.center.dash ?? []],
    ['PHANTOM', 'Phantom ____ _ _ ____', std.lines.phantom.dash ?? []],
  ];
  let s = '';
  s += g(999, `ChatCAD drawing, true scale 1:1 paper, units: ${units === 'in' ? 'inches' : 'millimeters'}`);
  s += g(0, 'SECTION') + g(2, 'HEADER');
  s += g(9, '$ACADVER') + g(1, 'AC1009');
  s += g(9, '$INSBASE') + g(10, '0.0') + g(20, '0.0') + g(30, '0.0');
  s += g(9, '$EXTMIN') + g(10, '0.0') + g(20, '0.0') + g(30, '0.0');
  s += g(9, '$EXTMAX') + g(10, X(w)) + g(20, X(h)) + g(30, '0.0');
  s += g(9, '$LIMMIN') + g(10, '0.0') + g(20, '0.0');
  s += g(9, '$LIMMAX') + g(10, X(w)) + g(20, X(h));
  s += g(9, '$LTSCALE') + g(40, '1.0');
  s += g(0, 'ENDSEC');
  // Tables: line types, layers, text style.
  s += g(0, 'SECTION') + g(2, 'TABLES');
  s += g(0, 'TABLE') + g(2, 'LTYPE') + g(70, ltDefs.length);
  for (const [name, desc, dash] of ltDefs) {
    s += g(0, 'LTYPE') + g(2, name) + g(70, 0) + g(3, desc) + g(72, 65) + g(73, dash.length);
    s += g(40, fx(dash.reduce((a, b) => a + b, 0) * k));
    dash.forEach((d, i) => { s += g(49, fx((i % 2 === 0 ? d : -d) * k)); });
  }
  s += g(0, 'ENDTAB');
  const layers = new Map<string, LayerDef>();
  for (const L of [...Object.values(LAYER_OF), TEXT_LAYER]) layers.set(L.name, L);
  s += g(0, 'TABLE') + g(2, 'LAYER') + g(70, layers.size + 1);
  s += g(0, 'LAYER') + g(2, '0') + g(70, 0) + g(62, 7) + g(6, 'CONTINUOUS');
  for (const L of layers.values()) s += g(0, 'LAYER') + g(2, L.name) + g(70, 0) + g(62, L.color) + g(6, L.ltype);
  s += g(0, 'ENDTAB');
  s += g(0, 'TABLE') + g(2, 'STYLE') + g(70, 1);
  s += g(0, 'STYLE') + g(2, 'STANDARD') + g(70, 0) + g(40, '0.0') + g(41, '1.0') + g(50, '0.0') + g(71, 0) + g(42, '2.5') + g(3, 'txt') + g(4, '');
  s += g(0, 'ENDTAB');
  s += g(0, 'ENDSEC');
  // Entities.
  s += g(0, 'SECTION') + g(2, 'ENTITIES');
  const curve = (cv: Curve2, L: LayerDef) => {
    if (cv.k === 'line') { s += g(0, 'LINE') + g(8, L.name) + g(10, X(cv.a[0])) + g(20, X(cv.a[1])) + g(30, '0.0') + g(11, X(cv.b[0])) + g(21, X(cv.b[1])) + g(31, '0.0'); return; }
    if (cv.k === 'arc') {
      if (cv.a1 - cv.a0 >= TAU - 1e-9) { s += g(0, 'CIRCLE') + g(8, L.name) + g(10, X(cv.c[0])) + g(20, X(cv.c[1])) + g(30, '0.0') + g(40, X(cv.r)); return; }
      const deg = (a: number) => fx(((a * 180) / Math.PI % 360 + 360) % 360);
      s += g(0, 'ARC') + g(8, L.name) + g(10, X(cv.c[0])) + g(20, X(cv.c[1])) + g(30, '0.0') + g(40, X(cv.r)) + g(50, deg(cv.a0)) + g(51, deg(cv.a1));
      return;
    }
    const pts = sampleCurve(cv, 0.001);
    s += g(0, 'POLYLINE') + g(8, L.name) + g(66, 1) + g(10, '0.0') + g(20, '0.0') + g(30, '0.0') + g(70, 0);
    for (const p of pts) s += g(0, 'VERTEX') + g(8, L.name) + g(10, X(p[0])) + g(20, X(p[1])) + g(30, '0.0');
    s += g(0, 'SEQEND') + g(8, L.name);
  };
  for (const p of prims) {
    if (p.t === 'curve') curve(p.cv, LAYER_OF[p.lt]);
    else if (p.t === 'fill') {
      const q = p.pts.length >= 4 ? [p.pts[0], p.pts[1], p.pts[3], p.pts[2]] : [p.pts[0], p.pts[1], p.pts[2], p.pts[2]];
      s += g(0, 'SOLID') + g(8, FILL_LAYER.name);
      q.forEach((v, i) => { s += g(10 + i, X(v[0])) + g(20 + i, X(v[1])) + g(30 + i, '0.0'); });
    } else if (p.t === 'fillCircle') {
      // Filled disc: closed 2-vertex polyline with bulge 1 and width = r (how CAD "donuts" are stored).
      s += g(0, 'POLYLINE') + g(8, FILL_LAYER.name) + g(66, 1) + g(10, '0.0') + g(20, '0.0') + g(30, '0.0') + g(70, 1) + g(40, X(p.r)) + g(41, X(p.r));
      for (const sx of [-1, 1]) s += g(0, 'VERTEX') + g(8, FILL_LAYER.name) + g(10, X(p.c[0] + (sx * p.r) / 2)) + g(20, X(p.c[1])) + g(30, '0.0') + g(42, '1.0');
      s += g(0, 'SEQEND') + g(8, FILL_LAYER.name);
    } else {
      const b = textBaseline(p);
      const tw = textWidth(p.s, p.h);
      const r = p.rot ?? 0;
      const dx = p.ax === 'l' ? 0 : p.ax === 'c' ? -tw / 2 : -tw;
      // Left-aligned baseline insertion point (most portable); width matches our font metrics.
      const x = b[0] + dx * Math.cos(r), y = b[1] + dx * Math.sin(r);
      s += g(0, 'TEXT') + g(8, TEXT_LAYER.name) + g(10, X(x)) + g(20, X(y)) + g(30, '0.0') + g(40, X(p.h)) + g(1, dxfText(p.s));
      if (r) s += g(50, fx((r * 180) / Math.PI));
      s += g(7, 'STANDARD');
    }
  }
  s += g(0, 'ENDSEC') + g(0, 'EOF');
  return s;
}
