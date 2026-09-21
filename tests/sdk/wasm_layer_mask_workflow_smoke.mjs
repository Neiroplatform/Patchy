import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const workspaceStore = new PatchyWorkspaceStore();
const recoveryId = "wasm-layer-mask-psb-v1";

function check(value, message) {
  if (!value) throw new Error(message);
}

try {
  await client.initialize(moduleUrl.href);
  const created = await client.create(8, 4, "Mask workflow.psb");
  const rgba = new Uint8Array(8 * 4 * 4);
  for (let index = 0; index < 8 * 4; ++index) rgba.set([220, 40, 30, 255], index * 4);
  let snapshot = await client.addPixelLayer({ name: "Masked pixels", width: 8, height: 4,
    bounds: { x: 0, y: 0, width: 8, height: 4 }, rgba });
  const layerId = snapshot.layers[0].id;
  snapshot = await client.createLayerMask(layerId);
  snapshot = await client.setLayerMaskLinked(layerId, false);
  snapshot = await client.setSelection([{ x: 0, y: 0, width: 4, height: 4 }]);
  const request = { layerId, mode: 0, brushSize: 1, color: [0, 0, 0, 255],
    points: [[1, 1], [6, 1]], source: [0, 0], expectedStateId: snapshot.stateId,
    expectedRevision: snapshot.revision };
  const preview = await client.previewLayerMaskStroke(request);
  check(preview.region.width > 0 && preview.rgba.byteLength ===
    preview.region.width * preview.region.height * 4, "mask preview was incomplete");
  check((await client.snapshot()).revision === snapshot.revision,
    "mask preview mutated canonical state");
  snapshot = await client.applyLayerMaskStroke(request);
  check(snapshot.revision === request.expectedRevision + 1n &&
    snapshot.layers[0].mask.linked === false, "mask commit/link state mismatch");
  let gray = await client.layerMaskPixels(layerId);
  check(gray[1 + 8] === 0 && gray[6 + 8] === 255,
    "selection-bounded mask stroke mismatch");

  const erase = { ...request, mode: 1, points: [[1, 1]],
    expectedStateId: snapshot.stateId, expectedRevision: snapshot.revision };
  snapshot = await client.applyLayerMaskStroke(erase);
  gray = await client.layerMaskPixels(layerId);
  check(gray[1 + 8] === 255, "mask eraser did not reveal");
  snapshot = await client.undo();
  check((await client.layerMaskPixels(layerId))[1 + 8] === 0,
    "mask undo did not restore paint");
  snapshot = await client.redo();
  check((await client.layerMaskPixels(layerId))[1 + 8] === 255,
    "mask redo did not restore erase");
  snapshot = await client.undo();

  const psb = await client.save("psb");
  check(psb[5] === 2, "mask workflow PSB header mismatch");
  const reopened = await client.open(psb, "Mask workflow.psb");
  const reopenedLayer = reopened.layers.find((layer) => layer.name === "Masked pixels");
  check(reopenedLayer?.mask?.linked === false, "PSB reopen lost unlinked mask");
  check((await client.layerMaskPixels(reopenedLayer.id))[1 + 8] === 0,
    "PSB reopen lost edited mask pixels");

  try { await workspaceStore.remove(recoveryId); } catch { /* Clean first run. */ }
  await workspaceStore.checkpoint({ id: recoveryId, name: "Recovered.psd",
    revision: snapshot.revision, dirty: true, format: "psb", bytes: psb });
  const recovered = await workspaceStore.restore(recoveryId);
  check(recovered.manifest.format === "psb" && recovered.bytes[5] === 2,
    "local recovery lost PSB mask document identity");
  await workspaceStore.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = `PASS preview=${preview.rgba.byteLength} revision=${snapshot.revision} mask=${gray.length} psb=${psb.length}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client.terminate();
}
