/**
 * Part quality check: is this a good part to 3D print and to send to CAM
 * (CAM software)? Every check is on the exact B-rep or on the same
 * mesh the STL export writes, so a part that passes prints and imports as it
 * is shown.
 *
 * Problems (the part is not a good part until they are fixed):
 *  - more than one solid (separate floating pieces), or no solid at all;
 *  - hidden hollows (inner shells left by a cut completely inside the body);
 *  - the B-rep is not valid, or not closed (free edges: a hole in the skin);
 *  - the STL mesh is not watertight (every triangle edge shared by exactly two triangles);
 *  - the STEP export does not read back as the same single solid (the Export STEP check, then the volume).
 * Warnings (worth fixing or at least telling the user):
 *  - very short edges / sliver faces (CAM toolpaths and meshing trip on them);
 *  - loose geometric tolerances (sloppy joins);
 *  - no flat face to stand on the print bed, or the centre of mass is outside it;
 *  - large overhangs (needs supports);
 *  - walls too thin to print (under 0.8 mm, two widths of a 0.4 mm FDM nozzle; under 0.4 mm a slicer
 *    prints nothing there).
 * All lengths are mm, areas mm^2 (the executor converts to document units).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { OC } from './regen';
import { countSolids, countShells, isValid, exactVolume } from './regen';
import { listSubShapes, tessellate } from './query';
import { exportStepFile, readStep } from './exporters';
import { takeXyz } from './mem';
import { wallThickness } from './walls';

export interface PartQuality {
  solids: number;
  valid: boolean;
  /** Boundary edges used by only one face (seams and poles excluded). 0 = closed skin. */
  freeEdges: number;
  /** STL mesh: triangle edges not shared by exactly two triangles. 0 = watertight. */
  meshOpenEdges: number;
  triangles: number;
  stepRoundTrip: boolean;
  /** Edges shorter than SHORT_EDGE mm, faces smaller than SLIVER_AREA mm^2. */
  shortEdges: number;
  sliverFaces: number;
  maxTolerance: number;
  /** Largest flat face on the bottom (outward normal -Z at the lowest point). */
  base: { area: number; size: [number, number]; comInside: boolean } | null;
  /** Downward-facing area steeper than 45 degrees from vertical, above the base (needs supports when printed standing). */
  overhangArea: number;
  surfaceArea: number;
  /**
   * Thinnest wall in mm (1st percentile over the surface, see ./walls.ts) and the share of the
   * surface on walls under WALL_NOZZLE / WALL_FDM; null when it could not be measured.
   */
  walls: { thinnest: number; min: number; underNozzle: number; underFdm: number; fromSize?: boolean } | null;
  problems: string[];
  warnings: string[];
}

const SHORT_EDGE = 0.01; // mm
const SLIVER_AREA = 0.001; // mm^2
/** FDM limits (as in verify/print/check_parts.py): a 0.4 mm nozzle, and two of its widths for a wall. */
const WALL_NOZZLE = 0.4, WALL_FDM = 0.8; // mm
/** The wall check needs a mesh this close to the part (mm); a coarser quick mesh is redone this fine when a wall is near the limit. */
const WALL_MESH = 0.02;

const isReversed = (oc: OC, f: TopoDS_Shape) => String(f.Orientation()).includes('REVERSED') || f.Orientation() === (oc.TopAbs_Orientation as any).TopAbs_REVERSED;

export function partQuality(oc: OC, shape: TopoDS_Shape): PartQuality {
  const problems: string[] = [];
  const warnings: string[] = [];
  const solids = countSolids(oc, shape);
  const valid = isValid(oc, shape);
  if (solids === 0) problems.push('There is no solid.');
  if (solids > 1) problems.push(`The part is ${solids} separate solids (floating pieces). A printable / machinable part is one solid: join or remove the loose pieces.`);
  const shells = countShells(oc, shape);
  if (solids >= 1 && shells > solids) problems.push(`The part has ${shells - solids} hidden hollow${shells - solids > 1 ? 's' : ''} inside (a cut or piece completely inside the body). Prints and toolpaths would be wrong: move the cut out to the surface or delete it.`);
  if (!valid) problems.push('The geometry is not valid (the kernel check failed). Rebuild the last features that changed.');

  // Free edges: an edge of the skin used by only one face, not counting seams of closed faces and degenerate pole edges.
  const faces = listSubShapes(oc, shape, 'TopAbs_FACE');
  const edges = listSubShapes(oc, shape, 'TopAbs_EDGE');
  const uses = edges.map(() => 0);
  let maxTol = 0;
  for (const f of faces) {
    const face = oc.TopoDS.Face(f);
    maxTol = Math.max(maxTol, (oc.BRep_Tool as any).Tolerance(face));
    face.delete();
    const ex = new oc.TopExp_Explorer(f, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
    // Count every use: a seam appears twice in its own face (once each way), any other edge once per face.
    for (; ex.More(); ex.Next()) {
      const c = ex.Current();
      const i = edges.findIndex((e) => e.IsSame(c));
      c.delete();
      if (i >= 0) uses[i]++;
    }
    ex.delete();
  }
  let freeEdges = 0, shortEdges = 0;
  edges.forEach((sh, i) => {
    const e = oc.TopoDS.Edge(sh);
    try {
      maxTol = Math.max(maxTol, (oc.BRep_Tool as any).Tolerance(e));
      if ((oc.BRep_Tool as any).Degenerated(e)) return;
      if (uses[i] !== 2) freeEdges++;
      const gp = new oc.GProp_GProps();
      oc.BRepGProp.LinearProperties(e, gp, false, false);
      if (gp.Mass() < SHORT_EDGE) shortEdges++;
      gp.delete();
    } finally { e.delete(); }
  });
  if (freeEdges) problems.push(`The skin is not closed (${freeEdges} open edges): it would not print or machine as a solid.`);
  if (shortEdges) warnings.push(`${shortEdges} very short edges (under ${SHORT_EDGE} mm): CAM and slicers can trip on them; they usually come from features that almost line up. Move one of them a little so they clearly overlap or clearly miss.`);
  if (maxTol > 0.01) warnings.push(`Loose joins: geometric tolerance up to ${maxTol.toFixed(3)} mm (should be under 0.01 mm).`);

  // Faces: slivers, the flat base, overhangs (from the exact face areas and the export mesh).
  const bb = new oc.Bnd_Box();
  oc.BRepBndLib.AddOptimal(shape, bb, false, false);
  const bLo = takeXyz(bb.CornerMin()), bHi = takeXyz(bb.CornerMax());
  const zMin = bLo[2];
  const span = Math.max(bHi[0] - bLo[0], bHi[1] - bLo[1], bHi[2] - zMin, 1e-6);
  bb.delete();
  let sliverFaces = 0, surfaceArea = 0;
  let base: PartQuality['base'] = null;
  let baseBox: [number, number, number, number] | null = null;
  for (const f of faces) {
    const face = oc.TopoDS.Face(f);
    const gp = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, gp, false, false);
    const area = gp.Mass();
    gp.delete();
    surfaceArea += area;
    if (area < SLIVER_AREA) sliverFaces++;
    const ad = new oc.BRepAdaptor_Surface(face, true);
    const t = ad.GetType();
    if (t === (oc as any).GeomAbs_SurfaceType?.GeomAbs_Plane || String(t).includes('Plane')) {
      const pl = ad.Plane(), ax = pl.Axis();
      let nz = takeXyz(ax.Direction())[2];
      pl.delete(); ax.delete();
      if (isReversed(oc, f)) nz = -nz;
      const fb = new oc.Bnd_Box();
      oc.BRepBndLib.AddOptimal(face, fb, false, false);
      const [loX, loY] = takeXyz(fb.CornerMin()), [hiX, hiY, hiZ] = takeXyz(fb.CornerMax());
      if (nz < -0.9999 && Math.abs(hiZ - zMin) < 1e-4 * span + 1e-6 && (!base || area > base.area)) {
        base = { area, size: [hiX - loX, hiY - loY], comInside: false };
        baseBox = [loX, loY, hiX, hiY];
      }
      fb.delete();
    }
    ad.delete(); face.delete();
  }
  if (sliverFaces) warnings.push(`${sliverFaces} tiny sliver faces (under ${SLIVER_AREA} mm^2): usually features that almost line up; nudge one so they clearly overlap.`);
  if (base && baseBox) {
    const vp = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shape, vp, false, false, false);
    const [cx, cy] = takeXyz(vp.CentreOfMass());
    base.comInside = cx >= baseBox[0] && cx <= baseBox[2] && cy >= baseBox[1] && cy <= baseBox[3];
    vp.delete();
    if (!base.comInside) warnings.push('The centre of mass is outside the flat base: the part may tip over when it stands on its base.');
  } else warnings.push('There is no flat face on the bottom to stand on the print bed: it needs supports or a raft (add a flat base or a flat cut on the bottom if it should stand).');

  // A quick print mesh: watertight, and overhangs. (The STL export checks its own, finer mesh the same way.)
  const quickDeflection = Math.max(0.01, span / 2000);
  const mesh = tessellate(oc, shape, { linearDeflection: quickDeflection, angularDeflection: 0.2 });
  // Weld vertices closer than WELD mm (faces mesh their shared edges at the same points, to float precision).
  const WELD = 1e-4, CELL = 1e-3;
  const grid = new Map<string, number[]>();
  const pts: number[] = [];
  const weld = (P: Float32Array, i: number) => {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL), gz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const v of grid.get(`${gx + dx},${gy + dy},${gz + dz}`) ?? []) {
        if (Math.abs(pts[3 * v] - x) <= WELD && Math.abs(pts[3 * v + 1] - y) <= WELD && Math.abs(pts[3 * v + 2] - z) <= WELD) return v;
      }
    }
    const v = pts.length / 3;
    pts.push(x, y, z);
    const k = `${gx},${gy},${gz}`;
    const cell = grid.get(k); if (cell) cell.push(v); else grid.set(k, [v]);
    return v;
  };
  const edgeUse = new Map<string, number>();
  let triangles = 0, overhangArea = 0;
  const tris: number[] = [];
  const zCut = zMin + 1e-3 * span;
  for (const f of mesh.faces) {
    const P = f.positions;
    for (let t = 0; t < f.indices.length; t += 3) {
      const a = f.indices[t] * 3, b = f.indices[t + 1] * 3, c = f.indices[t + 2] * 3;
      const va = weld(P, a), vb = weld(P, b), vc = weld(P, c);
      if (va === vb || vb === vc || va === vc) continue; // zero-area (pole) triangles are dropped by the export too
      triangles++;
      tris.push(va, vb, vc);
      for (const [p, q] of [[va, vb], [vb, vc], [vc, va]]) { const k = p < q ? `${p}_${q}` : `${q}_${p}`; edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1); }
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (!(l > 0)) continue;
      // Outward normal pointing down more than 45 degrees, and not on the bed.
      if (nz / l < -Math.SQRT1_2 && Math.min(P[a + 2], P[b + 2], P[c + 2]) > zCut) overhangArea += l / 2;
    }
  }
  let meshOpenEdges = 0;
  for (const n of edgeUse.values()) if (n !== 2) meshOpenEdges++;
  if (meshOpenEdges) problems.push(`The STL mesh is not watertight (${meshOpenEdges} open or non-manifold triangle edges): slicers would have to repair it.`);
  if (overhangArea > 0.05 * surfaceArea) warnings.push(`About ${Math.round((100 * overhangArea) / surfaceArea)}% of the surface overhangs more than 45 degrees: printed standing on its base it needs supports there (that is normal for figurines; say so).`);
  // Walls too thin to print. The quick mesh is within quickDeflection of the part, so a reading can be
  // off by twice that; when that could decide the warning, measure again on a mesh WALL_MESH close.
  let walls: PartQuality['walls'] = null;
  if (solids >= 1 && !meshOpenEdges) {
    const measure = (pos: ArrayLike<number>, tri: ArrayLike<number>) => {
      const w = wallThickness(pos, tri, [WALL_NOZZLE, WALL_FDM]);
      return w && { thinnest: w.p1, min: w.min, underNozzle: w.below[0], underFdm: w.below[1] };
    };
    walls = measure(pts, tris);
    if (walls && quickDeflection > WALL_MESH && walls.thinnest < WALL_FDM + 2 * quickDeflection) {
      const fine = tessellate(oc, shape, { linearDeflection: WALL_MESH, angularDeflection: 0.2 });
      const fp: number[] = [], ft: number[] = [];
      for (const f of fine.faces) {
        const base = fp.length / 3;
        for (let i = 0; i < f.positions.length; i++) fp.push(f.positions[i]);
        for (let i = 0; i < f.indices.length; i++) ft.push(base + f.indices[i]);
      }
      walls = measure(fp, ft) ?? walls;
    }
  }
  // No mesh reading (a part far smaller than the quick mesh's tolerance gets no triangles): no wall
  // can be thicker than the part's smallest size, so that is used.
  const smallest = Math.min(bHi[0] - bLo[0], bHi[1] - bLo[1], bHi[2] - bLo[2]);
  if (!walls && solids >= 1 && smallest < WALL_FDM) walls = { thinnest: smallest, min: smallest, underNozzle: smallest < WALL_NOZZLE ? 1 : 0, underFdm: 1, fromSize: true };
  if (walls && walls.thinnest < WALL_FDM) {
    const mm = (v: number) => `${v < 0.01 ? v.toPrecision(2) : v.toFixed(3)} mm`;
    const pc = Math.max(1, Math.round(100 * (walls.thinnest < WALL_NOZZLE ? walls.underNozzle : walls.underFdm)));
    const share = walls.fromSize ? ' (the whole part is that thin)' : ` (about ${pc}% of the surface is on walls under ${walls.thinnest < WALL_NOZZLE ? WALL_NOZZLE : WALL_FDM} mm)`;
    warnings.push(walls.thinnest < WALL_NOZZLE
      ? `Walls too thin to print: ${mm(walls.thinnest)} thin${share}. That is thinner than a 0.4 mm FDM nozzle, so a slicer prints nothing or leaves gaps there. For FDM printing make walls at least ${WALL_FDM} mm (0.031 in).`
      : `Thin walls: down to ${mm(walls.thinnest)}${share}. FDM printers need about ${WALL_FDM} mm (0.031 in, two widths of a 0.4 mm nozzle) for a solid wall; thinner walls print weak or with gaps.`);
  }

  // STEP round trip: what CAM software will read. The same read-back check as Export STEP (faces,
  // edges, validity, size, faces inside their surfaces), then the volume.
  let stepRoundTrip = false;
  try {
    const { text, report } = exportStepFile(oc, shape, { unit: 'mm', schema: 'AP214', name: 'Part' });
    const back = readStep(oc, text);
    // Exact integration (the quick Gauss volume differs by up to ~0.5% between parameterizations of
    // the same surface); a near miss is re-measured with the slower, more precise integration.
    const same = (a: number, b: number) => Math.abs(a - b) <= 1e-3 * Math.abs(a) + 1e-6;
    stepRoundTrip = report.ok && countSolids(oc, back) === solids
      && (same(exactVolume(oc, shape), exactVolume(oc, back)) || same(exactVolume(oc, shape, true), exactVolume(oc, back, true)));
    back.delete();
  } catch { stepRoundTrip = false; }
  if (!stepRoundTrip) problems.push('The STEP export does not read back as the same solid, so CAM software may not import it cleanly.');

  // Free the sub-shape handles (they would keep the whole part alive in the WASM heap).
  for (const x of [...faces, ...edges]) x.delete();
  return { solids, valid, freeEdges, meshOpenEdges, triangles, stepRoundTrip, shortEdges, sliverFaces, maxTolerance: maxTol, base, overhangArea, surfaceArea, walls, problems, warnings };
}
