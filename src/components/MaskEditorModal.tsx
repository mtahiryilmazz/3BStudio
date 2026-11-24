import React, { useEffect, useRef, useState } from 'react';
import { PhotoViewItem } from '../engine/types';
import {
  dataUrlToImageData,
  loadImage,
  normalizeAndCropMask,
  removeBackgroundAI,
  removeBackgroundFast,
} from '../engine/maskProcessor';
import { X, Eraser, Brush, Sparkles, Zap, Check } from 'lucide-react';

interface MaskEditorModalProps {
  item: PhotoViewItem;
  onClose: () => void;
  onSave: (updated: PhotoViewItem) => void;
}

export const MaskEditorModal: React.FC<MaskEditorModalProps> = ({ item, onClose, onSave }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const origCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tolerance, setTolerance] = useState(item.tolerance ?? 34);
  const [tool, setTool] = useState<'erase' | 'restore'>('erase');
  const [brushSize, setBrushSize] = useState(18);
  const [isDrawing, setIsDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [methodUsed, setMethodUsed] = useState<'ai' | 'fast' | 'manual'>(item.bgMethod ?? 'fast');

  useEffect(() => {
    let active = true;
    (async () => {
      const origImg = await loadImage(item.originalDataUrl);
      const size = 400;
      const scale = Math.min(1, size / Math.max(origImg.width, origImg.height));
      const w = Math.max(32, Math.round(origImg.width * scale));
      const h = Math.max(32, Math.round(origImg.height * scale));

      const origCanvas = document.createElement('canvas');
      origCanvas.width = w;
      origCanvas.height = h;
      origCanvas.getContext('2d')!.drawImage(origImg, 0, 0, w, h);
      origCanvasRef.current = origCanvas;

      if (!active || !canvasRef.current) return;
      const c = canvasRef.current;
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;

      if (item.cleanedDataUrl) {
        const cleanImg = await loadImage(item.cleanedDataUrl);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(cleanImg, 0, 0, w, h);
      } else {
        const imgData = origCanvas.getContext('2d')!.getImageData(0, 0, w, h);
        const cleaned = removeBackgroundFast(imgData, tolerance);
        ctx.putImageData(cleaned, 0, 0);
      }
    })();
    return () => {
      active = false;
    };
  }, [item]);

  const runFastBg = async () => {
    if (!canvasRef.current) return;
    setBusy(true);
    try {
      const imgData = await dataUrlToImageData(item.originalDataUrl, 400);
      const cleaned = removeBackgroundFast(imgData, tolerance);
      const c = canvasRef.current;
      c.width = cleaned.width;
      c.height = cleaned.height;
      c.getContext('2d')!.putImageData(cleaned, 0, 0);
      setMethodUsed('fast');
    } finally {
      setBusy(false);
    }
  };

  const runAiBg = async () => {
    if (!canvasRef.current) return;
    setBusy(true);
    try {
      const { imageData, method } = await removeBackgroundAI(item.originalDataUrl, tolerance);
      const c = canvasRef.current;
      c.width = imageData.width;
      c.height = imageData.height;
      c.getContext('2d')!.putImageData(imageData, 0, 0);
      setMethodUsed(method);
    } finally {
      setBusy(false);
    }
  };

  const applyBrush = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    const orig = origCanvasRef.current;
    if (!c || !orig) return;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * c.width;
    const y = ((e.clientY - rect.top) / rect.height) * c.height;
    const ctx = c.getContext('2d')!;

    if (tool === 'erase') {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(x, y, brushSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, brushSize, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(orig, 0, 0, c.width, c.height);
      ctx.restore();
    }
    setMethodUsed('manual');
  };

  const handleSave = () => {
    const c = canvasRef.current;
    if (!c) return;
    const imgData = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    const { cleanedDataUrl, mask } = normalizeAndCropMask(imgData, 256, 0.08);
    onSave({
      ...item,
      cleanedDataUrl,
      mask,
      tolerance,
      bgMethod: methodUsed,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Maske ve Arkaplan Düzenleyici — {item.label}
            </h3>
            <p className="text-xs text-slate-400">
              Kalan arkaplan parçalarını silin veya kesilen yerleri geri boyayın.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 flex flex-col md:flex-row gap-4">
          <div className="flex-1 flex items-center justify-center checkerboard-bg rounded-xl border border-slate-800 p-2 min-h-[300px]">
            <canvas
              ref={canvasRef}
              onPointerDown={(e) => {
                setIsDrawing(true);
                applyBrush(e);
              }}
              onPointerMove={(e) => {
                if (isDrawing) applyBrush(e);
              }}
              onPointerUp={() => setIsDrawing(false)}
              onPointerLeave={() => setIsDrawing(false)}
              className="max-w-full max-h-[360px] object-contain cursor-crosshair touch-none"
            />
          </div>

          <div className="w-full md:w-56 flex flex-col gap-3">
            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-2.5">
              <div className="text-xs font-semibold text-slate-300">Otomatik Temizleme</div>
              <div>
                <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                  <span>Renk Toleransı</span>
                  <span>{tolerance}</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={85}
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                  className="w-full accent-cyan-400"
                />
              </div>
              <button
                onClick={runFastBg}
                disabled={busy}
                className="w-full py-1.5 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center justify-center gap-1.5 transition"
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                Hızlı Yeniden Temizle
              </button>
              <button
                onClick={runAiBg}
                disabled={busy}
                className="w-full py-1.5 px-2.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-xs text-cyan-200 flex items-center justify-center gap-1.5 transition"
              >
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                {busy ? 'AI İşliyor...' : 'AI Segmentasyon'}
              </button>
            </div>

            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-2.5">
              <div className="text-xs font-semibold text-slate-300">Fırça Rötuş</div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => setTool('erase')}
                  className={`py-1.5 rounded-lg text-xs flex items-center justify-center gap-1 border ${
                    tool === 'erase'
                      ? 'bg-rose-500/20 border-rose-500/50 text-rose-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  <Eraser className="w-3.5 h-3.5" /> Sil
                </button>
                <button
                  onClick={() => setTool('restore')}
                  className={`py-1.5 rounded-lg text-xs flex items-center justify-center gap-1 border ${
                    tool === 'restore'
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  <Brush className="w-3.5 h-3.5" /> Geri Al
                </button>
              </div>
              <div>
                <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                  <span>Fırça Boyutu</span>
                  <span>{brushSize}px</span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={48}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-full accent-cyan-400"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex justify-end gap-2 bg-slate-950/50">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs text-slate-300 hover:bg-slate-800 transition"
          >
            İptal
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 flex items-center gap-1.5 transition"
          >
            <Check className="w-4 h-4" /> Kaydet ve Uygula
          </button>
        </div>
      </div>
    </div>
  );
};
