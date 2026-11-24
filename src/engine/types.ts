export type ViewAngle = 'front' | 'right' | 'back' | 'left' | 'top';

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
}

export type CloudProvider = 'huggingface' | 'fal' | 'tripo' | 'meshy';
export type OfflineMethod = 'visual-hull' | 'contour-extrude' | 'lathe-revolve';
export type ViewportDisplayMode = 'solid' | 'wireframe' | 'xray';
