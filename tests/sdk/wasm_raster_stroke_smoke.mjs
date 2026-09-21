import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const check = (value, message) => { if (!value) throw new Error(message); };
try {
  await client.initialize(moduleUrl.href);
  const created = await client.create(8, 4, "Raster.psd");
  const rgba = new Uint8Array(8 * 4 * 4);
  rgba.set([0, 0, 255, 255], (1 * 8 + 1) * 4);
  const authored = await client.addPixelLayer({ name: "Raster", width: 8, height: 4,
    bounds: { x: 0, y: 0, width: 8, height: 4 }, rgba }, { transferOwnership: true });
  const layerId = authored.activeLayerId;
  const input = { layerId, mode: 0, brushSize: 2, color: [255, 0, 0, 255],
    points: [[2, 1], [6, 1]], source: [0, 0],
    expectedStateId: authored.stateId, expectedRevision: authored.revision };
  const cancelled = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(cancelled, 0, 1);
  let cancelCode = 0;
  try { await client.previewRasterStroke({ ...input, cancellation: cancelled }); }
  catch (error) { cancelCode = error.code; }
  check(cancelCode === 7, "raster preview cancellation did not cross wasm32");
  const preview = await client.previewRasterStroke(input);
  const stable = await client.snapshot();
  check(preview.region.width > 0 && preview.rgba.length > 0 &&
    stable.revision === authored.revision, "raster preview mutated or returned no pixels");
  const painted = await client.applyRasterStroke(input);
  check(painted.revision === authored.revision + 1n, "raster commit was not one revision");
  const undone = await client.undo(); const redone = await client.redo();
  const saved = await client.save(); const reopened = await client.open(saved, "Reopened.psd");
  check(undone.revision < redone.revision && reopened.layers.length === 1,
    "raster undo/redo/save/reopen failed");
  body.dataset.result = "PASS";
  body.textContent = `PASS cancel=${cancelCode} preview=${preview.region.width}x${preview.region.height} bytes=${saved.length}`;
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
