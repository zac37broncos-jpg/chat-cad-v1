import { describe, it, expect, beforeAll } from 'vitest';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { buildSlot, buildPolygon } from '../src/sketch/build';
import type { WSketch } from '../src/sketch/geom';

let S: SketchSolver;
beforeAll(async () => { S = await createSketchSolver(); });
const ws = (b: { entities: any[]; constraints: any[] }): WSketch => ({ entities: b.entities, constraints: b.constraints, values: new Map() });

describe('Straight Slot and Polygon sketch tools', () => {
  it('slot: solves as drawn, 5 DOF (two centers + width), no redundant relations', () => {
    const b = buildSlot([0, 0], [30, 10], 4)!;
    const st = S.status(ws(b));
    expect(st.result.ok).toBe(true);
    expect(st.status.state).toBe('under');
    expect(st.status.dof).toBe(5);
    const [l1, , a1, a2] = b.entities as any[];
    expect(a1.r).toBeCloseTo(4, 12); expect(a2.r).toBeCloseTo(4, 12);
    expect(Math.hypot(l1.b[0] - l1.a[0], l1.b[1] - l1.a[1])).toBeCloseTo(Math.hypot(30, 10), 12);
  });
  it('polygon: hexagon stays regular, 4 DOF (center, size, rotation)', () => {
    for (const n of [3, 4, 6, 8]) {
      const b = buildPolygon([5, 5], [15, 5], n)!;
      const st = S.status(ws(b));
      expect(st.result.ok, `n=${n}`).toBe(true);
      expect(st.status.dof, `n=${n}`).toBe(4);
      const side = 2 * 10 * Math.sin(Math.PI / n);
      for (const e of b.entities.filter((x: any) => x.kind === 'line') as any[]) expect(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])).toBeCloseTo(side, 10);
    }
  });
  it('polygon with an inscribed circle: sides tangent at their middles, regular, 4 DOF, no redundancy', () => {
    for (const n of [3, 4, 5, 6, 8]) {
      const b = buildPolygon([5, 5], [15, 5], n, false, 'inscribed')!;
      const st = S.status(ws(b));
      expect(st.result.ok, `n=${n}`).toBe(true);
      expect(st.status.state, `n=${n}`).toBe('under');
      expect(st.status.dof, `n=${n}`).toBe(4);
      const circle = b.entities.find((x: any) => x.kind === 'circle') as any;
      expect(circle.r).toBeCloseTo(10, 12);
      const side = 2 * 10 * Math.tan(Math.PI / n); // apothem 10
      for (const e of b.entities.filter((x: any) => x.kind === 'line' && !x.construction) as any[]) {
        expect(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])).toBeCloseTo(side, 10);
        const m = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
        expect(Math.hypot(m[0] - 5, m[1] - 5)).toBeCloseTo(10, 10); // tangent at the middle
      }
    }
  });
  it('an inscribed-circle hexagon cannot shear into a non-regular shape when its circle is fixed', () => {
    const b = buildPolygon([0, 0], [10, 0], 6, false, 'inscribed')!;
    const circle = b.entities.find((x: any) => x.kind === 'circle') as any;
    const w = ws(b);
    w.constraints.push({ id: 'fx', type: 'fix', e: circle.id } as any, { id: 'v', type: 'vertical', e: (b.entities[0] as any).id } as any); // side 1 touches the circle at (10, 0)
    const st = S.status(w);
    expect(st.result.ok).toBe(true);
    expect(st.status.dof).toBe(0);
  });
});
