/**
 * Executes Claude's tool calls against the document through the same
 * DocumentStore commands the toolbar uses. DOM-free (portable to mobile).
 *
 * After every modelling tool the part is regenerated and the result
 * (success or the kernel's error, plus exact volume) is returned to Claude,
 * so it can verify its own work instead of assuming.
 */
import type { DocumentStore } from '../core/store';
import type { SketchEntity, ValueExpr, Feature, RevolveFeature, ExtrudeFeature, PlaneSpec } from '../core/model';
import { faceRefFrom, edgeRefFrom } from '../kernel/naming';
import { newId, rectangleEntities, centerRectangleEntities, MATERIALS, featureDependencies } from '../core/model';
import { formatLength, MM_PER, evalLength } from '../core/units';
import { resolveParams } from '../core/store';
import type { FeatureStatus } from '../kernel/regen';
import type { RegenResponse, SubRef, SelRef } from '../kernel/protocol';
import type { EntityInfo } from '../kernel/query';
import type { PartQuality } from '../kernel/quality';
import type { Topology } from '../kernel/naming';
import { getReference } from './references';
import TOOLS from './tools.json';
import { FEATURE_TOOL_DEFS, FEATURE_TOOL_NAMES, executeFeatureTool, summarizeModelingFeature, convertPicks } from './featureTools';
import { resolveFeatureRef } from './refs';
import BATCH_TOOLS from './batchTool.json';
import { ORGANIC_TOOL_DEFS, ORGANIC_TOOL_NAMES, executeOrganicTool } from './organicTools';

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
export const TOOL_DEFS: ToolDef[] = [...(TOOLS as ToolDef[]), ...FEATURE_TOOL_DEFS, ...ORGANIC_TOOL_DEFS, ...(BATCH_TOOLS as ToolDef[])];
export { resolveFeatureRef };

export interface ExecutorContext {
  store: DocumentStore;
  /**
   * Inside build_model: tools skip the regenerate-and-report step (one
   * regeneration at the end instead of one per step).
   */
  deferResults?: boolean;
  /** Regenerate the part. topology false: face/edge names are not needed (faster). */
  regen: (opts?: { topology?: boolean; mass?: boolean }) => Promise<RegenResponse>;
  selection: () => SelRef[];
  /** Feature ids selected in the feature tree (optional). */
  selectedFeatures?: () => string[];
  info: (ref: SubRef) => Promise<EntityInfo>;
  /** Shaded renders of the current part (base64 PNG), for view_model. Absent outside the app (tests). */
  snapshot?: (views: string[], size: number, edges: boolean) => Promise<{ view: string; png: string }[]>;
  /** Printability / CAM check of the last regenerated part (check_part, build_model report). */
  quality?: () => Promise<PartQuality>;
  /**
   * Face names and edges of the part just before a feature (the part it is
   * applied to), without changing the current part. update_feature uses it to
   * re-pick a feature's edges and faces.
   */
  topologyBefore?: (featureId: string) => Promise<Topology | null>;
}

type Args = Record<string, any>;

const isValue = (v: unknown): v is ValueExpr => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');

function req(a: Args, key: string, ctx: string): ValueExpr {
  const v = a[key];
  if (!isValue(v)) throw new Error(`${ctx}: "${key}" is required (number or expression)`);
  return v;
}

/** Convert the tool's friendly entity format into sketch entities. */
export function toEntities(list: Args[]): SketchEntity[] {
  if (!Array.isArray(list)) throw new Error('entities must be an array');
  const out: SketchEntity[] = [];
  list.forEach((e, i) => {
    const where = `entity ${i} (${e?.type})`;
    let ents: SketchEntity[];
    switch (e?.type) {
      case 'rectangle': {
        const x = req(e, 'x', where), y = req(e, 'y', where), w = req(e, 'width', where), h = req(e, 'height', where);
        ents = e.centered ? centerRectangleEntities(x, y, w, h) : rectangleEntities(x, y, w, h);
        break;
      }
      case 'circle':
        ents = [{ id: newId('ci'), kind: 'circle', center: { x: req(e, 'cx', where), y: req(e, 'cy', where) }, radius: `(${req(e, 'diameter', where)})/2` }];
        break;
      case 'line':
        ents = [{ id: newId('ln'), kind: 'line', p1: { x: req(e, 'x1', where), y: req(e, 'y1', where) }, p2: { x: req(e, 'x2', where), y: req(e, 'y2', where) } }];
        break;
      case 'arc':
        ents = [{ id: newId('ar'), kind: 'arc', center: { x: req(e, 'cx', where), y: req(e, 'cy', where) }, radius: req(e, 'radius', where), startAngle: req(e, 'start_angle', where), endAngle: req(e, 'end_angle', where) }];
        break;
      case 'polygon': {
        const pts = e.points;
        if (!Array.isArray(pts) || pts.length < 3) throw new Error(`${where}: points needs at least 3 [x,y] pairs`);
        ents = pts.map((p: unknown[], k: number) => {
          const q = pts[(k + 1) % pts.length] as unknown[];
          if (!isValue(p?.[0]) || !isValue(p?.[1]) || !isValue(q?.[0]) || !isValue(q?.[1])) throw new Error(`${where}: point ${k} is not [x,y]`);
          return { id: newId('ln'), kind: 'line', p1: { x: p[0] as ValueExpr, y: p[1] as ValueExpr }, p2: { x: q[0] as ValueExpr, y: q[1] as ValueExpr } } as SketchEntity;
        });
        break;
      }
      case 'spline': {
        const pts = e.points;
        if (!Array.isArray(pts) || pts.length < (e.closed ? 3 : 2)) throw new Error(`${where}: points needs at least ${e.closed ? 3 : 2} [x,y] pairs`);
        const points = pts.map((p: unknown[], k: number) => {
          if (!isValue(p?.[0]) || !isValue(p?.[1])) throw new Error(`${where}: point ${k} is not [x,y]`);
          return { x: p[0] as ValueExpr, y: p[1] as ValueExpr };
        });
        ents = [{ id: newId('sp'), kind: 'spline', points, ...(e.closed ? { closed: true } : {}), ...(e.uniform ? { uniform: true } : {}) }];
        break;
      }
      case 'oval': {
        ents = [{ id: newId('sp'), kind: 'spline', closed: true, uniform: true, points: ovalPoints(e, where) }];
        break;
      }
      case 'slot': {
        // Straight slot: two semicircular ends joined by two tangent lines.
        const x1 = req(e, 'x1', where), y1 = req(e, 'y1', where), x2 = req(e, 'x2', where), y2 = req(e, 'y2', where), w = req(e, 'width', where);
        ents = slotEntities(x1, y1, x2, y2, w);
        break;
      }
      default:
        throw new Error(`${where}: unknown entity type`);
    }
    if (e.construction) ents = ents.map((x) => ({ ...x, construction: true }));
    out.push(...ents);
  });
  return out;
}

/**
 * A smooth closed oval as a closed spline: an ellipse (squareness 2, default)
 * or a superellipse |x/rx|^n + |y/ry|^n = 1 (n = 3..6: rounded rectangle),
 * rotated by `rotation` degrees about its center. Numbers stay numbers;
 * expressions (parameters) stay expressions, so the oval follows them.
 */
export function ovalPoints(e: Args, where = 'oval'): { x: ValueExpr; y: ValueExpr }[] {
  const cx = isValue(e.cx) ? e.cx : 0, cy = isValue(e.cy) ? e.cy : 0;
  const rx = req(e, 'rx', where), ry = req(e, 'ry', where);
  const n = e.squareness === undefined ? 2 : Number(e.squareness);
  if (!(n >= 1.5 && n <= 12)) throw new Error(`${where}: squareness must be between 1.5 and 12 (2 = ellipse)`);
  const rot = e.rotation === undefined ? 0 : (Number(e.rotation) * Math.PI) / 180;
  if (!Number.isFinite(rot)) throw new Error(`${where}: rotation must be a number of degrees`);
  // Always 24 points: ovals of any squareness share one knot vector, so lofts through them take the exact smooth path.
  const N = 24;
  const r9 = (v: number) => +v.toFixed(9);
  const lin = (c: ValueExpr, terms: [ValueExpr, number][]): ValueExpr => {
    if (typeof c === 'number' && terms.every(([v]) => typeof v === 'number')) return r9(c + terms.reduce((s, [v, k]) => s + (v as number) * k, 0));
    return [`(${c})`, ...terms.filter(([, k]) => k !== 0).map(([v, k]) => `(${v})*(${r9(k)})`)].join(' + ');
  };
  const out: { x: ValueExpr; y: ValueExpr }[] = [];
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    const c = Math.cos(t), s = Math.sin(t);
    const a = Math.sign(c) * Math.abs(c) ** (2 / n), b = Math.sign(s) * Math.abs(s) ** (2 / n);
    // (rx*a, ry*b) rotated by rot
    out.push({ x: lin(cx, [[rx, a * Math.cos(rot)], [ry, -b * Math.sin(rot)]]), y: lin(cy, [[rx, a * Math.sin(rot)], [ry, b * Math.cos(rot)]]) });
  }
  return out;
}

/**
 * Straight slot. The centerline direction must be known numerically to place
 * the tangent lines exactly, so endpoints must be plain numbers; the width may
 * be an expression.
 */
function slotEntities(x1: ValueExpr, y1: ValueExpr, x2: ValueExpr, y2: ValueExpr, w: ValueExpr): SketchEntity[] {
  if (![x1, y1, x2, y2].every((v) => typeof v === 'number')) throw new Error('slot: endpoints must be plain numbers (use parameters in rectangle/circle entities instead)');
  const [ax, ay, bx, by] = [x1, y1, x2, y2] as number[];
  const len = Math.hypot(bx - ax, by - ay);
  if (!(len > 0)) throw new Error('slot: endpoints must differ');
  const a = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
  const r = `(${w})/2`;
  const nx = -(by - ay) / len, ny = (bx - ax) / len; // unit normal
  const off = (px: number, py: number, s: number) => ({ x: `${px} + ${s * nx}*${r}`, y: `${py} + ${s * ny}*${r}` });
  return [
    { id: newId('ln'), kind: 'line', p1: off(ax, ay, -1), p2: off(bx, by, -1) },
    { id: newId('ar'), kind: 'arc', center: { x: bx, y: by }, radius: r, startAngle: a - 90, endAngle: a + 90 },
    { id: newId('ln'), kind: 'line', p1: off(bx, by, 1), p2: off(ax, ay, 1) },
    { id: newId('ar'), kind: 'arc', center: { x: ax, y: ay }, radius: r, startAngle: a + 90, endAngle: a + 270 },
  ];
}

/** Parameter names referenced anywhere in a feature's expressions. */
function paramsUsed(f: Feature, names: string[]): string[] {
  if (!names.length) return [];
  const text: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') text.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'id' && k !== 'name' && k !== 'sketch' && k !== 'axisLine') walk(x); });
  };
  walk(f);
  const idents = new Set(text.join(' ').match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []);
  return names.filter((n) => idents.has(n));
}

/** Where a feature is and how big it is, in document units (exact B-rep box). */
function extentSummary(st: FeatureStatus | undefined, units: 'in' | 'mm') {
  if (!st?.extent) return undefined;
  const k = MM_PER[units];
  const r = (v: number) => +(v / k).toFixed(6);
  const { min, max } = st.extent;
  return {
    size: { x: r(max[0] - min[0]), y: r(max[1] - min[1]), z: r(max[2] - min[2]) },
    min: min.map(r), max: max.map(r), center: min.map((v, i) => r((v + max[i]) / 2)),
  };
}

function summarizeFeature(f: Feature, status: FeatureStatus | undefined, doc: { units: 'in' | 'mm'; features: Feature[]; params: { name: string }[] }) {
  const used = paramsUsed(f, doc.params.map((p) => p.name));
  const extent = extentSummary(status, doc.units);
  const base: Args = {
    id: f.id, type: f.type, name: f.name, ok: status?.ok ?? true,
    ...(status?.message ? { message: status.message } : {}), ...(f.suppressed ? { suppressed: true } : {}),
    ...(extent ? { extent } : {}), ...(used.length ? { parameters_used: used } : {}),
  };
  if (f.type === 'sketch') {
    const usedBy = doc.features.filter((x) => (x.type === 'extrude' || x.type === 'revolve') && x.sketch === f.id).map((x) => x.name);
    return { ...base, plane: f.plane, offset: f.offset ?? 0, ...(usedBy.length ? { used_by: usedBy } : {}), entities: f.entities };
  }
  if (f.type !== 'extrude' && f.type !== 'revolve') return summarizeModelingFeature(f, base);
  const sketchName = doc.features.find((x) => x.id === f.sketch)?.name;
  if (f.type === 'extrude') return { ...base, sketch: f.sketch, sketch_name: sketchName, depth: f.depth, direction: f.direction, operation: f.operation, through_all: !!f.throughAll, ...(f.depth2 !== undefined ? { depth2: f.depth2 } : {}), ...(f.throughAll2 ? { through_all2: true } : {}),
    ...(f.upTo ? { up_to: f.upTo } : {}), ...(f.startOffset !== undefined ? { start_offset: f.startOffset, start_offset_reverse: !!f.startOffsetReverse } : {}),
    ...(f.draft !== undefined ? { draft: f.draft, draft_outward: !!f.draftOutward } : {}), ...(f.flipSide ? { flip_side: true } : {}), ...(f.thin ? { thin: f.thin } : {}) };
  return {
    ...base, sketch: f.sketch, sketch_name: sketchName, axis_line: f.axisLine, angle: f.angle, operation: f.operation,
    ...(f.end === 'midPlane' ? { end: 'midPlane' } : {}), ...(f.reverse ? { reverse: true } : {}),
    ...(f.angle2 !== undefined ? { angle2: f.angle2 } : {}), ...(f.thin ? { thin: f.thin } : {}),
  };
}

/** Validate a thin-feature argument from the AI (see the revolve tool schema). */
function revolveThin(t: Args): NonNullable<RevolveFeature['thin']> {
  const type = t?.type ?? 'oneDirection';
  if (!['oneDirection', 'midPlane', 'twoDirection'].includes(type)) throw new Error('revolve: thin.type must be oneDirection, midPlane or twoDirection');
  if (!isValue(t.thickness)) throw new Error('revolve: thin.thickness is required');
  if (type === 'twoDirection' && !isValue(t.thickness2)) throw new Error('revolve: thin.thickness2 is required for twoDirection');
  return { type, thickness: t.thickness, ...(type === 'twoDirection' ? { thickness2: t.thickness2 } : {}), ...(t.reverse ? { reverse: true } : {}) };
}

function paramSummary(doc: { params: { name: string; expr: string }[]; units: 'in' | 'mm' }) {
  let vals: ReturnType<typeof resolveParams> = {};
  try { vals = resolveParams(doc as any); } catch { /* errors show per feature */ }
  return doc.params.map((p) => {
    const q = vals[p.name];
    const value = !q ? undefined : q.dim === 'length' ? formatLength(q.v, doc.units, 6) : q.dim === 'angle' ? `${+((q.v * 180) / Math.PI).toFixed(6)} deg` : +q.v.toFixed(9);
    return { name: p.name, expr: p.expr, ...(value !== undefined ? { value } : {}) };
  });
}

function massSummary(r: RegenResponse, units: 'in' | 'mm', density?: number) {
  if (!r.mass) return null;
  const m = r.mass, k = MM_PER[units];
  const grams = density ? (m.volume / 1000) * density : null;
  return {
    ...(grams !== null ? { mass: units === 'in' ? `${(grams / 453.59237).toFixed(6)} lb` : `${grams.toFixed(4)} g` } : {}),
    volume: `${(m.volume / k ** 3).toFixed(6)} ${units}^3`,
    surface_area: `${(m.area / k ** 2).toFixed(6)} ${units}^2`,
    bounding_box: {
      x: formatLength(m.bboxMax[0] - m.bboxMin[0], units, 6), y: formatLength(m.bboxMax[1] - m.bboxMin[1], units, 6), z: formatLength(m.bboxMax[2] - m.bboxMin[2], units, 6),
      min: m.bboxMin.map((v) => +(v / k).toFixed(6)), max: m.bboxMax.map((v) => +(v / k).toFixed(6)),
    },
    center_of_mass: m.centroid.map((v) => +(v / k).toFixed(6)),
  };
}

/** The part quality check in document units, for check_part and the build_model report. */
function qualitySummary(q: PartQuality, units: 'in' | 'mm') {
  const k = MM_PER[units];
  const good = q.problems.length === 0;
  return {
    verdict: good ? (q.warnings.length ? 'good part, with warnings' : 'good part') : 'NOT a good part yet: fix the problems',
    one_solid: q.solids === 1,
    closed_valid_solid: q.valid && q.freeEdges === 0,
    watertight_stl: q.meshOpenEdges === 0,
    step_for_cam: q.stepRoundTrip,
    flat_base: q.base ? { size: q.base.size.map((v) => +(v / k).toFixed(4)), area: `${(q.base.area / k ** 2).toFixed(4)} ${units}^2`, centre_of_mass_over_base: q.base.comInside } : null,
    overhang_percent: q.surfaceArea > 0 ? Math.round((100 * q.overhangArea) / q.surfaceArea) : 0,
    ...(q.problems.length ? { problems: q.problems } : {}),
    ...(q.warnings.length ? { warnings: q.warnings } : {}),
  };
}

async function result(ctx: ExecutorContext, featureId?: string, extra: Args = {}) {
  if (ctx.deferResults) return { ...extra, ...(featureId ? { feature_id: featureId } : {}) };
  const r = await ctx.regen();
  const units = ctx.store.state.units;
  const out: Args = { ...extra };
  if (featureId) {
    const st = r.status.find((s) => s.id === featureId);
    out.feature_id = featureId;
    out.ok = st?.ok ?? false;
    if (st?.message) out.message = st.message;
    const ext = extentSummary(st, units);
    if (ext) out.feature_extent = ext;
  }
  const failed = r.status.filter((s) => !s.ok);
  if (failed.length) out.errors = failed.map((s) => ({ feature_id: s.id, message: s.message }));
  out.part = massSummary(r, units, ctx.store.state.material?.density);
  return out;
}

/** Argument keys that hold a feature/sketch id (a single id or a list). */
const ID_KEYS = new Set(['sketch_id', 'feature_id', 'profile_sketch_id', 'path_sketch_id', 'ref_plane_id', 'ref_axis_id']);
const ID_LIST_KEYS = new Set(['profile_sketch_ids', 'features']);

function resolveIds(store: DocumentStore, a: unknown): any {
  if (Array.isArray(a)) return a.map((x) => resolveIds(store, x));
  if (!a || typeof a !== 'object') return a;
  const out: Args = {};
  for (const [k, v] of Object.entries(a as Args)) {
    if (ID_KEYS.has(k)) out[k] = resolveFeatureRef(store, v);
    else if (ID_LIST_KEYS.has(k) && Array.isArray(v)) out[k] = v.map((x) => resolveFeatureRef(store, x));
    else if (k === 'entities' || k === 'points' || k === 'changes' || k === 'steps') out[k] = v; // geometry / handled per step
    else out[k] = resolveIds(store, v);
  }
  return out;
}

export async function executeTool(ctx: ExecutorContext, name: string, args: Args): Promise<unknown> {
  const { store } = ctx;
  if (name === 'build_model') return buildModel(ctx, args);
  const a: Args = resolveIds(store, args ?? {});
  switch (name) {
    case 'check_part': {
      if (!ctx.quality) throw new Error('check_part: only available in the app');
      const r = await ctx.regen({ topology: false, mass: false });
      if (!r.status.length || r.status.every((s) => !s.ok)) return { ok: false, message: 'There is no part yet.' };
      const q = await ctx.quality();
      return { ok: q.problems.length === 0, ...qualitySummary(q, store.state.units) };
    }
    case 'get_reference': {
      const subject = String(a.subject ?? '').trim();
      if (!subject) throw new Error('get_reference: "subject" is required (e.g. "easter island head")');
      const h = a.height === undefined ? undefined : Number(a.height);
      if (h !== undefined && !(h > 0)) throw new Error('get_reference: height must be a positive number in document units');
      return getReference(subject, h, store.state.units);
    }
    case 'view_model': {
      if (!ctx.snapshot) throw new Error('view_model: rendering is only available in the app');
      const views: string[] = Array.isArray(a.views) && a.views.length ? a.views.slice(0, 6) : ['front', 'right', 'three_quarter'];
      const size = Math.round(Math.min(1024, Math.max(256, Number(a.size) || 640)));
      const shots = await ctx.snapshot(views, size, a.edges !== false);
      if (!shots.length) return { ok: false, message: 'The part has no solid body yet: nothing to look at.' };
      return {
        ok: true,
        views: shots.map((s) => s.view),
        note: 'Images follow in this order. Front looks at the -Y side (the face), right looks from +X, top from +Z.',
        images: shots.map((s) => ({ data: s.png, mimeType: 'image/png' })),
      };
    }
    case 'get_model_state': {
      const r = await ctx.regen();
      const doc = store.state;
      const statusById = new Map(r.status.map((s) => [s.id, s]));
      const sel = ctx.selection();
      const selection = [];
      const PLANE_NAMES = { XZ: 'Front Plane', XY: 'Top Plane', YZ: 'Right Plane' } as const;
      for (const ref of sel.slice(0, 4)) {
        if (ref.kind === 'plane') { selection.push({ kind: 'plane', plane: ref.plane, name: PLANE_NAMES[ref.plane] }); continue; }
        try { selection.push({ ...ref, ...(await ctx.info(ref)) }); } catch { /* stale */ }
      }
      return {
        name: doc.name, units: doc.units, ...(doc.material ? { material: doc.material } : {}), note: 'Internal geometry is exact (mm doubles). Lengths below are in document units unless they carry a unit.',
        parameters: paramSummary(doc), rollback: doc.rollback,
        orientation: 'Front view looks along +Y (viewer at -Y). Left = -X, right = +X, front = -Y, back = +Y, top = +Z, bottom = -Z.',
        features: doc.features.map((f) => summarizeFeature(f, statusById.get(f.id), doc)),
        part: massSummary(r, doc.units, doc.material?.density),
        selection: selection.map((s) => convertInfo(s, doc.units)),
        selected_features: (ctx.selectedFeatures?.() ?? []).flatMap((id) => {
          const f = store.feature(id);
          return f ? [{ id: f.id, name: f.name, type: f.type }] : [];
        }),
      };
    }
    case 'set_units': store.setUnits(a.units); return result(ctx);
    case 'set_part_name': store.renameDocument(String(a.name)); return result(ctx, undefined, { name: store.state.name });
    case 'set_material': {
      const known = MATERIALS.find((m) => m.name.toLowerCase() === String(a.name).toLowerCase());
      const density = typeof a.density === 'number' ? a.density : known?.density;
      if (!(typeof density === 'number' && density > 0)) throw new Error(`Unknown material "${a.name}": give its density in g/cm^3`);
      store.setMaterial({ name: known && a.density === undefined ? known.name : String(a.name), density });
      return result(ctx);
    }
    case 'set_parameter': {
      const name = String(a.name);
      store.setParameter(name, String(a.value));
      if (ctx.deferResults) return result(ctx, undefined, { parameter: name });
      const out = await result(ctx);
      // Report the features this parameter drives (directly or through other parameters), with their new extents.
      const doc = store.state;
      const names = doc.params.map((p) => p.name);
      const driven = new Set([name]);
      for (let grew = true; grew;) {
        grew = false;
        for (const p of doc.params) {
          if (driven.has(p.name)) continue;
          const ids = new Set(p.expr.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []);
          if ([...driven].some((d) => ids.has(d))) { driven.add(p.name); grew = true; }
        }
      }
      const r = await ctx.regen();
      const direct = new Set(doc.features.filter((f) => paramsUsed(f, names).some((n) => driven.has(n))).map((f) => f.id));
      // A feature built from a driven sketch changes too.
      for (const f of doc.features) if ((f.type === 'extrude' || f.type === 'revolve') && direct.has(f.sketch)) direct.add(f.id);
      out.affected_features = doc.features
        .filter((f) => direct.has(f.id))
        .map((f) => ({ name: f.name, id: f.id, ...(extentSummary(r.status.find((x) => x.id === f.id), doc.units) ? { extent: extentSummary(r.status.find((x) => x.id === f.id), doc.units) } : {}) }));
      return out;
    }
    case 'create_sketch': {
      const entities = toEntities(a.entities ?? []);
      const id = store.transaction('Add sketch', () => {
        const sid = store.addSketch(a.plane, entities, { ...(a.name ? { name: a.name } : {}), ...(isValue(a.offset) ? { offset: a.offset } : {}) });
        // Sketch on a reference plane (see the reference_plane tool).
        if (a.ref_plane_id) store.updateFeature(sid, { refPlane: String(a.ref_plane_id) });
        return sid;
      });
      return result(ctx, id, { sketch_id: id, entity_ids: entities.map((e) => ({ id: e.id, kind: e.kind, construction: !!e.construction })) });
    }
    case 'add_to_sketch': {
      const entities = toEntities(a.entities ?? []);
      store.addSketchEntities(a.sketch_id, entities);
      return result(ctx, a.sketch_id, { entity_ids: entities.map((e) => ({ id: e.id, kind: e.kind })) });
    }
    case 'extrude': {
      const upTo = await extrudeUpTo(ctx, a);
      if (!a.through_all && !upTo && !isValue(a.depth)) throw new Error('extrude: depth is required unless through_all, up_to_vertex or up_to_surface is given');
      const id = store.addExtrude(a.sketch_id, isValue(a.depth) ? a.depth : 0, {
        ...(a.operation ? { operation: a.operation } : {}), ...(a.direction ? { direction: a.direction } : {}),
        ...(a.through_all ? { throughAll: true } : {}), ...(a.name ? { name: a.name } : {}),
        ...(isValue(a.depth2) ? { depth2: a.depth2 } : {}), ...(a.through_all2 ? { throughAll2: true } : {}),
        ...(upTo ? { upTo } : {}),
        ...(isValue(a.start_offset) ? { startOffset: a.start_offset } : {}), ...(a.start_offset_reverse ? { startOffsetReverse: true } : {}),
        ...(isValue(a.draft) ? { draft: a.draft } : {}), ...(a.draft_outward ? { draftOutward: true } : {}),
        ...(a.flip_side ? { flipSide: true } : {}),
        ...(a.thin ? { thin: revolveThin(a.thin) } : {}),
      });
      return result(ctx, id);
    }
    case 'revolve': {
      let axis = a.axis_line_id;
      if (!axis) {
        const sk = store.feature(a.sketch_id);
        const lines = sk?.type === 'sketch' ? sk.entities.filter((e) => e.kind === 'line' && e.construction) : [];
        if (lines.length !== 1) throw new Error(`revolve: give axis_line_id (the sketch has ${lines.length} construction lines)`);
        axis = lines[0].id;
      }
      const id = store.addRevolve(a.sketch_id, axis, isValue(a.angle) ? a.angle : 360, {
        ...(a.operation ? { operation: a.operation } : {}), ...(a.name ? { name: a.name } : {}),
        ...(a.end === 'midPlane' ? { end: 'midPlane' as const } : {}), ...(a.reverse ? { reverse: true } : {}),
        ...(isValue(a.angle2) ? { angle2: a.angle2 } : {}), ...(a.thin ? { thin: revolveThin(a.thin) } : {}),
      });
      return result(ctx, id);
    }
    case 'update_feature': {
      const changes: Args = { ...(a.changes ?? {}) };
      if (changes.through_all !== undefined) { changes.throughAll = changes.through_all; delete changes.through_all; }
      if (changes.through_all2 !== undefined) { changes.throughAll2 = changes.through_all2; delete changes.through_all2; }
      if (changes.axis_line_id !== undefined) { changes.axisLine = changes.axis_line_id; delete changes.axis_line_id; }
      for (const [from, to] of [['start_offset', 'startOffset'], ['start_offset_reverse', 'startOffsetReverse'], ['draft_outward', 'draftOutward'], ['flip_side', 'flipSide']] as const) {
        if (changes[from] !== undefined) { changes[to] = changes[from] === false ? null : changes[from]; delete changes[from]; }
      }
      if (Array.isArray(changes.entities) && changes.entities.some((e: Args) => e && 'type' in e)) changes.entities = toEntities(changes.entities);
      // Edge / face / plane / axis picks become stored references, as when the feature was made.
      store.updateFeature(a.feature_id, await convertPicks(ctx, a.feature_id, changes));
      return result(ctx, a.feature_id);
    }
    case 'delete_feature': {
      const f = store.feature(a.feature_id);
      if (!f) throw new Error(`No feature ${a.feature_id}`);
      // Like mainstream CAD "delete absorbed features": sketches only this feature used go with it (a loft's sections, an extrude's sketch).
      const absorbed = a.keep_sketches ? [] : featureDependencies(f).filter((dep) => {
        const d = store.feature(dep);
        return d?.type === 'sketch' && !store.state.features.some((x) => x.id !== f.id && featureDependencies(x).includes(dep));
      });
      const names = [f.name, ...absorbed.map((id) => store.feature(id)!.name)];
      store.transaction(`Delete ${f.name}`, () => {
        store.deleteFeature(f.id);
        for (const id of absorbed) if (store.feature(id)) store.deleteFeature(id);
      });
      return result(ctx, undefined, { deleted: names });
    }
    case 'undo': store.undo(); return result(ctx, undefined, { undone: true });
    default:
      if (FEATURE_TOOL_NAMES.has(name)) return executeFeatureTool(ctx, name, a, (id, extra) => result(ctx, id, extra));
      if (ORGANIC_TOOL_NAMES.has(name)) return executeOrganicTool(ctx, name, a, toEntities, (id, extra) => result(ctx, id, extra));
      throw new Error(`Unknown tool ${name}`);
  }
}

function convertInfo(i: Args, units: 'in' | 'mm') {
  const k = MM_PER[units];
  const L = (mm: number) => formatLength(mm, units, 6);
  if (i.kind === 'plane') return i;
  const out: Args = { kind: i.kind, index: i.index };
  for (const [key, v] of Object.entries(i)) {
    if (key === 'kind' || key === 'index') continue;
    if (['length', 'radius'].includes(key) && typeof v === 'number') out[key] = L(v);
    else if (key === 'area' && typeof v === 'number') out[key] = `${(v / k ** 2).toFixed(6)} ${units}^2`;
    else if (['start', 'end', 'center', 'origin', 'axisOrigin'].includes(key) && Array.isArray(v)) out[key] = v.map((c: number) => +(c / k).toFixed(6));
    else out[key] = v;
  }
  return out;
}

/** Tools a build_model step may not run (they read state, or would recurse / undo the batch itself). */
const NOT_IN_BATCH = new Set(['build_model', 'view_model', 'check_part', 'get_reference', 'get_model_state', 'get_topology', 'list_hole_sizes', 'undo']);

/**
 * build_model: run many tool calls in one request. Each step goes through the
 * same executeTool path (same validation, same named, editable features), but
 * the part is regenerated only when a step needs the solid (edge/face picks)
 * and once at the end, and Claude gets one compact report instead of one round
 * trip per feature.
 */
async function buildModel(ctx: ExecutorContext, a: Args) {
  const { store } = ctx;
  const steps = a.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error('build_model: steps must be a non-empty array of {tool, args}');
  if (steps.length > 400) throw new Error('build_model: at most 400 steps per call');
  const t0 = Date.now();
  let cacheDoc: unknown = null;
  let cache: RegenResponse | null = null;
  let cacheHasMass = false;
  const regen = async (o?: { topology?: boolean; mass?: boolean }) => {
    const wantMass = o?.mass !== false;
    if (!cache || store.state !== cacheDoc || (wantMass && !cacheHasMass)) {
      cacheDoc = store.state; cache = await ctx.regen(o); cacheHasMass = wantMass;
    }
    return cache;
  };
  // Mid-build regenerations only serve edge/face picks: no mass properties.
  const bctx: ExecutorContext = { ...ctx, deferResults: true, regen: (o) => regen({ ...o, mass: false }) };
  const before = new Set(store.state.features.map((f) => f.id));
  const log: Args[] = [];
  let stopped: Args | null = null;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] ?? {};
    const tool = String(st.tool ?? '');
    try {
      if (!tool) throw new Error('step has no "tool"');
      if (NOT_IN_BATCH.has(tool)) throw new Error(`${tool} cannot run inside build_model`);
      if (!TOOL_DEFS.some((t) => t.name === tool)) throw new Error(`unknown tool "${tool}"`);
      // Steps may be {tool, args} or flat {tool, ...args} (less nesting, fewer bracket slips).
      const args = st.args && typeof st.args === 'object' ? st.args : Object.fromEntries(Object.entries(st).filter(([k]) => k !== 'tool'));
      await executeTool(bctx, tool, args);
    } catch (e) {
      const nm = st.args?.name ?? st.name;
      const err = { step: i + 1, tool, ...(typeof nm === 'string' ? { name: nm } : {}), error: (e as Error).message };
      log.push(err);
      if (a.stop_on_error !== false) { stopped = err; break; }
    }
  }
  const r = await regen({ topology: false });
  const units = store.state.units;
  const statusById = new Map(r.status.map((s) => [s.id, s]));
  const made = store.state.features.filter((f) => !before.has(f.id));
  const short = (v: number[]) => v.map((x) => +x.toFixed(4));
  const features = made.map((f) => {
    const st = statusById.get(f.id);
    const ext = extentSummary(st, units);
    return {
      name: f.name, type: f.type, ok: st?.ok ?? false,
      ...(st?.message ? { message: st.message } : {}),
      ...(ext && f.type !== 'sketch' ? { size: short([ext.size.x, ext.size.y, ext.size.z]), center: short(ext.center) } : {}),
    };
  });
  const failed = r.status.filter((s) => !s.ok);
  // Is it a good part (one closed solid, watertight STL, clean STEP)? Checked on every whole build.
  let quality: ReturnType<typeof qualitySummary> | null = null;
  if (ctx.quality && r.mass && a.check !== false) {
    try { quality = qualitySummary(await ctx.quality(), units); } catch { quality = null; }
  }
  const ok = !stopped && !log.length && !failed.length;
  const message = stopped ? `Stopped at step ${stopped.step} (${stopped.name ?? stopped.tool}): ${stopped.error}`
    : log.length ? `${log.length} step(s) failed: ${log.map((l) => `${l.name ?? l.tool}: ${l.error}`).join('; ')}`
    : failed.length ? `${failed.length} feature(s) failed to rebuild: ${failed.map((s) => `${store.feature(s.id)?.name ?? s.id}: ${s.message}`).join('; ')}` : undefined;
  return {
    ok,
    ...(message ? { message } : {}),
    steps_run: stopped ? stopped.step - 1 : steps.length, steps_total: steps.length,
    ...(stopped ? { stopped_at: stopped, note: 'Steps before this one were applied. Fix this step and send it with the remaining steps.' } : {}),
    ...(log.length && !stopped ? { step_errors: log } : {}),
    features,
    ...(failed.length ? { errors: failed.map((s) => ({ feature: store.feature(s.id)?.name ?? s.id, message: s.message })) } : {}),
    part: massSummary(r, units, store.state.material?.density),
    ...(quality ? { quality } : {}),
    seconds: +((Date.now() - t0) / 1000).toFixed(2),
  };
}

/** Extrude end condition from AI arguments (up_to_vertex / up_to_surface). */
async function extrudeUpTo(ctx: ExecutorContext, a: Args): Promise<ExtrudeFeature['upTo'] | undefined> {
  if (a.up_to_vertex && a.up_to_surface) throw new Error('extrude: give up_to_vertex or up_to_surface, not both');
  const topology = async () => {
    const r = await ctx.regen();
    if (!r.topology) throw new Error('extrude: there is no solid yet to pick a face or edge on');
    return r.topology;
  };
  if (a.up_to_vertex) {
    const v = a.up_to_vertex as Args;
    if (v.ref_point_id) return { kind: 'vertex', vertex: { refPoint: String(resolveFeatureRef(ctx.store, v.ref_point_id)) } };
    if (!v.edge || !Number.isInteger(v.edge.index)) throw new Error('up_to_vertex: give {ref_point_id} or {edge:{index}, near:[x,y,z]}');
    const t = await topology();
    const e = t.edges[v.edge.index];
    if (!e?.ends) throw new Error(`up_to_vertex: no edge ${v.edge.index}`);
    const params = resolveParams(ctx.store.state);
    const near = Array.isArray(v.near) ? v.near.map((x: ValueExpr) => evalLength(x, ctx.store.state.units, params)) as [number, number, number] : e.ends[0];
    const d2 = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
    const at = d2(near, e.ends[1]) < d2(near, e.ends[0]) ? e.ends[1] : e.ends[0];
    return { kind: 'vertex', vertex: { edge: edgeRefFrom(t, v.edge.index), at } };
  }
  if (a.up_to_surface) {
    const p = a.up_to_surface as Args;
    let surface: PlaneSpec;
    if (p.ref_plane_id) surface = { refPlane: String(resolveFeatureRef(ctx.store, p.ref_plane_id)) };
    else if (p.face && Number.isInteger(p.face.index)) {
      const t = await topology();
      const f = t.faces[p.face.index];
      if (!f) throw new Error(`up_to_surface: no face ${p.face.index}`);
      if (f.surface !== 'plane') throw new Error('up_to_surface: the face must be flat');
      surface = { face: faceRefFrom(t, p.face.index) };
    } else if (p.plane === 'XY' || p.plane === 'XZ' || p.plane === 'YZ') surface = { base: p.plane, ...(isValue(p.offset) ? { offset: p.offset } : {}) };
    else throw new Error('up_to_surface: give {plane, offset}, {ref_plane_id} or {face:{index}}');
    return { kind: 'surface', surface, ...(isValue(a.surface_offset) ? { offset: a.surface_offset } : {}), ...(a.reverse_offset ? { reverseOffset: true } : {}) };
  }
  if (isValue(a.surface_offset)) throw new Error('extrude: surface_offset needs up_to_surface');
  return undefined;
}
