/**
 * Drawing composition: sheet + views + annotations → paper primitives.
 *
 * Everything shown on screen and exported comes from `composeSheet`, which
 * is a pure function of the drawing document, the part document and the
 * view geometry the kernel computed from the exact B-rep. So when the part
 * changes, re-running the kernel and this function updates every view,
 * dimension and table.
 */
import type { CadDocument, ExtrudeFeature } from '../core/model';
import { resolveParams } from '../core/store';
import { evalLength } from '../core/units';
import { to3d, type SketchGeometry, type EvalEntity } from '../kernel/regen';
import { SKETCH_AXIS_H, SKETCH_AXIS_V, SKETCH_ORIGIN, type PointRef } from '../core/model';
import type { DrawingGeometryResponse, ModelAnchors, ViewGeometry, ViewRequest } from '../kernel/hlr';
import {
  add, boundsOf, clipToCircle, dist, dot, hatchSegments, mul, norm, perp, sub, transformCurve, type Curve2, type V2, type V3,
} from './geom2d';
import type { Annotation, Attach, DimRef, DrawingDocument, DrawingSheet, DrawingView, Ratio } from './model';
import { viewChain } from './model';
import { PrimList, type Prim } from './prims';
import { sheetFormat, type SheetFormatResult } from './sheetFormat';
import { sheetSize, STANDARDS, type StandardSpec } from './standards';
import { STD_FRAMES, project, projectedFrame, paperDirTo3d, scaleLabel, scaleValue, v3, type ViewFrame } from './views';
import { dimensionText, toUnits, type DimText } from './format';
import { drawAngleDim, drawDimText, drawLeader, drawLinearDim, drawRadialDim, dimTextWidth, type DimStyle } from './annotate';
import { drawDatum, drawFcf } from './gdt';
import { textWidth } from './text';

export interface ResolvedView {
  view: DrawingView;
  frame: ViewFrame;
  scale: number;
  ratio: Ratio;
  /** View-coordinate point placed at `pos`. */
  pivot: V2;
  pos: V2;
  /** Detail views: clip circle in view coordinates. */
  clip?: { c: V2; r: number };
  /** Id of the kernel geometry this view draws (detail views draw their parent's). */
  geomId: string;
  /** Paper bounding box of the drawn geometry. */
  box: { min: V2; max: V2 };
  error?: string;
}

export const toPaper = (rv: Pick<ResolvedView, 'pivot' | 'pos' | 'scale'>, q: V2): V2 => [rv.pos[0] + (q[0] - rv.pivot[0]) * rv.scale, rv.pos[1] + (q[1] - rv.pivot[1]) * rv.scale];
export const fromPaper = (rv: Pick<ResolvedView, 'pivot' | 'pos' | 'scale'>, p: V2): V2 => [rv.pivot[0] + (p[0] - rv.pos[0]) / rv.scale, rv.pivot[1] + (p[1] - rv.pos[1]) / rv.scale];
export const paperOf3 = (rv: ResolvedView, p: V3): V2 => toPaper(rv, project(p, rv.frame));

/** Something the cursor can snap to (paper coordinates) with the model reference it stands for. */
export type Snap =
  | { kind: 'vertex'; view: string; p: V2; ref: Extract<DimRef, { k: 'pt' }> }
  | { kind: 'center'; view: string; p: V2; r: number; ref: Extract<DimRef, { k: 'circle' }>; trueShape: boolean; full: boolean }
  | { kind: 'edge'; view: string; a: V2; b: V2; ref: Extract<DimRef, { k: 'line' }> };

export interface ComposeResult {
  prims: Prim[];
  views: ResolvedView[];
  format: SheetFormatResult;
  annotationBoxes: Record<string, { min: V2; max: V2 }>;
  snaps: Snap[];
  /** Human-readable problems (dangling dimensions, failed views). */
  warnings: string[];
}

export interface ComposeInput {
  doc: DrawingDocument;
  sheetIndex: number;
  part: CadDocument | null;
  geometry: (DrawingGeometryResponse & { sketches?: SketchGeometry[] }) | null;
  /** Part volume in mm³ (for the title block weight). */
  volume?: number | null;
}

/** Solved sketch geometry from the kernel (handles constrained sketches, face and reference planes). */
export type Sketches = SketchGeometry[] | undefined;

// ---------------------------------------------------------------------------
// View resolution

export function viewFrame(doc: DrawingDocument, sheet: DrawingSheet, id: string): ViewFrame {
  const chain = viewChain(sheet, id);
  let f: ViewFrame = STD_FRAMES.front;
  for (const v of chain) {
    if (v.kind === 'model') f = STD_FRAMES[v.orientation];
    else if (v.kind === 'projected' || v.kind === 'auxiliary' || v.kind === 'section') f = projectedFrame(f, v.dir, doc.projection);
    // detail: same frame as its parent
  }
  return f;
}

export function viewRatio(sheet: DrawingSheet, id: string): Ratio {
  const chain = viewChain(sheet, id);
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i].scale) return chain[i].scale!;
  return sheet.scale;
}

/** 3D point of a cutting line point given in parent view coordinates. */
export function viewPointTo3d(f: ViewFrame, q: V2): V3 { return v3.add(v3.mul(f.x, q[0]), v3.mul(f.y, q[1])); }

/** Kernel requests for a sheet (detail views reuse their parent's geometry). */
export function viewRequests(doc: DrawingDocument, sheet: DrawingSheet): ViewRequest[] {
  const out: ViewRequest[] = [];
  for (const v of sheet.views) {
    if (v.kind === 'detail') continue;
    try {
      const frame = viewFrame(doc, sheet, v.id);
      const req: ViewRequest = { id: v.id, frame, tangent: doc.tangentEdges === 'visible' };
      if (v.kind === 'section') {
        const pf = viewFrame(doc, sheet, v.parent);
        req.section = { point: viewPointTo3d(pf, v.a) };
      }
      out.push(req);
    } catch { /* broken parent chain: reported at compose time */ }
  }
  return out;
}

const bboxCenter = (m: ModelAnchors | null | undefined): V3 => (m ? [(m.bboxMin[0] + m.bboxMax[0]) / 2, (m.bboxMin[1] + m.bboxMax[1]) / 2, (m.bboxMin[2] + m.bboxMax[2]) / 2] : [0, 0, 0]);

function geomSource(sheet: DrawingSheet, v: DrawingView): string {
  let cur = v;
  while (cur.kind === 'detail') { const p = sheet.views.find((x) => x.id === (cur as any).parent); if (!p) break; cur = p; }
  return cur.id;
}

/** Resolve frame, scale and placement of every view (parents first, so alignment can use resolved parent positions). */
export function resolveViews(doc: DrawingDocument, sheet: DrawingSheet, geometry: DrawingGeometryResponse | null): ResolvedView[] {
  const center3 = bboxCenter(geometry?.model);
  const resolved = new Map<string, ResolvedView>();
  const resolve = (v: DrawingView, depth = 0): ResolvedView | null => {
    if (resolved.has(v.id)) return resolved.get(v.id)!;
    if (depth > 50) return null;
    let frame: ViewFrame, ratio: Ratio;
    try { frame = viewFrame(doc, sheet, v.id); ratio = viewRatio(sheet, v.id); } catch (e) {
      const rv: ResolvedView = { view: v, frame: STD_FRAMES.front, scale: 1, ratio: [1, 1], pivot: [0, 0], pos: v.position, geomId: v.id, box: { min: v.position, max: v.position }, error: (e as Error).message };
      resolved.set(v.id, rv); return rv;
    }
    let pos = v.position;
    let pivot = project(center3, frame);
    let clip: ResolvedView['clip'];
    if (v.kind === 'detail') { pivot = v.center; clip = { c: v.center, r: v.radius }; }
    if (v.kind !== 'model' && v.kind !== 'detail' && v.aligned !== false) {
      const parent = sheet.views.find((x) => x.id === v.parent);
      const pr = parent ? resolve(parent, depth + 1) : null;
      if (pr) {
        const d = norm(v.dir);
        // Keep only the offset along d; the fold-line coordinate follows the parent.
        pos = add(pr.pos, mul(d, dot(sub(v.position, pr.pos), d)));
      }
    }
    const rv: ResolvedView = { view: v, frame, scale: scaleValue(ratio), ratio, pivot, pos, clip, geomId: geomSource(sheet, v), box: { min: pos, max: pos } };
    resolved.set(v.id, rv);
    return rv;
  };
  return sheet.views.map((v) => resolve(v)!).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Model dimensions (from the part's features)

/**
 * The parameter that sets a sketch line's length, when the line was drawn as
 * `x2 = (x1) + (P)` (or the same in y) with the other coordinate shared, as
 * the rectangle tools write it. Editing such a dimension changes P.
 */
export function lineLengthParam(part: CadDocument, sketchId: string, entityId: string): string | null {
  const f = part.features.find((x) => x.id === sketchId);
  if (f?.type !== 'sketch') return null;
  const e = f.entities.find((x) => x.id === entityId);
  if (!e || e.kind !== 'line') return null;
  const str = (v: unknown) => String(v).replace(/\s+/g, '');
  const names = new Set(part.params.map((p) => p.name));
  const check = (a: unknown, b: unknown, same1: unknown, same2: unknown): string | null => {
    if (str(same1) !== str(same2)) return null;
    for (const [lo, hi] of [[a, b], [b, a]]) {
      const h = str(hi), l = str(lo);
      const m = /^\(?(.*?)\)?\+\(?([A-Za-z_][A-Za-z0-9_]*)\)?$/.exec(h);
      if (m && m[1] === l && names.has(m[2])) return m[2];
      if (Number(l) === 0 && names.has(h)) return h; // drawn from the origin: x2 = P
    }
    return null;
  };
  return check(e.p1.x, e.p2.x, e.p1.y, e.p2.y) ?? check(e.p1.y, e.p2.y, e.p1.x, e.p2.x);
}

export interface ModelDimGeometry { refs: DimRef[]; value: number; editable: boolean; label: string; sketchDir?: 'h' | 'v' }

type P2 = [number, number];

/** Solved 2D position of a sketch point reference. */
export function sketchPoint(ents: EvalEntity[], r: PointRef): P2 | null {
  if (r.e === SKETCH_ORIGIN) return [0, 0];
  const e = ents.find((x) => x.id === r.e);
  if (!e) return null;
  if (e.kind === 'point') return e.p;
  if (e.kind === 'line') return r.p === 'end' ? e.b : e.a;
  if (e.kind === 'circle') return e.c;
  if (e.kind === 'spline') return e.closed ? null : r.p === 'end' ? e.pts[e.pts.length - 1] : e.pts[0];
  if (r.p === 'center') return e.c;
  const a = r.p === 'end' ? e.a1 : e.a0;
  return [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)];
}

function sketchLine(ents: EvalEntity[], id: string): [P2, P2] | null {
  if (id === SKETCH_AXIS_H) return [[0, 0], [1, 0]];
  if (id === SKETCH_AXIS_V) return [[0, 0], [0, 1]];
  const e = ents.find((x) => x.id === id);
  return e && e.kind === 'line' ? [e.a, e.b] : null;
}

/**
 * Evaluate a model link against the current part and its solved sketches.
 * Returns null when the referenced feature, entity or constraint no longer exists.
 */
export function modelDimGeometry(part: CadDocument, a: Extract<Annotation, { kind: 'dim' }>, sketches: Sketches): ModelDimGeometry | null {
  const link = a.model;
  if (!link || !sketches) return null;
  const params = resolveParams(part);
  const skOf = (id: string) => sketches.find((s) => s.id === id);
  const nameOf = (id: string) => part.features.find((f) => f.id === id)?.name ?? 'Sketch';
  try {
    if (link.kind === 'depth') {
      const f = part.features.find((x) => x.id === link.feature) as ExtrudeFeature | undefined;
      if (!f || f.type !== 'extrude' || f.throughAll) return null;
      const sk = skOf(f.sketch);
      if (!sk) return null;
      const e0 = sk.entities.find((e) => !e.construction && e.kind !== 'point');
      if (!e0) return null;
      const uv: P2 = e0.kind === 'line' ? e0.a : e0.kind === 'point' ? e0.p : e0.kind === 'spline' ? e0.pts[0] : [e0.c[0] + e0.r, e0.c[1]];
      const p0 = to3d(sk.frame, uv[0], uv[1]);
      const n = sk.frame.n;
      const d = evalDepth(part, f.depth, params);
      const sgn = f.direction === 'reverse' ? -1 : 1;
      const start = f.direction === 'symmetric' ? v3.sub(p0, v3.mul(n, d / 2)) : p0;
      const end = f.direction === 'symmetric' ? v3.add(p0, v3.mul(n, d / 2)) : v3.add(p0, v3.mul(n, sgn * d));
      return { refs: [{ k: 'pt', p: start }, { k: 'pt', p: end }], value: d, editable: true, label: `${f.name} depth` };
    }
    const sk = skOf(link.sketch);
    if (!sk) return null;
    const P3 = (q: P2) => to3d(sk.frame, q[0], q[1]);
    const circleRef = (e: Extract<EvalEntity, { kind: 'circle' | 'arc' }>): DimRef => ({ k: 'circle', c: P3(e.c), r: e.r, n: sk.frame.n });
    if (link.kind === 'circle') {
      const e = sk.entities.find((x) => x.id === link.entities[0]);
      if (!e || e.kind !== 'circle') return null;
      return { refs: [circleRef(e)], value: 2 * e.r, editable: true, label: `${nameOf(sk.id)} circle` };
    }
    if (link.kind === 'arc') {
      const e = sk.entities.find((x) => x.id === link.entity);
      if (!e || e.kind !== 'arc') return null;
      return { refs: [circleRef(e)], value: e.r, editable: true, label: `${nameOf(sk.id)} arc` };
    }
    if (link.kind === 'line') {
      const e = sk.entities.find((x) => x.id === link.entity);
      if (!e || e.kind !== 'line') return null;
      return { refs: [{ k: 'pt', p: P3(e.a) }, { k: 'pt', p: P3(e.b) }], value: Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), editable: !!lineLengthParam(part, link.sketch, link.entity), label: `${nameOf(sk.id)} line` };
    }
    if (link.kind === 'sketchDim') {
      const feat = part.features.find((f) => f.id === link.sketch);
      const c = feat?.type === 'sketch' ? feat.constraints?.find((x) => x.id === link.constraint) : undefined;
      if (!c) return null;
      const label = `${nameOf(sk.id)} dimension`;
      const editable = !(c as any).driven;
      if (c.type === 'radius' || c.type === 'diameter') {
        const e = sk.entities.find((x) => x.id === c.e);
        if (!e || (e.kind !== 'circle' && e.kind !== 'arc')) return null;
        return { refs: [circleRef(e)], value: c.type === 'diameter' ? 2 * e.r : e.r, editable, label };
      }
      if (c.type === 'distance') {
        const p = sketchPoint(sk.entities, c.a), q = sketchPoint(sk.entities, c.b);
        if (!p || !q) return null;
        const v = c.dir === 'h' ? Math.abs(q[0] - p[0]) : c.dir === 'v' ? Math.abs(q[1] - p[1]) : Math.hypot(q[0] - p[0], q[1] - p[1]);
        return { refs: [{ k: 'pt', p: P3(p) }, { k: 'pt', p: P3(q) }], value: v, editable, label, sketchDir: c.dir };
      }
      if (c.type === 'pointLineDistance') {
        const p = sketchPoint(sk.entities, c.p), ln = sketchLine(sk.entities, c.line);
        if (!p || !ln) return null;
        const d = [ln[1][0] - ln[0][0], ln[1][1] - ln[0][1]], L = Math.hypot(d[0], d[1]) || 1;
        const t = ((p[0] - ln[0][0]) * d[0] + (p[1] - ln[0][1]) * d[1]) / (L * L);
        const foot: P2 = [ln[0][0] + d[0] * t, ln[0][1] + d[1] * t];
        return { refs: [{ k: 'pt', p: P3(p) }, { k: 'pt', p: P3(foot) }], value: Math.hypot(p[0] - foot[0], p[1] - foot[1]), editable, label };
      }
      if (c.type === 'angle') {
        const l1 = sketchLine(sk.entities, c.a), l2 = sketchLine(sk.entities, c.b);
        if (!l1 || !l2) return null;
        return { refs: [{ k: 'line', a: P3(l1[0]), b: P3(l1[1]) }, { k: 'line', a: P3(l2[0]), b: P3(l2[1]) }], value: 0, editable, label };
      }
      return null;
    }
  } catch { return null; }
  return null;
}

function evalDepth(part: CadDocument, v: number | string, params: ReturnType<typeof resolveParams>): number { return evalLength(v, part.units, params); }

// ---------------------------------------------------------------------------
// Dimension reference resolution (driven dimensions follow topology-stable changes)

function resolveRef(ref: DimRef, model: ModelAnchors | null | undefined): { ref: DimRef; ok: boolean } {
  if (!model) return { ref, ok: false };
  const near = (a: V3, b: V3, tol = 1e-4) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;
  if (ref.k === 'pt') {
    if (ref.vi !== undefined) { const v = model.vertices.find((x) => x.i === ref.vi); if (v) return { ref: { ...ref, p: v.p }, ok: true }; }
    const v = model.vertices.find((x) => near(x.p, ref.p));
    return v ? { ref: { ...ref, p: v.p, vi: v.i }, ok: true } : { ref, ok: false };
  }
  if (ref.k === 'circle') {
    if (ref.ei !== undefined) { const c = model.circles.find((x) => x.i === ref.ei); if (c) return { ref: { ...ref, c: c.c, r: c.r, n: c.n }, ok: true }; }
    const c = model.circles.find((x) => near(x.c, ref.c) && Math.abs(x.r - ref.r) < 1e-4);
    return c ? { ref: { ...ref, c: c.c, r: c.r, n: c.n, ei: c.i }, ok: true } : { ref, ok: false };
  }
  if (ref.ei !== undefined) { const l = model.lines.find((x) => x.i === ref.ei); if (l) return { ref: { ...ref, a: l.a, b: l.b }, ok: true }; }
  const l = model.lines.find((x) => (near(x.a, ref.a) && near(x.b, ref.b)) || (near(x.a, ref.b) && near(x.b, ref.a)));
  return l ? { ref: { ...ref, a: l.a, b: l.b, ei: l.i }, ok: true } : { ref, ok: false };
}

// ---------------------------------------------------------------------------
// Composition

const IN = 25.4;

export function formatWeight(doc: DrawingDocument, part: CadDocument | null, volume?: number | null): string {
  if (!part?.material || !volume) return '';
  const grams = (volume / 1000) * part.material.density;
  return doc.units === 'in' ? `${(grams / 453.59237).toFixed(3)} lb` : `${(grams / 1000).toFixed(3)} kg`;
}

export function composeSheet(input: ComposeInput): ComposeResult {
  const { doc, part, geometry } = input;
  const sheet = doc.sheets[input.sheetIndex];
  const std = STANDARDS[doc.standard];
  const prims: Prim[] = [];
  const warnings: string[] = [];
  const snaps: Snap[] = [];
  const annotationBoxes: ComposeResult['annotationBoxes'] = {};

  const format = sheetFormat({
    doc, sheet, sheetIndex: input.sheetIndex, sheetCount: doc.sheets.length,
    scaleText: scaleLabel(sheet.scale), weightText: formatWeight(doc, part, input.volume),
  });
  prims.push(...format.prims.items);

  const views = resolveViews(doc, sheet, geometry);
  const geomById = new Map<string, ViewGeometry>((geometry?.views ?? []).map((g) => [g.id, g]));
  const model = geometry?.model ?? null;
  const usedLetters: string[] = [];

  for (const rv of views) {
    const v = rv.view;
    const pl = new PrimList(v.id);
    const g = geomById.get(rv.geomId);
    if (rv.error || !g || g.error) {
      const msg = rv.error ?? g?.error ?? (geometry ? 'View not computed yet' : 'Computing view…');
      if (geometry) warnings.push(`${v.name}: ${msg}`);
      pl.text(rv.pos, std.text.note, msg, 'c', 'm', 'notes');
      rv.box = { min: sub(rv.pos, [20, 5]), max: add(rv.pos, [20, 5]) };
      prims.push(...pl.items);
      continue;
    }
    const place = (cv: Curve2): Curve2[] => (rv.clip ? clipToCircle(cv, rv.clip.c, rv.clip.r) : [cv]).map((c) => transformCurve(c, rv.pivot, rv.scale, rv.pos));
    const drawn: Curve2[] = [];
    for (const cv of g.visible) for (const c of place(cv)) { pl.curve(c, 'visible', 'geometry'); drawn.push(c); }
    if (doc.tangentEdges === 'visible') for (const cv of g.tangent) for (const c of place(cv)) { pl.curve(c, 'tangent', 'geometry'); drawn.push(c); }
    if (v.hiddenLines) for (const cv of g.hidden) for (const c of place(cv)) pl.curve(c, 'hidden', 'hidden');
    // Section hatching (ANSI31-style 45° lines; spacing on paper).
    if (g.section.length) {
      const chains = g.section.map((ch) => ch.map((q) => toPaper(rv, q)));
      let segs = hatchSegments(chains, std.hatch.angle, std.hatch.spacing);
      if (rv.clip) {
        const cc = toPaper(rv, rv.clip.c), cr = rv.clip.r * rv.scale;
        segs = segs.flatMap(([a, b]) => clipToCircle({ k: 'line', a, b }, cc, cr).map((c) => [(c as any).a, (c as any).b] as [V2, V2]));
      }
      for (const [a, b] of segs) pl.line(a, b, 'hatch', 'hatch');
    }
    // Automatic center marks / centerlines from exact cylinder axes.
    if (model) {
      const marks: { c: V2; r: number }[] = [];
      const clines: { a: V2; b: V2 }[] = [];
      for (const ax of model.axes) {
        if (!ax.full) continue;
        const along = Math.abs(v3.dot(ax.dir, rv.frame.z));
        if (along > 1 - 1e-9 && v.centerMarks) {
          const c = project(ax.c, rv.frame);
          if (rv.clip && dist(c, rv.clip.c) > rv.clip.r) continue;
          const pc = toPaper(rv, c);
          if (!marks.some((m) => dist(m.c, pc) < 1e-6 && Math.abs(m.r - ax.r * rv.scale) < 1e-6)) marks.push({ c: pc, r: ax.r * rv.scale });
        } else if (along < 1e-9 && v.centerlines) {
          const a = toPaper(rv, project(v3.add(ax.c, v3.mul(ax.dir, ax.v0)), rv.frame));
          const b = toPaper(rv, project(v3.add(ax.c, v3.mul(ax.dir, ax.v1)), rv.frame));
          const ex = mul(norm(sub(b, a)), 0.125 * IN);
          let seg = { a: sub(a, ex), b: add(b, ex) };
          // Merge coaxial centerlines (e.g. counterbores) in this view.
          const same = clines.find((l) => Math.abs((l.b[0] - l.a[0]) * (seg.a[1] - l.a[1]) - (l.b[1] - l.a[1]) * (seg.a[0] - l.a[0])) / (dist(l.a, l.b) || 1) < 1e-6);
          if (same) {
            const d = norm(sub(same.b, same.a));
            const ts = [0, dot(sub(same.b, same.a), d), dot(sub(seg.a, same.a), d), dot(sub(seg.b, same.a), d)];
            const lo = Math.min(...ts), hi = Math.max(...ts);
            const base = same.a;
            same.a = add(base, mul(d, lo)); same.b = add(base, mul(d, hi));
            continue;
          }
          clines.push(seg);
        }
      }
      for (const m of marks) drawCenterMark(pl, m.c, m.r, rv.clip ? { c: toPaper(rv, rv.clip.c), r: rv.clip.r * rv.scale } : undefined);
      for (const l of clines) {
        for (const c of rv.clip ? clipToCircle({ k: 'line', a: l.a, b: l.b }, toPaper(rv, rv.clip.c), rv.clip.r * rv.scale) : [{ k: 'line', a: l.a, b: l.b } as Curve2]) pl.curve(c, 'center', 'center');
      }
      // Snap targets for annotation tools (vertices, true-shape circles, linear edges).
      const inClip = (q: V2) => !rv.clip || dist(q, rv.clip.c) <= rv.clip.r + 1e-9;
      for (const vx of model.vertices) { const q = project(vx.p, rv.frame); if (inClip(q)) snaps.push({ kind: 'vertex', view: v.id, p: toPaper(rv, q), ref: { k: 'pt', p: vx.p, vi: vx.i } }); }
      if (v.kind === 'section') for (const p of g.sectionVertices) snaps.push({ kind: 'vertex', view: v.id, p: toPaper(rv, project(p, rv.frame)), ref: { k: 'pt', p } });
      for (const ci of model.circles) {
        const q = project(ci.c, rv.frame);
        if (!inClip(q)) continue;
        snaps.push({ kind: 'center', view: v.id, p: toPaper(rv, q), r: ci.r * rv.scale, ref: { k: 'circle', c: ci.c, r: ci.r, n: ci.n, ei: ci.i }, trueShape: Math.abs(v3.dot(ci.n, rv.frame.z)) > 1 - 1e-9, full: ci.full });
      }
      for (const ln of model.lines) {
        const a = project(ln.a, rv.frame), b = project(ln.b, rv.frame);
        if (dist(a, b) < 1e-9 || !inClip(a) || !inClip(b)) continue;
        snaps.push({ kind: 'edge', view: v.id, a: toPaper(rv, a), b: toPaper(rv, b), ref: { k: 'line', a: ln.a, b: ln.b, ei: ln.i } });
      }
    }
    // Detail boundary circle drawn in the detail view itself? ASME shows the enlarged view unbounded; we draw nothing.
    const bb = boundsOf(drawn) ?? { min: sub(rv.pos, [5, 5]), max: add(rv.pos, [5, 5]) };
    rv.box = bb;
    // View label (ASME Y14.3: below the view; scale noted when different from the sheet scale).
    const lines: string[] = [];
    if (v.kind === 'section') { lines.push(`SECTION ${v.letter}-${v.letter}`); usedLetters.push(v.letter); }
    if (v.kind === 'detail') { lines.push(`DETAIL ${v.letter}`); usedLetters.push(v.letter); }
    if (v.kind === 'auxiliary') { lines.push(`VIEW ${v.letter}`); usedLetters.push(v.letter); }
    if (scaleValue(rv.ratio) !== scaleValue(sheet.scale) || (lines.length && v.kind === 'detail')) lines.push(`SCALE ${scaleLabel(rv.ratio)}`);
    let ly = bb.min[1] - std.text.viewLabel * 1.2;
    const lx = (bb.min[0] + bb.max[0]) / 2;
    lines.forEach((t, i) => { const h = i === 0 && lines.length > 1 || (i === 0 && !t.startsWith('SCALE')) ? std.text.viewLabel : std.text.dim; pl.text([lx, ly], h, t, 'c', 't', 'notes'); ly -= h * 1.6; });
    prims.push(...pl.items);
  }

  // Parent-view callouts: cutting planes, detail circles, viewing arrows.
  for (const rv of views) {
    const v = rv.view;
    if (v.kind !== 'section' && v.kind !== 'detail' && v.kind !== 'auxiliary') continue;
    const parent = views.find((x) => x.view.id === v.parent);
    if (!parent) continue;
    const pl = new PrimList(v.id);
    const th = std.text.viewLabel;
    if (v.kind === 'section') {
      let a = toPaper(parent, v.a), b = toPaper(parent, v.b);
      const u = norm(sub(b, a));
      if (v.span) {
        // Keep the line across the whole parent view as the part changes size.
        const bx = parent.box;
        const ts = [[bx.min[0], bx.min[1]], [bx.max[0], bx.min[1]], [bx.min[0], bx.max[1]], [bx.max[0], bx.max[1]]].map((q) => dot(sub(q as V2, a), u));
        const m = 0.15 * IN;
        b = add(a, mul(u, Math.max(...ts) + m));
        a = add(a, mul(u, Math.min(...ts) - m));
      }
      const ext = mul(u, 0.25 * IN);
      const A = sub(a, ext), B = add(b, ext);
      pl.line(A, B, 'cutting', 'center');
      // Arrows at each end, perpendicular to the cutting line, pointing in the direction of sight.
      const s = doc.projection === 'third' ? 1 : -1;
      const sight = mul(norm(v.dir), -s);
      const al = 0.5 * IN;
      for (const P of [A, B]) {
        const tail = add(P, mul(sight, -0.0));
        const tip = add(tail, mul(sight, al));
        pl.line(tail, tip, 'visible', 'center');
        pl.arrow(tip, sight, std.arrow.length * 1.6, std.arrow.width * 1.6, 'center');
        pl.text(add(tip, add(mul(sight, th * 0.9), mul(perp(sight), 0))), th, v.letter, 'c', 'm', 'notes');
      }
    } else if (v.kind === 'detail') {
      const c = toPaper(parent, v.center), r = v.radius * parent.scale;
      pl.circle(c, r, 'phantom', 'center');
      const d: V2 = [Math.SQRT1_2, Math.SQRT1_2];
      pl.text(add(c, mul(d, r + th * 1.1)), th, v.letter, 'c', 'm', 'notes');
    } else {
      const [ea, eb] = v.edge;
      const m = toPaper(parent, [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2]);
      const s = doc.projection === 'third' ? 1 : -1;
      const sight = mul(norm(v.dir), -s);
      const tail = sub(m, mul(sight, 0.9 * IN)), tip = sub(m, mul(sight, 0.3 * IN));
      pl.line(tail, tip, 'thin', 'center');
      pl.arrow(tip, sight, std.arrow.length * 1.5, std.arrow.width * 1.5, 'center');
      pl.text(sub(tail, mul(sight, th)), th, v.letter, 'c', 'm', 'notes');
    }
    prims.push(...pl.items);
  }

  // Annotations
  const ctx: AnnContext = { doc, part, model, sketches: geometry?.sketches, views, std, warnings };
  for (const a of sheet.annotations) {
    const items = annotationPrims(a, ctx);
    if (items.length) annotationBoxes[a.id] = primBounds(items);
    prims.push(...items);
  }

  return { prims, views, format, annotationBoxes, snaps, warnings };
}

export interface AnnContext { doc: DrawingDocument; part: CadDocument | null; model: ModelAnchors | null; sketches?: Sketches; views: ResolvedView[]; std: StandardSpec; warnings: string[] }

/** Primitives of one annotation (also used for live previews while a tool is active). */
export function annotationPrims(a: Annotation, ctx: AnnContext): Prim[] {
  const { doc, part, model, views, std, warnings, sketches } = ctx;
  const h = std.text.dim;
  const st: DimStyle = { std, h };
  const viewOf = (id: string) => views.find((x) => x.view.id === id);
  const attachPoint = (at: Attach): V2 | null => {
    if ('paper' in at) return at.paper;
    const rv = viewOf(at.view);
    return rv ? paperOf3(rv, at.p) : null;
  };
  const pl = new PrimList(a.id);
  try {
    switch (a.kind) {
      case 'dim': {
        const rv = viewOf(a.view);
        if (!rv) { warnings.push(`Dimension ${a.id}: its view was deleted`); break; }
        drawDimension(pl, a, rv, doc, part, model, sketches, st, warnings);
        break;
      }
      case 'note': {
        const nh = a.height ?? std.text.note;
        const lines = a.text.split('\n');
        lines.forEach((t, i) => pl.text([a.at[0], a.at[1] - i * nh * 1.6], nh, t, 'l', 't', 'notes'));
        if (a.leader) {
          const p = attachPoint(a.leader);
          const w = Math.max(...lines.map((t) => textWidth(t, nh)));
          if (p) {
            const left = p[0] < a.at[0] + w / 2;
            const from: V2 = [left ? a.at[0] - nh * 0.5 : a.at[0] + w + nh * 0.5, a.at[1] - nh / 2];
            const shoulder: V2 = [from[0] + (left ? -1 : 1) * nh * 2, from[1]];
            pl.line(from, shoulder, 'thin', 'dims');
            drawLeader(pl, shoulder, p, st);
          }
        }
        break;
      }
      case 'fcf': {
        const box = drawFcf(pl, a.rows, a.at, h);
        if (a.leader) {
          const p = attachPoint(a.leader);
          if (p) {
            const cy = a.at[1] - h; // middle of first row
            const from: V2 = p[0] < (box.min[0] + box.max[0]) / 2 ? [box.min[0], cy] : [box.max[0], cy];
            drawLeader(pl, from, p, st);
          }
        }
        break;
      }
      case 'datum': {
        const p = attachPoint(a.attach);
        if (p) drawDatum(pl, a.letter, a.at, p, h);
        break;
      }
      case 'centermark': {
        const rv = viewOf(a.view);
        if (rv) drawCenterMark(pl, paperOf3(rv, a.c), a.r * rv.scale);
        break;
      }
      case 'centerline': {
        const rv = viewOf(a.view);
        if (rv) {
          const p = paperOf3(rv, a.a), q = paperOf3(rv, a.b);
          const ex = mul(norm(sub(q, p)), 0.125 * IN);
          pl.line(sub(p, ex), add(q, ex), 'center', 'center');
        }
        break;
      }
      case 'bom': drawBom(pl, a.at, doc, part, std); break;
      case 'balloon': {
        const p = attachPoint(a.attach);
        const r = h * 1.25;
        pl.circle(a.at, r, 'thin', 'dims');
        pl.text(a.at, h, String(a.item), 'c', 'm', 'dims');
        if (p) { const d = norm(sub(p, a.at)); drawLeader(pl, add(a.at, mul(d, r)), p, st, 'dot'); }
        break;
      }
    }
  } catch (e) {
    warnings.push(`${a.kind} ${a.id}: ${(e as Error).message}`);
  }
  return pl.items;
}

/** ASME center mark: short cross at the centre plus extension lines past the circle. */
export function drawCenterMark(pl: PrimList, c: V2, r: number, clip?: { c: V2; r: number }) {
  const m = Math.min(1.5, r * 0.4), gap = 1.5, over = 3;
  const segs: [V2, V2][] = [[[c[0] - m, c[1]], [c[0] + m, c[1]]], [[c[0], c[1] - m], [c[0], c[1] + m]]];
  if (r > m + gap + 0.5) {
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]] as V2[]) segs.push([add(c, mul(d, m + gap)), add(c, mul(d, r + over))]);
  }
  for (const [a, b] of segs) {
    const pieces = clip ? clipToCircle({ k: 'line', a, b }, clip.c, clip.r) : [{ k: 'line', a, b } as Curve2];
    for (const p of pieces) pl.curve(p, 'thin', 'center');
  }
}

function primBounds(items: Prim[]): { min: V2; max: V2 } {
  const min: V2 = [Infinity, Infinity], max: V2 = [-Infinity, -Infinity];
  const addp = (p: V2) => { min[0] = Math.min(min[0], p[0]); min[1] = Math.min(min[1], p[1]); max[0] = Math.max(max[0], p[0]); max[1] = Math.max(max[1], p[1]); };
  for (const p of items) {
    if (p.t === 'curve') { const b = boundsOf([p.cv]); if (b) { addp(b.min); addp(b.max); } }
    else if (p.t === 'fill') p.pts.forEach(addp);
    else if (p.t === 'fillCircle') { addp(sub(p.c, [p.r, p.r])); addp(add(p.c, [p.r, p.r])); }
    else {
      const w = textWidth(p.s, p.h);
      const x0 = p.ax === 'l' ? 0 : p.ax === 'c' ? -w / 2 : -w;
      const y0 = p.ay === 'b' ? 0 : p.ay === 'm' ? -p.h / 2 : -p.h;
      const cr = Math.cos(p.rot ?? 0), sr = Math.sin(p.rot ?? 0);
      for (const [x, y] of [[x0, y0], [x0 + w, y0], [x0, y0 + p.h], [x0 + w, y0 + p.h]]) addp([p.p[0] + x * cr - y * sr, p.p[1] + x * sr + y * cr]);
    }
  }
  return { min, max };
}

/** Value text for a dimension annotation. */
export function dimDisplay(a: Extract<Annotation, { kind: 'dim' }>, valueMm: number, doc: DrawingDocument): DimText {
  const dec = a.decimals ?? (a.dimType === 'angle' ? doc.angleDecimals : doc.decimals);
  const count = a.count && a.count > 1 ? `${a.count}X ` : '';
  const lead = (a.prefix ?? '') + count + (a.dimType === 'diameter' ? 'Ø' : a.dimType === 'radius' ? 'R' : '');
  if (a.dimType === 'angle') return dimensionText(valueMm, dec, doc.units, a.tol, lead, '°', a.suffix ? ` ${a.suffix}` : '');
  return dimensionText(toUnits(valueMm, doc.units), dec, doc.units, a.tol, lead, '', a.suffix ? ` ${a.suffix}` : '');
}

/**
 * The two measured points of a two-reference linear dimension. A straight
 * edge paired with a point (or circle centre) measures to the foot of the
 * perpendicular, so the dimension follows the edge as the part changes.
 */
function pointPair(r1: DimRef, r2: DimRef, to2: (q: V3) => V2): [V2, V2] {
  const pt = (r: DimRef): V2 => to2(r.k === 'pt' ? r.p : r.k === 'circle' ? r.c : r.a);
  const foot = (p: V2, l: Extract<DimRef, { k: 'line' }>): V2 => {
    const a = to2(l.a), d = sub(to2(l.b), a);
    const L2 = dot(d, d);
    return L2 < 1e-18 ? a : add(a, mul(d, dot(sub(p, a), d) / L2));
  };
  if (r2.k === 'line' && r1.k !== 'line') { const p = pt(r1); return [p, foot(p, r2)]; }
  if (r1.k === 'line' && r2.k !== 'line') { const p = pt(r2); return [foot(p, r1), p]; }
  return [pt(r1), pt(r2)];
}

function drawDimension(pl: PrimList, a: Extract<Annotation, { kind: 'dim' }>, rv: ResolvedView, doc: DrawingDocument, part: CadDocument | null, model: ModelAnchors | null, sketches: Sketches, st: DimStyle, warnings: string[]) {
  let refs = a.refs;
  let ok = true;
  if (a.model) {
    const mg = part ? modelDimGeometry(part, a, sketches) : null;
    if (!mg) { ok = false; warnings.push(`Model dimension ${a.id} no longer matches the part`); }
    else refs = mg.refs;
  } else {
    const r = refs.map((x) => resolveRef(x, model));
    ok = r.every((x) => x.ok);
    refs = r.map((x) => x.ref);
    if (!ok && model) warnings.push(`Dimension ${a.id} lost its geometry (shown as dangling)`);
  }
  pl.warn = !ok;
  const T = add(rv.pos, a.at);
  if (a.dimType === 'diameter' || a.dimType === 'radius') {
    const c = refs[0];
    if (c?.k !== 'circle') return;
    const pc = paperOf3(rv, c.c);
    const r = c.r * rv.scale;
    const value = a.dimType === 'diameter' ? 2 * c.r : c.r;
    drawRadialDim(pl, pc, r, T, dimDisplay(a, value, doc), st);
    return;
  }
  if (a.dimType === 'angle') {
    const [l1, l2] = refs;
    if (l1?.k !== 'line' || l2?.k !== 'line') return;
    const s1: [V2, V2] = [paperOf3(rv, l1.a), paperOf3(rv, l1.b)];
    const s2: [V2, V2] = [paperOf3(rv, l2.a), paperOf3(rv, l2.b)];
    // Measure first to get the value, then draw.
    const probe = new PrimList();
    const ang = drawAngleDim(probe, s1, s2, T, { main: '' }, st);
    if (ang === null) return;
    drawAngleDim(pl, s1, s2, T, dimDisplay(a, (ang * 180) / Math.PI, doc), st);
    return;
  }
  // Linear: two points, or one line.
  let p1: V2, p2: V2;
  if (refs.length === 1 && refs[0].k === 'line') { p1 = paperOf3(rv, refs[0].a); p2 = paperOf3(rv, refs[0].b); }
  else if (refs.length >= 2) {
    [p1, p2] = pointPair(refs[0], refs[1], (q) => paperOf3(rv, q));
  } else return;
  const u: V2 = a.orient === 'h' ? [1, 0] : a.orient === 'v' ? [0, 1] : norm(sub(p2, p1));
  const valueMm = Math.abs(dot(sub(p2, p1), u)) / rv.scale;
  drawLinearDim(pl, p1, p2, T, u, dimDisplay(a, valueMm, doc), st);
}

/** Measured value (mm or degrees) of a dimension, for the property panel and tests. */
export function dimensionValue(a: Extract<Annotation, { kind: 'dim' }>, rv: ResolvedView, part: CadDocument | null, model: ModelAnchors | null, sketches?: Sketches): number | null {
  let refs = a.refs;
  if (a.model) { const mg = part ? modelDimGeometry(part, a, sketches) : null; if (!mg) return null; refs = mg.refs; }
  else refs = refs.map((x) => resolveRef(x, model).ref);
  if (a.dimType === 'diameter' || a.dimType === 'radius') { const c = refs[0]; return c?.k === 'circle' ? (a.dimType === 'diameter' ? 2 * c.r : c.r) : null; }
  if (a.dimType === 'angle') {
    const [l1, l2] = refs;
    if (l1?.k !== 'line' || l2?.k !== 'line') return null;
    const probe = new PrimList();
    const ang = drawAngleDim(probe, [paperOf3(rv, l1.a), paperOf3(rv, l1.b)], [paperOf3(rv, l2.a), paperOf3(rv, l2.b)], add(rv.pos, a.at), { main: '' }, { std: STANDARDS.ASME, h: 3 });
    return ang === null ? null : (ang * 180) / Math.PI;
  }
  let p1: V2, p2: V2;
  if (refs.length === 1 && refs[0].k === 'line') { p1 = project(refs[0].a, rv.frame); p2 = project(refs[0].b, rv.frame); }
  else if (refs.length >= 2) {
    [p1, p2] = pointPair(refs[0], refs[1], (q) => project(q, rv.frame));
  } else return null;
  const u: V2 = a.orient === 'h' ? [1, 0] : a.orient === 'v' ? [0, 1] : norm(sub(p2, p1));
  return Math.abs(dot(sub(p2, p1), u));
}

/** Bill of materials table; `at` is its lower-right corner. Single-part drawings list the part itself. */
function drawBom(pl: PrimList, at: V2, doc: DrawingDocument, part: CadDocument | null, std: StandardSpec) {
  const tb = doc.titleBlock;
  const h = std.text.dim * 0.9;
  const rh = h * 2.4;
  const header = ['ITEM NO.', 'PART NUMBER', 'DESCRIPTION', 'MATERIAL', 'QTY.'];
  const rows = [[ '1', tb.dwgNo || part?.name || '', tb.title || part?.name || '', part?.material?.name ?? tb.material ?? '', '1' ]];
  const widths = header.map((hd, i) => Math.max(textWidth(hd, h), ...rows.map((r) => textWidth(r[i], h))) + h * 2);
  const W = widths.reduce((a, b) => a + b, 0);
  const x0 = at[0] - W;
  let y = at[1] + rh * (rows.length + 1);
  for (const [ri, row] of [header, ...rows].entries()) {
    let x = x0;
    row.forEach((t, i) => {
      pl.rect(x, y - rh, x + widths[i], y, ri === 0 ? 'visible' : 'thin', 'notes');
      pl.text([i === 2 ? x + h : x + widths[i] / 2, y - rh / 2], h, t, i === 2 ? 'l' : 'c', 'm', 'notes', 0, ri === 0);
      x += widths[i];
    });
    y -= rh;
  }
}

/** Paper size of a sheet (mm). */
export function sheetDims(sheet: DrawingSheet): { w: number; h: number } { const s = sheetSize(sheet.size); return { w: s.w, h: s.h }; }

export { dimTextWidth, drawDimText, paperDirTo3d };
