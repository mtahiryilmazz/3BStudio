import * as THREE from 'three';
import { marchingCubes } from './marchingCubes';
import { BinaryMask } from './types';

/**
 * Fotogrametri kabini: kişinin/nesnenin çevresinden çekilen N adet halka fotoğrafın
 * silüetlerini kesişimle oyarak yüksek açılı, kapalı bir hacim üretir.
 *
 * Mevcut `reconstructVisualHull` 5 ortoğrafik görünümle sınırlıdır; burada kamera
 * halkası keyfi azimutlarda (8/12/16 poz) çalışır ve isteğe bağlı olarak vertex
 * renkleri fotoğraflardan örneklenir (GLB'de "detaylı" görünüm için).
 */

export interface BoothPlanItem {
  /** Kamera azimutu (derece). 0 = önden (kamera +Z'de, modele bakıyor). */
  azimuthDeg: number;
  /** Kullanıcıya gösterilecek Türkçe etiket. */
  label: string;
}

export interface BoothView {
  azimuthDeg: number;
  mask: BinaryMask;
  /** Renk örneklemesi için temizlenmiş (arkaplanı silinmiş) görsel; opsiyonel. */
  image?: ImageData | null;
}

export interface BoothOptions {
  /** Voksel çözünürlüğü (32..160). Kişi taraması için 96-128 iyi sonuç verir. */
  resolution?: number;
  /** 3x3x3 yumuşatma geçişi (0..6); silüet gürültüsünü azaltır. */
  smoothPasses?: number;
  /** Modelin en büyük kenarı (mm). */
  sizeMm?: number;
}

const NAMED_AZIMUTHS: Record<number, string> = {
  0: 'Ön (0°)',
  90: 'Sağ (90°)',
  180: 'Arka (180°)',
  270: 'Sol (270°)',
};

/**
 * Halka çekim planı: 8 / 12 / 16 poz, eşit açı aralığıyla, 0° önden başlar.
 * 12 poz, kişi taraması için önerilen dengedir (30° aralık).
 */
export function buildBoothPlan(count: number): BoothPlanItem[] {
  const safe = Math.max(4, Math.min(24, Math.round(count)));
  const step = 360 / safe;
  return Array.from({ length: safe }, (_, i) => {
    const azimuthDeg = Math.round(i * step * 10) / 10;
    const named = NAMED_AZIMUTHS[Math.round(azimuthDeg) % 360];
    const label = named ?? `${azimuthDeg}°`;
    return { azimuthDeg, label };
  });
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

/** 3x3x3 kutu filtresi; 1 voksel sınır korunur. */
function smoothField3D(
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
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          let sum = 0;
          const base = z * strideZ + y * strideY + x;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              const row = base + dz * strideZ + dy * strideY;
              sum += src[row - 1] + src[row] + src[row + 1];
            }
          }
          dst[base] = sum / 27;
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
 * Halka silüetlerini kesişimle oyarak kapalı (watertight) hacim üretir.
 *
 * Koordinat sözleşmesi: 0° = kamera +Z'de, modele -Z yönünde bakıyor; artan azimut
 * sağa (+X'e doğru) döner. Ekran u ekseni her kamera için sağındaki dünya yönüdür:
 * u = x·cosθ − z·sinθ.
 */
export function carvePhotoBooth(
  views: BoothView[],
  options: BoothOptions = {}
): THREE.BufferGeometry {
  const active = views.filter((v) => v.mask && v.mask.width > 1 && v.mask.height > 1);
  if (active.length < 2) {
    throw new Error('Fotogrametri kabini için en az 2 farklı açıdan temizlenmiş silüet gerekli.');
  }

  const resolution = Math.max(32, Math.min(192, Math.round(options.resolution ?? 96)));
  const smoothPasses = Math.max(0, Math.min(6, Math.round(options.smoothPasses ?? 2)));
  const sizeMm = Math.max(5, options.sizeMm ?? 180);

  const pad = 2;
  const n = resolution + pad * 2;
  const strideY = n;
  const strideZ = n * n;
  const field = new Float32Array(n * n * n);

  const cams = active.map((v) => {
    const rad = (v.azimuthDeg * Math.PI) / 180;
    return { mask: v.mask, cos: Math.cos(rad), sin: Math.sin(rad) };
  });

  const denom = Math.max(1, resolution - 1);

  for (let iz = 0; iz < resolution; iz++) {
    const pz = (iz / denom) * 2 - 1;
    for (let iy = 0; iy < resolution; iy++) {
      const vNorm = iy / denom;
      for (let ix = 0; ix < resolution; ix++) {
        const px = (ix / denom) * 2 - 1;
        let occ = 1;
        for (const cam of cams) {
          const u = px * cam.cos - pz * cam.sin;
          const u01 = (u + 1) * 0.5;
          if (u01 < 0 || u01 > 1) {
            occ = 0;
            break;
          }
          occ = Math.min(occ, sampleMaskBilinear(cam.mask, u01, vNorm));
          if (occ <= 0.005) break;
        }
        if (occ > 0) {
          field[(iz + pad) * strideZ + (iy + pad) * strideY + (ix + pad)] = occ;
        }
      }
    }
  }

  const smoothed = smoothPasses > 0 ? smoothField3D(field, n, n, n, smoothPasses) : field;
  const geometry = marchingCubes(smoothed, n, n, n, 0.48, [-1, -1, -1], [1, 1, 1]);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) {
    throw new Error(
      'Kabin silüetlerinden hacim çıkmadı. Fotoğrafların aynı nesneyi aynı kadrajda ve temiz gösterdiğinden emin olun.'
    );
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

  return geometry;
}

export interface BoothColorSource {
  azimuthDeg: number;
  /** Arkaplanı temizlenmiş görsel (foreground pikselleri renk kaynağıdır). */
  image: ImageData;
}

const NEUTRAL_COLOR: [number, number, number] = [0.72, 0.75, 0.8];

/**
 * Fotoğraflardan vertex renkleri örnekler (kabaca projektif eşleme).
 *
 * Her vertex için yüzey normaliyle en iyi hizalanan (kameraya bakan) fotoğraf seçilir;
 * o kameranın ekran koordinatı hesaplanıp piksel rengi vertex'e yazılır. GLB'de
 * vertex renkleri olarak görünür (Blender/Unity/Godot destekler); STL/3MF etkilenmez.
 */
export function sampleVertexColors(
  geometry: THREE.BufferGeometry,
  sources: BoothColorSource[]
): THREE.BufferGeometry {
  if (sources.length === 0) return geometry;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return geometry;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const height = Math.max(size.y, 1e-6);
  const half = Math.max(0.5 * Math.max(size.x, size.y, size.z), 1e-6);

  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);

  const cams = sources.map((s) => {
    const rad = (s.azimuthDeg * Math.PI) / 180;
    return { image: s.image, cos: Math.cos(rad), sin: Math.sin(rad) };
  });

  const px = new THREE.Vector3();
  const vn = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    px.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    vn.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));

    let best: { image: ImageData; cos: number; sin: number; dot: number } | null = null;
    for (const cam of cams) {
      const dot = vn.x * cam.sin + vn.z * cam.cos;
      if (!best || dot > best.dot) best = { ...cam, dot };
    }

    let r = NEUTRAL_COLOR[0];
    let g = NEUTRAL_COLOR[1];
    let b = NEUTRAL_COLOR[2];

    if (best && best.dot > 0.05) {
      const dx = px.x - center.x;
      const dz = px.z - center.z;
      const u = 0.5 + (dx * best.cos - dz * best.sin) / (2 * half);
      const v = (px.y - box.min.y) / height;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        const img = best.image;
        const sx = Math.min(img.width - 1, Math.max(0, Math.round(u * (img.width - 1))));
        const sy = Math.min(img.height - 1, Math.max(0, Math.round((1 - v) * (img.height - 1))));
        const idx = (sy * img.width + sx) * 4;
        const alpha = img.data[idx + 3] / 255;
        if (alpha > 0.35) {
          r = img.data[idx] / 255;
          g = img.data[idx + 1] / 255;
          b = img.data[idx + 2] / 255;
        }
      }
    }

    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Çekim seti için Türkçe kalite önerileri (boş dizi dönmez).
 * Sunulan azimutlara bakıp eksik açı aralıklarını ve çözünürlük durumunu bildirir.
 */
export function boothQualityHints(
  presentAzimuths: number[],
  planCount = 12
): string[] {
  const hints: string[] = [];
  const plan = buildBoothPlan(planCount);
  const norm = (a: number) => ((a % 360) + 360) % 360;
  const present = new Set(presentAzimuths.map((a) => Math.round(norm(a))));
  const missing = plan.filter((p) => !present.has(Math.round(norm(p.azimuthDeg))));

  if (present.size === 0) {
    hints.push('Henüz kabin fotoğrafı yok; kişinin etrafında 30° aralıkla 12 poz çekin.');
    return hints;
  }
  if (present.size < 4) {
    hints.push('En az 8 poz önerilir; şu an silüet oyması çok kaba kalır.');
  } else if (missing.length > 0) {
    hints.push(
      `Eksik açılar: ${missing.map((m) => m.label).join(', ')}. Bu açılar detayı belirgin artırır.`
    );
  }
  if (present.size >= 8 && missing.length === 0) {
    hints.push('Halka tam; kabin oyması için yeterli görünüm var.');
  }
  hints.push(
    'İpucu: kişi sabit dursun, kamera göğüs hizasında ve aynı uzaklıkta olsun; fon sade olsun.'
  );
  return hints;
}
