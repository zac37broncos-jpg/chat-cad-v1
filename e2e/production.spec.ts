/**
 * The production build in a real browser, served with the same headers the published site uses
 * (COOP same-origin + COEP require-corp; vite.config.ts, vercel.json, public/_headers).
 *
 * Checks what a static host needs: the page is cross-origin isolated, the OpenCascade WebAssembly
 * downloads as application/wasm and really computes geometry, nothing the app loads is blocked by
 * COEP, the real /api/proxy still answers, and the About window shows the OCCT LGPL notice.
 * The AI answers are faked inside the browser, so no real AI is called.
 */
import { test, expect, type Response } from '@playwright/test';

/** Same number as PREVIEW_PORT in e2e/playwright.config.ts. */
const PREVIEW = 'http://localhost:5188';

test('production build: cross-origin isolated, OpenCascade WASM runs, /api/proxy reachable, About shows OCCT LGPL', async ({ page }) => {
  const pageErrors: string[] = [];
  const failed: string[] = [];
  const responses: Response[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => responses.push(r));
  // The local Claude Code bridge is not part of a production build: its WebSocket may fail, nothing else may.
  page.on('requestfailed', (r) => { if (!r.url().includes('/chatcad-bridge')) failed.push(`${r.url()} ${r.failure()?.errorText}`); });

  const doc = await page.goto(`${PREVIEW}/`);
  expect(doc?.status()).toBe(200);
  expect(doc?.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(doc?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  await page.waitForFunction(() => (window as any).chatcad?.kernel && (window as any).chatcad?.store);
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');

  // The real proxy (not faked) answers under COEP: a request with no key gets a plain-words refusal.
  const proxy = await page.evaluate(async () => {
    const r = await fetch('/api/proxy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', model: 'gemini-3.8-flash', body: {} }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  expect(proxy.status).toBeGreaterThanOrEqual(400);
  expect(proxy.status).toBeLessThan(500);
  expect(typeof proxy.body?.proxyError).toBe('string');

  // Build a part through the chat, so the OpenCascade worker and WebAssembly really run.
  let n = 0;
  await page.route('**/api/proxy', async (route) => {
    n++;
    const body = JSON.parse(route.request().postData() ?? '{}');
    const sketchId = n === 2 ? body.body.contents.at(-1).parts[0].functionResponse.response.output.sketch_id : '';
    const answer = n === 1
      ? { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'create_sketch', args: { name: 'Plate Sketch', plane: 'XY', entities: [{ type: 'rectangle', x: 0, y: 0, width: 2, height: 1 }] } } }] } }] }
      : n === 2
        ? { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'extrude', args: { name: 'Plate', sketch_id: sketchId, depth: 0.5, operation: 'new' } } }] } }] }
        : { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Built a 2 x 1 x 0.5 in plate.' }] } }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
  });
  await page.evaluate(() => { localStorage.setItem('chad.ai.provider', 'gemini'); localStorage.setItem('chad.ai.apiKey', 'test-key-not-real-456'); });
  await page.reload();
  await page.waitForFunction(() => (window as any).chatcad?.bridge && (window as any).chatcad.bridge.state.needsKey === false);
  const box = page.getByPlaceholder(/Ask the AI/);
  await box.fill('Make a 2 x 1 x 0.5 in plate');
  await box.press('Enter');
  await expect(page.locator('.msg.assistant', { hasText: 'Built a 2 x 1 x 0.5 in plate.' })).toBeVisible();
  const part = await page.evaluate(async () => {
    const w = (window as any).chatcad;
    const r = await w.kernel.call({ op: 'regen', doc: w.store.state, mass: true });
    return { ok: r.status.every((s: any) => s.ok), volume: r.mass?.volume ?? null };
  });
  expect(part.ok).toBe(true);
  expect(Math.abs(part.volume - 2 * 1 * 0.5 * 25.4 ** 3)).toBeLessThan(1e-3);

  // The OpenCascade module came as a separate .wasm file with the right type and the isolation headers,
  // and so did the worker script that loads it (a COEP page refuses a worker without them).
  const occt = responses.filter((r) => /\/assets\/replicad_single-[^/]+\.wasm$/.test(r.url()));
  expect(occt.length).toBeGreaterThan(0);
  for (const r of occt) {
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toMatch(/^application\/wasm/);
  }
  const worker = responses.filter((r) => /\/assets\/worker-[^/]+\.js$/.test(r.url()));
  expect(worker.length).toBeGreaterThan(0);
  for (const r of worker) expect(r.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  for (const r of responses.filter((x) => x.url().endsWith('.wasm'))) expect(r.headers()['content-type'], r.url()).toMatch(/^application\/wasm/);
  // Everything came from the site itself (require-corp would block anything else without CORP headers).
  for (const r of responses) expect(new URL(r.url()).origin, r.url()).toBe(PREVIEW);

  // About window: OCCT LGPL-2.1 attribution, the notices link, the MIT licence, isolation on.
  await page.getByTitle(/^Options/).first().click();
  await page.getByTestId('about-open').click();
  const about = page.getByRole('dialog', { name: 'About CHAD' });
  await expect(about).toBeVisible();
  await expect(about.getByTestId('about-occt')).toContainText('Open CASCADE Technology');
  await expect(about.getByTestId('about-occt')).toContainText('LGPL-2.1');
  await expect(about.getByRole('link', { name: 'third-party notices' })).toHaveAttribute('href', '/THIRD_PARTY_NOTICES.txt');
  await expect(about.getByTestId('about-isolation')).toContainText('isolation: on');
  await about.getByText('CHAD licence (MIT)').click();
  await expect(about.getByTestId('about-mit')).toContainText('Permission is hereby granted, free of charge');
  // Escape closes the About window only; the Options panel stays open.
  await page.keyboard.press('Escape');
  await expect(about).toHaveCount(0);
  await expect(page.getByTestId('about-open')).toBeVisible();

  // The notices file ships with the build.
  const notices = await page.request.get(`${PREVIEW}/THIRD_PARTY_NOTICES.txt`);
  expect(notices.status()).toBe(200);
  expect(await notices.text()).toContain('Open CASCADE Technology');

  expect(failed).toEqual([]);
  expect(pageErrors).toEqual([]);
});
