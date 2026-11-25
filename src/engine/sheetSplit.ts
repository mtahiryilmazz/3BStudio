/**
 * Karakter sheet (turnaround) bölücü.
 *
 * Bir karakter sheet görselindeki dikey boşluk (gutter) sütunlarını bulup
 * görüntüyü alt bölmelere ayırır: front / side / back kolonları tipik olarak
 * düz arka plan şeritleriyle ayrılır. Saf piksel matematiği; DOM yok.
 */

import { detectFaceRegion } from './faceDetect';

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
const DEFAULT_MAX_SLICES = 6;

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

  // Kenarlardan arka plan rengini öğren (sheet'lerde kenar her zaman boştur).
  const edgeSamples: Array<[number, number, number]> = [];
  const sampleStep = Math.max(1, Math.floor(height / 32));
  for (let y = 0; y < height; y += sampleStep) {
    for (const x of [0, 1, width - 2, width - 1]) {
      const i = (y * width + x) * 4;
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

  // Figür içeren sütun kümelerini (run) bul.
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
    // En geniş maxSlices dilimi koru, x'e göre sırala.
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
  const w = Math.max(1, Math.min(slice.width, data.width - slice.x));
  const h = Math.max(1, Math.min(slice.height, data.height - slice.y));
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const srcStart = ((slice.y + y) * data.width + slice.x) * 4;
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
 * 2B ızgara düzeni: çok satırlı sheet'ler (tam boy + yüz panelleri)
 * ------------------------------------------------------------------ */

export type SheetCellKind = 'figure' | 'face';

export interface SheetCell extends SheetSlice {
  /** 'figure' = tam boy/nesne görünümü, 'face' = yüz yakın çekimi. */
  kind: SheetCellKind;
  /** Yüz ise algılama güveni (0..1); figure için 0. */
  faceConfidence: number;
  /** Hücrenin satır bandı indeksi (üstten 0). */
  row: number;
  /** İçerikten çıkarılan açı önerisi (yüz yok → arka, dar → yan). */
  suggestedAngle: 'front' | 'right' | 'back' | 'left' | 'top';
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

/** Kenar piksellerinin medyanından arka plan rengini tahmin eder. */
function estimateBackground(data: ImageData): [number, number, number] {
  const { width, height, data: px } = data;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const step = Math.max(1, Math.floor(Math.max(width, height) / 64));
  for (let x = 0; x < width; x += step) {
    for (const y of [0, 1, height - 2, height - 1]) {
      const i = (y * width + x) * 4;
      rs.push(px[i]);
      gs.push(px[i + 1]);
      bs.push(px[i + 2]);
    }
  }
  for (let y = 0; y < height; y += step) {
    for (const x of [0, 1, width - 2, width - 1]) {
      const i = (y * width + x) * 4;
      rs.push(px[i]);
      gs.push(px[i + 1]);
      bs.push(px[i + 2]);
    }
  }
  return [median(rs), median(gs), median(bs)];
}

function foregroundMask(data: ImageData, bg: [number, number, number]): Uint8Array {
  const { width, height, data: px } = data;
  const mask = new Uint8Array(width * height);
  const threshold = 26;
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    if (px[i + 3] < 100) continue;
    const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
    if (d > threshold) mask[p] = 1;
  }
  return mask;
}

interface Span {
  start: number;
  end: number;
}

/** Verilen eksende boş olmayan (içerikli) bantları döndürür. */
function contentSpans(counts: Int32Array, length: number, gutterMax: number): Span[] {
  const spans: Span[] = [];
  let start = -1;
  for (let i = 0; i < length; i++) {
    const hasContent = counts[i] > gutterMax;
    if (hasContent && start === -1) start = i;
    if ((!hasContent || i === length - 1) && start !== -1) {
      spans.push({ start, end: hasContent ? i : i - 1 });
      start = -1;
    }
  }
  return spans;
}

/**
 * Çok satırlı/çok kolonlu karakter sheet'lerini 2B olarak böler.
 *
 * 1) Arka plan rengi kenarlardan tahmin edilir, ön plan maskesi çıkarılır.
 * 2) Yatay boş satırlardan satır bantları bulunur.
 * 3) Her bantta dikey boşluklardan hücreler ayrılır ve içeriğe göre daraltılır.
 * 4) Kare/portre oranlı ve yüz içeren hücreler 'face', ince-uzun hücreler 'figure'.
 */
export function detectSheetLayout(data: ImageData, options: SheetSplitOptions = {}): SheetLayout {
  const minSliceRatio = options.minSliceRatio ?? DEFAULT_MIN_SLICE;
  const maxSlices = options.maxSlices ?? 24;
  const { width, height } = data;
  const bg = estimateBackground(data);
  const mask = foregroundMask(data, bg);

  const rowCounts = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let c = 0;
    const base = y * width;
    for (let x = 0; x < width; x++) c += mask[base + x];
    rowCounts[y] = c;
  }

  const rowGutterMax = Math.max(1, Math.floor(width * 0.004));
  const bands = contentSpans(rowCounts, height, rowGutterMax).filter(
    (b) => b.end - b.start + 1 >= Math.max(6, Math.floor(height * 0.03))
  );

  const cells: SheetCell[] = [];
  const minCellW = Math.max(8, Math.floor(width * minSliceRatio * 0.6));
  const narrowSeen = new Map<number, number>();

  bands.forEach((band, rowIndex) => {
    const bandH = band.end - band.start + 1;
    const colCounts = new Int32Array(width);
    for (let y = band.start; y <= band.end; y++) {
      const base = y * width;
      for (let x = 0; x < width; x++) colCounts[x] += mask[base + x];
    }

    const colGutterMax = Math.max(1, Math.floor(bandH * 0.004));
    const columns = contentSpans(colCounts, width, colGutterMax);

    for (const col of columns) {
      if (col.end - col.start + 1 < minCellW) continue;

      // Hücreyi içeriğe göre daralt.
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      let area = 0;
      for (let y = band.start; y <= band.end; y++) {
        const base = y * width;
        for (let x = col.start; x <= col.end; x++) {
          if (!mask[base + x]) continue;
          area++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0 || area < width * height * 0.002) continue;

      const cw = maxX - minX + 1;
      const ch = maxY - minY + 1;
      const padX = Math.round(cw * 0.03);
      const padY = Math.round(ch * 0.03);
      const x = Math.max(0, minX - padX);
      const y = Math.max(0, minY - padY);
      const w = Math.min(width, maxX + padX) - x;
      const h = Math.min(height, maxY + padY) - y;

      const crop = cropImageData(data, { x, y, width: w, height: h });
      const aspect = h / Math.max(1, w);
      const face = detectFaceRegion(crop);
      const faceConfidence = face ? face.confidence : 0;
      const isFace = Boolean(face && faceConfidence >= 0.2 && aspect < 1.7);

      // Açı adlandırması içerikten: yüz görünen geniş gövde → ön;
      // yüz yok + dar silüet → yan (önce sağ, sonra sol); yüz yok + geniş → arka.
      let suggestedAngle: SheetCell['suggestedAngle'];
      if (isFace) {
        suggestedAngle = 'front';
      } else if (w / Math.max(1, h) <= 0.45) {
        const used = narrowSeen.get(rowIndex) ?? 0;
        suggestedAngle = used === 0 ? 'right' : 'left';
        narrowSeen.set(rowIndex, used + 1);
      } else if (faceConfidence >= 0.15) {
        suggestedAngle = 'front';
      } else {
        suggestedAngle = 'back';
      }

      cells.push({
        x,
        y,
        width: w,
        height: h,
        kind: isFace ? 'face' : 'figure',
        faceConfidence: isFace ? faceConfidence : 0,
        row: rowIndex,
        suggestedAngle,
      });
    }
  });

  const limited = cells.slice(0, Math.max(1, maxSlices));
  if (limited.length === 0) {
    return {
      cells: [
        { x: 0, y: 0, width, height, kind: 'figure', faceConfidence: 0, row: 0, suggestedAngle: 'front' },
      ],
      rows: 1,
      background: bg,
    };
  }

  return { cells: limited, rows: bands.length, background: bg };
}
