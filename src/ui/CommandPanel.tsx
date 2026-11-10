/**
 * Command panels: the left-panel forms that replace the
 * feature tree while a command is active (mainstream CAD behaviour).
 * ✓ / Enter accepts, ✕ / Esc cancels. Feature commands show a live
 * translucent preview of the result while values change.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DocumentStore } from '../core/store';
import { resolveParams } from '../core/store';
import type { BasePlane, CadDocument, ExtrudeFeature, ExtrudeUpTo, Feature, PlaneSpec, ValueExpr, RevolveFeature, RevolveThin, SketchEntity, SketchFeature, Vec3, VertexSpec } from '../core/model';
import type { SelRef } from '../kernel/protocol';
import type { Topology } from '../kernel/naming';
import { edgeIndex, edgeLabel, edgesFrom, faceIndex, facesFrom, planeLabel, selectionOf, selectionOfPlane } from './picks';
import { MATERIALS } from '../core/model';
import { evalAngle, evalLength, formatLength, MM_PER } from '../core/units';
import type { RegenResponse } from '../kernel/protocol';
import type { EntityInfo, MassProps } from '../kernel/query';
import type { MassPanelState } from './massStatus';
import { ExprField, SketchDialog, ParamsDialog } from './dialogs';
import type { AppCtx, PMState } from './commands';
import { NAV_PRESETS, type NavPresetId } from '../render/navigation';
import { Icon, type IconName } from './icons';
import { FeaturePM } from './FeaturePMs';
import { dragHandles, type DragHandle } from '../render/dragHandles';
import { ExportStepPM, ExportStlPM, type ExportFile } from './ExportPMs';
import { APP_NAME } from '../brand';
import { AboutModal } from './AboutModal';

/** Live preview hook-up, implemented by App (kernel preview op + viewport). */
export interface PreviewApi {
  /** topology: also name the base's faces/edges (for picking). quiet: do not show the kernel's message (the PM shows its own hint). */
  show(doc: CadDocument, featureId: string, kind: 'add' | 'cut', opts?: { topology?: boolean; quiet?: boolean }): void;
  clear(): void;
}

export interface ViewOptions {
  nav: NavPresetId; reverseWheel: boolean; showPlanes: boolean; showEdges: boolean; showSketches: boolean; showOrigin: boolean;
  /** Animate view orientation changes, Zoom to Fit and Previous View. */
  animateViews: boolean;
}

export interface PMProps {
  pm: Exclude<PMState, null>;
  ctx: AppCtx;
  close(): void;
  preview: PreviewApi;
  regen: RegenResponse | null;
  /** What Mass Properties may show: only numbers from a finished rebuild of the open document. */
  massState: MassPanelState;
  distance: number | null;
  /** Export STEP / STL (App runs it in the geometry worker and saves the file). */
  exportFile: ExportFile;
  viewOptions: ViewOptions;
  setViewOptions(o: Partial<ViewOptions>): void;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
export const PREVIEW_ID = '__preview__';

/** Common frame: title, ✓ / ✕, then sections. */
export function Shell({ title, icon, onOk, onCancel, okDisabled, children, help }: {
  title: string; icon: IconName; onOk?: () => void; onCancel: () => void; okDisabled?: boolean; children: ReactNode; help?: string;
}) {
  return (
    <div className="pm" onKeyDown={(e) => {
      if (e.key === 'Enter' && onOk && !okDisabled && !(e.target as HTMLElement).matches('textarea')) { e.preventDefault(); e.stopPropagation(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    }}>
      <div className="pm-title"><Icon name={icon} /><span>{title}</span></div>
      <div className="pm-buttons">
        {onOk && <button className="pm-ok" title="OK (Enter)" disabled={okDisabled} onClick={onOk}><Icon name="check" /></button>}
        <button className="pm-cancel" title={onOk ? 'Cancel (Esc)' : 'Close (Esc)'} onClick={onCancel}><Icon name="close" /></button>
      </div>
      {help && <p className="pm-help">{help}</p>}
      {children}
    </div>
  );
}

export function Section({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pm-section">
      <div className="pm-section-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="pm-section-title">{title}</span>
        {right && <span onClick={(e) => e.stopPropagation()}>{right}</span>}
      </div>
      {open && <div className="pm-section-body">{children}</div>}
    </div>
  );
}

export function lengthOk(store: DocumentStore, v: string): boolean {
  try { const d = evalLength(v, store.state.units, resolveParams(store.state)); return Number.isFinite(d) && d > 0; } catch { return false; }
}
export function angleOk(store: DocumentStore, v: string): boolean {
  try { const a = evalAngle(v, resolveParams(store.state)); return Number.isFinite(a) && a > 0; } catch { return false; }
}

/** Build a document containing the draft feature (in place when editing, at the insert point when new). */
export function draftDoc(store: DocumentStore, f: Feature, editId?: string): CadDocument {
  const doc = clone(store.state) as CadDocument;
  if (editId) {
    const i = doc.features.findIndex((x) => x.id === editId);
    doc.features[i] = f;
  } else {
    doc.features.splice(store.insertIndex(), 0, f);
  }
  doc.rollback = null;
  return doc;
}

function useDebouncedPreview(preview: PreviewApi, build: () => { doc: CadDocument; id: string; kind: 'add' | 'cut' } | null, deps: unknown[]) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => {
      const b = build();
      if (b) preview.show(b.doc, b.id, b.kind); else preview.clear();
    }, 120);
    return () => { if (t.current) clearTimeout(t.current); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => preview.clear(), []); // eslint-disable-line react-hooks/exhaustive-deps
}

export function SketchSelect({ store, value, onChange }: { store: DocumentStore; value: string; onChange: (id: string) => void }) {
  const sketches = store.state.features.filter((x): x is SketchFeature => x.type === 'sketch');
  return (
    <select className="pm-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">Select a sketch…</option>}
      {sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

/**
 * Direction 1 end conditions, as in mainstream CAD's Extrude command panel
 * (public help "End Condition Extrude"). 'both' = Through All - Both.
 */
type EndCond = 'blind' | 'through' | 'both' | 'next' | 'vertex' | 'surface' | 'offsetSurface' | 'mid';
const END_LABEL: Record<EndCond, string> = {
  blind: 'Blind', through: 'Through All', both: 'Through All - Both', next: 'Up To Next', vertex: 'Up To Vertex',
  surface: 'Up To Surface', offsetSurface: 'Offset From Surface', mid: 'Mid Plane',
};
/** Mainstream CAD's order. Direction 2 has the same list without Through All - Both and Mid Plane. */
const END_ORDER_1: EndCond[] = ['blind', 'through', 'both', 'next', 'vertex', 'surface', 'offsetSurface', 'mid'];
const END_ORDER_2: EndCond[] = ['blind', 'through', 'next', 'vertex', 'surface', 'offsetSurface'];
const BASE_PLANE_OPTIONS: { id: BasePlane; label: string }[] = [{ id: 'XZ', label: 'Front Plane' }, { id: 'XY', label: 'Top Plane' }, { id: 'YZ', label: 'Right Plane' }];

function endOfUpTo(u: ExtrudeUpTo | undefined): EndCond | null {
  if (u?.kind === 'next') return 'next';
  if (u?.kind === 'vertex') return 'vertex';
  if (u?.kind === 'surface') return u.offset !== undefined ? 'offsetSurface' : 'surface';
  return null;
}
function endOf(f: ExtrudeFeature | undefined): EndCond {
  if (!f) return 'blind';
  if (f.direction === 'symmetric') return 'mid';
  const u = endOfUpTo(f.upTo);
  if (u) return u;
  if (f.throughAll && f.throughAll2) return 'both';
  return f.throughAll ? 'through' : 'blind';
}
const isUpTo = (e: EndCond) => e === 'vertex' || e === 'surface' || e === 'offsetSurface';

/** One direction's settings in the Extrude PM. */
interface DirState {
  end: EndCond; depth: string; vertex: VertexSpec | null; surface: PlaneSpec | null; surfOff: string; revOff: boolean;
  draftOn: boolean; draft: string; draftOut: boolean;
}
function initDir(u: ExtrudeUpTo | undefined, end: EndCond, depth: string, draft: ValueExpr | undefined, draftOut: boolean | undefined, defDepth: string): DirState {
  return {
    end, depth,
    vertex: u?.kind === 'vertex' ? u.vertex : null,
    surface: u?.kind === 'surface' ? u.surface : null,
    surfOff: String(u?.kind === 'surface' ? u.offset ?? defDepth : defDepth),
    revOff: u?.kind === 'surface' && !!u.reverseOffset,
    draftOn: draft !== undefined, draft: String(draft ?? '1'), draftOut: !!draftOut,
  };
}
function upToOf(s: DirState): ExtrudeUpTo | undefined {
  if (s.end === 'next') return { kind: 'next' };
  if (s.end === 'vertex' && s.vertex) return { kind: 'vertex', vertex: s.vertex };
  if ((s.end === 'surface' || s.end === 'offsetSurface') && s.surface) {
    return { kind: 'surface', surface: s.surface, ...(s.end === 'offsetSurface' ? { offset: s.surfOff, ...(s.revOff ? { reverseOffset: true } : {}) } : {}) };
  }
  return undefined;
}

/** The extrude PM's picks: viewport clicks go to the active box; the view highlights what it holds. */
function useExtrudePicks(ctx: AppCtx, onPick: (ref: SelRef | null, point: Vec3 | null) => void, highlight: () => SelRef[], deps: unknown[]) {
  const h = useRef({ onPick, highlight }); h.current = { onPick, highlight };
  const seq = useRef(ctx.pick?.seq ?? 0);
  useEffect(() => {
    const p = ctx.pick;
    if (!p || p.seq === seq.current) return;
    seq.current = p.seq;
    h.current.onPick(p.ref, p.point);
  }, [ctx.pick?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { ctx.setSelection(h.current.highlight()); }, [...deps, ctx.topoSeq, ctx.pick?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Up To Vertex from a click on an edge: the end of the edge nearest the click (mainstream CAD picks the vertex itself). */
export function vertexFromPick(t: Topology | null, ref: SelRef | null, point: Vec3 | null): VertexSpec | 'closed' | null {
  if (!t || !ref || ref.kind !== 'edge') return null;
  const e = t.edges[ref.index];
  if (!e?.ends) return null;
  const [a, b] = e.ends;
  const d2 = (p: Vec3, q: Vec3) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  if (d2(a, b) < 1e-12) return 'closed';
  const at = point && d2(point, b) < d2(point, a) ? b : a;
  return { edge: edgesFrom(t, [ref])[0], at };
}

function vertexLabel(doc: CadDocument, v: VertexSpec | null): string {
  if (!v) return '';
  if ('refPoint' in v) return doc.features.find((f) => f.id === v.refPoint)?.name ?? 'Point (missing)';
  return `Vertex of ${edgeLabel(doc, v.edge)}`;
}

// ------------------------------------------------------------------ Extrude
function ExtrudePM({ pm, ctx, close, preview, regen }: PMProps & { pm: { kind: 'extrude'; cut: boolean; editId?: string; sketchId?: string } }) {
  const { store } = ctx;
  const doc = store.state;
  const existing = pm.editId ? (store.feature(pm.editId) as ExtrudeFeature | undefined) : undefined;
  const cut = existing ? existing.operation === 'cut' : pm.cut;
  const defDepth = store.state.units === 'in' ? '0.4' : '10';
  const [name, setName] = useState(existing?.name ?? '');
  const [sketch, setSketch] = useState(existing?.sketch ?? pm.sketchId ?? '');
  useEffect(() => { if (pm.sketchId) setSketch(pm.sketchId); }, [pm.sketchId]);
  // From
  const [fromOffset, setFromOffset] = useState(existing?.startOffset !== undefined);
  const [so, setSo] = useState(String(existing?.startOffset ?? defDepth));
  const [soRev, setSoRev] = useState(!!existing?.startOffsetReverse);
  // Direction 1 and Direction 2
  const [reverse, setReverse] = useState(existing ? existing.direction === 'reverse' : cut);
  const [s1, setS1] = useState<DirState>(() => initDir(existing?.upTo, endOf(existing), String(existing?.depth ?? defDepth), existing?.draft, existing?.draftOutward, defDepth));
  const end2Of = (f: ExtrudeFeature | undefined): EndCond => endOfUpTo(f?.upTo2) ?? (f?.throughAll2 ? 'through' : 'blind');
  const [s2, setS2] = useState<DirState>(() => initDir(existing?.upTo2, end2Of(existing), String(existing?.depth2 ?? defDepth), existing?.draft2, existing?.draftOutward2, defDepth));
  const set1 = (p: Partial<DirState>) => setS1((s) => ({ ...s, ...p }));
  const set2 = (p: Partial<DirState>) => setS2((s) => ({ ...s, ...p }));
  /** Which direction's pick box gets clicks in the view (like mainstream CAD's one active selection box). */
  const [activeDir, setActiveDir] = useState<1 | 2>(1);
  const [flip, setFlip] = useState(!!existing?.flipSide);
  // Thin Feature (an open sketch can only be extruded thin, so it starts ticked, like mainstream CAD)
  const [thinOn, setThinOn] = useState<boolean | null>(existing ? !!existing.thin : null);
  const [thinType, setThinType] = useState<RevolveThin['type']>(existing?.thin?.type ?? 'oneDirection');
  const [thinRev, setThinRev] = useState(!!existing?.thin?.reverse);
  const defThin = store.state.units === 'in' ? '0.1' : '2';
  const [tk1, setTk1] = useState(String(existing?.thin?.thickness ?? defThin));
  const [tk2, setTk2] = useState(String(existing?.thin?.thickness2 ?? defThin));
  const [capOn, setCapOn] = useState(!!existing?.thin?.capEnds);
  const [capT, setCapT] = useState(String(existing?.thin?.capThickness ?? defThin));
  const [filletOn, setFilletOn] = useState(existing?.thin?.autoFillet !== undefined);
  const [filletR, setFilletR] = useState(String(existing?.thin?.autoFillet ?? defThin));
  const loopCount = regen?.sketches.find((x) => x.id === sketch)?.loops;
  const thin = thinOn ?? loopCount === 0;
  const closedSketch = (loopCount ?? 0) > 0;
  const [dir2, setDir2] = useState(!!existing && existing.direction !== 'symmetric' && endOf(existing) !== 'both' && (existing.depth2 !== undefined || !!existing.throughAll2 || !!existing.upTo2));
  const hasBody = store.state.features.some((x) => x.type !== 'sketch' && x.id !== existing?.id);
  const operation: ExtrudeFeature['operation'] = cut ? 'cut' : existing?.operation === 'new' || !hasBody ? 'new' : 'add';
  const defaultName = existing?.name ?? store.nextName(cut ? 'Cut-Extrude' : 'Extrude');

  const end1 = s1.end;
  const upToMode = isUpTo(end1);
  const usesDepth = end1 === 'blind' || end1 === 'mid';
  const dir2Allowed = end1 !== 'mid' && end1 !== 'both';
  const useDir2 = dir2 && dir2Allowed;
  const draftAllowed = end1 !== 'mid';
  const useDraft = s1.draftOn && draftAllowed;
  const useDraft2 = useDir2 && s2.draftOn;
  const pickDir = useDir2 && activeDir === 2 && isUpTo(s2.end) ? 2 : isUpTo(end1) ? 1 : useDir2 && isUpTo(s2.end) ? 2 : 1;
  const cur = pickDir === 1 ? s1 : s2;
  const setCur = pickDir === 1 ? set1 : set2;
  const targetOf = (s: DirState) => (s.end === 'vertex' ? s.vertex : s.end === 'surface' || s.end === 'offsetSurface' ? s.surface : true);
  const angleValid = (v: string) => { try { const a = evalAngle(v, resolveParams(store.state)); return a > 0 && a < Math.PI / 2; } catch { return false; } };
  const nonNeg = (v: string) => { try { return evalLength(v, store.state.units, resolveParams(store.state)) >= 0; } catch { return false; } };
  const dirOk = (s: DirState, draftOn: boolean) => (s.end !== 'blind' && s.end !== 'mid' || lengthOk(store, s.depth)) && !!targetOf(s)
    && (s.end !== 'offsetSurface' || nonNeg(s.surfOff)) && (!draftOn || angleValid(s.draft));
  const capAllowed = thin && closedSketch && !cut;
  const filletAllowed = thin && !closedSketch;
  const thinOk = !thin || (lengthOk(store, tk1) && (thinType !== 'twoDirection' || lengthOk(store, tk2))
    && (!capAllowed || !capOn || lengthOk(store, capT)) && (!filletAllowed || !filletOn || lengthOk(store, filletR)));
  const valid = !!sketch && dirOk(s1, useDraft) && (!useDir2 || dirOk(s2, useDraft2)) && (!fromOffset || nonNeg(so)) && thinOk;

  const feature = (): ExtrudeFeature => {
    const upTo = upToOf(s1);
    const upTo2 = useDir2 ? upToOf(s2) : undefined;
    return {
      id: existing?.id ?? PREVIEW_ID, type: 'extrude', name: name.trim() || defaultName, sketch,
      depth: usesDepth ? s1.depth : (existing?.depth ?? defDepth),
      direction: end1 === 'mid' ? 'symmetric' : reverse && !upToMode ? 'reverse' : 'normal',
      operation,
      ...(end1 === 'through' || end1 === 'both' ? { throughAll: true } : {}),
      ...(end1 === 'both' ? { throughAll2: true } : {}),
      ...(upTo ? { upTo } : {}),
      ...(useDir2 && s2.end === 'blind' ? { depth2: s2.depth } : {}),
      ...(useDir2 && s2.end === 'through' ? { throughAll2: true } : {}),
      ...(upTo2 ? { upTo2 } : {}),
      ...(useDraft2 ? { draft2: s2.draft, ...(s2.draftOut ? { draftOutward2: true } : {}) } : {}),
      ...(fromOffset ? { startOffset: so, ...(soRev ? { startOffsetReverse: true } : {}) } : {}),
      ...(useDraft ? { draft: s1.draft, ...(s1.draftOut ? { draftOutward: true } : {}) } : {}),
      ...(cut && flip ? { flipSide: true } : {}),
      ...(thin ? {
        thin: {
          type: thinType, thickness: tk1, ...(thinType === 'twoDirection' ? { thickness2: tk2 } : {}), ...(thinRev && thinType !== 'midPlane' ? { reverse: true } : {}),
          ...(capAllowed && capOn ? { capEnds: true, capThickness: capT } : {}),
          ...(filletAllowed && filletOn ? { autoFillet: filletR } : {}),
        },
      } : {}),
    };
  };

  // Always preview, so the view shows the part just before the extrude (what Up To picks land on).
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => {
      if (!sketch) { preview.clear(); return; }
      const f = feature();
      const d = draftDoc(store, valid ? f : { ...f, upTo: undefined, upTo2: undefined, suppressed: true }, existing?.id);
      preview.show(d, existing?.id ?? PREVIEW_ID, cut ? 'cut' : 'add', { topology: true, quiet: !valid });
    }, 120);
    return () => { if (t.current) clearTimeout(t.current); };
  }, [sketch, fromOffset, so, soRev, reverse, s1, s2, flip, thin, thinType, thinRev, tk1, tk2, capOn, capT, filletOn, filletR, dir2, valid, store.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => preview.clear(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag handles: arrows at the end of each Blind / Mid Plane direction set the depth.
  const sg = regen?.sketches.find((x) => x.id === sketch);
  useEffect(() => {
    const vp = ctx.vp;
    if (!vp) return;
    const handles = dragHandles(vp);
    const mmPer = MM_PER[store.state.units];
    const mm = (v: string) => { try { const x = evalLength(v, store.state.units, resolveParams(store.state)); return x > 0 ? x : null; } catch { return null; } };
    const center = sg && sketchCenter(sg);
    if (!center || !sg) { handles.set([]); return; }
    const n = sg.frame.n;
    let o: Vec3 = center;
    const soMm = fromOffset ? (() => { try { return evalLength(so, store.state.units, resolveParams(store.state)); } catch { return 0; } })() : 0;
    o = [o[0] + n[0] * soMm * (soRev ? -1 : 1), o[1] + n[1] * soMm * (soRev ? -1 : 1), o[2] + n[2] * soMm * (soRev ? -1 : 1)];
    const d1: Vec3 = end1 !== 'mid' && reverse ? [-n[0], -n[1], -n[2]] : n;
    const text = (v: number) => String(+(v / mmPer).toFixed(store.state.units === 'in' ? 3 : 2));
    const fmt = (v: number) => `${text(v)} ${store.state.units}`;
    const list: DragHandle[] = [];
    const v1 = mm(s1.depth);
    if ((end1 === 'blind' || end1 === 'mid') && v1) {
      const half = end1 === 'mid';
      list.push({ origin: o, dir: d1, value: half ? v1 / 2 : v1, unitMm: mmPer, format: (v) => fmt(half ? 2 * v : v), onDrag: (v) => set1({ depth: text(half ? 2 * v : v) }) });
    }
    const v2 = mm(s2.depth);
    if (useDir2 && s2.end === 'blind' && v2) {
      list.push({ origin: o, dir: [-d1[0], -d1[1], -d1[2]], value: v2, unitMm: mmPer, format: fmt, onDrag: (v) => set2({ depth: text(v) }) });
    }
    handles.set(list);
  }, [ctx.vp, sg, s1.depth, s2.depth, end1, s2.end, useDir2, reverse, fromOffset, so, soRev, store.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (ctx.vp) dragHandles(ctx.vp).set([]); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useExtrudePicks(ctx, (ref, point) => {
    const topo = ctx.pickTopology();
    if (cur.end === 'vertex') {
      const v = vertexFromPick(topo, ref, point);
      if (v === 'closed') ctx.notify('A full circle has no vertex. Click near the end of an edge.');
      else if (v) setCur({ vertex: v });
      else if (ref) ctx.notify('Up To Vertex: click near the end of a model edge, or choose a reference point.');
      return;
    }
    if (cur.end === 'surface' || cur.end === 'offsetSurface') {
      if (!ref) return;
      if (ref.kind === 'plane') { setCur({ surface: { base: ref.plane } }); return; }
      if (ref.kind === 'face' && topo?.faces[ref.index]) {
        if (cur.end === 'surface' || topo.faces[ref.index].surface === 'plane') setCur({ surface: { face: facesFrom(topo, [ref])[0] } });
        else ctx.notify('Offset From Surface works with flat faces and planes. Pick a flat face or a plane (Up To Surface also takes curved faces).');
      }
    }
  }, () => {
    const topo = ctx.pickTopology();
    const sel: SelRef[] = [];
    for (const s of useDir2 ? [s1, s2] : [s1]) {
      if (s.end === 'vertex' && s.vertex && 'edge' in s.vertex) sel.push(...selectionOf(topo, { edges: [s.vertex.edge] }));
      if ((s.end === 'surface' || s.end === 'offsetSurface') && s.surface) sel.push(...selectionOfPlane(topo, s.surface));
    }
    return sel;
  }, [s1, s2, useDir2, pickDir]);

  const ok = () => {
    if (!valid) return;
    const f = feature();
    try {
      const opt = (k: keyof ExtrudeFeature) => (f[k] === undefined ? null : f[k]);
      if (existing) {
        store.updateFeature(existing.id, {
          name: f.name, sketch, depth: f.depth, direction: f.direction, operation,
          throughAll: opt('throughAll'), depth2: opt('depth2'), throughAll2: opt('throughAll2'), upTo: opt('upTo'), upTo2: opt('upTo2'),
          startOffset: opt('startOffset'), startOffsetReverse: opt('startOffsetReverse'), draft: opt('draft'), draftOutward: opt('draftOutward'),
          draft2: opt('draft2'), draftOutward2: opt('draftOutward2'), flipSide: opt('flipSide'), thin: opt('thin'),
        });
      } else {
        store.addExtrude(sketch, f.depth, {
          name: name.trim() || undefined, direction: f.direction, operation, throughAll: f.throughAll, depth2: f.depth2, throughAll2: f.throughAll2,
          upTo: f.upTo, upTo2: f.upTo2, startOffset: f.startOffset, startOffsetReverse: f.startOffsetReverse, draft: f.draft, draftOutward: f.draftOutward,
          draft2: f.draft2, draftOutward2: f.draftOutward2, flipSide: f.flipSide, thin: f.thin,
        });
      }
      close();
    } catch (e) { ctx.notify((e as Error).message); }
  };

  const needPick = (s: DirState) => (s.end === 'vertex' && !s.vertex) || ((s.end === 'surface' || s.end === 'offsetSurface') && !s.surface);
  const pickHelp = (s: DirState, which: string) => s.end === 'vertex'
    ? `${which}Up To Vertex: click near the end of an edge in the view (or pick a reference point).`
    : `${which}${END_LABEL[s.end]}: click a ${s.end === 'surface' ? 'face' : 'flat face'} or a plane in the view (or pick a plane in the list).`;
  const help = !sketch ? 'Select a sketch to extrude.'
    : needPick(s1) ? pickHelp(s1, '')
      : useDir2 && needPick(s2) ? pickHelp(s2, 'Direction 2 ')
        : loopCount === 0 && !thin ? 'The sketch is open: a solid extrude needs a closed profile. Turn on Thin Feature, or close the sketch.' : undefined;

  const dirProps = { doc, store, editId: existing?.id, topo: ctx.pickTopology() };
  return (
    <Shell title={existing ? existing.name : cut ? 'Cut-Extrude' : 'Extrude'} icon={cut ? 'cut' : 'boss'} onOk={ok} onCancel={close} okDisabled={!valid} help={help}>
      <Section title="Feature name"><input className="pm-input" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} spellCheck={false} /></Section>
      <Section title="From">
        <select className="pm-select" value={fromOffset ? 'offset' : 'plane'} onChange={(e) => setFromOffset(e.target.value === 'offset')}>
          <option value="plane">Sketch Plane</option>
          <option value="offset">Offset</option>
        </select>
        {fromOffset && (
          <div className="pm-row">
            <button className={`pm-icon-btn ${soRev ? 'on' : ''}`} title="Reverse Direction" onClick={() => setSoRev(!soRev)}>⇅</button>
            <ExprField label="Offset value" value={so} onChange={setSo} store={store} />
          </div>
        )}
      </Section>
      <Section title="Direction 1">
        <DirectionFields {...dirProps} s={s1} set={set1} order={END_ORDER_1} which={1} active={pickDir === 1} onActivate={() => setActiveDir(1)}
          reverse={{ on: reverse && !upToMode, disabled: end1 === 'mid' || upToMode, set: () => setReverse(!reverse) }}
          draftAllowed={draftAllowed} draftOffNote="Draft is not available with Mid Plane"
          extra={cut && <label className="check"><input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Flip side to cut</label>} />
      </Section>
      <Section title={<label className="check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={useDir2} disabled={!dir2Allowed} onChange={(e) => setDir2(e.target.checked)} /> Direction 2</label>}>
        {useDir2 ? (
          <DirectionFields {...dirProps} s={s2} set={set2} order={END_ORDER_2} which={2} active={pickDir === 2} onActivate={() => setActiveDir(2)} draftAllowed />
        ) : <div className="pm-row muted">{end1 === 'mid' ? 'Not used with Mid Plane.' : end1 === 'both' ? 'Through All - Both already goes both ways.' : 'Extrude the other way from the sketch plane too.'}</div>}
      </Section>
      <Section title={<label className="check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={thin} onChange={(e) => setThinOn(e.target.checked)} /> Thin Feature</label>}>
        {thin ? (
          <>
            <div className="pm-row">
              <button className={`pm-icon-btn ${thinRev ? 'on' : ''}`} disabled={thinType === 'midPlane'} title="Reverse Direction" onClick={() => setThinRev(!thinRev)}>⇅</button>
              <select className="pm-select" value={thinType} onChange={(e) => setThinType(e.target.value as RevolveThin['type'])}>
                <option value="oneDirection">One-Direction</option>
                <option value="midPlane">Mid-Plane</option>
                <option value="twoDirection">Two-Direction</option>
              </select>
            </div>
            <ExprField label={thinType === 'twoDirection' ? 'Direction 1 Thickness' : 'Thickness'} value={tk1} onChange={setTk1} store={store} />
            {thinType === 'twoDirection' && <ExprField label="Direction 2 Thickness" value={tk2} onChange={setTk2} store={store} />}
            {capAllowed && (
              <>
                <label className="check" data-hint="Close both ends of the thin feature, making a hollow part"><input type="checkbox" checked={capOn} onChange={(e) => setCapOn(e.target.checked)} /> Cap ends</label>
                {capOn && <ExprField label="Cap Thickness" value={capT} onChange={setCapT} store={store} />}
              </>
            )}
            {filletAllowed && (
              <>
                <label className="check" data-hint="Round each corner where two lines meet"><input type="checkbox" checked={filletOn} onChange={(e) => setFilletOn(e.target.checked)} /> Auto-fillet corners</label>
                {filletOn && <ExprField label="Fillet Radius (inside)" value={filletR} onChange={setFilletR} store={store} />}
              </>
            )}
          </>
        ) : <div className="pm-row muted">Make a wall of constant thickness from the sketch curves (open or closed).</div>}
      </Section>
      <Section title="Selected Contours"><SketchSelect store={store} value={sketch} onChange={setSketch} /></Section>
    </Shell>
  );
}

/** Middle of a sketch's geometry in 3D (mm): where the extrude drag arrows sit. */
function sketchCenter(sg: { frame: { o: Vec3; x: Vec3; y: Vec3 }; entities: { kind: string }[] }): Vec3 | null {
  const pts: [number, number][] = [];
  for (const e of sg.entities as any[]) {
    if (e.construction) continue;
    if (e.kind === 'line') pts.push(e.a, e.b);
    else if (e.kind === 'circle' || e.kind === 'arc') pts.push([e.c[0] - e.r, e.c[1] - e.r], [e.c[0] + e.r, e.c[1] + e.r]);
    else if (Array.isArray(e.pts)) pts.push(...e.pts);
    else if (Array.isArray(e.p)) pts.push(e.p);
  }
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const u = (Math.min(...xs) + Math.max(...xs)) / 2, v = (Math.min(...ys) + Math.max(...ys)) / 2;
  const { o, x, y } = sg.frame;
  return [o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v];
}

/** End condition, its target box, depth and draft for one direction of the Extrude PM. */
function DirectionFields({ s, set, order, which, active, onActivate, reverse, draftAllowed, draftOffNote, extra, doc, store, editId, topo }: {
  s: DirState; set(p: Partial<DirState>): void; order: EndCond[]; which: 1 | 2; active: boolean; onActivate(): void;
  reverse?: { on: boolean; disabled: boolean; set(): void }; draftAllowed: boolean; draftOffNote?: string; extra?: ReactNode;
  doc: CadDocument; store: DocumentStore; editId?: string; topo: Topology | null;
}) {
  const refPoints = doc.features.filter((f) => f.type === 'refPoint' && f.id !== editId);
  const refPlanes = doc.features.filter((f) => f.type === 'refPlane' && f.id !== editId);
  const surfSel = !s.surface ? '' : 'base' in s.surface ? `base:${s.surface.base}` : 'refPlane' in s.surface ? `ref:${s.surface.refPlane}` : 'face';
  const surfMissing = !!s.surface && 'face' in s.surface && topo !== null && faceIndex(topo, s.surface.face) === null;
  const vertSel = !s.vertex ? '' : 'refPoint' in s.vertex ? `ref:${s.vertex.refPoint}` : 'edge';
  const vertMissing = !!s.vertex && 'edge' in s.vertex && topo !== null && edgeIndex(topo, s.vertex.edge) === null;
  const useDraft = s.draftOn && draftAllowed;
  const D = which === 1 ? 'D1' : 'D2';
  return (
    <>
      <div className="pm-row">
        {reverse && (
          <button className={`pm-icon-btn ${reverse.on ? 'on' : ''}`} disabled={reverse.disabled}
            title={isUpTo(s.end) ? 'The direction comes from where the vertex or surface is' : 'Reverse Direction'} onClick={reverse.set}>⇅</button>
        )}
        <select className="pm-select" value={s.end} onChange={(e) => { set({ end: e.target.value as EndCond }); onActivate(); }}>
          {order.map((k) => <option key={k} value={k}>{END_LABEL[k]}</option>)}
        </select>
      </div>
      {s.end === 'next' && <div className="pm-row muted">Ends at the next face that the whole profile runs into.</div>}
      {s.end === 'vertex' && (
        <div className={`pick-box ${active ? 'active' : ''}`} onClick={onActivate}>
          <div className="pick-box-head"><span>Vertex</span></div>
          <select className="pm-select" value={vertSel} onChange={(e) => { const v = e.target.value; if (v.startsWith('ref:')) set({ vertex: { refPoint: v.slice(4) } }); else if (!v) set({ vertex: null }); }}>
            <option value="">Pick a vertex…</option>
            {refPoints.map((f) => <option key={f.id} value={`ref:${f.id}`}>{f.name}</option>)}
            {s.vertex && 'edge' in s.vertex && <option value="edge">{vertexLabel(doc, s.vertex)}{vertMissing ? ' (not found)' : ''}</option>}
          </select>
        </div>
      )}
      {(s.end === 'surface' || s.end === 'offsetSurface') && (
        <div className={`pick-box ${active ? 'active' : ''}`} onClick={onActivate}>
          <div className="pick-box-head"><span>Face/Plane</span></div>
          <select className="pm-select" value={surfSel} onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('base:')) set({ surface: { base: v.slice(5) as BasePlane } });
            else if (v.startsWith('ref:')) set({ surface: { refPlane: v.slice(4) } });
            else if (!v) set({ surface: null });
          }}>
            <option value="">{s.end === 'surface' ? 'Pick a face or plane…' : 'Pick a flat face or plane…'}</option>
            {BASE_PLANE_OPTIONS.map((b) => <option key={b.id} value={`base:${b.id}`}>{b.label}</option>)}
            {refPlanes.map((f) => <option key={f.id} value={`ref:${f.id}`}>{f.name}</option>)}
            {s.surface && 'face' in s.surface && <option value="face">{planeLabel(doc, s.surface)}{surfMissing ? ' (not found)' : ''}</option>}
          </select>
        </div>
      )}
      {s.end === 'offsetSurface' && (
        <>
          <ExprField label="Offset Distance" value={s.surfOff} onChange={(v) => set({ surfOff: v })} store={store} />
          <label className="check"><input type="checkbox" checked={s.revOff} onChange={(e) => set({ revOff: e.target.checked })} /> Reverse offset</label>
        </>
      )}
      {(s.end === 'blind' || s.end === 'mid') && <ExprField label={s.end === 'mid' ? `${D} (total depth)` : `${D} depth`} value={s.depth} onChange={(v) => set({ depth: v })} store={store} />}
      {extra}
      <div className="pm-row">
        <button className={`pm-icon-btn ${useDraft ? 'on' : ''}`} disabled={!draftAllowed} title={draftAllowed ? 'Draft On/Off' : draftOffNote} onClick={() => set({ draftOn: !s.draftOn })}>◿</button>
        <span className="muted">Draft {useDraft ? 'on' : 'off'}</span>
      </div>
      {useDraft && (
        <>
          <ExprField label="Draft angle" kind="angle" value={s.draft} onChange={(v) => set({ draft: v })} store={store} />
          <label className="check"><input type="checkbox" checked={s.draftOut} onChange={(e) => set({ draftOut: e.target.checked })} /> Draft outward</label>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Revolve
function lineLabel(e: SketchEntity, i: number): string {
  if (e.kind !== 'line') return '';
  return `${e.construction ? 'Centerline' : 'Line'} ${i + 1} (${e.p1.x}, ${e.p1.y}) → (${e.p2.x}, ${e.p2.y})`;
}

function RevolvePM({ pm, ctx, close, preview, regen }: PMProps & { pm: { kind: 'revolve'; cut: boolean; editId?: string; sketchId?: string } }) {
  const { store } = ctx;
  const existing = pm.editId ? (store.feature(pm.editId) as RevolveFeature | undefined) : undefined;
  const cut = existing ? existing.operation === 'cut' : pm.cut;
  const defThin = store.state.units === 'in' ? '0.05' : '1';
  const [name, setName] = useState(existing?.name ?? '');
  const [sketch, setSketch] = useState(existing?.sketch ?? pm.sketchId ?? '');
  useEffect(() => { if (pm.sketchId) setSketch(pm.sketchId); }, [pm.sketchId]);
  const lines = useMemo(() => ((store.feature(sketch) as SketchFeature | undefined)?.entities ?? []).filter((e) => e.kind === 'line'), [sketch, store.state]);
  const [axisSel, setAxis] = useState(existing?.axisLine ?? '');
  const axis = lines.some((l) => l.id === axisSel) ? axisSel : (lines.find((l) => l.construction)?.id ?? '');
  const [end1, setEnd1] = useState<'blind' | 'midPlane'>(existing?.end ?? 'blind');
  const [reverse, setReverse] = useState(!!existing?.reverse);
  const [angle, setAngle] = useState(String(existing?.angle ?? '360'));
  const [dir2, setDir2] = useState(existing?.angle2 !== undefined);
  const [angle2, setAngle2] = useState(String(existing?.angle2 ?? '90'));
  const [thinOn, setThinOn] = useState<boolean | null>(existing ? !!existing.thin : null);
  const [thinType, setThinType] = useState<RevolveThin['type']>(existing?.thin?.type ?? 'oneDirection');
  const [thinRev, setThinRev] = useState(!!existing?.thin?.reverse);
  const [t1, setT1] = useState(String(existing?.thin?.thickness ?? defThin));
  const [t2, setT2] = useState(String(existing?.thin?.thickness2 ?? defThin));
  // Like mainstream CAD: an open sketch (no closed profile) can only be revolved as a Thin Feature, so it starts checked.
  const loops = regen?.sketches.find((x) => x.id === sketch)?.loops;
  const thin = thinOn ?? loops === 0;
  const hasBody = store.state.features.some((x) => x.type !== 'sketch' && x.id !== existing?.id);
  const operation: RevolveFeature['operation'] = cut ? 'cut' : existing?.operation === 'new' || !hasBody ? 'new' : 'add';
  const defaultName = existing?.name ?? store.nextName(cut ? 'Cut-Revolve' : 'Revolve');
  const useDir2 = dir2 && end1 !== 'midPlane';
  const totalOk = (() => {
    try {
      const p = resolveParams(store.state);
      return evalAngle(angle, p) + (useDir2 ? evalAngle(angle2, p) : 0) <= 2 * Math.PI + 1e-9;
    } catch { return true; }
  })();
  const valid = !!sketch && !!axis && angleOk(store, angle) && (!useDir2 || angleOk(store, angle2)) && totalOk
    && (!thin || (lengthOk(store, t1) && (thinType !== 'twoDirection' || lengthOk(store, t2))));

  const thinDef = (): RevolveThin => ({ type: thinType, thickness: t1, ...(thinType === 'twoDirection' ? { thickness2: t2 } : {}), ...(thinRev && thinType !== 'midPlane' ? { reverse: true } : {}) });
  const feature = (): RevolveFeature => ({
    id: existing?.id ?? PREVIEW_ID, type: 'revolve', name: name.trim() || defaultName, sketch, axisLine: axis, angle, operation,
    ...(end1 === 'midPlane' ? { end: 'midPlane' as const } : {}),
    ...(reverse && end1 !== 'midPlane' ? { reverse: true } : {}),
    ...(useDir2 ? { angle2 } : {}),
    ...(thin ? { thin: thinDef() } : {}),
  });
  useDebouncedPreview(preview, () => (valid ? { doc: draftDoc(store, feature(), existing?.id), id: existing?.id ?? PREVIEW_ID, kind: cut ? 'cut' : 'add' } : null),
    [sketch, axis, angle, end1, reverse, useDir2, angle2, thin, thinType, thinRev, t1, t2, valid, store.state]);

  const ok = () => {
    if (!valid) return;
    const f = feature();
    try {
      if (existing) {
        store.updateFeature(existing.id, {
          name: f.name, sketch, axisLine: axis, angle, operation,
          end: f.end ?? null, reverse: f.reverse ?? null, angle2: f.angle2 ?? null, thin: f.thin ?? null,
        });
      } else {
        store.addRevolve(sketch, axis, angle, { operation, name: name.trim() || undefined, end: f.end, reverse: f.reverse, angle2: f.angle2, thin: f.thin });
      }
      close();
    } catch (e) { ctx.notify((e as Error).message); }
  };

  return (
    <Shell title={existing ? existing.name : cut ? 'Cut-Revolve' : 'Revolve'} icon={cut ? 'revcut' : 'revolve'} onOk={ok} onCancel={close} okDisabled={!valid}
      help={!sketch ? 'Select a sketch with a profile and a centerline.' : !axis ? 'Pick the line to revolve around (Axis of Revolution).'
        : !totalOk ? 'Direction 1 and Direction 2 together cannot be more than 360°.'
        : loops === 0 && !thin ? 'The sketch is open: a solid revolve needs a closed profile. Turn on Thin Feature, or close the sketch.' : undefined}>
      <Section title="Feature name"><input className="pm-input" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} spellCheck={false} /></Section>
      <Section title="Axis of Revolution">
        <select className="pm-select" value={axis} onChange={(e) => setAxis(e.target.value)}>
          {!axis && <option value="">Select a line…</option>}
          {lines.map((l, i) => <option key={l.id} value={l.id}>{lineLabel(l, i)}</option>)}
        </select>
      </Section>
      <Section title="Direction 1">
        <div className="pm-row">
          <button className={`pm-icon-btn ${reverse ? 'on' : ''}`} disabled={end1 === 'midPlane'} title="Reverse Direction" onClick={() => setReverse(!reverse)}>⇅</button>
          <select className="pm-select" value={end1} onChange={(e) => setEnd1(e.target.value as 'blind' | 'midPlane')}>
            <option value="blind">Blind</option>
            <option value="midPlane">Mid Plane</option>
          </select>
        </div>
        <ExprField label={end1 === 'midPlane' ? 'Angle (total, split both sides)' : 'Direction 1 Angle'} kind="angle" value={angle} onChange={setAngle} store={store} />
      </Section>
      <Section title={<label className="check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={useDir2} disabled={end1 === 'midPlane'} onChange={(e) => setDir2(e.target.checked)} /> Direction 2</label>}>
        {useDir2 ? (
          <>
            <div className="pm-row muted">Blind</div>
            <ExprField label="Direction 2 Angle" kind="angle" value={angle2} onChange={setAngle2} store={store} />
          </>
        ) : <div className="pm-row muted">{end1 === 'midPlane' ? 'Not used with Mid Plane.' : 'Revolve the other way from the sketch plane too.'}</div>}
      </Section>
      <Section title={<label className="check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={thin} onChange={(e) => setThinOn(e.target.checked)} /> Thin Feature</label>}>
        {thin ? (
          <>
            <div className="pm-row">
              <button className={`pm-icon-btn ${thinRev ? 'on' : ''}`} disabled={thinType === 'midPlane'} title="Reverse Direction" onClick={() => setThinRev(!thinRev)}>⇅</button>
              <select className="pm-select" value={thinType} onChange={(e) => setThinType(e.target.value as RevolveThin['type'])}>
                <option value="oneDirection">One-Direction</option>
                <option value="midPlane">Mid-Plane</option>
                <option value="twoDirection">Two-Direction</option>
              </select>
            </div>
            <ExprField label={thinType === 'twoDirection' ? 'Direction 1 Thickness' : 'Thickness'} value={t1} onChange={setT1} store={store} />
            {thinType === 'twoDirection' && <ExprField label="Direction 2 Thickness" value={t2} onChange={setT2} store={store} />}
          </>
        ) : <div className="pm-row muted">Make a wall of constant thickness from the sketch curves (open or closed).</div>}
      </Section>
      <Section title="Selected Contours"><SketchSelect store={store} value={sketch} onChange={setSketch} /></Section>
    </Shell>
  );
}

// ------------------------------------------------------------------ Material
function MaterialPM({ ctx, close }: PMProps) {
  const { store } = ctx;
  const cur = store.state.material;
  const [sel, setSel] = useState(cur?.name ?? '');
  const [customName, setCustomName] = useState(cur && !MATERIALS.some((m) => m.name === cur.name) ? cur.name : '');
  const [customDensity, setCustomDensity] = useState(cur && !MATERIALS.some((m) => m.name === cur.name) ? String(cur.density) : '');
  const isCustom = sel === '__custom__';
  const density = isCustom ? Number(customDensity) : MATERIALS.find((m) => m.name === sel)?.density;
  const valid = isCustom ? !!customName.trim() && Number.isFinite(density) && (density as number) > 0 : !!density;
  const metals = MATERIALS.filter((m) => m.density > 2);
  const plastics = MATERIALS.filter((m) => m.density <= 2);
  const ok = () => {
    if (!valid) return;
    store.setMaterial({ name: isCustom ? customName.trim() : sel, density: density as number });
    close();
  };
  const row = (m: { name: string; density: number }) => (
    <div key={m.name} className={`pm-list-item ${sel === m.name ? 'on' : ''}`} onClick={() => setSel(m.name)} onDoubleClick={() => { setSel(m.name); store.setMaterial(m); close(); }}>
      <span>{m.name}</span><span className="muted">{m.density.toFixed(2)} g/cm³</span>
    </div>
  );
  return (
    <Shell title="Material" icon="material" onOk={ok} onCancel={close} okDisabled={!valid} help="Typical room-temperature densities. Pick one or enter your own.">
      <Section title="Metals"><div className="pm-list">{metals.map(row)}</div></Section>
      <Section title="Plastics"><div className="pm-list">{plastics.map(row)}</div></Section>
      <Section title="Custom">
        <label className="check"><input type="radio" checked={isCustom} onChange={() => setSel('__custom__')} /> Custom material</label>
        {isCustom && (
          <div className="grid2">
            <label className="field"><span>Name</span><input value={customName} onChange={(e) => setCustomName(e.target.value)} /></label>
            <label className="field"><span>Density (g/cm³)</span><input value={customDensity} onChange={(e) => setCustomDensity(e.target.value)} className={valid ? '' : 'bad'} /></label>
          </div>
        )}
      </Section>
      {density && valid && <p className="pm-help">{(density / 27.6799047).toFixed(5)} lb/in³ · {(density * 1000).toFixed(0)} kg/m³</p>}
      {cur && <button className="pm-wide" onClick={() => { store.setMaterial(null); close(); }}>Remove material</button>}
    </Shell>
  );
}

// ------------------------------------------------------------------ Mass properties
export function massText(mass: MassProps | null | undefined, doc: Readonly<CadDocument>) {
  if (!mass) return null;
  const u = doc.units, k = MM_PER[u], m = mass;
  const volCm3 = m.volume / 1000;
  const grams = doc.material ? volCm3 * doc.material.density : null;
  return {
    volume: `${(m.volume / k ** 3).toFixed(6)} ${u}³`,
    area: `${(m.area / k ** 2).toFixed(6)} ${u}²`,
    mass: grams === null ? null : u === 'in' ? `${(grams / 453.59237).toFixed(6)} lb` : `${grams.toFixed(4)} g`,
    com: `(${m.centroid.map((c) => fix(c / k)).join(', ')}) ${u}`,
    bbox: `${formatLength(m.bboxMax[0] - m.bboxMin[0], u)} × ${formatLength(m.bboxMax[1] - m.bboxMin[1], u)} × ${formatLength(m.bboxMax[2] - m.bboxMin[2], u)}`,
  };
}

/** Never shows a number from an older or unfinished rebuild (see ./massStatus.ts). */
function MassPM({ ctx, close, massState: st }: PMProps) {
  const doc = ctx.store.state;
  const t = st.kind === 'ready' ? massText(st.mass, doc) : null;
  const failed = st.kind === 'ready' || st.kind === 'noSolid' ? st.failed : [];
  return (
    <Shell title="Mass Properties" icon="mass" onCancel={close} help="Computed from the exact solid (not the display mesh).">
      {st.kind === 'updating' && <p className="pm-help" data-testid="mass-updating">Updating… (the model is being rebuilt; the numbers appear when it is done)</p>}
      {st.kind === 'failed' && <p className="pm-help warn-help" data-testid="mass-failed">Mass properties are not available: the model could not be rebuilt. {st.message}</p>}
      {st.kind === 'noSolid' && <p className="pm-help">There is no solid yet.</p>}
      {failed.length > 0 && (
        <p className="pm-help warn-help" data-testid="mass-failed-features">
          {failed.length === 1 ? '1 feature' : `${failed.length} features`} failed to rebuild and {failed.length === 1 ? 'is' : 'are'} not included in these numbers: {failed.join(', ')}.
        </p>
      )}
      {t && doc.rollback !== null && <p className="pm-help warn-help">The rollback bar is not at the end of the tree: these numbers are for the model as it is shown now, without the features below the bar.</p>}
      {t && (
        <div className="kv" data-testid="mass-values">
          <span>Material</span><span>{doc.material ? `${doc.material.name} (${doc.material.density} g/cm³)` : <a onClick={() => ctx.openPM({ kind: 'material' })}>not set (click to choose)</a>}</span>
          {t.mass && <><span>Mass</span><span>{t.mass}</span></>}
          <span>Volume</span><span>{t.volume}</span>
          <span>Surface area</span><span>{t.area}</span>
          <span>Center of mass</span><span>{t.com}</span>
          <span>Bounding box</span><span>{t.bbox}</span>
        </div>
      )}
    </Shell>
  );
}

// ------------------------------------------------------------------ Measure
export function fix(v: number, d = 4): string { const s = v.toFixed(d); return /^-0\.0+$/.test(s) ? s.slice(1) : s; }

export function InfoView({ info, units }: { info: EntityInfo; units: 'in' | 'mm' }) {
  const L = (mm: number) => formatLength(mm, units);
  const a2 = (mm2: number) => `${(mm2 / MM_PER[units] ** 2).toFixed(6)} ${units}²`;
  const v3 = (p: [number, number, number]) => `(${p.map((c) => fix(c / MM_PER[units])).join(', ')})`;
  const i = info as any;
  if (info.kind === 'face') {
    return (
      <div className="kv">
        <span>Face</span><span>{i.surface}</span>
        <span>Area</span><span>{a2(i.area)}</span>
        {i.surface === 'cylinder' && <><span>Radius</span><span>{L(i.radius)}</span><span>Diameter</span><span>{L(i.radius * 2)}</span></>}
        {i.surface === 'plane' && <><span>Normal</span><span>({i.normal.map((c: number) => fix(c)).join(', ')})</span></>}
      </div>
    );
  }
  return (
    <div className="kv">
      <span>Edge</span><span>{i.curve}</span>
      <span>Length</span><span>{L(i.length)}</span>
      {i.curve === 'circle' && <><span>Radius</span><span>{L(i.radius)}</span><span>Diameter</span><span>{L(i.radius * 2)}</span><span>Center</span><span>{v3(i.center)}</span></>}
      {i.curve === 'line' && <><span>Start</span><span>{v3(i.start)}</span><span>End</span><span>{v3(i.end)}</span></>}
    </div>
  );
}

function MeasurePM({ ctx, close, distance }: PMProps) {
  const u = ctx.store.state.units;
  return (
    <Shell title="Measure" icon="measure" onCancel={close} help="Click a face or edge. Ctrl-click a second one for the distance between them. Values come from the exact geometry.">
      {ctx.infos.map((i, k) => <Section key={k} title={`Selection ${k + 1}`}><InfoView info={i} units={u} /></Section>)}
      {distance !== null && <Section title="Between selections"><div className="kv"><span>Min distance</span><span>{formatLength(distance, u)}</span></div></Section>}
    </Shell>
  );
}

// ------------------------------------------------------------------ Options
function OptionsPM({ close, viewOptions: o, setViewOptions }: PMProps) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const closeAbout = useCallback(() => setAboutOpen(false), []);
  return (
    <Shell title="Options" icon="options" onCancel={close}>
      <Section title="Mouse and view">
        <label className="field"><span>Mouse controls</span>
          <select className="pm-select" value={o.nav} onChange={(e) => setViewOptions({ nav: e.target.value as NavPresetId })}>
            {Object.values(NAV_PRESETS).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={o.reverseWheel} onChange={(e) => setViewOptions({ reverseWheel: e.target.checked })} /> Reverse mouse wheel zoom direction</label>
        <label className="check"><input type="checkbox" checked={o.animateViews} onChange={(e) => setViewOptions({ animateViews: e.target.checked })} /> Animate view changes (orientation, Zoom to Fit, Previous View)</label>
        <p className="pm-help">Laptop trackpad on any preset: Alt+drag rotates, Alt+Shift+drag pans, Alt+Ctrl+drag zooms.</p>
      </Section>
      <Section title="Display">
        <label className="check"><input type="checkbox" checked={o.showEdges} onChange={(e) => setViewOptions({ showEdges: e.target.checked })} /> Shaded with edges</label>
        <label className="check"><input type="checkbox" checked={o.showPlanes} onChange={(e) => setViewOptions({ showPlanes: e.target.checked })} /> Show planes</label>
        <label className="check"><input type="checkbox" checked={o.showSketches} onChange={(e) => setViewOptions({ showSketches: e.target.checked })} /> Show sketches</label>
        <label className="check"><input type="checkbox" checked={o.showOrigin} onChange={(e) => setViewOptions({ showOrigin: e.target.checked })} /> Show origin</label>
      </Section>
      <Section title={`About ${APP_NAME}`}>
        <p className="pm-help" data-testid="about-notices">
          {APP_NAME} uses Open CASCADE Technology (OCCT) for its exact geometry, under the GNU LGPL 2.1 with the Open CASCADE exception,
          the planegcs sketch solver from FreeCAD (GNU LGPL), and other open-source software.
          Licences and notices: <a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">third-party notices</a>.
        </p>
        <button type="button" className="pm-wide" onClick={() => setAboutOpen(true)} data-testid="about-open">About {APP_NAME} and licences…</button>
      </Section>
      {aboutOpen && <AboutModal onClose={closeAbout} />}
    </Shell>
  );
}

// ------------------------------------------------------------------ dispatcher
export function CommandPanel(props: PMProps) {
  const { pm, ctx, close } = props;
  switch (pm.kind) {
    case 'extrude': return <ExtrudePM key={`${pm.editId}-${pm.cut}`} {...props} pm={pm} />;
    case 'revolve': return <RevolvePM key={`${pm.editId}-${pm.cut}`} {...props} pm={pm} />;
    case 'feature': return <FeaturePM key={`${pm.type}-${pm.editId}-${pm.cut}`} {...props} pm={pm} />;
    case 'material': return <MaterialPM {...props} />;
    case 'mass': return <MassPM {...props} />;
    case 'measure': return <MeasurePM {...props} />;
    case 'exportStl': return <ExportStlPM {...props} />;
    case 'exportStep': return <ExportStepPM {...props} />;
    case 'options': return <OptionsPM {...props} />;
    case 'params': return <div className="pm"><ParamsDialog store={ctx.store} onClose={close} /></div>;
    case 'sketch': return (
      <div className="pm">
        <SketchDialog key={pm.editId ?? `${pm.plane}-${pm.offset}`} store={ctx.store} editId={pm.editId} initialPlane={pm.plane} initialOffset={pm.offset} onClose={close} />
      </div>
    );
  }
}
