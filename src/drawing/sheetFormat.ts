/**
 * Sheet formats: border, zones / grid reference, title block, tolerance
 * block, projection symbol and revision table. Laid out from the block
 * lists in ASME Y14.1-2012 §6 (blocks A–L) and ISO 7200 (data fields), with
 * our own geometry (no template is copied from any CAD product).
 */
import type { V2 } from './geom2d';
import type { DrawingDocument, DrawingSheet, TitleBlock } from './model';
import { PrimList } from './prims';
import { sheetSize, sizeDesignation, STANDARDS, type SheetSize } from './standards';
import { textWidth } from './text';

const IN = 25.4;

export interface FieldBox { field: keyof TitleBlock; label: string; min: V2; max: V2 }

export interface SheetFormatResult {
  prims: PrimList;
  /** The drawable area inside the border, excluding the title block. */
  drawArea: { min: V2; max: V2 };
  /** Title block region (for placing the BOM above it). */
  titleBox: { min: V2; max: V2 };
  /** Editable title block cells, for click-to-edit in the UI. */
  fields: FieldBox[];
}

export interface FormatContext {
  doc: DrawingDocument;
  sheet: DrawingSheet;
  sheetIndex: number;
  sheetCount: number;
  scaleText: string;
  weightText: string;
}

/** Third/first angle projection symbol (truncated cone), ISO 5456-2 / ASME Y14.3 arrangement. `c` = centre, D = large diameter. */
export function drawProjectionSymbol(pl: PrimList, c: V2, D: number, angle: 'third' | 'first') {
  const r1 = D / 2, r2 = D / 4, len = D * 1.05, gap = D * 0.45;
  const total = D + gap + len;
  const x0 = c[0] - total / 2;
  // Circles (end view) and trapezoid (side view of the cone, small end toward the circles in third angle).
  const circX = angle === 'third' ? x0 + r1 : x0 + len + gap + r1;
  const trapX0 = angle === 'third' ? x0 + D + gap : x0;
  pl.circle([circX, c[1]], r1, 'visible', 'title');
  pl.circle([circX, c[1]], r2, 'visible', 'title');
  // Third angle: small end of the cone faces the circles (left). First angle: small end on the left too, circles on the right.
  const small = r2, big = r1;
  const xa = trapX0, xb = trapX0 + len;
  pl.line([xa, c[1] - small], [xb, c[1] - big], 'visible', 'title');
  pl.line([xb, c[1] - big], [xb, c[1] + big], 'visible', 'title');
  pl.line([xb, c[1] + big], [xa, c[1] + small], 'visible', 'title');
  pl.line([xa, c[1] + small], [xa, c[1] - small], 'visible', 'title');
  // Centerlines.
  pl.line([x0 - D * 0.15, c[1]], [x0 + total + D * 0.15, c[1]], 'thin', 'title');
  pl.line([circX, c[1] - r1 - D * 0.15], [circX, c[1] + r1 + D * 0.15], 'thin', 'title');
}

/** A labelled cell: small label top-left, value centred (or left) below. */
function cell(pl: PrimList, fields: FieldBox[], x0: number, y0: number, x1: number, y1: number, label: string, value: string, lh: number, vh: number, field?: keyof TitleBlock, align: 'l' | 'c' = 'l') {
  pl.rect(x0, y0, x1, y1, 'frame', 'title');
  const pad = Math.min(1.2, (y1 - y0) * 0.12);
  if (label) pl.text([x0 + pad, y1 - pad], lh, label, 'l', 't', 'title');
  if (value) {
    // Shrink the value to fit the cell width (never below 60 % of nominal height).
    // Cells too short to stack label over value (e.g. SCALE / WEIGHT / SHEET)
    // carry the value on the same line, to the right of the label.
    const inline = !!label && y1 - y0 < lh + vh + 4 * pad;
    const vx0 = inline ? x0 + pad + textWidth(label, lh) + 2 * pad : x0 + pad;
    const avail = x1 - vx0 - pad;
    let h = inline ? Math.min(vh, y1 - y0 - 2 * pad) : vh;
    const w = textWidth(value, h);
    if (w > avail) h = Math.max(h * 0.6, (h * avail) / w);
    const yv = inline || !label ? (y0 + y1) / 2 : (y0 + (y1 - lh - pad)) / 2;
    const ax = inline ? 'l' : align;
    pl.text(ax === 'c' ? [(vx0 + x1 - pad) / 2, yv] : [inline ? vx0 : x0 + pad * 2, yv], h, value, ax, 'm', 'title');
  }
  if (field) fields.push({ field, label: label || field, min: [x0, y0], max: [x1, y1] });
}

function asmeFormat(ctx: FormatContext, sz: SheetSize): SheetFormatResult {
  const pl = new PrimList('format');
  const std = STANDARDS.ASME;
  const fields: FieldBox[] = [];
  const tb = ctx.doc.titleBlock;
  const m = 0.5 * IN;
  const bx0 = m, by0 = m, bx1 = sz.w - m, by1 = sz.h - m;
  pl.rect(bx0, by0, bx1, by1, 'border', 'format');
  // Zones (ASME Y14.1 Table 4-1): equal zones from the sheet edge; numbers right→left, letters bottom→top.
  const [nx, ny] = sz.zones ?? [2, 2];
  const zw = sz.w / nx, zh = sz.h / ny;
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const zt = std.text.zone;
  for (let i = 1; i < nx; i++) {
    const x = i * zw;
    pl.line([x, 0.25 * IN], [x, by0], 'frame', 'format');
    pl.line([x, by1], [x, sz.h - 0.25 * IN], 'frame', 'format');
  }
  for (let j = 1; j < ny; j++) {
    const y = j * zh;
    pl.line([0.25 * IN, y], [bx0, y], 'frame', 'format');
    pl.line([bx1, y], [sz.w - 0.25 * IN, y], 'frame', 'format');
  }
  for (let i = 0; i < nx; i++) {
    const label = String(nx - i);
    const x = (i + 0.5) * zw;
    pl.text([x, m / 2], zt, label, 'c', 'm', 'format');
    pl.text([x, sz.h - m / 2], zt, label, 'c', 'm', 'format');
  }
  for (let j = 0; j < ny; j++) {
    const label = letters[j];
    const y = (j + 0.5) * zh;
    pl.text([m / 2, y], zt, label, 'c', 'm', 'format');
    pl.text([sz.w - m / 2, y], zt, label, 'c', 'm', 'format');
  }

  // Title block (lower right). Widths in inches: tolerance block 2.25 | approvals 2.625 | title block 4.0. Height 1.875.
  const lh = std.text.tbLabel, vh = std.text.tbValue;
  const H = 1.875 * IN;
  const wT = 4.0 * IN, wA = 2.625 * IN, wTol = 2.25 * IN;
  const x3 = bx1, x2 = x3 - wT, x1 = x2 - wA;
  const y0 = by0, yTop = by0 + H;
  // Narrow sheets (A portrait): the tolerance block sits above the approvals instead of to their left.
  const stacked = x1 - wTol < bx0;
  const tx0 = stacked ? x2 - wTol : x1 - wTol, tx1 = stacked ? x2 : x1;
  const ty0 = stacked ? yTop : y0, tyTop = stacked ? yTop + H : yTop;
  const x0 = Math.min(tx0, x1);
  // -- Title block proper (blocks A, B, C, D, H, I, J, K, L).
  const rA = 0.625 * IN, rB = 0.625 * IN, rC = 0.375 * IN; // rD row = 0.25
  const yAB = yTop - rA, yBC = yAB - rB, yCD = yBC - rC;
  cell(pl, fields, x2, yAB, x3, yTop, '', tb.company || 'COMPANY NAME', lh, std.text.title * 0.75, 'company', 'c');
  cell(pl, fields, x2, yBC, x3, yAB, 'TITLE:', tb.title, lh, vh * 1.25, 'title', 'c');
  const c1 = x2 + 0.5 * IN, c2 = c1 + 0.9 * IN, c3 = c2 + 2.0 * IN;
  cell(pl, fields, x2, yCD, c1, yBC, 'SIZE', sizeDesignation(ctx.sheet.size), lh, vh * 1.25, undefined, 'c');
  cell(pl, fields, c1, yCD, c2, yBC, 'CAGE CODE', tb.cage, lh, vh, 'cage', 'c');
  cell(pl, fields, c2, yCD, c3, yBC, 'DWG NO.', tb.dwgNo, lh, vh * 1.25, 'dwgNo', 'c');
  cell(pl, fields, c3, yCD, x3, yBC, 'REV', tb.rev, lh, vh * 1.25, 'rev', 'c');
  const d1 = x2 + 1.4 * IN, d2 = d1 + 1.3 * IN;
  cell(pl, fields, x2, y0, d1, yCD, 'SCALE', ctx.scaleText, lh, vh, undefined);
  cell(pl, fields, d1, y0, d2, yCD, 'WEIGHT', ctx.weightText, lh, vh, undefined);
  cell(pl, fields, d2, y0, x3, yCD, 'SHEET', `${ctx.sheetIndex + 1} OF ${ctx.sheetCount}`, lh, vh, undefined);
  // -- Approvals (block E/F/G): name + date columns.
  const rows: [string, keyof TitleBlock, keyof TitleBlock][] = [['DRAWN', 'drawnBy', 'drawnDate'], ['CHECKED', 'checkedBy', 'checkedDate'], ['ENG APPR.', 'engBy', 'engDate'], ['MFG APPR.', 'mfgBy', 'mfgDate'], ['Q.A.', 'qaBy', 'qaDate']];
  const rh = H / 6;
  const n1 = x1 + 0.9 * IN, n2 = n1 + 0.95 * IN;
  cell(pl, fields, x1, yTop - rh, n1, yTop, '', '', lh, vh);
  cell(pl, fields, n1, yTop - rh, n2, yTop, '', 'NAME', lh, lh * 1.1, undefined, 'c');
  cell(pl, fields, n2, yTop - rh, x2, yTop, '', 'DATE', lh, lh * 1.1, undefined, 'c');
  rows.forEach(([label, nf, df], i) => {
    const yb = yTop - rh * (i + 2), yt = yb + rh;
    cell(pl, fields, x1, yb, n1, yt, '', label, lh, lh * 1.1);
    cell(pl, fields, n1, yb, n2, yt, '', tb[nf] as string, lh, vh * 0.85, nf, 'c');
    cell(pl, fields, n2, yb, x2, yt, '', tb[df] as string, lh, vh * 0.75, df, 'c');
  });
  // -- Tolerance block + material / finish + projection symbol.
  const yNotes = ty0 + 0.625 * IN;
  pl.rect(tx0, yNotes, tx1, tyTop, 'frame', 'title');
  const unitWord = ctx.doc.units === 'in' ? 'INCHES' : 'MILLIMETERS';
  const p2 = ctx.doc.units === 'in' ? '.XX ' : 'X.X ', p3 = ctx.doc.units === 'in' ? '.XXX' : 'X.XX';
  const notes = ['UNLESS OTHERWISE SPECIFIED:', `DIMENSIONS ARE IN ${unitWord}`, 'TOLERANCES:', `  ${p2}  ${tb.tol2}`, `  ${p3} ${tb.tol3}`, `  ANGLES ${tb.tolAngle}`, 'INTERPRET DIMENSIONS AND TOLERANCES', 'PER ASME Y14.5-2018'];
  const pitch = (tyTop - yNotes - 2) / notes.length;
  const nh = Math.min(lh * 1.05, pitch * 0.7, ...notes.map((t) => (lh * (tx1 - tx0 - 3)) / Math.max(textWidth(t, lh), 1e-9)));
  notes.forEach((t, i) => pl.text([tx0 + 1.5, tyTop - 1.2 - pitch * i], nh, t, 'l', 't', 'title'));
  fields.push({ field: 'tol3', label: 'Tolerances', min: [tx0, yNotes], max: [tx1, tyTop] });
  const xm = tx0 + 1.5 * IN;
  cell(pl, fields, tx0, ty0 + 0.3125 * IN, xm, yNotes, 'MATERIAL', tb.material, lh, vh * 0.85, 'material');
  cell(pl, fields, tx0, ty0, xm, ty0 + 0.3125 * IN, 'FINISH', tb.finish, lh, vh * 0.85, 'finish');
  pl.rect(xm, ty0, tx1, yNotes, 'frame', 'title');
  drawProjectionSymbol(pl, [(xm + tx1) / 2, ty0 + 0.36 * IN], 0.28 * IN, ctx.doc.projection);
  pl.text([(xm + tx1) / 2, ty0 + 0.07 * IN], lh * 0.85, ctx.doc.projection === 'third' ? 'THIRD ANGLE' : 'FIRST ANGLE', 'c', 'b', 'title');

  // Revision block (ASME Y14.35), upper right.
  if (ctx.sheet.showRevisionTable) revisionTable(pl, ctx.sheet, bx1, by1, lh, vh);

  return { prims: pl, drawArea: { min: [bx0, by0], max: [bx1, by1] }, titleBox: { min: [x0, y0], max: [x3, tyTop] }, fields };
}

function revisionTable(pl: PrimList, sheet: DrawingSheet, xr: number, yt: number, lh: number, vh: number) {
  const IN_ = 25.4;
  const cols: [string, number][] = [['ZONE', 0.5 * IN_], ['REV', 0.45 * IN_], ['DESCRIPTION', 2.6 * IN_], ['DATE', 0.8 * IN_], ['APPROVED', 0.9 * IN_]];
  const W = cols.reduce((a, c) => a + c[1], 0);
  const rh = 0.25 * IN_;
  const x0 = xr - W;
  pl.rect(x0, yt - rh, xr, yt, 'frame', 'title');
  pl.text([x0 + W / 2, yt - rh / 2], lh * 1.2, 'REVISIONS', 'c', 'm', 'title');
  let y = yt - rh;
  const rows = [cols.map((c) => c[0]), ...sheet.revisions.map((r) => [r.zone, r.rev, r.description, r.date, r.approved])];
  rows.forEach((row, ri) => {
    let x = x0;
    row.forEach((t, i) => {
      pl.rect(x, y - rh, x + cols[i][1], y, 'frame', 'title');
      pl.text([x + cols[i][1] / 2, y - rh / 2], ri === 0 ? lh : vh * 0.8, t, 'c', 'm', 'title');
      x += cols[i][1];
    });
    y -= rh;
  });
}

function isoFormat(ctx: FormatContext, sz: SheetSize): SheetFormatResult {
  const pl = new PrimList('format');
  const std = STANDARDS.ISO;
  const fields: FieldBox[] = [];
  const tb = ctx.doc.titleBlock;
  // ISO 5457 frame: 20 mm filing margin left, 10 mm elsewhere. Grid strip 5 mm wide outside the frame.
  const fx0 = 20, fy0 = 10, fx1 = sz.w - 10, fy1 = sz.h - 10;
  pl.rect(fx0, fy0, fx1, fy1, 'border', 'format');
  const sx0 = fx0 - 5, sy0 = fy0 - 5, sx1 = fx1 + 5, sy1 = fy1 + 5;
  pl.rect(sx0, sy0, sx1, sy1, 'frame', 'format');
  // Grid: 50 mm fields measured from the centring marks (sheet axes of symmetry).
  const cx = sz.w / 2, cy = sz.h / 2;
  const xs: number[] = [], ys: number[] = [];
  for (let x = cx; x < fx1 - 1e-9; x += 50) xs.push(x);
  for (let x = cx - 50; x > fx0 + 1e-9; x -= 50) xs.push(x);
  for (let y = cy; y < fy1 - 1e-9; y += 50) ys.push(y);
  for (let y = cy - 50; y > fy0 + 1e-9; y -= 50) ys.push(y);
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  for (const x of xs) { pl.line([x, sy0], [x, fy0], 'frame', 'format'); pl.line([x, fy1], [x, sy1], 'frame', 'format'); }
  for (const y of ys) { pl.line([sx0, y], [fx0, y], 'frame', 'format'); pl.line([fx1, y], [sx1, y], 'frame', 'format'); }
  const xb = [fx0, ...xs, fx1], yb = [fy0, ...ys, fy1];
  const zt = 3.5 * 0.85;
  for (let i = 0; i + 1 < xb.length; i++) {
    const x = (xb[i] + xb[i + 1]) / 2, label = String(i + 1);
    pl.text([x, (sy0 + fy0) / 2], zt, label, 'c', 'm', 'format');
    pl.text([x, (fy1 + sy1) / 2], zt, label, 'c', 'm', 'format');
  }
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const nRows = yb.length - 1;
  for (let j = 0; j < nRows; j++) {
    const y = (yb[j] + yb[j + 1]) / 2, label = letters[nRows - 1 - j]; // A at the top
    pl.text([(sx0 + fx0) / 2, y], zt, label, 'c', 'm', 'format');
    pl.text([(fx1 + sx1) / 2, y], zt, label, 'c', 'm', 'format');
  }
  // Centring marks: from the sheet edge to 5 mm inside the frame.
  pl.line([cx, 0], [cx, fy0 + 5], 'border', 'format'); pl.line([cx, sz.h], [cx, fy1 - 5], 'border', 'format');
  pl.line([0, cy], [fx0 + 5, cy], 'border', 'format'); pl.line([sz.w, cy], [fx1 - 5, cy], 'border', 'format');

  // ISO 7200 title block, 180 mm wide, 4 rows × 9 mm, plus a 9 mm data row above.
  const lh = std.text.tbLabel, vh = std.text.tbValue;
  const W = 180, r = 9;
  const x0 = fx1 - W, x3 = fx1, y0 = fy0;
  const row = (k: number) => y0 + k * r;
  cell(pl, fields, x0, row(3), x0 + 45, row(4), 'Responsible dept.', tb.dept, lh, vh * 0.8, 'dept');
  cell(pl, fields, x0 + 45, row(3), x0 + 90, row(4), 'Technical reference', tb.techRef, lh, vh * 0.8, 'techRef');
  cell(pl, fields, x0 + 90, row(3), x0 + 140, row(4), 'Document type', tb.docType, lh, vh * 0.8, 'docType');
  cell(pl, fields, x0 + 140, row(3), x3, row(4), 'Document status', tb.docStatus, lh, vh * 0.8, 'docStatus');
  cell(pl, fields, x0, row(2), x0 + 45, row(3), 'Created by', tb.drawnBy, lh, vh * 0.8, 'drawnBy');
  cell(pl, fields, x0 + 45, row(2), x0 + 90, row(3), 'Approved by', tb.engBy, lh, vh * 0.8, 'engBy');
  cell(pl, fields, x0 + 90, row(2), x3, row(3), 'Legal owner', tb.company, lh, vh, 'company');
  cell(pl, fields, x0, row(0), x0 + 90, row(2), 'Title, supplementary title', '', lh, vh, 'title');
  pl.text([x0 + 45, row(1) + 2.2], 5, tb.title, 'c', 'm', 'title');
  if (tb.subtitle) pl.text([x0 + 45, row(0) + 3], 3.5, tb.subtitle, 'c', 'm', 'title');
  cell(pl, fields, x0 + 90, row(1), x3, row(2), 'Identification number', tb.dwgNo, lh, vh * 1.2, 'dwgNo');
  cell(pl, fields, x0 + 90, row(0), x0 + 110, row(1), 'Rev.', tb.rev, lh, vh, 'rev', 'c');
  cell(pl, fields, x0 + 110, row(0), x0 + 140, row(1), 'Date of issue', tb.drawnDate, lh, vh * 0.8, 'drawnDate');
  cell(pl, fields, x0 + 140, row(0), x0 + 155, row(1), 'Lang.', tb.lang, lh, vh * 0.8, 'lang', 'c');
  cell(pl, fields, x0 + 155, row(0), x3, row(1), 'Sheet', `${ctx.sheetIndex + 1}/${ctx.sheetCount}`, lh, vh * 0.8, undefined, 'c');
  // Data row: scale | size | projection | general tolerances | material | mass.
  const yd0 = row(4), yd1 = row(5);
  cell(pl, fields, x0, yd0, x0 + 20, yd1, 'Scale', ctx.scaleText, lh, vh * 0.8, undefined, 'c');
  cell(pl, fields, x0 + 20, yd0, x0 + 35, yd1, 'Size', sizeDesignation(ctx.sheet.size), lh, vh * 0.8, undefined, 'c');
  pl.rect(x0 + 35, yd0, x0 + 60, yd1, 'frame', 'title');
  drawProjectionSymbol(pl, [x0 + 47.5, (yd0 + yd1) / 2], 5, ctx.doc.projection);
  cell(pl, fields, x0 + 60, yd0, x0 + 100, yd1, 'General tolerances', tb.generalTol, lh, vh * 0.8, 'generalTol');
  cell(pl, fields, x0 + 100, yd0, x0 + 150, yd1, 'Material', tb.material, lh, vh * 0.8, 'material');
  cell(pl, fields, x0 + 150, yd0, x3, yd1, 'Mass', ctx.weightText, lh, vh * 0.8, undefined);
  if (ctx.sheet.showRevisionTable) revisionTable(pl, ctx.sheet, fx1, fy1, lh * 1.4, vh);
  return { prims: pl, drawArea: { min: [fx0, fy0], max: [fx1, fy1] }, titleBox: { min: [x0, y0], max: [x3, yd1] }, fields };
}

export function sheetFormat(ctx: FormatContext): SheetFormatResult {
  const sz = sheetSize(ctx.sheet.size);
  return ctx.doc.standard === 'ISO' ? isoFormat(ctx, sz) : asmeFormat(ctx, sz);
}
