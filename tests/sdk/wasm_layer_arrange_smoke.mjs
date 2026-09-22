import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const store = new PatchyWorkspaceStore();
const recoveryId = "layer-arrange-v1";
const check = (value, message) => { if (!value) throw new Error(message); };
const layer = (state, name) => state.layers.find((item) => item.name === name);

async function addLayer(name, x, color) {
  const rgba = new Uint8Array(2 * 2 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([...color, 255], offset);
  return client.addPixelLayer({ name, width: 2, height: 2,
    bounds: { x, y: 1, width: 2, height: 2 }, rgba }, { transferOwnership: true });
}

try {
  await client.initialize(moduleUrl.href);
  await client.create(24, 10, "Layer arrange.psd");
  await addLayer("First", 1, [220, 40, 40]);
  await addLayer("Middle", 6, [40, 220, 80]);
  let state = await addLayer("Last", 15, [40, 80, 220]);
  const ids = [layer(state, "Last").id, layer(state, "Middle").id,
    layer(state, "First").id];
  const originalPixels = await client.layerPixels(layer(state, "Middle").id);
  const before = state.revision;
  state = await client.arrangeLayers({ layerIds: ids, mode: 6, reference: 0,
    expectedStateId: state.stateId, expectedRevision: state.revision });
  check(state.revision === before + 1n && layer(state, "First").bounds.x === 1 &&
    layer(state, "Middle").bounds.x === 8 && layer(state, "Last").bounds.x === 15,
  "horizontal gap distribution was not one deterministic revision");
  const movedPixels = await client.layerPixels(layer(state, "Middle").id);
  check(originalPixels.length === movedPixels.length &&
    originalPixels.every((value, index) => value === movedPixels[index]),
  "arrangement resampled pixel bytes");

  state = await client.arrangeLayers({ layerIds: ids, mode: 5, reference: 1,
    expectedStateId: state.stateId, expectedRevision: state.revision });
  check(ids.every((id) => state.layers.find((item) => item.id === id).bounds.y === 8),
    "canvas bottom alignment did not move every selected root");
  let staleCode = 0;
  try { await client.arrangeLayers({ layerIds: ids, mode: 0, reference: 0,
    expectedStateId: state.stateId, expectedRevision: state.revision - 1n }); }
  catch (error) { staleCode = error.code; }
  check(staleCode === 6, "stale arrangement did not fail closed");
  const undone = await client.undo();
  const redone = await client.redo();
  check(layer(undone, "First").bounds.y === 1 && layer(redone, "First").bounds.y === 8,
    "arrangement undo/redo was not atomic");

  const psd = await client.save("psd");
  const psb = await client.save("psb");
  await store.remove(recoveryId).catch(() => {});
  await store.checkpoint({ id: recoveryId, name: "Recovered arrange.psb",
    revision: redone.revision, dirty: true, format: "psb", bytes: psb });
  const recovered = await store.restore(recoveryId);
  let reopened = await client.open(psd, "Reopened arrange.psd");
  check(layer(reopened, "Middle").bounds.x === 8 && layer(reopened, "Middle").bounds.y === 8,
    "PSD reopen lost arranged geometry");
  reopened = await client.open(recovered.bytes, "Recovered arrange.psb");
  check(recovered.manifest.format === "psb" && recovered.bytes[5] === 2 &&
    layer(reopened, "Last").bounds.y === 8,
  "PSB recovery/reopen lost arranged geometry");
  await store.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = `PASS revision=${state.revision} layers=${state.layers.length} psd=${psd.length} psb=${psb.length}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
