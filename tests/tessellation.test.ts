import { it, expect } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities } from '../src/core/model';
import { regenerate } from '../src/kernel/regen';
import { tessellate } from '../src/kernel/query';

it('display edges span their full exact length (overload regression)', async () => {
  const oc = await init();
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2)), 0.5);
  const m = tessellate(oc, regenerate(oc, st.state).shape!);
  expect(m.edges.length).toBe(12);
  for (const e of m.edges) {
    const p = e.points, n = p.length;
    const len = Math.hypot(p[n - 3] - p[0], p[n - 2] - p[1], p[n - 1] - p[2]);
    expect([0.5 * 25.4, 2 * 25.4, 4 * 25.4].some((L) => Math.abs(L - len) < 1e-4)).toBe(true);
  }
});
