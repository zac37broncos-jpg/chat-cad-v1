/**
 * Linear pattern, circular pattern and mirror. A pattern re-applies its seed
 * features' tool bodies (the solid each seed added or cut), moved by exact
 * rigid transforms, so a patterned hole is a real hole. With `body: true` the
 * whole solid is copied and joined instead.
 *
 * Copied faces are named "<seed tag>#<pattern id>.<instance>", so a later
 * fillet can still pick an edge of one particular copy.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { LinearPatternFeature, CircularPatternFeature, MirrorFeature, Vec3 } from '../../core/featureTypes';
import { trackedBool, checkedBool, BooleanFailure } from '../regen';
import { type Named, indexShapes } from '../naming';
import { own } from '../mem';
import { type FeatureContext, type FeatureResult, type CapturedTool, needBody, axisOf, planeOf, posLength, count, A, scale, add, unit } from './index';

/** Copy a named shape with a transform; copied faces get tag suffix `#suffix`. */
export function transformNamed(ctx: FeatureContext, n: Named, trsf: any, suffix: string): Named {
  const { oc } = ctx;
  const t = new oc.BRepBuilderAPI_Transform(n.shape, trsf, true, false);
  const shape = t.Shape();
  const { list, map } = indexShapes(oc, shape, 'TopAbs_FACE');
  const tags: string[][] = list.map(() => []);
  n.faces.forEach((f, k) => {
    const m = t.ModifiedShape(f);
    const i = map.FindIndex(m);
    m.delete();
    if (i > 0) tags[i - 1].push(...n.tags[k].map((x) => `${x}#${suffix}`));
  });
  map.delete(); t.delete();
  return own({ shape, faces: list, tags: tags.map((x, i) => (x.length ? x : [`${suffix}:face${i}`])) });
}

function seeds(ctx: FeatureContext, ids: string[], what: string): CapturedTool[] {
  if (!ids.length) throw new Error(`Pick the features to ${what}, or choose the whole body`);
  return ids.map((id) => {
    const t = ctx.tools.get(id);
    const f = ctx.doc.features.find((x) => x.id === id);
    if (!f) throw new Error(`Seed feature ${id} is missing`);
    if (!t) {
      if (['fillet', 'chamfer', 'shell', 'draft'].includes(f.type)) throw new Error(`${f.name}: patterning ${f.type}s is not supported yet; pattern the feature it is applied to and add the ${f.type} after the pattern`);
      throw new Error(`${f.name} cannot be patterned (it is suppressed, failed, or comes after this pattern)`);
    }
    return t;
  });
}

const nameOf = (ctx: FeatureContext, fid: string) => ctx.doc.features.find((x) => x.id === fid)?.name ?? 'This feature';

/** Apply copies of seeds (or of the body) for each transform. */
function applyCopies(ctx: FeatureContext, fid: string, ids: string[], bodyMode: boolean | undefined, transforms: { trsf: any; label: string }[], what: string): FeatureResult {
  const { oc } = ctx;
  let body = needBody(ctx, what);
  if (bodyMode) {
    const original = body;
    for (const { trsf, label } of transforms) body = checkedBool(oc, 'fuse', body, transformNamed(ctx, original, trsf, `${fid}.${label}`), fid, nameOf(ctx, fid));
    return { body };
  }
  const list = seeds(ctx, ids, what.toLowerCase());
  // Union of all copies of all seeds, per operation, for the preview tool body.
  let preview: Named | null = null;
  for (const { trsf, label } of transforms) {
    for (const s of list) {
      const kind = s.op === 'cut' ? 'cut' : 'fuse';
      let copy = transformNamed(ctx, s.tool, trsf, `${fid}.${label}`);
      try {
        body = checkedBool(oc, kind, body, copy, fid, nameOf(ctx, fid));
      } catch (e) {
        // The kernel failed on this copy: try the seed built another way (same shape, other seam).
        if (!(e instanceof BooleanFailure) || !s.variants) throw e;
        let done = false;
        for (const v of s.variants(ctx.gc)) {
          const c2 = transformNamed(ctx, v, trsf, `${fid}.${label}`);
          try { body = checkedBool(oc, kind, body, c2, fid, nameOf(ctx, fid)); copy = c2; done = true; break; } catch (e2) { if (!(e2 instanceof BooleanFailure)) throw e2; }
        }
        if (!done) throw new Error(`${(e as Error).message}. Try moving or resizing the copied feature slightly.`);
      }
      preview = preview ? trackedBool(oc, 'fuse', preview, copy, fid) : copy;
    }
  }
  if (preview) ctx.tools.set(fid, { tool: preview, op: list.every((s) => s.op === 'cut') ? 'cut' : 'add' });
  return { body, tool: preview };
}

function translation(ctx: FeatureContext, v: Vec3): any {
  const { oc } = ctx;
  const t = new oc.gp_Trsf();
  t.SetTranslation(ctx.gc.t(new oc.gp_Vec(...v)));
  return ctx.gc.t(t);
}

export function linearPatternFeature(ctx: FeatureContext, f: LinearPatternFeature): FeatureResult {
  const d1 = unit(scale(axisOf(ctx, f.dir1).d, f.flip1 ? -1 : 1), 'Direction 1');
  const n1 = count(ctx, f.count1, 'Direction 1 instance count');
  const s1 = n1 > 1 ? posLength(ctx, f.spacing1, 'Direction 1 spacing') : 0;
  let d2: Vec3 = [0, 0, 0], n2 = 1, s2 = 0;
  if (f.dir2) {
    d2 = unit(scale(axisOf(ctx, f.dir2).d, f.flip2 ? -1 : 1), 'Direction 2');
    n2 = count(ctx, f.count2 ?? 1, 'Direction 2 instance count');
    s2 = n2 > 1 ? posLength(ctx, f.spacing2, 'Direction 2 spacing') : 0;
  }
  if (n1 * n2 > 1000) throw new Error('A pattern is limited to 1000 instances');
  const skip = new Set((f.skip ?? []).map(([i, j]) => `${i},${j}`));
  const transforms: { trsf: any; label: string }[] = [];
  for (let j = 0; j < n2; j++) for (let i = 0; i < n1; i++) {
    if ((i === 0 && j === 0) || skip.has(`${i},${j}`)) continue;
    transforms.push({ trsf: translation(ctx, add(scale(d1, i * s1), scale(d2, j * s2))), label: `${i}.${j}` });
  }
  if (!transforms.length) return { body: needBody(ctx, 'A pattern'), message: 'Only the seed instance: nothing to copy' };
  return applyCopies(ctx, f.id, f.features, f.body, transforms, 'A linear pattern');
}

export function circularPatternFeature(ctx: FeatureContext, f: CircularPatternFeature): FeatureResult {
  const { oc, gc } = ctx;
  const ax = axisOf(ctx, f.axis);
  const d = unit(scale(ax.d, f.flip ? -1 : 1), 'Axis');
  const n = count(ctx, f.count, 'Instance count');
  const ang = A(ctx, f.angle);
  if (!(Math.abs(ang) > 1e-12)) throw new Error('Pattern angle must not be zero');
  const full = Math.abs(Math.abs(ang) - 2 * Math.PI) < 1e-9;
  const step = f.equalSpacing === false ? ang : full ? ang / n : n > 1 ? ang / (n - 1) : 0;
  if (n > 1000) throw new Error('A pattern is limited to 1000 instances');
  const skip = new Set(f.skip ?? []);
  const ax1 = gc.t(new oc.gp_Ax1(gc.t(new oc.gp_Pnt(...ax.o)), gc.t(new oc.gp_Dir(...d))));
  const transforms: { trsf: any; label: string }[] = [];
  for (let i = 1; i < n; i++) {
    if (skip.has(i)) continue;
    const t = gc.t(new oc.gp_Trsf());
    t.SetRotation(ax1, step * i);
    transforms.push({ trsf: t, label: String(i) });
  }
  if (!transforms.length) return { body: needBody(ctx, 'A pattern'), message: 'Only the seed instance: nothing to copy' };
  return applyCopies(ctx, f.id, f.features, f.body, transforms, 'A circular pattern');
}

export function mirrorFeature(ctx: FeatureContext, f: MirrorFeature): FeatureResult {
  const { oc, gc } = ctx;
  const fr = planeOf(ctx, f.plane);
  const t = gc.t(new oc.gp_Trsf());
  t.SetMirror(gc.t(new oc.gp_Ax2(gc.t(new oc.gp_Pnt(...fr.o)), gc.t(new oc.gp_Dir(...fr.n)))));
  return applyCopies(ctx, f.id, f.features, f.body, [{ trsf: t, label: 'm' }], 'A mirror');
}

export type { TopoDS_Shape };
