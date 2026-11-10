/**
 * Feature tree: part, material, the three reference
 * planes, origin, then the feature history with consumed sketches nested
 * under the feature that uses them, and a draggable rollback bar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BasePlane, CadDocument, Feature } from '../core/model';
import type { DocumentStore } from '../core/store';
import type { FeatureStatus } from '../kernel/regen';
import { PLANE_NAMES } from '../render/viewport';
import { Icon, type IconName } from './icons';
import { sketchesUsedBy } from './commands';

export type TreeTarget =
  | { type: 'part' }
  | { type: 'material' }
  | { type: 'origin' }
  | { type: 'plane'; plane: BasePlane }
  | { type: 'feature'; id: string };

interface Props {
  doc: CadDocument;
  store: DocumentStore;
  status: FeatureStatus[];
  busy: boolean;
  treeSel: string[];
  setTreeSel(ids: string[]): void;
  selectedPlanes: BasePlane[];
  selectPlane(plane: BasePlane, add: boolean): void;
  hoverPlane(plane: BasePlane | null): void;
  hiddenSketches: Set<string>;
  renaming: string | null;
  setRenaming(id: string | null): void;
  onEdit(f: Feature): void;
  onMaterial(): void;
  onContextMenu(t: TreeTarget, x: number, y: number): void;
  /** Compact flyout copy inside the viewport while a command panel is open. */
  flyout?: boolean;
  /** Pointer over a feature row (null when it leaves): the view lights that feature's faces. */
  hoverFeature?(id: string | null): void;
  /** Features that made the faces selected in the view: marked and scrolled into view. */
  marked?: string[];
}

interface Row { f: Feature; index: number; children: { f: Feature; index: number }[]; start: number }

const FEATURE_ICON: Record<string, IconName> = {
  sketch: 'sketch', extrude: 'boss', revolve: 'revolve', fillet: 'fillet', chamfer: 'chamfer', hole: 'hole',
  linearPattern: 'lpattern', circularPattern: 'cpattern', mirror: 'mirror', shell: 'shell', draft: 'draft', rib: 'rib',
  sweep: 'sweep', loft: 'loft', refPlane: 'refPlane', refAxis: 'refAxis', refPoint: 'refPoint',
};
export function iconFor(f: Feature): IconName {
  if (f.type === 'extrude' && f.operation === 'cut') return 'cut';
  if (f.type === 'revolve' && f.operation === 'cut') return 'revcut';
  if (f.type === 'sweep' && f.operation === 'cut') return 'sweepCut';
  if (f.type === 'loft' && f.operation === 'cut') return 'loftCut';
  return FEATURE_ICON[f.type] ?? 'part';
}

export function buildRows(doc: CadDocument): Row[] {
  const feats = doc.features;
  const consumer = new Map<string, string>();
  for (const f of feats) for (const sk of sketchesUsedBy(f)) if (!consumer.has(sk)) consumer.set(sk, f.id);
  const rows: Row[] = [];
  feats.forEach((f, index) => {
    if (f.type === 'sketch' && consumer.has(f.id)) return; // shown under its feature
    const children: Row['children'] = [];
    let start = index;
    const own = sketchesUsedBy(f).filter((sk) => consumer.get(sk) === f.id).map((sk) => feats.findIndex((x) => x.id === sk)).filter((si) => si >= 0);
    for (const si of own) children.push({ f: feats[si], index: si });
    // Rolling back above the feature also rolls back its own sketches when they come right before it.
    for (const si of [...own].sort((a, b) => b - a)) if (si === start - 1) start = si;
    rows.push({ f, index, children, start });
  });
  return rows;
}

export function FeatureTree(p: Props) {
  const { doc, store } = p;
  const rows = useMemo(() => buildRows(doc), [doc]);
  const statusById = useMemo(() => new Map(p.status.map((s) => [s.id, s])), [p.status]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragTarget, setDragTarget] = useState<number | null | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const rollback = doc.rollback ?? doc.features.length;
  const marked = useMemo(() => new Set(p.marked ?? []), [p.marked]);
  // Scroll the first marked feature into view (mainstream CAD: "Scroll selected item into view").
  const markKey = (p.marked ?? []).join(',');
  useEffect(() => {
    const id = p.marked?.[0]; if (!id || p.flyout) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-fid="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [markKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (id: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) p.setTreeSel(p.treeSel.includes(id) ? p.treeSel.filter((x) => x !== id) : [...p.treeSel, id]);
    else p.setTreeSel([id]);
  };

  // ---- rollback bar dragging
  const rowEls = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row-start]') ?? []);
  const targetAt = (clientY: number): number | null => {
    const els = rowEls();
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return Number(el.dataset.rowStart);
    }
    return null; // after everything = roll forward
  };
  // Window listeners: the bar element itself moves (and remounts) while it is dragged.
  const onBarDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let target: number | null = targetAt(e.clientY);
    setDragTarget(target);
    const move = (ev: PointerEvent) => { target = targetAt(ev.clientY); setDragTarget(target); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragTarget(undefined);
      if (target !== (store.state.rollback ?? null)) store.setRollback(target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const barAt = dragTarget !== undefined ? dragTarget : doc.rollback;
  const found = barAt === null ? -1 : rows.findIndex((r) => r.start >= barAt);
  const barIndex = found < 0 ? rows.length : found;
  const bar = (
    <div key="__bar" className={`rollback-bar ${dragTarget !== undefined ? 'dragging' : ''}`} title="Rollback bar: drag up to see the part as it was earlier. Features below it are not applied."
      onPointerDown={onBarDown} onDoubleClick={() => store.setRollback(null)} />
  );

  const featureRow = (f: Feature, index: number, depth: number, hasKids: boolean) => {
    const st = statusById.get(f.id);
    const rolled = index >= rollback;
    const sel = p.treeSel.includes(f.id);
    const sk = (st as any)?.sketch as { state: string; dof?: number } | undefined;
    const prefix = f.type === 'sketch' && sk ? (sk.state === 'under' ? '(-) ' : sk.state === 'over' ? '(+) ' : sk.state === 'failed' ? '(?) ' : '') : '';
    const hidden = f.type === 'sketch' && p.hiddenSketches.has(f.id);
    const isOpen = !collapsed.has(f.id);
    return (
      <div key={f.id} data-fid={f.id}
        onMouseEnter={() => p.hoverFeature?.(f.id)} onMouseLeave={() => p.hoverFeature?.(null)}
        className={`tree-item depth${depth} ${sel ? 'sel' : ''} ${!sel && marked.has(f.id) ? 'marked' : ''} ${rolled ? 'rolled' : ''} ${st && !st.ok ? 'error' : ''} ${f.suppressed ? 'suppressed' : ''} ${hidden ? 'hidden-sk' : ''}`}
        title={st?.message ?? (sk?.dof ? `${sk.dof} degrees of freedom left` : '')}
        onClick={(e) => select(f.id, e)}
        onDoubleClick={() => p.onEdit(f)}
        onContextMenu={(e) => { e.preventDefault(); if (!sel) p.setTreeSel([f.id]); p.onContextMenu({ type: 'feature', id: f.id }, e.clientX, e.clientY); }}>
        <span className="caret" onClick={(e) => { e.stopPropagation(); if (!hasKids) return; const n = new Set(collapsed); if (isOpen) n.add(f.id); else n.delete(f.id); setCollapsed(n); }}>
          {hasKids ? (isOpen ? '▾' : '▸') : ''}
        </span>
        <Icon name={iconFor(f)} size={16} className="tree-icon" />
        {p.renaming === f.id ? (
          <input className="rename" autoFocus defaultValue={f.name} onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== f.name) store.renameFeature(f.id, v); p.setRenaming(null); }
              if (e.key === 'Escape') p.setRenaming(null);
            }}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== f.name) store.renameFeature(f.id, v); p.setRenaming(null); }} />
        ) : <span className="name">{prefix}{f.name}</span>}
        {st && !st.ok && <span className="badge err" title={st.message}><Icon name="error" size={13} /></span>}
        {st?.ok && st.message && !rolled && !f.suppressed && <span className="badge warn" title={st.message}><Icon name="warn" size={13} /></span>}
      </div>
    );
  };

  const fixed = (key: string, icon: IconName, label: string, target: TreeTarget, extra: Partial<React.HTMLAttributes<HTMLDivElement>> = {}, cls = '') => (
    <div key={key} className={`tree-item fixed ${cls}`} onContextMenu={(e) => { e.preventDefault(); p.onContextMenu(target, e.clientX, e.clientY); }} {...extra}>
      <span className="caret" />
      <Icon name={icon} size={16} className="tree-icon" /><span className="name">{label}</span>
    </div>
  );

  return (
    <div className={`feature-tree ${p.flyout ? 'flyout' : ''}`}>
      {fixed('part', 'part', doc.name, { type: 'part' }, { onDoubleClick: () => p.setRenaming('__part__') }, 'part-row')}
      {p.renaming === '__part__' && (
        <input className="rename part-rename" autoFocus defaultValue={doc.name}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) store.renameDocument(v); p.setRenaming(null); } if (e.key === 'Escape') p.setRenaming(null); }}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== doc.name) store.renameDocument(v); p.setRenaming(null); }} />
      )}
      {!p.flyout && fixed('material', 'material', doc.material ? doc.material.name : 'Material <not specified>', { type: 'material' }, { onDoubleClick: p.onMaterial })}
      {(['XZ', 'XY', 'YZ'] as BasePlane[]).map((pl) => fixed(pl, 'plane', PLANE_NAMES[pl], { type: 'plane', plane: pl }, {
        onMouseEnter: () => p.hoverPlane(pl), onMouseLeave: () => p.hoverPlane(null),
        onClick: (e) => p.selectPlane(pl, e.ctrlKey || e.metaKey || e.shiftKey),
      }, p.selectedPlanes.includes(pl) ? 'sel' : ''))}
      {fixed('origin', 'origin', 'Origin', { type: 'origin' })}
      <div ref={listRef} className="tree-features">
        {rows.map((r, k) => {
          const hasKids = r.children.length > 0;
          return [
            k === barIndex && bar,
            <div key={r.f.id} data-row-start={r.start}>
              {featureRow(r.f, r.index, 0, hasKids)}
              {hasKids && !collapsed.has(r.f.id) && r.children.map((c) => featureRow(c.f, c.index, 1, false))}
            </div>,
          ];
        })}
        {barIndex === rows.length && bar}
      </div>
      {!p.flyout && doc.features.length === 0 && (
        <p className="tree-hint">Pick a plane above (or in the view), then <b>Sketch</b>. Extrude the sketch from the Features tab. Or ask Claude on the right.</p>
      )}
      {p.busy && !p.flyout && <div className="tree-busy">Rebuilding…</div>}
    </div>
  );
}
