import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { CAD_PRESETS, compileCadSpec, evalCadExpr, generateBuild123dCode } from '../cadEngine';
import { analyzeMesh, buildOverhangColorGeometry, placeOnBuildPlate } from '../meshRepair';
import { detectSheetLayout } from '../sheetSplit';
import { FREE_HF_SPACES, VALID_SPACE_ID_RE } from '../cloudCatalog';

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

function fillRect(
  img: FakeImageData,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: [number, number, number]
) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
    }
  }
}

describe('Parametric Text-to-CAD Engine (cadEngine)', () => {
  it('evalCadExpr aritmetik ifadeleri ve parametreleri güvenli biçimde hesaplar', () => {
    const params = { width: 60, wall: 3, holeDia: 4.4 };
    expect(evalCadExpr('width - wall * 2', params)).toBeCloseTo(54, 5);
    expect(evalCadExpr('-(width / 2 - wall)', params)).toBeCloseTo(-27, 5);
    expect(evalCadExpr('max(wall, holeDia / 2)', params)).toBeCloseTo(3, 5);
    // Zararlı / tanınmayan kod ifadeleri çalıştırılmaz, fallback döner
    expect(evalCadExpr('process.exit(1)', params, 7)).toBe(7);
  });

  it('tüm 5 hazır 3D baskı CAD şablonu su geçirmez (watertight) ve Y=0 tabanlı geometri üretir', () => {
    for (const preset of CAD_PRESETS) {
      const geo = compileCadSpec(preset.spec);
      const stats = analyzeMesh(geo);
      geo.computeBoundingBox();
      expect(stats.triangleCount).toBeGreaterThan(20);
      expect(stats.isWatertight).toBe(true);
      expect(geo.boundingBox!.min.y).toBeCloseTo(0, 2);
      geo.dispose();
    }
  });

  it('canlı parametre değişikliği modelin fiziksel ölçüsünü anında günceller', () => {
    const boxPreset = CAD_PRESETS.find((p) => p.id === 'electronics-box')!;
    const smallGeo = compileCadSpec(boxPreset.spec, { length: 60, width: 44, height: 22, wall: 2.5 });
    const bigGeo = compileCadSpec(boxPreset.spec, { length: 110, width: 44, height: 22, wall: 2.5 });
    const smallStats = analyzeMesh(smallGeo);
    const bigStats = analyzeMesh(bigGeo);
    expect(smallStats.widthMm).toBeCloseTo(60, 0);
    expect(bigStats.widthMm).toBeCloseTo(110, 0);
    smallGeo.dispose();
    bigGeo.dispose();
  });

  it('generateBuild123dCode güncel parametrelerle geçerli Python betiği üretir', () => {
    const gearPreset = CAD_PRESETS.find((p) => p.id === 'spur-gear')!;
    const py = generateBuild123dCode(gearPreset.spec, { teeth: 28, module: 2.5, thickness: 10, boreDia: 8 });
    expect(py).toContain('from build123d import *');
    expect(py).toContain('teeth = 28');
    expect(py).toContain('export_step');
    expect(py).toContain('export_stl');
  });
});

describe('3B Baskı Sarkan Yüzey (Overhang) Denetimi', () => {
  it('düz küp için sarkan yüzey %0, taban teması > 0 hesaplar', () => {
    const box = placeOnBuildPlate(new THREE.BoxGeometry(30, 30, 30));
    const stats = analyzeMesh(box);
    expect(stats.isWatertight).toBe(true);
    expect(stats.overhangTrianglePct).toBe(0);
    expect(stats.bedContactPct).toBeGreaterThan(0);
    expect(stats.thinWallWarning).toBe(false);
    expect(stats.exceedsBedWarning).toBe(false);
    box.dispose();
  });

  it('desteksiz sarkan tabla (T-profil) için >45° overhang tespit eder ve kırmızı boyar', () => {
    const overhangGeo = compileCadSpec({
      title: 'T-Test',
      summary: 'Test',
      parameters: [],
      root: {
        type: 'union',
        children: [
          { type: 'cuboid', size: [10, 10, 20] },
          { type: 'translate', offset: [0, 0, 12], child: { type: 'cuboid', size: [40, 40, 6] } },
        ],
      },
    });
    const stats = analyzeMesh(overhangGeo);
    expect(stats.overhangTrianglePct).toBeGreaterThan(10);

    const colored = buildOverhangColorGeometry(overhangGeo);
    const colAttr = colored.getAttribute('color') as THREE.BufferAttribute;
    expect(colAttr).toBeTruthy();
    let hasRedOverhang = false;
    for (let i = 0; i < colAttr.count; i++) {
      if (colAttr.getX(i) > 0.85 && colAttr.getY(i) < 0.35) {
        hasRedOverhang = true;
        break;
      }
    }
    expect(hasRedOverhang).toBe(true);
    colored.dispose();
    overhangGeo.dispose();
  });
});

describe('Evrensel Karakter Sheet Algılama (3–7+ Görsel & Gradyan Arka Plan)', () => {
  it('3 görselli turnaround sheetini doğru ayırır ve metin başlığını eler', () => {
    const img = new FakeImageData(660, 420);
    const body: [number, number, number] = [65, 68, 76];
    const skin: [number, number, number] = [205, 152, 122];

    // Üstte ince metin başlığı şeridi (elenmeli)
    fillRect(img, 180, 8, 280, 10, [90, 90, 95]);

    // Ön (geniş + yüz), Yan (dar), Arka (geniş + yüz yok)
    fillRect(img, 30, 40, 170, 340, body);
    fillRect(img, 80, 58, 66, 66, skin);
    fillRect(img, 260, 40, 110, 340, body);
    fillRect(img, 430, 40, 170, 340, body);

    const layout = detectSheetLayout(img as unknown as ImageData);
    const figures = layout.cells.filter((c) => c.kind === 'figure');
    expect(figures).toHaveLength(3);
    expect(figures.map((f) => f.suggestedAngle)).toEqual(['front', 'right', 'back']);
  });

  it('gradyan arka planlı 7 görselli kademeli sheeti eksiksiz böler', () => {
    const img = new FakeImageData(900, 620);
    // Soldan sağa + yukarıdan aşağıya yumuşak stüdyo gradyanı
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const v = Math.round(215 + (x / img.width) * 28 + (y / img.height) * 12);
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v - 4;
      }
    }

    const body: [number, number, number] = [60, 64, 74];
    const skin: [number, number, number] = [202, 148, 118];
    // 4 tam boy üstte
    fillRect(img, 30, 30, 165, 340, body);
    fillRect(img, 80, 48, 65, 65, skin);
    fillRect(img, 240, 30, 115, 340, body);
    fillRect(img, 400, 30, 165, 340, body);
    fillRect(img, 610, 30, 115, 340, body);
    // 3 yüz paneli altta
    fillRect(img, 80, 420, 170, 155, skin);
    fillRect(img, 340, 420, 170, 155, skin);
    fillRect(img, 600, 420, 170, 155, skin);

    const layout = detectSheetLayout(img as unknown as ImageData, { maxSlices: 24 });
    expect(layout.cells).toHaveLength(7);
    expect(layout.cells.filter((c) => c.kind === 'figure')).toHaveLength(4);
    expect(layout.cells.filter((c) => c.kind === 'face')).toHaveLength(3);
  });

  it('ücretsiz HF 3D kataloğundaki tüm Space ID formatlarını doğrular', () => {
    expect(FREE_HF_SPACES.length).toBeGreaterThanOrEqual(6);
    for (const s of FREE_HF_SPACES) {
      expect(VALID_SPACE_ID_RE.test(s.id)).toBe(true);
    }
    expect(VALID_SPACE_ID_RE.test('../etc/passwd')).toBe(false);
    expect(VALID_SPACE_ID_RE.test('http://127.0.0.1/bad')).toBe(false);
  });
});
