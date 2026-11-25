import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import * as THREE from 'three';
import { BinaryMask } from '../types';
import { detectSideProfileFacing, reconstructVisualHull } from '../visualHull';
import { reconstructFaceMask, reconstructHeadBust } from '../bustAndMask';
import { buildObjMtlZip } from '../exporters';
import { analyzeMesh } from '../meshRepair';
import {
  bakeDualHemispherePbrAtlas,
  buildComfySetupScript,
  computeMultiViewSilhouetteIoU,
  evaluatePrintabilityDoctor,
} from '../photogrammetry';
import { buildGradioPayload, pickBestGradioEndpoint } from '../cloudCatalog';

/** Sentetik tam boy karakter ön maskesi oluşturur (kafa + omuz + gövde + bacaklar + ayaklar). */
function makeFrontCharacterMask(size = 128): BinaryMask {
  const data = new Uint8Array(size * size);
  const cx = size * 0.5;
  for (let y = 0; y < size; y++) {
    const ry = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / size;
      let inside = false;
      // Kafa (ry 0.08..0.24)
      if (ry >= 0.08 && ry <= 0.24) {
        const dy = (ry - 0.16) / 0.08;
        if ((dx / 0.075) ** 2 + dy ** 2 <= 1) inside = true;
      }
      // Boyun (ry 0.23..0.28)
      if (ry >= 0.23 && ry <= 0.28 && Math.abs(dx) <= 0.035) inside = true;
      // Gövde + kollar (ry 0.28..0.58)
      if (ry >= 0.28 && ry <= 0.58 && Math.abs(dx) <= 0.145) inside = true;
      // Bacaklar (ry 0.58..0.90)
      if (ry >= 0.58 && ry <= 0.90) {
        if (Math.abs(dx - 0.055) <= 0.04 || Math.abs(dx + 0.055) <= 0.04) inside = true;
      }
      // Ayaklar (ry 0.90..0.96)
      if (ry >= 0.90 && ry <= 0.96) {
        if (Math.abs(dx - 0.06) <= 0.05 || Math.abs(dx + 0.06) <= 0.05) inside = true;
      }
      if (inside) data[y * size + x] = 1;
    }
  }
  return { width: size, height: size, data };
}

/** Sentetik yan profil maskesi oluşturur (facing: 'right' => burun ve ayak parmakları +X tarafında). */
function makeSideProfileMask(facing: 'right' | 'left', size = 128): BinaryMask {
  const data = new Uint8Array(size * size);
  const dir = facing === 'right' ? 1 : -1;
  const cx = size * 0.5;
  for (let y = 0; y < size; y++) {
    const ry = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / size;
      let inside = false;
      // Kafa + burun çıkıntısı (ry 0.08..0.24)
      if (ry >= 0.08 && ry <= 0.24) {
        const dy = (ry - 0.16) / 0.08;
        if (((dx - dir * 0.015) / 0.075) ** 2 + dy ** 2 <= 1) inside = true;
        // Burun çıkıntısı
        if (ry >= 0.14 && ry <= 0.18 && dx * dir > 0.05 && dx * dir < 0.115) inside = true;
      }
      // Boyun + Gövde (ry 0.23..0.58)
      if (ry >= 0.23 && ry <= 0.58 && Math.abs(dx) <= 0.075) inside = true;
      // Bacak + bilek (ry 0.58..0.89)
      if (ry >= 0.58 && ry <= 0.89 && Math.abs(dx) <= 0.045) inside = true;
      // Ayak (topuk arkada, uzun parmak ucu dir yönünde)
      if (ry >= 0.89 && ry <= 0.96) {
        const footLocal = dx * dir;
        if (footLocal >= -0.04 && footLocal <= 0.145) inside = true;
      }
      if (inside) data[y * size + x] = 1;
    }
  }
  return { width: size, height: size, data };
}

/** Sentetik yüz/portre renkli ImageData üretir. */
function makeSyntheticColorImage(size = 128): ImageData {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = 195 + ((x * 23) % 40);
      data[i + 1] = 150 + ((y * 17) % 35);
      data[i + 2] = 125 + (((x + y) * 11) % 30);
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data, colorSpace: 'srgb' } as ImageData;
}

describe('Yan Profil Yön Kilidi ve Keskin/Hızlı Yerel 3D Motor', () => {
  it('detectSideProfileFacing sağa ve sola bakan yan profilleri doğru algılar', () => {
    const rightMask = makeSideProfileMask('right', 128);
    const leftMask = makeSideProfileMask('left', 128);

    const resRight = detectSideProfileFacing(rightMask);
    const resLeft = detectSideProfileFacing(leftMask);

    expect(resRight.facing).toBe('right');
    expect(resRight.confidence).toBeGreaterThan(0.2);
    expect(resLeft.facing).toBe('left');
    expect(resLeft.confidence).toBeGreaterThan(0.2);
  });

  it('reconstructVisualHull sağa bakan yan profilde ayak ucunu ön yüzle aynı +Z yönüne kilitler', () => {
    const front = makeFrontCharacterMask(128);
    const back = makeFrontCharacterMask(128);
    const right = makeSideProfileMask('right', 128);

    const t0 = performance.now();
    const geo = reconstructVisualHull(
      { front, back, right },
      {
        resolution: 88,
        smoothPasses: 1,
        sizeMm: 100,
        depthPreset: 'natural-sharp',
        sideProfileFacing: 'auto',
      }
    );
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(3500);
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const size = new THREE.Vector3();
    box.getSize(size);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;

    // Gövde ortası (y %45..60) ile ayak bandı (y %0..10) Z merkezlerini kıyasla:
    // Ayak parmakları +Z yönünde öne doğru çıkıntı yapmalı (ters -Z'ye değil!)
    let footSumZ = 0;
    let footCount = 0;
    let torsoSumZ = 0;
    let torsoCount = 0;
    for (let i = 0; i < pos.count; i++) {
      const yRel = (pos.getY(i) - box.min.y) / Math.max(1e-5, size.y);
      const z = pos.getZ(i);
      if (yRel <= 0.1) {
        footSumZ += z;
        footCount++;
      } else if (yRel >= 0.45 && yRel <= 0.6) {
        torsoSumZ += z;
        torsoCount++;
      }
    }
    expect(footCount).toBeGreaterThan(20);
    expect(torsoCount).toBeGreaterThan(20);
    const footMeanZ = footSumZ / footCount;
    const torsoMeanZ = torsoSumZ / torsoCount;
    expect(footMeanZ).toBeGreaterThan(torsoMeanZ);

    geo.dispose();
  });

  it('şişme balon önleme: slim profili bold profilinden belirgin şekilde daha ince derinlik üretir', () => {
    const front = makeFrontCharacterMask(96);
    const slimGeo = reconstructVisualHull(
      { front },
      { resolution: 64, smoothPasses: 1, sizeMm: 100, depthPreset: 'slim' }
    );
    const boldGeo = reconstructVisualHull(
      { front },
      { resolution: 64, smoothPasses: 1, sizeMm: 100, depthPreset: 'bold' }
    );

    slimGeo.computeBoundingBox();
    boldGeo.computeBoundingBox();
    const slimDepth = slimGeo.boundingBox!.max.z - slimGeo.boundingBox!.min.z;
    const boldDepth = boldGeo.boundingBox!.max.z - boldGeo.boundingBox!.min.z;

    expect(slimDepth).toBeLessThan(boldDepth);
    slimGeo.dispose();
    boldGeo.dispose();
  });
});

describe('Kafa Büstü ve Yüz Maskesi Modları', () => {
  it('reconstructHeadBust tam boy maskeden kafa+omuz büstünü kırpıp Y=0 tabanına oturtur', () => {
    const fullBody = makeFrontCharacterMask(128);
    const color = makeSyntheticColorImage(128);

    const bustWithPlinth = reconstructHeadBust(fullBody, color, {
      heightMm: 110,
      resolution: 72,
      reliefScale: 1.0,
      autoCropHeadShoulders: true,
      includeSculptedPlinth: true,
    });

    bustWithPlinth.computeBoundingBox();
    const box = bustWithPlinth.boundingBox!;
    const height = box.max.y - box.min.y;

    expect(Math.abs(box.min.y)).toBeLessThan(0.5);
    expect(height).toBeGreaterThan(85);
    expect(height).toBeLessThan(125);
    expect(bustWithPlinth.getAttribute('color')).toBeTruthy();
    expect(bustWithPlinth.getAttribute('uv')).toBeTruthy();
    expect(bustWithPlinth.getAttribute('position').count).toBeGreaterThan(3000);

    bustWithPlinth.dispose();
  });

  it('reconstructFaceMask giyilebilir oyuk maskede 0 açık kenarlı su geçirmez kabuk üretir', () => {
    const faceMask = makeFrontCharacterMask(128);
    const color = makeSyntheticColorImage(128);

    const wearable = reconstructFaceMask(faceMask, color, {
      style: 'wearable-shell',
      widthMm: 165,
      wallThicknessMm: 3.2,
      gridResolution: 68,
      cutEyes: true,
      addStrapLoops: true,
    });

    const stats = analyzeMesh(wearable);
    wearable.computeBoundingBox();
    const box = wearable.boundingBox!;

    expect(stats.openBoundaryEdges).toBe(0);
    expect(stats.isWatertight).toBe(true);
    expect(Math.abs(box.min.y)).toBeLessThan(0.2);
    expect(stats.widthMm).toBeGreaterThan(140);
    expect(stats.widthMm).toBeLessThan(205);

    const relief = reconstructFaceMask(faceMask, color, {
      style: 'wall-relief',
      widthMm: 140,
      wallThicknessMm: 4.0,
      gridResolution: 64,
    });
    const reliefStats = analyzeMesh(relief);
    expect(reliefStats.openBoundaryEdges).toBe(0);
    expect(reliefStats.isWatertight).toBe(true);

    wearable.dispose();
    relief.dispose();
  });
});

describe('Mesh Atölye & Local3D+ PBR, Multi-View IoU, OBJ+MTL ZIP ve ComfyUI Kurulum', () => {
  it('computeMultiViewSilhouetteIoU çoklu açıda ağırlıklı IoU skoru döndürür', () => {
    const front = makeFrontCharacterMask(96);
    const back = makeFrontCharacterMask(96);
    const right = makeSideProfileMask('right', 96);

    const geo = reconstructVisualHull(
      { front, back, right },
      { resolution: 64, smoothPasses: 1, sizeMm: 100 }
    );

    const multi = computeMultiViewSilhouetteIoU(geo, { front, back, right });
    expect(multi.overallIoU).not.toBeNull();
    expect(multi.overallIoU!).toBeGreaterThan(0.55);
    expect(multi.perView.front).toBeGreaterThan(0.6);
    expect(multi.perView.right).toBeGreaterThan(0.5);

    const report = evaluatePrintabilityDoctor(geo, { frontMask: front, viewMasks: { front, back, right } });
    expect(report.silhouetteIoU).toBeCloseTo(multi.overallIoU!, 3);
    expect(report.multiViewIoU?.front).toBeDefined();

    geo.dispose();
  });

  it('bakeDualHemispherePbrAtlas hızlı BFS bleed ile çalışır ve sourceDetailReplace bayrağını korur', () => {
    const color = makeSyntheticColorImage(128);
    const t0 = performance.now();
    const withReplace = bakeDualHemispherePbrAtlas(
      { front: color, back: color },
      { width: 512, height: 256, delight: true, sourceDetailReplace: true }
    );
    const elapsedMs = performance.now() - t0;

    const rawBase = bakeDualHemispherePbrAtlas(
      { front: color, back: color },
      { width: 512, height: 256, delight: true, sourceDetailReplace: false }
    );

    expect(elapsedMs).toBeLessThan(1200);
    expect(withReplace.sourceDetailReplace).toBe(true);
    expect(rawBase.sourceDetailReplace).toBe(false);
    expect(withReplace.albedo.length).toBe(512 * 256 * 4);
  });

  it('buildObjMtlZip geçerli PNG imzalı 2K PBR dokular + model.obj + model.mtl içeren ZIP üretir', () => {
    const box = new THREE.BoxGeometry(20, 20, 20).toNonIndexed();
    const color = makeSyntheticColorImage(64);
    const baked = bakeDualHemispherePbrAtlas({ front: color }, { width: 128, height: 64 });

    const zipBytes = buildObjMtlZip(box, baked);
    const files = unzipSync(zipBytes);

    expect(files['model.obj']).toBeDefined();
    expect(files['model.mtl']).toBeDefined();
    expect(files['albedo.png']).toBeDefined();
    expect(files['normal.png']).toBeDefined();
    expect(files['roughness.png']).toBeDefined();
    expect(files['metallic.png']).toBeDefined();
    expect(files['ao.png']).toBeDefined();

    // PNG sihirli baytları: 89 50 4E 47 0D 0A 1A 0A
    const png = files['albedo.png'];
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);

    const mtlText = new TextDecoder().decode(files['model.mtl']);
    expect(mtlText).toContain('map_Kd albedo.png');
    expect(mtlText).toContain('map_Bump -bm 1.0 normal.png');

    box.dispose();
  });

  it('buildComfySetupScript Windows ve Linux için geçerli Hugging Face + Local3D+ kurulum betiği üretir', () => {
    const winPs1 = buildComfySetupScript('windows', 'pixal3d-int8');
    const linuxSh = buildComfySetupScript('linux', 'hunyuan3d-mv');

    expect(winPs1).toContain('https://huggingface.co/');
    expect(winPs1).toContain('sh1ftmaker/local3d-plus');
    expect(winPs1).toContain('pixal3d_int8_convrot.safetensors');
    expect(winPs1).toContain('127.0.0.1 --port 8188');

    expect(linuxSh).toContain('#!/usr/bin/env bash');
    expect(linuxSh).toContain('tencent/Hunyuan3D-2mv');
  });

  it('buildGradioPayload zorunlu seed ve varsayilansiz Gradio parametrelerini eksiksiz doldurur', () => {
    const frontBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const params = [
      { parameter_name: 'image', component: 'Image', parameter_has_default: false },
      { parameter_name: 'mv_image_back', component: 'Image', parameter_has_default: false },
      { parameter_name: 'seed', label: 'Seed', component: 'Slider', type: 'number', parameter_has_default: false },
      { parameter_name: 'randomize_seed', label: 'Randomize seed', component: 'Checkbox', type: 'boolean', parameter_has_default: false },
      { parameter_name: 'num_inference_steps', component: 'Slider', type: 'number', parameter_has_default: false },
      { parameter_name: 'guidance_scale', component: 'Slider', type: 'number', parameter_has_default: false },
      { parameter_name: 'check_box_rembg', component: 'Checkbox', type: 'boolean', parameter_has_default: false },
      { parameter_name: 'caption', component: 'Textbox', type: 'string', parameter_has_default: false },
    ];

    const ep = pickBestGradioEndpoint('TencentARC/Pixal3D', {
      '/toggle_ui': { parameters: [{ parameter_name: 'flag', component: 'Checkbox' }] },
      '/generate_3d': { parameters: params },
    });
    expect(ep).toBe('/generate_3d');

    const payload = buildGradioPayload(params, { front: frontBlob }, (b) => ({ wrapped: b.size })) as Record<
      string,
      unknown
    >;
    expect(payload.image).toEqual({ wrapped: 3 });
    expect(payload.mv_image_back).toBeNull();
    expect(payload.seed).toBe(42);
    expect(payload.randomize_seed).toBe(false);
    expect(payload.num_inference_steps).toBe(30);
    expect(payload.guidance_scale).toBe(5.5);
    expect(payload.check_box_rembg).toBe(true);
    expect(payload.caption).toBe('');
    for (const p of params) {
      expect(payload[p.parameter_name]).not.toBeUndefined();
    }
  });
});
