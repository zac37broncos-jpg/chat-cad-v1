/**
 * Feedback details: which faces a feature owns (tree highlight / picked face
 * marks its feature) and the status bar's quick measurement text.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities } from '../src/core/model';
import { regenerate, type OC } from '../src/kernel/regen';
import { entityInfo } from '../src/kernel/query';
import * as F from '../src/core/featureCommands';
import { faceOwners, facesOfFeatures, featuresOfFaces, selectionSummary } from '../src/ui/feel';

const IN = 25.4;
let oc: OC;
beforeAll(async () => { oc = await init(); });

describe('face ownership from topological names', () => {
  it('reads the feature id from plain, nested and pattern-copy tags', () => {
    expect(faceOwners(['ex_ab1:side:l1'])).toEqual(['ex_ab1']);
    expect(faceOwners(['ex_ab1:start', 'ct_x2:side:c1'])).toEqual(['ex_ab1', 'ct_x2']);
    expect(faceOwners(['sh_q4:inner:ex_ab1:end'])).toEqual(['sh_q4']);
    expect(faceOwners(['ho_z3:wall:p1#lp_k5.2'])).toEqual(['lp_k5']);
    expect(faceOwners(['ho_z3:wall:p1#lp_k5.2#cp_m6.1'])).toEqual(['cp_m6']);
    expect(faceOwners([])).toEqual([]);
  });

  it('finds the faces of the plate, the hole and the pattern copies on a real part', () => {
    const st = new DocumentStore();
    const plate = st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 6, 4)), 0.5, { name: 'Plate' });
    const hole = F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { base: 'XY', offset: 0.5 }, points: [{ x: 1, y: 1 }] });
    const pattern = F.addLinearPattern(st, { features: [hole], dir1: { axis: 'X' }, spacing1: 1.5, count1: 3 });
    const r = regenerate(oc, st.state);
    expect(r.status.every((s) => s.ok)).toBe(true);
    const t = r.topology!;
    const shape = r.shape!;
    const info = (i: number) => entityInfo(oc, shape, 'face', i) as any;

    // Plate: its six planar faces (top and bottom keep the plate's names after the holes cut them).
    const plateFaces = facesOfFeatures(t, [plate]);
    expect(plateFaces.length).toBe(6);
    expect(plateFaces.every((i) => info(i).surface === 'plane')).toBe(true);

    // Hole: only the original hole's wall at (1, 1).
    const axisX = (i: number) => Math.round((info(i).axisOrigin[0] / IN) * 1e6) / 1e6;
    const holeFaces = facesOfFeatures(t, [hole]);
    expect(holeFaces.length).toBeGreaterThan(0);
    expect(holeFaces.every((i) => info(i).surface === 'cylinder' && axisX(i) === 1)).toBe(true);

    // Pattern: the copies at x = 2.5 and x = 4, not the original.
    const copyX = new Set(facesOfFeatures(t, [pattern]).map(axisX));
    expect([...copyX].sort()).toEqual([2.5, 4]);

    // Every face belongs to exactly one of the three, and the reverse lookup agrees.
    expect(plateFaces.length + holeFaces.length + facesOfFeatures(t, [pattern]).length).toBe(t.faces.length);
    expect(featuresOfFaces(t, [plateFaces[0]])).toEqual([plate]);
    expect(featuresOfFaces(t, [holeFaces[0], plateFaces[0]])).toEqual([hole, plate]);
    expect(facesOfFeatures(t, [])).toEqual([]);
    expect(facesOfFeatures(null, [plate])).toEqual([]);
  });
});

describe('status bar quick measurement', () => {
  it('summarises one face, one edge, or the distance between two selections', () => {
    expect(selectionSummary([{ kind: 'edge', curve: 'line', length: 2 * IN, start: [0, 0, 0], end: [2 * IN, 0, 0] }], null, 'in'))
      .toBe('Line edge   Length: 2.0000 in');
    expect(selectionSummary([{ kind: 'edge', curve: 'circle', length: Math.PI * 0.5 * IN, radius: 0.25 * IN, center: [0, 0, 0] }], null, 'in'))
      .toBe('Circular edge   Radius: 0.2500 in   Length: 1.5708 in');
    expect(selectionSummary([{ kind: 'face', surface: 'plane', area: 6 * IN * IN, normal: [0, 0, 1], origin: [0, 0, 0] }], null, 'in'))
      .toBe('Planar face   Area: 6.0000 in²');
    expect(selectionSummary([{ kind: 'face', surface: 'cylinder', area: 100, radius: 5, axis: [0, 0, 1], axisOrigin: [0, 0, 0] }], null, 'mm'))
      .toBe('Cylindrical face   Radius: 5.000 mm   Area: 100.00 mm²');
    const e = { kind: 'edge' as const, curve: 'line' as const, length: 1, start: [0, 0, 0] as [number, number, number], end: [1, 0, 0] as [number, number, number] };
    expect(selectionSummary([e, e], 12.7, 'in')).toBe('Distance: 0.5000 in');
    expect(selectionSummary([e, e], null, 'in')).toBe('');
    expect(selectionSummary([], null, 'in')).toBe('');
  });
});
