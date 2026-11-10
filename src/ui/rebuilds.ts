/**
 * The viewport's rebuilds: every change to the part asks for one, the newest wins.
 *
 * - A newer rebuild replaces a queued one (KernelClient `supersede`); a result that comes back
 *   after a newer rebuild was asked for is dropped (`seq`), so the screen never goes back to an
 *   older model.
 * - It remembers which exact document the result on screen was built from (`shown.doc`; the
 *   DocumentStore never changes a document object it handed out) and whether the newest rebuild
 *   failed. Mass Properties uses that to show only numbers of the document open now
 *   (./massStatus.ts).
 *
 * Kept out of the React component so tests can drive it against the real kernel.
 */
import type { CadDocument } from '../core/model';
import { Superseded } from '../kernel/client';
import type { KernelRequest, RegenResponse } from '../kernel/protocol';
import { massPanelState, type MassPanelState, type RegenFailure, type ShownRegen } from './massStatus';

export interface RebuildKernel {
  call(req: Extract<KernelRequest, { op: 'regen' }>, opts: { supersede?: string }): Promise<RegenResponse>;
}

export interface RebuildEvents {
  /** The newest rebuild finished (the caller shows its mesh). */
  result?(r: RegenResponse, doc: Readonly<CadDocument>): void;
  /** The newest rebuild failed (not replaced by a newer one). */
  error?(message: string): void;
  /** busy / shown / failure changed. */
  change?(): void;
}

export class ViewportRebuilds {
  private seq = 0;
  /** The rebuild result on screen and what it was built from. */
  shown: ShownRegen | null = null;
  /** The newest rebuild failed. Cleared by the next result. */
  failure: RegenFailure | null = null;
  /** A rebuild is queued or running. */
  busy = false;

  constructor(private readonly kernel: RebuildKernel, public on: RebuildEvents = {}) {}

  /** Rebuild `doc` (mass: compute mass properties too). Resolves when this request is settled. */
  request(doc: Readonly<CadDocument>, mass: boolean): Promise<void> {
    const seq = ++this.seq;
    this.busy = true;
    this.on.change?.();
    return this.kernel.call({ op: 'regen', doc: doc as CadDocument, mass }, { supersede: 'viewport' }).then((r) => {
      if (seq !== this.seq) return;
      this.shown = { doc, massRequested: mass, result: r };
      this.failure = null;
      this.on.result?.(r, doc);
    }).catch((e) => {
      if (seq !== this.seq || e instanceof Superseded) return;
      const message = String((e as Error)?.message ?? e);
      this.failure = { doc, message };
      this.on.error?.(message);
    }).finally(() => {
      if (seq === this.seq) this.busy = false;
      this.on.change?.();
    });
  }

  massState(current: Readonly<CadDocument>): MassPanelState {
    return massPanelState({ current, shown: this.shown, busy: this.busy, failure: this.failure });
  }
}
