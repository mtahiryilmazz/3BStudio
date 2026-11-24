import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { buildBipedRig, buildBipedSkeleton, computeSkinAttributes, disposeRig } from '../rigging';
import { buildClip, buildAllClips, RIG_CLIP_DURATIONS } from '../animClips';
import { exportAnimatedGLB } from '../exporters';

// GLTFExporter node ortamında FileReader kullanır: async stub yeterli.
class FileReaderStub {
  result: ArrayBuffer | null = null;
  onloadend: ((ev: { target: { result: ArrayBuffer | null } }) => void) | null = null;
  onload: ((ev: { target: { result: ArrayBuffer | null } }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  readAsArrayBuffer(blob: Blob | ArrayBuffer): void {
    const finish = (buf: ArrayBuffer) => {
      this.result = buf;
      const ev = { target: { result: buf } };
      this.onload?.(ev);
      this.onloadend?.(ev);
    };
    if (blob instanceof ArrayBuffer) {
      finish(blob);
    } else if (typeof blob.arrayBuffer === 'function') {
      void blob.arrayBuffer().then(finish).catch((e) => this.onerror?.(e));
    } else {
      finish(new ArrayBuffer(0));
    }
  }
  readAsText(blob: Blob | string): void {
    void Promise.resolve(typeof blob === 'string' ? blob : '').then(() => {
      const buf = new ArrayBuffer(0);
      this.result = buf;
      const ev = { target: { result: buf } };
      this.onload?.(ev);
      this.onloadend?.(ev);
    });
  }
}
beforeAll(() => {
  (globalThis as Record<string, unknown>).FileReader = FileReaderStub;
});

function sphereMesh(): THREE.BufferGeometry {
  // Y-up üzerinde duran basit gövde: taban y=0, yükseklik ~100.
  const geo = new THREE.SphereGeometry(30, 16, 16);
  geo.translate(0, 50, 0);
  return geo;
}

describe('buildBipedSkeleton', () => {
  it('beklenen kemik sayısını ve hiyerarşi kökünü üretir', () => {
    const geo = sphereMesh();
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const { rootBone, bones, heightMm } = buildBipedSkeleton(box);
    expect(bones).toHaveLength(19);
    expect(rootBone.name).toBe('hips');
    expect(heightMm).toBeCloseTo(60, 5);
    // hips çocukları spine + iki üst bacak olmalı
    const childNames = rootBone.children.map((c) => c.name).sort();
    expect(childNames).toEqual(['spine', 'upperLegL', 'upperLegR'].sort());
    // kol zinciri chest'e bağlı
    const chest = bones.find((b) => b.name === 'chest')!;
    expect(chest.children.map((c) => c.name).sort()).toEqual(['neck', 'shoulderL', 'shoulderR'].sort());
    geo.dispose();
  });

  it('kemik pozisyonları bbox içinde kalır', () => {
    const geo = sphereMesh();
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const { bones } = buildBipedSkeleton(box);
    for (const b of bones) {
      const wp = new THREE.Vector3();
      b.getWorldPosition(wp);
      expect(wp.y).toBeGreaterThanOrEqual(box.min.y - 1e-6);
      expect(wp.y).toBeLessThanOrEqual(box.max.y + 1e-6);
    }
    geo.dispose();
  });
});

describe('computeSkinAttributes', () => {
  it('her vertex için ağırlık toplamı 1 ve indeksler geçerlidir', () => {
    const geo = sphereMesh();
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const { bones } = buildBipedSkeleton(box);
    computeSkinAttributes(geo, bones, box);
    const idx = geo.getAttribute('skinIndex') as THREE.BufferAttribute;
    const w = geo.getAttribute('skinWeight') as THREE.BufferAttribute;
    expect(idx.count).toBe(geo.getAttribute('position').count);
    for (let i = 0; i < idx.count; i++) {
      const sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
      expect(sum).toBeCloseTo(1, 5);
      for (let k = 0; k < 4; k++) {
        expect(idx.getComponent(i, k)).toBeLessThan(bones.length);
      }
    }
    geo.dispose();
  });

  it('üst bölgedeki yan vertexler kol kemiğine bağlanır', () => {
    const geo = sphereMesh();
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const { bones } = buildBipedSkeleton(box);
    computeSkinAttributes(geo, bones, box);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const idx = geo.getAttribute('skinIndex') as THREE.BufferAttribute;
    const armIdx = bones.findIndex((b) => b.name === 'upperArmL');
    let found = false;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getX(i) < -20 && pos.getY(i) > 58 && pos.getY(i) < 72) {
        if (idx.getComponent(i, 0) === armIdx) found = true;
      }
    }
    expect(found).toBe(true);
    geo.dispose();
  });
});

describe('buildBipedRig', () => {
  it('SkinnedMesh bağlar ve kaynak geometriden bağımsızdır', () => {
    const geo = sphereMesh();
    const rig = buildBipedRig(geo);
    expect(rig.skinnedMesh.isSkinnedMesh).toBe(true);
    expect(rig.skinnedMesh.skeleton.bones).toHaveLength(19);
    expect(rig.skinnedMesh.geometry).not.toBe(geo);
    expect(rig.skinnedMesh.skeleton.boneInverses).toHaveLength(19);
    disposeRig(rig);
    geo.dispose();
  });

  it('kaynak geometriye skin attribute yazmaz', () => {
    const geo = sphereMesh();
    buildBipedRig(geo);
    expect(geo.getAttribute('skinIndex')).toBeUndefined();
    geo.dispose();
  });
});

describe('animClips', () => {
  it('üç klibin süresi ve track isimleri doğru', () => {
    const clips = buildAllClips(100);
    expect(clips.idle.duration).toBeCloseTo(RIG_CLIP_DURATIONS.idle, 5);
    expect(clips.walk.duration).toBeCloseTo(RIG_CLIP_DURATIONS.walk, 5);
    expect(clips.wave.duration).toBeCloseTo(RIG_CLIP_DURATIONS.wave, 5);
    for (const clip of Object.values(clips)) {
      expect(clip.tracks.length).toBeGreaterThan(0);
      for (const track of clip.tracks) {
        expect(track.name).toMatch(/^(hips|spine|chest|neck|head|shoulder[LR]|upperArm[LR]|lowerArm[LR]|hand[LR]|upperLeg[LR]|lowerLeg[LR]|foot[LR])\.(quaternion|position)$/);
      }
    }
  });

  it('buildClip bilinmeyen isimde idle döner', () => {
    const clip = buildClip('idle' as never, 100);
    expect(clip.name).toBe('idle');
  });
});

describe('exportAnimatedGLB', () => {
  it('GLB çıktısı skins ve animations içerir', async () => {
    const geo = sphereMesh();
    const rig = buildBipedRig(geo);
    const clips = buildAllClips(rig.heightMm);
    const buffer = await exportAnimatedGLB(rig.skinnedMesh, [clips.idle, clips.walk]);
    const bytes = new Uint8Array(buffer);
    // GLB: magic(4) + version(4) + length(4) + JSON chunk
    const jsonLen = new DataView(buffer, 12, 4).getUint32(0, true);
    const json = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen));
    expect(json).toContain('"skins"');
    expect(json).toContain('"animations"');
    disposeRig(rig);
    geo.dispose();
  }, 20000);
});
