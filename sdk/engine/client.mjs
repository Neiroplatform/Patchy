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
  replacePixelLayer(layerId, { name, width, height, bounds, rgba }) {
    const owned = rgba.slice();
    return this.#request("replacePixelLayer", {
      layerId: String(layerId), name, width, height, bounds, rgba: owned.buffer,
    }, [owned.buffer]);
  }
  addTextLayer(input) { return this.#textLayerRequest("addTextLayer", null, input); }
  updateTextLayer(layerId, input) {
    return this.#textLayerRequest("updateTextLayer", layerId, input);
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
