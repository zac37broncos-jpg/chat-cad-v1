/**
 * Turning viewport picks into persistent references and back, on the UI
 * side. Works from the Topology summary the kernel sends with every rebuild
 * and preview (face names, face centers, edge adjacency), so no kernel call
 * is needed while the user clicks.
 *
 * The kernel does the authoritative resolution at rebuild time
 * (src/kernel/naming.ts). Here we only need to highlight what a box holds
 * and to keep a reference unchanged when the user re-picks the same item.
 */
import type { EdgeRef, FaceRef, PlaneSpec, AxisSpec, Vec3 } from '../core/featureTypes';
import type { CadDocument } from '../core/model';
import { faceRefFrom, edgeRefFrom, describeTag, type Topology } from '../kernel/naming';
import type { SelRef } from '../kernel/protocol';

const overlap = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length;
const dist2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function best(cands: { i: number; score: number; p: Vec3 }[], at?: Vec3): number | null {
  if (!cands.length) return null;
  const top = Math.max(...cands.map((c) => c.score));
  const b = cands.filter((c) => c.score === top);
  if (b.length === 1 || !at) return b[0].i;
  return b.reduce((m, c) => (dist2(c.p, at) < dist2(m.p, at) ? c : m)).i;
}

/** Index of the face a reference names in this topology, or null when it is gone. */
export function faceIndex(t: Topology | null | undefined, ref: FaceRef): number | null {
  if (!t) return null;
  return best(t.faces.map((f, i) => ({ i, score: overlap(f.tags, ref.tags), p: f.center })).filter((c) => c.score > 0), ref.at);
}

/** Index of the edge a reference names in this topology, or null when it is gone. */
export function edgeIndex(t: Topology | null | undefined, ref: EdgeRef): number | null {
  if (!t) return null;
  const cands: { i: number; score: number; p: Vec3 }[] = [];
  t.edges.forEach((e, i) => {
    const f1 = e.faces[0], f2 = e.faces[1] ?? e.faces[0];
    if (f1 === undefined) return;
    const pair = (x: number, y: number) => {
      const oa = overlap(t.faces[x].tags, ref.a), ob = overlap(t.faces[y].tags, ref.b);
      return oa > 0 && ob > 0 ? oa + ob : 0;
    };
    const score = Math.max(pair(f1, f2), pair(f2, f1));
    if (score > 0) cands.push({ i, score, p: e.mid });
  });
  return best(cands, ref.at);
}

/** Selection that highlights these references. */
export function selectionOf(t: Topology | null | undefined, refs: { edges?: EdgeRef[]; faces?: FaceRef[] }): SelRef[] {
  const out: SelRef[] = [];
  for (const r of refs.faces ?? []) { const i = faceIndex(t, r); if (i !== null) out.push({ kind: 'face', index: i }); }
  for (const r of refs.edges ?? []) { const i = edgeIndex(t, r); if (i !== null) out.push({ kind: 'edge', index: i }); }
  return out;
}

/**
 * References for the faces / edges in a selection. A reference already in
 * `keep` that names the same item is kept as it is (so editing a feature and
 * re-picking does not change what it stores).
 */
export function facesFrom(t: Topology | null | undefined, sel: SelRef[], keep: FaceRef[] = []): FaceRef[] {
  if (!t) return keep;
  return sel.flatMap((s) => {
    if (s.kind !== 'face' || !t.faces[s.index]) return [];
    return [keep.find((k) => faceIndex(t, k) === s.index) ?? faceRefFrom(t, s.index)];
  });
}
export function edgesFrom(t: Topology | null | undefined, sel: SelRef[], keep: EdgeRef[] = []): EdgeRef[] {
  if (!t) return keep;
  return sel.flatMap((s) => {
    if (s.kind !== 'edge' || !t.edges[s.index]) return [];
    return [keep.find((k) => edgeIndex(t, k) === s.index) ?? edgeRefFrom(t, s.index)];
  });
}

const nameOf = (doc: CadDocument) => (id: string) => doc.features.find((f) => f.id === id)?.name;

export function faceLabel(doc: CadDocument, r: FaceRef): string {
  return describeTag(r.tags[0] ?? '?', nameOf(doc));
}
export function edgeLabel(doc: CadDocument, r: EdgeRef): string {
  return `Edge between ${describeTag(r.a[0] ?? '?', nameOf(doc))} and ${describeTag(r.b[0] ?? '?', nameOf(doc))}`;
}

const BASE_NAMES = { XY: 'Top Plane', XZ: 'Front Plane', YZ: 'Right Plane' } as const;

export function planeLabel(doc: CadDocument, p: PlaneSpec | null | undefined): string {
  if (!p) return '';
  if ('base' in p) return BASE_NAMES[p.base] + (p.offset !== undefined && p.offset !== 0 && p.offset !== '0' ? ` + ${p.offset}` : '');
  if ('refPlane' in p) return nameOf(doc)(p.refPlane) ?? 'Plane (missing)';
  return faceLabel(doc, p.face);
}

export function axisLabel(doc: CadDocument, a: AxisSpec | null | undefined): string {
  if (!a) return '';
  if ('axis' in a) return `${a.axis} axis`;
  if ('refAxis' in a) return nameOf(doc)(a.refAxis) ?? 'Axis (missing)';
  if ('edge' in a) return edgeLabel(doc, a.edge);
  return `Axis of ${faceLabel(doc, a.face)}`;
}

/** Highlight for a plane / axis spec that sits on the solid. */
export function selectionOfPlane(t: Topology | null | undefined, p: PlaneSpec | null | undefined): SelRef[] {
  if (!p) return [];
  if ('base' in p) return [{ kind: 'plane', plane: p.base }];
  if ('face' in p) return selectionOf(t, { faces: [p.face] });
  return [];
}
export function selectionOfAxis(t: Topology | null | undefined, a: AxisSpec | null | undefined): SelRef[] {
  if (!a) return [];
  if ('edge' in a) return selectionOf(t, { edges: [a.edge] });
  if ('face' in a) return selectionOf(t, { faces: [a.face] });
  return [];
}

/**
 * The 2D axes a hole point uses on a planar face (same rule as the
 * kernel: world axes for faces parallel to the base planes).
 */
export function faceAxes(normal: Vec3 | undefined): { u: string; v: string; ui: number; vi: number } | null {
  if (!normal) return null;
  const [ax, ay, az] = normal.map(Math.abs);
  const E = 1e-9;
  if (ax < E && ay < E) return { u: 'X', v: 'Y', ui: 0, vi: 1 };
  if (ax < E && az < E) return { u: 'X', v: 'Z', ui: 0, vi: 2 };
  if (ay < E && az < E) return { u: 'Y', v: 'Z', ui: 1, vi: 2 };
  return null;
}

/** 2D coordinates (mm) of a world point on a planar face, in the frame the kernel uses for hole points. */
export function toFace2D(normal: Vec3, p: Vec3): [number, number] {
  const n = normal;
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const E = 1e-9;
  let x: Vec3, y: Vec3;
  if (ax < E && ay < E) { x = [1, 0, 0]; y = [0, 1, 0]; }
  else if (ax < E && az < E) { x = [1, 0, 0]; y = [0, 0, 1]; }
  else if (ay < E && az < E) { x = [0, 1, 0]; y = [0, 0, 1]; }
  else {
    const r: Vec3 = ax < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const d = r[0] * n[0] + r[1] * n[1] + r[2] * n[2];
    const xr: Vec3 = [r[0] - n[0] * d, r[1] - n[1] * d, r[2] - n[2] * d];
    const l = Math.hypot(...xr);
    x = [xr[0] / l, xr[1] / l, xr[2] / l];
    y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
  }
  // The frame origin is the world origin projected onto the plane, so 2D coordinates are plain dot products.
  return [p[0] * x[0] + p[1] * x[1] + p[2] * x[2], p[0] * y[0] + p[1] * y[1] + p[2] * y[2]];
}
