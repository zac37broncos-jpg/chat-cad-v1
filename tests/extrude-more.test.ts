/**
 * The extrude options earlier runs left out, now matching mainstream CAD's
 * "End Condition Extrude" help and Extrude command panel: Up To Next,
 * Up To Surface on a curved face, every end condition and its own draft in
 * Direction 2, and the thin feature's Cap ends and Auto-fillet corners.
 * Every volume is checked against a hand calculation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, type SketchEntity } from '../src/core/model';
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
  expect(isValid(oc, r.shape!)).toBe(true);
  return massProperties(oc, r.shape!);
}
function fails(st: DocumentStore, msg: RegExp) {
  const r = regenerate(oc, st.state);
  const last = r.status.at(-1)!;
  expect(last.ok).toBe(false);
  expect(last.message).toMatch(msg);
}
const close = (v: number, exp: number) => expect(Math.abs(v - exp) / Math.abs(exp)).toBeLessThan(REL);

/**
 * A "C" seen from the front: base slab z 0..0.5, top plate z 1.5..2 (both
 * 2 x 2), joined by a wall at x 0..0.25. Volume 2*2*0.5*2 + 0.25*2*1 = 4.5.
 */
function cShape(st: DocumentStore) {
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2)), 0.5);
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 0.25, 2), { offset: 0.5 }), 1);
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2), { offset: 1.5 }), 0.5);
}

describe('Up To Next', () => {
  it('a cut from the top face goes through the first wall only', () => {
    const st = new DocumentStore();
    cShape(st);
    const sk = st.addSketch('XY', rectangleEntities(1, 0.5, 0.5, 1), { offset: 2 });
    const ex = st.addExtrude(sk, 0.1, { operation: 'cut', direction: 'reverse', upTo: { kind: 'next' } });
    close(build(st).volume, (4.5 - 0.5 * 0.5) * IN3);
    // Through All would also cut the base: Up To Next really stops at the next face.
    st.updateFeature(ex, { upTo: null, throughAll: true });
    close(build(st).volume, (4.5 - 0.5 * 1) * IN3);
  });

  it('a boss fills up to the overhang above it', () => {
    const st = new DocumentStore();
    cShape(st);
    st.addExtrude(st.addSketch('XY', rectangleEntities(1, 0.5, 0.5, 1), { offset: 0.5 }), 0.1, { upTo: { kind: 'next' } });
    const mp = build(st);
    close(mp.volume, (4.5 + 0.5 * 1 * 1) * IN3);
  });

  it('refuses when no face ahead covers the whole profile', () => {
    const st = new DocumentStore();
    cShape(st);
    st.addExtrude(st.addSketch('XY', rectangleEntities(1.5, 0.5, 1, 1), { offset: 0.5 }), 0.1, { upTo: { kind: 'next' } });
    fails(st, /intercepts the entire profile/);
    const st2 = new DocumentStore();
    cShape(st2);
    st2.addExtrude(st2.addSketch('XY', rectangleEntities(1, 0.5, 0.5, 1), { offset: 2 }), 0.1, { upTo: { kind: 'next' } });
    fails(st2, /no part ahead/);
  });
});

describe('Up To Surface on a curved face', () => {
  /** Cylinder along X: radius 1, x 0..2 (sketched on YZ). Returns its side-face tag. */
  function cylinder(st: DocumentStore) {
    const c: SketchEntity = { id: 'cyl', kind: 'circle', center: { x: 0, y: 0 }, radius: 1 };
    const ex = st.addExtrude(st.addSketch('YZ', [c]), 2);
    return `${ex}:side:cyl`;
  }
  it('ends exactly on the cylinder', () => {
    const st = new DocumentStore();
    const side = cylinder(st);
    // A 1 x 0.5 bar from z = -3 up to the underside of the cylinder.
    st.addExtrude(st.addSketch('XY', rectangleEntities(0.5, -0.25, 1, 0.5), { offset: -3 }), 0.1, { upTo: { kind: 'surface', surface: { face: { tags: [side] } } } });
    const a = 0.25;
    const under = a * Math.sqrt(1 - a * a) + Math.asin(a); // ∫ sqrt(1 - y²) dy over -a..a
    const bar = 1 * (3 * 2 * a - under);
    close(build(st).volume, (Math.PI * 2 + bar) * IN3);
  });
  it('refuses a face that does not cover the profile, and an offset from it', () => {
    const st = new DocumentStore();
    const side = cylinder(st);
    st.addExtrude(st.addSketch('XY', rectangleEntities(1.5, -0.25, 1, 0.5), { offset: -3 }), 0.1, { upTo: { kind: 'surface', surface: { face: { tags: [side] } } } });
    fails(st, /does not intercept the entire profile/);
    const st2 = new DocumentStore();
    const side2 = cylinder(st2);
    st2.addExtrude(st2.addSketch('XY', rectangleEntities(0.5, -0.25, 1, 0.5), { offset: -3 }), 0.1, { upTo: { kind: 'surface', surface: { face: { tags: [side2] } }, offset: 0.1 } });
    fails(st2, /Offset From Surface needs a plane/);
  });
});

describe('Direction 2 end conditions and draft', () => {
  it('Up To Surface and Up To Vertex in Direction 2', () => {
    const st = new DocumentStore();
    const pt = st.addFeature({ type: 'refPoint', def: { kind: 'coords', p: { x: 9, y: 9, z: -0.4 } } } as any);
    const ex = st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1, { upTo2: { kind: 'surface', surface: { base: 'XY', offset: -0.75 } } });
    let mp = build(st);
    close(mp.volume, 1.75 * IN3);
    expect(mp.bboxMin[2]).toBeCloseTo(-0.75 * IN, 9);
    st.updateFeature(ex, { upTo2: { kind: 'vertex', vertex: { refPoint: pt } } });
    mp = build(st);
    close(mp.volume, 1.4 * IN3);
    expect(mp.bboxMin[2]).toBeCloseTo(-0.4 * IN, 9);
  });

  it('refuses a Direction 2 target on the Direction 1 side', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1, { upTo2: { kind: 'surface', surface: { base: 'XY', offset: 2 } } });
    fails(st, /Direction 1 side/);
  });

  it('Direction 2 has its own draft (inward and outward)', () => {
    const t = Math.tan((5 * Math.PI) / 180);
    const frustum = (a: number, b: number, h: number) => (h / 3) * (a * a + b * b + a * b);
    const st = new DocumentStore();
    const ex = st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2)), 1, { depth2: 0.5, draft2: 5 });
    let mp = build(st);
    close(mp.volume, (4 * 1 + frustum(2, 2 - 2 * 0.5 * t, 0.5)) * IN3);
    expect(mp.bboxMin[2]).toBeCloseTo(-0.5 * IN, 9);
    st.updateFeature(ex, { draftOutward2: true, draft: 3 });
    const t3 = Math.tan((3 * Math.PI) / 180);
    mp = build(st);
    close(mp.volume, (frustum(2, 2 - 2 * t3, 1) + frustum(2, 2 + 2 * 0.5 * t, 0.5)) * IN3);
  });

  it('Up To Next in Direction 2 cuts only down to the next face', () => {
    const st = new DocumentStore();
    cShape(st);
    // Sketch in the gap at z = 1; Direction 1 up to the plate's underside, Direction 2 down to the base: a cut of nothing...
    // ...so cut instead from inside the top plate (z = 1.75): Direction 1 blind 0.25 up, Direction 2 Up To Next down = the plate's lower face.
    st.addExtrude(st.addSketch('XY', rectangleEntities(1, 0.5, 0.5, 1), { offset: 1.75 }), 0.25, { operation: 'cut', upTo2: { kind: 'next' } });
    close(build(st).volume, (4.5 - 0.5 * 0.5) * IN3);
  });
});

describe('Thin Feature: Cap ends and Auto-fillet corners', () => {
  it('Cap ends closes both ends inside the depth (a hollow part)', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2)), 1, { thin: { type: 'oneDirection', thickness: 0.1, capEnds: true, capThickness: 0.2 } });
    const mp = build(st);
    close(mp.volume, (4 * 1 - 1.8 * 1.8 * 0.6) * IN3);
    expect(mp.bboxMax[2] - mp.bboxMin[2]).toBeCloseTo(1 * IN, 9);
  });
  it('Cap ends works with Mid Plane and checks the cap thickness', () => {
    const st = new DocumentStore();
    const ex = st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2)), 1, { direction: 'symmetric', thin: { type: 'oneDirection', thickness: 0.1, capEnds: true, capThickness: 0.2 } });
    close(build(st).volume, (4 * 1 - 1.8 * 1.8 * 0.6) * IN3);
    st.updateFeature(ex, { thin: { type: 'oneDirection', thickness: 0.1, capEnds: true, capThickness: 0.5 } });
    fails(st, /less than half/);
  });
  it('Auto-fillet corners rounds an open L to the inside radius', () => {
    const st = new DocumentStore();
    const ents: SketchEntity[] = [
      { id: 'a', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 2, y: 0 } },
      { id: 'b', kind: 'line', p1: { x: 2, y: 0 }, p2: { x: 2, y: 1 } },
    ];
    st.addExtrude(st.addSketch('XY', ents), 1, { thin: { type: 'midPlane', thickness: 0.1, autoFillet: 0.2 } });
    // Centerline radius 0.25 trims 0.25 off each line; the bend is a quarter annulus 0.2..0.3.
    const area = (1.75 + 0.75) * 0.1 + (Math.PI / 2) * (0.3 ** 2 - 0.2 ** 2) / 2;
    close(build(st).volume, area * IN3);
  });
  it('Auto-fillet uses the inside of each bend for one-direction walls', () => {
    const st = new DocumentStore();
    const ents: SketchEntity[] = [
      { id: 'a', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 2, y: 0 } },
      { id: 'b', kind: 'line', p1: { x: 2, y: 0 }, p2: { x: 2, y: 1 } },
    ];
    st.addExtrude(st.addSketch('XY', ents), 1, { thin: { type: 'oneDirection', thickness: 0.1, autoFillet: 0.2 } });
    // Whichever side the wall is on, the inside radius is 0.2: wall inside the bend -> centerline radius 0.3,
    // bend band 0.2..0.3, lines trimmed by 0.3; outside -> centerline 0.2, band 0.2..0.3, trimmed by 0.2.
    const v = build(st).volume / IN3;
    const inside = (1.7 + 0.7) * 0.1 + (Math.PI / 2) * (0.3 ** 2 - 0.2 ** 2) / 2;
    const outside = (1.8 + 0.8) * 0.1 + (Math.PI / 2) * (0.3 ** 2 - 0.2 ** 2) / 2;
    expect(Math.min(Math.abs(v - inside) / inside, Math.abs(v - outside) / outside)).toBeLessThan(REL);
  });
});
