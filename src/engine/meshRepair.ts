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

  // 3D baskı sarkan yüzey (>45°) ve taban temas analizi
  const minY = box && !box.isEmpty() ? box.min.y : 0;
  const bedTol = Math.max(0.35, size.y * 0.008);
  let overhangTris = 0;
  let bedContactTris = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) continue;
    const nyUnit = ny / len;
    const triMaxY = Math.max(ay, by, cy);
    if (triMaxY <= minY + bedTol) {
      if (nyUnit < -0.5) bedContactTris++;
    } else if (nyUnit < -0.7071) {
      // Yataydan >45° sarkan ve tablaya basmayan alt yüzey: destek (support) gerektirir
      overhangTris++;
    }
  }

  const overhangTrianglePct =
    triangleCount > 0 ? Number(((overhangTris / triangleCount) * 100).toFixed(1)) : 0;
  const bedContactPct =
    triangleCount > 0 ? Number(((bedContactTris / triangleCount) * 100).toFixed(1)) : 0;
  const minDim = Math.min(size.x, size.y, size.z);
  const maxDim = Math.max(size.x, size.y, size.z);
  const thinWallWarning = triangleCount > 0 && minDim < 0.8;
  const exceedsBedWarning = maxDim > 220;
  const estimatedPrintMinutes =
    triangleCount > 0 ? Math.max(5, Math.round(volumeCm3 * 4.2 + size.y * 0.45)) : 0;

  const isWatertight = triangleCount > 0 && openBoundaryEdges === 0 && nonManifoldEdges === 0;

  let score = 100;
  if (triangleCount === 0) score = 0;
  else {
    if (openBoundaryEdges > 0) score -= Math.min(45, 15 + openBoundaryEdges * 2);
    if (nonManifoldEdges > 0) score -= Math.min(35, 10 + nonManifoldEdges * 2);
    if (thinWallWarning) score -= 10;
    if (exceedsBedWarning) score -= 10;
    if (overhangTrianglePct > 30) score -= 8;
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
    overhangTrianglePct,
    bedContactPct,
    thinWallWarning,
    exceedsBedWarning,
    estimatedPrintMinutes,
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
  resolution = 96
): THREE.BufferGeometry {
  const res = Math.max(20, Math.min(160, Math.round(resolution)));
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

/**
 * Üçgen sayısını 4^iterations katına çıkarır (orta-nokta alt bölme).
 *
 * Her üçgen dört alt üçgene bölünür; var olan `color` attribute'u ara
 * değerlerle korunur (yüz detayı kaybolmaz). Baskı kalitesini artırmak için
 * kullanılır: 1 geçiş ×4, 2 geçiş ×16 poligon.
 */
export function subdivideGeometry(
  geometry: THREE.BufferGeometry,
  iterations = 1
): THREE.BufferGeometry {
  const passes = Math.max(0, Math.min(3, Math.round(iterations)));
  let geo = geometry.clone();
  if (geo.getIndex()) {
    const nonIndexed = geo.toNonIndexed();
    geo.dispose();
    geo = nonIndexed;
  }
  if (passes === 0) return geo;

  for (let pass = 0; pass < passes; pass++) {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
    const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const uv2Attr = geo.getAttribute('uv2') as THREE.BufferAttribute | undefined;
    const triCount = Math.floor(pos.count / 3);
    const nextPos = new Float32Array(triCount * 12 * 3);
    const nextCol = colorAttr ? new Float32Array(triCount * 12 * 3) : null;
    const nextUv = uvAttr ? new Float32Array(triCount * 12 * 2) : null;
    const nextUv2 = uv2Attr ? new Float32Array(triCount * 12 * 2) : null;

    const readPoint = (i: number, target: THREE.Vector3) => {
      target.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    };
    const readColor = (i: number, target: THREE.Color) => {
      if (!colorAttr) target.setRGB(0.72, 0.75, 0.8);
      else target.setRGB(colorAttr.getX(i), colorAttr.getY(i), colorAttr.getZ(i));
    };
    const readUv = (attr: THREE.BufferAttribute | undefined, i: number, target: THREE.Vector2) => {
      if (!attr) target.set(0, 0);
      else target.set(attr.getX(i), attr.getY(i));
    };

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const cA = new THREE.Color();
    const cB = new THREE.Color();
    const cC = new THREE.Color();
    const cTmp = new THREE.Color();
    const uA = new THREE.Vector2();
    const uB = new THREE.Vector2();
    const uC = new THREE.Vector2();
    const u2A = new THREE.Vector2();
    const u2B = new THREE.Vector2();
    const u2C = new THREE.Vector2();

    let vp = 0;
    let cp = 0;
    let up = 0;
    let u2p = 0;
    const emit = (
      p: THREE.Vector3,
      color?: THREE.Color,
      uv?: THREE.Vector2,
      uv2?: THREE.Vector2
    ) => {
      nextPos[vp++] = p.x;
      nextPos[vp++] = p.y;
      nextPos[vp++] = p.z;
      if (nextCol) {
        const col = color ?? cTmp.setRGB(0.72, 0.75, 0.8);
        nextCol[cp++] = col.r;
        nextCol[cp++] = col.g;
        nextCol[cp++] = col.b;
      }
      if (nextUv && uv) {
        nextUv[up++] = uv.x;
        nextUv[up++] = uv.y;
      }
      if (nextUv2 && uv2) {
        nextUv2[u2p++] = uv2.x;
        nextUv2[u2p++] = uv2.y;
      }
    };

    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      const i1 = i0 + 1;
      const i2 = i0 + 2;
      readPoint(i0, a);
      readPoint(i1, b);
      readPoint(i2, c);
      readColor(i0, cA);
      readColor(i1, cB);
      readColor(i2, cC);
      if (uvAttr) {
        readUv(uvAttr, i0, uA);
        readUv(uvAttr, i1, uB);
        readUv(uvAttr, i2, uC);
      }
      if (uv2Attr) {
        readUv(uv2Attr, i0, u2A);
        readUv(uv2Attr, i1, u2B);
        readUv(uv2Attr, i2, u2C);
      }

      const ab = tmp.copy(a).add(b).multiplyScalar(0.5).clone();
      const bc = tmp.copy(b).add(c).multiplyScalar(0.5).clone();
      const ca = tmp.copy(c).add(a).multiplyScalar(0.5).clone();
      const cAB = cA.clone().add(cB).multiplyScalar(0.5);
      const cBC = cB.clone().add(cC).multiplyScalar(0.5);
      const cCA = cC.clone().add(cA).multiplyScalar(0.5);
      const uAB = uvAttr ? new THREE.Vector2((uA.x + uB.x) * 0.5, (uA.y + uB.y) * 0.5) : undefined;
      const uBC = uvAttr ? new THREE.Vector2((uB.x + uC.x) * 0.5, (uB.y + uC.y) * 0.5) : undefined;
      const uCA = uvAttr ? new THREE.Vector2((uC.x + uA.x) * 0.5, (uC.y + uA.y) * 0.5) : undefined;
      const u2AB = uv2Attr ? new THREE.Vector2((u2A.x + u2B.x) * 0.5, (u2A.y + u2B.y) * 0.5) : undefined;
      const u2BC = uv2Attr ? new THREE.Vector2((u2B.x + u2C.x) * 0.5, (u2B.y + u2C.y) * 0.5) : undefined;
      const u2CA = uv2Attr ? new THREE.Vector2((u2C.x + u2A.x) * 0.5, (u2C.y + u2A.y) * 0.5) : undefined;

      // 1) a, ab, ca
      emit(a, cA, uA, u2A);
      emit(ab, cAB, uAB, u2AB);
      emit(ca, cCA, uCA, u2CA);
      // 2) ab, b, bc
      emit(ab, cAB, uAB, u2AB);
      emit(b, cB, uB, u2B);
      emit(bc, cBC, uBC, u2BC);
      // 3) ca, bc, c
      emit(ca, cCA, uCA, u2CA);
      emit(bc, cBC, uBC, u2BC);
      emit(c, cC, uC, u2C);
      // 4) ab, bc, ca (orta)
      emit(ab, cAB, uAB, u2AB);
      emit(bc, cBC, uBC, u2BC);
      emit(ca, cCA, uCA, u2CA);
    }

    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(nextPos, 3));
    if (nextCol) next.setAttribute('color', new THREE.BufferAttribute(nextCol, 3));
    if (nextUv) next.setAttribute('uv', new THREE.BufferAttribute(nextUv, 2));
    if (nextUv2) next.setAttribute('uv2', new THREE.BufferAttribute(nextUv2, 2));
    geo.dispose();
    geo = next;
  }

  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Yumuşak üst sınır: bunun üzerine çıkan alt bölme uygulanmaz (750K üçgen dengeli bütçe). */
export const MAX_TRIANGLES_SOFT = 750_000;

export function countTriangles(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return Math.floor(index.count / 3);
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  return pos ? Math.floor(pos.count / 3) : 0;
}

/** Kaba dosya boyutu tahmini (bayt). */
export function estimateMeshBytes(triangles: number): {
  stlBytes: number;
  glbBytes: number;
  compactGlbBytes: number;
  compact3mfBytes: number;
} {
  const safeTris = Math.max(0, triangles);
  // Binary STL: 84 bayt başlık + üçgen başına 50 bayt.
  // Ham GLB üst sınırı: üçgen başına ~88 bayt + 4 KB başlık.
  // İndeksli kompakt GLB: paylaşımlı vertex + Uint8 renk (~26 bayt/üçgen).
  // DEFLATE Seviye-9 kaynaklı 3MF: ikili STL'nin ortalama ~%14'ü.
  return {
    stlBytes: Math.round(safeTris * 50 + 84),
    glbBytes: Math.round(safeTris * 88 + 4096),
    compactGlbBytes: Math.round(safeTris * 26 + 4096),
    compact3mfBytes: Math.round(safeTris * 7.5 + 1024),
  };
}

export interface SubdivideResult {
  geometry: THREE.BufferGeometry;
  appliedLevels: number;
  triangles: number;
  /** İstenen seviye bütçe nedeniyle kırpıldı mı. */
  clamped: boolean;
}

/**
 * Alt bölmeyi bütçeyle uygular: her geçiş üçgen sayısını ×4 yapar,
 * `maxTriangles` aşılacaksa o geçiş atlanır.
 */
export function subdivideWithBudget(
  geometry: THREE.BufferGeometry,
  level: number,
  maxTriangles: number = MAX_TRIANGLES_SOFT
): SubdivideResult {
  const target = Math.max(0, Math.min(3, Math.round(level)));
  let current = geometry.clone();
  let triangles = countTriangles(current);
  let applied = 0;
  const limit = Math.max(1, maxTriangles);
  while (applied < target && triangles * 4 <= limit) {
    const next = subdivideGeometry(current, 1);
    current.dispose();
    current = next;
    triangles = countTriangles(current);
    applied += 1;
  }
  return {
    geometry: current,
    appliedLevels: applied,
    triangles,
    clamped: applied < target,
  };
}

export interface FlatDecimateOptions {
  /** Komşu yüz normalleri bu açının (derece) altındaysa düzlem kabul edilip sıkıştırılır. */
  planarAngleDeg?: number;
  /** Köşegen oranına göre izin verilen maksimum geometrik sapma (ölçekten bağımsız). */
  maxChordErrorRatio?: number;
  /** En fazla kaç geçiş çalıştırılacağı. */
  maxPasses?: number;
}

export interface FlatDecimateResult {
  geometry: THREE.BufferGeometry;
  beforeTriangles: number;
  afterTriangles: number;
  lockedDetailRatio: number;
}

/**
 * Ölçekten bağımsız, eğrilik-kilitli düzlem sadeleştirme (Curvature-Locked Planar Decimation).
 *
 * - Yüksek eğrilikli tüm detay düğümlerini (yüz, keskin köşe, pah, kabartma, renk sınırı ve
 *   açık kenar sınırları) kesinlikle KİLİTLER.
 * - Yalnızca komşu üçgenleri neredeyse eş-düzlemli (düz yüzey) olan gereksiz iç düğümleri
 *   topolojik bağlantı (link) koşulunu doğrulayarak güvenli biçimde birleştirir; böylece
 *   su geçirmezlik (watertight) %100 korunurken dosya boyutu dramatik biçimde küçülür.
 */
export function decimateFlatRegions(
  geometry: THREE.BufferGeometry,
  options: FlatDecimateOptions = {}
): FlatDecimateResult {
  const planarAngleDeg = options.planarAngleDeg ?? 5.5;
  const maxChordErrorRatio = options.maxChordErrorRatio ?? 0.0005;
  const maxPasses = Math.max(1, Math.min(4, options.maxPasses ?? 2));
  const cosThresh = Math.cos((planarAngleDeg * Math.PI) / 180);

  const beforeTriangles = countTriangles(geometry);
  if (beforeTriangles < 16) {
    return {
      geometry: geometry.clone(),
      beforeTriangles,
      afterTriangles: beforeTriangles,
      lockedDetailRatio: 1,
    };
  }

  // Ölçekten bağımsız weld toleransı (15mm minyatürde de 220mm modelde de aynı hassasiyet)
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = new THREE.Vector3();
  if (box && !box.isEmpty()) box.getSize(size);
  const diag = Math.max(1e-4, size.length());
  const weldTol = Math.max(1e-5, diag * 1e-5);
  const maxChordSq = (diag * maxChordErrorRatio) ** 2;

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const srcIndex = geometry.getIndex();
  const rawIdxCount = srcIndex ? srcIndex.count : posAttr.count;

  // Vertex kaynağı (renk ve UV dikişi varsa koruyarak)
  const invTol = 1 / weldTol;
  const vertMap = new Map<string, number>();
  const remap = new Int32Array(posAttr.count);
  const vPos: number[] = [];
  const vColSum: number[] = [];
  const vColCnt: number[] = [];
  const vUvSum: number[] = [];
  const vUvCnt: number[] = [];
  const uvSeamVerts = new Set<number>();

  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = `${Math.round(x * invTol)},${Math.round(y * invTol)},${Math.round(z * invTol)}`;
    let vid = vertMap.get(key);
    if (vid === undefined) {
      vid = vPos.length / 3;
      vertMap.set(key, vid);
      vPos.push(x, y, z);
      if (colAttr) {
        vColSum.push(colAttr.getX(i), colAttr.getY(i), colAttr.getZ(i));
        vColCnt.push(1);
      }
      if (uvAttr) {
        vUvSum.push(uvAttr.getX(i), uvAttr.getY(i));
        vUvCnt.push(1);
      }
    } else {
      if (colAttr) {
        vColSum[vid * 3] += colAttr.getX(i);
        vColSum[vid * 3 + 1] += colAttr.getY(i);
        vColSum[vid * 3 + 2] += colAttr.getZ(i);
        vColCnt[vid]++;
      }
      if (uvAttr) {
        const avgU = vUvSum[vid * 2] / Math.max(1, vUvCnt[vid]);
        const avgV = vUvSum[vid * 2 + 1] / Math.max(1, vUvCnt[vid]);
        const du = Math.abs(uvAttr.getX(i) - avgU);
        const dv = Math.abs(uvAttr.getY(i) - avgV);
        if (du > 0.04 || dv > 0.04) {
          uvSeamVerts.add(vid);
        } else {
          vUvSum[vid * 2] += uvAttr.getX(i);
          vUvSum[vid * 2 + 1] += uvAttr.getY(i);
          vUvCnt[vid]++;
        }
      }
    }
    remap[i] = vid;
  }

  const vCount = vPos.length / 3;
  const vCol = colAttr ? new Float32Array(vCount * 3) : null;
  if (vCol) {
    for (let i = 0; i < vCount; i++) {
      const c = Math.max(1, vColCnt[i]);
      vCol[i * 3] = vColSum[i * 3] / c;
      vCol[i * 3 + 1] = vColSum[i * 3 + 1] / c;
      vCol[i * 3 + 2] = vColSum[i * 3 + 2] / c;
    }
  }
  const vUv = uvAttr ? new Float32Array(vCount * 2) : null;
  if (vUv) {
    for (let i = 0; i < vCount; i++) {
      const c = Math.max(1, vUvCnt[i]);
      vUv[i * 2] = vUvSum[i * 2] / c;
      vUv[i * 2 + 1] = vUvSum[i * 2 + 1] / c;
    }
  }

  // Üçgen listesi (dejenere olanlar elenir)
  const tris: Array<[number, number, number]> = [];
  const seenTri = new Set<string>();
  for (let i = 0; i + 2 < rawIdxCount; i += 3) {
    const a = remap[srcIndex ? srcIndex.getX(i) : i];
    const b = remap[srcIndex ? srcIndex.getX(i + 1) : i + 1];
    const c = remap[srcIndex ? srcIndex.getX(i + 2) : i + 2];
    if (a === b || b === c || c === a) continue;
    const s = [a, b, c].sort((p, q) => p - q);
    const k = `${s[0]}:${s[1]}:${s[2]}`;
    if (seenTri.has(k)) continue;
    seenTri.add(k);
    tris.push([a, b, c]);
  }

  let aliveTris = new Uint8Array(tris.length);
  aliveTris.fill(1);
  let lockedRatio = 1;

  const faceNormal = (a: number, b: number, c: number): [number, number, number] | null => {
    const ax = vPos[a * 3], ay = vPos[a * 3 + 1], az = vPos[a * 3 + 2];
    const ux = vPos[b * 3] - ax, uy = vPos[b * 3 + 1] - ay, uz = vPos[b * 3 + 2] - az;
    const vx = vPos[c * 3] - ax, vy = vPos[c * 3 + 1] - ay, vz = vPos[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return null;
    return [nx / len, ny / len, nz / len];
  };

  for (let pass = 0; pass < maxPasses; pass++) {
    const vertFaces: number[][] = Array.from({ length: vCount }, () => []);
    const vertNeighbors: Array<Set<number>> = Array.from({ length: vCount }, () => new Set<number>());
    const edgeFaceCount = new Map<string, number>();
    const fNormals: Array<[number, number, number] | null> = new Array(tris.length);

    for (let t = 0; t < tris.length; t++) {
      if (!aliveTris[t]) continue;
      const [a, b, c] = tris[t];
      const n = faceNormal(a, b, c);
      fNormals[t] = n;
      if (!n) {
        aliveTris[t] = 0;
        continue;
      }
      vertFaces[a].push(t);
      vertFaces[b].push(t);
      vertFaces[c].push(t);
      vertNeighbors[a].add(b);
      vertNeighbors[a].add(c);
      vertNeighbors[b].add(a);
      vertNeighbors[b].add(c);
      vertNeighbors[c].add(a);
      vertNeighbors[c].add(b);
      const edges: Array<[number, number]> = [[a, b], [b, c], [c, a]];
      for (const [u, v] of edges) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        edgeFaceCount.set(key, (edgeFaceCount.get(key) ?? 0) + 1);
      }
    }

    // Düğüm kilitleme: sınır, non-manifold, UV dikişi, keskin eğrilik veya boyalı renk sınırı = KİLİTLİ
    const locked = new Uint8Array(vCount);
    for (const seamVid of uvSeamVerts) {
      if (seamVid >= 0 && seamVid < vCount) locked[seamVid] = 1;
    }
    for (const [key, cnt] of edgeFaceCount.entries()) {
      if (cnt !== 2) {
        const [uStr, vStr] = key.split('_');
        locked[Number(uStr)] = 1;
        locked[Number(vStr)] = 1;
      }
    }

    let activeVerts = 0;
    let lockedVerts = 0;
    for (let v = 0; v < vCount; v++) {
      const faces = vertFaces[v];
      if (faces.length === 0) continue;
      activeVerts++;
      if (!locked[v]) {
        const refN = fNormals[faces[0]];
        if (!refN) {
          locked[v] = 1;
        } else {
          for (let k = 1; k < faces.length; k++) {
            const fn = fNormals[faces[k]];
            if (!fn || refN[0] * fn[0] + refN[1] * fn[1] + refN[2] * fn[2] < cosThresh) {
              locked[v] = 1;
              break;
            }
          }
        }
      }
      if (!locked[v] && vCol) {
        const r0 = vCol[v * 3], g0 = vCol[v * 3 + 1], b0 = vCol[v * 3 + 2];
        for (const nb of vertNeighbors[v]) {
          const dc =
            Math.abs(vCol[nb * 3] - r0) +
            Math.abs(vCol[nb * 3 + 1] - g0) +
            Math.abs(vCol[nb * 3 + 2] - b0);
          if (dc > 0.12) {
            locked[v] = 1;
            break;
          }
        }
      }
      if (locked[v]) lockedVerts++;
    }
    if (pass === 0) {
      lockedRatio = activeVerts > 0 ? lockedVerts / activeVerts : 1;
    }

    // Güvenli düzlem kenar çökertme (link koşulu == 2 ortak komşu → %100 manifold/watertight korunur)
    const touched = new Uint8Array(vCount);
    let collapsed = 0;

    for (let u = 0; u < vCount; u++) {
      if (locked[u] || touched[u]) continue;
      const uFaces = vertFaces[u];
      if (uFaces.length < 3) continue;
      const refN = fNormals[uFaces[0]];
      if (!refN) continue;

      // u'yu en yakın düzlem komşusuna çökert (detayı sıfır kayıpla koru)
      let bestTarget = -1;
      let bestDistSq = Infinity;
      for (const v of vertNeighbors[u]) {
        if (touched[v]) continue;
        // Düzlem içi mesafe (normal doğrultusunda sapma kontrolü)
        const dx = vPos[v * 3] - vPos[u * 3];
        const dy = vPos[v * 3 + 1] - vPos[u * 3 + 1];
        const dz = vPos[v * 3 + 2] - vPos[u * 3 + 2];
        const planeDev = dx * refN[0] + dy * refN[1] + dz * refN[2];
        if (planeDev * planeDev > maxChordSq) continue;

        // Topolojik link koşulu: u ve v tam 2 ortak komşuya sahip olmalı (delik veya non-manifold imkansız)
        let common = 0;
        for (const nb of vertNeighbors[u]) {
          if (vertNeighbors[v].has(nb)) common++;
        }
        if (common !== 2) continue;

        // Hedef v'ye taşındığında hiçbir komşu üçgenin normali ters dönmemeli veya dejenere olmamalı
        let safe = true;
        for (const t of uFaces) {
          if (!aliveTris[t]) continue;
          const [a, b, c] = tris[t];
          if (a === v || b === v || c === v) continue;
          const na = a === u ? v : a;
          const nb = b === u ? v : b;
          const nc = c === u ? v : c;
          const newN = faceNormal(na, nb, nc);
          const oldN = fNormals[t];
          if (!newN || !oldN || newN[0] * oldN[0] + newN[1] * oldN[1] + newN[2] * oldN[2] < 0.5) {
            safe = false;
            break;
          }
        }
        if (!safe) continue;

        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestTarget = v;
        }
      }

      if (bestTarget === -1) continue;

      // Çökertmeyi uygula ve komşu halkasını bu geçişte dondur
      touched[u] = 1;
      touched[bestTarget] = 1;
      for (const nb of vertNeighbors[u]) touched[nb] = 1;
      for (const nb of vertNeighbors[bestTarget]) touched[nb] = 1;

      for (const t of uFaces) {
        if (!aliveTris[t]) continue;
        const [a, b, c] = tris[t];
        if (a === bestTarget || b === bestTarget || c === bestTarget) {
          aliveTris[t] = 0;
        } else {
          tris[t] = [
            a === u ? bestTarget : a,
            b === u ? bestTarget : b,
            c === u ? bestTarget : c,
          ];
        }
      }
      collapsed++;
    }

    if (collapsed === 0) break;
  }

  // Sıkıştırılmış indeksli BufferGeometry üret
  const compactMap = new Int32Array(vCount).fill(-1);
  const outPos: number[] = [];
  const outCol: number[] = [];
  const outUv: number[] = [];
  const outIdx: number[] = [];

  for (let t = 0; t < tris.length; t++) {
    if (!aliveTris[t]) continue;
    const [a, b, c] = tris[t];
    if (a === b || b === c || c === a) continue;
    for (const vid of [a, b, c]) {
      let mapped = compactMap[vid];
      if (mapped === -1) {
        mapped = outPos.length / 3;
        compactMap[vid] = mapped;
        outPos.push(vPos[vid * 3], vPos[vid * 3 + 1], vPos[vid * 3 + 2]);
        if (vCol) {
          outCol.push(vCol[vid * 3], vCol[vid * 3 + 1], vCol[vid * 3 + 2]);
        }
        if (vUv) {
          outUv.push(vUv[vid * 2], vUv[vid * 2 + 1]);
        }
      }
      outIdx.push(mapped);
    }
  }

  if (outIdx.length < 9) {
    return {
      geometry: geometry.clone(),
      beforeTriangles,
      afterTriangles: beforeTriangles,
      lockedDetailRatio: 1,
    };
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  if (vCol) {
    out.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3));
  }
  if (vUv) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
    out.setAttribute('uv2', new THREE.Float32BufferAttribute(outUv.slice(), 2));
  }
  out.setIndex(outIdx);
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();

  return {
    geometry: out,
    beforeTriangles,
    afterTriangles: Math.floor(outIdx.length / 3),
    lockedDetailRatio: Number(lockedRatio.toFixed(3)),
  };
}

export interface CompactUpscaleOptions {
  /** Detay alt-bölme hedefi (küçük/büyük tüm modeller için ölçekten bağımsız). */
  targetDetailTriangles?: number;
  /** Eğrilik kilit açısı (derece); bunun altındaki düz alanlar sıkıştırılır. */
  planarAngleDeg?: number;
}

export interface CompactUpscaleResult {
  geometry: THREE.BufferGeometry;
  beforeTriangles: number;
  upscaledTriangles: number;
  afterTriangles: number;
  lockedDetailRatio: number;
  isWatertight: boolean;
  estimatedCompact3mfBytes: number;
}

/**
 * Ölçekten Bağımsız Max Upscale + Akıllı Küçük Dosya Motoru.
 *
 * Model 15 mm'lik minyatür de olsa 220 mm'lik büyük heykel de olsa:
 * 1) Birim ölçeğe normalize ederek detay yoğunluğunu boyuttan bağımsızlaştırır.
 * 2) Kavisli/organik/mekanik detayları bütçe içinde yüksek poligona yükseltip
 *    hacim-koruyucu Taubin düzleştirmesi uygular.
 * 3) Eğrilik-kilitli düzlem sadeleştirmesi ile düz alanlardaki gereksiz üçgenleri
 *    temizler — detay maksimum kalır, dosya boyutu minimuma iner.
 */
export function upscaleAndCompactMesh(
  geometry: THREE.BufferGeometry,
  options: CompactUpscaleOptions = {}
): CompactUpscaleResult {
  const beforeTriangles = countTriangles(geometry);
  const targetDetail = Math.min(MAX_TRIANGLES_SOFT, options.targetDetailTriangles ?? 120_000);
  const planarAngleDeg = options.planarAngleDeg ?? 5.5;

  const work = geometry.clone();
  work.computeBoundingBox();
  const box = work.boundingBox;
  const size = new THREE.Vector3(1, 1, 1);
  const center = new THREE.Vector3();
  const origMinY = box && !box.isEmpty() ? box.min.y : 0;
  if (box && !box.isEmpty()) {
    box.getSize(size);
    box.getCenter(center);
  }
  const origDiag = Math.max(1e-4, size.length());

  // 1) Birim köşegen (diag = 1.0) uzayına normalize et — büyük/küçük tüm modeller eşit işlenir
  work.translate(-center.x, -center.y, -center.z);
  work.scale(1 / origDiag, 1 / origDiag, 1 / origDiag);

  // 2) Max Upscale alt-bölme (en fazla 2 geçiş, yumuşak 750K sınırı altında)
  let current = work;
  let passes = 0;
  while (passes < 2 && countTriangles(current) * 4 <= targetDetail) {
    const next = subdivideGeometry(current, 1);
    current.dispose();
    current = next;
    passes++;
  }
  const upscaledTriangles = countTriangles(current);

  // Eğer alt-bölme yapıldıysa ve vertex rengi yoksa hafif hacim-koruyucu Taubin geçişi ile pürüzsüzleştir
  if (passes > 0 && !current.getAttribute('color')) {
    const smoothed = taubinSmooth(current, 2, 0.38, -0.4);
    current.dispose();
    current = smoothed;
  }

  // 3) Eğrilik-kilitli düzlem sıkıştırması (detayları kilitle, düz fazlalıkları at)
  const decimated = decimateFlatRegions(current, {
    planarAngleDeg,
    maxChordErrorRatio: 0.0005,
    maxPasses: 3,
  });
  current.dispose();

  // 4) Orijinal fiziksel milimetre ölçeğine (sıfır boyut kaymasıyla) ve Y=0 baskı tablasına geri döndür
  const finalGeo = decimated.geometry;
  finalGeo.computeBoundingBox();
  const curSize = new THREE.Vector3(1, 1, 1);
  if (finalGeo.boundingBox && !finalGeo.boundingBox.isEmpty()) {
    finalGeo.boundingBox.getSize(curSize);
  }
  const curDiag = Math.max(1e-4, curSize.length());
  const restoreScale = origDiag / curDiag;
  finalGeo.scale(restoreScale, restoreScale, restoreScale);
  finalGeo.translate(center.x, center.y, center.z);
  finalGeo.computeBoundingBox();
  if (finalGeo.boundingBox && !finalGeo.boundingBox.isEmpty()) {
    const dy = origMinY - finalGeo.boundingBox.min.y;
    if (Math.abs(dy) > 1e-6) finalGeo.translate(0, dy, 0);
  }
  finalGeo.computeVertexNormals();
  finalGeo.computeBoundingBox();
  finalGeo.computeBoundingSphere();

  const stats = analyzeMesh(finalGeo);
  const est = estimateMeshBytes(stats.triangleCount);

  return {
    geometry: finalGeo,
    beforeTriangles,
    upscaledTriangles,
    afterTriangles: stats.triangleCount,
    lockedDetailRatio: decimated.lockedDetailRatio,
    isWatertight: stats.isWatertight,
    estimatedCompact3mfBytes: est.compact3mfBytes,
  };
}

/**
 * 3D baskı sarkan yüzey (>45° overhang) görselleştirmesi için vertex renkli geometri üretir.
 * - Kırmızı (#ef4444): >45° destek gerektiren alt yüzeyler
 * - Turuncu (#f59e0b): 35°–45° sınır eğimli yüzeyler
 * - Zümrüt (#10b981): Yazıcı tablasına (Y≈0) basan güvenli taban
 * - Açık çelik mavisi (#7dd3fc): Desteksiz basılabilir güvenli yüzey
 */
export function buildOverhangColorGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const nonIndexed = geometry.getIndex() ? geometry.toNonIndexed() : geometry.clone();
  nonIndexed.computeBoundingBox();
  const box = nonIndexed.boundingBox;
  const minY = box ? box.min.y : 0;
  const height = box ? Math.max(1, box.max.y - box.min.y) : 10;
  const bedTol = Math.max(0.35, height * 0.008);

  const pos = nonIndexed.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const triCount = Math.floor(pos.count / 3);

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const i1 = i0 + 1;
    const i2 = i0 + 2;
    const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
    const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
    const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const nyUnit = ny / len;
    const maxY = Math.max(ay, by, cy);

    let r = 0.49;
    let g = 0.83;
    let b = 0.99; // güvenli yüzey
    if (maxY <= minY + bedTol && nyUnit < -0.5) {
      r = 0.06;
      g = 0.73;
      b = 0.51; // taban teması
    } else if (maxY > minY + bedTol && nyUnit < -0.7071) {
      r = 0.94;
      g = 0.27;
      b = 0.27; // >45° overhang
    } else if (maxY > minY + bedTol && nyUnit < -0.5736) {
      r = 0.96;
      g = 0.62;
      b = 0.04; // 35°-45° dikkat
    }

    for (const vi of [i0, i1, i2]) {
      colors[vi * 3] = r;
      colors[vi * 3 + 1] = g;
      colors[vi * 3 + 2] = b;
    }
  }

  nonIndexed.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (!nonIndexed.getAttribute('normal')) {
    nonIndexed.computeVertexNormals();
  }
  return nonIndexed;
}


