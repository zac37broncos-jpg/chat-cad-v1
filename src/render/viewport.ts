/**
 * Three.js viewport: shaded faces with exact-edge overlays, reference planes,
 * pre-selection highlight, picking, standard views, translucent feature
 * previews, a reference triad, and preset-driven navigation (mainstream CAD by default).
 * Z is up. Units are mm.
 */
import * as THREE from 'three';
import type { MeshData } from '../kernel/query';
import type { SketchGeometry } from '../kernel/regen';
import type { SubRef, PlaneRef, SelRef } from '../kernel/protocol';
import type { BasePlane } from '../core/model';
import type { RefGeometry } from '../kernel/features';
import { NAV_PRESETS, trackpadAction, type NavPresetId, type NavAction } from './navigation';
import { samplePolyline } from '../sketch/geom';

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';
export type { PlaneRef, SelRef };

export const PLANE_NAMES: Record<BasePlane, string> = { XZ: 'Front Plane', XY: 'Top Plane', YZ: 'Right Plane' };

const VIEW_DIRS: Record<StandardView, { dir: THREE.Vector3; up: THREE.Vector3 }> = {
  front: { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
  back: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
  left: { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
  right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
  top: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
  bottom: { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },
  iso: { dir: new THREE.Vector3(1, -1, 1).normalize(), up: new THREE.Vector3(0, 0, 1) },
};

export interface ViewportColors { background: string; face: string; edge: string; hover: string; selected: string; sketch: string; plane: string; preview: string; previewCut: string }

const DEFAULT_COLORS: ViewportColors = {
  background: '#e9edf2', face: '#b9c3cf', edge: '#1d2530', hover: '#f0a020', selected: '#2f7de1',
  sketch: '#1f6fd1', plane: '#4f86c6', preview: '#f2c230', previewCut: '#e0603a',
};

interface ViewState { pos: THREE.Vector3; up: THREE.Vector3; target: THREE.Vector3; height: number }

/** View-change animation (mainstream CAD: Options > View > View transition). */
const VIEW_ANIM_MS = 350;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Cursors while dragging the view. The rotate cursor is this project's own drawing (two curved arrows). */
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">'
  + '<g stroke="#fff" stroke-width="4"><path d="M5 9a7.5 7.5 0 0 1 13-2"/><path d="M19 15a7.5 7.5 0 0 1-13 2"/><path d="M18.5 3v4.5H14"/><path d="M5.5 21v-4.5H10"/></g>'
  + '<g stroke="#1d2530" stroke-width="1.8"><path d="M5 9a7.5 7.5 0 0 1 13-2"/><path d="M19 15a7.5 7.5 0 0 1-13 2"/><path d="M18.5 3v4.5H14"/><path d="M5.5 21v-4.5H10"/></g></svg>',
)}") 12 12, move`;
const DRAG_CURSOR: Record<Exclude<NavAction, 'none'>, string> = { rotate: ROTATE_CURSOR, roll: ROTATE_CURSOR, pan: 'move', zoom: 'ns-resize' };

const sameRef = (a: SelRef | null, b: SelRef | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind === 'plane' ? a.plane === (b as PlaneRef).plane : a.index === (b as SubRef).index);

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private model = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private planeGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private refGroup = new THREE.Group();
  private faceMeshes: THREE.Mesh[] = [];
  private edgeLines: THREE.Line[] = [];
  private planeMeshes: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private target = new THREE.Vector3();
  /** Rotation center: model center by default, or a middle-clicked point. */
  private pivot: THREE.Vector3 | null = null;
  private viewHeight = 200;
  private hovered: SelRef | null = null;
  private selected: SelRef[] = [];
  private navPreset: NavPresetId = 'middle-rotate';
  private reverseWheel = false;
  private drag: { action: Exclude<NavAction, 'none'>; x: number; y: number; moved: boolean } | null = null;
  private lastMiddleUp = 0;
  private history: ViewState[] = [];
  private showPlanesAlways = false;
  private showEdges = true;
  private originMarker!: THREE.Group;
  private highlightPlanes = new Set<BasePlane>();
  /** Faces lit from outside the view (feature tree hover / selection), by face index. */
  private emphasis = { hover: new Set<number>(), selected: new Set<number>() };
  /** Sketch ids lit from the tree (hover / selected). */
  private sketchEmphasis = { hover: new Set<string>(), selected: new Set<string>() };
  private sketchData: { sketches: SketchGeometry[]; visible: Set<string> } = { sketches: [], visible: new Set() };
  /** Running view transition, if any. */
  private anim: { from: ViewState; to: ViewState; t0: number } | null = null;
  private animateViews = true;
  /** Cursor that was on the canvas before a view drag changed it. */
  private cursorBeforeDrag: string | null = null;
  private colors: ViewportColors;
  private resizeObs: ResizeObserver;
  private raf = 0;
  /** False while another tool (the sketcher) owns left clicks: no model hover or selection. */
  pickingEnabled = true;
  /** Mainstream CAD command panel behaviour: a plain click adds/removes the item instead of replacing the selection. */
  additiveSelection = false;
  // Reference triad (bottom-left), drawn in its own small viewport.
  private triadScene = new THREE.Scene();
  private triadCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, -10, 10);
  onSelectionChange: (sel: SelRef[]) => void = () => {};
  onHover: (ref: SelRef | null) => void = () => {};
  /** A left click on the model, a plane or empty space (after the selection changed), with the 3D point clicked. */
  onPick: (ref: SelRef | null, point: [number, number, number] | null) => void = () => {};
  onContextMenu: (ref: SelRef | null, x: number, y: number) => void = () => {};

  constructor(private host: HTMLElement, colors: Partial<ViewportColors> = {}) {
    this.colors = { ...DEFAULT_COLORS, ...colors };
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.autoClear = false;
    this.scene.background = new THREE.Color(this.colors.background);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.camera.up.set(0, 0, 1);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.tabIndex = 0;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    this.camera.add(key);
    key.position.set(1, 1, 2);
    this.scene.add(this.camera);
    this.scene.add(this.model, this.sketchGroup, this.planeGroup, this.previewGroup, this.refGroup);
    this.originMarker = this.makeOrigin();
    this.scene.add(this.originMarker);
    this.buildTriad();
    this.rebuildPlanes();

    this.setView('iso', false);
    this.finishAnim(); // start in the isometric view, no animation
    this.bindEvents();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    const loop = () => { this.render(); this.raf = requestAnimationFrame(loop); };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setNavPreset(id: NavPresetId) { this.navPreset = id; }
  /** Animate view orientation changes, zoom to fit and previous view (on by default). */
  setAnimateViews(v: boolean) { this.animateViews = v; if (!v) this.finishAnim(); }
  setReverseWheel(v: boolean) { this.reverseWheel = v; }

  private render() {
    if (this.anim) this.stepAnim();
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // triad: same orientation as the main camera
    const s = 90;
    const dir = this.camera.position.clone().sub(this.target).normalize();
    this.triadCamera.position.copy(dir.multiplyScalar(5));
    this.triadCamera.up.copy(this.camera.up);
    this.triadCamera.lookAt(0, 0, 0);
    this.renderer.clearDepth();
    this.renderer.setViewport(8, 8, s, s);
    this.renderer.render(this.triadScene, this.triadCamera);
  }

  private buildTriad() {
    const mk = (d: THREE.Vector3, color: number, label: string) => {
      this.triadScene.add(new THREE.ArrowHelper(d, new THREE.Vector3(), 1, color, 0.25, 0.14));
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = `#${color.toString(16).padStart(6, '0')}`; g.font = 'bold 44px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, 32, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      sp.position.copy(d.clone().multiplyScalar(1.3)); sp.scale.set(0.45, 0.45, 1);
      this.triadScene.add(sp);
    };
    mk(new THREE.Vector3(1, 0, 0), 0xd23c3c, 'X');
    mk(new THREE.Vector3(0, 1, 0), 0x2e9e5b, 'Y');
    mk(new THREE.Vector3(0, 0, 1), 0x2f6fd1, 'Z');
  }

  private makeOrigin(): THREE.Group {
    // Small origin marker (sized in screen space would be ideal; 0.25 in is a good default).
    const g = new THREE.Group();
    const L = 6.35;
    g.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), L, 0xd23c3c, 1.6, 0.9));
    g.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), L, 0x2e9e5b, 1.6, 0.9));
    g.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), L, 0x2f6fd1, 1.6, 0.9));
    g.renderOrder = 3;
    return g;
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.updateProjection();
  }

  private updateProjection() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    const aspect = w / h;
    const hh = this.viewHeight / 2;
    this.camera.left = -hh * aspect; this.camera.right = hh * aspect;
    this.camera.top = hh; this.camera.bottom = -hh;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ reference planes
  /** Planes are sized to the model like in pro CAD (min 2 in square). */
  private rebuildPlanes() {
    for (const m of this.planeGroup.children) { (m as THREE.Mesh).geometry?.dispose(); }
    this.planeGroup.clear();
    this.planeMeshes = [];
    const b = new THREE.Box3().setFromObject(this.model);
    let half = 25.4;
    const c = new THREE.Vector3();
    if (!b.isEmpty()) {
      const size = b.getSize(new THREE.Vector3());
      half = Math.max(25.4, Math.max(size.x, size.y, size.z) * 0.65);
      b.getCenter(c);
    }
    const defs: { plane: BasePlane; rot: THREE.Euler; offset: THREE.Vector3 }[] = [
      { plane: 'XY', rot: new THREE.Euler(0, 0, 0), offset: new THREE.Vector3(c.x, c.y, 0) },
      { plane: 'XZ', rot: new THREE.Euler(Math.PI / 2, 0, 0), offset: new THREE.Vector3(c.x, 0, c.z) },
      { plane: 'YZ', rot: new THREE.Euler(0, Math.PI / 2, 0), offset: new THREE.Vector3(0, c.y, c.z) },
    ];
    for (const d of defs) {
      const g = new THREE.PlaneGeometry(half * 2, half * 2);
      const mat = new THREE.MeshBasicMaterial({ color: this.colors.plane, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
      const m = new THREE.Mesh(g, mat);
      m.rotation.copy(d.rot);
      m.position.copy(d.offset);
      m.userData.ref = { kind: 'plane', plane: d.plane } satisfies PlaneRef;
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: this.colors.plane }));
      m.add(border);
      const label = this.makeLabel(PLANE_NAMES[d.plane]);
      label.position.set(-half * 0.98, half * 0.98, 0);
      label.center.set(0, 1);
      label.scale.set(half * 0.5, half * 0.125, 1);
      m.add(label);
      this.planeMeshes.push(m);
      this.planeGroup.add(m);
    }
    this.paintPlanes();
  }

  private makeLabel(text: string): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = this.colors.plane; g.font = '28px system-ui, sans-serif'; g.textBaseline = 'top';
    g.fillText(text, 6, 8);
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  }

  setShowPlanes(v: boolean) { this.showPlanesAlways = v; this.paintPlanes(); }
  /** Highlight planes from outside (e.g. hovering them in the feature tree). */
  /** Display style: "Shaded With Edges" (true) or "Shaded" (false). Hovered/selected edges still show. */
  setShowEdges(v: boolean) { this.showEdges = v; this.paint(); }
  setShowOrigin(v: boolean) { this.originMarker.visible = v; }
  setHighlightedPlanes(planes: BasePlane[]) { this.highlightPlanes = new Set(planes); this.paintPlanes(); }

  private paintPlanes() {
    for (const m of this.planeMeshes) {
      const r = m.userData.ref as PlaneRef;
      const sel = this.selected.some((s) => sameRef(s, r));
      const hov = sameRef(this.hovered, r) || this.highlightPlanes.has(r.plane);
      m.visible = this.showPlanesAlways || sel || hov;
      const color = sel ? this.colors.selected : hov ? this.colors.hover : this.colors.plane;
      (m.material as THREE.MeshBasicMaterial).color.set(color);
      (m.material as THREE.MeshBasicMaterial).opacity = sel || hov ? 0.22 : 0.1;
      ((m.children[0] as THREE.LineSegments).material as THREE.LineBasicMaterial).color.set(color);
    }
  }

  // ------------------------------------------------------------ content
  setMesh(mesh: MeshData | null, keepSelection = false) {
    for (const m of this.faceMeshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    for (const l of this.edgeLines) { l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
    this.model.clear();
    this.faceMeshes = [];
    this.edgeLines = [];
    this.hovered = null;
    this.emphasis = { hover: new Set(), selected: new Set() };
    if (!keepSelection) this.selected = this.selected.filter((s) => s.kind === 'plane');
    if (mesh) {
      for (const f of mesh.faces) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(f.normals, 3));
        g.setIndex(new THREE.BufferAttribute(f.indices, 1));
        const mat = new THREE.MeshStandardMaterial({
          color: this.colors.face, metalness: 0.15, roughness: 0.55,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide,
        });
        const m = new THREE.Mesh(g, mat);
        m.userData.ref = { kind: 'face', index: f.index } satisfies SubRef;
        this.faceMeshes.push(m);
        this.model.add(m);
      }
      for (const e of mesh.edges) {
        if (e.seam) continue; // a closed face's seam is not a real edge (mainstream CAD does not draw it either)
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(e.points, 3));
        const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: this.colors.edge }));
        l.userData.ref = { kind: 'edge', index: e.index } satisfies SubRef;
        this.edgeLines.push(l);
        this.model.add(l);
      }
    }
    this.rebuildPlanes();
    this.paint();
    this.onSelectionChange([...this.selected]);
  }

  /** Translucent preview of a feature being edited (conventional CAD-style yellow preview). Cuts draw on top: the removed material is inside the body. */
  setPreview(mesh: MeshData | null, kind: 'add' | 'cut' = 'add') {
    for (const c of this.previewGroup.children) { const o = c as THREE.Mesh; o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    this.previewGroup.clear();
    if (!mesh) return;
    const color = kind === 'cut' ? this.colors.previewCut : this.colors.preview;
    for (const f of mesh.faces) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(f.normals, 3));
      g.setIndex(new THREE.BufferAttribute(f.indices, 1));
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false, depthTest: kind !== 'cut', side: THREE.DoubleSide, roughness: 0.6 }));
      m.renderOrder = 5;
      this.previewGroup.add(m);
    }
    for (const e of mesh.edges) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(e.points, 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: kind === 'cut' ? 0x9a3b1f : 0x8a6a00, transparent: true, opacity: 0.9, depthTest: kind !== 'cut' }));
      l.renderOrder = 6;
      this.previewGroup.add(l);
    }
  }

  /** User reference planes, axes and points (display only; pick them in the feature tree). */
  setRefGeometry(items: RefGeometry[], names: Map<string, string>, highlighted: Set<string> = new Set()) {
    for (const c of [...this.refGroup.children]) {
      c.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | undefined; mat?.dispose?.(); });
    }
    this.refGroup.clear();
    const v = (p: [number, number, number]) => new THREE.Vector3(...p);
    for (const g of items) {
      const color = highlighted.has(g.id) ? this.colors.selected : this.colors.plane;
      if (g.kind === 'plane') {
        const h = g.size / 2, o = v(g.origin), x = v(g.x).multiplyScalar(h), y = v(g.y).multiplyScalar(h);
        const corners = [o.clone().sub(x).sub(y), o.clone().add(x).sub(y), o.clone().add(x).add(y), o.clone().sub(x).add(y)];
        const geo = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: highlighted.has(g.id) ? 0.22 : 0.1, side: THREE.DoubleSide, depthWrite: false }));
        this.refGroup.add(m);
        this.refGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color })));
        const label = this.makeLabel(names.get(g.id) ?? 'Plane');
        label.position.copy(corners[3]);
        label.center.set(0, 1);
        label.scale.set(h * 0.5, h * 0.125, 1);
        this.refGroup.add(label);
      } else if (g.kind === 'axis') {
        const o = v(g.origin), d = v(g.dir).multiplyScalar(g.length / 2);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([o.clone().sub(d), o.clone().add(d)]), new THREE.LineDashedMaterial({ color, dashSize: g.length / 40, gapSize: g.length / 80 }));
        line.computeLineDistances();
        this.refGroup.add(line);
      } else {
        const p = v(g.p), s = this.viewHeight * 0.012;
        const pts = [p.clone().add(new THREE.Vector3(-s, 0, 0)), p.clone().add(new THREE.Vector3(s, 0, 0)), p.clone().add(new THREE.Vector3(0, -s, 0)), p.clone().add(new THREE.Vector3(0, s, 0)), p.clone().add(new THREE.Vector3(0, 0, -s)), p.clone().add(new THREE.Vector3(0, 0, s))];
        this.refGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
      }
    }
  }

  setSketches(sketches: SketchGeometry[], visibleIds: Set<string>) {
    this.sketchData = { sketches, visible: visibleIds };
    this.drawSketches();
  }

  private drawSketches() {
    const { sketches, visible: visibleIds } = this.sketchData;
    for (const c of this.sketchGroup.children) { const l = c as THREE.Line; l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
    this.sketchGroup.clear();
    for (const s of sketches) {
      if (!visibleIds.has(s.id)) continue;
      const color = this.sketchEmphasis.selected.has(s.id) ? this.colors.selected : this.sketchEmphasis.hover.has(s.id) ? this.colors.hover : this.colors.sketch;
      const { o, x, y } = s.frame;
      const P = (u: number, v: number) => new THREE.Vector3(o[0] + x[0] * u + y[0] * v, o[1] + x[1] * u + y[1] * v, o[2] + x[2] * u + y[2] * v);
      for (const e of s.entities) {
        if (e.kind === 'point') continue;
        const pts = samplePolyline(e).map((q) => P(q[0], q[1]));
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = e.construction
          ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.5 })
          : new THREE.LineBasicMaterial({ color });
        const line = new THREE.Line(g, mat);
        if (e.construction) line.computeLineDistances();
        line.renderOrder = 2;
        this.sketchGroup.add(line);
      }
    }
  }

  // ------------------------------------------------------------ views
  private snapshot(): ViewState { return { pos: this.camera.position.clone(), up: this.camera.up.clone(), target: this.target.clone(), height: this.viewHeight }; }
  private pushHistory() { this.history.push(this.snapshot()); if (this.history.length > 50) this.history.shift(); }

  private applyState(v: ViewState) {
    this.camera.position.copy(v.pos); this.camera.up.copy(v.up); this.target.copy(v.target); this.viewHeight = v.height;
    this.camera.lookAt(this.target); this.updateProjection();
  }

  /**
   * Run a view change. With animation on, the change is computed at once (so
   * every later call sees the final view), then the camera eases from the old
   * view to it. Any running animation is finished first.
   */
  private transition(apply: () => void) {
    this.finishAnim();
    const from = this.snapshot();
    apply();
    if (!this.animateViews) return;
    const to = this.snapshot();
    const same = from.pos.distanceTo(to.pos) < 1e-9 && from.up.distanceTo(to.up) < 1e-9 && from.target.distanceTo(to.target) < 1e-9 && Math.abs(from.height - to.height) < 1e-12;
    if (same) return;
    this.applyState(from);
    this.anim = { from, to, t0: performance.now() };
  }

  /** Jump to the end of a running view animation (before any other view change or drag). */
  private finishAnim() {
    const a = this.anim; if (!a) return;
    this.anim = null;
    this.applyState(a.to);
  }

  /** True while a view transition is playing. */
  get animating(): boolean { return this.anim !== null; }

  private stepAnim() {
    const a = this.anim!;
    const t = Math.min(1, (performance.now() - a.t0) / VIEW_ANIM_MS);
    if (t >= 1) { this.finishAnim(); return; }
    const k = easeInOut(t);
    const orient = (v: ViewState) => {
      const m = new THREE.Matrix4().lookAt(v.pos, v.target, v.up);
      return new THREE.Quaternion().setFromRotationMatrix(m);
    };
    const q = orient(a.from).slerp(orient(a.to), k);
    const target = a.from.target.clone().lerp(a.to.target, k);
    const dist = THREE.MathUtils.lerp(a.from.pos.distanceTo(a.from.target), a.to.pos.distanceTo(a.to.target), k);
    // Zoom eases on a log scale so zooming in and out feel the same.
    this.viewHeight = Math.exp(THREE.MathUtils.lerp(Math.log(a.from.height), Math.log(a.to.height), k));
    this.target.copy(target);
    this.camera.position.copy(target).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(q), dist);
    this.camera.up.copy(new THREE.Vector3(0, 1, 0).applyQuaternion(q));
    this.camera.lookAt(this.target);
    this.updateProjection();
  }

  /** Ctrl+Shift+Z: previous view. */
  previousView() {
    this.finishAnim();
    if (!this.history.length) return;
    this.transition(() => this.applyState(this.history.pop()!));
  }

  private bounds(): THREE.Box3 {
    const b = new THREE.Box3().setFromObject(this.model);
    b.union(new THREE.Box3().setFromObject(this.sketchGroup));
    if (b.isEmpty()) b.set(new THREE.Vector3(-25.4, -25.4, -25.4), new THREE.Vector3(25.4, 25.4, 25.4));
    return b;
  }

  private modelCenter(): THREE.Vector3 { return this.bounds().getCenter(new THREE.Vector3()); }

  fit(record = true) {
    this.transition(() => { if (record) this.pushHistory(); this.fitNow(); });
  }

  private fitNow() {
    const b = this.bounds();
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3()).length();
    const dir = this.camera.position.clone().sub(this.target).normalize();
    this.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, size * 2 + 100);
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.viewHeight = Math.max(size * 1.15 * Math.max(1, h / w), 1);
    this.pivot = null;
    this.camera.lookAt(this.target);
    this.updateProjection();
  }

  setView(v: StandardView, record = true) {
    this.transition(() => {
      if (record) this.pushHistory();
      const { dir, up } = VIEW_DIRS[v];
      this.camera.up.copy(up);
      this.camera.position.copy(this.target).addScaledVector(dir, 1000);
      this.camera.lookAt(this.target);
      this.fitNow();
    });
  }

  /**
   * Look straight at a plane / planar face (normal toward viewer). Selecting it
   * again flips 180°, unless noFlip (entering a sketch always looks at its front).
   */
  normalTo(normal: [number, number, number], upDir?: [number, number, number], noFlip = false) {
    this.transition(() => {
      this.pushHistory();
      let n = new THREE.Vector3(...normal).normalize();
      const cur = this.camera.position.clone().sub(this.target).normalize();
      const flip = !noFlip && cur.dot(n) > 0.9999;
      if (flip) n = n.negate();
      const up = upDir && !flip ? new THREE.Vector3(...upDir).normalize() : Math.abs(n.z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      this.camera.up.copy(up);
      this.camera.position.copy(this.target).addScaledVector(n, 1000);
      this.camera.lookAt(this.target);
      this.fitNow();
    });
  }

  /** Ctrl+8 with nothing selected: snap to the nearest standard orthographic view. */
  nearestStandardView() {
    this.finishAnim();
    const cur = this.camera.position.clone().sub(this.target).normalize();
    let best: StandardView = 'front', bestDot = -2;
    for (const v of ['front', 'back', 'left', 'right', 'top', 'bottom'] as StandardView[]) {
      const d = VIEW_DIRS[v].dir.dot(cur);
      if (d > bestDot) { bestDot = d; best = v; }
    }
    this.setView(best);
  }

  // ------------------------------------------------------------ input
  private ndc(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { v: new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), rect };
  }

  private pickHit(clientX: number, clientY: number): { ref: SelRef; point: THREE.Vector3 } | null {
    const { v, rect } = this.ndc(clientX, clientY);
    this.raycaster.params.Line = { threshold: (6 * this.viewHeight) / rect.height };
    this.raycaster.setFromCamera(v, this.camera);
    const hits = this.raycaster.intersectObjects([...this.edgeLines, ...this.faceMeshes], false);
    const firstFace = hits.find((h) => (h.object.userData.ref as SubRef).kind === 'face');
    const firstEdge = hits.find((h) => (h.object.userData.ref as SubRef).kind === 'edge');
    const slack = this.viewHeight * 0.01;
    if (firstEdge && (!firstFace || firstEdge.distance <= firstFace.distance + slack)) return { ref: firstEdge.object.userData.ref, point: firstEdge.point };
    if (firstFace) return { ref: firstFace.object.userData.ref, point: firstFace.point };
    // Planes only when no model geometry is under the cursor (and only visible ones, or near their border).
    const ph = this.raycaster.intersectObjects(this.planeMeshes.filter((m) => m.visible || this.showPlanesAlways), false);
    if (ph.length) return { ref: ph[0].object.userData.ref, point: ph[0].point };
    return null;
  }

  pick(clientX: number, clientY: number): SelRef | null { return this.pickHit(clientX, clientY)?.ref ?? null; }

  private paint() {
    for (const m of this.faceMeshes) {
      const r = m.userData.ref as SubRef;
      const c = this.selected.some((s) => sameRef(s, r)) || this.emphasis.selected.has(r.index) ? this.colors.selected
        : sameRef(this.hovered, r) || this.emphasis.hover.has(r.index) ? this.colors.hover : this.colors.face;
      (m.material as THREE.MeshStandardMaterial).color.set(c);
    }
    for (const l of this.edgeLines) {
      const r = l.userData.ref as SubRef;
      const c = this.selected.some((s) => sameRef(s, r)) ? this.colors.selected : sameRef(this.hovered, r) ? this.colors.hover : this.colors.edge;
      (l.material as THREE.LineBasicMaterial).color.set(c);
      l.visible = this.showEdges || c !== this.colors.edge;
    }
    this.paintPlanes();
  }

  /**
   * Light faces from outside the view without selecting them: mainstream CAD's
   * dynamic highlight (pointer over a feature in the feature tree) and
   * the highlight of features selected in the tree. Face indices of the current mesh.
   */
  setEmphasis(hoverFaces: number[], selectedFaces: number[]) {
    const same = (a: Set<number>, b: number[]) => a.size === b.length && b.every((i) => a.has(i));
    if (same(this.emphasis.hover, hoverFaces) && same(this.emphasis.selected, selectedFaces)) return;
    this.emphasis = { hover: new Set(hoverFaces), selected: new Set(selectedFaces) };
    this.paint();
  }

  /** Same for sketches shown in the view (by sketch feature id). */
  setSketchEmphasis(hover: string[], selected: string[]) {
    const same = (a: Set<string>, b: string[]) => a.size === b.length && b.every((i) => a.has(i));
    if (same(this.sketchEmphasis.hover, hover) && same(this.sketchEmphasis.selected, selected)) return;
    this.sketchEmphasis = { hover: new Set(hover), selected: new Set(selected) };
    this.drawSketches();
  }

  clearSelection() { this.selected = []; this.paint(); this.onSelectionChange([]); }
  setSelection(sel: SelRef[]) { this.selected = [...sel]; this.paint(); this.onSelectionChange([...sel]); }
  getSelection(): SelRef[] { return [...this.selected]; }

  private bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    let downAt: { x: number; y: number; button: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      el.focus();
      const mods = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
      let action = NAV_PRESETS[this.navPreset].action(e.button, mods);
      if (action === 'none') action = trackpadAction(e.button, mods);
      downAt = { x: e.clientX, y: e.clientY, button: e.button };
      if (action !== 'none') {
        this.finishAnim();
        if (!this.drag) this.pushHistory();
        this.drag = { action, x: e.clientX, y: e.clientY, moved: false };
        if (this.cursorBeforeDrag === null) this.cursorBeforeDrag = el.style.cursor;
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 0 && !this.drag.moved) { this.drag.moved = true; el.style.cursor = DRAG_CURSOR[this.drag.action]; }
        this.drag.x = e.clientX; this.drag.y = e.clientY;
        switch (this.drag.action) {
          case 'rotate': this.rotate(dx, dy); break;
          case 'pan': this.pan(dx, dy); break;
          case 'zoom': this.zoomCenter(Math.pow(1.01, dy)); break;
          case 'roll': this.roll(dx * 0.01); break;
        }
        return;
      }
      if (!this.pickingEnabled) { if (this.hovered) { this.hovered = null; this.paint(); this.onHover(null); } return; }
      const ref = this.pick(e.clientX, e.clientY);
      if (!sameRef(ref, this.hovered)) { this.hovered = ref; this.paint(); this.onHover(ref); }
    });
    el.addEventListener('pointercancel', () => {
      this.drag = null; downAt = null;
      if (this.cursorBeforeDrag !== null) { el.style.cursor = this.cursorBeforeDrag; this.cursorBeforeDrag = null; }
    });
    el.addEventListener('pointerleave', () => {
      // Pre-selection highlight goes away when the pointer leaves the view.
      if (!this.drag && this.hovered) { this.hovered = null; this.paint(); this.onHover(null); }
    });
    el.addEventListener('pointerup', (e) => {
      const drag = this.drag;
      this.drag = null;
      if (this.cursorBeforeDrag !== null) { el.style.cursor = this.cursorBeforeDrag; this.cursorBeforeDrag = null; }
      const click = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4;
      if (drag && !drag.moved) this.history.pop(); // no view change: drop the history entry
      if (click && downAt!.button === 1) {
        const preset = NAV_PRESETS[this.navPreset];
        const now = performance.now();
        if (preset.doubleMiddleFit && now - this.lastMiddleUp < 350) { this.fit(); this.lastMiddleUp = 0; }
        else {
          this.lastMiddleUp = now;
          if (preset.middleClickPivot) { const hit = this.pickHit(e.clientX, e.clientY); this.pivot = hit && hit.ref.kind !== 'plane' ? hit.point.clone() : null; }
        }
      } else if (this.pickingEnabled && click && downAt!.button === 0 && !(drag && drag.moved)) {
        const hit = this.pickHit(e.clientX, e.clientY);
        const ref = hit?.ref ?? null;
        if (!ref) { if (!this.additiveSelection) this.selected = []; }
        else if (e.ctrlKey || e.shiftKey || e.metaKey || this.additiveSelection) {
          const i = this.selected.findIndex((s) => sameRef(s, ref));
          if (i >= 0) this.selected.splice(i, 1); else this.selected.push(ref);
        } else this.selected = [ref];
        this.paint();
        this.onSelectionChange([...this.selected]);
        this.onPick(ref, hit ? [hit.point.x, hit.point.y, hit.point.z] : null);
      } else if (click && downAt!.button === 2 && !(drag && drag.moved)) {
        this.onContextMenu(this.pick(e.clientX, e.clientY), e.clientX, e.clientY);
      }
      downAt = null;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.finishAnim();
      const preset = NAV_PRESETS[this.navPreset];
      // deltaY < 0: wheel rolled away from the user.
      let zoomIn = preset.wheelZoomIn === 'away' ? e.deltaY < 0 : e.deltaY > 0;
      if (this.reverseWheel) zoomIn = !zoomIn;
      this.zoomAt(e.clientX, e.clientY, zoomIn ? 1 / 1.15 : 1.15);
    }, { passive: false });
  }

  /** Rotate the view about the pivot (model center, or the middle-clicked point). */
  private rotate(dx: number, dy: number) {
    const speed = 0.008;
    const pivot = this.pivot ?? this.modelCenter();
    const viewDir = this.target.clone().sub(this.camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(viewDir, this.camera.up).normalize();
    const qYaw = new THREE.Quaternion().setFromAxisAngle(this.camera.up.clone().normalize(), -dx * speed);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * speed);
    const q = qYaw.multiply(qPitch);
    this.camera.position.sub(pivot).applyQuaternion(q).add(pivot);
    this.target.sub(pivot).applyQuaternion(q).add(pivot);
    this.camera.up.applyQuaternion(q);
    this.camera.lookAt(this.target);
  }

  private roll(angle: number) {
    const viewDir = this.target.clone().sub(this.camera.position).normalize();
    this.camera.up.applyAxisAngle(viewDir, angle);
    this.camera.lookAt(this.target);
  }

  private pan(dx: number, dy: number) {
    const h = this.host.clientHeight || 1;
    const perPx = this.viewHeight / h;
    const viewDir = this.target.clone().sub(this.camera.position).normalize();
    const right = new THREE.Vector3().crossVectors(viewDir, this.camera.up).normalize();
    const up = this.camera.up.clone().normalize();
    const move = right.multiplyScalar(-dx * perPx).add(up.multiplyScalar(dy * perPx));
    this.target.add(move);
    this.camera.position.add(move);
  }

  private zoomCenter(factor: number) {
    this.viewHeight = Math.min(Math.max(this.viewHeight * factor, 0.01), 1e6);
    this.updateProjection();
  }

  private zoomAt(clientX: number, clientY: number, factor: number) {
    const { v } = this.ndc(clientX, clientY);
    const p = new THREE.Vector3(v.x, v.y, 0);
    const before = p.clone().unproject(this.camera);
    this.zoomCenter(factor);
    const after = p.clone().unproject(this.camera);
    const shift = before.sub(after);
    this.target.add(shift);
    this.camera.position.add(shift);
  }

  // ------------------------------------------------------------ keyboard helpers
  /** Arrow keys: rotate by an increment about the model center (screen axes). */
  stepRotate(yawDeg: number, pitchDeg: number) {
    this.finishAnim();
    this.pushHistory();
    const saved = this.pivot; this.pivot = null;
    this.rotate((-yawDeg * Math.PI) / 180 / 0.008, (-pitchDeg * Math.PI) / 180 / 0.008);
    this.pivot = saved;
  }
  stepRoll(deg: number) { this.finishAnim(); this.pushHistory(); this.roll((deg * Math.PI) / 180); }
  stepPan(dxPx: number, dyPx: number) { this.finishAnim(); this.pan(dxPx, dyPx); }
  /** Z / Shift+Z */
  stepZoom(zoomIn: boolean) { this.finishAnim(); this.pushHistory(); this.zoomCenter(zoomIn ? 1 / 1.25 : 1.25); }
}
