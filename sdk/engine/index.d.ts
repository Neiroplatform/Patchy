export interface Rect { x: number; y: number; width: number; height: number }
export interface LayerProjection {
  id: bigint; parentId: bigint; kind: number; visible: boolean;
  opacity: number; name: string; clipped: boolean; fillOpacity: number;
  blendMode: number; lockFlags: number; bounds: Rect;
  mask: null | { bounds: Rect; defaultColor: number; disabled: boolean; linked: boolean };
  text: null | { value: string; font: string; sizePixels: number;
    color: [number, number, number]; bold: boolean; italic: boolean; boxText: boolean };
}
export interface DocumentProjection {
  width: number; height: number; colorMode: number; bitDepth: number;
  channels: number; activeLayerId: bigint; revision: bigint; stateId: bigint;
  layerCount: number; hasActiveLayer: boolean; dirty: boolean;
  canUndo: boolean; canRedo: boolean; layers: LayerProjection[];
  selection: Rect[];
}
export type WorkerState = "starting" | "ready" | "crashed" | "closed";
export interface FilterProgress {
  completed: number; total: number; stage: number; ratio: number;
}
export interface CancellableOperation<T> { promise: Promise<T>; cancel(): void }

export class PatchyWorkerClient {
  constructor(worker: Worker);
  readonly state: WorkerState;
  readonly capabilities: bigint;
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
  setSelection(rects: Rect[]): Promise<DocumentProjection>;
  clearSelection(): Promise<DocumentProjection>;
  createLayerMask(layerId: bigint): Promise<DocumentProjection>;
  toggleLayerMask(layerId: bigint): Promise<DocumentProjection>;
  invertLayerMask(layerId: bigint): Promise<DocumentProjection>;
  removeLayerMask(layerId: bigint): Promise<DocumentProjection>;
  groupLayer(layerId: bigint, name?: string): Promise<DocumentProjection>;
  ungroup(layerId: bigint): Promise<DocumentProjection>;
  addPixelLayer(input: { name: string; width: number; height: number;
    bounds: Rect; rgba: Uint8Array }): Promise<DocumentProjection>;
  layerPixels(layerId: bigint): Promise<Uint8Array>;
  replacePixelLayer(layerId: bigint, input: { name: string; width: number;
    height: number; bounds: Rect; rgba: Uint8Array }): Promise<DocumentProjection>;
  addTextLayer(input: TextLayerInput): Promise<DocumentProjection>;
  updateTextLayer(layerId: bigint, input: TextLayerInput): Promise<DocumentProjection>;
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

export interface TextLayerInput {
  name: string; text: string; font: string; sizePixels: number;
  color: [number, number, number]; bold: boolean; italic: boolean;
  boxText: boolean; width: number; height: number; bounds: Rect; rgba: Uint8Array;
}
