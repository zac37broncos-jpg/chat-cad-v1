/**
 * Drag handles for the Extrude command panel: an arrow at
 * the end of each blind direction. Dragging it changes the depth live; while
 * dragging, a ruler appears beside the arrow and the value snaps to the
 * ruler's ticks when the pointer is over the ruler (the drag-with-ruler
 * behaviour common in professional CAD, for precise values).
 *
 * Everything here is display and pointer handling; the command panel owns
 * the value and gets it back through onDrag. Values are millimeters.
 */
import * as THREE from 'three';
import type { Viewport } from './viewport';

type V3 = [number, number, number];

export interface DragHandle {
  /** Where the depth is measured from (mm) and the unit direction it grows in. */
  origin: V3;
  dir: V3;
  /** Current depth (mm) shown by the arrow. */
  value: number;
  /** New depth while dragging (final = pointer released). */
  onDrag(valueMm: number, final: boolean): void;
  /** Text for the value label, and the ruler unit (mm per document unit). */
  format(valueMm: number): string;
  unitMm: number;
}

const HANDLE_PX = 12; // grab radius around the arrow head, screen pixels
const RULER_PX = 26; // ruler distance from the arrow line
const SNAP_PX = 14; // within this of the ruler: snap to ticks

const vec = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

class Handles {
  private group = new THREE.Group();
  private ruler = new THREE.Group();
  private handles: DragHandle[] = [];
  private arrows: THREE.Group[] = [];
  private hot = -1;
  private drag: { i: number; pointerId: number; grab: number } | null = null;
  private label: HTMLDivElement;
  private unbind: () => void;
  private raf = 0;

  constructor(private vp: Viewport) {
    this.group.renderOrder = 20;
    this.ruler.renderOrder = 21;
    vp.scene.add(this.group, this.ruler);
    this.label = document.createElement('div');
    this.label.className = 'drag-handle-label';
    Object.assign(this.label.style, {
      position: 'absolute', pointerEvents: 'none', display: 'none', padding: '2px 6px', borderRadius: '3px',
      whiteSpace: 'nowrap', background: 'rgba(255,255,255,0.92)', border: '1px solid #2f7de1', color: '#123', font: '12px system-ui, sans-serif', zIndex: '5',
    });
    const host = vp.renderer.domElement.parentElement;
    if (host) { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; host.appendChild(this.label); }
    const el = vp.renderer.domElement;
    // Capture phase on the canvas: runs before the viewport's own listeners, so a grab never selects or rotates.
    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = (e: PointerEvent) => this.onUp(e);
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    el.addEventListener('pointerup', up, true);
    this.unbind = () => {
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('pointermove', move, true);
      el.removeEventListener('pointerup', up, true);
    };
    // Arrows keep a constant size on screen: rescale when the zoom changes.
    let last = '';
    const tick = () => {
      const k = `${this.mmPerPx()}`;
      if (k !== last) { last = k; this.draw(); }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.unbind();
    this.clear();
    this.vp.scene.remove(this.group, this.ruler);
    this.label.remove();
  }

  set(handles: DragHandle[]) {
    this.handles = handles;
    if (this.drag && !handles[this.drag.i]) this.drag = null;
    this.draw();
  }

  /** Is a handle being dragged (the PM should not overwrite the value from elsewhere)? */
  get dragging() { return !!this.drag; }

  private mmPerPx(): number {
    const cam = this.vp.camera;
    return (cam.top - cam.bottom) / cam.zoom / (this.vp.renderer.domElement.clientHeight || 1);
  }

  private clear() {
    for (const g of [this.group, this.ruler]) {
      for (const c of [...g.children]) {
        g.remove(c);
        c.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); });
      }
    }
    this.arrows = [];
  }

  private draw() {
    this.clear();
    const px = this.mmPerPx();
    this.handles.forEach((h, i) => {
      const color = i === this.hot || this.drag?.i === i ? 0xf0a020 : 0x2f7de1;
      const mat = () => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
      const len = 26 * px, headLen = 12 * px, headR = 5 * px;
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.2 * px, 1.2 * px, len, 8), mat());
      shaft.position.y = len / 2;
      const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headLen, 16), mat());
      head.position.y = len + headLen / 2;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(3 * px, 12, 8), mat());
      g.add(shaft, head, ball);
      g.traverse((o) => { o.renderOrder = 20; });
      g.position.copy(this.tip(h));
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vec(h.dir).normalize());
      this.group.add(g);
      this.arrows.push(g);
    });
    if (this.drag) this.drawRuler(this.handles[this.drag.i]);
  }

  private tip(h: DragHandle): THREE.Vector3 { return vec(h.origin).addScaledVector(vec(h.dir), h.value); }

  /** Screen-space side offset for the ruler: perpendicular to the arrow on screen. */
  private rulerSide(h: DragHandle): THREE.Vector3 {
    const view = new THREE.Vector3(); this.vp.camera.getWorldDirection(view);
    let s = new THREE.Vector3().crossVectors(vec(h.dir), view);
    if (s.lengthSq() < 1e-12) s = new THREE.Vector3().crossVectors(this.vp.camera.up, view);
    return s.normalize();
  }

  /** Ruler tick spacing (mm): 1, 2 or 5 x 10^k document units, at least 12 px apart. */
  private step(h: DragHandle): number {
    const minUnits = (12 * this.mmPerPx()) / h.unitMm;
    const p = Math.pow(10, Math.floor(Math.log10(minUnits)));
    for (const m of [1, 2, 5, 10]) if (m * p >= minUnits) return m * p * h.unitMm;
    return 10 * p * h.unitMm;
  }

  private drawRuler(h: DragHandle) {
    const px = this.mmPerPx();
    const side = this.rulerSide(h).multiplyScalar(RULER_PX * px);
    const step = this.step(h);
    const end = Math.max(h.value * 1.5, h.value + 20 * step);
    const pts: THREE.Vector3[] = [];
    const base = vec(h.origin).add(side);
    const d = vec(h.dir);
    pts.push(base.clone(), base.clone().addScaledVector(d, end));
    const n = Math.floor(end / step);
    const sideU = side.clone().normalize();
    for (let k = 0; k <= n; k++) {
      const p = base.clone().addScaledVector(d, k * step);
      const major = k % 10 === 0 ? 10 : k % 5 === 0 ? 7 : 4;
      pts.push(p, p.clone().addScaledVector(sideU, major * px));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x334455, depthTest: false, transparent: true, opacity: 0.85 }));
    line.renderOrder = 21;
    this.ruler.add(line);
  }

  // ------------------------------------------------------------ pointer
  private screen(p: THREE.Vector3): { x: number; y: number } {
    const r = this.vp.renderer.domElement.getBoundingClientRect();
    const q = p.clone().project(this.vp.camera);
    return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height };
  }

  /** Index of the handle whose arrow is under the pointer. */
  private hit(x: number, y: number): number {
    const px = this.mmPerPx();
    let best = -1, bestD = HANDLE_PX;
    this.handles.forEach((h, i) => {
      const d = vec(h.dir);
      // Along the arrow from its base to the head tip, sampled on screen.
      for (const t of [0, 10, 20, 30, 38]) {
        const s = this.screen(this.tip(h).addScaledVector(d, t * px));
        const dist = Math.hypot(s.x - x, s.y - y);
        if (dist < bestD) { bestD = dist; best = i; }
      }
    });
    return best;
  }

  /** Depth (mm) under the pointer: the point of the arrow's line nearest the pointer's view ray. */
  private valueAt(h: DragHandle, x: number, y: number): { v: number; onRuler: boolean } {
    const r = this.vp.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.vp.camera);
    const o = vec(h.origin), d = vec(h.dir).normalize();
    const w = ray.ray.origin.clone().sub(o), e = ray.ray.direction;
    const b = d.dot(e), den = 1 - b * b;
    let t: number;
    if (den < 1e-9) t = h.value; // looking straight down the arrow: no change
    else t = (d.dot(w) - b * e.dot(w)) / den;
    // On the ruler? Distance on screen from the pointer to the ruler line.
    const side = this.rulerSide(h).multiplyScalar(RULER_PX * this.mmPerPx());
    const a = this.screen(o.clone().add(side)), c = this.screen(o.clone().add(side).addScaledVector(d, Math.max(t, 1)));
    const ux = c.x - a.x, uy = c.y - a.y, L = Math.hypot(ux, uy) || 1;
    const distToRuler = Math.abs(((x - a.x) * uy - (y - a.y) * ux) / L);
    const onRuler = distToRuler < SNAP_PX;
    return { v: t, onRuler };
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || !this.handles.length) return;
    const i = this.hit(e.clientX, e.clientY);
    if (i < 0) return;
    e.stopImmediatePropagation(); e.preventDefault();
    this.vp.renderer.domElement.setPointerCapture(e.pointerId);
    // Keep the grab point under the pointer: the value does not jump when the drag starts.
    const h = this.handles[i];
    this.drag = { i, pointerId: e.pointerId, grab: this.valueAt(h, e.clientX, e.clientY).v - h.value };
    this.draw();
    this.showLabel(this.handles[i], e.clientX, e.clientY);
  }

  private onMove(e: PointerEvent) {
    if (!this.drag) {
      const i = this.handles.length ? this.hit(e.clientX, e.clientY) : -1;
      if (i !== this.hot) { this.hot = i; this.draw(); this.vp.renderer.domElement.style.cursor = i >= 0 ? 'grab' : ''; }
      if (i >= 0 && e.buttons === 0) e.stopImmediatePropagation(); // no pre-selection under the arrow (but never stop a view drag)
      return;
    }
    e.stopImmediatePropagation();
    const h = this.handles[this.drag.i];
    const { v, onRuler } = this.valueAt(h, e.clientX, e.clientY);
    let val = v - this.drag.grab;
    if (onRuler) { const st = this.step(h); val = Math.max(st, Math.round(val / st) * st); } else val = this.clean(h, val);
    h.value = val;
    this.draw();
    this.showLabel(h, e.clientX, e.clientY);
    h.onDrag(val, false);
  }

  private onUp(e: PointerEvent) {
    if (!this.drag) return;
    e.stopImmediatePropagation();
    const h = this.handles[this.drag.i];
    try { this.vp.renderer.domElement.releasePointerCapture(this.drag.pointerId); } catch { /* already released */ }
    this.drag = null;
    this.label.style.display = 'none';
    this.draw();
    h.onDrag(h.value, true);
  }

  /** Off the ruler the value is rounded to 0.001 of the document unit; never zero or negative. */
  private clean(h: DragHandle, v: number): number {
    const q = h.unitMm / 1000;
    const r = Math.round(v / q) * q;
    return Math.max(r, q);
  }

  private showLabel(h: DragHandle, x: number, y: number) {
    const host = this.label.parentElement;
    if (!host) return;
    const r = host.getBoundingClientRect();
    this.label.textContent = h.format(h.value);
    this.label.style.display = 'block';
    this.label.style.left = `${x - r.left + 14}px`;
    this.label.style.top = `${y - r.top - 26}px`;
  }
}

const instances = new WeakMap<Viewport, Handles>();

/** The drag handles of a viewport (created on first use). */
export function dragHandles(vp: Viewport): Handles {
  let h = instances.get(vp);
  if (!h) { h = new Handles(vp); instances.set(vp, h); }
  return h;
}
