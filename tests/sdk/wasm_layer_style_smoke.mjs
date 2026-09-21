import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const check = (value, message) => { if (!value) throw new Error(message); };
const close = (actual, expected) => Math.abs(actual - expected) < 0.001;

try {
  await client.initialize(moduleUrl.href);
  const created = await client.create(32, 24, "Editable effects.psd");
  const rgba = new Uint8Array(32 * 24 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([80, 140, 220, 255], offset);
  const authored = await client.addPixelLayer({ name: "Styled", width: 32, height: 24,
    bounds: { x: 0, y: 0, width: 32, height: 24 }, rgba }, { transferOwnership: true });
  const layerId = authored.activeLayerId;
  const edited = await client.setEssentialLayerStyle(layerId, {
    effectsVisible: true, layerMaskHidesEffects: true,
    dropShadow: { enabled: true, blendMode: 2, color: [12, 34, 56], opacity: .42,
      angle: 33, distance: 9, spread: .18, size: 7, layerConceals: false },
    stroke: { enabled: true, blendMode: 1, color: [220, 120, 40], opacity: .8,
      size: 6, position: 1, overprint: true },
    colorOverlay: { enabled: true, blendMode: 4, color: [90, 30, 150], opacity: .35 },
  });
  check(edited.revision === authored.revision + 1n, "style edit was not one canonical revision");
  const style = edited.layers.find((layer) => layer.id === layerId)?.layerStyle;
  check(style?.layerMaskHidesEffects && style.counts.dropShadow === 1 && style.counts.stroke === 1 &&
    style.counts.colorOverlay === 1, "essential style projection lost effect families");
  check(style.dropShadow.color.join(",") === "12,34,56" && close(style.dropShadow.opacity, .42) &&
    style.dropShadow.layerConceals === false, "Drop Shadow values did not cross wasm32");
  check(style.stroke.position === 1 && style.stroke.overprint && close(style.stroke.size, 6),
    "Stroke values did not cross wasm32");
  check(style.colorOverlay.blendMode === 4 && close(style.colorOverlay.opacity, .35),
    "Color Overlay values did not cross wasm32");
  const undone = await client.undo(); const redone = await client.redo();
  check(undone.layers[0].layerStyle.counts.dropShadow === 0 &&
    redone.layers[0].layerStyle.dropShadow.color[1] === 34,
    "style edit did not survive undo/redo");
  const saved = await client.saveDocument(created.documentId);
  const reopened = await client.open(saved, "Editable effects reopen.psd", { transferOwnership: true });
  const roundTrip = reopened.layers.find((layer) => layer.name === "Styled")?.layerStyle;
  check(roundTrip?.dropShadow.color.join(",") === "12,34,56" &&
    roundTrip.stroke.color.join(",") === "220,120,40" &&
    roundTrip.colorOverlay.color.join(",") === "90,30,150",
    "editable effects did not survive layered PSD save/reopen");
  body.dataset.result = "PASS";
  body.textContent = `PASS revision=${edited.revision} effects=3 reopen=${reopened.revision}`;
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client.terminate();
}
