import * as THREE from 'three';
import { zipSync, zlibSync, strToU8 } from 'fflate';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { decimateFlatRegions, weldVertices } from './meshRepair';

export interface ExportOptimizeOptions {
  /** Düz yüzeylerdeki gereksiz üçgenleri eğrilik-kilitli temizleyip dosya boyutunu küçültür. */
  smartCompress?: boolean;
}

interface TriangleSoup {
  vertices: Float32Array;
  indices: Uint32Array;
}

/** Gereksiz sondaki sıfırları atarak 1 mikron (0.001 mm) hassasiyetinde kompakt koordinat üretir. */
function fmtCoord(v: number): string {
  const s = v.toFixed(3);
  if (s === '-0.000' || s === '0.000') return '0';
  return s.replace(/\.?0+$/, '');
}

/**
 * Dışa aktarım öncesi isteğe bağlı eğrilik-kilitli düzlem sıkıştırması uygular.
 * Çağıran taraf `dispose` sorumluluğunu `shouldDispose` ile yönetir.
 */
function prepareExportGeometry(
  geometry: THREE.BufferGeometry,
  options?: ExportOptimizeOptions
): { geo: THREE.BufferGeometry; owned: boolean } {
  if (!options?.smartCompress) {
    return { geo: geometry, owned: false };
  }
  const res = decimateFlatRegions(geometry, {
    planarAngleDeg: 5.0,
    maxChordErrorRatio: 0.0005,
    maxPasses: 2,
  });
  return { geo: res.geometry, owned: true };
}

/**
 * Converts Three.js Y-up geometry to standard 3D slicer Z-up coordinates (mm)
 * with minZ = 0 and X/Y centered at origin.
 * Mapping: (x, y, z)_Three -> (x, -z, y)_Slicer (preserves right-handedness & outward winding).
 */
function toSlicerCoordinates(geometry: THREE.BufferGeometry, weldForCompact = false): TriangleSoup {
  const srcGeo = weldForCompact ? weldVertices(geometry, 1e-4) : geometry;
  const posAttr = srcGeo.getAttribute('position');
  if (!posAttr || posAttr.count === 0) {
    if (weldForCompact) srcGeo.dispose();
    return { vertices: new Float32Array(0), indices: new Uint32Array(0) };
  }

  const indexAttr = srcGeo.getIndex();
  const vertCount = posAttr.count;
  const vertices = new Float32Array(vertCount * 3);

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity;

  for (let i = 0; i < vertCount; i++) {
    const sx = posAttr.getX(i);
    const sy = -posAttr.getZ(i);
    const sz = posAttr.getY(i);
    vertices[i * 3] = sx;
    vertices[i * 3 + 1] = sy;
    vertices[i * 3 + 2] = sz;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
    if (sz < minZ) minZ = sz;
  }

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  for (let i = 0; i < vertCount; i++) {
    vertices[i * 3] -= cx;
    vertices[i * 3 + 1] -= cy;
    vertices[i * 3 + 2] -= minZ;
  }

  let indices: Uint32Array;
  if (indexAttr) {
    indices = new Uint32Array(indexAttr.count);
    for (let i = 0; i < indexAttr.count; i++) {
      indices[i] = indexAttr.getX(i);
    }
  } else {
    indices = new Uint32Array(vertCount);
    for (let i = 0; i < vertCount; i++) indices[i] = i;
  }

  if (weldForCompact) srcGeo.dispose();
  return { vertices, indices };
}

/**
 * Generates standard binary STL (millimeters, Z-up, seated at Z=0).
 */
export function buildSTLBinary(
  geometry: THREE.BufferGeometry,
  options?: ExportOptimizeOptions
): ArrayBuffer {
  const { geo, owned } = prepareExportGeometry(geometry, options);
  const { vertices, indices } = toSlicerCoordinates(geo, false);
  if (owned) geo.dispose();

  const triCount = Math.floor(indices.length / 3);
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);

  const headerText = 'Photo2Print 3D Studio - Binary STL (mm, Z-up)';
  for (let i = 0; i < Math.min(80, headerText.length); i++) {
    view.setUint8(i, headerText.charCodeAt(i));
  }
  view.setUint32(80, triCount, true);

  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3;
    const b = indices[t * 3 + 1] * 3;
    const c = indices[t * 3 + 2] * 3;

    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);

    view.setFloat32(offset + 12, ax, true);
    view.setFloat32(offset + 16, ay, true);
    view.setFloat32(offset + 20, az, true);

    view.setFloat32(offset + 24, bx, true);
    view.setFloat32(offset + 28, by, true);
    view.setFloat32(offset + 32, bz, true);

    view.setFloat32(offset + 36, cx, true);
    view.setFloat32(offset + 40, cy, true);
    view.setFloat32(offset + 44, cz, true);

    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }

  return buffer;
}

/**
 * Generates an OPC-compliant, ultra-compact 3MF archive (millimeters, Z-up, welded vertices,
 * DEFLATE level-9 compression) compatible with Bambu Studio, PrusaSlicer, OrcaSlicer, and UltiMaker Cura.
 */
export function build3MF(
  geometry: THREE.BufferGeometry,
  options?: ExportOptimizeOptions
): Uint8Array {
  const { geo, owned } = prepareExportGeometry(geometry, options);
  const { vertices, indices } = toSlicerCoordinates(geo, true);
  if (owned) geo.dispose();

  const vertLines: string[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    vertLines.push(
      `<vertex x="${fmtCoord(vertices[i])}" y="${fmtCoord(vertices[i + 1])}" z="${fmtCoord(vertices[i + 2])}"/>`
    );
  }

  const triLines: string[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    triLines.push(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`);
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">Photo2Print 3D Model</metadata><metadata name="Application">Photo2Print 3D Studio</metadata><resources><object id="1" type="model"><mesh><vertices>${vertLines.join('')}</vertices><triangles>${triLines.join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;

  return zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypesXml),
      '_rels/.rels': strToU8(relsXml),
      '3D/3dmodel.model': strToU8(modelXml),
    },
    { level: 9 }
  );
}

export interface AmsFilamentSlot {
  slot: number;
  hex: string;
  rgb: [number, number, number];
  triangleSharePct: number;
}

export interface MultiColor3mfResult {
  bytes: Uint8Array;
  palette: AmsFilamentSlot[];
}

function linearToSrgbByte(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  const s = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Jaco2308/Local3D_Studio esintili K-Means Çok Renkli Filament Kuantizasyonu (4–8 renk):
 * Bambu Lab AMS & Anycubic ACE Pro dilimleyicileri için her üçgeni en yakın filament
 * slotuna atar ve paleti döndürür.
 */
export function quantizeVertexColorsKMeans(
  geometry: THREE.BufferGeometry,
  kSlots = 4
): { palette: AmsFilamentSlot[]; triangleSlots: Uint8Array } {
  const k = Math.max(2, Math.min(8, Math.round(kSlots)));
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  const idx = geometry.getIndex();
  const triCount = !pos ? 0 : idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);

  if (triCount === 0 || !col) {
    return {
      palette: [{ slot: 1, hex: '#334155', rgb: [51, 65, 85], triangleSharePct: 100 }],
      triangleSlots: new Uint8Array(triCount),
    };
  }

  // Her üçgenin ortalama sRGB rengini çıkar
  const triRgb = new Uint8Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const r = (col.getX(i0) + col.getX(i1) + col.getX(i2)) / 3;
    const g = (col.getY(i0) + col.getY(i1) + col.getY(i2)) / 3;
    const b = (col.getZ(i0) + col.getZ(i1) + col.getZ(i2)) / 3;
    triRgb[t * 3] = linearToSrgbByte(r);
    triRgb[t * 3 + 1] = linearToSrgbByte(g);
    triRgb[t * 3 + 2] = linearToSrgbByte(b);
  }

  // Deterministik en uzak merkez başlangıcı (K-Means++)
  const centers: Array<[number, number, number]> = [];
  centers.push([triRgb[0], triRgb[1], triRgb[2]]);
  const sampleStride = Math.max(1, Math.floor(triCount / 2400));

  while (centers.length < k) {
    let bestDist = -1;
    let bestRgb: [number, number, number] = [128, 128, 128];
    for (let t = 0; t < triCount; t += sampleStride) {
      const r = triRgb[t * 3], g = triRgb[t * 3 + 1], b = triRgb[t * 3 + 2];
      let minD = Infinity;
      for (const c of centers) {
        const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
        if (d < minD) minD = d;
      }
      if (minD > bestDist) {
        bestDist = minD;
        bestRgb = [r, g, b];
      }
    }
    centers.push(bestRgb);
  }

  // 8 iterasyon K-Means
  const assign = new Uint8Array(triCount);
  for (let iter = 0; iter < 8; iter++) {
    const sumR = new Float64Array(k);
    const sumG = new Float64Array(k);
    const sumB = new Float64Array(k);
    const cnt = new Int32Array(k);

    for (let t = 0; t < triCount; t++) {
      const r = triRgb[t * 3], g = triRgb[t * 3 + 1], b = triRgb[t * 3 + 2];
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - centers[c][0];
        const dg = g - centers[c][1];
        const db = b - centers[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      assign[t] = bestC;
      sumR[bestC] += r;
      sumG[bestC] += g;
      sumB[bestC] += b;
      cnt[bestC]++;
    }

    for (let c = 0; c < k; c++) {
      if (cnt[c] > 0) {
        centers[c] = [
          Math.round(sumR[c] / cnt[c]),
          Math.round(sumG[c] / cnt[c]),
          Math.round(sumB[c] / cnt[c]),
        ];
      }
    }
  }

  const finalCounts = new Int32Array(k);
  for (let t = 0; t < triCount; t++) finalCounts[assign[t]]++;

  const palette: AmsFilamentSlot[] = centers.map((rgb, i) => ({
    slot: i + 1,
    hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
    rgb,
    triangleSharePct: Number(((finalCounts[i] / Math.max(1, triCount)) * 100).toFixed(1)),
  }));

  return { palette, triangleSlots: assign };
}

/**
 * Bambu Studio / OrcaSlicer / Anycubic Slicer Next uyumlu Çok Renkli (.3mf) ihracı:
 * 3MF Core `<basematerials>` tanımlarıyla her üçgeni K-Means filament rengine bağlar.
 */
export function buildMultiColor3MF(
  geometry: THREE.BufferGeometry,
  kSlots = 4
): MultiColor3mfResult {
  const { palette, triangleSlots } = quantizeVertexColorsKMeans(geometry, kSlots);
  const { vertices, indices } = toSlicerCoordinates(geometry, false);

  const baseMatXml = palette
    .map((p) => `<base name="Filament_${p.slot}" displaycolor="${p.hex}"/>`)
    .join('');

  const vertLines: string[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    vertLines.push(
      `<vertex x="${fmtCoord(vertices[i])}" y="${fmtCoord(vertices[i + 1])}" z="${fmtCoord(vertices[i + 2])}"/>`
    );
  }

  const triLines: string[] = [];
  const triCount = Math.floor(indices.length / 3);
  for (let t = 0; t < triCount; t++) {
    const slotIdx = triangleSlots[t] ?? 0;
    triLines.push(
      `<triangle v1="${indices[t * 3]}" v2="${indices[t * 3 + 1]}" v3="${indices[t * 3 + 2]}" pid="2" p1="${slotIdx}"/>`
    );
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">3BStudio Multi-Color AMS/ACE Model</metadata><metadata name="Application">3BStudio</metadata><resources><basematerials id="2">${baseMatXml}</basematerials><object id="1" type="model" pid="2" pindex="0"><mesh><vertices>${vertLines.join('')}</vertices><triangles>${triLines.join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;

  const bytes = zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypesXml),
      '_rels/.rels': strToU8(relsXml),
      '3D/3dmodel.model': strToU8(modelXml),
    },
    { level: 9 }
  );

  return { bytes, palette };
}

/**
 * Generates compact Wavefront OBJ text (millimeters, Z-up, welded shared vertices).
 */
export function buildOBJ(
  geometry: THREE.BufferGeometry,
  options?: ExportOptimizeOptions
): string {
  const { geo, owned } = prepareExportGeometry(geometry, options);
  const { vertices, indices } = toSlicerCoordinates(geo, true);
  if (owned) geo.dispose();

  const lines: string[] = ['# Photo2Print 3D Studio - OBJ (mm, Z-up)', 'o Photo2PrintPart'];

  for (let i = 0; i < vertices.length; i += 3) {
    lines.push(
      `v ${fmtCoord(vertices[i])} ${fmtCoord(vertices[i + 1])} ${fmtCoord(vertices[i + 2])}`
    );
  }
  for (let i = 0; i + 2 < indices.length; i += 3) {
    lines.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`);
  }
  return lines.join('\n');
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Bytes(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = PNG_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = crc32Bytes(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return out;
}

/**
 * Bağımsız (tarayıcı + Node uyumlu) hızlı RGBA -> PNG kodlayıcı.
 */
export function encodeRgbaToPng(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rowLen = width * 4;
  const raw = new Uint8Array((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0; // filter type 0 (None)
    raw.set(rgba.subarray(y * rowLen, (y + 1) * rowLen), y * (rowLen + 1) + 1);
  }
  const compressed = zlibSync(raw, { level: 6 });

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const cIhdr = pngChunk('IHDR', ihdr);
  const cIdat = pngChunk('IDAT', compressed);
  const cIend = pngChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(sig.length + cIhdr.length + cIdat.length + cIend.length);
  let off = 0;
  out.set(sig, off); off += sig.length;
  out.set(cIhdr, off); off += cIhdr.length;
  out.set(cIdat, off); off += cIdat.length;
  out.set(cIend, off);
  return out;
}

export interface ObjMtlTextureMaps {
  width: number;
  height: number;
  albedo: Uint8ClampedArray;
  normal?: Uint8ClampedArray;
  roughness?: Uint8ClampedArray;
  metallic?: Uint8ClampedArray;
  ao?: Uint8ClampedArray;
}

/**
 * akararasul37/mesh-atolye esintili tam `OBJ + MTL + PBR Dokular (.zip)` paketi:
 * Blender, Maya, 3ds Max, Unreal ve Unity içine tek seferde UV + Albedo/Normal/Roughness/Metallic/AO aktarır.
 */
export function buildObjMtlZip(
  geometry: THREE.BufferGeometry,
  textures?: ObjMtlTextureMaps | null
): Uint8Array {
  const nonIdx = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  if (!nonIdx.getAttribute('normal')) nonIdx.computeVertexNormals();
  const pos = nonIdx.getAttribute('position') as THREE.BufferAttribute;
  const nrm = nonIdx.getAttribute('normal') as THREE.BufferAttribute;
  const uv = nonIdx.getAttribute('uv') as THREE.BufferAttribute | undefined;

  const objLines: string[] = [
    '# 3BStudio - Textured OBJ + MTL Package (mm, Y-up)',
    'mtllib model.mtl',
    'o 3BStudioModel',
    'usemtl material_0',
  ];

  for (let i = 0; i < pos.count; i++) {
    objLines.push(`v ${fmtCoord(pos.getX(i))} ${fmtCoord(pos.getY(i))} ${fmtCoord(pos.getZ(i))}`);
  }
  if (uv) {
    for (let i = 0; i < uv.count; i++) {
      objLines.push(`vt ${uv.getX(i).toFixed(5)} ${uv.getY(i).toFixed(5)}`);
    }
  }
  for (let i = 0; i < nrm.count; i++) {
    objLines.push(`vn ${nrm.getX(i).toFixed(4)} ${nrm.getY(i).toFixed(4)} ${nrm.getZ(i).toFixed(4)}`);
  }

  const triCount = Math.floor(pos.count / 3);
  for (let t = 0; t < triCount; t++) {
    const a = t * 3 + 1;
    const b = t * 3 + 2;
    const c = t * 3 + 3;
    if (uv) {
      objLines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
    } else {
      objLines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
  }

  nonIdx.dispose();

  const mtlLines: string[] = [
    '# 3BStudio PBR Material',
    'newmtl material_0',
    'Ka 1.000 1.000 1.000',
    'Kd 1.000 1.000 1.000',
    'Ks 0.120 0.120 0.120',
    'Ns 64.000',
    'd 1.000',
    'illum 2',
  ];

  const files: Record<string, Uint8Array> = {
    'model.obj': strToU8(objLines.join('\n')),
  };

  if (textures) {
    mtlLines.push('map_Kd albedo.png');
    files['albedo.png'] = encodeRgbaToPng(textures.albedo, textures.width, textures.height);
    if (textures.normal) {
      mtlLines.push('map_Bump -bm 1.0 normal.png');
      files['normal.png'] = encodeRgbaToPng(textures.normal, textures.width, textures.height);
    }
    if (textures.roughness) {
      mtlLines.push('map_Pr roughness.png');
      files['roughness.png'] = encodeRgbaToPng(textures.roughness, textures.width, textures.height);
    }
    if (textures.metallic) {
      mtlLines.push('map_Pm metallic.png');
      files['metallic.png'] = encodeRgbaToPng(textures.metallic, textures.width, textures.height);
    }
    if (textures.ao) {
      mtlLines.push('map_Ka ao.png');
      files['ao.png'] = encodeRgbaToPng(textures.ao, textures.width, textures.height);
    }
  }

  files['model.mtl'] = strToU8(mtlLines.join('\n'));
  return zipSync(files, { level: 6 });
}

/**
 * GLB dışa aktarımı için düğümleri tekilleştirip indeksli hale getirir ve vertex renklerini
 * 8-bit normalize tamponla (4× daha küçük) paketler.
 */
function buildCompactGlbGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  const indexAttr = geometry.getIndex();

  if (indexAttr && !colAttr) {
    return geometry.clone();
  }

  const tol = 1e-4;
  const invTol = 1 / tol;
  const map = new Map<string, number>();
  const outPos: number[] = [];
  const outCol: number[] = [];
  const outIdx: number[] = [];
  const count = indexAttr ? indexAttr.count : posAttr.count;

  for (let i = 0; i < count; i++) {
    const vi = indexAttr ? indexAttr.getX(i) : i;
    const x = posAttr.getX(vi);
    const y = posAttr.getY(vi);
    const z = posAttr.getZ(vi);
    const r = colAttr ? Math.max(0, Math.min(255, Math.round(colAttr.getX(vi) * 255))) : 0;
    const g = colAttr ? Math.max(0, Math.min(255, Math.round(colAttr.getY(vi) * 255))) : 0;
    const b = colAttr ? Math.max(0, Math.min(255, Math.round(colAttr.getZ(vi) * 255))) : 0;
    const key = colAttr
      ? `${Math.round(x * invTol)},${Math.round(y * invTol)},${Math.round(z * invTol)}_${r >> 2}_${g >> 2}_${b >> 2}`
      : `${Math.round(x * invTol)},${Math.round(y * invTol)},${Math.round(z * invTol)}`;

    let id = map.get(key);
    if (id === undefined) {
      id = outPos.length / 3;
      map.set(key, id);
      outPos.push(x, y, z);
      if (colAttr) outCol.push(r, g, b);
    }
    outIdx.push(id);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  if (colAttr) {
    out.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(outCol), 3, true));
  }
  out.setIndex(outIdx);
  out.computeVertexNormals();
  return out;
}

/**
 * Exports compact indexed GLB binary via Three.js GLTFExporter.
 */
export function exportGLB(
  geometry: THREE.BufferGeometry,
  options?: ExportOptimizeOptions
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const { geo: prepared, owned } = prepareExportGeometry(geometry, options);
    const compactGeo = buildCompactGlbGeometry(prepared);
    if (owned) prepared.dispose();

    const hasVertexColors = compactGeo.hasAttribute('color');
    const exporter = new GLTFExporter();
    const material = new THREE.MeshStandardMaterial({
      color: hasVertexColors ? 0xffffff : 0x38bdf8,
      roughness: 0.45,
      metalness: 0.1,
      vertexColors: hasVertexColors,
    });
    const mesh = new THREE.Mesh(compactGeo, material);
    exporter.parse(
      mesh,
      (result) => {
        compactGeo.dispose();
        material.dispose();
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          const json = JSON.stringify(result);
          resolve(new TextEncoder().encode(json).buffer);
        }
      },
      (err) => {
        compactGeo.dispose();
        material.dispose();
        reject(err);
      },
      { binary: true }
    );
  });
}

/**
 * Rig'li mesh + AnimationClip listesini tek GLB olarak export eder
 * (GLTF `skins` + `animations` bölümleri dahil; Blender/Unity/Godot/Unreal uyumlu).
 */
export function exportAnimatedGLB(
  skinnedMesh: THREE.Object3D,
  clips: THREE.AnimationClip[]
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      skinnedMesh,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          const json = JSON.stringify(result);
          resolve(new TextEncoder().encode(json).buffer);
        }
      },
      (err) => reject(err),
      { binary: true, animations: clips }
    );
  });
}

export function triggerDownload(
  data: ArrayBuffer | Uint8Array | string,
  filename: string,
  mimeType = 'application/octet-stream'
): void {
  const blobPart: BlobPart =
    typeof data === 'string'
      ? data
      : data instanceof Uint8Array
      ? new Uint8Array(data)
      : data;
  const blob = new Blob([blobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
