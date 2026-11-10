/**
 * What the Mass Properties panel may show.
 *
 * The panel shows numbers only from a rebuild of the exact document that is open now (the
 * DocumentStore never changes a document object it handed out, so identity says "built from
 * this document"), with mass properties computed, and no newer rebuild running. Anything
 * else shows "Updating" or the reason, never an older or partial number:
 *  - a rebuild is running (an edit, undo/redo, a parameter typed, the chat building): updating;
 *  - the shown rebuild is of an older document (its newer rebuild was skipped as stale, or has
 *    not come back yet): updating;
 *  - the shown rebuild skipped mass properties (they are only computed while the panel is
 *    open): updating;
 *  - the newest rebuild failed (the kernel crashed and could not rebuild, or an error): the
 *    message, and no numbers;
 *  - features that failed to rebuild are named, because the numbers leave them out.
 */
import type { CadDocument } from '../core/model';
import type { RegenResponse } from '../kernel/protocol';

/** The rebuild result on screen and what it was built from. */
export interface ShownRegen {
  doc: Readonly<CadDocument>;
  /** Mass properties were asked for (false: the result has none or a cached copy, not to be shown). */
  massRequested: boolean;
  result: RegenResponse;
}

/** The newest rebuild failed (not merely replaced by a newer one). */
export interface RegenFailure { doc: Readonly<CadDocument>; message: string }

export type MassPanelState =
  | { kind: 'updating' }
  | { kind: 'failed'; message: string }
  | { kind: 'noSolid'; failed: string[] }
  | { kind: 'ready'; mass: NonNullable<RegenResponse['mass']>; failed: string[] };

export function massPanelState(input: {
  current: Readonly<CadDocument>;
  shown: ShownRegen | null;
  /** A viewport rebuild is queued or running. */
  busy: boolean;
  failure: RegenFailure | null;
}): MassPanelState {
  const { current, shown, busy, failure } = input;
  if (busy) return { kind: 'updating' };
  if (failure && failure.doc === current) return { kind: 'failed', message: failure.message };
  if (!shown || shown.doc !== current || !shown.massRequested) return { kind: 'updating' };
  const failed = shown.result.status.filter((s) => !s.ok).map((s) => current.features.find((f) => f.id === s.id)?.name ?? s.id);
  if (!shown.result.mass) return { kind: 'noSolid', failed };
  return { kind: 'ready', mass: shown.result.mass, failed };
}
