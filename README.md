# Photo2Print 3D Studio

Fotoğraftan **3D baskıya hazır model** üreten bir stüdyo uygulaması. Telefonla çekilen 1–5 açı fotoğrafı (veya Android ARCore nokta bulutu) yükleyin; uygulama arka plan maskesi, çoklu görünüm füzyonu, ağ onarımı ve baskı öncesi ölçekleme adımlarından geçirip **STL / 3MF / OBJ / GLB** olarak dışa aktarır. Tarayıcıda çalışan arayüz Three.js ile canlı önizleme verir; fotoğraf/bulut işlemleri için yerel bir Express API'si vardır.

## Gereksinimler

- Node.js 20 veya üzeri (proje `type: module`, ESM)
- npm 10+
- Android/iOS telefon (isteğe bağlı, QR eşleştirme ile fotoğraf çekimi için)

## Kurulum

```bash
npm install
```

## Çalıştırma

```bash
# Arayüz + API birlikte (otomatik port: 5173 ve 3001)
npm run dev
```

Ayrı ayrı çalıştırmak isterseniz:

```bash
# Yalnızca API (Express + tsx) — http://localhost:3001
npm run server

# Yalnızca arayüz (Vite) — http://localhost:5173
npx vite
```

`npm run dev` iki süreci `concurrently` ile başlatır; Vite `/api` ve `/uploads` isteklerini `http://localhost:3001` adresine yönlendirir (bkz. `vite.config.ts`).

### Portlar

| Servis | Port | Adres |
| --- | --- | --- |
| Arayüz (Vite) | 5173 | http://localhost:5173 |
| API (Express) | 3001 | http://localhost:3001 |
| Yüklenen dosyalar (statik) | 3001 | http://localhost:3001/uploads/... |

Yerel ağ IP'nizi ve mobil erişim adresini öğrenmek için: `GET http://localhost:3001/api/network-info`

### Test ve derleme

```bash
npm test          # vitest run — src/engine altındaki birim testleri
npm run build     # tsc --noEmit && vite build → dist/
```

> Derleme ile ilgili bilinen durum ve güncel hata kayıtları: [docs/DURUM.md](docs/DURUM.md).

## API uç noktaları

| Metot | Yol | Açıklama |
| --- | --- | --- |
| GET | `/api/network-info` | LAN IP, portlar ve mobil taban adres |
| POST | `/api/sessions` | Yeni tarama oturumu (6 haneli kod) oluşturur |
| GET | `/api/sessions/:id` | Oturum durumunu ve yüklenen fotoğrafları döndürür |
| POST | `/api/sessions/:id/photo` | Oturuma fotoğraf yükler (`multipart`, alan: `photo`) |
| POST | `/api/sessions/:id/pointcloud` | Oturuma `.ply` nokta bulutu yükler (alan: `file`) |
| POST | `/api/reconstruct/cloud` | Bulut AI sağlayıcılarıyla (HuggingFace / fal / Tripo / Meshy) yeniden yapılandırma |

## Klasör yapısı

```
photo2print-3d/
├─ index.html                 # Vite giriş HTML'i (tr, dark tema)
├─ vite.config.ts             # Vite + React + Tailwind eklentileri, /api proxy, port 5173
├─ tsconfig.json              # src + server + vite.config.ts, strict mod
├─ src/
│  ├─ main.tsx                # React kök render
│  ├─ App.tsx                 # Ana akış: yükleme, görünüm seçimi, dışa aktarma
│  ├─ index.css               # Tailwind girişi
│  ├─ components/
│  │  ├─ ThreeViewport.tsx    # Three.js sahne, malzeme/görünüm modları
│  │  ├─ MaskEditorModal.tsx  # Arka plan maskesi düzenleme
│  │  ├─ QrPairingModal.tsx   # Android QR eşleştirme
│  │  └─ MobileScannerView.tsx# Telefon tarayıcısından fotoğraf çekme akışı
│  └─ engine/                 # Tarayıcı içi geometri motoru
│     ├─ maskProcessor.ts     # Maske üretimi/temizleme
│     ├─ visualHull.ts        # Çoklu görünüm visual hull
│     ├─ marchingCubes.ts     # Marching Cubes (+ tablolar)
│     ├─ contourExtrude.ts    # Konturdan ekstrüzyon
│     ├─ latheRevolve.ts      # Döner simetri (lathe) modeli
│     ├─ meshRepair.ts        # Manifold onarım, delik kapatma
│     ├─ plyImporter.ts       # .ply nokta bulutu → ağ
│     ├─ exporters.ts         # STL / 3MF / OBJ / GLB çıktıları
│     ├─ types.ts             # Ortak tipler
│     └─ __tests__/engine.test.ts
├─ server/
│  └─ index.ts                # Express API, multer yükleme, oturum yönetimi (port 3001)
├─ android-scanner/           # ARCore Depth API ile .ply üreten yerel Android projesi
├─ uploads/                   # Çalışma zamanı verisi (git'e girmez)
└─ docs/
   └─ DURUM.md                # Ayrıntılı durum/denetim notları
```

## Android / mobil notlar

- Masaüstü uygulamasındaki **“Android ile Tara (QR)”** penceresi bir QR kod ve 6 haneli oturum kodu gösterir; telefon aynı Wi-Fi ağında olmalıdır.
- Telefon tarayıcısı fotoğrafları `<input type="file" capture="environment">` ile çeker; bu yol **HTTPS gerektirmez**, LAN üzerinden `http://<LAN-IP>:5173` yeterlidir. (Kamera akışına `getUserMedia` ile erişen WebXR/AR özellikleri ise güvenli bağlam ister; bu yüzden derinlik taraması için yerel uygulama kullanılır.)
- Gerçek derinlik/nokta bulutu için `android-scanner` klasöründeki Kotlin projesi Android Studio ile derlenir; ayrıntılar: [android-scanner/README.md](android-scanner/README.md).
- Telefon ile masaüstü arasında bağlantı kurulamıyorsa Windows güvenlik duvarında 5173 ve 3001 portlarına izin verin.

## Başlatıcı (GUI)

Kurulumu ve sunucuyu elle başlatmak yerine çift tıklanabilir bir başlatıcı vardır:

- **`Photo2Print-Baslat.cmd`** — `start-studio.ps1` GUI'sini açar (PowerShell, kurulum gerekmez).
- **`start-studio.ps1`** — WPF arayüzü: yuvarlatılmış özel başlık çubuğu (sürüklenebilir), koyu/açık **tema** düğmesi,
  Başlat / Durdur / Stüdyoyu Aç düğmeleri, 2 sn'de bir port durumu (5173 + 3001), Wi-Fi adresi göstergesi
  ve pencere kapanınca süreci kapatma.
- **`install-shortcut.ps1`** — Masaüstüne "Photo2Print 3D Studio" kısayolu oluşturur:

```powershell
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
```

## Yayınlama (GitHub)

Uzak depo: https://github.com/mtahiryilmazz/3BStudio (private, `main`)

```bash
git push -u origin main
```

`uploads/` ve `.zwork/` klasörleri ile `node_modules/`, `dist/` sürüm kontrolüne dahil edilmez (bkz. `.gitignore`).
