/**
 * Small DOM-free helpers behind the app's feedback details: which faces belong
 * to which feature (for highlighting a feature from the feature tree and
 * marking a picked face's feature in the tree), and the status bar's quick
 * measurement of the selection.
 */
import type { Topology } from '../kernel/naming';
import type { EntityInfo } from '../kernel/query';
import { formatLength, MM_PER, type LengthUnit } from '../core/units';

/**
 * Features a face belongs to, from its topological-naming tags
 * (docs/TOPOLOGICAL_NAMING.md). A tag starts with the id of the feature that
 * made the face (`ex_1:side:l1`, `fi_2:blend:0`, `sh_4:inner:ex_1:end`).
 * A pattern or mirror copy carries `#<pattern id>.<instance>` and belongs to
 * that pattern (the last one when patterns are nested), not to the original.
 */
export function faceOwners(tags: string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const hash = t.lastIndexOf('#');
    if (hash >= 0) {
      const id = t.slice(hash + 1).split('.')[0];
      if (id) out.add(id);
    } else {
      const id = t.split(':')[0];
      if (id) out.add(id);
    }
  }
  return [...out];
}

/** Indices of the faces made by any of the given features. */
export function facesOfFeatures(topology: Topology | null | undefined, ids: Iterable<string>): number[] {
  const want = new Set(ids);
  if (!topology || want.size === 0) return [];
  const out: number[] = [];
  topology.faces.forEach((f, i) => { if (faceOwners(f.tags).some((o) => want.has(o))) out.push(i); });
  return out;
}

/** Features that made the given faces, in tree order of first appearance. */
export function featuresOfFaces(topology: Topology | null | undefined, faces: number[]): string[] {
  if (!topology) return [];
  const out = new Set<string>();
  for (const i of faces) for (const o of faceOwners(topology.faces[i]?.tags ?? [])) out.add(o);
  return [...out];
}

const SURFACE_NAME: Record<string, string> = { plane: 'Planar face', cylinder: 'Cylindrical face', cone: 'Conical face', sphere: 'Spherical face', torus: 'Toroidal face' };
const CURVE_NAME: Record<string, string> = { line: 'Line edge', circle: 'Circular edge', ellipse: 'Elliptical edge' };

/**
 * One-line quick measurement of the selection for the status bar, like the
 * one mainstream CAD shows: length of an edge, radius of a circular edge or
 * cylindrical face, area of a face, and the minimum distance between two
 * selections. Values come from the exact geometry (kernel `info` / `distance`).
 */
export function selectionSummary(infos: EntityInfo[], distance: number | null, units: LengthUnit): string {
  const L = (mm: number) => formatLength(mm, units);
  const area = (mm2: number) => `${(mm2 / MM_PER[units] ** 2).toFixed(units === 'in' ? 4 : 2)} ${units}²`;
  if (infos.length >= 2 && distance !== null) return `Distance: ${L(distance)}`;
  if (infos.length !== 1) return '';
  const i = infos[0] as any;
  if (i.kind === 'face') {
    const parts = [`${SURFACE_NAME[i.surface] ?? 'Face'}`];
    if (i.surface === 'cylinder') parts.push(`Radius: ${L(i.radius)}`);
    parts.push(`Area: ${area(i.area)}`);
    return parts.join('   ');
  }
  const parts = [`${CURVE_NAME[i.curve] ?? 'Edge'}`];
  if (i.curve === 'circle') parts.push(`Radius: ${L(i.radius)}`);
  parts.push(`Length: ${L(i.length)}`);
  return parts.join('   ');
}
