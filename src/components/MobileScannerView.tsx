import React, { useEffect, useState } from 'react';
import { ViewAngle } from '../engine/types';
import { Camera, CheckCircle2, Compass, Smartphone, UploadCloud } from 'lucide-react';

interface MobileScannerViewProps {
  sessionId: string;
}

const ANGLES: { angle: ViewAngle; label: string; hint: string }[] = [
  { angle: 'front', label: 'Ön (0°)', hint: 'Parçanın tam karşısından düz çekin' },
  { angle: 'right', label: 'Sağ (90°)', hint: 'Parçayı 90° saat yönünde çevirin' },
  { angle: 'back', label: 'Arka (180°)', hint: 'Parçanın arka yüzünü çekin' },
  { angle: 'left', label: 'Sol (270°)', hint: 'Parçanın sol yan profilini çekin' },
  { angle: 'top', label: 'Üstten', hint: 'Parçanın tam tepesinden dik çekin' },
];

export const MobileScannerView: React.FC<MobileScannerViewProps> = ({ sessionId }) => {
  const [uploaded, setUploaded] = useState<Record<string, boolean>>({});
  const [uploadingAngle, setUploadingAngle] = useState<ViewAngle | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [tilt, setTilt] = useState<number | null>(null);
  const [webXrSupported, setWebXrSupported] = useState<boolean | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    // Check WebXR AR support (informational)
    const navAny = navigator as Navigator & { xr?: { isSessionSupported: (m: string) => Promise<boolean> } };
    if (navAny.xr?.isSessionSupported) {
      navAny.xr.isSessionSupported('immersive-ar').then(setWebXrSupported).catch(() => setWebXrSupported(false));
    } else {
      setWebXrSupported(false);
    }

    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.alpha !== null) setHeading(Math.round(e.alpha));
      if (e.beta !== null) setTilt(Math.round(e.beta));
    };
    window.addEventListener('deviceorientation', onOrient);

    // Fetch existing uploaded angles for this session
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.photos) {
          const done: Record<string, boolean> = {};
          for (const k of Object.keys(data.photos)) done[k] = true;
          setUploaded(done);
        }
      })
      .catch(() => {});

    return () => window.removeEventListener('deviceorientation', onOrient);
  }, [sessionId]);

  const handleCapture = async (angle: ViewAngle, file: File | undefined) => {
    if (!file) return;
    setUploadingAngle(angle);
    setStatusMsg(`${angle.toUpperCase()} fotoğrafı PC stüdyosuna gönderiliyor...`);

    try {
      const fd = new FormData();
      fd.append('angle', angle);
      fd.append('photo', file);

      const res = await fetch(`/api/sessions/${sessionId}/photo`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) throw new Error('Yükleme başarısız');
      setUploaded((prev) => ({ ...prev, [angle]: true }));
      setStatusMsg('✓ Fotoğraf PC ekranına aktarıldı!');
    } catch {
      setStatusMsg('Hata: PC sunucusuna ulaşılamadı. Aynı Wi-Fi ağında olduğunuzu kontrol edin.');
    } finally {
      setUploadingAngle(null);
    }
  };

  const completedCount = Object.keys(uploaded).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 pb-10 max-w-md mx-auto flex flex-col gap-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center">
            <Smartphone className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">Photo2Print Mobil Tarayıcı</h1>
            <p className="text-[11px] text-slate-400">
              Oturum: <span className="font-mono text-cyan-300">{sessionId}</span> • {completedCount}/5 açı
            </p>
          </div>
        </div>
        <div className="text-right text-[11px]">
          <div className="flex items-center gap-1 text-slate-300 justify-end">
            <Compass className="w-3.5 h-3.5 text-cyan-400" />
            {heading !== null ? `${heading}°` : 'Sensör —'}
          </div>
          <div className="text-slate-500">Eğim: {tilt !== null ? `${tilt}°` : '—'}</div>
        </div>
      </div>

      <div className="bg-slate-900/70 border border-slate-800 rounded-xl px-3.5 py-2.5 text-[11px] text-slate-300 leading-relaxed">
        <strong className="text-cyan-300">İpucu:</strong> Parçayı düz renkli bir masa/kağıt üzerine koyun. Her açıdan aynı
        mesafeden net fotoğraf çekin; fotoğraflar anında PC’deki stüdyoya düşer.
        {webXrSupported !== null && (
          <div className="mt-1 text-slate-400">
            WebXR AR Desteği: {webXrSupported ? 'Mevcut' : 'HTTPS/Native APK gerekli (Kamera modu aktif)'}
          </div>
        )}
      </div>

      {statusMsg && (
        <div className="bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 rounded-xl px-3.5 py-2 text-xs">
          {statusMsg}
        </div>
      )}

      <div className="space-y-2.5">
        {ANGLES.map((item) => {
          const isDone = Boolean(uploaded[item.angle]);
          const isBusy = uploadingAngle === item.angle;
          return (
            <label
              key={item.angle}
              className={`block rounded-2xl border p-3.5 transition cursor-pointer ${
                isDone
                  ? 'bg-emerald-500/10 border-emerald-500/40'
                  : 'bg-slate-900 border-slate-800 active:scale-[0.99]'
              }`}
            >
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                disabled={isBusy}
                onChange={(e) => {
                  handleCapture(item.angle, e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white flex items-center gap-2">
                    {item.label}
                    {isDone && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">{item.hint}</div>
                </div>
                <div
                  className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shrink-0 ${
                    isBusy
                      ? 'bg-slate-700 text-slate-300'
                      : isDone
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-cyan-500 text-slate-950'
                  }`}
                >
                  {isBusy ? (
                    <>
                      <UploadCloud className="w-4 h-4 animate-bounce" /> Gönderiliyor
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4" /> {isDone ? 'Tekrar Çek' : 'Fotoğraf Çek'}
                    </>
                  )}
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
};
