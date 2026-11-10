/**
 * DocumentStore: deleting features keeps the rollback bar below the same features.
 * (Found in the 2026-11-05 code review: deleting a feature whose dependents were below the bar
 * moved the bar up too far, so features that were shown silently disappeared from the model.)
 */
import { describe, it, expect } from 'vitest';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities } from '../src/core/model';

/** Sketch A + extrude, sketch B + extrude (cut): four features. */
function part() {
  const st = new DocumentStore();
  const a = st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Sketch A' });
  const ea = st.addExtrude(a, 1, { name: 'Boss A' });
  const b = st.addSketch('XY', rectangleEntities(1, 0.5, 1, 1), { name: 'Sketch B' });
  const eb = st.addExtrude(b, 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Cut B' });
  return { st, a, ea, b, eb };
}
const names = (st: DocumentStore) => st.state.features.map((f) => f.name);
const applied = (st: DocumentStore) => names(st).slice(0, st.state.rollback ?? undefined);

describe('delete and the rollback bar', () => {
  it('a dependent below the bar does not pull the bar up past features that stay', () => {
    const { st, b } = part();
    st.setRollback(3); // applied: Sketch A, Boss A, Sketch B; below the bar: Cut B (built from Sketch B)
    st.deleteFeature(b); // removes Sketch B and Cut B
    expect(names(st)).toEqual(['Sketch A', 'Boss A']);
    // Before the fix the bar went to 1 and Boss A vanished from the model.
    expect(applied(st)).toEqual(['Sketch A', 'Boss A']);
  });

  it('removing applied features moves the bar up by exactly those', () => {
    const { st, a } = part();
    st.setRollback(3);
    st.deleteFeature(a); // Sketch A and Boss A, both above the bar
    expect(names(st)).toEqual(['Sketch B', 'Cut B']);
    expect(applied(st)).toEqual(['Sketch B']);
    expect(st.state.rollback).toBe(1);
  });

  it('deleting below the bar leaves it where it is', () => {
    const { st, eb } = part();
    st.setRollback(2);
    st.deleteFeature(eb);
    expect(applied(st)).toEqual(['Sketch A', 'Boss A']);
    expect(st.state.rollback).toBe(2);
  });

  it('a bar left at the end of the tree means "everything applied"', () => {
    const { st, eb } = part();
    st.setRollback(3);
    st.deleteFeature(eb); // the only feature below the bar
    expect(st.state.rollback).toBeNull();
    expect(applied(st)).toEqual(['Sketch A', 'Boss A', 'Sketch B']);
  });

  it('undo brings back the features and the bar', () => {
    const { st, b } = part();
    st.setRollback(3);
    st.deleteFeature(b);
    st.undo();
    expect(names(st)).toEqual(['Sketch A', 'Boss A', 'Sketch B', 'Cut B']);
    expect(st.state.rollback).toBe(3);
  });
});
