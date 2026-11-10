/**
 * Typed DocumentStore commands for the modelling features. The ribbon /
 * Command panel UI and the AI chat both call these, so a fillet made by
 * hand and one made by Claude are the same feature.
 *
 * Each command validates its inputs (cheap checks here; geometry checks
 * happen at regeneration, where failures show on the feature in the tree)
 * and adds one undoable feature after the rollback bar.
 */
import type { DocumentStore } from './store';
import type { ValueExpr, BooleanOp } from './model';
import type { Vec3Expr,
  FaceRef, EdgeRef, PlaneSpec, AxisSpec, Vec3, FilletFeature, ChamferFeature, HoleFeature, HoleType, HoleStandard, HoleFit,
  LinearPatternFeature, CircularPatternFeature, MirrorFeature, ShellFeature, DraftFeature, RibFeature,
  SweepFeature, LoftFeature, RefPlaneFeature, RefAxisFeature, RefPointFeature, RefPlaneDef, RefAxisDef, RefPointDef,
} from './featureTypes';
import { holeSpec } from './holeTables';

const has = (v: unknown) => v !== undefined && v !== null && v !== '';
function need(v: unknown, what: string) { if (!has(v)) throw new Error(`${what} is required`); }
function needSome<T>(a: T[] | undefined, what: string): T[] { if (!a?.length) throw new Error(`${what}: pick at least one`); return a; }
const named = <T extends object>(o: T, name?: string) => (name ? { ...o, name } : o);

export function addFillet(store: DocumentStore, o: { edges?: EdgeRef[]; faces?: FaceRef[]; radius: ValueExpr; name?: string }): string {
  need(o.radius, 'Radius');
  if (!o.edges?.length && !o.faces?.length) throw new Error('Fillet: pick at least one edge or face');
  return store.addFeature<FilletFeature>(named({ type: 'fillet', kind: 'constant', edges: o.edges ?? [], ...(o.faces?.length ? { faces: o.faces } : {}), radius: o.radius }, o.name));
}

export function addVariableFillet(store: DocumentStore, o: { edges: EdgeRef[]; radius: ValueExpr; radius2: ValueExpr; startAt?: Vec3; name?: string }): string {
  need(o.radius, 'Start radius'); need(o.radius2, 'End radius');
  return store.addFeature<FilletFeature>(named({ type: 'fillet', kind: 'variable', edges: needSome(o.edges, 'Variable fillet edges'), radius: o.radius, radius2: o.radius2, ...(o.startAt ? { startAt: o.startAt } : {}) }, o.name), { defaultName: 'VarFillet' });
}

export function addFaceFillet(store: DocumentStore, o: { faces: FaceRef[]; faces2: FaceRef[]; radius: ValueExpr; name?: string }): string {
  need(o.radius, 'Radius');
  return store.addFeature<FilletFeature>(named({ type: 'fillet', kind: 'face', edges: [], faces: needSome(o.faces, 'Face set 1'), faces2: needSome(o.faces2, 'Face set 2'), radius: o.radius }, o.name), { defaultName: 'FaceFillet' });
}

export function addChamfer(store: DocumentStore, o: {
  edges?: EdgeRef[]; faces?: FaceRef[]; kind?: ChamferFeature['kind']; distance: ValueExpr; distance2?: ValueExpr; angle?: ValueExpr; flip?: boolean; name?: string;
}): string {
  need(o.distance, 'Distance');
  const kind = o.kind ?? (has(o.angle) ? 'angle' : has(o.distance2) ? 'distances' : 'equal');
  if (kind === 'distances') need(o.distance2, 'Distance 2');
  if (kind === 'angle') need(o.angle, 'Angle');
  if (!o.edges?.length && !o.faces?.length) throw new Error('Chamfer: pick at least one edge or face');
  return store.addFeature<ChamferFeature>(named({
    type: 'chamfer', kind, edges: o.edges ?? [], ...(o.faces?.length ? { faces: o.faces } : {}), distance: o.distance,
    ...(kind === 'distances' ? { distance2: o.distance2 } : {}), ...(kind === 'angle' ? { angle: o.angle } : {}), ...(o.flip ? { flip: true } : {}),
  }, o.name));
}

export interface HoleOptions {
  holeType: HoleType; standard: HoleStandard; size: string; fit?: HoleFit;
  end: 'blind' | 'through'; depth?: ValueExpr; threadDepth?: ValueExpr; drillPoint?: ValueExpr;
  diameter?: ValueExpr; cboreDiameter?: ValueExpr; cboreDepth?: ValueExpr; cskDiameter?: ValueExpr; cskAngle?: ValueExpr;
  placement: PlaneSpec; points: { x: ValueExpr; y: ValueExpr }[]; flip?: boolean; name?: string;
}

export function addHole(store: DocumentStore, o: HoleOptions): string {
  const spec = holeSpec(o.standard, o.holeType, o.size, o.fit); // throws for unknown sizes
  if (o.end === 'blind' && o.holeType !== 'tapped') need(o.depth, 'Hole depth (or use end: through)');
  needSome(o.points, 'Hole positions');
  const { name, ...rest } = o;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Omit<HoleOptions, 'name'>;
  return store.addFeature<HoleFeature>(named({ type: 'hole', ...clean }, name), { defaultName: spec.label });
}

export function addLinearPattern(store: DocumentStore, o: {
  features?: string[]; body?: boolean; dir1: AxisSpec; flip1?: boolean; spacing1: ValueExpr; count1: ValueExpr;
  dir2?: AxisSpec; flip2?: boolean; spacing2?: ValueExpr; count2?: ValueExpr; skip?: [number, number][]; name?: string;
}): string {
  if (!o.body) needSome(o.features, 'Features to pattern');
  need(o.count1, 'Direction 1 count'); need(o.spacing1, 'Direction 1 spacing');
  if (o.dir2) { need(o.count2, 'Direction 2 count'); need(o.spacing2, 'Direction 2 spacing'); }
  const { name, ...rest } = o;
  return store.addFeature<LinearPatternFeature>(named({ type: 'linearPattern', ...rest, features: o.body ? [] : o.features! }, name));
}

export function addCircularPattern(store: DocumentStore, o: {
  features?: string[]; body?: boolean; axis: AxisSpec; flip?: boolean; count: ValueExpr; angle?: ValueExpr; equalSpacing?: boolean; skip?: number[]; name?: string;
}): string {
  if (!o.body) needSome(o.features, 'Features to pattern');
  need(o.count, 'Instance count');
  const { name, ...rest } = o;
  return store.addFeature<CircularPatternFeature>(named({ type: 'circularPattern', ...rest, features: o.body ? [] : o.features!, angle: o.angle ?? 360, equalSpacing: o.equalSpacing ?? true }, name));
}

export function addMirror(store: DocumentStore, o: { features?: string[]; body?: boolean; plane: PlaneSpec; name?: string }): string {
  if (!o.body) needSome(o.features, 'Features to mirror');
  const { name, ...rest } = o;
  return store.addFeature<MirrorFeature>(named({ type: 'mirror', ...rest, features: o.body ? [] : o.features! }, name));
}

export function addShell(store: DocumentStore, o: { faces?: FaceRef[]; thickness: ValueExpr; outward?: boolean; name?: string }): string {
  need(o.thickness, 'Thickness');
  return store.addFeature<ShellFeature>(named({ type: 'shell', faces: o.faces ?? [], thickness: o.thickness, ...(o.outward ? { outward: true } : {}) }, o.name));
}

export function addDraft(store: DocumentStore, o: { faces: FaceRef[]; neutral: PlaneSpec; angle: ValueExpr; flip?: boolean; name?: string }): string {
  need(o.angle, 'Draft angle');
  return store.addFeature<DraftFeature>(named({ type: 'draft', faces: needSome(o.faces, 'Faces to draft'), neutral: o.neutral, angle: o.angle, ...(o.flip ? { flip: true } : {}) }, o.name));
}

export function addRib(store: DocumentStore, o: { sketch: string; thickness: ValueExpr; side?: RibFeature['side']; direction?: RibFeature['direction']; flip?: boolean; name?: string }): string {
  need(o.thickness, 'Thickness');
  return store.addFeature<RibFeature>(named({ type: 'rib', sketch: o.sketch, thickness: o.thickness, side: o.side ?? 'both', direction: o.direction ?? 'parallel', ...(o.flip !== undefined ? { flip: o.flip } : {}) }, o.name));
}

const opName = (op: BooleanOp, base: string) => (op === 'cut' ? `Cut-${base}` : `Boss-${base}`);

export function addSweep(store: DocumentStore, o: { profile?: string; path: string; operation?: BooleanOp; name?: string; circular?: { diameter: ValueExpr }; orientation?: SweepFeature['orientation'] }): string {
  if (o.circular) need(o.circular.diameter, 'Circular profile diameter');
  else if (!o.profile) throw new Error('A sweep needs a profile sketch, or a circular profile diameter');
  if (!o.path) throw new Error('A sweep needs a path sketch');
  const operation = o.operation ?? (store.state.features.some((f) => f.type !== 'sketch' && f.type !== 'refPlane' && f.type !== 'refAxis' && f.type !== 'refPoint') ? 'add' : 'new');
  return store.addFeature<SweepFeature>(named({
    type: 'sweep', profile: o.circular ? '' : o.profile!, path: o.path, operation,
    ...(o.circular ? { circular: { diameter: o.circular.diameter } } : {}),
    ...(o.orientation === 'keepNormal' ? { orientation: 'keepNormal' as const } : {}),
  }, o.name), { defaultName: opName(operation, 'Sweep') });
}

export function addLoft(store: DocumentStore, o: { profiles: string[]; ruled?: boolean; operation?: BooleanOp; name?: string; startPoint?: Vec3Expr; endPoint?: Vec3Expr; startTip?: 'round' | 'point'; endTip?: 'round' | 'point' }): string {
  const tips = (o.startPoint ? 1 : 0) + (o.endPoint ? 1 : 0);
  if ((o.profiles?.length ?? 0) < 1 || (o.profiles?.length ?? 0) + tips < 2) throw new Error('A loft needs at least two profile sketches (or one profile plus a start/end point)');
  const operation = o.operation ?? (store.state.features.some((f) => f.type !== 'sketch' && f.type !== 'refPlane' && f.type !== 'refAxis' && f.type !== 'refPoint') ? 'add' : 'new');
  return store.addFeature<LoftFeature>(named({ type: 'loft', profiles: o.profiles, operation, ...(o.ruled ? { ruled: true } : {}), ...(o.startPoint ? { startPoint: o.startPoint } : {}), ...(o.endPoint ? { endPoint: o.endPoint } : {}), ...(o.startPoint && o.startTip === 'round' ? { startTip: 'round' as const } : {}), ...(o.endPoint && o.endTip === 'round' ? { endTip: 'round' as const } : {}) }, o.name), { defaultName: opName(operation, 'Loft') });
}

export function addRefPlane(store: DocumentStore, def: RefPlaneDef, name?: string): string {
  return store.addFeature<RefPlaneFeature>(named({ type: 'refPlane', def }, name));
}
export function addRefAxis(store: DocumentStore, def: RefAxisDef, name?: string): string {
  return store.addFeature<RefAxisFeature>(named({ type: 'refAxis', def }, name));
}
export function addRefPoint(store: DocumentStore, def: RefPointDef, name?: string): string {
  return store.addFeature<RefPointFeature>(named({ type: 'refPoint', def }, name));
}

/**
 * The feature commands for the ribbon (Features tab). The UI owns the
 * Command panel for each; `selects` says what the user picks.
 */
export interface FeatureCommandInfo {
  id: string; label: string; group: 'Features' | 'Reference Geometry'; description: string;
  selects: ('edge' | 'face' | 'plane' | 'axis' | 'feature' | 'sketch')[];
}

export const FEATURE_COMMANDS: FeatureCommandInfo[] = [
  { id: 'fillet', label: 'Fillet', group: 'Features', description: 'Round edges (constant, variable or face fillet)', selects: ['edge', 'face'] },
  { id: 'chamfer', label: 'Chamfer', group: 'Features', description: 'Bevel edges (distance, two distances, distance-angle)', selects: ['edge', 'face'] },
  { id: 'hole', label: 'Hole', group: 'Features', description: 'Standard counterbore, countersink, tapped and clearance holes', selects: ['face', 'plane'] },
  { id: 'linearPattern', label: 'Linear Pattern', group: 'Features', description: 'Copy features along one or two directions', selects: ['feature', 'edge', 'axis'] },
  { id: 'circularPattern', label: 'Circular Pattern', group: 'Features', description: 'Copy features around an axis', selects: ['feature', 'axis', 'face', 'edge'] },
  { id: 'mirror', label: 'Mirror', group: 'Features', description: 'Mirror features or the body about a plane', selects: ['feature', 'plane', 'face'] },
  { id: 'shell', label: 'Shell', group: 'Features', description: 'Hollow the part with a wall thickness, removing selected faces', selects: ['face'] },
  { id: 'draft', label: 'Draft', group: 'Features', description: 'Taper faces from a neutral plane', selects: ['face', 'plane'] },
  { id: 'rib', label: 'Rib', group: 'Features', description: 'Thin wall from a sketch line to the part', selects: ['sketch'] },
  { id: 'sweep', label: 'Sweep', group: 'Features', description: 'Sweep a profile along a path', selects: ['sketch'] },
  { id: 'loft', label: 'Loft', group: 'Features', description: 'Blend between two or more profiles', selects: ['sketch'] },
  { id: 'refPlane', label: 'Plane', group: 'Reference Geometry', description: 'Offset, angled, 3-point or mid plane', selects: ['plane', 'face', 'axis'] },
  { id: 'refAxis', label: 'Axis', group: 'Reference Geometry', description: 'Axis from two points, two planes, a cylinder or an edge', selects: ['plane', 'face', 'edge'] },
  { id: 'refPoint', label: 'Point', group: 'Reference Geometry', description: 'Point from coordinates, an arc center or a face center', selects: ['edge', 'face'] },
];
