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
const renderAll = () => client.render({ x: 0, y: 0, width: 32, height: 24 });

try {
  await client.initialize(new URL("patchy-engine.mjs", siteUrl).href);
  await client.create(32, 24, "Advanced paint.psd");
  const background = new Uint8Array(32 * 24 * 4);
  for (let y = 0; y < 24; ++y) for (let x = 0; x < 32; ++x) {
    background.set([20 + x * 5, 35 + y * 7, 210 - x * 4, 255], (y * 32 + x) * 4);
  }
  await client.addPixelLayer({ name: "Background", width: 32, height: 24,
    bounds: { x: 0, y: 0, width: 32, height: 24 }, rgba: background },
  { transferOwnership: true });
  let state = await client.addPixelLayer({ name: "Paint", width: 32, height: 24,
    bounds: { x: 0, y: 0, width: 32, height: 24 }, rgba: new Uint8Array(32 * 24 * 4) },
  { transferOwnership: true });
  const before = await renderAll();
  const mixerRevision = state.revision;
  state = await client.applyAdvancedPaintStroke({ layerId: state.activeLayerId, mode: 0,
    points: [[6, 12], [16, 12], [25, 14]], brushSize: 7, softness: 45, flow: 85,
    color: [240, 45, 25, 255], wet: 70, load: 65, mix: 60, sampleAllLayers: true,
    expectedStateId: state.stateId, expectedRevision: state.revision });
  const mixed = await renderAll();
  check(state.revision === mixerRevision + 1n && !equalBytes(mixed, before),
    "Mixer Brush did not commit one visible revision");
  await client.undo(); check(equalBytes(await renderAll(), before), "Mixer Brush undo failed");
  await client.redo(); check(equalBytes(await renderAll(), mixed), "Mixer Brush redo failed");

  state = await client.snapshot(); const patternRevision = state.revision;
  state = await client.applyAdvancedPaintStroke({ layerId: state.activeLayerId, mode: 1,
    points: [[8, 5], [24, 18]], brushSize: 9, softness: 20, flow: 75,
    color: [250, 220, 35, 255], secondaryColor: [35, 20, 120, 255],
    pattern: 0, patternSize: 3, patternAnchor: [0, 0], patternAligned: true,
    expectedStateId: state.stateId, expectedRevision: state.revision });
  const patterned = await renderAll();
  check(state.revision === patternRevision + 1n && !equalBytes(patterned, mixed),
    "Pattern Stamp did not commit one visible revision");

  const guarded = await client.snapshot();
  const guardedInput = { layerId: guarded.activeLayerId, mode: 1, points: [[4, 4], [20, 4]],
    brushSize: 5, softness: 0, flow: 100, color: [255, 0, 0, 255],
    secondaryColor: [0, 0, 0, 255], pattern: 1, patternSize: 4 };
  let staleRejected = false;
  try {
    await client.applyAdvancedPaintStroke({ ...guardedInput,
      expectedStateId: guarded.stateId, expectedRevision: guarded.revision - 1n });
  } catch (error) { staleRejected = error?.code === 6; }
  check(staleRejected, "stale advanced-paint stroke was not rejected");
  const cancellation = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(cancellation, 0, 1);
  let cancellationRejected = false;
  try {
    await client.applyAdvancedPaintStroke({ ...guardedInput, cancellation,
      expectedStateId: guarded.stateId, expectedRevision: guarded.revision });
  } catch (error) { cancellationRejected = error?.code === 7; }
  check(cancellationRejected, "pre-cancelled advanced-paint stroke was not rejected");
  const afterGuards = await client.snapshot();
  check(afterGuards.stateId === guarded.stateId && afterGuards.revision === guarded.revision &&
    equalBytes(await renderAll(), patterned), "advanced-paint guards mutated state");

  for (const format of ["psd", "psb"]) {
    const bytes = await client.save(format);
    await client.open(bytes, `Advanced paint.${format}`, { transferOwnership: true });
    check(equalBytes(await renderAll(), patterned), `${format.toUpperCase()} save/reopen lost pixels`);
  }
  const recoveryId = "advanced-paint-v1";
  await store.remove(recoveryId).catch(() => {});
  state = await client.snapshot();
  await store.checkpoint({ id: recoveryId, name: "Recovered advanced paint.psb",
    revision: state.revision, dirty: true, format: "psb", bytes: await client.save("psb") });
  const restored = await store.restore(recoveryId);
  await client.open(restored.bytes, restored.manifest.name, { transferOwnership: true });
  check(equalBytes(await renderAll(), patterned), "local recovery lost advanced-paint pixels");
  await store.remove(recoveryId);
  body.dataset.result = "PASS";
  body.textContent = "PASS mixer=1 pattern=1 undo=1 redo=1 stale=1 cancel=1 psd=1 psb=1 recovery=1";
} catch (error) {
  body.dataset.result = "FAIL"; body.textContent = `FAIL ${error?.stack || error}`;
} finally { client.terminate(); }
