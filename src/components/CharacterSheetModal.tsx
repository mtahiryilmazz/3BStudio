import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ViewAngle } from '../engine/types';
import {
  boxFromDragPoints,
  createCenteredDefaultBox,
  cropImageData,
  detectCharacterSheetGrid,
  moveSheetBox,
  resizeSheetBox,
  type GridDetectionMode,
  type ResizeHandle,
  type SheetAngleReason,
  type SheetCellKind,
  type SheetSlice,
} from '../engine/sheetSplit';
import { dataUrlToImageData, fileToDataUrl } from '../engine/maskProcessor';
import { detectFaceRegion } from '../engine/faceDetect';
import {
  X,
  Upload,
  Scissors,
  Check,
  AlertTriangle,
  Loader2,
  ImageOff,
  ScanFace,
  Grid,
  Eye,
  EyeOff,
  Trash2,
  Plus,
  MousePointer2,
  SquareDashed,
  User,
} from 'lucide-react';

export interface CharacterSheetApplyItem {
  angle: ViewAngle;
  dataUrl: string;
}

export interface CharacterSheetApplyOptions {
  autoCleanBackground?: boolean;
}

interface CharacterSheetModalProps {
  open: boolean;
  onClose: () => void;
  initialSheetUrl?: string | null;
  initialSheetName?: string | null;
  onApply: (
    items: CharacterSheetApplyItem[],
    faceDataUrl: string | null,
    options?: CharacterSheetApplyOptions
  ) => void;
}

/** Dilimleme veya manuel ekleme sonucunda listelenen tek bir kutu kaydı. */
interface SliceEntry {
  id: number;
  width: number;
  height: number;
  /** Analiz koordinatlarındaki kırpma kutusu (overlay çizimi ve düzenleme için). */
  box: SheetSlice;
  /** Çerçeve kesme uygulandıysa true. */
  frameStripped: boolean;
  previewUrl: string;
  kind: SheetCellKind;
  faceConfidence: number;
  suggestionReason: SheetAngleReason | 'manuel kutu';
  angle: ViewAngle;
  excluded: boolean;
  excludeReason?: string;
}

interface GridOverlayMeta {
  width: number;
  height: number;
  mode: GridDetectionMode;
  horizontalLines: number[];
  verticalLines: number[];
}

type ToolMode = 'select' | 'draw';

type PointerInteraction =
  | {
      type: 'move';
      pointerId: number;
      sliceId: number;
      startClientX: number;
      startClientY: number;
      originBox: SheetSlice;
    }
  | {
      type: 'resize';
      pointerId: number;
      sliceId: number;
      handle: ResizeHandle;
      startClientX: number;
      startClientY: number;
      originBox: SheetSlice;
    }
  | {
      type: 'draw';
      pointerId: number;
      startX: number;
      startY: number;
      currentX: number;
      currentY: number;
    };

const ANGLE_LABELS: Record<ViewAngle, string> = {
  front: 'Ön (0°)',
  frontRight: 'Ön-Sağ (45°)',
  right: 'Sağ (90°)',
  backRight: 'Arka-Sağ (135°)',
  back: 'Arka (180°)',
  backLeft: 'Arka-Sol (225°)',
  left: 'Sol (270°)',
  frontLeft: 'Ön-Sol (315°)',
  top: 'Üstten',
};

const ANGLE_SHORT: Record<ViewAngle, string> = {
  front: 'Ön 0°',
  frontRight: 'Ön-Sağ 45°',
  right: 'Sağ 90°',
  backRight: 'Arka-Sağ 135°',
  back: 'Arka 180°',
  backLeft: 'Arka-Sol 225°',
  left: 'Sol 270°',
  frontLeft: 'Ön-Sol 315°',
  top: 'Üst',
};

const ANGLE_ORDER: ViewAngle[] = [
  'front',
  'frontRight',
  'right',
  'backRight',
  'back',
  'backLeft',
  'left',
  'frontLeft',
  'top',
];

const HANDLE_SPECS: Array<{
  handle: ResizeHandle;
  positionClass: string;
  cursorClass: string;
}> = [
  { handle: 'nw', positionClass: '-top-1.5 -left-1.5', cursorClass: 'cursor-nwse-resize' },
  { handle: 'n', positionClass: '-top-1.5 left-1/2 -translate-x-1/2', cursorClass: 'cursor-ns-resize' },
  { handle: 'ne', positionClass: '-top-1.5 -right-1.5', cursorClass: 'cursor-nesw-resize' },
  { handle: 'e', positionClass: 'top-1/2 -right-1.5 -translate-y-1/2', cursorClass: 'cursor-ew-resize' },
  { handle: 'se', positionClass: '-bottom-1.5 -right-1.5', cursorClass: 'cursor-nwse-resize' },
  { handle: 's', positionClass: '-bottom-1.5 left-1/2 -translate-x-1/2', cursorClass: 'cursor-ns-resize' },
  { handle: 'sw', positionClass: '-bottom-1.5 -left-1.5', cursorClass: 'cursor-nesw-resize' },
  { handle: 'w', positionClass: 'top-1/2 -left-1.5 -translate-y-1/2', cursorClass: 'cursor-ew-resize' },
];

const MAX_SLICE_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 12];
const PREVIEW_MAX_DIM = 220;

function pickNextUnusedAngle(entries: SliceEntry[]): ViewAngle {
  const used = new Set<ViewAngle>();
  for (const e of entries) {
    if (e.kind === 'figure' && !e.excluded) used.add(e.angle);
  }
  return ANGLE_ORDER.find((a) => !used.has(a)) ?? 'front';
}

export const CharacterSheetModal: React.FC<CharacterSheetModalProps> = ({
  open,
  onClose,
  initialSheetUrl,
  initialSheetName,
  onApply,
}) => {
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [slices, setSlices] = useState<SliceEntry[]>([]);
  const [activeSliceId, setActiveSliceId] = useState<number | null>(null);
  const [overlayMeta, setOverlayMeta] = useState<GridOverlayMeta | null>(null);
  const [toolMode, setToolMode] = useState<ToolMode>('select');
  const [drawDraft, setDrawDraft] = useState<SheetSlice | null>(null);
  const [isDraggingBox, setIsDraggingBox] = useState(false);

  const [maxSlices, setMaxSlices] = useState<number>(12);
  const [stripFrames, setStripFrames] = useState<boolean>(true);
  const [focusedIsolation, setFocusedIsolation] = useState<boolean>(true);
  const [autoCleanBg, setAutoCleanBg] = useState<boolean>(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fullCanvasesMapRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const fullResRef = useRef<ImageData | null>(null);
  const fallbackFaceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const overlayStageRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const nextIdRef = useRef(1);
  const slicesRef = useRef<SliceEntry[]>([]);
  slicesRef.current = slices;

  const [selectedFaceId, setSelectedFaceId] = useState<number | null>(null);
  const [facePreviewUrl, setFacePreviewUrl] = useState<string | null>(null);
  const [faceConfidence, setFaceConfidence] = useState(0);
  const [faceEnabled, setFaceEnabled] = useState(true);
  const runIdRef = useRef(0);

  const disposeCanvases = useCallback(() => {
    for (const canvas of fullCanvasesMapRef.current.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
    fullCanvasesMapRef.current.clear();
    if (fallbackFaceCanvasRef.current) {
      fallbackFaceCanvasRef.current.width = 0;
      fallbackFaceCanvasRef.current.height = 0;
      fallbackFaceCanvasRef.current = null;
    }
  }, []);

  /** Bellekteki tam çözünürlüklü kaynaktan tek bir kutuyu kırpıp tam canvas + önizleme üretir. */
  const renderCropFromFullRes = useCallback(
    (box: SheetSlice, meta: GridOverlayMeta): { canvas: HTMLCanvasElement; previewUrl: string; width: number; height: number } | null => {
      const fullRes = fullResRef.current;
      if (!fullRes) return null;
      const scaleX = fullRes.width / Math.max(1, meta.width);
      const scaleY = fullRes.height / Math.max(1, meta.height);

      const crop = cropImageData(fullRes, {
        x: Math.round(box.x * scaleX),
        y: Math.round(box.y * scaleY),
        width: Math.max(4, Math.round(box.width * scaleX)),
        height: Math.max(4, Math.round(box.height * scaleY)),
      });

      const full = document.createElement('canvas');
      full.width = crop.width;
      full.height = crop.height;
      const fullCtx = full.getContext('2d');
      if (!fullCtx) return null;
      fullCtx.putImageData(crop, 0, 0);

      const pScale = Math.min(1, PREVIEW_MAX_DIM / Math.max(crop.width, crop.height));
      const preview = document.createElement('canvas');
      preview.width = Math.max(1, Math.round(crop.width * pScale));
      preview.height = Math.max(1, Math.round(crop.height * pScale));
      const previewCtx = preview.getContext('2d');
      if (!previewCtx) {
        full.width = 0;
        full.height = 0;
        return null;
      }
      previewCtx.drawImage(full, 0, 0, preview.width, preview.height);
      const previewUrl = preview.toDataURL('image/png');
      preview.width = 0;
      preview.height = 0;

      return { canvas: full, previewUrl, width: crop.width, height: crop.height };
    },
    []
  );

  /** Sürükleme/boyutlandırma bittiğinde tek bir dilimin tam çözünürlüklü kırpmasını günceller. */
  const refreshSliceCrop = useCallback(
    (sliceId: number, box: SheetSlice, meta: GridOverlayMeta) => {
      const rendered = renderCropFromFullRes(box, meta);
      if (!rendered) return;
      const prevCanvas = fullCanvasesMapRef.current.get(sliceId);
      if (prevCanvas) {
        prevCanvas.width = 0;
        prevCanvas.height = 0;
      }
      fullCanvasesMapRef.current.set(sliceId, rendered.canvas);

      setSlices((prev) =>
        prev.map((s) =>
          s.id === sliceId
            ? {
                ...s,
                box,
                width: rendered.width,
                height: rendered.height,
                previewUrl: rendered.previewUrl,
              }
            : s
        )
      );

      if (selectedFaceId === sliceId) {
        setFacePreviewUrl(rendered.previewUrl);
      }
    },
    [renderCropFromFullRes, selectedFaceId]
  );

  /** Kenar tabanlı Grid-Detection çalıştırır, overlay haritası ve tam çözünürlüklü kırpmaları hazırlar. */
  const buildSlices = useCallback(
    async (dataUrl: string, limit: number, shouldStripFrames: boolean, shouldFocusIsolation: boolean) => {
      const runId = ++runIdRef.current;
      setBusy(true);
      setError(null);
      disposeCanvases();
      fullResRef.current = null;
      setSelectedFaceId(null);
      setFacePreviewUrl(null);
      setFaceConfidence(0);
      setActiveSliceId(null);
      setDrawDraft(null);
      interactionRef.current = null;
      try {
        const source = await dataUrlToImageData(dataUrl, 1600);
        if (runId !== runIdRef.current) return;

        const grid = detectCharacterSheetGrid(source, {
          maxSlices: 24,
          stripFrames: shouldStripFrames,
          focusedIsolation: shouldFocusIsolation,
        });
        const figureCells = grid.cells.filter((c) => c.kind === 'figure').slice(0, limit);
        const faceCells = grid.cells.filter((c) => c.kind === 'face');
        const cells = [...figureCells, ...faceCells];

        // Tam çözünürlüklü kaynaktan kesim (4096px'e kadar detay %100 korunur ve manuel düzenleme için önbelleklenir)
        const fullRes = await dataUrlToImageData(dataUrl, 4096);
        if (runId !== runIdRef.current) return;
        fullResRef.current = fullRes;

        const meta: GridOverlayMeta = {
          width: source.width,
          height: source.height,
          mode: grid.mode,
          horizontalLines: grid.horizontalLines,
          verticalLines: grid.verticalLines,
        };

        const entries: SliceEntry[] = [];
        const usedAngles = new Set<ViewAngle>();

        cells.forEach((cell) => {
          const id = nextIdRef.current++;
          const box: SheetSlice = { x: cell.x, y: cell.y, width: cell.width, height: cell.height };
          const rendered = renderCropFromFullRes(box, meta);
          if (!rendered) return;
          fullCanvasesMapRef.current.set(id, rendered.canvas);

          const isExcluded = Boolean(cell.excludedByDefault);
          let angle: ViewAngle = cell.kind === 'face' ? 'top' : cell.suggestedAngle;
          if (cell.kind === 'figure' && !isExcluded) {
            if (usedAngles.has(angle)) {
              angle = ANGLE_ORDER.find((a) => !usedAngles.has(a)) ?? angle;
            }
            usedAngles.add(angle);
          }

          entries.push({
            id,
            width: rendered.width,
            height: rendered.height,
            box,
            frameStripped: cell.frameStripped,
            previewUrl: rendered.previewUrl,
            kind: cell.kind,
            faceConfidence: cell.faceConfidence,
            suggestionReason: cell.suggestionReason,
            angle,
            excluded: isExcluded,
            excludeReason: cell.excludeReason,
          });
        });

        if (runId !== runIdRef.current) {
          disposeCanvases();
          return;
        }

        // En yüksek güvenli aktif yüz panelini seç (önce dışlanmayanlar)
        let bestFaceEntry: SliceEntry | null = null;
        const candidateFaces = entries.filter((e) => e.kind === 'face' && !e.excluded);
        const facePool = candidateFaces.length > 0 ? candidateFaces : entries.filter((e) => e.kind === 'face');
        for (const entry of facePool) {
          if (!bestFaceEntry || entry.faceConfidence > bestFaceEntry.faceConfidence) {
            bestFaceEntry = entry;
          }
        }

        let facePreview: string | null = bestFaceEntry ? bestFaceEntry.previewUrl : null;
        let confidence = bestFaceEntry ? bestFaceEntry.faceConfidence : 0;

        if (!bestFaceEntry) {
          try {
            const region = detectFaceRegion(fullRes);
            if (region && runId === runIdRef.current) {
              const crop = cropImageData(fullRes, region);
              const faceCanvas = document.createElement('canvas');
              faceCanvas.width = crop.width;
              faceCanvas.height = crop.height;
              const ctx = faceCanvas.getContext('2d');
              if (ctx) {
                ctx.putImageData(crop, 0, 0);
                fallbackFaceCanvasRef.current = faceCanvas;
                const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(crop.width, crop.height));
                const preview = document.createElement('canvas');
                preview.width = Math.max(1, Math.round(crop.width * scale));
                preview.height = Math.max(1, Math.round(crop.height * scale));
                const pctx = preview.getContext('2d');
                if (pctx) {
                  pctx.drawImage(faceCanvas, 0, 0, preview.width, preview.height);
                  facePreview = preview.toDataURL('image/png');
                }
                preview.width = 0;
                preview.height = 0;
                confidence = region.confidence;
              }
            }
          } catch {
            fallbackFaceCanvasRef.current = null;
            facePreview = null;
          }
        }

        setOverlayMeta(meta);
        setSelectedFaceId(bestFaceEntry ? bestFaceEntry.id : null);
        setFacePreviewUrl(facePreview);
        setFaceConfidence(confidence);
        setSlices(entries);
        setActiveSliceId(entries[0]?.id ?? null);
      } catch (err) {
        if (runId !== runIdRef.current) return;
        disposeCanvases();
        fullResRef.current = null;
        setSlices([]);
        setOverlayMeta(null);
        setError(err instanceof Error ? err.message : 'Sheet dilimlenemedi.');
      } finally {
        if (runId === runIdRef.current) setBusy(false);
      }
    },
    [disposeCanvases, renderCropFromFullRes]
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('Lütfen bir görsel dosyası seçin (png, jpg, webp).');
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const dataUrl = await fileToDataUrl(file);
        setSheetUrl(dataUrl);
        setSheetName(file.name);
        setSlices([]);
        setOverlayMeta(null);
        setToolMode('select');
        await buildSlices(dataUrl, maxSlices, stripFrames, focusedIsolation);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Dosya okunamadı.');
        setBusy(false);
      }
    },
    [buildSlices, focusedIsolation, maxSlices, stripFrames]
  );

  const handleResplit = useCallback(() => {
    if (!sheetUrl) return;
    void buildSlices(sheetUrl, maxSlices, stripFrames, focusedIsolation);
  }, [buildSlices, focusedIsolation, maxSlices, sheetUrl, stripFrames]);

  const handleClearSheet = useCallback(() => {
    runIdRef.current++;
    disposeCanvases();
    fullResRef.current = null;
    interactionRef.current = null;
    setSheetUrl(null);
    setSheetName(null);
    setSlices([]);
    setOverlayMeta(null);
    setActiveSliceId(null);
    setSelectedFaceId(null);
    setFacePreviewUrl(null);
    setFaceConfidence(0);
    setDrawDraft(null);
    setToolMode('select');
    setError(null);
    setBusy(false);
  }, [disposeCanvases]);

  const handleToggleStripFrames = useCallback(
    (next: boolean) => {
      setStripFrames(next);
      if (sheetUrl) {
        void buildSlices(sheetUrl, maxSlices, next, focusedIsolation);
      }
    },
    [buildSlices, focusedIsolation, maxSlices, sheetUrl]
  );

  const handleToggleFocusedIsolation = useCallback(
    (next: boolean) => {
      setFocusedIsolation(next);
      if (sheetUrl) {
        void buildSlices(sheetUrl, maxSlices, stripFrames, next);
      }
    },
    [buildSlices, maxSlices, sheetUrl, stripFrames]
  );

  const addManualBox = useCallback(
    (box: SheetSlice) => {
      if (!overlayMeta) return;
      const rendered = renderCropFromFullRes(box, overlayMeta);
      if (!rendered) return;
      const id = nextIdRef.current++;
      fullCanvasesMapRef.current.set(id, rendered.canvas);
      const nextAngle = pickNextUnusedAngle(slicesRef.current);

      const newEntry: SliceEntry = {
        id,
        width: rendered.width,
        height: rendered.height,
        box,
        frameStripped: false,
        previewUrl: rendered.previewUrl,
        kind: 'figure',
        faceConfidence: 0,
        suggestionReason: 'manuel kutu',
        angle: nextAngle,
        excluded: false,
      };

      setSlices((prev) => [...prev, newEntry]);
      setActiveSliceId(id);
      setError(null);
    },
    [overlayMeta, renderCropFromFullRes]
  );

  const handleAddCenteredBox = useCallback(() => {
    if (!overlayMeta) return;
    const box = createCenteredDefaultBox(overlayMeta.width, overlayMeta.height, slicesRef.current.length);
    addManualBox(box);
    setToolMode('select');
  }, [addManualBox, overlayMeta]);

  const handleDeleteSlice = useCallback(
    (sliceId: number) => {
      const canvas = fullCanvasesMapRef.current.get(sliceId);
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        fullCanvasesMapRef.current.delete(sliceId);
      }

      const remaining = slicesRef.current.filter((s) => s.id !== sliceId);
      setSlices(remaining);
      if (activeSliceId === sliceId) {
        setActiveSliceId(remaining[0]?.id ?? null);
      }
      if (selectedFaceId === sliceId) {
        const nextFace = remaining.find((s) => s.kind === 'face') ?? null;
        if (nextFace) {
          setSelectedFaceId(nextFace.id);
          setFacePreviewUrl(nextFace.previewUrl);
          setFaceConfidence(nextFace.faceConfidence || 1);
        } else {
          setSelectedFaceId(null);
          setFacePreviewUrl(null);
          setFaceConfidence(0);
        }
      }
    },
    [activeSliceId, selectedFaceId]
  );

  const handleToggleKind = useCallback(
    (sliceId: number) => {
      const current = slicesRef.current.find((s) => s.id === sliceId);
      if (!current) return;
      const nextKind: SheetCellKind = current.kind === 'face' ? 'figure' : 'face';
      const nextAngle = nextKind === 'figure' ? pickNextUnusedAngle(slicesRef.current) : 'top';

      setSlices((prev) =>
        prev.map((s) =>
          s.id === sliceId
            ? {
                ...s,
                kind: nextKind,
                angle: nextKind === 'figure' && s.kind === 'face' ? nextAngle : s.angle,
                faceConfidence: nextKind === 'face' ? Math.max(0.95, s.faceConfidence) : 0,
                suggestionReason: nextKind === 'face' ? 'yüz paneli' : 'manuel kutu',
                excluded: false,
              }
            : s
        )
      );

      if (nextKind === 'face') {
        setSelectedFaceId(sliceId);
        setFacePreviewUrl(current.previewUrl);
        setFaceConfidence(Math.max(0.95, current.faceConfidence));
        setFaceEnabled(true);
      } else if (selectedFaceId === sliceId) {
        const otherFace = slicesRef.current.find((s) => s.id !== sliceId && s.kind === 'face') ?? null;
        setSelectedFaceId(otherFace ? otherFace.id : null);
        setFacePreviewUrl(otherFace ? otherFace.previewUrl : null);
        setFaceConfidence(otherFace ? otherFace.faceConfidence : 0);
      }
    },
    [selectedFaceId]
  );

  const handleAngleChange = useCallback((sliceId: number, angle: ViewAngle) => {
    setSlices((prev) => prev.map((s) => (s.id === sliceId ? { ...s, angle } : s)));
  }, []);

  const handleToggleExclude = useCallback((sliceId: number) => {
    setSlices((prev) => prev.map((s) => (s.id === sliceId ? { ...s, excluded: !s.excluded } : s)));
  }, []);

  const handleSelectFaceSlice = useCallback((sliceId: number) => {
    const entry = slicesRef.current.find((s) => s.id === sliceId);
    if (!entry) return;
    setSelectedFaceId(sliceId);
    setFacePreviewUrl(entry.previewUrl);
    setFaceConfidence(entry.faceConfidence || 1);
    setFaceEnabled(true);
  }, []);

  /** Ekran (client) koordinatını overlay analiz piksel koordinatına dönüştürür. */
  const clientToStageCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const stage = overlayStageRef.current;
      if (!stage || !overlayMeta) return null;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = ((clientX - rect.left) / rect.width) * overlayMeta.width;
      const y = ((clientY - rect.top) / rect.height) * overlayMeta.height;
      return {
        x: Math.max(0, Math.min(overlayMeta.width, x)),
        y: Math.max(0, Math.min(overlayMeta.height, y)),
      };
    },
    [overlayMeta]
  );

  const handleStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!overlayMeta || e.button !== 0) return;
      const pt = clientToStageCoords(e.clientX, e.clientY);
      if (!pt) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      interactionRef.current = {
        type: 'draw',
        pointerId: e.pointerId,
        startX: pt.x,
        startY: pt.y,
        currentX: pt.x,
        currentY: pt.y,
      };
      setDrawDraft({ x: Math.round(pt.x), y: Math.round(pt.y), width: 0, height: 0 });
      setIsDraggingBox(true);
    },
    [clientToStageCoords, overlayMeta]
  );

  const handleBoxPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, slice: SliceEntry) => {
      if (toolMode === 'draw' || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      setActiveSliceId(slice.id);
      cardRefs.current.get(slice.id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      const stage = overlayStageRef.current;
      if (stage) {
        try {
          stage.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture not supported in synthetic events
        }
      }
      interactionRef.current = {
        type: 'move',
        pointerId: e.pointerId,
        sliceId: slice.id,
        startClientX: e.clientX,
        startClientY: e.clientY,
        originBox: { ...slice.box },
      };
      setIsDraggingBox(true);
    },
    [toolMode]
  );

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, slice: SliceEntry, handle: ResizeHandle) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      setActiveSliceId(slice.id);

      const stage = overlayStageRef.current;
      if (stage) {
        try {
          stage.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if unsupported
        }
      }
      interactionRef.current = {
        type: 'resize',
        pointerId: e.pointerId,
        sliceId: slice.id,
        handle,
        startClientX: e.clientX,
        startClientY: e.clientY,
        originBox: { ...slice.box },
      };
      setIsDraggingBox(true);
    },
    []
  );

  const handleStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const inter = interactionRef.current;
      if (!inter || !overlayMeta) return;
      const stage = overlayStageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      if (inter.type === 'draw') {
        const pt = clientToStageCoords(e.clientX, e.clientY);
        if (!pt) return;
        inter.currentX = pt.x;
        inter.currentY = pt.y;
        setDrawDraft(
          boxFromDragPoints(inter.startX, inter.startY, pt.x, pt.y, overlayMeta.width, overlayMeta.height)
        );
        return;
      }

      const scaleX = overlayMeta.width / rect.width;
      const scaleY = overlayMeta.height / rect.height;
      const dx = (e.clientX - inter.startClientX) * scaleX;
      const dy = (e.clientY - inter.startClientY) * scaleY;

      const updatedBox =
        inter.type === 'move'
          ? moveSheetBox(inter.originBox, dx, dy, overlayMeta.width, overlayMeta.height)
          : resizeSheetBox(inter.originBox, inter.handle, dx, dy, overlayMeta.width, overlayMeta.height, 16);

      setSlices((prev) =>
        prev.map((s) => (s.id === inter.sliceId ? { ...s, box: updatedBox } : s))
      );
    },
    [clientToStageCoords, overlayMeta]
  );

  const finishInteraction = useCallback(
    (e?: React.PointerEvent<HTMLDivElement>) => {
      const inter = interactionRef.current;
      if (!inter || !overlayMeta) return;
      interactionRef.current = null;
      setIsDraggingBox(false);

      if (e && overlayStageRef.current) {
        try {
          if (overlayStageRef.current.hasPointerCapture(e.pointerId)) {
            overlayStageRef.current.releasePointerCapture(e.pointerId);
          }
        } catch {
          // Ignore
        }
      }

      if (inter.type === 'draw') {
        const finalBox = boxFromDragPoints(
          inter.startX,
          inter.startY,
          inter.currentX,
          inter.currentY,
          overlayMeta.width,
          overlayMeta.height
        );
        setDrawDraft(null);
        if (finalBox.width >= 14 && finalBox.height >= 14) {
          addManualBox(finalBox);
          setToolMode('select');
        }
        return;
      }

      // Bırakıldığında yalnızca değişen kutunun tam çözünürlüklü kırpmasını yenile
      const target = slicesRef.current.find((s) => s.id === inter.sliceId);
      if (target) {
        const moved =
          target.box.x !== inter.originBox.x ||
          target.box.y !== inter.originBox.y ||
          target.box.width !== inter.originBox.width ||
          target.box.height !== inter.originBox.height;
        if (moved) {
          refreshSliceCrop(target.id, target.box, overlayMeta);
        }
      }
    },
    [addManualBox, overlayMeta, refreshSliceCrop]
  );

  // Klavye kısayolları: Delete/Backspace aktif kutuyu siler, Escape çizimi iptal eder
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (interactionRef.current) {
          interactionRef.current = null;
          setDrawDraft(null);
          setIsDraggingBox(false);
        } else if (toolMode === 'draw') {
          setToolMode('select');
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && activeSliceId !== null) {
        e.preventDefault();
        handleDeleteSlice(activeSliceId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSliceId, handleDeleteSlice, open, toolMode]);

  const handleApply = useCallback(() => {
    if (slices.length === 0) return;
    const items: CharacterSheetApplyItem[] = [];
    for (const entry of slices) {
      if (entry.kind !== 'figure' || entry.excluded) continue;
      const canvas = fullCanvasesMapRef.current.get(entry.id);
      if (!canvas) continue;
      items.push({ angle: entry.angle, dataUrl: canvas.toDataURL('image/png') });
    }
    if (items.length === 0) {
      setError('Aktarılacak aktif tam boy görünüm bulunamadı.');
      return;
    }

    let faceDataUrl: string | null = null;
    if (faceEnabled) {
      const faceCanvas =
        selectedFaceId !== null
          ? fullCanvasesMapRef.current.get(selectedFaceId) ?? null
          : fallbackFaceCanvasRef.current;
      if (faceCanvas) {
        faceDataUrl = faceCanvas.toDataURL('image/png');
      }
    }

    onApply(items, faceDataUrl, { autoCleanBackground: autoCleanBg });
    onClose();
  }, [autoCleanBg, faceEnabled, onApply, onClose, selectedFaceId, slices]);

  useEffect(() => {
    if (open && initialSheetUrl && !sheetUrl) {
      setSheetUrl(initialSheetUrl);
      setSheetName(initialSheetName ?? 'Karakter Sheet');
      void buildSlices(initialSheetUrl, maxSlices, stripFrames, focusedIsolation);
    }
  }, [open, initialSheetUrl, initialSheetName, sheetUrl, buildSlices, maxSlices, stripFrames, focusedIsolation]);

  useEffect(() => {
    if (open) return;
    runIdRef.current++;
    disposeCanvases();
    fullResRef.current = null;
    interactionRef.current = null;
    setSheetUrl(null);
    setSheetName(null);
    setSlices([]);
    setOverlayMeta(null);
    setActiveSliceId(null);
    setSelectedFaceId(null);
    setFacePreviewUrl(null);
    setFaceConfidence(0);
    setDrawDraft(null);
    setToolMode('select');
    setError(null);
    setBusy(false);
    setDragOver(false);
  }, [disposeCanvases, open]);

  useEffect(() => {
    return () => {
      runIdRef.current++;
      disposeCanvases();
      fullResRef.current = null;
    };
  }, [disposeCanvases]);

  if (!open) return null;

  const duplicateIds = new Set<number>();
  const seenAngles = new Set<ViewAngle>();
  for (const entry of slices) {
    if (entry.kind === 'face' || entry.excluded) continue;
    if (seenAngles.has(entry.angle)) duplicateIds.add(entry.id);
    seenAngles.add(entry.angle);
  }

  const activeFigureCount = slices.filter((s) => s.kind === 'figure' && !s.excluded).length;
  const faceCount = slices.filter((s) => s.kind === 'face').length;
  const activeSlice = slices.find((s) => s.id === activeSliceId) ?? null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Başlık */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Grid className="w-4 h-4 text-cyan-400" />
              Karakter Sheet · Grid-Detection & Manuel Kutu Düzenleyici
            </h3>
            <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
              Otomatik algılar; görsel üzerinde kutu çizip ekleyebilir, taşıyıp boyutlandırabilir ve silebilirsiniz
              {slices.length > 0 && overlayMeta && (
                <span className="text-cyan-300">
                  {' '}
                  · {activeFigureCount} tam boy · {faceCount} yüz ·{' '}
                  {overlayMeta.mode === 'framed-grid' ? 'Çerçeveli Izgara' : 'Kenar-Bileşen'}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            aria-label="Kapat"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Gövde */}
        <div className="p-4 overflow-y-auto space-y-4">
          {/* Yükleme alanı + hızlı seçenekler */}
          <div className="flex flex-col sm:flex-row gap-3 items-stretch">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files[0];
                if (file) void handleFile(file);
              }}
              className={`flex-1 cursor-pointer rounded-xl border-2 border-dashed px-4 py-3.5 text-center transition flex flex-col justify-center ${
                dragOver
                  ? 'border-cyan-500/70 bg-cyan-500/10'
                  : 'border-slate-700 bg-slate-950/60 hover:border-cyan-500/50 hover:bg-slate-950/80'
              }`}
            >
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = '';
                }}
              />
              <Upload className="w-4 h-4 mx-auto mb-1 text-cyan-400" />
              <div className="text-xs text-slate-200 truncate">
                {sheetName ? sheetName : 'Karakter Sheet görselini buraya sürükle veya seç'}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                PNG / JPG / WEBP · 3, 5, 7, 8+ poz & çizgili ızgara otomatik algılanır
              </div>
            </label>

            <div className="sm:w-64 rounded-xl border border-slate-800 bg-slate-950/70 p-3 flex flex-col justify-center gap-2 text-xs text-slate-300">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={focusedIsolation}
                  onChange={(e) => handleToggleFocusedIsolation(e.target.checked)}
                  className="accent-teal-400"
                />
                <span>Sadece Ön/Yan/Arka + Ana Yüz</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={stripFrames}
                  onChange={(e) => handleToggleStripFrames(e.target.checked)}
                  className="accent-cyan-400"
                />
                <span>Çerçeve kes & boşluk kırp</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCleanBg}
                  onChange={(e) => setAutoCleanBg(e.target.checked)}
                  className="accent-emerald-400"
                />
                <span>Slotlarda arka planı temizle</span>
              </label>
              {sheetUrl && (
                <button
                  type="button"
                  onClick={handleClearSheet}
                  disabled={busy}
                  className="mt-0.5 w-full py-1.5 px-2.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-[11px] font-semibold text-rose-200 flex items-center justify-center gap-1.5 transition whitespace-nowrap disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Görseli Temizle
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {busy && (
            <div className="flex items-center justify-center gap-2 text-xs text-cyan-200 bg-slate-950/70 border border-slate-800 rounded-lg px-3 py-5">
              <Loader2 className="w-4 h-4 animate-spin" />
              Kenar analizi ve Grid-Detection çalışıyor...
            </div>
          )}

          {!busy && !sheetUrl && (
            <div className="flex flex-col items-center justify-center gap-1.5 text-xs text-slate-500 bg-slate-950/70 border border-slate-800 rounded-xl py-8">
              <ImageOff className="w-5 h-5" />
              Henüz sheet yüklenmedi.
            </div>
          )}

          {/* Etkileşimli Kutu Düzenleme Tuvali */}
          {!busy && sheetUrl && overlayMeta && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/90 p-3 space-y-2.5">
              {/* Üst Düzenleme Araç Çubuğu */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center rounded-lg bg-slate-900 p-0.5 border border-slate-800 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setToolMode('select')}
                      className={`px-2.5 py-1 rounded-md flex items-center gap-1.5 transition whitespace-nowrap ${
                        toolMode === 'select'
                          ? 'bg-cyan-500 text-slate-950 font-semibold'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      <MousePointer2 className="w-3.5 h-3.5" />
                      Seç / Taşı
                    </button>
                    <button
                      type="button"
                      onClick={() => setToolMode('draw')}
                      className={`px-2.5 py-1 rounded-md flex items-center gap-1.5 transition whitespace-nowrap ${
                        toolMode === 'draw'
                          ? 'bg-emerald-400 text-slate-950 font-semibold'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      <SquareDashed className="w-3.5 h-3.5" />
                      Kutu Çiz
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleAddCenteredBox}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-medium text-slate-100 flex items-center gap-1 transition whitespace-nowrap"
                  >
                    <Plus className="w-3.5 h-3.5 text-cyan-400" />
                    Kutu Ekle
                  </button>
                </div>

                <div className="text-[11px] text-slate-400 tabular-nums">
                  {drawDraft && drawDraft.width > 0
                    ? `Yeni kutu: ${drawDraft.width}×${drawDraft.height} px`
                    : activeSlice
                    ? `Seçili #${slices.findIndex((s) => s.id === activeSlice.id) + 1} · ${Math.round(activeSlice.box.width)}×${Math.round(activeSlice.box.height)} · boş alana çiz, köşeden büyüt, Del ile sil`
                    : 'Boş alanda sürükleyerek yeni kutu çizebilir veya + Kutu Ekle kullanabilirsiniz'}
                </div>
              </div>

              {/* Orijinal Sheet + Sürükle/Boyutlandır/Çiz Katmanı */}
              <div
                ref={overlayStageRef}
                onPointerDown={handleStagePointerDown}
                onPointerMove={handleStagePointerMove}
                onPointerUp={finishInteraction}
                onPointerCancel={finishInteraction}
                className={`relative mx-auto w-fit max-h-[26rem] overflow-hidden rounded-lg border border-slate-800 bg-slate-900 select-none touch-none ${
                  toolMode === 'draw' ? 'cursor-crosshair' : 'cursor-crosshair'
                }`}
              >
                <img
                  src={sheetUrl}
                  alt="Yüklenen karakter sheet"
                  referrerPolicy="no-referrer"
                  draggable={false}
                  className="block max-h-[26rem] w-auto object-contain select-none pointer-events-none"
                />

                {/* SVG Kılavuz Çizgileri ve Yeni Kutu Çizim Çerçevesi */}
                <svg
                  viewBox={`0 0 ${overlayMeta.width} ${overlayMeta.height}`}
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 w-full h-full"
                >
                  {overlayMeta.verticalLines.map((x, idx) => (
                    <line
                      key={`vl-${idx}`}
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={overlayMeta.height}
                      stroke="rgba(56, 189, 248, 0.35)"
                      strokeWidth={Math.max(1.2, overlayMeta.width * 0.0018)}
                      strokeDasharray={`${Math.max(6, overlayMeta.width * 0.008)} ${Math.max(4, overlayMeta.width * 0.006)}`}
                    />
                  ))}
                  {overlayMeta.horizontalLines.map((y, idx) => (
                    <line
                      key={`hl-${idx}`}
                      x1={0}
                      y1={y}
                      x2={overlayMeta.width}
                      y2={y}
                      stroke="rgba(56, 189, 248, 0.35)"
                      strokeWidth={Math.max(1.2, overlayMeta.width * 0.0018)}
                      strokeDasharray={`${Math.max(6, overlayMeta.width * 0.008)} ${Math.max(4, overlayMeta.width * 0.006)}`}
                    />
                  ))}

                  {drawDraft && drawDraft.width > 2 && drawDraft.height > 2 && (
                    <rect
                      x={drawDraft.x}
                      y={drawDraft.y}
                      width={drawDraft.width}
                      height={drawDraft.height}
                      fill="rgba(52, 211, 153, 0.16)"
                      stroke="#34d399"
                      strokeWidth={Math.max(2, overlayMeta.width * 0.003)}
                      strokeDasharray={`${Math.max(6, overlayMeta.width * 0.008)} ${Math.max(4, overlayMeta.width * 0.005)}`}
                    />
                  )}
                </svg>

                {/* Etkileşimli Kutu Katmanı (Taşıma + 8 Tutamaç + Üst Hızlı Kontroller) */}
                <div className="absolute inset-0 pointer-events-none">
                  {slices.map((slice, i) => {
                    const leftPct = (slice.box.x / Math.max(1, overlayMeta.width)) * 100;
                    const topPct = (slice.box.y / Math.max(1, overlayMeta.height)) * 100;
                    const widthPct = (slice.box.width / Math.max(1, overlayMeta.width)) * 100;
                    const heightPct = (slice.box.height / Math.max(1, overlayMeta.height)) * 100;
                    const isActive = activeSliceId === slice.id;
                    const isFace = slice.kind === 'face';
                    const isExc = slice.excluded;
                    const label = isFace
                      ? `#${i + 1} Yüz`
                      : `#${i + 1} ${ANGLE_SHORT[slice.angle]}`;

                    const borderStyle = isExc
                      ? 'border-slate-400/60 border-dashed bg-slate-950/50'
                      : isActive
                      ? isFace
                        ? 'border-amber-300 bg-amber-400/15 ring-1 ring-amber-300/60'
                        : 'border-emerald-400 bg-emerald-400/15 ring-1 ring-emerald-400/60'
                      : isFace
                      ? 'border-amber-400/85 bg-amber-400/10 hover:bg-amber-400/15'
                      : 'border-cyan-400/85 bg-cyan-400/10 hover:bg-cyan-400/15';

                    return (
                      <div
                        key={slice.id}
                        onPointerDown={(e) => handleBoxPointerDown(e, slice)}
                        style={{
                          left: `${leftPct}%`,
                          top: `${topPct}%`,
                          width: `${widthPct}%`,
                          height: `${heightPct}%`,
                        }}
                        className={`group absolute border-2 transition-colors ${borderStyle} ${
                          toolMode === 'draw'
                            ? 'pointer-events-none'
                            : 'pointer-events-auto cursor-move'
                        } ${isActive ? 'z-20' : 'z-10'}`}
                      >
                        {/* Üst Kutu Kontrol Şeridi: Etiket + Tam Boy/Yüz Geçişi + Sil */}
                        <div
                          onPointerDown={(e) => e.stopPropagation()}
                          className={`absolute top-0 left-0 flex items-center gap-0.5 max-w-full rounded-br border-r border-b text-[10px] leading-none shadow-sm ${
                            isExc
                              ? 'bg-slate-950/90 text-slate-400 border-slate-700'
                              : isFace
                              ? 'bg-slate-950/95 text-amber-200 border-amber-400/70'
                              : isActive
                              ? 'bg-emerald-950/95 text-emerald-100 border-emerald-400'
                              : 'bg-slate-950/90 text-cyan-100 border-cyan-400/70'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveSliceId(slice.id);
                            }}
                            className={`px-1.5 py-1 font-semibold whitespace-nowrap ${
                              isExc ? 'line-through' : ''
                            }`}
                          >
                            {label}
                          </button>

                          {toolMode === 'select' && (
                            <>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleToggleKind(slice.id);
                                }}
                                title={isFace ? 'Tam Boy görünümüne çevir' : 'Yüz yakın çekimine çevir'}
                                className={`px-1.5 py-1 border-l border-white/15 hover:bg-white/10 transition whitespace-nowrap flex items-center gap-0.5 ${
                                  isActive ? 'flex' : 'hidden group-hover:flex'
                                }`}
                              >
                                {isFace ? (
                                  <>
                                    <User className="w-2.5 h-2.5" />
                                    <span>Tam Boy</span>
                                  </>
                                ) : (
                                  <>
                                    <ScanFace className="w-2.5 h-2.5 text-amber-300" />
                                    <span>Yüz</span>
                                  </>
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteSlice(slice.id);
                                }}
                                title="Kutuyu sil"
                                aria-label={`Dilim ${i + 1} kutusunu sil`}
                                className={`px-1.5 py-1 border-l border-white/15 text-rose-300 hover:bg-rose-500/30 hover:text-white transition ${
                                  isActive ? 'flex items-center' : 'hidden group-hover:flex items-center'
                                }`}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </>
                          )}
                        </div>

                        {/* Sürükleme sırasında canlı boyut okuması */}
                        {isActive && isDraggingBox && (
                          <div className="pointer-events-none absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-slate-950/90 border border-slate-700 text-[10px] font-mono text-slate-200 tabular-nums whitespace-nowrap">
                            {Math.round(slice.box.width)}×{Math.round(slice.box.height)}
                          </div>
                        )}

                        {/* Aktif Kutuda 8 Boyutlandırma Tutamacı */}
                        {isActive && toolMode === 'select' &&
                          HANDLE_SPECS.map(({ handle, positionClass, cursorClass }) => (
                            <div
                              key={handle}
                              onPointerDown={(e) => handleResizePointerDown(e, slice, handle)}
                              className={`absolute w-3 h-3 rounded-[2px] border border-slate-950 shadow ${
                                isFace ? 'bg-amber-300' : 'bg-emerald-300'
                              } ${positionClass} ${cursorClass}`}
                              aria-label={`${handle} boyutlandırma tutamacı`}
                            />
                          ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Kırpılmış Kart Listesi */}
          {slices.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {slices.map((slice, i) => {
                const duplicate = duplicateIds.has(slice.id);
                const isExc = slice.excluded;
                const isActive = activeSliceId === slice.id;
                return (
                  <div
                    key={slice.id}
                    ref={(el) => {
                      if (el) cardRefs.current.set(slice.id, el);
                      else cardRefs.current.delete(slice.id);
                    }}
                    onClick={() => setActiveSliceId(slice.id)}
                    className={`rounded-xl p-2.5 flex gap-3 border transition cursor-pointer ${
                      isExc
                        ? 'bg-slate-950/40 border-slate-800/70 opacity-60'
                        : isActive
                        ? 'bg-slate-950 border-emerald-500/70'
                        : 'bg-slate-950/75 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="shrink-0 w-16 rounded-lg overflow-hidden border border-slate-800 bg-slate-900 flex items-center justify-center">
                      <img
                        src={slice.previewUrl}
                        alt={`Dilim ${i + 1} önizleme`}
                        referrerPolicy="no-referrer"
                        className="h-24 w-full object-contain"
                      />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-100 tabular-nums">
                          #{i + 1}
                          {slice.kind === 'face' && (
                            <span className="ml-1.5 text-[11px] font-medium text-amber-300">
                              · Yüz
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] text-slate-400 font-mono tabular-nums mr-1">
                            {slice.width}×{slice.height}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleKind(slice.id);
                            }}
                            title={slice.kind === 'face' ? 'Tam Boy yap' : 'Yüz yap'}
                            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-200 transition whitespace-nowrap"
                          >
                            {slice.kind === 'face' ? 'Tam Boy Yap' : 'Yüz Yap'}
                          </button>
                          {slice.kind === 'figure' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleExclude(slice.id);
                              }}
                              title={isExc ? 'Aktarıma dahil et' : 'Aktarımdan çıkar'}
                              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition"
                            >
                              {isExc ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5 text-cyan-400" />}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSlice(slice.id);
                            }}
                            title="Kutuyu sil"
                            className="p-1 rounded text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {slice.kind === 'face' ? (
                        <div className="space-y-1.5">
                          <div className="text-[11px] text-amber-200/90 tabular-nums">
                            Yüz yakın çekimi · güven %{Math.round((slice.faceConfidence || 1) * 100)}
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectFaceSlice(slice.id);
                            }}
                            className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition whitespace-nowrap ${
                              selectedFaceId === slice.id
                                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                                : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200'
                            }`}
                          >
                            {selectedFaceId === slice.id ? 'Aktif Yüz Kaynağı' : 'Yüz Kaynağı Seç'}
                          </button>
                        </div>
                      ) : (
                        <>
                          <select
                            value={slice.angle}
                            disabled={isExc}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => handleAngleChange(slice.id, e.target.value as ViewAngle)}
                            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500/60 disabled:opacity-50"
                            aria-label={`Dilim ${i + 1} açısı`}
                          >
                            {ANGLE_ORDER.map((angle) => (
                              <option key={angle} value={angle}>
                                {ANGLE_LABELS[angle]}
                              </option>
                            ))}
                          </select>
                          <div className="text-[11px] text-slate-400 truncate">
                            {isExc && slice.excludeReason
                              ? `Otomatik dışlandı (${slice.excludeReason})`
                              : slice.suggestionReason}
                            {slice.frameStripped ? ' · çerçeve kesildi' : ''}
                          </div>
                        </>
                      )}

                      {duplicate && !isExc && (
                        <div className="flex items-center gap-1 text-[11px] text-amber-300">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          Aynı açı başka bir dilimde de seçili.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Otomatik veya manuel yüz yakın çekimi */}
          {facePreviewUrl && (
            <div className="bg-slate-950/75 border border-slate-800 rounded-xl p-3 flex gap-3 items-center">
              <div className="shrink-0 w-14 h-14 rounded-lg overflow-hidden border border-slate-800 bg-slate-900 flex items-center justify-center">
                <img
                  src={facePreviewUrl}
                  alt="Yüz yakın çekim"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                  <ScanFace className="w-3.5 h-3.5 text-amber-400" /> Yüz yakın çekimi hazır
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                  Güven %{Math.round(faceConfidence * 100)} · tam çözünürlüklü kırpma
                </div>
                <label className="flex items-center gap-1.5 mt-1 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={faceEnabled}
                    onChange={(e) => setFaceEnabled(e.target.checked)}
                    className="accent-cyan-400"
                  />
                  Yüzü detay kaynağı olarak aktar
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Alt çubuk */}
        <div className="px-5 py-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-950/60">
          <div className="flex items-center gap-2">
            <select
              value={maxSlices}
              onChange={(e) => setMaxSlices(Number(e.target.value))}
              disabled={busy || !sheetUrl}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500/60 disabled:opacity-50 whitespace-nowrap"
              aria-label="En fazla dilim sayısı"
            >
              {MAX_SLICE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  En fazla {n} görünüm
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleResplit}
              disabled={busy || !sheetUrl}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5 transition whitespace-nowrap disabled:opacity-50"
            >
              <Scissors className="w-3.5 h-3.5 text-cyan-400" />
              Yeniden Algıla
            </button>
            {sheetUrl && (
              <button
                type="button"
                onClick={handleClearSheet}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-xs font-medium text-rose-200 flex items-center gap-1.5 transition whitespace-nowrap disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Temizle
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 transition whitespace-nowrap"
            >
              İptal
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={busy || activeFigureCount === 0}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 flex items-center gap-1.5 transition whitespace-nowrap disabled:opacity-40"
            >
              <Check className="w-4 h-4" />
              Slotlara Otomatik Yerleştir ({activeFigureCount})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
