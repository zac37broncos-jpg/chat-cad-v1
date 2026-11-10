/**
 * Shell (hollow out a solid with a wall thickness, optionally removing faces)
 * and draft (tilt faces about a neutral plane for mould release).
 */
import type { ShellFeature, DraftFeature } from '../../core/featureTypes';
import { trackedBool } from '../regen';
import { type Named, track, resolveFace } from '../naming';
import { type FeatureContext, type FeatureResult, needBody, posLength, planeOf, A, scale } from './index';
import { free } from '../mem';

export function shellFeature(ctx: FeatureContext, f: ShellFeature): FeatureResult {
  const { oc } = ctx;
  const body = needBody(ctx, 'A shell');
  const t = posLength(ctx, f.thickness, 'Thickness');
  const offset = f.outward ? t : -t;
  const pr = new oc.Message_ProgressRange();
  const mode = (oc as any).BRepOffset_Mode.BRepOffset_Skin;
  const join = (oc as any).GeomAbs_JoinType.GeomAbs_Arc;
  try {
    if (!f.faces.length) {
      // Closed hollow part: subtract (or add) an exact offset of the whole solid.
      const off = new oc.BRepOffsetAPI_MakeOffsetShape();
      let offNamed: Named;
      try {
        off.PerformByJoin(body.shape, offset, 1e-6, mode, false, false, join, false, pr);
        if (!off.IsDone()) throw new Error('Shell failed: the thickness is probably larger than a fillet radius or a thin wall of the part');
        // Each offset face is the inner wall of the face it came from.
        offNamed = track(oc, off, [body], off.Shape(), `${f.id}:inner`);
        offNamed.tags = offNamed.tags.map((ts) => ts.map((x) => `${f.id}:inner:${x}`));
      } finally { off.delete(); }
      return { body: f.outward ? trackedBool(oc, 'cut', offNamed, body, f.id) : trackedBool(oc, 'cut', body, offNamed, f.id) };
    }
    const picked = f.faces.map((r) => body.faces[resolveFace(oc, body, r)]);
    const faces = new oc.NCollection_List_TopoDS_Shape();
    for (const x of picked) free(faces.Append(x));
    const mk = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      mk.MakeThickSolidByJoin(body.shape, faces, offset, 1e-6, mode, false, false, join, false, pr);
      if (!mk.IsDone()) throw new Error('Shell failed: the thickness is probably larger than a fillet radius or a thin wall of the part');
      return { body: track(oc, mk, [body], mk.Shape(), `${f.id}:wall`, (tag) => `${f.id}:inner:${tag}`) };
    } finally { mk.delete(); faces.delete(); }
  } finally { pr.delete(); }
}

export function draftFeature(ctx: FeatureContext, f: DraftFeature): FeatureResult {
  const { oc, gc } = ctx;
  const body = needBody(ctx, 'A draft');
  if (!f.faces.length) throw new Error('Pick the faces to draft');
  const ang = A(ctx, f.angle);
  if (!(ang > 0 && ang < Math.PI / 2)) throw new Error('Draft angle must be between 0 and 90 degrees');
  const fr = planeOf(ctx, f.neutral);
  // Pull direction = neutral plane normal (flip reverses). Faces taper so the part gets smaller along the pull.
  const pull = f.flip ? scale(fr.n, -1) : fr.n;
  const pln = gc.t(new oc.gp_Pln(gc.t(new oc.gp_Pnt(...fr.o)), gc.t(new oc.gp_Dir(...fr.n))));
  const dir = gc.t(new oc.gp_Dir(...pull));
  const mk = new oc.BRepOffsetAPI_DraftAngle(body.shape);
  try {
    for (const r of f.faces) {
      const fi = resolveFace(oc, body, r);
      const face = oc.TopoDS.Face(body.faces[fi]);
      mk.Add(face, dir, ang, pln, true);
      face.delete();
      if (!mk.AddDone()) throw new Error(`Cannot draft face "${r.tags[0]}" (faces parallel to the pull direction and touching the neutral plane can be drafted)`);
    }
    const pr = new oc.Message_ProgressRange();
    try { mk.Build(pr); } finally { pr.delete(); }
    if (!mk.IsDone()) throw new Error('Draft failed in the geometry kernel');
    return { body: track(oc, mk, [body], mk.Shape(), `${f.id}:face`) };
  } finally { mk.delete(); }
}
