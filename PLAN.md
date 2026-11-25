# 3BStudio Nihai Mimari ve Geliştirme Planı

Bu belge, **3BStudio** projesinin nihai sürümünde bir araya getirilen **10 açık kaynak 3D ekosistemini** ve **Comfy-Org 3 aşamalı resmi ağırlık hattını** (`BiRefNet → MoGe → Pixal3D`) özetler.

---

## 1. İncelenen ve Sentezlenen Ekosistemler

| Ekosistem / Model Hattı | 3BStudio'ya Kazandırılan Yetenek |
|---|---|
| **Comfy-Org/BiRefNet** | Tarayıcı içi kenar sertleştirme ve 1px arka plan halesi temizliği (`hardenAlphaMask`) + ComfyUI akışında `birefnet.safetensors` düğümü. |
| **Comfy-Org/MoGe** | Metrik derinlik/normal kabartma ve kamera FoV kestirimi + ComfyUI akışında `moge_2_vitl_normal_fp16.safetensors` düğümü. |
| **Comfy-Org/Pixal3D & TencentARC/Pixal3D** | Piksel-hizalı çoklu açı geri izdüşümü, Ön Silüet-IoU (%) doğrulaması, ücretsiz HF Space havuzunda `TencentARC/Pixal3D` ve indirilebilir Tekli / Çoklu-Açı / INT8 ComfyUI JSON şablonları. |
| **stabilityai/stable-fast-3d (SF3D)** | Açılıp kapatılabilir **Albedo Delighting** (gölge & parlama arındırma), **Metallic / Roughness** PBR haritaları ve SF3D ComfyUI / HF Space entegrasyonu. |
| **Comfy-Org/ComfyUI** | 5 hazır GPU workflow JSON şablonu (`pixal3d-single`, `pixal3d-multiview`, `pixal3d-int8`, `sf3d`, `hunyuan3d`), VRAM gereksinimleri ve resmi Hugging Face ağırlık klasör eşleştirmesi. |
| **sh1ftmaker/local3d-plus** | Ortalama üçgen kalitesi (`computeTriangleQuality`), 2K Normal/AO UV korumalı anlık **Multi-LOD (`Tam · 20K · 5K`)** ve **Fotoğraf ↔ 3D Model Yan-Yana Kıyaslama**. |
| **Jaco2308/Local3D_Studio** | Geometrik **3D Baskı Doktoru** (`>45°` çıkıntı yüzdesi, 3D CoG statik denge kontrolü, 220×220×250 mm tabla uyumu), opsiyonel **Figür Sergi Kaidesi (Y=0)** ve **K-Means Çok Renkli `.3mf` (4–8 filament — Bambu AMS / Anycubic ACE Pro)**. |
| **crafter-station/local3d** | `<%0.5` yüzen gevşek parça temizliği (`pruneLooseFragments`), `run.json` üretim geçmişi manifesti ve `npm run cli -- doctor` sistem sağlık komutu. |
| **arashsajjadi/Local3D** | **Akıllı Konu Analizi** (Tam Boy Karakter / Büst-Portre / Mekanik Nesne tespiti) ve önbellekli geometri üzerinde anlık LOD / Delighting / Kaide geçişleri. |
| **3DF Zephyr + gavinyork/zephyr3d + polymolly.dev** | 3D sahnede 4 aşamalı fotogrametri görünümü (`1. Kamera · 2. Nokta Bulutu · 3. Mesh · 4. 2K PBR`), 6 maddelik **PolyMolly QA & Motor Uyumluluk Kapısı** ve indirilebilir 3DF Zephyr `.bat` / `.sh` otomasyon betikleri. |

---

## 2. Çift Tema ve Arayüz Tasarımı

- **Açık Tema (Varsayılan)**: `#F8FAFC` uygulama zemini, `#FFFFFF` düz kartlar, `#E2E8F0` ince kenarlıklar, `#0F172A` keskin karbon birincil düğmeler ve `#0D9488` teal vurgular.
- **Koyu Tema (Üst Çubukta Tek Tık Geçiş)**: `#090D16` zemin, `#0F172A` kartlar, `#1E293B` kenarlıklar ve `#14B8A6` teal vurgular (`localStorage` ile kalıcı).
- **3D Sahne Senkronizasyonu**: WebGL stüdyo arka planı ve 220×220 mm baskı tablası ızgarası seçili temaya göre anında güncellenir.
- **Sıfır Mor Gradyan**: Tüm mor/indigo/violet gradyanlar kaldırılmış, sade ve yüksek kontrastlı mühendislik arayüzü oluşturulmuştur.

---

## 3. Sunucu, Bulut AI ve CLI Mimarisi

- `GET /api/cloud/health` — Ücretsiz Hugging Face 3D Space havuzunun canlı durum taraması (`RUNNING / SLEEPING / PAUSED`).
- `POST /api/reconstruct/cloud/start`, `GET /api/reconstruct/cloud/status/:jobId`, `POST /api/reconstruct/cloud/cancel/:jobId` — Zaman aşımı ve HTML hatası üretmeyen asenkron Bulut 3D kuyruğu.
- `GET /api/comfy/workflows` ve `GET /api/comfy/workflow/:preset` — Resmi Comfy-Org JSON iş akışları.
- `POST /api/ai/analyze-character` — İsteğe bağlı sunucu tarafı karakter derinlik/oran kalibrasyonu.
- `POST /api/cli/convert` — HTTP üzerinden çoklu fotoğraf yükleyip doğrudan GLB/3MF/STL + `run.json` üretimi.
- `npm run cli -- doctor` & `npm run cli -- --input ./photos --out ./output/model --lod --ams-colors 4` — Terminalden tam otomatik 3D üretim ve sağlık denetimi.
- `GET /api/models/catalog`, `POST /api/models/download`, `GET /api/models/download/:jobId`, `POST /api/models/download/:jobId/cancel` — Resmi Hugging Face model ağırlıklarını (`Pixal3D INT8/BF16`, `Hunyuan3D-2mv`, `SF3D`, `MoGe`, `BiRefNet`) diske canlı ilerleme çubuğu, hız (MB/sn) ve iptal desteğiyle otomatik indirici.
- `GET /api/comfy/ping`, `POST /api/comfy/run`, `GET /api/comfy/status/:promptId`, `GET /api/comfy/setup-script` — Yerel ComfyUI GPU sunucusu (`127.0.0.1:8188`) canlı köprüsü ve tek tıkla Windows `.ps1` / Linux `.sh` kurulum betikleri.

---

## 4. Hızlı/Keskin Yerel Motor, Mesh Atölye Sentezi ve Kafa Büstü / Yüz Maskesi Modları

- **2–4 Saniyede Yüksek Poligonlu (55K–90K △) Keskin Yerel Üretim**: Varsayılan yerel üretimde 0 ağ çağrısı (Bulut AI oran analizi isteğe bağlı opt-in), tek geçişli BFS 2K PBR kenar taşması, sayısal anahtarlı gevşek parça temizliği ve sıkı anizotropik voxel ızgarası (`156³–164³`).
- **Ayak–Yüz `+Z` Yön Kilidi ve Şişme Balon Önleme**: Yan profil ayak parmağı/burun yönünü otomatik tespit eden `detectSideProfileFacing` + manuel `Yan Profil Yönü (Otomatik · Sağa · Sola)` seçici + tek tıkla `Ön / Arka Yönü Çevir` + süper-elips keskin derinlik profilleri (`Doğal Keskin · İnce · Derin Kabartma`) + Sobel mikro kabartma ve silüet koruyucu yumuşatma.
- **Mesh Atölye (`akararasul37/mesh-atolye`) Sentezi**: `Kaynak Ayrıntıları (Replace)` vs `Ham Temel (Önceki Kaplamayı Gör)` anlık doku kıyaslaması, çoklu görünüm Silüet-IoU (`Ön · Arka · Sağ · Sol` — `0.8*ort + 0.2*min`), `Hunyuan3D-2mv + Paint 2.1` ComfyUI şablonu ve **`OBJ + MTL + 2K PBR PNG Dokular (.ZIP)`** dışa aktarımı.
- **Kafa Büstü (`reconstructHeadBust`)**: Tam boy veya portre fotoğraftan kafa+boyun+omuz bölgesini otomatik kırpar, anatomik yüz kabartması (burun/kaş/elmacık/dudak/çene + fotoğraf parlaklık rölyefi) ve isteğe bağlı iki kademeli müze/heykel kaidesiyle (`Y=0`) yüksek poligonlu büst üretir.
- **Yüz Maskesi (`reconstructFaceMask`)**: İki mod — (1) **Giyilebilir İçi Oyuk Kabuk** (0 açık kenarlı su geçirmez çift cidar, ayarlanabilir et kalınlığı 2.5–5 mm, yetişkin 165 mm / çocuk 135 mm yüz genişliği, opsiyonel göz açıklıkları ve yan lastik/kayış kulakçıkları), (2) **Düz Arkalı Duvar Rölyefi**.

