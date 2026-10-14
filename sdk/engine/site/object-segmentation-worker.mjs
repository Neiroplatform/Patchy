import { installSameOriginFetch } from "./ml-network-policy.mjs";
import { OBJECT_SEGMENTATION_MODEL, OBJECT_SEGMENTATION_RUNTIME,
  objectSegmentationDelegate, objectSelectionIdentityMatches } from "./object-segmentation.mjs";

installSameOriginFetch(globalThis, { cacheName:
  `patchy-ml-${OBJECT_SEGMENTATION_MODEL.sha256.slice(0, 12)}-${OBJECT_SEGMENTATION_RUNTIME.bundleSha256.slice(0, 12)}` });
const { FilesetResolver, InteractiveSegmenter } =
  await import("./ml/mediapipe/vision_bundle.mjs");

const MODEL_PATH = new URL("./ml/models/magic-touch-int8-v1.task", import.meta.url).href;
const WASM_ROOT = new URL("./ml/mediapipe/wasm/", import.meta.url).href;
let segmenterPromise = null;
let runtimeTier = null;
let imageIdentity = null;
const renderCanvas = new OffscreenCanvas(1, 1);

function preferredDelegate() {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const extension = context?.getExtension("WEBGL_debug_renderer_info");
    const renderer = extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : "";
    return objectSegmentationDelegate(renderer);
  } catch { return "wasm"; }
}

async function segmenter(requestId) {
  segmenterPromise ??= (async () => {
    self.postMessage({ type: "progress", requestId, phase: "runtime", ratio: .05 });
    const files = await FilesetResolver.forVisionTasks(WASM_ROOT, true);
    self.postMessage({ type: "progress", requestId, phase: "model", ratio: .2 });
    const response = await fetch(MODEL_PATH, { cache: "force-cache", credentials: "same-origin" });
    if (!response.ok) throw new Error(`Could not load local model (${response.status}).`);
    const modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
    self.postMessage({ type: "progress", requestId, phase: "initializing", ratio: .65 });
    try {
      if (preferredDelegate() !== "gpu") throw new Error("Software WebGL delegate rejected");
      const engine = await InteractiveSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetBuffer, delegate: "GPU" }, canvas: renderCanvas,
      });
      runtimeTier = "gpu"; return engine;
    } catch {
      const engine = await InteractiveSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetBuffer }, canvas: renderCanvas,
      });
      runtimeTier = "wasm"; return engine;
    }
  })();
  return segmenterPromise;
}

self.addEventListener("message", async ({ data }) => {
  try {
    const engine = await segmenter(data.requestId);
    if (data.type === "set-image") {
      renderCanvas.width = data.bitmap.width; renderCanvas.height = data.bitmap.height;
      engine.setImage(data.bitmap); data.bitmap.close?.(); imageIdentity = data.identity;
      self.postMessage({ type: "image-ready", requestId: data.requestId, identity: imageIdentity,
        runtimeTier });
      return;
    }
    if (data.type !== "segment") return;
    if (!objectSelectionIdentityMatches(imageIdentity, data.identity)) {
      self.postMessage({ type: "error", requestId: data.requestId, code: "STALE_IMAGE",
        message: "The segmentation image no longer matches the document state." });
      return;
    }
    const started = performance.now();
    const mask = engine.segment(data.strokes);
    const confidence = new Float32Array(mask.getAsFloat32Array());
    const width = mask.width; const height = mask.height; mask.close();
    self.postMessage({ type: "mask", requestId: data.requestId, identity: imageIdentity,
      width, height, confidence, latencyMs: performance.now() - started, runtimeTier }, [confidence.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", requestId: data.requestId, code: "INFERENCE_FAILED",
      message: error instanceof Error ? error.message : String(error) });
  }
});

self.postMessage({ type: "worker-ready" });
