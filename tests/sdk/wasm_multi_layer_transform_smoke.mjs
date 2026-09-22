import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const store = new PatchyWorkspaceStore();
const recoveryId = "multi-layer-transform-v1";
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
  await client.create(20, 10, "Multi-layer transform.psd");
  await addLayer("First", 1, [220, 40, 40]);
  let state = await addLayer("Second", 5, [40, 80, 220]);
  const firstId = layer(state, "First")?.id;
  const secondId = layer(state, "Second")?.id;
  check(firstId && secondId, "transform fixture layers were not projected");

  const quad = [2, 2, 14, 2, 14, 6, 2, 6];
  const request = { layerIds: [secondId, firstId], quad,
    expectedStateId: state.stateId, expectedRevision: state.revision };
  const cancelled = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(cancelled, 0, 1);
  let cancelCode = 0;
  try { await client.previewLayersTransform({ ...request, cancellation: cancelled }); }
  catch (error) { cancelCode = error.code; }
  check(cancelCode === 7, "multi-layer preview cancellation did not cross wasm32");
  const preview = await client.previewLayersTransform(request);
  check(preview.region.x === 1 && preview.region.y === 1 &&
    preview.region.width === 13 && preview.region.height === 5 &&
    preview.rgba.length === 13 * 5 * 4,
  "multi-layer preview returned inconsistent union pixels");
  check((await client.snapshot()).revision === state.revision,
    "multi-layer preview mutated canonical state");

  const before = state.revision;
  state = await client.transformLayers(request);
  check(state.revision === before + 1n &&
    layer(state, "First").bounds.x === 2 && layer(state, "First").bounds.width === 4 &&
    layer(state, "Second").bounds.x === 10 && layer(state, "Second").bounds.width === 4,
  "collective transform lost relative placement or published more than one revision");
  const undone = await client.undo();
  const redone = await client.redo();
  check(layer(undone, "First").bounds.x === 1 && layer(undone, "Second").bounds.x === 5 &&
    layer(redone, "First").bounds.x === 2 && layer(redone, "Second").bounds.x === 10,
  "collective transform undo/redo was not atomic");

  const psd = await client.save("psd");
  const psb = await client.save("psb");
  await store.remove(recoveryId).catch(() => {});
  await store.checkpoint({ id: recoveryId, name: "Recovered transform.psb",
    revision: redone.revision, dirty: true, format: "psb", bytes: psb });
  const recovered = await store.restore(recoveryId);
  let reopened = await client.open(psd, "Reopened transform.psd");
  check(layer(reopened, "First").bounds.x === 2 && layer(reopened, "Second").bounds.x === 10,
    "PSD reopen lost collective transform geometry");
  reopened = await client.open(recovered.bytes, "Recovered transform.psb");
  check(recovered.manifest.format === "psb" && recovered.bytes[5] === 2 &&
    layer(reopened, "First").bounds.width === 4 && layer(reopened, "Second").bounds.width === 4,
  "PSB recovery/reopen lost collective transform geometry");
  await store.remove(recoveryId);

  body.dataset.result = "PASS";
  body.textContent = `PASS revision=${state.revision} layers=${state.layers.length} psd=${psd.length} psb=${psb.length}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
