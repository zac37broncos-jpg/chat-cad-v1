/**
 * Sketch solver: maps our sketch model onto FreeCAD's planegcs constraint
 * solver (WebAssembly, npm @salusoft89/planegcs, LGPL-2.1+, used unmodified
 * as a separate library), solves, and verifies the result with our own
 * equations (equations.ts). A solve is only reported ok when every driving
 * constraint holds to RESIDUAL_TOL; otherwise the caller must treat the
 * sketch as failed, never as "close enough".
 */
import type { GcsWrapper, SketchPrimitive } from '@salusoft89/planegcs';
import type { PointRef, SketchConstraint } from '../core/model';
import { isDimension } from '../core/model';
import { type P2, type WEntity, type WSketch, entityMap, constraintRefs, isBuiltin, pointOf, wrap2pi, arcSweep, TAU } from './geom';
import { RESIDUAL_TOL, angleTarget, curveNormal, tangentPoints, constraintSign, makeContext, maxResidual, offsetPairSign, analyze, type Analysis } from './equations';

/** planegcs numeric codes (from its enums.ts) kept local so this file does not import the WASM module. */
const ALG = { BFGS: 0, LevenbergMarquardt: 1, DogLeg: 2 } as const;
const STATUS_OK = new Set([0, 1]); // Success, Converged

export type SketchState = 'empty' | 'under' | 'full' | 'over' | 'failed';

/** A temporary pull used while dragging: the solver moves toward it as far as the constraints allow. */
export type DragTarget =
  | { ref: PointRef; to: P2 }
  | { radiusOf: string; to: number };

export interface SolveResult {
  ok: boolean;
  entities: WEntity[];
  /** Constraint ids planegcs reports as conflicting / redundant. */
  conflicting: string[];
  redundant: string[];
  /** planegcs degrees of freedom (counted on the system it solved). */
  dof: number;
  maxResidual: number;
  message?: string;
}

export interface SketchStatus { state: SketchState; dof: number; message?: string }

/** Owns one planegcs system. Create with createSketchSolver(). Not thread safe; one per worker/UI. */
export class SketchSolver {
  constructor(private gcs: GcsWrapper) {
    gcs.debug_mode = 0; // NoDebug: planegcs otherwise prints to the console
    gcs.set_max_iterations(200);
    gcs.set_convergence_threshold(1e-14);
  }

  dispose() { this.gcs.destroy_gcs_module(); }

  /**
   * Solve the sketch starting from its current geometry. With `drag`
   * targets, pulls toward them (temporary constraints) for interactive
   * dragging; driving constraints still have priority.
   */
  solve(ws: WSketch, drag: DragTarget[] = []): SolveResult {
    // Splines are not solver geometry: solve the rest, keep splines exactly as given.
    if (ws.entities.some((e) => e.kind === 'spline')) {
      const sp = withoutSplines(ws);
      if (sp.error) return { ok: false, entities: ws.entities.map(cloneEnt), conflicting: [], redundant: [], dof: NaN, maxResidual: Infinity, message: sp.error };
      const r = this.solve(sp.rest, drag.filter((d) => !('ref' in d ? sp.ids.has(d.ref.e) : sp.ids.has(d.radiusOf))));
      return { ...r, entities: mergeSplines(ws.entities, r.entities) };
    }
    const base = ws.entities;
    if (!ws.constraints.some((c) => !(isDimension(c) && c.driven)) && !drag.length) {
      return { ok: true, entities: base.map(cloneEnt), conflicting: [], redundant: [], dof: NaN, maxResidual: 0 };
    }
    const prims = buildPrimitives(ws, drag);
    const algorithms = drag.length ? [ALG.DogLeg] : [ALG.DogLeg, ALG.LevenbergMarquardt, ALG.BFGS];
    let last: SolveResult | null = null;
    for (const alg of algorithms) {
      const g = this.gcs;
      g.clear_data();
      g.push_primitives_and_params(prims as SketchPrimitive[]);
      const status = g.solve(alg as any);
      g.apply_solution();
      const conflicting = uniq(g.get_gcs_conflicting_constraints().map(ownerId));
      const redundant = uniq(g.get_gcs_redundant_constraints().map(ownerId));
      const dof = g.gcs.dof();
      const solved = readBack(g, base);
      const out: WSketch = { ...ws, entities: solved };
      const ctx = makeContext(ws, base);
      let res: { max: number; worst?: string };
      try { res = maxResidual(out, ctx); } catch (e) { res = { max: Infinity, worst: (e as Error).message }; }
      const degenerate = degenerateMessage(solved);
      if (degenerate) res = { max: Infinity, worst: degenerate };
      const ok = STATUS_OK.has(status) && res.max <= RESIDUAL_TOL && !conflicting.length;
      last = {
        ok, entities: solved, conflicting, redundant, dof, maxResidual: res.max,
        ...(ok ? {} : { message: failureMessage(status, conflicting, res) }),
      };
      if (ok) return last;
      if (conflicting.length) break; // a different algorithm will not fix a contradiction
    }
    return { ...last!, entities: last!.ok ? last!.entities : base.map(cloneEnt) };
  }

  /** Solve, then classify the sketch as under / fully / over defined. */
  status(ws: WSketch): { result: SolveResult; status: SketchStatus; analysis: Analysis | null } {
    if (ws.entities.some((e) => e.kind === 'spline')) {
      const sp = withoutSplines(ws);
      if (sp.error) {
        const result = this.solve(ws);
        return { result, status: { state: 'failed', dof: NaN, message: sp.error }, analysis: null };
      }
      if (!sp.rest.entities.length) {
        // Only splines: fixed by their fit points.
        return { result: { ok: true, entities: ws.entities.map(cloneEnt), conflicting: [], redundant: [], dof: 0, maxResidual: 0 }, status: { state: 'full', dof: 0 }, analysis: null };
      }
      const r = this.status(sp.rest);
      return { ...r, result: { ...r.result, entities: mergeSplines(ws.entities, r.result.entities) } };
    }
    const result = this.solve(ws);
    if (!ws.entities.length) return { result, status: { state: 'empty', dof: 0 }, analysis: null };
    if (!result.ok) {
      return { result, status: { state: result.conflicting.length ? 'over' : 'failed', dof: NaN, message: result.message }, analysis: null };
    }
    const solved: WSketch = { ...ws, entities: result.entities };
    const analysis = analyze(solved, makeContext(ws, ws.entities));
    if (result.redundant.length || analysis.rank < analysis.equations) {
      const ids = result.redundant.length ? result.redundant.join(', ') : 'some relations';
      return { result, status: { state: 'over', dof: analysis.dof, message: `Redundant (already implied): ${ids}` }, analysis };
    }
    return { result, status: { state: analysis.dof === 0 ? 'full' : 'under', dof: analysis.dof }, analysis };
  }
}

export async function createSketchSolver(wasmUrl?: string): Promise<SketchSolver> {
  const { make_gcs_wrapper } = await import('@salusoft89/planegcs');
  return new SketchSolver(await make_gcs_wrapper(wasmUrl));
}

// ------------------------------------------------------------------ mapping

const cloneEnt = (e: WEntity): WEntity => JSON.parse(JSON.stringify(e));

/** The sketch without its splines; relations/dimensions on splines are not supported yet. */
function withoutSplines(ws: WSketch): { rest: WSketch; ids: Set<string>; error?: string } {
  const ids = new Set(ws.entities.filter((e) => e.kind === 'spline').map((e) => e.id));
  const bad = ws.constraints.find((c) => constraintRefs(c).some((id) => ids.has(id)));
  return {
    rest: { ...ws, entities: ws.entities.filter((e) => !ids.has(e.id)) }, ids,
    ...(bad ? { error: `Relations and dimensions on splines are not supported yet (${bad.id}); a spline is fixed by its points` } : {}),
  };
}

/** Put the (unchanged) splines back in their original order. */
function mergeSplines(original: WEntity[], solved: WEntity[]): WEntity[] {
  const byId = new Map(solved.map((e) => [e.id, e]));
  return original.map((e) => (e.kind === 'spline' ? cloneEnt(e) : byId.get(e.id) ?? cloneEnt(e)));
}
const uniq = <T,>(a: T[]) => [...new Set(a)];
/** gcs ids are "<our id>#<n>"; geometry ids are our entity ids. */
const ownerId = (gid: string) => gid.split('#')[0];

function failureMessage(status: number, conflicting: string[], res: { max: number; worst?: string }): string {
  if (conflicting.length) return `Conflicting relations/dimensions: ${conflicting.join(', ')}`;
  if (!Number.isFinite(res.max)) return `Sketch could not be evaluated: ${res.worst ?? 'invalid geometry'}`;
  if (status === 2) return 'The solver could not find a solution (the dimensions may be impossible, e.g. a triangle side longer than the other two)';
  return `The solver stopped with an error of ${res.max.toExponential(2)} mm${res.worst ? ` on ${res.worst}` : ''}, above the ${RESIDUAL_TOL} mm limit`;
}

/** Zero-length lines or non-positive radii are never acceptable solutions. */
function degenerateMessage(ents: WEntity[]): string | undefined {
  for (const e of ents) {
    if (e.kind === 'line' && Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) < 1e-6) return `line ${e.id} collapsed to zero length`;
    if ((e.kind === 'circle' || e.kind === 'arc') && !(e.r > 1e-6)) return `${e.kind} ${e.id} has zero or negative radius`;
  }
  return undefined;
}

function pid(r: PointRef): string {
  const suffix = { start: 's', end: 'e', center: 'c', point: 'p' }[r.p];
  return `${r.e}.${suffix}`;
}

function buildPrimitives(ws: WSketch, drag: DragTarget[]): object[] {
  const out: object[] = [];
  const pt = (id: string, p: P2, fixed = false) => out.push({ id, type: 'point', x: p[0], y: p[1], fixed });
  // Built-in fixed references.
  pt('origin.p', [0, 0], true);
  pt('axisH.s', [0, 0], true); pt('axisH.e', [1, 0], true);
  out.push({ id: 'axisH', type: 'line', p1_id: 'axisH.s', p2_id: 'axisH.e' });
  pt('axisV.s', [0, 0], true); pt('axisV.e', [0, 1], true);
  out.push({ id: 'axisV', type: 'line', p1_id: 'axisV.s', p2_id: 'axisV.e' });

  for (const e of ws.entities) {
    switch (e.kind) {
      case 'point': pt(`${e.id}.p`, e.p); break;
      case 'line':
        pt(`${e.id}.s`, e.a); pt(`${e.id}.e`, e.b);
        out.push({ id: e.id, type: 'line', p1_id: `${e.id}.s`, p2_id: `${e.id}.e` });
        break;
      case 'circle':
        pt(`${e.id}.c`, e.c);
        out.push({ id: e.id, type: 'circle', c_id: `${e.id}.c`, radius: e.r });
        break;
      case 'arc': {
        const a0 = e.a0, a1 = a0 + arcSweep(e.a0, e.a1);
        pt(`${e.id}.c`, e.c);
        pt(`${e.id}.s`, [e.c[0] + e.r * Math.cos(a0), e.c[1] + e.r * Math.sin(a0)]);
        pt(`${e.id}.e`, [e.c[0] + e.r * Math.cos(a1), e.c[1] + e.r * Math.sin(a1)]);
        out.push({ id: e.id, type: 'arc', c_id: `${e.id}.c`, start_id: `${e.id}.s`, end_id: `${e.id}.e`, radius: e.r, start_angle: a0, end_angle: a1 });
        out.push({ id: `${e.id}#rules`, type: 'arc_rules', a_id: e.id });
        break;
      }
    }
  }

  const m = entityMap(ws.entities);
  const kind = (id: string) => {
    const e = m.get(id);
    if (!e) throw new Error(`Constraint refers to missing entity ${id}`);
    return e.kind;
  };
  const radius = (id: string) => ({ o_id: id, prop: 'radius' });
  const B = (id: string) => m.get(id)!;
  const tangentAt = tangentPoints(ws.constraints);

  for (const c of ws.constraints) {
    if (isDimension(c) && c.driven) continue;
    const v = ws.values.get(c.id) ?? NaN;
    let n = 0;
    const add = (o: object) => out.push({ id: `${c.id}#${n++}`, ...o });
    mapConstraint(c, v, add, kind, radius, pid, B, tangentAt);
  }

  let n = 0;
  for (const d of drag) {
    if ('ref' in d) {
      add2(out, `drag#${n++}`, { type: 'coordinate_x', p_id: pid(d.ref), x: d.to[0], temporary: true });
      add2(out, `drag#${n++}`, { type: 'coordinate_y', p_id: pid(d.ref), y: d.to[1], temporary: true });
    } else {
      const k = kind(d.radiusOf);
      add2(out, `drag#${n++}`, k === 'circle'
        ? { type: 'circle_radius', c_id: d.radiusOf, radius: d.to, temporary: true }
        : { type: 'arc_radius', a_id: d.radiusOf, radius: d.to, temporary: true });
    }
  }
  return out;
}

function add2(out: object[], id: string, o: object) { out.push({ id, ...o }); }

function mapConstraint(
  c: SketchConstraint, v: number, add: (o: object) => void, kind: (id: string) => WEntity['kind'],
  radius: (id: string) => object, pid: (r: PointRef) => string, B: (id: string) => WEntity,
  tangentAt: Map<string, PointRef>,
) {
  const round = (id: string) => { const k = kind(id); if (k !== 'circle' && k !== 'arc') throw new Error(`${id} is not a circle or arc`); return k; };
  const lineId = (id: string) => { if (kind(id) !== 'line') throw new Error(`${id} is not a line`); return id; };
  const center = (id: string) => `${id}.c`;
  switch (c.type) {
    case 'coincident': add({ type: 'p2p_coincident', p1_id: pid(c.a), p2_id: pid(c.b) }); return;
    case 'pointOn': {
      const k = kind(c.on);
      if (k === 'line') add({ type: 'point_on_line_pl', p_id: pid(c.p), l_id: c.on });
      else if (k === 'circle') add({ type: 'point_on_circle', p_id: pid(c.p), c_id: c.on });
      else if (k === 'arc') add({ type: 'point_on_arc', p_id: pid(c.p), a_id: c.on });
      else throw new Error('A point can only lie on a line, circle or arc');
      return;
    }
    case 'horizontal': add({ type: 'horizontal_l', l_id: lineId(c.e) }); return;
    case 'vertical': add({ type: 'vertical_l', l_id: lineId(c.e) }); return;
    case 'horizontalPoints': add({ type: 'horizontal_pp', p1_id: pid(c.a), p2_id: pid(c.b) }); return;
    case 'verticalPoints': add({ type: 'vertical_pp', p1_id: pid(c.a), p2_id: pid(c.b) }); return;
    case 'parallel': add({ type: 'parallel', l1_id: lineId(c.a), l2_id: lineId(c.b) }); return;
    case 'perpendicular': add({ type: 'perpendicular_ll', l1_id: lineId(c.a), l2_id: lineId(c.b) }); return;
    case 'collinear':
      lineId(c.a); lineId(c.b);
      add({ type: 'point_on_line_pl', p_id: `${c.a}.s`, l_id: c.b });
      add({ type: 'point_on_line_pl', p_id: `${c.a}.e`, l_id: c.b });
      return;
    case 'equal': {
      const ka = kind(c.a), kb = kind(c.b);
      if (ka === 'line' && kb === 'line') add({ type: 'equal_length', l1_id: c.a, l2_id: c.b });
      else if (ka === 'circle' && kb === 'circle') add({ type: 'equal_radius_cc', c1_id: c.a, c2_id: c.b });
      else if (ka === 'circle' && kb === 'arc') add({ type: 'equal_radius_ca', c1_id: c.a, a2_id: c.b });
      else if (ka === 'arc' && kb === 'circle') add({ type: 'equal_radius_ca', c1_id: c.b, a2_id: c.a });
      else if (ka === 'arc' && kb === 'arc') add({ type: 'equal_radius_aa', a1_id: c.a, a2_id: c.b });
      else throw new Error('Equal needs two lines, or two circles/arcs');
      return;
    }
    case 'concentric': round(c.a); round(c.b); add({ type: 'p2p_coincident', p1_id: center(c.a), p2_id: center(c.b) }); return;
    case 'tangent': {
      const ka = kind(c.a), kb = kind(c.b);
      if (ka === 'point' || kb === 'point') throw new Error('Tangent needs two curves');
      const at = tangentAt.get(c.id);
      if (at) {
        const p = pointOf(B(at.e), at.p);
        const n1 = curveNormal(B(c.a), p), n2 = curveNormal(B(c.b), p);
        const angle = n1[0] * n2[0] + n1[1] * n2[1] >= 0 ? 0 : Math.PI;
        add({ type: 'angle_via_point', crv1_id: c.a, crv2_id: c.b, p_id: pid(at), angle });
        return;
      }
      if (ka === 'line' || kb === 'line') {
        const l = ka === 'line' ? c.a : c.b, k = ka === 'line' ? c.b : c.a;
        const kk = round(k);
        add(kk === 'circle' ? { type: 'tangent_lc', l_id: l, c_id: k } : { type: 'tangent_la', l_id: l, a_id: k });
      } else {
        round(c.a); round(c.b);
        add({ type: 'tangent_circumf', p1_id: center(c.a), p2_id: center(c.b), rd1: radius(c.a), rd2: radius(c.b), internal: !!c.internal });
      }
      return;
    }
    case 'midpoint': lineId(c.line); add({ type: 'p2p_symmetric_ppp', p1_id: `${c.line}.s`, p2_id: `${c.line}.e`, p_id: pid(c.p) }); return;
    case 'symmetric': add({ type: 'p2p_symmetric_ppl', p1_id: pid(c.a), p2_id: pid(c.b), l_id: lineId(c.line) }); return;
    case 'fix': {
      if (isBuiltin(c.e)) return;
      const e = B(c.e);
      const fixPt = (id: string, p: P2) => { add({ type: 'coordinate_x', p_id: id, x: p[0] }); add({ type: 'coordinate_y', p_id: id, y: p[1] }); };
      if (e.kind === 'point') fixPt(`${e.id}.p`, e.p);
      else if (e.kind === 'line') { fixPt(`${e.id}.s`, e.a); fixPt(`${e.id}.e`, e.b); }
      else if (e.kind === 'circle') { fixPt(`${e.id}.c`, e.c); add({ type: 'circle_radius', c_id: e.id, radius: e.r }); }
      else if (e.kind === 'spline') return; // splines are always fixed by their points
      else {
        fixPt(`${e.id}.c`, e.c);
        add({ type: 'arc_radius', a_id: e.id, radius: e.r });
        add({ type: 'equal', param1: { o_id: e.id, prop: 'start_angle' }, param2: e.a0 });
        add({ type: 'equal', param1: { o_id: e.id, prop: 'end_angle' }, param2: e.a0 + arcSweep(e.a0, e.a1) });
      }
      return;
    }
    case 'distance': {
      if (!(v >= 0)) throw new Error(`Dimension ${c.id} must be zero or positive`);
      if (!c.dir) {
        if (v === 0) add({ type: 'p2p_coincident', p1_id: pid(c.a), p2_id: pid(c.b) });
        else add({ type: 'p2p_distance', p1_id: pid(c.a), p2_id: pid(c.b), distance: v });
        return;
      }
      const s = constraintSign(c, B);
      const prop = c.dir === 'h' ? 'x' : 'y';
      add({ type: 'difference', param1: { o_id: pid(c.a), prop }, param2: { o_id: pid(c.b), prop }, difference: s * v });
      return;
    }
    case 'pointLineDistance':
      if (!(v >= 0)) throw new Error(`Dimension ${c.id} must be zero or positive`);
      if (v === 0) add({ type: 'point_on_line_pl', p_id: pid(c.p), l_id: lineId(c.line) });
      else add({ type: 'p2l_distance', p_id: pid(c.p), l_id: lineId(c.line), distance: v });
      return;
    case 'radius': case 'diameter': {
      if (!(v > 0)) throw new Error(`Dimension ${c.id} must be greater than zero`);
      const k = round(c.e);
      if (c.type === 'radius') add(k === 'circle' ? { type: 'circle_radius', c_id: c.e, radius: v } : { type: 'arc_radius', a_id: c.e, radius: v });
      else add(k === 'circle' ? { type: 'circle_diameter', c_id: c.e, diameter: v } : { type: 'arc_diameter', a_id: c.e, diameter: v });
      return;
    }
    case 'angle': {
      if (!(v >= 0 && v <= Math.PI)) throw new Error(`Angle ${c.id} must be between 0 and 180 degrees`);
      add({ type: 'l2l_angle_ll', l1_id: lineId(c.a), l2_id: lineId(c.b), angle: angleTarget(c.sense, !!c.supplement, v) });
      return;
    }
    case 'offset': {
      if (!(v > 0)) throw new Error(`Offset ${c.id} must be greater than zero`);
      for (const pr of c.pairs) {
        const ks = kind(pr.src), kd = kind(pr.dst);
        if (ks === 'line' && kd === 'line') {
          add({ type: 'parallel', l1_id: pr.src, l2_id: pr.dst });
          add({ type: 'p2l_distance', p_id: `${pr.dst}.s`, l_id: pr.src, distance: v });
          for (const end of pr.pin ?? []) {
            const k = end === 'start' ? 's' : 'e';
            add({ type: 'perpendicular_pppp', l1p1_id: `${pr.src}.s`, l1p2_id: `${pr.src}.e`, l2p1_id: `${pr.src}.${k}`, l2p2_id: `${pr.dst}.${k}` });
          }
        } else {
          round(pr.src); round(pr.dst);
          add({ type: 'p2p_coincident', p1_id: center(pr.src), p2_id: center(pr.dst) });
          const s = offsetPairSign(B(pr.src), B(pr.dst));
          add({ type: 'difference', param1: radius(pr.src), param2: radius(pr.dst), difference: s * v });
          if (ks === 'arc' && kd === 'arc') {
            for (const end of pr.pin ?? []) {
              const k = end === 'start' ? 's' : 'e';
              add({ type: 'point_on_line_ppp', p_id: `${pr.dst}.${k}`, lp1_id: `${pr.src}.c`, lp2_id: `${pr.src}.${k}` });
            }
          }
        }
      }
      return;
    }
  }
}

function readBack(g: GcsWrapper, base: WEntity[]): WEntity[] {
  const get = (id: string): any => g.sketch_index.get_primitive(id);
  const P = (id: string): P2 => { const p = get(id); return [p.x, p.y]; };
  return base.map((e): WEntity => {
    switch (e.kind) {
      case 'point': return { ...e, p: P(`${e.id}.p`) };
      case 'line': return { ...e, a: P(`${e.id}.s`), b: P(`${e.id}.e`) };
      case 'circle': return { ...e, c: P(`${e.id}.c`), r: get(e.id).radius };
      case 'arc': {
        const a = get(e.id);
        let a0 = wrap2pi(a.start_angle);
        let sweep = a.end_angle - a.start_angle;
        if (!(sweep > 0) || sweep > TAU) sweep = arcSweep(a.start_angle, a.end_angle);
        if (a0 > Math.PI) a0 -= TAU;
        return { ...e, c: P(`${e.id}.c`), r: a.radius, a0, a1: a0 + sweep };
      }
      case 'spline': return cloneEnt(e);
    }
  });
}
