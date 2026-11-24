import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ViewAngle } from '../engine/types';
import { cropImageData, detectSheetSlices, suggestSliceAngles } from '../engine/sheetSplit';
import { dataUrlToImageData, fileToDataUrl } from '../engine/maskProcessor';
import { X, Upload, Scissors, Check, AlertTriangle, Loader2, ImageOff } from 'lucide-react';

export interface CharacterSheetApplyItem {
  angle: ViewAngle;
  dataUrl: string;
}

interface CharacterSheetModalProps {
  open: boolean;
  onClose: () => void;
  onApply: (items: CharacterSheetApplyItem[]) => void;
}

/** Dilimleme sonucunda listelenen tek bir önizleme kaydı. */
interface SliceEntry {
  /** Sıra numarası (0 tabanlı, listede 1 olarak gösterilir). */
  index: number;
  width: number;
  height: number;
  /** Küçük önizleme (png dataUrl). */
  previewUrl: string;
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
  /** Yarış koşullarını önlemek için her dilimleme işine artan bir kimlik verilir. */
  const runIdRef = useRef(0);

  /** Geçici canvas'ları serbest bırakır. */
  const disposeCanvases = useCallback(() => {
    for (const canvas of fullCanvasesRef.current) {
      canvas.width = 0;
      canvas.height = 0;
    }
    fullCanvasesRef.current = [];
  }, []);

  /** Sheet görselini böler, önizlemeleri ve tam çözünürlüklü canvas'ları hazırlar. */
  const buildSlices = useCallback(
    async (dataUrl: string, limit: number) => {
      const runId = ++runIdRef.current;
      setBusy(true);
      setError(null);
      disposeCanvases();
      try {
        // 1200px'e indirgenmiş kopya üzerinden dilim sınırları bulunur.
        const source = await dataUrlToImageData(dataUrl, 1200);
        if (runId !== runIdRef.current) return;

        const found = detectSheetSlices(source, { maxSlices: limit });
        const entries: SliceEntry[] = [];
        const canvases: HTMLCanvasElement[] = [];

        found.forEach((slice) => {
          const crop = cropImageData(source, slice);

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

          entries.push({ index: entries.length, width: crop.width, height: crop.height, previewUrl });
        });

        if (runId !== runIdRef.current) {
          // Bu iş artık geçersiz: ürettiği canvas'ları bırak.
          for (const canvas of canvases) {
            canvas.width = 0;
            canvas.height = 0;
          }
          return;
        }

        fullCanvasesRef.current = canvases;
        setSlices(entries);
        setAngles(suggestSliceAngles(entries.length));
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

  /** Stüdyoya aktar: her dilim için tam çözünürlüklü png dataUrl üretir. */
  const handleApply = useCallback(() => {
    if (slices.length === 0) return;
    const canvases = fullCanvasesRef.current;
    if (canvases.length !== slices.length) {
      setError('Dilimler hazır değil, lütfen yeniden dilimleyin.');
      return;
    }
    const items: CharacterSheetApplyItem[] = slices.map((_entry, i) => ({
      angle: angles[i] ?? 'front',
      dataUrl: canvases[i].toDataURL('image/png'),
    }));
    onApply(items);
    onClose();
  }, [angles, onApply, onClose, slices]);

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

  // Aynı açı birden fazla dilimde seçilmişse sonraki seçimler uyarılır.
  const duplicateIndexes = new Set<number>();
  const seenAngles = new Set<ViewAngle>();
  angles.forEach((angle, i) => {
    if (seenAngles.has(angle)) duplicateIndexes.add(i);
    seenAngles.add(angle);
  });

  const selectedCount = slices.length;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Başlık */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Karakter Sheet Yükle</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Turnaround görselini yükle, dilimleri açılara eşle, stüdyoya aktar.
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
                        <span className="text-xs font-semibold text-slate-200">#{i + 1}</span>
                        <span className="text-[11px] text-slate-500 font-mono">
                          {slice.width} × {slice.height} px
                        </span>
                      </div>
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
              disabled={busy || slices.length === 0}
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
