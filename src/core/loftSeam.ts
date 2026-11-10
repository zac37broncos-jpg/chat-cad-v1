/**
 * Where a smooth loft's closed surface starts and ends (its seam).
 *
 * The surface is exactly the same shape wherever the seam runs, but the seam
 * decides how OpenCascade splits it into faces, edges and vertices, and some
 * kernel steps (booleans, bounding boxes, STEP export) are sensitive to it.
 * Two organic bodies whose seams meet on their intersection are a known
 * OpenCascade weakness, so each loft gets its own seam.
 *
 * Until 2026-11-06 the seam came from a hash of the loft's random id, so the
 * same steps built a differently-seamed part every run (and tests passed or
 * failed at random). Now a new loft stores its seam in the document when it is
 * created, chosen from how many lofts the part already has: the same steps
 * always give the same seams, and the seam does not move when other features
 * are edited, added or deleted afterwards. Documents saved before that have no
 * stored seam; they keep the old id-based seam, so they rebuild exactly as
 * they did.
 */
import type { LoftFeature } from './featureTypes';

/** Golden-ratio step (0.618...): successive seams spread evenly around (0, 0.618, 0.236, 0.854, 0.472, ...). */
const STEP = (Math.sqrt(5) - 1) / 2;

/** The k-th seam of the golden sequence, a fraction of a turn in [0, 1). */
export function loftSeamAt(k: number): number {
  const x = k * STEP;
  return x - Math.floor(x);
}

/**
 * The seam for a new loft in a document with these features: the next one of
 * the golden sequence after the lofts it already has, skipping any value an
 * existing loft already uses (after a delete, two lofts could otherwise share one).
 */
export function nextLoftSeam(features: readonly { type: string; seam?: unknown }[]): number {
  const lofts = features.filter((f) => f.type === 'loft');
  const used = new Set(lofts.map((f) => f.seam).filter((s): s is number => typeof s === 'number'));
  let k = lofts.length;
  while (used.has(loftSeamAt(k))) k++;
  return loftSeamAt(k);
}

/** The seam of a loft saved before seams were stored: a stable number in [0, 1) from its id. */
export function legacyLoftSeam(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** The seam this loft is built with (its stored seam, or the old id-based one). */
export function loftSeam(f: Pick<LoftFeature, 'id' | 'seam'>): number {
  if (f.seam === undefined) return legacyLoftSeam(f.id);
  if (typeof f.seam !== 'number' || !Number.isFinite(f.seam)) throw new Error('Its seam position must be a number (a fraction of a turn)');
  return f.seam;
}
