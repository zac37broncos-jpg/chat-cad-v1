/**
 * Sweep options from the mainstream CAD Sweep command panel: Circular Profile
 * (no profile sketch) and Profile Orientation (Follow Path / Keep Normal
 * Constant). Volumes vs hand calculations (Pappus; a translated disk sweeps
 * area x path length projected on its normal).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import type { SketchEntity } from '../src/core/model';
import { regenerate, isValid, type OC } from '../src/kernel/regen';
import { massProperties } from '../src/kernel/query';
import * as F from '../src/core/featureCommands';

const IN3 = 25.4 ** 3;
const PI = Math.PI;
let oc: OC;
beforeAll(async () => { oc = await init(); });
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
function vol(st: DocumentStore, id: string) {
  const r = regenerate(oc, st.state);
  const s = r.status.find((x) => x.id === id)!;
  if (!s.ok) throw new Error(s.message);
  expect(isValid(oc, r.shape!)).toBe(true);
  return massProperties(oc, r.shape!).volume / IN3;
}
// Quarter arc on the Front plane (XZ): from the origin straight up (+Z), bending to +X, radius 2.
const quarter = (): SketchEntity[] => [{ id: 'p', kind: 'arc', center: { x: 2, y: 0 }, radius: 2, startAngle: 90, endAngle: 180 }];

describe('sweep circular profile', () => {
  it('a circle of the given diameter along a straight path', () => {
    const st = new DocumentStore();
    const path = st.addSketch('XY', [{ id: 'l', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 3, y: 0 } }], { name: 'Path' });
    const id = F.addSweep(st, { path, circular: { diameter: 0.5 }, name: 'Rod' });
    expect(st.feature(id)).toMatchObject({ profile: '', circular: { diameter: 0.5 } });
    expect(rel(vol(st, id), PI * 0.25 ** 2 * 3)).toBeLessThan(1e-7);
  });

  it('along an arc (Pappus) and along a line + arc chain', () => {
    const st = new DocumentStore();
    const path = st.addSketch('XZ', quarter(), { name: 'Bend' });
    const id = F.addSweep(st, { path, circular: { diameter: 0.2 } });
    expect(rel(vol(st, id), PI * 0.1 ** 2 * (PI * 2) / 2)).toBeLessThan(1e-7);

    const st2 = new DocumentStore();
    const p2 = st2.addSketch('XZ', [
      { id: 'a', kind: 'line', p1: { x: 0, y: -1 }, p2: { x: 0, y: 0 } },
      ...quarter()], { name: 'Hook' });
    const id2 = F.addSweep(st2, { path: p2, circular: { diameter: 0.2 } });
    expect(rel(vol(st2, id2), PI * 0.01 * (1 + PI))).toBeLessThan(1e-7);
  });

  it('cuts a groove', () => {
    const st = new DocumentStore();
    const base = st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: 3 }]);
    st.addExtrude(base, 1);
    // A straight groove across the top face, centred on its edge line z = 1.
    const path = st.addSketch('XY', [{ id: 'l', kind: 'line', p1: { x: -1, y: 0 }, p2: { x: 1, y: 0 } }], { offset: 1 });
    const id = F.addSweep(st, { path, circular: { diameter: 0.5 }, operation: 'cut' });
    expect(rel(vol(st, id), PI * 9 - (PI * 0.0625 * 2) / 2)).toBeLessThan(1e-7);
  });

  it('needs a diameter or a profile', () => {
    const st = new DocumentStore();
    const path = st.addSketch('XY', [{ id: 'l', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 3, y: 0 } }]);
    expect(() => F.addSweep(st, { path })).toThrow(/profile/);
  });
});

describe('sweep profile orientation', () => {
  function bend(orientation?: 'followPath' | 'keepNormal') {
    const st = new DocumentStore();
    const prof = st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: 0.25 }], { name: 'Disk' });
    const path = st.addSketch('XZ', quarter(), { name: 'Bend' });
    const id = F.addSweep(st, { profile: prof, path, orientation });
    return vol(st, id);
  }
  it('follow path keeps the profile square to the path (Pappus)', () => {
    expect(rel(bend(), PI * 0.0625 * PI)).toBeLessThan(1e-7);
    expect(rel(bend('followPath'), PI * 0.0625 * PI)).toBeLessThan(1e-7);
  });
  it('keep normal constant translates the profile (area x rise)', () => {
    expect(rel(bend('keepNormal'), PI * 0.0625 * 2)).toBeLessThan(1e-7);
  });
});

describe('sweep from the AI tools', () => {
  it('circular_diameter and orientation', async () => {
    const { executeTool } = await import('../src/ai/executor');
    const store = new DocumentStore();
    const c = {
      store,
      regen: async () => { const r = regenerate(oc, store.state); return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, ms: 0 }; },
      selection: () => [], info: async () => { throw new Error('unused'); },
    } as any;
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XZ', name: 'Handle Path', entities: [{ type: 'arc', cx: 2, cy: 0, radius: 2, start_angle: 90, end_angle: 180 }] });
    const r: any = await executeTool(c, 'sweep', { path_sketch_id: sk.sketch_id, circular_diameter: 0.2, name: 'Handle' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(parseFloat(r.part.volume)).toBeCloseTo(PI * 0.01 * PI, 6);
    await expect(executeTool(c, 'sweep', { path_sketch_id: sk.sketch_id, profile_sketch_id: sk.sketch_id, circular_diameter: 0.2 })).rejects.toThrow(/not both/);
  });
});
