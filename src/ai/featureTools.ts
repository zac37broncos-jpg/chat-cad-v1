/**
 * AI tools for the modelling features (fillet, chamfer, holes, patterns,
 * shell, draft, rib, sweep, loft, reference geometry). They call the same
 * DocumentStore commands as the UI (src/core/featureCommands.ts).
 *
 * Claude picks faces/edges by index from get_topology (or the user's
 * selection); they are turned into persistent references immediately, so the
 * feature keeps its edges through later edits.
 */
import type { ExecutorContext } from './executor';
import type { Feature, ValueExpr } from '../core/model';
import type { FaceRef, EdgeRef, PlaneSpec, AxisSpec, ModelingFeature, Vec3, Vec3Expr } from '../core/featureTypes';
import * as F from '../core/featureCommands';
import { holeSpec, holeSizes } from '../core/holeTables';
import { MM_PER } from '../core/units';
import { faceRefFrom, edgeRefFrom, describeTag, type Topology } from '../kernel/naming';
import TOOLS from './featureTools.json';
import { resolveFeatureRef } from './refs';

export const FEATURE_TOOL_DEFS = TOOLS as { name: string; description: string; inputSchema: Record<string, unknown> }[];
export const FEATURE_TOOL_NAMES = new Set(FEATURE_TOOL_DEFS.map((t) => t.name));

type Args = Record<string, any>;

async function topo(ctx: ExecutorContext): Promise<Topology> {
  const r = await ctx.regen();
  if (!r.topology) throw new Error('There is no solid yet (or its topology is unavailable)');
  return r.topology;
}

const round = (v: number) => +v.toFixed(6);

/** Does a face (by its history tags) belong to feature fid (made by it, or a pattern/mirror copy it made)? */
const ownedBy = (tags: string[], fid: string) => tags.some((x) => x.startsWith(`${fid}:`) || x.includes(`#${fid}.`));

function featureIdOf(ctx: ExecutorContext, v: unknown, what: string): string {
  const id = resolveFeatureRef(ctx.store, v);
  if (typeof id !== 'string' || !ctx.store.feature(id)) throw new Error(`${what}: no feature named "${String(v)}"`);
  return id;
}

function faceRefs(ctx: ExecutorContext, t: Topology, list: unknown, what: string): FaceRef[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${what} must be an array`);
  const out: FaceRef[] = [];
  for (const item of list) {
    if (item === 'selection') {
      for (const s of ctx.selection()) if (s.kind === 'face') out.push(faceRefFrom(t, s.index));
    } else if (item && typeof item === 'object' && Number.isInteger((item as Args).index)) {
      out.push(faceRefFrom(t, (item as Args).index));
    } else if (item && typeof item === 'object' && (item as Args).feature !== undefined) {
      const fid = featureIdOf(ctx, (item as Args).feature, what);
      const n = out.length;
      t.faces.forEach((f, i) => { if (ownedBy(f.tags, fid)) out.push(faceRefFrom(t, i)); });
      if (out.length === n) throw new Error(`${what}: feature "${(item as Args).feature}" has no faces on the part`);
    } else throw new Error(`${what}: each item is {index}, {feature} or "selection"`);
  }
  return out;
}

function edgeRefs(ctx: ExecutorContext, t: Topology, list: unknown, what: string): EdgeRef[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${what} must be an array`);
  const out: EdgeRef[] = [];
  for (const item of list) {
    if (item === 'selection') {
      for (const s of ctx.selection()) if (s.kind === 'edge') out.push(edgeRefFrom(t, s.index));
    } else if (item && typeof item === 'object' && Number.isInteger((item as Args).index)) {
      out.push(edgeRefFrom(t, (item as Args).index));
    } else if (item && typeof item === 'object' && ((item as Args).feature !== undefined || Array.isArray((item as Args).between))) {
      const o = item as Args;
      const n = out.length;
      if (o.between) {
        if (o.between.length !== 2) throw new Error(`${what}: between needs two feature names`);
        const A = featureIdOf(ctx, o.between[0], what), B = featureIdOf(ctx, o.between[1], what);
        t.edges.forEach((e, i) => {
          if (e.faces.length < 2) return;
          const fa = t.faces[e.faces[0]].tags, fb = t.faces[e.faces[1]].tags;
          if ((ownedBy(fa, A) && ownedBy(fb, B)) || (ownedBy(fa, B) && ownedBy(fb, A))) out.push(edgeRefFrom(t, i));
        });
        if (out.length === n) throw new Error(`${what}: "${o.between[0]}" and "${o.between[1]}" do not meet in an edge on the part`);
      } else {
        const fid = featureIdOf(ctx, o.feature, what);
        t.edges.forEach((e, i) => { if (e.faces.some((fi) => ownedBy(t.faces[fi].tags, fid))) out.push(edgeRefFrom(t, i)); });
        if (out.length === n) throw new Error(`${what}: feature "${o.feature}" has no edges on the part`);
      }
    } else throw new Error(`${what}: each item is {index}, {feature}, {between} or "selection"`);
  }
  return out;
}

const PLANES = ['XY', 'XZ', 'YZ'];

async function planeSpec(ctx: ExecutorContext, p: Args | undefined, what: string): Promise<PlaneSpec> {
  if (!p || typeof p !== 'object') throw new Error(`${what}: give {plane, offset}, {face:{index}} or {ref_plane_id}`);
  if (p.ref_plane_id) return { refPlane: String(p.ref_plane_id) };
  if (p.face !== undefined) {
    const t = await topo(ctx);
    const refs = faceRefs(ctx, t, [p.face], what);
    if (!refs.length) throw new Error(`${what}: no face selected`);
    return { face: refs[0] };
  }
  if (PLANES.includes(p.plane)) return { base: p.plane, ...(p.offset !== undefined && p.offset !== '' ? { offset: p.offset } : {}) };
  throw new Error(`${what}: unknown plane`);
}

async function axisSpec(ctx: ExecutorContext, a: unknown, what: string): Promise<AxisSpec> {
  if (a === 'X' || a === 'Y' || a === 'Z') return { axis: a };
  if (a && typeof a === 'object') {
    const o = a as Args;
    if (o.ref_axis_id) return { refAxis: String(o.ref_axis_id) };
    if (o.axis === 'X' || o.axis === 'Y' || o.axis === 'Z') return { axis: o.axis };
    const t = await topo(ctx);
    if (o.edge !== undefined) return { edge: edgeRefs(ctx, t, [o.edge], what)[0] };
    if (o.face !== undefined) return { face: faceRefs(ctx, t, [o.face], what)[0] };
  }
  throw new Error(`${what}: give 'X'/'Y'/'Z', {edge:{index}}, {face:{index}} or {ref_axis_id}`);
}

const v3 = (p: unknown, what: string): Vec3Expr => {
  if (!Array.isArray(p) || p.length !== 3) throw new Error(`${what} must be [x, y, z]`);
  return { x: p[0], y: p[1], z: p[2] };
};

function opt<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
}

/** Runs one feature tool; returns the id of the feature it created. */
async function run(ctx: ExecutorContext, name: string, a: Args): Promise<string> {
  const { store } = ctx;
  const t = async () => topo(ctx);
  switch (name) {
    case 'fillet': {
      const tp = await t();
      const edges = edgeRefs(ctx, tp, a.edges, 'edges');
      const faces = faceRefs(ctx, tp, a.faces, 'faces');
      if (a.kind === 'variable') {
        const startAt = Array.isArray(a.start_point) ? (a.start_point.map((c: number) => c * MM_PER[store.state.units]) as Vec3) : undefined;
        return F.addVariableFillet(store, { edges, radius: a.radius, radius2: a.radius2, ...(startAt ? { startAt } : {}), name: a.name });
      }
      if (a.kind === 'face') return F.addFaceFillet(store, { faces, faces2: faceRefs(ctx, tp, a.faces2, 'faces2'), radius: a.radius, name: a.name });
      return F.addFillet(store, { edges, faces, radius: a.radius, name: a.name });
    }
    case 'chamfer': {
      const tp = await t();
      return F.addChamfer(store, opt({ edges: edgeRefs(ctx, tp, a.edges, 'edges'), faces: faceRefs(ctx, tp, a.faces, 'faces'), distance: a.distance, distance2: a.distance2, angle: a.angle, flip: a.flip, name: a.name }) as any);
    }
    case 'hole': {
      if (!Array.isArray(a.points) || !a.points.length) throw new Error('hole: points is required, e.g. [[1, 0.5]]');
      return F.addHole(store, opt({
        holeType: a.hole_type, standard: a.standard, size: String(a.size), fit: a.fit, end: a.end,
        depth: a.depth, threadDepth: a.thread_depth, drillPoint: a.drill_point_angle,
        diameter: a.diameter, cboreDiameter: a.cbore_diameter, cboreDepth: a.cbore_depth, cskDiameter: a.csk_diameter, cskAngle: a.csk_angle,
        placement: await planeSpec(ctx, a.placement, 'placement'),
        points: a.points.map((p: ValueExpr[]) => ({ x: p[0], y: p[1] })), flip: a.flip, name: a.name,
      }) as F.HoleOptions);
    }
    case 'linear_pattern':
      return F.addLinearPattern(store, opt({
        features: a.features, body: a.body, dir1: await axisSpec(ctx, a.direction1, 'direction1'), flip1: a.flip1, spacing1: a.spacing1, count1: a.count1,
        dir2: a.direction2 !== undefined ? await axisSpec(ctx, a.direction2, 'direction2') : undefined, flip2: a.flip2, spacing2: a.spacing2, count2: a.count2,
        skip: a.skip, name: a.name,
      }) as any);
    case 'circular_pattern':
      return F.addCircularPattern(store, opt({
        features: a.features, body: a.body, axis: await axisSpec(ctx, a.axis, 'axis'), count: a.count, angle: a.angle,
        equalSpacing: a.equal_spacing, flip: a.flip, skip: a.skip, name: a.name,
      }) as any);
    case 'mirror':
      return F.addMirror(store, opt({ features: a.features, body: a.body, plane: await planeSpec(ctx, a.plane, 'plane'), name: a.name }) as any);
    case 'shell': {
      const tp = a.open_faces?.length ? await t() : null;
      return F.addShell(store, opt({ faces: tp ? faceRefs(ctx, tp, a.open_faces, 'open_faces') : [], thickness: a.thickness, outward: a.outward, name: a.name }) as any);
    }
    case 'draft': {
      const tp = await t();
      return F.addDraft(store, opt({ faces: faceRefs(ctx, tp, a.faces, 'faces'), neutral: await planeSpec(ctx, a.neutral_plane, 'neutral_plane'), angle: a.angle, flip: a.flip, name: a.name }) as any);
    }
    case 'rib': return F.addRib(store, opt({ sketch: a.sketch_id, thickness: a.thickness, side: a.side, direction: a.direction, flip: a.flip, name: a.name }) as any);
    case 'sweep': {
      if (a.circular_diameter !== undefined && a.profile_sketch_id) throw new Error('sweep: give profile_sketch_id or circular_diameter, not both');
      return F.addSweep(store, opt({
        profile: a.profile_sketch_id, path: a.path_sketch_id, operation: a.operation, name: a.name,
        circular: a.circular_diameter !== undefined ? { diameter: a.circular_diameter } : undefined,
        orientation: a.orientation === 'keepNormal' ? 'keepNormal' : undefined,
      }) as any);
    }
    case 'loft': return F.addLoft(store, opt({
      profiles: a.profile_sketch_ids, ruled: a.ruled, operation: a.operation, name: a.name,
      startPoint: a.start_point !== undefined ? v3(a.start_point, 'start_point') : undefined,
      endPoint: a.end_point !== undefined ? v3(a.end_point, 'end_point') : undefined,
      startTip: a.start_tip, endTip: a.end_tip,
    }) as any);
    case 'reference_plane': {
      switch (a.type) {
        case 'offset': return F.addRefPlane(store, { kind: 'offset', from: await planeSpec(ctx, a.from, 'from'), distance: a.distance ?? 0, ...(a.flip ? { flip: true } : {}) }, a.name);
        case 'angle': return F.addRefPlane(store, { kind: 'angle', from: await planeSpec(ctx, a.from, 'from'), axis: await axisSpec(ctx, a.axis, 'axis'), angle: a.angle }, a.name);
        case 'three_points': {
          if (!Array.isArray(a.points) || a.points.length !== 3) throw new Error('three_points needs points: [[x,y,z],[x,y,z],[x,y,z]]');
          return F.addRefPlane(store, { kind: 'threePoints', points: a.points.map((p: unknown, i: number) => v3(p, `point ${i + 1}`)) as [Vec3Expr, Vec3Expr, Vec3Expr] }, a.name);
        }
        case 'midplane': return F.addRefPlane(store, { kind: 'midplane', a: await planeSpec(ctx, a.a, 'a'), b: await planeSpec(ctx, a.b, 'b') }, a.name);
        case 'normal_to_curve': {
          if (!a.sketch_id) throw new Error('normal_to_curve needs sketch_id (the path sketch)');
          if (a.at !== undefined && a.at !== 'start' && a.at !== 'end') throw new Error("normal_to_curve: at must be 'start' or 'end'");
          return F.addRefPlane(store, { kind: 'normalToCurve', sketch: a.sketch_id, at: a.at ?? 'end' }, a.name);
        }
        case 'parallel_at_point': {
          const point = a.ref_point_id ? { refPoint: a.ref_point_id as string } : v3(a.point, 'point');
          return F.addRefPlane(store, { kind: 'parallelAtPoint', from: await planeSpec(ctx, a.from, 'from'), point }, a.name);
        }
        default: throw new Error('reference_plane: unknown type');
      }
    }
    case 'reference_axis': {
      if (a.type === 'two_points') return F.addRefAxis(store, { kind: 'twoPoints', p1: v3(a.p1, 'p1'), p2: v3(a.p2, 'p2') }, a.name);
      if (a.type === 'two_planes') return F.addRefAxis(store, { kind: 'twoPlanes', a: await planeSpec(ctx, a.a, 'a'), b: await planeSpec(ctx, a.b, 'b') }, a.name);
      if (a.type === 'entity') return F.addRefAxis(store, { kind: 'entity', of: await axisSpec(ctx, a.of, 'of') }, a.name);
      throw new Error('reference_axis: unknown type');
    }
    case 'reference_point': {
      if (a.type === 'coords') return F.addRefPoint(store, { kind: 'coords', p: { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 } }, a.name);
      const tp = await t();
      if (a.type === 'arc_center') return F.addRefPoint(store, { kind: 'arcCenter', edge: edgeRefs(ctx, tp, [a.edge], 'edge')[0] }, a.name);
      if (a.type === 'face_center') return F.addRefPoint(store, { kind: 'faceCenter', face: faceRefs(ctx, tp, [a.face], 'face')[0] }, a.name);
      throw new Error('reference_point: unknown type');
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

/**
 * Execute a feature tool. `finish` is the executor's normal result step
 * (regenerate, report ok/errors and exact mass properties).
 */
export async function executeFeatureTool(ctx: ExecutorContext, name: string, a: Args, finish: (featureId?: string, extra?: Args) => Promise<unknown>): Promise<unknown> {
  if (name === 'get_topology') return getTopology(ctx, a);
  if (name === 'list_hole_sizes') {
    const sizes = holeSizes(a.standard, a.hole_type);
    if (!a.size) return { standard: a.standard, hole_type: a.hole_type, sizes };
    const s = holeSpec(a.standard, a.hole_type, String(a.size), a.fit);
    return { standard: a.standard, hole_type: a.hole_type, size: a.size, values_in: s.unit, ...s };
  }
  // One undo step per tool call, even when a command does several things.
  const id = await run(ctx, name, a);
  return finish(id, { feature_id: id, name: ctx.store.feature(id)?.name });
}

async function getTopology(ctx: ExecutorContext, a: Args) {
  const t = await topo(ctx);
  const doc = ctx.store.state;
  const k = MM_PER[doc.units];
  const nameOf = (fid: string) => doc.features.find((f) => f.id === fid)?.name;
  const keep = new Set<number>();
  t.faces.forEach((f, i) => { if (!a.feature_id || f.tags.some((x) => x.startsWith(`${a.feature_id}:`) || x.includes(`#${a.feature_id}.`))) keep.add(i); });
  const faces = t.faces.map((f, i) => ({ index: i, name: describeTag(f.tags[0], nameOf), surface: f.surface, center: f.center.map((c) => round(c / k)), ...(f.normal ? { normal: f.normal.map((c) => round(c)) } : {}) })).filter((f) => keep.has(f.index));
  const out: Args = { units: doc.units, face_count: t.faces.length, edge_count: t.edges.length, faces };
  if (a.include_edges !== false) {
    out.edges = t.edges.map((e, i) => ({ index: i, curve: e.curve, length: round(e.length / k), mid: e.mid.map((c) => round(c / k)), faces: e.faces }))
      .filter((e) => e.faces.some((f) => keep.has(f)));
  }
  return out;
}

/** Short summary of a modelling feature for get_model_state. */
export function summarizeModelingFeature(f: ModelingFeature, base: Args): Args {
  const { id: _i, type: _t, name: _n, suppressed: _s, ...rest } = f as Feature & Args;
  const compact = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(compact);
    if (v && typeof v === 'object') {
      const o = v as Args;
      if (Array.isArray(o.tags)) return { face: o.tags[0] };
      if (Array.isArray(o.a) && Array.isArray(o.b)) return { edge_between: [o.a[0], o.b[0]] };
      return Object.fromEntries(Object.entries(o).map(([key, x]) => [key, compact(x)]));
    }
    return v;
  };
  return { ...base, ...(compact(rest) as Args) };
}
