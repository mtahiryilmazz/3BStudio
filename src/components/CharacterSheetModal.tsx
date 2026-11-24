import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ViewAngle } from '../engine/types';
import { cropImageData, detectSheetLayout, suggestSliceAngles } from '../engine/sheetSplit';
import type { SheetCellKind } from '../engine/sheetSplit';
import { dataUrlToImageData, fileToDataUrl } from '../engine/maskProcessor';
import { detectFaceRegion } from '../engine/faceDetect';
import { X, Upload, Scissors, Check, AlertTriangle, Loader2, ImageOff, ScanFace } from 'lucide-react';

export interface CharacterSheetApplyItem {
  angle: ViewAngle;
  dataUrl: string;
}

interface CharacterSheetModalProps {
  open: boolean;
  onClose: () => void;
  onApply: (items: CharacterSheetApplyItem[], faceDataUrl: string | null) => void;
}

/** Dilimleme sonucunda listelenen tek bir önizleme kaydı. */
interface SliceEntry {
  /** Sıra numarası (0 tabanlı, listede 1 olarak gösterilir). */
  index: number;
  width: number;
  height: number;
  /** Küçük önizleme (png dataUrl). */
  previewUrl: string;
  /** 'figure' = tam boy görünüm, 'face' = yüz yakın çekimi. */
  kind: SheetCellKind;
  /** Yüz ise algılama güveni (0..1). */
  faceConfidence: number;
}

const ANGLE_LABELS: Record<ViewAngle, string> = {
  front: 'Ön',
  right: 'Sağ',
  back: 'Arka',
  left: 'Sol',
  top: 'Üstten',
};

const ANGLE_ORDER: ViewAngle[] = ['front', 'right', 'back', 'left', 'top'];

const MAX_SLICE_OPTIONS = [2, 3, 4, 5, 6];

/** Önizleme oluştururken kullanılan en büyük kenar (piksel). */
const PREVIEW_MAX_DIM = 220;

export const CharacterSheetModal: React.FC<CharacterSheetModalProps> = ({ open, onClose, onApply }) => {
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [slices, setSlices] = useState<SliceEntry[]>([]);
  const [angles, setAngles] = useState<ViewAngle[]>([]);
  const [maxSlices, setMaxSlices] = useState<number>(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  /** Tam çözünürlüklü dilim canvas'ları — aktarımda dataUrl'e bunlardan çevrilir. */
  const fullCanvasesRef = useRef<HTMLCanvasElement[]>([]);
  /** Otomatik algılanan yüz yakın çekimi (tam çözünürlüklü). */
  const faceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [facePreviewUrl, setFacePreviewUrl] = useState<string | null>(null);
  const [faceConfidence, setFaceConfidence] = useState(0);
  const [faceEnabled, setFaceEnabled] = useState(true);
  /** Yarış koşullarını önlemek için her dilimleme işine artan bir kimlik verilir. */
  const runIdRef = useRef(0);

  /** Geçici canvas'ları serbest bırakır. */
  const disposeCanvases = useCallback(() => {
    for (const canvas of fullCanvasesRef.current) {
      canvas.width = 0;
      canvas.height = 0;
    }
    fullCanvasesRef.current = [];
    if (faceCanvasRef.current) {
      faceCanvasRef.current.width = 0;
      faceCanvasRef.current.height = 0;
      faceCanvasRef.current = null;
    }
  }, []);

  /** Sheet görselini böler, önizlemeleri ve tam çözünürlüklü canvas'ları hazırlar. */
  const buildSlices = useCallback(
    async (dataUrl: string, limit: number) => {
      const runId = ++runIdRef.current;
      setBusy(true);
      setError(null);
      disposeCanvases();
      setFacePreviewUrl(null);
      setFaceConfidence(0);
      try {
        // 1600px'e indirgenmiş kopya üzerinden 2B ızgara (satır + kolon) bulunur.
        const source = await dataUrlToImageData(dataUrl, 1600);
        if (runId !== runIdRef.current) return;

        const layout = detectSheetLayout(source, { maxSlices: 24 });
        const figureCells = layout.cells.filter((c) => c.kind === 'figure').slice(0, limit);
        const faceCells = layout.cells.filter((c) => c.kind === 'face');
        const cells = [...figureCells, ...faceCells];
        const entries: SliceEntry[] = [];
        const canvases: HTMLCanvasElement[] = [];

        // Dilimler TAM ÇÖZÜNÜRLÜKLÜ görselden kesilir (detay korunur);
        // analiz 1600px kopyada yapılır, koordinatlar ölçeklenir.
        const fullRes = await dataUrlToImageData(dataUrl, 4096);
        if (runId !== runIdRef.current) return;
        const scaleX = fullRes.width / source.width;
        const scaleY = fullRes.height / source.height;

        cells.forEach((slice) => {
          const crop = cropImageData(fullRes, {
            x: Math.round(slice.x * scaleX),
            y: Math.round(slice.y * scaleY),
            width: Math.round(slice.width * scaleX),
            height: Math.round(slice.height * scaleY),
          });

          // Tam çözünürlüklü dilim: aktarımda bu canvas kullanılır.
          const full = document.createElement('canvas');
          full.width = crop.width;
          full.height = crop.height;
          const fullCtx = full.getContext('2d');
          if (!fullCtx) throw new Error('Canvas bağlamı oluşturulamadı.');
          fullCtx.putImageData(crop, 0, 0);
          canvases.push(full);

          // Küçük önizleme.
          const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(crop.width, crop.height));
          const preview = document.createElement('canvas');
          preview.width = Math.max(1, Math.round(crop.width * scale));
          preview.height = Math.max(1, Math.round(crop.height * scale));
          const previewCtx = preview.getContext('2d');
          if (!previewCtx) throw new Error('Canvas bağlamı oluşturulamadı.');
          previewCtx.drawImage(full, 0, 0, preview.width, preview.height);
          const previewUrl = preview.toDataURL('image/png');
          // Önizleme canvas'ına artık gerek yok.
          preview.width = 0;
          preview.height = 0;

          entries.push({
            index: entries.length,
            width: crop.width,
            height: crop.height,
            previewUrl,
            kind: slice.kind,
            faceConfidence: slice.faceConfidence,
          });
        });

        if (runId !== runIdRef.current) {
          // Bu iş artık geçersiz: ürettiği canvas'ları bırak.
          for (const canvas of canvases) {
            canvas.width = 0;
            canvas.height = 0;
          }
          return;
        }

        // En güvenli yüz hücresini seç (tam çözünürlüklü canvas'ıyla).
        let faceIndex = -1;
        entries.forEach((entry, i) => {
          if (entry.kind !== 'face') return;
          if (faceIndex === -1 || entry.faceConfidence > entries[faceIndex].faceConfidence) {
            faceIndex = i;
          }
        });

        // Yüz yakın çekimi: ızgarada bulunan yüz hücresi (tam çözünürlüklü crop) önceliklidir.
        let faceCanvas: HTMLCanvasElement | null = faceIndex >= 0 ? canvases[faceIndex] : null;
        let facePreview: string | null = faceIndex >= 0 ? entries[faceIndex].previewUrl : null;
        let confidence = faceIndex >= 0 ? entries[faceIndex].faceConfidence : 0;
        if (!faceCanvas) try {
          if (runId !== runIdRef.current) {
            for (const canvas of canvases) {
              canvas.width = 0;
              canvas.height = 0;
            }
            return;
          }
          const region = detectFaceRegion(fullRes);
          if (region) {
            const crop = cropImageData(fullRes, region);
            faceCanvas = document.createElement('canvas');
            faceCanvas.width = crop.width;
            faceCanvas.height = crop.height;
            const ctx = faceCanvas.getContext('2d');
            if (ctx) {
              ctx.putImageData(crop, 0, 0);
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
          faceCanvas = null;
          facePreview = null;
        }

        const suggested = suggestSliceAngles(figureCells.length);
        const nextAngles: ViewAngle[] = cells.map((cell, i) =>
          cell.kind === 'face' ? 'top' : suggested[Math.min(i, suggested.length - 1)]
        );

        fullCanvasesRef.current = canvases;
        faceCanvasRef.current = faceCanvas;
        setFacePreviewUrl(facePreview);
        setFaceConfidence(confidence);
        setSlices(entries);
        setAngles(nextAngles);
      } catch (err) {
        if (runId !== runIdRef.current) return;
        disposeCanvases();
        setSlices([]);
        setAngles([]);
        setError(err instanceof Error ? err.message : 'Sheet dilimlenemedi.');
      } finally {
        if (runId === runIdRef.current) setBusy(false);
      }
    },
    [disposeCanvases]
  );

  /** Seçilen dosyayı state'e alır ve dilimlemeyi başlatır. */
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
        setAngles([]);
        await buildSlices(dataUrl, maxSlices);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Dosya okunamadı.');
        setBusy(false);
      }
    },
    [buildSlices, maxSlices]
  );

  /** Aynı sheet'i seçili dilim sayısıyla yeniden böler. */
  const handleResplit = useCallback(() => {
    if (!sheetUrl) return;
    void buildSlices(sheetUrl, maxSlices);
  }, [buildSlices, maxSlices, sheetUrl]);

  const handleAngleChange = useCallback((index: number, angle: ViewAngle) => {
    setAngles((prev) => prev.map((a, i) => (i === index ? angle : a)));
  }, []);

  /** Stüdyoya aktar: tam boy dilimler için tam çözünürlüklü png üretir; yüz ayrı taşınır. */
  const handleApply = useCallback(() => {
    if (slices.length === 0) return;
    const canvases = fullCanvasesRef.current;
    if (canvases.length !== slices.length) {
      setError('Dilimler hazır değil, lütfen yeniden dilimleyin.');
      return;
    }
    const items: CharacterSheetApplyItem[] = [];
    slices.forEach((entry, i) => {
      if (entry.kind !== 'figure') return;
      items.push({ angle: angles[i] ?? 'front', dataUrl: canvases[i].toDataURL('image/png') });
    });
    if (items.length === 0) {
      setError('Tam boy görünüm bulunamadı; yalnızca yüz panelleri algılandı.');
      return;
    }
    const faceDataUrl =
      faceEnabled && faceCanvasRef.current ? faceCanvasRef.current.toDataURL('image/png') : null;
    onApply(items, faceDataUrl);
    onClose();
  }, [angles, faceEnabled, onApply, onClose, slices]);

  // Kapanınca tüm geçici durumu ve canvas'ları temizle.
  useEffect(() => {
    if (open) return;
    runIdRef.current++;
    disposeCanvases();
    setSheetUrl(null);
    setSheetName(null);
    setSlices([]);
    setAngles([]);
    setError(null);
    setBusy(false);
    setDragOver(false);
  }, [disposeCanvases, open]);

  // Bileşen kaldırılırken canvas'ları serbest bırak.
  useEffect(() => {
    return () => {
      runIdRef.current++;
      disposeCanvases();
    };
  }, [disposeCanvases]);

  if (!open) return null;

  // Aynı açı birden fazla tam boy dilimde seçilmişse sonraki seçimler uyarılır.
  const duplicateIndexes = new Set<number>();
  const seenAngles = new Set<ViewAngle>();
  angles.forEach((angle, i) => {
    if (slices[i]?.kind === 'face') return;
    if (seenAngles.has(angle)) duplicateIndexes.add(i);
    seenAngles.add(angle);
  });

  const figureCount = slices.filter((s) => s.kind === 'figure').length;
  const faceCount = slices.filter((s) => s.kind === 'face').length;
  const selectedCount = figureCount;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Başlık */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Karakter Sheet Yükle</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Turnaround görselini yükle, dilimleri açılara eşle, stüdyoya aktar.
              {slices.length > 0 && (
                <span className="text-cyan-300/90">
                  {' '}
                  · {figureCount} tam boy · {faceCount} yüz
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
        <div className="p-4 overflow-y-auto space-y-3">
          {/* Sürükle-bırak / dosya seç */}
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
            className={`block cursor-pointer rounded-xl border-2 border-dashed px-4 py-5 text-center transition ${
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
            <Upload className="w-5 h-5 mx-auto mb-1.5 text-cyan-400" />
            <div className="text-xs text-slate-300">
              {sheetName ? sheetName : 'Sheet görselini buraya sürükle veya tıkla'}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Tek dosya · png / jpg / webp · front, side, back kolonları otomatik ayrılır
            </div>
          </label>

          {error && (
            <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {busy && (
            <div className="flex items-center justify-center gap-2 text-xs text-cyan-200 bg-slate-950/70 border border-slate-800 rounded-lg px-3 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              Dilimler hazırlanıyor...
            </div>
          )}

          {!busy && !sheetUrl && (
            <div className="flex flex-col items-center justify-center gap-1.5 text-xs text-slate-500 bg-slate-950/70 border border-slate-800 rounded-xl py-8">
              <ImageOff className="w-5 h-5" />
              Henüz sheet yüklenmedi.
            </div>
          )}

          {!busy && sheetUrl && slices.length === 0 && (
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-2">
              Dilim bulunamadı. "Yeniden Dilimle" ile farklı dilim sayısı deneyin.
            </div>
          )}

          {/* Dilim listesi */}
          {slices.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {slices.map((slice, i) => {
                const duplicate = duplicateIndexes.has(i);
                return (
                  <div
                    key={`slice-${slice.index}`}
                    className="bg-slate-950/70 border border-slate-800 rounded-xl p-2.5 flex gap-3"
                  >
                    <div className="shrink-0 w-16 rounded-lg overflow-hidden border border-slate-800 bg-slate-900 flex items-center justify-center">
                      <img
                        src={slice.previewUrl}
                        alt={`Dilim ${i + 1} önizleme`}
                        className="h-24 w-full object-contain"
                      />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-200">
                          #{i + 1}
                          {slice.kind === 'face' && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 text-[9px] font-bold text-cyan-300 align-middle">
                              YÜZ
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] text-slate-500 font-mono">
                          {slice.width} × {slice.height} px
                        </span>
                      </div>
                      {slice.kind === 'face' ? (
                        <div className="text-[10px] text-cyan-300/80 leading-snug">
                          Yüz yakın çekimi · güven %{Math.round(slice.faceConfidence * 100)} · tam
                          çözünürlükte saklanır
                        </div>
                      ) : (
                      <select
                        value={angles[i] ?? 'front'}
                        onChange={(e) => handleAngleChange(i, e.target.value as ViewAngle)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500/60"
                        aria-label={`Dilim ${i + 1} açısı`}
                      >
                        {ANGLE_ORDER.map((angle) => (
                          <option key={angle} value={angle}>
                            {ANGLE_LABELS[angle]}
                          </option>
                        ))}
                      </select>
                      )}
                      {duplicate && (
                        <div className="flex items-center gap-1 text-[11px] text-amber-300">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          Bu açı zaten başka bir dilimde seçili.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Otomatik yüz yakın çekimi — tam çözünürlüklü kırpma */}
          {facePreviewUrl && (
            <div className="bg-slate-950/70 border border-cyan-700/50 rounded-xl p-2.5 flex gap-3 items-center">
              <div className="shrink-0 w-16 h-16 rounded-lg overflow-hidden border border-slate-800 bg-slate-900 flex items-center justify-center">
                <img src={facePreviewUrl} alt="Yüz yakın çekim" className="h-full w-full object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-200">
                  <ScanFace className="w-3.5 h-3.5" /> Yüz yakın çekimi algılandı
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  Güven: %{Math.round(faceConfidence * 100)} · tam çözünürlüklü kırpma (detay korunur)
                </div>
                <label className="flex items-center gap-1.5 mt-1.5 text-[10px] text-slate-300 cursor-pointer">
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

        {/* Alt butonlar */}
        <div className="px-5 py-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-950/50">
          <div className="flex items-center gap-1.5">
            <select
              value={maxSlices}
              onChange={(e) => setMaxSlices(Number(e.target.value))}
              disabled={busy || !sheetUrl}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500/60 disabled:opacity-50"
              aria-label="En fazla dilim sayısı"
            >
              {MAX_SLICE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  En fazla {n} dilim
                </option>
              ))}
            </select>
            <button
              onClick={handleResplit}
              disabled={busy || !sheetUrl}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5 transition disabled:opacity-50 disabled:hover:bg-slate-800"
            >
              <Scissors className="w-3.5 h-3.5 text-cyan-400" />
              Yeniden Dilimle
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 transition"
            >
              İptal
            </button>
            <button
              onClick={handleApply}
              disabled={busy || figureCount === 0}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 flex items-center gap-1.5 transition disabled:opacity-40 disabled:hover:bg-cyan-500"
            >
              <Check className="w-4 h-4" />
              Stüdyoya Aktar ({selectedCount})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
