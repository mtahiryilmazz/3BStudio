import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import {
  normalizeTurnaroundGroup,
  removeBackgroundFast,
} from '../maskProcessor';
import { reconstructVisualHull } from '../visualHull';
import { reconstructContourExtrude } from '../contourExtrude';
import { reconstructLathe } from '../latheRevolve';
import {
  decimateFlatRegions,
  subdivideGeometry,
  subdivideWithBudget,
  upscaleAndCompactMesh,
  analyzeMesh,
} from '../meshRepair';
import { assignDualHemisphereUVs, bakeDualHemispherePbrAtlas } from '../photogrammetry';
import { detectCharacterSheetGrid } from '../sheetSplit';
import { CHARACTER_SAMPLE_PRESETS, MECHANICAL_DEMO_PRESETS } from '../sampleGallery';
import type { BinaryMask } from '../types';

function makeImageData(width: number, height: number, bg: [number, number, number, number] = [255, 255, 255, 255]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bg[0];
    data[i + 1] = bg[1];
    data[i + 2] = bg[2];
    data[i + 3] = bg[3];
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
}

function fillRect(
  img: ImageData,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgba: [number, number, number, number]
): void {
  const { width, height, data } = img;
  const xEnd = Math.min(width, Math.round(x0 + w));
  const yEnd = Math.min(height, Math.round(y0 + h));
  for (let y = Math.max(0, Math.round(y0)); y < yEnd; y++) {
    for (let x = Math.max(0, Math.round(x0)); x < xEnd; x++) {
      const o = (y * width + x) * 4;
      data[o] = rgba[0];
      data[o + 1] = rgba[1];
      data[o + 2] = rgba[2];
      data[o + 3] = rgba[3];
    }
  }
}

function fillCircle(
  img: ImageData,
  cx: number,
  cy: number,
  r: number,
  rgba: [number, number, number, number]
): void {
  const { width, height, data } = img;
  const r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        const o = (y * width + x) * 4;
        data[o] = rgba[0];
        data[o + 1] = rgba[1];
        data[o + 2] = rgba[2];
        data[o + 3] = rgba[3];
      }
    }
  }
}

function maskExtent(mask: BinaryMask): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = mask.width, maxX = -1, minY = mask.height, maxY = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

describe('Oran Kilidi, Merdiven Düzeltmesi, Doku Koruması ve Örnek Doğrulama', () => {
  it('normalizeTurnaroundGroup: T-poz geniş ön ile dar yan görünümü 1:1 ortak boyda hizalar', () => {
    // Ön: 160px geniş T-poz kollar + 200px boy
    const front = makeImageData(256, 256, [0, 0, 0, 0]);
    fillRect(front, 108, 28, 40, 200, [40, 70, 120, 255]); // gövde
    fillRect(front, 48, 72, 160, 22, [40, 70, 120, 255]);  // T-poz kollar

    // Yan: 44px dar gövde + 200px boy
    const right = makeImageData(256, 256, [0, 0, 0, 0]);
    fillRect(right, 106, 28, 44, 200, [180, 90, 40, 255]);

    const normList = normalizeTurnaroundGroup(
      [
        { angle: 'front', imageData: front },
        { angle: 'right', imageData: right },
      ],
      128,
      0.08
    );
    const frontNorm = normList.find((n) => n.angle === 'front');
    const rightNorm = normList.find((n) => n.angle === 'right');
    expect(frontNorm).toBeDefined();
    expect(rightNorm).toBeDefined();

    const fExt = maskExtent(frontNorm!.mask);
    const rExt = maskExtent(rightNorm!.mask);
    const fH = fExt.maxY - fExt.minY + 1;
    const rH = rExt.maxY - rExt.minY + 1;
    const fW = fExt.maxX - fExt.minX + 1;
    const rW = rExt.maxX - rExt.minX + 1;

    // İki görünümün de yüksekliği birebir (≤ 2 px fark) aynı olmalı
    expect(Math.abs(fH - rH)).toBeLessThanOrEqual(2);
    // Yan görünüm gerçekte çok daha dar olduğu için normalize sonrasında da belirgin şekilde dar kalmalı
    expect(rW / fW).toBeLessThan(0.42);
  });

  it('subdivideGeometry, subdivideWithBudget ve upscaleAndCompactMesh UV ve vertex renklerini korur', () => {
    const base = new THREE.BoxGeometry(20, 40, 20, 2, 4, 2).toNonIndexed();
    const pos = base.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      colors[i * 3] = 0.2 + 0.6 * ((i % 7) / 6);
      colors[i * 3 + 1] = 0.45;
      colors[i * 3 + 2] = 0.8;
    }
    base.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const withUv = assignDualHemisphereUVs(base);

    const sub1 = subdivideGeometry(withUv, 1);
    expect(sub1.getAttribute('uv')).toBeDefined();
    expect(sub1.getAttribute('uv2')).toBeDefined();
    expect(sub1.getAttribute('color')).toBeDefined();
    expect(sub1.getAttribute('position').count).toBe(withUv.getAttribute('position').count * 4);

    // Tüm UV değerleri sonlu ve [0, 1] aralığında olmalı
    const uvAttr = sub1.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uvAttr.count; i++) {
      expect(Number.isFinite(uvAttr.getX(i))).toBe(true);
      expect(Number.isFinite(uvAttr.getY(i))).toBe(true);
      expect(uvAttr.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uvAttr.getX(i)).toBeLessThanOrEqual(1);
    }

    const budgeted = subdivideWithBudget(withUv, 1);
    expect(budgeted.geometry.getAttribute('uv')).toBeDefined();
    expect(budgeted.geometry.getAttribute('color')).toBeDefined();

    const decimated = decimateFlatRegions(sub1, {});
    expect(decimated.geometry.getAttribute('uv')).toBeDefined();
    expect(decimated.geometry.getAttribute('color')).toBeDefined();

    const upscaled = upscaleAndCompactMesh(withUv);
    expect(upscaled.geometry.getAttribute('uv')).toBeDefined();
    expect(upscaled.geometry.getAttribute('color')).toBeDefined();

    base.dispose();
    withUv.dispose();
    sub1.dispose();
    budgeted.geometry.dispose();
    decimated.geometry.dispose();
    upscaled.geometry.dispose();
  });

  it('reconstructVisualHull: tek yan profilde simetrik aynalama ve pürüzsüz yuvarlak yüzey üretir', () => {
    const front = makeImageData(128, 128, [0, 0, 0, 0]);
    const right = makeImageData(128, 128, [0, 0, 0, 0]);
    // Yuvarlak küre/vazo silüeti + belirgin renk farkı: Ön mavi, Yan parlak turuncu
    fillCircle(front, 64, 64, 44, [40, 110, 220, 255]);
    fillCircle(right, 64, 64, 34, [235, 130, 35, 255]);

    const normList = normalizeTurnaroundGroup(
      [
        { angle: 'front', imageData: front },
        { angle: 'right', imageData: right },
      ],
      128,
      0.08
    );
    const frontNorm = normList.find((n) => n.angle === 'front')!;
    const rightNorm = normList.find((n) => n.angle === 'right')!;
    const geo = reconstructVisualHull(
      { front: frontNorm.mask, right: rightNorm.mask },
      {
        resolution: 56,
        smoothPasses: 2,
        sizeMm: 80,
        colorViews: { front: frontNorm.cleanedImageData, right: rightNorm.cleanedImageData },
        projectColors: true,
        symmetricSideMirror: true,
      }
    );

    const stats = analyzeMesh(geo);
    expect(stats.triangleCount).toBeGreaterThan(200);
    expect(stats.widthMm).toBeGreaterThan(30);
    expect(stats.heightMm).toBeGreaterThan(30);

    // +X ve -X yan yüzey vertex'leri turuncu (R > B) yan rengi simetrik almalı
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    expect(col).toBeDefined();

    let posXOrange = 0;
    let negXOrange = 0;
    for (let i = 0; i < pos.count; i++) {
      const nx = nrm.getX(i);
      const r = col.getX(i);
      const b = col.getZ(i);
      expect(Number.isFinite(pos.getX(i))).toBe(true);
      if (nx > 0.78 && r > b + 0.12) posXOrange++;
      if (nx < -0.78 && r > b + 0.12) negXOrange++;
    }
    expect(posXOrange).toBeGreaterThan(5);
    expect(negXOrange).toBeGreaterThan(5);

    // 2K PBR atlas da tek yan simetriyle hatasız pişmeli
    const pbr = bakeDualHemispherePbrAtlas(
      { front, right },
      { width: 256, height: 128, symmetricSideMirror: true }
    );
    expect(pbr.albedo.length).toBe(256 * 128 * 4);
    geo.dispose();
  });

  it('Mekanik demo parçalar: L-Braket cıvata delikleri açılır ve Torna düğmesi su geçirmez üretilir', () => {
    // L-Braket sentetik görseli (açık gri arka plan + koyu gövde + 2 adet açık gri iç cıvata deliği)
    const bracketImg = makeImageData(128, 128, [221, 229, 239, 255]);
    fillRect(bracketImg, 24, 18, 28, 92, [58, 72, 92, 255]);  // dikey kol
    fillRect(bracketImg, 24, 82, 82, 28, [58, 72, 92, 255]);  // yatay taban
    fillCircle(bracketImg, 38, 36, 7, [221, 229, 239, 255]);  // üst delik
    fillCircle(bracketImg, 88, 96, 7, [221, 229, 239, 255]);  // sağ delik

    const cleanedBracket = removeBackgroundFast(bracketImg, 34, { cutInteriorHoles: true });
    // Delik merkez pikseli kesinlikle saydam (alpha === 0) olmalı
    expect(cleanedBracket.data[(36 * 128 + 38) * 4 + 3]).toBe(0);
    expect(cleanedBracket.data[(96 * 128 + 88) * 4 + 3]).toBe(0);
    // Gövde pikseli dolu (alpha === 255) olmalı
    expect(cleanedBracket.data[(64 * 128 + 38) * 4 + 3]).toBe(255);

    const bMask: BinaryMask = {
      width: 128,
      height: 128,
      data: new Uint8Array(128 * 128),
    };
    for (let i = 0; i < bMask.data.length; i++) {
      bMask.data[i] = cleanedBracket.data[i * 4 + 3] > 128 ? 1 : 0;
    }

    const bracketGeo = reconstructContourExtrude(bMask, { widthMm: 60, thicknessMm: 8, bevelMm: 0.5 });
    const bracketStats = analyzeMesh(bracketGeo);
    expect(bracketStats.triangleCount).toBeGreaterThan(80);
    expect(bracketStats.widthMm).toBeGreaterThan(50);

    // Döner düğme (Torna)
    const knobImg = makeImageData(128, 128, [221, 229, 239, 255]);
    fillRect(knobImg, 24, 82, 80, 26, [52, 65, 84, 255]);
    fillRect(knobImg, 36, 32, 56, 54, [52, 65, 84, 255]);
    const cleanedKnob = removeBackgroundFast(knobImg, 34);
    const kMask: BinaryMask = {
      width: 128,
      height: 128,
      data: new Uint8Array(128 * 128),
    };
    for (let i = 0; i < kMask.data.length; i++) {
      kMask.data[i] = cleanedKnob.data[i * 4 + 3] > 128 ? 1 : 0;
    }
    const knobGeo = reconstructLathe(kMask, { heightMm: 45, hollowWallMm: 0 });
    const knobStats = analyzeMesh(knobGeo);
    expect(knobStats.triangleCount).toBeGreaterThan(200);
    expect(knobStats.heightMm).toBeGreaterThan(35);

    bracketGeo.dispose();
    knobGeo.dispose();
  });

  it('detectCharacterSheetGrid (focusedIsolation): uzun ana turnaround figürlerini ayıklar, ek kısa pozları dışlar', () => {
    const sheet = makeImageData(600, 400, [245, 245, 245, 255]);
    // 3 adet ana uzun turnaround figürü (boy: 280px)
    fillRect(sheet, 20, 20, 75, 280, [45, 50, 62, 255]);   // Ön
    fillRect(sheet, 120, 20, 48, 280, [55, 60, 72, 255]);  // Yan (dar)
    fillRect(sheet, 195, 20, 75, 280, [40, 45, 58, 255]);  // Arka

    // Sağ tarafta 2 adet daha kısa ek poz (boy: 150px)
    fillRect(sheet, 330, 170, 56, 150, [70, 75, 85, 255]);
    fillRect(sheet, 415, 170, 56, 150, [70, 75, 85, 255]);

    const grid = detectCharacterSheetGrid(sheet, { stripFrames: true, focusedIsolation: true });
    const activeFigs = grid.cells.filter((c) => c.kind === 'figure' && !c.excludedByDefault);
    const excludedFigs = grid.cells.filter((c) => c.kind === 'figure' && c.excludedByDefault);

    expect(activeFigs.length).toBe(3);
    expect(excludedFigs.length).toBeGreaterThanOrEqual(2);
    const angles = new Set(activeFigs.map((f) => f.suggestedAngle));
    expect(angles.has('front')).toBe(true);
    expect(angles.has('right')).toBe(true);
    expect(angles.has('back')).toBe(true);
  });

  it('Örnek galeri varlıklarının tamamı public/assets/aistudio altında mevcut', () => {
    expect(CHARACTER_SAMPLE_PRESETS.length).toBe(8);
    expect(MECHANICAL_DEMO_PRESETS.length).toBe(3);
    for (const preset of CHARACTER_SAMPLE_PRESETS) {
      const diskPath = path.resolve(process.cwd(), 'public', preset.assetPath.replace(/^\//, ''));
      expect(fs.existsSync(diskPath), `Eksik örnek dosya: ${diskPath}`).toBe(true);
    }
  });
});
