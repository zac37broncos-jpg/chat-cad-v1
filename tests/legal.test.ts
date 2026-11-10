import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error plain JS module
import { productionPackages } from '../scripts/third-party-notices.mjs';

// Guards CHAD's licence obligations (docs/LICENSES.md): licence notices ship with the app, no new
// dependency brings a licence nobody reviewed, and no other company's product names or trademarks
// come back into the code, the docs, what the user sees or what the AI chat is told.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const lock = JSON.parse(read('package-lock.json'));

/** Licences reviewed for CHAD (docs/LICENSES.md). A new one fails here until it is reviewed and added. */
const REVIEWED_RUNTIME = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'LGPL-2.1-only', 'LGPL-2.0-or-later']);
const REVIEWED_DEV = new Set([...REVIEWED_RUNTIME, 'MPL-2.0', 'BlueOak-1.0.0', 'CC0-1.0', 'Python-2.0', 'CC-BY-4.0']);
/** The only copyleft libraries CHAD may use, each with its obligations written down in docs/LICENSES.md. */
const LGPL_ALLOWED = new Set(['replicad-opencascadejs', '@salusoft89/planegcs']);

/** Words that name other companies' products or trademarks (case-sensitive, as they would be written). */
const THIRD_PARTY_MARKS = /SolidWorks|SOLIDWORKS|FeatureManager|PropertyManager|CommandManager|Hole Wizard|Instant3D|Smart Dimension|Copilot|Mastercam|Onshape|Fusion 360|Autodesk|Dassault|Claude Code Agent/;
/** The same names in any spelling, for code comments and docs (Onshape and Fusion as whole words, so "PointOnShape" and "Confusion" pass). */
const THIRD_PARTY_MARKS_ANY_CASE = /solid ?works|featuremanager|propertymanager|commandmanager|hole wizard|instant3d|smart dimension|copilot|mastercam|\bonshape\b|\bfusion\b|autodesk|dassault/i;

/** String literals and JSX text of a TS/TSX source, with comments and import lines removed. */
function shownText(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/^\s*(import|export)\s[^;]*\sfrom\s.*$/gm, '');
  const out: string[] = [];
  for (const m of code.matchAll(/'([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*"|`([^`\\]|\\.)*`/g)) out.push(m[0]);
  for (const m of code.matchAll(/>([^<>{}]+)</g)) out.push(m[1]);
  return out;
}

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const f of readdirSync(join(root, dir))) {
    const p = `${dir}/${f}`;
    if (statSync(join(root, p)).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(p)) out.push(p);
  }
  return out;
}

describe('CHAD legal guards', () => {
  it('ships an up-to-date third-party notices file with the app', () => {
    execFileSync(process.execPath, [join(root, 'scripts/third-party-notices.mjs'), '--check'], { cwd: root });
    const n = read('public/THIRD_PARTY_NOTICES.txt');
    expect(n).toContain('Open CASCADE Technology');
    expect(n).toContain('OCCT-exception-1.0');
    expect(n).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(n).toContain('Eigen');
    for (const p of productionPackages(lock)) expect(n, p.name).toContain(`${p.name} ${p.version}`);
  });

  it('shows the Open CASCADE notice and links the notices in the app (Options > About)', () => {
    const pm = read('src/ui/CommandPanel.tsx');
    expect(pm).toContain('Open CASCADE Technology');
    expect(pm).toContain('href="/THIRD_PARTY_NOTICES.txt"');
  });

  it('CHAD itself is MIT-licensed, with no personal details in the copyright line', () => {
    expect(JSON.parse(read('package.json')).license).toBe('MIT');
    expect(lock.packages[''].license).toBe('MIT');
    const lic = read('LICENSE');
    expect(lic.startsWith('MIT License\n\nCopyright (c) 2026 CHAD contributors\n')).toBe(true);
    expect(lic).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    expect(lic).not.toMatch(/@/); // no e-mail address or personal name: the holder is "CHAD contributors"
  });

  it('the About window credits OCCT (LGPL-2.1) and names every package the app ships', async () => {
    const about = read('src/ui/AboutModal.tsx');
    expect(about).toContain('Open CASCADE Technology (OCCT), Copyright © Open CASCADE SAS');
    expect(about).toContain('GNU Lesser General Public License version 2.1 (LGPL-2.1) with the Open CASCADE Exception 1.0');
    expect(about).toContain('This product uses Open CASCADE Technology software.');
    expect(about).toContain('href="/THIRD_PARTY_NOTICES.txt"');
    expect(about).toContain("from '../../LICENSE?raw'");
    const { ATTRIBUTIONS } = await import('../src/ui/AboutModal');
    const deps = Object.keys(JSON.parse(read('package.json')).dependencies).sort();
    expect(ATTRIBUTIONS.map((a) => a.pkg).sort()).toEqual(deps);
    for (const a of ATTRIBUTIONS) expect(a.license, a.pkg).toBe(lock.packages[`node_modules/${a.pkg}`].license);
    expect(read('src/ui/CommandPanel.tsx')).toContain('<AboutModal');
  });

  it('every dependency licence has been reviewed; copyleft only where the audit allows it', () => {
    for (const [path, meta] of Object.entries<any>(lock.packages)) {
      if (!path) continue;
      const name = path.replace(/^.*node_modules\//, '');
      const lic = String(meta.license ?? 'UNKNOWN');
      const ok = (meta.dev || meta.devOptional ? REVIEWED_DEV : REVIEWED_RUNTIME).has(lic);
      expect(ok, `${name} ${meta.version}: licence ${lic} is not reviewed in docs/LICENSES.md`).toBe(true);
      if (/GPL/.test(lic)) expect(LGPL_ALLOWED.has(name), `${name}: copyleft licence ${lic}`).toBe(true);
    }
  });

  it('no other company\'s product names or trademarks in the UI, the AI tools or the AI instructions', () => {
    const ui = [...files('src/ui', /\.tsx?$/), ...files('src/render', /\.ts$/), ...files('src/core', /\.ts$/), ...files('src/sketch', /\.ts$/), ...files('src/kernel', /\.ts$/), ...files('src/ai', /\.ts$/)]
      .filter((f) => !f.startsWith('src/ui/drawing/')); // drawings are hidden in CHAD (src/edition.ts)
    for (const f of ui) for (const t of shownText(read(f))) expect(t, `${f}: ${t.slice(0, 120)}`).not.toMatch(THIRD_PARTY_MARKS);
    for (const f of files('src/ai', /\.json$/)) expect(read(f), f).not.toMatch(THIRD_PARTY_MARKS);
    expect(read('bridge/system-prompt.md')).not.toMatch(THIRD_PARTY_MARKS);
    expect(read('index.html')).not.toMatch(THIRD_PARTY_MARKS);
  });

  it('no other CAD or AI product names anywhere in the code, tests or docs (comments included)', () => {
    // Allowed: the licence texts (they quote their authors) and this file (it holds the list).
    const allowed = new Set(['public/THIRD_PARTY_NOTICES.txt', 'tests/legal.test.ts', 'package-lock.json']);
    const generated = /^(node_modules|dist|dist-e2e|\.git|bench-results|smoke-results|smoke-report|verify\/print\/out|verify\/print\/\.venv)$|(^|\/)__pycache__$/;
    const text = /\.(ts|tsx|js|mjs|cjs|json|md|txt|css|html|py|sh|bat|yml|yaml|svg)$|(^|\/)(LICENSE|_headers)$/;
    const walk = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((n) => {
      const p = dir ? `${dir}/${n}` : n;
      if (generated.test(p)) return [];
      return statSync(join(root, p)).isDirectory() ? walk(p) : [p];
    });
    const checked = walk('').filter((f) => text.test(f) && !allowed.has(f));
    for (const f of checked) expect(read(f), f).not.toMatch(THIRD_PARTY_MARKS_ANY_CASE);
    expect(checked.length).toBeGreaterThan(150);
  });

  it('mouse layouts are described, not named after other CAD programs', async () => {
    const { NAV_PRESETS } = await import('../src/render/navigation');
    for (const p of Object.values(NAV_PRESETS)) {
      expect(p.label).not.toMatch(/SolidWorks|Onshape|Fusion/i);
      expect(p.id).not.toMatch(/SolidWorks|Onshape|Fusion/i);
    }
  });
});
