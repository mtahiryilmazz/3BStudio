import * as THREE from 'three';

/**
 * Karakter sheet'lerinde yüz yakın çekimini otomatik bulma.
 *
 * Yaklaşım: ten rengi (YCbCr) segmentasyonu → bağlı bileşenler → en olası yüz
 * bölgesi (alansal büyüklük, en-boy oranı, üst yarıda olma, doluluk). Saf
 * piksel matematiği; DOM yok. Tarayıcıda `FaceDetector` varsa çağıran taraf
 * onu tercih edebilir, bu fonksiyon yedek yoldur.
 */

export interface FaceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1 arası güven; büyük bileşen + makul oran + üst konum ile artar. */
  confidence: number;
}

export interface FaceDetectOptions {
  /** Ten maskesi için minimum parlaklık (0..255). */
  minLuminance?: number;
  /** Bölge en-boy oranı kabul aralığı (genişlik/yükseklik). */
  minAspect?: number;
  maxAspect?: number;
  /** Görüntünün üst yüzdesinde olma koşulu (0..1). */
  maxTopRatio?: number;
  /** Kenarlara eklenecek pay (bölge boyutunun oranı). */
  padding?: number;
}

const DEFAULTS: Required<FaceDetectOptions> = {
  minLuminance: 50,
  minAspect: 0.45,
  maxAspect: 1.9,
  maxTopRatio: 0.75,
  padding: 0.14,
};

/** YCbCr ten rengi aralığı (geniş tutuldu: açık ten → koyu ten). */
function isSkin(r: number, g: number, b: number, minLuminance: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < minLuminance) return false;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb >= 77 && cb <= 135 && cr >= 133 && cr <= 180;
}

interface Component {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  count: number;
}

/**
 * Ten rengi bölgelerini bağlı bileşen olarak toplar (grid üzerinde BFS).
 * Performans için görüntü en fazla ~320 px genişliğe indirgenerek taranır.
 */
function findSkinComponents(
  data: ImageData,
  minLuminance: number
): { components: Component[]; scale: number; gw: number; gh: number } {
  const { width, height, data: px } = data;
  const scale = Math.min(1, 320 / Math.max(width, height));
  const gw = Math.max(16, Math.round(width * scale));
  const gh = Math.max(16, Math.round(height * scale));

  const skin = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const sy = Math.min(height - 1, Math.floor(gy / scale));
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(width - 1, Math.floor(gx / scale));
      const i = (sy * width + sx) * 4;
      if (px[i + 3] < 128) continue;
      if (isSkin(px[i], px[i + 1], px[i + 2], minLuminance)) {
        skin[gy * gw + gx] = 1;
      }
    }
  }

  const visited = new Uint8Array(gw * gh);
  const components: Component[] = [];
  const queue: number[] = [];

  for (let start = 0; start < skin.length; start++) {
    if (!skin[start] || visited[start]) continue;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;
    const comp: Component = {
      minX: gw,
      maxX: 0,
      minY: gh,
      maxY: 0,
      count: 0,
    };
    while (queue.length > 0) {
      const idx = queue.pop() as number;
      const x = idx % gw;
      const y = (idx - x) / gw;
      comp.count += 1;
      if (x < comp.minX) comp.minX = x;
      if (x > comp.maxX) comp.maxX = x;
      if (y < comp.minY) comp.minY = y;
      if (y > comp.maxY) comp.maxY = y;
      // 4-komşuluk
      const neighbours = [idx - 1, idx + 1, idx - gw, idx + gw];
      for (let n = 0; n < neighbours.length; n++) {
        const ni = neighbours[n];
        if (ni < 0 || ni >= skin.length) continue;
        if (Math.abs((ni % gw) - x) > 1) continue; // satır taşması
        if (skin[ni] && !visited[ni]) {
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }
    components.push(comp);
  }

  return { components, scale, gw, gh };
}

/**
 * En olası yüz bölgesini döndürür; ten bölgesi bulunamazsa null.
 */
export function detectFaceRegion(
  data: ImageData,
  options: FaceDetectOptions = {}
): FaceRegion | null {
  const opts = { ...DEFAULTS, ...options };
  const { width, height } = data;
  if (width < 24 || height < 24) return null;

  const { components, scale, gw, gh } = findSkinComponents(data, opts.minLuminance);
  const imageArea = gw * gh;

  let best: { comp: Component; score: number } | null = null;
  for (const comp of components) {
    const cw = comp.maxX - comp.minX + 1;
    const ch = comp.maxY - comp.minY + 1;
    if (cw < 6 || ch < 6) continue;
    const aspect = cw / ch;
    if (aspect < opts.minAspect || aspect > opts.maxAspect) continue;
    const areaRatio = comp.count / imageArea;
    if (areaRatio < 0.002) continue;
    const centerY = (comp.minY + comp.maxY) / 2 / gh;
    if (centerY > opts.maxTopRatio) continue;

    const fill = comp.count / (cw * ch);
    const aspectScore = 1 - Math.min(1, Math.abs(aspect - 0.78) / 1.1);
    const positionScore = 1 - Math.min(1, centerY);
    const sizeScore = Math.min(1, Math.sqrt(areaRatio) * 6);
    const score = aspectScore * 0.45 + positionScore * 0.2 + sizeScore * 0.2 + fill * 0.15;

    if (!best || score > best.score) best = { comp, score };
  }

  if (!best) return null;

  const cw = (best.comp.maxX - best.comp.minX + 1) / scale;
  const ch = (best.comp.maxY - best.comp.minY + 1) / scale;
  const padX = cw * opts.padding;
  const padY = ch * opts.padding;
  const x = Math.max(0, best.comp.minX / scale - padX);
  const y = Math.max(0, best.comp.minY / scale - padY);
  const x2 = Math.min(width, best.comp.maxX / scale + padX);
  const y2 = Math.min(height, best.comp.maxY / scale + padY);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(8, Math.round(x2 - x)),
    height: Math.max(8, Math.round(y2 - y)),
    confidence: Math.max(0.05, Math.min(1, best.score)),
  };
}

/**
 * Yüz yakın çekimini, modelin kafa bölgesine vertex rengi olarak bindirir.
 *
 * Kafa bandı: model yüksekliğinin üst `headHeightRatio` kadarı. Yalnızca öne
 * bakan (normal.z > 0) vertexler boyanır; diğerleri mevcut rengini korur.
 * `color` attribute yoksa nötr gri ile oluşturulur.
 */
export function paintHeadFromFace(
  geometry: THREE.BufferGeometry,
  face: ImageData,
  options: { headHeightRatio?: number; minFacing?: number } = {}
): THREE.BufferGeometry {
  const headHeightRatio = Math.max(0.08, Math.min(0.5, options.headHeightRatio ?? 0.22));
  const minFacing = options.minFacing ?? 0.12;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return geometry;
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  const size = new THREE.Vector3();
  box.getSize(size);
  const height = Math.max(size.y, 1e-6);
  const headMinY = box.max.y - height * headHeightRatio;
  const centerX = (box.min.x + box.max.x) / 2;
  const halfWidth = Math.max(size.x, size.z) * 0.5 || 1;

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const existing = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const r = existing ? existing.getX(i) : 0.72;
    const g = existing ? existing.getY(i) : 0.75;
    const b = existing ? existing.getZ(i) : 0.8;
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < headMinY) continue;
    const nz = nrm.getZ(i);
    if (nz < minFacing) continue;

    const dx = pos.getX(i) - centerX;
    const dy = pos.getY(i) - headMinY;
    const u = 0.5 + dx / (2 * halfWidth);
    const v = dy / (height * headHeightRatio);
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;

    const sx = Math.min(face.width - 1, Math.max(0, Math.round(u * (face.width - 1))));
    const sy = Math.min(face.height - 1, Math.max(0, Math.round((1 - v) * (face.height - 1))));
    const idx = (sy * face.width + sx) * 4;
    if (face.data[idx + 3] < 96) continue;

    colors[i * 3] = face.data[idx] / 255;
    colors[i * 3 + 1] = face.data[idx + 1] / 255;
    colors[i * 3 + 2] = face.data[idx + 2] / 255;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}
