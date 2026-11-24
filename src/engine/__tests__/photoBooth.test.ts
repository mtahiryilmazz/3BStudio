import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import {
  buildBoothPlan,
  carvePhotoBooth,
  sampleVertexColors,
  boothQualityHints,
  type BoothView,
} from '../photoBooth';
import type { BinaryMask } from '../types';

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

beforeAll(() => {
  (globalThis as Record<string, unknown>).ImageData = FakeImageData;
});

/** Dikdörtgen silüet maskesi (merkezli, yarıçaplar oranla 0..1). */
function rectMask(size: number, halfW: number, halfH: number): BinaryMask {
  const data = new Uint8Array(size * size);
  const cx = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x - cx) / cx;
      const v = 1 - (y / (size - 1)); // 0 taban, 1 tepe
      const insideX = Math.abs(u) <= halfW;
      const insideY = Math.abs(v - 0.5) <= halfH;
      data[y * size + x] = insideX && insideY ? 1 : 0;
    }
  }
  return { width: size, height: size, data };
}

function diskMask(size: number, radius: number): BinaryMask {
  const data = new Uint8Array(size * size);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = radius * cx;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      data[y * size + x] = Math.hypot(dx, dy) <= r ? 1 : 0;
    }
  }
  return { width: size, height: size, data };
}

function ring(azimuths: number[], mask: BinaryMask): BoothView[] {
  return azimuths.map((azimuthDeg) => ({ azimuthDeg, mask }));
}

describe('buildBoothPlan', () => {
  it('12 poz için 30° aralık ve adlandırılmış ana açılar üretir', () => {
    const plan = buildBoothPlan(12);
    expect(plan).toHaveLength(12);
    expect(plan[0]).toEqual({ azimuthDeg: 0, label: 'Ön (0°)' });
    expect(plan[3].azimuthDeg).toBe(90);
    expect(plan[3].label).toBe('Sağ (90°)');
    expect(plan[6].azimuthDeg).toBe(180);
    expect(plan[9].azimuthDeg).toBe(270);
  });

  it('8 poz için 45° aralık, 16 poz için 22.5° aralık verir', () => {
    expect(buildBoothPlan(8).map((p) => p.azimuthDeg)).toEqual([
      0, 45, 90, 135, 180, 225, 270, 315,
    ]);
    const p16 = buildBoothPlan(16);
    expect(p16[1].azimuthDeg).toBeCloseTo(22.5, 5);
    expect(p16).toHaveLength(16);
  });

  it('aşırı sayıları güvenli aralığa kırpar', () => {
    expect(buildBoothPlan(1)).toHaveLength(4);
    expect(buildBoothPlan(999)).toHaveLength(24);
  });
});

describe('carvePhotoBooth', () => {
  it('8 halka diski yuvarlak (sphere benzeri) hacim üretir', () => {
    const mask = diskMask(64, 0.42);
    const geo = carvePhotoBooth(ring([0, 45, 90, 135, 180, 225, 270, 315], mask), {
      resolution: 40,
      smoothPasses: 1,
      sizeMm: 100,
    });
    geo.computeBoundingBox();
    const box = geo.boundingBox as THREE.Box3;
    const size = new THREE.Vector3();
    box.getSize(size);
    expect(geo.getAttribute('position').count).toBeGreaterThan(0);
    expect(size.x).toBeGreaterThan(10);
    expect(size.z).toBeGreaterThan(10);
    expect(size.y).toBeGreaterThan(10);
    // Halka dışbükeyliği: en büyük kenar 100 mm'ye ölçeklenmeli
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(100, 0);
    // Taban y=0'a oturmalı
    expect(box.min.y).toBeCloseTo(0, 3);
  });

  it('ön/arka geniş + yan dar maskeler en-boy farkını korur', () => {
    const wide = rectMask(64, 0.42, 0.42);
    const narrow = rectMask(64, 0.12, 0.42);
    const views: BoothView[] = [
      { azimuthDeg: 0, mask: wide },
      { azimuthDeg: 90, mask: narrow },
      { azimuthDeg: 180, mask: wide },
      { azimuthDeg: 270, mask: narrow },
    ];
    const geo = carvePhotoBooth(views, { resolution: 48, smoothPasses: 0, sizeMm: 100 });
    geo.computeBoundingBox();
    const size = new THREE.Vector3();
    (geo.boundingBox as THREE.Box3).getSize(size);
    expect(size.x).toBeGreaterThan(size.z * 1.8);
  });

  it('tek görünümde hata verir', () => {
    expect(() =>
      carvePhotoBooth([{ azimuthDeg: 0, mask: diskMask(32, 0.4) }], { resolution: 32 })
    ).toThrow(/en az 2/i);
  });

  it('boş maskelerde hata verir', () => {
    const empty: BinaryMask = { width: 32, height: 32, data: new Uint8Array(32 * 32) };
    expect(() =>
      carvePhotoBooth(ring([0, 90], empty), { resolution: 32, smoothPasses: 0 })
    ).toThrow(/hacim çıkmadı/i);
  });
});

describe('sampleVertexColors', () => {
  it('kırmızı fotoğraftan vertex renkleri yazar', () => {
    const mask = diskMask(32, 0.4);
    const geo = carvePhotoBooth(ring([0, 90, 180, 270], mask), {
      resolution: 32,
      smoothPasses: 0,
      sizeMm: 50,
    });
    const img = new FakeImageData(16, 16);
    img.data.fill(255);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 255;
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
    }
    sampleVertexColors(geo, [{ azimuthDeg: 0, image: img as unknown as ImageData }]);
    const color = geo.getAttribute('color') as THREE.BufferAttribute;
    expect(color).toBeTruthy();
    expect(color.count).toBe(geo.getAttribute('position').count);
    let redFound = false;
    for (let i = 0; i < color.count; i++) {
      if (color.getX(i) > 0.9 && color.getY(i) < 0.1) redFound = true;
    }
    expect(redFound).toBe(true);
  });

  it('kaynak yoksa geometriye dokunmaz', () => {
    const mask = diskMask(32, 0.4);
    const geo = carvePhotoBooth(ring([0, 90], mask), { resolution: 32, smoothPasses: 0 });
    const before = geo.getAttribute('position').count;
    sampleVertexColors(geo, []);
    expect(geo.getAttribute('position').count).toBe(before);
    expect(geo.getAttribute('color')).toBeUndefined();
  });
});

describe('boothQualityHints', () => {
  it('boş sette yönlendirme verir', () => {
    const hints = boothQualityHints([]);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toMatch(/12 poz/);
  });

  it('eksik açıları listeler, tam halkada olumlu döner', () => {
    const partial = boothQualityHints([0, 30, 60, 90]);
    expect(partial.join(' ')).toMatch(/Eksik açılar/);
    const full = boothQualityHints(buildBoothPlan(12).map((p) => p.azimuthDeg));
    expect(full.join(' ')).toMatch(/Halka tam/);
  });
});
