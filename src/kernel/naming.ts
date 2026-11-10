/**
 * Topological naming: give every face of the solid stable names ("tags") that
 * come from the feature history, and keep them through every operation using
 * OpenCascade's own modification history (Generated / Modified / IsDeleted).
 *
 *   extrude ex_1 of a rectangle -> side faces "ex_1:side:<line id>", caps
 *   "ex_1:start" / "ex_1:end". A later cut that only trims the top face keeps
 *   its tag; a fillet face is "fi_2:fillet:<n>"; a patterned copy of a face
 *   gets "<tag>#<pattern id>.<instance>".
 *
 * Features store FaceRef / EdgeRef (tags + a tie-break point), and this module
 * resolves them against the current solid. A reference that no longer
 * resolves is reported as an error, never guessed. Design note:
 * docs/TOPOLOGICAL_NAMING.md.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { OC } from './regen';
import type { FaceRef, EdgeRef, Vec3 } from '../core/featureTypes';
import { own, free, freeAll, takeXyz } from './mem';

/** A solid plus the tags of each of its faces (parallel arrays, explorer order = listSubShapes order). */
export interface Named { shape: TopoDS_Shape; faces: TopoDS_Shape[]; tags: string[][] }

/** Anything with OCCT's history interface. */
export interface HistoryOp {
  Modified(s: TopoDS_Shape): unknown;
  Generated?(s: TopoDS_Shape): unknown;
  IsDeleted?(s: TopoDS_Shape): boolean;
}

/** The shapes of an OCCT list (e.g. a history's Modified/Generated). The caller deletes them. */
export function listOf(oc: OC, l: unknown): TopoDS_Shape[] {
  const c = new oc.NCollection_List_TopoDS_Shape(l as any);
  const out: TopoDS_Shape[] = [];
  while (c.Extent() > 0) { out.push(c.First()); c.RemoveFirst(); }
  c.delete();
  // The history getters return a new list object each call: free it too.
  free(l as any);
  return out;
}

type Kind = 'TopAbs_FACE' | 'TopAbs_EDGE' | 'TopAbs_VERTEX' | 'TopAbs_SOLID' | 'TopAbs_WIRE';

/**
 * Index of shapes for lookups. The WASM build has no shape hashing, so this
 * is a linear IsSame scan (fine for part-sized models; listSubShapes is the
 * same). FindIndex is 1-based with 0 = absent, like OCCT's IndexedMap.
 */
export class ShapeIndex {
  constructor(readonly list: TopoDS_Shape[]) {}
  FindIndex(s: TopoDS_Shape): number {
    for (let i = 0; i < this.list.length; i++) if (this.list[i].IsSame(s)) return i + 1;
    return 0;
  }
  delete() { /* nothing to free */ }
}

/** Unique sub-shapes in explorer order (= listSubShapes order), plus a lookup index. The caller owns the list. */
export function indexShapes(oc: OC, s: TopoDS_Shape, kind: Kind): { list: TopoDS_Shape[]; map: ShapeIndex } {
  const list: TopoDS_Shape[] = [];
  const ex = new oc.TopExp_Explorer(s, (oc.TopAbs_ShapeEnum as any)[kind], (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const c = ex.Current();
    if (!list.some((o) => o.IsSame(c))) list.push(c); else c.delete();
  }
  ex.delete();
  return { list, map: new ShapeIndex(list) };
}

/** Tag a fresh shape's faces with a callback. */
export function nameShape(oc: OC, shape: TopoDS_Shape, tagOf: (face: TopoDS_Shape, i: number) => string[]): Named {
  const { list } = indexShapes(oc, shape, 'TopAbs_FACE');
  return own({ shape, faces: list, tags: list.map((f, i) => tagOf(f, i)) });
}

/**
 * Carry tags from `inputs` to `result` through `op`'s history. Faces that the
 * op generated from an input face (shell inner walls) get `generated(tag)`.
 * Faces left without any tag get `fallback` so every face has a name.
 */
export function track(oc: OC, op: HistoryOp, inputs: Named[], result: TopoDS_Shape, fallback: string, generated?: (tag: string) => string): Named {
  const { list, map } = indexShapes(oc, result, 'TopAbs_FACE');
  const tags: string[][] = list.map(() => []);
  const add = (s: TopoDS_Shape, t: string[]) => {
    const i = map.FindIndex(s);
    if (i > 0) for (const x of t) if (!tags[i - 1].includes(x)) tags[i - 1].push(x);
  };
  for (const inp of inputs) {
    inp.faces.forEach((f, k) => {
      const t = inp.tags[k];
      let deleted = false;
      try { deleted = !!op.IsDeleted?.(f); } catch { /* op without IsDeleted */ }
      if (!deleted) {
        const mods = listOf(oc, op.Modified(f));
        if (mods.length === 0) add(f, t); else for (const m of mods) add(m, t);
        freeAll(mods);
      }
      if (generated && op.Generated) {
        let gens: TopoDS_Shape[] = [];
        try { gens = listOf(oc, op.Generated(f)); } catch { /* none */ }
        for (const g of gens) add(g, t.map(generated));
        freeAll(gens);
      }
    });
  }
  map.delete();
  tags.forEach((t, i) => { if (t.length === 0) t.push(`${fallback}:face${i}`); });
  return own({ shape: result, faces: list, tags });
}

/** Add tags to specific result faces (e.g. faces an op generated from edges). */
export function addTags(oc: OC, n: Named, faces: TopoDS_Shape[], tag: string) {
  for (const f of faces) {
    const i = n.faces.findIndex((x) => x.IsSame(f));
    if (i < 0) continue;
    // Replace a fallback name ("<feature>:face<n>") by the real one.
    n.tags[i] = n.tags[i].filter((t) => !/:face\d+$/.test(t));
    if (!n.tags[i].includes(tag)) n.tags[i].push(tag);
  }
  void oc;
}

// ------------------------------------------------------------------ topology summary

/** `normal` (outward, unit) is set for planar faces. */
export interface TopoFace { tags: string[]; center: Vec3; surface: string; normal?: Vec3 }
/** ends: the edge's two vertices (equal for a closed edge such as a full circle). */
export interface TopoEdge { faces: number[]; mid: Vec3; curve: string; length: number; ends?: [Vec3, Vec3] }
/** Face / edge names and adjacency of the current solid, sent to the UI and the AI. Indices match listSubShapes. */
export interface Topology { faces: TopoFace[]; edges: TopoEdge[] }

/** For each edge (listSubShapes order): indices of the faces that contain it. The caller deletes `edges`. */
export function edgeFaceMap(oc: OC, n: Named): { edges: TopoDS_Shape[]; faces: number[][] } {
  const { list, map } = indexShapes(oc, n.shape, 'TopAbs_EDGE');
  const faces: number[][] = list.map(() => []);
  n.faces.forEach((f, fi) => {
    const ex = new oc.TopExp_Explorer(f, (oc.TopAbs_ShapeEnum as any).TopAbs_EDGE, (oc.TopAbs_ShapeEnum as any).TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
      const c = ex.Current();
      const i = map.FindIndex(c);
      c.delete();
      if (i > 0 && !faces[i - 1].includes(fi)) faces[i - 1].push(fi);
    }
    ex.delete();
  });
  map.delete();
  return { edges: list, faces };
}

export function edgeMid(oc: OC, e: TopoDS_Shape): Vec3 {
  const edge = oc.TopoDS.Edge(e);
  const ad = new oc.BRepAdaptor_Curve(edge);
  const p = takeXyz(ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2));
  ad.delete(); edge.delete();
  return p;
}

function faceCenter(oc: OC, f: TopoDS_Shape): Vec3 {
  const gp = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(f, gp, 1e-9, false);
  const c = takeXyz(gp.CentreOfMass());
  gp.delete();
  return c;
}

export function topology(oc: OC, n: Named): Topology {
  const faces: TopoFace[] = n.faces.map((f, i) => {
    const face = oc.TopoDS.Face(f);
    const ad = new oc.BRepAdaptor_Surface(face, true);
    const surface = String(ad.GetType()).replace('GeomAbs_', '').toLowerCase();
    let normal: Vec3 | undefined;
    if (surface === 'plane') {
      const pl = ad.Plane(), ax = pl.Axis();
      normal = takeXyz(ax.Direction());
      pl.delete(); ax.delete();
      if (String(f.Orientation()).includes('REVERSED')) normal = [-normal[0], -normal[1], -normal[2]];
      normal = normal.map((c) => (Math.abs(c) < 1e-12 ? 0 : c)) as Vec3;
    }
    ad.delete(); face.delete();
    return { tags: n.tags[i], center: faceCenter(oc, f), surface, ...(normal ? { normal } : {}) };
  });
  const ef = edgeFaceMap(oc, n);
  try {
    const edges: TopoEdge[] = ef.edges.map((e, i) => {
      const edge = oc.TopoDS.Edge(e);
      const ad = new oc.BRepAdaptor_Curve(edge);
      const curve = String(ad.GetType()).replace('GeomAbs_', '').toLowerCase();
      const ends: [Vec3, Vec3] = [takeXyz(ad.Value(ad.FirstParameter())), takeXyz(ad.Value(ad.LastParameter()))];
      ad.delete(); edge.delete();
      const gp = new oc.GProp_GProps();
      oc.BRepGProp.LinearProperties(e, gp, false, false);
      const length = gp.Mass(); gp.delete();
      return { faces: ef.faces[i], mid: edgeMid(oc, e), curve, length, ends };
    });
    return { faces, edges };
  } finally { freeAll(ef.edges); }
}

/** Persistent references from current indices (UI selection / AI picks). Pure: works from a Topology. */
export function faceRefFrom(t: Topology, index: number, at?: Vec3): FaceRef {
  const f = t.faces[index];
  if (!f) throw new Error(`No face ${index}`);
  return { tags: [...f.tags], at: at ?? f.center };
}

export function edgeRefFrom(t: Topology, index: number): EdgeRef {
  const e = t.edges[index];
  if (!e) throw new Error(`No edge ${index}`);
  const [fa, fb] = [e.faces[0], e.faces[1] ?? e.faces[0]];
  return { a: [...t.faces[fa].tags], b: [...t.faces[fb].tags], at: e.mid };
}

// ------------------------------------------------------------------ resolution

const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length;

function distTo(oc: OC, p: Vec3, s: TopoDS_Shape): number {
  const pt = new oc.gp_Pnt(p[0], p[1], p[2]);
  const v = new oc.BRepBuilderAPI_MakeVertex(pt);
  const vx = v.Vertex();
  const pr = new oc.Message_ProgressRange();
  const d = new oc.BRepExtrema_DistShapeShape(vx, s, (oc as any).Extrema_ExtFlag?.Extrema_ExtFlag_MIN, (oc as any).Extrema_ExtAlgo?.Extrema_ExtAlgo_Grad, pr);
  const out = d.IsDone() ? d.Value() : Infinity;
  free(d, pr, vx, v, pt);
  return out;
}

function pickBest<T>(oc: OC, cands: { item: T; score: number; shape: TopoDS_Shape }[], at: Vec3 | undefined, what: string): T {
  if (cands.length === 0) throw new Error(`${what} no longer exists in the model. Re-select it.`);
  const top = Math.max(...cands.map((c) => c.score));
  const best = cands.filter((c) => c.score === top);
  if (best.length === 1) return best[0].item;
  if (!at) throw new Error(`${what} is ambiguous (${best.length} matches). Re-select it.`);
  let min = Infinity; let pick = best[0];
  for (const c of best) { const d = distTo(oc, at, c.shape); if (d < min) { min = d; pick = c; } }
  return pick.item;
}

const describe = (tags: string[]) => tags[0] ?? '?';

/** Index of the face a FaceRef names. */
export function resolveFace(oc: OC, n: Named, ref: FaceRef): number {
  const cands = n.faces.map((f, i) => ({ item: i, score: overlap(n.tags[i], ref.tags), shape: f })).filter((c) => c.score > 0);
  return pickBest(oc, cands, ref.at, `Face "${describe(ref.tags)}"`);
}

/**
 * Index (listSubShapes order) of the edge an EdgeRef names, plus the edge itself.
 * With `ef` given the edge is one of `ef.edges` (deleted with them); without,
 * the caller owns and deletes the returned edge.
 */
export function resolveEdge(oc: OC, n: Named, ref: EdgeRef, given?: ReturnType<typeof edgeFaceMap>): { index: number; edge: TopoDS_Shape; faces: number[] } {
  const ef = given ?? edgeFaceMap(oc, n);
  let keep: TopoDS_Shape | null = null;
  try {
    const r = resolveEdgeIn(oc, n, ref, ef);
    keep = r.edge;
    return r;
  } finally { if (!given) freeAll(ef.edges.filter((e) => e !== keep)); }
}

function resolveEdgeIn(oc: OC, n: Named, ref: EdgeRef, ef: ReturnType<typeof edgeFaceMap>): { index: number; edge: TopoDS_Shape; faces: number[] } {
  const cands: { item: number; score: number; shape: TopoDS_Shape }[] = [];
  ef.edges.forEach((e, i) => {
    const fs = ef.faces[i];
    const f1 = fs[0], f2 = fs[1] ?? fs[0];
    if (f1 === undefined) return;
    const pair = (x: number, y: number) => {
      const oa = overlap(n.tags[x], ref.a), ob = overlap(n.tags[y], ref.b);
      return oa > 0 && ob > 0 ? oa + ob : 0;
    };
    const s1 = pair(f1, f2), s2 = pair(f2, f1);
    const score = Math.max(s1, s2);
    if (score > 0) cands.push({ item: i, score, shape: e });
  });
  const index = pickBest(oc, cands, ref.at, `Edge between "${describe(ref.a)}" and "${describe(ref.b)}"`);
  return { index, edge: ef.edges[index], faces: ef.faces[index] };
}

/** Human-readable face name for the AI and the UI, from its first tag. */
export function describeTag(tag: string, nameOf: (featureId: string) => string | undefined): string {
  const [fid, kind, ...rest] = tag.split(':');
  const fname = nameOf(fid.split('#')[0]) ?? fid;
  const inst = tag.includes('#') ? ` (pattern copy ${tag.split('#')[1]})` : '';
  switch (kind) {
    case 'start': return `${fname} start face${inst}`;
    case 'end': return `${fname} end face${inst}`;
    case 'side': return `${fname} side face from sketch entity ${rest.join(':').split('#')[0]}${inst}`;
    default: return `${fname} ${kind ?? 'face'}${rest.length ? ' ' + rest.join(':') : ''}${inst}`;
  }
}
