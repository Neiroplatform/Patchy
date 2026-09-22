import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";
import { applyRecoveredSelection } from "../../build/wasm-sdk/site/engine/recovery-controller.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const store = new PatchyWorkspaceStore();
const recoveryId = "selection-refinement-v1";
const check = (value, message) => { if (!value) throw new Error(message); };
const selectionPixels = (state) => {
  const gray = new Uint8Array(state.width * state.height);
  if (state.selectionMask) {
    const { bounds, gray: bounded } = state.selectionMask;
    for (let y = 0; y < bounds.height; ++y) {
      gray.set(bounded.subarray(y * bounds.width, (y + 1) * bounds.width),
        (bounds.y + y) * state.width + bounds.x);
    }
  } else {
    for (const rect of state.selection) {
      for (let y = rect.y; y < rect.y + rect.height; ++y) {
        gray.fill(255, y * state.width + rect.x, y * state.width + rect.x + rect.width);
      }
    }
  }
  return gray;
};

try {
  await client.initialize(moduleUrl.href);
  const created = await client.create(48, 40, "Selection refinement.psd");
  const rgba = new Uint8Array(48 * 40 * 4).fill(255);
  const layered = await client.addPixelLayer({ name: "Target", width: 48, height: 40,
    bounds: { x: 0, y: 0, width: 48, height: 40 }, rgba }, { transferOwnership: true });
  const selected = await client.setSelection([{ x: 12, y: 9, width: 20, height: 18 }]);
  const settings = { smooth: 3, feather: 0, contrast: 0, shiftEdge: 0,
    output: "selection", expectedStateId: selected.stateId,
    expectedRevision: selected.revision };
  const preview = await client.previewSelectionRefinement(settings);
  check(preview.gray.length === preview.bounds.width * preview.bounds.height,
    "preview did not return one bounded gray mask");
  const unchanged = await client.snapshot();
  check(unchanged.stateId === selected.stateId && unchanged.revision === selected.revision,
    "preview mutated canonical state");
  let refined = await client.refineSelection(settings);
  check(refined.stateId === selected.stateId && refined.revision === selected.revision + 1n &&
    !refined.selectionMask && refined.selection.length > 0,
  "selection output was not one dirty-neutral revision of preview pixels");
  const hardPixels = selectionPixels(refined);
  const selectionBytes = await client.save("psb");
  await store.remove(recoveryId).catch(() => {});
  await store.checkpoint({ id: recoveryId, name: "Recovered selection.psb",
    revision: refined.revision, dirty: true, format: "psb", bytes: selectionBytes,
    selection: { rects: refined.selection } });
  const selectedRecovery = await store.restore(recoveryId);
  refined = await client.open(selectedRecovery.bytes, "Recovered selection.psb",
    { transferOwnership: true });
  refined = await applyRecoveredSelection(client, selectedRecovery.selection);
  const recoveredHardPixels = selectionPixels(refined);
  check(recoveredHardPixels.every((value, index) => value === hardPixels[index]),
  "local recovery lost refined hard canonical selection geometry");
  await store.remove(recoveryId);

  const maskSettings = { ...settings, feather: 2.5, contrast: 30, shiftEdge: 2,
    output: "layerMask", layerId: layered.activeLayerId,
    expectedStateId: refined.stateId, expectedRevision: refined.revision };
  const maskPreview = await client.previewSelectionRefinement(maskSettings);
  const masked = await client.refineSelection(maskSettings);
  const target = masked.layers.find((layer) => layer.id === layered.activeLayerId);
  check(masked.stateId !== refined.stateId && masked.revision === refined.revision + 1n && target?.mask,
    "layer-mask output was not one canonical document revision");
  const maskPixels = await client.layerMaskPixels(layered.activeLayerId);
  check(maskPixels.length === maskPreview.gray.length &&
    maskPixels.every((value, index) => value === maskPreview.gray[index]),
  "layer-mask output diverged from preview pixels");
  const undone = await client.undo();
  const redone = await client.redo();
  check(!undone.layers.find((layer) => layer.id === layered.activeLayerId)?.mask &&
    redone.layers.find((layer) => layer.id === layered.activeLayerId)?.mask,
  "undo/redo did not restore selection refinement mask state");

  for (const format of ["psd", "psb"]) {
    const saved = await client.save(format);
    const reopened = await client.open(saved, `Selection refinement.${format}`,
      { transferOwnership: true });
    check(reopened.layers.some((layer) => layer.mask),
      `${format.toUpperCase()} reopen lost the refined layer mask`);
  }
  const recoveryBytes = await client.save("psb");
  await store.remove(recoveryId).catch(() => {});
  await store.checkpoint({ id: recoveryId, name: "Recovered refinement.psb",
    revision: masked.revision, dirty: true, format: "psb", bytes: recoveryBytes });
  const recovered = await store.restore(recoveryId);
  const recoveryState = await client.open(recovered.bytes, "Recovered refinement.psb",
    { transferOwnership: true });
  check(recovered.manifest.format === "psb" && recoveryState.layers.some((layer) => layer.mask),
    "local recovery/reopen lost the refined layer mask");
  await store.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = `PASS selection=${refined.revision} mask=${masked.revision}`;
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client.terminate();
}
