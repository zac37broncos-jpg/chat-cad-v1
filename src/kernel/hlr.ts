/**
 * Drawing views from the exact B-rep: OpenCascade hidden-line removal
 * (HLRBRep_Algo, the exact algorithm, not the polygonal one), section cuts,
 * and the anchors drawings attach dimensions and centerlines to.
 *
 * Output curves are analytic wherever OCCT gives an analytic edge (lines,
 * circles, ellipses), so exported drawings are exact. Free-form edges are
 * sampled to 0.0005 mm chordal error.
 *
 * Gotcha: these bindings choose C++ overloads by argument COUNT, so every
 * call below passes the full argument list for the overload meant.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { OC } from './regen';
import { listSubShapes, curvePoints } from './query';
import { free, freeAll, takeXyz } from './mem';
import { removeCovered, TAU, type Curve2, type V2, type V3 } from '../drawing/geom2d';
import type { ViewFrame } from '../drawing/views';

export interface ViewRequest {
  id: string;
  frame: ViewFrame;
  /** Section view: cut with the plane through `point` whose normal is frame.z; material on the viewer's side is removed. */
  section?: { point: V3 };
  /** Include smooth (tangent) edges. */
  tangent?: boolean;
}

export interface ViewGeometry {
  id: string;
  visible: Curve2[];
  hidden: Curve2[];
  tangent: Curve2[];
  /** Section view only: boundaries of the cut faces in view coordinates, as polylines (for hatching). */
  section: V2[][];
  /** Section view only: extra anchors created by the cut (vertices on the cut face). */
  sectionVertices: V3[];
  error?: string;
}

export interface ModelAnchors {
  vertices: { i: number; p: V3 }[];
  /** Circular edges; `full` = closed circle (vs. an arc). */
  circles: { i: number; c: V3; r: number; n: V3; full: boolean }[];
  lines: { i: number; a: V3; b: V3 }[];
  /** Cylindrical faces grouped by axis + radius. `full` = closed 360° (holes, bosses, shafts). */
  axes: { c: V3; dir: V3; r: number; v0: number; v1: number; full: boolean }[];
  bboxMin: V3;
  bboxMax: V3;
}

export interface DrawingGeometryResponse { model: ModelAnchors | null; views: ViewGeometry[] }

/** X, Y, Z of a point or direction, which is then deleted (getters return new objects). */
const xyz = (p: { X(): number; Y(): number; Z(): number; delete(): void }): V3 => takeXyz(p);

/** Tight chordal tolerance (mm) for sampling free-form projected edges. */
const SPLINE_TOL = 0.0005;

/** The edges of an HLR result compound as 2D curves. Deletes the compound. */
function compoundEdges(oc: OC, c: TopoDS_Shape | null | undefined): Curve2[] {
  if (!c) return [];
  if (c.IsNull()) { c.delete(); return []; }
  const out: Curve2[] = [];
  const ex = new oc.TopExp_Explorer(c, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const cur = ex.Current(), edge = oc.TopoDS.Edge(cur);
    try {
      const cv = edgeToCurve(oc, edge);
      if (cv) out.push(cv);
    } finally { edge.delete(); cur.delete(); }
  }
  ex.delete(); c.delete();
  return out;
}

/** Convert a projected (z = 0) HLR edge to an exact 2D curve. */
export function edgeToCurve(oc: OC, edge: any): Curve2 | null {
  const ad = new oc.BRepAdaptor_Curve(edge);
  try {
    const type = String(ad.GetType());
    const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    if (!(u1 > u0)) return null;
    if (type.endsWith('Line')) {
      const a = ad.Value(u0), b = ad.Value(u1);
      const cv: Curve2 = { k: 'line', a: [a.X(), a.Y()], b: [b.X(), b.Y()] };
      a.delete(); b.delete();
      return cv;
    }
    if (type.endsWith('Circle') || type.endsWith('Ellipse')) {
      const isCircle = type.endsWith('Circle');
      const g = isCircle ? ad.Circle() : ad.Ellipse();
      const pos = g.Position(); // gp_Ax2 of the conic
      const c = xyz(pos.Location()), xd = xyz(pos.XDirection()), n = xyz(pos.Direction());
      pos.delete();
      const phi = Math.atan2(xd[1], xd[0]);
      const ccw = n[2] > 0;
      // Map the curve parameter to a ccw angle measured from the conic's X axis.
      let t0 = ccw ? u0 : -u1, t1 = ccw ? u1 : -u0;
      if (t1 - t0 > TAU) t1 = t0 + TAU;
      try {
        if (isCircle) {
          const r = (g as any).Radius();
          return { k: 'arc', c: [c[0], c[1]], r, a0: phi + t0, a1: phi + t1 };
        }
        return { k: 'ellipse', c: [c[0], c[1]], rx: (g as any).MajorRadius(), ry: (g as any).MinorRadius(), rot: phi, t0, t1 };
      } finally { g.delete(); }
    }
    const pts: V2[] = curvePoints(oc, ad, u0, u1, 0.02, SPLINE_TOL).map((p) => [p[0], p[1]]);
    return pts.length >= 2 ? { k: 'poly', pts } : null;
  } finally { ad.delete(); }
}

function hlr(oc: OC, shape: TopoDS_Shape, f: ViewFrame, tangent: boolean): { visible: Curve2[]; hidden: Curve2[]; tangent: Curve2[] } {
  const algo = new oc.HLRBRep_Algo();
  const p0 = new oc.gp_Pnt(0, 0, 0), dz = new oc.gp_Dir(f.z[0], f.z[1], f.z[2]), dx = new oc.gp_Dir(f.x[0], f.x[1], f.x[2]);
  const ax = new oc.gp_Ax2(p0, dz, dx);
  const proj = new oc.HLRAlgo_Projector(ax);
  let h: any = null;
  let visible: Curve2[], hiddenRaw: Curve2[], tangentRaw: Curve2[];
  try {
    algo.Add(shape, 0);
    algo.Projector(proj);
    algo.Update();
    algo.Hide();
    h = new oc.HLRBRep_HLRToShape(algo);
    visible = [...compoundEdges(oc, h.VCompound()), ...compoundEdges(oc, h.OutLineVCompound())];
    hiddenRaw = [...compoundEdges(oc, h.HCompound()), ...compoundEdges(oc, h.OutLineHCompound())];
    tangentRaw = tangent ? compoundEdges(oc, h.Rg1LineVCompound()) : [];
  } finally { free(h, proj, ax, p0, dz, dx); free(algo); }
  // Line precedence (ASME Y14.2 / ISO 128): visible over hidden; drop duplicates.
  const vis = removeCovered(visible, []);
  const tan = removeCovered(tangentRaw, vis);
  const hid = removeCovered(hiddenRaw, [...vis, ...tan]);
  return { visible: vis, hidden: hid, tangent: tan };
}

function bbox(oc: OC, s: TopoDS_Shape): { min: V3; max: V3 } {
  const b = new oc.Bnd_Box();
  oc.BRepBndLib.AddOptimal(s, b, false, false);
  const out = { min: xyz(b.CornerMin()), max: xyz(b.CornerMax()) };
  b.delete();
  return out;
}

/** Keep the part of `shape` on the far side of the plane (point, normal z), as seen by a viewer on +z. */
function sectionCut(oc: OC, shape: TopoDS_Shape, f: ViewFrame, point: V3): TopoDS_Shape {
  const bb = bbox(oc, shape);
  const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
  const mid: V3 = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
  const L = diag + Math.hypot(mid[0] - point[0], mid[1] - point[1], mid[2] - point[2]) + 10;
  // Box corner = point - L·x - L·y - 2L·z, spanning 2L in x, y, z of the frame: covers the far half-space.
  const o: V3 = [0, 1, 2].map((k) => point[k] - L * f.x[k] - L * f.y[k] - 2 * L * f.z[k]) as V3;
  const p0 = new oc.gp_Pnt(o[0], o[1], o[2]), dz = new oc.gp_Dir(f.z[0], f.z[1], f.z[2]), dx = new oc.gp_Dir(f.x[0], f.x[1], f.x[2]);
  const ax = new oc.gp_Ax2(p0, dz, dx);
  const mb = new oc.BRepPrimAPI_MakeBox(ax, 2 * L, 2 * L, 2 * L);
  const box = mb.Shape();
  const pr = new oc.Message_ProgressRange();
  const common = new oc.BRepAlgoAPI_Common(shape, box, pr);
  try {
    if (!common.IsDone()) throw new Error('Section cut failed');
    const r = common.Shape();
    if (r.IsNull()) { r.delete(); throw new Error('Section plane misses the part'); }
    return r;
  } finally { free(common, pr, box, mb, ax, p0, dz, dx); }
}

/** Faces of the cut lying on the section plane, as projected polylines. */
function sectionFaces(oc: OC, cutShape: TopoDS_Shape, f: ViewFrame, point: V3): { chains: V2[][]; vertices: V3[] } {
  const chains: V2[][] = [];
  const vertices: V3[] = [];
  const planeD = f.z[0] * point[0] + f.z[1] * point[1] + f.z[2] * point[2];
  const faces = listSubShapes(oc, cutShape, 'TopAbs_FACE');
  try {
    for (const fs of faces) {
      const face = oc.TopoDS.Face(fs);
      try {
        const ad = new oc.BRepAdaptor_Surface(face, true);
        const isPlane = String(ad.GetType()).endsWith('Plane');
        let onPlane = false;
        if (isPlane) {
          const pl = ad.Plane(); const ax = pl.Axis(); const n = xyz(ax.Direction()); const lo = xyz(ax.Location());
          pl.delete(); ax.delete();
          const par = Math.abs(n[0] * f.z[0] + n[1] * f.z[1] + n[2] * f.z[2]);
          const d = lo[0] * f.z[0] + lo[1] * f.z[1] + lo[2] * f.z[2];
          // The plane location may be anywhere on the plane; compare distances along z.
          onPlane = par > 1 - 1e-9 && Math.abs(d - planeD) < 1e-6;
        }
        ad.delete();
        if (!onPlane) continue;
        const edges = listSubShapes(oc, face, 'TopAbs_EDGE');
        for (const es of edges) {
          const edge = oc.TopoDS.Edge(es);
          const ca = new oc.BRepAdaptor_Curve(edge);
          const pts: V2[] = curvePoints(oc, ca, ca.FirstParameter(), ca.LastParameter(), 0.02, 0.001)
            .map((p) => [p[0] * f.x[0] + p[1] * f.x[1] + p[2] * f.x[2], p[0] * f.y[0] + p[1] * f.y[1] + p[2] * f.y[2]]);
          ca.delete(); edge.delete();
          if (pts.length >= 2) chains.push(pts);
        }
        freeAll(edges);
        const verts = listSubShapes(oc, face, 'TopAbs_VERTEX');
        for (const vs of verts) vertices.push(vertexPoint(oc, vs));
        freeAll(verts);
      } finally { face.delete(); }
    }
  } finally { freeAll(faces); }
  return { chains, vertices };
}

/** Point of a vertex shape (the shape is not deleted). */
function vertexPoint(oc: OC, v: TopoDS_Shape): V3 {
  const vx = oc.TopoDS.Vertex(v);
  const p = xyz(oc.BRep_Tool.Pnt(vx));
  vx.delete();
  return p;
}

/** Vertices, circular / linear edges and cylinder axes of the solid (model coordinates, mm). */
export function modelAnchors(oc: OC, shape: TopoDS_Shape): ModelAnchors {
  const vertexList = listSubShapes(oc, shape, 'TopAbs_VERTEX');
  const vertices = vertexList.map((v, i) => ({ i, p: vertexPoint(oc, v) }));
  freeAll(vertexList);
  const circles: ModelAnchors['circles'] = [];
  const lines: ModelAnchors['lines'] = [];
  const edgeList = listSubShapes(oc, shape, 'TopAbs_EDGE');
  edgeList.forEach((es, i) => {
    const edge = oc.TopoDS.Edge(es);
    const ad = new oc.BRepAdaptor_Curve(edge);
    const type = String(ad.GetType());
    if (type.endsWith('Circle')) {
      const c = ad.Circle(); const ax = c.Axis();
      circles.push({ i, c: xyz(c.Location()), r: c.Radius(), n: xyz(ax.Direction()), full: ad.LastParameter() - ad.FirstParameter() >= TAU - 1e-9 });
      c.delete(); ax.delete();
    } else if (type.endsWith('Line')) {
      lines.push({ i, a: xyz(ad.Value(ad.FirstParameter())), b: xyz(ad.Value(ad.LastParameter())) });
    }
    ad.delete(); edge.delete();
  });
  freeAll(edgeList);
  // Cylinders grouped by axis line + radius.
  type Cyl = { c: V3; dir: V3; r: number; v0: number; v1: number; span: number };
  const cyls: Cyl[] = [];
  const faceList = listSubShapes(oc, shape, 'TopAbs_FACE');
  for (const fs of faceList) {
    const face = oc.TopoDS.Face(fs);
    const ad = new oc.BRepAdaptor_Surface(face, true);
    if (String(ad.GetType()).endsWith('Cylinder')) {
      const cy = ad.Cylinder(); const ax = cy.Axis();
      let dir = xyz(ax.Direction()); let c = xyz(ax.Location());
      ax.delete();
      const uv = oc.BRepTools.UVBounds(face, 0, 0, 0, 0);
      let v0 = uv.VMin, v1 = uv.VMax;
      // Canonical direction sign so coaxial faces group together.
      const flip = dir[2] < -1e-12 || (Math.abs(dir[2]) <= 1e-12 && (dir[1] < -1e-12 || (Math.abs(dir[1]) <= 1e-12 && dir[0] < 0)));
      if (flip) { dir = [-dir[0], -dir[1], -dir[2]]; [v0, v1] = [-v1, -v0]; }
      // Re-base on the point of the axis closest to the origin.
      const t = c[0] * dir[0] + c[1] * dir[1] + c[2] * dir[2];
      c = [c[0] - t * dir[0], c[1] - t * dir[1], c[2] - t * dir[2]];
      v0 += t; v1 += t;
      const span = Math.min(TAU, uv.UMax - uv.UMin);
      const r = cy.Radius();
      cy.delete();
      const same = cyls.find((k) => Math.abs(k.r - r) < 1e-6 && Math.hypot(k.c[0] - c[0], k.c[1] - c[1], k.c[2] - c[2]) < 1e-6
        && Math.abs(k.dir[0] * dir[0] + k.dir[1] * dir[1] + k.dir[2] * dir[2]) > 1 - 1e-9);
      if (same) {
        // Coaxial pieces: add the angular coverage only when they overlap axially (same hole split by a seam).
        if (v0 < same.v1 - 1e-9 && v1 > same.v0 + 1e-9) same.span += span;
        same.v0 = Math.min(same.v0, v0); same.v1 = Math.max(same.v1, v1);
      } else cyls.push({ c, dir, r, v0, v1, span });
    }
    ad.delete(); face.delete();
  }
  freeAll(faceList);
  const bb = bbox(oc, shape);
  return {
    vertices, circles, lines,
    axes: cyls.map((k) => ({ c: k.c, dir: k.dir, r: k.r, v0: k.v0, v1: k.v1, full: k.span >= TAU - 1e-6 })),
    bboxMin: bb.min, bboxMax: bb.max,
  };
}

/** Compute every requested view of `shape`. A failing view reports its error and does not stop the others. */
export function drawingGeometry(oc: OC, shape: TopoDS_Shape | null, views: ViewRequest[]): DrawingGeometryResponse {
  if (!shape) return { model: null, views: views.map((v) => ({ id: v.id, visible: [], hidden: [], tangent: [], section: [], sectionVertices: [], error: 'There is no solid to draw yet' })) };
  const model = modelAnchors(oc, shape);
  const out: ViewGeometry[] = [];
  for (const v of views) {
    try {
      if (v.section) {
        const cutShape = sectionCut(oc, shape, v.frame, v.section.point);
        try {
          const g = hlr(oc, cutShape, v.frame, !!v.tangent);
          const sf = sectionFaces(oc, cutShape, v.frame, v.section.point);
          out.push({ id: v.id, ...g, section: sf.chains, sectionVertices: sf.vertices });
        } finally { cutShape.delete(); }
      } else {
        out.push({ id: v.id, ...hlr(oc, shape, v.frame, !!v.tangent), section: [], sectionVertices: [] });
      }
    } catch (e) {
      out.push({ id: v.id, visible: [], hidden: [], tangent: [], section: [], sectionVertices: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { model, views: out };
}
