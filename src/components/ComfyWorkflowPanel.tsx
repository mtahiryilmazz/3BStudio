import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  CloudDownload,
  Copy,
  Cpu,
  Download,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  COMFY_WORKFLOW_PRESETS,
  ComfyPresetId,
  buildComfySetupScript,
  buildComfyUiWorkflowJson,
} from '../engine/photogrammetry';
import { triggerDownload } from '../engine/exporters';

interface ComfyWorkflowPanelProps {
  frontPhotoDataUrl?: string | null;
  onComfyModelReady?: (modelUrl: string, presetName: string) => void;
  onNotify?: (type: 'info' | 'ok' | 'err', text: string) => void;
}

interface CatalogWeightStatus {
  id: string;
  repo: string;
  file: string;
  filename: string;
  targetDir: string;
  sizeHintGb: number;
  gated?: boolean;
  installed: boolean;
  diskBytes: number;
}

interface CatalogPresetStatus {
  id: ComfyPresetId;
  installedCount: number;
  totalCount: number;
  weights: CatalogWeightStatus[];
}

interface DownloadFileProgress {
  id: string;
  file: string;
  status: 'pending' | 'downloading' | 'skipped' | 'done' | 'error' | 'cancelled';
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  speedMbps: number;
  error?: string;
}

interface DownloadJobSnapshot {
  jobId: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  overallPercent: number;
  error?: string;
  files: DownloadFileProgress[];
}

interface ComfyPingState {
  checked: boolean;
  online: boolean;
  gpuName?: string;
  vramGb?: number;
  hasPixal3d?: boolean;
  hasBiRefNet?: boolean;
  hasLocal3dPlus?: boolean;
  note?: string;
}

function formatMb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export const ComfyWorkflowPanel: React.FC<ComfyWorkflowPanelProps> = ({
  frontPhotoDataUrl,
  onComfyModelReady,
  onNotify,
}) => {
  const [preset, setPreset] = useState<ComfyPresetId>('pixal3d-int8');
  const [textureSize, setTextureSize] = useState<number>(2048);
  const [maxFaces, setMaxFaces] = useState<number>(40000);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Otomatik Hugging Face Ağırlık İndirici durumu
  const [modelsDir, setModelsDir] = useState<string>('');
  const [resolvedDir, setResolvedDir] = useState<string>('');
  const [hfToken, setHfToken] = useState<string>('');
  const [catalogMap, setCatalogMap] = useState<Record<string, CatalogPresetStatus>>({});
  const [scanningDisk, setScanningDisk] = useState(false);
  const [dlJob, setDlJob] = useState<DownloadJobSnapshot | null>(null);
  const dlPollRef = useRef<number | null>(null);

  // Canlı yerel ComfyUI (:8188) köprüsü durumu
  const [comfyUrl, setComfyUrl] = useState<string>('http://127.0.0.1:8188');
  const [comfyPing, setComfyPing] = useState<ComfyPingState>({ checked: false, online: false });
  const [pinging, setPinging] = useState(false);
  const [runningComfy, setRunningComfy] = useState(false);
  const [comfyStageText, setComfyStageText] = useState<string>('');
  const comfyPollRef = useRef<number | null>(null);

  const selectedMeta = useMemo(
    () => COMFY_WORKFLOW_PRESETS.find((p) => p.id === preset) ?? COMFY_WORKFLOW_PRESETS[0],
    [preset]
  );

  const selectedCatalog = catalogMap[preset];
  const missingCount = selectedCatalog
    ? selectedCatalog.totalCount - selectedCatalog.installedCount
    : selectedMeta.weights.length;
  const totalGb = useMemo(
    () => Number(selectedMeta.weights.reduce((acc, w) => acc + w.sizeHintGb, 0).toFixed(1)),
    [selectedMeta]
  );

  const cliCmd = `npm run cli -- --comfy-workflow ${preset} --out ./output/comfy_${preset}`;

  const scanCatalog = useCallback(async (dirOverride?: string) => {
    setScanningDisk(true);
    try {
      const q = (dirOverride ?? modelsDir).trim();
      const url = q ? `/api/models/catalog?dir=${encodeURIComponent(q)}` : '/api/models/catalog';
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = (await resp.json()) as { targetRoot: string; presets: CatalogPresetStatus[] };
      setResolvedDir(data.targetRoot);
      const next: Record<string, CatalogPresetStatus> = {};
      for (const p of data.presets) next[p.id] = p;
      setCatalogMap(next);
    } catch {
      // silent
    } finally {
      setScanningDisk(false);
    }
  }, [modelsDir]);

  const pingComfy = useCallback(async () => {
    setPinging(true);
    try {
      const resp = await fetch(`/api/comfy/ping?url=${encodeURIComponent(comfyUrl.trim())}`);
      const data = (await resp.json()) as ComfyPingState;
      setComfyPing({ ...data, checked: true });
    } catch {
      setComfyPing({ checked: true, online: false, note: 'Bağlantı kurulamadı' });
    } finally {
      setPinging(false);
    }
  }, [comfyUrl]);

  useEffect(() => {
    void scanCatalog();
    void pingComfy();
    return () => {
      if (dlPollRef.current) window.clearInterval(dlPollRef.current);
      if (comfyPollRef.current) window.clearInterval(comfyPollRef.current);
    };
  }, []);

  const handleStartAutoDownload = async () => {
    try {
      const resp = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          presetId: preset,
          targetDir: modelsDir.trim() || undefined,
          hfToken: hfToken.trim() || undefined,
        }),
      });
      const data = (await resp.json()) as { jobId?: string; error?: string };
      if (!resp.ok || !data.jobId) {
        onNotify?.('err', data.error || 'Model indirme başlatılamadı.');
        return;
      }

      const jobId = data.jobId;
      onNotify?.('info', `${selectedMeta.name} ağırlıkları Hugging Face'ten indiriliyor...`);

      if (dlPollRef.current) window.clearInterval(dlPollRef.current);
      dlPollRef.current = window.setInterval(async () => {
        try {
          const stResp = await fetch(`/api/models/download/${jobId}`);
          if (!stResp.ok) return;
          const snap = (await stResp.json()) as DownloadJobSnapshot;
          setDlJob(snap);
          if (snap.status !== 'running') {
            if (dlPollRef.current) {
              window.clearInterval(dlPollRef.current);
              dlPollRef.current = null;
            }
            void scanCatalog();
            if (snap.status === 'done') {
              onNotify?.('ok', 'Tüm Hugging Face model ağırlıkları başarıyla indirildi!');
            } else if (snap.status === 'cancelled') {
              onNotify?.('info', 'Model indirme iptal edildi.');
            } else {
              onNotify?.('err', snap.error || 'İndirme sırasında hata oluştu.');
            }
          }
        } catch {
          // retry next tick
        }
      }, 900);
    } catch (err) {
      onNotify?.('err', (err as Error).message);
    }
  };

  const handleCancelDownload = async () => {
    if (!dlJob || dlJob.status !== 'running') return;
    try {
      await fetch(`/api/models/download/${dlJob.jobId}/cancel`, { method: 'POST' });
    } catch {
      // ignore
    }
  };

  const handleRunLiveComfy = async () => {
    if (!frontPhotoDataUrl) {
      onNotify?.('err', 'Canlı ComfyUI üretimi için önce en az 1 ön fotoğraf yükleyin.');
      return;
    }
    setRunningComfy(true);
    setComfyStageText('Fotoğraf yerel ComfyUI sunucusuna yükleniyor...');
    try {
      const resp = await fetch('/api/comfy/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comfyUrl: comfyUrl.trim(),
          preset,
          imageDataUrl: frontPhotoDataUrl,
          textureSize,
          maxFaces,
        }),
      });
      const data = (await resp.json()) as { promptId?: string; error?: string };
      if (!resp.ok || !data.promptId) {
        throw new Error(data.error || 'ComfyUI üretimi başlatılamadı.');
      }

      const promptId = data.promptId;
      setComfyStageText('ComfyUI GPU kuyruğunda (BiRefNet → MoGe → Pixal3D / Hunyuan3D)...');
      if (comfyPollRef.current) window.clearInterval(comfyPollRef.current);
      comfyPollRef.current = window.setInterval(async () => {
        try {
          const stResp = await fetch(
            `/api/comfy/status/${encodeURIComponent(promptId)}?url=${encodeURIComponent(comfyUrl.trim())}`
          );
          const st = (await stResp.json()) as {
            status: 'running' | 'done' | 'error';
            stageLabel?: string;
            modelUrl?: string;
            error?: string;
          };
          if (st.stageLabel) setComfyStageText(st.stageLabel);
          if (st.status === 'done' && st.modelUrl) {
            if (comfyPollRef.current) {
              window.clearInterval(comfyPollRef.current);
              comfyPollRef.current = null;
            }
            setRunningComfy(false);
            setComfyStageText('');
            onComfyModelReady?.(st.modelUrl, selectedMeta.name);
          } else if (st.status === 'error') {
            if (comfyPollRef.current) {
              window.clearInterval(comfyPollRef.current);
              comfyPollRef.current = null;
            }
            setRunningComfy(false);
            setComfyStageText('');
            onNotify?.('err', st.error || 'ComfyUI üretimi başarısız oldu.');
          }
        } catch {
          // retry
        }
      }, 1500);
    } catch (err) {
      setRunningComfy(false);
      setComfyStageText('');
      onNotify?.('err', (err as Error).message);
    }
  };

  const handleDownloadJson = () => {
    try {
      const wf = buildComfyUiWorkflowJson(preset, {
        inputFilename: 'input_front.png',
        textureSize,
        maxFaces,
      });
      triggerDownload(JSON.stringify(wf, null, 2), `3bstudio_comfyui_${preset}.json`, 'application/json;charset=utf-8');
      onNotify?.('ok', `ComfyUI (${selectedMeta.name}) akışı .json olarak indirildi.`);
    } catch (err) {
      onNotify?.('err', (err as Error).message);
    }
  };

  const handleDownloadSetupScript = (os: 'windows' | 'linux') => {
    const content = buildComfySetupScript(os, preset);
    const filename = os === 'windows' ? `3bstudio_kurulum_${preset}.ps1` : `3bstudio_kurulum_${preset}.sh`;
    triggerDownload(content, filename, 'text/plain;charset=utf-8');
    onNotify?.('ok', `${filename} tek-tık kurulum betiği indirildi.`);
  };

  const handleCopyCli = async () => {
    try {
      await navigator.clipboard.writeText(cliCmd);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1800);
      onNotify?.('info', 'ComfyUI CLI komutu panoya kopyalandı.');
    } catch {
      onNotify?.('err', 'Pano kopyalaması engellendi.');
    }
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
          Local3D+ &amp; Mesh Atölye GPU
        </span>
        <span className="text-[10px] font-mono text-teal-700 dark:text-teal-400 font-semibold">
          {selectedMeta.vramGb}
        </span>
      </div>

      {/* Paket Seçici */}
      <div className="space-y-1">
        <label className="text-[11px] text-slate-600 dark:text-slate-400">
          Otomatik Model Paketi (Hugging Face)
        </label>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as ComfyPresetId)}
          className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-teal-600 dark:focus:border-teal-400"
        >
          {COMFY_WORKFLOW_PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 p-2 space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1">
          <Layers className="w-3 h-3 text-teal-600 dark:text-teal-400" />
          Nöral Üretim Hattı · ~{totalGb} GB
        </div>
        <p className="text-[10px] text-slate-800 dark:text-slate-200 leading-snug font-mono">
          {selectedMeta.pipeline}
        </p>
      </div>

      {/* Otomatik Hugging Face Ağırlık İndirici */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/70 p-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400 flex items-center gap-1">
            <CloudDownload className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            Otomatik HF Ağırlık İndirici
          </span>
          <button
            type="button"
            onClick={() => scanCatalog()}
            disabled={scanningDisk}
            className="text-[10px] text-teal-700 dark:text-teal-400 hover:underline flex items-center gap-1"
            title="Diskteki modelleri yeniden tara"
          >
            <RefreshCw className={`w-3 h-3 ${scanningDisk ? 'animate-spin' : ''}`} />
            Tara
          </button>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <FolderOpen className="w-3 h-3 text-slate-400 shrink-0" />
            <input
              type="text"
              value={modelsDir}
              onChange={(e) => setModelsDir(e.target.value)}
              onBlur={() => scanCatalog()}
              placeholder={resolvedDir ? `Varsayılan: ${resolvedDir}` : 'ComfyUI/models klasörü (opsiyonel)'}
              className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-[10px] font-mono text-slate-800 dark:text-slate-200"
            />
          </div>
          {selectedMeta.weights.some((w) => w.gated) && (
            <input
              type="password"
              value={hfToken}
              onChange={(e) => setHfToken(e.target.value)}
              placeholder="HF Token (yalnızca kısıtlı SF3D modeli için)"
              className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-[10px] font-mono text-slate-800 dark:text-slate-200"
            />
          )}
        </div>

        {/* Ağırlık Listesi + Kurulu/Eksik Rozeti */}
        <div className="space-y-1 max-h-36 overflow-y-auto pr-0.5">
          {selectedMeta.weights.map((w) => {
            const diskItem = selectedCatalog?.weights.find((cw) => cw.id === w.id);
            const activeDl = dlJob?.files.find((df) => df.id === w.id);
            const isInstalled = Boolean(diskItem?.installed) || activeDl?.status === 'done' || activeDl?.status === 'skipped';
            return (
              <div
                key={w.id}
                className="text-[10px] border-b last:border-b-0 border-slate-100 dark:border-slate-800/80 pb-1 last:pb-0 space-y-0.5"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="font-semibold text-slate-800 dark:text-slate-200 font-mono truncate">
                    {w.file.split('/').pop()}
                  </span>
                  {isInstalled ? (
                    <span className="shrink-0 text-[9px] font-mono font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-0.5">
                      <CheckCircle2 className="w-2.5 h-2.5" /> Hazır
                    </span>
                  ) : activeDl?.status === 'downloading' ? (
                    <span className="shrink-0 text-[9px] font-mono text-teal-700 dark:text-teal-400">
                      %{activeDl.percent} · {activeDl.speedMbps} MB/s
                    </span>
                  ) : (
                    <span className="shrink-0 text-[9px] font-mono text-slate-500 dark:text-slate-400">
                      {w.sizeHintGb} GB · Eksik
                    </span>
                  )}
                </div>
                {activeDl?.status === 'downloading' && (
                  <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden">
                    <div
                      className="h-full bg-teal-600 transition-all"
                      style={{ width: `${activeDl.percent}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* İndir / İptal Düğmesi */}
        {dlJob?.status === 'running' ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] font-mono text-teal-700 dark:text-teal-400">
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                İndiriliyor (%{dlJob.overallPercent})
              </span>
              <button
                type="button"
                onClick={handleCancelDownload}
                className="text-rose-600 dark:text-rose-400 hover:underline flex items-center gap-0.5"
              >
                <Square className="w-2.5 h-2.5" /> İptal
              </button>
            </div>
            <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden">
              <div className="h-full bg-teal-600 transition-all" style={{ width: `${dlJob.overallPercent}%` }} />
            </div>
            {dlJob.files.find((f) => f.status === 'downloading') && (
              <div className="text-[9px] font-mono text-slate-500 dark:text-slate-400 truncate">
                {(() => {
                  const cur = dlJob.files.find((f) => f.status === 'downloading')!;
                  return `${formatMb(cur.downloadedBytes)} / ${formatMb(cur.totalBytes)} (${cur.speedMbps} MB/sn)`;
                })()}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={handleStartAutoDownload}
            disabled={missingCount === 0}
            className="w-full py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-500 text-white font-semibold text-[11px] flex items-center justify-center gap-1.5 transition"
          >
            <CloudDownload className="w-3.5 h-3.5" />
            {missingCount === 0
              ? 'Tüm Ağırlıklar Diskte Hazır'
              : `Eksik ${missingCount} Ağırlığı Otomatik İndir`}
          </button>
        )}
      </div>

      {/* Canlı Yerel ComfyUI (:8188) GPU Köprüsü */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 p-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400 flex items-center gap-1">
            {comfyPing.online ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-slate-400" />
            )}
            Canlı ComfyUI Köprüsü
          </span>
          <span
            className={`text-[9px] font-mono font-semibold ${
              comfyPing.online
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {comfyPing.online
              ? `${comfyPing.gpuName ?? 'GPU'}${comfyPing.vramGb ? ` · ${comfyPing.vramGb} GB` : ''}`
              : 'Çevrimdışı'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={comfyUrl}
            onChange={(e) => setComfyUrl(e.target.value)}
            className="flex-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-[10px] font-mono text-slate-800 dark:text-slate-200"
          />
          <button
            type="button"
            onClick={pingComfy}
            disabled={pinging}
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-[10px] font-semibold text-slate-700 dark:text-slate-200"
          >
            {pinging ? '...' : 'Test'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="text-[9px] text-slate-500 dark:text-slate-400">Doku</label>
            <select
              value={textureSize}
              onChange={(e) => setTextureSize(Number(e.target.value))}
              className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1 text-[10px] font-mono text-slate-900 dark:text-slate-100"
            >
              <option value={1024}>1024 px</option>
              <option value={2048}>2048 px (2K)</option>
            </select>
          </div>
          <div>
            <label className="text-[9px] text-slate-500 dark:text-slate-400">Hedef Yüzey</label>
            <select
              value={maxFaces}
              onChange={(e) => setMaxFaces(Number(e.target.value))}
              className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-1 text-[10px] font-mono text-slate-900 dark:text-slate-100"
            >
              <option value={20000}>20.000 △</option>
              <option value={40000}>40.000 △</option>
              <option value={80000}>80.000 △</option>
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={handleRunLiveComfy}
          disabled={runningComfy || !comfyPing.online}
          className="w-full py-2 rounded-lg bg-slate-900 hover:bg-slate-800 dark:bg-teal-600 dark:hover:bg-teal-500 disabled:opacity-45 text-white font-semibold text-[11px] flex items-center justify-center gap-1.5 transition"
        >
          {runningComfy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {runningComfy ? 'GPU Üretiliyor...' : 'Canlı ComfyUI ile 3D Üret'}
        </button>

        {comfyStageText && (
          <p className="text-[10px] text-teal-700 dark:text-teal-400 font-mono leading-snug">
            {comfyStageText}
          </p>
        )}
      </div>

      {/* Tek Tık Kurulum Betiği + JSON İndir */}
      <div className="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          onClick={() => handleDownloadSetupScript('windows')}
          className="py-1.5 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[10px] font-semibold text-slate-800 dark:text-slate-200 transition"
          title="ComfyUI + Local3D+ + ağırlıkları kuran Windows PowerShell betiği"
        >
          Kur (.PS1)
        </button>
        <button
          type="button"
          onClick={() => handleDownloadSetupScript('linux')}
          className="py-1.5 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[10px] font-semibold text-slate-800 dark:text-slate-200 transition"
          title="ComfyUI + Local3D+ + ağırlıkları kuran Linux/macOS bash betiği"
        >
          Kur (.SH)
        </button>
        <button
          type="button"
          onClick={handleDownloadJson}
          className="py-1.5 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[10px] font-semibold text-slate-800 dark:text-slate-200 flex items-center justify-center gap-1 transition"
        >
          <Download className="w-3 h-3 text-teal-600 dark:text-teal-400" />
          .JSON
        </button>
      </div>

      {/* Terminal tek satır üretim komutu */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70 p-2 flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
          <code className="text-[10px] font-mono text-slate-700 dark:text-slate-300 truncate">
            {cliCmd}
          </code>
        </div>
        <button
          type="button"
          onClick={handleCopyCli}
          className="shrink-0 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-[10px] text-slate-700 dark:text-slate-200 flex items-center gap-1 transition"
          title="CLI komutunu kopyala"
        >
          {copiedCmd ? <Check className="w-3 h-3 text-teal-600" /> : <Copy className="w-3 h-3" />}
          {copiedCmd ? 'Kopyalandı' : 'Kopyala'}
        </button>
      </div>
    </div>
  );
};
