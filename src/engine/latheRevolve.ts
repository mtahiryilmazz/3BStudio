import * as THREE from 'three';
import { BinaryMask } from './types';

export interface LatheRevolveOptions {
  heightMm: number;
  segments?: number;
  smoothWindow?: number;
  hollowWallMm?: number;
}

/**
 * Generates a 360-degree rotationally symmetric (lathe) watertight 3D mesh
 * from a single side-view silhouette mask (ideal for knobs, caps, cups, vases, bushings).
 */
export function reconstructLathe(
  mask: BinaryMask,
  options: LatheRevolveOptions
): THREE.BufferGeometry {
  const heightMm = Math.max(4, options.heightMm);
  const segments = Math.max(16, Math.min(128, Math.round(options.segments ?? 48)));
  const smoothWindow = Math.max(0, options.smoothWindow ?? 3);
  const hollowWallMm = Math.max(0, options.hollowWallMm ?? 0);

  const w = mask.width;
  const h = mask.height;

  // Find vertical foreground bounds and measure radial width at each scanline
  let minRow = h;
  let maxRow = -1;
  const rawRadii = new Float32Array(h);

  for (let y = 0; y < h; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < w; x++) {
      if (mask.data[y * w + x]) {
        if (left === -1) left = x;
        right = x;
      }
    }
    if (left !== -1) {
      if (y < minRow) minRow = y;
      if (y > maxRow) maxRow = y;
      rawRadii[y] = (right - left + 1) * 0.5;
    }
  }

  if (maxRow <= minRow + 2) {
    throw new Error('Dönel simetri profili çıkarılamadı. Parçanın yandan çekilmiş fotoğrafını kullanın.');
  }

  const rowCount = maxRow - minRow + 1;
  const pxToMm = heightMm / Math.max(1, rowCount - 1);

  // Sample profile bottom-to-top
  const sampleCount = Math.min(80, Math.max(16, rowCount));
  const radiiMm = new Float32Array(sampleCount);
  const heightsMm = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const t = i / (sampleCount - 1);
    const row = Math.round(maxRow - t * (maxRow - minRow));
    heightsMm[i] = t * heightMm;
    radiiMm[i] = Math.max(0.5, rawRadii[row] * pxToMm);
  }

  // Smooth radial profile to eliminate pixel stair-stepping
  if (smoothWindow > 0) {
    const smoothed = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      let sum = 0;
      let cnt = 0;
      for (let k = -smoothWindow; k <= smoothWindow; k++) {
        const j = i + k;
        if (j >= 0 && j < sampleCount) {
          sum += radiiMm[j];
          cnt++;
        }
      }
      smoothed[i] = sum / cnt;
    }
    radiiMm.set(smoothed);
  }

  // Build closed 2D Lathe profile starting at axis r=0 bottom -> outer wall -> axis r=0 top (or inner hollow wall)
  const points: THREE.Vector2[] = [];
  points.push(new THREE.Vector2(0, 0));
  for (let i = 0; i < sampleCount; i++) {
    points.push(new THREE.Vector2(radiiMm[i], heightsMm[i]));
  }

  if (hollowWallMm > 0.4 && hollowWallMm < Math.max(...radiiMm) * 0.7) {
    // Open top hollow vessel with specified wall thickness and solid floor
    const floorMm = Math.min(heightMm * 0.25, Math.max(1.5, hollowWallMm));
    for (let i = sampleCount - 1; i >= 0; i--) {
      if (heightsMm[i] <= floorMm) break;
      const innerR = Math.max(0.4, radiiMm[i] - hollowWallMm);
      points.push(new THREE.Vector2(innerR, heightsMm[i]));
    }
    points.push(new THREE.Vector2(0, floorMm));
  } else {
    points.push(new THREE.Vector2(0, heightMm));
  }

  const geometry = new THREE.LatheGeometry(points, segments);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}
