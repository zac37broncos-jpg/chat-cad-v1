/**
 * Safe autosave.
 *
 * Every change to the part is saved in the browser, in two places:
 *  - IndexedDB, which has no 5 MB limit: three copies ("slots"). Slot 0 is the newest save.
 *    The copies shift down (0 -> 1 -> 2) on the first save of each app start and then every
 *    10 minutes, so there are always older restore points if the newest one is damaged.
 *  - localStorage (the original autosave key), for parts small enough to fit. It is written
 *    synchronously, so it survives even if the tab closes in the middle of an IndexedDB write.
 * On start, the newest copy that opens cleanly is used. If the newest is damaged, the next
 * one is used and the user is told. When a save cannot be kept anywhere, the user is warned
 * (once, until saving works again) to use Save.
 *
 * Storage is injected so the logic is unit tested in Node (tests/autosave.test.ts); the
 * browser smoke test checks the real IndexedDB with a part over 5 MB.
 */
import type { CadDocument } from '../core/model';
import { APP_NAME } from '../brand';

/** The historical localStorage key (see src/brand.ts); old autosaves keep opening. */
export const LOCAL_KEY = 'chatcad.autosave.v1';
/** When the localStorage copy was saved (ms since 1970), to compare it with IndexedDB copies. */
export const LOCAL_TIME_KEY = 'chatcad.autosave.v1.savedAt';
/** Parts bigger than this (characters of JSON) live only in IndexedDB. Chrome allows about 5 million characters per site in localStorage, shared with view settings and drawings. */
export const LOCAL_LIMIT = 1_000_000;
export const SLOTS = 3;
/** Shift the restore points at most this often during one session. */
export const ROTATE_MS = 10 * 60 * 1000;
/** Give up on IndexedDB if it does not open this fast at start (then only localStorage is used). */
export const DB_TIMEOUT_MS = 5000;

export interface SavedCopy { savedAt: number; json: string }

/** What the autosave needs from IndexedDB (real one: idbBackend()). */
export interface AutosaveDb {
  /** The slots, newest first; missing slots are null. */
  read(): Promise<(SavedCopy | null)[]>;
  /** Write slot 0; when rotate is true, first shift slots 0 -> 1 -> 2 (one transaction). */
  write(copy: SavedCopy, rotate: boolean): Promise<void>;
}

export type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface LoadResult {
  doc?: CadDocument;
  /** Shown to the user when something about the autosave needs their attention. */
  notice?: string;
  /** Where the document came from (for tests and the console). */
  source?: 'local' | `slot${number}`;
}

/** A parsed autosave if it is a part document we can open, else null. */
export function parseCopy(json: string | null | undefined): CadDocument | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json);
    if (!d || typeof d !== 'object' || d.format !== 'chatcad' || d.version !== 1 || !Array.isArray(d.features)) return null;
    return d as CadDocument;
  } catch { return null; }
}

const when = (ms: number) => {
  try { return new Date(ms).toLocaleString(); } catch { return 'earlier'; }
};

/** Pick the newest autosave copy that opens. */
export async function loadAutosave(local: LocalStore | null, db: AutosaveDb | null): Promise<LoadResult> {
  const candidates: { source: LoadResult['source']; savedAt: number; json: string | null }[] = [];
  if (local) {
    try {
      const json = local.getItem(LOCAL_KEY);
      // Autosaves from before IndexedDB have no time: they are older than any IndexedDB copy.
      if (json !== null) candidates.push({ source: 'local', savedAt: Number(local.getItem(LOCAL_TIME_KEY)) || 0, json });
    } catch { /* storage blocked */ }
  }
  let dbNote = '';
  if (db) {
    try {
      const slots = await db.read();
      slots.forEach((c, i) => { if (c) candidates.push({ source: `slot${i}`, savedAt: c.savedAt, json: c.json }); });
    } catch { dbNote = `${APP_NAME} could not read its autosave database, so it may have opened an older autosave.`; }
  }
  // Newest first; for the same save, IndexedDB first (same content either way).
  candidates.sort((a, b) => b.savedAt - a.savedAt || (a.source === 'local' ? 1 : 0) - (b.source === 'local' ? 1 : 0));
  let damaged = 0;
  for (const c of candidates) {
    const doc = parseCopy(c.json);
    if (!doc) { damaged++; continue; }
    const parts: string[] = [];
    if (damaged) parts.push(`The newest autosave could not be opened, so ${APP_NAME} restored the one from ${when(c.savedAt)}.`);
    if (dbNote) parts.push(dbNote);
    return { doc, source: c.source, ...(parts.length ? { notice: parts.join(' ') } : {}) };
  }
  if (damaged) return { notice: `The autosave could not be opened, so ${APP_NAME} started a new part.` };
  return dbNote ? { notice: dbNote } : {};
}

export interface SaveStatus { ok: boolean; message?: string }

/**
 * Saves documents as they change. save() is cheap to call on every change: localStorage is
 * written at once, and IndexedDB writes are coalesced (only the newest pending document is written).
 */
export class Autosaver {
  private writing = false;
  private queued: SavedCopy | null = null;
  private lastRotate = 0;
  private lastSavedAt = 0;
  private failing = false;
  /** JSON of the last document handed to save(), so an unchanged document is not written again. */
  private lastJson: string | null = null;
  /** Whether the queued copy also made it into localStorage. */
  private pendingLocalOk = false;

  constructor(
    private local: LocalStore | null,
    private db: AutosaveDb | null,
    private onStatus: (s: SaveStatus) => void = () => {},
    private now: () => number = () => Date.now(),
    /** The document the app started with: saving it again unchanged is skipped (keeps restore points distinct). */
    startDoc?: CadDocument,
  ) {
    if (startDoc) { try { this.lastJson = JSON.stringify(startDoc); } catch { /* ignore */ } }
  }

  save(doc: CadDocument) {
    let json: string;
    try { json = JSON.stringify(doc); } catch (e) { this.report(false, `Autosave failed (${e instanceof Error ? e.message : String(e)}).`); return; }
    if (json === this.lastJson) return;
    this.lastJson = json;
    // Strictly increasing times, so the newest save always wins on load.
    const savedAt = Math.max(this.now(), this.lastSavedAt + 1);
    this.lastSavedAt = savedAt;
    const copy = { savedAt, json };
    const localOk = json.length <= LOCAL_LIMIT && this.writeLocal(copy);
    if (!this.db) { this.report(localOk, localOk ? undefined : this.tooBig(json)); return; }
    if (this.writing) { this.queued = copy; this.pendingLocalOk = localOk; return; }
    void this.writeDb(copy, localOk);
  }

  /** Resolves when every queued IndexedDB write has finished (tests, and before closing). */
  async flush() { while (this.writing) await new Promise((r) => setTimeout(r, 5)); }

  private writeLocal(copy: SavedCopy): boolean {
    if (!this.local) return false;
    try {
      this.local.setItem(LOCAL_KEY, copy.json);
      this.local.setItem(LOCAL_TIME_KEY, String(copy.savedAt));
      return true;
    } catch {
      return false;
    }
  }

  private async writeDb(copy: SavedCopy, localOk: boolean) {
    this.writing = true;
    let current: SavedCopy | null = copy;
    let curLocalOk = localOk;
    while (current) {
      const rotate = this.lastRotate === 0 || this.now() - this.lastRotate >= ROTATE_MS;
      let dbOk = true;
      let why = '';
      try {
        await this.db!.write(current, rotate);
        if (rotate) this.lastRotate = this.now();
      } catch (e) {
        dbOk = false;
        why = e instanceof Error ? e.message : String(e);
      }
      if (dbOk && !curLocalOk && this.local) {
        // A big part now lives only in IndexedDB: drop the older small copy so it is never preferred
        // by mistake (its time is older anyway, this just frees the space).
        try { this.local.removeItem(LOCAL_KEY); this.local.removeItem(LOCAL_TIME_KEY); } catch { /* ignore */ }
      }
      const ok = dbOk || curLocalOk;
      if (!dbOk) console.warn(`[chatcad] autosave database write failed${curLocalOk ? ' (the browser copy was saved)' : ''}: ${why}`);
      this.report(ok, ok ? undefined : `Autosave failed (${why || 'browser storage refused it'}).`);
      current = this.queued;
      curLocalOk = this.pendingLocalOk;
      this.queued = null;
    }
    this.writing = false;
  }

  private tooBig(json: string) {
    return json.length > LOCAL_LIMIT ? 'Autosave failed: this part is too big for the browser copy and the autosave database is not available.' : 'Autosave failed: the browser refused to store the part.';
  }

  private report(ok: boolean, why?: string) {
    if (ok) {
      if (this.failing) { this.failing = false; this.onStatus({ ok: true }); }
      return;
    }
    if (this.failing) return; // warn once per failure streak
    this.failing = true;
    this.onStatus({ ok: false, message: `${why ?? 'Autosave failed.'} Your latest changes are not saved in the browser. Use Save (Ctrl+S) to keep a copy of the part.` });
  }
}

// ------------------------------------------------------------------ real IndexedDB

const DB_NAME = 'chatcad';
const STORE = 'autosave';
const slotKey = (i: number) => `slot${i}`;

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Open the autosave database, or null if this browser cannot (blocked, private mode, too slow). */
export async function openIdb(factory: IDBFactory | undefined = globalThis.indexedDB, timeoutMs = DB_TIMEOUT_MS): Promise<AutosaveDb | null> {
  if (!factory) return null;
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((res, rej) => {
      const t = setTimeout(() => rej(new Error('timed out')), timeoutMs);
      const r = factory.open(DB_NAME, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => { clearTimeout(t); res(r.result); };
      r.onerror = () => { clearTimeout(t); rej(r.error); };
      r.onblocked = () => { clearTimeout(t); rej(new Error('blocked')); };
    });
  } catch (e) {
    console.warn('[chatcad] autosave database unavailable:', e);
    return null;
  }
  const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error ?? new Error('aborted')); });
  return {
    // Every request is issued synchronously inside its transaction (never after an await),
    // so the transaction cannot commit early in any browser.
    async read() {
      const st = db.transaction(STORE, 'readonly').objectStore(STORE);
      const vals = await Promise.all(Array.from({ length: SLOTS }, (_, i) => req(st.get(slotKey(i)))));
      return vals.map((v) => (v && typeof v.json === 'string' && typeof v.savedAt === 'number' ? v : null));
    },
    async write(copy, rotate) {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const finished = done(tx);
      if (rotate) {
        // Requests run in order: both reads see the old slots before slot 0 is replaced.
        for (let i = 0; i < SLOTS - 1; i++) {
          const r = st.get(slotKey(i));
          r.onsuccess = () => { if (r.result !== undefined) st.put(r.result, slotKey(i + 1)); };
        }
      }
      st.put(copy, slotKey(0));
      await finished;
    },
  };
}

/** localStorage, or null where the browser blocks it. */
export function browserLocal(): LocalStore | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// ------------------------------------------------------------------ app start

let initial: LoadResult = {};
let initialDb: AutosaveDb | null = null;

/** Called once before the app module loads (src/main.tsx). Never throws. */
export async function prepareAutosave(): Promise<void> {
  try {
    initialDb = await openIdb();
    initial = await loadAutosave(browserLocal(), initialDb);
    if (initial.source) console.info(`[chatcad] restored autosave from ${initial.source}`);
  } catch (e) {
    console.warn('[chatcad] autosave restore failed:', e);
    initial = {};
  }
}

/** The document to start with (and any notice about it), as found by prepareAutosave. */
export const initialAutosave = (): LoadResult => initial;
/** The database prepareAutosave opened (null when IndexedDB is not available). */
export const autosaveDb = (): AutosaveDb | null => initialDb;
