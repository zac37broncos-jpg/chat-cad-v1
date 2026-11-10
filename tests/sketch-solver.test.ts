import { describe, it, expect, beforeAll } from 'vitest';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { analyze, makeContext } from '../src/sketch/equations';
import type { WEntity, WSketch } from '../src/sketch/geom';
import type { SketchConstraint } from '../src/core/model';

let S: SketchSolver;
beforeAll(async () => { S = await createSketchSolver(); });

const L = (id: string, a: [number, number], b: [number, number]): WEntity => ({ id, kind: 'line', a, b, construction: false });
const ws = (entities: WEntity[], constraints: SketchConstraint[], values: Record<string, number> = {}): WSketch =>
  ({ entities, constraints, values: new Map(Object.entries(values)) });

function rect(): WSketch {
  const e = [L('l1', [0.3, 0.1], [90, 2]), L('l2', [90, 2], [92, 45]), L('l3', [92, 45], [1, 44]), L('l4', [1, 44], [0.3, 0.1])];
  const c: SketchConstraint[] = [
    { id: 'c1', type: 'coincident', a: { e: 'l1', p: 'end' }, b: { e: 'l2', p: 'start' } },
    { id: 'c2', type: 'coincident', a: { e: 'l2', p: 'end' }, b: { e: 'l3', p: 'start' } },
    { id: 'c3', type: 'coincident', a: { e: 'l3', p: 'end' }, b: { e: 'l4', p: 'start' } },
    { id: 'c4', type: 'coincident', a: { e: 'l4', p: 'end' }, b: { e: 'l1', p: 'start' } },
    { id: 'h1', type: 'horizontal', e: 'l1' }, { id: 'h2', type: 'horizontal', e: 'l3' },
    { id: 'v1', type: 'vertical', e: 'l2' }, { id: 'v2', type: 'vertical', e: 'l4' },
  ];
  return ws(e, c);
}

describe('sketch solver (planegcs + our verification)', () => {
  it('rectangle with relations only is under defined by 4 DOF', () => {
    const r = S.status(rect());
    expect(r.result.ok).toBe(true);
    expect(r.status.state).toBe('under');
    expect(r.status.dof).toBe(4);
    expect(r.result.dof).toBe(4);
  });
  it('fully defined rectangle: exact 4 x 2 in, anchored at origin', () => {
    const w = rect();
    w.constraints.push(
      { id: 'o', type: 'coincident', a: { e: 'l1', p: 'start' }, b: { e: 'origin', p: 'point' } },
      { id: 'dw', type: 'distance', a: { e: 'l1', p: 'start' }, b: { e: 'l1', p: 'end' }, value: 4 },
      { id: 'dh', type: 'distance', a: { e: 'l2', p: 'start' }, b: { e: 'l2', p: 'end' }, value: 2 },
    );
    w.values.set('dw', 4 * 25.4); w.values.set('dh', 2 * 25.4);
    const r = S.status(w);
    expect(r.result.ok).toBe(true);
    expect(r.status.state).toBe('full');
    expect(r.analysis!.defined.size).toBe(4);
    const l1 = r.result.entities[0] as any, l2 = r.result.entities[1] as any;
    expect(Math.abs(l1.a[0])).toBeLessThan(1e-9);
    expect(Math.abs(l1.b[0] - 101.6)).toBeLessThan(1e-9);
    expect(Math.abs(l2.b[1] - 50.8)).toBeLessThan(1e-9);
    expect(r.result.maxResidual).toBeLessThan(1e-9);
  });
  it('partially anchored: only the anchored line is fully defined', () => {
    const w = ws([L('a', [0, 0], [10, 1]), L('b', [20, 5], [30, 9])], [
      { id: 'o', type: 'coincident', a: { e: 'a', p: 'start' }, b: { e: 'origin', p: 'point' } },
      { id: 'h', type: 'horizontal', e: 'a' },
      { id: 'd', type: 'distance', a: { e: 'a', p: 'start' }, b: { e: 'a', p: 'end' }, value: 10 },
    ], { d: 10 });
    const r = S.status(w);
    expect(r.status.dof).toBe(4);
    expect([...r.analysis!.defined]).toEqual(['a']);
  });
  it('detects conflicting relations and refuses the solve', () => {
    const w = ws([L('a', [0, 0], [10, 1])], [
      { id: 'h', type: 'horizontal', e: 'a' }, { id: 'v', type: 'vertical', e: 'a' },
      { id: 'd', type: 'distance', a: { e: 'a', p: 'start' }, b: { e: 'a', p: 'end' }, value: 5 },
    ], { d: 5 });
    const r = S.status(w);
    expect(r.result.ok).toBe(false);
    expect(r.status.state).toBe('over');
    expect(r.result.conflicting.length).toBeGreaterThan(0);
  });
  it('detects redundant relations', () => {
    const w = ws([L('a', [0, 0], [10, 1])], [
      { id: 'h', type: 'horizontal', e: 'a' },
      { id: 'h2', type: 'horizontalPoints', a: { e: 'a', p: 'start' }, b: { e: 'a', p: 'end' } },
    ]);
    const r = S.status(w);
    expect(r.status.state).toBe('over');
  });
  it('circle tangent to a line, arc tangent, angle and h/v distances', () => {
    const w = ws([
      L('base', [0, 0], [100, 3]),
      { id: 'k', kind: 'circle', c: [50, 20], r: 15, construction: false },
      L('slant', [0, 0], [50, 40]),
      { id: 'arc', kind: 'arc', c: [120, 30], r: 10, a0: 0, a1: Math.PI / 2, construction: false },
    ], [
      { id: 'o', type: 'coincident', a: { e: 'base', p: 'start' }, b: { e: 'origin', p: 'point' } },
      { id: 'hz', type: 'horizontal', e: 'base' },
      { id: 't', type: 'tangent', a: 'base', b: 'k' },
      { id: 'r', type: 'diameter', e: 'k', value: 1 },
      { id: 'cx', type: 'distance', a: { e: 'origin', p: 'point' }, b: { e: 'k', p: 'center' }, dir: 'h', value: 2 },
      { id: 'sc', type: 'coincident', a: { e: 'slant', p: 'start' }, b: { e: 'origin', p: 'point' } },
      { id: 'an', type: 'angle', a: 'base', b: 'slant', value: 30, sense: 1 },
      { id: 'ar', type: 'radius', e: 'arc', value: 0.5 },
      { id: 'tk', type: 'tangent', a: 'arc', b: 'k' },
    ], { r: 25.4, cx: 50.8, an: Math.PI / 6, ar: 12.7 });
    const r = S.solve(w);
    expect(r.ok).toBe(true);
    const k = r.entities[1] as any, sl = r.entities[2] as any, arc = r.entities[3] as any;
    expect(k.r).toBeCloseTo(12.7, 10);
    expect(k.c[0]).toBeCloseTo(50.8, 10);
    expect(Math.abs(k.c[1])).toBeCloseTo(12.7, 10);
    expect(Math.atan2(sl.b[1] - sl.a[1], sl.b[0] - sl.a[0])).toBeCloseTo(Math.PI / 6, 12);
    expect(Math.hypot(arc.c[0] - k.c[0], arc.c[1] - k.c[1])).toBeCloseTo(25.4, 9);
  });
  it('impossible dimensions fail instead of approximating', () => {
    // Triangle with sides 10, 10, 30: impossible.
    const e = [L('a', [0, 0], [10, 0]), L('b', [10, 0], [5, 8]), L('c', [5, 8], [0, 0])];
    const co = (id: string, x: string, y: string): SketchConstraint => ({ id, type: 'coincident', a: { e: x, p: 'end' }, b: { e: y, p: 'start' } });
    const d = (id: string, l: string): SketchConstraint => ({ id, type: 'distance', a: { e: l, p: 'start' }, b: { e: l, p: 'end' }, value: 0 });
    const w = ws(e, [co('1', 'a', 'b'), co('2', 'b', 'c'), co('3', 'c', 'a'), d('da', 'a'), d('db', 'b'), d('dc', 'c')], { da: 10, db: 10, dc: 30 });
    const r = S.solve(w);
    expect(r.ok).toBe(false);
  });
  it('drag moves an under-defined point and keeps relations', () => {
    const w = ws([L('a', [0, 0], [10, 0])], [{ id: 'h', type: 'horizontal', e: 'a' }]);
    const r = S.solve(w, [{ ref: { e: 'a', p: 'end' }, to: [20, 5] }]);
    expect(r.ok).toBe(true);
    const a = r.entities[0] as any;
    expect(Math.abs(a.b[1] - a.a[1])).toBeLessThan(1e-9);
    expect(a.b[0]).toBeGreaterThan(15);
  });
  it('analysis DOF agrees with planegcs on an arc slot', () => {
    const w = ws([
      L('t', [0, 10], [50, 10]), L('b', [0, -10], [50, -10]),
      { id: 'r', kind: 'arc', c: [50, 0], r: 10, a0: -Math.PI / 2, a1: Math.PI / 2, construction: false },
      { id: 'l', kind: 'arc', c: [0, 0], r: 10, a0: Math.PI / 2, a1: 1.5 * Math.PI, construction: false },
    ], [
      { id: '1', type: 'coincident', a: { e: 't', p: 'end' }, b: { e: 'r', p: 'end' } },
      { id: '2', type: 'coincident', a: { e: 'b', p: 'end' }, b: { e: 'r', p: 'start' } },
      { id: '3', type: 'coincident', a: { e: 't', p: 'start' }, b: { e: 'l', p: 'start' } },
      { id: '4', type: 'coincident', a: { e: 'b', p: 'start' }, b: { e: 'l', p: 'end' } },
      { id: '5', type: 'tangent', a: 't', b: 'r' }, { id: '6', type: 'tangent', a: 'b', b: 'r' },
      { id: '7', type: 'tangent', a: 't', b: 'l' }, { id: '8', type: 'tangent', a: 'b', b: 'l' },
      { id: '9', type: 'horizontal', e: 't' },
    ]);
    const st = S.status(w);
    expect(st.result.ok).toBe(true);
    expect(st.status.dof).toBe(st.result.dof);
    expect(st.status.dof).toBe(5); // x, y, length, two radii (arcs not set equal)
    const an = analyze({ ...w, entities: st.result.entities }, makeContext(w));
    expect(an.dof).toBe(5);
  });
  it('endpoint tangency keeps the smooth side (no cusp flip) when dimensions change', () => {
    for (const [a0, a1, cy] of [[-Math.PI / 2, Math.PI / 2, 0], [Math.PI / 2, 1.5 * Math.PI, 20]] as const) {
      // Line along +X ending at (50,10); arc either continues downward (cy 0) or upward (cy 20).
      const arc: WEntity = cy === 0
        ? { id: 'r', kind: 'arc', c: [50, 0], r: 10, a0, a1, construction: false }
        : { id: 'r', kind: 'arc', c: [50, 20], r: 10, a0: -Math.PI / 2, a1: Math.PI / 2, construction: false };
      const endRef = cy === 0 ? 'end' : 'start';
      const w = ws([L('t', [0, 10], [50, 10]), arc], [
        { id: 'c', type: 'coincident', a: { e: 't', p: 'end' }, b: { e: 'r', p: endRef } },
        { id: 'tg', type: 'tangent', a: 't', b: 'r' },
        { id: 'fx', type: 'fix', e: 't' },
        { id: 'rr', type: 'radius', e: 'r', value: 0 },
      ], { rr: 17 });
      const r = S.solve(w);
      expect(r.ok).toBe(true);
      const k = r.entities[1] as any;
      expect(k.r).toBeCloseTo(17, 10);
      expect(k.c[0]).toBeCloseTo(50, 9);
      expect(k.c[1]).toBeCloseTo(cy === 0 ? 10 - 17 : 10 + 17, 9);
    }
  });
});
