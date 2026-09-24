const body = document.body;
const build = new URL(location.href).searchParams.get("build") || "wasm-sdk";
const siteUrl = new URL(`../../build/${encodeURIComponent(build)}/site/`, import.meta.url);
const [{ PatchyWorkerClient }, { PatchyWorkspaceStore }] = await Promise.all([
  import(new URL("engine/client.mjs", siteUrl)),
  import(new URL("engine/workspace-store.mjs", siteUrl)),
]);
const client = new PatchyWorkerClient(new Worker(new URL("engine/worker.mjs", siteUrl), { type: "module" }));
const store = new PatchyWorkspaceStore();
const check = (value, message) => { if (!value) throw new Error(message); };
const equalBytes = (left, right) => left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);
const renderAll = () => client.render({ x: 0, y: 0, width: 24, height: 16 });
const fixture = () => {
  const rgba = new Uint8Array(24 * 16 * 4);
  for (let y = 0; y < 16; ++y) for (let x = 0; x < 24; ++x) {
    const detail = (x + y) % 3 === 0 ? 28 : 0;
    rgba.set([30 + x * 7 + detail, 40 + y * 9 - detail / 2,
      210 - x * 5 + detail / 3, 255], (y * 24 + x) * 4);
  }
  return rgba;
};

try {
  await client.initialize(new URL("patchy-engine.mjs", siteUrl).href);
  let accepted = null; let acceptedDocumentId = 0;
  for (let mode = 0; mode < 6; ++mode) {
    const created = await client.create(24, 16, `Local brush ${mode}.psd`);
    let state = await client.addPixelLayer({ name: `Mode ${mode}`, width: 24, height: 16,
      bounds: { x: 0, y: 0, width: 24, height: 16 }, rgba: fixture() },
    { transferOwnership: true });
    const before = await renderAll(); const revision = state.revision;
    state = await client.applyLocalAdjustmentBrush({ layerId: state.activeLayerId, mode,
      points: [[5, 8], [12, 8], [18, 10]], brushSize: 7, softness: 35, strength: 60,
      toneRange: 1, protectTones: true, spongeSaturate: true, spongeVibrance: true,
      expectedStateId: state.stateId, expectedRevision: state.revision });
    const after = await renderAll();
    check(state.revision === revision + 1n && !equalBytes(after, before),
      `mode ${mode} did not commit exactly one visible revision`);
    await client.undo(); check(equalBytes(await renderAll(), before), `mode ${mode} undo failed`);
    await client.redo(); check(equalBytes(await renderAll(), after), `mode ${mode} redo failed`);
    if (mode === 5) { accepted = after; acceptedDocumentId = created.documentId; }
  }

  await client.activateDocument(acceptedDocumentId);
  const guarded = await client.snapshot();
  const guardedPixels = await renderAll();
  const guardedInput = { layerId: guarded.activeLayerId, mode: 1,
    points: [[5, 8], [18, 8]], brushSize: 7, softness: 35, strength: 60,
    toneRange: 1, protectTones: true, spongeSaturate: false, spongeVibrance: true };
  let staleRejected = false;
  try {
    await client.applyLocalAdjustmentBrush({ ...guardedInput,
      expectedStateId: guarded.stateId, expectedRevision: guarded.revision - 1n });
  } catch (error) { staleRejected = error?.code === 6; }
  check(staleRejected, "stale local-adjustment brush was not rejected");
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(cancellation, 0, 1);
  let cancellationRejected = false;
  try {
    await client.applyLocalAdjustmentBrush({ ...guardedInput, cancellation,
      expectedStateId: guarded.stateId, expectedRevision: guarded.revision });
  } catch (error) { cancellationRejected = error?.code === 7; }
  check(cancellationRejected, "pre-cancelled local-adjustment brush was not rejected");
  const afterGuards = await client.snapshot();
  check(afterGuards.stateId === guarded.stateId && afterGuards.revision === guarded.revision &&
      equalBytes(await renderAll(), guardedPixels), "failed local-adjustment guards mutated state");

  for (const format of ["psd", "psb"]) {
    const bytes = await client.saveDocument(acceptedDocumentId, format);
    check(bytes[4] === 0 && bytes[5] === (format === "psd" ? 1 : 2),
      `${format.toUpperCase()} header mismatch`);
    await client.open(bytes, `Local brush.${format}`, { transferOwnership: true });
    check(equalBytes(await renderAll(), accepted), `${format.toUpperCase()} save/reopen lost pixels`);
  }

  const recoveryId = "local-adjustment-brush-v1";
  await store.remove(recoveryId).catch(() => {});
  const state = await client.snapshot();
  await store.checkpoint({ id: recoveryId, name: "Recovered local brush.psb",
    revision: state.revision, dirty: true, format: "psb", bytes: await client.save("psb") });
  const restored = await store.restore(recoveryId);
  await client.open(restored.bytes, restored.manifest.name, { transferOwnership: true });
  check(equalBytes(await renderAll(), accepted), "local recovery lost local-brush pixels");
  await store.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = "PASS modes=6 undo=6 redo=6 stale=1 cancel=1 psd=1 psb=1 recovery=1";
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
