import * as THREE from 'three';
import { marchingCubes } from './marchingCubes';
import { taubinSmooth } from './meshRepair';
import { detectFaceRegion } from './faceDetect';
import { BinaryMask, CharacterDepthProfile, ViewAngle } from './types';

export type DepthStylePreset = 'natural-sharp' | 'slim' | 'bold';
export type SideFacingChoice = 'auto' | 'left' | 'right';

export interface SideProfileFacingResult {
  facing: 'left' | 'right';
  confidence: number;
  footBias: number;
  headBias: number;
}

export interface VisualHullOptions {
  resolution?: number;
  smoothPasses?: number;
  sizeMm?: number;
  /** Her açı için temizlenmiş renkli görsel (360° doku projeksiyonu ve parlaklık kabartması için). */
  colorViews?: Partial<Record<ViewAngle, ImageData>>;
  /** Karakter sheet'ten veya manuel gelen yakın yüz fotoğrafı (baş ön yüzüne yüksek çözünürlüklü giydirme). */
  faceCloseUp?: ImageData | null;
  /** Ön görünümde eksik/bantlı kafa varsa arka silüetten otomatik tamamla (varsayılan: true). */
  autoCompleteHead?: boolean;
  /** 360° fotoğraf renk projeksiyonunu etkinleştir (varsayılan: true). */
  projectColors?: boolean;
  /** Gemini veya manuel derinlik/anatomi kalibrasyonu (opsiyonel). */
  depthProfile?: Partial<CharacterDepthProfile> | null;
  /** Balonsuz keskin kontur profili ('natural-sharp' | 'slim' | 'bold'). */
  depthPreset?: DepthStylePreset;
  /** Yan profil görselinde yüz/ayak uçlarının baktığı yön ('auto' | 'left' | 'right'). */
  sideProfileFacing?: SideFacingChoice;
  /** Yalnızca tek yan (Sağ veya Sol) yüklüyse karşı yana simetrik geometri ve doku uygula (varsayılan: true). */
  symmetricSideMirror?: boolean;
}

interface FrontTransform {
  /** Ön maske/renk görselinin arka görsele hizalanması için dikey ölçek ve taban kayması. */
  aligned: boolean;
  scaleY: number;
  scaleX: number;
  frontBottomY: number;
  backBottomY: number;
  frontCenterX: number;
  backCenterX: number;
  headCompleted: boolean;
  headTopNormY: number;
  neckNormY: number;
}

interface ActiveNormBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function sampleMaskBilinear(mask: BinaryMask, uNorm: number, vNorm: number): number {
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

function sampleLuminanceBilinear(img: ImageData, uNorm: number, vNorm: number): number {
  if (uNorm < 0 || uNorm > 1 || vNorm < 0 || vNorm > 1) return 0.5;
  const fx = uNorm * (img.width - 1);
  const fy = (1 - vNorm) * (img.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const lumAt = (x: number, y: number): number => {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] < 64) return 0.5;
    return (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]) / 255;
  };

  const a = lumAt(x0, y0) * (1 - tx) + lumAt(x1, y0) * tx;
  const b = lumAt(x0, y1) * (1 - tx) + lumAt(x1, y1) * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * Bir renkli görselden yüksek frekanslı giysi/yüz rölyef haritası (luminance + Sobel kontur)
 * çıkarır. Yaka, cep, kemer, burun/kaş ve kumaş kıvrımlarını 3D yüzeye net olarak işler.
 */
function buildImageReliefMap(img: ImageData): { data: Float32Array; width: number; height: number } {
  const { width: w, height: h, data: rgba } = img;
  const lum = new Float32Array(w * h);
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] >= 64) {
      alpha[i] = 1;
      lum[i] = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255;
    } else {
      lum[i] = 0.5;
    }
  }

  // 3x3 ortalama ile yerel yüksek geçiş (high-pass detail) + Sobel kenar vurgusu
  const relief = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (!alpha[idx]) continue;
      const c = lum[idx];
      const tl = lum[idx - w - 1];
      const tc = lum[idx - w];
      const tr = lum[idx - w + 1];
      const ml = lum[idx - 1];
      const mr = lum[idx + 1];
      const bl = lum[idx + w - 1];
      const bc = lum[idx + w];
      const br = lum[idx + w + 1];

      const localAvg = (tl + tc + tr + ml + c + mr + bl + bc + br) / 9;
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      const gradMag = Math.min(1, Math.hypot(gx, gy) * 0.65);

      // Parlaklık kabartması + keskin kenar çizgi oyuğu (kıyafet/yüz hatlarını netleştirir)
      const val = (c - 0.5) * 0.55 + (c - localAvg) * 1.35 - gradMag * 0.18;
      relief[idx] = Math.max(-0.85, Math.min(0.85, val));
    }
  }

  return { data: relief, width: w, height: h };
}

/**
 * Yan profil (Sağ 90° veya Sol 270°) maskesinde karakterin ayak uçları ile yüz/burnunun
 * görsel içinde SOLA (u=0) mı yoksa SAĞA (u=1) mı baktığını otomatik tespit eder.
 * Böylece yan profil hangi yöne çizilmiş olursa olsun ayaklar ve yüz her zaman +Z yönüne kilitlenir.
 */
export function detectSideProfileFacing(
  mask: BinaryMask,
  colorImg?: ImageData | null
): SideProfileFacingResult {
  const { width: w, height: h, data } = mask;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x]) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxY - minY < 10) {
    return { facing: 'right', confidence: 0, footBias: 0, headBias: 0 };
  }

  const spanH = maxY - minY + 1;

  const bandStats = (relStart: number, relEnd: number) => {
    const y0 = Math.max(minY, Math.floor(minY + spanH * relStart));
    const y1 = Math.min(maxY, Math.ceil(minY + spanH * relEnd));
    let bMinX = w;
    let bMaxX = -1;
    let sumX = 0;
    let cnt = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (data[row + x]) {
          if (x < bMinX) bMinX = x;
          if (x > bMaxX) bMaxX = x;
          sumX += x;
          cnt++;
        }
      }
    }
    return {
      valid: cnt > 0 && bMaxX >= bMinX,
      minX: bMinX,
      maxX: bMaxX,
      meanX: cnt > 0 ? sumX / cnt : w * 0.5,
      span: cnt > 0 ? Math.max(1, bMaxX - bMinX + 1) : 1,
    };
  };

  // 1) Ayak bandı (%88..%100) vs Bilek bandı (%79..%86): Parmak uçları topuktan ~2.5x daha fazla taşar.
  const ankle = bandStats(0.79, 0.86);
  const foot = bandStats(0.88, 1.0);
  let footBias = 0;
  if (ankle.valid && foot.valid) {
    const leftProtrusion = Math.max(0, ankle.meanX - foot.minX);
    const rightProtrusion = Math.max(0, foot.maxX - ankle.meanX);
    const footMeanShift = (foot.meanX - ankle.meanX) / Math.max(4, foot.span);
    const extentBias = (rightProtrusion - leftProtrusion) / Math.max(4, rightProtrusion + leftProtrusion);
    footBias = extentBias * 0.65 + footMeanShift * 0.35;
  }

  // 2) Kafa/burun bandı (%4..%17) vs Boyun bandı (%18..%24) + YCbCr ten rengi yönü (yüz vs arka saç)
  const head = bandStats(0.04, 0.17);
  const neck = bandStats(0.18, 0.24);
  let headBias = 0;
  if (head.valid && neck.valid) {
    const leftHead = Math.max(0, neck.meanX - head.minX);
    const rightHead = Math.max(0, head.maxX - neck.meanX);
    headBias += ((rightHead - leftHead) / Math.max(4, rightHead + leftHead)) * 0.55;
  }

  if (colorImg && head.valid) {
    const y0 = Math.max(minY, Math.floor(minY + spanH * 0.04));
    const y1 = Math.min(maxY, Math.ceil(minY + spanH * 0.17));
    const headMidX = head.meanX;
    let leftSkin = 0;
    let rightSkin = 0;
    const scaleX = (colorImg.width - 1) / Math.max(1, w - 1);
    const scaleY = (colorImg.height - 1) / Math.max(1, h - 1);
    for (let y = y0; y <= y1; y++) {
      const cy = Math.min(colorImg.height - 1, Math.round(y * scaleY));
      for (let x = head.minX; x <= head.maxX; x++) {
        if (!data[y * w + x]) continue;
        const cx = Math.min(colorImg.width - 1, Math.round(x * scaleX));
        const o = (cy * colorImg.width + cx) * 4;
        if (colorImg.data[o + 3] < 96) continue;
        const r = colorImg.data[o];
        const g = colorImg.data[o + 1];
        const b = colorImg.data[o + 2];
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        if (cb >= 77 && cb <= 135 && cr >= 133 && cr <= 180) {
          if (x < headMidX) leftSkin++;
          else if (x > headMidX) rightSkin++;
        }
      }
    }
    if (leftSkin + rightSkin >= 12) {
      headBias += ((rightSkin - leftSkin) / (leftSkin + rightSkin)) * 0.75;
    }
  }

  // Pozitif toplam => parmak uçları & burun görselin SAĞINA (u=1) bakıyor; Negatif => SOLA (u=0)
  const combined = footBias * 2.2 + headBias * 1.1;
  const facing: 'left' | 'right' = combined >= 0 ? 'right' : 'left';
  const confidence = Math.min(1, Math.abs(combined));

  return {
    facing,
    confidence: Number(confidence.toFixed(3)),
    footBias: Number(footBias.toFixed(3)),
    headBias: Number(headBias.toFixed(3)),
  };
}

/**
 * Şeffaf kenarlardan siyah/boş taşma olmaması için opak piksellerden bilineer RGB örnekler;
 * eğer tam koordinat şeffafsa küçük bir yarıçapta en yakın ön plan pikselini alır.
 */
function sampleColorSafe(
  img: ImageData,
  uNorm: number,
  vNorm: number
): [number, number, number, number] {
  if (uNorm < 0 || uNorm > 1 || vNorm < 0 || vNorm > 1) return [0, 0, 0, 0];
  const fx = uNorm * (img.width - 1);
  const fy = (1 - vNorm) * (img.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const pts: Array<[number, number, number]> = [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty],
  ];

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let wSum = 0;
  for (const [px, py, w] of pts) {
    const idx = (py * img.width + px) * 4;
    const a = img.data[idx + 3];
    if (a >= 96) {
      const ew = w * (a / 255);
      rSum += img.data[idx] * ew;
      gSum += img.data[idx + 1] * ew;
      bSum += img.data[idx + 2] * ew;
      wSum += ew;
    }
  }
  if (wSum > 0.01) {
    return [rSum / wSum / 255, gSum / wSum / 255, bSum / wSum / 255, Math.min(1, wSum)];
  }

  // Kenar vokselleri için en yakın opak pikseli küçük yarıçapta ara
  const cx = Math.round(fx);
  const cy = Math.round(fy);
  for (let rad = 1; rad <= 4; rad++) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let cnt = 0;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.abs(dx) !== rad && Math.abs(dy) !== rad) continue;
        const sx = cx + dx;
        const sy = cy + dy;
        if (sx < 0 || sx >= img.width || sy < 0 || sy >= img.height) continue;
        const idx = (sy * img.width + sx) * 4;
        if (img.data[idx + 3] >= 120) {
          sr += img.data[idx];
          sg += img.data[idx + 1];
          sb += img.data[idx + 2];
          cnt++;
        }
      }
    }
    if (cnt > 0) {
      return [sr / cnt / 255, sg / cnt / 255, sb / cnt / 255, 0.75];
    }
  }

  return [0, 0, 0, 0];
}

function srgbChannelToLinear(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.04045 ? clamped / 12.92 : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

/**
 * Bir maskenin dikey profilini (üst/alt sınır, satır genişlikleri, boyun daralması, omuz seviyesi) analiz eder.
 */
function analyzeMaskProfile(mask: BinaryMask): {
  minY: number;
  maxY: number;
  centerX: number;
  maxWidth: number;
  topWidthRatio: number;
  hasNeckPinch: boolean;
  neckY: number;
  shoulderY: number;
  shoulderWidth: number;
  rowWidths: Float32Array;
} {
  const { width: w, height: h, data } = mask;
  const rowWidths = new Float32Array(h);
  let minY = h;
  let maxY = -1;
  let xSum = 0;
  let count = 0;

  for (let y = 0; y < h; y++) {
    let minX = w;
    let maxX = -1;
    let rowCnt = 0;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      if (data[rowOff + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        xSum += x;
        count++;
        rowCnt++;
      }
    }
    if (rowCnt > 0) {
      rowWidths[y] = maxX - minX + 1;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxY <= minY || count === 0) {
    return {
      minY: 0,
      maxY: h - 1,
      centerX: w / 2,
      maxWidth: 1,
      topWidthRatio: 1,
      hasNeckPinch: false,
      neckY: Math.round(h * 0.2),
      shoulderY: Math.round(h * 0.25),
      shoulderWidth: 1,
      rowWidths,
    };
  }

  const spanH = maxY - minY + 1;
  let maxWidth = 1;
  for (let y = minY; y <= maxY; y++) {
    if (rowWidths[y] > maxWidth) maxWidth = rowWidths[y];
  }

  const topBandEnd = Math.min(maxY, Math.round(minY + spanH * 0.12));
  let topSum = 0;
  let topCnt = 0;
  for (let y = minY + Math.max(1, Math.round(spanH * 0.02)); y <= topBandEnd; y++) {
    if (rowWidths[y] > 0) {
      topSum += rowWidths[y];
      topCnt++;
    }
  }
  const topAvgW = topCnt > 0 ? topSum / topCnt : maxWidth;
  const topWidthRatio = topAvgW / Math.max(1, maxWidth);

  const shStart = Math.round(minY + spanH * 0.06);
  const shEnd = Math.round(minY + spanH * 0.36);
  let shoulderY = Math.round(minY + spanH * 0.22);
  let shoulderWidth = 0;
  for (let y = shStart; y <= Math.min(maxY, shEnd); y++) {
    if (rowWidths[y] > shoulderWidth) {
      shoulderWidth = rowWidths[y];
      shoulderY = y;
    }
  }

  let neckY = Math.round(minY + spanH * 0.16);
  let minNeckW = Infinity;
  const neckSearchTop = Math.round(minY + spanH * 0.08);
  const neckSearchBot = Math.max(neckSearchTop + 1, shoulderY - Math.max(2, Math.round(spanH * 0.02)));
  for (let y = neckSearchTop; y <= Math.min(maxY, neckSearchBot); y++) {
    if (rowWidths[y] > 0 && rowWidths[y] < minNeckW) {
      minNeckW = rowWidths[y];
      neckY = y;
    }
  }

  const headBandHeight = Math.max(0, neckY - minY);
  const hasNeckPinch =
    headBandHeight >= spanH * 0.09 &&
    minNeckW < shoulderWidth * 0.56 &&
    topWidthRatio < 0.62;

  return {
    minY,
    maxY,
    centerX: xSum / count,
    maxWidth,
    topWidthRatio,
    hasNeckPinch,
    neckY,
    shoulderY,
    shoulderWidth: Math.max(1, shoulderWidth),
    rowWidths,
  };
}

/**
 * Ön görünümde kafa eksik (başsız karakter sheet) veya bantlıysa, arka görünümdeki kafa/boyun
 * geometrisini hizalayarak ön maskeye aktarır ve omuz–ayak ölçeğini eşitler.
 */
export function alignAndCompleteFrontBackMasks(
  front: BinaryMask,
  back: BinaryMask | undefined,
  options: { forceHeadComplete?: boolean; faceOccluded?: boolean } = {}
): {
  alignedFront: BinaryMask;
  transform: FrontTransform;
} {
  const identityTransform: FrontTransform = {
    aligned: false,
    scaleY: 1,
    scaleX: 1,
    frontBottomY: front.height - 1,
    backBottomY: front.height - 1,
    frontCenterX: front.width / 2,
    backCenterX: front.width / 2,
    headCompleted: false,
    headTopNormY: 0.92,
    neckNormY: 0.78,
  };

  if (!back) {
    return { alignedFront: front, transform: identityTransform };
  }

  const fp = analyzeMaskProfile(front);
  const bp = analyzeMaskProfile(back);
  const backSpanH = Math.max(1, bp.maxY - bp.minY);
  const frontSpanH = Math.max(1, fp.maxY - fp.minY);

  const frontLooksHeadless =
    Boolean(options.forceHeadComplete) ||
    (bp.hasNeckPinch && !fp.hasNeckPinch && fp.topWidthRatio > 0.56);

  const frontHeadBandWidth = (() => {
    let mx = 0;
    const endY = Math.min(fp.maxY, Math.round(fp.minY + frontSpanH * 0.19));
    for (let y = fp.minY; y <= endY; y++) {
      if (fp.rowWidths[y] > mx) mx = fp.rowWidths[y];
    }
    return mx;
  })();
  const backHeadBandWidth = (() => {
    let mx = 0;
    const endY = Math.min(bp.maxY, Math.round(bp.minY + backSpanH * 0.17));
    for (let y = bp.minY; y <= endY; y++) {
      if (bp.rowWidths[y] > mx) mx = bp.rowWidths[y];
    }
    return mx;
  })();
  const frontHasTapeBlock =
    Boolean(options.faceOccluded) ||
    (!frontLooksHeadless &&
      bp.hasNeckPinch &&
      backHeadBandWidth > 4 &&
      frontHeadBandWidth > backHeadBandWidth * 1.28);

  if (!frontLooksHeadless && !frontHasTapeBlock) {
    return {
      alignedFront: front,
      transform: {
        ...identityTransform,
        headTopNormY: 1 - bp.minY / Math.max(1, back.height - 1),
        neckNormY: 1 - bp.neckY / Math.max(1, back.height - 1),
      },
    };
  }

  const w = back.width;
  const h = back.height;
  const out = new Uint8Array(w * h);

  if (frontLooksHeadless) {
    const backBodyH = Math.max(8, bp.maxY - bp.neckY);
    const scaleY = backBodyH / Math.max(8, frontSpanH);
    const scaleX = bp.shoulderWidth / Math.max(8, fp.shoulderWidth);
    const uniformScale = Math.max(0.65, Math.min(1.05, scaleY * 0.72 + scaleX * 0.28));

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcY = fp.maxY - (bp.maxY - y) / uniformScale;
        const srcX = fp.centerX + (x - bp.centerX) / uniformScale;
        let v = 0;
        if (srcX >= 0 && srcX < front.width && srcY >= 0 && srcY < front.height) {
          v = front.data[Math.round(srcY) * front.width + Math.round(srcX)];
        }
        if (y <= bp.neckY + Math.max(2, Math.round(backSpanH * 0.03))) {
          const mx = Math.min(w - 1, Math.max(0, w - 1 - x));
          if (back.data[y * w + mx]) {
            v = 1;
          }
        }
        out[y * w + x] = v;
      }
    }

    return {
      alignedFront: { width: w, height: h, data: out },
      transform: {
        aligned: true,
        scaleY: uniformScale,
        scaleX: uniformScale,
        frontBottomY: fp.maxY,
        backBottomY: bp.maxY,
        frontCenterX: fp.centerX,
        backCenterX: bp.centerX,
        headCompleted: true,
        headTopNormY: 1 - bp.minY / Math.max(1, h - 1),
        neckNormY: 1 - bp.neckY / Math.max(1, h - 1),
      },
    };
  }

  const neckCutoffY = Math.max(bp.neckY, fp.neckY);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = Math.min(front.width - 1, Math.round((x / Math.max(1, w - 1)) * (front.width - 1)));
      const fy = Math.min(front.height - 1, Math.round((y / Math.max(1, h - 1)) * (front.height - 1)));
      let v = front.data[fy * front.width + fx];
      if (y <= neckCutoffY) {
        const mx = Math.min(w - 1, Math.max(0, w - 1 - x));
        v = back.data[y * w + mx];
      }
      out[y * w + x] = v;
    }
  }

  return {
    alignedFront: { width: w, height: h, data: out },
    transform: {
      ...identityTransform,
      headCompleted: true,
      headTopNormY: 1 - bp.minY / Math.max(1, h - 1),
      neckNormY: 1 - neckCutoffY / Math.max(1, h - 1),
    },
  };
}

/**
 * 1D parabolik alt zarf (Felzenszwalb-Huttenlocher) ile tam 2D Öklid Mesafe Dönüşümü (EDT).
 * Her ön-plan pikselinin en yakın silüet kenarına olan gerçek piksel mesafesini O(W*H) sürede hesaplar.
 */
export function computeSilhouetteEDT(mask: BinaryMask): Float32Array {
  const { width: w, height: h, data } = mask;
  const INF = 1e12;
  const f = new Float32Array(w * h);

  const v = new Int32Array(Math.max(w, h));
  const z = new Float32Array(Math.max(w, h) + 1);
  const g = new Float32Array(Math.max(w, h));
  const dOut = new Float32Array(Math.max(w, h));

  const edt1d = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = 0;
      while (true) {
        const r = v[k];
        s = ((g[q] + q * q) - (g[r] + r * r)) / (2 * q - 2 * r);
        if (s <= z[k]) {
          k--;
        } else {
          break;
        }
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dx = q - v[k];
      dOut[q] = dx * dx + g[v[k]];
    }
  };

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      g[y] = data[y * w + x] ? INF : 0;
    }
    edt1d(h);
    for (let y = 0; y < h; y++) {
      f[y * w + x] = dOut[y];
    }
  }

  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      g[x] = f[rowOff + x];
    }
    edt1d(w);
    for (let x = 0; x < w; x++) {
      f[rowOff + x] = Math.sqrt(Math.max(0, dOut[x]));
    }
  }

  return f;
}

/**
 * Balonsuz, görsele sadık keskin hatlı süper-elips derinlik + anatomik +Z merkez kaydırma haritası:
 * - Gövde/ceket genişliği aşırı şişmez (boya bağlı güvenli derinlik tavanı).
 * - Ayak bandı (+Z yüz yönüne doğru öne kaydırılır, topuk düzleşir, parmak ucu yüzle aynı yöne bakar).
 */
function buildOrganicHalfDepthMap(
  mask: BinaryMask,
  edt: Float32Array,
  profile?: Partial<CharacterDepthProfile> | null,
  depthPreset: DepthStylePreset = 'natural-sharp'
): { halfDepth: Float32Array; zCenterOffset: Float32Array; maxHalfDepth: number } {
  const { width: w, height: h, data } = mask;
  const halfDepth = new Float32Array(w * h);
  const zCenterOffset = new Float32Array(w * h);

  let minY = h;
  let maxY = 0;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x]) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const spanH = Math.max(1, maxY - minY);
  const normDim = Math.max(w, h);
  const isHumanoid = (profile?.subjectType ?? 'humanoid') !== 'object';

  const presetMult =
    depthPreset === 'slim'
      ? { torso: 0.34, head: 0.66, limb: 0.56, cap: 0.82 }
      : depthPreset === 'bold'
        ? { torso: 0.56, head: 0.86, limb: 0.78, cap: 1.18 }
        : { torso: 0.44, head: 0.78, limb: 0.68, cap: 1.0 };

  const headScale = profile?.headDepthScale ? Math.min(0.92, profile.headDepthScale * 0.85) : presetMult.head;
  const torsoScale = profile?.torsoDepthScale ? Math.min(0.62, profile.torsoDepthScale * 0.74) : presetMult.torso;
  const limbScale = profile?.limbDepthScale ? Math.min(0.84, profile.limbDepthScale * 0.82) : presetMult.limb;

  // Boya bağlı anatomik derinlik tavanları (geniş ceket/kollar gövdeye bitişikse balonlaşmayı kesin engeller)
  const capHead = (spanH * 0.088 * presetMult.cap) / normDim;
  const capTorso = (spanH * 0.112 * presetMult.cap) / normDim;
  const capArm = (spanH * 0.068 * presetMult.cap) / normDim;
  const capLeg = (spanH * 0.078 * presetMult.cap) / normDim;
  const capFoot = (spanH * 0.095 * presetMult.cap) / normDim;

  let maxHalfDepth = 1e-4;

  for (let y = minY; y <= maxY; y++) {
    const rowOff = y * w;
    const relY = (y - minY) / spanH; // 0 = tepe (kafa), 1 = taban (ayaklar)

    let x = 0;
    while (x < w) {
      while (x < w && !data[rowOff + x]) x++;
      if (x >= w) break;
      const segStart = x;
      let segMaxEdt = 0;
      while (x < w && data[rowOff + x]) {
        const d = edt[rowOff + x];
        if (d > segMaxEdt) segMaxEdt = d;
        x++;
      }
      const segEnd = x - 1;
      const segWidth = segEnd - segStart + 1;
      const segHalfW = Math.max(1, segWidth * 0.5);
      // Yerel kesit yarıçapı: şişmeyi önlemek için EDT tepesine daha sadık
      const localR = Math.max(1, Math.min(segHalfW, Math.max(segMaxEdt, segHalfW * 0.52)));

      let regionScale = torsoScale;
      let regionCap = capTorso;
      let zShift = 0;

      if (isHumanoid) {
        if (relY < 0.19) {
          regionScale = headScale;
          regionCap = capHead;
          // Yüz / burun bölgesi hafif +Z merkezli
          zShift = (spanH * 0.008) / normDim;
        } else if (relY < 0.57) {
          const looksLikeArm = segWidth < spanH * 0.11;
          regionScale = looksLikeArm ? limbScale : torsoScale;
          regionCap = looksLikeArm ? capArm : capTorso;
          // Göğüs bölgesi hafif öne, bel/kalça dengeli
          zShift = relY < 0.38 ? (spanH * 0.005) / normDim : 0;
        } else if (relY < 0.90) {
          regionScale = limbScale;
          regionCap = capLeg;
          zShift = 0;
        } else {
          // Ayak bandı (%90..%100): Parmak uçları +Z (yüz) yönüne doğru uzanır, topuk arkada düz kalır!
          const footT = Math.min(1, (relY - 0.90) / 0.10);
          regionScale = Math.min(0.95, limbScale * (1 + 0.28 * footT));
          regionCap = capFoot;
          zShift = ((spanH * 0.032) / normDim) * footT;
        }
      } else {
        regionScale = depthPreset === 'slim' ? 0.45 : depthPreset === 'bold' ? 0.72 : 0.58;
        regionCap = (spanH * 0.24 * presetMult.cap) / normDim;
      }

      for (let sx = segStart; sx <= segEnd; sx++) {
        const d = Math.min(localR, edt[rowOff + sx]);
        const t = d / localR; // 0 = silüet kenarı, 1 = segment ekseni
        // Balonsuz keskin süper-elips profil: kenarlar görsel silüetine sadık, orta kısım doğal anatomik
        const sculpted = Math.pow(Math.max(0, 1 - Math.pow(1 - t, 1.85)), 0.56);
        const rawHz = (localR * sculpted * regionScale) / normDim;
        const hz = Math.min(regionCap, rawHz);
        halfDepth[rowOff + sx] = hz;
        zCenterOffset[rowOff + sx] = zShift * sculpted;
        if (hz > maxHalfDepth) maxHalfDepth = hz;
      }
    }
  }

  // Yalnızca 1 hafif 3x3 geçiş: kol-omuz/boyun geçişlerini pürüzsüzleştirir, silüet kenarlarını eritmez
  const tmpDepth = new Float32Array(w * h);
  const tmpShift = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (!data[idx]) continue;
      tmpDepth[idx] =
        (halfDepth[idx - w - 1] +
          halfDepth[idx - w] * 2 +
          halfDepth[idx - w + 1] +
          halfDepth[idx - 1] * 2 +
          halfDepth[idx] * 6 +
          halfDepth[idx + 1] * 2 +
          halfDepth[idx + w - 1] +
          halfDepth[idx + w] * 2 +
          halfDepth[idx + w + 1]) /
        18;
      tmpShift[idx] =
        (zCenterOffset[idx - w] +
          zCenterOffset[idx - 1] +
          zCenterOffset[idx] * 4 +
          zCenterOffset[idx + 1] +
          zCenterOffset[idx + w]) /
        8;
    }
  }

  return { halfDepth: tmpDepth, zCenterOffset: tmpShift, maxHalfDepth };
}

function sampleFloatMapBilinear(
  map: Float32Array,
  w: number,
  h: number,
  uNorm: number,
  vNorm: number
): number {
  if (uNorm < 0 || uNorm > 1 || vNorm < 0 || vNorm > 1) return 0;
  const fx = uNorm * (w - 1);
  const fy = (1 - vNorm) * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = map[y0 * w + x0];
  const v10 = map[y0 * w + x1];
  const v01 = map[y1 * w + x0];
  const v11 = map[y1 * w + x1];

  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

interface SmoothSdfMask {
  width: number;
  height: number;
  /** 0..1 arası C1-sürekli işaretli mesafe rampası (0.5 = tam pürüzsüz silüet sınırı). */
  data: Float32Array;
}

/**
 * İkili (0/1) silüet maskesini merdiven etkisini tamamen yok eden sürekli 2B İşaretli Mesafe Alanına (SDF)
 * dönüştürür: `edtIn - edtOut` + 3×3 yumuşatma → [0, 1] sürekli geçiş rampası (0.5 = tam kontur).
 * Marching Cubes artık basamaklı 0/1 yerine pürüzsüz eğrisel izo-yüzey çıkarır.
 */
function buildSmoothMaskSdf(mask: BinaryMask, bandPx = 2.4): SmoothSdfMask {
  const { width: w, height: h, data } = mask;
  const total = w * h;
  const invData = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    invData[i] = data[i] ? 0 : 1;
  }
  const edtIn = computeSilhouetteEDT(mask);
  const edtOut = computeSilhouetteEDT({ width: w, height: h, data: invData });
  const rawSdf = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    // 0.5 px merkez kaydırmasıyla 0 tam piksel sınırına oturur
    rawSdf[i] = data[i] ? edtIn[i] - 0.5 : -(edtOut[i] - 0.5);
  }

  // Tek geçiş 3×3 Gaussian yumuşatma: eğik ve yuvarlak piksel merdivenlerini pürüzsüz eğriye çevirir
  const smooth = new Float32Array(total);
  const invBand = 1 / Math.max(1.0, bandPx);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y + 1 < h ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x + 1 < w ? x + 1 : w - 1;
      const s =
        (rawSdf[y0 * w + x0] +
          rawSdf[y0 * w + x] * 2 +
          rawSdf[y0 * w + x1] +
          rawSdf[row + x0] * 2 +
          rawSdf[row + x] * 4 +
          rawSdf[row + x1] * 2 +
          rawSdf[y1 * w + x0] +
          rawSdf[y1 * w + x] * 2 +
          rawSdf[y1 * w + x1]) /
        16;
      const norm = 0.5 + s * 0.5 * invBand;
      smooth[row + x] = norm < 0 ? 0 : norm > 1 ? 1 : norm;
    }
  }

  return { width: w, height: h, data: smooth };
}

function sampleSdfBilinear(sdf: SmoothSdfMask, uNorm: number, vNorm: number): number {
  return sampleFloatMapBilinear(sdf.data, sdf.width, sdf.height, uNorm, vNorm);
}

/**
 * İzotropik 3D skaler alan yumuşatma (merdiven giderici):
 * Sert ikili kırpma uygulamadan 3B izo-yüzey geçiş bandını pürüzsüzleştirir.
 */
function smoothFieldSilhouettePreserving(
  field: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  passes: number
): Float32Array {
  let src: Float32Array = field;
  let dst: Float32Array = new Float32Array(field.length);
  const strideY = nx;
  const strideZ = nx * ny;

  for (let p = 0; p < passes; p++) {
    dst.fill(0);
    for (let z = 1; z < nz - 1; z++) {
      const zOff = z * strideZ;
      for (let y = 1; y < ny - 1; y++) {
        const zyOff = zOff + y * strideY;
        for (let x = 1; x < nx - 1; x++) {
          const idx = zyOff + x;
          const c = src[idx];
          const zSum = src[idx - strideZ] + src[idx + strideZ];
          const xySum = src[idx - 1] + src[idx + 1] + src[idx - strideY] + src[idx + strideY];
          if (c <= 0.001 && zSum <= 0.002 && xySum <= 0.004) continue;
          // İzotropik 6-komşu + merkez ağırlıklı pürüzsüzleştirme (merdiven basamaklarını tamamen giderir)
          dst[idx] = (c * 6.0 + zSum * 1.5 + xySum * 1.25) / 14.0;
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
 * Maskenin aktif normalize sınırlarını (0..1) hesaplar; boş havayı kesmek için kullanılır.
 */
function computeMaskNormBounds(mask: BinaryMask): { minU: number; maxU: number; minV: number; maxV: number } {
  const { width: w, height: h, data } = mask;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { minU: 0, maxU: 1, minV: 0, maxV: 1 };
  }
  return {
    minU: minX / Math.max(1, w - 1),
    maxU: maxX / Math.max(1, w - 1),
    minV: 1 - maxY / Math.max(1, h - 1),
    maxV: 1 - minY / Math.max(1, h - 1),
  };
}

const VIEW_NORMALS: Record<ViewAngle, [number, number, number]> = {
  front: [0, 0, 1],
  frontRight: [Math.SQRT1_2, 0, Math.SQRT1_2],
  right: [1, 0, 0],
  backRight: [Math.SQRT1_2, 0, -Math.SQRT1_2],
  back: [0, 0, -1],
  backLeft: [-Math.SQRT1_2, 0, -Math.SQRT1_2],
  left: [-1, 0, 0],
  frontLeft: [-Math.SQRT1_2, 0, Math.SQRT1_2],
  top: [0, 1, 0],
};

/**
 * Tüm mevcut fotoğraf açılarından (+ yakın yüz fotoğrafından) 3D model yüzeyine
 * normal-ağırlıklı 360° vertex renk projeksiyonu uygular (sRGB → Linear dönüşümlü).
 */
export function projectMultiViewColors(
  geometry: THREE.BufferGeometry,
  colorViews: Partial<Record<ViewAngle, ImageData>>,
  options: {
    faceCloseUp?: ImageData | null;
    frontTransform?: FrontTransform;
    /** Yan profillerin tespit edilen/seçilen yönü (ayak ve burun +Z ile eşleşir). */
    rightFacing?: 'left' | 'right';
    leftFacing?: 'left' | 'right';
    /** Yalnızca tek yan (Sağ veya Sol) mevcutsa karşı yan (+X / -X) yüzeye de simetrik uygula. */
    symmetricSideMirror?: boolean;
    /** Anizotropik veya kübik voxel ızgarasından 0..1 normalize uzaya geri dönüşüm parametreleri. */
    voxelNormBounds?: {
      scale: number;
      centerX: number;
      boxMinY: number;
      centerZ: number;
      normMinX: number;
      normMaxX: number;
      normMinY: number;
      normMaxY: number;
      normMinZ: number;
      normMaxZ: number;
      worldMinX: number;
      worldMaxX: number;
      worldMinY: number;
      worldMaxY: number;
      worldMinZ: number;
      worldMaxZ: number;
      nx: number;
      ny: number;
      nz: number;
      pad: number;
    };
  } = {}
): THREE.BufferGeometry {
  const symmetricSide = options.symmetricSideMirror !== false;
  const effectiveColorViews: Partial<Record<ViewAngle, ImageData>> = { ...colorViews };
  if (symmetricSide) {
    if (effectiveColorViews.right && !effectiveColorViews.left) {
      effectiveColorViews.left = effectiveColorViews.right;
    } else if (effectiveColorViews.left && !effectiveColorViews.right) {
      effectiveColorViews.right = effectiveColorViews.left;
    }
  }

  const activeColorAngles = (Object.keys(effectiveColorViews) as ViewAngle[]).filter((a) =>
    Boolean(effectiveColorViews[a])
  );
  if (activeColorAngles.length === 0 && !options.faceCloseUp) return geometry;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return geometry;
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const vb = options.voxelNormBounds;
  const ft = options.frontTransform;
  const rightFacing =
    colorViews.right
      ? options.rightFacing ?? 'left'
      : symmetricSide && colorViews.left
        ? options.leftFacing ?? 'right'
        : options.rightFacing ?? 'left';
  const leftFacing =
    colorViews.left
      ? options.leftFacing ?? 'right'
      : symmetricSide && colorViews.right
        ? options.rightFacing ?? 'left'
        : options.leftFacing ?? 'right';
  const INV_SQRT2 = Math.SQRT1_2;

  const faceImg = options.faceCloseUp ?? null;
  const faceRegion = faceImg ? detectFaceRegion(faceImg, { padding: 0.24 }) : null;

  const mapFrontUv = (uNorm: number, vNorm: number, img: ImageData): [number, number] => {
    if (!ft || !ft.aligned) return [uNorm, vNorm];
    const yBackPx = (1 - vNorm) * (img.height - 1);
    const xBackPx = uNorm * (img.width - 1);
    const srcY = ft.frontBottomY - (ft.backBottomY - yBackPx) / Math.max(0.2, ft.scaleY);
    const srcX = ft.frontCenterX + (xBackPx - ft.backCenterX) / Math.max(0.2, ft.scaleX);
    return [srcX / Math.max(1, img.width - 1), 1 - srcY / Math.max(1, img.height - 1)];
  };

  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);

    let uX: number;
    let vY: number;
    let uZ: number;
    if (vb) {
      const wx = px / vb.scale + vb.centerX;
      const wy = py / vb.scale + vb.boxMinY;
      const wz = pz / vb.scale + vb.centerZ;
      const gx = ((wx - vb.worldMinX) / Math.max(1e-6, vb.worldMaxX - vb.worldMinX)) * (vb.nx - 1);
      const gy = ((wy - vb.worldMinY) / Math.max(1e-6, vb.worldMaxY - vb.worldMinY)) * (vb.ny - 1);
      const gz = ((wz - vb.worldMinZ) / Math.max(1e-6, vb.worldMaxZ - vb.worldMinZ)) * (vb.nz - 1);
      const tx = (gx - vb.pad) / Math.max(1, vb.nx - 1 - vb.pad * 2);
      const ty = (gy - vb.pad) / Math.max(1, vb.ny - 1 - vb.pad * 2);
      const tz = (gz - vb.pad) / Math.max(1, vb.nz - 1 - vb.pad * 2);
      uX = vb.normMinX + tx * (vb.normMaxX - vb.normMinX);
      vY = vb.normMinY + ty * (vb.normMaxY - vb.normMinY);
      uZ = vb.normMinZ + tz * (vb.normMaxZ - vb.normMinZ);
    } else {
      uX = (px - box.min.x) / Math.max(1e-5, size.x);
      vY = (py - box.min.y) / Math.max(1e-5, size.y);
      uZ = (pz - box.min.z) / Math.max(1e-5, size.z);
    }

    const cx = uX - 0.5;
    const cz = uZ - 0.5;

    let rAcc = 0;
    let gAcc = 0;
    let bAcc = 0;
    let wAcc = 0;

    for (const angle of activeColorAngles) {
      const img = effectiveColorViews[angle];
      if (!img) continue;

      const [vnx, vny, vnz] = VIEW_NORMALS[angle];
      const dot = nx * vnx + ny * vny + nz * vnz;
      const facing = Math.max(0, dot + 0.22);
      if (facing <= 0.01) continue;
      let weight = Math.pow(facing, 2.8);

      const inHeadRegion = ft?.headCompleted && vY >= ft.neckNormY - 0.01;
      if (angle === 'front' && inHeadRegion) {
        weight *= 0.04;
      }

      let su = uX;
      let sv = vY;
      switch (angle) {
        case 'front':
          [su, sv] = mapFrontUv(uX, vY, img);
          break;
        case 'back':
          su = 1 - uX;
          sv = vY;
          break;
        case 'right':
          su = rightFacing === 'right' ? uZ : 1 - uZ;
          sv = vY;
          break;
        case 'left':
          su = leftFacing === 'right' ? uZ : 1 - uZ;
          sv = vY;
          break;
        case 'frontRight':
          su = 0.5 + (cx - cz) * INV_SQRT2;
          sv = vY;
          break;
        case 'backRight':
          su = 0.5 + (-cx - cz) * INV_SQRT2;
          sv = vY;
          break;
        case 'backLeft':
          su = 0.5 + (-cx + cz) * INV_SQRT2;
          sv = vY;
          break;
        case 'frontLeft':
          su = 0.5 + (cx + cz) * INV_SQRT2;
          sv = vY;
          break;
        case 'top':
          su = uX;
          sv = 1 - uZ;
          break;
      }

      const [r, g, b, alpha] = sampleColorSafe(img, su, sv);
      if (alpha > 0.05) {
        const effW = weight * alpha;
        rAcc += r * effW;
        gAcc += g * effW;
        bAcc += b * effW;
        wAcc += effW;
      }
    }

    if (wAcc < 0.01) {
      const fallbackImg =
        nz >= 0
          ? effectiveColorViews.front ?? effectiveColorViews.back
          : effectiveColorViews.back ?? effectiveColorViews.front;
      if (fallbackImg) {
        const isBack = fallbackImg === effectiveColorViews.back && fallbackImg !== effectiveColorViews.front;
        const [su, sv] = isBack ? [1 - uX, vY] : mapFrontUv(uX, vY, fallbackImg);
        const [r, g, b, a] = sampleColorSafe(fallbackImg, su, sv);
        if (a > 0.05) {
          rAcc = r;
          gAcc = g;
          bAcc = b;
          wAcc = 1;
        }
      }
    }

    let rFinal = wAcc > 0 ? rAcc / wAcc : 0.72;
    let gFinal = wAcc > 0 ? gAcc / wAcc : 0.75;
    let bFinal = wAcc > 0 ? bAcc / wAcc : 0.8;

    // Yakın yüz fotoğrafı varsa kafa ön yarımküresine (+Z) yüksek çözünürlüklü yüz bindir
    if (faceImg && nz > 0.14) {
      const headHeightRatio = ft ? Math.max(0.14, Math.min(0.28, (ft.headTopNormY - ft.neckNormY) * 1.15)) : 0.21;
      const headMinY = box.max.y - size.y * headHeightRatio;
      if (py >= headMinY) {
        const headHalfW = Math.max(size.x * 0.24, size.y * 0.095);
        const fu = 0.5 + (px - center.x) / (2 * headHalfW);
        const fv = (py - headMinY) / Math.max(1e-4, size.y * headHeightRatio);

        if (fu >= 0 && fu <= 1 && fv >= 0 && fv <= 1) {
          const ex = (fu - 0.5) * 2;
          const ey = (fv - 0.52) * 2;
          const ellDist = Math.sqrt(ex * ex + ey * ey);
          if (ellDist < 1.08) {
            const regX = faceRegion ? faceRegion.x : faceImg.width * 0.16;
            const regY = faceRegion ? faceRegion.y : faceImg.height * 0.08;
            const regW = faceRegion ? faceRegion.width : faceImg.width * 0.68;
            const regH = faceRegion ? faceRegion.height : faceImg.height * 0.76;

            const sampleU = (regX + fu * regW) / Math.max(1, faceImg.width - 1);
            const sampleV = 1 - (regY + (1 - fv) * regH) / Math.max(1, faceImg.height - 1);
            const [fr, fg, fb, fa] = sampleColorSafe(faceImg, sampleU, sampleV);
            if (fa > 0.2) {
              const edgeFade = Math.max(0, Math.min(1, (1.08 - ellDist) / 0.26));
              const facingFade = Math.max(0, Math.min(1, (nz - 0.14) / 0.35));
              const blend = edgeFade * facingFade * fa;
              rFinal = rFinal * (1 - blend) + fr * blend;
              gFinal = gFinal * (1 - blend) + fg * blend;
              bFinal = bFinal * (1 - blend) + fb * blend;
            }
          }
        }
      }
    }

    colors[i * 3] = srgbChannelToLinear(rFinal);
    colors[i * 3 + 1] = srgbChannelToLinear(gFinal);
    colors[i * 3 + 2] = srgbChannelToLinear(bFinal);
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Sıkı Anizotropik Yüksek-Poligonlu 3D Görsel Gövde Rekonstrüksiyonu:
 * - Boş havayı keserek figürün gerçek sınırlarına sıkıca sarılır (3x daha hızlı + 55K-90K keskin üçgen).
 * - Yan profillerde ayak ucu & burun yönünü otomatik algılayıp yüzle (+Z) kilitler.
 * - Yan profil yoksa balonsuz süper-elips derinlik + ileri +Z ayak kaydırma + fotoğraf gradyan rölyef oyma uygular.
 */
export function reconstructVisualHull(
  views: Partial<Record<ViewAngle, BinaryMask>>,
  options: VisualHullOptions = {}
): THREE.BufferGeometry {
  const resolution = Math.max(24, Math.min(192, Math.round(options.resolution ?? 144)));
  const smoothPasses = Math.max(0, Math.min(4, Math.round(options.smoothPasses ?? 1)));
  const sizeMm = Math.max(5, options.sizeMm ?? 60);
  const autoCompleteHead = options.autoCompleteHead ?? true;
  const projectColors = options.projectColors ?? true;
  const depthProfile = options.depthProfile ?? null;
  const depthPreset: DepthStylePreset = options.depthPreset ?? 'natural-sharp';
  const sideFacingOpt: SideFacingChoice = options.sideProfileFacing ?? 'auto';
  const symmetricSideMirror = options.symmetricSideMirror !== false;

  const activeAngles = (Object.keys(views) as ViewAngle[]).filter((k) => Boolean(views[k]));
  if (activeAngles.length === 0) {
    throw new Error('En az bir temizlenmiş fotoğraf maskesi gereklidir.');
  }

  let front = views.front;
  const frontRight = views.frontRight;
  const right = views.right;
  const backRight = views.backRight;
  const back = views.back;
  const backLeft = views.backLeft;
  const left = views.left;
  const frontLeft = views.frontLeft;
  const top = views.top;

  // Ön görünümde başsız/bantlı kafa varsa arka silüetten otomatik hizala ve tamamla
  let frontTransform: FrontTransform | undefined;
  if (front && back && autoCompleteHead) {
    const aligned = alignAndCompleteFrontBackMasks(front, back, {
      forceHeadComplete: depthProfile?.frontHeadMissing,
      faceOccluded: depthProfile?.frontFaceOccluded,
    });
    front = aligned.alignedFront;
    frontTransform = aligned.transform;
  }

  // Yan profillerde parmak ucu + burun yönünü algıla (veya kullanıcı seçimine kilitle)
  let rightFacing: 'left' | 'right' = 'left';
  let leftFacing: 'left' | 'right' = 'right';
  if (right) {
    if (sideFacingOpt !== 'auto') {
      rightFacing = sideFacingOpt;
    } else {
      const det = detectSideProfileFacing(right, options.colorViews?.right);
      rightFacing = det.confidence >= 0.08 ? det.facing : 'left';
    }
  }
  if (left) {
    if (sideFacingOpt !== 'auto') {
      leftFacing = sideFacingOpt;
    } else {
      const det = detectSideProfileFacing(left, options.colorViews?.left);
      leftFacing = det.confidence >= 0.08 ? det.facing : 'right';
    }
  }

  const hasDepthConstraint = Boolean(
    right || left || top || frontRight || backRight || backLeft || frontLeft
  );
  const INV_SQRT2 = Math.SQRT1_2;

  // Yan açı yoksa balonsuz süper-elips derinlik + anatomik +Z ayak kaydırma haritası üret
  let organicDepthMap: {
    halfDepth: Float32Array;
    zCenterOffset: Float32Array;
    maxHalfDepth: number;
    width: number;
    height: number;
  } | null = null;

  if (!hasDepthConstraint) {
    const refMask = front ?? back;
    if (refMask) {
      let combinedMask: BinaryMask = refMask;
      if (front && back && front.width === back.width && front.height === back.height) {
        const w = front.width;
        const h = front.height;
        const merged = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
          const row = y * w;
          for (let x = 0; x < w; x++) {
            const fVal = front.data[row + x];
            const bVal = back.data[row + (w - 1 - x)];
            merged[row + x] = fVal || bVal ? 1 : 0;
          }
        }
        combinedMask = { width: w, height: h, data: merged };
      }
      const edt = computeSilhouetteEDT(combinedMask);
      const built = buildOrganicHalfDepthMap(combinedMask, edt, depthProfile, depthPreset);
      organicDepthMap = {
        halfDepth: built.halfDepth,
        zCenterOffset: built.zCenterOffset,
        maxHalfDepth: built.maxHalfDepth,
        width: combinedMask.width,
        height: combinedMask.height,
      };
    }
  }

  // Sıkı aktif X/Y/Z sınırlarını hesapla (boş havayı keserek hem hız hem detay artışı!)
  const bounds: ActiveNormBounds = {
    minX: 0,
    maxX: 1,
    minY: 0,
    maxY: 1,
    minZ: 0,
    maxZ: 1,
  };
  const margin = 0.025;
  if (front || back) {
    const fb = front ? computeMaskNormBounds(front) : null;
    const bb = back ? computeMaskNormBounds(back) : null;
    const minX = Math.min(fb ? fb.minU : 1, bb ? 1 - bb.maxU : 1);
    const maxX = Math.max(fb ? fb.maxU : 0, bb ? 1 - bb.minU : 0);
    const minY = Math.min(fb ? fb.minV : 1, bb ? bb.minV : 1);
    const maxY = Math.max(fb ? fb.maxV : 0, bb ? bb.maxV : 0);
    if (maxX > minX && maxY > minY) {
      bounds.minX = Math.max(0, minX - margin);
      bounds.maxX = Math.min(1, maxX + margin);
      bounds.minY = Math.max(0, minY - margin);
      bounds.maxY = Math.min(1, maxY + margin);
    }
  }

  if (organicDepthMap) {
    const zHalf = Math.min(0.48, organicDepthMap.maxHalfDepth + 0.065);
    bounds.minZ = Math.max(0, 0.5 - zHalf);
    bounds.maxZ = Math.min(1, 0.5 + zHalf);
  } else if ((right || left) && !frontRight && !backRight && !backLeft && !frontLeft) {
    let minZ = 1;
    let maxZ = 0;
    if (right) {
      const rb = computeMaskNormBounds(right);
      const z0 = rightFacing === 'right' ? rb.minU : 1 - rb.maxU;
      const z1 = rightFacing === 'right' ? rb.maxU : 1 - rb.minU;
      minZ = Math.min(minZ, z0);
      maxZ = Math.max(maxZ, z1);
    }
    if (left) {
      const lb = computeMaskNormBounds(left);
      const z0 = leftFacing === 'right' ? lb.minU : 1 - lb.maxU;
      const z1 = leftFacing === 'right' ? lb.maxU : 1 - lb.minU;
      minZ = Math.min(minZ, z0);
      maxZ = Math.max(maxZ, z1);
    }
    if (maxZ > minZ) {
      bounds.minZ = Math.max(0, minZ - margin);
      bounds.maxZ = Math.min(1, maxZ + margin);
    }
  }

  const spanX = Math.max(0.12, bounds.maxX - bounds.minX);
  const spanY = Math.max(0.12, bounds.maxY - bounds.minY);
  const spanZ = Math.max(0.10, bounds.maxZ - bounds.minZ);
  const maxSpan = Math.max(spanX, spanY, spanZ);

  const pad = 2;
  const resX = Math.max(20, Math.round((spanX / maxSpan) * resolution));
  const resY = Math.max(20, Math.round((spanY / maxSpan) * resolution));
  const resZ = Math.max(18, Math.round((spanZ / maxSpan) * resolution));
  const nx = resX + pad * 2;
  const ny = resY + pad * 2;
  const nz = resZ + pad * 2;

  let field: Float32Array = new Float32Array(nx * ny * nz);
  const strideY = nx;
  const strideZ = nx * ny;

  const frontColorImg = options.colorViews?.front;
  const backColorImg = options.colorViews?.back;
  const reliefStrength = Math.max(0, Math.min(0.055, depthProfile?.reliefStrength ?? 0.022));
  const frontReliefMap = frontColorImg && reliefStrength > 0.001 ? buildImageReliefMap(frontColorImg) : null;
  const backReliefMap = backColorImg && reliefStrength > 0.001 ? buildImageReliefMap(backColorImg) : null;

  // 0) Tüm aktif silüet maskelerini C1-sürekli 2B İşaretli Mesafe Alanına (SDF) çevir (sıfır merdiven etkisi!)
  const frontSdf = front ? buildSmoothMaskSdf(front) : null;
  const backSdf = back ? buildSmoothMaskSdf(back) : null;
  const rightSdf = right ? buildSmoothMaskSdf(right) : null;
  const leftSdf = left ? buildSmoothMaskSdf(left) : null;
  const frontRightSdf = frontRight ? buildSmoothMaskSdf(frontRight) : null;
  const backRightSdf = backRight ? buildSmoothMaskSdf(backRight) : null;
  const backLeftSdf = backLeft ? buildSmoothMaskSdf(backLeft) : null;
  const frontLeftSdf = frontLeft ? buildSmoothMaskSdf(frontLeft) : null;
  const topSdf = top ? buildSmoothMaskSdf(top) : null;

  // 1) 2D (X, Y) sürekli SDF silüet haritasını önceden hesapla — boş sütunları Z döngüsüne girmeden atla!
  const xyOcc = new Float32Array(nx * ny);
  const xyMask = new Uint8Array(nx * ny);
  const xyHalfZ = organicDepthMap ? new Float32Array(nx * ny) : null;
  const xyShiftZ = organicDepthMap ? new Float32Array(nx * ny) : null;
  const xyFrontRelief = frontReliefMap ? new Float32Array(nx * ny) : null;
  const xyBackRelief = backReliefMap ? new Float32Array(nx * ny) : null;

  for (let y = pad; y < ny - pad; y++) {
    const ty = (y - pad) / Math.max(1, resY - 1);
    const nyNorm = bounds.minY + ty * spanY;
    const row = y * strideY;
    for (let x = pad; x < nx - pad; x++) {
      const tx = (x - pad) / Math.max(1, resX - 1);
      const nxNorm = bounds.minX + tx * spanX;

      let occ = 1.0;
      if (frontSdf && backSdf) {
        const fOcc = sampleSdfBilinear(frontSdf, nxNorm, nyNorm);
        const bOcc = sampleSdfBilinear(backSdf, 1 - nxNorm, nyNorm);
        occ = Math.min(fOcc, bOcc) * 0.78 + Math.max(fOcc, bOcc) * 0.22;
      } else if (frontSdf) {
        occ = sampleSdfBilinear(frontSdf, nxNorm, nyNorm);
      } else if (backSdf) {
        occ = sampleSdfBilinear(backSdf, 1 - nxNorm, nyNorm);
      }

      xyOcc[row + x] = occ;
      if (occ > 0.015) {
        xyMask[row + x] = 1;
        if (organicDepthMap && xyHalfZ && xyShiftZ) {
          xyHalfZ[row + x] = sampleFloatMapBilinear(
            organicDepthMap.halfDepth,
            organicDepthMap.width,
            organicDepthMap.height,
            nxNorm,
            nyNorm
          );
          xyShiftZ[row + x] = sampleFloatMapBilinear(
            organicDepthMap.zCenterOffset,
            organicDepthMap.width,
            organicDepthMap.height,
            nxNorm,
            nyNorm
          );
        }
        if (frontReliefMap && xyFrontRelief) {
          xyFrontRelief[row + x] = sampleFloatMapBilinear(
            frontReliefMap.data,
            frontReliefMap.width,
            frontReliefMap.height,
            nxNorm,
            nyNorm
          );
        }
        if (backReliefMap && xyBackRelief) {
          xyBackRelief[row + x] = sampleFloatMapBilinear(
            backReliefMap.data,
            backReliefMap.width,
            backReliefMap.height,
            1 - nxNorm,
            nyNorm
          );
        }
      }
    }
  }

  // 1b) T-Poz / A-Poz Uzuv-Farkındalıklı Kol Derinliği Algılama:
  // Ön/Arka görünümde kollar yana açık (T-Poz / A-Poz) iken Yan profilde kollar gövdeye yapışıksa,
  // gövde dışına taşan kolları göğüs kalınlığıyla düz kürek gibi kesmek yerine silindirik kol kesitiyle yont!
  let armBlendMap: Float32Array | null = null;
  let armHalfZMap: Float32Array | null = null;
  let armCenterZ = 0.5;
  if ((right || left) && !top && (front || back)) {
    const refMask = front ?? back!;
    const refBounds = computeMaskNormBounds(refMask);
    const refH = Math.max(0.1, refBounds.maxV - refBounds.minV);
    const refW = Math.max(0.05, refBounds.maxU - refBounds.minU);
    if (refW / refH > 0.48) {
      const { width: mw, height: mh, data: mdata } = refMask;
      const rowSpanAt = (relFromTop: number): { minU: number; maxU: number; valid: boolean } => {
        const yPx = Math.max(0, Math.min(mh - 1, Math.round((1 - (refBounds.maxV - relFromTop * refH)) * (mh - 1))));
        const row = yPx * mw;
        let x0 = mw;
        let x1 = -1;
        for (let x = 0; x < mw; x++) {
          if (mdata[row + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
          }
        }
        return x1 >= x0
          ? { minU: x0 / Math.max(1, mw - 1), maxU: x1 / Math.max(1, mw - 1), valid: true }
          : { minU: 0.5, maxU: 0.5, valid: false };
      };

      const waistSamples: number[] = [];
      const waistCenters: number[] = [];
      for (const r of [0.46, 0.50, 0.54, 0.58]) {
        const sp = rowSpanAt(r);
        if (sp.valid) {
          waistSamples.push(sp.maxU - sp.minU);
          waistCenters.push((sp.minU + sp.maxU) * 0.5);
        }
      }
      const armBandMax = Math.max(
        ...([0.20, 0.24, 0.28, 0.34, 0.40].map((r) => {
          const sp = rowSpanAt(r);
          return sp.valid ? sp.maxU - sp.minU : 0;
        }))
      );
      waistSamples.sort((a, b) => a - b);
      const coreWaistW = waistSamples.length > 0 ? waistSamples[Math.floor(waistSamples.length / 2)] : refH * 0.22;
      const coreCenterU =
        waistCenters.length > 0
          ? waistCenters.reduce((a, b) => a + b, 0) / waistCenters.length
          : (refBounds.minU + refBounds.maxU) * 0.5;
      const torsoHalfU = Math.max(coreWaistW * 0.62, refH * 0.11);
      if (armBandMax > torsoHalfU * 2.55) {
        const sideRef = right ?? left!;
        const sideFacingRef = right ? rightFacing : leftFacing;
        const sideY = Math.max(0, Math.min(sideRef.height - 1, Math.round((1 - (refBounds.maxV - 0.22 * refH)) * (sideRef.height - 1))));
        let sSum = 0;
        let sCnt = 0;
        for (let sx = 0; sx < sideRef.width; sx++) {
          if (sideRef.data[sideY * sideRef.width + sx]) {
            const u = sx / Math.max(1, sideRef.width - 1);
            sSum += sideFacingRef === 'right' ? u : 1 - u;
            sCnt++;
          }
        }
        if (sCnt > 0) armCenterZ = sSum / sCnt;

        const armEdt = computeSilhouetteEDT(refMask);
        armBlendMap = new Float32Array(nx * ny);
        armHalfZMap = new Float32Array(nx * ny);
        const transitionU = Math.max(0.025, refH * 0.04);
        const maxArmHalfZ = refH * 0.052;

        for (let y = pad; y < ny - pad; y++) {
          const ty = (y - pad) / Math.max(1, resY - 1);
          const nyNorm = bounds.minY + ty * spanY;
          const relFromTop = (refBounds.maxV - nyNorm) / refH;
          if (relFromTop < 0.14 || relFromTop > 0.64) continue;
          const row = y * strideY;
          for (let x = pad; x < nx - pad; x++) {
            if (!xyMask[row + x]) continue;
            const tx = (x - pad) / Math.max(1, resX - 1);
            const nxNorm = bounds.minX + tx * spanX;
            const distFromCore = Math.abs(nxNorm - coreCenterU) - torsoHalfU;
            if (distFromCore <= 0) continue;
            const blend = Math.min(1, distFromCore / transitionU);
            const edtPx = sampleFloatMapBilinear(armEdt, mw, mh, nxNorm, nyNorm);
            const armR = Math.min(maxArmHalfZ, Math.max(0.012, (edtPx / Math.max(mw, mh)) * 0.92));
            armBlendMap[row + x] = blend;
            armHalfZMap[row + x] = armR;
          }
        }
      }
    }
  }

  // 2) 3D Hacim doldurma (C1-sürekli SDF kesişimi ile pürüzsüz eğriler)
  const zStep = spanZ / Math.max(1, resZ - 1);
  const minHalfZ = Math.max(zStep * 1.1, 0.008);

  for (let z = pad; z < nz - pad; z++) {
    const tz = (z - pad) / Math.max(1, resZ - 1);
    const nzNorm = bounds.minZ + tz * spanZ;
    const cz = nzNorm - 0.5;
    const zOff = z * strideZ;

    const rightU = rightFacing === 'right' ? nzNorm : 1 - nzNorm;
    const leftU = leftFacing === 'right' ? nzNorm : 1 - nzNorm;

    for (let y = pad; y < ny - pad; y++) {
      const ty = (y - pad) / Math.max(1, resY - 1);
      const nyNorm = bounds.minY + ty * spanY;
      const yOff = y * strideY;

      let sideRowOcc = 1.0;
      if (rightSdf) {
        sideRowOcc = Math.min(sideRowOcc, sampleSdfBilinear(rightSdf, rightU, nyNorm));
      }
      if (leftSdf) {
        sideRowOcc = Math.min(sideRowOcc, sampleSdfBilinear(leftSdf, leftU, nyNorm));
      }
      if (sideRowOcc <= 0.01 && !armBlendMap) continue;

      const zyOff = zOff + yOff;
      for (let x = pad; x < nx - pad; x++) {
        const baseOcc = xyOcc[yOff + x];
        if (baseOcc <= 0.015) continue;

        let effectiveSideOcc = sideRowOcc;
        if (armBlendMap && armHalfZMap) {
          const armB = armBlendMap[yOff + x];
          if (armB > 0.001) {
            const armR = Math.max(minHalfZ, armHalfZMap[yOff + x]);
            const distOutsideArm = Math.abs(nzNorm - armCenterZ) - armR;
            const armDepthOcc = Math.max(0, Math.min(1, 0.5 - distOutsideArm / (zStep * 1.6)));
            effectiveSideOcc = sideRowOcc * (1 - armB) + armDepthOcc * armB;
          }
        }
        if (effectiveSideOcc <= 0.01) continue;

        let occ = Math.min(baseOcc, effectiveSideOcc);
        if (frontRightSdf || backRightSdf || backLeftSdf || frontLeftSdf || topSdf) {
          const tx = (x - pad) / Math.max(1, resX - 1);
          const nxNorm = bounds.minX + tx * spanX;
          const cx = nxNorm - 0.5;
          if (frontRightSdf && occ > 0.01) {
            occ = Math.min(occ, sampleSdfBilinear(frontRightSdf, 0.5 + (cx - cz) * INV_SQRT2, nyNorm));
          }
          if (backRightSdf && occ > 0.01) {
            occ = Math.min(occ, sampleSdfBilinear(backRightSdf, 0.5 + (-cx - cz) * INV_SQRT2, nyNorm));
          }
          if (backLeftSdf && occ > 0.01) {
            occ = Math.min(occ, sampleSdfBilinear(backLeftSdf, 0.5 + (-cx + cz) * INV_SQRT2, nyNorm));
          }
          if (frontLeftSdf && occ > 0.01) {
            occ = Math.min(occ, sampleSdfBilinear(frontLeftSdf, 0.5 + (cx + cz) * INV_SQRT2, nyNorm));
          }
          if (topSdf && occ > 0.01) {
            occ = Math.min(occ, sampleSdfBilinear(topSdf, nxNorm, 1 - nzNorm));
          }
        }

        if (!hasDepthConstraint && occ > 0.01 && xyHalfZ && xyShiftZ) {
          let halfZ = xyHalfZ[yOff + x];
          const centerShift = xyShiftZ[yOff + x];
          const relCz = cz - centerShift;

          if (reliefStrength > 0.001) {
            if (relCz >= 0 && xyFrontRelief) {
              halfZ += xyFrontRelief[yOff + x] * reliefStrength;
            } else if (relCz < 0 && xyBackRelief) {
              halfZ += xyBackRelief[yOff + x] * reliefStrength;
            } else if (relCz >= 0 && frontColorImg) {
              const tx = (x - pad) / Math.max(1, resX - 1);
              const nxNorm = bounds.minX + tx * spanX;
              halfZ += (sampleLuminanceBilinear(frontColorImg, nxNorm, nyNorm) - 0.5) * reliefStrength;
            }
          }

          const effHalfZ = Math.max(minHalfZ, Math.min(0.42, halfZ));
          const distOutside = Math.abs(relCz) - effHalfZ;
          const depthOcc = Math.max(0, Math.min(1, 0.5 - distOutside / (zStep * 1.6)));
          occ = Math.min(occ, depthOcc);
        }

        field[zyOff + x] = occ;
      }
    }
  }

  if (smoothPasses > 0) {
    field = smoothFieldSilhouettePreserving(field, nx, ny, nz, smoothPasses);
  }

  // Gerçek fiziksel oranları koruyan anizotropik dünya sınırları
  const stepX = spanX / Math.max(1, resX - 1);
  const stepY = spanY / Math.max(1, resY - 1);
  const stepZ = spanZ / Math.max(1, resZ - 1);
  const worldMinX = (bounds.minX - pad * stepX) * 2 - 1;
  const worldMaxX = (bounds.maxX + pad * stepX) * 2 - 1;
  const worldMinY = (bounds.minY - pad * stepY) * 2 - 1;
  const worldMaxY = (bounds.maxY + pad * stepY) * 2 - 1;
  const worldMinZ = (bounds.minZ - pad * stepZ) * 2 - 1;
  const worldMaxZ = (bounds.maxZ + pad * stepZ) * 2 - 1;

  const rawMcGeo = marchingCubes(
    field,
    nx,
    ny,
    nz,
    0.5,
    [worldMinX, worldMinY, worldMinZ],
    [worldMaxX, worldMaxY, worldMaxZ]
  );

  // Hacim-koruyucu Taubin yumuşatma (2 geçiş): kalan tüm Marching Cubes merdiven/basamak izlerini
  // sıfır hacim kaybıyla silip yuvarlak hatları (kafa, omuz, figür, silindir) pürüzsüzleştirir!
  const taubinPasses = smoothPasses > 0 ? Math.min(3, smoothPasses + 1) : 1;
  const geometry = taubinSmooth(rawMcGeo, taubinPasses, 0.42, -0.44);
  rawMcGeo.dispose();

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

  geometry.translate(-center.x, -box.min.y, -center.z);
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  if (projectColors && (options.colorViews || options.faceCloseUp)) {
    projectMultiViewColors(geometry, options.colorViews ?? {}, {
      faceCloseUp: options.faceCloseUp ?? null,
      frontTransform,
      rightFacing,
      leftFacing,
      symmetricSideMirror,
      voxelNormBounds: {
        scale,
        centerX: center.x,
        boxMinY: box.min.y,
        centerZ: center.z,
        normMinX: bounds.minX,
        normMaxX: bounds.maxX,
        normMinY: bounds.minY,
        normMaxY: bounds.maxY,
        normMinZ: bounds.minZ,
        normMaxZ: bounds.maxZ,
        worldMinX,
        worldMaxX,
        worldMinY,
        worldMaxY,
        worldMinZ,
        worldMaxZ,
        nx,
        ny,
        nz,
        pad,
      },
    });
  }

  return geometry;
}
