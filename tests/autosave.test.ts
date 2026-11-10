/**
 * Safe autosave. The browser smoke test checks the real
 * IndexedDB with a part over 5 MB; these tests check the logic with in-memory storage.
 */
import { describe, it, expect, vi } from 'vitest';
import { Autosaver, loadAutosave, parseCopy, LOCAL_KEY, LOCAL_TIME_KEY, LOCAL_LIMIT, ROTATE_MS, type AutosaveDb, type SavedCopy, type LocalStore } from '../src/ui/autosave';
import { emptyDocument, type CadDocument } from '../src/core/model';

/** localStorage stand-in with Chrome's limit of about 5 million characters per site. */
function fakeLocal(limit = 5_000_000) {
  const m = new Map<string, string>();
  const size = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const local: LocalStore & { m: Map<string, string>; broken?: boolean } = {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      if (local.broken) throw new Error('QuotaExceededError');
      const old = m.get(k);
      m.set(k, String(v));
      if (size() > limit) { if (old === undefined) m.delete(k); else m.set(k, old); throw new Error('QuotaExceededError'); }
    },
    removeItem: (k) => { m.delete(k); },
  };
  return local;
}

function fakeDb() {
  const slots: (SavedCopy | null)[] = [null, null, null];
  const db: AutosaveDb & { slots: typeof slots; fail: boolean; writes: number; delay: number } = {
    slots, fail: false, writes: 0, delay: 0,
    async read() { return slots.map((s) => (s ? { ...s } : null)); },
    async write(copy, rotate) {
      if (db.delay) await new Promise((r) => setTimeout(r, db.delay));
      if (db.fail) throw new Error('QuotaExceededError (disk full)');
      db.writes++;
      if (rotate) { slots[2] = slots[1]; slots[1] = slots[0]; }
      slots[0] = { ...copy };
    },
  };
  return db;
}

const docNamed = (name: string, extra = 0): CadDocument => {
  const d = emptyDocument();
  d.name = name;
  // A long parameter comment-like value makes the document big without features (ok for storage tests).
  if (extra) (d as any).notes = 'x'.repeat(extra);
  return d;
};

describe('autosave (B5)', () => {
  it('saves a small part in both places and restores it', async () => {
    const local = fakeLocal(); const db = fakeDb();
    const a = new Autosaver(local, db);
    a.save(docNamed('Bracket'));
    await a.flush();
    expect(parseCopy(local.getItem(LOCAL_KEY))?.name).toBe('Bracket');
    expect(parseCopy(db.slots[0]!.json)?.name).toBe('Bracket');
    const r = await loadAutosave(local, db);
    expect(r.doc?.name).toBe('Bracket');
    expect(r.notice).toBeUndefined();
  });

  it('keeps a part over 5 MB in IndexedDB and restores it after a reload', async () => {
    const local = fakeLocal(); const db = fakeDb();
    const a = new Autosaver(local, db);
    a.save(docNamed('Small'));
    await a.flush();
    const big = docNamed('Figurine', 6_000_000);
    a.save(big);
    await a.flush();
    expect(local.getItem(LOCAL_KEY)).toBeNull(); // too big for localStorage, the old small copy is dropped
    const r = await loadAutosave(local, db);
    expect(r.doc?.name).toBe('Figurine');
    expect(JSON.stringify(r.doc).length).toBeGreaterThan(5_000_000);
    expect(JSON.stringify(r.doc)).toBe(JSON.stringify(big));
    // Shrinks again: back in localStorage too.
    a.save(docNamed('Small again'));
    await a.flush();
    expect(parseCopy(local.getItem(LOCAL_KEY))?.name).toBe('Small again');
    expect((await loadAutosave(local, db)).doc?.name).toBe('Small again');
  });

  it('opens an old autosave from before this change (localStorage only, no time)', async () => {
    const local = fakeLocal();
    local.setItem(LOCAL_KEY, JSON.stringify(docNamed('Old part')));
    const r = await loadAutosave(local, fakeDb());
    expect(r.doc?.name).toBe('Old part');
    expect(r.source).toBe('local');
    expect((await loadAutosave(local, null)).doc?.name).toBe('Old part');
  });

  it('keeps the last 3 autosaves as restore points (one per app start, and every 10 minutes)', async () => {
    const local = fakeLocal(); const db = fakeDb();
    let t = 1_000_000;
    const now = () => t;
    const s1 = new Autosaver(local, db, () => {}, now);
    s1.save(docNamed('A')); await s1.flush(); t += 1000;
    s1.save(docNamed('B')); await s1.flush(); t += 1000;
    // Within one session the newest copy is overwritten.
    expect(db.slots.map((s) => parseCopy(s?.json)?.name ?? null)).toEqual(['B', null, null]);
    // Next app start: the first save shifts the copies, so the last session's final part is kept.
    const s2 = new Autosaver(local, db, () => {}, now);
    s2.save(docNamed('C')); await s2.flush(); t += 1000;
    s2.save(docNamed('D')); await s2.flush();
    expect(db.slots.map((s) => parseCopy(s?.json)?.name ?? null)).toEqual(['D', 'B', null]);
    t += ROTATE_MS;
    s2.save(docNamed('E')); await s2.flush();
    expect(db.slots.map((s) => parseCopy(s?.json)?.name)).toEqual(['E', 'D', 'B']);
  });

  it('does not write an unchanged part again (restore points stay distinct)', async () => {
    const db = fakeDb();
    const start = docNamed('Same');
    const a = new Autosaver(fakeLocal(), db, () => {}, undefined, start);
    a.save(JSON.parse(JSON.stringify(start)));
    await a.flush();
    expect(db.writes).toBe(0);
    a.save(docNamed('Changed'));
    await a.flush();
    a.save(docNamed('Changed'));
    await a.flush();
    expect(db.writes).toBe(1);
  });

  it('falls back to the previous copy when the newest is damaged, and says so', async () => {
    const local = fakeLocal(); const db = fakeDb();
    db.slots[0] = { savedAt: 300, json: '{"format":"chatcad","version":1,"featu' }; // cut off mid-write
    db.slots[1] = { savedAt: 200, json: JSON.stringify(docNamed('Good')) };
    local.setItem(LOCAL_KEY, '{not json'); local.setItem(LOCAL_TIME_KEY, '250');
    const r = await loadAutosave(local, db);
    expect(r.doc?.name).toBe('Good');
    expect(r.source).toBe('slot1');
    expect(r.notice).toMatch(/newest autosave could not be opened/);
    // Nothing usable at all: start a new part, and say why.
    db.slots[1] = null;
    const none = await loadAutosave(local, db);
    expect(none.doc).toBeUndefined();
    expect(none.notice).toMatch(/started a new part/);
    expect(await loadAutosave(fakeLocal(), fakeDb())).toEqual({});
  });

  it('rejects files that are not part documents', () => {
    expect(parseCopy(JSON.stringify({ format: 'other', version: 1, features: [] }))).toBeNull();
    expect(parseCopy(JSON.stringify({ format: 'chatcad', version: 2, features: [] }))).toBeNull();
    expect(parseCopy(JSON.stringify({ format: 'chatcad', version: 1 }))).toBeNull();
    expect(parseCopy('null')).toBeNull();
    expect(parseCopy(null)).toBeNull();
    expect(parseCopy(JSON.stringify(emptyDocument()))).not.toBeNull();
  });

  it('warns once when a save cannot be kept anywhere, and again only after it worked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const local = fakeLocal(); const db = fakeDb();
    const status: any[] = [];
    const a = new Autosaver(local, db, (s) => status.push(s));
    db.fail = true;
    a.save(docNamed('Big1', LOCAL_LIMIT + 10)); await a.flush();
    a.save(docNamed('Big2', LOCAL_LIMIT + 10)); await a.flush();
    expect(status).toHaveLength(1);
    expect(status[0].ok).toBe(false);
    expect(status[0].message).toMatch(/^Autosave failed .*Use Save \(Ctrl\+S\)/);
    db.fail = false;
    a.save(docNamed('Big3', LOCAL_LIMIT + 10)); await a.flush();
    expect(status.at(-1)).toEqual({ ok: true });
    db.fail = true;
    a.save(docNamed('Big4', LOCAL_LIMIT + 10)); await a.flush();
    expect(status.filter((s) => !s.ok)).toHaveLength(2);
    warn.mockRestore();
  });

  it('does not warn when only one of the two places failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const local = fakeLocal(); const db = fakeDb();
    const status: any[] = [];
    const a = new Autosaver(local, db, (s) => status.push(s));
    db.fail = true; // database broken, small part still fits in localStorage
    a.save(docNamed('P1')); await a.flush();
    db.fail = false; local.broken = true; // localStorage full, database fine
    a.save(docNamed('P2')); await a.flush();
    expect(status).toEqual([]);
    expect((await loadAutosave(local, db)).doc?.name).toBe('P2');
    warn.mockRestore();
  });

  it('warns when there is no database and localStorage is full', async () => {
    const status: any[] = [];
    const local = fakeLocal(); local.broken = true;
    new Autosaver(local, null, (s) => status.push(s)).save(docNamed('X'));
    expect(status[0]?.ok).toBe(false);
    const status2: any[] = [];
    new Autosaver(fakeLocal(), null, (s) => status2.push(s)).save(docNamed('Huge', LOCAL_LIMIT + 1));
    expect(status2[0]?.message).toMatch(/too big/);
  });

  it('coalesces fast changes: only the newest pending part is written', async () => {
    const db = fakeDb(); db.delay = 20;
    const a = new Autosaver(fakeLocal(), db);
    for (let i = 1; i <= 10; i++) a.save(docNamed(`V${i}`));
    await a.flush();
    expect(db.writes).toBe(2); // the first, then the newest
    expect(parseCopy(db.slots[0]!.json)?.name).toBe('V10');
  });
});
