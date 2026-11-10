/**
 * Bring-your-own-key chat in a real browser: open AI Settings, pick a provider, paste a key
 * (hidden), save, and send a request. The /api/proxy answer is faked inside the browser, so no
 * real AI is called and no key leaves the test. Checks the request the page sends, that the
 * part is built as real named features, that the key is remembered after a reload, and that
 * sending without a key explains what to do.
 */
import { test, expect } from '@playwright/test';

test('AI Settings: choose a provider, save a hidden key, build a part through /api/proxy', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const requests: { headers: Record<string, string>; body: any }[] = [];
  await page.route('**/api/proxy', async (route) => {
    const r = route.request();
    const body = JSON.parse(r.postData() ?? '{}');
    requests.push({ headers: r.headers(), body });
    const n = requests.length;
    // The extrude needs the sketch's real id: it is in the create_sketch result the page sent back.
    const sketchId = n === 2 ? body.body.contents.at(-1).parts[0].functionResponse.response.output.sketch_id : '';
    const answer = n === 1
      ? { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Sketching the plate.' }, { functionCall: { name: 'create_sketch', args: { name: 'Base Plate Sketch', plane: 'XY', entities: [{ type: 'rectangle', x: 0, y: 0, width: 3, height: 2 }] } }, thoughtSignature: 'SIG' }] } }] }
      : n === 2
        ? { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'extrude', args: { name: 'Base Plate', sketch_id: sketchId, depth: 0.25, operation: 'new' } } }] } }] }
        : { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Built a 3 x 2 x 0.25 in plate.' }] } }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
  });

  await page.goto('/');
  await page.waitForFunction(() => (window as any).chatcad?.kernel && (window as any).chatcad?.store);
  page.on('dialog', (d) => d.dismiss());

  // Open AI Settings from the gear in the chat header.
  await page.getByRole('button', { name: 'AI Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('AI provider').selectOption('gemini');
  const key = dialog.getByLabel('API key');
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('test-key-not-real-123');
  await expect(dialog.getByLabel('Model (optional)')).toHaveAttribute('placeholder', 'gemini-3.8-flash');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  // Remembered in this browser.
  expect(await page.evaluate(() => [localStorage.getItem('chad.ai.provider'), localStorage.getItem('chad.ai.apiKey')])).toEqual(['gemini', 'test-key-not-real-123']);

  // Send a request.
  const box = page.getByPlaceholder(/Ask the AI/);
  await box.fill('Make a 3 x 2 x 0.25 in plate');
  await box.press('Enter');
  await expect(page.locator('.msg.assistant', { hasText: 'Built a 3 x 2 x 0.25 in plate.' })).toBeVisible();
  expect(requests).toHaveLength(3);
  for (const r of requests) {
    expect(r.headers['x-chad-api-key']).toBe('test-key-not-real-123');
    expect(JSON.stringify(r.body)).not.toContain('test-key-not-real-123');
    expect(r.body).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash' });
  }
  // The model's thought signature went back unchanged.
  expect(JSON.stringify(requests[1].body.body.contents)).toContain('"thoughtSignature":"SIG"');
  // Real, named features, exactly 3 x 2 x 0.25 in.
  const part = await page.evaluate(async () => {
    const w = (window as any).chatcad;
    const r = await w.kernel.call({ op: 'regen', doc: w.store.state, mass: true });
    return { names: w.store.state.features.map((f: any) => f.name), ok: r.status.every((s: any) => s.ok), volume: r.mass?.volume ?? null };
  });
  expect(part.names).toEqual(expect.arrayContaining(['Base Plate Sketch', 'Base Plate']));
  expect(part.ok).toBe(true);
  expect(Math.abs(part.volume - 3 * 2 * 0.25 * 25.4 ** 3)).toBeLessThan(1e-3);
  await expect(page.locator('.tree-item', { hasText: 'Base Plate' }).first()).toBeVisible();

  // After a reload the key is still there.
  await page.reload();
  await page.waitForFunction(() => (window as any).chatcad?.bridge);
  expect(await page.evaluate(() => (window as any).chatcad.bridge.state.needsKey)).toBe(false);

  // Remove the key: sending explains and opens AI Settings, and nothing is sent.
  await page.getByRole('button', { name: 'AI Settings' }).click();
  await page.getByRole('button', { name: 'Remove saved key' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  const before = requests.length;
  await page.getByPlaceholder(/Ask the AI/).fill('another one');
  await page.getByPlaceholder(/Ask the AI/).press('Enter');
  await expect(page.locator('.msg.error', { hasText: 'Add your API key first' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'AI Settings' })).toBeVisible();
  expect(requests.length).toBe(before);
  expect(pageErrors).toEqual([]);
});
