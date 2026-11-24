import type { OfflineMethod, ViewAngle } from './types';

/**
 * Otomatik çoklu-foto pipeline'ının karar katmanı.
 *
 * Bu modül DOM'a, three.js'e veya ağır bağımlılıklara dokunmaz: yalnızca fotoğraf
 * boyutlarından/ipuçlarından görünüm planı çıkarır ve hangi yerel üretim motorunun
 * (visualHull / contourExtrude / lathe) kullanılacağını söyler. Ağır iş yapan
 * rekonstrüksiyonlar mevcut `visualHull.ts`, `contourExtrude.ts`, `latheRevolve.ts`
 * fonksiyonlarında kalır; onların girdisi `BinaryMask`, çıktısı `THREE.BufferGeometry`.
 */

/** Desteklenen beş ortoğrafik görünüm; `types.ts` içindeki `ViewAngle` ile aynı. */
export const ALL_VIEW_ANGLES: readonly ViewAngle[] = ['front', 'right', 'back', 'left', 'top'];

/** Üst görünüm için özel ipucu değeri (açı 0°/90°... ile ifade edilemez). */
export const TOP_VIEW_HINT = -1;

/** Kısa kenarı bunun altında kalan fotoğraflar düşük çözünürlüklü sayılır. */
export const MIN_USEFUL_PX = 200;

/** Visual hull'u anlamlı kılan en az farklı açı sayısı. */
export const VISUAL_HULL_MIN_ANGLES = 3;

/** "Yeterli poligon" eşiği: bu sayıya kadar foto ekleme önerilir. */
export const GOOD_ENOUGH_PHOTOS = 3;

const ASPECT_MIN = 0.02;
const ASPECT_MAX = 50;
const RECT_ASPECT_SPAN = 1.0;
const RECT_THRESHOLD = 0.5;
const SYMMETRY_THRESHOLD = 0.55;
const SYMMETRY_REFERENCE_ASPECT = 0.85;
const SYMMETRY_LOG_SPAN = 0.9;
const EXTREME_ASPECT = 4;

export type EngineChoice = 'visualHull' | 'contourExtrude' | 'lathe';

/** Girdi sözleşmesi: zorunlu olan tek şey piksel boyutları. */
export interface ViewInput {
  /** 0/90/180/270 gibi kamera azimutu (derece); üst görünüm için `TOP_VIEW_HINT`. */
  angleHint?: number;
  width: number;
  height: number;
  /** Çağıran taraf silüet doluluk oranını (bbox içi ön plan / bbox alanı) biliyorsa 0..1. */
  silhouetteFill?: number;
  /** Kullanıcı/işaretleme "bu parçada iç delik var" diyorsa. */
  hasHoleHint?: boolean;
}

export interface ClassifiedView {
  index: number;
  angle: ViewAngle;
  angleSource: 'hint' | 'inferred';
  /** width / height, güvenli aralığa kırpılmış (0 = geçersiz boyut). */
  aspectRatio: number;
  /** 0..1: çözünürlük + makul en-boy oranı sezgisi. */
  quality: number;
  lowResolution: boolean;
  /** Tekrar eden bir açıysa, korunacak (en yüksek çözünürlüklü) fotoğrafın indeksi. */
  duplicateOfIndex: number | null;
}

export interface DuplicateGroup {
  angle: ViewAngle;
  indexes: number[];
  keepIndex: number;
  /** Aynı açıdaki adayların en-boy oranı sapması (0..1); düşükse örtüşme yüksek. */
  aspectSpread: number;
}

export interface ViewPlan {
  views: ClassifiedView[];
  /** Fotoğraflardan çıkan benzersiz açılar (ALL_VIEW_ANGLES sırasıyla). */
  presentAngles: ViewAngle[];
  missingAngles: ViewAngle[];
  duplicateGroups: DuplicateGroup[];
  uniqueAngleCount: number;
  /** uniqueAngleCount / 5 */
  coverage: number;
  /** Tekrar olmayan görünümlerin ortalama en-boy oranı (0 = hesaplanamadı). */
  averageAspect: number;
  /** Tekrar olmayan görünümlerin ortalama kalitesi 0..1. */
  averageQuality: number;
  /** 0..1: düşük çözünürlüklü foto oranı. */
  lowResolutionRatio: number;
  /** 0..1: dönel simetri sezgisi (lathe uygunluğu). */
  symmetryScore: number;
  /** 0..1: düz/dikdörtgen plaka sezgisi (contourExtrude uygunluğu). */
  rectangularityScore: number;
  /** 0..1: iç delik şüphesi (hull delikleri kaybeder, contour extrude korur). */
  holeSuspicion: number;
  warnings: string[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Sıfıra bölme korumalı bölme. */
function safeDiv(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

function ratioOf(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  const raw = safeDiv(w, h);
  if (raw <= 0) return 0;
  return clamp(raw, ASPECT_MIN, ASPECT_MAX);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Derece ipucunu en yakın 90° katına yuvarlayıp `ViewAngle`'a çevirir. */
function angleFromHint(hint: number): ViewAngle {
  if (hint === TOP_VIEW_HINT) return 'top';
  const normalized = ((hint % 360) + 360) % 360;
  const quadrant = Math.round(normalized / 90) % 4;
  const byQuadrant: ViewAngle[] = ['front', 'right', 'back', 'left'];
  return byQuadrant[quadrant];
}

function minDimOf(image: ViewInput): number {
  const w = Number.isFinite(image.width) && image.width > 0 ? image.width : 0;
  const h = Number.isFinite(image.height) && image.height > 0 ? image.height : 0;
  return Math.min(w, h);
}

/**
 * Fotoğrafları görünüm sırasına (ön/sağ/arka/sol/üst) yerleştirir.
 *
 * - `angleHint` varsa en yakın 90° katına eşlenir; `TOP_VIEW_HINT` üst görünümdür.
 * - İpucu yoksa en-boy oranı 1.7'nin üzerindeki geniş kareler üst görünüm sayılır,
 *   aksi halde henüz kullanılmamış ilk açı (ön → sağ → arka → sol) atanır.
 * - Aynı açıya düşen fotoğraflar "silüet örtüşmesi" grubu olarak işaretlenir; grupta
 *   en yüksek kısa kenara sahip olan tutulur, diğerleri `duplicateOfIndex` alır.
 */
export function classifyViews(images: readonly ViewInput[]): ViewPlan {
  const views: ClassifiedView[] = [];
  const used = new Set<ViewAngle>();
  const warnings: string[] = [];

  images.forEach((image, index) => {
    const aspectRatio = ratioOf(image.width, image.height);
    const hinted = Number.isFinite(image.angleHint) && image.angleHint !== undefined;

    let angle: ViewAngle;
    let angleSource: 'hint' | 'inferred';
    if (hinted) {
      angle = angleFromHint(image.angleHint as number);
      angleSource = 'hint';
    } else if (aspectRatio >= 1.7) {
      angle = 'top';
      angleSource = 'inferred';
    } else {
      angle = (['front', 'right', 'back', 'left'] as ViewAngle[]).find((a) => !used.has(a)) ?? 'front';
      angleSource = 'inferred';
    }
    used.add(angle);

    const minDim = minDimOf(image);
    const lowResolution = minDim > 0 && minDim < MIN_USEFUL_PX;
    const resolutionScore = clamp01(safeDiv(minDim, 800));
    const aspectScore = aspectRatio >= EXTREME_ASPECT ? 0.35 : 1;

    views.push({
      index,
      angle,
      angleSource,
      aspectRatio,
      quality: clamp01(resolutionScore * (0.7 + aspectScore * 0.3)),
      lowResolution,
      duplicateOfIndex: null,
    });
  });

  // Aynı açıya düşenleri grupla, en yüksek kısa kenarlı olanı koru.
  const duplicateGroups: DuplicateGroup[] = [];
  for (const angle of ALL_VIEW_ANGLES) {
    const members = views.filter((v) => v.angle === angle);
    if (members.length < 2) continue;
    const keep = members.reduce((best, cur) =>
      minDimOf(images[cur.index]) > minDimOf(images[best.index]) ? cur : best
    );
    const aspects = members.map((m) => m.aspectRatio);
    const spread = clamp01(safeDiv(Math.max(...aspects) - Math.min(...aspects), Math.max(...aspects)));
    for (const member of members) {
      if (member.index !== keep.index) member.duplicateOfIndex = keep.index;
    }
    duplicateGroups.push({
      angle,
      indexes: members.map((m) => m.index),
      keepIndex: keep.index,
      aspectSpread: spread,
    });
  }

  const kept = views.filter((v) => v.duplicateOfIndex === null);
  const presentAngles = ALL_VIEW_ANGLES.filter((angle) => kept.some((v) => v.angle === angle));
  const missingAngles = ALL_VIEW_ANGLES.filter((angle) => !presentAngles.includes(angle));
  const uniqueAngleCount = presentAngles.length;

  const averageAspect = mean(kept.map((v) => v.aspectRatio));
  const averageQuality = mean(kept.map((v) => v.quality));
  const lowResolutionRatio = clamp01(
    safeDiv(kept.filter((v) => v.lowResolution).length, kept.length)
  );

  const frontLike = kept.filter((v) => v.angle === 'front' || v.angle === 'back');
  const sideLike = kept.filter((v) => v.angle === 'right' || v.angle === 'left');
  let symmetryScore = 0;
  if (frontLike.length > 0 && sideLike.length > 0) {
    const aF = mean(frontLike.map((v) => v.aspectRatio));
    const aS = mean(sideLike.map((v) => v.aspectRatio));
    symmetryScore = clamp01(1 - safeDiv(Math.abs(aF - aS), Math.max(aF, aS)));
  } else if (averageAspect > 0) {
    // Tek görünüm: dikey/dengeli silüet dönel gövdeye, yatay plaka olanlar değil.
    const logOffset = Math.abs(Math.log(averageAspect / SYMMETRY_REFERENCE_ASPECT));
    symmetryScore = clamp01(1 - safeDiv(logOffset, SYMMETRY_LOG_SPAN));
  }

  const fills = kept
    .map((v) => images[v.index].silhouetteFill)
    .filter((f): f is number => typeof f === 'number' && Number.isFinite(f))
    .map(clamp01);
  const averageFill = fills.length > 0 ? mean(fills) : null;
  const holeSuspicion = clamp01(
    safeDiv(kept.filter((v) => images[v.index].hasHoleHint === true).length, kept.length)
  );

  let rectangularityScore = clamp01(safeDiv(averageAspect - 1.0, RECT_ASPECT_SPAN));
  if (averageFill !== null) {
    rectangularityScore = Math.max(rectangularityScore, clamp01(safeDiv(averageFill - 0.6, 0.35)));
  }
  if (holeSuspicion >= 0.5) {
    rectangularityScore = Math.max(rectangularityScore, 0.75);
  }

  if (images.length === 0) {
    warnings.push('Hiç fotoğraf yüklenmedi; en az bir silüet fotoğrafı gerekli.');
  }
  const lowResCount = kept.filter((v) => v.lowResolution).length;
  if (lowResCount > 0) {
    warnings.push(
      `${lowResCount} fotoğraf düşük çözünürlüklü (kısa kenar < ${MIN_USEFUL_PX}px); kenar detayı kaybolabilir.`
    );
  }
  if (uniqueAngleCount >= VISUAL_HULL_MIN_ANGLES && missingAngles.includes('top')) {
    warnings.push('Üst görünüm yok; üst yüzey ve delik çevresi kaba kalabilir.');
  }
  if (duplicateGroups.length > 0) {
    const total = duplicateGroups.reduce((sum, g) => sum + g.indexes.length - 1, 0);
    warnings.push(`${total} fotoğraf aynı açıyı tekrar ediyor; farklı açılar daha çok bilgi verir.`);
  }
  if (averageAspect >= EXTREME_ASPECT) {
    warnings.push(
      `Aşırı en-boy oranı (${averageAspect.toFixed(1)}:1); silüet ince bir şeride dönüşebilir.`
    );
  }

  return {
    views,
    presentAngles,
    missingAngles,
    duplicateGroups,
    uniqueAngleCount,
    coverage: clamp01(safeDiv(uniqueAngleCount, ALL_VIEW_ANGLES.length)),
    averageAspect,
    averageQuality,
    lowResolutionRatio,
    symmetryScore,
    rectangularityScore,
    holeSuspicion,
    warnings,
  };
}

/**
 * Plan için üretim motorunu seçer.
 * - >= 3 farklı açı: `visualHull` (silüet kesişimi gerçek hacim verir).
 * - 2 farklı açı: `visualHull` (iki yönlü kesişim hâlâ geçerli, kaba sonuç).
 * - Tek/tekilleşmiş görünüm: delik ya da dikdörtgen-plaka skoru yüksekse
 *   `contourExtrude`, dönel simetri skoru yüksekse `lathe`.
 */
export function selectEngine(plan: ViewPlan): EngineChoice {
  if (plan.uniqueAngleCount >= VISUAL_HULL_MIN_ANGLES) return 'visualHull';
  if (plan.uniqueAngleCount === 2) return 'visualHull';
  if (plan.holeSuspicion >= 0.5 || plan.rectangularityScore >= RECT_THRESHOLD) return 'contourExtrude';
  if (plan.symmetryScore >= SYMMETRY_THRESHOLD) return 'lathe';
  return 'contourExtrude';
}

/** Mevcut `types.ts` sözleşmesine köprü; UI'daki `OfflineMethod` seçimi için. */
export function engineToOfflineMethod(engine: EngineChoice): OfflineMethod {
  if (engine === 'visualHull') return 'visual-hull';
  if (engine === 'contourExtrude') return 'contour-extrude';
  return 'lathe-revolve';
}

/**
 * Kullanıcıya gösterilecek Türkçe kalite önerileri (boş dizi dönmez).
 */
export function buildQualityHints(plan: ViewPlan): string[] {
  const hints: string[] = [];

  if (plan.views.length === 0) {
    hints.push('Fotoğraf yüklenmedi: önce parçanın net bir silüet fotoğrafını ekleyin.');
    return hints;
  }

  if (plan.lowResolutionRatio > 0) {
    hints.push(
      `Düşük çözünürlüklü fotoğraf var; daha temiz poligon için kısa kenarı en az ${MIN_USEFUL_PX}px olan fotoğraf çekin.`
    );
  }

  if (plan.duplicateGroups.length > 0) {
    const groups = plan.duplicateGroups
      .map((g) => `${g.angle} (${g.indexes.length} foto)`)
      .join(', ');
    hints.push(`Aynı açı tekrar ediyor: ${groups}. Tekrar yerine farklı açı eklemek poligonu iyileştirir.`);
  }

  const missingCount = GOOD_ENOUGH_PHOTOS - plan.uniqueAngleCount;
  if (missingCount > 0) {
    hints.push(
      `Daha iyi poligon için ${missingCount} foto daha ekleyin (ön/sağ/arka sırası önerilir).`
    );
  }

  if (plan.uniqueAngleCount >= VISUAL_HULL_MIN_ANGLES && plan.missingAngles.includes('top')) {
    hints.push('Üst görünümü eklerseniz üst yüzey ile delik çevresi belirgin şekilde düzelir.');
  }

  if (plan.averageAspect >= EXTREME_ASPECT) {
    hints.push('Fotoğraf çok geniş bir karede; parçayı kadraja dikey/dengeli yerleştirip yeniden çekin.');
  }

  if (plan.averageQuality < 0.4) {
    hints.push('Genel fotoğraf kalitesi düşük; daha yakın ve net çekimler önerilir.');
  }

  if (hints.length === 0) {
    hints.push('Görünüm seti dengeli; mevcut fotoğraflarla yüksek kaliteli poligon üretilebilir.');
  }

  return hints;
}
