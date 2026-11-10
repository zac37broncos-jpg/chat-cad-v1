import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import init from 'replicad-opencascadejs';
import { DocumentStore } from '../src/core/store';
import { rectangleEntities, newId } from '../src/core/model';
import { regenerate, type OC } from '../src/kernel/regen';
import { drawingGeometry } from '../src/kernel/hlr';
import { massProperties } from '../src/kernel/query';
import { composeSheet, viewRequests, resolveViews, dimensionValue, lineLengthParam, type ComposeInput } from '../src/drawing/compose';
import { createStandardDrawing, insertModelItems, addSectionView, addDetailView, addAuxiliaryView, defaultBomAnchor } from '../src/drawing/layout';
import { dimTextString } from '../src/drawing/format';
import { dimDisplay } from '../src/drawing/compose';
import { buildPdf } from '../src/drawing/export/pdf';
import { buildDxf } from '../src/drawing/export/dxf';
import { sheetSvg } from '../src/drawing/export/svg';
import { sheetSize } from '../src/drawing/standards';
import { dwgId, type DrawingDocument } from '../src/drawing/model';

const IN = 25.4;
let oc: OC;
const OUT = process.env.CHATCAD_TEST_OUT;
beforeAll(async () => { oc = await init(); });

function bracket() {
  const st = new DocumentStore();
  st.renameDocument('Bracket');
  st.setParameter('L', '4'); st.setParameter('W', '2'); st.setParameter('T', '0.5');
  const base = st.addSketch('XY', rectangleEntities(0, 0, 'L', 'W'), { name: 'Base Sketch' });
  st.addExtrude(base, 'T', { name: 'Base Plate' });
  const holes = st.addSketch('XY', [
    { id: newId('c'), kind: 'circle', center: { x: 0.5, y: 'W/2' }, radius: '0.25/2' },
    { id: newId('c'), kind: 'circle', center: { x: 'L-0.5', y: 'W/2' }, radius: '0.25/2' },
  ], { name: 'Hole Sketch' });
  st.addExtrude(holes, 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Mounting Holes' });
  st.setMaterial({ name: 'Aluminum 6061-T6', density: 2.70 });
  return st;
}

function compute(doc: DrawingDocument, part: any, sheetIndex = 0): ComposeInput {
  const r = regenerate(oc, part);
  const geometry = { ...drawingGeometry(oc, r.shape, viewRequests(doc, doc.sheets[sheetIndex])), sketches: r.sketches };
  return { doc, sheetIndex, part, geometry, volume: massProperties(oc, r.shape!).volume };
}

describe('drawing composition', () => {
  it('builds a standard 3-view drawing with model dimensions, section, detail, aux, GD&T and BOM, and exports it', () => {
    const st = bracket();
    const part = st.state;
    const r = regenerate(oc, part);
    const g0 = drawingGeometry(oc, r.shape, []);
    const doc = createStandardDrawing(part, g0.model);
    const sheet = doc.sheets[0];
    expect(sheet.views.length).toBe(4);
    expect(sheet.scale).toEqual([2, 1]); // 4 x 2 x 0.5 in: largest standard scale that fits a B sheet
    // Model items
    const added = insertModelItems(doc, 0, part, g0.model, r.sketches);
    const input = compute(doc, part);
    const rvs = resolveViews(doc, sheet, input.geometry);
    const texts = added.map((a) => {
      if (a.kind !== 'dim') return '';
      const rv = rvs.find((x) => x.view.id === a.view)!;
      return dimTextString(dimDisplay(a, dimensionValue(a, rv, part, input.geometry!.model, input.geometry!.sketches)!, doc));
    });
    expect(texts).toContain('2X Ø.250');
    expect(texts).toContain('4.000');
    expect(texts).toContain('2.000');
    expect(texts).toContain('.500');
    // Section A-A through the holes (cutting line across the top view along y = W/2, looking back).
    const top = sheet.views.find((v) => v.kind === 'projected' && v.dir[1] === 1)!;
    const front = sheet.views[0];
    addSectionView(doc, sheet, top.id, [-0.2 * IN, 1 * IN], [4.2 * IN, 1 * IN], [0, -1], [front.position[0], front.position[1] - 2 * IN]);
    addDetailView(doc, sheet, front.id, [0.5 * IN, 0.25 * IN], 0.4 * IN, [2, 1], [front.position[0] + 5 * IN, front.position[1] - 2 * IN]);
    addAuxiliaryView(doc, sheet, front.id, [[0, 0.5 * IN], [4 * IN, 0.5 * IN]], [0, 1], [front.position[0], front.position[1] + 3 * IN]);
    sheet.annotations.push({ id: dwgId('fcf'), kind: 'fcf', at: [60, 60], rows: [{ sym: 'position', dia: true, tol: '.010', mod: 'M', datums: [{ letter: 'A', mod: '' }, { letter: 'B', mod: '' }] }] });
    sheet.annotations.push({ id: dwgId('d'), kind: 'datum', letter: 'A', at: [40, 40], attach: { paper: [40, 30] } });
    sheet.annotations.push({ id: dwgId('bom'), kind: 'bom', at: defaultBomAnchor(doc, 0) });
    sheet.annotations.push({ id: dwgId('n'), kind: 'note', at: [20, 200], text: 'NOTES:\n1. BREAK ALL SHARP EDGES .010 MAX.' });
    const res = composeSheet(compute(doc, part));
    expect(res.warnings).toEqual([]);
    const allText = res.prims.filter((p) => p.t === 'text').map((p: any) => p.s);
    expect(allText).toContain('SECTION A-A');
    expect(allText).toContain('DETAIL B');
    expect(allText).toContain('SCALE 2:1');
    expect(allText).toContain('VIEW C');
    expect(allText).toContain('ALUMINUM 6061-T6');
    expect(allText.some((t: string) => /lb$/.test(t))).toBe(true);
    expect(res.prims.some((p) => p.t === 'curve' && p.lt === 'hatch')).toBe(true);
    expect(res.prims.some((p) => p.t === 'curve' && p.lt === 'center')).toBe(true);
    // Exports at true scale.
    const sz = sheetSize(sheet.size);
    const pdf = buildPdf([{ w: sz.w, h: sz.h, prims: res.prims, standard: doc.standard }]);
    const pdfText = new TextDecoder('latin1').decode(pdf);
    expect(pdfText).toContain('/MediaBox [0 0 1224 792]'); // 17 x 11 in
    const dxf = buildDxf(res.prims, sz.w, sz.h, doc.standard);
    expect(dxf).toContain('AC1009');
    expect(dxf).toContain('%%c.250');
    const svg = sheetSvg(res.prims, sz.w, sz.h, doc.standard);
    expect(svg).toContain('width="431.8mm"');
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/bracket.pdf`, pdf); writeFileSync(`${OUT}/bracket.dxf`, dxf); writeFileSync(`${OUT}/bracket.svg`, svg);
    }
  });

  it('views follow model changes (parametric update)', () => {
    const st = bracket();
    const r = regenerate(oc, st.state);
    const doc = createStandardDrawing(st.state, drawingGeometry(oc, r.shape, []).model);
    insertModelItems(doc, 0, st.state, drawingGeometry(oc, r.shape, []).model, r.sketches);
    st.setParameter('L', '5');
    const input = compute(doc, st.state);
    const res = composeSheet(input);
    expect(res.warnings).toEqual([]);
    const allText = res.prims.filter((p) => p.t === 'text').map((p: any) => p.s);
    expect(allText).toContain('5.000');
  });

  it('point-to-edge dimension measures perpendicular and follows the edge', () => {
    const st = bracket();
    const r = regenerate(oc, st.state);
    const model = drawingGeometry(oc, r.shape, []).model!;
    const doc = createStandardDrawing(st.state, model);
    const sheet = doc.sheets[0];
    const top = sheet.views[1];
    // Right-hand hole (x = L - 0.5) to the right edge of the top face (x = L, z = T).
    const hole = model.circles.find((c) => Math.abs(c.c[0] - 3.5 * IN) < 1e-6 && Math.abs(c.c[2] - 0.5 * IN) < 1e-6)!;
    const edge = model.lines.find((l) => Math.abs(l.a[0] - 4 * IN) < 1e-6 && Math.abs(l.b[0] - 4 * IN) < 1e-6 && Math.abs(l.a[2] - 0.5 * IN) < 1e-6 && Math.abs(l.b[2] - 0.5 * IN) < 1e-6)!;
    expect(hole && edge).toBeTruthy();
    sheet.annotations.push({ id: 'd1', kind: 'dim', dimType: 'linear', orient: 'h', view: top.id, at: [90, 60], tol: { type: 'none' },
      refs: [{ k: 'circle', c: hole.c, r: hole.r, n: hole.n, ei: hole.i }, { k: 'line', a: edge.a, b: edge.b, ei: edge.i }] } as any);
    const check = (expected: number) => {
      const input = compute(doc, st.state);
      const res = composeSheet(input);
      expect(res.warnings).toEqual([]);
      const rv = resolveViews(doc, sheet, input.geometry).find((v) => v.view.id === top.id)!;
      expect(dimensionValue(sheet.annotations.find((a) => a.id === 'd1') as any, rv, st.state, input.geometry!.model, input.geometry!.sketches)! / IN).toBeCloseTo(expected, 6);
    };
    check(0.5);
    // Moving the hole changes the measured distance; the refs re-resolve by index.
    st.setParameter('L', '5');
    check(0.5);
  });

  it('rectangle side lengths map to their parameters', () => {
    const st = bracket();
    const sk = st.state.features.find((f) => f.name === 'Base Sketch')! as any;
    const params = sk.entities.map((e: any) => lineLengthParam(st.state, sk.id, e.id));
    expect(params).toEqual(['L', 'W', 'L', 'W']);
  });

  it('ISO A3 first-angle drawing in mm', () => {
    const st = bracket(); // modelled in inches; the ISO drawing is dimensioned in mm
    const r = regenerate(oc, st.state);
    const g0 = drawingGeometry(oc, r.shape, []);
    const doc = createStandardDrawing(st.state, g0.model, { standard: 'ISO' });
    expect(doc.sheets[0].size).toBe('A3');
    expect(doc.projection).toBe('first');
    const top = doc.sheets[0].views[1];
    expect(top.kind === 'projected' && top.dir[1]).toBe(-1); // top view below front in first angle
    insertModelItems(doc, 0, st.state, g0.model, r.sketches);
    const res = composeSheet(compute(doc, st.state));
    const allText = res.prims.filter((p) => p.t === 'text').map((p: any) => p.s);
    expect(allText).toContain('101.6');
    expect(allText).toContain('2X Ø6.35');
    const sz = sheetSize('A3');
    if (OUT) writeFileSync(`${OUT}/bracket-iso.pdf`, buildPdf([{ w: sz.w, h: sz.h, prims: res.prims, standard: 'ISO' }]));
  });
});
