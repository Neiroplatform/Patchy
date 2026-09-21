export class PatchyWorkerClient {
  #worker;
  #nextId = 1;
  #pending = new Map();
  #state = "starting";

  constructor(worker) {
    this.#worker = worker;
    worker.addEventListener("message", (event) => this.#onMessage(event.data));
    worker.addEventListener("error", (event) => this.#crash(event.error || new Error(event.message)));
    worker.addEventListener("messageerror", () => this.#crash(new Error("Patchy worker message decoding failed")));
  }

  get state() { return this.#state; }

  async initialize(moduleUrl, moduleOptions = {}) {
    if (typeof window !== "undefined" && !globalThis.crossOriginIsolated) {
      throw new Error("Patchy Worker requires COOP/COEP cross-origin isolation");
    }
    await this.#request("initialize", { moduleUrl, moduleOptions });
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
  moveLayer(layerId, targetLayerId, position) {
    return this.#request("moveLayer", {
      layerId: String(layerId),
      targetLayerId: targetLayerId == null ? null : String(targetLayerId),
      position,
    });
  }
  undo() { return this.#request("undo"); }
  redo() { return this.#request("redo"); }
  render(region) { return this.#request("render", { region }); }
  save() { return this.#request("save"); }
  close() { return this.#request("close"); }

  terminate() {
    this.#worker.terminate();
    this.#crash(new Error("Patchy worker was terminated"), "closed");
  }

  #request(method, payload = {}, transfer = []) {
    if (this.#state === "crashed" || this.#state === "closed") {
      return Promise.reject(new Error(`Patchy worker is ${this.#state}`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, method, ...payload }, transfer);
    });
  }

  #onMessage(message) {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
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
