/**
 * Bring-your-own-key AI settings: which AI provider the chat uses, the user's own API key and
 * (optionally) the model. Stored only in this browser's localStorage, never in the code, never
 * sent anywhere except with the user's own chat requests (through the app's /api/proxy).
 *
 * Security note (docs/BYOK_AI.md): anything in localStorage can be read by any script running
 * on the page, so CHAD loads no third-party scripts.
 */
import { useSyncExternalStore } from 'react';

/** The three bring-your-own-key providers. */
export type ByokProvider = 'anthropic' | 'openai' | 'gemini';
/** What the chat runs on: a BYOK provider, or Claude Code on this computer (local dev server only). */
export type AiProvider = ByokProvider | 'claude-code';

export const BYOK_PROVIDERS: readonly ByokProvider[] = ['anthropic', 'openai', 'gemini'];

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  'claude-code': 'Claude Code on this computer (no key)',
};

/**
 * Default model per provider, used when the user leaves the model field empty. Checked against
 * each provider's official docs on 2026-11-10 (docs/BYOK_AI.md lists the sources):
 *  - Anthropic: claude-opus-5-5, the current Opus.
 *  - OpenAI: gpt-6-sol. OpenAI's docs say the newer GPT-6.1 / Astra models need the Responses API
 *    for tool calling; in Chat Completions, tool calling works on GPT-6 Sol and Luna with
 *    reasoning_effort "none".
 *  - Gemini: gemini-3.8-flash, the stable model the Gemini function-calling docs use.
 */
export const DEFAULT_MODELS: Record<ByokProvider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-6-sol',
  gemini: 'gemini-3.8-flash',
};

export const STORAGE_KEYS = Object.freeze({
  provider: 'chad.ai.provider',
  apiKey: 'chad.ai.apiKey',
  model: 'chad.ai.model',
});

export interface AiSettings {
  /** null: never chosen (the chat then uses Claude Code when the local bridge is there). */
  provider: AiProvider | null;
  apiKey: string;
  /** Empty: the provider's default model. */
  model: string;
}

const isProvider = (v: unknown): v is AiProvider => v === 'anthropic' || v === 'openai' || v === 'gemini' || v === 'claude-code';
export const isByok = (p: AiProvider | null | undefined): p is ByokProvider => p === 'anthropic' || p === 'openai' || p === 'gemini';

/** localStorage, or null where it is blocked (private windows, some embedded views). */
function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function get(key: string): string {
  try { return storage()?.getItem(key) ?? ''; } catch { return ''; }
}
function put(key: string, value: string) {
  const s = storage();
  if (!s) throw new Error('This browser blocks saving settings (localStorage). The key cannot be remembered here.');
  if (value) s.setItem(key, value); else s.removeItem(key);
}

/** A key is one line of printable characters (no spaces): anything else is a paste mistake. */
export function keyProblem(key: string): string | null {
  if (!key) return null;
  if (key.length > 512) return 'That key is too long. Copy just the key itself.';
  if (/[^\x21-\x7e]/.test(key)) return 'The key has spaces or unusual characters. Copy just the key itself, with nothing before or after it.';
  return null;
}

/** Model ids are short names like claude-opus-5-5, gpt-6-sol or gemini-3.8-flash. */
export function modelProblem(model: string): string | null {
  if (!model) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model) ? null : 'A model name uses only letters, digits, dots, dashes and underscores (for example gemini-3.8-flash).';
}

let cache: AiSettings | null = null;
const listeners = new Set<() => void>();

export function readAiSettings(): AiSettings {
  if (cache) return cache;
  const p = get(STORAGE_KEYS.provider);
  cache = { provider: isProvider(p) ? p : null, apiKey: get(STORAGE_KEYS.apiKey).trim(), model: get(STORAGE_KEYS.model).trim() };
  return cache;
}

/** Save (and tell every open settings view). Throws a plain-words error if it cannot be saved. */
export function saveAiSettings(next: AiSettings) {
  const apiKey = next.apiKey.trim();
  const model = next.model.trim();
  const bad = keyProblem(apiKey) ?? modelProblem(model);
  if (bad) throw new Error(bad);
  put(STORAGE_KEYS.provider, next.provider ?? '');
  put(STORAGE_KEYS.apiKey, apiKey);
  put(STORAGE_KEYS.model, model);
  cache = null;
  for (const l of listeners) l();
}

/** Forget the saved key (the provider choice stays). */
export function clearApiKey() {
  try { storage()?.removeItem(STORAGE_KEYS.apiKey); } catch { /* blocked storage: nothing saved */ }
  cache = null;
  for (const l of listeners) l();
}

export function subscribeAiSettings(fn: () => void): () => void {
  listeners.add(fn);
  // Another tab changed the settings.
  const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith('chad.ai.')) { cache = null; fn(); } };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => { listeners.delete(fn); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
}

/** React hook: the saved AI settings, kept in sync with saves in this tab and in other tabs. */
export function useAiSettings(): AiSettings {
  return useSyncExternalStore(subscribeAiSettings, readAiSettings, readAiSettings);
}

/** The model a request will use. */
export function effectiveModel(provider: ByokProvider, model: string): string {
  return model.trim() || DEFAULT_MODELS[provider];
}

/** For tests: forget the cached copy. */
export function _resetAiSettingsCache() { cache = null; }
