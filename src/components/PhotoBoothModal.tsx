import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Camera, Loader2, Trash2, Upload, Wand2, X } from 'lucide-react';
import {
  buildBoothPlan,
  boothQualityHints,
  carvePhotoBooth,
  sampleVertexColors,
  type BoothColorSource,
  type BoothView,
} from '../engine/photoBooth';
import { dataUrlToImageData, fileToDataUrl, normalizeAndCropMask, removeBackgroundFast } from '../engine/maskProcessor';

export interface PhotoBoothResult {
  geometry: THREE.BufferGeometry;
  /** Vertex renkleri bindirildi mi (GLB/önizleme için). */
  colored: boolean;
  /** Kullanılan görünüm sayısı. */
  viewCount: number;
}

interface PhotoBoothModalProps {
  open: boolean;
  onClose: () => void;
  onGenerated: (result: PhotoBoothResult) => void;
}

interface BoothSlot {
  azimuthDeg: number;
  label: string;
  dataUrl: string | null;
}

const PLAN_OPTIONS = [8, 12, 16];
const RESOLUTION_OPTIONS = [64, 96, 128];

function makeSlots(count: number, previous: BoothSlot[]): BoothSlot[] {
  const plan = buildBoothPlan(count);
  return plan.map((p) => {
    const old = previous.find((s) => Math.abs(s.azimuthDeg - p.azimuthDeg) < 1);
    return { azimuthDeg: p.azimuthDeg, label: p.label, dataUrl: old?.dataUrl ?? null };
  });
}

export const PhotoBoothModal: React.FC<PhotoBoothModalProps> = ({ open, onClose, onGenerated }) => {
  const [planCount, setPlanCount] = useState(12);
  const [slots, setSlots] = useState<BoothSlot[]>(() => makeSlots(12, []));
  const [resolution, setResolution] = useState(96);
  const [sizeMm, setSizeMm] = useState(180);
  const [withColors, setWithColors] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef(0);
  const bulkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    runIdRef.current += 1;
    setError(null);
    setBusy(false);
    setBusyLabel('');
  }, [open]);

  const filled = useMemo(() => slots.filter((s) => Boolean(s.dataUrl)), [slots]);
  const hints = useMemo(
    () => boothQualityHints(filled.map((s) => s.azimuthDeg), planCount),
    [filled, planCount]
  );

  const changePlan = (count: number) => {
    setPlanCount(count);
    setSlots((prev) => makeSlots(count, prev));
  };

  const setSlotFile = useCallback(async (azimuthDeg: number, file: File | undefined) => {
    if (!file) return;
    const runId = runIdRef.current;
    try {
      const dataUrl = await fileToDataUrl(file);
      if (runId !== runIdRef.current) return;
      setSlots((prev) =>
        prev.map((s) => (Math.abs(s.azimuthDeg - azimuthDeg) < 1 ? { ...s, dataUrl } : s))
      );
    } catch {
      if (runId === runIdRef.current) setError('Fotoğraf okunamadı.');
    }
  }, []);

  const clearSlot = (azimuthDeg: number) => {
    setSlots((prev) =>
      prev.map((s) => (Math.abs(s.azimuthDeg - azimuthDeg) < 1 ? { ...s, dataUrl: null } : s))
    );
  };

  /** Çoklu seçimde dosyaları plan sırasıyla doldurur (0°, 30°, 60°...). */
  const handleBulk = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    list.sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true }));
    const runId = runIdRef.current;
    const loaded = await Promise.all(
      list.map(async (file) => {
        try {
          return await fileToDataUrl(file);
        } catch {
          return null;
        }
      })
    );
    if (runId !== runIdRef.current) return;
    setSlots((prev) => {
      const next = prev.map((s) => ({ ...s }));
      let cursor = 0;
      for (const url of loaded) {
        if (!url) continue;
        while (cursor < next.length && next[cursor].dataUrl) cursor += 1;
        if (cursor >= next.length) break;
        next[cursor].dataUrl = url;
        cursor += 1;
      }
      return next;
    });
  }, []);

  const handleGenerate = async () => {
    if (filled.length < 2) {
      setError('En az 2 farklı açıdan fotoğraf gerekli (8-12 önerilir).');
      return;
    }
    const runId = runIdRef.current;
    setBusy(true);
    setError(null);
    try {
      const views: BoothView[] = [];
      const colors: BoothColorSource[] = [];
      for (let i = 0; i < filled.length; i++) {
        const slot = filled[i];
        setBusyLabel(`${slot.label} işleniyor (${i + 1}/${filled.length})...`);
        const raw = await dataUrlToImageData(slot.dataUrl as string, 512);
        const cleaned = removeBackgroundFast(raw, 34);
        const { cleanedDataUrl, mask } = normalizeAndCropMask(cleaned, 256);
        views.push({ azimuthDeg: slot.azimuthDeg, mask });
        if (withColors) {
          const colorImg = await dataUrlToImageData(cleanedDataUrl, 320);
          colors.push({ azimuthDeg: slot.azimuthDeg, image: colorImg });
        }
      }
      if (runId !== runIdRef.current) return;

      setBusyLabel('Silüetler kesişimle oyuluyor (kabin)...');
      const geometry = carvePhotoBooth(views, { resolution, smoothPasses: 2, sizeMm });
      if (withColors && colors.length > 0) {
        sampleVertexColors(geometry, colors);
      }
      onGenerated({ geometry, colored: withColors && colors.length > 0, viewCount: views.length });
      onClose();
    } catch (err) {
      if (runId === runIdRef.current) {
        setError((err as Error).message || 'Kabin modeli üretilemedi.');
      }
    } finally {
      if (runId === runIdRef.current) {
        setBusy(false);
        setBusyLabel('');
      }
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[92vh] overflow-hidden bg-slate-900 border border-slate-700 rounded-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold text-slate-100">Fotogrametri Kabini</h3>
            <span className="text-[10px] text-slate-400">
              {filled.length}/{slots.length} poz
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-rose-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2.5 border-b border-slate-800 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-slate-400">Poz sayısı</span>
          <div className="flex rounded-lg bg-slate-950 p-0.5 border border-slate-800">
            {PLAN_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => changePlan(n)}
                className={`px-2 py-0.5 rounded ${
                  planCount === n ? 'bg-cyan-500 text-slate-950 font-semibold' : 'text-slate-400'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            onClick={() => bulkInputRef.current?.click()}
            className="ml-auto px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1"
          >
            <Upload className="w-3 h-3" /> Hepsini sırayla yükle
          </button>
          <input
            ref={bulkInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleBulk(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {slots.map((slot) => (
              <div
                key={slot.azimuthDeg}
                className={`relative rounded-xl border p-1.5 flex flex-col gap-1 ${
                  slot.dataUrl
                    ? 'border-cyan-500/40 bg-slate-950/80'
                    : 'border-dashed border-slate-700 bg-slate-950/40'
                }`}
              >
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-semibold text-slate-200">{slot.label}</span>
                  {slot.dataUrl && (
                    <button
                      onClick={() => clearSlot(slot.azimuthDeg)}
                      className="text-slate-500 hover:text-rose-400"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
                {slot.dataUrl ? (
                  <div className="h-20 rounded-lg overflow-hidden bg-slate-900 flex items-center justify-center">
                    <img src={slot.dataUrl} alt={slot.label} className="max-h-full max-w-full object-contain" />
                  </div>
                ) : (
                  <label className="h-20 flex flex-col items-center justify-center cursor-pointer text-center text-slate-500 hover:text-cyan-300">
                    <Upload className="w-3.5 h-3.5 mb-1" />
                    <span className="text-[9px]">Fotoğraf</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        void setSlotFile(slot.azimuthDeg, e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
            <div className="text-[10px] font-semibold text-cyan-300 uppercase tracking-wide">
              Çekim önerileri
            </div>
            <ul className="mt-1 space-y-0.5">
              {hints.map((h, i) => (
                <li key={i} className="text-[10px] text-slate-300 leading-snug">
                  • {h}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
            <label className="space-y-1">
              <span className="text-slate-400">Voksel çözünürlüğü</span>
              <select
                value={resolution}
                onChange={(e) => setResolution(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5"
              >
                {RESOLUTION_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}³ {r >= 128 ? '(yavaş, detaylı)' : r === 96 ? '(önerilen)' : '(hızlı)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-slate-400">Hedef yükseklik (mm)</span>
              <input
                type="number"
                min={20}
                max={400}
                value={sizeMm}
                onChange={(e) => setSizeMm(Math.max(20, Math.min(400, Number(e.target.value) || 180)))}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5"
              />
            </label>
            <label className="flex items-end gap-1.5 text-slate-300 pb-1">
              <input
                type="checkbox"
                checked={withColors}
                onChange={(e) => setWithColors(e.target.checked)}
                className="accent-cyan-400"
              />
              Fotoğraftan renk bindir
            </label>
          </div>

          {error && (
            <div className="text-[11px] text-rose-300 bg-rose-950/40 border border-rose-800/60 rounded-lg px-2.5 py-1.5">
              {error}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-400 flex items-center gap-1.5">
            <Wand2 className="w-3 h-3 text-cyan-400" />
            Arkaplanlar hızlı yerel algoritmayla temizlenir.
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px]"
            >
              İptal
            </button>
            <button
              onClick={() => void handleGenerate()}
              disabled={busy || filled.length < 2}
              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 disabled:opacity-40 text-slate-950 text-[11px] font-bold flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
              {busy ? busyLabel || 'Üretiliyor...' : 'Kabinden Model Üret'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
