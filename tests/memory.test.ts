/**
 * Kernel memory: no OpenCascade object may be dropped without `.delete()`.
 * (The rules are in src/kernel/mem.ts. A dropped shape keeps its whole B-rep
 * on the WASM heap, which never shrinks, so a long session would run out of
 * memory.) The leak finder (tests/helpers/ocLeaks.ts) counts every value
 * object that JavaScript garbage-collected while it was still undeleted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities } from '../src/core/model';
import { regenerate, releaseRegen, clearRegenCache, type OC } from '../src/kernel/regen';
import { massProperties, tessellate, entityInfo, minDistance } from '../src/kernel/query';
import { exportStepFile, exportStlFile } from '../src/kernel/exporters';
import { STL_DEFAULT } from '../src/kernel/exportDefaults';
import { partQuality } from '../src/kernel/quality';
import { drawingGeometry } from '../src/kernel/hlr';
import { createStandardDrawing } from '../src/drawing/layout';
import { viewRequests } from '../src/drawing/compose';
import { edgeRefFrom, faceRefFrom, type Topology } from '../src/kernel/naming';
import * as F from '../src/core/featureCommands';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import type { Vec3 } from '../src/core/featureTypes';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { trackOc, type OcTracker, type LeakReport } from './helpers/ocLeaks';

const IN = 25.4;
let oc: OC;
let solver: SketchSolver;
let tr: OcTracker;
beforeAll(async () => { oc = (await init()) as OC; tr = trackOc(oc); solver = await createSketchSolver(); });
afterAll(() => clearRegenCache());

const show = (r: LeakReport) => r.byOrigin.slice(0, 15).map(([k, n]) => `${n} x ${k}`).join(', ');

/** 4 x 3 x T plate with a 4 x 3 pattern of 1/4" holes. */
function holePlate() {
  const st = new DocumentStore();
  st.setParameter('T', '0.5');
  const sk = st.addSketch('XY', rectangleEntities(0, 0, 4, 3));
  st.addExtrude(sk, 'T');
  const h = F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { base: 'XY', offset: 'T' }, points: [{ x: 0.5, y: 0.5 }] });
  F.addLinearPattern(st, { features: [h], dir1: { axis: 'X' }, spacing1: 0.7, count1: 4, dir2: { axis: 'Y' }, spacing2: 0.65, count2: 3 });
  return st;
}

/** 2 x 2 x H block with a fillet, a chamfer and a shell open at the top. */
function blendedBox() {
  const st = new DocumentStore();
  st.setParameter('H', '1');
  const sk = st.addSketch('XY', rectangleEntities(0, 0, 2, 2));
  st.addExtrude(sk, 'H');
  const t = regenerate(oc, st.state, { solver });
  const topo = t.topology as Topology;
  releaseRegen(t);
  const near = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;
  const edgeAt = (x: number, y: number, z: number) => edgeRefFrom(topo, topo.edges.findIndex((e) => near(e.mid, [x * IN, y * IN, z * IN])));
  F.addFillet(st, { edges: [edgeAt(2, 2, 0.5)], radius: 0.2 });
  F.addChamfer(st, { edges: [edgeAt(0, 0, 0.5)], distance: 0.1 });
  const top = topo.faces.findIndex((f) => near(f.center, [1 * IN, 1 * IN, 1 * IN]));
  F.addShell(st, { faces: [faceRefFrom(topo, top)], thickness: 0.05 });
  return st;
}

describe('kernel memory', () => {
  for (const [name, make, param, base] of [
    ['a plate with a hole pattern', holePlate, 'T', 0.5],
    ['a block with a fillet, a chamfer and a shell', blendedBox, 'H', 1],
  ] as const) {
    it(`editing ${name} (cached rebuild, display mesh, mass) leaves no kernel object behind`, async () => {
      const st = make();
      const edit = (i: number) => {
        st.setParameter(param, String(base + i * 0.001));
        const r = regenerate(oc, st.state, { solver, cache: true });
        expect(r.status.filter((s) => !s.ok)).toEqual([]);
        tessellate(oc, r.shape!);
        massProperties(oc, r.shape!);
      };
      edit(0); edit(1);
      await tr.leaks();
      const live = tr.live();
      for (let i = 2; i < 5; i++) edit(i);
      const rep = await tr.leaks();
      expect(rep.total, show(rep)).toBe(0);
      // The cache keeps one rebuild's worth of objects: the count does not grow with edits.
      expect(tr.live()).toBe(live);
      clearRegenCache();
      // Only the one curve sampler the mesher keeps for reuse (query.ts curvePoints) is left.
      expect(tr.live()).toBe(1);
    }, 120000);
  }

  it('rebuilding a part does not grow the kernel heap (booleans and checks release their data)', async () => {
    // A kernel of its own, so the heap starts small. Before the fix each rebuild of this plate kept
    // about 8 MB (boolean operations and validity checks whose destructors are empty, see mem.ts).
    clearRegenCache();
    const own = (await init()) as OC;
    const heap = () => (own as any).wasmMemory.buffer.byteLength as number;
    const st = holePlate();
    const edit = (i: number) => {
      st.setParameter('T', String(0.5 + i * 0.001));
      const r = regenerate(own, st.state, { solver, cache: true });
      expect(r.status.filter((s) => !s.ok)).toEqual([]);
      massProperties(own, r.shape!);
    };
    for (let i = 0; i < 3; i++) edit(i);
    const before = heap();
    for (let i = 3; i < 43; i++) edit(i);
    expect(heap() / 1e6).toBe(before / 1e6);
    clearRegenCache();
  }, 300000);

  it('an uncached rebuild is freed completely by releaseRegen', async () => {
    const st = blendedBox();
    await tr.leaks();
    const before = tr.live();
    const r = regenerate(oc, st.state, { solver });
    expect(r.shape).not.toBeNull();
    releaseRegen(r);
    const rep = await tr.leaks();
    expect(rep.total, show(rep)).toBe(0);
    expect(tr.live()).toBe(before);
  }, 120000);

  it('an organic model (smooth loft, tube, mirror, blend) rebuilds without leaving kernel objects behind', async () => {
    const store = new DocumentStore(); store.setUnits('mm');
    const c: ExecutorContext = {
      store,
      regen: async () => {
        const r = regenerate(oc, store.state, { solver });
        try { return { mesh: null, status: r.status, sketches: r.sketches, mass: r.shape ? massProperties(oc, r.shape) : null, topology: r.topology ?? null, ms: 0 }; } finally { releaseRegen(r); }
      },
      selection: () => [],
      info: async () => { throw new Error('not used'); },
    };
    for (const [tool, args] of [
      ['loft_sections', { name: 'Torso', sections: [{ offset: 0, oval: { rx: 12, ry: 8 } }, { offset: 30, oval: { rx: 14, ry: 9 } }], end_point: [0, 0, 40] }],
      ['tube', { name: 'Left Arm', path: [[-10, 0, 25], [-20, -3, 18], [-26, -6, 5], [-27, -10, -6]], radii: [4, 3.5, 3, 2.6], start_end: 'flat' }],
      ['mirror', { features: ['Left Arm'], plane: { plane: 'YZ' }, name: 'Right Arm' }],
      ['fillet', { edges: [{ between: ['Torso', 'Left Arm'] }], radius: 1.5, name: 'Left Shoulder Blend' }],
    ] as const) {
      const res: any = await executeTool(c, tool, args as any);
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
    await tr.leaks();
    const before = tr.live();
    const r = regenerate(oc, store.state, { solver });
    expect(r.status.filter((s) => !s.ok)).toEqual([]);
    tessellate(oc, r.shape!);
    massProperties(oc, r.shape!);
    releaseRegen(r);
    const rep = await tr.leaks();
    expect(rep.total, show(rep)).toBe(0);
    expect(tr.live()).toBe(before);
  }, 300000);

  it('queries, exports, quality checks and drawing views leave no kernel object behind', async () => {
    const st = holePlate();
    const r = regenerate(oc, st.state, { solver });
    const s = r.shape!;
    const doc = createStandardDrawing(st.state, drawingGeometry(oc, s, []).model);
    await tr.leaks();
    const live = tr.live();
    entityInfo(oc, s, 'face', 0);
    entityInfo(oc, s, 'edge', 3);
    minDistance(oc, s, { kind: 'face', index: 0 }, { kind: 'edge', index: 5 });
    exportStepFile(oc, s, { unit: 'in', schema: 'AP214', name: 'Plate' });
    exportStepFile(oc, s, { unit: 'mm', schema: 'AP242', name: 'Plate' });
    exportStlFile(oc, s, { ...STL_DEFAULT, unit: 'mm', format: 'binary', name: 'Plate' });
    exportStlFile(oc, s, { ...STL_DEFAULT, unit: 'in', format: 'ascii', name: 'Plate' });
    partQuality(oc, s);
    drawingGeometry(oc, s, viewRequests(doc, doc.sheets[0]));
    const rep = await tr.leaks();
    expect(rep.total, show(rep)).toBe(0);
    expect(tr.live()).toBe(live);
    releaseRegen(r);
  }, 120000);
});
