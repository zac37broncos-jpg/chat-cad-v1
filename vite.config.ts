/// <reference types="vitest/config" />
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
// @ts-expect-error plain JS module (no imports of its own, safe in every build)
import { handleProxy } from './proxy/core.mjs';
import brand from './brand.json' with { type: 'json' };

/**
 * Cross-origin isolation: lets the browser give the page SharedArrayBuffer and WebAssembly threads
 * (needed by the multi-threaded OpenCascade build, replicad-opencascadejs/multi) and precise timers.
 * The same two headers are set for the published site in vercel.json (Vercel) and public/_headers
 * (Cloudflare Pages); tests/deploy.test.ts fails if the three ever disagree.
 * Everything CHAD loads comes from its own address (the app, the worker, both .wasm files and
 * /api/proxy), so require-corp blocks nothing it needs. docs/DEPLOY.md explains more.
 */
export const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

/** Runs a Node request through proxy/core.mjs (the same code the published site uses). */
const proxyMiddleware: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', async () => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const method = req.method ?? 'GET';
    const request = new Request(`http://${req.headers.host ?? 'localhost'}/api/proxy`, {
      method, headers, signal: abort.signal,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
    });
    try {
      const out: Response = await handleProxy(request, { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '' });
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch {
      if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'application/json'); }
      res.end(JSON.stringify({ proxyError: 'The local AI proxy failed.' }));
    }
  });
};

/**
 * Serves /api/proxy on the local dev server (`npm run dev`) and on `npm run preview` with the same
 * code as the published site, so bring-your-own-key chat works locally too.
 */
function byokProxy(): Plugin {
  return {
    name: 'chad-byok-proxy',
    configureServer(server) { server.middlewares.use('/api/proxy', proxyMiddleware); },
    configurePreviewServer(server) { server.middlewares.use('/api/proxy', proxyMiddleware); },
  };
}

/**
 * Local mode only: starts the Claude Code bridge (bridge/hub.mjs) inside the dev server, so
 * `npm run dev` and the desktop launcher run everything with the user's own Claude subscription.
 *
 * The bridge needs the Node-only packages `ws` and `@modelcontextprotocol/sdk` (devDependencies).
 * It is loaded only here, at dev-server start, from a path built at run time, so `vite build` never
 * reads it and the published site never contains it (tests/deploy.test.ts checks the bundle).
 * If those packages are missing, the dev server still starts and only the Claude Code choice is off.
 */
function chadBridge(): Plugin {
  return {
    name: 'chatcad-bridge',
    apply: 'serve',
    async configureServer(server) {
      const http = server.httpServer;
      if (!http) return;
      const log = server.config.logger;
      let attachBridge: (h: typeof http, o: { port: number; log: (m: string) => void; model?: string }) => { close(): void };
      try {
        const hub = pathToFileURL(resolve(server.config.root, 'bridge/hub.mjs')).href;
        ({ attachBridge } = await import(/* @vite-ignore */ hub));
      } catch (e) {
        log.warn(`[chatcad] Claude Code bridge not started (${e instanceof Error ? e.message : String(e)}). Bring-your-own-key chat still works.`);
        return;
      }
      http.once('listening', () => {
        const addr = http.address();
        const port = typeof addr === 'object' && addr ? addr.port : brand.port;
        const bridge = attachBridge(http, { port, log: (m: string) => log.info(`[chatcad] ${m}`), model: process.env.CHATCAD_MODEL });
        http.once('close', () => bridge.close());
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), chadBridge(), byokProxy()],
  // CHAD's own port (brand.json), so it never shares a browser address, and with it the autosave, with ChatCAD (5173).
  server: { host: 'localhost', port: brand.port, headers: CROSS_ORIGIN_ISOLATION },
  preview: { headers: CROSS_ORIGIN_ISOLATION },
  worker: { format: 'es' },
  // The OpenCascade module is loaded as-is (its .wasm is a separate, replaceable file: LGPL-2.1 section 6).
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  // Keep each .wasm a separate file in dist/assets (never inlined as base64 into JavaScript).
  build: { assetsInlineLimit: (file: string) => (file.endsWith('.wasm') ? false : undefined) },
  // bench/ holds the benchmark suite (npm run bench), not part of npm test.
  test: { testTimeout: 60000, exclude: ['**/node_modules/**', 'bench/**', 'e2e/**'] },
});
