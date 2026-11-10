/**
 * Tests that need a particular loft seam. Before 2026-11-06 a loft's seam came from its random
 * id, so the regression tests recorded the ids of failing builds and swapped them in. Lofts now
 * store their seam (src/core/loftSeam.ts); this gives the swapped-in lofts the seam their recorded
 * id used to give, so those tests build exactly the geometry they were written for.
 */
import type { CadDocument } from '../../src/core/model';
import { legacyLoftSeam } from '../../src/core/loftSeam';

/** A copy of `doc` with the named features' ids replaced, and those lofts seamed as their recorded id seamed them. */
export function withRecordedSeams(doc: Readonly<CadDocument>, ids: Record<string, string>): CadDocument {
  let json = JSON.stringify(doc);
  for (const [name, id] of Object.entries(ids)) {
    const f = doc.features.find((x) => x.name === name);
    if (!f) throw new Error(`No feature named ${name}`);
    json = json.split(f.id).join(id);
  }
  const out: CadDocument = JSON.parse(json);
  const swapped = new Set(Object.values(ids));
  for (const f of out.features) if (f.type === 'loft' && swapped.has(f.id)) f.seam = legacyLoftSeam(f.id);
  return out;
}
