export interface Rect { x: number; y: number; width: number; height: number }
export interface LayerProjection {
  id: bigint; parentId: bigint; kind: number; visible: boolean;
  opacity: number; name: string; clipped: boolean; fillOpacity: number;
  blendMode: number; lockFlags: number; bounds: Rect;
}
export interface DocumentProjection {
  width: number; height: number; colorMode: number; bitDepth: number;
  channels: number; activeLayerId: bigint; revision: bigint; stateId: bigint;
  layerCount: number; hasActiveLayer: boolean; dirty: boolean;
  canUndo: boolean; canRedo: boolean; layers: LayerProjection[];
}
export type WorkerState = "starting" | "ready" | "crashed" | "closed";
export interface FilterProgress {
  completed: number; total: number; stage: number; ratio: number;
}
export interface CancellableOperation<T> { promise: Promise<T>; cancel(): void }

export class PatchyWorkerClient {
  constructor(worker: Worker);
  readonly state: WorkerState;
  initialize(moduleUrl: string, moduleOptions?: object): Promise<void>;
  open(bytes: Uint8Array): Promise<DocumentProjection>;
  create(width: number, height: number): Promise<DocumentProjection>;
  snapshot(): Promise<DocumentProjection>;
  setLayerVisibility(layerId: bigint, visible: boolean): Promise<DocumentProjection>;
  setLayerOpacity(layerId: bigint, opacity: number): Promise<DocumentProjection>;
  setLayerBlendMode(layerId: bigint, blendMode: number): Promise<DocumentProjection>;
  renameLayer(layerId: bigint, name: string): Promise<DocumentProjection>;
  removeLayer(layerId: bigint): Promise<DocumentProjection>;
  resizeImage(width: number, height: number): Promise<DocumentProjection>;
  resizeCanvas(width: number, height: number, anchor?: number): Promise<DocumentProjection>;
  rotateCanvas(clockwiseDegrees: number): Promise<DocumentProjection>;
  cropDocument(crop: Rect): Promise<DocumentProjection>;
  groupLayer(layerId: bigint, name?: string): Promise<DocumentProjection>;
  ungroup(layerId: bigint): Promise<DocumentProjection>;
  addPixelLayer(input: { name: string; width: number; height: number;
    bounds: Rect; rgba: Uint8Array }): Promise<DocumentProjection>;
  moveLayer(layerId: bigint, targetLayerId: bigint | null,
            position: number): Promise<DocumentProjection>;
  undo(): Promise<DocumentProjection>;
  redo(): Promise<DocumentProjection>;
  invertLayer(layerId: bigint,
              onProgress?: (progress: FilterProgress) => void):
    CancellableOperation<DocumentProjection>;
  render(region: Rect): Promise<Uint8Array>;
  save(): Promise<Uint8Array>;
  close(): Promise<null>;
  terminate(): void;
}
