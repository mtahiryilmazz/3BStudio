import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshStats, ViewportDisplayMode } from '../engine/types';
import { buildOverhangColorGeometry } from '../engine/meshRepair';
import type {
  DensePointCloudData,
  LodTier,
  PhotogrammetryStage,
  VirtualCameraPose,
} from '../engine/photogrammetry';
import {
  RotateCw,
  Grid,
  Box,
  Layers,
  Eye,
  RefreshCw,
  ShieldAlert,
  Camera,
  Sparkles,
  Columns2,
} from 'lucide-react';

interface ThreeViewportProps {
  theme?: 'light' | 'dark';
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
  /** Bulut/GLB veya 2K yerel PBR pişirmesinden gelen dokulu sahne. */
  texturedScene?: THREE.Group | null;
  /** 3DF Zephyr 4 aşamalı fotogrametri görünüm aşaması. */
  photogrammetryStage?: PhotogrammetryStage;
  onPhotogrammetryStageChange?: (stage: PhotogrammetryStage) => void;
  cameraRig?: VirtualCameraPose[];
  denseCloud?: DensePointCloudData | null;
  showCameraRig?: boolean;
  onToggleCameraRig?: () => void;
  /** Local3D+ Çoklu LOD anahtarı */
  activeLod?: LodTier;
  onLodChange?: (tier: LodTier) => void;
  /** Local3D+ Fotoğraf ↔ 3D Kıyaslama */
  comparePhotoUrl?: string | null;
  showPhotoCompare?: boolean;
  onTogglePhotoCompare?: () => void;
}

export const ThreeViewport: React.FC<ThreeViewportProps> = ({
  theme = 'light',
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
  texturedScene,
  photogrammetryStage = 'textured',
  onPhotogrammetryStageChange,
  cameraRig,
  denseCloud,
  showCameraRig = false,
  onToggleCameraRig,
  activeLod = 'full',
  onLodChange,
  comparePhotoUrl,
  showPhotoCompare = false,
  onTogglePhotoCompare,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const overhangGeoRef = useRef<THREE.BufferGeometry | null>(null);
  const texturedRef = useRef<THREE.Group | null>(null);
  const pointCloudRef = useRef<THREE.Points | null>(null);
  const cameraRigGroupRef = useRef<THREE.Group | null>(null);
  const skinnedRef = useRef<THREE.SkinnedMesh | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const boxHelperRef = useRef<THREE.BoxHelper | null>(null);
  const gridGroupRef = useRef<THREE.Group | null>(null);
  const bedPlaneRef = useRef<THREE.Mesh | null>(null);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const autoRotateRef = useRef(autoRotate);
  const softwareGlRef = useRef(false);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
    if (controlsRef.current) {
      controlsRef.current.autoRotate = !softwareGlRef.current && autoRotate;
    }
  }, [autoRotate]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme === 'dark' ? 0x090d16 : 0xeef2f6);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      42,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.5,
      2000
    );
    camera.position.set(110, 85, 130);
    cameraRef.current = camera;

    const probeCanvas = document.createElement('canvas');
    const probeGl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
    const dbg = probeGl?.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? String(probeGl?.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    const isSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(glRenderer);
    softwareGlRef.current = isSoftwareGl;

    const renderer = new THREE.WebGLRenderer({ antialias: !isSoftwareGl, preserveDrawingBuffer: true });
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Studio IBL reflections for metallic / clay / vertex-colored surfaces
    let envRT: THREE.WebGLRenderTarget | null = null;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const roomEnv = new RoomEnvironment();
      envRT = pmrem.fromScene(roomEnv, 0.04);
      scene.environment = envRT.texture;
      roomEnv.dispose();
      pmrem.dispose();
    } catch {
      // Ignore if environment generation fails on constrained WebGL contexts
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.autoRotate = !isSoftwareGl && autoRotateRef.current;
    controls.autoRotateSpeed = 1.6;
    controls.target.set(0, 20, 0);
    controlsRef.current = controls;

    // Studio lighting
    const hemi = new THREE.HemisphereLight(0xe2e8f0, 0x1e293b, 0.85);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(120, 200, 140);
    keyLight.castShadow = !isSoftwareGl;
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
    const isDark = theme === 'dark';
    const grid = new THREE.GridHelper(220, 22, isDark ? 0x334155 : 0x94a3b8, isDark ? 0x1e293b : 0xcbd5e1);
    bedGroup.add(grid);
    gridHelperRef.current = grid;

    const bedPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      new THREE.MeshStandardMaterial({
        color: isDark ? 0x0f172a : 0xf8fafc,
        roughness: 0.92,
        metalness: 0.05,
        transparent: true,
        opacity: isDark ? 0.65 : 0.78,
      })
    );
    bedPlane.rotation.x = -Math.PI / 2;
    bedPlane.position.y = -0.05;
    bedPlane.receiveShadow = !isSoftwareGl;
    bedGroup.add(bedPlane);
    bedPlaneRef.current = bedPlane;

    const axes = new THREE.AxesHelper(35);
    axes.position.set(-108, 0.2, 108);
    bedGroup.add(axes);

    scene.add(bedGroup);
    gridGroupRef.current = bedGroup;

    let animId = 0;
    let timerId: number | null = null;
    let disposed = false;

    const afterDraw = (done: () => void) => {
      const gl = renderer.getContext();
      if (gl instanceof WebGL2RenderingContext) {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (sync) {
          gl.flush();
          const poll = () => {
            if (disposed) {
              gl.deleteSync(sync);
              return;
            }
            if (gl.clientWaitSync(sync, 0, 0) !== gl.TIMEOUT_EXPIRED) {
              gl.deleteSync(sync);
              done();
            } else {
              timerId = window.setTimeout(poll, 16);
            }
          };
          poll();
          return;
        }
      }
      timerId = window.setTimeout(done, 16);
    };

    const animate = () => {
      if (disposed) return;
      if (mixerRef.current) {
        mixerRef.current.update(clockRef.current.getDelta());
      }
      controls.update();
      renderer.render(scene, camera);
      if (isSoftwareGl) {
        afterDraw(() => {
          if (!disposed) {
            timerId = window.setTimeout(() => {
              if (!disposed) animId = requestAnimationFrame(animate);
            }, 80);
          }
        });
      } else {
        animId = requestAnimationFrame(animate);
      }
    };
    animId = requestAnimationFrame(animate);

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
      disposed = true;
      cancelAnimationFrame(animId);
      if (timerId !== null) clearTimeout(timerId);
      ro.disconnect();
      controls.dispose();
      envRT?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    if (gridGroupRef.current) {
      gridGroupRef.current.visible = showBedGrid;
    }
  }, [showBedGrid]);

  // Tema değiştiğinde 3D sahne arka planı ve yazıcı tablası renklerini canlı senkronize et
  useEffect(() => {
    const isDark = theme === 'dark';
    if (sceneRef.current) {
      sceneRef.current.background = new THREE.Color(isDark ? 0x090d16 : 0xeef2f6);
    }
    if (bedPlaneRef.current) {
      const mat = bedPlaneRef.current.material as THREE.MeshStandardMaterial;
      mat.color.setHex(isDark ? 0x0f172a : 0xf8fafc);
      mat.opacity = isDark ? 0.65 : 0.78;
      mat.needsUpdate = true;
    }
    if (gridGroupRef.current && gridHelperRef.current) {
      gridGroupRef.current.remove(gridHelperRef.current);
      gridHelperRef.current.geometry.dispose();
      const gm = gridHelperRef.current.material;
      if (Array.isArray(gm)) gm.forEach((m) => m.dispose());
      else gm.dispose();
      const nextGrid = new THREE.GridHelper(
        220,
        22,
        isDark ? 0x334155 : 0x94a3b8,
        isDark ? 0x1e293b : 0xcbd5e1
      );
      gridGroupRef.current.add(nextGrid);
      gridHelperRef.current = nextGrid;
    }
  }, [theme]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (meshRef.current) {
      scene.remove(meshRef.current);
      (meshRef.current.material as THREE.Material).dispose();
      meshRef.current = null;
    }
    if (overhangGeoRef.current) {
      overhangGeoRef.current.dispose();
      overhangGeoRef.current = null;
    }
    if (texturedRef.current) {
      scene.remove(texturedRef.current);
      texturedRef.current = null;
    }
    if (pointCloudRef.current) {
      scene.remove(pointCloudRef.current);
      pointCloudRef.current.geometry.dispose();
      (pointCloudRef.current.material as THREE.Material).dispose();
      pointCloudRef.current = null;
    }
    if (cameraRigGroupRef.current) {
      scene.remove(cameraRigGroupRef.current);
      cameraRigGroupRef.current.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
        const m = (obj as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else if (m) m.dispose();
      });
      cameraRigGroupRef.current = null;
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

    // 3DF Zephyr Aşama 1: 3D Sanal Kamera Piramitleri (Frustum Rig)
    const shouldRenderCameras =
      Boolean(cameraRig && cameraRig.length > 0) &&
      (photogrammetryStage === 'cameras' || showCameraRig);
    if (shouldRenderCameras && cameraRig) {
      const rigGroup = new THREE.Group();
      const frustumMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85 });
      const rayMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.28 });
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x06b6d4, roughness: 0.35, metalness: 0.4 });
      const camBoxGeo = new THREE.BoxGeometry(4.5, 3.2, 2.4);

      for (const cam of cameraRig) {
        const pos = new THREE.Vector3(...cam.position);
        const tgt = new THREE.Vector3(...cam.target);
        const dir = new THREE.Vector3().subVectors(tgt, pos).normalize();
        const up = Math.abs(dir.y) > 0.92 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
        const rightVec = new THREE.Vector3().crossVectors(dir, up).normalize();
        const trueUp = new THREE.Vector3().crossVectors(rightVec, dir).normalize();

        const camBody = new THREE.Mesh(camBoxGeo.clone(), bodyMat.clone());
        camBody.position.copy(pos);
        camBody.lookAt(tgt);
        rigGroup.add(camBody);

        // Görüş piramidi (frustum)
        const depth = 12;
        const hw = 5.4;
        const hh = 7.2;
        const fc = pos.clone().addScaledVector(dir, depth);
        const c1 = fc.clone().addScaledVector(rightVec, -hw).addScaledVector(trueUp, hh);
        const c2 = fc.clone().addScaledVector(rightVec, hw).addScaledVector(trueUp, hh);
        const c3 = fc.clone().addScaledVector(rightVec, hw).addScaledVector(trueUp, -hh);
        const c4 = fc.clone().addScaledVector(rightVec, -hw).addScaledVector(trueUp, -hh);
        const fPts = [pos, c1, pos, c2, pos, c3, pos, c4, c1, c2, c2, c3, c3, c4, c4, c1];
        const fGeo = new THREE.BufferGeometry().setFromPoints(fPts);
        rigGroup.add(new THREE.LineSegments(fGeo, frustumMat.clone()));

        // Optik eksen çizgisi
        const rayGeo = new THREE.BufferGeometry().setFromPoints([pos, tgt]);
        rigGroup.add(new THREE.Line(rayGeo, rayMat.clone()));
      }
      camBoxGeo.dispose();
      frustumMat.dispose();
      rayMat.dispose();
      bodyMat.dispose();
      scene.add(rigGroup);
      cameraRigGroupRef.current = rigGroup;
    }

    // 3DF Zephyr Aşama 1 veya 2: Renkli Yoğun Nokta Bulutu (THREE.Points)
    if ((photogrammetryStage === 'pointcloud' || photogrammetryStage === 'cameras') && denseCloud && denseCloud.count > 0) {
      const pcGeo = new THREE.BufferGeometry();
      if (photogrammetryStage === 'cameras') {
        // Aşama 1 (SfM): Seyrek bağ noktaları görünümü (her 6. nokta)
        const stride = Math.max(1, Math.floor(denseCloud.count / 1800));
        const sparseCount = Math.ceil(denseCloud.count / stride);
        const spPos = new Float32Array(sparseCount * 3);
        const spCol = new Float32Array(sparseCount * 3);
        let k = 0;
        for (let i = 0; i < denseCloud.count && k < sparseCount; i += stride) {
          spPos[k * 3] = denseCloud.positions[i * 3];
          spPos[k * 3 + 1] = denseCloud.positions[i * 3 + 1];
          spPos[k * 3 + 2] = denseCloud.positions[i * 3 + 2];
          spCol[k * 3] = denseCloud.colors[i * 3];
          spCol[k * 3 + 1] = denseCloud.colors[i * 3 + 1];
          spCol[k * 3 + 2] = denseCloud.colors[i * 3 + 2];
          k++;
        }
        pcGeo.setAttribute('position', new THREE.BufferAttribute(spPos.subarray(0, k * 3), 3));
        pcGeo.setAttribute('color', new THREE.BufferAttribute(spCol.subarray(0, k * 3), 3));
      } else {
        pcGeo.setAttribute('position', new THREE.BufferAttribute(denseCloud.positions.slice(), 3));
        pcGeo.setAttribute('color', new THREE.BufferAttribute(denseCloud.colors.slice(), 3));
      }
      const pcMat = new THREE.PointsMaterial({
        size: photogrammetryStage === 'cameras' ? 1.8 : 1.35,
        vertexColors: true,
        sizeAttenuation: true,
      });
      const pts = new THREE.Points(pcGeo, pcMat);
      scene.add(pts);
      pointCloudRef.current = pts;

      geometry.computeBoundingBox();
      const pbox = geometry.boundingBox;
      if (pbox && cameraRef.current && controlsRef.current) {
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        pbox.getSize(size);
        pbox.getCenter(center);
        const maxDim = Math.max(size.x, size.y, size.z, 20) * (photogrammetryStage === 'cameras' ? 2.15 : 1.55);
        controlsRef.current.target.copy(center);
        cameraRef.current.position.set(
          center.x + maxDim * 1.15,
          center.y + maxDim * 0.78,
          center.z + maxDim * 1.3
        );
        controlsRef.current.update();
      }
      return;
    }

    // Aşama 4 (2K PBR Doku): Katı modda dokulu GLB / 2K PBR sahnesi mevcutsa doğrudan onu göster
    if (displayMode === 'solid' && photogrammetryStage === 'textured' && texturedScene) {
      scene.add(texturedScene);
      texturedRef.current = texturedScene;

      const boxHelper = new THREE.BoxHelper(texturedScene, 0x0ea5e9);
      (boxHelper.material as THREE.LineBasicMaterial).transparent = true;
      (boxHelper.material as THREE.LineBasicMaterial).opacity = 0.35;
      scene.add(boxHelper);
      boxHelperRef.current = boxHelper;

      const tbox = new THREE.Box3().setFromObject(texturedScene);
      if (!tbox.isEmpty() && cameraRef.current && controlsRef.current) {
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        tbox.getSize(size);
        tbox.getCenter(center);
        const maxDim = Math.max(size.x, size.y, size.z, 20);
        controlsRef.current.target.copy(center);
        cameraRef.current.position.set(
          center.x + maxDim * 1.45,
          center.y + maxDim * 1.05,
          center.z + maxDim * 1.65
        );
        controlsRef.current.update();
      }
      return;
    }

    let renderGeo = geometry;
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
    } else if (displayMode === 'overhang') {
      renderGeo = buildOverhangColorGeometry(geometry);
      overhangGeoRef.current = renderGeo;
      mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.42,
        metalness: 0.08,
        vertexColors: true,
      });
    } else if (photogrammetryStage === 'mesh') {
      // Aşama 3 (Sasha / Ham Kil Mesh): Saf geometri ve yüzey kabartması incelemesi
      mat = new THREE.MeshStandardMaterial({
        color: 0xcbd5e1,
        roughness: 0.56,
        metalness: 0.06,
        flatShading: false,
      });
    } else {
      const hasVertexColors = Boolean(geometry.getAttribute('color'));
      mat = new THREE.MeshStandardMaterial({
        color: hasVertexColors ? 0xffffff : 0x38bdf8,
        roughness: hasVertexColors ? 0.68 : 0.34,
        metalness: hasVertexColors ? 0.04 : 0.14,
        flatShading: false,
        vertexColors: hasVertexColors,
      });
    }

    const mesh = new THREE.Mesh(renderGeo, mat);
    mesh.castShadow = !softwareGlRef.current;
    mesh.receiveShadow = !softwareGlRef.current;
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
  }, [
    geometry,
    displayMode,
    skinnedMesh,
    wireframeRig,
    texturedScene,
    photogrammetryStage,
    cameraRig,
    denseCloud,
    showCameraRig,
  ]);

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
    <div className="relative w-full h-full min-h-[380px] bg-slate-100 dark:bg-slate-950 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden flex">
      {/* Local3D+ Fotoğraf ↔ 3D Model Yan-Yana Kıyaslama Paneli */}
      {showPhotoCompare && comparePhotoUrl && (
        <div className="w-[36%] max-w-[300px] h-full shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col z-10">
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
              Referans Fotoğraf
            </span>
            <span className="text-[10px] font-mono text-slate-500">Ön (0°)</span>
          </div>
          <div className="flex-1 p-3 flex items-center justify-center checkerboard-bg overflow-hidden">
            <img
              src={comparePhotoUrl}
              alt="Referans girdi fotoğrafı"
              className="max-w-full max-h-full object-contain rounded"
            />
          </div>
        </div>
      )}

      <div className="relative flex-1 h-full min-w-0">
        <div ref={containerRef} className="w-full h-full" />

        {/* Top Left Dimension Overlay */}
        {stats && (
          <div className="absolute top-3 left-3 pointer-events-none flex flex-wrap gap-2">
            <div className="bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1 text-xs font-mono text-slate-800 dark:text-slate-200 shadow-sm">
              <span className="text-teal-700 dark:text-teal-400 font-semibold">Boyut:</span>{' '}
              {stats.widthMm} × {stats.depthMm} × {stats.heightMm} mm
            </div>
            <div className="bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1 text-xs font-mono text-slate-800 dark:text-slate-200 shadow-sm">
              <span className="text-slate-600 dark:text-slate-400 font-semibold">Poligon:</span>{' '}
              {stats.triangleCount.toLocaleString('tr-TR')}
            </div>
          </div>
        )}

        {/* Top Right Toolbar */}
        <div className="absolute top-3 right-3 flex items-center gap-1 bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-lg p-1 shadow-sm">
          <button
            onClick={() => onDisplayModeChange('solid')}
            title="Katı Görünüm"
            className={`px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1 whitespace-nowrap transition ${
              displayMode === 'solid'
                ? 'bg-slate-900 text-white dark:bg-teal-500 dark:text-slate-950'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Box className="w-3.5 h-3.5" />
            Katı
          </button>
          <button
            onClick={() => onDisplayModeChange('wireframe')}
            title="Poligon Tel Kafes"
            className={`px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1 whitespace-nowrap transition ${
              displayMode === 'wireframe'
                ? 'bg-slate-900 text-white dark:bg-teal-500 dark:text-slate-950'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Kafes
          </button>
          <button
            onClick={() => onDisplayModeChange('xray')}
            title="X-Ray Şeffaf"
            className={`px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1 whitespace-nowrap transition ${
              displayMode === 'xray'
                ? 'bg-slate-900 text-white dark:bg-teal-500 dark:text-slate-950'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            X-Ray
          </button>
          <button
            onClick={() => onDisplayModeChange('overhang')}
            title="3B Baskı Sarkan Yüzey (>45° Overhang) Denetimi"
            className={`px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1 whitespace-nowrap transition ${
              displayMode === 'overhang'
                ? 'bg-rose-600 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            Baskı
          </button>
          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5" />
          {comparePhotoUrl && onTogglePhotoCompare && (
            <button
              onClick={onTogglePhotoCompare}
              title="Fotoğraf ↔ 3D Model Kıyaslama"
              className={`p-1.5 rounded transition ${
                showPhotoCompare
                  ? 'text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-500/15'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <Columns2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onToggleBedGrid}
            title="220×220 mm Yazıcı Tablası"
            className={`p-1.5 rounded transition ${
              showBedGrid
                ? 'text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-500/15'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <Grid className="w-4 h-4" />
          </button>
          <button
            onClick={onToggleAutoRotate}
            title="Otomatik Döndür"
            className={`p-1.5 rounded transition ${
              autoRotate
                ? 'text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-500/15'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <RotateCw className="w-4 h-4" />
          </button>
          <button
            onClick={resetCamera}
            title="Kamerayı Sıfırla"
            className="p-1.5 rounded text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Empty State */}
        {!geometry && !isBusy && (
          <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center text-center p-6">
            <div className="bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 rounded-xl px-6 py-5 max-w-md shadow-sm">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1.5">
                220 × 220 mm 3D Stüdyo Tablası Hazır
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Sol panelden fotoğraf yükleyin veya üstten{' '}
                <strong className="text-slate-900 dark:text-teal-300">Karakter Sheet</strong> /{' '}
                <strong className="text-slate-900 dark:text-teal-300">Örnek Parça</strong> seçip
                2K PBR 3D modelinizi oluşturun.
              </p>
            </div>
          </div>
        )}

        {/* Busy Overlay */}
        {isBusy && (
          <div className="absolute inset-0 bg-slate-50/85 dark:bg-slate-950/85 flex flex-col items-center justify-center z-20">
            <div className="w-9 h-9 border-3 border-slate-300 dark:border-slate-700 border-t-teal-600 dark:border-t-teal-400 rounded-full animate-spin mb-3" />
            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{busyLabel || 'İşleniyor...'}</p>
          </div>
        )}

        {/* Bottom Dock: 3DF Zephyr 4-Stage Pipeline + Local3D+ LOD Switcher */}
        {geometry && (onPhotogrammetryStageChange || onLodChange) && (
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-xl p-1 shadow-sm max-w-[96%] overflow-x-auto">
            {onPhotogrammetryStageChange && (cameraRig?.length || denseCloud) && (
              <>
                {(
                  [
                    { id: 'cameras', label: '1. Kamera' },
                    { id: 'pointcloud', label: '2. Nokta Bulutu' },
                    { id: 'mesh', label: '3. Mesh' },
                    { id: 'textured', label: '4. 2K PBR' },
                  ] as const
                ).map((st) => {
                  const active = photogrammetryStage === st.id;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => onPhotogrammetryStageChange(st.id)}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap shrink-0 transition flex items-center gap-1 ${
                        active
                          ? 'bg-slate-900 text-white dark:bg-teal-500 dark:text-slate-950'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      {st.id === 'textured' && <Sparkles className="w-3 h-3" />}
                      {st.label}
                    </button>
                  );
                })}
                {cameraRig && cameraRig.length > 0 && onToggleCameraRig && (
                  <>
                    <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5 shrink-0" />
                    <button
                      type="button"
                      onClick={onToggleCameraRig}
                      title="3D Kamera Piramitlerini Göster / Gizle"
                      className={`px-2 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap shrink-0 transition flex items-center gap-1 ${
                        showCameraRig
                          ? 'bg-teal-600 text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <Camera className="w-3 h-3" />
                      Kameralar ({cameraRig.length})
                    </button>
                  </>
                )}
              </>
            )}

            {onLodChange && (
              <>
                <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5 shrink-0" />
                <span className="text-[10px] font-mono text-slate-400 px-1 shrink-0">LOD</span>
                {(
                  [
                    { id: 'full', label: 'Tam' },
                    { id: '20k', label: '20K' },
                    { id: '5k', label: '5K' },
                  ] as const
                ).map((lod) => (
                  <button
                    key={lod.id}
                    type="button"
                    onClick={() => onLodChange(lod.id)}
                    className={`px-2 py-1 rounded-md text-[11px] font-mono whitespace-nowrap shrink-0 transition ${
                      activeLod === lod.id
                        ? 'bg-teal-600 text-white'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {lod.label}
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {/* Bottom hint */}
        <div className="absolute bottom-2 left-3 right-3 pointer-events-none flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span>Sol tık: Döndür · Sağ tık: Kaydır · Tekerlek: Yakınlaş · Taban Y=0 mm</span>
          {displayMode === 'overhang' && geometry && (
            <span className="bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-0.5 text-[10px] text-slate-700 dark:text-slate-300">
              <span className="text-rose-600 dark:text-rose-400 font-semibold">Kırmızı:</span> &gt;45° Destek ·{' '}
              <span className="text-amber-600 dark:text-amber-400 font-semibold">Turuncu:</span> 35–45° ·{' '}
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Yeşil:</span> Tabla
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
