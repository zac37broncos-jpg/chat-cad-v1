/**
 * Builds the printability test set and exports every part exactly the way the app's Export STL
 * and Export STEP buttons do (exportStlFile / exportStepFile with the panels' presets), then
 * writes the files and a manifest of what each part should be (hand calculations) to
 * verify/print/out/. The independent checker (check_parts.py) judges the files with tools that
 * share no code with the app.
 *
 * Run: npm run verify:print   (see docs/PRINT_VERIFICATION.md)
 */
import { it, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import init from 'replicad-opencascadejs';
import type { OC } from '../../src/kernel/regen';
import { exactBox } from '../../src/kernel/exporters';
import { exportStlFile, exportStepFile, type StlOptions } from '../../src/kernel/exporters';
import { STL_PRESETS } from '../../src/kernel/exportDefaults';
import { createSketchSolver, type SketchSolver } from '../../src/sketch/solver';
import { TEST_SET, releaseBuilt } from './parts';

/**
 * The model's volume for the checker, integrated tighter than the app does (Gauss-Kronrod at 1e-9).
 * The app's exactVolume uses 1e-6, which on the sculpted figure with an arm came out 2.2e-6 of the
 * volume (0.39 mm³) low: OpenCascade 7.8 gives the same low number on the STEP file at 1e-6, and agrees
 * with the plain integration at 1e-9 and 1e-12 to 2e-9 when tighter.
 */
function referenceVolume(oc: OC, s: any): number {
  const p = new oc.GProp_GProps();
  (oc.BRepGProp as any).VolumePropertiesGK(s, p, 1e-9, false, true, false, false, false);
  const v = p.Mass();
  p.delete();
  return v;
}


const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
let oc: OC;
let solver: SketchSolver;
beforeAll(async () => { oc = await init(); solver = await createSketchSolver(); });

it('exports the test set', async () => {
  // VERIFY_PARTS=05,14 builds only the parts whose slugs start with those prefixes.
  const only = (process.env.VERIFY_PARTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const set = TEST_SET.filter((t) => !only.length || only.some((o) => t.slug.startsWith(o)));
  if (!only.length) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const manifest: any[] = [];
  for (const t of set) {
    const p = await t.make({ oc, solver });
    const dir = join(OUT, p.slug);
    mkdirSync(dir, { recursive: true });
    const name = p.store.state.name && p.store.state.name !== 'Part1' ? p.store.state.name : p.title;
    writeFileSync(join(dir, `${p.slug}.chatcad.json`), p.store.serialize());
    const files: Record<string, any> = {};
    // STL: the three presets in mm binary (the default), Fine in ASCII and in inches (the pitfall case).
    const stl = (key: string, o: Omit<StlOptions, 'name'>) => {
      const t0 = performance.now();
      const { data, report } = exportStlFile(oc, p.shape, { ...o, name });
      const file = `${p.slug}-${key}.stl`;
      writeFileSync(join(dir, file), data);
      files[key] = { file, kind: 'stl', ms: Math.round(performance.now() - t0), options: o, report };
    };
    // VERIFY_PRESETS=draft,fine limits the STL presets (Extra fine of a large organic part is slow).
    const presets = (process.env.VERIFY_PRESETS ?? '').split(',').filter(Boolean);
    for (const pr of STL_PRESETS.filter((x) => !presets.length || presets.includes(x.id))) stl(`${pr.id}-mm-binary`, { linearDeflection: pr.linearDeflection, angularDeflection: pr.angularDeflection, unit: 'mm', format: 'binary' });
    const fine = STL_PRESETS.find((x) => x.id === 'fine')!;
    stl('fine-mm-ascii', { linearDeflection: fine.linearDeflection, angularDeflection: fine.angularDeflection, unit: 'mm', format: 'ascii' });
    stl('fine-in-binary', { linearDeflection: fine.linearDeflection, angularDeflection: fine.angularDeflection, unit: 'in', format: 'binary' });
    // STEP: AP214 in the part's unit (the panel default) and in the other unit, AP242 in mm.
    const other = p.unit === 'in' ? 'mm' : 'in';
    for (const [key, unit, schema] of [[`ap214-${p.unit}`, p.unit, 'AP214'], [`ap214-${other}`, other, 'AP214'], ['ap242-mm', 'mm', 'AP242']] as const) {
      const t0 = performance.now();
      const { text, report } = exportStepFile(oc, p.shape, { unit, schema, name, fileName: `${p.slug}.step` });
      const file = `${p.slug}-${key}.step`;
      writeFileSync(join(dir, file), text);
      files[key] = { file, kind: 'step', ms: Math.round(performance.now() - t0), options: { unit, schema }, report };
    }
    const box = exactBox(oc, p.shape);
    manifest.push({
      slug: p.slug, title: p.title, covers: p.covers, unit: p.unit, name,
      expected: { volume: p.volume, box: p.box, genus: p.genus, holes: p.holes, minWall: p.minWall },
      model: { volume: referenceVolume(oc, p.shape), box: { min: box.min, max: box.max } },
      files,
    });
    releaseBuilt();
    writeFileSync(join(dir, 'manifest-entry.json'), JSON.stringify(manifest[manifest.length - 1], null, 1));
    console.log(`${p.slug}: ${Object.values(files).map((f: any) => `${f.file.replace(p.slug + '-', '')} ${(f.report.ok ?? f.report.watertight) ? 'ok' : 'PROBLEM'} ${f.ms} ms`).join(', ')}`);
  }
  if (!only.length) writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ generated: new Date().toISOString(), parts: manifest }, null, 1));
}, 1_800_000);
