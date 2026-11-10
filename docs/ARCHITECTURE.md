# Architecture

CHAD is a TypeScript single-page app. Everything runs in the browser except one small serverless function that forwards AI requests (and, when you run it on your own computer, an optional local bridge to Claude Code).

```
Browser
├─ UI (React)                    src/ui          ribbon, feature tree, command panels, sketcher, chat, dialogs
├─ 3D view (three.js)            src/render      viewport, navigation presets, drag handles, offscreen renders for the AI
├─ Document + commands           src/core        the part document, units and expressions, the single command API, undo/redo
├─ Sketch maths                  src/sketch      sketch geometry, planegcs solver wrapper, CHAD's own residual equations
├─ AI chat                       src/ai          tool schemas (JSON), executor, reference library, BYOK chat loop
└─ Geometry worker (Web Worker)  src/kernel      OpenCascade (WebAssembly): rebuild, mesh, mass, quality check, STL/STEP

Server side (optional)
├─ /api/proxy                    proxy/core.mjs  forwards the user's own key to Anthropic, OpenAI or Google (Vercel: api/, Cloudflare: functions/)
└─ Local Claude Code bridge      bridge/         dev server only: runs the user's own Claude Code and gives it the CAD tools over MCP
```

## One command API

Every change, whether it comes from a mouse click, a dialog or the AI chat, is a command on `DocumentStore` (`src/core/store.ts`). A command updates the document (a JSON feature history: parameters, sketches and features), records an undo step and notifies the UI. That is what makes AI edits real, visible, editable and undoable: the AI cannot do anything the toolbar cannot. A whole AI request is squashed into one undo step. The undo history is capped (200 steps, fewer only for very large parts, never fewer than 20).

## Rebuilding the part

The document goes to the geometry worker (`src/kernel/worker.ts`), which replays the history with OpenCascade (`src/kernel/regen.ts` and `src/kernel/features/`) and returns the display mesh, each feature's status, face names and mass properties. Rebuilds are incremental: the unchanged start of the history is reused. A feature that fails shows red in the tree with the reason; it never silently produces a different shape. Booleans are checked by measuring the volume they changed, because the kernel occasionally returns a wrong boolean without an error ([ORGANIC_MODELING.md](ORGANIC_MODELING.md), "Checked booleans").

The worker's WebAssembly heap only grows, so the client (`src/kernel/client.ts`) replaces the worker with a fresh one past a size limit, and restarts it after a crash.

## Persistent naming

Fillets, chamfers, holes and shells refer to faces and edges by tags recorded from the kernel's own history, not by index, so they follow the right geometry when earlier dimensions change: [TOPOLOGICAL_NAMING.md](TOPOLOGICAL_NAMING.md).

## Precision

The precision rules are the foundation of the app:

- All internal geometry is in millimetres, in IEEE-754 doubles. Inches exist only for input and display (1 in = 25.4 mm exactly).
- What the user types is stored as the original expression string ("0.25 in", "W/2"), never as a rounded number, so saving and reopening cannot drift a value (`src/core/units.ts`).
- Geometry is exact B-rep from OpenCascade. The triangle mesh is for display only: measurements, mass properties and STEP export use the exact solid.
- Every sketch solve by planegcs is checked against CHAD's own constraint equations (`src/sketch/equations.ts`); a sketch that does not satisfy its constraints is flagged, never silently approximated.
- STL export measures the real distance between its triangles and the true surface and meshes finer where needed (`src/kernel/exporters.ts`). The accuracy promise is 0.005 in (0.127 mm); the default export is 1/12 of that.
- Tests check volumes, sizes and positions against hand calculations, and STL/STEP files against independent readers.

## The AI chat

The AI sees the same tools in both modes: the CAD tools in `src/ai/*.json` (sketches, features, parameters, a batch `build_model` tool, organic shortcuts such as `loft_sections` and `tube`, `view_model` renders, `get_reference`, `check_part`), executed by `src/ai/executor.ts` through the command API.

- **Bring your own key** (the published website): the chat loop runs in the browser (`src/ai/byok/agent.ts`), with per-provider request formats in `src/ai/byok/providers.ts`. Requests go through `/api/proxy` because the providers' APIs cannot be called from a web page directly. [BYOK_AI.md](BYOK_AI.md)
- **Claude Code on this computer** (local only): the dev server's bridge runs the user's own Claude Code headless and exposes the CAD tools to it over MCP. [AI_CHAT.md](AI_CHAT.md)

Both modes share the same guards per request (number of AI turns, tool calls and renders; repeated failures stop the run) and the same instructions (`bridge/system-prompt.md`).

## Deployment

`npm run build` makes a static site in `dist/`. The site sends cross-origin isolation headers so a multi-threaded OpenCascade build can be used later, loads nothing from other websites, and keeps the `.wasm` files separate: [DEPLOY.md](DEPLOY.md).

## Tests

- `tests/` (Vitest): kernel features against hand calculations, sketch solving, persistent naming, exports read back by independent parsers, AI tools driven the way the AI calls them, the BYOK formats and proxy, the local bridge's security, autosave, licences, deployment headers and a privacy scan of the whole repository.
- `e2e/` (Playwright, real Chromium): the app driven with mouse and keyboard, autosave, exports, mass properties, the BYOK chat against a fake proxy, and the production build served with its headers.
- `bench/`: kernel timings and memory (reported, not asserted).
- `verify/print/`: the independent print verification ([PRINT_VERIFICATION.md](PRINT_VERIFICATION.md)).
