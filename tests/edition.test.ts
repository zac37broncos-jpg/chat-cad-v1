import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EDITION } from '../src/edition';

// CHAD hides engineering-only screens instead of deleting them (docs/CHAD_SCOPE.md), so the shared code
// stays tested. These checks make sure the hiding is real and that nothing was deleted by accident.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('CHAD edition (print focus)', () => {
  it('hides 2D engineering drawings', () => {
    expect(EDITION.drawings).toBe(false);
    // The only way into the drawing workspace is ctx.makeDrawing (the Drawings tab); CHAD leaves it unset.
    const app = read('src/ui/App.tsx');
    expect(app).toContain('makeDrawing: EDITION.drawings ? () => setDrawingOpen(true) : undefined,');
    expect(app.match(/setDrawingOpen\(true\)/g)?.length).toBe(1);
    expect(read('src/ui/Ribbon.tsx')).toContain('{ctx.makeDrawing && <button className="cm-tab" onClick={ctx.makeDrawing}>Drawings</button>}');
  });

  it('keeps the hidden code and its tests (hidden, not deleted)', () => {
    for (const f of ['src/ui/drawing/DrawingWorkspace.tsx', 'src/drawing/compose.ts', 'src/kernel/hlr.ts', 'tests/drawing-compose.test.ts', 'tests/drawing-views.test.ts']) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });

  it('documents what CHAD shows and hides', () => {
    const scope = read('docs/CHAD_SCOPE.md');
    expect(scope).toContain('Hidden in CHAD');
    expect(scope).toContain('src/edition.ts');
  });
});
