/**
 * Export STEP / STL never silently saves a part with features missing.
 *
 * A feature that failed to rebuild is left out of the solid, so its file would print or machine
 * without it. The panels warn as soon as they open, save nothing until the user explicitly
 * saves without the failed features, and say in the result what is missing. Once the feature
 * is fixed, the export saves the whole part at once (tests/export-partial.test.ts checks the
 * kernel side).
 */
import { test, expect } from '@playwright/test';

test('Export holds back a part with features that failed to rebuild', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).chatcad?.kernel && (window as any).chatcad?.store);

  // A 100 x 60 x 8 mm plate, then a boss from an open line: the boss fails to rebuild.
  await page.evaluate(() => {
    const { store } = (window as any).chatcad;
    store.resetPart('Partial');
    store.setUnits('mm');
    const P = (x: number, y: number) => ({ x, y });
    const line = (id: string, a: unknown, b: unknown) => ({ id, kind: 'line', p1: a, p2: b });
    const sk = store.addSketch('XY', [
      line('l1', P(0, 0), P(100, 0)), line('l2', P(100, 0), P(100, 60)), line('l3', P(100, 60), P(0, 60)), line('l4', P(0, 60), P(0, 0)),
    ], { name: 'Plate Sketch' });
    store.addExtrude(sk, 8, { name: 'Plate' });
    const open = store.addSketch('XY', [line('b1', P(10, 10), P(40, 10))], { name: 'Boss Sketch' });
    store.addExtrude(open, 5, { operation: 'add', name: 'Mounting Boss' });
  });
  await expect(page.getByText(/1 rebuild error/)).toBeVisible();

  // STL: warned on open; Save holds the file back and names the feature.
  await page.getByTestId('qb-exportStl').click();
  await expect(page.locator('.pm-title')).toContainText('Export STL');
  await expect(page.getByTestId('export-failed-warning')).toContainText('Mounting Boss');
  await page.getByTestId('export-stl-go').click();
  const result = page.getByTestId('export-result');
  await expect(result).toContainText('Not saved: the file would be missing 1 feature that failed to rebuild');
  await expect(result).toContainText('Mounting Boss');
  await expect(result).toContainText('closed profile');
  expect(downloads).toEqual([]);

  // Only an explicit "save without it" saves, and the result says what is missing.
  const [stl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-force').click()]);
  expect(stl.suggestedFilename()).toBe('Partial.stl');
  await expect(result).toContainText('Saved Partial.stl anyway');
  await expect(result).toContainText('Missing');
  await expect(result).toContainText('Mounting Boss');
  await page.locator('.pm-cancel').click();

  // STEP: the same.
  await page.getByTestId('qb-exportStep').click();
  await expect(page.getByTestId('export-failed-warning')).toContainText('Mounting Boss');
  await page.getByTestId('export-step-go').click();
  await expect(result).toContainText('Not saved');
  await expect(result).toContainText('Mounting Boss');
  expect(downloads).toEqual(['Partial.stl']);
  await page.locator('.pm-cancel').click();

  // Fixed (the boss gets a closed profile): the export saves the whole part at once, no warning.
  await page.evaluate(() => {
    const { store } = (window as any).chatcad;
    const sk = store.state.features.find((f: any) => f.name === 'Boss Sketch');
    const P = (x: number, y: number) => ({ x, y });
    const line = (id: string, a: unknown, b: unknown) => ({ id, kind: 'line', p1: a, p2: b });
    store.updateFeature(sk.id, { entities: [line('b1', P(10, 10), P(40, 10)), line('b2', P(40, 10), P(40, 30)), line('b3', P(40, 30), P(10, 30)), line('b4', P(10, 30), P(10, 10))] });
  });
  await expect(page.getByText(/rebuild error/)).toHaveCount(0);
  await page.getByTestId('qb-exportStep').click();
  await expect(page.getByTestId('export-failed-warning')).toHaveCount(0);
  const [step] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-step-go').click()]);
  expect(step.suggestedFilename()).toBe('Partial.step');
  await expect(result).toContainText('Saved Partial.step');
  await expect(result).toContainText('the same solid');
  await expect(result).not.toContainText('Missing');
  expect(pageErrors).toEqual([]);
});
