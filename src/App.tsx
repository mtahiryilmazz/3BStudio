import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  Box,
  Camera,
  CheckCircle2,
  Cloud,
  Cpu,
  Download,
  FolderOpen,
  Layers,
  Lock,
  Play,
  Printer,
  QrCode,
  RotateCcw,
  RotateCw,
  Scissors,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  Unlock,
  Upload,
  Wand2,
  Wrench,
  Zap,
} from 'lucide-react';
import {
  BinaryMask,
  CloudProvider,
  MeshStats,
  OfflineMethod,
  PhotoViewItem,
  ViewAngle,
  ViewportDisplayMode,
} from './engine/types';
import {
  dataUrlToImageData,
  fileToDataUrl,
  generateDemoPartViews,
  normalizeAndCropMask,
  removeBackgroundAI,
  removeBackgroundFast,
} from './engine/maskProcessor';
import { reconstructVisualHull } from './engine/visualHull';
import { reconstructContourExtrude } from './engine/contourExtrude';
import { reconstructLathe } from './engine/latheRevolve';
import { classifyViews, selectEngine, buildQualityHints, engineToOfflineMethod } from './engine/autoDetect';
import {
  analyzeMesh,
  flatCutBottom,
  placeOnBuildPlate,
  repairMesh,
  rotateMesh90,
  scaleToDimension,
  subdivideGeometry,
  simplifyMesh,
  taubinSmooth,
  voxelRemesh,
} from './engine/meshRepair';
import { build3MF, buildOBJ, buildSTLBinary, exportAnimatedGLB, exportGLB, triggerDownload } from './engine/exporters';
import { buildBipedRig, disposeRig, type RigResult } from './engine/rigging';
import { buildAllClips, RIG_CLIP_LABELS, type RigClipName } from './engine/animClips';
import { parsePLY } from './engine/plyImporter';
import { ThreeViewport } from './components/ThreeViewport';
import { MaskEditorModal } from './components/MaskEditorModal';
import { QrPairingModal } from './components/QrPairingModal';
import { MobileScannerView } from './components/MobileScannerView';
import { CharacterSheetModal, type CharacterSheetApplyItem } from './components/CharacterSheetModal';
import { PhotoBoothModal, type PhotoBoothResult } from './components/PhotoBoothModal';
import { paintHeadFromFace } from './engine/faceDetect';

const INITIAL_VIEWS: PhotoViewItem[] = [
  { angle: 'front', label: 'Ön (0°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'right', label: 'Sağ (90°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'back', label: 'Arka (180°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'left', label: 'Sol (270°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'top', label: 'Üstten', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
];

function extractMergedGeometry(object3d: THREE.Object3D): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  object3d.updateMatrixWorld(true);
  object3d.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      const nonIndexed = g.index ? g.toNonIndexed() : g;
      // Keep only position attribute so mergeGeometries never fails on mismatched uv/color attributes
      const clean = new THREE.BufferGeometry();
      clean.setAttribute('position', nonIndexed.getAttribute('position').clone());
      parts.push(clean);
      if (nonIndexed !== g) nonIndexed.dispose();
      g.dispose();
    }
  });
  if (parts.length === 0) {
    throw new Error('İçe aktarılan 3D model içinde mesh bulunamadı.');
  }
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  parts.forEach((p) => {
    if (p !== merged) p.dispose();
  });
  if (!merged) throw new Error('Mesh parçaları birleştirilemedi.');
  return placeOnBuildPlate(merged);
}

/** Manuel açı atamasını autoDetect ipucuna çevirir (top = TOP_VIEW_HINT). */
const ANGLE_HINT_DEG: Record<ViewAngle, number> = { front: 0, right: 90, back: 180, left: 270, top: -1 };

const getImageSize = (dataUrl: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Görsel boyutları okunamadı.'));
    img.src = dataUrl;
  });

/**
 * Yüklü fotoğraflardan autoDetect girdisi üretir: piksel boyutu + açı ipucu.
 * `loaded` ile `sized` aynı sıradadır; bu yüzden `ViewPlan.views[i].index`
 * doğrudan `loaded[i]` fotoğrafını gösterir.
 */
const buildViewInputs = async (items: PhotoViewItem[]) => {
  const loaded = items.filter((v) => Boolean(v.originalDataUrl) || Boolean(v.cleanedDataUrl));
  const sized = await Promise.all(
    loaded.map(async (v) => {
      const { width, height } = await getImageSize(v.cleanedDataUrl || v.originalDataUrl);
      return { angleHint: ANGLE_HINT_DEG[v.angle], width, height };
    })
  );
  return { loaded, sized };
};

export default function App() {
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const mobileSession = searchParams.get('mode') === 'mobile' ? searchParams.get('session') : null;

  if (mobileSession) {
    return <MobileScannerView sessionId={mobileSession} />;
  }

  return <DesktopStudio />;
}

function DesktopStudio() {
  const [views, setViews] = useState<PhotoViewItem[]>(INITIAL_VIEWS);
  const [editingAngle, setEditingAngle] = useState<ViewAngle | null>(null);
  const [bgMode, setBgMode] = useState<'fast' | 'ai'>('fast');

  // Engine mode
  const [engineTab, setEngineTab] = useState<'offline' | 'cloud'>('offline');
  const [offlineMethod, setOfflineMethod] = useState<OfflineMethod>('visual-hull');
  const [autoEngine, setAutoEngine] = useState(true);
  const [qualityHints, setQualityHints] = useState<string[]>([]);
  const [rig, setRig] = useState<{ result: RigResult; clips: Record<RigClipName, THREE.AnimationClip> } | null>(null);
  const [activeClip, setActiveClip] = useState<RigClipName>('idle');
  const [wireframeRig, setWireframeRig] = useState(false);

  // Fotoğraf eklendiği/yüklendiği an otomatik algılama: eksik açı ve düşük çözünürlük
  // ipuçları ile birlikte önerilen motoru seçer. "3D Model Oluştur"a basmayı beklemez.
  useEffect(() => {
    let cancelled = false;
    if (!views.some((v) => Boolean(v.originalDataUrl) || Boolean(v.cleanedDataUrl))) {
      setQualityHints([]);
      return;
    }
    void (async () => {
      try {
        const { sized } = await buildViewInputs(views);
        if (cancelled || sized.length === 0) return;
        const plan = classifyViews(sized);
        setQualityHints(buildQualityHints(plan));
        if (autoEngine) setOfflineMethod(engineToOfflineMethod(selectEngine(plan)));
      } catch {
        // Boyut okunamazsa sessiz kal; üretim akışı kendi planını yeniden kurar.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [views, autoEngine]);
  const [hullResolution, setHullResolution] = useState(64);
  const [hullSmooth, setHullSmooth] = useState(2);
  const [targetSizeMm, setTargetSizeMm] = useState(60);
  const [extrudeWidthMm, setExtrudeWidthMm] = useState(60);
  const [extrudeThicknessMm, setExtrudeThicknessMm] = useState(8);
  const [extrudeBevelMm, setExtrudeBevelMm] = useState(0.5);
  const [latheHeightMm, setLatheHeightMm] = useState(45);
  const [latheHollowMm, setLatheHollowMm] = useState(0);

  // Cloud AI state
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>('huggingface');
  const [cloudKey, setCloudKey] = useState(() => localStorage.getItem('p2p_cloud_key') ?? '');
  const [hfSpaceId, setHfSpaceId] = useState('tencent/Hunyuan3D-2mv');
  const [saveKeyLocal, setSaveKeyLocal] = useState(true);

  // Geometry & Undo history
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [undoStack, setUndoStack] = useState<THREE.BufferGeometry[]>([]);
  const [displayMode, setDisplayMode] = useState<ViewportDisplayMode>('solid');
  const [showBedGrid, setShowBedGrid] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);

  // Calibration & Repair controls
  const [lockRatio, setLockRatio] = useState(true);
  const [dimX, setDimX] = useState('');
  const [dimY, setDimY] = useState('');
  const [dimZ, setDimZ] = useState('');
  const [simplifyPct, setSimplifyPct] = useState(50);
  const [cutBottomMm, setCutBottomMm] = useState(2);

  // Status & QR pairing
  const [isBusy, setIsBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [toast, setToast] = useState<{ type: 'info' | 'ok' | 'err'; text: string } | null>(null);
  const [demoMenuOpen, setDemoMenuOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [boothOpen, setBoothOpen] = useState(false);
  /** Karakter sheet'inden otomatik kırpılan yüz yakın çekimi (tam çözünürlük). */
  const [faceCloseUp, setFaceCloseUp] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [syncedFromPhone, setSyncedFromPhone] = useState<Record<string, string>>({});
  const [hasSyncedPly, setHasSyncedPly] = useState(false);

  const import3dInputRef = useRef<HTMLInputElement>(null);

  const stats: MeshStats | null = useMemo(() => {
    if (!geometry) return null;
    return analyzeMesh(geometry);
  }, [geometry]);

  useEffect(() => {
    if (stats) {
      setDimX(String(stats.widthMm));
      setDimY(String(stats.depthMm));
      setDimZ(String(stats.heightMm));
    }
  }, [stats]);

  const showToast = useCallback((type: 'info' | 'ok' | 'err', text: string) => {
    setToast({ type, text });
  }, []);

  // Karakter sheet dilimlerini ilgili açı slotlarına yazar; temizlenmiş veri ve maske geçersizleşir.
  const handleSheetApply = useCallback((items: CharacterSheetApplyItem[], faceDataUrl: string | null) => {
    if (items.length === 0) return;
    setViews((prev) => {
      const next = prev.map((v) => ({ ...v }));
      for (const item of items) {
        const target = next.find((v) => v.angle === item.angle);
        if (!target) continue;
        target.originalDataUrl = item.dataUrl;
        target.cleanedDataUrl = null;
        target.mask = null;
      }
      return next;
    });
    if (faceDataUrl) {
      setFaceCloseUp(faceDataUrl);
      showToast('ok', `Karakter sheet'ten ${items.length} görünüm ve yüz yakın çekimi yüklendi.`);
    } else {
      showToast('ok', `Karakter sheet'ten ${items.length} görünüm yüklendi.`);
    }
  }, [showToast]);

  const commitGeometry = useCallback((nextGeo: THREE.BufferGeometry, pushHistory = true) => {
    setGeometry((prev) => {
      if (prev && pushHistory) {
        setUndoStack((s) => [...s.slice(-9), prev]);
      } else if (prev && !pushHistory) {
        prev.dispose();
      }
      return nextGeo;
    });
    // Yeni geometri gelince eski rig geçersizdir: temizle.
    setRig((prev) => {
      if (prev) disposeRig(prev.result);
      return null;
    });
  }, []);

  // Fotogrametri kabini çıktısını doğrudan baskı/önizleme hattına alır.
  const handleBoothGenerated = useCallback(
    (result: PhotoBoothResult) => {
      commitGeometry(result.geometry);
      setDisplayMode('solid');
      const vertexCount = result.geometry.getAttribute('position').count;
      showToast(
        'ok',
        `Fotogrametri kabini: ${result.viewCount} pozdan ${vertexCount.toLocaleString('tr-TR')} vertex'lik model üretildi${
          result.colored ? ' (fotoğraftan renk bindirildi)' : ''
        }.`
      );
    },
    [commitGeometry, showToast]
  );

  // ---- Rig & Animasyon (Oyun Modu) ----
  const handleCreateRig = () => {
    if (!geometry) {
      showToast('err', 'Önce bir 3D model oluşturun veya içe aktarın.');
      return;
    }
    try {
      if (rig) disposeRig(rig.result);
      const result = buildBipedRig(geometry);
      const clips = buildAllClips(result.heightMm);
      setRig({ result, clips });
      setActiveClip('idle');
      showToast('ok', `Rig oluşturuldu (${result.skeleton.bones.length} kemik) — idle animasyonu başladı.`);
    } catch (err) {
      showToast('err', (err as Error).message);
    }
  };

  const handleRemoveRig = () => {
    if (!rig) return;
    disposeRig(rig.result);
    setRig(null);
    showToast('info', 'Rig kaldırıldı; baskı modeli aynen duruyor.');
  };

  const handleDownloadAnimatedGLB = async () => {
    if (!rig) return;
    try {
      const buffer = await exportAnimatedGLB(rig.result.skinnedMesh, [rig.clips[activeClip]]);
      triggerDownload(buffer, `photo2print-rigged-${activeClip}.glb`, 'model/gltf-binary');
      showToast('ok', `Animasyonlu GLB indirildi (klip: ${activeClip}) — Blender/Unity/Godot/Unreal'de açılabilir.`);
    } catch (err) {
      showToast('err', (err as Error).message);
    }
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setGeometry((curr) => {
      curr?.dispose();
      return prev;
    });
    showToast('info', 'Son işlem geri alındı.');
  };

  // Start or reuse mobile session when QR modal opens
  const openQrScanner = async () => {
    try {
      let sid = sessionId;
      if (!sid) {
        const res = await fetch('/api/sessions', { method: 'POST' });
        const data = await res.json();
        sid = data.sessionId;
        setSessionId(sid);
      }
      setQrOpen(true);
    } catch {
      showToast('err', 'Yerel sunucuya (port 3001) bağlanılamadı.');
    }
  };

  // Poll active mobile session for incoming photos & PLY point clouds
  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        const photos: Record<string, string> = data.photos ?? {};

        for (const [angle, url] of Object.entries(photos)) {
          if (syncedFromPhone[angle] === url) continue;
          const imgRes = await fetch(url);
          const blob = await imgRes.blob();
          const dataUrl = await fileToDataUrl(blob);
          setViews((prev) =>
            prev.map((v) =>
              v.angle === angle
                ? { ...v, originalDataUrl: dataUrl, cleanedDataUrl: null, mask: null }
                : v
            )
          );
          setSyncedFromPhone((prev) => ({ ...prev, [angle]: url }));
          showToast('ok', `Telefondan "${angle}" açısı fotoğrafı alındı.`);
        }

        if (data.pointcloudUrl && !hasSyncedPly) {
          setHasSyncedPly(true);
          const plyRes = await fetch(data.pointcloudUrl);
          const buf = await plyRes.arrayBuffer();
          const parsed = parsePLY(buf);
          commitGeometry(parsed.geometry);
          showToast('ok', `Android ARCore nokta bulutu (${parsed.pointCount} nokta) 3D modele dönüştürüldü!`);
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 2200);

    return () => clearInterval(timer);
  }, [sessionId, syncedFromPhone, hasSyncedPly, commitGeometry, showToast]);

  const handleUploadAngle = async (angle: ViewAngle, file: File | undefined) => {
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    setViews((prev) =>
      prev.map((v) =>
        v.angle === angle
          ? { ...v, originalDataUrl: dataUrl, cleanedDataUrl: null, mask: null }
          : v
      )
    );
  };

  // Çoklu fotoğraf seçiminde: dosyaları ad sırasına göre boş açı slotlarına otomatik ata.
  // Dosya adları 1.jpg, 2.jpg... şeklinde numaralıysa bu sıra korunur (numaralıyken alfabetik = çekim sırası).
  const AUTO_ANGLE_ORDER: ViewAngle[] = ['front', 'right', 'back', 'left', 'top'];
  const autoAssignPhotos = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    list.sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true }));
    const used = new Set<string>();
    const assignments: Array<{ angle: ViewAngle; file: File }> = [];
    for (const file of list) {
      const slot = AUTO_ANGLE_ORDER.find((a) => !used.has(a));
      if (!slot) break;
      used.add(slot);
      assignments.push({ angle: slot, file });
    }
    const dataUrls = await Promise.all(assignments.map((a) => fileToDataUrl(a.file)));
    setViews((prev) =>
      prev.map((v) => {
        const idx = assignments.findIndex((a) => a.angle === v.angle);
        return idx === -1
          ? v
          : { ...v, originalDataUrl: dataUrls[idx], cleanedDataUrl: null, mask: null };
      })
    );
    showToast(
      'ok',
      `${assignments.length} fotoğraf sırayla otomatik atandı: ${assignments.map((a) => a.angle).join(' → ')}.`
    );
    if (list.length > assignments.length) {
      showToast('err', `${list.length - assignments.length} fotoğraf atlandı: 5 açı slotu doldu.`);
    }
  };

  const clearAngle = (angle: ViewAngle) => {
    setViews((prev) =>
      prev.map((v) =>
        v.angle === angle ? { ...v, originalDataUrl: '', cleanedDataUrl: null, mask: null } : v
      )
    );
  };

  const cleanAllBackgrounds = async (customViews?: PhotoViewItem[]) => {
    const source = customViews ?? views;
    const loaded = source.filter((v) => Boolean(v.originalDataUrl));
    if (loaded.length === 0) {
      showToast('err', 'Önce en az 1 fotoğraf yükleyin.');
      return;
    }

    setIsBusy(true);
    setBusyLabel(
      bgMode === 'ai'
        ? 'AI ile arkaplanlar temizleniyor (ilk çalıştırmada model indirilebilir)...'
        : 'Arkaplanlar hızlı yerel algoritmayla temizleniyor...'
    );

    try {
      const updated = [...source];
      for (let i = 0; i < updated.length; i++) {
        const item = updated[i];
        if (!item.originalDataUrl) continue;
        setBusyLabel(`${item.label} arkaplanı temizleniyor...`);
        let imgData: ImageData;
        let method: 'ai' | 'fast' = 'fast';
        if (bgMode === 'ai') {
          const res = await removeBackgroundAI(item.originalDataUrl, item.tolerance ?? 34);
          imgData = res.imageData;
          method = res.method;
        } else {
          const raw = await dataUrlToImageData(item.originalDataUrl, 384);
          imgData = removeBackgroundFast(raw, item.tolerance ?? 34);
          method = 'fast';
        }
        const { cleanedDataUrl, mask } = normalizeAndCropMask(imgData, 256, 0.08);
        updated[i] = { ...item, cleanedDataUrl, mask, bgMethod: method };
      }
      setViews(updated);
      showToast('ok', `${loaded.length} fotoğrafın arkaplanı başarıyla temizlendi.`);
      return updated;
    } catch (err) {
      showToast('err', `Arkaplan temizleme hatası: ${(err as Error).message}`);
      return undefined;
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const loadDemo = async (part: 'bracket' | 'knob' | 'figurine') => {
    setDemoMenuOpen(false);
    const demoViews = generateDemoPartViews(part);
    setViews(demoViews);
    if (part === 'bracket') setOfflineMethod('contour-extrude');
    else if (part === 'knob') setOfflineMethod('lathe-revolve');
    else setOfflineMethod('visual-hull');

    const cleaned = await cleanAllBackgrounds(demoViews);
    if (cleaned) {
      showToast('info', 'Örnek parça yüklendi ve temizlendi. Şimdi "3D Model Oluştur" butonuna tıklayın!');
    }
  };

  const handleGenerateOffline = async () => {
    let activeViews = views;
    const hasOriginal = activeViews.some((v) => Boolean(v.originalDataUrl));
    if (!hasOriginal) {
      showToast('err', 'Lütfen en az 1 fotoğraf yükleyin veya üstten "Örnek Parça" seçin.');
      return;
    }

    // Auto-clean if user skipped step 2
    if (!activeViews.some((v) => Boolean(v.mask))) {
      const cleaned = await cleanAllBackgrounds(activeViews);
      if (!cleaned) return;
      activeViews = cleaned;
    }

    setIsBusy(true);
    setBusyLabel('3D poligon ağı ve katı model hesaplanıyor...');
    try {
      await new Promise((r) => setTimeout(r, 30));
      let nextGeo: THREE.BufferGeometry;

      // Otomatik çoklu-foto planı: boyut → açı sınıflandırma → motor seçimi + ipuçları
      const { loaded: loadedViews, sized: sizedViews } = await buildViewInputs(activeViews);
      const plan = classifyViews(sizedViews);
      setQualityHints(buildQualityHints(plan));
      const chosenMethod = autoEngine ? engineToOfflineMethod(selectEngine(plan)) : offlineMethod;
      if (autoEngine && chosenMethod !== offlineMethod) {
        setOfflineMethod(chosenMethod);
        showToast('info', `Fotoğraf setine göre motor otomatik seçildi: ${chosenMethod}`);
      }

      // Aynı açıdan birden fazla fotoğraf geldiyse en yüksek çözünürlüklü olan tutulur:
      // düşük çözünürlüklü kopya visual hull kesişimini köreltir.
      const keepIndexes = new Set(
        plan.views.filter((v) => v.duplicateOfIndex === null).map((v) => v.index)
      );
      const keptViews = loadedViews.filter((_, i) => keepIndexes.has(i));
      if (keptViews.length < loadedViews.length) {
        showToast(
          'info',
          `${loadedViews.length - keptViews.length} tekrar eden fotoğraf atlandı (en yüksek çözünürlüklü olan kullanıldı).`
        );
      }

      if (chosenMethod === 'visual-hull') {
        const maskMap: Partial<Record<ViewAngle, BinaryMask>> = {};
        for (const v of keptViews) {
          if (v.mask) maskMap[v.angle] = v.mask;
        }
        nextGeo = reconstructVisualHull(maskMap, {
          resolution: hullResolution,
          smoothPasses: hullSmooth,
          sizeMm: targetSizeMm,
        });
      } else if (chosenMethod === 'contour-extrude') {
        const primary = activeViews.find((v) => v.angle === 'front' && v.mask) ?? activeViews.find((v) => v.mask);
        if (!primary?.mask) throw new Error('Temizlenmiş ön görünüm maskesi bulunamadı.');
        nextGeo = reconstructContourExtrude(primary.mask, {
          widthMm: extrudeWidthMm,
          thicknessMm: extrudeThicknessMm,
          bevelMm: extrudeBevelMm,
        });
      } else {
        const primary = activeViews.find((v) => v.angle === 'front' && v.mask) ?? activeViews.find((v) => v.mask);
        if (!primary?.mask) throw new Error('Temizlenmiş yan/ön görünüm maskesi bulunamadı.');
        nextGeo = reconstructLathe(primary.mask, {
          heightMm: latheHeightMm,
          hollowWallMm: latheHollowMm,
        });
      }

      const repaired = repairMesh(nextGeo);
      nextGeo.dispose();

      // Karakter sheet'inden gelen yüz yakın çekimi varsa kafa bölgesine renk bindir.
      if (faceCloseUp) {
        try {
          setBusyLabel('Yüz detayı kafa bölgesine bindiriliyor...');
          const faceImg = await dataUrlToImageData(faceCloseUp, 768);
          paintHeadFromFace(repaired, faceImg);
        } catch {
          // Yüz bindirme başarısız olsa da model kullanılabilir kalır.
        }
      }

      commitGeometry(repaired);
      showToast('ok', 'Su geçirmez (manifold) 3D model oluşturuldu ve yazıcı tablasına oturtuldu!');
    } catch (err) {
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const handleGenerateCloud = async () => {
    const frontItem = views.find((v) => v.angle === 'front' && v.originalDataUrl) ?? views.find((v) => v.originalDataUrl);
    if (!frontItem) {
      showToast('err', 'Bulut 3D AI için en az Ön (0°) fotoğrafını yüklemelisiniz.');
      return;
    }

    if (saveKeyLocal && cloudKey) {
      localStorage.setItem('p2p_cloud_key', cloudKey);
    } else if (!saveKeyLocal) {
      localStorage.removeItem('p2p_cloud_key');
    }

    setIsBusy(true);
    setBusyLabel(`Bulut Multi-View AI (${cloudProvider}) ile yüksek detaylı 3D model üretiliyor...`);

    try {
      const pickImg = (angle: ViewAngle) => {
        const item = views.find((v) => v.angle === angle && v.originalDataUrl);
        return item ? item.cleanedDataUrl || item.originalDataUrl : undefined;
      };

      const res = await fetch('/api/reconstruct/cloud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: cloudProvider,
          apiKey: cloudKey.trim() || undefined,
          hfToken: cloudProvider === 'huggingface' ? cloudKey.trim() || undefined : undefined,
          spaceId: hfSpaceId.trim() || undefined,
          images: {
            front: frontItem.cleanedDataUrl || frontItem.originalDataUrl,
            back: pickImg('back'),
            left: pickImg('left'),
            right: pickImg('right'),
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Bulut 3D üretimi başarısız oldu.');
      }

      setBusyLabel('Üretilen GLB modeli indiriliyor ve baskıya hazırlanıyor...');
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(data.modelUrl);
      const merged = extractMergedGeometry(gltf.scene);
      const scaled = scaleToDimension(merged, 'x', targetSizeMm, true);
      merged.dispose();
      commitGeometry(scaled);
      showToast('ok', `Bulut AI (${cloudProvider}) modeli hazır! Gerekirse "Katılaştır" ile 3D baskıya mühürleyin.`);
    } catch (err) {
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const handleImport3D = async (file: File | undefined) => {
    if (!file) return;
    setIsBusy(true);
    setBusyLabel(`${file.name} içe aktarılıyor...`);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      const buf = await file.arrayBuffer();
      let imported: THREE.BufferGeometry;

      if (ext === 'stl') {
        const loader = new STLLoader();
        imported = placeOnBuildPlate(loader.parse(buf));
      } else if (ext === 'obj') {
        const loader = new OBJLoader();
        const text = new TextDecoder().decode(buf);
        imported = extractMergedGeometry(loader.parse(text));
      } else if (ext === 'glb' || ext === 'gltf') {
        const loader = new GLTFLoader();
        const gltf = await loader.parseAsync(buf, '');
        imported = extractMergedGeometry(gltf.scene);
      } else if (ext === 'ply') {
        const parsed = parsePLY(buf);
        imported = parsed.geometry;
        if (parsed.wasPointCloud) {
          showToast('info', `Nokta bulutu (${parsed.pointCount} nokta) otomatik 3D katı ağa dönüştürüldü.`);
        }
      } else {
        throw new Error('Desteklenen formatlar: .STL, .OBJ, .GLB, .GLTF, .PLY');
      }

      commitGeometry(imported);
      showToast('ok', `${file.name} başarıyla yüklendi.`);
    } catch (err) {
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const runMeshOp = async (label: string, fn: (g: THREE.BufferGeometry) => THREE.BufferGeometry) => {
    if (!geometry) return;
    setIsBusy(true);
    setBusyLabel(label);
    try {
      await new Promise((r) => setTimeout(r, 20));
      const next = fn(geometry);
      commitGeometry(next);
      showToast('ok', `${label} tamamlandı.`);
    } catch (err) {
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const applyScaleAxis = (axis: 'x' | 'y' | 'z', rawValue: string) => {
    if (!geometry) return;
    const val = parseFloat(rawValue);
    if (!Number.isFinite(val) || val < 1) return;
    // Note: in UI, X=Width, Y=Depth (Three Z), Z=Height (Three Y)
    const threeAxis: 'x' | 'y' | 'z' = axis === 'x' ? 'x' : axis === 'y' ? 'z' : 'y';
    const next = scaleToDimension(geometry, threeAxis, val, lockRatio);
    commitGeometry(next);
  };

  const handleExport = async (format: 'stl' | '3mf' | 'obj' | 'glb') => {
    if (!geometry) return;
    try {
      if (format === 'stl') {
        const stl = buildSTLBinary(geometry);
        triggerDownload(stl, 'photo2print-model.stl', 'model/stl');
      } else if (format === '3mf') {
        const mf = build3MF(geometry);
        triggerDownload(mf, 'photo2print-model.3mf', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
      } else if (format === 'obj') {
        const obj = buildOBJ(geometry);
        triggerDownload(obj, 'photo2print-model.obj', 'text/plain');
      } else {
        const glb = await exportGLB(geometry);
        triggerDownload(glb, 'photo2print-model.glb', 'model/gltf-binary');
      }
      showToast('ok', `Model .${format.toUpperCase()} formatında indirildi (mm, Z=0 hazır).`);
    } catch (err) {
      showToast('err', `Dışa aktarma hatası: ${(err as Error).message}`);
    }
  };

  const loadedPhotoCount = views.filter((v) => Boolean(v.originalDataUrl)).length;
  const cleanedPhotoCount = views.filter((v) => Boolean(v.mask)).length;
  const editingItem = views.find((v) => v.angle === editingAngle) ?? null;

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col">
      {/* Top Studio Header */}
      <header className="h-14 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur px-4 flex items-center justify-between gap-3 shrink-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Printer className="w-4.5 h-4.5 text-slate-950" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-white flex items-center gap-2">
              Photo2Print 3D Studio
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                STL / 3MF / OBJ
              </span>
            </div>
            <p className="text-[11px] text-slate-400 hidden sm:block">
              Fotoğraftan Otomatik Arkaplan Temizleme, Poligon Onarım ve 3D Baskı Hazırlama
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Demo Dropdown */}
          <div className="relative">
            <button
              onClick={() => setDemoMenuOpen((o) => !o)}
              className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Örnek Parça
            </button>
            {demoMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-56 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-1 z-40">
                <button
                  onClick={() => loadDemo('bracket')}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-slate-800 text-slate-200"
                >
                  <div className="font-semibold">Kırık L-Braket (Delikli)</div>
                  <div className="text-[11px] text-slate-400">Mekanik Kontur modu için</div>
                </button>
                <button
                  onClick={() => loadDemo('knob')}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-slate-800 text-slate-200"
                >
                  <div className="font-semibold">Fırın / Cihaz Düğmesi</div>
                  <div className="text-[11px] text-slate-400">Dönel Simetri (Torna) için</div>
                </button>
                <button
                  onClick={() => loadDemo('figurine')}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-slate-800 text-slate-200"
                >
                  <div className="font-semibold">Dekoratif Biblo (Çoklu Açı)</div>
                  <div className="text-[11px] text-slate-400">Silüet Kazıma (5 Açı) için</div>
                </button>
              </div>
            )}
          </div>

          {/* Import Existing 3D / PLY */}
          <input
            ref={import3dInputRef}
            type="file"
            accept=".stl,.obj,.glb,.gltf,.ply"
            className="hidden"
            onChange={(e) => {
              handleImport3D(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => import3dInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition"
          >
            <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden md:inline">3D / .PLY İçe Aktar</span>
          </button>

          {/* Android QR Pairing */}
          <button
            onClick={openQrScanner}
            className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-xs font-semibold text-cyan-200 flex items-center gap-1.5 transition"
          >
            <QrCode className="w-3.5 h-3.5 text-cyan-400" />
            Android ile Tara (QR)
          </button>
        </div>
      </header>

      {/* Toast Notification Bar */}
      {toast && (
        <div
          className={`px-4 py-2 text-xs flex items-center justify-between border-b ${
            toast.type === 'err'
              ? 'bg-rose-950/70 border-rose-800 text-rose-200'
              : toast.type === 'ok'
              ? 'bg-emerald-950/60 border-emerald-800 text-emerald-200'
              : 'bg-cyan-950/60 border-cyan-800 text-cyan-200'
          }`}
        >
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)} className="text-slate-400 hover:text-white ml-4">
            Kapat
          </button>
        </div>
      )}

      {/* Main 3-Column Studio Workspace */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 p-3 overflow-hidden">
        {/* LEFT PANEL: Photos, Background Removal & Reconstruction Engine */}
        <section className="lg:col-span-4 xl:col-span-3 bg-slate-900/60 border border-slate-800 rounded-2xl p-3.5 flex flex-col gap-3.5 overflow-y-auto max-h-[calc(100vh-5.5rem)]">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Camera className="w-4 h-4 text-cyan-400" />
              1. Fotoğraflar ({loadedPhotoCount}/5)
            </h2>
            <span className="text-[11px] text-slate-400">{cleanedPhotoCount} temizlendi</span>
          </div>

          {/* Çoklu Yükleme: sırayla otomatik ata + sürükle-bırak */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void autoAssignPhotos(e.dataTransfer.files);
            }}
            className="rounded-xl border border-dashed border-cyan-600/50 bg-slate-950/60 p-2.5 flex items-center justify-between gap-2"
          >
            <span className="text-[10px] text-slate-400 flex-1">
              Çoklu fotoğrafı buraya sürükleyin — sırayla otomatik atanır.
            </span>
            <label className="shrink-0 px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-[11px] font-semibold cursor-pointer transition flex items-center gap-1">
              <Upload className="w-3.5 h-3.5" />
              Tümünü Yükle
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void autoAssignPhotos(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          {/* Karakter Sheet: tek görselden çoklu açı dilimleme */}
          <button
            onClick={() => setSheetOpen(true)}
            className="w-full py-2 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/40 text-[11px] font-semibold text-violet-200 flex items-center justify-center gap-1.5 transition"
          >
            <Layers className="w-3.5 h-3.5 text-violet-300" />
            Karakter Sheet'ten Yükle
          </button>

          {/* Fotogrametri Kabini: 8-16 açılı halka çekim */}
          <button
            onClick={() => setBoothOpen(true)}
            className="w-full py-2 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/40 text-[11px] font-semibold text-cyan-200 flex items-center justify-center gap-1.5 transition"
          >
            <Camera className="w-3.5 h-3.5 text-cyan-300" />
            Fotogrametri Kabini (8-16 Poz)
          </button>

          {/* Karakter sheet'inden otomatik algılanan yüz detayı */}
          {faceCloseUp && (
            <div className="rounded-xl border border-cyan-700/50 bg-slate-950/70 p-2 flex items-center gap-2">
              <img
                src={faceCloseUp}
                alt="Yüz yakın çekim"
                className="w-12 h-12 rounded-lg object-cover border border-slate-800 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-semibold text-cyan-200">Yüz detayı hazır</div>
                <div className="text-[9px] text-slate-500 leading-snug">
                  Otomatik kırpıldı; model üretiminde kafa bölgesine renk olarak bindirilir.
                </div>
              </div>
              <button
                onClick={() => setFaceCloseUp(null)}
                className="text-slate-500 hover:text-rose-400"
                title="Yüz detayını kaldır"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 5 Angle Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-2">
            {views.map((item) => (
              <div
                key={item.angle}
                className={`relative rounded-xl border p-2 flex flex-col gap-1.5 transition ${
                  item.cleanedDataUrl
                    ? 'border-emerald-500/40 bg-slate-950/80'
                    : item.originalDataUrl
                    ? 'border-cyan-500/40 bg-slate-950/80'
                    : 'border-dashed border-slate-700 bg-slate-950/40 hover:border-slate-500'
                }`}
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-slate-200">{item.label}</span>
                  {item.originalDataUrl && (
                    <button
                      onClick={() => clearAngle(item.angle)}
                      className="text-slate-500 hover:text-rose-400"
                      title="Kaldır"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {item.originalDataUrl ? (
                  <>
                    <div className="h-20 rounded-lg overflow-hidden checkerboard-bg flex items-center justify-center relative">
                      <img
                        src={item.cleanedDataUrl || item.originalDataUrl}
                        alt={item.label}
                        className="max-h-full max-w-full object-contain"
                      />
                      {item.cleanedDataUrl && (
                        <span className="absolute bottom-1 right-1 bg-emerald-500/90 text-slate-950 text-[9px] font-bold px-1.5 py-0.5 rounded">
                          TEMİZ
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setEditingAngle(item.angle)}
                        className="flex-1 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-200 transition"
                      >
                        Maske Düzenle
                      </button>
                    </div>
                  </>
                ) : (
                  <label className="h-24 flex flex-col items-center justify-center cursor-pointer text-center text-slate-500 hover:text-cyan-300 transition">
                    <Upload className="w-4 h-4 mb-1" />
                    <span className="text-[10px]">Fotoğraf Seç</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        handleUploadAngle(item.angle, e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
            ))}
          </div>

          {/* Step 2: Background Cleanup */}
          <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <Wand2 className="w-3.5 h-3.5 text-cyan-400" />
                2. Arkaplan Temizleme
              </span>
              <div className="flex rounded-lg bg-slate-900 p-0.5 border border-slate-800 text-[10px]">
                <button
                  onClick={() => setBgMode('fast')}
                  className={`px-2 py-0.5 rounded ${
                    bgMode === 'fast' ? 'bg-cyan-500 text-slate-950 font-semibold' : 'text-slate-400'
                  }`}
                >
                  Hızlı
                </button>
                <button
                  onClick={() => setBgMode('ai')}
                  className={`px-2 py-0.5 rounded ${
                    bgMode === 'ai' ? 'bg-cyan-500 text-slate-950 font-semibold' : 'text-slate-400'
                  }`}
                >
                  AI
                </button>
              </div>
            </div>
            <button
              onClick={() => cleanAllBackgrounds()}
              disabled={isBusy || loadedPhotoCount === 0}
              className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              Tüm Arkaplanları Otomatik Temizle
            </button>
          </div>

          {/* Step 3: 3D Generation Engine */}
          <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-3">
            <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              3. 3D Model Oluşturma Motoru
            </div>

            <div className="grid grid-cols-2 gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs">
              <button
                onClick={() => setEngineTab('offline')}
                className={`py-1.5 rounded-lg font-medium flex items-center justify-center gap-1 transition ${
                  engineTab === 'offline' ? 'bg-cyan-500 text-slate-950 font-semibold' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Zap className="w-3.5 h-3.5" /> Yerel Offline
              </button>
              <button
                onClick={() => setEngineTab('cloud')}
                className={`py-1.5 rounded-lg font-medium flex items-center justify-center gap-1 transition ${
                  engineTab === 'cloud' ? 'bg-cyan-500 text-slate-950 font-semibold' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Cloud className="w-3.5 h-3.5" /> Bulut AI
              </button>
            </div>

            {engineTab === 'offline' ? (
              <div className="space-y-2.5 text-xs">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>Yeniden Oluşturma Modu</span>
                    <label className="flex items-center gap-1.5 cursor-pointer text-cyan-300">
                      <input
                        type="checkbox"
                        checked={autoEngine}
                        onChange={(e) => setAutoEngine(e.target.checked)}
                        className="accent-cyan-500"
                      />
                      Otomatik Seç
                    </label>
                  </div>
                  <select
                    value={offlineMethod}
                    onChange={(e) => setOfflineMethod(e.target.value as OfflineMethod)}
                    disabled={autoEngine}
                    className={`w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-100 ${
                      autoEngine ? 'opacity-60 cursor-not-allowed' : ''
                    }`}
                  >
                    <option value="visual-hull">Çoklu Açı Silüet Kazıma (3–5 Fotoğraf)</option>
                    <option value="contour-extrude">Mekanik Kontur + Delik (1 Fotoğraf → Kalınlık)</option>
                    <option value="lathe-revolve">Dönel Simetri / Torna (Düğme, Kapak, Vazo)</option>
                  </select>
                </div>

                {qualityHints.length > 0 && (
                  <div className="space-y-1 rounded-lg border border-cyan-800/50 bg-slate-950/60 p-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
                      Kalite İpuçları
                    </div>
                    <ul className="space-y-0.5">
                      {qualityHints.map((hint, i) => (
                        <li key={i} className="text-[10px] text-slate-300 leading-snug">• {hint}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {offlineMethod === 'visual-hull' && (
                  <div className="space-y-2">
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>Poligon Çözünürlüğü</span>
                        <span>{hullResolution}³</span>
                      </div>
                      <input
                        type="range"
                        min={36}
                        max={160}
                        step={8}
                        value={hullResolution}
                        onChange={(e) => setHullResolution(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>Yüzey Yumuşatma</span>
                        <span>{hullSmooth} geçiş</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={5}
                        value={hullSmooth}
                        onChange={(e) => setHullSmooth(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-slate-400">Başlangıç Boyutu (mm)</label>
                      <input
                        type="number"
                        min={10}
                        max={220}
                        value={targetSizeMm}
                        onChange={(e) => setTargetSizeMm(Number(e.target.value))}
                        className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs"
                      />
                    </div>
                  </div>
                )}

                {offlineMethod === 'contour-extrude' && (
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-400">Genişlik (mm)</label>
                      <input
                        type="number"
                        value={extrudeWidthMm}
                        onChange={(e) => setExtrudeWidthMm(Number(e.target.value))}
                        className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Kalınlık (mm)</label>
                      <input
                        type="number"
                        value={extrudeThicknessMm}
                        onChange={(e) => setExtrudeThicknessMm(Number(e.target.value))}
                        className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-400">Pah (mm)</label>
                      <input
                        type="number"
                        step="0.2"
                        value={extrudeBevelMm}
                        onChange={(e) => setExtrudeBevelMm(Number(e.target.value))}
                        className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                      />
                    </div>
                  </div>
                )}

                {offlineMethod === 'lathe-revolve' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-slate-400">Yükseklik (mm)</label>
                      <input
                        type="number"
                        value={latheHeightMm}
                        onChange={(e) => setLatheHeightMm(Number(e.target.value))}
                        className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-slate-400">İçi Boş Et Kalınlığı (mm)</label>
                      <input
                        type="number"
                        min={0}
                        step="0.5"
                        value={latheHollowMm}
                        onChange={(e) => setLatheHollowMm(Number(e.target.value))}
                        placeholder="0 = Dolu"
                        className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs"
                      />
                    </div>
                  </div>
                )}

                <button
                  onClick={handleGenerateOffline}
                  disabled={isBusy}
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-slate-950 font-bold text-xs shadow-lg shadow-cyan-500/20 flex items-center justify-center gap-1.5 transition"
                >
                  <Box className="w-4 h-4" />
                  Yerel 3D Model Oluştur
                </button>
              </div>
            ) : (
              <div className="space-y-2.5 text-xs">
                <div>
                  <label className="text-[11px] text-slate-400">Bulut AI Sağlayıcısı</label>
                  <select
                    value={cloudProvider}
                    onChange={(e) => setCloudProvider(e.target.value as CloudProvider)}
                    className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-100"
                  >
                    <option value="huggingface">Hugging Face (Ücretsiz Hunyuan3D-2mv)</option>
                    <option value="fal">fal.ai (Hunyuan3D Multi-View)</option>
                    <option value="tripo">Tripo3D v2 (Multi-View)</option>
                    <option value="meshy">Meshy AI (Multi-Image to 3D)</option>
                  </select>
                </div>

                {cloudProvider === 'huggingface' && (
                  <div>
                    <label className="text-[11px] text-slate-400">Space ID</label>
                    <input
                      type="text"
                      value={hfSpaceId}
                      onChange={(e) => setHfSpaceId(e.target.value)}
                      className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                    />
                  </div>
                )}

                <div>
                  <label className="text-[11px] text-slate-400">
                    {cloudProvider === 'huggingface'
                      ? 'HF Token (İsteğe bağlı, sıra önceliği için)'
                      : 'API Anahtarı'}
                  </label>
                  <input
                    type="password"
                    value={cloudKey}
                    onChange={(e) => setCloudKey(e.target.value)}
                    placeholder={cloudProvider === 'huggingface' ? 'hf_... (opsiyonel)' : 'API anahtarını yapıştırın'}
                    className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs"
                  />
                  <label className="flex items-center gap-1.5 mt-1.5 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveKeyLocal}
                      onChange={(e) => setSaveKeyLocal(e.target.checked)}
                      className="accent-cyan-400"
                    />
                    Anahtarı sadece bu tarayıcıda hatırla
                  </label>
                </div>

                <button
                  onClick={handleGenerateCloud}
                  disabled={isBusy}
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 hover:from-indigo-400 hover:to-cyan-400 text-white font-bold text-xs shadow-lg flex items-center justify-center gap-1.5 transition"
                >
                  <Cloud className="w-4 h-4" />
                  Bulutta Multi-View 3D Üret
                </button>
              </div>
            )}

            {/* RIG & ANIMASYON (Oyun Modu) */}
            <div className="bg-slate-950/70 border border-violet-800/60 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5 text-violet-400" />
                  Rig & Animasyon (Oyun GLB)
                </span>
                {rig && (
                  <span className="text-[10px] text-violet-300 font-mono">
                    {rig.result.skeleton.bones.length} kemik
                  </span>
                )}
              </div>
              {rig ? (
                <>
                  <div className="grid grid-cols-3 gap-1">
                    {(Object.keys(RIG_CLIP_LABELS) as RigClipName[]).map((name) => (
                      <button
                        key={name}
                        onClick={() => setActiveClip(name)}
                        className={`py-1 rounded text-[10px] transition ${
                          activeClip === name
                            ? 'bg-violet-500 text-slate-950 font-bold'
                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={wireframeRig}
                      onChange={(e) => setWireframeRig(e.target.checked)}
                      className="accent-violet-400"
                    />
                    Wireframe göster
                  </label>
                  <div className="flex gap-1">
                    <button
                      onClick={handleDownloadAnimatedGLB}
                      className="flex-1 py-1.5 rounded-lg bg-violet-500 hover:bg-violet-400 text-slate-950 text-[11px] font-bold transition"
                    >
                      Animasyonlu GLB İndir
                    </button>
                    <button
                      onClick={handleRemoveRig}
                      className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] transition"
                    >
                      Kaldır
                    </button>
                  </div>
                  <p className="text-[9px] text-slate-500 leading-snug">
                    Oyun motorlarına (Unity/Godot/Unreal) ve Blender'a aktarılabilir; baskı modeli etkilenmez.
                  </p>
                </>
              ) : (
                <button
                  onClick={handleCreateRig}
                  disabled={!geometry || isBusy}
                  className="w-full py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-[11px] font-bold transition"
                >
                  Otomatik Biped Rig Oluştur
                </button>
              )}
            </div>
          </div>
        </section>
        <section className="lg:col-span-5 xl:col-span-6 flex flex-col min-h-[420px]">
          <ThreeViewport
            geometry={geometry}
            stats={stats}
            displayMode={displayMode}
            onDisplayModeChange={setDisplayMode}
            showBedGrid={showBedGrid}
            onToggleBedGrid={() => setShowBedGrid((v) => !v)}
            autoRotate={autoRotate}
            onToggleAutoRotate={() => setAutoRotate((v) => !v)}
            isBusy={isBusy}
            busyLabel={busyLabel}
            skinnedMesh={rig?.result.skinnedMesh ?? null}
            activeClip={rig ? rig.clips[activeClip] : null}
            wireframeRig={wireframeRig}
          />
        </section>

        {/* RIGHT PANEL: Print Health, mm Calibration, Mesh Repair & Export */}
        <section className="lg:col-span-3 bg-slate-900/60 border border-slate-800 rounded-2xl p-3.5 flex flex-col gap-3.5 overflow-y-auto max-h-[calc(100vh-5.5rem)]">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Sliders className="w-4 h-4 text-cyan-400" />
              4. Baskı Hazırlık & Export
            </h2>
            {undoStack.length > 0 && (
              <button
                onClick={handleUndo}
                className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> Geri Al
              </button>
            )}
          </div>

          {/* Printability Status Card */}
          {stats ? (
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                {stats.isWatertight ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                    <ShieldCheck className="w-4 h-4" /> Su Geçirmez (Baskıya Hazır)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                    <ShieldAlert className="w-4 h-4" /> Açık Kenar ({stats.openBoundaryEdges})
                  </span>
                )}
                <span className="text-xs font-mono font-bold text-cyan-300">
                  %{stats.printabilityScore}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[11px] pt-1 border-t border-slate-800/80">
                <div className="text-slate-400">
                  Hacim: <span className="text-slate-200 font-mono">{stats.volumeCm3} cm³</span>
                </div>
                <div className="text-slate-400">
                  PLA (~100%): <span className="text-slate-200 font-mono">{stats.estimatedPlaGrams} g</span>
                </div>
                <div className="text-slate-400">
                  Üçgen: <span className="text-slate-200 font-mono">{stats.triangleCount.toLocaleString('tr-TR')}</span>
                </div>
                <div className="text-slate-400">
                  Köşe: <span className="text-slate-200 font-mono">{stats.vertexCount.toLocaleString('tr-TR')}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-3 text-xs text-slate-500">
              Model oluşturulduğunda hacim, poligon sağlığı ve gerçek milimetrik ölçüler burada görünür.
            </div>
          )}

          {/* Millimeter Calibration */}
          <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">Ölçü Kalibrasyonu (mm)</span>
              <button
                onClick={() => setLockRatio((v) => !v)}
                className={`text-[11px] flex items-center gap-1 px-2 py-0.5 rounded border ${
                  lockRatio
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                    : 'bg-slate-900 border-slate-700 text-slate-400'
                }`}
              >
                {lockRatio ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                Orantı
              </button>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <div>
                <label className="text-[10px] text-slate-400">X Genişlik</label>
                <input
                  type="number"
                  disabled={!geometry}
                  value={dimX}
                  onChange={(e) => setDimX(e.target.value)}
                  onBlur={() => applyScaleAxis('x', dimX)}
                  onKeyDown={(e) => e.key === 'Enter' && applyScaleAxis('x', dimX)}
                  className="w-full mt-0.5 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400">Y Derinlik</label>
                <input
                  type="number"
                  disabled={!geometry}
                  value={dimY}
                  onChange={(e) => setDimY(e.target.value)}
                  onBlur={() => applyScaleAxis('y', dimY)}
                  onKeyDown={(e) => e.key === 'Enter' && applyScaleAxis('y', dimY)}
                  className="w-full mt-0.5 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-400">Z Yükseklik</label>
                <input
                  type="number"
                  disabled={!geometry}
                  value={dimZ}
                  onChange={(e) => setDimZ(e.target.value)}
                  onBlur={() => applyScaleAxis('z', dimZ)}
                  onKeyDown={(e) => e.key === 'Enter' && applyScaleAxis('z', dimZ)}
                  className="w-full mt-0.5 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-1">
              <button
                disabled={!geometry}
                onClick={() => runMeshOp('Tabana Oturtma', (g) => placeOnBuildPlate(g))}
                className="col-span-1 py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[10px] text-slate-200"
                title="Tabana oturt (Z=0)"
              >
                Z=0
              </button>
              <button
                disabled={!geometry}
                onClick={() => runMeshOp('X +90° Döndürme', (g) => rotateMesh90(g, 'x'))}
                className="py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[10px] text-slate-200 flex items-center justify-center gap-0.5"
              >
                <RotateCw className="w-3 h-3" /> X90°
              </button>
              <button
                disabled={!geometry}
                onClick={() => runMeshOp('Y +90° Döndürme', (g) => rotateMesh90(g, 'z'))}
                className="py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[10px] text-slate-200 flex items-center justify-center gap-0.5"
              >
                <RotateCw className="w-3 h-3" /> Y90°
              </button>
              <button
                disabled={!geometry}
                onClick={() => runMeshOp('Z +90° Döndürme', (g) => rotateMesh90(g, 'y'))}
                className="py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[10px] text-slate-200 flex items-center justify-center gap-0.5"
              >
                <RotateCw className="w-3 h-3" /> Z90°
              </button>
            </div>
          </div>

          {/* Polygon Repair & Optimization */}
          <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-cyan-400" />
              Poligon Onarım & Optimizasyon
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                disabled={!geometry || isBusy}
                onClick={() => runMeshOp('Otomatik Delik Kapama', (g) => repairMesh(g))}
                className="py-1.5 px-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[11px] text-slate-200 flex items-center justify-center gap-1"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Delik Kapat
              </button>
              <button
                disabled={!geometry || isBusy}
                onClick={() => runMeshOp('Katı Manifold Remesh', (g) => voxelRemesh(g, 64))}
                className="py-1.5 px-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/35 disabled:opacity-40 text-[11px] text-cyan-200 flex items-center justify-center gap-1"
              >
                <Layers className="w-3.5 h-3.5 text-cyan-400" /> Katılaştır
              </button>
            </div>

            <button
              disabled={!geometry || isBusy}
              onClick={() => runMeshOp('Taubin Yumuşatma', (g) => taubinSmooth(g, 3))}
              className="w-full py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[11px] text-slate-200"
            >
              Yüzeyi Yumuşat (Hacim Korumalı)
            </button>

            {/* Poligon artırma: orta-nokta alt bölme (×4 / ×16) */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                disabled={!geometry || isBusy}
                onClick={() => runMeshOp('Poligon Artır ×4', (g) => subdivideGeometry(g, 1))}
                className="py-1.5 px-2 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/35 disabled:opacity-40 text-[11px] text-violet-200 flex items-center justify-center gap-1"
              >
                <Sparkles className="w-3.5 h-3.5 text-violet-400" /> Poligon ×4
              </button>
              <button
                disabled={!geometry || isBusy}
                onClick={() => runMeshOp('Poligon Artır ×16', (g) => subdivideGeometry(g, 2))}
                className="py-1.5 px-2 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/35 disabled:opacity-40 text-[11px] text-violet-200 flex items-center justify-center gap-1"
              >
                <Sparkles className="w-3.5 h-3.5 text-violet-400" /> Poligon ×16
              </button>
            </div>

            <div className="pt-1 border-t border-slate-800/80 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Poligon Azaltma: %{simplifyPct}</span>
                <button
                  disabled={!geometry || isBusy}
                  onClick={() =>
                    runMeshOp('Poligon Optimizasyonu', (g) => simplifyMesh(g, simplifyPct / 100))
                  }
                  className="text-cyan-400 hover:text-cyan-300 disabled:opacity-40 font-semibold"
                >
                  Uygula
                </button>
              </div>
              <input
                type="range"
                min={15}
                max={90}
                step={5}
                value={simplifyPct}
                onChange={(e) => setSimplifyPct(Number(e.target.value))}
                className="w-full accent-cyan-400"
              />
            </div>

            <div className="pt-1 border-t border-slate-800/80 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Tabanı Düz Kes: {cutBottomMm} mm</span>
                <button
                  disabled={!geometry || isBusy}
                  onClick={() =>
                    runMeshOp('Alt Taban Düz Kesme', (g) => flatCutBottom(g, cutBottomMm))
                  }
                  className="text-cyan-400 hover:text-cyan-300 disabled:opacity-40 font-semibold flex items-center gap-1"
                >
                  <Scissors className="w-3 h-3" /> Kes
                </button>
              </div>
              <input
                type="range"
                min={0.5}
                max={12}
                step={0.5}
                value={cutBottomMm}
                onChange={(e) => setCutBottomMm(Number(e.target.value))}
                className="w-full accent-cyan-400"
              />
            </div>
          </div>

          {/* Export Formats */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 space-y-2 mt-auto">
            <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              5. 3D Yazıcı İçin Dışa Aktar
            </div>
            <button
              disabled={!geometry || isBusy}
              onClick={() => handleExport('stl')}
              className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition"
            >
              <Download className="w-4 h-4" /> .STL İndir (Cura / Prusa / Bambu)
            </button>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                disabled={!geometry || isBusy}
                onClick={() => handleExport('3mf')}
                className="py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-semibold text-cyan-200"
              >
                .3MF
              </button>
              <button
                disabled={!geometry || isBusy}
                onClick={() => handleExport('obj')}
                className="py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-semibold text-slate-200"
              >
                .OBJ
              </button>
              <button
                disabled={!geometry || isBusy}
                onClick={() => handleExport('glb')}
                className="py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-semibold text-slate-200"
              >
                .GLB
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Modals */}
      {editingItem && (
        <MaskEditorModal
          item={editingItem}
          onClose={() => setEditingAngle(null)}
          onSave={(updated) => {
            setViews((prev) => prev.map((v) => (v.angle === updated.angle ? updated : v)));
            setEditingAngle(null);
            showToast('ok', `${updated.label} maskesi güncellendi.`);
          }}
        />
      )}

      <CharacterSheetModal
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onApply={handleSheetApply}
      />

      <PhotoBoothModal
        open={boothOpen}
        onClose={() => setBoothOpen(false)}
        onGenerated={handleBoothGenerated}
      />

      {qrOpen && sessionId && (
        <QrPairingModal
          sessionId={sessionId}
          syncedCount={Object.keys(syncedFromPhone).length}
          hasPointCloud={hasSyncedPly}
          onClose={() => setQrOpen(false)}
        />
      )}
    </div>
  );
}
