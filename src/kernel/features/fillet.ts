/**
 * Fillet (constant, variable, face) and chamfer (equal distance, two
 * distances, distance-angle). Exact rolling-ball blends from OCCT
 * (BRepFilletAPI_MakeFillet / MakeChamfer). Like pro CAD, a fillet on one
 * edge propagates along tangent-continuous edges.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { FilletFeature, ChamferFeature, FaceRef, EdgeRef } from '../../core/featureTypes';
import { type Named, track, addTags, listOf, edgeFaceMap, resolveEdge, resolveFace } from '../naming';
import { type FeatureContext, type FeatureResult, needBody, posLength, A, L } from './index';
import { freeAll } from '../mem';

interface PickedEdge { index: number; edge: TopoDS_Shape; faces: number[]; ref?: number; tag: string }

/** Edges named by refs plus every (non-seam) edge of the given faces, without duplicates. */
function collectEdges(ctx: FeatureContext, body: Named, fid: string, edges: EdgeRef[], faces: FaceRef[] = []): { picked: PickedEdge[]; ef: ReturnType<typeof edgeFaceMap> } {
  const { oc } = ctx;
  const ef = edgeFaceMap(oc, body);
  const picked: PickedEdge[] = [];
  const has = (i: number) => picked.some((p) => p.index === i);
  try {
    edges.forEach((r, k) => {
      const e = resolveEdge(oc, body, r, ef);
      if (!has(e.index)) picked.push({ ...e, ref: k, tag: `${fid}:blend:${k}` });
    });
    faces.forEach((r, k) => {
      const fi = resolveFace(oc, body, r);
      ef.faces.forEach((fs, i) => {
        if (!fs.includes(fi) || fs.length < 2 || fs[0] === fs[1] || has(i)) return;
        picked.push({ index: i, edge: ef.edges[i], faces: fs, tag: `${fid}:blend:f${k}` });
      });
    });
  } catch (e) { freeAll(ef.edges); throw e; }
  return { picked, ef };
}

/** Build the blend and name its faces. Deletes `mk`. */
function finish(ctx: FeatureContext, mk: any, body: Named, fid: string, picked: PickedEdge[], what: string): FeatureResult {
  const { oc } = ctx;
  try {
    const pr = new oc.Message_ProgressRange();
    try { mk.Build(pr); } catch { /* reported below */ }
    pr.delete();
    if (!mk.IsDone()) {
      throw new Error(`${what} failed in the geometry kernel. The size is probably too large for the faces next to an edge, or the edges meet in a way that cannot be blended.`);
    }
    const out = track(oc, mk, [body], mk.Shape(), `${fid}:corner`);
    for (const p of picked) {
      let gen: TopoDS_Shape[] = [];
      try { gen = listOf(oc, mk.Generated(p.edge)); } catch { /* none */ }
      addTags(oc, out, gen, p.tag);
      freeAll(gen);
    }
    return { body: out };
  } finally { mk.delete(); }
}

export function filletFeature(ctx: FeatureContext, f: FilletFeature): FeatureResult {
  const { oc } = ctx;
  const body = needBody(ctx, 'A fillet');
  const r1 = posLength(ctx, f.radius, 'Radius');
  let picked: PickedEdge[];
  let ef: ReturnType<typeof edgeFaceMap>;
  if (f.kind === 'face') {
    // Face fillet: blend where face set A meets face set B.
    if (!f.faces?.length || !f.faces2?.length) throw new Error('A face fillet needs face set 1 and face set 2');
    const A1 = f.faces.map((r) => resolveFace(oc, body, r));
    const B1 = f.faces2.map((r) => resolveFace(oc, body, r));
    ef = edgeFaceMap(oc, body);
    picked = [];
    ef.faces.forEach((fs, i) => {
      if (fs.length < 2 || fs[0] === fs[1]) return;
      if ((A1.includes(fs[0]) && B1.includes(fs[1])) || (A1.includes(fs[1]) && B1.includes(fs[0]))) picked.push({ index: i, edge: ef.edges[i], faces: fs, tag: `${f.id}:blend` });
    });
  } else {
    ({ picked, ef } = collectEdges(ctx, body, f.id, f.edges, f.faces));
  }
  try {
    if (f.kind === 'face' && !picked.length) throw new Error('Face set 1 and face set 2 do not touch. This kernel can only blend faces that share edges.');
    if (!picked.length) throw new Error('Select at least one edge or face to fillet');
    const mk = new oc.BRepFilletAPI_MakeFillet(body.shape, (oc as any).ChFi3d_FilletShape.ChFi3d_Rational);
    const edges: TopoDS_Shape[] = [];
    try {
      if (f.kind === 'variable') {
        const r2 = posLength(ctx, f.radius2, 'End radius');
        for (const p of picked) {
          const e = oc.TopoDS.Edge(p.edge);
          edges.push(e);
          mk.Add(r1, r2, e);
          if (f.startAt) {
            // Radius 1 goes at the contour end nearest startAt.
            const ic = mk.Contour(e);
            const d = (v: TopoDS_Shape) => { const vx = oc.TopoDS.Vertex(v); const q = oc.BRep_Tool.Pnt(vx); const s = f.startAt!; const out = Math.hypot(q.X() - s[0], q.Y() - s[1], q.Z() - s[2]); q.delete(); vx.delete(); v.delete(); return out; };
            if (d(mk.LastVertex(ic)) < d(mk.FirstVertex(ic))) { mk.Remove(e); mk.Add(r2, r1, e); }
          }
        }
      } else {
        for (const p of picked) { const e = oc.TopoDS.Edge(p.edge); edges.push(e); mk.Add(r1, e); }
      }
    } catch (e) { mk.delete(); throw e; } finally { freeAll(edges); }
    return finish(ctx, mk, body, f.id, picked, 'Fillet');
  } finally { freeAll(ef.edges); }
}

export function chamferFeature(ctx: FeatureContext, f: ChamferFeature): FeatureResult {
  const body = needBody(ctx, 'A chamfer');
  const d1 = posLength(ctx, f.distance, 'Distance');
  const { picked, ef } = collectEdges(ctx, body, f.id, f.edges, f.faces);
  try { return chamferOn(ctx, f, body, d1, picked); } finally { freeAll(ef.edges); }
}

function chamferOn(ctx: FeatureContext, f: ChamferFeature, body: Named, d1: number, picked: PickedEdge[]): FeatureResult {
  const { oc } = ctx;
  if (!picked.length) throw new Error('Select at least one edge or face to chamfer');
  const mk = new oc.BRepFilletAPI_MakeChamfer(body.shape);
  // Distance 1 is measured on face `a` of the edge reference (or on the picked face).
  const faceA = (p: PickedEdge): TopoDS_Shape => {
    let fi: number;
    if (p.ref !== undefined) {
      const ref = f.edges[p.ref];
      const ov = (i: number, t: string[]) => body.tags[i].filter((x) => t.includes(x)).length;
      fi = ov(p.faces[0], ref.a) >= ov(p.faces[1], ref.a) ? p.faces[0] : p.faces[1];
    } else {
      fi = p.faces.find((i) => f.faces?.some((r) => body.tags[i].some((t) => r.tags.includes(t)))) ?? p.faces[0];
    }
    if (f.flip) fi = fi === p.faces[0] ? p.faces[1] : p.faces[0];
    return oc.TopoDS.Face(body.faces[fi]);
  };
  const temps: TopoDS_Shape[] = [];
  try {
    for (const p of picked) {
      const e = oc.TopoDS.Edge(p.edge);
      temps.push(e);
      if (f.kind === 'equal') mk.Add(d1, e);
      else if (f.kind === 'distances') { const fa = faceA(p); temps.push(fa); mk.Add(d1, posLength(ctx, f.distance2, 'Distance 2'), e, fa); }
      else {
        const ang = f.angle !== undefined ? A(ctx, f.angle) : NaN;
        if (!(ang > 0 && ang < Math.PI / 2)) throw new Error('Chamfer angle must be between 0 and 90 degrees');
        const fa = faceA(p); temps.push(fa);
        mk.AddDA(d1, ang, e, fa);
      }
    }
  } catch (e) { mk.delete(); throw e; } finally { freeAll(temps); }
  void L;
  return finish(ctx, mk, body, f.id, picked, 'Chamfer');
}
