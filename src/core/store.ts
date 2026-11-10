/**
 * The single command API. Every change to a document, whether it comes from
 * a mouse click, a dialog, or the AI chat, goes through these commands.
 * That keeps edits undoable, replayable, and identical no matter who made them.
 */
import {
  type CadDocument, type Feature, type SketchFeature, type ExtrudeFeature, type RevolveFeature,
  type SketchEntity, type BasePlane, type ValueExpr, type PlaneFrame, type BooleanOp, emptyDocument, newId, featureDependencies,
} from './model';
import { type ModelingFeature, DEFAULT_NAMES } from './featureTypes';
import { evaluate, type Quantity, ExpressionError } from './units';
import { nextLoftSeam } from './loftSeam';

type Listener = (doc: CadDocument) => void;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Undo history limits. Every undo step holds a whole copy of the document, so
 * the history is capped: at most `maxSteps` steps, and the oldest steps are
 * dropped while all steps together are larger than `maxChars` characters of
 * document JSON (a rough measure of their memory) - but the newest `minSteps`
 * steps are always kept, however large the part. Steps inside an open AI
 * request or sketch edit (openCheckpoint) are never dropped, so that request
 * still undoes as one step and Cancel still restores the sketch exactly.
 */
export interface HistoryLimits { maxSteps: number; maxChars: number; minSteps: number }
// Measured 2026-11-06: the worked examples are about 105,000 (cartoon bear) and 125,000 (Easter
// Island head) characters, so 200 steps of them is about 25 million; a prismatic part is far smaller.
export const HISTORY_LIMITS: HistoryLimits = { maxSteps: 200, maxChars: 32_000_000, minSteps: 20 };

interface Step { label: string; doc: CadDocument; chars: number }

/** A copy of a document and its size in JSON characters. */
function snapshot(doc: CadDocument): { doc: CadDocument; chars: number } {
  const json = JSON.stringify(doc);
  return { doc: JSON.parse(json), chars: json.length };
}

export class DocumentStore {
  private doc: CadDocument;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  /** Undo steps dropped from the bottom of the history (by the limits or load), so checkpoints stay absolute positions. */
  private dropped = 0;
  /** Open checkpoints (absolute positions): the steps from there on are kept until squashSince/releaseCheckpoint. */
  private held: number[] = [];
  private readonly limits: HistoryLimits;
  private listeners = new Set<Listener>();
  private txDepth = 0;
  private txLabel = '';
  private txSnapshot: CadDocument | null = null;

  constructor(doc: CadDocument = emptyDocument(), limits: Partial<HistoryLimits> = {}) {
    this.doc = clone(doc);
    this.limits = { ...HISTORY_LIMITS, ...limits };
  }

  get state(): Readonly<CadDocument> { return this.doc; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label; }
  get redoLabel() { return this.redoStack.at(-1)?.label; }
  /** Number of undo / redo steps held now. */
  get undoDepth() { return this.undoStack.length; }
  get redoDepth() { return this.redoStack.length; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() { for (const l of this.listeners) l(this.doc); }

  /**
   * Group several commands into one undo step (used by the AI chat so a
   * whole AI run can be undone at once). Nested transactions merge outward.
   */
  transaction<T>(label: string, fn: () => T): T {
    // Copy on write: a document object that `state` has handed out is never changed afterwards.
    // Rebuild requests, the rebuilt result shown on screen and the undo history all hold such
    // objects, so "this result was built from this document" stays true (a result can be
    // compared with `state` by identity to know whether it is current).
    if (this.txDepth === 0) { this.txLabel = label; this.txSnapshot = this.doc; this.doc = clone(this.doc); }
    this.txDepth++;
    try {
      return fn();
    } catch (e) {
      if (this.txDepth === 1 && this.txSnapshot) this.doc = this.txSnapshot; // roll back partial work
      throw e;
    } finally {
      this.txDepth--;
      if (this.txDepth === 0 && this.txSnapshot) {
        const before = JSON.stringify(this.txSnapshot);
        if (before !== JSON.stringify(this.doc)) {
          this.undoStack.push({ label: this.txLabel, doc: this.txSnapshot, chars: before.length });
          this.redoStack = [];
          this.trimHistory();
        } else {
          // Nothing changed: keep the published object (same identity, so nothing rebuilds).
          this.doc = this.txSnapshot;
        }
        this.txSnapshot = null;
        this.emit();
      }
    }
  }

  private mutate(label: string, fn: (d: CadDocument) => void) {
    this.transaction(label, () => fn(this.doc));
  }

  /**
   * Position in the undo history; pass to squashSince() to merge later steps.
   * Positions are absolute: they stay right when the oldest steps are dropped.
   */
  checkpoint(): number { return this.dropped + this.undoStack.length; }

  /**
   * checkpoint(), and keep every step from here on until squashSince() or
   * releaseCheckpoint() with this position (for an AI request or a sketch edit,
   * which may make more steps than the history limit).
   */
  openCheckpoint(): number {
    const cp = this.checkpoint();
    this.held.push(cp);
    return cp;
  }

  /** Stop keeping the steps after an open checkpoint (without merging them). */
  releaseCheckpoint(checkpoint: number) {
    const i = this.held.indexOf(checkpoint);
    if (i >= 0) { this.held.splice(i, 1); this.trimHistory(); }
  }

  /**
   * Merge every undo step made since `checkpoint` into one labelled step, so a
   * whole AI request (many tool calls) undoes with a single Ctrl+Z. Releases
   * the checkpoint if it was opened with openCheckpoint().
   */
  squashSince(checkpoint: number, label: string) {
    const held = this.held.indexOf(checkpoint);
    if (held >= 0) this.held.splice(held, 1);
    // Index in the stack; a plain checkpoint whose steps were dropped merges what is left.
    const at = Math.max(0, checkpoint - this.dropped);
    if (this.undoStack.length - at <= 1) {
      if (this.undoStack.length > at) this.undoStack[this.undoStack.length - 1].label = label;
      if (held >= 0) this.trimHistory();
      return;
    }
    const first = this.undoStack[at];
    this.undoStack.splice(at, this.undoStack.length - at, { label, doc: first.doc, chars: first.chars });
    this.trimHistory();
    this.emit();
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ label: e.label, ...snapshot(this.doc) });
    this.doc = e.doc;
    this.emit();
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ label: e.label, ...snapshot(this.doc) });
    this.doc = e.doc;
    this.trimHistory();
    this.emit();
  }

  /**
   * Drop the oldest undo steps beyond the limits. Never drops the newest
   * `minSteps`, nor any step at or after an open checkpoint. Each kept step is
   * a whole document, so undo stays exact for every step that is kept; only
   * the ability to go further back is lost. Redo steps come from undone steps,
   * so they are bounded by the same limits.
   */
  private trimHistory() {
    const { maxSteps, maxChars, minSteps } = this.limits;
    const n = this.undoStack.length;
    const keepFrom = this.held.length ? Math.min(...this.held) - this.dropped : n;
    let chars = 0;
    for (const s of this.undoStack) chars += s.chars;
    for (const s of this.redoStack) chars += s.chars;
    let drop = 0;
    while (drop < keepFrom && n - drop > minSteps && (n - drop > maxSteps || chars > maxChars)) {
      chars -= this.undoStack[drop].chars;
      drop++;
    }
    if (drop) { this.undoStack.splice(0, drop); this.dropped += drop; }
  }

  load(doc: CadDocument) {
    if (doc.format !== 'chatcad' || doc.version !== 1) throw new Error('Not a CHAD part file (format chatcad, version 1)');
    this.doc = clone(doc);
    // A new document starts a new history (positions keep counting, so an old checkpoint never points into it).
    this.dropped += this.undoStack.length;
    this.undoStack = [];
    this.redoStack = [];
    this.held = [];
    this.emit();
  }

  serialize(): string { return JSON.stringify(this.doc, null, 2); }

  // ---------- queries ----------
  feature(id: string): Feature | undefined { return this.doc.features.find((f) => f.id === id); }

  /** Next free default name like Sketch3 / Extrude2 (never reuses a taken name). */
  private uniqueName(base: string): string {
    let max = 0;
    const escaped = base.replace(/[.*+?^$(){}|[\]\\/-]/g, (c) => `\\${c}`);
    const re = new RegExp(`^${escaped}(\\d+)$`);
    for (const f of this.doc.features) { const m = re.exec(f.name); if (m) max = Math.max(max, Number(m[1])); }
    return `${base}${max + 1}`;
  }

  /** The default name the next feature of this base would get, e.g. "Extrude3". */
  nextName(base: string): string { return this.uniqueName(base); }

  /** Index where a new feature goes: right after the rollback bar. */
  insertIndex(): number {
    return this.doc.rollback ?? this.doc.features.length;
  }

  private insert(f: Feature) {
    const i = this.insertIndex();
    this.doc.features.splice(i, 0, f);
    if (this.doc.rollback !== null) this.doc.rollback = i + 1;
  }

  // ---------- commands ----------
  setMaterial(material: CadDocument['material'] | null) {
    if (material && !(material.density > 0)) throw new Error('Density must be greater than zero');
    this.mutate(material ? `Material: ${material.name}` : 'Remove material', (d) => {
      if (material) d.material = { name: material.name, density: material.density }; else delete d.material;
    });
  }

  /** New part: clears features, parameters and material (undoable, keeps units). */
  resetPart(name = 'Part1') {
    this.mutate('New part', (d) => { d.features = []; d.params = []; d.rollback = null; delete d.material; d.name = name; });
  }

  renameDocument(name: string) {
    const n = name.trim();
    if (!n) throw new Error('Name cannot be empty');
    this.mutate(`Rename part to ${n}`, (d) => { d.name = n; });
  }

  setUnits(units: CadDocument['units']) {
    this.mutate(`Units: ${units}`, (d) => { d.units = units; });
  }

  setParameter(name: string, expr: string) {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new ExpressionError(`Invalid parameter name "${name}"`);
    this.mutate(`Set ${name}`, (d) => {
      const p = d.params.find((x) => x.name === name);
      if (p) p.expr = expr; else d.params.push({ name, expr });
      resolveParams(d); // throws if invalid, rolling back
    });
  }

  deleteParameter(name: string) {
    this.mutate(`Delete ${name}`, (d) => { d.params = d.params.filter((p) => p.name !== name); });
  }

  addSketch(plane: BasePlane | 'face', entities: SketchEntity[] = [], opts: { name?: string; offset?: ValueExpr; frame?: PlaneFrame; faceLabel?: string; refPlane?: string } = {}): string {
    if (plane === 'face' && !opts.frame) throw new Error('A sketch on a face needs its plane frame');
    if (opts.refPlane && this.feature(opts.refPlane)?.type !== 'refPlane') throw new Error(`No reference plane ${opts.refPlane}`);
    const f: SketchFeature = {
      id: newId('sk'), type: 'sketch', name: opts.name ?? this.uniqueName('Sketch'),
      plane, entities: clone(entities), ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      ...(opts.frame ? { frame: clone(opts.frame) } : {}), ...(opts.faceLabel ? { faceLabel: opts.faceLabel } : {}),
      ...(opts.refPlane ? { refPlane: opts.refPlane } : {}),
    };
    this.mutate(`Add ${f.name}`, () => this.insert(f));
    return f.id;
  }

  addSketchEntities(sketchId: string, entities: SketchEntity[]) {
    this.mutate('Edit sketch', () => {
      const s = this.requireType(sketchId, 'sketch');
      s.entities.push(...clone(entities));
    });
  }

  /**
   * General sketch edit used by the interactive sketcher (src/sketch/commands.ts):
   * `fn` changes the sketch's entities/constraints in place, as one undo step.
   * Throwing inside `fn` leaves the document unchanged.
   */
  editSketch(sketchId: string, label: string, fn: (sketch: SketchFeature) => void) {
    this.mutate(label, () => fn(this.requireType(sketchId, 'sketch')));
  }

  replaceSketchEntity(sketchId: string, entity: SketchEntity) {
    this.mutate('Edit sketch', () => {
      const s = this.requireType(sketchId, 'sketch');
      const i = s.entities.findIndex((e) => e.id === entity.id);
      if (i < 0) throw new Error(`No entity ${entity.id} in ${s.name}`);
      s.entities[i] = clone(entity);
    });
  }

  removeSketchEntity(sketchId: string, entityId: string) {
    this.mutate('Edit sketch', () => {
      const s = this.requireType(sketchId, 'sketch');
      s.entities = s.entities.filter((e) => e.id !== entityId);
    });
  }

  addExtrude(sketch: string, depth: ValueExpr, opts: {
    operation?: BooleanOp; direction?: ExtrudeFeature['direction']; throughAll?: boolean; name?: string;
    depth2?: ValueExpr; throughAll2?: boolean;
    upTo?: ExtrudeFeature['upTo']; startOffset?: ValueExpr; startOffsetReverse?: boolean;
    draft?: ValueExpr; draftOutward?: boolean; flipSide?: boolean; thin?: ExtrudeFeature['thin'];
    upTo2?: ExtrudeFeature['upTo2']; draft2?: ValueExpr; draftOutward2?: boolean;
  } = {}): string {
    this.requireType(sketch, 'sketch');
    if (opts.flipSide && opts.operation !== 'cut') throw new Error('Flip side to cut is only for cuts');
    if (opts.upTo && (opts.direction === 'symmetric' || opts.throughAll)) throw new Error('Up To Next / Vertex / Surface replaces Blind, Through All and Mid Plane in Direction 1');
    if (opts.upTo2 && opts.throughAll2) throw new Error('Direction 2: Up To Next / Vertex / Surface replaces Through All');
    const operation = opts.operation ?? (this.doc.features.some((f) => f.type !== 'sketch') ? 'add' : 'new');
    const f: ExtrudeFeature = {
      id: newId('ex'), type: 'extrude',
      name: opts.name ?? this.uniqueName(operation === 'cut' ? 'Cut-Extrude' : 'Extrude'),
      sketch, depth, direction: opts.direction ?? 'normal', operation,
      ...(opts.throughAll ? { throughAll: true } : {}),
      ...(opts.depth2 !== undefined ? { depth2: opts.depth2 } : {}),
      ...(opts.throughAll2 ? { throughAll2: true } : {}),
      ...(opts.upTo ? { upTo: clone(opts.upTo) } : {}),
      ...(opts.startOffset !== undefined ? { startOffset: opts.startOffset } : {}),
      ...(opts.startOffsetReverse ? { startOffsetReverse: true } : {}),
      ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
      ...(opts.draftOutward ? { draftOutward: true } : {}),
      ...(opts.flipSide ? { flipSide: true } : {}),
      ...(opts.thin ? { thin: clone(opts.thin) } : {}),
      ...(opts.upTo2 ? { upTo2: clone(opts.upTo2) } : {}),
      ...(opts.draft2 !== undefined ? { draft2: opts.draft2 } : {}),
      ...(opts.draftOutward2 ? { draftOutward2: true } : {}),
    };
    for (const dep of featureDependencies(f)) if (!this.feature(dep)) throw new Error(`No feature ${dep}`);
    this.mutate(`Add ${f.name}`, () => this.insert(f));
    return f.id;
  }

  addRevolve(sketch: string, axisLine: string, angle: ValueExpr = 360, opts: { operation?: BooleanOp; name?: string } & Pick<RevolveFeature, 'end' | 'reverse' | 'angle2' | 'thin'> = {}): string {
    const s = this.requireType(sketch, 'sketch');
    if (!s.entities.some((e) => e.id === axisLine && e.kind === 'line')) throw new Error(`Axis ${axisLine} is not a line in ${s.name}`);
    if (opts.end === 'midPlane' && opts.angle2 !== undefined) throw new Error('Direction 2 is not used with Mid Plane');
    const operation = opts.operation ?? (this.doc.features.some((f) => f.type !== 'sketch') ? 'add' : 'new');
    const f: RevolveFeature = {
      id: newId('rv'), type: 'revolve', name: opts.name ?? this.uniqueName(operation === 'cut' ? 'Cut-Revolve' : 'Revolve'),
      sketch, axisLine, angle, operation,
      ...(opts.end && opts.end !== 'blind' ? { end: opts.end } : {}),
      ...(opts.reverse ? { reverse: true } : {}),
      ...(opts.angle2 !== undefined ? { angle2: opts.angle2 } : {}),
      ...(opts.thin ? { thin: clone(opts.thin) } : {}),
    };
    this.mutate(`Add ${f.name}`, () => this.insert(f));
    return f.id;
  }

  /**
   * Add a modelling feature (fillet, chamfer, hole, pattern, shell, ...). The
   * typed helpers in src/core/featureCommands.ts validate inputs and call this.
   * Without a name it gets the conventional CAD-style default (Fillet1, LPattern2...).
   */
  addFeature<T extends ModelingFeature>(f: Omit<T, 'id' | 'name'> & { name?: string }, opts: { defaultName?: string } = {}): string {
    for (const dep of featureDependencies(f as unknown as Feature)) if (!this.feature(dep)) throw new Error(`No feature ${dep}`);
    const base = opts.defaultName ?? DEFAULT_NAMES[f.type];
    const full = { ...clone(f), id: newId(f.type.slice(0, 2)), name: f.name?.trim() || this.uniqueName(base) } as unknown as Feature;
    // A new loft stores its seam, so the same steps always build the same faces (src/core/loftSeam.ts).
    if (full.type === 'loft' && full.seam === undefined) full.seam = nextLoftSeam(this.doc.features);
    this.mutate(`Add ${full.name}`, () => this.insert(full));
    return full.id;
  }

  /** Change properties of a feature (e.g. depth). Type and id cannot change. A null value removes an optional property. */
  updateFeature(id: string, patch: Record<string, unknown>) {
    this.mutate('Edit feature', () => {
      const f = this.feature(id);
      if (!f) throw new Error(`No feature ${id}`);
      const { id: _i, type: _t, ...rest } = patch as any;
      // null means "remove this optional property" (e.g. turn off Direction 2).
      for (const [k, v] of Object.entries(clone(rest))) {
        if (v === null) delete (f as any)[k]; else (f as any)[k] = v;
      }
    });
  }

  renameFeature(id: string, name: string) { this.updateFeature(id, { name }); }

  setSuppressed(id: string, suppressed: boolean) { this.updateFeature(id, { suppressed }); }

  deleteFeature(id: string) {
    this.mutate('Delete feature', (d) => {
      const f = this.feature(id);
      if (!f) throw new Error(`No feature ${id}`);
      // Remove everything built from it, transitively (a sketch's extrude, a pattern of that extrude...).
      const remove = new Set([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const x of d.features) if (!remove.has(x.id) && featureDependencies(x).some((dep) => remove.has(dep))) { remove.add(x.id); grew = true; }
      }
      // The bar stays below the same features: it moves up by the removed features that were above it
      // (dependents below the bar, which were not applied, do not count).
      if (d.rollback !== null) {
        const above = d.features.slice(0, d.rollback).filter((x) => remove.has(x.id)).length;
        d.features = d.features.filter((x) => !remove.has(x.id));
        d.rollback = d.rollback - above >= d.features.length ? null : d.rollback - above;
      } else d.features = d.features.filter((x) => !remove.has(x.id));
    });
  }

  setRollback(index: number | null) {
    this.mutate('Move rollback bar', (d) => {
      d.rollback = index === null || index >= d.features.length ? null : Math.max(0, index);
    });
  }

  private requireType<T extends Feature['type']>(id: string, type: T): Extract<Feature, { type: T }> {
    const f = this.feature(id);
    if (!f) throw new Error(`No feature ${id}`);
    if (f.type !== type) throw new Error(`${f.name} is a ${f.type}, expected ${type}`);
    return f as Extract<Feature, { type: T }>;
  }
}

/**
 * Resolve document parameters in order; each may reference earlier ones.
 * A parameter whose value has no unit is a length in document units.
 */
export function resolveParams(doc: CadDocument): Record<string, Quantity> {
  const out: Record<string, Quantity> = {};
  const unitMM = doc.units === 'in' ? 25.4 : 1;
  for (const p of doc.params) {
    const q = evaluate(p.expr, out, unitMM);
    out[p.name] = q.dim === 'none' ? { v: q.v * unitMM, dim: 'length', bare: q.v } : q;
  }
  return out;
}
