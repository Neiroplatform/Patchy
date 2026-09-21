export class PatchyWorkerClient {
  #worker;
  #nextId = 1;
  #pending = new Map();
  #state = "starting";
  #capabilities = 0n;

  constructor(worker) {
    this.#worker = worker;
    worker.addEventListener("message", (event) => this.#onMessage(event.data));
    worker.addEventListener("error", (event) => this.#crash(event.error || new Error(event.message)));
    worker.addEventListener("messageerror", () => this.#crash(new Error("Patchy worker message decoding failed")));
  }

  get state() { return this.#state; }
  get capabilities() { return this.#capabilities; }

  async initialize(moduleUrl, moduleOptions = {}) {
    if (typeof window !== "undefined" && !globalThis.crossOriginIsolated) {
      throw new Error("Patchy Worker requires COOP/COEP cross-origin isolation");
    }
    const info = await this.#request("initialize", { moduleUrl, moduleOptions });
    this.#capabilities = info.capabilities;
    this.#state = "ready";
  }

  open(bytes) {
    const owned = bytes.slice();
    return this.#request("open", { bytes: owned.buffer }, [owned.buffer]);
  }
  create(width, height) { return this.#request("create", { width, height }); }
  snapshot() { return this.#request("snapshot"); }
  setLayerVisibility(layerId, visible) {
    return this.#request("setLayerVisibility", { layerId: String(layerId), visible });
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
  setLayerBlendMode(layerId, blendMode) {
    return this.#request("setLayerBlendMode", { layerId: String(layerId), blendMode });
  }
  renameLayer(layerId, name) {
    return this.#request("renameLayer", { layerId: String(layerId), name });
  }
  removeLayer(layerId) { return this.#request("removeLayer", { layerId: String(layerId) }); }
  resizeImage(width, height) { return this.#request("resizeImage", { width, height }); }
  resizeCanvas(width, height, anchor = 4) {
    return this.#request("resizeCanvas", { width, height, anchor });
  }
  rotateCanvas(clockwiseDegrees) {
    return this.#request("rotateCanvas", { clockwiseDegrees });
  }
  cropDocument(crop) { return this.#request("cropDocument", { crop }); }
  setSelection(rects) { return this.#request("setSelection", { rects }); }
  clearSelection() { return this.#request("setSelection", { rects: [] }); }
  invertSelection() { return this.#request("modifySelection", { type: 19, pixels: 0 }); }
  expandSelection(pixels) { return this.#request("modifySelection", { type: 20, pixels }); }
  contractSelection(pixels) { return this.#request("modifySelection", { type: 21, pixels }); }
  borderSelection(pixels) { return this.#request("modifySelection", { type: 22, pixels }); }
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
  removeLayerMask(layerId) {
    return this.#request("removeLayerMask", { layerId: String(layerId) });
  }
  groupLayer(layerId, name = "Group") {
    return this.#request("groupLayer", { layerId: String(layerId), name });
  }
  ungroup(layerId) { return this.#request("ungroup", { layerId: String(layerId) }); }
  addPixelLayer({ name, width, height, bounds, rgba }) {
    const owned = rgba.slice();
    return this.#request("addPixelLayer", {
      name, width, height, bounds, rgba: owned.buffer,
    }, [owned.buffer]);
  }
  layerPixels(layerId) { return this.#request("layerPixels", { layerId: String(layerId) }); }
  layerMaskPixels(layerId) { return this.#request("layerMaskPixels", { layerId: String(layerId) }); }
  replacePixelLayer(layerId, { name, width, height, bounds, rgba }) {
    const owned = rgba.slice();
    return this.#request("replacePixelLayer", {
      layerId: String(layerId), name, width, height, bounds, rgba: owned.buffer,
    }, [owned.buffer]);
  }
  replacePixelLayerAndMask(layerId, input, mask) {
    const rgba = input.rgba.slice(); const gray = mask.gray.slice();
    return this.#request("replacePixelLayerAndMask", { layerId: String(layerId),
      input: { ...input, rgba: rgba.buffer }, mask: { ...mask, gray: gray.buffer } },
    [rgba.buffer, gray.buffer]);
  }
  addTextLayer(input) { return this.#textLayerRequest("addTextLayer", null, input); }
  updateTextLayer(layerId, input) {
    return this.#textLayerRequest("updateTextLayer", layerId, input);
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
  addSmartObject(input) {
    const rgba = input.rgba.slice();
    const sourceBytes = input.sourceBytes.slice();
    return this.#request("addSmartObject", {
      input: { ...input, rgba: rgba.buffer, sourceBytes: sourceBytes.buffer },
    }, [rgba.buffer, sourceBytes.buffer]);
  }
  replaceSmartObject(layerId, input) {
    const rgba = input.rgba.slice(); const sourceBytes = input.sourceBytes.slice();
    return this.#request("replaceSmartObject", { layerId: String(layerId),
      input: { ...input, rgba: rgba.buffer, sourceBytes: sourceBytes.buffer } },
    [rgba.buffer, sourceBytes.buffer]);
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
  undo() { return this.#request("undo"); }
  redo() { return this.#request("redo"); }
  invertLayer(layerId, onProgress) {
    const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const promise = this.#request("invertLayer", {
      layerId: String(layerId), cancellation: cancellation.buffer,
    }, [], onProgress);
    return {
      promise,
      cancel() { Atomics.store(cancellation, 0, 1); },
    };
  }
  render(region) { return this.#request("render", { region }); }
  save() { return this.#request("save"); }
  close() { return this.#request("close"); }

  #textLayerRequest(method, layerId, input) {
    const owned = input.rgba.slice();
    return this.#request(method, {
      ...(layerId == null ? {} : { layerId: String(layerId) }),
      input: { ...input, rgba: owned.buffer },
    }, [owned.buffer]);
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
    this.#state = state;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
