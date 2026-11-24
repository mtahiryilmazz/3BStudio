import * as THREE from 'three';

/**
 * Prosedürel (dosyasız) basit oyun animasyonları: idle / walk / wave.
 * Track isimleri rigging.ts'teki kemik isimleriyle birebir eşleşir; DOM yok.
 */

export const RIG_CLIP_NAMES = ['idle', 'walk', 'wave'] as const;
export type RigClipName = (typeof RIG_CLIP_NAMES)[number];

export const RIG_CLIP_LABELS: Record<RigClipName, string> = {
  idle: 'Idle (nefes/sallanma)',
  walk: 'Walk (yürüme döngüsü)',
  wave: 'Wave (el sallama)',
};

export const RIG_CLIP_DURATIONS: Record<RigClipName, number> = {
  idle: 3.2,
  walk: 1.0,
  wave: 1.6,
};

const euler = new THREE.Euler();
const quat = new THREE.Quaternion();

/** Derece cinsinden euler → quaternion keyframe listesi. */
function quaternionTrack(
  bone: string,
  times: number[],
  rotations: Array<[number, number, number]>
): THREE.QuaternionKeyframeTrack {
  const values: number[] = [];
  for (const [rx, ry, rz] of rotations) {
    quat.setFromEuler(euler.set(rx, ry, rz, 'XYZ'));
    values.push(quat.x, quat.y, quat.z, quat.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
}

/** Kemik pozisyonu (mm) için keyframe listesi. */
function positionTrack(
  bone: string,
  times: number[],
  positions: Array<[number, number, number]>
): THREE.VectorKeyframeTrack {
  const values: number[] = [];
  for (const [x, y, z] of positions) values.push(x, y, z);
  return new THREE.VectorKeyframeTrack(`${bone}.position`, times, values);
}

const D = Math.PI / 180;

/**
 * heightMm: kemik pozisyon ölçeği (hips bob miktarı için kullanılır).
 * idle — gövde nefes alma, hafif baş/kol salınımı, hips dikey esneme.
 */
export function buildIdleClip(heightMm: number): THREE.AnimationClip {
  const H = Math.max(heightMm, 10);
  const bob = 0.006 * H;
  const times = [0, 0.8, 1.6, 2.4, 3.2];
  return new THREE.AnimationClip('idle', RIG_CLIP_DURATIONS.idle, [
    quaternionTrack('chest', times, [
      [2 * D, 0, 0], [3.5 * D, 1 * D, 0], [2 * D, 0, 0], [1 * D, -1 * D, 0], [2 * D, 0, 0],
    ]),
    quaternionTrack('head', times, [
      [0, 0, 0], [1 * D, 3 * D, 0], [0, 0, 0], [-1 * D, -3 * D, 0], [0, 0, 0],
    ]),
    quaternionTrack('upperArmL', times, [
      [0, 0, 0], [0, 0, 2 * D], [0, 0, 0], [0, 0, -1.5 * D], [0, 0, 0],
    ]),
    quaternionTrack('upperArmR', times, [
      [0, 0, 0], [0, 0, -2 * D], [0, 0, 0], [0, 0, 1.5 * D], [0, 0, 0],
    ]),
    positionTrack('hips', times, [
      [0, 0, 0], [0, bob, 0], [0, 0, 0], [0, bob * 0.6, 0], [0, 0, 0],
    ]),
  ]);
}

/**
 * walk — 1 sn döngü: bacaklar zıt fazda, kollar ters salınım, çift dikey bob.
 */
export function buildWalkClip(heightMm: number): THREE.AnimationClip {
  const H = Math.max(heightMm, 10);
  const bob = 0.012 * H;
  const times = [0, 0.25, 0.5, 0.75, 1.0];
  const legSwing = 32 * D;
  const armSwing = 22 * D;
  return new THREE.AnimationClip('walk', RIG_CLIP_DURATIONS.walk, [
    quaternionTrack('upperLegL', times, [
      [legSwing, 0, 0], [0, 0, 0], [-legSwing, 0, 0], [0, 0, 0], [legSwing, 0, 0],
    ]),
    quaternionTrack('upperLegR', times, [
      [-legSwing, 0, 0], [0, 0, 0], [legSwing, 0, 0], [0, 0, 0], [-legSwing, 0, 0],
    ]),
    quaternionTrack('lowerLegL', times, [
      [10 * D, 0, 0], [35 * D, 0, 0], [10 * D, 0, 0], [0, 0, 0], [10 * D, 0, 0],
    ]),
    quaternionTrack('lowerLegR', times, [
      [10 * D, 0, 0], [0, 0, 0], [10 * D, 0, 0], [35 * D, 0, 0], [10 * D, 0, 0],
    ]),
    quaternionTrack('upperArmL', times, [
      [-armSwing, 0, 0], [0, 0, 0], [armSwing, 0, 0], [0, 0, 0], [-armSwing, 0, 0],
    ]),
    quaternionTrack('upperArmR', times, [
      [armSwing, 0, 0], [0, 0, 0], [-armSwing, 0, 0], [0, 0, 0], [armSwing, 0, 0],
    ]),
    quaternionTrack('chest', times, [
      [0, 3 * D, 0], [0, 0, 0], [0, -3 * D, 0], [0, 0, 0], [0, 3 * D, 0],
    ]),
    positionTrack('hips', times, [
      [0, 0, 0], [0, bob, 0], [0, 0, 0], [0, bob, 0], [0, 0, 0],
    ]),
  ]);
}

/**
 * wave — sağ kol yukarı kalkar, ön kol iki tur sallanır, baş hafif eğilir.
 */
export function buildWaveClip(heightMm: number): THREE.AnimationClip {
  void heightMm;
  const times = [0, 0.3, 0.55, 0.85, 1.15, 1.45, 1.6];
  return new THREE.AnimationClip('wave', RIG_CLIP_DURATIONS.wave, [
    quaternionTrack('upperArmR', times, [
      [0, 0, 0],
      [0, 0, -110 * D],
      [0, 0, -125 * D],
      [0, 0, -110 * D],
      [0, 0, -125 * D],
      [0, 0, -110 * D],
      [0, 0, 0],
    ]),
    quaternionTrack('lowerArmR', times, [
      [0, 0, 0],
      [0, 0, 25 * D],
      [0, 0, -20 * D],
      [0, 0, 25 * D],
      [0, 0, -20 * D],
      [0, 0, 10 * D],
      [0, 0, 0],
    ]),
    quaternionTrack('head', times, [
      [0, 0, 0], [0, 0, 6 * D], [0, 0, 6 * D], [0, 0, 6 * D], [0, 0, 6 * D], [0, 0, 0], [0, 0, 0],
    ]),
  ]);
}

export function buildClip(name: RigClipName, heightMm: number): THREE.AnimationClip {
  if (name === 'walk') return buildWalkClip(heightMm);
  if (name === 'wave') return buildWaveClip(heightMm);
  return buildIdleClip(heightMm);
}

export function buildAllClips(heightMm: number): Record<RigClipName, THREE.AnimationClip> {
  return {
    idle: buildIdleClip(heightMm),
    walk: buildWalkClip(heightMm),
    wave: buildWaveClip(heightMm),
  };
}
