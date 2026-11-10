/**
 * CHAD benchmarks: rebuild speed, mesh, naming, preview, drawings and
 * geometry-worker memory on fixed reference models. Run with `npm run bench`.
 *
 * Timings are REPORTED, not asserted (machines differ). What is asserted is
 * that every model still builds and keeps its exact volume, so a "faster"
 * change that breaks a model is caught here too.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities } from '../src/core/model';
import { regenerate, clearRegenCache, type OC } from '../src/kernel/regen';
import { massProperties, tessellate } from '../src/kernel/query';
import { topology, edgeRefFrom } from '../src/kernel/naming';
import { drawingGeometry } from '../src/kernel/hlr';
import { createStandardDrawing } from '../src/drawing/layout';
import { viewRequests } from '../src/drawing/compose';
import * as F from '../src/core/featureCommands';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import type { CadDocument } from '../src/core/model';

const IN = 25.4;
const IN3 = IN ** 3;
let oc: OC;
let solver: SketchSolver;

/** One row of the report. */
interface Row { model: string; op: string; ms?: number; mb?: number; note?: string }
const rows: Row[] = [];
const heapMB = () => ((oc as any).wasmMemory?.buffer?.byteLength ?? NaN) / 1e6;
function time<T>(model: string, op: string, fn: () => T, note?: string): T {
  const t0 = performance.now();
  const r = fn();
  rows.push({ model, op, ms: +(performance.now() - t0).toFixed(1), ...(note ? { note } : {}) });
  return r;
}
async function timeAsync<T>(model: string, op: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  rows.push({ model, op, ms: +(performance.now() - t0).toFixed(1) });
  return r;
}
const ok = (r: ReturnType<typeof regenerate>) => {
  const bad = r.status.filter((s) => !s.ok);
  expect(bad, JSON.stringify(bad)).toEqual([]);
  expect(r.shape).not.toBeNull();
  return r;
};
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

// ------------------------------------------------------------------ models

/** 8 x 5 x T plate with a 1/4" counterbore hole patterned 10 x 7 (70 holes). */
function holePlate() {
  const st = new DocumentStore();
  st.setParameter('T', '0.5');
  const sk = st.addSketch('XY', rectangleEntities(0, 0, 8, 5), { name: 'Plate Sketch' });
  st.addExtrude(sk, 'T', { name: 'Plate' });
  const h = F.addHole(st, { holeType: 'counterbore', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { base: 'XY', offset: 'T' }, points: [{ x: 0.5, y: 0.5 }] });
  const pat = F.addLinearPattern(st, { features: [h], dir1: { axis: 'X' }, spacing1: 0.7, count1: 10, dir2: { axis: 'Y' }, spacing2: 0.65, count2: 7, name: 'Hole Grid' });
  return { st, pat };
}
/** Volume of holePlate in in^3 for thickness T (ANSI 1/4 counterbore: 0.281 thru, 0.438 x 0.25 cbore). */
const holePlateVolume = (T: number) => 8 * 5 * T - 70 * Math.PI * ((0.438 / 2) ** 2 * 0.25 + (0.281 / 2) ** 2 * (T - 0.25));

/** 4 x 2 x 1 block with its four vertical edges filleted 0.25. */
function filletedBox() {
  const st = new DocumentStore();
  const sk = st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Box Sketch' });
  st.addExtrude(sk, 1, { name: 'Box' });
  const r = ok(regenerate(oc, st.state, { solver }));
  const t = r.topology!;
  const vertical = t.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.mid[2] - 0.5 * IN) < 1e-6);
  expect(vertical.length).toBe(4);
  F.addFillet(st, { edges: vertical.map(({ i }) => edgeRefFrom(t, i)), radius: 0.25, name: 'Corner Rounds' });
  return st;
}

/** Organic figure built by the chat's build_model tool (same as tests/organic.test.ts). */
async function organicFigure() {
  const store = new DocumentStore(); store.setUnits('mm');
  const ctx: ExecutorContext = {
    store,
    regen: async () => {
      const r = regenerate(oc, store.state, { solver, cache: true });
      return { mesh: null, status: r.status, sketches: r.sketches, mass: null, topology: r.topology ?? null, ms: 0 };
    },
    selection: () => [],
    info: async () => { throw new Error('not used'); },
  };
  const ring = (n: number, rx: number, ry: number): [number, number][] => Array.from({ length: n }, (_, i) => { const q = (2 * Math.PI * i) / n; return [+(rx * Math.cos(q)).toFixed(6), +(ry * Math.sin(q)).toFixed(6)]; });
  const sec = (i: number, z: number, s: number) => ({ tool: 'create_sketch', args: { plane: 'XY', offset: z, name: `Body Section ${i}`, entities: [{ type: 'spline', closed: true, points: ring(10, 14 * s, 10 * s) }] } });
  const res: any = await executeTool(ctx, 'build_model', { steps: [
    sec(1, 0, 1), sec(2, 15, 1.25), sec(3, 30, 1.1), sec(4, 45, 0.7),
    { tool: 'loft', args: { profile_sketch_ids: ['Body Section 1', 'Body Section 2', 'Body Section 3', 'Body Section 4'], end_point: [0, 0, 55], name: 'Body' } },
    { tool: 'create_sketch', args: { plane: 'XZ', offset: 5, name: 'Nose Profile', entities: [{ type: 'circle', cx: 0, cy: 28, diameter: 7 }] } },
    { tool: 'extrude', args: { sketch_id: 'Nose Profile', depth: 12, direction: 'normal', operation: 'add', name: 'Nose' } },
    { tool: 'fillet', args: { edges: [{ between: ['Body', 'Nose'] }], radius: 2, name: 'Nose Blend' } },
  ] });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return store;
}

/** The live preview as the worker computes it (src/kernel/worker.ts, op 'preview'): model before the feature + the feature's tool. */
function previewLike(doc: CadDocument, featureId: string) {
  const idx = doc.features.findIndex((f) => f.id === featureId);
  const before = regenerate(oc, { ...doc, rollback: idx }, { topology: true, solver });
  const withTool = regenerate(oc, { ...doc, rollback: idx + 1 }, { captureToolFor: featureId, topology: false, solver });
  if (before.shape) tessellate(oc, before.shape);
  if (withTool.tool) tessellate(oc, withTool.tool);
}

// ------------------------------------------------------------------ benchmarks

describe('benchmarks', () => {
  it('70-hole plate: rebuild, edit, preview, mesh, naming, mass', () => {
    const M = '70-hole plate';
    const { st, pat } = holePlate();
    clearRegenCache();
    const r = ok(time(M, 'full rebuild (cold)', () => regenerate(oc, st.state, { solver, cache: true })));
    expect(rel(massProperties(oc, r.shape!).volume / IN3, holePlateVolume(0.5))).toBeLessThan(1e-9);
    time(M, 'rebuild without face-name summary', () => regenerate(oc, st.state, { solver, topology: false }));
    time(M, 'face-name summary (topology)', () => topology(oc, r.named!));
    time(M, 'display mesh (first)', () => tessellate(oc, r.shape!));
    time(M, 'display mesh (again, already meshed)', () => tessellate(oc, r.shape!));
    time(M, 'mass properties', () => massProperties(oc, r.shape!));
    st.updateFeature(pat, { count1: 9 });
    ok(time(M, 'edit last feature (pattern count)', () => regenerate(oc, st.state, { solver, cache: true })));
    st.updateFeature(pat, { count1: 10 });
    regenerate(oc, st.state, { solver, cache: true });
    st.setParameter('T', '0.6');
    const r2 = ok(time(M, 'change thickness parameter', () => regenerate(oc, st.state, { solver, cache: true })));
    expect(rel(massProperties(oc, r2.shape!).volume / IN3, holePlateVolume(0.6))).toBeLessThan(1e-9);
    time(M, 'live preview of the pattern', () => previewLike(st.state, pat));
  });

  it('filleted box: rebuild and mesh', () => {
    const M = 'filleted box';
    const st = filletedBox();
    clearRegenCache();
    const r = ok(time(M, 'full rebuild (cold)', () => regenerate(oc, st.state, { solver, cache: true })));
    // 4 x 2 x 1 block minus four corner spandrels (r^2 - pi r^2 / 4) x height.
    const exact = 8 - 4 * (0.25 ** 2 - (Math.PI * 0.25 ** 2) / 4);
    expect(rel(massProperties(oc, r.shape!).volume / IN3, exact)).toBeLessThan(1e-9);
    time(M, 'display mesh', () => tessellate(oc, r.shape!));
  });

  it('organic figure: build_model, rebuild, mesh, mass', async () => {
    const M = 'organic figure';
    const store = await timeAsync(M, 'build_model (chat tool, 9 steps)', organicFigure);
    clearRegenCache();
    const r = ok(time(M, 'full rebuild (cold)', () => regenerate(oc, store.state, { solver, cache: true })));
    time(M, 'display mesh', () => tessellate(oc, r.shape!));
    time(M, 'mass properties', () => massProperties(oc, r.shape!));
  });

  it('drawing: standard 3 views + isometric', () => {
    const M = 'drawing';
    const { st } = holePlate();
    const r = ok(regenerate(oc, st.state, { solver }));
    const doc = createStandardDrawing(st.state, drawingGeometry(oc, r.shape, []).model);
    const req = viewRequests(doc, doc.sheets[0]);
    const g = time(M, `hidden-line views (${req.length}) of the 70-hole plate`, () => drawingGeometry(oc, r.shape, req));
    expect(g.views.every((v) => !v.error)).toBe(true);
  });

  it('geometry-worker memory over repeated edits', async () => {
    // A fresh kernel of its own: the heap of the shared one already grew for the big models above,
    // so it would hide what these edits keep (the WASM heap never shrinks; leaks make it grow).
    clearRegenCache();
    const mo = (await init()) as OC;
    const moMB = () => ((mo as any).wasmMemory?.buffer?.byteLength ?? NaN) / 1e6;
    const M = 'memory';
    const st = new DocumentStore();
    st.setParameter('T', '0.5');
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 4, 3));
    st.addExtrude(sk, 'T');
    const h = F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { base: 'XY', offset: 'T' }, points: [{ x: 0.5, y: 0.5 }] });
    F.addLinearPattern(st, { features: [h], dir1: { axis: 'X' }, spacing1: 0.7, count1: 4, dir2: { axis: 'Y' }, spacing2: 0.65, count2: 3 });
    // What the app does on every edit: rebuild (cached), mesh, mass.
    const edit = (i: number) => { st.setParameter('T', String(0.5 + i * 0.001)); const rr = ok(regenerate(mo, st.state, { solver, cache: true })); tessellate(mo, rr.shape!); massProperties(mo, rr.shape!); };
    for (let i = 0; i < 5; i++) edit(i); // warm up
    const h0 = moMB();
    const N = 100;
    const t0 = performance.now();
    for (let i = 5; i < 5 + N; i++) edit(i);
    const ms = performance.now() - t0;
    const h1 = moMB();
    rows.push({ model: M, op: `12-hole plate, ${N} edits: heap before`, mb: +h0.toFixed(1) });
    rows.push({ model: M, op: `12-hole plate, ${N} edits: heap after`, mb: +h1.toFixed(1) });
    rows.push({ model: M, op: '12-hole plate: heap growth per edit', mb: +((h1 - h0) / N).toFixed(2), note: 'target ~0 (plan item B1)' });
    rows.push({ model: M, op: '12-hole plate: average edit', ms: +(ms / N).toFixed(1) });
    clearRegenCache();
  });
});

// ------------------------------------------------------------------ report

afterAll(() => {
  const outDir = join(process.cwd(), 'bench-results');
  mkdirSync(outDir, { recursive: true });
  const meta = { date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, platform: `${os.platform()} ${os.arch()}` };
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify({ meta, rows }, null, 2));
  // Compare with a saved baseline when given: BENCH_BASELINE=path/to/old.json npm run bench
  const basePath = process.env.BENCH_BASELINE;
  const base: Row[] | null = basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')).rows : null;
  const key = (r: Row) => `${r.model} | ${r.op}`;
  const old = new Map((base ?? []).map((r) => [key(r), r]));
  const lines = [`CHAD benchmarks  ${meta.date}  node ${meta.node}  ${meta.cpu} x${meta.cores}`, ''];
  for (const r of rows) {
    const v = r.ms !== undefined ? `${r.ms.toFixed(1).padStart(9)} ms` : `${(r.mb ?? NaN).toFixed(2).padStart(9)} MB`;
    const o = old.get(key(r));
    const ov = o ? (r.ms !== undefined ? o.ms : o.mb) : undefined;
    const nv = r.ms !== undefined ? r.ms : r.mb;
    const cmp = ov !== undefined && nv !== undefined ? `   was ${ov}${r.ms !== undefined ? ` (${(ov / Math.max(nv, 1e-9)).toFixed(2)}x faster)` : ''}` : '';
    lines.push(`${key(r).padEnd(70)} ${v}${cmp}${r.note ? `   [${r.note}]` : ''}`);
  }
  const text = lines.join('\n');
  writeFileSync(join(outDir, 'latest.txt'), text + '\n');
  console.log(`\n${text}\n\nSaved bench-results/latest.json and latest.txt`);
});
