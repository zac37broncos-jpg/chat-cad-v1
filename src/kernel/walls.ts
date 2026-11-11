/**
 * Wall thickness of a closed, outward-oriented triangle mesh, for the part check's "too thin to
 * print" warning (precision stress test bug 6, plan item A3).
 *
 * Same method as the print checker (verify/print/check_parts.py, wall_thickness): from points on
 * the surface, a ray goes straight inward (against the outward normal) to the first triangle it
 * meets; the distance is the local wall thickness. Here the points are the triangles' centers,
 * each weighted by its triangle's area, so the result does not depend on how finely a face is
 * meshed. Rays are cast through a bounding-volume hierarchy (about log n triangles per ray).
 *
 * The thinnest wall reported is the 1st percentile by area (as in the checker), so a single knife
 * edge or a sliver of a fillet does not decide it, while a wall that is thin over 1% or more of the
 * surface does.
 */

export interface WallThickness {
  /** Thinnest wall: 1st percentile of the thickness over the surface area (mesh units). */
  p1: number;
  /** Thinnest single reading (mesh units). */
  min: number;
  /** Area-weighted median thickness. */
  median: number;
  /** Rays that found the far side of the wall, of those cast. */
  rays: number;
  cast: number;
  /** Share (0..1) of the measured surface area with a wall thinner than each limit asked for. */
  below: number[];
}

const LEAF = 6;

/**
 * @param pos vertex coordinates (x, y, z, ...)
 * @param tri triangles (three vertex indices each), outward normals by the right-hand rule
 * @param limits thicknesses to report the thin area share for (same unit as pos)
 * @param maxRays at most this many triangles are measured (evenly spread over the list)
 */
export function wallThickness(pos: ArrayLike<number>, tri: ArrayLike<number>, limits: number[] = [], maxRays = 20000): WallThickness | null {
  const nT = Math.floor(tri.length / 3);
  if (nT < 4) return null;
  // Per-triangle box and center, for the hierarchy.
  const lo = new Float64Array(3 * nT), hi = new Float64Array(3 * nT), ce = new Float64Array(3 * nT);
  let span = 0;
  {
    const gLo = [Infinity, Infinity, Infinity], gHi = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < nT; t++) {
      for (let a = 0; a < 3; a++) {
        const x0 = pos[3 * tri[3 * t] + a], x1 = pos[3 * tri[3 * t + 1] + a], x2 = pos[3 * tri[3 * t + 2] + a];
        lo[3 * t + a] = Math.min(x0, x1, x2); hi[3 * t + a] = Math.max(x0, x1, x2); ce[3 * t + a] = (x0 + x1 + x2) / 3;
        gLo[a] = Math.min(gLo[a], lo[3 * t + a]); gHi[a] = Math.max(gHi[a], hi[3 * t + a]);
      }
    }
    span = Math.max(gHi[0] - gLo[0], gHi[1] - gLo[1], gHi[2] - gLo[2]);
  }
  if (!(span > 0)) return null;

  // Bounding-volume hierarchy: nodes hold a box and either two children or a run of `order`.
  const order = new Int32Array(nT); for (let i = 0; i < nT; i++) order[i] = i;
  const nLo: number[] = [], nHi: number[] = [], nLeft: number[] = [], nStart: number[] = [], nCount: number[] = [];
  const right: number[] = [];
  {
    const build = (start: number, count: number): number => {
      const id = nLeft.length;
      const bl = [Infinity, Infinity, Infinity], bh = [-Infinity, -Infinity, -Infinity];
      for (let k = start; k < start + count; k++) {
        const t = order[k];
        for (let a = 0; a < 3; a++) { bl[a] = Math.min(bl[a], lo[3 * t + a]); bh[a] = Math.max(bh[a], hi[3 * t + a]); }
      }
      nLo.push(...bl); nHi.push(...bh); nLeft.push(-1); nStart.push(start); nCount.push(count); right.push(-1);
      if (count <= LEAF) return id;
      const ax = bh[0] - bl[0] >= bh[1] - bl[1] && bh[0] - bl[0] >= bh[2] - bl[2] ? 0 : bh[1] - bl[1] >= bh[2] - bl[2] ? 1 : 2;
      const part = order.subarray(start, start + count);
      const sorted = Array.from(part).sort((p, q) => ce[3 * p + ax] - ce[3 * q + ax]);
      part.set(sorted);
      const half = count >> 1;
      nLeft[id] = build(start, half);
      right[id] = build(start + half, count - half);
      nCount[id] = 0;
      return id;
    };
    build(0, nT);
  }

  // Ray against one triangle (Moller-Trumbore); distance along the unit direction, or Infinity.
  const hitTri = (t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number => {
    const a = 3 * tri[3 * t], b = 3 * tri[3 * t + 1], c = 3 * tri[3 * t + 2];
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det === 0) return Infinity;
    const inv = 1 / det;
    const sx = ox - pos[a], sy = oy - pos[a + 1], sz = oz - pos[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return Infinity;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return Infinity;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return d > 0 ? d : Infinity;
  };
  const boxEntry = (n: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, best: number): boolean => {
    let t0 = 0, t1 = best;
    const o = [ox, oy, oz], iv = [ix, iy, iz];
    for (let a = 0; a < 3; a++) {
      let ta = (nLo[3 * n + a] - o[a]) * iv[a], tb = (nHi[3 * n + a] - o[a]) * iv[a];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (Number.isNaN(ta) || Number.isNaN(tb)) { if (o[a] < nLo[3 * n + a] || o[a] > nHi[3 * n + a]) return false; continue; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
    return true;
  };
  const cast = (self: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number => {
    let best = Infinity;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      if (!boxEntry(n, ox, oy, oz, ix, iy, iz, best)) continue;
      if (nLeft[n] < 0) {
        for (let k = nStart[n]; k < nStart[n] + nCount[n]; k++) {
          const t = order[k];
          if (t === self) continue;
          const d = hitTri(t, ox, oy, oz, dx, dy, dz);
          if (d < best) best = d;
        }
      } else { stack.push(nLeft[n], right[n]); }
    }
    return best;
  };

  // Measure: from just inside each (sampled) triangle's center, straight inward.
  const eps = Math.min(1e-4, span * 1e-6);
  const step = Math.max(1, Math.ceil(nT / maxRays));
  const th: number[] = [], wt: number[] = [];
  let castN = 0;
  for (let t = 0; t < nT; t += step) {
    const a = 3 * tri[3 * t], b = 3 * tri[3 * t + 1], c = 3 * tri[3 * t + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) continue;
    castN++;
    const dx = -nx / l, dy = -ny / l, dz = -nz / l;
    const ox = ce[3 * t] + eps * dx, oy = ce[3 * t + 1] + eps * dy, oz = ce[3 * t + 2] + eps * dz;
    const d = cast(t, ox, oy, oz, dx, dy, dz);
    if (!Number.isFinite(d)) continue; // a ray that slipped through a shared edge: no reading
    th.push(d + eps); wt.push(l / 2);
  }
  if (!th.length) return null;
  const idx = th.map((_, i) => i).sort((p, q) => th[p] - th[q]);
  const total = wt.reduce((s, w) => s + w, 0);
  const pct = (q: number) => {
    let acc = 0;
    for (const i of idx) { acc += wt[i]; if (acc >= q * total) return th[i]; }
    return th[idx[idx.length - 1]];
  };
  const below = limits.map((lim) => { let s = 0; for (let i = 0; i < th.length; i++) if (th[i] < lim) s += wt[i]; return s / total; });
  return { p1: pct(0.01), min: th[idx[0]], median: pct(0.5), rays: th.length, cast: castN, below };
}
