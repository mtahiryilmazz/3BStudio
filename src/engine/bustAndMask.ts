import * as THREE from 'three';
import { marchingCubes } from './marchingCubes';
import { detectFaceRegion } from './faceDetect';
import { computeSilhouetteEDT } from './visualHull';
import { BinaryMask } from './types';

export type SubjectBuildMode = 'character' | 'head-bust' | 'face-mask';
export type MaskStyle = 'wearable-shell' | 'wall-relief';

export interface HeadBustOptions {
  /** Hedef büst yüksekliği (mm, varsayılan: 110 mm). */
  heightMm?: number;
  /** Voxel çözünürlüğü (varsayılan: 136 → ~45K-75K üçgen). */
  resolution?: number;
  /** Yüz rölyef derinliği (0.5..1.8, varsayılan: 1.0). */
  reliefScale?: number;
  /** Tam boy fotoğraftan yalnızca kafa+omuz büstünü otomatik kırp (varsayılan: true). */
  autoCropHeadShoulders?: boolean;
  /** Altına müze/heykel büst kaidesi (Y=0) ekle (varsayılan: true). */
  includeSculptedPlinth?: boolean;
}

export interface FaceMaskOptions {
  /** Giyilebilir içi oyuk kabuk ('wearable-shell') veya düz arkalı duvar rölyefi ('wall-relief'). */
  style?: MaskStyle;
  /** Gerçek yüz genişliği (mm — yetişkin ~165 mm, çocuk/dekoratif ~135 mm). */
  widthMm?: number;
  /** Kabuk et kalınlığı veya taban kalınlığı (mm, varsayılan: 3.2 mm). */
  wallThicknessMm?: number;
  /** Yüz derinlik / burun kabartma yüksekliği (mm, varsayılan: 46 mm). */
  depthMm?: number;
  /** Izgara çözünürlüğü (varsayılan: 132 → ~40K-65K üçgen). */
  gridResolution?: number;
  /** Giyilebilir maskede göz açıklıkları aç (varsayılan: true). */
  cutEyes?: boolean;
  /** Yan şakaklara lastik/kayış geçirme kulakçığı ekle (varsayılan: true). */
  addStrapLoops?: boolean;
}

function srgbToLinear(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.04045 ? clamped / 12.92 : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

function sampleMaskBilinear(mask: BinaryMask, u: number, v: number): number {
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const fx = u * (mask.width - 1);
  const fy = (1 - v) * (mask.height - 1);
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
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

function sampleColorBilinear(img: ImageData | null | undefined, u: number, v: number): [number, number, number, number] {
  if (!img || u < 0 || u > 1 || v < 0 || v > 1) return [0.76, 0.72, 0.69, 0];
  const fx = u * (img.width - 1);
  const fy = (1 - v) * (img.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  let r = 0, g = 0, b = 0, wSum = 0;
  const pts: Array<[number, number, number]> = [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty],
  ];
  for (const [px, py, w] of pts) {
    const o = (py * img.width + px) * 4;
    const a = img.data[o + 3];
    if (a >= 64) {
      const ew = w * (a / 255);
      r += img.data[o] * ew;
      g += img.data[o + 1] * ew;
      b += img.data[o + 2] * ew;
      wSum += ew;
    }
  }
  if (wSum <= 0.01) return [0.76, 0.72, 0.69, 0];
  return [r / wSum / 255, g / wSum / 255, b / wSum / 255, Math.min(1, wSum)];
}

function getMaskBBox(mask: BinaryMask): { minX: number; maxX: number; minY: number; maxY: number } {
  const { width: w, height: h, data } = mask;
  let minX = w, maxX = -1, minY = h, maxY = -1;
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
    return { minX: 0, maxX: w - 1, minY: 0, maxY: h - 1 };
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Tam boy bir maskeden (veya yakın portreden) kafa + boyun + üst omuz büst bölgesini
 * temiz kavisli heykel kesimiyle çıkarır.
 */
function cropHeadBustMask(
  mask: BinaryMask,
  colorImg?: ImageData | null,
  autoCrop = true
): {
  bustMask: BinaryMask;
  cropBox: { x0: number; y0: number; cw: number; ch: number };
  faceCenterU: number;
  faceCenterV: number;
  faceRadiusU: number;
  faceRadiusV: number;
} {
  const bb = getMaskBBox(mask);
  const spanW = Math.max(1, bb.maxX - bb.minX + 1);
  const spanH = Math.max(1, bb.maxY - bb.minY + 1);
  const aspect = spanH / spanW;

  let cropX0 = bb.minX;
  let cropX1 = bb.maxX;
  let cropY0 = bb.minY;
  let cropY1 = bb.maxY;

  // Eğer girdi tam boy figürse (boy/en > 1.55) üst %34 (kafa + boyun + üst omuz) bölgesini kırp
  if (autoCrop && aspect > 1.55) {
    const bustHeight = Math.round(spanH * 0.34);
    cropY1 = Math.min(mask.height - 1, bb.minY + bustHeight);
    // Bu dikey aralıktaki gerçek yatay sınırları bul
    let bMinX = mask.width, bMaxX = -1;
    for (let y = cropY0; y <= cropY1; y++) {
      const row = y * mask.width;
      for (let x = 0; x < mask.width; x++) {
        if (mask.data[row + x]) {
          if (x < bMinX) bMinX = x;
          if (x > bMaxX) bMaxX = x;
        }
      }
    }
    if (bMaxX > bMinX) {
      cropX0 = bMinX;
      cropX1 = bMaxX;
    }
  } else if (autoCrop && colorImg) {
    // Yakın/yarım portre: yüz algılama varsa kafanın altında dengeli göğüs payı bırak
    const face = detectFaceRegion(colorImg, { padding: 0.28 });
    if (face && face.height < colorImg.height * 0.55) {
      const scaleY = mask.height / Math.max(1, colorImg.height);
      const scaleX = mask.width / Math.max(1, colorImg.width);
      const fy0 = Math.max(bb.minY, Math.floor((face.y - face.height * 0.25) * scaleY));
      const fy1 = Math.min(bb.maxY, Math.ceil((face.y + face.height * 1.58) * scaleY));
      const fx0 = Math.max(bb.minX, Math.floor((face.x - face.width * 0.65) * scaleX));
      const fx1 = Math.min(bb.maxX, Math.ceil((face.x + face.width * 1.65) * scaleX));
      if (fy1 - fy0 > 24 && fx1 - fx0 > 20) {
        cropY0 = fy0;
        cropY1 = fy1;
        cropX0 = fx0;
        cropX1 = fx1;
      }
    }
  }

  const cw = Math.max(16, cropX1 - cropX0 + 1);
  const ch = Math.max(16, cropY1 - cropY0 + 1);
  const outW = 192;
  const outH = Math.max(96, Math.min(240, Math.round((ch / cw) * outW)));
  const outData = new Uint8Array(outW * outH);

  // Kavisli heykel büst alt kesimi (altta omuzları doğal oval tabanla toplar)
  for (let y = 0; y < outH; y++) {
    const ny = y / Math.max(1, outH - 1); // 0 = tepe, 1 = alt
    for (let x = 0; x < outW; x++) {
      const nx = x / Math.max(1, outW - 1);
      const sx = Math.min(mask.width - 1, Math.round(cropX0 + nx * (cw - 1)));
      const sy = Math.min(mask.height - 1, Math.round(cropY0 + ny * (ch - 1)));
      let v = mask.data[sy * mask.width + sx];
      if (v && ny > 0.78) {
        // Alt %22 bölgede dış omuz köşelerini klasik büst yayı gibi yumuşakça topla
        const t = (ny - 0.78) / 0.22;
        const maxHalf = 0.5 - t * 0.14;
        if (Math.abs(nx - 0.5) > maxHalf) v = 0;
      }
      outData[y * outW + x] = v;
    }
  }

  return {
    bustMask: { width: outW, height: outH, data: outData },
    cropBox: { x0: cropX0, y0: cropY0, cw, ch },
    faceCenterU: 0.5,
    faceCenterV: 0.64,
    faceRadiusU: 0.26,
    faceRadiusV: 0.28,
  };
}

/**
 * Özel **Kafa Büstü (Head Bust)** 3D Rekonstrüksiyon Motoru:
 * - Tam boy veya portre fotoğraftan otomatik kafa + boyun + üst omuz büstü çıkarır.
 * - Anatomik kafatası hacmi + yüz kabartması (burun köprüsü, elmacık, çene, alın + fotoğraf rölyefi).
 * - İsteğe bağlı Y=0 tabanlı pahlı heykel/müze büst kaidesi ve sRGB→Linear renk projeksiyonu.
 */
export function reconstructHeadBust(
  mask: BinaryMask,
  colorImg?: ImageData | null,
  options: HeadBustOptions = {}
): THREE.BufferGeometry {
  const heightMm = Math.max(30, Math.min(240, options.heightMm ?? 110));
  const resolution = Math.max(48, Math.min(176, Math.round(options.resolution ?? 136)));
  const reliefScale = Math.max(0.3, Math.min(2.0, options.reliefScale ?? 1.0));
  const autoCrop = options.autoCropHeadShoulders ?? true;
  const includePlinth = options.includeSculptedPlinth ?? true;

  const { bustMask, cropBox } = cropHeadBustMask(mask, colorImg, autoCrop);
  const { width: w, height: h, data } = bustMask;
  const edt = computeSilhouetteEDT(bustMask);

  // Kırpılmış büst için anatomik derinlik haritası (kafa küresel-oval, boyun silindirik, omuz doğal)
  const halfDepth = new Float32Array(w * h);
  const frontBias = new Float32Array(w * h);
  const normDim = Math.max(w, h);
  let maxHalfD = 0.08;

  for (let y = 0; y < h; y++) {
    const relY = y / Math.max(1, h - 1); // 0 = tepe, 1 = alt
    const row = y * w;
    let minX = w, maxX = -1, segMaxEdt = 0;
    for (let x = 0; x < w; x++) {
      if (data[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (edt[row + x] > segMaxEdt) segMaxEdt = edt[row + x];
      }
    }
    if (maxX <= minX) continue;
    const segW = maxX - minX + 1;
    const segCx = (minX + maxX) * 0.5;
    const localR = Math.max(1, Math.min(segW * 0.5, Math.max(segMaxEdt, segW * 0.32)));

    // Anatomik büst derinliği: kafa (%0..%58) derin oval (~0.92), boyun (%58..%74) ~0.78, omuz (%74..%100) ~0.48
    let depthFactor = 0.88;
    let capRatio = 0.36;
    if (relY < 0.58) {
      depthFactor = 0.94;
      capRatio = 0.38;
    } else if (relY < 0.74) {
      depthFactor = 0.76;
      capRatio = 0.24;
    } else {
      depthFactor = 0.48;
      capRatio = 0.26;
    }
    const rowCap = (capRatio * h) / normDim;

    for (let x = minX; x <= maxX; x++) {
      if (!data[row + x]) continue;
      const d = Math.min(localR, edt[row + x]);
      const t = d / localR;
      const sculpted = Math.pow(Math.max(0, 1 - Math.pow(1 - t, 1.85)), 0.55);
      let hz = Math.min(rowCap, (localR * sculpted * depthFactor) / normDim);

      // Yüz anatomisi mikro-kabartma (+Z yönünde burun köprüsü, kaş kemeri, elmacık, çene)
      let fExtra = 0;
      if (relY >= 0.14 && relY <= 0.62) {
        const fx = (x - segCx) / Math.max(4, segW * 0.46); // -1..1
        const fy = (relY - 0.36) / 0.24; // -1 (alın) .. 0 (burun) .. +1 (çene)

        // Burun köprüsü ve ucu (merkez x≈0, fy≈-0.1..+0.25)
        const noseGauss = Math.exp(-(fx * fx) / 0.042 - ((fy - 0.06) * (fy - 0.06)) / 0.11);
        // Kaş kemeri (fy≈-0.36)
        const browGauss = Math.exp(-((fy + 0.36) * (fy + 0.36)) / 0.03) * Math.exp(-(fx * fx) / 0.45);
        // Göz çukuru hafif geriye (fx≈±0.34, fy≈-0.2)
        const leftEye = Math.exp(-((fx + 0.34) ** 2) / 0.045 - ((fy + 0.19) ** 2) / 0.035);
        const rightEye = Math.exp(-((fx - 0.34) ** 2) / 0.045 - ((fy + 0.19) ** 2) / 0.035);
        // Elmacık kemikleri (fx≈±0.42, fy≈+0.08)
        const cheeks =
          (Math.exp(-((fx + 0.42) ** 2) / 0.09) + Math.exp(-((fx - 0.42) ** 2) / 0.09)) *
          Math.exp(-((fy - 0.08) ** 2) / 0.08);
        // Dudak / çene (fy≈+0.44..+0.78)
        const lips = Math.exp(-(fx * fx) / 0.12 - ((fy - 0.42) ** 2) / 0.025);
        const chin = Math.exp(-(fx * fx) / 0.14 - ((fy - 0.72) ** 2) / 0.055);

        fExtra =
          (noseGauss * 0.048 +
            browGauss * 0.015 +
            cheeks * 0.016 +
            lips * 0.018 +
            chin * 0.020 -
            (leftEye + rightEye) * 0.018) *
          reliefScale;
      }

      halfDepth[row + x] = hz;
      frontBias[row + x] = fExtra;
      if (hz + Math.abs(fExtra) > maxHalfD) maxHalfD = hz + Math.abs(fExtra);
    }
  }

  // Sıkı anizotropik voxel ızgarası
  const aspectW = w / normDim;
  const aspectH = h / normDim;
  const aspectZ = Math.min(0.95, maxHalfD * 2.18);
  const maxSpan = Math.max(aspectW, aspectH, aspectZ);

  const pad = 2;
  const resX = Math.max(32, Math.round((aspectW / maxSpan) * resolution));
  const resY = Math.max(32, Math.round((aspectH / maxSpan) * resolution));
  const resZ = Math.max(28, Math.round((aspectZ / maxSpan) * resolution));
  const nx = resX + pad * 2;
  const ny = resY + pad * 2;
  const nz = resZ + pad * 2;
  const field = new Float32Array(nx * ny * nz);
  const strideY = nx;
  const strideZ = nx * ny;

  // Fotoğraf luminance rölyef örnekleme yardımcısı
  const samplePhotoLum = (uBust: number, vBust: number): number => {
    if (!colorImg) return 0.5;
    const origU = (cropBox.x0 + uBust * (cropBox.cw - 1)) / Math.max(1, mask.width - 1);
    const origV = 1 - (cropBox.y0 + (1 - vBust) * (cropBox.ch - 1)) / Math.max(1, mask.height - 1);
    const [r, g, b, a] = sampleColorBilinear(colorImg, origU, origV);
    if (a < 0.2) return 0.5;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };

  const zStep = aspectZ / Math.max(1, resZ - 1);
  for (let y = pad; y < ny - pad; y++) {
    const vNorm = (y - pad) / Math.max(1, resY - 1); // 0 = alt, 1 = üst
    const fy = (1 - vNorm) * (h - 1);
    const py = Math.max(0, Math.min(h - 1, Math.round(fy)));
    const yOff = y * strideY;

    for (let x = pad; x < nx - pad; x++) {
      const uNorm = (x - pad) / Math.max(1, resX - 1);
      const mOcc = sampleMaskBilinear(bustMask, uNorm, vNorm);
      if (mOcc <= 0.02) continue;

      const px = Math.max(0, Math.min(w - 1, Math.round(uNorm * (w - 1))));
      const baseHz = halfDepth[py * w + px];
      const fExtra = frontBias[py * w + px];
      const lumRelief = (samplePhotoLum(uNorm, vNorm) - 0.5) * 0.024 * reliefScale;

      const frontLimit = Math.max(0.012, baseHz + fExtra + lumRelief);
      const backLimit = Math.max(0.012, baseHz * 0.94);

      for (let z = pad; z < nz - pad; z++) {
        const tz = (z - pad) / Math.max(1, resZ - 1); // 0..1
        const cz = (tz - 0.5) * aspectZ; // -aspectZ/2 .. +aspectZ/2
        const distOutside = cz >= 0 ? cz - frontLimit : -cz - backLimit;
        const zOcc = Math.max(0, Math.min(1, 0.5 - distOutside / (zStep * 1.3)));
        field[z * strideZ + yOff + x] = Math.min(mOcc, zOcc);
      }
    }
  }

  let geo = marchingCubes(
    field,
    nx,
    ny,
    nz,
    0.48,
    [-aspectW * 0.5, 0, -aspectZ * 0.5],
    [aspectW * 0.5, aspectH, aspectZ * 0.5]
  );

  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (!box || box.isEmpty()) {
    throw new Error('Kafa büstü geometrisi oluşturulamadı. Maskenin dolu olduğundan emin olun.');
  }
  const sz = new THREE.Vector3();
  const ctr = new THREE.Vector3();
  box.getSize(sz);
  box.getCenter(ctr);

  const plinthH = includePlinth ? Math.max(10, heightMm * 0.14) : 0;
  const bustTargetH = heightMm - plinthH * 0.85;
  const scale = bustTargetH / Math.max(1e-5, sz.y);

  geo.translate(-ctr.x, -box.min.y, -ctr.z);
  geo.scale(scale, scale, scale);
  geo.computeVertexNormals();
  geo.computeBoundingBox();

  // Renk + UV projeksiyonu
  const finalBox = geo.boundingBox!;
  const fSize = new THREE.Vector3();
  finalBox.getSize(fSize);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const uvs = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const uBust = (pos.getX(i) - finalBox.min.x) / Math.max(1e-5, fSize.x);
    const vBust = (pos.getY(i) - finalBox.min.y) / Math.max(1e-5, fSize.y);
    const origU = (cropBox.x0 + uBust * (cropBox.cw - 1)) / Math.max(1, mask.width - 1);
    const origV = 1 - (cropBox.y0 + (1 - vBust) * (cropBox.ch - 1)) / Math.max(1, mask.height - 1);
    const [r, g, b, a] = sampleColorBilinear(colorImg, origU, origV);
    const shade = nrm.getZ(i) >= -0.1 ? 1.0 : 0.86;
    const fr = a > 0.1 ? r * shade : 0.74;
    const fg = a > 0.1 ? g * shade : 0.71;
    const fb = a > 0.1 ? b * shade : 0.68;
    cols[i * 3] = srgbToLinear(fr);
    cols[i * 3 + 1] = srgbToLinear(fg);
    cols[i * 3 + 2] = srgbToLinear(fb);

    const isFront = nrm.getZ(i) >= 0;
    uvs[i * 2] = isFront ? 0.025 + uBust * 0.45 : 0.525 + (1 - uBust) * 0.45;
    uvs[i * 2 + 1] = 0.03 + vBust * 0.94;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('uv2', new THREE.BufferAttribute(uvs.slice(), 2));

  // İsteğe bağlı müze/heykel büst kaidesi (iki kademeli pahlı kaide + boyun sütunu)
  if (includePlinth) {
    const baseR = Math.max(18, Math.min(fSize.x * 0.46, heightMm * 0.34));
    const lowerH = plinthH * 0.58;
    const upperH = plinthH * 0.48;
    const lowerCyl = new THREE.CylinderGeometry(baseR * 0.86, baseR, lowerH, 48).toNonIndexed();
    lowerCyl.translate(0, lowerH * 0.5, 0);
    const upperCyl = new THREE.CylinderGeometry(baseR * 0.56, baseR * 0.76, upperH, 48).toNonIndexed();
    upperCyl.translate(0, lowerH + upperH * 0.5 - 0.4, 0);

    // Büstü kaideye 1.2mm gömerek sağlam ve tek parça yap
    const liftY = lowerH + upperH - 1.6;
    geo.translate(0, liftY, 0);

    const gNon = geo.index ? geo.toNonIndexed() : geo;
    const parts = [gNon, lowerCyl, upperCyl];
    const totalVerts = parts.reduce((acc, p) => acc + p.getAttribute('position').count, 0);
    const mPos = new Float32Array(totalVerts * 3);
    const mCol = new Float32Array(totalVerts * 3);
    const mUv = new Float32Array(totalVerts * 2);

    let vOff = 0;
    for (let pi = 0; pi < parts.length; pi++) {
      const p = parts[pi];
      const pPos = p.getAttribute('position') as THREE.BufferAttribute;
      const pCol = p.getAttribute('color') as THREE.BufferAttribute | undefined;
      const pUv = p.getAttribute('uv') as THREE.BufferAttribute | undefined;
      mPos.set(pPos.array as Float32Array, vOff * 3);
      if (pCol) {
        mCol.set(pCol.array as Float32Array, vOff * 3);
      } else {
        // Koyu mermer/karbon kaide rengi
        for (let k = 0; k < pPos.count; k++) {
          mCol[(vOff + k) * 3] = 0.055;
          mCol[(vOff + k) * 3 + 1] = 0.068;
          mCol[(vOff + k) * 3 + 2] = 0.09;
        }
      }
      if (pUv) {
        mUv.set(pUv.array as Float32Array, vOff * 2);
      }
      vOff += pPos.count;
    }

    if (gNon !== geo) gNon.dispose();
    geo.dispose();
    lowerCyl.dispose();
    upperCyl.dispose();

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
    merged.setAttribute('color', new THREE.BufferAttribute(mCol, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(mUv, 2));
    merged.setAttribute('uv2', new THREE.BufferAttribute(mUv.slice(), 2));
    merged.computeVertexNormals();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Özel **Yüz Maskesi (Face Mask)** 3D Rekonstrüksiyon Motoru:
 * - `wearable-shell`: Gerçek yüz kavisine oturan, arkası oyuk, ayarlanabilir et kalınlıklı (2.5–5 mm),
 *   isteğe bağlı göz açıklıkları ve yan lastik/kayış kulakçıkları bulunan su geçirmez manifold kabuk!
 * - `wall-relief`: Arkası tamamen düz (`Z=0`) duvar rölyefi / kalıp maskesi!
 */
export function reconstructFaceMask(
  mask: BinaryMask,
  colorImg?: ImageData | null,
  options: FaceMaskOptions = {}
): THREE.BufferGeometry {
  const style: MaskStyle = options.style ?? 'wearable-shell';
  const widthMm = Math.max(60, Math.min(240, options.widthMm ?? 165));
  const wallMm = Math.max(1.6, Math.min(12, options.wallThicknessMm ?? 3.2));
  const depthMm = Math.max(12, Math.min(85, options.depthMm ?? 46));
  const cutEyes = options.cutEyes ?? (style === 'wearable-shell');
  const addStrapLoops = options.addStrapLoops ?? (style === 'wearable-shell');
  const gridN = Math.max(48, Math.min(180, Math.round(options.gridResolution ?? 132)));

  // Yüz bölgesini odakla (tam boy fotoğrafta bile sadece yüz/kafa maskesini keser)
  const bb = getMaskBBox(mask);
  let fx0 = bb.minX;
  let fx1 = bb.maxX;
  let fy0 = bb.minY;
  let fy1 = bb.maxY;

  if (colorImg) {
    const face = detectFaceRegion(colorImg, { padding: 0.24 });
    if (face) {
      const sx = mask.width / Math.max(1, colorImg.width);
      const sy = mask.height / Math.max(1, colorImg.height);
      const candX0 = Math.max(0, Math.floor(face.x * sx));
      const candX1 = Math.min(mask.width - 1, Math.ceil((face.x + face.width) * sx));
      const candY0 = Math.max(0, Math.floor(face.y * sy));
      const candY1 = Math.min(mask.height - 1, Math.ceil((face.y + face.height) * sy));
      if (candX1 - candX0 >= 16 && candY1 - candY0 >= 16) {
        fx0 = candX0;
        fx1 = candX1;
        fy0 = candY0;
        fy1 = candY1;
      }
    }
  } else if ((bb.maxY - bb.minY) / Math.max(1, bb.maxX - bb.minX) > 1.55) {
    // Renksiz tam boy maskede üst %22 kafa bölgesini al
    fy1 = Math.min(mask.height - 1, Math.round(bb.minY + (bb.maxY - bb.minY) * 0.22));
  }

  const spanW = Math.max(12, fx1 - fx0 + 1);
  const spanH = Math.max(12, fy1 - fy0 + 1);
  const aspectH = Math.max(0.85, Math.min(1.55, spanH / spanW));
  const heightMm = widthMm * aspectH;

  const cols = gridN;
  const rows = Math.max(48, Math.round(gridN * aspectH));
  const stride = cols + 1;

  // Hücre aktivasyon haritası (oval yüz maskesi + fotoğraf silüeti + isteğe bağlı göz boşlukları + kayış kulakçıkları)
  const active = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const ny = (r + 0.5) / rows; // 0 = üst, 1 = alt
    const ey = (ny - 0.5) * 2; // -1..+1
    for (let c = 0; c < cols; c++) {
      const nx = (c + 0.5) / cols; // 0 = sol, 1 = sağ
      const ex = (nx - 0.5) * 2; // -1..+1

      // Maske oval zarfı (çene hafif daralan gerçekçi yüz ovali)
      const jawTaper = ey > 0 ? 1 - 0.22 * ey * ey : 1 - 0.06 * ey * ey;
      const ovalDist = Math.hypot(ex / Math.max(0.55, jawTaper), ey);

      const uOrig = (fx0 + nx * (spanW - 1)) / Math.max(1, mask.width - 1);
      const vOrig = 1 - (fy0 + ny * (spanH - 1)) / Math.max(1, mask.height - 1);
      const inPhotoMask = sampleMaskBilinear(mask, uOrig, vOrig) >= 0.35;

      let inside = ovalDist <= 0.96 && (inPhotoMask || ovalDist <= 0.84);

      // Yan lastik/kayış kulakçıkları (şakak hizasında sol/sağ çıkıntı + orta delik)
      if (addStrapLoops && style === 'wearable-shell') {
        const earY = (ny - 0.46) / 0.085;
        const leftTab = ex <= -0.82 && ex >= -1.04 && Math.abs(earY) <= 1.0;
        const rightTab = ex >= 0.82 && ex <= 1.04 && Math.abs(earY) <= 1.0;
        if (leftTab || rightTab) {
          const tabX = Math.abs(ex) - 0.95;
          const inStrapHole = Math.hypot(tabX / 0.042, earY / 0.46) < 1.0;
          inside = !inStrapHole;
        }
      }

      // Giyilebilir maskede simetrik göz açıklıkları
      if (inside && cutEyes && style === 'wearable-shell') {
        const leftEyeD = Math.hypot((ex + 0.34) / 0.165, (ey + 0.16) / 0.095);
        const rightEyeD = Math.hypot((ex - 0.34) / 0.165, (ey + 0.16) / 0.095);
        if (leftEyeD < 1.0 || rightEyeD < 1.0) {
          inside = false;
        }
      }

      active[r * cols + c] = inside ? 1 : 0;
    }
  }

  // Ön ve arka Z yükseklik alanlarını (köşe bazlı) hesapla
  const vertCount2D = (cols + 1) * (rows + 1);
  const zFront = new Float32Array(vertCount2D);
  const zBack = new Float32Array(vertCount2D);
  const vColors = new Float32Array(vertCount2D * 3);
  const vUvs = new Float32Array(vertCount2D * 2);

  for (let r = 0; r <= rows; r++) {
    const ny = r / rows;
    const ey = (ny - 0.5) * 2;
    for (let c = 0; c <= cols; c++) {
      const nx = c / cols;
      const ex = (nx - 0.5) * 2;
      const vi = r * stride + c;

      // 1) Anatomik yüz kubbesi: yanaklar geriye sarılır, merkez öne çıkar
      const clampedEx = Math.max(-1, Math.min(1, ex));
      const clampedEy = Math.max(-1, Math.min(1, ey));
      const archX = Math.cos(clampedEx * Math.PI * 0.46);
      const archY = Math.cos(clampedEy * Math.PI * 0.42);
      const baseDome = Math.max(0, archX * archY) * depthMm * 0.68;

      // 2) Yüz özellikleri (burun köprüsü + kaş kemeri + elmacık + dudak/çene)
      const nose = Math.exp(-(ex * ex) / 0.036 - ((ey - 0.04) * (ey - 0.04)) / 0.11) * depthMm * 0.34;
      const brow = Math.exp(-((ey + 0.32) ** 2) / 0.025) * Math.exp(-(ex * ex) / 0.42) * depthMm * 0.08;
      const cheeks =
        (Math.exp(-((ex + 0.44) ** 2) / 0.085) + Math.exp(-((ex - 0.44) ** 2) / 0.085)) *
        Math.exp(-((ey - 0.08) ** 2) / 0.09) *
        depthMm *
        0.09;
      const lips = Math.exp(-(ex * ex) / 0.11 - ((ey - 0.42) ** 2) / 0.024) * depthMm * 0.10;
      const chin = Math.exp(-(ex * ex) / 0.12 - ((ey - 0.72) ** 2) / 0.05) * depthMm * 0.11;

      // 3) Fotoğraf parlaklığından ince kabartma
      const uOrig = Math.max(0, Math.min(1, (fx0 + nx * (spanW - 1)) / Math.max(1, mask.width - 1)));
      const vOrig = Math.max(0, Math.min(1, 1 - (fy0 + ny * (spanH - 1)) / Math.max(1, mask.height - 1)));
      const [cr, cg, cb, ca] = sampleColorBilinear(colorImg, uOrig, vOrig);
      const lum = ca > 0.15 ? 0.299 * cr + 0.587 * cg + 0.114 * cb : 0.52;
      const photoRelief = (lum - 0.5) * depthMm * 0.14;

      const frontZ = Math.max(wallMm + 0.8, wallMm + baseDome + nose + brow + cheeks + lips + chin + photoRelief);
      // Giyilebilir kabukta arka yüzey ön yüzü wallMm mesafeden izler (içi oyuk!); duvar rölyefinde arka düz Z=0!
      const backZ = style === 'wearable-shell' ? Math.max(0, frontZ - wallMm) : 0;

      zFront[vi] = frontZ;
      zBack[vi] = backZ;

      const rr = ca > 0.1 ? cr : 0.82;
      const gg = ca > 0.1 ? cg : 0.77;
      const bbCol = ca > 0.1 ? cb : 0.73;
      vColors[vi * 3] = srgbToLinear(rr);
      vColors[vi * 3 + 1] = srgbToLinear(gg);
      vColors[vi * 3 + 2] = srgbToLinear(bbCol);

      vUvs[vi * 2] = 0.025 + nx * 0.45;
      vUvs[vi * 2 + 1] = 0.03 + (1 - ny) * 0.94;
    }
  }

  // Su geçirmez kapalı kabuk üçgenlerini oluştur: Ön yüzey + Arka yüzey + Tüm açık kenar duvarları
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];

  const vx = (c: number) => (c / cols - 0.5) * widthMm;
  const vy = (r: number) => (1 - r / rows) * heightMm;

  const pushTri = (
    ax: number, ay: number, az: number, ia: number,
    bx: number, by: number, bz: number, ib: number,
    cx: number, cy: number, cz: number, ic: number,
    isBackFace = false
  ) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const dim = isBackFace ? 0.72 : 1.0;
    colors.push(
      vColors[ia * 3] * dim, vColors[ia * 3 + 1] * dim, vColors[ia * 3 + 2] * dim,
      vColors[ib * 3] * dim, vColors[ib * 3 + 1] * dim, vColors[ib * 3 + 2] * dim,
      vColors[ic * 3] * dim, vColors[ic * 3 + 1] * dim, vColors[ic * 3 + 2] * dim
    );
    const uShift = isBackFace ? 0.5 : 0;
    uvs.push(
      Math.min(0.99, vUvs[ia * 2] + uShift), vUvs[ia * 2 + 1],
      Math.min(0.99, vUvs[ib * 2] + uShift), vUvs[ib * 2 + 1],
      Math.min(0.99, vUvs[ic * 2] + uShift), vUvs[ic * 2 + 1]
    );
  };

  const pushWallQuad = (
    c0: number, r0: number,
    c1: number, r1: number
  ) => {
    const i0 = r0 * stride + c0;
    const i1 = r1 * stride + c1;
    const x0 = vx(c0), y0 = vy(r0);
    const x1 = vx(c1), y1 = vy(r1);
    const f0 = zFront[i0], b0 = zBack[i0];
    const f1 = zFront[i1], b1 = zBack[i1];
    // Dışa bakan kenar duvarı (2 üçgen)
    pushTri(x0, y0, f0, i0, x0, y0, b0, i0, x1, y1, b1, i1, true);
    pushTri(x0, y0, f0, i0, x1, y1, b1, i1, x1, y1, f1, i1, true);
  };

  const isCellActive = (c: number, r: number) =>
    c >= 0 && c < cols && r >= 0 && r < rows && active[r * cols + c] === 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!active[r * cols + c]) continue;
      const i00 = r * stride + c;
      const i10 = r * stride + (c + 1);
      const i01 = (r + 1) * stride + c;
      const i11 = (r + 1) * stride + (c + 1);

      const x0 = vx(c), x1 = vx(c + 1);
      const y0 = vy(r), y1 = vy(r + 1);

      // Ön (+Z) yüzey (saat yönü tersi => +Z normali)
      pushTri(x0, y0, zFront[i00], i00, x0, y1, zFront[i01], i01, x1, y1, zFront[i11], i11, false);
      pushTri(x0, y0, zFront[i00], i00, x1, y1, zFront[i11], i11, x1, y0, zFront[i10], i10, false);

      // Arka (-Z) yüzey (ters sargı => -Z normali)
      pushTri(x0, y0, zBack[i00], i00, x1, y1, zBack[i11], i11, x0, y1, zBack[i01], i01, true);
      pushTri(x0, y0, zBack[i00], i00, x1, y0, zBack[i10], i10, x1, y1, zBack[i11], i11, true);

      // Açık kenarlara su geçirmez yan duvar dik (dış sınır + göz delikleri + kayış delikleri!)
      if (!isCellActive(c, r - 1)) pushWallQuad(c + 1, r, c, r);       // Üst kenar (+Y normali)
      if (!isCellActive(c, r + 1)) pushWallQuad(c, r + 1, c + 1, r + 1); // Alt kenar (-Y normali)
      if (!isCellActive(c - 1, r)) pushWallQuad(c, r, c, r + 1);       // Sol kenar (-X normali)
      if (!isCellActive(c + 1, r)) pushWallQuad(c + 1, r + 1, c + 1, r); // Sağ kenar (+X normali)
    }
  }

  if (positions.length === 0) {
    throw new Error('Yüz maskesi üretilemedi. Fotoğraf maskesinin dolu olduğundan emin olun.');
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('uv2', new THREE.Float32BufferAttribute(uvs.slice(), 2));

  geo.computeBoundingBox();
  const b = geo.boundingBox!;
  const ctr = new THREE.Vector3();
  b.getCenter(ctr);
  // X ve Z'de merkeze, Y=0 tabanına oturt
  geo.translate(-ctr.x, -b.min.y, -ctr.z);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  return geo;
}
