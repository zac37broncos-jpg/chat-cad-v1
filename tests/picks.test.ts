/** UI-side pick helpers: viewport picks <-> persistent references, on real kernel topology. */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { regenerate, type OC } from '../src/kernel/regen';
import { faceRefFrom, edgeRefFrom, type Topology } from '../src/kernel/naming';
import { addFillet } from '../src/core/featureCommands';
import { faceIndex, edgeIndex, facesFrom, edgesFrom, selectionOf, faceAxes, toFace2D } from '../src/ui/picks';
import type { SketchEntity } from '../src/core/model';

let oc: OC;
beforeAll(async () => { oc = await init(); });

const L = (id: string, a: [number, number], b: [number, number]): SketchEntity => ({ id, kind: 'line', p1: { x: a[0], y: a[1] }, p2: { x: b[0], y: b[1] } });
function plate() {
  const store = new DocumentStore();
  const sk = store.addSketch('XY', [L('a', [0, 0], [4, 0]), L('b', [4, 0], [4, 2]), L('c', [4, 2], [0, 2]), L('d', [0, 2], [0, 0])]);
  store.addExtrude(sk, 0.5, { name: 'Plate', operation: 'new' });
  return store;
}
const topoOf = (store: DocumentStore) => regenerate(oc, store.state).topology as Topology;

describe('pick helpers', () => {
  it('round-trips every face and edge of a block, and reports outward normals for flat faces', () => {
    const t = topoOf(plate());
    expect(t.faces.length).toBe(6);
    t.faces.forEach((_, i) => expect(faceIndex(t, faceRefFrom(t, i))).toBe(i));
    t.edges.forEach((_, i) => expect(edgeIndex(t, edgeRefFrom(t, i))).toBe(i));
    const top = t.faces.find((f) => Math.abs(f.center[2] - 12.7) < 1e-9)!;
    expect(top.normal).toEqual([0, 0, 1]);
    const bottom = t.faces.find((f) => Math.abs(f.center[2]) < 1e-9)!;
    expect(bottom.normal).toEqual([0, 0, -1]);
    const front = t.faces.find((f) => Math.abs(f.center[1]) < 1e-9)!;
    expect(front.normal).toEqual([0, -1, 0]);
    expect(faceAxes(front.normal)).toMatchObject({ u: 'X', v: 'Z' });
  });

  it('keeps an existing reference when the same item is picked again, and follows it after an edit', () => {
    const store = plate();
    let t = topoOf(store);
    const vi = t.edges.findIndex((e) => e.curve === 'line' && Math.abs(e.length - 12.7) < 1e-9);
    const ref = { ...edgeRefFrom(t, vi), at: [999, 999, 999] as [number, number, number] }; // a marker that must survive
    const kept = edgesFrom(t, [{ kind: 'edge', index: vi }], [ref]);
    expect(kept[0]).toBe(ref);
    addFillet(store, { edges: [edgeRefFrom(t, vi)], radius: 0.125, name: 'Corner Round' });
    // A thicker plate renumbers everything; the stored edge still resolves on the model before the fillet.
    store.updateFeature(store.state.features[1].id, { depth: 0.75 });
    store.setRollback(2);
    t = topoOf(store);
    const sel = selectionOf(t, { edges: [(store.state.features[2] as any).edges[0]] });
    expect(sel.length).toBe(1);
    expect(t.edges[(sel[0] as any).index].length).toBeCloseTo(0.75 * 25.4, 9);
  });

  it('turns faces of a selection into references and ignores other kinds', () => {
    const t = topoOf(plate());
    const refs = facesFrom(t, [{ kind: 'face', index: 0 }, { kind: 'edge', index: 0 }, { kind: 'plane', plane: 'XY' }]);
    expect(refs.length).toBe(1);
    expect(faceIndex(t, refs[0])).toBe(0);
  });

  it('maps world points to the 2D frame holes use on a face', () => {
    expect(toFace2D([0, 0, 1], [12.7, 25.4, 12.7])).toEqual([12.7, 25.4]);
    expect(toFace2D([0, -1, 0], [10, 0, 5])).toEqual([10, 5]);
    expect(toFace2D([1, 0, 0], [3, 7, 9])).toEqual([7, 9]);
    // Angled face: the 2D point is the projection, so a point on the face maps back exactly.
    const n: [number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2];
    const [u, v] = toFace2D(n, [0, 4, 10]);
    expect(Math.hypot(u, v)).toBeGreaterThan(0);
    expect(v).toBeCloseTo(4, 12);
  });
});
