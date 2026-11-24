import { describe, it, expect } from 'vitest';
import {
  ALL_VIEW_ANGLES,
  MIN_USEFUL_PX,
  TOP_VIEW_HINT,
  buildQualityHints,
  classifyViews,
  engineToOfflineMethod,
  selectEngine,
} from '../autoDetect';

describe('autoDetect.classifyViews', () => {
  it('3 farklı açıyı (ön/sağ/arka) sınıflandırır ve visualHull seçer', () => {
    const plan = classifyViews([
      { angleHint: 0, width: 800, height: 1000 },
      { angleHint: 90, width: 800, height: 1000 },
      { angleHint: 180, width: 800, height: 1000 },
    ]);

    expect(plan.presentAngles).toEqual(['front', 'right', 'back']);
    expect(plan.uniqueAngleCount).toBe(3);
    expect(plan.duplicateGroups).toHaveLength(0);
    expect(plan.views.map((v) => v.angleSource)).toEqual(['hint', 'hint', 'hint']);
    expect(selectEngine(plan)).toBe('visualHull');
    expect(engineToOfflineMethod(selectEngine(plan))).toBe('visual-hull');
    // Üst görünüm eksik: plan bunu bildirmeli ve öneri üretmeli.
    expect(plan.missingAngles).toContain('top');
    expect(buildQualityHints(plan).some((h) => h.includes('Üst görünüm'))).toBe(true);
  });

  it('tek fotoğrafta görünümü çıkarır, dönel simetri yüksekse lathe seçer', () => {
    const plan = classifyViews([{ angleHint: 0, width: 800, height: 1000 }]);

    expect(plan.views).toHaveLength(1);
    expect(plan.presentAngles).toEqual(['front']);
    expect(plan.missingAngles).toEqual(['right', 'back', 'left', 'top']);
    expect(plan.symmetryScore).toBeGreaterThan(0.8);
    expect(selectEngine(plan)).toBe('lathe');
    expect(engineToOfflineMethod('lathe')).toBe('lathe-revolve');
    // En fazla 2 foto daha önerisi: 3 - 1 = 2
    expect(buildQualityHints(plan).some((h) => h.includes('2 foto daha'))).toBe(true);
  });

  it('tekrarlı açıyı gruplar, en yüksek çözünürlüklü fotoğrafı korur', () => {
    const plan = classifyViews([
      { angleHint: 0, width: 800, height: 1000 },
      { angleHint: 0, width: 1200, height: 1500 },
      { angleHint: 0, width: 640, height: 800 },
    ]);

    expect(plan.presentAngles).toEqual(['front']);
    expect(plan.uniqueAngleCount).toBe(1);
    expect(plan.duplicateGroups).toHaveLength(1);
    const group = plan.duplicateGroups[0];
    expect(group.angle).toBe('front');
    expect(group.indexes).toEqual([0, 1, 2]);
    expect(group.keepIndex).toBe(1); // 1200x1500 en yüksek kısa kenar
    expect(plan.views[0].duplicateOfIndex).toBe(1);
    expect(plan.views[2].duplicateOfIndex).toBe(1);
    expect(plan.views[1].duplicateOfIndex).toBeNull();
    // Aynı açı tekrarı yalnızca tek benzersiz açı bırakır, motor tek görünüme düşer.
    expect(selectEngine(plan)).not.toBe('visualHull');
    expect(buildQualityHints(plan).some((h) => h.includes('Aynı açı'))).toBe(true);
  });

  it('çok düşük çözünürlüğü işaretler ve uyarı üretir', () => {
    const plan = classifyViews([{ angleHint: 0, width: 90, height: 120 }]);

    expect(plan.views[0].lowResolution).toBe(true);
    expect(plan.lowResolutionRatio).toBe(1);
    expect(plan.averageQuality).toBeLessThan(0.2);
    expect(plan.warnings.some((w) => w.includes('düşük çözünürlük'))).toBe(true);
    expect(buildQualityHints(plan).some((h) => h.includes(`${MIN_USEFUL_PX}px`))).toBe(true);
  });

  it('üst görünüm eksikken bunu eksik açı olarak raporlar', () => {
    const plan = classifyViews([
      { angleHint: 0, width: 900, height: 900 },
      { angleHint: 90, width: 900, height: 900 },
      { angleHint: 180, width: 900, height: 900 },
      { angleHint: 270, width: 900, height: 900 },
    ]);

    expect(plan.presentAngles).toEqual(['front', 'right', 'back', 'left']);
    expect(plan.missingAngles).toEqual(['top']);
    expect(plan.uniqueAngleCount).toBe(4);
    expect(plan.coverage).toBeCloseTo(0.8, 5);
    expect(selectEngine(plan)).toBe('visualHull');
    expect(plan.warnings.some((w) => w.includes('Üst görünüm'))).toBe(true);
  });

  it('aşırı geniş kareyi dikdörtgen plaka sayıp contourExtrude seçer', () => {
    const plan = classifyViews([{ angleHint: 0, width: 1600, height: 400 }]);

    expect(plan.averageAspect).toBeCloseTo(4, 5);
    expect(plan.rectangularityScore).toBeGreaterThan(0.9);
    expect(plan.symmetryScore).toBeLessThan(0.1);
    expect(selectEngine(plan)).toBe('contourExtrude');
    expect(engineToOfflineMethod('contourExtrude')).toBe('contour-extrude');
    expect(plan.warnings.some((w) => w.includes('en-boy oranı'))).toBe(true);
  });

  it('kare fotoğrafta dönel simetri skorunu yüksek bulur', () => {
    const plan = classifyViews([{ angleHint: TOP_VIEW_HINT, width: 1000, height: 1000 }]);

    expect(plan.views[0].angle).toBe('top');
    expect(plan.symmetryScore).toBeGreaterThan(0.7);
    expect(plan.rectangularityScore).toBeLessThan(0.1);
    expect(selectEngine(plan)).toBe('lathe');
  });

  it('dikdörtgen plakayı (1.5:1) contourExtrude ile eşler', () => {
    const plan = classifyViews([{ angleHint: 0, width: 1500, height: 1000 }]);

    expect(plan.averageAspect).toBeCloseTo(1.5, 5);
    expect(plan.rectangularityScore).toBeGreaterThanOrEqual(0.5);
    expect(selectEngine(plan)).toBe('contourExtrude');
  });

  it('iç delik ipucunda tek görünümde bile contourExtrude seçer', () => {
    const plan = classifyViews([
      { angleHint: 0, width: 1000, height: 1000, hasHoleHint: true },
    ]);

    expect(plan.holeSuspicion).toBe(1);
    expect(plan.rectangularityScore).toBeGreaterThanOrEqual(0.5);
    expect(selectEngine(plan)).toBe('contourExtrude');
  });

  it('sıfır/geçersiz boyutlarda NaN ve Infinity üretmez', () => {
    const plan = classifyViews([
      { width: 0, height: 0 },
      { width: 1200, height: 0 },
      { angleHint: 90, width: 600, height: 800 },
    ]);

    for (const view of plan.views) {
      expect(Number.isFinite(view.aspectRatio)).toBe(true);
      expect(Number.isFinite(view.quality)).toBe(true);
    }
    expect(Number.isFinite(plan.averageAspect)).toBe(true);
    expect(Number.isFinite(plan.symmetryScore)).toBe(true);
    expect(Number.isFinite(plan.rectangularityScore)).toBe(true);
    expect(Number.isFinite(plan.coverage)).toBe(true);
    expect(Number.isFinite(plan.lowResolutionRatio)).toBe(true);
    expect(plan.coverage).toBeLessThanOrEqual(1);
  });

  it('iki farklı açıda visualHull seçer ve ipucusuz fotoğrafları sırayla atar', () => {
    const plan = classifyViews([
      { width: 800, height: 1200 },
      { width: 820, height: 1200 },
    ]);

    expect(plan.views.map((v) => v.angle)).toEqual(['front', 'right']);
    expect(plan.views.every((v) => v.angleSource === 'inferred')).toBe(true);
    expect(plan.uniqueAngleCount).toBe(2);
    expect(selectEngine(plan)).toBe('visualHull');
  });

  it('boş girdide çökmez, uyarı ve öneri döner', () => {
    const plan = classifyViews([]);

    expect(plan.views).toHaveLength(0);
    expect(plan.uniqueAngleCount).toBe(0);
    expect(plan.coverage).toBe(0);
    expect(plan.missingAngles).toEqual([...ALL_VIEW_ANGLES]);
    expect(plan.warnings.length).toBeGreaterThan(0);
    const hints = buildQualityHints(plan);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('Fotoğraf yüklenmedi');
  });
});
