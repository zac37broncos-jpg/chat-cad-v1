/**
 * Extrude end conditions and options that match mainstream CAD's Extrude
 * Command panel: Up To Vertex, Up To Surface, Offset From Surface,
 * Through All - Both, From: Offset, Draft (inward / outward), Flip side to
 * cut. Every volume is checked against a hand calculation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, type SketchFeature } from '../src/core/model';
import { addRefPlane } from '../src/core/featureCommands';
import { regenerate, isValid, type OC } from '../src/kernel/regen';
import { massProperties } from '../src/kernel/query';

const IN = 25.4;
const IN3 = IN ** 3;
const REL = 1e-7;
let oc: OC;
beforeAll(async () => { oc = await init(); });

function build(st: DocumentStore) {
  const r = regenerate(oc, st.state);
  const bad = r.status.filter((s) => !s.ok);
  expect(bad).toEqual([]);
  expect(r.shape).not.toBeNull();
  expect(isValid(oc, r.shape!)).toBe(true);
  return { r, mp: massProperties(oc, r.shape!) };
}
const close = (v: number, exp: number) => expect(Math.abs(v - exp) / Math.abs(exp)).toBeLessThan(REL);

/** 2 x 2 block, height H (parameter), on the XY plane. Returns its extrude id and the sketch line ids. */
function block(st: DocumentStore, h: string | number = 1) {
  const ents = rectangleEntities(0, 0, 2, 2);
  const sk = st.addSketch('XY', ents);
  const ex = st.addExtrude(sk, h);
  return { ex, lines: ents.map((e) => e.id) };
}

describe('Extrude end conditions (mainstream CAD parity)', () => {
  it('Up To Vertex ends on the plane through the vertex, parallel to the sketch, and follows the part', () => {
    const st = new DocumentStore();
    st.setParameter('H', '1');
    const { ex, lines } = block(st, 'H');
    const sk2 = st.addSketch('XY', rectangleEntities(3, 0, 1, 1));
    // Vertex at a top corner of the block: an end of the edge between the top cap and a side.
    st.addExtrude(sk2, 0.1, { upTo: { kind: 'vertex', vertex: { edge: { a: [`${ex}:end`], b: [`${ex}:side:${lines[0]}`] }, at: [0, 0, IN] } } });
    let { mp } = build(st);
    close(mp.volume, (4 * 1 + 1 * 1) * IN3);
    st.setParameter('H', '1.75');
    ({ mp } = build(st));
    close(mp.volume, (4 * 1.75 + 1.75) * IN3);
  });

  it('Up To Vertex accepts a reference point and goes backward when the point is behind the sketch', () => {
    const st = new DocumentStore();
    const pt = st.addFeature({ type: 'refPoint', def: { kind: 'coords', p: { x: 5, y: 5, z: -0.6 } } } as any);
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1, { upTo: { kind: 'vertex', vertex: { refPoint: pt } } });
    const { mp } = build(st);
    close(mp.volume, 0.6 * IN3);
    expect(mp.bboxMin[2]).toBeCloseTo(-0.6 * IN, 9);
    expect(mp.bboxMax[2]).toBeCloseTo(0, 9);
  });

  it('Up To Surface on a parallel plane, Offset From Surface and Reverse offset', () => {
    const st = new DocumentStore();
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 1, 1));
    const ex = st.addExtrude(sk, 0.1, { upTo: { kind: 'surface', surface: { base: 'XY', offset: 1.5 } } });
    close(build(st).mp.volume, 1.5 * IN3);
    st.updateFeature(ex, { upTo: { kind: 'surface', surface: { base: 'XY', offset: 1.5 }, offset: 0.25 } });
    close(build(st).mp.volume, 1.25 * IN3);
    st.updateFeature(ex, { upTo: { kind: 'surface', surface: { base: 'XY', offset: 1.5 }, offset: 0.25, reverseOffset: true } });
    close(build(st).mp.volume, 1.75 * IN3);
  });

  it('Up To Surface on a planar face of the part (the face plane)', () => {
    const st = new DocumentStore();
    const { ex } = block(st, 1.25);
    st.addExtrude(st.addSketch('XY', rectangleEntities(3, 0, 1, 1)), 0.1, { upTo: { kind: 'surface', surface: { face: { tags: [`${ex}:end`] } } } });
    close(build(st).mp.volume, (4 * 1.25 + 1.25) * IN3);
  });

  it('Up To Surface on a tilted plane ends exactly on that plane', () => {
    const st = new DocumentStore();
    // Plane z = 2 + y (through (0,0,2), (1,0,2), (0,1,3)).
    const pl = addRefPlane(st, { kind: 'threePoints', points: [{ x: 0, y: 0, z: 2 }, { x: 1, y: 0, z: 2 }, { x: 0, y: 1, z: 3 }] });
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 0.1, { upTo: { kind: 'surface', surface: { refPlane: pl } } });
    const { mp } = build(st);
    close(mp.volume, 2.5 * IN3); // ∫∫ (2 + y) dx dy over the unit square
    expect(mp.bboxMax[2]).toBeCloseTo(3 * IN, 6);
    // Offset From Surface on the tilted plane: 0.5 back along its normal.
    const st2 = new DocumentStore();
    const pl2 = addRefPlane(st2, { kind: 'threePoints', points: [{ x: 0, y: 0, z: 2 }, { x: 1, y: 0, z: 2 }, { x: 0, y: 1, z: 3 }] });
    st2.addExtrude(st2.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 0.1, { upTo: { kind: 'surface', surface: { refPlane: pl2 }, offset: 0.5 } });
    close(build(st2).mp.volume, (2.5 - 0.5 * Math.SQRT2) * IN3); // the plane drops by 0.5/cos45° along Z
  });

  it('refuses a surface that crosses the profile instead of guessing', () => {
    const st = new DocumentStore();
    const pl = addRefPlane(st, { kind: 'threePoints', points: [{ x: 0, y: 0.5, z: 0 }, { x: 1, y: 0.5, z: 0 }, { x: 0, y: 1.5, z: 1 }] });
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 0.1, { upTo: { kind: 'surface', surface: { refPlane: pl } } });
    const r = regenerate(oc, st.state);
    expect(r.status.at(-1)!.ok).toBe(false);
    expect(r.status.at(-1)!.message).toMatch(/crosses the sketch profile/);
  });

  it('Through All - Both cuts both ways from a sketch inside the part', () => {
    const st = new DocumentStore();
    block(st, 1);
    const hs = st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 1, y: 1 }, radius: 0.25 }], { offset: 0.5 });
    st.addExtrude(hs, 0, { operation: 'cut', throughAll: true, throughAll2: true });
    close(build(st).mp.volume, (4 - Math.PI * 0.0625) * IN3);
  });

  it('From: Offset starts the extrusion away from the sketch plane', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1, { startOffset: 0.5 });
    let mp = build(st).mp;
    expect(mp.bboxMin[2]).toBeCloseTo(0.5 * IN, 9);
    expect(mp.bboxMax[2]).toBeCloseTo(1.5 * IN, 9);
    const st2 = new DocumentStore();
    st2.addExtrude(st2.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1, { startOffset: 0.5, startOffsetReverse: true });
    mp = build(st2).mp;
    expect(mp.bboxMin[2]).toBeCloseTo(-0.5 * IN, 9);
    expect(mp.bboxMax[2]).toBeCloseTo(0.5 * IN, 9);
  });

  it('Draft inward and outward match the frustum volume', () => {
    const t = Math.tan((5 * Math.PI) / 180);
    const frustum = (a: number, b: number, h: number) => (h / 3) * (a * a + b * b + a * b);
    const st = new DocumentStore();
    const ex = st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2)), 1, { draft: 5 });
    let mp = build(st).mp;
    close(mp.volume, frustum(2, 2 - 2 * t, 1) * IN3);
    expect(mp.bboxMax[0] - mp.bboxMin[0]).toBeCloseTo(2 * IN, 9); // base keeps the sketch size
    st.updateFeature(ex, { draftOutward: true });
    mp = build(st).mp;
    close(mp.volume, frustum(2, 2 + 2 * t, 1) * IN3);
    // Draft with Direction 2: Direction 2 stays straight.
    st.updateFeature(ex, { draftOutward: null, depth2: 0.5 });
    mp = build(st).mp;
    close(mp.volume, (frustum(2, 2 - 2 * t, 1) + 4 * 0.5) * IN3);
  });

  it('Draft on a circle makes a cone frustum; drafted cut tapers inward', () => {
    const t = Math.tan((10 * Math.PI) / 180);
    const cone = (R: number, r: number, h: number) => (Math.PI * h / 3) * (R * R + R * r + r * r);
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: 1 }]), 1, { draft: 10 });
    close(build(st).mp.volume, cone(1, 1 - t, 1) * IN3);
    // Cut a drafted pocket from the top face of a block: removed volume is a cone frustum.
    const st2 = new DocumentStore();
    block(st2, 1);
    const top = st2.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 1, y: 1 }, radius: 0.5 }], { offset: 1 });
    st2.addExtrude(top, 0.5, { operation: 'cut', direction: 'reverse', draft: 10 });
    close(build(st2).mp.volume, (4 - cone(0.5, 0.5 - 0.5 * t, 0.5)) * IN3);
  });

  it('Flip side to cut removes the material outside the profile, within the depth', () => {
    const st = new DocumentStore();
    block(st, 1);
    const top = st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 1, y: 1 }, radius: 0.5 }], { offset: 1 });
    st.addExtrude(top, 0.25, { operation: 'cut', direction: 'reverse', flipSide: true });
    close(build(st).mp.volume, (4 * 0.75 + Math.PI * 0.25 * 0.25) * IN3);
  });

  it('keeps face names so later features find the end face of an Up To Surface extrude', () => {
    const st = new DocumentStore();
    const pl = addRefPlane(st, { kind: 'threePoints', points: [{ x: 0, y: 0, z: 2 }, { x: 1, y: 0, z: 2 }, { x: 0, y: 1, z: 3 }] });
    const ex = st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 0.1, { upTo: { kind: 'surface', surface: { refPlane: pl } } });
    const r = regenerate(oc, st.state);
    const tags = r.topology!.faces.map((f) => f.tags);
    expect(tags.filter((t) => t.includes(`${ex}:end`)).length).toBe(1);
    expect(tags.filter((t) => t.includes(`${ex}:start`)).length).toBe(1);
    expect(tags.filter((t) => t.some((x) => x.startsWith(`${ex}:side:`))).length).toBe(4);
    const sk = st.state.features.find((f) => f.type === 'sketch') as SketchFeature;
    expect(sk).toBeTruthy();
  });
});

describe('AI extrude tool: mainstream CAD end conditions', () => {
  it('up_to_surface with surface_offset, draft and flip_side through the executor', async () => {
    const { executeTool } = await import('../src/ai/executor');
    const store = new DocumentStore();
    const c: any = {
      store,
      regen: async () => { const r = regenerate(oc, store.state); return { mesh: null, status: r.status, sketches: r.sketches, topology: r.topology, mass: r.shape ? massProperties(oc, r.shape) : null, ms: 0 }; },
      selection: () => [],
      info: async () => { throw new Error('unused'); },
    };
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', entities: [{ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, up_to_surface: { plane: 'XY', offset: 2 }, surface_offset: 0.5, operation: 'new' });
    expect(ex, JSON.stringify(ex)).toMatchObject({ ok: true });
    close(build(store).mp.volume, 1.5 * IN3);
    await expect(executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: 1, flip_side: true })).rejects.toThrow(/only for cuts/);
    const sk2: any = await executeTool(c, 'create_sketch', { plane: 'XY', entities: [{ type: 'rectangle', x: 3, y: 0, width: 2, height: 2 }] });
    const ex2: any = await executeTool(c, 'extrude', { sketch_id: sk2.sketch_id, depth: 1, draft: 5 });
    expect(ex2, JSON.stringify(ex2)).toMatchObject({ ok: true });
    const t = Math.tan((5 * Math.PI) / 180), b = 2 - 2 * t;
    close(build(store).mp.volume, (1.5 + (4 + b * b + 2 * b) / 3) * IN3);
  });
});

describe('Extrude Thin Feature', () => {
  it('open L-shaped chain: one-direction, mid-plane, reverse; and a closed square as a tube', () => {
    const L = (dir: any) => {
      const st = new DocumentStore();
      const sk = st.addSketch('XY', [
        { id: 'l1', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 2, y: 0 } },
        { id: 'l2', kind: 'line', p1: { x: 2, y: 0 }, p2: { x: 2, y: 1 } },
      ]);
      st.addExtrude(sk, 1, { thin: dir });
      return build(st).mp;
    };
    // Mid-plane 0.2 around an L of total length 3: area = 3*0.2 exactly (the outer corner adds 0.1², the inner removes 0.1²).
    close(L({ type: 'midPlane', thickness: 0.2 }).volume, 3 * 0.2 * IN3);
    // One direction 0.1 to the left of the chain (inside the L): (2 - 0.1) * 0.1 + 1 * 0.1.
    close(L({ type: 'oneDirection', thickness: 0.1 }).volume, (1.9 * 0.1 + 0.1) * IN3);
    // Reverse: outside the corner: 2 * 0.1 + (1 + 0.1) * 0.1.
    close(L({ type: 'oneDirection', thickness: 0.1, reverse: true }).volume, (0.2 + 0.11) * IN3);
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2)), 1, { thin: { type: 'oneDirection', thickness: 0.1 } });
    close(build(st).mp.volume, (4 - 1.8 * 1.8) * IN3); // wall inside the square
  });

  it('a thin cut with Through All', () => {
    const st = new DocumentStore();
    block(st, 1);
    const sk = st.addSketch('XY', [{ id: 'l', kind: 'line', p1: { x: 0.5, y: -1 }, p2: { x: 0.5, y: 3 } }], { offset: 1 });
    st.addExtrude(sk, 0, { operation: 'cut', direction: 'reverse', throughAll: true, thin: { type: 'midPlane', thickness: 0.125 } });
    close(build(st).mp.volume, (4 - 0.125 * 2) * IN3); // a 1/8 slot across the 2-wide block
  });
});
