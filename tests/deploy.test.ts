import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';
import { CROSS_ORIGIN_ISOLATION } from '../vite.config';

// Guards the public static deployment (docs/DEPLOY.md): the browser build contains no Node-only
// code, the OpenCascade WebAssembly stays a separate file small enough for every host, and the
// cross-origin isolation headers are the same in the dev server, Vercel and Cloudflare Pages.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

/** Packages that need Node.js (a server, sockets, child processes): never in the browser app. */
const NODE_ONLY = ['ws', '@modelcontextprotocol/sdk', 'express', 'hono', '@hono/node-server', 'cross-spawn', 'eventsource', 'cors', 'body-parser'];
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
/** The Emscripten loaders of the two WebAssembly modules mention node:* behind an "are we in Node?" check. */
const EMSCRIPTEN_GLUE = [
  'node_modules/replicad-opencascadejs/dist/replicad_single.js',
  'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.js',
];
/** Cloudflare Pages refuses any single file over 25 MiB (developers.cloudflare.com/pages/platform/limits). */
const CLOUDFLARE_MAX_FILE = 25 * 1024 * 1024;

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const f of readdirSync(join(root, dir))) {
    const p = `${dir}/${f}`;
    if (statSync(join(root, p)).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(p)) out.push(p);
  }
  return out;
}

const rel = (id: string) => relative(root, id.replace(/^\0/, '').split('?')[0]).split(sep).join('/');

/** Builds the app like `npm run build` (in memory) and records every module and every import. */
async function buildInMemory() {
  const modules = new Set<string>();
  const imports: { source: string; importer: string }[] = [];
  const spy = (): Plugin => ({
    name: 'deploy-test-spy',
    enforce: 'pre',
    resolveId(source, importer) { if (importer) imports.push({ source, importer: rel(importer) }); return null; },
    load(id) { modules.add(rel(id)); return null; },
  });
  const result = await build({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'silent',
    plugins: [spy()],
    worker: { plugins: () => [spy()] },
    build: { write: false, reportCompressedSize: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  return { modules, imports, items: outputs.flatMap((o) => o.output) };
}

describe('public static deployment', () => {
  it('the app ships only browser packages; Node-only ones are local-mode tooling (devDependencies)', () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const n of NODE_ONLY) expect(deps, n).not.toContain(n);
    // The local Claude Code bridge still has what it needs for `npm run dev` and the launcher.
    expect(pkg.devDependencies).toHaveProperty('ws');
    expect(pkg.devDependencies).toHaveProperty('@modelcontextprotocol/sdk');
  });

  it('no app source imports Node built-ins, the bridge, or Node-only packages', () => {
    const bad: string[] = [];
    for (const f of files('src', /\.(ts|tsx)$/)) {
      for (const m of read(f).matchAll(/(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1] ?? m[2] ?? m[3];
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(name) || NODE_ONLY.includes(name) || /(^|\/)bridge\/[^?]*\.(m?js|ts)$/.test(spec)) bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the production build has no Node-only code, and the WebAssembly files are separate and small enough', async () => {
    const { modules, imports, items } = await buildInMemory();
    const all = [...modules];
    // The build really went through the app, its worker and the OpenCascade loader.
    expect(all).toContain('src/main.tsx');
    expect(all).toContain('src/kernel/worker.ts');
    expect(all).toContain('node_modules/replicad-opencascadejs/dist/replicad_single.js');

    // bridge/system-prompt.md (plain text, the AI instructions) is shared with the BYOK chat; its code is not.
    expect(all.filter((m) => /^bridge\/.*\.(m?js|ts)$/.test(m) || NODE_ONLY.some((n) => m.startsWith(`node_modules/${n}/`)))).toEqual([]);
    // Packages bundled from node_modules: only the dependencies (and what they use), plus Vite's own helpers.
    const allowed = new Set([...Object.keys(pkg.dependencies), 'scheduler', 'vite', 'loose-envify', 'js-tokens']);
    const bundled = new Set(all.filter((m) => m.startsWith('node_modules/')).map((m) => {
      const p = m.slice('node_modules/'.length).split('/');
      return p[0].startsWith('@') ? `${p[0]}/${p[1]}` : p[0];
    }));
    for (const b of bundled) expect(allowed.has(b), `bundled package ${b}`).toBe(true);
    // Node built-ins are only named by the Emscripten loaders (inside their Node-only branch).
    const nodeImports = imports.filter((i) => NODE_BUILTINS.has(i.source)).map((i) => i.importer);
    for (const i of nodeImports) expect(EMSCRIPTEN_GLUE, `${i} imports a Node built-in`).toContain(i);

    const code = items.filter((o): o is Rollup.OutputChunk => o.type === 'chunk').map((c) => c.code)
      .concat(items.filter((o): o is Rollup.OutputAsset => o.type === 'asset' && o.fileName.endsWith('.js')).map((a) => String(a.source)));
    for (const marker of ['WebSocketServer', 'StdioServerTransport', 'modelcontextprotocol', 'child_process']) {
      expect(code.some((c) => c.includes(marker)), marker).toBe(false);
    }

    const wasm = items.filter((o): o is Rollup.OutputAsset => o.type === 'asset' && o.fileName.endsWith('.wasm'));
    expect(wasm.map((w) => w.fileName.replace(/-[\w-]{8}\.wasm$/, '.wasm')).sort()).toEqual(['assets/planegcs.wasm', 'assets/replicad_single.wasm']);
    for (const w of wasm) expect(w.source.length, w.fileName).toBeLessThan(CLOUDFLARE_MAX_FILE);
    for (const c of code) expect(c.includes('data:application/wasm'), 'a .wasm inlined into JavaScript').toBe(false);
  });

  it('dev server, Vercel and Cloudflare Pages send the same cross-origin isolation headers on every path', () => {
    expect(CROSS_ORIGIN_ISOLATION).toEqual({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });

    const vercel = JSON.parse(read('vercel.json'));
    const vAll = vercel.headers.find((h: any) => h.source === '/(.*)');
    expect(vAll, 'vercel.json needs a rule for /(.*)').toBeTruthy();
    const vMap = Object.fromEntries(vAll.headers.map((h: any) => [h.key, h.value]));
    for (const [k, v] of Object.entries(CROSS_ORIGIN_ISOLATION)) expect(vMap[k], `vercel.json ${k}`).toBe(v);
    expect(vMap['X-Content-Type-Options']).toBe('nosniff');
    expect(vercel.outputDirectory).toBe('dist');

    // public/_headers: a path line, then indented "Name: value" lines (Cloudflare's format).
    const rules = new Map<string, Record<string, string>>();
    let cur: Record<string, string> | null = null;
    for (const line of read('public/_headers').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) { cur = {}; rules.set(line.trim(), cur); continue; }
      const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
      expect(m && cur, `bad _headers line: ${line}`).toBeTruthy();
      cur![m![1].trim()] = m![2].trim();
    }
    const cAll = rules.get('/*');
    expect(cAll, 'public/_headers needs a rule for /*').toBeTruthy();
    for (const [k, v] of Object.entries(CROSS_ORIGIN_ISOLATION)) expect(cAll![k], `_headers ${k}`).toBe(v);
    expect(cAll!['X-Content-Type-Options']).toBe('nosniff');
    expect(rules.size).toBeLessThanOrEqual(100); // Cloudflare's limit

    // Long caching only for /assets/, whose file names change with every content change.
    const immutable = 'public, max-age=31536000, immutable';
    expect(rules.get('/assets/*')?.['Cache-Control']).toBe(immutable);
    expect(vercel.headers.find((h: any) => h.source === '/assets/(.*)')?.headers).toEqual([{ key: 'Cache-Control', value: immutable }]);
    for (const h of vercel.headers) if (h.source !== '/assets/(.*)') expect(JSON.stringify(h)).not.toContain('immutable');
  });

  it('nothing in the app is loaded from another website (COEP require-corp would block it)', () => {
    expect(read('index.html')).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=["']https?:/i);
    for (const f of [...files('src', /\.(ts|tsx|css)$/)]) {
      const s = read(f);
      expect(s, f).not.toMatch(/new Worker\(\s*['"`]https?:|importScripts\(\s*['"`]https?:|@import\s+url\(\s*['"]?https?:|<(img|iframe|script)[^>]+src=["'{`]+https?:/);
    }
  });
});
