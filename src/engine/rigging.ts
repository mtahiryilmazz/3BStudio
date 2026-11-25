import * as THREE from 'three';

/**
 * Basit otomatik biped rig üretimi (oyun motoru kullanımı için).
 *
 * Girdi: viewport eksen düzeninde (Y-up, taban y=0) milimetre ölçekli BufferGeometry.
 * Çıktı: bounding box'a otomatik oturtulan iskelet, kutu-bölge tabanlı skin
 * ağırlıkları ve bağlanmış SkinnedMesh. Matematik saf three.js'tir; DOM kullanılmaz.
 */

export const RIG_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'upperArmL',
  'lowerArmL',
  'handL',
  'shoulderR',
  'upperArmR',
  'lowerArmR',
  'handR',
  'upperLegL',
  'lowerLegL',
  'footL',
  'upperLegR',
  'lowerLegR',
  'footR',
] as const;

export type RigBoneName = (typeof RIG_BONES)[number];

export interface RigResult {
  rootBone: THREE.Bone;
  skeleton: THREE.Skeleton;
  skinnedMesh: THREE.SkinnedMesh;
  /** Rig'in oturtulduğu kaynak geometrinin yüksekliği (mm). */
  heightMm: number;
}

function makeBone(name: RigBoneName, position: THREE.Vector3, parent: THREE.Bone | null): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.copy(position);
  if (parent) parent.add(bone);
  return bone;
}

/**
 * Biped iskeleti: bbox yüksekliğine oranlı eklem yerleri, gövde bbox merkezinde.
 */
export function buildBipedSkeleton(box: THREE.Box3): { rootBone: THREE.Bone; bones: THREE.Bone[]; heightMm: number } {
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const H = Math.max(size.y, 1);
  const W = Math.max(size.x, 1);
  const cx = center.x;
  const cz = center.z;
  const y0 = box.min.y;

  const hips = makeBone('hips', new THREE.Vector3(cx, y0 + 0.45 * H, cz), null);
  const spine = makeBone('spine', new THREE.Vector3(0, 0.13 * H, 0), hips);
  const chest = makeBone('chest', new THREE.Vector3(0, 0.14 * H, 0), spine);
  const neck = makeBone('neck', new THREE.Vector3(0, 0.15 * H, 0), chest);
  const head = makeBone('head', new THREE.Vector3(0, 0.06 * H, 0), neck);

  const armX = 0.42 * W;
  const shoulderL = makeBone('shoulderL', new THREE.Vector3(-armX, 0.06 * H, 0), chest);
  const upperArmL = makeBone('upperArmL', new THREE.Vector3(-0.06 * W, -0.02 * H, 0), shoulderL);
  const lowerArmL = makeBone('lowerArmL', new THREE.Vector3(0, -0.16 * H, 0), upperArmL);
  const handL = makeBone('handL', new THREE.Vector3(0, -0.14 * H, 0), lowerArmL);

  const shoulderR = makeBone('shoulderR', new THREE.Vector3(armX, 0.06 * H, 0), chest);
  const upperArmR = makeBone('upperArmR', new THREE.Vector3(0.06 * W, -0.02 * H, 0), shoulderR);
  const lowerArmR = makeBone('lowerArmR', new THREE.Vector3(0, -0.16 * H, 0), upperArmR);
  const handR = makeBone('handR', new THREE.Vector3(0, -0.14 * H, 0), lowerArmR);

  const legX = 0.18 * W;
  const upperLegL = makeBone('upperLegL', new THREE.Vector3(-legX, -0.04 * H, 0), hips);
  const lowerLegL = makeBone('lowerLegL', new THREE.Vector3(0, -0.20 * H, 0), upperLegL);
  const footL = makeBone('footL', new THREE.Vector3(0, -0.17 * H, 0), lowerLegL);

  const upperLegR = makeBone('upperLegR', new THREE.Vector3(legX, -0.04 * H, 0), hips);
  const lowerLegR = makeBone('lowerLegR', new THREE.Vector3(0, -0.20 * H, 0), upperLegR);
  const footR = makeBone('footR', new THREE.Vector3(0, -0.17 * H, 0), lowerLegR);

  const bones: THREE.Bone[] = [
    hips, spine, chest, neck, head,
    shoulderL, upperArmL, lowerArmL, handL,
    shoulderR, upperArmR, lowerArmR, handR,
    upperLegL, lowerLegL, footL,
    upperLegR, lowerLegR, footR,
  ];
  return { rootBone: hips, bones, heightMm: H };
}

interface BandRule {
  /** Bu bandı tetikleyen normalized t aralığı. */
  tMin: number;
  tMax: number;
  /** Kullanıcının x tarafı: -1 sol, +1 sağ, 0 fark etmez. */
  side: -1 | 0 | 1;
  /** |dx| / W bu eşiği aşarsa kol bandı önceliği kazanır. */
  armXThreshold?: number;
  primary: RigBoneName;
  secondary: RigBoneName;
}

/**
 * Vertex başına 2 kemik ağırlığı: ana kemik 0.8, komşu kemik 0.2.
 * Y-bantları (t = (y - y0) / H) + kol için |dx| eşiği; yüzden bağımsız, hızlıdır.
 */
const BANDS: BandRule[] = [
  { tMin: 0.0, tMax: 0.08, side: 0, primary: 'footL', secondary: 'lowerLegL' },
  { tMin: 0.08, tMax: 0.24, side: 0, primary: 'lowerLegL', secondary: 'upperLegL' },
  { tMin: 0.24, tMax: 0.42, side: 0, primary: 'upperLegL', secondary: 'hips' },
  { tMin: 0.42, tMax: 0.56, side: 0, primary: 'hips', secondary: 'spine' },
  { tMin: 0.56, tMax: 0.70, side: 0, primary: 'spine', secondary: 'chest' },
  { tMin: 0.70, tMax: 0.84, side: 0, primary: 'chest', secondary: 'neck' },
  { tMin: 0.84, tMax: 1.01, side: 0, primary: 'head', secondary: 'neck' },
];

function boneIndexOf(bones: THREE.Bone[], name: RigBoneName): number {
  return bones.findIndex((b) => b.name === name);
}

function pickSide(name: RigBoneName, xSign: -1 | 1): RigBoneName {
  if (name === 'footL' || name === 'lowerLegL' || name === 'upperLegL') return xSign < 0 ? name : (name.replace(/L$/, 'R') as RigBoneName);
  if (name === 'footR' || name === 'lowerLegR' || name === 'upperLegR') return xSign > 0 ? name : (name.replace(/R$/, 'L') as RigBoneName);
  return name;
}

/** Vertex başına skin ağırlıklarını hesaplar ve geometry'ye attribute olarak ekler. */
export function computeSkinAttributes(
  geometry: THREE.BufferGeometry,
  bones: THREE.Bone[],
  box: THREE.Box3
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const count = position.count;
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const H = Math.max(size.y, 1);
  const W = Math.max(size.x, 1);
  const y0 = box.min.y;
  const cx = center.x;

  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const armThreshold = 0.30;

  for (let i = 0; i < count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const dx = x - cx;
    const t = (y - y0) / H;
    const xSign: -1 | 1 = dx < 0 ? -1 : 1;
    const absDxN = Math.abs(dx) / W;

    let primary: RigBoneName;
    let secondary: RigBoneName;
    if (t >= 0.50 && t <= 0.86 && absDxN > armThreshold) {
      // Kol bandı: omuzdan aşağı sarkan kollar (yukarıdan aşağıya).
      const side = xSign < 0 ? 'L' : 'R';
      if (t > 0.76) {
        primary = `upperArm${side}` as RigBoneName;
        secondary = `lowerArm${side}` as RigBoneName;
      } else if (t > 0.62) {
        primary = `lowerArm${side}` as RigBoneName;
        secondary = `upperArm${side}` as RigBoneName;
      } else {
        primary = `hand${side}` as RigBoneName;
        secondary = `lowerArm${side}` as RigBoneName;
      }
    } else {
      const band =
        BANDS.find((b) => t >= b.tMin && t < b.tMax) ?? BANDS[BANDS.length - 1];
      primary = band.primary;
      secondary = band.secondary;
    }
    primary = pickSide(primary, xSign);
    secondary = pickSide(secondary, xSign);

    const pi = boneIndexOf(bones, primary);
    const si = boneIndexOf(bones, secondary);
    skinIndex[i * 4 + 0] = pi >= 0 ? pi : 0;
    skinIndex[i * 4 + 1] = si >= 0 ? si : 0;
    skinWeight[i * 4 + 0] = 0.8;
    skinWeight[i * 4 + 1] = 0.2;
  }

  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  return geometry;
}

/**
 * Kaynak geometriden bağımsız (clone) bir SkinnedMesh üretir; baskı hattı geometrisi
 * değişmeden kalır. Rig'i boşaltırken disposeRig ile clone temizlenir.
 */
export function buildBipedRig(
  geometry: THREE.BufferGeometry,
  material?: THREE.Material
): RigResult {
  const skinnedGeometry = geometry.clone();
  skinnedGeometry.computeBoundingBox();
  const box = skinnedGeometry.boundingBox as THREE.Box3;
  if (box.isEmpty()) throw new Error('Rig için geçerli bir mesh gerekli (bbox boş).');

  const { rootBone, bones, heightMm } = buildBipedSkeleton(box);
  computeSkinAttributes(skinnedGeometry, bones, box);

  const skeleton = new THREE.Skeleton(bones);
  const mat =
    material ??
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.38, metalness: 0.15 });
  const skinnedMesh = new THREE.SkinnedMesh(skinnedGeometry, mat);
  skinnedMesh.name = '3bstudio_rigged';
  skinnedMesh.castShadow = true;
  skinnedMesh.add(rootBone);
  skinnedMesh.bind(skeleton);

  return { rootBone, skeleton, skinnedMesh, heightMm };
}

/** Rig temizliği: clone geometri ve (istenirse) materyal dispose edilir. */
export function disposeRig(rig: RigResult, disposeMaterial = false): void {
  rig.skinnedMesh.geometry.dispose();
  if (disposeMaterial) {
    const m = rig.skinnedMesh.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m.dispose();
  }
}
