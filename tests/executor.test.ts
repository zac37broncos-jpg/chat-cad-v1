import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { regenerate, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo } from '../src/kernel/query';
import { executeTool, type ExecutorContext, TOOL_DEFS } from '../src/ai/executor';

let oc: OC;
beforeAll(async () => { oc = await init(); });

function ctx(store: DocumentStore): ExecutorContext {
  return {
    store,
    regen: async () => {
      const r = regenerate(oc, store.state);
      return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, ms: 0 };
    },
    selection: () => [],
    info: async (ref) => { const r = regenerate(oc, store.state); return entityInfo(oc, r.shape!, ref.kind, ref.index); },
  };
}

describe('AI tool executor', () => {
  it('exposes valid tool definitions', () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOL_DEFS) { expect(t.description.length).toBeGreaterThan(20); expect((t.inputSchema as any).type).toBe('object'); }
  });

  it('builds a parametric plate with holes the way Claude would, as one undo step', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    const cp = store.checkpoint();
    await executeTool(c, 'set_parameter', { name: 'L', value: '4' });
    await executeTool(c, 'set_parameter', { name: 'W', value: '2' });
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', entities: [{ type: 'rectangle', x: 0, y: 0, width: 'L', height: 'W' }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: '0.5', operation: 'new' });
    expect(ex, JSON.stringify(ex)).toMatchObject({ ok: true });
    const holes: any = await executeTool(c, 'create_sketch', { plane: 'XY', entities: [
      { type: 'circle', cx: 0.5, cy: 'W/2', diameter: '1/4"' }, { type: 'circle', cx: 'L-0.5', cy: 'W/2', diameter: '0.25 in' }] });
    const cut: any = await executeTool(c, 'extrude', { sketch_id: holes.sketch_id, operation: 'cut', through_all: true, direction: 'symmetric' });
    expect(cut, JSON.stringify(cut)).toMatchObject({ ok: true });
    expect(cut.part.bounding_box.x).toBe('4.000000 in');
    store.squashSince(cp, 'Claude: plate');
    const state: any = await executeTool(c, 'get_model_state', {});
    expect(state.features.length).toBe(4);
    const vol = parseFloat(state.part.volume);
    expect(vol).toBeCloseTo(4 * 2 * 0.5 - 2 * Math.PI * 0.125 ** 2 * 0.5, 6);
    store.undo();
    expect(store.state.features.length).toBe(0);
    expect(store.state.params.length).toBe(0);
  });

  it('edits through update_feature and reports kernel errors back', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XZ', entities: [{ type: 'rectangle', x: 0, y: 0, width: 1, height: 1, centered: true }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: 2 });
    const upd: any = await executeTool(c, 'update_feature', { feature_id: ex.feature_id, changes: { depth: '3' } });
    expect(upd.ok).toBe(true);
    expect(parseFloat(upd.part.volume)).toBeCloseTo(3, 9);
    const bad: any = await executeTool(c, 'update_feature', { feature_id: ex.feature_id, changes: { depth: '-1' } });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/greater than zero/);
  });

  it('builds slots, polygons and revolves exactly', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    await executeTool(c, 'set_units', { units: 'mm' });
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', entities: [
      { type: 'polygon', points: [[0, 0], [60, 0], [60, 30], [0, 30]] },
      { type: 'slot', x1: 15, y1: 15, x2: 45, y2: 15, width: 10 }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: 5 });
    expect(ex.ok).toBe(true);
    expect(parseFloat(ex.part.volume)).toBeCloseTo((60 * 30 - (30 * 10 + Math.PI * 25)) * 5, 6);

    const s2 = new DocumentStore(); const c2 = ctx(s2);
    const rv: any = await executeTool(c2, 'create_sketch', { plane: 'XZ', entities: [
      { type: 'line', x1: 0, y1: 0, x2: 0, y2: 1, construction: true },
      { type: 'rectangle', x: 0.5, y: 0, width: 0.25, height: 1 }] });
    const axis = rv.entity_ids.find((e: any) => e.construction).id;
    const r: any = await executeTool(c2, 'revolve', { sketch_id: rv.sketch_id, axis_line_id: axis });
    expect(r.ok).toBe(true);
    expect(parseFloat(r.part.volume)).toBeCloseTo(Math.PI * (0.75 ** 2 - 0.5 ** 2), 6);
  });

  it('rejects malformed input with a clear message', async () => {
    const c = ctx(new DocumentStore());
    await expect(executeTool(c, 'create_sketch', { plane: 'XY', entities: [{ type: 'circle', cx: 0 }] })).rejects.toThrow(/cy/);
    await expect(executeTool(c, 'nope', {})).rejects.toThrow(/Unknown tool/);
  });
});

describe('named regions the AI can edit ("make the left wing longer by .2")', () => {
  it('reports each feature’s exact extent, the parameters it uses, and what a parameter change drives', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    await executeTool(c, 'set_parameter', { name: 'body_len', value: '3' });
    await executeTool(c, 'set_parameter', { name: 'left_wing_span', value: '2' });
    await executeTool(c, 'set_parameter', { name: 'left_wing_chord', value: '0.75' });
    const body: any = await executeTool(c, 'create_sketch', { plane: 'XY', name: 'Fuselage Sketch', entities: [{ type: 'rectangle', x: '-body_len/2', y: -0.25, width: 'body_len', height: 0.5 }] });
    await executeTool(c, 'extrude', { sketch_id: body.sketch_id, depth: 0.5, operation: 'new', name: 'Fuselage' });
    // Left = -X: the wing runs from the fuselage side outward toward -X.
    const wing: any = await executeTool(c, 'create_sketch', { plane: 'XY', name: 'Left Wing Sketch', entities: [{ type: 'rectangle', x: '-body_len/2 - left_wing_span', y: '-left_wing_chord/2', width: 'left_wing_span', height: 'left_wing_chord' }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: wing.sketch_id, depth: 0.1, operation: 'add', name: 'Left Wing' });
    expect(ex.feature_extent.size).toEqual({ x: 2, y: 0.75, z: 0.1 });
    expect(ex.feature_extent.min).toEqual([-3.5, -0.375, 0]);

    const state: any = await executeTool(c, 'get_model_state', {});
    expect(state.orientation).toMatch(/Left = -X/);
    const lw = state.features.find((f: any) => f.name === 'Left Wing');
    const lws = state.features.find((f: any) => f.name === 'Left Wing Sketch');
    expect(lw.sketch_name).toBe('Left Wing Sketch');
    expect(lws.used_by).toEqual(['Left Wing']);
    expect(lws.parameters_used.sort()).toEqual(['body_len', 'left_wing_chord', 'left_wing_span']);
    expect(state.parameters.find((p: any) => p.name === 'left_wing_span').value).toBe('2.000000 in');

    // "Make the left wing longer by .2": change its span parameter; the root stays on the fuselage.
    const r: any = await executeTool(c, 'set_parameter', { name: 'left_wing_span', value: '2.2' });
    const after = r.affected_features.find((f: any) => f.name === 'Left Wing');
    expect(after.extent.size.x).toBeCloseTo(2.2, 9);
    expect(after.extent.max[0]).toBeCloseTo(-1.5, 9);
    expect(r.affected_features.map((f: any) => f.name)).not.toContain('Fuselage');
  });
});
