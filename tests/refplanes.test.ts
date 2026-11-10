/**
 * Mainstream CAD reference plane types "Normal to curve" and "Parallel plane at
 * point", and the sweep-profile workflow they exist for.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities } from '../src/core/model';
import { regenerate, type OC } from '../src/kernel/regen';
import { massProperties } from '../src/kernel/query';
import * as F from '../src/core/featureCommands';

const IN = 25.4;
const PI = Math.PI;
let oc: OC;
beforeAll(async () => { oc = await init(); });
const near = (a: number[], b: number[], tol = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < tol);

function planeOf(st: DocumentStore, id: string) {
  const r = regenerate(oc, st.state);
  const s = r.status.find((x) => x.id === id)!;
  if (!s.ok) throw new Error(s.message);
  const g = r.refGeometry!.find((x) => x.id === id)!;
  if (g.kind !== 'plane') throw new Error('not a plane');
  return { o: g.origin.map((v) => v / IN), n: g.normal, r };
}

describe('reference plane: normal to curve', () => {
  // Quarter arc on Front (XZ): from the origin straight up (+Z), bending to end at (2, 0, 2) heading +X.
  const path = (st: DocumentStore) => st.addSketch('XZ', [{ id: 'p', kind: 'arc', center: { x: 2, y: 0 }, radius: 2, startAngle: 90, endAngle: 180 }], { name: 'Path' });

  it('at either end of the path, square to it', () => {
    const st = new DocumentStore();
    const sk = path(st);
    const a = F.addRefPlane(st, { kind: 'normalToCurve', sketch: sk, at: 'start' });
    const b = F.addRefPlane(st, { kind: 'normalToCurve', sketch: sk, at: 'end' });
    const pa = planeOf(st, a), pb = planeOf(st, b);
    // The chain runs from whichever free end the path finder starts at; the two planes are its two ends.
    const ends = [pa, pb].map((q) => q.o);
    expect(ends.some((o) => near(o, [0, 0, 0])) && ends.some((o) => near(o, [2, 0, 2]))).toBe(true);
    for (const q of [pa, pb]) {
      if (near(q.o, [0, 0, 0])) expect(Math.abs(q.n[2])).toBeCloseTo(1, 12); // square to the path at the bottom: normal +-Z
      else expect(Math.abs(q.n[0])).toBeCloseTo(1, 12); // at the top end: normal +-X
    }
  });

  it('a profile sketched on it sweeps along the path (Pappus)', () => {
    const st = new DocumentStore();
    const sk = path(st);
    const pl = F.addRefPlane(st, { kind: 'normalToCurve', sketch: sk, at: 'end' });
    const prof = st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: 0.25 }], { name: 'Profile' });
    st.updateFeature(prof, { refPlane: pl });
    const sw = F.addSweep(st, { profile: prof, path: sk });
    const r = regenerate(oc, st.state);
    const s = r.status.find((x) => x.id === sw)!;
    expect(s.ok, s.message).toBe(true);
    // The profile must sit on the path end, wherever the plane's in-plane origin is.
    const pr = planeOf(st, pl);
    const circleAtEnd = Math.hypot(...pr.o) < 1e-9 || Math.hypot(pr.o[0] - 2, pr.o[2] - 2) < 1e-9;
    expect(circleAtEnd).toBe(true);
    const v = massProperties(oc, r.shape!).volume / IN ** 3;
    expect(Math.abs(v - PI * 0.0625 * PI) / (PI * 0.0625 * PI)).toBeLessThan(1e-7);
  });
});

describe('reference plane: parallel at point', () => {
  it('through coordinates, and through a reference point', () => {
    const st = new DocumentStore();
    const a = F.addRefPlane(st, { kind: 'parallelAtPoint', from: { base: 'XY' }, point: { x: 3, y: -1, z: 1.5 } });
    const pa = planeOf(st, a);
    expect(pa.o[2]).toBeCloseTo(1.5, 12);
    expect(near(pa.n, [0, 0, 1])).toBe(true);
    const pt = F.addRefPoint(st, { kind: 'coords', p: { x: 0, y: 0.75, z: 0 } });
    const b = F.addRefPlane(st, { kind: 'parallelAtPoint', from: { base: 'XZ' }, point: { refPoint: pt } });
    const pb = planeOf(st, b);
    expect(pb.o[1]).toBeCloseTo(0.75, 12);
    // A block sketched on it starts there.
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 1, 1));
    st.updateFeature(sk, { refPlane: a });
    const ex = st.addExtrude(sk, 0.5);
    const s = regenerate(oc, st.state).status.find((x) => x.id === ex)!;
    expect(s.extent!.min[2] / IN).toBeCloseTo(1.5, 9);
    expect(s.extent!.max[2] / IN).toBeCloseTo(2, 9);
  });

  it('deleting the reference point removes the plane that uses it', () => {
    const st = new DocumentStore();
    const pt = F.addRefPoint(st, { kind: 'coords', p: { x: 0, y: 0, z: 1 } });
    const a = F.addRefPlane(st, { kind: 'parallelAtPoint', from: { base: 'XY' }, point: { refPoint: pt } });
    st.deleteFeature(pt);
    expect(st.feature(a)).toBeUndefined();
  });
});
