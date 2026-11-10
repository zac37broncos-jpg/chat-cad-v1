/**
 * Self-intersection check for a closed triangle mesh (an STL about to be saved).
 *
 * A mesh can be closed, manifold and consistently oriented and still have triangles that pass
 * through each other: a fold where the mesher put a few triangles of one face outside the face's
 * real border (found on the Easter Island head in the print verification of 2026-11-06, see
 * docs/PRINT_VERIFICATION.md), or two bodies that overlap without being joined. Slicers usually
 * print such a file, but it is not the part as designed, and mesh tools (MeshLab, Netfabb) flag it.
 *
 * Two triangles that do not share a corner intersect when an edge of one crosses the other. With
 * one shared corner they intersect when the edge opposite that corner crosses the other triangle.
 * Triangles sharing an edge are neighbours and are not tested (a fold there shows up as a flipped
 * edge in checkMesh). Touching and coplanar contacts are not counted: only proper crossings, decided
 * by the signs of exact-enough orientation determinants on the file's float32 coordinates.
 *
 * Candidate pairs come from a bounding-volume hierarchy over the triangles' boxes, so the check
 * costs about n log n: a few seconds for a million triangles.
 */

export interface SelfIntersections {
  /** Triangles that cross at least one other triangle. */
  triangles: number;
  /** Crossing pairs found. */
  pairs: number;
  /** Centers of a few crossing triangles (same unit as the input), to say where. */
  where: [number, number, number][];
  /** Indices of the crossing triangles (at most `maxHits`). */
  hits: number[];
}

const LEAF = 8;

/** Sign of the orientation of point d against the plane through a, b, c (0 when too close to tell). */
function orient(P: ArrayLike<number>, a: number, b: number, c: number, d: number): number {
  const ax = P[a] - P[d], ay = P[a + 1] - P[d + 1], az = P[a + 2] - P[d + 2];
  const bx = P[b] - P[d], by = P[b + 1] - P[d + 1], bz = P[b + 2] - P[d + 2];
  const cx = P[c] - P[d], cy = P[c + 1] - P[d + 1], cz = P[c + 2] - P[d + 2];
  const t1 = ax * (by * cz - bz * cy), t2 = ay * (bz * cx - bx * cz), t3 = az * (bx * cy - by * cx);
  const det = t1 + t2 + t3;
  // Rounding error bound of the determinant (Shewchuk's static filter, with a safety factor):
  // below it the sign is not trusted and the point counts as on the plane.
  const perm = (Math.abs(by * cz) + Math.abs(bz * cy)) * Math.abs(ax) + (Math.abs(bz * cx) + Math.abs(bx * cz)) * Math.abs(ay) + (Math.abs(bx * cy) + Math.abs(by * cx)) * Math.abs(az);
  const bound = 1e-14 * perm;
  return det > bound ? 1 : det < -bound ? -1 : 0;
}

/** Does segment p-q (vertex offsets ×3) properly cross triangle a, b, c? */
function segmentCrosses(P: ArrayLike<number>, p: number, q: number, a: number, b: number, c: number): boolean {
  const s1 = orient(P, a, b, c, p), s2 = orient(P, a, b, c, q);
  if (s1 === 0 || s2 === 0 || s1 === s2) return false;
  const t1 = orient(P, p, q, a, b), t2 = orient(P, p, q, b, c), t3 = orient(P, p, q, c, a);
  return t1 !== 0 && t1 === t2 && t2 === t3;
}

/** Do triangles i and j cross each other? `tri` holds corner indices, P the coordinates. */
function trianglesCross(P: ArrayLike<number>, tri: ArrayLike<number>, i: number, j: number): boolean {
  const A = [tri[3 * i], tri[3 * i + 1], tri[3 * i + 2]];
  const B = [tri[3 * j], tri[3 * j + 1], tri[3 * j + 2]];
  let shared = 0;
  for (const a of A) if (a === B[0] || a === B[1] || a === B[2]) shared++;
  if (shared >= 2) return false; // neighbours across an edge (or a duplicate): checkMesh's business
  const a = A.map((x) => 3 * x), b = B.map((x) => 3 * x);
  for (let k = 0; k < 3; k++) {
    const p = a[k], q = a[(k + 1) % 3];
    if (segmentCrosses(P, p, q, b[0], b[1], b[2])) return true;
    const r = b[k], s = b[(k + 1) % 3];
    if (segmentCrosses(P, r, s, a[0], a[1], a[2])) return true;
  }
  return false;
}

/** Find triangles that pass through other triangles. `pos` = x, y, z per vertex; `tri` = 3 vertex indices per triangle. */
export function selfIntersections(pos: ArrayLike<number>, tri: ArrayLike<number>, maxWhere = 5, maxHits = 200): SelfIntersections {
  const n = Math.floor(tri.length / 3);
  if (n < 2) return { triangles: 0, pairs: 0, where: [], hits: [] };
  // Triangle boxes and centers.
  const lo = new Float64Array(3 * n), hi = new Float64Array(3 * n), ctr = new Float64Array(3 * n);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const x0 = pos[3 * tri[3 * t] + k], x1 = pos[3 * tri[3 * t + 1] + k], x2 = pos[3 * tri[3 * t + 2] + k];
      lo[3 * t + k] = Math.min(x0, x1, x2); hi[3 * t + k] = Math.max(x0, x1, x2); ctr[3 * t + k] = (x0 + x1 + x2) / 3;
    }
  }
  // Bounding-volume hierarchy (midpoint split of the centers on the longest axis).
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const cap = 2 * Math.ceil(n / LEAF) * 2 + 16;
  let nodeLo = new Float64Array(3 * cap), nodeHi = new Float64Array(3 * cap);
  let nodeStart = new Int32Array(cap), nodeCount = new Int32Array(cap), nodeLeft = new Int32Array(cap);
  let nodes = 0;
  const grow = () => {
    const c2 = nodeStart.length * 2;
    const f = (a: Float64Array) => { const b = new Float64Array(3 * c2); b.set(a); return b; };
    const g = (a: Int32Array) => { const b = new Int32Array(c2); b.set(a); return b; };
    nodeLo = f(nodeLo); nodeHi = f(nodeHi); nodeStart = g(nodeStart); nodeCount = g(nodeCount); nodeLeft = g(nodeLeft);
  };
  const make = (start: number, count: number) => {
    if (nodes >= nodeStart.length) grow();
    const id = nodes++;
    let l0 = Infinity, l1 = Infinity, l2 = Infinity, h0 = -Infinity, h1 = -Infinity, h2 = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = 3 * order[i];
      if (lo[t] < l0) l0 = lo[t]; if (lo[t + 1] < l1) l1 = lo[t + 1]; if (lo[t + 2] < l2) l2 = lo[t + 2];
      if (hi[t] > h0) h0 = hi[t]; if (hi[t + 1] > h1) h1 = hi[t + 1]; if (hi[t + 2] > h2) h2 = hi[t + 2];
    }
    nodeLo[3 * id] = l0; nodeLo[3 * id + 1] = l1; nodeLo[3 * id + 2] = l2;
    nodeHi[3 * id] = h0; nodeHi[3 * id + 1] = h1; nodeHi[3 * id + 2] = h2;
    nodeStart[id] = start; nodeCount[id] = count; nodeLeft[id] = -1;
    return id;
  };
  const root = make(0, n);
  const work = [root];
  while (work.length) {
    const id = work.pop()!;
    const start = nodeStart[id], count = nodeCount[id];
    if (count <= LEAF) continue;
    // Split on the longest axis of the centers' box at its middle; fall back to halving the list.
    let c0 = Infinity, c1 = -Infinity, axis = 0, span = -1;
    for (let k = 0; k < 3; k++) {
      let mn = Infinity, mx = -Infinity;
      for (let i = start; i < start + count; i++) { const v = ctr[3 * order[i] + k]; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mx - mn > span) { span = mx - mn; axis = k; c0 = mn; c1 = mx; }
    }
    const mid = (c0 + c1) / 2;
    let i = start, j = start + count - 1;
    while (i <= j) {
      if (ctr[3 * order[i] + axis] < mid) i++;
      else { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--; }
    }
    let leftCount = i - start;
    if (leftCount === 0 || leftCount === count) leftCount = count >> 1; // all centers equal on that axis
    const L = make(start, leftCount), R = make(start + leftCount, count - leftCount);
    nodeLeft[id] = L;
    if (R !== L + 1) throw new Error('bvh layout');
    work.push(L, R);
  }
  // Query every triangle's box against the tree; test each pair once (j > i).
  const hit = new Uint8Array(n);
  let pairs = 0;
  let stack = new Int32Array(256);
  for (let t = 0; t < n; t++) {
    const tl0 = lo[3 * t], tl1 = lo[3 * t + 1], tl2 = lo[3 * t + 2], th0 = hi[3 * t], th1 = hi[3 * t + 1], th2 = hi[3 * t + 2];
    let sp = 0;
    stack[sp++] = root;
    while (sp) {
      const id = stack[--sp];
      if (nodeLo[3 * id] > th0 || nodeHi[3 * id] < tl0 || nodeLo[3 * id + 1] > th1 || nodeHi[3 * id + 1] < tl1 || nodeLo[3 * id + 2] > th2 || nodeHi[3 * id + 2] < tl2) continue;
      if (nodeLeft[id] < 0) {
        for (let k = nodeStart[id]; k < nodeStart[id] + nodeCount[id]; k++) {
          const u = order[k];
          if (u <= t) continue;
          if (lo[3 * u] > th0 || hi[3 * u] < tl0 || lo[3 * u + 1] > th1 || hi[3 * u + 1] < tl1 || lo[3 * u + 2] > th2 || hi[3 * u + 2] < tl2) continue;
          if (trianglesCross(pos, tri, t, u)) { pairs++; hit[t] = 1; hit[u] = 1; }
        }
      } else {
        if (sp + 2 > stack.length) { const bigger = new Int32Array(stack.length * 2); bigger.set(stack); stack = bigger; }
        stack[sp++] = nodeLeft[id]; stack[sp++] = nodeLeft[id] + 1;
      }
    }
  }
  let triangles = 0;
  const where: [number, number, number][] = [];
  const hits: number[] = [];
  for (let t = 0; t < n; t++) {
    if (!hit[t]) continue;
    triangles++;
    if (where.length < maxWhere) where.push([ctr[3 * t], ctr[3 * t + 1], ctr[3 * t + 2]]);
    if (hits.length < maxHits) hits.push(t);
  }
  return { triangles, pairs, where, hits };
}
