/**
 * Export STEP and Export STL command panels. Each one shows the choices
 * that decide whether the file is right (units, resolution, format), saves
 * the file, and then shows what the kernel's own check of that file found:
 * a plain "good file" summary, or the problems and a Save anyway button.
 *
 * A part with features that failed to rebuild is never saved silently: the file would be
 * missing those features (a hole that is not there, a boss that is not printed). The panel warns
 * as soon as it opens, and the export is held back until the user explicitly saves without them.
 */
import { useState } from 'react';
import type { StepOptions, StepReport, StepSchema, StlOptions, StlReport, ExportUnit } from '../kernel/exporters';
import { STL_DEFAULT, STL_PRESETS, safeFileBase } from '../kernel/exportDefaults';
import { resolveParams } from '../core/store';
import { evalAngle, evalLength, formatLength, MM_PER } from '../core/units';
import { ExprField } from './dialogs';
import { Shell, Section, type PMProps } from './CommandPanel';
import type { FailedFeature } from '../kernel/regenOp';
import { APP_NAME } from '../brand';

export type ExportRequest =
  | { kind: 'step'; fileName: string; opts: StepOptions }
  | { kind: 'stl'; fileName: string; opts: StlOptions };
export type ExportOutcome =
  | { kind: 'step'; fileName: string; saved: boolean; report: StepReport; failed: FailedFeature[] }
  | { kind: 'stl'; fileName: string; saved: boolean; report: StlReport; failed: FailedFeature[] };
/**
 * Implemented by App: rebuild the open document in the geometry worker, export it and, when the
 * file is good and no feature failed to rebuild (or `force`), save it.
 */
export type ExportFile = (req: ExportRequest, force?: boolean) => Promise<ExportOutcome>;

const DEG = 180 / Math.PI;
const bytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const count = (n: number) => n.toLocaleString('en-US');
/** Size of a box (mm) in a unit: "4.0000 x 2.0000 x 0.5000 in". */
const sizeText = (min: number[], max: number[], unit: ExportUnit) => `${[0, 1, 2].map((k) => ((max[k] - min[k]) / MM_PER[unit]).toFixed(unit === 'in' ? 4 : 3)).join(' x ')} ${unit}`;
const unitWord = (u: ExportUnit) => (u === 'in' ? 'inches' : 'millimeters');

function Radio<T extends string>({ value, set, options }: { value: T; set(v: T): void; options: { v: T; label: string; note?: string }[] }) {
  return (
    <>
      {options.map((o) => (
        <label key={o.v} className="check export-opt">
          <input type="radio" checked={value === o.v} onChange={() => set(o.v)} />
          <span>{o.label}{o.note && <span className="muted"> · {o.note}</span>}</span>
        </label>
      ))}
    </>
  );
}

function FileNameField({ base, setBase, ext }: { base: string; setBase(v: string): void; ext: string }) {
  return (
    <label className="field">
      <span>File name</span>
      <span className="export-name"><input className="pm-input" value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} /><span className="muted">{ext}</span></span>
    </label>
  );
}

/** Running, done, or failed: the shared bottom part of both panels. */
function useRun() {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const [error, setError] = useState('');
  const run = async (f: () => Promise<ExportOutcome>) => {
    setBusy(true); setError(''); setOutcome(null);
    try { setOutcome(await f()); } catch (e) { setError((e as Error).message || String(e)); } finally { setBusy(false); }
  };
  return { busy, outcome, error, run, reset: () => { setOutcome(null); setError(''); } };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Features of the open document that failed in its last rebuild (shown when the panel opens). */
function failedNow({ ctx, regen }: Pick<PMProps, 'ctx' | 'regen'>): string[] {
  const doc = ctx.store.state;
  return (regen?.status ?? []).filter((s) => !s.ok).map((s) => doc.features.find((f) => f.id === s.id)?.name ?? s.id);
}

/** Shown as soon as the panel opens when the model on screen has rebuild errors. */
function FailedWarning({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <p className="pm-help warn-help" data-testid="export-failed-warning">
      {plural(names.length, 'feature')} failed to rebuild: {names.join(', ')}. The file would be missing {names.length === 1 ? 'it' : 'them'}.
      Fix {names.length === 1 ? 'it' : 'them'} first (red in the tree), or ask Claude in the chat. {APP_NAME} will not save a part with missing features unless you confirm.
    </p>
  );
}

/** The export was held back: features failed to rebuild, and/or the file check found problems. */
function NotSaved({ failed, problems, onForce, busy }: { failed: FailedFeature[]; problems: string[]; onForce(): void; busy: boolean }) {
  return (
    <div className="export-result bad" data-testid="export-result">
      {failed.length > 0 && (
        <>
          <b>Not saved: the file would be missing {plural(failed.length, 'feature')} that failed to rebuild.</b>
          <ul>{failed.map((f) => <li key={f.id}><b>{f.name}</b>: {f.message}</li>)}</ul>
          <p>Fix {failed.length === 1 ? 'it' : 'them'} first (red in the tree), or tell Claude in the chat what it says. Save without {failed.length === 1 ? 'it' : 'them'} only if you really want the part as it is now.</p>
        </>
      )}
      {problems.length > 0 && (
        <>
          <b>{failed.length ? 'The file check also found a problem.' : 'Not saved: the check found a problem.'}</b>
          <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          <p>Tell Claude in the chat what it says, or change the resolution and try again.</p>
        </>
      )}
      <button disabled={busy} onClick={onForce} data-testid="export-force">{failed.length ? `Save without the ${failed.length === 1 ? 'failed feature' : `${failed.length} failed features`}` : 'Save anyway'}</button>
    </div>
  );
}

/** One line naming what a forced save left out. */
function Missing({ failed }: { failed: FailedFeature[] }) {
  if (!failed.length) return null;
  return <><span>Missing</span><span>{plural(failed.length, 'feature')} that failed to rebuild: {failed.map((f) => f.name).join(', ')}</span></>;
}

// ------------------------------------------------------------------ STEP

export function ExportStepPM({ ctx, close, exportFile, regen }: PMProps) {
  const doc = ctx.store.state;
  const [base, setBase] = useState(() => safeFileBase(doc.name));
  const [unit, setUnit] = useState<ExportUnit>(doc.units);
  const [schema, setSchema] = useState<StepSchema>('AP214');
  const { busy, outcome, error, run, reset } = useRun();
  const fileName = `${safeFileBase(base)}.step`;
  const go = (force = false) => run(() => exportFile({ kind: 'step', fileName, opts: { unit, schema, name: doc.name || 'Part', fileName } }, force));
  const r = outcome?.kind === 'step' ? outcome.report : null;
  const ok = !busy && !!ctx.hasSolid && !!base.trim();
  return (
    <Shell title="Export STEP" icon="export" onOk={() => { if (ok) go(); }} okDisabled={!ok} onCancel={close}
      help="STEP keeps the exact solid (true circles, cylinders and curves) for other CAD programs, print services and CNC (CAM). The unit is written into the file, so the other program scales it correctly.">
      <FailedWarning names={failedNow({ ctx, regen })} />
      {doc.rollback !== null && <p className="pm-help warn-help">The rollback bar is not at the end of the tree: the file holds the model as it is shown now, without the features below the bar.</p>}
      <Section title="File">
        <FileNameField base={base} setBase={(v) => { setBase(v); reset(); }} ext=".step" />
      </Section>
      <Section title="Units in the file">
        <Radio value={unit} set={(v) => { setUnit(v); reset(); }} options={[
          { v: 'in', label: 'Inches', note: doc.units === 'in' ? 'this part’s unit' : undefined },
          { v: 'mm', label: 'Millimeters', note: doc.units === 'mm' ? 'this part’s unit' : undefined },
        ]} />
      </Section>
      <Section title="STEP version">
        <Radio value={schema} set={(v) => { setSchema(v); reset(); }} options={[
          { v: 'AP214', label: 'AP214 (recommended)', note: 'read by every CAD and CAM program' },
          { v: 'AP242', label: 'AP242', note: 'newer; pick it only if asked for' },
        ]} />
      </Section>
      <button className="primary export-go" disabled={!ok} onClick={() => go()} data-testid="export-step-go">{busy ? 'Saving and checking…' : `Save ${fileName}`}</button>
      {error && <div className="export-result bad" data-testid="export-result"><b>Export failed.</b> {error}</div>}
      {r && outcome && (outcome.saved ? (
        <div className={`export-result ${r.ok && !outcome.failed.length ? 'good' : 'bad'}`} data-testid="export-result">
          <b>{r.ok && !outcome.failed.length ? `Saved ${outcome.fileName}` : `Saved ${outcome.fileName} anyway`}</b> <span className="muted">({bytes(r.bytes)}, see your browser’s downloads)</span>
          <div className="kv">
            <Missing failed={outcome.failed} />
            <span>Check</span><span>{r.ok ? 'Read back by a separate STEP reader: the same solid' : r.problems.join(' ')}</span>
            <span>Body</span><span>{r.solids === 1 ? '1 solid' : `${r.solids} solids`}, {r.faces} faces, {r.edges} edges</span>
            <span>Size</span><span>{sizeText(r.bboxMin, r.bboxMax, r.unit)}</span>
            <span>Units</span><span>{unitWord(r.unit)}</span>
            <span>Format</span><span>STEP {r.schema}, part name “{doc.name}”</span>
          </div>
        </div>
      ) : <NotSaved failed={outcome.failed} problems={r.problems} busy={busy} onForce={() => go(true)} />)}
    </Shell>
  );
}

// ------------------------------------------------------------------ STL

/** Custom resolution limits: finer than this makes huge files for no printable gain; coarser breaks the 0.005 in promise. */
const MIN_DEV = 0.001, MAX_DEV = 0.127, MIN_ANG = 0.5, MAX_ANG = 30;

export function ExportStlPM({ ctx, close, exportFile, regen }: PMProps) {
  const doc = ctx.store.state;
  const u = doc.units;
  const [base, setBase] = useState(() => safeFileBase(doc.name));
  const [unit, setUnit] = useState<ExportUnit>('mm');
  const [format, setFormat] = useState<'binary' | 'ascii'>('binary');
  const [preset, setPreset] = useState<string>(STL_DEFAULT.id);
  const [dev, setDev] = useState(u === 'in' ? '0.0004' : '0.01');
  const [ang, setAng] = useState('5');
  const { busy, outcome, error, run, reset } = useRun();
  const p = STL_PRESETS.find((x) => x.id === preset);
  let lin = p?.linearDeflection ?? NaN, angRad = p?.angularDeflection ?? NaN;
  let customError = '';
  if (!p) {
    try { lin = evalLength(dev, u, resolveParams(doc)); } catch { lin = NaN; }
    try { angRad = evalAngle(ang, resolveParams(doc)); } catch { angRad = NaN; }
    if (!(lin >= MIN_DEV && lin <= MAX_DEV)) customError = `Deviation must be between ${formatLength(MIN_DEV, u, u === 'in' ? 5 : 3)} and ${formatLength(MAX_DEV, u, u === 'in' ? 3 : 3)}.`;
    else if (!(angRad * DEG >= MIN_ANG && angRad * DEG <= MAX_ANG)) customError = `Angle must be between ${MIN_ANG}° and ${MAX_ANG}°.`;
  }
  const fileName = `${safeFileBase(base)}.stl`;
  const ok = !busy && !!ctx.hasSolid && !!base.trim() && !customError && lin > 0 && angRad > 0;
  const go = (force = false) => run(() => exportFile({ kind: 'stl', fileName, opts: { linearDeflection: lin, angularDeflection: angRad, unit, format, name: doc.name || 'Part' } }, force));
  const r = outcome?.kind === 'stl' ? outcome.report : null;
  const both = (mm: number) => `${formatLength(mm, 'mm', mm < 0.01 ? 4 : 3)} (${formatLength(mm, 'in', mm < 0.01 ? 5 : 4)})`;
  return (
    <Shell title="Export STL" icon="export" onOk={() => { if (ok) go(); }} okDisabled={!ok} onCancel={close}
      help="STL is the triangle mesh 3D-printer slicers read. It has no units inside: slicers (PrusaSlicer, Cura, Bambu Studio, OrcaSlicer) read the numbers as millimeters, so keep Millimeters. Z is up, as in the slicer.">
      <FailedWarning names={failedNow({ ctx, regen })} />
      {doc.rollback !== null && <p className="pm-help warn-help">The rollback bar is not at the end of the tree: the file holds the model as it is shown now, without the features below the bar.</p>}
      <Section title="File">
        <FileNameField base={base} setBase={(v) => { setBase(v); reset(); }} ext=".stl" />
        <Radio value={format} set={(v) => { setFormat(v); reset(); }} options={[
          { v: 'binary', label: 'Binary (recommended)', note: 'small file, exact numbers' },
          { v: 'ascii', label: 'ASCII text', note: 'about 5x bigger; only if a program asks for it' },
        ]} />
      </Section>
      <Section title="Units in the file">
        <Radio value={unit} set={(v) => { setUnit(v); reset(); }} options={[
          { v: 'mm', label: 'Millimeters (recommended)', note: 'what every slicer expects' },
          { v: 'in', label: 'Inches' },
        ]} />
        {unit === 'in' && <p className="pm-help warn-help">Slicers read STL numbers as millimeters: an inch file comes in 25.4 times too small unless you tell the slicer the file is in inches (or scale it by 2540%).</p>}
      </Section>
      <Section title="Resolution">
        {STL_PRESETS.map((x) => (
          <label key={x.id} className="check export-opt">
            <input type="radio" checked={preset === x.id} onChange={() => { setPreset(x.id); reset(); }} />
            <span>{x.label}<span className="muted"> · deviation at most {both(x.linearDeflection)}, angle {Math.round(x.angularDeflection * DEG)}° · {x.note}</span></span>
          </label>
        ))}
        <label className="check export-opt"><input type="radio" checked={preset === 'custom'} onChange={() => { setPreset('custom'); reset(); }} /> Custom</label>
        {preset === 'custom' && (
          <>
            <ExprField label="Max deviation from the true surface" value={dev} onChange={(v) => { setDev(v); reset(); }} store={ctx.store} />
            <ExprField label="Max angle between neighbouring triangles" kind="angle" value={ang} onChange={(v) => { setAng(v); reset(); }} store={ctx.store} />
            {customError && <p className="pm-help warn-help">{customError}</p>}
          </>
        )}
        <p className="pm-row muted">Deviation is how far a flat triangle may be from the true curved surface. {APP_NAME} measures it on every curved triangle before saving. Its accuracy promise is 0.005 in (0.127 mm).</p>
      </Section>
      <button className="primary export-go" disabled={!ok} onClick={() => go()} data-testid="export-stl-go">{busy ? 'Meshing and checking…' : `Save ${fileName}`}</button>
      {error && <div className="export-result bad" data-testid="export-result"><b>Export failed.</b> {error}</div>}
      {r && outcome && (outcome.saved ? (
        <div className={`export-result ${r.watertight && !outcome.failed.length ? 'good' : 'bad'}`} data-testid="export-result">
          <b>{r.watertight && !outcome.failed.length ? `Saved ${outcome.fileName}` : `Saved ${outcome.fileName} anyway`}</b> <span className="muted">({bytes(r.bytes)}, see your browser’s downloads)</span>
          <div className="kv">
            <Missing failed={outcome.failed} />
            <span>Check</span><span>{r.watertight ? 'Ready to print: closed and watertight, every triangle facing out, none flat, flipped or crossing another' : r.problems.join(' ')}</span>
            <span>Deviation</span><span>at most {both(r.measuredDeviation)} measured (asked for {both(r.linearDeflection)})</span>
            {r.notes.length > 0 && <><span>Note</span><span>{r.notes.join(' ')}</span></>}
            <span>Size</span><span>{sizeText(r.bboxMin, r.bboxMax, r.unit)}{r.unit !== u ? ` = ${sizeText(r.bboxMin, r.bboxMax, u)}` : ''}</span>
            <span>Units</span><span>{unitWord(r.unit)}</span>
            <span>Triangles</span><span>{count(r.triangles)}{r.pieces !== 1 ? `, ${r.pieces} separate pieces` : ''}</span>
            <span>Volume</span><span>{(r.volume / MM_PER[u] ** 3).toFixed(u === 'in' ? 4 : 1)} {u}³</span>
          </div>
        </div>
      ) : <NotSaved failed={outcome.failed} problems={r.problems} busy={busy} onForce={() => go(true)} />)}
    </Shell>
  );
}
