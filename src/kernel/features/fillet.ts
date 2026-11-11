/**
 * Fillet (constant, variable, face) and chamfer (equal distance, two
 * distances, distance-angle). Exact rolling-ball blends from OCCT
 * (BRepFilletAPI_MakeFillet / MakeChamfer). Like pro CAD, a fillet on one
 * edge propagates along tangent-continuous edges.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { FilletFeature, ChamferFeature, FaceRef, EdgeRef } from '../../core/featureTypes';
import { type Named, track, addTags, listOf, edgeFaceMap, resolveEdge, resolveFace, nameShape } from '../naming';
import { type FeatureContext, type FeatureResult, needBody, posLength, A, L, sub, add, scale, dot, cross, norm } from './index';
import { free, freeAll, takeXyz } from '../mem';
import { checkDone, isValid, countSolids, exactVolume } from '../regen';
import type { Vec3 } from '../../core/model';

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
  if (f.kind === 'fullRound') return fullRound(ctx, f, body);
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

// ------------------------------------------------------------------ full round

const unit = (v: Vec3): Vec3 => scale(v, 1 / norm(v));
const ANG_TOL = 1e-9; // parallel sides: |n1 + n2| below this (radians, about)

/** Plane of a face (point, outward unit normal), or null when the face is not flat. */
function facePlane(oc: any, face: TopoDS_Shape): { p: Vec3; n: Vec3 } | null {
  const fc = oc.TopoDS.Face(face);
  const ad = new oc.BRepAdaptor_Surface(fc, true);
  try {
    const t = ad.GetType();
    if (!(t === oc.GeomAbs_SurfaceType?.GeomAbs_Plane || String(t).includes('Plane'))) return null;
    const pl = ad.Plane(), ax = pl.Axis(), loc = ax.Location(), d = ax.Direction();
    const p = takeXyz(loc) as Vec3;
    let n = takeXyz(d) as Vec3;
    free(d, loc, ax, pl);
    const rev = face.Orientation() === oc.TopAbs_Orientation?.TopAbs_REVERSED || String(face.Orientation()).includes('REVERSED');
    if (rev) n = scale(n, -1);
    return { p, n: unit(n) };
  } finally { free(ad, fc); }
}

/** Range of a shape along the axis `d` through `o` (exact box in a frame whose Z is d). */
function rangeAlong(oc: any, s: TopoDS_Shape, o: Vec3, d: Vec3, x: Vec3): [number, number] {
  const objs: { delete(): void }[] = [];
  try {
    const ax3 = new oc.gp_Ax3(new oc.gp_Pnt(...o), new oc.gp_Dir(...d), new oc.gp_Dir(...x)); objs.push(ax3);
    const tr = new oc.gp_Trsf(); objs.push(tr);
    tr.SetTransformation(ax3);
    const mk = new oc.BRepBuilderAPI_Transform(s, tr, true, false); objs.push(mk);
    const moved = mk.Shape(); objs.push(moved);
    const bb = new oc.Bnd_Box(); objs.push(bb);
    oc.BRepBndLib.AddOptimal(moved, bb, false, false);
    const lo = bb.CornerMin(), hi = bb.CornerMax(); objs.push(lo, hi);
    return [lo.Z(), hi.Z()];
  } finally { freeAll(objs); }
}

/**
 * Full round fillet: the center face F is replaced by a round of radius w/2 tangent to F and to the
 * two flat, parallel side faces S1 and S2 (w = distance between them). Built exactly: the round is a
 * circular cylinder along the direction where F meets the sides, and the corners above it are cut
 * away with one boolean. The cut must only change F, the sides and the faces next to F; if it would
 * touch anything else the feature is refused rather than cutting into other geometry.
 */
function fullRound(ctx: FeatureContext, f: FilletFeature, body: Named): FeatureResult {
  const { oc } = ctx;
  const O = oc as any;
  const one = (r: FaceRef[] | undefined, what: string) => {
    if (!r?.length) throw new Error(`Full round fillet: pick the ${what}`);
    if (r.length !== 1) throw new Error(`Full round fillet: the ${what} must be exactly one face`);
    return resolveFace(oc, body, r[0]);
  };
  const i1 = one(f.faces, 'side face 1'), i2 = one(f.faces2, 'side face 2'), ic = one(f.faces3, 'center face');
  if (new Set([i1, i2, ic]).size < 3) throw new Error('Full round fillet: side face 1, side face 2 and the center face must be three different faces');
  const s1 = facePlane(O, body.faces[i1]), s2 = facePlane(O, body.faces[i2]), fc = facePlane(O, body.faces[ic]);
  if (!s1 || !s2) throw new Error('Full round fillet: both side faces must be flat (this kernel builds full rounds between flat, parallel faces)');
  if (!fc) throw new Error('Full round fillet: the center face must be flat');
  if (norm(add(s1.n, s2.n)) > ANG_TOL * 10) throw new Error('Full round fillet: the two side faces must be parallel and face away from each other (for sides that are not parallel, use a variable-radius fillet)');
  // The center face must meet both sides along an edge.
  const ef = edgeFaceMap(oc, body);
  let adj: number[] = [];
  try {
    const touches = (a: number, b: number) => ef.faces.some((fs) => fs.includes(a) && fs.includes(b) && a !== b);
    if (!touches(ic, i1) || !touches(ic, i2)) throw new Error('Full round fillet: the center face must share an edge with each side face');
    adj = [...new Set(ef.faces.filter((fs) => fs.includes(ic)).flat())].filter((i) => i !== ic);
  } finally { freeAll(ef.edges); }

  // Frame: A across the width (outward of S1), B "up" out of F in the cross-section, D along the round.
  const Aax = s1.n;
  const w = dot(sub(s1.p, s2.p), Aax);
  if (!(w > 0)) throw new Error('Full round fillet: side face 1 and side face 2 face the wrong way for a wall between them');
  const R = w / 2;
  const nfA = dot(fc.n, Aax);
  if (Math.abs(nfA) > 1 - 1e-9) throw new Error('Full round fillet: the center face is parallel to the side faces');
  const Bax = unit(sub(fc.n, scale(Aax, nfA)));
  const Dax = unit(cross(Aax, Bax));
  const nfB = dot(fc.n, Bax);
  if (!(nfB > 1e-6)) throw new Error('Full round fillet: the center face must face away from the material between the sides');
  // Origin on the mid-plane, in F's cross-section; F: nfA*a + nfB*b = hf.
  const mid = sub(s1.p, scale(Aax, R));
  const hf = dot(fc.n, sub(fc.p, mid));
  const bc = (hf - R) / nfB; // center height: R from F
  const cornerB = (a: number) => (hf - nfA * a) / nfB;
  const top = Math.max(cornerB(R), cornerB(-R)) + R;
  const M = R; // how far the cut reaches past the sides and above F (outside the wall)
  const [t0, t1] = rangeAlong(O, body.faces[ic], mid, Dax, Aax);
  if (!(t1 - t0 > 1e-9)) throw new Error('Full round fillet: the center face has no length');
  const P = (a: number, b: number, t: number): Vec3 => add(mid, add(scale(Aax, a), add(scale(Bax, b), scale(Dax, t))));

  const objs: { delete(): void }[] = [];
  const g = <T extends { delete(): void }>(x: T) => { objs.push(x); return x; };
  try {
    // Tangent points on the sides must lie on the side faces (else the wall is too short for the round).
    const onFace = (fi: number, p: Vec3) => {
      const v = g(new O.BRepBuilderAPI_MakeVertex(g(new O.gp_Pnt(...p))));
      const vx = g(v.Vertex());
      const pr = g(new O.Message_ProgressRange());
      const ds = g(new O.BRepExtrema_DistShapeShape(body.faces[fi], vx, O.Extrema_ExtFlag?.Extrema_ExtFlag_MIN, O.Extrema_ExtAlgo?.Extrema_ExtAlgo_Grad, pr));
      return ds.IsDone() && ds.Value() <= 1e-7 * Math.max(1, w);
    };
    const tm = (t0 + t1) / 2;
    if (!onFace(i1, P(R, bc, tm)) || !onFace(i2, P(-R, bc, tm))) {
      throw new Error(`Full round fillet: the side faces are not tall enough for a round of radius ${+R.toFixed(6)} mm (half the ${+w.toFixed(6)} mm width): they must reach at least that far below the center face`);
    }
    // Cross-section of the cut: above the round's center line, outside the round.
    const pts = [P(R + M, bc, t0), P(R + M, top, t0), P(-R - M, top, t0), P(-R - M, bc, t0), P(-R, bc, t0), P(R, bc, t0)];
    const mw = g(new O.BRepBuilderAPI_MakeWire());
    const addEdge = (mk: any) => { g(mk); if (!mk.IsDone()) throw new Error('Full round fillet: could not build the round'); const e = mk.Edge(); mw.Add(e); e.delete(); };
    for (let k = 0; k < 4; k++) addEdge(new O.BRepBuilderAPI_MakeEdge(g(new O.gp_Pnt(...pts[k])), g(new O.gp_Pnt(...pts[k + 1]))));
    // Arc from T2 (a = -R) over the top (b = bc + R) to T1 (a = +R): circle in the plane t = t0 around (0, bc).
    const circ = g(new O.gp_Circ(g(new O.gp_Ax2(g(new O.gp_Pnt(...P(0, bc, t0))), g(new O.gp_Dir(...Dax)), g(new O.gp_Dir(...Aax)))), R));
    addEdge(new O.BRepBuilderAPI_MakeEdge(circ, 0, Math.PI)); // 0 = +A (T1), pi/2 = +B (top), pi = -A (T2)
    addEdge(new O.BRepBuilderAPI_MakeEdge(g(new O.gp_Pnt(...pts[5])), g(new O.gp_Pnt(...pts[0]))));
    if (!mw.IsDone()) throw new Error('Full round fillet: could not build the round');
    const wire = g(mw.Wire());
    const mf = g(new O.BRepBuilderAPI_MakeFace(wire, true));
    if (!mf.IsDone()) throw new Error('Full round fillet: could not build the round');
    const face = g(mf.Face());
    const prism = g(new O.BRepPrimAPI_MakePrism(face, g(new O.gp_Vec(...scale(Dax, t1 - t0))), false, true));
    const waste = nameShape(oc, prism.Shape(), (wf) => {
      const ad = new O.BRepAdaptor_Surface(O.TopoDS.Face(wf), true);
      const t = ad.GetType(); ad.delete();
      const cyl = t === O.GeomAbs_SurfaceType?.GeomAbs_Cylinder || String(t).includes('Cylinder');
      return cyl ? [`${f.id}:blend`] : [`${f.id}:cut`];
    });
    objs.push({ delete: () => { freeAll(waste.faces); waste.shape.delete(); } });

    const pr = g(new O.Message_ProgressRange());
    const op = g(new O.BRepAlgoAPI_Cut(body.shape, waste.shape, pr));
    checkDone(op, 'Full round fillet');
    // Only the center face, the sides and the faces next to the center face may change.
    const allowed = new Set([ic, i1, i2, ...adj]);
    const touched = body.faces.map((bf, i) => {
      if (allowed.has(i)) return false;
      let del = false; try { del = !!op.IsDeleted(bf); } catch { /* none */ }
      const mods = listOf(oc, op.Modified(bf)); const m = mods.length > 0; freeAll(mods);
      return del || m;
    }).filter(Boolean).length;
    if (touched) throw new Error(`Full round fillet: the round would cut into ${touched} other face${touched > 1 ? 's' : ''} of the part (something stands between the side faces above the round). Use a constant fillet instead.`);
    op.SimplifyResult(true, true, 1e-9);
    const result = op.Shape();
    if (countSolids(oc, result) !== countSolids(oc, body.shape) || !isValid(oc, result)) {
      result.delete();
      throw new Error('Full round fillet failed in the geometry kernel (the result was not one valid solid)');
    }
    const vBefore = exactVolume(oc, body.shape), vAfter = exactVolume(oc, result);
    if (!(vAfter < vBefore)) { result.delete(); throw new Error('Full round fillet failed in the geometry kernel (nothing was removed)'); }
    const out = track(oc, op, [body, waste], result, `${f.id}:corner`);
    // Name the round itself: the cylinder of radius R on our axis (the cut's history does not always
    // carry the tool's face through to a reversed copy in the result).
    const axisPt = P(0, bc, 0);
    const rounds = out.faces.filter((rf) => {
      const ad = new O.BRepAdaptor_Surface(O.TopoDS.Face(rf), true);
      try {
        const t = ad.GetType();
        if (!(t === O.GeomAbs_SurfaceType?.GeomAbs_Cylinder || String(t).includes('Cylinder'))) return false;
        const cy = ad.Cylinder(), ax = cy.Axis(), lp = ax.Location(), ld = ax.Direction();
        const r = cy.Radius(), o = takeXyz(lp) as Vec3, dd = takeXyz(ld) as Vec3;
        free(ld, lp, ax, cy);
        const off = sub(o, axisPt);
        const across = norm(sub(off, scale(Dax, dot(off, Dax))));
        return Math.abs(r - R) <= 1e-9 * Math.max(1, R) && Math.abs(Math.abs(dot(dd, Dax)) - 1) < 1e-9 && across <= 1e-9 * Math.max(1, R);
      } finally { ad.delete(); }
    });
    addTags(oc, out, rounds, `${f.id}:blend`);
    return { body: out };
  } finally { freeAll(objs.reverse()); }
}
