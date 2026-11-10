/**
 * File export for manufacturing: STEP (exact solid, for other CAD and CAM)
 * and STL (triangle mesh, for 3D printing).
 *
 * The model is always stored in millimeters. Both writers convert to the unit
 * the user picked and then CHECK what they wrote, so the app can say plainly
 * whether the file is good:
 *  - STL: the exact triangles in the file (after rounding to the 32-bit
 *    floats STL stores) are welded and checked: every edge shared by exactly
 *    two triangles running opposite ways (watertight, consistently oriented),
 *    no zero-area triangles, normals pointing out (positive volume), and the
 *    bounding box within the chord tolerance of the exact solid.
 *  - STEP: the text is read back by a fresh STEP reader and compared with the
 *    solid it came from: same number of solids, faces, edges and vertices,
 *    valid and closed, and the same bounding box.
 *
 * Sources (public specifications, no code copied):
 *  - STL: 3D Systems "StereoLithography Interface Specification" (1989/1988),
 *    binary layout: 80-byte header, uint32 count, per facet 12 float32 + uint16.
 *  - STEP: ISO 10303-21 (file structure, string encoding), ISO 10303-214 /
 *    -242 schemas as written by OpenCascade 8.0's STEP translator (DE STEP
 *    user guide: write.step.schema, write.step.unit, xstep.cascade.unit).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { OC } from './regen';
import { countSolids, isValid, freeEdgeCount, shapeDistance } from './regen';
import { selfIntersections } from './meshIntersect';
import { listSubShapes } from './query';
import { free, freeAll, takeXyz } from './mem';
import { safeFileBase } from './exportDefaults';

export { safeFileBase };
import { exactBox } from './bbox';
import { APP_NAME } from '../brand';

export type ExportUnit = 'mm' | 'in';
const MM_PER: Record<ExportUnit, number> = { mm: 1, in: 25.4 };
export const UNIT_NAME: Record<ExportUnit, string> = { mm: 'millimeters', in: 'inches' };

/** Exact bounding box (from the B-rep, not from triangles), in mm: see ./bbox.ts. */
export { exactBox };
type Box = ReturnType<typeof exactBox>;
const boxDiff = (a: Box, b: Box) => Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(a.min[k] - b.min[k]), Math.abs(a.max[k] - b.max[k])]));

// ====================================================================== STL

export interface StlOptions {
  /** Max chord deviation between the triangles and the true surface, mm. */
  linearDeflection: number;
  /** Max angle between neighbouring triangles' edges along a curve, radians. */
  angularDeflection: number;
  /** Unit of the numbers in the file. STL itself has no units; slicers assume mm. */
  unit: ExportUnit;
  format: 'binary' | 'ascii';
  /** Part name (header / solid name). */
  name: string;
}

export interface StlReport {
  format: 'binary' | 'ascii';
  unit: ExportUnit;
  bytes: number;
  triangles: number;
  vertices: number;
  /** Separate closed pieces in the mesh (1 for a normal part). */
  pieces: number;
  /** Through holes (genus) from Euler's formula, when the mesh is closed. */
  throughHoles: number | null;
  /** Triangle edges used by only one triangle (holes in the skin). */
  openEdges: number;
  /** Triangle edges shared by more than two triangles. */
  nonManifoldEdges: number;
  /** Edges whose two triangles run the same way (a flipped triangle). */
  flippedEdges: number;
  /** Triangles of zero area that are still in the file (slicers call them degenerate). */
  zeroAreaTriangles: number;
  /** Triangles that collapsed to a line or point (at poles) and were left out. */
  droppedTriangles: number;
  /** Faces the mesher could not triangulate (each would be a hole). */
  unmeshedFaces: number;
  /** Mesh volume in mm^3 (positive = normals point out). */
  volume: number;
  /** Mesh bounding box (what the slicer will show), mm. */
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  /** Flat sliver triangles the mesher made, fixed by flipping them into their neighbour. */
  sliversFixed: number;
  /** The chord tolerance asked for (mm), and the largest sag measured on the file's triangles (mm). */
  linearDeflection: number;
  measuredDeviation: number;
  angularDeflection: number;
  /** Whole-part meshing passes (more than 1 when a face border sagged too much, or triangles crossed, and the part was meshed finer). */
  meshPasses: number;
  /** Triangles that pass through other triangles (self-intersections) in the file. */
  crossingTriangles: number;
  /**
   * How far mesh corners on the model's own edges lie from their faces (measured to the nearest surface
   * point, at most the edge's tolerance, mm). Nonzero where an edge's 3D curve leaves its faces, as at
   * the joints of joined organic bodies; the file follows the edge there. That is the model's accuracy,
   * which no finer mesh can improve, and it is not counted in measuredDeviation. (The edge's tolerance
   * itself can be larger: it also covers the mismatch between the edge's curve on the face and its 3D
   * curve.)
   */
  jointTolerance: number;
  /** Plain-language remarks that are not problems (for example the joint tolerance). */
  notes: string[];
  /** All checks passed: closed, manifold, consistently oriented, outward, no degenerate triangles. */
  watertight: boolean;
  problems: string[];
}

/**
 * OpenCascade's mesher treats its chord tolerance as a target, not a hard
 * limit: measured against the exact surface it kept to it on planes,
 * cylinders and tori, but a few triangles on free-form (B-spline) faces sagged
 * up to 2.5x the target (0.025 mm at 0.0075 mm on the test figurine), and
 * asking it for a finer mesh is erratic there. So every export measures the
 * sag of every triangle on a curved face (at 12 points of a degree-4 lattice,
 * and the largest gap from those with an error estimate, see LATTICE) and splits the
 * triangles that sag too much itself, with new corners placed exactly on the
 * surface, until none does. The tolerance used is the setting less what writing
 * the file can move a point (float32 rounding, welding); the report adds the
 * movement measured. Edges of the face are never split
 * (the neighbouring face shares their points), so the mesh stays watertight.
 * The tolerance shown to the user is then what the file holds.
 */
const REFINE_ROUNDS = 8;
/** Finer whole-part meshes tried when triangles cross each other, and how much finer each one is. */
const CROSSING_RETRIES = 2;
const CROSSING_FINER = 0.7;
/** The project's accuracy promise, 0.005 in, in mm. */
const PROMISE_MM = 0.005 * 25.4;
/** Whole-part meshing passes at most (a pass after the first happens only when a border line sagged too much). */
const MESH_PASSES = 4;

/**
 * Largest gap of a quadratic between a flat triangle and the surface, from the gaps at its three side
 * midpoints. On a surface that is locally quadratic, the gap is zero at the corners and
 * e = a01 l0 l1 + a12 l1 l2 + a20 l2 l0 (barycentric l), with a = 4 x the signed gap at that side's
 * midpoint. Its largest size is at a side's midpoint or at the one point inside where it is flat: for an
 * equilateral triangle on a sphere, the center, 4/3 of the midpoint gap. The signs matter: where the
 * surface curves both ways (a saddle) the gaps partly cancel inside. When a sign is not known (0), all
 * gaps count as one sign, which is an upper bound for any signs. Used by triangleGapMax as the
 * low-order half of its error estimate.
 */
export function quadraticMax(e01: number, e12: number, e20: number, s01 = 0, s12 = 0, s20 = 0): number {
  let best = Math.max(e01, e12, e20);
  const known = s01 !== 0 && s12 !== 0 && s20 !== 0;
  const a = 4 * e01 * (known ? s01 : 1), b = 4 * e12 * (known ? s12 : 1), c = 4 * e20 * (known ? s20 : 1);
  // A = [[0, a, c], [a, 0, b], [c, b, 0]]; the flat point is A^-1 (1, 1, 1), scaled onto the triangle.
  const det = 2 * a * b * c;
  if (!(Math.abs(det) > 1e-300)) return best;
  const x0 = (-b * b + a * b + b * c) / det, x1 = (c * b - c * c + a * c) / det, x2 = (a * b + a * c - a * a) / det;
  const sum = x0 + x1 + x2;
  if (!(Math.abs(sum) > 0)) return best;
  const l0 = x0 / sum, l1 = x1 / sum, l2 = x2 / sum;
  if (l0 > 0 && l1 > 0 && l2 > 0) best = Math.max(best, Math.abs(a * l0 * l1 + b * l1 * l2 + c * l2 * l0));
  return best;
}

/*
 * Where the gap is measured on each triangle: the degree-4 lattice (barycentric (i, j, k) / 4) without
 * its corners, where the gap is zero. In this order: the points at 1/4, 1/2 and 3/4 of side v0-v1
 * (from v0), of side v1-v2 (from v1) and of side v2-v0 (from v2), then the three inside.
 *
 * Why not just the side midpoints and a quadratic: on organic faces the curvature changes along a
 * triangle (a B-spline's knot lines are only C1 or C2), and the gap along a side can be lopsided. The
 * verification found a 2 mm triangle on the Easter Island head whose side gap peaked at 3/8 of the side,
 * 0.0546 mm, where the midpoint said 0.0489 and the quadratic said at most 0.049 (Draft, 0.05 mm).
 * The degree-4 polynomial through these 12 gaps follows such a profile, and the difference between it
 * and the quadratic from the midpoints alone is added as an error estimate (the same idea as a
 * Gauss-Kronrod pair: two orders, and their disagreement bounds what the lower one misses). Where the
 * surface really is quadratic the two agree and nothing is added.
 */
const LATTICE: ReadonlyArray<readonly [number, number, number]> = [
  [3, 1, 0], [2, 2, 0], [1, 3, 0], [0, 3, 1], [0, 2, 2], [0, 1, 3], [1, 0, 3], [2, 0, 2], [3, 0, 1], [2, 1, 1], [1, 2, 1], [1, 1, 2],
];
/** Lagrange basis of the degree-4 lattice node (i, j, k) at barycentric (l0, l1, l2). */
function lattice4(i: number, j: number, k: number, l0: number, l1: number, l2: number): number {
  const f = (n: number, x: number) => { let p = 1; for (let a = 0; a < n; a++) p *= (4 * x - a) / (a + 1); return p; };
  return f(i, l0) * f(j, l1) * f(k, l2);
}
/** The polynomials are searched for their largest size on a finer lattice (it contains the 12 points). */
const GAP_GRID = 16;
const TRI_W: Float64Array[] = [], TRI_Q: Float64Array[] = [];
for (let i = 0; i <= GAP_GRID; i++) {
  for (let j = 0; i + j <= GAP_GRID; j++) {
    const l0 = i / GAP_GRID, l1 = j / GAP_GRID, l2 = 1 - l0 - l1;
    TRI_W.push(Float64Array.from(LATTICE, ([a, b, c]) => lattice4(a, b, c, l0, l1, l2)));
    TRI_Q.push(Float64Array.of(4 * l0 * l1, 4 * l1 * l2, 4 * l2 * l0));
  }
}
const SIDE_GRID = 32;
const SIDE_W: Float64Array[] = [], SIDE_Q: number[] = [];
for (let n = 0; n <= SIDE_GRID; n++) {
  const t = n / SIDE_GRID;
  const basis = (m: number) => { let p = 1; for (let q = 0; q <= 4; q++) if (q !== m) p *= (4 * t - q) / (m - q); return p; };
  SIDE_W.push(Float64Array.of(basis(1), basis(2), basis(3)));
  SIDE_Q.push(4 * t * (1 - t));
}

/**
 * Largest gap along one side of a triangle from the gaps at 1/4, 1/2 and 3/4 of it (zero at the ends):
 * the larger of the quartic through them and the midpoint gap, plus how far the quartic is from the
 * parabola through the midpoint alone (the error estimate described above LATTICE).
 */
export function sideGapMax(g1: number, g2: number, g3: number): number {
  let p4 = 0, diff = 0;
  for (let n = 0; n <= SIDE_GRID; n++) {
    const w = SIDE_W[n];
    const v = w[0] * g1 + w[1] * g2 + w[2] * g3;
    p4 = Math.max(p4, Math.abs(v));
    diff = Math.max(diff, Math.abs(v - SIDE_Q[n] * g2));
  }
  return Math.max(p4, Math.abs(g2)) + diff;
}

/**
 * Largest gap over a triangle from its 12 lattice gaps (order of LATTICE; signed when `signed`, else
 * sizes): the larger of the degree-4 polynomial's largest size and the quadratic's (quadraticMax),
 * plus the largest difference between the two (the error estimate described above LATTICE).
 */
export function triangleGapMax(g: ArrayLike<number>, signed: boolean): number {
  const v = Float64Array.from(g, (x) => (signed ? x : Math.abs(x)));
  const e01 = v[1], e12 = v[4], e20 = v[7];
  const sg = (x: number) => (signed ? Math.sign(x) || 1 : 0);
  const q = quadraticMax(Math.abs(e01), Math.abs(e12), Math.abs(e20), sg(e01), sg(e12), sg(e20));
  let p4 = 0, diff = 0;
  for (let n = 0; n < TRI_W.length; n++) {
    const w = TRI_W[n], Q = TRI_Q[n];
    let s = 0;
    for (let m = 0; m < 12; m++) s += w[m] * v[m];
    p4 = Math.max(p4, Math.abs(s));
    diff = Math.max(diff, Math.abs(s - (Q[0] * e01 + Q[1] * e12 + Q[2] * e20)));
  }
  return Math.max(p4, q) + diff;
}

/*
 * The same two estimates for gap VECTORS (from the flat point to the nearest point of the curve or
 * surface, x y z). Used where the side of the surface is not known, above all on a face's border
 * links, which are measured against their edge's 3D curve: a distance to a curve has no sign, and
 * where the curve wiggles across its chord the sizes alone have a kink at zero that no polynomial
 * follows (found on the Easter Island head: sizes 0.0035, 0.0009, 0.0045 mm read as 0.0101). The
 * vector passes smoothly through zero. The largest size is searched on the finer lattice, which can
 * miss at most (spacing^2 / 8) x the second derivative: for these low-degree polynomials under 1/1000
 * of the size along a side (32 steps) and 1/250 over a triangle (16 steps), covered by GRID_MARGIN.
 */
const SIDE_GRID_MARGIN = 1 + 1 / 512, TRI_GRID_MARGIN = 1 + 1 / 128;
const norm3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

/** sideGapMax for gap vectors at 1/4, 1/2, 3/4 of a side (r: 9 numbers, x y z of each). */
export function sideGapMaxVec(r: ArrayLike<number>): number {
  let p4 = 0, diff = 0;
  for (let n = 0; n <= SIDE_GRID; n++) {
    const w = SIDE_W[n], q = SIDE_Q[n];
    const x = w[0] * r[0] + w[1] * r[3] + w[2] * r[6], y = w[0] * r[1] + w[1] * r[4] + w[2] * r[7], z = w[0] * r[2] + w[1] * r[5] + w[2] * r[8];
    p4 = Math.max(p4, norm3(x, y, z));
    diff = Math.max(diff, norm3(x - q * r[3], y - q * r[4], z - q * r[5]));
  }
  return (Math.max(p4, norm3(r[3], r[4], r[5])) + diff) * SIDE_GRID_MARGIN;
}

/** triangleGapMax for gap vectors at the 12 lattice points (r: 36 numbers, x y z of each, order of LATTICE). */
export function triangleGapMaxVec(r: ArrayLike<number>): number {
  let p4 = 0, diff = 0;
  for (let n = 0; n < TRI_W.length; n++) {
    const w = TRI_W[n], Q = TRI_Q[n];
    let x = 0, y = 0, z = 0;
    for (let m = 0; m < 12; m++) { x += w[m] * r[3 * m]; y += w[m] * r[3 * m + 1]; z += w[m] * r[3 * m + 2]; }
    // The quadratic from the side midpoints (lattice points 1, 4 and 7).
    const qx = Q[0] * r[3] + Q[1] * r[12] + Q[2] * r[21], qy = Q[0] * r[4] + Q[1] * r[13] + Q[2] * r[22], qz = Q[0] * r[5] + Q[1] * r[14] + Q[2] * r[23];
    p4 = Math.max(p4, norm3(x, y, z));
    diff = Math.max(diff, norm3(x - qx, y - qy, z - qz));
  }
  return (p4 + diff) * TRI_GRID_MARGIN;
}

/**
 * Refine one face's triangles (local node indices, as the mesher stored
 * them) until the largest gap estimated over each triangle and along each
 * inner link (from 12 lattice points, see LATTICE) is within `lin`. New nodes are appended to `pos` (global, mm) and `uv`.
 * Returns the largest deviation left inside the face (sag, or a corner off
 * the surface), and the sag of its boundary links (which are not split here).
 */
/**
 * What the face's border (B-rep edge) nodes know: the tolerance of the edge each node lies on (0 for
 * inner nodes), and for each border link the edge's 3D curve and the curve parameters at its ends.
 */
interface FaceBorder {
  nodeTol: Float64Array;
  links: Map<number, BorderLink>;
}
/** One number for the link between face nodes a and b (either order); faces have far fewer than 2^26 nodes. */
const LINK_KEY = 2 ** 26;
const linkKeyOf = (a: number, b: number) => (a < b ? a * LINK_KEY + b : b * LINK_KEY + a);
/** A border link's B-rep edge: its 3D curve, and the curve parameters at node `n0` (t0) and at the other end (t1). */
interface BorderLink { curve: any; t0: number; t1: number; n0: number }

function refineFace(oc: OC, face: any, pos: number[], base: number, uv: number[], tris: number[], lin: number, border: FaceBorder | null): [number, number, number] {
  const ad = new oc.BRepAdaptor_Surface(face, true);
  const objs: { delete(): void }[] = [];
  try {
    const nNodes = uv.length / 2;
    const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter(), v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
    const at = (u: number, v: number) => takeXyz(ad.Value(u, v));
    const S = new oc.gp_Pnt(0, 0, 0), Du = new oc.gp_Vec(0, 0, 0), Dv = new oc.gp_Vec(0, 0, 0);
    objs.push(S, Du, Dv);
    const clampU = (u: number) => Math.min(u1, Math.max(u0, u)), clampV = (v: number) => Math.min(v1, Math.max(v0, v));
    // Corners at a pole (a cone's apex, the tip of a loft or dome): there one parameter does not move
    // the point (its derivative is zero), so its value at that corner says nothing, and halfway in
    // parameters between the pole and another corner can land on the far side of the surface. The
    // triangles made there then fold through their neighbours (found on a tapped hole's drill point
    // and on loft tips, 2026-11-06). At a pole, use the other corner's value of that parameter.
    const flat = new Uint8Array(nNodes); // bit 1: u does not move the point here, bit 2: v does not (filled below)
    const flatOf = (i: number) => (i < nNodes ? flat[i] : 0);
    /**
     * Parameters at barycentric weights `ws` of the corners `ids` (halfway along a link: [0.5, 0.5]),
     * ignoring a parameter that a pole corner does not have.
     */
    const uvAt = (ids: number[], ws: number[]): [number, number] => {
      let su = 0, nu = 0, sv = 0, nv = 0;
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k], w = ws[k];
        if (!(flatOf(i) & 1)) { su += w * uv[2 * i]; nu += w; }
        if (!(flatOf(i) & 2)) { sv += w * uv[2 * i + 1]; nv += w; }
      }
      // Every corner with a weight at a pole in this parameter (or the weights there are all zero): plain average.
      if (!(nu > 0)) { su = 0; nu = 0; for (let k = 0; k < ids.length; k++) { su += ws[k] * uv[2 * ids[k]]; nu += ws[k]; } }
      if (!(nv > 0)) { sv = 0; nv = 0; for (let k = 0; k < ids.length; k++) { sv += ws[k] * uv[2 * ids[k] + 1]; nv += ws[k]; } }
      return [su / nu, sv / nv];
    };
    const midUv = (ids: number[]) => uvAt(ids, ids.map(() => 1 / ids.length));
    /**
     * The last surface point and first derivatives `sag` accepted, copied out of the kernel once per
     * evaluation (each read of a coordinate is a call into the WebAssembly kernel): S, Du, Dv.
     */
    const E = new Float64Array(9);
    const evalAt = (u: number, v: number) => { ad.D1(u, v, S, Du, Dv); copyE(); };
    const copyE = () => {
      E[0] = S.X(); E[1] = S.Y(); E[2] = S.Z(); E[3] = Du.X(); E[4] = Du.Y(); E[5] = Du.Z(); E[6] = Dv.X(); E[7] = Dv.Y(); E[8] = Dv.Z();
    };
    /**
     * Side of the surface the point is on, from the last surface point and derivatives `sag` accepted:
     * +1 along the surface normal (Du x Dv), -1 against it, 0 when that cannot be told (the gap is not
     * mostly along the normal there, or a pole).
     */
    const sideOf = (x: number, y: number, z: number, d: number) => {
      if (d < 1e-12) return 1; // on the surface: either side, nothing to add
      const nx = E[4] * E[8] - E[5] * E[7], ny = E[5] * E[6] - E[3] * E[8], nz = E[3] * E[7] - E[4] * E[6];
      const nl = Math.hypot(nx, ny, nz);
      if (!(nl > 0)) return 0;
      const dot = ((x - E[0]) * nx + (y - E[1]) * ny + (z - E[2]) * nz) / nl;
      return Math.abs(dot) >= 0.9 * d ? Math.sign(dot) : 0;
    };
    let lastSide = 0;
    /**
     * Distance from a point of a flat triangle to the surface. Every surface point gives an upper
     * bound, starting with S(u, v) at the same parameters; Gauss-Newton steps along the surface (from
     * its first derivatives) walk to the nearest point, so the bound only gets tighter and never
     * under-reports. The walk goes on until the distance is within the limit AND the gap is along the
     * normal, so `lastSide` says which side of the surface the point is on. E holds the accepted point.
     */
    let lastU = 0, lastV = 0; // parameters of the point E holds
    const sag = (x: number, y: number, z: number, u: number, v: number, tol = lin, needSide = true, maxIt = 30) => {
      evalAt(u, v);
      let d = Math.hypot(x - E[0], y - E[1], z - E[2]);
      lastSide = sideOf(x, y, z, d);
      for (let it = 0; it < maxIt && (d > tol || (needSide && lastSide === 0)); it++) {
        const rx = x - E[0], ry = y - E[1], rz = z - E[2];
        const ux = E[3], uy = E[4], uz = E[5], vx = E[6], vy = E[7], vz = E[8];
        const a = ux * ux + uy * uy + uz * uz, b = ux * vx + uy * vy + uz * vz, c = vx * vx + vy * vy + vz * vz;
        const det = a * c - b * b;
        if (!(det > 0)) break; // singular point (a pole): keep the bound
        const gu = ux * rx + uy * ry + uz * rz, gv = vx * rx + vy * ry + vz * rz;
        const su = (c * gu - b * gv) / det, sv = (a * gv - b * gu) / det;
        // Where the surface is parameterized unevenly the full step can overshoot: halve it until the
        // distance drops (every accepted point is on the surface, so d stays an upper bound).
        let better = false;
        for (let h = 1, k = 0; k < 20; k++, h /= 2) {
          const nu = clampU(u + h * su), nv = clampV(v + h * sv);
          if (Math.abs(nu - u) + Math.abs(nv - v) < 1e-15) break;
          ad.D1(nu, nv, S, Du, Dv);
          const nd = Math.hypot(x - S.X(), y - S.Y(), z - S.Z());
          if (nd < d) { d = nd; u = nu; v = nv; better = true; break; }
        }
        if (!better) break; // E still holds the accepted point (rejected trials are not copied)
        copyE(); // the last evaluation was the accepted point: copy it and its derivatives
        lastSide = sideOf(x, y, z, d);
      }
      lastU = u; lastV = v;
      return d;
    };

    // Every corner the mesher made must be ON the surface, except where the model's own edge is not:
    // where two organic bodies were joined, the joint edge's 3D curve lies off the faces' surfaces (the
    // kernel's intersection curves are approximations), and the mesher puts border corners on that
    // curve. Each corner's distance to the surface is measured from the NEAREST surface point (a local
    // walk, then the kernel's global projection if the walk stalls), and its parameters are moved
    // there. The stored parameters alone overstate it: on one Easter Island head build |P - S(u, v)|
    // was up to 0.036 mm (the edge's tolerance; its curve on the face and its 3D curve disagree) where
    // the corner is 0.019 mm from the surface. An earlier version allowed for |P - S(u, v)| and so hid
    // gaps of up to 0.018 mm next to the joints (found by the independent check, 2026-11-06).
    // The true offset is allowed for up to the edge's tolerance (`off`, reported as `joint`): that is
    // the model's own accuracy there, no finer mesh can change it, and chords are judged against the
    // surface allowing for the offset of their end nodes. Beyond the edge's tolerance it counts in full.
    let geomSurf: any = null;
    const projectGlobal = (x: number, y: number, z: number) => {
      if (!geomSurf) { geomSurf = oc.BRep_Tool.Surface(face); if (geomSurf?.delete) objs.push(geomSurf); }
      const P = new oc.gp_Pnt(x, y, z);
      const pr = new oc.GeomAPI_ProjectPointOnSurf(P, geomSurf, u0, u1, v0, v1);
      try {
        if (!(pr.NbPoints() > 0)) return null;
        const { U, V } = pr.LowerDistanceParameters();
        return { d: pr.LowerDistance(), u: U, v: V };
      } finally { free(pr, P); }
    };
    const off = new Float64Array(nNodes); // allowed offset of each node from the surface (<= its edge tolerance)
    let offSurface = 0, joint = 0;
    for (let i = 0; i < nNodes; i++) {
      const x = pos[3 * (base + i)], y = pos[3 * (base + i) + 1], z = pos[3 * (base + i) + 2];
      let d = sag(x, y, z, uv[2 * i], uv[2 * i + 1], lin * 1e-4, false); // walks to the nearest point when not on S(u, v)
      if (d > lin * 0.01) {
        // The local walk can stall: ask the kernel's global point-to-surface projection too, and keep the
        // nearer. It is slow (a search over the whole surface), so only for corners off by more than 1%
        // of the setting; below that a stalled walk can overstate a joint corner's offset, and so its
        // allowance, by at most 1% of the setting.
        const g = projectGlobal(x, y, z);
        if (g && g.d < d) { d = g.d; lastU = g.u; lastV = g.v; }
      }
      if (lastU !== uv[2 * i] || lastV !== uv[2 * i + 1]) { uv[2 * i] = lastU; uv[2 * i + 1] = lastV; }
      if (!(d >= 0)) d = Infinity;
      const tol = border ? border.nodeTol[i] : 0;
      off[i] = Math.min(d, tol);
      joint = Math.max(joint, off[i]);
      offSurface = Math.max(offSurface, d - off[i]);
    }
    if (String(ad.GetType()).endsWith('Plane')) return [offSurface, 0, joint]; // flat triangles on a plane do not sag
    for (let i = 0; i < nNodes; i++) {
      evalAt(uv[2 * i], uv[2 * i + 1]);
      const lu = Math.hypot(E[3], E[4], E[5]), lv = Math.hypot(E[6], E[7], E[8]);
      if (lu <= 1e-7 * lv) flat[i] |= 1;
      else if (lv <= 1e-7 * lu) flat[i] |= 2;
    }
    const X = (i: number, c: number) => pos[3 * (base + i) + c];
    const linkKey = linkKeyOf;
    // Links used by one triangle of this face lie on the face's boundary (B-rep edges, seams): never split.
    const uses = new Map<number, number>();
    for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) { const key = linkKey(tris[t + k], tris[t + (k + 1) % 3]); uses.set(key, (uses.get(key) ?? 0) + 1); }
    const boundary = new Set([...uses].filter(([, n]) => n === 1).map(([k]) => k));
    const offOf = (i: number) => (i < nNodes ? off[i] : 0); // nodes added here lie on the surface
    const P0 = new oc.gp_Pnt(0, 0, 0), T0 = new oc.gp_Vec(0, 0, 0);
    objs.push(P0, T0);
    /**
     * Distance from a point of a border link to the B-rep edge it follows, starting at the curve
     * parameter a fraction `f` of the way from t0 (Gauss-Newton along the curve; an upper bound).
     */
    const curveSag = (x: number, y: number, z: number, e: BorderLink, f: number) => {
      const lo = Math.min(e.t0, e.t1), hi = Math.max(e.t0, e.t1);
      let t = e.t0 + f * (e.t1 - e.t0);
      e.curve.D1(t, P0, T0);
      let d = Math.hypot(x - P0.X(), y - P0.Y(), z - P0.Z());
      // Edge curves are often parameterized very unevenly (a B-spline intersection curve on [0, 1]),
      // so the full step can overshoot: halve it until the distance drops.
      for (let it = 0; it < 30 && d > lin / 100; it++) {
        const tx = T0.X(), ty = T0.Y(), tz = T0.Z(), tt = tx * tx + ty * ty + tz * tz;
        if (!(tt > 0)) break;
        const step = ((x - P0.X()) * tx + (y - P0.Y()) * ty + (z - P0.Z()) * tz) / tt;
        let better = false;
        for (let h = 1, k = 0; k < 20; k++, h /= 2) {
          const nt = Math.min(hi, Math.max(lo, t + h * step));
          if (Math.abs(nt - t) < 1e-15) break;
          e.curve.D1(nt, P0, T0);
          const nd = Math.hypot(x - P0.X(), y - P0.Y(), z - P0.Z());
          if (nd < d) { d = nd; t = nt; better = true; break; }
        }
        if (!better) break;
        e.curve.D1(t, P0, T0); // derivative at the accepted point for the next step
      }
      e.curve.D1(t, P0, T0); // P0 = the accepted curve point (a rejected trial may have moved it)
      return d;
    };
    const SIDE_F = [0.25, 0.5, 0.75];
    /**
     * Gaps to the surface at 1/4, 1/2, 3/4 of each link from its lower-numbered end: sizes (less the
     * joint allowance), sides (+1, -1; 0 unknown) and vectors (along the surface normal where the side
     * is known, so they agree with the signed sizes; else to the surface point found).
     */
    type Samples = { g: Float64Array; s: Int8Array; r: Float64Array };
    const sideMemo = new Map<number, Samples & { max: number; edge: number }>();
    const surfaceSample = (m: Samples, k: number, x: number, y: number, z: number, u: number, v: number, allow: number) => {
      const d = sag(x, y, z, u, v);
      const g = Math.max(0, d - allow);
      m.g[k] = g; m.s[k] = lastSide;
      if (lastSide !== 0) {
        const nx = E[4] * E[8] - E[5] * E[7], ny = E[5] * E[6] - E[3] * E[8], nz = E[3] * E[7] - E[4] * E[6];
        const f = (lastSide * g) / Math.hypot(nx, ny, nz); // from the surface to the point
        m.r[3 * k] = nx * f; m.r[3 * k + 1] = ny * f; m.r[3 * k + 2] = nz * f;
      } else {
        const f = d > 0 ? g / d : 0;
        m.r[3 * k] = (x - E[0]) * f; m.r[3 * k + 1] = (y - E[1]) * f; m.r[3 * k + 2] = (z - E[2]) * f;
      }
    };
    const samples = (): Samples => ({ g: new Float64Array(3), s: new Int8Array(3), r: new Float64Array(9) });
    const side = (a: number, b: number) => {
      const key = linkKey(a, b);
      let m = sideMemo.get(key);
      if (!m) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const sm = samples();
        const pt = (f: number) => [(1 - f) * X(lo, 0) + f * X(hi, 0), (1 - f) * X(lo, 1) + f * X(hi, 1), (1 - f) * X(lo, 2) + f * X(hi, 2)] as const;
        // Against the surface, allowing for the joint offset of the end nodes.
        for (let k = 0; k < 3; k++) {
          const f = SIDE_F[k], [x, y, z] = pt(f);
          surfaceSample(sm, k, x, y, z, ...uvAt([lo, hi], [1 - f, f]), (1 - f) * offOf(lo) + f * offOf(hi));
        }
        const known = sm.s[0] !== 0 && sm.s[1] !== 0 && sm.s[2] !== 0;
        const max = known ? sideGapMax(sm.g[0] * sm.s[0], sm.g[1] * sm.s[1], sm.g[2] * sm.s[2]) : sideGapMaxVec(sm.r);
        // A border link follows its B-rep edge: it is also measured against the edge's own curve (the
        // face's surface may reach past its border there, so the surface alone could miss a gap).
        let edgeMax = 0;
        const edge = border?.links.get(key);
        if (edge) {
          const r = new Float64Array(9);
          for (let k = 0; k < 3; k++) {
            const f = SIDE_F[k], [x, y, z] = pt(f);
            curveSag(x, y, z, edge, edge.n0 === lo ? f : 1 - f); // leaves P0 at the nearest curve point found
            r[3 * k] = P0.X() - x; r[3 * k + 1] = P0.Y() - y; r[3 * k + 2] = P0.Z() - z;
          }
          edgeMax = sideGapMaxVec(r);
        }
        m = { ...sm, max, edge: Math.max(max, edgeMax) };
        sideMemo.set(key, m);
      }
      return m;
    };
    /** Gaps at the three lattice points inside a triangle (corners in this order), with their sides. */
    const inner = (v: number[]) => {
      const m = samples();
      for (let k = 0; k < 3; k++) {
        const w = LATTICE[9 + k].map((n) => n / 4);
        let x = 0, y = 0, z = 0, o = 0;
        for (let c = 0; c < 3; c++) { x += w[c] * X(v[c], 0); y += w[c] * X(v[c], 1); z += w[c] * X(v[c], 2); o += w[c] * offOf(v[c]); }
        surfaceSample(m, k, x, y, z, ...uvAt(v, w), o);
      }
      return m;
    };
    /** Largest gap over a triangle from its 12 lattice gaps: signed sizes when every side is known (triangleGapMax), else vectors. */
    const vals = new Array<number>(12), vecs = new Float64Array(36);
    const triangleGap = (v: number[]) => {
      let known = true;
      const put = (n: number, m: Samples, i: number) => {
        vals[n] = m.g[i] * (m.s[i] || 1);
        if (m.s[i] === 0) known = false;
        vecs[3 * n] = m.r[3 * i]; vecs[3 * n + 1] = m.r[3 * i + 1]; vecs[3 * n + 2] = m.r[3 * i + 2];
      };
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3], m = side(a, b);
        for (let q = 0; q < 3; q++) put(3 * k + q, m, a < b ? q : 2 - q); // the memo runs from the lower-numbered end
      }
      const m = inner(v);
      for (let q = 0; q < 3; q++) put(9 + q, m, q);
      return known ? triangleGapMax(vals, true) : triangleGapMaxVec(vecs);
    };
    /** Each triangle's estimate once measured (NaN: not yet). A triangle that is not split keeps its corners, so its estimate. */
    let est: number[] = new Array(tris.length / 3).fill(NaN);
    let worst = 0, edgeWorst = 0;
    for (let round = 0; round <= REFINE_ROUNDS; round++) {
      // Links to split: inner links whose gap is too large anywhere along them; then, for a triangle
      // none of whose links is split yet and whose gap inside is too large, its longest inner link (in
      // 3D). A triangle with a split link is split anyway, so its inside is not measured this round.
      const split = new Set<number>();
      worst = 0; edgeWorst = 0;
      for (let t = 0; t < tris.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const a = tris[t + k], b = tris[t + (k + 1) % 3];
          const sm = side(a, b), key = linkKey(a, b);
          if (boundary.has(key)) { edgeWorst = Math.max(edgeWorst, sm.edge); continue; }
          worst = Math.max(worst, sm.max);
          if (sm.max > lin) split.add(key);
        }
      }
      for (let t = 0; t < tris.length; t += 3) {
        const v = [tris[t], tris[t + 1], tris[t + 2]];
        if (split.has(linkKey(v[0], v[1])) || split.has(linkKey(v[1], v[2])) || split.has(linkKey(v[2], v[0]))) continue;
        let dc = est[t / 3];
        if (Number.isNaN(dc)) dc = est[t / 3] = triangleGap(v);
        worst = Math.max(worst, dc);
        if (dc > lin) {
          let best: number | null = null, bestLen = -1;
          for (let k = 0; k < 3; k++) {
            const a = v[k], b = v[(k + 1) % 3];
            if (boundary.has(linkKey(a, b))) continue;
            const len = Math.hypot(X(a, 0) - X(b, 0), X(a, 1) - X(b, 1), X(a, 2) - X(b, 2));
            if (len > bestLen) { bestLen = len; best = linkKey(a, b); }
          }
          if (best !== null) split.add(best);
        }
      }
      // A triangle that is split also has its longest inner link split (longest-edge bisection, as in
      // Rivara's refinement): splitting only a short far-side link of a needle triangle would leave a
      // new link from the needle's tip as long as the old ones, and a fan of such needles never gets
      // finer (found on the Easter Island head at Extra fine, 2026-11-06: about 20 links stayed at
      // 0.006 to 0.018 mm sag after every round, and the part was meshed ever finer until the kernel ran
      // out of memory).
      if (split.size) {
        const longest: number[] = [];
        for (let t = 0; t < tris.length; t += 3) {
          const v = [tris[t], tris[t + 1], tris[t + 2]];
          let touched = false, best: number | null = null, bestLen = -1;
          for (let k = 0; k < 3; k++) {
            const a = v[k], b = v[(k + 1) % 3], key = linkKey(a, b);
            if (split.has(key)) touched = true;
            if (boundary.has(key)) continue;
            const len = Math.hypot(X(a, 0) - X(b, 0), X(a, 1) - X(b, 1), X(a, 2) - X(b, 2));
            if (len > bestLen) { bestLen = len; best = key; }
          }
          if (touched && best !== null) longest.push(best);
        }
        for (const key of longest) split.add(key);
      }
      if (!split.size || round === REFINE_ROUNDS) break;
      // New node at the middle of each split link, ON the surface.
      const mid = new Map<number, number>();
      for (const key of split) {
        const a = Math.floor(key / LINK_KEY), b = key - a * LINK_KEY;
        const [u, w] = midUv([a, b]);
        const p = at(u, w);
        const id = pos.length / 3 - base;
        pos.push(p[0], p[1], p[2]); uv.push(u, w);
        mid.set(key, id);
      }
      // Split each triangle by its marked links, keeping its winding (1, 2 or 3 marked links -> 2, 3 or 4 triangles).
      const out: number[] = [], outEst: number[] = [];
      for (let t = 0; t < tris.length; t += 3) {
        const v = [tris[t], tris[t + 1], tris[t + 2]];
        const m = [0, 1, 2].map((k) => mid.get(linkKey(v[k], v[(k + 1) % 3])));
        const n = m.filter((x) => x !== undefined).length;
        if (n === 0) { out.push(v[0], v[1], v[2]); outEst.push(est[t / 3]); continue; }
        for (let q = 0; q < n + 1; q++) outEst.push(NaN);
        if (n === 3) {
          const [ab, bc, ca] = m as number[];
          out.push(v[0], ab, ca, ab, v[1], bc, ca, bc, v[2], ab, bc, ca);
          continue;
        }
        // Rotate so the first marked link starts at r.
        const r = m.findIndex((x) => x !== undefined);
        const A = v[r], B = v[(r + 1) % 3], C = v[(r + 2) % 3];
        const mAB = m[r]!, mBC = m[(r + 1) % 3], mCA = m[(r + 2) % 3];
        if (n === 1) { out.push(A, mAB, C, mAB, B, C); continue; }
        if (mBC !== undefined) out.push(A, mAB, C, mAB, B, mBC, mAB, mBC, C);
        else out.push(A, mAB, mCA!, mAB, B, C, mAB, C, mCA!);
      }
      tris.length = out.length;
      for (let i = 0; i < out.length; i++) tris[i] = out[i];
      est = outEst;
    }
    return [Math.max(worst, offSurface), edgeWorst, joint];
  } finally { freeAll(objs); free(ad); }
}

/**
 * Triangles of the B-rep in mm (doubles), meshed to the chord tolerance and
 * refined where the mesher missed it; `sag` is the largest measured sag.
 */
function triangulate(oc: OC, s: TopoDS_Shape, target: number, ang: number, lin: number) {
  // Start from scratch: BRepMesh keeps an existing triangulation when it is already finer than asked,
  // which would make the file depend on what was exported or displayed before.
  (oc.BRepTools as any).Clean(s, false);
  const mesher = new oc.BRepMesh_IncrementalMesh(s, target, false, ang, false);
  mesher.delete();
  const pos: number[] = [];
  const tri: number[] = [];
  let unmeshed = 0, sag = 0, edgeSag = 0, joint = 0;
  const faces = listSubShapes(oc, s, 'TopAbs_FACE');
  try {
    for (const f of faces) {
      const face = oc.TopoDS.Face(f);
      const loc = new oc.TopLoc_Location();
      let t: any = null, trsf: any = null;
      try {
        t = oc.BRep_Tool.Triangulation(face, loc, 0);
        if (!t || t.IsNull?.()) { unmeshed++; continue; }
        const T = t.get ? t.get() : t;
        trsf = loc.IsIdentity() ? null : loc.Transformation();
        const base = pos.length / 3;
        const n = T.NbNodes();
        for (let i = 1; i <= n; i++) {
          const p = T.Node(i);
          if (trsf) p.Transform(trsf);
          pos.push(p.X(), p.Y(), p.Z());
          p.delete();
        }
        const m = T.NbTriangles();
        if (m === 0) { unmeshed++; continue; }
        const local: number[] = [];
        for (let i = 1; i <= m; i++) {
          const tr = T.Triangle(i);
          local.push(tr.Value(1) - 1, tr.Value(2) - 1, tr.Value(3) - 1);
          tr.delete();
        }
        if (T.HasUVNodes()) {
          const uv: number[] = [];
          for (let i = 1; i <= n; i++) { const q = T.UVNode(i); uv.push(q.X(), q.Y()); q.delete(); }
          const border = faceBorder(oc, face, t, loc, n);
          try {
            const [inner, edge, jt] = refineFace(oc, face, pos, base, uv, local, lin, border.info);
            sag = Math.max(sag, inner); edgeSag = Math.max(edgeSag, edge); joint = Math.max(joint, jt);
          } finally { border.release(); }
        } else sag = Infinity; // cannot be measured: reported as a problem
        const reversed = face.Orientation() === (oc.TopAbs_Orientation as any).TopAbs_REVERSED || String(face.Orientation()).includes('REVERSED');
        for (let i = 0; i < local.length; i += 3) {
          const a = base + local[i], b = base + local[i + 1], c = base + local[i + 2];
          if (reversed) tri.push(a, c, b); else tri.push(a, b, c);
        }
      } finally { free(trsf, t, loc, face); }
    }
  } finally {
    freeAll(faces);
    // The export mesh is far finer than the display mesh: do not leave it attached to the model.
    (oc.BRepTools as any).Clean(s, false);
  }
  return { pos, tri, unmeshed, sag: Math.max(sag, edgeSag), edgeSag, joint };
}

/**
 * The border of one meshed face: which of its triangulation's nodes lie on which B-rep edge (from
 * the edges' polygons on the triangulation), with that edge's tolerance, and the edge's 3D curve
 * and parameters for each border link. Null info when the polygons are missing (then every node is
 * judged as if it had to lie on the surface: stricter, never looser).
 */
function faceBorder(oc: OC, face: any, tHandle: any, loc: any, nNodes: number): { info: FaceBorder | null; release(): void } {
  const objs: { delete(): void }[] = [];
  const nodeTol = new Float64Array(nNodes);
  const links = new Map<number, BorderLink>();
  const key = linkKeyOf;
  let complete = true;
  const ex = new oc.TopExp_Explorer(face, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  try {
    for (; ex.More(); ex.Next()) {
      const cur = ex.Current();
      const e = oc.TopoDS.Edge(cur);
      objs.push(cur, e);
      let poly: any = null;
      try { poly = (oc.BRep_Tool as any).PolygonOnTriangulation(e, tHandle, loc); } catch { poly = null; }
      const P = poly && !(poly.IsNull?.()) ? (poly.get ? poly.get() : poly) : null;
      if (!P) { if (!oc.BRep_Tool.Degenerated(e)) complete = false; if (poly) objs.push(poly); continue; }
      objs.push(poly);
      const tol = oc.BRep_Tool.Tolerance(e);
      const m = P.NbNodes();
      const idx: number[] = [];
      for (let i = 1; i <= m; i++) { const k = P.Node(i) - 1; idx.push(k); if (k >= 0 && k < nNodes) nodeTol[k] = Math.max(nodeTol[k], tol); }
      if (oc.BRep_Tool.Degenerated(e) || !P.HasParameters()) continue;
      const curve = new oc.BRepAdaptor_Curve(e);
      objs.push(curve);
      for (let i = 0; i + 1 < m; i++) links.set(key(idx[i], idx[i + 1]), { curve, t0: P.Parameter(i + 1), t1: P.Parameter(i + 2), n0: idx[i] });
    }
  } finally { ex.delete(); }
  return { info: complete ? { nodeTol, links } : null, release: () => freeAll(objs) };
}

/** Largest distance (mm) from the points (mm) to the solid's skin (its faces, so a point inside is not at 0). */
function distanceToSkin(oc: OC, s: TopoDS_Shape, pts: number[][]): number {
  const faces = listSubShapes(oc, s, 'TopAbs_FACE');
  const comp = new oc.TopoDS_Compound();
  const b = new oc.TopoDS_Builder();
  let worst = 0;
  try {
    b.MakeCompound(comp);
    for (const f of faces) b.Add(comp, f);
    for (const p of pts) {
      const g = new oc.gp_Pnt(p[0], p[1], p[2]);
      const mv = new oc.BRepBuilderAPI_MakeVertex(g);
      const v = mv.Vertex();
      try { worst = Math.max(worst, shapeDistance(oc, comp, v)); } finally { free(v, mv, g); }
    }
  } finally { freeAll(faces); free(b, comp); }
  return worst;
}

/**
 * Weld the mesh, round to float32 in the output unit, weld again on the exact
 * float32 values and drop triangles that collapsed. What comes out is exactly
 * what the file holds, so the checks below are checks of the file.
 */
const WELD_MM = 1e-5;
function weld(pos: number[], tri: number[], scale: number) {
  // 1. Weld nodes closer than WELD mm (faces share their edges' points; seams of closed faces can
  //    differ in the last bits). WELD is 100x below anything a printer or CAM can see.
  const WELD = WELD_MM, CELL = 1e-3;
  const nIn = pos.length / 3;
  const rep = new Int32Array(nIn);
  const grid = new Map<string, number[]>();
  const uniq: number[] = [];
  const near = (i: number, j: number) => Math.abs(pos[3 * i] - pos[3 * j]) <= WELD && Math.abs(pos[3 * i + 1] - pos[3 * j + 1]) <= WELD && Math.abs(pos[3 * i + 2] - pos[3 * j + 2]) <= WELD;
  for (let i = 0; i < nIn; i++) {
    const x = pos[3 * i] / CELL, y = pos[3 * i + 1] / CELL, z = pos[3 * i + 2] / CELL;
    const gx = Math.floor(x), gy = Math.floor(y), gz = Math.floor(z);
    // Only look in neighbouring cells when the point is within WELD of its cell's side.
    const w = WELD / CELL;
    const xs = [gx, ...(x - gx < w ? [gx - 1] : []), ...(gx + 1 - x < w ? [gx + 1] : [])];
    const ys = [gy, ...(y - gy < w ? [gy - 1] : []), ...(gy + 1 - y < w ? [gy + 1] : [])];
    const zs = [gz, ...(z - gz < w ? [gz - 1] : []), ...(gz + 1 - z < w ? [gz + 1] : [])];
    let found = -1;
    search: for (const a of xs) for (const b of ys) for (const c of zs) {
      const cell = grid.get(`${a},${b},${c}`);
      if (cell) for (const j of cell) if (near(i, j)) { found = j; break search; }
    }
    if (found >= 0) { rep[i] = rep[found]; continue; }
    rep[i] = uniq.length; uniq.push(i);
    const k = `${gx},${gy},${gz}`;
    const cell = grid.get(k); if (cell) cell.push(i); else grid.set(k, [i]);
  }
  // 2. Round to float32 in the output unit, then merge points that became identical.
  const f32 = new Float32Array(3);
  const bits = new Uint32Array(f32.buffer);
  const byBits = new Map<string, number>();
  const outPos: number[] = [];
  const remap = new Int32Array(uniq.length);
  uniq.forEach((src, u) => {
    f32[0] = pos[3 * src] / scale; f32[1] = pos[3 * src + 1] / scale; f32[2] = pos[3 * src + 2] / scale;
    const k = `${bits[0]},${bits[1]},${bits[2]}`;
    let v = byBits.get(k);
    if (v === undefined) { v = outPos.length / 3; byBits.set(k, v); outPos.push(f32[0], f32[1], f32[2]); }
    remap[u] = v;
  });
  // 3. Triangles on the final points; collapsed ones (two corners on one point) are left out.
  const outTri: number[] = [];
  let dropped = 0;
  for (let t = 0; t < tri.length; t += 3) {
    const a = remap[rep[tri[t]]], b = remap[rep[tri[t + 1]]], c = remap[rep[tri[t + 2]]];
    if (a === b || b === c || a === c) { dropped++; continue; }
    outTri.push(a, b, c);
  }
  const slivers = fixSlivers(outPos, outTri);
  // How far welding and float32 rounding moved any point (mm): a triangle of the file is then at most
  // this much farther from the surface than the measured one.
  let moved = 0;
  for (let i = 0; i < nIn; i++) {
    const v = 3 * remap[rep[i]];
    moved = Math.max(moved, Math.hypot(outPos[v] * scale - pos[3 * i], outPos[v + 1] * scale - pos[3 * i + 1], outPos[v + 2] * scale - pos[3 * i + 2]));
  }
  // Points no triangle uses any more (only at collapsed triangles) are not part of the mesh.
  return { pos: outPos, tri: outTri, dropped, slivers, moved };
}

/** Zero area: the cross product vanishes against the triangle's size (three corners on one line). */
function flat(P: number[], a: number, b: number, c: number): boolean {
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  const len2 = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz);
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) <= 1e-12 * len2;
}

/**
 * A triangle whose three corners lie on one line (a, b, c with b on the long
 * side c-a) is removed by flipping that long side with the neighbouring
 * triangle (a, c, d): the two become (a, b, d) and (b, c, d). Same surface,
 * same winding, still closed; slicers flag flat triangles as errors.
 * Returns how many were fixed (a flat triangle that cannot be fixed stays and
 * is reported by the checks).
 */
export function fixSlivers(P: number[], T: number[]): number {
  let fixed = 0;
  for (let pass = 0; pass < 3; pass++) {
    const bad: number[] = [];
    for (let t = 0; t < T.length; t += 3) if (flat(P, T[t], T[t + 1], T[t + 2])) bad.push(t);
    if (!bad.length) break;
    // Directed edge -> triangle (index of its first corner in T).
    const owner = new Map<string, number>();
    for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) owner.set(`${T[t + k]}>${T[t + (k + 1) % 3]}`, t);
    let any = false;
    for (const t of bad) {
      if (!flat(P, T[t], T[t + 1], T[t + 2])) continue; // fixed by an earlier flip
      // Rotate so the long side is c -> a (the middle corner is b).
      const len = (i: number, j: number) => Math.hypot(P[3 * i] - P[3 * j], P[3 * i + 1] - P[3 * j + 1], P[3 * i + 2] - P[3 * j + 2]);
      const v = [T[t], T[t + 1], T[t + 2]];
      const sides = [0, 1, 2].map((k) => len(v[(k + 2) % 3], v[k])); // side k: from v[k-1] to v[k] (c -> a when k = 0)
      const k = sides.indexOf(Math.max(...sides));
      const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
      const n = owner.get(`${a}>${c}`);
      if (n === undefined || n === t) continue;
      const w = [T[n], T[n + 1], T[n + 2]];
      const j = w.findIndex((x, i) => x === a && w[(i + 1) % 3] === c);
      if (j < 0) continue;
      const d = w[(j + 2) % 3];
      // The new side b-d must not exist yet (it would join three triangles), and neither new triangle may be flat.
      if (d === b || owner.has(`${b}>${d}`) || owner.has(`${d}>${b}`) || flat(P, a, b, d) || flat(P, b, c, d)) continue;
      T[t] = a; T[t + 1] = b; T[t + 2] = d;
      T[n] = b; T[n + 1] = c; T[n + 2] = d;
      for (const [x, y, o] of [[a, b, t], [b, d, t], [d, a, t], [b, c, n], [c, d, n], [d, b, n]]) owner.set(`${x}>${y}`, o);
      owner.delete(`${c}>${a}`); owner.delete(`${a}>${c}`);
      fixed++; any = true;
    }
    if (!any) break;
  }
  return fixed;
}

interface MeshCheck {
  vertices: number; openEdges: number; nonManifoldEdges: number; flippedEdges: number; zeroAreaTriangles: number;
  pieces: number; throughHoles: number | null; volume: number; min: [number, number, number]; max: [number, number, number];
}

/**
 * Topology and geometry checks of an indexed triangle mesh (coordinates in
 * file units). Exported for the tests, which run it on files read back from bytes.
 */
export function checkMesh(pos: ArrayLike<number>, tri: ArrayLike<number>): MeshCheck {
  const nT = tri.length / 3;
  const used = new Uint8Array(pos.length / 3);
  // Edge uses keyed by (low, high) vertex: forward (low -> high) and backward counts.
  const N = pos.length / 3;
  const fwd = new Map<number, number>(), bwd = new Map<number, number>();
  let zeroArea = 0, vol = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  // Union-find for separate pieces.
  const parent = new Int32Array(N).map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let t = 0; t < nT; t++) {
    const v = [tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      used[a] = 1;
      const key = a < b ? a * N + b : b * N + a;
      const m = a < b ? fwd : bwd;
      m.set(key, (m.get(key) ?? 0) + 1);
      const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb;
      for (let d = 0; d < 3; d++) { const x = pos[3 * a + d]; if (x < min[d]) min[d] = x; if (x > max[d]) max[d] = x; }
    }
    const [ax, ay, az] = [pos[3 * v[0]], pos[3 * v[0] + 1], pos[3 * v[0] + 2]];
    const ux = pos[3 * v[1]] - ax, uy = pos[3 * v[1] + 1] - ay, uz = pos[3 * v[1] + 2] - az;
    const wx = pos[3 * v[2]] - ax, wy = pos[3 * v[2] + 1] - ay, wz = pos[3 * v[2] + 2] - az;
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const len2 = Math.max(ux * ux + uy * uy + uz * uz, wx * wx + wy * wy + wz * wz);
    // Zero area: the cross product vanishes against the triangle's size (collinear corners).
    if (Math.hypot(cx, cy, cz) <= 1e-12 * len2) zeroArea++;
    // Divergence theorem: sum of signed tetrahedra to the origin.
    vol += (ax * cx + ay * cy + az * cz) / 6;
  }
  let open = 0, nonMan = 0, flipped = 0;
  const keys = new Set<number>([...fwd.keys(), ...bwd.keys()]);
  for (const k of keys) {
    const f = fwd.get(k) ?? 0, b = bwd.get(k) ?? 0;
    if (f + b === 1) open++;
    else if (f + b > 2) nonMan++;
    else if (f !== 1) flipped++;
  }
  let V = 0;
  const roots = new Set<number>();
  for (let i = 0; i < N; i++) if (used[i]) { V++; roots.add(find(i)); }
  const E = keys.size;
  const pieces = roots.size;
  const closed = open === 0 && nonMan === 0 && flipped === 0;
  // Closed orientable surfaces: V - E + F = 2 * (pieces - holes).
  const chi = V - E + nT;
  const throughHoles = closed && (2 * pieces - chi) % 2 === 0 ? (2 * pieces - chi) / 2 : null;
  return { vertices: V, openEdges: open, nonManifoldEdges: nonMan, flippedEdges: flipped, zeroAreaTriangles: zeroArea, pieces, throughHoles, volume: vol, min, max };
}

const STL_HEADER_PREFIX = `${APP_NAME} binary STL`;

/** Plain printable ASCII (for the STL header and the ASCII solid name). */
const ascii = (s: string) => s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');

/**
 * Write an STL file and check it (see the top of this file). Coordinates are
 * the model's, as modeled (Z up, like slicers); only the unit is converted.
 */
export function exportStlFile(oc: OC, s: TopoDS_Shape, opt: StlOptions): { data: Uint8Array; report: StlReport } {
  if (!(opt.linearDeflection > 0) || !(opt.angularDeflection > 0)) throw new Error('STL tolerance must be greater than zero.');
  const scale = MM_PER[opt.unit];
  const lin = opt.linearDeflection;
  // The face's own border lines (B-rep edges) are shared with the next face, so they are not split
  // here; if one of them sags too much the whole part is meshed again a little finer.
  let passes = 0;
  // Writing the file moves every point a little: float32 rounding (at most 2^-24 of the part's
  // largest coordinate, in each axis, in any unit) and welding (points within WELD_MM). Refine to the
  // tolerance less that, so the file itself stays within it; the report adds the movement actually
  // measured. The margin does not depend on the unit, so an inch file holds the same triangles as the
  // mm file, only scaled.
  const bb = new oc.Bnd_Box();
  oc.BRepBndLib.Add(s, bb, false);
  const [bl, bh] = [takeXyz(bb.CornerMin()), takeXyz(bb.CornerMax())];
  bb.delete();
  const maxCoordMm = Math.max(...bl.map(Math.abs), ...bh.map(Math.abs));
  const linEff = lin - Math.sqrt(3) * (maxCoordMm * 2 ** -24 + WELD_MM);
  const meshTo = (target: number, ang: number) => {
    let raw = triangulate(oc, s, target, ang, linEff);
    passes++;
    for (let k = 1; raw.sag > linEff && k < MESH_PASSES; k++) {
      target *= Math.max(0.5, Math.min(0.9, (0.9 * linEff) / raw.sag));
      raw = triangulate(oc, s, target, ang, linEff);
      passes++;
    }
    const w = weld(raw.pos, raw.tri, scale);
    const chk = checkMesh(w.pos, w.tri);
    const crossing = selfIntersections(w.pos, w.tri);
    return { raw, w, chk, target, crossing };
  };
  let mesh = meshTo(lin, opt.angularDeflection);
  // Triangles passing through each other (a fold where the mesher put a few triangles past a face's
  // border, or a sharp spot thinner than the tolerance): mesh the part again finer. Keep a finer mesh
  // only when it is as good in every other check and has fewer crossings.
  for (let k = 1; k <= CROSSING_RETRIES && mesh.crossing.triangles > 0; k++) {
    const m = meshTo(mesh.target * CROSSING_FINER, opt.angularDeflection * CROSSING_FINER ** k);
    const clean = (x: typeof m) => x.raw.sag <= linEff && !x.raw.unmeshed && !x.chk.openEdges && !x.chk.nonManifoldEdges && !x.chk.flippedEdges && !x.chk.zeroAreaTriangles;
    if (clean(m) && (m.crossing.triangles < mesh.crossing.triangles || !clean(mesh))) mesh = m;
    else mesh = { ...mesh, target: m.target }; // keep the better mesh, go finer from here next time
  }
  const { raw, w, chk, crossing } = mesh;
  // Where triangles cross, measure the distance of their corners and centers from the exact solid,
  // so the deviation reported is true there too (a fold can stick out past the face's border).
  let crossingDeviation = 0;
  if (crossing.triangles) {
    const pts: number[][] = [];
    for (const t of crossing.hits.slice(0, 100)) {
      const c = [0, 1, 2].map((k) => [w.pos[3 * w.tri[3 * t + k]], w.pos[3 * w.tri[3 * t + k] + 1], w.pos[3 * w.tri[3 * t + k] + 2]]);
      pts.push(...c, [0, 1, 2].map((a) => (c[0][a] + c[1][a] + c[2][a]) / 3));
    }
    crossingDeviation = distanceToSkin(oc, s, pts.map((p) => p.map((x) => x * scale)));
  }
  const nT = w.tri.length / 3;
  const P = w.pos;

  // Facet normals from the (float32) corners, right-hand rule = outward.
  const normal = (t: number): [number, number, number] => {
    const a = 3 * w.tri[3 * t], b = 3 * w.tri[3 * t + 1], c = 3 * w.tri[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
  };

  let data: Uint8Array;
  if (opt.format === 'binary') {
    const buf = new ArrayBuffer(84 + nT * 50);
    const dv = new DataView(buf);
    // The header must not start with "solid" (readers would take the file for ASCII).
    const header = `${STL_HEADER_PREFIX}; units: ${opt.unit}; part: ${ascii(opt.name)}`.slice(0, 80);
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
    dv.setUint32(80, nT, true);
    let o = 84;
    for (let t = 0; t < nT; t++) {
      for (const x of normal(t)) { dv.setFloat32(o, x, true); o += 4; }
      for (let k = 0; k < 3; k++) {
        const v = 3 * w.tri[3 * t + k];
        dv.setFloat32(o, P[v], true); dv.setFloat32(o + 4, P[v + 1], true); dv.setFloat32(o + 8, P[v + 2], true); o += 12;
      }
      dv.setUint16(o, 0, true); o += 2;
    }
    data = new Uint8Array(buf);
  } else {
    // 9 significant digits: enough to give back the same float32 value when read.
    const f = (x: number) => (x === 0 ? '0' : x.toExponential(8));
    const solid = ascii(opt.name).replace(/\s+/g, '_') || 'part';
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [enc.encode(`solid ${solid}\n`)];
    let part: string[] = [];
    for (let t = 0; t < nT; t++) {
      const [nx, ny, nz] = normal(t);
      part.push(`  facet normal ${f(nx)} ${f(ny)} ${f(nz)}\n    outer loop\n`);
      for (let k = 0; k < 3; k++) { const v = 3 * w.tri[3 * t + k]; part.push(`      vertex ${f(P[v])} ${f(P[v + 1])} ${f(P[v + 2])}\n`); }
      part.push('    endloop\n  endfacet\n');
      if (part.length > 20000) { chunks.push(enc.encode(part.join(''))); part = []; }
    }
    part.push(`endsolid ${solid}\n`);
    chunks.push(enc.encode(part.join('')));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    data = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { data.set(c, o); o += c.length; }
  }

  const meshBox: Box = { min: chk.min.map((x) => x * scale) as Box['min'], max: chk.max.map((x) => x * scale) as Box['max'] };
  const volume = chk.volume * scale ** 3;
  const problems: string[] = [];
  if (!nT) problems.push('The mesh is empty.');
  if (raw.unmeshed) problems.push(`${raw.unmeshed} face${raw.unmeshed > 1 ? 's' : ''} could not be triangulated (each would be a hole in the print).`);
  if (chk.openEdges) problems.push(`${chk.openEdges} open triangle edges (the skin has holes).`);
  if (chk.nonManifoldEdges) problems.push(`${chk.nonManifoldEdges} edges shared by more than two triangles (non-manifold).`);
  if (chk.flippedEdges) problems.push(`${chk.flippedEdges} edges between triangles facing opposite ways (flipped triangles).`);
  if (chk.zeroAreaTriangles) problems.push(`${chk.zeroAreaTriangles} zero-area triangles.`);
  if (nT && !(volume > 0)) problems.push('The mesh is inside out (negative volume).');
  const deviation = Math.max(raw.sag + w.moved, crossingDeviation);
  if (!(deviation <= lin)) problems.push(Number.isFinite(deviation) ? `Curved surfaces deviate up to ${deviation.toFixed(4)} mm from the model (asked for ${lin} mm).` : 'The deviation from the model could not be measured on every face.');
  if (crossing.triangles) {
    const at = crossing.where[0].map((x) => (x * scale).toFixed(1)).join(', ');
    problems.push(`${crossing.triangles} triangle${crossing.triangles > 1 ? 's pass' : ' passes'} through other triangles (the mesh crosses itself), for example near ${at} mm. Slicers usually print this, but the file is not exactly the part: try a finer resolution.`);
  }
  const notes: string[] = [];
  if (raw.joint > PROMISE_MM) problems.push(`Where bodies were joined, the model's own faces meet only within ${raw.joint.toFixed(4)} mm, more than the 0.005 in (0.127 mm) accuracy promise.`);
  else if (raw.joint > lin) notes.push(`Where bodies were joined, the model itself is exact to ${raw.joint.toFixed(4)} mm (its faces meet within that); the file follows the model's joint edges there.`);
  // Separate bodies are a valid file (each one closed), but often a surprise: a body that does not touch
  // the others prints as its own object, and one in the air needs supports (found when a mirrored boss
  // in the verification set landed off the plate, 2026-11-06).
  if (chk.pieces > 1) notes.push(`This part is ${chk.pieces} separate bodies that do not touch each other. The slicer prints each one as its own object, and a body in the air needs supports. If they should be one piece, join them in the model first.`);
  const report: StlReport = {
    format: opt.format, unit: opt.unit, bytes: data.byteLength, triangles: nT, vertices: chk.vertices, pieces: chk.pieces, throughHoles: chk.throughHoles,
    openEdges: chk.openEdges, nonManifoldEdges: chk.nonManifoldEdges, flippedEdges: chk.flippedEdges, zeroAreaTriangles: chk.zeroAreaTriangles,
    droppedTriangles: w.dropped, unmeshedFaces: raw.unmeshed, volume, bboxMin: meshBox.min, bboxMax: meshBox.max, sliversFixed: w.slivers,
    linearDeflection: lin, measuredDeviation: deviation, angularDeflection: opt.angularDeflection, meshPasses: passes,
    crossingTriangles: crossing.triangles, jointTolerance: raw.joint, notes,
    watertight: problems.length === 0, problems,
  };
  return { data, report };
}

// ===================================================================== STEP

export type StepSchema = 'AP214' | 'AP242';
/** OpenCascade's names for the schemas (write.step.schema). AP214IS = ISO 10303-214 International Standard. */
const SCHEMA_STATIC: Record<StepSchema, string> = { AP214: 'AP214IS', AP242: 'AP242DIS' };

export interface StepOptions {
  unit: ExportUnit;
  schema: StepSchema;
  /** Product (part) name stored in the file: the name other CAD shows for the body. */
  name: string;
  /** The file name written in the header. */
  fileName?: string;
}

export interface StepReport {
  unit: ExportUnit;
  schema: StepSchema;
  bytes: number;
  solids: number;
  faces: number;
  edges: number;
  vertices: number;
  /** What a fresh STEP reader got back from the text. */
  readBack: { solids: number; faces: number; edges: number; vertices: number; valid: boolean; openEdges: number; bboxError: number; outsideRange: number } | null;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  ok: boolean;
  problems: string[];
}

/**
 * The shape as it is written to STEP. A closed organic face that runs from
 * pole to pole (a body with two round ends, like an ear or a finger) and has
 * several holes cut into it is legal in OpenCascade, but STEP describes its
 * outer boundary only as vertex loops, so importers (OpenCascade's own, and
 * CAM systems) can rebuild the wrong region. Such faces are split in two
 * along their middle ring for export: the same surface, an extra edge, no
 * ambiguity.
 *
 * A face on a closed (periodic) B-spline surface, like the skin of a smooth
 * loft, may also run across the place where the surface's parameters start
 * over. OpenCascade allows that, but STEP has no periodic B-splines: the file
 * gives the surface one parameter range, and such a face's trimming curves
 * would run past its end (found in the 2026-11-05 review: OpenCascade's own
 * reader then measured the Easter Island head 0.5% too small, and CAM systems
 * may reject or mis-trim the face). Such faces are split along that line, so
 * each piece lies inside the range.
 */
export function stepReady(oc: OC, s: TopoDS_Shape): TopoDS_Shape {
  const tools = new oc.NCollection_List_TopoDS_Shape();
  let n = 0;
  const addIso = (surf: any, u: boolean, at: number) => {
    const iso = u ? surf.UIso(at) : surf.VIso(at);
    const mk = new oc.BRepBuilderAPI_MakeEdge(iso);
    if (mk.IsDone()) { const e = mk.Edge(); free(tools.Append(e)); e.delete(); n++; }
    free(mk, iso);
  };
  const faces = listSubShapes(oc, s, 'TopAbs_FACE');
  try {
    for (const f of faces) {
      const edges = listSubShapes(oc, f, 'TopAbs_EDGE');
      const poles = edges.filter((e) => { const ed = oc.TopoDS.Edge(e); const dg = (oc.BRep_Tool as any).Degenerated(ed); ed.delete(); return dg; }).length;
      freeAll(edges);
      const face = oc.TopoDS.Face(f);
      const ad = new oc.BRepAdaptor_Surface(face, false);
      const surf: any = (oc.BRep_Tool as any).Surface(face);
      // Closed around (periodic, or a closed rational ring such as a smooth loft of circles).
      if (poles >= 2 && (ad.IsUPeriodic() || ad.IsUClosed())) addIso(surf, false, (ad.FirstVParameter() + ad.LastVParameter()) / 2);
      if (String(ad.GetType()).includes('BSplineSurface') && (ad.IsUPeriodic() || ad.IsVPeriodic())) {
        for (const at of periodicCrossings(oc, face, ad)) addIso(surf, at.u, at.at);
      }
      free(surf, ad, face);
    }
  } finally { freeAll(faces); }
  if (!n) { tools.delete(); return s; }
  const sp = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  free(args.Append(s));
  sp.SetArguments(args); sp.SetTools(tools);
  const pr = new oc.Message_ProgressRange();
  sp.Build(pr);
  const out = sp.HasErrors() ? s : solidsOf(oc, sp.Shape(), countSolids(oc, s));
  free(sp, args, tools, pr);
  return out;
}

/**
 * The solids of a split result, rebuilt from their shells only. The splitter
 * keeps the parts of its splitting lines that lie off the faces as loose edges
 * inside the solid, and a point where a line only touches a face as a loose
 * vertex inside that face; the STEP file holds only the faces and their
 * boundaries, so they made the read-back counts disagree. Unchanged if the
 * solid count is not what it should be.
 */
function solidsOf(oc: OC, s: TopoDS_Shape, want: number): TopoDS_Shape {
  const E = oc.TopAbs_ShapeEnum as any;
  const solids: TopoDS_Shape[] = [];
  const ex = new oc.TopExp_Explorer(s, E.TopAbs_SOLID, E.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) solids.push(ex.Current());
  ex.delete();
  if (solids.length !== want || want === 0) { freeAll(solids); return s; }
  const builder = new oc.TopoDS_Builder();
  const clean = solids.map((solid) => {
    const out = new oc.TopoDS_Solid();
    builder.MakeSolid(out);
    // Direct children only: the solid's own shells (with their orientation), not its loose edges.
    const it = new oc.TopExp_Explorer(solid, E.TopAbs_SHELL, E.TopAbs_FACE);
    for (; it.More(); it.Next()) {
      const sh = it.Current();
      const clean = withoutLooseVertices(oc, builder, sh);
      builder.Add(out, clean);
      if (clean !== sh) clean.delete();
      sh.delete();
    }
    it.delete();
    return out;
  });
  freeAll(solids); s.delete();
  if (want === 1) { builder.delete(); return clean[0]; }
  const c = new oc.TopoDS_Compound();
  builder.MakeCompound(c);
  for (const x of clean) builder.Add(c, x);
  freeAll(clean); builder.delete();
  return c;
}

/** Vertices of a face that are not on any of its edges (loose points inside it). */
function looseVertexCount(oc: OC, face: TopoDS_Shape): number {
  const E = oc.TopAbs_ShapeEnum as any;
  const ex = new oc.TopExp_Explorer(face, E.TopAbs_VERTEX, E.TopAbs_EDGE);
  let n = 0;
  for (; ex.More(); ex.Next()) { n++; ex.Current().delete(); }
  ex.delete();
  return n;
}

/** The shell with every face that holds loose vertices rebuilt from its boundary wires only (the same shell if none). */
function withoutLooseVertices(oc: OC, builder: any, shell: TopoDS_Shape): TopoDS_Shape {
  const E = oc.TopAbs_ShapeEnum as any;
  const faces: TopoDS_Shape[] = [];
  const ex = new oc.TopExp_Explorer(shell, E.TopAbs_FACE, E.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) faces.push(ex.Current());
  ex.delete();
  if (!faces.some((f) => looseVertexCount(oc, f) > 0)) { freeAll(faces); return shell; }
  const out = new oc.TopoDS_Shell();
  builder.MakeShell(out);
  for (const f of faces) {
    if (looseVertexCount(oc, f) === 0) { builder.Add(out, f); continue; }
    // Same surface, location, orientation and tolerance; then only its wires (the edges keep their p-curves).
    const nf = f.EmptyCopied();
    const wx = new oc.TopExp_Explorer(f, E.TopAbs_WIRE, E.TopAbs_SHAPE);
    for (; wx.More(); wx.Next()) { const w = wx.Current(); builder.Add(nf, w); w.delete(); }
    wx.delete();
    builder.Add(out, nf);
    nf.delete();
  }
  freeAll(faces);
  out.Closed(shell.Closed());
  return out;
}

/**
 * Where a face on a periodic B-spline surface crosses the start of the
 * surface's parameter range (its first knot plus whole periods): the lines a
 * STEP file needs the face split along (see stepReady). A crossing closer than
 * a millionth of a period to the face's own edge is the edge itself.
 */
export function periodicCrossings(oc: OC, face: any, ad: any): { u: boolean; at: number }[] {
  const out: { u: boolean; at: number }[] = [];
  const h: any = ad.BSpline();
  const bs = h.get ? h.get() : h;
  const b = (oc.BRepTools as any).UVBounds(face, 0, 0, 0, 0);
  const dirs = [
    { u: true, periodic: bs.IsUPeriodic(), k0: bs.IsUPeriodic() ? bs.UKnot(1) : 0, k1: bs.IsUPeriodic() ? bs.UKnot(bs.NbUKnots()) : 0, lo: b.UMin, hi: b.UMax },
    { u: false, periodic: bs.IsVPeriodic(), k0: bs.IsVPeriodic() ? bs.VKnot(1) : 0, k1: bs.IsVPeriodic() ? bs.VKnot(bs.NbVKnots()) : 0, lo: b.VMin, hi: b.VMax },
  ];
  free(h);
  for (const d of dirs) {
    if (!d.periodic) continue;
    const P = d.k1 - d.k0;
    if (!(P > 0)) continue;
    const m = 1e-6 * P;
    for (let j = Math.ceil((d.lo + m - d.k0) / P); d.k0 + j * P < d.hi - m; j++) out.push({ u: d.u, at: d.k0 + j * P });
  }
  return out;
}

/**
 * Faces on B-spline surfaces whose trimming reaches outside the surface's
 * parameter range (more than a millionth of it). A STEP surface has exactly
 * one range; a face across its end reads back wrong and is split for export
 * (stepReady). A face lying wholly one period further on reads back right with
 * OpenCascade, so this count is reported for information.
 */
export function facesOutsideRange(oc: OC, s: TopoDS_Shape): number {
  let bad = 0;
  const faces = listSubShapes(oc, s, 'TopAbs_FACE');
  try {
    for (const f of faces) {
      const face = oc.TopoDS.Face(f);
      const ad = new oc.BRepAdaptor_Surface(face, false);
      if (String(ad.GetType()).includes('BSplineSurface')) {
        const h: any = ad.BSpline();
        const bs = h.get ? h.get() : h;
        const b = (oc.BRepTools as any).UVBounds(face, 0, 0, 0, 0);
        const u0 = bs.UKnot(1), u1 = bs.UKnot(bs.NbUKnots()), v0 = bs.VKnot(1), v1 = bs.VKnot(bs.NbVKnots());
        const mu = 1e-6 * (u1 - u0), mv = 1e-6 * (v1 - v0);
        if (b.UMin < u0 - mu || b.UMax > u1 + mu || b.VMin < v0 - mv || b.VMax > v1 + mv) bad++;
        free(h);
      }
      free(ad, face);
    }
  } finally { freeAll(faces); }
  return bad;
}

/**
 * ISO 10303-21 string literal: apostrophes and backslashes doubled, characters
 * outside printable ASCII written as \X2\hhhh\X0\ (UTF-16, upper-case hex).
 */
export function stepString(s: string): string {
  let out = '';
  let wide = '';
  const flush = () => { if (wide) { out += `\\X2\\${wide}\\X0\\`; wide = ''; } };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += c === 0x27 ? "''" : c === 0x5c ? '\\\\' : s[i];
    } else wide += c.toString(16).toUpperCase().padStart(4, '0');
  }
  flush();
  return `'${out}'`;
}

/** Index just after the `;` that ends the header entity starting at `start` (quotes respected). */
function entityEnd(text: string, start: number): number {
  let q = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "'") q = !q; // a doubled '' toggles twice: still correct
    else if (!q && c === ';') return i + 1;
  }
  return -1;
}

/** Fill the header with the part's file name and the app (APP_NAME) as the originating system. */
function writeHeader(text: string, fileName: string, name: string): string {
  const head = text.indexOf('ENDSEC;');
  const fn = text.indexOf('FILE_NAME(');
  const fd = text.indexOf('FILE_DESCRIPTION(');
  if (head < 0 || fn < 0 || fd < 0 || fn > head || fd > head) return text;
  const fnEnd = entityEnd(text, fn), fdEnd = entityEnd(text, fd);
  if (fnEnd < 0 || fdEnd < 0) return text;
  const old = text.slice(fn, fnEnd);
  // Keep OpenCascade's time stamp and its preprocessor version (the translator that wrote the geometry).
  const stamp = /^FILE_NAME\('(?:[^']|'')*',\s*'([^']*)'/.exec(old)?.[1] ?? new Date().toISOString().slice(0, 19);
  const pre = /'(Open CASCADE STEP processor [^']*)'/.exec(old)?.[1] ?? 'Open CASCADE STEP processor';
  const newFn = `FILE_NAME(${stepString(fileName.slice(0, 256))},'${stamp}',(''),(''),\n  ${stepString(pre)},${stepString(APP_NAME)},'');`;
  const newFd = `FILE_DESCRIPTION((${stepString(`${APP_NAME} part: ${name}`.slice(0, 256))}),'2;1');`;
  // Replace the later one first so the earlier index stays valid.
  const [a, b] = fd < fn ? [[fn, fnEnd, newFn], [fd, fdEnd, newFd]] as const : [[fd, fdEnd, newFd], [fn, fnEnd, newFn]] as const;
  let t = text.slice(0, a[0]) + a[2] + text.slice(a[1]);
  t = t.slice(0, b[0]) + b[2] + t.slice(b[1]);
  return t;
}

function counts(oc: OC, s: TopoDS_Shape) {
  const n = (k: 'TopAbs_FACE' | 'TopAbs_EDGE' | 'TopAbs_VERTEX') => { const l = listSubShapes(oc, s, k); const c = l.length; freeAll(l); return c; };
  return { solids: countSolids(oc, s), faces: n('TopAbs_FACE'), edges: n('TopAbs_EDGE'), vertices: n('TopAbs_VERTEX') };
}

let stepSeq = 0;
const NAME_TOKEN = 'CHATCAD_PART_NAME_0F3A9C';

/** Read STEP text with a fresh reader into a shape in mm (the caller deletes it). */
export function readStep(oc: OC, text: string): TopoDS_Shape {
  const path = `/chatcad-read-${++stepSeq}.step`;
  oc.FS.writeFile(path, text);
  const r = new oc.STEPControl_Reader();
  try {
    // The reader converts whatever unit the file declares into this one.
    oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
    const st = String(r.ReadFile(path));
    if (!st.includes('RetDone')) throw new Error(`STEP reader: ${st}`);
    const pr = new oc.Message_ProgressRange();
    (r as any).TransferRoots(pr);
    pr.delete();
    return (r as any).OneShape();
  } finally {
    r.delete();
    try { oc.FS.unlink(path); } catch { /* already gone */ }
  }
}

/** Write STEP text for the shape (no read-back check). */
export function writeStep(oc: OC, shape: TopoDS_Shape, opt: StepOptions): string {
  const s = stepReady(oc, shape);
  const path = `/chatcad-write-${++stepSeq}.step`;
  const ws = new oc.XSControl_WorkSession();
  // Creating the writer registers the STEP parameters, so they are set after it.
  const w = new oc.STEPCAFControl_Writer(ws, false);
  const format = new oc.TCollection_ExtendedString('XmlXCAF', false);
  const doc = new oc.TDocStd_Document(format);
  const main = doc.Main();
  let label: any = null, nameStr: any = null, pr: any = null;
  try {
    const S = oc.Interface_Static;
    if (!S.SetCVal('write.step.schema', SCHEMA_STATIC[opt.schema])) throw new Error('STEP writer: schema setting not available');
    if (!S.SetCVal('write.step.unit', opt.unit === 'in' ? 'INCH' : 'MM')) throw new Error('STEP writer: unit setting not available');
    S.SetCVal('xstep.cascade.unit', 'MM');
    // One part, not an assembly; curves on surfaces (p-curves) written as usual.
    S.SetCVal('write.step.assembly', 'Off');
    S.SetCVal('write.surfacecurve.mode', 'On');
    // The model's own unit is the millimeter (this call takes the unit's size in meters).
    oc.XCAFDoc_DocumentTool.SetLengthUnit(doc, 0.001);
    const tool = oc.XCAFDoc_DocumentTool.ShapeTool(main);
    label = tool.AddShape(s, false, false);
    // The writer copies names into the file without ISO 10303-21 escaping (raw UTF-8, raw
    // backslashes), so it gets a plain token that is then replaced by the correctly encoded name.
    nameStr = new oc.TCollection_ExtendedString(NAME_TOKEN, false);
    oc.TDataStd_Name.Set(label, nameStr);
    w.SetNameMode(true);
    w.SetColorMode(false);
    w.SetLayerMode(false);
    w.SetPropsMode(false);
    pr = new oc.Message_ProgressRange();
    if (!w.Perform(doc, path, pr)) throw new Error('The STEP writer could not translate the part.');
    const text = oc.FS.readFile(path, { encoding: 'utf8' }) as string;
    if (!text.includes(`'${NAME_TOKEN}'`)) throw new Error('STEP writer: the part name was not written.');
    const named = text.split(`'${NAME_TOKEN}'`).join(stepString(opt.name || 'Part'));
    return writeHeader(named, opt.fileName ?? `${safeFileBase(opt.name)}.step`, opt.name || 'Part');
  } finally {
    try { oc.FS.unlink(path); } catch { /* not written */ }
    // Drop the document's hold on the shape before deleting the wrappers.
    try { main.ForgetAllAttributes(true); } catch { /* bindings without it */ }
    free(pr, nameStr, label, main, doc, format, w, ws);
    if (s !== shape) s.delete();
  }
}

/** Write STEP and check it by reading it back (see the top of this file). */
export function exportStepFile(oc: OC, shape: TopoDS_Shape, opt: StepOptions): { text: string; report: StepReport } {
  const text = writeStep(oc, shape, opt);
  const problems: string[] = [];
  const ready = stepReady(oc, shape);
  const want = counts(oc, ready);
  const box = exactBox(oc, ready);
  if (ready !== shape) ready.delete();
  if (want.solids === 0) problems.push('The part has no solid body, so the STEP file holds no solid.');
  let readBack: StepReport['readBack'] = null;
  let back: TopoDS_Shape | null = null;
  try {
    back = readStep(oc, text);
    const got = counts(oc, back);
    const bb = exactBox(oc, back);
    readBack = { ...got, valid: isValid(oc, back), openEdges: freeEdgeCount(oc, back), bboxError: boxDiff(box, bb), outsideRange: facesOutsideRange(oc, back) };
  } catch (e) {
    problems.push(`The file could not be read back: ${(e as Error).message}`);
  } finally { free(back); }
  if (readBack) {
    if (readBack.solids !== want.solids) problems.push(`Read back ${readBack.solids} solid${readBack.solids === 1 ? '' : 's'}, the part has ${want.solids}.`);
    if (readBack.faces !== want.faces || readBack.edges !== want.edges || readBack.vertices !== want.vertices)
      problems.push(`Read back ${readBack.faces} faces / ${readBack.edges} edges / ${readBack.vertices} vertices, the part has ${want.faces} / ${want.edges} / ${want.vertices}.`);
    if (!readBack.valid) problems.push('The solid read back from the file is not valid.');
    if (readBack.openEdges) problems.push(`The solid read back from the file has ${readBack.openEdges} open edges.`);
    // readBack.outsideRange (faces whose p-curves lie a whole period past their surface's range) is
    // reported, not a problem: OpenCascade writes such p-curves as they are, its reader sometimes
    // shifts them back and sometimes not, and in both cases the solid reads back valid, with the same
    // faces, size and volume (checked here and in tests). Moving them into the range needs edge
    // surgery this OpenCascade build does not offer.
    // 1e-6 of the part size (13 significant digits are written): far below 0.0001 in.
    const span = Math.max(...[0, 1, 2].map((k) => box.max[k] - box.min[k]), 1);
    if (readBack.bboxError > 1e-6 * span + 1e-7) problems.push(`The size read back differs by ${readBack.bboxError.toExponential(2)} mm.`);
  }
  const report: StepReport = {
    unit: opt.unit, schema: opt.schema, bytes: new TextEncoder().encode(text).length, ...want, readBack,
    bboxMin: box.min, bboxMax: box.max, ok: problems.length === 0, problems,
  };
  return { text, report };
}
