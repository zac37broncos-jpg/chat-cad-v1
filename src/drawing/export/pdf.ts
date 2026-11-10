/**
 * Vector PDF writer (PDF 1.4), one page per sheet, true scale: the page
 * MediaBox is the sheet size and 1 mm on the drawing is 1 mm on paper when
 * printed at 100 % ("Actual size").
 *
 * Circular and elliptic arcs become cubic Béziers of at most 45° each
 * (radial error ≤ 4.2e-6 × radius, e.g. 0.0004 mm on a 100 mm radius);
 * everything else is exact. Text uses the PDF base-14 Helvetica font with
 * WinAnsi encoding (covers Ø, ±, °).
 */
import { TAU, type Curve2, type V2 } from '../geom2d';
import type { Prim } from '../prims';
import { STANDARDS, type DraftStandard } from '../standards';
import { CAP_HEIGHT, textWidth } from '../text';
import { textBaseline } from './svg';

const PT_PER_MM = 72 / 25.4;
const n = (v: number) => (Math.abs(v) < 1e-9 ? '0' : Number(v.toFixed(4)).toString());

/** Bézier control points for a unit-circle arc from a0 to a1 (|a1 - a0| ≤ π/2). */
function unitArc(a0: number, a1: number): [V2, V2, V2, V2] {
  const k = (4 / 3) * Math.tan((a1 - a0) / 4);
  const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
  return [[c0, s0], [c0 - k * s0, s0 + k * c0], [c1 + k * s1, s1 - k * c1], [c1, s1]];
}

function conicPath(c: V2, rx: number, ry: number, rot: number, t0: number, t1: number): string {
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const M = (p: V2): V2 => [c[0] + rx * p[0] * cr - ry * p[1] * sr, c[1] + rx * p[0] * sr + ry * p[1] * cr];
  const segs = Math.max(1, Math.ceil((t1 - t0) / (Math.PI / 4) - 1e-9));
  let s = '';
  for (let i = 0; i < segs; i++) {
    const a = t0 + ((t1 - t0) * i) / segs, b = t0 + ((t1 - t0) * (i + 1)) / segs;
    const [p0, p1, p2, p3] = unitArc(a, b).map(M);
    if (i === 0) s += `${n(p0[0])} ${n(p0[1])} m `;
    s += `${n(p1[0])} ${n(p1[1])} ${n(p2[0])} ${n(p2[1])} ${n(p3[0])} ${n(p3[1])} c `;
  }
  return s;
}

function curveOps(cv: Curve2): string {
  switch (cv.k) {
    case 'line': return `${n(cv.a[0])} ${n(cv.a[1])} m ${n(cv.b[0])} ${n(cv.b[1])} l `;
    case 'poly': return cv.pts.map((p, i) => `${n(p[0])} ${n(p[1])} ${i ? 'l' : 'm'} `).join('');
    case 'arc': return conicPath(cv.c, cv.r, cv.r, 0, cv.a0, Math.min(cv.a1, cv.a0 + TAU));
    case 'ellipse': return conicPath(cv.c, cv.rx, cv.ry, cv.rot, cv.t0, Math.min(cv.t1, cv.t0 + TAU));
  }
}

/** WinAnsi-encode a string as a PDF literal. */
function pdfString(s: string): string {
  let out = '(';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const map: Record<string, number> = { 'Ø': 0xd8, '±': 0xb1, '°': 0xb0, '×': 0xd7, 'µ': 0xb5, '²': 0xb2, '³': 0xb3, '·': 0xb7, '–': 0x96, '—': 0x97 };
    let b = map[ch] ?? (code < 128 ? code : 0x3f);
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

export interface PdfPage { w: number; h: number; prims: Prim[]; standard: DraftStandard }

function pageContent(pg: PdfPage): string {
  const std = STANDARDS[pg.standard];
  const ops: string[] = [`${n(PT_PER_MM)} 0 0 ${n(PT_PER_MM)} 0 0 cm`, '1 J 1 j 0 G 0 g'];
  // Group curves by line style.
  const byLt = new Map<string, Curve2[]>();
  for (const p of pg.prims) if (p.t === 'curve') byLt.set(p.lt, [...(byLt.get(p.lt) ?? []), p.cv]);
  for (const [lt, cvs] of byLt) {
    const ls = std.lines[lt as keyof typeof std.lines];
    ops.push(`${n(ls.width)} w ${ls.dash ? '0 J' : '1 J'} [${(ls.dash ?? []).map(n).join(' ')}] 0 d`);
    // Each curve is stroked separately so dash patterns restart per curve (as on screen/SVG).
    for (const cv of cvs) ops.push(curveOps(cv) + 'S');
  }
  ops.push('[] 0 d');
  for (const p of pg.prims) {
    if (p.t === 'fill') ops.push(p.pts.map((q, i) => `${n(q[0])} ${n(q[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h f');
    else if (p.t === 'fillCircle') ops.push(conicPath(p.c, p.r, p.r, 0, 0, TAU) + 'h f');
  }
  for (const p of pg.prims) {
    if (p.t !== 'text') continue;
    const size = p.h / CAP_HEIGHT;
    const w = textWidth(p.s, p.h);
    const dx = p.ax === 'l' ? 0 : p.ax === 'c' ? -w / 2 : -w;
    const r = p.rot ?? 0, cr = Math.cos(r), sr = Math.sin(r);
    const b = textBaseline(p);
    const x = b[0] + dx * cr, y = b[1] + dx * sr;
    ops.push(`BT /${p.bold ? 'F2' : 'F1'} ${n(size)} Tf ${n(cr)} ${n(sr)} ${n(-sr)} ${n(cr)} ${n(x)} ${n(y)} Tm ${pdfString(p.s)} Tj ET`);
  }
  return ops.join('\n');
}

/** Build a multi-page PDF. Returns the file bytes. */
export function buildPdf(pages: PdfPage[], title = 'ChatCAD drawing'): Uint8Array {
  const objs: string[] = [];
  // 1 catalog, 2 pages, 3 font, 4 bold font, 5 info, then (page, content) pairs.
  const pageIds: number[] = [];
  const contents: string[] = pages.map(pageContent);
  const base = 6;
  pages.forEach((_, i) => pageIds.push(base + i * 2));
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  objs[5] = `<< /Title ${pdfString(title)} /Creator (ChatCAD) /Producer (ChatCAD drawing export) >>`;
  pages.forEach((pg, i) => {
    const pid = pageIds[i], cid = pid + 1;
    objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pg.w * PT_PER_MM)} ${n(pg.h * PT_PER_MM)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`;
    objs[cid] = `<< /Length ${contents[i].length} >>\nstream\n${contents[i]}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is < 256 (content is ASCII; the header comment uses 4 high bytes): one byte per char.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
