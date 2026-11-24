import * as THREE from 'three';
import { marchingCubes } from './marchingCubes';
import { MeshStats } from './types';

function ensureNonIndexedOrIndexedArrays(geometry: THREE.BufferGeometry): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) {
    return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  }
  const positions = new Float32Array(posAttr.count * 3);
  for (let i = 0; i < posAttr.count; i++) {
    positions[i * 3] = posAttr.getX(i);
    positions[i * 3 + 1] = posAttr.getY(i);
    positions[i * 3 + 2] = posAttr.getZ(i);
  }

  const indexAttr = geometry.getIndex();
  if (indexAttr) {
    const indices = new Uint32Array(indexAttr.count);
    for (let i = 0; i < indexAttr.count; i++) {
      indices[i] = indexAttr.getX(i);
    }
    return { positions, indices };
  }

  const indices = new Uint32Array(posAttr.count);
  for (let i = 0; i < posAttr.count; i++) {
    indices[i] = i;
  }
  return { positions, indices };
}

export function signedMeshVolume(positions: Float32Array, indices: Uint32Array): number {
  let vol6 = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];

    vol6 +=
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
  }
  return vol6 / 6;
}

/**
 * Welds duplicate vertices within `tolerance` and removes degenerate or duplicate triangles.
 */
export function weldVertices(
  geometry: THREE.BufferGeometry,
  tolerance = 1e-4
): THREE.BufferGeometry {
  const { positions, indices } = ensureNonIndexedOrIndexedArrays(geometry);
  if (positions.length === 0 || indices.length < 3) return geometry.clone();

  const invTol = 1 / Math.max(1e-7, tolerance);
  const vertMap = new Map<string, number>();
  const remap = new Uint32Array(positions.length / 3);
  const newPositions: number[] = [];

  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const key = `${Math.round(x * invTol)},${Math.round(y * invTol)},${Math.round(z * invTol)}`;
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = newPositions.length / 3;
      vertMap.set(key, idx);
      newPositions.push(x, y, z);
    }
    remap[i] = idx;
  }

  const newIndices: number[] = [];
  const seenTris = new Set<string>();

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i]];
    const b = remap[indices[i + 1]];
    const c = remap[indices[i + 2]];
    if (a === b || b === c || c === a) continue;

    // Area check
    const ax = newPositions[a * 3], ay = newPositions[a * 3 + 1], az = newPositions[a * 3 + 2];
    const bx = newPositions[b * 3], by = newPositions[b * 3 + 1], bz = newPositions[b * 3 + 2];
    const cx = newPositions[c * 3], cy = newPositions[c * 3 + 1], cz = newPositions[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) continue;

    // Canonical undirected face key to skip exact duplicate triangles
    const sorted = [a, b, c].sort((p, q) => p - q);
    const triKey = `${sorted[0]}:${sorted[1]}:${sorted[2]}`;
    if (seenTris.has(triKey)) continue;
    seenTris.add(triKey);

    newIndices.push(a, b, c);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
  out.setIndex(newIndices);
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * Inspects geometry topology, watertightness, physical dimensions in mm, volume in cm³,
 * and 3D printability score.
 */
export function analyzeMesh(geometry: THREE.BufferGeometry): MeshStats {
  const welded = weldVertices(geometry, 1e-4);
  const { positions, indices } = ensureNonIndexedOrIndexedArrays(welded);

  welded.computeBoundingBox();
  const box = welded.boundingBox;
  const size = new THREE.Vector3();
  if (box && !box.isEmpty()) {
    box.getSize(size);
  }

  const edgeCounts = new Map<string, number>();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const u = tri[e];
      const v = tri[(e + 1) % 3];
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  let openBoundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) openBoundaryEdges++;
    else if (count > 2) nonManifoldEdges++;
  }

  const triangleCount = Math.floor(indices.length / 3);
  const vertexCount = Math.floor(positions.length / 3);
  const rawVolMm3 = Math.abs(signedMeshVolume(positions, indices));
  const volumeCm3 = rawVolMm3 / 1000;
  const estimatedPlaGrams = volumeCm3 * 1.24; // 100% doluluk PLA yoğunluğu (1.24 g/cm³)

  const isWatertight = triangleCount > 0 && openBoundaryEdges === 0 && nonManifoldEdges === 0;

  let score = 100;
  if (triangleCount === 0) score = 0;
  else {
    if (openBoundaryEdges > 0) score -= Math.min(45, 15 + openBoundaryEdges * 2);
    if (nonManifoldEdges > 0) score -= Math.min(35, 10 + nonManifoldEdges * 2);
    if (Math.min(size.x, size.y, size.z) < 0.8) score -= 10;
  }

  welded.dispose();

  return {
    vertexCount,
    triangleCount,
    widthMm: Number(size.x.toFixed(2)),
    heightMm: Number(size.y.toFixed(2)),
    depthMm: Number(size.z.toFixed(2)),
    volumeCm3: Number(volumeCm3.toFixed(2)),
    estimatedPlaGrams: Number(estimatedPlaGrams.toFixed(2)),
    openBoundaryEdges,
    nonManifoldEdges,
    isWatertight,
    printabilityScore: Math.max(0, Math.round(score)),
  };
}

/**
 * Repairs a mesh by welding vertices, capping open boundary loops,
 * and ensuring positive outward-facing triangle winding.
 */
export function repairMesh(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const welded = weldVertices(geometry, 1e-4);
  const { positions: posArr, indices: idxArr } = ensureNonIndexedOrIndexedArrays(welded);
  welded.dispose();

  const positions = Array.from(posArr);
  const indices = Array.from(idxArr);

  // Find directed edges whose reverse is missing (open boundaries)
  const directedSet = new Set<string>();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    directedSet.add(`${a}->${b}`);
    directedSet.add(`${b}->${c}`);
    directedSet.add(`${c}->${a}`);
  }

  const boundaryNext = new Map<number, number[]>();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const u = tri[e];
      const v = tri[(e + 1) % 3];
      if (!directedSet.has(`${v}->${u}`)) {
        const list = boundaryNext.get(u);
        if (list) list.push(v);
        else boundaryNext.set(u, [v]);
      }
    }
  }

  // Chain boundary loops and cap each with centroid fan
  const visitedEdges = new Set<string>();
  for (const [startU, nexts] of boundaryNext.entries()) {
    for (const firstV of nexts) {
      const edgeKey = `${startU}->${firstV}`;
      if (visitedEdges.has(edgeKey)) continue;

      const loop: number[] = [startU];
      let currU = startU;
      let currV = firstV;
      let guard = 0;

      while (guard++ < 50000) {
        visitedEdges.add(`${currU}->${currV}`);
        if (currV === startU) break;
        loop.push(currV);

        const candidates = boundaryNext.get(currV);
        if (!candidates || candidates.length === 0) break;
        const nextV = candidates.find((cand) => !visitedEdges.has(`${currV}->${cand}`));
        if (nextV === undefined) break;
        currU = currV;
        currV = nextV;
      }

      if (loop.length >= 3) {
        let cx = 0, cy = 0, cz = 0;
        for (const vi of loop) {
          cx += positions[vi * 3];
          cy += positions[vi * 3 + 1];
          cz += positions[vi * 3 + 2];
        }
        const inv = 1 / loop.length;
        const centerIdx = positions.length / 3;
        positions.push(cx * inv, cy * inv, cz * inv);

        for (let k = 0; k < loop.length; k++) {
          const u = loop[k];
          const v = loop[(k + 1) % loop.length];
          // Reverse edge v -> u -> center matches adjacent face u -> v
          indices.push(v, u, centerIdx);
        }
      }
    }
  }

  // Verify outward winding via signed volume
  const fPos = new Float32Array(positions);
  const fIdx = new Uint32Array(indices);
  if (signedMeshVolume(fPos, fIdx) < 0) {
    for (let i = 0; i + 2 < fIdx.length; i += 3) {
      const tmp = fIdx[i + 1];
      fIdx[i + 1] = fIdx[i + 2];
      fIdx[i + 2] = tmp;
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(fPos, 3));
  out.setIndex(Array.from(fIdx));
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * Re-meshes any arbitrary/broken triangle soup into a guaranteed 100% watertight
 * solid mesh via Z-column parity voxelization + Marching Cubes.
 */
export function voxelRemesh(
  geometry: THREE.BufferGeometry,
  resolution = 64
): THREE.BufferGeometry {
  const res = Math.max(20, Math.min(128, Math.round(resolution)));
  const { positions, indices } = ensureNonIndexedOrIndexedArrays(geometry);
  if (indices.length < 3) {
    throw new Error('Yeniden ağ oluşturmak için geçerli üçgen bulunamadı.');
  }

  geometry.computeBoundingBox();
  const box = geometry.boundingBox!.clone();
  const size = new THREE.Vector3();
  box.getSize(size);

  const maxSpan = Math.max(size.x, size.y, size.z, 1e-3);
  const padWorld = maxSpan * 0.08;
  const minB: [number, number, number] = [
    box.min.x - padWorld,
    box.min.y - padWorld,
    box.min.z - padWorld,
  ];
  const maxB: [number, number, number] = [
    box.max.x + padWorld,
    box.max.y + padWorld,
    box.max.z + padWorld,
  ];

  const nx = res;
  const ny = res;
  const nz = res;
  const dx = (maxB[0] - minB[0]) / (nx - 1);
  const dy = (maxB[1] - minB[1]) / (ny - 1);
  const dz = (maxB[2] - minB[2]) / (nz - 1);

  // Collect Z intersections per (x, y) column
  const columns: number[][] = Array.from({ length: nx * ny }, () => []);

  // Tiny deterministic offset prevents exact edge/vertex ray hits
  const epsX = dx * 0.0137;
  const epsY = dy * 0.0193;

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];

    const triMinX = Math.min(ax, bx, cx);
    const triMaxX = Math.max(ax, bx, cx);
    const triMinY = Math.min(ay, by, cy);
    const triMaxY = Math.max(ay, by, cy);

    const ix0 = Math.max(1, Math.floor((triMinX - minB[0]) / dx));
    const ix1 = Math.min(nx - 2, Math.ceil((triMaxX - minB[0]) / dx));
    const iy0 = Math.max(1, Math.floor((triMinY - minB[1]) / dy));
    const iy1 = Math.min(ny - 2, Math.ceil((triMaxY - minB[1]) / dy));

    const v0x = bx - ax, v0y = by - ay;
    const v1x = cx - ax, v1y = cy - ay;
    const denom = v0x * v1y - v1x * v0y;
    if (Math.abs(denom) < 1e-12) continue;
    const invDenom = 1 / denom;

    for (let iy = iy0; iy <= iy1; iy++) {
      const py = minB[1] + iy * dy + epsY;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = minB[0] + ix * dx + epsX;
        const v2x = px - ax;
        const v2y = py - ay;

        const u = (v2x * v1y - v1x * v2y) * invDenom;
        const v = (v0x * v2y - v2x * v0y) * invDenom;
        if (u >= 0 && v >= 0 && u + v <= 1) {
          const w = 1 - u - v;
          const pz = w * az + u * bz + v * cz;
          columns[iy * nx + ix].push(pz);
        }
      }
    }
  }

  const field = new Float32Array(nx * ny * nz);
  const strideZ = nx * ny;

  for (let iy = 1; iy < ny - 1; iy++) {
    for (let ix = 1; ix < nx - 1; ix++) {
      const hits = columns[iy * nx + ix];
      if (hits.length < 2) continue;
      hits.sort((p, q) => p - q);
      for (let k = 0; k + 1 < hits.length; k += 2) {
        const zStart = Math.max(1, Math.ceil((hits[k] - minB[2]) / dz));
        const zEnd = Math.min(nz - 2, Math.floor((hits[k + 1] - minB[2]) / dz));
        for (let iz = zStart; iz <= zEnd; iz++) {
          field[iz * strideZ + iy * nx + ix] = 1.0;
        }
      }
    }
  }

  // Gentle 1-pass smoothing for clean surface normals
  const smoothed = new Float32Array(field.length);
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const base = z * strideZ + y * nx + x;
        const sum =
          field[base] * 4 +
          field[base - 1] +
          field[base + 1] +
          field[base - nx] +
          field[base + nx] +
          field[base - strideZ] +
          field[base + strideZ];
        smoothed[base] = sum / 10;
      }
    }
  }

  const remeshed = marchingCubes(smoothed, nx, ny, nz, 0.48, minB, maxB);
  return placeOnBuildPlate(remeshed);
}

/**
 * Volume-preserving Taubin smoothing (alternates positive lambda and negative mu passes).
 */
export function taubinSmooth(
  geometry: THREE.BufferGeometry,
  iterations = 3,
  lambda = 0.5,
  mu = -0.53
): THREE.BufferGeometry {
  if (iterations <= 0) return geometry.clone();
  const welded = weldVertices(geometry, 1e-4);
  const { positions, indices } = ensureNonIndexedOrIndexedArrays(welded);
  welded.dispose();

  const vertCount = positions.length / 3;
  const neighbors: Set<number>[] = Array.from({ length: vertCount }, () => new Set<number>());

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    neighbors[a].add(b); neighbors[a].add(c);
    neighbors[b].add(a); neighbors[b].add(c);
    neighbors[c].add(a); neighbors[c].add(b);
  }

  let curr = new Float32Array(positions);
  let next = new Float32Array(positions.length);

  const step = (factor: number) => {
    for (let i = 0; i < vertCount; i++) {
      const nb = neighbors[i];
      if (nb.size === 0) {
        next[i * 3] = curr[i * 3];
        next[i * 3 + 1] = curr[i * 3 + 1];
        next[i * 3 + 2] = curr[i * 3 + 2];
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      for (const n of nb) {
        sx += curr[n * 3];
        sy += curr[n * 3 + 1];
        sz += curr[n * 3 + 2];
      }
      const inv = 1 / nb.size;
      const cx = curr[i * 3];
      const cy = curr[i * 3 + 1];
      const cz = curr[i * 3 + 2];
      next[i * 3] = cx + factor * (sx * inv - cx);
      next[i * 3 + 1] = cy + factor * (sy * inv - cy);
      next[i * 3 + 2] = cz + factor * (sz * inv - cz);
    }
    const tmp = curr;
    curr = next;
    next = tmp;
  };

  for (let it = 0; it < iterations; it++) {
    step(lambda);
    step(mu);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(curr, 3));
  out.setIndex(Array.from(indices));
  out.computeVertexNormals();
  return placeOnBuildPlate(out);
}

/**
 * Reduces polygon count using spatial vertex clustering while preserving closed manifold topology.
 */
export function simplifyMesh(
  geometry: THREE.BufferGeometry,
  targetRatio = 0.5
): THREE.BufferGeometry {
  const ratio = Math.max(0.1, Math.min(0.95, targetRatio));
  const stats = analyzeMesh(geometry);
  if (stats.triangleCount <= 100) return geometry.clone();

  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxSpan = Math.max(size.x, size.y, size.z, 1e-3);

  // Estimate grid cell size based on target vertex count
  const targetVerts = Math.max(24, stats.vertexCount * ratio);
  const cellsPerAxis = Math.max(6, Math.round(Math.cbrt(targetVerts) * 2.2));
  const cellSize = maxSpan / cellsPerAxis;

  const welded = weldVertices(geometry, cellSize);
  const repaired = repairMesh(welded);
  welded.dispose();
  return placeOnBuildPlate(repaired);
}

/**
 * Scales geometry accurately in millimeters and re-seats bottom at Y = 0.
 */
export function scaleToDimension(
  geometry: THREE.BufferGeometry,
  axis: 'x' | 'y' | 'z',
  targetMm: number,
  uniform = true
): THREE.BufferGeometry {
  const out = geometry.clone();
  out.computeBoundingBox();
  const box = out.boundingBox;
  if (!box || box.isEmpty()) return out;

  const size = new THREE.Vector3();
  box.getSize(size);
  const current = Math.max(1e-4, size[axis]);
  const factor = Math.max(0.5, targetMm) / current;

  if (uniform) {
    out.scale(factor, factor, factor);
  } else {
    out.scale(
      axis === 'x' ? factor : 1,
      axis === 'y' ? factor : 1,
      axis === 'z' ? factor : 1
    );
  }

  return placeOnBuildPlate(out);
}

/**
 * Centers geometry horizontally on X/Z = 0 and seats bottom flat on print bed Y = 0.
 */
export function placeOnBuildPlate(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = geometry.clone();
  out.computeBoundingBox();
  const box = out.boundingBox;
  if (!box || box.isEmpty()) return out;

  const center = new THREE.Vector3();
  box.getCenter(center);
  out.translate(-center.x, -box.min.y, -center.z);
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

export function rotateMesh90(
  geometry: THREE.BufferGeometry,
  axis: 'x' | 'y' | 'z'
): THREE.BufferGeometry {
  const out = geometry.clone();
  const angle = Math.PI / 2;
  if (axis === 'x') out.rotateX(angle);
  else if (axis === 'y') out.rotateY(angle);
  else out.rotateZ(angle);
  return placeOnBuildPlate(out);
}

/**
 * Slices off the bottom `cutMm` millimeters of a mesh and caps the cut plane flat on Y = 0
 * so curved/organic parts adhere cleanly to a 3D printer bed.
 */
export function flatCutBottom(
  geometry: THREE.BufferGeometry,
  cutMm: number
): THREE.BufferGeometry {
  if (cutMm <= 0.01) return placeOnBuildPlate(geometry);

  const welded = weldVertices(geometry, 1e-4);
  const { positions: posArr, indices: idxArr } = ensureNonIndexedOrIndexedArrays(welded);
  welded.dispose();

  welded.computeBoundingBox();
  let minY = Infinity;
  for (let i = 1; i < posArr.length; i += 3) {
    if (posArr[i] < minY) minY = posArr[i];
  }
  const cutY = minY + cutMm;

  const positions = Array.from(posArr);
  const newIndices: number[] = [];

  const interpEdge = (i0: number, i1: number): number => {
    const y0 = positions[i0 * 3 + 1];
    const y1 = positions[i1 * 3 + 1];
    const t = Math.max(0, Math.min(1, (cutY - y0) / (y1 - y0 || 1e-9)));
    const x = positions[i0 * 3] + t * (positions[i1 * 3] - positions[i0 * 3]);
    const z = positions[i0 * 3 + 2] + t * (positions[i1 * 3 + 2] - positions[i0 * 3 + 2]);
    const idx = positions.length / 3;
    positions.push(x, cutY, z);
    return idx;
  };

  for (let i = 0; i + 2 < idxArr.length; i += 3) {
    const tri = [idxArr[i], idxArr[i + 1], idxArr[i + 2]];
    const above = tri.map((idx) => positions[idx * 3 + 1] >= cutY);
    const count = (above[0] ? 1 : 0) + (above[1] ? 1 : 0) + (above[2] ? 1 : 0);

    if (count === 0) continue;
    if (count === 3) {
      newIndices.push(tri[0], tri[1], tri[2]);
      continue;
    }

    if (count === 1) {
      const aPos = above[0] ? 0 : above[1] ? 1 : 2;
      const i0 = tri[aPos];
      const i1 = tri[(aPos + 1) % 3];
      const i2 = tri[(aPos + 2) % 3];
      const m1 = interpEdge(i0, i1);
      const m2 = interpEdge(i0, i2);
      newIndices.push(i0, m1, m2);
    } else {
      // count === 2
      const bPos = !above[0] ? 0 : !above[1] ? 1 : 2;
      const i0 = tri[bPos]; // below
      const i1 = tri[(bPos + 1) % 3]; // above
      const i2 = tri[(bPos + 2) % 3]; // above
      const m1 = interpEdge(i0, i1);
      const m2 = interpEdge(i0, i2);
      newIndices.push(m1, i1, i2);
      newIndices.push(m1, i2, m2);
    }
  }

  const clipped = new THREE.BufferGeometry();
  clipped.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  clipped.setIndex(newIndices);

  const repaired = repairMesh(clipped);
  clipped.dispose();
  return placeOnBuildPlate(repaired);
}
