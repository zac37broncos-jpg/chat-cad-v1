/**
 * Read-only queries on a regenerated shape: display tessellation, exact
 * measurements, mass properties, and export.
 *
 * Rule: the tessellation is ONLY for drawing on screen. Every number shown
 * to the user (lengths, radii, distances, volumes) is computed from the
 * exact B-rep, never from triangles.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { OC } from './regen';
import { free, freeAll, takeXyz } from './mem';
import { exactBox } from './bbox';
import { faceAreaByQuadrature, pastKnotRange } from './area';

export interface FaceMesh { index: number; positions: Float32Array; normals: Float32Array; indices: Uint32Array }
/** seam: the edge where a closed (periodic) face meets itself; not a real boundary, so it is not drawn. */
export interface EdgePolyline { index: number; points: Float32Array; seam?: boolean }
export interface MeshData { faces: FaceMesh[]; edges: EdgePolyline[] }

export interface TessOptions { linearDeflection: number; angularDeflection: number }
export const DISPLAY_TESS: TessOptions = { linearDeflection: 0.01, angularDeflection: 0.1 };

/** Unique sub-shapes in explorer order. The caller owns (and deletes) the returned shapes. */
export function listSubShapes(oc: OC, s: TopoDS_Shape, kind: 'TopAbs_FACE' | 'TopAbs_EDGE' | 'TopAbs_VERTEX'): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  const ex = new oc.TopExp_Explorer(s, (oc.TopAbs_ShapeEnum as any)[kind], (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const c = ex.Current();
    if (!out.some((o) => o.IsSame(c))) out.push(c); else c.delete();
  }
  ex.delete();
  return out;
}

/**
 * Display tolerance scaled to the part: 0.01 mm chord for small parts, up to
 * 0.2 mm on large ones (about 1/4000 of the part's size). Large organic parts
 * (many curved B-spline faces) otherwise take seconds to mesh for no visible gain.
 */
export function displayTess(oc: OC, s: TopoDS_Shape): TessOptions {
  const b = new oc.Bnd_Box();
  oc.BRepBndLib.Add(s, b, false);
  const lo = takeXyz(b.CornerMin()), hi = takeXyz(b.CornerMax());
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  b.delete();
  const lin = Math.min(0.2, Math.max(DISPLAY_TESS.linearDeflection, diag / 4000));
  return { linearDeflection: Number.isFinite(lin) ? lin : DISPLAY_TESS.linearDeflection, angularDeflection: DISPLAY_TESS.angularDeflection };
}

/**
 * Points along `curve` from u0 to u1, exactly as a new
 * GCPnts_TangentialDeflection(curve, u0, u1, angular, linear, 2, 1e-9, 1e-7)
 * gives them. That class has an empty destructor in these bindings (see
 * mem.ts), so a new object per curve would leave its point list on the heap
 * (about 1.6 MB per display mesh of a 12-hole plate). One object per kernel is
 * re-initialized for every curve instead; it holds only the last curve's points.
 */
const samplers = new WeakMap<object, any>();
export function curvePoints(oc: OC, curve: unknown, u0: number, u1: number, angular: number, linear: number): [number, number, number][] {
  let d = samplers.get(oc as object);
  if (!d) { d = new oc.GCPnts_TangentialDeflection(); samplers.set(oc as object, d); }
  // Explicit-range overload (8 args): the bindings dispatch overloads by argument count.
  d.Initialize(curve, u0, u1, angular, linear, 2, 1e-9, 1e-7);
  const out: [number, number, number][] = [];
  for (let i = 1, k = d.NbPoints(); i <= k; i++) out.push(takeXyz(d.Value(i)));
  return out;
}

export function tessellate(oc: OC, s: TopoDS_Shape, opt: TessOptions = displayTess(oc, s)): MeshData {
  const mesher = new oc.BRepMesh_IncrementalMesh(s, opt.linearDeflection, false, opt.angularDeflection, false);
  mesher.delete();
  const faceList = listSubShapes(oc, s, 'TopAbs_FACE');
  const edgeList = listSubShapes(oc, s, 'TopAbs_EDGE');
  const seams: TopoDS_Shape[] = [];
  try {
    const faces: FaceMesh[] = [];
    faceList.forEach((shape, index) => {
      const face = oc.TopoDS.Face(shape);
      const loc = new oc.TopLoc_Location();
      let tri: any = null;
      let trsf: any = null;
      try {
        tri = oc.BRep_Tool.Triangulation(face, loc, 0);
        if (!tri || (tri as any).IsNull?.()) return;
        const t = (tri as any).get ? (tri as any).get() : tri;
        // Faces of a built solid normally have no location: then the nodes are used as they are.
        // (Each point object read costs heap for good in these bindings, see mem.ts, so none extra.)
        trsf = loc.IsIdentity() ? null : loc.Transformation();
        const n = t.NbNodes();
        const positions = new Float32Array(n * 3);
        const normals = new Float32Array(n * 3);
        if (!t.HasNormals()) t.ComputeNormals();
        const reversed = String(face.Orientation()).includes('REVERSED') || face.Orientation() === (oc.TopAbs_Orientation as any).TopAbs_REVERSED;
        const sgn = reversed ? -1 : 1;
        for (let i = 1; i <= n; i++) {
          const p = t.Node(i);
          if (trsf) p.Transform(trsf);
          positions.set([p.X(), p.Y(), p.Z()], (i - 1) * 3);
          p.delete();
          const d = t.Normal(i);
          if (trsf) d.Transform(trsf);
          normals.set([d.X() * sgn, d.Y() * sgn, d.Z() * sgn], (i - 1) * 3);
          d.delete();
        }
        const m = t.NbTriangles();
        const indices = new Uint32Array(m * 3);
        for (let i = 1; i <= m; i++) {
          const tr = t.Triangle(i);
          const a = tr.Value(1) - 1, b = tr.Value(2) - 1, c = tr.Value(3) - 1;
          tr.delete();
          if (reversed) indices.set([a, c, b], (i - 1) * 3); else indices.set([a, b, c], (i - 1) * 3);
        }
        faces.push({ index, positions, normals, indices });
      } finally { free(trsf, tri, loc, face); }
    });
    for (const f of faceList) {
      const face = oc.TopoDS.Face(f);
      for (const e of listSubShapes(oc, f, 'TopAbs_EDGE')) {
        const edge = oc.TopoDS.Edge(e);
        const closed = (oc.BRep_Tool as any).IsClosed(edge, face);
        edge.delete();
        if (closed) seams.push(e); else e.delete();
      }
      face.delete();
    }
    const edges: EdgePolyline[] = [];
    edgeList.forEach((shape, index) => {
      const edge = oc.TopoDS.Edge(shape);
      const curve = new oc.BRepAdaptor_Curve(edge);
      const ps = curvePoints(oc, curve, curve.FirstParameter(), curve.LastParameter(), opt.angularDeflection, opt.linearDeflection);
      const pts = new Float32Array(ps.length * 3);
      ps.forEach((p, i) => pts.set(p, i * 3));
      edges.push({ index, points: pts, ...(seams.some((e) => e.IsSame(shape)) ? { seam: true } : {}) });
      curve.delete(); edge.delete();
    });
    return { faces, edges };
  } finally { freeAll(faceList); freeAll(edgeList); freeAll(seams); }
}

export interface MassProps { volume: number; area: number; centroid: [number, number, number]; bboxMin: [number, number, number]; bboxMax: [number, number, number] }

/**
 * Exact volume / surface area / centroid (mm based) from the B-rep.
 *
 * Faces that run past their surface's parameter range (see ./area.ts) are integrated wrong by
 * OpenCascade's plain integrations. When a part has such faces, its volume comes from the
 * Gauss-Kronrod integration (right on them, and the reference the print verification uses), and
 * those faces' areas from an independent quadrature. Its centroid stays the plain integration's
 * (Gauss-Kronrod with the centroid is up to 50 times slower; the plain centroid was measured within
 * 0.0004 mm of it on the organic heads). Parts without such faces (every prismatic part) are
 * computed exactly as before.
 */
export function massProperties(oc: OC, s: TopoDS_Shape): MassProps {
  // Note: OCCT's integration is unreliable on "surfaces of linear extrusion" of
  // B-spline curves; extrudes of sketch splines are therefore built as straight
  // lofts (true B-spline faces), see splinePrism in regen.ts.
  const faces = facesOf(oc, s);
  try {
    const past = faces.map((f) => pastKnotRange(oc, f));
    const vp = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(s, vp, 1e-12, false, false);
    const centroid = takeXyz(vp.CentreOfMass());
    let volume = vp.Mass();
    vp.delete();
    let area = 0;
    if (!past.some(Boolean)) {
      const sp = new oc.GProp_GProps();
      oc.BRepGProp.SurfaceProperties(s, sp, 1e-12, false);
      area = sp.Mass();
      sp.delete();
    } else {
      const gk = new oc.GProp_GProps();
      oc.BRepGProp.VolumePropertiesGK(s, gk, 1e-9, false, true, false, false, false);
      volume = gk.Mass();
      gk.delete();
      // The quadrature needs the faces' triangulations; the display mesh uses the same settings, so
      // it reuses this one instead of meshing again.
      const tess = displayTess(oc, s);
      const mesher = new oc.BRepMesh_IncrementalMesh(s, tess.linearDeflection, false, tess.angularDeflection, false);
      mesher.delete();
      faces.forEach((f, i) => {
        const q = past[i] ? faceAreaByQuadrature(oc, f) : null;
        if (q !== null) { area += q; return; }
        const g = new oc.GProp_GProps();
        oc.BRepGProp.SurfaceProperties(f, g, 1e-12, false);
        area += g.Mass();
        g.delete();
      });
    }
    // Exact geometry (no triangulation), checked on free-form faces (see ./bbox.ts).
    const box = exactBox(oc, s);
    return { volume, area, centroid, bboxMin: box.min, bboxMax: box.max };
  } finally { freeAll(faces); }
}

/** Every face occurrence in explorer order (as BRepGProp sums them). The caller deletes them. */
function facesOf(oc: OC, s: TopoDS_Shape): any[] {
  const out: any[] = [];
  const ex = new oc.TopExp_Explorer(s, (oc.TopAbs_ShapeEnum as any).TopAbs_FACE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) { const c = ex.Current(); out.push(oc.TopoDS.Face(c)); c.delete(); }
  ex.delete();
  return out;
}

export type EntityInfo =
  | { kind: 'face'; surface: 'plane'; area: number; normal: [number, number, number]; origin: [number, number, number] }
  | { kind: 'face'; surface: 'cylinder'; area: number; radius: number; axis: [number, number, number]; axisOrigin: [number, number, number] }
  | { kind: 'face'; surface: string; area: number }
  | { kind: 'edge'; curve: 'line'; length: number; start: [number, number, number]; end: [number, number, number] }
  | { kind: 'edge'; curve: 'circle'; length: number; radius: number; center: [number, number, number] }
  | { kind: 'edge'; curve: string; length: number };

/** One sub-shape (by listSubShapes index); the caller deletes it. */
function subShape(oc: OC, s: TopoDS_Shape, kind: 'TopAbs_FACE' | 'TopAbs_EDGE', index: number): TopoDS_Shape | undefined {
  const all = listSubShapes(oc, s, kind);
  const out = all[index];
  freeAll(all.filter((x) => x !== out));
  return out;
}

/** Exact information about one face or edge, by its index from listSubShapes. */
export function entityInfo(oc: OC, s: TopoDS_Shape, kind: 'face' | 'edge', index: number): EntityInfo {
  if (kind === 'face') {
    const sh = subShape(oc, s, 'TopAbs_FACE', index);
    if (!sh) throw new Error(`No face ${index}`);
    const face = oc.TopoDS.Face(sh);
    sh.delete();
    const gp = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, gp, 1e-12, false);
    const area = gp.Mass(); gp.delete();
    const ad = new oc.BRepAdaptor_Surface(face, true);
    const type = String(ad.GetType());
    try {
      if (type.endsWith('Plane')) {
        const pl = ad.Plane(); const ax = pl.Axis();
        let n = takeXyz(ax.Direction());
        if (String(face.Orientation()).includes('REVERSED')) n = [-n[0], -n[1], -n[2]];
        const origin = takeXyz(ax.Location());
        pl.delete(); ax.delete();
        return { kind: 'face', surface: 'plane', area, normal: n, origin };
      }
      if (type.endsWith('Cylinder')) {
        const cy = ad.Cylinder(); const ax = cy.Axis();
        const out: EntityInfo = { kind: 'face', surface: 'cylinder', area, radius: cy.Radius(), axis: takeXyz(ax.Direction()), axisOrigin: takeXyz(ax.Location()) };
        cy.delete(); ax.delete();
        return out;
      }
      return { kind: 'face', surface: type.replace('GeomAbs_', '').toLowerCase(), area };
    } finally { ad.delete(); face.delete(); }
  }
  const sh = subShape(oc, s, 'TopAbs_EDGE', index);
  if (!sh) throw new Error(`No edge ${index}`);
  const edge = oc.TopoDS.Edge(sh);
  sh.delete();
  const gp = new oc.GProp_GProps();
  oc.BRepGProp.LinearProperties(edge, gp, false, false);
  const length = gp.Mass(); gp.delete();
  const ad = new oc.BRepAdaptor_Curve(edge);
  const type = String(ad.GetType());
  try {
    if (type.endsWith('Line')) return { kind: 'edge', curve: 'line', length, start: takeXyz(ad.Value(ad.FirstParameter())), end: takeXyz(ad.Value(ad.LastParameter())) };
    if (type.endsWith('Circle')) { const c = ad.Circle(); const out: EntityInfo = { kind: 'edge', curve: 'circle', length, radius: c.Radius(), center: takeXyz(c.Location()) }; c.delete(); return out; }
    return { kind: 'edge', curve: type.replace('GeomAbs_', '').toLowerCase(), length };
  } finally { ad.delete(); edge.delete(); }
}

/** Exact minimum distance between two sub-shapes (faces/edges/vertices). */
export function minDistance(oc: OC, s: TopoDS_Shape, a: { kind: 'face' | 'edge'; index: number }, b: { kind: 'face' | 'edge'; index: number }): { distance: number; p1: [number, number, number]; p2: [number, number, number] } {
  const get = (r: typeof a) => subShape(oc, s, r.kind === 'face' ? 'TopAbs_FACE' : 'TopAbs_EDGE', r.index);
  const sa = get(a), sb = get(b);
  const pr = new oc.Message_ProgressRange();
  let d: any = null;
  try {
    if (!sa || !sb) throw new Error('Entity not found');
    d = new oc.BRepExtrema_DistShapeShape(sa, sb, (oc as any).Extrema_ExtFlag?.Extrema_ExtFlag_MINMAX, (oc as any).Extrema_ExtAlgo?.Extrema_ExtAlgo_Grad, pr);
    if (!d.IsDone()) throw new Error('Distance computation failed');
    return { distance: d.Value(), p1: takeXyz(d.PointOnShape1(1)), p2: takeXyz(d.PointOnShape2(1)) };
  } finally { free(d, pr, sa, sb); }
}
