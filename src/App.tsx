import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  ArrowLeftRight,
  Box,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  Code2,
  Columns2,
  Compass,
  Cpu,
  Download,
  FileCode2,
  FolderOpen,
  Layers,
  LayoutGrid,
  Lock,
  Moon,
  Play,
  Printer,
  QrCode,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ScanFace,
  Scissors,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Unlock,
  Upload,
  User,
  Wand2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import {
  BinaryMask,
  CadSpec,
  CharacterDepthProfile,
  CloudJobSnapshot,
  CloudProvider,
  HfSpaceHealth,
  MeshStats,
  OfflineMethod,
  PhotoViewItem,
  ViewAngle,
  ViewportDisplayMode,
} from './engine/types';
import { FREE_HF_SPACES } from './engine/cloudCatalog';
import { CAD_PRESETS, compileCadSpec, generateBuild123dCode } from './engine/cadEngine';
import {
  dataUrlToImageData,
  fileToDataUrl,
  generateDemoPartViews,
  normalizeAndCropMask,
  normalizeTurnaroundGroup,
  removeBackgroundAI,
  removeBackgroundFast,
} from './engine/maskProcessor';
import { cropImageData, detectCharacterSheetGrid } from './engine/sheetSplit';
import {
  CHARACTER_SAMPLE_PRESETS,
  MECHANICAL_DEMO_PRESETS,
  type CharacterSamplePreset,
} from './engine/sampleGallery';
import {
  DepthStylePreset,
  SideFacingChoice,
  reconstructVisualHull,
} from './engine/visualHull';
import {
  MaskStyle,
  SubjectBuildMode,
  reconstructFaceMask,
  reconstructHeadBust,
} from './engine/bustAndMask';
import { reconstructContourExtrude } from './engine/contourExtrude';
import { reconstructLathe } from './engine/latheRevolve';
import { classifyViews, selectEngine, buildQualityHints, engineToOfflineMethod } from './engine/autoDetect';
import {
  MAX_TRIANGLES_SOFT,
  analyzeMesh,
  countTriangles,
  estimateMeshBytes,
  flatCutBottom,
  placeOnBuildPlate,
  repairMesh,
  rotateMesh90,
  scaleToDimension,
  simplifyMesh,
  subdivideWithBudget,
  taubinSmooth,
  upscaleAndCompactMesh,
  voxelRemesh,
} from './engine/meshRepair';
import {
  AmsFilamentSlot,
  build3MF,
  buildMultiColor3MF,
  buildOBJ,
  buildObjMtlZip,
  buildSTLBinary,
  exportAnimatedGLB,
  exportGLB,
  quantizeVertexColorsKMeans,
  triggerDownload,
} from './engine/exporters';
import {
  BakedPbrPixels,
  DensePointCloudData,
  LodTier,
  PhotogrammetryStage,
  PolyMollyQaReport,
  PrintabilityReport,
  QUALITY_PROFILES,
  QualityProfileId,
  RunManifest,
  SubjectRoutingAdvice,
  VirtualCameraPose,
  addDisplayPedestal,
  analyzeSubjectRouting,
  applyQualityProfileToGeometry,
  bakeDualHemispherePbrAtlas,
  buildCameraRig,
  buildLodGeometry,
  buildRunManifest,
  buildTexturedPbrGroup,
  evaluatePolyMollyQa,
  evaluatePrintabilityDoctor,
  extractDensePointCloud,
  pruneLooseFragments,
} from './engine/photogrammetry';
import { buildBipedRig, disposeRig, type RigResult } from './engine/rigging';
import { buildAllClips, RIG_CLIP_LABELS, type RigClipName } from './engine/animClips';
import { parsePLY } from './engine/plyImporter';
import { ThreeViewport } from './components/ThreeViewport';
import { MultiCompareViewport, type ComparePaneItem } from './components/MultiCompareViewport';
import { ComfyWorkflowPanel } from './components/ComfyWorkflowPanel';
import { StudioDiagnosticsPanel } from './components/StudioDiagnosticsPanel';
import { MaskEditorModal } from './components/MaskEditorModal';
import { QrPairingModal } from './components/QrPairingModal';
import { MobileScannerView } from './components/MobileScannerView';
import {
  CharacterSheetModal,
  type CharacterSheetApplyItem,
  type CharacterSheetApplyOptions,
} from './components/CharacterSheetModal';
import { PhotoBoothModal, type PhotoBoothResult } from './components/PhotoBoothModal';
import { paintHeadFromFace } from './engine/faceDetect';

const CARDINAL_ANGLES: ViewAngle[] = ['front', 'right', 'back', 'left', 'top'];
const DIAGONAL_ANGLES: ViewAngle[] = ['frontRight', 'backRight', 'backLeft', 'frontLeft'];

const INITIAL_VIEWS: PhotoViewItem[] = [
  { angle: 'front', label: 'Ön (0°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'right', label: 'Sağ (90°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'back', label: 'Arka (180°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'left', label: 'Sol (270°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'top', label: 'Üstten', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'frontRight', label: 'Ön-Sağ (45°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'backRight', label: 'Arka-Sağ (135°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'backLeft', label: 'Arka-Sol (225°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
  { angle: 'frontLeft', label: 'Ön-Sol (315°)', originalDataUrl: '', cleanedDataUrl: null, mask: null, tolerance: 34 },
];

function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

function disposeThreeGroup(group: THREE.Group | null) {
  if (!group) return;
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      const std = m as THREE.MeshPhysicalMaterial;
      std.map?.dispose();
      std.normalMap?.dispose();
      std.roughnessMap?.dispose();
      std.metalnessMap?.dispose();
      std.aoMap?.dispose();
      m.dispose();
    }
  });
}

async function safeFetchJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, init);
  const raw = await res.text();
  const trimmed = raw.trim();
  if (trimmed.startsWith('<!') || trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
    throw new Error(`Sunucu geçici olarak HTML yanıtı döndürdü (HTTP ${res.status}). Lütfen tekrar deneyin.`);
  }
  let parsed: unknown = {};
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Sunucu JSON yanıtı çözümlenemedi (HTTP ${res.status}).`);
    }
  }
  return { ok: res.ok, status: res.status, data: parsed as T };
}

function resizeDataUrlForCloud(dataUrl: string, maxSide = 1024): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      if (w <= maxSide && h <= maxSide) {
        resolve(dataUrl);
        return;
      }
      const scale = maxSide / Math.max(w, h);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function extractMergedGeometry(object3d: THREE.Object3D): THREE.BufferGeometry {
  const rawParts: THREE.BufferGeometry[] = [];
  let anyColor = false;
  let anyUv = false;
  object3d.updateMatrixWorld(true);
  object3d.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      const nonIndexed = g.index ? g.toNonIndexed() : g;
      if (!nonIndexed.getAttribute('normal')) {
        nonIndexed.computeVertexNormals();
      }
      if (nonIndexed.getAttribute('color')) anyColor = true;
      if (nonIndexed.getAttribute('uv')) anyUv = true;
      rawParts.push(nonIndexed);
      if (nonIndexed !== g) g.dispose();
    }
  });
  if (rawParts.length === 0) {
    throw new Error('İçe aktarılan 3D model içinde mesh bulunamadı.');
  }

  const parts = rawParts.map((src) => {
    const clean = new THREE.BufferGeometry();
    const pos = src.getAttribute('position') as THREE.BufferAttribute;
    const nrm = src.getAttribute('normal') as THREE.BufferAttribute;
    clean.setAttribute('position', pos.clone());
    clean.setAttribute('normal', nrm.clone());
    if (anyColor) {
      const col = src.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (col && col.itemSize >= 3) {
        const rgb = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          rgb[i * 3] = col.getX(i);
          rgb[i * 3 + 1] = col.getY(i);
          rgb[i * 3 + 2] = col.getZ(i);
        }
        clean.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
      } else {
        const fill = new Float32Array(pos.count * 3);
        fill.fill(0.88);
        clean.setAttribute('color', new THREE.BufferAttribute(fill, 3));
      }
    }
    if (anyUv) {
      const uv = src.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (uv) {
        clean.setAttribute('uv', uv.clone());
      } else {
        clean.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
      }
    }
    src.dispose();
    return clean;
  });

  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  parts.forEach((p) => {
    if (p !== merged) p.dispose();
  });
  if (!merged) throw new Error('Mesh parçaları birleştirilemedi.');
  return placeOnBuildPlate(merged);
}

function prepareTexturedScene(source: THREE.Object3D, targetWidthMm?: number): THREE.Group {
  const wrapper = new THREE.Group();
  const clone = source.clone(true);
  wrapper.add(clone);
  wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrapper);
  if (!box.isEmpty()) {
    const size = new THREE.Vector3();
    box.getSize(size);
    if (targetWidthMm && targetWidthMm > 0 && size.x > 1e-5) {
      const s = targetWidthMm / size.x;
      clone.scale.multiplyScalar(s);
      wrapper.updateMatrixWorld(true);
    }
    const scaledBox = new THREE.Box3().setFromObject(wrapper);
    const center = new THREE.Vector3();
    scaledBox.getCenter(center);
    clone.position.x -= center.x;
    clone.position.y -= scaledBox.min.y;
    clone.position.z -= center.z;
    wrapper.updateMatrixWorld(true);
  }
  return wrapper;
}

const ANGLE_HINT_DEG: Record<ViewAngle, number> = {
  front: 0,
  frontRight: 45,
  right: 90,
  backRight: 135,
  back: 180,
  backLeft: 225,
  left: 270,
  frontLeft: 315,
  top: -1,
};

const getImageSize = (dataUrl: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Görsel boyutları okunamadı.'));
    img.src = dataUrl;
  });

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

function formatSpaceStage(health?: HfSpaceHealth): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!health) return { text: 'Kontrol ediliyor', tone: 'muted' };
  if (health.healthy || health.stage === 'RUNNING') return { text: 'Açık', tone: 'ok' };
  if (health.stage === 'SLEEPING' || health.stage === 'BUILDING' || health.stage === 'RUNNING_BUILDING') {
    return { text: 'Uyuyor', tone: 'warn' };
  }
  return { text: 'Bakımda', tone: 'muted' };
}

export default function App() {
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const mobileSession = searchParams.get('mode') === 'mobile' ? searchParams.get('session') : null;

  if (mobileSession) {
    return <MobileScannerView sessionId={mobileSession} />;
  }

  return <DesktopStudio />;
}

function DesktopStudio() {
  // Light-default dual theme (persisted in localStorage)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('3bstudio_theme');
      return saved === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('3bstudio_theme', theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  const [views, setViews] = useState<PhotoViewItem[]>(INITIAL_VIEWS);
  const [editingAngle, setEditingAngle] = useState<ViewAngle | null>(null);
  const [bgMode, setBgMode] = useState<'fast' | 'ai'>('fast');

  // Engine tabs: Local 2K PBR, Cloud AI, ComfyUI GPU, Text-CAD
  const [engineTab, setEngineTab] = useState<'offline' | 'cloud' | 'comfy' | 'cad'>('offline');
  const [offlineMethod, setOfflineMethod] = useState<OfflineMethod>('visual-hull');
  const [autoEngine, setAutoEngine] = useState(true);
  const [qualityProfile, setQualityProfile] = useState<QualityProfileId>('studio-ultra');
  const [delightAlbedo, setDelightAlbedo] = useState(true);
  const [sourceDetailReplace, setSourceDetailReplace] = useState(true);
  const [enablePedestal, setEnablePedestal] = useState(false);
  const [subjectMode, setSubjectMode] = useState<SubjectBuildMode>('character');
  const [depthPreset, setDepthPreset] = useState<DepthStylePreset>('natural-sharp');
  const [sideProfileFacing, setSideProfileFacing] = useState<SideFacingChoice>('auto');
  const [symmetricSideMirror, setSymmetricSideMirror] = useState(true);
  const [compareLayout, setCompareLayout] = useState<'single' | '2-up' | '4-up'>('single');
  const [compareVersion, setCompareVersion] = useState(0);
  const [useCloudDepthCalibration, setUseCloudDepthCalibration] = useState(false);

  // Kafa Büstü & Yüz Maskesi ayarları
  const [bustHeightMm, setBustHeightMm] = useState(110);
  const [bustReliefScale, setBustReliefScale] = useState(1.0);
  const [bustIncludePlinth, setBustIncludePlinth] = useState(true);
  const [maskStyle, setMaskStyle] = useState<MaskStyle>('wearable-shell');
  const [maskWidthMm, setMaskWidthMm] = useState(165);
  const [maskWallMm, setMaskWallMm] = useState(3.2);
  const [maskCutEyes, setMaskCutEyes] = useState(true);
  const [maskStrapLoops, setMaskStrapLoops] = useState(true);

  const [qualityHints, setQualityHints] = useState<string[]>([]);
  const [subjectAdvice, setSubjectAdvice] = useState<SubjectRoutingAdvice | null>(null);

  // Photogrammetry 4-stage + LOD + Diagnostics state
  const [photogrammetryStage, setPhotogrammetryStage] = useState<PhotogrammetryStage>('textured');
  const [cameraRig, setCameraRig] = useState<VirtualCameraPose[]>([]);
  const [denseCloud, setDenseCloud] = useState<DensePointCloudData | null>(null);
  const [showCameraRig, setShowCameraRig] = useState(false);
  const [activeLod, setActiveLod] = useState<LodTier>('full');
  const [showPhotoCompare, setShowPhotoCompare] = useState(false);
  const [qaReport, setQaReport] = useState<PolyMollyQaReport | null>(null);
  const [printability, setPrintability] = useState<PrintabilityReport | null>(null);
  const [amsSlotsCount, setAmsSlotsCount] = useState(4);
  const [amsPalette, setAmsPalette] = useState<AmsFilamentSlot[]>([]);
  const [runHistory, setRunHistory] = useState<RunManifest[]>([]);

  // Cached local reconstruction artifacts for instant LOD / Pedestal / Delighting / Local3D+ Compare toggles
  const baseGeoRef = useRef<THREE.BufferGeometry | null>(null);
  const colorViewsRef = useRef<Partial<Record<ViewAngle, ImageData>>>({});
  const faceImgRef = useRef<ImageData | null>(null);
  const bakedPbrRef = useRef<BakedPbrPixels | null>(null);
  const frontHeadMissingRef = useRef(false);
  const frontMaskRef = useRef<BinaryMask | null>(null);
  const viewMasksRef = useRef<Partial<Record<ViewAngle, BinaryMask>>>({});
  const aiHybridRef = useRef<{
    label: string;
    geometry: THREE.BufferGeometry;
    texturedScene: THREE.Group | null;
  } | null>(null);
  const localHybridRef = useRef<{
    geometry: THREE.BufferGeometry;
    texturedScene: THREE.Group | null;
    iouPct: number | null;
  } | null>(null);

  // Rig & Animation
  const [rig, setRig] = useState<{ result: RigResult; clips: Record<RigClipName, THREE.AnimationClip> } | null>(null);
  const [activeClip, setActiveClip] = useState<RigClipName>('idle');
  const [wireframeRig, setWireframeRig] = useState(false);

  // Auto-detect engine + Subject Routing whenever views change
  useEffect(() => {
    let cancelled = false;
    if (!views.some((v) => Boolean(v.originalDataUrl) || Boolean(v.cleanedDataUrl))) {
      setQualityHints([]);
      setSubjectAdvice(null);
      return;
    }
    void (async () => {
      try {
        const { sized } = await buildViewInputs(views);
        if (cancelled || sized.length === 0) return;
        const plan = classifyViews(sized);
        setQualityHints(buildQualityHints(plan));
        if (autoEngine) setOfflineMethod(engineToOfflineMethod(selectEngine(plan)));

        const front = views.find((v) => v.angle === 'front' && v.mask) ?? views.find((v) => v.mask);
        if (front?.mask) {
          const frontImg = front.cleanedDataUrl
            ? await dataUrlToImageData(front.cleanedDataUrl, 384).catch(() => null)
            : null;
          if (!cancelled) {
            setSubjectAdvice(analyzeSubjectRouting(front.mask, frontImg));
          }
        } else {
          setSubjectAdvice(null);
        }
      } catch {
        // silent fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [views, autoEngine]);

  const [hullResolution, setHullResolution] = useState(156);
  const [hullSmooth, setHullSmooth] = useState(1);
  const [targetSizeMm, setTargetSizeMm] = useState(80);
  const [extrudeWidthMm, setExtrudeWidthMm] = useState(60);
  const [extrudeThicknessMm, setExtrudeThicknessMm] = useState(8);
  const [extrudeBevelMm, setExtrudeBevelMm] = useState(0.5);
  const [latheHeightMm, setLatheHeightMm] = useState(45);
  const [latheHollowMm, setLatheHollowMm] = useState(0);

  // Cloud AI state (Async Job Queue + Live Space Health)
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>('huggingface');
  const [cloudKey, setCloudKey] = useState(() => localStorage.getItem('p2p_cloud_key') ?? '');
  const [hfSpaceId, setHfSpaceId] = useState(FREE_HF_SPACES[0].id);
  const [hfAutoFallback, setHfAutoFallback] = useState(true);
  const [saveKeyLocal, setSaveKeyLocal] = useState(true);
  const [hfHealthMap, setHfHealthMap] = useState<Record<string, HfSpaceHealth>>({});
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [cloudJob, setCloudJob] = useState<CloudJobSnapshot | null>(null);
  const activeCloudJobIdRef = useRef<string | null>(null);

  // Parametric Text-to-CAD state
  const [cadPrompt, setCadPrompt] = useState('');
  const [cadUseFrontRef, setCadUseFrontRef] = useState(false);
  const [activeCadSpec, setActiveCadSpec] = useState<CadSpec | null>(null);
  const [cadParamValues, setCadParamValues] = useState<Record<string, number>>({});
  const [showCadCode, setShowCadCode] = useState(false);

  // Geometry & Undo history
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [texturedScene, setTexturedScene] = useState<THREE.Group | null>(null);
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
  const [polyLevel, setPolyLevel] = useState(0);
  const [cutBottomMm, setCutBottomMm] = useState(2);
  const [smartCompressExport, setSmartCompressExport] = useState(true);
  const [showDiagonalAngles, setShowDiagonalAngles] = useState(false);

  // Status & modals
  const [isBusy, setIsBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [toast, setToast] = useState<{ type: 'info' | 'ok' | 'err'; text: string } | null>(null);
  const [demoMenuOpen, setDemoMenuOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [boothOpen, setBoothOpen] = useState(false);
  const [faceCloseUp, setFaceCloseUp] = useState<string | null>(null);
  const faceInputRef = useRef<HTMLInputElement>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [syncedFromPhone, setSyncedFromPhone] = useState<Record<string, string>>({});
  const [hasSyncedPly, setHasSyncedPly] = useState(false);

  const import3dInputRef = useRef<HTMLInputElement>(null);

  const stats: MeshStats | null = useMemo(() => {
    if (!geometry) return null;
    return analyzeMesh(geometry);
  }, [geometry]);

  const currentTris = useMemo(() => (geometry ? countTriangles(geometry) : 0), [geometry]);
  const projectedTris = currentTris * 4 ** polyLevel;
  const sizeEstimate = useMemo(() => estimateMeshBytes(projectedTris), [projectedTris]);
  const overBudget = projectedTris > MAX_TRIANGLES_SOFT;

  const comparePhotoUrl = useMemo(() => {
    const front = views.find((v) => v.angle === 'front' && (v.cleanedDataUrl || v.originalDataUrl));
    const anyLoaded = views.find((v) => v.cleanedDataUrl || v.originalDataUrl);
    return front?.originalDataUrl || front?.cleanedDataUrl || anyLoaded?.originalDataUrl || null;
  }, [views]);

  useEffect(() => {
    if (stats) {
      setDimX(String(stats.widthMm));
      setDimY(String(stats.depthMm));
      setDimZ(String(stats.heightMm));
    }
  }, [stats]);

  // Recompute K-Means AMS filament palette whenever geometry or slot count changes
  useEffect(() => {
    if (!geometry) {
      setAmsPalette([]);
      return;
    }
    try {
      const { palette } = quantizeVertexColorsKMeans(geometry, amsSlotsCount);
      setAmsPalette(palette);
    } catch {
      setAmsPalette([]);
    }
  }, [geometry, amsSlotsCount]);

  // Recompute QA & Printability when geometry/texturedScene changes
  useEffect(() => {
    if (!geometry) {
      setQaReport(null);
      setPrintability(null);
      return;
    }
    const qa = evaluatePolyMollyQa(geometry, qualityProfile, {
      hasTexture: Boolean(texturedScene),
      stats,
    });
    const doc = evaluatePrintabilityDoctor(geometry, {
      frontMask: frontMaskRef.current,
    });
    setQaReport(qa);
    setPrintability(doc);
  }, [geometry, texturedScene, qualityProfile, stats]);

  const showToast = useCallback((type: 'info' | 'ok' | 'err', text: string) => {
    setToast({ type, text });
  }, []);

  const refreshCloudHealth = useCallback(async (force = false) => {
    setLoadingHealth(true);
    try {
      const q = force ? '?refresh=1' : '';
      const { ok, data } = await safeFetchJson<{ spaces?: HfSpaceHealth[] }>(`/api/cloud/health${q}`);
      if (ok && Array.isArray(data.spaces)) {
        const next: Record<string, HfSpaceHealth> = {};
        for (const s of data.spaces) next[s.id] = s;
        setHfHealthMap(next);
      }
    } catch {
      // silent health check fallback
    } finally {
      setLoadingHealth(false);
    }
  }, []);

  useEffect(() => {
    if (engineTab === 'cloud' && Object.keys(hfHealthMap).length === 0) {
      void refreshCloudHealth(false);
    }
  }, [engineTab, hfHealthMap, refreshCloudHealth]);

  const commitGeometry = useCallback(
    (nextGeo: THREE.BufferGeometry, pushHistory = true, nextTexturedScene: THREE.Group | null = null) => {
      setGeometry((prev) => {
        if (prev && pushHistory) {
          setUndoStack((s) => [...s.slice(-9), prev]);
        } else if (prev && !pushHistory) {
          prev.dispose();
        }
        return nextGeo;
      });
      setTexturedScene((prevScene) => {
        if (prevScene && prevScene !== nextTexturedScene) {
          disposeThreeGroup(prevScene);
        }
        return nextTexturedScene;
      });
      setRig((prev) => {
        if (prev) disposeRig(prev.result);
        return null;
      });
    },
    []
  );

  /**
   * Poligon arttırma (Subdivide), Max Upscale, Yumuşatma, Azaltma veya Ölçekleme sonrasında
   * mevcut 2K PBR veya içe aktarılmış GLB dokusunu/materyalini yeni geometriye yeniden bağlar.
   * Böylece poligon düzenlemelerinde yüzey kaplaması ve renkler asla kaybolmaz.
   */
  const rebindTexturedSceneForGeometry = useCallback(
    (nextGeo: THREE.BufferGeometry, prevScene: THREE.Group | null): THREE.Group | null => {
      if (bakedPbrRef.current) {
        return buildTexturedPbrGroup(nextGeo, bakedPbrRef.current);
      }
      if (!prevScene || !nextGeo.getAttribute('uv')) {
        return null;
      }
      let sourceMat: THREE.Material | null = null;
      prevScene.traverse((obj) => {
        if (sourceMat) return;
        const m = obj as THREE.Mesh;
        if (m.isMesh && m.material) {
          sourceMat = Array.isArray(m.material) ? m.material[0] : m.material;
        }
      });
      if (!sourceMat) return null;
      const clonedMat = (sourceMat as THREE.Material).clone();
      const std = clonedMat as THREE.MeshPhysicalMaterial;
      const srcStd = sourceMat as THREE.MeshPhysicalMaterial;
      if (srcStd.map) {
        std.map = srcStd.map.clone();
        std.map.needsUpdate = true;
      }
      if (srcStd.normalMap) {
        std.normalMap = srcStd.normalMap.clone();
        std.normalMap.needsUpdate = true;
      }
      if (srcStd.roughnessMap) {
        std.roughnessMap = srcStd.roughnessMap.clone();
        std.roughnessMap.needsUpdate = true;
      }
      if (srcStd.metalnessMap) {
        std.metalnessMap = srcStd.metalnessMap.clone();
        std.metalnessMap.needsUpdate = true;
      }
      if (srcStd.aoMap) {
        std.aoMap = srcStd.aoMap.clone();
        std.aoMap.needsUpdate = true;
      }

      const geoClone = nextGeo.clone();
      if (!geoClone.getAttribute('uv2') && geoClone.getAttribute('uv')) {
        geoClone.setAttribute('uv2', geoClone.getAttribute('uv').clone());
      }
      const mesh = new THREE.Mesh(geoClone, clonedMat);
      mesh.name = '3BStudio_Rebound_Mesh';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const group = new THREE.Group();
      group.name = '3BStudio_Rebound_Scene';
      group.add(mesh);
      return group;
    },
    []
  );

  // Instant rebuild from cached baseGeoRef for LOD / Pedestal / Delighting / Source-Detail / Side-Symmetry toggles
  const rebuildCachedView = useCallback(
    (opts: {
      lod?: LodTier;
      pedestal?: boolean;
      delight?: boolean;
      sourceDetailReplace?: boolean;
      symmetricSideMirror?: boolean;
      rebakePbr?: boolean;
    }) => {
      const base = baseGeoRef.current;
      if (!base) return;
      const tier = opts.lod ?? activeLod;
      const usePedestal = opts.pedestal ?? enablePedestal;
      const useDelight = opts.delight ?? delightAlbedo;
      const useSourceReplace = opts.sourceDetailReplace ?? sourceDetailReplace;
      const useSymSide = opts.symmetricSideMirror ?? symmetricSideMirror;

      let geo = buildLodGeometry(base, tier);
      if (usePedestal) {
        const withPed = addDisplayPedestal(geo);
        geo.dispose();
        geo = withPed;
      }

      let nextTex: THREE.Group | null = null;
      const hasColorViews = Object.keys(colorViewsRef.current).length > 0;
      if (hasColorViews) {
        if (opts.rebakePbr || !bakedPbrRef.current) {
          const spec = QUALITY_PROFILES[qualityProfile];
          bakedPbrRef.current = bakeDualHemispherePbrAtlas(colorViewsRef.current, {
            faceCloseUp: faceImgRef.current,
            width: spec.atlasWidth,
            height: spec.atlasHeight,
            unsharpAmount: spec.unsharpAmount,
            normalStrength: spec.normalStrength,
            aoStrength: spec.aoStrength,
            frontHeadMissing: frontHeadMissingRef.current,
            delight: useDelight,
            sourceDetailReplace: useSourceReplace,
            symmetricSideMirror: useSymSide,
          });
        }
        if (bakedPbrRef.current) {
          nextTex = buildTexturedPbrGroup(geo, bakedPbrRef.current);
        }
      } else {
        nextTex = rebindTexturedSceneForGeometry(geo, texturedScene);
      }

      commitGeometry(geo, false, nextTex);
      setCompareVersion((v) => v + 1);
    },
    [
      activeLod,
      enablePedestal,
      delightAlbedo,
      sourceDetailReplace,
      symmetricSideMirror,
      qualityProfile,
      commitGeometry,
      rebindTexturedSceneForGeometry,
      texturedScene,
    ]
  );

  const handleLodChange = useCallback(
    (tier: LodTier) => {
      setActiveLod(tier);
      if (baseGeoRef.current) {
        rebuildCachedView({ lod: tier });
        showToast(
          'info',
          tier === 'full'
            ? 'Tam çözünürlüklü mesh etkinleştirildi.'
            : `${tier.toUpperCase()} oyun/web LOD varyantı (2K Normal/AO UV korumalı) uygulandı.`
        );
      } else if (geometry) {
        const lodGeo = buildLodGeometry(geometry, tier);
        commitGeometry(lodGeo, true, null);
      }
    },
    [rebuildCachedView, geometry, commitGeometry, showToast]
  );

  const handleTogglePedestal = useCallback(() => {
    const next = !enablePedestal;
    setEnablePedestal(next);
    if (baseGeoRef.current) {
      rebuildCachedView({ pedestal: next });
      showToast('ok', next ? 'Figür sergi kaidesi (Y=0) eklendi.' : 'Sergi kaidesi kaldırıldı.');
    } else if (geometry && next) {
      const withPed = addDisplayPedestal(geometry);
      commitGeometry(withPed, true, null);
      showToast('ok', 'Figür sergi kaidesi (Y=0) eklendi.');
    }
  }, [enablePedestal, rebuildCachedView, geometry, commitGeometry, showToast]);

  const handleToggleDelight = useCallback(
    (nextVal: boolean) => {
      setDelightAlbedo(nextVal);
      if (baseGeoRef.current && Object.keys(colorViewsRef.current).length > 0) {
        rebuildCachedView({ delight: nextVal, rebakePbr: true });
        showToast(
          'info',
          nextVal
            ? 'SF3D Albedo Delighting etkinleştirildi — gölge yanıkları dengelendi.'
            : 'Orijinal fotoğraf ışığı ile Albedo yeniden pişirildi.'
        );
      }
    },
    [rebuildCachedView, showToast]
  );

  const handleToggleSourceDetailReplace = useCallback(() => {
    const nextVal = !sourceDetailReplace;
    setSourceDetailReplace(nextVal);
    if (baseGeoRef.current && Object.keys(colorViewsRef.current).length > 0) {
      rebuildCachedView({ sourceDetailReplace: nextVal, rebakePbr: true });
      showToast(
        'info',
        nextVal
          ? 'Kaynak Ayrıntıları (Replace) etkin — fotoğraf netliği ve keskin hatlar geri yansıtıldı.'
          : 'Ham Temel (önceki kaplama) görünümüne geçildi.'
      );
    }
  }, [sourceDetailReplace, rebuildCachedView, showToast]);

  const handleSwapFrontBack = useCallback(() => {
    setViews((prev) => {
      const front = prev.find((v) => v.angle === 'front');
      const back = prev.find((v) => v.angle === 'back');
      if (!front || !back) return prev;
      return prev.map((v) => {
        if (v.angle === 'front') {
          return {
            ...v,
            originalDataUrl: back.originalDataUrl,
            cleanedDataUrl: back.cleanedDataUrl,
            mask: back.mask,
            tolerance: back.tolerance,
            bgMethod: back.bgMethod,
          };
        }
        if (v.angle === 'back') {
          return {
            ...v,
            originalDataUrl: front.originalDataUrl,
            cleanedDataUrl: front.cleanedDataUrl,
            mask: front.mask,
            tolerance: front.tolerance,
            bgMethod: front.bgMethod,
          };
        }
        return v;
      });
    });

    if (geometry) {
      const flipped = geometry.clone();
      flipped.rotateY(Math.PI);
      flipped.computeVertexNormals();
      flipped.computeBoundingBox();
      if (baseGeoRef.current) {
        baseGeoRef.current.rotateY(Math.PI);
        baseGeoRef.current.computeVertexNormals();
        baseGeoRef.current.computeBoundingBox();
      }
      const rebound = rebindTexturedSceneForGeometry(flipped, texturedScene);
      commitGeometry(flipped, true, rebound);
      setCompareVersion((v) => v + 1);
    }
    showToast('ok', 'Ön ↔ Arka görünümler ve model yönü (180°) çevrildi.');
  }, [geometry, commitGeometry, rebindTexturedSceneForGeometry, texturedScene, showToast]);

  const handleSelectProfile = useCallback((id: QualityProfileId) => {
    setQualityProfile(id);
    const spec = QUALITY_PROFILES[id];
    setHullResolution(spec.resolution);
    setHullSmooth(spec.smoothPasses);
  }, []);

  const handleSheetApply = useCallback(
    (
      items: CharacterSheetApplyItem[],
      faceDataUrl: string | null,
      options?: CharacterSheetApplyOptions
    ) => {
      if (items.length === 0 && !faceDataUrl) return;
      const nextViews = views.map((v) => ({ ...v }));
      let hasDiagonal = false;
      for (const item of items) {
        const target = nextViews.find((v) => v.angle === item.angle);
        if (!target) continue;
        target.originalDataUrl = item.dataUrl;
        target.cleanedDataUrl = null;
        target.mask = null;
        if (DIAGONAL_ANGLES.includes(item.angle)) hasDiagonal = true;
      }
      setViews(nextViews);
      if (hasDiagonal) setShowDiagonalAngles(true);
      if (faceDataUrl) setFaceCloseUp(faceDataUrl);

      if (items.length > 0 && options?.autoCleanBackground !== false) {
        void cleanAllBackgrounds(nextViews).then((cleaned) => {
          if (cleaned) {
            showToast(
              'ok',
              faceDataUrl
                ? `Karakter sheet'ten ${items.length} görünüm + yüz yakın çekimi aktarıldı ve temizlendi.`
                : `Karakter sheet'ten ${items.length} görünüm aktarıldı ve temizlendi.`
            );
          }
        });
      } else {
        showToast('ok', `Karakter sheet'ten ${items.length} görünüm yüklendi.`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [views, showToast, bgMode]
  );

  const handleFaceUpload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        showToast('err', 'Lütfen bir görsel dosyası seçin (png, jpg, webp).');
        return;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        setFaceCloseUp(dataUrl);
        showToast('ok', 'Yüz fotoğrafı yüklendi; 2K PBR doku ve kafa bölgesine işlenecek.');
      } catch (err) {
        showToast('err', (err as Error).message);
      }
    },
    [showToast]
  );

  const handleLoadCadPreset = useCallback(
    (spec: CadSpec) => {
      try {
        const initVals: Record<string, number> = {};
        for (const p of spec.parameters) initVals[p.name] = p.value;
        const geo = compileCadSpec(spec, initVals);
        baseGeoRef.current?.dispose();
        baseGeoRef.current = null;
        setActiveCadSpec(spec);
        setCadParamValues(initVals);
        setPhotogrammetryStage('mesh');
        commitGeometry(geo, true, null);
        setDisplayMode('solid');
        showToast('ok', `"${spec.title}" parametrik CAD modeli yüklendi.`);
      } catch (err) {
        showToast('err', (err as Error).message);
      }
    },
    [commitGeometry, showToast]
  );

  const handleCadParamChange = useCallback(
    (paramName: string, value: number) => {
      if (!activeCadSpec) return;
      const nextVals = { ...cadParamValues, [paramName]: value };
      setCadParamValues(nextVals);
      try {
        const geo = compileCadSpec(activeCadSpec, nextVals);
        commitGeometry(geo, false, null);
      } catch {
        // ignore invalid intermediate values
      }
    },
    [activeCadSpec, cadParamValues, commitGeometry]
  );

  const handleGenerateCad = async () => {
    const clean = cadPrompt.trim();
    if (clean.length < 3) {
      showToast('err', 'Lütfen üretmek istediğiniz parçayı kısaca tarif edin.');
      return;
    }
    setIsBusy(true);
    setBusyLabel('Parametrik Text-to-CAD modeli ve build123d kodu üretiliyor...');
    try {
      const frontView = views.find((v) => v.angle === 'front' && v.originalDataUrl) ?? views.find((v) => v.originalDataUrl);
      const { ok, data } = await safeFetchJson<{ spec?: CadSpec; error?: string }>('/api/cad/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: clean,
          referenceImageDataUrl: cadUseFrontRef && frontView ? frontView.cleanedDataUrl || frontView.originalDataUrl : undefined,
        }),
      });
      if (!ok || !data.spec) {
        throw new Error(data.error || 'Parametrik CAD üretimi başarısız oldu.');
      }
      const spec = data.spec;
      const initVals: Record<string, number> = {};
      for (const p of spec.parameters) initVals[p.name] = p.value;
      const geo = compileCadSpec(spec, initVals);
      baseGeoRef.current?.dispose();
      baseGeoRef.current = null;
      setActiveCadSpec(spec);
      setCadParamValues(initVals);
      setPhotogrammetryStage('mesh');
      commitGeometry(geo, true, null);
      setDisplayMode('solid');
      showToast('ok', `"${spec.title}" üretildi! Parametre sürgüleriyle ölçüyü anlık değiştirebilirsiniz.`);
    } catch (err) {
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const handleDownloadBuild123d = () => {
    if (!activeCadSpec) return;
    const code = generateBuild123dCode(activeCadSpec, cadParamValues);
    const safeName = activeCadSpec.title.replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase() || 'model';
    triggerDownload(code, `${safeName}_build123d.py`, 'text/x-python;charset=utf-8');
    showToast('ok', `${safeName}_build123d.py indirildi.`);
  };

  const handleBoothGenerated = useCallback(
    (result: PhotoBoothResult) => {
      baseGeoRef.current?.dispose();
      baseGeoRef.current = result.geometry.clone();
      commitGeometry(result.geometry);
      setDisplayMode('solid');
      setPhotogrammetryStage('mesh');
      const vertexCount = result.geometry.getAttribute('position').count;
      showToast(
        'ok',
        `Fotogrametri kabini: ${result.viewCount} pozdan ${vertexCount.toLocaleString('tr-TR')} vertex'lik model üretildi.`
      );
    },
    [commitGeometry, showToast]
  );

  // ---- Rig & Animation ----
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
      triggerDownload(buffer, `3bstudio-rigged-${activeClip}.glb`, 'model/gltf-binary');
      showToast('ok', `Animasyonlu GLB indirildi (${activeClip}).`);
    } catch (err) {
      showToast('err', (err as Error).message);
    }
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    const rebound = rebindTexturedSceneForGeometry(prev, texturedScene);
    setGeometry((curr) => {
      curr?.dispose();
      return prev;
    });
    setTexturedScene((prevScene) => {
      if (prevScene && prevScene !== rebound) disposeThreeGroup(prevScene);
      return rebound;
    });
    showToast('info', 'Son işlem geri alındı.');
  };

  const openQrScanner = async () => {
    try {
      let sid = sessionId;
      if (!sid) {
        const { ok, data } = await safeFetchJson<{ sessionId?: string }>('/api/sessions', { method: 'POST' });
        if (!ok || !data.sessionId) throw new Error('Oturum açılamadı.');
        sid = data.sessionId;
        setSessionId(sid);
      }
      setQrOpen(true);
    } catch {
      showToast('err', 'Yerel sunucu oturumu başlatılamadı.');
    }
  };

  // Poll active mobile session
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
          showToast('ok', `Android nokta bulutu (${parsed.pointCount} nokta) 3D modele dönüştürüldü.`);
        }
      } catch {
        // ignore transient poll errors
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

  const AUTO_ANGLE_ORDER: ViewAngle[] = [
    'front',
    'right',
    'back',
    'left',
    'top',
    'frontRight',
    'backRight',
    'backLeft',
    'frontLeft',
  ];

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
    if (assignments.some((a) => DIAGONAL_ANGLES.includes(a.angle))) {
      setShowDiagonalAngles(true);
    }
    setViews((prev) =>
      prev.map((v) => {
        const idx = assignments.findIndex((a) => a.angle === v.angle);
        return idx === -1
          ? v
          : { ...v, originalDataUrl: dataUrls[idx], cleanedDataUrl: null, mask: null };
      })
    );
    showToast('ok', `${assignments.length} fotoğraf sırayla otomatik atandı.`);
  };

  const clearAngle = (angle: ViewAngle) => {
    setViews((prev) =>
      prev.map((v) =>
        v.angle === angle ? { ...v, originalDataUrl: '', cleanedDataUrl: null, mask: null } : v
      )
    );
  };

  const clearAllPhotos = () => {
    setViews(INITIAL_VIEWS.map((v) => ({ ...v })));
    setFaceCloseUp(null);
    setQualityHints([]);
    setSubjectAdvice(null);
    showToast('info', 'Tüm fotoğraf slotları temizlendi.');
  };

  const cleanAllBackgrounds = async (
    customViews?: PhotoViewItem[],
    options?: { cutInteriorHoles?: boolean; silent?: boolean }
  ) => {
    const source = customViews ?? views;
    const loaded = source.filter((v) => Boolean(v.originalDataUrl));
    if (loaded.length === 0) {
      showToast('err', 'Önce en az 1 fotoğraf yükleyin.');
      return;
    }

    setIsBusy(true);
    setBusyLabel(
      bgMode === 'ai'
        ? 'AI ile arkaplanlar temizleniyor...'
        : 'BiRefNet kenar sertleştirme + ortak boy hizalama uygulanıyor...'
    );

    try {
      const updated = [...source];
      const cleanedImages: Partial<Record<ViewAngle, ImageData>> = {};
      const methodsByAngle: Partial<Record<ViewAngle, 'ai' | 'fast'>> = {};

      for (let i = 0; i < updated.length; i++) {
        const item = updated[i];
        if (!item.originalDataUrl) continue;
        setBusyLabel(`${item.label} arkaplanı temizleniyor...`);
        let imgData: ImageData;
        let method: 'ai' | 'fast' = 'fast';
        if (bgMode === 'ai' && !options?.cutInteriorHoles) {
          const res = await removeBackgroundAI(item.originalDataUrl, item.tolerance ?? 34);
          imgData = res.imageData;
          method = res.method;
        } else {
          const raw = await dataUrlToImageData(item.originalDataUrl, 512);
          imgData = removeBackgroundFast(raw, item.tolerance ?? 34, {
            cutInteriorHoles: options?.cutInteriorHoles,
          });
          method = 'fast';
        }
        cleanedImages[item.angle] = imgData;
        methodsByAngle[item.angle] = method;
      }

      const angleKeys = Object.keys(cleanedImages) as ViewAngle[];
      if (angleKeys.length >= 2) {
        // Ortak dikey yükseklik (head-to-toe) kilidi: T-poz/A-poz ön görünüm ile dar yan görünüm 1:1 hizalanır
        const normalizedList = normalizeTurnaroundGroup(
          angleKeys.map((angle) => ({ angle, imageData: cleanedImages[angle]! })),
          256,
          0.08
        );
        const normByAngle = new Map(normalizedList.map((n) => [n.angle, n]));
        for (let i = 0; i < updated.length; i++) {
          const item = updated[i];
          const norm = normByAngle.get(item.angle);
          if (!norm) continue;
          updated[i] = {
            ...item,
            cleanedDataUrl: norm.cleanedDataUrl,
            mask: norm.mask,
            bgMethod: methodsByAngle[item.angle] ?? 'fast',
          };
        }
      } else if (angleKeys.length === 1) {
        const onlyAngle = angleKeys[0];
        const norm = normalizeAndCropMask(cleanedImages[onlyAngle]!, 256, 0.08);
        for (let i = 0; i < updated.length; i++) {
          if (updated[i].angle === onlyAngle) {
            updated[i] = {
              ...updated[i],
              cleanedDataUrl: norm.cleanedDataUrl,
              mask: norm.mask,
              bgMethod: methodsByAngle[onlyAngle] ?? 'fast',
            };
          }
        }
      }

      setViews(updated);
      if (!options?.silent) {
        showToast(
          'ok',
          angleKeys.length >= 2
            ? `${loaded.length} görünümün arkaplanı temizlendi ve 1:1 ortak boy hizalaması kilitlendi.`
            : `${loaded.length} fotoğrafın arkaplanı temizlendi ve kenar haleleri arındırıldı.`
        );
      }
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
    const preset = MECHANICAL_DEMO_PRESETS.find((p) => p.id === part);
    const demoCards = generateDemoPartViews(part);
    const mergedViews = INITIAL_VIEWS.map((slot) => {
      const found = demoCards.find((d) => d.angle === slot.angle);
      return found ? { ...slot, ...found } : { ...slot };
    });
    // Örnek mekanik parçalarda otomatik motor geçersiz kılmasını kapat ki doğru algoritma (Kontur / Torna / Visual Hull) çalışsın
    setAutoEngine(false);
    setSubjectMode('character');
    setFaceCloseUp(null);
    setViews(mergedViews);
    setOfflineMethod(preset?.recommendedMethod ?? (part === 'bracket' ? 'contour-extrude' : part === 'knob' ? 'lathe-revolve' : 'visual-hull'));

    const cleaned = await cleanAllBackgrounds(mergedViews, {
      cutInteriorHoles: preset?.cutInteriorHoles ?? part === 'bracket',
      silent: true,
    });
    if (cleaned) {
      showToast(
        'ok',
        `${preset?.title ?? part} yüklendi (${preset?.subtitle ?? ''}). "Yerel 2K PBR Model Oluştur" butonuna tıklayın.`
      );
    }
  };

  const loadCharacterSample = async (preset: CharacterSamplePreset) => {
    setDemoMenuOpen(false);
    setIsBusy(true);
    setBusyLabel(`"${preset.title}" yükleniyor ve görünümler ayıklanıyor...`);
    try {
      const resp = await fetch(preset.assetPath);
      if (!resp.ok) throw new Error(`Örnek görsel yüklenemedi (HTTP ${resp.status}).`);
      const blob = await resp.blob();
      const dataUrl = await fileToDataUrl(blob);

      setSubjectMode('character');
      setAutoEngine(false);
      setOfflineMethod('visual-hull');
      setSymmetricSideMirror(preset.singleSideSymmetry);

      const nextViews = INITIAL_VIEWS.map((v) => ({ ...v }));
      let extractedFaceUrl: string | null = null;
      let extractedCount = 0;

      if (preset.kind === 'single') {
        const frontSlot = nextViews.find((v) => v.angle === 'front');
        if (frontSlot) {
          frontSlot.originalDataUrl = dataUrl;
          extractedCount = 1;
        }
      } else {
        const source = await dataUrlToImageData(dataUrl, 1600);
        const grid = detectCharacterSheetGrid(source, {
          maxSlices: 24,
          stripFrames: true,
          focusedIsolation: true,
        });
        const fullRes = await dataUrlToImageData(dataUrl, 4096);
        const scaleX = fullRes.width / Math.max(1, source.width);
        const scaleY = fullRes.height / Math.max(1, source.height);

        const cropToDataUrl = (box: { x: number; y: number; width: number; height: number }): string => {
          const cropped = cropImageData(fullRes, {
            x: Math.round(box.x * scaleX),
            y: Math.round(box.y * scaleY),
            width: Math.max(8, Math.round(box.width * scaleX)),
            height: Math.max(8, Math.round(box.height * scaleY)),
          });
          const canvas = document.createElement('canvas');
          canvas.width = cropped.width;
          canvas.height = cropped.height;
          const ctx = canvas.getContext('2d')!;
          ctx.putImageData(cropped, 0, 0);
          const url = canvas.toDataURL('image/png');
          canvas.width = 0;
          canvas.height = 0;
          return url;
        };

        const activeFigs = grid.cells.filter((c) => c.kind === 'figure' && !c.excludedByDefault);
        const fallbackFigs = activeFigs.length > 0 ? activeFigs : grid.cells.filter((c) => c.kind === 'figure').slice(0, 4);
        const usedAngles = new Set<ViewAngle>();
        const angleOrder: ViewAngle[] = ['front', 'right', 'back', 'left', 'frontRight'];
        let hasDiag = false;

        for (const cell of fallbackFigs) {
          let ang: ViewAngle = cell.suggestedAngle;
          if (usedAngles.has(ang)) {
            ang = angleOrder.find((a) => !usedAngles.has(a)) ?? ang;
          }
          if (usedAngles.has(ang)) continue;
          usedAngles.add(ang);
          const slot = nextViews.find((v) => v.angle === ang);
          if (slot) {
            slot.originalDataUrl = cropToDataUrl(cell);
            extractedCount++;
            if (DIAGONAL_ANGLES.includes(ang)) hasDiag = true;
          }
        }
        if (hasDiag) setShowDiagonalAngles(true);

        const activeFaces = grid.cells.filter((c) => c.kind === 'face' && !c.excludedByDefault);
        const bestFace = activeFaces.sort((a, b) => b.faceConfidence - a.faceConfidence)[0];
        if (bestFace) {
          extractedFaceUrl = cropToDataUrl(bestFace);
        }
      }

      setViews(nextViews);
      setFaceCloseUp(extractedFaceUrl);
      const cleaned = await cleanAllBackgrounds(nextViews, { silent: true });
      if (cleaned) {
        showToast(
          'ok',
          `"${preset.title}" hazır: ${extractedCount} ana görünüm${extractedFaceUrl ? ' + Ana Yüz' : ''} ayıklandı ve 1:1 boy kilitlendi.`
        );
      }
    } catch (err) {
      showToast('err', `Örnek yüklenemedi: ${(err as Error).message}`);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const handleGenerateOffline = async (overrideProfile?: QualityProfileId) => {
    let activeViews = views;
    const hasOriginal = activeViews.some((v) => Boolean(v.originalDataUrl));
    if (!hasOriginal) {
      showToast('err', 'Lütfen en az 1 fotoğraf yükleyin veya üstten "Örnek Parça" seçin.');
      return;
    }

    if (!activeViews.some((v) => Boolean(v.mask))) {
      const cleaned = await cleanAllBackgrounds(activeViews);
      if (!cleaned) return;
      activeViews = cleaned;
    }

    const activeProfileId = overrideProfile ?? qualityProfile;
    const profileSpec = QUALITY_PROFILES[activeProfileId];
    const tStart = performance.now();

    setIsBusy(true);
    setBusyLabel(
      subjectMode === 'head-bust'
        ? '1/3 · Kafa büstü maskesi ve yüz bölgesi hazırlanıyor...'
        : subjectMode === 'face-mask'
          ? '1/3 · Yüz maskesi kabuk geometrisi hazırlanıyor...'
          : '1/4 · Fotoğraflar ve keskin anatomi kalibrasyonu hazırlanıyor...'
    );
    try {
      await new Promise((r) => setTimeout(r, 12));

      const { loaded: loadedViews, sized: sizedViews } = await buildViewInputs(activeViews);
      const plan = classifyViews(sizedViews);
      setQualityHints(buildQualityHints(plan));
      const chosenMethod =
        subjectMode !== 'character'
          ? 'visual-hull'
          : autoEngine
            ? engineToOfflineMethod(selectEngine(plan))
            : offlineMethod;
      if (subjectMode === 'character' && autoEngine && chosenMethod !== offlineMethod) {
        setOfflineMethod(chosenMethod);
      }

      const keepIndexes = new Set(
        plan.views.filter((v) => v.duplicateOfIndex === null).map((v) => v.index)
      );
      const keptViews = loadedViews.filter((_, i) => keepIndexes.has(i));

      // Yüksek çözünürlüklü renkli görselleri oku (360° projeksiyon + 2K PBR Atlas için)
      const colorViews: Partial<Record<ViewAngle, ImageData>> = {};
      const viewMasks: Partial<Record<ViewAngle, BinaryMask>> = {};
      for (const v of keptViews) {
        if (v.mask) viewMasks[v.angle] = v.mask;
        const src = v.cleanedDataUrl || v.originalDataUrl;
        if (!src) continue;
        try {
          colorViews[v.angle] = await dataUrlToImageData(src, 768);
        } catch {
          // ignore
        }
      }
      const faceImg = faceCloseUp ? await dataUrlToImageData(faceCloseUp, 768).catch(() => null) : null;

      // Bulut AI oran kalibrasyonu varsayılan olarak KAPALI (0 ağ çağrısı => 2-4 sn yerel hız).
      // Kullanıcı isterse "Bulut AI Oran Analizi" kutusunu açarak opt-in kullanabilir.
      let depthProfile: Partial<CharacterDepthProfile> | null = null;
      if (useCloudDepthCalibration && subjectMode === 'character' && chosenMethod === 'visual-hull') {
        const frontV = keptViews.find((v) => v.angle === 'front');
        const backV = keptViews.find((v) => v.angle === 'back');
        if (frontV || backV) {
          try {
            const frontSmall = frontV ? await resizeDataUrlForCloud(frontV.cleanedDataUrl || frontV.originalDataUrl, 512) : undefined;
            const backSmall = backV ? await resizeDataUrlForCloud(backV.cleanedDataUrl || backV.originalDataUrl, 512) : undefined;
            const faceSmall = faceCloseUp ? await resizeDataUrlForCloud(faceCloseUp, 512) : undefined;
            const aiRes = await safeFetchJson<{ profile?: CharacterDepthProfile }>('/api/ai/analyze-character', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ front: frontSmall, back: backSmall, face: faceSmall }),
            });
            if (aiRes.ok && aiRes.data.profile) {
              depthProfile = aiRes.data.profile;
            }
          } catch {
            // Yerel matematiksel EDT anatomi ile sessizce devam et
          }
        }
      }

      const activeAngles: ViewAngle[] = [];
      let nextGeo: THREE.BufferGeometry;

      if (subjectMode === 'head-bust') {
        setBusyLabel('2/3 · Yüksek poligonlu kafa büstü ve yüz rölyefi yontuluyor...');
        await new Promise((r) => setTimeout(r, 10));
        const primary = activeViews.find((v) => v.angle === 'front' && v.mask) ?? activeViews.find((v) => v.mask);
        if (!primary?.mask) throw new Error('Kafa büstü için temizlenmiş ön fotoğraf maskesi gerekli.');
        activeAngles.push(primary.angle);
        const primaryColor = faceImg ?? colorViews[primary.angle] ?? null;
        nextGeo = reconstructHeadBust(primary.mask, primaryColor, {
          heightMm: bustHeightMm,
          resolution: Math.min(156, Math.max(96, hullResolution)),
          reliefScale: bustReliefScale,
          autoCropHeadShoulders: true,
          includeSculptedPlinth: bustIncludePlinth,
        });
      } else if (subjectMode === 'face-mask') {
        setBusyLabel(
          maskStyle === 'wearable-shell'
            ? '2/3 · Giyilebilir içi oyuk yüz maskesi kabuğu örülüyor...'
            : '2/3 · Düz arkalı duvar maske rölyefi örülüyor...'
        );
        await new Promise((r) => setTimeout(r, 10));
        const primary = activeViews.find((v) => v.angle === 'front' && v.mask) ?? activeViews.find((v) => v.mask);
        if (!primary?.mask) throw new Error('Yüz maskesi için temizlenmiş ön fotoğraf maskesi gerekli.');
        activeAngles.push(primary.angle);
        const primaryColor = faceImg ?? colorViews[primary.angle] ?? null;
        nextGeo = reconstructFaceMask(primary.mask, primaryColor, {
          style: maskStyle,
          widthMm: maskWidthMm,
          wallThicknessMm: maskWallMm,
          cutEyes: maskCutEyes,
          addStrapLoops: maskStrapLoops,
        });
      } else if (chosenMethod === 'visual-hull') {
        setBusyLabel('2/4 · Yüksek poligonlu keskin hacim ve ayak/yüz +Z kilidi hesaplanıyor...');
        await new Promise((r) => setTimeout(r, 10));
        const maskMap: Partial<Record<ViewAngle, BinaryMask>> = {};
        for (const v of keptViews) {
          if (v.mask) {
            maskMap[v.angle] = v.mask;
            activeAngles.push(v.angle);
          }
        }
        nextGeo = reconstructVisualHull(maskMap, {
          resolution: overrideProfile ? profileSpec.resolution : hullResolution,
          smoothPasses: overrideProfile ? profileSpec.smoothPasses : hullSmooth,
          sizeMm: targetSizeMm,
          colorViews,
          faceCloseUp: faceImg,
          autoCompleteHead: true,
          projectColors: true,
          depthProfile,
          depthPreset,
          sideProfileFacing,
          symmetricSideMirror,
        });
      } else if (chosenMethod === 'contour-extrude') {
        const primary = activeViews.find((v) => v.angle === 'front' && v.mask) ?? activeViews.find((v) => v.mask);
        if (!primary?.mask) throw new Error('Temizlenmiş ön görünüm maskesi bulunamadı.');
        activeAngles.push(primary.angle);
        nextGeo = reconstructContourExtrude(primary.mask, {
          widthMm: extrudeWidthMm,
          thicknessMm: extrudeThicknessMm,
          bevelMm: extrudeBevelMm,
        });
      } else {
        const primary = activeViews.find((v) => v.angle === 'front' && v.mask) ?? activeViews.find((v) => v.mask);
        if (!primary?.mask) throw new Error('Temizlenmiş görünüm maskesi bulunamadı.');
        activeAngles.push(primary.angle);
        nextGeo = reconstructLathe(primary.mask, {
          heightMm: latheHeightMm,
          hollowWallMm: latheHollowMm,
        });
      }

      setBusyLabel(
        subjectMode === 'character'
          ? '3/4 · Gevşek parça temizliği ve manifold kontrolü...'
          : '3/3 · Manifold doğrulama ve kalite analizi...'
      );
      await new Promise((r) => setTimeout(r, 10));

      let removedComponents = 0;
      let profiled: THREE.BufferGeometry;
      if (subjectMode === 'face-mask') {
        // Yüz maskesi zaten 0 açık kenarlı çift cidarlı su geçirmez manifold üretir
        profiled = nextGeo;
      } else {
        const pruned = pruneLooseFragments(nextGeo, 0.005);
        removedComponents = pruned.removedComponents;
        nextGeo.dispose();
        const repaired = repairMesh(pruned.geometry);
        pruned.geometry.dispose();

        if (faceImg && subjectMode === 'character' && chosenMethod !== 'visual-hull') {
          try {
            paintHeadFromFace(repaired, faceImg);
          } catch {
            // ignore
          }
        }

        if (subjectMode === 'head-bust') {
          profiled = repaired;
        } else {
          profiled = applyQualityProfileToGeometry(repaired, activeProfileId);
          repaired.dispose();
        }
      }

      // Önbelleği güncelle (LOD, Kaide, Delighting, Kaynak Ayrıntıları anlık geçişleri için)
      baseGeoRef.current?.dispose();
      baseGeoRef.current = profiled.clone();
      colorViewsRef.current = subjectMode === 'character' ? colorViews : {};
      faceImgRef.current = faceImg;
      frontHeadMissingRef.current = Boolean(depthProfile?.frontHeadMissing);
      const frontMask = activeViews.find((v) => v.angle === 'front' && v.mask)?.mask ?? activeViews.find((v) => v.mask)?.mask ?? null;
      frontMaskRef.current = frontMask;
      viewMasksRef.current = viewMasks;

      // 3DF Zephyr 4 aşamalı kamera dizilimi + yoğun nokta bulutu
      profiled.computeBoundingBox();
      const rigPoses = buildCameraRig(activeAngles.length > 0 ? activeAngles : ['front'], profiled.boundingBox!);
      const cloud = extractDensePointCloud(profiled, 16000);
      setCameraRig(rigPoses);
      setDenseCloud(cloud);

      let displayGeo = buildLodGeometry(profiled, activeLod);
      profiled.dispose();

      if (enablePedestal && subjectMode === 'character') {
        const withPed = addDisplayPedestal(displayGeo);
        displayGeo.dispose();
        displayGeo = withPed;
      }

      let texturedGroup: THREE.Group | null = null;
      const shouldBakeCharacterPbr =
        subjectMode === 'character' && chosenMethod === 'visual-hull' && Object.keys(colorViews).length > 0;
      if (shouldBakeCharacterPbr) {
        setBusyLabel('4/4 · 2K PBR doku atlası (BFS + Kaynak Ayrıntıları + Normal/AO) pişiriliyor...');
        await new Promise((r) => setTimeout(r, 10));
        const baked = bakeDualHemispherePbrAtlas(colorViews, {
          faceCloseUp: faceImg,
          width: profileSpec.atlasWidth,
          height: profileSpec.atlasHeight,
          unsharpAmount: profileSpec.unsharpAmount,
          normalStrength: profileSpec.normalStrength,
          aoStrength: profileSpec.aoStrength,
          frontHeadMissing: frontHeadMissingRef.current,
          delight: delightAlbedo,
          sourceDetailReplace,
          symmetricSideMirror,
        });
        bakedPbrRef.current = baked;
        texturedGroup = buildTexturedPbrGroup(displayGeo, baked);
      } else {
        bakedPbrRef.current = null;
      }

      const elapsedSec = Number(((performance.now() - tStart) / 1000).toFixed(2));
      const finalStats = analyzeMesh(displayGeo);
      const finalQa = evaluatePolyMollyQa(displayGeo, activeProfileId, {
        hasTexture: Boolean(texturedGroup) || Boolean(displayGeo.getAttribute('color')),
        stats: finalStats,
      });
      const finalPrint = evaluatePrintabilityDoctor(displayGeo, {
        frontMask: subjectMode === 'character' ? frontMask : null,
        viewMasks: subjectMode === 'character' ? viewMasks : undefined,
      });

      const manifest = buildRunManifest({
        source: 'local-pbr',
        subjectMode,
        durationSec: elapsedSec,
        profileId: activeProfileId,
        lod: activeLod,
        delighted: delightAlbedo,
        sourceDetailReplace,
        hasPedestal: enablePedestal && subjectMode === 'character',
        angles: activeAngles,
        stats: finalStats,
        qa: finalQa,
        printability: finalPrint,
      });
      setRunHistory((prev) => [manifest, ...prev].slice(0, 12));

      // Yerel hibrit kıyaslama önbelleğini sakla
      if (localHybridRef.current) {
        localHybridRef.current.geometry.dispose();
        disposeThreeGroup(localHybridRef.current.texturedScene);
      }
      localHybridRef.current = {
        geometry: displayGeo.clone(),
        texturedScene: bakedPbrRef.current ? buildTexturedPbrGroup(displayGeo, bakedPbrRef.current) : null,
        iouPct: finalPrint.silhouetteIoU !== null ? Math.round(finalPrint.silhouetteIoU * 100) : null,
      };

      setPhotogrammetryStage(texturedGroup ? 'textured' : 'mesh');
      setDisplayMode('solid');
      commitGeometry(displayGeo, true, texturedGroup);
      setCompareVersion((v) => v + 1);

      const modeLabel =
        subjectMode === 'head-bust'
          ? 'Kafa Büstü'
          : subjectMode === 'face-mask'
            ? maskStyle === 'wearable-shell'
              ? 'Giyilebilir Yüz Maskesi'
              : 'Duvar Maske Rölyefi'
            : '2K PBR Model';
      const iouSuffix =
        finalPrint.silhouetteIoU !== null ? ` · Silüet-IoU %${Math.round(finalPrint.silhouetteIoU * 100)}` : '';
      showToast(
        'ok',
        `${modeLabel} ${elapsedSec} sn içinde hazır! ${finalStats.triangleCount.toLocaleString('tr-TR')} üçgen · QA %${finalQa.score}${iouSuffix}${
          removedComponents > 0 ? ` (${removedComponents} gevşek parça temizlendi)` : ''
        }.`
      );
    } catch (err) {
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  // ---- Canlı Yerel ComfyUI GPU Köprüsünden Dönen GLB Modelini Sahneye Yükle ----
  const handleComfyModelReady = async (modelUrl: string, presetName: string) => {
    setIsBusy(true);
    setBusyLabel(`ComfyUI GPU (${presetName}) modeli sahneye yükleniyor...`);
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(modelUrl);
      const merged = extractMergedGeometry(gltf.scene);
      const scaled = scaleToDimension(merged, 'x', targetSizeMm, true);
      merged.dispose();
      const loadedTextured = prepareTexturedScene(gltf.scene, targetSizeMm);

      baseGeoRef.current?.dispose();
      baseGeoRef.current = scaled.clone();
      bakedPbrRef.current = null;
      colorViewsRef.current = {};

      const comfyStats = analyzeMesh(scaled);
      const comfyQa = evaluatePolyMollyQa(scaled, qualityProfile, {
        hasTexture: Boolean(loadedTextured),
        stats: comfyStats,
      });
      const frontMask = views.find((v) => v.angle === 'front' && v.mask)?.mask ?? null;
      const comfyPrint = evaluatePrintabilityDoctor(scaled, {
        frontMask,
        viewMasks: Object.keys(viewMasksRef.current).length > 0 ? viewMasksRef.current : undefined,
      });
      const manifest = buildRunManifest({
        source: 'comfy-gpu',
        subjectMode,
        profileId: qualityProfile,
        lod: 'full',
        delighted: false,
        hasPedestal: false,
        angles: ['front'],
        stats: comfyStats,
        qa: comfyQa,
        printability: comfyPrint,
      });
      setRunHistory((prev) => [manifest, ...prev].slice(0, 12));

      if (aiHybridRef.current) {
        aiHybridRef.current.geometry.dispose();
        disposeThreeGroup(aiHybridRef.current.texturedScene);
      }
      aiHybridRef.current = {
        label: `ComfyUI · ${presetName}`,
        geometry: scaled.clone(),
        texturedScene: loadedTextured ? loadedTextured.clone(true) : null,
      };

      setActiveLod('full');
      setEnablePedestal(false);
      setPhotogrammetryStage(loadedTextured ? 'textured' : 'mesh');
      setDisplayMode('solid');
      commitGeometry(scaled, true, loadedTextured);
      setCompareVersion((v) => v + 1);
      showToast(
        'ok',
        `ComfyUI GPU (${presetName}) modeli yüklendi! ${comfyStats.triangleCount.toLocaleString('tr-TR')} üçgen · QA %${comfyQa.score}.`
      );
    } catch (err) {
      showToast('err', `ComfyUI GLB yükleme hatası: ${(err as Error).message}`);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  // ---- Bulletproof Async Cloud 3D Generation with Polling + Cancel ----
  const handleCancelCloudJob = async () => {
    const jobId = activeCloudJobIdRef.current;
    if (!jobId) return;
    activeCloudJobIdRef.current = null;
    try {
      await fetch(`/api/reconstruct/cloud/cancel/${jobId}`, { method: 'POST' });
    } catch {
      // ignore
    }
    setCloudJob(null);
    setIsBusy(false);
    setBusyLabel('');
    showToast('info', 'Bulut 3D görevi iptal edildi.');
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
    setBusyLabel('Görseller 1024 px ölçeğine optimize ediliyor...');

    try {
      const pickImg = async (angle: ViewAngle) => {
        const item = views.find((v) => v.angle === angle && v.originalDataUrl);
        if (!item) return undefined;
        return resizeDataUrlForCloud(item.cleanedDataUrl || item.originalDataUrl, 1024);
      };

      const frontResized = await resizeDataUrlForCloud(frontItem.cleanedDataUrl || frontItem.originalDataUrl, 1024);
      const [backImg, leftImg, rightImg] = await Promise.all([
        pickImg('back'),
        pickImg('left'),
        pickImg('right'),
      ]);

      setBusyLabel('Bulut 3D kuyruğu başlatılıyor...');
      const startRes = await safeFetchJson<CloudJobSnapshot & { error?: string }>('/api/reconstruct/cloud/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: cloudProvider,
          apiKey: cloudKey.trim() || undefined,
          hfToken: cloudProvider === 'huggingface' ? cloudKey.trim() || undefined : undefined,
          spaceId: hfSpaceId.trim() || undefined,
          autoFallback: hfAutoFallback,
          images: {
            front: frontResized,
            back: backImg,
            left: leftImg,
            right: rightImg,
          },
        }),
      });

      if (!startRes.ok || !startRes.data.jobId) {
        throw new Error(startRes.data.error || 'Bulut 3D görevi başlatılamadı.');
      }

      const jobId = startRes.data.jobId;
      activeCloudJobIdRef.current = jobId;
      setCloudJob(startRes.data);

      // Poll every 1.5s until done/error/cancelled
      let finalSnap: CloudJobSnapshot = startRes.data;
      while (activeCloudJobIdRef.current === jobId) {
        await new Promise((r) => setTimeout(r, 1500));
        if (activeCloudJobIdRef.current !== jobId) return;
        const poll = await safeFetchJson<CloudJobSnapshot & { error?: string }>(`/api/reconstruct/cloud/status/${jobId}`);
        if (!poll.ok) {
          throw new Error(poll.data.error || 'Bulut görev durumu okunamadı.');
        }
        finalSnap = poll.data;
        setCloudJob(finalSnap);
        setBusyLabel(`${finalSnap.stageLabel} (%${finalSnap.percent} · ${finalSnap.elapsedSec} sn)`);

        if (finalSnap.status === 'done' || finalSnap.status === 'error' || finalSnap.status === 'cancelled') {
          break;
        }
      }

      activeCloudJobIdRef.current = null;
      if (finalSnap.status === 'cancelled') return;
      if (finalSnap.status === 'error' || !finalSnap.modelUrl) {
        throw new Error(finalSnap.error || 'Bulut 3D üretimi tamamlanamadı.');
      }

      setBusyLabel('Üretilen yüksek detaylı 3D model sahneye yükleniyor...');
      const modelUrl = String(finalSnap.modelUrl);
      const lowerUrl = modelUrl.toLowerCase();
      let scaled: THREE.BufferGeometry;
      let loadedTextured: THREE.Group | null = null;

      if (lowerUrl.endsWith('.stl')) {
        const buf = await (await fetch(modelUrl)).arrayBuffer();
        const raw = placeOnBuildPlate(new STLLoader().parse(buf));
        scaled = scaleToDimension(raw, 'x', targetSizeMm, true);
        raw.dispose();
      } else if (lowerUrl.endsWith('.obj')) {
        const text = await (await fetch(modelUrl)).text();
        const obj = new OBJLoader().parse(text);
        const merged = extractMergedGeometry(obj);
        scaled = scaleToDimension(merged, 'x', targetSizeMm, true);
        merged.dispose();
      } else {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(modelUrl);
        const merged = extractMergedGeometry(gltf.scene);
        scaled = scaleToDimension(merged, 'x', targetSizeMm, true);
        merged.dispose();
        loadedTextured = prepareTexturedScene(gltf.scene, targetSizeMm);
      }

      baseGeoRef.current?.dispose();
      baseGeoRef.current = scaled.clone();
      bakedPbrRef.current = null;
      colorViewsRef.current = {};

      const cloudStats = analyzeMesh(scaled);
      const cloudQa = evaluatePolyMollyQa(scaled, qualityProfile, {
        hasTexture: Boolean(loadedTextured),
        stats: cloudStats,
      });
      const cloudPrint = evaluatePrintabilityDoctor(scaled, { frontMask: frontItem.mask });
      const manifest = buildRunManifest({
        source: 'cloud-hf',
        profileId: qualityProfile,
        lod: 'full',
        delighted: false,
        hasPedestal: false,
        angles: ['front'],
        stats: cloudStats,
        qa: cloudQa,
        printability: cloudPrint,
      });
      setRunHistory((prev) => [manifest, ...prev].slice(0, 12));

      const usedLabel = finalSnap.usedSpaceId ? `${cloudProvider} · ${finalSnap.usedSpaceId}` : cloudProvider;
      if (aiHybridRef.current) {
        aiHybridRef.current.geometry.dispose();
        disposeThreeGroup(aiHybridRef.current.texturedScene);
      }
      aiHybridRef.current = {
        label: `AI 3D (${usedLabel})`,
        geometry: scaled.clone(),
        texturedScene: loadedTextured ? loadedTextured.clone(true) : null,
      };

      setActiveLod('full');
      setEnablePedestal(false);
      setPhotogrammetryStage(loadedTextured ? 'textured' : 'mesh');
      setDisplayMode('solid');
      commitGeometry(scaled, true, loadedTextured);
      setCompareVersion((v) => v + 1);
      showToast('ok', `Bulut AI (${usedLabel}) modeli yüklendi! PolyMolly QA %${cloudQa.score}.`);
    } catch (err) {
      activeCloudJobIdRef.current = null;
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
      setCloudJob(null);
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
      let importedTextured: THREE.Group | null = null;

      if (ext === 'stl') {
        imported = placeOnBuildPlate(new STLLoader().parse(buf));
      } else if (ext === 'obj') {
        const text = new TextDecoder().decode(buf);
        imported = extractMergedGeometry(new OBJLoader().parse(text));
      } else if (ext === 'glb' || ext === 'gltf') {
        const gltf = await new GLTFLoader().parseAsync(buf, '');
        imported = extractMergedGeometry(gltf.scene);
        importedTextured = prepareTexturedScene(gltf.scene);
      } else if (ext === 'ply') {
        const parsed = parsePLY(buf);
        imported = parsed.geometry;
      } else {
        throw new Error('Desteklenen formatlar: .STL, .OBJ, .GLB, .GLTF, .PLY');
      }

      baseGeoRef.current?.dispose();
      baseGeoRef.current = imported.clone();
      setPhotogrammetryStage(importedTextured ? 'textured' : 'mesh');
      commitGeometry(imported, true, importedTextured);
      showToast('ok', `${file.name} başarıyla içe aktarıldı.`);
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
      const rebound = rebindTexturedSceneForGeometry(next, texturedScene);
      baseGeoRef.current?.dispose();
      baseGeoRef.current = next.clone();
      commitGeometry(next, true, rebound);
      setCompareVersion((v) => v + 1);
      showToast('ok', `${label} tamamlandı${rebound ? ' (doku ve renkler korundu)' : ''}.`);
    } catch (err) {
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const handleApplySubdivide = async () => {
    if (!geometry || polyLevel === 0) return;
    const label = `Poligon ×${4 ** polyLevel}`;
    setIsBusy(true);
    setBusyLabel(label);
    try {
      await new Promise((r) => setTimeout(r, 20));
      const res = subdivideWithBudget(geometry, polyLevel);
      const rebound = rebindTexturedSceneForGeometry(res.geometry, texturedScene);
      baseGeoRef.current?.dispose();
      baseGeoRef.current = res.geometry.clone();
      commitGeometry(res.geometry, true, rebound);
      setCompareVersion((v) => v + 1);
      setPolyLevel(0);
      showToast(
        res.clamped ? 'info' : 'ok',
        `${label} tamamlandı (${res.triangles.toLocaleString('tr-TR')} üçgen · doku & renkler korundu).`
      );
    } catch (err) {
      showToast('err', (err as Error).message);
    } finally {
      setIsBusy(false);
      setBusyLabel('');
    }
  };

  const handleUpscaleCompact = async () => {
    if (!geometry) return;
    setIsBusy(true);
    setBusyLabel('Max Upscale & Akıllı Sıkıştırma uygulanıyor...');
    try {
      await new Promise((r) => setTimeout(r, 25));
      const res = upscaleAndCompactMesh(geometry);
      const rebound = rebindTexturedSceneForGeometry(res.geometry, texturedScene);
      baseGeoRef.current?.dispose();
      baseGeoRef.current = res.geometry.clone();
      commitGeometry(res.geometry, true, rebound);
      setCompareVersion((v) => v + 1);
      setPolyLevel(0);
      showToast(
        'ok',
        `Max Upscale tamamlandı: ${res.beforeTriangles.toLocaleString('tr-TR')} → ${res.afterTriangles.toLocaleString('tr-TR')} üçgen (doku korundu).`
      );
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
    const threeAxis: 'x' | 'y' | 'z' = axis === 'x' ? 'x' : axis === 'y' ? 'z' : 'y';
    const next = scaleToDimension(geometry, threeAxis, val, lockRatio);
    const rebound = rebindTexturedSceneForGeometry(next, texturedScene);
    baseGeoRef.current?.dispose();
    baseGeoRef.current = next.clone();
    commitGeometry(next, true, rebound);
    setCompareVersion((v) => v + 1);
  };

  const handleExport = async (format: 'stl' | '3mf' | 'obj' | 'glb') => {
    if (!geometry) return;
    try {
      const opts = { smartCompress: smartCompressExport };
      let byteLength = 0;
      if (format === 'stl') {
        const stl = buildSTLBinary(geometry, opts);
        byteLength = stl.byteLength;
        triggerDownload(stl, '3bstudio-model.stl', 'model/stl');
      } else if (format === '3mf') {
        const mf = build3MF(geometry, opts);
        byteLength = mf.byteLength;
        triggerDownload(mf, '3bstudio-model.3mf', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
      } else if (format === 'obj') {
        const obj = buildOBJ(geometry, opts);
        byteLength = new TextEncoder().encode(obj).byteLength;
        triggerDownload(obj, '3bstudio-model.obj', 'text/plain');
      } else {
        const glb = await exportGLB(geometry, opts);
        byteLength = glb.byteLength;
        triggerDownload(glb, '3bstudio-model.glb', 'model/gltf-binary');
      }
      showToast('ok', `Model .${format.toUpperCase()} olarak indirildi (${formatBytesCompact(byteLength)}).`);
    } catch (err) {
      showToast('err', `Dışa aktarma hatası: ${(err as Error).message}`);
    }
  };

  const handleExportMultiColor3MF = () => {
    if (!geometry) return;
    try {
      const { bytes, palette } = buildMultiColor3MF(geometry, amsSlotsCount);
      triggerDownload(
        bytes,
        `3bstudio-ams-${palette.length}renk.3mf`,
        'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
      );
      showToast(
        'ok',
        `${palette.length} renkli Bambu AMS / Anycubic ACE Pro .3MF indirildi (${formatBytesCompact(bytes.byteLength)}).`
      );
    } catch (err) {
      showToast('err', (err as Error).message);
    }
  };

  const handleExportObjMtlZip = () => {
    if (!geometry) return;
    try {
      const zipBytes = buildObjMtlZip(geometry, bakedPbrRef.current ?? undefined);
      triggerDownload(zipBytes, '3bstudio-obj-mtl-pbr.zip', 'application/zip');
      showToast(
        'ok',
        `OBJ + MTL + 2K PBR dokular (.ZIP) indirildi (${formatBytesCompact(zipBytes.byteLength)}).`
      );
    } catch (err) {
      showToast('err', `OBJ+MTL ZIP hatası: ${(err as Error).message}`);
    }
  };

  const loadedPhotoCount = views.filter((v) => Boolean(v.originalDataUrl)).length;
  const cleanedPhotoCount = views.filter((v) => Boolean(v.mask)).length;
  const editingItem = views.find((v) => v.angle === editingAngle) ?? null;

  // Local3D+ Senkronize Çoklu Kıyaslama Panelleri (Ham Baz · Tam 2K PBR · LOD 20K · LOD 5K / Hibrit AI Kıyas)
  const [comparePanes, setComparePanes] = useState<ComparePaneItem[]>([]);
  useEffect(() => {
    const ownedGeos: THREE.BufferGeometry[] = [];
    const ownedGroups: THREE.Group[] = [];

    if (compareLayout === 'single' || !geometry) {
      setComparePanes([]);
      return () => {
        ownedGeos.forEach((g) => g.dispose());
        ownedGroups.forEach((grp) => disposeThreeGroup(grp));
      };
    }

    const base = baseGeoRef.current ?? geometry;
    const baked = bakedPbrRef.current;
    const iouPct =
      printability?.silhouetteIoU !== null && printability?.silhouetteIoU !== undefined
        ? Math.round(printability.silhouetteIoU * 100)
        : localHybridRef.current?.iouPct ?? null;

    const makeDownloadHandler = (targetGeo: THREE.BufferGeometry, fileName: string) => () => {
      void exportGLB(targetGeo, { smartCompress: smartCompressExport })
        .then((buf) => {
          triggerDownload(buf, fileName, 'model/gltf-binary');
          showToast('ok', `${fileName} indirildi (${formatBytesCompact(buf.byteLength)}).`);
        })
        .catch((err) => showToast('err', `GLB hatası: ${(err as Error).message}`));
    };

    const panes: ComparePaneItem[] = [];
    const hasBothHybrid = Boolean(localHybridRef.current && aiHybridRef.current);

    if (compareLayout === '2-up') {
      if (hasBothHybrid && localHybridRef.current && aiHybridRef.current) {
        panes.push({
          id: 'local-hybrid',
          title: 'Yerel Oran-Kilitli (2K PBR)',
          subtitle: '1:1 Ortak Boy + SDF/Taubin',
          badge: 'Yerel',
          geometry: localHybridRef.current.geometry,
          texturedScene: localHybridRef.current.texturedScene,
          triangleCount: countTriangles(localHybridRef.current.geometry),
          iouPct: localHybridRef.current.iouPct,
          onDownloadGlb: makeDownloadHandler(localHybridRef.current.geometry, '3bstudio-yerel-oran-kilitli.glb'),
        });
        panes.push({
          id: 'ai-hybrid',
          title: aiHybridRef.current.label,
          subtitle: 'Gerçek AI 3D Üretimi',
          badge: 'AI 3D',
          geometry: aiHybridRef.current.geometry,
          texturedScene: aiHybridRef.current.texturedScene,
          triangleCount: countTriangles(aiHybridRef.current.geometry),
          iouPct: null,
          onDownloadGlb: makeDownloadHandler(aiHybridRef.current.geometry, '3bstudio-ai-3d.glb'),
        });
      } else {
        panes.push({
          id: 'baseline-clay',
          title: 'Ham Baz (Kil Geometri)',
          subtitle: 'Yalnızca SDF/Taubin Yüzey',
          badge: 'Baz',
          geometry: base,
          texturedScene: null,
          forceClay: true,
          triangleCount: countTriangles(base),
          iouPct,
          onDownloadGlb: makeDownloadHandler(base, '3bstudio-baz-geometri.glb'),
        });
        panes.push({
          id: 'full-pbr',
          title: texturedScene ? 'Tam Kalite · 2K PBR' : 'Tam Kalite · Renkli',
          subtitle: 'Orijinal Çözünürlük + Doku',
          badge: 'Tam',
          geometry,
          texturedScene,
          triangleCount: countTriangles(geometry),
          iouPct,
          onDownloadGlb: makeDownloadHandler(geometry, '3bstudio-tam-2k-pbr.glb'),
        });
      }
    } else {
      // 4-up Local3D+ Grid: Baz (veya AI 3D) · Tam 2K PBR · LOD 20K · LOD 5K
      const lod20Geo = buildLodGeometry(base, '20k');
      const lod5Geo = buildLodGeometry(base, '5k');
      ownedGeos.push(lod20Geo, lod5Geo);

      const lod20Tex = baked ? buildTexturedPbrGroup(lod20Geo, baked) : rebindTexturedSceneForGeometry(lod20Geo, texturedScene);
      const lod5Tex = baked ? buildTexturedPbrGroup(lod5Geo, baked) : rebindTexturedSceneForGeometry(lod5Geo, texturedScene);
      if (lod20Tex) ownedGroups.push(lod20Tex);
      if (lod5Tex) ownedGroups.push(lod5Tex);

      if (hasBothHybrid && aiHybridRef.current) {
        panes.push({
          id: 'ai-hybrid-4',
          title: aiHybridRef.current.label,
          subtitle: 'Hibrit AI 3D Karşılaştırma',
          badge: 'AI 3D',
          geometry: aiHybridRef.current.geometry,
          texturedScene: aiHybridRef.current.texturedScene,
          triangleCount: countTriangles(aiHybridRef.current.geometry),
          iouPct: null,
          onDownloadGlb: makeDownloadHandler(aiHybridRef.current.geometry, '3bstudio-ai-3d.glb'),
        });
      } else {
        panes.push({
          id: 'baseline-clay-4',
          title: 'Ham Baz (Kil)',
          subtitle: 'Dokusuz Geometri İnceleme',
          badge: 'Baz',
          geometry: base,
          texturedScene: null,
          forceClay: true,
          triangleCount: countTriangles(base),
          iouPct,
          onDownloadGlb: makeDownloadHandler(base, '3bstudio-ham-baz.glb'),
        });
      }

      panes.push({
        id: 'full-pbr-4',
        title: texturedScene ? 'Tam Kalite · 2K PBR' : 'Tam Kalite · Mesh',
        subtitle: 'Oran-Kilitli 1:1 Master',
        badge: 'Tam',
        geometry,
        texturedScene,
        triangleCount: countTriangles(geometry),
        iouPct,
        onDownloadGlb: makeDownloadHandler(geometry, '3bstudio-tam-master.glb'),
      });

      panes.push({
        id: 'lod20k-4',
        title: 'LOD 20K (Oyun)',
        subtitle: 'UV & 2K Normal/AO Korumalı',
        badge: '20K',
        geometry: lod20Geo,
        texturedScene: lod20Tex,
        triangleCount: countTriangles(lod20Geo),
        iouPct,
        onDownloadGlb: makeDownloadHandler(lod20Geo, '3bstudio-lod-20k.glb'),
      });

      panes.push({
        id: 'lod5k-4',
        title: 'LOD 5K (Web / Mobil)',
        subtitle: 'Hafif Gerçek-Zamanlı Varyant',
        badge: '5K',
        geometry: lod5Geo,
        texturedScene: lod5Tex,
        triangleCount: countTriangles(lod5Geo),
        iouPct,
        onDownloadGlb: makeDownloadHandler(lod5Geo, '3bstudio-lod-5k.glb'),
      });
    }

    setComparePanes(panes);

    return () => {
      ownedGeos.forEach((g) => g.dispose());
      ownedGroups.forEach((grp) => disposeThreeGroup(grp));
    };
  }, [
    compareLayout,
    compareVersion,
    geometry,
    texturedScene,
    printability?.silhouetteIoU,
    smartCompressExport,
    rebindTexturedSceneForGeometry,
    showToast,
  ]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#090D16] text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Top Studio Header — Clean Flat Carbon & Teal */}
      <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 flex items-center justify-between gap-3 shrink-0 z-30">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-slate-900 dark:bg-teal-600 flex items-center justify-center shrink-0">
            <Printer className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold tracking-tight text-slate-900 dark:text-white truncate">
              3BStudio
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 hidden sm:block truncate">
              Fotoğraftan 2K PBR 3D Model, ComfyUI İş Akışı ve 3D Baskı Hazırlama
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Sample Gallery & Mechanical Demo Dropdown */}
          <div className="relative">
            <button
              onClick={() => setDemoMenuOpen((o) => !o)}
              className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5 transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              <span className="hidden sm:inline">Örnekler</span>
              <ChevronDown className="w-3 h-3 text-slate-500" />
            </button>
            {demoMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-80 max-h-[75vh] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl py-1.5 z-50">
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-teal-700 dark:text-teal-400">
                  Karakter Sheet Örnekleri ({CHARACTER_SAMPLE_PRESETS.length})
                </div>
                {CHARACTER_SAMPLE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => void loadCharacterSample(preset)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 flex items-center gap-2.5 transition"
                  >
                    <img
                      src={preset.assetPath}
                      alt={preset.title}
                      className="w-10 h-10 rounded-md object-cover border border-slate-200 dark:border-slate-700 shrink-0 bg-slate-100 dark:bg-slate-950"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold truncate">{preset.title}</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                        {preset.subtitle}
                      </div>
                    </div>
                  </button>
                ))}
                <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Mekanik & Figür Örnekleri ({MECHANICAL_DEMO_PRESETS.length})
                </div>
                {MECHANICAL_DEMO_PRESETS.map((demo) => (
                  <button
                    key={demo.id}
                    type="button"
                    onClick={() => void loadDemo(demo.id)}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 transition"
                  >
                    <div className="font-semibold">{demo.title}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">{demo.subtitle}</div>
                  </button>
                ))}
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
            className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5 transition"
          >
            <FolderOpen className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            <span className="hidden md:inline">3D İçe Aktar</span>
          </button>

          {/* Android QR Pairing */}
          <button
            onClick={openQrScanner}
            className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500 text-xs font-semibold text-white flex items-center gap-1.5 transition"
          >
            <QrCode className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Android QR</span>
          </button>

          {/* Light / Dark Theme Toggle */}
          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 transition"
            title={theme === 'light' ? 'Koyu temaya geç' : 'Açık temaya geç'}
            aria-label={theme === 'light' ? 'Koyu temaya geç' : 'Açık temaya geç'}
          >
            {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Toast Notification Bar */}
      {toast && (
        <div
          className={`px-4 py-2 text-xs flex items-center justify-between border-b ${
            toast.type === 'err'
              ? 'bg-rose-50 dark:bg-rose-950/70 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
              : toast.type === 'ok'
                ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                : 'bg-teal-50 dark:bg-teal-950/60 border-teal-200 dark:border-teal-800 text-teal-900 dark:text-teal-200'
          }`}
        >
          <span>{toast.text}</span>
          <button
            onClick={() => setToast(null)}
            className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white ml-4 font-medium"
          >
            Kapat
          </button>
        </div>
      )}

      {/* Main 3-Column Studio Workspace */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 p-3 overflow-hidden">
        {/* LEFT PANEL: Photos, Background Removal & 4 Reconstruction Engines */}
        <section className="lg:col-span-4 xl:col-span-3 bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 flex flex-col gap-3.5 overflow-y-auto max-h-[calc(100vh-5.2rem)]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Camera className="w-4 h-4 text-teal-600 dark:text-teal-400" />
              1. Fotoğraflar ({loadedPhotoCount}/9)
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                {cleanedPhotoCount} temiz
              </span>
              {(loadedPhotoCount > 0 || faceCloseUp) && (
                <button
                  type="button"
                  onClick={clearAllPhotos}
                  disabled={isBusy}
                  className="px-2 py-0.5 rounded bg-rose-50 hover:bg-rose-100 dark:bg-rose-500/15 dark:hover:bg-rose-500/25 border border-rose-200 dark:border-rose-500/40 text-[10px] font-semibold text-rose-700 dark:text-rose-200 flex items-center gap-1 transition disabled:opacity-40"
                >
                  <Trash2 className="w-3 h-3" />
                  Temizle
                </button>
              )}
            </div>
          </div>

          {/* Multi-photo drag & drop */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void autoAssignPhotos(e.dataTransfer.files);
            }}
            className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 p-2.5 flex items-center justify-between gap-2"
          >
            <span className="text-[10px] text-slate-600 dark:text-slate-400 flex-1">
              Çoklu fotoğrafı sürükleyin — açılara otomatik atanır.
            </span>
            <label className="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500 text-white text-[11px] font-semibold cursor-pointer transition flex items-center gap-1">
              <Upload className="w-3.5 h-3.5" />
              Yükle
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

          {/* Character Sheet & Photogrammetry Booth */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => setSheetOpen(true)}
              className="py-2 px-2 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-800 dark:text-slate-100 flex items-center justify-center gap-1.5 transition"
            >
              <Layers className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              Karakter Sheet
            </button>
            <button
              onClick={() => setBoothOpen(true)}
              className="py-2 px-2 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-800 dark:text-slate-100 flex items-center justify-center gap-1.5 transition"
            >
              <Camera className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              Kabin (8-16 Poz)
            </button>
          </div>

          {/* Face Close-Up Slot */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-2 flex items-center gap-2">
            {faceCloseUp ? (
              <img
                src={faceCloseUp}
                alt="Yüz yakın çekim"
                className="w-11 h-11 rounded-md object-cover border border-slate-300 dark:border-slate-700 shrink-0"
              />
            ) : (
              <div className="w-11 h-11 rounded-md border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center shrink-0">
                <ScanFace className="w-4.5 h-4.5 text-teal-600 dark:text-teal-400" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-200">
                {faceCloseUp ? 'Yüz portresi hazır' : 'Yüz yakın çekim (opsiyonel)'}
              </div>
              <div className="text-[9px] text-slate-500 dark:text-slate-400 leading-snug">
                2K PBR ön yarımküre kafa dokusuna yüksek netlikte işlenir.
              </div>
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button
                type="button"
                onClick={() => faceInputRef.current?.click()}
                className="px-2 py-1 rounded bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-[10px] font-semibold text-slate-800 dark:text-slate-200 transition"
              >
                {faceCloseUp ? 'Değiştir' : 'Ekle'}
              </button>
              {faceCloseUp && (
                <button
                  type="button"
                  onClick={() => setFaceCloseUp(null)}
                  className="px-2 py-0.5 rounded text-[10px] text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 transition"
                >
                  Kaldır
                </button>
              )}
            </div>
            <input
              ref={faceInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFaceUpload(f);
                e.target.value = '';
              }}
            />
          </div>

          {/* 5 Cardinal Angle Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-2">
            {views
              .filter((v) => CARDINAL_ANGLES.includes(v.angle))
              .map((item) => (
                <div
                  key={item.angle}
                  className={`relative rounded-lg border p-2 flex flex-col gap-1.5 transition ${
                    item.cleanedDataUrl
                      ? 'border-emerald-400/70 dark:border-emerald-500/40 bg-white dark:bg-slate-950/80'
                      : item.originalDataUrl
                        ? 'border-teal-400/70 dark:border-teal-500/40 bg-white dark:bg-slate-950/80'
                        : 'border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/40 hover:border-slate-400 dark:hover:border-slate-500'
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">{item.label}</span>
                    {item.originalDataUrl && (
                      <button
                        onClick={() => clearAngle(item.angle)}
                        className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                        title="Kaldır"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {item.originalDataUrl ? (
                    <>
                      <div className="h-20 rounded-md overflow-hidden checkerboard-bg flex items-center justify-center relative border border-slate-200 dark:border-slate-800">
                        <img
                          src={item.cleanedDataUrl || item.originalDataUrl}
                          alt={item.label}
                          className="max-h-full max-w-full object-contain"
                        />
                        {item.cleanedDataUrl && (
                          <span className="absolute bottom-1 right-1 bg-emerald-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
                            TEMİZ
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => setEditingAngle(item.angle)}
                        className="w-full py-1 rounded bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-[10px] font-medium text-slate-800 dark:text-slate-200 transition"
                      >
                        Maske Düzenle
                      </button>
                    </>
                  ) : (
                    <label className="h-20 flex flex-col items-center justify-center cursor-pointer text-center text-slate-500 hover:text-teal-700 dark:hover:text-teal-400 transition px-1">
                      <Upload className="w-4 h-4 mb-1" />
                      <span className="text-[10px]">Fotoğraf Seç</span>
                      {symmetricSideMirror &&
                        ((item.angle === 'left' && views.some((v) => v.angle === 'right' && Boolean(v.originalDataUrl))) ||
                          (item.angle === 'right' && views.some((v) => v.angle === 'left' && Boolean(v.originalDataUrl)))) && (
                          <span className="mt-0.5 text-[9px] font-semibold text-teal-700 dark:text-teal-400">
                            Simetrik aynalanır
                          </span>
                        )}
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

          {/* 3/4 Diagonal Angles */}
          {(() => {
            const diagonalItems = views.filter((v) => DIAGONAL_ANGLES.includes(v.angle));
            const diagonalLoaded = diagonalItems.filter((v) => Boolean(v.originalDataUrl)).length;
            return (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowDiagonalAngles((o) => !o)}
                  className="w-full px-2.5 py-2 flex items-center justify-between text-[11px] font-semibold text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white transition"
                >
                  <span className="flex items-center gap-1.5">
                    <span>3/4 Ara Açılar (45°–315°)</span>
                    <span className="text-[10px] font-mono text-teal-700 dark:text-teal-400 tabular-nums">
                      {diagonalLoaded}/4
                    </span>
                  </span>
                  {showDiagonalAngles ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                {showDiagonalAngles && (
                  <div className="grid grid-cols-2 gap-2 p-2 pt-1 border-t border-slate-200 dark:border-slate-800">
                    {diagonalItems.map((item) => (
                      <div
                        key={item.angle}
                        className={`relative rounded-lg border p-2 flex flex-col gap-1.5 transition ${
                          item.cleanedDataUrl
                            ? 'border-emerald-400/70 dark:border-emerald-500/40 bg-white dark:bg-slate-950'
                            : item.originalDataUrl
                              ? 'border-teal-400/70 dark:border-teal-500/40 bg-white dark:bg-slate-950'
                              : 'border-dashed border-slate-300 dark:border-slate-700 bg-white/50 dark:bg-slate-950/40'
                        }`}
                      >
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="font-semibold text-slate-800 dark:text-slate-200">{item.label}</span>
                          {item.originalDataUrl && (
                            <button
                              onClick={() => clearAngle(item.angle)}
                              className="text-slate-400 hover:text-rose-600"
                              title="Kaldır"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                        {item.originalDataUrl ? (
                          <>
                            <div className="h-16 rounded overflow-hidden checkerboard-bg flex items-center justify-center relative border border-slate-200 dark:border-slate-800">
                              <img
                                src={item.cleanedDataUrl || item.originalDataUrl}
                                alt={item.label}
                                className="max-h-full max-w-full object-contain"
                              />
                            </div>
                            <button
                              onClick={() => setEditingAngle(item.angle)}
                              className="w-full py-1 rounded bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-[10px] text-slate-800 dark:text-slate-200 transition"
                            >
                              Maske Düzenle
                            </button>
                          </>
                        ) : (
                          <label className="h-16 flex flex-col items-center justify-center cursor-pointer text-center text-slate-500 hover:text-teal-700 dark:hover:text-teal-400 transition">
                            <Upload className="w-3.5 h-3.5 mb-0.5" />
                            <span className="text-[9px]">3/4 Açı Ekle</span>
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
                )}
              </div>
            );
          })()}

          {/* Step 2: Background Cleanup */}
          <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                <Wand2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                2. Arkaplan Temizleme
              </span>
              <div className="flex rounded-md bg-white dark:bg-slate-900 p-0.5 border border-slate-200 dark:border-slate-800 text-[10px]">
                <button
                  onClick={() => setBgMode('fast')}
                  className={`px-2 py-0.5 rounded transition ${
                    bgMode === 'fast'
                      ? 'bg-slate-900 dark:bg-teal-600 text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Hızlı
                </button>
                <button
                  onClick={() => setBgMode('ai')}
                  className={`px-2 py-0.5 rounded transition ${
                    bgMode === 'ai'
                      ? 'bg-slate-900 dark:bg-teal-600 text-white font-semibold'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  AI
                </button>
              </div>
            </div>
            <button
              onClick={() => cleanAllBackgrounds()}
              disabled={isBusy || loadedPhotoCount === 0}
              className="w-full py-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-xs font-semibold text-slate-900 dark:text-white flex items-center justify-center gap-1.5 transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              Tüm Arkaplanları Temizle
            </button>
          </div>

          {/* Step 3: 4 Reconstruction Engines */}
          <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-3">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              3. 3D Üretim Motoru
            </div>

            <div className="grid grid-cols-2 gap-1 bg-white dark:bg-slate-900 p-1 rounded-lg border border-slate-200 dark:border-slate-800 text-[11px]">
              <button
                onClick={() => setEngineTab('offline')}
                className={`py-1.5 rounded-md font-medium flex items-center justify-center gap-1 transition ${
                  engineTab === 'offline'
                    ? 'bg-slate-900 dark:bg-teal-600 text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Zap className="w-3.5 h-3.5" /> Yerel 2K PBR
              </button>
              <button
                onClick={() => setEngineTab('cloud')}
                className={`py-1.5 rounded-md font-medium flex items-center justify-center gap-1 transition ${
                  engineTab === 'cloud'
                    ? 'bg-slate-900 dark:bg-teal-600 text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Cloud className="w-3.5 h-3.5" /> Bulut AI
              </button>
              <button
                onClick={() => setEngineTab('comfy')}
                className={`py-1.5 rounded-md font-medium flex items-center justify-center gap-1 transition ${
                  engineTab === 'comfy'
                    ? 'bg-slate-900 dark:bg-teal-600 text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Cpu className="w-3.5 h-3.5" /> ComfyUI GPU
              </button>
              <button
                onClick={() => setEngineTab('cad')}
                className={`py-1.5 rounded-md font-medium flex items-center justify-center gap-1 transition ${
                  engineTab === 'cad'
                    ? 'bg-slate-900 dark:bg-teal-600 text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Code2 className="w-3.5 h-3.5" /> Text-CAD
              </button>
            </div>

            {engineTab === 'offline' ? (
              <div className="space-y-2.5 text-xs">
                {/* Konu Modu Seçici: Tam Karakter · Kafa Büstü · Yüz Maskesi */}
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Konu Modu</div>
                  <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setSubjectMode('character')}
                      className={`py-1.5 px-1 rounded-md font-semibold flex items-center justify-center gap-1 transition ${
                        subjectMode === 'character'
                          ? 'bg-slate-900 dark:bg-teal-600 text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <User className="w-3 h-3 shrink-0" />
                      <span>Tam Model</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSubjectMode('head-bust')}
                      className={`py-1.5 px-1 rounded-md font-semibold flex items-center justify-center gap-1 transition ${
                        subjectMode === 'head-bust'
                          ? 'bg-slate-900 dark:bg-teal-600 text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <ScanFace className="w-3 h-3 shrink-0" />
                      <span>Kafa Büstü</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSubjectMode('face-mask')}
                      className={`py-1.5 px-1 rounded-md font-semibold flex items-center justify-center gap-1 transition ${
                        subjectMode === 'face-mask'
                          ? 'bg-slate-900 dark:bg-teal-600 text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <Layers className="w-3 h-3 shrink-0" />
                      <span>Yüz Maskesi</span>
                    </button>
                  </div>
                </div>

                {/* Smart Subject Routing Card (Tam Model modunda) */}
                {subjectMode === 'character' && subjectAdvice && (
                  <div className="rounded-lg border border-teal-200 dark:border-teal-800/70 bg-teal-50/70 dark:bg-teal-950/30 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-teal-900 dark:text-teal-200 flex items-center gap-1">
                        <Compass className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                        {subjectAdvice.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          handleSelectProfile(subjectAdvice.recommendedProfile);
                          setEnablePedestal(subjectAdvice.recommendPedestal);
                          showToast('info', `Önerilen profil uygulandı: ${QUALITY_PROFILES[subjectAdvice.recommendedProfile].name}`);
                        }}
                        className="text-[10px] font-semibold text-teal-700 dark:text-teal-300 hover:underline shrink-0"
                      >
                        Öneriyi Uygula
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-600 dark:text-slate-400 leading-snug">
                      {subjectAdvice.reason}
                    </p>
                  </div>
                )}

                {subjectMode === 'head-bust' ? (
                  <div className="space-y-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5">
                    <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">
                      Kafa Büstü Ayarları (Otomatik Kafa + Omuz Kırpma)
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-600 dark:text-slate-400">
                        <span>Büst Yüksekliği</span>
                        <span className="font-mono font-semibold text-slate-900 dark:text-teal-400">{bustHeightMm} mm</span>
                      </div>
                      <input
                        type="range"
                        min={60}
                        max={200}
                        step={5}
                        value={bustHeightMm}
                        onChange={(e) => setBustHeightMm(Number(e.target.value))}
                        className="w-full accent-teal-600"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-600 dark:text-slate-400">
                        <span>Yüz Rölyef Derinliği</span>
                        <span className="font-mono">{bustReliefScale.toFixed(2)}×</span>
                      </div>
                      <input
                        type="range"
                        min={0.6}
                        max={1.6}
                        step={0.05}
                        value={bustReliefScale}
                        onChange={(e) => setBustReliefScale(Number(e.target.value))}
                        className="w-full accent-teal-600"
                      />
                    </div>
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={bustIncludePlinth}
                        onChange={(e) => setBustIncludePlinth(e.target.checked)}
                        className="accent-teal-600"
                      />
                      <span>İki kademeli heykel büst kaidesi (Y=0)</span>
                    </label>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                      Tam boy karakter fotoğrafı yükleseniz bile üst kafa-boyun-omuz bölgesini otomatik ayırıp keskin yüz kabartmalı büst oluşturur.
                    </p>
                  </div>
                ) : subjectMode === 'face-mask' ? (
                  <div className="space-y-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5">
                    <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">
                      Yüz Maskesi Ayarları (3D Baskıya Hazır)
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setMaskStyle('wearable-shell')}
                        className={`py-1.5 px-2 rounded-lg text-[10px] font-semibold border transition ${
                          maskStyle === 'wearable-shell'
                            ? 'bg-slate-900 dark:bg-teal-600 border-slate-900 dark:border-teal-600 text-white'
                            : 'bg-slate-50 dark:bg-slate-950 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        Giyilebilir Oyuk Kabuk
                      </button>
                      <button
                        type="button"
                        onClick={() => setMaskStyle('wall-relief')}
                        className={`py-1.5 px-2 rounded-lg text-[10px] font-semibold border transition ${
                          maskStyle === 'wall-relief'
                            ? 'bg-slate-900 dark:bg-teal-600 border-slate-900 dark:border-teal-600 text-white'
                            : 'bg-slate-50 dark:bg-slate-950 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        Düz Duvar Rölyefi
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-slate-600 dark:text-slate-400">Yüz Genişliği (mm)</label>
                        <input
                          type="number"
                          min={90}
                          max={210}
                          value={maskWidthMm}
                          onChange={(e) => setMaskWidthMm(Number(e.target.value))}
                          className="w-full mt-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-600 dark:text-slate-400">Et Kalınlığı (mm)</label>
                        <input
                          type="number"
                          min={2}
                          max={8}
                          step={0.2}
                          value={maskWallMm}
                          onChange={(e) => setMaskWallMm(Number(e.target.value))}
                          className="w-full mt-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-xs font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setMaskWidthMm(165)}
                        className="flex-1 py-1 rounded bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                      >
                        Yetişkin (165 mm)
                      </button>
                      <button
                        type="button"
                        onClick={() => setMaskWidthMm(135)}
                        className="flex-1 py-1 rounded bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                      >
                        Çocuk / Dekor (135 mm)
                      </button>
                    </div>
                    {maskStyle === 'wearable-shell' && (
                      <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-slate-200 dark:border-slate-800">
                        <label className="flex items-center gap-1.5 text-[10px] text-slate-700 dark:text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={maskCutEyes}
                            onChange={(e) => setMaskCutEyes(e.target.checked)}
                            className="accent-teal-600"
                          />
                          <span>Göz Açıklıkları</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-[10px] text-slate-700 dark:text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={maskStrapLoops}
                            onChange={(e) => setMaskStrapLoops(e.target.checked)}
                            className="accent-teal-600"
                          />
                          <span>Yan Kayış Kulakçığı</span>
                        </label>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Quality Profile Selector */}
                    <div className="space-y-1">
                      <label className="text-[11px] text-slate-600 dark:text-slate-400">Kalite Profili</label>
                      <select
                        value={qualityProfile}
                        onChange={(e) => handleSelectProfile(e.target.value as QualityProfileId)}
                        className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                      >
                        {(Object.keys(QUALITY_PROFILES) as QualityProfileId[]).map((id) => (
                          <option key={id} value={id}>
                            {QUALITY_PROFILES[id].name}
                          </option>
                        ))}
                      </select>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400">
                        {QUALITY_PROFILES[qualityProfile].tagline}
                      </p>
                    </div>

                    {/* Derinlik Profili & Yan Profil Yön Kilidi */}
                    <div className="grid grid-cols-2 gap-1.5">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-600 dark:text-slate-400">Hat & Derinlik Profili</label>
                        <select
                          value={depthPreset}
                          onChange={(e) => setDepthPreset(e.target.value as DepthStylePreset)}
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-900 dark:text-slate-100"
                        >
                          <option value="natural-sharp">Doğal Keskin</option>
                          <option value="slim">İnce / Düz Hat</option>
                          <option value="bold">Derin Kabartma</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-600 dark:text-slate-400">Yan Profil Yönü (+Z)</label>
                        <select
                          value={sideProfileFacing}
                          onChange={(e) => setSideProfileFacing(e.target.value as SideFacingChoice)}
                          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-900 dark:text-slate-100"
                        >
                          <option value="auto">Otomatik Kilitle</option>
                          <option value="right">Sağa Bakıyor</option>
                          <option value="left">Sola Bakıyor</option>
                        </select>
                      </div>
                    </div>

                    {/* Tek Tıkla Ön/Arka Yönü Çevir */}
                    <button
                      type="button"
                      onClick={handleSwapFrontBack}
                      disabled={isBusy}
                      className="w-full py-1.5 px-2 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 text-[10px] font-semibold text-slate-800 dark:text-slate-200 flex items-center justify-center gap-1.5 transition"
                    >
                      <ArrowLeftRight className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                      Ön / Arka Yönü Çevir (Ayak–Yüz Hizalama)
                    </button>

                    {/* SF3D Delighting, Kaynak Ayrıntıları, Tek Yan Simetri & Sergi Kaidesi */}
                    <div className="grid grid-cols-2 gap-1.5">
                      <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-[10px] text-slate-700 dark:text-slate-300 cursor-pointer" title="Tek yan profil (yalnızca Sağ veya Sol) verildiğinde karşı yana simetrik geometri ve doku uygular">
                        <input
                          type="checkbox"
                          checked={symmetricSideMirror}
                          onChange={(e) => {
                            const nextVal = e.target.checked;
                            setSymmetricSideMirror(nextVal);
                            if (baseGeoRef.current && Object.keys(colorViewsRef.current).length > 0) {
                              rebuildCachedView({ symmetricSideMirror: nextVal, rebakePbr: true });
                            }
                          }}
                          className="accent-teal-600"
                        />
                        <span>Tek Yan Simetri</span>
                      </label>
                      <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-[10px] text-slate-700 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={sourceDetailReplace}
                          onChange={() => handleToggleSourceDetailReplace()}
                          className="accent-teal-600"
                        />
                        <span>Kaynak Ayrıntıları</span>
                      </label>
                      <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-[10px] text-slate-700 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={delightAlbedo}
                          onChange={(e) => handleToggleDelight(e.target.checked)}
                          className="accent-teal-600"
                        />
                        <span>SF3D Delighting</span>
                      </label>
                      <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-[10px] text-slate-700 dark:text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={enablePedestal}
                          onChange={() => handleTogglePedestal()}
                          className="accent-teal-600"
                        />
                        <span>Sergi Kaidesi</span>
                      </label>
                      <label className="col-span-2 flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-[10px] text-slate-700 dark:text-slate-300 cursor-pointer" title="Kapalıyken 0 ağ çağrısı ile 2-4 sn yerel üretim yapılır">
                        <input
                          type="checkbox"
                          checked={useCloudDepthCalibration}
                          onChange={(e) => setUseCloudDepthCalibration(e.target.checked)}
                          className="accent-teal-600"
                        />
                        <span>Bulut AI Oran Analizi (İsteğe Bağlı)</span>
                      </label>
                    </div>

                    {/* Method Selector */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400">
                        <span>Yeniden Oluşturma Modu</span>
                        <label className="flex items-center gap-1.5 cursor-pointer text-teal-700 dark:text-teal-400 font-medium">
                          <input
                            type="checkbox"
                            checked={autoEngine}
                            onChange={(e) => setAutoEngine(e.target.checked)}
                            className="accent-teal-600"
                          />
                          Otomatik
                        </label>
                      </div>
                      <select
                        value={offlineMethod}
                        onChange={(e) => setOfflineMethod(e.target.value as OfflineMethod)}
                        disabled={autoEngine}
                        className={`w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 ${
                          autoEngine ? 'opacity-60 cursor-not-allowed' : ''
                        }`}
                      >
                        <option value="visual-hull">Çoklu Açı Silüet + 2K PBR (1–9 Fotoğraf)</option>
                        <option value="contour-extrude">Mekanik Kontur + Delik (1 Fotoğraf)</option>
                        <option value="lathe-revolve">Dönel Simetri / Torna (Düğme, Vazo)</option>
                      </select>
                    </div>

                    {qualityHints.length > 0 && (
                      <div className="space-y-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-400">
                          Çekim İpuçları
                        </div>
                        <ul className="space-y-0.5">
                          {qualityHints.map((hint, i) => (
                            <li key={i} className="text-[10px] text-slate-600 dark:text-slate-300 leading-snug">
                              • {hint}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {offlineMethod === 'visual-hull' && (
                      <div className="space-y-2">
                        <div>
                          <div className="flex justify-between text-[11px] text-slate-600 dark:text-slate-400">
                            <span>Poligon Çözünürlüğü</span>
                            <span className="font-mono text-slate-900 dark:text-teal-400 font-semibold">{hullResolution}³</span>
                          </div>
                          <input
                            type="range"
                            min={64}
                            max={192}
                            step={8}
                            value={hullResolution}
                            onChange={(e) => setHullResolution(Number(e.target.value))}
                            className="w-full accent-teal-600"
                          />
                        </div>
                        <div>
                          <div className="flex justify-between text-[11px] text-slate-600 dark:text-slate-400">
                            <span>Kenar Korumalı Yumuşatma</span>
                            <span className="font-mono">{hullSmooth} geçiş</span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={4}
                            value={hullSmooth}
                            onChange={(e) => setHullSmooth(Number(e.target.value))}
                            className="w-full accent-teal-600"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-600 dark:text-slate-400">Başlangıç Boyutu (mm)</label>
                          <input
                            type="number"
                            min={10}
                            max={220}
                            value={targetSizeMm}
                            onChange={(e) => setTargetSizeMm(Number(e.target.value))}
                            className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {offlineMethod === 'contour-extrude' && (
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-[10px] text-slate-600 dark:text-slate-400">Genişlik</label>
                          <input
                            type="number"
                            value={extrudeWidthMm}
                            onChange={(e) => setExtrudeWidthMm(Number(e.target.value))}
                            className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-600 dark:text-slate-400">Kalınlık</label>
                          <input
                            type="number"
                            value={extrudeThicknessMm}
                            onChange={(e) => setExtrudeThicknessMm(Number(e.target.value))}
                            className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-slate-600 dark:text-slate-400">Pah (mm)</label>
                          <input
                            type="number"
                            step="0.2"
                            value={extrudeBevelMm}
                            onChange={(e) => setExtrudeBevelMm(Number(e.target.value))}
                            className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono"
                          />
                        </div>
                      </div>
                    )}

                    {offlineMethod === 'lathe-revolve' && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[11px] text-slate-600 dark:text-slate-400">Yükseklik (mm)</label>
                          <input
                            type="number"
                            value={latheHeightMm}
                            onChange={(e) => setLatheHeightMm(Number(e.target.value))}
                            className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-600 dark:text-slate-400">Et Kalınlığı (mm)</label>
                          <input
                            type="number"
                            min={0}
                            step="0.5"
                            value={latheHollowMm}
                            onChange={(e) => setLatheHollowMm(Number(e.target.value))}
                            placeholder="0 = Dolu"
                            className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}

                <button
                  onClick={() => handleGenerateOffline()}
                  disabled={isBusy}
                  className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition"
                >
                  <Box className="w-4 h-4" />
                  {subjectMode === 'head-bust'
                    ? 'Yüksek Poligonlu Kafa Büstü Oluştur'
                    : subjectMode === 'face-mask'
                      ? maskStyle === 'wearable-shell'
                        ? 'Giyilebilir Yüz Maskesi Oluştur'
                        : 'Duvar Maske Rölyefi Oluştur'
                      : 'Yerel 2K PBR Model Oluştur'}
                </button>
              </div>
            ) : engineTab === 'cloud' ? (
              <div className="space-y-2.5 text-xs">
                <div>
                  <label className="text-[11px] text-slate-600 dark:text-slate-400">Bulut AI Sağlayıcısı</label>
                  <select
                    value={cloudProvider}
                    onChange={(e) => setCloudProvider(e.target.value as CloudProvider)}
                    className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100"
                  >
                    <option value="huggingface">Hugging Face ({FREE_HF_SPACES.length} Ücretsiz Space Havuzu)</option>
                    <option value="fal">fal.ai (Hunyuan3D Multi-View)</option>
                    <option value="tripo">Tripo3D v2 (Multi-View)</option>
                    <option value="meshy">Meshy AI (Multi-Image to 3D)</option>
                  </select>
                </div>

                {cloudProvider === 'huggingface' && (
                  <div className="space-y-2">
                    <div>
                      <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400">
                        <span>Ücretsiz 3D Space</span>
                        <button
                          type="button"
                          onClick={() => refreshCloudHealth(true)}
                          disabled={loadingHealth}
                          className="text-[10px] text-teal-700 dark:text-teal-400 hover:underline flex items-center gap-1"
                        >
                          <RefreshCw className={`w-3 h-3 ${loadingHealth ? 'animate-spin' : ''}`} />
                          Durumu Yenile
                        </button>
                      </div>
                      <select
                        value={FREE_HF_SPACES.some((s) => s.id === hfSpaceId) ? hfSpaceId : '__custom__'}
                        onChange={(e) => {
                          if (e.target.value !== '__custom__') setHfSpaceId(e.target.value);
                        }}
                        className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                      >
                        {FREE_HF_SPACES.map((space) => {
                          const st = formatSpaceStage(hfHealthMap[space.id]);
                          return (
                            <option key={space.id} value={space.id}>
                              {space.name} [{st.text}]
                            </option>
                          );
                        })}
                        <option value="__custom__">Özel Space ID gir...</option>
                      </select>
                      {(() => {
                        const preset = FREE_HF_SPACES.find((s) => s.id === hfSpaceId);
                        const h = hfHealthMap[hfSpaceId];
                        const st = formatSpaceStage(h);
                        return (
                          <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
                            <span className="text-slate-500 dark:text-slate-400 truncate">
                              {preset?.description ?? 'Özel Gradio 3D Space'}
                            </span>
                            <span
                              className={`font-semibold shrink-0 ${
                                st.tone === 'ok'
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : st.tone === 'warn'
                                    ? 'text-amber-700 dark:text-amber-400'
                                    : 'text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              {st.text}
                            </span>
                          </div>
                        );
                      })()}
                    </div>

                    <div>
                      <label className="text-[11px] text-slate-600 dark:text-slate-400">Space ID</label>
                      <input
                        type="text"
                        value={hfSpaceId}
                        onChange={(e) => setHfSpaceId(e.target.value)}
                        placeholder="TencentARC/Pixal3D"
                        className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>

                    <label className="flex items-start gap-1.5 text-[11px] text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={hfAutoFallback}
                        onChange={(e) => setHfAutoFallback(e.target.checked)}
                        className="accent-teal-600 mt-0.5"
                      />
                      <span className="leading-snug">
                        Otomatik Yedekleme: Açık Space’lere öncelik ver, meşgulse diğer ücretsiz Space’lere geç.
                      </span>
                    </label>
                  </div>
                )}

                <div>
                  <label className="text-[11px] text-slate-600 dark:text-slate-400">
                    {cloudProvider === 'huggingface' ? 'HF Token (İsteğe bağlı)' : 'API Anahtarı'}
                  </label>
                  <input
                    type="password"
                    value={cloudKey}
                    onChange={(e) => setCloudKey(e.target.value)}
                    placeholder={cloudProvider === 'huggingface' ? 'hf_... (opsiyonel)' : 'API anahtarını yapıştırın'}
                    className="w-full mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs"
                  />
                  <label className="flex items-center gap-1.5 mt-1.5 text-[10px] text-slate-500 dark:text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveKeyLocal}
                      onChange={(e) => setSaveKeyLocal(e.target.checked)}
                      className="accent-teal-600"
                    />
                    Anahtarı sadece bu tarayıcıda hatırla
                  </label>
                </div>

                {/* Live Cloud Job Queue Progress + Cancel */}
                {cloudJob && (
                  <div className="rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50/70 dark:bg-teal-950/30 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-semibold text-teal-900 dark:text-teal-200">
                      <span className="truncate">{cloudJob.stageLabel}</span>
                      <span className="font-mono shrink-0 ml-2">
                        %{cloudJob.percent} · {cloudJob.elapsedSec}s
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-teal-600 dark:bg-teal-400 transition-all duration-300"
                        style={{ width: `${Math.max(4, Math.min(100, cloudJob.percent))}%` }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleCancelCloudJob}
                      className="w-full py-1 rounded border border-rose-300 dark:border-rose-700 bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/50 text-[10px] font-semibold text-rose-700 dark:text-rose-300 flex items-center justify-center gap-1 transition"
                    >
                      <X className="w-3 h-3" /> Görevi İptal Et
                    </button>
                  </div>
                )}

                <button
                  onClick={handleGenerateCloud}
                  disabled={isBusy}
                  className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition"
                >
                  <Cloud className="w-4 h-4" />
                  Bulutta Yüksek Detaylı 3D Üret
                </button>
              </div>
            ) : engineTab === 'comfy' ? (
              <ComfyWorkflowPanel
                frontPhotoDataUrl={
                  views.find((v) => v.angle === 'front' && (v.cleanedDataUrl || v.originalDataUrl))?.cleanedDataUrl ||
                  views.find((v) => v.angle === 'front' && v.originalDataUrl)?.originalDataUrl ||
                  views.find((v) => v.cleanedDataUrl || v.originalDataUrl)?.cleanedDataUrl ||
                  views.find((v) => v.originalDataUrl)?.originalDataUrl ||
                  null
                }
                onComfyModelReady={handleComfyModelReady}
                onNotify={showToast}
              />
            ) : (
              <div className="space-y-2.5 text-xs">
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">Parametrik Text-to-CAD</span>
                    <span className="text-[10px] text-teal-700 dark:text-teal-400 font-mono">CSG + build123d</span>
                  </div>
                  <textarea
                    rows={3}
                    value={cadPrompt}
                    onChange={(e) => setCadPrompt(e.target.value)}
                    placeholder="Örn: 60×40 mm, 3 mm duvarlı, 4 adet M4 köşe vida delikli sensör kutusu..."
                    className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-teal-600 resize-none"
                  />
                  <label className="flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cadUseFrontRef}
                      onChange={(e) => setCadUseFrontRef(e.target.checked)}
                      className="accent-teal-600"
                    />
                    Yüklü Ön fotoğrafı CAD referansı olarak kullan
                  </label>
                </div>

                <button
                  onClick={handleGenerateCad}
                  disabled={isBusy}
                  className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500 disabled:opacity-50 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition"
                >
                  <Sparkles className="w-4 h-4" />
                  Metinden Parametrik CAD Üret
                </button>

                <div className="space-y-1.5 pt-1 border-t border-slate-200 dark:border-slate-800">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Hazır Mekanik CAD Şablonları
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {CAD_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => handleLoadCadPreset(preset.spec)}
                        className={`px-2 py-1 rounded-md text-[10px] border transition ${
                          activeCadSpec?.title === preset.spec.title
                            ? 'bg-slate-900 dark:bg-teal-600 border-slate-900 dark:border-teal-600 text-white font-semibold'
                            : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-teal-600'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {activeCadSpec && (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5 space-y-2">
                    <div>
                      <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">
                        {activeCadSpec.title}
                      </div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
                        {activeCadSpec.summary}
                      </div>
                    </div>

                    {activeCadSpec.parameters.length > 0 && (
                      <div className="space-y-1.5 pt-1 border-t border-slate-200 dark:border-slate-800">
                        {activeCadSpec.parameters.map((param) => {
                          const val = cadParamValues[param.name] ?? param.value;
                          return (
                            <div key={param.name}>
                              <div className="flex items-center justify-between text-[10px] text-slate-700 dark:text-slate-300">
                                <span>{param.label}</span>
                                <span className="font-mono text-teal-700 dark:text-teal-400 font-semibold">
                                  {val}
                                  {param.unit ? ` ${param.unit}` : ''}
                                </span>
                              </div>
                              <input
                                type="range"
                                min={param.min}
                                max={param.max}
                                step={param.step}
                                value={val}
                                onChange={(e) => handleCadParamChange(param.name, Number(e.target.value))}
                                className="w-full accent-teal-600"
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 pt-1 border-t border-slate-200 dark:border-slate-800">
                      <button
                        type="button"
                        onClick={handleDownloadBuild123d}
                        className="flex-1 py-1.5 px-2 rounded-lg bg-slate-900 dark:bg-teal-600 text-white text-[10px] font-semibold flex items-center justify-center gap-1 transition"
                      >
                        <FileCode2 className="w-3.5 h-3.5" />
                        build123d (.py)
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCadCode((v) => !v)}
                        className="py-1.5 px-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-700 dark:text-slate-300 transition"
                      >
                        {showCadCode ? 'Gizle' : 'Kodu Gör'}
                      </button>
                    </div>

                    {showCadCode && (
                      <pre className="max-h-40 overflow-auto rounded-lg bg-slate-950 p-2 text-[9px] font-mono text-slate-200 whitespace-pre-wrap">
                        {generateBuild123dCode(activeCadSpec, cadParamValues)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* RIG & ANIMASYON (Oyun GLB) — Clean Carbon & Teal */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                  Rig & Animasyon (Oyun GLB)
                </span>
                {rig && (
                  <span className="text-[10px] text-teal-700 dark:text-teal-400 font-mono">
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
                            ? 'bg-slate-900 dark:bg-teal-600 text-white font-semibold'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                        }`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={wireframeRig}
                      onChange={(e) => setWireframeRig(e.target.checked)}
                      className="accent-teal-600"
                    />
                    Wireframe göster
                  </label>
                  <div className="flex gap-1">
                    <button
                      onClick={handleDownloadAnimatedGLB}
                      className="flex-1 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500 text-white text-[11px] font-semibold transition"
                    >
                      Animasyonlu GLB İndir
                    </button>
                    <button
                      onClick={handleRemoveRig}
                      className="px-2 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-[11px] transition"
                    >
                      Kaldır
                    </button>
                  </div>
                </>
              ) : (
                <button
                  onClick={handleCreateRig}
                  disabled={!geometry || isBusy}
                  className="w-full py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-slate-900 dark:text-slate-100 text-[11px] font-semibold transition"
                >
                  Otomatik Biped Rig Oluştur
                </button>
              )}
            </div>
          </div>
        </section>

        {/* CENTER PANEL: Interactive 3D Viewport + Local3D+ Synchronized Multi-Compare */}
        <section className="lg:col-span-5 xl:col-span-6 flex flex-col gap-2 min-h-[440px]">
          <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-1 text-[11px]">
              <button
                type="button"
                onClick={() => setCompareLayout('single')}
                className={`px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5 transition ${
                  compareLayout === 'single'
                    ? 'bg-slate-900 dark:bg-teal-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Square className="w-3.5 h-3.5" />
                Tekil Sahne
              </button>
              <button
                type="button"
                disabled={!geometry}
                onClick={() => setCompareLayout('2-up')}
                className={`px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5 transition disabled:opacity-40 ${
                  compareLayout === '2-up'
                    ? 'bg-slate-900 dark:bg-teal-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Columns2 className="w-3.5 h-3.5" />
                2'li Kıyas
              </button>
              <button
                type="button"
                disabled={!geometry}
                onClick={() => setCompareLayout('4-up')}
                className={`px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5 transition disabled:opacity-40 ${
                  compareLayout === '4-up'
                    ? 'bg-slate-900 dark:bg-teal-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                4'lü Local3D+
              </button>
            </div>
            <div className="text-[10px] text-slate-500 dark:text-slate-400">
              {compareLayout === 'single'
                ? 'Tekil 3B Sahne · 4 Aşama & LOD'
                : 'Senkronize Kamera · Baz · Tam 2K · LOD 20K · LOD 5K · Oran Örtüsü'}
            </div>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            {compareLayout !== 'single' && comparePanes.length > 0 ? (
              <MultiCompareViewport
                theme={theme}
                panes={comparePanes}
                layout={compareLayout}
                displayMode={displayMode}
                showBedGrid={showBedGrid}
                autoRotate={autoRotate}
                referencePhotoUrl={comparePhotoUrl}
              />
            ) : (
              <ThreeViewport
                theme={theme}
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
                texturedScene={texturedScene}
                photogrammetryStage={photogrammetryStage}
                onPhotogrammetryStageChange={setPhotogrammetryStage}
                cameraRig={cameraRig}
                denseCloud={denseCloud}
                showCameraRig={showCameraRig}
                onToggleCameraRig={() => setShowCameraRig((v) => !v)}
                activeLod={activeLod}
                onLodChange={handleLodChange}
                comparePhotoUrl={comparePhotoUrl}
                showPhotoCompare={showPhotoCompare}
                onTogglePhotoCompare={() => setShowPhotoCompare((v) => !v)}
              />
            )}
          </div>
        </section>

        {/* RIGHT PANEL: QA Gate, Printability Doctor, Calibration, Mesh Repair & Export */}
        <section className="lg:col-span-3 bg-white dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 flex flex-col gap-3.5 overflow-y-auto max-h-[calc(100vh-5.2rem)]">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Sliders className="w-4 h-4 text-teal-600 dark:text-teal-400" />
              4. Kalite & Baskı Hazırlık
            </h2>
            {undoStack.length > 0 && (
              <button
                onClick={handleUndo}
                className="text-[11px] text-teal-700 dark:text-teal-400 hover:underline flex items-center gap-1 font-medium"
              >
                <RotateCcw className="w-3 h-3" /> Geri Al
              </button>
            )}
          </div>

          {/* Print Health Summary Card */}
          {stats ? (
            <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                {stats.isWatertight ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                    <ShieldCheck className="w-4 h-4" /> Su Geçirmez (Manifold)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                    <ShieldAlert className="w-4 h-4" /> Açık Kenar ({stats.openBoundaryEdges})
                  </span>
                )}
                <span className="text-xs font-mono font-bold text-slate-900 dark:text-teal-400">
                  %{stats.printabilityScore}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[11px] pt-1 border-t border-slate-200 dark:border-slate-800">
                <div className="text-slate-600 dark:text-slate-400">
                  Hacim: <span className="text-slate-900 dark:text-slate-100 font-mono">{stats.volumeCm3} cm³</span>
                </div>
                <div className="text-slate-600 dark:text-slate-400">
                  PLA: <span className="text-slate-900 dark:text-slate-100 font-mono">{stats.estimatedPlaGrams} g</span>
                </div>
                <div className="text-slate-600 dark:text-slate-400">
                  Süre:{' '}
                  <span className="text-slate-900 dark:text-slate-100 font-mono">
                    {stats.estimatedPrintMinutes >= 60
                      ? `${Math.floor(stats.estimatedPrintMinutes / 60)}s ${stats.estimatedPrintMinutes % 60}dk`
                      : `${stats.estimatedPrintMinutes} dk`}
                  </span>
                </div>
                <div className="text-slate-600 dark:text-slate-400">
                  Taban: <span className="text-slate-900 dark:text-slate-100 font-mono">%{stats.bedContactPct}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setDisplayMode((m) => (m === 'overhang' ? 'solid' : 'overhang'))}
                className={`w-full py-1.5 rounded-lg text-[11px] font-semibold border flex items-center justify-center gap-1.5 transition ${
                  displayMode === 'overhang'
                    ? 'bg-rose-600 border-rose-600 text-white'
                    : 'bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200'
                }`}
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                {displayMode === 'overhang' ? 'Sarkan Analizini Kapat' : 'Sarkan Yüzeyleri (>45°) Göster'}
              </button>
            </div>
          ) : (
            <div className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl p-3 text-xs text-slate-500 dark:text-slate-400">
              Model oluşturulduğunda PolyMolly QA, 3D Baskı Doktoru ve milimetrik kalibrasyon burada görünür.
            </div>
          )}

          {/* PolyMolly QA, Printability Doctor, Bambu AMS 3MF, Run History & CLI/Zephyr */}
          <StudioDiagnosticsPanel
            hasGeometry={Boolean(geometry)}
            isBusy={isBusy}
            qaReport={qaReport}
            printability={printability}
            hasPedestal={enablePedestal}
            onTogglePedestal={handleTogglePedestal}
            sourceDetailReplace={sourceDetailReplace}
            onToggleSourceDetailReplace={
              subjectMode === 'character' && Object.keys(colorViewsRef.current).length > 0
                ? handleToggleSourceDetailReplace
                : undefined
            }
            onExportObjMtlZip={handleExportObjMtlZip}
            onUpgradeToUltraPbr={
              loadedPhotoCount > 0 ? () => handleGenerateOffline('studio-ultra') : undefined
            }
            amsSlotsCount={amsSlotsCount}
            onAmsSlotsCountChange={setAmsSlotsCount}
            amsPalette={amsPalette}
            onExportMultiColor3MF={handleExportMultiColor3MF}
            runHistory={runHistory}
            onNotify={showToast}
          />

          {/* Millimeter Calibration */}
          <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">Ölçü Kalibrasyonu (mm)</span>
              <button
                onClick={() => setLockRatio((v) => !v)}
                className={`text-[10px] flex items-center gap-1 px-2 py-0.5 rounded border transition ${
                  lockRatio
                    ? 'bg-slate-900 dark:bg-teal-600 border-slate-900 dark:border-teal-600 text-white'
                    : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                {lockRatio ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                Orantı
              </button>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <div>
                <label className="text-[10px] text-slate-600 dark:text-slate-400">X Genişlik</label>
                <input
                  type="number"
                  disabled={!geometry}
                  value={dimX}
                  onChange={(e) => setDimX(e.target.value)}
                  onBlur={() => applyScaleAxis('x', dimX)}
                  onKeyDown={(e) => e.key === 'Enter' && applyScaleAxis('x', dimX)}
                  className="w-full mt-0.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-600 dark:text-slate-400">Y Derinlik</label>
                <input
                  type="number"
                  disabled={!geometry}
                  value={dimY}
                  onChange={(e) => setDimY(e.target.value)}
                  onBlur={() => applyScaleAxis('y', dimY)}
                  onKeyDown={(e) => e.key === 'Enter' && applyScaleAxis('y', dimY)}
                  className="w-full mt-0.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-slate-600 dark:text-slate-400">Z Yükseklik</label>
                <input
                  type="number"
                  disabled={!geometry}
                  value={dimZ}
                  onChange={(e) => setDimZ(e.target.value)}
                  onBlur={() => applyScaleAxis('z', dimZ)}
                  onKeyDown={(e) => e.key === 'Enter' && applyScaleAxis('z', dimZ)}
                  className="w-full mt-0.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-1">
              <button
                disabled={!geometry}
                onClick={() => runMeshOp('Tabana Oturtma', (g) => placeOnBuildPlate(g))}
                className="py-1.5 rounded bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[10px] font-medium text-slate-800 dark:text-slate-200"
              >
                Z=0
              </button>
              <button
                disabled={!geometry}
                onClick={() => runMeshOp('X +90° Döndürme', (g) => rotateMesh90(g, 'x'))}
                className="py-1.5 rounded bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[10px] text-slate-800 dark:text-slate-200 flex items-center justify-center gap-0.5"
              >
                <RotateCw className="w-3 h-3" /> X90°
              </button>
              <button
                disabled={!geometry}
                onClick={() => runMeshOp('Y +90° Döndürme', (g) => rotateMesh90(g, 'z'))}
                className="py-1.5 rounded bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[10px] text-slate-800 dark:text-slate-200 flex items-center justify-center gap-0.5"
              >
                <RotateCw className="w-3 h-3" /> Y90°
              </button>
              <button
                disabled={!geometry}
                onClick={() => runMeshOp('Z +90° Döndürme', (g) => rotateMesh90(g, 'y'))}
                className="py-1.5 rounded bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[10px] text-slate-800 dark:text-slate-200 flex items-center justify-center gap-0.5"
              >
                <RotateCw className="w-3 h-3" /> Z90°
              </button>
            </div>
          </div>

          {/* Polygon Repair & Optimization */}
          <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              Poligon Onarım & Optimizasyon
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                disabled={!geometry || isBusy}
                onClick={() => runMeshOp('Otomatik Delik Kapama', (g) => repairMesh(g))}
                className="py-1.5 px-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[11px] text-slate-800 dark:text-slate-200 flex items-center justify-center gap-1"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> Delik Kapat
              </button>
              <button
                disabled={!geometry || isBusy}
                onClick={() => runMeshOp('Katı Manifold Remesh', (g) => voxelRemesh(g, 96))}
                className="py-1.5 px-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[11px] text-slate-800 dark:text-slate-200 flex items-center justify-center gap-1"
              >
                <Layers className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" /> Katılaştır
              </button>
            </div>

            <button
              disabled={!geometry || isBusy}
              onClick={() => runMeshOp('Taubin Yumuşatma', (g) => taubinSmooth(g, 3))}
              className="w-full py-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[11px] text-slate-800 dark:text-slate-200"
            >
              Yüzeyi Yumuşat (Hacim Korumalı)
            </button>

            <div className="pt-1 border-t border-slate-200 dark:border-slate-800 space-y-1.5">
              <button
                disabled={!geometry || isBusy}
                onClick={handleUpscaleCompact}
                className="w-full py-1.5 px-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-[11px] font-semibold text-white flex items-center justify-center gap-1.5 transition"
              >
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                Max Upscale · Küçük Dosya
              </button>

              <div className="flex items-center justify-between text-[11px] text-slate-700 dark:text-slate-300 pt-1">
                <span className="font-medium">Poligon Çarpanı</span>
                <span className="font-mono text-teal-700 dark:text-teal-400 font-semibold tabular-nums">
                  {polyLevel === 0 ? 'Orijinal (×1)' : `×${4 ** polyLevel}`}
                </span>
              </div>

              <input
                type="range"
                min={0}
                max={3}
                step={1}
                disabled={!geometry || isBusy}
                value={polyLevel}
                onChange={(e) => setPolyLevel(Number(e.target.value))}
                className="w-full accent-teal-600"
              />

              {geometry && (
                <div className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center justify-between gap-2 font-mono tabular-nums">
                  <span>
                    {currentTris.toLocaleString('tr-TR')} → {projectedTris.toLocaleString('tr-TR')} △
                  </span>
                  <span>3MF ≈ {formatBytesCompact(sizeEstimate.compact3mfBytes)}</span>
                </div>
              )}

              {geometry && overBudget && (
                <div className="text-[10px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded px-2 py-1 leading-snug">
                  Otomatik bütçe sınırı: en fazla {MAX_TRIANGLES_SOFT.toLocaleString('tr-TR')} üçgen.
                </div>
              )}

              <button
                disabled={!geometry || isBusy || polyLevel === 0}
                onClick={handleApplySubdivide}
                className="w-full py-1.5 px-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[11px] font-semibold text-slate-900 dark:text-slate-100"
              >
                Poligonu Uygula
              </button>
            </div>

            <div className="pt-1 border-t border-slate-200 dark:border-slate-800 space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400">
                <span>Poligon Azaltma: %{simplifyPct}</span>
                <button
                  disabled={!geometry || isBusy}
                  onClick={() => runMeshOp('Poligon Azaltma', (g) => simplifyMesh(g, simplifyPct / 100))}
                  className="text-teal-700 dark:text-teal-400 hover:underline disabled:opacity-40 font-semibold"
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
                className="w-full accent-teal-600"
              />
            </div>

            <div className="pt-1 border-t border-slate-200 dark:border-slate-800 space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400">
                <span>Tabanı Düz Kes: {cutBottomMm} mm</span>
                <button
                  disabled={!geometry || isBusy}
                  onClick={() => runMeshOp('Alt Taban Düz Kesme', (g) => flatCutBottom(g, cutBottomMm))}
                  className="text-teal-700 dark:text-teal-400 hover:underline disabled:opacity-40 font-semibold flex items-center gap-1"
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
                className="w-full accent-teal-600"
              />
            </div>
          </div>

          {/* Export Formats */}
          <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2 mt-auto">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                5. Dışa Aktar
              </div>
              {geometry && (
                <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                  3MF ≈ {formatBytesCompact(estimateMeshBytes(currentTris).compact3mfBytes)}
                </span>
              )}
            </div>

            <label className="flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={smartCompressExport}
                onChange={(e) => setSmartCompressExport(e.target.checked)}
                className="accent-teal-600"
              />
              <span>Akıllı Sıkıştırma (Max detay · küçük dosya)</span>
            </label>

            <button
              disabled={!geometry || isBusy}
              onClick={() => handleExport('3mf')}
              className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500 disabled:opacity-40 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition"
            >
              <Download className="w-4 h-4 shrink-0" /> .3MF İndir (En Küçük · Tam Detay)
            </button>
            <div className="grid grid-cols-4 gap-1.5">
              <button
                disabled={!geometry || isBusy}
                onClick={() => handleExport('stl')}
                className="py-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[11px] font-semibold text-slate-800 dark:text-slate-100"
              >
                .STL
              </button>
              <button
                disabled={!geometry || isBusy}
                onClick={() => handleExport('obj')}
                className="py-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[11px] font-semibold text-slate-800 dark:text-slate-100"
              >
                .OBJ
              </button>
              <button
                disabled={!geometry || isBusy}
                onClick={() => handleExport('glb')}
                className="py-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 disabled:opacity-40 text-[11px] font-semibold text-slate-800 dark:text-slate-100"
              >
                .GLB
              </button>
              <button
                disabled={!geometry || isBusy}
                onClick={handleExportObjMtlZip}
                title="OBJ + MTL + 2K PBR PNG Dokular (.ZIP)"
                className="py-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-teal-500/60 dark:border-teal-600/70 disabled:opacity-40 text-[10px] font-semibold text-teal-800 dark:text-teal-300"
              >
                OBJ+ZIP
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
