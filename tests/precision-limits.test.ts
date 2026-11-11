/**
 * Precision stress test (docs/PRECISION_STRESS_TEST_2026-11-11.md), bugs 3 and 4:
 *  - bug 3: STL export of a curved part far from the origin ran without end / out of memory;
 *    it now stops at once with a clear message, while flat parts and parts nearer in still export;
 *  - bug 4: the chat read the volume of parts of 0.01 mm and smaller as "0.000000 mm^3".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { formatMeasure } from '../src/core/units';
import { regenerate, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo } from '../src/kernel/query';
import { exportStlFile, stlFarLimitMm, STL_MIN_SHARE } from '../src/kernel/exporters';
import { STL_PRESETS } from '../src/kernel/exportDefaults';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { massText } from '../src/ui/CommandPanel';
import { free } from '../src/kernel/mem';

let oc: OC;
beforeAll(async () => { oc = await init(); });

const DEG = Math.PI / 180;
const fine = STL_PRESETS.find((p) => p.id === 'fine')!;
const extra = STL_PRESETS.find((p) => p.id === 'extra')!;
const draft = STL_PRESETS.find((p) => p.id === 'draft')!;

/** A Ø20 x 20 mm cylinder whose axis is at x = off (mm). */
function cylinderAt(off: number) {
  const p = new (oc as any).gp_Pnt(off, 0, 0), d = new (oc as any).gp_Dir(0, 0, 1), ax = new (oc as any).gp_Ax2(p, d);
  const mk = new (oc as any).BRepPrimAPI_MakeCylinder(ax, 10, 20);
  const s = mk.Shape();
  free(mk, ax, d, p);
  return s;
}
function boxAt(off: number) {
  const p = new (oc as any).gp_Pnt(off, 0, 0);
  const mk = new (oc as any).BRepPrimAPI_MakeBox(p, 20, 10, 5);
  const s = mk.Shape();
  free(mk, p);
  return s;
}
const stl = (s: any, lin: number, ang: number) => exportStlFile(oc, s, { format: 'binary', unit: 'mm', linearDeflection: lin, angularDeflection: ang, name: 'far' });

describe('STL export far from the origin (stress-test bug 3)', () => {
  it('the distance limit leaves at least a quarter of the setting for the curves', () => {
    // margin = sqrt(3) * (x * 2^-24 + 1e-5 mm) must stay <= 3/4 of the setting
    for (const p of STL_PRESETS) {
      const x = stlFarLimitMm(p.linearDeflection);
      expect(Math.sqrt(3) * (x * 2 ** -24 + 1e-5)).toBeCloseTo((1 - STL_MIN_SHARE) * p.linearDeflection, 12);
    }
    // Hand-calculated: Fine 72.5 m, Extra fine 36.2 m, Draft 363 m.
    expect(stlFarLimitMm(fine.linearDeflection) / 1000).toBeCloseTo(72.47, 1);
    expect(stlFarLimitMm(extra.linearDeflection) / 1000).toBeCloseTo(36.15, 1);
    expect(stlFarLimitMm(draft.linearDeflection) / 1000).toBeCloseTo(363.1, 0);
  });

  it('a curved part 100 m out is refused at once with a message that says what works', () => {
    const s = cylinderAt(100_000);
    const t0 = Date.now();
    let msg = '';
    try { stl(s, fine.linearDeflection, fine.angularDeflection); } catch (e) { msg = (e as Error).message; }
    expect(Date.now() - t0).toBeLessThan(5000); // was: minutes, then out of memory
    expect(msg).toMatch(/100 m from the origin/);
    expect(msg).toMatch(/0\.01 mm works up to 72\.5 m/);
    expect(msg).toMatch(/Draft works here/);
    expect(msg).toMatch(/STEP file is not affected/);
    // Draft is within its own limit there: it exports, inside its setting, watertight.
    const r = stl(s, draft.linearDeflection, draft.angularDeflection);
    expect(r.report.openEdges).toBe(0);
    expect(r.report.measuredDeviation).toBeLessThanOrEqual(draft.linearDeflection);
    s.delete();
  });

  it('Extra fine is refused past its limit; no coarser setting is named when none works', () => {
    const s = cylinderAt(40_000);
    expect(() => stl(s, extra.linearDeflection, extra.angularDeflection)).toThrow(/40 m from the origin.*Fine works here/);
    s.delete();
    const far = cylinderAt(1_000_000);
    let msg = '';
    try { stl(far, draft.linearDeflection, draft.angularDeflection); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/1000 m from the origin/);
    expect(msg).not.toMatch(/works here/);
    far.delete();
  });

  it('a curved part 60 m out still exports at Fine, inside the setting', () => {
    const s = cylinderAt(60_000);
    const r = stl(s, fine.linearDeflection, fine.angularDeflection);
    expect(r.report.openEdges).toBe(0);
    expect(r.report.measuredDeviation).toBeLessThanOrEqual(fine.linearDeflection);
    s.delete();
  });

  it('a flat part (planes and straight edges) is never refused for its distance', () => {
    const s = boxAt(100_000);
    const r = stl(s, extra.linearDeflection, 3 * DEG);
    expect(r.report.triangles).toBe(12);
    expect(r.report.openEdges).toBe(0);
    s.delete();
  });
});

describe('volume, area and mass keep their digits (stress-test bug 4)', () => {
  it('formatMeasure', () => {
    // Unchanged from 1 up: 6 decimals.
    expect(formatMeasure(1000)).toBe('1000.000000');
    expect(formatMeasure(2.0307694)).toBe('2.030769');
    expect(formatMeasure(0)).toBe('0.000000');
    // Below 1: 7 significant digits, never "0.000000".
    expect(formatMeasure(0.000117)).toBe('0.0001170000');
    expect(formatMeasure(1.25e-7)).toBe('1.250000e-7');
    expect(formatMeasure(-1.25e-7)).toBe('-1.250000e-7');
    expect(formatMeasure(0.99999999)).toBe('1.000000');
    // Huge: no digits past what a double holds (15 significant).
    expect(formatMeasure(1.25e17)).toBe('125000000000000000');
    expect(formatMeasure(123456789.123456789)).toBe('123456789.123457');
    // Grams with 4 decimals as before, 5 significant digits below 1 g.
    expect(formatMeasure(7.85, 4)).toBe('7.8500');
    expect(formatMeasure(7.85e-9, 4)).toBe('7.8500e-9');
    for (const v of [3.3e-13, 4.2e-9, 0.0123456789, 0.5, 7, 12345.678, 9.87e14]) {
      expect(Math.abs(parseFloat(formatMeasure(v)) - v) / v).toBeLessThan(1e-6);
    }
  });

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

  it('the chat reads the volume of a 0.01 mm cube (was "0.000000 mm^3")', async () => {
    const store = new DocumentStore();
    store.setUnits('mm');
    store.setMaterial({ name: 'Steel', density: 7.85 });
    const c = ctx(store);
    const sk: any = await executeTool(c, 'create_sketch', { plane: 'XY', entities: [{ type: 'rectangle', x: 0, y: 0, width: '0.01', height: '0.01' }] });
    const ex: any = await executeTool(c, 'extrude', { sketch_id: sk.sketch_id, depth: '0.01', operation: 'new' });
    expect(ex, JSON.stringify(ex)).toMatchObject({ ok: true });
    expect(ex.part.volume).toMatch(/ mm\^3$/);
    expect(parseFloat(ex.part.volume)).not.toBe(0);
    expect(Math.abs(parseFloat(ex.part.volume) - 1e-6) / 1e-6).toBeLessThan(1e-6);
    expect(Math.abs(parseFloat(ex.part.surface_area) - 6e-4) / 6e-4).toBeLessThan(1e-6);
    // Mass Properties in the app shows the same digits.
    const r = regenerate(oc, store.state);
    const t = massText(massProperties(oc, r.shape!), store.state)!;
    expect(Math.abs(parseFloat(t.volume) - 1e-6) / 1e-6).toBeLessThan(1e-6);
  });
});
