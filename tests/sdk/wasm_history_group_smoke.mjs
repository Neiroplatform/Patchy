import assert from "node:assert/strict";
import { createRequire } from "node:module";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("usage: node wasm_history_group_smoke.mjs <site-url>");
async function loadPlaywright() {
  try { return await import("playwright"); }
  catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) throw error;
    return createRequire(import.meta.url)(root);
  }
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ extraHTTPHeaders: { "Accept-Encoding": "identity" } });
const page = await context.newPage();
try {
  const capabilitiesUrl = new URL("capabilities.html", baseUrl).href;
  await page.goto(capabilitiesUrl, { waitUntil: "domcontentloaded" });
  const evidence = await page.evaluate(async () => {
    const { createPatchyWorkerClient } = await import("./engine/index.mjs");
    const client = createPatchyWorkerClient(new URL("./engine/worker.mjs", location.href));
    try {
      await client.initialize(new URL("./patchy-engine.mjs", location.href).href);
      const created = await client.create(4, 4, "History group.psd");
      const group = await client.beginHistoryGroup();
      const rgba = new Uint8Array(4 * 4 * 4).fill(255);
      let changed = await client.addPixelLayer({ name: "First", width: 4, height: 4,
        bounds: { x: 0, y: 0, width: 4, height: 4 }, rgba }, { transferOwnership: true });
      changed = await client.renameLayer(changed.layers[0].id, "Grouped result");
      const committed = await client.commitHistoryGroup(group.groupId);
      const undone = await client.historyTravel(-1, committed.stateId, committed.revision);
      const redone = await client.historyTravel(1, undone.stateId, undone.revision);

      const abortGroup = await client.beginHistoryGroup();
      const renamed = await client.renameLayer(redone.layers[0].id, "Must roll back");
      const restored = await client.abortHistoryGroup(abortGroup.groupId);
      return { createdLayers: created.layers.length, committedLayers: committed.layers.length,
        committedName: committed.layers[0].name, undoneLayers: undone.layers.length,
        redoneName: redone.layers[0].name, renamedName: renamed.layers[0].name,
        restoredName: restored.layers[0].name, restoredCanRedo: restored.canRedo,
        committedUndoStates: committed.memory.undoStates,
        restoredUndoStates: restored.memory.undoStates };
    } finally { client.terminate(); }
  });
  assert.deepEqual(evidence, { createdLayers: 0, committedLayers: 1,
    committedName: "Grouped result", undoneLayers: 0, redoneName: "Grouped result",
    renamedName: "Must roll back", restoredName: "Grouped result", restoredCanRedo: false,
    committedUndoStates: 1, restoredUndoStates: 1 });
  console.log("WASM-HISTORY-GROUP PASS commitUndo=1 abortRollback=1");
} finally { await browser.close(); }
