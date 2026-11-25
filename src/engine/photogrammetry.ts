import * as THREE from 'three';
import { detectFaceRegion } from './faceDetect';
import {
  analyzeMesh,
  countTriangles,
  decimateFlatRegions,
  placeOnBuildPlate,
  simplifyMesh,
  upscaleAndCompactMesh,
} from './meshRepair';
import { BinaryMask, MeshStats, ViewAngle } from './types';

export type LodTier = 'full' | '20k' | '5k';
export type ComfyPresetId =
  | 'pixal3d-int8'
  | 'pixal3d-single'
  | 'pixal3d-multiview'
  | 'hunyuan3d-mv'
  | 'sf3d'
  | 'hunyuan3d';

export type PhotogrammetryStage = 'cameras' | 'pointcloud' | 'mesh' | 'textured';

export type QualityProfileId = 'studio-ultra' | 'game-polymolly' | 'print-precision';

export interface QualityProfileSpec {
  id: QualityProfileId;
  name: string;
  tagline: string;
  resolution: number;
  smoothPasses: number;
  atlasWidth: number;
  atlasHeight: number;
  unsharpAmount: number;
  normalStrength: number;
  aoStrength: number;
  targetTriangles: number;
  decimateFlat: boolean;
  upscaleCompact: boolean;
  recommendedEngines: string[];
}

export const QUALITY_PROFILES: Record<QualityProfileId, QualityProfileSpec> = {
  'studio-ultra': {
    id: 'studio-ultra',
    name: 'Stüdyo Ultra PBR',
    tagline: 'Yüksek poligon (55K–90K △) + 2K keskin PBR doku & derin normal/AO',
    resolution: 156,
    smoothPasses: 1,
    atlasWidth: 2048,
    atlasHeight: 1024,
    unsharpAmount: 0.52,
    normalStrength: 1.45,
    aoStrength: 0.42,
    targetTriangles: 72000,
    decimateFlat: false,
    upscaleCompact: false,
    recommendedEngines: ['Blender', 'Unreal', 'Unity', 'WebGL'],
  },
  'game-polymolly': {
    id: 'game-polymolly',
    name: 'Oyun Motoru · PolyMolly',
    tagline: 'Temiz düşük-poligon bütçesi, 1:1 ölçek, anında sürükle-bırak GLB',
    resolution: 112,
    smoothPasses: 1,
    atlasWidth: 1024,
    atlasHeight: 512,
    unsharpAmount: 0.45,
    normalStrength: 1.2,
    aoStrength: 0.35,
    targetTriangles: 18000,
    decimateFlat: true,
    upscaleCompact: false,
    recommendedEngines: ['Godot', 'Unity', 'Unreal', 'Blender'],
  },
  'print-precision': {
    id: 'print-precision',
    name: '3D Baskı Hassas',
    tagline: 'Su geçirmez yüksek detay (65K–95K △) + küçük dosya 3MF/STL',
    resolution: 164,
    smoothPasses: 1,
    atlasWidth: 1024,
    atlasHeight: 512,
    unsharpAmount: 0.28,
    normalStrength: 0.95,
    aoStrength: 0.22,
    targetTriangles: 80000,
    decimateFlat: false,
    upscaleCompact: false,
    recommendedEngines: ['Bambu Studio', 'PrusaSlicer', 'Cura', 'Blender'],
  },
};

export interface VirtualCameraPose {
  angle: ViewAngle;
  label: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface DensePointCloudData {
  positions: Float32Array;
  colors: Float32Array;
  count: number;
}

export interface BakedPbrPixels {
  width: number;
  height: number;
  albedo: Uint8ClampedArray;
  normal: Uint8ClampedArray;
  roughness: Uint8ClampedArray;
  metallic: Uint8ClampedArray;
  ao: Uint8ClampedArray;
  delighted: boolean;
  sourceDetailReplace?: boolean;
}

export interface PrintabilityReport {
  overhangPct: number;
  overhangTriangles: number;
  cogXmm: number;
  cogZmm: number;
  cogStable: boolean;
  fitsBuildPlate: boolean;
  triangleQuality: number;
  silhouetteIoU: number | null;
  multiViewIoU?: Partial<Record<ViewAngle, number>>;
  verdict: 'ready' | 'needs-supports' | 'check-stability';
  summary: string;
}

export interface SubjectRoutingAdvice {
  kind: 'full-body-character' | 'bust-portrait' | 'mechanical-object';
  label: string;
  reason: string;
  recommendedProfile: QualityProfileId;
  recommendedDepthScale: number;
  recommendPedestal: boolean;
}

export interface RunManifest {
  id: string;
  timestamp: string;
  source: 'local-pbr' | 'cloud-hf' | 'comfy-gpu' | 'cad' | 'cli';
  subjectMode?: 'character' | 'head-bust' | 'face-mask';
  durationSec?: number;
  profileId: QualityProfileId;
  lod: LodTier;
  delighted: boolean;
  sourceDetailReplace?: boolean;
  hasPedestal: boolean;
  angles: string[];
  triangleCount: number;
  dimensionsMm: { width: number; height: number; depth: number };
  polyMollyScore: number;
  compatibleEngines: string[];
  printability?: PrintabilityReport | null;
}

export interface PolyMollyQaCheck {
  id:
    | 'groundedPivot'
    | 'realWorldScale'
    | 'watertightManifold'
    | 'cleanNormals'
    | 'hasPbrUv'
    | 'engineBudgetReady';
  label: string;
  passed: boolean;
  detail: string;
}

export interface PolyMollyQaReport {
  score: number;
  profileId: QualityProfileId;
  checks: PolyMollyQaCheck[];
  compatibleEngines: string[];
  triangleCount: number;
  hasUv: boolean;
  hasTexture: boolean;
}

const ANGLE_AZIMUTH_RAD: Record<ViewAngle, { az: number; el: number; label: string }> = {
  front: { az: 0, el: 0.06, label: 'Ön (0°)' },
  frontRight: { az: Math.PI * 0.25, el: 0.06, label: 'Ön-Sağ (45°)' },
  right: { az: Math.PI * 0.5, el: 0.06, label: 'Sağ (90°)' },
  backRight: { az: Math.PI * 0.75, el: 0.06, label: 'Arka-Sağ (135°)' },
  back: { az: Math.PI, el: 0.06, label: 'Arka (180°)' },
  backLeft: { az: -Math.PI * 0.75, el: 0.06, label: 'Arka-Sol (225°)' },
  left: { az: -Math.PI * 0.5, el: 0.06, label: 'Sol (270°)' },
  frontLeft: { az: -Math.PI * 0.25, el: 0.06, label: 'Ön-Sol (315°)' },
  top: { az: 0, el: Math.PI * 0.48, label: 'Üst (Tepe)' },
};

/**
 * 3DF Zephyr Aşama 1 (SfM / Samantha): Aktif açılar için 3D sanal kamera pozisyonlarını üretir.
 */
export function buildCameraRig(
  angles: ViewAngle[],
  boundingBox: THREE.Box3
): VirtualCameraPose[] {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  boundingBox.getSize(size);
  boundingBox.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z, 20) * 1.45;

  const unique = Array.from(new Set(angles));
  return unique.map((angle) => {
    const spec = ANGLE_AZIMUTH_RAD[angle] ?? ANGLE_AZIMUTH_RAD.front;
    const cosEl = Math.cos(spec.el);
    const px = center.x + Math.sin(spec.az) * cosEl * radius;
    const py = center.y + Math.sin(spec.el) * radius;
    const pz = center.z + Math.cos(spec.az) * cosEl * radius;
    return {
      angle,
      label: spec.label,
      position: [px, py, pz],
      target: [center.x, center.y, center.z],
      fov: 38,
    };
  });
}

/**
 * 3DF Zephyr Aşama 2 (MVS / Stasia): Model yüzeyinden dengeli dağılımlı renkli yoğun nokta bulutu çıkarır.
 */
export function extractDensePointCloud(
  geometry: THREE.BufferGeometry,
  maxPoints = 22000
): DensePointCloudData {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!posAttr || posAttr.count === 0) {
    return { positions: new Float32Array(0), colors: new Float32Array(0), count: 0 };
  }
  const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;

  const totalVerts = posAttr.count;
  const stride = Math.max(1, Math.floor(totalVerts / Math.max(100, maxPoints)));
  const count = Math.ceil(totalVerts / stride);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  let out = 0;
  for (let i = 0; i < totalVerts && out < count; i += stride) {
    positions[out * 3] = posAttr.getX(i);
    positions[out * 3 + 1] = posAttr.getY(i);
    positions[out * 3 + 2] = posAttr.getZ(i);
    if (colorAttr) {
      colors[out * 3] = colorAttr.getX(i);
      colors[out * 3 + 1] = colorAttr.getY(i);
      colors[out * 3 + 2] = colorAttr.getZ(i);
    } else {
      colors[out * 3] = 0.35;
      colors[out * 3 + 1] = 0.78;
      colors[out * 3 + 2] = 0.96;
    }
    out++;
  }

  return {
    positions: positions.subarray(0, out * 3),
    colors: colors.subarray(0, out * 3),
    count: out,
  };
}

/**
 * Dikiş-korumalı Çift-Yarımküre UV parametrizasyonu uygular:
 * - Ön yarımküre üçgenleri (ortalama normal.z >= 0) → atlasın sol yarısı (u ∈ [0.02, 0.48])
 * - Arka yarımküre üçgenleri (ortalama normal.z < 0) → atlasın sağ yarısı (u ∈ [0.52, 0.98])
 * Böylece yüz ve gövde ortasında asla silindirik UV dikişi kırılması oluşmaz.
 */
export function assignDualHemisphereUVs(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const nonIdx = geometry.index ? geometry.toNonIndexed() : geometry;
  nonIdx.computeBoundingBox();
  if (!nonIdx.getAttribute('normal')) nonIdx.computeVertexNormals();

  const box = nonIdx.boundingBox;
  if (!box || box.isEmpty()) return nonIdx;

  const pos = nonIdx.getAttribute('position') as THREE.BufferAttribute;
  const nrm = nonIdx.getAttribute('normal') as THREE.BufferAttribute;
  const uvs = new Float32Array(pos.count * 2);

  const sizeX = Math.max(1e-5, box.max.x - box.min.x);
  const sizeY = Math.max(1e-5, box.max.y - box.min.y);

  const padU = 0.025;
  const halfSpan = 0.5 - padU * 2;
  const padV = 0.03;
  const spanV = 1 - padV * 2;

  for (let i = 0; i < pos.count; i += 3) {
    const avgNz = (nrm.getZ(i) + nrm.getZ(i + 1) + nrm.getZ(i + 2)) / 3;
    const isFront = avgNz >= 0;

    for (let k = 0; k < 3; k++) {
      const vi = i + k;
      const nx = (pos.getX(vi) - box.min.x) / sizeX; // 0..1 (sol -> sağ)
      const ny = (pos.getY(vi) - box.min.y) / sizeY; // 0..1 (alt -> üst)
      const localU = isFront ? nx : 1 - nx;
      const u = isFront ? padU + localU * halfSpan : 0.5 + padU + localU * halfSpan;
      const v = padV + ny * spanV;
      uvs[vi * 2] = Math.max(0, Math.min(1, u));
      uvs[vi * 2 + 1] = Math.max(0, Math.min(1, v));
    }
  }

  nonIdx.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  nonIdx.setAttribute('uv2', new THREE.BufferAttribute(uvs.slice(), 2));
  return nonIdx;
}

function sampleImageRgbaBilinear(
  img: ImageData,
  uNorm: number,
  vNorm: number
): [number, number, number, number] {
  if (uNorm < 0 || uNorm > 1 || vNorm < 0 || vNorm > 1) return [0, 0, 0, 0];
  const fx = uNorm * (img.width - 1);
  const fy = (1 - vNorm) * (img.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  let r = 0;
  let g = 0;
  let b = 0;
  let wSum = 0;
  const samples: Array<[number, number, number]> = [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty],
  ];
  for (const [sx, sy, w] of samples) {
    const idx = (sy * img.width + sx) * 4;
    const a = img.data[idx + 3];
    if (a >= 90) {
      const ew = w * (a / 255);
      r += img.data[idx] * ew;
      g += img.data[idx + 1] * ew;
      b += img.data[idx + 2] * ew;
      wSum += ew;
    }
  }
  if (wSum <= 0.02) return [0, 0, 0, 0];
  return [r / wSum, g / wSum, b / wSum, Math.min(1, wSum)];
}

/**
 * Bir görselin opak piksellerinin sıkı bounding-box'ını (0..1 normalize) bulur.
 */
function findOpaqueBoundsNorm(img: ImageData): { minU: number; maxU: number; minV: number; maxV: number } {
  const { width: w, height: h, data } = img;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] >= 96) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { minU: 0, maxU: 1, minV: 0, maxV: 1 };
  }
  return {
    minU: minX / Math.max(1, w - 1),
    maxU: maxX / Math.max(1, w - 1),
    minV: 1 - maxY / Math.max(1, h - 1),
    maxV: 1 - minY / Math.max(1, h - 1),
  };
}

/**
 * Tek-geçiş BFS sınır kuyruğu (Frontier Queue) ile kenar taşması (UV bleed):
 * 2048×1024 atlasta 12 tam geçiş (~7 sn) yerine yalnızca sınır piksellerini işler (~35 ms, ~200× hızlı).
 */
function dilateAtlasBleed(rgba: Uint8ClampedArray, w: number, h: number, maxRadius = 10): void {
  const total = w * h;
  const dist = new Int16Array(total);
  dist.fill(-1);

  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  // Yalnızca opak olup en az bir boş komşusu olan sınır piksellerini kuyruğa ekle
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      if (rgba[idx * 4 + 3] >= 128) {
        dist[idx] = 0;
        const hasEmptyNeighbor =
          (x > 0 && rgba[(idx - 1) * 4 + 3] < 128) ||
          (x + 1 < w && rgba[(idx + 1) * 4 + 3] < 128) ||
          (y > 0 && rgba[(idx - w) * 4 + 3] < 128) ||
          (y + 1 < h && rgba[(idx + w) * 4 + 3] < 128);
        if (hasEmptyNeighbor) {
          queue[tail++] = idx;
        }
      }
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const curD = dist[idx];
    if (curD >= maxRadius) continue;

    const x = idx % w;
    const y = (idx - x) / w;
    const r = rgba[idx * 4];
    const g = rgba[idx * 4 + 1];
    const b = rgba[idx * 4 + 2];
    const nextD = curD + 1;

    // 4-komşu + diyagonal yayılım
    if (x > 0) {
      const n = idx - 1;
      if (dist[n] === -1) {
        dist[n] = nextD;
        rgba[n * 4] = r; rgba[n * 4 + 1] = g; rgba[n * 4 + 2] = b; rgba[n * 4 + 3] = 255;
        queue[tail++] = n;
      }
    }
    if (x + 1 < w) {
      const n = idx + 1;
      if (dist[n] === -1) {
        dist[n] = nextD;
        rgba[n * 4] = r; rgba[n * 4 + 1] = g; rgba[n * 4 + 2] = b; rgba[n * 4 + 3] = 255;
        queue[tail++] = n;
      }
    }
    if (y > 0) {
      const n = idx - w;
      if (dist[n] === -1) {
        dist[n] = nextD;
        rgba[n * 4] = r; rgba[n * 4 + 1] = g; rgba[n * 4 + 2] = b; rgba[n * 4 + 3] = 255;
        queue[tail++] = n;
      }
    }
    if (y + 1 < h) {
      const n = idx + w;
      if (dist[n] === -1) {
        dist[n] = nextD;
        rgba[n * 4] = r; rgba[n * 4 + 1] = g; rgba[n * 4 + 2] = b; rgba[n * 4 + 3] = 255;
        queue[tail++] = n;
      }
    }
  }

  for (let i = 0; i < total; i++) {
    if (dist[i] === -1) {
      rgba[i * 4] = 180;
      rgba[i * 4 + 1] = 182;
      rgba[i * 4 + 2] = 186;
      rgba[i * 4 + 3] = 255;
    }
  }
}

/**
 * PolyMolly tarzı Unsharp Mask keskinleştirme (2K doku netliği ve göz/kumaş ayrımı için).
 */
function applyUnsharpMask(rgba: Uint8ClampedArray, w: number, h: number, amount: number): void {
  if (amount <= 0.01) return;
  const copy = new Uint8ClampedArray(rgba);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const blur =
          (copy[((y - 1) * w + (x - 1)) * 4 + c] +
            copy[((y - 1) * w + x) * 4 + c] * 2 +
            copy[((y - 1) * w + (x + 1)) * 4 + c] +
            copy[(y * w + (x - 1)) * 4 + c] * 2 +
            copy[idx + c] * 4 +
            copy[(y * w + (x + 1)) * 4 + c] * 2 +
            copy[((y + 1) * w + (x - 1)) * 4 + c] +
            copy[((y + 1) * w + x) * 4 + c] * 2 +
            copy[((y + 1) * w + (x + 1)) * 4 + c]) /
          16;
        const orig = copy[idx + c];
        const sharp = orig + (orig - blur) * amount;
        rgba[idx + c] = Math.max(0, Math.min(255, Math.round(sharp)));
      }
    }
  }
}

/**
 * stabilityai/stable-fast-3d (SF3D) esintili Delighting (Işık & Gölge Arındırma):
 * Düşük frekanslı (geniş yarıçaplı) parlaklık haritasını çıkarıp hedef nötr aydınlatmaya
 * bölerek fotoğraftaki sert yönlü gölgeleri ve patlamaları temizler; böylece 3D model
 * herhangi bir HDRI/stüdyo ışığında doğal görünür.
 */
export function applyDelightingToAlbedo(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  strength = 0.62
): void {
  if (strength <= 0.01) return;
  const n = w * h;
  const lum = new Float32Array(n);
  let meanLum = 0;
  let lumCount = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    const l = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255;
    lum[i] = l;
    meanLum += l;
    lumCount++;
  }
  const targetLum = lumCount > 0 ? Math.max(0.38, Math.min(0.68, meanLum / lumCount)) : 0.52;

  // 2 geçişli ayrılabilir geniş kutu filtresi ile düşük frekanslı gölge/ışık zarfı
  const radius = Math.max(6, Math.min(28, Math.round(Math.min(w, h) * 0.045)));
  const tmp = new Float32Array(n);
  const env = new Float32Array(n);

  // Yatay geçiş
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let cnt = 0;
    for (let x = 0; x <= Math.min(w - 1, radius); x++) {
      sum += lum[row + x];
      cnt++;
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / Math.max(1, cnt);
      const addX = x + radius + 1;
      const remX = x - radius;
      if (addX < w) { sum += lum[row + addX]; cnt++; }
      if (remX >= 0) { sum -= lum[row + remX]; cnt--; }
    }
  }
  // Dikey geçiş
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let cnt = 0;
    for (let y = 0; y <= Math.min(h - 1, radius); y++) {
      sum += tmp[y * w + x];
      cnt++;
    }
    for (let y = 0; y < h; y++) {
      env[y * w + x] = sum / Math.max(1, cnt);
      const addY = y + radius + 1;
      const remY = y - radius;
      if (addY < h) { sum += tmp[addY * w + x]; cnt++; }
      if (remY >= 0) { sum -= tmp[remY * w + x]; cnt--; }
    }
  }

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    const localEnv = Math.max(0.14, env[i]);
    const rawGain = targetLum / localEnv;
    // Aşırı gürültü ve renk bozulmasını önlemek için yumuşak kazanç sınırı
    const clampedGain = Math.max(0.68, Math.min(1.52, rawGain));
    const gain = 1 + (clampedGain - 1) * strength;
    rgba[o] = Math.max(0, Math.min(255, Math.round(rgba[o] * gain)));
    rgba[o + 1] = Math.max(0, Math.min(255, Math.round(rgba[o + 1] * gain)));
    rgba[o + 2] = Math.max(0, Math.min(255, Math.round(rgba[o + 2] * gain)));
  }
}

/**
 * 3DF Zephyr + Zephyr3D + SF3D Aşama 4:
 * Çoklu açı fotoğraflarından + yakın yüz portresinden 2K Çift-Yarımküre Albedo (isteğe bağlı SF3D Delighting),
 * Sobel Tangent-Space Normal, Cilt/Kumaş Roughness, Metallic ve Ambient Occlusion haritalarını pişirir.
 */
export function bakeDualHemispherePbrAtlas(
  colorViews: Partial<Record<ViewAngle, ImageData>>,
  options: {
    faceCloseUp?: ImageData | null;
    width?: number;
    height?: number;
    unsharpAmount?: number;
    normalStrength?: number;
    aoStrength?: number;
    frontHeadMissing?: boolean;
    delight?: boolean;
    /** Local3D+ & Mesh Atölye Kaynak Ayrıntıları (Replace) modu — kenar tüyü + keskin kaynak fotoğraf aktarımı. */
    sourceDetailReplace?: boolean;
    /** Yalnızca tek yan (Sağ veya Sol) yüklüyse karşı yana simetrik doku uygula (varsayılan: true). */
    symmetricSideMirror?: boolean;
  } = {}
): BakedPbrPixels {
  const width = Math.max(256, Math.min(2048, options.width ?? 1024));
  const height = Math.max(128, Math.min(1024, options.height ?? Math.round(width / 2)));
  const sourceDetailReplace = options.sourceDetailReplace !== false;
  const unsharpAmount = sourceDetailReplace ? (options.unsharpAmount ?? 0.48) : 0;
  const normalStrength = sourceDetailReplace ? (options.normalStrength ?? 1.25) : 0.45;
  const aoStrength = sourceDetailReplace ? (options.aoStrength ?? 0.38) : 0.14;
  const delight = options.delight !== false;
  const symmetricSideMirror = options.symmetricSideMirror !== false;

  const albedo = new Uint8ClampedArray(width * height * 4);
  const normal = new Uint8ClampedArray(width * height * 4);
  const roughness = new Uint8ClampedArray(width * height * 4);
  const metallic = new Uint8ClampedArray(width * height * 4);
  const ao = new Uint8ClampedArray(width * height * 4);

  const frontImg = colorViews.front ?? colorViews.frontRight ?? colorViews.frontLeft ?? colorViews.back;
  const backImg = colorViews.back ?? colorViews.backRight ?? colorViews.backLeft ?? colorViews.front;
  const leftImg = colorViews.left ?? (symmetricSideMirror ? colorViews.right : undefined);
  const rightImg = colorViews.right ?? (symmetricSideMirror ? colorViews.left : undefined);
  const faceImg = options.faceCloseUp ?? null;

  const frontBounds = frontImg ? findOpaqueBoundsNorm(frontImg) : { minU: 0, maxU: 1, minV: 0, maxV: 1 };
  const backBounds = backImg ? findOpaqueBoundsNorm(backImg) : { minU: 0, maxU: 1, minV: 0, maxV: 1 };
  const leftBounds = leftImg ? findOpaqueBoundsNorm(leftImg) : null;
  const rightBounds = rightImg ? findOpaqueBoundsNorm(rightImg) : null;
  const faceRegion = faceImg ? detectFaceRegion(faceImg, { padding: 0.24 }) : null;

  const padU = 0.025;
  const halfSpan = 0.5 - padU * 2;
  const padV = 0.03;
  const spanV = 1 - padV * 2;

  // 1) Albedo Atlas Pişirme (Sol yarı = Ön yarımküre, Sağ yarı = Arka yarımküre)
  for (let py = 0; py < height; py++) {
    // Canvas y=0 en üst (v=1), y=height-1 en alt (v=0)
    const vAtlas = 1 - py / Math.max(1, height - 1);
    const vNorm = (vAtlas - padV) / spanV;
    if (vNorm < -0.02 || vNorm > 1.02) continue;
    const clampedV = Math.max(0, Math.min(1, vNorm));

    for (let px = 0; px < width; px++) {
      const uAtlas = px / Math.max(1, width - 1);
      const isFrontHalf = uAtlas < 0.5;
      const localU = isFrontHalf
        ? (uAtlas - padU) / halfSpan
        : (uAtlas - (0.5 + padU)) / halfSpan;
      if (localU < -0.02 || localU > 1.02) continue;
      const clampedU = Math.max(0, Math.min(1, localU));

      const primaryImg = isFrontHalf ? frontImg : backImg;
      const primaryBounds = isFrontHalf ? frontBounds : backBounds;
      if (!primaryImg) continue;

      // Başsız ön görünümde: ön vücudu %0..%82 dikey aralığına hizala, üst %18 kafayı arka saç/kafa + yüzle doldur
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (isFrontHalf && options.frontHeadMissing && clampedV > 0.78 && backImg) {
        const bu = backBounds.minU + (1 - clampedU) * (backBounds.maxU - backBounds.minU);
        const bv = backBounds.minV + clampedV * (backBounds.maxV - backBounds.minV);
        [r, g, b, a] = sampleImageRgbaBilinear(backImg, bu, bv);
      } else {
        const mappedV =
          isFrontHalf && options.frontHeadMissing
            ? Math.min(1, clampedV / 0.8)
            : clampedV;
        const su = primaryBounds.minU + clampedU * (primaryBounds.maxU - primaryBounds.minU);
        const sv = primaryBounds.minV + mappedV * (primaryBounds.maxV - primaryBounds.minV);
        [r, g, b, a] = sampleImageRgbaBilinear(primaryImg, su, sv);
      }

      // Yan kenarlarda (clampedU < 0.14 veya > 0.86) sol/sağ profil varsa yumuşak harmanla
      if (a > 0.1 && (clampedU < 0.16 || clampedU > 0.84)) {
        const edgeBlend = clampedU < 0.16 ? (0.16 - clampedU) / 0.16 : (clampedU - 0.84) / 0.16;
        const sideImg = isFrontHalf
          ? clampedU < 0.16
            ? leftImg
            : rightImg
          : clampedU < 0.16
            ? rightImg
            : leftImg;
        const sideB = sideImg === leftImg ? leftBounds : rightBounds;
        if (sideImg && sideB) {
          const su = sideB.minU + 0.5 * (sideB.maxU - sideB.minU);
          const sv = sideB.minV + clampedV * (sideB.maxV - sideB.minV);
          const [sr, sg, sb, sa] = sampleImageRgbaBilinear(sideImg, su, sv);
          if (sa > 0.25) {
            const blend = edgeBlend * 0.45 * sa;
            r = r * (1 - blend) + sr * blend;
            g = g * (1 - blend) + sg * blend;
            b = b * (1 - blend) + sb * blend;
          }
        }
      }

      // Yakın yüz portresi varsa ön yarımküre kafa bölgesine (v ∈ [0.77, 0.99]) yüksek çözünürlüklü yüz bindir
      if (isFrontHalf && faceImg && clampedV >= 0.77) {
        const fv = (clampedV - 0.78) / 0.21;
        const fu = (clampedU - 0.34) / 0.32;
        if (fu >= 0 && fu <= 1 && fv >= 0 && fv <= 1) {
          const ex = (fu - 0.5) * 2;
          const ey = (fv - 0.5) * 2;
          const dist = Math.sqrt(ex * ex + ey * ey);
          if (dist < 1.05) {
            const regX = faceRegion ? faceRegion.x : faceImg.width * 0.16;
            const regY = faceRegion ? faceRegion.y : faceImg.height * 0.08;
            const regW = faceRegion ? faceRegion.width : faceImg.width * 0.68;
            const regH = faceRegion ? faceRegion.height : faceImg.height * 0.76;
            const fsu = (regX + fu * regW) / Math.max(1, faceImg.width - 1);
            const fsv = 1 - (regY + (1 - fv) * regH) / Math.max(1, faceImg.height - 1);
            const [fr, fg, fb, fa] = sampleImageRgbaBilinear(faceImg, fsu, fsv);
            if (fa > 0.2) {
              const feather = Math.max(0, Math.min(1, (1.05 - dist) / 0.24)) * fa;
              if (a < 0.15) {
                r = fr;
                g = fg;
                b = fb;
                a = feather;
              } else {
                r = r * (1 - feather) + fr * feather;
                g = g * (1 - feather) + fg * feather;
                b = b * (1 - feather) + fb * feather;
              }
            }
          }
        }
      }

      if (a > 0.08) {
        const idx = (py * width + px) * 4;
        albedo[idx] = Math.max(0, Math.min(255, Math.round(r)));
        albedo[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
        albedo[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
        albedo[idx + 3] = 255;
      }
    }
  }

  // UV adası kenar kararmasını engellemek için hızlı BFS kenar taşması + SF3D Delighting + Local3D+/Mesh Atölye keskinleştirme
  dilateAtlasBleed(albedo, width, height, 10);
  if (delight) {
    applyDelightingToAlbedo(albedo, width, height, sourceDetailReplace ? 0.56 : 0.28);
  }
  if (sourceDetailReplace && unsharpAmount > 0.01) {
    applyUnsharpMask(albedo, width, height, unsharpAmount);
  }

  // 2) Luminance dizisi + Sobel Tangent-Space Normal Map + Cilt/Kumaş Roughness Map + AO Map
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    lum[i] = (0.299 * albedo[o] + 0.587 * albedo[o + 1] + 0.114 * albedo[o + 2]) / 255;
  }

  for (let y = 0; y < height; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(width - 1, x + 1);
      const idx = y * width + x;
      const o = idx * 4;

      // Sobel gradyanı → Tangent-space normal
      const tl = lum[ym * width + xm];
      const tc = lum[ym * width + x];
      const tr = lum[ym * width + xp];
      const ml = lum[y * width + xm];
      const mr = lum[y * width + xp];
      const bl = lum[yp * width + xm];
      const bc = lum[yp * width + x];
      const br = lum[yp * width + xp];

      const dX = (tr + 2 * mr + br - (tl + 2 * ml + bl)) * normalStrength;
      const dY = (bl + 2 * bc + br - (tl + 2 * tc + tr)) * normalStrength;
      const nz = 1.0;
      const invLen = 1 / Math.sqrt(dX * dX + dY * dY + nz * nz);
      normal[o] = Math.round(((-dX * invLen) * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round(((dY * invLen) * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round(((nz * invLen) * 0.5 + 0.5) * 255);
      normal[o + 3] = 255;

      // Zephyr3D esintili Cilt / Kumaş / Deri Roughness ayrımı (YCbCr cilt tespiti)
      const r = albedo[o];
      const g = albedo[o + 1];
      const b = albedo[o + 2];
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const isSkinTone = cb >= 77 && cb <= 135 && cr >= 133 && cr <= 180 && lum[idx] > 0.2;
      const isDarkLeatherOrHair = lum[idx] < 0.22;

      let roughVal = 0.82; // Mat pamuk/kot kumaş
      if (isSkinTone) {
        roughVal = 0.5; // Doğal cilt saten parlaklığı
      } else if (isDarkLeatherOrHair) {
        roughVal = 0.42; // Saç/ayakkabı/göz hafif yansıması
      }
      // İnce mikro-doku varyasyonu
      const localVar = Math.abs(lum[idx] - (tl + tc + tr + ml + mr + bl + bc + br) / 8);
      const finalRough = Math.max(0.24, Math.min(0.95, roughVal + localVar * 0.4));
      const roughByte = Math.round(finalRough * 255);
      roughness[o] = roughByte;
      roughness[o + 1] = roughByte;
      roughness[o + 2] = roughByte;
      roughness[o + 3] = 255;

      // SF3D esintili Metallic tahmini: düşük doygunluklu parlak/koyu sert yüzeylerde hafif metalik yanıt
      const maxCh = Math.max(r, g, b);
      const minCh = Math.min(r, g, b);
      const sat = maxCh > 0 ? (maxCh - minCh) / maxCh : 0;
      const metalVal =
        !isSkinTone && sat < 0.14 && (lum[idx] > 0.72 || (lum[idx] < 0.25 && localVar > 0.08))
          ? 0.28
          : 0.02;
      const metalByte = Math.round(metalVal * 255);
      metallic[o] = metalByte;
      metallic[o + 1] = metalByte;
      metallic[o + 2] = metalByte;
      metallic[o + 3] = 255;

      // Ambient Occlusion (kıvrım & gölge derinliği)
      const localMean = (tl + tc + tr + ml + lum[idx] + mr + bl + bc + br) / 9;
      const cavity = Math.max(0, localMean - lum[idx]);
      const aoVal = Math.max(0.45, Math.min(1.0, 1.0 - cavity * 2.4 * aoStrength - (1 - lum[idx]) * 0.18 * aoStrength));
      const aoByte = Math.round(aoVal * 255);
      ao[o] = aoByte;
      ao[o + 1] = aoByte;
      ao[o + 2] = aoByte;
      ao[o + 3] = 255;
    }
  }

  return { width, height, albedo, normal, roughness, metallic, ao, delighted: delight, sourceDetailReplace };
}

/**
 * Pişirilmiş 2K PBR piksellerinden Zephyr3D esintili karakter sahnesi (THREE.Group + MeshPhysicalMaterial) üretir.
 * Tarayıcı ortamında çalışır ve GLTFExporter ile gömülü dokulu GLB dışa aktarımına tam uyumludur.
 */
export function buildTexturedPbrGroup(
  geometry: THREE.BufferGeometry,
  baked: BakedPbrPixels,
  maxAnisotropy = 8
): THREE.Group {
  const makeCanvasTex = (pixels: Uint8ClampedArray, isSrgb: boolean): THREE.CanvasTexture => {
    const canvas = document.createElement('canvas');
    canvas.width = baked.width;
    canvas.height = baked.height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(baked.width, baked.height);
    img.data.set(pixels);
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    if (isSrgb) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = Math.max(1, maxAnisotropy);
    tex.needsUpdate = true;
    return tex;
  };

  const albedoMap = makeCanvasTex(baked.albedo, true);
  const normalMap = makeCanvasTex(baked.normal, false);
  const roughnessMap = makeCanvasTex(baked.roughness, false);
  const metalnessMap = makeCanvasTex(baked.metallic, false);
  const aoMap = makeCanvasTex(baked.ao, false);

  const uvGeo = geometry.getAttribute('uv') ? geometry.clone() : assignDualHemisphereUVs(geometry.clone());
  if (!uvGeo.getAttribute('uv2') && uvGeo.getAttribute('uv')) {
    uvGeo.setAttribute('uv2', uvGeo.getAttribute('uv').clone());
  }

  // Zephyr3D + SF3D karakter görünüm kalibrasyonu: yumuşak kumaş sheen + cilt saten yansıması + metalik harita
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: albedoMap,
    normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughnessMap,
    roughness: 0.92,
    metalnessMap,
    metalness: 0.95,
    aoMap,
    aoMapIntensity: 0.55,
    sheen: 0.32,
    sheenRoughness: 0.72,
    sheenColor: new THREE.Color(0xf1f5f9),
    clearcoat: 0.04,
    clearcoatRoughness: 0.65,
  });

  const mesh = new THREE.Mesh(uvGeo, mat);
  mesh.name = '3BStudio_PBR_Character';
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.name = '3BStudio_Photogrammetry_Scene';
  group.add(mesh);
  return group;
}

/**
 * Seçilen PolyMolly kalite profiline göre mesh'i rafine veya optimize eder.
 */
export function applyQualityProfileToGeometry(
  geometry: THREE.BufferGeometry,
  profileId: QualityProfileId
): THREE.BufferGeometry {
  const spec = QUALITY_PROFILES[profileId];
  let result: THREE.BufferGeometry;

  if (spec.decimateFlat) {
    // Oyun motoru (PolyMolly) profili: düz bölgeleri temizle, silüeti ve keskin hatları koru
    const dec = decimateFlatRegions(geometry, { planarAngleDeg: 6.5, maxPasses: 3 });
    result = dec.geometry;
  } else if (spec.upscaleCompact && countTriangles(geometry) < spec.targetTriangles * 0.72) {
    const up = upscaleAndCompactMesh(geometry, { targetDetailTriangles: spec.targetTriangles });
    result = up.geometry;
  } else {
    result = geometry.clone();
  }

  return assignDualHemisphereUVs(result);
}

/**
 * PolyMolly (polymolly.dev) tarzı deterministik 6-kontrollü kalite ve motor uyumluluk denetimi.
 */
export function evaluatePolyMollyQa(
  geometry: THREE.BufferGeometry,
  profileId: QualityProfileId,
  options: { hasTexture?: boolean; stats?: MeshStats | null } = {}
): PolyMollyQaReport {
  const stats = options.stats ?? analyzeMesh(geometry);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const tris = countTriangles(geometry);
  const hasUv = Boolean(geometry.getAttribute('uv'));
  const hasNormal = Boolean(geometry.getAttribute('normal'));
  const hasTexture = Boolean(options.hasTexture);

  const minY = box ? Math.abs(box.min.y) : 99;
  const centerX = box ? Math.abs((box.min.x + box.max.x) * 0.5) : 99;
  const centerZ = box ? Math.abs((box.min.z + box.max.z) * 0.5) : 99;
  const groundedPivot = minY <= 0.35 && centerX <= 1.2 && centerZ <= 1.2;

  const maxDim = Math.max(stats.widthMm, stats.heightMm, stats.depthMm);
  const realWorldScale = maxDim >= 10 && maxDim <= 300;
  const watertightManifold = stats.isWatertight;
  const cleanNormals = hasNormal && stats.nonManifoldEdges === 0;
  const hasPbrUv = hasUv && (hasTexture || Boolean(geometry.getAttribute('color')));
  const budgetCap = profileId === 'game-polymolly' ? 45000 : 140000;
  const engineBudgetReady = tris >= 100 && tris <= budgetCap;

  const checks: PolyMollyQaCheck[] = [
    {
      id: 'groundedPivot',
      label: 'Y=0 Taban & Merkez Pivot',
      passed: groundedPivot,
      detail: groundedPivot ? 'Model tam tabana (Y=0) ve merkeze oturdu' : `Y sapması ${minY.toFixed(1)} mm`,
    },
    {
      id: 'realWorldScale',
      label: '1:1 Gerçek Ölçek',
      passed: realWorldScale,
      detail: `${stats.widthMm.toFixed(0)} × ${stats.heightMm.toFixed(0)} × ${stats.depthMm.toFixed(0)} mm`,
    },
    {
      id: 'watertightManifold',
      label: 'Su Geçirmez Manifold',
      passed: watertightManifold,
      detail: watertightManifold ? '0 açık kenar' : `${stats.openBoundaryEdges} açık kenar`,
    },
    {
      id: 'cleanNormals',
      label: 'Temiz Yüzey Normalleri',
      passed: cleanNormals,
      detail: cleanNormals ? 'Tutarlı dışa dönük normal' : `${stats.nonManifoldEdges} bozuk kenar`,
    },
    {
      id: 'hasPbrUv',
      label: '2K UV & PBR Doku',
      passed: hasPbrUv,
      detail: hasTexture ? 'Albedo + Normal + Roughness + AO' : hasUv ? 'UV + Vertex Renk' : 'Sadece geometri',
    },
    {
      id: 'engineBudgetReady',
      label: 'Motor Poligon Bütçesi',
      passed: engineBudgetReady,
      detail: `${tris.toLocaleString('tr-TR')} üçgen`,
    },
  ];

  const passedCount = checks.filter((c) => c.passed).length;
  const score = Math.round((passedCount / checks.length) * 100);

  const compatibleEngines: string[] = [];
  if (engineBudgetReady && groundedPivot) {
    compatibleEngines.push('Blender', 'Unity', 'Godot', 'Unreal');
  }
  if (watertightManifold && realWorldScale) {
    compatibleEngines.push('3D Baskı');
  }

  return {
    score,
    profileId,
    checks,
    compatibleEngines: compatibleEngines.length > 0 ? compatibleEngines : ['Blender'],
    triangleCount: tris,
    hasUv,
    hasTexture,
  };
}

/**
 * 3DF Zephyr Masaüstü CLI otomasyon betiği (.bat / .sh) üretir.
 */
export function build3DFZephyrCliScript(options: {
  projectName?: string;
  photosDir?: string;
  outputDir?: string;
  os?: 'windows' | 'linux';
}): string {
  const proj = (options.projectName || 'karakter_3d').replace(/[^a-zA-Z0-9_-]/g, '_');
  const photos = options.photosDir || './photos';
  const out = options.outputDir || './output';
  if (options.os === 'linux') {
    return `#!/usr/bin/env bash
# 3DF Zephyr / 3BStudio Otomatik Fotogrametri CLI Betiği
set -e
mkdir -p "${out}"
# 1) 3BStudio Yerel Node CLI ile anında GLB + 3MF + PolyMolly QA:
npm run cli -- --input "${photos}" --out "${out}/${proj}" --profile studio-ultra --formats glb,3mf,stl
echo "Tamamlandı: ${out}/${proj}.glb & ${out}/${proj}.3mf"
`;
  }
  return `@echo off
REM 3DF Zephyr Masaüstü CLI + 3BStudio Otomatik Fotogrametri Betiği
set ZEPHYR="C:\\Program Files\\3DF Zephyr\\3DFZephyr.exe"
set PHOTOS=${photos}
set OUT=${out}
if not exist "%OUT%" mkdir "%OUT%"

REM Seçenek A: 3DF Zephyr yüklüyse tam Samantha -> Stasia -> Sasha -> Doku hattı:
if exist %ZEPHYR% (
  %ZEPHYR% -newproject "%OUT%\\${proj}.zep" -addphotos "%PHOTOS%" -sfm -mvs -mesh -texture -export "%OUT%\\${proj}.obj"
) else (
  REM Seçenek B: 3BStudio Yerel Fotogrametri CLI (harici kurulum gerektirmez):
  npm run cli -- --input "%PHOTOS%" --out "%OUT%\\${proj}" --profile studio-ultra --formats glb,3mf,stl
)
echo Islem tamamlandi: %OUT%\\${proj}
`;
}

/* -------------------------------------------------------------------------- *
 * crafter-station/local3d: Yüzen Gevşek Parça Temizliği (<%0.5 üçgen)
 * -------------------------------------------------------------------------- */
export function pruneLooseFragments(
  geometry: THREE.BufferGeometry,
  minFraction = 0.005
): { geometry: THREE.BufferGeometry; removedComponents: number; removedTriangles: number } {
  const nonIdx = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = nonIdx.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 9) {
    return { geometry: nonIdx, removedComponents: 0, removedTriangles: 0 };
  }
  const triCount = Math.floor(pos.count / 3);
  const col = nonIdx.getAttribute('color') as THREE.BufferAttribute | undefined;
  const uv = nonIdx.getAttribute('uv') as THREE.BufferAttribute | undefined;

  // Konuma göre (0.05 mm tolerans) bağlı bileşenleri bul (Union-Find)
  const parent = new Int32Array(triCount);
  const compSize = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) {
    parent[i] = i;
    compSize[i] = 1;
  }
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let cur = x;
    while (parent[cur] !== r) {
      const nxt = parent[cur];
      parent[cur] = r;
      cur = nxt;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (compSize[ra] < compSize[rb]) {
      parent[ra] = rb;
      compSize[rb] += compSize[ra];
    } else {
      parent[rb] = ra;
      compSize[ra] += compSize[rb];
    }
  };

  const vertOwner = new Map<number, number>();
  const q = 20; // 0.05 mm grid
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = t * 3 + k;
      // Sıfır-string sayısal paketli 51-bit koordinat anahtarı (3x daha hızlı + sıfır GC baskısı)
      const ix = Math.round(pos.getX(vi) * q) + 65536;
      const iy = Math.round(pos.getY(vi) * q) + 65536;
      const iz = Math.round(pos.getZ(vi) * q) + 65536;
      const key = (ix * 131072 + iy) * 131072 + iz;
      const prev = vertOwner.get(key);
      if (prev === undefined) {
        vertOwner.set(key, t);
      } else {
        union(prev, t);
      }
    }
  }

  let largest = 0;
  const rootCounts = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    const c = (rootCounts.get(r) ?? 0) + 1;
    rootCounts.set(r, c);
    if (c > largest) largest = c;
  }
  if (rootCounts.size <= 1) {
    return { geometry: nonIdx, removedComponents: 0, removedTriangles: 0 };
  }

  const threshold = Math.max(4, Math.floor(triCount * minFraction));
  const keepTris: number[] = [];
  let removedTriangles = 0;
  let removedComponents = 0;
  for (const [, cnt] of rootCounts.entries()) {
    if (cnt <= threshold && cnt < largest) removedComponents++;
  }
  for (let t = 0; t < triCount; t++) {
    const cnt = rootCounts.get(find(t)) ?? 0;
    if (cnt > threshold || cnt === largest) {
      keepTris.push(t);
    } else {
      removedTriangles++;
    }
  }
  if (removedTriangles === 0 || keepTris.length === 0) {
    return { geometry: nonIdx, removedComponents: 0, removedTriangles: 0 };
  }

  const outPos = new Float32Array(keepTris.length * 9);
  const outCol = col ? new Float32Array(keepTris.length * 9) : null;
  const outUv = uv ? new Float32Array(keepTris.length * 6) : null;

  for (let i = 0; i < keepTris.length; i++) {
    const t = keepTris[i];
    for (let k = 0; k < 3; k++) {
      const sv = t * 3 + k;
      const dv = i * 3 + k;
      outPos[dv * 3] = pos.getX(sv);
      outPos[dv * 3 + 1] = pos.getY(sv);
      outPos[dv * 3 + 2] = pos.getZ(sv);
      if (outCol && col) {
        outCol[dv * 3] = col.getX(sv);
        outCol[dv * 3 + 1] = col.getY(sv);
        outCol[dv * 3 + 2] = col.getZ(sv);
      }
      if (outUv && uv) {
        outUv[dv * 2] = uv.getX(sv);
        outUv[dv * 2 + 1] = uv.getY(sv);
      }
    }
  }

  nonIdx.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (outCol) out.setAttribute('color', new THREE.BufferAttribute(outCol, 3));
  if (outUv) {
    out.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
    out.setAttribute('uv2', new THREE.BufferAttribute(outUv.slice(), 2));
  }
  out.computeVertexNormals();
  return { geometry: out, removedComponents, removedTriangles };
}

/* -------------------------------------------------------------------------- *
 * sh1ftmaker/local3d-plus: Üçgen Kalitesi, Çoklu LOD (Tam/20K/5K) & Silüet-IoU
 * -------------------------------------------------------------------------- */
export function computeTriangleQuality(geometry: THREE.BufferGeometry): number {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 3) return 0;
  const idx = geometry.getIndex();
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  if (triCount === 0) return 0;

  const stride = Math.max(1, Math.floor(triCount / 25000));
  const c = 4 * Math.sqrt(3);
  let sumQ = 0;
  let samples = 0;

  for (let t = 0; t < triCount; t += stride) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

    const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
    const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
    const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const e3x = cx - bx, e3y = cy - by, e3z = cz - bz;

    const l1Sq = e1x * e1x + e1y * e1y + e1z * e1z;
    const l2Sq = e2x * e2x + e2y * e2y + e2z * e2z;
    const l3Sq = e3x * e3x + e3y * e3y + e3z * e3z;
    const denom = l1Sq + l2Sq + l3Sq;
    if (denom < 1e-12) continue;

    const crx = e1y * e2z - e1z * e2y;
    const cry = e1z * e2x - e1x * e2z;
    const crz = e1x * e2y - e1y * e2x;
    const area = 0.5 * Math.sqrt(crx * crx + cry * cry + crz * crz);
    const q = Math.min(1, (c * area) / denom);
    sumQ += q;
    samples++;
  }
  return samples > 0 ? Number((sumQ / samples).toFixed(3)) : 0;
}

/**
 * Local3D+ tarzı anlık LOD üretici:
 * Tam çözünürlüklü 2K Normal/AO haritalarıyla aynı Çift-Yarımküre UV koordinatlarını koruyarak
 * `20k` (Oyun Motoru) veya `5k` (Mobil/Web) düşük poligonlu varyant üretir.
 */
export function buildLodGeometry(
  baseGeometry: THREE.BufferGeometry,
  tier: LodTier
): THREE.BufferGeometry {
  if (tier === 'full') {
    const clone = baseGeometry.clone();
    return clone.getAttribute('uv') ? clone : assignDualHemisphereUVs(clone);
  }
  const currentTris = countTriangles(baseGeometry);
  const targetTris = tier === '20k' ? 20000 : 5000;
  if (currentTris <= targetTris * 1.05) {
    const clone = baseGeometry.clone();
    return clone.getAttribute('uv') ? clone : assignDualHemisphereUVs(clone);
  }
  const ratio = Math.max(0.06, Math.min(0.95, targetTris / Math.max(1, currentTris)));
  const simplified = simplifyMesh(baseGeometry, ratio);
  const uvReady = assignDualHemisphereUVs(simplified);
  if (uvReady !== simplified) simplified.dispose();
  return uvReady;
}

/**
 * Pixal3D / Local3D+ Silüet-IoU (%):
 * 3D mesh'i ön ortografik düzleme (X-Y) rasterize edip orijinal ön maske silüetiyle
 * kesişim / birleşim oranını (0..100%) ölçer.
 */
export function computeFrontSilhouetteIoU(
  geometry: THREE.BufferGeometry,
  frontMask?: BinaryMask | null
): number | null {
  if (!frontMask || frontMask.width < 8 || frontMask.height < 8) return null;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return null;

  const { width: mw, height: mh, data: mdata } = frontMask;
  let mMinX = mw, mMaxX = -1, mMinY = mh, mMaxY = -1;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (mdata[y * mw + x]) {
        if (x < mMinX) mMinX = x;
        if (x > mMaxX) mMaxX = x;
        if (y < mMinY) mMinY = y;
        if (y > mMaxY) mMaxY = y;
      }
    }
  }
  if (mMaxX <= mMinX || mMaxY <= mMinY) return null;

  const G = 96;
  const maskGrid = new Uint8Array(G * G);
  const meshGrid = new Uint8Array(G * G);

  const mSpanX = mMaxX - mMinX + 1;
  const mSpanY = mMaxY - mMinY + 1;
  for (let gy = 0; gy < G; gy++) {
    const sy = Math.min(mh - 1, mMinY + Math.floor((gy / G) * mSpanY));
    for (let gx = 0; gx < G; gx++) {
      const sx = Math.min(mw - 1, mMinX + Math.floor((gx / G) * mSpanX));
      if (mdata[sy * mw + sx]) maskGrid[gy * G + gx] = 1;
    }
  }

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const idx = geometry.getIndex();
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  const sizeX = Math.max(1e-5, box.max.x - box.min.x);
  const sizeY = Math.max(1e-5, box.max.y - box.min.y);

  const toGx = (x: number) => ((x - box.min.x) / sizeX) * (G - 1);
  const toGy = (y: number) => (1 - (y - box.min.y) / sizeY) * (G - 1);

  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

    const x0 = toGx(pos.getX(i0)), y0 = toGy(pos.getY(i0));
    const x1 = toGx(pos.getX(i1)), y1 = toGy(pos.getY(i1));
    const x2 = toGx(pos.getX(i2)), y2 = toGy(pos.getY(i2));

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(G - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(G - 1, Math.ceil(Math.max(y0, y1, y2)));

    const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(denom) < 1e-6) {
      const cx = Math.max(0, Math.min(G - 1, Math.round((x0 + x1 + x2) / 3)));
      const cy = Math.max(0, Math.min(G - 1, Math.round((y0 + y1 + y2) / 3)));
      meshGrid[cy * G + cx] = 1;
      continue;
    }
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const l1 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / denom;
        const l2 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / denom;
        const l3 = 1 - l1 - l2;
        if (l1 >= -0.05 && l2 >= -0.05 && l3 >= -0.05) {
          meshGrid[py * G + px] = 1;
        }
      }
    }
  }

  let inter = 0;
  let uni = 0;
  for (let i = 0; i < G * G; i++) {
    const a = maskGrid[i];
    const b = meshGrid[i];
    if (a && b) inter++;
    if (a || b) uni++;
  }
  if (uni === 0) return null;
  return Number(((inter / uni) * 100).toFixed(1));
}

/**
 * akararasul37/mesh-atolye (shape_quality.py) esintili Çok Açılı Silüet-IoU (%):
 * Ön, Arka, Sağ ve Sol ortografik izdüşümlerini ±2px hizalama aramasıyla değerlendirip
 * hem açı bazlı oranları hem ağırlıklı genel skoru (0.8 × Ortalama + 0.2 × En Zayıf Açı) döndürür.
 */
export function computeMultiViewSilhouetteIoU(
  geometry: THREE.BufferGeometry,
  masks: Partial<Record<ViewAngle, BinaryMask | null | undefined>>
): { overallIoU: number | null; perView: Partial<Record<ViewAngle, number>> } {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return { overallIoU: null, perView: {} };

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 3) return { overallIoU: null, perView: {} };
  const idx = geometry.getIndex();
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);

  const G = 80;
  const sizeX = Math.max(1e-5, box.max.x - box.min.x);
  const sizeY = Math.max(1e-5, box.max.y - box.min.y);
  const sizeZ = Math.max(1e-5, box.max.z - box.min.z);

  const viewAngles: Array<'front' | 'back' | 'right' | 'left'> = ['front', 'back', 'right', 'left'];
  const perView: Partial<Record<ViewAngle, number>> = {};
  const scores: number[] = [];

  for (const angle of viewAngles) {
    const mask = masks[angle];
    if (!mask || mask.width < 8 || mask.height < 8) continue;

    // Maske sıkı bbox'ını GxG ızgarasına örnekle
    const { width: mw, height: mh, data: mdata } = mask;
    let mMinX = mw, mMaxX = -1, mMinY = mh, mMaxY = -1;
    for (let y = 0; y < mh; y++) {
      const row = y * mw;
      for (let x = 0; x < mw; x++) {
        if (mdata[row + x]) {
          if (x < mMinX) mMinX = x;
          if (x > mMaxX) mMaxX = x;
          if (y < mMinY) mMinY = y;
          if (y > mMaxY) mMaxY = y;
        }
      }
    }
    if (mMaxX <= mMinX || mMaxY <= mMinY) continue;

    const maskGrid = new Uint8Array(G * G);
    const mSpanX = mMaxX - mMinX + 1;
    const mSpanY = mMaxY - mMinY + 1;
    for (let gy = 0; gy < G; gy++) {
      const sy = Math.min(mh - 1, mMinY + Math.floor((gy / G) * mSpanY));
      for (let gx = 0; gx < G; gx++) {
        const sx = Math.min(mw - 1, mMinX + Math.floor((gx / G) * mSpanX));
        if (mdata[sy * mw + sx]) maskGrid[gy * G + gx] = 1;
      }
    }

    // Mesh'i ilgili eksenden GxG ızgarasına rasterize et
    const meshGrid = new Uint8Array(G * G);
    const stride = Math.max(1, Math.floor(triCount / 24000));
    const projectU = (i: number): number => {
      if (angle === 'front') return ((pos.getX(i) - box.min.x) / sizeX) * (G - 1);
      if (angle === 'back') return (1 - (pos.getX(i) - box.min.x) / sizeX) * (G - 1);
      if (angle === 'right') return ((pos.getZ(i) - box.min.z) / sizeZ) * (G - 1);
      return (1 - (pos.getZ(i) - box.min.z) / sizeZ) * (G - 1);
    };
    const projectV = (i: number): number => (1 - (pos.getY(i) - box.min.y) / sizeY) * (G - 1);

    for (let t = 0; t < triCount; t += stride) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

      const x0 = projectU(i0), y0 = projectV(i0);
      const x1 = projectU(i1), y1 = projectV(i1);
      const x2 = projectU(i2), y2 = projectV(i2);

      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(G - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(G - 1, Math.ceil(Math.max(y0, y1, y2)));

      const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (Math.abs(denom) < 1e-6) {
        const cx = Math.max(0, Math.min(G - 1, Math.round((x0 + x1 + x2) / 3)));
        const cy = Math.max(0, Math.min(G - 1, Math.round((y0 + y1 + y2) / 3)));
        meshGrid[cy * G + cx] = 1;
        continue;
      }
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const l1 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / denom;
          const l2 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / denom;
          if (l1 >= -0.05 && l2 >= -0.05 && 1 - l1 - l2 >= -0.05) {
            meshGrid[py * G + px] = 1;
          }
        }
      }
    }

    // ±2px kaydırmalı en iyi örtüşme (yan profilde ayna kontrolü dahil)
    const evalBestShift = (mirrorX: boolean): number => {
      let best = 0;
      for (const dy of [-2, 0, 2]) {
        for (const dx of [-2, 0, 2]) {
          let inter = 0;
          let uni = 0;
          for (let y = 0; y < G; y++) {
            const sy = y + dy;
            for (let x = 0; x < G; x++) {
              const a = maskGrid[y * G + x];
              const sx = (mirrorX ? G - 1 - x : x) + dx;
              const b = sx >= 0 && sx < G && sy >= 0 && sy < G ? meshGrid[sy * G + sx] : 0;
              if (a && b) inter++;
              if (a || b) uni++;
            }
          }
          if (uni > 0) best = Math.max(best, inter / uni);
        }
      }
      return best;
    };

    const rawBest =
      angle === 'right' || angle === 'left'
        ? Math.max(evalBestShift(false), evalBestShift(true))
        : evalBestShift(false);
    const pct = Number((rawBest * 100).toFixed(1));
    perView[angle] = pct;
    scores.push(pct);
  }

  if (scores.length === 0) return { overallIoU: null, perView };
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const worst = Math.min(...scores);
  const overallIoU = Number((0.8 * mean + 0.2 * worst).toFixed(1));
  return { overallIoU, perView };
}

/* -------------------------------------------------------------------------- *
 * Jaco2308/Local3D_Studio: 3D Baskı Doktoru (>45° çıkıntı, CoG dengesi) & Kaide
 * -------------------------------------------------------------------------- */
export function evaluatePrintabilityDoctor(
  geometry: THREE.BufferGeometry,
  options: {
    frontMask?: BinaryMask | null;
    viewMasks?: Partial<Record<ViewAngle, BinaryMask | null | undefined>>;
    buildPlateMm?: [number, number, number];
  } = {}
): PrintabilityReport {
  const plate = options.buildPlateMm ?? [220, 220, 250];
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const idx = geometry.getIndex();
  const triCount = !pos ? 0 : idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);

  if (!box || box.isEmpty() || !pos || triCount === 0) {
    return {
      overhangPct: 0,
      overhangTriangles: 0,
      cogXmm: 0,
      cogZmm: 0,
      cogStable: false,
      fitsBuildPlate: false,
      triangleQuality: 0,
      silhouetteIoU: null,
      verdict: 'check-stability',
      summary: 'Geçerli geometri bulunamadı.',
    };
  }

  const sizeX = box.max.x - box.min.x;
  const sizeY = box.max.y - box.min.y;
  const sizeZ = box.max.z - box.min.z;
  const fitsBuildPlate = sizeX <= plate[0] && sizeZ <= plate[1] && sizeY <= plate[2];

  const baseBandY = box.min.y + Math.max(1.2, sizeY * 0.045);
  let baseMinX = Infinity, baseMaxX = -Infinity;
  let baseMinZ = Infinity, baseMaxZ = -Infinity;

  let totalArea = 0;
  let overhangArea = 0;
  let overhangTriangles = 0;
  let sumAreaX = 0;
  let sumAreaZ = 0;
  const cos45 = -Math.SQRT1_2; // ny < -0.7071 => >45° aşağı bakan çıkıntı

  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

    const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
    const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
    const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);

    const cyMid = (ay + by + cy) / 3;
    if (cyMid <= baseBandY) {
      if (ax < baseMinX) baseMinX = ax;
      if (ax > baseMaxX) baseMaxX = ax;
      if (bx < baseMinX) baseMinX = bx;
      if (bx > baseMaxX) baseMaxX = bx;
      if (cx < baseMinX) baseMinX = cx;
      if (cx > baseMaxX) baseMaxX = cx;
      if (az < baseMinZ) baseMinZ = az;
      if (az > baseMaxZ) baseMaxZ = az;
      if (bz < baseMinZ) baseMinZ = bz;
      if (bz > baseMaxZ) baseMaxZ = bz;
      if (cz < baseMinZ) baseMinZ = cz;
      if (cz > baseMaxZ) baseMaxZ = cz;
    }

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const mag = Math.hypot(nx, ny, nz);
    if (mag < 1e-9) continue;

    const area = 0.5 * mag;
    totalArea += area;
    sumAreaX += ((ax + bx + cx) / 3) * area;
    sumAreaZ += ((az + bz + cz) / 3) * area;

    // Taban temas yüzeyini (box.min.y + 0.5mm altı) çıkıntı sayma
    if (cyMid > box.min.y + 0.6 && ny / mag < cos45) {
      overhangArea += area;
      overhangTriangles++;
    }
  }

  const cogXmm = totalArea > 0 ? sumAreaX / totalArea : 0;
  const cogZmm = totalArea > 0 ? sumAreaZ / totalArea : 0;
  const marginX = Math.max(1.5, (baseMaxX - baseMinX) * 0.08);
  const marginZ = Math.max(1.5, (baseMaxZ - baseMinZ) * 0.08);
  const cogStable =
    Number.isFinite(baseMinX) &&
    cogXmm >= baseMinX - marginX &&
    cogXmm <= baseMaxX + marginX &&
    cogZmm >= baseMinZ - marginZ &&
    cogZmm <= baseMaxZ + marginZ;

  const overhangPct = totalArea > 0 ? Number(((overhangArea / totalArea) * 100).toFixed(1)) : 0;
  const triangleQuality = computeTriangleQuality(geometry);
  const multi = options.viewMasks
    ? computeMultiViewSilhouetteIoU(geometry, options.viewMasks)
    : options.frontMask
      ? { overallIoU: computeFrontSilhouetteIoU(geometry, options.frontMask), perView: {} }
      : { overallIoU: null, perView: {} };
  const silhouetteIoU = multi.overallIoU;

  let verdict: PrintabilityReport['verdict'] = 'ready';
  let summary = 'Desteksiz veya hafif destekle doğrudan basılmaya hazır.';
  if (!fitsBuildPlate) {
    verdict = 'check-stability';
    summary = `Model ${plate[0]}×${plate[1]}×${plate[2]} mm tabla sınırını aşıyor; ölçeği küçültün.`;
  } else if (!cogStable) {
    verdict = 'check-stability';
    summary = 'Ağırlık merkezi taban dışına kayıyor — Sergi Kaidesi eklemeniz önerilir.';
  } else if (overhangPct > 10) {
    verdict = 'needs-supports';
    summary = `%${overhangPct} oranında >45° sarkan yüzey var; dilimleyicide ağaç destek (Tree Support) açın.`;
  }

  return {
    overhangPct,
    overhangTriangles,
    cogXmm: Number(cogXmm.toFixed(1)),
    cogZmm: Number(cogZmm.toFixed(1)),
    cogStable,
    fitsBuildPlate,
    triangleQuality,
    silhouetteIoU,
    multiViewIoU: Object.keys(multi.perView).length > 0 ? multi.perView : undefined,
    verdict,
    summary,
  };
}

/**
 * Local3D_Studio tarzı Figür Sergi Kaidesi:
 * Modelin altına Y=0'da oturan pahlı dairesel bir sergi kaidesi ekler, böylece ince ayaklı
 * karakterler devrilmeden 3D basılabilir ve vitrin sergisine hazır olur.
 */
export function addDisplayPedestal(
  geometry: THREE.BufferGeometry,
  options: { heightMm?: number; radialSegments?: number } = {}
): THREE.BufferGeometry {
  const base = placeOnBuildPlate(geometry.index ? geometry.toNonIndexed() : geometry.clone());
  base.computeBoundingBox();
  const box = base.boundingBox!;
  const sizeX = box.max.x - box.min.x;
  const sizeZ = box.max.z - box.min.z;
  const pedH = options.heightMm ?? Math.max(3.2, Math.min(6, (box.max.y - box.min.y) * 0.045));
  const radiusBottom = Math.max(12, Math.hypot(sizeX, sizeZ) * 0.42);
  const radiusTop = radiusBottom * 0.94;
  const segs = options.radialSegments ?? 48;

  const cyl = new THREE.CylinderGeometry(radiusTop, radiusBottom, pedH, segs, 1, false);
  const ped = cyl.toNonIndexed();
  cyl.dispose();
  ped.translate(0, pedH * 0.5, 0);

  // Modeli kaidenin üstüne 0.6mm gömerek tek parça (su geçirmez birleşim) yap
  base.translate(0, pedH - 0.6, 0);

  const bPos = base.getAttribute('position') as THREE.BufferAttribute;
  const pPos = ped.getAttribute('position') as THREE.BufferAttribute;
  const totalVerts = bPos.count + pPos.count;

  const mergedPos = new Float32Array(totalVerts * 3);
  mergedPos.set(bPos.array as Float32Array, 0);
  mergedPos.set(pPos.array as Float32Array, bPos.count * 3);

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));

  const bCol = base.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (bCol) {
    const mergedCol = new Float32Array(totalVerts * 3);
    mergedCol.set(bCol.array as Float32Array, 0);
    // Kaide için koyu karbon stüdyo rengi (#1e293b linear ~ 0.045, 0.055, 0.075)
    for (let i = bPos.count; i < totalVerts; i++) {
      mergedCol[i * 3] = 0.06;
      mergedCol[i * 3 + 1] = 0.08;
      mergedCol[i * 3 + 2] = 0.11;
    }
    out.setAttribute('color', new THREE.BufferAttribute(mergedCol, 3));
  }

  out.computeVertexNormals();
  const uvOut = assignDualHemisphereUVs(out);
  if (uvOut !== out) out.dispose();
  base.dispose();
  ped.dispose();
  return placeOnBuildPlate(uvOut);
}

/* -------------------------------------------------------------------------- *
 * arashsajjadi/Local3D: Akıllı Konu Yönlendirme ("Üretmeden Önce Görür")
 * -------------------------------------------------------------------------- */
export function analyzeSubjectRouting(
  frontMask?: BinaryMask | null,
  frontImage?: ImageData | null
): SubjectRoutingAdvice {
  if (!frontMask) {
    return {
      kind: 'full-body-character',
      label: 'Tam Boy Karakter / Figür',
      reason: 'Ön maske temizlendiğinde konu tipi ve oranlar otomatik doğrulanacak.',
      recommendedProfile: 'studio-ultra',
      recommendedDepthScale: 0.72,
      recommendPedestal: true,
    };
  }
  const { width: w, height: h, data } = frontMask;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  let topPixels = 0, midPixels = 0, botPixels = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) {
    return {
      kind: 'mechanical-object',
      label: 'Genel Nesne / Parça',
      reason: 'Silüet sınırları algılanamadı; dengeli nesne derinliği öneriliyor.',
      recommendedProfile: 'print-precision',
      recommendedDepthScale: 0.75,
      recommendPedestal: false,
    };
  }

  const spanW = maxX - minX + 1;
  const spanH = maxY - minY + 1;
  const aspectHtoW = spanH / Math.max(1, spanW);

  for (let y = minY; y <= maxY; y++) {
    const ny = (y - minY) / Math.max(1, spanH - 1);
    for (let x = minX; x <= maxX; x++) {
      if (!data[y * w + x]) continue;
      if (ny < 0.33) topPixels++;
      else if (ny < 0.66) midPixels++;
      else botPixels++;
    }
  }

  const face = frontImage ? detectFaceRegion(frontImage, { padding: 0.15 }) : null;
  const faceHeightFraction = face && frontImage ? face.height / Math.max(1, frontImage.height) : 0;

  if (faceHeightFraction >= 0.32 && aspectHtoW < 1.55) {
    return {
      kind: 'bust-portrait',
      label: 'Portre / Büst Algılandı',
      reason: `Yüz oranı yüksek (%${Math.round(faceHeightFraction * 100)}); yüz rölyefi ve 2K cilt PBR dokusuna öncelik veriliyor.`,
      recommendedProfile: 'studio-ultra',
      recommendedDepthScale: 0.85,
      recommendPedestal: true,
    };
  }

  if (aspectHtoW >= 1.35 || (topPixels > 0 && botPixels > 0 && midPixels > topPixels * 0.85)) {
    return {
      kind: 'full-body-character',
      label: 'Tam Boy Karakter / Figür',
      reason: `Dikey silüet oranı ${aspectHtoW.toFixed(2)}×; kafa/gövde/uzuv organik şişirme ve denge kaidesi öneriliyor.`,
      recommendedProfile: 'studio-ultra',
      recommendedDepthScale: 0.72,
      recommendPedestal: true,
    };
  }

  return {
    kind: 'mechanical-object',
    label: 'Kompakt Nesne / Mekanik Parça',
    reason: `Yatay/kompakt oran (${aspectHtoW.toFixed(2)}×); keskin kenarlı 3D Baskı veya Oyun LOD profili ideal.`,
    recommendedProfile: 'print-precision',
    recommendedDepthScale: 0.8,
    recommendPedestal: false,
  };
}

/* -------------------------------------------------------------------------- *
 * Comfy-Org/ComfyUI Resmi BiRefNet -> MoGe -> Pixal3D / SF3D / Hunyuan3D JSON
 * -------------------------------------------------------------------------- */
export interface ComfyWeightSpec {
  id: string;
  repo: string;
  file: string;
  targetDir: string;
  downloadUrl: string;
  sizeHintGb: number;
  gated?: boolean;
}

export interface ComfyWorkflowPresetMeta {
  id: ComfyPresetId;
  name: string;
  vramGb: string;
  pipeline: string;
  weights: ComfyWeightSpec[];
}

const W_BIREFNET: ComfyWeightSpec = {
  id: 'birefnet',
  repo: 'Comfy-Org/BiRefNet',
  file: 'background_removal/birefnet.safetensors',
  targetDir: 'models/background_removal/',
  downloadUrl: 'https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors',
  sizeHintGb: 0.44,
};
const W_MOGE: ComfyWeightSpec = {
  id: 'moge2',
  repo: 'Comfy-Org/MoGe',
  file: 'geometry_estimation/moge_2_vitl_normal_fp16.safetensors',
  targetDir: 'models/geometry_estimation/',
  downloadUrl: 'https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_2_vitl_normal_fp16.safetensors',
  sizeHintGb: 0.66,
};
const W_DINOV3: ComfyWeightSpec = {
  id: 'dinov3',
  repo: 'Comfy-Org/Pixal3D',
  file: 'clip_vision/dino_v3_L_naf_fp32.safetensors',
  targetDir: 'models/clip_vision/',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/clip_vision/dino_v3_L_naf_fp32.safetensors',
  sizeHintGb: 1.22,
};
const W_PIXAL_INT8: ComfyWeightSpec = {
  id: 'pixal3d-int8',
  repo: 'Comfy-Org/Pixal3D',
  file: 'diffusion_models/pixal3d_int8_convrot.safetensors',
  targetDir: 'models/diffusion_models/',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/diffusion_models/pixal3d_int8_convrot.safetensors',
  sizeHintGb: 3.1,
};
const W_PIXAL_BF16: ComfyWeightSpec = {
  id: 'pixal3d-bf16',
  repo: 'Comfy-Org/Pixal3D',
  file: 'diffusion_models/pixal3d_bf16.safetensors',
  targetDir: 'models/diffusion_models/',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/diffusion_models/pixal3d_bf16.safetensors',
  sizeHintGb: 8.5,
};
const W_PIXAL_MV: ComfyWeightSpec = {
  id: 'pixal3d-mv',
  repo: 'Comfy-Org/Pixal3D',
  file: 'diffusion_models/pixal3d_multiview_bf16.safetensors',
  targetDir: 'models/diffusion_models/',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/diffusion_models/pixal3d_multiview_bf16.safetensors',
  sizeHintGb: 8.5,
};
const W_TRELLIS_SHAPE: ComfyWeightSpec = {
  id: 'trellis2-shape-vae',
  repo: 'Comfy-Org/Pixal3D',
  file: 'vae/trellis_2_shape_vae_bf16.safetensors',
  targetDir: 'models/vae/',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_shape_vae_bf16.safetensors',
  sizeHintGb: 1.45,
};
const W_TRELLIS_TEX: ComfyWeightSpec = {
  id: 'trellis2-tex-vae',
  repo: 'Comfy-Org/Pixal3D',
  file: 'vae/trellis_2_texture_vae_bf16.safetensors',
  targetDir: 'models/vae/',
  downloadUrl: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_texture_vae_bf16.safetensors',
  sizeHintGb: 1.45,
};
const W_SF3D: ComfyWeightSpec = {
  id: 'sf3d-model',
  repo: 'stabilityai/stable-fast-3d',
  file: 'model.safetensors',
  targetDir: 'models/checkpoints/',
  downloadUrl: 'https://huggingface.co/stabilityai/stable-fast-3d/resolve/main/model.safetensors',
  sizeHintGb: 1.7,
  gated: true,
};
const W_HY3D_2MV: ComfyWeightSpec = {
  id: 'hy3d-2mv-shape',
  repo: 'tencent/Hunyuan3D-2mv',
  file: 'hunyuan3d-dit-v2-mv/model.fp16.safetensors',
  targetDir: 'models/diffusion_models/',
  downloadUrl: 'https://huggingface.co/tencent/Hunyuan3D-2mv/resolve/main/hunyuan3d-dit-v2-mv/model.fp16.safetensors',
  sizeHintGb: 2.35,
};
const W_HY3D_21_SHAPE: ComfyWeightSpec = {
  id: 'hy3d-21-shape',
  repo: 'tencent/Hunyuan3D-2.1',
  file: 'hunyuan3d-dit-v2-1/model.fp16.ckpt',
  targetDir: 'models/diffusion_models/',
  downloadUrl: 'https://huggingface.co/tencent/Hunyuan3D-2.1/resolve/main/hunyuan3d-dit-v2-1/model.fp16.ckpt',
  sizeHintGb: 5.2,
};
const W_HY3D_2_SINGLE: ComfyWeightSpec = {
  id: 'hy3d-2-shape',
  repo: 'tencent/Hunyuan3D-2',
  file: 'hunyuan3d-dit-v2-0/model.fp16.safetensors',
  targetDir: 'models/diffusion_models/',
  downloadUrl: 'https://huggingface.co/tencent/Hunyuan3D-2/resolve/main/hunyuan3d-dit-v2-0/model.fp16.safetensors',
  sizeHintGb: 2.35,
};

export const COMFY_WORKFLOW_PRESETS: ComfyWorkflowPresetMeta[] = [
  {
    id: 'pixal3d-int8',
    name: 'Pixal3D INT8 + Local3D+ (Önerilen · 12 GB VRAM)',
    vramGb: '12 GB VRAM',
    pipeline: 'BiRefNet → MoGe-2 → DINOv3 + Pixal3D INT8 → Local3D+ Photo Replace → GLB',
    weights: [W_BIREFNET, W_MOGE, W_DINOV3, W_PIXAL_INT8, W_TRELLIS_SHAPE, W_TRELLIS_TEX],
  },
  {
    id: 'pixal3d-single',
    name: 'Pixal3D BF16 Tam Kalite (Local3D+ · 16–24 GB VRAM)',
    vramGb: '16–24 GB VRAM',
    pipeline: 'BiRefNet → MoGe-2 Normal/FoV → DINOv3 + Pixal3D BF16 → TRELLIS.2 VAE → GLB',
    weights: [W_BIREFNET, W_MOGE, W_DINOV3, W_PIXAL_BF16, W_TRELLIS_SHAPE, W_TRELLIS_TEX],
  },
  {
    id: 'hunyuan3d-mv',
    name: 'Hunyuan3D-2mv + Paint 2.1 (Mesh Atölye · 12 GB VRAM)',
    vramGb: '12 GB VRAM',
    pipeline: 'BiRefNet → Ön/Yan/Arka Pafta → Hunyuan3D-2mv + 2.1 PBR → Kaynak Ayrıntıları → GLB',
    weights: [W_BIREFNET, W_HY3D_2MV, W_HY3D_21_SHAPE],
  },
  {
    id: 'pixal3d-multiview',
    name: 'Pixal3D Çoklu Açı (4 Görünüm Turnaround · 24 GB)',
    vramGb: '24 GB VRAM',
    pipeline: '4× BiRefNet → MoGe-2 → Pixal3D MultiView BF16 → PBR Mesh → GLB',
    weights: [W_BIREFNET, W_MOGE, W_DINOV3, W_PIXAL_MV, W_TRELLIS_SHAPE, W_TRELLIS_TEX],
  },
  {
    id: 'sf3d',
    name: 'Stable Fast 3D (SF3D · 8 GB VRAM · 0.5 sn)',
    vramGb: '8 GB VRAM',
    pipeline: 'BiRefNet → StableFast3D (UV + Delighting + PBR) → SaveGLB',
    weights: [W_BIREFNET, W_SF3D],
  },
  {
    id: 'hunyuan3d',
    name: 'Hunyuan3D-2 (Tek Görsel Native · 12 GB)',
    vramGb: '12–16 GB VRAM',
    pipeline: 'BiRefNet → Hunyuan3D-2 DiT → VoxelToMesh → PBR Bake → GLB',
    weights: [W_BIREFNET, W_HY3D_2_SINGLE],
  },
];

export function buildComfyUiWorkflowJson(
  preset: ComfyPresetId,
  options: { inputFilename?: string; textureSize?: number; maxFaces?: number } = {}
): Record<string, unknown> {
  const inputFile = options.inputFilename || 'input_front.png';
  const texSize = options.textureSize ?? 2048;
  const maxFaces = options.maxFaces ?? 30000;

  if (preset === 'sf3d') {
    return {
      _meta: { generator: '3BStudio', preset, repos: ['Comfy-Org/BiRefNet', 'stabilityai/stable-fast-3d'] },
      '1': { class_type: 'LoadImage', inputs: { image: inputFile } },
      '2': { class_type: 'BiRefNetRemoveBackground', inputs: { model: 'birefnet.safetensors', image: ['1', 0] } },
      '3': {
        class_type: 'StableFast3D',
        inputs: {
          image: ['2', 0],
          mask: ['2', 1],
          texture_resolution: texSize,
          remesh_option: 'triangle',
          foreground_ratio: 0.85,
        },
      },
      '4': { class_type: 'SaveGLB', inputs: { mesh: ['3', 0], filename_prefix: '3bstudio_sf3d' } },
    };
  }

  if (preset === 'hunyuan3d' || preset === 'hunyuan3d-mv') {
    const ckpt = preset === 'hunyuan3d-mv' ? 'hunyuan3d-dit-v2-mv.safetensors' : 'hunyuan3d-dit-v2-0.safetensors';
    return {
      _meta: {
        generator: '3BStudio',
        preset,
        repos: ['Comfy-Org/BiRefNet', 'tencent/Hunyuan3D-2mv', 'tencent/Hunyuan3D-2.1'],
      },
      '1': { class_type: 'LoadImage', inputs: { image: inputFile } },
      '2': { class_type: 'BiRefNetRemoveBackground', inputs: { model: 'birefnet.safetensors', image: ['1', 0] } },
      '3': { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: ckpt } },
      '4': { class_type: 'Hunyuan3Dv2Conditioning', inputs: { clip_vision_output: ['2', 0] } },
      '5': { class_type: 'VoxelToMesh', inputs: { voxel: ['4', 0], algorithm: 'surface net', threshold: 0.6 } },
      '6': { class_type: 'SaveGLB', inputs: { mesh: ['5', 0], filename_prefix: `3bstudio_${preset}` } },
    };
  }

  const modelFile =
    preset === 'pixal3d-multiview'
      ? 'pixal3d_multiview_bf16.safetensors'
      : preset === 'pixal3d-int8'
        ? 'pixal3d_int8_convrot.safetensors'
        : 'pixal3d_bf16.safetensors';

  return {
    _meta: {
      generator: '3BStudio',
      preset,
      repos: ['Comfy-Org/BiRefNet', 'Comfy-Org/MoGe', 'Comfy-Org/Pixal3D', 'sh1ftmaker/local3d-plus'],
    },
    '1': { class_type: 'LoadImage', inputs: { image: inputFile } },
    '2': { class_type: 'BiRefNetRemoveBackground', inputs: { model: 'birefnet.safetensors', image: ['1', 0] } },
    '3': { class_type: 'MoGeGeometryEstimation', inputs: { model: 'moge_2_vitl_normal_fp16.safetensors', image: ['2', 0] } },
    '4': { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'dino_v3_L_naf_fp32.safetensors' } },
    '5': {
      class_type: 'Pixal3DGenerate',
      inputs: {
        diffusion_model: modelFile,
        shape_vae: 'trellis_2_shape_vae_bf16.safetensors',
        texture_vae: 'trellis_2_texture_vae_bf16.safetensors',
        clip_vision: ['4', 0],
        image: ['2', 0],
        mask: ['2', 1],
        depth_map: ['3', 0],
        normal_map: ['3', 1],
        multiview: preset === 'pixal3d-multiview',
      },
    },
    '6': {
      class_type: 'MeshPostprocess',
      inputs: { mesh: ['5', 0], target_face_count: maxFaces, texture_size: texSize, repair_manifold: true },
    },
    '7': { class_type: 'SaveGLB', inputs: { mesh: ['6', 0], filename_prefix: `3bstudio_${preset}` } },
  };
}

/**
 * Tek tıkla ComfyUI + sh1ftmaker/local3d-plus + seçilen Hugging Face ağırlıklarını kuran
 * ve :8188 portunda başlatan Windows (.ps1) veya Linux/macOS (.sh) kurulum betiği üretir.
 */
export function buildComfySetupScript(os: 'windows' | 'linux', presetId: ComfyPresetId): string {
  const meta = COMFY_WORKFLOW_PRESETS.find((p) => p.id === presetId) ?? COMFY_WORKFLOW_PRESETS[0];

  if (os === 'windows') {
    const dlLines = meta.weights
      .map((w) => {
        const fname = w.file.split('/').pop() || w.file;
        const winDir = w.targetDir.replace(/\//g, '\\');
        return `New-Item -ItemType Directory -Force -Path "ComfyUI\\${winDir}" | Out-Null\n` +
          `if (!(Test-Path "ComfyUI\\${winDir}${fname}")) {\n` +
          `  Write-Host "Indiriliyor: ${fname} (${w.sizeHintGb} GB)..." -ForegroundColor Cyan\n` +
          `  curl.exe -fL --retry 3 -C - "${w.downloadUrl}" -o "ComfyUI\\${winDir}${fname}"\n` +
          `}`;
      })
      .join('\n');

    return `# 3BStudio + ComfyUI + Local3D+ Otomatik Kurulum Betigi (Windows PowerShell)\n` +
      `# Paket: ${meta.name} (${meta.vramGb})\n` +
      `$ErrorActionPreference = "Stop"\n\n` +
      `if (!(Test-Path "ComfyUI")) {\n` +
      `  git clone https://github.com/Comfy-Org/ComfyUI.git ComfyUI\n` +
      `}\n` +
      `if (!(Test-Path "ComfyUI\\custom_nodes\\local3d_plus")) {\n` +
      `  git clone https://github.com/sh1ftmaker/local3d-plus.git local3d-plus\n` +
      `  Copy-Item -Recurse -Force "local3d-plus\\trellis_plus" "ComfyUI\\custom_nodes\\local3d_plus"\n` +
      `}\n` +
      `python -m pip install --upgrade pip\n` +
      `python -m pip install -r ComfyUI\\requirements.txt pymeshlab trimesh\n\n` +
      `# Resmi Hugging Face Agirliklari\n` +
      `${dlLines}\n\n` +
      `Write-Host "Kurulum tamam! ComfyUI 127.0.0.1:8188 uzerinde baslatiliyor..." -ForegroundColor Green\n` +
      `python ComfyUI\\main.py --listen 127.0.0.1 --port 8188 --enable-cors-header\n`;
  }

  const dlLinesSh = meta.weights
    .map((w) => {
      const fname = w.file.split('/').pop() || w.file;
      return `mkdir -p "ComfyUI/${w.targetDir}"\n` +
        `if [ ! -f "ComfyUI/${w.targetDir}${fname}" ]; then\n` +
        `  echo "Indiriliyor: ${fname} (${w.sizeHintGb} GB)..."\n` +
        `  curl -fL --retry 3 -C - "${w.downloadUrl}" -o "ComfyUI/${w.targetDir}${fname}"\n` +
        `fi`;
    })
    .join('\n');

  return `#!/usr/bin/env bash\n` +
    `# 3BStudio + ComfyUI + Local3D+ Otomatik Kurulum Betigi (Linux / macOS)\n` +
    `# Paket: ${meta.name} (${meta.vramGb})\n` +
    `set -euo pipefail\n\n` +
    `[ -d "ComfyUI" ] || git clone https://github.com/Comfy-Org/ComfyUI.git ComfyUI\n` +
    `if [ ! -d "ComfyUI/custom_nodes/local3d_plus" ]; then\n` +
    `  [ -d "local3d-plus" ] || git clone https://github.com/sh1ftmaker/local3d-plus.git local3d-plus\n` +
    `  ln -s "$PWD/local3d-plus/trellis_plus" ComfyUI/custom_nodes/local3d_plus\n` +
    `fi\n` +
    `python3 -m pip install --upgrade pip\n` +
    `python3 -m pip install -r ComfyUI/requirements.txt pymeshlab trimesh\n\n` +
    `${dlLinesSh}\n\n` +
    `echo "Kurulum tamam! ComfyUI http://127.0.0.1:8188 adresinde baslatiliyor..."\n` +
    `python3 ComfyUI/main.py --listen 127.0.0.1 --port 8188 --enable-cors-header\n`;
}

export function buildRunManifest(params: {
  source: RunManifest['source'];
  subjectMode?: RunManifest['subjectMode'];
  durationSec?: number;
  profileId: QualityProfileId;
  lod: LodTier;
  delighted: boolean;
  sourceDetailReplace?: boolean;
  hasPedestal: boolean;
  angles: string[];
  stats: MeshStats;
  qa: PolyMollyQaReport;
  printability?: PrintabilityReport | null;
}): RunManifest {
  return {
    id: `run_${Date.now().toString(36)}`,
    timestamp: new Date().toISOString(),
    source: params.source,
    subjectMode: params.subjectMode,
    durationSec: params.durationSec,
    profileId: params.profileId,
    lod: params.lod,
    delighted: params.delighted,
    sourceDetailReplace: params.sourceDetailReplace,
    hasPedestal: params.hasPedestal,
    angles: params.angles,
    triangleCount: params.stats.triangleCount,
    dimensionsMm: {
      width: Number(params.stats.widthMm.toFixed(1)),
      height: Number(params.stats.heightMm.toFixed(1)),
      depth: Number(params.stats.depthMm.toFixed(1)),
    },
    polyMollyScore: params.qa.score,
    compatibleEngines: params.qa.compatibleEngines,
    printability: params.printability ?? null,
  };
}
