import React, { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileJson,
  Layers,
  Palette,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  XCircle,
} from 'lucide-react';
import {
  PolyMollyQaReport,
  PrintabilityReport,
  RunManifest,
  build3DFZephyrCliScript,
} from '../engine/photogrammetry';
import { AmsFilamentSlot, triggerDownload } from '../engine/exporters';

interface StudioDiagnosticsPanelProps {
  hasGeometry: boolean;
  isBusy: boolean;
  qaReport: PolyMollyQaReport | null;
  printability: PrintabilityReport | null;
  hasPedestal: boolean;
  onTogglePedestal: () => void;
  sourceDetailReplace?: boolean;
  onToggleSourceDetailReplace?: () => void;
  onExportObjMtlZip?: () => void;
  onUpgradeToUltraPbr?: () => void;
  amsSlotsCount: number;
  onAmsSlotsCountChange: (count: number) => void;
  amsPalette: AmsFilamentSlot[];
  onExportMultiColor3MF: () => void;
  runHistory: RunManifest[];
  onNotify?: (type: 'info' | 'ok' | 'err', text: string) => void;
}

export const StudioDiagnosticsPanel: React.FC<StudioDiagnosticsPanelProps> = ({
  hasGeometry,
  isBusy,
  qaReport,
  printability,
  hasPedestal,
  onTogglePedestal,
  sourceDetailReplace = true,
  onToggleSourceDetailReplace,
  onExportObjMtlZip,
  onUpgradeToUltraPbr,
  amsSlotsCount,
  onAmsSlotsCountChange,
  amsPalette,
  onExportMultiColor3MF,
  runHistory,
  onNotify,
}) => {
  const [cliOpen, setCliOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const copyCommand = async (cmd: string, label: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      onNotify?.('info', `${label} panoya kopyalandı.`);
    } catch {
      onNotify?.('err', 'Pano kopyalaması engellendi.');
    }
  };

  const downloadZephyrScript = (os: 'windows' | 'linux') => {
    const content = build3DFZephyrCliScript({
      projectName: '3bstudio_model',
      photosDir: './photos',
      outputDir: './output',
      os,
    });
    const filename = os === 'windows' ? '3bstudio_zephyr_pipeline.bat' : '3bstudio_zephyr_pipeline.sh';
    triggerDownload(content, filename, 'text/plain;charset=utf-8');
    onNotify?.('ok', `${filename} indirildi.`);
  };

  const downloadManifest = (manifest: RunManifest) => {
    triggerDownload(
      JSON.stringify(manifest, null, 2),
      `${manifest.id}_run.json`,
      'application/json;charset=utf-8'
    );
    onNotify?.('ok', `${manifest.id}_run.json indirildi.`);
  };

  const ANGLE_LABELS: Record<string, string> = {
    front: 'Ön',
    back: 'Arka',
    right: 'Sağ',
    left: 'Sol',
  };

  return (
    <div className="space-y-3">
      {/* 1. PolyMolly 6-Check QA & Motor Uyumluluk Kapısı */}
      {qaReport && (
        <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              PolyMolly QA Kapısı
            </span>
            <span
              className={`text-xs font-mono font-bold tabular-nums ${
                qaReport.score >= 83
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : qaReport.score >= 60
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-rose-700 dark:text-rose-400'
              }`}
            >
              %{qaReport.score}
            </span>
          </div>

          <div className="space-y-1 pt-1 border-t border-slate-200/80 dark:border-slate-800">
            {qaReport.checks.map((chk) => (
              <div key={chk.id} className="flex items-start justify-between gap-2 text-[10px]">
                <span className="flex items-center gap-1 text-slate-700 dark:text-slate-300">
                  {chk.passed ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
                  )}
                  <span className="font-medium">{chk.label}</span>
                </span>
                <span className="text-slate-500 dark:text-slate-400 font-mono text-right truncate max-w-[115px]">
                  {chk.detail}
                </span>
              </div>
            ))}
          </div>

          <div className="pt-1.5 border-t border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-2 text-[10px]">
            <span className="text-slate-500 dark:text-slate-400">Uyumlu:</span>
            <span className="font-mono font-medium text-slate-800 dark:text-slate-200 truncate">
              {qaReport.compatibleEngines.join(' · ')}
            </span>
          </div>

          {hasGeometry && onToggleSourceDetailReplace && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onToggleSourceDetailReplace}
              className={`w-full py-1.5 rounded-lg text-[10px] font-semibold border transition disabled:opacity-40 ${
                sourceDetailReplace
                  ? 'bg-teal-50 dark:bg-teal-950/50 border-teal-300 dark:border-teal-800 text-teal-800 dark:text-teal-300'
                  : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300'
              }`}
              title="Mesh Atölye & Local3D+: Kaynak fotoğraf ayrıntıları ile ham kaplamayı anlık kıyasla"
            >
              {sourceDetailReplace
                ? 'Kaplama: Kaynak Ayrıntılı (Önceki/Ham Gör)'
                : 'Kaplama: Ham Temel (Kaynak Ayrıntılarını Aç)'}
            </button>
          )}

          {hasGeometry && onExportObjMtlZip && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onExportObjMtlZip}
              className="w-full py-1.5 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[10px] font-semibold text-slate-800 dark:text-slate-200 flex items-center justify-center gap-1.5 transition"
            >
              <Download className="w-3 h-3 text-teal-600 dark:text-teal-400" />
              OBJ + MTL + 2K PBR Dokular (.ZIP)
            </button>
          )}

          {qaReport.score < 100 && onUpgradeToUltraPbr && (
            <button
              type="button"
              disabled={!hasGeometry || isBusy}
              onClick={onUpgradeToUltraPbr}
              className="w-full py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white text-[11px] font-semibold flex items-center justify-center gap-1 transition"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Kaliteyi Artır (2K PBR + Onarım)
            </button>
          )}
        </div>
      )}

      {/* 2. 3D Baskı Doktoru & Çok Açılı Silüet-IoU + Sergi Kaidesi */}
      {printability && (
        <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              {printability.verdict === 'ready' ? (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <ShieldAlert className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              )}
              3D Baskı Doktoru
            </span>
            <span
              className={`text-[10px] font-semibold ${
                printability.verdict === 'ready'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : printability.verdict === 'needs-supports'
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-rose-700 dark:text-rose-400'
              }`}
            >
              {printability.verdict === 'ready'
                ? 'Hazır'
                : printability.verdict === 'needs-supports'
                  ? 'Destek Gerekir'
                  : 'Denge Kontrolü'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-1.5 text-[10px] pt-1 border-t border-slate-200/80 dark:border-slate-800">
            <div className="text-slate-600 dark:text-slate-400">
              Çıkıntı (&gt;45°):{' '}
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                %{printability.overhangPct}
              </span>
            </div>
            <div className="text-slate-600 dark:text-slate-400">
              CoG Denge:{' '}
              <span
                className={`font-semibold ${
                  printability.cogStable
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-rose-700 dark:text-rose-400'
                }`}
              >
                {printability.cogStable ? 'Dengeli' : 'Kayık'}
              </span>
            </div>
            <div className="text-slate-600 dark:text-slate-400">
              Üçgen Kalitesi:{' '}
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                {printability.triangleQuality.toFixed(2)}
              </span>
            </div>
            <div className="text-slate-600 dark:text-slate-400">
              Silüet IoU:{' '}
              <span className="font-mono font-semibold text-teal-700 dark:text-teal-400">
                {printability.silhouetteIoU !== null ? `%${printability.silhouetteIoU}` : '—'}
              </span>
            </div>
          </div>

          {/* Çok Açılı Silüet-IoU kırılımı (Mesh Atölye) */}
          {printability.multiViewIoU && Object.keys(printability.multiViewIoU).length > 1 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {Object.entries(printability.multiViewIoU).map(([ang, pct]) => (
                <span
                  key={ang}
                  className="px-1.5 py-0.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[9px] font-mono text-slate-700 dark:text-slate-300"
                >
                  {ANGLE_LABELS[ang] || ang}: %{pct}
                </span>
              ))}
            </div>
          )}

          <p className="text-[10px] text-slate-600 dark:text-slate-400 leading-snug">
            {printability.summary}
          </p>

          <button
            type="button"
            disabled={!hasGeometry || isBusy}
            onClick={onTogglePedestal}
            className={`w-full py-1.5 rounded-lg text-[11px] font-semibold border flex items-center justify-center gap-1.5 transition disabled:opacity-40 ${
              hasPedestal
                ? 'bg-slate-900 dark:bg-teal-600 border-slate-900 dark:border-teal-600 text-white'
                : 'bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            {hasPedestal ? 'Sergi Kaidesini Kaldır' : 'Figür Sergi Kaidesi Ekle (Y=0)'}
          </button>
        </div>
      )}

      {/* 3. Bambu AMS / Anycubic ACE Pro Çok Renkli .3MF */}
      {hasGeometry && (
        <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Palette className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              Çok Renkli Filament (.3MF)
            </span>
            <select
              value={amsSlotsCount}
              onChange={(e) => onAmsSlotsCountChange(Number(e.target.value))}
              className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-0.5 text-[10px] font-mono text-slate-800 dark:text-slate-200"
              title="Bambu AMS / Anycubic ACE Pro filament sayısı"
            >
              <option value={4}>4 Renk (AMS)</option>
              <option value={6}>6 Renk</option>
              <option value={8}>8 Renk (2×AMS)</option>
            </select>
          </div>

          {amsPalette.length > 0 && (
            <div className="grid grid-cols-2 gap-1">
              {amsPalette.map((slot) => (
                <div
                  key={slot.slot}
                  className="flex items-center justify-between gap-1.5 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-1.5 py-1 text-[10px]"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="w-3 h-3 rounded-sm border border-slate-300 dark:border-slate-600 shrink-0"
                      style={{ backgroundColor: slot.hex }}
                    />
                    <span className="font-mono text-slate-700 dark:text-slate-300 truncate">
                      F{slot.slot} {slot.hex}
                    </span>
                  </span>
                  <span className="font-mono text-slate-500 dark:text-slate-400 shrink-0">
                    %{slot.triangleSharePct}
                  </span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            disabled={isBusy}
            onClick={onExportMultiColor3MF}
            className="w-full py-1.5 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 text-[11px] font-semibold text-slate-900 dark:text-slate-100 flex items-center justify-center gap-1.5 transition"
          >
            <Download className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            Bambu AMS / ACE Pro .3MF İndir
          </button>
        </div>
      )}

      {/* 4. Son Üretimler & run.json Manifest Geçmişi */}
      {runHistory.length > 0 && (
        <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 transition"
          >
            <span className="flex items-center gap-1.5">
              <FileJson className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              Son Üretimler ({runHistory.length})
            </span>
            {historyOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          {historyOpen && (
            <div className="px-3 pb-2.5 pt-1 border-t border-slate-200/80 dark:border-slate-800 space-y-1.5">
              {runHistory.slice(0, 5).map((run) => (
                <div
                  key={run.id}
                  className="flex items-center justify-between gap-2 text-[10px] rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="font-mono font-semibold text-slate-800 dark:text-slate-200 truncate">
                      {run.profileId} · {run.lod.toUpperCase()} · QA %{run.polyMollyScore}
                    </div>
                    <div className="text-[9px] text-slate-500 dark:text-slate-400 font-mono">
                      {run.triangleCount.toLocaleString('tr-TR')} △ · {run.dimensionsMm.width}×
                      {run.dimensionsMm.height} mm
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadManifest(run)}
                    className="shrink-0 px-1.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[9px] font-mono text-slate-700 dark:text-slate-200"
                    title="run.json indir"
                  >
                    run.json
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 5. CLI & 3DF Zephyr Otomasyon (Açılır/Kapanır) */}
      <div className="bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setCliOpen((o) => !o)}
          className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 transition"
        >
          <span className="flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            CLI & 3DF Zephyr Otomasyon
          </span>
          {cliOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>

        {cliOpen && (
          <div className="px-3 pb-3 pt-1.5 border-t border-slate-200/80 dark:border-slate-800 space-y-2 text-[10px]">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                <span>Yerel Dönüştürme (GLB + 3MF + LOD)</span>
                <button
                  type="button"
                  onClick={() =>
                    copyCommand(
                      'npm run cli -- --input ./photos --out ./output/model --profile studio-ultra --lod --ams-colors 4 --formats glb,3mf',
                      'CLI convert komutu'
                    )
                  }
                  className="text-teal-700 dark:text-teal-400 hover:underline flex items-center gap-0.5"
                >
                  <Copy className="w-3 h-3" /> Kopyala
                </button>
              </div>
              <code className="block p-1.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 font-mono text-[9px] text-slate-700 dark:text-slate-300 overflow-x-auto">
                npm run cli -- --input ./photos --out ./output/model --lod --ams-colors 4
              </code>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                <span>Sistem Sağlık Kontrolü (Doctor)</span>
                <button
                  type="button"
                  onClick={() => copyCommand('npm run cli -- doctor', 'CLI doctor komutu')}
                  className="text-teal-700 dark:text-teal-400 hover:underline flex items-center gap-0.5"
                >
                  <Copy className="w-3 h-3" /> Kopyala
                </button>
              </div>
              <code className="block p-1.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 font-mono text-[9px] text-slate-700 dark:text-slate-300">
                npm run cli -- doctor
              </code>
            </div>

            <div className="grid grid-cols-2 gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => downloadZephyrScript('windows')}
                className="py-1.5 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 font-semibold text-slate-800 dark:text-slate-200 transition"
              >
                Zephyr .BAT İndir
              </button>
              <button
                type="button"
                onClick={() => downloadZephyrScript('linux')}
                className="py-1.5 rounded-lg bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-700 font-semibold text-slate-800 dark:text-slate-200 transition"
              >
                Zephyr .SH İndir
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
