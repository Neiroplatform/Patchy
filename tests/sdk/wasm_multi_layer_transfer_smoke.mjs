import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const store = new PatchyWorkspaceStore();
const recoveryId = "multi-layer-transfer-v1";
const check = (value, message) => { if (!value) throw new Error(message); };
const layer = (state, name) => state.layers.find((item) => item.name === name);
const topNames = (state) => [...state.layers].reverse()
  .filter((item) => item.parentId === 0n).map((item) => item.name);

async function addLayer(name, color) {
  const rgba = new Uint8Array(6 * 6 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([...color, 255], offset);
  return client.addPixelLayer({ name, width: 6, height: 6,
    bounds: { x: 0, y: 0, width: 6, height: 6 }, rgba }, { transferOwnership: true });
}

try {
  await client.initialize(moduleUrl.href);
  await store.remove(recoveryId).catch(() => {});
  const source = await client.create(6, 6, "Transfer source.psd");
  await addLayer("Bottom", [220, 30, 30]);
  await addLayer("Child A", [30, 220, 30]);
  await addLayer("Child B", [30, 30, 220]);
  let sourceState = await addLayer("Top", [240, 180, 20]);
  const sourceIds = Object.fromEntries(["Bottom", "Child A", "Child B", "Top"]
    .map((name) => [name, layer(sourceState, name)?.id]));
  check(Object.values(sourceIds).every(Boolean), "source layers were not projected");
  sourceState = await client.setLayerOpacity(sourceIds.Top, 0.42);
  sourceState = await client.setLayerFillOpacity(sourceIds.Top, 0.64);
  sourceState = await client.setLayerBlendMode(sourceIds.Top, 2);
  sourceState = await client.createLayerMask(sourceIds["Child A"]);
  sourceState = await client.setLayerMaskLinked(sourceIds["Child A"], false);
  sourceState = await client.groupLayers(
    [sourceIds["Child B"], sourceIds["Child A"]], "Transfer group");
  const group = layer(sourceState, "Transfer group");
  check(group?.kind === 1 && layer(sourceState, "Child A")?.parentId === group.id &&
    layer(sourceState, "Child B")?.parentId === group.id,
  "source group tree was not authored");
  const exactSource = { stateId: sourceState.stateId, revision: sourceState.revision };

  const target = await client.create(6, 6, "Transfer target.psb");
  const transferred = await client.copyLayersToDocument({
    sourceDocumentId: source.documentId,
    targetDocumentId: target.documentId,
    layerIds: [sourceIds.Top, group.id, sourceIds.Bottom],
    expectedSourceStateId: exactSource.stateId,
    expectedSourceRevision: exactSource.revision,
    expectedTargetStateId: target.stateId,
    expectedTargetRevision: target.revision,
  });
  check(transferred.revision === target.revision + 1n,
    "selected forest did not commit one target revision");
  check(topNames(transferred).join(",") === "Top,Transfer group,Bottom",
    "selected forest lost its top-to-bottom order");
  const copiedGroup = layer(transferred, "Transfer group");
  const copiedChildA = layer(transferred, "Child A");
  const copiedChildB = layer(transferred, "Child B");
  const copiedTop = layer(transferred, "Top");
  const copiedIds = transferred.layers.map((item) => item.id);
  check(new Set(copiedIds).size === copiedIds.length && copiedIds.every((id) => id !== 0n),
    "transferred forest did not receive unique target identities");
  check(copiedChildA?.parentId === copiedGroup?.id && copiedChildB?.parentId === copiedGroup?.id,
    "transferred forest lost editable group topology");
  check(copiedChildA?.mask && !copiedChildA.mask.linked &&
    Math.abs(copiedTop?.opacity - 0.42) < 0.001 &&
    Math.abs(copiedTop?.fillOpacity - 0.64) < 0.001 && copiedTop?.blendMode === 2,
  "transferred forest lost mask or modeled appearance");

  const sourceAfter = await client.activateDocument(source.documentId);
  check(sourceAfter.stateId === exactSource.stateId && sourceAfter.revision === exactSource.revision &&
    topNames(sourceAfter).join(",") === "Top,Transfer group,Bottom",
  "cross-document transfer mutated the source session");
  await client.activateDocument(target.documentId);
  const undone = await client.undo();
  check(undone.layers.length === 0, "transfer undo left part of the forest behind");
  const redone = await client.redo();
  check(redone.layers.length === 5 && topNames(redone).join(",") === "Top,Transfer group,Bottom",
    "transfer redo did not restore the complete forest");

  const psd = await client.saveDocument(target.documentId, "psd");
  const psb = await client.saveDocument(target.documentId, "psb");
  await store.checkpoint({ id: recoveryId, name: "Recovered transfer.psb",
    revision: redone.revision, dirty: true, format: "psb", bytes: psb });
  const recovered = await store.restore(recoveryId);
  check(recovered.manifest.format === "psb" && recovered.bytes[5] === 2,
    "recovery checkpoint lost transferred PSB identity");
  let reopened = await client.open(psd, "Reopened transfer.psd");
  check(reopened.layers.length === 5 && topNames(reopened).join(",") === "Top,Transfer group,Bottom" &&
    layer(reopened, "Child A")?.parentId === layer(reopened, "Transfer group")?.id &&
    layer(reopened, "Child A")?.mask && !layer(reopened, "Child A").mask.linked,
  "PSD reopen lost the transferred forest");
  reopened = await client.open(recovered.bytes, "Recovered transfer.psb");
  check(reopened.layers.length === 5 && topNames(reopened).join(",") === "Top,Transfer group,Bottom" &&
    Math.abs(layer(reopened, "Top")?.opacity - 0.42) < 0.001,
  "PSB recovery/reopen lost transferred order or appearance");

  await store.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = `PASS revision=${redone.revision} layers=${redone.layers.length} psd=${psd.length} psb=${psb.length}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
