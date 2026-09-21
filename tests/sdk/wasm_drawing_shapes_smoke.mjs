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

  const warp = { layerId, style: 0, bend: 55, horizontalDistortion: 8,
    verticalDistortion: -4, rotateVertical: false, interpolation: 1,
    expectedStateId: filled.stateId, expectedRevision: filled.revision };
  const cancelledWarp = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(cancelledWarp, 0, 1); let warpCancelCode = 0;
  try { await client.previewLayerWarp({ ...warp, cancellation: cancelledWarp }); }
  catch (error) { warpCancelCode = error.code; }
  check(warpCancelCode === 7, "warp preview cancellation did not cross wasm32");
  const warpPreview = await client.previewLayerWarp(warp);
  check(warpPreview.rgba.length === warpPreview.region.width * warpPreview.region.height * 4,
    "warp preview returned inconsistent pixels");
  const warped = await client.warpLayer(warp);
  check(warped.revision === filled.revision + 1n,
    "warp was not one canonical revision");

  const smartSource = await client.save();
  const placed = await client.placePsdSmartObject(
    new Blob([smartSource], { type: "application/octet-stream" }), "Warp source.psd");
  const smartId = placed.activeLayerId;
  check(placed.layers.find((layer) => layer.id === smartId)?.kind === 5,
    "Smart Object placement did not cross the Worker boundary");
  const smartWarped = await client.warpLayer({ ...warp, layerId: smartId, style: 3,
    bend: 35, horizontalDistortion: 0, verticalDistortion: 0,
    expectedStateId: placed.stateId, expectedRevision: placed.revision });
  check(smartWarped.revision === placed.revision + 1n &&
    smartWarped.layers.find((layer) => layer.id === smartId)?.kind === 5,
  "editable Smart Object warp was not one canonical revision");

  const smartBounds = smartWarped.layers.find((layer) => layer.id === smartId).bounds;
  const smartQuad = [smartBounds.x, smartBounds.y,
    smartBounds.x + smartBounds.width + 1, smartBounds.y + 1,
    smartBounds.x + smartBounds.width, smartBounds.y + smartBounds.height + 1,
    smartBounds.x - 1, smartBounds.y + smartBounds.height];
  const smartTransform = { layerId: smartId, quad: smartQuad,
    expectedStateId: smartWarped.stateId, expectedRevision: smartWarped.revision };
  const smartTransformPreview = await client.previewLayerTransform(smartTransform);
  const afterSmartPreview = await client.snapshot();
  check(smartTransformPreview.rgba.length ===
    smartTransformPreview.region.width * smartTransformPreview.region.height * 4 &&
    afterSmartPreview.revision === smartWarped.revision,
  "Smart Object transform preview mutated state or returned inconsistent pixels");
  const smartTransformed = await client.transformLayer(smartTransform);
  check(smartTransformed.revision === smartWarped.revision + 1n &&
    smartTransformed.layers.find((layer) => layer.id === smartId)?.kind === 5,
  "editable Smart Object perspective transform was not one canonical revision");

  const textRgba = new Uint8Array(4 * 2 * 4);
  for (let offset = 0; offset < textRgba.length; offset += 4) {
    textRgba.set([30, 40, 210, 255], offset);
  }
  const textAuthored = await client.addTextLayer({ name: "Warp text", text: "Warp",
    font: "Arial", sizePixels: 12, color: [30, 40, 210], bold: false,
    italic: false, boxText: true, width: 4, height: 2,
    bounds: { x: 1, y: 1, width: 4, height: 2 }, rgba: textRgba },
  { transferOwnership: true });
  const textId = textAuthored.activeLayerId;
  check(textRgba.byteLength === 0 &&
    textAuthored.layers.find((layer) => layer.id === textId)?.kind === 3,
  "editable text authoring did not cross the Worker boundary");
  const textWarp = { ...warp, layerId: textId, style: 0, bend: 42,
    horizontalDistortion: 9, verticalDistortion: -6, rotateVertical: true,
    expectedStateId: textAuthored.stateId, expectedRevision: textAuthored.revision };
  const textWarpPreview = await client.previewLayerWarp(textWarp);
  check((await client.snapshot()).revision === textAuthored.revision &&
    textWarpPreview.rgba.length ===
      textWarpPreview.region.width * textWarpPreview.region.height * 4,
  "editable text warp preview mutated state or returned inconsistent pixels");
  const textWarped = await client.warpLayer(textWarp);
  check(textWarped.revision === textAuthored.revision + 1n &&
    textWarped.layers.find((layer) => layer.id === textId)?.kind === 3,
  "editable text warp was not one canonical revision");

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
    reopened.layers.some((layer) => layer.kind === 0) &&
    reopened.layers.some((layer) => layer.kind === 5) &&
    reopened.layers.some((layer) => layer.kind === 3),
  "drawing/path/shape/editable transform state did not survive PSD reopen");
  body.dataset.result = "PASS";
  body.textContent = `PASS fillCancel=${cancelCode} warpCancel=${warpCancelCode} warp=${warpPreview.region.width}x${warpPreview.region.height} smartTransform=1 textWarp=1 paths=${reopened.paths.length} layers=${reopened.layers.length}`;
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
