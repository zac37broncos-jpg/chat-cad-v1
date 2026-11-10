/** The AI chat's feature tools, driven the way Claude calls them. */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { regenerate, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo } from '../src/kernel/query';
import { executeTool, type ExecutorContext, TOOL_DEFS } from '../src/ai/executor';
import type { SelRef } from '../src/kernel/protocol';

let oc: OC;
beforeAll(async () => { oc = await init(); });

function ctx(store: DocumentStore, sel: SelRef[] = []): ExecutorContext {
  return {
    store,
    regen: async () => {
      const r = regenerate(oc, store.state);
      return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, topology: r.topology, refGeometry: r.refGeometry, ms: 0 };
    },
    selection: () => sel,
    info: async (ref) => { const r = regenerate(oc, store.state); return entityInfo(oc, r.shape!, ref.kind, ref.index); },
  };
}

async function plate(c: ExecutorContext) {
  const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', name: 'Plate Sketch', entities: [{ type: 'rectangle', x: 0, y: 0, width: 4, height: 2 }] });
  const ex: any = await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: 0.5, operation: 'new', name: 'Plate' });
  expect(ex.ok).toBe(true);
  return ex.feature_id as string;
}

describe('AI feature tools', () => {
  it('exposes unique, documented tools', () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['fillet', 'chamfer', 'hole', 'linear_pattern', 'circular_pattern', 'mirror', 'shell', 'draft', 'rib', 'sweep', 'loft', 'reference_plane', 'reference_axis', 'reference_point', 'get_topology', 'list_hole_sizes']) expect(names).toContain(n);
  });

  it('fillets the four vertical edges picked from get_topology, then holes, pattern and model state', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    const cp = store.checkpoint();
    await plate(c);
    const topo: any = await executeTool(c, 'get_topology', {});
    expect(topo.faces.find((f: any) => f.name === 'Plate end face')).toBeTruthy();
    const vertical = topo.edges.filter((e: any) => e.curve === 'line' && Math.abs(e.length - 0.5) < 1e-9);
    expect(vertical.length).toBe(4);
    const fil: any = await executeTool(c, 'fillet', { edges: vertical.map((e: any) => ({ index: e.index })), radius: 0.25, name: 'Corner Rounds' });
    expect(fil, JSON.stringify(fil)).toMatchObject({ ok: true, name: 'Corner Rounds' });
    expect(parseFloat(fil.part.volume)).toBeCloseTo((8 - 4 * 0.0625 * (1 - Math.PI / 4)) * 0.5, 6); // reported to 6 decimals

    // Hole on the top face picked by index; points are world X, Y.
    const t2: any = await executeTool(c, 'get_topology', { include_edges: false });
    const top = t2.faces.find((f: any) => f.surface === 'plane' && Math.abs(f.center[2] - 0.5) < 1e-9);
    const hole: any = await executeTool(c, 'hole', { hole_type: 'counterbore', standard: 'ansi-inch', size: '#10', end: 'through', placement: { face: { index: top.index } }, points: [[0.5, 0.5]], name: 'Mount Hole' });
    expect(hole, JSON.stringify(hole)).toMatchObject({ ok: true });
    const pat: any = await executeTool(c, 'linear_pattern', { features: [hole.feature_id], direction1: 'X', spacing1: 3, count1: 2, direction2: 'Y', spacing2: 1, count2: 2, name: 'Mount Hole Pattern' });
    expect(pat, JSON.stringify(pat)).toMatchObject({ ok: true });
    const r = 0.221 / 2, rc = 0.375 / 2;
    const holeV = Math.PI * (rc * rc * 0.19 + r * r * (0.5 - 0.19));
    expect(parseFloat(pat.part.volume)).toBeCloseTo((8 - 4 * 0.0625 * (1 - Math.PI / 4)) * 0.5 - 4 * holeV, 6);

    const state: any = await executeTool(c, 'get_model_state', {});
    const f = state.features.find((x: any) => x.name === 'Corner Rounds');
    expect(f).toMatchObject({ type: 'fillet', kind: 'constant', radius: 0.25, ok: true });
    expect(f.edges[0].edge_between.length).toBe(2);
    store.squashSince(cp, 'Claude: plate');
    store.undo();
    expect(store.state.features.length).toBe(0);
  });

  it('uses the user selection, reports table values, and returns kernel errors', async () => {
    const store = new DocumentStore();
    await plate(ctx(store));
    const t: any = await executeTool(ctx(store), 'get_topology', {});
    const e = t.edges.find((x: any) => Math.abs(x.mid[0] - 2) < 1e-9 && Math.abs(x.mid[1] - 2) < 1e-9 && Math.abs(x.mid[2] - 0.5) < 1e-9);
    const c = ctx(store, [{ kind: 'edge', index: e.index }]);
    const ch: any = await executeTool(c, 'chamfer', { edges: ['selection'], distance: 0.05 });
    expect(ch.ok).toBe(true);
    expect(parseFloat(ch.part.volume)).toBeCloseTo(4 - 0.05 * 0.05 / 2 * 4, 6);
    const sizes: any = await executeTool(c, 'list_hole_sizes', { standard: 'ansi-inch', hole_type: 'tapped', size: '1/4-20' });
    expect(sizes).toMatchObject({ diameter: 0.201, values_in: 'in' });
    const bad: any = await executeTool(c, 'fillet', { edges: [{ index: e.index }], radius: 5 });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('builds a reference plane, sketches on it, and mirrors the body', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    await plate(c);
    const pl: any = await executeTool(c, 'reference_plane', { type: 'offset', from: { plane: 'XY' }, distance: 0.5, name: 'Plate Top Plane' });
    expect(pl.ok).toBe(true);
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', ref_plane_id: pl.feature_id, name: 'Boss Sketch', entities: [{ type: 'circle', cx: 1, cy: 1, diameter: 0.5 }] });
    const boss: any = await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: 0.25, operation: 'add', name: 'Boss' });
    expect(boss.part.bounding_box.z).toBe('0.750000 in');
    const m: any = await executeTool(c, 'mirror', { body: true, plane: { plane: 'YZ' }, name: 'Mirror Body' });
    expect(m.ok).toBe(true);
    expect(m.part.bounding_box.x).toBe('8.000000 in');
  });
});
