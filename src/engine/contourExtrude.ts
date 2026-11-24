import * as THREE from 'three';
import { BinaryMask } from './types';

export interface ContourExtrudeOptions {
  widthMm: number;
  thicknessMm: number;
  simplifyEpsilon?: number;
  bevelMm?: number;
  smoothIterations?: number;
}

interface Point2D {
  x: number;
  y: number;
}

/**
 * Signed shoelace area (>0 means counter-clockwise in standard XY coords).
 */
function signedArea(pts: Point2D[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

/**
 * Ramer-Douglas-Peucker simplification on a closed polygon.
 */
function simplifyPolygon(pts: Point2D[], epsilon: number): Point2D[] {
  if (pts.length <= 4 || epsilon <= 0) return pts;

  const perpDist = (p: Point2D, a: Point2D, b: Point2D) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };

  const rdp = (slice: Point2D[]): Point2D[] => {
    let maxDist = 0;
    let idx = 0;
    const start = slice[0];
    const end = slice[slice.length - 1];
    for (let i = 1; i < slice.length - 1; i++) {
      const d = perpDist(slice[i], start, end);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (maxDist > epsilon) {
      const left = rdp(slice.slice(0, idx + 1));
      const right = rdp(slice.slice(idx));
      return left.slice(0, -1).concat(right);
    }
    return [start, end];
  };

  // Split closed ring at farthest pair to run open RDP cleanly
  let splitIdx = Math.floor(pts.length / 2);
  let bestDist = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > bestDist) {
      bestDist = d;
      splitIdx = i;
    }
  }

  const part1 = rdp(pts.slice(0, splitIdx + 1));
  const part2 = rdp(pts.slice(splitIdx).concat([pts[0]]));
  return part1.slice(0, -1).concat(part2.slice(0, -1));
}

function chaikinSmooth(pts: Point2D[], iterations: number): Point2D[] {
  let curr = pts;
  for (let it = 0; it < iterations; it++) {
    if (curr.length < 3) break;
    const next: Point2D[] = [];
    for (let i = 0; i < curr.length; i++) {
      const p0 = curr[i];
      const p1 = curr[(i + 1) % curr.length];
      next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
      next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
    }
    curr = next;
  }
  return curr;
}

/**
 * Extracts closed boundary loops (outer contours and inner holes) from a binary mask
 * using Marching Squares edge chaining.
 */
function extractContours(mask: BinaryMask): Point2D[][] {
  const w = mask.width;
  const h = mask.height;
  const sample = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return mask.data[y * w + x] ? 1 : 0;
  };

  // Map from directed start vertex key -> end vertex key
  interface Segment {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    used: boolean;
  }
  const segments: Segment[] = [];
  const startBuckets = new Map<string, number[]>();

  const addSeg = (ax: number, ay: number, bx: number, by: number) => {
    const idx = segments.length;
    segments.push({ ax, ay, bx, by, used: false });
    const key = `${ax},${ay}`;
    const arr = startBuckets.get(key);
    if (arr) arr.push(idx);
    else startBuckets.set(key, [idx]);
  };

  // Marching squares cell edges (coordinates scaled by 2 to keep exact integer keys)
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = sample(x, y);
      const tr = sample(x + 1, y);
      const br = sample(x + 1, y + 1);
      const bl = sample(x, y + 1);
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      // Edge midpoints in 2x integer space (Y flipped upward for 2D Shape)
      const topX = 2 * x + 1, topY = -2 * y;
      const rightX = 2 * x + 2, rightY = -(2 * y + 1);
      const botX = 2 * x + 1, botY = -(2 * y + 2);
      const leftX = 2 * x, leftY = -(2 * y + 1);

      // Follow standard CCW around foreground (1)
      switch (code) {
        case 1: addSeg(leftX, leftY, botX, botY); break;
        case 2: addSeg(botX, botY, rightX, rightY); break;
        case 3: addSeg(leftX, leftY, rightX, rightY); break;
        case 4: addSeg(rightX, rightY, topX, topY); break;
        case 5:
          addSeg(leftX, leftY, topX, topY);
          addSeg(rightX, rightY, botX, botY);
          break;
        case 6: addSeg(botX, botY, topX, topY); break;
        case 7: addSeg(leftX, leftY, topX, topY); break;
        case 8: addSeg(topX, topY, leftX, leftY); break;
        case 9: addSeg(topX, topY, botX, botY); break;
        case 10:
          addSeg(topX, topY, rightX, rightY);
          addSeg(botX, botY, leftX, leftY);
          break;
        case 11: addSeg(topX, topY, rightX, rightY); break;
        case 12: addSeg(rightX, rightY, leftX, leftY); break;
        case 13: addSeg(rightX, rightY, botX, botY); break;
        case 14: addSeg(botX, botY, leftX, leftY); break;
      }
    }
  }

  const loops: Point2D[][] = [];

  for (let i = 0; i < segments.length; i++) {
    if (segments[i].used) continue;
    const loop: Point2D[] = [];
    let currIdx: number | undefined = i;

    while (currIdx !== undefined && !segments[currIdx].used) {
      const seg = segments[currIdx];
      seg.used = true;
      loop.push({ x: seg.ax * 0.5, y: seg.ay * 0.5 });

      const nextKey = `${seg.bx},${seg.by}`;
      const candidates = startBuckets.get(nextKey);
      currIdx = undefined;
      if (candidates) {
        for (const cand of candidates) {
          if (!segments[cand].used) {
            currIdx = cand;
            break;
          }
        }
      }
    }

    if (loop.length >= 4) {
      loops.push(loop);
    }
  }

  return loops;
}

function pointInPolygon(pt: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Converts a 2D mechanical silhouette (including internal bolt holes/cutouts)
 * into a 3D extruded solid placed flat on the print bed (Y = 0).
 */
export function reconstructContourExtrude(
  mask: BinaryMask,
  options: ContourExtrudeOptions
): THREE.BufferGeometry {
  const widthMm = Math.max(2, options.widthMm);
  const thicknessMm = Math.max(0.5, options.thicknessMm);
  const simplifyEpsilon = options.simplifyEpsilon ?? 1.2;
  const smoothIterations = options.smoothIterations ?? 1;
  const bevelMm = Math.min(options.bevelMm ?? 0, thicknessMm * 0.25);

  const rawLoops = extractContours(mask);
  if (rawLoops.length === 0) {
    throw new Error('Fotoğraf maskesinden dış kontur çıkarılamadı.');
  }

  // Filter noise loops and compute areas
  const processed = rawLoops
    .map((raw) => {
      let pts = simplifyPolygon(raw, simplifyEpsilon);
      if (smoothIterations > 0) pts = chaikinSmooth(pts, smoothIterations);
      return { pts, area: signedArea(pts) };
    })
    .filter((item) => item.pts.length >= 3 && Math.abs(item.area) > 16);

  if (processed.length === 0) {
    throw new Error('Geçerli boyutta bir parça konturu bulunamadı.');
  }

  // Sort largest absolute area first -> largest is outer boundary
  processed.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

  const outer = processed[0];
  const outerPts = outer.area > 0 ? outer.pts : [...outer.pts].reverse();

  // Compute pixel span of outer contour to scale accurately to widthMm
  let minX = Infinity, maxX = -Infinity;
  for (const p of outerPts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const pixelWidth = Math.max(1, maxX - minX);
  const pxToMm = widthMm / pixelWidth;

  const shape = new THREE.Shape();
  outerPts.forEach((p, idx) => {
    const mx = p.x * pxToMm;
    const my = p.y * pxToMm;
    if (idx === 0) shape.moveTo(mx, my);
    else shape.lineTo(mx, my);
  });
  shape.closePath();

  // Any smaller loop inside outer is treated as a hole (bolt hole / cutout)
  for (let i = 1; i < processed.length; i++) {
    const item = processed[i];
    if (pointInPolygon(item.pts[0], outerPts)) {
      const holePts = item.area < 0 ? item.pts : [...item.pts].reverse();
      const holePath = new THREE.Path();
      holePts.forEach((p, idx) => {
        const mx = p.x * pxToMm;
        const my = p.y * pxToMm;
        if (idx === 0) holePath.moveTo(mx, my);
        else holePath.lineTo(mx, my);
      });
      holePath.closePath();
      shape.holes.push(holePath);
    }
  }

  const extrudeDepth = Math.max(0.2, thicknessMm - 2 * bevelMm);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: extrudeDepth,
    bevelEnabled: bevelMm > 0.05,
    bevelThickness: bevelMm,
    bevelSize: bevelMm,
    bevelSegments: bevelMm > 0.05 ? 2 : 0,
    curveSegments: 16,
  });

  // Rotate from XY+Z extrusion to lie flat on print bed XZ with thickness along +Y
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const center = new THREE.Vector3();
  box.getCenter(center);

  geometry.translate(-center.x, -box.min.y, -center.z);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}
