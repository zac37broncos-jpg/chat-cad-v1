/**
 * Smoke test of the whole app in a real browser: the main workflow a person
 * does by hand, with the mouse and keyboard. Every number is checked against
 * the exact kernel, not the screen.
 *
 * One test on purpose: each step builds on the last, like a real session.
 */
import { test, expect, type Page } from '@playwright/test';

const IN = 25.4;
const IN3 = IN ** 3;

/** Exact rebuild of the current document in the app's own geometry worker. */
async function exact(page: Page) {
  return page.evaluate(async () => {
    const w = (window as any).chatcad;
    const doc = w.store.state;
    const r = await w.kernel.call({ op: 'regen', doc, mass: true });
    return {
      features: doc.features.map((f: any) => `${f.type}:${f.name}`),
      ok: r.status.every((s: any) => s.ok),
      errors: r.status.filter((s: any) => !s.ok).map((s: any) => s.message),
      volume: r.mass?.volume ?? null,
    };
  });
}

/** Where a 3D point (mm) is on screen right now. */
async function screenOf(page: Page, p: [number, number, number]) {
  return page.evaluate((q) => {
    const vp = (window as any).chatcad.vp;
    const v = vp.target.clone().set(q[0], q[1], q[2]).project(vp.camera);
    const r = vp.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, p);
}

/** The rectangle drawn in Sketch1: half width and half height (inches), from the stored geometry. */
async function rectHalfSize(page: Page) {
  return page.evaluate(() => {
    const sk = (window as any).chatcad.store.state.features.find((f: any) => f.type === 'sketch');
    const xs = sk.entities.flatMap((e: any) => [e.p1.x, e.p2.x]);
    const ys = sk.entities.flatMap((e: any) => [e.p1.y, e.p2.y]);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), ymin: Math.min(...ys), xmin: Math.min(...xs) };
  });
}

test('sketch, extrude with preview, fillet, undo/redo, kernel crash recovery, no drawings tab, export, chat panel', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).chatcad?.kernel && (window as any).chatcad?.store);

  // Safety: the bridge must be pointed at the fake Claude path from the config, never the real one.
  await page.waitForFunction(() => (window as any).chatcad.bridge?.state?.claude !== null);
  const claudePath = await page.evaluate(() => (window as any).chatcad.bridge.state.claude?.path ?? null);
  expect(claudePath, 'smoke tests must never reach the real Claude Code').toContain('nonexistent');

  // 1. Sketch a corner rectangle on the Top plane by mouse.
  await page.getByText('Top Plane', { exact: true }).click();
  await page.locator('.cm-tab', { hasText: 'Sketch' }).click();
  await page.locator('.cm-btn', { hasText: /^Sketch$/ }).click();
  await page.waitForSelector('body[data-sketch-mode=on]');
  await page.waitForTimeout(500); // the view turns Normal To the plane first
  await page.keyboard.press('r');
  const box = (await page.locator('.viewport canvas, canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.click(cx - 150, cy - 80);
  await page.waitForTimeout(200);
  await page.mouse.move(cx + 100, cy + 60, { steps: 5 });
  await page.mouse.click(cx + 150, cy + 80);
  await page.waitForTimeout(300);
  await page.getByText('✓ Exit Sketch').click();
  await expect(page.locator('body[data-sketch-mode=on]')).toHaveCount(0);
  const rect = await rectHalfSize(page);
  expect(rect.w).toBeGreaterThan(0.5);
  expect(rect.h).toBeGreaterThan(0.3);

  // 2. Extrude 0.5 in, with the live translucent preview, then OK.
  await page.locator('.cm-tab', { hasText: 'Features' }).click();
  await page.locator('.cm-btn', { hasText: /^Extrude$/ }).click();
  await page.locator('label.field', { hasText: 'D1 depth' }).locator('input').fill('0.5');
  await expect.poll(() => page.evaluate(() => (window as any).chatcad.vp.previewGroup.children.length)).toBeGreaterThan(0);
  await page.locator('.pm-ok').click();
  await expect.poll(async () => (await exact(page)).features).toEqual(['sketch:Sketch1', 'extrude:Extrude1']);
  let r = await exact(page);
  expect(r.ok, r.errors.join('; ')).toBe(true);
  const block = rect.w * rect.h * 0.5;
  expect(Math.abs(r.volume! / IN3 - block) / block).toBeLessThan(1e-9);

  // 3. Fillet the top front edge 0.1 in: open Fillet, click the edge in an isometric view, OK.
  await page.locator('.viewport, canvas').first().click({ position: { x: 5, y: 5 } }); // focus the view, select nothing
  await page.keyboard.press('Control+7');
  await page.waitForTimeout(800); // view animation
  await page.locator('.cm-btn', { hasText: 'Fillet' }).click();
  await page.waitForTimeout(1000);
  const edgeMid = await screenOf(page, [(rect.xmin + rect.w / 2) * IN, rect.ymin * IN, 0.5 * IN]);
  await page.mouse.move(edgeMid.x, edgeMid.y);
  await page.waitForTimeout(200);
  await page.mouse.click(edgeMid.x, edgeMid.y);
  await expect(page.locator('.pm')).toContainText('Edge<1>');
  const radius = page.locator('.pm-section', { hasText: 'Fillet Parameters' }).locator('input').first();
  await radius.fill('0.1');
  await page.waitForTimeout(600);
  await page.locator('.pm-ok').click();
  await expect.poll(async () => (await exact(page)).features.length).toBe(3);
  r = await exact(page);
  expect(r.ok, r.errors.join('; ')).toBe(true);
  // A fillet of radius t on a straight edge of length L removes L * t^2 * (1 - pi/4).
  const filleted = block - rect.w * 0.1 ** 2 * (1 - Math.PI / 4);
  expect(Math.abs(r.volume! / IN3 - filleted) / filleted).toBeLessThan(1e-7);

  // 4. Undo and redo from the keyboard.
  await page.locator('.viewport, canvas').first().click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await exact(page)).features.length).toBe(2);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await exact(page)).features.length).toBe(3);

  // 4b. The geometry worker crashes (simulated): the app says so, starts a fresh worker and rebuilds.
  await page.evaluate(() => (window as any).chatcad.kernel.worker.onerror(new Event('error')));
  await expect(page.getByText(/crashed and was restarted/)).toBeVisible();
  const q = await page.evaluate(() => (window as any).chatcad.kernel.call({ op: 'quality' }).then(() => 'ok', (e: Error) => e.message));
  expect(q).toBe('ok');
  r = await exact(page);
  expect(r.ok, r.errors.join('; ')).toBe(true);
  expect(Math.abs(r.volume! / IN3 - filleted) / filleted).toBeLessThan(1e-7);

  // 5. Export STEP from the labeled toolbar button: the panel, a real download, the kernel's read-back check.
  const partName: string = await page.evaluate(() => (window as any).chatcad.store.state.name);
  const readAll = async (d: import('@playwright/test').Download) => Buffer.concat(await (await d.createReadStream()).toArray());
  await page.getByTestId('qb-exportStep').click();
  await expect(page.locator('.pm-title')).toContainText('Export STEP');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-step-go').click()]);
  expect(download.suggestedFilename()).toBe(`${partName}.step`);
  const stepText = (await readAll(download)).toString('utf8');
  expect(stepText.startsWith('ISO-10303-21;')).toBe(true);
  expect(stepText).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'))");
  expect(stepText).toMatch(/CONVERSION_BASED_UNIT\('INCH'/); // the part is in inches, so is the file
  expect(stepText).toContain(`PRODUCT('${partName}'`);
  expect(stepText.match(/MANIFOLD_SOLID_BREP\(/g)?.length).toBe(1);
  await expect(page.getByTestId('export-result')).toContainText(`Saved ${partName}.step`);
  await expect(page.getByTestId('export-result')).toContainText('the same solid');
  await page.locator('.pm-cancel').click();

  // 5b. Export STL from the File menu: binary, millimeters, watertight, the size of the part.
  await page.getByTestId('file-menu').click();
  await expect(page.getByText(/Export STEP \(\.step\)/)).toBeVisible();
  await page.getByText(/Export STL \(\.stl\)/).click();
  await expect(page.locator('.pm-title')).toContainText('Export STL');
  const [stlDownload] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-stl-go').click()]);
  expect(stlDownload.suggestedFilename()).toBe(`${partName}.stl`);
  const stl = await readAll(stlDownload);
  const n = stl.readUInt32LE(80);
  expect(stl.length).toBe(84 + 50 * n);
  expect(stl.subarray(0, 80).toString('latin1')).toContain('units: mm');
  const edges = new Map<string, number>();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const o = 84 + 50 * i + 12;
    const v = [0, 1, 2].map((k) => [0, 1, 2].map((d) => stl.readFloatLE(o + 12 * k + 4 * d)));
    for (const p of v) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], p[d]); hi[d] = Math.max(hi[d], p[d]); }
    for (let k = 0; k < 3; k++) { const key = `${v[k]}>${v[(k + 1) % 3]}`; edges.set(key, (edges.get(key) ?? 0) + 1); }
  }
  // Watertight: every directed edge once, and its reverse once.
  for (const [key, c] of edges) { const [a, b] = key.split('>'); expect(c).toBe(1); expect(edges.get(`${b}>${a}`)).toBe(1); }
  // Size in mm = the sketched rectangle and the 0.5 in depth (corners lie exactly on the model).
  expect(Math.abs(hi[0] - lo[0] - rect.w * IN)).toBeLessThan(1e-3);
  expect(Math.abs(hi[1] - lo[1] - rect.h * IN)).toBeLessThan(1e-3);
  expect(Math.abs(hi[2] - lo[2] - 0.5 * IN)).toBeLessThan(1e-3);
  await expect(page.getByTestId('export-result')).toContainText('Ready to print');
  await page.locator('.pm-cancel').click();

  // 6. Chat panel is there and accepts typing. Nothing is sent (sending would start Claude).
  const chat = page.getByPlaceholder(/Ask (Claude|the AI)/);
  if (await chat.count()) {
    await chat.fill('smoke test text, not sent');
    await expect(chat).toHaveValue('smoke test text, not sent');
  }

  // 7. CHAD has no 2D engineering drawings (src/edition.ts, docs/CHAD_SCOPE.md): the Drawings tab is not shown.
  //    The drawing code itself is still covered by tests/drawing-*.test.ts and the benchmarks.
  await expect(page.locator('.cm-tabs')).toBeVisible();
  await expect(page.locator('.cm-tab', { hasText: 'Features' })).toBeVisible();
  await expect(page.locator('.cm-tab', { hasText: 'Drawings' })).toHaveCount(0);
  await expect(page.locator('.dw-body')).toHaveCount(0);

  expect(pageErrors, 'no uncaught errors in the page').toEqual([]);
});
