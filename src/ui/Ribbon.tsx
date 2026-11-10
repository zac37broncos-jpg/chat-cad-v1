/**
 * Top of the window: a quick-access strip (file, undo/redo, rebuild,
 * export, options) and a tabbed command ribbon with large buttons.
 */
import { useState } from 'react';
import { COMMAND_BY_ID, type AppCtx, type Command, type CommandGroup } from './commands';
import { Icon } from './icons';
import { ContextMenu } from './Popups';
import { APP_NAME, PART_FILE_EXT } from '../brand';

/** A group of buttons; groups whose first entry is SMALL show as stacked small buttons (up to three rows). */
const SMALL = '__small__';
const TABS: { id: CommandGroup; label: string; ids: string[][] }[] = [
  { id: 'features', label: 'Features', ids: [
    ['boss', 'revolve'], [SMALL, 'sweep', 'loft'],
    ['cutExtrude', 'hole', 'cutRevolve'], [SMALL, 'cutSweep', 'cutLoft'],
    ['fillet', 'chamfer'], ['linearPattern', 'circularPattern', 'mirror'], [SMALL, 'rib', 'draft', 'shell'],
    [SMALL, 'refPlane', 'refAxis', 'refPoint'], ['params'],
  ] },
  { id: 'sketch', label: 'Sketch', ids: [['sketch', 'editSketch']] },
  { id: 'evaluate', label: 'Evaluate', ids: [['measure', 'mass', 'material']] },
  { id: 'view', label: 'View', ids: [['fit', 'prevView', 'normalTo'], ['front', 'top', 'right', 'iso'], ['chat']] },
];

function enabled(c: Command, ctx: AppCtx) { return c.enabled ? c.enabled(ctx) : true; }

export function Ribbon({ ctx, onRun, onSearch, title }: { ctx: AppCtx; onRun(c: Command): void; onSearch(): void; title: string }) {
  const [tab, setTab] = useState<CommandGroup>('features');
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number } | null>(null);
  const quick = ['new', 'open', 'save', 'undo', 'redo', 'rebuild'].map((id) => COMMAND_BY_ID.get(id)!);
  /** Undo / Redo name the step they act on, like mainstream CAD's Undo list. */
  const label = (c: Command) => {
    const step = c.id === 'undo' ? ctx.store.undoLabel : c.id === 'redo' ? ctx.store.redoLabel : undefined;
    return step ? `${c.label} ${step}` : c.label;
  };
  const hint = (c: Command) => (c.id === 'undo' || c.id === 'redo') && ctx.editing ? `${c.hint} (close the open panel first)` : c.hint;
  const tip = (c: Command) => `${label(c)}${c.shortcut ? ` (${c.shortcut})` : ''}\n${hint(c)}`;
  return (
    <header className="ribbon">
      <div className="quickbar">
        <span className="brand">{APP_NAME}</span>
        <button className="qb wide" title="File menu: new, open, save, export" data-hint="New, Open, Save, Export STEP, Export STL" data-testid="file-menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setFileMenu({ x: r.left, y: r.bottom + 2 }); }}>File ▾</button>
        {quick.map((c) => (
          <button key={c.id} className="qb" title={tip(c)} data-hint={c.id === 'undo' || c.id === 'redo' ? `${label(c)}: ${hint(c)}` : c.hint} disabled={!enabled(c, ctx)} onClick={() => onRun(c)}><Icon name={c.icon} size={17} /></button>
        ))}
        {(['exportStep', 'exportStl'] as const).map((id) => { const c = COMMAND_BY_ID.get(id)!; return (
          <button key={id} className="qb wide export-btn" title={`${c.label}\n${c.hint}`} data-hint={c.hint} data-testid={`qb-${id}`} disabled={!enabled(c, ctx)} onClick={() => onRun(c)}>
            <Icon name="export" size={17} /> {c.label}
          </button>
        ); })}
        <button className="qb" title={tip(COMMAND_BY_ID.get('options')!)} data-hint={COMMAND_BY_ID.get('options')!.hint} onClick={() => onRun(COMMAND_BY_ID.get('options')!)}><Icon name="options" size={17} /></button>
        <span className="doc-title">{title}</span>
        <button className="qb wide search-btn" title="Search commands (W)" data-hint="Find and run any command by name" onClick={onSearch}>Search commands <kbd>W</kbd></button>
      </div>
      <div className="cm-tabs">
        {TABS.map((t) => <button key={t.id} className={`cm-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
        {ctx.makeDrawing && <button className="cm-tab" onClick={ctx.makeDrawing}>Drawings</button>}
      </div>
      <div className="cm-body">
        {TABS.find((t) => t.id === tab)!.ids.map((grp, gi) => (
          <div key={gi} className={`cm-group ${grp[0] === SMALL ? 'small' : ''}`}>
            {grp.filter((id) => id !== SMALL).map((id) => {
              const c = COMMAND_BY_ID.get(id)!;
              return grp[0] === SMALL ? (
                <button key={id} className="cm-btn-sm" title={tip(c)} data-hint={c.hint} disabled={!enabled(c, ctx)} onClick={() => onRun(c)}>
                  <Icon name={c.icon} size={16} /><span>{c.label}</span>
                </button>
              ) : (
                <button key={id} className="cm-btn" title={tip(c)} data-hint={c.hint} disabled={!enabled(c, ctx)} onClick={() => onRun(c)}>
                  <Icon name={c.icon} size={24} /><span>{c.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {fileMenu && (
        <ContextMenu x={fileMenu.x} y={fileMenu.y} onClose={() => setFileMenu(null)} items={[
          ...(['new', 'open', 'save'] as const).map((id) => { const c = COMMAND_BY_ID.get(id)!; return { label: c.id === 'save' ? `Save part file (${PART_FILE_EXT})` : c.id === 'open' ? 'Open part file…' : 'New part', icon: c.icon, shortcut: c.shortcut, disabled: !enabled(c, ctx), run: () => onRun(c) }; }),
          { separator: true, label: '' },
          { label: 'Export STEP (.step)…  for CAD / CAM', icon: 'export', disabled: !enabled(COMMAND_BY_ID.get('exportStep')!, ctx), run: () => onRun(COMMAND_BY_ID.get('exportStep')!) },
          { label: 'Export STL (.stl)…  for 3D printing', icon: 'export', disabled: !enabled(COMMAND_BY_ID.get('exportStl')!, ctx), run: () => onRun(COMMAND_BY_ID.get('exportStl')!) },
        ]} />
      )}
    </header>
  );
}
