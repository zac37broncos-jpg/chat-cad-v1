/**
 * Feature references in AI tool arguments: an id, or a feature's exact name.
 */
import type { DocumentStore } from '../core/store';

/**
 * Let Claude refer to features and sketches by their (unique) names as well
 * as by id, so a whole model can be described in one build_model call.
 * An id always wins; a name must match exactly one feature (case-insensitive).
 */
export function resolveFeatureRef(store: DocumentStore, v: unknown): unknown {
  if (typeof v !== 'string' || store.feature(v)) return v;
  const key = v.trim().toLowerCase();
  const hits = store.state.features.filter((f) => f.name.trim().toLowerCase() === key);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw new Error(`"${v}" names ${hits.length} features; use the id instead`);
  return v;
}

