import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DocumentStore } from '../core/store';
import type { BasePlane, CadDocument, Feature, SketchFeature } from '../core/model';
import { KernelClient, Superseded } from '../kernel/client';
import type { RegenResponse, SelRef, SubRef } from '../kernel/protocol';
import type { EntityInfo } from '../kernel/query';
import { Viewport, PLANE_NAMES, type StandardView } from '../render/viewport';
import { NAV_PRESETS } from '../render/navigation';
import { BridgeClient } from '../ai/bridgeClient';
import { renderSnapshots, type SnapshotView } from '../render/snapshot';
import { ChatDock } from './ChatDock';
import { REPEATABLE, draftPMTitle, editPMFor, sketchesUsedBy, type AppCtx, type Command, type PMState } from './commands';
import { facesOfFeatures, featuresOfFaces, selectionSummary } from './feel';
import type { Topology } from '../kernel/naming';
import { FeatureTree, buildRows, iconFor, type TreeTarget } from './FeatureTree';
import { CommandPanel, type PreviewApi, type ViewOptions } from './CommandPanel';
import type { ExportFile } from './ExportPMs';
import { Ribbon } from './Ribbon';
import { CommandSearch, ContextMenu, OrientationMenu, ShortcutBar, type MenuItem } from './Popups';
import { Icon } from './icons';
import { useSketcher, SketchPanel, SketchLayer, SketchPlanePicker, sketchShortcutTools } from './sketcher/SketchUI';
import { DrawingWorkspace } from './drawing/DrawingWorkspace';
import { PART_FILE_EXT } from '../brand';
import { EDITION } from '../edition';
import { ViewportRebuilds } from './rebuilds';
import { Autosaver, autosaveDb, browserLocal, initialAutosave, type SaveStatus } from './autosave';

const VIEW_KEY = 'chatcad.view.v1';

// The newest autosave that opens (read by src/main.tsx before this module loads).
const restored = initialAutosave();
const store = new DocumentStore(restored.doc);
/** Autosave status for the App component (set before it mounts, read on mount). */
let autosaveListener: (s: SaveStatus) => void = () => {};
let lastAutosaveStatus: SaveStatus | null = null;
const autosaver = new Autosaver(browserLocal(), autosaveDb(), (s) => { lastAutosaveStatus = s; autosaveListener(s); }, undefined, restored.doc);
const kernel = new KernelClient();
let currentSelection: SelRef[] = [];
let currentTreeSel: string[] = [];
const bridge = new BridgeClient({
  store,
  regen: (o) => kernel.call({ op: 'regen', doc: store.state, mesh: false, ...(o?.topology === false ? { topology: false } : {}), ...(o?.mass === false ? { mass: false } : {}) }),
  selection: () => currentSelection,
  selectedFeatures: () => currentTreeSel,
  info: (ref) => kernel.call({ op: 'info', ref }),
  quality: () => kernel.call({ op: 'quality' }),
  snapshot: async (views, size, edges) => {
    const r = await kernel.call({ op: 'regen', doc: store.state, topology: false, mass: false });
    return r.mesh ? renderSnapshots(r.mesh, views as SnapshotView[], size, edges) : [];
  },
});
// Expose the command API for scripting and debugging.
(window as any).chatcad = { store, kernel, bridge };

function useDoc(): CadDocument {
  return useSyncExternalStore((cb) => store.subscribe(cb), () => store.state);
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const DEFAULT_VIEW: ViewOptions = { nav: 'middle-rotate', reverseWheel: false, showPlanes: false, showEdges: true, showSketches: true, showOrigin: true, animateViews: true };
function loadView(): ViewOptions {
  try {
    const v: ViewOptions = { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') };
    // A mouse layout saved under an id this version does not have falls back to the default.
    return Object.hasOwn(NAV_PRESETS, v.nav) ? v : { ...v, nav: DEFAULT_VIEW.nav };
  } catch { return DEFAULT_VIEW; }
}

const PLANE_NORMAL: Record<BasePlane, [number, number, number]> = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0] };
const isSub = (s: SelRef): s is SubRef => s.kind !== 'plane';
/** Normal of a sketch's plane (base plane or the stored frame of a face sketch). */
const sketchNormal = (sk: SketchFeature, refPlane?: (id: string) => { normal: [number, number, number] } | null): [number, number, number] =>
  (sk.refPlane && refPlane?.(sk.refPlane)?.normal) || (sk.plane === 'face' ? sk.frame?.normal ?? [0, 0, 1] : PLANE_NORMAL[sk.plane]);

type Popup =
  | { kind: 'menu'; x: number; y: number; title?: string; items: MenuItem[] }
  | { kind: 'orient'; x: number; y: number }
  | { kind: 'sbar'; x: number; y: number }
  | { kind: 'search' }
  | null;

export function App() {
  const doc = useDoc();
  const hostRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<Viewport | null>(null);
  const [regen, setRegen] = useState<RegenResponse | null>(null);
  /** Bumped when the viewport rebuild state changes (what is on screen, failed, busy). */
  const [, setRebuildTick] = useState(0);
  const regenRef = useRef<RegenResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pm, setPMRaw] = useState<PMState>(null);
  const [selection, setSelection] = useState<SelRef[]>([]);
  const [infos, setInfos] = useState<EntityInfo[]>([]);
  const [distance, setDistance] = useState<number | null>(null);
  const [treeSel, setTreeSel] = useState<string[]>([]);
  currentTreeSel = treeSel;
  const [hiddenSketches, setHiddenSketches] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [view, setViewOpts] = useState<ViewOptions>(loadView);
  const [chatOpen, setChatOpen] = useState(true);
  const [notice, setNotice] = useState('');
  const [previewMsg, setPreviewMsg] = useState('');
  const [popup, setPopup] = useState<Popup>(null);
  const [hint, setHint] = useState('');
  /** Description of the button under the pointer (mainstream CAD shows it in the status bar). */
  const [cmdHint, setCmdHint] = useState('');
  /** Short-lived note: in the status bar (info) or as a viewport toast (warn). */
  const [flash, setFlash] = useState<{ text: string; warn?: boolean; seq: number } | null>(null);
  const say = useCallback((text: string, warn = false) => setFlash((f) => ({ text, warn, seq: (f?.seq ?? 0) + 1 })), []);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), flash.warn ? 4000 : 2500); return () => clearTimeout(t); }, [flash]);
  /** Feature row under the pointer in the feature tree (dynamic highlight). */
  const [treeHover, setTreeHover] = useState<string | null>(null);
  // Feature command panels: viewport clicks, flyout-tree clicks, and the names of what is on screen.
  const [pick, setPick] = useState<AppCtx['pick']>(null);
  const [treePick, setTreePick] = useState<AppCtx['treePick']>(null);
  const previewTopo = useRef<Topology | null>(null);
  const [topoSeq, setTopoSeq] = useState(0);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const firstFit = useRef(true);
  const lastCommand = useRef<Command | null>(null);
  const mouse = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  // Interactive sketcher: owns the viewport's left clicks and sketch keys while a sketch is open.
  const refPlaneLookup = useCallback((id: string) => {
    const g = regenRef.current?.refGeometry?.find((r) => r.id === id);
    return g && g.kind === 'plane' ? g : null;
  }, []);
  const sketcher = useSketcher(store, vpRef, kernel, refPlaneLookup);
  const sketcherRef = useRef(sketcher); sketcherRef.current = sketcher;
  const [planePick, setPlanePick] = useState(false);
  const activeSketch = sketcher.controller?.session.sketchId ?? null;
  /**
   * Open a command panel. Sketch requests go to the interactive sketcher
   * (or the plane picker); the typed-coordinates sketch dialog is opened with
   * typed: true. Opening any other command panel closes an open sketch (✓).
   */
  const setPM = useCallback((p: PMState) => {
    const sk = sketcherRef.current;
    if (p?.kind === 'sketch' && !p.typed) {
      setPMRaw(null);
      if (p.editId) { setPlanePick(false); void sk.editSketch(p.editId); }
      else if (p.plane && !p.offset) { setPlanePick(false); void sk.startSketch({ kind: 'plane', plane: p.plane }); }
      else { sk.exit(); setPlanePick(true); }
      return;
    }
    // Leaving a feature command panel: its highlight used the preview's face numbering.
    if (pmRef.current?.kind === 'feature' && p?.kind !== 'feature') vpRef.current?.clearSelection();
    if (p) {
      const open = sk.controller?.session.sketchId;
      setPlanePick(false);
      if (open) {
        sk.exit();
        // Extrude/Revolve straight from a sketch: use that sketch, and turn to a trimetric-style view to show the preview.
        if ((p.kind === 'extrude' || p.kind === 'revolve') && !p.editId) { p = { ...p, sketchId: p.sketchId ?? open }; vpRef.current?.setView('iso'); }
      }
    }
    setPMRaw(p);
  }, []);

  // ---------------------------------------------------------------- viewport
  useEffect(() => {
    const vp = new Viewport(hostRef.current!);
    vpRef.current = vp;
    (window as any).chatcad.vp = vp; // scripting / debugging
    vp.onSelectionChange = (sel) => { currentSelection = sel; setSelection(sel); if (sel.length) setTreeSel([]); };
    vp.onPick = (ref, point) => setPick((p) => ({ seq: (p?.seq ?? 0) + 1, ref, point }));
    vp.onHover = (ref) => setHint(ref ? (ref.kind === 'plane' ? PLANE_NAMES[ref.plane] : ref.kind === 'face' ? 'Face' : 'Edge') : '');
    return () => vp.dispose();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const vp = vpRef.current; if (!vp) return;
    vp.setNavPreset(view.nav); vp.setReverseWheel(view.reverseWheel); vp.setAnimateViews(view.animateViews); vp.setShowPlanes(view.showPlanes); vp.setShowEdges(view.showEdges); vp.setShowOrigin(view.showOrigin);
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* ignore */ }
  }, [view]);
  const setViewOptions = (o: Partial<ViewOptions>) => setViewOpts((v) => ({ ...v, ...o }));

  // ---------------------------------------------------------------- regenerate on every change (latest wins)
  const massWanted = useRef(false);
  // Mass Properties may only show a finished rebuild of the document open now (./massStatus.ts).
  const rebuilds = useMemo(() => new ViewportRebuilds(kernel), []);
  rebuilds.on = {
    result: (r) => {
      regenRef.current = r;
      setRegen(r);
      if (!previewing.current) setTopoSeq((n) => n + 1);
      vpRef.current?.setMesh(r.mesh);
      if (firstFit.current && r.mesh) { vpRef.current?.fit(false); firstFit.current = false; }
    },
    error: (message) => setNotice(message),
    change: () => { busyRef.current = rebuilds.busy; setBusy(rebuilds.busy); setRebuildTick((n) => n + 1); },
  };
  const runRegen = useCallback((d: CadDocument) => {
    // Mass properties take seconds on large curved parts: only compute them while the Mass Properties panel is open.
    // A newer rebuild replaces this one if it has not started yet (typing fast rebuilds at most twice).
    void rebuilds.request(d, massWanted.current);
  }, [rebuilds]);
  // The geometry worker was replaced. After a crash rebuild the model on the fresh worker (a
  // too-large heap needs nothing: the client rebuilds the last model itself when it is needed).
  useEffect(() => {
    kernel.onRestart = ({ reason, repeated }) => {
      if (reason !== 'crash') return;
      if (repeated) { setNotice('The geometry kernel keeps crashing on this model. Undo the last change (Ctrl+Z) or change it, and the model rebuilds.'); return; }
      setNotice('The geometry kernel crashed and was restarted. The model is being rebuilt.');
      runRegen(store.state);
    };
    return () => { kernel.onRestart = undefined; };
  }, [runRegen]);
  useEffect(() => {
    autosaver.save(doc);
    runRegen(doc);
  }, [doc, runRegen]);
  // Autosave problems are never silent (item B5): a notice that stays until dismissed.
  useEffect(() => {
    const AUTOSAVE_PREFIX = 'Autosave failed';
    autosaveListener = (s) => {
      if (!s.ok) setNotice(s.message ?? 'Autosave failed. Use Save (Ctrl+S) to keep a copy of the part.');
      else { setNotice((n) => (n.startsWith(AUTOSAVE_PREFIX) ? '' : n)); say('Autosave is working again'); }
    };
    if (restored.notice) setNotice(restored.notice);
    if (lastAutosaveStatus && !lastAutosaveStatus.ok) autosaveListener(lastAutosaveStatus);
    return () => { autosaveListener = () => {}; };
  }, [say]);

  // Reference planes / axes / points of the rebuilt model.
  useEffect(() => {
    const names = new Map(doc.features.map((f) => [f.id, f.name]));
    vpRef.current?.setRefGeometry(regen?.refGeometry ?? [], names, new Set(treeSel));
  }, [regen, treeSel]); // eslint-disable-line react-hooks/exhaustive-deps
  // Feature command panels pick mainstream CAD style: a click adds or removes the item.
  useEffect(() => { if (vpRef.current) vpRef.current.additiveSelection = pm?.kind === 'feature'; }, [pm]);

  useEffect(() => {
    if (!regen) return;
    const visible = new Set(view.showSketches ? doc.features.filter((f) => f.type === 'sketch' && !f.suppressed && !hiddenSketches.has(f.id) && f.id !== activeSketch).map((f) => f.id) : []);
    vpRef.current?.setSketches(regen.sketches, visible);
  }, [regen, view.showSketches, hiddenSketches, activeSketch]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- exact info for the selection (planes have none)
  useEffect(() => {
    setInfos([]); setDistance(null);
    const subs = selection.filter(isSub);
    if (!subs.length) return;
    Promise.all(subs.slice(0, 2).map((ref) => kernel.call({ op: 'info', ref }))).then(setInfos).catch((e) => setNotice(e.message));
    if (subs.length === 2) kernel.call({ op: 'distance', a: subs[0], b: subs[1] }).then((d) => setDistance(d.distance)).catch(() => {});
  }, [selection]);

  // ---------------------------------------------------------------- live preview (command panel)
  const previewSeq = useRef(0);
  const previewing = useRef(false);
  const preview: PreviewApi = useMemo(() => ({
    show(d, featureId, kind, opts = {}) {
      const seq = ++previewSeq.current;
      kernel.call({ op: 'preview', doc: d, featureId, ...(opts.topology ? { topology: true } : {}) }, { supersede: 'preview' }).then((r) => {
        if (seq !== previewSeq.current) return;
        previewing.current = true;
        vpRef.current?.setMesh(r.base, true);
        // In-place features (fillet, chamfer, shell, draft) send the faces they make instead of a tool body.
        // 'cut' draws on top of the body (shell walls and drafted faces are inside or on it).
        vpRef.current?.setPreview(r.tool ?? r.result ?? null, kind);
        if (opts.topology) { previewTopo.current = r.baseTopology ?? null; setTopoSeq((n) => n + 1); }
        setPreviewMsg(r.ok || opts.quiet ? '' : r.message ?? 'The feature cannot be built with these values.');
      }).catch((e) => { if (seq === previewSeq.current && !opts.quiet && !(e instanceof Superseded)) setPreviewMsg(String(e.message ?? e)); });
    },
    clear() {
      previewSeq.current++;
      vpRef.current?.setPreview(null);
      setPreviewMsg('');
      if (previewTopo.current) { previewTopo.current = null; setTopoSeq((n) => n + 1); }
      if (previewing.current) {
        previewing.current = false;
        // A rebuild in flight will put the real model back itself.
        if (!busyRef.current) vpRef.current?.setMesh(regenRef.current?.mesh ?? null, true);
      }
    },
  }), []);

  // ---------------------------------------------------------------- actions
  const notify = useCallback((m: string) => setNotice(m), []);
  const openFile = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,.chatcad';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      try { store.load(JSON.parse(await f.text())); firstFit.current = true; setPM(null); setTreeSel([]); } catch (e) { setNotice(`Could not open file: ${(e as Error).message}`); }
    };
    inp.click();
  };
  const saveFile = () => download(`${store.state.name}${PART_FILE_EXT}`, store.serialize(), 'application/json');
  /**
   * Export STEP / STL: the worker rebuilds the open document, writes the file and checks it. A good
   * file of the whole part is saved at once. A file with problems, or one that would be missing
   * features that failed to rebuild, is saved only when the user presses the panel's button to
   * save it anyway (`force`). The panel shows the outcome.
   */
  const exportFile: ExportFile = async (req, force = false) => {
    const doc = store.state as CadDocument;
    if (req.kind === 'step') {
      const { text, report, failed } = await kernel.call({ op: 'exportStep', ...req.opts, doc });
      const good = report.ok && failed.length === 0;
      const saved = good || force;
      if (saved) download(req.fileName, text, 'model/step');
      say(saved ? `Saved ${req.fileName}${good ? ' (checked: reads back as the same solid)' : failed.length ? ` without ${failed.length} failed feature${failed.length > 1 ? 's' : ''}` : ' (with problems)'}` : 'STEP not saved: see the panel', !good);
      return { kind: 'step', fileName: req.fileName, saved, report, failed };
    }
    const { data, report, failed } = await kernel.call({ op: 'exportStl', ...req.opts, doc });
    const good = report.watertight && failed.length === 0;
    const saved = good || force;
    if (saved) download(req.fileName, data as Uint8Array<ArrayBuffer>, 'model/stl');
    say(saved ? `Saved ${req.fileName}${good ? ' (checked: watertight, ready to print)' : failed.length ? ` without ${failed.length} failed feature${failed.length > 1 ? 's' : ''}` : ' (with problems)'}` : 'STL not saved: see the panel', !good);
    return { kind: 'stl', fileName: req.fileName, saved, report, failed };
  };

  const normalTo = () => {
    const vp = vpRef.current; if (!vp) return;
    const s = selection[0];
    if (s?.kind === 'plane') return vp.normalTo(PLANE_NORMAL[s.plane]);
    const i = infos[0] as any;
    if (s?.kind === 'face' && i?.kind === 'face' && i.surface === 'plane') return vp.normalTo(i.normal);
    const f = treeSel.map((id) => store.feature(id)).find(Boolean);
    const sk = f?.type === 'sketch' ? f : f && 'sketch' in f ? store.feature(f.sketch) : undefined;
    if (sk?.type === 'sketch') return vp.normalTo(sketchNormal(sk, refPlaneLookup));
    if (s) { setNotice('Normal To needs a plane or a flat face.'); return; }
    vp.nearestStandardView();
  };

  /** Sketch (ribbon, S bar, context menus): on the selected plane or planar face, else ask for a plane. */
  const startSketch = async () => {
    const s = selection[0];
    if (s?.kind === 'plane') { setPM({ kind: 'sketch', plane: s.plane }); return; }
    if (s?.kind === 'face') { setPMRaw(null); setPlanePick(false); await sketcher.startSketch({ kind: 'face', index: s.index }); return; }
    if (s?.kind === 'edge') { setNotice('Select a plane or a flat face to sketch on.'); }
    // A reference plane selected in the tree (mainstream CAD: select Plane1, then Sketch).
    const rp = treeSel.map((id) => store.feature(id)).find((x) => x?.type === 'refPlane');
    if (rp && !s) { setPMRaw(null); setPlanePick(false); await sketcher.startSketch({ kind: 'refPlane', id: rp.id }); return; }
    const f = treeSel.map((id) => store.feature(id)).find((x) => x?.type === 'sketch');
    if (f?.type === 'sketch' && f.plane !== 'face' && !f.offset) { setPM({ kind: 'sketch', plane: f.plane }); return; }
    setPM({ kind: 'sketch' });
  };

  /**
   * Undo / Redo. While a command panel holds a feature being made or edited,
   * the document must not change under it, so Undo waits for OK or Cancel.
   */
  const undoRedo = (which: 'undo' | 'redo') => {
    const word = which === 'undo' ? 'Undo' : 'Redo';
    if (draftPMTitle(pm)) { say(`Close the open panel with OK or Cancel first, then ${word}.`, true); return; }
    const label = which === 'undo' ? store.undoLabel : store.redoLabel;
    if (label === undefined) { say(`Nothing to ${word.toLowerCase()}.`); return; }
    if (which === 'undo') store.undo(); else store.redo();
    say(`${word}: ${label}`);
  };

  const ctx: AppCtx = {
    store, vp: vpRef.current, selection, infos, treeSel, hasSolid: !!regen?.mesh,
    openPM: (p) => setPM(p),
    saveFile, openFile,
    newPart: () => { store.resetPart(); setPM(null); setTreeSel([]); setHiddenSketches(new Set()); },
    rebuild: () => runRegen(store.state),
    view: (v: StandardView) => vpRef.current?.setView(v),
    normalTo, startSketch,
    toggleChat: () => setChatOpen((o) => !o),
    notify,
    pick, treePick, topoSeq,
    pickTopology: () => (previewing.current ? previewTopo.current : regenRef.current?.topology ?? null),
    setSelection: (sel) => vpRef.current?.setSelection(sel),
    // CHAD hides 2D engineering drawings (src/edition.ts, docs/CHAD_SCOPE.md).
    makeDrawing: EDITION.drawings ? () => setDrawingOpen(true) : undefined,
    editing: draftPMTitle(pm),
    undo: () => undoRedo('undo'),
    redo: () => undoRedo('redo'),
  };
  const ctxRef = useRef(ctx); ctxRef.current = ctx;

  const runCommand = (c: Command) => {
    if (c.enabled && !c.enabled(ctxRef.current)) return;
    if (REPEATABLE.has(c.id)) lastCommand.current = c;
    c.run(ctxRef.current);
  };

  const closePM = useCallback(() => setPM(null), []);
  const editFeature = (f: Feature) => { setTreeSel([f.id]); if (f.type !== 'sketch') vpRef.current?.clearSelection(); setPM(editPMFor(f)); };

  // ---------------------------------------------------------------- context menus
  const rollbackAbove = (id: string) => {
    const row = buildRows(store.state).find((r) => r.f.id === id);
    store.setRollback(row ? row.start : store.state.features.findIndex((f) => f.id === id));
  };
  const deleteFeatures = (ids: string[]) => {
    store.transaction(ids.length > 1 ? `Delete ${ids.length} features` : `Delete ${store.feature(ids[0])?.name ?? 'feature'}`, () => {
      for (const id of ids) if (store.feature(id)) store.deleteFeature(id);
    });
    setTreeSel([]);
  };
  const toggleSketchVisible = (id: string) => setHiddenSketches((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const treeMenu = (t: TreeTarget, x: number, y: number) => {
    const items: MenuItem[] = [];
    let title: string | undefined;
    if (t.type === 'feature') {
      const f = store.feature(t.id); if (!f) return;
      title = f.name;
      const sketchId = f.type === 'sketch' ? f.id : sketchesUsedBy(f)[0];
      if (f.type !== 'sketch') items.push({ label: 'Edit Feature', icon: iconFor(f), run: () => editFeature(f) });
      if (sketchId) {
        items.push({ label: 'Edit Sketch', icon: 'sketch', run: () => setPM({ kind: 'sketch', editId: sketchId }) });
        items.push({ label: hiddenSketches.has(sketchId) ? 'Show Sketch' : 'Hide Sketch', icon: 'eye', run: () => toggleSketchVisible(sketchId) });
      }
      if (f.type === 'sketch') items.push({ label: 'Normal To', icon: 'views', run: () => vpRef.current?.normalTo(sketchNormal(f, refPlaneLookup)) });
      if (f.type === 'refPlane') items.push({ label: 'Sketch', icon: 'sketch', run: () => { setPMRaw(null); setPlanePick(false); void sketcher.startSketch({ kind: 'refPlane', id: f.id }); } });
      items.push({ separator: true, label: '' });
      items.push({ label: f.suppressed ? 'Unsuppress' : 'Suppress', run: () => store.setSuppressed(f.id, !f.suppressed) });
      items.push({ label: 'Rename', shortcut: 'F2', run: () => setRenaming(f.id) });
      items.push({ label: 'Roll Back', icon: 'rollback', run: () => rollbackAbove(f.id) });
      if (store.state.rollback !== null) items.push({ label: 'Roll to End', run: () => store.setRollback(null) });
      items.push({ separator: true, label: '' });
      items.push({ label: 'Delete', danger: true, shortcut: 'Del', run: () => deleteFeatures(treeSel.includes(f.id) ? treeSel : [f.id]) });
    } else if (t.type === 'plane') {
      title = PLANE_NAMES[t.plane];
      const sel: SelRef[] = [{ kind: 'plane', plane: t.plane }];
      items.push({ label: 'Sketch', icon: 'sketch', run: () => { vpRef.current?.setSelection(sel); setPM({ kind: 'sketch', plane: t.plane }); } });
      items.push({ label: 'Normal To', icon: 'views', run: () => vpRef.current?.normalTo(PLANE_NORMAL[t.plane]) });
      items.push({ label: view.showPlanes ? 'Hide All Planes' : 'Show All Planes', icon: 'eye', run: () => setViewOptions({ showPlanes: !view.showPlanes }) });
    } else if (t.type === 'part') {
      title = store.state.name;
      items.push({ label: 'Rename Part', run: () => setRenaming('__part__') });
      items.push({ label: 'Edit Material', icon: 'material', run: () => setPM({ kind: 'material' }) });
      items.push({ label: 'Mass Properties', icon: 'mass', disabled: !regen?.mesh, run: () => setPM({ kind: 'mass' }) });
      items.push({ label: 'Parameters', icon: 'params', run: () => setPM({ kind: 'params' }) });
    } else if (t.type === 'material') {
      title = 'Material';
      items.push({ label: 'Edit Material', icon: 'material', run: () => setPM({ kind: 'material' }) });
      if (store.state.material) items.push({ label: 'Remove Material', run: () => store.setMaterial(null) });
    } else return;
    setPopup({ kind: 'menu', x, y, title, items });
  };

  const openViewportMenu = (ref: SelRef | null, x: number, y: number) => {
    const vp = vpRef.current; if (!vp) return;
    const c = ctxRef.current;
    if (ref && !vp.getSelection().some((s) => s.kind === ref.kind && (s.kind === 'plane' ? s.plane === (ref as any).plane : (s as SubRef).index === (ref as SubRef).index))) vp.setSelection([ref]);
    const items: MenuItem[] = [];
    let title: string | undefined;
    if (ref?.kind === 'plane') {
      title = PLANE_NAMES[ref.plane];
      items.push({ label: 'Sketch', icon: 'sketch', run: () => ctxRef.current.startSketch() });
      items.push({ label: 'Normal To', icon: 'views', run: () => vp.normalTo(PLANE_NORMAL[ref.plane]) });
    } else if (ref?.kind === 'face') {
      title = 'Face';
      items.push({ label: 'Sketch', icon: 'sketch', run: () => ctxRef.current.startSketch() });
      items.push({ label: 'Normal To', icon: 'views', shortcut: 'Ctrl+8', run: () => ctxRef.current.normalTo() });
      items.push({ label: 'Measure', icon: 'measure', run: () => setPM({ kind: 'measure' }) });
    } else if (ref?.kind === 'edge') {
      title = 'Edge';
      items.push({ label: 'Measure', icon: 'measure', run: () => setPM({ kind: 'measure' }) });
    }
    if (items.length) items.push({ separator: true, label: '' });
    items.push({ label: 'Zoom to Fit', icon: 'fit', shortcut: 'F', run: () => vp.fit() });
    items.push({ label: 'Previous View', icon: 'prev', shortcut: 'Ctrl+Shift+Z', run: () => vp.previousView() });
    items.push({ label: 'View Orientation…', icon: 'views', shortcut: 'Space', run: () => setPopup({ kind: 'orient', x, y }) });
    items.push({ label: c.store.state.features.length ? (view.showPlanes ? 'Hide Planes' : 'Show Planes') : 'Show Planes', icon: 'plane', run: () => setViewOptions({ showPlanes: !view.showPlanes }) });
    if (vp.getSelection().length) items.push({ label: 'Clear Selection', shortcut: 'Esc', run: () => vp.clearSelection() });
    setPopup({ kind: 'menu', x, y, title, items });
  };
  const openViewportMenuRef = useRef(openViewportMenu); openViewportMenuRef.current = openViewportMenu;
  useEffect(() => { if (vpRef.current) vpRef.current.onContextMenu = (r, x, y) => openViewportMenuRef.current(r, x, y); }, []);

  // ---------------------------------------------------------------- keyboard (mainstream CAD defaults)
  useEffect(() => {
    const onMove = (e: PointerEvent) => { mouse.current = { x: e.clientX, y: e.clientY }; };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (document.body.dataset.drawingMode === 'on') return;
      if (document.querySelector('.popup')) return; // popups handle their own keys
      const c = ctxRef.current;
      const vp = vpRef.current;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      // The interactive sketcher owns letter keys while a sketch is open; view keys stay global.
      const sketching = document.body.dataset.sketchMode === 'on';
      const done = () => { e.preventDefault(); e.stopPropagation(); };

      // Ctrl+1..8 standard views / Normal To (Shift+1..8 as a fallback for keyboards/browsers that take Ctrl+digit)
      const digit = /^Digit([1-8])$/.exec(e.code)?.[1] ?? /^Numpad([1-8])$/.exec(e.code)?.[1];
      if (digit && (ctrl || (e.shiftKey && !e.altKey))) {
        done();
        const views: StandardView[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];
        if (digit === '8') c.normalTo(); else c.view(views[Number(digit) - 1]);
        return;
      }
      if (ctrl && e.shiftKey && k === 'z') { done(); vp?.previousView(); return; }
      if (ctrl && k === 'z') { done(); c.undo?.(); return; }
      if (ctrl && k === 'y') { done(); c.redo?.(); return; }
      if (ctrl && k === 's') { done(); c.saveFile(); return; }
      if (ctrl && k === 'o') { done(); c.openFile(); return; }
      if (ctrl && (k === 'b' || k === 'q')) { done(); c.rebuild(); return; }
      if (ctrl && k === 'r') { done(); return; } // Redraw in mainstream CAD; the view redraws continuously here, and this stops an accidental page reload.
      if (ctrl && e.key.startsWith('Arrow')) {
        done();
        const d = 40; const m: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
        vp?.stepPan(...m[e.key]); return;
      }
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { done(); vp?.stepRoll(e.key === 'ArrowLeft' ? 15 : -15); return; }
      if (ctrl || e.altKey) return;
      if (e.key.startsWith('Arrow')) {
        done();
        const step = e.shiftKey ? 90 : 15;
        const m: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        vp?.stepRotate(...m[e.key]); return;
      }
      if (e.key === ' ') { done(); setPopup({ kind: 'orient', x: mouse.current.x, y: mouse.current.y }); return; }
      if (k === 'f') { done(); vp?.fit(); return; }
      if (k === 'z') { done(); vp?.stepZoom(e.shiftKey); return; }
      if (k === 's' && !e.shiftKey) { done(); setPopup({ kind: 'sbar', x: mouse.current.x, y: mouse.current.y }); return; }
      if (k === 'w' && !e.shiftKey) { done(); setPopup({ kind: 'search' }); return; }
      if (sketching) return;
      if (e.key === 'Escape') {
        done();
        if (pmRef.current) setPM(null); else { vp?.clearSelection(); setTreeSel([]); }
        return;
      }
      if (e.key === 'Enter') {
        done();
        if (pmRef.current) { document.querySelector<HTMLButtonElement>('.pm .pm-ok:not(:disabled)')?.click(); return; }
        if (lastCommand.current) runCommand(lastCommand.current);
        return;
      }
      if (e.key === 'Delete' && c.treeSel.length && !pmRef.current) { done(); deleteFeatures(c.treeSel); return; }
      if (e.key === 'F2' && c.treeSel.length) { done(); setRenaming(c.treeSel[0]); return; }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('keydown', onKey); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pmRef = useRef<PMState>(null); pmRef.current = pm;
  useEffect(() => {
    const want = pm?.kind === 'mass';
    if (want !== massWanted.current) { massWanted.current = want; if (want) runRegen(store.state); }
  }, [pm, runRegen]);

  // ---------------------------------------------------------------- render
  const selectedPlanes = selection.flatMap((s) => (s.kind === 'plane' ? [s.plane] : []));
  const selectPlane = (plane: BasePlane, add: boolean) => {
    const vp = vpRef.current; if (!vp) return;
    const ref: SelRef = { kind: 'plane', plane };
    const cur = vp.getSelection();
    if (add) vp.setSelection(cur.some((s) => s.kind === 'plane' && s.plane === plane) ? cur.filter((s) => !(s.kind === 'plane' && s.plane === plane)) : [...cur, ref]);
    else vp.setSelection([ref]);
    setTreeSel([]);
  };
  // Dynamic highlight (mainstream CAD): the pointer over a feature in the tree lights its faces;
  // features selected in the tree show their faces in the selection colour. Only on the real
  // model (not while a command panel preview or a sketch is on screen).
  const highlightActive = !pm && !sketcher.controller;
  useEffect(() => { if (!highlightActive) setTreeHover(null); }, [highlightActive]);
  useEffect(() => {
    const vp = vpRef.current; if (!vp) return;
    const topo = highlightActive && !previewing.current ? regen?.topology : null;
    const hov = treeHover ? [treeHover] : [];
    const isSketch = (id: string) => store.feature(id)?.type === 'sketch';
    vp.setEmphasis(facesOfFeatures(topo, hov), facesOfFeatures(topo, treeSel));
    vp.setSketchEmphasis(highlightActive ? hov.filter(isSketch) : [], highlightActive ? treeSel.filter(isSketch) : []);
  }, [regen, treeSel, treeHover, highlightActive]);
  // A face picked in the view marks the feature that made it in the tree (and scrolls to it).
  const ownerMarks = useMemo(() => (highlightActive
    ? featuresOfFaces(regen?.topology, selection.flatMap((s) => (s.kind === 'face' ? [s.index] : [])))
    : []), [highlightActive, regen, selection]);

  const treeProps = {
    doc, store, status: regen?.status ?? [], busy, treeSel, setTreeSel: (ids: string[]) => { setTreeSel(ids); if (ids.length) vpRef.current?.clearSelection(); },
    selectedPlanes, selectPlane, hoverPlane: (p: BasePlane | null) => vpRef.current?.setHighlightedPlanes(p ? [p] : []),
    hoverFeature: setTreeHover, marked: ownerMarks,
    hiddenSketches, renaming, setRenaming, onEdit: editFeature, onMaterial: () => setPM({ kind: 'material' }), onContextMenu: treeMenu,
  };
  const u = doc.units;
  const failed = (regen?.status ?? []).filter((s) => !s.ok);
  const massState = rebuilds.massState(doc);
  // Quick measurement of the selection (the Measure panel shows the full details itself).
  const selSummary = pm?.kind === 'measure' ? '' : selectionSummary(infos, distance, u);

  return (
    <div className={`app ${chatOpen ? '' : 'no-chat'}`}
      onMouseOver={(e) => { const el = (e.target as Element).closest?.('[data-hint]') as HTMLElement | null; setCmdHint(el?.dataset.hint ?? ''); }}
      onMouseLeave={() => setCmdHint('')}>
      <Ribbon ctx={ctx} onRun={runCommand} onSearch={() => setPopup({ kind: 'search' })} title={doc.name} />

      <aside className="left">
        <div className="left-tabs">
          <span className={`left-tab ${!pm && !sketcher.controller && !planePick ? 'on' : ''}`} title="Feature tree"><Icon name="part" size={16} /></span>
          <span className={`left-tab ${pm || sketcher.controller || planePick ? 'on' : ''}`} title="Properties panel"><Icon name="params" size={16} /></span>
        </div>
        {sketcher.controller
          ? <SketchPanel ctl={sketcher.controller} sketcher={sketcher} store={store} onTyped={(id) => setPMRaw({ kind: 'sketch', editId: id, typed: true })} />
          : planePick && !pm
          ? <SketchPlanePicker onPick={(plane) => setPM({ kind: 'sketch', plane })} onTyped={() => { setPlanePick(false); setPMRaw({ kind: 'sketch', typed: true }); }} onClose={() => setPlanePick(false)} />
          : pm
          ? <CommandPanel pm={pm} ctx={ctx} close={closePM} preview={preview} regen={regen} massState={massState} distance={distance} exportFile={exportFile} viewOptions={view} setViewOptions={setViewOptions} />
          : <FeatureTree {...treeProps} />}
      </aside>

      <main className="viewport" ref={hostRef}>
        <div className="hud">
          <button title="Zoom to Fit (F)" data-hint="Zoom the model to fit the window" onClick={() => vpRef.current?.fit()}><Icon name="fit" /></button>
          <button title="Previous View (Ctrl+Shift+Z)" data-hint="Go back to the previous view" onClick={() => vpRef.current?.previousView()}><Icon name="prev" /></button>
          <button title="View Orientation (Space)" data-hint="Change the view orientation" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPopup({ kind: 'orient', x: r.left, y: r.bottom + 4 }); }}><Icon name="views" /></button>
          <button title={view.showEdges ? 'Display Style: Shaded With Edges (click for Shaded)' : 'Display Style: Shaded (click for Shaded With Edges)'} data-hint="Switch between Shaded With Edges and Shaded" onClick={() => setViewOptions({ showEdges: !view.showEdges })}><Icon name={view.showEdges ? 'views' : 'shaded'} /></button>
          <button title="Hide/Show Items" data-hint="Show or hide planes, sketches and the origin" onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPopup({ kind: 'menu', x: r.left, y: r.bottom + 4, title: 'Hide/Show Items', items: [
              { label: `${view.showPlanes ? '✓ ' : ''}Planes`, icon: 'plane', run: () => setViewOptions({ showPlanes: !view.showPlanes }) },
              { label: `${view.showSketches ? '✓ ' : ''}Sketches`, icon: 'sketch', run: () => setViewOptions({ showSketches: !view.showSketches }) },
              { label: `${view.showOrigin ? '✓ ' : ''}Origin`, icon: 'origin', run: () => setViewOptions({ showOrigin: !view.showOrigin }) },
            ] });
          }}><Icon name="eye" /></button>
          <span className="hud-sep" />
          <button className={chatOpen ? 'on' : ''} title="AI Chat" data-hint="Show or hide the AI chat" onClick={() => setChatOpen(!chatOpen)}><Icon name="chat" /></button>
        </div>
        {pm && (
          <div className="flyout-tree">
            <FeatureTree {...treeProps} flyout onEdit={() => {}} setTreeSel={(ids) => {
              // While a feature PM is open, clicking a sketch in the flyout tree picks it as the profile.
              const f = store.feature(ids[0]);
              if (f?.type === 'sketch' && (pm.kind === 'extrude' || pm.kind === 'revolve')) setPM({ ...pm, sketchId: f.id });
              const last = store.feature(ids.at(-1) ?? '');
              if (last && pm.kind === 'feature') setTreePick((t) => ({ seq: (t?.seq ?? 0) + 1, id: last.id }));
            }} selectPlane={(plane, add) => {
              if (pm.kind === 'feature') setTreePick((t) => ({ seq: (t?.seq ?? 0) + 1, id: `plane:${plane}` }));
              else selectPlane(plane, add);
            }} />
          </div>
        )}
        {sketcher.controller && <SketchLayer ctl={sketcher.controller} sketcher={sketcher} />}
        {previewMsg && <div className="toast warn">{previewMsg}</div>}
        {flash?.warn && !previewMsg && <div className="toast warn" onClick={() => setFlash(null)}>{flash.text}</div>}
        {(notice || sketcher.error) && <div className="toast err" onClick={() => setNotice('')} title="Click to dismiss">{notice || sketcher.error}</div>}
      </main>

      {chatOpen && (
        <aside className="right">
          <ChatDock bridge={bridge} />
        </aside>
      )}

      <footer className="status">
        <span className="st-hint">{cmdHint || (flash && !flash.warn ? flash.text : '') || hint || (selection.length ? `${selection.length} selected` : treeSel.length ? `${treeSel.length} feature${treeSel.length > 1 ? 's' : ''} selected` : 'Ready')}</span>
        {selSummary && <span className="st-measure" title="Exact values of the selection">{selSummary}</span>}
        {failed.length > 0 && <span className="st-err" title={failed.map((f) => f.message).join('\n')}><Icon name="error" size={13} /> {failed.length} rebuild error{failed.length > 1 ? 's' : ''}</span>}
        {doc.rollback !== null && <span className="st-warn">Rolled back</span>}
        <span className="st-right">
          <span>{busy ? 'Rebuilding…' : regen ? `Rebuilt in ${regen.ms.toFixed(0)} ms` : ''}</span>
          <span>{activeSketch ? `Editing ${store.feature(activeSketch)?.name ?? 'Sketch'}` : 'Editing Part'}</span>
          <span>Mouse: {NAV_PRESETS[view.nav].label}</span>
          <select className="units" title="Unit system" value={u} onChange={(e) => store.setUnits(e.target.value as 'in' | 'mm')}>
            <option value="in">IPS (inch, pound, second)</option>
            <option value="mm">MMGS (mm, gram, second)</option>
          </select>
        </span>
      </footer>

      {popup?.kind === 'menu' && <ContextMenu x={popup.x} y={popup.y} title={popup.title} items={popup.items} onClose={() => setPopup(null)} />}
      {popup?.kind === 'orient' && <OrientationMenu x={popup.x} y={popup.y} ctx={ctx} onClose={() => setPopup(null)} />}
      {popup?.kind === 'sbar' && <ShortcutBar x={popup.x} y={popup.y} ctx={ctx} tools={sketcher.controller ? sketchShortcutTools(sketcher.controller, sketcher) : undefined} onClose={() => setPopup(null)} onRun={runCommand} />}
      {popup?.kind === 'search' && <CommandSearch ctx={ctx} onClose={() => setPopup(null)} onRun={runCommand} />}
      {drawingOpen && <div style={{ position: 'fixed', inset: 0, zIndex: 60 }}><DrawingWorkspace store={store} kernel={kernel} onClose={() => setDrawingOpen(false)} /></div>}
    </div>
  );
}
