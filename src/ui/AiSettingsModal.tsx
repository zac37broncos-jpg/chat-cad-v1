/**
 * AI Settings: pick the AI provider and paste your own API key (bring your own key).
 * The choice and the key are saved in this browser only (localStorage, src/ai/byok/settings.ts).
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  BYOK_PROVIDERS, DEFAULT_MODELS, PROVIDER_LABELS, clearApiKey, isByok, keyProblem, modelProblem,
  saveAiSettings, useAiSettings, type AiProvider,
} from '../ai/byok/settings';

/** Where each provider's keys are made (plain directions, no links that could go stale). */
const KEY_HELP: Record<AiProvider, string> = {
  anthropic: 'Make a key in the Claude Console (platform.claude.com): Settings, API keys.',
  openai: 'Make a key on the OpenAI platform (platform.openai.com): API keys.',
  gemini: 'Make a key in Google AI Studio (aistudio.google.com): Get API key.',
  'claude-code': 'Uses Claude Code and your Claude subscription on this computer. No key needed. Only works when CHAD runs from npm run dev.',
};

export function AiSettingsModal({ onClose, current, localBridge }: { onClose: () => void; current: AiProvider; localBridge: boolean }) {
  const saved = useAiSettings();
  const [provider, setProvider] = useState<AiProvider>(saved.provider ?? current);
  const [apiKey, setApiKey] = useState(saved.apiKey);
  const [model, setModel] = useState(saved.model);
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const ids = { provider: useId(), key: useId(), model: useId(), title: useId() };

  useEffect(() => { selectRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const byok = isByok(provider);
  const problem = byok ? keyProblem(apiKey.trim()) ?? modelProblem(model.trim()) : null;
  const choices: AiProvider[] = localBridge || saved.provider === 'claude-code' || current === 'claude-code' ? [...BYOK_PROVIDERS, 'claude-code'] : [...BYOK_PROVIDERS];

  const onProviderChange = (p: AiProvider) => {
    setProvider(p);
    // A key belongs to one provider: switching clears the field (the saved key stays until you save).
    if (p !== (saved.provider ?? '')) { setApiKey(''); setModel(''); } else { setApiKey(saved.apiKey); setModel(saved.model); }
    setError(null);
  };

  const save = () => {
    if (byok && !apiKey.trim()) { setError('Paste your API key, or press Cancel.'); return; }
    try {
      saveAiSettings({ provider, apiKey: byok ? apiKey : '', model: byok ? model : '' });
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={ids.title}>
        <div className="modal-head">
          <b id={ids.title}>AI Settings</b>
          <button className="modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form className="modal-body" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <p className="hint">Use your own AI account: you pay your provider directly for what the chat uses. Your key is saved only in this browser on this computer.</p>
          <label className="field" htmlFor={ids.provider}>
            <span>AI provider</span>
            <select id={ids.provider} ref={selectRef} value={provider} onChange={(e) => onProviderChange(e.target.value as AiProvider)}>
              {choices.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
            </select>
          </label>
          {byok && (
            <>
              <label className="field" htmlFor={ids.key}>
                <span>API key</span>
                <input
                  id={ids.key} type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setError(null); }}
                  autoComplete="off" spellCheck={false} placeholder="Paste your key here" className={problem && apiKey ? 'bad' : ''}
                />
              </label>
              <label className="field" htmlFor={ids.model}>
                <span>Model (optional)</span>
                <input id={ids.model} value={model} onChange={(e) => { setModel(e.target.value); setError(null); }} spellCheck={false} placeholder={DEFAULT_MODELS[provider]} />
              </label>
            </>
          )}
          <p className="modal-help">{KEY_HELP[provider]}{byok ? ` Leave the model empty to use ${DEFAULT_MODELS[provider]}.` : ''}</p>
          {byok && <p className="modal-help">Keep your key private. Anyone who can use this browser profile can read it, so do not save it on a shared computer.</p>}
          {(error ?? problem) && <p className="modal-error" role="alert">{error ?? problem}</p>}
          <div className="modal-actions">
            {saved.apiKey && <button type="button" onClick={() => { clearApiKey(); setApiKey(''); }} title="Delete the saved key from this browser">Remove saved key</button>}
            <span className="modal-spacer" />
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={!!problem}>Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}
