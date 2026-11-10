/**
 * The printability and precision test set (docs/PRINT_VERIFICATION.md).
 *
 * Each part is built with the same feature commands the app and the chat use, and carries
 * what an independent checker needs to judge the exported files without trusting CHAD:
 * the volume and bounding box calculated by hand (closed form, in mm), every round hole's
 * design diameter, axis and position, the number of through holes (genus), and the thinnest
 * wall the design has on purpose. Nothing here is derived from the exported files.
 *
 * All expectations are in millimeters (inch parts are converted with 25.4 exactly).
 */
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import { DocumentStore } from '../../src/core/store';
import { rectangleEntities, newId, type SketchEntity } from '../../src/core/model';
import { regenerate, releaseRegen, type OC, type RegenResult } from '../../src/kernel/regen';
import { edgeRefFrom, faceRefFrom, type Topology } from '../../src/kernel/naming';
import * as F from '../../src/core/featureCommands';
import type { SketchSolver } from '../../src/sketch/solver';
import { executeTool, type ExecutorContext } from '../../src/ai/executor';
import { withRecordedSeams } from '../../tests/helpers/seams';

export const IN = 25.4;
const IN3 = IN ** 3;
const PI = Math.PI;

export type Vec3 = [number, number, number];
/** A round hole as designed: a cylinder of this diameter around this axis, between z0 and z1 along it. */
export interface HoleSpec { label: string; diameter: number; axis: Vec3; point: Vec3; from: number; to: number }

export interface TestPart {
  slug: string;
  title: string;
  /** What the part exercises. */
  covers: string;
  unit: 'in' | 'mm';
  store: DocumentStore;
  shape: TopoDS_Shape;
  /** Hand-calculated volume, mm³ (null: no closed form, e.g. organic lofts). */
  volume: number | null;
  /** Hand-calculated bounding box, mm. */
  box: { min: Vec3; max: Vec3 } | null;
  /** Through holes (genus of the closed surface). */
  genus: number;
  holes: HoleSpec[];
  /** Thinnest wall in the design, mm (null: not a designed wall, e.g. organic). */
  minWall: number | null;
}

export interface Ctx { oc: OC; solver: SketchSolver }

const mmBox = (u: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
  ({ min: [x0 * u, y0 * u, z0 * u] as Vec3, max: [x1 * u, y1 * u, z1 * u] as Vec3 });

/** Every rebuild result made while building a part (they belong to the caller: freed by releaseBuilt). */
const built: RegenResult[] = [];
function rebuild(c: Ctx, st: DocumentStore) { const r = regenerate(c.oc, st.state, { solver: c.solver }); built.push(r); return r; }
/** Free the kernel objects of everything built so far (call after exporting a part). */
export function releaseBuilt() { for (const r of built.splice(0)) releaseRegen(r); }

function build(c: Ctx, st: DocumentStore) {
  const r = rebuild(c, st);
  const bad = r.status.filter((s) => !s.ok);
  if (bad.length) throw new Error(`rebuild failed: ${JSON.stringify(bad)}`);
  if (!r.shape) throw new Error('no solid');
  return r;
}
const near = (p: number[], q: number[], tol = 1e-6) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
function edgeAt(t: Topology, p: Vec3) { const i = t.edges.findIndex((e) => near(e.mid, p)); if (i < 0) throw new Error(`no edge at ${p}`); return i; }
function faceAt(t: Topology, p: Vec3) { const i = t.faces.findIndex((f) => near(f.center, p)); if (i < 0) throw new Error(`no face at ${p}`); return i; }
const zHole = (label: string, d: number, x: number, y: number, z0: number, z1: number): HoleSpec => ({ label, diameter: d, axis: [0, 0, 1], point: [x, y, 0], from: z0, to: z1 });

// ---------------------------------------------------------------- prismatic parts (closed forms)

function plateWithHoles(c: Ctx): TestPart {
  const st = new DocumentStore(); // inches
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Plate Sketch' }), 0.5, { name: 'Plate' });
  st.addExtrude(st.addSketch('XY', [
    { id: newId('c'), kind: 'circle', center: { x: 0.5, y: 1 }, radius: 0.125 },
    { id: newId('c'), kind: 'circle', center: { x: 3.5, y: 1 }, radius: 0.125 },
  ], { name: 'Hole Sketch' }), 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Holes' });
  return {
    slug: '01-plate-with-holes', title: 'Plate with holes (4 x 2 x 0.5 in)', covers: 'scale (4 in = 101.6 mm), sketch cut through all, small holes',
    unit: 'in', store: st, shape: build(c, st).shape!,
    volume: (4 * 2 * 0.5 - 2 * PI * 0.125 ** 2 * 0.5) * IN3, box: mmBox(IN, 0, 0, 0, 4, 2, 0.5), genus: 2,
    holes: [zHole('Ø0.250 left', 0.25 * IN, 0.5 * IN, 1 * IN, 0, 0.5 * IN), zHole('Ø0.250 right', 0.25 * IN, 3.5 * IN, 1 * IN, 0, 0.5 * IN)],
    minWall: 0.375 * IN, // hole edge to the plate's end
  };
}

function filletChamferBlock(c: Ctx): TestPart {
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2)), 1, { name: 'Block' });
  let t = build(c, st).topology!;
  const vertical = t.edges.map((e, i) => ({ e, i })).filter(({ e }) => Math.abs(e.mid[2] - 0.5 * IN) < 1e-6);
  if (vertical.length !== 4) throw new Error('expected 4 vertical edges');
  F.addFillet(st, { edges: vertical.map(({ i }) => edgeRefFrom(t, i)), radius: 0.25, name: 'Corner Rounds' });
  t = build(c, st).topology!;
  F.addChamfer(st, { edges: [edgeRefFrom(t, edgeAt(t, [2 * IN, 0, IN]))], distance: 0.1, name: 'Edge Break' });
  // Rounds remove 4 (r² - pi r²/4) x 1; the 0.1 x 0.1 chamfer follows the tangent top edges: 10 in of
  // straight edge plus four quarter rounds (Pappus, triangle centroid 0.1/3 inside the R0.25 edge).
  const volume = (8 - 4 * (0.25 ** 2 - (PI * 0.25 ** 2) / 4) - 0.005 * (10 + 2 * PI * (0.25 - 0.1 / 3))) * IN3;
  return {
    slug: '02-fillet-chamfer-block', title: 'Block with R0.25 rounds and a 0.1 chamfer (4 x 2 x 1 in)', covers: 'fillets (cylinders), chamfer following tangent edges',
    unit: 'in', store: st, shape: build(c, st).shape!, volume, box: mmBox(IN, 0, 0, 0, 4, 2, 1), genus: 0, holes: [], minWall: 2 * IN,
  };
}

function boltCircleFlange(c: Ctx): TestPart {
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', [{ id: 'c', kind: 'circle', center: { x: 0, y: 0 }, radius: 2 }]), 0.25, { name: 'Flange' });
  const hole = F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '#10', end: 'through', placement: { base: 'XY', offset: 0.25 }, points: [{ x: 1.5, y: 0 }], name: 'Bolt Hole' });
  F.addCircularPattern(st, { features: [hole], axis: { axis: 'Z' }, count: 6, angle: 360, name: 'Bolt Pattern' });
  const d = 0.221; // ANSI #10 normal-fit clearance (holeTables)
  const holes = Array.from({ length: 6 }, (_, k) => zHole(`#10 clearance ${k + 1}`, d * IN, 1.5 * IN * Math.cos((k * PI) / 3), 1.5 * IN * Math.sin((k * PI) / 3), 0, 0.25 * IN));
  return {
    slug: '03-bolt-circle-flange', title: 'Ø4 in flange, six #10 holes on a Ø3 bolt circle', covers: 'hole, circular pattern, round outline',
    unit: 'in', store: st, shape: build(c, st).shape!, volume: (PI * 4 * 0.25 - 6 * PI * (d / 2) ** 2 * 0.25) * IN3, box: mmBox(IN, -2, -2, 0, 2, 2, 0.25), genus: 6, holes,
    minWall: 0.25 * IN, // the plate thickness (the holes are 0.39 in from the rim)
  };
}

function revolvedRing(c: Ctx): TestPart {
  const st = new DocumentStore();
  const ents: SketchEntity[] = [
    { id: 'ax', kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 0, y: 1 }, construction: true },
    { id: newId('c'), kind: 'circle', center: { x: 1, y: 0 }, radius: 0.25 },
  ];
  st.addRevolve(st.addSketch('XY', ents, { name: 'Ring Profile' }), 'ax', 360, { name: 'Ring' });
  return {
    slug: '04-revolved-ring', title: 'Revolved ring (torus R1 x r0.25 in)', covers: 'revolve, doubly curved surface (torus)',
    unit: 'in', store: st, shape: build(c, st).shape!, volume: 2 * PI ** 2 * 1 * 0.25 ** 2 * IN3, box: mmBox(IN, -1.25, -0.25, -1.25, 1.25, 0.25, 1.25), genus: 1, holes: [], minWall: 0.5 * IN,
  };
}

function lBracket(c: Ctx): TestPart {
  // The demo bracket (tests/mass-consistency.test.ts): 100 x 60 x 8 plate, 100 x 8 x 50 wall, four M6
  // normal clearance holes (ISO 273: 6.6), a Ø22 hole through the wall, R6 inside corner fillet.
  const st = new DocumentStore(); st.setUnits('mm');
  st.setParameter('T', '8'); st.setParameter('WT', '8'); st.setParameter('WH', '50');
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 100, 60), { name: 'Base Plate Sketch' }), 'T', { name: 'Base Plate' });
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, '60 - WT', 100, 'WT'), { name: 'Wall Sketch', offset: 'T' }), 'WH', { name: 'Wall' });
  const hole = F.addHole(st, { holeType: 'simple', standard: 'iso-metric', size: 'M6', end: 'through', placement: { base: 'XY', offset: 'T' }, points: [{ x: 10, y: 10 }], name: 'M6 Mounting Hole' });
  F.addLinearPattern(st, { features: [hole], dir1: { axis: 'X' }, spacing1: 80, count1: 2, dir2: { axis: 'Y' }, spacing2: 30, count2: 2, name: 'Mounting Hole Pattern' });
  st.addExtrude(st.addSketch('XZ', [{ id: newId('c'), kind: 'circle', center: { x: 50, y: 'T + WH/2' }, radius: 11 }], { name: 'Wall Hole Sketch' }), 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Wall Hole' });
  const t = build(c, st).topology!;
  F.addFillet(st, { edges: [edgeRefFrom(t, edgeAt(t, [50, 52, 8]))], radius: 6, name: 'Corner Fillet' });
  const volume = 100 * 60 * 8 + 100 * 8 * 50 - PI * 11 ** 2 * 8 - 4 * PI * 3.3 ** 2 * 8 + (1 - PI / 4) * 36 * 100;
  const holes = [[10, 10], [90, 10], [10, 40], [90, 40]].map(([x, y], k) => zHole(`M6 clearance ${k + 1}`, 6.6, x, y, 0, 8));
  holes.push({ label: 'Ø22 wall hole', diameter: 22, axis: [0, 1, 0], point: [50, 0, 33], from: 52, to: 60 });
  return {
    slug: '05-l-bracket', title: 'L mounting bracket (demo part, mm)', covers: 'parameters, linear pattern of ISO holes, hole on a vertical wall, fillet between two bodies',
    unit: 'mm', store: st, shape: build(c, st).shape!, volume, box: { min: [0, 0, 0], max: [100, 60, 58] }, genus: 5, holes, minWall: 8,
  };
}

function holeGauge(c: Ctx): TestPart {
  // Small-hole accuracy: Ø1, Ø2, Ø3.4 (M3 clearance), Ø6.6 (M6), Ø12 through a 90 x 20 x 10 block,
  // and an M6 counterbore (Ø6.6 through, Ø11 x 6 deep, ISO 4762 head).
  const st = new DocumentStore(); st.setUnits('mm');
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 90, 20), { name: 'Gauge Sketch' }), 10, { name: 'Gauge Block' });
  const sizes: [number, number][] = [[8, 1], [18, 2], [30, 3.4], [44, 6.6], [62, 12]];
  st.addExtrude(st.addSketch('XY', sizes.map(([x, d]) => ({ id: newId('c'), kind: 'circle' as const, center: { x, y: 10 }, radius: d / 2 })), { name: 'Gauge Holes Sketch' }),
    0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Gauge Holes' });
  F.addHole(st, { holeType: 'counterbore', standard: 'iso-metric', size: 'M6', end: 'through', placement: { base: 'XY', offset: 10 }, points: [{ x: 80, y: 10 }], name: 'M6 Counterbore' });
  const volume = 90 * 20 * 10 - sizes.reduce((s, [, d]) => s + PI * (d / 2) ** 2 * 10, 0) - PI * (5.5 ** 2 * 6 + 3.3 ** 2 * 4);
  const holes = sizes.map(([x, d]) => zHole(`Ø${d}`, d, x, 10, 0, 10));
  holes.push(zHole('M6 counterbore: Ø6.6 drill', 6.6, 80, 10, 0, 4), zHole('M6 counterbore: Ø11 bore', 11, 80, 10, 4, 10));
  return {
    slug: '06-hole-gauge', title: 'Hole gauge: Ø1 to Ø12 and an M6 counterbore (mm)', covers: 'small holes (worst case for STL flats), counterbore',
    unit: 'mm', store: st, shape: build(c, st).shape!, volume, box: { min: [0, 0, 0], max: [90, 20, 10] }, genus: 6, holes, minWall: 4 /* Ø12 hole to the Y faces */,
  };
}

function countersinkTapped(c: Ctx): TestPart {
  // 4 x 2 x 1 in plate: #10 82° countersink through, 1/4-20 tapped blind (tap drill Ø0.201, 118° point).
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 4, 2), { name: 'Plate Sketch' }), 1, { name: 'Plate' });
  F.addHole(st, { holeType: 'countersink', standard: 'ansi-inch', size: '#10', end: 'through', placement: { base: 'XY', offset: 1 }, points: [{ x: 1, y: 1 }], name: 'CSK #10' });
  F.addHole(st, { holeType: 'tapped', standard: 'ansi-inch', size: '1/4-20', end: 'blind', placement: { base: 'XY', offset: 1 }, points: [{ x: 3, y: 1 }], name: 'Tapped 1/4-20' });
  const R = 0.411 / 2, r = 0.221 / 2, h = (R - r) / Math.tan((41 * PI) / 180);
  const csk = (PI * h / 3) * (R * R + R * r + r * r) + PI * r * r * (1 - h);
  const rt = 0.201 / 2, depth = 0.5 + 3 / 20, tip = rt / Math.tan((59 * PI) / 180);
  const tapped = PI * rt * rt * depth + (PI * rt * rt * tip) / 3;
  return {
    slug: '07-countersink-tapped', title: 'Countersink #10 and tapped 1/4-20 blind hole (4 x 2 x 1 in)', covers: 'cones (countersink, drill point), blind hole',
    unit: 'in', store: st, shape: build(c, st).shape!, volume: (8 - csk - tapped) * IN3, box: mmBox(IN, 0, 0, 0, 4, 2, 1), genus: 1,
    holes: [zHole('#10 clearance below the countersink', 0.221 * IN, 1 * IN, 1 * IN, 0, (1 - h) * IN), zHole('1/4-20 tap drill', 0.201 * IN, 3 * IN, 1 * IN, (1 - depth) * IN, 1 * IN)],
    minWall: 0.35 * IN /* blind hole bottom to the base: 1 - 0.65 */,
  };
}

function shelledBox(c: Ctx, slug: string, title: string, unit: 'in' | 'mm', L: number, W: number, H: number, t: number): TestPart {
  const st = new DocumentStore(); if (unit === 'mm') st.setUnits('mm');
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, L, W), { name: 'Box Sketch' }), H, { name: 'Box' });
  const u = unit === 'in' ? IN : 1;
  const topo = build(c, st).topology!;
  F.addShell(st, { faces: [faceRefFrom(topo, faceAt(topo, [L / 2 * u, W / 2 * u, H * u]))], thickness: t, name: 'Shell' });
  return {
    slug, title, covers: `shell (open top), ${t} ${unit} walls: thin-wall check`,
    unit, store: st, shape: build(c, st).shape!, volume: (L * W * H - (L - 2 * t) * (W - 2 * t) * (H - t)) * u ** 3, box: mmBox(u, 0, 0, 0, L, W, H), genus: 0, holes: [], minWall: t * u,
  };
}

function draftedBoss(c: Ctx): TestPart {
  // 1 in cube, four sides drafted 5° from the bottom: a frustum.
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 1, 1)), 1, { name: 'Boss' });
  const t = build(c, st).topology!;
  const sides = ([[0.5, 0, 0.5], [1, 0.5, 0.5], [0.5, 1, 0.5], [0, 0.5, 0.5]] as Vec3[]).map((p) => faceRefFrom(t, faceAt(t, p.map((x) => x * IN) as Vec3)));
  F.addDraft(st, { faces: sides, neutral: { base: 'XY' }, angle: 5, name: 'Draft' });
  const top = 1 - 2 * Math.tan((5 * PI) / 180);
  return {
    slug: '09-drafted-boss', title: 'Drafted boss (1 in cube, 5° draft)', covers: 'draft, inclined planes',
    unit: 'in', store: st, shape: build(c, st).shape!, volume: (1 / 3) * (1 + top * top + top) * IN3, box: mmBox(IN, 0, 0, 0, 1, 1, 1), genus: 0, holes: [], minWall: top * IN,
  };
}

function sweptHook(c: Ctx): TestPart {
  // Ø0.2 in rod swept along 1 in straight + R2 quarter arc on the Front plane (Pappus: area x length).
  const st = new DocumentStore();
  const path = st.addSketch('XZ', [
    { id: 'a', kind: 'line', p1: { x: 0, y: -1 }, p2: { x: 0, y: 0 } },
    { id: 'p', kind: 'arc', center: { x: 2, y: 0 }, radius: 2, startAngle: 90, endAngle: 180 },
  ], { name: 'Hook Path' });
  F.addSweep(st, { path, circular: { diameter: 0.2 }, name: 'Hook' });
  // The Front plane's sketch Y is world Z; X is world X. Path: (0,-1)->(0,0) then the arc from (0,0) to (2,2).
  // Box: the rod's radius 0.1 around the path in X/Z, ±0.1 in Y.
  return {
    slug: '10-swept-hook', title: 'Swept rod: Ø0.2 in along a line and an R2 arc', covers: 'sweep (pipe) along a line and an arc',
    unit: 'in', store: st, shape: build(c, st).shape!, volume: PI * 0.01 * (1 + PI) * IN3, box: null, genus: 0, holes: [], minWall: 0.2 * IN,
  };
}

/** The Front plane (XZ) faces -Y, so this offset puts the mirror plane at y = +2 in. */
const MIRROR_Y = -2;
function patternMirror(c: Ctx): TestPart {
  // 6 x 4 x 0.5 plate, 1/4 clearance hole (Ø0.281) patterned 3 x 2 with one skipped (the one at x 4,
  // y 3), a 0.5 x 1 x 1 boss mirrored about a plane through the plate's middle (y = 2), so both bosses
  // stand on the plate. (The first version mirrored about the Front plane, y = 0: the copy landed in
  // the air beside the plate, a separate body, and every tool reported 2 bodies.)
  const st = new DocumentStore();
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 6, 4)), 0.5, { name: 'Plate' });
  const hole = F.addHole(st, { holeType: 'simple', standard: 'ansi-inch', size: '1/4', end: 'through', placement: { base: 'XY', offset: 0.5 }, points: [{ x: 1, y: 1 }], name: '1/4 Hole' });
  F.addLinearPattern(st, { features: [hole], dir1: { axis: 'X' }, spacing1: 1.5, count1: 3, dir2: { axis: 'Y' }, spacing2: 2, count2: 2, skip: [[2, 1]], name: 'Hole Pattern' });
  const boss = st.addExtrude(st.addSketch('XY', rectangleEntities(5, 0.5, 0.5, 1), { offset: 0.5, name: 'Boss Sketch' }), 1, { name: 'Boss' });
  F.addMirror(st, { features: [boss], plane: { base: 'XZ', offset: MIRROR_Y }, name: 'Mirror Boss' });
  const hv = PI * (0.281 / 2) ** 2 * 0.5;
  const pos = [[1, 1], [2.5, 1], [4, 1], [1, 3], [2.5, 3]];
  return {
    slug: '11-pattern-mirror', title: 'Plate with a skipped hole pattern and a mirrored boss (in)', covers: 'linear pattern with skip, mirror feature, separate-looking bosses on one body',
    unit: 'in', store: st, shape: build(c, st).shape!, volume: (12 - 5 * hv + 2 * 0.5) * IN3, box: mmBox(IN, 0, 0, 0, 6, 4, 1.5), genus: 5,
    holes: pos.map(([x, y], k) => zHole(`1/4 clearance ${k + 1}`, 0.281 * IN, x * IN, y * IN, 0, 0.5 * IN)), minWall: 0.5 * IN,
  };
}

// ---------------------------------------------------------------- CHAD print parts (what printer owners make)

function deskOrganiser(c: Ctx): TestPart {
  // A desk organiser, built the way the AI chat builds it: 150 x 80 x 90 mm,
  // 2.4 mm walls with R6 outside and R3.6 inside vertical corners, 3 mm floor, open top, two 2 mm
  // dividers making three equal compartments, sunk 1.2 mm into the side walls so they fuse with them.
  const st = new DocumentStore(); st.setUnits('mm');
  st.setParameter('box_length', '150'); st.setParameter('box_width', '80'); st.setParameter('box_height', '90');
  st.setParameter('wall', '2.4'); st.setParameter('floor_thickness', '3'); st.setParameter('corner_radius', '6'); st.setParameter('divider_thickness', '2');
  st.setParameter('compartment_length', '(box_length - 2*wall - 2*divider_thickness)/3');
  st.addExtrude(st.addSketch('XY', rectangleEntities(0, 0, 'box_length', 'box_width'), { name: 'Outer Sketch' }), 'box_height', { name: 'Outer Body' });
  let t = build(c, st).topology!;
  const outer = ([[0, 0], [150, 0], [150, 80], [0, 80]] as const).map(([x, y]) => edgeRefFrom(t, edgeAt(t, [x, y, 45])));
  F.addFillet(st, { edges: outer, radius: 'corner_radius', name: 'Outer Corner Rounds' });
  st.addExtrude(st.addSketch('XY', rectangleEntities('wall', 'wall', 'box_length - 2*wall', 'box_width - 2*wall'), { name: 'Cavity Sketch', offset: 'floor_thickness' }),
    'box_height - floor_thickness', { operation: 'cut', name: 'Inner Cavity Cut' });
  t = build(c, st).topology!;
  const inner = ([[2.4, 2.4], [147.6, 2.4], [147.6, 77.6], [2.4, 77.6]] as const).map(([x, y]) => edgeRefFrom(t, edgeAt(t, [x, y, 46.5])));
  F.addFillet(st, { edges: inner, radius: 'corner_radius - wall', name: 'Inner Corner Rounds' });
  st.addExtrude(st.addSketch('XY', [
    ...rectangleEntities('wall + compartment_length', 'wall/2', 'divider_thickness', 'box_width - wall'),
    ...rectangleEntities('wall + 2*compartment_length + divider_thickness', 'wall/2', 'divider_thickness', 'box_width - wall'),
  ], { name: 'Divider Sketch', offset: 'floor_thickness' }), 'box_height - floor_thickness', { name: 'Dividers' });
  const L = 150, W = 80, H = 90, w = 2.4, f = 3, r = 6, d = 2;
  const volume = (L * W - (4 - PI) * r * r) * H - ((L - 2 * w) * (W - 2 * w) - (4 - PI) * (r - w) ** 2) * (H - f) + 2 * d * (W - 2 * w) * (H - f);
  return {
    slug: '16-desk-organiser', title: 'Desk organiser (CHAD demo part, 150 x 80 x 90 mm)', covers: 'parameters with formulas, outside and inside corner rounds, pocket cut, dividers fused flush with the walls and top',
    unit: 'mm', store: st, shape: build(c, st).shape!, volume, box: { min: [0, 0, 0], max: [L, W, H] }, genus: 0, holes: [], minWall: d,
  };
}

function phoneStand(c: Ctx): TestPart {
  // A phone stand drawn on the Front plane with an angle parameter and trig in the sketch
  // (lean = 20 deg, backrest top shifted by back_h*tan(lean)), extruded 70 mm mid-plane, a 6 x 10 lip
  // and a Ø10 cable hole through the base. Profile area: base 90 x 6, a 6 mm (horizontal) wide
  // parallelogram 100 tall, lip 6 x 10.
  const st = new DocumentStore(); st.setUnits('mm');
  st.setParameter('lean', '20 deg'); st.setParameter('back_h', '100'); st.setParameter('thick', '6'); st.setParameter('base_len', '90');
  const P = (x: string | number, y: string | number) => ({ x, y });
  const pts = [P(0, 0), P('base_len', 0), P('base_len', 'thick'), P('40 + thick', 'thick'), P('40 + thick - back_h*tan(lean)', 'thick + back_h'),
    P('40 - back_h*tan(lean)', 'thick + back_h'), P(40, 'thick'), P(0, 'thick')];
  st.addExtrude(st.addSketch('XZ', pts.map((p, i) => ({ id: newId('ln'), kind: 'line' as const, p1: p, p2: pts[(i + 1) % pts.length] })), { name: 'Stand Profile' }),
    70, { direction: 'symmetric', name: 'Stand' });
  st.addExtrude(st.addSketch('XZ', rectangleEntities(78, 'thick', 'thick', 10), { name: 'Lip Sketch' }), 70, { direction: 'symmetric', name: 'Lip' });
  st.addExtrude(st.addSketch('XY', [{ id: newId('c'), kind: 'circle', center: { x: 20, y: 0 }, radius: 5 }], { name: 'Cable Hole Sketch' }), 'thick',
    { operation: 'cut', name: 'Cable Hole' }); // only through the base: a through-all cut would also drill the leaning backrest above it
  const lean = (20 * PI) / 180;
  return {
    slug: '17-phone-stand', title: 'Phone stand with a 20° lean from an angle formula (mm)', covers: 'angle parameter and tan() in sketch coordinates, slanted faces, mid-plane extrudes, a hole through the base',
    unit: 'mm', store: st, shape: build(c, st).shape!, volume: (90 * 6 + 6 * 100 + 6 * 10) * 70 - PI * 25 * 6, box: { min: [0, -35, 0], max: [90, 35, 106] }, genus: 1,
    holes: [zHole('Ø10 cable hole', 10, 20, 0, 0, 6)], minWall: 6 * Math.cos(lean),
  };
}

function splineVase(c: Ctx): TestPart {
  // A vase: a spline profile revolved about the Top-plane Y axis (surface of revolution of a B-spline),
  // then shelled 2 mm with the top open. No closed form: judged against the exact model.
  const st = new DocumentStore(); st.setUnits('mm');
  const ents: SketchEntity[] = [
    { id: 'ax', kind: 'line', p1: { x: 0, y: -10 }, p2: { x: 0, y: -5 }, construction: true },
    { id: newId('ln'), kind: 'line', p1: { x: 0, y: 0 }, p2: { x: 25, y: 0 } },
    { id: newId('sp'), kind: 'spline', points: [{ x: 25, y: 0 }, { x: 32, y: 20 }, { x: 22, y: 45 }, { x: 15, y: 60 }, { x: 18, y: 72 }] },
    { id: newId('ln'), kind: 'line', p1: { x: 18, y: 72 }, p2: { x: 0, y: 72 } },
    { id: newId('ln'), kind: 'line', p1: { x: 0, y: 72 }, p2: { x: 0, y: 0 } },
  ];
  st.addRevolve(st.addSketch('XY', ents, { name: 'Vase Profile' }), 'ax', 360, { name: 'Vase Body' });
  const topo = build(c, st).topology!;
  F.addShell(st, { faces: [faceRefFrom(topo, faceAt(topo, [0, 72, 0]))], thickness: 2, name: 'Vase Shell' });
  return {
    slug: '18-spline-vase', title: 'Vase: revolved spline profile, shelled 2 mm, open top (mm)', covers: 'revolve of a B-spline (surface of revolution), shell (offset) of a free-form face',
    unit: 'mm', store: st, shape: build(c, st).shape!, volume: null, box: null, genus: 0, holes: [], minWall: null,
  };
}

// ---------------------------------------------------------------- organic parts (no closed form)

function chatCtx(c: Ctx, store: DocumentStore): ExecutorContext {
  return {
    store,
    regen: async () => { const r = rebuild(c, store); return { mesh: null, status: r.status, sketches: r.sketches, mass: null, topology: r.topology ?? null, ms: 0 }; },
    selection: () => [], info: async () => { throw new Error('not used'); },
  };
}

async function organicFigure(c: Ctx): Promise<TestPart> {
  const store = new DocumentStore(); store.setUnits('mm');
  const ring = (n: number, rx: number, ry: number): [number, number][] => Array.from({ length: n }, (_, i) => { const q = (2 * PI * i) / n; return [+(rx * Math.cos(q)).toFixed(6), +(ry * Math.sin(q)).toFixed(6)]; });
  const sec = (i: number, z: number, s: number) => ({ tool: 'create_sketch', args: { plane: 'XY', offset: z, name: `Body Section ${i}`, entities: [{ type: 'spline', closed: true, points: ring(10, 14 * s, 10 * s) }] } });
  const res: any = await executeTool(chatCtx(c, store), 'build_model', { steps: [
    sec(1, 0, 1), sec(2, 15, 1.25), sec(3, 30, 1.1), sec(4, 45, 0.7),
    { tool: 'loft', args: { profile_sketch_ids: ['Body Section 1', 'Body Section 2', 'Body Section 3', 'Body Section 4'], end_point: [0, 0, 55], name: 'Body' } },
    { tool: 'create_sketch', args: { plane: 'XZ', offset: 5, name: 'Nose Profile', entities: [{ type: 'circle', cx: 0, cy: 28, diameter: 7 }] } },
    { tool: 'extrude', args: { sketch_id: 'Nose Profile', depth: 12, direction: 'normal', operation: 'add', name: 'Nose' } },
    { tool: 'fillet', args: { edges: [{ between: ['Body', 'Nose'] }], radius: 2, name: 'Nose Blend' } },
  ] });
  if (!res.ok) throw new Error(JSON.stringify(res));
  return { slug: '12-organic-figure', title: 'Organic figure from the chat (spline loft, nose, blend fillet, mm)', covers: 'B-spline loft to a point, boolean with a cylinder, variable blend', unit: 'mm', store, shape: build(c, store).shape!, volume: null, box: null, genus: 0, holes: [], minWall: null };
}

async function figureWithArm(c: Ctx): Promise<TestPart> {
  const store = new DocumentStore();
  const ctx = chatCtx(c, store);
  await executeTool(ctx, 'profile_body', { name: 'Body', end: 'round', stations: [{ at: 0, x: 1, y: [-0.8, 0.8] }, { at: 1.5, x: 1.2, y: [-1, 0.9] }, { at: 3, x: 0.9, y: [-0.7, 0.7] }] });
  await executeTool(ctx, 'tube', { name: 'Arm', path: [[0.8, 0, 2], [1.5, -0.3, 1.4], [1.7, -0.5, 0.8]], radii: [0.3, 0.22, 0.18], start_end: 'flat', finish_end: 'round' });
  return { slug: '13-figure-with-arm', title: 'Sculpted body with an arm tube (chat sculpting tools, in)', covers: 'free-form faces joined along a curve (hardest case for meshing)', unit: 'in', store, shape: build(c, store).shape!, volume: null, box: null, genus: 0, holes: [], minWall: null };
}

/** Seams (loft / mirror ids) of the reference builds that once failed, from tests/step-periodic.test.ts: the hard cases. */
const HEAD_SEAMS: Record<string, string> = {
  Chest: 'lo_vltf0l60', Head: 'lo_wdkewnn9', Nose: 'lo_p8zbfu2n', 'Left Eye Socket': 'lo_ay22jy9x', 'Right Eye Socket': 'mi_7yasok3q',
  'Left Nostril': 'lo_tbwdn59t', 'Right Nostril': 'mi_cnefl7c7', Mouth: 'lo_pwyj61ue', 'Mouth Line': 'lo_bu5ty7k0',
  'Left Ear': 'lo_0yz27x0n', 'Left Ear Groove': 'lo_g2mhsi68', 'Right Ear': 'mi_fhzivvie',
};
const BEAR_SEAMS: Record<string, string> = {
  Body: 'lo_qsvdcskq', Head: 'lo_uzi64j90', Muzzle: 'lo_x4q0hgve', Nose: 'lo_molqruxx', 'Mouth Line': 'lo_67soxfew', 'Mouth Center Line': 'lo_metitdmm',
  'Left Eye': 'lo_5hu2lmec', 'Right Eye': 'mi_ujth0sta', 'Left Ear': 'lo_g5hnldy4', 'Left Inner Ear': 'lo_y5o55bes', 'Right Ear': 'mi_92419ghg',
  'Left Arm': 'lo_a3s54c5v', 'Right Arm': 'mi_njfuv2lp', 'Left Leg': 'lo_70hwjhlm', 'Left Foot Pad': 'lo_o878o0yu', 'Right Leg': 'mi_ms3omv95',
};

/** A worked example from the chat's reference library: as the app builds it now (seams: null), or with recorded seams. */
async function referenceExample(c: Ctx, slug: string, title: string, subject: string, seams: Record<string, string> | null): Promise<TestPart> {
  const tmp = new DocumentStore();
  const ref: any = await executeTool(chatCtx(c, tmp), 'get_reference', { subject });
  await executeTool({ ...chatCtx(c, tmp), regen: async () => ({ mesh: null, status: [], sketches: [], mass: null, topology: null, ms: 0 }) }, 'build_model', { steps: ref.example.steps });
  const store = new DocumentStore(seams ? withRecordedSeams(tmp.state, seams) : JSON.parse(JSON.stringify(tmp.state)));
  const how = seams ? 'with the seams of a build that once failed (hard case)' : 'as the chat builds it today';
  return { slug, title, covers: `the chat's worked organic example ${how}: many lofts, mirrors, booleans`, unit: store.state.units, store, shape: build(c, store).shape!, volume: null, box: null, genus: 0, holes: [], minWall: null };
}

/** The test set, built one part at a time (organic parts are large: building them all first runs the WASM kernel out of memory). */
export const TEST_SET: { slug: string; make: (c: Ctx) => TestPart | Promise<TestPart> }[] = [
  { slug: '01-plate-with-holes', make: plateWithHoles },
  { slug: '02-fillet-chamfer-block', make: filletChamferBlock },
  { slug: '03-bolt-circle-flange', make: boltCircleFlange },
  { slug: '04-revolved-ring', make: revolvedRing },
  { slug: '05-l-bracket', make: lBracket },
  { slug: '06-hole-gauge', make: holeGauge },
  { slug: '07-countersink-tapped', make: countersinkTapped },
  { slug: '08a-shelled-box', make: (c) => shelledBox(c, '08a-shelled-box', 'Shelled box, open top, 0.1 in walls (4 x 3 x 2 in)', 'in', 4, 3, 2, 0.1) },
  { slug: '08b-thin-wall-cup', make: (c) => shelledBox(c, '08b-thin-wall-cup', 'Thin-wall cup, open top, 0.8 mm walls (40 x 30 x 20 mm)', 'mm', 40, 30, 20, 0.8) },
  { slug: '09-drafted-boss', make: draftedBoss },
  { slug: '10-swept-hook', make: sweptHook },
  { slug: '11-pattern-mirror', make: patternMirror },
  { slug: '12-organic-figure', make: organicFigure },
  { slug: '13-figure-with-arm', make: figureWithArm },
  { slug: '14-easter-island-head', make: (c) => referenceExample(c, '14-easter-island-head', 'Easter Island head (chat example, as built today)', 'easter island head', null) },
  { slug: '14b-easter-island-head-hard-seams', make: (c) => referenceExample(c, '14b-easter-island-head-hard-seams', 'Easter Island head (recorded hard seams)', 'easter island head', HEAD_SEAMS) },
  { slug: '15-cartoon-bear', make: (c) => referenceExample(c, '15-cartoon-bear', 'Cartoon bear (chat example, as built today)', 'cartoon bear', null) },
  { slug: '15b-cartoon-bear-hard-seams', make: (c) => referenceExample(c, '15b-cartoon-bear-hard-seams', 'Cartoon bear (recorded hard seams)', 'cartoon bear', BEAR_SEAMS) },
  { slug: '16-desk-organiser', make: deskOrganiser },
  { slug: '17-phone-stand', make: phoneStand },
  { slug: '18-spline-vase', make: splineVase },
];
