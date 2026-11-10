/// <reference lib="webworker" />
import init from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import { regenerate, common, releaseRegen, type OC, type RegenResult } from './regen';
import { free } from './mem';
import gcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { createSketchSolver, type SketchSolver } from '../sketch/solver';
import { tessellate, massProperties, entityInfo, minDistance } from './query';
import { regenOp, newModelState, modelForExport } from './regenOp';
import { exportStepFile, exportStlFile } from './exporters';
import type { KernelRequest } from './protocol';
import { drawingGeometry } from './hlr';
import { partQuality } from './quality';

let ocPromise: Promise<OC> | null = null;
let ocModule: OC | null = null;
const getOC = () => (ocPromise ??= (init({ locateFile: () => wasmUrl }) as Promise<OC>).then((m) => (ocModule = m)));
let solverPromise: Promise<SketchSolver> | null = null;
const getSolver = () => (solverPromise ??= createSketchSolver(gcsWasmUrl));
/** The last regenerated shape and its cached mesh and mass (see ./regenOp.ts). */
const model = newModelState();
/** Drawing views regenerate the part separately (full history), cached by document JSON. Owns its result. */
let drawingCache: { key: string; result: RegenResult; volume: number | null; sketches: unknown[] } | null = null;

function need(): TopoDS_Shape {
  if (!model.current) throw new Error('There is no solid yet');
  return model.current;
}

/** Current size of the OpenCascade WASM heap (the client replaces the worker when it gets too big). */
function heapBytes(): number {
  return ((ocModule as any)?.wasmMemory?.buffer?.byteLength as number | undefined) ?? 0;
}
/**
 * After these errors the WASM module is broken (aborted, memory exhausted or
 * corrupted) and every later call would fail: the client starts a fresh worker.
 * Ordinary modelling errors (a C++ exception, a bad value) are not fatal.
 */
function isFatal(e: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /\bAborted\b|out of memory|memory access out of bounds|\bunreachable\b|Cannot enlarge memory/i.test(m);
}

self.onmessage = async (ev: MessageEvent<{ id: number; req: KernelRequest }>) => {
  const { id, req } = ev.data;
  try {
    const oc = await getOC();
    let result: unknown;
    const transfer: Transferable[] = [];
    switch (req.op) {
      case 'regen': {
        const out = regenOp(oc, model, req, await getSolver());
        result = out.result;
        transfer.push(...out.transfer);
        break;
      }
      case 'preview': {
        const idx = req.doc.features.findIndex((f) => f.id === req.featureId);
        if (idx < 0) throw new Error('Preview feature not found');
        // Both rebuilds are uncached: their shapes belong to this preview and are freed below.
        let before: RegenResult | null = null, withTool: RegenResult | null = null;
        let cutPart: TopoDS_Shape | null = null, shownComp: TopoDS_Shape | null = null;
        try {
          before = regenerate(oc, { ...req.doc, rollback: idx }, { topology: !!req.topology, solver: await getSolver() });
          withTool = regenerate(oc, { ...req.doc, rollback: idx + 1 }, { captureToolFor: req.featureId, topology: false, solver: await getSolver() });
          const st = withTool.status.find((x) => x.id === req.featureId);
          const base = before.shape ? tessellate(oc, before.shape) : null;
          // For cuts show only the material that will be removed (Through All tools are very long).
          let toolShape = withTool.tool;
          const feat = req.doc.features[idx];
          const isCut = ('operation' in feat && feat.operation === 'cut') || feat.type === 'hole';
          if (toolShape && before.shape && isCut) {
            try {
              const c = common(oc, before.shape, toolShape);
              if (massProperties(oc, c).volume > 1e-9) { toolShape = c; cutPart = c; } else c.delete();
            } catch { /* fall back to the full tool */ }
          }
          const tool = toolShape ? tessellate(oc, toolShape) : null;
          // In-place features (fillet, chamfer, shell, draft) have no tool body: send the faces the feature made
          // (fillet rounds, chamfer bevels, shell walls), or the whole result when it only modified faces (draft).
          let after: ReturnType<typeof tessellate> | null = null;
          const named = withTool.named;
          if (!toolShape && st?.ok && withTool.shape) {
            const own = named ? named.faces.filter((_, i) => named.tags[i].some((t) => t.startsWith(`${req.featureId}:`))) : [];
            let shown: TopoDS_Shape = withTool.shape;
            if (own.length && own.length < (named?.faces.length ?? 0)) {
              const b = new oc.TopoDS_Builder(); const comp = new oc.TopoDS_Compound(); b.MakeCompound(comp);
              for (const f of own) b.Add(comp, f);
              b.delete();
              shown = shownComp = comp;
            }
            after = tessellate(oc, shown);
          }
          for (const m of [base, tool, after]) if (m) for (const f of m.faces) transfer.push(f.positions.buffer, f.normals.buffer, f.indices.buffer);
          result = { base, tool, ...(after ? { result: after } : {}), ...(req.topology ? { baseTopology: before.topology ?? null } : {}), ok: !!st?.ok && !!(toolShape || after), ...(st?.message ? { message: st.message } : {}) };
        } finally {
          free(cutPart, shownComp);
          releaseRegen(before); releaseRegen(withTool);
        }
        break;
      }
      case 'info': result = entityInfo(oc, need(), req.ref.kind, req.ref.index); break;
      case 'distance': result = minDistance(oc, need(), req.a, req.b); break;
      case 'exportStep': {
        const m = modelForExport(oc, model, req.doc, await getSolver());
        result = { ...exportStepFile(oc, m.shape, { unit: req.unit, schema: req.schema, name: req.name, fileName: req.fileName }), failed: m.failed };
        break;
      }
      case 'quality': result = partQuality(oc, need()); break;
      case 'drawing': {
        const full = { ...req.doc, rollback: null };
        const key = JSON.stringify(full);
        if (!drawingCache || drawingCache.key !== key) {
          const solver = await getSolver();
          if (drawingCache) { releaseRegen(drawingCache.result); drawingCache = null; }
          const r = regenerate(oc, full, { topology: false, solver });
          drawingCache = { key, result: r, volume: r.shape ? massProperties(oc, r.shape).volume : null, sketches: r.sketches };
        }
        result = { ...drawingGeometry(oc, drawingCache.result.shape, req.views), volume: drawingCache.volume, sketches: drawingCache.sketches };
        break;
      }
      case 'exportStl': {
        const m = modelForExport(oc, model, req.doc, await getSolver());
        const r = { ...exportStlFile(oc, m.shape, { linearDeflection: req.linearDeflection, angularDeflection: req.angularDeflection, unit: req.unit, format: req.format, name: req.name }), failed: m.failed };
        transfer.push(r.data.buffer);
        result = r;
        break;
      }
    }
    (self as unknown as Worker).postMessage({ id, ok: true, result, heap: heapBytes() }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e), heap: heapBytes(), ...(isFatal(e) ? { fatal: true } : {}) });
  }
};
