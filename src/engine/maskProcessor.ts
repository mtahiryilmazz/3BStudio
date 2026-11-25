import { BinaryMask, PhotoViewItem, ViewAngle } from './types';

export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

export async function dataUrlToImageData(dataUrl: string, maxDim = 512): Promise<ImageData> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(16, Math.round(img.width * scale));
  const h = Math.max(16, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export interface RemoveBackgroundOptions {
  /** Kapalı iç delikleri (cıvata/montaj deliği gibi) arka plan rengiyle eşleşiyorsa oy. */
  cutInteriorHoles?: boolean;
}

/**
 * Pure local background removal: corner/border-seeded flood fill using adaptive
 * perceptual color distance + morphological despeckle + largest component retention.
 * Optionally punches clean interior background cutouts (e.g. mechanical bolt holes).
 */
export function removeBackgroundFast(
  imageData: ImageData,
  tolerance = 34,
  options: RemoveBackgroundOptions = {}
): ImageData {
  const { width: w, height: h, data } = imageData;
  const out = new Uint8ClampedArray(data);
  const total = w * h;

  // Estimate dominant background color from outer 2px border via 24-bin RGB histogram mode
  // (immune to foreground shoulders/shoes touching the bottom or side edges)
  const borderSamples: Array<[number, number, number]> = [];
  for (let x = 0; x < w; x += 2) {
    for (const y of [0, 1, h - 2, h - 1]) {
      const p = (y * w + x) * 4;
      if (data[p + 3] < 20) continue;
      borderSamples.push([data[p], data[p + 1], data[p + 2]]);
    }
  }
  for (let y = 0; y < h; y += 2) {
    for (const x of [0, 1, w - 2, w - 1]) {
      const p = (y * w + x) * 4;
      if (data[p + 3] < 20) continue;
      borderSamples.push([data[p], data[p + 1], data[p + 2]]);
    }
  }

  let bgR = 240, bgG = 240, bgB = 240;
  if (borderSamples.length > 0) {
    const BIN = 24;
    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
    for (const [r, g, b] of borderSamples) {
      const key = `${Math.floor(r / BIN)},${Math.floor(g / BIN)},${Math.floor(b / BIN)}`;
      const cur = buckets.get(key);
      if (cur) {
        cur.count++;
        cur.r += r;
        cur.g += g;
        cur.b += b;
      } else {
        buckets.set(key, { count: 1, r, g, b });
      }
    }
    let bestCount = -1;
    let modeR = 240, modeG = 240, modeB = 240;
    for (const b of buckets.values()) {
      if (b.count > bestCount) {
        bestCount = b.count;
        modeR = b.r / b.count;
        modeG = b.g / b.count;
        modeB = b.b / b.count;
      }
    }
    // Average all border samples within Manhattan distance 72 of mode
    let rSum = 0, gSum = 0, bSum = 0, inlierCount = 0;
    for (const [r, g, b] of borderSamples) {
      if (Math.abs(r - modeR) + Math.abs(g - modeG) + Math.abs(b - modeB) <= 72) {
        rSum += r;
        gSum += g;
        bSum += b;
        inlierCount++;
      }
    }
    if (inlierCount > 0) {
      bgR = rSum / inlierCount;
      bgG = gSum / inlierCount;
      bgB = bSum / inlierCount;
    } else {
      bgR = modeR;
      bgG = modeG;
      bgB = modeB;
    }
  }

  const tolSq = tolerance * tolerance * 3;
  const isBg = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;

  const colorDistSq = (idx: number, rr: number, gg: number, bb: number) => {
    const p = idx * 4;
    const dr = data[p] - rr;
    const dg = data[p + 1] - gg;
    const db = data[p + 2] - bb;
    return dr * dr + dg * dg + db * db;
  };

  // Seed flood-fill along entire image border
  const trySeed = (idx: number) => {
    if (visited[idx]) return;
    if (data[idx * 4 + 3] < 20 || colorDistSq(idx, bgR, bgG, bgB) <= tolSq * 1.6) {
      visited[idx] = 1;
      isBg[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < w; x++) {
    trySeed(x);
    trySeed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    trySeed(y * w);
    trySeed(y * w + (w - 1));
  }

  // BFS flood fill checking both similarity to global border color AND local neighbor smoothness
  const localTolSq = tolerance * tolerance * 1.35;
  while (head < tail) {
    const curr = queue[head++];
    const cx = curr % w;
    const cy = (curr - cx) / w;
    const cp = curr * 4;
    const cr = data[cp], cg = data[cp + 1], cb = data[cp + 2];

    const neighbors = [
      cx > 0 ? curr - 1 : -1,
      cx < w - 1 ? curr + 1 : -1,
      cy > 0 ? curr - w : -1,
      cy < h - 1 ? curr + w : -1,
    ];

    for (const nb of neighbors) {
      if (nb < 0 || visited[nb]) continue;
      const dGlobal = colorDistSq(nb, bgR, bgG, bgB);
      const dLocal = colorDistSq(nb, cr, cg, cb);
      if (data[nb * 4 + 3] < 20 || dGlobal <= tolSq || (dLocal <= localTolSq && dGlobal <= tolSq * 2.2)) {
        visited[nb] = 1;
        isBg[nb] = 1;
        queue[tail++] = nb;
      }
    }
  }

  // Keep only foreground components of significant size
  const fgLabel = new Int32Array(total);
  let bestSize = 0;
  let bestLabel = 0;
  let labelId = 0;
  const compQueue = new Int32Array(total);

  for (let i = 0; i < total; i++) {
    if (isBg[i] || fgLabel[i] !== 0) continue;
    labelId++;
    let cHead = 0, cTail = 0;
    compQueue[cTail++] = i;
    fgLabel[i] = labelId;
    while (cHead < cTail) {
      const idx = compQueue[cHead++];
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0 && !isBg[idx - 1] && fgLabel[idx - 1] === 0) {
        fgLabel[idx - 1] = labelId;
        compQueue[cTail++] = idx - 1;
      }
      if (x < w - 1 && !isBg[idx + 1] && fgLabel[idx + 1] === 0) {
        fgLabel[idx + 1] = labelId;
        compQueue[cTail++] = idx + 1;
      }
      if (y > 0 && !isBg[idx - w] && fgLabel[idx - w] === 0) {
        fgLabel[idx - w] = labelId;
        compQueue[cTail++] = idx - w;
      }
      if (y < h - 1 && !isBg[idx + w] && fgLabel[idx + w] === 0) {
        fgLabel[idx + w] = labelId;
        compQueue[cTail++] = idx + w;
      }
    }
    if (cTail > bestSize) {
      bestSize = cTail;
      bestLabel = labelId;
    }
  }

  // Optional or auto-detected interior cutouts (e.g. bolt holes on flat-color CAD/bracket silhouettes,
  // or background visible between a character's arms & torso if explicitly requested)
  let shouldCutHoles = options.cutInteriorHoles === true;
  if (!shouldCutHoles && bestSize > 120) {
    // Check if foreground is a uniform-color technical silhouette (low RGB variance away from bg)
    let sumLum = 0;
    let sumLumSq = 0;
    let nonBgFgCount = 0;
    for (let i = 0; i < total; i += 2) {
      if (fgLabel[i] !== bestLabel) continue;
      if (colorDistSq(i, bgR, bgG, bgB) <= tolSq * 0.6) continue;
      const p = i * 4;
      const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      sumLum += lum;
      sumLumSq += lum * lum;
      nonBgFgCount++;
    }
    if (nonBgFgCount > 60) {
      const mean = sumLum / nonBgFgCount;
      const variance = Math.max(0, sumLumSq / nonBgFgCount - mean * mean);
      const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
      if (Math.sqrt(variance) < 22 && Math.abs(mean - bgLum) > 50) {
        shouldCutHoles = true;
      }
    }
  }

  const holeTolSq = Math.max(250, tolSq * 0.65);
  for (let i = 0; i < total; i++) {
    let keep = !isBg[i] && (fgLabel[i] === bestLabel || bestSize === 0);
    if (keep && shouldCutHoles) {
      if (data[i * 4 + 3] < 20 || colorDistSq(i, bgR, bgG, bgB) <= holeTolSq) {
        keep = false;
      }
    }
    if (!keep) {
      out[i * 4 + 3] = 0;
    } else {
      out[i * 4 + 3] = 255;
    }
  }

  return hardenAlphaMask({ width: w, height: h, data: out, colorSpace: 'srgb' } as unknown as ImageData);
}

/**
 * crafter-station/local3d & BiRefNet-tarzı Maske Sertleştirme + Kenar Halo Temizliği:
 * - Yarı saydam kenar piksellerini sert eşikle (alpha >= threshold → 255, altı → 0) temizler.
 * - Ön plan sınırındaki 1px arka-plan renk sızması (fringe/halo) olan piksellerin RGB rengini
 *   iç ön-plan komşularının ortalamasıyla değiştirir, böylece 2K PBR dokuya arka plan rengi bulaşmaz.
 */
export function hardenAlphaMask(
  imageData: ImageData,
  options: { alphaThreshold?: number; dehaloBorder?: boolean } = {}
): ImageData {
  const { width: w, height: h, data } = imageData;
  const threshold = options.alphaThreshold ?? 170;
  const dehalo = options.dehaloBorder !== false;
  const out = new Uint8ClampedArray(data);
  const opaque = new Uint8Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a >= threshold) {
      out[i * 4 + 3] = 255;
      opaque[i] = 1;
    } else {
      out[i * 4 + 3] = 0;
      opaque[i] = 0;
    }
  }

  if (dehalo) {
    // 1) Sınır piksellerini tespit et (en az bir 4-komşusu şeffaf olan opak pikseller)
    const isBorder = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (!opaque[idx]) continue;
        if (!opaque[idx - 1] || !opaque[idx + 1] || !opaque[idx - w] || !opaque[idx + w]) {
          isBorder[idx] = 1;
        }
      }
    }
    // 2) Sınır piksellerinin rengini iç (sınır olmayan) ön-plan komşularından temizle
    const srcCopy = new Uint8ClampedArray(out);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (!isBorder[idx]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nIdx = (y + dy) * w + (x + dx);
            if (opaque[nIdx] && !isBorder[nIdx]) {
              r += srcCopy[nIdx * 4];
              g += srcCopy[nIdx * 4 + 1];
              b += srcCopy[nIdx * 4 + 2];
              cnt++;
            }
          }
        }
        if (cnt > 0) {
          out[idx * 4] = Math.round(r / cnt);
          out[idx * 4 + 1] = Math.round(g / cnt);
          out[idx * 4 + 2] = Math.round(b / cnt);
        }
      }
    }
  }

  if (typeof ImageData !== 'undefined') {
    return new ImageData(out, w, h);
  }
  return { width: w, height: h, data: out, colorSpace: 'srgb' } as unknown as ImageData;
}

/**
 * Attempts local ONNX/WASM AI background removal via @imgly/background-removal,
 * falling back transparently to fast local segmentation if offline or WASM fails.
 */
export async function removeBackgroundAI(
  dataUrl: string,
  tolerance = 34,
  onProgress?: (pct: number) => void
): Promise<{ imageData: ImageData; method: 'ai' | 'fast' }> {
  try {
    onProgress?.(10);
    const mod = await import('@imgly/background-removal');
    const removeBackground = mod.removeBackground;
    const blob = await (await fetch(dataUrl)).blob();
    const resultBlob = await removeBackground(blob, {
      progress: (_key: string, current: number, total: number) => {
        if (total > 0) {
          onProgress?.(Math.min(95, Math.round((current / total) * 85) + 10));
        }
      },
    });
    const outUrl = await fileToDataUrl(resultBlob);
    const imgData = await dataUrlToImageData(outUrl, 512);
    onProgress?.(100);
    return { imageData: imgData, method: 'ai' };
  } catch (err) {
    console.warn('AI arkaplan temizleme yüklenemedi, yerel hızlı moda geçiliyor:', err);
    const imgData = await dataUrlToImageData(dataUrl, 512);
    const cleaned = removeBackgroundFast(imgData, tolerance);
    onProgress?.(100);
    return { imageData: cleaned, method: 'fast' };
  }
}

interface ForegroundBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cropW: number;
  cropH: number;
}

function findForegroundBBox(imageData: ImageData): ForegroundBBox {
  const { width: w, height: h, data } = imageData;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    minX = 0; minY = 0; maxX = w - 1; maxY = h - 1;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    cropW: Math.max(1, maxX - minX + 1),
    cropH: Math.max(1, maxY - minY + 1),
  };
}

/**
 * Pure ImageData placement into a square canvas/buffer (works in both Browser and Node/Vitest).
 */
function placeCroppedIntoSquare(
  imageData: ImageData,
  bbox: ForegroundBBox,
  targetSize: number,
  drawW: number,
  drawH: number,
  dx: number,
  dy: number
): { cleanedDataUrl: string; cleanedImageData: ImageData; mask: BinaryMask } {
  const safeDrawW = Math.max(1, Math.min(targetSize, drawW));
  const safeDrawH = Math.max(1, Math.min(targetSize, drawH));
  const safeDx = Math.max(0, Math.min(targetSize - safeDrawW, dx));
  const safeDy = Math.max(0, Math.min(targetSize - safeDrawH, dy));

  if (typeof document !== 'undefined') {
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = imageData.width;
    srcCanvas.height = imageData.height;
    srcCanvas.getContext('2d')!.putImageData(imageData, 0, 0);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = targetSize;
    outCanvas.height = targetSize;
    const outCtx = outCanvas.getContext('2d')!;
    outCtx.clearRect(0, 0, targetSize, targetSize);
    outCtx.drawImage(
      srcCanvas,
      bbox.minX,
      bbox.minY,
      bbox.cropW,
      bbox.cropH,
      safeDx,
      safeDy,
      safeDrawW,
      safeDrawH
    );

    const outImg = outCtx.getImageData(0, 0, targetSize, targetSize);
    const maskBytes = new Uint8Array(targetSize * targetSize);
    for (let i = 0; i < targetSize * targetSize; i++) {
      maskBytes[i] = outImg.data[i * 4 + 3] > 100 ? 1 : 0;
    }

    return {
      cleanedDataUrl: outCanvas.toDataURL('image/png'),
      cleanedImageData: outImg,
      mask: { width: targetSize, height: targetSize, data: maskBytes },
    };
  }

  // Headless Node/Vitest pure bilinear resampler
  const outBuf = new Uint8ClampedArray(targetSize * targetSize * 4);
  const maskBytes = new Uint8Array(targetSize * targetSize);
  const { width: sw, height: sh, data: sdata } = imageData;

  for (let oy = 0; oy < safeDrawH; oy++) {
    const sy = bbox.minY + ((oy + 0.5) / safeDrawH) * bbox.cropH - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
    const ty = Math.max(0, Math.min(1, sy - y0));
    const destY = safeDy + oy;
    for (let ox = 0; ox < safeDrawW; ox++) {
      const sx = bbox.minX + ((ox + 0.5) / safeDrawW) * bbox.cropW - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
      const tx = Math.max(0, Math.min(1, sx - x0));
      const destX = safeDx + ox;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      const dstIdx = destY * targetSize + destX;
      const o = dstIdx * 4;
      const alpha = sdata[i00 + 3] * w00 + sdata[i10 + 3] * w10 + sdata[i01 + 3] * w01 + sdata[i11 + 3] * w11;
      outBuf[o] = Math.round(sdata[i00] * w00 + sdata[i10] * w10 + sdata[i01] * w01 + sdata[i11] * w11);
      outBuf[o + 1] = Math.round(sdata[i00 + 1] * w00 + sdata[i10 + 1] * w10 + sdata[i01 + 1] * w01 + sdata[i11 + 1] * w11);
      outBuf[o + 2] = Math.round(sdata[i00 + 2] * w00 + sdata[i10 + 2] * w10 + sdata[i01 + 2] * w01 + sdata[i11 + 2] * w11);
      outBuf[o + 3] = Math.round(alpha);
      maskBytes[dstIdx] = alpha > 100 ? 1 : 0;
    }
  }

  const outImg = { width: targetSize, height: targetSize, data: outBuf, colorSpace: 'srgb' } as unknown as ImageData;
  return {
    cleanedDataUrl: '',
    cleanedImageData: outImg,
    mask: { width: targetSize, height: targetSize, data: maskBytes },
  };
}

/**
 * Tightly crops around non-transparent foreground, centers onto a square mask canvas,
 * and returns both a transparent PNG data URL and a BinaryMask for 3D reconstruction.
 */
export function normalizeAndCropMask(
  imageData: ImageData,
  targetSize = 256,
  paddingRatio = 0.08
): { cleanedDataUrl: string; mask: BinaryMask } {
  const bbox = findForegroundBBox(imageData);
  const usable = targetSize * (1 - paddingRatio * 2);
  const scale = usable / Math.max(bbox.cropW, bbox.cropH);
  const drawW = Math.max(1, Math.round(bbox.cropW * scale));
  const drawH = Math.max(1, Math.round(bbox.cropH * scale));
  const dx = Math.round((targetSize - drawW) / 2);
  const dy = Math.round((targetSize - drawH) / 2);

  const res = placeCroppedIntoSquare(imageData, bbox, targetSize, drawW, drawH, dx, dy);
  return { cleanedDataUrl: res.cleanedDataUrl, mask: res.mask };
}

export interface TurnaroundNormalizedItem {
  angle: ViewAngle;
  cleanedDataUrl: string;
  cleanedImageData: ImageData;
  mask: BinaryMask;
  drawWidth: number;
  drawHeight: number;
}

/**
 * Ortak Ölçekli Turnaround Normalizasyonu (1:1 Oran Kilidi):
 * - Tüm dikey açıları (Ön, Arka, Sağ, Sol ve 45° çaprazlar) tepeden topuğa
 *   AYNI yükseklik eksenine (`sharedDrawH`) kilitler!
 * - Böylece T-Poz / A-Poz Ön görünüm ile kolları yanda duran Yan profil arasında
 *   kafa, omuz, bel, diz ve ayaklar milimetrik hizalanır; her açının gerçek
 *   `en / boy` ve `derinlik / boy` oranları bozulmadan korunur.
 * - Üst (top) görünüm varsa genişliği Ön görünüm X aralığına, derinliği Yan görünüm Z aralığına kilitlenir.
 */
export function normalizeTurnaroundGroup(
  items: Array<{ angle: ViewAngle; imageData: ImageData }>,
  targetSize = 256,
  paddingRatio = 0.08
): TurnaroundNormalizedItem[] {
  if (items.length === 0) return [];
  const usable = targetSize * (1 - paddingRatio * 2);

  const bboxes = items.map((it) => ({
    ...it,
    bbox: findForegroundBBox(it.imageData),
  }));

  const verticalItems = bboxes.filter((b) => b.angle !== 'top');
  // Her dikey görünümün gerçek en/boy oranını bul; en genişi (ör. T-Poz Ön) sığacak ortak boyu seç
  let maxAspect = 1.0;
  for (const v of verticalItems) {
    const aspect = v.bbox.cropW / Math.max(1, v.bbox.cropH);
    if (aspect > maxAspect) maxAspect = aspect;
  }

  const sharedDrawH = Math.max(8, Math.round(usable / Math.max(1.0, maxAspect)));
  const sharedDy = Math.round((targetSize - sharedDrawH) / 2);

  // Ön/Arka genişlik ile Sağ/Sol derinlik referanslarını topla (Üst görünüm ölçek kilidi için)
  const frontLikeWidths: number[] = [];
  const sideLikeWidths: number[] = [];

  for (const v of verticalItems) {
    const wPx = Math.max(2, Math.round((v.bbox.cropW / Math.max(1, v.bbox.cropH)) * sharedDrawH));
    if (v.angle === 'front' || v.angle === 'back') frontLikeWidths.push(wPx);
    else if (v.angle === 'right' || v.angle === 'left') sideLikeWidths.push(wPx);
  }

  const refFrontW =
    frontLikeWidths.length > 0
      ? Math.round(frontLikeWidths.reduce((a, b) => a + b, 0) / frontLikeWidths.length)
      : null;
  const refSideW =
    sideLikeWidths.length > 0
      ? Math.round(sideLikeWidths.reduce((a, b) => a + b, 0) / sideLikeWidths.length)
      : null;

  return bboxes.map(({ angle, imageData, bbox }) => {
    let drawW: number;
    let drawH: number;
    let dx: number;
    let dy: number;

    if (angle === 'top') {
      if (refFrontW !== null && refSideW !== null) {
        drawW = Math.max(2, Math.min(Math.round(usable), refFrontW));
        drawH = Math.max(2, Math.min(Math.round(usable), refSideW));
      } else if (refFrontW !== null) {
        drawW = Math.max(2, Math.min(Math.round(usable), refFrontW));
        drawH = Math.max(2, Math.min(Math.round(usable), Math.round((bbox.cropH / Math.max(1, bbox.cropW)) * drawW)));
      } else {
        const scale = usable / Math.max(bbox.cropW, bbox.cropH);
        drawW = Math.max(2, Math.round(bbox.cropW * scale));
        drawH = Math.max(2, Math.round(bbox.cropH * scale));
      }
      dx = Math.round((targetSize - drawW) / 2);
      dy = Math.round((targetSize - drawH) / 2);
    } else {
      drawH = sharedDrawH;
      drawW = Math.max(
        2,
        Math.min(Math.round(usable), Math.round((bbox.cropW / Math.max(1, bbox.cropH)) * sharedDrawH))
      );
      dx = Math.round((targetSize - drawW) / 2);
      dy = sharedDy;
    }

    const res = placeCroppedIntoSquare(imageData, bbox, targetSize, drawW, drawH, dx, dy);
    return {
      angle,
      cleanedDataUrl: res.cleanedDataUrl,
      cleanedImageData: res.cleanedImageData,
      mask: res.mask,
      drawWidth: drawW,
      drawHeight: drawH,
    };
  });
}

/**
 * Generates geometrically consistent synthetic multi-view photos (exact 1:1 orthographic projections
 * on studio background) so L-Bracket (with open bolt holes & mirrored back), Rotary Knob,
 * and Geometric Figurine reconstruct cleanly with zero distortion or broken faces.
 */
export function generateDemoPartViews(partType: 'bracket' | 'knob' | 'figurine'): PhotoViewItem[] {
  const size = 256;
  const drawView = (angle: ViewAngle): string => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Clean studio backdrop (light uniform slate gradient)
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#e2e8f0');
    grad.addColorStop(1, '#d8e1ec');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#1e3a5f';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;

    if (partType === 'bracket') {
      // Exact 3D L-bracket extents: X=[48..208] (160px), Y=[44..212] (168px), Z=[96..160] (64px)
      if (angle === 'front' || angle === 'back') {
        ctx.save();
        // Back (180°) is viewed from -Z, so X must be horizontally mirrored to match front in 3D!
        if (angle === 'back') {
          ctx.translate(size, 0);
          ctx.scale(-1, 1);
        }
        ctx.beginPath();
        ctx.roundRect(48, 44, 52, 168, 8);
        ctx.roundRect(48, 160, 160, 52, 8);
        ctx.fill();
        // Cutout bolt holes filled with exact studio backdrop tone so interior-hole detector opens them cleanly
        ctx.fillStyle = '#dde5ef';
        ctx.beginPath();
        ctx.arc(74, 82, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(172, 186, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (angle === 'right' || angle === 'left') {
        // Depth Z = 64px centered [96..160], Height Y = 168px [44..212]
        ctx.beginPath();
        ctx.roundRect(96, 44, 64, 168, 6);
        ctx.fill();
      } else {
        // Top view: Width X = 160px [48..208], Depth Z = 64px [96..160]
        ctx.beginPath();
        ctx.roundRect(48, 96, 160, 64, 6);
        ctx.fill();
      }
    } else if (partType === 'knob') {
      // Axisymmetric rotary knob: base radius 64px (width 128px), height 168px [42..210]
      if (angle === 'top') {
        ctx.beginPath();
        ctx.arc(128, 128, 64, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(64, 210);
        ctx.lineTo(192, 210);
        ctx.lineTo(184, 168);
        ctx.lineTo(164, 168);
        ctx.lineTo(158, 64);
        ctx.quadraticCurveTo(128, 42, 98, 64);
        ctx.lineTo(92, 168);
        ctx.lineTo(72, 168);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      // Exact 3D geometric owl/cat figurine:
      // Body ellipsoid rx=56, ry=56, rz=48 centered at y=162
      // Head sphere r=40 centered at y=92
      // Ears rising to y=36 (front/back twin ears; side aligned single silhouette)
      if (angle === 'top') {
        ctx.beginPath();
        ctx.ellipse(128, 128, 56, 48, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (angle === 'front' || angle === 'back') {
        ctx.beginPath();
        ctx.ellipse(128, 162, 56, 56, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(128, 92, 40, 0, Math.PI * 2);
        ctx.fill();
        // Symmetric pointed ears
        ctx.beginPath();
        ctx.moveTo(92, 76); ctx.lineTo(100, 36); ctx.lineTo(118, 62);
        ctx.moveTo(164, 76); ctx.lineTo(156, 36); ctx.lineTo(138, 62);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(128, 162, 48, 56, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(128, 92, 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(112, 66); ctx.lineTo(128, 36); ctx.lineTo(144, 66);
        ctx.fill();
      }
    }

    return canvas.toDataURL('image/png');
  };

  const specs: { angle: ViewAngle; label: string }[] = [
    { angle: 'front', label: 'Ön (0°)' },
    { angle: 'right', label: 'Sağ (90°)' },
    { angle: 'back', label: 'Arka (180°)' },
    { angle: 'left', label: 'Sol (270°)' },
    { angle: 'top', label: 'Üst' },
  ];

  return specs.map(({ angle, label }) => ({
    angle,
    label,
    originalDataUrl: drawView(angle),
    cleanedDataUrl: null,
    mask: null,
    tolerance: 34,
  }));
}
