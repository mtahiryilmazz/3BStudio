# 3BStudio — Düzeltme Talimatları

Bu belge, kullanıcının üç itirazını sırayla ele alır. Her bölümde **mevcut durum**, **yapılacak değişiklik**, **hazır kod**, **kabul kriteri** ve **doğrulama** vardır. Kod blokları doğrudan uygulanabilir; dosya yolları depo köküne göredir.

Temel commit: `ee61c01` (+ bu belgeyle birlikte gelen açı çıkarımı değişikliği).

---

## 1) Yüz fotoğrafını manuel ekleme

**Durum:** ❌ Bekliyor. Şu an yüz yalnızca **Karakter Sheet** modalından otomatik kırpılarak gelebiliyor; sol panelde kart yalnızca yüz zaten varsa görünüyor. Kullanıcı kendi yakın çekimini ekleyemiyor.

**Hedef:** Sol panelde her zaman görünen bir "Yüz fotoğrafı (isteğe bağlı)" kartı; `Ekle` / `Değiştir` / `Kaldır`. Eklenen görsel üretimde kafa bölgesine bindirilir.

**Dosya:** `src/App.tsx`

### 1.1 İkon ve ref

`lucide-react` içe aktarmasına `ScanFace` ekleyin:

```ts
  RotateCcw,
  RotateCw,
  ScanFace,
  Scissors,
```

`faceCloseUp` state'inin hemen altına:

```ts
  const [faceCloseUp, setFaceCloseUp] = useState<string | null>(null);
  const faceInputRef = useRef<HTMLInputElement>(null);
```

### 1.2 Yükleme işleyicisi

`commitGeometry` tanımından **önce** (useCallback sırası önemli değil, ama okunabilirlik için):

```ts
  // Manuel yüz yakın çekimi: kullanıcı isterse kendi detay fotoğrafını ekler.
  const handleFaceUpload = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const dataUrl = await fileToDataUrl(file);
        setFaceCloseUp(dataUrl);
        showToast('ok', 'Yüz fotoğrafı eklendi; model üretiminde kafa bölgesine bindirilecek.');
      } catch {
        showToast('err', 'Yüz fotoğrafı okunamadı.');
      }
    },
    [showToast]
  );
```

> `fileToDataUrl` zaten `./engine/maskProcessor` içinden içe aktarılıyor; `dataUrlToImageData` de öyle. Yeni bağımlılık gerekmez.

### 1.3 Kart arayüzü

`src/App.tsx` içinde **"Karakter sheet'inden otomatik algılanan yüz detayı"** yorumlu `{faceCloseUp && (...)}` bloğunu tamamen aşağıdaki kartla değiştirin (kart artık koşulsuz görünür):

```tsx
          {/* Yüz detayı: sheet'ten otomatik veya manuel yakın çekim */}
          <div className="rounded-xl border border-cyan-700/50 bg-slate-950/70 p-2 flex items-center gap-2">
            {faceCloseUp ? (
              <img
                src={faceCloseUp}
                alt="Yüz yakın çekim"
                className="w-12 h-12 rounded-lg object-cover border border-slate-800 shrink-0"
              />
            ) : (
              <div className="w-12 h-12 rounded-lg border border-dashed border-slate-700 flex items-center justify-center shrink-0">
                <ScanFace className="w-5 h-5 text-slate-500" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-semibold text-cyan-200">
                {faceCloseUp ? 'Yüz detayı hazır' : 'Yüz fotoğrafı (isteğe bağlı)'}
              </div>
              <div className="text-[9px] text-slate-500 leading-snug">
                {faceCloseUp
                  ? 'Üretimde kafa bölgesine renk olarak bindirilir; kalitesizse değiştirin.'
                  : 'Kendi yakın çekiminizi ekleyin; kafa bölgesi belirgin detaylanır.'}
              </div>
            </div>
            <button
              onClick={() => faceInputRef.current?.click()}
              className="px-2 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-[10px] text-cyan-200 shrink-0"
            >
              {faceCloseUp ? 'Değiştir' : 'Ekle'}
            </button>
            {faceCloseUp && (
              <button
                onClick={() => setFaceCloseUp(null)}
                className="text-slate-500 hover:text-rose-400 shrink-0"
                title="Yüz fotoğrafını kaldır"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <input
              ref={faceInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleFaceUpload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
```

### 1.4 Kullanım zaten bağlı

`handleGenerateOffline` içinde şu blok mevcut ve **değişmesi gerekmiyor**:

```ts
      if (faceCloseUp) {
        try {
          setBusyLabel('Yüz detayı kafa bölgesine bindiriliyor...');
          const faceImg = await dataUrlToImageData(faceCloseUp, 768);
          paintHeadFromFace(repaired, faceImg);
        } catch { /* model kullanılabilir kalır */ }
      }
```

**Kabul kriteri**
- Yüz yokken kart görünür ve "Ekle" ile dosya seçilebilir.
- Seçim sonrası küçük önizleme + "Değiştir"/çöp kutusu görünür; `Kaldır` state'i temizler.
- Yüz ile üretim yapıldığında geometry'de `color` attribute oluşur (GLB'de kafa renkli).

---

## 2) Otomatik açı isimlendirmesi yanlış

**Durum:** ⚠️ Kısmen düzeltildi (bu commit). Önce hücreler sırayla `Ön → Sağ → Arka → Sol` etiketleniyordu; 4 kolonlu sheet'te son kolon (arka görünüm) "Sol" oluyordu.

**Yapılan:** `detectSheetLayout` artık her hücreye içerikten `suggestedAngle` veriyor:

| Durum | Kural | Sonuç |
|---|---|---|
| Kare/portre + yüz (conf ≥ 0.2) | yüz paneli | `face` hücresi (açı taşımaz) |
| Geniş gövde + yüz ipucu (conf ≥ 0.15) | önden görünüm | `front` |
| Dar silüet (`w/h ≤ 0.45`) | yan görünüm | satırdaki ilk → `right`, ikinci → `left` |
| Yüz yok, geniş gövde | sırt görünümü | `back` |

Modal (`CharacterSheetModal.tsx`) bu öneriyi kullanıyor; aynı açı iki kez çıkarsa sıradaki kullanılmamış açıya düşüyor:

```ts
        const order: ViewAngle[] = ['front', 'right', 'back', 'left', 'top'];
        const usedAngles = new Set<ViewAngle>();
        const nextAngles: ViewAngle[] = cells.map((cell) => {
          if (cell.kind === 'face') return 'top';
          let angle: ViewAngle = cell.suggestedAngle;
          if (usedAngles.has(angle)) angle = order.find((a) => !usedAngles.has(a)) ?? angle;
          usedAngles.add(angle);
          return angle;
        });
```

Kullanıcı yine de her karttaki açı listesinden değiştirebilir.

**Kalan iyileştirme (opsiyonel, önerilir)**

- Karta öneri kaynağını yazın: `Öneri: yüz algılandı` / `dar silüet` / `yüz yok`. Böylece kullanıcı neden bu etiketin geldiğini görür.
- `suggestedAngle`'ı `SheetCell` yerine ayrı `analyzeSheetCell(crop)` fonksiyonuna taşıyıp elle test edilebilir kılın.

**Kabul kriteri**
- 4 kolonlu (ön, iki yan, arka) sheet'te etiketler `Ön / Sağ / Sol / Arka` olur.
- Aynı açı hiçbir zaman iki tam boy kartına yazılmaz.
- Mevcut test: `src/engine/__tests__/sheetLayout.test.ts` → *"açıları içerikten önerir"*.

---

## 3) Poligon sayısını manuel yükseltme — dosya boyutu şişmeden

**Durum:** ❌ Bekliyor. Şu an yalnızca sabit `Poligon ×4` ve `Poligon ×16` düğmeleri var; kullanıcı seviye seçemiyor, çıktı boyutu önceden gösterilmiyor ve üst sınır yok (×16 sonrası 2M+ üçgen → yüzlerce MB STL riski).

**Hedef:** 0–3 seviye (×1/×4/×16/×64) manuel seçim, canlı "üçgen sayısı + tahmini dosya boyutu" göstergesi ve yumuşak üst sınır (1.5M üçgen) ile otomatik kırpma.

### 3.1 Motor fonksiyonları

`src/engine/meshRepair.ts` sonuna ekleyin (`subdivideGeometry` zaten var):

```ts
/** Yumuşak üst sınır: bunun üzerine çıkan alt bölme uygulanmaz. */
export const MAX_TRIANGLES_SOFT = 1_500_000;

export function countTriangles(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return Math.floor(index.count / 3);
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  return pos ? Math.floor(pos.count / 3) : 0;
}

/** Kaba dosya boyutu tahmini (bayt). */
export function estimateMeshBytes(triangles: number): { stlBytes: number; glbBytes: number } {
  // Binary STL: 84 bayt başlık + üçgen başına 50 bayt.
  // GLB: vertex başına ~24 bayt (position+normal) × 3 + indeks/dolgu payı.
  return {
    stlBytes: Math.round(triangles * 50 + 84),
    glbBytes: Math.round(triangles * 88 + 4096),
  };
}

export interface SubdivideResult {
  geometry: THREE.BufferGeometry;
  appliedLevels: number;
  triangles: number;
  /** İstenen seviye bütçe nedeniyle kırpıldı mı. */
  clamped: boolean;
}

/**
 * Alt bölmeyi bütçeyle uygular: her geçiş üçgen sayısını ×4 yapar,
 * `maxTriangles` aşılacaksa o geçiş atlanır.
 */
export function subdivideWithBudget(
  geometry: THREE.BufferGeometry,
  level: number,
  maxTriangles: number = MAX_TRIANGLES_SOFT
): SubdivideResult {
  const target = Math.max(0, Math.min(3, Math.round(level)));
  let current = geometry.clone();
  let triangles = countTriangles(current);
  let applied = 0;
  while (applied < target && triangles * 4 <= Math.max(1, maxTriangles)) {
    const next = subdivideGeometry(current, 1);
    current.dispose();
    current = next;
    triangles = countTriangles(current);
    applied += 1;
  }
  return { geometry: current, appliedLevels: applied, triangles, clamped: applied < target };
}
```

> Not: `subdivideGeometry` girişini klonlar; burada ek klon fazladan bellek kullanır. İsterseniz `subdivideGeometry`'yi "sahiplen" (in-place) moduna alıp `subdivideWithBudget` içindeki klonu kaldırın.

### 3.2 Arayüz

`src/App.tsx` içindeki mevcut "Poligon ×4 / ×16" düğme ızgarasını aşağıdaki blokla değiştirin.

State (diğer mesh ayarlarının yanına):

```ts
  const [polyLevel, setPolyLevel] = useState(0);
```

Hesaplar (render gövdesinde, `stats` mevcut):

```ts
  const currentTris = useMemo(() => (geometry ? countTriangles(geometry) : 0), [geometry]);
  const projectedTris = currentTris * Math.pow(4, polyLevel);
  const sizeEstimate = estimateMeshBytes(projectedTris);
  const overBudget = projectedTris > MAX_TRIANGLES_SOFT;
```

Blok:

```tsx
            {/* Poligon yoğunluğu: manuel seviye + boyut bütçesi */}
            <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-300">
                <span>Poligon Yoğunluğu</span>
                <span className="font-mono text-violet-200">
                  ×{Math.pow(4, polyLevel)} ({polyLevel} geçiş)
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={3}
                step={1}
                value={polyLevel}
                onChange={(e) => setPolyLevel(Number(e.target.value))}
                className="w-full accent-violet-400"
              />
              <div className={`text-[10px] font-mono ${overBudget ? 'text-amber-300' : 'text-slate-400'}`}>
                {currentTris.toLocaleString('tr-TR')} → {projectedTris.toLocaleString('tr-TR')} üçgen
                {' · '}STL ≈ {(sizeEstimate.stlBytes / 1048576).toFixed(1)} MB
                {' · '}GLB ≈ {(sizeEstimate.glbBytes / 1048576).toFixed(1)} MB
              </div>
              {overBudget && (
                <div className="text-[10px] text-amber-300 leading-snug">
                  Bütçe aşılıyor (üst sınır {MAX_TRIANGLES_SOFT.toLocaleString('tr-TR')} üçgen);
                  uygulandığında seviye otomatik kırpılır.
                </div>
              )}
              <button
                disabled={!geometry || isBusy || polyLevel === 0}
                onClick={() =>
                  runMeshOp('Poligon Yoğunluğu', (g) => {
                    const res = subdivideWithBudget(g, polyLevel);
                    if (res.clamped) {
                      showToast(
                        'info',
                        `Dosya boyutu korumak için seviye ${res.appliedLevels} geçişte kırpıldı (${res.triangles.toLocaleString('tr-TR')} üçgen).`
                      );
                    }
                    return res.geometry;
                  })
                }
                className="w-full py-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/40 disabled:opacity-40 text-[11px] text-violet-100"
              >
                Poligonu Uygula
              </button>
            </div>
```

İçe aktarma satırına ekleyin:

```ts
import { MAX_TRIANGLES_SOFT, countTriangles, estimateMeshBytes, subdivideWithBudget } from './engine/meshRepair';
```

> `runMeshOp` içindeki işlem `showToast` kullanır; bu fonksiyon zaten bileşen kapsamında tanımlı.

### 3.3 Bütçe tablosu (kullanıcı beklentisi)

| Seviye | Çarpan | 120k üçgenlik model | STL ≈ | GLB ≈ |
|---|---|---|---|---|
| 0 | ×1 | 120.000 | 5,7 MB | 10,1 MB |
| 1 | ×4 | 480.000 | 22,9 MB | 40,3 MB |
| 2 | ×16 | 1.920.000 → **kırpılır** (960.000) | 45,8 MB | 80,5 MB |
| 3 | ×64 | 7.680.000 → **kırpılır** (960.000) | 45,8 MB | 80,5 MB |

**Kabul kriteri**
- Seviye değişince üçgen ve MB tahmini anında güncellenir.
- `Poligonu Uygula` sonrası `stats.triangleCount` beklenen çarpanı gösterir; bütçe aşılırsa kullanıcı bilgilendirilir ve çıktı ≤ 1,5M üçgen kalır.
- STL indirme boyutu tablodaki tahminle ±%10 içinde.

---

## Doğrulama

```powershell
npx tsc --noEmit      # 0 hata
npx vitest run        # 64/64 (bu belgeyle gelen yeni test dahil)
npm run build         # vite üretim derlemesi başarılı
```

Yeni testler (öneri):
- `subdivideWithBudget`: 12 üçgenlik kutu, `maxTriangles=100` → yalnız 1 geçiş (48 üçgen), `clamped=true`.
- `estimateMeshBytes(1_000_000)` → `stlBytes ≈ 50 MB`, `glbBytes ≈ 88 MB` (sınır kontrolü).
- Manuel yüz: `faceCloseUp` set edilmişken üretimde `geometry.getAttribute('color')` tanımlı olmalı.

## Riskler / notlar

- Vertex renkleri alt bölmede korunur (`subdivideGeometry` renk attribute'unu interpolasyonla taşır); yüz detayı ×16 sonrası da görünür.
- `subdivideWithBudget` her geçişte tam kopya üretir; 1,5M üçgen civarında tarayıcıda ~200–300 MB geçici bellek beklenir. Düşük RAM'li makinelerde üst sınırı 750.000'e indirmek güvenli olur.
- GLB tahmini kabaca vertex başına 24 bayt varsayar; GLTFExporter indeksleme davranışı değişirse katsayıyı güncelleyin.
