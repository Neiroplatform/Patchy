import { PatchyWorkerClient } from "../../build/wasm-sdk/site/engine/client.mjs";
import { recoverWorkerSession } from "../../build/wasm-sdk/site/engine/recovery-controller.mjs";
import { PatchyWorkspaceStore } from "../../build/wasm-sdk/site/engine/workspace-store.mjs";

const body = document.body;
const workerUrl = new URL("../../build/wasm-sdk/site/engine/worker.mjs", import.meta.url);
const moduleUrl = new URL("../../build/wasm-sdk/site/patchy-engine.mjs", import.meta.url);
const workspaceStore = new PatchyWorkspaceStore();
const phaseKey = "patchy-wasm-runtime-recovery-phase";
const workspaceOne = "wasm-runtime-first-v1";
const workspaceTwo = "wasm-runtime-second-v1";
let client = null;
let createdClients = 0;
let recoveryPhase = null;
try { recoveryPhase = JSON.parse(sessionStorage.getItem(phaseKey) || "null"); }
catch { sessionStorage.removeItem(phaseKey); }

function createClient() {
  createdClients++;
  return new PatchyWorkerClient(new Worker(workerUrl, { type: "module" }));
}

function check(value, message) {
  if (!value) throw new Error(message);
}

try {
  check(await workspaceStore.available(), "origin-private workspace storage is unavailable");
  client = createClient();
  await client.initialize(moduleUrl.href);
  if (recoveryPhase?.mode === "restore") {
    const listed = await workspaceStore.list();
    check(listed.some(({ id }) => id === workspaceOne) && listed.some(({ id }) => id === workspaceTwo),
      "reload did not retain both isolated workspaces");
    client.terminate();
    const recovered = await recoverWorkerSession({ createClient, moduleUrl: moduleUrl.href,
      workspaceStore, documents: [
        { documentId: 11, workspaceId: workspaceOne, active: true },
        { documentId: 12, workspaceId: workspaceTwo, active: false },
      ] });
    client = recovered.client;
    check(createdClients === 2, "crash recovery did not create exactly one replacement Worker");
    check(recovered.restored.length === 2 && recovered.failed.length === 0,
      "multi-document crash recovery was incomplete");
    const first = recovered.restored[0].snapshot;
    const second = recovered.restored[1].snapshot;
    check(recovered.restored[0].manifest.generation === 2 &&
      recovered.restored[0].manifest.revision === recoveryPhase.firstRevision,
      "latest complete first generation was not selected");
    check(recovered.restored[1].manifest.generation === 1 &&
      recovered.restored[1].manifest.revision === recoveryPhase.secondRevision,
      "second workspace generation was not isolated");
    check(first.width === 4 && first.height === 3 && first.layers.length === 3,
      "first recovered PSD lost authored state");
    check(second.width === 2 && second.height === 2 && second.documents.length === 2,
      "second recovered PSD or multi-document isolation failed");
    check(recovered.activeSnapshot.documentId === first.documentId,
      "prior active workspace was not reactivated after id remap");
    await workspaceStore.savePreferences({ tool: "brush", brushSize: 37,
      color: "#123456", paintPreset: "ocean", font: "Georgia",
      selectionTolerance: 28, historyBudgetMiB: 128, panelsHidden: true });
    const preferences = await workspaceStore.loadPreferences();
    check(preferences.brushSize === 37 && preferences.historyBudgetMiB === 128,
      "browser preferences did not survive OPFS round-trip");
    await workspaceStore.remove(workspaceOne);
    await workspaceStore.remove(workspaceTwo);
    sessionStorage.removeItem(phaseKey);
    body.dataset.result = "PASS";
    body.textContent = `PASS crash-recovery documents=${second.documents.length} generations=2,1 workers=${createdClients}`;
  } else {
    for (const id of [workspaceOne, workspaceTwo]) {
      try { await workspaceStore.remove(id); } catch { /* A clean smoke run has no prior fixture. */ }
    }
    const first = await client.create(4, 3, "First.psd");
    check(first.documents.length === 1 && first.documentName === "First.psd",
      "first document projection mismatch");
    const budgeted = await client.setMemoryBudget(16 * 1024 * 1024, 32 * 1024 * 1024);
    check(budgeted.memoryBudget.documentBytes === 16 * 1024 * 1024 &&
      budgeted.memory?.totalRetainedBytes === 0,
    "WASM memory census or budget projection is unavailable");

    const rgba = new Uint8Array(4 * 3 * 4);
    const rgbaLength = rgba.length;
    for (let pixel = 0; pixel < 12; ++pixel) {
      rgba.set([32 + pixel, 96, 192, 255], pixel * 4);
    }
    const authored = await client.addPixelLayer({ name: "Pixels", width: 4, height: 3,
      bounds: { x: 0, y: 0, width: 4, height: 3 }, rgba }, { transferOwnership: true });
    check(rgba.byteLength === 0, "owned pixel input was not detached after Worker transfer");
    check(authored.memory?.documentPixelBytes >= rgbaLength &&
      authored.memory.totalRetainedBytes >= rgbaLength,
    "non-empty document memory census was not projected through wasm32");
    const layerId = authored.activeLayerId;
    check(layerId !== 0n && authored.layers.length === 1, "pixel layer was not authored");

    const gray = new Uint8Array([0, 32, 64, 96, 128, 160, 192, 224, 255, 224, 160, 96]);
    const grayLength = gray.length;
    const selected = await client.setSelectionMask(
      { x: 0, y: 0, width: 4, height: 3 }, gray, { transferOwnership: true });
    check(gray.byteLength === 0, "owned selection input was not detached after Worker transfer");
    check(selected.selectionMask?.gray.length === grayLength,
      "soft selection did not cross the wasm32 ABI");
    const quickSelected = await client.quickSelect({ points: [[1, 1], [2, 1]],
      brushRadius: 1, spread: 50, subtract: false, enhanceEdge: true,
      expectedStateId: selected.stateId, expectedRevision: selected.revision });
    check(quickSelected.revision >= selected.revision && quickSelected.selection.length > 0,
      "Quick Select did not cross the exact-state wasm32 ABI");
    const magneticSelected = await client.magneticLasso({ anchors: [[0, 0], [3, 0], [2, 2]],
      width: 4, edgeContrast: 10, nodeBudget: 4096, combine: 0,
      expectedStateId: quickSelected.stateId, expectedRevision: quickSelected.revision });
    check(magneticSelected.revision === quickSelected.revision + 1n && magneticSelected.selection.length > 0,
      "Magnetic Lasso did not publish one canonical wasm32 revision");
    const magneticUndone = await client.undo();
    const magneticRedone = await client.redo();
    check(magneticUndone.revision > magneticSelected.revision && magneticRedone.selection.length > 0,
      "advanced selection history did not survive undo/redo");
    const styled = await client.setLayerStylePreset(
      layerId, "57a1e500-0015-4c6d-8f2a-9b3d4e55c015");
    check(styled.revision > authored.revision, "style preset did not publish a revision");
    check(styled.dirtyRegion?.width === 4 && styled.dirtyRegion?.height === 3,
      "dirty render region did not cross the wasm32 ABI");
    const filterOperation = client.applyFilter(layerId, "patchy.filters.brightness_contrast",
      [{ key: "brightness", kind: "integer", value: 12 },
        { key: "contrast", kind: "integer", value: 8 }]);
    const filtered = await filterOperation.promise;
    check(filtered.revision === styled.revision + 1n,
      "parameterized filter was not one engine revision");
    const adjusted = await client.addAdjustment({ name: "Browser Levels", kind: 0,
      values: [8, 240, 110, 0, 255], curvePoints: [] });
    const adjustmentLayer = adjusted.layers.find((layer) => layer.id === adjusted.activeLayerId);
    check(adjustmentLayer?.adjustment?.values[2] === 110,
      "editable adjustment parameters did not cross wasm32");

    check((await client.render({ x: 0, y: 0, width: 1, height: 1 })).length === 4,
      "partial bounded render byte count mismatch");
    check((await client.snapshot()).dirtyRegion != null,
      "partial render cleared an uncovered dirty region");
    const rendered = await client.render({ x: 0, y: 0, width: 4, height: 3 });
    check(rendered.length === rgbaLength, "bounded render byte count mismatch");
    const frame = await client.renderFrame({ x: 0, y: 0, width: 4, height: 3 });
    check(frame.width === 4 && frame.height === 3, "render frame dimensions mismatch");
    check(frame.kind === "bitmap", `Worker ImageBitmap transport unavailable: ${frame.kind}`);
    frame.bitmap.close();
    const renderedSnapshot = await client.snapshot();
    check(renderedSnapshot.dirtyRegion == null,
      "complete render did not clear the covered dirty region");
    check(renderedSnapshot.memory?.renderCacheEntries === 1 &&
      renderedSnapshot.memory?.renderCacheHits >= 1,
    `render tile cache was not reused or projected through wasm32: ${JSON.stringify(renderedSnapshot.memory)}`);
    const transformQuad = [0, 0, 3, 0, 3, 2, 0, 2];
    const transformPreview = await client.previewLayerTransform({ layerId,
      quad: transformQuad, expectedStateId: renderedSnapshot.stateId,
      expectedRevision: renderedSnapshot.revision });
    check(transformPreview.region.width === 4 && transformPreview.region.height === 3 &&
      transformPreview.rgba.length === 4 * 3 * 4,
    "engine-owned layer transform preview did not cross wasm32");
    const previewState = await client.snapshot();
    check(previewState.revision === renderedSnapshot.revision &&
      previewState.stateId === renderedSnapshot.stateId,
    "layer transform preview mutated canonical state");
    const transformed = await client.transformLayer({ layerId, quad: transformQuad,
      expectedStateId: renderedSnapshot.stateId,
      expectedRevision: renderedSnapshot.revision });
    const transformedLayer = transformed.layers.find((layer) => layer.id === layerId);
    check(transformed.revision === renderedSnapshot.revision + 1n &&
      transformedLayer.bounds.width === 3 && transformedLayer.bounds.height === 2,
    "layer transform was not one canonical wasm32 revision");
    const strokeInput = { layerId, mode: 0, brushSize: 2,
      color: [255, 0, 0, 255], points: [[1, 1], [2, 1]], source: [0, 0],
      expectedStateId: transformed.stateId, expectedRevision: transformed.revision };
    const strokePreview = await client.previewRasterStroke(strokeInput);
    check(strokePreview.region.width > 0 && strokePreview.rgba.length > 0,
      "engine-owned raster preview did not cross wasm32");
    const previewAfterStroke = await client.snapshot();
    check(previewAfterStroke.revision === transformed.revision,
      "raster preview mutated canonical state");
    const painted = await client.applyRasterStroke(strokeInput);
    check(painted.revision === transformed.revision + 1n,
      "raster stroke was not one canonical wasm32 revision");
    const saved = await client.saveDocument(first.documentId);
    check(saved.length > 26 && String.fromCharCode(...saved.subarray(0, 4)) === "8BPS",
      "layered PSD encoding mismatch");
    const blobOpened = await client.openBlob(
      new Blob([saved], { type: "image/vnd.adobe.photoshop" }), "Worker Blob.psd");
    check(blobOpened.layers.length === 2 && blobOpened.width === 4 && blobOpened.height === 3,
      "Worker-native Blob open lost layered PSD state");
    await client.closeDocument(blobOpened.documentId);
    await client.activateDocument(first.documentId);
    const inspected = await client.inspectBlob(new Blob([saved]));
    check(inspected.width === 4 && inspected.height === 3 && inspected.sourceBytes === saved.length,
      "bounded PSD header inspection mismatch");
    const workerSavedBlob = await client.saveDocumentBlob(first.documentId);
    check(workerSavedBlob.type === "image/vnd.adobe.photoshop" &&
      workerSavedBlob.size === saved.length,
    "Worker-native PSD Blob save mismatch");
    const smart = await client.addSmartObject({ name: "Embedded contents",
      filename: "contents.psd", filetype: "8BPS", width: 4, height: 3,
      bounds: { x: 0, y: 0, width: 4, height: 3 }, rgba: rendered.slice(),
      sourceBytes: saved.slice() }, { transferOwnership: true });
    const smartLayer = smart.layers.find((layer) => layer.id === smart.activeLayerId);
    check(smartLayer?.smartObject?.contentsEditable,
      "identity embedded PSD Smart Object did not expose Open Contents");
    const child = await client.openSmartObjectContents(smartLayer.id);
    check(child.documents.find((item) => item.active)?.smartObjectParentId === first.documentId,
      "Smart Object child tab lost its parent link");
    const childLayer = child.layers.find((layer) => layer.id === child.activeLayerId);
    await client.setLayerOpacity(childLayer.id, 0.5);
    const committedParent = await client.saveSmartObjectContents(child.documentId);
    check(committedParent.documentId === first.documentId &&
      committedParent.revision === smart.revision + 1n,
    "Smart Object Save-back was not one parent revision");
    const savedWithSmartObject = await client.saveDocument(first.documentId);
    await workspaceStore.checkpoint({ id: workspaceOne, name: "First.psd",
      revision: committedParent.revision, dirty: true, bytes: savedWithSmartObject });
    const opacity = await client.setLayerOpacity(layerId, 0.75);
    const savedAgain = await client.saveDocument(first.documentId);
    await workspaceStore.checkpoint({ id: workspaceOne, name: "First.psd",
      revision: opacity.revision, dirty: true, bytes: savedAgain });

    const second = await client.create(2, 2, "Second.psd");
    check(second.documents.length === 3 && second.documents.some((item) =>
      item.smartObjectParentId === first.documentId),
    "second isolated session or linked Smart Object child was not retained");
    const copied = await client.copyLayerToDocument({
      sourceDocumentId: first.documentId, targetDocumentId: second.documentId,
      layerId, expectedSourceStateId: opacity.stateId,
      expectedSourceRevision: opacity.revision,
      expectedTargetStateId: second.stateId,
      expectedTargetRevision: second.revision,
    });
    check(copied.documentId === second.documentId && copied.layers.length === 1 &&
      copied.revision === second.revision + 1n,
    "cross-document layer copy was not one target revision");
    const undoneCopy = await client.undo();
    check(undoneCopy.layers.length === 0, "cross-document copy was not undoable");
    const redoneCopy = await client.redo();
    check(redoneCopy.layers.length === 1, "cross-document copy was not redoable");
    const copiedPsd = await client.saveDocument(second.documentId);
    const reopenedCopy = await client.open(copiedPsd, "Copied layer.psd");
    check(reopenedCopy.layers.length === 1,
      "cross-document copied layer did not survive save/reopen");
    await client.closeDocument(reopenedCopy.documentId);
    await workspaceStore.checkpoint({ id: workspaceTwo, name: "Second.psd",
      revision: redoneCopy.revision, dirty: true,
      bytes: await client.saveDocument(second.documentId) });
    const restored = await client.activateDocument(first.documentId);
    check(restored.documentId === first.documentId && restored.layers.length === 3 &&
      restored.layers.some((layer) => layer.smartObject?.contentsEditable),
    "document switch lost canonical state");

    sessionStorage.setItem(phaseKey, JSON.stringify({ mode: "restore",
      firstRevision: String(opacity.revision),
      secondRevision: String(redoneCopy.revision) }));
    location.reload();
  }
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client?.terminate();
}
