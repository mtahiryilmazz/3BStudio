import * as THREE from 'three';
import { marchingCubes } from './marchingCubes';
import { BinaryMask, ViewAngle } from './types';

export interface VisualHullOptions {
  resolution?: number;
  smoothPasses?: number;
  sizeMm?: number;
}

function sampleMaskBilinear(mask: BinaryMask, uNorm: number, vNorm: number): number {
  // uNorm in [0, 1] left->right, vNorm in [0, 1] bottom->top (image y = 1 - vNorm)
  if (uNorm < 0 || uNorm > 1 || vNorm < 0 || vNorm > 1) return 0;
  const fx = uNorm * (mask.width - 1);
  const fy = (1 - vNorm) * (mask.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(mask.width - 1, x0 + 1);
  const y1 = Math.min(mask.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = mask.data[y0 * mask.width + x0];
  const v10 = mask.data[y0 * mask.width + x1];
  const v01 = mask.data[y1 * mask.width + x0];
  const v11 = mask.data[y1 * mask.width + x1];

  const a = v00 * (1 - tx) + v10 * tx;
  const b = v01 * (1 - tx) + v11 * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * Separable 3D 3x3x3 box filter pass on scalar field (preserving 1-voxel zero border).
 */
function smoothField3D(field: Float32Array, nx: number, ny: number, nz: number, passes: number): Float32Array {
  let src: Float32Array = field;
  let dst: Float32Array = new Float32Array(field.length);
  const strideY = nx;
  const strideZ = nx * ny;

  for (let p = 0; p < passes; p++) {
    dst.fill(0);
    for (let z = 1; z < nz - 1; z++) {
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          let sum = 0;
          const base = z * strideZ + y * strideY + x;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              const row = base + dz * strideZ + dy * strideY;
              sum += src[row - 1] + src[row] + src[row + 1];
            }
          }
          dst[base] = sum / 27;
        }
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  return src;
}

/**
 * Carves a 3D volume by intersecting silhouettes from up to 5 orthographic views
 * (front, right, back, left, top), producing a guaranteed watertight mesh via Marching Cubes.
 */
export function reconstructVisualHull(
  views: Partial<Record<ViewAngle, BinaryMask>>,
  options: VisualHullOptions = {}
): THREE.BufferGeometry {
  const resolution = Math.max(24, Math.min(128, Math.round(options.resolution ?? 64)));
  const smoothPasses = Math.max(0, Math.min(6, Math.round(options.smoothPasses ?? 2)));
  const sizeMm = Math.max(5, options.sizeMm ?? 60);

  const activeAngles = (Object.keys(views) as ViewAngle[]).filter((k) => Boolean(views[k]));
  if (activeAngles.length === 0) {
    throw new Error('En az bir temizlenmiş fotoğraf maskesi gereklidir.');
  }

  // Pad grid by 2 empty boundary voxels on all 6 faces so surface is strictly closed
  const pad = 2;
  const nx = resolution + pad * 2;
  const ny = resolution + pad * 2;
  const nz = resolution + pad * 2;

  let field: Float32Array = new Float32Array(nx * ny * nz);
  const strideY = nx;
  const strideZ = nx * ny;

  const front = views.front;
  const back = views.back;
  const right = views.right;
  const left = views.left;
  const top = views.top;

  for (let z = pad; z < nz - pad; z++) {
    const nzNorm = (z - pad) / (resolution - 1); // 0 (-Z back) to 1 (+Z front)
    for (let y = pad; y < ny - pad; y++) {
      const nyNorm = (y - pad) / (resolution - 1); // 0 (bottom) to 1 (top)
      for (let x = pad; x < nx - pad; x++) {
        const nxNorm = (x - pad) / (resolution - 1); // 0 (-X left) to 1 (+X right)

        let occ = 1.0;

        if (front) {
          occ = Math.min(occ, sampleMaskBilinear(front, nxNorm, nyNorm));
        }
        if (back && occ > 0.01) {
          occ = Math.min(occ, sampleMaskBilinear(back, 1 - nxNorm, nyNorm));
        }
        if (right && occ > 0.01) {
          // Viewer at +X looks toward -X: horizontal right on screen is -Z
          occ = Math.min(occ, sampleMaskBilinear(right, 1 - nzNorm, nyNorm));
        }
        if (left && occ > 0.01) {
          // Viewer at -X looks toward +X: horizontal right on screen is +Z
          occ = Math.min(occ, sampleMaskBilinear(left, nzNorm, nyNorm));
        }
        if (top && occ > 0.01) {
          // Viewer at +Y looks toward -Y: screen X = +X, screen up = -Z
          occ = Math.min(occ, sampleMaskBilinear(top, nxNorm, 1 - nzNorm));
        }

        // If only 1 side view was provided (e.g. only front), give a reasonable symmetric depth falloff
        if (!right && !left && !top) {
          const dz = (nzNorm - 0.5) * 2;
          const depthMask = Math.abs(dz) <= 0.45 ? 1 : 0;
          occ = Math.min(occ, depthMask);
        }

        field[z * strideZ + y * strideY + x] = occ;
      }
    }
  }

  if (smoothPasses > 0) {
    field = smoothField3D(field, nx, ny, nz, smoothPasses);
  }

  const geometry = marchingCubes(field, nx, ny, nz, 0.48, [-1, -1, -1], [1, 1, 1]);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;

  if (!box || box.isEmpty()) {
    throw new Error('Silüet kesişiminden 3D hacim üretilemedi. Fotoğrafların hizalı ve temiz olduğundan emin olun.');
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  const scale = sizeMm / maxDim;

  // Center X/Z at 0, place bottom on Y = 0
  geometry.translate(-center.x, -box.min.y, -center.z);
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}
