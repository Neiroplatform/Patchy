import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));

function check(value, message) {
  if (!value) throw new Error(message);
}

try {
  await client.initialize(moduleUrl.href);
  const first = await client.create(4, 3, "First.psd");
  check(first.documents.length === 1 && first.documentName === "First.psd",
    "first document projection mismatch");

  const rgba = new Uint8Array(4 * 3 * 4);
  for (let pixel = 0; pixel < 12; ++pixel) {
    rgba.set([32 + pixel, 96, 192, 255], pixel * 4);
  }
  const authored = await client.addPixelLayer({ name: "Pixels", width: 4, height: 3,
    bounds: { x: 0, y: 0, width: 4, height: 3 }, rgba });
  const layerId = authored.activeLayerId;
  check(layerId !== 0n && authored.layers.length === 1, "pixel layer was not authored");

  const gray = new Uint8Array([0, 32, 64, 96, 128, 160, 192, 224, 255, 224, 160, 96]);
  const selected = await client.setSelectionMask({ x: 0, y: 0, width: 4, height: 3 }, gray);
  check(selected.selectionMask?.gray.length === gray.length,
    "soft selection did not cross the wasm32 ABI");
  const styled = await client.setLayerStylePreset(
    layerId, "57a1e500-0015-4c6d-8f2a-9b3d4e55c015");
  check(styled.revision > authored.revision, "style preset did not publish a revision");

  const rendered = await client.render({ x: 0, y: 0, width: 4, height: 3 });
  check(rendered.length === rgba.length, "bounded render byte count mismatch");
  const saved = await client.save();
  check(saved.length > 26 && String.fromCharCode(...saved.subarray(0, 4)) === "8BPS",
    "layered PSD encoding mismatch");

  const second = await client.create(2, 2, "Second.psd");
  check(second.documents.length === 2, "second isolated session was not retained");
  const restored = await client.activateDocument(first.documentId);
  check(restored.documentId === first.documentId && restored.layers.length === 1,
    "document switch lost canonical state");
  const reopened = await client.open(saved, "Reopened.psd");
  check(reopened.documents.length === 3 && reopened.width === 4 && reopened.height === 3,
    "saved PSD did not reopen as an isolated document");

  body.dataset.result = "PASS";
  body.textContent = `PASS documents=${reopened.documents.length} revision=${reopened.revision} bytes=${saved.length}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client.terminate();
}
