/**
 * Whole models from references, and "is it a good part":
 *  - get_reference finds subjects, scales the worked examples to any height / units;
 *  - the worked examples (moai, cartoon bear) build cleanly as one solid that
 *    passes the part quality check (watertight STL, STEP reads back the same);
 *  - booleans are checked: a piece that does not touch the part, or a cut that
 *    leaves a hidden hollow, is flagged and fails the good-part check; two
 *    organic bodies whose seams meet still join (the kernel's silent failure
 *    there is detected and the loft's seam moved).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { regenerate, countSolids, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo } from '../src/kernel/query';
import { partQuality } from '../src/kernel/quality';
import { executeTool, type ExecutorContext } from '../src/ai/executor';
import { getReference, findReference, scaleSteps } from '../src/ai/references';
import { createSketchSolver, type SketchSolver } from '../src/sketch/solver';

let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

function ctx(store: DocumentStore): ExecutorContext {
  let last: ReturnType<typeof regenerate> | null = null;
  return {
    store,
    regen: async (o) => {
      last = regenerate(oc, store.state, { solver, topology: o?.topology !== false });
      return { mesh: null, status: last.status, sketches: last.sketches, mass: last.shape && o?.mass !== false ? massProperties(oc, last.shape) : null, topology: last.topology ?? null, ms: 0 };
    },
    selection: () => [],
    info: async (ref) => { const r = regenerate(oc, store.state, { solver }); return entityInfo(oc, r.shape!, ref.kind, ref.index); },
    quality: async () => partQuality(oc, last!.shape!),
  };
}

describe('reference library', () => {
  it('finds subjects by their everyday names', () => {
    expect(findReference('make an Easter Island head')?.id).toBe('moai');
    expect(findReference('Moai')?.id).toBe('moai');
    expect(findReference('a cute cartoon bear please')?.id).toBe('cartoon-bear');
    expect(findReference('teddy bear')?.id).toBe('cartoon-bear');
    expect(findReference('a dragon')).toBeNull();
  });

  it('scales only lengths, at any depth', () => {
    const s = scaleSteps([{ tool: 'profile_body', name: 'A', squareness: 3, stations: [{ at: 1, x: 2, y: [-1, 1] }] },
      { tool: 'loft_sections', sections: [{ offset: 1, oval: { cx: 1, cy: 2, rx: 0.5, ry: 0.25 } }], end_point: [1, 2, 3] },
      { tool: 'tube', path: [[0, 0, 0], [1, 1, 1]], radii: [0.2, 0.1], ends: 'round' },
      { tool: 'mirror', features: ['A'], plane: { plane: 'YZ' } }], 2);
    expect(s[0]).toEqual({ tool: 'profile_body', name: 'A', squareness: 3, stations: [{ at: 2, x: 4, y: [-2, 2] }] });
    expect(s[1]).toEqual({ tool: 'loft_sections', sections: [{ offset: 2, oval: { cx: 2, cy: 4, rx: 1, ry: 0.5 } }], end_point: [2, 4, 6] });
    expect(s[2]).toEqual({ tool: 'tube', path: [[0, 0, 0], [2, 2, 2]], radii: [0.4, 0.2], ends: 'round' });
    expect(s[3]).toEqual({ tool: 'mirror', features: ['A'], plane: { plane: 'YZ' } });
  });

  it('get_reference returns the sheet and the example scaled to the height and units asked for', async () => {
    const store = new DocumentStore();
    const r: any = await executeTool(ctx(store), 'get_reference', { subject: 'easter island head', height: 4 });
    expect(r.found).toBe(true);
    expect(r.reference_sheet.join(' ')).toMatch(/brow/i);
    const head = r.example.steps.find((s: any) => s.name === 'Head');
    const last = head.stations[head.stations.length - 1];
    expect(last.at).toBeCloseTo((5.95 * 4) / 6.115, 5);
    const none: any = await executeTool(ctx(store), 'get_reference', { subject: 'a fire-breathing dragon' });
    expect(none.found).toBe(false);
    expect(none.next).toMatch(/WebSearch/);
    const mm: any = getReference('bear', 100, 'mm');
    expect(mm.example.units).toBe('mm');
    const body = mm.example.steps.find((s: any) => s.name === 'Body');
    expect(body.stations[1].at).toBeCloseTo((0.6 * 100) / 4.43, 4);
  });
});

describe('worked examples are good parts', () => {
  for (const [subject, height, minFeatures] of [['easter island head', 6.115, 12], ['cartoon bear', 4.43, 16]] as const) {
    it(`${subject}: builds as one clean solid that prints and exports`, async () => {
      const store = new DocumentStore();
      const c = ctx(store);
      const ref: any = await executeTool(c, 'get_reference', { subject });
      const r: any = await executeTool(c, 'build_model', { steps: ref.example.steps });
      expect(r.ok, JSON.stringify(r.errors ?? r.message)).toBe(true);
      expect(r.features.filter((f: any) => f.type !== 'sketch').length).toBeGreaterThanOrEqual(minFeatures);
      expect(parseFloat(r.part.bounding_box.z)).toBeCloseTo(height, 2);
      expect(r.quality.verdict, JSON.stringify(r.quality)).toMatch(/^good part/);
      expect(r.quality.one_solid && r.quality.closed_valid_solid && r.quality.watertight_stl && r.quality.step_for_cam).toBe(true);
      expect(r.quality.flat_base?.centre_of_mass_over_base).toBe(true);
    }, 240000);
  }
});

describe('checked booleans', () => {
  it('a piece that does not touch the part is flagged on the feature and fails the good-part check', async () => {
    // Separate bodies are valid modelling (as in mainstream CAD), but never a good part to print or machine.
    const store = new DocumentStore();
    const c = ctx(store);
    const r: any = await executeTool(c, 'build_model', { steps: [
      { tool: 'profile_body', name: 'Body', stations: [{ at: 0, x: 1, y: [-1, 1] }, { at: 2, x: 1, y: [-1, 1] }] },
      { tool: 'tube', name: 'Loose Ball', path: [[0, 0, 4], [0, 0, 4.4]], radius: 0.3, ends: 'round' },
    ] });
    const ball = r.features.find((f: any) => f.name === 'Loose Ball');
    expect(ball.ok).toBe(true);
    expect(ball.message).toMatch(/does not touch the part/);
    expect(r.quality.one_solid).toBe(false);
    expect(r.quality.verdict).not.toMatch(/^good part/);
    const reg = regenerate(oc, store.state, { solver });
    expect(countSolids(oc, reg.shape!)).toBe(2);
  }, 120000);

  it('a cut completely inside the part is flagged as a hidden hollow', async () => {
    const store = new DocumentStore();
    const c = ctx(store);
    const r: any = await executeTool(c, 'build_model', { steps: [
      { tool: 'profile_body', name: 'Body', stations: [{ at: 0, x: 1, y: [-1, 1] }, { at: 2, x: 1, y: [-1, 1] }] },
      { tool: 'tube', name: 'Inner Channel', operation: 'cut', path: [[-0.4, 0, 1], [0.4, 0, 1]], radius: 0.2, ends: 'round' },
    ] });
    const ch = r.features.find((f: any) => f.name === 'Inner Channel');
    expect(ch.ok).toBe(true);
    expect(ch.message).toMatch(/hidden hollow/);
    expect(r.quality.verdict).not.toMatch(/^good part/);
  }, 120000);

  it('two stacked organic bodies whose seams meet still join into one solid', async () => {
    // Body and head share an axis (both seams would start on +X): OpenCascade used to return
    // two separate solids without an error, and a later feature then dropped the head.
    const store = new DocumentStore();
    const c = ctx(store);
    const r: any = await executeTool(c, 'build_model', { steps: [
      { tool: 'profile_body', name: 'Body', squareness: 2.2, end: 'flat', stations: [{ at: 0, x: 0.95, y: [-0.82, 0.82] }, { at: 0.6, x: 1.15, y: [-1.0, 0.95] }, { at: 1.3, x: 1.05, y: [-0.9, 0.85] }, { at: 2.0, x: 0.8, y: [-0.68, 0.68] }, { at: 2.35, x: 0.62, y: [-0.55, 0.55] }] },
      { tool: 'profile_body', name: 'Head', squareness: 2.2, start: 'round', end: 'round', start_dome: 0.2, end_dome: 0.35, stations: [{ at: 2.2, x: 0.75, y: [-0.62, 0.62] }, { at: 2.55, x: 1.12, y: [-0.95, 0.9] }, { at: 3.1, x: 1.3, y: [-1.08, 1.0] }, { at: 3.7, x: 1.24, y: [-1.0, 0.98] }, { at: 4.3, x: 0.92, y: [-0.74, 0.74] }] },
      { tool: 'profile_body', name: 'Muzzle', axis: 'Y', squareness: 2.3, start: 'round', start_dome: 0.14, stations: [{ at: -1.35, x: 0.4, z: [2.7, 3.14] }, { at: -1.1, x: 0.48, z: [2.62, 3.22] }, { at: -0.6, x: 0.5, z: [2.6, 3.3] }] },
    ] });
    expect(r.ok, JSON.stringify(r.errors ?? r.message)).toBe(true);
    const reg = regenerate(oc, store.state, { solver });
    expect(countSolids(oc, reg.shape!)).toBe(1);
    // Body alone is about 6.5 in^3, head about 8.3, overlap small: the union keeps both.
    expect(parseFloat(r.part.volume)).toBeGreaterThan(14.5);
  }, 120000);
});
