# How the AI chat works

## Goal
Type a request in the CAD window; the AI builds or edits the part step by step in front of the user, through the same commands as the toolbar. Every step becomes a named, editable feature.

The chat has two modes:

- **Bring your own key** (the published website, and also available locally): Anthropic, OpenAI or Google Gemini with the user's own API key. See [BYOK_AI.md](BYOK_AI.md).
- **Claude Code on this computer** (local only): the user's own Claude Code sign-in, through a small bridge in the dev server. This page describes that mode; the tools, guards and instructions are the same in both.

## Claude Code mode
```
CHAD window (browser)
  └─ BridgeClient (src/ai/bridgeClient.ts) ──ws role=app──┐
                                                           ▼
Vite dev server ── bridge hub (bridge/hub.mjs) ── spawns `claude -p` (Claude Code, the user's own sign-in)
                                                           │ stdio MCP
                                                  bridge/mcp-server.mjs ──ws role=mcp──┘
```
1. The chat sends the request to the hub, which runs headless Claude Code:
   `claude -p --output-format stream-json --verbose --mcp-config <tmp> --strict-mcp-config --tools "" --allowedTools mcp__chatcad,WebSearch,WebFetch --append-system-prompt-file bridge/system-prompt.md [--resume <session>]`
   with the prompt on stdin. Built-in tools are disabled: Claude can only use the CAD tools, plus read-only web research.
2. Claude calls the CAD tools (`src/ai/*.json`; the MCP server is named `chatcad` for historical reasons, see `src/brand.ts`). The MCP server forwards each call to the open window, where `executeTool` (`src/ai/executor.ts`) runs it through `DocumentStore`, regenerates, and returns ok/error plus exact volume and bounding box so Claude can verify its work.
3. Stream events become the chat's step list. When the request finishes, all its changes are squashed into one undo step (`store.squashSince`).
4. Follow-up messages resume the same Claude session; "New chat" starts fresh.

The user signs in with Claude Code's own sign-in flow (the chat panel's **Sign in to Claude** button opens it). CHAD never reads, stores or forwards the user's Claude credentials.

## Whole models
For a whole object the AI plans first, then builds in a few large `build_model` stages (main masses, details, blends) using the organic tools (profile_body, loft_sections, tube, splines, ovals), calls `view_model` after each stage to look at shaded renders of the part, and fixes what looks off. Before modelling a recognizable subject it calls `get_reference` (reference sheets and tested worked examples, such as an Easter Island head and a cartoon bear); in Claude Code mode it may also research the subject with WebSearch / WebFetch. Every build ends with the part quality check (one solid, watertight STL, clean STEP).
Every step stays a named, editable feature. MCP calls from the in-app chat get 15 minutes (per-server `timeout` in the generated MCP config plus `MCP_TOOL_TIMEOUT`); build_model's own socket timeout is 900 s.
Details: [ORGANIC_MODELING.md](ORGANIC_MODELING.md).

## Safety
- The hub accepts loopback connections only. App sockets must come from this server's own page (same port); MCP sockets with an Origin header (a web page) are refused.
- Each in-app run has its own token; its tool calls reach only the window that started it. Closing that window fails its pending calls and stops the run.
- Usage guards per request (`LIMITS` in `bridge/hub.mjs`): 60 turns (`--max-turns`), 150 tool calls, 6 view_model renders, 3 identical failures in a row stop the run, one request at a time per window, Stop kills the whole process tree. Nothing is ever re-sent automatically.
- Claude has no shell or file tools in this mode; besides the CAD tools it may only use WebSearch and WebFetch (read-only research for references).
- Untokened loopback MCP clients (for example the Claude desktop app) are allowed, so a desktop app on the same computer can also drive the window; their calls go to the newest window.
- The automated tests never start the real Claude Code: they use a fake Claude process (`tests/fixtures/fake-claude.mjs`), and the browser tests point the bridge at a path that does not exist.

## Optional: drive CHAD from the Claude desktop app
Add to the desktop app's MCP config (Settings > Developer > Edit config), with the real path:
```json
{ "mcpServers": { "chatcad": { "command": "node", "args": ["C:\\path\\to\\chat-cad-v1\\bridge\\mcp-server.mjs"] } } }
```
CHAD must be running (`npm run dev`) with the window open.

## Verified
- "4 x 2 x 0.5 in plate with two 1/4\" holes..." built with parameters in about 16 s; volume 3.950913 in³ (exact).
- A multi-turn edit (thicken + pocket) resumed the session correctly.
- A selection-aware question was answered from the exact face area.
- A mm flange with a bolt circle: Claude switched the document to mm and stated its assumption about the hole angle.
- The Windows paths for `claude.exe` are resolved via `where`, the native install location, then the npm shim (unit-tested).
