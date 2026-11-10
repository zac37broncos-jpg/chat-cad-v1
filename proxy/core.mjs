/**
 * CHAD AI proxy: forwards one bring-your-own-key chat request from the CHAD page to the AI
 * provider the user chose, with the user's own key in the header that provider expects.
 * The browser cannot call the providers directly (their APIs block cross-site browser calls
 * without special headers), so it calls this site's own /api/proxy instead.
 *
 * Used by: functions/api/proxy.js (Cloudflare Pages), api/proxy.js (Vercel) and the local dev
 * server (vite.config.ts). Web-standard Request/Response only, so it runs on all three.
 *
 * Security:
 *  - Fixed upstreams: the browser names a provider, never a URL. Only these three hosts are
 *    ever contacted (checked again just before the call), over HTTPS, without following redirects.
 *  - The key comes from the X-Chad-Api-Key header of each request. It is never logged, stored,
 *    cached or sent anywhere except to that provider. This file has no console calls at all
 *    (tests/proxy.test.ts checks that).
 *  - Browser requests must come from this site's own origin, or an origin listed in the
 *    ALLOWED_ORIGINS setting (comma separated). Everything else is refused, and CORS headers
 *    are only ever sent for an allowed origin.
 *  - Only the headers each provider needs are sent upstream (no cookies, no client IP headers).
 */

export const KEY_HEADER = 'x-chad-api-key';
export const ANTHROPIC_VERSION = '2026-10-21';
/** Big enough for a few 1024 px renders in one request; anything larger is a mistake or abuse. */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export const ALLOWED_HOSTS = Object.freeze(['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com']);

const PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' };
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const KEY_RE = /^[\x21-\x7e]{1,512}$/;
const BETA_RE = /^[a-z0-9-]{1,80}(,[a-z0-9-]{1,80}){0,7}$/;

/** The upstream URL and headers for one provider. Exported for tests. */
export function upstreamFor(provider, model, apiKey, extraHeaders = {}) {
  switch (provider) {
    case 'anthropic': {
      const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
      const beta = extraHeaders['anthropic-beta'];
      if (typeof beta === 'string' && BETA_RE.test(beta)) headers['anthropic-beta'] = beta;
      return { url: 'https://api.anthropic.com/v1/messages', headers };
    }
    case 'openai':
      return { url: 'https://api.openai.com/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` } };
    case 'gemini':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      };
    default:
      return null;
  }
}

function allowedOrigins(env) {
  const raw = env && typeof env.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** The request's Origin if this proxy serves it, else null. */
export function checkOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  let own = null;
  try { own = new URL(request.url).origin; } catch { /* no usable URL */ }
  if (origin === own || allowedOrigins(env).includes(origin)) return origin;
  return null;
}

function corsHeaders(origin, request) {
  let own = null;
  try { own = new URL(request.url).origin; } catch { /* no usable URL */ }
  // Same-origin requests need no CORS headers; a listed other origin gets exactly its own origin back.
  if (!origin || origin === own) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
});
const refuse = (status, message, extra) => json(status, { proxyError: message }, extra);

/**
 * Handle one request to /api/proxy.
 * @param {Request} request
 * @param {{ ALLOWED_ORIGINS?: string }} [env]
 * @param {typeof fetch} [fetchFn]
 */
export async function handleProxy(request, env = {}, fetchFn = fetch) {
  const origin = checkOrigin(request, env);
  if (request.method === 'OPTIONS') {
    if (!origin) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin, request),
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type, x-chad-api-key',
        'access-control-max-age': '600',
      },
    });
  }
  if (!origin) return refuse(403, 'This AI proxy only answers requests from the CHAD website it belongs to.');
  const cors = corsHeaders(origin, request);
  if (request.method !== 'POST') return refuse(405, 'Use POST.', { ...cors, allow: 'POST, OPTIONS' });
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return refuse(415, 'Send JSON.', cors);

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return refuse(413, 'This request is too large to send to the AI.', cors);
  let text;
  try { text = await request.text(); } catch { return refuse(400, 'Could not read the request.', cors); }
  if (text.length > MAX_BODY_BYTES) return refuse(413, 'This request is too large to send to the AI.', cors);
  let msg;
  try { msg = JSON.parse(text); } catch { return refuse(400, 'The request is not valid JSON.', cors); }
  if (!msg || typeof msg !== 'object') return refuse(400, 'The request is not valid.', cors);

  const { provider, model, headers: extra, body } = msg;
  if (!Object.hasOwn(PROVIDER_NAMES, provider)) return refuse(400, 'Unknown AI provider. Choose Anthropic, OpenAI or Google Gemini in AI Settings.', cors);
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return refuse(400, 'That model name is not valid. Check it in AI Settings.', cors);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'The request has no AI message.', cors);
  const apiKey = request.headers.get(KEY_HEADER) ?? '';
  if (!apiKey) return refuse(401, 'No API key was sent. Add your key in AI Settings (the gear in the chat).', cors);
  if (!KEY_RE.test(apiKey)) return refuse(400, 'The API key has spaces or unusual characters. Paste just the key in AI Settings.', cors);

  const up = upstreamFor(provider, model, apiKey, extra && typeof extra === 'object' ? extra : {});
  if (!up) return refuse(400, 'Unknown AI provider.', cors);
  const target = new URL(up.url);
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.includes(target.hostname)) return refuse(500, 'Proxy configuration error.', cors);

  let res;
  try {
    res = await fetchFn(target.toString(), { method: 'POST', headers: up.headers, body: JSON.stringify(body), redirect: 'manual', signal: request.signal });
  } catch {
    return refuse(502, `Could not reach ${PROVIDER_NAMES[provider]}. Try again in a moment.`, cors);
  }
  if (res.status >= 300 && res.status < 400) return refuse(502, `${PROVIDER_NAMES[provider]} answered with an unexpected redirect.`, cors);
  // Pass the provider's answer (or its error message) through as it is, with no provider headers.
  const out = await res.text();
  return new Response(out, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors },
  });
}
