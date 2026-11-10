/**
 * View orientation math for orthographic drawings (pure TypeScript).
 *
 * A view frame is a right-handed orthonormal basis: x = paper right, y = paper
 * up, z = toward the viewer. A model point p projects to (p·x, p·y). These are
 * the same axes handed to OpenCascade's HLRAlgo_Projector (gp_Ax2 with
 * N = z and Vx = x), so kernel output and this module agree exactly.
 *
 * Model convention (matches the 3D viewport): Z up, Front view looks along +Y
 * (viewer on -Y), Top view looks down -Z, Right view looks along -X.
 *
 * Projection placement follows ASME Y14.3 / ISO 128-30:
 * - third angle: a view placed on side d of its parent shows the part as seen
 *   from side d (Top above Front, Right to the right of Front).
 * - first angle: a view placed on side d shows the part as seen from the
 *   opposite side (Top below Front, Right to the LEFT of Front).
 */
import type { V2, V3 } from './geom2d';

export interface ViewFrame { x: V3; y: V3; z: V3 }
export type ProjectionAngle = 'third' | 'first';
export type StdOrientation = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'dimetric' | 'trimetric';

export const v3 = {
  add: (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  len: (a: V3) => Math.hypot(a[0], a[1], a[2]),
};

/** Build a frame from a toward-viewer direction and an approximate "up". */
export function frameFromDir(z: V3, upHint: V3): ViewFrame {
  const zn = v3.norm(z);
  let y = v3.sub(upHint, v3.mul(zn, v3.dot(upHint, zn)));
  if (v3.len(y) < 1e-9) y = Math.abs(zn[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  y = v3.norm(v3.sub(y, v3.mul(zn, v3.dot(y, zn))));
  const x = v3.cross(y, zn);
  return { x, y, z: zn };
}

const S3 = 1 / Math.sqrt(3);

/**
 * Standard orientations. Iso views from front-right-top (the usual default).
 * Dimetric / trimetric directions are common textbook choices; they are
 * pictorial views, never dimensioned for true lengths.
 */
export const STD_FRAMES: Record<StdOrientation, ViewFrame> = {
  front: { x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
  back: { x: [-1, 0, 0], y: [0, 0, 1], z: [0, 1, 0] },
  left: { x: [0, -1, 0], y: [0, 0, 1], z: [-1, 0, 0] },
  right: { x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
  top: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
  bottom: { x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
  iso: frameFromDir([S3, -S3, S3], [0, 0, 1]),
  // Dimetric: two axes equally foreshortened (view direction elevation ~20.7°, azimuth 45°).
  dimetric: frameFromDir([Math.SQRT1_2 * Math.cos(0.3614), -Math.SQRT1_2 * Math.cos(0.3614), Math.sin(0.3614)], [0, 0, 1]),
  trimetric: frameFromDir([Math.cos(0.4) * Math.sin(1.0), -Math.cos(0.4) * Math.cos(1.0), Math.sin(0.4)], [0, 0, 1]),
};

export const ORIENTATION_LABEL: Record<StdOrientation, string> = {
  front: 'Front', back: 'Back', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom', iso: 'Isometric', dimetric: 'Dimetric', trimetric: 'Trimetric',
};

export function project(p: V3, f: ViewFrame): V2 { return [v3.dot(p, f.x), v3.dot(p, f.y)]; }

/** 3D direction of a paper-space direction inside a view. */
export function paperDirTo3d(d: V2, f: ViewFrame): V3 { return v3.add(v3.mul(f.x, d[0]), v3.mul(f.y, d[1])); }

/**
 * Frame of a view projected from `parent` and placed on paper direction `d`
 * (unit vector from the parent toward the new view). Used for projected,
 * auxiliary and section views.
 */
export function projectedFrame(parent: ViewFrame, d: V2, angle: ProjectionAngle): ViewFrame {
  const s = angle === 'third' ? 1 : -1;
  const dl = Math.hypot(d[0], d[1]) || 1;
  const dd: V2 = [d[0] / dl, d[1] / dl];
  const f: V2 = [-dd[1], dd[0]];
  const d3 = paperDirTo3d(dd, parent);
  const f3 = paperDirTo3d(f, parent);
  const z = v3.mul(d3, s);
  const along = v3.mul(parent.z, -s); // model direction that appears along paper d in the new view
  const x = v3.norm(v3.add(v3.mul(along, dd[0]), v3.mul(f3, f[0])));
  const y = v3.norm(v3.add(v3.mul(along, dd[1]), v3.mul(f3, f[1])));
  return { x, y, z: v3.norm(z) };
}

/** Snap a paper direction to the nearest of the four orthographic directions. */
export function snapOrtho(d: V2): V2 {
  return Math.abs(d[0]) >= Math.abs(d[1]) ? [Math.sign(d[0]) || 1, 0] : [0, Math.sign(d[1]) || 1];
}

/** Which standard orientation (if any) a frame equals. */
export function matchStd(f: ViewFrame, tol = 1e-9): StdOrientation | null {
  for (const [k, g] of Object.entries(STD_FRAMES) as [StdOrientation, ViewFrame][]) {
    if (v3.dot(f.x, g.x) > 1 - tol && v3.dot(f.y, g.y) > 1 - tol) return k;
  }
  return null;
}

/** Standard view scales (ratio sheet:model). ASME/ISO preferred values. */
export const STD_SCALES: [number, number][] = [
  [20, 1], [10, 1], [5, 1], [4, 1], [2, 1], [1, 1], [1, 2], [1, 4], [1, 5], [1, 8], [1, 10], [1, 16], [1, 20], [1, 50], [1, 100],
];
export const scaleValue = (s: [number, number]) => s[0] / s[1];
export const scaleLabel = (s: [number, number]) => `${s[0]}:${s[1]}`;

/** Largest standard scale ≤ the given ratio. */
export function pickScale(ratio: number): [number, number] {
  for (const s of STD_SCALES) if (scaleValue(s) <= ratio * (1 + 1e-9)) return s;
  return STD_SCALES[STD_SCALES.length - 1];
}
