/**
 * Mass Properties in the real app never shows a number from an older or unfinished rebuild:
 * after an edit it shows "Updating" until the rebuild of the edited part is done, then that
 * part's exact volume (tests/mass-consistency.test.ts checks the logic against the kernel).
 */
import { test, expect } from '@playwright/test';

test('Mass Properties shows only the current part\'s volume, through rapid edits', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).chatcad?.kernel && (window as any).chatcad?.store);

  // A 100 x 60 x T mm block with a 20 mm through hole, driven by the parameter T.
  await page.evaluate(() => {
    const { store } = (window as any).chatcad;
    store.resetPart('Mass check');
    store.setUnits('mm');
    store.setParameter('T', '8');
    const P = (x: unknown, y: unknown) => ({ x, y });
    const line = (id: string, a: unknown, b: unknown) => ({ id, kind: 'line', p1: a, p2: b });
    const sk = store.addSketch('XY', [
      line('l1', P(0, 0), P(100, 0)), line('l2', P(100, 0), P(100, 60)), line('l3', P(100, 60), P(0, 60)), line('l4', P(0, 60), P(0, 0)),
    ], { name: 'Plate Sketch' });
    store.addExtrude(sk, 'T', { name: 'Plate' });
    const hs = store.addSketch('XY', [{ id: 'c1', kind: 'circle', center: P(50, 30), radius: 10 }], { name: 'Hole Sketch' });
    store.addExtrude(hs, 0, { operation: 'cut', throughAll: true, direction: 'symmetric', name: 'Hole' });
  });
  const volume = (T: number) => 100 * 60 * T - Math.PI * 10 ** 2 * T;

  await page.locator('.cm-tab', { hasText: 'Evaluate' }).click();
  await page.locator('.cm-btn', { hasText: 'Mass Properties' }).click();
  const values = page.getByTestId('mass-values');
  await expect(values).toBeVisible();
  const shownVolume = async () => {
    const txt = await values.innerText();
    return Number(/Volume\s+([\d.]+) mm³/.exec(txt)![1]);
  };
  expect(Math.abs((await shownVolume()) - volume(8))).toBeLessThan(1e-5);

  // Record every volume the panel shows from now on, with the part's T at that moment.
  await page.evaluate(() => {
    const w = window as any;
    w.__shown = [] as { text: string; T: string }[];
    const T = () => w.chatcad.store.state.params.find((p: any) => p.name === 'T').expr;
    const pm = document.querySelector('.pm')!;
    w.__observer = new MutationObserver(() => {
      const el = pm.querySelector('[data-testid="mass-values"]') as HTMLElement | null;
      const m = el && /Volume\s+([\d.]+) mm³/.exec(el.innerText);
      w.__shown.push(m ? { text: m[1], T: T() } : { text: pm.querySelector('[data-testid="mass-updating"]') ? 'updating' : 'other', T: T() });
    });
    w.__observer.observe(pm, { subtree: true, childList: true, characterData: true });
    // Rapid edits, as when typing values or the chat changing a parameter; the last one stays.
    for (const v of ['9', '10', '12', '10']) w.chatcad.store.setParameter('T', v);
  });
  await expect.poll(shownVolume).toBeCloseTo(volume(10), 5);
  const shown = await page.evaluate(() => { const w = window as any; w.__observer.disconnect(); return w.__shown as { text: string; T: string }[]; });
  // The panel said it was updating, and every number that appeared belonged to the part as it was then.
  expect(shown.some((s) => s.text === 'updating'), JSON.stringify(shown)).toBe(true);
  for (const s of shown.filter((x) => x.text !== 'updating' && x.text !== 'other')) {
    expect(Math.abs(Number(s.text) - volume(Number(s.T))), JSON.stringify(s)).toBeLessThan(1e-5);
  }
  expect(pageErrors).toEqual([]);
});
