import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/core/store';
import { buildRows } from '../src/ui/FeatureTree';
import { pickSketch, sketchPlaneFromSelection } from '../src/ui/commands';

function part() {
  const s = new DocumentStore();
  const a = s.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: 1 }], { name: 'Base Sketch' });
  const e = s.addExtrude(a, 1, { name: 'Base' });
  const b = s.addSketch('XY', [{ id: 'h', kind: 'circle', center: { x: 0, y: 0 }, radius: 0.2 }], { name: 'Hole Sketch', offset: 1 });
  const free = s.addSketch('XZ', [], { name: 'Loose Sketch' });
  return { s, a, e, b, free };
}

describe('feature tree rows', () => {
  it('nests a consumed sketch under its feature and keeps free sketches top-level', () => {
    const { s, a, e, b, free } = part();
    const rows = buildRows(s.state);
    expect(rows.map((r) => r.f.id)).toEqual([e, b, free]);
    expect(rows[0].children.map((c) => c.f.id)).toEqual([a]);
    // Rolling back above "Base" also rolls back its own sketch (they are adjacent).
    expect(rows[0].start).toBe(0);
  });
});

describe('command helpers', () => {
  it('picks the tree-selected sketch, else the newest unused one', () => {
    const { s, b, free } = part();
    expect(pickSketch(s, [b])).toBe(b);
    expect(pickSketch(s, [])).toBe(free);
  });

  it('maps reference planes and axis-aligned flat faces to a sketch plane + exact offset', () => {
    expect(sketchPlaneFromSelection({ kind: 'plane', plane: 'YZ' }, undefined)).toEqual({ plane: 'YZ' });
    const top = { kind: 'face', surface: 'plane', area: 1, normal: [0, 0, 1], origin: [3, 4, 12.7] } as any;
    expect(sketchPlaneFromSelection({ kind: 'face', index: 0 }, top)).toEqual({ plane: 'XY', offset: '12.7 mm' });
    // Front plane normal is -Y, so a face at y = -5 is offset +5 along it.
    const front = { kind: 'face', surface: 'plane', area: 1, normal: [0, -1, 0], origin: [0, -5, 0] } as any;
    expect(sketchPlaneFromSelection({ kind: 'face', index: 1 }, front)).toEqual({ plane: 'XZ', offset: '5 mm' });
    const angled = { kind: 'face', surface: 'plane', area: 1, normal: [0, 0.6, 0.8], origin: [0, 0, 0] } as any;
    expect(sketchPlaneFromSelection({ kind: 'face', index: 2 }, angled)).toHaveProperty('error');
    const cyl = { kind: 'face', surface: 'cylinder', area: 1 } as any;
    expect(sketchPlaneFromSelection({ kind: 'face', index: 3 }, cyl)).toHaveProperty('error');
  });

  it('New part is undoable and conventional CAD-style names continue from the highest number', () => {
    const { s } = part();
    expect(s.nextName('Extrude')).toBe('Extrude1');
    s.resetPart();
    expect(s.state.features).toHaveLength(0);
    s.undo();
    expect(s.state.features).toHaveLength(4);
  });
});
