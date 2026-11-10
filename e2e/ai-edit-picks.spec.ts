/**
 * The AI chat changing which edges an existing fillet rounds, through the
 * app's own executor context and geometry worker (tests/featureTools.test.ts
 * checks the same tools against the kernel directly). The part before the
 * fillet comes from the worker's topologyBefore request, which must not
 * change the part that check_part / Measure read afterwards.
 */
import { test, expect } from '@playwright/test';

test('AI update_feature re-picks a fillet\'s edges in the real app', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).chatcad?.kernel && (window as any).chatcad?.bridge);

  const r = await page.evaluate(async () => {
    const { store, kernel, bridge } = (window as any).chatcad;
    const { executeTool } = await import('/src/ai/executor.ts' as string);
    const ctx = bridge.ctx;
    const run = (name: string, args: unknown) => executeTool(ctx, name, args);
    store.resetPart('Edit picks');
    const sk = await run('create_sketch', { plane: 'XY', name: 'Plate Sketch', entities: [{ type: 'rectangle', x: 0, y: 0, width: 4, height: 2 }] });
    await run('extrude', { sketch_id: sk.sketch_id, depth: 0.5, name: 'Plate' });
    const t = await run('get_topology', {});
    const top = t.edges.find((e: any) => e.curve === 'line' && Math.abs(e.length - 4) < 1e-9 && Math.abs(e.mid[1]) < 1e-9 && Math.abs(e.mid[2] - 0.5) < 1e-9);
    const fil = await run('fillet', { edges: [{ index: top.index }], radius: 0.1, name: 'Rounds' });

    // The worker's part before the fillet is the plain plate (6 faces), and asking for it leaves the current part alone.
    const q1 = await kernel.call({ op: 'quality' });
    const before = await kernel.call({ op: 'topologyBefore', doc: store.state, featureId: fil.feature_id });
    const q2 = await kernel.call({ op: 'quality' });

    const upd = await run('update_feature', { feature_id: 'Rounds', changes: { edges: [{ feature: 'Plate' }] } });
    const exact = await kernel.call({ op: 'regen', doc: store.state, mesh: false, mass: true });
    const q3 = await kernel.call({ op: 'quality' });
    return {
      filOk: fil.ok, beforeFaces: before?.faces.length, sameQuality: JSON.stringify(q1) === JSON.stringify(q2),
      updOk: upd.ok, updVolume: parseFloat(upd.part.volume), edges: store.state.features.find((f: any) => f.name === 'Rounds').edges.length,
      allOk: exact.status.every((s: any) => s.ok), volumeIn3: exact.mass.volume / 25.4 ** 3, q3Problems: q3.problems,
    };
  });
  expect(r.filOk).toBe(true);
  expect(r.beforeFaces).toBe(6);
  expect(r.sameQuality).toBe(true);
  expect(r.updOk).toBe(true);
  expect(r.edges).toBe(12);
  expect(r.allOk).toBe(true);
  // Every edge of a 4 x 2 x 0.5 in plate rounded r = 0.1 in (a rounded box): the straight runs lose r^2 (1 - pi/4)
  // per unit length (4 edges each of 3.8, 1.8 and 0.3 in) and each of the 8 corners loses r^3 (1 - pi/6).
  expect(r.volumeIn3).toBeCloseTo(4 - 0.01 * (1 - Math.PI / 4) * 4 * (3.8 + 1.8 + 0.3) - 8 * 0.001 * (1 - Math.PI / 6), 5);
  expect(r.volumeIn3).toBeCloseTo(r.updVolume, 5);
  expect(r.q3Problems).toEqual([]);
  expect(pageErrors).toEqual([]);
});
