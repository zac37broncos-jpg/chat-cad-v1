/**
 * Drawing document model: sheets, views and annotations, stored as plain
 * JSON. Views reference the part by orientation and parent links only, so
 * every view is recomputed from the exact B-rep whenever the part changes.
 *
 * Coordinates:
 * - paper: millimetres on the sheet, origin at the lower-left corner, y up.
 * - view:  model millimetres projected into the view frame (see views.ts).
 * - model: part millimetres (3D).
 */
import type { V2, V3 } from './geom2d';
import type { ProjectionAngle, StdOrientation } from './views';
import type { DraftStandard, SheetSizeId } from './standards';

export type Ratio = [number, number];

interface ViewBase {
  id: string;
  /** Tree name, e.g. "Drawing View1" (conventional CAD-style default names). */
  name: string;
  /** Paper position (mm) of the model's bounding-box centre (detail views: of the detail centre). */
  position: V2;
  /** Own scale; when absent the view uses its parent's scale, or the sheet scale. */
  scale?: Ratio;
  /** Show hidden lines (ASME "hidden lines visible"). */
  hiddenLines: boolean;
  /** Automatic center marks on holes seen end-on, and centerlines on cylinders seen side-on. */
  centerMarks: boolean;
  centerlines: boolean;
  /** Projected views stay aligned to their parent unless broken. */
  aligned?: boolean;
}

export type DrawingView =
  | (ViewBase & { kind: 'model'; orientation: StdOrientation })
  | (ViewBase & { kind: 'projected'; parent: string; dir: V2 })
  | (ViewBase & { kind: 'auxiliary'; parent: string; dir: V2; letter: string; edge: [V2, V2] })
  /** a, b: cutting line in parent view coordinates; dir: unit paper direction from parent to this view. */
  /** `span`: the cutting line always runs across the whole parent view (horizontal / vertical sections). */
  | (ViewBase & { kind: 'section'; parent: string; letter: string; a: V2; b: V2; dir: V2; span?: boolean })
  /** center/radius in parent view coordinates. */
  | (ViewBase & { kind: 'detail'; parent: string; letter: string; center: V2; radius: number });

export type ViewKind = DrawingView['kind'];

/** Geometry a dimension attaches to, in model coordinates (re-projected every regen). */
export type DimRef =
  | { k: 'pt'; p: V3; vi?: number }
  | { k: 'circle'; c: V3; r: number; n: V3; ei?: number }
  | { k: 'line'; a: V3; b: V3; ei?: number };

export type TolType = 'none' | 'symmetric' | 'bilateral' | 'limit' | 'basic' | 'reference' | 'min' | 'max';
/** Tolerance values in drawing units. */
export interface Tolerance { type: TolType; plus?: number; minus?: number }

/**
 * A model dimension: the value (and editability) comes from the part's
 * feature definitions, so it is driving: editing it changes the part.
 */
export type ModelLink =
  | { kind: 'circle'; sketch: string; entities: string[] }
  | { kind: 'arc'; sketch: string; entity: string }
  | { kind: 'line'; sketch: string; entity: string }
  | { kind: 'depth'; feature: string }
  /** A dimension constraint of a sketch (the sketcher's own driving dimensions). */
  | { kind: 'sketchDim'; sketch: string; constraint: string };

export type Attach = { view: string; p: V3 } | { paper: V2 };

export type GdtSymbol =
  | 'straightness' | 'flatness' | 'circularity' | 'cylindricity'
  | 'profileLine' | 'profileSurface'
  | 'angularity' | 'perpendicularity' | 'parallelism'
  | 'position' | 'concentricity' | 'symmetry'
  | 'circularRunout' | 'totalRunout';
export type MaterialMod = '' | 'M' | 'L';
export type ZoneMod = '' | 'P' | 'F' | 'T' | 'U' | 'ST';
export interface FcfRow { sym: GdtSymbol; dia: boolean; tol: string; mod: MaterialMod; extra?: ZoneMod; datums: { letter: string; mod: MaterialMod }[] }

export type Annotation =
  | { id: string; kind: 'dim'; view: string; dimType: 'linear' | 'diameter' | 'radius' | 'angle'; orient: 'h' | 'v' | 'aligned'; refs: DimRef[];
      /** Text position as an offset from the view's position (paper mm), so it moves with the view. */
      at: V2; tol: Tolerance; decimals?: number; prefix?: string; suffix?: string; count?: number; model?: ModelLink }
  | { id: string; kind: 'note'; text: string; at: V2; leader?: Attach; height?: number }
  | { id: string; kind: 'fcf'; rows: FcfRow[]; at: V2; leader?: Attach }
  | { id: string; kind: 'datum'; letter: string; at: V2; attach: Attach }
  | { id: string; kind: 'centermark'; view: string; c: V3; r: number }
  | { id: string; kind: 'centerline'; view: string; a: V3; b: V3 }
  | { id: string; kind: 'bom'; at: V2 }
  | { id: string; kind: 'balloon'; item: number; at: V2; attach: Attach };

export type AnnotationKind = Annotation['kind'];

export interface RevisionRow { zone: string; rev: string; description: string; date: string; approved: string }

export interface TitleBlock {
  company: string;
  title: string;
  /** Second title line (ISO "supplementary title"). */
  subtitle: string;
  dwgNo: string;
  rev: string;
  drawnBy: string; drawnDate: string;
  checkedBy: string; checkedDate: string;
  engBy: string; engDate: string;
  mfgBy: string; mfgDate: string;
  qaBy: string; qaDate: string;
  cage: string;
  /** Material / finish text; material defaults to the part's material. */
  material: string;
  finish: string;
  /** Tolerance block entries (ASME) or general tolerance (ISO, e.g. "ISO 2768-m"). */
  tol2: string; tol3: string; tolAngle: string; generalTol: string;
  /** ISO 7200 extras. */
  dept: string; techRef: string; docType: string; docStatus: string; lang: string;
}

export interface DrawingSheet {
  id: string;
  name: string;
  size: SheetSizeId;
  scale: Ratio;
  views: DrawingView[];
  annotations: Annotation[];
  revisions: RevisionRow[];
  showRevisionTable: boolean;
}

export interface DrawingDocument {
  format: 'chatcad-drawing';
  version: 1;
  name: string;
  /** Name of the part this drawing documents (informational). */
  partName: string;
  standard: DraftStandard;
  projection: ProjectionAngle;
  units: 'in' | 'mm';
  /** Default decimal places for linear and angular dimensions. */
  decimals: number;
  angleDecimals: number;
  tangentEdges: 'visible' | 'removed';
  titleBlock: TitleBlock;
  sheets: DrawingSheet[];
}

let counter = 0;
export function dwgId(prefix: string): string {
  counter++;
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${counter.toString(36)}`;
}

export function defaultTitleBlock(standard: DraftStandard, partName: string): TitleBlock {
  const today = new Date();
  const asmeDate = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${String(today.getFullYear()).slice(2)}`;
  const isoDate = today.toISOString().slice(0, 10);
  return {
    company: '', title: partName.toUpperCase(), subtitle: '', dwgNo: partName.toUpperCase(), rev: '-',
    drawnBy: '', drawnDate: standard === 'ISO' ? isoDate : asmeDate,
    checkedBy: '', checkedDate: '', engBy: '', engDate: '', mfgBy: '', mfgDate: '', qaBy: '', qaDate: '',
    cage: '', material: '', finish: '',
    tol2: standard === 'ISO' ? '±0.1' : '±.01', tol3: standard === 'ISO' ? '±0.05' : '±.005', tolAngle: '±0.5°', generalTol: 'ISO 2768-m',
    dept: '', techRef: '', docType: 'Detail drawing', docStatus: 'Released', lang: 'en',
  };
}

export function emptyDrawing(partName: string, standard: DraftStandard = 'ASME'): DrawingDocument {
  const iso = standard === 'ISO';
  return {
    format: 'chatcad-drawing', version: 1,
    name: `${partName} drawing`, partName, standard,
    projection: iso ? 'first' : 'third',
    units: iso ? 'mm' : 'in',
    decimals: iso ? 2 : 3, angleDecimals: 1,
    tangentEdges: 'visible',
    titleBlock: defaultTitleBlock(standard, partName),
    sheets: [{ id: dwgId('sheet'), name: 'Sheet1', size: iso ? 'A3' : 'B', scale: [1, 1], views: [], annotations: [], revisions: [], showRevisionTable: true }],
  };
}

/** Find a view and its whole parent chain (parent first). Throws on cycles or missing parents. */
export function viewChain(sheet: DrawingSheet, id: string): DrawingView[] {
  const chain: DrawingView[] = [];
  let cur = sheet.views.find((v) => v.id === id);
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.id)) throw new Error('View parent loop');
    seen.add(cur.id);
    chain.unshift(cur);
    if (cur.kind === 'model') break;
    const pid = cur.parent;
    cur = sheet.views.find((v) => v.id === pid);
    if (!cur) throw new Error(`Parent view ${pid} is missing`);
  }
  return chain;
}

/** Views that depend (directly or indirectly) on `id`. */
export function dependents(sheet: DrawingSheet, id: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    for (const v of sheet.views) if (v.kind !== 'model' && v.parent === pid && !out.includes(v.id)) { out.push(v.id); walk(v.id); }
  };
  walk(id);
  return out;
}

/** Next default view name ("Drawing View7"), unique on the sheet. */
export function nextViewName(doc: DrawingDocument): string {
  let n = 1;
  const names = new Set(doc.sheets.flatMap((s) => s.views.map((v) => v.name)));
  while (names.has(`Drawing View${n}`)) n++;
  return `Drawing View${n}`;
}
