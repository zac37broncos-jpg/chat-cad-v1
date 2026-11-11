/**
 * Full round fillet (precision stress test bug 5): R = half the width on both top edges of a 10 mm
 * bar failed in the kernel. kind 'fullRound' replaces the center face by a round tangent to it and
 * to both side faces. Checked against hand-calculated volumes and the round's exact radius and axis.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities } from '../src/core/model';
import { regenerate, isValid, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo, listSubShapes } from '../src/kernel/query';
import { faceRefFrom, type Topology } from '../src/kernel/naming';
import * as F from '../src/core/featureCommands';
import type { Vec3 } from '../src/core/featureTypes';
import { executeTool, type ExecutorContext } from '../src/ai/executor';

let oc: OC;
beforeAll(async () => { oc = await init(); });
const near = (p: Vec3, q: Vec3, tol = 1e-6) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
function faceAt(t: Topology, p: Vec3) {
  const i = t.faces.findIndex((f) => near(f.center, p));
  if (i < 0) throw new Error(`no face at ${p}: ${t.faces.map((f) => f.center.map((x) => +x.toFixed(3))).join(' | ')}`);
  return faceRefFrom(t, i);
}
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
function regen(st: DocumentStore, ok = true) {
  const r = regenerate(oc, st.state);
  const bad = r.status.filter((s) => !s.ok);
  if (ok && bad.length) throw new Error(JSON.stringify(bad));
  return { r, bad };
}
const cylinders = (shape: any) => listSubShapes(oc, shape, 'TopAbs_FACE').map((_, i) => entityInfo(oc, shape, 'face', i) as any).filter((f) => f.surface === 'cylinder');

/** Bar L (x) by W (y) by H (z), mm, corner at the origin. */
function bar(L: number, W: number, H: number) {
  const st = new DocumentStore();
  st.setUnits('mm');
  st.setParameter('W', `${W} mm`);
  const sk = st.addSketch('XY', rectangleEntities(0, 0, `${L} mm`, 'W'));
  st.addExtrude(sk, `${H} mm`);
  return st;
}

describe('full round fillet', () => {
  it('the stress-test bar: R5 round on a 10 mm wide bar, exact volume, radius and axis', () => {
    const L = 50, W = 10, H = 20, R = W / 2;
    const st = bar(L, W, H);
    const t = regen(st).r.topology!;
    F.addFullRoundFillet(st, { faces: [faceAt(t, [L / 2, 0, H / 2])], faces2: [faceAt(t, [L / 2, W, H / 2])], faces3: [faceAt(t, [L / 2, W / 2, H])] });
    const { r } = regen(st);
    expect(isValid(oc, r.shape!)).toBe(true);
    const m = massProperties(oc, r.shape!);
    expect(rel(m.volume, L * (W * (H - R) + Math.PI * R * R / 2))).toBeLessThan(1e-9);
    expect(m.bboxMax[2]).toBeCloseTo(H, 9);
    const c = cylinders(r.shape!);
    expect(c.length).toBe(1);
    expect(c[0].radius).toBeCloseTo(R, 10);
    // Axis along X at y = W/2, z = H - R.
    expect(c[0].axisOrigin[1]).toBeCloseTo(W / 2, 9);
    expect(c[0].axisOrigin[2]).toBeCloseTo(H - R, 9);
    // 6 faces: bottom, 2 ends, 2 sides, the round. No top face left.
    expect(listSubShapes(oc, r.shape!, 'TopAbs_FACE').length).toBe(6);
    // The round's face is named after the feature.
    expect(r.topology!.faces.some((f) => f.tags.some((x) => /:blend$/.test(x)))).toBe(true);
  });

  it('follows the width when a parameter changes (R = W/2 again)', () => {
    const L = 30, H = 15;
    const st = bar(L, 6, H);
    const t = regen(st).r.topology!;
    F.addFullRoundFillet(st, { faces: [faceAt(t, [L / 2, 0, H / 2])], faces2: [faceAt(t, [L / 2, 6, H / 2])], faces3: [faceAt(t, [L / 2, 3, H])] });
    st.setParameter('W', '8 mm');
    const { r } = regen(st);
    const R = 4;
    expect(rel(massProperties(oc, r.shape!).volume, L * (8 * (H - R) + Math.PI * R * R / 2))).toBeLessThan(1e-9);
    expect(cylinders(r.shape!)[0].radius).toBeCloseTo(R, 10);
  });

  it('a rib running into a wall: the round stops at the wall and leaves the wall alone', () => {
    // Base 40 x 10 x 5, wall at x 30..40 up to z 30, rib 4 wide (y 3..7) from x 0 to 30 up to z 20.
    const st = new DocumentStore();
    st.setUnits('mm');
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, '40 mm', '10 mm')), '5 mm');
    st.addExtrude(st.addSketch('XY', rectangleEntities('30 mm', 0, '10 mm', '10 mm')), '30 mm');
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, '3 mm', '30 mm', '4 mm')), '20 mm');
    const { r: r0 } = regen(st);
    const v0 = massProperties(oc, r0.shape!).volume;
    const t = r0.topology!;
    F.addFullRoundFillet(st, { faces: [faceAt(t, [15, 3, 12.5])], faces2: [faceAt(t, [15, 7, 12.5])], faces3: [faceAt(t, [15, 5, 20])] });
    const { r } = regen(st);
    expect(isValid(oc, r.shape!)).toBe(true);
    const R = 2;
    expect(rel(massProperties(oc, r.shape!).volume, v0 - 30 * (4 * R - Math.PI * R * R / 2))).toBeLessThan(1e-9);
    expect(massProperties(oc, r.shape!).bboxMax[2]).toBeCloseTo(30, 9);
  });

  it('refuses side faces that are not parallel, with a message', () => {
    const st = bar(20, 10, 10);
    const t = regen(st).r.topology!;
    F.addFullRoundFillet(st, { faces: [faceAt(t, [10, 0, 5])], faces2: [faceAt(t, [20, 5, 5])], faces3: [faceAt(t, [10, 5, 10])] });
    const { bad } = regen(st, false);
    expect(bad.length).toBe(1);
    expect(bad[0].message).toMatch(/parallel/);
  });

  it('refuses side faces too short for the round', () => {
    // 10 wide, only 3 tall: a R5 round needs the sides at least 5 below the top.
    const st = bar(20, 10, 3);
    const t = regen(st).r.topology!;
    F.addFullRoundFillet(st, { faces: [faceAt(t, [10, 0, 1.5])], faces2: [faceAt(t, [10, 10, 1.5])], faces3: [faceAt(t, [10, 5, 3])] });
    const { bad } = regen(st, false);
    expect(bad[0].message).toMatch(/not tall enough/);
  });

  it('refuses rather than cutting into other geometry above the round', () => {
    // Bar 30 x 10 x 10; a post at its end (x 30..34, up to z 16) with an arm reaching back over the
    // bar (x 20..34, z 14..16). The round's cut would reach up to z 15 there: refused, part unchanged.
    const st = new DocumentStore();
    st.setUnits('mm');
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, '30 mm', '10 mm')), '10 mm');
    st.addExtrude(st.addSketch('XY', rectangleEntities('30 mm', 0, '4 mm', '10 mm')), '16 mm');
    st.addExtrude(st.addSketch('XY', rectangleEntities('20 mm', 0, '14 mm', '10 mm'), { offset: '14 mm' } as any), '2 mm');
    const { r: r0 } = regen(st);
    const t = r0.topology!;
    // The bar's sides are merged with the post's (one face each side).
    const side = (y: number) => faceRefFrom(t, t.faces.findIndex((f) => f.surface === 'plane' && Math.abs(f.center[1] - y) < 1e-9 && f.center[2] < 10));
    F.addFullRoundFillet(st, { faces: [side(0)], faces2: [side(10)], faces3: [faceAt(t, [15, 5, 10])] });
    const { bad } = regen(st, false);
    expect(bad.length).toBe(1);
    expect(bad[0].message).toMatch(/would cut into/);
  });

  it('works from the chat tool (no radius), and in an inch part', async () => {
    const st = new DocumentStore();
    const c: ExecutorContext = {
      store: st,
      regen: async () => { const r = regenerate(oc, st.state); return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, topology: r.topology, refGeometry: r.refGeometry, ms: 0 } as any; },
      selection: () => [],
      info: async () => null as any,
    };
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', entities: [{ type: 'rectangle', x: 0, y: 0, width: 2, height: 0.25 }] });
    await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: 0.5 });
    const t = regen(st).r.topology!;
    const IN = 25.4;
    const idx = (p: Vec3) => t.faces.findIndex((f) => near(f.center, p.map((x) => x * IN) as Vec3));
    const res: any = await executeTool(c, 'fillet', { kind: 'fullRound', faces: [{ index: idx([1, 0, 0.25]) }], faces2: [{ index: idx([1, 0.25, 0.25]) }], faces3: [{ index: idx([1, 0.125, 0.5]) }] });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    const R = 0.125;
    expect(parseFloat(res.part.volume)).toBeCloseTo(2 * (0.25 * (0.5 - R) + Math.PI * R * R / 2), 6);
    // Other kinds still need a radius.
    await expect(executeTool(c, 'fillet', { edges: [{ index: 0 }] })).rejects.toThrow(/radius is required/);
  });
});
