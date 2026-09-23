import assert from "node:assert/strict";
import test from "node:test";
import { PatchyCheckpointQueue, PatchyWorkspaceStore } from "../../sdk/engine/workspace-store.mjs";

class MemoryFileHandle {
  kind = "file";
  constructor(name, files, failures) { this.name = name; this.files = files; this.failures = failures; }
  async getFile() {
    if (!this.files.has(this.name)) throw new Error("not found");
    const bytes = this.files.get(this.name).slice();
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  }
  async createWritable() {
    let pending = new Uint8Array();
    return {
      write: async (bytes) => {
        if (this.failures.write === this.name) throw new Error(`write failed: ${this.name}`);
        pending = new Uint8Array(bytes).slice();
      },
      close: async () => {
        if (this.failures.close === this.name) throw new Error(`close failed: ${this.name}`);
        this.files.set(this.name, pending);
      },
      abort: async () => {},
    };
  }
}

class MemoryDirectoryHandle {
  kind = "directory";
  files = new Map();
  directories = new Map();
  constructor(name = "root", failures = {}) { this.name = name; this.failures = failures; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.directories.has(name)) {
      if (!create) throw new Error("not found");
      this.directories.set(name, new MemoryDirectoryHandle(name, this.failures));
    }
    return this.directories.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!create && !this.files.has(name)) throw new Error("not found");
    return new MemoryFileHandle(name, this.files, this.failures);
  }
  async removeEntry(name) {
    if (!this.directories.delete(name) && !this.files.delete(name)) throw new Error("not found");
  }
  async *values() {
    yield* this.directories.values();
    for (const name of this.files.keys()) yield new MemoryFileHandle(name, this.files, this.failures);
  }
}

function fixture(options = {}) {
  const root = new MemoryDirectoryHandle();
  let tick = 0;
  const store = new PatchyWorkspaceStore({ rootProvider: async () => root,
    clock: () => `2026-09-21T00:00:0${tick++}.000Z`, ...options });
  return { root, store };
}

function layeredBytes(marker, format = "psd") {
  return new Uint8Array([56, 66, 80, 83, 0, format === "psb" ? 2 : 1, marker]);
}

test("availability provisions the versioned origin-private root", async () => {
  const { root, store } = fixture();
  assert.equal(await store.available(), true);
  assert.equal(root.directories.has("patchy-workspaces-v1"), true);
  assert.deepEqual(await store.list(), []);
});

test("per-document queue serializes publication and coalesces pending revisions", async () => {
  let releaseFirst;
  const firstWrite = new Promise((resolve) => { releaseFirst = resolve; });
  const saved = []; const written = []; const states = [];
  const queue = new PatchyCheckpointQueue({
    save: async (checkpoint) => { saved.push(checkpoint.revision); return new Uint8Array([checkpoint.revision]); },
    write: async (checkpoint) => {
      if (checkpoint.revision === 1) await firstWrite;
      written.push(checkpoint.revision); return { generation: written.length };
    },
    onState: (state, checkpoint) => states.push([state, checkpoint?.revision]),
  });
  queue.schedule({ revision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  queue.schedule({ revision: 2 });
  queue.schedule({ revision: 3 });
  releaseFirst();
  await queue.whenIdle();
  assert.deepEqual(saved, [1, 3]);
  assert.deepEqual(written, [1, 3]);
  assert.deepEqual(states, [["pending", 1], ["pending", 2], ["pending", 3],
    ["confirmed", 1], ["confirmed", 3]]);
});

test("checkpoint queue reports write failure without rejecting its idle barrier", async () => {
  const states = [];
  const queue = new PatchyCheckpointQueue({
    save: async () => new Uint8Array([1]),
    write: async () => { throw new Error("quota"); },
    onState: (state, checkpoint, value) => states.push([state, value?.message]),
  });
  queue.schedule({ revision: 1 });
  await queue.whenIdle();
  assert.deepEqual(states, [["pending", undefined], ["error", "quota"]]);
});

test("alternating generations restore the newest digest-valid PSD", async () => {
  const { store } = fixture();
  const first = await store.checkpoint({ id: "document-1", name: "One.psd", revision: 1n,
    bytes: layeredBytes(1) });
  const second = await store.checkpoint({ id: "document-1", name: "One.psd", revision: 2n,
    bytes: layeredBytes(2) });
  assert.equal(first.slot, "a"); assert.equal(second.slot, "b");
  const restored = await store.restore("document-1");
  assert.equal(restored.manifest.generation, 2);
  assert.deepEqual([...restored.bytes], [...layeredBytes(2)]);
  assert.deepEqual((await store.list()).map((item) => item.id), ["document-1"]);
});

test("workspace generations preserve a digest-bound canonical selection sidecar", async () => {
  const { root, store } = fixture();
  const selection = { bounds: { x: 2, y: 3, width: 3, height: 2 },
    gray: new Uint8Array([0, 32, 128, 192, 224, 255]) };
  await store.checkpoint({ id: "selected", name: "Selected.psd", revision: 3n,
    bytes: layeredBytes(3), selection });
  const restored = await store.restore("selected");
  assert.deepEqual(restored.selection?.bounds, selection.bounds);
  assert.deepEqual(restored.selection?.gray, selection.gray);
  assert.equal(restored.manifest.selection.size, selection.gray.byteLength);
  assert.match(restored.manifest.selection.sha256, /^[0-9a-f]{64}$/);

  await store.checkpoint({ id: "selected", name: "Selected.psd", revision: 4n,
    bytes: layeredBytes(4), selection: { ...selection, gray: selection.gray.map((value) => 255 - value) } });
  const base = await root.getDirectoryHandle("patchy-workspaces-v1");
  const workspace = await base.getDirectoryHandle("selected");
  workspace.files.set("selection-b.bin", new Uint8Array([1]));
  const fallback = await store.restore("selected");
  assert.equal(fallback.manifest.generation, 1);
  assert.deepEqual(fallback.selection?.gray, selection.gray);
  await assert.rejects(store.checkpoint({ id: "bad-selection", name: "Bad.psd", revision: 1n,
    bytes: layeredBytes(1), selection: { bounds: { x: 0, y: 0, width: 2, height: 2 },
      gray: new Uint8Array(3) } }), /selection sidecar/);

});

test("PSB recovery format is bound to encoded bytes rather than the document suffix", async () => {
  const { store } = fixture();
  const manifest = await store.checkpoint({ id: "renamed-psb", name: "Renamed.psd",
    revision: 4n, format: "psb", bytes: layeredBytes(7, "psb") });
  assert.equal(manifest.name, "Renamed.psd");
  assert.equal(manifest.format, "psb");
  const restored = await store.restore("renamed-psb");
  assert.equal(restored.manifest.format, "psb");
  assert.equal(restored.bytes[5], 2);
  await assert.rejects(store.checkpoint({ id: "mismatch", name: "Wrong.psd",
    revision: 1n, format: "psd", bytes: layeredBytes(8, "psb") }), /does not match/);
});

test("a failed next snapshot retains the prior complete generation", async () => {
  const failures = {}; const { root, store } = fixture();
  root.failures = failures;
  await store.checkpoint({ id: "safe", name: "Safe.psd", revision: 1n,
    bytes: layeredBytes(1) });
  failures.write = "snapshot-b.psd";
  await assert.rejects(store.checkpoint({ id: "safe", name: "Safe.psd", revision: 2n,
    bytes: layeredBytes(2) }), /write failed/);
  const restored = await store.restore("safe");
  assert.equal(restored.manifest.generation, 1);
  assert.equal(restored.bytes.at(-1), 1);
});

test("an interruption before snapshot write retains the prior generation", async () => {
  let interrupt = false;
  const { store } = fixture({ hooks: { beforeSnapshotWrite() {
    if (interrupt) throw new Error("simulated crash before snapshot");
  } } });
  await store.checkpoint({ id: "safe", name: "Safe.psd", revision: 1n,
    bytes: layeredBytes(1) });
  interrupt = true;
  await assert.rejects(store.checkpoint({ id: "safe", name: "Safe.psd", revision: 2n,
    bytes: layeredBytes(2) }), /before snapshot/);
  assert.equal((await store.restore("safe")).manifest.generation, 1);
});

test("a failure before manifest publication does not confirm the new slot", async () => {
  let rejectManifest = false;
  const { store } = fixture({ hooks: { beforeManifestWrite() {
    if (rejectManifest) throw new Error("simulated crash before manifest");
  } } });
  await store.checkpoint({ id: "safe", name: "Safe.psd", revision: 1n,
    bytes: layeredBytes(1) });
  rejectManifest = true;
  await assert.rejects(store.checkpoint({ id: "safe", name: "Safe.psd", revision: 2n,
    bytes: layeredBytes(2) }), /simulated crash/);
  const restored = await store.restore("safe");
  assert.equal(restored.manifest.generation, 1);
});

test("an interruption after manifest publication leaves the new generation recoverable", async () => {
  let interrupt = false;
  const { store } = fixture({ hooks: { afterManifestWrite() {
    if (interrupt) throw new Error("simulated crash after manifest");
  } } });
  await store.checkpoint({ id: "safe", name: "Safe.psd", revision: 1n,
    bytes: layeredBytes(1) });
  interrupt = true;
  await assert.rejects(store.checkpoint({ id: "safe", name: "Safe.psd", revision: 2n,
    bytes: layeredBytes(2) }), /after manifest/);
  const restored = await store.restore("safe");
  assert.equal(restored.manifest.generation, 2);
  assert.equal(restored.bytes.at(-1), 2);
});

test("unavailable origin-private storage fails closed", async () => {
  const store = new PatchyWorkspaceStore({ rootProvider: async () => {
    throw new Error("storage disabled");
  } });
  assert.equal(await store.available(), false);
});

test("corrupt newest bytes fall back and workspace removal is isolated", async () => {
  const { root, store } = fixture();
  for (const id of ["first", "second"]) {
    await store.checkpoint({ id, name: `${id}.psd`, revision: 1n,
      bytes: layeredBytes(id.length) });
  }
  await store.checkpoint({ id: "first", name: "first.psd", revision: 2n,
    bytes: layeredBytes(9) });
  const base = await root.getDirectoryHandle("patchy-workspaces-v1");
  const first = await base.getDirectoryHandle("first");
  first.files.set("snapshot-b.psd", new Uint8Array([0]));
  assert.equal((await store.restore("first")).manifest.generation, 1);
  await store.remove("first");
  assert.deepEqual((await store.list()).map((item) => item.id), ["second"]);
});

test("invalid ids and empty checkpoints fail closed", async () => {
  const { store } = fixture();
  await assert.rejects(store.checkpoint({ id: "../escape", revision: 1n,
    bytes: new Uint8Array([1]) }), /Invalid workspace id/);
  await assert.rejects(store.checkpoint({ id: "valid", revision: 1n,
    bytes: new Uint8Array() }), /non-empty PSD bytes/);
});

test("preferences round-trip with validation and malformed-data fallback", async () => {
  const { root, store } = fixture();
  const saved = await store.savePreferences({ locale: "ru", tool: "brush", brushSize: 42,
    color: "#AABBCC", paintPreset: "ocean", font: "Georgia",
    selectionTolerance: 31, historyBudgetMiB: 512, panelsHidden: true,
    guidesVisible: false, snappingEnabled: false });
  assert.deepEqual(saved, { locale: "ru", tool: "brush", brushSize: 42, color: "#aabbcc",
    paintPreset: "ocean", font: "Georgia", selectionTolerance: 31,
    historyBudgetMiB: 512, panelsHidden: true, guidesVisible: false, snappingEnabled: false });
  assert.deepEqual(await store.loadPreferences({ brushSize: 12 }), saved);
  await assert.rejects(store.savePreferences({ tool: "unknown" }), /Invalid preferred tool/);
  await assert.rejects(store.savePreferences({ locale: "de" }), /Invalid preferred locale/);
  await assert.rejects(store.savePreferences({ historyBudgetMiB: 12 }), /History memory budget/);
  const base = await root.getDirectoryHandle("patchy-workspaces-v1");
  base.files.set("preferences.json", new TextEncoder().encode("not-json"));
  assert.deepEqual(await store.loadPreferences({ tool: "marquee" }), { tool: "marquee" });
});

test("asset library alternates validated generations and preserves custom fills", async () => {
  const { root, store } = fixture();
  const first = await store.saveAssetLibrary({ generation: 0, gradients: [{ id: "gradient-sky",
    name: "Sky", start: "#112233", end: "#aabbcc" }], patterns: [], fonts: [] });
  assert.equal(first.generation, 1);
  const second = await store.saveAssetLibrary({ ...first, patterns: [{ id: "pattern-grid",
    name: "Grid", kind: "checker", foreground: "#010203", background: "#fefdfc", size: 12 }] });
  assert.equal(second.generation, 2);
  assert.deepEqual(await store.loadAssetLibrary(), second);
  const base = await root.getDirectoryHandle("patchy-workspaces-v1");
  base.files.set("assets-b.json", new TextEncoder().encode("torn"));
  assert.deepEqual((await store.loadAssetLibrary()).gradients, first.gradients);
});

test("font assets publish digest metadata, verify bytes and remove atomically", async () => {
  const { root, store } = fixture();
  const bytes = new Uint8Array([0, 1, 0, 0, 4, 8, 15, 16, 23, 42]);
  const metadata = await store.installFont({ id: "font-inter", family: "Inter Local",
    filename: "Inter.ttf", bytes });
  assert.equal(metadata.size, bytes.byteLength);
  assert.deepEqual([...(await store.loadFont("font-inter")).bytes], [...bytes]);
  await assert.rejects(store.installFont({ id: "font-inter", family: "Replacement",
    filename: "other.ttf", bytes: new Uint8Array([7, 8, 9]) }), /already exists/);
  assert.deepEqual([...(await store.loadFont("font-inter")).bytes], [...bytes]);
  const base = await root.getDirectoryHandle("patchy-workspaces-v1");
  const fonts = await base.getDirectoryHandle("fonts");
  fonts.files.set("font-inter.font", new Uint8Array([9]));
  await assert.rejects(store.loadFont("font-inter"), /integrity validation/);
  await store.removeAsset("fonts", "font-inter");
  assert.equal((await store.loadAssetLibrary()).fonts.length, 0);
});

test("explicit cleanup keeps newest recovery items and protects open workspaces", async () => {
  const { store } = fixture();
  for (const id of ["oldest", "protected", "newer", "newest"]) {
    await store.checkpoint({ id, name: `${id}.psd`, revision: 1n,
      bytes: layeredBytes(id.length) });
  }
  const removed = await store.cleanup({ protectedIds: ["protected"], keepNewest: 2 });
  assert.deepEqual(removed.map((item) => item.id), ["oldest"]);
  assert.deepEqual((await store.list()).map((item) => item.id), ["newest", "newer", "protected"]);
});
