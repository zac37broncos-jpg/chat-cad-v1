/**
 * About CHAD: the app's own licence (MIT) and the legal attribution for the open-source software
 * it is built on. Opened from Options > About CHAD.
 *
 * The Open CASCADE Technology (OCCT) notice is required by the GNU LGPL 2.1 (section 6: a prominent
 * notice that the library is used and where its licence is). The full licence texts of every
 * package are in /THIRD_PARTY_NOTICES.txt (made by scripts/third-party-notices.mjs).
 * tests/legal.test.ts checks that every package the app ships is named here.
 */
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { APP_NAME } from '../brand';
import { version } from '../../package.json';
import mitLicense from '../../LICENSE?raw';

export interface Attribution {
  /** npm package that ships inside the app. */
  pkg: string;
  /** What it does in CHAD, in plain words. */
  role: string;
  /** SPDX licence expression. */
  license: string;
  /** Where the source code is. */
  source: string;
}

/** Every package CHAD ships to the browser (package.json "dependencies"), with its licence. */
export const ATTRIBUTIONS: readonly Attribution[] = [
  { pkg: 'replicad-opencascadejs', role: 'Open CASCADE Technology compiled to WebAssembly (the 3D engine)', license: 'LGPL-2.1-only', source: 'https://github.com/sgenoud/replicad' },
  { pkg: '@salusoft89/planegcs', role: 'Sketch constraint solver (planegcs from FreeCAD, with Eigen and Boost)', license: 'LGPL-2.0-or-later', source: 'https://github.com/Salusoft89/planegcs' },
  { pkg: 'three', role: '3D view (three.js)', license: 'MIT', source: 'https://github.com/mrdoob/three.js' },
  { pkg: 'react', role: 'User interface', license: 'MIT', source: 'https://github.com/facebook/react' },
  { pkg: 'react-dom', role: 'User interface', license: 'MIT', source: 'https://github.com/facebook/react' },
];

const OCCT_SOURCE = 'https://github.com/Open-Cascade-SAS/OCCT';
const LGPL_21 = 'https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html';

/** True when the site sends the COOP and COEP headers (vite.config.ts, vercel.json, public/_headers). */
function isCrossOriginIsolated(): boolean {
  return typeof globalThis.crossOriginIsolated === 'boolean' && globalThis.crossOriginIsolated;
}

export function AboutModal({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); before?.focus(); };
  }, [onClose]);

  const isolated = isCrossOriginIsolated();

  // A portal keeps the window centred on the screen whatever panel opened it.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="about-modal">
        <div className="modal-head">
          <b id={titleId}>About {APP_NAME}</b>
          <button ref={closeRef} className="modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          <p>{APP_NAME} {version}: parametric CAD with an AI chat, for 3D printing.</p>

          <section className="about-block" aria-label="3D engine" data-testid="about-occt">
            <b>3D engine: Open CASCADE Technology</b>
            <p>
              {APP_NAME}'s exact 3D geometry is computed by Open CASCADE Technology (OCCT), Copyright © Open CASCADE SAS,
              used under the GNU Lesser General Public License version 2.1 (LGPL-2.1) with the Open CASCADE Exception 1.0.
              This product uses Open CASCADE Technology software.
            </p>
            <p className="modal-help">
              OCCT runs as a separate WebAssembly file (replicad_single.wasm, built by replicad-opencascadejs) that is loaded
              at run time and can be replaced with a modified build of the library.
              OCCT source: <a href={OCCT_SOURCE} target="_blank" rel="noreferrer">{OCCT_SOURCE}</a>.
              Licence text: <a href={LGPL_21} target="_blank" rel="noreferrer">GNU LGPL 2.1</a>.
            </p>
          </section>

          <section className="about-block" aria-label="Open-source software">
            <b>Open-source software in {APP_NAME}</b>
            <ul className="about-list">
              {ATTRIBUTIONS.map((a) => (
                <li key={a.pkg}>
                  <a href={a.source} target="_blank" rel="noreferrer">{a.pkg}</a> ({a.license}): {a.role}
                </li>
              ))}
            </ul>
            <p className="modal-help">
              Every licence and copyright notice in full, including the packages these use:{' '}
              <a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">third-party notices</a>.
            </p>
          </section>

          <section className="about-block" aria-label="AI chat">
            <b>AI chat</b>
            <p className="modal-help">
              The chat uses the AI provider you choose in AI Settings: Anthropic, OpenAI or Google Gemini with your own API key,
              or Claude Code with your own Claude account when {APP_NAME} runs on your computer.
              {' '}{APP_NAME} is not made by, endorsed by or affiliated with any of these companies; their names are trademarks of their owners.
            </p>
          </section>

          <details className="about-block">
            <summary><b>{APP_NAME} licence (MIT)</b></summary>
            <pre className="about-license" data-testid="about-mit">{mitLicense}</pre>
          </details>

          <p className="modal-help" data-testid="about-isolation">
            Cross-origin isolation: {isolated ? 'on (the site sends the right security headers)' : 'off (see docs/DEPLOY.md)'}.
          </p>
          <div className="modal-actions">
            <span className="modal-spacer" />
            <button type="button" className="primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
