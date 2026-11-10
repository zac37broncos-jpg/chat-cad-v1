import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import brand from '../brand.json';
import { APP_NAME, PART_FILE_EXT } from '../src/brand';
// @ts-expect-error plain JS module
import { APP_NAME as LAUNCHER_NAME, REPO, DEFAULT_PORT, homeDir, windowsCmd } from '../launcher/chad-launcher.mjs';

// CHAD's identity lives in brand.json (see src/brand.ts). These checks keep every copy of it in
// step, and keep CHAD from colliding with an installed ChatCAD (folder, port/autosave, icon, window title).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const CHATCAD_PORT = 5173; // ChatCAD's fixed port (its launcher and its browser autosave)
const SMOKE_PORT = 5187; // e2e/playwright.config.ts

describe('CHAD brand in one place', () => {
  it('brand.json is CHAD and the app reads it', () => {
    expect(brand.name).toBe('CHAD');
    expect(APP_NAME).toBe(brand.name);
    expect(PART_FILE_EXT).toBe(brand.fileExtension);
    expect(PART_FILE_EXT).toMatch(/^\.[a-z0-9]+\.json$/);
  });

  it('the launcher copy of the brand matches brand.json', () => {
    expect(LAUNCHER_NAME).toBe(brand.name);
    expect(REPO).toBe(brand.repo);
    expect(DEFAULT_PORT).toBe(brand.port);
    expect(windowsCmd()).toContain(`title ${brand.name}`);
  });

  it('the window title is the brand (the launcher recognises a running CHAD by it)', () => {
    expect(read('index.html')).toContain(`<title>${brand.name}</title>`);
  });

  it('uses its own port, so its browser autosave never mixes with ChatCAD\'s', () => {
    expect(brand.port).not.toBe(CHATCAD_PORT);
    expect(brand.port).not.toBe(CHATCAD_PORT + 1); // Vite's fallback when 5173 is busy
    expect(brand.port).not.toBe(SMOKE_PORT);
    expect(read('e2e/playwright.config.ts')).toContain(`const PORT = ${SMOKE_PORT};`);
  });

  it('installs into its own folder with its own shortcut and icon', () => {
    expect(homeDir({ LOCALAPPDATA: 'C:\\L' }, 'win32')).toMatch(/[\\/]CHAD$/);
    const src = read('launcher/chad-launcher.mjs');
    expect(src).not.toMatch(/'ChatCAD(\.lnk|\.cmd)?'|chatcad\.ico|CHATCAD_(HOME|PORT|BRANCH|GITHUB_TOKEN)\b/);
    expect(existsSync(join(root, 'launcher/chatcad-launcher.mjs'))).toBe(false);
    // A real multi-size Windows icon (ICO header, PNG images, a 256 px one), drawn for CHAD.
    const ico = readFileSync(join(root, 'launcher/chad.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const n = ico.readUInt16LE(4);
    expect(n).toBeGreaterThanOrEqual(5);
    const sizes = Array.from({ length: n }, (_, i) => ico.readUInt8(6 + 16 * i) || 256);
    expect(sizes).toContain(16);
    expect(sizes).toContain(32);
    expect(sizes).toContain(256);
    for (let i = 0; i < n; i++) {
      const off = ico.readUInt32LE(6 + 16 * i + 12);
      expect(ico.subarray(off, off + 4).toString('latin1')).toBe('\x89PNG');
    }
  });

  it('the start file and the Claude instructions say CHAD', () => {
    const bat = read('Start CHAD (Windows).bat');
    expect(bat).toContain('title CHAD');
    expect(bat).not.toContain('ChatCAD');
    expect(read('bridge/system-prompt.md')).not.toContain('ChatCAD');
  });

  it('no ChatCAD name left in what the user sees (window, ribbon, panels, chat)', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(join(root, d))) {
        const p = `${d}/${f}`;
        if (statSync(join(root, p)).isDirectory()) walk(p);
        else if (p.endsWith('.tsx')) files.push(p);
      }
    };
    walk('src/ui');
    for (const f of files) {
      // Code comments may mention ChatCAD (history); strings shown in the UI must not.
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      if (f.startsWith('src/ui/drawing/')) continue; // drawings are not part of CHAD (see docs/CHAD_SCOPE.md)
      expect(code, f).not.toContain('ChatCAD');
    }
  });
});
