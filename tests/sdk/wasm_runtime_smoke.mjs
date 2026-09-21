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
  if (sessionStorage.getItem(phaseKey) === "restore") {
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
      recovered.restored[0].manifest.revision === "4",
      "latest complete first generation was not selected");
    check(recovered.restored[1].manifest.generation === 1,
      "second workspace generation was not isolated");
    check(first.width === 4 && first.height === 3 && first.layers.length === 1,
      "first recovered PSD lost authored state");
    check(second.width === 2 && second.height === 2 && second.documents.length === 2,
      "second recovered PSD or multi-document isolation failed");
    check(recovered.activeSnapshot.documentId === first.documentId,
      "prior active workspace was not reactivated after id remap");
    await workspaceStore.savePreferences({ tool: "brush", brushSize: 37,
      color: "#123456", paintPreset: "ocean", font: "Georgia",
      selectionTolerance: 28, panelsHidden: true });
    check((await workspaceStore.loadPreferences()).brushSize === 37,
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

    const rgba = new Uint8Array(4 * 3 * 4);
    for (let pixel = 0; pixel < 12; ++pixel) {
      rgba.set([32 + pixel, 96, 192, 255], pixel * 4);
    }
    const authored = await client.addPixelLayer({ name: "Pixels", width: 4, height: 3,
      bounds: { x: 0, y: 0, width: 4, height: 3 }, rgba });
    const layerId = authored.activeLayerId;
    check(layerId !== 0n && authored.layers.length === 1, "pixel layer was not authored");

    const gray = new Uint8Array([0, 32, 64, 96, 128, 160, 192, 224, 255, 224, 160, 96]);
    const selected = await client.setSelectionMask({ x: 0, y: 0, width: 4, height: 3 }, gray);
    check(selected.selectionMask?.gray.length === gray.length,
      "soft selection did not cross the wasm32 ABI");
    const styled = await client.setLayerStylePreset(
      layerId, "57a1e500-0015-4c6d-8f2a-9b3d4e55c015");
    check(styled.revision > authored.revision, "style preset did not publish a revision");

    const rendered = await client.render({ x: 0, y: 0, width: 4, height: 3 });
    check(rendered.length === rgba.length, "bounded render byte count mismatch");
    const saved = await client.saveDocument(first.documentId);
    check(saved.length > 26 && String.fromCharCode(...saved.subarray(0, 4)) === "8BPS",
      "layered PSD encoding mismatch");
    await workspaceStore.checkpoint({ id: workspaceOne, name: "First.psd",
      revision: styled.revision, dirty: true, bytes: saved });
    const opacity = await client.setLayerOpacity(layerId, 0.75);
    const savedAgain = await client.saveDocument(first.documentId);
    await workspaceStore.checkpoint({ id: workspaceOne, name: "First.psd",
      revision: opacity.revision, dirty: true, bytes: savedAgain });

    const second = await client.create(2, 2, "Second.psd");
    check(second.documents.length === 2, "second isolated session was not retained");
    await workspaceStore.checkpoint({ id: workspaceTwo, name: "Second.psd",
      revision: second.revision, dirty: false, bytes: await client.saveDocument(second.documentId) });
    const restored = await client.activateDocument(first.documentId);
    check(restored.documentId === first.documentId && restored.layers.length === 1,
      "document switch lost canonical state");

    sessionStorage.setItem(phaseKey, "restore");
    location.reload();
  }
} catch (error) {
  body.dataset.result = "FAIL";
  body.textContent = `FAIL ${error?.stack || error}`;
} finally {
  client?.terminate();
}
