import { describe, it, expect, beforeAll } from 'vitest';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, newId } from '../src/core/model';
import { regenerate, type OC } from '../src/kernel/regen';
import { drawingGeometry } from '../src/kernel/hlr';
import { STD_FRAMES, projectedFrame, v3, project, type ViewFrame } from '../src/drawing/views';
import { boundsOf, removeCovered, clipToCircle, hatchSegments, type Curve2 } from '../src/drawing/geom2d';

const IN = 25.4;
let oc: OC;
beforeAll(async () => { oc = await init(); });

function bracket() {
  const st = new DocumentStore();
  st.setParameter('L', '4'); st.setParameter('W', '2'); st.setParameter('T', '0.5');
  const base = st.addSketch('XY', rectangleEntities(0, 0, 'L', 'W'));
  st.addExtrude(base, 'T');
  const holes = st.addSketch('XY', [
    { id: newId('c'), kind: 'circle', center: { x: 0.5, y: 'W/2' }, radius: '0.25/2' },
    { id: newId('c'), kind: 'circle', center: { x: 'L-0.5', y: 'W/2' }, radius: '0.25/2' },
  ]);
  st.addExtrude(holes, 0, { operation: 'cut', throughAll: true, direction: 'symmetric' });
  return st;
}

const sameFrame = (a: ViewFrame, b: ViewFrame) => {
  for (const k of ['x', 'y', 'z'] as const) for (let i = 0; i < 3; i++) expect(a[k][i]).toBeCloseTo(b[k][i], 12);
};

describe('view frames (ASME third angle / ISO first angle)', () => {
  it('standard frames are right-handed and orthonormal', () => {
    for (const f of Object.values(STD_FRAMES)) {
      const c = v3.cross(f.x, f.y);
      for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(f.z[i], 12);
      expect(v3.dot(f.x, f.y)).toBeCloseTo(0, 12);
    }
  });
  it('third angle: top above front, right to the right', () => {
    sameFrame(projectedFrame(STD_FRAMES.front, [0, 1], 'third'), STD_FRAMES.top);
    sameFrame(projectedFrame(STD_FRAMES.front, [1, 0], 'third'), STD_FRAMES.right);
    sameFrame(projectedFrame(STD_FRAMES.front, [-1, 0], 'third'), STD_FRAMES.left);
    sameFrame(projectedFrame(STD_FRAMES.front, [0, -1], 'third'), STD_FRAMES.bottom);
  });
  it('first angle: top below front, right view on the left', () => {
    sameFrame(projectedFrame(STD_FRAMES.front, [0, -1], 'first'), STD_FRAMES.top);
    sameFrame(projectedFrame(STD_FRAMES.front, [-1, 0], 'first'), STD_FRAMES.right);
  });
  it('projected views stay aligned with the parent', () => {
    // A model point keeps its paper coordinate along the fold line.
    const p: [number, number, number] = [12.3, -4.5, 7.8];
    expect(project(p, projectedFrame(STD_FRAMES.front, [0, 1], 'third'))[0]).toBeCloseTo(project(p, STD_FRAMES.front)[0], 12);
    expect(project(p, projectedFrame(STD_FRAMES.front, [1, 0], 'third'))[1]).toBeCloseTo(project(p, STD_FRAMES.front)[1], 12);
  });
});

describe('exact hidden-line views', () => {
  it('front / top views of the bracket have exact outlines, holes and hidden lines', () => {
    const r = regenerate(oc, bracket().state);
    const g = drawingGeometry(oc, r.shape, [
      { id: 'front', frame: STD_FRAMES.front },
      { id: 'top', frame: STD_FRAMES.top },
      { id: 'iso', frame: STD_FRAMES.iso },
    ]);
    const [front, top, iso] = g.views;
    expect(front.error).toBeUndefined();
    const fb = boundsOf(front.visible)!;
    expect(fb.max[0] - fb.min[0]).toBeCloseTo(4 * IN, 9);
    expect(fb.max[1] - fb.min[1]).toBeCloseTo(0.5 * IN, 9);
    // Hidden hole walls: 4 vertical lines at x = 0.5 ± 0.125 and 3.5 ± 0.125 in.
    const hx = front.hidden.filter((c): c is Extract<Curve2, { k: 'line' }> => c.k === 'line' && Math.abs(c.a[0] - c.b[0]) < 1e-9).map((c) => c.a[0] / IN).sort((a, b) => a - b);
    expect(hx.length).toBe(4);
    [0.375, 0.625, 3.375, 3.625].forEach((x, i) => expect(hx[i]).toBeCloseTo(x, 9));
    // Top view: two full circles, r = 0.125 in, no hidden duplicates of visible geometry.
    const circles = top.visible.filter((c) => c.k === 'arc') as Extract<Curve2, { k: 'arc' }>[];
    expect(circles.length).toBe(2);
    for (const c of circles) { expect(c.r).toBeCloseTo(0.125 * IN, 12); expect(c.a1 - c.a0).toBeCloseTo(2 * Math.PI, 12); }
    expect(top.hidden.length).toBe(0);
    // Iso: holes become exact ellipses.
    expect(iso.visible.some((c) => c.k === 'ellipse')).toBe(true);
    // Anchors: circles and cylinder axes.
    expect(g.model!.axes.filter((a) => a.full).length).toBe(2);
    expect(g.model!.circles.length).toBe(4);
  });

  it('section view cuts through the holes and reports hatch boundaries', () => {
    const r = regenerate(oc, bracket().state);
    // Cutting line in the top view along y = W/2, looking toward +Y (third angle, view placed below top -> d = (0,-1)).
    const top = STD_FRAMES.top;
    const frame = projectedFrame(top, [0, -1], 'third');
    sameFrame(frame, STD_FRAMES.front);
    const g = drawingGeometry(oc, r.shape, [{ id: 's', frame, section: { point: [0, 1 * IN, 0] } }]);
    const s = g.views[0];
    expect(s.error).toBeUndefined();
    expect(s.section.length).toBeGreaterThan(0);
    // The cut face is the 4 x 0.5 rectangle minus two 0.25 wide slots: hatch area = (4 - 0.5) * 0.5 in².
    const segs = hatchSegments(s.section, Math.PI / 2, 0.001 * IN); // vertical hatch, fine spacing
    const area = segs.reduce((a, [p, q]) => a + Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.001 * IN, 0);
    expect(area / (IN * IN)).toBeCloseTo(3.5 * 0.5, 2);
    // Hole walls cut in half are now visible lines (x = 0.375, 0.625 ...).
    const vx = s.visible.filter((c): c is Extract<Curve2, { k: 'line' }> => c.k === 'line' && Math.abs(c.a[0] - c.b[0]) < 1e-9).map((c) => +(c.a[0] / IN).toFixed(6));
    for (const x of [0.375, 0.625, 3.375, 3.625]) expect(vx).toContain(x);
  });
});

describe('2D exact operations', () => {
  it('removes hidden lines covered by visible ones', () => {
    const vis: Curve2[] = [{ k: 'line', a: [0, 0], b: [10, 0] }];
    const hid = removeCovered([{ k: 'line', a: [5, 0], b: [15, 0] }, { k: 'arc', c: [0, 0], r: 1, a0: 0, a1: Math.PI }], vis);
    expect(hid[0]).toEqual({ k: 'line', a: [10, 0], b: [15, 0] });
    const arcs = removeCovered([{ k: 'arc', c: [0, 0], r: 1, a0: 0, a1: 2 * Math.PI }], [{ k: 'arc', c: [0, 0], r: 1, a0: -Math.PI / 2, a1: Math.PI / 2 }]);
    expect(arcs.length).toBe(1);
    expect((arcs[0] as any).a1 - (arcs[0] as any).a0).toBeCloseTo(Math.PI, 12);
  });
  it('clips lines, circles and ellipses exactly to a detail circle', () => {
    const l = clipToCircle({ k: 'line', a: [-10, 0], b: [10, 0] }, [0, 0], 3)[0] as any;
    expect(l.a[0]).toBeCloseTo(-3, 12); expect(l.b[0]).toBeCloseTo(3, 12);
    const full = clipToCircle({ k: 'arc', c: [2, 0], r: 2, a0: 0, a1: 2 * Math.PI }, [0, 0], 2);
    expect(full.length).toBe(1);
    const a = full[0] as any;
    expect(a.a1 - a.a0).toBeCloseTo((2 * Math.PI) / 3, 12); // the part of circle 2 inside circle 1 spans 120°
    const el = clipToCircle({ k: 'ellipse', c: [0, 0], rx: 4, ry: 1, rot: 0, t0: 0, t1: 2 * Math.PI }, [4, 0], 1);
    expect(el.length).toBe(1);
  });
});
