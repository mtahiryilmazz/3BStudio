import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { detectFaceRegion, paintHeadFromFace } from '../faceDetect';

class FakeImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    this.data.fill(255);
  }
}

function makeImage(w: number, h: number, bg: [number, number, number]): FakeImageData {
  const img = new FakeImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = bg[0];
    img.data[i + 1] = bg[1];
    img.data[i + 2] = bg[2];
    img.data[i + 3] = 255;
  }
  return img;
}

function fillRect(
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
      img.data[i + 3] = 255;
    }
  }
}

const SKIN: [number, number, number] = [200, 150, 120];
const BG: [number, number, number] = [30, 34, 40];

describe('detectFaceRegion', () => {
  it('üst yarıdaki ten bölgesini yüz olarak bulur', () => {
    const img = makeImage(200, 300, BG);
    fillRect(img, 70, 40, 60, 70, SKIN);
    const region = detectFaceRegion(img as unknown as ImageData);
    expect(region).not.toBeNull();
    if (!region) return;
    expect(region.width).toBeGreaterThanOrEqual(60);
    expect(region.height).toBeGreaterThanOrEqual(70);
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    expect(Math.abs(cx - 100)).toBeLessThan(15);
    expect(Math.abs(cy - 75)).toBeLessThan(20);
    expect(region.confidence).toBeGreaterThan(0.1);
  });

  it('kenar payı uygular ve görüntü sınırını aşmaz', () => {
    const img = makeImage(120, 120, BG);
    fillRect(img, 10, 10, 80, 80, SKIN);
    const region = detectFaceRegion(img as unknown as ImageData);
    expect(region).not.toBeNull();
    if (!region) return;
    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeGreaterThanOrEqual(0);
    expect(region.x + region.width).toBeLessThanOrEqual(120);
    expect(region.y + region.height).toBeLessThanOrEqual(120);
  });

  it('ten rengi yoksa null döner', () => {
    const img = makeImage(160, 160, [20, 40, 90]);
    expect(detectFaceRegion(img as unknown as ImageData)).toBeNull();
  });

  it('çok alttaki ten bölgesini yüz saymaz', () => {
    const img = makeImage(200, 300, BG);
    fillRect(img, 70, 250, 60, 45, SKIN);
    expect(detectFaceRegion(img as unknown as ImageData)).toBeNull();
  });

  it('aşırı geniş ten şeridini eler', () => {
    const img = makeImage(300, 200, BG);
    fillRect(img, 10, 30, 280, 40, SKIN); // aspect 7
    expect(detectFaceRegion(img as unknown as ImageData)).toBeNull();
  });

  it('küçük görsellerde null döner', () => {
    const img = makeImage(10, 10, SKIN);
    expect(detectFaceRegion(img as unknown as ImageData)).toBeNull();
  });
});

describe('paintHeadFromFace', () => {
  function sphere(): THREE.BufferGeometry {
    const geo = new THREE.SphereGeometry(30, 24, 24);
    geo.translate(0, 50, 0);
    return geo;
  }

  function redFace(size = 24): ImageData {
    const img = makeImage(size, size, [255, 0, 0]);
    return img as unknown as ImageData;
  }

  it('kafa bandındaki ön yüz vertexlerini boyar, gövdeyi korur', () => {
    const geo = sphere();
    paintHeadFromFace(geo, redFace(), { headHeightRatio: 0.22 });
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const color = geo.getAttribute('color') as THREE.BufferAttribute;
    expect(color).toBeTruthy();

    let headPainted = 0;
    let bodyNeutral = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const nz = nrm.getZ(i);
      if (y > 67 && nz > 0.3) {
        if (color.getX(i) > 0.9 && color.getY(i) < 0.1) headPainted++;
      }
      if (y < 50) {
        if (Math.abs(color.getX(i) - 0.72) < 1e-6) bodyNeutral++;
      }
    }
    expect(headPainted).toBeGreaterThan(0);
    expect(bodyNeutral).toBeGreaterThan(0);
  });

  it('mevcut renkleri korur (üzerine yalnızca kafa yazar)', () => {
    const geo = sphere();
    const count = (geo.getAttribute('position') as THREE.BufferAttribute).count;
    const base = new Float32Array(count * 3);
    base.fill(0.2);
    geo.setAttribute('color', new THREE.BufferAttribute(base, 3));
    paintHeadFromFace(geo, redFace(), { headHeightRatio: 0.2 });
    const color = geo.getAttribute('color') as THREE.BufferAttribute;
    expect(color.getX(0)).toBeCloseTo(0.2, 6);
  });

  it('boş geometride çökmez', () => {
    const geo = new THREE.BufferGeometry();
    expect(() => paintHeadFromFace(geo, redFace())).not.toThrow();
  });
});
