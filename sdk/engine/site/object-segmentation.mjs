export const OBJECT_SEGMENTATION_MODEL = Object.freeze({
  id: "mediapipe-magic-touch-int8-v1",
  path: "./ml/models/magic-touch-int8-v1.task",
  sha256: "38431bc66b883404e8397f74c3579404315b9b52b04a46c6346fe906a7309b03",
  bytes: 30525312,
});
export const OBJECT_SEGMENTATION_RUNTIME = Object.freeze({
  id: "mediapipe-tasks-vision",
  version: "1.1.0",
  bundleSha256: "9d5fc9ef74b22329cf9aa88dc543956d192b8c254210b187271614713eb5b10c",
});

export function objectSegmentationDelegate(renderer) {
  const value = String(renderer || "").trim();
  if (!value || /swiftshader|llvmpipe|lavapipe|software|basic render|\bwarp\b|virtualbox|vmware/i.test(value))
    return "wasm";
  return "gpu";
}

export function proposalMatchesSnapshot(proposal, snapshot) {
  return Boolean(proposal && snapshot &&
    proposal.documentId === String(snapshot.documentId) &&
    proposal.stateId === String(snapshot.stateId) &&
    proposal.revision === Number(snapshot.revision) &&
    proposal.width === Number(snapshot.width) && proposal.height === Number(snapshot.height));
}

export function objectSelectionIdentityMatches(left, right) {
  if (!left || !right || String(left.documentId) !== String(right.documentId) ||
      String(left.stateId) !== String(right.stateId) || Number(left.revision) !== Number(right.revision) ||
      Number(left.width) !== Number(right.width) || Number(left.height) !== Number(right.height) ||
      String(left.source || "") !== String(right.source || "")) return false;
  const leftLayers = (left.sourceLayerIds || []).map(String);
  const rightLayers = (right.sourceLayerIds || []).map(String);
  return leftLayers.length === rightLayers.length &&
    leftLayers.every((value, index) => value === rightLayers[index]);
}

export function scaleConfidenceMask(source, sourceWidth, sourceHeight, width, height) {
  if (!(source instanceof Float32Array) || source.length !== sourceWidth * sourceHeight)
    throw new TypeError("invalid confidence mask");
  if (![sourceWidth, sourceHeight, width, height].every((value) => Number.isInteger(value) && value > 0))
    throw new RangeError("mask dimensions must be positive integers");
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; ++y) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + .5) * sourceHeight / height));
    for (let x = 0; x < width; ++x) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + .5) * sourceWidth / width));
      result[y * width + x] = Math.round(Math.max(0, Math.min(1,
        source[sourceY * sourceWidth + sourceX])) * 255);
    }
  }
  return result;
}

export function combineSelectionMasks(current, proposed, mode = "replace") {
  if (!(current instanceof Uint8Array) || !(proposed instanceof Uint8Array) ||
      current.length !== proposed.length) throw new TypeError("selection masks must have equal byte coverage");
  if (!['replace', 'add', 'subtract', 'intersect'].includes(mode))
    throw new TypeError("selection combine mode is invalid");
  const result = new Uint8Array(proposed);
  if (mode === "replace") return result;
  for (let index = 0; index < result.length; ++index) {
    if (mode === "add") result[index] = Math.max(current[index], result[index]);
    else if (mode === "subtract") result[index] = Math.round(current[index] * (255 - result[index]) / 255);
    else result[index] = Math.min(current[index], result[index]);
  }
  return result;
}

export function normalizedPromptPoint(point, width, height) {
  return { x: Math.max(0, Math.min(1, point.x / width)),
    y: Math.max(0, Math.min(1, point.y / height)) };
}

export function clickPromptStroke(point, width, height) {
  const center = normalizedPromptPoint(point, width, height);
  const start = Math.max(0, Math.min(.92, center.x - .04));
  return [0, .02, .04, .06, .08].map((delta) =>
    ({ x: Math.round((start + delta) * 1e6) / 1e6, y: center.y }));
}

export function rectanglePromptStroke(start, end, width, height) {
  const left = Math.min(start.x, end.x); const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y); const bottom = Math.max(start.y, end.y);
  return [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom },
    { x: left, y: bottom }, { x: left, y: top },
  ].map((point) => normalizedPromptPoint(point, width, height));
}

export class ObjectSegmentationClient {
  constructor(worker = null, timeouts = {}) {
    this.externalWorker = Boolean(worker); this.closed = false;
    this.sequence = 0; this.pending = new Map(); this.outbox = [];
    this.timeouts = { setImage: Number(timeouts.setImage) > 0 ? Number(timeouts.setImage) : 120_000,
      segment: Number(timeouts.segment) > 0 ? Number(timeouts.segment) : 15_000 };
    this.attach(worker || this.createWorker());
  }

  createWorker() {
    return new Worker(new URL("./object-segmentation-worker.mjs", import.meta.url),
      { type: "module", name: "patchy-object-segmentation" });
  }

  attach(worker) {
    this.worker = worker; this.workerReady = this.externalWorker;
    worker.addEventListener("message", ({ data }) => {
      if (data.type === "worker-ready") {
        this.workerReady = true;
        for (const request of this.outbox.splice(0)) this.send(request);
        return;
      }
      const pending = this.pending.get(data.requestId);
      if (!pending) return;
      if (data.type === "progress") { pending.onProgress?.(data); return; }
      this.pending.delete(data.requestId);
      clearTimeout(pending.timeout);
      if (data.type === "error") pending.reject(Object.assign(new Error(data.message), { code: data.code }));
      else pending.resolve(data);
    });
    worker.addEventListener("error", (event) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout); pending.reject(event.error || new Error(event.message));
      }
      this.pending.clear(); this.outbox = [];
    });
  }

  send(request) {
    if (!this.pending.has(request.message.requestId)) return;
    const timeoutMs = request.message.type === "set-image" ? this.timeouts.setImage : this.timeouts.segment;
    request.pending.timeout = setTimeout(() => {
      if (!this.pending.has(request.message.requestId)) return;
      const error = Object.assign(new Error(`Object segmentation ${request.message.type} timed out`),
        { code: "INFERENCE_TIMEOUT" });
      for (const item of this.pending.values()) { clearTimeout(item.timeout); item.reject(error); }
      this.pending.clear(); this.outbox = []; this.worker.terminate(); ++this.sequence;
      if (this.externalWorker) this.closed = true;
      else if (!this.closed) this.attach(this.createWorker());
    }, timeoutMs);
    this.worker.postMessage(request.message, request.transfer);
  }

  request(type, payload = {}, transfer = [], onProgress = null) {
    if (this.closed) return Promise.reject(new Error("Object segmentation client is closed"));
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, onProgress, timeout: null };
      this.pending.set(requestId, pending);
      const request = { message: { type, requestId, ...payload }, transfer, pending };
      if (this.workerReady) this.send(request); else this.outbox.push(request);
    });
  }

  setImage(bitmap, identity, onProgress = null) {
    return this.request("set-image", { bitmap, identity }, [bitmap], onProgress);
  }
  segment(strokes, identity) { return this.request("segment", { strokes, identity }); }
  cancel() {
    const error = Object.assign(new Error("Object segmentation cancelled"), { name: "AbortError" });
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear(); this.outbox = [];
    this.worker.terminate();
    ++this.sequence;
    if (this.externalWorker) this.closed = true;
    else if (!this.closed) this.attach(this.createWorker());
  }
  close() {
    this.closed = true;
    const error = Object.assign(new Error("Object segmentation closed"), { name: "AbortError" });
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear(); this.outbox = []; this.worker.terminate();
  }
}
