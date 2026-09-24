const body = document.body;
const build = new URL(location.href).searchParams.get("build") || "wasm-sdk";
const siteUrl = new URL(`../../build/${encodeURIComponent(build)}/site/`, import.meta.url);
const [{ PatchyWorkerClient }, { PatchyWorkspaceStore }, recovery] = await Promise.all([
  import(new URL("engine/client.mjs", siteUrl)),
  import(new URL("engine/workspace-store.mjs", siteUrl)),
  import(new URL("engine/recovery-controller.mjs", siteUrl)),
]);
const workerUrl = new URL("engine/worker.mjs", siteUrl);
const moduleUrl = new URL("patchy-engine.mjs", siteUrl);
const client = new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
const store = new PatchyWorkspaceStore();
const recoveryId = "retouch-repair-v1";
const check = (value, message) => { if (!value) throw new Error(message); };
const equalBytes = (left, right) => left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);
const renderAll = () => client.render({ x: 0, y: 0, width: 24, height: 16 });

async function reopenInBothFormats(documentId, expected, label) {
  for (const format of ["psd", "psb"]) {
    const bytes = await client.saveDocument(documentId, format);
    check(bytes[4] === 0 && bytes[5] === (format === "psd" ? 1 : 2),
      `${label} ${format.toUpperCase()} header mismatch`);
    await client.open(bytes, `${label}.${format}`, { transferOwnership: true });
    check(equalBytes(await renderAll(), expected),
      `${label} ${format.toUpperCase()} save/reopen lost repaired pixels`);
  }
}

try {
  await client.initialize(moduleUrl.href);
  const spotDocument = await client.create(24, 16, "Spot Healing.psd");
  const spotPixels = new Uint8Array(24 * 16 * 4);
  for (let index = 0; index < 24 * 16; ++index) spotPixels.set([120, 120, 120, 255], index * 4);
  spotPixels.set([245, 20, 30, 255], (8 * 24 + 12) * 4);
  let state = await client.addPixelLayer({ name: "Spot target", width: 24, height: 16,
    bounds: { x: 0, y: 0, width: 24, height: 16 }, rgba: spotPixels },
  { transferOwnership: true });
  const beforeSpot = await renderAll();
  const spotRevision = state.revision;
  state = await client.applyRetouchRepair({ layerId: state.activeLayerId, mode: 0,
    points: [[12, 8]], brushSize: 5, softness: 0, sampleAllLayers: true,
    expectedStateId: state.stateId, expectedRevision: state.revision });
  const healed = await renderAll();
  check(state.revision === spotRevision + 1n && healed[(8 * 24 + 12) * 4] < 180,
    "Spot Healing did not commit one deterministic repaired revision");
  await client.undo();
  check(equalBytes(await renderAll(), beforeSpot), "Spot Healing undo did not restore source pixels");
  await client.redo();
  check(equalBytes(await renderAll(), healed), "Spot Healing redo did not restore repaired pixels");
  await reopenInBothFormats(spotDocument.documentId, healed, "Spot Healing");

  const patchDocument = await client.create(24, 16, "Patch Tool.psb");
  const patchPixels = new Uint8Array(24 * 16 * 4);
  for (let index = 0; index < 24 * 16; ++index) patchPixels.set([120, 120, 120, 255], index * 4);
  patchPixels.set([15, 30, 220, 255], (6 * 24 + 5) * 4);
  state = await client.addPixelLayer({ name: "Patch target", width: 24, height: 16,
    bounds: { x: 0, y: 0, width: 24, height: 16 }, rgba: patchPixels },
  { transferOwnership: true });
  state = await client.setSelection([{ x: 4, y: 4, width: 4, height: 4 }]);
  const beforePatch = await renderAll();
  const patchRevision = state.revision;
  state = await client.applyRetouchRepair({ layerId: state.activeLayerId, mode: 2,
    deltaX: 8, deltaY: 0, transparent: false, sampleAllLayers: true,
    expectedStateId: state.stateId, expectedRevision: state.revision });
  const patched = await renderAll();
  const copied = patched.subarray((6 * 24 + 13) * 4, (6 * 24 + 13) * 4 + 4);
  check(state.revision === patchRevision + 1n && copied[2] > copied[0] &&
    state.selection.length === 1 && state.selection[0].x === 12,
  "Patch Destination did not commit pixels and translated selection atomically");
  await client.undo();
  let travelled = await client.snapshot();
  check(equalBytes(await renderAll(), beforePatch) && travelled.selection[0]?.x === 4,
    "Patch undo did not restore pixels and selection together");
  await client.redo();
  travelled = await client.snapshot();
  check(equalBytes(await renderAll(), patched) && travelled.selection[0]?.x === 12,
    "Patch redo did not restore pixels and selection together");
  await reopenInBothFormats(patchDocument.documentId, patched, "Patch Tool");

  await client.activateDocument(patchDocument.documentId);
  const checkpointState = await client.snapshot();
  const recoveryBytes = await client.save("psb");
  await store.remove(recoveryId).catch(() => {});
  await store.checkpoint({ id: recoveryId, name: "Recovered Patch.psb",
    revision: checkpointState.revision, dirty: true, format: "psb", bytes: recoveryBytes,
    selection: recovery.checkpointSelection(checkpointState) });
  const restored = await store.restore(recoveryId);
  let recovered = await client.open(restored.bytes, restored.manifest.name,
    { transferOwnership: true });
  recovered = await recovery.applyRecoveredSelection(client, restored.selection);
  check(equalBytes(await renderAll(), patched) && recovered.selection[0]?.x === 12,
    "local recovery lost Patch pixels or translated selection");
  await store.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = `PASS spot=${spotRevision + 1n} patch=${patchRevision + 1n}`;
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client.terminate();
}
