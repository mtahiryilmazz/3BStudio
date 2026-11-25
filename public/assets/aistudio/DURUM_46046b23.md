# DURUM — Doğrulama ve Depo Hazırlığı Notları

Son güncelleme: 24.11.2026, 10:30 (yerel saat)
Kapsam: yalnızca yapılandırma/derleme doğrulaması, git deposunun hazırlanması ve çalışma zamanı kontrolü. `src/App.tsx` ve `src/engine/*.ts` dosyalarına **dokunulmadı** (başka bir ekip üyesi orada çalışıyor).

## 1. Derleme ve test sonuçları

| Komut | Sonuç | Not |
| --- | --- | --- |
| `npx tsc --noEmit` | ✅ geçti (exit 0) | Ayrıntı için aşağıdaki "zaman çizelgesi" bölümüne bakın |
| `npx vitest run` | ✅ geçti — 2 dosya, 20 test | `engine.test.ts` (8) + `autoDetect.test.ts` (12) |
| `npm run build` (`tsc --noEmit && vite build`) | ✅ geçti — `dist/` üretildi | 1665 modül, ~4 sn |

### Zaman çizelgesi (önemli)

- 10:24'teki ilk `npm run build` denemesinde derleme **kırıktı**: `src/App.tsx(280,9): error TS6133: 'autoAssignPhotos' is declared but its value is never read.` (`noUnusedLocals: true` nedeniyle hata).
- Bu hata kaynak kod kaynaklıydı (yapılandırma değil), bu yüzden kapsam gereği düzeltilmedi.
- 10:25:08'de `src/App.tsx` ekip üyesi tarafından güncellendi (55.875 → 58.640 bayt); `autoAssignPhotos` artık 716. ve 732. satırlarda kullanılıyor.
- 10:28 civarında aynı komutlar tekrar çalıştırıldı ve **hepsi geçti**. Aynı sırada `src/engine/__tests__/autoDetect.test.ts` de eklendi (test sayısı 8 → 20).

Sonuç: mevcut hâliyle `tsc`, `vitest` ve `vite build` üçü de yeşil. `tsconfig.json`, `vite.config.ts`, `package.json` ve `index.html` içinde **değişiklik gerekmedi**, hiçbiri düzenlenmedi.

### Açık (bloklamayan) uyarılar

1. `vite build` uyarısı: `dist/assets/index-*.js` 1.040 kB (> 500 kB). Kod bölme (`manualChunks` / dinamik import) önerilir; işlevsel hata değil, bilinçli olarak dokunulmadı.
2. `ort-wasm-simd-threaded.jsep.wasm` ~23,9 MB olarak `dist/` içine kopyalanıyor (`@imgly/background-removal` bağımlılığı). Depo boyutu/dağıtım açısından bilinmesi gereken bir ayrıntı.
3. Derleme sırasında `dist/` yeniden üretildi (komutun kendi çıktısı; elle silme/taşıma yapılmadı).

## 2. Çalışma zamanı doğrulaması

Arka planda `npx tsx server/index.ts` ve `npx vite --host` başlatıldı, ardından süreçler kapatıldı. Ölçülen yanıtlar:

| İstek | Durum | Yanıt |
| --- | --- | --- |
| `GET http://localhost:5173/` | 200 | `index.html` — başlık: "3BStudio 3D Studio — Fotoğraftan 3D Baskı Stüdyosu" |
| `GET http://localhost:5173/src/main.tsx` | 200 | Vite tarafından dönüştürülmüş modül (1.918 bayt) |
| `GET http://localhost:3001/api/network-info` | 200 | `{"lanIp":"192.168.50.99","frontendPort":5173,"apiPort":3001,"mobileBaseUrl":"http://192.168.50.99:5173"}` |
| `GET http://localhost:5173/api/network-info` (Vite proxy) | 200 | Aynı JSON — `/api` proxy'si çalışıyor |

Sunucu açılış logu: `3BStudio 3D API hazir: http://localhost:3001 (LAN: http://192.168.50.99:3001)`

Kapatma: 3001 ve 5173 dinleyen iki `node.exe` süreci (PID 13252 = tsx sunucusu, PID 16108 = vite) durduruldu; sonrasında portlar boş ve `http://localhost:3001` bağlantısı reddediliyor ("DOWN") olarak doğrulandı.

Doğrulama logları: `.zwork/verification/server.log`, `.zwork/verification/vite.log` (git dışında).

## 3. Depo hazırlığı

- `git init -b main` ile depo oluşturuldu (öncesinde klasör bir git deposu değildi).
- Not: çalışma sırasında `.git` klasörü başka bir süreç tarafından 10:25:51'de oluşturulmuş ve `HEAD` `refs/heads/master` olarak kalmıştı; sıfır baytlık bir `index.lock` (10:26:09, tutan süreç artık yok) `git add`'i bloke ediyordu. Kilit silindi, `HEAD` `refs/heads/main` yapıldı. Commit öncesi depoda hiç commit yoktu (`git rev-list --all --count` = 0).
- `.gitignore`: `node_modules/`, `dist/`, `uploads/`, `.zwork/`, `*.log` (+ `.env`, OS/IDE dosyaları).
- `README.md`: Türkçe; ne yaptığı, kurulum, çalıştırma (`npm install` / `npm run dev` / `npm run server` / `npm test`), portlar (5173 / 3001), klasör yapısı, API tablosu, Android tarayıcı notları, yayınlama komutları.
- İlk commit atıldı: `ab44af9` — "chore: depoyu baslat, .gitignore ve README ekle" (39 dosya, 12.919 satır). `git status` temiz. `user.name = mtahiryilmazz`, `user.email = thrylmz@live.cn` mevcut global ayardan kullanıldı; yerel override yapılmadı.
- **Uzak depo eklenmedi, push yapılmadı.** README'de yalnızca komut olarak gösterildi:
  `git remote add origin https://github.com/mtahiryilmazz/3BStudio.git`

## 4. Doğrulanmayan / kapsam dışı

- `android-scanner/` Kotlin projesi derlenmedi: bu makinede Android SDK/Gradle wrapper yok (klasörün kendi README'sine göre yalnızca Java 8 ve `adb` kurulu). APK üretimi Android Studio gerektiriyor.
- Tarayıcıda gerçek kullanıcı akışı (fotoğraf yükleme → maske → ağ üretimi → STL indirme) uçtan uca tıklanarak denenmedi; yalnızca HTTP yanıtları ve derleme doğrulandı.
- `POST /api/reconstruct/cloud` bulut AI sağlayıcılarına (HuggingFace/fal/Tripo/Meshy) dış istek attığı için çağrılmadı (API anahtarı/ağ bağımlılığı).
- Gerçek mobil cihazla QR eşleştirme ve LAN erişimi test edilmedi (telefon gerekiyor).
- `git push` / GitHub tarafı doğrulanmadı — kullanıcı onayı gerektiği için yapılmadı.

## 5. Otomatik çoklu-foto algılama (yükleme anında)

Kullanıcı akışı: "fotoğraf çekip atınca otomatik algılasın, çoklu fotoğrafla daha kaliteli poligon üretsin".

- **Yükleme anında analiz:** `src/App.tsx` içine `buildViewInputs()` yardımcısı ve `views` değişimini izleyen
  bir `useEffect` eklendi. Fotoğraf (veya Örnek Parça) yüklenir yüklenmez `classifyViews()` çalışıp
  **KALİTE İPUÇLARI** paneli dolduruluyor ve `selectEngine()` sonucu motor olarak seçiliyor; artık
  "3D Model Oluştur"a basmayı beklemiyor.
- **Tekrar eden fotoğraf filtresi:** Aynı açıdan birden fazla foto gelirse `ViewPlan.duplicateGroups`
  üzerinden en yüksek çözünürlüklü olan tutuluyor, diğerleri visual hull kesişimine sokulmuyor
  (düşük çözünürlüklü kopya kesişimi köreltiyordu). Kullanıcıya kaç fotoğrafın atlandığı bildiriliyor.
- **Üretim akışıyla tek kaynak:** `handleGenerateOffline()` de aynı `buildViewInputs()` + `classifyViews()`
  zincirini kullanıyor; iki yerde farklı plan hesaplanması riski kalktı.

Doğrulama (bu makinede):

| Kontrol | Sonuç |
| :--- | :--- |
| `npx tsc --noEmit` | 0 hata |
| `npx vitest run` | 20/20 (autoDetect 12 + engine 8) |
| `npm run build` | başarılı (1.047 kB ana paket, yalnızca boyut uyarısı) |
| Canlı (Chromium, `localhost:5199`) | Örnek Parça → Dekoratif Biblo: ipuçları **tıklamadan** geldi, motor "Çoklu Açı Silüet Kazıma" seçildi |
| Uçtan uca üretim | Su geçirmez %100, 45.48 cm³, 13.252 üçgen, PLA ~56.4 g — export düğmeleri açıldı |

- `start-studio.ps1` (Windows Forms başlatıcı: sunucu + Vite'ı başlatıp 5173'ü açar) depoya eklendi.
