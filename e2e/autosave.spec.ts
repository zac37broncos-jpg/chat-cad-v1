/**
 * Safe autosave in a real browser: a part over 5 MB
 * (more than Chrome lets localStorage hold) is autosaved to IndexedDB and comes back after a reload.
 */
import { test, expect, type Page } from '@playwright/test';

const ready = (page: Page) => page.waitForFunction(() => (window as any).chatcad?.kernel && (window as any).chatcad?.store);

/** Length of the newest IndexedDB autosave copy, or 0. */
const slot0Length = (page: Page) => page.evaluate(() => new Promise<number>((res) => {
  const r = indexedDB.open('chatcad', 1);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('autosave')) { res(0); return; }
    const g = db.transaction('autosave', 'readonly').objectStore('autosave').get('slot0');
    g.onsuccess = () => { res(g.result?.json?.length ?? 0); db.close(); };
    g.onerror = () => res(0);
  };
  r.onerror = () => res(0);
}));

test('a part over 5 MB autosaves to IndexedDB and is restored after a reload', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  await ready(page);

  // A big document: a plain block plus 6 million characters of extra data (stands in for a large organic part).
  await page.evaluate(() => {
    const { store } = (window as any).chatcad;
    const doc = JSON.parse(store.serialize());
    doc.name = 'BigAutosavePart';
    doc.notes = 'x'.repeat(6_000_000);
    store.load(doc);
  });
  await expect.poll(() => slot0Length(page), { timeout: 20_000 }).toBeGreaterThan(5_000_000);
  // Too big for localStorage, so no stale small copy is left there either.
  expect(await page.evaluate(() => localStorage.getItem('chatcad.autosave.v1'))).toBeNull();
  await expect(page.locator('.toast.err')).toHaveCount(0); // no "Autosave failed" warning

  await page.reload();
  await ready(page);
  const restored = await page.evaluate(() => {
    const s = (window as any).chatcad.store.state;
    return { name: s.name, length: JSON.stringify(s).length, notes: s.notes?.length ?? 0 };
  });
  expect(restored.name).toBe('BigAutosavePart');
  expect(restored.notes).toBe(6_000_000);
  expect(restored.length).toBeGreaterThan(5_000_000);

  // Back to a small part: it is in localStorage again, and the newest copy wins after a reload.
  await page.evaluate(() => {
    const { store } = (window as any).chatcad;
    const doc = JSON.parse(store.serialize());
    delete doc.notes;
    doc.name = 'SmallAgain';
    store.load(doc);
  });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('chatcad.autosave.v1') ?? '{}').name)).toBe('SmallAgain');
  await expect.poll(() => slot0Length(page)).toBeLessThan(100_000);
  await page.reload();
  await ready(page);
  expect(await page.evaluate(() => (window as any).chatcad.store.state.name)).toBe('SmallAgain');

  // A damaged newest copy (as if the computer lost power mid-write): the previous good copy opens, with a notice.
  await page.evaluate(() => new Promise<void>((res) => {
    const r = indexedDB.open('chatcad', 1);
    r.onsuccess = () => {
      const tx = r.result.transaction('autosave', 'readwrite');
      tx.objectStore('autosave').put({ savedAt: Date.now() + 60_000, json: '{"format":"chatcad","vers' }, 'slot0');
      tx.oncomplete = () => { r.result.close(); res(); };
    };
  }));
  await page.reload();
  await ready(page);
  expect(await page.evaluate(() => (window as any).chatcad.store.state.name)).toBe('SmallAgain');
  await expect(page.locator('.toast.err')).toContainText('newest autosave could not be opened');
  expect(pageErrors).toEqual([]);
});
