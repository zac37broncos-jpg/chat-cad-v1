# Publishing CHAD as a static website

CHAD's public website is a plain static site (the `dist` folder that `npm run build` makes) plus
one small serverless function, `/api/proxy`, that forwards each user's own AI key to the provider
they chose (bring your own key, [BYOK_AI.md](BYOK_AI.md)). Step-by-step sign-up and deploy
instructions for Vercel and Cloudflare Pages are in [BYOK_AI.md, "Deploy the proxy"](BYOK_AI.md#deploy-the-proxy).
This page explains what the build needs from the host and how the repository makes sure of it.

## 1. No Node-only code in the website

The website runs only in the browser. Two packages in the repository need Node.js and can never
run there: `ws` (a WebSocket server) and `@modelcontextprotocol/sdk` (the MCP protocol over a
local process). They are used only by the **local Claude Code mode**: `bridge/hub.mjs` and
`bridge/mcp-server.mjs`, which run on your own computer when CHAD starts from `npm run dev` or the
desktop launcher, and let the chat use your Claude subscription.

- They are `devDependencies`: tools for the local server, like Vite itself. The website's
  `dependencies` are only what the browser downloads (OpenCascade, planegcs, three.js, React).
- `vite.config.ts` loads the bridge only when the dev server starts, from a path built at run time,
  so `vite build` never reads it. If the two packages are missing, the dev server still starts
  and only the Claude Code choice in AI Settings is unavailable.
- The browser side never used them: the website's chat uses `fetch()` to `/api/proxy` with the
  providers' own tool calling (`src/ai/byok/agent.ts`, `src/ai/byok/providers.ts`), and the local
  mode talks to the bridge with the browser's built-in `WebSocket` (`src/ai/bridgeClient.ts`, only
  on `localhost`).
- `tests/deploy.test.ts` builds the app and fails if any Node-only package, bridge code, or Node
  built-in (other than inside the Emscripten loaders' "are we in Node?" branch) gets into the
  website.

## 2. Headers for the OpenCascade WebAssembly

Every response of the site carries:

| Header | Value | Why |
|---|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` | Together with the next one, makes the page "cross-origin isolated", which browsers require before they allow `SharedArrayBuffer` and WebAssembly threads (the multi-threaded OpenCascade build). |
| `Cross-Origin-Embedder-Policy` | `require-corp` | The page may only load files from other websites that explicitly allow it. CHAD loads nothing from other websites, so nothing is blocked. |
| `X-Content-Type-Options` | `nosniff` | Browsers trust the declared file type (hosts send `.wasm` as `application/wasm`). |

Files in `/assets/` (their names contain a content hash) are also sent with
`Cache-Control: public, max-age=31536000, immutable`, so returning users do not download the
23 MB OpenCascade file again until it changes.

Where they are set (`tests/deploy.test.ts` fails if these disagree):

- `vite.config.ts`: `npm run dev` and `npm run preview` (COOP and COEP).
- `vercel.json`: Vercel.
- `public/_headers`: Cloudflare Pages (copied into `dist` by the build).

Notes:

- The current app uses the single-threaded OpenCascade build (`replicad_single.wasm`), which works
  with or without isolation. The headers are there so a threaded build can be used later, and the
  About window (Options, About CHAD and licences) shows "Cross-origin isolation: on" when a
  deployed site sends them correctly. That is the quickest check after a deploy.
- `/api/proxy` is on the same address as the app, so COEP does not affect it. On Cloudflare Pages
  `_headers` does not apply to Functions, which is fine: the proxy's answers are data, not pages.
- Do not add images, fonts, scripts or frames from other websites. COEP would block them, and an
  outside script could read users' saved keys ([BYOK_AI.md, Security](BYOK_AI.md#security)).
- Cloudflare Pages refuses any single file over 25 MiB. `replicad_single.wasm` is about 21.9 MiB;
  `tests/deploy.test.ts` fails if a `.wasm` file grows past the limit.
- Each `.wasm` file stays a separate file in `dist/assets` (never inlined), as the LGPL notes in
  [LICENSES.md](LICENSES.md) require.

## 3. Licence

CHAD's own code is under the MIT licence (`LICENSE`, `package.json` `"license": "MIT"`). The
open-source parts keep their own licences, listed with full texts in
`public/THIRD_PARTY_NOTICES.txt` (made by `node scripts/third-party-notices.mjs`). The About
window (`src/ui/AboutModal.tsx`) states that the 3D engine is Open CASCADE Technology under the
LGPL-2.1 with the Open CASCADE Exception, names every package the app ships, links the notices
and shows the MIT licence. `tests/legal.test.ts` guards all of this.

## How it is tested

- `tests/deploy.test.ts`: builds the app in memory and checks the points above.
- `e2e/production.spec.ts` (part of `npm run smoke`, so CI runs it): builds the production site,
  serves it with `vite preview` and the headers, and in real Chromium checks that the page is
  cross-origin isolated, the OpenCascade `.wasm` arrives as `application/wasm` and really builds a
  part with the exact expected volume, the worker gets the headers, nothing is blocked, the real
  `/api/proxy` answers, and the About window shows the OCCT notice.

To try the production site on your own computer: `npm run build`, then `npm run preview`, and open
the address it prints.
