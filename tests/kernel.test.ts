import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, newId } from '../src/core/model';
import { regenerate, isValid, type OC } from '../src/kernel/regen';
import { massProperties, entityInfo, listSubShapes, minDistance } from '../src/kernel/query';
import { exportStepFile, exportStlFile } from '../src/kernel/exporters';
import { STL_DEFAULT } from '../src/kernel/exportDefaults';

const IN = 25.4;
const IN3 = IN ** 3;
/** Analytic checks must agree to 1e-6 mm-based relative error: far below 0.005 in. */
const REL = 1e-9;
let oc: OC;
beforeAll(async () => { oc = await init(); });

function bracket() {
  const st = new DocumentStore();
  st.setParameter('L', '4');
  st.setParameter('W', '2');
  st.setParameter('T', '0.5');
  const base = st.addSketch('XY', rectangleEntities(0, 0, 'L', 'W'));
  st.addExtrude(base, 'T');
  const holes = st.addSketch('XY', [
    { id: newId('c'), kind: 'circle', center: { x: 0.5, y: 'W/2' }, radius: '0.25/2' },
    { id: newId('c'), kind: 'circle', center: { x: 'L-0.5', y: 'W/2' }, radius: '0.25/2' },
  ]);
  st.addExtrude(holes, 0, { operation: 'cut', throughAll: true, direction: 'symmetric' });
  return st;
}

describe('kernel regeneration (exact B-rep)', () => {
  it('builds a bracket with two through holes and exact volume', () => {
    const st = bracket();
    const r = regenerate(oc, st.state);
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(r.shape).not.toBeNull();
    expect(isValid(oc, r.shape!)).toBe(true);
    const mp = massProperties(oc, r.shape!);
    const expected = (4 * 2 * 0.5 - 2 * Math.PI * 0.125 ** 2 * 0.5) * IN3;
    expect(Math.abs(mp.volume - expected) / expected).toBeLessThan(REL);
    expect(mp.bboxMax[0] - mp.bboxMin[0]).toBeCloseTo(4 * IN, 6);
    expect(mp.bboxMax[2] - mp.bboxMin[2]).toBeCloseTo(0.5 * IN, 6);
    // centroid is at the middle by symmetry
    expect(mp.centroid[0]).toBeCloseTo(2 * IN, 6);
    expect(mp.centroid[1]).toBeCloseTo(1 * IN, 6);
  });

  it('measures hole radius and edge lengths exactly', () => {
    const r = regenerate(oc, bracket().state);
    const faces = listSubShapes(oc, r.shape!, 'TopAbs_FACE');
    const cyl = faces.map((_, i) => entityInfo(oc, r.shape!, 'face', i)).filter((f: any) => f.surface === 'cylinder');
    expect(cyl.length).toBe(2);
    for (const c of cyl) expect((c as any).radius).toBeCloseTo(0.125 * IN, 10);
    const edges = listSubShapes(oc, r.shape!, 'TopAbs_EDGE').map((_, i) => entityInfo(oc, r.shape!, 'edge', i));
    const longest = Math.max(...edges.map((e: any) => e.length));
    expect(longest).toBeCloseTo(4 * IN, 10);
  });

  it('parameter edits regenerate downstream features', () => {
    const st = bracket();
    st.setParameter('T', '0.75');
    const r = regenerate(oc, st.state);
    const mp = massProperties(oc, r.shape!);
    const expected = (4 * 2 * 0.75 - 2 * Math.PI * 0.125 ** 2 * 0.75) * IN3;
    expect(Math.abs(mp.volume - expected) / expected).toBeLessThan(REL);
  });

  it('measures the minimum distance between the two holes', () => {
    const r = regenerate(oc, bracket().state);
    const faces = listSubShapes(oc, r.shape!, 'TopAbs_FACE');
    const idx = faces.map((_, i) => i).filter((i) => (entityInfo(oc, r.shape!, 'face', i) as any).surface === 'cylinder');
    const d = minDistance(oc, r.shape!, { kind: 'face', index: idx[0] }, { kind: 'face', index: idx[1] });
    expect(d.distance).toBeCloseTo((3 - 0.25) * IN, 9);
  });

  it('handles nested profiles (washer) and revolve', () => {
    const st = new DocumentStore();
    const sk = st.addSketch('XY', [
      { id: 'o', kind: 'circle', center: { x: 0, y: 0 }, radius: 1 },
      { id: 'i', kind: 'circle', center: { x: 0, y: 0 }, radius: 0.5 },
    ]);
    st.addExtrude(sk, 0.1);
    let mp = massProperties(oc, regenerate(oc, st.state).shape!);
    let expected = Math.PI * (1 - 0.25) * 0.1 * IN3;
    expect(Math.abs(mp.volume - expected) / expected).toBeLessThan(REL);

    const st2 = new DocumentStore();
    const prof = st2.addSketch('XZ', [
      { id: 'ax', kind: 'line', p1: { x: 0, y: -1 }, p2: { x: 0, y: 2 }, construction: true },
      ...rectangleEntities(1, 0, 0.5, 1),
    ]);
    st2.addRevolve(prof, 'ax', 360);
    mp = massProperties(oc, regenerate(oc, st2.state).shape!);
    expected = Math.PI * (1.5 ** 2 - 1) * 1 * IN3;
    expect(Math.abs(mp.volume - expected) / expected).toBeLessThan(REL);
  });

  it('reports errors instead of producing wrong geometry', () => {
    const st = new DocumentStore();
    const sk = st.addSketch('XY', [{ id: 'l', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } }]);
    st.addExtrude(sk, 1);
    const r = regenerate(oc, st.state);
    expect(r.status[1].ok).toBe(false);
    expect(r.shape).toBeNull();
  });

  it('undo/redo and AI-style transactions are single steps', () => {
    const st = new DocumentStore();
    st.transaction('AI: make plate', () => {
      const s = st.addSketch('XY', rectangleEntities(0, 0, 1, 1));
      st.addExtrude(s, 1);
    });
    expect(st.state.features.length).toBe(2);
    st.undo();
    expect(st.state.features.length).toBe(0);
    st.redo();
    expect(st.state.features.length).toBe(2);
  });

  it('rollback bar suppresses later features', () => {
    const st = bracket();
    st.setRollback(2);
    const mp = massProperties(oc, regenerate(oc, st.state).shape!);
    expect(Math.abs(mp.volume - 4 * IN3) / (4 * IN3)).toBeLessThan(REL);
  });

  it('exports STEP and print-quality STL', () => {
    const r = regenerate(oc, bracket().state);
    const { text: step, report: sr } = exportStepFile(oc, r.shape!, { unit: 'in', schema: 'AP214', name: 'Bracket' });
    expect(step).toContain('ISO-10303-21');
    expect(sr.ok).toBe(true);
    const { data: stl, report } = exportStlFile(oc, r.shape!, { ...STL_DEFAULT, unit: 'mm', format: 'binary', name: 'Bracket' });
    expect(report.watertight).toBe(true);
    const tris = new DataView(stl.buffer).getUint32(80, true);
    expect(tris).toBeGreaterThan(100);
    expect(stl.byteLength).toBe(84 + tris * 50);
  });

  it('extrudes with Direction 2 and mid-plane exactly', () => {
    const st = new DocumentStore();
    const sk = st.addSketch('XY', rectangleEntities(0, 0, 1, 1));
    const ex = st.addExtrude(sk, 0.75, { depth2: 0.25 });
    let r = regenerate(oc, st.state);
    let mp = massProperties(oc, r.shape!);
    expect(Math.abs(mp.volume - 1 * IN3) / IN3).toBeLessThan(REL);
    expect(mp.bboxMin[2]).toBeCloseTo(-0.25 * IN, 9);
    expect(mp.bboxMax[2]).toBeCloseTo(0.75 * IN, 9);
    st.updateFeature(ex, { direction: 'reverse' });
    mp = massProperties(oc, regenerate(oc, st.state).shape!);
    expect(mp.bboxMin[2]).toBeCloseTo(-0.75 * IN, 9);
    expect(mp.bboxMax[2]).toBeCloseTo(0.25 * IN, 9);
    st.updateFeature(ex, { direction: 'symmetric', depth: 2 });
    r = regenerate(oc, st.state);
    mp = massProperties(oc, r.shape!);
    expect(mp.bboxMin[2]).toBeCloseTo(-1 * IN, 9);
    expect(mp.bboxMax[2]).toBeCloseTo(1 * IN, 9);
  });

  it('cuts through all from a sketch plane far from the part', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1);
    const far = st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.25 }], { offset: 20 });
    st.addExtrude(far, 0, { operation: 'cut', throughAll: true, direction: 'reverse' });
    const mp = massProperties(oc, regenerate(oc, st.state).shape!);
    const expected = (1 - Math.PI * 0.0625) * IN3;
    expect(Math.abs(mp.volume - expected) / expected).toBeLessThan(REL);
  });

  it('captures the tool body for previews', () => {
    const st = new DocumentStore();
    st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 2, 2)), 1);
    const h = st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 1, y: 1 }, radius: 0.5 }]);
    const cutId = st.addExtrude(h, 0.5, { operation: 'cut', direction: 'reverse' });
    const r = regenerate(oc, st.state, { captureToolFor: cutId });
    expect(r.tool).toBeTruthy();
    const mp = massProperties(oc, r.tool!);
    expect(Math.abs(mp.volume - Math.PI * 0.25 * 0.5 * IN3) / IN3).toBeLessThan(1e-9);
  });

  it('uses default feature names and never reuses one', () => {
    const st = new DocumentStore();
    const a = st.addSketch('XY', rectangleEntities(0, 0, 1, 1));
    st.addExtrude(a, 1);
    const b = st.addSketch('XY', rectangleEntities(0, 0, 0.5, 0.5));
    st.addExtrude(b, 1, { operation: 'cut' });
    expect(st.state.features.map((f) => f.name)).toEqual(['Sketch1', 'Extrude1', 'Sketch2', 'Cut-Extrude1']);
    st.deleteFeature(a);
    const c = st.addSketch('XY', []);
    expect(st.feature(c)!.name).toBe('Sketch3');
  });
});
