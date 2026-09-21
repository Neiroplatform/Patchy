import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PatchyWorkerHost } from "../../sdk/engine/worker-host.mjs";
import { PatchyWorkerClient } from "../../sdk/engine/client.mjs";
import { EmscriptenPatchyEngine } from "../../sdk/engine/module-adapter.mjs";

test("WASM export manifest covers every engine symbol used by the adapter", async () => {
  const root = new URL("../../", import.meta.url);
  const exportsList = JSON.parse(await readFile(new URL("sdk/engine/exports.json", root), "utf8"));
  const adapter = await readFile(new URL("sdk/engine/module-adapter.mjs", root), "utf8");
  const used = new Set(adapter.match(/_patchy_engine_[a-z0-9_]+/g));
  for (const symbol of used) assert.ok(exportsList.includes(symbol), `${symbol} is not exported`);
  assert.ok(exportsList.includes("_malloc"));
  assert.ok(exportsList.includes("_free"));
  assert.equal(new Set(exportsList).size, exportsList.length);
});

test("Emscripten adapter owns buffers and decodes wasm32 projections", () => {
  const memory = new ArrayBuffer(1 << 20);
  const heap = new Uint8Array(memory);
  const view = new DataView(memory);
  let next = 1024;
  let released = 0;
  let destroyed = 0;
  const alloc = (size) => { const at = next; next += (size + 7) & ~7; return at; };
  const module = {
    HEAPU8: heap,
    _malloc: alloc,
    _free() {},
    _patchy_engine_runtime_create() { return 11; },
    _patchy_engine_runtime_destroy() { destroyed++; },
    _patchy_engine_session_create_rgba8() { return 22; },
    _patchy_engine_session_destroy() { destroyed++; },
    _patchy_engine_session_document(session, output) {
      assert.equal(session, 22);
      assert.equal(view.getUint32(output, true), 56);
      view.setInt32(output + 4, 3, true); view.setInt32(output + 8, 2, true);
      view.setUint32(output + 12, 3, true); view.setUint32(output + 16, 8, true);
      view.setUint32(output + 20, 4, true); view.setBigUint64(output + 24, 7n, true);
      view.setBigUint64(output + 32, 4n, true); view.setBigUint64(output + 40, 9n, true);
      view.setUint32(output + 48, 1, true); heap[output + 52] = 1; heap[output + 53] = 1;
      return 1;
    },
    _patchy_engine_session_layer_at(session, index, output) {
      assert.equal(index, 0);
      view.setBigUint64(output, 7n, true); view.setUint32(output + 16, 0, true);
      heap[output + 20] = 1; view.setFloat32(output + 24, 1, true);
      view.setUint32(output + 28, 5, true); heap.set(new TextEncoder().encode("Layer"), output + 32);
      view.setFloat32(output + 292, 1, true); view.setInt32(output + 312, 3, true);
      view.setInt32(output + 316, 2, true); return 1;
    },
    _patchy_engine_session_set_layer_visibility(session, state, revision, layer, visible) {
      assert.deepEqual([session, state, revision, layer, visible], [22, 9n, 4n, 7n, 0]); return 1;
    },
    _patchy_engine_session_render_region(session, x, y, width, height, output) {
      assert.deepEqual([x, y, width, height], [0, 0, 3, 2]);
      const data = alloc(24); heap.fill(17, data, data + 24);
      view.setUint32(output, data, true); view.setUint32(output + 4, 24, true); return 1;
    },
    _patchy_engine_session_save_psd(session, output) {
      const data = alloc(4); heap.set([56, 66, 80, 83], data);
      view.setUint32(output, data, true); view.setUint32(output + 4, 4, true); return 1;
    },
    _patchy_engine_buffer_release() { released++; },
    _patchy_engine_session_move_layer() { return 1; },
    _patchy_engine_session_undo() { return 1; },
    _patchy_engine_session_redo() { return 1; },
  };
  const engine = new EmscriptenPatchyEngine(module);
  const session = engine.create(3, 2);
  const snapshot = engine.snapshot(session);
  assert.equal(snapshot.layers[0].name, "Layer");
  assert.equal(snapshot.layers[0].bounds.width, 3);
  engine.setLayerVisibility(session, snapshot, 7n, false);
  assert.equal(engine.render(session, { x: 0, y: 0, width: 3, height: 2 }).byteLength, 24);
  assert.deepEqual(Array.from(engine.save(session)), [56, 66, 80, 83]);
  assert.equal(released, 2);
  engine.dispose();
  assert.equal(destroyed, 2);
});

function projection(revision, visible = true) {
  return {
    width: 3, height: 2, colorMode: 3, bitDepth: 8, channels: 4,
    activeLayerId: 7n, revision: BigInt(revision), stateId: BigInt(revision),
    layerCount: 1, hasActiveLayer: true, dirty: revision > 1,
    canUndo: revision > 1, canRedo: false,
    layers: [{ id: 7n, parentId: 0n, kind: 0, visible, opacity: 1,
      name: "Layer", clipped: false, fillOpacity: 1, blendMode: 0,
      lockFlags: 0, bounds: { x: 0, y: 0, width: 3, height: 2 } }],
  };
}

test("worker host runs the minimal browser editing vertical workflow", async () => {
  let revision = 1;
  let visible = true;
  const calls = [];
  const engine = {
    create(width, height) { calls.push(["create", width, height]); return 41; },
    snapshot(session) { assert.equal(session, 41); return projection(revision, visible); },
    setLayerVisibility(session, before, layerId, next) {
      calls.push(["visibility", before.revision, layerId, next]);
      visible = next; revision++;
    },
    moveLayer(session, before, layerId, target, position) {
      calls.push(["move", before.revision, layerId, target, position]); revision++;
    },
    undo() { calls.push(["undo"]); revision--; visible = true; },
    redo() { calls.push(["redo"]); revision++; visible = false; },
    render() { calls.push(["render"]); return new Uint8Array(24).fill(9); },
    save() { calls.push(["save"]); return new Uint8Array([56, 66, 80, 83]); },
    close(session) { calls.push(["close", session]); },
    dispose() { calls.push(["dispose"]); },
  };
  const host = new PatchyWorkerHost(engine);
  assert.equal((await host.dispatch({ method: "create", width: 3, height: 2 })).revision, 1n);
  assert.equal((await host.dispatch({ method: "setLayerVisibility", layerId: "7", visible: false })).layers[0].visible, false);
  await host.dispatch({ method: "moveLayer", layerId: "7", targetLayerId: null, position: 3 });
  assert.equal((await host.dispatch({ method: "undo" })).revision, 2n);
  assert.equal((await host.dispatch({ method: "redo" })).layers[0].visible, false);
  assert.equal((await host.dispatch({ method: "render", region: { x: 0, y: 0, width: 3, height: 2 } })).byteLength, 24);
  assert.deepEqual(Array.from(await host.dispatch({ method: "save" })), [56, 66, 80, 83]);
  await host.dispatch({ method: "close" });
  host.dispose();
  assert.deepEqual(calls[1], ["visibility", 1n, 7n, false]);
  assert.deepEqual(calls[2], ["move", 2n, 7n, null, 3]);
  assert.ok(calls.some(([name]) => name === "save"));
});

class FakeWorker extends EventTarget {
  sent = [];
  postMessage(message, transfer) { this.sent.push({ message, transfer }); }
  terminate() {}
  reply(message) { this.dispatchEvent(new MessageEvent("message", { data: message })); }
  fail(message) {
    const event = new Event("error");
    Object.defineProperty(event, "message", { value: message });
    this.dispatchEvent(event);
  }
}

test("client correlates RPC, transfers input and rejects all requests on crash", async () => {
  const worker = new FakeWorker();
  const client = new PatchyWorkerClient(worker);
  const init = client.initialize("./patchy-engine.mjs");
  worker.reply({ id: 1, ok: true, value: null });
  await init;
  assert.equal(client.state, "ready");
  const source = new Uint8Array([1, 2, 3]);
  const opened = client.open(source);
  assert.equal(worker.sent[1].transfer.length, 1);
  worker.reply({ id: 2, ok: true, value: projection(1) });
  assert.equal((await opened).layers[0].id, 7n);
  const pending = client.save();
  worker.fail("worker trap");
  await assert.rejects(pending, /worker trap/);
  assert.equal(client.state, "crashed");
  await assert.rejects(client.undo(), /crashed/);
});
