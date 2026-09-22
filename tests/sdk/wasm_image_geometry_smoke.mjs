import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const store = new PatchyWorkspaceStore();
const recoveryId = "image-geometry-v1";
const check = (value, message) => { if (!value) throw new Error(message); };
const layer = (state) => state.layers.find((item) => item.name === "Geometry pixels");

try {
  await client.initialize(moduleUrl.href);
  let state = await client.create(8, 6, "Image geometry.psd");
  const rgba = new Uint8Array(2 * 2 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([220, 40, 80, 255], offset);
  state = await client.addPixelLayer({ name: "Geometry pixels", width: 2, height: 2,
    bounds: { x: 1, y: 1, width: 2, height: 2 }, rgba }, { transferOwnership: true });
  state = await client.setSelection([{ x: 1, y: 1, width: 2, height: 2 }]);

  let before = state.revision;
  state = await client.resizeImage(16, 12);
  check(state.revision === before + 1n && state.width === 16 && state.height === 12 &&
    layer(state).bounds.x === 2 && layer(state).bounds.y === 2 &&
    layer(state).bounds.width === 4 && layer(state).bounds.height === 4 &&
    state.selection.length === 0, "image resize did not atomically scale geometry and reset selection");

  before = state.revision;
  state = await client.resizeCanvas(20, 16,
    { anchor: 8, color: [12, 34, 56, 255] });
  check(state.revision === before + 1n && state.width === 20 && state.height === 16 &&
    layer(state).bounds.x === 0 && layer(state).bounds.y === 0,
  `bottom-right canvas resize did not publish once: ${JSON.stringify(layer(state).bounds)}`);

  before = state.revision;
  state = await client.rotateCanvas(90, [1, 2, 3, 255]);
  check(state.revision === before + 1n && state.width === 16 && state.height === 20,
    "quarter-turn rotation did not swap canvas dimensions in one revision");

  before = state.revision;
  state = await client.cropDocument({ x: -2, y: -1, width: 20, height: 23 },
    { clockwiseDegrees: 0, color: [7, 8, 9, 255], clipToCanvas: false });
  check(state.revision === before + 1n && state.width === 20 && state.height === 23,
    "expanding crop did not retain requested document-space bounds");

  before = state.revision;
  state = await client.rotateCanvas(12.5, [0, 0, 0, 0]);
  check(state.revision === before + 1n && state.width > 20 && state.height > 23,
    "arbitrary rotation did not expand the reference canvas");
  const rotatedWidth = state.width; const rotatedHeight = state.height;
  const undone = await client.undo(); const redone = await client.redo();
  check(undone.width === 20 && undone.height === 23 &&
    redone.width === rotatedWidth && redone.height === rotatedHeight,
  "geometry undo/redo was not atomic");

  const psd = await client.save("psd"); const psb = await client.save("psb");
  await store.remove(recoveryId).catch(() => {});
  await store.checkpoint({ id: recoveryId, name: "Recovered geometry.psb",
    revision: redone.revision, dirty: true, format: "psb", bytes: psb });
  const recovered = await store.restore(recoveryId);
  let reopened = await client.open(psd, "Reopened geometry.psd");
  check(reopened.width === rotatedWidth && reopened.height === rotatedHeight && layer(reopened),
    "PSD reopen lost final image geometry");
  reopened = await client.open(recovered.bytes, "Recovered geometry.psb");
  check(recovered.manifest.format === "psb" && recovered.bytes[5] === 2 &&
    reopened.width === rotatedWidth && reopened.height === rotatedHeight && layer(reopened),
  "PSB recovery/reopen lost final image geometry");
  await store.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = `PASS revision=${state.revision} canvas=${rotatedWidth}x${rotatedHeight} psd=${psd.length} psb=${psb.length}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
