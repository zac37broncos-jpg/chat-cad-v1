/**
 * Organic modelling: sketch splines (exact interpolation, same curve in
 * OpenCascade), smooth lofts through spline sections with tips, sweeps and
 * revolves of splines, and the build_model batch tool with name references
 * and feature-based edge picks.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { regenerate, releaseRegen, countSolids, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo } from '../src/kernel/query';
import { exportStlFile } from '../src/kernel/exporters';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { interpolateSpline, splinePoint, splineEval, closestOnSpline, knotsAndMults } from '../src/sketch/spline';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { evalWorking } from '../src/sketch/geom';
import { pchip } from '../src/ai/organicTools';
import { withRecordedSeams } from './helpers/seams';

let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

function ctx(store: DocumentStore, counter?: { n: number }): ExecutorContext {
  return {
    store,
    regen: async () => {
      if (counter) counter.n++;
      // Like the app's worker, free each rebuild when done: the kernel's heap never shrinks, and
      // with a heap past 2.5 GB the 'Horn' boolean below was seen to fail and the kernel to crash.
      const r = regenerate(oc, store.state, { solver });
      try {
        return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, topology: r.topology ?? null, ms: 0 };
      } finally { releaseRegen(r); }
    },
    selection: () => [],
    info: async (ref) => { const r = regenerate(oc, store.state, { solver }); try { return entityInfo(oc, r.shape!, ref.kind, ref.index); } finally { releaseRegen(r); } },
  };
}

const ring = (n: number, rx: number, ry: number, bumps = 0): [number, number][] =>
  Array.from({ length: n }, (_, i) => { const t = (2 * Math.PI * i) / n; const k = 1 + bumps * Math.cos(3 * t); return [+(rx * k * Math.cos(t)).toFixed(6), +(ry * k * Math.sin(t)).toFixed(6)]; });

describe('spline math', () => {
  it('passes exactly through every point, open and closed, and is C2 at the closed seam', () => {
    const pts: [number, number][] = [[0, 0], [10, 2], [14, 9], [6, 14], [-3, 8], [-1, 3]];
    for (const closed of [false, true]) {
      const c = interpolateSpline(pts, closed);
      pts.forEach((p, i) => { const q = splinePoint(c, c.params[i]); expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(1e-9); });
      if (closed) {
        const a = splinePoint(c, c.t0), b = splinePoint(c, c.t1);
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-9);
        const h = 1e-5 * (c.t1 - c.t0);
        const d1a = splineEval(c, c.t0).d, d1b = splineEval(c, c.t1 - 1e-12).d;
        expect(Math.hypot(d1a[0] - d1b[0], d1a[1] - d1b[1])).toBeLessThan(1e-6);
        // Second derivative continuity across the seam (finite differences).
        const dd = (t: number) => { const u = splineEval(c, t + h).d, v = splineEval(c, t - h).d; return [(u[0] - v[0]) / (2 * h), (u[1] - v[1]) / (2 * h)]; };
        const s0 = dd(c.t0 + 2 * h), s1 = dd(c.t1 - 2 * h);
        expect(Math.hypot(s0[0] - s1[0], s0[1] - s1[1])).toBeLessThan(1e-3 * Math.hypot(s0[0], s0[1]) + 1e-6);
      }
      const near = closestOnSpline(c, [6, 15]);
      expect(near.dist).toBeGreaterThan(0.5);
      expect(near.dist).toBeLessThan(1.5);
    }
  });

  it('is the same curve in OpenCascade', () => {
    const pts: [number, number][] = ring(9, 20, 12, 0.15);
    const c = interpolateSpline(pts, true);
    const o: any = oc;
    const P = new o.NCollection_Array1_gp_Pnt(1, c.poles.length);
    c.poles.forEach((p, i) => P.SetValue(i + 1, new o.gp_Pnt(p[0], p[1], 0)));
    const { knots, mults } = knotsAndMults(c);
    const K = new o.NCollection_Array1_double(1, knots.length); knots.forEach((k, i) => K.SetValue(i + 1, k));
    const M = new o.NCollection_Array1_int(1, mults.length); mults.forEach((k, i) => M.SetValue(i + 1, k));
    const g = new o.Geom_BSplineCurve(P, K, M, c.degree, false);
    expect(g.IsClosed()).toBe(true);
    for (let k = 0; k <= 50; k++) {
      const t = c.t0 + ((c.t1 - c.t0) * k) / 50;
      const v = g.Value(t), j = splinePoint(c, t);
      expect(Math.hypot(v.X() - j[0], v.Y() - j[1])).toBeLessThan(1e-9);
    }
  });

  it('keeps splines fixed while the solver moves other geometry', () => {
    const sk: any = { id: 's', type: 'sketch', name: 'S', plane: 'XY', entities: [
      { id: 'sp', kind: 'spline', points: [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: 0 }] },
      { id: 'l', kind: 'line', p1: { x: 0, y: 5 }, p2: { x: 3, y: 6 } }],
      constraints: [{ id: 'h', type: 'horizontal', e: 'l' }] };
    const ws = evalWorking(sk, 'mm', {});
    const st = solver.status(ws);
    expect(st.result.ok).toBe(true);
    const l = st.result.entities.find((e) => e.id === 'l') as any;
    expect(Math.abs(l.a[1] - l.b[1])).toBeLessThan(1e-9);
    expect((st.result.entities.find((e) => e.id === 'sp') as any).pts).toEqual([[0, 0], [5, 3], [10, 0]]);
    const bad = solver.status(evalWorking({ ...sk, constraints: [{ id: 'f', type: 'fix', e: 'sp' }, { id: 'x', type: 'horizontal', e: 'sp' }] }, 'mm', {}));
    expect(bad.result.ok).toBe(false);
    expect(bad.status.message).toMatch(/splines/);
  });
});

describe('organic features', () => {
  it('extrudes a closed spline with the exact enclosed area', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const c = ctx(store);
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', name: 'Blob', entities: [{ type: 'spline', closed: true, points: ring(8, 20, 12, 0.1) }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: 'Blob', depth: 5, name: 'Blob Plate' });
    expect(ex.ok, JSON.stringify(ex)).toBe(true);
    expect(sk.sketch_id).toBeTruthy();
    // Area of the spline by Green's theorem on the exact curve (dense Gauss sampling).
    const curve = interpolateSpline(ring(8, 20, 12, 0.1), true);
    let area = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const t = curve.t0 + ((curve.t1 - curve.t0) * (i + 0.5)) / N;
      const { p, d } = splineEval(curve, t);
      area += 0.5 * (p[0] * d[1] - p[1] * d[0]) * ((curve.t1 - curve.t0) / N);
    }
    expect(parseFloat(ex.part.volume)).toBeCloseTo(Math.abs(area) * 5, 3);
  });

  it('lofts closed spline sections into one smooth face and closes to a tip point', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const c = ctx(store);
    for (const [i, z, s] of [[1, 0, 1], [2, 20, 1.2], [3, 40, 0.9]] as const) {
      await executeTool(c, 'create_sketch', { plane: 'XY', offset: z, name: `Head Section ${i}`, entities: [{ type: 'spline', closed: true, points: ring(10, 15 * s, 11 * s, 0.08) }] });
    }
    const lf: any = await executeTool(c, 'loft', { profile_sketch_ids: ['Head Section 1', 'Head Section 2', 'Head Section 3'], end_point: [0, 0, 52], name: 'Head' });
    expect(lf.ok, JSON.stringify(lf)).toBe(true);
    expect(lf.part.bounding_box.z).toBe('52.000000 mm');
    const r = regenerate(oc, store.state, { solver });
    // Side surface is one smooth B-spline face + flat bottom cap (no seams between sections).
    expect(r.topology!.faces.length).toBe(2);
  });

  it('sweeps a circle along an open spline path and revolves a spline profile', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const c = ctx(store);
    await executeTool(c, 'create_sketch', { plane: 'XZ', name: 'Arm Path', entities: [{ type: 'spline', points: [[0, 0], [10, 8], [25, 10], [40, 2]] }] });
    await executeTool(c, 'create_sketch', { plane: 'YZ', name: 'Arm Profile', entities: [{ type: 'circle', cx: 0, cy: 0, diameter: 6 }] });
    const sw: any = await executeTool(c, 'sweep', { profile_sketch_id: 'Arm Profile', path_sketch_id: 'Arm Path', name: 'Arm' });
    expect(sw.ok, JSON.stringify(sw)).toBe(true);
    expect(parseFloat(sw.part.volume)).toBeGreaterThan(0);

    const s2 = new DocumentStore(); s2.setUnits('mm');
    const c2 = ctx(s2);
    await executeTool(c2, 'create_sketch', { plane: 'XZ', name: 'Vase Profile', entities: [
      { type: 'line', x1: 0, y1: 0, x2: 0, y2: 60, construction: true },
      { type: 'line', x1: 0, y1: 0, x2: 20, y2: 0 },
      { type: 'spline', points: [[20, 0], [28, 15], [14, 40], [18, 60]] },
      { type: 'line', x1: 18, y1: 60, x2: 0, y2: 60 },
      { type: 'line', x1: 0, y1: 60, x2: 0, y2: 0 }] });
    const rv: any = await executeTool(c2, 'revolve', { sketch_id: 'Vase Profile', name: 'Vase Body' });
    expect(rv.ok, JSON.stringify(rv)).toBe(true);
    expect(rv.part.bounding_box.z).toBe('60.000000 mm');
  });

  it('builds a whole named model in one build_model call with few regenerations', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const counter = { n: 0 };
    const c = ctx(store, counter);
    const cp = store.checkpoint();
    const sec = (i: number, z: number, s: number) => ({ tool: 'create_sketch', args: { plane: 'XY', offset: z, name: `Body Section ${i}`, entities: [{ type: 'spline', closed: true, points: ring(10, 14 * s, 10 * s) }] } });
    const res: any = await executeTool(c, 'build_model', { steps: [
      { tool: 'set_part_name', args: { name: 'Test Figure' } },
      { tool: 'set_parameter', args: { name: 'nose_len', value: '12' } },
      sec(1, 0, 1), sec(2, 15, 1.25), sec(3, 30, 1.1), sec(4, 45, 0.7),
      { tool: 'loft', args: { profile_sketch_ids: ['Body Section 1', 'Body Section 2', 'Body Section 3', 'Body Section 4'], end_point: [0, 0, 55], name: 'Body' } },
      { tool: 'create_sketch', args: { plane: 'XZ', offset: 5, name: 'Nose Profile', entities: [{ type: 'circle', cx: 0, cy: 28, diameter: 7 }] } },
      { tool: 'extrude', args: { sketch_id: 'Nose Profile', depth: 'nose_len', direction: 'normal', operation: 'add', name: 'Nose' } },
      { tool: 'fillet', args: { edges: [{ between: ['Body', 'Nose'] }], radius: 2, name: 'Nose Blend' } },
      { tool: 'create_sketch', args: { plane: 'XZ', name: 'Left Eye Socket Sketch', entities: [{ type: 'circle', cx: -6, cy: 36, diameter: 6 }] } },
      { tool: 'extrude', args: { sketch_id: 'Left Eye Socket Sketch', depth: 30, direction: 'symmetric', operation: 'cut', name: 'Left Eye Socket' } },
      { tool: 'mirror', args: { features: ['Left Eye Socket'], plane: { plane: 'YZ' }, name: 'Right Eye Socket' } },
    ] });
    expect(res.ok, JSON.stringify(res, null, 1)).toBe(true);
    expect(res.steps_run).toBe(13);
    expect(res.features.map((f: any) => f.name)).toEqual(expect.arrayContaining(['Body', 'Nose', 'Nose Blend', 'Left Eye Socket', 'Right Eye Socket']));
    expect(store.state.name).toBe('Test Figure');
    // One regeneration for the fillet's edge pick, one at the end.
    expect(counter.n).toBe(2);
    const nose = res.features.find((f: any) => f.name === 'Nose');
    expect(nose.size[1]).toBeGreaterThan(5);
    // Everything stays editable: change the nose parameter afterwards.
    const ed: any = await executeTool(c, 'set_parameter', { name: 'nose_len', value: '16' });
    expect(ed.errors).toBeUndefined();
    store.squashSince(cp, 'Claude: figure');
    store.undo();
    expect(store.state.features.length).toBe(0);
  });

  it('stops at a failing step, keeps what ran, and says which step failed', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const c = ctx(store);
    const res: any = await executeTool(c, 'build_model', { steps: [
      { tool: 'create_sketch', args: { plane: 'XY', name: 'Base Sketch', entities: [{ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] } },
      { tool: 'extrude', args: { sketch_id: 'Base Sketch', depth: 2, name: 'Base' } },
      { tool: 'extrude', args: { sketch_id: 'No Such Sketch', depth: 2, name: 'Oops' } },
      { tool: 'fillet', args: { edges: [{ feature: 'Base' }], radius: 0.5, name: 'Never Runs' } },
    ] });
    expect(res.ok).toBe(false);
    expect(res.steps_run).toBe(2);
    expect(res.stopped_at.step).toBe(3);
    expect(store.state.features.map((f) => f.name)).toEqual(['Base Sketch', 'Base']);
  });
});

describe('organic shorthand tools', () => {
  it('loft_sections makes named section sketches and one smooth loft', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    const r: any = await executeTool(c, 'loft_sections', { name: 'Head', sections: [
      { offset: 0, oval: { rx: 1, ry: 0.8 } }, { offset: 1, oval: { rx: 1.2, ry: 1, squareness: 3 } },
      { offset: 2, points: [[1, 0], [0.7, 0.7], [0, 0.9], [-0.7, 0.7], [-1, 0], [-0.7, -0.8], [0, -1.2], [0.7, -0.8]] }], end_point: [0, 0, 2.6] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(store.state.features.map((f) => f.name)).toEqual(['Head Section 1', 'Head Section 2', 'Head Section 3', 'Head End Dome 1', 'Head End Dome 2', 'Head']);
    expect(r.part.bounding_box.z).toBe('2.600000 in');
    // One undo step for the whole tool.
    store.undo();
    expect(store.state.features.length).toBe(0);
  });

  it('tube makes a smooth limb along a 3D path with domed ends, joined to a body', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const c = ctx(store);
    await executeTool(c, 'loft_sections', { name: 'Torso', sections: [{ offset: 0, oval: { rx: 12, ry: 8 } }, { offset: 30, oval: { rx: 14, ry: 9 } }], end_point: [0, 0, 40] });
    const t: any = await executeTool(c, 'tube', { name: 'Left Arm', path: [[-10, 0, 25], [-20, -3, 18], [-26, -6, 5], [-27, -10, -6]], radii: [4, 3.5, 3, 2.6], start_end: 'flat' });
    expect(t.ok, JSON.stringify(t)).toBe(true);
    expect(t.sketches).toEqual(['Left Arm Section 1', 'Left Arm Section 2', 'Left Arm Section 3', 'Left Arm Section 4', 'Left Arm End Dome 1', 'Left Arm End Dome 2']);
    // The rounded end reaches one radius past the last path point along the path.
    expect(t.part.bounding_box.min[2]).toBeLessThan(-6 - 2.0);
    const m: any = await executeTool(c, 'mirror', { features: ['Left Arm'], plane: { plane: 'YZ' }, name: 'Right Arm' });
    expect(m.ok, JSON.stringify(m)).toBe(true);
    const fl: any = await executeTool(c, 'fillet', { edges: [{ between: ['Torso', 'Left Arm'] }], radius: 1.5, name: 'Left Shoulder Blend' });
    expect(fl.ok, JSON.stringify(fl)).toBe(true);
    const tip: any = await executeTool(c, 'tube', { name: 'Horn', path: [[0, 0, 38], [3, -2, 48], [8, -2, 54]], radii: [3, 2, 1], ends: 'point', start_end: 'flat' });
    expect(tip.ok, JSON.stringify(tip)).toBe(true);
  });

  it('a correct join at a dome\'s pole is not rejected by the volume check (seams that failed at random before)', async () => {
    // The same torso, arms and horn, with the loft ids (which place the seams) of a build that
    // failed in CI and in 6 of 40 local builds: the horn starts inside the torso right below its
    // dome's pole. The join was right (whole-body integration and a fine mesh agreed within
    // 0.1 mm^3), but the changed-faces volume integral was 1 mm^3 off and rejected it.
    const store = new DocumentStore(); store.setUnits('mm');
    const c = ctx(store);
    await executeTool(c, 'loft_sections', { name: 'Torso', sections: [{ offset: 0, oval: { rx: 12, ry: 8 } }, { offset: 30, oval: { rx: 14, ry: 9 } }], end_point: [0, 0, 40] });
    await executeTool(c, 'tube', { name: 'Left Arm', path: [[-10, 0, 25], [-20, -3, 18], [-26, -6, 5], [-27, -10, -6]], radii: [4, 3.5, 3, 2.6], start_end: 'flat' });
    await executeTool(c, 'mirror', { features: ['Left Arm'], plane: { plane: 'YZ' }, name: 'Right Arm' });
    await executeTool(c, 'fillet', { edges: [{ between: ['Torso', 'Left Arm'] }], radius: 1.5, name: 'Left Shoulder Blend' });
    await executeTool(c, 'tube', { name: 'Horn', path: [[0, 0, 38], [3, -2, 48], [8, -2, 54]], radii: [3, 2, 1], ends: 'point', start_end: 'flat' });
    const r = regenerate(oc, withRecordedSeams(store.state, { Torso: 'lo_s4xt8b14', 'Left Arm': 'lo_28l7pl1h', Horn: 'lo_guha741q' }), { solver });
    try {
      expect(r.status.filter((s) => !s.ok), JSON.stringify(r.status.filter((s) => !s.ok))).toEqual([]);
      expect(countSolids(oc, r.shape!)).toBe(1);
    } finally { releaseRegen(r); }
  }, 120000);

  it('profile_body sculpts a body from front and side silhouettes with a domed top', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    // A stone head: the side profile has a brow that juts forward and a chin; the width profile has its own keys.
    const r: any = await executeTool(c, 'profile_body', { name: 'Head', squareness: 3.5, front_squareness: 4, end: 'round', end_dome: 0.4, stations: [
      { at: 0, x: 1.0, y: [-0.9, 0.8] },
      { at: 0.6, y: [-1.15, 0.8] }, // chin
      { at: 1.0, y: [-0.95, 0.85] },
      { at: 2.2, x: 1.1, y: [-1.0, 0.9] },
      { at: 2.6, y: [-1.35, 0.95] }, // brow
      { at: 3.2, x: 1.0, y: [-1.0, 0.95] },
    ] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const names = store.state.features.map((f) => f.name);
    expect(names[names.length - 1]).toBe('Head');
    expect(names.filter((n) => n.startsWith('Head Section')).length).toBeGreaterThanOrEqual(14);
    const bb = r.part.bounding_box;
    expect(parseFloat(bb.z)).toBeCloseTo(3.6, 2);
    // Exact: every section point lies on the lofted surface; the solid is valid.
    const reg = regenerate(oc, store.state, { solver });
    expect(new oc.BRepCheck_Analyzer(reg.shape!, true, false).IsValid()).toBe(true);
    const sk: any = store.state.features.find((f) => f.name === 'Head Section 7');
    for (const q of sk.entities[0].points.slice(0, 24).filter((_: unknown, i: number) => i % 3 === 0)) {
      const vtx = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(q.x * 25.4, q.y * 25.4, sk.offset * 25.4)).Vertex();
      const d = new oc.BRepExtrema_DistShapeShape(vtx, reg.shape!, (oc as any).Extrema_ExtFlag?.Extrema_ExtFlag_MIN, (oc as any).Extrema_ExtAlgo?.Extrema_ExtAlgo_Grad, new oc.Message_ProgressRange());
      expect(d.Value()).toBeLessThan(1e-5);
    }
    // The brow is the most forward point; the loft follows the silhouette closely.
    expect(bb.min[1]).toBeGreaterThan(-1.35 * 1.03);
    expect(bb.min[1]).toBeLessThan(-1.35 * 0.98);
    expect(parseFloat(bb.x)).toBeGreaterThan(2.2 * 0.98);
    expect(parseFloat(bb.x)).toBeLessThan(2.2 * 1.04);
    // An animal body along Y, with a pointed snout end and rounded rump.
    const b: any = await executeTool(c, 'profile_body', { name: 'Body', axis: 'Y', start: 'round', end: 'point', stations: [
      { at: -2, x: 0.8, z: [3.2, 4.6] }, { at: 0, x: 1.0, z: [3.0, 4.8] }, { at: 2, x: 0.6, z: [3.6, 4.6] }] });
    expect(b.ok, JSON.stringify(b)).toBe(true);
    expect(b.part.bounding_box.min[1]).toBeLessThan(-2.3);
    expect(b.part.bounding_box.max[1]).toBeGreaterThan(2.4);
    await expect(executeTool(c, 'profile_body', { name: 'Bad', stations: [{ at: 0, x: 1 }, { at: 1, x: 1 }] })).rejects.toThrow(/no station gives y/);
  });

  it('lofts circles exactly and closes tubes with true round domes', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const c = ctx(store);
    await executeTool(c, 'create_sketch', { plane: 'XY', name: 'Big', entities: [{ type: 'circle', cx: 0, cy: 0, diameter: 20 }] });
    await executeTool(c, 'create_sketch', { plane: 'XY', name: 'Small', offset: 20, entities: [{ type: 'circle', cx: 0, cy: 0, diameter: 10 }] });
    const l: any = await executeTool(c, 'loft', { profile_sketch_ids: ['Big', 'Small'], name: 'Cone' });
    expect(l.ok, JSON.stringify(l)).toBe(true);
    // Two circles: an exact truncated cone.
    expect(parseFloat(l.part.volume)).toBeCloseTo((Math.PI * 20 / 3) * (100 + 50 + 25), 2);
    // A straight tube with a round end: cylinder plus an exact-looking hemisphere, no bulge past the radius.
    const s2 = new DocumentStore(); s2.setUnits('mm');
    const c2 = ctx(s2);
    const t: any = await executeTool(c2, 'tube', { name: 'Rod', path: [[0, 0, 0], [0, 0, 10], [0, 0, 20], [0, 0, 30]], radius: 5, start_end: 'flat', finish_end: 'round' });
    expect(t.ok, JSON.stringify(t)).toBe(true);
    const bb = t.part.bounding_box;
    expect(parseFloat(bb.x)).toBeLessThan(10 * 1.003);
    expect(bb.max[2]).toBeCloseTo(35, 3);
    const v = Math.PI * 25 * 30 + (2 / 3) * Math.PI * 125;
    expect(Math.abs(parseFloat(t.part.volume) - v) / v).toBeLessThan(0.005);
  });

  it('build_model takes flat steps and carves smooth dish recesses', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    const r: any = await executeTool(c, 'build_model', { steps: [
      { tool: 'profile_body', name: 'Face Block', stations: [{ at: 0, x: 1, y: [-1, 1] }, { at: 2, x: 1, y: [-1, 1] }] },
      // Eye socket: an oval in front of the face, one at the face, then a round-bottomed dish 0.25 deep.
      { tool: 'loft_sections', name: 'Left Eye Socket', plane: 'XZ', operation: 'cut', sections: [
        { offset: 1.2, oval: { cx: -0.4, cy: 1.3, rx: 0.3, ry: 0.18 } }, { offset: 0.98, oval: { cx: -0.4, cy: 1.3, rx: 0.28, ry: 0.16 } }], end_point: [-0.4, -0.75, 1.3] },
      { tool: 'mirror', name: 'Right Eye Socket', features: ['Left Eye Socket'], plane: { plane: 'YZ' } },
    ] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.features.map((f: any) => f.name)).toContain('Right Eye Socket');
    const block = 2 * 2 * 2;
    expect(parseFloat(r.part.volume)).toBeLessThan(block * 1.0);
    expect(new oc.BRepCheck_Analyzer(regenerate(oc, store.state, { solver }).shape!, true, false).IsValid()).toBe(true);
  });

  it('exports a closed, watertight STL of a domed organic body with a limb', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    await executeTool(c, 'profile_body', { name: 'Body', end: 'round', stations: [{ at: 0, x: 1, y: [-0.8, 0.8] }, { at: 1.5, x: 1.2, y: [-1, 0.9] }, { at: 3, x: 0.9, y: [-0.7, 0.7] }] });
    await executeTool(c, 'tube', { name: 'Arm', path: [[0.8, 0, 2], [1.5, -0.3, 1.4], [1.7, -0.5, 0.8]], radii: [0.3, 0.22, 0.18], start_end: 'flat', finish_end: 'round' });
    const shape = regenerate(oc, store.state, { solver, topology: false }).shape!;
    const { data: b, report } = exportStlFile(oc, shape, { linearDeflection: 0.05, angularDeflection: 0.2, unit: 'mm', format: 'binary', name: 'Body' });
    expect(report.problems).toEqual([]);
    expect(report.measuredDeviation).toBeLessThanOrEqual(0.05);
    const dv = new DataView(b.buffer, b.byteOffset);
    const n = dv.getUint32(80, true);
    const key = (o: number) => [0, 4, 8].map((k) => Math.round(dv.getFloat32(o + k, true) * 1e4)).join(',');
    const edges = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      const v = [key(o), key(o + 12), key(o + 24)];
      expect(new Set(v).size).toBe(3); // no zero-area triangles
      for (let k = 0; k < 3; k++) { const a = v[k], d = v[(k + 1) % 3]; const e = a < d ? `${a}|${d}` : `${d}|${a}`; edges.set(e, (edges.get(e) ?? 0) + 1); }
    }
    expect([...edges.values()].every((m) => m === 2)).toBe(true);
  });

  it('pchip interpolation never overshoots its keys', () => {
    const f = pchip([0, 1, 2, 3], [0, 1, 1, 0]);
    for (let x = 0; x <= 3; x += 0.01) { expect(f(x)).toBeLessThanOrEqual(1 + 1e-12); expect(f(x)).toBeGreaterThanOrEqual(-1e-12); }
    expect(f(1.5)).toBeCloseTo(1, 12);
  });

  it('oval entities follow parameters', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    await executeTool(c, 'set_parameter', { name: 'w', value: '2' });
    await executeTool(c, 'create_sketch', { plane: 'XY', name: 'Egg', entities: [{ type: 'oval', cx: 0, cy: 0, rx: 'w/2', ry: 0.5 }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: 'Egg', depth: 1, name: 'Egg Body' });
    expect(ex.part.bounding_box.x).toBe('2.000000 in');
    const p: any = await executeTool(c, 'set_parameter', { name: 'w', value: '3' });
    expect(p.part.bounding_box.x).toBe('3.000000 in');
  });
});

describe('incremental regeneration', () => {
  it('gives exactly the same result as a full rebuild after appends, middle edits and parameter changes', async () => {
    const { clearRegenCache } = await import('../src/kernel/regen');
    clearRegenCache();
    const store = new DocumentStore(); store.setUnits('mm');
    const c: ExecutorContext = { ...ctx(store), deferResults: true };
    const check = () => {
      const a = regenerate(oc, store.state, { solver, cache: true });
      const b = regenerate(oc, store.state, { solver });
      const va = a.shape ? massProperties(oc, a.shape).volume : 0, vb = b.shape ? massProperties(oc, b.shape).volume : 0;
      expect(va).toBeCloseTo(vb, 6);
      expect(a.status.map((s) => [s.id, s.ok, s.message])).toEqual(b.status.map((s) => [s.id, s.ok, s.message]));
      expect(a.topology?.faces.map((f) => f.tags)).toEqual(b.topology?.faces.map((f) => f.tags));
    };
    await executeTool(c, 'set_parameter', { name: 'h', value: '20' });
    await executeTool(c, 'loft_sections', { name: 'Body', sections: [{ offset: 0, oval: { rx: 10, ry: 8 } }, { offset: 'h', oval: { rx: 12, ry: 9 } }], end_point: [0, 0, 30] });
    check();
    await executeTool(c, 'create_sketch', { plane: 'XZ', name: 'Hole Sketch', entities: [{ type: 'circle', cx: 0, cy: 10, diameter: 4 }] });
    await executeTool(c, 'extrude', { sketch_id: 'Hole Sketch', depth: 40, direction: 'symmetric', operation: 'cut', name: 'Hole' });
    check();
    await executeTool(c, 'update_feature', { feature_id: 'Hole', changes: { depth: 10 } });
    check();
    await executeTool(c, 'set_parameter', { name: 'h', value: '24' });
    check();
    const sk = store.state.features.find((f) => f.name === 'Body Section 1')!;
    store.setSuppressed(store.state.features.find((f) => f.name === 'Hole')!.id, true);
    check();
    store.setRollback(2);
    check();
    expect(sk).toBeTruthy();
  });
});
