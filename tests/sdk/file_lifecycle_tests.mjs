import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BrowserFileLifecycle, layeredFilename, supportsFileSystemAccess } from
  "../../sdk/engine/file-lifecycle.mjs";

function projection(revision, dirty = true, documentId = 7) {
  return { documentId, stateId: BigInt(revision * 10), revision: BigInt(revision), dirty,
    documentName: "Artwork.psd" };
}

function handle(name = "Artwork.psd", permission = "granted") {
  const writes = []; let closed = 0; let aborted = 0;
  return { name, writes, get closed() { return closed; }, get aborted() { return aborted; },
    async queryPermission() { return permission; }, async requestPermission() { return permission; },
    async createWritable() { return { async write(value) { writes.push(value); },
      async close() { closed++; }, async abort() { aborted++; } }; } };
}

test("capability and layered filenames are deterministic", () => {
  assert.equal(supportsFileSystemAccess({ showOpenFilePicker() {}, showSaveFilePicker() {} }), true);
  assert.equal(supportsFileSystemAccess({ showOpenFilePicker() {} }), false);
  assert.equal(layeredFilename("Sketch.PSD", "psb"), "Sketch.psb");
  assert.equal(layeredFilename("../bad/name", "psd"), ".._bad_name.psd");
});

test("native open binds the selected handle to the opened document", async () => {
  const openedHandle = handle(); openedHandle.getFile = async () => new Blob(["psd"]);
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker: async () => [openedHandle],
    showSaveFilePicker: async () => openedHandle } });
  const picked = await lifecycle.pickOpen();
  assert.equal(picked.kind, "handle");
  lifecycle.bindOpened(7, picked.handle, projection(1, false), "psd");
  assert.equal(lifecycle.hasHandle(7), true);
});

test("durable persistence is reported only after writable close", async () => {
  const target = handle();
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {},
    showSaveFilePicker: async () => target } });
  lifecycle.register(7, projection(1, false), "psd");
  let encoded = 0;
  const result = await lifecycle.save({ documentId: 7, projection: projection(2), format: "psd",
    name: "Artwork.psd", createBlob: async () => { encoded++; return new Blob(["bytes"]); } });
  assert.deepEqual({ kind: result.kind, durable: result.durable, bytes: result.bytes },
    { kind: "file", durable: true, bytes: 5 });
  assert.equal(encoded, 1); assert.equal(target.writes.length, 1); assert.equal(target.closed, 1);
});

test("denied and cancelled native saves do not encode or clear dirty state", async () => {
  let encoded = 0;
  const denied = handle("Denied.psd", "denied");
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {},
    showSaveFilePicker: async () => denied } });
  lifecycle.register(7, projection(1, false), "psd");
  const result = await lifecycle.save({ documentId: 7, projection: projection(2), format: "psd",
    name: "Artwork.psd", createBlob: async () => { encoded++; return new Blob(["x"]); } });
  assert.equal(result.kind, "permission-denied"); assert.equal(encoded, 0);
  lifecycle.release(7);
  lifecycle.register(7, projection(1, false), "psd");
  const cancelled = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {},
    showSaveFilePicker: async () => { throw new DOMException("cancel", "AbortError"); } } });
  cancelled.register(7, projection(1, false), "psd");
  assert.equal((await cancelled.save({ documentId: 7, projection: projection(2), format: "psd",
    name: "Artwork.psd", createBlob: async () => new Blob(["x"]) })).kind, "cancelled");
});

test("revoked permission on an existing handle fails before encoding", async () => {
  let encoded = 0;
  const revoked = handle("Revoked.psd", "denied");
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {},
    showSaveFilePicker: async () => { assert.fail("Save must reuse the bound handle"); } } });
  lifecycle.bindOpened(7, revoked, projection(1, false), "psd");
  const result = await lifecycle.save({ documentId: 7, projection: projection(2), format: "psd",
    name: "Revoked.psd", createBlob: async () => { encoded++; return new Blob(["x"]); } });
  assert.equal(result.kind, "permission-denied"); assert.equal(encoded, 0);
});

test("download fallback never claims durable persistence", async () => {
  const downloads = [];
  const lifecycle = new BrowserFileLifecycle({ scope: {},
    download: (blob, name) => downloads.push({ blob, name }) });
  lifecycle.register(7, projection(1, false), "psd");
  const result = await lifecycle.save({ documentId: 7, projection: projection(2), format: "psb",
    name: "Artwork.psd", createBlob: async () => new Blob(["fallback"]) });
  assert.equal(result.kind, "download"); assert.equal(result.durable, false);
  assert.equal(downloads[0].name, "Artwork.psb");
});

test("worker recovery remaps colliding document ids without moving handles between tabs", async () => {
  const first = handle("First.psd"); const second = handle("Second.psd");
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {}, showSaveFilePicker() {} } });
  lifecycle.bindOpened(1, first, projection(1, false, 1), "psd");
  lifecycle.bindOpened(2, second, projection(1, false, 2), "psd");
  lifecycle.remapAll([
    { previousDocumentId: 1, documentId: 2, projection: projection(1, true, 2), format: "psd" },
    { previousDocumentId: 2, documentId: 1, projection: projection(1, true, 1), format: "psd" },
  ]);
  assert.equal(lifecycle.hasHandle(1), true); assert.equal(lifecycle.hasHandle(2), true);
  await lifecycle.save({ documentId: 1, projection: projection(2, true, 1), format: "psd",
    name: "Second.psd", createBlob: async () => new Blob(["second"]) });
  assert.equal(first.writes.length, 0); assert.equal(second.writes.length, 1);
});

test("partial recovery releases failed old ids before publishing colliding new ids", async () => {
  const failed = handle("Failed.psd"); const restored = handle("Restored.psd");
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {}, showSaveFilePicker() {} } });
  lifecycle.bindOpened(1, failed, projection(1, false, 1), "psd");
  lifecycle.bindOpened(2, restored, projection(1, false, 2), "psd");
  lifecycle.remapAll([
    { previousDocumentId: 2, documentId: 1, projection: projection(1, true, 1), format: "psd" },
  ], [1]);
  assert.equal(lifecycle.hasHandle(1), true); assert.equal(lifecycle.hasHandle(2), false);
  await lifecycle.save({ documentId: 1, projection: projection(2, true, 1), format: "psd",
    name: "Restored.psd", createBlob: async () => new Blob(["restored"]) });
  assert.equal(failed.writes.length, 0); assert.equal(restored.writes.length, 1);
});

test("write failure aborts and preserves the previous savepoint", async () => {
  const target = handle();
  target.createWritable = async () => ({ async write() { throw new Error("disk full"); },
    async close() { assert.fail("close must not run"); }, async abort() { target.abortCount = 1; } });
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {},
    showSaveFilePicker: async () => target } });
  lifecycle.register(7, projection(1, false), "psd");
  await assert.rejects(lifecycle.save({ documentId: 7, projection: projection(2), format: "psd",
    name: "Artwork.psd", createBlob: async () => new Blob(["x"]) }), /disk full/);
  assert.equal(target.abortCount, 1);
});

test("close failure aborts and never reports durable persistence", async () => {
  const target = handle();
  target.createWritable = async () => ({ async write() {},
    async close() { throw new Error("close failed"); },
    async abort() { target.abortCount = (target.abortCount || 0) + 1; } });
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {},
    showSaveFilePicker: async () => target } });
  lifecycle.register(7, projection(1, false), "psd");
  await assert.rejects(lifecycle.save({ documentId: 7, projection: projection(2), format: "psd",
    name: "Artwork.psd", createBlob: async () => new Blob(["x"]) }), /close failed/);
  assert.equal(target.abortCount, 1);
});

test("large Worker Blob is passed to the writable without UI byte materialization", async () => {
  const target = handle();
  const bytes = new Uint8Array(64 * 1024 * 1024);
  const largeBlob = new Blob([bytes]);
  largeBlob.arrayBuffer = async () => { assert.fail("UI must not materialize Worker Blob bytes"); };
  target.createWritable = async () => ({
    async write(value) { assert.equal(value, largeBlob); }, async close() {}, async abort() {},
  });
  const lifecycle = new BrowserFileLifecycle({ scope: { showOpenFilePicker() {},
    showSaveFilePicker: async () => target } });
  const result = await lifecycle.save({ documentId: 7, projection: projection(2), format: "psb",
    name: "Large.psb", createBlob: async () => largeBlob });
  assert.equal(result.durable, true); assert.equal(result.bytes, 64 * 1024 * 1024);
});

test("production shell stages the lifecycle and exposes open/save/save-as contracts", async () => {
  const root = new URL("../../", import.meta.url);
  const [cmake, html, editor] = await Promise.all([
    readFile(new URL("CMakeLists.txt", root), "utf8"),
    readFile(new URL("sdk/engine/site/patchy.html", root), "utf8"),
    readFile(new URL("sdk/engine/site/editor.mjs", root), "utf8"),
  ]);
  assert.match(cmake, /sdk\/engine\/file-lifecycle\.mjs/);
  assert.match(html, /id="saveAsButton"/);
  assert.match(editor, /fileLifecycle\.pickOpen\(\)/);
  assert.match(editor, /fileLifecycle\.save\(/);
  assert.match(editor, /const savingClient = client;/);
  assert.match(editor, /const savingSnapshot = snapshot;/);
  assert.match(editor, /automaticRecoveryEnabled = false;/);
  assert.match(editor, /savingClient\.markSaved\([\s\S]*savingSnapshot\.documentId,[\s\S]*savingSnapshot\.stateId\)/);
  assert.match(editor, /savingClient\.state === "crashed" && client === savingClient/);
  assert.match(editor, /documentTab\.dirty/);
  assert.match(editor, /fileLifecycle\.remapAll\(/);
});
