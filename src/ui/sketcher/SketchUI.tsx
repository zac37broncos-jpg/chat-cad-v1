/**
 * React side of sketch mode: the hook that opens/closes a sketch, the
 * Panel in the style of the command panels (tools, status, relations, dimension values)
 * and the viewport layer (dimension text, relation glyphs, Modify box,
 * confirmation corner).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import gcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { DocumentStore } from '../../core/store';
import { resolveParams } from '../../core/store';
import type { BasePlane, PlaneFrame, SketchConstraint, SketchFeature } from '../../core/model';
import { isDimension, newId } from '../../core/model';
import { evalLength, formatLength } from '../../core/units';
import type { KernelClient } from '../../kernel/client';
import { sketchFrame, type Frame } from '../../kernel/regen';
import type { Viewport } from '../../render/viewport';
import { SketchOverlay } from '../../render/sketchOverlay';
import { createSketchSolver, type SketchSolver } from '../../sketch/solver';
import { SketchSession } from '../../sketch/session';
import { hasExpressionCoordinates, dist, pointOf, entityPoints, type P2 } from '../../sketch/geom';
import { SketchController, TOOL_LABEL, COLORS, type ToolId } from './controller';

let solverPromise: Promise<SketchSolver> | null = null;
export const getSketchSolver = () => (solverPromise ??= createSketchSolver(gcsWasmUrl));

/** What a sketch can be placed on. Face index comes from the viewport pick. */
export type SketchPlaneRef = { kind: 'plane'; plane: BasePlane } | { kind: 'face'; index: number } | { kind: 'refPlane'; id: string };

/** Plane frame for a planar face: origin = world origin projected onto the face plane; sketch Y is "up" where possible. */
export function faceFrame(normal: [number, number, number], pointOnPlane: [number, number, number]): PlaneFrame {
  const n = normalize(normal);
  const d = n[0] * pointOnPlane[0] + n[1] * pointOnPlane[1] + n[2] * pointOnPlane[2];
  const origin: [number, number, number] = [n[0] * d, n[1] * d, n[2] * d];
  let xDir: [number, number, number];
  if (Math.abs(n[2]) > 1 - 1e-9) xDir = [1, 0, 0]; // horizontal face: X stays X
  else {
    // y = world Z projected onto the plane; x = y × n
    const z: [number, number, number] = [-n[2] * n[0], -n[2] * n[1], 1 - n[2] * n[2]];
    const y = normalize(z);
    xDir = normalize([y[1] * n[2] - y[2] * n[1], y[2] * n[0] - y[0] * n[2], y[0] * n[1] - y[1] * n[0]]);
  }
  return { origin, xDir, normal: n };
}
function normalize(v: [number, number, number]): [number, number, number] { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

export interface Sketcher {
  controller: SketchController | null;
  /** Start a new sketch on a base plane or planar face. */
  startSketch(ref: SketchPlaneRef): Promise<void>;
  /** Open an existing sketch for editing. */
  editSketch(id: string): Promise<void>;
  /** ✓ keep changes (one undo step), ✗ discard everything since the sketch was opened. */
  exit(): void;
  cancel(): void;
  error: string;
}

/** Tools for the S shortcut bar while a sketch is open. */
export interface SketchShortcutTool { id: string; label: string; icon?: string; run(): void }
const SHORTCUT_TOOLS: { tool: ToolId; icon: string; key?: string }[] = [
  { tool: 'line', icon: 'skLine', key: 'L' }, { tool: 'rect', icon: 'skRect', key: 'R' }, { tool: 'circle', icon: 'skCircle', key: 'C' },
  { tool: 'arc3', icon: 'skArc', key: 'A' }, { tool: 'point', icon: 'skPoint', key: 'P' }, { tool: 'dimension', icon: 'skDim', key: 'D' },
  { tool: 'trim', icon: 'skTrim', key: 'M' }, { tool: 'offset', icon: 'skOffset', key: 'O' }, { tool: 'fillet', icon: 'skFillet' },
];
export function sketchShortcutTools(ctl: SketchController, sketcher: Sketcher): SketchShortcutTool[] {
  return [
    ...SHORTCUT_TOOLS.map((t) => ({ id: t.tool, label: `${TOOL_LABEL[t.tool]}${t.key ? ` (${t.key})` : ''}`, icon: t.icon, run: () => { ctl.setTool(t.tool); ctl.changed(); } })),
    { id: 'exit', label: 'Exit Sketch', icon: 'skExit', run: () => sketcher.exit() },
  ];
}

/** A reference plane as the last rebuild evaluated it (for sketches on reference planes). */
export type RefPlaneLookup = (id: string) => { origin: [number, number, number]; x: [number, number, number]; y: [number, number, number]; normal: [number, number, number] } | null;

export function useSketcher(store: DocumentStore, vpRef: React.MutableRefObject<Viewport | null>, kernel: KernelClient, refPlane?: RefPlaneLookup): Sketcher {
  const [controller, setController] = useState<SketchController | null>(null);
  const [error, setError] = useState('');
  const overlayRef = useRef<SketchOverlay | null>(null);
  const openRef = useRef<{ ctl: SketchController; checkpoint: number; id: string } | null>(null);

  /** Close the sketch. Its undo steps stop being protected from the history limit unless `keepSteps` (Cancel undoes them first). */
  const close = useCallback((keepSteps = false) => {
    const o = openRef.current;
    if (!o) return;
    o.ctl.dispose();
    openRef.current = null;
    if (!keepSteps) store.releaseCheckpoint(o.checkpoint);
    if (vpRef.current) vpRef.current.pickingEnabled = true;
    delete document.body.dataset.sketchMode;
    (globalThis as any).chatcadSketch = null;
    setController(null);
  }, [vpRef, store]);

  const open = useCallback(async (id: string) => {
    const vp = vpRef.current;
    if (!vp) return;
    if (openRef.current) close();
    const solver = await getSketchSolver();
    const f = store.feature(id) as SketchFeature | undefined;
    if (!f || f.type !== 'sketch') return;
    const params = resolveParams(store.state as any);
    const off = f.offset !== undefined ? evalLength(f.offset, store.state.units, params) : 0;
    let frame: Frame;
    if (f.refPlane) {
      // Same frame the kernel uses (refPlaneFrame): the plane's origin and axes, moved by the sketch offset.
      const g = refPlane?.(f.refPlane);
      if (!g) { setError('Its reference plane is missing or failed; fix the plane first.'); return; }
      frame = { o: [g.origin[0] + g.normal[0] * off, g.origin[1] + g.normal[1] * off, g.origin[2] + g.normal[2] * off], x: g.x, y: g.y, n: g.normal };
    } else frame = sketchFrame(f, off);
    overlayRef.current ??= new SketchOverlay(vp);
    const session = new SketchSession(store, solver, id);
    const ctl = new SketchController(session, overlayRef.current, frame);
    // Every step of this sketch edit is kept (even past the history limit) until OK merges them or Cancel undoes them.
    const checkpoint = store.openCheckpoint();
    openRef.current = { ctl, checkpoint, id };
    vp.pickingEnabled = false;
    // Tells the app-wide key handler that sketch keys belong to the sketcher.
    document.body.dataset.sketchMode = 'on';
    vp.clearSelection();
    vp.normalTo(frame.n, frame.y, true);
    // Typed sketches: connect touching ends so dragging keeps them joined.
    if (!f.constraints?.length && f.entities.length) {
      const ws = session.working();
      const refs = ws.entities.flatMap((e) => entityPoints(e).filter((r) => r.p !== 'center').map((r) => ({ r, p: pointOf(e, r.p) })));
      const extra: SketchConstraint[] = [];
      for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) {
        if (refs[i].r.e !== refs[j].r.e && dist(refs[i].p, refs[j].p) < 1e-6) extra.push({ id: newId('cn'), type: 'coincident', a: refs[i].r, b: refs[j].r });
      }
      if (extra.length) session.apply('Connect sketch ends', { entities: ws.entities, constraints: extra });
    }
    if (hasExpressionCoordinates(f)) ctl.say('This sketch was typed with expressions in its coordinates. Mouse edits store plain numbers; use dimensions to drive it from parameters.', 'warn');
    else ctl.say('Pick a tool. Dimensions and relations turn the sketch from blue (under defined) to black (fully defined).');
    setController(ctl);
    (globalThis as any).chatcadSketch = ctl; // for scripting and debugging
  }, [store, vpRef, close, refPlane]);

  // Keep the controller in sync with document changes (undo, AI edits, parameter changes).
  useEffect(() => store.subscribe(() => {
    const o = openRef.current;
    if (!o) return;
    if (!store.feature(o.id)) { close(); return; }
    o.ctl.changed();
  }), [store, close]);

  const startSketch = useCallback(async (ref: SketchPlaneRef) => {
    setError('');
    try {
      if (ref.kind === 'plane') { await open(store.addSketch(ref.plane)); return; }
      if (ref.kind === 'refPlane') {
        if (!refPlane?.(ref.id)) { setError('That reference plane is missing or failed; fix it first.'); return; }
        await open(store.addSketch('XY', [], { refPlane: ref.id }));
        return;
      }
      const info: any = await kernel.call({ op: 'info', ref: { kind: 'face', index: ref.index } });
      if (info.kind !== 'face' || info.surface !== 'plane') { setError('Pick a flat (planar) face to sketch on.'); return; }
      const frame = faceFrame(info.normal, info.origin);
      const d = info.normal[0] * info.origin[0] + info.normal[1] * info.origin[1] + info.normal[2] * info.origin[2];
      const label = `planar face, normal (${info.normal.map((v: number) => v.toFixed(3)).join(', ')}), ${formatLength(Math.abs(d), store.state.units)} from origin`;
      await open(store.addSketch('face', [], { frame, faceLabel: label }));
    } catch (e) { setError((e as Error).message); }
  }, [store, kernel, open]);

  const exit = useCallback(() => {
    const o = openRef.current;
    if (!o) return;
    const f = store.feature(o.id);
    if (f) store.squashSince(o.checkpoint, `Edit ${f.name}`);
    close();
  }, [store, close]);

  const cancel = useCallback(() => {
    const o = openRef.current;
    if (!o) return;
    close(true);
    while (store.checkpoint() > o.checkpoint && store.canUndo) store.undo();
    store.releaseCheckpoint(o.checkpoint);
  }, [store, close]);

  return { controller, startSketch, editSketch: open, exit, cancel, error };
}

function useCtl(ctl: SketchController) { useSyncExternalStore(ctl.subscribe, ctl.getVersion); }

// ---------------------------------------------------------------- panel

/** Shown after pressing Sketch with nothing selected: pick a plane (or select a planar face in the viewport). */
export function SketchPlanePicker({ onPick, onTyped, onClose }: { onPick: (p: BasePlane) => void; onTyped: () => void; onClose: () => void }) {
  return (
    <div className="dialog">
      <h3>✎ New Sketch</h3>
      <p className="hint">Select a plane to sketch on. To sketch on a flat face of the part, close this, click the face in the viewport, then press ✎ Sketch.</p>
      <div className="seg">
        <button onClick={() => onPick('XZ')}>Front Plane</button>
        <button onClick={() => onPick('XY')}>Top Plane</button>
        <button onClick={() => onPick('YZ')}>Right Plane</button>
      </div>
      <div className="actions">
        <button onClick={onClose}>Close</button>
        <button className="linkish" onClick={onTyped}>Typed sketch (exact coordinates)…</button>
      </div>
    </div>
  );
}

const TOOLS: { id: ToolId; icon: string; key?: string }[] = [
  { id: 'line', icon: '╱', key: 'L' }, { id: 'centerline', icon: '┄' }, { id: 'rect', icon: '▭', key: 'R' }, { id: 'crect', icon: '⊡' },
  { id: 'circle', icon: '◯', key: 'C' }, { id: 'arc3', icon: '◠', key: 'A' }, { id: 'carc', icon: '◜' }, { id: 'tarc', icon: '⤻' },
  { id: 'slot', icon: '⊂⊃' }, { id: 'polygon', icon: '⬡' },
  { id: 'point', icon: '•', key: 'P' }, { id: 'dimension', icon: '↔', key: 'D' },
  { id: 'trim', icon: '✂', key: 'M' }, { id: 'extend', icon: '⇥', key: 'X' }, { id: 'offset', icon: '⧉', key: 'O' }, { id: 'fillet', icon: '◟' },
];

const STATE_TEXT = { empty: 'Empty sketch', under: 'Under Defined', full: 'Fully Defined', over: 'Over Defined', failed: 'Cannot Solve' } as const;

/** Compact names for the narrow tool grid (full names are in the tooltips). */
const SHORT_LABEL: Partial<Record<ToolId, string>> = {
  rect: 'Corner Rect', crect: 'Center Rect', arc3: '3-Point Arc', carc: 'Center Arc', dimension: 'Smart Dim',
  trim: 'Trim', offset: 'Offset', fillet: 'Fillet', centerline: 'Centerline', tarc: 'Tangent Arc', slot: 'Slot', polygon: 'Polygon',
};

export function SketchPanel({ ctl, sketcher, store, onTyped }: { ctl: SketchController; sketcher: Sketcher; store: DocumentStore; onTyped: (id: string) => void }) {
  useCtl(ctl);
  let st;
  try { st = ctl.state(); } catch { return null; }
  const f = ctl.session.feature;
  const color = st.status.state === 'full' ? COLORS.full : st.status.state === 'under' ? COLORS.under : st.status.state === 'empty' ? '#6b7686' : COLORS.over;
  const rels = ctl.applicableRelations();
  const existing = ctl.selectedConstraints();
  const selDims = existing.filter((c) => ctl.selection.constraints.has(c.id) && isDimension(c));
  const nSel = ctl.selection.entities.size + ctl.selection.points.length + ctl.selection.constraints.size;
  return (
    <div className="dialog sketch-panel">
      <div className="sk-head">
        <h3>✎ {f?.name ?? 'Sketch'}</h3>
        <span className="sk-state" style={{ color, borderColor: color }}>{STATE_TEXT[st.status.state]}{st.status.state === 'under' ? ` · ${st.status.dof} DOF` : ''}</span>
      </div>
      {f?.plane === 'face' && <p className="hint">On {f.faceLabel ?? 'a face'}. Placement is fixed where you picked it (it will not follow later edits to that face yet).</p>}
      {st.status.message && <p className="err">{st.status.message}</p>}
      <div className="actions">
        <button className="primary" onClick={sketcher.exit} title="Exit sketch and keep changes">✓ Exit Sketch</button>
        <button onClick={sketcher.cancel} title="Discard all changes made since this sketch was opened">✗ Cancel</button>
      </div>
      <div className="sk-tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={ctl.tool === t.id ? 'on' : ''} title={`${TOOL_LABEL[t.id]}${t.key ? ` (${t.key})` : ''}`} onClick={() => ctl.setTool(ctl.tool === t.id ? 'select' : t.id)}>
            <span className="ic">{t.icon}</span><span className="lb">{SHORT_LABEL[t.id] ?? TOOL_LABEL[t.id]}</span>{t.key && <kbd>{t.key}</kbd>}
          </button>
        ))}
      </div>
      <div className="actions">
        <button onClick={() => ctl.toggleConstructionSel()} title="Toggle construction geometry for the selection (Q)">┄ Construction <kbd>Q</kbd></button>
        <label className="check"><input type="checkbox" checked={ctl.showRelations} onChange={(e) => { ctl.showRelations = e.target.checked; ctl.changed(); }} /> Show relations</label>
      </div>
      {ctl.tool === 'offset' && (
        <ExprInput label="Offset distance" value={ctl.offsetExpr} store={store} onChange={(v) => { ctl.offsetExpr = v; ctl.changed(); }} />
      )}
      {ctl.tool === 'polygon' && (
        <label className="field"><span>Number of sides</span>
          <input type="number" min={3} max={40} step={1} value={ctl.polygonSides}
            onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 3 && n <= 40) { ctl.polygonSides = n; ctl.changed(); } }} />
        </label>
      )}
      {ctl.tool === 'polygon' && (
        <div className="field">
          <label className="check"><input type="radio" name="polygon-circle" checked={ctl.polygonCircle === 'inscribed'} onChange={() => { ctl.polygonCircle = 'inscribed'; ctl.changed(); }} /> Inscribed circle</label>
          <label className="check"><input type="radio" name="polygon-circle" checked={ctl.polygonCircle === 'circumscribed'} onChange={() => { ctl.polygonCircle = 'circumscribed'; ctl.changed(); }} /> Circumscribed circle</label>
        </div>
      )}
      {ctl.tool === 'fillet' && (
        <ExprInput label="Fillet radius" value={ctl.filletExpr} store={store} onChange={(v) => { ctl.filletExpr = v; ctl.changed(); }} />
      )}
      {ctl.message && <p className={ctl.messageKind === 'error' ? 'err' : ctl.messageKind === 'warn' ? 'warn-text' : 'hint'}>{ctl.message}</p>}

      {nSel > 0 && (
        <>
          <h3>Selection</h3>
          <p className="hint">{ctl.selection.entities.size} entities, {ctl.selection.points.length} points{ctl.selection.constraints.size ? `, ${ctl.selection.constraints.size} relations/dimensions` : ''} · Delete removes them</p>
          {rels.length > 0 && (
            <>
              <div className="sk-sub">Add Relations</div>
              <div className="seg">{rels.map((r) => <button key={r.type + r.label} onClick={() => ctl.addRelation(r.make)}>{r.label}</button>)}</div>
            </>
          )}
          {selDims.map((c) => <DimensionEditor key={c.id} ctl={ctl} c={c} store={store} />)}
          {existing.length > 0 && (
            <>
              <div className="sk-sub">Existing Relations</div>
              <ul className="entities">
                {existing.map((c) => (
                  <li key={c.id} className={st.conflicting.includes(c.id) || st.redundant.includes(c.id) ? 'bad' : ''}>
                    <span onClick={() => ctl.selectConstraint(c.id, false)} style={{ cursor: 'pointer' }}>{describe(c)}</span>
                    <button className="x" title="Delete" onClick={() => ctl.deleteConstraint(c.id)}>×</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <details className="sk-help">
        <summary>Mouse and keys</summary>
        <p className="hint">Left-click draws/selects. Lines chain until you double-click, right-click or press Esc. Hold Ctrl while drawing to stop automatic relations. Esc ends the tool; Enter repeats the last tool. Double-click a dimension to change it; drag its text to move it. Drag points or curves in Select mode to move under-defined geometry.</p>
      </details>
      {f && <button className="linkish" onClick={() => { sketcher.exit(); onTyped(f.id); }}>Edit coordinates as typed values…</button>}
    </div>
  );
}

function DimensionEditor({ ctl, c, store }: { ctl: SketchController; c: SketchConstraint; store: DocumentStore }) {
  const value = isDimension(c) ? c.value : '';
  const [v, setV] = useState(String(value));
  const [err, setErr] = useState('');
  useEffect(() => { setV(String(value)); setErr(''); }, [value]);
  if (!isDimension(c)) return null;
  const apply = () => { const r = ctl.session.setDimension(c.id, v.trim()); setErr(r.ok ? '' : r.message ?? 'Invalid'); };
  return (
    <div className="field">
      <span>{describe(c)}</span>
      <div className="row">
        <input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} disabled={!!c.driven} className={err ? 'bad' : ''} spellCheck={false} />
        <button onClick={apply} disabled={!!c.driven}>Set</button>
      </div>
      <label className="check"><input type="checkbox" checked={!!c.driven} onChange={(e) => { const r = ctl.session.setDriven(c.id, e.target.checked); setErr(r.ok ? '' : r.message ?? ''); }} /> Driven (reference only)</label>
      {err ? <small className="err">{err}</small> : <small className="ok">{c.type === 'angle' ? 'Degrees. ' : `${store.state.units}. `}Expressions and parameters allowed, e.g. W/2 or 6.35 mm.</small>}
    </div>
  );
}

function ExprInput({ label, value, onChange, store }: { label: string; value: string; onChange: (v: string) => void; store: DocumentStore }) {
  let shown = '', err = '';
  try { shown = formatLength(evalLength(value, store.state.units, resolveParams(store.state as any)), store.state.units, 6); } catch (e) { err = (e as Error).message; }
  return (
    <label className="field"><span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className={err ? 'bad' : ''} spellCheck={false} />
      <small className={err ? 'err' : 'ok'}>{err || `= ${shown}`}</small>
    </label>
  );
}

const NAMES: Record<string, string> = {
  coincident: 'Coincident', pointOn: 'Coincident (on curve)', horizontal: 'Horizontal', vertical: 'Vertical',
  horizontalPoints: 'Horizontal (points)', verticalPoints: 'Vertical (points)', parallel: 'Parallel', perpendicular: 'Perpendicular',
  collinear: 'Collinear', equal: 'Equal', concentric: 'Concentric', tangent: 'Tangent', midpoint: 'Midpoint', symmetric: 'Symmetric',
  fix: 'Fixed', distance: 'Distance', pointLineDistance: 'Distance to line', radius: 'Radius', diameter: 'Diameter', angle: 'Angle', offset: 'Offset',
};
function describe(c: SketchConstraint): string {
  const n = NAMES[c.type] ?? c.type;
  if (isDimension(c)) return `${n}${c.type === 'distance' && c.dir ? (c.dir === 'h' ? ' (horizontal)' : ' (vertical)') : ''} = ${c.value}${c.type === 'angle' ? '°' : ''}${c.driven ? ' (driven)' : ''}`;
  return n;
}

// ---------------------------------------------------------------- viewport layer

export function SketchLayer({ ctl, sketcher }: { ctl: SketchController; sketcher: Sketcher }) {
  useCtl(ctl);
  const ov = ctl.overlay;
  const dragRef = useRef<{ id: string; x0: number; y0: number; moved: boolean } | null>(null);
  let labels: ReturnType<SketchController['dimLabels']> = [], glyphs: ReturnType<SketchController['relationGlyphs']> = [];
  let st;
  try { st = ctl.state(); labels = ctl.dimLabels(); glyphs = ctl.relationGlyphs(); } catch { return null; }
  const scr = (p: P2) => ov.toScreen(p);
  // Labels and glyphs take clicks only in Select mode, so they never block drawing.
  const live = ctl.tool === 'select';
  const u = ctl.units, k = ctl.k;
  const onLabelDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id, x0: e.clientX, y0: e.clientY, moved: false };
  };
  const onLabelMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 3) d.moved = true;
    if (d.moved) (e.target as HTMLElement).style.transform = `translate(calc(-50% + ${e.clientX - d.x0}px), calc(-50% + ${e.clientY - d.y0}px))`;
  };
  const onLabelUp = (e: React.PointerEvent, id: string) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    (e.target as HTMLElement).style.transform = '';
    if (!d.moved) { if (id !== '__draft') ctl.selectConstraint(id, e.ctrlKey || e.shiftKey); return; }
    const p = ov.toSketch(e.clientX, e.clientY);
    const c = ctl.state().ws.constraints.find((x) => x.id === id);
    if (!p || !c) return;
    const anchor = ctl.dimAnchor(c, ctl.state().solved);
    if (anchor) ctl.session.moveDimensionText(id, [(p[0] - anchor[0]) / k, (p[1] - anchor[1]) / k]);
  };
  return (
    <div className="sk-layer">
      {labels.map((l) => {
        const [x, y] = scr(l.at);
        return (
          <div key={l.id} className={`sk-dim ${l.driven ? 'driven' : ''} ${l.selected ? 'sel' : ''} ${l.conflicting ? 'bad' : ''}`} style={{ left: x, top: y, ...(l.id === '__draft' || !live ? { pointerEvents: 'none' } : {}) }}
            title={l.expr ? 'Driven by an expression' : 'Double-click to change'}
            onPointerDown={(e) => onLabelDown(e, l.id)} onPointerMove={onLabelMove} onPointerUp={(e) => onLabelUp(e, l.id)}
            onDoubleClick={(e) => { e.stopPropagation(); if (l.id !== '__draft') ctl.openModify(l.id); }}>
            {l.expr && <span className="fx">ƒ</span>}{l.text}
          </div>
        );
      })}
      {glyphs.map((g, i) => {
        const [x, y] = scr(g.at);
        return <div key={`${g.id}-${i}`} className={`sk-glyph ${g.selected ? 'sel' : ''} ${g.bad ? 'bad' : ''}`} style={{ left: x, top: y, ...(live ? {} : { pointerEvents: 'none' }) }} title={g.title}
          onPointerDown={(e) => { e.stopPropagation(); ctl.selectConstraint(g.id, e.ctrlKey || e.shiftKey); }}>{g.glyph}</div>;
      })}
      {ctl.modify && <ModifyBoxView ctl={ctl} at={scr(ctl.modify.at)} />}
      <div className="sk-corner">
        <button className="ok" title="Exit sketch (keep changes)" onClick={sketcher.exit}>✓</button>
        <button className="no" title="Discard changes" onClick={sketcher.cancel}>✗</button>
      </div>
      <div className="sk-status" style={{ color: st.status.state === 'full' ? COLORS.full : st.status.state === 'under' ? COLORS.under : st.status.state === 'empty' ? undefined : COLORS.over }}>
        {TOOL_LABEL[ctl.tool]} · {STATE_TEXT[st.status.state]}{st.status.state === 'under' ? ` (${st.status.dof} DOF)` : ''} · x {(ctl.cursor[0] / k).toFixed(u === 'in' ? 4 : 3)} y {(ctl.cursor[1] / k).toFixed(u === 'in' ? 4 : 3)} {u}
      </div>
    </div>
  );
}

function ModifyBoxView({ ctl, at }: { ctl: SketchController; at: [number, number] }) {
  const m = ctl.modify!;
  const [v, setV] = useState(m.value);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setV(m.value); setErr(''); setTimeout(() => { ref.current?.focus(); ref.current?.select(); }, 0); }, [m.id]);
  const ok = () => { const e = ctl.applyModify(v); setErr(e ?? ''); };
  return (
    <div className="sk-modify" style={{ left: at[0], top: at[1] + 18 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="row">
        <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} className={err ? 'bad' : ''}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') { ctl.modify = null; ctl.changed(); } }} />
        <button className="primary" onClick={ok} title="Apply (Enter)">✓</button>
        <button onClick={() => { ctl.modify = null; ctl.changed(); }} title="Keep the current value (Esc)">✗</button>
      </div>
      {err ? <small className="err">{err}</small> : <small className="ok">Value or expression, e.g. 1.25, 3/8", 10 mm, W/2</small>}
    </div>
  );
}
