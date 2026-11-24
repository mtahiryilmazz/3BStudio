import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

interface TriangleSoup {
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * Converts Three.js Y-up geometry to standard 3D slicer Z-up coordinates (mm)
 * with minZ = 0 and X/Y centered at origin.
 * Mapping: (x, y, z)_Three -> (x, -z, y)_Slicer (preserves right-handedness & outward winding).
 */
function toSlicerCoordinates(geometry: THREE.BufferGeometry): TriangleSoup {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count === 0) {
    return { vertices: new Float32Array(0), indices: new Uint32Array(0) };
  }

  const indexAttr = geometry.getIndex();
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

  return { vertices, indices };
}

/**
 * Generates standard binary STL (millimeters, Z-up, seated at Z=0).
 */
export function buildSTLBinary(geometry: THREE.BufferGeometry): ArrayBuffer {
  const { vertices, indices } = toSlicerCoordinates(geometry);
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
 * Generates an OPC-compliant 3MF archive (millimeters, Z-up) compatible with
 * Bambu Studio, PrusaSlicer, OrcaSlicer, and UltiMaker Cura.
 */
export function build3MF(geometry: THREE.BufferGeometry): Uint8Array {
  const { vertices, indices } = toSlicerCoordinates(geometry);

  const vertLines: string[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    vertLines.push(
      `          <vertex x="${vertices[i].toFixed(4)}" y="${vertices[i + 1].toFixed(4)}" z="${vertices[i + 2].toFixed(4)}" />`
    );
  }

  const triLines: string[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    triLines.push(
      `          <triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}" />`
    );
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">Photo2Print 3D Model</metadata>
  <metadata name="Application">Photo2Print 3D Studio</metadata>
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
${vertLines.join('\n')}
        </vertices>
        <triangles>
${triLines.join('\n')}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`;

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels': strToU8(relsXml),
    '3D/3dmodel.model': strToU8(modelXml),
  });
}

/**
 * Generates Wavefront OBJ text (millimeters, Z-up).
 */
export function buildOBJ(geometry: THREE.BufferGeometry): string {
  const { vertices, indices } = toSlicerCoordinates(geometry);
  const lines: string[] = ['# Photo2Print 3D Studio - OBJ (mm, Z-up)', 'o Photo2PrintPart'];

  for (let i = 0; i < vertices.length; i += 3) {
    lines.push(
      `v ${vertices[i].toFixed(4)} ${vertices[i + 1].toFixed(4)} ${vertices[i + 2].toFixed(4)}`
    );
  }
  for (let i = 0; i + 2 < indices.length; i += 3) {
    lines.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`);
  }
  return lines.join('\n');
}

/**
 * Exports GLB binary via Three.js GLTFExporter.
 */
export function exportGLB(geometry: THREE.BufferGeometry): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        roughness: 0.45,
        metalness: 0.1,
        vertexColors: geometry.hasAttribute('color'),
      })
    );
    exporter.parse(
      mesh,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          const json = JSON.stringify(result);
          resolve(new TextEncoder().encode(json).buffer);
        }
      },
      (err) => reject(err),
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
