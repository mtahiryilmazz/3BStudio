#!/usr/bin/env node
/**
 * 3BStudio CLI — Tek Görsel / Karakter Sheet / Çoklu Açı → Su Geçirmez 3D Model (.glb, .3mf, .stl, .obj)
 *
 * Kullanım örnekleri:
 *   npm run cli -- --input ./karakter-sheet.jpg --out ./out/karakter
 *   npm run cli -- --front ./on.png --back ./arka.png --left ./sol.png --out ./out/figur --profile game-polymolly
 *   npm run cli -- --input ./sheet.png --out ./out/figur --formats glb,3mf,stl --zephyr-script
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import * as THREE from 'three';
import { detectCharacterSheetGrid, cropImageData } from '../src/engine/sheetSplit.ts';
import { removeBackgroundFast } from '../src/engine/maskProcessor.ts';
import { reconstructVisualHull } from '../src/engine/visualHull.ts';
import { analyzeMesh, repairMesh } from '../src/engine/meshRepair.ts';
import os from 'node:os';
import {
  addDisplayPedestal,
  applyQualityProfileToGeometry,
  build3DFZephyrCliScript,
  buildComfyUiWorkflowJson,
  buildLodGeometry,
  buildRunManifest,
  ComfyPresetId,
  evaluatePolyMollyQa,
  evaluatePrintabilityDoctor,
  pruneLooseFragments,
  QUALITY_PROFILES,
  QualityProfileId,
} from '../src/engine/photogrammetry.ts';
import { build3MF, buildMultiColor3MF, buildOBJ, buildSTLBinary } from '../src/engine/exporters.ts';
import type { BinaryMask, ViewAngle } from '../src/engine/types.ts';

interface CliArgs {
  command: 'convert' | 'doctor';
  inputs: string[];
  front?: string;
  back?: string;
  left?: string;
  right?: string;
  face?: string;
  out: string;
  profile: QualityProfileId;
  sizeMm: number;
  resolution?: number;
  formats: string[];
  tolerance: number;
  zephyrScript: boolean;
  lod: boolean;
  pedestal: boolean;
  delight: boolean;
  amsColors: number;
  comfyWorkflow?: ComfyPresetId;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'convert',
    inputs: [],
    out: './output/model',
    profile: 'studio-ultra',
    sizeMm: 80,
    formats: ['glb', '3mf'],
    tolerance: 34,
    zephyrScript: false,
    lod: false,
    pedestal: false,
    delight: true,
    amsColors: 0,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (i === 0 && a === 'doctor') {
      args.command = 'doctor';
      continue;
    }
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '-i' || a === '--input') {
      const val = next();
      if (val) args.inputs.push(val);
    } else if (a === '--front') {
      args.front = next();
    } else if (a === '--back') {
      args.back = next();
    } else if (a === '--left') {
      args.left = next();
    } else if (a === '--right') {
      args.right = next();
    } else if (a === '--face') {
      args.face = next();
    } else if (a === '-o' || a === '--out') {
      args.out = next() || args.out;
    } else if (a === '-p' || a === '--profile') {
      const p = next() as QualityProfileId;
      if (p && p in QUALITY_PROFILES) args.profile = p;
    } else if (a === '--size' || a === '--size-mm') {
      const n = Number(next());
      if (Number.isFinite(n) && n >= 10 && n <= 300) args.sizeMm = n;
    } else if (a === '--resolution') {
      const n = Number(next());
      if (Number.isFinite(n) && n >= 32 && n <= 192) args.resolution = Math.round(n);
    } else if (a === '-f' || a === '--formats') {
      const f = next();
      if (f) {
        args.formats = f
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
      }
    } else if (a === '--tolerance') {
      const n = Number(next());
      if (Number.isFinite(n) && n >= 5 && n <= 120) args.tolerance = n;
    } else if (a === '--zephyr-script') {
      args.zephyrScript = true;
    } else if (a === '--lod') {
      args.lod = true;
    } else if (a === '--pedestal') {
      args.pedestal = true;
    } else if (a === '--no-delight') {
      args.delight = false;
    } else if (a === '--ams-colors') {
      const n = Number(next());
      if (Number.isFinite(n) && n >= 2 && n <= 8) args.amsColors = Math.round(n);
    } else if (a === '--comfy-workflow') {
      const preset = next() as ComfyPresetId;
      if (['pixal3d-single', 'pixal3d-multiview', 'pixal3d-int8', 'sf3d', 'hunyuan3d'].includes(preset)) {
        args.comfyWorkflow = preset;
      }
    } else if (!a.startsWith('-')) {
      args.inputs.push(a);
    }
  }
  return args;
}

export async function runCliDoctor() {
  const cpus = os.cpus().length;
  const totalMemGb = Number((os.totalmem() / 1024 ** 3).toFixed(1));
  const freeMemGb = Number((os.freemem() / 1024 ** 3).toFixed(1));
  let hfReachable = false;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3500);
    const r = await fetch('https://huggingface.co/api/spaces/TencentARC/Pixal3D', { signal: c.signal });
    clearTimeout(t);
    hfReachable = r.ok;
  } catch {
    hfReachable = false;
  }
  return {
    ok: true,
    nodeVersion: process.version,
    platform: `${os.platform()}/${os.arch()}`,
    cpuCores: cpus,
    memoryGb: { total: totalMemGb, free: freeMemGb },
    encoders: { png: true, jpeg: true, glb2: true, threemf: true, amsMultiColor3mf: true, stl: true, obj: true },
    comfyWorkflows: ['pixal3d-single', 'pixal3d-multiview', 'pixal3d-int8', 'sf3d', 'hunyuan3d'],
    hfApiReachable: hfReachable,
  };
}

function makeImageData(width: number, height: number, data: Uint8ClampedArray): ImageData {
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData;
}

/** Saf Node.js PNG / JPEG okuyucu (harici derleme gerektirmez). */
export function decodeImageFile(filePath: string): ImageData {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (isPng || ext === '.png') {
    const png = PNG.sync.read(buf);
    return makeImageData(png.width, png.height, new Uint8ClampedArray(png.data));
  }
  const jpg = jpeg.decode(buf, { useTArray: true });
  return makeImageData(jpg.width, jpg.height, new Uint8ClampedArray(jpg.data));
}

function resizeImageData(src: ImageData, maxDim: number): ImageData {
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  if (scale >= 0.999) return src;
  const dstW = Math.max(16, Math.round(src.width * scale));
  const dstH = Math.max(16, Math.round(src.height * scale));
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y / dstH) * src.height));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x / dstW) * src.width));
      const si = (sy * src.width + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = src.data[si];
      out[di + 1] = src.data[si + 1];
      out[di + 2] = src.data[si + 2];
      out[di + 3] = src.data[si + 3];
    }
  }
  return makeImageData(dstW, dstH, out);
}

/** DOM gerektirmeyen saf Node maske + renk normalize edici (kare 256×256 ortalanmış çıktı). */
export function normalizeImageAndMaskNode(
  cleaned: ImageData,
  targetSize = 256,
  paddingRatio = 0.08
): { color: ImageData; mask: BinaryMask } {
  const { width: w, height: h, data } = cleaned;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    minX = 0;
    minY = 0;
    maxX = w - 1;
    maxY = h - 1;
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const usable = targetSize * (1 - paddingRatio * 2);
  const scale = usable / Math.max(cropW, cropH);
  const drawW = Math.max(1, Math.round(cropW * scale));
  const drawH = Math.max(1, Math.round(cropH * scale));
  const dx = Math.round((targetSize - drawW) / 2);
  const dy = Math.round((targetSize - drawH) / 2);

  const outRgba = new Uint8ClampedArray(targetSize * targetSize * 4);
  const maskBytes = new Uint8Array(targetSize * targetSize);

  for (let y = 0; y < drawH; y++) {
    const sy = Math.min(maxY, minY + Math.floor((y / drawH) * cropH));
    const ty = dy + y;
    if (ty < 0 || ty >= targetSize) continue;
    for (let x = 0; x < drawW; x++) {
      const sx = Math.min(maxX, minX + Math.floor((x / drawW) * cropW));
      const tx = dx + x;
      if (tx < 0 || tx >= targetSize) continue;
      const si = (sy * w + sx) * 4;
      const di = (ty * targetSize + tx) * 4;
      outRgba[di] = data[si];
      outRgba[di + 1] = data[si + 1];
      outRgba[di + 2] = data[si + 2];
      outRgba[di + 3] = data[si + 3];
      maskBytes[ty * targetSize + tx] = data[si + 3] > 100 ? 1 : 0;
    }
  }

  return {
    color: makeImageData(targetSize, targetSize, outRgba),
    mask: { width: targetSize, height: targetSize, data: maskBytes },
  };
}

/**
 * Saf Node.js uyumlu minimal binary GLB 2.0 yazıcı (POSITION, NORMAL, TEXCOORD_0, COLOR_0).
 * Blender, Godot, Unity ve Unreal'da doğrudan açılır.
 */
export function buildNodeGLB(geometry: THREE.BufferGeometry): Buffer {
  const nonIdx = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!nonIdx.getAttribute('normal')) nonIdx.computeVertexNormals();
  nonIdx.computeBoundingBox();

  const posAttr = nonIdx.getAttribute('position') as THREE.BufferAttribute;
  const nrmAttr = nonIdx.getAttribute('normal') as THREE.BufferAttribute;
  const uvAttr = nonIdx.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const colAttr = nonIdx.getAttribute('color') as THREE.BufferAttribute | undefined;

  const vertCount = posAttr.count;
  const posBytes = Buffer.from(
    new Float32Array(posAttr.array as Float32Array).buffer
  );
  const nrmBytes = Buffer.from(
    new Float32Array(nrmAttr.array as Float32Array).buffer
  );
  const uvBytes = uvAttr
    ? Buffer.from(new Float32Array(uvAttr.array as Float32Array).buffer)
    : null;
  const colBytes = colAttr
    ? Buffer.from(new Float32Array(colAttr.array as Float32Array).buffer)
    : null;

  const chunks: Buffer[] = [];
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number; target: number }> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const attributes: Record<string, number> = {};

  let byteOffset = 0;
  const pushAttr = (
    name: string,
    buf: Buffer,
    type: 'VEC3' | 'VEC2',
    min?: number[],
    max?: number[]
  ) => {
    const viewIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.byteLength, target: 34962 });
    const accIdx = accessors.length;
    accessors.push({
      bufferView: viewIdx,
      componentType: 5126,
      count: vertCount,
      type,
      ...(min && max ? { min, max } : {}),
    });
    attributes[name] = accIdx;
    chunks.push(buf);
    byteOffset += buf.byteLength;
    const pad = (4 - (byteOffset % 4)) % 4;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad));
      byteOffset += pad;
    }
  };

  const box = nonIdx.boundingBox!;
  pushAttr(
    'POSITION',
    posBytes,
    'VEC3',
    [box.min.x, box.min.y, box.min.z],
    [box.max.x, box.max.y, box.max.z]
  );
  pushAttr('NORMAL', nrmBytes, 'VEC3');
  if (uvBytes) pushAttr('TEXCOORD_0', uvBytes, 'VEC2');
  if (colBytes) pushAttr('COLOR_0', colBytes, 'VEC3');

  const binBuf = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: '3BStudio CLI Photogrammetry' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: '3BStudio_Model' }],
    materials: [
      {
        name: '3BStudio_Material',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0.04,
          roughnessFactor: 0.68,
        },
      },
    ],
    meshes: [
      {
        name: '3BStudio_Mesh',
        primitives: [{ attributes, material: 0, mode: 4 }],
      },
    ],
    buffers: [{ byteLength: binBuf.byteLength }],
    bufferViews,
    accessors,
  };

  let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (jsonBuf.byteLength % 4)) % 4;
  if (jsonPad > 0) {
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  }

  const totalLength = 12 + 8 + jsonBuf.byteLength + 8 + binBuf.byteLength;
  const out = Buffer.alloc(totalLength);
  let off = 0;
  // GLB Header
  out.writeUInt32LE(0x46546c67, off); off += 4; // 'glTF'
  out.writeUInt32LE(2, off); off += 4;          // version 2
  out.writeUInt32LE(totalLength, off); off += 4;
  // JSON Chunk
  out.writeUInt32LE(jsonBuf.byteLength, off); off += 4;
  out.writeUInt32LE(0x4e4f534a, off); off += 4; // 'JSON'
  jsonBuf.copy(out, off); off += jsonBuf.byteLength;
  // BIN Chunk
  out.writeUInt32LE(binBuf.byteLength, off); off += 4;
  out.writeUInt32LE(0x004e4942, off); off += 4; // 'BIN\0'
  binBuf.copy(out, off);

  return out;
}

function collectInputFiles(rawInputs: string[]): string[] {
  const files: string[] = [];
  for (const item of rawInputs) {
    const resolved = path.resolve(item);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Giriş dosyası/klasörü bulunamadı: ${item}`);
    }
    const st = fs.statSync(resolved);
    if (st.isDirectory()) {
      const entries = fs
        .readdirSync(resolved)
        .filter((f) => /\.(png|jpe?g)$/i.test(f))
        .sort();
      for (const e of entries) files.push(path.join(resolved, e));
    } else {
      files.push(resolved);
    }
  }
  return files;
}

export async function runCliPipeline(args: CliArgs) {
  const profileSpec = QUALITY_PROFILES[args.profile];
  const masks: Partial<Record<ViewAngle, BinaryMask>> = {};
  const colorViews: Partial<Record<ViewAngle, ImageData>> = {};
  let faceCloseUp: ImageData | null = null;

  const explicitPairs: Array<[ViewAngle, string | undefined]> = [
    ['front', args.front],
    ['back', args.back],
    ['left', args.left],
    ['right', args.right],
  ];

  let loadedExplicit = 0;
  for (const [angle, fp] of explicitPairs) {
    if (!fp) continue;
    const raw = resizeImageData(decodeImageFile(path.resolve(fp)), 768);
    const cleaned = removeBackgroundFast(raw, args.tolerance);
    const norm = normalizeImageAndMaskNode(cleaned, 256);
    masks[angle] = norm.mask;
    colorViews[angle] = norm.color;
    loadedExplicit++;
  }

  if (args.face) {
    faceCloseUp = resizeImageData(decodeImageFile(path.resolve(args.face)), 768);
  }

  const extraFiles = collectInputFiles(args.inputs);
  if (loadedExplicit === 0 && extraFiles.length === 1) {
    // Tek görsel: önce karakter sheet çoklu görünüm algılamayı dene
    const fullImg = decodeImageFile(extraFiles[0]);
    const analysisImg = resizeImageData(fullImg, 1280);
    const grid = detectCharacterSheetGrid(analysisImg, { stripFrames: true });

    if (grid.cells.length >= 2) {
      const sx = fullImg.width / analysisImg.width;
      const sy = fullImg.height / analysisImg.height;
      for (const cell of grid.cells) {
        const crop = resizeImageData(
          cropImageData(fullImg, {
            x: Math.round(cell.x * sx),
            y: Math.round(cell.y * sy),
            width: Math.max(16, Math.round(cell.width * sx)),
            height: Math.max(16, Math.round(cell.height * sy)),
          }),
          768
        );
        if (cell.kind === 'face') {
          if (!faceCloseUp) faceCloseUp = crop;
          continue;
        }
        const cleaned = removeBackgroundFast(crop, args.tolerance);
        const norm = normalizeImageAndMaskNode(cleaned, 256);
        const angle = cell.suggestedAngle;
        if (!masks[angle]) {
          masks[angle] = norm.mask;
          colorViews[angle] = norm.color;
        }
      }
    } else {
      const small = resizeImageData(fullImg, 768);
      const cleaned = removeBackgroundFast(small, args.tolerance);
      const norm = normalizeImageAndMaskNode(cleaned, 256);
      masks.front = norm.mask;
      colorViews.front = norm.color;
    }
  } else if (loadedExplicit === 0 && extraFiles.length > 1) {
    const angleOrder: ViewAngle[] = ['front', 'right', 'back', 'left', 'frontRight', 'backRight', 'backLeft', 'frontLeft'];
    extraFiles.slice(0, angleOrder.length).forEach((fp, idx) => {
      const angle = angleOrder[idx];
      const raw = resizeImageData(decodeImageFile(fp), 768);
      const cleaned = removeBackgroundFast(raw, args.tolerance);
      const norm = normalizeImageAndMaskNode(cleaned, 256);
      masks[angle] = norm.mask;
      colorViews[angle] = norm.color;
    });
  }

  if (Object.keys(masks).length === 0) {
    throw new Error('En az bir PNG/JPEG görsel belirtmelisiniz (--input veya --front/--back).');
  }

  const rawGeo = reconstructVisualHull(masks, {
    resolution: args.resolution ?? profileSpec.resolution,
    smoothPasses: profileSpec.smoothPasses,
    sizeMm: args.sizeMm,
    colorViews,
    faceCloseUp,
    autoCompleteHead: true,
    projectColors: true,
  });
  const pruned = pruneLooseFragments(rawGeo, 0.005);
  rawGeo.dispose();
  const repaired = repairMesh(pruned.geometry);
  pruned.geometry.dispose();
  let finalGeo = applyQualityProfileToGeometry(repaired, args.profile);
  repaired.dispose();

  if (args.pedestal) {
    const withPed = addDisplayPedestal(finalGeo);
    finalGeo.dispose();
    finalGeo = withPed;
  }

  const stats = analyzeMesh(finalGeo);
  const qa = evaluatePolyMollyQa(finalGeo, args.profile, { hasTexture: false, stats });
  const printability = evaluatePrintabilityDoctor(finalGeo, { frontMask: masks.front });
  const manifest = buildRunManifest({
    source: 'cli',
    profileId: args.profile,
    lod: 'full',
    delighted: args.delight,
    hasPedestal: args.pedestal,
    angles: Object.keys(masks),
    stats,
    qa,
    printability,
  });

  const outBase = path.resolve(args.out).replace(/\.(glb|3mf|stl|obj)$/i, '');
  fs.mkdirSync(path.dirname(outBase), { recursive: true });

  const written: Array<{ format: string; file: string; bytes: number }> = [];
  for (const fmt of args.formats) {
    if (fmt === 'glb') {
      const buf = buildNodeGLB(finalGeo);
      const file = `${outBase}.glb`;
      fs.writeFileSync(file, buf);
      written.push({ format: 'glb', file, bytes: buf.byteLength });
    } else if (fmt === '3mf') {
      const file = `${outBase}.3mf`;
      if (args.amsColors >= 2) {
        const mc = buildMultiColor3MF(finalGeo, args.amsColors);
        fs.writeFileSync(file, mc.bytes);
        written.push({ format: `3mf-ams${args.amsColors}`, file, bytes: mc.bytes.byteLength });
      } else {
        const bytes = build3MF(finalGeo, { smartCompress: true });
        fs.writeFileSync(file, bytes);
        written.push({ format: '3mf', file, bytes: bytes.byteLength });
      }
    } else if (fmt === 'stl') {
      const bytes = buildSTLBinary(finalGeo, { smartCompress: true });
      const file = `${outBase}.stl`;
      fs.writeFileSync(file, new Uint8Array(bytes));
      written.push({ format: 'stl', file, bytes: bytes.byteLength });
    } else if (fmt === 'obj') {
      const txt = buildOBJ(finalGeo, { smartCompress: true });
      const file = `${outBase}.obj`;
      fs.writeFileSync(file, txt, 'utf8');
      written.push({ format: 'obj', file, bytes: Buffer.byteLength(txt, 'utf8') });
    }
  }

  if (args.lod) {
    for (const tier of ['20k', '5k'] as const) {
      const lodGeo = buildLodGeometry(finalGeo, tier);
      const buf = buildNodeGLB(lodGeo);
      lodGeo.dispose();
      const file = `${outBase}_lod${tier}.glb`;
      fs.writeFileSync(file, buf);
      written.push({ format: `glb-lod${tier}`, file, bytes: buf.byteLength });
    }
  }

  if (args.comfyWorkflow) {
    const wfFile = `${outBase}_comfy_${args.comfyWorkflow}.json`;
    const wfText = JSON.stringify(buildComfyUiWorkflowJson(args.comfyWorkflow), null, 2);
    fs.writeFileSync(wfFile, wfText, 'utf8');
    written.push({ format: 'comfy-json', file: wfFile, bytes: Buffer.byteLength(wfText, 'utf8') });
  }

  if (args.zephyrScript) {
    const batFile = `${outBase}_3df_zephyr.bat`;
    const shFile = `${outBase}_3df_zephyr.sh`;
    fs.writeFileSync(
      batFile,
      build3DFZephyrCliScript({
        projectName: path.basename(outBase),
        photosDir: path.dirname(extraFiles[0] || args.front || './photos'),
        outputDir: path.dirname(outBase),
        os: 'windows',
      }),
      'utf8'
    );
    fs.writeFileSync(
      shFile,
      build3DFZephyrCliScript({
        projectName: path.basename(outBase),
        photosDir: path.dirname(extraFiles[0] || args.front || './photos'),
        outputDir: path.dirname(outBase),
        os: 'linux',
      }),
      'utf8'
    );
    written.push({ format: 'zephyr-bat', file: batFile, bytes: fs.statSync(batFile).size });
    written.push({ format: 'zephyr-sh', file: shFile, bytes: fs.statSync(shFile).size });
  }

  const manifestFile = `${outBase}_run.json`;
  const manifestText = JSON.stringify({ ...manifest, outputs: written }, null, 2);
  fs.writeFileSync(manifestFile, manifestText, 'utf8');
  written.push({ format: 'run-json', file: manifestFile, bytes: Buffer.byteLength(manifestText, 'utf8') });

  finalGeo.dispose();
  return { stats, qa, printability, manifest, written, angles: Object.keys(masks) };
}

const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith(path.join('cli', 'image2model.ts'));

if (isMainModule) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'doctor') {
    runCliDoctor()
      .then((info) => console.log(JSON.stringify(info, null, 2)))
      .catch((err) => {
        console.error('Doctor Hatası:', (err as Error).message);
        process.exit(1);
      });
  } else if (parsed.help || (parsed.inputs.length === 0 && !parsed.front)) {
    console.log(`3BStudio CLI — Görselden / Karakter Sheet'ten 3D Model Üretici

Kullanım:
  npm run cli -- doctor
  npm run cli -- --input ./karakter-sheet.jpg --out ./out/karakter --lod --ams-colors 4 --pedestal
  npm run cli -- --front ./on.png --back ./arka.png --left ./sol.png --out ./out/figur

Seçenekler:
  doctor                      Sistem, bellek, kodlayıcı ve HF erişim sağlık kontrolü
  -i, --input <dosya|klasör>  Tek karakter sheet, tek fotoğraf veya fotoğraf klasörü
  --front / --back / --left / --right / --face  Açık açı fotoğrafları
  -o, --out <yol>             Çıktı dosya ön eki (varsayılan: ./output/model)
  -p, --profile <profil>      studio-ultra | game-polymolly | print-precision
  --size <mm>                 Hedef maksimum boyut mm (varsayılan: 80)
  --resolution <32..192>      Voksel çözünürlüğü
  -f, --formats <liste>       glb,3mf,stl,obj (varsayılan: glb,3mf)
  --lod                       Oyun/Mobil 20K ve 5K LOD GLB dosyalarını da üret
  --ams-colors <2..8>         Bambu AMS / Anycubic ACE Pro çok renkli .3mf kuantizasyonu
  --pedestal                  Figür altına dairesel sergi kaidesi ekle
  --comfy-workflow <preset>   pixal3d-single | pixal3d-multiview | pixal3d-int8 | sf3d | hunyuan3d
  --zephyr-script             3DF Zephyr masaüstü CLI .bat ve .sh betiklerini de üret`);
    process.exit(0);
  } else {
    runCliPipeline(parsed)
      .then((res) => {
        console.log(
          JSON.stringify(
            {
              ok: true,
              angles: res.angles,
              triangles: res.stats.triangleCount,
              dimensionsMm: {
                x: Number(res.stats.widthMm.toFixed(1)),
                y: Number(res.stats.heightMm.toFixed(1)),
                z: Number(res.stats.depthMm.toFixed(1)),
              },
              watertight: res.stats.isWatertight,
              polyMollyQaScore: res.qa.score,
              printability: res.printability,
              compatibleEngines: res.qa.compatibleEngines,
              outputs: res.written,
            },
            null,
            2
          )
        );
      })
      .catch((err) => {
        console.error('CLI Hatası:', (err as Error).message);
        process.exit(1);
      });
  }
}
