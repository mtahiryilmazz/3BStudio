import * as THREE from 'three';
import { EDGE_TABLE, TRI_TABLE } from './marchingCubesTables';

const CORNER_OFFSETS: readonly [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

const EDGE_CORNERS: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

// [dx, dy, dz, axis (0=X, 1=Y, 2=Z)] for each of the 12 cube edges
const EDGE_KEYS: readonly [number, number, number, number][] = [
  [0, 0, 0, 0], // 0: 0-1
  [1, 0, 0, 1], // 1: 1-2
  [0, 1, 0, 0], // 2: 2-3
  [0, 0, 0, 1], // 3: 3-0
  [0, 0, 1, 0], // 4: 4-5
  [1, 0, 1, 1], // 5: 5-6
  [0, 1, 1, 0], // 6: 6-7
  [0, 0, 1, 1], // 7: 7-4
  [0, 0, 0, 2], // 8: 0-4
  [1, 0, 0, 2], // 9: 1-5
  [1, 1, 0, 2], // 10: 2-6
  [0, 1, 0, 2], // 11: 3-7
];

/**
 * Extracts an indexed, watertight BufferGeometry from a 3D scalar field
 * where `field >= isoLevel` represents the solid interior.
 */
export function marchingCubes(
  field: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  isoLevel: number,
  boundsMin: [number, number, number],
  boundsMax: [number, number, number]
): THREE.BufferGeometry {
  const dx = (boundsMax[0] - boundsMin[0]) / Math.max(1, nx - 1);
  const dy = (boundsMax[1] - boundsMin[1]) / Math.max(1, ny - 1);
  const dz = (boundsMax[2] - boundsMin[2]) / Math.max(1, nz - 1);

  const positions: number[] = [];
  const indices: number[] = [];
  const edgeVertexMap = new Map<number, number>();

  const strideY = nx;
  const strideZ = nx * ny;
  const cornerValues = new Float32Array(8);
  const edgeVertices = new Int32Array(12);

  const idx = (x: number, y: number, z: number) => z * strideZ + y * strideY + x;

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const [ox, oy, oz] = CORNER_OFFSETS[c];
          const val = field[idx(x + ox, y + oy, z + oz)];
          cornerValues[c] = val;
          if (val >= isoLevel) {
            cubeIndex |= 1 << c;
          }
        }

        const edgeMask = EDGE_TABLE[cubeIndex];
        if (edgeMask === 0) continue;

        for (let e = 0; e < 12; e++) {
          if ((edgeMask & (1 << e)) === 0) continue;

          const [ex, ey, ez, axis] = EDGE_KEYS[e];
          const key = (((z + ez) * ny + (y + ey)) * nx + (x + ex)) * 3 + axis;

          let vertIndex = edgeVertexMap.get(key);
          if (vertIndex === undefined) {
            const [c0, c1] = EDGE_CORNERS[e];
            const v0 = cornerValues[c0];
            const v1 = cornerValues[c1];
            const denom = v1 - v0;
            let t = Math.abs(denom) < 1e-7 ? 0.5 : (isoLevel - v0) / denom;
            // Clamp slightly away from endpoints so adjacent edge vertices never collapse to identical coordinates
            if (t < 1e-4) t = 1e-4;
            if (t > 1 - 1e-4) t = 1 - 1e-4;

            const [o0x, o0y, o0z] = CORNER_OFFSETS[c0];
            const [o1x, o1y, o1z] = CORNER_OFFSETS[c1];

            const px = boundsMin[0] + (x + o0x + t * (o1x - o0x)) * dx;
            const py = boundsMin[1] + (y + o0y + t * (o1y - o0y)) * dy;
            const pz = boundsMin[2] + (z + o0z + t * (o1z - o0z)) * dz;

            vertIndex = positions.length / 3;
            positions.push(px, py, pz);
            edgeVertexMap.set(key, vertIndex);
          }

          edgeVertices[e] = vertIndex;
        }

        const triRow = TRI_TABLE[cubeIndex];
        for (let i = 0; triRow[i] !== -1; i += 3) {
          const i0 = edgeVertices[triRow[i]];
          // Swap i1 and i2 so normals point outward when field >= isoLevel is inside
          const i1 = edgeVertices[triRow[i + 2]];
          const i2 = edgeVertices[triRow[i + 1]];
          if (i0 !== i1 && i1 !== i2 && i2 !== i0) {
            indices.push(i0, i1, i2);
          }
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
