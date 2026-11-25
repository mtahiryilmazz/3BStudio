import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  boxFromDragPoints,
  clampBoxToBounds,
  createCenteredDefaultBox,
  detectCharacterSheetGrid,
  moveSheetBox,
  resizeSheetBox,
} from '../sheetSplit';
import { reconstructVisualHull } from '../visualHull';
import {
  analyzeMesh,
  countTriangles,
  decimateFlatRegions,
  estimateMeshBytes,
  upscaleAndCompactMesh,
} from '../meshRepair';
import { build3MF, buildMultiColor3MF, buildOBJ, buildSTLBinary, quantizeVertexColorsKMeans } from '../exporters';
import { hardenAlphaMask } from '../maskProcessor';
import {
  addDisplayPedestal,
  analyzeSubjectRouting,
  bakeDualHemispherePbrAtlas,
  buildComfyUiWorkflowJson,
  buildLodGeometry,
  buildRunManifest,
  COMFY_WORKFLOW_PRESETS,
  computeFrontSilhouetteIoU,
  computeTriangleQuality,
  evaluatePolyMollyQa,
  evaluatePrintabilityDoctor,
  pruneLooseFragments,
} from '../photogrammetry';
import { buildNodeGLB } from '../../../cli/image2model';
import type { BinaryMask, ViewAngle } from '../types';

function makeImageData(width: number, height: number, fill: [number, number, number] = [245, 245, 245]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData;
}

function fillRect(
  img: ImageData,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: [number, number, number]
) {
  const { width, height, data } = img;
  const sx0 = Math.max(0, Math.floor(x0));
  const sy0 = Math.max(0, Math.floor(y0));
  const sx1 = Math.min(width - 1, Math.floor(x1));
  const sy1 = Math.min(height - 1, Math.floor(y1));
  for (let y = sy0; y <= sy1; y++) {
    for (let x = sx0; x <= sx1; x++) {
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
}

function fillEllipse(
  img: ImageData,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: [number, number, number]
) {
  const { width, height, data } = img;
  const sx0 = Math.max(0, Math.floor(cx - rx));
  const sy0 = Math.max(0, Math.floor(cy - ry));
  const sx1 = Math.min(width - 1, Math.ceil(cx + rx));
  const sy1 = Math.min(height - 1, Math.ceil(cy + ry));
  for (let y = sy0; y <= sy1; y++) {
    for (let x = sx0; x <= sx1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        const i = (y * width + x) * 4;
        data[i] = color[0];
        data[i + 1] = color[1];
        data[i + 2] = color[2];
        data[i + 3] = 255;
      }
    }
  }
}

/**
 * Gerçek stüdyo karakter sheet düzenini (gri dikey cyclorama + 2 tam boy figür +
 * sağ-alt köşeyi tamamen kaplayan büyük yüz/omuz portresi) birebir simüle eder.
 */
function buildStudioPortraitSheet(variant: 'white-shirt' | 'red-jacket'): ImageData {
  const w = 640;
  const h = 360;
  const img = makeImageData(w, h, [126, 127, 129]);

  // Gerçekçi dikey stüdyo cyclorama gradyanı (üst: 120 → alt zemin: 146)
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const v = Math.round(118 + t * 28);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v + 1;
      img.data[i + 2] = v + 3;
      img.data[i + 3] = 255;
    }
  }

  const topColor: [number, number, number] = variant === 'white-shirt' ? [236, 236, 232] : [172, 26, 34];
  const pantsColor: [number, number, number] = variant === 'white-shirt' ? [222, 212, 194] : [26, 30, 44];
  const shoeColor: [number, number, number] = variant === 'white-shirt' ? [232, 230, 224] : [24, 24, 28];
  const skinColor: [number, number, number] = [194, 144, 114];
  const hairColor: [number, number, number] = [28, 25, 24];

  // 1) Sol tam boy figür (başsız veya yüzü bantlı ön görünüm)
  if (variant === 'red-jacket') {
    fillEllipse(img, 96, 42, 16, 22, hairColor);
    fillRect(img, 62, 34, 132, 82, [224, 214, 184]); // yüzü kapatan bant
  }
  fillRect(img, 64, 82, 128, 192, topColor); // gövde
  fillRect(img, 70, 192, 92, 316, pantsColor); // sol bacak
  fillRect(img, 100, 192, 122, 316, pantsColor); // sağ bacak
  fillRect(img, 64, 316, 94, 336, shoeColor);
  fillRect(img, 98, 316, 128, 336, shoeColor);

  // 2) Orta tam boy figür (arka görünüm)
  fillEllipse(img, 248, 44, 16, 22, hairColor);
  fillRect(img, 238, 58, 258, 76, skinColor); // ense/boyun bağlantısı
  fillRect(img, 216, 72, 280, 192, topColor);
  fillRect(img, 222, 192, 244, 316, pantsColor);
  fillRect(img, 252, 192, 274, 316, pantsColor);
  fillRect(img, 216, 316, 246, 336, shoeColor);
  fillRect(img, 250, 316, 280, 336, shoeColor);

  // 3) Sağ yarı: sağ-alt köşeye kadar taşan BÜYÜK yüz/göğüs portresi!
  fillRect(img, 332, 232, 639, 359, topColor); // omuzlar tüm sağ-alt köşeyi kaplar!
  fillRect(img, 444, 185, 520, 255, skinColor); // boyun
  fillEllipse(img, 482, 122, 58, 76, skinColor); // büyük yüz
  fillEllipse(img, 482, 62, 58, 28, hairColor); // saç

  return img;
}

/** Çizgili ızgaralı (framed) 5 veya 7 görünümlü karakter sheet üretir. */
function buildFramedGridSheet(count: 5 | 7): ImageData {
  const cols = count === 5 ? 5 : 4;
  const rows = count === 5 ? 1 : 2;
  const cellW = 110;
  const cellH = 180;
  const w = cols * cellW;
  const h = rows * cellH;
  const img = makeImageData(w, h, [246, 247, 249]);

  const borderColor: [number, number, number] = [30, 34, 42];
  // Dış ve iç ızgara çizgileri (3px kalınlık)
  for (let c = 0; c <= cols; c++) {
    const x = Math.min(w - 3, c * cellW);
    fillRect(img, x, 0, x + 2, h - 1, borderColor);
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.min(h - 3, r * cellH);
    fillRect(img, 0, y, w - 1, y + 2, borderColor);
  }

  let drawn = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (drawn >= count) break;
      const cx = c * cellW + cellW / 2;
      const cy = r * cellH + cellH / 2;
      // Karakter silüeti (koyu mavi gövde + ilk pozda yüz ten rengi)
      const bodyHalfW = drawn === 2 || drawn === 6 ? 18 : 26;
      fillRect(img, cx - bodyHalfW, cy - 38, cx + bodyHalfW, cy + 58, [40, 72, 132]);
      fillEllipse(
        img,
        cx,
        cy - 54,
        14,
        16,
        drawn === 0 ? [204, 152, 122] : [52, 58, 76]
      );
      drawn++;
    }
  }
  return img;
}

describe('Kenar Tabanlı Grid-Detection (Stüdyo Portre + 5/7 Çerçeveli Izgara)', () => {
  it('sağ-alt köşeyi beyaz tişörtlü portrenin kapladığı stüdyo sheetini 3 panel (front, back, face) olarak algılar', () => {
    const sheet = buildStudioPortraitSheet('white-shirt');
    const res = detectCharacterSheetGrid(sheet, { stripFrames: true });

    const figures = res.cells.filter((c) => c.kind === 'figure');
    const faces = res.cells.filter((c) => c.kind === 'face');

    expect(figures.length).toBe(2);
    expect(faces.length).toBe(1);
    expect(figures.map((f) => f.suggestedAngle)).toEqual(['front', 'back']);
    expect(faces[0].width).toBeGreaterThan(200);
  });

  it('sağ-alt köşeyi kırmızı ceketli portrenin kapladığı bantlı yüz stüdyo sheetini 3 panel (front, back, face) olarak algılar', () => {
    const sheet = buildStudioPortraitSheet('red-jacket');
    const res = detectCharacterSheetGrid(sheet, { stripFrames: true });

    const figures = res.cells.filter((c) => c.kind === 'figure');
    const faces = res.cells.filter((c) => c.kind === 'face');

    expect(figures.length).toBe(2);
    expect(faces.length).toBe(1);
    expect(figures.map((f) => f.suggestedAngle)).toEqual(['front', 'back']);
  });

  it('5 görünümlü çizgili ızgaralı sheeti framed-grid modunda böler, çerçeveyi keser ve 3/4 açı atar', () => {
    const sheet = buildFramedGridSheet(5);
    const res = detectCharacterSheetGrid(sheet, { stripFrames: true });

    expect(res.mode).toBe('framed-grid');
    expect(res.verticalLines.length).toBeGreaterThanOrEqual(4);
    expect(res.cells.length).toBe(5);
    expect(res.cells.every((c) => c.frameStripped)).toBe(true);
    expect(res.cells.map((c) => c.suggestedAngle)).toEqual([
      'front',
      'frontRight',
      'right',
      'back',
      'left',
    ]);
  });

  it('7 görünümlü 2 satırlı çizgili sheeti böler ve 7 farklı 360° açıya yerleştirir', () => {
    const sheet = buildFramedGridSheet(7);
    const res = detectCharacterSheetGrid(sheet, { stripFrames: true });

    expect(res.mode).toBe('framed-grid');
    expect(res.horizontalLines.length).toBeGreaterThanOrEqual(1);
    expect(res.cells.length).toBe(7);
    const uniqueAngles = new Set(res.cells.map((c) => c.suggestedAngle));
    expect(uniqueAngles.size).toBe(7);
    expect(uniqueAngles.has('frontRight')).toBe(true);
    expect(uniqueAngles.has('backRight')).toBe(true);
    expect(uniqueAngles.has('backLeft')).toBe(true);
  });
});

describe('9-Açılı 360° Visual Hull (45°/135°/225°/315° Köşe Kazıma)', () => {
  function circleMask(size: number, radiusRatio: number): BinaryMask {
    const data = new Uint8Array(size * size);
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    const r = size * radiusRatio;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          data[y * size + x] = 1;
        }
      }
    }
    return { width: size, height: size, data };
  }

  it('3/4 çapraz açılar eklendiğinde kare prizma köşelerini kazıyarak daha düşük hacimli ve su geçirmez model üretir', () => {
    const mask = circleMask(64, 0.36);
    const cardinalOnly: Partial<Record<ViewAngle, BinaryMask>> = {
      front: mask,
      right: mask,
      back: mask,
      left: mask,
    };
    const full360: Partial<Record<ViewAngle, BinaryMask>> = {
      ...cardinalOnly,
      frontRight: mask,
      backRight: mask,
      backLeft: mask,
      frontLeft: mask,
      top: mask,
    };

    const g4 = reconstructVisualHull(cardinalOnly, { resolution: 40, smoothPasses: 0, sizeMm: 60 });
    const g9 = reconstructVisualHull(full360, { resolution: 40, smoothPasses: 0, sizeMm: 60 });
    const s4 = analyzeMesh(g4);
    const s9 = analyzeMesh(g9);

    expect(s9.isWatertight).toBe(true);
    expect(s9.triangleCount).toBeGreaterThan(200);
    expect(s9.volumeCm3).toBeLessThan(s4.volumeCm3);
    g4.dispose();
    g9.dispose();
  });
});

describe('Ölçekten Bağımsız Max Upscale + Küçük Dosya (Akıllı Sıkıştırma & Exporter)', () => {
  it('15 mm küçük ve 200 mm büyük modellerde aynı detay yoğunluğunu ve tam fiziksel ölçüyü korur', () => {
    const smallBox = new THREE.BoxGeometry(15, 15, 15, 2, 2, 2).toNonIndexed();
    const largeBox = new THREE.BoxGeometry(200, 200, 200, 2, 2, 2).toNonIndexed();

    const smallRes = upscaleAndCompactMesh(smallBox, { targetDetailTriangles: 12000 });
    const largeRes = upscaleAndCompactMesh(largeBox, { targetDetailTriangles: 12000 });

    const smallStats = analyzeMesh(smallRes.geometry);
    const largeStats = analyzeMesh(largeRes.geometry);

    expect(smallStats.isWatertight).toBe(true);
    expect(largeStats.isWatertight).toBe(true);
    expect(smallStats.widthMm).toBeCloseTo(15, 0);
    expect(largeStats.widthMm).toBeCloseTo(200, 0);
    // Ölçekten bağımsız: küçük ve büyük model benzer üçgen detayında üretilir
    expect(Math.abs(smallRes.afterTriangles - largeRes.afterTriangles)).toBeLessThanOrEqual(
      Math.max(20, smallRes.afterTriangles * 0.15)
    );

    smallBox.dispose();
    largeBox.dispose();
    smallRes.geometry.dispose();
    largeRes.geometry.dispose();
  });

  it('decimateFlatRegions yüksek bölünmüş düz küp yüzeylerini su geçirmez biçimde ciddi oranda sıkıştırır', () => {
    const denseBox = new THREE.BoxGeometry(50, 50, 50, 8, 8, 8).toNonIndexed();
    const before = countTriangles(denseBox);
    const compact = decimateFlatRegions(denseBox, { planarAngleDeg: 5, maxPasses: 4 });
    const after = countTriangles(compact.geometry);
    const stats = analyzeMesh(compact.geometry);

    expect(after).toBeLessThan(before * 0.5);
    expect(stats.isWatertight).toBe(true);
    denseBox.dispose();
    compact.geometry.dispose();
  });

  it('build3MF sıkıştırılmış çıkışı ham STL boyutunun %35inden küçüktür ve OBJ/STL geçerli üretilir', () => {
    const sphere = new THREE.IcosahedronGeometry(30, 3).toNonIndexed();
    const stlRaw = buildSTLBinary(sphere, { smartCompress: false });
    const stlCompact = buildSTLBinary(sphere, { smartCompress: true });
    const mfCompact = build3MF(sphere, { smartCompress: true });
    const objCompact = buildOBJ(sphere, { smartCompress: true });
    const est = estimateMeshBytes(countTriangles(sphere));

    expect(mfCompact.byteLength).toBeLessThan(stlRaw.byteLength * 0.35);
    expect(stlCompact.byteLength).toBeLessThanOrEqual(stlRaw.byteLength);
    expect(est.compact3mfBytes).toBeLessThan(est.stlBytes);
    expect(est.compactGlbBytes).toBeLessThan(est.glbBytes);
    expect(objCompact).toContain('v ');
    expect(objCompact).toContain('f ');

    // 3MF ZIP magic header ('PK\x03\x04')
    const zipMagic = new DataView(mfCompact.buffer, mfCompact.byteOffset, 4).getUint32(0, false);
    expect(zipMagic).toBe(0x504b0304);
    sphere.dispose();
  });
});

describe('Etkileşimli Kutu Düzenleme Geometrisi', () => {
  it('clampBoxToBounds taşan koordinatları sınır içine alır ve minimum boyutu korur', () => {
    const clamped = clampBoxToBounds({ x: -30, y: 490, width: 8, height: 6 }, 640, 500, 16);
    expect(clamped.x).toBe(0);
    expect(clamped.width).toBe(16);
    expect(clamped.height).toBe(16);
    expect(clamped.y + clamped.height).toBe(500);

    const oversized = clampBoxToBounds({ x: 100, y: 100, width: 900, height: 700 }, 640, 500, 16);
    expect(oversized).toEqual({ x: 0, y: 0, width: 640, height: 500 });
  });

  it('moveSheetBox kutuyu taşırken boyutunu korur ve görsel sınırlarına kenetler', () => {
    const base = { x: 100, y: 80, width: 120, height: 200 };
    expect(moveSheetBox(base, 45, -30, 640, 480)).toEqual({ x: 145, y: 50, width: 120, height: 200 });
    expect(moveSheetBox(base, -500, -500, 640, 480)).toEqual({ x: 0, y: 0, width: 120, height: 200 });
    expect(moveSheetBox(base, 900, 900, 640, 480)).toEqual({ x: 520, y: 280, width: 120, height: 200 });
  });

  it('resizeSheetBox 8 tutamaçta karşı kenarı sabit tutar, minimum boyutun altına düşmez ve taşmaz', () => {
    const base = { x: 100, y: 100, width: 120, height: 160 };

    // Sol-üst (nw) küçültme: sağ ve alt kenar (220, 260) sabit kalmalı
    const nwRes = resizeSheetBox(base, 'nw', 30, 40, 640, 480, 20);
    expect(nwRes).toEqual({ x: 130, y: 140, width: 90, height: 120 });

    // Aşırı içe sürükleme: minimum boyut 20px korunmalı
    const nwMin = resizeSheetBox(base, 'nw', 500, 500, 640, 480, 20);
    expect(nwMin).toEqual({ x: 200, y: 240, width: 20, height: 20 });

    // Sağ-alt (se) dışa sürükleme: görsel sınırından taşmamalı
    const seMax = resizeSheetBox(base, 'se', 800, 800, 640, 480, 20);
    expect(seMax).toEqual({ x: 100, y: 100, width: 540, height: 380 });

    // Tek kenar tutamaçları (n, e, s, w) yalnızca ilgili ekseni değiştirmeli
    expect(resizeSheetBox(base, 'n', 99, -20, 640, 480, 20)).toEqual({ x: 100, y: 80, width: 120, height: 180 });
    expect(resizeSheetBox(base, 'e', 50, 99, 640, 480, 20)).toEqual({ x: 100, y: 100, width: 170, height: 160 });
    expect(resizeSheetBox(base, 's', 99, 40, 640, 480, 20)).toEqual({ x: 100, y: 100, width: 120, height: 200 });
    expect(resizeSheetBox(base, 'w', -40, 99, 640, 480, 20)).toEqual({ x: 60, y: 100, width: 160, height: 160 });
  });

  it('boxFromDragPoints ters yönde (sağ-alttan sol-üste) çizimde doğru normalize eder ve kırpar', () => {
    const box = boxFromDragPoints(320, 290, 120, 90, 640, 480);
    expect(box).toEqual({ x: 120, y: 90, width: 200, height: 200 });

    const clamped = boxFromDragPoints(700, -50, 500, 520, 640, 480);
    expect(clamped).toEqual({ x: 500, y: 0, width: 140, height: 480 });
  });

  it('createCenteredDefaultBox kademeli konumlandırılmış ve sınır içinde geçerli kutular üretir', () => {
    const b0 = createCenteredDefaultBox(800, 600, 0);
    const b1 = createCenteredDefaultBox(800, 600, 1);
    const b2 = createCenteredDefaultBox(800, 600, 2);

    for (const b of [b0, b1, b2]) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(800);
      expect(b.y + b.height).toBeLessThanOrEqual(600);
      expect(b.width).toBeGreaterThanOrEqual(24);
      expect(b.height).toBeGreaterThanOrEqual(24);
    }
    expect(b0.x).not.toBe(b1.x);
    expect(b1.x).not.toBe(b2.x);
  });
});

describe('3BStudio Nihai Ekosistem Motoru (BiRefNet / SF3D / Local3D+ / Local3D_Studio / ComfyUI / Pixal3D)', () => {
  it('hardenAlphaMask yarı saydam kenarları sertleştirir ve 1px arka plan halesini temizler', () => {
    const img = makeImageData(12, 12, [255, 255, 255]);
    // Dış alanı şeffaf, iç 6x6 alanı kırmızı, 1px sınırı yarı saydam pembe hale yap
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const i = (y * 12 + x) * 4;
        if (x >= 4 && x <= 7 && y >= 4 && y <= 7) {
          img.data[i] = 200;
          img.data[i + 1] = 30;
          img.data[i + 2] = 30;
          img.data[i + 3] = 255;
        } else if (x >= 3 && x <= 8 && y >= 3 && y <= 8) {
          img.data[i] = 240;
          img.data[i + 1] = 220;
          img.data[i + 2] = 220;
          img.data[i + 3] = 170;
        } else {
          img.data[i + 3] = 20;
        }
      }
    }
    const hardened = hardenAlphaMask(img, { alphaThreshold: 140, dehaloBorder: true });
    // Dış piksel kesin 0 olmalı
    expect(hardened.data[3]).toBe(0);
    // İç çekirdek kesin 255 olmalı
    const centerIdx = (5 * 12 + 5) * 4;
    expect(hardened.data[centerIdx + 3]).toBe(255);
    // Sınır pikseli 255'e sertleşmiş ve iç kırmızıya doğru dekontamine edilmiş olmalı
    const borderIdx = (3 * 12 + 5) * 4;
    expect(hardened.data[borderIdx + 3]).toBe(255);
    expect(hardened.data[borderIdx + 1]).toBeLessThan(220);
  });

  it('pruneLooseFragments ana meshin %0.5 altındaki yüzen üçgen adacıklarını temizler', () => {
    const main = new THREE.IcosahedronGeometry(25, 6);
    const stray = new THREE.TetrahedronGeometry(1, 0);
    stray.translate(80, 80, 80);

    const pMain = main.getAttribute('position') as THREE.BufferAttribute;
    const pStray = stray.getAttribute('position') as THREE.BufferAttribute;
    const combined = new Float32Array((pMain.count + pStray.count) * 3);
    combined.set(pMain.array as Float32Array, 0);
    combined.set(pStray.array as Float32Array, pMain.count * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(combined, 3));

    const res = pruneLooseFragments(geo, 0.005);
    expect(res.removedComponents).toBe(1);
    expect(res.removedTriangles).toBe(countTriangles(stray));
    expect(countTriangles(res.geometry)).toBe(countTriangles(main));

    main.dispose();
    stray.dispose();
    geo.dispose();
    res.geometry.dispose();
  });

  it('bakeDualHemispherePbrAtlas SF3D Delighting + Metallic/Roughness/Normal/AO üretir', () => {
    const front = makeImageData(64, 64, [0, 0, 0]);
    for (let i = 3; i < front.data.length; i += 4) front.data[i] = 0;
    fillRect(front, 16, 8, 48, 56, [185, 110, 85]);
    const baked = bakeDualHemispherePbrAtlas({ front }, { width: 256, height: 128, delight: true });

    expect(baked.width).toBe(256);
    expect(baked.height).toBe(128);
    expect(baked.delighted).toBe(true);
    expect(baked.albedo.length).toBe(256 * 128 * 4);
    expect(baked.normal.length).toBe(256 * 128 * 4);
    expect(baked.roughness.length).toBe(256 * 128 * 4);
    expect(baked.metallic.length).toBe(256 * 128 * 4);
    expect(baked.ao.length).toBe(256 * 128 * 4);
  });

  it('Multi-LOD, Üçgen Kalitesi, Silüet-IoU, 3D Baskı Doktoru, Sergi Kaidesi ve Akıllı Konu Analizi doğru çalışır', () => {
    const sphere = new THREE.IcosahedronGeometry(25, 4).toNonIndexed();
    sphere.translate(0, 25, 0);

    const quality = computeTriangleQuality(sphere);
    expect(quality).toBeGreaterThan(0.7);

    const lod5k = buildLodGeometry(sphere, '5k');
    expect(countTriangles(lod5k)).toBeLessThanOrEqual(countTriangles(sphere));
    expect(lod5k.getAttribute('uv')).toBeDefined();

    // Silüet maskesi
    const maskData = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if ((x - 32) ** 2 + (y - 32) ** 2 <= 26 ** 2) maskData[y * 64 + x] = 1;
      }
    }
    const mask: BinaryMask = { width: 64, height: 64, data: maskData };
    const iou = computeFrontSilhouetteIoU(sphere, mask);
    expect(iou).not.toBeNull();
    expect(iou!).toBeGreaterThan(60);

    const doctor = evaluatePrintabilityDoctor(sphere, { frontMask: mask });
    expect(doctor.fitsBuildPlate).toBe(true);
    expect(doctor.triangleQuality).toBeGreaterThan(0.7);

    const withPedestal = addDisplayPedestal(sphere);
    expect(countTriangles(withPedestal)).toBeGreaterThan(countTriangles(sphere));
    withPedestal.computeBoundingBox();
    expect(Math.abs(withPedestal.boundingBox!.min.y)).toBeLessThan(0.2);

    const advice = analyzeSubjectRouting(mask, null);
    expect(['full-body-character', 'bust-portrait', 'mechanical-object']).toContain(advice.kind);

    const stats = analyzeMesh(withPedestal);
    const qa = evaluatePolyMollyQa(withPedestal, 'studio-ultra', { hasTexture: true, stats });
    const manifest = buildRunManifest({
      source: 'local-pbr',
      profileId: 'studio-ultra',
      lod: 'full',
      delighted: true,
      hasPedestal: true,
      angles: ['front'],
      stats,
      qa,
      printability: doctor,
    });
    expect(manifest.polyMollyScore).toBe(qa.score);

    sphere.dispose();
    lod5k.dispose();
    withPedestal.dispose();
  });

  it('K-Means Çok Renkli AMS/ACE .3mf (4 filament) ve Node GLB geçerli ikili çıktılar üretir', () => {
    const box = new THREE.BoxGeometry(30, 30, 30, 2, 2, 2).toNonIndexed();
    const pos = box.getAttribute('position') as THREE.BufferAttribute;
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const x = pos.getX(i);
      if (y > 5) {
        cols[i * 3] = 0.85; cols[i * 3 + 1] = 0.1; cols[i * 3 + 2] = 0.1;
      } else if (x > 0) {
        cols[i * 3] = 0.1; cols[i * 3 + 1] = 0.6; cols[i * 3 + 2] = 0.8;
      } else {
        cols[i * 3] = 0.15; cols[i * 3 + 1] = 0.15; cols[i * 3 + 2] = 0.18;
      }
    }
    box.setAttribute('color', new THREE.BufferAttribute(cols, 3));

    const q = quantizeVertexColorsKMeans(box, 4);
    expect(q.palette.length).toBe(4);

    const ams = buildMultiColor3MF(box, 4);
    expect(ams.palette.length).toBe(4);
    const zipMagic = new DataView(ams.bytes.buffer, ams.bytes.byteOffset, 4).getUint32(0, false);
    expect(zipMagic).toBe(0x504b0304);

    const glb = buildNodeGLB(box);
    const gltfMagic = new DataView(glb.buffer, glb.byteOffset, 4).getUint32(0, true);
    expect(gltfMagic).toBe(0x46546c67); // 'glTF'

    box.dispose();
  });

  it('ComfyUI resmi BiRefNet -> MoGe -> Pixal3D / SF3D / Hunyuan3D workflow JSON şablonları eksiksiz üretilir', () => {
    expect(COMFY_WORKFLOW_PRESETS.length).toBe(6);
    for (const preset of COMFY_WORKFLOW_PRESETS) {
      const wf = buildComfyUiWorkflowJson(preset.id);
      const text = JSON.stringify(wf);
      expect(text).toContain('BiRefNetRemoveBackground');
      expect(text).toContain('SaveGLB');
    }
    const pixalJson = JSON.stringify(buildComfyUiWorkflowJson('pixal3d-multiview'));
    expect(pixalJson).toContain('moge_2_vitl_normal_fp16.safetensors');
    expect(pixalJson).toContain('pixal3d_multiview_bf16.safetensors');
    expect(pixalJson).toContain('dino_v3_L_naf_fp32.safetensors');
  });
});


