import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const check = (value, message) => { if (!value) throw new Error(message); };

try {
  await client.initialize(moduleUrl.href);
  const created = await client.create(64, 64, "Advanced selection.psd");
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; ++y) for (let x = 0; x < 64; ++x) {
    const offset = (y * 64 + x) * 4; const value = x < 32 ? 24 : 224;
    rgba.set([value, value, value, 255], offset);
  }
  const authored = await client.addPixelLayer({ name: "Edge", width: 64, height: 64,
    bounds: { x: 0, y: 0, width: 64, height: 64 }, rgba }, { transferOwnership: true });
  const quick = await client.quickSelect({ points: [[48, 28], [48, 36]], brushRadius: 5,
    spread: 50, enhanceEdge: true, expectedStateId: authored.stateId,
    expectedRevision: authored.revision });
  check(quick.selection.length > 0 && quick.revision === authored.revision + 1n,
    "Quick Select was not one canonical revision");
  const magnetic = await client.magneticLasso({ anchors: [[30, 8], [34, 8], [34, 56], [30, 56]],
    width: 12, edgeContrast: 10, nodeBudget: 600000, combine: 0,
    expectedStateId: quick.stateId, expectedRevision: quick.revision });
  check(magnetic.selection.length > 0 && magnetic.revision === quick.revision + 1n,
    "Magnetic Lasso was not one canonical revision");
  const mask = new Uint8Array(64 * 64);
  mask.fill(255); mask.fill(0, 20 * 64 + 20, 20 * 64 + 44); mask[20 * 64 + 20] = 128;
  const quickMask = await client.setSelectionMask({ x: 0, y: 0, width: 64, height: 64 }, mask,
    { transferOwnership: true });
  check(quickMask.selectionMask?.gray.length === 4096,
    "Quick Mask coverage did not cross the canonical boundary");
  const undone = await client.undo(); const redone = await client.redo();
  check(undone.revision > quickMask.revision && redone.selectionMask?.gray.length === 4096,
    "advanced selection undo/redo lost coverage");
  const saved = await client.saveDocument(created.documentId);
  const reopened = await client.open(saved, "Advanced selection reopen.psd", { transferOwnership: true });
  check(reopened.width === 64 && reopened.height === 64 && reopened.layers.length === 1,
    "advanced selection document did not survive PSD save/reopen");
  body.dataset.result = "PASS";
  body.textContent = `PASS quick=${quick.revision} magnetic=${magnetic.revision} mask=${quickMask.revision}`;
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client.terminate();
}
