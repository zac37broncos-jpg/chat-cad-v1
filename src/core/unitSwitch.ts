/**
 * Changing a document's units without changing the part.
 *
 * Plain numbers in a part ("3.1417", rectangle corners, sketch coordinates)
 * are in document units. Changing the units menu (or the chat's set_units)
 * used to re-read every one of them in the new unit, so a 3.1417 in plate
 * became a 3.1417 mm plate. Now the document is converted first: every length
 * that depended on the old unit gets that unit written out ("3.1417 in"), so
 * it is the same size, to the last bit, in the new unit. The part keeps its
 * physical size, and only how sizes are shown and how new plain numbers are
 * read changes - the way unit systems work in professional CAD.
 *
 * Nothing is rounded: typed text is kept and only a unit is added, and plain
 * stored numbers become "<number> <unit>" (see docs/UNITS_AND_FRACTIONS.md).
 *
 * The walk below lists every length, count and angle field of every feature.
 * tests/unit-switch.test.ts checks that list against the type definitions, so
 * a new length field that is not added here fails the tests instead of
 * silently changing size when the units change.
 */
import type { CadDocument, SketchFeature, ValueExpr, Vec2Expr, ExtrudeUpTo, RevolveThin, ExtrudeThin } from './model';
import type { PlaneSpec, Vec3Expr, RefPlaneDef, RefAxisDef, RefPointDef } from './featureTypes';
import { type LengthUnit, MM_PER, pinDocumentUnit, nameUses, evaluate, ExpressionError, type Quantity } from './units';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** Field names (as in model.ts / featureTypes.ts) that hold lengths, counts and angles. Used by the completeness test. */
export const LENGTH_FIELDS = [
  'offset', 'p', 'p1', 'p2', 'center', 'radius', 'points', 'value', 'depth', 'depth2', 'startOffset',
  'capThickness', 'autoFillet', 'thickness', 'thickness2', 'radius2', 'distance', 'distance2',
  'threadDepth', 'diameter', 'cboreDiameter', 'cboreDepth', 'cskDiameter', 'placement', 'spacing1', 'spacing2',
  'plane', 'neutral', 'startPoint', 'endPoint', 'surface', 'from', 'a', 'b', 'point', 'x', 'y', 'z',
] as const;
export const COUNT_FIELDS = ['count1', 'count2', 'count'] as const;
/** Angles never use the document unit (plain numbers are degrees), so they are left exactly as they are. */
export const ANGLE_FIELDS = ['startAngle', 'endAngle', 'draft', 'draft2', 'angle', 'angle2', 'drillPoint', 'cskAngle'] as const;

/**
 * The same document in `to` units, the same physical size. Throws (and
 * changes nothing) if a value cannot be read, naming it, because a value that
 * cannot be read cannot be kept the same size.
 */
export function convertDocumentUnits(doc: CadDocument, to: LengthUnit): CadDocument {
  const from = doc.units;
  const out = clone(doc);
  out.units = to;
  if (from === to) return out;

  // ---- parameters: resolve in order with the old unit (as resolveParams does), then pin each one.
  const params: Record<string, Quantity> = {};
  const angleOnly = anglesOnlyParams(doc);
  for (const p of out.params) {
    const where = `parameter ${p.name}`;
    let q: Quantity;
    try { q = evaluate(p.expr, params, MM_PER[from]); } catch (e) { throw unreadable(where, p.expr, e); }
    params[p.name] = q.dim === 'none' ? { v: q.v * MM_PER[from], dim: 'length', bare: q.v } : q;
    // A plain-number parameter is a length in document units, unless it is only ever used as "name deg".
    if (q.dim === 'none' && angleOnly.has(p.name)) continue;
    p.expr = pin(p.expr, where, q.dim === 'angle' ? 'number' : 'length');
  }

  function pin(v: string, where: string, context: 'length' | 'number'): string {
    try { return pinDocumentUnit(v, from, params, context); } catch (e) { throw unreadable(where, v, e); }
  }
  /** A length value: numbers become "<n> <unit>" (0 stays 0), text gets units written out where it needs them. */
  const L = (v: ValueExpr | undefined, where: string): ValueExpr | undefined => {
    if (v === undefined) return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw unreadable(where, String(v), new Error('not a finite number'));
      return v === 0 ? v : `${String(v)} ${from}`;
    }
    return pin(v, where, 'length');
  };
  const N = (v: ValueExpr | undefined, where: string): ValueExpr | undefined =>
    typeof v === 'string' ? pin(v, where, 'number') : v;
  const V2 = (p: Vec2Expr, where: string) => { p.x = L(p.x, where)!; p.y = L(p.y, where)!; };
  const V3 = (p: Vec3Expr | undefined, where: string) => { if (p) { p.x = L(p.x, where)!; p.y = L(p.y, where)!; p.z = L(p.z, where)!; } };
  const PL = (p: PlaneSpec | undefined, where: string) => { if (p && 'base' in p && p.offset !== undefined) p.offset = L(p.offset, where); };
  const set = <T extends object, K extends keyof T>(o: T, k: K, where: string, f: (v: any, w: string) => any) => {
    if (o[k] !== undefined) o[k] = f(o[k], `${where} ${String(k)}`);
  };
  const thin = (t: RevolveThin | ExtrudeThin | undefined, where: string) => {
    if (!t) return;
    set(t, 'thickness', where, L); set(t, 'thickness2', where, L);
    if ('capThickness' in t) set(t as ExtrudeThin, 'capThickness', where, L);
    if ('autoFillet' in t) set(t as ExtrudeThin, 'autoFillet', where, L);
  };
  const upTo = (u: ExtrudeUpTo | undefined, where: string) => {
    if (u?.kind === 'surface') { PL(u.surface, `${where} surface`); set(u, 'offset', where, L); }
  };

  for (const f of out.features) {
    const w = f.name || f.id;
    switch (f.type) {
      case 'sketch': sketch(f, w); break;
      case 'extrude':
        set(f, 'depth', w, L); set(f, 'depth2', w, L); set(f, 'startOffset', w, L);
        thin(f.thin, w); upTo(f.upTo, w); upTo(f.upTo2, w);
        break; // draft, draft2: angles
      case 'revolve': thin(f.thin, w); break; // angle, angle2: angles
      case 'fillet': set(f, 'radius', w, L); set(f, 'radius2', w, L); break;
      case 'chamfer': set(f, 'distance', w, L); set(f, 'distance2', w, L); break; // angle: angle
      case 'hole':
        for (const k of ['depth', 'threadDepth', 'diameter', 'cboreDiameter', 'cboreDepth', 'cskDiameter'] as const) set(f, k, w, L);
        PL(f.placement, `${w} placement`);
        f.points.forEach((p) => V2(p, `${w} point`));
        break; // drillPoint, cskAngle: angles
      case 'linearPattern':
        set(f, 'spacing1', w, L); set(f, 'spacing2', w, L); set(f, 'count1', w, N); set(f, 'count2', w, N);
        break;
      case 'circularPattern': set(f, 'count', w, N); break; // angle: angle
      case 'mirror': PL(f.plane, `${w} plane`); break;
      case 'shell': case 'rib': set(f, 'thickness', w, L); break;
      case 'draft': PL(f.neutral, `${w} neutral plane`); break; // angle: angle
      case 'sweep': if (f.circular) set(f.circular, 'diameter', w, L); break;
      case 'loft': V3(f.startPoint, `${w} start point`); V3(f.endPoint, `${w} end point`); break;
      case 'refPlane': refPlane(f.def, w); break;
      case 'refAxis': refAxis(f.def, w); break;
      case 'refPoint': refPoint(f.def, w); break;
      default: {
        const never: never = f;
        throw new Error(`Cannot change units: unknown feature type ${(never as { type: string }).type}`);
      }
    }
  }

  function sketch(f: SketchFeature, w: string) {
    set(f, 'offset', w, L);
    for (const e of f.entities) {
      switch (e.kind) {
        case 'point': V2(e.p, w); break;
        case 'line': V2(e.p1, w); V2(e.p2, w); break;
        case 'circle': V2(e.center, w); e.radius = L(e.radius, `${w} radius`)!; break;
        case 'arc': V2(e.center, w); e.radius = L(e.radius, `${w} radius`)!; break; // start/end angles: angles
        case 'spline': e.points.forEach((p) => V2(p, w)); break;
      }
    }
    for (const c of f.constraints ?? []) {
      if (!('value' in c)) continue;
      if (c.type !== 'angle') c.value = L(c.value, `${w} dimension`)!;
      // Where a dimension's text sits is in document units too (looks only; a plain scale is fine).
      if (c.text) c.text = [c.text[0] * MM_PER[from] / MM_PER[to], c.text[1] * MM_PER[from] / MM_PER[to]];
    }
  }
  function refPlane(d: RefPlaneDef, w: string) {
    switch (d.kind) {
      case 'offset': PL(d.from, w); d.distance = L(d.distance, `${w} distance`)!; break;
      case 'angle': PL(d.from, w); break;
      case 'threePoints': d.points.forEach((p) => V3(p, w)); break;
      case 'midplane': PL(d.a, w); PL(d.b, w); break;
      case 'normalToCurve': break;
      case 'parallelAtPoint': PL(d.from, w); if (!('refPoint' in d.point)) V3(d.point, w); break;
    }
  }
  function refAxis(d: RefAxisDef, w: string) {
    if (d.kind === 'twoPoints') { V3(d.p1, w); V3(d.p2, w); }
    if (d.kind === 'twoPlanes') { PL(d.a, w); PL(d.b, w); }
  }
  function refPoint(d: RefPointDef, w: string) { if (d.kind === 'coords') V3(d.p, w); }

  return out;
}

function unreadable(where: string, v: string, e: unknown): Error {
  return new ExpressionError(`Units were not changed: ${where} ("${v}") cannot be read (${(e as Error).message}). Fix it first, so its size can be kept.`);
}

/** Plain-number parameters used only as "name deg" / "name rad" (an angle typed without a unit): no unit is added to them. */
function anglesOnlyParams(doc: CadDocument): Set<string> {
  const uses = new Map<string, boolean[]>();
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    let found: { name: string; asAngle: boolean }[];
    try { found = nameUses(v); } catch { return; }
    for (const u of found) uses.set(u.name, [...(uses.get(u.name) ?? []), u.asAngle]);
  };
  const walk = (o: unknown) => {
    if (typeof o === 'string') add(o);
    else if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
  };
  doc.params.forEach((p) => add(p.expr));
  walk(doc.features);
  const out = new Set<string>();
  for (const [name, a] of uses) if (a.length && a.every(Boolean)) out.add(name);
  return out;
}
