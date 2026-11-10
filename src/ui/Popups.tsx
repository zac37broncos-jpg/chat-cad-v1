/**
 * Pop-up UI: right-click context menus, the Space orientation menu,
 * the S shortcut bar and the W command search.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StandardView } from '../render/viewport';
import { COMMANDS, type AppCtx, type Command } from './commands';
import { Icon, type IconName } from './icons';

export interface MenuItem { label: string; icon?: IconName; shortcut?: string; disabled?: boolean; danger?: boolean; run?: () => void; separator?: boolean }

/**
 * Up / Down arrows move between the enabled items of a menu, Home / End jump
 * to the ends, and Enter or Space runs the focused item (standard menu keys).
 */
function useMenuKeys(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const el = ref.current; if (!el) return;
      const items = Array.from(el.querySelectorAll<HTMLButtonElement>('button.menu-item:not(:disabled), .orient-grid button:not(:disabled)'));
      if (!items.length) return;
      e.preventDefault(); e.stopPropagation();
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur <= 0 ? items.length - 1 : cur - 1);
      items[next].focus();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [ref]);
}

/** Keeps a popup inside the window and closes it on outside click / Esc. */
function useFloating(x: number, y: number, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true));
    window.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return { ref, style: { left: pos.left, top: pos.top } };
}

export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const f = useFloating(x, y, onClose);
  useMenuKeys(f.ref);
  return (
    <div className="popup menu" ref={f.ref} style={f.style} onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="menu-title">{title}</div>}
      {items.map((it, i) => it.separator ? <div key={i} className="menu-sep" /> : (
        <button key={i} className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { onClose(); it.run?.(); }}>
          <span className="menu-icon">{it.icon && <Icon name={it.icon} size={15} />}</span>
          <span className="menu-label">{it.label}</span>
          {it.shortcut && <span className="menu-key">{it.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}

const ORIENT: { v: StandardView; label: string; key: string }[] = [
  { v: 'front', label: 'Front', key: 'Ctrl+1' }, { v: 'back', label: 'Back', key: 'Ctrl+2' },
  { v: 'left', label: 'Left', key: 'Ctrl+3' }, { v: 'right', label: 'Right', key: 'Ctrl+4' },
  { v: 'top', label: 'Top', key: 'Ctrl+5' }, { v: 'bottom', label: 'Bottom', key: 'Ctrl+6' },
  { v: 'iso', label: 'Isometric', key: 'Ctrl+7' },
];

/** Space bar: view orientation menu at the pointer. */
export function OrientationMenu({ x, y, ctx, onClose }: { x: number; y: number; ctx: AppCtx; onClose: () => void }) {
  const f = useFloating(x, y, onClose);
  useMenuKeys(f.ref);
  return (
    <div className="popup orient" ref={f.ref} style={f.style}>
      <div className="menu-title">Orientation</div>
      <div className="orient-grid">
        {ORIENT.map((o) => (
          <button key={o.v} title={o.key} onClick={() => { onClose(); ctx.view(o.v); }}>
            <ViewCube view={o.v} /><span>{o.label}</span>
          </button>
        ))}
        <button title="Ctrl+8" onClick={() => { onClose(); ctx.normalTo(); }}><Icon name="views" /><span>Normal To</span></button>
      </div>
      <div className="menu-sep" />
      <button className="menu-item" onClick={() => { onClose(); ctx.vp?.previousView(); }}><span className="menu-icon"><Icon name="prev" size={15} /></span><span className="menu-label">Previous View</span><span className="menu-key">Ctrl+Shift+Z</span></button>
      <button className="menu-item" onClick={() => { onClose(); ctx.vp?.fit(); }}><span className="menu-icon"><Icon name="fit" size={15} /></span><span className="menu-label">Zoom to Fit</span><span className="menu-key">F</span></button>
    </div>
  );
}

/** Tiny cube glyph with the viewed face shaded. */
function ViewCube({ view }: { view: StandardView }) {
  const shade: Record<StandardView, string> = {
    front: 'M4 8h8v8H4z', back: 'M4 8h8v8H4z', left: 'M4 8h8v8H4z', right: 'M12 8l4-4v8l-4 4z',
    top: 'M4 8l4-4h8l-4 4z', bottom: 'M4 16h8l4-4', iso: 'M12 8l4-4v8l-4 4z',
  };
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d={shade[view]} fill="currentColor" fillOpacity=".35" stroke="none" />
      <path d="M4 8h8v8H4zM4 8l4-4h8l-4 4M12 16l4-4V4" />
    </svg>
  );
}

/** S key: shortcut bar at the pointer. In sketch mode the sketcher supplies its own tools. */
export function ShortcutBar({ x, y, ctx, tools, onClose, onRun }: {
  x: number; y: number; ctx: AppCtx; tools?: { id: string; label: string; icon?: string; run(): void }[]; onClose: () => void; onRun(c: Command): void;
}) {
  const f = useFloating(x - 20, y - 20, onClose);
  const cmds = COMMANDS.filter((c) => c.shortcutBar);
  return (
    <div className="popup sbar" ref={f.ref} style={f.style}>
      {tools ? tools.map((t) => (
        <button key={t.id} title={t.label} onClick={() => { onClose(); t.run(); }}><Icon name={(t.icon as IconName) ?? 'sketch'} /></button>
      )) : cmds.map((c) => (
        <button key={c.id} title={`${c.label}${c.shortcut ? ` (${c.shortcut})` : ''}`} data-hint={c.hint} disabled={c.enabled ? !c.enabled(ctx) : false} onClick={() => { onClose(); onRun(c); }}>
          <Icon name={c.icon} />
        </button>
      ))}
    </div>
  );
}

/** W key: type to find and run any command. */
export function CommandSearch({ ctx, onClose, onRun }: { ctx: AppCtx; onClose: () => void; onRun(c: Command): void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const f = useFloating(window.innerWidth / 2 - 180, 90, onClose);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return COMMANDS.filter((c) => !t || c.label.toLowerCase().includes(t) || c.hint.toLowerCase().includes(t) || c.id.toLowerCase().includes(t));
  }, [q]);
  const run = (c?: Command) => { if (!c || (c.enabled && !c.enabled(ctx))) return; onClose(); onRun(c); };
  return (
    <div className="popup search" ref={f.ref} style={f.style}>
      <input autoFocus placeholder="Search commands…" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(i + 1, list.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(i - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); run(list[i]); }
        }} />
      <div className="search-list">
        {list.map((c, k) => (
          <button key={c.id} className={`menu-item ${k === i ? 'on' : ''}`} disabled={c.enabled ? !c.enabled(ctx) : false} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
            <span className="menu-icon"><Icon name={c.icon} size={15} /></span>
            <span className="menu-label">{c.label}<small>{c.hint}</small></span>
            {c.shortcut && <span className="menu-key">{c.shortcut}</span>}
          </button>
        ))}
        {list.length === 0 && <div className="menu-title">No command matches “{q}”</div>}
      </div>
    </div>
  );
}
