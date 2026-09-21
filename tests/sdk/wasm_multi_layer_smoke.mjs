import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const store = new PatchyWorkspaceStore();
const recoveryId = "multi-layer-authoring-v1";
const check = (value, message) => { if (!value) throw new Error(message); };
const layer = (state, name) => state.layers.find((item) => item.name === name);
const topNames = (state) => [...state.layers].reverse()
  .filter((item) => item.parentId === 0n).map((item) => item.name);

async function addLayer(name, color) {
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([...color, 255], offset);
  return client.addPixelLayer({ name, width: 4, height: 4,
    bounds: { x: 0, y: 0, width: 4, height: 4 }, rgba }, { transferOwnership: true });
}

try {
  await client.initialize(moduleUrl.href);
  await client.create(4, 4, "Multi-layer.psd");
  await addLayer("Bottom", [220, 30, 30]);
  await addLayer("Middle", [30, 220, 30]);
  let state = await addLayer("Top", [30, 30, 220]);
  const ids = Object.fromEntries(["Bottom", "Middle", "Top"]
    .map((name) => [name, layer(state, name)?.id]));
  check(Object.values(ids).every(Boolean), "three authored layers were not projected");

  let before = state.revision;
  state = await client.editLayers([ids.Top, ids.Bottom], 1, { opacity: .42 });
  check(state.revision === before + 1n &&
    Math.abs(layer(state, "Top").opacity - .42) < .001 &&
    Math.abs(layer(state, "Bottom").opacity - .42) < .001,
  "batch opacity was not one exact revision");
  before = state.revision;
  state = await client.editLayers([ids.Middle, ids.Bottom], 4, { value: 7 });
  check(state.revision === before + 1n && layer(state, "Middle").lockFlags === 7 &&
    layer(state, "Bottom").lockFlags === 7, "batch locks were not atomic");
  before = state.revision;
  state = await client.editLayers([ids.Top, ids.Middle], 2, { opacity: .64 });
  check(state.revision === before + 1n &&
    Math.abs(layer(state, "Top").fillOpacity - .64) < .001 &&
    Math.abs(layer(state, "Middle").fillOpacity - .64) < .001,
  "batch fill opacity was not atomic");
  before = state.revision;
  state = await client.editLayers([ids.Top, ids.Middle], 3, { value: 2 });
  check(state.revision === before + 1n && layer(state, "Top").blendMode === 2 &&
    layer(state, "Middle").blendMode === 2, "batch blend mode was not atomic");
  before = state.revision;
  state = await client.editLayers([ids.Top, ids.Middle], 0, { value: 0 });
  check(state.revision === before + 1n && !layer(state, "Top").visible &&
    !layer(state, "Middle").visible, "batch visibility was not atomic");

  before = state.revision;
  state = await client.groupLayers([ids.Top, ids.Middle], "Selected pair");
  const group = layer(state, "Selected pair");
  check(state.revision === before + 1n && group?.kind === 1 &&
    layer(state, "Top")?.parentId === group.id && layer(state, "Middle")?.parentId === group.id,
  "grouping did not preserve both selected children");
  let undone = await client.undo();
  let redone = await client.redo();
  check(!layer(undone, "Selected pair") && layer(redone, "Selected pair")?.id === group.id,
    "group undo/redo did not restore exact topology");

  state = await client.ungroupLayers([group.id]);
  check(!layer(state, "Selected pair") && layer(state, "Top")?.parentId === 0n &&
    layer(state, "Middle")?.parentId === 0n, "ungroup did not release both children");
  before = state.revision;
  state = await client.moveLayers([ids.Top, ids.Middle], ids.Bottom, 2);
  check(state.revision === before + 1n &&
    topNames(state).join(",") === "Bottom,Top,Middle",
  "multi-layer reorder lost relative top-to-bottom order");

  const psd = await client.save("psd");
  const psb = await client.save("psb");
  await store.remove(recoveryId).catch(() => {});
  await store.checkpoint({ id: recoveryId, name: "Recovered multi-layer.psb",
    revision: state.revision, dirty: true, format: "psb", bytes: psb });
  const recovered = await store.restore(recoveryId);
  check(recovered.manifest.format === "psb" && recovered.bytes[5] === 2,
    "recovery lost multi-layer PSB identity");

  let reopened = await client.open(psd, "Reopened multi-layer.psd");
  check(topNames(reopened).join(",") === "Bottom,Top,Middle" &&
    Math.abs(layer(reopened, "Top").opacity - .42) < .001 &&
    Math.abs(layer(reopened, "Top").fillOpacity - .64) < .001 &&
    layer(reopened, "Top").blendMode === 2 && !layer(reopened, "Top").visible &&
    layer(reopened, "Middle").lockFlags === 7,
  "PSD reopen lost batch appearance or order");
  reopened = await client.open(recovered.bytes, "Recovered multi-layer.psb");
  check(topNames(reopened).join(",") === "Bottom,Top,Middle" &&
    Math.abs(layer(reopened, "Bottom").opacity - .42) < .001 &&
    layer(reopened, "Bottom").lockFlags === 7,
  "PSB recovery/reopen lost batch appearance or order");

  before = reopened.revision;
  state = await client.removeLayers([layer(reopened, "Top").id, layer(reopened, "Middle").id]);
  check(state.revision === before + 1n && !layer(state, "Top") && !layer(state, "Middle"),
    "batch delete was not one revision");
  undone = await client.undo(); redone = await client.redo();
  check(Boolean(layer(undone, "Top") && layer(undone, "Middle")) &&
    !layer(redone, "Top") && !layer(redone, "Middle"),
  "batch delete undo/redo did not restore exact layers");

  await store.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = `PASS revision=${state.revision} layers=${state.layers.length} psd=${psd.length} psb=${psb.length}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
