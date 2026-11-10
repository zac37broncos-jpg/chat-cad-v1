/**
 * Drawing workspace: the 2D drawing environment (conventional CAD-style).
 *
 * Mount it with the part's DocumentStore and the geometry KernelClient:
 *
 *   <DrawingWorkspace store={store} kernel={kernel} onClose={() => setTab('part')} />
 *
 * The drawing stays associative: whenever the part changes, the views are
 * recomputed from the exact B-rep by hidden-line removal in the geometry
 * worker, and model dimensions re-read the part's features. Editing a model
 * dimension (double-click) changes the part.
 *
 * Optional controlled mode: pass `drawing` and `onDrawingChange` to own the
 * drawing document yourself (e.g. to save it inside a project file). Without
 * them the workspace autosaves to localStorage per part name.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DocumentStore } from '../../core/store';
import type { CadDocument } from '../../core/model';
import type { KernelClient } from '../../kernel/client';
import type { DrawingGeometryResponse } from '../../kernel/hlr';
import type { SketchGeometry } from '../../kernel/regen';
import { add, dist, dot, mul, norm, perp, sub, type V2 } from '../../drawing/geom2d';
import {
  dependents, dwgId, type Annotation, type Attach, type DimRef, type DrawingDocument, type DrawingSheet, type DrawingView, type FcfRow, type Ratio, type TitleBlock, type TolType,
} from '../../drawing/model';
import {
  annotationPrims, composeSheet, dimensionValue, fromPaper, lineLengthParam, modelDimGeometry, viewFrame, viewRequests, type ComposeResult, type ResolvedView,
} from '../../drawing/compose';
import {
  addAuxiliaryView, addDetailView, addModelView, addProjectedView, addSectionView, addStandardViews, createStandardDrawing, defaultBomAnchor, insertModelItems, projectedHalfExtents,
} from '../../drawing/layout';
import { nextLetter, SHEET_SIZES, sheetSize, STANDARDS, type DraftStandard, type SheetSizeId } from '../../drawing/standards';
import { ORIENTATION_LABEL, pickScale, scaleLabel, scaleValue, snapOrtho, STD_SCALES, type StdOrientation } from '../../drawing/views';
import { PrimList, type Prim } from '../../drawing/prims';
import { buildPdf } from '../../drawing/export/pdf';
import { buildDxf } from '../../drawing/export/dxf';
import { sheetSvg } from '../../drawing/export/svg';
import { formatNumber, toUnits } from '../../drawing/format';
import { symbolsFor } from '../../drawing/gdt';
import { DrawingCanvas, type CanvasHandle, type CanvasPointer } from './DrawingCanvas';
import { findSnap, pickOwner, viewAt, type SnapHit } from './picking';
import './drawing.css';

export interface DrawingWorkspaceProps {
  store: DocumentStore;
  kernel: KernelClient;
  drawing?: DrawingDocument | null;
  onDrawingChange?: (d: DrawingDocument) => void;
  /** Shows a "Back to part" button. */
  onClose?: () => void;
}

type Tool =
  | { k: 'select' }
  | { k: 'modelview'; orientation: StdOrientation }
  | { k: 'projected'; parent?: string }
  | { k: 'section'; mode: 'h' | 'v' | 'free'; parent?: string; a?: V2; b?: V2 }
  | { k: 'detail'; parent?: string; center?: V2; radius?: number }
  | { k: 'aux'; parent?: string; edge?: [V2, V2] }
  | { k: 'dim'; picks: SnapHit[] }
  | { k: 'note'; leader?: Attach }
  | { k: 'gdt'; leader?: Attach }
  | { k: 'datum'; attach?: Attach }
  | { k: 'balloon'; attach?: Attach }
  | { k: 'centermark' }
  | { k: 'centerline'; first?: SnapHit };

const TOOL_HINT: Record<Tool['k'], string> = {
  select: 'Click to select; drag views and annotations to move them. Double-click a dimension, note or title block cell to edit.',
  modelview: 'Click on the sheet to place the view.',
  projected: 'Click a parent view, then move the mouse to a side and click to place.',
  section: 'Click a view, then click the cutting line point(s), then click to place the section view.',
  detail: 'Click the centre of the detail circle, click again to set its size, then place the view.',
  aux: 'Click a straight edge in a view, then click to place the auxiliary view.',
  dim: 'Dimension: click an edge, circle, or two points, then click to place. Esc to stop.',
  note: 'Click geometry for a leader (optional), then click to place the note.',
  gdt: 'Click geometry for the leader (optional), then click to place the feature control frame.',
  datum: 'Click the datum feature (edge or point), then click to place the datum symbol.',
  balloon: 'Click the part, then click to place the balloon.',
  centermark: 'Click a hole or circular edge seen end-on to add a center mark.',
  centerline: 'Click two points or edges for a centerline.',
};

const autosaveKey = (partName: string) => `chatcad.drawing.v1:${partName}`;

function loadAutosave(partName: string): DrawingDocument | null {
  try { const s = localStorage.getItem(autosaveKey(partName)); return s ? JSON.parse(s) : null; } catch { return null; }
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._ -]+/g, '_').trim() || 'drawing';

function refOfHit(h: SnapHit): DimRef { return h.snap.ref; }
function attachOfHit(h: SnapHit | null, p: V2): Attach {
  if (!h) return { paper: p };
  if (h.kind === 'edge') {
    // Point on the 3D edge nearest to the click (by its parameter along the projected edge).
    const s = h.snap;
    const d = sub(s.b, s.a); const L2 = dot(d, d) || 1;
    const t = Math.max(0, Math.min(1, dot(sub(p, s.a), d) / L2));
    const a = s.ref.a, b = s.ref.b;
    return { view: s.view, p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] };
  }
  if (h.kind === 'circle') {
    // Point on the circle under the cursor: centre + r * (direction in view) mapped back is not unique in 3D; attach to the paper point instead.
    return { paper: h.p };
  }
  const r = h.snap.ref;
  return { view: h.snap.view, p: r.k === 'pt' ? r.p : r.c };
}

export function DrawingWorkspace(props: DrawingWorkspaceProps) {
  const { store, kernel } = props;
  const part = useSyncExternalStore((cb) => store.subscribe(cb), () => store.state);
  const [doc, setDocState] = useState<DrawingDocument | null>(() => props.drawing ?? loadAutosave(part.name));
  const docRef = useRef(doc); docRef.current = doc;
  const history = useRef<{ undo: DrawingDocument[]; redo: DrawingDocument[] }>({ undo: [], redo: [] });
  const [sheetIndex, setSheetIndex] = useState(0);
  const [geometry, setGeometry] = useState<(DrawingGeometryResponse & { volume: number | null; sketches: SketchGeometry[] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [kernelError, setKernelError] = useState('');
  const [selection, setSelection] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>({ k: 'select' });
  const lastTool = useRef<Tool>({ k: 'dim', picks: [] });
  const [tab, setTab] = useState<'layout' | 'annotation' | 'sheet' | 'export'>('layout');
  const [mouse, setMouse] = useState<V2>([0, 0]);
  const [pxPerMm, setPxPerMm] = useState(2);
  const [message, setMessage] = useState('');
  const [fcfDraft, setFcfDraft] = useState<FcfRow>({ sym: 'position', dia: true, tol: '.010', mod: 'M', datums: [{ letter: 'A', mod: '' }, { letter: 'B', mod: '' }, { letter: 'C', mod: '' }] });
  const [noteDraft, setNoteDraft] = useState('NOTES:\n1. BREAK ALL SHARP EDGES.');
  const [editField, setEditField] = useState<keyof TitleBlock | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const canvas = useRef<CanvasHandle>(null);
  const drag = useRef<{ id: string; kind: 'view' | 'ann'; start: V2; orig: DrawingDocument; moved: boolean } | null>(null);

  // Adopt an externally supplied drawing (controlled mode).
  useEffect(() => { if (props.drawing && props.drawing !== docRef.current) setDocState(props.drawing); }, [props.drawing]);
  // Let the host app know a drawing has the keyboard (like the sketcher's data-sketch-mode contract).
  useEffect(() => { document.body.dataset.drawingMode = 'on'; return () => { delete document.body.dataset.drawingMode; }; }, []);

  const commit = useCallback((next: DrawingDocument, opts: { undoable?: boolean; from?: DrawingDocument } = {}) => {
    const prev = opts.from ?? docRef.current;
    if (opts.undoable !== false && prev) { history.current.undo.push(prev); if (history.current.undo.length > 200) history.current.undo.shift(); history.current.redo = []; }
    setDocState(next);
    docRef.current = next;
    props.onDrawingChange?.(next);
    if (!props.onDrawingChange) { try { localStorage.setItem(autosaveKey(next.partName), JSON.stringify(next)); } catch { /* storage full or blocked */ } }
  }, [props.onDrawingChange]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Apply a mutation to a copy of the drawing. */
  const mutate = useCallback((fn: (d: DrawingDocument, sheet: DrawingSheet) => void) => {
    const cur = docRef.current;
    if (!cur) return;
    const next = clone(cur);
    fn(next, next.sheets[Math.min(sheetIndex, next.sheets.length - 1)]);
    commit(next);
  }, [commit, sheetIndex]);

  const undo = () => { const h = history.current; const p = h.undo.pop(); if (p && docRef.current) { h.redo.push(docRef.current); commit(p, { undoable: false }); } };
  const redo = () => { const h = history.current; const n = h.redo.pop(); if (n && docRef.current) { h.undo.push(docRef.current); commit(n, { undoable: false }); } };

  const sheet = doc ? doc.sheets[Math.min(sheetIndex, doc.sheets.length - 1)] : null;
  const std = STANDARDS[doc?.standard ?? 'ASME'];

  // ---- geometry: recompute views from the exact B-rep whenever the part or the view set changes (latest wins)
  const requests = useMemo(() => (doc && sheet ? viewRequests(doc, sheet) : []), [doc, sheet]);
  const reqKey = useMemo(() => JSON.stringify(requests), [requests]);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      kernel.call({ op: 'drawing', doc: part, views: requests }).then((g) => {
        if (my !== seq.current) return;
        setGeometry(g); setKernelError('');
      }).catch((e) => { if (my === seq.current) setKernelError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (my === seq.current) setBusy(false); });
    }, 60);
    return () => clearTimeout(t);
  }, [part, reqKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const res: ComposeResult | null = useMemo(() => (doc ? composeSheet({ doc, sheetIndex: Math.min(sheetIndex, doc.sheets.length - 1), part, geometry, volume: geometry?.volume }) : null), [doc, sheetIndex, part, geometry]);
  const tol = 7 / pxPerMm; // 7 px pick tolerance

  // ---- keyboard (capture phase so the 3D app's shortcuts do not fire while drawing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      let handled = true;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') { setTool({ k: 'select' }); setMessage(''); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selection) deleteSelected();
      else if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) undo();
      else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) redo();
      else if (k === 'f' && !e.ctrlKey && !e.metaKey) canvas.current?.fit();
      else if (k === 'd' && !e.ctrlKey && !e.metaKey) startTool({ k: 'dim', picks: [] });
      else if (e.key === 'Enter' && tool.k === 'select') startTool(clone(lastTool.current));
      else handled = false;
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const startTool = (t: Tool) => { if (t.k !== 'select') lastTool.current = t; setTool(t); setMessage(''); };

  const deleteSelected = () => {
    if (!selection || !sheet) return;
    mutate((_d, s) => {
      const isView = s.views.some((v) => v.id === selection);
      if (isView) {
        const gone = new Set([selection, ...dependents(s, selection)]);
        s.views = s.views.filter((v) => !gone.has(v.id));
        s.annotations = s.annotations.filter((a) => !('view' in a && gone.has((a as any).view)) && !('leader' in a && a.leader && 'view' in a.leader && gone.has(a.leader.view)) && !('attach' in a && 'view' in a.attach && gone.has(a.attach.view)));
      } else s.annotations = s.annotations.filter((a) => a.id !== selection);
    });
    setSelection(null);
  };

  // ---- creating a drawing
  const [newStd, setNewStd] = useState<DraftStandard>('ASME');
  const [newSize, setNewSize] = useState<SheetSizeId>('B');
  const [newIso, setNewIso] = useState(true);
  const [newModelItems, setNewModelItems] = useState(true);
  const createDrawing = async () => {
    try {
      setBusy(true);
      const g = await kernel.call({ op: 'drawing', doc: part, views: [] });
      if (!g.model) { setMessage('The part has no solid yet. Build the part first, then make the drawing.'); return; }
      const d = createStandardDrawing(part, g.model, { standard: newStd, size: newSize, iso: newIso });
      if (newModelItems) insertModelItems(d, 0, part, g.model, g.sketches);
      history.current = { undo: [], redo: [] };
      commit(d, { undoable: false });
      setSheetIndex(0);
      setTimeout(() => canvas.current?.fit(), 50);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  // ---- pointer handling
  const rvOf = (id: string | undefined) => res?.views.find((v) => v.view.id === id);
  const placementPreview = (): Prim[] => {
    if (!res || !doc || !sheet || !geometry?.model) return [];
    const pl = new PrimList('preview');
    const box = (center: V2, half: V2) => pl.rect(center[0] - half[0], center[1] - half[1], center[0] + half[0], center[1] + half[1], 'thin', 'notes');
    const s = scaleValue(sheet.scale);
    if (tool.k === 'modelview') {
      const tmp = clone(doc); const ts = tmp.sheets[sheetIndex];
      const v = addModelView(tmp, ts, tool.orientation, mouse);
      const f = viewFrame(tmp, ts, v.id);
      box(mouse, mul(projectedHalfExtents(geometry.model, f), s));
    } else if (tool.k === 'projected' && tool.parent) {
      const pr = rvOf(tool.parent); if (!pr) return [];
      const d = snapOrtho(sub(mouse, pr.pos));
      const tmp = clone(doc); const ts = tmp.sheets[sheetIndex];
      const pos = add(pr.pos, mul(d, dot(sub(mouse, pr.pos), d)));
      const v = addProjectedView(tmp, ts, tool.parent, d, pos);
      box(pos, mul(projectedHalfExtents(geometry.model, viewFrame(tmp, ts, v.id)), pr.scale));
    } else if (tool.k === 'section' && tool.parent) {
      const pr = rvOf(tool.parent); if (!pr) return [];
      const ends = sectionEnds(pr, tool, fromPaper(pr, mouse));
      if (ends) {
        const [a, b] = ends.map((q) => [pr.pos[0] + (q[0] - pr.pivot[0]) * pr.scale, pr.pos[1] + (q[1] - pr.pivot[1]) * pr.scale] as V2);
        pl.line(a, b, 'cutting', 'center');
        if (ends.ready) {
          const n = norm(perp(sub(b, a)));
          const side = Math.sign(dot(sub(mouse, mul(add(a, b), 0.5)), n)) || 1;
          const d = mul(n, side);
          const pos = add(pr.pos, mul(d, dot(sub(mouse, pr.pos), d)));
          const tmp = clone(doc); const ts = tmp.sheets[sheetIndex];
          const v = addSectionView(tmp, ts, tool.parent, ends[0], ends[1], d, pos);
          box(pos, mul(projectedHalfExtents(geometry.model, viewFrame(tmp, ts, v.id)), pr.scale));
        }
      }
    } else if (tool.k === 'detail' && tool.parent && tool.center) {
      const pr = rvOf(tool.parent); if (!pr) return [];
      const c = add(pr.pos, mul(sub(tool.center, pr.pivot), pr.scale));
      const r = tool.radius !== undefined ? tool.radius * pr.scale : dist(mouse, c);
      pl.circle(c, Math.max(r, 0.5), 'phantom', 'center');
      if (tool.radius !== undefined) { const ds = detailScale(pr); pl.circle(mouse, tool.radius * scaleValue(ds), 'thin', 'notes'); }
    } else if (tool.k === 'aux' && tool.parent && tool.edge) {
      const pr = rvOf(tool.parent); if (!pr) return [];
      const [ea, eb] = tool.edge;
      const n = norm(perp(sub(eb, ea)));
      const m = add(pr.pos, mul(sub(mul(add(ea, eb), 0.5), pr.pivot), pr.scale));
      const side = Math.sign(dot(sub(mouse, m), n)) || 1;
      const d = mul(n, side);
      const pos = add(pr.pos, mul(d, dot(sub(mouse, pr.pos), d)));
      const tmp = clone(doc); const ts = tmp.sheets[sheetIndex];
      const v = addAuxiliaryView(tmp, ts, tool.parent, tool.edge, d, pos);
      box(pos, mul(projectedHalfExtents(geometry.model, viewFrame(tmp, ts, v.id)), pr.scale));
    } else if (tool.k === 'dim' && tool.picks.length) {
      const a = dimFromPicks(tool.picks, mouse, true);
      if (a) return annotationPrims(a, { doc, part, model: geometry.model, sketches: geometry.sketches, views: res.views, std, warnings: [] });
    } else if ((tool.k === 'note' || tool.k === 'gdt' || tool.k === 'datum' || tool.k === 'balloon')) {
      const a = annotationAt(mouse, true);
      if (a) return annotationPrims(a, { doc, part, model: geometry.model, sketches: geometry.sketches, views: res.views, std, warnings: [] });
    }
    // Snap marker
    if (['dim', 'section', 'detail', 'aux', 'note', 'gdt', 'datum', 'balloon', 'centermark', 'centerline'].includes(tool.k)) {
      const h = findSnap(res, mouse, tol);
      if (h) { if (h.kind === 'edge') pl.line(h.snap.a, h.snap.b, 'visible', 'notes'); else pl.circle(h.p, 1.2 / Math.max(pxPerMm / 3, 0.3), 'thin', 'notes'); }
    }
    return pl.items;
  };

  /** Cutting line ends (parent view coords) for the section tool, given the current cursor in view coords. */
  function sectionEnds(pr: ResolvedView, t: Extract<Tool, { k: 'section' }>, cur: V2): ([V2, V2] & { ready?: boolean }) | null {
    const b = pr.box;
    const lo = fromPaper(pr, [b.min[0], b.min[1]]), hi = fromPaper(pr, [b.max[0], b.max[1]]);
    const m = 0.15 * 25.4 / pr.scale;
    const snapPt = (q: V2) => { const h = res ? findSnap(res, add(pr.pos, mul(sub(q, pr.pivot), pr.scale)), tol, pr.view.id) : null; return h && h.kind !== 'edge' ? fromPaper(pr, h.p) : q; };
    if (t.mode === 'h' || t.mode === 'v') {
      const q = t.a ?? snapPt(cur);
      const out = (t.mode === 'h' ? [[lo[0] - m, q[1]], [hi[0] + m, q[1]]] : [[q[0], lo[1] - m], [q[0], hi[1] + m]]) as [V2, V2] & { ready?: boolean };
      out.ready = !!t.a;
      return out;
    }
    if (!t.a) return null;
    const bq = t.b ?? snapPt(cur);
    const out = [t.a, bq] as [V2, V2] & { ready?: boolean };
    out.ready = !!t.b;
    return out;
  }

  function detailScale(pr: ResolvedView): Ratio {
    const target = pr.scale * 2;
    const up = [...STD_SCALES].reverse().find((s) => scaleValue(s) >= target - 1e-9);
    return up ?? pickScale(target);
  }

  /** Build a dimension annotation from picks and a placement point. */
  function dimFromPicks(picks: SnapHit[], T: V2, preview = false): Extract<Annotation, { kind: 'dim' }> | null {
    const first = picks[0];
    const rv = rvOf(first.snap.view);
    if (!rv) return null;
    const at = sub(T, rv.pos);
    const base = { id: preview ? 'preview' : dwgId('dim'), kind: 'dim' as const, view: rv.view.id, at, tol: { type: 'none' as TolType } };
    if (picks.length === 1 && first.kind === 'circle') {
      return { ...base, dimType: first.snap.full ? 'diameter' : 'radius', orient: 'aligned', refs: [first.snap.ref] };
    }
    const orientFor = (p1: V2, p2: V2): 'h' | 'v' | 'aligned' => {
      const inX = T[0] >= Math.min(p1[0], p2[0]) && T[0] <= Math.max(p1[0], p2[0]);
      const inY = T[1] >= Math.min(p1[1], p2[1]) && T[1] <= Math.max(p1[1], p2[1]);
      if (Math.abs(p1[1] - p2[1]) < 1e-6) return 'h';
      if (Math.abs(p1[0] - p2[0]) < 1e-6) return 'v';
      if (inX && !inY) return 'h';
      if (inY && !inX) return 'v';
      if (!inX && !inY) {
        const ex = Math.min(Math.abs(T[0] - p1[0]), Math.abs(T[0] - p2[0])), ey = Math.min(Math.abs(T[1] - p1[1]), Math.abs(T[1] - p2[1]));
        return ey > ex ? 'h' : 'v';
      }
      return 'aligned';
    };
    if (picks.length === 1 && first.kind === 'edge') {
      return { ...base, dimType: 'linear', orient: orientFor(first.snap.a, first.snap.b), refs: [first.snap.ref] };
    }
    if (picks.length === 2) {
      const [p, q] = picks;
      if (p.kind === 'edge' && q.kind === 'edge') {
        const d1 = norm(sub(p.snap.b, p.snap.a)), d2 = norm(sub(q.snap.b, q.snap.a));
        if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) > 1e-6) return { ...base, dimType: 'angle', orient: 'aligned', refs: [p.snap.ref, q.snap.ref] };
        // Parallel edges: distance between them, measured perpendicular (axis-aligned edges only).
        const ra = p.snap.ref, rb = q.snap.ref;
        const o: 'h' | 'v' = Math.abs(d1[1]) < 1e-6 ? 'v' : 'h';
        return { ...base, dimType: 'linear', orient: o, refs: [{ k: 'pt', p: ra.a }, { k: 'pt', p: rb.a }] };
      }
      // Point (or circle centre) to a straight edge: the perpendicular distance.
      if ((p.kind === 'edge') !== (q.kind === 'edge')) {
        const e = (p.kind === 'edge' ? p : q) as Extract<SnapHit, { kind: 'edge' }>;
        const o = p.kind === 'edge' ? q : p;
        const d = sub(e.snap.b, e.snap.a); const L = Math.hypot(d[0], d[1]) || 1;
        const ro = refOfHit(o);
        const orient = Math.abs(d[0]) < 1e-6 * L ? 'h' : Math.abs(d[1]) < 1e-6 * L ? 'v' : 'aligned';
        return { ...base, dimType: 'linear', orient, refs: [ro.k === 'line' ? { k: 'pt', p: ro.a } : ro, e.snap.ref] };
      }
      const pt = (h: SnapHit): [DimRef, V2] => [refOfHit(h), h.kind === 'edge' ? h.snap.a : h.kind === 'circle' ? h.snap.p : h.p];
      const [r1, p1] = pt(p), [r2, p2] = pt(q);
      return { ...base, dimType: 'linear', orient: orientFor(p1, p2), refs: [r1.k === 'line' ? { k: 'pt', p: r1.a } : r1, r2.k === 'line' ? { k: 'pt', p: r2.a } : r2] };
    }
    return null;
  }

  /** Annotation for the note / GD&T / datum / balloon tools at placement point T. */
  function annotationAt(T: V2, preview = false): Annotation | null {
    if (!doc || !sheet) return null;
    const id = preview ? 'preview' : dwgId('ann');
    switch (tool.k) {
      case 'note': return { id, kind: 'note', text: noteDraft || 'NOTE', at: T, leader: tool.leader };
      case 'gdt': return { id, kind: 'fcf', rows: [{ ...fcfDraft, datums: fcfDraft.datums.filter((d) => d.letter.trim()) }], at: T, leader: tool.leader };
      case 'datum': {
        if (!tool.attach) return null;
        const used = sheet.annotations.filter((a) => a.kind === 'datum').map((a) => (a as any).letter);
        return { id, kind: 'datum', letter: nextLetter(used, std.excludedLetters), at: T, attach: tool.attach };
      }
      case 'balloon': if (!tool.attach) return null; return { id, kind: 'balloon', item: 1, at: T, attach: tool.attach };
    }
    return null;
  }

  const onDown = (e: CanvasPointer) => {
    if (!res || !doc || !sheet || e.button !== 0) return;
    const p = e.p;
    const hit = findSnap(res, p, tol);
    switch (tool.k) {
      case 'select': {
        const id = pickOwner(res, p, tol);
        setSelection(id);
        setEditField(null);
        if (id) {
          const isView = sheet.views.some((v) => v.id === id);
          drag.current = { id, kind: isView ? 'view' : 'ann', start: p, orig: doc, moved: false };
        }
        // Title block field under the cursor (double-click edits it).
        if (!id) { const f = res.format.fields.find((b) => p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1]); if (f) setSelection('sheet-format'); }
        return;
      }
      case 'modelview': mutate((d, s) => { const v = addModelView(d, s, tool.orientation, p); setSelection(v.id); }); setTool({ k: 'select' }); return;
      case 'projected': {
        if (!tool.parent) { const v = viewAt(res, p); if (v) setTool({ ...tool, parent: v.view.id }); else setMessage('Click inside a view first.'); return; }
        const pr = rvOf(tool.parent)!;
        const d = snapOrtho(sub(p, pr.pos));
        mutate((dd, s) => { const v = addProjectedView(dd, s, tool.parent!, d, add(pr.pos, mul(d, dot(sub(p, pr.pos), d)))); setSelection(v.id); });
        return; // stays active for more projections from the same parent (mainstream CAD behaviour)
      }
      case 'section': {
        if (!tool.parent) { const v = viewAt(res, p); if (v) setTool({ ...tool, parent: v.view.id }); else { setMessage('Click inside a view to cut.'); return; } if (!v) return; if (tool.mode === 'free') return; }
        const pr = rvOf(tool.parent ?? viewAt(res, p)?.view.id)!;
        const t2 = { ...tool, parent: pr.view.id };
        const ends = sectionEnds(pr, t2, fromPaper(pr, p));
        if (t2.mode !== 'free' && !t2.a) { setTool({ ...t2, a: ends ? (t2.mode === 'h' ? [0, ends[0][1]] : [ends[0][0], 0]) as V2 : fromPaper(pr, p) }); return; }
        if (t2.mode === 'free' && !t2.a) { const h = findSnap(res, p, tol, pr.view.id); setTool({ ...t2, a: fromPaper(pr, h && h.kind !== 'edge' ? h.p : p) }); return; }
        if (t2.mode === 'free' && !t2.b) { const h = findSnap(res, p, tol, pr.view.id); setTool({ ...t2, b: fromPaper(pr, h && h.kind !== 'edge' ? h.p : p) }); return; }
        if (!ends) return;
        const [a, b] = ends;
        const pa = add(pr.pos, mul(sub(a, pr.pivot), pr.scale)), pb = add(pr.pos, mul(sub(b, pr.pivot), pr.scale));
        const n = norm(perp(sub(pb, pa)));
        const side = Math.sign(dot(sub(p, mul(add(pa, pb), 0.5)), n)) || 1;
        const d = mul(n, side);
        mutate((dd, s) => { const v = addSectionView(dd, s, pr.view.id, a, b, d, add(pr.pos, mul(d, dot(sub(p, pr.pos), d))), t2.mode !== 'free'); setSelection(v.id); });
        setTool({ k: 'select' });
        return;
      }
      case 'detail': {
        if (!tool.parent || !tool.center) {
          const v = viewAt(res, p); if (!v) { setMessage('Click inside a view.'); return; }
          const c = hit && hit.kind !== 'edge' ? hit.p : p;
          setTool({ k: 'detail', parent: v.view.id, center: fromPaper(v, c) }); return;
        }
        const pr = rvOf(tool.parent)!;
        if (tool.radius === undefined) { const c = add(pr.pos, mul(sub(tool.center, pr.pivot), pr.scale)); setTool({ ...tool, radius: Math.max(dist(p, c), 1) / pr.scale }); return; }
        const sc = detailScale(pr);
        mutate((dd, s) => { const v = addDetailView(dd, s, pr.view.id, tool.center!, tool.radius!, sc, p); setSelection(v.id); });
        setTool({ k: 'select' });
        return;
      }
      case 'aux': {
        if (!tool.edge) {
          if (!hit || hit.kind !== 'edge') { setMessage('Click a straight edge.'); return; }
          const pr = rvOf(hit.snap.view)!;
          setTool({ k: 'aux', parent: pr.view.id, edge: [fromPaper(pr, hit.snap.a), fromPaper(pr, hit.snap.b)] }); return;
        }
        const pr = rvOf(tool.parent)!;
        const [ea, eb] = tool.edge;
        const n = norm(perp(sub(eb, ea)));
        const m = add(pr.pos, mul(sub(mul(add(ea, eb), 0.5), pr.pivot), pr.scale));
        const d = mul(n, Math.sign(dot(sub(p, m), n)) || 1);
        mutate((dd, s) => { const v = addAuxiliaryView(dd, s, pr.view.id, tool.edge!, d, add(pr.pos, mul(d, dot(sub(p, pr.pos), d)))); setSelection(v.id); });
        setTool({ k: 'select' });
        return;
      }
      case 'dim': {
        const picks = tool.picks;
        const sameView = (h: SnapHit | null) => !!h && (!picks.length || h.snap.view === picks[0].snap.view);
        if (!picks.length) { if (hit) setTool({ k: 'dim', picks: [hit] }); else setMessage('Click an edge, a circle or a point.'); return; }
        if (picks.length === 1 && picks[0].kind !== 'circle' && sameView(hit) && hit!.kind !== 'circle' && !(picks[0].kind === 'edge' && hit!.kind === 'point' && hit!.snap.kind === 'vertex' && isEndOf(picks[0], hit!))) {
          if (!(hit!.kind === 'edge' && picks[0].kind === 'edge' && hit!.snap.ref.ei === picks[0].snap.ref.ei)) { setTool({ k: 'dim', picks: [...picks, hit!] }); return; }
        }
        const a = dimFromPicks(picks, p);
        if (a) mutate((_d, s) => { s.annotations.push(a); });
        setTool({ k: 'dim', picks: [] });
        return;
      }
      case 'note': case 'gdt': {
        if (!tool.leader && hit) { setTool({ ...tool, leader: attachOfHit(hit, p) }); return; }
        const a = annotationAt(p);
        if (a) { mutate((_d, s) => { s.annotations.push(a); }); setSelection(a.id); }
        setTool({ k: 'select' });
        return;
      }
      case 'datum': case 'balloon': {
        if (!tool.attach) { if (!hit) { setMessage('Click the part geometry first.'); return; } setTool({ ...tool, attach: attachOfHit(hit, p) }); return; }
        const a = annotationAt(p);
        if (a) { mutate((_d, s) => { s.annotations.push(a); }); setSelection(a.id); }
        setTool({ k: tool.k } as Tool);
        return;
      }
      case 'centermark': {
        if (!hit || (hit.kind !== 'circle' && !(hit.kind === 'point' && hit.snap.kind === 'center'))) { setMessage('Click a circle seen end-on.'); return; }
        const s0 = hit.snap as Extract<typeof hit.snap, { kind: 'center' }>;
        mutate((_d, s) => { s.annotations.push({ id: dwgId('cm'), kind: 'centermark', view: s0.view, c: s0.ref.c, r: s0.ref.r }); });
        return;
      }
      case 'centerline': {
        if (!hit) return;
        if (!tool.first) { setTool({ k: 'centerline', first: hit }); return; }
        const mid = (h: SnapHit) => (h.kind === 'edge' ? [0, 1, 2].map((i) => (h.snap.ref.a[i] + h.snap.ref.b[i]) / 2) : h.snap.ref.k === 'pt' ? h.snap.ref.p : (h.snap.ref as any).c) as [number, number, number];
        const f = tool.first;
        if (f.kind === 'edge' && hit.kind === 'edge') {
          // Centerline midway between two edges (e.g. the sides of a cylinder), spanning their length.
          const a = f.snap.ref, b = hit.snap.ref;
          const m0 = [0, 1, 2].map((i) => (a.a[i] + b.a[i]) / 2) as [number, number, number];
          const m1 = [0, 1, 2].map((i) => (a.b[i] + b.b[i]) / 2) as [number, number, number];
          const sameDir = dot(sub(f.snap.b, f.snap.a), sub(hit.snap.b, hit.snap.a)) > 0;
          const n1 = sameDir ? m1 : [0, 1, 2].map((i) => (a.b[i] + b.a[i]) / 2) as [number, number, number];
          const n0 = sameDir ? m0 : [0, 1, 2].map((i) => (a.a[i] + b.b[i]) / 2) as [number, number, number];
          mutate((_d, s) => { s.annotations.push({ id: dwgId('cl'), kind: 'centerline', view: f.snap.view, a: n0, b: n1 }); });
        } else mutate((_d, s) => { s.annotations.push({ id: dwgId('cl'), kind: 'centerline', view: f.snap.view, a: mid(f), b: mid(hit) }); });
        setTool({ k: 'centerline' });
        return;
      }
    }
  };

  function isEndOf(edge: SnapHit, pt: SnapHit): boolean {
    if (edge.kind !== 'edge' || pt.kind !== 'point') return false;
    return dist(edge.snap.a, pt.p) < 1e-6 || dist(edge.snap.b, pt.p) < 1e-6;
  }

  const onMove = (e: CanvasPointer) => {
    setMouse(e.p);
    if (!res || !doc || !sheet) return;
    const dr = drag.current;
    if (dr && tool.k === 'select') {
      const delta = sub(e.p, dr.start);
      if (!dr.moved && Math.hypot(delta[0], delta[1]) * pxPerMm < 3) return;
      dr.moved = true;
      const next = clone(dr.orig);
      const s = next.sheets[sheetIndex];
      if (dr.kind === 'view') {
        // Move the view and the views that depend on it (they stay aligned).
        const ids = new Set([dr.id, ...dependents(s, dr.id).filter((id) => { const v = s.views.find((x) => x.id === id); return v && v.kind !== 'detail'; })]);
        for (const v of s.views) if (ids.has(v.id)) v.position = add(v.position, delta);
      } else {
        const a = s.annotations.find((x) => x.id === dr.id);
        if (a && 'at' in a) (a as any).at = add((a as any).at, delta);
      }
      setDocState(next); docRef.current = next;
      return;
    }
    if (tool.k === 'select') setHover(pickOwner(res, e.p, tol));
  };
  const onUp = () => {
    const dr = drag.current;
    drag.current = null;
    if (dr?.moved && docRef.current) commit(docRef.current, { from: dr.orig });
  };

  const onDouble = (e: CanvasPointer) => {
    if (!res || !sheet || tool.k !== 'select') return;
    const id = pickOwner(res, e.p, tol);
    if (id) { setSelection(id); setTab(tab); setFocusTick((t) => t + 1); return; }
    const f = res.format.fields.find((b) => e.p[0] >= b.min[0] && e.p[0] <= b.max[0] && e.p[1] >= b.min[1] && e.p[1] <= b.max[1]);
    if (f) { setSelection('sheet-format'); setEditField(f.field); }
  };

  // ---- exports
  const sheetName = () => `${safeName(doc?.titleBlock.dwgNo || doc?.partName || 'drawing')}${doc && doc.sheets.length > 1 ? `-${safeName(sheet!.name)}` : ''}`;
  const exportPdf = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      const pages = [];
      for (let i = 0; i < doc.sheets.length; i++) {
        const s = doc.sheets[i];
        const g = i === sheetIndex && geometry ? geometry : await kernel.call({ op: 'drawing', doc: part, views: viewRequests(doc, s) });
        const r = composeSheet({ doc, sheetIndex: i, part, geometry: g, volume: g.volume });
        const sz = sheetSize(s.size);
        pages.push({ w: sz.w, h: sz.h, prims: r.prims, standard: doc.standard });
      }
      download(`${safeName(doc.titleBlock.dwgNo || doc.partName)}.pdf`, buildPdf(pages, doc.titleBlock.title || doc.name) as BlobPart, 'application/pdf');
      setMessage('PDF exported at true scale. Print at 100% ("Actual size") to keep the scale.');
    } catch (e) { setMessage(`PDF export failed: ${e instanceof Error ? e.message : e}`); } finally { setBusy(false); }
  };
  const exportDxf = () => {
    if (!res || !doc || !sheet) return;
    const sz = sheetSize(sheet.size);
    download(`${sheetName()}.dxf`, buildDxf(res.prims, sz.w, sz.h, doc.standard), 'application/dxf');
    setMessage(`DXF exported at 1:1, units ${doc.standard === 'ASME' ? 'inches' : 'millimetres'} (set your CAD import to the same unit).`);
  };
  const exportSvg = () => {
    if (!res || !doc || !sheet) return;
    const sz = sheetSize(sheet.size);
    download(`${sheetName()}.svg`, sheetSvg(res.prims, sz.w, sz.h, doc.standard, doc.titleBlock.title), 'image/svg+xml');
  };
  const saveJson = () => { if (doc) download(`${safeName(doc.name)}.chatdrw.json`, JSON.stringify(doc, null, 2), 'application/json'); };
  const fileInput = useRef<HTMLInputElement>(null);
  const openJson = (file: File) => {
    file.text().then((t) => {
      const d = JSON.parse(t);
      if (d?.format !== 'chatcad-drawing') throw new Error('Not a ChatCAD drawing file');
      commit(d); setSheetIndex(0); setSelection(null);
    }).catch((e) => setMessage(`Could not open: ${e instanceof Error ? e.message : e}`));
  };

  // ---- derived render data
  const highlight = useMemo(() => (res && selection ? res.prims.filter((p) => p.owner === selection) : []), [res, selection]);
  const hoverPrims = useMemo(() => (res && hover && hover !== selection ? res.prims.filter((p) => p.owner === hover) : []), [res, hover, selection]);
  const overlay = res ? placementPreview() : [];

  if (!doc || !sheet || !res) {
    return (
      <div className="dw-root">
        <div className="dw-start">
          <h2>New drawing of “{part.name}”</h2>
          <p className="dw-muted">Views are projected from the exact 3D model with hidden-line removal and stay linked to the part.</p>
          <label className="dw-field"><span>Standard</span>
            <select value={newStd} onChange={(e) => { const s = e.target.value as DraftStandard; setNewStd(s); setNewSize(s === 'ISO' ? 'A3' : 'B'); }}>
              <option value="ASME">ASME Y14 (inches, third-angle projection)</option>
              <option value="ISO">ISO (millimetres, first-angle projection)</option>
            </select></label>
          <label className="dw-field"><span>Sheet size</span>
            <select value={newSize} onChange={(e) => setNewSize(e.target.value as SheetSizeId)}>
              {SHEET_SIZES.filter((s) => (newStd === 'ISO' ? s.family === 'ISO' : s.family === 'ANSI')).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select></label>
          <label className="dw-check"><input type="checkbox" checked={newIso} onChange={(e) => setNewIso(e.target.checked)} /> Add an isometric view</label>
          <label className="dw-check"><input type="checkbox" checked={newModelItems} onChange={(e) => setNewModelItems(e.target.checked)} /> Import model dimensions</label>
          <div className="dw-row">
            <button className="primary" disabled={busy} onClick={createDrawing}>{busy ? 'Working…' : 'Create drawing (Standard 3 View)'}</button>
            {props.onClose && <button onClick={props.onClose}>Back to part</button>}
          </div>
          {message && <p className="dw-err">{message}</p>}
        </div>
      </div>
    );
  }

  const sz = sheetSize(sheet.size);
  const selView = sheet.views.find((v) => v.id === selection);
  const selAnn = sheet.annotations.find((a) => a.id === selection);
  const units = doc.units;
  const fmtLen = (mm: number) => `${formatNumber(toUnits(mm, units), doc.decimals, units, { leadingZero: true })} ${units}`;

  return (
    <div className="dw-root">
      {/* Ribbon tabs */}
      <div className="dw-ribbon">
        <div className="dw-tabs">
          {([['layout', 'View Layout'], ['annotation', 'Annotation'], ['sheet', 'Sheet Format'], ['export', 'Export']] as const).map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
          <span className="dw-spacer" />
          <button title="Undo (Ctrl+Z)" disabled={!history.current.undo.length} onClick={undo}>↶</button>
          <button title="Redo (Ctrl+Y)" disabled={!history.current.redo.length} onClick={redo}>↷</button>
          <button title="Zoom to fit (F)" onClick={() => canvas.current?.fit()}>Fit</button>
          {props.onClose && <button onClick={props.onClose}>Back to part</button>}
        </div>
        <div className="dw-tools">
          {tab === 'layout' && <>
            <ToolBtn on={false} label="Standard 3 View" onClick={() => {
              if (!geometry?.model) { setMessage('Waiting for the model…'); return; }
              mutate((d, s) => { s.views = []; s.annotations = s.annotations.filter((a) => a.kind === 'note' || a.kind === 'bom'); addStandardViews(d, s, geometry.model!, true); });
            }} />
            <span className="dw-group">
              <ToolBtn on={tool.k === 'modelview'} label="Model View" onClick={() => startTool({ k: 'modelview', orientation: tool.k === 'modelview' ? tool.orientation : 'iso' })} />
              {tool.k === 'modelview' && <select value={tool.orientation} onChange={(e) => setTool({ k: 'modelview', orientation: e.target.value as StdOrientation })}>
                {(Object.keys(ORIENTATION_LABEL) as StdOrientation[]).map((o) => <option key={o} value={o}>{ORIENTATION_LABEL[o]}</option>)}
              </select>}
            </span>
            <ToolBtn on={tool.k === 'projected'} label="Projected View" onClick={() => startTool({ k: 'projected' })} />
            <span className="dw-group">
              <ToolBtn on={tool.k === 'section'} label="Section View" onClick={() => startTool({ k: 'section', mode: tool.k === 'section' ? tool.mode : 'h' })} />
              {tool.k === 'section' && <select value={tool.mode} onChange={(e) => setTool({ k: 'section', mode: e.target.value as 'h' | 'v' | 'free' })}>
                <option value="h">Horizontal cut</option><option value="v">Vertical cut</option><option value="free">Two points</option>
              </select>}
            </span>
            <ToolBtn on={tool.k === 'detail'} label="Detail View" onClick={() => startTool({ k: 'detail' })} />
            <ToolBtn on={tool.k === 'aux'} label="Auxiliary View" onClick={() => startTool({ k: 'aux' })} />
          </>}
          {tab === 'annotation' && <>
            <ToolBtn on={tool.k === 'dim'} label="Dimension (D)" onClick={() => startTool({ k: 'dim', picks: [] })} />
            <ToolBtn on={false} label="Model Items" onClick={() => {
              if (!geometry?.model) return;
              const next = clone(doc);
              const added = insertModelItems(next, sheetIndex, part, geometry.model, geometry.sketches);
              commit(next);
              setMessage(added.length ? `Imported ${added.length} model dimension${added.length > 1 ? 's' : ''}.` : 'All model dimensions are already shown.');
            }} />
            <ToolBtn on={tool.k === 'note'} label="Note" onClick={() => startTool({ k: 'note' })} />
            <ToolBtn on={tool.k === 'gdt'} label="Geometric Tolerance" onClick={() => startTool({ k: 'gdt' })} />
            <ToolBtn on={tool.k === 'datum'} label="Datum Feature" onClick={() => startTool({ k: 'datum' })} />
            <ToolBtn on={tool.k === 'centermark'} label="Center Mark" onClick={() => startTool({ k: 'centermark' })} />
            <ToolBtn on={tool.k === 'centerline'} label="Centerline" onClick={() => startTool({ k: 'centerline' })} />
            <ToolBtn on={tool.k === 'balloon'} label="Balloon" onClick={() => startTool({ k: 'balloon' })} />
            <ToolBtn on={false} label="Bill of Materials" onClick={() => { const id = dwgId('bom'); mutate((d, s) => { s.annotations.push({ id, kind: 'bom', at: defaultBomAnchor(d, sheetIndex) }); }); setSelection(id); }} />
          </>}
          {tab === 'sheet' && <>
            <ToolBtn on={selection === 'sheet'} label="Sheet Properties" onClick={() => setSelection('sheet')} />
            <ToolBtn on={selection === 'sheet-format'} label="Edit Title Block" onClick={() => setSelection('sheet-format')} />
            <ToolBtn on={false} label="Add Sheet" onClick={() => { mutate((d) => { d.sheets.push({ id: dwgId('sheet'), name: `Sheet${d.sheets.length + 1}`, size: sheet.size, scale: sheet.scale, views: [], annotations: [], revisions: [], showRevisionTable: true }); }); setSheetIndex(doc.sheets.length); }} />
          </>}
          {tab === 'export' && <>
            <ToolBtn on={false} label="Export PDF (all sheets)" onClick={exportPdf} />
            <ToolBtn on={false} label="Export DXF (this sheet)" onClick={exportDxf} />
            <ToolBtn on={false} label="Export SVG (this sheet)" onClick={exportSvg} />
            <ToolBtn on={false} label="Save drawing file" onClick={saveJson} />
            <ToolBtn on={false} label="Open drawing file" onClick={() => fileInput.current?.click()} />
            <input ref={fileInput} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) openJson(f); e.target.value = ''; }} />
          </>}
        </div>
      </div>

      <div className="dw-body">
        {/* Drawing tree + command panel */}
        <div className="dw-side">
          <div className="dw-tree">
            <div className="dw-tree-item dw-root-item">▤ {doc.name}</div>
            <div className={`dw-tree-item ${selection === 'sheet' ? 'sel' : ''}`} onClick={() => setSelection('sheet')}>▭ {sheet.name} <span className="dw-muted">({sheet.size}, {scaleLabel(sheet.scale)})</span></div>
            <div className={`dw-tree-item l1 ${selection === 'sheet-format' ? 'sel' : ''}`} onClick={() => setSelection('sheet-format')}>☰ Sheet Format1</div>
            {sheet.views.filter((v) => v.kind === 'model').map((v) => <ViewTreeNode key={v.id} v={v} sheet={sheet} depth={1} sel={selection} hover={hover} onSel={setSelection} onHover={setHover} />)}
            {sheet.annotations.length > 0 && <div className="dw-tree-item l1 dw-muted">Annotations ({sheet.annotations.length})</div>}
            {sheet.annotations.map((a) => (
              <div key={a.id} className={`dw-tree-item l2 ${selection === a.id ? 'sel' : ''} ${hover === a.id ? 'hov' : ''}`} onClick={() => setSelection(a.id)} onMouseEnter={() => setHover(a.id)} onMouseLeave={() => setHover(null)}>
                {annLabel(a, doc, part, geometry?.sketches)}
              </div>
            ))}
          </div>
          <div className="dw-props">
            {selView && <ViewProps v={selView} sheet={sheet} doc={doc} rv={rvOf(selView.id)} onChange={(fn) => mutate((_d, s) => { const v = s.views.find((x) => x.id === selView.id); if (v) fn(v, s); })} onDelete={deleteSelected} />}
            {selAnn && <AnnProps focusTick={focusTick} a={selAnn} doc={doc} part={part} store={store} rv={'view' in selAnn ? rvOf((selAnn as any).view) : undefined} model={geometry?.model ?? null} sketches={geometry?.sketches}
              onChange={(fn) => mutate((_d, s) => { const a = s.annotations.find((x) => x.id === selAnn.id); if (a) fn(a); })} onDelete={deleteSelected} fmtLen={fmtLen} />}
            {selection === 'sheet' && <SheetProps doc={doc} sheet={sheet} model={geometry?.model ?? null} onChange={(fn) => mutate(fn)} />}
            {selection === 'sheet-format' && <TitleBlockProps doc={doc} focus={editField} onChange={(field, value) => mutate((d) => { (d.titleBlock as any)[field] = value; })} sheet={sheet} onSheet={(fn) => mutate((_d, s) => fn(s))} />}
            {!selection && tool.k === 'select' && <p className="dw-hint">Select a view or annotation to edit it. Use the tabs above to add views, dimensions, GD&amp;T and notes, or to export.</p>}
            {tool.k === 'gdt' && <FcfEditor row={fcfDraft} std={doc.standard} onChange={setFcfDraft} />}
            {tool.k === 'note' && <label className="dw-field"><span>Note text</span><textarea rows={4} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} /></label>}
          </div>
        </div>

        <div className="dw-main">
          <DrawingCanvas
            ref={canvas}
            prims={res.prims}
            sheetW={sz.w}
            sheetH={sz.h}
            standard={doc.standard}
            highlight={highlight}
            hover={hoverPrims}
            overlay={overlay}
            cursor={tool.k === 'select' ? (hover ? 'move' : 'default') : 'crosshair'}
            onDown={onDown}
            onMove={onMove}
            onUp={onUp}
            onDouble={onDouble}
            onZoom={setPxPerMm}
          />
          <div className="dw-sheets">
            {doc.sheets.map((s, i) => <button key={s.id} className={i === sheetIndex ? 'on' : ''} onClick={() => { setSheetIndex(i); setSelection(null); setTool({ k: 'select' }); }}>{s.name}</button>)}
            <button title="Add sheet" onClick={() => { mutate((d) => { d.sheets.push({ id: dwgId('sheet'), name: `Sheet${d.sheets.length + 1}`, size: sheet.size, scale: sheet.scale, views: [], annotations: [], revisions: [], showRevisionTable: true }); }); setSheetIndex(doc.sheets.length); }}>+</button>
          </div>
        </div>
      </div>

      <div className="dw-status">
        <span>{TOOL_HINT[tool.k]}</span>
        {message && <span className="dw-msg" onClick={() => setMessage('')}>{message}</span>}
        <span className="dw-spacer" />
        {res.warnings.length > 0 && <span className="dw-warn" title={res.warnings.join('\n')}>⚠ {res.warnings.length} warning{res.warnings.length > 1 ? 's' : ''}</span>}
        {kernelError && <span className="dw-err">Kernel: {kernelError}</span>}
        {busy && <span className="dw-muted">Updating views…</span>}
        <span>{doc.standard} · {doc.projection === 'third' ? 'Third' : 'First'} angle · {fmtLen(mouse[0])}, {fmtLen(mouse[1])}</span>
      </div>
    </div>
  );
}

function ToolBtn(p: { on: boolean; label: string; onClick: () => void }) {
  return <button className={`dw-tool ${p.on ? 'on' : ''}`} onClick={p.onClick}>{p.label}</button>;
}

function viewLabel(v: DrawingView): string {
  switch (v.kind) {
    case 'model': return `${v.name} (${ORIENTATION_LABEL[v.orientation]})`;
    case 'projected': return `${v.name} (Projected)`;
    case 'section': return `${v.name} (Section ${v.letter}-${v.letter})`;
    case 'detail': return `${v.name} (Detail ${v.letter})`;
    case 'auxiliary': return `${v.name} (Auxiliary ${v.letter})`;
  }
}

function ViewTreeNode(p: { v: DrawingView; sheet: DrawingSheet; depth: number; sel: string | null; hover: string | null; onSel: (id: string) => void; onHover: (id: string | null) => void }) {
  const kids = p.sheet.views.filter((x) => x.kind !== 'model' && x.parent === p.v.id);
  return <>
    <div className={`dw-tree-item l${Math.min(p.depth, 4)} ${p.sel === p.v.id ? 'sel' : ''} ${p.hover === p.v.id ? 'hov' : ''}`} onClick={() => p.onSel(p.v.id)} onMouseEnter={() => p.onHover(p.v.id)} onMouseLeave={() => p.onHover(null)}>
      ◫ {viewLabel(p.v)}
    </div>
    {kids.map((k) => <ViewTreeNode key={k.id} {...p} v={k} depth={p.depth + 1} />)}
  </>;
}

function annLabel(a: Annotation, doc: DrawingDocument, part: CadDocument, sketches?: SketchGeometry[]): string {
  switch (a.kind) {
    case 'dim': {
      const kind = a.dimType === 'diameter' ? 'Diameter' : a.dimType === 'radius' ? 'Radius' : a.dimType === 'angle' ? 'Angle' : 'Linear';
      if (a.model) { const mg = modelDimGeometry(part, a, sketches); return `◇ ${kind} — ${mg?.label ?? 'missing'}`; }
      return `◇ ${kind} dimension`;
    }
    case 'note': return `✎ Note: ${a.text.split('\n')[0].slice(0, 24)}`;
    case 'fcf': return `⌖ Feature control frame`;
    case 'datum': return `▲ Datum ${a.letter}`;
    case 'centermark': return '+ Center mark';
    case 'centerline': return '— Centerline';
    case 'bom': return '☷ Bill of Materials';
    case 'balloon': return `① Balloon ${a.item}`;
  }
  void doc;
}

function Field(p: { label: string; children: React.ReactNode }) { return <label className="dw-field"><span>{p.label}</span>{p.children}</label>; }

function ScaleSelect(p: { value: Ratio | undefined; inherit?: string; onChange: (r: Ratio | undefined) => void }) {
  const key = p.value ? scaleLabel(p.value) : '';
  return (
    <select value={key} onChange={(e) => { const v = e.target.value; p.onChange(v ? STD_SCALES.find((s) => scaleLabel(s) === v) : undefined); }}>
      {p.inherit !== undefined && <option value="">{p.inherit}</option>}
      {STD_SCALES.map((s) => <option key={scaleLabel(s)} value={scaleLabel(s)}>{scaleLabel(s)}</option>)}
    </select>
  );
}

function ViewProps(p: { v: DrawingView; sheet: DrawingSheet; doc: DrawingDocument; rv?: ResolvedView; onChange: (fn: (v: DrawingView, s: DrawingSheet) => void) => void; onDelete: () => void }) {
  const { v } = p;
  return (
    <div className="dw-panel">
      <h3>{viewLabel(v)}</h3>
      <Field label="Name"><input value={v.name} onChange={(e) => p.onChange((x) => { x.name = e.target.value; })} /></Field>
      {v.kind === 'model' && <Field label="Orientation"><select value={v.orientation} onChange={(e) => p.onChange((x) => { (x as any).orientation = e.target.value; })}>
        {(Object.keys(ORIENTATION_LABEL) as StdOrientation[]).map((o) => <option key={o} value={o}>{ORIENTATION_LABEL[o]}</option>)}
      </select></Field>}
      <Field label="Scale"><ScaleSelect value={v.scale} inherit={v.kind === 'detail' ? undefined : v.kind === 'model' ? 'Use sheet scale' : 'Use parent scale'} onChange={(r) => p.onChange((x) => { if (r) x.scale = r; else delete x.scale; })} /></Field>
      {v.kind === 'detail' && <Field label={`Detail radius (${p.doc.units})`}><input type="number" step="any" value={+toUnits(v.radius, p.doc.units).toFixed(4)} onChange={(e) => { const n = parseFloat(e.target.value); if (n > 0) p.onChange((x) => { (x as any).radius = p.doc.units === 'in' ? n * 25.4 : n; }); }} /></Field>}
      {'letter' in v && <Field label="Label letter"><input value={v.letter} onChange={(e) => p.onChange((x) => { (x as any).letter = e.target.value.toUpperCase(); })} /></Field>}
      <label className="dw-check"><input type="checkbox" checked={v.hiddenLines} onChange={(e) => p.onChange((x) => { x.hiddenLines = e.target.checked; })} /> Hidden lines visible</label>
      <label className="dw-check"><input type="checkbox" checked={v.centerMarks} onChange={(e) => p.onChange((x) => { x.centerMarks = e.target.checked; })} /> Auto center marks</label>
      <label className="dw-check"><input type="checkbox" checked={v.centerlines} onChange={(e) => p.onChange((x) => { x.centerlines = e.target.checked; })} /> Auto centerlines</label>
      {(v.kind === 'projected' || v.kind === 'section' || v.kind === 'auxiliary') && <label className="dw-check"><input type="checkbox" checked={v.aligned !== false} onChange={(e) => p.onChange((x) => { x.aligned = e.target.checked; })} /> Aligned with parent</label>}
      {v.kind === 'section' && <button onClick={() => p.onChange((x, s) => {
        // Flip the viewing direction: mirror the view to the other side of its parent.
        const sx = x as Extract<DrawingView, { kind: 'section' }>;
        const parent = s.views.find((q) => q.id === sx.parent);
        sx.dir = [-sx.dir[0], -sx.dir[1]];
        if (parent && p.rv) { const pp = parent.position; sx.position = [2 * pp[0] - sx.position[0], 2 * pp[1] - sx.position[1]]; }
      })}>Flip section direction</button>}
      {p.rv?.error && <p className="dw-err">{p.rv.error}</p>}
      <div className="dw-row"><button className="danger" onClick={p.onDelete}>Delete view</button></div>
      <p className="dw-hint">Drag the view to move it. Projected views stay aligned with their parent.</p>
    </div>
  );
}

const TOL_TYPES: { id: TolType; label: string }[] = [
  { id: 'none', label: 'None' }, { id: 'symmetric', label: 'Symmetric ±' }, { id: 'bilateral', label: 'Bilateral +/−' }, { id: 'limit', label: 'Limit' },
  { id: 'basic', label: 'Basic (boxed)' }, { id: 'reference', label: 'Reference ( )' }, { id: 'min', label: 'MIN' }, { id: 'max', label: 'MAX' },
];

function AnnProps(p: { focusTick?: number; a: Annotation; doc: DrawingDocument; part: CadDocument; store: DocumentStore; rv?: ResolvedView; model: DrawingGeometryResponse['model']; sketches?: SketchGeometry[]; onChange: (fn: (a: Annotation) => void) => void; onDelete: () => void; fmtLen: (mm: number) => string }) {
  const { a, doc } = p;
  const [val, setVal] = useState('');
  const [err, setErr] = useState('');
  const valueInput = useRef<HTMLInputElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  // Double-clicking an annotation on the sheet jumps to its main editable field.
  useEffect(() => {
    if (!p.focusTick) return;
    const el = valueInput.current && !valueInput.current.readOnly ? valueInput.current : noteInput.current;
    if (el) { el.focus(); el.select(); }
  }, [p.focusTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const measured = a.kind === 'dim' && p.rv ? dimensionValue(a, p.rv, p.part, p.model, p.sketches) : null;
  useEffect(() => {
    if (a.kind === 'dim' && measured !== null) setVal(a.dimType === 'angle' ? measured.toFixed(4) : String(+toUnits(measured, doc.units).toFixed(6)));
  }, [a.id, measured]); // eslint-disable-line react-hooks/exhaustive-deps

  if (a.kind === 'dim') {
    const mg = a.model ? modelDimGeometry(p.part, a, p.sketches) : null;
    const driving = !!mg?.editable;
    const applyValue = () => {
      setErr('');
      const n = parseFloat(val);
      if (!(n > 0)) { setErr('Enter a positive number.'); return; }
      try { applyModelValue(p.store, a, n, doc.units); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    };
    return (
      <div className="dw-panel">
        <h3>{a.dimType === 'diameter' ? 'Diameter' : a.dimType === 'radius' ? 'Radius' : a.dimType === 'angle' ? 'Angle' : 'Linear'} dimension</h3>
        {a.model ? <p className="dw-hint">{driving ? 'Model dimension (driving): changing the value changes the part.' : 'Model dimension (from the part). Edit the sketch in the part to change it.'}</p> : <p className="dw-hint">Driven dimension: measured from the exact geometry.</p>}
        <Field label={`Value (${a.dimType === 'angle' ? 'degrees' : doc.units})`}>
          <div className="dw-row">
            <input ref={valueInput} value={val} readOnly={!driving} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && driving) applyValue(); }} />
            {driving && <button className="primary" onClick={applyValue}>Apply</button>}
          </div>
        </Field>
        {err && <p className="dw-err">{err}</p>}
        <Field label="Tolerance"><select value={a.tol.type} onChange={(e) => p.onChange((x) => { (x as any).tol = { ...(x as any).tol, type: e.target.value }; })}>
          {TOL_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select></Field>
        {['symmetric', 'bilateral', 'limit'].includes(a.tol.type) && <div className="dw-grid2">
          <Field label="Plus"><input type="number" step="any" value={a.tol.plus ?? 0} onChange={(e) => p.onChange((x) => { (x as any).tol.plus = parseFloat(e.target.value) || 0; })} /></Field>
          {a.tol.type !== 'symmetric' && <Field label="Minus"><input type="number" step="any" value={a.tol.minus ?? 0} onChange={(e) => p.onChange((x) => { (x as any).tol.minus = parseFloat(e.target.value) || 0; })} /></Field>}
        </div>}
        <div className="dw-grid2">
          <Field label="Decimals"><input type="number" min={0} max={6} value={a.decimals ?? (a.dimType === 'angle' ? doc.angleDecimals : doc.decimals)} onChange={(e) => p.onChange((x) => { (x as any).decimals = Math.max(0, Math.min(6, parseInt(e.target.value) || 0)); })} /></Field>
          <Field label="Count (nX)"><input type="number" min={1} value={a.count ?? 1} onChange={(e) => p.onChange((x) => { (x as any).count = Math.max(1, parseInt(e.target.value) || 1); })} /></Field>
        </div>
        <div className="dw-grid2">
          <Field label="Prefix"><input value={a.prefix ?? ''} onChange={(e) => p.onChange((x) => { (x as any).prefix = e.target.value || undefined; })} /></Field>
          <Field label="Suffix"><input value={a.suffix ?? ''} placeholder="e.g. THRU" onChange={(e) => p.onChange((x) => { (x as any).suffix = e.target.value || undefined; })} /></Field>
        </div>
        {a.dimType === 'linear' && <Field label="Direction"><select value={a.orient} onChange={(e) => p.onChange((x) => { (x as any).orient = e.target.value; })}>
          <option value="h">Horizontal</option><option value="v">Vertical</option><option value="aligned">Aligned</option>
        </select></Field>}
        <div className="dw-row"><button className="danger" onClick={p.onDelete}>Delete</button></div>
      </div>
    );
  }
  if (a.kind === 'note') return (
    <div className="dw-panel"><h3>Note</h3>
      <Field label="Text"><textarea ref={noteInput} rows={5} value={a.text} onChange={(e) => p.onChange((x) => { (x as any).text = e.target.value; })} /></Field>
      <Field label={`Text height (mm)`}><input type="number" step="any" value={+(a.height ?? STANDARDS[doc.standard].text.note).toFixed(3)} onChange={(e) => p.onChange((x) => { (x as any).height = parseFloat(e.target.value) || undefined; })} /></Field>
      {a.leader && <button onClick={() => p.onChange((x) => { delete (x as any).leader; })}>Remove leader</button>}
      <div className="dw-row"><button className="danger" onClick={p.onDelete}>Delete</button></div>
    </div>
  );
  if (a.kind === 'fcf') return (
    <div className="dw-panel"><h3>Feature control frame</h3>
      {a.rows.map((r, i) => <FcfEditor key={i} row={r} std={doc.standard} onChange={(nr) => p.onChange((x) => { (x as any).rows[i] = nr; })} onRemove={a.rows.length > 1 ? () => p.onChange((x) => { (x as any).rows.splice(i, 1); }) : undefined} />)}
      <button onClick={() => p.onChange((x) => { (x as any).rows.push({ sym: 'flatness', dia: false, tol: '.005', mod: '', datums: [] }); })}>Add frame row</button>
      <div className="dw-row"><button className="danger" onClick={p.onDelete}>Delete</button></div>
    </div>
  );
  if (a.kind === 'datum') return (
    <div className="dw-panel"><h3>Datum feature</h3>
      <Field label="Letter"><input value={a.letter} onChange={(e) => p.onChange((x) => { (x as any).letter = e.target.value.toUpperCase().slice(0, 2); })} /></Field>
      <div className="dw-row"><button className="danger" onClick={p.onDelete}>Delete</button></div>
    </div>
  );
  if (a.kind === 'balloon') return (
    <div className="dw-panel"><h3>Balloon</h3>
      <Field label="Item number"><input type="number" min={1} value={a.item} onChange={(e) => p.onChange((x) => { (x as any).item = Math.max(1, parseInt(e.target.value) || 1); })} /></Field>
      <div className="dw-row"><button className="danger" onClick={p.onDelete}>Delete</button></div>
    </div>
  );
  return (
    <div className="dw-panel"><h3>{annLabel(a, doc, p.part, p.sketches)}</h3>
      {a.kind === 'bom' && <p className="dw-hint">Lists the part (item 1). Part number, description and material come from the title block and the part's material. Assemblies will add rows here.</p>}
      <div className="dw-row"><button className="danger" onClick={p.onDelete}>Delete</button></div>
    </div>
  );
}

/** Write a new model-dimension value back into the part (driving dimension). */
function applyModelValue(store: DocumentStore, a: Extract<Annotation, { kind: 'dim' }>, value: number, units: 'in' | 'mm') {
  const part = store.state;
  const link = a.model;
  if (!link) throw new Error('Not a model dimension');
  // Express the new value in the drawing's unit so it is stored exactly as typed.
  const expr = (v: number) => `${+v.toPrecision(12)} ${units}`;
  const setExpr = (cur: unknown, next: string, apply: (e: string) => void) => {
    // When the field is just a parameter name, change the parameter instead (keeps the design intent).
    if (typeof cur === 'string' && part.params.some((pp) => pp.name === cur.trim())) store.setParameter(cur.trim(), next);
    else apply(next);
  };
  if (link.kind === 'depth') {
    const f = part.features.find((x) => x.id === link.feature);
    if (!f || f.type !== 'extrude') throw new Error('The extrude no longer exists');
    setExpr(f.depth, expr(value), (e) => store.updateFeature(f.id, { depth: e }));
    return;
  }
  const sk = part.features.find((x) => x.id === link.sketch);
  if (!sk || sk.type !== 'sketch') throw new Error('The sketch no longer exists');
  if (link.kind === 'circle' || link.kind === 'arc') {
    const ids = link.kind === 'circle' ? link.entities : [link.entity];
    const r = link.kind === 'circle' ? value / 2 : value;
    const first = sk.entities.find((e) => e.id === ids[0]);
    if (first && (first.kind === 'circle' || first.kind === 'arc') && typeof first.radius === 'string' && part.params.some((pp) => pp.name === first.radius.toString().trim())) {
      store.setParameter(String(first.radius).trim(), expr(r));
      return;
    }
    for (const id of ids) {
      const e = sk.entities.find((x) => x.id === id);
      if (e && (e.kind === 'circle' || e.kind === 'arc')) store.replaceSketchEntity(sk.id, { ...e, radius: expr(r) });
    }
    return;
  }
  if (link.kind === 'line') {
    const param = lineLengthParam(part, sk.id, link.entity);
    if (!param) throw new Error('This line length is set in the part sketch.');
    store.setParameter(param, expr(value));
    return;
  }
  if (link.kind === 'sketchDim') {
    const c = sk.constraints?.find((x) => x.id === link.constraint);
    if (!c || !('value' in c)) throw new Error('The sketch dimension no longer exists');
    if ((c as { driven?: boolean }).driven) throw new Error('This is a driven (reference) dimension in the sketch.');
    const next = c.type === 'angle' ? String(+value.toPrecision(12)) : expr(value);
    setExpr(c.value, next, (e) => store.editSketch(sk.id, 'Edit dimension', (s) => {
      const cc = s.constraints?.find((x) => x.id === link.constraint);
      if (cc && 'value' in cc) cc.value = e;
    }));
    return;
  }
  throw new Error('This dimension is edited in the part.');
}

function FcfEditor(p: { row: FcfRow; std: DraftStandard; onChange: (r: FcfRow) => void; onRemove?: () => void }) {
  const r = p.row;
  const set = (patch: Partial<FcfRow>) => p.onChange({ ...r, ...patch });
  const datums = [0, 1, 2].map((i) => r.datums[i] ?? { letter: '', mod: '' as const });
  return (
    <div className="dw-fcf">
      <Field label="Characteristic"><select value={r.sym} onChange={(e) => set({ sym: e.target.value as FcfRow['sym'] })}>
        {symbolsFor(p.std).map((s) => <option key={s.id} value={s.id}>{s.group}: {s.label}</option>)}
      </select></Field>
      <div className="dw-grid2">
        <label className="dw-check"><input type="checkbox" checked={r.dia} onChange={(e) => set({ dia: e.target.checked })} /> Ø zone</label>
        <Field label="Tolerance"><input value={r.tol} onChange={(e) => set({ tol: e.target.value })} /></Field>
      </div>
      <div className="dw-grid2">
        <Field label="Material condition"><select value={r.mod} onChange={(e) => set({ mod: e.target.value as FcfRow['mod'] })}><option value="">RFS (none)</option><option value="M">Ⓜ MMC</option><option value="L">Ⓛ LMC</option></select></Field>
        <Field label="Zone modifier"><select value={r.extra ?? ''} onChange={(e) => set({ extra: (e.target.value || undefined) as FcfRow['extra'] })}><option value="">None</option><option value="P">Ⓟ Projected</option><option value="F">Ⓕ Free state</option><option value="T">Ⓣ Tangent plane</option><option value="U">Ⓤ Unequal</option><option value="ST">ST Statistical</option></select></Field>
      </div>
      <div className="dw-datums">
        {datums.map((d, i) => (
          <span key={i}>
            <input placeholder={['Primary', 'Secondary', 'Tertiary'][i]} value={d.letter} onChange={(e) => { const nd = [...datums]; nd[i] = { ...nd[i], letter: e.target.value.toUpperCase().slice(0, 2) }; set({ datums: nd.filter((x, j) => x.letter || j < i) as FcfRow['datums'] }); }} />
            <select value={d.mod} onChange={(e) => { const nd = [...datums]; nd[i] = { ...nd[i], mod: e.target.value as FcfRow['mod'] }; set({ datums: nd.filter((x) => x.letter) as FcfRow['datums'] }); }}><option value="">–</option><option value="M">Ⓜ</option><option value="L">Ⓛ</option></select>
          </span>
        ))}
      </div>
      {!symbolsFor(p.std).find((s) => s.id === r.sym)?.datums && r.datums.some((d) => d.letter) && <p className="dw-err">Form tolerances do not take datum references (ASME Y14.5).</p>}
      {p.onRemove && <button onClick={p.onRemove}>Remove row</button>}
    </div>
  );
}

function SheetProps(p: { doc: DrawingDocument; sheet: DrawingSheet; model: DrawingGeometryResponse['model']; onChange: (fn: (d: DrawingDocument, s: DrawingSheet) => void) => void }) {
  const { doc, sheet } = p;
  return (
    <div className="dw-panel">
      <h3>Sheet properties</h3>
      <Field label="Sheet name"><input value={sheet.name} onChange={(e) => p.onChange((_d, s) => { s.name = e.target.value; })} /></Field>
      <Field label="Sheet size"><select value={sheet.size} onChange={(e) => p.onChange((_d, s) => { s.size = e.target.value as SheetSizeId; })}>
        {SHEET_SIZES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select></Field>
      <Field label="Sheet scale"><ScaleSelect value={sheet.scale} onChange={(r) => r && p.onChange((_d, s) => { s.scale = r; })} /></Field>
      <Field label="Drafting standard"><select value={doc.standard} onChange={(e) => p.onChange((d) => {
        const st = e.target.value as DraftStandard;
        d.standard = st;
        d.projection = STANDARDS[st].defaultProjection; d.units = st === 'ISO' ? 'mm' : 'in'; d.decimals = st === 'ISO' ? 2 : 3;
      })}><option value="ASME">ASME Y14 (inch)</option><option value="ISO">ISO</option></select></Field>
      <Field label="Projection"><select value={doc.projection} onChange={(e) => p.onChange((d) => { d.projection = e.target.value as 'third' | 'first'; })}>
        <option value="third">Third angle (ASME default)</option><option value="first">First angle (ISO default)</option></select></Field>
      <p className="dw-hint">Changing the projection re-projects existing projected views from the same parent side.</p>
      <div className="dw-grid2">
        <Field label="Units"><select value={doc.units} onChange={(e) => p.onChange((d) => { d.units = e.target.value as 'in' | 'mm'; })}><option value="in">Inches</option><option value="mm">Millimetres</option></select></Field>
        <Field label="Decimals"><input type="number" min={0} max={6} value={doc.decimals} onChange={(e) => p.onChange((d) => { d.decimals = Math.max(0, Math.min(6, parseInt(e.target.value) || 0)); })} /></Field>
      </div>
      <Field label="Tangent edges"><select value={doc.tangentEdges} onChange={(e) => p.onChange((d) => { d.tangentEdges = e.target.value as 'visible' | 'removed'; })}><option value="visible">Visible</option><option value="removed">Removed</option></select></Field>
      <label className="dw-check"><input type="checkbox" checked={sheet.showRevisionTable} onChange={(e) => p.onChange((_d, s) => { s.showRevisionTable = e.target.checked; })} /> Revision table</label>
      {p.model && sheet.views.length === 0 && <button onClick={() => p.onChange((d, s) => addStandardViews(d, s, p.model!, true))}>Add Standard 3 View</button>}
      {doc.sheets.length > 1 && <button className="danger" onClick={() => p.onChange((d, s) => { d.sheets = d.sheets.filter((x) => x.id !== s.id); })}>Delete this sheet</button>}
    </div>
  );
}

const TB_FIELDS: { f: keyof TitleBlock; label: string; iso?: boolean; asme?: boolean }[] = [
  { f: 'company', label: 'Company / legal owner' }, { f: 'title', label: 'Drawing title' }, { f: 'subtitle', label: 'Supplementary title', iso: true },
  { f: 'dwgNo', label: 'Drawing number' }, { f: 'rev', label: 'Revision' }, { f: 'cage', label: 'CAGE code', asme: true },
  { f: 'material', label: 'Material' }, { f: 'finish', label: 'Finish', asme: true },
  { f: 'drawnBy', label: 'Drawn / created by' }, { f: 'drawnDate', label: 'Date' },
  { f: 'checkedBy', label: 'Checked by', asme: true }, { f: 'checkedDate', label: 'Checked date', asme: true },
  { f: 'engBy', label: 'Engineering / approved by' }, { f: 'engDate', label: 'Approval date', asme: true },
  { f: 'mfgBy', label: 'Manufacturing approval', asme: true }, { f: 'qaBy', label: 'Q.A.', asme: true },
  { f: 'tol2', label: 'Tolerance, 2 places', asme: true }, { f: 'tol3', label: 'Tolerance, 3 places', asme: true }, { f: 'tolAngle', label: 'Angle tolerance', asme: true },
  { f: 'generalTol', label: 'General tolerances', iso: true },
  { f: 'dept', label: 'Responsible department', iso: true }, { f: 'techRef', label: 'Technical reference', iso: true },
  { f: 'docType', label: 'Document type', iso: true }, { f: 'docStatus', label: 'Document status', iso: true }, { f: 'lang', label: 'Language', iso: true },
];

function TitleBlockProps(p: { doc: DrawingDocument; sheet: DrawingSheet; focus: keyof TitleBlock | null; onChange: (f: keyof TitleBlock, v: string) => void; onSheet: (fn: (s: DrawingSheet) => void) => void }) {
  const iso = p.doc.standard === 'ISO';
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  useEffect(() => { if (p.focus) { refs.current[p.focus]?.focus(); refs.current[p.focus]?.select(); } }, [p.focus]);
  return (
    <div className="dw-panel">
      <h3>Title block</h3>
      {TB_FIELDS.filter((x) => (iso ? !x.asme : !x.iso)).map((x) => (
        <Field key={x.f} label={x.label}><input ref={(el) => { refs.current[x.f] = el; }} value={p.doc.titleBlock[x.f]} onChange={(e) => p.onChange(x.f, e.target.value)} /></Field>
      ))}
      <h3>Revisions</h3>
      {p.sheet.revisions.map((r, i) => (
        <div key={i} className="dw-rev">
          <input value={r.rev} placeholder="Rev" onChange={(e) => p.onSheet((s) => { s.revisions[i].rev = e.target.value; })} />
          <input value={r.description} placeholder="Description" onChange={(e) => p.onSheet((s) => { s.revisions[i].description = e.target.value; })} />
          <input value={r.date} placeholder="Date" onChange={(e) => p.onSheet((s) => { s.revisions[i].date = e.target.value; })} />
          <input value={r.approved} placeholder="Appr." onChange={(e) => p.onSheet((s) => { s.revisions[i].approved = e.target.value; })} />
          <button className="x" onClick={() => p.onSheet((s) => { s.revisions.splice(i, 1); })}>×</button>
        </div>
      ))}
      <button onClick={() => p.onSheet((s) => { const n = s.revisions.length; s.revisions.push({ zone: '', rev: String.fromCharCode(65 + n), description: n ? '' : 'INITIAL RELEASE', date: new Date().toISOString().slice(0, 10), approved: '' }); })}>Add revision</button>
    </div>
  );
}

export default DrawingWorkspace;
