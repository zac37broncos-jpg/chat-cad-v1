/**
 * The command registry behind the ribbon, the S shortcut
 * bar, the W command search and "Enter repeats last command". Every UI
 * entry point calls the same commands, which call the same DocumentStore
 * API the AI uses.
 */
import type { DocumentStore } from '../core/store';
import type { BasePlane, Feature, SketchFeature } from '../core/model';
import type { ModelingFeatureType, Vec3 } from '../core/featureTypes';
import type { Topology } from '../kernel/naming';
import type { SelRef } from '../kernel/protocol';
import type { EntityInfo } from '../kernel/query';
import type { StandardView, Viewport } from '../render/viewport';
import type { IconName } from './icons';
import { PART_FILE_EXT } from '../brand';

/** What the command panel is showing. */
export type PMState =
  | { kind: 'extrude'; cut: boolean; editId?: string; sketchId?: string }
  | { kind: 'revolve'; cut: boolean; editId?: string; sketchId?: string }
  /** typed: the exact-coordinates sketch dialog instead of the interactive sketcher. */
  | { kind: 'sketch'; editId?: string; plane?: BasePlane; offset?: string; typed?: boolean }
  /** Fillet, chamfer, Hole, patterns, mirror, shell, draft, rib, sweep, loft, reference geometry. */
  | { kind: 'feature'; type: ModelingFeatureType; editId?: string; cut?: boolean }
  | { kind: 'params' }
  | { kind: 'material' }
  | { kind: 'mass' }
  | { kind: 'measure' }
  | { kind: 'exportStl' }
  | { kind: 'exportStep' }
  | { kind: 'options' }
  | null;

export interface AppCtx {
  store: DocumentStore;
  vp: Viewport | null;
  /** Viewport selection (faces, edges, planes). */
  selection: SelRef[];
  /** Exact info for the first two viewport selections (planes excluded). */
  infos: EntityInfo[];
  /** Feature ids selected in the feature tree. */
  treeSel: string[];
  openPM(pm: PMState): void;
  hasSolid: boolean;
  saveFile(): void;
  openFile(): void;
  newPart(): void;
  rebuild(): void;
  view(v: StandardView): void;
  normalTo(): void;
  toggleChat(): void;
  /** Sketch on the selected plane / flat face (or ask for one). */
  startSketch(): void;
  /** Short message in the viewport (errors, hints). */
  notify(msg: string): void;
  makeDrawing?(): void;
  /** Last click in the viewport (seq changes on every click). Feature command panels read picks from it. */
  pick: { seq: number; ref: SelRef | null; point: Vec3 | null } | null;
  /** Last click on a feature or plane in the flyout tree while a command panel is open. */
  treePick: { seq: number; id: string } | null;
  /** Names of the faces/edges currently on screen (the preview base while previewing). */
  pickTopology(): Topology | null;
  /** Changes whenever pickTopology() does. */
  topoSeq: number;
  /** Replace the viewport highlight (no pick event). */
  setSelection(sel: SelRef[]): void;
  /**
   * Name of the open command panel that holds unsaved values (a feature being
   * created or edited). Undo/Redo wait until it is closed with OK or Cancel.
   */
  editing?: string;
  /** Undo / Redo with the app's feedback (status bar note, guard while editing). */
  undo?(): void;
  redo?(): void;
}

/** Title of a command panel that holds a draft of a feature, or undefined. */
export function draftPMTitle(pm: PMState): string | undefined {
  if (!pm) return undefined;
  switch (pm.kind) {
    case 'extrude': return pm.cut ? 'Cut-Extrude' : 'Extrude';
    case 'revolve': return pm.cut ? 'Cut-Revolve' : 'Revolve';
    case 'feature': return 'feature';
    case 'sketch': return pm.typed ? 'Sketch' : undefined;
    default: return undefined;
  }
}

export type CommandGroup = 'file' | 'features' | 'sketch' | 'evaluate' | 'view';

export interface Command {
  id: string;
  label: string;
  icon: IconName;
  group: CommandGroup;
  /** One-line tooltip, mainstream CAD style: what it does. */
  hint: string;
  shortcut?: string;
  run(ctx: AppCtx): void;
  enabled?(ctx: AppCtx): boolean;
  /** Shown in the S shortcut bar. */
  shortcutBar?: boolean;
}

/** Sketches a feature consumes (shown nested under it in the tree). */
export function sketchesUsedBy(f: Feature): string[] {
  switch (f.type) {
    case 'extrude': case 'revolve': case 'rib': return [f.sketch];
    case 'sweep': return f.profile ? [f.profile, f.path] : [f.path];
    case 'loft': return f.profiles;
    default: return [];
  }
}

/** Sketch the user most likely means: selected in the tree, else the newest sketch not yet used by a feature. */
export function pickSketch(store: DocumentStore, treeSel: string[]): string | undefined {
  const feats = store.state.features;
  const sel = treeSel.map((id) => feats.find((f) => f.id === id)).find((f) => f?.type === 'sketch');
  if (sel) return sel.id;
  const used = new Set(feats.flatMap(sketchesUsedBy));
  const free = feats.filter((f): f is SketchFeature => f.type === 'sketch' && !used.has(f.id) && !f.suppressed);
  return free.at(-1)?.id ?? feats.filter((f) => f.type === 'sketch').at(-1)?.id;
}

/**
 * Plane for a new sketch from the current selection: a reference plane, or a
 * planar face parallel to one (mapped to that plane plus an offset). Faces at
 * other angles need the sketcher's face-plane support.
 */
export function sketchPlaneFromSelection(sel: SelRef | undefined, faceInfo: EntityInfo | undefined): { plane: BasePlane; offset?: string } | { error: string } | null {
  const s = sel;
  if (!s) return null;
  if (s.kind === 'plane') return { plane: s.plane };
  if (s.kind !== 'face') return { error: 'Select a plane or a flat face to sketch on.' };
  const info = faceInfo as any;
  if (!info || info.kind !== 'face') return { error: 'Measuring the face… try again in a moment.' };
  if (info.surface !== 'plane') return { error: 'That face is curved. Select a flat face or a plane.' };
  const n = info.normal as [number, number, number];
  const o = info.origin as [number, number, number];
  const tol = 1e-9;
  const mm = (v: number) => `${Number(v.toPrecision(15))} mm`;
  if (Math.abs(Math.abs(n[2]) - 1) < tol) return { plane: 'XY', offset: mm(o[2]) };
  if (Math.abs(Math.abs(n[1]) - 1) < tol) return { plane: 'XZ', offset: mm(-o[1]) }; // Front plane normal is -Y
  if (Math.abs(Math.abs(n[0]) - 1) < tol) return { plane: 'YZ', offset: mm(o[0]) };
  return { error: 'Sketching on angled faces comes with the interactive sketcher. Use a face parallel to Front, Top or Right for now.' };
}


const hasSketch = (c: AppCtx) => c.store.state.features.some((f) => f.type === 'sketch');
const NON_SOLID = new Set(['sketch', 'refPlane', 'refAxis', 'refPoint']);
const hasBody = (c: AppCtx) => c.store.state.features.some((f) => !NON_SOLID.has(f.type) && !f.suppressed);
const sketchCount = (c: AppCtx) => c.store.state.features.filter((f) => f.type === 'sketch').length;
const feat = (type: ModelingFeatureType, cut?: boolean) => (c: AppCtx) => c.openPM({ kind: 'feature', type, ...(cut ? { cut } : {}) });

export const COMMANDS: Command[] = [
  // ----- file
  { id: 'new', label: 'New', icon: 'newdoc', group: 'file', hint: 'Start a new part (undoable)', run: (c) => c.newPart() },
  { id: 'open', label: 'Open', icon: 'open', group: 'file', hint: `Open a part file (${PART_FILE_EXT} or .chatcad.json)`, shortcut: 'Ctrl+O', run: (c) => c.openFile() },
  { id: 'save', label: 'Save', icon: 'save', group: 'file', hint: `Save the part as a ${PART_FILE_EXT} file`, shortcut: 'Ctrl+S', run: (c) => c.saveFile() },
  { id: 'undo', label: 'Undo', icon: 'undo', group: 'file', hint: 'Undo the last change', shortcut: 'Ctrl+Z', run: (c) => (c.undo ? c.undo() : c.store.undo()), enabled: (c) => c.store.canUndo && !c.editing },
  { id: 'redo', label: 'Redo', icon: 'redo', group: 'file', hint: 'Redo the last undone change', shortcut: 'Ctrl+Y', run: (c) => (c.redo ? c.redo() : c.store.redo()), enabled: (c) => c.store.canRedo && !c.editing },
  { id: 'rebuild', label: 'Rebuild', icon: 'rebuild', group: 'file', hint: 'Rebuild the model', shortcut: 'Ctrl+B', run: (c) => c.rebuild() },
  { id: 'exportStep', label: 'Export STEP', icon: 'export', group: 'file', hint: 'Save a .step file: the exact solid for other CAD programs, print services and CNC, in inches or mm', run: (c) => c.openPM({ kind: 'exportStep' }), enabled: (c) => c.hasSolid },
  { id: 'exportStl', label: 'Export STL', icon: 'export', group: 'file', hint: 'Save a .stl file for 3D printing: a checked, watertight mesh in mm for the slicer', run: (c) => c.openPM({ kind: 'exportStl' }), enabled: (c) => c.hasSolid },
  { id: 'options', label: 'Options', icon: 'options', group: 'file', hint: 'Mouse, view and display options', run: (c) => c.openPM({ kind: 'options' }) },

  // ----- features
  { id: 'boss', label: 'Extrude', icon: 'boss', group: 'features', shortcutBar: true, hint: 'Extrude a sketch to add material', enabled: hasSketch,
    run: (c) => c.openPM({ kind: 'extrude', cut: false, sketchId: pickSketch(c.store, c.treeSel) }) },
  { id: 'revolve', label: 'Revolve', icon: 'revolve', group: 'features', shortcutBar: true, hint: 'Revolve a sketch around a line to add material', enabled: hasSketch,
    run: (c) => c.openPM({ kind: 'revolve', cut: false, sketchId: pickSketch(c.store, c.treeSel) }) },
  { id: 'cutExtrude', label: 'Extruded Cut', icon: 'cut', group: 'features', shortcutBar: true, hint: 'Extrude a sketch to remove material', enabled: (c) => hasSketch(c) && hasBody(c),
    run: (c) => c.openPM({ kind: 'extrude', cut: true, sketchId: pickSketch(c.store, c.treeSel) }) },
  { id: 'cutRevolve', label: 'Revolved Cut', icon: 'revcut', group: 'features', shortcutBar: true, hint: 'Revolve a sketch to remove material', enabled: (c) => hasSketch(c) && hasBody(c),
    run: (c) => c.openPM({ kind: 'revolve', cut: true, sketchId: pickSketch(c.store, c.treeSel) }) },
  { id: 'sweep', label: 'Sweep', icon: 'sweep', group: 'features', hint: 'Sweep a closed profile (or a circle of a given diameter) along a path sketch', enabled: (c) => sketchCount(c) >= 1, run: feat('sweep') },
  { id: 'loft', label: 'Loft', icon: 'loft', group: 'features', hint: 'Blend between two or more profile sketches', enabled: (c) => sketchCount(c) >= 2, run: feat('loft') },
  { id: 'cutSweep', label: 'Swept Cut', icon: 'sweepCut', group: 'features', hint: 'Remove material by sweeping a profile (or a circle) along a path', enabled: (c) => sketchCount(c) >= 1 && hasBody(c), run: feat('sweep', true) },
  { id: 'cutLoft', label: 'Lofted Cut', icon: 'loftCut', group: 'features', hint: 'Remove material by blending between profiles', enabled: (c) => sketchCount(c) >= 2 && hasBody(c), run: feat('loft', true) },
  { id: 'fillet', label: 'Fillet', icon: 'fillet', group: 'features', shortcutBar: true, hint: 'Round edges: constant, variable or face fillet', enabled: hasBody, run: feat('fillet') },
  { id: 'chamfer', label: 'Chamfer', icon: 'chamfer', group: 'features', shortcutBar: true, hint: 'Bevel edges: distance, two distances or distance-angle', enabled: hasBody, run: feat('chamfer') },
  { id: 'hole', label: 'Hole', icon: 'hole', group: 'features', shortcutBar: true, hint: 'Counterbore, countersink, tapped and clearance holes from standard tables', enabled: hasBody, run: feat('hole') },
  { id: 'linearPattern', label: 'Linear Pattern', icon: 'lpattern', group: 'features', hint: 'Copy features along one or two directions', enabled: hasBody, run: feat('linearPattern') },
  { id: 'circularPattern', label: 'Circular Pattern', icon: 'cpattern', group: 'features', hint: 'Copy features around an axis', enabled: hasBody, run: feat('circularPattern') },
  { id: 'mirror', label: 'Mirror', icon: 'mirror', group: 'features', hint: 'Mirror features or the whole body about a plane', enabled: hasBody, run: feat('mirror') },
  { id: 'rib', label: 'Rib', icon: 'rib', group: 'features', hint: 'Thin wall from an open sketch line out to the part', enabled: (c) => hasSketch(c) && hasBody(c), run: feat('rib') },
  { id: 'draft', label: 'Draft', icon: 'draft', group: 'features', hint: 'Taper faces from a neutral plane (for molding and casting)', enabled: hasBody, run: feat('draft') },
  { id: 'shell', label: 'Shell', icon: 'shell', group: 'features', hint: 'Hollow the part to a wall thickness, removing the faces you pick', enabled: hasBody, run: feat('shell') },
  { id: 'refPlane', label: 'Plane', icon: 'refPlane', group: 'features', hint: 'Reference plane: offset, at an angle, through 3 points or a mid plane', run: feat('refPlane') },
  { id: 'refAxis', label: 'Axis', icon: 'refAxis', group: 'features', hint: 'Reference axis: from a cylinder, an edge, two planes or two points', run: feat('refAxis') },
  { id: 'refPoint', label: 'Point', icon: 'refPoint', group: 'features', hint: 'Reference point: coordinates, arc center or face center', run: feat('refPoint') },
  { id: 'params', label: 'Parameters', icon: 'params', group: 'features', hint: 'Named dimensions (design variables) used in any field', run: (c) => c.openPM({ kind: 'params' }) },

  // ----- sketch
  { id: 'sketch', label: 'Sketch', icon: 'sketch', group: 'sketch', shortcutBar: true, hint: 'Sketch on the selected plane or flat face', run: (c) => c.startSketch() },
  { id: 'editSketch', label: 'Edit Sketch', icon: 'sketch', group: 'sketch', hint: 'Edit the selected sketch', enabled: (c) => !!selectedSketch(c),
    run: (c) => { const id = selectedSketch(c); if (id) c.openPM({ kind: 'sketch', editId: id }); } },

  // ----- evaluate
  { id: 'measure', label: 'Measure', icon: 'measure', group: 'evaluate', shortcutBar: true, hint: 'Exact lengths, areas, radii and distances of selected faces and edges', run: (c) => c.openPM({ kind: 'measure' }) },
  { id: 'mass', label: 'Mass Properties', icon: 'mass', group: 'evaluate', hint: 'Volume, area, mass and center of mass', run: (c) => c.openPM({ kind: 'mass' }), enabled: (c) => c.hasSolid },
  { id: 'material', label: 'Edit Material', icon: 'material', group: 'evaluate', hint: 'Set the part material used for mass', run: (c) => c.openPM({ kind: 'material' }) },

  // ----- view
  { id: 'fit', label: 'Zoom to Fit', icon: 'fit', group: 'view', shortcut: 'F', hint: 'Fit the model in the window', run: (c) => c.vp?.fit() },
  { id: 'prevView', label: 'Previous View', icon: 'prev', group: 'view', shortcut: 'Ctrl+Shift+Z', hint: 'Undo the last view change', run: (c) => c.vp?.previousView() },
  { id: 'normalTo', label: 'Normal To', icon: 'views', group: 'view', shortcut: 'Ctrl+8', shortcutBar: true, hint: 'Look straight at the selected plane or face', run: (c) => c.normalTo() },
  { id: 'front', label: 'Front', icon: 'views', group: 'view', shortcut: 'Ctrl+1', hint: 'Front view', run: (c) => c.view('front') },
  { id: 'back', label: 'Back', icon: 'views', group: 'view', shortcut: 'Ctrl+2', hint: 'Back view', run: (c) => c.view('back') },
  { id: 'left', label: 'Left', icon: 'views', group: 'view', shortcut: 'Ctrl+3', hint: 'Left view', run: (c) => c.view('left') },
  { id: 'right', label: 'Right', icon: 'views', group: 'view', shortcut: 'Ctrl+4', hint: 'Right view', run: (c) => c.view('right') },
  { id: 'top', label: 'Top', icon: 'views', group: 'view', shortcut: 'Ctrl+5', hint: 'Top view', run: (c) => c.view('top') },
  { id: 'bottom', label: 'Bottom', icon: 'views', group: 'view', shortcut: 'Ctrl+6', hint: 'Bottom view', run: (c) => c.view('bottom') },
  { id: 'iso', label: 'Isometric', icon: 'views', group: 'view', shortcut: 'Ctrl+7', hint: 'Isometric view', run: (c) => c.view('iso') },
  { id: 'chat', label: 'AI Chat', icon: 'chat', group: 'view', hint: 'Show or hide the AI chat', run: (c) => c.toggleChat() },
];

export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/** Commands that "Enter = repeat last command" is allowed to repeat. */
export const REPEATABLE = new Set(['boss', 'revolve', 'cutExtrude', 'cutRevolve', 'sketch', 'measure', 'mass', 'material', 'params',
  'sweep', 'loft', 'cutSweep', 'cutLoft', 'fillet', 'chamfer', 'hole', 'linearPattern', 'circularPattern', 'mirror', 'rib', 'draft', 'shell', 'refPlane', 'refAxis', 'refPoint']);

function selectedSketch(c: AppCtx): string | undefined {
  const feats = c.store.state.features;
  for (const id of c.treeSel) {
    const f = feats.find((x) => x.id === id);
    if (f?.type === 'sketch') return f.id;
    if (f && (f.type === 'extrude' || f.type === 'revolve')) return f.sketch;
  }
  return undefined;
}

/** Command panel to open when the user edits a feature (double-click / Edit Feature). */
export function editPMFor(f: Feature): PMState {
  if (f.type === 'sketch') return { kind: 'sketch', editId: f.id };
  if (f.type === 'extrude') return { kind: 'extrude', cut: f.operation === 'cut', editId: f.id };
  if (f.type === 'revolve') return { kind: 'revolve', cut: f.operation === 'cut', editId: f.id };
  return { kind: 'feature', type: f.type, editId: f.id, ...((f.type === 'sweep' || f.type === 'loft') && f.operation === 'cut' ? { cut: true } : {}) };
}
