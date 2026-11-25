import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ViewportDisplayMode } from '../engine/types';
import { Download, Eye, Grid, RefreshCw, RotateCw } from 'lucide-react';

export interface ComparePaneItem {
  id: string;
  title: string;
  subtitle: string;
  badge?: string;
  geometry: THREE.BufferGeometry | null;
  texturedScene?: THREE.Group | null;
  /** Zorla kil / ham baz materyali göster (Local3D+ Baseline kıyası için). */
  forceClay?: boolean;
  triangleCount: number;
  iouPct?: number | null;
  onDownloadGlb?: () => void;
}

interface MultiCompareViewportProps {
  theme?: 'light' | 'dark';
  panes: ComparePaneItem[];
  layout: '2-up' | '4-up';
  displayMode: ViewportDisplayMode;
  showBedGrid: boolean;
  autoRotate: boolean;
  referencePhotoUrl?: string | null;
}

function disposeObject3DResources(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      // Do not dispose shared source geometries/textures owned by parent state;
      // only dispose materials we explicitly cloned/created for clay/wireframe overrides.
      if (mesh.userData.__ownedMaterial && mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => m.dispose());
      }
    }
  });
}

function createStudioLights(scene: THREE.Scene): void {
  const hemi = new THREE.HemisphereLight(0xf8fafc, 0x334155, 0.9);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
  keyLight.position.set(110, 180, 130);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xe0f2fe, 0.55);
  fillLight.position.set(-120, 75, -90);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xfef3c7, 0.42);
  rimLight.position.set(0, 95, -145);
  scene.add(rimLight);
}

function buildPaneObject(pane: ComparePaneItem, displayMode: ViewportDisplayMode): THREE.Object3D | null {
  if (!pane.geometry && !pane.texturedScene) return null;

  const showTextured = Boolean(pane.texturedScene) && !pane.forceClay && displayMode === 'solid';
  if (showTextured && pane.texturedScene) {
    const clone = pane.texturedScene.clone(true);
    return clone;
  }

  if (!pane.geometry) return null;
  const hasColors = Boolean(pane.geometry.getAttribute('color')) && !pane.forceClay;
  const mat =
    displayMode === 'wireframe'
      ? new THREE.MeshStandardMaterial({
          color: 0x0d9488,
          wireframe: true,
          roughness: 0.4,
        })
      : displayMode === 'xray'
        ? new THREE.MeshPhysicalMaterial({
            color: 0x0ea5e9,
            transparent: true,
            opacity: 0.38,
            roughness: 0.2,
            depthWrite: false,
            side: THREE.DoubleSide,
          })
        : new THREE.MeshStandardMaterial({
            color: pane.forceClay ? 0xcbd5e1 : hasColors ? 0xffffff : 0x38bdf8,
            vertexColors: hasColors,
            roughness: pane.forceClay ? 0.58 : 0.44,
            metalness: pane.forceClay ? 0.04 : 0.08,
            side: THREE.DoubleSide,
          });

  const mesh = new THREE.Mesh(pane.geometry, mat);
  mesh.userData.__ownedMaterial = true;
  return mesh;
}

/**
 * Local3D+ tarzı tek-WebGLRenderer Scissor/Viewport eşzamanlı çoklu 3D kıyaslama ekranı:
 * - Tek WebGL bağlamı kullanarak 2 veya 4 modeli aynı anda sıfır bağlam hatasıyla çizer.
 * - Tek paylaşımlı OrbitControls kamerasıyla tüm paneller milimetrik olarak birlikte döner.
 */
export const MultiCompareViewport: React.FC<MultiCompareViewportProps> = ({
  theme = 'light',
  panes,
  layout,
  displayMode,
  showBedGrid,
  autoRotate,
  referencePhotoUrl,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const scenesRef = useRef<THREE.Scene[]>([]);
  const envTexRef = useRef<THREE.Texture | null>(null);
  const softwareGlRef = useRef(false);
  const autoRotateRef = useRef(autoRotate);
  const layoutRef = useRef(layout);

  const [contextLost, setContextLost] = useState(false);
  const [ghostOpacity, setGhostOpacity] = useState(0);
  const [localAutoRotate, setLocalAutoRotate] = useState(autoRotate);
  const [localGrid, setLocalGrid] = useState(showBedGrid);

  autoRotateRef.current = localAutoRotate;
  layoutRef.current = layout;

  useEffect(() => {
    setLocalAutoRotate(autoRotate);
  }, [autoRotate]);

  useEffect(() => {
    setLocalGrid(showBedGrid);
  }, [showBedGrid]);

  const activeCount = layout === '2-up' ? 2 : 4;
  const visiblePanes = panes.slice(0, activeCount);

  // Initialize single shared WebGLRenderer + OrbitControls
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? String(gl?.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    const isSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(glRenderer);
    softwareGlRef.current = isSoftwareGl;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setScissorTest(true);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    host.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    let envRT: THREE.WebGLRenderTarget | null = null;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const roomEnv = new RoomEnvironment();
      envRT = pmrem.fromScene(roomEnv, 0.04);
      envTexRef.current = envRT.texture;
      roomEnv.dispose();
      pmrem.dispose();
    } catch {
      envTexRef.current = null;
    }

    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2500);
    camera.position.set(0, 52, 145);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 38, 0);
    controls.autoRotate = !isSoftwareGl && autoRotateRef.current;
    controls.autoRotateSpeed = 1.6;
    controls.update();
    controlsRef.current = controls;

    const onContextLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    const onContextRestored = () => setContextLost(false);
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

    const resizeObserver = new ResizeObserver(() => {
      if (!host) return;
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      renderer.setSize(w, h, false);
    });
    resizeObserver.observe(host);

    let rafId = 0;
    const animate = () => {
      rafId = requestAnimationFrame(animate);
      controls.autoRotate = !softwareGlRef.current && autoRotateRef.current;
      controls.update();

      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width <= 1 || height <= 1) return;

      const scenes = scenesRef.current;
      const cols = 2;
      const rows = layoutRef.current === '2-up' ? 1 : 2;
      const cellW = Math.floor(width / cols);
      const cellH = Math.floor(height / rows);

      camera.aspect = Math.max(0.2, cellW / Math.max(1, cellH));
      camera.updateProjectionMatrix();

      for (let i = 0; i < scenes.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        // Three.js viewport origin is bottom-left
        const x = col * cellW;
        const y = height - (row + 1) * cellH;
        const w = col === cols - 1 ? width - x : cellW;
        const h = row === rows - 1 ? y + cellH : cellH;

        renderer.setViewport(x, y, Math.max(1, w), Math.max(1, h));
        renderer.setScissor(x, y, Math.max(1, w), Math.max(1, h));
        renderer.render(scenes[i], camera);
      }
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      controls.dispose();
      for (const sc of scenesRef.current) {
        disposeObject3DResources(sc);
      }
      scenesRef.current = [];
      envRT?.dispose();
      envTexRef.current = null;
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
      rendererRef.current = null;
    };
  }, []);

  // Rebuild scenes when panes, theme, displayMode, or bed grid change
  useEffect(() => {
    for (const oldScene of scenesRef.current) {
      disposeObject3DResources(oldScene);
    }

    const bgHex = theme === 'dark' ? 0x090d16 : 0xeef2f6;
    const gridMain = theme === 'dark' ? 0x0d9488 : 0x64748b;
    const gridSub = theme === 'dark' ? 0x1e293b : 0xcbd5e1;

    const nextScenes: THREE.Scene[] = [];
    let refBox: THREE.Box3 | null = null;

    for (let i = 0; i < activeCount; i++) {
      const pane = visiblePanes[i];
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(bgHex);
      if (envTexRef.current) {
        scene.environment = envTexRef.current;
      }
      createStudioLights(scene);

      if (localGrid) {
        const grid = new THREE.GridHelper(180, 18, gridMain, gridSub);
        grid.position.y = 0.02;
        scene.add(grid);
      }

      if (pane) {
        const obj = buildPaneObject(pane, displayMode);
        if (obj) {
          scene.add(obj);
          if (!refBox && pane.geometry) {
            pane.geometry.computeBoundingBox();
            if (pane.geometry.boundingBox && !pane.geometry.boundingBox.isEmpty()) {
              refBox = pane.geometry.boundingBox.clone();
            }
          }
        }
      }

      nextScenes.push(scene);
    }

    scenesRef.current = nextScenes;

    // Frame shared camera cleanly around reference model bounds on first population
    if (refBox && cameraRef.current && controlsRef.current) {
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      refBox.getSize(size);
      refBox.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z, 20);
      controlsRef.current.target.copy(center);
      cameraRef.current.position.set(center.x, center.y + maxDim * 0.12, center.z + maxDim * 1.95);
      controlsRef.current.update();
    }
  }, [panes, activeCount, theme, displayMode, localGrid]);

  const resetSyncCamera = (view: 'front' | 'three-quarter' | 'side' | 'back') => {
    if (!cameraRef.current || !controlsRef.current) return;
    const firstGeo = visiblePanes.find((p) => p.geometry)?.geometry ?? null;
    const center = new THREE.Vector3(0, 36, 0);
    let maxDim = 80;
    if (firstGeo) {
      firstGeo.computeBoundingBox();
      if (firstGeo.boundingBox && !firstGeo.boundingBox.isEmpty()) {
        const sz = new THREE.Vector3();
        firstGeo.boundingBox.getSize(sz);
        firstGeo.boundingBox.getCenter(center);
        maxDim = Math.max(sz.x, sz.y, sz.z, 20);
      }
    }
    const dist = maxDim * 1.95;
    controlsRef.current.target.copy(center);
    if (view === 'front') {
      cameraRef.current.position.set(center.x, center.y, center.z + dist);
    } else if (view === 'side') {
      cameraRef.current.position.set(center.x + dist, center.y, center.z);
    } else if (view === 'back') {
      cameraRef.current.position.set(center.x, center.y, center.z - dist);
    } else {
      cameraRef.current.position.set(center.x + dist * 0.65, center.y + dist * 0.35, center.z + dist * 0.75);
    }
    controlsRef.current.update();
  };

  return (
    <div className="relative w-full h-full min-h-[420px] bg-slate-100 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden select-none">
      {/* Single shared WebGL canvas */}
      <div ref={hostRef} className="w-full h-full" />

      {/* Semantic DOM Grid Dividers & Per-Pane HUD Labels (Pointer-events-none except buttons) */}
      <div
        className={`absolute inset-0 pointer-events-none grid ${
          layout === '2-up' ? 'grid-cols-2 grid-rows-1' : 'grid-cols-2 grid-rows-2'
        }`}
      >
        {visiblePanes.map((pane, idx) => (
          <div
            key={pane.id}
            className="relative border border-slate-300/80 dark:border-slate-800/90 flex flex-col justify-between p-2.5 overflow-hidden"
          >
            {/* Optional Reference Photo Ghost Overlay for 1:1 proportion verification */}
            {ghostOpacity > 0 && referencePhotoUrl && (
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none p-8"
                style={{ opacity: ghostOpacity / 100 }}
              >
                <img
                  src={referencePhotoUrl}
                  alt="Referans oran örtüsü"
                  className="max-w-[78%] max-h-[82%] object-contain"
                />
              </div>
            )}

            {/* Top Left Label */}
            <div className="relative z-10 flex items-start justify-between gap-2">
              <div className="bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1 shadow-sm">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono font-bold text-teal-700 dark:text-teal-400">
                    0{idx + 1}
                  </span>
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {pane.title}
                  </span>
                  {pane.badge && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                      {pane.badge}
                    </span>
                  )}
                </div>
                <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                  {pane.subtitle} · {pane.triangleCount.toLocaleString('tr-TR')} △
                  {typeof pane.iouPct === 'number' && (
                    <span className="ml-1.5 text-teal-700 dark:text-teal-400 font-semibold">
                      · Uyum %{pane.iouPct}
                    </span>
                  )}
                </div>
              </div>

              {pane.onDownloadGlb && pane.geometry && (
                <button
                  type="button"
                  onClick={pane.onDownloadGlb}
                  className="pointer-events-auto px-2 py-1 rounded-md bg-white/95 dark:bg-slate-900/95 hover:bg-slate-900 hover:text-white dark:hover:bg-teal-500 dark:hover:text-slate-950 border border-slate-200 dark:border-slate-700 text-[10px] font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1 shadow-sm transition"
                  title={`${pane.title} GLB İndir`}
                >
                  <Download className="w-3 h-3" />
                  GLB
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Shared Synchronized Camera Controls Bar (Bottom Center) */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-xl px-2.5 py-1.5 shadow-sm max-w-[96%] overflow-x-auto">
        <span className="text-[10px] font-mono font-semibold text-teal-700 dark:text-teal-400 whitespace-nowrap">
          SENKRON KAMERA
        </span>
        <div className="w-px h-4 bg-slate-200 dark:bg-slate-700" />
        {(
          [
            { id: 'front', label: 'Ön 0°' },
            { id: 'side', label: 'Yan 90°' },
            { id: 'back', label: 'Arka 180°' },
            { id: 'three-quarter', label: '3/4' },
          ] as const
        ).map((cam) => (
          <button
            key={cam.id}
            type="button"
            onClick={() => resetSyncCamera(cam.id)}
            className="px-2 py-1 rounded text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap transition"
          >
            {cam.label}
          </button>
        ))}

        {referencePhotoUrl && (
          <>
            <div className="w-px h-4 bg-slate-200 dark:bg-slate-700" />
            <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 whitespace-nowrap">
              <Eye className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              <span>Oran Örtüsü</span>
              <input
                type="range"
                min={0}
                max={70}
                step={5}
                value={ghostOpacity}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setGhostOpacity(val);
                  if (val > 0) resetSyncCamera('front');
                }}
                className="w-16 accent-teal-600"
              />
              <span className="font-mono text-[10px] w-7">%{ghostOpacity}</span>
            </label>
          </>
        )}

        <div className="w-px h-4 bg-slate-200 dark:bg-slate-700" />
        <button
          type="button"
          onClick={() => setLocalGrid((g) => !g)}
          title="Izgara"
          className={`p-1 rounded transition ${
            localGrid
              ? 'text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-500/15'
              : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          <Grid className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setLocalAutoRotate((r) => !r)}
          title="Otomatik Döndür"
          className={`p-1 rounded transition ${
            localAutoRotate
              ? 'text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-500/15'
              : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => resetSyncCamera('front')}
          title="Kamerayı Sıfırla"
          className="p-1 rounded text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {contextLost && (
        <div className="absolute inset-0 z-30 bg-slate-100/95 dark:bg-slate-950/95 flex items-center justify-center p-6 text-center">
          <div className="max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4 text-xs text-slate-600 dark:text-slate-300">
            WebGL bağlamı yeniden başlatılıyor...
          </div>
        </div>
      )}
    </div>
  );
};
