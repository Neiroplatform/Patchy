import { installSameOriginFetch, responseCacheCommit } from "./ml-network-policy.mjs";
import { OBJECT_SEGMENTATION_MODEL, OBJECT_SEGMENTATION_RUNTIME,
  automaticDetailPromptStroke, boundedObjectPreviewSize, chooseAutomaticDetailConfidence,
  objectSegmentationDelegate, objectSelectionIdentityMatches,
  readResponseBytesWithProgress,
  shouldAttemptAutomaticDetailConfidence,
  withObjectSegmentationRuntimeFallback } from "./object-segmentation.mjs";

installSameOriginFetch(globalThis, { cacheName:
  `patchy-ml-${OBJECT_SEGMENTATION_MODEL.sha256.slice(0, 12)}-${OBJECT_SEGMENTATION_RUNTIME.bundleSha256.slice(0, 12)}` });
const { FilesetResolver, InteractiveSegmenter } =
  await import("./ml/mediapipe/vision_bundle.mjs");

const MODEL_PATH = new URL("./ml/models/magic-touch-int8-v1.task", import.meta.url).href;
const WASM_ROOT = new URL("./ml/mediapipe/wasm/", import.meta.url).href;
let assetsPromise = null;
let segmenterPromise = null;
let runtimeTier = null;
let forceWasm = false;
let imageIdentity = null;
const renderCanvas = new OffscreenCanvas(1, 1);
const sourceCanvas = new OffscreenCanvas(1, 1);

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
  assetsPromise ??= (async () => {
    self.postMessage({ type: "progress", requestId, phase: "runtime", ratio: .05 });
    const files = await FilesetResolver.forVisionTasks(WASM_ROOT, true);
    const wasmResponse = await fetch(files.wasmBinaryPath,
      { cache: "force-cache", credentials: "same-origin" });
    if (!wasmResponse.ok) throw new Error(`Could not load local runtime (${wasmResponse.status}).`);
    let lastRuntimePercent = -1;
    const wasmBinary = await readResponseBytesWithProgress(wasmResponse,
      OBJECT_SEGMENTATION_RUNTIME.wasmModuleBytes, (ratio) => {
        const percent = Math.floor(ratio * 100);
        if (percent === lastRuntimePercent) return;
        lastRuntimePercent = percent;
        self.postMessage({ type: "progress", requestId, phase: "runtime", ratio: .05 + ratio * .1 });
      });
    await responseCacheCommit(wasmResponse);
    self.postMessage({ type: "progress", requestId, phase: "model", ratio: .2 });
    const response = await fetch(MODEL_PATH, { cache: "force-cache", credentials: "same-origin" });
    if (!response.ok) throw new Error(`Could not load local model (${response.status}).`);
    let lastPercent = -1;
    const modelAssetBuffer = await readResponseBytesWithProgress(response,
      OBJECT_SEGMENTATION_MODEL.bytes, (ratio) => {
        const percent = Math.floor(ratio * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;
        self.postMessage({ type: "progress", requestId, phase: "model", ratio: .2 + ratio * .4 });
      });
    await responseCacheCommit(response);
    return { files, wasmBinary, modelAssetBuffer };
  })();
  return assetsPromise;
}

async function segmenter(requestId) {
  segmenterPromise ??= (async () => {
    const loaded = await assets(requestId);
    self.postMessage({ type: "progress", requestId, phase: "initializing", ratio: .65 });
    if (!forceWasm && preferredDelegate() === "gpu") {
      try {
        self.Module = { wasmBinary: loaded.wasmBinary.slice() };
        const engine = await InteractiveSegmenter.createFromOptions(loaded.files, {
          baseOptions: { modelAssetBuffer: loaded.modelAssetBuffer.slice(), delegate: "GPU" }, canvas: renderCanvas,
        });
        runtimeTier = "gpu"; return engine;
      } catch { forceWasm = true; }
    }
    self.Module = { wasmBinary: loaded.wasmBinary.slice() };
    const engine = await InteractiveSegmenter.createFromOptions(loaded.files, {
      baseOptions: { modelAssetBuffer: loaded.modelAssetBuffer.slice() }, canvas: renderCanvas,
    });
    runtimeTier = "wasm"; return engine;
  })();
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
  const primary = confidenceFromMask(engine.segment(strokes));
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
    if (data.type === "set-image") {
      const size = boundedObjectPreviewSize(data.bitmap.width, data.bitmap.height);
      const dimensionsChanged = renderCanvas.width !== size.width || renderCanvas.height !== size.height;
      if (dimensionsChanged) await disposeSegmenter();
      sourceCanvas.width = size.width; sourceCanvas.height = size.height;
      sourceCanvas.getContext("2d", { alpha: true }).drawImage(data.bitmap, 0, 0, size.width, size.height);
      data.bitmap.close?.();
      if (dimensionsChanged) { renderCanvas.width = size.width; renderCanvas.height = size.height; }
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
    self.postMessage({ type: "error", requestId: data.requestId, code: "INFERENCE_FAILED",
      message: error instanceof Error ? error.message : String(error) });
  }
});

self.postMessage({ type: "worker-ready" });
