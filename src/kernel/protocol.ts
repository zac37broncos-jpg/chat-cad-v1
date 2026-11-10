import type { CadDocument } from '../core/model';
import type { FeatureStatus, SketchGeometry } from './regen';
import type { MeshData, MassProps, EntityInfo } from './query';
import type { PartQuality } from './quality';
import type { StepOptions, StepReport, StlOptions, StlReport } from './exporters';
import type { DrawingGeometryResponse, ViewRequest } from './hlr';
import type { Topology } from './naming';
import type { RefGeometry } from './features';
import type { FailedFeature } from './regenOp';

import type { BasePlane } from '../core/model';

export type SubRef = { kind: 'face' | 'edge'; index: number };
/** A reference plane (Front/Top/Right) picked in the viewport or tree. */
export type PlaneRef = { kind: 'plane'; plane: BasePlane };
/** Anything the user can select. */
export type SelRef = SubRef | PlaneRef;

export type KernelRequest =
  /** mesh false: skip the display mesh (the chat only needs status and mass). topology false: skip face names. */
  | { op: 'regen'; doc: CadDocument; mesh?: boolean; topology?: boolean; mass?: boolean }
  /**
   * Preview a feature being created/edited: `doc` contains the feature at its
   * position. Returns the model just before it (base) and its tool body.
   */
  | { op: 'preview'; doc: CadDocument; featureId: string; topology?: boolean }
  | { op: 'info'; ref: SubRef }
  | { op: 'distance'; a: SubRef; b: SubRef }
  /**
   * STEP (exact solid) of `doc`, checked by reading it back. The worker rebuilds `doc` itself (from
   * its history cache), so the file is always the document open now; `failed` names features that
   * did not rebuild and are therefore missing from the file.
   */
  | ({ op: 'exportStep'; doc: CadDocument } & StepOptions)
  /** Printability / CAM check of the current (last regenerated) shape. */
  | { op: 'quality' }
  /** STL (triangle mesh) of `doc`, checked for printing (rebuilt like exportStep). */
  | ({ op: 'exportStl'; doc: CadDocument } & StlOptions)
  /**
   * 2D drawing views by exact hidden-line removal. The worker regenerates
   * `doc` (all features, ignoring the rollback bar) into its own cache, so
   * this never disturbs the 3D viewport's current shape.
   */
  | { op: 'drawing'; doc: CadDocument; views: ViewRequest[] };

export interface RegenResponse {
  /** Face names and edge adjacency of the solid (topological naming), by index. */
  topology?: Topology | null;
  /** Reference planes / axes / points to draw. */
  refGeometry?: RefGeometry[];
  mesh: MeshData | null;
  status: FeatureStatus[];
  sketches: SketchGeometry[];
  mass: MassProps | null;
  ms: number;
}

/** `result` is set for in-place features (fillet, chamfer, shell, draft) that have no tool body. */
/** `baseTopology` (when requested) names the faces/edges of `base`, so picks on the preview base can become references. */
export interface PreviewResponse { base: MeshData | null; tool: MeshData | null; result?: MeshData; baseTopology?: Topology | null; ok: boolean; message?: string }

export type KernelResponseMap = {
  preview: PreviewResponse;
  regen: RegenResponse;
  info: EntityInfo;
  distance: { distance: number; p1: [number, number, number]; p2: [number, number, number] };
  exportStep: { text: string; report: StepReport; failed: FailedFeature[] };
  quality: PartQuality;
  exportStl: { data: Uint8Array; report: StlReport; failed: FailedFeature[] };
  drawing: DrawingGeometryResponse & { volume: number | null; sketches: SketchGeometry[] };
};
