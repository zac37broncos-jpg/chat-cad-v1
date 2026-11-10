/**
 * Draws the sketch being edited on top of the model (wide anti-aliased
 * lines, point markers, previews, inference guides, dimension graphics) and
 * converts mouse positions to sketch-plane coordinates. All geometry it
 * receives is in sketch (u, v) millimeters; the frame places it in 3D.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Viewport } from './viewport';
import type { Frame } from '../kernel/regen';

export type P2 = [number, number];

export interface OverlayPolyline { pts: P2[]; color: string; width?: number; dashed?: boolean; opacity?: number }
export interface OverlayPoint { p: P2; color: string; size?: number; shape?: 'square' | 'circle' }
export interface OverlayScene { lines: OverlayPolyline[]; points: OverlayPoint[] }

export class SketchOverlay {
  private group = new THREE.Group();
  private frame: Frame | null = null;
  private materials: LineMaterial[] = [];
  private raf = 0;
  private lastCam = '';
  /** Called when the camera moves (so HTML labels can be repositioned). */
  onCameraChange: () => void = () => {};

  constructor(readonly vp: Viewport) {
    this.group.renderOrder = 10;
    vp.scene.add(this.group);
    const tick = () => {
      const m = vp.camera.matrixWorld.elements.join(',') + vp.camera.top + vp.camera.right + this.canvas.clientWidth + this.canvas.clientHeight;
      if (m !== this.lastCam) { this.lastCam = m; this.updateResolution(); this.onCameraChange(); }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  get canvas(): HTMLCanvasElement { return this.vp.renderer.domElement; }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.clear();
    this.vp.scene.remove(this.group);
  }

  setFrame(fr: Frame | null) { this.frame = fr; }

  private to3(p: P2): THREE.Vector3 {
    const { o, x, y } = this.frame!;
    return new THREE.Vector3(o[0] + x[0] * p[0] + y[0] * p[1], o[1] + x[1] * p[0] + y[1] * p[1], o[2] + x[2] * p[0] + y[2] * p[1]);
  }

  /** Millimeters per screen pixel at the current zoom (orthographic camera). */
  mmPerPixel(): number {
    const cam = this.vp.camera;
    return (cam.top - cam.bottom) / cam.zoom / (this.canvas.clientHeight || 1);
  }

  /** Mouse position -> sketch plane (u, v) in mm, or null if the view is edge-on to the plane. */
  toSketch(clientX: number, clientY: number): P2 | null {
    if (!this.frame) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.vp.camera);
    const { o, x, y, n } = this.frame;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...n), new THREE.Vector3(...o));
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) {
      // Ray parallel to the plane or plane behind: use the closest point of the ray instead.
      const t = ray.ray.origin.clone().sub(new THREE.Vector3(...o));
      return [t.dot(new THREE.Vector3(...x)), t.dot(new THREE.Vector3(...y))];
    }
    const d = hit.sub(new THREE.Vector3(...o));
    return [d.dot(new THREE.Vector3(...x)), d.dot(new THREE.Vector3(...y))];
  }

  /** Sketch (u, v) -> pixel position inside the viewport host element. */
  toScreen(p: P2): [number, number] {
    const v = this.to3(p).project(this.vp.camera);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
  }

  private updateResolution() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    for (const m of this.materials) m.resolution.set(w, h);
  }

  private clear() {
    for (const o of this.group.children) {
      const any = o as any;
      any.geometry?.dispose?.();
      if (any.material && !this.materials.includes(any.material)) any.material.dispose?.();
    }
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.group.clear();
  }

  draw(scene: OverlayScene) {
    this.clear();
    if (!this.frame) return;
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    for (const l of scene.lines) {
      if (l.pts.length < 2) continue;
      const g = new LineGeometry();
      g.setPositions(l.pts.flatMap((p) => this.to3(p).toArray()));
      const mat = new LineMaterial({
        color: new THREE.Color(l.color).getHex(), linewidth: l.width ?? 2, worldUnits: false,
        dashed: !!l.dashed, dashSize: 8 * this.mmPerPixel(), gapSize: 5 * this.mmPerPixel(),
        transparent: l.opacity !== undefined, opacity: l.opacity ?? 1, depthTest: false, depthWrite: false,
      });
      mat.resolution.set(w, h);
      this.materials.push(mat);
      const line = new Line2(g, mat);
      if (l.dashed) line.computeLineDistances();
      line.renderOrder = 10;
      this.group.add(line);
    }
    for (const p of scene.points) {
      const g = new THREE.BufferGeometry().setFromPoints([this.to3(p.p)]);
      const mat = new THREE.PointsMaterial({ color: p.color, size: p.size ?? 6, sizeAttenuation: false, depthTest: false, depthWrite: false });
      const pts = new THREE.Points(g, mat);
      pts.renderOrder = 11;
      this.group.add(pts);
    }
  }
}
