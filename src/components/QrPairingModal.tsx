import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { X, Smartphone, Wifi, CheckCircle2, Copy } from 'lucide-react';

interface QrPairingModalProps {
  sessionId: string;
  syncedCount: number;
  hasPointCloud: boolean;
  onClose: () => void;
}

export const QrPairingModal: React.FC<QrPairingModalProps> = ({
  sessionId,
  syncedCount,
  hasPointCloud,
  onClose,
}) => {
  const [mobileUrl, setMobileUrl] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/network-info');
        const info = await res.json();
        const url = `http://${info.lanIp}:${info.frontendPort}/?mode=mobile&session=${sessionId}`;
        setMobileUrl(url);
        setApiBase(`http://${info.lanIp}:${info.apiPort}`);
        const qr = await QRCode.toDataURL(url, {
          width: 240,
          margin: 2,
          color: { dark: '#0f172a', light: '#f8fafc' },
        });
        setQrDataUrl(qr);
      } catch {
        const fallback = `${window.location.origin}/?mode=mobile&session=${sessionId}`;
        setMobileUrl(fallback);
        const qr = await QRCode.toDataURL(fallback, { width: 240, margin: 2 });
        setQrDataUrl(qr);
      }
    })();
  }, [sessionId]);

  const copyUrl = async () => {
    if (!mobileUrl) return;
    await navigator.clipboard.writeText(mobileUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-cyan-400" />
            <h3 className="text-sm font-semibold text-slate-100">Android Telefon ile 3D Tarama</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 flex flex-col items-center text-center space-y-4">
          <div className="bg-white p-3 rounded-2xl shadow-inner">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="Android Tarayıcı QR" className="w-52 h-52" />
            ) : (
              <div className="w-52 h-52 flex items-center justify-center text-slate-500 text-xs">
                QR hazırlanıyor...
              </div>
            )}
          </div>

          <div className="space-y-1">
            <div className="text-xs font-medium text-cyan-300 flex items-center justify-center gap-1.5">
              <Wifi className="w-4 h-4" /> Telefon ve PC aynı Wi-Fi ağında olmalıdır
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Android kameranızla QR kodu okutun. Çektiğiniz 4–5 açı fotoğraf anında masaüstündeki bu oturuma (
              <span className="font-mono text-slate-200">{sessionId}</span>) aktarılır.
            </p>
          </div>

          {mobileUrl && (
            <div className="w-full flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
              <span className="text-[11px] font-mono text-slate-300 truncate flex-1 text-left">
                {mobileUrl}
              </span>
              <button
                onClick={copyUrl}
                className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 shrink-0"
              >
                <Copy className="w-3.5 h-3.5" />
                {copied ? 'Kopyalandı' : 'Kopyala'}
              </button>
            </div>
          )}

          <div className="w-full bg-slate-950/80 border border-slate-800 rounded-xl p-3 text-left text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Eşleşen Fotoğraf:</span>
              <span className="font-semibold text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> {syncedCount} / 5 açı alındı
              </span>
            </div>
            {hasPointCloud && (
              <div className="text-cyan-300 font-medium">
                ✓ Android ARCore Depth nokta bulutu (.PLY) alındı!
              </div>
            )}
            {apiBase && (
              <div className="text-[11px] text-slate-500 pt-1 border-t border-slate-800/80">
                ARCore Depth APK Oturum Adresi: <span className="font-mono text-slate-300">{apiBase}</span> • Oturum:{' '}
                <span className="font-mono text-slate-300">{sessionId}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
