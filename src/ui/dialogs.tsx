/**
 * Property-manager style dialogs (left/right panel forms) for creating and
 * editing features. Every field accepts expressions with units, e.g.
 * "0.25", "6.35 mm", "2*wall", "1/4\"".
 */
import { useMemo, useState } from 'react';
import type { DocumentStore } from '../core/store';
import { resolveParams } from '../core/store';
import type { BasePlane, ExtrudeFeature, SketchEntity, SketchFeature, RevolveFeature } from '../core/model';
import { newId, rectangleEntities, centerRectangleEntities } from '../core/model';
import { evalLength, evalAngle, formatLength } from '../core/units';
import { constraintRefs, isBuiltin } from '../sketch/geom';

export type DialogState =
  | { kind: 'sketch'; editId?: string }
  | { kind: 'extrude'; editId?: string; cut?: boolean }
  | { kind: 'revolve'; editId?: string }
  | { kind: 'params' }
  | null;

/** A text field that evaluates its expression live and shows the exact value. */
export function ExprField({ label, value, onChange, kind = 'length', store }: {
  label: string; value: string; onChange: (v: string) => void; kind?: 'length' | 'angle'; store: DocumentStore;
}) {
  const doc = store.state;
  let shown = ''; let err = '';
  try {
    const params = resolveParams(doc);
    if (kind === 'length') shown = formatLength(evalLength(value, doc.units, params), doc.units, 6);
    else shown = `${((evalAngle(value, params) * 180) / Math.PI).toFixed(6)}°`;
  } catch (e) { err = (e as Error).message; }
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className={err ? 'bad' : ''} spellCheck={false} />
      <small className={err ? 'err' : 'ok'}>{err || `= ${shown}`}</small>
    </label>
  );
}

const PLANES: { id: BasePlane; label: string }[] = [
  { id: 'XZ', label: 'Front (XZ)' }, { id: 'XY', label: 'Top (XY)' }, { id: 'YZ', label: 'Right (YZ)' },
];

function entityLabel(e: SketchEntity): string {
  const s = (v: unknown) => String(v);
  if (e.kind === 'line') return `Line (${s(e.p1.x)}, ${s(e.p1.y)}) → (${s(e.p2.x)}, ${s(e.p2.y)})`;
  if (e.kind === 'point') return `Point (${s(e.p.x)}, ${s(e.p.y)})`;
  if (e.kind === 'circle') return `Circle c=(${s(e.center.x)}, ${s(e.center.y)}) r=${s(e.radius)}`;
  if (e.kind === 'spline') return `${e.closed ? 'Closed spline' : 'Spline'} through ${e.points.length} points`;
  return `Arc c=(${s(e.center.x)}, ${s(e.center.y)}) r=${s(e.radius)} ${s(e.startAngle)}°→${s(e.endAngle)}°`;
}

export function SketchDialog({ store, editId, initialPlane, initialOffset, onClose }: { store: DocumentStore; editId?: string; initialPlane?: BasePlane; initialOffset?: string; onClose: () => void }) {
  const existing = editId ? (store.feature(editId) as SketchFeature | undefined) : undefined;
  const [plane, setPlane] = useState<BasePlane | 'face'>(existing?.plane ?? initialPlane ?? 'XY');
  const [offset, setOffset] = useState(String(existing?.offset ?? initialOffset ?? '0'));
  const [name, setName] = useState(existing?.name ?? '');
  const defaultName = existing?.name ?? store.nextName('Sketch');
  const [entities, setEntities] = useState<SketchEntity[]>(existing?.entities ?? []);
  const [tool, setTool] = useState<'rect' | 'crect' | 'circle' | 'line' | 'arc'>('rect');
  const [f, setF] = useState<Record<string, string>>({ x: '0', y: '0', w: '1', h: '1', d: '0.5', x2: '1', y2: '0', r: '0.5', a0: '0', a1: '90' });
  const [construction, setConstruction] = useState(false);
  const set = (k: string) => (v: string) => setF((o) => ({ ...o, [k]: v }));

  const add = () => {
    let ents: SketchEntity[] = [];
    if (tool === 'rect') ents = rectangleEntities(f.x, f.y, f.w, f.h);
    if (tool === 'crect') ents = centerRectangleEntities(f.x, f.y, f.w, f.h);
    if (tool === 'circle') ents = [{ id: newId('ci'), kind: 'circle', center: { x: f.x, y: f.y }, radius: `(${f.d})/2` }];
    if (tool === 'line') ents = [{ id: newId('ln'), kind: 'line', p1: { x: f.x, y: f.y }, p2: { x: f.x2, y: f.y2 } }];
    if (tool === 'arc') ents = [{ id: newId('ar'), kind: 'arc', center: { x: f.x, y: f.y }, radius: f.r, startAngle: f.a0, endAngle: f.a1 }];
    if (construction) ents = ents.map((e) => ({ ...e, construction: true }));
    setEntities((es) => [...es, ...ents]);
  };

  const commit = () => {
    if (existing) {
      store.transaction(`Edit ${existing.name}`, () => {
        // Relations/dimensions that referred to removed entities are dropped with them.
        const ids = new Set(entities.map((e) => e.id));
        const constraints = (existing.constraints ?? []).filter((c) => constraintRefs(c).every((r) => ids.has(r) || isBuiltin(r)));
        store.updateFeature(existing.id, { plane, offset, entities, constraints, name: name.trim() || existing.name });
      });
    } else {
      store.addSketch(plane as BasePlane, entities, { offset, name: name.trim() || undefined });
    }
    onClose();
  };

  return (
    <div className="dialog">
      <h3>{existing ? `Edit ${existing.name}` : 'New Sketch'}</h3>
      <p className="hint">Typed sketch entry: exact coordinates and expressions. To draw with the mouse, with relations and dimensions, use Sketch.</p>
      <label className="field"><span>Sketch name</span><input value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} spellCheck={false} /></label>
      {plane === 'face'
        ? <p className="hint">Plane: on face{existing?.faceLabel ? ` (${existing.faceLabel})` : ''}</p>
        : <label className="field"><span>Plane</span>
          <select value={plane} onChange={(e) => setPlane(e.target.value as BasePlane)}>{PLANES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>}
      <ExprField label="Plane offset" value={offset} onChange={setOffset} store={store} />
      <div className="seg">
        {(['rect', 'crect', 'circle', 'line', 'arc'] as const).map((t) => (
          <button key={t} className={tool === t ? 'on' : ''} onClick={() => setTool(t)}>
            {{ rect: 'Corner rect', crect: 'Center rect', circle: 'Circle', line: 'Line', arc: 'Arc' }[t]}
          </button>
        ))}
      </div>
      <div className="grid2">
        <ExprField label={tool === 'rect' ? 'Corner X' : tool === 'line' ? 'Start X' : 'Center X'} value={f.x} onChange={set('x')} store={store} />
        <ExprField label={tool === 'rect' ? 'Corner Y' : tool === 'line' ? 'Start Y' : 'Center Y'} value={f.y} onChange={set('y')} store={store} />
        {(tool === 'rect' || tool === 'crect') && <><ExprField label="Width" value={f.w} onChange={set('w')} store={store} /><ExprField label="Height" value={f.h} onChange={set('h')} store={store} /></>}
        {tool === 'circle' && <ExprField label="Diameter" value={f.d} onChange={set('d')} store={store} />}
        {tool === 'line' && <><ExprField label="End X" value={f.x2} onChange={set('x2')} store={store} /><ExprField label="End Y" value={f.y2} onChange={set('y2')} store={store} /></>}
        {tool === 'arc' && <><ExprField label="Radius" value={f.r} onChange={set('r')} store={store} /><span /><ExprField label="Start angle" kind="angle" value={f.a0} onChange={set('a0')} store={store} /><ExprField label="End angle" kind="angle" value={f.a1} onChange={set('a1')} store={store} /></>}
      </div>
      <label className="check"><input type="checkbox" checked={construction} onChange={(e) => setConstruction(e.target.checked)} /> Construction geometry</label>
      <button onClick={add}>Add to sketch</button>
      <ul className="entities">
        {entities.map((e) => (
          <li key={e.id}>
            <span className={e.construction ? 'construction' : ''}>{entityLabel(e)}</span>
            <button className="x" title="Remove" onClick={() => setEntities((es) => es.filter((x) => x.id !== e.id))}>×</button>
          </li>
        ))}
        {entities.length === 0 && <li className="hint">No entities yet</li>}
      </ul>
      <div className="actions"><button className="primary" onClick={commit}>✓ OK</button><button onClick={onClose}>Cancel</button></div>
    </div>
  );
}

export function ExtrudeDialog({ store, editId, cut, onClose }: { store: DocumentStore; editId?: string; cut?: boolean; onClose: () => void }) {
  const existing = editId ? (store.feature(editId) as ExtrudeFeature | undefined) : undefined;
  const sketches = store.state.features.filter((x): x is SketchFeature => x.type === 'sketch');
  const [sketch, setSketch] = useState(existing?.sketch ?? sketches.at(-1)?.id ?? '');
  const [depth, setDepth] = useState(String(existing?.depth ?? '0.5'));
  const [direction, setDirection] = useState<ExtrudeFeature['direction']>(existing?.direction ?? 'normal');
  const hasBody = store.state.features.some((x) => x.type !== 'sketch');
  const [operation, setOperation] = useState<ExtrudeFeature['operation']>(existing?.operation ?? (cut ? 'cut' : hasBody ? 'add' : 'new'));
  const [throughAll, setThroughAll] = useState(!!existing?.throughAll);
  const commit = () => {
    if (!sketch) return;
    if (existing) store.updateFeature(existing.id, { sketch, depth, direction, operation, throughAll });
    else store.addExtrude(sketch, depth, { direction, operation, throughAll });
    onClose();
  };
  return (
    <div className="dialog">
      <h3>{existing ? `Edit ${existing.name}` : operation === 'cut' ? 'Cut-Extrude' : 'Extrude'}</h3>
      <label className="field"><span>Sketch</span>
        <select value={sketch} onChange={(e) => setSketch(e.target.value)}>{sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </label>
      <label className="field"><span>Operation</span>
        <select value={operation} onChange={(e) => setOperation(e.target.value as any)}>
          {!hasBody && <option value="new">New body</option>}<option value="add">Add (boss)</option><option value="cut">Cut</option>
        </select>
      </label>
      <label className="field"><span>Direction</span>
        <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
          <option value="normal">Along normal</option><option value="reverse">Reversed</option><option value="symmetric">Mid-plane (symmetric)</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={throughAll} onChange={(e) => setThroughAll(e.target.checked)} /> Through all</label>
      {!throughAll && <ExprField label="Depth" value={depth} onChange={setDepth} store={store} />}
      <div className="actions"><button className="primary" onClick={commit} disabled={!sketch}>✓ OK</button><button onClick={onClose}>Cancel</button></div>
    </div>
  );
}

export function RevolveDialog({ store, editId, onClose }: { store: DocumentStore; editId?: string; onClose: () => void }) {
  const existing = editId ? (store.feature(editId) as RevolveFeature | undefined) : undefined;
  const sketches = store.state.features.filter((x): x is SketchFeature => x.type === 'sketch');
  const [sketch, setSketch] = useState(existing?.sketch ?? sketches.at(-1)?.id ?? '');
  const lines = useMemo(() => (sketches.find((s) => s.id === sketch)?.entities ?? []).filter((e) => e.kind === 'line'), [sketch, sketches]);
  const [axis, setAxis] = useState(existing?.axisLine ?? '');
  const [angle, setAngle] = useState(String(existing?.angle ?? '360'));
  const hasBody = store.state.features.some((x) => x.type !== 'sketch');
  const [operation, setOperation] = useState<RevolveFeature['operation']>(existing?.operation ?? (hasBody ? 'add' : 'new'));
  const axisId = axis || lines.find((l) => l.construction)?.id || lines[0]?.id || '';
  const commit = () => {
    if (!sketch || !axisId) return;
    if (existing) store.updateFeature(existing.id, { sketch, axisLine: axisId, angle, operation });
    else store.addRevolve(sketch, axisId, angle, { operation });
    onClose();
  };
  return (
    <div className="dialog">
      <h3>{existing ? `Edit ${existing.name}` : 'Revolve'}</h3>
      <label className="field"><span>Sketch</span>
        <select value={sketch} onChange={(e) => setSketch(e.target.value)}>{sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </label>
      <label className="field"><span>Axis (line in sketch)</span>
        <select value={axisId} onChange={(e) => setAxis(e.target.value)}>{lines.map((l) => <option key={l.id} value={l.id}>{entityLabel(l)}{l.construction ? ' (construction)' : ''}</option>)}</select>
      </label>
      <label className="field"><span>Operation</span>
        <select value={operation} onChange={(e) => setOperation(e.target.value as any)}>
          {!hasBody && <option value="new">New body</option>}<option value="add">Add (boss)</option><option value="cut">Cut</option>
        </select>
      </label>
      <ExprField label="Angle" kind="angle" value={angle} onChange={setAngle} store={store} />
      <div className="actions"><button className="primary" onClick={commit} disabled={!axisId}>✓ OK</button><button onClick={onClose}>Cancel</button></div>
    </div>
  );
}

export function ParamsDialog({ store, onClose }: { store: DocumentStore; onClose: () => void }) {
  const [name, setName] = useState('');
  const [expr, setExpr] = useState('');
  const [err, setErr] = useState('');
  const doc = store.state;
  let resolved: ReturnType<typeof resolveParams> = {};
  try { resolved = resolveParams(doc); } catch { /* shown per row */ }
  const add = () => {
    try { store.setParameter(name.trim(), expr.trim()); setName(''); setExpr(''); setErr(''); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="dialog">
      <h3>Parameters</h3>
      <p className="hint">Named values usable in any field, e.g. <code>wall</code>, <code>2*wall</code>. Values with no unit are in document units ({doc.units}).</p>
      <table className="params"><tbody>
        {doc.params.map((p) => (
          <tr key={p.name}><td><code>{p.name}</code></td><td>{p.expr}</td>
            <td>{resolved[p.name] ? (resolved[p.name].dim === 'length' ? formatLength(resolved[p.name].v, doc.units, 6) : resolved[p.name].v.toFixed(6)) : '?'}</td>
            <td><button className="x" onClick={() => store.deleteParameter(p.name)}>×</button></td></tr>
        ))}
      </tbody></table>
      <div className="grid2">
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Value</span><input value={expr} onChange={(e) => setExpr(e.target.value)} /></label>
      </div>
      {err && <small className="err">{err}</small>}
      <div className="actions"><button className="primary" onClick={add} disabled={!name || !expr}>Add / update</button><button onClick={onClose}>Close</button></div>
    </div>
  );
}
