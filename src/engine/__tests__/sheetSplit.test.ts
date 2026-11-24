import { describe, it, expect, beforeAll } from 'vitest';
import { detectSheetSlices, cropImageData, suggestSliceAngles } from '../sheetSplit';

class FakeImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

type Ctor = new (w: number, h: number) => FakeImageData;

beforeAll(() => {
  (globalThis as Record<string, unknown>).ImageData = FakeImageData as unknown as Ctor;
});

/** Beyaz arka plan (245) üzerine koyu figür (30) çizen sahte sheet. */
function makeSheet(width: number, height: number, figureSpans: Array<[number, number]>): FakeImageData {
  const img = new FakeImageData(width, height);
  img.data.fill(245);
  for (const [x0, x1] of figureSpans) {
    for (let x = x0; x <= x1; x++) {
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4;
        img.data[i] = 30;
        img.data[i + 1] = 30;
        img.data[i + 2] = 30;
        img.data[i + 3] = 255;
      }
    }
  }
  return img as unknown as ImageData;
}

describe('detectSheetSlices', () => {
  it('3 kolonlu turnaround sheetini front/side/back dilimlerine ayırır', () => {
    // 300x100: figürler 10-90, 110-190, 210-290
    const sheet = makeSheet(300, 100, [
      [10, 90],
      [110, 190],
      [210, 290],
    ]);
    const slices = detectSheetSlices(sheet);
    expect(slices).toHaveLength(3);
    expect(slices[0].x).toBeLessThanOrEqual(10);
    expect(slices[0].width).toBeGreaterThanOrEqual(80);
    expect(slices[1].x).toBeGreaterThan(90);
    expect(slices[2].x).toBeGreaterThan(190);
    for (const s of slices) {
      expect(s.height).toBe(100);
      expect(s.y).toBe(0);
    }
  });

  it('gutter içermeyen tek görselde tam kareyi tek dilim döndürür', () => {
    const sheet = makeSheet(200, 150, [[0, 199]]);
    const slices = detectSheetSlices(sheet);
    expect(slices).toHaveLength(1);
    expect(slices[0].x).toBe(0);
    expect(slices[0].width).toBe(200);
    expect(slices[0].height).toBe(150);
  });

  it('boş görselde tek dilim döner (çökmez)', () => {
    const sheet = makeSheet(120, 80, []);
    const slices = detectSheetSlices(sheet);
    expect(slices).toHaveLength(1);
    expect(slices[0].width).toBe(120);
  });

  it('6+ dilimde en geniş dilimleri tutar', () => {
    const spans: Array<[number, number]> = [];
    for (let k = 0; k < 8; k++) spans.push([k * 50 + 5, k * 50 + 40]);
    const sheet = makeSheet(400, 60, spans);
    const slices = detectSheetSlices(sheet, { maxSlices: 5 });
    expect(slices.length).toBeLessThanOrEqual(5);
    // x'e göre sıralı kalmalı
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i].x).toBeGreaterThan(slices[i - 1].x);
    }
  });
});

describe('cropImageData', () => {
  it('alt bölgeyi doğru piksellerle kopyalar', () => {
    const img = new FakeImageData(10, 10);
    img.data.fill(0);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const i = (y * 10 + x) * 4;
        img.data[i] = y * 10 + x;
        img.data[i + 3] = 255;
      }
    }
    const crop = cropImageData(img as unknown as ImageData, { x: 3, y: 2, width: 4, height: 3 });
    expect(crop.width).toBe(4);
    expect(crop.height).toBe(3);
    expect(crop.data[0]).toBe(23); // y=2, x=3 → 23
    expect(crop.data[3 * 4]).toBe(26); // y=2, x=6 → 26
    expect(crop.data[2 * 4 * 4]).toBe(43); // y=4, x=3 → 43
  });
});

describe('suggestSliceAngles', () => {
  it('sırayı front→right→back→left→top olarak verir ve taşmayı clamp eder', () => {
    expect(suggestSliceAngles(3)).toEqual(['front', 'right', 'back']);
    expect(suggestSliceAngles(5)).toEqual(['front', 'right', 'back', 'left', 'top']);
    expect(suggestSliceAngles(7)[6]).toBe('top');
    expect(suggestSliceAngles(0)).toEqual([]);
  });
});
