import { useEffect, useRef, useState } from 'react';
import type { BridgeClient, BridgeState } from '../ai/bridgeClient';
import { MiniMarkdown } from './miniMarkdown';
import { APP_NAME } from '../brand';
import { AiSettingsModal } from './AiSettingsModal';
import { PROVIDER_LABELS, effectiveModel, isByok, useAiSettings } from '../ai/byok/settings';

const EXAMPLES = [
  'Make a 4 x 2 x 0.5 in plate with two 1/4" through holes, 0.5 in from each end, centered across the width',
  'Make the plate 0.75 thick',
  'Add a 1 in diameter boss, 0.25 tall, centered on top',
];

export function ChatDock({ bridge }: { bridge: BridgeClient }) {
  const [s, setS] = useState<BridgeState>(bridge.state);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const ai = useAiSettings();
  useEffect(() => bridge.subscribe(setS), [bridge]);
  useEffect(() => { bridge.onOpenSettings = () => setSettingsOpen(true); return () => { bridge.onOpenSettings = null; }; }, [bridge]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [s.items.length, s.items]);

  const byok = isByok(s.provider);
  const signedOut = !!s.claude?.found && s.claude.loggedIn === false;
  const claudeReady = s.connected && !!s.claude?.found && !signedOut;
  // A bring-your-own-key chat without a key can still be typed in: Send then explains and opens AI Settings.
  const ready = byok || claudeReady;
  const keyReady = byok && !s.needsKey;
  const submit = () => { if (!ready || s.running || !text.trim()) return; bridge.send(text); if (!byok || keyReady) setText(''); };
  const poweredBy = byok ? `${PROVIDER_LABELS[s.provider]} · ${effectiveModel(s.provider as Exclude<typeof s.provider, 'claude-code'>, ai.model)}` : 'Claude Code';
  const dotOn = byok ? keyReady : claudeReady;
  const dotTitle = byok ? (keyReady ? 'Ready (your own key)' : 'Add your API key in AI Settings')
    : claudeReady ? 'Ready' : !s.connected ? 'Not connected to the dev server' : signedOut ? 'Sign in to Claude needed' : 'Claude Code not found';

  return (
    <div className={`chat ${open ? 'open' : ''}`}>
      <div className="chat-head" onClick={() => setOpen(!open)}>
        <span>✦ AI Chat <span className="muted">({poweredBy})</span> <span className={`dot ${dotOn ? 'on' : byok || s.connected ? 'warn' : 'off'}`} title={dotTitle} /></span>
        <span className="chat-head-tools">
          <button className="chat-gear" title="AI Settings: provider and your API key" aria-label="AI Settings" onClick={(e) => { e.stopPropagation(); setSettingsOpen(true); }}>⚙</button>
          <span className="muted">{open ? '▾' : '▸'}</span>
        </span>
      </div>
      {settingsOpen && <AiSettingsModal onClose={() => setSettingsOpen(false)} current={s.provider} localBridge={s.connected || s.provider === 'claude-code'} />}
      {open && (
        <div className="chat-body">
          {byok && s.needsKey && (
            <div className="setup">
              <b>Use your own AI key</b>
              <p>The chat runs on your own Anthropic, OpenAI or Google Gemini account, so you pay your provider directly for what you use. Your key is saved only in this browser.</p>
              <button className="primary" onClick={() => setSettingsOpen(true)}>Open AI Settings</button>
            </div>
          )}
          {!byok && !s.connected && <p className="hint">Connecting to the local bridge… (it runs with <code>npm run dev</code>). Or open AI Settings (⚙) to use your own API key.</p>}
          {!byok && s.connected && s.claude && !s.claude.found && (
            <div className="setup">
              <b>One-time setup (about 2 minutes)</b>
              <p>The chat runs on Claude Code with your Claude Pro or Max subscription, so there is no per-use cost. Close {APP_NAME}'s black window, then double-click <b>Start {APP_NAME} (Windows).bat</b> again: it installs Claude Code for you. Or, in a Windows command window (cmd), run:</p>
              <code className="block">curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd</code>
              <p>On Mac/Linux use <code>curl -fsSL https://claude.ai/install.sh | bash</code>. Then press Re-check.</p>
              <button onClick={() => bridge.recheck()}>Re-check</button>
            </div>
          )}
          {!byok && s.connected && signedOut && (
            <div className="setup">
              <b>Sign in to Claude (one time)</b>
              {!s.signingIn ? (
                <>
                  <p>The chat uses your Claude Pro or Max account. Press the button: a small window opens and your browser asks you to sign in.</p>
                  <button className="primary" onClick={() => bridge.login()}>Sign in to Claude</button>
                </>
              ) : (
                <>
                  <p>Finish signing in in your browser and approve access. If the page shows a code, copy it into the small black window and press Enter. This panel turns ready by itself when you're signed in.</p>
                  <div className="actions"><button onClick={() => bridge.recheck()}>I've signed in</button><button onClick={() => bridge.login()}>Open sign-in again</button></div>
                </>
              )}
            </div>
          )}
          <div className="chat-list" ref={listRef}>
            {s.items.length === 0 && ready && (
              <div className="examples">
                <p className="hint">Describe a part or a change. Each step appears in the feature tree as it happens, and the whole request undoes with one Ctrl+Z.</p>
                {EXAMPLES.map((e) => <button key={e} className="example" onClick={() => setText(e)}>{e}</button>)}
              </div>
            )}
            {s.items.map((it, k) => {
              if (it.kind === 'user') return <div key={k} className="msg user">{it.text}</div>;
              if (it.kind === 'assistant') return <div key={k} className="msg assistant"><MiniMarkdown text={it.text} /></div>;
              if (it.kind === 'step') return (
                <div key={k} className={`step ${it.state}`} title={it.detail ?? ''}>
                  <span className="step-icon">{it.state === 'running' ? '◌' : it.state === 'ok' ? '✓' : '✕'}</span>
                  {it.label}{it.detail && it.state === 'error' ? <span className="step-detail"> · {it.detail}</span> : null}
                </div>
              );
              if (it.kind === 'error') return <div key={k} className="msg error">{it.text}</div>;
              return <div key={k} className="msg info">{it.text}</div>;
            })}
            {s.running && <div className="step running"><span className="step-icon spin">◌</span>{byok ? 'The AI is working…' : 'Claude is working…'}</div>}
          </div>
          <div className="chat-input">
            <textarea
              value={text} rows={2} disabled={!ready}
              placeholder={byok ? 'Ask the AI to build or change the part…' : ready ? 'Ask Claude to build or change the part…' : signedOut ? 'Sign in to Claude above to use the chat' : 'Chat unavailable until setup is done'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            />
            <div className="chat-actions">
              {s.running
                ? <button onClick={() => bridge.stop()}>■ Stop</button>
                : <button className="primary" disabled={!ready || !text.trim()} onClick={submit}>Send</button>}
              <button disabled={s.running || s.items.length === 0} onClick={() => bridge.newChat()} title="Start a new conversation">New chat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
