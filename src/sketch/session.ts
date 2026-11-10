/**
 * SketchSession: the verified way to change a sketch. Every change is
 * solved first; it is only committed to the document (through
 * DocumentStore.editSketch, one undo step each) when the solve succeeds and
 * passes our residual check. Used by the interactive sketcher and available
 * to the AI bridge. No DOM.
 */
import type { DocumentStore } from '../core/store';
import { resolveParams } from '../core/store';
import type { SketchConstraint, SketchFeature, ValueExpr } from '../core/model';
import { isDimension, newId } from '../core/model';
import { evalAngle, evalLength } from '../core/units';
import { type WEntity, type WSketch, evalWorking, evalValues, toStoredEntities, constraintRefs, isBuiltin } from './geom';
import type { Edit } from './ops';
import type { DragTarget, SketchSolver, SketchStatus } from './solver';
import type { Analysis } from './equations';

export interface ApplyResult { ok: boolean; message?: string; /** Set when a dimension was added as a reference because it would over-define the sketch. */ madeDriven?: boolean }

export interface SessionState {
  ws: WSketch;
  status: SketchStatus;
  analysis: Analysis | null;
  /** Entities as solved from the stored positions (what the user sees). */
  solved: WEntity[];
  conflicting: string[];
  redundant: string[];
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export class SketchSession {
  private cache: { key: string; state: SessionState } | null = null;

  constructor(readonly store: DocumentStore, readonly solver: SketchSolver, readonly sketchId: string) {}

  get feature(): SketchFeature | undefined {
    const f = this.store.feature(this.sketchId);
    return f && f.type === 'sketch' ? f : undefined;
  }

  private params() { return resolveParams(this.store.state as any); }
  private get units() { return this.store.state.units; }

  /** Evaluate a dimension value expression for this document (mm or rad). */
  evalValue(c: SketchConstraint, expr: ValueExpr): number {
    return c.type === 'angle' ? evalAngle(expr, this.params()) : evalLength(expr, this.units, this.params());
  }

  /** Current sketch, solved and analysed (cached until the document changes). */
  state(): SessionState {
    const f = this.feature;
    if (!f) throw new Error('The sketch no longer exists');
    const key = JSON.stringify([f.entities, f.constraints, this.store.state.params, this.units]);
    if (this.cache?.key === key) return this.cache.state;
    const ws = evalWorking(f, this.units, this.params());
    const st = this.solver.status(ws);
    const state: SessionState = {
      ws, status: st.status, analysis: st.analysis,
      solved: st.result.ok ? st.result.entities : ws.entities,
      conflicting: st.result.conflicting, redundant: st.result.redundant,
    };
    this.cache = { key, state };
    return state;
  }

  /** Working sketch with geometry at its solved positions, ready for an edit. */
  working(): WSketch {
    const s = this.state();
    return { ...s.ws, entities: s.solved.map(clone), constraints: clone(s.ws.constraints) };
  }

  /**
   * Solve an edited sketch and commit it as one undo step. Fails (and changes
   * nothing) when the result cannot be solved exactly. With rejectOverDefined,
   * also fails when the edit adds a conflicting or redundant constraint.
   */
  apply(label: string, edit: Edit, opts: { rejectOverDefined?: boolean; allowUnsolved?: boolean } = {}): ApplyResult {
    for (const c of edit.constraints) {
      for (const r of constraintRefs(c)) if (!isBuiltin(r) && !edit.entities.some((e) => e.id === r)) return { ok: false, message: `Internal error: ${c.type} refers to a missing entity` };
    }
    let values: Map<string, number>;
    try { values = evalValues(edit.constraints, this.units, this.params()); } catch (e) { return { ok: false, message: (e as Error).message }; }
    const ws: WSketch = { entities: edit.entities, constraints: edit.constraints, values };
    const st = this.solver.status(ws);
    if (!st.result.ok && !opts.allowUnsolved) return { ok: false, message: st.result.message ?? 'The sketch could not be solved' };
    if (opts.rejectOverDefined && st.status.state === 'over') {
      const before = this.state().status.state;
      if (before !== 'over') return { ok: false, message: st.status.message ?? 'That would over-define the sketch' };
    }
    const ents = st.result.ok ? st.result.entities : edit.entities;
    const units = this.units;
    this.store.editSketch(this.sketchId, label, (sk) => {
      sk.entities = toStoredEntities(ents, units);
      sk.constraints = clone(edit.constraints);
      if (!sk.constraints.length) delete sk.constraints;
    });
    return { ok: true };
  }

  /** Add new geometry with its automatic relations. */
  addGeometry(label: string, entities: WEntity[], constraints: SketchConstraint[]): ApplyResult {
    const w = this.working();
    const r = this.apply(label, { entities: w.entities.concat(entities), constraints: w.constraints.concat(constraints) });
    if (r.ok) return r;
    // An inferred relation can clash with existing ones; keep the geometry, drop the clashing inferences.
    return this.apply(label, { entities: w.entities.concat(entities), constraints: w.constraints });
  }

  /** Add a geometric relation; refuses conflicts and redundant (already implied) relations. */
  addRelation(c: SketchConstraint, label = `Add ${c.type} relation`): ApplyResult {
    const w = this.working();
    return this.apply(label, { entities: w.entities, constraints: w.constraints.concat(c) }, { rejectOverDefined: true });
  }

  /**
   * Add a dimension. If it would over-define the sketch it is added as a
   * driven (reference) dimension instead, the way professional CAD tools do.
   */
  addDimension(c: SketchConstraint & { value: ValueExpr }, label = 'Add dimension'): ApplyResult {
    const w = this.working();
    const r = this.apply(label, { entities: w.entities, constraints: w.constraints.concat(c) }, { rejectOverDefined: true });
    if (r.ok) return r;
    const driven = { ...c, driven: true } as SketchConstraint;
    const r2 = this.apply(label, { entities: w.entities, constraints: w.constraints.concat(driven) });
    return r2.ok ? { ok: true, madeDriven: true, message: `${r.message}. Added as a driven (reference) dimension instead.` } : r;
  }

  /** Change a dimension's value (any expression: "1.25", "W/2", "30 mm"). */
  setDimension(id: string, value: ValueExpr): ApplyResult {
    const w = this.working();
    const c = w.constraints.find((x) => x.id === id);
    if (!c || !isDimension(c)) return { ok: false, message: 'Not a dimension' };
    try { this.evalValue(c, value); } catch (e) { return { ok: false, message: (e as Error).message }; }
    const next = w.constraints.map((x) => (x.id === id ? { ...x, value } as SketchConstraint : x));
    return this.apply(`Set dimension to ${value}`, { entities: w.entities, constraints: next });
  }

  /** Switch a dimension between driving and driven. */
  setDriven(id: string, driven: boolean): ApplyResult {
    const w = this.working();
    const next = w.constraints.map((x) => (x.id === id && isDimension(x) ? ({ ...x, driven } as SketchConstraint) : x));
    if (driven) return this.apply('Make dimension driven', { entities: w.entities, constraints: next });
    // Making it driving: its value becomes the current measured value unless it already holds.
    return this.apply('Make dimension driving', { entities: w.entities, constraints: next }, { rejectOverDefined: true });
  }

  /** Move a dimension's text (stored relative to its anchor, document units). */
  moveDimensionText(id: string, offsetDocUnits: [number, number]) {
    this.store.editSketch(this.sketchId, 'Move dimension', (sk) => {
      const c = sk.constraints?.find((x) => x.id === id);
      if (c && isDimension(c)) c.text = offsetDocUnits;
    });
  }

  /** Solve toward drag targets for a live preview (not committed). */
  dragPreview(base: WSketch, targets: DragTarget[]): WEntity[] | null {
    const r = this.solver.solve(base, targets);
    return r.ok ? r.entities : null;
  }

  /** Commit dragged geometry (already solved) as one undo step. */
  commitDrag(base: WSketch, ents: WEntity[]): ApplyResult {
    return this.apply('Drag sketch geometry', { entities: ents, constraints: base.constraints });
  }

  newId(prefix: string) { return newId(prefix); }
}
