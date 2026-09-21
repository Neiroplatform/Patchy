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
    bytes: new Uint8Array([56, 66, 80, 83, 1]) });
  const second = await store.checkpoint({ id: "document-1", name: "One.psd", revision: 2n,
    bytes: new Uint8Array([56, 66, 80, 83, 2, 2]) });
  assert.equal(first.slot, "a"); assert.equal(second.slot, "b");
  const restored = await store.restore("document-1");
  assert.equal(restored.manifest.generation, 2);
  assert.deepEqual([...restored.bytes], [56, 66, 80, 83, 2, 2]);
  assert.deepEqual((await store.list()).map((item) => item.id), ["document-1"]);
});

test("a failed next snapshot retains the prior complete generation", async () => {
  const failures = {}; const { root, store } = fixture();
  root.failures = failures;
  await store.checkpoint({ id: "safe", name: "Safe.psd", revision: 1n,
    bytes: new Uint8Array([56, 66, 80, 83, 1]) });
  failures.write = "snapshot-b.psd";
  await assert.rejects(store.checkpoint({ id: "safe", name: "Safe.psd", revision: 2n,
    bytes: new Uint8Array([56, 66, 80, 83, 2]) }), /write failed/);
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
    bytes: new Uint8Array([56, 66, 80, 83, 1]) });
  interrupt = true;
  await assert.rejects(store.checkpoint({ id: "safe", name: "Safe.psd", revision: 2n,
    bytes: new Uint8Array([56, 66, 80, 83, 2]) }), /before snapshot/);
  assert.equal((await store.restore("safe")).manifest.generation, 1);
});

test("a failure before manifest publication does not confirm the new slot", async () => {
  let rejectManifest = false;
  const { store } = fixture({ hooks: { beforeManifestWrite() {
    if (rejectManifest) throw new Error("simulated crash before manifest");
  } } });
  await store.checkpoint({ id: "safe", name: "Safe.psd", revision: 1n,
    bytes: new Uint8Array([56, 66, 80, 83, 1]) });
  rejectManifest = true;
  await assert.rejects(store.checkpoint({ id: "safe", name: "Safe.psd", revision: 2n,
    bytes: new Uint8Array([56, 66, 80, 83, 2]) }), /simulated crash/);
  const restored = await store.restore("safe");
  assert.equal(restored.manifest.generation, 1);
});

test("an interruption after manifest publication leaves the new generation recoverable", async () => {
  let interrupt = false;
  const { store } = fixture({ hooks: { afterManifestWrite() {
    if (interrupt) throw new Error("simulated crash after manifest");
  } } });
  await store.checkpoint({ id: "safe", name: "Safe.psd", revision: 1n,
    bytes: new Uint8Array([56, 66, 80, 83, 1]) });
  interrupt = true;
  await assert.rejects(store.checkpoint({ id: "safe", name: "Safe.psd", revision: 2n,
    bytes: new Uint8Array([56, 66, 80, 83, 2]) }), /after manifest/);
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
      bytes: new Uint8Array([56, 66, 80, 83, id.length]) });
  }
  await store.checkpoint({ id: "first", name: "first.psd", revision: 2n,
    bytes: new Uint8Array([56, 66, 80, 83, 9]) });
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
  const saved = await store.savePreferences({ tool: "brush", brushSize: 42,
    color: "#AABBCC", paintPreset: "ocean", font: "Georgia",
    selectionTolerance: 31, historyBudgetMiB: 512, panelsHidden: true });
  assert.deepEqual(saved, { tool: "brush", brushSize: 42, color: "#aabbcc",
    paintPreset: "ocean", font: "Georgia", selectionTolerance: 31,
    historyBudgetMiB: 512, panelsHidden: true });
  assert.deepEqual(await store.loadPreferences({ brushSize: 12 }), saved);
  await assert.rejects(store.savePreferences({ tool: "unknown" }), /Invalid preferred tool/);
  await assert.rejects(store.savePreferences({ historyBudgetMiB: 12 }), /History memory budget/);
  const base = await root.getDirectoryHandle("patchy-workspaces-v1");
  base.files.set("preferences.json", new TextEncoder().encode("not-json"));
  assert.deepEqual(await store.loadPreferences({ tool: "marquee" }), { tool: "marquee" });
});

test("explicit cleanup keeps newest recovery items and protects open workspaces", async () => {
  const { store } = fixture();
  for (const id of ["oldest", "protected", "newer", "newest"]) {
    await store.checkpoint({ id, name: `${id}.psd`, revision: 1n,
      bytes: new Uint8Array([56, 66, 80, 83, id.length]) });
  }
  const removed = await store.cleanup({ protectedIds: ["protected"], keepNewest: 2 });
  assert.deepEqual(removed.map((item) => item.id), ["oldest"]);
  assert.deepEqual((await store.list()).map((item) => item.id), ["newest", "newer", "protected"]);
});
