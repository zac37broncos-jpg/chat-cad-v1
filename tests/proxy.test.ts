/**
 * The AI proxy (proxy/core.mjs) that the published CHAD site serves at /api/proxy.
 * Upstream providers are faked: nothing here calls a real AI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain JS module
import { handleProxy, upstreamFor, ALLOWED_HOSTS, ANTHROPIC_VERSION, MAX_BODY_BYTES } from '../proxy/core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://chad.example';

function req(opts: { origin?: string | null; method?: string; key?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers.origin = opts.origin ?? SITE;
  if (opts.key !== null) headers['x-chad-api-key'] = opts.key ?? 'user-key-1';
  const method = opts.method ?? 'POST';
  const body = method === 'GET' || method === 'OPTIONS' ? undefined : opts.raw ?? JSON.stringify(opts.body ?? { provider: 'anthropic', model: 'claude-opus-5-5', body: { messages: [] } });
  return new Request(`${SITE}/api/proxy`, { method, headers, body });
}

function upstream(status = 200, body: unknown = { ok: 1 }, headers: Record<string, string> = { 'content-type': 'application/json', 'set-cookie': 'x=1', 'anthropic-ratelimit-requests-remaining': '9' }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers }); };
  return { calls, fetchFn };
}

describe('AI proxy routing', () => {
  it('Anthropic: v1/messages with x-api-key and anthropic-version, beta header only when well formed', async () => {
    const u = upstream();
    const res = await handleProxy(req({ body: { provider: 'anthropic', model: 'claude-opus-5-5', headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' }, body: { model: 'claude-opus-5-5', messages: [] } } }), {}, u.fetchFn);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(u.calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(u.calls[0].init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'user-key-1', 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': 'server-side-fallback-2026-07-01' });
    expect(JSON.parse(String(u.calls[0].init.body))).toEqual({ model: 'claude-opus-5-5', messages: [] });
    expect(u.calls[0].init.redirect).toBe('manual');
    expect(upstreamFor('anthropic', 'm', 'k', { 'anthropic-beta': 'x\r\ninjected: 1' }).headers).not.toHaveProperty('anthropic-beta');
  });

  it('OpenAI: v1/chat/completions with Authorization Bearer', async () => {
    const u = upstream();
    await handleProxy(req({ body: { provider: 'openai', model: 'gpt-6-sol', body: { model: 'gpt-6-sol', messages: [] } } }), {}, u.fetchFn);
    expect(u.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(u.calls[0].init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer user-key-1' });
  });

  it('Gemini: models/{model}:generateContent with x-goog-api-key (never the key in the URL)', async () => {
    const u = upstream();
    await handleProxy(req({ body: { provider: 'gemini', model: 'gemini-3.8-flash', body: { contents: [] } } }), {}, u.fetchFn);
    expect(u.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(u.calls[0].url).not.toContain('key=');
    expect(u.calls[0].init.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': 'user-key-1' });
  });

  it('only ever contacts the three provider hosts over https', () => {
    for (const p of ['anthropic', 'openai', 'gemini']) {
      const u = new URL(upstreamFor(p, 'gemini-3.8-flash', 'k').url);
      expect(u.protocol).toBe('https:');
      expect(ALLOWED_HOSTS).toContain(u.hostname);
    }
    expect(upstreamFor('evil', 'm', 'k')).toBeNull();
  });

  it('passes the provider answer and status through, without the provider\'s own headers', async () => {
    const u = upstream(401, { error: { message: 'invalid x-api-key' } });
    const res = await handleProxy(req(), {}, u.fetchFn);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: 'invalid x-api-key' } });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('anthropic-ratelimit-requests-remaining')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sends nothing upstream but the body and the provider headers (no cookies, no client headers)', async () => {
    const u = upstream();
    await handleProxy(req({ headers: { cookie: 'session=abc', 'x-forwarded-for': '1.2.3.4', 'user-agent': 'test' } }), {}, u.fetchFn);
    const sent = JSON.stringify(u.calls[0].init.headers);
    expect(sent).not.toMatch(/cookie|session|forwarded|1\.2\.3\.4|user-agent/i);
  });
});

describe('AI proxy refuses what it should', () => {
  const noUpstream = async () => { throw new Error('must not be called'); };
  const refused = async (r: Request, status: number, env = {}) => {
    const res = await handleProxy(r, env, noUpstream);
    expect(res.status).toBe(status);
    return res;
  };

  it('other websites and requests without an Origin', async () => {
    await refused(req({ origin: 'https://evil.example' }), 403);
    await refused(req({ origin: null }), 403);
    const pre = await handleProxy(req({ method: 'OPTIONS', origin: 'https://evil.example' }), {}, noUpstream);
    expect(pre.status).toBe(403);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('CORS only for an origin listed in ALLOWED_ORIGINS, echoing exactly that origin', async () => {
    const env = { ALLOWED_ORIGINS: 'https://app.chad.example, https://www.chad.example/' };
    const pre = await handleProxy(req({ method: 'OPTIONS', origin: 'https://www.chad.example' }), env, noUpstream);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://www.chad.example');
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-chad-api-key');
    const u = upstream();
    const res = await handleProxy(req({ origin: 'https://app.chad.example' }), env, u.fetchFn);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.chad.example');
    // Same-origin answers carry no CORS header at all.
    const same = await handleProxy(req(), env, upstream().fetchFn);
    expect(same.headers.get('access-control-allow-origin')).toBeNull();
    expect(same.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('missing or malformed key, unknown provider, bad model, wrong method or content type, bad JSON, too large', async () => {
    await refused(req({ key: null }), 401);
    await refused(req({ key: 'has space' }), 400);
    await refused(req({ body: { provider: 'evil', model: 'm', body: {} } }), 400);
    await refused(req({ body: { provider: '__proto__', model: 'm', body: {} } }), 400);
    await refused(req({ body: { provider: 'gemini', model: '../../v1/files', body: {} } }), 400);
    await refused(req({ body: { provider: 'gemini', model: 'gemini-3.8-flash:streamGenerateContent?alt=sse', body: {} } }), 400);
    await refused(req({ body: { provider: 'openai', model: 'gpt-6-sol' } }), 400);
    await refused(req({ method: 'GET' }), 405);
    await refused(req({ headers: { 'content-type': 'text/plain' } }), 415);
    await refused(req({ raw: '{not json' }), 400);
    await refused(req({ raw: JSON.stringify({ provider: 'openai', model: 'gpt-6-sol', body: { x: 'a'.repeat(MAX_BODY_BYTES) } }) }), 413);
  });

  it('a provider that cannot be reached or that redirects', async () => {
    const down = await handleProxy(req(), {}, async () => { throw new TypeError('fetch failed'); });
    expect(down.status).toBe(502);
    expect((await down.json()).proxyError).toMatch(/Could not reach Anthropic/);
    const moved = await handleProxy(req(), {}, async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }));
    expect(moved.status).toBe(502);
  });

  it('the error answers never contain the key', async () => {
    for (const r of [req({ body: { provider: 'evil', model: 'm', body: {} } }), req({ origin: 'https://evil.example' })]) {
      const res = await handleProxy(r, {}, noUpstream);
      expect(await res.text()).not.toContain('user-key-1');
    }
  });
});

describe('AI proxy never logs or stores keys', () => {
  it('has no logging and no storage calls, and the platform files only call the shared core', () => {
    const core = readFileSync(join(root, 'proxy/core.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(core).not.toMatch(/console\.|caches\.|\.put\(|localStorage|KV|writeFile/);
    for (const f of ['functions/api/proxy.js', 'api/proxy.js']) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src, f).toContain('handleProxy');
      expect(src, f).not.toMatch(/console\./);
    }
    const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
    expect(vercel.functions['api/proxy.js'].maxDuration).toBe(300);
  });
});
