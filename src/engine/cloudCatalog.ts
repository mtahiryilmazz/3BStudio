import { FreeHfSpacePreset } from './types';

/**
 * Ücretsiz açık kaynaklı Hugging Face 3D üretim Space kataloğu.
 * Canlı durum kontrolü ile önce RUNNING aşamasındaki Space'ler önceliklendirilir;
 * otomatik yedekleme (auto-fallback) aktifken çalışan ilk Space'ten GLB üretilir.
 */
export const FREE_HF_SPACES: FreeHfSpacePreset[] = [
  {
    id: 'TencentARC/Pixal3D',
    name: 'Pixal3D (Piksel Hizalı · SIGGRAPH)',
    badge: 'Piksel Hizalı · Yüksek Sadakat',
    multiView: false,
    description: 'BiRefNet + MoGe + piksel geri-izdüşüm mimarisiyle girdi fotoğrafına birebir hizalı 3D GLB üretir.',
    preferredEndpoints: ['/generate_3d', '/image_to_3d', '/run', '/predict'],
  },
  {
    id: 'tencent/Hunyuan3D-2mv',
    name: 'Hunyuan3D-2mv (Çoklu Açı)',
    badge: 'Çoklu Açı · Yüksek Detay',
    multiView: true,
    description: 'Ön, arka, sol ve sağ görselleri birlikte işleyerek yüksek detaylı karakter/figür GLB modeli üretir.',
    preferredEndpoints: ['/shape_generation', '/generation_all', '/predict'],
  },
  {
    id: 'tencent/Hunyuan3D-2.1',
    name: 'Hunyuan3D-2.1 (Yeni Nesil PBR)',
    badge: 'PBR Doku · Yüksek Sadakat',
    multiView: false,
    description: 'Yeni nesil Hunyuan3D-2.1 ile net anatomik geometri ve PBR doku haritası üretir.',
    preferredEndpoints: ['/shape_generation', '/generation_all', '/generate_mesh', '/predict'],
  },
  {
    id: 'tencent/Hunyuan3D-2',
    name: 'Hunyuan3D-2 (Tek Görsel Pro)',
    badge: 'Yüksek Detay · PBR',
    multiView: false,
    description: 'Tek veya ön fotoğraftan yüksek çözünürlüklü geometri ve PBR doku haritası üretir.',
    preferredEndpoints: ['/shape_generation', '/generation_all', '/generate'],
  },
  {
    id: 'trellis-community/trellis',
    name: 'Microsoft TRELLIS',
    badge: 'Keskin Geometri · O-Voxel',
    multiView: false,
    description: 'Yapılandırılmış seyrek voksel mimarisiyle temiz ve net yüzeyli GLB modeli çıkarır.',
    preferredEndpoints: ['/image_to_3d', '/extract_glb', '/generate_and_extract_glb', '/predict'],
  },
  {
    id: 'VAST-AI/TripoSG',
    name: 'TripoSG (Yüksek Çözünürlük)',
    badge: 'Keskin Silüet · Açık Kaynak',
    multiView: false,
    description: 'Karakter ve nesnelerde keskin yüzey detayları üreten yüksek çözünürlüklü açık kaynaklı 3D model.',
    preferredEndpoints: ['/image_to_3d', '/run_segmentation', '/generate', '/predict'],
  },
  {
    id: 'Stable-X/Hi3DGen',
    name: 'Hi3DGen (Yüksek Rölyef)',
    badge: '3D Baskı · Sert Yüzey',
    multiView: false,
    description: 'Mekanik parçalar, figür rölyefleri ve keskin kenar detayları için yüksek geometrik sadakat sunar.',
    preferredEndpoints: ['/generate_3d', '/run', '/predict'],
  },
  {
    id: 'stabilityai/stable-fast-3d',
    name: 'Stable Fast 3D (SF3D)',
    badge: 'Çok Hızlı · UV+PBR',
    multiView: false,
    description: 'Saniyeler içinde temiz UV ve hızlı önizleme/baskı GLB mesh üretir.',
    preferredEndpoints: ['/run_button', '/generate', '/predict'],
  },
  {
    id: 'stabilityai/TripoSR',
    name: 'TripoSR (Hafif Yedek)',
    badge: 'Hafif · Güvenilir Yedek',
    multiView: false,
    description: 'Düşük kuyruk yoğunluklu, hızlı ve güvenilir açık kaynaklı 3D yeniden oluşturma yedeği.',
    preferredEndpoints: ['/generate', '/run', '/predict'],
  },
];

export const VALID_SPACE_ID_RE = /^[a-zA-Z0-9._-]{1,80}\/[a-zA-Z0-9._-]{1,100}$/;

export interface GradioParamSpec {
  parameter_name?: string;
  label?: string;
  component?: string;
  type?: string;
  python_type?: { type?: string; description?: string };
  example_input?: unknown;
  parameter_has_default?: boolean;
  parameter_default?: unknown;
}

export interface GradioNamedEndpoints {
  [endpoint: string]: { parameters?: GradioParamSpec[] } | undefined;
}

function isGradioNonFileComponent(p: GradioParamSpec): boolean {
  const comp = (p.component || '').toLowerCase();
  const typeStr = (p.type || p.python_type?.type || '').toLowerCase();
  return (
    comp.includes('checkbox') ||
    comp.includes('slider') ||
    comp.includes('number') ||
    comp.includes('radio') ||
    comp.includes('dropdown') ||
    comp.includes('textbox') ||
    typeStr === 'bool' ||
    typeStr === 'boolean' ||
    typeStr === 'int' ||
    typeStr === 'float' ||
    typeStr === 'number'
  );
}

export function isGradioImageParam(p: GradioParamSpec): boolean {
  if (isGradioNonFileComponent(p)) return false;
  const pname = (p.parameter_name || '').toLowerCase();
  const label = (p.label || '').toLowerCase();
  const comp = (p.component || '').toLowerCase();
  const typeStr = (p.type || p.python_type?.type || '').toLowerCase();
  return (
    comp.includes('image') ||
    comp.includes('file') ||
    comp.includes('gallery') ||
    typeStr === 'filepath' ||
    typeStr === 'blob' ||
    pname.includes('image') ||
    pname.includes('img') ||
    pname.includes('photo') ||
    label.includes('image')
  );
}

/**
 * Gradio Space API'sinin zorunlu (parameter_has_default: false) olarak işaretlediği
 * seed, steps, guidance_scale, rembg vb. parametrelere güvenli 3D üretim değeri döndürür.
 * Böylece "@gradio/client: No value provided for required parameter: seed" hatası engellenir.
 */
export function inferRequiredGradioParamValue(p: GradioParamSpec): unknown {
  if (p.parameter_has_default && p.parameter_default !== undefined) {
    return p.parameter_default;
  }

  const pname = (p.parameter_name || '').toLowerCase();
  const label = (p.label || '').toLowerCase();
  const comp = (p.component || '').toLowerCase();
  const typeStr = (p.type || p.python_type?.type || '').toLowerCase();
  const isBool = comp.includes('checkbox') || typeStr === 'bool' || typeStr === 'boolean';
  const isNum =
    comp.includes('slider') ||
    comp.includes('number') ||
    typeStr === 'int' ||
    typeStr === 'float' ||
    typeStr === 'number';
  const isStr = comp.includes('textbox') || comp.includes('text') || typeStr === 'str' || typeStr === 'string';
  const combined = `${pname} ${label}`;

  if (combined.includes('random') && combined.includes('seed')) {
    return isBool ? false : 0;
  }
  if (pname === 'seed' || pname.endsWith('_seed') || label === 'seed') {
    return 42;
  }
  if (
    combined.includes('rembg') ||
    combined.includes('remove_bg') ||
    combined.includes('remove_background') ||
    combined.includes('remove background')
  ) {
    return isBool ? true : 1;
  }
  if (
    isBool &&
    (combined.includes('texture') ||
      combined.includes('simplify') ||
      combined.includes('bake') ||
      combined.includes('mesh'))
  ) {
    return true;
  }
  if (combined.includes('foreground_ratio') || combined.includes('foreground ratio')) {
    return 0.85;
  }
  if (combined.includes('mesh_simplify') || combined.includes('simplify_ratio')) {
    return 0.95;
  }
  if (combined.includes('octree') || combined.includes('mc_resolution')) {
    return 256;
  }
  if (combined.includes('texture_size') || combined.includes('texture_resolution')) {
    return 1024;
  }
  if (combined.includes('target_face') || combined.includes('max_faces') || combined.includes('face_count')) {
    return 25000;
  }
  if (combined.includes('num_chunks')) {
    return 8000;
  }
  if (combined.includes('ss_sampling_steps') || combined.includes('slat_sampling_steps')) {
    return 12;
  }
  if (combined.includes('step')) {
    if (
      typeof p.example_input === 'number' &&
      Number.isFinite(p.example_input) &&
      p.example_input >= 4 &&
      p.example_input <= 60
    ) {
      return p.example_input;
    }
    return 30;
  }
  if (combined.includes('ss_guidance')) return 7.5;
  if (combined.includes('slat_guidance')) return 3.0;
  if (combined.includes('guidance') || combined.includes('cfg')) {
    if (
      typeof p.example_input === 'number' &&
      Number.isFinite(p.example_input) &&
      p.example_input >= 1 &&
      p.example_input <= 15
    ) {
      return p.example_input;
    }
    return 5.5;
  }
  if (isStr && (combined.includes('prompt') || combined.includes('caption') || combined.includes('negative'))) {
    return '';
  }

  if (
    p.example_input !== undefined &&
    p.example_input !== null &&
    (typeof p.example_input === 'number' ||
      typeof p.example_input === 'boolean' ||
      typeof p.example_input === 'string')
  ) {
    return p.example_input;
  }

  if (isBool) return false;
  if (isNum) return 0;
  if (isStr) return '';
  if (typeStr.includes('list') || typeStr.includes('array')) return [];
  return null;
}

export function pickBestGradioEndpoint(
  spaceId: string,
  named: GradioNamedEndpoints
): string {
  const namedKeys = Object.keys(named);
  const preset = FREE_HF_SPACES.find((s) => s.id.toLowerCase() === spaceId.toLowerCase());
  const hasImageParam = (ep: string) =>
    (named[ep]?.parameters ?? []).some((p) => isGradioImageParam(p));

  if (preset) {
    const preferredWithImage = preset.preferredEndpoints.find(
      (ep) => namedKeys.includes(ep) && hasImageParam(ep)
    );
    if (preferredWithImage) return preferredWithImage;
    const preferredAny = preset.preferredEndpoints.find((ep) => namedKeys.includes(ep));
    if (preferredAny) return preferredAny;
  }

  const imageEndpoints = namedKeys.filter((ep) => hasImageParam(ep));
  const pool = imageEndpoints.length > 0 ? imageEndpoints : namedKeys;

  return (
    pool.find((k) => /extract_glb|shape_generation|generation_all|image_to_3d|generate_3d|generate/i.test(k)) ||
    pool.find((k) => /shape|predict|run/i.test(k)) ||
    pool[0] ||
    '/predict'
  );
}

export function buildGradioPayload<TFile>(
  paramSpecs: GradioParamSpec[],
  blobs: { front: Blob; back?: Blob | null; left?: Blob | null; right?: Blob | null },
  wrapFile: (blob: Blob) => TFile
): Record<string, unknown> | unknown[] {
  if (paramSpecs.length === 0) {
    const fallback: Record<string, unknown> = {
      mv_image_front: wrapFile(blobs.front),
    };
    if (blobs.back) fallback.mv_image_back = wrapFile(blobs.back);
    if (blobs.left) fallback.mv_image_left = wrapFile(blobs.left);
    if (blobs.right) fallback.mv_image_right = wrapFile(blobs.right);
    return fallback;
  }

  const allNamed = paramSpecs.every((p) => typeof p.parameter_name === 'string' && p.parameter_name.length > 0);
  const values: unknown[] = new Array(paramSpecs.length);
  let assignedPrimaryImage = false;
  const extraBlobs = [blobs.back, blobs.left, blobs.right].filter((b): b is Blob => Boolean(b));

  for (let i = 0; i < paramSpecs.length; i++) {
    const p = paramSpecs[i];
    const pname = (p.parameter_name || '').toLowerCase();
    const label = (p.label || '').toLowerCase();
    const comp = (p.component || '').toLowerCase();
    const pyType = (p.python_type?.type || '').toLowerCase();

    if (isGradioImageParam(p)) {
      const isMulti = comp.includes('gallery') || pname.includes('multi') || pyType.includes('list');
      if (isMulti) {
        values[i] = [blobs.front, ...extraBlobs].map((b) => wrapFile(b));
        assignedPrimaryImage = true;
        continue;
      }
      if (pname.includes('back') || label.includes('back')) {
        values[i] = blobs.back
          ? wrapFile(blobs.back)
          : p.parameter_has_default && p.parameter_default !== undefined
            ? p.parameter_default
            : null;
        continue;
      }
      if (pname.includes('left') || label.includes('left')) {
        values[i] = blobs.left
          ? wrapFile(blobs.left)
          : p.parameter_has_default && p.parameter_default !== undefined
            ? p.parameter_default
            : null;
        continue;
      }
      if (pname.includes('right') || label.includes('right')) {
        values[i] = blobs.right
          ? wrapFile(blobs.right)
          : p.parameter_has_default && p.parameter_default !== undefined
            ? p.parameter_default
            : null;
        continue;
      }
      if (!assignedPrimaryImage || pname.includes('front') || label.includes('front')) {
        values[i] = wrapFile(blobs.front);
        assignedPrimaryImage = true;
        continue;
      }
      values[i] =
        p.parameter_has_default && p.parameter_default !== undefined ? p.parameter_default : null;
      continue;
    }

    values[i] = inferRequiredGradioParamValue(p);
  }

  if (!assignedPrimaryImage && paramSpecs.length > 0) {
    values[0] = wrapFile(blobs.front);
  }

  if (!allNamed) {
    return values;
  }

  const payload: Record<string, unknown> = {};
  for (let i = 0; i < paramSpecs.length; i++) {
    payload[paramSpecs[i].parameter_name!] = values[i];
  }
  return payload;
}

