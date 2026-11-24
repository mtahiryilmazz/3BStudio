/**
 * Karakter sheet (turnaround) bölücü.
 *
 * Bir karakter sheet görselindeki dikey boşluk (gutter) sütunlarını bulup
 * görüntüyü alt bölmelere ayırır: front / side / back kolonları tipik olarak
 * düz arka plan şeritleriyle ayrılır. Saf piksel matematiği; DOM yok.
 */

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
