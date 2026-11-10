/**
 * Offscreen renders of the part for the AI chat (view_model): the same shaded
 * look as the viewport, from standard directions, independent of whatever the
 * user is doing in the main view (sketching, previewing, zoomed in).
 * Z is up, the front of a model faces -Y.
 */
import * as THREE from 'three';
import type { MeshData } from '../kernel/query';

export type SnapshotView =
  | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'
  | 'three_quarter' | 'three_quarter_left' | 'three_quarter_back' | 'below';

/** Direction from the model toward the camera, and the camera's up. */
const DIRS: Record<SnapshotView, { dir: [number, number, number]; up: [number, number, number] }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [1, -1, 1], up: [0, 0, 1] },
  three_quarter: { dir: [0.75, -1, 0.3], up: [0, 0, 1] },
  three_quarter_left: { dir: [-0.75, -1, 0.3], up: [0, 0, 1] },
  three_quarter_back: { dir: [0.75, 1, 0.3], up: [0, 0, 1] },
  below: { dir: [0.4, -1, -0.6], up: [0, 0, 1] },
};
export const SNAPSHOT_VIEWS = Object.keys(DIRS) as SnapshotView[];

let renderer: THREE.WebGLRenderer | null = null;
function getRenderer(size: number): THREE.WebGLRenderer {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, canvas: document.createElement('canvas') });
    renderer.setPixelRatio(1);
  }
  renderer.setSize(size, size, false);
  return renderer;
}

export interface Snapshot { view: SnapshotView; png: string /* base64, no data: prefix */ }

/**
 * Render the mesh from each view at size x size pixels, fitted to the part
 * with a small margin. Faces are light grey with soft studio lighting so the
 * form reads clearly; feature edges are drawn thin and darker.
 */
export function renderSnapshots(mesh: MeshData, views: SnapshotView[], size = 512, edges = true): Snapshot[] {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#eef1f5');
  const mat = new THREE.MeshStandardMaterial({
    color: '#c4ccd6', metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const geoms: THREE.BufferGeometry[] = [];
  const pts: number[][] = [];
  for (const f of mesh.faces) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(f.normals, 3));
    g.setIndex(new THREE.BufferAttribute(f.indices, 1));
    geoms.push(g);
    scene.add(new THREE.Mesh(g, mat));
    pts.push(f.positions as unknown as number[]);
  }
  const edgeMat = new THREE.LineBasicMaterial({ color: '#5c6670', transparent: true, opacity: 0.55 });
  if (edges) for (const e of mesh.edges) {
    if (e.seam) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(e.points, 3));
    geoms.push(g);
    scene.add(new THREE.Line(g, edgeMat));
  }
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8896, 1.35));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-1, 1.2, 2); // upper left of the view, toward the viewer
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(1.5, -0.3, 1);
  cam.add(key, fill);
  scene.add(cam);

  const box = new THREE.Box3();
  for (const p of pts) for (let i = 0; i < p.length; i += 3) box.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
  const center = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const out: Snapshot[] = [];
  const ren = getRenderer(size);
  for (const v of views) {
    const d = DIRS[v];
    if (!d) continue;
    const dir = new THREE.Vector3(...d.dir).normalize();
    cam.up.set(...d.up);
    cam.position.copy(center).addScaledVector(dir, r * 4);
    cam.lookAt(center);
    cam.updateMatrixWorld(true);
    // Fit the projected part (all vertices) with a 6% margin.
    const inv = cam.matrixWorldInverse;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const q = new THREE.Vector3();
    for (const p of pts) for (let i = 0; i < p.length; i += 3) {
      q.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(inv);
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
    }
    const half = Math.max(x1 - x0, y1 - y0, 1e-3) * 0.53;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    cam.left = cx - half; cam.right = cx + half; cam.bottom = cy - half; cam.top = cy + half;
    cam.updateProjectionMatrix();
    ren.render(scene, cam);
    out.push({ view: v, png: ren.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, '') });
  }
  for (const g of geoms) g.dispose();
  mat.dispose(); edgeMat.dispose();
  return out;
}
