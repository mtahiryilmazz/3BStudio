export type ViewAngle =
  | 'front'
  | 'frontRight'
  | 'right'
  | 'backRight'
  | 'back'
  | 'backLeft'
  | 'left'
  | 'frontLeft'
  | 'top';

export interface BinaryMask {
  width: number;
  height: number;
  /** 1 = foreground, 0 = background */
  data: Uint8Array;
}

export interface PhotoViewItem {
  angle: ViewAngle;
  label: string;
  originalDataUrl: string;
  cleanedDataUrl: string | null;
  mask: BinaryMask | null;
  bgMethod?: 'ai' | 'fast' | 'manual';
  tolerance?: number;
}

export interface MeshStats {
  vertexCount: number;
  triangleCount: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  volumeCm3: number;
  estimatedPlaGrams: number;
  openBoundaryEdges: number;
  nonManifoldEdges: number;
  isWatertight: boolean;
  printabilityScore: number;
  /** 45° üzeri destek gerektiren sarkan yüzey üçgenlerinin yüzdesi (0..100). */
  overhangTrianglePct: number;
  /** Tablaya (Y=0) temas eden yüzey oranı (0..100). */
  bedContactPct: number;
  /** 0.4 mm nozul için en küçük boyut 0.8 mm altındaysa true. */
  thinWallWarning: boolean;
  /** 220×220×220 mm standart tabla sınırını aşıyorsa true. */
  exceedsBedWarning: boolean;
  /** 0.2 mm katman, %20 doluluk için tahmini FDM baskı süresi (dakika). */
  estimatedPrintMinutes: number;
}

export type CloudProvider = 'huggingface' | 'fal' | 'tripo' | 'meshy';
export type OfflineMethod = 'visual-hull' | 'contour-extrude' | 'lathe-revolve';
export type ViewportDisplayMode = 'solid' | 'wireframe' | 'xray' | 'overhang';

export interface FreeHfSpacePreset {
  id: string;
  name: string;
  badge: string;
  multiView: boolean;
  description: string;
  /** Tercih edilen varsayılan Gradio uç noktası (yoksa otomatik keşfedilir). */
  preferredEndpoints: string[];
}

export type HfRuntimeStage =
  | 'RUNNING'
  | 'RUNNING_BUILDING'
  | 'SLEEPING'
  | 'BUILDING'
  | 'PAUSED'
  | 'RUNTIME_ERROR'
  | 'BUILD_ERROR'
  | 'NO_APP_FILE'
  | 'STOPPED'
  | 'UNKNOWN';

export interface HfSpaceHealth {
  id: string;
  stage: HfRuntimeStage;
  healthy: boolean;
  hardware?: string;
  checkedAt: number;
  note?: string;
}

export type CloudJobState =
  | 'queued'
  | 'checking'
  | 'running'
  | 'downloading'
  | 'done'
  | 'error'
  | 'cancelled';

export interface CloudJobSnapshot {
  jobId: string;
  provider: CloudProvider;
  status: CloudJobState;
  stageLabel: string;
  percent: number;
  activeSpaceId?: string;
  usedSpaceId?: string;
  triedSpaces: Array<{ spaceId: string; stage?: string; error?: string }>;
  modelUrl?: string;
  error?: string;
  elapsedSec: number;
}

export interface CharacterDepthProfile {
  subjectType: 'humanoid' | 'figurine' | 'object';
  frontHeadMissing: boolean;
  frontFaceOccluded: boolean;
  torsoDepthScale: number;
  headDepthScale: number;
  limbDepthScale: number;
  reliefStrength: number;
  notes?: string;
}

export type CadExpr = number | string;

export interface CadParameter {
  name: string;
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step: number;
}

export type CadNode =
  | { type: 'cuboid'; size: [CadExpr, CadExpr, CadExpr] }
  | { type: 'roundedCuboid'; size: [CadExpr, CadExpr, CadExpr]; roundRadius?: CadExpr; segments?: CadExpr }
  | { type: 'cylinder'; radius: CadExpr; height: CadExpr; segments?: CadExpr }
  | { type: 'roundedCylinder'; radius: CadExpr; height: CadExpr; roundRadius?: CadExpr; segments?: CadExpr }
  | { type: 'cone'; bottomRadius: CadExpr; topRadius: CadExpr; height: CadExpr; segments?: CadExpr }
  | { type: 'sphere'; radius: CadExpr; segments?: CadExpr }
  | { type: 'torus'; innerRadius: CadExpr; outerRadius: CadExpr; innerSegments?: CadExpr; outerSegments?: CadExpr }
  | { type: 'tube'; outerRadius: CadExpr; innerRadius: CadExpr; height: CadExpr; segments?: CadExpr }
  | { type: 'gear'; teeth: CadExpr; module: CadExpr; thickness: CadExpr; boreRadius?: CadExpr }
  | { type: 'hexNut'; flatToFlat: CadExpr; thickness: CadExpr; holeRadius?: CadExpr }
  | { type: 'polygonExtrude'; points: Array<[CadExpr, CadExpr]>; height: CadExpr }
  | { type: 'translate'; offset: [CadExpr, CadExpr, CadExpr]; child: CadNode }
  | { type: 'rotate'; anglesDeg: [CadExpr, CadExpr, CadExpr]; child: CadNode }
  | { type: 'scale'; factors: [CadExpr, CadExpr, CadExpr]; child: CadNode }
  | { type: 'mirror'; normal: [CadExpr, CadExpr, CadExpr]; child: CadNode }
  | { type: 'linearArray'; count: CadExpr; step: [CadExpr, CadExpr, CadExpr]; child: CadNode }
  | { type: 'radialArray'; count: CadExpr; radius: CadExpr; axis?: 'x' | 'y' | 'z'; child: CadNode }
  | { type: 'union'; children: CadNode[] }
  | { type: 'subtract'; children: CadNode[] }
  | { type: 'intersect'; children: CadNode[] }
  | { type: 'hull'; children: CadNode[] };

export interface CadSpec {
  title: string;
  summary: string;
  parameters: CadParameter[];
  root: CadNode;
  build123dCode?: string;
}
