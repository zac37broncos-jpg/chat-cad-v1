/**
 * Leak finder for the OpenCascade WASM bindings (tests and benchmarks only).
 *
 * Why: every OpenCascade value object handed to JavaScript (a TopoDS_Shape, a
 * gp_Pnt, a builder, an explorer...) is a C++ object on the WASM heap that is
 * freed ONLY by calling `.delete()`. JavaScript's garbage collector never frees
 * it. A shape object left undeleted also keeps its whole B-rep (surfaces,
 * display triangles) alive. Reference-counted objects (Geom_*, Poly_*, every
 * Standard_Transient) are the exception: the bindings free those when their
 * JavaScript wrapper is garbage collected, so they are not reported.
 *
 * How: `trackOc(oc)` wraps every constructor, static function and method of the
 * bindings so each value object they return is registered with a
 * FinalizationRegistry. When JavaScript garbage-collects a wrapper that was
 * never deleted, its C++ object is lost for good: that is a leak, counted by
 * where it came from ("new gp_Pnt", "TopExp_Explorer.Current", ...).
 * `leaks()` forces garbage collection and returns the counts since the last
 * call. With `stacks: true` each leak also records the first source line
 * outside node_modules that created it (slower).
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import type { OC } from '../../src/kernel/regen';

interface Token { origin: string; site?: string; deleted: boolean }

export interface LeakReport { total: number; byOrigin: [string, number][]; bySite: [string, number][] }

export interface OcTracker {
  /** Force garbage collection and return the leaks found since the previous call. */
  leaks(): Promise<LeakReport>;
  /** Value objects created and not yet deleted or collected (diagnostics). */
  live(): number;
}

let gcFn: (() => void) | null = null;
function forceGc() {
  if (!gcFn) {
    v8.setFlagsFromString('--expose-gc');
    gcFn = vm.runInNewContext('gc') as () => void;
  }
  gcFn();
}

const trackers = new WeakMap<object, OcTracker>();

export function trackOc(oc: OC, opts: { stacks?: boolean } = {}): OcTracker {
  const existing = trackers.get(oc as object);
  if (existing) return existing;
  const O = oc as any;
  const transient = O.Standard_Transient as Function | undefined;
  const tokens = new WeakMap<object, Token>();
  let found: Token[] = [];
  let liveCount = 0;
  const registry = new FinalizationRegistry<Token>((t) => { if (!t.deleted) { found.push(t); liveCount--; } });

  // The common base of every wrapped class holds delete(); mark the object's token when it is called.
  const anyClass = Object.keys(O).map((k) => O[k]).find((v) => typeof v === 'function' && v.prototype && typeof v.prototype.delete === 'function');
  let base = anyClass.prototype;
  while (Object.getPrototypeOf(base) && !Object.prototype.hasOwnProperty.call(base, 'delete')) base = Object.getPrototypeOf(base);
  const del = base.delete;
  base.delete = function (this: object) {
    const t = tokens.get(this);
    del.call(this);
    if (t && !t.deleted) { t.deleted = true; liveCount--; }
  };

  const clean = (l: string) => l.trim().replace(/^at /, '').replace(/\/home\/[^)]*?\/chatcad\//, '').replace(/\?[^:]*:/, ':');
  const site = () => {
    const lines = (new Error().stack ?? '').split('\n').slice(3).filter((x) => !x.includes('ocLeaks.ts') && !x.includes('node_modules'));
    const first = clean(lines[0] ?? '');
    // The outermost kernel frame before a test (or bench) frame: which kernel entry point leaked it.
    const t = lines.findIndex((x) => x.includes('/tests/') || x.includes('/bench/'));
    const entry = t > 0 ? clean(lines[t - 1]) : '';
    return entry && entry !== first ? `${first}  <=  ${entry}` : first;
  };
  const isValueObject = (r: any) => r !== null && typeof r === 'object' && base.isPrototypeOf(r) && !(transient && r instanceof transient);
  const note = (r: any, origin: string) => {
    if (!isValueObject(r) || tokens.has(r)) return r;
    const t: Token = { origin, deleted: false, ...(opts.stacks ? { site: site() } : {}) };
    tokens.set(r, t);
    registry.register(r, t);
    liveCount++;
    return r;
  };
  const wrap = (fn: Function, origin: string) => {
    const w = function (this: unknown, ...args: unknown[]) { return note(fn.apply(this, args), origin); };
    // Overloaded functions keep their overload table on the function itself.
    for (const k of Object.getOwnPropertyNames(fn)) if (!['length', 'name', 'prototype', 'arguments', 'caller'].includes(k)) Object.defineProperty(w, k, Object.getOwnPropertyDescriptor(fn, k)!);
    return w;
  };

  for (const name of Object.keys(O)) {
    const C = O[name];
    if (typeof C !== 'function') continue;
    // Static functions (BRep_Tool.Triangulation, TopoDS.Face, ...).
    for (const k of Object.getOwnPropertyNames(C)) {
      if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(k)) continue;
      const d = Object.getOwnPropertyDescriptor(C, k);
      if (d && typeof d.value === 'function' && d.writable) C[k] = wrap(d.value, `${name}.${k}`);
    }
    // Methods (Explorer.Current, Triangulation.Node, ...).
    const P = C.prototype;
    if (P && P !== base) {
      for (const k of Object.getOwnPropertyNames(P)) {
        if (k === 'constructor' || k === 'delete' || k === 'isDeleted' || k === 'deleteLater' || k === 'isAliasOf') continue;
        const d = Object.getOwnPropertyDescriptor(P, k);
        if (d && typeof d.value === 'function' && d.writable) P[k] = wrap(d.value, `${name}.${k}`);
      }
    }
    // Constructors.
    if (P && typeof P.delete === 'function') {
      O[name] = new Proxy(C, { construct(target, args, nt) { return note(Reflect.construct(target, args, nt), `new ${name}`); } });
    }
  }

  const tracker: OcTracker = {
    async leaks() {
      for (let i = 0; i < 4; i++) { forceGc(); await new Promise((r) => setTimeout(r, 10)); }
      const got = found; found = [];
      const count = (key: (t: Token) => string | undefined) => {
        const m = new Map<string, number>();
        for (const t of got) { const k = key(t); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
        return [...m].sort((a, b) => b[1] - a[1]);
      };
      return { total: got.length, byOrigin: count((t) => t.origin), bySite: count((t) => t.site && `${t.origin} @ ${t.site}`) };
    },
    live: () => liveCount,
  };
  trackers.set(oc as object, tracker);
  return tracker;
}
