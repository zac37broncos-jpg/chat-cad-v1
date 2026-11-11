/**
 * Thin-wall warning in the part check (precision stress test bug 6, plan item A3): a 0.05 mm cup
 * wall was reported as "good part" and PrusaSlicer then printed nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import type { OC } from '../src/kernel/regen';
import { partQuality } from '../src/kernel/quality';
import { wallThickness } from '../src/kernel/walls';
import { free } from '../src/kernel/mem';

let oc: OC;
beforeAll(async () => { oc = await init(); });
const O = () => oc as any;

function box(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
  const p = new (O().gp_Pnt)(x, y, z);
  const mk = new (O().BRepPrimAPI_MakeBox)(p, dx, dy, dz);
  const s = mk.Shape();
  free(mk, p);
  return s;
}
function cylinder(r: number, h: number) {
  const p = new (O().gp_Pnt)(0, 0, 0), d = new (O().gp_Dir)(0, 0, 1), ax = new (O().gp_Ax2)(p, d);
  const mk = new (O().BRepPrimAPI_MakeCylinder)(ax, r, h);
  const s = mk.Shape();
  free(mk, ax, d, p);
  return s;
}
function cut(a: any, b: any) {
  const pr = new (O().Message_ProgressRange)();
  const mk = new (O().BRepAlgoAPI_Cut)(a, b, pr);
  const s = mk.Shape();
  free(mk, pr);
  return s;
}
/** An open-top cup: outer w x w x h, walls and floor `t` thick. */
const cup = (w: number, h: number, t: number) => cut(box(0, 0, 0, w, w, h), box(t, t, t, w - 2 * t, w - 2 * t, h));
const wallWarning = (q: ReturnType<typeof partQuality>) => q.warnings.find((w) => /wall/i.test(w));

describe('wall thickness (ray cast on the mesh)', () => {
  it('measures a hand-made unit cube as 1 everywhere', () => {
    const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
    // 12 triangles, outward by the right-hand rule
    const tri = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    const w = wallThickness(pos, tri, [0.5, 2])!;
    expect(w.rays).toBe(12);
    expect(w.min).toBeCloseTo(1, 9);
    expect(w.p1).toBeCloseTo(1, 9);
    expect(w.median).toBeCloseTo(1, 9);
    expect(w.below).toEqual([0, 1]);
  });
});

describe('part check: walls too thin to print', () => {
  it('a 0.05 mm cup wall (the stress-test part) is no longer a plain "good part"', () => {
    const s = cup(20, 10, 0.05);
    const q = partQuality(oc, s);
    expect(q.problems).toEqual([]);
    expect(q.walls!.thinnest).toBeCloseTo(0.05, 3);
    expect(wallWarning(q)).toMatch(/^Walls too thin to print: 0\.050 mm thin/);
    expect(wallWarning(q)).toMatch(/0\.4 mm FDM nozzle/);
    s.delete();
  });

  it('a 0.6 mm plate gets the softer thin-wall warning; 1 mm and a solid block get none', () => {
    const thin = box(0, 0, 0, 30, 20, 0.6);
    const q = partQuality(oc, thin);
    expect(q.walls!.thinnest).toBeCloseTo(0.6, 6);
    expect(wallWarning(q)).toMatch(/^Thin walls: down to 0\.600 mm/);
    thin.delete();
    for (const s of [box(0, 0, 0, 30, 20, 1), box(0, 0, 0, 20, 20, 10), cylinder(10, 20), cup(20, 10, 1.2)]) {
      const ok = partQuality(oc, s);
      expect(ok.walls!.thinnest).toBeGreaterThanOrEqual(0.8);
      expect(wallWarning(ok)).toBeUndefined();
      s.delete();
    }
  });

  it('the cup with 1.2 mm walls reads 1.2 mm', () => {
    const s = cup(20, 10, 1.2);
    const q = partQuality(oc, s);
    expect(q.walls!.thinnest).toBeCloseTo(1.2, 6);
    s.delete();
  });

  it('a curved 0.7 mm wall on a 200 mm tube is measured on a fine mesh, not the coarse quick one', () => {
    const s = cut(cylinder(100, 30), cylinder(99.3, 30));
    const q = partQuality(oc, s);
    // Quick mesh for a 200 mm part is 0.1 mm off the surface: it could read 0.5 or 0.9 mm.
    expect(Math.abs(q.walls!.thinnest - 0.7)).toBeLessThan(0.04);
    expect(wallWarning(q)).toMatch(/^Thin walls: down to 0\.(69|70|71)\d mm/);
    s.delete();
  });

  it('parts too small for the quick mesh still get the warning, from their size', () => {
    const micro = box(0, 0, 0, 0.0001, 0.00005, 0.000025);
    const q = partQuality(oc, micro);
    expect(q.walls!.thinnest).toBeCloseTo(0.000025, 12);
    expect(wallWarning(q)).toMatch(/^Walls too thin to print: 0\.000025 mm thin \(the whole part is that thin\)/);
    micro.delete();
    const sheet = box(0, 0, 0, 10, 10, 0.05);
    const q2 = partQuality(oc, sheet);
    expect(q2.walls!.thinnest).toBeCloseTo(0.05, 6);
    expect(wallWarning(q2)).toMatch(/^Walls too thin to print: 0\.050 mm/);
    sheet.delete();
  });
});
