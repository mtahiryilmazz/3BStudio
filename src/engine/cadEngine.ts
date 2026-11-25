import * as THREE from 'three';
import * as modeling from '@jscad/modeling';
import type { CadExpr, CadNode, CadParameter, CadSpec } from './types';

const { primitives, booleans, transforms, extrusions, hulls, geometries } = modeling;

type Geom3 = modeling.geometries.geom3.Geom3;

const MAX_NODES = 160;
const MAX_DEPTH = 16;
const MAX_ARRAY_COUNT = 36;

/**
 * Güvenli özyinelemeli aritmetik ifade çözümleyici.
 * eval() / new Function() KULLANMAZ — yalnızca sayı, parametre adı,
 * + - * / ( ) ve temel matematik fonksiyonlarını (min, max, abs, sin, cos, sqrt) destekler.
 */
export function evalCadExpr(expr: CadExpr, params: Record<string, number>, fallback = 0): number {
  if (typeof expr === 'number') {
    return Number.isFinite(expr) ? expr : fallback;
  }
  const src = String(expr).trim();
  if (!src) return fallback;
  if (/^[+-]?\d+(\.\d+)?$/.test(src)) return Number(src);

  let pos = 0;
  const skipWs = () => {
    while (pos < src.length && /\s/.test(src[pos])) pos++;
  };

  const parseExpr = (): number => {
    let val = parseTerm();
    while (true) {
      skipWs();
      if (src[pos] === '+') {
        pos++;
        val += parseTerm();
      } else if (src[pos] === '-') {
        pos++;
        val -= parseTerm();
      } else {
        break;
      }
    }
    return val;
  };

  const parseTerm = (): number => {
    let val = parseUnary();
    while (true) {
      skipWs();
      if (src[pos] === '*') {
        pos++;
        val *= parseUnary();
      } else if (src[pos] === '/') {
        pos++;
        const denom = parseUnary();
        val = Math.abs(denom) < 1e-9 ? 0 : val / denom;
      } else {
        break;
      }
    }
    return val;
  };

  const parseUnary = (): number => {
    skipWs();
    if (src[pos] === '+') {
      pos++;
      return parseUnary();
    }
    if (src[pos] === '-') {
      pos++;
      return -parseUnary();
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    skipWs();
    if (src[pos] === '(') {
      pos++;
      const val = parseExpr();
      skipWs();
      if (src[pos] === ')') pos++;
      return val;
    }
    // Number literal
    const numMatch = src.slice(pos).match(/^\d+(\.\d+)?/);
    if (numMatch) {
      pos += numMatch[0].length;
      return Number(numMatch[0]);
    }
    // Identifier or whitelisted math function
    const idMatch = src.slice(pos).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (idMatch) {
      const name = idMatch[0];
      pos += name.length;
      skipWs();
      if (src[pos] === '(') {
        pos++;
        const args: number[] = [];
        skipWs();
        if (src[pos] !== ')') {
          args.push(parseExpr());
          skipWs();
          while (src[pos] === ',') {
            pos++;
            args.push(parseExpr());
            skipWs();
          }
        }
        if (src[pos] === ')') pos++;
        switch (name) {
          case 'min':
            return args.length ? Math.min(...args) : 0;
          case 'max':
            return args.length ? Math.max(...args) : 0;
          case 'abs':
            return Math.abs(args[0] ?? 0);
          case 'sqrt':
            return Math.sqrt(Math.max(0, args[0] ?? 0));
          case 'sin':
            return Math.sin(((args[0] ?? 0) * Math.PI) / 180);
          case 'cos':
            return Math.cos(((args[0] ?? 0) * Math.PI) / 180);
          default:
            return fallback;
        }
      }
      if (name === 'PI') return Math.PI;
      if (Object.prototype.hasOwnProperty.call(params, name)) {
        return params[name];
      }
      return fallback;
    }
    return fallback;
  };

  try {
    const out = parseExpr();
    return Number.isFinite(out) ? out : fallback;
  } catch {
    return fallback;
  }
}

function clampDim(v: number, min = 0.4, max = 300): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function buildGearGeom(teethRaw: number, moduleRaw: number, thicknessRaw: number, boreRadiusRaw: number): Geom3 {
  const teeth = Math.max(6, Math.min(48, Math.round(teethRaw)));
  const mod = clampDim(moduleRaw, 0.8, 12);
  const thickness = clampDim(thicknessRaw, 1, 80);
  const pitchR = (teeth * mod) / 2;
  const addendum = mod * 0.95;
  const dedendum = mod * 1.15;
  const outerR = pitchR + addendum;
  const rootR = Math.max(1.5, pitchR - dedendum);

  const pts: Array<[number, number]> = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a0 = i * step;
    const a1 = a0 + step * 0.16;
    const a2 = a0 + step * 0.30;
    const a3 = a0 + step * 0.56;
    const a4 = a0 + step * 0.70;
    pts.push([Math.cos(a0) * rootR, Math.sin(a0) * rootR]);
    pts.push([Math.cos(a1) * rootR, Math.sin(a1) * rootR]);
    pts.push([Math.cos(a2) * outerR, Math.sin(a2) * outerR]);
    pts.push([Math.cos(a3) * outerR, Math.sin(a3) * outerR]);
    pts.push([Math.cos(a4) * rootR, Math.sin(a4) * rootR]);
  }
  const poly2d = primitives.polygon({ points: pts });
  let gear = extrusions.extrudeLinear({ height: thickness }, poly2d);
  gear = transforms.translate([0, 0, -thickness / 2], gear);

  const boreR = Math.max(0, Math.min(rootR - 1.2, boreRadiusRaw));
  if (boreR >= 0.6) {
    const bore = primitives.cylinder({ radius: boreR, height: thickness + 2, segments: 32 });
    gear = booleans.subtract(gear, bore);
  }
  return gear;
}

function buildHexNutGeom(flatToFlatRaw: number, thicknessRaw: number, holeRadiusRaw: number): Geom3 {
  const ftf = clampDim(flatToFlatRaw, 4, 120);
  const thickness = clampDim(thicknessRaw, 1.5, 60);
  const circumR = ftf / Math.sqrt(3);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    pts.push([Math.cos(a) * circumR, Math.sin(a) * circumR]);
  }
  let nut = extrusions.extrudeLinear({ height: thickness }, primitives.polygon({ points: pts }));
  nut = transforms.translate([0, 0, -thickness / 2], nut);
  const holeR = Math.max(0, Math.min(ftf * 0.42, holeRadiusRaw));
  if (holeR >= 0.5) {
    nut = booleans.subtract(nut, primitives.cylinder({ radius: holeR, height: thickness + 2, segments: 32 }));
  }
  return nut;
}

function evalNode(
  node: CadNode,
  params: Record<string, number>,
  state: { count: number },
  depth = 0
): Geom3 {
  state.count++;
  if (state.count > MAX_NODES || depth > MAX_DEPTH) {
    throw new Error('CAD modeli maksimum karmaşıklık sınırını aştı.');
  }

  const num = (e: CadExpr | undefined, def: number) => (e === undefined ? def : evalCadExpr(e, params, def));
  const vec3 = (v: [CadExpr, CadExpr, CadExpr], def: [number, number, number]): [number, number, number] => [
    num(v[0], def[0]),
    num(v[1], def[1]),
    num(v[2], def[2]),
  ];

  switch (node.type) {
    case 'cuboid': {
      const [x, y, z] = vec3(node.size, [20, 20, 20]);
      return primitives.cuboid({ size: [clampDim(x), clampDim(y), clampDim(z)] });
    }
    case 'roundedCuboid': {
      const [x, y, z] = vec3(node.size, [20, 20, 20]);
      const sx = clampDim(x);
      const sy = clampDim(y);
      const sz = clampDim(z);
      const maxR = Math.min(sx, sy, sz) * 0.44;
      const rr = Math.max(0.2, Math.min(maxR, num(node.roundRadius, 2)));
      const segs = Math.max(8, Math.min(32, Math.round(num(node.segments, 16))));
      return primitives.roundedCuboid({ size: [sx, sy, sz], roundRadius: rr, segments: segs });
    }
    case 'cylinder': {
      const r = clampDim(num(node.radius, 10), 0.3, 180);
      const h = clampDim(num(node.height, 20), 0.4, 250);
      const segs = Math.max(12, Math.min(64, Math.round(num(node.segments, 36))));
      return primitives.cylinder({ radius: r, height: h, segments: segs });
    }
    case 'roundedCylinder': {
      const r = clampDim(num(node.radius, 10), 0.6, 180);
      const h = clampDim(num(node.height, 20), 0.8, 250);
      const maxR = Math.min(r * 0.45, h * 0.45);
      const rr = Math.max(0.2, Math.min(maxR, num(node.roundRadius, 1.5)));
      const segs = Math.max(12, Math.min(48, Math.round(num(node.segments, 32))));
      return primitives.roundedCylinder({ radius: r, height: h, roundRadius: rr, segments: segs });
    }
    case 'cone': {
      const r1 = clampDim(num(node.bottomRadius, 12), 0.2, 180);
      const r2 = Math.max(0.05, Math.min(180, num(node.topRadius, 4)));
      const h = clampDim(num(node.height, 20), 0.4, 250);
      const segs = Math.max(12, Math.min(64, Math.round(num(node.segments, 36))));
      return primitives.cylinderElliptic({
        height: h,
        startRadius: [r1, r1],
        endRadius: [r2, r2],
        segments: segs,
      });
    }
    case 'sphere': {
      const r = clampDim(num(node.radius, 12), 0.4, 150);
      const segs = Math.max(12, Math.min(48, Math.round(num(node.segments, 28))));
      return primitives.sphere({ radius: r, segments: segs });
    }
    case 'torus': {
      const innerR = clampDim(num(node.innerRadius, 3), 0.4, 80);
      const outerR = clampDim(num(node.outerRadius, 15), innerR + 0.5, 160);
      const inSeg = Math.max(10, Math.min(36, Math.round(num(node.innerSegments, 20))));
      const outSeg = Math.max(16, Math.min(64, Math.round(num(node.outerSegments, 36))));
      return primitives.torus({
        innerRadius: innerR,
        outerRadius: outerR,
        innerSegments: inSeg,
        outerSegments: outSeg,
      });
    }
    case 'tube': {
      const outerR = clampDim(num(node.outerRadius, 14), 1, 180);
      const innerR = Math.max(0.4, Math.min(outerR - 0.5, num(node.innerRadius, 10)));
      const h = clampDim(num(node.height, 20), 0.4, 250);
      const segs = Math.max(16, Math.min(64, Math.round(num(node.segments, 36))));
      return booleans.subtract(
        primitives.cylinder({ radius: outerR, height: h, segments: segs }),
        primitives.cylinder({ radius: innerR, height: h + 2, segments: segs })
      );
    }
    case 'gear': {
      return buildGearGeom(
        num(node.teeth, 18),
        num(node.module, 2),
        num(node.thickness, 8),
        num(node.boreRadius, 4)
      );
    }
    case 'hexNut': {
      return buildHexNutGeom(num(node.flatToFlat, 16), num(node.thickness, 7), num(node.holeRadius, 4));
    }
    case 'polygonExtrude': {
      const pts: Array<[number, number]> = (node.points || []).map(([px, py]) => [num(px, 0), num(py, 0)]);
      if (pts.length < 3) {
        return primitives.cuboid({ size: [10, 10, 10] });
      }
      const h = clampDim(num(node.height, 10), 0.4, 250);
      const g = extrusions.extrudeLinear({ height: h }, primitives.polygon({ points: pts }));
      return transforms.translate([0, 0, -h / 2], g);
    }
    case 'translate': {
      const offset = vec3(node.offset, [0, 0, 0]);
      return transforms.translate(offset, evalNode(node.child, params, state, depth + 1));
    }
    case 'rotate': {
      const [rx, ry, rz] = vec3(node.anglesDeg, [0, 0, 0]);
      const d2r = Math.PI / 180;
      return transforms.rotate([rx * d2r, ry * d2r, rz * d2r], evalNode(node.child, params, state, depth + 1));
    }
    case 'scale': {
      const [sx, sy, sz] = vec3(node.factors, [1, 1, 1]);
      return transforms.scale(
        [clampDim(sx, 0.05, 20), clampDim(sy, 0.05, 20), clampDim(sz, 0.05, 20)],
        evalNode(node.child, params, state, depth + 1)
      );
    }
    case 'mirror': {
      const [nx, ny, nz] = vec3(node.normal, [1, 0, 0]);
      const len = Math.hypot(nx, ny, nz) || 1;
      return transforms.mirror({ normal: [nx / len, ny / len, nz / len] }, evalNode(node.child, params, state, depth + 1));
    }
    case 'linearArray': {
      const count = Math.max(1, Math.min(MAX_ARRAY_COUNT, Math.round(num(node.count, 2))));
      const [dx, dy, dz] = vec3(node.step, [10, 0, 0]);
      const base = evalNode(node.child, params, state, depth + 1);
      const items: Geom3[] = [];
      for (let i = 0; i < count; i++) {
        items.push(transforms.translate([dx * i, dy * i, dz * i], base));
      }
      return items.length === 1 ? items[0] : booleans.union(...items);
    }
    case 'radialArray': {
      const count = Math.max(1, Math.min(MAX_ARRAY_COUNT, Math.round(num(node.count, 4))));
      const r = num(node.radius, 15);
      const axis = node.axis ?? 'z';
      const base = evalNode(node.child, params, state, depth + 1);
      const items: Geom3[] = [];
      for (let i = 0; i < count; i++) {
        const angle = (i * Math.PI * 2) / count;
        if (axis === 'z') {
          const moved = transforms.translate([r, 0, 0], base);
          items.push(transforms.rotateZ(angle, moved));
        } else if (axis === 'y') {
          const moved = transforms.translate([r, 0, 0], base);
          items.push(transforms.rotateY(angle, moved));
        } else {
          const moved = transforms.translate([0, r, 0], base);
          items.push(transforms.rotateX(angle, moved));
        }
      }
      return items.length === 1 ? items[0] : booleans.union(...items);
    }
    case 'union': {
      const list = (node.children || []).map((c) => evalNode(c, params, state, depth + 1));
      if (list.length === 0) throw new Error('Union işlemi için en az 1 parça gerekli.');
      return list.length === 1 ? list[0] : booleans.union(...list);
    }
    case 'subtract': {
      const list = (node.children || []).map((c) => evalNode(c, params, state, depth + 1));
      if (list.length === 0) throw new Error('Subtract işlemi için en az 1 parça gerekli.');
      if (list.length === 1) return list[0];
      return booleans.subtract(list[0], ...list.slice(1));
    }
    case 'intersect': {
      const list = (node.children || []).map((c) => evalNode(c, params, state, depth + 1));
      if (list.length === 0) throw new Error('Intersect işlemi için en az 1 parça gerekli.');
      return list.length === 1 ? list[0] : booleans.intersect(...list);
    }
    case 'hull': {
      const list = (node.children || []).map((c) => evalNode(c, params, state, depth + 1));
      if (list.length === 0) throw new Error('Hull işlemi için en az 1 parça gerekli.');
      return list.length === 1 ? list[0] : hulls.hull(...list);
    }
    default:
      throw new Error(`Desteklenmeyen CAD düğümü: ${(node as { type?: string }).type ?? 'bilinmeyen'}`);
  }
}

/**
 * JSCAD Geom3 katı modelini keskin kenar normallerini koruyarak, T-kavşaklarını (T-junction)
 * otomatik kapatıp %100 su geçirmez (manifold) Y-up Three.js BufferGeometry'ye çevirir.
 * Z-up CAD koordinatları → Three.js Y-up (x, z, -y) eşlenir ve taban Y = 0 mm üzerine oturtulur.
 */
function geom3ToBufferGeometry(geom: Geom3): THREE.BufferGeometry {
  const rawPolygons = geometries.geom3.toPolygons(geom);

  // 1) Y-up dönüşümü + 1e-4 mm ızgara üzerinde uzamsal düğüm birleştirme (T-junction & weld tutarlılığı)
  const SNAP_TOL = 2e-4;
  const CELL = 5e-4;
  const invCell = 1 / CELL;
  const grid = new Map<string, number[]>();
  const verts: Array<[number, number, number]> = [];

  const getVertId = (x: number, y: number, z: number): number => {
    const gx = Math.floor(x * invCell);
    const gy = Math.floor(y * invCell);
    const gz = Math.floor(z * invCell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!bucket) continue;
          for (const id of bucket) {
            const v = verts[id];
            const ddx = v[0] - x;
            const ddy = v[1] - y;
            const ddz = v[2] - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= SNAP_TOL * SNAP_TOL) {
              return id;
            }
          }
        }
      }
    }
    const id = verts.length;
    const sx = Math.round(x * 1e4) / 1e4;
    const sy = Math.round(y * 1e4) / 1e4;
    const sz = Math.round(z * 1e4) / 1e4;
    verts.push([sx, sy, sz]);
    const key = `${gx},${gy},${gz}`;
    const list = grid.get(key);
    if (list) list.push(id);
    else grid.set(key, [id]);
    return id;
  };

  const polyRings: number[][] = [];
  for (const poly of rawPolygons) {
    const ring: number[] = [];
    for (const rv of poly.vertices) {
      const id = getVertId(rv[0], rv[2], -rv[1]);
      if (ring.length === 0 || ring[ring.length - 1] !== id) {
        ring.push(id);
      }
    }
    if (ring.length > 1 && ring[0] === ring[ring.length - 1]) {
      ring.pop();
    }
    if (ring.length >= 3) {
      polyRings.push(ring);
    }
  }

  // 2) T-kavşak (T-junction) çözümü: Bir çokgenin kenarı üzerinde duran komşu düğümleri kenara ekle
  const TJ_EPS = 6e-4;
  const TJ_EPS_SQ = TJ_EPS * TJ_EPS;
  const positions: number[] = [];
  const normals: number[] = [];

  for (const ring of polyRings) {
    // Orijinal çokgenin dışa bakan düzlem normali (Newell yöntemi)
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = verts[ring[i]];
      const b = verts[ring[(i + 1) % ring.length]];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-10) continue;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;

    // Orijinal köşelerin ağırlık merkezi (dışbükey çokgenin kesinlikle iç bölgesindedir)
    let cx = 0, cy = 0, cz = 0;
    for (const id of ring) {
      cx += verts[id][0];
      cy += verts[id][1];
      cz += verts[id][2];
    }
    cx = Math.round((cx / ring.length) * 1e4) / 1e4;
    cy = Math.round((cy / ring.length) * 1e4) / 1e4;
    cz = Math.round((cz / ring.length) * 1e4) / 1e4;

    // Her kenarda T-kavşak düğümlerini tespit et ve t sırasıyla araya ekle
    const refined: number[] = [];
    let hadTJunction = false;
    for (let i = 0; i < ring.length; i++) {
      const aId = ring[i];
      const bId = ring[(i + 1) % ring.length];
      refined.push(aId);
      const a = verts[aId];
      const b = verts[bId];
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const abz = b[2] - a[2];
      const abLenSq = abx * abx + aby * aby + abz * abz;
      if (abLenSq < 1e-8) continue;

      const minX = Math.min(a[0], b[0]) - TJ_EPS;
      const maxX = Math.max(a[0], b[0]) + TJ_EPS;
      const minY = Math.min(a[1], b[1]) - TJ_EPS;
      const maxY = Math.max(a[1], b[1]) + TJ_EPS;
      const minZ = Math.min(a[2], b[2]) - TJ_EPS;
      const maxZ = Math.max(a[2], b[2]) + TJ_EPS;

      const splits: Array<{ id: number; t: number }> = [];
      for (let vId = 0; vId < verts.length; vId++) {
        if (vId === aId || vId === bId) continue;
        const p = verts[vId];
        if (p[0] < minX || p[0] > maxX || p[1] < minY || p[1] > maxY || p[2] < minZ || p[2] > maxZ) continue;
        const apx = p[0] - a[0];
        const apy = p[1] - a[1];
        const apz = p[2] - a[2];
        const t = (apx * abx + apy * aby + apz * abz) / abLenSq;
        if (t <= 1e-5 || t >= 1 - 1e-5) continue;
        const px = a[0] + abx * t - p[0];
        const py = a[1] + aby * t - p[1];
        const pz = a[2] + abz * t - p[2];
        if (px * px + py * py + pz * pz <= TJ_EPS_SQ) {
          // Uç noktalardan yeterince ayrı mı kontrol et
          const daSq = apx * apx + apy * apy + apz * apz;
          const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
          const dbSq = bpx * bpx + bpy * bpy + bpz * bpz;
          if (daSq > TJ_EPS_SQ && dbSq > TJ_EPS_SQ) {
            splits.push({ id: vId, t });
          }
        }
      }

      if (splits.length > 0) {
        hadTJunction = true;
        splits.sort((u, v) => u.t - v.t);
        for (const s of splits) {
          if (refined[refined.length - 1] !== s.id) {
            refined.push(s.id);
          }
        }
      }
    }

    const emitTri = (p0: [number, number, number], p1: [number, number, number], p2: [number, number, number]) => {
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      const tx = uy * vz - uz * vy;
      const ty = uz * vx - ux * vz;
      const tz = ux * vy - uy * vx;
      if (tx * tx + ty * ty + tz * tz < 1e-14) return;
      // Normal yönü ters düşmüşse sarımı düzelt
      if (tx * nx + ty * ny + tz * nz < 0) {
        positions.push(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p1[0], p1[1], p1[2]);
      } else {
        positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
      }
      normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    };

    if (refined.length === 3) {
      emitTri(verts[refined[0]], verts[refined[1]], verts[refined[2]]);
    } else if (!hadTJunction && refined.length === 4) {
      emitTri(verts[refined[0]], verts[refined[1]], verts[refined[2]]);
      emitTri(verts[refined[0]], verts[refined[2]], verts[refined[3]]);
    } else {
      // T-kavşak içeren veya 4'ten fazla köşeli çokgenlerde merkezden yelpaze üçgenleme:
      // Tüm dış alt-kenarlar birebir korunur, iç konuşma kenarları tam 2 üçgen paylaşır.
      const center: [number, number, number] = [cx, cy, cz];
      for (let i = 0; i < refined.length; i++) {
        emitTri(center, verts[refined[i]], verts[refined[(i + 1) % refined.length]]);
      }
    }
  }

  if (positions.length === 0) {
    throw new Error('CAD işlemi boş geometri üretti; parametreleri kontrol edin.');
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.computeBoundingBox();

  // X ve Z'de merkeze al, tabanı Y=0 mm yazıcı tablasına oturt (1e-4 mm ızgarayı koru)
  const box = geo.boundingBox!;
  const centerX = Math.round(((box.min.x + box.max.x) / 2) * 1e4) / 1e4;
  const centerZ = Math.round(((box.min.z + box.max.z) / 2) * 1e4) / 1e4;
  geo.translate(-centerX, -box.min.y, -centerZ);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Parametrik CadSpec + güncel parametre değerlerinden su geçirmez Three.js BufferGeometry üretir.
 */
export function compileCadSpec(
  spec: CadSpec,
  overrideValues?: Record<string, number>
): THREE.BufferGeometry {
  const paramMap: Record<string, number> = {};
  for (const p of spec.parameters) {
    paramMap[p.name] = overrideValues && overrideValues[p.name] !== undefined ? overrideValues[p.name] : p.value;
  }
  const geom = evalNode(spec.root, paramMap, { count: 0 }, 0);
  return geom3ToBufferGeometry(geom);
}

/**
 * earthtojake/text-to-cad ile uyumlu, yerel Python + build123d ortamında doğrudan çalıştırılabilen
 * parametrik CAD betiği üretir.
 */
export function generateBuild123dCode(spec: CadSpec, overrideValues?: Record<string, number>): string {
  if (spec.build123dCode && spec.build123dCode.includes('build123d')) {
    // Güncel parametre değerlerini başlık sabitlerine yansıt
    let code = spec.build123dCode;
    for (const p of spec.parameters) {
      const val = overrideValues?.[p.name] ?? p.value;
      const re = new RegExp(`^(${p.name}\\s*=\\s*)[-+]?\\d+(?:\\.\\d+)?`, 'm');
      if (re.test(code)) {
        code = code.replace(re, `$1${val}`);
      }
    }
    return code;
  }

  const paramLines = spec.parameters
    .map((p) => `${p.name} = ${overrideValues?.[p.name] ?? p.value}  # ${p.label}${p.unit ? ` (${p.unit})` : ''}`)
    .join('\n');

  const safeTitle = spec.title.replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase() || 'model';

  const emitNode = (node: CadNode, indent = '    '): string => {
    const f = (e: CadExpr | undefined, def: number) => (e === undefined ? String(def) : String(e));
    switch (node.type) {
      case 'cuboid':
        return `${indent}Box(${f(node.size[0], 20)}, ${f(node.size[1], 20)}, ${f(node.size[2], 20)})`;
      case 'roundedCuboid':
        return `${indent}Box(${f(node.size[0], 20)}, ${f(node.size[1], 20)}, ${f(node.size[2], 20)})`;
      case 'cylinder':
      case 'roundedCylinder':
        return `${indent}Cylinder(radius=${f(node.radius, 10)}, height=${f(node.height, 20)})`;
      case 'cone':
        return `${indent}Cone(bottom_radius=${f(node.bottomRadius, 12)}, top_radius=${f(node.topRadius, 4)}, height=${f(node.height, 20)})`;
      case 'sphere':
        return `${indent}Sphere(radius=${f(node.radius, 12)})`;
      case 'torus':
        return `${indent}Torus(major_radius=${f(node.outerRadius, 15)}, minor_radius=${f(node.innerRadius, 3)})`;
      case 'tube':
        return `${indent}Cylinder(radius=${f(node.outerRadius, 14)}, height=${f(node.height, 20)})\n${indent}Cylinder(radius=${f(node.innerRadius, 10)}, height=${f(node.height, 20)} + 2, mode=Mode.SUBTRACT)`;
      case 'gear':
        return `${indent}Cylinder(radius=(${f(node.teeth, 18)} * ${f(node.module, 2)}) / 2, height=${f(node.thickness, 8)})  # ${f(node.teeth, 18)}T M${f(node.module, 2)} spur gear`;
      case 'hexNut':
        return `${indent}RegularPolygon(radius=${f(node.flatToFlat, 16)} / 1.732, side_count=6)  # extrude ${f(node.thickness, 7)} mm`;
      case 'translate':
        return `${indent}with Locations((${f(node.offset[0], 0)}, ${f(node.offset[1], 0)}, ${f(node.offset[2], 0)})):\n${emitNode(node.child, indent + '    ')}`;
      case 'rotate':
        return `${indent}with Locations(Rotation(${f(node.anglesDeg[0], 0)}, ${f(node.anglesDeg[1], 0)}, ${f(node.anglesDeg[2], 0)})):\n${emitNode(node.child, indent + '    ')}`;
      case 'union':
        return (node.children || []).map((c) => emitNode(c, indent)).join('\n');
      case 'subtract': {
        const [first, ...rest] = node.children || [];
        if (!first) return `${indent}pass`;
        const subLines = rest.map((c) => `${indent}# Subtract:\n${emitNode(c, indent)}`).join('\n');
        return `${emitNode(first, indent)}\n${subLines}`;
      }
      default:
        return `${indent}Box(20, 20, 20)`;
    }
  };

  return `"""
${spec.title} — 3BStudio / text-to-cad (build123d) Parametrik CAD Betiği
${spec.summary}

Çalıştırma (earthtojake/text-to-cad veya build123d ile):
  pip install build123d
  python ${safeTitle}.py
"""
from build123d import *

# Parametreler (mm)
${paramLines}

with BuildPart() as part:
${emitNode(spec.root, '    ')}

# 3D yazıcı ve CAD dışa aktarımı
export_step(part.part, "${safeTitle}.step")
export_stl(part.part, "${safeTitle}.stl")
print(f"Hacim: {part.part.volume / 1000:.2f} cm3")
`;
}

/**
 * İnternet/API beklemeden anında çalışabilen 5 hazır parametrik 3D baskı CAD şablonu.
 */
export const CAD_PRESETS: Array<{ id: string; label: string; spec: CadSpec }> = [
  {
    id: 'l-bracket',
    label: 'L-Montaj Braketi (M4)',
    spec: {
      title: 'M4 Köşe Montaj Braketi',
      summary: 'Takviye kaburgalı ve 4 adet M4 montaj delikli 3D baskıya hazır L-braket.',
      parameters: [
        { name: 'width', label: 'Genişlik', unit: 'mm', value: 44, min: 20, max: 120, step: 2 },
        { name: 'armLen', label: 'Kol Uzunluğu', unit: 'mm', value: 46, min: 24, max: 120, step: 2 },
        { name: 'thick', label: 'Duvar Kalınlığı', unit: 'mm', value: 5, min: 2.5, max: 14, step: 0.5 },
        { name: 'holeDia', label: 'Vida Delik Çapı', unit: 'mm', value: 4.4, min: 2.2, max: 12, step: 0.2 },
      ],
      root: {
        type: 'subtract',
        children: [
          {
            type: 'union',
            children: [
              // Yatay taban kolu
              {
                type: 'translate',
                offset: [0, 'armLen / 2 - thick / 2', 'thick / 2'],
                child: { type: 'roundedCuboid', size: ['width', 'armLen', 'thick'], roundRadius: 1.5, segments: 12 },
              },
              // Dikey kol
              {
                type: 'translate',
                offset: [0, 0, 'armLen / 2'],
                child: { type: 'roundedCuboid', size: ['width', 'thick', 'armLen'], roundRadius: 1.5, segments: 12 },
              },
              // Sol ve sağ takviye kaburgası (gusset)
              {
                type: 'translate',
                offset: ['-(width / 2 - thick / 2)', 'thick / 2', 'thick'],
                child: {
                  type: 'rotate',
                  anglesDeg: [90, 0, 90],
                  child: {
                    type: 'polygonExtrude',
                    points: [
                      [0, 0],
                      ['armLen * 0.55', 0],
                      [0, 'armLen * 0.55'],
                    ],
                    height: 'thick * 0.8',
                  },
                },
              },
              {
                type: 'translate',
                offset: ['width / 2 - thick / 2', 'thick / 2', 'thick'],
                child: {
                  type: 'rotate',
                  anglesDeg: [90, 0, 90],
                  child: {
                    type: 'polygonExtrude',
                    points: [
                      [0, 0],
                      ['armLen * 0.55', 0],
                      [0, 'armLen * 0.55'],
                    ],
                    height: 'thick * 0.8',
                  },
                },
              },
            ],
          },
          // Yatay taban delikleri (2x)
          {
            type: 'translate',
            offset: ['-width * 0.26', 'armLen * 0.62', 'thick / 2'],
            child: { type: 'cylinder', radius: 'holeDia / 2', height: 'thick + 4', segments: 28 },
          },
          {
            type: 'translate',
            offset: ['width * 0.26', 'armLen * 0.62', 'thick / 2'],
            child: { type: 'cylinder', radius: 'holeDia / 2', height: 'thick + 4', segments: 28 },
          },
          // Dikey kol delikleri (2x)
          {
            type: 'translate',
            offset: ['-width * 0.26', 0, 'armLen * 0.66'],
            child: {
              type: 'rotate',
              anglesDeg: [90, 0, 0],
              child: { type: 'cylinder', radius: 'holeDia / 2', height: 'thick + 4', segments: 28 },
            },
          },
          {
            type: 'translate',
            offset: ['width * 0.26', 0, 'armLen * 0.66'],
            child: {
              type: 'rotate',
              anglesDeg: [90, 0, 0],
              child: { type: 'cylinder', radius: 'holeDia / 2', height: 'thick + 4', segments: 28 },
            },
          },
        ],
      },
    },
  },
  {
    id: 'spur-gear',
    label: 'Parametrik Dişli Çark',
    spec: {
      title: 'Düz Dişli Çark (Spur Gear)',
      summary: 'Mil yuvalı ve merkez göbekli, 3D yazıcı toleranslı parametrik dişli çark.',
      parameters: [
        { name: 'teeth', label: 'Diş Sayısı', value: 20, min: 8, max: 40, step: 1 },
        { name: 'module', label: 'Diş Modülü', unit: 'mm', value: 2.2, min: 1.2, max: 5, step: 0.2 },
        { name: 'thickness', label: 'Dişli Kalınlığı', unit: 'mm', value: 8, min: 3, max: 25, step: 1 },
        { name: 'boreDia', label: 'Mil Delik Çapı', unit: 'mm', value: 8, min: 3, max: 20, step: 0.5 },
      ],
      root: {
        type: 'subtract',
        children: [
          {
            type: 'union',
            children: [
              { type: 'gear', teeth: 'teeth', module: 'module', thickness: 'thickness', boreRadius: 0 },
              {
                type: 'translate',
                offset: [0, 0, 'thickness * 0.35'],
                child: { type: 'cylinder', radius: 'boreDia * 0.95', height: 'thickness * 1.4', segments: 36 },
              },
            ],
          },
          { type: 'cylinder', radius: 'boreDia / 2', height: 'thickness * 3', segments: 36 },
        ],
      },
    },
  },
  {
    id: 'electronics-box',
    label: 'Elektronik Devre Kutusu',
    spec: {
      title: 'Parametrik Elektronik Muhafaza Kutusu',
      summary: 'Köşe PCB yükseltme ayakları ve yan kablo/USB çıkışlı 3D baskı elektronik kutusu.',
      parameters: [
        { name: 'length', label: 'Uzunluk', unit: 'mm', value: 76, min: 40, max: 180, step: 2 },
        { name: 'width', label: 'Genişlik', unit: 'mm', value: 54, min: 30, max: 150, step: 2 },
        { name: 'height', label: 'Yükseklik', unit: 'mm', value: 26, min: 12, max: 80, step: 2 },
        { name: 'wall', label: 'Duvar Kalınlığı', unit: 'mm', value: 2.8, min: 1.6, max: 6, step: 0.2 },
      ],
      root: {
        type: 'subtract',
        children: [
          {
            type: 'union',
            children: [
              {
                type: 'subtract',
                children: [
                  { type: 'roundedCuboid', size: ['length', 'width', 'height'], roundRadius: 3, segments: 14 },
                  {
                    type: 'translate',
                    offset: [0, 0, 'wall'],
                    child: {
                      type: 'cuboid',
                      size: ['length - wall * 2', 'width - wall * 2', 'height'],
                    },
                  },
                ],
              },
              // 4 köşe PCB ayağı
              {
                type: 'translate',
                offset: ['length / 2 - wall - 5', 'width / 2 - wall - 5', '-height / 2 + wall + 3'],
                child: { type: 'tube', outerRadius: 3.6, innerRadius: 1.5, height: 6, segments: 24 },
              },
              {
                type: 'translate',
                offset: ['-(length / 2 - wall - 5)', 'width / 2 - wall - 5', '-height / 2 + wall + 3'],
                child: { type: 'tube', outerRadius: 3.6, innerRadius: 1.5, height: 6, segments: 24 },
              },
              {
                type: 'translate',
                offset: ['length / 2 - wall - 5', '-(width / 2 - wall - 5)', '-height / 2 + wall + 3'],
                child: { type: 'tube', outerRadius: 3.6, innerRadius: 1.5, height: 6, segments: 24 },
              },
              {
                type: 'translate',
                offset: ['-(length / 2 - wall - 5)', '-(width / 2 - wall - 5)', '-height / 2 + wall + 3'],
                child: { type: 'tube', outerRadius: 3.6, innerRadius: 1.5, height: 6, segments: 24 },
              },
            ],
          },
          // USB / kablo portu açıklığı
          {
            type: 'translate',
            offset: ['length / 2', 0, '-height / 2 + wall + 7'],
            child: { type: 'cuboid', size: ['wall * 3', 14, 8] },
          },
        ],
      },
    },
  },
  {
    id: 'pipe-clamp',
    label: 'Kablo / Boru Kelepçesi',
    spec: {
      title: 'Vidalı Boru ve Kablo Kelepçesi',
      summary: 'İki kulaklı montaj tabanı ve esnek kelepçe halkalı tutucu aparat.',
      parameters: [
        { name: 'pipeDia', label: 'Boru İç Çapı', unit: 'mm', value: 22, min: 8, max: 60, step: 1 },
        { name: 'wall', label: 'Et Kalınlığı', unit: 'mm', value: 3.5, min: 2, max: 8, step: 0.5 },
        { name: 'depth', label: 'Kelepçe Genişliği', unit: 'mm', value: 16, min: 8, max: 40, step: 2 },
        { name: 'screwDia', label: 'Montaj Deliği', unit: 'mm', value: 4.2, min: 2.5, max: 8, step: 0.2 },
      ],
      root: {
        type: 'subtract',
        children: [
          {
            type: 'union',
            children: [
              { type: 'cylinder', radius: 'pipeDia / 2 + wall', height: 'depth', segments: 40 },
              {
                type: 'translate',
                offset: [0, '-(pipeDia / 2 + wall * 0.4)', 0],
                child: { type: 'roundedCuboid', size: ['pipeDia + wall * 2 + 24', 'wall * 1.4', 'depth'], roundRadius: 1.2, segments: 10 },
              },
            ],
          },
          // İç boru boşluğu
          { type: 'cylinder', radius: 'pipeDia / 2', height: 'depth + 4', segments: 40 },
          // Üst geçme yarığı
          {
            type: 'translate',
            offset: [0, 'pipeDia / 2 + wall', 0],
            child: { type: 'cuboid', size: ['pipeDia * 0.55', 'pipeDia * 0.6', 'depth + 4'] },
          },
          // Sol & sağ vida delikleri
          {
            type: 'translate',
            offset: ['-(pipeDia / 2 + wall + 6)', '-(pipeDia / 2 + wall * 0.4)', 0],
            child: {
              type: 'rotate',
              anglesDeg: [90, 0, 0],
              child: { type: 'cylinder', radius: 'screwDia / 2', height: 'wall * 4', segments: 24 },
            },
          },
          {
            type: 'translate',
            offset: ['pipeDia / 2 + wall + 6', '-(pipeDia / 2 + wall * 0.4)', 0],
            child: {
              type: 'rotate',
              anglesDeg: [90, 0, 0],
              child: { type: 'cylinder', radius: 'screwDia / 2', height: 'wall * 4', segments: 24 },
            },
          },
        ],
      },
    },
  },
  {
    id: 'hex-flange',
    label: 'Altıgen Flanşlı Burç',
    spec: {
      title: 'Altıgen Flanşlı Mekanik Burç',
      summary: 'Anahtar tutuşlu altıgen flanş ve kademeli silindirik gövdeli adaptör.',
      parameters: [
        { name: 'hexSize', label: 'Altıgen Genişlik', unit: 'mm', value: 32, min: 14, max: 70, step: 2 },
        { name: 'flangeH', label: 'Flanş Yüksekliği', unit: 'mm', value: 7, min: 3, max: 20, step: 1 },
        { name: 'shaftDia', label: 'Gövde Dış Çapı', unit: 'mm', value: 20, min: 8, max: 50, step: 1 },
        { name: 'shaftH', label: 'Toplam Yükseklik', unit: 'mm', value: 26, min: 10, max: 80, step: 2 },
        { name: 'boreDia', label: 'İç Delik Çapı', unit: 'mm', value: 10, min: 3, max: 35, step: 0.5 },
      ],
      root: {
        type: 'subtract',
        children: [
          {
            type: 'union',
            children: [
              { type: 'hexNut', flatToFlat: 'hexSize', thickness: 'flangeH', holeRadius: 0 },
              {
                type: 'translate',
                offset: [0, 0, '(shaftH - flangeH) / 2'],
                child: { type: 'cylinder', radius: 'shaftDia / 2', height: 'shaftH', segments: 44 },
              },
            ],
          },
          {
            type: 'translate',
            offset: [0, 0, '(shaftH - flangeH) / 2'],
            child: { type: 'cylinder', radius: 'boreDia / 2', height: 'shaftH + 6', segments: 40 },
          },
        ],
      },
    },
  },
];
