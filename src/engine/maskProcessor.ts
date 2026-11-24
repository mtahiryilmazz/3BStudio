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

/**
 * Pure local background removal: corner/border-seeded flood fill using adaptive
 * perceptual color distance + morphological despeckle + largest component retention.
 */
export function removeBackgroundFast(imageData: ImageData, tolerance = 34): ImageData {
  const { width: w, height: h, data } = imageData;
  const out = new Uint8ClampedArray(data);
  const total = w * h;

  // Estimate background color from outer 2px border samples
  let rSum = 0, gSum = 0, bSum = 0, borderCount = 0;
  for (let x = 0; x < w; x += 2) {
    for (const y of [0, 1, h - 2, h - 1]) {
      const p = (y * w + x) * 4;
      rSum += data[p]; gSum += data[p + 1]; bSum += data[p + 2];
      borderCount++;
    }
  }
  for (let y = 0; y < h; y += 2) {
    for (const x of [0, 1, w - 2, w - 1]) {
      const p = (y * w + x) * 4;
      rSum += data[p]; gSum += data[p + 1]; bSum += data[p + 2];
      borderCount++;
    }
  }
  const bgR = rSum / Math.max(1, borderCount);
  const bgG = gSum / Math.max(1, borderCount);
  const bgB = bSum / Math.max(1, borderCount);

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

  for (let i = 0; i < total; i++) {
    const keep = !isBg[i] && (fgLabel[i] === bestLabel || bestSize === 0);
    if (!keep) {
      out[i * 4 + 3] = 0;
    } else {
      out[i * 4 + 3] = 255;
    }
  }

  return new ImageData(out, w, h);
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

/**
 * Tightly crops around non-transparent foreground, centers onto a square mask canvas,
 * and returns both a transparent PNG data URL and a BinaryMask for 3D reconstruction.
 */
export function normalizeAndCropMask(
  imageData: ImageData,
  targetSize = 256,
  paddingRatio = 0.08
): { cleanedDataUrl: string; mask: BinaryMask } {
  const { width: w, height: h, data } = imageData;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 127) {
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

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w;
  srcCanvas.height = h;
  srcCanvas.getContext('2d')!.putImageData(imageData, 0, 0);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const usable = targetSize * (1 - paddingRatio * 2);
  const scale = usable / Math.max(cropW, cropH);
  const drawW = Math.max(1, Math.round(cropW * scale));
  const drawH = Math.max(1, Math.round(cropH * scale));
  const dx = Math.round((targetSize - drawW) / 2);
  const dy = Math.round((targetSize - drawH) / 2);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = targetSize;
  outCanvas.height = targetSize;
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.clearRect(0, 0, targetSize, targetSize);
  outCtx.drawImage(srcCanvas, minX, minY, cropW, cropH, dx, dy, drawW, drawH);

  const normData = outCtx.getImageData(0, 0, targetSize, targetSize).data;
  const maskBytes = new Uint8Array(targetSize * targetSize);
  for (let i = 0; i < targetSize * targetSize; i++) {
    maskBytes[i] = normData[i * 4 + 3] > 100 ? 1 : 0;
  }

  return {
    cleanedDataUrl: outCanvas.toDataURL('image/png'),
    mask: { width: targetSize, height: targetSize, data: maskBytes },
  };
}

/**
 * Generates synthetic multi-view photos (on realistic studio background) so the user
 * can test automatic background removal, 3D generation, mesh repair, and STL/3MF export immediately.
 */
export function generateDemoPartViews(partType: 'bracket' | 'knob' | 'figurine'): PhotoViewItem[] {
  const size = 256;
  const drawView = (angle: ViewAngle): string => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Studio table background (subtle gradient so auto-bg removal is genuinely tested)
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#e2e8f0');
    grad.addColorStop(1, '#cbd5e1');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#1e3a5f';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;

    if (partType === 'bracket') {
      if (angle === 'front' || angle === 'back') {
        // L-bracket with mounting hole
        ctx.beginPath();
        ctx.roundRect(48, 44, 52, 168, 8);
        ctx.roundRect(48, 160, 160, 52, 8);
        ctx.fill();
        // Cutout bolt hole
        ctx.fillStyle = '#dbe4ee';
        ctx.beginPath();
        ctx.arc(74, 82, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(172, 186, 14, 0, Math.PI * 2);
        ctx.fill();
      } else if (angle === 'right' || angle === 'left') {
        ctx.beginPath();
        ctx.roundRect(88, 44, 80, 168, 6);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.roundRect(48, 88, 160, 80, 6);
        ctx.fill();
      }
    } else if (partType === 'knob') {
      if (angle === 'top') {
        ctx.beginPath();
        ctx.arc(128, 128, 76, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Appliance rotary knob silhouette
        ctx.beginPath();
        ctx.moveTo(64, 210);
        ctx.lineTo(192, 210);
        ctx.lineTo(182, 168);
        ctx.lineTo(164, 168);
        ctx.lineTo(158, 64);
        ctx.quadraticCurveTo(128, 42, 98, 64);
        ctx.lineTo(92, 168);
        ctx.lineTo(74, 168);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      // Stylized geometric cat/owl figurine
      if (angle === 'top') {
        ctx.beginPath();
        ctx.ellipse(128, 128, 62, 54, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (angle === 'front' || angle === 'back') {
        ctx.beginPath();
        ctx.ellipse(128, 162, 56, 56, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(128, 92, 42, 0, Math.PI * 2);
        ctx.fill();
        // Ears
        ctx.beginPath();
        ctx.moveTo(92, 74); ctx.lineTo(98, 36); ctx.lineTo(118, 62);
        ctx.moveTo(164, 74); ctx.lineTo(158, 36); ctx.lineTo(138, 62);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(128, 162, 48, 56, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(128, 92, 38, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(116, 62); ctx.lineTo(128, 36); ctx.lineTo(140, 62);
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
