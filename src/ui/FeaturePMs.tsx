/**
 * Command panels for the modelling features: fillet, chamfer, Hole,
 * linear / circular pattern, mirror, shell, draft, rib, sweep, loft and
 * reference planes, axes and points.
 *
 * Each panel follows the mainstream CAD pattern: selection boxes (the active one
 * is highlighted; clicks in the view add or remove items), value fields that
 * accept expressions, a live translucent preview, ✓ / ✕. Picks become
 * persistent references (src/ui/picks.ts) and the feature is created with the
 * same DocumentStore commands the AI uses (src/core/featureCommands.ts).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DocumentStore } from '../core/store';
import type { CadDocument, Feature, SketchFeature, BasePlane, ValueExpr, BooleanOp } from '../core/model';
import type {
  EdgeRef, FaceRef, PlaneSpec, AxisSpec, Vec3, Vec3Expr, ModelingFeatureType, FilletFeature, ChamferFeature, HoleFeature,
  HoleType, HoleStandard, HoleFit, LinearPatternFeature, CircularPatternFeature, MirrorFeature, ShellFeature, DraftFeature, RibFeature,
  SweepFeature, LoftFeature, RefPlaneFeature, RefAxisFeature, RefPointFeature, RefPlaneDef, RefAxisDef, RefPointDef,
} from '../core/featureTypes';
import * as F from '../core/featureCommands';
import { holeSpec, holeSizes } from '../core/holeTables';
import { MM_PER, evaluate } from '../core/units';
import { resolveParams } from '../core/store';
import { nextLoftSeam } from '../core/loftSeam';
import type { SelRef } from '../kernel/protocol';
import type { Topology } from '../kernel/naming';
import { ExprField } from './dialogs';
import type { AppCtx } from './commands';
import { Shell, Section, lengthOk, angleOk, draftDoc, PREVIEW_ID, SketchSelect, type PMProps } from './CommandPanel';
import {
  edgesFrom, facesFrom, selectionOf, selectionOfPlane, selectionOfAxis, faceIndex, edgeIndex, faceLabel, edgeLabel, planeLabel, axisLabel, faceAxes, toFace2D,
} from './picks';

type FeaturePMState = { kind: 'feature'; type: ModelingFeatureType; editId?: string; cut?: boolean };
type P = PMProps & { pm: FeaturePMState };

// ================================================================== shared plumbing

/** Values typed in a PM are strings; numbers stored in a feature come back as strings for editing. */
const str = (v: ValueExpr | undefined, d = ''): string => (v === undefined ? d : String(v));
const def = (store: DocumentStore, inch: string, mm: string) => (store.state.units === 'in' ? inch : mm);

function intOk(store: DocumentStore, v: string, min = 1): boolean {
  try {
    const n = evaluate(v, resolveParams(store.state), MM_PER[store.state.units]).v;
    return Math.abs(n - Math.round(n)) < 1e-9 && n >= min;
  } catch { return false; }
}

/** Feature id that made a face (from its first tag, e.g. "ho_ab12:wall:0" -> "ho_ab12"). */
const featureOfFace = (t: Topology | null, index: number): string | undefined => t?.faces[index]?.tags[0]?.split('#')[0].split(':')[0];

const SEED_TYPES = new Set(['extrude', 'revolve', 'hole', 'sweep', 'loft', 'rib', 'fillet', 'chamfer']);

/**
 * Wire a PM to viewport clicks and flyout-tree clicks, and keep the viewport
 * highlight equal to what the active box holds.
 */
function usePicking(ctx: AppCtx, h: {
  onPick?(ref: SelRef | null, point: Vec3 | null, sel: SelRef[]): void;
  onTree?(id: string): void;
  highlight(): SelRef[];
}, deps: unknown[]) {
  const hr = useRef(h); hr.current = h;
  const pickSeq = useRef(ctx.pick?.seq ?? 0);
  const treeSeq = useRef(ctx.treePick?.seq ?? 0);
  useEffect(() => {
    const p = ctx.pick;
    if (!p || p.seq === pickSeq.current) return;
    pickSeq.current = p.seq;
    hr.current.onPick?.(p.ref, p.point, ctx.selection);
  }, [ctx.pick?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = ctx.treePick;
    if (!t || t.seq === treeSeq.current) return;
    treeSeq.current = t.seq;
    hr.current.onTree?.(t.id);
  }, [ctx.treePick?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { ctx.setSelection(hr.current.highlight()); }, [...deps, ctx.topoSeq, ctx.pick?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Live preview for modelling features. Always previews (even while the
 * feature is incomplete) so the view shows the model just before the
 * feature, which is what the user picks on.
 */
function useFeaturePreview(p: P, build: () => Feature, complete: boolean, kind: 'add' | 'cut', deps: unknown[]) {
  const { ctx, preview, pm } = p;
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => {
      try {
        const doc = draftDoc(ctx.store, build(), pm.editId);
        preview.show(doc, pm.editId ?? PREVIEW_ID, kind, { topology: true, quiet: !complete });
      } catch { preview.clear(); }
    }, 150);
    return () => { if (t.current) clearTimeout(t.current); };
  }, [...deps, complete, ctx.store.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => preview.clear(), []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Patch that turns `existing` into `next` with updateFeature (null removes keys the new version does not have). */
export function patchFor(existing: Feature, next: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...next };
  for (const k of Object.keys(existing)) if (!(k in next) && k !== 'id' && k !== 'type' && k !== 'suppressed') patch[k] = null;
  return patch;
}

/** OK handler shared by every PM: update in place when editing, else create through the typed command. */
function commit(p: P, existing: Feature | undefined, full: Record<string, unknown>, create: () => string) {
  try {
    if (existing) p.ctx.store.updateFeature(existing.id, patchFor(existing, full));
    else create();
    p.close();
  } catch (e) { p.ctx.notify((e as Error).message); }
}

/** Selection box: the list of picked items. Click it to make it the active box (mainstream CAD pink box). */
function PickBox({ label, active, onActivate, items, onRemove, onClear, empty }: {
  label: string; active: boolean; onActivate(): void;
  items: { text: string; title?: string; missing?: boolean }[];
  onRemove(i: number): void; onClear?(): void; empty: string;
}) {
  return (
    <div className={`pick-box ${active ? 'active' : ''}`} onClick={onActivate} title={active ? 'Active: click items in the view or the flyout tree' : 'Click to make this box active'}>
      <div className="pick-box-head"><span>{label}</span>{items.length > 0 && onClear && <a onClick={(e) => { e.stopPropagation(); onClear(); }}>Clear</a>}</div>
      {items.length === 0 && <div className="pick-empty">{empty}</div>}
      {items.map((it, i) => (
        <div key={i} className={`pick-item ${it.missing ? 'missing' : ''}`} title={it.title ?? it.text}>
          <span>{it.text}{it.missing ? ' (not found)' : ''}</span>
          <button className="pick-x" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(i); }}>✕</button>
        </div>
      ))}
    </div>
  );
}

function NameSection({ name, setName, placeholder }: { name: string; setName(v: string): void; placeholder: string }) {
  return (
    <Section title="Feature name">
      <input className="pm-input" value={name} placeholder={placeholder} onChange={(e) => setName(e.target.value)} spellCheck={false} />
    </Section>
  );
}

function Radio<T extends string>({ value, options, onChange }: { value: T; options: { id: NoInfer<T>; label: string }[]; onChange(v: NoInfer<T>): void }) {
  return (
    <div className="pm-radios">
      {options.map((o) => <label key={o.id} className="check"><input type="radio" checked={value === o.id} onChange={() => onChange(o.id)} /> {o.label}</label>)}
    </div>
  );
}

const BASE_PLANES: { id: BasePlane; label: string }[] = [{ id: 'XZ', label: 'Front Plane' }, { id: 'XY', label: 'Top Plane' }, { id: 'YZ', label: 'Right Plane' }];

function refFeatures(doc: CadDocument, type: 'refPlane' | 'refAxis', before?: string) {
  const end = before ? doc.features.findIndex((f) => f.id === before) : -1;
  return doc.features.filter((f, i) => f.type === type && (end < 0 || i < end));
}

/** Plane chooser: Front/Top/Right, a reference plane, or a picked flat face. */
function PlaneBox({ label, doc, value, onChange, active, onActivate, editId, topo }: {
  label: string; doc: CadDocument; value: PlaneSpec | null; onChange(v: PlaneSpec | null): void; active: boolean; onActivate(): void; editId?: string; topo: Topology | null;
}) {
  const sel = !value ? '' : 'base' in value ? `base:${value.base}` : 'refPlane' in value ? `ref:${value.refPlane}` : 'face';
  const missing = !!value && 'face' in value && topo !== null && faceIndex(topo, value.face) === null;
  return (
    <div className={`pick-box ${active ? 'active' : ''}`} onClick={onActivate}>
      <div className="pick-box-head"><span>{label}</span></div>
      <select className="pm-select" value={sel} onClick={(e) => e.stopPropagation()} onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith('base:')) onChange({ base: v.slice(5) as BasePlane });
        else if (v.startsWith('ref:')) onChange({ refPlane: v.slice(4) });
        else if (!v) onChange(null);
      }}>
        <option value="">{active ? 'Pick a plane or flat face…' : 'Select…'}</option>
        {BASE_PLANES.map((b) => <option key={b.id} value={`base:${b.id}`}>{b.label}</option>)}
        {refFeatures(doc, 'refPlane', editId).map((f) => <option key={f.id} value={`ref:${f.id}`}>{f.name}</option>)}
        {value && 'face' in value && <option value="face">{planeLabel(doc, value)}{missing ? ' (not found)' : ''}</option>}
      </select>
    </div>
  );
}

/** Axis / direction chooser: X/Y/Z, a reference axis, or a picked edge or cylindrical face. */
function AxisBox({ label, doc, value, onChange, active, onActivate, editId }: {
  label: string; doc: CadDocument; value: AxisSpec | null; onChange(v: AxisSpec | null): void; active: boolean; onActivate(): void; editId?: string;
}) {
  const sel = !value ? '' : 'axis' in value ? `axis:${value.axis}` : 'refAxis' in value ? `ref:${value.refAxis}` : 'picked';
  return (
    <div className={`pick-box ${active ? 'active' : ''}`} onClick={onActivate}>
      <div className="pick-box-head"><span>{label}</span></div>
      <select className="pm-select" value={sel} onClick={(e) => e.stopPropagation()} onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith('axis:')) onChange({ axis: v.slice(5) as 'X' | 'Y' | 'Z' });
        else if (v.startsWith('ref:')) onChange({ refAxis: v.slice(4) });
        else if (!v) onChange(null);
      }}>
        <option value="">{active ? 'Pick an edge or round face…' : 'Select…'}</option>
        {(['X', 'Y', 'Z'] as const).map((a) => <option key={a} value={`axis:${a}`}>{a} axis</option>)}
        {refFeatures(doc, 'refAxis', editId).map((f) => <option key={f.id} value={`ref:${f.id}`}>{f.name}</option>)}
        {value && ('edge' in value || 'face' in value) && <option value="picked">{axisLabel(doc, value)}</option>}
      </select>
    </div>
  );
}

/** Plane spec from a click (base plane, or a flat face) or a tree click (base or reference plane). */
function planeFromPick(t: Topology | null, ref: SelRef | null): PlaneSpec | null | 'bad' {
  if (!ref) return null;
  if (ref.kind === 'plane') return { base: ref.plane };
  if (ref.kind === 'face' && t?.faces[ref.index]) return t.faces[ref.index].surface === 'plane' ? { face: facesFrom(t, [ref])[0] } : 'bad';
  return 'bad';
}
function planeFromTree(doc: CadDocument, id: string): PlaneSpec | null {
  if (id.startsWith('plane:')) return { base: id.slice(6) as BasePlane };
  return doc.features.find((f) => f.id === id)?.type === 'refPlane' ? { refPlane: id } : null;
}
function axisFromPick(t: Topology | null, ref: SelRef | null): AxisSpec | null | 'bad' {
  if (!ref || !t) return null;
  if (ref.kind === 'edge' && t.edges[ref.index]) {
    const c = t.edges[ref.index].curve;
    return c === 'line' || c === 'circle' ? { edge: edgesFrom(t, [ref])[0] } : 'bad';
  }
  if (ref.kind === 'face' && t.faces[ref.index]) {
    const s = t.faces[ref.index].surface;
    return s === 'cylinder' || s === 'cone' ? { face: facesFrom(t, [ref])[0] } : 'bad';
  }
  return 'bad';
}

function faceItems(doc: CadDocument, t: Topology | null, refs: FaceRef[]) {
  return refs.map((r, i) => ({ text: `Face<${i + 1}>`, title: faceLabel(doc, r), missing: t !== null && faceIndex(t, r) === null }));
}
function edgeItems(doc: CadDocument, t: Topology | null, refs: EdgeRef[]) {
  return refs.map((r, i) => ({ text: `Edge<${i + 1}>`, title: edgeLabel(doc, r), missing: t !== null && edgeIndex(t, r) === null }));
}

function useExisting<T extends Feature>(p: P): T | undefined {
  return p.pm.editId ? (p.ctx.store.feature(p.pm.editId) as T | undefined) : undefined;
}

/** Name state: blank means "use the default name". */
function useName(existing: Feature | undefined) {
  return useState(existing?.name ?? '');
}

function hasSolidBefore(store: DocumentStore, editId?: string) {
  const feats = store.state.features;
  const end = editId ? feats.findIndex((f) => f.id === editId) : store.insertIndex();
  return feats.slice(0, end < 0 ? feats.length : end).some((f) => !f.suppressed && !['sketch', 'refPlane', 'refAxis', 'refPoint'].includes(f.type));
}

// ================================================================== Fillet
function FilletPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<FilletFeature>(p);
  const topo = ctx.pickTopology();
  const [name, setName] = useName(ex);
  const [kind, setKind] = useState<FilletFeature['kind']>(ex?.kind ?? 'constant');
  const initSel = useRef(ex ? null : ctx.selection);
  const [edges, setEdges] = useState<EdgeRef[]>(ex?.edges ?? edgesFrom(topo, initSel.current ?? []));
  const [faces, setFaces] = useState<FaceRef[]>(ex?.faces ?? (kind === 'constant' ? facesFrom(topo, initSel.current ?? []) : []));
  const [faces2, setFaces2] = useState<FaceRef[]>(ex?.faces2 ?? []);
  const [faces3, setFaces3] = useState<FaceRef[]>(ex?.faces3 ?? []);
  const [r1, setR1] = useState(str(ex?.radius, def(store, '0.0625', '1.5')));
  const [r2, setR2] = useState(str(ex?.radius2, def(store, '0.125', '3')));
  const [active, setActive] = useState<'items' | 'set2' | 'set3'>('items');
  const round = kind === 'fullRound';

  const complete = round ? faces.length === 1 && faces2.length === 1 && faces3.length === 1 : kind === 'face' ? faces.length > 0 && faces2.length > 0 : kind === 'variable' ? edges.length > 0 : edges.length + faces.length > 0;
  const valid = complete && (round || lengthOk(store, r1)) && (kind !== 'variable' || lengthOk(store, r2));
  const defaultName = ex?.name ?? store.nextName(kind === 'variable' ? 'VarFillet' : kind === 'face' ? 'FaceFillet' : round ? 'FullRoundFillet' : 'Fillet');

  const full = (): Omit<FilletFeature, 'id'> => ({
    type: 'fillet', name: name.trim() || defaultName, kind,
    edges: kind === 'face' || round ? [] : edges,
    ...(kind === 'constant' && faces.length ? { faces } : {}),
    ...(kind === 'face' ? { faces, faces2 } : {}),
    ...(round ? { faces, faces2, faces3 } : {}),
    radius: round ? 0 : r1, ...(kind === 'variable' ? { radius2: r2 } : {}),
  });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'add', [kind, edges, faces, faces2, faces3, r1, r2]);

  usePicking(ctx, {
    onPick(_ref, _pt, sel) {
      const t = ctx.pickTopology();
      if (round) {
        // One face per box: a new pick replaces it, then the next box becomes active.
        const picked = facesFrom(t, sel, []).slice(-1);
        if (!picked.length) return;
        if (active === 'items') { setFaces(picked); setActive('set2'); } else if (active === 'set2') { setFaces2(picked); setActive('set3'); } else setFaces3(picked);
        return;
      }
      if (kind === 'face') {
        if (active === 'items') setFaces((k) => facesFrom(t, sel, k)); else setFaces2((k) => facesFrom(t, sel, k));
        return;
      }
      setEdges((k) => edgesFrom(t, sel, k));
      if (kind === 'constant') setFaces((k) => facesFrom(t, sel, k));
    },
    highlight() {
      const t = ctx.pickTopology();
      if (round) return selectionOf(t, { faces: active === 'items' ? faces : active === 'set2' ? faces2 : faces3 });
      if (kind === 'face') return selectionOf(t, { faces: active === 'items' ? faces : faces2 });
      return selectionOf(t, { edges, faces: kind === 'constant' ? faces : [] });
    },
  }, [kind, active, edges, faces, faces2, faces3]);

  const ok = () => valid && commit(p, ex, full(), () => (round
    ? F.addFullRoundFillet(store, { faces, faces2, faces3, name: name.trim() || undefined })
    : kind === 'variable'
    ? F.addVariableFillet(store, { edges, radius: r1, radius2: r2, name: name.trim() || undefined })
    : kind === 'face' ? F.addFaceFillet(store, { faces, faces2, radius: r1, name: name.trim() || undefined })
    : F.addFillet(store, { edges, faces, radius: r1, name: name.trim() || undefined })));

  const switchKind = (k: FilletFeature['kind']) => {
    setKind(k); setActive('items');
    if (k === 'face' || k === 'fullRound') { setEdges([]); setFaces([]); setFaces2([]); setFaces3([]); } else if (kind === 'face' || kind === 'fullRound') { setFaces([]); setFaces2([]); setFaces3([]); }
    if (k === 'variable') setFaces([]);
  };
  return (
    <Shell title={ex ? ex.name : 'Fillet'} icon="fillet" onOk={ok} onCancel={p.close} okDisabled={!valid}
      help={!complete ? (round ? 'Pick side face 1, then side face 2, then the center face (the face the round replaces). The sides must be flat and parallel.' : kind === 'face' ? 'Pick the faces of set 1, then click the second box and pick set 2.' : kind === 'variable' ? 'Click the edges to round.' : 'Click the edges (or faces: all their edges) to round.') : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Fillet Type">
        <Radio value={kind} onChange={switchKind} options={[{ id: 'constant', label: 'Constant size' }, { id: 'variable', label: 'Variable size' }, { id: 'face', label: 'Face fillet' }, { id: 'fullRound', label: 'Full round fillet' }]} />
      </Section>
      <Section title="Items To Fillet">
        {round ? (
          <>
            <PickBox label="Side face 1" active={active === 'items'} onActivate={() => setActive('items')} items={faceItems(doc, topo, faces)} onRemove={() => setFaces([])} onClear={() => setFaces([])} empty="Pick a face" />
            <PickBox label="Center face" active={active === 'set3'} onActivate={() => setActive('set3')} items={faceItems(doc, topo, faces3)} onRemove={() => setFaces3([])} onClear={() => setFaces3([])} empty="Pick a face" />
            <PickBox label="Side face 2" active={active === 'set2'} onActivate={() => setActive('set2')} items={faceItems(doc, topo, faces2)} onRemove={() => setFaces2([])} onClear={() => setFaces2([])} empty="Pick a face" />
          </>
        ) : kind === 'face' ? (
          <>
            <PickBox label="Face set 1" active={active === 'items'} onActivate={() => setActive('items')} items={faceItems(doc, topo, faces)} onRemove={(i) => setFaces(faces.filter((_, j) => j !== i))} onClear={() => setFaces([])} empty="Pick faces" />
            <PickBox label="Face set 2" active={active === 'set2'} onActivate={() => setActive('set2')} items={faceItems(doc, topo, faces2)} onRemove={(i) => setFaces2(faces2.filter((_, j) => j !== i))} onClear={() => setFaces2([])} empty="Pick faces" />
          </>
        ) : (
          <PickBox label={kind === 'variable' ? 'Edges' : 'Edges and faces'} active onActivate={() => setActive('items')}
            items={[...edgeItems(doc, topo, edges), ...faceItems(doc, topo, kind === 'constant' ? faces : [])]}
            onRemove={(i) => (i < edges.length ? setEdges(edges.filter((_, j) => j !== i)) : setFaces(faces.filter((_, j) => j !== i - edges.length)))}
            onClear={() => { setEdges([]); setFaces([]); }} empty="Pick edges" />
        )}
      </Section>
      {!round && <Section title="Fillet Parameters">
        {kind === 'variable' ? (
          <>
            <ExprField label="Start radius" value={r1} onChange={setR1} store={store} />
            <ExprField label="End radius" value={r2} onChange={setR2} store={store} />
            <button className="pm-wide" onClick={() => { setR1(r2); setR2(r1); }}>⇄ Swap start and end</button>
          </>
        ) : <ExprField label="Radius" value={r1} onChange={setR1} store={store} />}
      </Section>}
      {round && <p className="pm-help">The radius is half the distance between the side faces, and follows it when the part changes.</p>}
    </Shell>
  );
}

// ================================================================== Chamfer
function ChamferPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<ChamferFeature>(p);
  const topo = ctx.pickTopology();
  const [name, setName] = useName(ex);
  const [kind, setKind] = useState<ChamferFeature['kind']>(ex?.kind ?? 'equal');
  const initSel = useRef(ex ? [] : ctx.selection);
  const [edges, setEdges] = useState<EdgeRef[]>(ex?.edges ?? edgesFrom(topo, initSel.current));
  const [faces, setFaces] = useState<FaceRef[]>(ex?.faces ?? facesFrom(topo, initSel.current));
  const [d1, setD1] = useState(str(ex?.distance, def(store, '0.03', '0.5')));
  const [d2, setD2] = useState(str(ex?.distance2, def(store, '0.06', '1')));
  const [ang, setAng] = useState(str(ex?.angle, '45'));
  const [flip, setFlip] = useState(!!ex?.flip);
  const complete = edges.length + faces.length > 0;
  const valid = complete && lengthOk(store, d1) && (kind !== 'distances' || lengthOk(store, d2)) && (kind !== 'angle' || angleOk(store, ang));
  const defaultName = ex?.name ?? store.nextName('Chamfer');
  const full = (): Omit<ChamferFeature, 'id'> => ({
    type: 'chamfer', name: name.trim() || defaultName, kind, edges, ...(faces.length ? { faces } : {}), distance: d1,
    ...(kind === 'distances' ? { distance2: d2 } : {}), ...(kind === 'angle' ? { angle: ang } : {}), ...(flip && kind !== 'equal' ? { flip: true } : {}),
  });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'add', [kind, edges, faces, d1, d2, ang, flip]);
  usePicking(ctx, {
    onPick(_r, _pt, sel) { const t = ctx.pickTopology(); setEdges((k) => edgesFrom(t, sel, k)); setFaces((k) => facesFrom(t, sel, k)); },
    highlight: () => selectionOf(ctx.pickTopology(), { edges, faces }),
  }, [edges, faces]);
  const ok = () => valid && commit(p, ex, full(), () => F.addChamfer(store, { edges, faces, kind, distance: d1, distance2: kind === 'distances' ? d2 : undefined, angle: kind === 'angle' ? ang : undefined, flip: flip && kind !== 'equal', name: name.trim() || undefined }));
  return (
    <Shell title={ex ? ex.name : 'Chamfer'} icon="chamfer" onOk={ok} onCancel={p.close} okDisabled={!valid} help={!complete ? 'Click the edges (or faces: all their edges) to bevel.' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Chamfer Type">
        <Radio value={kind} onChange={setKind} options={[{ id: 'equal', label: 'Equal distance' }, { id: 'distances', label: 'Two distances' }, { id: 'angle', label: 'Angle-distance' }]} />
      </Section>
      <Section title="Items To Chamfer">
        <PickBox label="Edges and faces" active onActivate={() => {}} items={[...edgeItems(doc, topo, edges), ...faceItems(doc, topo, faces)]}
          onRemove={(i) => (i < edges.length ? setEdges(edges.filter((_, j) => j !== i)) : setFaces(faces.filter((_, j) => j !== i - edges.length)))}
          onClear={() => { setEdges([]); setFaces([]); }} empty="Pick edges" />
      </Section>
      <Section title="Chamfer Parameters">
        <ExprField label={kind === 'equal' ? 'Distance' : 'Distance 1'} value={d1} onChange={setD1} store={store} />
        {kind === 'distances' && <ExprField label="Distance 2" value={d2} onChange={setD2} store={store} />}
        {kind === 'angle' && <ExprField label="Angle" kind="angle" value={ang} onChange={setAng} store={store} />}
        {kind !== 'equal' && <label className="check"><input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Flip direction</label>}
      </Section>
    </Shell>
  );
}

// ================================================================== Hole
const HOLE_TYPES: { id: HoleType; label: string }[] = [
  { id: 'counterbore', label: 'Counterbore' }, { id: 'countersink', label: 'Countersink' }, { id: 'simple', label: 'Hole' }, { id: 'tapped', label: 'Tapped' },
];

function HolePM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state; const u = doc.units;
  const ex = useExisting<HoleFeature>(p);
  const topo = ctx.pickTopology();
  const [name, setName] = useName(ex);
  const [holeType, setHoleType] = useState<HoleType>(ex?.holeType ?? 'counterbore');
  const [standard, setStandard] = useState<HoleStandard>(ex?.standard ?? (u === 'in' ? 'ansi-inch' : 'iso-metric'));
  const sizes = useMemo(() => holeSizes(standard, holeType), [standard, holeType]);
  const [size, setSizeRaw] = useState(ex?.size ?? '');
  const sizeOk = sizes.includes(size);
  const curSize = sizeOk ? size : (sizes.includes(standard === 'ansi-inch' ? (holeType === 'tapped' ? '1/4-20' : '1/4') : 'M6') ? (standard === 'ansi-inch' ? (holeType === 'tapped' ? '1/4-20' : '1/4') : 'M6') : sizes[0]);
  const [fit, setFit] = useState<HoleFit>(ex?.fit ?? 'normal');
  const [end, setEnd] = useState<'blind' | 'through'>(ex?.end ?? 'through');
  const [depth, setDepth] = useState(str(ex?.depth, def(store, '0.5', '12')));
  const [threadDepth, setThreadDepth] = useState(str(ex?.threadDepth));
  const [flip, setFlip] = useState(!!ex?.flip);
  const initFace = !ex && ctx.selection[0]?.kind === 'face' ? planeFromPick(topo, ctx.selection[0]) : null;
  const [placement, setPlacement] = useState<PlaneSpec | null>(ex?.placement ?? (initFace && initFace !== 'bad' ? initFace : null));
  const k = MM_PER[u];
  const fmt = (mm: number) => String(+(mm / k).toFixed(u === 'in' ? 4 : 3));
  const faceCenterPoint = (pl: PlaneSpec | null): { x: string; y: string }[] => {
    if (!pl || !('face' in pl)) return [];
    const fi = faceIndex(topo, pl.face); const f = fi !== null ? topo?.faces[fi] : undefined;
    if (!f?.normal) return [];
    const [x, y] = toFace2D(f.normal, f.center);
    return [{ x: fmt(x), y: fmt(y) }];
  };
  const [points, setPoints] = useState<{ x: string; y: string }[]>(ex?.points.map((q) => ({ x: String(q.x), y: String(q.y) })) ?? faceCenterPoint(placement));
  const [active, setActive] = useState<'face' | 'points'>(placement ? 'points' : 'face');

  let spec: ReturnType<typeof holeSpec> | null = null; let specErr = '';
  try { spec = holeSpec(standard, holeType, curSize, fit); } catch (e) { specErr = (e as Error).message; }

  // 2D axis names for the points on this placement.
  const axes = (() => {
    if (!placement) return { u: 'X', v: 'Y' };
    if ('base' in placement) return placement.base === 'XY' ? { u: 'X', v: 'Y' } : placement.base === 'XZ' ? { u: 'X', v: 'Z' } : { u: 'Y', v: 'Z' };
    if ('face' in placement) { const fi = faceIndex(topo, placement.face); const a = faceAxes(fi !== null ? topo?.faces[fi]?.normal : undefined); if (a) return a; }
    return { u: 'u', v: 'v' };
  })();

  const pointsOk = points.length > 0 && points.every((q) => lengthOrZero(store, q.x) && lengthOrZero(store, q.y));
  const complete = !!placement && points.length > 0;
  const valid = complete && pointsOk && !!spec && (end === 'through' || holeType === 'tapped' || lengthOk(store, depth)) && (!threadDepth || lengthOk(store, threadDepth));
  const defaultName = ex?.name ?? store.nextName(spec?.label ?? 'Hole');

  const full = (): Omit<HoleFeature, 'id'> => ({
    type: 'hole', name: name.trim() || defaultName, holeType, standard, size: curSize, ...(fit !== 'normal' ? { fit } : {}), end,
    ...(end === 'blind' && (holeType !== 'tapped' || depth) ? { depth } : {}),
    ...(holeType === 'tapped' && end === 'blind' && threadDepth ? { threadDepth } : {}),
    placement: placement ?? { base: 'XY' }, points: points.map((q) => ({ x: q.x, y: q.y })), ...(flip ? { flip: true } : {}),
  });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'cut', [holeType, standard, curSize, fit, end, depth, threadDepth, flip, placement, points]);

  usePicking(ctx, {
    onPick(ref, pt) {
      const t = ctx.pickTopology();
      if (active === 'face' || !placement) {
        const pl = planeFromPick(t, ref);
        if (pl === 'bad') { ctx.notify('Place holes on a flat face or a plane.'); return; }
        if (!pl) return;
        setPlacement(pl);
        if (!points.length) setPoints(faceCenterPoint(pl));
        setActive('points');
        return;
      }
      // Positions: a click on the placement face adds a hole there.
      if (ref?.kind === 'face' && pt && 'face' in placement && faceIndex(t, placement.face) === ref.index) {
        const f = t!.faces[ref.index];
        const [x, y] = toFace2D(f.normal!, pt);
        setPoints((ps) => [...ps, { x: fmt(x), y: fmt(y) }]);
      } else if (ref) ctx.notify('Click on the placement face to add a hole there, or type the coordinates.');
    },
    onTree(id) { const pl = planeFromTree(doc, id); if (pl) { setPlacement(pl); setActive('points'); } },
    highlight: () => selectionOfPlane(ctx.pickTopology(), placement),
  }, [placement, active]);

  const ok = () => valid && commit(p, ex, full(), () => F.addHole(store, {
    holeType, standard, size: curSize, fit, end, depth: end === 'blind' ? depth : undefined, threadDepth: holeType === 'tapped' && end === 'blind' && threadDepth ? threadDepth : undefined,
    placement: placement!, points, flip, name: name.trim() || undefined,
  }));
  const su = spec?.unit ?? 'in';
  const v = (x?: number) => (x === undefined ? '' : `${su === 'in' ? x.toFixed(4) : x.toFixed(2)} ${su}`);

  return (
    <Shell title={ex ? ex.name : 'Hole Specification'} icon="hole" onOk={ok} onCancel={p.close} okDisabled={!valid}
      help={!placement ? 'Click the flat face (or plane) the holes start on.' : !points.length ? 'Click on the face where each hole goes, or add points and type their coordinates.' : specErr || undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Hole Type">
        <div className="pm-row wrap">
          {HOLE_TYPES.map((h) => <button key={h.id} className={`pm-chip ${holeType === h.id ? 'on' : ''}`} onClick={() => setHoleType(h.id)}>{h.label}</button>)}
        </div>
        <label className="field"><span>Standard</span>
          <select className="pm-select" value={standard} onChange={(e) => setStandard(e.target.value as HoleStandard)}>
            <option value="ansi-inch">ANSI Inch</option><option value="iso-metric">ISO Metric</option>
          </select>
        </label>
      </Section>
      <Section title="Hole Specifications">
        <label className="field"><span>Size</span>
          <select className="pm-select" value={curSize} onChange={(e) => setSizeRaw(e.target.value)}>
            {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {holeType !== 'tapped' && (
          <label className="field"><span>Fit</span>
            <select className="pm-select" value={fit} onChange={(e) => setFit(e.target.value as HoleFit)}>
              <option value="close">Close</option><option value="normal">Normal</option>{standard === 'iso-metric' && <option value="loose">Loose</option>}
            </select>
          </label>
        )}
        {spec && (
          <div className="kv">
            <span>{holeType === 'tapped' ? 'Tap drill' : 'Diameter'}</span><span>{v(spec.diameter)}{spec.thread ? ` (${spec.thread.drill})` : ''}</span>
            {spec.cboreDiameter !== undefined && <><span>C'bore dia</span><span>{v(spec.cboreDiameter)}</span><span>C'bore depth</span><span>{v(spec.cboreDepth)}</span></>}
            {spec.cskDiameter !== undefined && <><span>C'sink dia</span><span>{v(spec.cskDiameter)}</span><span>C'sink angle</span><span>{spec.cskAngle}°</span></>}
            {spec.thread && <><span>Thread</span><span>{spec.thread.callout}</span></>}
          </div>
        )}
      </Section>
      <Section title="End Condition">
        <select className="pm-select" value={end} onChange={(e) => setEnd(e.target.value as 'blind' | 'through')}>
          <option value="through">Through All</option><option value="blind">Blind</option>
        </select>
        {end === 'blind' && <ExprField label={holeType === 'tapped' ? 'Drill depth (blank = thread depth + 3 pitches)' : 'Depth'} value={depth} onChange={setDepth} store={store} />}
        {end === 'blind' && holeType === 'tapped' && (
          <label className="field"><span>Thread depth (blank = 2 × diameter)</span><input value={threadDepth} onChange={(e) => setThreadDepth(e.target.value)} spellCheck={false} /></label>
        )}
        <label className="check"><input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Reverse direction</label>
      </Section>
      <Section title="Positions">
        <PlaneBox label="Placement face or plane" doc={doc} value={placement} onChange={setPlacement} active={active === 'face'} onActivate={() => setActive('face')} editId={ex?.id} topo={topo} />
        <div className={`pick-box ${active === 'points' ? 'active' : ''}`} onClick={() => setActive('points')}>
          <div className="pick-box-head"><span>Hole centers ({axes.u}, {axes.v} in {u})</span>{points.length > 0 && <a onClick={(e) => { e.stopPropagation(); setPoints([]); }}>Clear</a>}</div>
          {points.map((q, i) => (
            <div key={i} className="pm-point">
              <span>{axes.u}</span><input value={q.x} onChange={(e) => setPoints(points.map((r, j) => (j === i ? { ...r, x: e.target.value } : r)))} className={lengthOrZero(store, q.x) ? '' : 'bad'} />
              <span>{axes.v}</span><input value={q.y} onChange={(e) => setPoints(points.map((r, j) => (j === i ? { ...r, y: e.target.value } : r)))} className={lengthOrZero(store, q.y) ? '' : 'bad'} />
              <button className="pick-x" title="Remove" onClick={(e) => { e.stopPropagation(); setPoints(points.filter((_, j) => j !== i)); }}>✕</button>
            </div>
          ))}
          <button className="pm-wide" onClick={(e) => { e.stopPropagation(); setPoints([...points, points.at(-1) ?? { x: '0', y: '0' }]); }}>Add point</button>
        </div>
      </Section>
    </Shell>
  );
}

function lengthOrZero(store: DocumentStore, v: string): boolean {
  if (/^\s*-?0*(\.0*)?\s*$/.test(v) && v.trim() !== '' && v.trim() !== '-') return true;
  if (lengthOk(store, v)) return true;
  // Negative coordinates.
  const t = v.trim();
  return t.startsWith('-') && lengthOk(store, t.slice(1));
}

// ================================================================== Seed features (patterns, mirror)
function useSeeds(p: P, initial: string[] | undefined) {
  const { store } = p.ctx;
  const pre = p.pm.editId ? [] : p.ctx.treeSel.filter((id) => SEED_TYPES.has(store.feature(id)?.type ?? ''));
  return useState<string[]>(initial ?? pre);
}
function toggleSeed(store: DocumentStore, seeds: string[], id: string | undefined, self?: string): string[] {
  if (!id || id === self) return seeds;
  const f = store.feature(id);
  if (!f || !SEED_TYPES.has(f.type)) return seeds;
  return seeds.includes(id) ? seeds.filter((x) => x !== id) : [...seeds, id];
}
function SeedBox({ store, seeds, setSeeds, body, setBody, active, onActivate }: {
  store: DocumentStore; seeds: string[]; setSeeds(s: string[]): void; body: boolean; setBody(b: boolean): void; active: boolean; onActivate(): void;
}) {
  return (
    <>
      <label className="check"><input type="checkbox" checked={body} onChange={(e) => setBody(e.target.checked)} /> Whole body</label>
      {!body && (
        <PickBox label="Features" active={active} onActivate={onActivate} items={seeds.map((id) => ({ text: store.feature(id)?.name ?? id, missing: !store.feature(id) }))}
          onRemove={(i) => setSeeds(seeds.filter((_, j) => j !== i))} onClear={() => setSeeds([])} empty="Click features in the flyout tree, or a face of the feature" />
      )}
    </>
  );
}

// ================================================================== Linear pattern
function LinearPatternPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<LinearPatternFeature>(p);
  const [name, setName] = useName(ex);
  const [seeds, setSeeds] = useSeeds(p, ex?.features);
  const [body, setBody] = useState(!!ex?.body);
  const [dir1, setDir1] = useState<AxisSpec | null>(ex?.dir1 ?? { axis: 'X' });
  const [flip1, setFlip1] = useState(!!ex?.flip1);
  const [sp1, setSp1] = useState(str(ex?.spacing1, def(store, '1', '25')));
  const [n1, setN1] = useState(str(ex?.count1, '3'));
  const [use2, setUse2] = useState(!!ex?.dir2);
  const [dir2, setDir2] = useState<AxisSpec | null>(ex?.dir2 ?? { axis: 'Y' });
  const [flip2, setFlip2] = useState(!!ex?.flip2);
  const [sp2, setSp2] = useState(str(ex?.spacing2, def(store, '1', '25')));
  const [n2, setN2] = useState(str(ex?.count2, '2'));
  const [skipAll, setSkip] = useState<[number, number][]>(ex?.skip ?? []);
  const [active, setActive] = useState<'seeds' | 'dir1' | 'dir2'>(seeds.length || body ? 'dir1' : 'seeds');
  const c1 = intVal(store, n1), c2 = use2 ? intVal(store, n2) : null;
  // Only positions that exist with the current counts are kept.
  const skip = skipAll.filter(([i, j]) => c1 !== null && i < c1 && (use2 ? c2 !== null && j < c2 : j === 0));
  const complete = (body || seeds.length > 0) && !!dir1 && (!use2 || !!dir2);
  const valid = complete && lengthOk(store, sp1) && intOk(store, n1) && (!use2 || (lengthOk(store, sp2) && intOk(store, n2)));
  const defaultName = ex?.name ?? store.nextName('LPattern');
  const full = (): Omit<LinearPatternFeature, 'id'> => ({
    type: 'linearPattern', name: name.trim() || defaultName, features: body ? [] : seeds, ...(body ? { body: true } : {}),
    dir1: dir1 ?? { axis: 'X' }, ...(flip1 ? { flip1: true } : {}), spacing1: sp1, count1: n1,
    ...(use2 ? { dir2: dir2 ?? { axis: 'Y' }, ...(flip2 ? { flip2: true } : {}), spacing2: sp2, count2: n2 } : {}),
    ...(skip.length ? { skip } : {}),
  });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'add', [seeds, body, dir1, flip1, sp1, n1, use2, dir2, flip2, sp2, n2, JSON.stringify(skip)]);
  usePicking(ctx, {
    onPick(ref) {
      const t = ctx.pickTopology();
      if (active === 'seeds') { if (ref?.kind === 'face') setSeeds(toggleSeed(store, seeds, featureOfFace(t, ref.index), ex?.id)); return; }
      const a = axisFromPick(t, ref);
      if (a === 'bad') { ctx.notify('Pick a straight edge (or a round face or circular edge) for the direction.'); return; }
      if (a) (active === 'dir1' ? setDir1 : setDir2)(a);
    },
    onTree(id) {
      if (active === 'seeds' || doc.features.find((f) => f.id === id)?.type !== 'refAxis') { setSeeds(toggleSeed(store, seeds, id, ex?.id)); return; }
      (active === 'dir1' ? setDir1 : setDir2)({ refAxis: id });
    },
    highlight: () => selectionOfAxis(ctx.pickTopology(), active === 'dir1' ? dir1 : active === 'dir2' ? dir2 : null),
  }, [active, seeds, dir1, dir2]);
  const ok = () => valid && commit(p, ex, full(), () => F.addLinearPattern(store, {
    features: seeds, body, dir1: dir1!, flip1, spacing1: sp1, count1: n1,
    ...(use2 ? { dir2: dir2!, flip2, spacing2: sp2, count2: n2 } : {}), ...(skip.length ? { skip } : {}), name: name.trim() || undefined,
  }));
  return (
    <Shell title={ex ? ex.name : 'Linear Pattern'} icon="lpattern" onOk={ok} onCancel={p.close} okDisabled={!valid}
      help={!body && !seeds.length ? 'Pick the features to copy (flyout tree or a face of the feature).' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Direction 1">
        <div className="pm-row"><button className={`pm-icon-btn ${flip1 ? 'on' : ''}`} title="Reverse Direction" onClick={() => setFlip1(!flip1)}>⇅</button>
          <div style={{ flex: 1 }}><AxisBox label="Direction" doc={doc} value={dir1} onChange={setDir1} active={active === 'dir1'} onActivate={() => setActive('dir1')} editId={ex?.id} /></div></div>
        <ExprField label="Spacing" value={sp1} onChange={setSp1} store={store} />
        <label className="field"><span>Number of instances</span><input value={n1} onChange={(e) => setN1(e.target.value)} className={intOk(store, n1) ? '' : 'bad'} /></label>
      </Section>
      <Section title={<label className="check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={use2} onChange={(e) => setUse2(e.target.checked)} /> Direction 2</label>}>
        {use2 ? (
          <>
            <div className="pm-row"><button className={`pm-icon-btn ${flip2 ? 'on' : ''}`} title="Reverse Direction" onClick={() => setFlip2(!flip2)}>⇅</button>
              <div style={{ flex: 1 }}><AxisBox label="Direction" doc={doc} value={dir2} onChange={setDir2} active={active === 'dir2'} onActivate={() => setActive('dir2')} editId={ex?.id} /></div></div>
            <ExprField label="Spacing" value={sp2} onChange={setSp2} store={store} />
            <label className="field"><span>Number of instances</span><input value={n2} onChange={(e) => setN2(e.target.value)} className={intOk(store, n2) ? '' : 'bad'} /></label>
          </>
        ) : <div className="pm-row muted">Make a grid by copying along a second direction too.</div>}
      </Section>
      <Section title="Features and Bodies">
        <SeedBox store={store} seeds={seeds} setSeeds={setSeeds} body={body} setBody={setBody} active={active === 'seeds'} onActivate={() => setActive('seeds')} />
      </Section>
      <Section title={`Instances to Skip${skip.length ? ` (${skip.length})` : ''}`}>
        <SkipSection n1={c1} n2={c2} skip={skip} setSkip={setSkip} />
      </Section>
    </Shell>
  );
}

// ------------------------------------------------------------------ Instances to Skip
function intVal(store: DocumentStore, v: string, min = 1): number | null {
  if (!intOk(store, v, min)) return null;
  return Math.round(evaluate(v, resolveParams(store.state), MM_PER[store.state.units]).v);
}

/**
 * Mainstream CAD "Instances to Skip": every instance position is listed by its
 * (Direction 1, Direction 2) number, 1-based like mainstream CAD shows them; the
 * seed (1, 1) cannot be skipped. Large patterns take typed positions instead.
 */
function SkipSection({ n1, n2, skip, setSkip }: { n1: number | null; n2: number | null; skip: [number, number][]; setSkip(s: [number, number][]): void }) {
  const [text, setText] = useState('');
  if (!n1) return <div className="pm-row muted">Set a valid number of instances first.</div>;
  const rows = n2 ?? 1;
  const has = (i: number, j: number) => skip.some(([a, b]) => a === i && b === j);
  const toggle = (i: number, j: number) => setSkip(has(i, j) ? skip.filter(([a, b]) => a !== i || b !== j) : [...skip, [i, j]].sort((x, y) => x[1] - y[1] || x[0] - y[0]) as [number, number][]);
  const label = (i: number, j: number) => (n2 ? `(${i + 1}, ${j + 1})` : `${i + 1}`);
  if (n1 * rows > 144) {
    const add = () => {
      const m = text.match(/^\s*\(?\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)?\s*$/);
      if (!m) return;
      const i = +m[1] - 1, j = m[2] ? +m[2] - 1 : 0;
      if (i < 0 || j < 0 || i >= n1 || j >= rows || (i === 0 && j === 0) || has(i, j)) return;
      toggle(i, j); setText('');
    };
    return (
      <>
        <div className="pick-box active">
          {skip.length === 0 && <div className="pick-empty">No instances skipped</div>}
          {skip.map(([i, j]) => <div key={`${i},${j}`} className="pick-item"><span>{label(i, j)}</span><button className="pick-x" title="Keep this instance" onClick={() => toggle(i, j)}>✕</button></div>)}
        </div>
        <label className="field"><span>{n2 ? 'Skip instance (Dir 1, Dir 2), Enter' : 'Skip instance number, Enter'}</span>
          <input value={text} placeholder={n2 ? '2, 1' : '2'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(); } }} /></label>
      </>
    );
  }
  return (
    <>
      <div className="pm-row muted">Uncheck an instance to skip it.{n2 ? ' Rows are Direction 2, columns Direction 1.' : ''}</div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(n1, 8)}, auto)`, gap: '2px 6px', justifyContent: 'start' }}>
        {Array.from({ length: rows }, (_, j) => Array.from({ length: n1 }, (_, i) => (
          <label key={`${i},${j}`} className="check" title={i === 0 && j === 0 ? 'Seed (cannot be skipped)' : `Instance ${label(i, j)}`}>
            <input type="checkbox" checked={!has(i, j)} disabled={i === 0 && j === 0} onChange={() => toggle(i, j)} /> {label(i, j)}
          </label>
        )))}
      </div>
    </>
  );
}

// ================================================================== Circular pattern
function CircularPatternPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<CircularPatternFeature>(p);
  const [name, setName] = useName(ex);
  const [seeds, setSeeds] = useSeeds(p, ex?.features);
  const [body, setBody] = useState(!!ex?.body);
  const [axis, setAxis] = useState<AxisSpec | null>(ex?.axis ?? { axis: 'Z' });
  const [flip, setFlip] = useState(!!ex?.flip);
  const [n, setN] = useState(str(ex?.count, '6'));
  const [angle, setAngle] = useState(str(ex?.angle, '360'));
  const [equal, setEqual] = useState(ex?.equalSpacing ?? true);
  const [skipAll, setSkip] = useState<number[]>(ex?.skip ?? []);
  const [active, setActive] = useState<'seeds' | 'axis'>(seeds.length || body ? 'axis' : 'seeds');
  const cn = intVal(store, n, 2);
  const skip = skipAll.filter((i) => cn !== null && i > 0 && i < cn);
  const complete = (body || seeds.length > 0) && !!axis;
  const valid = complete && intOk(store, n, 2) && angleOk(store, angle);
  const defaultName = ex?.name ?? store.nextName('CirPattern');
  const full = (): Omit<CircularPatternFeature, 'id'> => ({
    type: 'circularPattern', name: name.trim() || defaultName, features: body ? [] : seeds, ...(body ? { body: true } : {}),
    axis: axis ?? { axis: 'Z' }, ...(flip ? { flip: true } : {}), count: n, angle, equalSpacing: equal, ...(skip.length ? { skip } : {}),
  });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'add', [seeds, body, axis, flip, n, angle, equal, JSON.stringify(skip)]);
  usePicking(ctx, {
    onPick(ref) {
      const t = ctx.pickTopology();
      if (active === 'seeds') { if (ref?.kind === 'face') setSeeds(toggleSeed(store, seeds, featureOfFace(t, ref.index), ex?.id)); return; }
      const a = axisFromPick(t, ref);
      if (a === 'bad') { ctx.notify('Pick a round face, a circular edge or a straight edge for the axis.'); return; }
      if (a) setAxis(a);
    },
    onTree(id) {
      if (active === 'axis' && doc.features.find((f) => f.id === id)?.type === 'refAxis') { setAxis({ refAxis: id }); return; }
      setSeeds(toggleSeed(store, seeds, id, ex?.id));
    },
    highlight: () => (active === 'axis' ? selectionOfAxis(ctx.pickTopology(), axis) : []),
  }, [active, seeds, axis]);
  const ok = () => valid && commit(p, ex, full(), () => F.addCircularPattern(store, { features: seeds, body, axis: axis!, flip, count: n, angle, equalSpacing: equal, ...(skip.length ? { skip } : {}), name: name.trim() || undefined }));
  return (
    <Shell title={ex ? ex.name : 'Circular Pattern'} icon="cpattern" onOk={ok} onCancel={p.close} okDisabled={!valid}
      help={!body && !seeds.length ? 'Pick the features to copy (flyout tree or a face of the feature).' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Direction 1">
        <div className="pm-row"><button className={`pm-icon-btn ${flip ? 'on' : ''}`} title="Reverse Direction" onClick={() => setFlip(!flip)}>⇅</button>
          <div style={{ flex: 1 }}><AxisBox label="Axis" doc={doc} value={axis} onChange={setAxis} active={active === 'axis'} onActivate={() => setActive('axis')} editId={ex?.id} /></div></div>
        <Radio value={equal ? 'equal' : 'step'} onChange={(v) => setEqual(v === 'equal')} options={[{ id: 'equal', label: 'Equal spacing (total angle)' }, { id: 'step', label: 'Angle between instances' }]} />
        <ExprField label={equal ? 'Total angle' : 'Angle between instances'} kind="angle" value={angle} onChange={setAngle} store={store} />
        <label className="field"><span>Number of instances</span><input value={n} onChange={(e) => setN(e.target.value)} className={intOk(store, n, 2) ? '' : 'bad'} /></label>
      </Section>
      <Section title="Features and Bodies">
        <SeedBox store={store} seeds={seeds} setSeeds={setSeeds} body={body} setBody={setBody} active={active === 'seeds'} onActivate={() => setActive('seeds')} />
      </Section>
      <Section title={`Instances to Skip${skip.length ? ` (${skip.length})` : ''}`}>
        <SkipSection n1={cn} n2={null} skip={skip.map((i) => [i, 0] as [number, number])} setSkip={(v) => setSkip(v.map(([i]) => i).sort((a, b) => a - b))} />
      </Section>
    </Shell>
  );
}

// ================================================================== Mirror
function MirrorPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<MirrorFeature>(p);
  const topo = ctx.pickTopology();
  const [name, setName] = useName(ex);
  const [seeds, setSeeds] = useSeeds(p, ex?.features);
  const [body, setBody] = useState(!!ex?.body);
  const initPlane = !ex && ctx.selection[0] ? planeFromPick(topo, ctx.selection[0]) : null;
  const [plane, setPlane] = useState<PlaneSpec | null>(ex?.plane ?? (initPlane && initPlane !== 'bad' ? initPlane : null));
  const [active, setActive] = useState<'plane' | 'seeds'>(plane ? 'seeds' : 'plane');
  const complete = (body || seeds.length > 0) && !!plane;
  const defaultName = ex?.name ?? store.nextName('Mirror');
  const full = (): Omit<MirrorFeature, 'id'> => ({ type: 'mirror', name: name.trim() || defaultName, features: body ? [] : seeds, ...(body ? { body: true } : {}), plane: plane ?? { base: 'YZ' } });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), complete, 'add', [seeds, body, plane]);
  usePicking(ctx, {
    onPick(ref) {
      const t = ctx.pickTopology();
      if (active === 'seeds') { if (ref?.kind === 'face') setSeeds(toggleSeed(store, seeds, featureOfFace(t, ref.index), ex?.id)); return; }
      const pl = planeFromPick(t, ref);
      if (pl === 'bad') { ctx.notify('Mirror about a plane or a flat face.'); return; }
      if (pl) { setPlane(pl); setActive('seeds'); }
    },
    onTree(id) {
      const pl = planeFromTree(doc, id);
      if (active === 'plane' && pl) { setPlane(pl); setActive('seeds'); return; }
      setSeeds(toggleSeed(store, seeds, id, ex?.id));
    },
    highlight: () => (active === 'plane' ? selectionOfPlane(ctx.pickTopology(), plane) : []),
  }, [active, plane, seeds]);
  const ok = () => complete && commit(p, ex, full(), () => F.addMirror(store, { features: seeds, body, plane: plane!, name: name.trim() || undefined }));
  return (
    <Shell title={ex ? ex.name : 'Mirror'} icon="mirror" onOk={ok} onCancel={p.close} okDisabled={!complete}
      help={!plane ? 'Pick the mirror plane (a plane or flat face).' : !body && !seeds.length ? 'Pick the features to mirror, or tick Whole body.' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Mirror Face/Plane">
        <PlaneBox label="Plane" doc={doc} value={plane} onChange={setPlane} active={active === 'plane'} onActivate={() => setActive('plane')} editId={ex?.id} topo={topo} />
      </Section>
      <Section title="Features and Bodies">
        <SeedBox store={store} seeds={seeds} setSeeds={setSeeds} body={body} setBody={setBody} active={active === 'seeds'} onActivate={() => setActive('seeds')} />
      </Section>
    </Shell>
  );
}

// ================================================================== Shell
function ShellPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<ShellFeature>(p);
  const topo = ctx.pickTopology();
  const [name, setName] = useName(ex);
  const [faces, setFaces] = useState<FaceRef[]>(ex?.faces ?? facesFrom(topo, ex ? [] : ctx.selection));
  const [t, setT] = useState(str(ex?.thickness, def(store, '0.06', '1.5')));
  const [outward, setOutward] = useState(!!ex?.outward);
  const valid = lengthOk(store, t);
  const defaultName = ex?.name ?? store.nextName('Shell');
  const full = (): Omit<ShellFeature, 'id'> => ({ type: 'shell', name: name.trim() || defaultName, faces, thickness: t, ...(outward ? { outward: true } : {}) });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'cut', [faces, t, outward]);
  usePicking(ctx, {
    onPick(_r, _pt, sel) { setFaces((k) => facesFrom(ctx.pickTopology(), sel, k)); },
    highlight: () => selectionOf(ctx.pickTopology(), { faces }),
  }, [faces]);
  const ok = () => valid && commit(p, ex, full(), () => F.addShell(store, { faces, thickness: t, outward, name: name.trim() || undefined }));
  return (
    <Shell title={ex ? ex.name : 'Shell'} icon="shell" onOk={ok} onCancel={p.close} okDisabled={!valid}
      help={!faces.length ? 'Pick the faces to remove (open faces). With none picked the part becomes a closed hollow shell.' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Parameters">
        <ExprField label="Wall thickness" value={t} onChange={setT} store={store} />
        <PickBox label="Faces to remove" active onActivate={() => {}} items={faceItems(doc, topo, faces)} onRemove={(i) => setFaces(faces.filter((_, j) => j !== i))} onClear={() => setFaces([])} empty="None (closed shell)" />
        <label className="check"><input type="checkbox" checked={outward} onChange={(e) => setOutward(e.target.checked)} /> Shell outward (keeps the inside size)</label>
      </Section>
    </Shell>
  );
}

// ================================================================== Draft
function DraftPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<DraftFeature>(p);
  const topo = ctx.pickTopology();
  const [name, setName] = useName(ex);
  const [neutral, setNeutral] = useState<PlaneSpec | null>(ex?.neutral ?? null);
  const [faces, setFaces] = useState<FaceRef[]>(ex?.faces ?? []);
  const [angle, setAngle] = useState(str(ex?.angle, '3'));
  const [flip, setFlip] = useState(!!ex?.flip);
  const [active, setActive] = useState<'neutral' | 'faces'>(neutral ? 'faces' : 'neutral');
  const complete = !!neutral && faces.length > 0;
  const valid = complete && angleOk(store, angle);
  const defaultName = ex?.name ?? store.nextName('Draft');
  const full = (): Omit<DraftFeature, 'id'> => ({ type: 'draft', name: name.trim() || defaultName, faces, neutral: neutral ?? { base: 'XY' }, angle, ...(flip ? { flip: true } : {}) });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'cut', [neutral, faces, angle, flip]);
  usePicking(ctx, {
    onPick(ref, _pt, sel) {
      const t = ctx.pickTopology();
      if (active === 'neutral') {
        const pl = planeFromPick(t, ref);
        if (pl === 'bad') { ctx.notify('The neutral plane must be a plane or a flat face.'); return; }
        if (pl) { setNeutral(pl); setActive('faces'); }
        return;
      }
      setFaces((k) => facesFrom(t, sel, k));
    },
    onTree(id) { const pl = planeFromTree(doc, id); if (pl) { setNeutral(pl); setActive('faces'); } },
    highlight: () => (active === 'neutral' ? selectionOfPlane(ctx.pickTopology(), neutral) : selectionOf(ctx.pickTopology(), { faces })),
  }, [active, neutral, faces]);
  const ok = () => valid && commit(p, ex, full(), () => F.addDraft(store, { faces, neutral: neutral!, angle, flip, name: name.trim() || undefined }));
  return (
    <Shell title={ex ? ex.name : 'Draft'} icon="draft" onOk={ok} onCancel={p.close} okDisabled={!valid}
      help={!neutral ? 'Pick the neutral plane (faces keep their size where they cross it).' : !faces.length ? 'Pick the faces to draft.' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Draft Angle"><ExprField label="Angle" kind="angle" value={angle} onChange={setAngle} store={store} /></Section>
      <Section title="Neutral Plane">
        <div className="pm-row"><button className={`pm-icon-btn ${flip ? 'on' : ''}`} title="Reverse Direction" onClick={() => setFlip(!flip)}>⇅</button>
          <div style={{ flex: 1 }}><PlaneBox label="Neutral plane" doc={doc} value={neutral} onChange={setNeutral} active={active === 'neutral'} onActivate={() => setActive('neutral')} editId={ex?.id} topo={topo} /></div></div>
      </Section>
      <Section title="Faces to Draft">
        <PickBox label="Faces" active={active === 'faces'} onActivate={() => setActive('faces')} items={faceItems(doc, topo, faces)} onRemove={(i) => setFaces(faces.filter((_, j) => j !== i))} onClear={() => setFaces([])} empty="Pick faces" />
      </Section>
    </Shell>
  );
}

// ================================================================== Rib
function RibPM(p: P) {
  const { ctx } = p; const { store } = ctx;
  const ex = useExisting<RibFeature>(p);
  const [name, setName] = useName(ex);
  const pre = !ex ? ctx.treeSel.find((id) => store.feature(id)?.type === 'sketch') : undefined;
  const [sketch, setSketch] = useState(ex?.sketch ?? pre ?? '');
  const [t, setT] = useState(str(ex?.thickness, def(store, '0.1', '2.5')));
  const [side, setSide] = useState<NonNullable<RibFeature['side']>>(ex?.side ?? 'both');
  const [direction, setDirection] = useState<RibFeature['direction']>(ex?.direction ?? 'parallel');
  const [flip, setFlip] = useState(!!ex?.flip);
  const valid = !!sketch && lengthOk(store, t);
  const defaultName = ex?.name ?? store.nextName('Rib');
  const full = (): Omit<RibFeature, 'id'> => ({ type: 'rib', name: name.trim() || defaultName, sketch, thickness: t, side, direction, ...(flip ? { flip: true } : {}) });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'add', [sketch, t, side, direction, flip]);
  usePicking(ctx, { onTree(id) { if (store.feature(id)?.type === 'sketch') setSketch(id); }, highlight: () => [] }, []);
  const ok = () => valid && commit(p, ex, full(), () => F.addRib(store, { sketch, thickness: t, side, direction, flip, name: name.trim() || undefined }));
  return (
    <Shell title={ex ? ex.name : 'Rib'} icon="rib" onOk={ok} onCancel={p.close} okDisabled={!valid} help={!sketch ? 'Pick the sketch with the rib line (an open line from wall to wall).' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Parameters">
        <ExprField label="Thickness" value={t} onChange={setT} store={store} />
        <label className="field"><span>Thickness side</span>
          <select className="pm-select" value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
            <option value="both">Both sides (centered)</option><option value="left">First side</option><option value="right">Second side</option>
          </select>
        </label>
        <Radio value={direction} onChange={setDirection} options={[{ id: 'parallel', label: 'Parallel to sketch' }, { id: 'normal', label: 'Normal to sketch' }]} />
        <label className="check"><input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Flip material side</label>
      </Section>
      <Section title="Selected Contours"><SketchSelect store={store} value={sketch} onChange={setSketch} /></Section>
    </Shell>
  );
}

// ================================================================== Sweep
function opFor(store: DocumentStore, cut: boolean, editId?: string, current?: BooleanOp): BooleanOp {
  if (cut) return 'cut';
  if (current === 'new') return 'new';
  return hasSolidBefore(store, editId) ? 'add' : 'new';
}

function SweepPM(p: P) {
  const { ctx } = p; const { store } = ctx;
  const ex = useExisting<SweepFeature>(p);
  const cut = ex ? ex.operation === 'cut' : !!p.pm.cut;
  const [name, setName] = useName(ex);
  const sel = ctx.treeSel.filter((id) => store.feature(id)?.type === 'sketch');
  // Mainstream CAD Sweep command panel: Sketch Profile or Circular Profile (a diameter, no profile sketch).
  const [circular, setCircular] = useState(!!ex?.circular);
  const [diameter, setDiameter] = useState(String(ex?.circular?.diameter ?? (store.state.units === 'in' ? '0.25' : '6')));
  const [profile, setProfile] = useState(ex?.profile || sel[0] || '');
  const [path, setPath] = useState(ex?.path ?? (ex?.circular ? sel[0] : sel[1]) ?? '');
  const [orientation, setOrientation] = useState<NonNullable<SweepFeature['orientation']>>(ex?.orientation ?? 'followPath');
  const [active, setActive] = useState<'profile' | 'path'>(circular || (profile && !path) ? 'path' : 'profile');
  const operation = opFor(store, cut, ex?.id, ex?.operation);
  const valid = !!path && (circular ? lengthOk(store, diameter) : !!profile && profile !== path);
  const defaultName = ex?.name ?? store.nextName(cut ? 'Cut-Sweep' : 'Boss-Sweep');
  const full = (): Omit<SweepFeature, 'id'> => ({
    type: 'sweep', name: name.trim() || defaultName, profile: circular ? '' : profile, path, operation,
    ...(circular ? { circular: { diameter } } : {}),
    ...(orientation === 'keepNormal' ? { orientation } : {}),
  });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, cut ? 'cut' : 'add', [profile, path, operation, circular, diameter, orientation]);
  usePicking(ctx, {
    onTree(id) {
      if (store.feature(id)?.type !== 'sketch') return;
      if (active === 'profile' && !circular) { setProfile(id); setActive('path'); } else setPath(id);
    },
    highlight: () => [],
  }, [active, circular]);
  const ok = () => valid && commit(p, ex, full(), () => F.addSweep(store, {
    path, operation, name: name.trim() || undefined,
    ...(circular ? { circular: { diameter } } : { profile }),
    ...(orientation === 'keepNormal' ? { orientation } : {}),
  }));
  return (
    <Shell title={ex ? ex.name : cut ? 'Cut-Sweep' : 'Sweep'} icon={cut ? 'sweepCut' : 'sweep'} onOk={ok} onCancel={p.close} okDisabled={!valid}
      help={!circular && !profile ? 'Pick the profile sketch (one closed loop), or choose Circular Profile.' : !path ? 'Pick the path sketch (it should start on the profile plane).' : !circular && profile === path ? 'The profile and the path must be different sketches.' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Profile and Path">
        <label className="check"><input type="radio" checked={!circular} onChange={() => { setCircular(false); setActive(profile ? 'path' : 'profile'); }} /> Sketch Profile</label>
        <label className="check"><input type="radio" checked={circular} onChange={() => { setCircular(true); setActive('path'); }} /> Circular Profile</label>
        {!circular && <div className={`pick-box ${active === 'profile' ? 'active' : ''}`} onClick={() => setActive('profile')}><div className="pick-box-head"><span>Profile</span></div><SketchSelect store={store} value={profile} onChange={setProfile} /></div>}
        <div className={`pick-box ${active === 'path' ? 'active' : ''}`} onClick={() => setActive('path')}><div className="pick-box-head"><span>Path</span></div><SketchSelect store={store} value={path} onChange={setPath} /></div>
        {circular && <ExprField label="Diameter" value={diameter} onChange={setDiameter} store={store} />}
      </Section>
      <Section title="Options">
        <div className="pm-row muted">Profile orientation</div>
        <select className="pm-select" value={orientation} onChange={(e) => setOrientation(e.target.value as NonNullable<SweepFeature['orientation']>)}>
          <option value="followPath">Follow Path</option>
          <option value="keepNormal">Keep Normal Constant</option>
        </select>
      </Section>
    </Shell>
  );
}

// ================================================================== Loft
/**
 * Loft properties the Loft panel does not show or edit: an edited loft keeps its own tips and
 * seam (else saving the panel would drop them), and a new loft previews with the seam it will get.
 */
export function loftKept(ex: LoftFeature | undefined, features: readonly Feature[]): Partial<LoftFeature> {
  if (!ex) return { seam: nextLoftSeam(features) };
  const out: Partial<LoftFeature> = {};
  for (const k of ['startPoint', 'endPoint', 'startTip', 'endTip', 'seam'] as const) if (ex[k] !== undefined) (out as any)[k] = ex[k];
  return out;
}

function LoftPM(p: P) {
  const { ctx } = p; const { store } = ctx;
  const ex = useExisting<LoftFeature>(p);
  const cut = ex ? ex.operation === 'cut' : !!p.pm.cut;
  const [name, setName] = useName(ex);
  const [profiles, setProfiles] = useState<string[]>(ex?.profiles ?? ctx.treeSel.filter((id) => store.feature(id)?.type === 'sketch'));
  const [ruled, setRuled] = useState(!!ex?.ruled);
  const [adding, setAdding] = useState('');
  const operation = opFor(store, cut, ex?.id, ex?.operation);
  const valid = profiles.length >= 2;
  const defaultName = ex?.name ?? store.nextName(cut ? 'Cut-Loft' : 'Boss-Loft');
  const full = (): Omit<LoftFeature, 'id'> => ({ type: 'loft', name: name.trim() || defaultName, profiles, operation, ...(ruled ? { ruled: true } : {}), ...loftKept(ex, store.state.features) });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, cut ? 'cut' : 'add', [profiles, ruled, operation]);
  const toggle = (id: string) => setProfiles((ps) => (ps.includes(id) ? ps.filter((x) => x !== id) : [...ps, id]));
  usePicking(ctx, { onTree(id) { if (store.feature(id)?.type === 'sketch') toggle(id); }, highlight: () => [] }, []);
  const move = (i: number, d: number) => setProfiles((ps) => { const n = [...ps]; const j = i + d; if (j < 0 || j >= n.length) return ps; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const ok = () => valid && commit(p, ex, full(), () => F.addLoft(store, { profiles, ruled, operation, name: name.trim() || undefined }));
  const sketches = store.state.features.filter((f): f is SketchFeature => f.type === 'sketch' && !profiles.includes(f.id));
  return (
    <Shell title={ex ? ex.name : cut ? 'Cut-Loft' : 'Loft'} icon={cut ? 'loftCut' : 'loft'} onOk={ok} onCancel={p.close} okDisabled={!valid}
      help={profiles.length < 2 ? 'Pick two or more profile sketches in order (flyout tree or the list below).' : undefined}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Profiles">
        <div className="pick-box active">
          {profiles.length === 0 && <div className="pick-empty">No profiles yet</div>}
          {profiles.map((id, i) => (
            <div key={id} className="pick-item">
              <span>{i + 1}. {store.feature(id)?.name ?? id}</span>
              <span>
                <button className="pick-x" title="Move up" onClick={() => move(i, -1)}>▲</button>
                <button className="pick-x" title="Move down" onClick={() => move(i, 1)}>▼</button>
                <button className="pick-x" title="Remove" onClick={() => toggle(id)}>✕</button>
              </span>
            </div>
          ))}
          {sketches.length > 0 && (
            <select className="pm-select" value={adding} onChange={(e) => { if (e.target.value) toggle(e.target.value); setAdding(''); }}>
              <option value="">Add a profile sketch…</option>
              {sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>
      </Section>
      <Section title="Options"><label className="check"><input type="checkbox" checked={ruled} onChange={(e) => setRuled(e.target.checked)} /> Ruled (straight between sections)</label></Section>
    </Shell>
  );
}

// ================================================================== Reference geometry
function Vec3Fields({ label, v, onChange, store }: { label: string; v: Vec3Expr; onChange(v: Vec3Expr): void; store: DocumentStore }) {
  return (
    <div className="pm-point three">
      <span className="pm-point-label">{label}</span>
      {(['x', 'y', 'z'] as const).map((c) => (
        <label key={c}><span>{c.toUpperCase()}</span><input value={String(v[c])} onChange={(e) => onChange({ ...v, [c]: e.target.value })} className={lengthOrZero(store, String(v[c])) ? '' : 'bad'} /></label>
      ))}
    </div>
  );
}
const vecOk = (store: DocumentStore, v: Vec3Expr) => (['x', 'y', 'z'] as const).every((c) => lengthOrZero(store, String(v[c])));
const zero = (): Vec3Expr => ({ x: '0', y: '0', z: '0' });

function RefPlanePM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<RefPlaneFeature>(p);
  const topo = ctx.pickTopology();
  const d = ex?.def;
  const [name, setName] = useName(ex);
  const [kind, setKind] = useState<RefPlaneDef['kind']>(d?.kind ?? 'offset');
  const initPlane = !ex && ctx.selection[0] ? planeFromPick(topo, ctx.selection[0]) : null;
  const [from, setFrom] = useState<PlaneSpec | null>(d && (d.kind === 'offset' || d.kind === 'angle') ? d.from : initPlane && initPlane !== 'bad' ? initPlane : null);
  const [b, setB] = useState<PlaneSpec | null>(d?.kind === 'midplane' ? d.b : null);
  const [axis, setAxis] = useState<AxisSpec | null>(d?.kind === 'angle' ? d.axis : null);
  const [dist, setDist] = useState(str(d?.kind === 'offset' ? d.distance : undefined, def(store, '1', '25')));
  const [flip, setFlip] = useState(d?.kind === 'offset' && !!d.flip);
  const [angle, setAngle] = useState(str(d?.kind === 'angle' ? d.angle : undefined, '45'));
  const [pts, setPts] = useState<[Vec3Expr, Vec3Expr, Vec3Expr]>(d?.kind === 'threePoints' ? d.points : [zero(), { x: '1', y: '0', z: '0' }, { x: '0', y: '1', z: '0' }]);
  const [curve, setCurve] = useState(d?.kind === 'normalToCurve' ? d.sketch : '');
  const [curveAt, setCurveAt] = useState<'start' | 'end'>(d?.kind === 'normalToCurve' ? d.at : 'end');
  const [atPoint, setAtPoint] = useState<Vec3Expr>(d?.kind === 'parallelAtPoint' && !('refPoint' in d.point) ? d.point : zero());
  const [atRef, setAtRef] = useState(d?.kind === 'parallelAtPoint' && 'refPoint' in d.point ? d.point.refPoint : '');
  const refPoints = doc.features.filter((f) => f.type === 'refPoint' && f.id !== ex?.id);
  const [active, setActive] = useState<'from' | 'b' | 'axis'>(from ? (kind === 'midplane' ? 'b' : kind === 'angle' ? 'axis' : 'from') : 'from');
  const built = (): RefPlaneDef | null => {
    if (kind === 'offset') return from ? { kind, from, distance: dist, ...(flip ? { flip: true } : {}) } : null;
    if (kind === 'angle') return from && axis ? { kind, from, axis, angle } : null;
    if (kind === 'midplane') return from && b ? { kind, a: from, b } : null;
    if (kind === 'normalToCurve') return curve ? { kind, sketch: curve, at: curveAt } : null;
    if (kind === 'parallelAtPoint') return from ? { kind, from, point: atRef ? { refPoint: atRef } : atPoint } : null;
    return { kind, points: pts };
  };
  const df = built();
  const valid = !!df && (kind !== 'offset' || lengthOk(store, dist)) && (kind !== 'angle' || angleOk(store, angle)) && (kind !== 'threePoints' || pts.every((q) => vecOk(store, q)))
    && (kind !== 'parallelAtPoint' || !!atRef || vecOk(store, atPoint));
  const defaultName = ex?.name ?? store.nextName('Plane');
  const full = (): Omit<RefPlaneFeature, 'id'> => ({ type: 'refPlane', name: name.trim() || defaultName, def: df ?? { kind: 'offset', from: { base: 'XY' }, distance: 0 } });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'add', [kind, from, b, axis, dist, flip, angle, pts, curve, curveAt, atPoint, atRef]);
  usePicking(ctx, {
    onPick(ref) {
      const t = ctx.pickTopology();
      if (active === 'axis') { const a = axisFromPick(t, ref); if (a === 'bad') ctx.notify('Pick a straight edge for the axis.'); else if (a) setAxis(a); return; }
      const pl = planeFromPick(t, ref);
      if (pl === 'bad') { ctx.notify('Pick a plane or a flat face.'); return; }
      if (!pl) return;
      if (active === 'from') { setFrom(pl); if (kind === 'midplane') setActive('b'); if (kind === 'angle') setActive('axis'); } else setB(pl);
    },
    onTree(id) {
      if (kind === 'normalToCurve') { if (store.feature(id)?.type === 'sketch') setCurve(id); return; }
      if (kind === 'parallelAtPoint' && store.feature(id)?.type === 'refPoint') { setAtRef(id); return; }
      if (active === 'axis') { if (store.feature(id)?.type === 'refAxis') setAxis({ refAxis: id }); return; }
      const pl = planeFromTree(doc, id); if (!pl) return;
      if (active === 'from') setFrom(pl); else setB(pl);
    },
    highlight: () => { const t = ctx.pickTopology(); return active === 'axis' ? selectionOfAxis(t, axis) : selectionOfPlane(t, active === 'b' ? b : from); },
  }, [active, from, b, axis, kind, curve]);
  const ok = () => valid && df && commit(p, ex, full(), () => F.addRefPlane(store, df, name.trim() || undefined));
  return (
    <Shell title={ex ? ex.name : 'Plane'} icon="refPlane" onOk={ok} onCancel={p.close} okDisabled={!valid}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Type">
        <Radio value={kind} onChange={(k) => { setKind(k); setActive('from'); }} options={[{ id: 'offset', label: 'Offset distance' }, { id: 'angle', label: 'At angle' }, { id: 'midplane', label: 'Mid plane' }, { id: 'threePoints', label: 'Through 3 points' }, { id: 'parallelAtPoint', label: 'Parallel at point' }, { id: 'normalToCurve', label: 'Normal to curve' }]} />
      </Section>
      {kind === 'normalToCurve' && (
        <Section title="Curve">
          <SketchSelect store={store} value={curve} onChange={setCurve} />
          <Radio value={curveAt} onChange={setCurveAt} options={[{ id: 'start', label: 'At the start point' }, { id: 'end', label: 'At the end point' }]} />
          <div className="pm-row muted">Pick the path sketch (flyout tree or the list). The plane is square to the curve at that end, ready for a sweep profile. If it shows at the wrong end, pick the other end.</div>
        </Section>
      )}
      {kind !== 'threePoints' && kind !== 'normalToCurve' && (
        <Section title="First Reference">
          <PlaneBox label="Plane or flat face" doc={doc} value={from} onChange={setFrom} active={active === 'from'} onActivate={() => setActive('from')} editId={ex?.id} topo={topo} />
          {kind === 'offset' && <><ExprField label="Distance" value={dist} onChange={setDist} store={store} /><label className="check"><input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Flip offset</label></>}
          {kind === 'angle' && <><AxisBox label="Hinge axis (in the plane)" doc={doc} value={axis} onChange={setAxis} active={active === 'axis'} onActivate={() => setActive('axis')} editId={ex?.id} /><ExprField label="Angle" kind="angle" value={angle} onChange={setAngle} store={store} /></>}
        </Section>
      )}
      {kind === 'parallelAtPoint' && (
        <Section title="Second Reference (point)">
          {refPoints.length > 0 && (
            <select className="pm-select" value={atRef} onChange={(e) => setAtRef(e.target.value)}>
              <option value="">Coordinates below</option>
              {refPoints.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
          {!atRef && <Vec3Fields label={`Point (${doc.units})`} v={atPoint} store={store} onChange={setAtPoint} />}
        </Section>
      )}
      {kind === 'midplane' && (
        <Section title="Second Reference"><PlaneBox label="Parallel plane or flat face" doc={doc} value={b} onChange={setB} active={active === 'b'} onActivate={() => setActive('b')} editId={ex?.id} topo={topo} /></Section>
      )}
      {kind === 'threePoints' && (
        <Section title={`Points (${doc.units})`}>
          {pts.map((q, i) => <Vec3Fields key={i} label={`Point ${i + 1}`} v={q} store={store} onChange={(nv) => setPts(pts.map((r, j) => (j === i ? nv : r)) as typeof pts)} />)}
        </Section>
      )}
    </Shell>
  );
}

function RefAxisPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<RefAxisFeature>(p);
  const topo = ctx.pickTopology();
  const d = ex?.def;
  const [name, setName] = useName(ex);
  const [kind, setKind] = useState<RefAxisDef['kind']>(d?.kind ?? 'entity');
  const init = !ex && ctx.selection[0] ? axisFromPick(topo, ctx.selection[0]) : null;
  const [of, setOf] = useState<AxisSpec | null>(d?.kind === 'entity' ? d.of : init && init !== 'bad' ? init : null);
  const [a, setA] = useState<PlaneSpec | null>(d?.kind === 'twoPlanes' ? d.a : null);
  const [b, setB] = useState<PlaneSpec | null>(d?.kind === 'twoPlanes' ? d.b : null);
  const [p1, setP1] = useState<Vec3Expr>(d?.kind === 'twoPoints' ? d.p1 : zero());
  const [p2, setP2] = useState<Vec3Expr>(d?.kind === 'twoPoints' ? d.p2 : { x: '0', y: '0', z: '1' });
  const [active, setActive] = useState<'of' | 'a' | 'b'>(kind === 'twoPlanes' ? 'a' : 'of');
  const df: RefAxisDef | null = kind === 'entity' ? (of ? { kind, of } : null) : kind === 'twoPlanes' ? (a && b ? { kind, a, b } : null) : { kind, p1, p2 };
  const valid = !!df && (kind !== 'twoPoints' || (vecOk(store, p1) && vecOk(store, p2)));
  const defaultName = ex?.name ?? store.nextName('Axis');
  const full = (): Omit<RefAxisFeature, 'id'> => ({ type: 'refAxis', name: name.trim() || defaultName, def: df ?? { kind: 'entity', of: { axis: 'Z' } } });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'add', [kind, of, a, b, p1, p2]);
  usePicking(ctx, {
    onPick(ref) {
      const t = ctx.pickTopology();
      if (kind === 'entity') { const x = axisFromPick(t, ref); if (x === 'bad') ctx.notify('Pick a round face, a circular edge or a straight edge.'); else if (x) setOf(x); return; }
      if (kind === 'twoPlanes') { const pl = planeFromPick(t, ref); if (pl === 'bad') { ctx.notify('Pick a plane or a flat face.'); return; } if (!pl) return; if (active === 'b') setB(pl); else { setA(pl); setActive('b'); } }
    },
    onTree(id) {
      if (kind === 'entity') { if (store.feature(id)?.type === 'refAxis') setOf({ refAxis: id }); return; }
      if (kind === 'twoPlanes') { const pl = planeFromTree(doc, id); if (!pl) return; if (active === 'b') setB(pl); else { setA(pl); setActive('b'); } }
    },
    highlight: () => { const t = ctx.pickTopology(); return kind === 'entity' ? selectionOfAxis(t, of) : kind === 'twoPlanes' ? selectionOfPlane(t, active === 'b' ? b : a) : []; },
  }, [kind, active, of, a, b]);
  const ok = () => valid && df && commit(p, ex, full(), () => F.addRefAxis(store, df, name.trim() || undefined));
  return (
    <Shell title={ex ? ex.name : 'Axis'} icon="refAxis" onOk={ok} onCancel={p.close} okDisabled={!valid}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Type">
        <Radio value={kind} onChange={(k) => { setKind(k); setActive(k === 'twoPlanes' ? 'a' : 'of'); }} options={[{ id: 'entity', label: 'Cylinder / edge' }, { id: 'twoPlanes', label: 'Two planes' }, { id: 'twoPoints', label: 'Two points' }]} />
      </Section>
      <Section title="Selections">
        {kind === 'entity' && <AxisBox label="Round face, circular edge or straight edge" doc={doc} value={of} onChange={setOf} active onActivate={() => setActive('of')} editId={ex?.id} />}
        {kind === 'twoPlanes' && <>
          <PlaneBox label="Plane 1" doc={doc} value={a} onChange={setA} active={active === 'a'} onActivate={() => setActive('a')} editId={ex?.id} topo={topo} />
          <PlaneBox label="Plane 2" doc={doc} value={b} onChange={setB} active={active === 'b'} onActivate={() => setActive('b')} editId={ex?.id} topo={topo} />
        </>}
        {kind === 'twoPoints' && <><Vec3Fields label="Point 1" v={p1} onChange={setP1} store={store} /><Vec3Fields label="Point 2" v={p2} onChange={setP2} store={store} /></>}
      </Section>
    </Shell>
  );
}

function RefPointPM(p: P) {
  const { ctx } = p; const { store } = ctx; const doc = store.state;
  const ex = useExisting<RefPointFeature>(p);
  const topo = ctx.pickTopology();
  const d = ex?.def;
  const [name, setName] = useName(ex);
  const [kind, setKind] = useState<RefPointDef['kind']>(d?.kind ?? 'coords');
  const [pt, setPt] = useState<Vec3Expr>(d?.kind === 'coords' ? d.p : zero());
  const [edge, setEdge] = useState<EdgeRef | null>(d?.kind === 'arcCenter' ? d.edge : null);
  const [face, setFace] = useState<FaceRef | null>(d?.kind === 'faceCenter' ? d.face : null);
  const df: RefPointDef | null = kind === 'coords' ? { kind, p: pt } : kind === 'arcCenter' ? (edge ? { kind, edge } : null) : face ? { kind, face } : null;
  const valid = !!df && (kind !== 'coords' || vecOk(store, pt));
  const defaultName = ex?.name ?? store.nextName('Point');
  const full = (): Omit<RefPointFeature, 'id'> => ({ type: 'refPoint', name: name.trim() || defaultName, def: df ?? { kind: 'coords', p: zero() } });
  useFeaturePreview(p, () => ({ ...full(), id: ex?.id ?? PREVIEW_ID } as Feature), valid, 'add', [kind, pt, edge, face]);
  usePicking(ctx, {
    onPick(ref) {
      const t = ctx.pickTopology();
      if (kind === 'arcCenter' && ref?.kind === 'edge') { if (t?.edges[ref.index]?.curve !== 'circle') { ctx.notify('Pick a circular edge or arc.'); return; } setEdge(edgesFrom(t, [ref])[0]); }
      if (kind === 'faceCenter' && ref?.kind === 'face') setFace(facesFrom(t, [ref])[0]);
    },
    highlight: () => { const t = ctx.pickTopology(); return kind === 'arcCenter' && edge ? selectionOf(t, { edges: [edge] }) : kind === 'faceCenter' && face ? selectionOf(t, { faces: [face] }) : []; },
  }, [kind, edge, face]);
  const ok = () => valid && df && commit(p, ex, full(), () => F.addRefPoint(store, df, name.trim() || undefined));
  return (
    <Shell title={ex ? ex.name : 'Point'} icon="refPoint" onOk={ok} onCancel={p.close} okDisabled={!valid}>
      <NameSection name={name} setName={setName} placeholder={defaultName} />
      <Section title="Type">
        <Radio value={kind} onChange={setKind} options={[{ id: 'coords', label: 'Coordinates' }, { id: 'arcCenter', label: 'Arc center' }, { id: 'faceCenter', label: 'Center of face' }]} />
      </Section>
      <Section title="Selections">
        {kind === 'coords' && <Vec3Fields label={`Point (${doc.units})`} v={pt} onChange={setPt} store={store} />}
        {kind === 'arcCenter' && <PickBox label="Circular edge" active onActivate={() => {}} items={edge ? edgeItems(doc, topo, [edge]) : []} onRemove={() => setEdge(null)} empty="Pick a circular edge" />}
        {kind === 'faceCenter' && <PickBox label="Face" active onActivate={() => {}} items={face ? faceItems(doc, topo, [face]) : []} onRemove={() => setFace(null)} empty="Pick a face" />}
      </Section>
    </Shell>
  );
}

// ================================================================== dispatcher
const PMS: Record<ModelingFeatureType, (p: P) => ReactNode> = {
  fillet: FilletPM, chamfer: ChamferPM, hole: HolePM, linearPattern: LinearPatternPM, circularPattern: CircularPatternPM, mirror: MirrorPM,
  shell: ShellPM, draft: DraftPM, rib: RibPM, sweep: SweepPM, loft: LoftPM, refPlane: RefPlanePM, refAxis: RefAxisPM, refPoint: RefPointPM,
};

export function FeaturePM(p: P) {
  const C = PMS[p.pm.type];
  return <C {...p} />;
}


