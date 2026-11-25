# Otomatik Çoklu-Foto Pipeline — Entegrasyon Notu

`src/engine/autoDetect.ts` saf TypeScript'tir; DOM/three.js import etmez, `App.tsx`'ten bağımsızdır.
Testler: `npx vitest run src/engine/__tests__/autoDetect.test.ts` (12 vaka).

1. Her yüklenen dosyadan `img.width` / `img.height` al (ör. `loadImage(dataUrl)`), dilersen `hasHoleHint` ekle.
2. `const plan = classifyViews(items)` → `plan.presentAngles` açı atamalarını, `plan.missingAngles` eksikleri verir.
3. `const engine = selectEngine(plan)` → `'visualHull' | 'contourExtrude' | 'lathe'`; UI etiketi için `engineToOfflineMethod(engine)`.
4. Maske üretimi mevcut akışta kalır: `removeBackgroundAI` → `normalizeAndCropMask` → `BinaryMask`.
5. `engine === 'visualHull'` ise maskeleri `reconstructVisualHull({front,right,back,left,top}, {resolution:64})`'a ver.
6. `'contourExtrude'` ise plan'daki tek maskeyi `reconstructContourExtrude(mask, {widthMm, thicknessMm})` ile üret.
7. `'lathe'` ise yan görünüm maskesini `reconstructLathe(mask, {heightMm})` ile üret.
8. Tekrar eden fotoğraflar `plan.duplicateGroups[].keepIndex` ile atılır; atılanlar `duplicateOfIndex` taşır.
9. `buildQualityHints(plan)` çıktısını yükleme panelinde uyarı listesi olarak göster (boş dizi dönmez).
10. `plan.warnings` teknik uyarılar içindir; kullanıcı metni için `buildQualityHints` tercih edilir.
11. Tüm skorlar 0..1 aralığında ve sıfıra bölme korumalıdır; geçersiz boyut NaN üretmez.
12. `selectEngine` 2 farklı açıda da `visualHull` döner: iki yönlü kesişim geçerlidir, sonuç kabadır.
13. Eşikler: `MIN_USEFUL_PX=200`, `VISUAL_HULL_MIN_ANGLES=3`, `GOOD_ENOUGH_PHOTOS=3`; değiştirmek gerekirse bu sabitleri kullan.
14. Motor seçimini kullanıcıya override ettirmek istersen `selectEngine` sonucunu başlangıç değeri yap, planı yeniden hesaplama.
15. Bu modül kök dosyalara (App.tsx, package.json, server/) dokunmaz; bağlama işi ayrı ekibin sorumluluğundadır.
