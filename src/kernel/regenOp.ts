/**
 * The worker's 'regen' request: rebuild the document and return its mesh, status and mass.
 *
 * Kept apart from worker.ts (which loads the WASM files by URL) so tests run exactly this code
 * against the real kernel in Node (tests/mass-consistency.test.ts).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { CadDocument } from '../core/model';
import { regenerate, type OC, type FeatureStatus } from './regen';
import { tessellate, massProperties, type MeshData, type MassProps } from './query';
import type { KernelRequest, RegenResponse } from './protocol';
import type { SketchSolver } from '../sketch/solver';

/** What the worker keeps between requests. */
export interface ModelState {
  /** The last regenerated shape (info, distance, export and quality read it). */
  current: TopoDS_Shape | null;
  /** Mesh and mass of the last regenerated shape (buffers are transferred, so keep a copy). */
  lastResult: { shape: TopoDS_Shape; mass: MassProps | null; mesh: MeshData | null } | null;
}

export const newModelState = (): ModelState => ({ current: null, lastResult: null });

const cloneMesh = (m: MeshData): MeshData => ({
  faces: m.faces.map((f) => ({ index: f.index, positions: f.positions.slice(), normals: f.normals.slice(), indices: f.indices.slice() })),
  edges: m.edges.map((e) => ({ ...e, points: e.points.slice() })),
});

export function regenOp(oc: OC, state: ModelState, req: Extract<KernelRequest, { op: 'regen' }>, solver: SketchSolver): { result: RegenResponse; transfer: Transferable[] } {
  const t0 = performance.now();
  const transfer: Transferable[] = [];
  // Incremental: only features after the first change are recomputed (see RegenOptions.cache).
  const r = regenerate(oc, req.doc, { solver, cache: true, topology: req.topology !== false });
  state.current = r.shape;
  // Mesh and mass are cached per resulting shape object, so the viewport and the chat asking for
  // the same model do not pay twice. The history cache hands back the very same object only when
  // the model is unchanged; any change makes a new shape object, so a cached mass is never of
  // another model.
  const prev = state.lastResult;
  const cached = r.shape && prev?.shape === r.shape ? prev : null;
  const mass = r.shape && req.mass !== false ? (cached?.mass ?? massProperties(oc, r.shape)) : (cached?.mass ?? null);
  let mesh: MeshData | null = null;
  if (r.shape && req.mesh !== false) mesh = cached?.mesh ? cloneMesh(cached.mesh) : tessellate(oc, r.shape);
  state.lastResult = r.shape ? { shape: r.shape, mass: mass ?? cached?.mass ?? null, mesh: mesh ? cloneMesh(mesh) : cached?.mesh ?? null } : null;
  if (mesh) for (const f of mesh.faces) transfer.push(f.positions.buffer, f.normals.buffer, f.indices.buffer);
  const result: RegenResponse = { mesh, status: r.status, sketches: r.sketches, mass, topology: r.topology ?? null, refGeometry: r.refGeometry ?? [], ms: performance.now() - t0 };
  return { result, transfer };
}

/** A feature that did not rebuild, named the way the tree shows it. */
export interface FailedFeature { id: string; name: string; message: string }

/** The features of `doc` that failed to rebuild (their geometry is missing from the result). */
export function failedFeatures(doc: Readonly<CadDocument>, status: readonly FeatureStatus[]): FailedFeature[] {
  return status.filter((s) => !s.ok).map((s) => ({
    id: s.id,
    name: doc.features.find((f) => f.id === s.id)?.name ?? s.id,
    message: s.message ?? 'It did not rebuild.',
  }));
}

/**
 * The model an export writes: exactly `doc`, the document open when Export was pressed, rebuilt
 * through the history cache (an unchanged model costs nothing), never whatever the worker built
 * last (after a worker restart that is an older document). Also says which features failed to
 * rebuild, because the file would silently be missing them.
 */
export function modelForExport(oc: OC, state: ModelState, doc: CadDocument, solver: SketchSolver): { shape: TopoDS_Shape; failed: FailedFeature[] } {
  const r = regenerate(oc, doc, { solver, cache: true, topology: false });
  // The history cache owns the shape (as for a viewport rebuild), and later reads see this model.
  state.current = r.shape;
  const failed = failedFeatures(doc, r.status);
  if (!r.shape) {
    const why = failed.length ? ` (${failed.map((f) => `${f.name}: ${f.message}`).join(' ')})` : '';
    throw new Error(`There is no solid to export${why}.`);
  }
  return { shape: r.shape, failed };
}
