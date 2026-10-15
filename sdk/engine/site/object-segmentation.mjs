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
  wasmModuleSha256: "ee03b14a878e6c3c053a1bfa62e166dc45244be54dc0bbe61c578f710b771f6a",
  wasmModuleBytes: 12997272,
});

export async function readResponseBytesWithProgress(response, expectedBytes, onProgress = null) {
  if (!(response instanceof Response) || !Number.isInteger(expectedBytes) || expectedBytes <= 0)
    throw new TypeError("A bounded asset response is required");
  const bytes = new Uint8Array(expectedBytes);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const fallback = new Uint8Array(await response.arrayBuffer());
    if (fallback.byteLength !== expectedBytes) throw new RangeError("Asset byte count mismatch");
    bytes.set(fallback); onProgress?.(1); return bytes;
  }
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array) || received + value.byteLength > expectedBytes)
      throw new RangeError("Asset byte count mismatch");
    bytes.set(value, received); received += value.byteLength;
    onProgress?.(received / expectedBytes);
  }
  if (received !== expectedBytes) throw new RangeError("Asset byte count mismatch");
  return bytes;
}

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

function binaryErodeCross(source, width, height) {
  const result = new Uint8Array(source.length);
  for (let y = 1; y + 1 < height; ++y) {
    for (let x = 1; x + 1 < width; ++x) {
      const index = y * width + x;
      result[index] = source[index] && source[index - 1] && source[index + 1] &&
        source[index - width] && source[index + width] ? 1 : 0;
    }
  }
  return result;
}

function binaryDilateCross(source, width, height) {
  const result = new Uint8Array(source.length);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const index = y * width + x;
      result[index] = source[index] || (x > 0 && source[index - 1]) ||
        (x + 1 < width && source[index + 1]) || (y > 0 && source[index - width]) ||
        (y + 1 < height && source[index + width]) ? 1 : 0;
    }
  }
  return result;
}

function maskComponents(binary, width, height, foreground, diagonals = true) {
  const visited = new Uint8Array(binary.length); const components = [];
  const queue = new Int32Array(binary.length);
  for (let start = 0; start < binary.length; ++start) {
    if (visited[start] || Boolean(binary[start]) !== foreground) continue;
    let head = 0; let tail = 0; let touchesBorder = false;
    queue[tail++] = start; visited[start] = 1;
    while (head < tail) {
      const index = queue[head++]; const x = index % width; const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x + 1 === width || y + 1 === height) touchesBorder = true;
      for (let offsetY = -1; offsetY <= 1; ++offsetY) {
        const nextY = y + offsetY; if (nextY < 0 || nextY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; ++offsetX) {
          if (offsetX === 0 && offsetY === 0) continue;
          if (!diagonals && offsetX !== 0 && offsetY !== 0) continue;
          const nextX = x + offsetX; if (nextX < 0 || nextX >= width) continue;
          const next = nextY * width + nextX;
          if (!visited[next] && Boolean(binary[next]) === foreground) {
            visited[next] = 1; queue[tail++] = next;
          }
        }
      }
    }
    components.push({ pixels: queue.slice(0, tail), touchesBorder });
  }
  return components;
}

export function refineObjectSelectionMask(source, width, height) {
  if (!(source instanceof Uint8Array) || source.length !== width * height)
    throw new TypeError("invalid object selection mask");
  if (![width, height].every((value) => Number.isInteger(value) && value > 0))
    throw new RangeError("mask dimensions must be positive integers");
  const result = new Uint8Array(source);
  if (width < 5 || height < 5) return result;

  const binary = Uint8Array.from(source, (coverage) => coverage >= 128 ? 1 : 0);
  const opened = binaryDilateCross(binaryErodeCross(binary, width, height), width, height);
  for (let index = 0; index < binary.length; ++index) {
    // A one-pixel, low-confidence spur is usually model noise. Preserve strong
    // fine detail (hair, whiskers and fingers) even when opening removes it.
    if (binary[index] && !opened[index] && source[index] < 208) binary[index] = 0;
  }

  const foreground = maskComponents(binary, width, height, true);
  const largestArea = foreground.reduce((largest, component) =>
    Math.max(largest, component.pixels.length), 0);
  const islandLimit = Math.max(4, Math.floor(Math.min(binary.length * .0005,
    largestArea * .02)));
  for (const component of foreground) {
    if (component.pixels.length >= islandLimit) continue;
    for (const index of component.pixels) binary[index] = 0;
  }

  const selectedArea = binary.reduce((sum, value) => sum + value, 0);
  const holeLimit = Math.max(4, Math.floor(Math.min(binary.length * .0035,
    selectedArea * .015)));
  for (const component of maskComponents(binary, width, height, false, false)) {
    if (component.touchesBorder || component.pixels.length > holeLimit) continue;
    for (const index of component.pixels) binary[index] = 1;
  }

  for (let index = 0; index < result.length; ++index) {
    if (!binary[index]) result[index] = 0;
    else if (source[index] < 128) result[index] = 255;
  }
  return result;
}

export function scaleConfidenceMask(source, sourceWidth, sourceHeight, width, height) {
  if (!(source instanceof Float32Array) || source.length !== sourceWidth * sourceHeight)
    throw new TypeError("invalid confidence mask");
  if (![sourceWidth, sourceHeight, width, height].every((value) => Number.isInteger(value) && value > 0))
    throw new RangeError("mask dimensions must be positive integers");
  const sourceMask = refineObjectSelectionMask(Uint8Array.from(source,
    (coverage) => Math.round(Math.max(0, Math.min(1, coverage)) * 255)),
  sourceWidth, sourceHeight);
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; ++y) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + .5) * sourceHeight / height));
    for (let x = 0; x < width; ++x) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + .5) * sourceWidth / width));
      result[y * width + x] = sourceMask[sourceY * sourceWidth + sourceX];
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
    this.timeouts = { setImage: Number(timeouts.setImage) > 0 ? Number(timeouts.setImage) : 600_000,
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
