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
    topologyBefore: async (id) => regenerate(oc, { ...store.state, rollback: store.state.features.findIndex((f) => f.id === id) }).topology ?? null,
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

  describe('update_feature re-picks edges and faces like the tool that made the feature', () => {
    const k = 1 - Math.PI / 4; // area left over by a fillet of radius 1 in a 90 degree corner
    const topEdge = (t: any, y: number) => t.edges.find((e: any) => e.curve === 'line' && Math.abs(e.length - 4) < 1e-9 && Math.abs(e.mid[1] - y) < 1e-9 && Math.abs(e.mid[2] - 0.5) < 1e-9);

    it('moves a fillet to another edge picked by index (was: rebuild failed reading "includes")', async () => {
      const store = new DocumentStore();
      const c = ctx(store);
      await plate(c);
      const t: any = await executeTool(c, 'get_topology', {});
      const fil: any = await executeTool(c, 'fillet', { edges: [{ index: topEdge(t, 0).index }], radius: 0.1, name: 'Edge Round' });
      expect(fil.ok).toBe(true);
      const t2: any = await executeTool(c, 'get_topology', {});
      const upd: any = await executeTool(c, 'update_feature', { feature_id: 'Edge Round', changes: { edges: [{ index: topEdge(t2, 2).index }] } });
      expect(upd, JSON.stringify(upd)).toMatchObject({ ok: true });
      expect(parseFloat(upd.part.volume)).toBeCloseTo(4 - 4 * 0.01 * k, 6);
      // Stored as a persistent reference, and the round is now on the far edge (y = 2).
      const f: any = store.feature(fil.feature_id);
      expect(f.edges).toHaveLength(1);
      expect(Array.isArray(f.edges[0].a) && Array.isArray(f.edges[0].b)).toBe(true);
      const own: any = await executeTool(c, 'get_topology', { feature_id: fil.feature_id, include_edges: false });
      expect(own.faces).toHaveLength(1);
      expect(own.faces[0].center[1]).toBeGreaterThan(1.8);
      expect(topEdge(await executeTool(c, 'get_topology', {}), 0)).toBeTruthy();
    });

    it('{feature} / {between} look at the part before the feature, so they include edges it already rounds (also inside build_model)', async () => {
      const fresh = new DocumentStore();
      const fc = ctx(fresh);
      await plate(fc);
      const ref: any = await executeTool(fc, 'fillet', { edges: [{ feature: 'Plate' }], radius: 0.1, name: 'All Rounds' });
      expect(ref.ok).toBe(true);
      // A rounded box: straight runs lose r^2 (1 - pi/4) per unit length (4 edges each of 3.8, 1.8, 0.3), each of the 8 corners r^3 (1 - pi/6).
      expect(parseFloat(ref.part.volume)).toBeCloseTo(4 - 0.01 * k * 4 * (3.8 + 1.8 + 0.3) - 8 * 0.001 * (1 - Math.PI / 6), 6);

      const store = new DocumentStore();
      const c = ctx(store);
      await plate(c);
      const t: any = await executeTool(c, 'get_topology', {});
      await executeTool(c, 'fillet', { edges: [{ index: topEdge(t, 0).index }, { index: topEdge(t, 2).index }], radius: 0.1, name: 'All Rounds' });
      const b: any = await executeTool(c, 'build_model', { steps: [{ tool: 'update_feature', feature_id: 'All Rounds', changes: { edges: [{ feature: 'Plate' }] } }] });
      expect(b, JSON.stringify(b)).toMatchObject({ ok: true, steps_run: 1 });
      expect(parseFloat(b.part.volume)).toBeCloseTo(parseFloat(ref.part.volume), 6);
      const st: any = await executeTool(c, 'get_model_state', {});
      expect(st.features.find((x: any) => x.name === 'All Rounds').ok).toBe(true);
      expect(parseFloat(st.part.volume)).toBeCloseTo(parseFloat(ref.part.volume), 6);
      expect((store.state.features.find((f) => f.name === 'All Rounds') as any).edges).toHaveLength(12);
    });

    it('refuses an edge that only exists because of the feature itself, and leaves the feature as it was', async () => {
      const store = new DocumentStore();
      const c = ctx(store);
      await plate(c);
      const t: any = await executeTool(c, 'get_topology', {});
      const fil: any = await executeTool(c, 'fillet', { edges: [{ index: topEdge(t, 0).index }], radius: 0.1, name: 'Edge Round' });
      const before = JSON.stringify(store.feature(fil.feature_id));
      const t2: any = await executeTool(c, 'get_topology', { feature_id: fil.feature_id });
      const onRound = t2.edges[0];
      expect(onRound).toBeTruthy();
      await expect(executeTool(c, 'update_feature', { feature_id: fil.feature_id, changes: { edges: [{ index: onRound.index }] } }))
        .rejects.toThrow(/touches a face made by "Edge Round" or a later feature/);
      expect(JSON.stringify(store.feature(fil.feature_id))).toBe(before);
      await expect(executeTool(c, 'update_feature', { feature_id: fil.feature_id, changes: { edges: [{ index: 9999 }] } })).rejects.toThrow(/No edge 9999/);
      await expect(executeTool(c, 'update_feature', { feature_id: fil.feature_id, changes: { edges: [{ edge: 3 }] } })).rejects.toThrow(/each item is/);
      expect(JSON.stringify(store.feature(fil.feature_id))).toBe(before);
    });

    it('keeps stored references handed back unchanged (e.g. only the radius changes)', async () => {
      const store = new DocumentStore();
      const c = ctx(store);
      await plate(c);
      const t: any = await executeTool(c, 'get_topology', {});
      const fil: any = await executeTool(c, 'fillet', { edges: [{ index: topEdge(t, 0).index }], radius: 0.1 });
      const edges = structuredClone((store.feature(fil.feature_id) as any).edges);
      const upd: any = await executeTool(c, 'update_feature', { feature_id: fil.feature_id, changes: { edges, radius: 0.2 } });
      expect(upd.ok).toBe(true);
      expect((store.feature(fil.feature_id) as any).edges).toEqual(edges);
      expect(parseFloat(upd.part.volume)).toBeCloseTo(4 - 4 * 0.04 * k, 6);
    });

    it('re-picks shell open faces (open_faces, as the shell tool calls them) and a hole placement face', async () => {
      const store = new DocumentStore();
      const c = ctx(store);
      await plate(c);
      const face = (t: any, z: number) => t.faces.find((f: any) => f.surface === 'plane' && Math.abs(f.center[2] - z) < 1e-9 && f.normal && Math.abs(Math.abs(f.normal[2]) - 1) < 1e-9);
      const t: any = await executeTool(c, 'get_topology', { include_edges: false });
      const hole: any = await executeTool(c, 'hole', { hole_type: 'simple', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { face: { index: face(t, 0.5).index } }, points: [[1, 1]], name: 'Pin Hole' });
      expect(hole.ok).toBe(true);
      const t1: any = await executeTool(c, 'get_topology', { include_edges: false });
      const moved: any = await executeTool(c, 'update_feature', { feature_id: 'Pin Hole', changes: { placement: { face: { index: face(t1, 0).index } } } });
      expect(moved, JSON.stringify(moved)).toMatchObject({ ok: true });
      expect(parseFloat(moved.part.volume)).toBeCloseTo(parseFloat(hole.part.volume), 6);
      expect((store.feature(hole.feature_id) as any).placement.face.tags[0]).toMatch(/:start$/);

      const t2: any = await executeTool(c, 'get_topology', { include_edges: false });
      const sh: any = await executeTool(c, 'shell', { open_faces: [{ index: face(t2, 0.5).index }], thickness: 0.1, name: 'Hollow' });
      expect(sh.ok).toBe(true);
      const t3: any = await executeTool(c, 'get_topology', { include_edges: false });
      const upd: any = await executeTool(c, 'update_feature', { feature_id: 'Hollow', changes: { open_faces: [{ index: face(t3, 0).index }] } });
      expect(upd, JSON.stringify(upd)).toMatchObject({ ok: true });
      const f: any = store.feature(sh.feature_id);
      expect(f.open_faces).toBeUndefined();
      expect(f.faces).toHaveLength(1);
      expect(f.faces[0].tags[0]).toMatch(/:start$/);
      expect(parseFloat(upd.part.volume)).toBeCloseTo(parseFloat(sh.part.volume), 6);
    });
  });
});
