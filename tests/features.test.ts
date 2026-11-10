/**
 * Modelling features checked against hand calculations (closed-form volumes,
 * exact radii and positions). Tolerances are relative and far tighter than
 * the 0.005 in requirement.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, newId } from '../src/core/model';
import { regenerate, isValid, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo, listSubShapes } from '../src/kernel/query';
import { edgeRefFrom, faceRefFrom, type Topology } from '../src/kernel/naming';
import * as F from '../src/core/featureCommands';
import { holeSpec, holeCallout } from '../src/core/holeTables';
import type { Vec3 } from '../src/core/featureTypes';

const IN = 25.4;
const IN3 = IN ** 3;
const EXACT = 1e-9;
let oc: OC;
beforeAll(async () => { oc = await init(); });

function regen(st: DocumentStore) {
  const r = regenerate(oc, st.state);
  const bad = r.status.filter((s) => !s.ok);
  if (bad.length) throw new Error(JSON.stringify(bad));
  expect(r.shape).not.toBeNull();
  expect(isValid(oc, r.shape!)).toBe(true);
  return r;
}
const vol = (st: DocumentStore) => massProperties(oc, regen(st).shape!).volume / IN3;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const near = (p: Vec3, q: Vec3, tol = 1e-6) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
const inch = (x: number, y: number, z: number): Vec3 => [x * IN, y * IN, z * IN];

/** Edge whose midpoint is at the given inch coordinates. */
function edgeAt(t: Topology, p: Vec3) {
  const i = t.edges.findIndex((e) => near(e.mid, p, 1e-6));
  if (i < 0) throw new Error(`no edge at ${p}`);
  return edgeRefFrom(t, i);
}
/** Planar face whose centroid is at the given point. */
function faceAt(t: Topology, p: Vec3) {
  const i = t.faces.findIndex((f) => near(f.center, p, 1e-6));
  if (i < 0) throw new Error(`no face at ${p}`);
  return faceRefFrom(t, i);
}

/** L x W x H block on the Top plane, corner at the origin, with parameters. */
function block(L = 2, W = 2, H = 1) {
  const st = new DocumentStore();
  st.setParameter('L', String(L)); st.setParameter('W', String(W)); st.setParameter('H', String(H));
  const sk = st.addSketch('XY', rectangleEntities(0, 0, 'L', 'W'), { name: 'Block Sketch' });
  const ex = st.addExtrude(sk, 'H', { name: 'Block' });
  return { st, sk, ex };
}

describe('fillet', () => {
  it('constant fillet on one edge: exact volume and radius, and it follows the edge when the block grows', () => {
    const { st } = block();
    const t = regen(st).topology!;
    const r = 0.25;
    const id = F.addFillet(st, { edges: [edgeAt(t, inch(2, 2, 0.5))], radius: r, name: 'Corner Round' });
    expect(st.feature(id)!.name).toBe('Corner Round');
    expect(rel(vol(st), 4 - r * r * (1 - Math.PI / 4))).toBeLessThan(EXACT);
    const shape = regen(st).shape!;
    const cyl = listSubShapes(oc, shape, 'TopAbs_FACE').map((_, i) => entityInfo(oc, shape, 'face', i)).filter((f: any) => f.surface === 'cylinder');
    expect(cyl.length).toBe(1);
    expect((cyl[0] as any).radius).toBeCloseTo(r * IN, 10);
    // Upstream edit: the fillet stays on the same (moved) corner edge.
    st.setParameter('L', '3');
    expect(rel(vol(st), 6 - r * r * (1 - Math.PI / 4))).toBeLessThan(EXACT);
    const s2 = regen(st).shape!;
    const c2 = listSubShapes(oc, s2, 'TopAbs_FACE').map((_, i) => entityInfo(oc, s2, 'face', i)).find((f: any) => f.surface === 'cylinder') as any;
    expect(c2.axisOrigin[0]).toBeCloseTo((3 - r) * IN, 8);
    expect(c2.axisOrigin[1]).toBeCloseTo((2 - r) * IN, 8);
  });

  it('fillet of all faces = rounded box (Minkowski formula)', () => {
    const a = 2, b = 1.5, c = 1, r = 0.2;
    const { st } = block(a, b, c);
    const t = regen(st).topology!;
    F.addFillet(st, { faces: t.faces.map((_, i) => faceRefFrom(t, i)), radius: r });
    const [A, B, C] = [a - 2 * r, b - 2 * r, c - 2 * r];
    const expected = A * B * C + 2 * r * (A * B + B * C + C * A) + Math.PI * r * r * (A + B + C) + (4 / 3) * Math.PI * r ** 3;
    expect(rel(vol(st), expected)).toBeLessThan(1e-7);
  });

  it('variable fillet: radius runs linearly from the start end to the other end', () => {
    const { st } = block(2, 2, 1);
    const t = regen(st).topology!;
    const r1 = 0.1, r2 = 0.3;
    F.addVariableFillet(st, { edges: [edgeAt(t, inch(2, 2, 0.5))], radius: r1, radius2: r2, startAt: inch(2, 2, 0) });
    // The ball touches each side face at distance r(z) from the edge. With a linear law that
    // contact line is straight, so each side face loses exactly a trapezoid: (r1 + r2) / 2 * height.
    const shape = regen(st).shape!;
    const faces = listSubShapes(oc, shape, 'TopAbs_FACE').map((_, i) => entityInfo(oc, shape, 'face', i) as any);
    const xFace = faces.find((f) => f.surface === 'plane' && f.normal[0] > 0.99);
    const yFace = faces.find((f) => f.surface === 'plane' && f.normal[1] > 0.99);
    expect(xFace.area / IN ** 2).toBeCloseTo(2 - (r1 + r2) / 2, 7);
    expect(yFace.area / IN ** 2).toBeCloseTo(2 - (r1 + r2) / 2, 7);
    // Smaller radius at the bottom: the bottom face keeps more area than the top.
    const bottom = faces.find((f) => f.surface === 'plane' && f.normal[2] < -0.99);
    const top = faces.find((f) => f.surface === 'plane' && f.normal[2] > 0.99);
    const k = 1 - Math.PI / 4;
    expect(bottom.area / IN ** 2).toBeCloseTo(4 - k * r1 * r1, 3);
    expect(top.area / IN ** 2).toBeCloseTo(4 - k * r2 * r2, 3);
    // Removed volume lies between the two constant-radius fillets.
    const v = vol(st);
    expect(4 - v).toBeGreaterThan(k * r1 * r1);
    expect(4 - v).toBeLessThan(k * r2 * r2);
    // Flipping the start end swaps the radii.
    const fid = st.state.features.at(-1)!.id;
    st.updateFeature(fid, { startAt: inch(2, 2, 1) });
    const s2 = regen(st).shape!;
    const b2 = listSubShapes(oc, s2, 'TopAbs_FACE').map((_, i) => entityInfo(oc, s2, 'face', i) as any).find((f) => f.surface === 'plane' && f.normal[2] < -0.99);
    expect(b2.area / IN ** 2).toBeCloseTo(4 - k * r2 * r2, 3);
  });

  it('face fillet blends where two face sets meet', () => {
    const { st } = block();
    const t = regen(st).topology!;
    const top = faceAt(t, inch(1, 1, 1)), side = faceAt(t, inch(2, 1, 0.5));
    F.addFaceFillet(st, { faces: [top], faces2: [side], radius: 0.25 });
    expect(rel(vol(st), 4 - 0.0625 * 2 * (1 - Math.PI / 4))).toBeLessThan(EXACT);
  });

  it('reports a lost reference instead of guessing', () => {
    const { st } = block();
    const boss = st.addSketch('XY', rectangleEntities(0.5, 0.5, 1, 1), { offset: 'H' });
    st.addExtrude(boss, 0.5, { name: 'Boss' });
    const t = regen(st).topology!;
    const fid = F.addFillet(st, { edges: [edgeAt(t, inch(1.5, 1.5, 1.25))], radius: 0.1 });
    expect(regenerate(oc, st.state).status.find((s) => s.id === fid)!.ok).toBe(true);
    st.setSuppressed(st.state.features.find((f) => f.name === 'Boss')!.id, true);
    const st2 = regenerate(oc, st.state).status.find((s) => s.id === fid)!;
    expect(st2.ok).toBe(false);
    expect(st2.message).toMatch(/no longer exists/);
  });

  it('fails cleanly when the radius is too large', () => {
    const { st } = block(2, 2, 1);
    const t = regen(st).topology!;
    const fid = F.addFillet(st, { edges: [edgeAt(t, inch(1, 2, 1))], radius: 1.5 });
    const s = regenerate(oc, st.state).status.find((x) => x.id === fid)!;
    expect(s.ok).toBe(false);
  });
});

describe('chamfer', () => {
  it('equal distance', () => {
    const { st } = block();
    const t = regen(st).topology!;
    F.addChamfer(st, { edges: [edgeAt(t, inch(1, 2, 1))], distance: 0.1 });
    expect(rel(vol(st), 4 - (0.1 * 0.1) / 2 * 2)).toBeLessThan(EXACT);
  });

  it('two distances: distance 1 lies on face a of the edge reference', () => {
    const { st } = block();
    const t = regen(st).topology!;
    const e = edgeAt(t, inch(1, 2, 1)); // top / back edge
    const top = t.faces.find((f) => near(f.center, inch(1, 1, 1)))!.tags;
    const ref = e.a.some((x) => top.includes(x)) ? e : { a: e.b, b: e.a, at: e.at };
    F.addChamfer(st, { edges: [ref], distance: 0.1, distance2: 0.3 });
    expect(rel(vol(st), 4 - (0.1 * 0.3) / 2 * 2)).toBeLessThan(EXACT);
    const shape = regen(st).shape!;
    const topFace = listSubShapes(oc, shape, 'TopAbs_FACE').map((_, i) => entityInfo(oc, shape, 'face', i) as any).find((f) => f.surface === 'plane' && f.normal[2] > 0.99);
    expect(topFace.area / IN ** 2).toBeCloseTo(2 * (2 - 0.1), 8);
  });

  it('distance-angle', () => {
    const { st } = block();
    const t = regen(st).topology!;
    F.addChamfer(st, { edges: [edgeAt(t, inch(1, 2, 1))], distance: 0.2, angle: 30 });
    expect(rel(vol(st), 4 - (0.2 * 0.2 * Math.tan(Math.PI / 6)) / 2 * 2)).toBeLessThan(1e-8);
  });
});

describe('hole feature', () => {
  it('table lookups match ASME B18.3 / ISO values', () => {
    expect(holeSpec('ansi-inch', 'counterbore', '1/4', 'normal')).toMatchObject({ diameter: 0.281, cboreDiameter: 0.438, cboreDepth: 0.25 });
    expect(holeSpec('ansi-inch', 'counterbore', '#10', 'close')).toMatchObject({ diameter: 0.206, cboreDiameter: 0.375 });
    expect(holeSpec('ansi-inch', 'tapped', '1/4-20').diameter).toBe(0.201);
    expect(holeSpec('ansi-inch', 'tapped', '10-32').diameter).toBe(0.159);
    expect(holeSpec('ansi-inch', 'countersink', '#10')).toMatchObject({ cskDiameter: 0.411, cskAngle: 82 });
    expect(holeSpec('iso-metric', 'counterbore', 'M6')).toMatchObject({ diameter: 6.6, cboreDiameter: 11, cboreDepth: 6 });
    expect(holeSpec('iso-metric', 'tapped', 'M6').diameter).toBe(5);
    expect(holeSpec('iso-metric', 'tapped', 'M8x1').diameter).toBe(7);
    expect(holeSpec('iso-metric', 'simple', 'M5', 'close').diameter).toBe(5.3);
    expect(() => holeSpec('iso-metric', 'tapped', 'M6x0.5')).toThrow(/pitch/);
    expect(() => holeSpec('ansi-inch', 'simple', '9/32')).toThrow(/Unknown/);
    expect(holeCallout({ holeType: 'counterbore', diameter: 0.281, through: true, cboreDiameter: 0.438, cboreDepth: 0.25, count: 2 }, 'in')).toBe('2X  ⌀.281 THRU ALL  ⌴ ⌀.438 ↧ .250');
  });

  function plate(T = 1) {
    const st = new DocumentStore();
    st.setParameter('T', String(T));
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Plate Sketch' }), 'T', { name: 'Plate' });
    return st;
  }

  it('through clearance hole and counterbore on the top plane', () => {
    const st = plate(1);
    F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { base: 'XY', offset: 'T' }, points: [{ x: 1, y: 1 }] });
    F.addHole(st, { holeType: 'counterbore', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { base: 'XY', offset: 'T' }, points: [{ x: 3, y: 1 }] });
    const r = 0.281 / 2, rc = 0.438 / 2;
    const expected = 8 - Math.PI * r * r * 1 - Math.PI * (rc * rc * 0.25 + r * r * 0.75);
    expect(rel(vol(st), expected)).toBeLessThan(EXACT);
    expect(st.state.features.map((f) => f.name)).toEqual(['Plate Sketch', 'Plate', '1/4 Clearance Hole1', 'CBORE for 1/4 SHCS1']);
  });

  it('countersink (82 deg) and blind tapped hole with drill point', () => {
    const st = plate(1);
    F.addHole(st, { holeType: 'countersink', standard: 'ansi-inch', size: '#10', end: 'through', placement: { base: 'XY', offset: 1 }, points: [{ x: 1, y: 1 }] });
    F.addHole(st, { holeType: 'tapped', standard: 'ansi-inch', size: '1/4-20', end: 'blind', placement: { base: 'XY', offset: 1 }, points: [{ x: 3, y: 1 }] });
    const R = 0.411 / 2, r = 0.221 / 2, h = (R - r) / Math.tan((41 * Math.PI) / 180);
    const csk = (Math.PI * h / 3) * (R * R + R * r + r * r) + Math.PI * r * r * (1 - h);
    const rt = 0.201 / 2, depth = 0.5 + 3 / 20, tip = rt / Math.tan((59 * Math.PI) / 180);
    const tapped = Math.PI * rt * rt * depth + (Math.PI * rt * rt * tip) / 3;
    expect(rel(vol(st), 8 - csk - tapped)).toBeLessThan(EXACT);
  });

  it('metric counterbore in a mm part, on a picked face; follows the face when the part gets thicker', () => {
    const st = new DocumentStore();
    st.setUnits('mm');
    st.setParameter('T', '20');
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 50, 30)), 'T');
    const t = regen(st).topology!;
    const top = faceAt(t, [25, 15, 20]);
    F.addHole(st, { holeType: 'counterbore', standard: 'iso-metric', size: 'M6', end: 'through', placement: { face: top }, points: [{ x: 10, y: 15 }, { x: 40, y: 15 }] });
    const hole = (T: number) => 2 * Math.PI * (5.5 * 5.5 * 6 + 3.3 * 3.3 * (T - 6));
    expect(rel(massProperties(oc, regen(st).shape!).volume, 50 * 30 * 20 - hole(20))).toBeLessThan(EXACT);
    st.setParameter('T', '25');
    expect(rel(massProperties(oc, regen(st).shape!).volume, 50 * 30 * 25 - hole(25))).toBeLessThan(EXACT);
  });
});

describe('patterns and mirror', () => {
  function plateWithHole() {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 6, 4)), 0.5, { name: 'Plate' });
    const hole = F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { base: 'XY', offset: 0.5 }, points: [{ x: 1, y: 1 }] });
    return { st, hole, hv: Math.PI * (0.281 / 2) ** 2 * 0.5 };
  }

  it('linear pattern in two directions with a skipped instance', () => {
    const { st, hole, hv } = plateWithHole();
    F.addLinearPattern(st, { features: [hole], dir1: { axis: 'X' }, spacing1: 1.5, count1: 3, dir2: { axis: 'Y' }, spacing2: 2, count2: 2, skip: [[2, 1]] });
    expect(rel(vol(st), 12 - 5 * hv)).toBeLessThan(EXACT);
    const shape = regen(st).shape!;
    const axes = listSubShapes(oc, shape, 'TopAbs_FACE').map((_, i) => entityInfo(oc, shape, 'face', i) as any).filter((f) => f.surface === 'cylinder').map((f) => [f.axisOrigin[0] / IN, f.axisOrigin[1] / IN]);
    const has = (x: number, y: number) => axes.some(([a, b]) => Math.abs(a - x) < 1e-9 && Math.abs(b - y) < 1e-9);
    expect(has(4, 1) && has(2.5, 3) && has(1, 3)).toBe(true);
    expect(has(4, 3)).toBe(false);
  });

  it('circular pattern of 6 holes on a bolt circle', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: 2 }]), 0.25, { name: 'Flange' });
    const hole = F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '#10', end: 'through', placement: { base: 'XY', offset: 0.25 }, points: [{ x: 1.5, y: 0 }] });
    F.addCircularPattern(st, { features: [hole], axis: { axis: 'Z' }, count: 6, angle: 360 });
    const r = 0.221 / 2;
    expect(rel(vol(st), Math.PI * 4 * 0.25 - 6 * Math.PI * r * r * 0.25)).toBeLessThan(EXACT);
    const shape = regen(st).shape!;
    const axes = listSubShapes(oc, shape, 'TopAbs_FACE').map((_, i) => entityInfo(oc, shape, 'face', i) as any).filter((f) => f.surface === 'cylinder' && Math.abs(f.radius - r * IN) < 1e-9);
    expect(axes.length).toBe(6);
    expect(axes.some((f) => Math.abs(f.axisOrigin[0] - 1.5 * IN * Math.cos(Math.PI / 3)) < 1e-6 && Math.abs(f.axisOrigin[1] - 1.5 * IN * Math.sin(Math.PI / 3)) < 1e-6)).toBe(true);
  });

  it('mirror a boss about the Right plane, and mirror the whole body', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(-2, 0, 4, 1)), 0.5, { name: 'Base' });
    const boss = st.addExtrude(st.addSketch('XY', rectangleEntities(1, 0, 0.5, 1), { offset: 0.5 }), 1, { name: 'Boss' });
    F.addMirror(st, { features: [boss], plane: { base: 'YZ' } });
    expect(rel(vol(st), 2 + 2 * 0.5)).toBeLessThan(EXACT);
    F.addMirror(st, { body: true, plane: { base: 'XZ' } });
    const r = regen(st);
    expect(rel(massProperties(oc, r.shape!).volume / IN3, 6)).toBeLessThan(EXACT);
    expect(massProperties(oc, r.shape!).bboxMin[1]).toBeCloseTo(-1 * IN, 8);
  });

  it('body pattern', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1);
    F.addLinearPattern(st, { body: true, dir1: { axis: 'X' }, spacing1: 1, count1: 3 });
    expect(rel(vol(st), 3)).toBeLessThan(EXACT);
    expect(regen(st).shape && listSubShapes(oc, regen(st).shape!, 'TopAbs_FACE').length).toBe(6); // touching cubes merge into one clean box
  });
});

describe('shell and draft', () => {
  it('shell with the top face removed, inward', () => {
    const { st } = block(4, 3, 2);
    const t = regen(st).topology!;
    F.addShell(st, { faces: [faceAt(t, inch(2, 1.5, 2))], thickness: 0.1 });
    expect(rel(vol(st), 24 - 3.8 * 2.8 * 1.9)).toBeLessThan(EXACT);
  });

  it('closed hollow shell', () => {
    const { st } = block(4, 3, 2);
    F.addShell(st, { thickness: 0.1 });
    expect(rel(vol(st), 24 - 3.8 * 2.8 * 1.8)).toBeLessThan(EXACT);
  });

  it('draft four side faces 5 deg from the bottom: exact frustum', () => {
    const { st } = block(1, 1, 1);
    const t = regen(st).topology!;
    const sides = [inch(0.5, 0, 0.5), inch(1, 0.5, 0.5), inch(0.5, 1, 0.5), inch(0, 0.5, 0.5)].map((p) => faceAt(t, p));
    F.addDraft(st, { faces: sides, neutral: { base: 'XY' }, angle: 5 });
    const top = 1 - 2 * Math.tan((5 * Math.PI) / 180);
    const expected = (1 / 3) * (1 + top * top + top);
    expect(rel(vol(st), expected)).toBeLessThan(1e-8);
  });
});

describe('rib, sweep, loft', () => {
  it('rib between two walls down to the base (parallel to the sketch)', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 1)), 0.25, { name: 'Base' });
    st.addExtrude(st.addSketch('XY', [...rectangleEntities(0, 0, 0.25, 1), ...rectangleEntities(3.75, 0, 0.25, 1)], { offset: 0.25 }), 2, { name: 'Walls' });
    // Front plane (normal -Y) moved to y = 0.5: offset -0.5.
    const rs = st.addSketch('XZ', [{ id: newId('ln'), kind: 'line', p1: { x: 1, y: 1.5 }, p2: { x: 3, y: 1.5 } }], { offset: -0.5, name: 'Rib Sketch' });
    F.addRib(st, { sketch: rs, thickness: 0.2 });
    const base = 4 * 0.25 + 2 * 0.25 * 2;
    expect(rel(vol(st), base + 3.5 * 1.25 * 0.2)).toBeLessThan(EXACT);
  });

  it('sweep a circle along a quarter arc (Pappus)', () => {
    const st = new DocumentStore();
    const r = 0.25, R = 2;
    const prof = st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: r }], { name: 'Pipe Profile' });
    // Front plane: sketch x -> X, y -> Z. Arc centred at (R, 0) from 90 to 180 deg ends at the origin.
    const path = st.addSketch('XZ', [{ id: 'a', kind: 'arc', center: { x: R, y: 0 }, radius: R, startAngle: 90, endAngle: 180 }], { name: 'Pipe Path' });
    F.addSweep(st, { profile: prof, path });
    expect(rel(vol(st), Math.PI * r * r * (R * Math.PI / 2))).toBeLessThan(1e-6);
    expect(st.state.features.at(-1)!.name).toBe('Boss-Sweep1');
  });

  it('ruled loft between two squares = frustum', () => {
    const st = new DocumentStore();
    const a = st.addSketch('XY', rectangleEntities(-1, -1, 2, 2));
    const b = st.addSketch('XY', rectangleEntities(-0.5, -0.5, 1, 1), { offset: 1 });
    F.addLoft(st, { profiles: [a, b], ruled: true });
    expect(rel(vol(st), (1 / 3) * (4 + 1 + 2))).toBeLessThan(1e-9);
  });
});

describe('reference geometry', () => {
  it('offset plane carries a sketch; two-plane axis drives a circular pattern', () => {
    const st = new DocumentStore();
    const pl = F.addRefPlane(st, { kind: 'offset', from: { base: 'XY' }, distance: 1 }, 'Raised Plane');
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 2, 2));
    st.updateFeature(sk, { refPlane: pl });
    st.addExtrude(sk, 0.5);
    let r = regen(st);
    expect(massProperties(oc, r.shape!).bboxMin[2]).toBeCloseTo(1 * IN, 9);
    expect(r.refGeometry!.find((g) => g.id === pl)).toMatchObject({ kind: 'plane', normal: [0, 0, 1] });
    // Axis where x = 1 and y = 1 planes meet: vertical through (1, 1).
    const xp = F.addRefPlane(st, { kind: 'offset', from: { base: 'YZ' }, distance: 1 });
    const yp = F.addRefPlane(st, { kind: 'offset', from: { base: 'XZ' }, distance: -1 });
    const ax = F.addRefAxis(st, { kind: 'twoPlanes', a: { refPlane: xp }, b: { refPlane: yp } });
    r = regen(st);
    const g = r.refGeometry!.find((x) => x.id === ax)! as any;
    expect(Math.abs(g.dir[2])).toBeCloseTo(1, 12);
    // Point on the axis at z = 0 is (1, 1).
    const t = -g.origin[2] / g.dir[2];
    expect(g.origin[0] + t * g.dir[0]).toBeCloseTo(1 * IN, 9);
    expect(g.origin[1] + t * g.dir[1]).toBeCloseTo(1 * IN, 9);
    const boss = st.addExtrude(st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 1.75, y: 1 }, radius: 0.1 }], { offset: 1.5 }), 0.25);
    F.addCircularPattern(st, { features: [boss], axis: { refAxis: ax }, count: 4 });
    expect(rel(vol(st), 2 + 4 * Math.PI * 0.01 * 0.25)).toBeLessThan(EXACT);
  });

  it('angled plane, three-point plane, mid plane and points', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2)), 1);
    const r0 = regen(st);
    const t = r0.topology!;
    const ang = F.addRefPlane(st, { kind: 'angle', from: { base: 'XY' }, axis: { axis: 'X' }, angle: 30 });
    const three = F.addRefPlane(st, { kind: 'threePoints', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }] });
    const mid = F.addRefPlane(st, { kind: 'midplane', a: { face: faceAt(t, inch(1, 1, 1)) }, b: { face: faceAt(t, inch(1, 1, 0)) } });
    const cp = F.addRefPoint(st, { kind: 'faceCenter', face: faceAt(t, inch(1, 1, 1)) });
    const r = regen(st);
    const get = (id: string) => r.refGeometry!.find((g) => g.id === id) as any;
    expect(get(ang).normal[1]).toBeCloseTo(-Math.sin(Math.PI / 6), 12);
    expect(get(ang).normal[2]).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    expect(Math.abs(get(three).normal[1])).toBeCloseTo(1, 12);
    expect(get(mid).origin[2]).toBeCloseTo(0.5 * IN, 9);
    expect(near(get(cp).p, inch(1, 1, 1))).toBe(true);
  });

  it('deleting a reference plane deletes what is built on it', () => {
    const st = new DocumentStore();
    const pl = F.addRefPlane(st, { kind: 'offset', from: { base: 'XY' }, distance: 1 });
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 1, 1));
    st.updateFeature(sk, { refPlane: pl });
    const ex = st.addExtrude(sk, 1);
    F.addFillet(st, { edges: [{ a: [`${ex}:end`], b: [`${ex}:side:x`] }], radius: 0.1 });
    st.deleteFeature(pl);
    expect(st.state.features.length).toBe(1); // only the fillet remains (it references faces, not features)
  });
});

describe('topological naming', () => {
  it('fillet on a hole edge (Pappus) keeps its edge when the hole moves', () => {
    const st = new DocumentStore();
    st.setParameter('HX', '1');
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 3, 2)), 1, { name: 'Block' });
    const hs = st.addSketch('XY', [{ id: 'hc', kind: 'circle', center: { x: 'HX', y: 1 }, radius: 0.25 }], { name: 'Hole Sketch' });
    st.addExtrude(hs, 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Bore' });
    const t = regen(st).topology!;
    const i = t.edges.findIndex((e) => e.curve === 'circle' && Math.abs(e.mid[2] - IN) < 1e-6);
    F.addFillet(st, { edges: [edgeRefFrom(t, i)], radius: 0.1, name: 'Bore Edge Round' });
    const R = 0.25, r = 0.1, k = 1 - Math.PI / 4;
    const xbar = (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI); // centroid of the removed corner from the edge
    const expected = 6 - Math.PI * R * R - 2 * Math.PI * (R + xbar) * k * r * r;
    expect(rel(vol(st), expected)).toBeLessThan(1e-8);
    st.setParameter('HX', '2');
    expect(rel(vol(st), expected)).toBeLessThan(1e-8);
    const shape = regen(st).shape!;
    const torus = listSubShapes(oc, shape, 'TopAbs_FACE').map((_, j) => entityInfo(oc, shape, 'face', j) as any).filter((f) => f.surface === 'torus');
    expect(torus.length).toBe(1);
  });

  it('a face split in two by a slot: the tie-break point picks the right piece', () => {
    const { st } = block(4, 2, 1);
    const slot = st.addSketch('XY', rectangleEntities(1.75, -1, 0.5, 4), { offset: 1, name: 'Slot Sketch' });
    st.addExtrude(slot, 0.5, { operation: 'cut', direction: 'reverse', name: 'Slot' });
    const t = regen(st).topology!;
    // The block's top face is now two faces with the same name.
    const tops = t.faces.map((f, i) => ({ f, i })).filter(({ f }) => Math.abs(f.center[2] - IN) < 1e-6);
    expect(tops.length).toBe(2);
    expect(tops[0].f.tags).toEqual(tops[1].f.tags);
    // Chamfer the far-right top edge (x = 4): only the right piece has it.
    F.addChamfer(st, { edges: [edgeAt(t, inch(4, 1, 1))], distance: 0.1 });
    expect(rel(vol(st), 8 - 0.5 * 2 * 0.5 - 0.005 * 2)).toBeLessThan(EXACT);
    // Widen the block: the same edge is found again by name plus nearest point.
    st.setParameter('L', '5');
    expect(rel(vol(st), 10 - 0.5 * 2 * 0.5 - 0.005 * 2)).toBeLessThan(EXACT);
    const chId = st.state.features.at(-1)!.id;
    const ch = regen(st).topology!.faces.find((f) => f.tags.some((x) => x.startsWith(`${chId}:blend`)))!;
    expect(ch.center[0] / IN).toBeCloseTo(5 - 0.05, 9);
    expect(ch.center[2] / IN).toBeCloseTo(1 - 0.05, 9);
  });
});
