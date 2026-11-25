# 3BStudio

**3BStudio**, tek veya çoklu açı fotoğraflarından, karakter sheet'lerinden ya da metin tariflerinden doğrudan tarayıcıda **2K PBR dokulu, su geçirmez (manifold) 3D modeller** üreten; **3D Baskı Doktoru**, **Bambu AMS / Anycubic ACE Pro çok renkli `.3mf`**, **ComfyUI resmi GPU iş akışları**, **ücretsiz Hugging Face Bulut 3D kuyruğu** ve **Node.js CLI** desteği sunan açık/koyu çift temalı 3D stüdyodur.

---

## Öne Çıkan Özellikler

### 1. Yerel 2K PBR Fotogrametri Motoru (GPU Gerektirmez)
- **BiRefNet-Stili Maske Sertleştirme**: Kenarlardaki yarı saydam pikselleri sertleştirir ve 1px arka plan renk halesini temizler (`hardenAlphaMask`).
- **Organik 2D EDT Hacim & 360° Renk Projeksiyonu**: 1–9 açıdan (Ön, Sağ, Arka, Sol, Üst + 3/4 çapraz açılar) organik şişirme, eksik/bantlı kafa tamamlama ve yakın yüz portresi bindirme.
- **SF3D Albedo Delighting & 2K PBR Atlas**: Gölge/parlama arındırma (`Delighting`), Sobel Tangent-Space Normal, Roughness, Metallic ve Ambient Occlusion haritaları.
- **Gevşek Parça Temizliği & Manifold Onarım**: `<%0.5` yüzen üçgen adacıklarını temizler, delikleri kapatır ve modeli `Y=0` baskı tablasına oturtur.
- **Anlık Multi-LOD (`Tam · 20K · 5K`) & Fotoğraf ↔ 3D Kıyaslama**: 2K Normal/AO UV haritalarını koruyarak oyun/web/mobil LOD seviyeleri arasında anında geçiş yapar.

### 2. 3D Baskı Doktoru, PolyMolly QA & Çok Renkli `.3mf`
- **PolyMolly 6-Kontrollü QA Kapısı**: Y=0 pivot, 1:1 gerçek ölçek, su geçirmezlik, temiz normaller, 2K UV/PBR ve motor poligon bütçesi doğrulaması (Blender, Unity, Godot, Unreal, 3D Baskı).
- **3D Baskı Doktoru**: `>45°` sarkan yüzey yüzdesi, 3D Ağırlık Merkezi (CoG) statik denge kontrolü, 220×220×250 mm tabla uyumu, ortalama üçgen kalitesi ve Ön Silüet-IoU (%).
- **Figür Sergi Kaidesi**: İnce ayaklı figürler için tek tıkla `Y=0` tabanlı pahlı dairesel sergi kaidesi ekler.
- **Bambu AMS / Anycubic ACE Pro `.3mf`**: K-Means renk kuantizasyonu (4–8 filament slotu) ve 3MF `<basematerials>` tanımlarıyla doğrudan çok renkli dilimleyici çıktısı.

### 3. Ücretsiz Hugging Face Bulut 3D Kuyruğu
- `TencentARC/Pixal3D`, `stabilityai/stable-fast-3d`, `tencent/Hunyuan3D-2mv`, `tencent/Hunyuan3D-2`, `microsoft/TRELLIS` ve `VAST-AI/TripoSG` dahil **9 ücretsiz Space** havuzu.
- Canlı durum taraması (`GET /api/cloud/health`), 1024 px yükleme optimizasyonu, 1.5 saniyelik güvenli JSON kuyruk takibi ve anında **İptal Et** desteği.

### 4. ComfyUI Yerel GPU İş Akışları (`BiRefNet → MoGe → Pixal3D`)
- Resmi `Comfy-Org/BiRefNet`, `Comfy-Org/MoGe`, `Comfy-Org/Pixal3D` (`Single BF16`, `MultiView BF16`, `INT8 ConvRot`), `stabilityai/stable-fast-3d` ve `tencent/Hunyuan3D-2` ağırlık yollarına uyumlu 5 hazır `.json` şablonu.

### 5. Parametrik Text-to-CAD, Rig & Animasyon ve Android QR
- Metinden canlı parametre sürgülü mekanik CAD modelleri + `build123d` (`.py`) ihracı.
- Otomatik 17 kemikli Biped Rig + animasyonlu `.glb` ihracı.
- QR kod ile Android telefondan çoklu fotoğraf ve `.PLY` nokta bulutu aktarımı.

---

## Kurulum ve Çalıştırma (Yerel Masaüstü WPF GUI & Web Portalı)

### Windows · 3BStudio PowerShell Başlatıcısı
`3BStudio-Baslat.cmd` dosyasına çift tıklayarak koyu teal yerel başlatıcıyı açın. Başlatıcı internet istemez; sunucuyu başlatır, canlı günlüğü gösterir ve hazır olunca Web Portalı düğmesini etkinleştirir. `Photo2Print-Baslat.cmd` eski masaüstü kısayolları için uyumluluk dosyası olarak korunur.

### Windows · Tek Tıkla WPF Masaüstü GUI Başlatıcı (Önerilen)
Repoyu çektikten sonra kök dizindeki **`Start-3BStudio.bat`** dosyasına çift tıklamanız yeterlidir:
1. Gerekirse `node_modules` bağımlılıklarını otomatik kurar.
2. Yerel `3BStudio` sunucusunu (`http://localhost:3000`) arka planda başlatır ve pencere kapatıldığında temiz şekilde sonlandırır.
3. **WPF Masaüstü Başlatıcı** (`desktop/3BStudio.Launcher`) içinden tek tıkla:
   - **Masaüstü GUI (WebView2)** — 3BStudio'yu doğrudan Windows masaüstü penceresinde GPU WebGL hızlandırmasıyla açar.
   - **Web Portalı (Tarayıcı)** — `http://localhost:3000` adresini tarayıcıda açar ve Android QR eşleştirme için yerel ağ URL'sini kopyalar.

> **Not:** WPF arayüzü için Windows üzerinde [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) (`winget install Microsoft.DotNet.SDK.8`) ve Microsoft Edge WebView2 (Windows 10/11'de yerleşik) gerekir. Kalıcı `.exe` derlemek için: `.\Start-3BStudio.ps1 -BuildRelease`

### Manuel Terminal / Web Portalı (Windows · macOS · Linux)

```bash
npm install
npm run dev
```

Uygulama varsayılan olarak `http://localhost:3000` adresinde başlar. İsteğe bağlı sunucu ortam değişkenleri için `.env.example` dosyasını `.env` olarak kopyalayabilirsiniz (`GEMINI_API_KEY` yalnızca sunucu tarafında isteğe bağlı oran kalibrasyonu ve Text-to-CAD için kullanılır; yerel 2K PBR motoru anahtar olmadan tamamen çevrimdışı çalışır).

---

## CLI Kullanımı (`convert` & `doctor`)

```bash
# Sistem sağlık kontrolü (Node, bağımlılıklar, bellek, disk)
npm run cli -- doctor

# Klasör veya karakter sheet'ten GLB + 3MF + LOD + 4 Renkli AMS .3mf + run.json üretimi
npm run cli -- --input ./photos --out ./output/karakter --profile studio-ultra --lod --ams-colors 4 --pedestal --formats glb,3mf,stl

# Resmi ComfyUI Pixal3D workflow JSON üretimi
npm run cli -- --comfy-workflow pixal3d-single --out ./output/comfy_pixal3d
```

---

## Test ve Üretim Derlemesi

```bash
# Birim testleri (Vitest)
npx vitest run

# TypeScript + ESLint + Vite üretim derlemesi
npm run lint
npm run build
```

Detaylı mimari kararlar ve sentezlenen ekosistem haritası için [`PLAN.md`](./PLAN.md) dosyasına bakabilirsiniz.
