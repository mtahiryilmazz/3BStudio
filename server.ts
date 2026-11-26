import express from 'express';
import cors from 'cors';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Client, handle_file } from '@gradio/client';
import { GoogleGenAI, Type } from '@google/genai';
import {
  buildGradioPayload,
  FREE_HF_SPACES,
  pickBestGradioEndpoint,
  VALID_SPACE_ID_RE,
  type GradioNamedEndpoints,
} from './src/engine/cloudCatalog.ts';
import { compileCadSpec } from './src/engine/cadEngine.ts';
import { runCliPipeline } from './cli/image2model.ts';
import type {
  CadSpec,
  CharacterDepthProfile,
  CloudJobSnapshot,
  CloudProvider,
  HfRuntimeStage,
  HfSpaceHealth,
} from './src/engine/types.ts';
import {
  buildComfySetupScript,
  buildComfyUiWorkflowJson,
  COMFY_WORKFLOW_PRESETS,
  type ComfyPresetId,
  type QualityProfileId,
} from './src/engine/photogrammetry.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const SESSIONS_DIR = path.join(UPLOADS_DIR, 'sessions');
const MODELS_DIR = path.join(UPLOADS_DIR, 'models');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(MODELS_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

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

function assertSafeRemoteUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Geçersiz uzak model adresi.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Yalnızca HTTP/HTTPS model adreslerine izin verilir.');
  }
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (blocked) {
    throw new Error('Yerel veya özel ağ adreslerinden model indirilemez.');
  }
  return parsed;
}

async function downloadToModelFile(url: string, headers: Record<string, string> = {}): Promise<string> {
  const safeUrl = assertSafeRemoteUrl(url);
  const res = await fetch(safeUrl.toString(), { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`3D model indirilemedi (HTTP ${res.status})`);
  }
  const arr = Buffer.from(await res.arrayBuffer());
  if (arr.byteLength < 64) {
    throw new Error('İndirilen 3D model dosyası boş veya bozuk.');
  }
  const lowerPath = safeUrl.pathname.toLowerCase();
  const ext = lowerPath.endsWith('.obj') ? '.obj' : lowerPath.endsWith('.stl') ? '.stl' : '.glb';
  const filename = `model_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`;
  const target = path.resolve(MODELS_DIR, filename);
  if (!target.startsWith(path.resolve(MODELS_DIR) + path.sep)) {
    throw new Error('Geçersiz hedef dosya yolu.');
  }
  fs.writeFileSync(target, arr);
  return `/uploads/models/${filename}`;
}

function extractModelUrlFromGradioData(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (
      (lower.startsWith('http://') || lower.startsWith('https://')) &&
      (lower.includes('.glb') || lower.includes('.obj') || lower.includes('.stl') || lower.includes('/file='))
    ) {
      return value;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractModelUrlFromGradioData(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === 'string') {
      const direct = extractModelUrlFromGradioData(obj.url, depth + 1);
      if (direct) return direct;
      if (obj.url.startsWith('http://') || obj.url.startsWith('https://')) return obj.url;
    }
    if (obj.value) {
      const nested = extractModelUrlFromGradioData(obj.value, depth + 1);
      if (nested) return nested;
    }
    for (const k of Object.keys(obj)) {
      const found = extractModelUrlFromGradioData(obj[k], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} zaman aşımına uğradı (${Math.round(ms / 1000)} sn)`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runSingleHfSpace(
  spaceId: string,
  images: { front: string; back?: string; left?: string; right?: string },
  tokenOpt?: `hf_${string}`
): Promise<string> {
  if (!VALID_SPACE_ID_RE.test(spaceId)) {
    throw new Error(`Geçersiz Hugging Face Space ID formatı: ${spaceId}`);
  }

  const connectOpts = tokenOpt ? ({ token: tokenOpt } as Record<string, unknown>) : undefined;
  const client = await withTimeout(Client.connect(spaceId, connectOpts), 25_000, `${spaceId} bağlantısı`);
  const apiInfo = (await withTimeout(client.view_api(), 15_000, `${spaceId} API bilgisi`)) as {
    named_endpoints?: GradioNamedEndpoints;
  };

  const frontBlob = dataUrlToBlob(images.front);
  const backBlob = images.back ? dataUrlToBlob(images.back) : null;
  const leftBlob = images.left ? dataUrlToBlob(images.left) : null;
  const rightBlob = images.right ? dataUrlToBlob(images.right) : null;

  const named = apiInfo.named_endpoints || {};
  const endpoint = pickBestGradioEndpoint(spaceId, named);
  const paramSpecs = named[endpoint]?.parameters ?? [];
  const payload = buildGradioPayload(
    paramSpecs,
    { front: frontBlob, back: backBlob, left: leftBlob, right: rightBlob },
    (blob) => handle_file(blob)
  );

  const result = await withTimeout(client.predict(endpoint, payload), 70_000, `${spaceId} 3D üretimi`);
  const modelRemoteUrl = extractModelUrlFromGradioData(result.data);
  if (!modelRemoteUrl) {
    throw new Error(`${spaceId} geçerli bir GLB/OBJ dosya bağlantısı döndürmedi.`);
  }
  return downloadToModelFile(
    modelRemoteUrl,
    tokenOpt ? { Authorization: `Bearer ${tokenOpt}` } : {}
  );
}

/**
 * HTML hata sayfalarını (<!doctype html>, Cloudflare, ZeroGPU kota, Space uyku)
 * anlaşılır Türkçe tanı mesajına çevirir.
 */
function formatCloudError(rawErr: unknown, spaceId?: string): string {
  const msg = rawErr instanceof Error ? rawErr.message : String(rawErr || 'Bilinmeyen hata');
  const lower = msg.toLowerCase();
  const prefix = spaceId ? `${spaceId}: ` : '';
  if (lower.includes('<!doctype') || lower.includes('<html') || lower.includes("unexpected token '<'")) {
    return `${prefix}Space şu an uykuda, yeniden başlatılıyor veya geçici HTML hata sayfası döndürdü.`;
  }
  if (lower.includes('zerogpu') || lower.includes('quota') || lower.includes('429') || lower.includes('exceeded')) {
    return `${prefix}Ücretsiz ZeroGPU günlük kotası doldu (HF Token ekleyebilir veya başka Space seçebilirsiniz).`;
  }
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized')) {
    return `${prefix}Yetkilendirme gerekiyor (ücretsiz Hugging Face token ekleyin).`;
  }
  if (lower.includes('404') || lower.includes('not found')) {
    return `${prefix}Space veya Gradio uç noktası bulunamadı.`;
  }
  if (lower.includes('zaman aşımı') || lower.includes('timeout') || lower.includes('abort')) {
    return `${prefix}Yanıt süresi aşıldı (sunucu kuyruğu yoğun).`;
  }
  return `${prefix}${msg}`;
}

async function fetchJsonSafe(
  url: string,
  init: RequestInit,
  providerLabel: string
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, init);
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('<!') || trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
    throw new Error(`${providerLabel} geçici HTML sayfası döndürdü (HTTP ${res.status}).`);
  }
  let parsed: Record<string, unknown> = {};
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new Error(`${providerLabel} geçersiz JSON yanıtı döndürdü (HTTP ${res.status}).`);
    }
  }
  return { ok: res.ok, status: res.status, data: parsed };
}

/* ------------------------------------------------------------------ *
 * Canlı Hugging Face Space Sağlık Önbelleği & Arka Plan Görev Kuyruğu
 * ------------------------------------------------------------------ */

const spaceHealthCache = new Map<string, HfSpaceHealth>();
const HEALTH_CACHE_TTL_MS = 45_000;

async function checkSingleHfSpaceHealth(spaceId: string, forceRefresh = false): Promise<HfSpaceHealth> {
  if (!VALID_SPACE_ID_RE.test(spaceId)) {
    return {
      id: spaceId,
      stage: 'UNKNOWN',
      healthy: false,
      checkedAt: Date.now(),
      note: 'Geçersiz Space ID',
    };
  }
  const cached = spaceHealthCache.get(spaceId);
  if (!forceRefresh && cached && Date.now() - cached.checkedAt < HEALTH_CACHE_TTL_MS) {
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_500);
  try {
    const res = await fetch(`https://huggingface.co/api/spaces/${spaceId}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const entry: HfSpaceHealth = {
        id: spaceId,
        stage: res.status === 404 ? 'STOPPED' : 'UNKNOWN',
        healthy: false,
        checkedAt: Date.now(),
        note: `HTTP ${res.status}`,
      };
      spaceHealthCache.set(spaceId, entry);
      return entry;
    }
    const json = (await res.json()) as {
      runtime?: { stage?: string; hardware?: { current?: string } };
    };
    const rawStage = String(json.runtime?.stage || 'UNKNOWN').toUpperCase();
    const knownStages: HfRuntimeStage[] = [
      'RUNNING',
      'RUNNING_BUILDING',
      'SLEEPING',
      'BUILDING',
      'PAUSED',
      'RUNTIME_ERROR',
      'BUILD_ERROR',
      'NO_APP_FILE',
      'STOPPED',
    ];
    const stage: HfRuntimeStage = knownStages.includes(rawStage as HfRuntimeStage)
      ? (rawStage as HfRuntimeStage)
      : 'UNKNOWN';
    const healthy = stage === 'RUNNING' || stage === 'RUNNING_BUILDING';
    const entry: HfSpaceHealth = {
      id: spaceId,
      stage,
      healthy,
      hardware: json.runtime?.hardware?.current,
      checkedAt: Date.now(),
    };
    spaceHealthCache.set(spaceId, entry);
    return entry;
  } catch {
    const entry: HfSpaceHealth = {
      id: spaceId,
      stage: 'UNKNOWN',
      healthy: false,
      checkedAt: Date.now(),
      note: 'Durum alınamadı',
    };
    spaceHealthCache.set(spaceId, entry);
    return entry;
  } finally {
    clearTimeout(timer);
  }
}

interface InternalCloudJob {
  jobId: string;
  provider: CloudProvider;
  createdAt: number;
  status: CloudJobSnapshot['status'];
  stageLabel: string;
  percent: number;
  activeSpaceId?: string;
  usedSpaceId?: string;
  triedSpaces: Array<{ spaceId: string; stage?: string; error?: string }>;
  modelUrl?: string;
  error?: string;
  cancelled: boolean;
}

const cloudJobs = new Map<string, InternalCloudJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

function pruneExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of cloudJobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      cloudJobs.delete(id);
    }
  }
}

function toCloudJobSnapshot(job: InternalCloudJob): CloudJobSnapshot {
  return {
    jobId: job.jobId,
    provider: job.provider,
    status: job.status,
    stageLabel: job.stageLabel,
    percent: job.percent,
    activeSpaceId: job.activeSpaceId,
    usedSpaceId: job.usedSpaceId,
    triedSpaces: job.triedSpaces,
    modelUrl: job.modelUrl,
    error: job.error,
    elapsedSec: Math.max(0, Math.round((Date.now() - job.createdAt) / 1000)),
  };
}

async function executeCloudJob(
  job: InternalCloudJob,
  params: {
    provider: CloudProvider;
    apiKey?: string;
    hfToken?: string;
    spaceId?: string;
    autoFallback?: boolean;
    images: { front: string; back?: string; left?: string; right?: string };
  }
): Promise<void> {
  try {
    if (params.provider === 'huggingface') {
      const primarySpace = (params.spaceId || FREE_HF_SPACES[0].id).trim();
      if (!VALID_SPACE_ID_RE.test(primarySpace)) {
        throw new Error('Geçersiz Hugging Face Space ID formatı (örnek: tencent/Hunyuan3D-2mv).');
      }
      const tokenOpt =
        params.hfToken && params.hfToken.startsWith('hf_')
          ? (params.hfToken as `hf_${string}`)
          : undefined;

      const rawCandidates =
        params.autoFallback !== false
          ? [primarySpace, ...FREE_HF_SPACES.map((s) => s.id).filter((id) => id !== primarySpace)]
          : [primarySpace];

      job.status = 'checking';
      job.percent = 12;
      job.stageLabel = 'Ücretsiz Hugging Face Space canlı durumu kontrol ediliyor...';

      const healthList = await Promise.all(rawCandidates.map((id) => checkSingleHfSpaceHealth(id)));
      const healthMap = new Map(healthList.map((h) => [h.id, h]));

      if (job.cancelled) return;

      // RUNNING Space'leri öne al; kesin durmuş/hata vermiş olanları en sona at
      const deadStages = new Set<HfRuntimeStage>(['PAUSED', 'BUILD_ERROR', 'RUNTIME_ERROR', 'NO_APP_FILE', 'STOPPED']);
      const runningOnes = rawCandidates.filter((id) => healthMap.get(id)?.healthy);
      const wakingOnes = rawCandidates.filter((id) => {
        const st = healthMap.get(id)?.stage;
        return !healthMap.get(id)?.healthy && (!st || !deadStages.has(st));
      });
      const ordered =
        params.autoFallback !== false
          ? [...runningOnes, ...wakingOnes.slice(0, 2)]
          : [primarySpace];

      if (ordered.length === 0) {
        const deadSummary = healthList
          .slice(0, 4)
          .map((h) => `${h.id} (${h.stage})`)
          .join(', ');
        throw new Error(
          `Açık/çalışır durumda ücretsiz Hugging Face 3D Space bulunamadı (${deadSummary}). Yerel 3DF Zephyr 2K PBR motorunu anında kullanabilirsiniz.`
        );
      }

      const totalSteps = ordered.length;
      for (let idx = 0; idx < totalSteps; idx++) {
        if (job.cancelled) return;
        const candidate = ordered[idx];
        const stage = healthMap.get(candidate)?.stage ?? 'UNKNOWN';
        job.status = 'running';
        job.activeSpaceId = candidate;
        job.percent = Math.min(88, Math.round(20 + (idx / Math.max(1, totalSteps)) * 65));
        job.stageLabel = `${candidate} (${stage === 'RUNNING' ? 'Açık' : stage}) ile 3D model üretiliyor...`;

        try {
          const localUrl = await runSingleHfSpace(candidate, params.images, tokenOpt);
          if (job.cancelled) return;
          job.triedSpaces.push({ spaceId: candidate, stage });
          job.usedSpaceId = candidate;
          job.modelUrl = localUrl;
          job.status = 'done';
          job.percent = 100;
          job.stageLabel = `${candidate} 3D modeli hazırlandı.`;
          return;
        } catch (spaceErr) {
          job.triedSpaces.push({
            spaceId: candidate,
            stage,
            error: formatCloudError(spaceErr),
          });
        }
      }

      const summary = job.triedSpaces
        .map((t) => `${t.spaceId}: ${t.error}`)
        .slice(0, 3)
        .join(' | ');
      throw new Error(
        `Denenen ${job.triedSpaces.length} ücretsiz Hugging Face Space yanıt vermedi (${summary}). Ücretsiz HF Token ekleyebilir veya Yerel 3DF Zephyr 2K PBR motorunu kullanabilirsiniz.`
      );
    }

    if (params.provider === 'fal') {
      if (!params.apiKey) throw new Error('fal.ai için API anahtarı gereklidir.');
      job.status = 'running';
      job.percent = 35;
      job.stageLabel = 'fal.ai Hunyuan3D Multi-View çalışıyor...';
      const { ok, status, data } = await fetchJsonSafe(
        'https://fal.run/fal-ai/hunyuan3d/v2/multi-view',
        {
          method: 'POST',
          headers: {
            Authorization: `Key ${params.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            front_image_url: params.images.front,
            back_image_url: params.images.back || params.images.front,
            left_image_url: params.images.left || params.images.right || params.images.front,
          }),
        },
        'fal.ai'
      );
      const meshUrl = (data.model_mesh as { url?: string } | undefined)?.url;
      if (!ok || !meshUrl) {
        throw new Error(String(data.detail || `fal.ai hatası (HTTP ${status})`));
      }
      job.status = 'downloading';
      job.percent = 85;
      job.stageLabel = 'fal.ai 3D modeli indiriliyor...';
      job.modelUrl = await downloadToModelFile(meshUrl);
      job.status = 'done';
      job.percent = 100;
      job.stageLabel = 'fal.ai 3D modeli hazır.';
      return;
    }

    if (params.provider === 'tripo') {
      if (!params.apiKey) throw new Error('Tripo3D için API anahtarı gereklidir.');
      job.status = 'running';
      job.percent = 20;
      job.stageLabel = 'Görseller Tripo3D sunucusuna yükleniyor...';
      const uploadOne = async (dataUrl: string) => {
        const blob = dataUrlToBlob(dataUrl);
        const fd = new FormData();
        fd.append('file', blob, 'view.png');
        const up = await fetchJsonSafe(
          'https://api.tripo3d.ai/v2/openapi/upload',
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${params.apiKey}` },
            body: fd,
          },
          'Tripo3D'
        );
        const tok = (up.data.data as { image_token?: string } | undefined)?.image_token;
        if (!up.ok || !tok) throw new Error(String(up.data.message || 'Tripo görsel yüklemesi başarısız'));
        return tok;
      };

      const files: { type: string; file_token: string }[] = [
        { type: 'png', file_token: await uploadOne(params.images.front) },
      ];
      if (params.images.left) files.push({ type: 'png', file_token: await uploadOne(params.images.left) });
      if (params.images.back) files.push({ type: 'png', file_token: await uploadOne(params.images.back) });
      if (params.images.right) files.push({ type: 'png', file_token: await uploadOne(params.images.right) });

      const taskRes = await fetchJsonSafe(
        'https://api.tripo3d.ai/v2/openapi/task',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: files.length > 1 ? 'multiview_to_model' : 'image_to_model',
            ...(files.length > 1 ? { files } : { file: files[0] }),
          }),
        },
        'Tripo3D'
      );
      const taskId = (taskRes.data.data as { task_id?: string } | undefined)?.task_id;
      if (!taskRes.ok || !taskId) {
        throw new Error(String(taskRes.data.message || 'Tripo görevi başlatılamadı'));
      }

      for (let attempt = 0; attempt < 45; attempt++) {
        if (job.cancelled) return;
        await new Promise((r) => setTimeout(r, 3000));
        job.percent = Math.min(88, 30 + attempt);
        job.stageLabel = `Tripo3D modeli işleniyor (${attempt * 3} sn)...`;
        const poll = await fetchJsonSafe(
          `https://api.tripo3d.ai/v2/openapi/task/${taskId}`,
          { headers: { Authorization: `Bearer ${params.apiKey}` } },
          'Tripo3D'
        );
        const pdata = poll.data.data as
          | { status?: string; output?: { model?: string; pbr_model?: string } }
          | undefined;
        if (pdata?.status === 'success') {
          const url = pdata.output?.model || pdata.output?.pbr_model;
          if (!url) throw new Error('Tripo model URL döndürmedi.');
          job.status = 'downloading';
          job.percent = 92;
          job.stageLabel = 'Tripo3D GLB indiriliyor...';
          job.modelUrl = await downloadToModelFile(url);
          job.status = 'done';
          job.percent = 100;
          job.stageLabel = 'Tripo3D modeli hazır.';
          return;
        }
        if (pdata?.status === 'failed' || pdata?.status === 'cancelled') {
          throw new Error(`Tripo görevi başarısız oldu (${pdata.status})`);
        }
      }
      throw new Error('Tripo zaman aşımına uğradı.');
    }

    if (params.provider === 'meshy') {
      if (!params.apiKey) throw new Error('Meshy AI için API anahtarı gereklidir.');
      job.status = 'running';
      job.percent = 25;
      job.stageLabel = 'Meshy AI çoklu-görsel görevi başlatılıyor...';
      const imageUrls = [
        params.images.front,
        params.images.right,
        params.images.back,
        params.images.left,
      ].filter(Boolean) as string[];
      const created = await fetchJsonSafe(
        'https://api.meshy.ai/openapi/v1/multi-image-to-3d',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ image_urls: imageUrls, should_remesh: true }),
        },
        'Meshy AI'
      );
      const taskId = String(created.data.result || '');
      if (!created.ok || !taskId) {
        throw new Error(String(created.data.message || 'Meshy görevi başlatılamadı'));
      }

      for (let attempt = 0; attempt < 45; attempt++) {
        if (job.cancelled) return;
        await new Promise((r) => setTimeout(r, 3000));
        job.percent = Math.min(88, 30 + attempt);
        job.stageLabel = `Meshy AI 3D modeli üretiliyor (${attempt * 3} sn)...`;
        const poll = await fetchJsonSafe(
          `https://api.meshy.ai/openapi/v1/multi-image-to-3d/${taskId}`,
          { headers: { Authorization: `Bearer ${params.apiKey}` } },
          'Meshy AI'
        );
        const status = String(poll.data.status || '');
        const glb = (poll.data.model_urls as { glb?: string } | undefined)?.glb;
        if (status === 'SUCCEEDED' && glb) {
          job.status = 'downloading';
          job.percent = 92;
          job.stageLabel = 'Meshy GLB indiriliyor...';
          job.modelUrl = await downloadToModelFile(glb);
          job.status = 'done';
          job.percent = 100;
          job.stageLabel = 'Meshy 3D modeli hazır.';
          return;
        }
        if (status === 'FAILED') throw new Error('Meshy 3D üretimi başarısız oldu.');
      }
      throw new Error('Meshy zaman aşımına uğradı.');
    }

    throw new Error(`Bilinmeyen sağlayıcı: ${params.provider}`);
  } catch (err) {
    if (!job.cancelled) {
      job.status = 'error';
      job.error = formatCloudError(err);
      job.stageLabel = 'Bulut üretimi tamamlanamadı.';
    }
  }
}

const CAD_SYSTEM_INSTRUCTION = `You are a precision mechanical & 3D-printing CAD engineer inspired by earthtojake/text-to-cad (build123d).
Return ONLY valid JSON (no markdown fences) matching this exact CadSpec schema:
{
  "title": "Short Turkish part title",
  "summary": "1 sentence Turkish engineering description (mm dimensions, 3D print readiness)",
  "parameters": [
    { "name": "camelCaseId", "label": "Turkish label", "unit": "mm", "value": 40, "min": 10, "max": 160, "step": 1 }
  ],
  "root": <CadNode>,
  "build123dCode": "Complete valid Python build123d script using the exact same parameter names and exporting STEP and STL"
}

Supported <CadNode> types (coordinates are in mm, Z-up, centered at origin unless translated):
- { "type": "cuboid", "size": [x, y, z] }
- { "type": "roundedCuboid", "size": [x, y, z], "roundRadius": r, "segments": 14 }
- { "type": "cylinder", "radius": r, "height": h, "segments": 36 }
- { "type": "roundedCylinder", "radius": r, "height": h, "roundRadius": r2, "segments": 32 }
- { "type": "cone", "bottomRadius": r1, "topRadius": r2, "height": h, "segments": 36 }
- { "type": "sphere", "radius": r, "segments": 28 }
- { "type": "torus", "innerRadius": rMinor, "outerRadius": rMajor }
- { "type": "tube", "outerRadius": rOut, "innerRadius": rIn, "height": h, "segments": 36 }
- { "type": "gear", "teeth": n, "module": m, "thickness": t, "boreRadius": r }
- { "type": "hexNut", "flatToFlat": ftf, "thickness": t, "holeRadius": r }
- { "type": "polygonExtrude", "points": [[x1,y1], [x2,y2], ...], "height": h }
- { "type": "translate", "offset": [x, y, z], "child": <CadNode> }
- { "type": "rotate", "anglesDeg": [rx, ry, rz], "child": <CadNode> }
- { "type": "scale", "factors": [sx, sy, sz], "child": <CadNode> }
- { "type": "mirror", "normal": [nx, ny, nz], "child": <CadNode> }
- { "type": "linearArray", "count": n, "step": [dx, dy, dz], "child": <CadNode> }
- { "type": "radialArray", "count": n, "radius": r, "axis": "z", "child": <CadNode> }
- { "type": "union", "children": [<CadNode>, ...] }
- { "type": "subtract", "children": [<baseNode>, <cut1>, ...] }
- { "type": "intersect", "children": [<CadNode>, ...] }
- { "type": "hull", "children": [<CadNode>, ...] }

Engineering rules for 3D printing:
1. Every numeric field may be a number OR a safe math expression string referencing parameter names (e.g. "width - wall * 2", "holeDia / 2", "-(length / 2 - wall)").
2. Use realistic FDM 3D printing tolerances: walls >= 2.0 mm, clearances >= 0.3 mm, through-holes slightly taller than the wall they cut ("thick + 4") so CSG subtract is always clean and manifold!
3. Keep all parts connected as one solid piece (overlapping joins by >= 0.5 mm) so the STL is 100% watertight.
4. Provide 3 to 6 meaningful editable parameters so the user can adjust dimensions live with sliders.
5. Make detailed, realistic mechanical features (mounting holes, ribs, chamfers/roundedCuboids, recesses, bolt circles, vents, hex bosses) — never return a plain featureless box!`;

function parseCadSpecJson(rawText: string): CadSpec {
  const trimmed = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(trimmed) as CadSpec;
  if (!parsed || typeof parsed !== 'object' || !parsed.root || typeof parsed.root !== 'object') {
    throw new Error('Üretilen CAD yanıtında geçerli geometri ağacı (root) bulunamadı.');
  }
  if (!Array.isArray(parsed.parameters)) {
    parsed.parameters = [];
  }
  parsed.title = String(parsed.title || 'Parametrik CAD Parçası');
  parsed.summary = String(parsed.summary || '3D yazıcıya uygun parametrik katı model.');
  return parsed;
}

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use('/uploads', express.static(UPLOADS_DIR));

  app.get('/api/network-info', (req, res) => {
    const lanIp = getLanIp();
    const appUrl = process.env.APP_URL;
    const hostHeader = req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const mobileBaseUrl = appUrl || (hostHeader ? `${proto}://${hostHeader}` : `http://${lanIp}:${PORT}`);
    res.json({
      lanIp,
      frontendPort: PORT,
      apiPort: PORT,
      mobileBaseUrl,
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

  app.get('/api/cloud/free-models', (_req, res) => {
    res.json({ models: FREE_HF_SPACES });
  });

  // Canlı Hugging Face Space çalışma durumu (RUNNING / SLEEPING / PAUSED)
  app.get('/api/cloud/health', async (req, res) => {
    const force = req.query.refresh === '1';
    const customSpace = typeof req.query.spaceId === 'string' ? req.query.spaceId.trim() : '';
    const ids = FREE_HF_SPACES.map((s) => s.id);
    if (customSpace && VALID_SPACE_ID_RE.test(customSpace) && !ids.includes(customSpace)) {
      ids.unshift(customSpace);
    }
    try {
      const spaces = await Promise.all(ids.map((id) => checkSingleHfSpaceHealth(id, force)));
      res.json({ spaces, checkedAt: Date.now() });
    } catch (err) {
      res.status(502).json({ error: formatCloudError(err) });
    }
  });

  // Ücretsiz katman Gemini (gemini-4-hydrogen) ile karakter derinlik & kafa oranı kalibrasyonu
  app.post('/api/ai/analyze-character', async (req, res) => {
    const { front, back, face } = req.body as {
      front?: string;
      back?: string;
      face?: string;
    };
    if (!front && !back) {
      res.status(400).json({ error: 'Oran analizi için en az bir görsel gereklidir.' });
      return;
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error: 'Sunucuda GEMINI_API_KEY tanımlı değil; yerel matematiksel anatomi oranları kullanılacak.',
      });
      return;
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
      for (const [label, dataUrl] of [
        ['FRONT', front],
        ['BACK', back],
        ['FACE', face],
      ] as const) {
        if (!dataUrl || typeof dataUrl !== 'string') continue;
        const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (m) {
          parts.push({ text: `${label} view:` });
          parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
        }
      }
      parts.push({
        text: 'Analyze these character/object turnaround views for 3D silhouette inflation and depth reconstruction. Detect if the front view is missing the head (headless) or has tape/occlusion covering the face, classify subjectType (humanoid, figurine, or object), and recommend organic depth ratios (headDepthScale 0.75-1.1, torsoDepthScale 0.52-0.85, limbDepthScale 0.75-1.0, reliefStrength 0.01-0.035).',
      });

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              subjectType: { type: Type.STRING },
              frontHeadMissing: { type: Type.BOOLEAN },
              frontFaceOccluded: { type: Type.BOOLEAN },
              torsoDepthScale: { type: Type.NUMBER },
              headDepthScale: { type: Type.NUMBER },
              limbDepthScale: { type: Type.NUMBER },
              reliefStrength: { type: Type.NUMBER },
              notes: { type: Type.STRING },
            },
          },
        },
      });
      const parsed = JSON.parse((response.text || '{}').trim()) as Partial<CharacterDepthProfile>;
      const profile: CharacterDepthProfile = {
        subjectType:
          parsed.subjectType === 'object' || parsed.subjectType === 'figurine'
            ? parsed.subjectType
            : 'humanoid',
        frontHeadMissing: Boolean(parsed.frontHeadMissing),
        frontFaceOccluded: Boolean(parsed.frontFaceOccluded),
        torsoDepthScale: Math.max(0.5, Math.min(0.9, Number(parsed.torsoDepthScale) || 0.68)),
        headDepthScale: Math.max(0.75, Math.min(1.15, Number(parsed.headDepthScale) || 0.96)),
        limbDepthScale: Math.max(0.7, Math.min(1.05, Number(parsed.limbDepthScale) || 0.88)),
        reliefStrength: Math.max(0.008, Math.min(0.04, Number(parsed.reliefStrength) || 0.018)),
        notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 220) : undefined,
      };
      res.json({ profile, model: 'gemini-4-hydrogen' });
    } catch (err) {
      res.status(502).json({ error: `Gemini oran analizi tamamlanamadı: ${formatCloudError(err)}` });
    }
  });

  // Arka Plan Bulut 3D Görev Başlatma (sıfır 60sn proxy zaman aşımı / HTML hatası)
  app.post('/api/reconstruct/cloud/start', (req, res) => {
    pruneExpiredJobs();
    const { provider, apiKey, hfToken, spaceId, autoFallback, images } = req.body as {
      provider: CloudProvider;
      apiKey?: string;
      hfToken?: string;
      spaceId?: string;
      autoFallback?: boolean;
      images?: { front?: string; back?: string; left?: string; right?: string };
    };

    if (!images?.front) {
      res.status(400).json({ error: 'En az ön (front) fotoğrafı gereklidir.' });
      return;
    }
    if (provider === 'huggingface' && spaceId && !VALID_SPACE_ID_RE.test(spaceId.trim())) {
      res.status(400).json({ error: 'Geçersiz Hugging Face Space ID formatı (örnek: tencent/Hunyuan3D-2mv).' });
      return;
    }

    const jobId = crypto.randomBytes(12).toString('hex');
    const job: InternalCloudJob = {
      jobId,
      provider: provider || 'huggingface',
      createdAt: Date.now(),
      status: 'queued',
      stageLabel: 'Görev sıraya alındı...',
      percent: 5,
      triedSpaces: [],
      cancelled: false,
    };
    cloudJobs.set(jobId, job);

    void executeCloudJob(job, {
      provider: job.provider,
      apiKey,
      hfToken,
      spaceId,
      autoFallback,
      images: {
        front: images.front,
        back: images.back,
        left: images.left,
        right: images.right,
      },
    });

    res.status(202).json(toCloudJobSnapshot(job));
  });

  app.get('/api/reconstruct/cloud/status/:jobId', (req, res) => {
    const jobId = String(req.params.jobId || '').replace(/[^a-f0-9]/gi, '');
    const job = cloudJobs.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Bulut 3D görevi bulunamadı veya süresi doldu.' });
      return;
    }
    res.json(toCloudJobSnapshot(job));
  });

  app.post('/api/reconstruct/cloud/cancel/:jobId', (req, res) => {
    const jobId = String(req.params.jobId || '').replace(/[^a-f0-9]/gi, '');
    const job = cloudJobs.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Görev bulunamadı.' });
      return;
    }
    job.cancelled = true;
    job.status = 'cancelled';
    job.stageLabel = 'Kullanıcı tarafından iptal edildi.';
    res.json(toCloudJobSnapshot(job));
  });

  // Uzaktan CLI / curl ile görsel yükleyip anında 3D model alma uç noktası
  app.post('/api/cli/convert', upload.array('files', 8), async (req, res) => {
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (uploaded.length === 0) {
      res.status(400).json({ error: 'En az bir PNG/JPEG görsel dosyası (files) yüklemelisiniz.' });
      return;
    }
    const rawProfile = String(req.body?.profile || 'studio-ultra');
    const profile: QualityProfileId =
      rawProfile === 'game-polymolly' || rawProfile === 'print-precision'
        ? rawProfile
        : 'studio-ultra';
    const rawFormat = String(req.body?.format || 'glb').toLowerCase();
    const format = ['glb', '3mf', 'stl', 'obj'].includes(rawFormat) ? rawFormat : 'glb';
    const sizeMm = Math.max(15, Math.min(220, Number(req.body?.sizeMm) || 80));

    const outId = `cli_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const outPrefix = path.resolve(MODELS_DIR, outId);
    if (!outPrefix.startsWith(path.resolve(MODELS_DIR) + path.sep)) {
      res.status(400).json({ error: 'Geçersiz çıktı yolu.' });
      return;
    }

    try {
      const result = await runCliPipeline({
        command: 'convert',
        inputs: uploaded.map((f) => f.path),
        out: outPrefix,
        profile,
        sizeMm,
        formats: [format],
        tolerance: 34,
        zephyrScript: false,
        lod: req.body?.lod === 'true' || req.body?.lod === true,
        pedestal: req.body?.pedestal === 'true' || req.body?.pedestal === true,
        delight: req.body?.delight !== 'false',
        amsColors: Math.max(0, Math.min(8, Number(req.body?.amsColors) || 0)),
        help: false,
      });
      const mainOut = result.written[0];
      res.json({
        ok: true,
        modelUrl: mainOut ? `/uploads/models/${path.basename(mainOut.file)}` : null,
        angles: result.angles,
        stats: result.stats,
        qa: result.qa,
        printability: result.printability,
        manifest: result.manifest,
      });
    } catch (err) {
      res.status(500).json({ error: `CLI 3D dönüştürme hatası: ${formatCloudError(err)}` });
    } finally {
      for (const f of uploaded) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  });

  // Resmi Comfy-Org & Mesh Atölye (BiRefNet -> MoGe -> Pixal3D / Hunyuan3D-2mv / SF3D) Workflow JSON + Otomatik HF İndirici + Canlı ComfyUI Köprüsü
  const DEFAULT_MODELS_ROOT = path.join(ROOT_DIR, 'models', 'comfyui');
  fs.mkdirSync(DEFAULT_MODELS_ROOT, { recursive: true });

  const resolveSafeModelsRoot = (rawDir?: string): string => {
    const trimmed = String(rawDir || '').trim();
    if (!trimmed) return DEFAULT_MODELS_ROOT;
    // Güvenlik: null byte ve sistem kök dizinlerini engelle
    if (trimmed.includes('\0') || trimmed === '/' || /^[a-zA-Z]:[\\/]?$/.test(trimmed)) {
      throw new Error('Geçersiz hedef model klasörü.');
    }
    const resolved = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(ROOT_DIR, trimmed);
    return resolved;
  };

  const resolveSafeLocalComfyUrl = (rawUrl?: string): URL => {
    const clean = String(rawUrl || 'http://127.0.0.1:8188').trim();
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      throw new Error('Geçersiz ComfyUI adresi (örn: http://127.0.0.1:8188).');
    }
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!isLoopback || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new Error('Güvenlik gereği yalnızca yerel ComfyUI adreslerine (127.0.0.1 / localhost) bağlanılabilir.');
    }
    return parsed;
  };

  interface ModelDownloadFileState {
    id: string;
    repo: string;
    file: string;
    targetPath: string;
    sizeHintGb: number;
    status: 'pending' | 'downloading' | 'skipped' | 'done' | 'error' | 'cancelled';
    downloadedBytes: number;
    totalBytes: number;
    percent: number;
    speedMbps: number;
    error?: string;
  }

  interface ModelDownloadJob {
    jobId: string;
    presetId: ComfyPresetId;
    targetRoot: string;
    status: 'running' | 'done' | 'error' | 'cancelled';
    files: ModelDownloadFileState[];
    currentFileIndex: number;
    overallPercent: number;
    startedAt: number;
    error?: string;
    abortController: AbortController;
  }

  const modelDownloadJobs = new Map<string, ModelDownloadJob>();

  app.get('/api/comfy/workflows', (_req, res) => {
    res.json({ presets: COMFY_WORKFLOW_PRESETS });
  });

  app.get('/api/comfy/workflow/:preset', (req, res) => {
    const raw = String(req.params.preset || 'pixal3d-int8');
    const valid: ComfyPresetId[] = [
      'pixal3d-int8',
      'pixal3d-single',
      'pixal3d-multiview',
      'hunyuan3d-mv',
      'sf3d',
      'hunyuan3d',
    ];
    if (!valid.includes(raw as ComfyPresetId)) {
      res.status(400).json({ error: 'Geçersiz ComfyUI workflow şablonu.' });
      return;
    }
    const wf = buildComfyUiWorkflowJson(raw as ComfyPresetId);
    res.json({ preset: raw, workflow: wf });
  });

  app.get('/api/comfy/setup-script', (req, res) => {
    const osKind = req.query.os === 'linux' ? 'linux' : 'windows';
    const rawPreset = String(req.query.preset || 'pixal3d-int8') as ComfyPresetId;
    const valid = COMFY_WORKFLOW_PRESETS.some((p) => p.id === rawPreset);
    const presetId: ComfyPresetId = valid ? rawPreset : 'pixal3d-int8';
    const script = buildComfySetupScript(osKind, presetId);
    const ext = osKind === 'windows' ? 'ps1' : 'sh';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="3bstudio_comfyui_${presetId}.${ext}"`);
    res.send(script);
  });

  // Disk üzerindeki mevcut / eksik Hugging Face ağırlıklarını tara
  app.get('/api/models/catalog', (req, res) => {
    try {
      const targetRoot = resolveSafeModelsRoot(typeof req.query.dir === 'string' ? req.query.dir : undefined);
      const presets = COMFY_WORKFLOW_PRESETS.map((preset) => {
        const weights = preset.weights.map((w) => {
          const fname = path.basename(w.file);
          const subDir = w.targetDir.replace(/^models[\\/]/, '');
          const fullPath = path.join(targetRoot, subDir, fname);
          let installed = false;
          let diskBytes = 0;
          try {
            const st = fs.statSync(fullPath);
            if (st.isFile() && st.size > 1024 * 1024) {
              installed = true;
              diskBytes = st.size;
            }
          } catch {
            // missing
          }
          return {
            ...w,
            filename: fname,
            targetPath: fullPath,
            installed,
            diskBytes,
          };
        });
        return {
          ...preset,
          installedCount: weights.filter((w) => w.installed).length,
          totalCount: weights.length,
          weights,
        };
      });
      res.json({ targetRoot, presets });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Resmi Hugging Face ağırlıklarını akışlı (streaming + .part atomik) indir
  app.post('/api/models/download', (req, res) => {
    try {
      const { presetId, targetDir, hfToken, weightIds } = req.body as {
        presetId?: ComfyPresetId;
        targetDir?: string;
        hfToken?: string;
        weightIds?: string[];
      };
      const preset = COMFY_WORKFLOW_PRESETS.find((p) => p.id === presetId);
      if (!preset) {
        res.status(400).json({ error: 'Geçersiz model paketi seçimi.' });
        return;
      }
      const targetRoot = resolveSafeModelsRoot(targetDir);
      fs.mkdirSync(targetRoot, { recursive: true });

      const selectedWeights =
        Array.isArray(weightIds) && weightIds.length > 0
          ? preset.weights.filter((w) => weightIds.includes(w.id))
          : preset.weights;

      if (selectedWeights.length === 0) {
        res.status(400).json({ error: 'İndirilecek ağırlık dosyası bulunamadı.' });
        return;
      }

      const jobId = `mdl_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
      const abortController = new AbortController();
      const files: ModelDownloadFileState[] = selectedWeights.map((w) => {
        const fname = path.basename(w.file);
        const subDir = w.targetDir.replace(/^models[\\/]/, '');
        return {
          id: w.id,
          repo: w.repo,
          file: w.file,
          targetPath: path.join(targetRoot, subDir, fname),
          sizeHintGb: w.sizeHintGb,
          status: 'pending',
          downloadedBytes: 0,
          totalBytes: Math.round(w.sizeHintGb * 1024 * 1024 * 1024),
          percent: 0,
          speedMbps: 0,
        };
      });

      const job: ModelDownloadJob = {
        jobId,
        presetId: preset.id,
        targetRoot,
        status: 'running',
        files,
        currentFileIndex: 0,
        overallPercent: 0,
        startedAt: Date.now(),
        abortController,
      };
      modelDownloadJobs.set(jobId, job);

      const cleanToken = (hfToken || process.env.HF_TOKEN || '').trim();
      const recomputeOverall = () => {
        const sum = job.files.reduce((acc, f) => acc + (f.status === 'done' || f.status === 'skipped' ? 100 : f.percent), 0);
        job.overallPercent = Math.round(sum / Math.max(1, job.files.length));
      };

      void (async () => {
        for (let i = 0; i < selectedWeights.length; i++) {
          if (abortController.signal.aborted) {
            job.files[i].status = 'cancelled';
            continue;
          }
          job.currentFileIndex = i;
          const spec = selectedWeights[i];
          const fState = job.files[i];

          // Zaten indirilmişse atla
          try {
            const existing = fs.statSync(fState.targetPath);
            if (existing.isFile() && existing.size > 1024 * 1024) {
              fState.status = 'skipped';
              fState.downloadedBytes = existing.size;
              fState.totalBytes = existing.size;
              fState.percent = 100;
              recomputeOverall();
              continue;
            }
          } catch {
            // yok, indirilecek
          }

          fs.mkdirSync(path.dirname(fState.targetPath), { recursive: true });
          const partPath = `${fState.targetPath}.part`;
          fState.status = 'downloading';
          const fileStartMs = Date.now();

          try {
            // Sadece resmi huggingface.co alanından indir
            const dlUrl = new URL(spec.downloadUrl);
            if (dlUrl.hostname !== 'huggingface.co' || dlUrl.protocol !== 'https:') {
              throw new Error('Yalnızca resmi huggingface.co ağırlık adreslerine izin verilir.');
            }
            const headers: Record<string, string> = { 'User-Agent': '3BStudio-Downloader/1.0' };
            if (cleanToken) headers.Authorization = `Bearer ${cleanToken}`;

            const resp = await fetch(dlUrl.toString(), {
              headers,
              redirect: 'follow',
              signal: abortController.signal,
            });
            if (!resp.ok || !resp.body) {
              if (resp.status === 401 || resp.status === 403) {
                throw new Error('Bu model için Hugging Face erişim anahtarı (HF Token) veya lisans onayı gerekiyor.');
              }
              throw new Error(`Hugging Face indirme hatası (HTTP ${resp.status})`);
            }

            const contentLen = Number(resp.headers.get('content-length') || 0);
            if (contentLen > 0) fState.totalBytes = contentLen;

            const outStream = fs.createWriteStream(partPath);
            const reader = resp.body.getReader();
            let received = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                  received += value.byteLength;
                  if (!outStream.write(Buffer.from(value))) {
                    await new Promise<void>((resolve) => outStream.once('drain', resolve));
                  }
                  const elapsedSec = Math.max(0.1, (Date.now() - fileStartMs) / 1000);
                  fState.downloadedBytes = received;
                  fState.speedMbps = Number((received / (1024 * 1024) / elapsedSec).toFixed(1));
                  fState.percent =
                    fState.totalBytes > 0
                      ? Math.min(99, Math.round((received / fState.totalBytes) * 100))
                      : 0;
                  recomputeOverall();
                }
              }
            } finally {
              await new Promise<void>((resolve) => outStream.end(() => resolve()));
            }

            fs.renameSync(partPath, fState.targetPath);
            fState.status = 'done';
            fState.percent = 100;
            recomputeOverall();
          } catch (err) {
            try {
              fs.unlinkSync(partPath);
            } catch {
              // ignore
            }
            if (abortController.signal.aborted) {
              fState.status = 'cancelled';
              job.status = 'cancelled';
              return;
            }
            fState.status = 'error';
            fState.error = (err as Error).message;
            job.status = 'error';
            job.error = `${spec.file}: ${(err as Error).message}`;
            return;
          }
        }

        if (job.status === 'running') {
          job.status = 'done';
          job.overallPercent = 100;
        }
      })();

      res.json({ jobId, targetRoot, totalFiles: files.length });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/models/download/:jobId', (req, res) => {
    const job = modelDownloadJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'İndirme işi bulunamadı.' });
      return;
    }
    res.json({
      jobId: job.jobId,
      presetId: job.presetId,
      targetRoot: job.targetRoot,
      status: job.status,
      currentFileIndex: job.currentFileIndex,
      overallPercent: job.overallPercent,
      elapsedSec: Math.round((Date.now() - job.startedAt) / 1000),
      error: job.error,
      files: job.files,
    });
  });

  app.post('/api/models/download/:jobId/cancel', (req, res) => {
    const job = modelDownloadJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'İndirme işi bulunamadı.' });
      return;
    }
    job.abortController.abort();
    job.status = 'cancelled';
    res.json({ ok: true });
  });

  // Canlı yerel ComfyUI (:8188) sağlık & GPU / düğüm kontrolü
  app.get('/api/comfy/ping', async (req, res) => {
    try {
      const base = resolveSafeLocalComfyUrl(typeof req.query.url === 'string' ? req.query.url : undefined);
      const statsResp = await withTimeout(fetch(`${base.origin}/system_stats`), 3500, 'ComfyUI ping');
      if (!statsResp.ok) {
        res.json({ online: false, url: base.origin, note: `HTTP ${statsResp.status}` });
        return;
      }
      const stats = (await statsResp.json()) as {
        devices?: Array<{ name?: string; vram_total?: number; vram_free?: number }>;
      };
      const gpu = stats.devices?.[0];
      const vramGb = gpu?.vram_total ? Number((gpu.vram_total / 1024 ** 3).toFixed(1)) : undefined;

      let hasPixal3d = false;
      let hasBiRefNet = false;
      let hasLocal3dPlus = false;
      try {
        const objResp = await withTimeout(fetch(`${base.origin}/object_info`), 3000, 'ComfyUI nodes');
        if (objResp.ok) {
          const objKeys = Object.keys((await objResp.json()) as Record<string, unknown>);
          hasPixal3d = objKeys.some((k) => /pixal3d|trellis/i.test(k));
          hasBiRefNet = objKeys.some((k) => /birefnet/i.test(k));
          hasLocal3dPlus = objKeys.some((k) => /trellisplus|local3d/i.test(k));
        }
      } catch {
        // node list optional
      }

      res.json({
        online: true,
        url: base.origin,
        gpuName: gpu?.name ?? 'Yerel GPU',
        vramGb,
        hasPixal3d,
        hasBiRefNet,
        hasLocal3dPlus,
      });
    } catch (err) {
      res.json({
        online: false,
        url: String(req.query.url || 'http://127.0.0.1:8188'),
        note: (err as Error).message,
      });
    }
  });

  // Canlı yerel ComfyUI'ye görsel yükleyip Pixal3D / Hunyuan3D / SF3D iş akışını kuyruğa ekle
  app.post('/api/comfy/run', async (req, res) => {
    try {
      const { comfyUrl, preset, imageDataUrl, textureSize, maxFaces } = req.body as {
        comfyUrl?: string;
        preset?: ComfyPresetId;
        imageDataUrl?: string;
        textureSize?: number;
        maxFaces?: number;
      };
      if (!imageDataUrl) {
        res.status(400).json({ error: 'ComfyUI üretimi için en az 1 ön fotoğraf gerekli.' });
        return;
      }
      const base = resolveSafeLocalComfyUrl(comfyUrl);
      const blob = dataUrlToBlob(imageDataUrl);
      const fileName = `3bstudio_${Date.now()}.png`;
      const form = new FormData();
      form.append('image', blob, fileName);
      form.append('overwrite', 'true');

      const uploadResp = await withTimeout(
        fetch(`${base.origin}/upload/image`, { method: 'POST', body: form }),
        15_000,
        'ComfyUI görsel yükleme'
      );
      if (!uploadResp.ok) {
        throw new Error(`ComfyUI görsel yüklenemedi (HTTP ${uploadResp.status}).`);
      }
      const uploaded = (await uploadResp.json()) as { name?: string };
      const workflow = buildComfyUiWorkflowJson(preset || 'pixal3d-int8', {
        inputFilename: uploaded.name || fileName,
        textureSize: textureSize ?? 2048,
        maxFaces: maxFaces ?? 40000,
      });
      // _meta alanını ComfyUI prompt API'sinden çıkar
      const promptGraph: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(workflow)) {
        if (k !== '_meta') promptGraph[k] = v;
      }

      const promptResp = await withTimeout(
        fetch(`${base.origin}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: promptGraph, client_id: '3bstudio' }),
        }),
        15_000,
        'ComfyUI kuyruk isteği'
      );
      if (!promptResp.ok) {
        const errText = await promptResp.text().catch(() => '');
        throw new Error(`ComfyUI akışı başlatılamadı (HTTP ${promptResp.status}): ${errText.slice(0, 180)}`);
      }
      const promptData = (await promptResp.json()) as { prompt_id?: string };
      if (!promptData.prompt_id) {
        throw new Error('ComfyUI geçerli bir prompt_id döndürmedi.');
      }
      res.json({ promptId: promptData.prompt_id, comfyUrl: base.origin });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Canlı ComfyUI üretim durumunu takip et ve bitince .glb dosyasını 3BStudio'ya al
  app.get('/api/comfy/status/:promptId', async (req, res) => {
    try {
      const promptId = String(req.params.promptId || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const base = resolveSafeLocalComfyUrl(typeof req.query.url === 'string' ? req.query.url : undefined);
      const histResp = await withTimeout(fetch(`${base.origin}/history/${promptId}`), 6000, 'ComfyUI geçmiş');
      if (!histResp.ok) {
        res.json({ status: 'running', stageLabel: 'ComfyUI GPU üzerinde işleniyor...' });
        return;
      }
      const histJson = (await histResp.json()) as Record<
        string,
        {
          status?: { completed?: boolean; status_str?: string };
          outputs?: Record<string, Record<string, Array<{ filename?: string; subfolder?: string; type?: string }>>>;
        }
      >;
      const entry = histJson[promptId];
      if (!entry) {
        res.json({ status: 'running', stageLabel: 'ComfyUI GPU kuyruğunda işleniyor...' });
        return;
      }
      if (entry.status?.status_str === 'error') {
        res.json({ status: 'error', error: 'ComfyUI düğüm yürütmesi hata ile sonlandı. ComfyUI konsolunu kontrol edin.' });
        return;
      }

      // Çıktılarda .glb / .obj dosyasını bul
      let foundFile: { filename: string; subfolder: string; type: string } | null = null;
      for (const nodeOut of Object.values(entry.outputs || {})) {
        for (const list of Object.values(nodeOut || {})) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            if (item?.filename && /\.(glb|gltf|obj|stl)$/i.test(item.filename)) {
              foundFile = {
                filename: item.filename,
                subfolder: item.subfolder || '',
                type: item.type || 'output',
              };
              break;
            }
          }
          if (foundFile) break;
        }
        if (foundFile) break;
      }

      if (!foundFile) {
        res.json({ status: 'running', stageLabel: 'Mesh & PBR doku dışa aktarılıyor...' });
        return;
      }

      // Dosyayı yerel ComfyUI /view uç noktasından indirip 3BStudio /uploads/models klasörüne kaydet
      const viewUrl = new URL(`${base.origin}/view`);
      viewUrl.searchParams.set('filename', foundFile.filename);
      if (foundFile.subfolder) viewUrl.searchParams.set('subfolder', foundFile.subfolder);
      viewUrl.searchParams.set('type', foundFile.type);

      const fileResp = await withTimeout(fetch(viewUrl.toString()), 25_000, 'ComfyUI GLB indirme');
      if (!fileResp.ok) {
        throw new Error(`ComfyUI çıktısı indirilemedi (HTTP ${fileResp.status}).`);
      }
      const buf = Buffer.from(await fileResp.arrayBuffer());
      const ext = path.extname(foundFile.filename) || '.glb';
      const localName = `comfy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`;
      const localPath = path.join(MODELS_DIR, localName);
      fs.writeFileSync(localPath, buf);

      res.json({
        status: 'done',
        modelUrl: `/uploads/models/${localName}`,
        filename: foundFile.filename,
      });
    } catch (err) {
      res.status(502).json({ status: 'error', error: (err as Error).message });
    }
  });

  app.post('/api/cad/generate', async (req, res) => {
    const { prompt, referenceImageDataUrl } = req.body as {
      prompt?: string;
      referenceImageDataUrl?: string;
    };

    const cleanPrompt = String(prompt || '').trim();
    if (cleanPrompt.length < 3) {
      res.status(400).json({ error: 'Lütfen üretmek istediğiniz parçayı kısaca tarif edin (örn: 4 delikli M4 braket).' });
      return;
    }
    if (cleanPrompt.length > 2000) {
      res.status(400).json({ error: 'CAD açıklaması en fazla 2000 karakter olabilir.' });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(503).json({
        error: 'Sunucuda GEMINI_API_KEY yapılandırılmamış. Hazır parametrik CAD şablonlarını kullanabilir veya AI Studio Secrets ayarından anahtar tanımlayabilirsiniz.',
      });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const buildContents = (extraFeedback?: string) => {
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
      if (referenceImageDataUrl && typeof referenceImageDataUrl === 'string') {
        const match = referenceImageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (match) {
          parts.push({
            inlineData: {
              mimeType: match[1],
              data: match[2],
            },
          });
        }
      }
      parts.push({
        text: extraFeedback
          ? `User CAD request: ${cleanPrompt}\n\nPrevious JSON failed CSG compilation with error: ${extraFeedback}\nFix the JSON CadSpec so every node and expression compiles cleanly into a manifold 3D solid.`
          : `User CAD request: ${cleanPrompt}\nDesign a detailed, 3D-printable parametric CAD part in mm with editable parameters and equivalent build123d Python code.`,
      });
      return { parts };
    };

    let lastError = 'Bilinmeyen CAD üretim hatası';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: buildContents(attempt === 1 ? lastError : undefined),
          config: {
            systemInstruction: CAD_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
          },
        });
        const raw = response.text;
        if (!raw) {
          throw new Error('Model boş yanıt döndürdü.');
        }
        const spec = parseCadSpecJson(raw);
        // Sunucu tarafında CSG derlemesini doğrulayarak kırık geometrileri otomatik onar
        const compiled = compileCadSpec(spec);
        compiled.dispose();
        res.json({ spec, model: 'gemini-4-hydrogen' });
        return;
      } catch (err) {
        lastError = (err as Error).message || 'CAD derleme hatası';
      }
    }

    res.status(502).json({
      error: `Parametrik CAD üretimi tamamlanamadı: ${lastError}`,
    });
  });

  app.post('/api/reconstruct/cloud', async (req, res) => {
    const { provider, apiKey, hfToken, spaceId, autoFallback, images } = req.body as {
      provider: 'huggingface' | 'fal' | 'tripo' | 'meshy';
      apiKey?: string;
      hfToken?: string;
      spaceId?: string;
      autoFallback?: boolean;
      images?: { front?: string; back?: string; left?: string; right?: string };
    };

    if (!images?.front) {
      res.status(400).json({ error: 'En az ön (front) fotoğrafı gereklidir.' });
      return;
    }

    try {
      if (provider === 'huggingface') {
        const primarySpace = (spaceId || FREE_HF_SPACES[0].id).trim();
        if (!VALID_SPACE_ID_RE.test(primarySpace)) {
          res.status(400).json({ error: 'Geçersiz Hugging Face Space ID formatı (örnek: tencent/Hunyuan3D-2mv).' });
          return;
        }
        const tokenOpt = hfToken && hfToken.startsWith('hf_') ? (hfToken as `hf_${string}`) : undefined;

        const candidates = autoFallback !== false
          ? [primarySpace, ...FREE_HF_SPACES.map((s) => s.id).filter((id) => id !== primarySpace)]
          : [primarySpace];

        const triedSpaces: Array<{ spaceId: string; error?: string }> = [];
        for (const candidate of candidates) {
          try {
            const localUrl = await runSingleHfSpace(
              candidate,
              {
                front: images.front,
                back: images.back,
                left: images.left,
                right: images.right,
              },
              tokenOpt
            );
            triedSpaces.push({ spaceId: candidate });
            res.json({
              modelUrl: localUrl,
              provider: 'huggingface',
              usedSpaceId: candidate,
              triedSpaces,
            });
            return;
          } catch (spaceErr) {
            triedSpaces.push({
              spaceId: candidate,
              error: (spaceErr as Error).message || 'Bağlantı hatası',
            });
          }
        }

        const summary = triedSpaces
          .map((t) => `${t.spaceId}: ${t.error}`)
          .slice(0, 3)
          .join(' | ');
        throw new Error(`Denenen ${triedSpaces.length} ücretsiz Hugging Face Space yanıt vermedi (${summary}).`);
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

  const httpServer = http.createServer(app);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configLoader: 'native',
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLanIp();
    console.log(`3BStudio API & UI hazir: http://localhost:${PORT} (LAN: http://${lanIp}:${PORT})`);
  });
}

startServer().catch((err) => {
  console.error('3BStudio sunucusu başlatılamadı:', err);
  process.exit(1);
});
