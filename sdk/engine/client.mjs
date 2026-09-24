import {
  PATCHY_ENGINE_PROTOCOL_VERSION,
  PATCHY_ENGINE_REQUIRED_CAPABILITIES,
  PATCHY_ENGINE_SDK_VERSION,
  PATCHY_WORKER_RPC_VERSION,
} from "./protocol.mjs";

function transferableInput(bytes, transferOwnership) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Worker byte input must be a Uint8Array");
  if (transferOwnership && bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes;
  }
  return bytes.slice();
}

function saveFormat(format) {
  if (format !== "psd" && format !== "psb") {
    throw new TypeError("Save format must be psd or psb");
  }
  return format;
}

export class PatchyWorkerClient {
  #worker;
  #nextId = 1;
  #pending = new Map();
  #state = "starting";
  #capabilities = 0n;
  #engineProtocolVersion = 0;
  #rpcVersion = 0;
  #stateListeners = new Set();

  constructor(worker) {
    this.#worker = worker;
    worker.addEventListener("message", (event) => this.#onMessage(event.data));
    worker.addEventListener("error", (event) => this.#crash(event.error || new Error(event.message)));
    worker.addEventListener("messageerror", () => this.#crash(new Error("Patchy worker message decoding failed")));
  }

  get state() { return this.#state; }
  get capabilities() { return this.#capabilities; }
  get engineProtocolVersion() { return this.#engineProtocolVersion; }
  get rpcVersion() { return this.#rpcVersion; }
  get sdkVersion() { return PATCHY_ENGINE_SDK_VERSION; }

  addStateListener(listener) {
    if (typeof listener !== "function") throw new TypeError("Worker state listener must be a function");
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async initialize(moduleUrl, moduleOptions = {}) {
    if (typeof window !== "undefined" && !globalThis.crossOriginIsolated) {
      throw new Error("Patchy Worker requires COOP/COEP cross-origin isolation");
    }
    try {
      const info = await this.#request("initialize", { moduleUrl, moduleOptions,
        sdkVersion: PATCHY_ENGINE_SDK_VERSION,
        rpcVersion: PATCHY_WORKER_RPC_VERSION,
        engineProtocolVersion: PATCHY_ENGINE_PROTOCOL_VERSION });
      if (info.sdkVersion !== PATCHY_ENGINE_SDK_VERSION ||
          info.rpcVersion !== PATCHY_WORKER_RPC_VERSION ||
          info.engineProtocolVersion !== PATCHY_ENGINE_PROTOCOL_VERSION) {
        throw new Error("Patchy SDK/Worker/engine protocol version mismatch");
      }
      if (typeof info.capabilities !== "bigint" ||
          (info.capabilities & PATCHY_ENGINE_REQUIRED_CAPABILITIES) !==
            PATCHY_ENGINE_REQUIRED_CAPABILITIES) {
        throw new Error("Patchy engine is missing mandatory SDK capabilities");
      }
      this.#capabilities = info.capabilities;
      this.#engineProtocolVersion = info.engineProtocolVersion;
      this.#rpcVersion = info.rpcVersion;
      this.#setState("ready");
    } catch (error) {
      this.#worker.terminate();
      this.#crash(error);
      throw error;
    }
  }

  open(bytes, name = "Document.psd", { transferOwnership = false } = {}) {
    const owned = transferableInput(bytes, transferOwnership);
    return this.#request("open", { bytes: owned.buffer, name }, [owned.buffer]);
  }
  openBlob(blob, name = "Document.psd") {
    return this.#request("openBlob", { blob, name });
  }
  inspectBlob(blob) { return this.#request("inspectBlob", { blob }); }
  placePsdSmartObject(blob, name = "Smart Object.psd", layerId = null) {
    return this.#request("placePsdSmartObject", {
      blob, name, layerId: layerId == null ? null : String(layerId),
    });
  }
  create(width, height, name = "Untitled.psd") {
    return this.#request("create", { width, height, name });
  }
  snapshot() { return this.#request("snapshot"); }
  listDocuments() { return this.#request("listDocuments"); }
  activateDocument(documentId) { return this.#request("activateDocument", { documentId }); }
  copyLayerToDocument(input) {
    return this.#request("copyLayerToDocument", {
      sourceDocumentId: input.sourceDocumentId,
      targetDocumentId: input.targetDocumentId,
      layerId: String(input.layerId),
      expectedSourceStateId: String(input.expectedSourceStateId),
      expectedSourceRevision: String(input.expectedSourceRevision),
      expectedTargetStateId: String(input.expectedTargetStateId),
      expectedTargetRevision: String(input.expectedTargetRevision),
    });
  }
  copyLayersToDocument(input) {
    if (!Array.isArray(input.layerIds)) throw new TypeError("Layer transfer requires a layer id array");
    return this.#request("copyLayersToDocument", {
      sourceDocumentId: input.sourceDocumentId,
      targetDocumentId: input.targetDocumentId,
      layerIds: input.layerIds.map(String),
      expectedSourceStateId: String(input.expectedSourceStateId),
      expectedSourceRevision: String(input.expectedSourceRevision),
      expectedTargetStateId: String(input.expectedTargetStateId),
      expectedTargetRevision: String(input.expectedTargetRevision),
    });
  }
  previewLayerTransform(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    if (!(cancellation.buffer instanceof SharedArrayBuffer) || cancellation.length < 1) {
      throw new TypeError("Transform preview cancellation must use shared Int32 storage");
    }
    return this.#request("previewLayerTransform", {
      layerId: String(input.layerId), quad: [...input.quad],
      interpolation: input.interpolation ?? 1,
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision),
      cancellation: cancellation.buffer,
    });
  }
  transformLayer(input) {
    return this.#request("transformLayer", {
      layerId: String(input.layerId), quad: [...input.quad],
      interpolation: input.interpolation ?? 1,
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision),
    });
  }
  previewLayersTransform(input) {
    if (!Array.isArray(input.layerIds)) {
      throw new TypeError("Multi-layer transform requires a layer id array");
    }
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    if (!(cancellation.buffer instanceof SharedArrayBuffer) || cancellation.length < 1) {
      throw new TypeError("Transform preview cancellation must use shared Int32 storage");
    }
    return this.#request("previewLayersTransform", {
      layerIds: input.layerIds.map(String), quad: [...input.quad],
      interpolation: input.interpolation ?? 1,
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision),
      cancellation: cancellation.buffer,
    });
  }
  transformLayers(input) {
    if (!Array.isArray(input.layerIds)) {
      throw new TypeError("Multi-layer transform requires a layer id array");
    }
    return this.#request("transformLayers", {
      layerIds: input.layerIds.map(String), quad: [...input.quad],
      interpolation: input.interpolation ?? 1,
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision),
    });
  }
  arrangeLayers(input) {
    if (!Array.isArray(input.layerIds)) {
      throw new TypeError("Layer arrangement requires a layer id array");
    }
    return this.#request("arrangeLayers", {
      layerIds: input.layerIds.map(String), mode: input.mode,
      reference: input.reference ?? 0,
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision),
    });
  }
  previewRasterStroke(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    return this.#request("previewRasterStroke", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision), cancellation: cancellation.buffer });
  }
  applyRasterStroke(input) {
    return this.#request("applyRasterStroke", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  previewLayerMaskStroke(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    return this.#request("previewLayerMaskStroke", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision), cancellation: cancellation.buffer });
  }
  applyLayerMaskStroke(input) {
    return this.#request("applyLayerMaskStroke", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  previewRasterFill(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    return this.#request("previewRasterFill", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision), cancellation: cancellation.buffer });
  }
  applyRasterFill(input) {
    return this.#request("applyRasterFill", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  previewLayerWarp(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    return this.#request("previewLayerWarp", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision), cancellation: cancellation.buffer });
  }
  warpLayer(input) {
    return this.#request("warpLayer", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  previewLiquify(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    return this.#request("previewLiquify", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision), cancellation: cancellation.buffer });
  }
  applyLiquify(input) {
    return this.#request("applyLiquify", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  applyRetouchRepair(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    if (!(cancellation.buffer instanceof SharedArrayBuffer) || cancellation.length < 1) {
      throw new TypeError("Retouch repair cancellation must use shared Int32 storage");
    }
    return this.#request("applyRetouchRepair", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision),
      cancellation: cancellation.buffer });
  }
  applyLocalAdjustmentBrush(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    if (!(cancellation.buffer instanceof SharedArrayBuffer) || cancellation.length < 1) {
      throw new TypeError("Local-adjustment brush cancellation must use shared Int32 storage");
    }
    return this.#request("applyLocalAdjustmentBrush", { ...input,
      layerId: String(input.layerId), expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision),
      cancellation: cancellation.buffer });
  }
  closeDocument(documentId) { return this.#request("closeDocument", { documentId }); }
  setMemoryBudget(documentBytes, globalBytes) {
    return this.#request("setMemoryBudget", { documentBytes, globalBytes });
  }
  setLayerVisibility(layerId, visible) {
    return this.#request("setLayerVisibility", { layerId: String(layerId), visible });
  }
  editLayers(layerIds, property, { opacity = 0, value = 0 } = {}) {
    return this.#request("editLayers", {
      layerIds: layerIds.map(String), property, opacity, value,
    });
  }
  removeLayers(layerIds) {
    return this.#request("removeLayers", { layerIds: layerIds.map(String) });
  }
  groupLayers(layerIds, name = "Group") {
    return this.#request("groupLayers", { layerIds: layerIds.map(String), name });
  }
  ungroupLayers(layerIds) {
    return this.#request("ungroupLayers", { layerIds: layerIds.map(String) });
  }
  setLayerOpacity(layerId, opacity) {
    return this.#request("setLayerOpacity", { layerId: String(layerId), opacity });
  }
  setLayerFillOpacity(layerId, opacity) {
    return this.#request("setLayerFillOpacity", { layerId: String(layerId), opacity });
  }
  setLayerLocks(layerId, lockFlags) {
    return this.#request("setLayerLocks", { layerId: String(layerId), lockFlags });
  }
  setLayerClipping(layerId, clipped) {
    return this.#request("setLayerClipping", { layerId: String(layerId), clipped });
  }
  setLayerStylePreset(layerId, presetId) {
    return this.#request("setLayerStylePreset", { layerId: String(layerId), presetId });
  }
  setEssentialLayerStyle(layerId, input) {
    return this.#request("setEssentialLayerStyle", { layerId: String(layerId), input });
  }
  setLayerBlendMode(layerId, blendMode) {
    return this.#request("setLayerBlendMode", { layerId: String(layerId), blendMode });
  }
  renameLayer(layerId, name) {
    return this.#request("renameLayer", { layerId: String(layerId), name });
  }
  removeLayer(layerId) { return this.#request("removeLayer", { layerId: String(layerId) }); }
  resizeImage(width, height) { return this.#request("resizeImage", { width, height }); }
  resizeCanvas(width, height, options = 4) {
    const { anchor = 4, color = [0, 0, 0, 0] } =
      typeof options === "number" ? { anchor: options } : (options || {});
    return this.#request("resizeCanvas", { width, height, anchor, color });
  }
  rotateCanvas(clockwiseDegrees, color = [0, 0, 0, 0]) {
    return this.#request("rotateCanvas", { clockwiseDegrees, color });
  }
  cropDocument(crop, { clockwiseDegrees = 0, color = [0, 0, 0, 0],
    clipToCanvas = true } = {}) {
    return this.#request("cropDocument", {
      crop, clockwiseDegrees, color, clipToCanvas,
    });
  }
  setSelection(rects) { return this.#request("setSelection", { rects }); }
  setSelectionMask(bounds, gray, { transferOwnership = false } = {}) {
    const owned = transferableInput(gray, transferOwnership);
    return this.#request("setSelectionMask", { bounds, gray: owned.buffer }, [owned.buffer]);
  }
  quickSelect(input) {
    return this.#request("quickSelect", { ...input,
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  magneticLasso(input) {
    return this.#request("magneticLasso", { ...input,
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  previewSelectionRefinement(input) {
    const cancellation = input.cancellation instanceof Int32Array
      ? input.cancellation : new Int32Array(new SharedArrayBuffer(4));
    if (!(cancellation.buffer instanceof SharedArrayBuffer) || cancellation.length < 1) {
      throw new TypeError("Selection refinement cancellation must use shared Int32 storage");
    }
    return this.#request("previewSelectionRefinement", { ...input,
      cancellation: cancellation.buffer,
      layerId: input.layerId == null ? null : String(input.layerId),
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  refineSelection(input) {
    return this.#request("refineSelection", { ...input,
      layerId: input.layerId == null ? null : String(input.layerId),
      expectedStateId: String(input.expectedStateId),
      expectedRevision: String(input.expectedRevision) });
  }
  clearSelection() { return this.#request("setSelection", { rects: [] }); }
  invertSelection() { return this.#request("modifySelection", { type: 19, pixels: 0 }); }
  expandSelection(pixels) { return this.#request("modifySelection", { type: 20, pixels }); }
  contractSelection(pixels) { return this.#request("modifySelection", { type: 21, pixels }); }
  borderSelection(pixels) { return this.#request("modifySelection", { type: 22, pixels }); }
  growSelection(tolerance) { return this.#request("modifySelection", { type: 33, pixels: tolerance }); }
  selectSimilar(tolerance) { return this.#request("modifySelection", { type: 34, pixels: tolerance }); }
  addAlphaChannel(name = "Alpha 1") { return this.#request("addAlphaChannel", { name }); }
  addDocumentPath(input) { return this.#request("addDocumentPath", { input }); }
  selectChannel(channelId) { return this.#request("selectChannel", { channelId: String(channelId) }); }
  selectPath(pathId, feather = 0, combine = 0, antialias = true) {
    return this.#request("selectPath", { pathId: String(pathId), feather, combine, antialias });
  }
  renameChannel(channelId, name) {
    return this.#request("renameChannel", { channelId: String(channelId), name });
  }
  invertChannel(channelId) { return this.#request("invertChannel", { channelId: String(channelId) }); }
  removeChannel(channelId) { return this.#request("removeChannel", { channelId: String(channelId) }); }
  moveChannel(channelId, finalIndex) {
    return this.#request("moveChannel", { channelId: String(channelId), finalIndex });
  }
  renamePath(pathId, name) { return this.#request("renamePath", { pathId: String(pathId), name }); }
  removePath(pathId) { return this.#request("removePath", { pathId: String(pathId) }); }
  movePath(pathId, finalIndex) {
    return this.#request("movePath", { pathId: String(pathId), finalIndex });
  }
  setClippingPath(pathId, clipping) {
    return this.#request("setClippingPath", { pathId: String(pathId), clipping });
  }
  updateDocumentPath(pathId, input) {
    return this.#request("updateDocumentPath", { pathId: String(pathId), input });
  }
  rasterizeLayer(layerId) { return this.#request("rasterizeLayer", { layerId: String(layerId) }); }
  mergeVisibleCopy(name) { return this.#request("mergeVisibleCopy", { name }); }
  createLayerMask(layerId) {
    return this.#request("createLayerMask", { layerId: String(layerId) });
  }
  toggleLayerMask(layerId) {
    return this.#request("toggleLayerMask", { layerId: String(layerId) });
  }
  invertLayerMask(layerId) {
    return this.#request("invertLayerMask", { layerId: String(layerId) });
  }
  setLayerMaskLinked(layerId, linked) {
    return this.#request("setLayerMaskLinked", { layerId: String(layerId), linked: Boolean(linked) });
  }
  removeLayerMask(layerId) {
    return this.#request("removeLayerMask", { layerId: String(layerId) });
  }
  groupLayer(layerId, name = "Group") {
    return this.#request("groupLayer", { layerId: String(layerId), name });
  }
  ungroup(layerId) { return this.#request("ungroup", { layerId: String(layerId) }); }
  addPixelLayer({ name, width, height, bounds, rgba }, { transferOwnership = false } = {}) {
    const owned = transferableInput(rgba, transferOwnership);
    return this.#request("addPixelLayer", {
      name, width, height, bounds, rgba: owned.buffer,
    }, [owned.buffer]);
  }
  layerPixels(layerId) { return this.#request("layerPixels", { layerId: String(layerId) }); }
  layerThumbnail(layerId, maximumEdge, expectedStateId, expectedRevision) {
    return this.#request("layerThumbnail", { layerId: String(layerId), maximumEdge,
      expectedStateId: String(expectedStateId), expectedRevision: String(expectedRevision) });
  }
  layerMaskPixels(layerId) { return this.#request("layerMaskPixels", { layerId: String(layerId) }); }
  replacePixelLayer(layerId, { name, width, height, bounds, rgba },
                    { transferOwnership = false } = {}) {
    const owned = transferableInput(rgba, transferOwnership);
    return this.#request("replacePixelLayer", {
      layerId: String(layerId), name, width, height, bounds, rgba: owned.buffer,
    }, [owned.buffer]);
  }
  replacePixelLayerAndMask(layerId, input, mask, { transferOwnership = false } = {}) {
    const rgba = transferableInput(input.rgba, transferOwnership);
    const gray = transferableInput(mask.gray, transferOwnership);
    return this.#request("replacePixelLayerAndMask", { layerId: String(layerId),
      input: { ...input, rgba: rgba.buffer }, mask: { ...mask, gray: gray.buffer } },
    [rgba.buffer, gray.buffer]);
  }
  addTextLayer(input, { transferOwnership = false } = {}) {
    return this.#textLayerRequest("addTextLayer", null, input, transferOwnership);
  }
  updateTextLayer(layerId, input, { transferOwnership = false } = {}) {
    return this.#textLayerRequest("updateTextLayer", layerId, input, transferOwnership);
  }
  addAdjustment(input) { return this.#request("addAdjustment", { input }); }
  updateAdjustment(layerId, input) {
    return this.#request("updateAdjustment", { layerId: String(layerId), input });
  }
  addVectorShape(input) { return this.#request("addVectorShape", { input }); }
  updateVectorShape(layerId, input) {
    return this.#request("updateVectorShape", { layerId: String(layerId), input });
  }
  setVectorMask(layerId, input) {
    return this.#request("setVectorMask", { layerId: String(layerId), input });
  }
  addSmartObject(input, { transferOwnership = false } = {}) {
    const rgba = transferableInput(input.rgba, transferOwnership);
    const sourceBytes = transferableInput(input.sourceBytes, transferOwnership);
    return this.#request("addSmartObject", {
      input: { ...input, rgba: rgba.buffer, sourceBytes: sourceBytes.buffer },
    }, [rgba.buffer, sourceBytes.buffer]);
  }
  replaceSmartObject(layerId, input, { transferOwnership = false } = {}) {
    const rgba = transferableInput(input.rgba, transferOwnership);
    const sourceBytes = transferableInput(input.sourceBytes, transferOwnership);
    return this.#request("replaceSmartObject", { layerId: String(layerId),
      input: { ...input, rgba: rgba.buffer, sourceBytes: sourceBytes.buffer } },
    [rgba.buffer, sourceBytes.buffer]);
  }
  openSmartObjectContents(layerId) {
    return this.#request("openSmartObjectContents", { layerId: String(layerId) });
  }
  saveSmartObjectContents(documentId) {
    return this.#request("saveSmartObjectContents", { documentId });
  }
  setSmartFilter(layerId, input) {
    return this.#request("setSmartFilter", { layerId: String(layerId), input });
  }
  moveLayer(layerId, targetLayerId, position) {
    return this.#request("moveLayer", {
      layerId: String(layerId),
      targetLayerId: targetLayerId == null ? null : String(targetLayerId),
      position,
    });
  }
  moveLayers(layerIds, targetLayerId, position) {
    return this.#request("moveLayers", {
      layerIds: layerIds.map(String),
      targetLayerId: targetLayerId == null ? null : String(targetLayerId),
      position,
    });
  }
  undo() { return this.#request("undo"); }
  redo() { return this.#request("redo"); }
  historyTravel(steps, expectedStateId, expectedRevision) {
    return this.#request("historyTravel", { steps,
      expectedStateId: String(expectedStateId), expectedRevision: String(expectedRevision) });
  }
  applyFilter(layerId, filterId, parameters = [], onProgress) {
    const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const promise = this.#request("applyFilter", {
      layerId: String(layerId), filterId, parameters, cancellation: cancellation.buffer,
    }, [], onProgress);
    return {
      promise,
      cancel() { Atomics.store(cancellation, 0, 1); },
    };
  }
  invertLayer(layerId, onProgress) {
    return this.applyFilter(layerId, "patchy.filters.invert", [], onProgress);
  }
  renderCancellable(region, onProgress) {
    return this.#cancellableRequest("renderProgress", { region }, onProgress);
  }
  render(region) { return this.#request("render", { region }); }
  renderFrame(region) { return this.#request("renderFrame", { region }); }
  save(format = "psd") { return this.#request("save", { format: saveFormat(format) }); }
  saveCancellable(format = "psd", onProgress) {
    return this.#cancellableRequest("saveProgress", { format: saveFormat(format) }, onProgress);
  }
  saveDocument(documentId, format = "psd") {
    return this.#request("saveDocument", { documentId, format: saveFormat(format) });
  }
  saveBlob(format = "psd") { return this.#request("saveBlob", { format: saveFormat(format) }); }
  saveDocumentBlob(documentId, format = "psd") {
    return this.#request("saveDocumentBlob", { documentId, format: saveFormat(format) });
  }
  markSaved(documentId, expectedStateId) {
    return this.#request("markSaved", { documentId, expectedStateId: String(expectedStateId) });
  }
  close() { return this.#request("close"); }

  #textLayerRequest(method, layerId, input, transferOwnership = false) {
    const owned = transferableInput(input.rgba, transferOwnership);
    return this.#request(method, {
      ...(layerId == null ? {} : { layerId: String(layerId) }),
      input: { ...input, rgba: owned.buffer },
    }, [owned.buffer]);
  }

  #cancellableRequest(method, payload, onProgress) {
    const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const promise = this.#request(method, { ...payload, cancellation: cancellation.buffer },
      [], onProgress);
    return { promise, cancel() { Atomics.store(cancellation, 0, 1); } };
  }

  terminate() {
    this.#worker.terminate();
    this.#crash(new Error("Patchy worker was terminated"), "closed");
  }

  #request(method, payload = {}, transfer = [], onProgress) {
    if (this.#state === "crashed" || this.#state === "closed") {
      return Promise.reject(new Error(`Patchy worker is ${this.#state}`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onProgress });
      this.#worker.postMessage({ id, method, ...payload }, transfer);
    });
  }

  #onMessage(message) {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (message.progress) {
      pending.onProgress?.(message.progress);
      return;
    }
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else {
      const error = new Error(message.error?.message || "Patchy worker request failed");
      error.name = message.error?.name || "Error";
      error.code = message.error?.code;
      pending.reject(error);
    }
  }

  #crash(error, state = "crashed") {
    this.#setState(state, error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #setState(state, error = null) {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) {
      try { listener(state, error); } catch { /* Lifecycle observers cannot break RPC cleanup. */ }
    }
  }
}
