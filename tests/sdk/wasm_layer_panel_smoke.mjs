import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const store = new PatchyWorkspaceStore();
const check = (value, message) => { if (!value) throw new Error(message); };
const workspaceId = "layer-panel-300-v1";

try {
  if (new URL(location.href).searchParams.has("cleanup")) {
    await store.remove(workspaceId).catch(() => {});
    body.dataset.result = "PASS"; body.textContent = "PASS cleanup=1";
  } else {
    await client.initialize(moduleUrl.href);
    await client.create(16, 16, "Layer panel 300.psd");
    let state;
    for (let index = 0; index < 300; ++index) {
      const rgba = new Uint8Array([index % 256, (index * 3) % 256,
        (index * 7) % 256, 255]);
      state = await client.addPixelLayer({ name: `Layer ${String(index + 1).padStart(3, "0")}`,
        width: 1, height: 1, bounds: { x: index % 16, y: Math.floor(index / 16) % 16,
          width: 1, height: 1 }, rgba }, { transferOwnership: true });
    }
    check(state.layers.length === 300, "300-layer projection was not retained");
    const thumbnail = await client.layerThumbnail(state.activeLayerId, 32,
      state.stateId, state.revision);
    check(thumbnail.width === 1 && thumbnail.height === 1 && thumbnail.rgba.length === 4,
      "thumbnail was not source-aware and bounded");
    const bytes = await client.save();
    await store.remove(workspaceId).catch(() => {});
    await store.checkpoint({ id: workspaceId, name: "Layer panel 300.psd",
      revision: state.revision, dirty: true, bytes });
    body.dataset.result = "PASS";
    body.textContent = `PASS layers=${state.layers.length} thumb=${thumbnail.width}x${thumbnail.height} bytes=${thumbnail.rgba.length}`;
  }
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
