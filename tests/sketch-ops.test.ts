import { describe, it, expect, beforeAll } from 'vitest';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { trim, extend, offset, fillet, connectedChain } from '../src/sketch/ops';
import { buildCornerRect, buildCenterRect, buildArc3, buildTangentArc, exitDirection } from '../src/sketch/build';
import type { WEntity, WSketch } from '../src/sketch/geom';
import type { SketchConstraint } from '../src/core/model';

let S: SketchSolver;
beforeAll(async () => { S = await createSketchSolver(); });
const L = (id: string, a: [number, number], b: [number, number]): WEntity => ({ id, kind: 'line', a, b, construction: false });
const ws = (entities: WEntity[], constraints: SketchConstraint[] = [], values: Record<string, number> = {}): WSketch =>
  ({ entities, constraints, values: new Map(Object.entries(values)) });
const anchoredRect = (w = 100, h = 50) => {
  const r = buildCornerRect([0, 0], [w, h]);
  const [l1, l2] = r.entities.map((e) => e.id);
  r.constraints.push(
    { id: 'o', type: 'coincident', a: { e: l1, p: 'start' }, b: { e: 'origin', p: 'point' } },
    { id: 'dw', type: 'distance', a: { e: l1, p: 'start' }, b: { e: l1, p: 'end' }, value: 0 },
    { id: 'dh', type: 'distance', a: { e: l2, p: 'start' }, b: { e: l2, p: 'end' }, value: 0 },
  );
  return ws(r.entities, r.constraints, { dw: w, dh: h });
};

describe('sketch builders', () => {
  it('corner rectangle has 4 DOF; center rectangle with its center on the origin has 2', () => {
    const r = buildCornerRect([1, 2], [40, 30]);
    expect(S.status(ws(r.entities, r.constraints)).status.dof).toBe(4);
    const c = buildCenterRect([0, 0], [20, 10]);
    c.constraints.push({ id: 'o', type: 'coincident', a: c.picks[0], b: { e: 'origin', p: 'point' } });
    const st = S.status(ws(c.entities, c.constraints));
    expect(st.result.ok).toBe(true);
    expect(st.status.state).toBe('under');
    expect(st.status.dof).toBe(2);
  });
  it('3-point arc passes through its three points', () => {
    const a = buildArc3([0, 0], [10, 0], [5, 5])!.entities[0] as any;
    expect(a.c[0]).toBeCloseTo(5, 12); expect(a.c[1]).toBeCloseTo(0, 12); expect(a.r).toBeCloseTo(5, 12);
    expect(a.a1 - a.a0).toBeCloseTo(Math.PI, 12);
  });
  it('tangent arc from a line end is tangent and connected', () => {
    const l = L('l', [0, 0], [10, 0]);
    const t = exitDirection(l, 'end')!;
    const b = buildTangentArc({ e: 'l', p: 'end' }, [10, 0], t, [10, 10], 'l')!;
    const a = b.entities[0] as any;
    expect(a.c[0]).toBeCloseTo(10, 12); expect(a.c[1]).toBeCloseTo(5, 12);
    const r = S.solve(ws([l, ...b.entities], b.constraints));
    expect(r.ok).toBe(true);
  });
});

describe('trim / extend', () => {
  it('trims the middle of a line crossed by two others into two collinear pieces', () => {
    const w = ws([L('h', [0, 0], [100, 0]), L('v1', [30, -10], [30, 10]), L('v2', [60, -10], [60, 10])]);
    const out = trim(w, 'h', [45, 0.5]);
    const lines = out.entities.filter((e) => e.kind === 'line') as any[];
    expect(lines.length).toBe(4);
    const h = lines.find((e) => e.id === 'h');
    expect(h.b[0]).toBeCloseTo(30, 12);
    const piece = lines.find((e) => !['h', 'v1', 'v2'].includes(e.id));
    expect(piece.a[0]).toBeCloseTo(60, 12); expect(piece.b[0]).toBeCloseTo(100, 12);
    expect(out.constraints.some((c) => c.type === 'collinear')).toBe(true);
    expect(S.solve(ws(out.entities, out.constraints)).ok).toBe(true);
  });
  it('trims an end back to the crossing and deletes an uncrossed line', () => {
    const w = ws([L('h', [0, 0], [100, 0]), L('v', [30, -10], [30, 10])]);
    const out = trim(w, 'h', [10, 0]);
    const h = out.entities.find((e) => e.id === 'h') as any;
    expect(h.a[0]).toBeCloseTo(30, 12);
    expect(trim(ws([L('x', [0, 0], [1, 1])]), 'x', [0.5, 0.5]).entities.length).toBe(0);
  });
  it('trims a circle crossed twice into an arc', () => {
    const w = ws([{ id: 'c', kind: 'circle', c: [0, 0], r: 10, construction: false }, L('v', [0, -20], [0, 20])]);
    const out = trim(w, 'c', [10, 0]);
    const a = out.entities.find((e) => e.id === 'c') as any;
    expect(a.kind).toBe('arc');
    expect(a.a1 - a.a0).toBeCloseTo(Math.PI, 12);
    expect(Math.cos((a.a0 + a.a1) / 2)).toBeCloseTo(-1, 12); // the left half remains
  });
  it('extends a line to the next line', () => {
    const w = ws([L('h', [0, 0], [20, 0]), L('v', [50, -10], [50, 10])]);
    const out = extend(w, 'h', [19, 0]);
    expect((out.entities[0] as any).b[0]).toBeCloseTo(50, 12);
    expect(out.constraints.some((c) => c.type === 'pointOn')).toBe(true);
  });
});

describe('offset', () => {
  it('offsets a fully defined rectangle outward and stays fully defined', () => {
    const w = anchoredRect();
    const ids = connectedChain(w, w.entities[0].id);
    expect(ids.length).toBe(4);
    const out = offset(w, ids, 5, [-20, 25], 5);
    const off = out.constraints.find((c) => c.type === 'offset')!;
    const w2 = ws(out.entities, out.constraints, { dw: 100, dh: 50, [off.id]: 5 });
    const st = S.status(w2);
    expect(st.result.ok).toBe(true);
    expect(st.status.state).toBe('full');
    const xs = st.result.entities.slice(4).flatMap((e: any) => [e.a[0], e.b[0]]);
    expect(Math.min(...xs)).toBeCloseTo(-5, 9); expect(Math.max(...xs)).toBeCloseTo(105, 9);
  });
  it('offsets an open line + tangent arc chain inward with pinned ends', () => {
    const l = L('l', [0, 0], [50, 0]);
    const b = buildTangentArc({ e: 'l', p: 'end' }, [50, 0], [1, 0], [50, 40], 'l')!;
    const base = ws([l, ...b.entities], [...b.constraints, { id: 'fx', type: 'fix', e: 'l' }, { id: 'r', type: 'radius', e: b.entities[0].id, value: 0 }], { r: 20 });
    const solved = S.solve(base);
    expect(solved.ok).toBe(true);
    const w = { ...base, entities: solved.entities };
    const out = offset(w, connectedChain(w, 'l'), 3, [25, 5], 3);
    const off = out.constraints.find((c) => c.type === 'offset')!;
    const st = S.status({ ...w, entities: out.entities, constraints: out.constraints, values: new Map([...w.values, [off.id, 3]]) });
    expect(st.result.ok).toBe(true);
    const arc2 = st.result.entities[3] as any;
    expect(arc2.r).toBeCloseTo(17, 9);
  });
});

describe('fillet', () => {
  it('rounds a rectangle corner with a tangent arc and the sketch still solves', () => {
    const w = anchoredRect();
    const out = fillet(w, [100, 50], 10, 10, 0.5);
    const rad = out.constraints.find((c) => c.type === 'radius')!;
    const st = S.status(ws(out.entities, out.constraints, { dw: 100, dh: 50, [rad.id]: 10 }));
    expect(st.result.ok).toBe(true);
    const arc = st.result.entities.find((e) => e.kind === 'arc') as any;
    expect(arc.c[0]).toBeCloseTo(90, 9); expect(arc.c[1]).toBeCloseTo(40, 9); expect(arc.r).toBeCloseTo(10, 9);
  });
});
