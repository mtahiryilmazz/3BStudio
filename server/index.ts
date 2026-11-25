import express from 'express';
import cors from 'cors';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, handle_file } from '@gradio/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const SESSIONS_DIR = path.join(UPLOADS_DIR, 'sessions');
const MODELS_DIR = path.join(UPLOADS_DIR, 'models');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(MODELS_DIR, { recursive: true });

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

interface ScanSession {
  id: string;
  createdAt: number;
  photos: Record<string, string>;
  pointcloudUrl: string | null;
}

const sessions = new Map<string, ScanSession>();

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const sid = String(req.params.id || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
    const dir = path.join(SESSIONS_DIR, sid);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    const angle = typeof req.body?.angle === 'string' ? req.body.angle : 'scan';
    cb(null, `${angle}_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function getLanIp(): string {
  const nets = os.networkInterfaces();
  const candidates: { address: string; score: number }[] = [];
  for (const name of Object.keys(nets)) {
    const lower = name.toLowerCase();
    const isVirtual =
      lower.includes('vethernet') ||
      lower.includes('wsl') ||
      lower.includes('hyper-v') ||
      lower.includes('virtual') ||
      lower.includes('docker') ||
      lower.includes('vmware');
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        let score = 0;
        if (!isVirtual) score += 10;
        if (net.address.startsWith('192.168.')) score += 5;
        else if (net.address.startsWith('10.')) score += 3;
        if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan')) score += 4;
        candidates.push({ address: net.address, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address ?? '127.0.0.1';
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Geçersiz görsel data URL formatı.');
  }
  const bytes = Uint8Array.from(Buffer.from(match[2], 'base64'));
  return new Blob([bytes], { type: match[1] });
}

async function downloadToModelFile(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`3D model indirilemedi (HTTP ${res.status})`);
  }
  const arr = Buffer.from(await res.arrayBuffer());
  const filename = `model_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.glb`;
  const target = path.join(MODELS_DIR, filename);
  fs.writeFileSync(target, arr);
  return `/uploads/models/${filename}`;
}

app.get('/api/network-info', (_req, res) => {
  const lanIp = getLanIp();
  res.json({
    lanIp,
    frontendPort: 5173,
    apiPort: PORT,
    mobileBaseUrl: `http://${lanIp}:5173`,
  });
});

app.post('/api/sessions', (_req, res) => {
  const id = crypto.randomBytes(3).toString('hex').toUpperCase();
  const session: ScanSession = {
    id,
    createdAt: Date.now(),
    photos: {},
    pointcloudUrl: null,
  };
  sessions.set(id, session);
  fs.mkdirSync(path.join(SESSIONS_DIR, id), { recursive: true });
  res.json({ sessionId: id });
});

app.get('/api/sessions/:id', (req, res) => {
  const sid = String(req.params.id || '');
  let session = sessions.get(sid);
  if (!session) {
    session = { id: sid, createdAt: Date.now(), photos: {}, pointcloudUrl: null };
    sessions.set(sid, session);
  }
  res.json(session);
});

app.post('/api/sessions/:id/photo', upload.single('photo'), (req, res) => {
  const sid = String(req.params.id || '');
  const angle = String(req.body?.angle || 'front');
  if (!req.file) {
    res.status(400).json({ error: 'Fotoğraf dosyası eksik.' });
    return;
  }

  let session = sessions.get(sid);
  if (!session) {
    session = { id: sid, createdAt: Date.now(), photos: {}, pointcloudUrl: null };
    sessions.set(sid, session);
  }
  const url = `/uploads/sessions/${sid}/${req.file.filename}`;
  session.photos[angle] = url;
  res.json({ ok: true, angle, url });
});

app.post('/api/sessions/:id/pointcloud', upload.single('file'), (req, res) => {
  const sid = String(req.params.id || '');
  if (!req.file) {
    res.status(400).json({ error: '.PLY nokta bulutu dosyası eksik.' });
    return;
  }

  let session = sessions.get(sid);
  if (!session) {
    session = { id: sid, createdAt: Date.now(), photos: {}, pointcloudUrl: null };
    sessions.set(sid, session);
  }
  const url = `/uploads/sessions/${sid}/${req.file.filename}`;
  session.pointcloudUrl = url;
  res.json({ ok: true, pointcloudUrl: url });
});

app.post('/api/reconstruct/cloud', async (req, res) => {
  const { provider, apiKey, hfToken, spaceId, images } = req.body as {
    provider: 'huggingface' | 'fal' | 'tripo' | 'meshy';
    apiKey?: string;
    hfToken?: string;
    spaceId?: string;
    images?: { front?: string; back?: string; left?: string; right?: string };
  };

  if (!images?.front) {
    res.status(400).json({ error: 'En az ön (front) fotoğrafı gereklidir.' });
    return;
  }

  try {
    if (provider === 'huggingface') {
      const targetSpace = spaceId || 'tencent/Hunyuan3D-2mv';
      const tokenOpt = hfToken && hfToken.startsWith('hf_') ? (hfToken as `hf_${string}`) : undefined;

      const client = await Client.connect(targetSpace, tokenOpt ? { token: tokenOpt } : undefined);
      const apiInfo = await client.view_api();

      const frontBlob = dataUrlToBlob(images.front);
      const backBlob = images.back ? dataUrlToBlob(images.back) : null;
      const leftBlob = images.left ? dataUrlToBlob(images.left) : null;
      const rightBlob = images.right ? dataUrlToBlob(images.right) : null;

      // Pick the first generation endpoint available on the Space
      const namedKeys = Object.keys(apiInfo.named_endpoints || {});
      const endpoint =
        namedKeys.find((k) => k.includes('generation') || k.includes('shape') || k.includes('predict')) ||
        namedKeys[0] ||
        '/shape_generation';

      const payload: Record<string, unknown> = {
        mv_image_front: handle_file(frontBlob),
      };
      if (backBlob) payload.mv_image_back = handle_file(backBlob);
      if (leftBlob) payload.mv_image_left = handle_file(leftBlob);
      if (rightBlob) payload.mv_image_right = handle_file(rightBlob);

      const result = await client.predict(endpoint, payload);
      const dataArr = Array.isArray(result.data) ? result.data : [result.data];

      let modelRemoteUrl: string | null = null;
      for (const item of dataArr) {
        if (typeof item === 'string' && (item.includes('.glb') || item.startsWith('http'))) {
          modelRemoteUrl = item;
          break;
        }
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (typeof obj.url === 'string') {
            modelRemoteUrl = obj.url;
            break;
          }
          if (obj.value && typeof (obj.value as Record<string, unknown>).url === 'string') {
            modelRemoteUrl = (obj.value as Record<string, unknown>).url as string;
            break;
          }
        }
      }

      if (!modelRemoteUrl) {
        throw new Error('Hugging Face Space geçerli bir GLB dosya bağlantısı döndürmedi.');
      }

      const localUrl = await downloadToModelFile(
        modelRemoteUrl,
        tokenOpt ? { Authorization: `Bearer ${tokenOpt}` } : {}
      );
      res.json({ modelUrl: localUrl, provider: 'huggingface' });
      return;
    }

    if (provider === 'fal') {
      if (!apiKey) {
        res.status(400).json({ error: 'fal.ai için API anahtarı gereklidir.' });
        return;
      }
      const falRes = await fetch('https://fal.run/fal-ai/hunyuan3d/v2/multi-view', {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          front_image_url: images.front,
          back_image_url: images.back || images.front,
          left_image_url: images.left || images.right || images.front,
        }),
      });
      const falData = (await falRes.json()) as {
        model_mesh?: { url?: string };
        detail?: string;
      };
      if (!falRes.ok || !falData.model_mesh?.url) {
        throw new Error(falData.detail || `fal.ai hatası (HTTP ${falRes.status})`);
      }
      const localUrl = await downloadToModelFile(falData.model_mesh.url);
      res.json({ modelUrl: localUrl, provider: 'fal' });
      return;
    }

    if (provider === 'tripo') {
      if (!apiKey) {
        res.status(400).json({ error: 'Tripo3D için API anahtarı gereklidir.' });
        return;
      }
      const uploadOne = async (dataUrl: string) => {
        const blob = dataUrlToBlob(dataUrl);
        const fd = new FormData();
        fd.append('file', blob, 'view.png');
        const upRes = await fetch('https://api.tripo3d.ai/v2/openapi/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: fd,
        });
        const upJson = (await upRes.json()) as { data?: { image_token?: string }; message?: string };
        if (!upRes.ok || !upJson.data?.image_token) {
          throw new Error(upJson.message || 'Tripo görsel yüklemesi başarısız');
        }
        return upJson.data.image_token;
      };

      const files: { type: string; file_token: string }[] = [
        { type: 'png', file_token: await uploadOne(images.front) },
      ];
      if (images.left) files.push({ type: 'png', file_token: await uploadOne(images.left) });
      if (images.back) files.push({ type: 'png', file_token: await uploadOne(images.back) });
      if (images.right) files.push({ type: 'png', file_token: await uploadOne(images.right) });

      const taskRes = await fetch('https://api.tripo3d.ai/v2/openapi/task', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: files.length > 1 ? 'multiview_to_model' : 'image_to_model',
          ...(files.length > 1 ? { files } : { file: files[0] }),
        }),
      });
      const taskJson = (await taskRes.json()) as { data?: { task_id?: string }; message?: string };
      const taskId = taskJson.data?.task_id;
      if (!taskRes.ok || !taskId) {
        throw new Error(taskJson.message || 'Tripo görevi başlatılamadı');
      }

      for (let attempt = 0; attempt < 45; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const pollRes = await fetch(`https://api.tripo3d.ai/v2/openapi/task/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const pollJson = (await pollRes.json()) as {
          data?: { status?: string; output?: { model?: string; pbr_model?: string } };
        };
        const status = pollJson.data?.status;
        if (status === 'success') {
          const url = pollJson.data?.output?.model || pollJson.data?.output?.pbr_model;
          if (!url) throw new Error('Tripo model URL döndürmedi.');
          const localUrl = await downloadToModelFile(url);
          res.json({ modelUrl: localUrl, provider: 'tripo' });
          return;
        }
        if (status === 'failed' || status === 'cancelled') {
          throw new Error(`Tripo görevi başarısız oldu (${status})`);
        }
      }
      throw new Error('Tripo zaman aşımına uğradı.');
    }

    if (provider === 'meshy') {
      if (!apiKey) {
        res.status(400).json({ error: 'Meshy AI için API anahtarı gereklidir.' });
        return;
      }
      const imageUrls = [images.front, images.right, images.back, images.left].filter(Boolean) as string[];
      const createRes = await fetch('https://api.meshy.ai/openapi/v1/multi-image-to-3d', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image_urls: imageUrls,
          should_remesh: true,
        }),
      });
      const createJson = (await createRes.json()) as { result?: string; message?: string };
      const taskId = createJson.result;
      if (!createRes.ok || !taskId) {
        throw new Error(createJson.message || 'Meshy görevi başlatılamadı');
      }

      for (let attempt = 0; attempt < 45; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const pollRes = await fetch(`https://api.meshy.ai/openapi/v1/multi-image-to-3d/${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const pollJson = (await pollRes.json()) as {
          status?: string;
          model_urls?: { glb?: string };
        };
        if (pollJson.status === 'SUCCEEDED' && pollJson.model_urls?.glb) {
          const localUrl = await downloadToModelFile(pollJson.model_urls.glb);
          res.json({ modelUrl: localUrl, provider: 'meshy' });
          return;
        }
        if (pollJson.status === 'FAILED') {
          throw new Error('Meshy 3D üretimi başarısız oldu.');
        }
      }
      throw new Error('Meshy zaman aşımına uğradı.');
    }

    res.status(400).json({ error: `Bilinmeyen sağlayıcı: ${provider}` });
  } catch (err) {
    const msg = (err as Error).message || 'Bilinmeyen sunucu hatası';
    const friendly =
      provider === 'huggingface'
        ? `Hugging Face Space şu an yoğun/uykuda olabilir (${msg}). Ücretsiz HF Token ekleyebilir, fal.ai/Tripo seçebilir veya "Yerel Offline" motoru kullanabilirsiniz.`
        : msg;
    res.status(502).json({ error: friendly });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`Photo2Print 3D API hazir: http://localhost:${PORT} (LAN: http://${lanIp}:${PORT})`);
});
