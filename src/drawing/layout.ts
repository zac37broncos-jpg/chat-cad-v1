/**
 * Drawing creation helpers: Standard 3 View layout with automatic scale,
 * adding projected / section / detail / auxiliary views, and "Model Items"
 * (dimensions imported from the part's features).
 */
import type { CadDocument } from '../core/model';
import { isDimension } from '../core/model';
import { to3d, type SketchGeometry } from '../kernel/regen';
import type { ModelAnchors } from '../kernel/hlr';
import { add, mul, norm, sub, type V2, type V3 } from './geom2d';
import {
  dwgId, emptyDrawing, nextViewName, type Annotation, type DrawingDocument, type DrawingSheet, type DrawingView, type Ratio,
} from './model';
import { nextLetter, sheetSize, STANDARDS, type DraftStandard, type SheetSizeId } from './standards';
import { pickScale, project, scaleValue, STD_FRAMES, type StdOrientation, type ViewFrame, v3 } from './views';
import { modelDimGeometry, resolveViews, viewFrame, toPaper, type ResolvedView } from './compose';
import { sheetFormat } from './sheetFormat';

const IN = 25.4;

/** Half-extents of the model's bounding box projected into a frame (exact for the box, conservative for the part). */
export function projectedHalfExtents(m: Pick<ModelAnchors, 'bboxMin' | 'bboxMax'>, f: ViewFrame): V2 {
  const c: V3 = [0, 1, 2].map((k) => (m.bboxMin[k] + m.bboxMax[k]) / 2) as V3;
  let hx = 0, hy = 0;
  for (let i = 0; i < 8; i++) {
    const p: V3 = [i & 1 ? m.bboxMax[0] : m.bboxMin[0], i & 2 ? m.bboxMax[1] : m.bboxMin[1], i & 4 ? m.bboxMax[2] : m.bboxMin[2]];
    const q = project(v3.sub(p, c), f);
    hx = Math.max(hx, Math.abs(q[0])); hy = Math.max(hy, Math.abs(q[1]));
  }
  return [hx, hy];
}

function baseView(doc: DrawingDocument, extra: Partial<DrawingView>): Omit<DrawingView, 'kind'> {
  return { id: dwgId('view'), name: nextViewName(doc), position: [0, 0], hiddenLines: true, centerMarks: true, centerlines: true, ...extra } as any;
}

/**
 * New drawing with Front, Top, Right (third angle; first angle mirrors the
 * placement) and an isometric view, on the given sheet, at the largest
 * standard scale that fits.
 */
export function createStandardDrawing(part: CadDocument, model: Pick<ModelAnchors, 'bboxMin' | 'bboxMax'> | null, opts: { standard?: DraftStandard; size?: SheetSizeId; iso?: boolean } = {}): DrawingDocument {
  const standard = opts.standard ?? 'ASME';
  const doc = emptyDrawing(part.name, standard);
  if (opts.size) doc.sheets[0].size = opts.size;
  if (part.material) doc.titleBlock.material = part.material.name.toUpperCase();
  if (model) addStandardViews(doc, doc.sheets[0], model, opts.iso ?? true);
  return doc;
}

export function addStandardViews(doc: DrawingDocument, sheet: DrawingSheet, model: Pick<ModelAnchors, 'bboxMin' | 'bboxMax'>, iso = true) {
  const sz = sheetSize(sheet.size);
  const fmt = sheetFormat({ doc, sheet, sheetIndex: 0, sheetCount: 1, scaleText: '', weightText: '' });
  const area = fmt.drawArea;
  const titleTop = fmt.titleBox.max[1];
  const third = doc.projection === 'third';
  const ef = projectedHalfExtents(model, STD_FRAMES.front);
  const et = projectedHalfExtents(model, STD_FRAMES.top);
  const er = projectedHalfExtents(model, STD_FRAMES.right);
  const ei = projectedHalfExtents(model, STD_FRAMES.iso);
  // Layout grid: [front | right] over [top] (third angle: top above). Gaps leave room for dimensions.
  const gap = 1.0 * IN;
  const usableW = area.max[0] - area.min[0] - 2 * gap;
  const usableH = area.max[1] - Math.max(area.min[1], titleTop * 0 + area.min[1]) - 2 * gap;
  const needW = 2 * ef[0] + 2 * er[0] + (iso ? 0 : 0);
  const needH = 2 * ef[1] + 2 * et[1];
  const ratio = Math.min((usableW - gap) / Math.max(needW, 1e-9), (usableH - gap - (titleTop - area.min[1]) * 0.35) / Math.max(needH, 1e-9));
  const scale: Ratio = pickScale(ratio);
  sheet.scale = scale;
  const s = scaleValue(scale);
  // Front view: left part of the sheet; top above (third) or below (first); right view right (third) or left (first).
  const fw = ef[0] * s, fh = ef[1] * s, tw = et[1] * s, rw = er[0] * s;
  const left = area.min[0] + gap, bottom = Math.max(area.min[1] + gap, titleTop + gap * 0.25);
  const blockW = 2 * fw + gap + 2 * rw;
  const blockH = 2 * fh + gap + 2 * tw;
  const x0 = left + Math.max(0, (area.max[0] - area.min[0] - 2 * gap - blockW) / 2) * 0.5;
  const yAvail = area.max[1] - gap - bottom;
  const y0 = bottom + Math.max(0, (yAvail - blockH) / 2);
  const frontPos: V2 = third ? [x0 + fw, y0 + fh] : [x0 + 2 * rw + gap + fw, y0 + 2 * tw + gap + fh];
  const front: DrawingView = { ...baseView(doc, {}), kind: 'model', orientation: 'front', position: frontPos } as DrawingView;
  sheet.views.push(front);
  const top: DrawingView = { ...baseView(doc, {}), kind: 'projected', parent: front.id, dir: third ? [0, 1] : [0, -1], position: [frontPos[0], frontPos[1] + (third ? 1 : -1) * (fh + gap + tw)] } as DrawingView;
  sheet.views.push(top);
  const right: DrawingView = { ...baseView(doc, {}), kind: 'projected', parent: front.id, dir: third ? [1, 0] : [-1, 0], position: [frontPos[0] + (third ? 1 : -1) * (fw + gap + rw), frontPos[1]] } as DrawingView;
  sheet.views.push(right);
  if (iso) {
    const isoPos: V2 = [right.position[0], top.position[1]];
    const fitIso = Math.min(1, (Math.min(2 * rw + gap, sz.w) / Math.max(2 * ei[0] * s, 1e-9)));
    const isoScale = fitIso < 1 ? pickScale(s * fitIso) : undefined;
    sheet.views.push({ ...baseView(doc, { hiddenLines: false }), kind: 'model', orientation: 'iso', position: isoPos, ...(isoScale ? { scale: isoScale } : {}) } as DrawingView);
  }
}

/** Add a model (named) view at a paper position. */
export function addModelView(doc: DrawingDocument, sheet: DrawingSheet, orientation: StdOrientation, position: V2): DrawingView {
  const v = { ...baseView(doc, { hiddenLines: orientation !== 'iso' && orientation !== 'dimetric' && orientation !== 'trimetric' }), kind: 'model', orientation, position } as DrawingView;
  sheet.views.push(v);
  return v;
}

export function addProjectedView(doc: DrawingDocument, sheet: DrawingSheet, parent: string, dir: V2, position: V2): DrawingView {
  const v = { ...baseView(doc, {}), kind: 'projected', parent, dir, position } as DrawingView;
  sheet.views.push(v);
  return v;
}

function usedLetters(sheet: DrawingSheet, doc: DrawingDocument): string[] {
  const out: string[] = [];
  for (const s of doc.sheets) for (const v of s.views) if ('letter' in v) out.push(v.letter);
  for (const s of doc.sheets) for (const a of s.annotations) if (a.kind === 'datum') out.push(a.letter);
  void sheet;
  return out;
}

export function addSectionView(doc: DrawingDocument, sheet: DrawingSheet, parent: string, a: V2, b: V2, dir: V2, position: V2, span = false): DrawingView {
  const letter = nextLetter(usedLetters(sheet, doc), STANDARDS[doc.standard].excludedLetters);
  const v = { ...baseView(doc, { hiddenLines: false }), kind: 'section', parent, letter, a, b, dir: norm(dir), position, ...(span ? { span } : {}) } as DrawingView;
  sheet.views.push(v);
  return v;
}

export function addDetailView(doc: DrawingDocument, sheet: DrawingSheet, parent: string, center: V2, radius: number, scale: Ratio, position: V2): DrawingView {
  const letter = nextLetter(usedLetters(sheet, doc), STANDARDS[doc.standard].excludedLetters);
  // A detail shows the parent's region with the parent's display style (hidden lines on or off).
  const hiddenLines = sheet.views.find((x) => x.id === parent)?.hiddenLines ?? true;
  const v = { ...baseView(doc, { hiddenLines }), kind: 'detail', parent, letter, center, radius, scale, position } as DrawingView;
  sheet.views.push(v);
  return v;
}

export function addAuxiliaryView(doc: DrawingDocument, sheet: DrawingSheet, parent: string, edge: [V2, V2], dir: V2, position: V2): DrawingView {
  const letter = nextLetter(usedLetters(sheet, doc), STANDARDS[doc.standard].excludedLetters);
  const v = { ...baseView(doc, {}), kind: 'auxiliary', parent, letter, edge, dir: norm(dir), position } as DrawingView;
  sheet.views.push(v);
  return v;
}

/**
 * Model Items: dimensions from the part's sketches and extrudes, placed in
 * the view where each one is seen true size. Circles of equal size in one
 * sketch become a single "nX Ø" callout. Already-imported items are skipped.
 */
export function insertModelItems(doc: DrawingDocument, sheetIndex: number, part: CadDocument, model: ModelAnchors | null, sketches: SketchGeometry[]): Annotation[] {
  const sheet = doc.sheets[sheetIndex];
  const views = resolveViews(doc, sheet, model ? { model, views: [] } : null).filter((r) => r.view.kind !== 'detail' && r.view.kind !== 'section');
  const std = STANDARDS[doc.standard];
  const added: Annotation[] = [];
  const exists = (key: string) => sheet.annotations.some((a) => a.kind === 'dim' && a.model && linkKey(a.model) === key);
  const used = new Set(part.features.filter((f) => f.type === 'extrude' || f.type === 'revolve').map((f) => (f as any).sketch as string));
  const ortho = (rv: ResolvedView) => ['front', 'back', 'left', 'right', 'top', 'bottom'].some((k) => {
    const g = STD_FRAMES[k as StdOrientation];
    return v3.dot(g.z, rv.frame.z) > 1 - 1e-9;
  });
  const trueView = (n: V3) => views.find((rv) => ortho(rv) && Math.abs(v3.dot(rv.frame.z, n)) > 1 - 1e-9);
  const sideView = (n: V3) => views.find((rv) => ortho(rv) && Math.abs(v3.dot(rv.frame.z, n)) < 1e-9);
  // Per-view stacking offsets so dimensions do not overlap: [below, left, right, above].
  const stack = new Map<string, number[]>();
  const nextOffset = (rv: ResolvedView, side: number) => {
    const s = stack.get(rv.view.id) ?? [0, 0, 0, 0];
    const o = std.dimOffset.first + s[side] * std.dimOffset.next;
    s[side]++; stack.set(rv.view.id, s);
    return o;
  };
  const halfExt = (rv: ResolvedView): V2 => (model ? projectedHalfExtents(model, rv.frame).map((x) => x * rv.scale) as V2 : [20, 20]);

  for (const f of part.features) {
    if (f.type !== 'sketch' || !used.has(f.id) || f.suppressed) continue;
    const ev = sketches.find((s) => s.id === f.id);
    if (!ev) continue;
    const rv = trueView(ev.frame.n);
    if (!rv) continue;
    // Sketches with their own dimensions (from the sketcher): import exactly those, like mainstream CAD Model Items.
    const sdims = (f.constraints ?? []).filter(isDimension);
    if (sdims.length) {
      for (const c of sdims) {
        const key = `sketchDim:${f.id}:${c.id}`;
        if (exists(key) || c.type === 'offset') continue;
        const ann: Extract<Annotation, { kind: 'dim' }> = { id: dwgId('dim'), kind: 'dim', view: rv.view.id, dimType: c.type === 'diameter' ? 'diameter' : c.type === 'radius' ? 'radius' : c.type === 'angle' ? 'angle' : 'linear', orient: 'aligned', refs: [], at: [0, 0], tol: { type: 'none' }, model: { kind: 'sketchDim', sketch: f.id, constraint: c.id } };
        const mg = modelDimGeometry(part, ann, sketches);
        if (!mg) continue;
        const he = halfExt(rv);
        if (ann.dimType === 'diameter' || ann.dimType === 'radius') {
          const r0 = mg.refs[0] as Extract<typeof mg.refs[number], { k: 'circle' }>;
          const pc = toPaper(rv, project(r0.c, rv.frame));
          ann.at = sub(add(pc, mul([1, 1], r0.r * rv.scale * Math.SQRT1_2 + 0.5 * IN)), rv.pos);
        } else if (ann.dimType === 'angle') {
          const l = mg.refs[0] as Extract<typeof mg.refs[number], { k: 'line' }>;
          ann.at = sub(add(toPaper(rv, project(l.a, rv.frame)), [0.6 * IN, 0.4 * IN]), rv.pos);
        } else {
          const [p1, p2] = mg.refs.map((r) => toPaper(rv, project((r as any).p, rv.frame)));
          // Sketch horizontal/vertical maps to the paper direction of the sketch's x / y axis in this view.
          const xs = project(ev.frame.x, rv.frame);
          const sketchXIsPaperX = Math.abs(xs[0]) > 0.5;
          let orient: 'h' | 'v' | 'aligned' = 'aligned';
          if (mg.sketchDir) orient = (mg.sketchDir === 'h') === sketchXIsPaperX ? 'h' : 'v';
          else if (Math.abs(p1[1] - p2[1]) < 1e-6) orient = 'h';
          else if (Math.abs(p1[0] - p2[0]) < 1e-6) orient = 'v';
          ann.orient = orient;
          const mid = mul(add(p1, p2), 0.5);
          ann.at = sub(orient === 'h' ? [mid[0], rv.pos[1] - he[1] - nextOffset(rv, 0)] : orient === 'v' ? [rv.pos[0] - he[0] - nextOffset(rv, 1), mid[1]] : add(mid, mul(norm([-(p2[1] - p1[1]), p2[0] - p1[0]]), std.dimOffset.first)), rv.pos);
        }
        added.push(ann);
      }
      continue;
    }
    // Circles grouped by radius.
    const groups = new Map<string, string[]>();
    for (const e of ev.entities) if (e.kind === 'circle' && !e.construction) { const k = e.r.toFixed(9); groups.set(k, [...(groups.get(k) ?? []), e.id]); }
    for (const ids of groups.values()) {
      const key = `circle:${f.id}:${ids.join(',')}`;
      if (exists(key)) continue;
      const e = ev.entities.find((x) => x.id === ids[0]) as Extract<typeof ev.entities[number], { kind: 'circle' }>;
      const c3 = to3d(ev.frame, e.c[0], e.c[1]);
      const pc = toPaper(rv, project(c3, rv.frame));
      const r = e.r * rv.scale;
      const T = add(pc, mul([1, 1], r * Math.SQRT1_2 + 0.5 * IN));
      added.push({ id: dwgId('dim'), kind: 'dim', view: rv.view.id, dimType: 'diameter', orient: 'aligned', refs: [], at: sub(T, rv.pos), tol: { type: 'none' }, count: ids.length, suffix: undefined, model: { kind: 'circle', sketch: f.id, entities: ids } });
    }
    for (const e of ev.entities) {
      if (e.construction) continue;
      if (e.kind === 'arc') {
        const key = `arc:${f.id}:${e.id}`;
        if (exists(key)) continue;
        const pc = toPaper(rv, project(to3d(ev.frame, e.c[0], e.c[1]), rv.frame));
        const mid = (e.a0 + e.a1) / 2;
        const d: V2 = [Math.cos(mid), Math.sin(mid)];
        const T = add(pc, mul(d, e.r * rv.scale + 0.5 * IN));
        added.push({ id: dwgId('dim'), kind: 'dim', view: rv.view.id, dimType: 'radius', orient: 'aligned', refs: [], at: sub(T, rv.pos), tol: { type: 'none' }, model: { kind: 'arc', sketch: f.id, entity: e.id } });
      }
    }
    // Lines: one dimension per distinct (direction, length) in the sketch; placed outside the view.
    const seen: { d: V2; l: number }[] = [];
    for (const e of ev.entities) {
      if (e.kind !== 'line' || e.construction) continue;
      const a3 = to3d(ev.frame, e.a[0], e.a[1]), b3 = to3d(ev.frame, e.b[0], e.b[1]);
      const pa = project(a3, rv.frame), pb = project(b3, rv.frame);
      const dv = sub(pb, pa); const l = Math.hypot(dv[0], dv[1]);
      if (l < 1e-9) continue;
      const d = norm(dv);
      if (seen.some((s) => Math.abs(Math.abs(s.d[0] * d[0] + s.d[1] * d[1]) - 1) < 1e-9 && Math.abs(s.l - l) < 1e-6)) continue;
      seen.push({ d, l });
      const key = `line:${f.id}:${e.id}`;
      if (exists(key)) continue;
      const horiz = Math.abs(d[1]) < 1e-9, vert = Math.abs(d[0]) < 1e-9;
      const he = halfExt(rv);
      const pa_ = toPaper(rv, pa), pb_ = toPaper(rv, pb);
      let T: V2, orient: 'h' | 'v' | 'aligned';
      if (horiz) { orient = 'h'; T = [(pa_[0] + pb_[0]) / 2, rv.pos[1] - he[1] - nextOffset(rv, 0)]; }
      else if (vert) { orient = 'v'; T = [rv.pos[0] - he[0] - nextOffset(rv, 1), (pa_[1] + pb_[1]) / 2]; }
      else { orient = 'aligned'; const m = mul(add(pa_, pb_), 0.5); const n: V2 = [-d[1], d[0]]; T = add(m, mul(n, std.dimOffset.first)); }
      added.push({ id: dwgId('dim'), kind: 'dim', view: rv.view.id, dimType: 'linear', orient, refs: [], at: sub(T, rv.pos), tol: { type: 'none' }, model: { kind: 'line', sketch: f.id, entity: e.id } });
    }
  }
  // Extrude depths in a view where the extrusion direction lies in the paper plane.
  for (const f of part.features) {
    if (f.type !== 'extrude' || f.suppressed || f.throughAll) continue;
    const key = `depth:${f.id}`;
    if (exists(key)) continue;
    const ev = sketches.find((s) => s.id === f.sketch);
    if (!ev) continue;
    const rv = sideView(ev.frame.n);
    if (!rv) continue;
    const dirPaper = project(ev.frame.n, rv.frame);
    const he = halfExt(rv);
    const vert = Math.abs(dirPaper[0]) < 1e-9;
    const T: V2 = vert ? [rv.pos[0] + he[0] + nextOffset(rv, 2), rv.pos[1]] : [rv.pos[0], rv.pos[1] + he[1] + nextOffset(rv, 3)];
    added.push({ id: dwgId('dim'), kind: 'dim', view: rv.view.id, dimType: 'linear', orient: vert ? 'v' : 'h', refs: [], at: sub(T, rv.pos), tol: { type: 'none' }, model: { kind: 'depth', feature: f.id } });
  }
  sheet.annotations.push(...added);
  void viewFrame;
  return added;
}

export function linkKey(l: NonNullable<Extract<Annotation, { kind: 'dim' }>['model']>): string {
  switch (l.kind) {
    case 'circle': return `circle:${l.sketch}:${l.entities.join(',')}`;
    case 'arc': return `arc:${l.sketch}:${l.entity}`;
    case 'line': return `line:${l.sketch}:${l.entity}`;
    case 'depth': return `depth:${l.feature}`;
    case 'sketchDim': return `sketchDim:${l.sketch}:${l.constraint}`;
  }
}

/** Default BOM position: just above the title block's right end. */
export function defaultBomAnchor(doc: DrawingDocument, sheetIndex: number): V2 {
  const sheet = doc.sheets[sheetIndex];
  const f = sheetFormat({ doc, sheet, sheetIndex, sheetCount: doc.sheets.length, scaleText: '', weightText: '' });
  return [f.titleBox.max[0], f.titleBox.max[1] + 2];
}
