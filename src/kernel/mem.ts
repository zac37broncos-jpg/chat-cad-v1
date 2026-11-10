/**
 * Memory rules for the geometry kernel (OpenCascade compiled to WASM).
 *
 * Every OpenCascade value object handed to JavaScript (a shape, a point, a
 * builder, an explorer, ...) is a C++ object on the WASM heap. JavaScript's
 * garbage collector never frees it: only `.delete()` does, and the heap never
 * shrinks. A shape object that is not deleted also keeps its whole B-rep
 * (surfaces, display triangles) alive. Without these rules a long editing
 * session grows the heap until the kernel runs out of memory.
 * (Reference-counted objects, i.e. every Standard_Transient such as Geom_*
 * curves and surfaces or Poly_Triangulation, are freed by the bindings when
 * their wrapper is garbage collected; deleting them early is still fine.)
 *
 *  1. A kernel function deletes every object it creates and does not return
 *     or store: builders, explorers, lists, points, sub-shape copies. Getters
 *     such as `Explorer.Current()`, `TopoDS.Face(s)`, `Adaptor.Value(u)` and
 *     `Box.CornerMin()` return NEW objects, so their results count too; so
 *     does `ShapeList.Append(s)`, which returns a copy of what it added.
 *  2. Shapes in a `Named` (a body or tool with face names) belong to the
 *     regeneration that made them. `regenerate` records every Named made
 *     while it runs (see `own`) and, when it ends, deletes the shapes that
 *     nothing kept: intermediate bodies, pattern copies, failed attempts.
 *     What is kept: the history cache (cached rebuilds) or the result.
 *  3. A cached regeneration's result is valid until the next cached
 *     regeneration (or `clearRegenCache`). An uncached result belongs to the
 *     caller, who frees it with `releaseRegen` when done.
 *
 * tests/memory.test.ts checks these rules with a leak finder
 * (tests/helpers/ocLeaks.ts) that reports every object that was dropped
 * without being deleted.
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { Named } from './naming';

export interface Deletable { delete(): void; isDeleted?(): boolean }

/**
 * In this build of the bindings many classes have an empty C++ destructor, so
 * `.delete()` frees only the object itself, not what it owns (see the
 * opencascade.js 3.1.0 release notes: about 2,100 classes were bound that
 * way). Shapes (TopoDS_Shape) are fine. The boolean operations are not: each
 * one deleted without `Clear()` kept its whole data structure on the heap
 * (measured 120 to 170 KB per cut, so a 12-hole pattern grew the heap ~8 MB
 * per rebuild). `Clear()` releases it first.
 */
const CLEAR_BEFORE_DELETE = /^BRepAlgoAPI_/;

/** Delete one object; null and already-deleted ones are skipped. */
function release(x: Deletable | null | undefined): void {
  if (!x) return;
  try {
    if (x.isDeleted?.()) return;
    const c = x as unknown as { constructor?: { name?: string }; Clear?: () => void };
    if (typeof c.Clear === 'function' && CLEAR_BEFORE_DELETE.test(c.constructor?.name ?? '')) c.Clear();
    x.delete();
  } catch { /* the kernel was replaced: nothing to free */ }
}

/** Delete objects; null and already-deleted ones are skipped. */
export function free(...xs: (Deletable | null | undefined)[]): void { freeAll(xs); }
export function freeAll(xs: Iterable<Deletable | null | undefined>): void {
  for (const x of xs) release(x);
}

/** X, Y, Z of a point, vector or direction that the caller owns, which is then deleted. */
export function takeXyz(p: { X(): number; Y(): number; Z(): number; delete(): void }): [number, number, number] {
  const r: [number, number, number] = [p.X(), p.Y(), p.Z()];
  p.delete();
  return r;
}

/** Run `fn` with `o`, then delete `o` (also when `fn` throws). */
export function using<T extends Deletable, R>(o: T, fn: (o: T) => R): R {
  try { return fn(o); } finally { free(o); }
}

/** The shape objects a Named holds. */
export function namedObjects(n: Named): TopoDS_Shape[] { return [n.shape, ...n.faces]; }
export function freeNamed(n: Named | null | undefined): void { if (n) freeAll(namedObjects(n)); }

// ------------------------------------------------------------------ Named ledger (rule 2)

const ledgers: Set<Named>[] = [];

/** Record a Named made during a regeneration (no-op outside one). Returns it. */
export function own<T extends Named | null | undefined>(n: T): T {
  if (n && ledgers.length) ledgers[ledgers.length - 1].add(n);
  return n;
}

/** Start recording Named objects; `endLedger` returns what was recorded. Nests. */
export function beginLedger(): void { ledgers.push(new Set()); }
export function endLedger(): Set<Named> { return ledgers.pop() ?? new Set(); }

/**
 * Delete every shape object of `candidates` that is not in `keep` (compared by
 * object identity: several Named can share one shape object).
 */
export function freeExcept(candidates: Iterable<TopoDS_Shape>, keep: Set<TopoDS_Shape>): void {
  const seen = new Set<TopoDS_Shape>();
  for (const s of candidates) {
    if (keep.has(s) || seen.has(s)) continue;
    seen.add(s);
    free(s);
  }
}
