import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
import { marchingCubes } from '../marchingCubes';
import { reconstructVisualHull } from '../visualHull';
import { reconstructContourExtrude } from '../contourExtrude';
import { reconstructLathe } from '../latheRevolve';
import {
  analyzeMesh,
  repairMesh,
  voxelRemesh,
  taubinSmooth,
  simplifyMesh,
  scaleToDimension,
  flatCutBottom,
} from '../meshRepair';
import { buildSTLBinary, build3MF, buildOBJ } from '../exporters';
import { parsePLY } from '../plyImporter';
import { BinaryMask } from '../types';

function makeCircleMask(size: number, radius: number, holeRadius = 0): BinaryMask {
  const data = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d <= radius && d >= holeRadius) {
        data[y * size + x] = 1;
      }
    }
  }
  return { width: size, height: size, data };
}

function makeRectMask(size: number, halfW: number, halfH: number): BinaryMask {
  const data = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.abs(x - c) <= halfW && Math.abs(y - c) <= halfH) {
        data[y * size + x] = 1;
      }
    }
  }
  return { width: size, height: size, data };
}

describe('Photo2Print 3D Engine', () => {
  it('marchingCubes produces a closed, watertight, positive-volume sphere', () => {
    const n = 36;
    const field = new Float32Array(n * n * n);
    const center = (n - 1) / 2;
    const radius = 10;

    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const d = Math.hypot(x - center, y - center, z - center);
          field[(z * n + y) * n + x] = radius - d; // >= 0 inside
        }
      }
    }

    const geo = marchingCubes(field, n, n, n, 0, [-18, -18, -18], [18, 18, 18]);
    const stats = analyzeMesh(geo);

    expect(stats.triangleCount).toBeGreaterThan(500);
    expect(stats.openBoundaryEdges).toBe(0);
    expect(stats.nonManifoldEdges).toBe(0);
    expect(stats.isWatertight).toBe(true);
    // Theoretical sphere volume of R=10mm: 4/3 * pi * 1000 / 1000 = 4.189 cm³
    expect(stats.volumeCm3).toBeGreaterThan(3.5);
    expect(stats.volumeCm3).toBeLessThan(4.8);
  });

  it('reconstructVisualHull generates watertight mesh seated on Y=0 from 4 views', () => {
    const mask = makeCircleMask(64, 20);
    const geo = reconstructVisualHull(
      { front: mask, right: mask, back: mask, left: mask },
      { resolution: 36, smoothPasses: 2, sizeMm: 50 }
    );
    const stats = analyzeMesh(geo);

    expect(stats.isWatertight).toBe(true);
    expect(stats.openBoundaryEdges).toBe(0);
    expect(stats.widthMm).toBeCloseTo(50, 0);
    expect(geo.boundingBox!.min.y).toBeCloseTo(0, 2);
  });

  it('reconstructContourExtrude preserves outer width, thickness, and internal bolt hole', () => {
    const bracketWithHole = makeCircleMask(96, 36, 12);
    const geo = reconstructContourExtrude(bracketWithHole, {
      widthMm: 60,
      thicknessMm: 8,
      bevelMm: 0.5,
    });
    const stats = analyzeMesh(geo);

    expect(stats.widthMm).toBeGreaterThan(55);
    expect(stats.widthMm).toBeLessThan(65);
    expect(stats.heightMm).toBeCloseTo(8, 1);
    // Volume of solid cylinder R=30, H=8 is 22.6 cm³; with R=10 hole it is ~20.1 cm³
    expect(stats.volumeCm3).toBeGreaterThan(15);
    expect(stats.volumeCm3).toBeLessThan(22.2);
  });

  it('reconstructLathe produces watertight symmetric solid matching heightMm', () => {
    const knobMask = makeRectMask(64, 18, 22);
    const geo = reconstructLathe(knobMask, { heightMm: 40, segments: 32 });
    const stats = analyzeMesh(geo);

    expect(stats.triangleCount).toBeGreaterThan(100);
    expect(stats.openBoundaryEdges).toBe(0);
    expect(stats.heightMm).toBeCloseTo(40, 1);
  });

  it('repairMesh closes open cylinder cap and restores watertightness', () => {
    // Open-ended cylinder (openEnded = true) has open boundary loops
    const openCyl = new THREE.CylinderGeometry(15, 15, 30, 24, 1, true);
    const before = analyzeMesh(openCyl);
    expect(before.isWatertight).toBe(false);
    expect(before.openBoundaryEdges).toBeGreaterThan(0);

    const repaired = repairMesh(openCyl);
    const after = analyzeMesh(repaired);
    expect(after.openBoundaryEdges).toBe(0);
    expect(after.isWatertight).toBe(true);
  });

  it('voxelRemesh, taubinSmooth, simplifyMesh, scaleToDimension, and flatCutBottom work cleanly', () => {
    const box = new THREE.BoxGeometry(20, 30, 20);
    const remeshed = voxelRemesh(box, 36);
    expect(analyzeMesh(remeshed).isWatertight).toBe(true);

    const smoothed = taubinSmooth(remeshed, 2);
    expect(analyzeMesh(smoothed).isWatertight).toBe(true);

    const simplified = simplifyMesh(smoothed, 0.5);
    expect(analyzeMesh(simplified).triangleCount).toBeGreaterThan(20);

    const scaled = scaleToDimension(simplified, 'x', 80, true);
    expect(analyzeMesh(scaled).widthMm).toBeCloseTo(80, 0);

    const cut = flatCutBottom(scaled, 5);
    const cutStats = analyzeMesh(cut);
    expect(cutStats.isWatertight).toBe(true);
    expect(cut.boundingBox!.min.y).toBeCloseTo(0, 2);
  });

  it('buildSTLBinary, build3MF, and buildOBJ export valid slicer-ready Z-up files', () => {
    const box = new THREE.BoxGeometry(20, 10, 30);
    // Test STL
    const stl = buildSTLBinary(box);
    const view = new DataView(stl);
    const triCount = view.getUint32(80, true);
    expect(triCount).toBe(12);
    expect(stl.byteLength).toBe(84 + triCount * 50);

    // Check Z coordinates >= 0 in STL
    let minZ = Infinity;
    for (let t = 0; t < triCount; t++) {
      for (let v = 0; v < 3; v++) {
        const z = view.getFloat32(84 + t * 50 + 12 + v * 12 + 8, true);
        if (z < minZ) minZ = z;
      }
    }
    expect(minZ).toBeCloseTo(0, 3);

    // Test 3MF
    const threeMf = build3MF(box);
    const unzipped = unzipSync(threeMf);
    expect(unzipped['[Content_Types].xml']).toBeDefined();
    expect(unzipped['_rels/.rels']).toBeDefined();
    expect(unzipped['3D/3dmodel.model']).toBeDefined();
    const modelXml = strFromU8(unzipped['3D/3dmodel.model']);
    expect(modelXml).toContain('unit="millimeter"');

    // Test OBJ
    const obj = buildOBJ(box);
    expect(obj).toContain('v ');
    expect(obj).toContain('f ');
  });

  it('parsePLY reconstructs watertight solid mesh from ASCII point cloud', () => {
    const lines = ['ply', 'format ascii 1.0'];
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 120; i++) {
      const phi = Math.acos(1 - (2 * (i + 0.5)) / 120);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      pts.push([
        Math.sin(phi) * Math.cos(theta) * 20,
        Math.cos(phi) * 20,
        Math.sin(phi) * Math.sin(theta) * 20,
      ]);
    }
    lines.push(`element vertex ${pts.length}`);
    lines.push('property float x', 'property float y', 'property float z', 'end_header');
    for (const p of pts) lines.push(`${p[0].toFixed(3)} ${p[1].toFixed(3)} ${p[2].toFixed(3)}`);

    const buf = new TextEncoder().encode(lines.join('\n')).buffer;
    const parsed = parsePLY(buf);
    expect(parsed.wasPointCloud).toBe(true);
    expect(parsed.pointCount).toBe(120);
    const stats = analyzeMesh(parsed.geometry);
    expect(stats.triangleCount).toBeGreaterThan(100);
    expect(stats.isWatertight).toBe(true);
  });
});
