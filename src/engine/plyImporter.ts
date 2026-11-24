import * as THREE from 'three';
import { marchingCubes } from './marchingCubes';
import { placeOnBuildPlate } from './meshRepair';

export interface PLYParseResult {
  geometry: THREE.BufferGeometry;
  wasPointCloud: boolean;
  pointCount: number;
}

/**
 * Converts a raw 3D point cloud into a watertight solid mesh via
 * voxel splatting + 3D smoothing + Marching Cubes.
 */
export function pointCloudToMesh(
  points: Float32Array,
  resolution = 64,
  sizeMm = 80
): THREE.BufferGeometry {
  const count = Math.floor(points.length / 3);
  if (count < 8) {
    throw new Error('Nokta bulutu çok az nokta içeriyor.');
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = points[i * 3];
    const y = points[i * 3 + 1];
    const z = points[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const spanX = Math.max(1e-4, maxX - minX);
  const spanY = Math.max(1e-4, maxY - minY);
  const spanZ = Math.max(1e-4, maxZ - minZ);
  const maxSpan = Math.max(spanX, spanY, spanZ);
  const pad = maxSpan * 0.12;

  const boundsMin: [number, number, number] = [minX - pad, minY - pad, minZ - pad];
  const boundsMax: [number, number, number] = [maxX + pad, maxY + pad, maxZ + pad];

  const nx = resolution;
  const ny = resolution;
  const nz = resolution;
  const field = new Float32Array(nx * ny * nz);
  const strideZ = nx * ny;

  const invX = (nx - 1) / (boundsMax[0] - boundsMin[0]);
  const invY = (ny - 1) / (boundsMax[1] - boundsMin[1]);
  const invZ = (nz - 1) / (boundsMax[2] - boundsMin[2]);

  // Splat each point with a 3x3x3 Gaussian kernel
  for (let i = 0; i < count; i++) {
    const gx = Math.round((points[i * 3] - boundsMin[0]) * invX);
    const gy = Math.round((points[i * 3 + 1] - boundsMin[1]) * invY);
    const gz = Math.round((points[i * 3 + 2] - boundsMin[2]) * invZ);

    for (let dz = -2; dz <= 2; dz++) {
      const z = gz + dz;
      if (z < 2 || z >= nz - 2) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const y = gy + dy;
        if (y < 2 || y >= ny - 2) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const x = gx + dx;
          if (x < 2 || x >= nx - 2) continue;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > 5) continue;
          const weight = Math.exp(-d2 * 0.55);
          const idx = z * strideZ + y * nx + x;
          field[idx] = Math.min(1.5, field[idx] + weight);
        }
      }
    }
  }

  const geo = marchingCubes(field, nx, ny, nz, 0.45, boundsMin, boundsMax);
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (!box || box.isEmpty()) {
    throw new Error('Nokta bulutundan kapalı 3D ağ çıkarılamadı.');
  }
  const sz = new THREE.Vector3();
  box.getSize(sz);
  const curMax = Math.max(sz.x, sz.y, sz.z, 1e-4);
  if (curMax < 2 || curMax > 500) {
    // Normalize meter/unit clouds to realistic millimeter scale
    const s = sizeMm / curMax;
    geo.scale(s, s, s);
  }
  return placeOnBuildPlate(geo);
}

/**
 * Parses ASCII or binary_little_endian .PLY meshes and point clouds
 * (including scans captured from the Android ARCore Depth app).
 */
export function parsePLY(buffer: ArrayBuffer): PLYParseResult {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('ascii');
  // Header is within first 16 KB
  const headerSlice = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 16384)));
  const endHeaderIdx = headerSlice.indexOf('end_header');
  if (endHeaderIdx === -1) {
    throw new Error('Geçersiz PLY dosyası: end_header bulunamadı.');
  }

  const newlineAfterHeader = headerSlice.indexOf('\n', endHeaderIdx);
  const headerText = headerSlice.slice(0, endHeaderIdx);
  const dataOffset = newlineAfterHeader !== -1 ? newlineAfterHeader + 1 : endHeaderIdx + 'end_header'.length;

  let format: 'ascii' | 'binary_little_endian' = 'ascii';
  let vertexCount = 0;
  let faceCount = 0;
  let currentElement = '';
  const vertexProps: { name: string; type: string }[] = [];

  for (const rawLine of headerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('comment')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'format') {
      if (parts[1] === 'binary_little_endian') format = 'binary_little_endian';
      else if (parts[1] !== 'ascii') {
        throw new Error(`Desteklenmeyen PLY formatı: ${parts[1]}`);
      }
    } else if (parts[0] === 'element') {
      currentElement = parts[1];
      if (currentElement === 'vertex') vertexCount = parseInt(parts[2], 10);
      else if (currentElement === 'face') faceCount = parseInt(parts[2], 10);
    } else if (parts[0] === 'property' && currentElement === 'vertex' && parts[1] !== 'list') {
      vertexProps.push({ type: parts[1], name: parts[2] });
    }
  }

  const xIdx = vertexProps.findIndex((p) => p.name === 'x');
  const yIdx = vertexProps.findIndex((p) => p.name === 'y');
  const zIdx = vertexProps.findIndex((p) => p.name === 'z');
  if (xIdx === -1 || yIdx === -1 || zIdx === -1) {
    throw new Error('PLY dosyasında x, y, z vertex özellikleri bulunamadı.');
  }

  const positions = new Float32Array(vertexCount * 3);
  const indices: number[] = [];

  if (format === 'ascii') {
    const bodyText = new TextDecoder('utf-8').decode(bytes.subarray(dataOffset));
    const lines = bodyText.split(/\r?\n/);
    let linePtr = 0;

    let readVerts = 0;
    while (readVerts < vertexCount && linePtr < lines.length) {
      const line = lines[linePtr++].trim();
      if (!line) continue;
      const cols = line.split(/\s+/);
      positions[readVerts * 3] = parseFloat(cols[xIdx]);
      positions[readVerts * 3 + 1] = parseFloat(cols[yIdx]);
      positions[readVerts * 3 + 2] = parseFloat(cols[zIdx]);
      readVerts++;
    }

    let readFaces = 0;
    while (readFaces < faceCount && linePtr < lines.length) {
      const line = lines[linePtr++].trim();
      if (!line) continue;
      const cols = line.split(/\s+/);
      const n = parseInt(cols[0], 10);
      if (n >= 3) {
        const v0 = parseInt(cols[1], 10);
        for (let k = 1; k + 1 < n; k++) {
          indices.push(v0, parseInt(cols[1 + k], 10), parseInt(cols[2 + k], 10));
        }
      }
      readFaces++;
    }
  } else {
    const view = new DataView(buffer, dataOffset);
    let offset = 0;

    const typeSize = (t: string) => {
      switch (t) {
        case 'char': case 'int8': case 'uchar': case 'uint8': return 1;
        case 'short': case 'int16': case 'ushort': case 'uint16': return 2;
        case 'int': case 'int32': case 'uint': case 'uint32': case 'float': case 'float32': return 4;
        case 'double': case 'float64': return 8;
        default: return 4;
      }
    };

    const readVal = (t: string): number => {
      let v = 0;
      switch (t) {
        case 'float': case 'float32': v = view.getFloat32(offset, true); break;
        case 'double': case 'float64': v = view.getFloat64(offset, true); break;
        case 'uchar': case 'uint8': v = view.getUint8(offset); break;
        case 'char': case 'int8': v = view.getInt8(offset); break;
        case 'ushort': case 'uint16': v = view.getUint16(offset, true); break;
        case 'short': case 'int16': v = view.getInt16(offset, true); break;
        case 'uint': case 'uint32': v = view.getUint32(offset, true); break;
        default: v = view.getInt32(offset, true); break;
      }
      offset += typeSize(t);
      return v;
    };

    for (let i = 0; i < vertexCount; i++) {
      for (let p = 0; p < vertexProps.length; p++) {
        const val = readVal(vertexProps[p].type);
        if (p === xIdx) positions[i * 3] = val;
        else if (p === yIdx) positions[i * 3 + 1] = val;
        else if (p === zIdx) positions[i * 3 + 2] = val;
      }
    }

    for (let f = 0; f < faceCount; f++) {
      if (offset >= view.byteLength) break;
      const n = view.getUint8(offset);
      offset += 1;
      const faceVerts: number[] = [];
      for (let k = 0; k < n; k++) {
        faceVerts.push(view.getInt32(offset, true));
        offset += 4;
      }
      for (let k = 1; k + 1 < faceVerts.length; k++) {
        indices.push(faceVerts[0], faceVerts[k], faceVerts[k + 1]);
      }
    }
  }

  if (indices.length === 0) {
    const geo = pointCloudToMesh(positions, 60, 80);
    return { geometry: geo, wasPointCloud: true, pointCount: vertexCount };
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return {
    geometry: placeOnBuildPlate(geo),
    wasPointCloud: false,
    pointCount: vertexCount,
  };
}
