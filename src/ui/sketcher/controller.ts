/**
 * Interactive sketch editing: tools, mouse/keyboard handling, inference,
 * drag solving, dimension placement and the drawing of the active sketch.
 * Every change goes through SketchSession (solved + verified, then one
 * DocumentStore command), so mouse edits are identical to AI or scripted
 * edits and undo the same way.
 *
 * Conventions follow common professional CAD sketchers:
 * click-click line chains, Ctrl suppresses automatic relations, Esc ends the
 * tool, Enter repeats the last tool, under / fully / over defined colours
 * (blue / black / red), driven dimensions shown in parentheses.
 */
import type { PointRef, SketchConstraint, SketchDimension, ValueExpr } from '../../core/model';
import { isDimension, newId } from '../../core/model';
import { MM_PER } from '../../core/units';
import type { Frame } from '../../kernel/regen';
import type { SketchOverlay, OverlayPolyline, OverlayPoint } from '../../render/sketchOverlay';
import {
  type P2, type WEntity, type WSketch, add, sub, mul, dot, cross, dist, norm, perp, lerp, polar, len,
  entityMap, pointOf, refKey, sameRef, samplePolyline, constraintRefs, constraintPointRefs, curveIntersections, arcSweep, wrap2pi, TAU, BUILTIN,
} from '../../sketch/geom';
import { snap, snapRelations, lineInference, pickEntity, type Snap } from '../../sketch/inference';
import {
  buildLine, buildPoint, buildCornerRect, buildCenterRect, buildCircle, buildArc3, buildCenterArc, buildTangentArc, buildSlot, buildPolygon, exitDirection, type Built,
} from '../../sketch/build';
import { trim, extend, offset, fillet, deleteItems, toggleConstruction, connectedChain, nearestCorner, SketchOpError } from '../../sketch/ops';
import type { SketchSession } from '../../sketch/session';
import { tangentPoints } from '../../sketch/equations';

export type ToolId =
  | 'select' | 'line' | 'centerline' | 'rect' | 'crect' | 'circle' | 'arc3' | 'carc' | 'tarc' | 'point' | 'slot' | 'polygon'
  | 'dimension' | 'trim' | 'extend' | 'offset' | 'fillet';

export const TOOL_LABEL: Record<ToolId, string> = {
  select: 'Select', line: 'Line', centerline: 'Centerline', rect: 'Corner Rectangle', crect: 'Center Rectangle',
  circle: 'Circle', arc3: '3 Point Arc', carc: 'Centerpoint Arc', tarc: 'Tangent Arc', point: 'Point', slot: 'Straight Slot', polygon: 'Polygon',
  dimension: 'Dimension', trim: 'Trim', extend: 'Extend', offset: 'Offset', fillet: 'Sketch Fillet',
};

export const TOOL_HINT: Record<ToolId, string> = {
  select: 'Click to select; drag points or curves to move them; drag empty space to box-select.',
  line: 'Click to start, click to end each segment. Press A to switch the next segment to a tangent arc. Double-click, right-click or Esc to finish. Hold Ctrl to stop automatic relations.',
  centerline: 'Construction line: click start and end.',
  rect: 'Click one corner, then the opposite corner.',
  crect: 'Click the center, then a corner.',
  circle: 'Click the center, then a point on the circle.',
  arc3: 'Click the start, the end, then a point the arc passes through.',
  carc: 'Click the center, the start (sets the radius), then the end.',
  tarc: 'Click the end of a line or arc, then where the arc should end.',
  point: 'Click to place a point.',
  slot: 'Click the center of one end, then the center of the other end, then move out and click to set the width.',
  polygon: 'Click the center, then the middle of a side (Inscribed circle) or a corner (Circumscribed circle). Sides and circle type are in the panel.',
  dimension: 'Click a line, circle or arc (or two items), move to place the dimension, click, then type the value.',
  trim: 'Click the piece of a curve to remove (between crossings).',
  extend: 'Click near the end of a line or arc to extend it to the next curve.',
  offset: 'Click a curve: its connected chain is offset. Move to choose the side, click to place.',
  fillet: 'Click a corner where two lines meet.',
};

export const COLORS = {
  under: '#1f5fd6', full: '#141a22', over: '#d32f2f', failed: '#d32f2f',
  hover: '#f2a100', selected: '#ff6a00', preview: '#0f9d58', guide: '#7b8794', dim: '#2b3440', driven: '#6b7686',
  axisX: '#d64545', axisY: '#2e9b4f', trim: '#e53935',
};

export interface Selection { entities: Set<string>; points: PointRef[]; constraints: Set<string> }

export interface DimLabel {
  id: string; text: string; at: P2; driven: boolean; expr: boolean; conflicting: boolean; selected: boolean;
}
export interface RelGlyph { id: string; glyph: string; title: string; at: P2; selected: boolean; bad: boolean }

export interface ModifyBox { id: string; value: string; at: P2; isNew: boolean }

interface DimDraft {
  picks: Pick[];
  c: SketchConstraint | null;
  measured: number;
  text: P2;
}
type Pick = { id: string; point?: PointRef };

export class SketchController {
  tool: ToolId = 'select';
  lastTool: ToolId = 'line';
  selection: Selection = { entities: new Set(), points: [], constraints: new Set() };
  hover: Pick | null = null;
  hoverConstraint: string | null = null;
  message = '';
  messageKind: 'info' | 'warn' | 'error' = 'info';
  showRelations = true;
  modify: ModifyBox | null = null;
  /** Offset / fillet inputs (expressions in document units). */
  offsetExpr = '0.1';
  filletExpr = '0.1';
  /** Polygon tool: number of sides (mainstream CAD default 6). */
  polygonSides = 6;
  /**
   * Polygon tool: mainstream CAD's "Inscribed circle" (circle inside, touching the
   * middle of every side; the first option in mainstream CAD's Polygon panel) or
   * "Circumscribed circle" (circle outside, through every corner).
   */
  polygonCircle: 'inscribed' | 'circumscribed' = 'inscribed';
  cursor: P2 = [0, 0];

  private clicks: { p: P2; snap: Snap }[] = [];
  private chainEnd: { ref: PointRef; p: P2; entity: string } | null = null;
  private arcNext = false;
  private snapNow: Snap = { p: [0, 0], kind: 'none', guides: [] };
  private relHint: 'horizontal' | 'vertical' | null = null;
  private ctrlHeld = false;
  private down: { x: number; y: number; p: P2; pick: Pick | null; button: number; shift: boolean; ctrl: boolean } | null = null;
  private drag: { base: WSketch; targets: (p: P2) => any[]; preview: WEntity[] | null } | null = null;
  private box: { a: P2; b: P2 } | null = null;
  private dimDraft: DimDraft | null = null;
  private carcSweep = 0;
  private carcLastAngle: number | null = null;
  private offsetChain: string[] | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private unbind: (() => void) | null = null;

  constructor(readonly session: SketchSession, readonly overlay: SketchOverlay, public frame: Frame) {
    overlay.setFrame(frame);
    overlay.onCameraChange = () => this.changed(false);
    this.bind();
    this.changed();
  }

  dispose() {
    this.unbind?.();
    this.overlay.draw({ lines: [], points: [] });
    this.overlay.setFrame(null);
    this.listeners.clear();
  }

  // ------------------------------------------------------------ react glue
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  /** Re-render the overlay and notify the panel. Call after document changes too. */
  changed(redrawOnly = false) {
    try { this.redraw(); } catch (e) { this.say((e as Error).message, 'error'); }
    void redrawOnly;
    this.version++;
    for (const l of this.listeners) l();
  }

  say(msg: string, kind: 'info' | 'warn' | 'error' = 'info') { this.message = msg; this.messageKind = kind; }

  get units() { return this.session.store.state.units; }
  get k() { return MM_PER[this.units]; }
  private tol() { return 10 * this.overlay.mmPerPixel(); }

  state() { return this.session.state(); }

  setTool(t: ToolId) {
    this.cancelTool();
    this.tool = t;
    if (t !== 'select') this.lastTool = t;
    this.say(TOOL_HINT[t]);
    if (t === 'offset' && this.selection.entities.size) {
      const ws = this.session.working();
      const first = [...this.selection.entities][0];
      this.offsetChain = this.selection.entities.size > 1 ? [...this.selection.entities] : connectedChain(ws, first);
    }
    this.changed();
  }

  /** Abort the in-progress click sequence of the current tool. */
  cancelTool() {
    this.clicks = []; this.chainEnd = null; this.arcNext = false; this.dimDraft = null; this.box = null; this.drag = null;
    this.carcSweep = 0; this.carcLastAngle = null; this.offsetChain = null; this.relHint = null;
  }

  // ------------------------------------------------------------ events
  private bind() {
    const el = this.overlay.canvas;
    const pd = (e: PointerEvent) => this.onDown(e);
    const pm = (e: PointerEvent) => this.onMove(e);
    const pu = (e: PointerEvent) => this.onUp(e);
    const dc = (e: MouseEvent) => this.onDouble(e);
    const kd = (e: KeyboardEvent) => this.onKey(e);
    const ku = (e: KeyboardEvent) => { if (e.key === 'Control') { this.ctrlHeld = false; } };
    el.addEventListener('pointerdown', pd);
    el.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', pu);
    el.addEventListener('dblclick', dc);
    window.addEventListener('keydown', kd, true);
    window.addEventListener('keyup', ku, true);
    this.unbind = () => {
      el.removeEventListener('pointerdown', pd); el.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu); el.removeEventListener('dblclick', dc);
      window.removeEventListener('keydown', kd, true); window.removeEventListener('keyup', ku, true);
    };
  }

  private sketchPos(e: MouseEvent): P2 | null { return this.overlay.toSketch(e.clientX, e.clientY); }

  private pickables(): WEntity[] {
    return this.state().solved;
  }

  private pickAt(p: P2): Pick | null {
    const ents = this.pickables();
    const hit = pickEntity(ents, p, this.tol() * 0.7);
    if (hit) return hit;
    if (dist(p, [0, 0]) <= this.tol() * 0.7) return { id: 'origin', point: { e: 'origin', p: 'point' } };
    if (this.tool === 'dimension') {
      const t = this.tol() * 0.5;
      if (Math.abs(p[1]) <= t) return { id: 'axisH' };
      if (Math.abs(p[0]) <= t) return { id: 'axisV' };
    }
    return null;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || e.altKey) return;
    if (this.modify) { this.modify = null; }
    const p = this.sketchPos(e);
    if (!p) return;
    this.overlay.canvas.setPointerCapture?.(e.pointerId);
    this.down = { x: e.clientX, y: e.clientY, p, pick: this.pickAt(p), button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    if (this.tool === 'select') {
      const pk = this.down.pick;
      if (pk && pk.id !== 'origin' && !this.down.ctrl && !this.down.shift) this.beginDrag(pk, p);
      else if (!pk) this.box = { a: p, b: p };
    }
    this.changed();
  }

  private onMove(e: PointerEvent) {
    const raw = this.sketchPos(e);
    if (!raw) return;
    this.ctrlHeld = e.ctrlKey || e.metaKey;
    this.cursor = raw;
    if (this.drag) {
      const prev = this.session.dragPreview(this.drag.base, this.drag.targets(raw));
      if (prev) this.drag.preview = prev;
      this.changed();
      return;
    }
    if (this.box) { this.box.b = raw; this.changed(); return; }
    this.hover = this.pickAt(raw);
    if (this.tool === 'select' || this.tool === 'trim' || this.tool === 'extend' || this.tool === 'offset' || this.tool === 'dimension') {
      // hover only
    } else {
      this.updateSnap(raw);
    }
    if (this.tool === 'carc' && this.clicks.length === 2) {
      const c = this.clicks[0].p;
      const a = Math.atan2(raw[1] - c[1], raw[0] - c[0]);
      if (this.carcLastAngle !== null) this.carcSweep += wrapSigned(a - this.carcLastAngle);
      this.carcLastAngle = a;
    }
    if (this.dimDraft) { this.dimDraft.text = raw; this.inferDimension(); }
    this.changed();
  }

  private updateSnap(raw: P2) {
    const off = this.ctrlHeld;
    const excludeRefs = this.chainEnd ? [this.chainEnd.ref] : [];
    let s = snap(this.pickables(), raw, { tol: this.tol(), off, excludeRefs });
    this.relHint = null;
    const from = this.lineFrom();
    if (from && s.kind === 'none' && (this.tool === 'line' || this.tool === 'centerline') && !this.arcNext) {
      const li = lineInference(from, s.p, this.tol() * 0.6, off);
      if (li.rel) { s = { ...s, p: li.p, guides: [] }; this.relHint = li.rel; }
    }
    this.snapNow = s;
  }

  private lineFrom(): P2 | null {
    if (this.tool !== 'line' && this.tool !== 'centerline') return null;
    if (this.chainEnd) return this.chainEnd.p;
    if (this.clicks.length === 1) return this.clicks[0].p;
    return null;
  }

  private onUp(e: PointerEvent) {
    if (e.button === 2) { this.onRightClick(e); return; }
    if (e.button !== 0 || !this.down) return;
    const d = this.down;
    this.down = null;
    const p = this.sketchPos(e) ?? d.p;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4;
    if (this.drag) { this.endDrag(moved); return; }
    if (this.box) { this.endBox(e.ctrlKey || e.shiftKey); return; }
    if (this.tool === 'select') { this.clickSelect(d.pick, d.ctrl || d.shift); this.changed(); return; }
    // Click-drag-release draws a single element in one stroke.
    if (moved && (this.tool === 'line' || this.tool === 'centerline' || this.tool === 'rect' || this.tool === 'crect' || this.tool === 'circle') && this.clicks.length === 1 && !this.chainEnd) {
      this.updateSnap(p);
      this.toolClick(p, true);
      return;
    }
    if (!moved) this.toolClick(p, false);
  }

  private onRightClick(_e: PointerEvent) {
    // Right-click ends a line chain (other right-button behaviour belongs to navigation presets).
    if (this.chainEnd || this.clicks.length) { this.cancelTool(); this.say('Chain finished.'); this.changed(); }
  }

  private onDouble(_e: MouseEvent) {
    if (this.tool === 'line' || this.tool === 'centerline') { this.cancelTool(); this.changed(); return; }
    if (this.tool === 'select' && this.hover) {
      // Double-click a curve: select its connected chain.
      const ws = this.session.working();
      const chain = connectedChain(ws, this.hover.id);
      for (const id of chain) this.selection.entities.add(id);
      this.changed();
    }
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && t.closest && t.closest('input, select, textarea')) return;
    // An open menu (right-click, S bar, Space, W search) owns Esc / Enter / arrows.
    if (document.querySelector('.popup')) return;
    if (e.key === 'Control') { this.ctrlHeld = true; return; }
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === 'escape') {
      consume();
      if (this.modify) { this.modify = null; }
      else if (this.tool !== 'select' && (this.clicks.length || this.chainEnd || this.dimDraft || this.offsetChain)) this.cancelTool();
      else if (this.tool !== 'select') this.setTool('select');
      else this.clearSelection();
      this.changed();
      return;
    }
    if (k === 'delete' || k === 'backspace') { consume(); this.deleteSelection(); return; }
    if (k === 'enter' && !ctrl) { consume(); if (this.tool === 'offset' && this.offsetChain) this.placeOffset(this.cursor); else this.setTool(this.lastTool); return; }
    if (ctrl) return;
    if (k === 'a' && (this.tool === 'line' || this.tool === 'centerline') && this.chainEnd) {
      consume(); this.arcNext = !this.arcNext; this.say(this.arcNext ? 'Next segment: tangent arc (A to switch back).' : 'Next segment: line.'); this.changed(); return;
    }
    const map: Record<string, ToolId> = { l: 'line', c: 'circle', a: 'arc3', r: 'rect', d: 'dimension', m: 'trim', x: 'extend', o: 'offset', p: 'point' };
    if (map[k] && !e.shiftKey && !e.altKey) { consume(); this.setTool(map[k]); return; }
    if (k === 'q' && !e.shiftKey) { consume(); this.toggleConstructionSel(); return; }
  }

  // ------------------------------------------------------------ select / drag
  clearSelection() { this.selection = { entities: new Set(), points: [], constraints: new Set() }; }

  private clickSelect(pk: Pick | null, additive: boolean) {
    if (!additive) this.clearSelection();
    if (!pk) return;
    const s = this.selection;
    if (pk.point && pk.id !== 'origin' && this.state().solved.find((e) => e.id === pk.id)?.kind !== 'point') {
      const i = s.points.findIndex((r) => sameRef(r, pk.point!));
      if (i >= 0) s.points.splice(i, 1); else s.points.push(pk.point);
    } else if (pk.id === 'origin') {
      const r: PointRef = { e: 'origin', p: 'point' };
      const i = s.points.findIndex((q) => sameRef(q, r));
      if (i >= 0) s.points.splice(i, 1); else s.points.push(r);
    } else {
      if (s.entities.has(pk.id)) s.entities.delete(pk.id); else s.entities.add(pk.id);
    }
  }

  selectConstraint(id: string, additive: boolean) {
    if (!additive) this.clearSelection();
    if (this.selection.constraints.has(id)) this.selection.constraints.delete(id); else this.selection.constraints.add(id);
    this.changed();
  }

  private beginDrag(pk: Pick, start: P2) {
    const base = this.session.working();
    const m = entityMap(base.entities);
    const e = m.get(pk.id);
    if (!e) return;
    let targets: (p: P2) => any[];
    if (pk.point) {
      const ref = pk.point;
      targets = (p) => [{ ref, to: p }];
    } else if (e.kind === 'line') {
      targets = (p) => { const d = sub(p, start); return [{ ref: { e: e.id, p: 'start' }, to: add(e.a, d) }, { ref: { e: e.id, p: 'end' }, to: add(e.b, d) }]; };
    } else if (e.kind === 'circle' || e.kind === 'arc') {
      targets = (p) => [{ radiusOf: e.id, to: Math.max(1e-6, dist(p, e.c)) }];
    } else if (e.kind === 'point') {
      targets = (p) => [{ ref: { e: e.id, p: 'point' }, to: p }];
    } else return;
    this.drag = { base, targets, preview: null };
  }

  private endDrag(moved: boolean) {
    const d = this.drag!;
    this.drag = null;
    if (!moved || !d.preview) { if (!moved) this.clickSelect(this.down?.pick ?? this.hover, false); this.changed(); return; }
    const r = this.session.commitDrag(d.base, d.preview);
    if (!r.ok) this.say(r.message ?? 'Could not move that', 'warn');
    this.changed();
  }

  private endBox(additive: boolean) {
    const b = this.box!;
    this.box = null;
    if (!additive) this.clearSelection();
    const lo: P2 = [Math.min(b.a[0], b.b[0]), Math.min(b.a[1], b.b[1])], hi: P2 = [Math.max(b.a[0], b.b[0]), Math.max(b.a[1], b.b[1])];
    if (dist(lo, hi) < this.tol() * 0.3) { this.changed(); return; }
    const crossing = b.b[0] < b.a[0]; // right-to-left drag selects anything touched
    const inside = (p: P2) => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1];
    for (const e of this.state().solved) {
      const pts = samplePolyline(e, 64);
      if (crossing ? pts.some(inside) || boxCrosses(e, lo, hi) : pts.every(inside)) this.selection.entities.add(e.id);
    }
    this.changed();
  }

  deleteSelection() {
    const s = this.selection;
    if (!s.entities.size && !s.constraints.size && !s.points.length) return;
    const ws = this.session.working();
    // Deleting a point marker deletes a sketch point entity; endpoints of curves cannot be deleted alone.
    const pointEnts = s.points.filter((r) => ws.entities.find((e) => e.id === r.e)?.kind === 'point').map((r) => r.e);
    const edit = deleteItems(ws, [...s.entities, ...pointEnts], s.constraints);
    const r = this.session.apply('Delete', edit, { allowUnsolved: true });
    if (!r.ok) this.say(r.message ?? 'Delete failed', 'error');
    this.clearSelection();
    this.changed();
  }

  toggleConstructionSel() {
    if (!this.selection.entities.size) { this.say('Select sketch entities first, then toggle construction (Q).', 'warn'); this.changed(); return; }
    const r = this.session.apply('Toggle construction', toggleConstruction(this.session.working(), this.selection.entities));
    if (!r.ok) this.say(r.message ?? 'Failed', 'error');
    this.changed();
  }

  // ------------------------------------------------------------ drawing tools
  private construction() { return this.tool === 'centerline'; }

  private toolClick(raw: P2, strokeEnd: boolean) {
    if (this.tool === 'dimension') { this.dimensionClick(raw); return; }
    if (this.tool === 'trim' || this.tool === 'extend') { this.trimExtendClick(raw); return; }
    if (this.tool === 'offset') { this.offsetClick(raw); return; }
    if (this.tool === 'fillet') { this.filletClick(raw); return; }
    if (!strokeEnd) this.updateSnap(raw);
    const s = this.snapNow;
    const p = s.p;
    const cons = this.construction();
    switch (this.tool) {
      case 'point': {
        const b = buildPoint(p);
        this.commitBuilt('Add point', b, [[b.picks[0], s]]);
        return;
      }
      case 'line': case 'centerline': {
        if (this.arcNext && this.chainEnd) { this.placeTangentArc(p, s); return; }
        const from = this.chainEnd ?? (this.clicks[0] ? { p: this.clicks[0].p, ref: null as PointRef | null, entity: '' } : null);
        if (!from) { this.clicks = [{ p, snap: s }]; this.changed(); return; }
        if (dist(from.p, p) < 1e-6) return;
        const b = buildLine(from.p, p, cons);
        const lineId = b.entities[0].id;
        const extra: SketchConstraint[] = [];
        if (this.relHint && !this.ctrlHeld) extra.push({ id: newId('cn'), type: this.relHint, e: lineId });
        if (this.chainEnd) extra.push({ id: newId('cn'), type: 'coincident', a: this.chainEnd.ref, b: b.picks[0] });
        const startSnap = this.chainEnd ? null : this.clicks[0].snap;
        const ok = this.commitBuilt('Add line', b, [[b.picks[0], startSnap], [b.picks[1], s]], extra);
        if (!ok) return;
        const closes = !!s.ref && !this.ctrlHeld;
        this.clicks = [];
        this.chainEnd = closes || strokeEnd ? null : { ref: b.picks[1], p, entity: lineId };
        this.changed();
        return;
      }
      case 'rect': case 'crect': case 'circle': {
        if (!this.clicks.length) { this.clicks = [{ p, snap: s }]; this.changed(); return; }
        const a = this.clicks[0];
        if (dist(a.p, p) < 1e-6) return;
        if (this.tool === 'circle') {
          const b = buildCircle(a.p, p);
          const extra: SketchConstraint[] = s.ref ? [{ id: newId('cn'), type: 'pointOn', p: s.ref, on: b.entities[0].id }] : [];
          this.commitBuilt('Add circle', b, [[b.picks[0], a.snap]], extra);
        } else {
          const b = this.tool === 'rect' ? buildCornerRect(a.p, p) : buildCenterRect(a.p, p);
          this.commitBuilt('Add rectangle', b, [[b.picks[0], a.snap], [b.picks[1], s]]);
        }
        this.clicks = [];
        this.changed();
        return;
      }
      case 'slot': {
        if (this.clicks.length < 2) { if (this.clicks.length === 1 && dist(this.clicks[0].p, p) < 1e-6) return; this.clicks.push({ p, snap: s }); this.changed(); return; }
        const b = buildSlot(this.clicks[0].p, this.clicks[1].p, this.slotHalfWidth(p), cons);
        if (!b) { this.say('Move away from the slot centerline to give it a width.', 'warn'); this.changed(); return; }
        this.commitBuilt('Add slot', b, [[b.picks[0], this.clicks[0].snap], [b.picks[1], this.clicks[1].snap]]);
        this.clicks = [];
        this.changed();
        return;
      }
      case 'polygon': {
        if (!this.clicks.length) { this.clicks = [{ p, snap: s }]; this.changed(); return; }
        const b = buildPolygon(this.clicks[0].p, p, this.polygonSides, cons, this.polygonCircle);
        if (!b) { this.say('Click away from the center (3 to 40 sides).', 'warn'); this.changed(); return; }
        this.commitBuilt('Add polygon', b, b.picks[1] ? [[b.picks[0], this.clicks[0].snap], [b.picks[1], s]] : [[b.picks[0], this.clicks[0].snap]]);
        this.clicks = [];
        this.changed();
        return;
      }
      case 'arc3': {
        if (this.clicks.length < 2) { if (this.clicks.length === 1 && dist(this.clicks[0].p, p) < 1e-6) return; this.clicks.push({ p, snap: s }); this.changed(); return; }
        const b = buildArc3(this.clicks[0].p, this.clicks[1].p, p);
        if (!b) { this.say('The three points are in a line; pick a point off the line.', 'warn'); this.changed(); return; }
        const extra: SketchConstraint[] = s.ref ? [{ id: newId('cn'), type: 'pointOn', p: s.ref, on: b.entities[0].id }] : [];
        this.commitBuilt('Add arc', b, [[b.picks[0], this.clicks[0].snap], [b.picks[1], this.clicks[1].snap]], extra);
        this.clicks = [];
        this.changed();
        return;
      }
      case 'carc': {
        if (this.clicks.length < 2) { this.clicks.push({ p, snap: s }); this.carcSweep = 0; this.carcLastAngle = null; this.changed(); return; }
        const b = buildCenterArc(this.clicks[0].p, this.clicks[1].p, p, this.carcSweep >= 0);
        if (!b) return;
        const extra: SketchConstraint[] = s.ref ? [{ id: newId('cn'), type: 'pointOn', p: s.ref, on: b.entities[0].id }] : [];
        this.commitBuilt('Add arc', b, [[b.picks[0], this.clicks[0].snap], [b.picks[1], this.clicks[1].snap]], extra);
        this.clicks = [];
        this.changed();
        return;
      }
      case 'tarc': {
        if (!this.chainEnd) {
          const r = s.ref;
          const ent = r ? this.state().solved.find((e) => e.id === r.e) : undefined;
          if (!r || !ent || (ent.kind !== 'line' && ent.kind !== 'arc') || (r.p !== 'start' && r.p !== 'end')) {
            this.say('Start a tangent arc on the end of a line or arc.', 'warn'); this.changed(); return;
          }
          this.chainEnd = { ref: r, p: pointOf(ent, r.p), entity: ent.id };
          this.changed();
          return;
        }
        this.placeTangentArc(p, s);
        return;
      }
      default: return;
    }
  }

  private placeTangentArc(p: P2, s: Snap) {
    const ce = this.chainEnd!;
    const ent = this.state().solved.find((e) => e.id === ce.entity);
    if (!ent) { this.cancelTool(); return; }
    const t = exitDirection(ent, ce.ref.p as 'start' | 'end');
    if (!t) return;
    const b = buildTangentArc(ce.ref, ce.p, t, p, ce.entity, this.construction());
    if (!b) { this.say('That point is straight ahead; use a line there.', 'warn'); this.changed(); return; }
    const ok = this.commitBuilt('Add tangent arc', b, [[b.picks[1], s]]);
    if (!ok) return;
    const arc = b.entities[0];
    this.chainEnd = s.ref ? null : { ref: b.picks[1], p: pointOf(arc, b.picks[1].p), entity: arc.id };
    this.arcNext = false;
    if (this.tool === 'tarc') this.chainEnd = null;
    this.changed();
  }

  /** Slot half width: distance from the cursor to the line through the two centers. */
  private slotHalfWidth(p: P2): number {
    const [a, b] = [this.clicks[0].p, this.clicks[1].p];
    return Math.abs(cross(sub(p, a), norm(sub(b, a))));
  }

  /** Commit built geometry plus relations from snaps; drops inferred relations if they clash. */
  private commitBuilt(label: string, b: Built, snaps: [PointRef, Snap | null][], extra: SketchConstraint[] = []): boolean {
    const inferred = this.ctrlHeld ? [] : snaps.flatMap(([ref, s]) => (s ? snapRelations(ref, s) : []));
    const r = this.session.addGeometry(label, b.entities, [...b.constraints, ...extra, ...inferred]);
    if (!r.ok) { this.say(r.message ?? 'Could not add that', 'error'); this.changed(); return false; }
    this.say(TOOL_HINT[this.tool]);
    return true;
  }

  // ------------------------------------------------------------ trim / extend / offset / fillet
  private trimExtendClick(p: P2) {
    const pk = pickEntity(this.state().solved, p, this.tol() * 0.7);
    if (!pk) return;
    try {
      const ws = this.session.working();
      const edit = this.tool === 'trim' ? trim(ws, pk.id, p) : extend(ws, pk.id, p);
      const r = this.session.apply(this.tool === 'trim' ? 'Trim' : 'Extend', edit, { allowUnsolved: false });
      if (!r.ok) this.say(r.message ?? 'Failed', 'error');
    } catch (e) { this.say((e as Error).message, e instanceof SketchOpError ? 'warn' : 'error'); }
    this.changed();
  }

  private offsetMM(): number { return this.session.evalValue({ type: 'offset' } as any, this.offsetExpr); }

  private offsetClick(p: P2) {
    if (!this.offsetChain) {
      const pk = pickEntity(this.state().solved, p, this.tol() * 0.7);
      if (!pk) return;
      this.offsetChain = connectedChain(this.session.working(), pk.id);
      this.say('Move to the side to offset toward, then click (or press Enter). Change the distance in the panel.');
      this.changed();
      return;
    }
    this.placeOffset(p);
  }

  placeOffset(p: P2) {
    if (!this.offsetChain) return;
    try {
      const ws = this.session.working();
      const edit = offset(ws, this.offsetChain, this.offsetMM(), p, this.offsetExpr);
      const r = this.session.apply('Offset entities', edit);
      if (!r.ok) this.say(r.message ?? 'Failed', 'error'); else this.offsetChain = null;
    } catch (e) { this.say((e as Error).message, 'warn'); }
    this.changed();
  }

  private filletClick(p: P2) {
    const ws = this.session.working();
    const corner = nearestCorner(ws, p);
    if (!corner || dist(corner, p) > this.tol()) { this.say('Click on a corner where two lines meet.', 'warn'); this.changed(); return; }
    try {
      const rmm = this.session.evalValue({ type: 'radius' } as any, this.filletExpr);
      const edit = fillet(ws, corner, rmm, this.filletExpr, 1e-6);
      const r = this.session.apply('Sketch fillet', edit);
      if (!r.ok) this.say(r.message ?? 'Failed', 'error');
    } catch (e) { this.say((e as Error).message, 'warn'); }
    this.changed();
  }

  // ------------------------------------------------------------ dimension tool
  private dimensionClick(p: P2) {
    const pk = this.pickAt(p);
    if (!this.dimDraft) {
      if (!pk) return;
      this.dimDraft = { picks: [pk], c: null, measured: NaN, text: p };
      this.inferDimension();
      this.changed();
      return;
    }
    const d = this.dimDraft;
    const already = d.picks.some((q) => q.id === pk?.id && (q.point ? pk?.point && sameRef(q.point, pk.point) : !pk?.point));
    if (pk && !already && d.picks.length < 2) {
      d.picks.push(pk);
      this.inferDimension();
      if (!d.c) { this.say('Those two items cannot be dimensioned together.', 'warn'); d.picks.pop(); this.inferDimension(); }
      this.changed();
      return;
    }
    if (!d.c) return;
    this.placeDimension();
  }

  /** Decide which dimension the picked items (and cursor position) describe. */
  private inferDimension() {
    const d = this.dimDraft!;
    const m = entityMap(this.state().solved);
    const ent = (id: string) => m.get(id)!;
    const ptOf = (pk: Pick): PointRef | null => {
      if (pk.point) return pk.point;
      const e = ent(pk.id);
      if (e?.kind === 'point') return { e: e.id, p: 'point' };
      if (e && (e.kind === 'circle' || e.kind === 'arc')) return { e: e.id, p: 'center' };
      return null;
    };
    const cursor = d.text;
    const id = newId('dim');
    const twoPoints = (a: PointRef, b: PointRef): void => {
      const pa = pointOf(ent(a.e), a.p), pb = pointOf(ent(b.e), b.p);
      const lo: P2 = [Math.min(pa[0], pb[0]), Math.min(pa[1], pb[1])], hi: P2 = [Math.max(pa[0], pb[0]), Math.max(pa[1], pb[1])];
      let dir: 'h' | 'v' | undefined;
      const outX = cursor[0] < lo[0] || cursor[0] > hi[0], outY = cursor[1] < lo[1] || cursor[1] > hi[1];
      if (outY && !outX) dir = 'h'; else if (outX && !outY) dir = 'v';
      if (Math.abs(pa[1] - pb[1]) < 1e-9) dir = 'h';
      if (Math.abs(pa[0] - pb[0]) < 1e-9) dir = 'v';
      const measured = dir === 'h' ? Math.abs(pb[0] - pa[0]) : dir === 'v' ? Math.abs(pb[1] - pa[1]) : dist(pa, pb);
      d.c = { id, type: 'distance', a, b, ...(dir ? { dir } : {}), value: 0 };
      d.measured = measured;
    };
    d.c = null;
    const [p1, p2] = d.picks;
    const e1 = ent(p1.id);
    if (!e1) return;
    if (!p2) {
      if (p1.point || e1.kind === 'point') return; // a single point needs a second pick
      if (e1.kind === 'line') { twoPoints({ e: e1.id, p: 'start' }, { e: e1.id, p: 'end' }); return; }
      if (e1.kind === 'circle') { d.c = { id, type: 'diameter', e: e1.id, value: 0 }; d.measured = 2 * e1.r; return; }
      if (e1.kind === 'arc') { d.c = { id, type: 'radius', e: e1.id, value: 0 }; d.measured = e1.r; return; }
      return;
    }
    const e2 = ent(p2.id);
    if (!e2) return;
    const isLine = (pk: Pick, e: WEntity) => !pk.point && e.kind === 'line';
    if (isLine(p1, e1) && isLine(p2, e2)) {
      const l1 = e1 as Extract<WEntity, { kind: 'line' }>, l2 = e2 as Extract<WEntity, { kind: 'line' }>;
      const da = sub(l1.b, l1.a), db = sub(l2.b, l2.a);
      if (Math.abs(cross(norm(da), norm(db))) < 1e-7) {
        if (isAxis(l1.id) && isAxis(l2.id)) return;
        const [pl, ln] = isAxis(l1.id) ? [l2, l1] : [l1, l2];
        d.c = { id, type: 'pointLineDistance', p: { e: pl.id, p: 'start' }, line: ln.id, value: 0 };
        d.measured = Math.abs(cross(sub(pl.a, ln.a), norm(sub(ln.b, ln.a))));
        return;
      }
      // Angle: which of the four angles depends on where the cursor is.
      const V = curveIntersections(l1, l2)[0];
      const w = sub(cursor, V);
      let best: { sa: number; sb: number; v: number } | null = null;
      for (const sa of [1, -1]) for (const sb of [1, -1]) {
        const ra = mul(norm(da), sa), rb = mul(norm(db), sb);
        const v = Math.acos(Math.max(-1, Math.min(1, dot(ra, rb))));
        // cursor inside the wedge between ra and rb?
        const inside = cross(ra, w) * cross(ra, rb) >= 0 && cross(rb, w) * cross(rb, ra) >= 0;
        if (inside && (!best || v < best.v)) best = { sa, sb, v };
      }
      if (!best) best = { sa: 1, sb: 1, v: Math.acos(Math.max(-1, Math.min(1, dot(norm(da), norm(db))))) };
      const theta = Math.atan2(cross(da, db), dot(da, db));
      const sense: 1 | -1 = theta >= 0 ? 1 : -1;
      const supplement = best.sa * best.sb < 0;
      d.c = { id, type: 'angle', a: l1.id, b: l2.id, value: 0, sense, ...(supplement ? { supplement: true } : {}) };
      d.measured = best.v;
      return;
    }
    // point (or center) with a line
    const lineOf = (pk: Pick, e: WEntity) => (isLine(pk, e) ? e : null);
    const L = lineOf(p1, e1) ?? lineOf(p2, e2);
    if (L) {
      const other = L === e1 ? p2 : p1;
      const pr = ptOf(other);
      if (!pr) return;
      const pp = pointOf(ent(pr.e), pr.p);
      const l = L as Extract<WEntity, { kind: 'line' }>;
      d.c = { id, type: 'pointLineDistance', p: pr, line: l.id, value: 0 };
      d.measured = Math.abs(cross(sub(pp, l.a), norm(sub(l.b, l.a))));
      return;
    }
    const a = ptOf(p1), b = ptOf(p2);
    if (a && b && !sameRef(a, b)) twoPoints(a, b);
  }

  private placeDimension() {
    const d = this.dimDraft!;
    const c = d.c!;
    const v = c.type === 'angle' ? (d.measured * 180) / Math.PI : d.measured / this.k;
    const anchor = this.dimAnchor(c, this.state().solved);
    const text: [number, number] = anchor ? [(d.text[0] - anchor[0]) / this.k, (d.text[1] - anchor[1]) / this.k] : [0, 0];
    const dim = { ...c, value: v, text } as SketchDimension;
    const r = this.session.addDimension(dim);
    this.dimDraft = null;
    if (!r.ok) { this.say(r.message ?? 'Could not add the dimension', 'error'); this.changed(); return; }
    if (r.madeDriven) this.say(r.message!, 'warn'); else this.say(TOOL_HINT.dimension);
    if (!r.madeDriven) this.modify = { id: c.id, value: formatValue(v, c.type === 'angle' ? 'deg' : this.units), at: d.text, isNew: true };
    this.changed();
  }

  openModify(id: string) {
    const c = this.state().ws.constraints.find((x) => x.id === id);
    if (!c || !isDimension(c)) return;
    const at = this.dimTextPos(c, this.state().solved);
    if (!at) return;
    this.modify = { id, value: String(c.value), at, isNew: false };
    this.changed();
  }

  /** Apply the Modify box. Returns an error message or null. */
  applyModify(value: string): string | null {
    if (!this.modify) return null;
    const r = this.session.setDimension(this.modify.id, value.trim());
    if (!r.ok) return r.message ?? 'Invalid value';
    this.modify = null;
    this.changed();
    return null;
  }

  // ------------------------------------------------------------ relations
  /** Relations that apply to the current selection, for the panel. */
  applicableRelations(): { type: string; label: string; make: () => SketchConstraint }[] {
    const s = this.selection;
    const m = entityMap(this.state().solved);
    const ents = [...s.entities].map((id) => m.get(id)!).filter(Boolean);
    const pts = [...s.points, ...ents.filter((e) => e.kind === 'point').map((e) => ({ e: e.id, p: 'point' as const }))];
    const curves = ents.filter((e) => e.kind !== 'point');
    const lines = curves.filter((e) => e.kind === 'line');
    const rounds = curves.filter((e) => e.kind === 'circle' || e.kind === 'arc');
    const id = () => newId('cn');
    const out: { type: string; label: string; make: () => SketchConstraint }[] = [];
    const n = curves.length, np = pts.length;
    if (n === 1 && np === 0 && lines.length === 1) {
      out.push({ type: 'horizontal', label: 'Horizontal', make: () => ({ id: id(), type: 'horizontal', e: lines[0].id }) });
      out.push({ type: 'vertical', label: 'Vertical', make: () => ({ id: id(), type: 'vertical', e: lines[0].id }) });
    }
    if (n === 2 && np === 0 && lines.length === 2) {
      const [a, b] = lines.map((e) => e.id);
      out.push(
        { type: 'parallel', label: 'Parallel', make: () => ({ id: id(), type: 'parallel', a, b }) },
        { type: 'perpendicular', label: 'Perpendicular', make: () => ({ id: id(), type: 'perpendicular', a, b }) },
        { type: 'collinear', label: 'Collinear', make: () => ({ id: id(), type: 'collinear', a, b }) },
        { type: 'equal', label: 'Equal', make: () => ({ id: id(), type: 'equal', a, b }) },
      );
    }
    if (n === 2 && np === 0 && lines.length === 1 && rounds.length === 1) {
      out.push({ type: 'tangent', label: 'Tangent', make: () => ({ id: id(), type: 'tangent', a: lines[0].id, b: rounds[0].id }) });
    }
    if (n === 2 && np === 0 && rounds.length === 2) {
      const [a, b] = rounds as Extract<WEntity, { kind: 'circle' | 'arc' }>[];
      const dd = dist(a.c, b.c);
      const internal = Math.abs(dd - Math.abs(a.r - b.r)) < Math.abs(dd - (a.r + b.r));
      out.push(
        { type: 'equal', label: 'Equal', make: () => ({ id: id(), type: 'equal', a: a.id, b: b.id }) },
        { type: 'concentric', label: 'Concentric', make: () => ({ id: id(), type: 'concentric', a: a.id, b: b.id }) },
        { type: 'tangent', label: 'Tangent', make: () => ({ id: id(), type: 'tangent', a: a.id, b: b.id, ...(internal ? { internal: true } : {}) }) },
      );
    }
    if (np === 2 && n === 0) {
      const [a, b] = pts;
      out.push(
        { type: 'coincident', label: 'Coincident', make: () => ({ id: id(), type: 'coincident', a, b }) },
        { type: 'horizontalPoints', label: 'Horizontal', make: () => ({ id: id(), type: 'horizontalPoints', a, b }) },
        { type: 'verticalPoints', label: 'Vertical', make: () => ({ id: id(), type: 'verticalPoints', a, b }) },
      );
    }
    if (np === 1 && n === 1) {
      const p = pts[0], c = curves[0];
      out.push({ type: 'pointOn', label: 'Coincident (on curve)', make: () => ({ id: id(), type: 'pointOn', p, on: c.id }) });
      if (c.kind === 'line') out.push({ type: 'midpoint', label: 'Midpoint', make: () => ({ id: id(), type: 'midpoint', p, line: c.id }) });
      if (c.kind === 'circle' || c.kind === 'arc') out.push({ type: 'coincident', label: 'Concentric (at center)', make: () => ({ id: id(), type: 'coincident', a: p, b: { e: c.id, p: 'center' } }) });
    }
    if (np === 2 && n === 1 && lines.length === 1) {
      out.push({ type: 'symmetric', label: 'Symmetric', make: () => ({ id: id(), type: 'symmetric', a: pts[0], b: pts[1], line: lines[0].id }) });
    }
    if (ents.length >= 1 && np === s.points.length && s.points.length === 0) {
      out.push({ type: 'fix', label: 'Fix', make: () => ({ id: id(), type: 'fix', e: ents[0].id }) });
    }
    // Endpoints of the same line count as a line selection for horizontal/vertical
    return out.filter((r) => !(r.type === 'fix' && ents.length !== 1));
  }

  addRelation(make: () => SketchConstraint) {
    const c = make();
    const r = this.session.addRelation(c, `Add ${c.type} relation`);
    if (!r.ok) this.say(r.message ?? 'Could not add the relation', 'error'); else this.say('Relation added.');
    this.changed();
  }

  /** Constraints that involve the selected items, for the "Existing relations" list. */
  selectedConstraints(): SketchConstraint[] {
    const s = this.selection;
    const ws = this.state().ws;
    if (!s.entities.size && !s.points.length) return ws.constraints.filter((c) => s.constraints.has(c.id));
    return ws.constraints.filter((c) => s.constraints.has(c.id) || constraintRefs(c).some((r) => s.entities.has(r))
      || constraintPointRefs(c).some((r) => s.points.some((q) => sameRef(q, r))));
  }

  deleteConstraint(id: string) {
    const ws = this.session.working();
    const r = this.session.apply('Delete relation', { entities: ws.entities, constraints: ws.constraints.filter((c) => c.id !== id) }, { allowUnsolved: true });
    if (!r.ok) this.say(r.message ?? 'Failed', 'error');
    this.selection.constraints.delete(id);
    this.changed();
  }

  // ------------------------------------------------------------ annotations
  dimAnchor(c: SketchConstraint, ents: WEntity[]): P2 | null {
    const m = entityMap(ents);
    const P = (r: PointRef) => { const e = m.get(r.e); return e ? pointOf(e, r.p) : null; };
    try {
      switch (c.type) {
        case 'distance': { const a = P(c.a), b = P(c.b); return a && b ? lerp(a, b, 0.5) : null; }
        case 'pointLineDistance': {
          const p = P(c.p), l = m.get(c.line) as any; if (!p || !l) return null;
          const u = norm(sub(l.b, l.a)); const foot = add(l.a, mul(u, dot(sub(p, l.a), u)));
          return lerp(p, foot, 0.5);
        }
        case 'radius': case 'diameter': { const e = m.get(c.e) as any; return e ? e.c : null; }
        case 'angle': { const a = m.get(c.a), b = m.get(c.b); if (!a || !b) return null; return curveIntersections(a, b)[0] ?? (a as any).a; }
        case 'offset': {
          const pr = c.pairs[0]; const s = m.get(pr.src), d = m.get(pr.dst); if (!s || !d) return null;
          const ps = s.kind === 'line' ? lerp(s.a, s.b, 0.5) : pointOf(s, s.kind === 'circle' ? 'center' : 'start');
          const pd = d.kind === 'line' ? lerp(d.a, d.b, 0.5) : pointOf(d, d.kind === 'circle' ? 'center' : 'start');
          return lerp(ps, pd, 0.5);
        }
        default: return null;
      }
    } catch { return null; }
  }

  dimTextPos(c: SketchConstraint, ents: WEntity[]): P2 | null {
    const a = this.dimAnchor(c, ents);
    if (!a || !isDimension(c)) return a;
    lastMmPerPx = this.overlay.mmPerPixel();
    const t = c.text ?? defaultTextOffset(c, ents, this.overlay.mmPerPixel() / this.k);
    return [a[0] + t[0] * this.k, a[1] + t[1] * this.k];
  }

  /** Dimension labels to show (positions in sketch mm). */
  dimLabels(): DimLabel[] {
    const st = this.state();
    const ents = this.drag?.preview ?? st.solved;
    const bad = new Set([...st.conflicting, ...st.redundant]);
    const out: DimLabel[] = [];
    for (const c of st.ws.constraints) {
      if (!isDimension(c)) continue;
      const at = this.dimTextPos(c, ents);
      if (!at) continue;
      const measured = measure(c, ents);
      const shown = c.driven ? measured : st.ws.values.get(c.id) ?? measured;
      const unit = c.type === 'angle' ? 'deg' : this.units;
      const v = c.type === 'angle' ? (shown * 180) / Math.PI : shown / this.k;
      let text = formatValue(v, unit);
      if (c.type === 'diameter') text = `Ø${text}`;
      if (c.type === 'radius') text = `R${text}`;
      if (c.type === 'angle') text = `${text}°`;
      if (c.driven) text = `(${text})`;
      out.push({ id: c.id, text, at, driven: !!c.driven, expr: typeof c.value === 'string' && !/^\s*[-+]?[\d.]+\s*$/.test(c.value), conflicting: bad.has(c.id), selected: this.selection.constraints.has(c.id) });
    }
    if (this.dimDraft?.c) {
      const d = this.dimDraft;
      const c = d.c!;
      const unit = c.type === 'angle' ? 'deg' : this.units;
      const v = c.type === 'angle' ? (d.measured * 180) / Math.PI : d.measured / this.k;
      out.push({ id: '__draft', text: (c.type === 'diameter' ? 'Ø' : c.type === 'radius' ? 'R' : '') + formatValue(v, unit) + (c.type === 'angle' ? '°' : ''), at: d.text, driven: false, expr: false, conflicting: false, selected: true });
    }
    return out;
  }

  /** Relation glyphs next to the geometry they constrain. */
  relationGlyphs(): RelGlyph[] {
    if (!this.showRelations) return [];
    const st = this.state();
    const m = entityMap(this.drag?.preview ?? st.solved);
    const bad = new Set([...st.conflicting, ...st.redundant]);
    const px = this.overlay.mmPerPixel();
    const counts = new Map<string, number>();
    const place = (key: string, p: P2, side: P2): P2 => {
      const n = counts.get(key) ?? 0; counts.set(key, n + 1);
      return add(p, mul(side, (14 + 16 * n) * px));
    };
    const mid = (id: string): { p: P2; side: P2 } | null => {
      const e = m.get(id);
      if (!e) return null;
      if (e.kind === 'line') { const d = norm(sub(e.b, e.a)); return { p: lerp(e.a, e.b, 0.5), side: perp(d) }; }
      if (e.kind === 'arc') { const a = e.a0 + arcSweep(e.a0, e.a1) / 2; return { p: polar(e.c, e.r, a), side: [Math.cos(a), Math.sin(a)] }; }
      if (e.kind === 'circle') return { p: polar(e.c, e.r, Math.PI / 4), side: norm([1, 1]) };
      if (e.kind === 'spline') return { p: e.pts[Math.floor(e.pts.length / 2)], side: [1, 1] };
      return { p: e.p, side: [1, 1] };
    };
    const out: RelGlyph[] = [];
    const G: Record<string, [string, string]> = {
      horizontal: ['H', 'Horizontal'], vertical: ['V', 'Vertical'], parallel: ['∥', 'Parallel'], perpendicular: ['⊥', 'Perpendicular'],
      collinear: ['⫽', 'Collinear'], equal: ['=', 'Equal'], concentric: ['◎', 'Concentric'], tangent: ['⌒', 'Tangent'],
      midpoint: ['M', 'Midpoint'], symmetric: ['⇋', 'Symmetric'], fix: ['⚓', 'Fixed'], pointOn: ['◦', 'Coincident (on curve)'],
      horizontalPoints: ['H', 'Horizontal (points)'], verticalPoints: ['V', 'Vertical (points)'], coincident: ['•', 'Coincident'],
    };
    for (const c of st.ws.constraints) {
      if (isDimension(c)) continue;
      const g = G[c.type];
      if (!g) continue;
      const selected = this.selection.constraints.has(c.id);
      // Coincident relations are implied by connected geometry; only show them when involved in the selection.
      if (c.type === 'coincident' && !selected && !constraintPointRefs(c).some((r) => this.selection.points.some((q) => sameRef(q, r))) && !bad.has(c.id)) continue;
      const refs = constraintRefs(c).filter((r) => !BUILTIN[r]);
      for (const r of c.type === 'coincident' || c.type === 'pointOn' || c.type === 'midpoint' || c.type === 'horizontalPoints' || c.type === 'verticalPoints' || c.type === 'symmetric' ? refs.slice(0, 1) : refs) {
        let at: P2 | null = null;
        if ('p' in c && typeof (c as any).p === 'object') {
          const pr = (c as any).p as PointRef; const e = m.get(pr.e); if (e) at = place(refKey(pr), pointOf(e, pr.p), [0.7, 0.7]);
        } else if (c.type === 'coincident' || c.type === 'horizontalPoints' || c.type === 'verticalPoints' || c.type === 'symmetric') {
          const pr = c.a; const e = m.get(pr.e); if (e) at = place(refKey(pr), pointOf(e, pr.p), [0.7, -0.7]);
        } else {
          const q = mid(r); if (q) at = place(r, q.p, q.side);
        }
        if (at) out.push({ id: c.id, glyph: g[0], title: g[1], at, selected, bad: bad.has(c.id) });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ drawing
  private redraw() {
    let st;
    try { st = this.state(); } catch { return; }
    const ents = this.drag?.preview ?? st.solved;
    const px = this.overlay.mmPerPixel();
    const lines: OverlayPolyline[] = [];
    const points: OverlayPoint[] = [];
    const bad = new Set<string>();
    for (const id of [...st.conflicting, ...st.redundant]) {
      const c = st.ws.constraints.find((x) => x.id === id);
      if (c) for (const r of constraintRefs(c)) bad.add(r);
    }
    const failed = st.status.state === 'failed' || st.status.state === 'over' && !bad.size;
    const def = st.analysis?.defined;
    const colorOf = (e: WEntity) => {
      if (this.selection.entities.has(e.id)) return COLORS.selected;
      if (this.hover && this.hover.id === e.id && !this.hover.point) return this.tool === 'trim' ? COLORS.trim : COLORS.hover;
      if (failed || bad.has(e.id)) return COLORS.over;
      return def?.has(e.id) ? COLORS.full : COLORS.under;
    };
    // origin axes
    lines.push({ pts: [[0, 0], [40 * px, 0]], color: COLORS.axisX, width: 2 });
    lines.push({ pts: [[0, 0], [0, 40 * px]], color: COLORS.axisY, width: 2 });
    points.push({ p: [0, 0], color: COLORS.axisX, size: 7 });
    for (const e of ents) {
      if (e.kind === 'point') continue;
      const sel = this.selection.entities.has(e.id) || (this.hover?.id === e.id && !this.hover.point);
      lines.push({ pts: samplePolyline(e, 128), color: colorOf(e), width: sel ? 3 : 2, dashed: e.construction });
    }
    // points: endpoints and centers
    const dp = st.analysis?.definedPoints;
    for (const e of ents) {
      const refs = e.kind === 'point' ? [{ e: e.id, p: 'point' as const }] : e.kind === 'line' ? [{ e: e.id, p: 'start' as const }, { e: e.id, p: 'end' as const }] : e.kind === 'circle' ? [{ e: e.id, p: 'center' as const }] : [{ e: e.id, p: 'center' as const }, { e: e.id, p: 'start' as const }, { e: e.id, p: 'end' as const }];
      for (const r of refs) {
        const p = pointOf(e, r.p);
        const selected = this.selection.points.some((q) => sameRef(q, r)) || (e.kind === 'point' && this.selection.entities.has(e.id));
        const hovered = this.hover?.point && sameRef(this.hover.point, r);
        const color = selected ? COLORS.selected : hovered ? COLORS.hover : failed || bad.has(e.id) ? COLORS.over : dp?.has(refKey(r)) ? COLORS.full : COLORS.under;
        points.push({ p, color, size: selected || hovered ? 8 : e.kind === 'point' ? 6 : 5 });
      }
    }
    // dimension graphics
    for (const c of st.ws.constraints) if (isDimension(c)) this.dimGraphics(c, ents, lines, st.conflicting.includes(c.id) ? COLORS.over : c.driven ? COLORS.driven : this.selection.constraints.has(c.id) ? COLORS.selected : COLORS.dim);
    if (this.dimDraft?.c) {
      const c = { ...this.dimDraft.c, value: 0 } as SketchDimension;
      const anchor = this.dimAnchor(c, ents);
      if (anchor) (c as any).text = [(this.dimDraft.text[0] - anchor[0]) / this.k, (this.dimDraft.text[1] - anchor[1]) / this.k];
      this.dimGraphics(c, ents, lines, COLORS.selected);
      for (const pk of this.dimDraft.picks) {
        const e = entityMap(ents).get(pk.id);
        if (e && e.kind !== 'point' && !pk.point) lines.push({ pts: samplePolyline(e, 128), color: COLORS.selected, width: 3 });
      }
    }
    // tool previews
    this.previewGraphics(ents, lines, points);
    // box selection
    if (this.box) {
      const { a, b } = this.box;
      lines.push({ pts: [a, [b[0], a[1]], b, [a[0], b[1]], a], color: b[0] < a[0] ? COLORS.preview : COLORS.selected, width: 1, dashed: b[0] < a[0] });
    }
    this.overlay.draw({ lines, points });
  }

  private previewGraphics(ents: WEntity[], lines: OverlayPolyline[], points: OverlayPoint[]) {
    const px = this.overlay.mmPerPixel();
    const s = this.snapNow;
    const drawTool = !['select', 'dimension', 'trim', 'extend', 'offset', 'fillet'].includes(this.tool);
    if (drawTool) {
      for (const g of s.guides) lines.push({ pts: [g.from, g.to], color: COLORS.guide, width: 1, dashed: true });
      if (s.kind !== 'none') points.push({ p: s.p, color: COLORS.hover, size: 10 });
      const pv = (e: WEntity | undefined) => { if (e) lines.push({ pts: samplePolyline(e, 128), color: COLORS.preview, width: 2, dashed: e.construction }); };
      const p = s.p;
      const c0 = this.clicks[0]?.p;
      const cons = this.construction();
      if ((this.tool === 'line' || this.tool === 'centerline') && (this.chainEnd || c0)) {
        if (this.arcNext && this.chainEnd) {
          const ent = ents.find((e) => e.id === this.chainEnd!.entity);
          const t = ent && exitDirection(ent, this.chainEnd.ref.p as any);
          if (t) pv(buildTangentArc(this.chainEnd.ref, this.chainEnd.p, t, p, this.chainEnd.entity)?.entities[0]);
        } else {
          const from = this.chainEnd?.p ?? c0!;
          pv(buildLine(from, p, cons).entities[0]);
          if (this.relHint) points.push({ p: add(p, [12 * px, 12 * px]), color: COLORS.guide, size: 1 });
        }
      }
      if (this.tool === 'tarc' && this.chainEnd) {
        const ent = ents.find((e) => e.id === this.chainEnd!.entity);
        const t = ent && exitDirection(ent, this.chainEnd.ref.p as any);
        if (t) pv(buildTangentArc(this.chainEnd.ref, this.chainEnd.p, t, p, this.chainEnd.entity)?.entities[0]);
      }
      if (c0 && (this.tool === 'rect' || this.tool === 'crect')) {
        const b = this.tool === 'rect' ? buildCornerRect(c0, p) : buildCenterRect(c0, p);
        b.entities.forEach(pv);
      }
      if (c0 && this.tool === 'circle') pv(buildCircle(c0, p).entities[0]);
      if (this.tool === 'slot') {
        if (this.clicks.length === 1) pv(buildLine(c0!, p, true).entities[0]);
        if (this.clicks.length === 2) buildSlot(c0!, this.clicks[1].p, this.slotHalfWidth(p), cons)?.entities.forEach(pv);
      }
      if (c0 && this.tool === 'polygon') buildPolygon(c0, p, this.polygonSides, cons, this.polygonCircle)?.entities.forEach(pv);
      if (this.tool === 'arc3') {
        if (this.clicks.length === 1) pv(buildLine(c0!, p, true).entities[0]);
        if (this.clicks.length === 2) pv(buildArc3(this.clicks[0].p, this.clicks[1].p, p)?.entities[0]);
      }
      if (this.tool === 'carc') {
        if (this.clicks.length === 1) pv(buildCircle(c0!, p, true).entities[0]);
        if (this.clicks.length === 2) pv(buildCenterArc(c0!, this.clicks[1].p, p, this.carcSweep >= 0)?.entities[0]);
      }
    }
    if (this.tool === 'offset' && this.offsetChain) {
      try {
        const ws = this.session.working();
        const edit = offset(ws, this.offsetChain, this.offsetMM(), this.cursor, this.offsetExpr);
        for (const e of edit.entities.slice(ws.entities.length)) lines.push({ pts: samplePolyline(e, 128), color: COLORS.preview, width: 2 });
        for (const id of this.offsetChain) { const e = ents.find((x) => x.id === id); if (e) lines.push({ pts: samplePolyline(e, 128), color: COLORS.selected, width: 3 }); }
      } catch { /* shown on click */ }
    }
    if (this.tool === 'fillet') {
      const corner = nearestCorner({ entities: ents, constraints: [], values: new Map() }, this.cursor);
      if (corner && dist(corner, this.cursor) <= this.tol()) points.push({ p: corner, color: COLORS.hover, size: 11 });
    }
  }

  /** Extension lines, dimension line and arrows for one dimension (sketch mm). */
  private dimGraphics(c: SketchDimension, ents: WEntity[], lines: OverlayPolyline[], color: string) {
    const m = entityMap(ents);
    const px = this.overlay.mmPerPixel();
    const at = this.dimTextPos(c, ents);
    if (!at) return;
    const arrow = (tip: P2, dir: P2) => {
      const d = norm(dir), n = perp(d), s = 9 * px, w = 3 * px;
      lines.push({ pts: [add(add(tip, mul(d, -s)), mul(n, w)), tip, add(add(tip, mul(d, -s)), mul(n, -w))], color, width: 1.5 });
    };
    const P = (r: PointRef) => { const e = m.get(r.e); return e ? pointOf(e, r.p) : null; };
    const gap = 4 * px, over = 6 * px;
    const linear = (a: P2, b: P2, dirv: P2) => {
      // dimension line parallel to dirv through the text position
      const u = norm(dirv), n = perp(u);
      const off = dot(sub(at, a), n);
      const a2 = add(a, mul(n, off)), b2 = add(b, mul(n, dot(sub(at, b), n)));
      const ext = (p: P2, q: P2) => { const d = sub(q, p); const L = len(d); if (L > gap) lines.push({ pts: [add(p, mul(norm(d), gap)), add(q, mul(norm(d), over))], color, width: 1 }); };
      ext(a, a2); ext(b, b2);
      lines.push({ pts: [a2, b2], color, width: 1 });
      const t = dot(sub(at, a2), u), L = dot(sub(b2, a2), u);
      if (t < 0) lines.push({ pts: [a2, at], color, width: 1 });
      if (t > L) lines.push({ pts: [b2, at], color, width: 1 });
      if (Math.abs(L) > 1e-12) { arrow(a2, mul(u, -Math.sign(L))); arrow(b2, mul(u, Math.sign(L))); }
    };
    switch (c.type) {
      case 'distance': {
        const a = P(c.a), b = P(c.b);
        if (!a || !b) return;
        const dirv: P2 = c.dir === 'h' ? [1, 0] : c.dir === 'v' ? [0, 1] : dist(a, b) > 1e-12 ? sub(b, a) : [1, 0];
        linear(a, b, dirv);
        return;
      }
      case 'pointLineDistance': {
        const p = P(c.p), l = m.get(c.line) as any;
        if (!p || !l) return;
        const u = norm(sub(l.b, l.a));
        const foot = add(l.a, mul(u, dot(sub(p, l.a), u)));
        if (dist(p, foot) < 1e-12) return;
        linear(p, foot, sub(foot, p));
        // extend the line to the foot if the foot is off the segment
        lines.push({ pts: [foot, dist(foot, l.a) < dist(foot, l.b) ? l.a : l.b], color, width: 1, dashed: true });
        return;
      }
      case 'radius': case 'diameter': {
        const e = m.get(c.e) as any;
        if (!e) return;
        const d = norm(sub(at, e.c));
        const rim = add(e.c, mul(d, e.r));
        if (c.type === 'radius') { lines.push({ pts: [e.c, at], color, width: 1 }); arrow(rim, d); }
        else { const rim2 = add(e.c, mul(d, -e.r)); lines.push({ pts: [rim2, at], color, width: 1 }); arrow(rim, d); arrow(rim2, mul(d, -1)); }
        return;
      }
      case 'angle': {
        const a = m.get(c.a) as any, b = m.get(c.b) as any;
        if (!a || !b) return;
        const V = curveIntersections(a, b)[0];
        if (!V) return;
        const r = Math.max(dist(at, V), 10 * px);
        const da = norm(sub(a.b, a.a)), db = norm(sub(b.b, b.a));
        // choose rays bracketing the text
        const w = sub(at, V);
        let best: [P2, P2] | null = null;
        for (const sa of [1, -1]) for (const sb of [1, -1]) {
          const ra = mul(da, sa), rb = mul(db, sb);
          if (cross(ra, w) * cross(ra, rb) >= 0 && cross(rb, w) * cross(rb, ra) >= 0) { if (!best || dot(ra, rb) > dot(best[0], best[1])) best = [ra, rb]; }
        }
        if (!best) best = [da, db];
        const a0 = Math.atan2(best[0][1], best[0][0]), a1 = Math.atan2(best[1][1], best[1][0]);
        let s0 = a0, sw = wrap2pi(a1 - a0);
        if (sw > Math.PI) { s0 = a1; sw = TAU - sw; }
        const pts: P2[] = [];
        for (let i = 0; i <= 32; i++) pts.push(polar(V, r, s0 + (sw * i) / 32));
        lines.push({ pts, color, width: 1 });
        arrow(pts[0], perp([Math.cos(s0), Math.sin(s0)]).map((x) => -x) as P2);
        arrow(pts[32], perp([Math.cos(s0 + sw), Math.sin(s0 + sw)]));
        // extension of the lines to the arc
        for (const ray of best) { const end = add(V, mul(ray, r + over)); lines.push({ pts: [V, end], color, width: 1, dashed: true }); }
        return;
      }
      case 'offset': {
        const pr = c.pairs[0];
        const s = m.get(pr.src), d = m.get(pr.dst);
        if (!s || !d) return;
        let ps: P2, pd: P2;
        if (s.kind === 'line' && d.kind === 'line') {
          ps = lerp(s.a, s.b, 0.5); const u = norm(sub(d.b, d.a)); pd = add(d.a, mul(u, dot(sub(ps, d.a), u)));
        } else if ((s.kind === 'arc' || s.kind === 'circle') && (d.kind === 'arc' || d.kind === 'circle')) {
          const ang = s.kind === 'arc' ? s.a0 + arcSweep(s.a0, s.a1) / 2 : 0;
          ps = polar(s.c, s.r, ang); pd = polar(d.c, d.r, ang);
        } else return;
        lines.push({ pts: [ps, pd], color, width: 1 });
        arrow(pd, sub(pd, ps)); arrow(ps, sub(ps, pd));
        lines.push({ pts: [lerp(ps, pd, 0.5), at], color, width: 1, dashed: true });
        return;
      }
    }
  }

  /** Tangency points known to the solver (for display/debug). */
  tangentPoints() { return tangentPoints(this.state().ws.constraints); }
}

function isAxis(id: string) { return id === 'axisH' || id === 'axisV'; }

function wrapSigned(a: number) { let x = a % TAU; if (x > Math.PI) x -= TAU; if (x < -Math.PI) x += TAU; return x; }

function boxCrosses(e: WEntity, lo: P2, hi: P2): boolean {
  const edges: WEntity[] = [
    { id: 'b1', kind: 'line', a: lo, b: [hi[0], lo[1]], construction: true },
    { id: 'b2', kind: 'line', a: [hi[0], lo[1]], b: hi, construction: true },
    { id: 'b3', kind: 'line', a: hi, b: [lo[0], hi[1]], construction: true },
    { id: 'b4', kind: 'line', a: [lo[0], hi[1]], b: lo, construction: true },
  ];
  return edges.some((b) => curveIntersections(e, b).some((q) => {
    const onB = q[0] >= lo[0] - 1e-9 && q[0] <= hi[0] + 1e-9 && q[1] >= lo[1] - 1e-9 && q[1] <= hi[1] + 1e-9;
    if (!onB) return false;
    if (e.kind === 'line') { const t = dot(sub(q, e.a), sub(e.b, e.a)) / dot(sub(e.b, e.a), sub(e.b, e.a)); return t >= 0 && t <= 1; }
    if (e.kind === 'arc') { const a = wrap2pi(Math.atan2(q[1] - e.c[1], q[0] - e.c[0]) - e.a0); return a <= arcSweep(e.a0, e.a1); }
    return true;
  }));
}

/** Current measured value of a dimension (mm or rad). */
export function measure(c: SketchConstraint, ents: WEntity[]): number {
  const m = entityMap(ents);
  const P = (r: PointRef) => pointOf(m.get(r.e)!, r.p);
  switch (c.type) {
    case 'distance': { const a = P(c.a), b = P(c.b); return c.dir === 'h' ? Math.abs(b[0] - a[0]) : c.dir === 'v' ? Math.abs(b[1] - a[1]) : dist(a, b); }
    case 'pointLineDistance': { const p = P(c.p), l = m.get(c.line) as any; return Math.abs(cross(sub(p, l.a), norm(sub(l.b, l.a)))); }
    case 'radius': return (m.get(c.e) as any).r;
    case 'diameter': return 2 * (m.get(c.e) as any).r;
    case 'angle': {
      const a = m.get(c.a) as any, b = m.get(c.b) as any;
      const da = sub(a.b, a.a), db = sub(b.b, b.a);
      const th = Math.abs(Math.atan2(cross(da, db), dot(da, db)));
      return c.supplement ? Math.PI - th : th;
    }
    case 'offset': {
      const pr = c.pairs[0]; const s = m.get(pr.src) as any, d = m.get(pr.dst) as any;
      if (s.kind === 'line') return Math.abs(cross(sub(d.a, s.a), norm(sub(s.b, s.a))));
      return Math.abs(d.r - s.r);
    }
    default: return NaN;
  }
}

/** Display a value: 3 decimals for inches, 2 for mm, 2 for degrees, trailing zeros kept for lengths (drawing style). */
export function formatValue(v: number, unit: 'in' | 'mm' | 'deg'): string {
  const d = unit === 'in' ? 3 : 2;
  const s = (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
  return unit === 'deg' ? s.replace(/\.?0+$/, '') : s;
}

let lastMmPerPx = 1;
const mmPerPxFor = (_docPerPx: number) => lastMmPerPx;

function defaultTextOffset(c: SketchDimension, ents: WEntity[], docPerPx: number): [number, number] {
  const m = entityMap(ents);
  const off = 28 * docPerPx;
  try {
    if (c.type === 'distance') {
      const a = pointOf(m.get(c.a.e)!, c.a.p), b = pointOf(m.get(c.b.e)!, c.b.p);
      if (c.dir === 'h') return [0, off];
      if (c.dir === 'v') return [off, 0];
      const n = perp(norm(sub(b, a)));
      return [n[0] * off, n[1] * off];
    }
    if (c.type === 'radius' || c.type === 'diameter') {
      // Text just outside the curve, up and to the right of the center. r is mm; convert via docPerPx / mmPerPx.
      const e = m.get(c.e) as any;
      const rDoc = e.r * docPerPx / mmPerPxFor(docPerPx);
      return [0.7071 * (rDoc + off), 0.7071 * (rDoc + off)];
    }
  } catch { /* fall through */ }
  return [off * 0.7, off * 0.7];
}

export type { ValueExpr };
