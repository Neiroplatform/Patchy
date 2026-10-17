import { evictSameOriginCachedResponse, installSameOriginFetch,
  responseCacheCommit } from "./ml-network-policy.mjs";
import { OBJECT_SEGMENTATION_MODEL, OBJECT_SEGMENTATION_RUNTIME,
  automaticDetailPromptStroke, boundedObjectPreviewSize, chooseAutomaticDetailConfidence,
  objectSegmentationDelegate, objectSelectionIdentityMatches,
  readResponseBytesWithProgress,
  shouldAttemptAutomaticDetailConfidence,
  withObjectSegmentationRuntimeFallback } from "./object-segmentation.mjs";

const CACHE_NAME =
  `patchy-ml-${OBJECT_SEGMENTATION_MODEL.sha256.slice(0, 12)}-${OBJECT_SEGMENTATION_RUNTIME.bundleSha256.slice(0, 12)}`;
installSameOriginFetch(globalThis, { cacheName: CACHE_NAME });
const { FilesetResolver, InteractiveSegmenter } =
  await import("./ml/mediapipe/vision_bundle.mjs");
const { default: visionModuleFactory } =
  await import("./ml/mediapipe/wasm/vision_wasm_module_internal.js");

const MODEL_PATH = new URL("./ml/models/magic-touch-int8-v1.task", import.meta.url).href;
const WASM_ROOT = new URL("./ml/mediapipe/wasm/", import.meta.url).href;
let assetsPromise = null;
let segmenterPromise = null;
let runtimeTier = null;
let forceWasm = false;
let imageIdentity = null;
let renderCanvas = new OffscreenCanvas(1, 1);
const sourceCanvas = new OffscreenCanvas(1, 1);

function recreateRenderCanvas(width = renderCanvas.width, height = renderCanvas.height) {
  renderCanvas = new OffscreenCanvas(width, height);
}

async function createSegmenter(loaded, delegate = null) {
  // MediaPipe consumes and clears self.ModuleFactory after every construction.
  // Re-importing the loader cannot restore it because ES modules are cached, so
  // retain the exact local factory and explicitly install it for each runtime.
  self.ModuleFactory = visionModuleFactory;
  self.Module = { wasmBinary: loaded.wasmBinary.slice() };
  return InteractiveSegmenter.createFromOptions(loaded.files, {
    baseOptions: { modelAssetBuffer: loaded.modelAssetBuffer.slice(),
      ...(delegate ? { delegate } : {}) }, canvas: renderCanvas,
  });
}

async function loadLocalAsset(path, expectedBytes, label, onProgress) {
  let firstError = null;
  for (const cache of ["force-cache", "reload"]) {
    let response = null;
    try {
      response = await fetch(path, { cache, credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await readResponseBytesWithProgress(response, expectedBytes, onProgress);
      await responseCacheCommit(response);
      return bytes;
    } catch (error) {
      firstError ??= error;
      if (response) await responseCacheCommit(response);
      await evictSameOriginCachedResponse(globalThis, CACHE_NAME, path).catch(() => false);
      if (cache === "force-cache") continue;
      const reason = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`Could not load local ${label} after cache recovery (${reason}).`,
        { cause: firstError }), { code: "LOCAL_ASSET_LOAD_FAILED" });
    }
  }
  throw firstError;
}

function preferredDelegate() {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const extension = context?.getExtension("WEBGL_debug_renderer_info");
    const renderer = extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : "";
    return objectSegmentationDelegate(renderer);
  } catch { return "wasm"; }
}

async function assets(requestId) {
  if (!assetsPromise) {
    const pending = (async () => {
      self.postMessage({ type: "progress", requestId, phase: "runtime", ratio: .05 });
      const files = await FilesetResolver.forVisionTasks(WASM_ROOT, true);
      let lastRuntimePercent = -1;
      const wasmBinary = await loadLocalAsset(files.wasmBinaryPath,
        OBJECT_SEGMENTATION_RUNTIME.wasmModuleBytes, "runtime", (ratio) => {
        const percent = Math.floor(ratio * 100);
        if (percent === lastRuntimePercent) return;
        lastRuntimePercent = percent;
        self.postMessage({ type: "progress", requestId, phase: "runtime", ratio: .05 + ratio * .1 });
        });
      self.postMessage({ type: "progress", requestId, phase: "model", ratio: .2 });
      let lastPercent = -1;
      const modelAssetBuffer = await loadLocalAsset(MODEL_PATH,
        OBJECT_SEGMENTATION_MODEL.bytes, "model", (ratio) => {
        const percent = Math.floor(ratio * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;
        self.postMessage({ type: "progress", requestId, phase: "model", ratio: .2 + ratio * .4 });
        });
      return { files, wasmBinary, modelAssetBuffer };
    })();
    assetsPromise = pending;
    pending.catch(() => { if (assetsPromise === pending) assetsPromise = null; });
  }
  return assetsPromise;
}

async function segmenter(requestId) {
  if (!segmenterPromise) {
    const pending = (async () => {
      const loaded = await assets(requestId);
      self.postMessage({ type: "progress", requestId, phase: "initializing", ratio: .65 });
      if (!forceWasm && preferredDelegate() === "gpu") {
        try {
          const engine = await createSegmenter(loaded, "GPU");
          runtimeTier = "gpu"; return engine;
        } catch {
          forceWasm = true;
          recreateRenderCanvas();
        }
      }
      const engine = await createSegmenter(loaded);
      runtimeTier = "wasm"; return engine;
    })();
    segmenterPromise = pending;
    pending.catch(() => { if (segmenterPromise === pending) segmenterPromise = null; });
  }
  return segmenterPromise;
}

async function disposeSegmenter() {
  const pending = segmenterPromise;
  segmenterPromise = null; runtimeTier = null;
  if (!pending) return;
  try { (await pending).close?.(); } catch {}
}

async function useWasmFallback(requestId) {
  if (runtimeTier !== "gpu") throw new Error("Local WASM inference failed");
  await disposeSegmenter(); forceWasm = true;
  recreateRenderCanvas();
  const engine = await segmenter(requestId);
  engine.setImage(sourceCanvas);
  return engine;
}

function confidenceFromMask(mask) {
  const confidence = new Float32Array(mask.getAsFloat32Array());
  const width = mask.width; const height = mask.height; mask.close();
  return { confidence, width, height };
}

function segmentWithAutomaticDetail(engine, strokes) {
  // promptIntent belongs to Patchy's routing boundary, not MediaPipe's public
  // prompt contract. Strip it before invoking the third-party runtime.
  const modelStrokes = strokes.map(({ promptIntent: _promptIntent, ...stroke }) => stroke);
  const primary = confidenceFromMask(engine.segment(modelStrokes));
  const detailStrokes = automaticDetailPromptStroke(strokes, sourceCanvas.width, sourceCanvas.height);
  const prompt = strokes[0]?.point?.[2];
  if (!detailStrokes || !shouldAttemptAutomaticDetailConfidence(primary.confidence,
    primary.width, primary.height, prompt)) return { ...primary, automaticDetailApplied: false };
  let detail;
  try { detail = confidenceFromMask(engine.segment(detailStrokes)); }
  catch (error) {
    if (runtimeTier === "gpu") throw error;
    return { ...primary, automaticDetailApplied: false };
  }
  if (detail.width !== primary.width || detail.height !== primary.height)
    return { ...primary, automaticDetailApplied: false };
  const chosen = chooseAutomaticDetailConfidence(primary.confidence, detail.confidence,
    primary.width, primary.height, prompt);
  return { confidence: chosen.confidence, width: primary.width, height: primary.height,
    automaticDetailApplied: chosen.automaticDetailApplied };
}

self.addEventListener("message", async ({ data }) => {
  try {
    if (data.type === "preload") {
      await assets(data.requestId);
      self.postMessage({ type: "assets-ready", requestId: data.requestId,
        modelHash: OBJECT_SEGMENTATION_MODEL.sha256,
        runtimeHash: OBJECT_SEGMENTATION_RUNTIME.bundleSha256 });
      return;
    }
    if (data.type === "set-image") {
      const size = boundedObjectPreviewSize(data.bitmap.width, data.bitmap.height);
      const dimensionsChanged = renderCanvas.width !== size.width || renderCanvas.height !== size.height;
      if (dimensionsChanged) await disposeSegmenter();
      sourceCanvas.width = size.width; sourceCanvas.height = size.height;
      sourceCanvas.getContext("2d", { alpha: true }).drawImage(data.bitmap, 0, 0, size.width, size.height);
      data.bitmap.close?.();
      if (dimensionsChanged) recreateRenderCanvas(size.width, size.height);
      let engine = await segmenter(data.requestId);
      engine = await withObjectSegmentationRuntimeFallback(runtimeTier,
        () => { engine.setImage(sourceCanvas); return engine; },
        async () => useWasmFallback(data.requestId));
      imageIdentity = data.identity;
      self.postMessage({ type: "image-ready", requestId: data.requestId, identity: imageIdentity,
        runtimeTier, previewWidth: size.width, previewHeight: size.height });
      return;
    }
    if (data.type !== "segment") return;
    if (!objectSelectionIdentityMatches(imageIdentity, data.identity)) {
      self.postMessage({ type: "error", requestId: data.requestId, code: "STALE_IMAGE",
        message: "The segmentation image no longer matches the document state." });
      return;
    }
    const started = performance.now();
    let engine = await segmenter(data.requestId); let result;
    result = await withObjectSegmentationRuntimeFallback(runtimeTier,
      () => segmentWithAutomaticDetail(engine, data.strokes), async () => {
        engine = await useWasmFallback(data.requestId);
        return segmentWithAutomaticDetail(engine, data.strokes);
      });
    self.postMessage({ type: "mask", requestId: data.requestId, identity: imageIdentity,
      width: result.width, height: result.height, confidence: result.confidence,
      automaticDetailApplied: result.automaticDetailApplied,
      latencyMs: performance.now() - started, runtimeTier }, [result.confidence.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", requestId: data.requestId,
      code: error?.code || "INFERENCE_FAILED",
      message: error instanceof Error ? error.message : String(error) });
  }
});

self.postMessage({ type: "worker-ready" });
