import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { analyzeSheetCell, detectSheetLayout } from '../sheetSplit';
import {
  MAX_TRIANGLES_SOFT,
  estimateMeshBytes,
  subdivideGeometry,
  subdivideWithBudget,
} from '../meshRepair';
import { paintHeadFromFace } from '../faceDetect';

class FakeImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.data.fill(245);
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = 255;
  }
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).ImageData = FakeImageData;
});

function fill(
  img: FakeImageData,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: [number, number, number]
) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
    }
  }
}

/** Kullanıcının gönderdiği düzene benzer: üstte 4 tam boy, altta 3 yüz paneli. */
function makeMultiRowSheet(): FakeImageData {
  const img = new FakeImageData(800, 600);
  const body: [number, number, number] = [70, 70, 78];
  const skin: [number, number, number] = [200, 150, 120];
  const figureX = [20, 220, 420, 620];
  for (const x of figureX) fill(img, x, 20, 150, 360, body);
  const faceX = [60, 300, 540];
  for (const x of faceX) fill(img, x, 420, 190, 160, skin);
  return img;
}

describe('detectSheetLayout', () => {
  it('çok satırlı sheette satırları ve kolonları ayrı ayrı böler', () => {
    const sheet = makeMultiRowSheet();
    const layout = detectSheetLayout(sheet as unknown as ImageData, { maxSlices: 24 });
    expect(layout.rows).toBe(2);
    expect(layout.cells).toHaveLength(7);
    expect(layout.cells.filter((c) => c.kind === 'figure')).toHaveLength(4);
    expect(layout.cells.filter((c) => c.kind === 'face')).toHaveLength(3);
  });

  it('yüz hücrelerini alt bantta ve kareye yakın oranda bulur', () => {
    const sheet = makeMultiRowSheet();
    const layout = detectSheetLayout(sheet as unknown as ImageData);
    const faces = layout.cells.filter((c) => c.kind === 'face');
    for (const face of faces) {
      expect(face.row).toBe(1);
      expect(face.y).toBeGreaterThan(400);
      expect(face.width / face.height).toBeGreaterThan(0.8);
      expect(face.faceConfidence).toBeGreaterThan(0.1);
    }
  });

  it('tam boy görünümleri üst bantta ve ince-uzun bulur', () => {
    const sheet = makeMultiRowSheet();
    const layout = detectSheetLayout(sheet as unknown as ImageData);
    const figures = layout.cells.filter((c) => c.kind === 'figure');
    for (const fig of figures) {
      expect(fig.row).toBe(0);
      expect(fig.height / fig.width).toBeGreaterThan(1.8);
    }
    // Kolonlar soldan sağa sıralı
    const xs = figures.map((f) => f.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('tek görselde tek hücre döner', () => {
    const img = new FakeImageData(200, 200);
    fill(img, 40, 30, 120, 140, [40, 40, 40]);
    const layout = detectSheetLayout(img as unknown as ImageData);
    expect(layout.cells.length).toBeGreaterThanOrEqual(1);
    expect(layout.cells[0].kind).toBe('figure');
  });

  it('açıları içerikten önerir: yüz → ön, dar → yan, yüz yok → arka', () => {
    const img = new FakeImageData(800, 420);
    const body: [number, number, number] = [70, 70, 78];
    const skin: [number, number, number] = [200, 150, 120];

    // Ön: geniş gövde + ten rengi kafa
    fill(img, 20, 20, 200, 360, body);
    fill(img, 85, 40, 70, 70, skin);
    // İki yan: dar silüet
    fill(img, 260, 20, 120, 360, body);
    fill(img, 420, 20, 120, 360, body);
    // Arka: geniş gövde, yüz yok
    fill(img, 580, 20, 200, 360, body);

    const layout = detectSheetLayout(img as unknown as ImageData);
    const angles = layout.cells.filter((c) => c.kind === 'figure').map((c) => c.suggestedAngle);
    expect(angles).toEqual(['front', 'right', 'left', 'back']);
  });
});

describe('subdivideGeometry', () => {
  function box(): THREE.BufferGeometry {
    const geo = new THREE.BoxGeometry(10, 10, 10);
    return geo;
  }

  it('üçgen sayısını ×4 ve ×16 artırır', () => {
    const base = box();
    const once = subdivideGeometry(base, 1);
    const twice = subdivideGeometry(base, 2);
    const index = base.getIndex();
    const baseTris = index ? index.count / 3 : base.getAttribute('position').count / 3;
    expect(once.getAttribute('position').count / 3).toBe(baseTris * 4);
    expect(twice.getAttribute('position').count / 3).toBe(baseTris * 16);
  });

  it('sınırları ve hacmi korur', () => {
    const base = box();
    base.computeBoundingBox();
    const sub = subdivideGeometry(base, 1);
    sub.computeBoundingBox();
    const a = base.boundingBox as THREE.Box3;
    const b = sub.boundingBox as THREE.Box3;
    expect(b.min.x).toBeCloseTo(a.min.x, 4);
    expect(b.max.y).toBeCloseTo(a.max.y, 4);
    expect(b.max.z).toBeCloseTo(a.max.z, 4);
  });

  it('mevcut vertex renklerini korur', () => {
    const base = subdivideGeometry(box(), 0);
    const count = (base.getAttribute('position') as THREE.BufferAttribute).count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 0;
      colors[i * 3 + 2] = 0;
    }
    base.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sub = subdivideGeometry(base, 1);
    const subColor = sub.getAttribute('color') as THREE.BufferAttribute;
    expect(subColor).toBeTruthy();
    expect(subColor.count).toBe((sub.getAttribute('position') as THREE.BufferAttribute).count);
    expect(subColor.getX(0)).toBeCloseTo(1, 5);
    expect(subColor.getY(0)).toBeCloseTo(0, 5);
  });

  it('0 geçişte kopya döner, orijinali değiştirmez', () => {
    const base = box();
    const copy = subdivideGeometry(base, 0);
    const index = base.getIndex();
    const baseTris = index ? index.count / 3 : base.getAttribute('position').count / 3;
    expect(copy).not.toBe(base);
    expect(copy.getAttribute('position').count / 3).toBe(baseTris);
  });
});

describe('analyzeSheetCell', () => {
  it('ten rengi dolu kare dilimi yüz paneli olarak sınıflandırır', () => {
    const crop = new FakeImageData(180, 160);
    fill(crop, 10, 10, 160, 140, [205, 152, 120]);
    const analysis = analyzeSheetCell(crop as unknown as ImageData);
    expect(analysis.kind).toBe('face');
    expect(analysis.suggestionReason).toBe('yüz paneli');
  });

  it('üst bölgede ten rengi bulunan geniş tam boy figürü ön olarak önerir', () => {
    const crop = new FakeImageData(200, 360);
    fill(crop, 0, 0, 200, 360, [70, 70, 78]);
    fill(crop, 65, 20, 70, 70, [205, 152, 120]);
    const analysis = analyzeSheetCell(crop as unknown as ImageData);
    expect(analysis.kind).toBe('figure');
    expect(analysis.suggestedAngle).toBe('front');
    expect(analysis.suggestionReason).toBe('yüz algılandı');
  });

  it('dar silüeti sırasıyla sağ ve sol olarak önerir', () => {
    const crop = new FakeImageData(120, 360);
    fill(crop, 0, 0, 120, 360, [70, 70, 78]);
    const first = analyzeSheetCell(crop as unknown as ImageData, 0);
    const second = analyzeSheetCell(crop as unknown as ImageData, 1);
    expect(first.suggestedAngle).toBe('right');
    expect(first.suggestionReason).toBe('dar silüet');
    expect(second.suggestedAngle).toBe('left');
    expect(second.suggestionReason).toBe('dar silüet');
  });

  it('yüzsüz geniş figürü arka olarak önerir', () => {
    const crop = new FakeImageData(200, 360);
    fill(crop, 0, 0, 200, 360, [70, 70, 78]);
    const analysis = analyzeSheetCell(crop as unknown as ImageData);
    expect(analysis.suggestedAngle).toBe('back');
    expect(analysis.suggestionReason).toBe('yüz yok');
  });
});

describe('subdivideWithBudget & estimateMeshBytes', () => {
  it('bütçe aşıldığında güvenli geçiş sayısında kırpar (clamped)', () => {
    const base = new THREE.BoxGeometry(10, 10, 10); // 12 üçgen
    const res = subdivideWithBudget(base, 3, 100);
    expect(res.appliedLevels).toBe(1);
    expect(res.triangles).toBe(48);
    expect(res.clamped).toBe(true);
    expect(MAX_TRIANGLES_SOFT).toBe(750_000);
  });

  it('STL ve GLB tahmini bayt hesabını doğru verir', () => {
    const est = estimateMeshBytes(1_000_000);
    expect(est.stlBytes).toBe(50_000_084);
    expect(est.glbBytes).toBe(88_004_096);
  });

  it('paintHeadFromFace sonrası subdivideWithBudget renk özniteliğini korur', () => {
    const base = new THREE.BoxGeometry(20, 40, 20);
    const face = new FakeImageData(64, 64);
    fill(face, 0, 0, 64, 64, [230, 160, 120]);
    const painted = paintHeadFromFace(base, face as unknown as ImageData);
    const sub = subdivideWithBudget(painted, 1, 10_000);
    const colorAttr = sub.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(colorAttr).toBeTruthy();
    expect(colorAttr.count).toBe((sub.geometry.getAttribute('position') as THREE.BufferAttribute).count);
    let hasFaceTint = false;
    for (let i = 0; i < colorAttr.count; i++) {
      if (colorAttr.getX(i) > 0.85 && colorAttr.getY(i) > 0.55) {
        hasFaceTint = true;
        break;
      }
    }
    expect(hasFaceTint).toBe(true);
  });
});

