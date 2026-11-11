/**
 * Changing the document units must never change the part
 * (docs/UNITS_AND_FRACTIONS.md): a 3.1417 in plate stays a
 * 3.1417 in plate (79.79918 mm) when the units menu or set_units goes to mm.
 * Values are compared bit for bit: a unit change only writes units out, it
 * never rounds anything.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import init from 'replicad-opencascadejs';
import { DocumentStore, resolveParams } from '../src/core/store';
import { rectangleEntities, newId, type CadDocument } from '../src/core/model';
import { regenerate, type OC } from '../src/kernel/regen';
import { massProperties } from '../src/kernel/query';
import { edgeRefFrom, faceRefFrom } from '../src/kernel/naming';
import * as F from '../src/core/featureCommands';
import { evalLength, pinDocumentUnit } from '../src/core/units';
import { convertDocumentUnits, LENGTH_FIELDS, COUNT_FIELDS, ANGLE_FIELDS } from '../src/core/unitSwitch';
import { executeTool, type ExecutorContext } from '../src/ai/executor';

let oc: OC;
beforeAll(async () => { oc = await init(); });

function build(doc: CadDocument) {
  const r = regenerate(oc, doc);
  const bad = r.status.filter((s) => !s.ok);
  if (bad.length) throw new Error(JSON.stringify(bad));
  return massProperties(oc, r.shape!);
}

/**
 * Switch in -> mm -> in (or the other way) and check the solid is the same
 * at every step, bit for bit. Also check that the converted document no
 * longer depends on its unit at all: reading it with the other unit (no
 * conversion) gives the same solid, which proves no length was missed.
 */
function expectSameSizeThroughUnitChanges(st: DocumentStore) {
  const first = st.state.units, other = first === 'in' ? 'mm' : 'in';
  const ref = build(st.state);
  st.setUnits(other);
  expect(st.state.units).toBe(other);
  expect(build(st.state)).toEqual(ref);
  const raw = { ...st.state, units: first } as CadDocument; // no conversion: must not matter any more
  expect(build(raw)).toEqual(ref);
  st.setUnits(first);
  expect(build(st.state)).toEqual(ref);
  return ref;
}

const topFaceAt = (t: any, p: [number, number, number]) => faceRefFrom(t, t.faces.findIndex((f: any) => Math.hypot(f.center[0] - p[0], f.center[1] - p[1], f.center[2] - p[2]) < 1e-6));
const edgeAt = (t: any, p: [number, number, number]) => edgeRefFrom(t, t.edges.findIndex((e: any) => Math.hypot(e.mid[0] - p[0], e.mid[1] - p[1], e.mid[2] - p[2]) < 1e-6));

describe('changing units keeps the part the same size', () => {
  it('a 3.1417 x 1.7325 x 0.375 in stays that size in mm, and its numbers get their unit written out', () => {
    const st = new DocumentStore();
    st.setParameter('L', '3.1417');
    const sk = st.addSketch('XY', [...rectangleEntities(0, 0, 'L', 1.7325), { id: newId('ci'), kind: 'circle', center: { x: 1, y: 0.8 }, radius: '0.1875/2' }]);
    st.addExtrude(sk, 0.375);
    const ref = build(st.state);
    expect(ref.volume / 25.4 ** 3).toBeCloseTo((3.1417 * 1.7325 - Math.PI * 0.09375 ** 2) * 0.375, 12);

    st.setUnits('mm');
    expect(build(st.state)).toEqual(ref);
    expect(st.state.params).toEqual([{ name: 'L', expr: '3.1417 in' }]);
    const ex = st.state.features[1] as any;
    expect(ex.depth).toBe('0.375 in');
    const circle = (st.state.features[0] as any).entities[4];
    expect(circle.radius).toBe('(0.1875/2) in');
    expect(circle.center).toEqual({ x: '1 in', y: '0.8 in' });
    // New plain numbers now mean mm, like the menu says.
    expect(evalLength('10', st.state.units, resolveParams(st.state))).toBe(10);
    expect(evalLength('L', st.state.units, resolveParams(st.state))).toBe(3.1417 * 25.4);

    // Undo puts the document back exactly.
    st.undo();
    expect(st.state.units).toBe('in');
    expect(st.state.params).toEqual([{ name: 'L', expr: '3.1417' }]);
    expect(build(st.state)).toEqual(ref);
  });

  it('mm part to inches keeps every millimetre, also for values with no exact inch decimal', () => {
    const st = new DocumentStore(); st.setUnits('mm');
    st.setParameter('T', '7');
    const sk = st.addSketch('XY', rectangleEntities(5, -3, 50.001, 'T*3 + 0.002'));
    st.addExtrude(sk, 'T + 1');
    const ref = expectSameSizeThroughUnitChanges(st);
    expect(ref.bboxMax[0] - ref.bboxMin[0]).toBeCloseTo(50.001, 9);
    st.setUnits('in');
    const ex = st.state.features[1] as any;
    expect(ex.depth).toBe('T + 1 mm');
    expect(st.state.params[0].expr).toBe('7 mm');
  });

  it('expressions that mix a parameter and a plain number, offsets, both directions and thin features', () => {
    const st = new DocumentStore();
    st.setParameter('W', '2');
    st.setParameter('wall', '1/16"');
    const sk = st.addSketch('XY', rectangleEntities('-W/2', 0.25, 'W + 0.5', '(W) - 0.75'), { offset: 0.1 });
    st.addExtrude(sk, '0.4 + wall', { direction: 'normal', depth2: 0.3, startOffset: 0.05 } as any);
    const sk2 = st.addSketch('XZ', [
      { id: 'ax', kind: 'line', p1: { x: 3, y: 0 }, p2: { x: 3, y: 1 }, construction: true },
      { id: newId('ln'), kind: 'line', p1: { x: 3.5, y: 0 }, p2: { x: 3.5, y: 0.75 } },
    ]);
    st.addRevolve(sk2, 'ax', 180, { operation: 'add', thin: { type: 'twoDirection', thickness: 0.05, thickness2: 'wall' } });
    expectSameSizeThroughUnitChanges(st);
  });

  it('fillet, chamfer, holes on an offset plane, patterns with counts, mirror, shell and reference planes', () => {
    const st = new DocumentStore();
        st.setParameter('gap', '0.6');
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 4, 2));
    st.addExtrude(sk, 1);
    let t = regenerate(oc, st.state).topology!;
    F.addFillet(st, { edges: [edgeAt(t, [4 * 25.4, 2 * 25.4, 12.7])], radius: 0.125 });
    F.addChamfer(st, { kind: 'distances', edges: [edgeAt(t, [0, 0, 12.7])], distance: 0.1, distance2: '0.05 + 0.02' } as any);
    const h = F.addHole(st, { holeType: 'counterbore', standard: 'ansi-inch', size: '1/4', end: 'blind', depth: 0.6, cboreDiameter: 0.45, cboreDepth: '0.2', placement: { base: 'XY', offset: 1 }, points: [{ x: 0.5, y: 0.5 }] } as any);
    F.addLinearPattern(st, { features: [h], dir1: { axis: 'X' }, spacing1: 'gap', count1: 3, dir2: { axis: 'Y' }, spacing2: 1, count2: '1 + 1' } as any);
    const p = F.addRefPlane(st, { kind: 'offset', from: { base: 'YZ', offset: 0.5 }, distance: 1.5 });
    const sk3 = st.addSketch('XY', [{ id: newId('ci'), kind: 'circle', center: { x: 3.4, y: 1 }, radius: 0.1 }]);
    const cut = st.addExtrude(sk3, 0.5, { operation: 'cut', direction: 'reverse' } as any);
    F.addCircularPattern(st, { features: [cut], axis: { axis: 'Z' }, count: 2, angle: 30, equalSpacing: false } as any);
    t = regenerate(oc, st.state).topology!;
    void p; void t;
    expectSameSizeThroughUnitChanges(st);
    F.addMirror(st, { body: true, plane: { base: 'YZ', offset: -0.25 } });
    t = regenerate(oc, st.state).topology!;
    expectSameSizeThroughUnitChanges(st);
  });

  it('shell and loft with an end point', () => {
    const st = new DocumentStore();
    const a = st.addSketch('XY', rectangleEntities(-1, -1, 2, 2));
    st.addExtrude(a, 1.5);
    const t = regenerate(oc, st.state).topology!;
    F.addShell(st, { faces: [topFaceAt(t, [0, 0, 1.5 * 25.4])], thickness: '0.08' });
    expectSameSizeThroughUnitChanges(st);

    const s2 = new DocumentStore();
    const c1 = s2.addSketch('XY', [{ id: newId('ci'), kind: 'circle', center: { x: 0, y: 0 }, radius: 1 }]);
    const c2 = s2.addSketch('XY', [{ id: newId('ci'), kind: 'circle', center: { x: 0, y: 0 }, radius: '0.5' }], { offset: 1 });
    F.addLoft(s2, { profiles: [c1, c2], endPoint: { x: 0, y: 0, z: 1.5 } });
    expectSameSizeThroughUnitChanges(s2);
  });

  it('sweep, rib, draft, reference points, axes and planes, and up-to-surface ends', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 1)), 0.25, { name: 'Base' });
    st.addExtrude(st.addSketch('XY', [...rectangleEntities(0, 0, 0.25, 1), ...rectangleEntities(3.75, 0, 0.25, 1)], { offset: 0.25 }), 2, { name: 'Walls' });
    const rs = st.addSketch('XZ', [{ id: newId('ln'), kind: 'line', p1: { x: 1, y: 1.5 }, p2: { x: 3, y: 1.5 } }], { offset: -0.5 });
    F.addRib(st, { sketch: rs, thickness: 0.2 });
    const path = st.addSketch('XY', [{ id: 'l', kind: 'line', p1: { x: 0, y: -1 }, p2: { x: 3, y: -1 } }]);
    F.addSweep(st, { path, circular: { diameter: '0.5' }, operation: 'add' });
    const pt = F.addRefPoint(st, { kind: 'coords', p: { x: 9, y: 9, z: -0.4 } });
    const pl = F.addRefPlane(st, { kind: 'threePoints', points: [{ x: 0, y: 0, z: 2.5 }, { x: 1, y: 0, z: 2.5 }, { x: 0, y: 1, z: 3 }] });
    const pl2 = F.addRefPlane(st, { kind: 'parallelAtPoint', from: { base: 'XY' }, point: { x: 0, y: 0, z: 3.5 } });
    F.addRefAxis(st, { kind: 'twoPoints', p1: { x: 2, y: 0.5, z: 0 }, p2: { x: 2, y: 0.5, z: 1 } });
    st.addExtrude(st.addSketch('XY', rectangleEntities(1.5, 0.25, 1, 0.5), { refPlane: pl2 }), 0.1, { direction: 'reverse', upTo: { kind: 'surface', surface: { refPlane: pl }, offset: 0.1 } } as any);
    st.addExtrude(st.addSketch('XY', rectangleEntities(5, 0, 1, 1)), 1, { upTo2: { kind: 'vertex', vertex: { refPoint: pt } } } as any);
    st.addExtrude(st.addSketch('XY', rectangleEntities(7, 0, 1, 1)), 1, { upTo2: { kind: 'surface', surface: { base: 'XY', offset: -0.75 } } } as any);
    expectSameSizeThroughUnitChanges(st);

    const d = new DocumentStore();
    d.addExtrude(d.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1);
    const t = regenerate(oc, d.state).topology!;
    const sides = [[12.7, 0, 12.7], [25.4, 12.7, 12.7], [12.7, 25.4, 12.7], [0, 12.7, 12.7]].map((p) => topFaceAt(t, p as any));
    F.addDraft(d, { faces: sides, neutral: { base: 'XY', offset: 0.25 }, angle: 5 });
    expectSameSizeThroughUnitChanges(d);
  });

  it('sketch dimensions keep their size; angle dimensions and arc angles are left alone', () => {
    const st = new DocumentStore();
    const sk = st.addSketch('XY', [
      { id: 'l1', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 2, y: 0 } },
      { id: 'a1', kind: 'arc', center: { x: 0, y: 0 }, radius: 2, startAngle: 0, endAngle: 90 },
      { id: 'l2', kind: 'line', p1: { x: 0, y: 2 }, p2: { x: 0, y: 0 } },
    ]);
    st.editSketch(sk, 'dims', (s) => {
      s.constraints = [
        { id: 'c1', type: 'coincident', a: { e: 'l1', p: 'start' }, b: { e: 'origin', p: 'point' } },
        { id: 'd1', type: 'distance', a: { e: 'l1', p: 'start' }, b: { e: 'l1', p: 'end' }, value: '2', text: [0.5, 0.25] },
        { id: 'd2', type: 'angle', a: 'l1', b: 'l2', value: 90, sense: 1 },
      ];
    });
    st.setUnits('mm');
    const f = st.state.features[0] as any;
    expect(f.constraints[1].value).toBe('2 in');
    expect(f.constraints[1].text).toEqual([0.5 * 25.4, 0.25 * 25.4]);
    expect(f.constraints[2].value).toBe(90);
    expect(f.entities[1].startAngle).toBe(0);
    expect(f.entities[1].endAngle).toBe(90);
    expect(f.entities[1].radius).toBe('2 in');
  });

  it('a plain-number parameter used only as an angle ("lean deg") is left as it is', () => {
    const st = new DocumentStore();
    st.setParameter('lean', '20');
    st.setParameter('W', '2');
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 'W * cos(lean deg)', 1));
    st.addExtrude(sk, 1);
    const ref = build(st.state);
    st.setUnits('mm');
    expect(st.state.params).toEqual([{ name: 'lean', expr: '20' }, { name: 'W', expr: '2 in' }]);
    expect(build(st.state)).toEqual(ref);
  });

  it('refuses to change units, changing nothing, when a value cannot be read', () => {
    const st = new DocumentStore();
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 2, 1));
    st.addExtrude(sk, 'missing_param + 1', { name: 'Boss' });
    const before = st.serialize();
    expect(() => st.setUnits('mm')).toThrow(/Units were not changed: Boss depth/);
    expect(st.serialize()).toBe(before);
    expect(() => st.setUnits('cm' as any)).toThrow(/Unknown units/);
  });

  it('saving after a unit change keeps the size: the saved file reads back the same', () => {
    const st = new DocumentStore();
    st.setParameter('L', '3.1417');
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 'L', 1.7325)), 0.375);
    const ref = build(st.state);
    st.setUnits('mm');
    const loaded = new DocumentStore();
    loaded.load(JSON.parse(st.serialize()));
    expect(loaded.state.units).toBe('mm');
    expect(build(loaded.state)).toEqual(ref);
  });

  it('pinDocumentUnit writes the unit only where the old unit was used, and keeps 0 and angle-free parts as typed', () => {
    const W = { v: 50.8, dim: 'length' as const };
    const cases: [string, string][] = [
      ['3.1417', '3.1417 in'], ['W + 5', 'W + 5 in'], ['(5) + (W)', '(5 in) + (W)'], ['(0) + (W)', '(0) + (W)'],
      ['2*W', '2*W'], ['W/2', 'W/2'], ['0', '0'], ['-3', '-3 in'], ['1/4', '(1/4) in'], ['1/4"', '1/4"'],
      ['(0) + (2.5)', '((0) + (2.5)) in'], ['W - (2*3)', 'W - (2*3) in'], ['10 mm + 2', '10 mm + 2 in'],
    ];
    for (const [src, want] of cases) {
      const got = pinDocumentUnit(src, 'in', { W }, 'length');
      expect(got, src).toBe(want);
      for (const u of ['in', 'mm'] as const) expect(evalLength(got, u, { W }), `${src} in ${u}`).toBe(evalLength(src, 'in', { W }));
    }
  });

  it('every length, count and angle field in the document model is handled by the unit change', () => {
    const src = ['../src/core/model.ts', '../src/core/featureTypes.ts'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n').split('\n').filter((l) => !/\bfunction\b/.test(l)).join('\n');
    const known = new Set<string>([...LENGTH_FIELDS, ...COUNT_FIELDS, ...ANGLE_FIELDS]);
    const fields = [...src.matchAll(/(\w+)\??:\s*(?:ValueExpr|Vec2Expr|Vec3Expr|PlaneSpec|\{\s*x:\s*ValueExpr|\[Vec3Expr|Vec3Expr \||TextOffset)/g)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(40);
    const missing = [...new Set(fields)].filter((f) => !known.has(f) && f !== 'text');
    expect(missing, 'add these fields to src/core/unitSwitch.ts (and convert them there)').toEqual([]);
  });
});

describe('the chat set_units tool keeps the part', () => {
  function ctx(store: DocumentStore): ExecutorContext {
    return {
      store,
      regen: async () => {
        const r = regenerate(oc, store.state);
        return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, ms: 0 };
      },
      selection: () => [],
      info: async () => { throw new Error('unused'); },
    };
  }
  it('set_units mm on a finished inch part: same volume, shown in mm', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    await executeTool(c, 'set_parameter', { name: 'L', value: '3.1417' });
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', entities: [{ type: 'rectangle', x: 0, y: 0, width: 'L', height: 1.7325 }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: 0.375 });
    expect(ex.ok).toBe(true);
    const m: any = await executeTool(c, 'set_units', { units: 'mm' });
    expect(m.part.bounding_box.x).toBe('79.799180 mm');
    expect(parseFloat(m.part.volume)).toBeCloseTo(3.1417 * 1.7325 * 0.375 * 25.4 ** 3, 4);
    const back: any = await executeTool(c, 'set_units', { units: 'in' });
    expect(back.part.bounding_box.x).toBe('3.141700 in');
  });
});

void convertDocumentUnits;
