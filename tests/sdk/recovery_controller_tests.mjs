import assert from "node:assert/strict";
import test from "node:test";
import { recoverWorkerSession } from "../../sdk/engine/recovery-controller.mjs";

function projection(documentId, name) {
  return { documentId, documentName: name, documents: [], layers: [], channels: [], paths: [] };
}

test("worker recovery restores valid tabs in order, remaps ids and reactivates the prior tab", async () => {
  const calls = []; let nextId = 100;
  const client = {
    async initialize(url) { calls.push(["initialize", url]); },
    async open(bytes, name, options) {
      calls.push(["open", name, bytes.at(-1), options?.transferOwnership]);
      return projection(nextId++, name);
    },
    async setSelectionMask(bounds, gray, options) {
      calls.push(["selection", bounds, [...gray], options?.transferOwnership]);
      return { ...projection(nextId - 1, "active.psb"),
        selectionMask: { bounds, gray: gray.slice() } };
    },
    async activateDocument(id) { calls.push(["activate", id]); return projection(id, `active-${id}.psd`); },
  };
  const store = { async restore(id) {
    if (id === "broken") throw new Error("digest mismatch");
    const format = id === "active" ? "psb" : "psd";
    return { manifest: { id, name: `${id}.psd`, revision: "9", format },
      bytes: new Uint8Array([56, 66, 80, 83, 0, format === "psb" ? 2 : 1, id.length]),
      selection: id === "active" ? { bounds: { x: 1, y: 2, width: 2, height: 1 },
        gray: new Uint8Array([64, 255]) } : null };
  } };
  const result = await recoverWorkerSession({ createClient: () => client,
    moduleUrl: "engine.mjs", workspaceStore: store, documents: [
      { documentId: 1, workspaceId: "first", active: false },
      { documentId: 2, workspaceId: "active", active: true, confirmed: false },
      { documentId: 3, workspaceId: "broken", active: false },
      { documentId: 4, workspaceId: "last", active: false },
    ] });
  assert.equal(result.client, client);
  assert.deepEqual(result.restored.map((item) =>
    [item.previousDocumentId, item.documentId, item.workspaceId]),
  [[1, 100, "first"], [2, 101, "active"], [4, 102, "last"]]);
  assert.deepEqual(result.failed.map((item) => item.workspaceId), ["broken"]);
  assert.equal(result.activeSnapshot.documentId, 101);
  assert.equal(result.restored[1].confirmedAtCrash, false);
  assert.equal(result.restored[1].format, "psb");
  assert.deepEqual(calls.map((item) => item[0]),
    ["initialize", "open", "open", "selection", "open", "activate"]);
  assert.ok(calls.filter((item) => item[0] === "open").every((item) => item[3] === true));
  assert.deepEqual(calls.find((item) => item[0] === "selection")?.slice(1),
    [{ x: 1, y: 2, width: 2, height: 1 }, [64, 255], true]);
  assert.deepEqual(result.restored[1].snapshot.selectionMask?.gray,
    new Uint8Array([64, 255]));
});

test("worker recovery terminates a replacement that cannot initialize", async () => {
  let terminated = 0;
  const client = { async initialize() { throw new Error("wasm failed"); },
    terminate() { terminated++; } };
  await assert.rejects(recoverWorkerSession({ createClient: () => client,
    moduleUrl: "engine.mjs", workspaceStore: {}, documents: [] }), /wasm failed/);
  assert.equal(terminated, 1);
});
