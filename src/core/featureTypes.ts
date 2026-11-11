/**
 * Modelling features beyond sketch / extrude / revolve: fillet, chamfer,
 * holes, patterns, mirror, shell, draft, rib, sweep, loft and
 * reference geometry (planes, axes, points).
 *
 * Pure data (JSON), no DOM, no kernel. Every value that is a dimension is a
 * ValueExpr, so it can be a number in document units or an expression that
 * uses parameters ("W/2", "0.06 in", "30 deg").
 *
 * Faces and edges of the solid are stored as persistent references (FaceRef /
 * EdgeRef), never as raw indices, so a fillet keeps finding "its" edge after
 * an upstream dimension changes. See docs/TOPOLOGICAL_NAMING.md.
 */
import type { ValueExpr, BasePlane, BooleanOp } from './model';

export type Vec3 = [number, number, number];
export interface Vec3Expr { x: ValueExpr; y: ValueExpr; z: ValueExpr }

/**
 * A persistent face reference. `tags` are the face's names from the history
 * (e.g. "ex_ab12:end" = end cap of that extrude, "ex_ab12:side:ln_7" = the
 * side face swept from sketch line ln_7). `at` is a point (mm) that was on the
 * face when it was picked; it only breaks ties between faces with the same
 * names (e.g. a face that a later cut split in two).
 */
export interface FaceRef { tags: string[]; at?: Vec3 }

/**
 * A persistent edge reference: the edge where a face named `a` meets a face
 * named `b` (order does not matter). `at` breaks ties like for faces.
 */
export interface EdgeRef { a: string[]; b: string[]; at?: Vec3 }

export type WorldAxis = 'X' | 'Y' | 'Z';

/** A plane used to place holes and sketches, to mirror, or as a draft neutral plane. */
export type PlaneSpec =
  | { base: BasePlane; offset?: ValueExpr }
  | { refPlane: string }
  | { face: FaceRef };

/** An axis (for circular patterns, angled planes) or a direction (linear patterns). */
export type AxisSpec =
  | { axis: WorldAxis }
  | { refAxis: string }
  /** A straight edge (its line) or a circular edge (its center axis). */
  | { edge: EdgeRef }
  /** A cylindrical or conical face: its axis. */
  | { face: FaceRef };

// ----------------------------------------------------------------- fillet

export interface FilletFeature {
  id: string;
  type: 'fillet';
  name: string;
  /**
   * constant: one radius on every edge (and on every edge of `faces`).
   * variable: radius changes linearly from `radius` at each edge's start to
   *   `radius2` at its end; the start is the end nearest `startAt`.
   * face: blends between face set A (`faces`) and face set B (`faces2`)
   *   along every edge where they meet.
   * fullRound: replaces the center face (`faces3`) by a round tangent to it
   *   and to the two side faces (`faces`, `faces2`), like a pro CAD full
   *   round fillet. The side faces must be flat and parallel and the center
   *   face flat; the radius is half the distance between the sides (`radius`
   *   is not used).
   */
  kind: 'constant' | 'variable' | 'face' | 'fullRound';
  edges: EdgeRef[];
  faces?: FaceRef[];
  faces2?: FaceRef[];
  /** Full round: the center face set (one face). */
  faces3?: FaceRef[];
  radius: ValueExpr;
  radius2?: ValueExpr;
  startAt?: Vec3;
  suppressed?: boolean;
}

// ----------------------------------------------------------------- chamfer

export interface ChamferFeature {
  id: string;
  type: 'chamfer';
  name: string;
  /**
   * equal: `distance` on both faces. distances: `distance` on the first face
   * of each edge reference (face `a`), `distance2` on the other.
   * angle: `distance` on face `a`, at `angle` from it. `flip` swaps faces.
   */
  kind: 'equal' | 'distances' | 'angle';
  edges: EdgeRef[];
  faces?: FaceRef[];
  distance: ValueExpr;
  distance2?: ValueExpr;
  angle?: ValueExpr;
  flip?: boolean;
  suppressed?: boolean;
}

// ----------------------------------------------------------------- hole

export type HoleType = 'simple' | 'counterbore' | 'countersink' | 'tapped';
export type HoleStandard = 'ansi-inch' | 'iso-metric';
export type HoleFit = 'close' | 'normal' | 'loose';

export interface HoleFeature {
  id: string;
  type: 'hole';
  name: string;
  holeType: HoleType;
  standard: HoleStandard;
  /** Fastener or thread size from the standard tables, e.g. "1/4", "#10", "1/4-20", "M6", "M6x1". */
  size: string;
  fit?: HoleFit;
  /** blind: to `depth`; through: through the whole part. */
  end: 'blind' | 'through';
  /** Blind: drill depth (to the shoulder, not the drill point tip). */
  depth?: ValueExpr;
  /** Tapped blind holes: full-thread depth. Default 2 x nominal diameter. */
  threadDepth?: ValueExpr;
  /** Included drill point angle for blind holes (default 118 deg); 0 = flat bottom. */
  drillPoint?: ValueExpr;
  /** Overrides for the table values. */
  diameter?: ValueExpr;
  cboreDiameter?: ValueExpr;
  cboreDepth?: ValueExpr;
  cskDiameter?: ValueExpr;
  cskAngle?: ValueExpr;
  /** Where the hole starts. The hole goes against the plane's normal (into the material) unless `flip`. */
  placement: PlaneSpec;
  /** Hole centers in the placement plane's 2D coordinates. */
  points: { x: ValueExpr; y: ValueExpr }[];
  flip?: boolean;
  suppressed?: boolean;
}

// ----------------------------------------------------------------- patterns

export interface LinearPatternFeature {
  id: string;
  type: 'linearPattern';
  name: string;
  /** Seed features (extrude, revolve, hole, sweep, loft, rib). Empty with body: true = pattern the whole body. */
  features: string[];
  body?: boolean;
  dir1: AxisSpec;
  flip1?: boolean;
  spacing1: ValueExpr;
  /** Total instances in direction 1, including the seed. */
  count1: ValueExpr;
  dir2?: AxisSpec;
  flip2?: boolean;
  spacing2?: ValueExpr;
  count2?: ValueExpr;
  /** Instances to skip, as [i, j] (0-based; [0,0] is the seed and cannot be skipped). */
  skip?: [number, number][];
  suppressed?: boolean;
}

export interface CircularPatternFeature {
  id: string;
  type: 'circularPattern';
  name: string;
  features: string[];
  body?: boolean;
  axis: AxisSpec;
  flip?: boolean;
  /** Total instances, including the seed. */
  count: ValueExpr;
  /** With equalSpacing (default): total angle (360 = full circle). Without: angle between instances. */
  angle: ValueExpr;
  equalSpacing?: boolean;
  skip?: number[];
  suppressed?: boolean;
}

export interface MirrorFeature {
  id: string;
  type: 'mirror';
  name: string;
  features: string[];
  /** Mirror the whole body (joined to the original). */
  body?: boolean;
  plane: PlaneSpec;
  suppressed?: boolean;
}

// ----------------------------------------------------------------- shell / draft / rib

export interface ShellFeature {
  id: string;
  type: 'shell';
  name: string;
  /** Faces to remove (open faces). Empty = hollow closed shell. */
  faces: FaceRef[];
  thickness: ValueExpr;
  /** Default inward (keeps outside dimensions), like pro CAD. */
  outward?: boolean;
  suppressed?: boolean;
}

export interface DraftFeature {
  id: string;
  type: 'draft';
  name: string;
  faces: FaceRef[];
  /** Neutral plane: drafted faces keep their size where they cross it. Its normal is the pull direction. */
  neutral: PlaneSpec;
  angle: ValueExpr;
  flip?: boolean;
  suppressed?: boolean;
}

export interface RibFeature {
  id: string;
  type: 'rib';
  name: string;
  /** Sketch with an open (or closed) chain of lines/arcs describing the rib's edge. */
  sketch: string;
  thickness: ValueExpr;
  /** Which side of the sketch line gets the thickness. */
  side?: 'both' | 'left' | 'right';
  /**
   * parallel: the rib grows in the sketch plane, away from the line, until it meets the part
   * (the usual case: sketch on a mid plane). normal: it grows along the sketch normal.
   */
  direction: 'parallel' | 'normal';
  flip?: boolean;
  suppressed?: boolean;
}

// ----------------------------------------------------------------- sweep / loft

export interface SweepFeature {
  id: string;
  type: 'sweep';
  name: string;
  /** Sketch with the closed profile. Empty ('') when `circular` is used. */
  profile: string;
  /** Sketch with the path: an open or closed chain of lines/arcs that starts at the profile plane. */
  path: string;
  /**
   * Mainstream CAD "Circular Profile": no profile sketch; a circle of this
   * diameter centred on the start of the path, square to it (wires, tubes,
   * handles, springs).
   */
  circular?: { diameter: ValueExpr };
  /**
   * Profile orientation. followPath (default): the profile stays square to
   * the path as it turns. keepNormal ("Keep Normal Constant"): the profile
   * keeps its starting orientation (it is translated along the path).
   */
  orientation?: 'followPath' | 'keepNormal';
  operation: BooleanOp;
  suppressed?: boolean;
}

export interface LoftFeature {
  id: string;
  type: 'loft';
  name: string;
  /** Two or more sketches, each with one closed profile, in order. */
  profiles: string[];
  /** Ruled: straight lines between sections; otherwise smooth. */
  ruled?: boolean;
  /** Optional points the loft closes to before the first / after the last profile (rounded tips, domes, noses). */
  startPoint?: Vec3Expr;
  endPoint?: Vec3Expr;
  /** How the loft meets a start/end point: 'point' (a cone-like tip, default) or 'round' (a dome, smooth through the tip). */
  startTip?: 'round' | 'point';
  endTip?: 'round' | 'point';
  operation: BooleanOp;
  /**
   * Smooth lofts: where the closed surface's seam starts, as a fraction of a turn from each
   * section's first point (the shape is the same wherever it is). Set when the loft is created
   * (src/core/loftSeam.ts), so the same steps always build the same faces; missing in documents
   * saved before 2026-11-06, which keep their old id-based seam. Not used by ruled lofts.
   */
  seam?: number;
  suppressed?: boolean;
}

// ----------------------------------------------------------------- reference geometry

export type RefPlaneDef =
  | { kind: 'offset'; from: PlaneSpec; distance: ValueExpr; flip?: boolean }
  /** Rotated from a plane about an axis lying in it. */
  | { kind: 'angle'; from: PlaneSpec; axis: AxisSpec; angle: ValueExpr }
  | { kind: 'threePoints'; points: [Vec3Expr, Vec3Expr, Vec3Expr] }
  /** Halfway between two parallel planes/planar faces. */
  | { kind: 'midplane'; a: PlaneSpec; b: PlaneSpec }
  /**
   * Mainstream CAD "Normal to curve": through the start or end point of a
   * sketch's curve chain (a sweep path), square to the curve there. The
   * normal points along the chain's direction.
   */
  | { kind: 'normalToCurve'; sketch: string; at: 'start' | 'end' }
  /** Mainstream CAD "Parallel plane at point": parallel to a plane or flat face, through a point (coordinates or a reference point). */
  | { kind: 'parallelAtPoint'; from: PlaneSpec; point: Vec3Expr | { refPoint: string } };

export interface RefPlaneFeature { id: string; type: 'refPlane'; name: string; def: RefPlaneDef; suppressed?: boolean }

export type RefAxisDef =
  | { kind: 'twoPoints'; p1: Vec3Expr; p2: Vec3Expr }
  | { kind: 'twoPlanes'; a: PlaneSpec; b: PlaneSpec }
  /** Axis of a cylindrical/conical face, line of a straight edge, or axis of a circular edge. */
  | { kind: 'entity'; of: AxisSpec };

export interface RefAxisFeature { id: string; type: 'refAxis'; name: string; def: RefAxisDef; suppressed?: boolean }

export type RefPointDef =
  | { kind: 'coords'; p: Vec3Expr }
  | { kind: 'arcCenter'; edge: EdgeRef }
  | { kind: 'faceCenter'; face: FaceRef };

export interface RefPointFeature { id: string; type: 'refPoint'; name: string; def: RefPointDef; suppressed?: boolean }

export type ModelingFeature =
  | FilletFeature | ChamferFeature | HoleFeature
  | LinearPatternFeature | CircularPatternFeature | MirrorFeature
  | ShellFeature | DraftFeature | RibFeature | SweepFeature | LoftFeature
  | RefPlaneFeature | RefAxisFeature | RefPointFeature;

export type ModelingFeatureType = ModelingFeature['type'];

/** Reference geometry features make no solid; they are used by other features. */
export const REFERENCE_TYPES = ['refPlane', 'refAxis', 'refPoint'] as const;

/** Conventional CAD-style default names (the base; a number is appended: Fillet1, LPattern2...). */
export const DEFAULT_NAMES: Record<ModelingFeatureType, string> = {
  fillet: 'Fillet', chamfer: 'Chamfer', hole: 'Hole',
  linearPattern: 'LPattern', circularPattern: 'CirPattern', mirror: 'Mirror',
  shell: 'Shell', draft: 'Draft', rib: 'Rib', sweep: 'Sweep', loft: 'Loft',
  refPlane: 'Plane', refAxis: 'Axis', refPoint: 'Point',
};

/** Ids of the features this feature needs (sketches, seeds, reference geometry). */
export function modelingDependencies(f: ModelingFeature): string[] {
  const out: string[] = [];
  const plane = (p?: PlaneSpec) => { if (p && 'refPlane' in p) out.push(p.refPlane); };
  const axis = (a?: AxisSpec) => { if (a && 'refAxis' in a) out.push(a.refAxis); };
  switch (f.type) {
    case 'hole': plane(f.placement); break;
    case 'linearPattern': out.push(...f.features); axis(f.dir1); axis(f.dir2); break;
    case 'circularPattern': out.push(...f.features); axis(f.axis); break;
    case 'mirror': out.push(...f.features); plane(f.plane); break;
    case 'draft': plane(f.neutral); break;
    case 'rib': out.push(f.sketch); break;
    case 'sweep': if (f.profile) out.push(f.profile); out.push(f.path); break;
    case 'loft': out.push(...f.profiles); break;
    case 'refPlane': {
      const d = f.def;
      if (d.kind === 'offset') plane(d.from);
      if (d.kind === 'angle') { plane(d.from); axis(d.axis); }
      if (d.kind === 'midplane') { plane(d.a); plane(d.b); }
      if (d.kind === 'normalToCurve') out.push(d.sketch);
      if (d.kind === 'parallelAtPoint') { plane(d.from); if ('refPoint' in d.point) out.push(d.point.refPoint); }
      break;
    }
    case 'refAxis': {
      const d = f.def;
      if (d.kind === 'twoPlanes') { plane(d.a); plane(d.b); }
      if (d.kind === 'entity') axis(d.of);
      break;
    }
    default: break;
  }
  return out;
}
