/**
 * Document model: a parametric feature history stored as plain JSON.
 * Pure TypeScript, no DOM, so it runs in the UI, a worker, Node tests,
 * the AI bridge, and (later) mobile.
 */
import type { LengthUnit } from './units';
import { type ModelingFeature, type EdgeRef, type PlaneSpec, modelingDependencies } from './featureTypes';
export type * from './featureTypes';

/** A number in document units, or an expression string such as "2*wall" or "0.25 in". */
export type ValueExpr = number | string;

export interface Vec2Expr { x: ValueExpr; y: ValueExpr }

export type SketchEntity =
  | { id: string; kind: 'point'; p: Vec2Expr; construction?: boolean }
  | { id: string; kind: 'line'; p1: Vec2Expr; p2: Vec2Expr; construction?: boolean }
  | { id: string; kind: 'circle'; center: Vec2Expr; radius: ValueExpr; construction?: boolean }
  | { id: string; kind: 'arc'; center: Vec2Expr; radius: ValueExpr; startAngle: ValueExpr; endAngle: ValueExpr; construction?: boolean }
  /**
   * Smooth curve through every point (cubic B-spline, see src/sketch/spline.ts).
   * Closed splines are C2 all the way round and make a profile on their own.
   */
  | { id: string; kind: 'spline'; points: Vec2Expr[]; closed?: boolean; construction?: boolean; /** Equal parameter steps between points (generated sections: all share one knot vector, so lofts through them stay light). Default: chord length. */ uniform?: boolean };

export type BasePlane = 'XY' | 'XZ' | 'YZ';

/**
 * Where a point of a sketch entity is: line 'start'/'end', circle/arc
 * 'center', arc 'start'/'end' (at startAngle/endAngle), sketch point 'point'.
 * The fixed sketch origin is { e: 'origin', p: 'point' }.
 */
export type PointPos = 'start' | 'end' | 'center' | 'point';
export interface PointRef { e: string; p: PointPos }

/** Built-in fixed references every sketch has: its origin and its two axes. */
export const SKETCH_ORIGIN = 'origin';
export const SKETCH_AXIS_H = 'axisH';
export const SKETCH_AXIS_V = 'axisV';

/** Where a dimension's text sits, relative to its natural anchor, in document units. */
export type TextOffset = [number, number];

/**
 * Geometric relations and dimensions in a sketch. The solver (planegcs)
 * moves the entities so that every driving constraint holds. Dimension
 * values are expressions, so they can use parameters ("W/2", "0.25 in").
 * A dimension with driven: true is a reference (measured, not enforced).
 */
export type SketchConstraint =
  | { id: string; type: 'coincident'; a: PointRef; b: PointRef }
  | { id: string; type: 'pointOn'; p: PointRef; on: string }
  | { id: string; type: 'horizontal' | 'vertical'; e: string }
  | { id: string; type: 'horizontalPoints' | 'verticalPoints'; a: PointRef; b: PointRef }
  | { id: string; type: 'parallel' | 'perpendicular' | 'collinear' | 'equal' | 'concentric'; a: string; b: string }
  /** internal: circle/arc tangency with one inside the other. */
  | { id: string; type: 'tangent'; a: string; b: string; internal?: boolean }
  | { id: string; type: 'midpoint'; p: PointRef; line: string }
  | { id: string; type: 'symmetric'; a: PointRef; b: PointRef; line: string }
  | { id: string; type: 'fix'; e: string }
  // ----- dimensions
  /** Point-to-point distance. dir 'h'/'v' measures only along the sketch X/Y axis. */
  | { id: string; type: 'distance'; a: PointRef; b: PointRef; dir?: 'h' | 'v'; value: ValueExpr; driven?: boolean; text?: TextOffset }
  | { id: string; type: 'pointLineDistance'; p: PointRef; line: string; value: ValueExpr; driven?: boolean; text?: TextOffset }
  | { id: string; type: 'radius' | 'diameter'; e: string; value: ValueExpr; driven?: boolean; text?: TextOffset }
  /**
   * Angle between two lines, in degrees. The measured angle is the
   * counter-clockwise angle from line a's direction to line b's direction
   * times `sense`, or 180° minus it when `supplement` is set. These flags
   * record which of the four angles the user picked.
   */
  | { id: string; type: 'angle'; a: string; b: string; value: ValueExpr; sense: 1 | -1; supplement?: boolean; driven?: boolean; text?: TextOffset }
  /**
   * Offset copies: each dst stays parallel (lines) or concentric (arcs/circles)
   * to src at this distance. A pinned end of dst sits square across from the
   * same end of src (open chain ends and smooth joins); other ends are joined
   * to their neighbour by a coincident relation.
   */
  | { id: string; type: 'offset'; pairs: OffsetPair[]; value: ValueExpr; driven?: boolean; text?: TextOffset };

export interface OffsetPair { src: string; dst: string; pin?: ('start' | 'end')[] }

export type SketchConstraintType = SketchConstraint['type'];
export const DIMENSION_TYPES = ['distance', 'pointLineDistance', 'radius', 'diameter', 'angle', 'offset'] as const;
export type SketchDimension = Extract<SketchConstraint, { type: (typeof DIMENSION_TYPES)[number] }>;
export function isDimension(c: SketchConstraint): c is SketchDimension {
  return (DIMENSION_TYPES as readonly string[]).includes(c.type);
}

/** An explicit sketch plane (used for sketches on planar faces). Millimeters, absolute. */
export interface PlaneFrame { origin: [number, number, number]; xDir: [number, number, number]; normal: [number, number, number] }

export interface SketchFeature {
  id: string;
  type: 'sketch';
  name: string;
  /** A base plane, or 'face' for a sketch placed on a planar face (see `frame`). */
  plane: BasePlane | 'face';
  /** Offset of the sketch plane along its normal. */
  offset?: ValueExpr;
  /**
   * For plane 'face': the face's plane at the time the sketch was placed.
   * It does not follow later edits to that face yet (needs topological
   * naming for sketch planes, see docs/TOPOLOGICAL_NAMING.md).
   */
  frame?: PlaneFrame;
  /** Which face it was placed on, for display. */
  faceLabel?: string;
  /**
   * Entity coordinates: numbers are document units. For a sketch with
   * constraints they are the last solved positions and the solver's start
   * point; the constraints and dimensions are what drive the geometry.
   */
  entities: SketchEntity[];
  constraints?: SketchConstraint[];
  suppressed?: boolean;
  /** Sketch on a reference plane feature (overrides `plane`; `offset` still applies). */
  refPlane?: string;
}

export type BooleanOp = 'new' | 'add' | 'cut';

export interface ExtrudeFeature {
  id: string;
  type: 'extrude';
  name: string;
  sketch: string;
  depth: ValueExpr;
  direction: 'normal' | 'reverse' | 'symmetric';
  /** Cut through the whole existing body in the chosen direction (depth ignored). */
  throughAll?: boolean;
  /**
   * Optional Direction 2 (opposite to direction 1). Ignored for 'symmetric'
   * (mid-plane). Like Direction 2 in pro CAD extrudes.
   */
  depth2?: ValueExpr;
  throughAll2?: boolean;
  operation: BooleanOp;
  suppressed?: boolean;
  /**
   * Direction 1 ends at a vertex or a surface instead of a depth (mainstream CAD
   * end conditions Up To Vertex, Up To Surface, Offset From Surface). `depth`
   * and `direction` reverse/normal are then ignored: the extrusion goes toward
   * the target. See ExtrudeUpTo.
   */
  upTo?: ExtrudeUpTo;
  /** From: Offset. The extrusion starts this far from the sketch plane (along the sketch normal; startOffsetReverse flips it). */
  startOffset?: ValueExpr;
  startOffsetReverse?: boolean;
  /**
   * Draft while extruding (Direction 1): side faces taper by this angle
   * (degrees) about the start plane. Inward (the profile gets smaller away
   * from the start) unless draftOutward. Not with Mid Plane.
   */
  draft?: ValueExpr;
  draftOutward?: boolean;
  /** Cut only: remove the material outside the profile instead of inside it (Flip side to cut). */
  flipSide?: boolean;
  /**
   * Thin Feature: extrude a constant-thickness wall made from the sketch
   * curves (open or closed) instead of the closed profile. Same sides as the
   * revolve's thin feature (src/kernel/features/thin.ts).
   */
  thin?: ExtrudeThin;
  /**
   * Direction 2 end condition other than Blind (`depth2`) or Through All
   * (`throughAll2`): Up To Next, Up To Vertex, Up To Surface or Offset From
   * Surface, measured the opposite way to Direction 1 (mainstream CAD offers the
   * Direction 1 list without Mid Plane). `depth2` is then ignored.
   */
  upTo2?: ExtrudeUpTo;
  /** Draft on Direction 2 (its own angle and Draft outward, about the start plane). */
  draft2?: ValueExpr;
  draftOutward2?: boolean;
}

/**
 * Extrude Thin Feature: the revolve's options plus mainstream CAD's Cap ends
 * (closed profiles, bosses: both ends closed with `capThickness` inside the
 * extrude's length, making a hollow part) and Auto-fillet corners (open
 * profiles: line-line corners rounded, `autoFillet` = the inside radius).
 */
export interface ExtrudeThin extends RevolveThin { capEnds?: boolean; capThickness?: ValueExpr; autoFillet?: ValueExpr }

/**
 * A vertex used by Up To Vertex: an end of a model edge (the end nearest
 * `at`, the vertex position when it was picked; the edge itself follows the
 * part by topological naming), or a reference point feature.
 */
export type VertexSpec =
  | { edge: EdgeRef; at: [number, number, number] }
  | { refPoint: string };

export type ExtrudeUpTo =
  /**
   * Up To Next: ends on the nearest face of the part, ahead in the extrude
   * direction (`direction` reverse flips it), that intercepts the entire
   * profile (mainstream CAD "End Condition Extrude").
   */
  | { kind: 'next' }
  /** Up To Vertex: ends on the plane parallel to the start plane through the vertex. */
  | { kind: 'vertex'; vertex: VertexSpec }
  /**
   * Up To Surface (no offset) or Offset From Surface: ends on a plane, a
   * reference plane or a face of the part (Up To Surface also takes curved
   * faces, which must cover the whole profile). The offset moves the end
   * back toward the sketch (reverseOffset: past the surface); it needs a
   * plane or a planar face.
   */
  | { kind: 'surface'; surface: PlaneSpec; offset?: ValueExpr; reverseOffset?: boolean };

export interface RevolveFeature {
  id: string;
  type: 'revolve';
  name: string;
  sketch: string;
  /**
   * Axis in sketch coordinates: a line id from the sketch (usually a
   * centerline; a solid line also works and may be an edge of the profile).
   */
  axisLine: string;
  /** Direction 1 angle (with end 'midPlane': the total angle, split equally both sides of the sketch plane). */
  angle: ValueExpr;
  /** Direction 1 end condition: 'blind' (default) or 'midPlane'. */
  end?: 'blind' | 'midPlane';
  /** Revolve Direction 1 the other way round the axis. */
  reverse?: boolean;
  /** Direction 2 (the other way round the axis from the sketch plane), blind angle. Not used with Mid Plane. Direction 1 + 2 at most 360°. */
  angle2?: ValueExpr;
  /**
   * Thin Feature: the sketch curves (open chain or closed loops) become a wall
   * of constant thickness. oneDirection: `thickness` to one side (`reverse`
   * picks the other side); midPlane: `thickness` split equally; twoDirection:
   * `thickness` on one side and `thickness2` on the other.
   */
  thin?: RevolveThin;
  operation: BooleanOp;
  suppressed?: boolean;
}

export interface RevolveThin { type: 'oneDirection' | 'midPlane' | 'twoDirection'; thickness: ValueExpr; thickness2?: ValueExpr; reverse?: boolean }

export type Feature = SketchFeature | ExtrudeFeature | RevolveFeature | ModelingFeature;

/** Ids of the features `f` is built from (its sketches, seed features, reference geometry). */
export function featureDependencies(f: Feature): string[] {
  if (f.type === 'sketch') return f.refPlane ? [f.refPlane] : [];
  if (f.type === 'extrude') return [f.sketch, ...extrudeTargetDeps(f)];
  if (f.type === 'revolve') return [f.sketch];
  return modelingDependencies(f);
}
export type FeatureType = Feature['type'];

/** Reference features (planes, points) an extrude's end condition uses. */
function extrudeTargetDeps(f: ExtrudeFeature): string[] {
  const deps = (u: ExtrudeUpTo | undefined): string[] => {
    if (!u || u.kind === 'next') return [];
    if (u.kind === 'vertex') return 'refPoint' in u.vertex ? [u.vertex.refPoint] : [];
    return 'refPlane' in u.surface ? [u.surface.refPlane] : [];
  };
  return [...deps(f.upTo), ...deps(f.upTo2)];
}

export interface Parameter { name: string; expr: string }

/** Material for mass properties. Density in g/cm³. */
export interface Material { name: string; density: number }

/**
 * Typical room-temperature densities (g/cm³) from common engineering references
 * (e.g. MatWeb / ASM handbook typical values). Users can enter their own.
 */
export const MATERIALS: Material[] = [
  { name: 'Aluminum 6061-T6', density: 2.70 },
  { name: 'Aluminum 7075-T6', density: 2.81 },
  { name: 'Steel, AISI 1018', density: 7.87 },
  { name: 'Steel, AISI 4140', density: 7.85 },
  { name: 'Stainless Steel 304', density: 8.00 },
  { name: 'Stainless Steel 316', density: 8.00 },
  { name: 'Brass C360', density: 8.50 },
  { name: 'Copper C110', density: 8.89 },
  { name: 'Titanium Ti-6Al-4V', density: 4.43 },
  { name: 'Cast Iron, Gray', density: 7.20 },
  { name: 'ABS', density: 1.04 },
  { name: 'PLA', density: 1.24 },
  { name: 'PETG', density: 1.27 },
  { name: 'Nylon 6/6', density: 1.14 },
  { name: 'Acetal (POM)', density: 1.41 },
  { name: 'Polycarbonate', density: 1.20 },
];

export interface CadDocument {
  format: 'chatcad';
  version: 1;
  name: string;
  units: LengthUnit;
  material?: Material;
  params: Parameter[];
  features: Feature[];
  /** Number of features applied (rollback bar). null = all. */
  rollback: number | null;
}

export function emptyDocument(name = 'Part1', units: LengthUnit = 'in'): CadDocument {
  return { format: 'chatcad', version: 1, name, units, params: [], features: [], rollback: null };
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter++;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${rand}${idCounter.toString(36)}`;
}

/** Convenience: four lines forming a rectangle from corner (x,y) with width w, height h. */
export function rectangleEntities(x: ValueExpr, y: ValueExpr, w: ValueExpr, h: ValueExpr): SketchEntity[] {
  const x2 = `(${x}) + (${w})`;
  const y2 = `(${y}) + (${h})`;
  const P = (a: ValueExpr, b: ValueExpr): Vec2Expr => ({ x: a, y: b });
  return [
    { id: newId('ln'), kind: 'line', p1: P(x, y), p2: P(x2, y) },
    { id: newId('ln'), kind: 'line', p1: P(x2, y), p2: P(x2, y2) },
    { id: newId('ln'), kind: 'line', p1: P(x2, y2), p2: P(x, y2) },
    { id: newId('ln'), kind: 'line', p1: P(x, y2), p2: P(x, y) },
  ];
}

/** Center-point rectangle. */
export function centerRectangleEntities(cx: ValueExpr, cy: ValueExpr, w: ValueExpr, h: ValueExpr): SketchEntity[] {
  return rectangleEntities(`(${cx}) - (${w})/2`, `(${cy}) - (${h})/2`, w, h);
}
