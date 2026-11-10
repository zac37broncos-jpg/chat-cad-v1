/**
 * Revolve like the mainstream CAD Revolve command panel: Direction 1 Blind /
 * Mid Plane, Reverse, Direction 2, Thin Feature (open and closed), and a
 * solid sketch line as the axis. Volumes are checked against hand
 * calculations (washer rings and Pappus' theorem).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, type SketchEntity } from '../src/core/model';
import { regenerate, isValid, type OC } from '../src/kernel/regen';
import { massProperties } from '../src/kernel/query';
import { thinLoops } from '../src/kernel/features/thin';

const IN = 25.4;
const IN3 = IN ** 3;
const REL = 1e-7;
const PI = Math.PI;
let oc: OC;
beforeAll(async () => { oc = await init(); });

/** Axis along the sketch Y axis (x = 0), as a centerline. */
const axis = (construction = true): SketchEntity => ({ id: 'ax', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 }, construction });

function build(entities: SketchEntity[], opts: Parameters<DocumentStore['addRevolve']>[3] = {}, angle: number | string = 360) {
  const st = new DocumentStore();
  const sk = st.addSketch('XY', entities, { name: 'Profile' });
  const id = st.addRevolve(sk, 'ax', angle, opts);
  return { st, id };
}
function result(st: DocumentStore, id: string) {
  const r = regenerate(oc, st.state);
  const s = r.status.find((x) => x.id === id)!;
  if (!s.ok) throw new Error(s.message);
  expect(isValid(oc, r.shape!)).toBe(true);
  return { vol: massProperties(oc, r.shape!).volume / IN3, extent: s.extent!, r };
}
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
// Ring x in [1, 2], y in [0, 1] revolved about the Y axis: 3*pi per full turn.
const ring = () => [axis(), ...rectangleEntities(1, 0, 1, 1)];

describe('revolve directions', () => {
  it('blind 90 degrees: a quarter of the ring, turning toward -Z (right-hand rule about the axis)', () => {
    const { st, id } = build(ring(), {}, 90);
    const { vol, extent } = result(st, id);
    expect(rel(vol, (3 * PI) / 4)).toBeLessThan(REL);
    expect(extent.min[2] / IN).toBeCloseTo(-2, 9);
    expect(extent.max[2] / IN).toBeCloseTo(0, 9);
  });

  it('reverse direction turns the other way', () => {
    const { st, id } = build(ring(), { reverse: true }, 90);
    const { vol, extent } = result(st, id);
    expect(rel(vol, (3 * PI) / 4)).toBeLessThan(REL);
    expect(extent.min[2] / IN).toBeCloseTo(0, 9);
    expect(extent.max[2] / IN).toBeCloseTo(2, 9);
  });

  it('mid plane splits the angle equally about the sketch plane', () => {
    const { st, id } = build(ring(), { end: 'midPlane' }, 90);
    const { vol, extent } = result(st, id);
    expect(rel(vol, (3 * PI) / 4)).toBeLessThan(REL);
    expect(extent.min[2] / IN).toBeCloseTo(-2 * Math.SQRT1_2, 9);
    expect(extent.max[2] / IN).toBeCloseTo(2 * Math.SQRT1_2, 9);
  });

  it('direction 2 adds a blind angle the other way', () => {
    const { st, id } = build(ring(), { angle2: 45 }, 90);
    const { vol, extent } = result(st, id);
    expect(rel(vol, 3 * PI * (135 / 360))).toBeLessThan(REL);
    expect(extent.min[2] / IN).toBeCloseTo(-2, 9);
    expect(extent.max[2] / IN).toBeCloseTo(2 * Math.SQRT1_2, 9);
  });

  it('refuses more than 360 degrees in total and Direction 2 with Mid Plane', () => {
    const { st, id } = build(ring(), { angle2: 200 }, 200);
    const s = regenerate(oc, st.state).status.find((x) => x.id === id)!;
    expect(s.ok).toBe(false);
    expect(s.message).toMatch(/360/);
    expect(() => build(ring(), { end: 'midPlane', angle2: 10 })).toThrow(/Mid Plane/);
  });

  it('cut-revolve with Direction 2 removes exactly that sector', () => {
    const st = new DocumentStore();
    const base = st.addSketch('XY', [axis(), ...rectangleEntities(0, 0, 3, 1)], { name: 'Base' });
    st.addRevolve(base, 'ax', 360); // cylinder r = 3, h = 1
    const cutSk = st.addSketch('XY', [axis(), ...rectangleEntities(1, 0, 1, 1)], { name: 'Groove' });
    const id = st.addRevolve(cutSk, 'ax', 30, { operation: 'cut', angle2: 60 });
    const { vol } = result(st, id);
    expect(rel(vol, 9 * PI - 3 * PI * (90 / 360))).toBeLessThan(REL);
  });
});

describe('revolve axis', () => {
  it('a solid line that is an edge of the profile works as the axis (cylinder)', () => {
    const ents = rectangleEntities(0, 0, 1, 1);
    // rectangleEntities: the 4th line runs (0,1) -> (0,0), along the axis.
    const st = new DocumentStore();
    const sk = st.addSketch('XY', ents);
    const id = st.addRevolve(sk, ents[3].id, 360);
    expect(rel(result(st, id).vol, PI)).toBeLessThan(REL);
  });

  it('a stand-alone solid line works as the axis', () => {
    const { st, id } = build([axis(false), ...rectangleEntities(1, 0, 1, 1)]);
    expect(rel(result(st, id).vol, 3 * PI)).toBeLessThan(REL);
  });

  it('an open profile without Thin Feature is a clear error', () => {
    const { st, id } = build([axis(), { id: 'w', kind: 'line', p1: { x: 1, y: 0 }, p2: { x: 1, y: 1 } }]);
    const s = regenerate(oc, st.state).status.find((x) => x.id === id)!;
    expect(s.ok).toBe(false);
    expect(s.message).toMatch(/Thin Feature/);
  });
});

describe('thin revolve', () => {
  // A vertical wall line x = 1 from y = 0 to 1, drawn upward: its left side is toward the axis.
  const wall = (): SketchEntity[] => [axis(), { id: 'w', kind: 'line', p1: { x: 1, y: 0 }, p2: { x: 1, y: 1 } }];
  const tube = (ri: number, ro: number) => PI * (ro * ro - ri * ri);

  it('one direction, reversed, mid plane and two direction thicknesses', () => {
    const cases: [Parameters<DocumentStore['addRevolve']>[3], number][] = [
      [{ thin: { type: 'oneDirection', thickness: 0.1 } }, tube(0.9, 1)],
      [{ thin: { type: 'oneDirection', thickness: 0.1, reverse: true } }, tube(1, 1.1)],
      [{ thin: { type: 'midPlane', thickness: 0.1 } }, tube(0.95, 1.05)],
      [{ thin: { type: 'twoDirection', thickness: 0.1, thickness2: 0.05 } }, tube(0.9, 1.05)],
    ];
    for (const [opts, expected] of cases) {
      const { st, id } = build(wall(), opts);
      expect(rel(result(st, id).vol, expected)).toBeLessThan(REL);
    }
  });

  it('an L-shaped open chain gets a sharp inside corner', () => {
    const ents: SketchEntity[] = [axis(),
      { id: 'a', kind: 'line', p1: { x: 1, y: 0 }, p2: { x: 2, y: 0 } },
      { id: 'b', kind: 'line', p1: { x: 2, y: 0 }, p2: { x: 2, y: 1 } }];
    const { st, id } = build(ents, { thin: { type: 'oneDirection', thickness: 0.1 } });
    // Floor x 1..2, y 0..0.1 plus wall x 1.9..2, y 0.1..1.
    expect(rel(result(st, id).vol, 0.1 * tube(1, 2) + 0.9 * tube(1.9, 2))).toBeLessThan(REL);
  });

  it('arcs are offset exactly (Pappus)', () => {
    const ents: SketchEntity[] = [axis(), { id: 'c', kind: 'arc', center: { x: 2, y: 0 }, radius: 1, startAngle: 0, endAngle: 180 }];
    const { st, id } = build(ents, { thin: { type: 'midPlane', thickness: 0.2 } });
    const area = (PI / 2) * (1.1 ** 2 - 0.9 ** 2);
    expect(rel(result(st, id).vol, 2 * PI * 2 * area)).toBeLessThan(REL);
  });

  it('a closed profile becomes a hollow wall: inside by default, outside when reversed', () => {
    const ents: SketchEntity[] = [axis(), { id: 'c', kind: 'circle', center: { x: 2, y: 0 }, radius: 0.5 }];
    let b = build(ents, { thin: { type: 'oneDirection', thickness: 0.1 } });
    expect(rel(result(b.st, b.id).vol, 2 * PI * 2 * PI * (0.25 - 0.16))).toBeLessThan(REL);
    b = build(ents, { thin: { type: 'oneDirection', thickness: 0.1, reverse: true } });
    expect(rel(result(b.st, b.id).vol, 2 * PI * 2 * PI * (0.36 - 0.25))).toBeLessThan(REL);
  });

  it('a closed rectangle thin wall with direction 2 angle', () => {
    const { st, id } = build([axis(), ...rectangleEntities(1, 0, 1, 1)], { thin: { type: 'oneDirection', thickness: 0.1 }, angle2: 90 }, 90);
    // Square ring 1x1 minus 0.8x0.8, both centred at x = 1.5: area 0.36, half a turn.
    expect(rel(result(st, id).vol, 0.5 * 2 * PI * 1.5 * 0.36)).toBeLessThan(REL);
  });

  it('refuses a thickness larger than an arc radius', () => {
    const ents: SketchEntity[] = [axis(), { id: 'c', kind: 'arc', center: { x: 2, y: 0 }, radius: 0.1, startAngle: 0, endAngle: 180 }];
    const { st, id } = build(ents, { thin: { type: 'oneDirection', thickness: 0.2 } });
    const s = regenerate(oc, st.state).status.find((x) => x.id === id)!;
    expect(s.ok).toBe(false);
    expect(s.message).toMatch(/radius/);
  });
});

describe('thinLoops (2D)', () => {
  it('joins an obtuse corner with the exact intersection', () => {
    // Two lines meeting at 135 degrees, offset 1 to the left.
    const loops = thinLoops([
      { id: 'a', kind: 'line', a: [0, 0], b: [10, 0], construction: false },
      { id: 'b', kind: 'line', a: [10, 0], b: [20, 10], construction: false },
    ], 1, 0);
    expect(loops).toHaveLength(1);
    const pts = loops[0].entities.flatMap((e) => (e.kind === 'line' ? [e.a, e.b] : []));
    // Left offset corner: y = 1 meets the line x - y = 10 shifted by 1 to its left: x - y = 10 - sqrt(2).
    const want: [number, number] = [11 - Math.SQRT2, 1];
    expect(pts.some((p) => Math.hypot(p[0] - want[0], p[1] - want[1]) < 1e-12)).toBe(true);
  });
});

describe('revolve from the AI tools', () => {
  it('thin cup wall from an open outline, mid plane angle, and update_feature', async () => {
    const { executeTool } = await import('../src/ai/executor');
    const store = new DocumentStore();
    const c = {
      store,
      regen: async () => { const r = regenerate(oc, store.state); return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, ms: 0 }; },
      selection: () => [],
      info: async () => { throw new Error('unused'); },
    } as any;
    // Cup outline: bottom from the axis out to r = 1, then the wall up to 2.
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XZ', name: 'Cup Outline', entities: [
      { type: 'line', x1: 0, y1: -1, x2: 0, y2: 3, construction: true },
      { type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 },
      { type: 'line', x1: 1, y1: 0, x2: 1, y2: 2 }] });
    const r: any = await executeTool(c, 'revolve', { sketch_id: sk.sketch_id, name: 'Cup', thin: { type: 'oneDirection', thickness: 0.1 } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // Left of the chain: above the bottom, inside the wall. Bottom disk r 0..0.9 x 0.1 plus wall r 0.9..1 x 2.
    expect(parseFloat(r.part.volume)).toBeCloseTo(PI * 0.81 * 0.1 + PI * (1 - 0.81) * 2, 6);
    const u: any = await executeTool(c, 'update_feature', { feature_id: r.feature_id ?? 'Cup', changes: { angle: 180, end: 'midPlane' } });
    expect(u.ok, JSON.stringify(u)).toBe(true);
    expect(parseFloat(u.part.volume)).toBeCloseTo((PI * 0.81 * 0.1 + PI * (1 - 0.81) * 2) / 2, 6);
  });
});
