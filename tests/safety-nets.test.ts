import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards the automatic checks themselves (.github/workflows/ci.yml).
// If someone removes a check by accident, this test turns red.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('safety nets stay in place', () => {
  const ci = read('.github/workflows/ci.yml');

  it('CI runs on every pull request and on main', () => {
    expect(ci).toMatch(/^on:\s*\n\s+pull_request:/m);
    expect(ci).toMatch(/push:\s*\n\s+branches: \[main\]/);
  });

  it('CI runs typecheck, tests, the production build and the browser smoke test', () => {
    expect(ci).toContain('name: Typecheck, tests, build');
    expect(ci).toContain('npm run typecheck');
    expect(ci).toContain('npm test');
    expect(ci).toContain('npm run build');
    expect(ci).toContain('name: Browser smoke test');
    expect(ci).toContain('npm run smoke');
  });

  it('CI never forgives a failure', () => {
    expect(ci).not.toMatch(/continue-on-error:\s*true/);
    expect(ci).not.toMatch(/\|\|\s*true/);
  });

  it('the test and smoke scripts exist', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    for (const s of ['typecheck', 'test', 'build', 'smoke', 'bench']) expect(scripts[s], s).toBeTruthy();
  });

  it('every document the README links to exists', () => {
    const links = [...read('README.md').matchAll(/\]\(((?:docs|public)\/[^)#\s]+|LICENSE)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(5);
    for (const l of links) expect(existsSync(join(root, l)), l).toBe(true);
  });
});
