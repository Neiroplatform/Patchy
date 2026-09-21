export interface Rect { x: number; y: number; width: number; height: number }
export interface LayerProjection {
  id: bigint; parentId: bigint; kind: number; visible: boolean;
  opacity: number; name: string; clipped: boolean; fillOpacity: number;
  blendMode: number; lockFlags: number; bounds: Rect;
  mask: null | { bounds: Rect; defaultColor: number; disabled: boolean; linked: boolean };
  text: null | { value: string; font: string; sizePixels: number;
    color: [number, number, number]; bold: boolean; italic: boolean; boxText: boolean };
  adjustment: null | { kind: number; values: number[];
    curvePoints: Array<{ input: number; output: number }> };
  smartObject: null | { sourceKind: number; filename: string; filetype: string;
    sourceSize: bigint; editable: boolean; contentsEditable: boolean };
}
export interface DocumentProjection {
  width: number; height: number; colorMode: number; bitDepth: number;
  channels: number; activeLayerId: bigint; revision: bigint; stateId: bigint;
  layerCount: number; hasActiveLayer: boolean; dirty: boolean;
  canUndo: boolean; canRedo: boolean; layers: LayerProjection[];
  documentId: number; documentName: string; documents: DocumentTabProjection[];
  memory: MemoryUsage | null; dirtyRegion: Rect | null;
  memoryBudget: { documentBytes: number; globalBytes: number };
  selection: Rect[];
  selectionMask: null | { bounds: Rect; gray: Uint8Array };
  channels: Array<{ id: bigint; kind: number; name: string }>;
  paths: Array<{ id: bigint; kind: number; name: string; subpathCount: number;
    anchorCount: number; clipping: boolean; anchors: VectorAnchor[];
    subpaths: VectorSubpathInput[] }>;
}
export interface MemoryUsage {
  documentPixelBytes: number; historyPixelBytes: number; previewPixelBytes: number;
  selectionBytes: number; historySelectionBytes: number; previewSelectionBytes: number;
  historyRetainedBytes: number; totalRetainedBytes: number;
  undoStates: number; redoStates: number;
  renderCacheBytes: number; renderCacheEntries: number; renderCacheHits: number;
  renderCacheMisses: number; renderCacheEvictions: number;
}
export interface DocumentTabProjection { id: number; name: string; dirty: boolean;
  revision: bigint; active: boolean; retainedBytes: number; historyBytes: number;
  smartObjectParentId?: number }
export type WorkerState = "starting" | "ready" | "crashed" | "closed";
export interface FilterProgress {
  completed: number; total: number; stage: number; ratio: number;
}
export interface CancellableOperation<T> { promise: Promise<T>; cancel(): void }
export interface TransferOptions { transferOwnership?: boolean }
export interface PsdHeader {
  version: 1 | 2; width: number; height: number; channels: number;
  depth: number; colorMode: number; sourceBytes: number;
}
export type RenderFrame =
  | { kind: "bitmap"; bitmap: ImageBitmap; width: number; height: number }
  | { kind: "rgba"; bytes: Uint8Array; width: number; height: number };

export class PatchyWorkerClient {
  constructor(worker: Worker);
  readonly state: WorkerState;
  readonly capabilities: bigint;
  addStateListener(listener: (state: WorkerState, error: Error | null) => void): () => void;
  initialize(moduleUrl: string, moduleOptions?: object): Promise<void>;
  open(bytes: Uint8Array, name?: string, options?: TransferOptions): Promise<DocumentProjection>;
  openBlob(blob: Blob, name?: string): Promise<DocumentProjection>;
  inspectBlob(blob: Blob): Promise<PsdHeader>;
  placePsdSmartObject(blob: Blob, name?: string,
    layerId?: bigint | null): Promise<DocumentProjection>;
  create(width: number, height: number, name?: string): Promise<DocumentProjection>;
  snapshot(): Promise<DocumentProjection>;
  listDocuments(): Promise<DocumentTabProjection[]>;
  activateDocument(documentId: number): Promise<DocumentProjection>;
  copyLayerToDocument(input: { sourceDocumentId: number; targetDocumentId: number;
    layerId: bigint; expectedSourceStateId: bigint; expectedSourceRevision: bigint;
    expectedTargetStateId: bigint; expectedTargetRevision: bigint }): Promise<DocumentProjection>;
  previewLayerTransform(input: { layerId: bigint; quad: number[]; interpolation?: 0 | 1;
    cancellation?: Int32Array;
    expectedStateId: bigint; expectedRevision: bigint }): Promise<{ region: Rect; rgba: Uint8Array }>;
  transformLayer(input: { layerId: bigint; quad: number[]; interpolation?: 0 | 1;
    expectedStateId: bigint; expectedRevision: bigint }): Promise<DocumentProjection>;
  previewRasterStroke(input: { layerId: bigint; mode: 0 | 1 | 2 | 3; brushSize: number;
    color: number[]; points: number[][]; source?: number[]; cancellation?: Int32Array;
    expectedStateId: bigint; expectedRevision: bigint }): Promise<{ region: Rect; rgba: Uint8Array }>;
  applyRasterStroke(input: { layerId: bigint; mode: 0 | 1 | 2 | 3; brushSize: number;
    color: number[]; points: number[][]; source?: number[];
    expectedStateId: bigint; expectedRevision: bigint }): Promise<DocumentProjection>;
  previewRasterFill(input: { layerId: bigint; mode: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    color: number[]; start: number[]; end: number[]; cancellation?: Int32Array;
    expectedStateId: bigint; expectedRevision: bigint }): Promise<{ region: Rect; rgba: Uint8Array }>;
  applyRasterFill(input: { layerId: bigint; mode: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    color: number[]; start: number[]; end: number[];
    expectedStateId: bigint; expectedRevision: bigint }): Promise<DocumentProjection>;
  previewLayerWarp(input: { layerId: bigint;
    style: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
    bend: number; horizontalDistortion: number; verticalDistortion: number;
    rotateVertical?: boolean; interpolation?: 0 | 1; cancellation?: Int32Array;
    expectedStateId: bigint; expectedRevision: bigint }): Promise<{ region: Rect; rgba: Uint8Array }>;
  warpLayer(input: { layerId: bigint;
    style: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
    bend: number; horizontalDistortion: number; verticalDistortion: number;
    rotateVertical?: boolean; interpolation?: 0 | 1;
    expectedStateId: bigint; expectedRevision: bigint }): Promise<DocumentProjection>;
  closeDocument(documentId: number): Promise<DocumentProjection | null>;
  setMemoryBudget(documentBytes: number, globalBytes: number): Promise<DocumentProjection>;
  setLayerVisibility(layerId: bigint, visible: boolean): Promise<DocumentProjection>;
  setLayerOpacity(layerId: bigint, opacity: number): Promise<DocumentProjection>;
  setLayerFillOpacity(layerId: bigint, opacity: number): Promise<DocumentProjection>;
  setLayerLocks(layerId: bigint, lockFlags: number): Promise<DocumentProjection>;
  setLayerClipping(layerId: bigint, clipped: boolean): Promise<DocumentProjection>;
  setLayerStylePreset(layerId: bigint, presetId: string): Promise<DocumentProjection>;
  setLayerBlendMode(layerId: bigint, blendMode: number): Promise<DocumentProjection>;
  renameLayer(layerId: bigint, name: string): Promise<DocumentProjection>;
  removeLayer(layerId: bigint): Promise<DocumentProjection>;
  resizeImage(width: number, height: number): Promise<DocumentProjection>;
  resizeCanvas(width: number, height: number, anchor?: number): Promise<DocumentProjection>;
  rotateCanvas(clockwiseDegrees: number): Promise<DocumentProjection>;
  cropDocument(crop: Rect): Promise<DocumentProjection>;
  setSelection(rects: Rect[]): Promise<DocumentProjection>;
  setSelectionMask(bounds: Rect, gray: Uint8Array,
    options?: TransferOptions): Promise<DocumentProjection>;
  clearSelection(): Promise<DocumentProjection>;
  invertSelection(): Promise<DocumentProjection>;
  expandSelection(pixels: number): Promise<DocumentProjection>;
  contractSelection(pixels: number): Promise<DocumentProjection>;
  borderSelection(pixels: number): Promise<DocumentProjection>;
  growSelection(tolerance: number): Promise<DocumentProjection>;
  selectSimilar(tolerance: number): Promise<DocumentProjection>;
  addAlphaChannel(name?: string): Promise<DocumentProjection>;
  addDocumentPath(input: { name: string; kind?: number; clipping?: boolean;
    path: VectorPathInput }): Promise<DocumentProjection>;
  selectChannel(channelId: bigint): Promise<DocumentProjection>;
  selectPath(pathId: bigint, feather?: number, combine?: number,
    antialias?: boolean): Promise<DocumentProjection>;
  renameChannel(channelId: bigint, name: string): Promise<DocumentProjection>;
  invertChannel(channelId: bigint): Promise<DocumentProjection>;
  removeChannel(channelId: bigint): Promise<DocumentProjection>;
  moveChannel(channelId: bigint, finalIndex: number): Promise<DocumentProjection>;
  renamePath(pathId: bigint, name: string): Promise<DocumentProjection>;
  removePath(pathId: bigint): Promise<DocumentProjection>;
  movePath(pathId: bigint, finalIndex: number): Promise<DocumentProjection>;
  setClippingPath(pathId: bigint, clipping: boolean): Promise<DocumentProjection>;
  updateDocumentPath(pathId: bigint, input: { name: string; kind?: number;
    clipping?: boolean; path: VectorPathInput }): Promise<DocumentProjection>;
  rasterizeLayer(layerId: bigint): Promise<DocumentProjection>;
  mergeVisibleCopy(name?: string): Promise<DocumentProjection>;
  createLayerMask(layerId: bigint): Promise<DocumentProjection>;
  toggleLayerMask(layerId: bigint): Promise<DocumentProjection>;
  invertLayerMask(layerId: bigint): Promise<DocumentProjection>;
  removeLayerMask(layerId: bigint): Promise<DocumentProjection>;
  groupLayer(layerId: bigint, name?: string): Promise<DocumentProjection>;
  ungroup(layerId: bigint): Promise<DocumentProjection>;
  addPixelLayer(input: { name: string; width: number; height: number;
    bounds: Rect; rgba: Uint8Array }, options?: TransferOptions): Promise<DocumentProjection>;
  layerPixels(layerId: bigint): Promise<Uint8Array>;
  layerMaskPixels(layerId: bigint): Promise<Uint8Array>;
  replacePixelLayer(layerId: bigint, input: { name: string; width: number;
    height: number; bounds: Rect; rgba: Uint8Array },
    options?: TransferOptions): Promise<DocumentProjection>;
  replacePixelLayerAndMask(layerId: bigint,
    input: { name: string; width: number; height: number; bounds: Rect; rgba: Uint8Array },
    mask: { width: number; height: number; bounds: Rect; gray: Uint8Array;
      defaultColor: number; disabled: boolean },
    options?: TransferOptions): Promise<DocumentProjection>;
  addTextLayer(input: TextLayerInput, options?: TransferOptions): Promise<DocumentProjection>;
  updateTextLayer(layerId: bigint, input: TextLayerInput,
    options?: TransferOptions): Promise<DocumentProjection>;
  addAdjustment(input: AdjustmentInput): Promise<DocumentProjection>;
  updateAdjustment(layerId: bigint, input: AdjustmentInput): Promise<DocumentProjection>;
  addVectorShape(input: VectorShapeInput): Promise<DocumentProjection>;
  updateVectorShape(layerId: bigint, input: VectorShapeInput): Promise<DocumentProjection>;
  setVectorMask(layerId: bigint, input: VectorMaskInput | null): Promise<DocumentProjection>;
  addSmartObject(input: SmartObjectInput,
    options?: TransferOptions): Promise<DocumentProjection>;
  replaceSmartObject(layerId: bigint, input: SmartObjectInput,
    options?: TransferOptions): Promise<DocumentProjection>;
  openSmartObjectContents(layerId: bigint): Promise<DocumentProjection>;
  saveSmartObjectContents(documentId: number): Promise<DocumentProjection>;
  setSmartFilter(layerId: bigint, input: SmartFilterInput): Promise<DocumentProjection>;
  moveLayer(layerId: bigint, targetLayerId: bigint | null,
            position: number): Promise<DocumentProjection>;
  undo(): Promise<DocumentProjection>;
  redo(): Promise<DocumentProjection>;
  applyFilter(layerId: bigint, filterId: string, parameters?: FilterParameterInput[],
              onProgress?: (progress: FilterProgress) => void):
    CancellableOperation<DocumentProjection>;
  invertLayer(layerId: bigint,
              onProgress?: (progress: FilterProgress) => void):
    CancellableOperation<DocumentProjection>;
  render(region: Rect): Promise<Uint8Array>;
  renderFrame(region: Rect): Promise<RenderFrame>;
  save(): Promise<Uint8Array>;
  saveDocument(documentId: number): Promise<Uint8Array>;
  saveBlob(): Promise<Blob>;
  saveDocumentBlob(documentId: number): Promise<Blob>;
  close(): Promise<null>;
  terminate(): void;
}

export interface TextLayerInput {
  name: string; text: string; font: string; sizePixels: number;
  color: [number, number, number]; bold: boolean; italic: boolean;
  boxText: boolean; width: number; height: number; bounds: Rect; rgba: Uint8Array;
}
export interface VectorAnchor { x: number; y: number; inX?: number; inY?: number;
  outX?: number; outY?: number; smooth?: boolean }
export interface VectorSubpathInput { anchors: VectorAnchor[]; shapeGroup?: number;
  combine?: number; closed?: boolean }
export interface VectorPathInput { anchors?: VectorAnchor[]; subpaths?: VectorSubpathInput[] }
export interface VectorShapeInput { name: string; path: VectorPathInput;
  fill: [number, number, number]; strokeEnabled: boolean;
  stroke: [number, number, number]; strokeWidth: number }
export interface VectorMaskInput { path: VectorPathInput; feather?: number; density?: number;
  disabled?: boolean; inverted?: boolean; unlinked?: boolean; hidesEffects?: boolean }
export interface AdjustmentInput { name?: string; kind: number; values?: number[];
  curvePoints?: Array<{ input: number; output: number }> }
export interface SmartObjectInput { name: string; filename: string; filetype: string;
  width: number; height: number; bounds: Rect; rgba: Uint8Array; sourceBytes: Uint8Array }
export interface SmartFilterInput { kind: number; amount: number; enabled?: boolean }
export interface FilterParameterInput { key: string;
  kind: "integer" | "double" | "boolean" | "option";
  value: number | boolean | string }
