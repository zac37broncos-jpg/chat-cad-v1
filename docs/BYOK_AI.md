# Bring your own key (BYOK) AI chat

CHAD's AI chat can run on the user's own AI account, so each user pays their own AI provider
for what they use and whoever hosts the site pays nothing per request. This page explains how it works,
what is different between providers, the security rules, and how to put the proxy online.

## How it works

```
CHAD page (browser)                         your website                    AI provider
  AI Settings: provider + key  ──►  POST /api/proxy  ──►  api.anthropic.com/v1/messages
  (saved in localStorage)          (proxy/core.mjs)        api.openai.com/v1/chat/completions
  chat loop + CAD tools run here                          generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

1. **AI Settings** (the gear ⚙ in the chat header, `src/ui/AiSettingsModal.tsx`): pick Anthropic,
   OpenAI or Google Gemini, paste a key (a password field, so it is hidden), optionally a model.
   Saved in this browser's localStorage only (`src/ai/byok/settings.ts`, keys `chad.ai.provider`,
   `chad.ai.apiKey`, `chad.ai.model`).
2. **The chat client** (`src/ai/bridgeClient.ts`) reads the provider and key from localStorage
   for every request. With no key, Send shows an alert and opens AI Settings; nothing is sent.
3. **The chat loop** (`src/ai/byok/agent.ts`) runs in the browser: it sends the conversation and
   CHAD's 35 CAD tools to the model, runs each tool call with the same executor as before
   (`src/ai/executor.ts`, so every step is a real, named, editable feature), sends the results
   back, and repeats until the model is done. The whole request is one undo step.
4. **The request formats** are in one place (`src/ai/byok/providers.ts`): a `switch` builds the
   Anthropic Messages body, the OpenAI Chat Completions body, or the Gemini generateContent body,
   and reads each provider's answer.
5. **The proxy** (`proxy/core.mjs`, served at `/api/proxy`) forwards the request to that provider
   with the key in the header the provider expects. Browsers cannot call these APIs directly
   from a website, which is why the proxy exists.

No API key, secret or default token is anywhere in the code (`tests/byok.test.ts` scans for them).

The old way still works too: when CHAD runs on your own computer (`npm run dev` or the Windows
starter), AI Settings also offers **Claude Code on this computer (no key)**, which uses your
Claude subscription through the local bridge exactly as before. If nothing was chosen, a local
CHAD keeps using Claude Code; the published website asks for a key.

## The same guards as before

Each request stops at 60 AI replies, 150 CAD tool calls, 6 renders, or the same step failing 3
times in a row (`BYOK_LIMITS`, kept equal to `bridge/hub.mjs` by a test). Whatever was built
stays and is one undo step. The Stop button ends the request.

Each message to `/api/proxy` is kept under 4 MB (`MAX_REQUEST_BYTES`), because Vercel Functions
refuse anything over 4.5 MB. Renders are the large part, so in a long chat the oldest renders are
replaced by a short note ("an earlier render was removed") and the newest are kept. If a chat is
still too large, it stops with a message asking for **New chat**; nothing built is lost.

## Providers: formats, defaults and differences

Checked against each provider's official documentation on 2026-11-10.

| | Anthropic | OpenAI | Google Gemini |
|---|---|---|---|
| Endpoint | `POST https://api.anthropic.com/v1/messages` | `POST https://api.openai.com/v1/chat/completions` | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| Key header (added by the proxy) | `x-api-key`, plus `anthropic-version: 2026-10-21` | `Authorization: Bearer <key>` | `x-goog-api-key` |
| Default model | `claude-opus-5-5` | `gpt-6-sol` | `gemini-3.8-flash` |
| Tools | `tools[].input_schema` (CHAD's JSON Schema as is) | `tools[].function.parameters` (references inlined) | `functionDeclarations[].parametersJsonSchema` (references inlined, documented keywords only) |
| Renders (view_model images) | inside the tool result | a user message after the tool messages (tool messages are text only) | image parts after the function responses |

Things to know:

- **Anthropic**: thinking blocks are sent back exactly as received (required during tool use).
  Effort is set to `high` for CAD precision. Prompt caching is on, so each tool round trip
  re-reads the conversation cheaply. For current models the server-side refusal fallback is on
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): a rare safety decline is
  retried on another Claude model inside the same request.
- **OpenAI**: OpenAI's docs say their newest models (GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Astra)
  need the newer *Responses API* for tool calling; in Chat Completions, tool calling works on
  GPT-6 Sol and GPT-6 Luna with `reasoning_effort: "none"` (no extra reasoning). CHAD uses
  Chat Completions as requested, so the default is `gpt-6-sol` with reasoning off. Expect
  weaker results on complex parts than with Claude. Moving OpenAI to the Responses API is a
  possible follow-up.
- **Gemini**: thought signatures are sent back exactly as received (Gemini 3 and later reject the
  request otherwise). Google now recommends its newer Interactions API for new projects, but
  says generateContent "remains fully supported". Gemini 4 Argon may need the Interactions API;
  CHAD's default is the stable `gemini-3.8-flash`.
- **No web research in BYOK chats.** Claude Code could search the web before modelling a subject
  that is not in CHAD's reference library; the BYOK chat cannot, so the instructions tell the
  model to use what it knows and say when it is unsure. The reference library itself works.
- **Cost**: renders and long conversations cost the user the most. A new chat (New chat button)
  starts a fresh, cheaper conversation. Changing provider or model also starts a new conversation.

What was verified, and what was not:

- Unit tests (`tests/byok.test.ts`, `tests/byok-client.test.ts`, `tests/proxy.test.ts`) check every
  request and answer format against the shapes in the docs, and build a real 4 x 2 x 0.5 in plate
  through each provider's format with the real geometry kernel.
- A browser test (`e2e/byok.spec.ts`) saves a key in AI Settings and builds a plate through a
  faked `/api/proxy` in real Chromium.
- Live: the proxy reached Anthropic and Gemini with a fake key. Anthropic answered "invalid
  x-api-key" (so the headers and route are right). Gemini accepted the full CHAD request body
  (all 35 tools) and only then refused the fake key, so its format is right. OpenAI was not
  reachable from the build machine.
- Not tested with real keys (no real AI was called, nobody's credit was spent): a full multi-step
  build on each provider. Try one simple part on your provider first.

## Security

- **localStorage is readable by any script on the page.** If a script from another website ever
  ran inside CHAD, it could read the key. CHAD therefore loads no third-party scripts (no
  analytics, ads, chat widgets or tag managers). Keep it that way: adding any outside script to
  `index.html` would put every user's key at risk.
- The key is sent only to your own `/api/proxy`, in the `X-Chad-Api-Key` header (never in the
  body or the URL), and the proxy sends it only to the provider the user chose.
- The proxy contacts only `api.anthropic.com`, `api.openai.com` and
  `generativelanguage.googleapis.com`, over HTTPS, and never follows redirects. The browser
  names a provider, never a web address.
- The proxy never logs, stores or caches keys (it has no logging at all; a test checks that),
  forwards no cookies or other browser headers, and passes back only the provider's answer.
- The proxy answers only requests from its own website. To also allow another website address
  of yours (for example the same app on a second domain), set `ALLOWED_ORIGINS` to a
  comma-separated list such as `https://chad.example.com,https://www.chad.example.com`.
- Users should not save a key on a shared computer, and can remove it any time (AI Settings,
  Remove saved key). Providers let users set spending limits on their keys, which is worth
  recommending.

## Deploy the proxy

The proxy is already in the repository for two hosts. Pick one. Both serve the CHAD app and
`/api/proxy` from the same website, so nothing else needs configuring, and no keys or secrets
are entered anywhere: each user brings their own.

The security headers the site needs (for the OpenCascade WebAssembly) are already set in
`vercel.json` and `public/_headers`; what they do and how they are tested: [DEPLOY.md](DEPLOY.md).
After deploying, open Options, **About CHAD and licences**: it should say "Cross-origin isolation: on".

### Option A: Vercel (recommended, settings already in `vercel.json`)

1. Go to vercel.com and sign up with your GitHub account.
2. Click **Add New...**, then **Project**.
3. Find the **chat-cad-v1** repository (or your fork) in the list and click **Import**. If it is not
   listed, click the link to adjust GitHub permissions and give Vercel access to it.
4. Leave everything as it is (Vercel reads the build settings from `vercel.json`: build command
   `npm run build`, output folder `dist`). Do not add any environment variables.
5. Click **Deploy** and wait for it to finish (a few minutes).
6. Click the new website address. Open the AI chat's gear (⚙), choose a provider, paste your
   own key, Save, and ask for a simple part such as "a 2 x 1 x 0.25 in plate".
7. From now on every merge into `main` updates the website by itself.

**Free (Hobby) plan.** Everything above works on Vercel's free Hobby plan, with no card: no paid
feature is used (one function, no environment variables, no add-ons, no password protection).
What the free plan allows each month, from Vercel's docs (vercel.com/docs/plans/hobby and
vercel.com/docs/functions/limitations, checked 2026-11-10):

- 100 GB of data sent to visitors. A first visit downloads up to about 25 MB (mostly the OpenCascade
  WebAssembly, then cached by the browser for a year), so roughly 4,000 first visits a month.
- 1,000,000 function calls, 4 hours of active CPU and 360 GB-hours of memory for `/api/proxy`.
  Waiting for the AI does not count as CPU. Memory is counted while a call waits (2 GB x the wait),
  so about 180 hours of AI waiting a month, several thousand chat replies.
- Each proxy call may run up to 300 seconds (the Hobby maximum, set in `vercel.json`), and each
  request may be at most 4.5 MB (see the guards above).
- Going over a limit never costs money on Hobby: the feature pauses until 30 days have passed.
- Hobby is for personal, non-commercial use only. Selling CHAD or charging for it from this site
  would need Vercel's paid Pro plan (or another host).

### Option B: Cloudflare Pages

1. Go to dash.cloudflare.com and sign up or log in.
2. Open **Workers & Pages**, click **Create**, choose **Pages**, then **Connect to Git**, and pick
   the **chat-cad-v1** repository or your fork (allow Cloudflare to see it if asked).
3. Build settings: build command `npm run build`, build output directory `dist`.
4. Under **Environment variables**, add `NODE_VERSION` with the value `24`.
5. Click **Save and Deploy**. Cloudflare finds the `functions/api/proxy.js` file and serves the
   proxy at `/api/proxy` by itself.
6. Test as in step 6 of Option A.

If Cloudflare's screens look different (they change the dashboard often), follow Cloudflare's
own Pages "Git integration" guide with the build settings above.

### Optional: allow another website address

Only if the app is opened from a different address than the one serving `/api/proxy`: in the
host's project settings, add an environment variable `ALLOWED_ORIGINS` with the full address
(for example `https://chad.example.com`), then redeploy.

## Files

- `src/ai/byok/settings.ts`: saved provider, key and model (localStorage), defaults.
- `src/ai/byok/providers.ts`: the per-provider request and answer formats (the `switch`).
- `src/ai/byok/schema.ts`: tool schemas for OpenAI and Gemini.
- `src/ai/byok/agent.ts`: the chat loop, guards, and plain-words errors.
- `src/ai/bridgeClient.ts`: the chat client (BYOK or Claude Code).
- `src/ui/AiSettingsModal.tsx`, `src/ui/ChatDock.tsx`: AI Settings and the chat panel.
- `proxy/core.mjs`: the proxy. `api/proxy.js` (Vercel), `functions/api/proxy.js` (Cloudflare
  Pages) and `vite.config.ts` (local dev server) all use it.
- Tests: `tests/byok.test.ts`, `tests/byok-client.test.ts`, `tests/proxy.test.ts`, `e2e/byok.spec.ts`.
