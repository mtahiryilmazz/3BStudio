/**
 * Evrensel Karakter Sheet (Turnaround) Bölücü.
 *
 * 3, 4, 5, 6, 7+ görselli tek satırlı, çok satırlı veya kademeli (staggered)
 * karakter sheet'lerini kenar gradyanına uyumlu arka plan çıkarma + 2B bağlı bileşen
 * (CCL) + yapışık figür vadi kesimi ile otomatik böler. Saf piksel matematiği; DOM yok.
 */

import { detectFaceRegion } from './faceDetect';
import type { ViewAngle } from './types';

export interface SheetSlice {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SheetSplitOptions {
  /** Gutter sayılan sütunda figür pikseli eşiği (0..1; sütundaki "figür oranı" bunun altındaysa boş sayılır). */
  figureRatioThreshold?: number;
  /** Bu genişliğin altındaki dilimler atılır (görüntü genişliğine oran). */
  minSliceRatio?: number;
  /** Bulunacak en fazla dilim. */
  maxSlices?: number;
}

const DEFAULT_FIGURE_RATIO = 0.02;
const DEFAULT_MIN_SLICE = 0.04;
const DEFAULT_MAX_SLICES = 12;

/** 0..1 normalize luminance. */
function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Her sütun için "figür pikseli oranı" hesaplar: arka plandan (kenar sütunların
 * medyan rengi) yeterince farklı olan piksellerin sütun içindeki payı.
 */
function columnFigureRatios(data: ImageData): Float64Array {
  const { width, height, data: px } = data;
  const ratios = new Float64Array(width);

  const edgeSamples: Array<[number, number, number]> = [];
  const sampleStep = Math.max(1, Math.floor(height / 32));
  for (let y = 0; y < height; y += sampleStep) {
    for (const x of [0, 1, width - 2, width - 1]) {
      const cx = Math.max(0, Math.min(width - 1, x));
      const i = (y * width + cx) * 4;
      edgeSamples.push([px[i], px[i + 1], px[i + 2]]);
    }
  }
  const bgL = edgeSamples
    .map(([r, g, b]) => luminance(r, g, b))
    .sort((a, b) => a - b);
  const bgLum = bgL[Math.floor(bgL.length / 2)] ?? 1;

  const diffThreshold = 0.12;
  for (let x = 0; x < width; x++) {
    let figure = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      const l = luminance(px[i], px[i + 1], px[i + 2]);
      if (Math.abs(l - bgLum) > diffThreshold) figure++;
    }
    ratios[x] = figure / height;
  }
  return ratios;
}

/**
 * Dikey gutter'ları bulup aradaki dilimleri döndürür. Hiç gutter yoksa
 * tek dilim (tüm görüntü) döner — çağıran taraf her koşulda kullanılabilir
 * bir sonuç alır.
 */
export function detectSheetSlices(
  data: ImageData,
  options: SheetSplitOptions = {}
): SheetSlice[] {
  const figureThreshold = options.figureRatioThreshold ?? DEFAULT_FIGURE_RATIO;
  const minSliceRatio = options.minSliceRatio ?? DEFAULT_MIN_SLICE;
  const maxSlices = options.maxSlices ?? DEFAULT_MAX_SLICES;
  const { width, height } = data;

  const ratios = columnFigureRatios(data);

  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x < width; x++) {
    const isFigure = ratios[x] > figureThreshold;
    if (isFigure && start === -1) start = x;
    if ((!isFigure || x === width - 1) && start !== -1) {
      const end = isFigure ? x : x - 1;
      runs.push([start, end]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, width - 1]);

  const minSliceWidth = Math.max(2, Math.floor(width * minSliceRatio));
  const slices: SheetSlice[] = runs
    .filter(([a, b]) => b - a + 1 >= minSliceWidth)
    .map(([a, b]) => ({ x: a, y: 0, width: b - a + 1, height }));

  if (slices.length === 0) {
    return [{ x: 0, y: 0, width, height }];
  }
  if (slices.length > maxSlices) {
    const kept = [...slices].sort((a, b) => b.width - a.width).slice(0, maxSlices);
    kept.sort((a, b) => a.x - b.x);
    return kept;
  }
  return slices;
}

/**
 * Bir ImageData'nın alt bölgesini yeni ImageData olarak kopyalar.
 */
export function cropImageData(data: ImageData, slice: SheetSlice): ImageData {
  const sx = Math.max(0, Math.min(data.width - 1, Math.round(slice.x)));
  const sy = Math.max(0, Math.min(data.height - 1, Math.round(slice.y)));
  const w = Math.max(1, Math.min(Math.round(slice.width), data.width - sx));
  const h = Math.max(1, Math.min(Math.round(slice.height), data.height - sy));
  const out: ImageData =
    typeof ImageData !== 'undefined'
      ? new ImageData(w, h)
      : ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' } as unknown as ImageData);
  for (let y = 0; y < h; y++) {
    const srcStart = ((sy + y) * data.width + sx) * 4;
    const dstStart = y * w * 4;
    out.data.set(data.data.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return out;
}

/**
 * Dilimleri tipik turnaround sırasına göre açılara eşler:
 * front → right → back → left → top.
 */
export function suggestSliceAngles(count: number): Array<'front' | 'right' | 'back' | 'left' | 'top'> {
  const order: Array<'front' | 'right' | 'back' | 'left' | 'top'> = ['front', 'right', 'back', 'left', 'top'];
  return Array.from({ length: count }, (_, i) => order[Math.min(i, order.length - 1)]);
}

/* ------------------------------------------------------------------ *
 * Evrensel 2B ızgara + bağlı bileşen (CCL) + vadi bölücü
 * 3, 4, 5, 6, 7+ görselli tüm karakter sheet düzenlerini destekler
 * ------------------------------------------------------------------ */

export type SheetCellKind = 'figure' | 'face';

export type SheetAngleReason =
  | 'yüz paneli'
  | 'yüz algılandı'
  | 'dar silüet'
  | 'yüz yok'
  | '3/4 turnaround'
  | 'çerçeveli ızgara';

export interface SheetCellAnalysis {
  kind: SheetCellKind;
  faceConfidence: number;
  suggestedAngle: ViewAngle;
  suggestionReason: SheetAngleReason;
}

export interface SheetCell extends SheetSlice {
  /** 'figure' = tam boy/nesne görünümü, 'face' = yüz yakın çekimi. */
  kind: SheetCellKind;
  /** Yüz ise algılama güveni (0..1); figure için 0. */
  faceConfidence: number;
  /** Hücrenin satır bandı indeksi (üstten 0). */
  row: number;
  /** İçerikten çıkarılan açı önerisi (yüz yok → arka, dar → yan, 3/4 ara açılar). */
  suggestedAngle: ViewAngle;
  /** Kullanıcının etiketi anlaması için öneri kaynağı. */
  suggestionReason: SheetAngleReason;
}

/**
 * Tek bir sheet hücresini içeriğine göre analiz eder:
 * - Kare/portre + yüz (conf >= 0.2) → yüz paneli
 * - Dar silüet (w/h <= 0.45) → yan görünüm (satırdaki ilk → right, sonraki → left)
 * - Geniş gövde + yüz ipucu (conf >= 0.15) → ön görünüm (front)
 * - Geniş gövde + yüz yok → arka görünüm (back)
 */
export function analyzeSheetCell(crop: ImageData, narrowIndex = 0): SheetCellAnalysis {
  const w = crop.width;
  const h = crop.height;
  const aspect = h / Math.max(1, w);
  const face = detectFaceRegion(crop);
  const faceConfidence = face ? face.confidence : 0;
  const isFace = Boolean(face && faceConfidence >= 0.2 && aspect < 1.7);

  if (isFace) {
    return {
      kind: 'face',
      faceConfidence,
      suggestedAngle: 'front',
      suggestionReason: 'yüz paneli',
    };
  }

  if (w / Math.max(1, h) <= 0.45) {
    return {
      kind: 'figure',
      faceConfidence: 0,
      suggestedAngle: narrowIndex === 0 ? 'right' : 'left',
      suggestionReason: 'dar silüet',
    };
  }

  if (faceConfidence >= 0.15) {
    return {
      kind: 'figure',
      faceConfidence: 0,
      suggestedAngle: 'front',
      suggestionReason: 'yüz algılandı',
    };
  }

  return {
    kind: 'figure',
    faceConfidence: 0,
    suggestedAngle: 'back',
    suggestionReason: 'yüz yok',
  };
}

export interface SheetLayout {
  cells: SheetCell[];
  rows: number;
  /** Arka plan rengi (teşhis için). */
  background: [number, number, number];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Kenar ve 4 köşe örneklerinden aykırı-değer (outlier) korumalı + dikey stüdyo
 * gradyanına (cyclorama) uyumlu arka plan modeli çıkarır.
 *
 * Sağ-alt veya kenarlara taşan büyük yüz/göğüs portreleri (beyaz tişört, kırmızı ceket vb.)
 * histogram moduyla dışlanır; böylece arka plan modeli asla bozulmaz.
 */
interface AdaptiveBgModel {
  global: [number, number, number];
  tl: [number, number, number];
  tr: [number, number, number];
  bl: [number, number, number];
  br: [number, number, number];
  /** Her y satırı için aykırı-temizlenmiş stüdyo arka plan rengi (dikey gradyan takibi). */
  rowBg: Float32Array;
  threshold: number;
}

function colorDistManhattan(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function estimateAdaptiveBackground(data: ImageData): AdaptiveBgModel {
  const { width, height, data: px } = data;

  // 1) Tüm dış çevre piksellerini topla ve 24-birim RGB histogramıyla baskın arka plan modunu bul
  const borderSamples: Array<[number, number, number]> = [];
  const stepX = Math.max(1, Math.floor(width / 96));
  const stepY = Math.max(1, Math.floor(height / 96));

  const pushSample = (x: number, y: number) => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    const i = (cy * width + cx) * 4;
    if (px[i + 3] < 80) return;
    borderSamples.push([px[i], px[i + 1], px[i + 2]]);
  };

  // Dış kenar + hafif içe alınmış çerçeve-sonrası halka:
  // Dışta 2-4px siyah çerçeve çizgisi olan sheet'lerde bile gerçek zemin rengini yakalar.
  const insetX = Math.max(4, Math.min(14, Math.floor(width * 0.025)));
  const insetY = Math.max(4, Math.min(14, Math.floor(height * 0.025)));

  for (let x = 0; x < width; x += stepX) {
    pushSample(x, 0);
    pushSample(x, insetY);
    pushSample(x, insetY + 2);
    pushSample(x, height - 1 - insetY);
    pushSample(x, height - 3 - insetY);
    pushSample(x, height - 1);
  }
  for (let y = 0; y < height; y += stepY) {
    pushSample(0, y);
    pushSample(insetX, y);
    pushSample(insetX + 2, y);
    pushSample(width - 1 - insetX, y);
    pushSample(width - 3 - insetX, y);
    pushSample(width - 1, y);
  }

  // RGB 24-adım kova modu: kenarın %45'i portre/kıyafetle kaplı olsa bile gerçek stüdyo fonunu bulur
  const BIN = 24;
  const buckets = new Map<string, { count: number; rSum: number; gSum: number; bSum: number }>();
  for (const [r, g, b] of borderSamples) {
    const key = `${Math.floor(r / BIN)},${Math.floor(g / BIN)},${Math.floor(b / BIN)}`;
    const cur = buckets.get(key);
    if (cur) {
      cur.count++;
      cur.rSum += r;
      cur.gSum += g;
      cur.bSum += b;
    } else {
      buckets.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
    }
  }

  let modeColor: [number, number, number] = [245, 245, 245];
  let bestCount = -1;
  for (const b of buckets.values()) {
    if (b.count > bestCount) {
      bestCount = b.count;
      modeColor = [Math.round(b.rSum / b.count), Math.round(b.gSum / b.count), Math.round(b.bSum / b.count)];
    }
  }

  // Yalnızca baskın arka plan moduna yakın (inlier) çevre piksellerinden global renk ve MAD hesapla
  const INLIER_DIST = 78;
  const inliers = borderSamples.filter((c) => colorDistManhattan(c, modeColor) <= INLIER_DIST);
  const cleanBorder = inliers.length >= 12 ? inliers : borderSamples;

  const global: [number, number, number] =
    cleanBorder.length > 0
      ? [
          median(cleanBorder.map((c) => c[0])),
          median(cleanBorder.map((c) => c[1])),
          median(cleanBorder.map((c) => c[2])),
        ]
      : modeColor;

  const sampleCorner = (x0: number, y0: number, x1: number, y1: number): [number, number, number] => {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const sx0 = Math.max(0, Math.min(width - 1, Math.floor(x0)));
    const sx1 = Math.max(sx0, Math.min(width - 1, Math.floor(x1)));
    const sy0 = Math.max(0, Math.min(height - 1, Math.floor(y0)));
    const sy1 = Math.max(sy0, Math.min(height - 1, Math.floor(y1)));
    const dx = Math.max(1, Math.floor((sx1 - sx0 + 1) / 8));
    const dy = Math.max(1, Math.floor((sy1 - sy0 + 1) / 8));
    for (let y = sy0; y <= sy1; y += dy) {
      for (let x = sx0; x <= sx1; x += dx) {
        const i = (y * width + x) * 4;
        if (px[i + 3] < 80) continue;
        rs.push(px[i]);
        gs.push(px[i + 1]);
        bs.push(px[i + 2]);
      }
    }
    if (rs.length === 0) return global;
    const candidate: [number, number, number] = [median(rs), median(gs), median(bs)];
    // Köşe bir figür veya portre omuzu tarafından kaplanmışsa (aykırı renk), global fona düş!
    if (colorDistManhattan(candidate, global) > INLIER_DIST) {
      return global;
    }
    return candidate;
  };

  const marginX = Math.max(2, Math.floor(width * 0.035));
  const marginY = Math.max(2, Math.floor(height * 0.035));
  const tl = sampleCorner(0, 0, marginX, marginY);
  const tr = sampleCorner(width - 1 - marginX, 0, width - 1, marginY);
  const bl = sampleCorner(0, height - 1 - marginY, marginX, height - 1);
  const br = sampleCorner(width - 1 - marginX, height - 1 - marginY, width - 1, height - 1);

  // Her satır için sol ve sağ dış kenarlardan aykırı-temizlenmiş dikey stüdyo fon profili
  const rowBg = new Float32Array(height * 3);
  const leftCols = [0, Math.min(width - 1, 2), Math.min(width - 1, Math.floor(width * 0.015))];
  const rightCols = [
    width - 1,
    Math.max(0, width - 3),
    Math.max(0, width - 1 - Math.floor(width * 0.015)),
  ];
  let lastValid: [number, number, number] = [...global];
  for (let y = 0; y < height; y++) {
    const rList: number[] = [];
    const gList: number[] = [];
    const bList: number[] = [];
    for (const x of [...leftCols, ...rightCols]) {
      const i = (y * width + x) * 4;
      if (px[i + 3] < 80) continue;
      const c: [number, number, number] = [px[i], px[i + 1], px[i + 2]];
      if (colorDistManhattan(c, global) <= INLIER_DIST) {
        rList.push(c[0]);
        gList.push(c[1]);
        bList.push(c[2]);
      }
    }
    if (rList.length > 0) {
      lastValid = [median(rList), median(gList), median(bList)];
    }
    rowBg[y * 3] = lastValid[0];
    rowBg[y * 3 + 1] = lastValid[1];
    rowBg[y * 3 + 2] = lastValid[2];
  }

  // Kenar gürültü seviyesini (MAD) yalnızca temiz arka plan örneklerinden hesapla
  const diffs = cleanBorder.map((c) => colorDistManhattan(c, global));
  const bgMad = median(diffs);
  const threshold = Math.max(24, Math.min(48, Math.round(24 + bgMad * 1.9)));

  return { global, tl, tr, bl, br, rowBg, threshold };
}

function foregroundMaskAdaptive(data: ImageData, model: AdaptiveBgModel): Uint8Array {
  const { width, height, data: px } = data;
  const mask = new Uint8Array(width * height);
  const { tl, tr, bl, br, rowBg, threshold } = model;
  const invW = width > 1 ? 1 / (width - 1) : 0;
  const invH = height > 1 ? 1 / (height - 1) : 0;

  for (let y = 0; y < height; y++) {
    const ty = y * invH;
    const itY = 1 - ty;
    const rowBase = y * width;
    const rBgR = rowBg[y * 3];
    const rBgG = rowBg[y * 3 + 1];
    const rBgB = rowBg[y * 3 + 2];

    for (let x = 0; x < width; x++) {
      const p = rowBase + x;
      const i = p * 4;
      if (px[i + 3] < 100) continue;

      const tx = x * invW;
      const itX = 1 - tx;
      const wTL = itX * itY;
      const wTR = tx * itY;
      const wBL = itX * ty;
      const wBR = tx * ty;

      // Köşe bilineer fonu ile satır bazlı dikey stüdyo gradyanını harmanla
      const cornerR = tl[0] * wTL + tr[0] * wTR + bl[0] * wBL + br[0] * wBR;
      const cornerG = tl[1] * wTL + tr[1] * wTR + bl[1] * wBL + br[1] * wBR;
      const cornerB = tl[2] * wTL + tr[2] * wTR + bl[2] * wBL + br[2] * wBR;

      const bgR = cornerR * 0.45 + rBgR * 0.55;
      const bgG = cornerG * 0.45 + rBgG * 0.55;
      const bgB = cornerB * 0.45 + rBgB * 0.55;

      const d = Math.abs(px[i] - bgR) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i + 2] - bgB);
      if (d > threshold) mask[p] = 1;
    }
  }
  return mask;
}

interface RawBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  area: number;
}

/** 2B 8-komşuluklu bağlı bileşen (CCL) tespiti. */
function findConnectedBoxes(grid: Uint8Array, gw: number, gh: number): RawBox[] {
  const visited = new Uint8Array(gw * gh);
  const queue = new Int32Array(gw * gh);
  const boxes: RawBox[] = [];

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const startIdx = y * gw + x;
      if (!grid[startIdx] || visited[startIdx]) continue;

      visited[startIdx] = 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = startIdx;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % gw;
        const cy = (cur - cx) / gw;
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= gh) continue;
          const rowOff = ny * gw;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= gw) continue;
            const nIdx = rowOff + nx;
            if (grid[nIdx] && !visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }
      }

      boxes.push({ minX, maxX, minY, maxY, area });
    }
  }

  return boxes;
}

/**
 * Aynı karaktere ait küçük kopuk parçaları (havada duran şapka, saç, aksesuar, ayak)
 * ana bileşenle birleştirir; ancak iki büyük karakteri asla birleştirmez.
 */
function mergeSmallFragments(boxes: RawBox[], gw: number, gh: number): RawBox[] {
  const totalPixels = gw * gh;
  const minMajorArea = totalPixels * 0.0045;
  const sorted = [...boxes].sort((a, b) => b.area - a.area);
  const major: RawBox[] = [];
  const minor: RawBox[] = [];

  for (const b of sorted) {
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    // Küçük metin başlıklarını ("FRONT", "BACK" vb.) daha baştan ele
    const looksLikeCaption = bh < gh * 0.045 && bw / Math.max(1, bh) > 2.8 && b.area < totalPixels * 0.008;
    if (looksLikeCaption) continue;
    if (b.area >= minMajorArea) {
      major.push({ ...b });
    } else if (b.area >= totalPixels * 0.0005) {
      minor.push(b);
    }
  }

  if (major.length === 0) {
    return boxes.filter((b) => b.area >= totalPixels * 0.0015);
  }

  const gapX = Math.max(3, Math.round(gw * 0.018));
  const gapY = Math.max(3, Math.round(gh * 0.025));

  for (const frag of minor) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < major.length; i++) {
      const m = major[i];
      const dx = Math.max(0, Math.max(m.minX - frag.maxX, frag.minX - m.maxX));
      const dy = Math.max(0, Math.max(m.minY - frag.maxY, frag.minY - m.maxY));
      if (dx <= gapX && dy <= gapY) {
        const d = dx + dy;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0) {
      const m = major[bestIdx];
      m.minX = Math.min(m.minX, frag.minX);
      m.maxX = Math.max(m.maxX, frag.maxX);
      m.minY = Math.min(m.minY, frag.minY);
      m.maxY = Math.max(m.maxY, frag.maxY);
      m.area += frag.area;
    }
  }

  // Birbiriyle %50+ örtüşen kutuları birleştir (örn. iç içe çerçeve/parça)
  const merged: RawBox[] = [];
  for (const box of major) {
    let absorbed = false;
    for (const existing of merged) {
      const ix0 = Math.max(existing.minX, box.minX);
      const iy0 = Math.max(existing.minY, box.minY);
      const ix1 = Math.min(existing.maxX, box.maxX);
      const iy1 = Math.min(existing.maxY, box.maxY);
      if (ix1 > ix0 && iy1 > iy0) {
        const inter = (ix1 - ix0) * (iy1 - iy0);
        const boxRect = (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1);
        const exRect = (existing.maxX - existing.minX + 1) * (existing.maxY - existing.minY + 1);
        if (inter / Math.max(1, Math.min(boxRect, exRect)) > 0.45) {
          existing.minX = Math.min(existing.minX, box.minX);
          existing.maxX = Math.max(existing.maxX, box.maxX);
          existing.minY = Math.min(existing.minY, box.minY);
          existing.maxY = Math.max(existing.maxY, box.maxY);
          existing.area += box.area;
          absorbed = true;
          break;
        }
      }
    }
    if (!absorbed) merged.push(box);
  }

  return merged;
}

/**
 * Birbirine değen veya ince gölgeyle birleşen figürleri dikey/yatay vadi kesimiyle ayırır.
 */
function splitTouchingBoxes(boxes: RawBox[], grid: Uint8Array, gw: number, gh: number): RawBox[] {
  const result: RawBox[] = [];
  const minW = Math.max(8, Math.round(gw * 0.06));
  const minH = Math.max(8, Math.round(gh * 0.08));

  const trySplitAxis = (box: RawBox, axis: 'x' | 'y'): RawBox[] => {
    const bw = box.maxX - box.minX + 1;
    const bh = box.maxY - box.minY + 1;
    const len = axis === 'x' ? bw : bh;
    const otherLen = axis === 'x' ? bh : bw;
    const minSpan = axis === 'x' ? minW : minH;

    if (len < minSpan * 2.2) return [box];
    if (axis === 'x' && !(bw > gw * 0.36 && bw / Math.max(1, bh) > 0.72)) return [box];
    if (axis === 'y' && !(bh > gh * 0.62 && bh / Math.max(1, bw) > 1.35)) return [box];

    const prof = new Int32Array(len);
    for (let y = box.minY; y <= box.maxY; y++) {
      const rowOff = y * gw;
      for (let x = box.minX; x <= box.maxX; x++) {
        if (!grid[rowOff + x]) continue;
        prof[axis === 'x' ? x - box.minX : y - box.minY]++;
      }
    }

    let maxProf = 0;
    for (let i = 0; i < len; i++) {
      if (prof[i] > maxProf) maxProf = prof[i];
    }
    if (maxProf < otherLen * 0.15) return [box];

    // Derin vadi eşiği: profilin %12'sinin altı (hafif değen el/gölge köprüsü)
    const valleyThresh = Math.max(1, Math.floor(maxProf * 0.12));
    const cutPoints: number[] = [];
    let i = minSpan;
    while (i < len - minSpan) {
      if (prof[i] <= valleyThresh) {
        let best = i;
        let j = i;
        while (j < len - minSpan && prof[j] <= valleyThresh) {
          if (prof[j] < prof[best]) best = j;
          j++;
        }
        if (cutPoints.length === 0 || best - cutPoints[cutPoints.length - 1] >= minSpan) {
          cutPoints.push(best);
        }
        i = j + 1;
      } else {
        i++;
      }
    }

    if (cutPoints.length === 0) return [box];

    const cuts = [0, ...cutPoints, len];
    const parts: RawBox[] = [];
    for (let k = 0; k < cuts.length - 1; k++) {
      const s = cuts[k];
      const e = cuts[k + 1] - 1;
      if (e - s + 1 < minSpan) continue;
      let minX = gw;
      let maxX = -1;
      let minY = gh;
      let maxY = -1;
      let area = 0;
      const x0 = axis === 'x' ? box.minX + s : box.minX;
      const x1 = axis === 'x' ? box.minX + e : box.maxX;
      const y0 = axis === 'y' ? box.minY + s : box.minY;
      const y1 = axis === 'y' ? box.minY + e : box.maxY;
      for (let y = y0; y <= y1; y++) {
        const rowOff = y * gw;
        for (let x = x0; x <= x1; x++) {
          if (!grid[rowOff + x]) continue;
          area++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX >= minX && area >= gw * gh * 0.002) {
        parts.push({ minX, maxX, minY, maxY, area });
      }
    }
    return parts.length >= 2 ? parts : [box];
  };

  for (const box of boxes) {
    const hSplit = trySplitAxis(box, 'y');
    for (const part of hSplit) {
      const vSplit = trySplitAxis(part, 'x');
      result.push(...vSplit);
    }
  }
  return result;
}

/**
 * 3, 4, 5, 6, 7+ görselli tüm karakter sheet'lerini 2B bağlı bileşen + vadi ayırıcı ile böler.
 *
 * 1) 4 köşe + kenar tabanlı gradyana uyumlu arka plan modeli çıkarılır.
 * 2) Hızlı çalışma ızgarasında 2B bağlı bileşenler (CCL) bulunur; metin başlıkları elenir.
 * 3) Yapışık/gölgeli figürler derin vadi kesimiyle ayrılır.
 * 4) Hücreler satır bantlarına gruplanır (soldan sağa, yukarıdan aşağıya).
 * 5) Sheet içi göreceli genişlik ve yüz skorlarıyla her hücreye akıllı açı önerilir.
 */
export function detectSheetLayout(data: ImageData, options: SheetSplitOptions = {}): SheetLayout {
  const minSliceRatio = options.minSliceRatio ?? DEFAULT_MIN_SLICE;
  const maxSlices = options.maxSlices ?? 24;
  const { width, height } = data;
  const bgModel = estimateAdaptiveBackground(data);
  const mask = foregroundMaskAdaptive(data, bgModel);

  // Çalışma ızgarasına indirge (en uzun kenar <= 400 px) — OR birleştirme ince hatları korur
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / 400));
  const gw = Math.max(1, Math.ceil(width / scale));
  const gh = Math.max(1, Math.ceil(height / scale));
  const grid = new Uint8Array(gw * gh);

  for (let y = 0; y < height; y++) {
    const gy = Math.floor(y / scale);
    const srcOff = y * width;
    const dstOff = gy * gw;
    for (let x = 0; x < width; x++) {
      if (mask[srcOff + x]) {
        grid[dstOff + Math.floor(x / scale)] = 1;
      }
    }
  }

  const rawBoxes = findConnectedBoxes(grid, gw, gh);
  const mergedBoxes = mergeSmallFragments(rawBoxes, gw, gh);
  const splitBoxes = splitTouchingBoxes(mergedBoxes, grid, gw, gh);

  const minCellW = Math.max(8, Math.floor(width * minSliceRatio * 0.55));
  const minCellH = Math.max(10, Math.floor(height * 0.04));

  // Tam çözünürlüklü maskede her kutuyu sıkılaştır
  const refined: Array<{ x: number; y: number; width: number; height: number; cy: number }> = [];
  for (const b of splitBoxes) {
    const fx0 = Math.max(0, b.minX * scale);
    const fx1 = Math.min(width - 1, (b.maxX + 1) * scale - 1);
    const fy0 = Math.max(0, b.minY * scale);
    const fy1 = Math.min(height - 1, (b.maxY + 1) * scale - 1);

    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let area = 0;
    for (let y = fy0; y <= fy1; y++) {
      const rowOff = y * width;
      for (let x = fx0; x <= fx1; x++) {
        if (!mask[rowOff + x]) continue;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0 || area < width * height * 0.0018) continue;

    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    if (cw < minCellW || ch < minCellH) continue;

    const padX = Math.round(cw * 0.03);
    const padY = Math.round(ch * 0.03);
    const x = Math.max(0, minX - padX);
    const y = Math.max(0, minY - padY);
    const w = Math.min(width, maxX + padX + 1) - x;
    const h = Math.min(height, maxY + padY + 1) - y;
    refined.push({ x, y, width: w, height: h, cy: y + h * 0.5 });
  }

  if (refined.length === 0) {
    return {
      cells: [
        {
          x: 0,
          y: 0,
          width,
          height,
          kind: 'figure',
          faceConfidence: 0,
          row: 0,
          suggestedAngle: 'front',
          suggestionReason: 'yüz algılandı',
        },
      ],
      rows: 1,
      background: bgModel.global,
    };
  }

  // Satır bantlarına grupla (dikey merkez yakınlığına göre) ve soldan sağa sırala
  const sortedByY = [...refined].sort((a, b) => a.cy - b.cy);
  const rowGroups: Array<typeof refined> = [];
  for (const box of sortedByY) {
    const lastGroup = rowGroups[rowGroups.length - 1];
    if (!lastGroup) {
      rowGroups.push([box]);
      continue;
    }
    const groupMinY = Math.min(...lastGroup.map((g) => g.y));
    const groupMaxY = Math.max(...lastGroup.map((g) => g.y + g.height));
    const overlapY = Math.min(groupMaxY, box.y + box.height) - Math.max(groupMinY, box.y);
    const minH = Math.min(groupMaxY - groupMinY, box.height);
    if (overlapY > minH * 0.35) {
      lastGroup.push(box);
    } else {
      rowGroups.push([box]);
    }
  }

  rowGroups.forEach((group) => group.sort((a, b) => a.x - b.x));

  // İlk geçiş: hücreleri kırp ve temel analizleri topla
  interface DraftCell {
    x: number;
    y: number;
    width: number;
    height: number;
    row: number;
    crop: ImageData;
    base: SheetCellAnalysis;
    rawFaceConf: number;
  }

  const drafts: DraftCell[] = [];
  rowGroups.forEach((group, rowIndex) => {
    let narrowInRow = 0;
    for (const box of group) {
      const crop = cropImageData(data, box);
      const face = detectFaceRegion(crop);
      const base = analyzeSheetCell(crop, narrowInRow);
      if (base.suggestionReason === 'dar silüet') narrowInRow++;
      drafts.push({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        row: rowIndex,
        crop,
        base,
        rawFaceConf: face ? face.confidence : 0,
      });
    }
  });

  // İkinci geçiş: sheet içi göreceli genişlik ile kalın/chibi yan görünümleri de yakala
  const figureDrafts = drafts.filter((d) => d.base.kind === 'figure');
  if (figureDrafts.length >= 3) {
    const maxFigW = Math.max(...figureDrafts.map((f) => f.width));
    const medFigH = median(figureDrafts.map((f) => f.height));
    let narrowCounter = 0;

    // Önce en güçlü yüz adayını belirle (stilize karakterlerde 0.08..0.15 arası bile olabilir)
    let bestFrontDraft: DraftCell | null = null;
    for (const f of figureDrafts) {
      const isNarrow =
        f.width / Math.max(1, f.height) <= 0.45 ||
        (f.width <= maxFigW * 0.74 && f.height >= medFigH * 0.75);
      if (!isNarrow && f.rawFaceConf >= 0.08) {
        if (!bestFrontDraft || f.rawFaceConf > bestFrontDraft.rawFaceConf) {
          bestFrontDraft = f;
        }
      }
    }

    for (const f of figureDrafts) {
      const isNarrow =
        f.width / Math.max(1, f.height) <= 0.45 ||
        (f.width <= maxFigW * 0.74 && f.height >= medFigH * 0.75);

      if (isNarrow) {
        f.base = {
          kind: 'figure',
          faceConfidence: 0,
          suggestedAngle: narrowCounter === 0 ? 'right' : 'left',
          suggestionReason: 'dar silüet',
        };
        narrowCounter++;
      } else if (f === bestFrontDraft || f.rawFaceConf >= 0.15) {
        f.base = {
          kind: 'figure',
          faceConfidence: 0,
          suggestedAngle: 'front',
          suggestionReason: 'yüz algılandı',
        };
      } else {
        f.base = {
          kind: 'figure',
          faceConfidence: 0,
          suggestedAngle: 'back',
          suggestionReason: 'yüz yok',
        };
      }
    }
  }

  const cells: SheetCell[] = drafts.slice(0, Math.max(1, maxSlices)).map((d) => ({
    x: d.x,
    y: d.y,
    width: d.width,
    height: d.height,
    kind: d.base.kind,
    faceConfidence: d.base.faceConfidence,
    row: d.row,
    suggestedAngle: d.base.suggestedAngle,
    suggestionReason: d.base.suggestionReason,
  }));

  return { cells, rows: rowGroups.length, background: bgModel.global };
}

/* ------------------------------------------------------------------ *
 * Kenar Enerjisi (Sobel) + Çerçeve Çizgisi Grid-Detection Motoru
 * 3, 5, 7, 8+ görünümlü çizgili/kutulu veya serbest sheet'leri böler,
 * çerçeve çizgilerini kesip kenar boşluğunu kırpar ve 360° slotlara eşler.
 * ------------------------------------------------------------------ */

export type GridDetectionMode = 'framed-grid' | 'edge-components';

export interface GridDetectOptions extends SheetSplitOptions {
  /** Çizgili/kutulu panellerde çerçeve kenarlıklarını kes ve kenar boşluğunu kırp. */
  stripFrames?: boolean;
  /**
   * Çok panelli karakter sheet'lerde yalnızca ana Ön/Yan/Arka turnaround + 1 Ana Yüzü
   * aktif bırakır; metin, palet, kumaş örneği, 15 baş ızgarası ve ek pozları varsayılan dışlar.
   */
  focusedIsolation?: boolean;
}

export interface GridDetectedCell extends SheetCell {
  /** Çerçeve ayıklama öncesi ham panel kutusu. */
  rawBox: SheetSlice;
  /** Kenar çerçeve çizgisi tespit edilip kesildiyse true. */
  frameStripped: boolean;
  /** Hücre içindeki ortalama Sobel kenar yoğunluğu (0..1). */
  edgeDensity: number;
  /** Odaklanmış ayıklama modunda varsayılan olarak dışlanan ek panel. */
  excludedByDefault?: boolean;
  /** Dışlama nedeni (arayüz etiketi). */
  excludeReason?: string;
}

export interface GridDetectionResult {
  mode: GridDetectionMode;
  /** Orijinal görsel koordinatlarında yatay ayırıcı kılavuz çizgileri (px). */
  horizontalLines: number[];
  /** Orijinal görsel koordinatlarında dikey ayırıcı kılavuz çizgileri (px). */
  verticalLines: number[];
  cells: GridDetectedCell[];
  rows: number;
  background: [number, number, number];
}

/**
 * 3×3 Sobel operatörü ile normalize kenar gradyan büyüklüğü haritası üretir (0..255).
 */
export function computeSobelEdgeMap(data: ImageData): Uint8Array {
  const { width, height, data: px } = data;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    gray[p] = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  }
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const r0 = (y - 1) * width;
    const r1 = y * width;
    const r2 = (y + 1) * width;
    for (let x = 1; x < width - 1; x++) {
      const tl = gray[r0 + x - 1];
      const tc = gray[r0 + x];
      const tr = gray[r0 + x + 1];
      const ml = gray[r1 + x - 1];
      const mr = gray[r1 + x + 1];
      const bl = gray[r2 + x - 1];
      const bc = gray[r2 + x];
      const br = gray[r2 + x + 1];

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const mag = Math.min(255, Math.round((Math.abs(gx) + Math.abs(gy)) * 0.25));
      edges[r1 + x] = mag;
    }
  }
  return edges;
}

interface DividerLines {
  horizontal: number[];
  vertical: number[];
  hasOuterBorder: boolean;
}

/**
 * Yatay ve dikey düz panel ayırıcı çizgileri (çerçeve/ızgara kuralları) tespit eder.
 * Gerçek karakter gövdelerini yanlışlıkla çizgi sanmamak için düşük renk sapması ve
 * ince bant kalınlığı (< %3.5) şartı uygular.
 */
function detectStraightDividerLines(
  data: ImageData,
  edgeMap: Uint8Array,
  bgModel: AdaptiveBgModel
): DividerLines {
  const { width, height, data: px } = data;
  const bgLum = luminance(bgModel.global[0], bgModel.global[1], bgModel.global[2]);

  const isLinePixel = (x: number, y: number): boolean => {
    const p = y * width + x;
    const i = p * 4;
    if (px[i + 3] < 80) return false;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const diffBg =
      Math.abs(r - bgModel.global[0]) +
      Math.abs(g - bgModel.global[1]) +
      Math.abs(b - bgModel.global[2]);
    if (diffBg < Math.max(24, bgModel.threshold * 0.85)) return false;
    const lum = luminance(r, g, b);
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    return edgeMap[p] >= 20 || (sat < 48 && Math.abs(lum - bgLum) > 0.14);
  };

  const scanAxis = (axis: 'h' | 'v'): { internal: number[]; outerTouch: boolean } => {
    const primary = axis === 'h' ? height : width;
    const secondary = axis === 'h' ? width : height;
    const step = Math.max(1, Math.floor(secondary / 200));
    const maxBandThick = Math.max(10, Math.floor(primary * 0.032));
    const flags = new Uint8Array(primary);

    for (let a = 0; a < primary; a++) {
      let lineHits = 0;
      let total = 0;
      let lumSum = 0;
      let lumSqSum = 0;
      for (let b = 0; b < secondary; b += step) {
        const x = axis === 'h' ? b : a;
        const y = axis === 'h' ? a : b;
        total++;
        if (isLinePixel(x, y)) {
          lineHits++;
          const idx = (y * width + x) * 4;
          const l = luminance(px[idx], px[idx + 1], px[idx + 2]);
          lumSum += l;
          lumSqSum += l * l;
        }
      }
      const ratio = lineHits / Math.max(1, total);
      // Gerçek çerçeve/ızgara ayırıcı çizgisi tüm kenar boyunca kesintisiz uzanır (>= %86)
      // ve düşük parlaklık sapmasına (<= 0.08) sahiptir; böylece beyaz giysili ayakta figürler
      // asla yanlışlıkla ızgara çizgisi sanılmaz.
      if (ratio >= 0.86 && lineHits >= 12) {
        const meanL = lumSum / lineHits;
        const variance = Math.max(0, lumSqSum / lineHits - meanL * meanL);
        if (Math.sqrt(variance) <= 0.085) {
          flags[a] = 1;
        }
      }
    }

    const internal: number[] = [];
    let outerTouch = false;
    const edgeMargin = Math.max(6, Math.floor(primary * 0.04));
    let start = -1;
    for (let a = 0; a <= primary; a++) {
      const on = a < primary && flags[a] === 1;
      if (on && start === -1) start = a;
      if (!on && start !== -1) {
        const end = a - 1;
        const thick = end - start + 1;
        const center = Math.round((start + end) * 0.5);
        if (thick <= maxBandThick) {
          if (center < edgeMargin || center > primary - 1 - edgeMargin) {
            outerTouch = true;
          } else {
            internal.push(center);
          }
        }
        start = -1;
      }
    }
    return { internal, outerTouch };
  };

  const hRes = scanAxis('h');
  const vRes = scanAxis('v');
  return {
    horizontal: hRes.internal,
    vertical: vRes.internal,
    hasOuterBorder: hRes.outerTouch || vRes.outerTouch,
  };
}

/**
 * Tek bir panel kutusunda dış çerçeve çizgilerini keser, kenar boşluklarını kırpar ve
 * içerideki karakteri sıkı sınırlı bir kutu olarak döndürür.
 */
function stripCellFrameAndTrim(
  data: ImageData,
  rawBox: SheetSlice,
  bgModel: AdaptiveBgModel,
  edgeMap: Uint8Array,
  stripFrames: boolean
): { box: SheetSlice; frameStripped: boolean; edgeDensity: number; fgRatio: number } {
  const { width, height, data: px } = data;
  let x0 = Math.max(0, Math.round(rawBox.x));
  let y0 = Math.max(0, Math.round(rawBox.y));
  let x1 = Math.min(width - 1, Math.round(rawBox.x + rawBox.width - 1));
  let y1 = Math.min(height - 1, Math.round(rawBox.y + rawBox.height - 1));
  let frameStripped = false;

  const isBgPixel = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4;
    if (px[i + 3] < 80) return true;
    const tx = width > 1 ? x / (width - 1) : 0;
    const ty = height > 1 ? y / (height - 1) : 0;
    const wTL = (1 - tx) * (1 - ty);
    const wTR = tx * (1 - ty);
    const wBL = (1 - tx) * ty;
    const wBR = tx * ty;
    const cornerR = bgModel.tl[0] * wTL + bgModel.tr[0] * wTR + bgModel.bl[0] * wBL + bgModel.br[0] * wBR;
    const cornerG = bgModel.tl[1] * wTL + bgModel.tr[1] * wTR + bgModel.bl[1] * wBL + bgModel.br[1] * wBR;
    const cornerB = bgModel.tl[2] * wTL + bgModel.tr[2] * wTR + bgModel.bl[2] * wBL + bgModel.br[2] * wBR;
    const bgR = cornerR * 0.45 + bgModel.rowBg[y * 3] * 0.55;
    const bgG = cornerG * 0.45 + bgModel.rowBg[y * 3 + 1] * 0.55;
    const bgB = cornerB * 0.45 + bgModel.rowBg[y * 3 + 2] * 0.55;
    const d = Math.abs(px[i] - bgR) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i + 2] - bgB);
    return d <= bgModel.threshold && edgeMap[y * width + x] < 24;
  };

  if (stripFrames) {
    const isBorderStripRow = (y: number, sx0: number, sx1: number): boolean => {
      const span = sx1 - sx0 + 1;
      if (span < 8) return false;
      let nonBg = 0;
      let lumSum = 0;
      let lumSq = 0;
      for (let x = sx0; x <= sx1; x++) {
        if (!isBgPixel(x, y)) {
          nonBg++;
          const i = (y * width + x) * 4;
          const l = luminance(px[i], px[i + 1], px[i + 2]);
          lumSum += l;
          lumSq += l * l;
        }
      }
      if (nonBg / span < 0.72) return false;
      const meanL = lumSum / nonBg;
      const std = Math.sqrt(Math.max(0, lumSq / nonBg - meanL * meanL));
      return std <= 0.12;
    };

    const isBorderStripCol = (x: number, sy0: number, sy1: number): boolean => {
      const span = sy1 - sy0 + 1;
      if (span < 8) return false;
      let nonBg = 0;
      let lumSum = 0;
      let lumSq = 0;
      for (let y = sy0; y <= sy1; y++) {
        if (!isBgPixel(x, y)) {
          nonBg++;
          const i = (y * width + x) * 4;
          const l = luminance(px[i], px[i + 1], px[i + 2]);
          lumSum += l;
          lumSq += l * l;
        }
      }
      if (nonBg / span < 0.72) return false;
      const meanL = lumSum / nonBg;
      const std = Math.sqrt(Math.max(0, lumSq / nonBg - meanL * meanL));
      return std <= 0.12;
    };

    // Yalnızca gerçek ince çerçeve çizgilerini (<= 10px kalınlık + arkasında boşluk) kes;
    // kenara taşan omuz/kıyafet portrelerini asla çerçeve sanıp kesme!
    const tryPeelSide = (
      maxPeel: number,
      check: (idx: number) => boolean,
      startIdx: number,
      step: 1 | -1
    ): number => {
      let count = 0;
      while (count < maxPeel && check(startIdx + count * step)) {
        count++;
      }
      // Eğer maxPeel sınırına kadar kesintisiz doluysa bu bir çizgi değil, dolu portre/nesnedir!
      if (count === 0 || count >= maxPeel) return 0;
      return count;
    };

    const maxPeelX = Math.min(12, Math.floor((x1 - x0 + 1) * 0.08));
    const maxPeelY = Math.min(12, Math.floor((y1 - y0 + 1) * 0.08));

    const peelTop = tryPeelSide(maxPeelY, (y) => isBorderStripRow(y, x0, x1), y0, 1);
    const peelBottom = tryPeelSide(maxPeelY, (y) => isBorderStripRow(y, x0, x1), y1, -1);
    const peelLeft = tryPeelSide(maxPeelX, (x) => isBorderStripCol(x, y0, y1), x0, 1);
    const peelRight = tryPeelSide(maxPeelX, (x) => isBorderStripCol(x, y0, y1), x1, -1);

    if (peelTop > 0) { y0 += peelTop; frameStripped = true; }
    if (peelBottom > 0) { y1 -= peelBottom; frameStripped = true; }
    if (peelLeft > 0) { x0 += peelLeft; frameStripped = true; }
    if (peelRight > 0) { x1 -= peelRight; frameStripped = true; }

    if (frameStripped && x1 - x0 > 20 && y1 - y0 > 20) {
      x0 = Math.min(x1 - 8, x0 + 2);
      x1 = Math.max(x0 + 8, x1 - 2);
      y0 = Math.min(y1 - 8, y0 + 2);
      y1 = Math.max(y0 + 8, y1 - 2);
    }
  }

  // Sıkı figür sınır kırpma + kenar yoğunluğu hesabı
  let minX = x1 + 1;
  let maxX = x0 - 1;
  let minY = y1 + 1;
  let maxY = y0 - 1;
  let fgCount = 0;
  let edgeSum = 0;
  const totalPixels = Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1));

  for (let y = y0; y <= y1; y++) {
    const rowOff = y * width;
    for (let x = x0; x <= x1; x++) {
      const e = edgeMap[rowOff + x];
      if (e >= 26) edgeSum++;
      if (!isBgPixel(x, y)) {
        fgCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const fgRatio = fgCount / totalPixels;
  const edgeDensity = edgeSum / totalPixels;

  if (maxX < minX || maxY < minY || !stripFrames) {
    return {
      box: { x: x0, y: y0, width: Math.max(1, x1 - x0 + 1), height: Math.max(1, y1 - y0 + 1) },
      frameStripped,
      edgeDensity,
      fgRatio,
    };
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const padX = Math.max(2, Math.round(bw * 0.025));
  const padY = Math.max(2, Math.round(bh * 0.025));
  const tx0 = Math.max(x0, minX - padX);
  const ty0 = Math.max(y0, minY - padY);
  const tx1 = Math.min(x1, maxX + padX);
  const ty1 = Math.min(y1, maxY + padY);

  return {
    box: { x: tx0, y: ty0, width: Math.max(1, tx1 - tx0 + 1), height: Math.max(1, ty1 - ty0 + 1) },
    frameStripped,
    edgeDensity,
    fgRatio,
  };
}

/**
 * 3, 4, 5, 6, 7, 8+ tam boy figürü 360° turnaround sırasına ve yüz/genişlik ipuçlarına göre
 * 9 desteklenen ViewAngle slotuna benzersiz biçimde atar.
 */
function assign360TurnaroundAngles(
  drafts: Array<{
    kind: SheetCellKind;
    width: number;
    height: number;
    rawFaceConf: number;
    suggestedAngle: ViewAngle;
    suggestionReason: SheetAngleReason;
  }>
): void {
  const figures = drafts.filter((d) => d.kind === 'figure');
  const count = figures.length;
  if (count === 0) return;

  const maxW = Math.max(...figures.map((f) => f.width));
  const medH = median(figures.map((f) => f.height));

  // 1–4 görünümlü klasik turnaround'larda akıllı ve deterministik eşleme
  // Not: Gerçekçi insan tam boy ön/arka görünümlerinin en/boy oranı ~0.28–0.36 olabilir;
  // bu nedenle iki benzer genişlikte figürü "dar silüet" (sağ/sol) sanmamak için göreceli genişlik kontrol edilir.
  if (count === 1) {
    figures[0].suggestedAngle = 'front';
    return;
  }

  if (count === 2) {
    const [a, b] = figures;
    const minW = Math.min(a.width, b.width);
    const ratioW = minW / Math.max(1, maxW);
    if (ratioW <= 0.74) {
      // Biri belirgin şekilde dar → geniş olan front, dar olan right
      const wider = a.width >= b.width ? a : b;
      const narrower = wider === a ? b : a;
      wider.suggestedAngle = 'front';
      wider.suggestionReason = wider.rawFaceConf >= 0.12 ? 'yüz algılandı' : '3/4 turnaround';
      narrower.suggestedAngle = 'right';
      narrower.suggestionReason = 'dar silüet';
    } else {
      // Benzer genişlikte iki tam boy figür → turnaround standardı: soldaki Ön (0°), sağdaki Arka (180°)
      // (Başsız veya yüzü bantlı ön pozlarda arka pozun ense derisi yanlışlıkla ön sanılmaz.)
      a.suggestedAngle = 'front';
      a.suggestionReason = a.rawFaceConf >= 0.15 ? 'yüz algılandı' : '3/4 turnaround';
      b.suggestedAngle = 'back';
      b.suggestionReason = 'yüz yok';
    }
    return;
  }

  if (count <= 4) {
    const order: ViewAngle[] =
      count === 3 ? ['front', 'right', 'back'] : ['front', 'right', 'back', 'left'];

    // Göreceli olarak gerçekten dar (yan) olan figürleri işaretle
    const narrowFlags = figures.map(
      (f) => f.width <= maxW * 0.75 && f.height >= medH * 0.72
    );
    const narrowCount = narrowFlags.filter(Boolean).length;

    if (narrowCount >= 1 && narrowCount <= 2) {
      // Gerçek dar figürler yan (right / left), geniş figürler front / back
      let sideIdx = 0;
      const wideIndices: number[] = [];
      figures.forEach((f, idx) => {
        if (narrowFlags[idx]) {
          f.suggestedAngle = sideIdx === 0 ? 'right' : 'left';
          f.suggestionReason = 'dar silüet';
          sideIdx++;
        } else {
          wideIndices.push(idx);
        }
      });

      if (wideIndices.length > 0) {
        let frontWideIdx = wideIndices[0];
        let bestFace = figures[frontWideIdx].rawFaceConf;
        for (const wi of wideIndices) {
          if (figures[wi].rawFaceConf > bestFace + 0.08) {
            bestFace = figures[wi].rawFaceConf;
            frontWideIdx = wi;
          }
        }
        figures[frontWideIdx].suggestedAngle = 'front';
        figures[frontWideIdx].suggestionReason =
          figures[frontWideIdx].rawFaceConf >= 0.12 ? 'yüz algılandı' : '3/4 turnaround';
        const remainingAngles: ViewAngle[] = (['back', 'left', 'right'] as ViewAngle[]).filter(
          (a) => !figures.some((f) => f.suggestedAngle === a)
        );
        let remPtr = 0;
        for (const wi of wideIndices) {
          if (wi === frontWideIdx) continue;
          figures[wi].suggestedAngle = remainingAngles[remPtr++] ?? 'back';
          figures[wi].suggestionReason = figures[wi].suggestedAngle === 'back' ? 'yüz yok' : '3/4 turnaround';
        }
      }
      return;
    }

    // Hepsi benzer genişlikteyse soldan sağa deterministik turnaround sırası
    figures.forEach((f, idx) => {
      f.suggestedAngle = order[idx] ?? 'front';
      if (f.suggestedAngle === 'front') {
        f.suggestionReason = f.rawFaceConf >= 0.12 ? 'yüz algılandı' : '3/4 turnaround';
      } else if (f.suggestedAngle === 'back') {
        f.suggestionReason = 'yüz yok';
      } else {
        f.suggestionReason = '3/4 turnaround';
      }
    });
    return;
  }

  // 5+ görünümlü gelişmiş turnaround:
  // Üstten görünüm adayı var mı? (geniş en-boy oranı ve kısa boy)
  let topCandidateIdx = -1;
  if (count >= 5) {
    for (let i = 0; i < figures.length; i++) {
      const f = figures[i];
      if (f.width / Math.max(1, f.height) >= 1.4 && f.height <= medH * 0.72) {
        topCandidateIdx = i;
        break;
      }
    }
  }

  const turnaroundOrderByCount = (n: number): ViewAngle[] => {
    if (n === 5) return ['front', 'frontRight', 'right', 'back', 'left'];
    if (n === 6) return ['front', 'frontRight', 'right', 'backRight', 'back', 'left'];
    if (n === 7) return ['front', 'frontRight', 'right', 'backRight', 'back', 'backLeft', 'left'];
    return ['front', 'frontRight', 'right', 'backRight', 'back', 'backLeft', 'left', 'frontLeft', 'top'];
  };

  const remainingFigs = figures.filter((_, idx) => idx !== topCandidateIdx);
  const ringOrder = turnaroundOrderByCount(remainingFigs.length);

  // En güçlü ön yüz adayını (front) bularak halka başlangıcını doğru figüre sabitle
  let frontIdx = 0;
  let bestFrontScore = -1;
  remainingFigs.forEach((f, idx) => {
    const isNarrow = f.width / Math.max(1, f.height) <= 0.45 || f.width <= maxW * 0.72;
    const score = (isNarrow ? 0 : 0.2) + f.rawFaceConf * 2 + (idx === 0 ? 0.12 : 0);
    if (score > bestFrontScore) {
      bestFrontScore = score;
      frontIdx = idx;
    }
  });

  for (let offset = 0; offset < remainingFigs.length; offset++) {
    const fig = remainingFigs[(frontIdx + offset) % remainingFigs.length];
    const angle = ringOrder[Math.min(offset, ringOrder.length - 1)];
    fig.suggestedAngle = angle;
    if (
      angle === 'frontRight' ||
      angle === 'backRight' ||
      angle === 'backLeft' ||
      angle === 'frontLeft'
    ) {
      fig.suggestionReason = '3/4 turnaround';
    } else if (angle === 'right' || angle === 'left') {
      fig.suggestionReason = fig.width <= maxW * 0.76 ? 'dar silüet' : '3/4 turnaround';
    } else if (angle === 'front') {
      fig.suggestionReason = fig.rawFaceConf >= 0.1 ? 'yüz algılandı' : '3/4 turnaround';
    } else if (angle === 'back') {
      fig.suggestionReason = 'yüz yok';
    }
  }

  if (topCandidateIdx >= 0) {
    figures[topCandidateIdx].suggestedAngle = 'top';
    figures[topCandidateIdx].suggestionReason = '3/4 turnaround';
  }
}

/**
 * Metin bloğu, ölçek cetveli, renk paleti veya kenardan kenara kumaş/doku örneği gibi
 * karakter gövdesi olmayan yardımcı sheet panellerini ayırt eder.
 */
function detectUtilityPanelReason(
  crop: ImageData,
  edgeDensity: number,
  rawFaceConf: number,
  sheetW: number,
  sheetH: number
): string | null {
  const { width, height, data: px } = crop;
  if (width < 12 || height < 12) return 'küçük parça';
  const aspect = width / Math.max(1, height);

  // 1) Çok ince ölçek cetveli veya kenar şeridi
  if (aspect < 0.085 && height > sheetH * 0.18) {
    return 'ölçek cetveli';
  }

  // Arka plan rengi (köşe medyanı) ve ön plan / kenar doluluk oranları
  const samplePx = (x: number, y: number): [number, number, number] => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    const i = (cy * width + cx) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const corners = [
    samplePx(1, 1),
    samplePx(width - 2, 1),
    samplePx(1, height - 2),
    samplePx(width - 2, height - 2),
  ];
  const bgR = median(corners.map((c) => c[0]));
  const bgG = median(corners.map((c) => c[1]));
  const bgB = median(corners.map((c) => c[2]));

  let fgCount = 0;
  let borderNonLight = 0;
  let borderTotal = 0;
  const rowHasInk = new Uint8Array(height);
  const stepX = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 120));
  let sampled = 0;

  for (let y = 0; y < height; y += stepY) {
    let rowInk = 0;
    let rowSamples = 0;
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const diff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
      sampled++;
      rowSamples++;
      if (diff > 36) {
        fgCount++;
        rowInk++;
      }
      if (y === 0 || y + stepY >= height || x === 0 || x + stepX >= width) {
        borderTotal++;
        if (luminance(r, g, b) < 0.82) borderNonLight++;
      }
    }
    if (rowSamples > 0 && rowInk / rowSamples > 0.04 && rowInk / rowSamples < 0.72) {
      rowHasInk[y] = 1;
    }
  }
  const fgRatio = fgCount / Math.max(1, sampled);
  const borderFill = borderNonLight / Math.max(1, borderTotal);

  // 2) Yatay metin/not satırları (CHARACTER OVERVIEW, NOTES, başlık blokları)
  let textBands = 0;
  let inBand = false;
  let bandLen = 0;
  for (let y = 0; y < height; y += stepY) {
    if (rowHasInk[y]) {
      if (!inBand) {
        inBand = true;
        bandLen = stepY;
      } else {
        bandLen += stepY;
      }
    } else if (inBand) {
      if (bandLen <= Math.max(14, sheetH * 0.045)) textBands++;
      inBand = false;
    }
  }
  if (textBands >= 6 && fgRatio < 0.34 && rawFaceConf < 0.14) {
    return 'metin/not paneli';
  }

  // 3) Kenardan kenara dolu kumaş/doku veya renk paleti örneği (portre olmayan)
  if (borderFill > 0.88 && rawFaceConf < 0.10 && height < sheetH * 0.42 && aspect > 0.42) {
    return 'doku/renk paleti';
  }
  if (edgeDensity < 0.018 && fgRatio < 0.45 && rawFaceConf < 0.12 && height < sheetH * 0.38) {
    return 'renk paleti';
  }

  return null;
}

/**
 * Geniş çerçeveli bir panel (örn. KAIA VIRE "FULL BODY TURNAROUND" kutusu) içinde
 * yan yana duran 2–6 figür varsa alt bileşenlerine ayırır.
 */
function trySubSplitWideBox(
  data: ImageData,
  rawBox: SheetSlice,
  cropBox: SheetSlice,
  row: number,
  bgModel: AdaptiveBgModel,
  edgeMap: Uint8Array,
  stripFrames: boolean
): Array<{
  rawBox: SheetSlice;
  cropBox: SheetSlice;
  row: number;
  frameStripped: boolean;
  edgeDensity: number;
}> | null {
  const aspect = cropBox.width / Math.max(1, cropBox.height);
  if (aspect < 1.18 || cropBox.width < data.width * 0.24 || cropBox.height < data.height * 0.24) {
    return null;
  }

  // Üst/alt metin başlığı varsa ("FULL BODY TURNAROUND", "FRONT / SIDE / BACK") kaba şeridi kırpmadan önce alt düzeni çöz
  const subCrop = cropImageData(data, cropBox);
  const subLayout = detectSheetLayout(subCrop, {
    minSliceRatio: 0.05,
    maxSlices: 10,
  });
  if (subLayout.cells.length < 2) return null;

  const tallSubs = subLayout.cells.filter(
    (c) => c.height >= cropBox.height * 0.42 && c.width >= cropBox.width * 0.06
  );
  if (tallSubs.length < 2) return null;

  const results: Array<{
    rawBox: SheetSlice;
    cropBox: SheetSlice;
    row: number;
    frameStripped: boolean;
    edgeDensity: number;
  }> = [];

  for (const sc of subLayout.cells) {
    // Çok ince cetvel veya küçük alt yazı etiketlerini atla
    if (sc.height < cropBox.height * 0.16) continue;
    if (sc.width / Math.max(1, sc.height) < 0.075) continue;
    const absBox: SheetSlice = {
      x: cropBox.x + sc.x,
      y: cropBox.y + sc.y,
      width: sc.width,
      height: sc.height,
    };
    const trimmed = stripCellFrameAndTrim(data, absBox, bgModel, edgeMap, stripFrames);
    if (trimmed.fgRatio < 0.02) continue;
    results.push({
      rawBox: absBox,
      cropBox: stripFrames ? trimmed.box : absBox,
      row: row * 10 + sc.row,
      frameStripped: true,
      edgeDensity: trimmed.edgeDensity,
    });
  }

  return results.length >= 2 ? results : null;
}

/**
 * Kenar analizi (Sobel) + düz çerçeve çizgisi algılama + 2B bağlı bileşen tabanlı
 * evrensel Karakter Sheet Grid-Detection fonksiyonu.
 *
 * 3, 5, 7, 8+ görünümlü çizgili/kutulu veya serbest turnaround sheet'lerini otomatik algılar,
 * çerçeve çizgilerini keser, kenar boşluğunu kırpar ve her görünümü ilgili 360° slota eşler.
 */
export function detectCharacterSheetGrid(
  data: ImageData,
  options: GridDetectOptions = {}
): GridDetectionResult {
  const maxSlices = options.maxSlices ?? 24;
  const stripFrames = options.stripFrames !== false;
  const focusedIsolation = options.focusedIsolation === true;
  const { width, height } = data;
  const bgModel = estimateAdaptiveBackground(data);
  const edgeMap = computeSobelEdgeMap(data);
  const dividers = detectStraightDividerLines(data, edgeMap, bgModel);

  const hasInternalGrid = dividers.horizontal.length > 0 || dividers.vertical.length > 0;
  let mode: GridDetectionMode = 'edge-components';
  let horizontalLines: number[] = [];
  let verticalLines: number[] = [];

  interface CandidateCell {
    rawBox: SheetSlice;
    cropBox: SheetSlice;
    row: number;
    frameStripped: boolean;
    edgeDensity: number;
  }

  let candidates: CandidateCell[] = [];

  // 1) Çizgili/kutulu ızgara modu (framed-grid)
  if (hasInternalGrid) {
    const xs = [0, ...dividers.vertical, width];
    const ys = [0, ...dividers.horizontal, height];
    const framed: CandidateCell[] = [];

    for (let r = 0; r < ys.length - 1; r++) {
      const cy0 = ys[r];
      const cy1 = ys[r + 1];
      if (cy1 - cy0 < Math.max(20, height * 0.08)) continue;
      for (let c = 0; c < xs.length - 1; c++) {
        const cx0 = xs[c];
        const cx1 = xs[c + 1];
        if (cx1 - cx0 < Math.max(20, width * 0.06)) continue;
        const rawBox: SheetSlice = { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 };
        const trimmed = stripCellFrameAndTrim(data, rawBox, bgModel, edgeMap, stripFrames);
        // Boş veya yalnızca küçük metin etiketi içeren hücreleri atla
        const cellArea = trimmed.box.width * trimmed.box.height;
        if (trimmed.fgRatio < 0.015 || cellArea < width * height * 0.0025) continue;
        if (trimmed.box.height < height * 0.05 && trimmed.box.width / Math.max(1, trimmed.box.height) > 3.2) {
          continue;
        }
        // Geniş çerçeveli panel içinde birden fazla turnaround figürü varsa (örn. KAIA VIRE) alt bölümlere ayır
        const subCells = trySubSplitWideBox(data, rawBox, trimmed.box, r, bgModel, edgeMap, stripFrames);
        if (subCells && subCells.length >= 2) {
          framed.push(...subCells);
        } else {
          framed.push({
            rawBox,
            cropBox: trimmed.box,
            row: r,
            frameStripped: trimmed.frameStripped || true,
            edgeDensity: trimmed.edgeDensity,
          });
        }
      }
    }

    if (framed.length >= 2) {
      mode = 'framed-grid';
      horizontalLines = dividers.horizontal;
      verticalLines = dividers.vertical;
      candidates = framed;
    }
  }

  // 2) Serbest / çerçevesiz veya dış çerçeveli sheet'ler için kenar destekli 2B bileşen modu
  if (candidates.length === 0) {
    mode = 'edge-components';
    let workData = data;
    let offX = 0;
    let offY = 0;
    if (dividers.hasOuterBorder && stripFrames && width > 40 && height > 40) {
      const inset = stripCellFrameAndTrim(
        data,
        { x: 0, y: 0, width, height },
        bgModel,
        edgeMap,
        true
      );
      if (inset.frameStripped && inset.box.width > width * 0.5 && inset.box.height > height * 0.5) {
        workData = cropImageData(data, inset.box);
        offX = inset.box.x;
        offY = inset.box.y;
      }
    }

    const layout = detectSheetLayout(workData, {
      minSliceRatio: options.minSliceRatio,
      figureRatioThreshold: options.figureRatioThreshold,
      maxSlices,
    });

    candidates = [];
    for (const cell of layout.cells) {
      const rawBox: SheetSlice = {
        x: cell.x + offX,
        y: cell.y + offY,
        width: cell.width,
        height: cell.height,
      };
      const trimmed = stripCellFrameAndTrim(data, rawBox, bgModel, edgeMap, stripFrames);
      const effectiveBox = stripFrames ? trimmed.box : rawBox;
      const subCells = trySubSplitWideBox(data, rawBox, effectiveBox, cell.row, bgModel, edgeMap, stripFrames);
      if (subCells && subCells.length >= 2) {
        candidates.push(...subCells);
      } else {
        candidates.push({
          rawBox,
          cropBox: effectiveBox,
          row: cell.row,
          frameStripped: trimmed.frameStripped || offX > 0 || offY > 0,
          edgeDensity: trimmed.edgeDensity,
        });
      }
    }

    // Görsel overlay için satır ve sütunlar arasındaki doğal kılavuz çizgilerini çıkar
    const rowMap = new Map<number, CandidateCell[]>();
    for (const c of candidates) {
      const arr = rowMap.get(c.row) ?? [];
      arr.push(c);
      rowMap.set(c.row, arr);
    }
    const rowIndices = Array.from(rowMap.keys()).sort((a, b) => a - b);
    for (let i = 0; i + 1 < rowIndices.length; i++) {
      const cur = rowMap.get(rowIndices[i])!;
      const next = rowMap.get(rowIndices[i + 1])!;
      const curBottom = Math.max(...cur.map((c) => c.cropBox.y + c.cropBox.height));
      const nextTop = Math.min(...next.map((c) => c.cropBox.y));
      if (nextTop > curBottom) {
        horizontalLines.push(Math.round((curBottom + nextTop) * 0.5));
      }
    }
    const primaryRow = rowMap.get(rowIndices[0] ?? 0) ?? [];
    const sortedCols = [...primaryRow].sort((a, b) => a.cropBox.x - b.cropBox.x);
    for (let i = 0; i + 1 < sortedCols.length; i++) {
      const rightEdge = sortedCols[i].cropBox.x + sortedCols[i].cropBox.width;
      const nextLeft = sortedCols[i + 1].cropBox.x;
      if (nextLeft > rightEdge) {
        verticalLines.push(Math.round((rightEdge + nextLeft) * 0.5));
      }
    }
  }

  // 3) Hücre içeriğini analiz et (yüz yakın çekimi + figür + yardımcı panel tespiti)
  interface EnrichedDraft {
    rawBox: SheetSlice;
    cropBox: SheetSlice;
    row: number;
    frameStripped: boolean;
    edgeDensity: number;
    kind: SheetCellKind;
    faceConfidence: number;
    rawFaceConf: number;
    suggestedAngle: ViewAngle;
    suggestionReason: SheetAngleReason;
    width: number;
    height: number;
    excludedByDefault: boolean;
    excludeReason?: string;
  }

  let narrowInRow = 0;
  let lastRow = -1;
  const drafts: EnrichedDraft[] = candidates.slice(0, Math.max(1, maxSlices)).map((cand) => {
    if (cand.row !== lastRow) {
      narrowInRow = 0;
      lastRow = cand.row;
    }
    const crop = cropImageData(data, cand.cropBox);
    const face = detectFaceRegion(crop);
    const analysis = analyzeSheetCell(crop, narrowInRow);
    const rawFaceConf = face ? face.confidence : 0;
    const utilityReason = detectUtilityPanelReason(crop, cand.edgeDensity, rawFaceConf, width, height);
    if (analysis.suggestionReason === 'dar silüet') narrowInRow++;
    return {
      rawBox: cand.rawBox,
      cropBox: cand.cropBox,
      row: cand.row,
      frameStripped: cand.frameStripped,
      edgeDensity: cand.edgeDensity,
      kind: analysis.kind,
      faceConfidence: analysis.faceConfidence,
      rawFaceConf,
      suggestedAngle: analysis.suggestedAngle,
      suggestionReason: mode === 'framed-grid' && analysis.kind === 'figure' ? 'çerçeveli ızgara' : analysis.suggestionReason,
      width: cand.cropBox.width,
      height: cand.cropBox.height,
      excludedByDefault: focusedIsolation && utilityReason !== null,
      excludeReason: focusedIsolation && utilityReason ? utilityReason : undefined,
    };
  });

  // 4) Odaklanmış Ayıklama: Sadece Ana Ön/Yan/Arka Turnaround + 1 Ana Yüzü aktif bırak
  if (focusedIsolation) {
    const activeFigures = drafts.filter((d) => d.kind === 'figure' && !d.excludedByDefault);
    if (activeFigures.length > 0) {
      const maxFigH = Math.max(...activeFigures.map((f) => f.height));
      // Ana turnaround adayları: en uzun ayakta duran figürlerin boyunun >= %72'si
      const tallGroup = activeFigures.filter(
        (f) => f.height >= maxFigH * 0.72 && f.width / Math.max(1, f.height) <= 1.05
      );

      // Eğer belirgin bir uzun turnaround sırası (2-5 figür) + daha kısa ek poz/aksesuar panelleri varsa
      if (tallGroup.length >= 2) {
        const tallSet = new Set(tallGroup);
        for (const f of activeFigures) {
          if (!tallSet.has(f)) {
            f.excludedByDefault = true;
            f.excludeReason = 'ek poz / detay';
          }
        }
        // Aynı yükseklik bandında 4'ten fazla figür varsa en baskın turnaround grubunu (ilk 4) tut
        if (tallGroup.length > 4) {
          // Aynı dikey Y bandında kümelenen en büyük grubu seç
          const sortedByY = [...tallGroup].sort((a, b) => a.cropBox.y - b.cropBox.y);
          const anchorY = sortedByY[0].cropBox.y;
          const primaryBand = tallGroup
            .filter((f) => Math.abs(f.cropBox.y - anchorY) <= maxFigH * 0.35)
            .sort((a, b) => a.cropBox.x - b.cropBox.x);
          const keepSet = new Set(primaryBand.slice(0, 4));
          for (const f of tallGroup) {
            if (!keepSet.has(f)) {
              f.excludedByDefault = true;
              f.excludeReason = 'ek turnaround açısı';
            }
          }
        }
      }
    }

    // Yüz portreleri arasından yalnızca EN İYİ 1 ana ön yüzü aktif tut (15 baş ızgarası / yan profil başlar dışlanır)
    const activeFaces = drafts.filter((d) => d.kind === 'face' && !d.excludedByDefault);
    if (activeFaces.length > 1) {
      let bestFace = activeFaces[0];
      let bestScore = -1;
      const maxFaceArea = Math.max(...activeFaces.map((f) => f.width * f.height));
      for (const f of activeFaces) {
        const areaNorm = (f.width * f.height) / Math.max(1, maxFaceArea);
        const aspect = f.width / Math.max(1, f.height);
        const uprightBonus = aspect >= 0.65 && aspect <= 1.35 ? 0.25 : 0;
        const score = f.faceConfidence * 1.4 + areaNorm * 0.7 + uprightBonus;
        if (score > bestScore) {
          bestScore = score;
          bestFace = f;
        }
      }
      for (const f of activeFaces) {
        if (f !== bestFace) {
          f.excludedByDefault = true;
          f.excludeReason = 'ek yüz açısı';
        }
      }
    }
  }

  // Aktif figürlere 360° açıları (Ön / Yan / Arka / 3/4) deterministik ata
  const activeDrafts = focusedIsolation
    ? drafts.filter((d) => !d.excludedByDefault)
    : drafts;
  assign360TurnaroundAngles(activeDrafts);

  const uniqueRows = new Set(drafts.map((d) => d.row)).size || 1;
  const cells: GridDetectedCell[] = drafts.map((d) => ({
    x: d.cropBox.x,
    y: d.cropBox.y,
    width: d.cropBox.width,
    height: d.cropBox.height,
    rawBox: d.rawBox,
    frameStripped: d.frameStripped,
    edgeDensity: Number(d.edgeDensity.toFixed(3)),
    kind: d.kind,
    faceConfidence: d.faceConfidence,
    row: d.row,
    suggestedAngle: d.suggestedAngle,
    suggestionReason: d.suggestionReason,
    excludedByDefault: d.excludedByDefault,
    excludeReason: d.excludeReason,
  }));

  return {
    mode,
    horizontalLines,
    verticalLines,
    cells,
    rows: uniqueRows,
    background: bgModel.global,
  };
}

/* ------------------------------------------------------------------ *
 * Etkileşimli Manuel Kutu Düzenleme Yardımcıları
 * (Taşıma, 8 Tutamaçlı Boyutlandırma, Fareyle Çizim ve Sınır Kilidi)
 * ------------------------------------------------------------------ */

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Bir kutuyu görüntü sınırları içine ve minimum boyut eşiğine kenetler. */
export function clampBoxToBounds(
  box: SheetSlice,
  boundsW: number,
  boundsH: number,
  minSize = 16
): SheetSlice {
  const safeBoundsW = Math.max(1, Math.round(boundsW));
  const safeBoundsH = Math.max(1, Math.round(boundsH));
  const effMinW = Math.min(minSize, safeBoundsW);
  const effMinH = Math.min(minSize, safeBoundsH);

  const width = Math.max(effMinW, Math.min(safeBoundsW, Math.round(box.width)));
  const height = Math.max(effMinH, Math.min(safeBoundsH, Math.round(box.height)));
  const x = Math.max(0, Math.min(safeBoundsW - width, Math.round(box.x)));
  const y = Math.max(0, Math.min(safeBoundsH - height, Math.round(box.y)));

  return { x, y, width, height };
}

/** Bir kutuyu boyutunu bozmadan görüntü sınırları içinde taşır. */
export function moveSheetBox(
  box: SheetSlice,
  dx: number,
  dy: number,
  boundsW: number,
  boundsH: number
): SheetSlice {
  const width = Math.max(1, Math.min(Math.round(boundsW), Math.round(box.width)));
  const height = Math.max(1, Math.min(Math.round(boundsH), Math.round(box.height)));
  const x = Math.max(0, Math.min(Math.round(boundsW) - width, Math.round(box.x + dx)));
  const y = Math.max(0, Math.min(Math.round(boundsH) - height, Math.round(box.y + dy)));
  return { x, y, width, height };
}

/**
 * Bir kutuyu 8 köşe/kenar tutamacından biriyle boyutlandırır; karşı kenarı sabit tutar,
 * minimum boyutu korur ve görüntü dışına taşmayı engeller.
 */
export function resizeSheetBox(
  box: SheetSlice,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  boundsW: number,
  boundsH: number,
  minSize = 16
): SheetSlice {
  const safeBoundsW = Math.max(1, Math.round(boundsW));
  const safeBoundsH = Math.max(1, Math.round(boundsH));
  const effMinW = Math.min(minSize, safeBoundsW);
  const effMinH = Math.min(minSize, safeBoundsH);

  let x0 = Math.round(box.x);
  let y0 = Math.round(box.y);
  let x1 = Math.round(box.x + box.width);
  let y1 = Math.round(box.y + box.height);

  if (handle.includes('w')) {
    x0 = Math.max(0, Math.min(x1 - effMinW, Math.round(box.x + dx)));
  }
  if (handle.includes('e')) {
    x1 = Math.min(safeBoundsW, Math.max(x0 + effMinW, Math.round(box.x + box.width + dx)));
  }
  if (handle.includes('n')) {
    y0 = Math.max(0, Math.min(y1 - effMinH, Math.round(box.y + dy)));
  }
  if (handle.includes('s')) {
    y1 = Math.min(safeBoundsH, Math.max(y0 + effMinH, Math.round(box.y + box.height + dy)));
  }

  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  };
}

/** İki sürükleme noktasından normalize ve sınırlanmış bir seçim kutusu üretir. */
export function boxFromDragPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  boundsW: number,
  boundsH: number
): SheetSlice {
  const safeW = Math.max(1, Math.round(boundsW));
  const safeH = Math.max(1, Math.round(boundsH));
  const sx = Math.max(0, Math.min(safeW, startX));
  const sy = Math.max(0, Math.min(safeH, startY));
  const ex = Math.max(0, Math.min(safeW, endX));
  const ey = Math.max(0, Math.min(safeH, endY));

  const x = Math.round(Math.min(sx, ex));
  const y = Math.round(Math.min(sy, ey));
  const x2 = Math.round(Math.max(sx, ex));
  const y2 = Math.round(Math.max(sy, ey));

  return {
    x,
    y,
    width: Math.max(0, x2 - x),
    height: Math.max(0, y2 - y),
  };
}

/** '+ Kutu Ekle' butonu için görsel ortasında kademeli konumlandırılmış yeni kutu üretir. */
export function createCenteredDefaultBox(
  boundsW: number,
  boundsH: number,
  existingCount = 0
): SheetSlice {
  const w = Math.max(24, Math.round(boundsW * 0.24));
  const h = Math.max(24, Math.round(boundsH * 0.56));
  const step = existingCount % 5;
  const offsetX = (step - 2) * Math.round(boundsW * 0.035);
  const offsetY = (step - 2) * Math.round(boundsH * 0.025);
  const cx = Math.round((boundsW - w) * 0.5) + offsetX;
  const cy = Math.round((boundsH - h) * 0.5) + offsetY;
  return clampBoxToBounds({ x: cx, y: cy, width: w, height: h }, boundsW, boundsH, 24);
}

