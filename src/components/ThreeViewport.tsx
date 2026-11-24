import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshStats, ViewportDisplayMode } from '../engine/types';
import { RotateCw, Grid, Box, Layers, Eye, RefreshCw } from 'lucide-react';

interface ThreeViewportProps {
  geometry: THREE.BufferGeometry | null;
  stats: MeshStats | null;
  displayMode: ViewportDisplayMode;
  onDisplayModeChange: (mode: ViewportDisplayMode) => void;
  showBedGrid: boolean;
  onToggleBedGrid: () => void;
  autoRotate: boolean;
  onToggleAutoRotate: () => void;
  isBusy?: boolean;
  busyLabel?: string;
  /** Rig modu: verilirse normal mesh yerine SkinnedMesh gösterilir. */
  skinnedMesh?: THREE.SkinnedMesh | null;
  activeClip?: THREE.AnimationClip | null;
  wireframeRig?: boolean;
}

export const ThreeViewport: React.FC<ThreeViewportProps> = ({
  geometry,
  stats,
  displayMode,
  onDisplayModeChange,
  showBedGrid,
  onToggleBedGrid,
  autoRotate,
  onToggleAutoRotate,
  isBusy,
  busyLabel,
  skinnedMesh,
  activeClip,
  wireframeRig,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const skinnedRef = useRef<THREE.SkinnedMesh | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const boxHelperRef = useRef<THREE.BoxHelper | null>(null);
  const gridGroupRef = useRef<THREE.Group | null>(null);
  const autoRotateRef = useRef(autoRotate);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate;
    }
  }, [autoRotate]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090d16);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      42,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.5,
      2000
    );
    camera.position.set(110, 85, 130);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.autoRotate = autoRotateRef.current;
    controls.autoRotateSpeed = 1.6;
    controls.target.set(0, 20, 0);
    controlsRef.current = controls;

    // Studio lighting
    const hemi = new THREE.HemisphereLight(0xe2e8f0, 0x1e293b, 0.85);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(120, 200, 140);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 20;
    keyLight.shadow.camera.far = 500;
    const d = 140;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.65);
    rimLight.position.set(-140, 80, -120);
    scene.add(rimLight);

    // 220x220 mm Print Bed (Ender 3 / Bambu style grid)
    const bedGroup = new THREE.Group();
    const grid = new THREE.GridHelper(220, 22, 0x334155, 0x1e293b);
    bedGroup.add(grid);

    const bedPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.9,
        metalness: 0.1,
        transparent: true,
        opacity: 0.65,
      })
    );
    bedPlane.rotation.x = -Math.PI / 2;
    bedPlane.position.y = -0.05;
    bedPlane.receiveShadow = true;
    bedGroup.add(bedPlane);

    const axes = new THREE.AxesHelper(35);
    axes.position.set(-108, 0.2, 108);
    bedGroup.add(axes);

    scene.add(bedGroup);
    gridGroupRef.current = bedGroup;

    let animId = 0;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      if (mixerRef.current) {
        mixerRef.current.update(clockRef.current.getDelta());
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      if (!container) return;
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    if (gridGroupRef.current) {
      gridGroupRef.current.visible = showBedGrid;
    }
  }, [showBedGrid]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (meshRef.current) {
      scene.remove(meshRef.current);
      (meshRef.current.material as THREE.Material).dispose();
      meshRef.current = null;
    }
    if (skinnedRef.current) {
      scene.remove(skinnedRef.current);
      skinnedRef.current = null;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
    }
    if (boxHelperRef.current) {
      scene.remove(boxHelperRef.current);
      boxHelperRef.current.dispose();
      boxHelperRef.current = null;
    }

    // RIG MODU: SkinnedMesh doğrudan sahneye eklenir; baskı mesh'i yerine geçer.
    if (skinnedMesh) {
      const m = skinnedMesh.material as THREE.MeshStandardMaterial;
      m.wireframe = wireframeRig ?? false;
      scene.add(skinnedMesh);
      skinnedRef.current = skinnedMesh;

      // Kamerayı rig etrafına çerçevele
      skinnedMesh.geometry.computeBoundingBox();
      const rbox = skinnedMesh.geometry.boundingBox;
      if (rbox && cameraRef.current && controlsRef.current) {
        const rsize = new THREE.Vector3();
        const rcenter = new THREE.Vector3();
        rbox.getSize(rsize);
        rbox.getCenter(rcenter);
        const rmax = Math.max(rsize.x, rsize.y, rsize.z, 20);
        controlsRef.current.target.copy(rcenter);
        cameraRef.current.position.set(
          rcenter.x + rmax * 1.45,
          rcenter.y + rmax * 0.9,
          rcenter.z + rmax * 1.65
        );
        cameraRef.current.updateProjectionMatrix();
        controlsRef.current.update();
      }
      return;
    }

    if (!geometry) return;

    let mat: THREE.Material;
    if (displayMode === 'wireframe') {
      mat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        wireframe: true,
        roughness: 0.4,
      });
    } else if (displayMode === 'xray') {
      mat = new THREE.MeshPhysicalMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.45,
        roughness: 0.2,
        side: THREE.DoubleSide,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        roughness: 0.38,
        metalness: 0.15,
        flatShading: false,
      });
    }

    const mesh = new THREE.Mesh(geometry, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshRef.current = mesh;

    const boxHelper = new THREE.BoxHelper(mesh, 0x0ea5e9);
    (boxHelper.material as THREE.LineBasicMaterial).transparent = true;
    (boxHelper.material as THREE.LineBasicMaterial).opacity = 0.35;
    scene.add(boxHelper);
    boxHelperRef.current = boxHelper;

    // Frame camera nicely around object
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box && cameraRef.current && controlsRef.current) {
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z, 20);
      controlsRef.current.target.copy(center);
      cameraRef.current.position.set(
        center.x + maxDim * 1.45,
        center.y + maxDim * 1.05,
        center.z + maxDim * 1.65
      );
      controlsRef.current.update();
    }
  }, [geometry, displayMode, skinnedMesh, wireframeRig]);

  // Animasyon klibi değişince mixer'ı yeniden kur
  useEffect(() => {
    const target = skinnedRef.current;
    if (!target) return;
    mixerRef.current?.stopAllAction();
    if (!activeClip) {
      mixerRef.current = null;
      return;
    }
    const mixer = new THREE.AnimationMixer(target);
    const action = mixer.clipAction(activeClip);
    action.reset().play();
    mixerRef.current = mixer;
  }, [activeClip, skinnedMesh]);

  const resetCamera = () => {
    if (!cameraRef.current || !controlsRef.current) return;
    if (geometry?.boundingBox) {
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      geometry.boundingBox.getSize(size);
      geometry.boundingBox.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z, 20);
      controlsRef.current.target.copy(center);
      cameraRef.current.position.set(
        center.x + maxDim * 1.45,
        center.y + maxDim * 1.05,
        center.z + maxDim * 1.65
      );
    } else {
      controlsRef.current.target.set(0, 20, 0);
      cameraRef.current.position.set(110, 85, 130);
    }
    controlsRef.current.update();
  };

  return (
    <div className="relative w-full h-full min-h-[380px] bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />

      {/* Top Left Dimension Overlay */}
      {stats && (
        <div className="absolute top-3 left-3 pointer-events-none flex flex-wrap gap-2">
          <div className="bg-slate-900/85 backdrop-blur-md border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 shadow-lg">
            <span className="text-cyan-400 font-semibold">Boyut:</span>{' '}
            {stats.widthMm} × {stats.depthMm} × {stats.heightMm} mm
          </div>
          <div className="bg-slate-900/85 backdrop-blur-md border border-slate-700/80 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 shadow-lg">
            <span className="text-emerald-400 font-semibold">Poligon:</span>{' '}
            {stats.triangleCount.toLocaleString('tr-TR')}
          </div>
        </div>
      )}

      {/* Top Right Toolbar */}
      <div className="absolute top-3 right-3 flex items-center gap-1 bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-lg p-1 shadow-lg">
        <button
          onClick={() => onDisplayModeChange('solid')}
          title="Katı Görünüm"
          className={`px-2.5 py-1.5 rounded text-xs flex items-center gap-1 transition ${
            displayMode === 'solid'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <Box className="w-3.5 h-3.5" />
          Katı
        </button>
        <button
          onClick={() => onDisplayModeChange('wireframe')}
          title="Poligon Tel Kafes"
          className={`px-2.5 py-1.5 rounded text-xs flex items-center gap-1 transition ${
            displayMode === 'wireframe'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          Kafes
        </button>
        <button
          onClick={() => onDisplayModeChange('xray')}
          title="X-Ray Şeffaf"
          className={`px-2.5 py-1.5 rounded text-xs flex items-center gap-1 transition ${
            displayMode === 'xray'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          <Eye className="w-3.5 h-3.5" />
          X-Ray
        </button>
        <div className="w-px h-4 bg-slate-700 mx-0.5" />
        <button
          onClick={onToggleBedGrid}
          title="220×220 mm Yazıcı Tablası"
          className={`p-1.5 rounded transition ${
            showBedGrid ? 'text-cyan-400 bg-cyan-500/10' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Grid className="w-4 h-4" />
        </button>
        <button
          onClick={onToggleAutoRotate}
          title="Otomatik Döndür"
          className={`p-1.5 rounded transition ${
            autoRotate ? 'text-cyan-400 bg-cyan-500/10' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <RotateCw className="w-4 h-4" />
        </button>
        <button
          onClick={resetCamera}
          title="Kamerayı Sıfırla"
          className="p-1.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Empty State */}
      {!geometry && !isBusy && (
        <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center text-center p-6">
          <div className="bg-slate-900/80 backdrop-blur border border-slate-800 rounded-2xl px-6 py-5 max-w-md shadow-2xl">
            <p className="text-base font-semibold text-slate-100 mb-1">
              220 × 220 mm 3D Yazıcı Tablası Hazır
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">
              Sol panelden 3–4 fotoğraf yükleyin (veya üstten <strong className="text-cyan-300">Örnek Parça</strong> /{' '}
              <strong className="text-cyan-300">Android QR Tara</strong> seçin), arkaplanları temizleyip 3D model oluşturun.
            </p>
          </div>
        </div>
      )}

      {/* Busy Overlay */}
      {isBusy && (
        <div className="absolute inset-0 bg-slate-950/75 backdrop-blur-sm flex flex-col items-center justify-center z-20">
          <div className="w-10 h-10 border-4 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mb-3" />
          <p className="text-sm font-medium text-cyan-200">{busyLabel || 'İşleniyor...'}</p>
        </div>
      )}

      {/* Bottom hint */}
      <div className="absolute bottom-2.5 left-3 pointer-events-none text-[11px] text-slate-500">
        Sol tık: Döndür • Sağ tık: Kaydır • Tekerlek: Yakınlaş • Taban Z=0 mm
      </div>
    </div>
  );
};
