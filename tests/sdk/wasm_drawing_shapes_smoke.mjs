import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const check = (value, message) => { if (!value) throw new Error(message); };

try {
  await client.initialize(moduleUrl.href);
  await client.create(8, 4, "Drawing.psd");
  const authored = await client.addPixelLayer({ name: "Canvas", width: 8, height: 4,
    bounds: { x: 0, y: 0, width: 8, height: 4 }, rgba: new Uint8Array(8 * 4 * 4) },
  { transferOwnership: true });
  const layerId = authored.activeLayerId;
  const fill = { layerId, mode: 2, color: [230, 40, 90, 255], start: [0, 0], end: [7, 0],
    expectedStateId: authored.stateId, expectedRevision: authored.revision };
  const cancelled = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(cancelled, 0, 1);
  let cancelCode = 0;
  try { await client.previewRasterFill({ ...fill, cancellation: cancelled }); }
  catch (error) { cancelCode = error.code; }
  check(cancelCode === 7, "fill preview cancellation did not cross wasm32");
  const preview = await client.previewRasterFill(fill);
  const stable = await client.snapshot();
  check(preview.region.width === 8 && preview.region.height === 4 && preview.rgba.length === 128 &&
    stable.revision === authored.revision, "fill preview mutated state or returned wrong pixels");
  const filled = await client.applyRasterFill(fill);
  check(filled.revision === authored.revision + 1n, "fill was not one canonical revision");

  const path = { subpaths: [{ anchors: [
    { x: 1, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 3 }, { x: 1, y: 3 },
  ], shapeGroup: 0, combine: 1, closed: true }] };
  const withPath = await client.addDocumentPath({ name: "Pen path", kind: 0, path });
  check(withPath.paths.length === 1 && withPath.paths[0].anchorCount === 4,
    "Pen path did not cross wasm32");
  const withMask = await client.setVectorMask(layerId, { path, density: 255, feather: 0 });
  const shapeInput = { name: "Rectangle", path, fill: [25, 120, 210],
    strokeEnabled: true, stroke: [10, 20, 30], strokeWidth: 1 };
  const shaped = await client.addVectorShape(shapeInput);
  const shapeId = shaped.activeLayerId;
  check(shaped.layers.some((layer) => layer.id === shapeId && layer.kind === 4),
    "vector shape was not projected");
  const updated = await client.updateVectorShape(shapeId, { ...shapeInput,
    name: "Edited rectangle", fill: [60, 180, 120] });
  check(updated.revision === shaped.revision + 1n &&
    updated.layers.find((layer) => layer.id === shapeId)?.kind === 4,
  "shape edit was not one canonical revision");
  const undone = await client.undo(); const redone = await client.redo();
  check(undone.revision < redone.revision && redone.revision > withMask.revision,
    "shape undo/redo failed");
  const saved = await client.save();
  const reopened = await client.open(saved, "Reopened drawing.psd");
  check(reopened.paths.length === 1 && reopened.layers.some((layer) => layer.kind === 4) &&
    reopened.layers.some((layer) => layer.kind === 0),
  "drawing/path/shape state did not survive PSD reopen");
  body.dataset.result = "PASS";
  body.textContent = `PASS cancel=${cancelCode} preview=${preview.region.width}x${preview.region.height} paths=${reopened.paths.length} layers=${reopened.layers.length}`;
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
