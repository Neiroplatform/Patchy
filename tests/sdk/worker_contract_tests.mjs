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

test("self-hosted editor closes the minimal product workflow without remote assets", async () => {
  const root = new URL("../../", import.meta.url);
  const html = await readFile(new URL("sdk/engine/site/patchy.html", root), "utf8");
  const css = await readFile(new URL("sdk/engine/site/editor.css", root), "utf8");
  const script = await readFile(new URL("sdk/engine/site/editor.mjs", root), "utf8");
  const nodeServer = await readFile(new URL("scripts/wasm/serve.mjs", root), "utf8");
  const pythonServer = await readFile(new URL("scripts/wasm/serve.py", root), "utf8");
  for (const id of ["openButton", "fileInput", "imageInput", "documentCanvas", "layerList",
    "importLayerButton", "groupLayerButton", "removeLayerButton", "layerNameInput",
    "layerOpacityInput", "layerBlendSelect", "invertLayerButton", "transformButton",
    "documentDialog", "resizeImageButton", "resizeCanvasButton", "rotateLeftButton",
    "rotateRightButton", "cropButton", "busyProgress", "cancelOperationButton",
    "undoButton", "redoButton", "saveButton", "errorBanner"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const method of ["client.open", "client.setLayerVisibility",
    "client.moveLayer", "client.addPixelLayer", "client.groupLayer", "client.removeLayer",
    "client.renameLayer", "client.setLayerOpacity", "client.setLayerBlendMode",
    "client.resizeImage", "client.resizeCanvas", "client.rotateCanvas",
    "client.cropDocument", "client.invertLayer",
    "client.undo", "client.redo", "client.render", "client.save"]) {
    assert.ok(script.includes(method), `${method} is not wired`);
  }
  assert.match(script, /from "\.\/engine\/client\.mjs"/);
  assert.match(script, /new URL\("\.\/engine\/worker\.mjs", import\.meta\.url\)/);
  assert.match(script, /new URL\("\.\/patchy-engine\.mjs", location\.href\)/);
  assert.doesNotMatch(`${html}\n${css}\n${script}`, /https?:\/\//);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(html, /role="alert"/);
  assert.match(nodeServer, /'\.css': 'text\/css; charset=utf-8'/);
  assert.match(pythonServer, /"\.css": "text\/css; charset=utf-8"/);
});

test("Emscripten adapter owns buffers and decodes wasm32 projections", () => {
  const memory = new ArrayBuffer(1 << 20);
  const heap = new Uint8Array(memory);
  const view = new DataView(memory);
  let next = 1024;
  let released = 0;
  let destroyed = 0;
  let callback = null;
  const callbackReturns = [];
  const commandTypes = [];
  const alloc = (size) => { const at = next; next += (size + 7) & ~7; return at; };
  const module = {
    HEAPU8: heap,
    _malloc: alloc,
    _free() {},
    _patchy_engine_runtime_create() { return 11; },
    _patchy_engine_runtime_destroy() { destroyed++; },
    addFunction(value, signature) { assert.equal(signature, "iiiii"); callback = value; return 71; },
    removeFunction(pointer) { assert.equal(pointer, 71); callback = null; },
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
    _patchy_engine_session_execute(session, command) {
      assert.equal(session, 22);
      assert.equal(view.getUint32(command, true), 304);
      assert.equal(view.getUint32(command + 4, true), 1);
      assert.equal(view.getBigUint64(command + 16, true), 9n);
      assert.equal(view.getBigUint64(command + 24, true), 4n);
      const type = view.getUint32(command + 8, true);
      commandTypes.push(type);
      if (type === 2) assert.equal(view.getFloat32(command + 40, true), 0.5);
      if (type === 4) assert.equal(view.getUint32(command + 40, true), 2);
      if (type === 5) {
        const size = view.getUint32(command + 40, true);
        assert.equal(new TextDecoder().decode(heap.subarray(command + 44, command + 44 + size)), "Renamed");
      }
      if (type === 14) {
        const size = view.getUint32(command + 32, true);
        assert.equal(new TextDecoder().decode(heap.subarray(command + 36, command + 36 + size)), "Group");
      }
      if (type === 10) assert.deepEqual([view.getInt32(command + 32, true), view.getInt32(command + 36, true)], [6, 4]);
      if (type === 11) assert.deepEqual([view.getInt32(command + 32, true), view.getInt32(command + 36, true), view.getUint32(command + 40, true)], [8, 6, 4]);
      if (type === 12) assert.equal(view.getFloat64(command + 32, true), 90);
      if (type === 13) assert.deepEqual([view.getInt32(command + 32, true), view.getInt32(command + 36, true), view.getInt32(command + 40, true), view.getInt32(command + 44, true)], [1, 1, 4, 3]);
      return 1;
    },
    _patchy_engine_session_group_layer(session, state, revision, layer, name, nameSize) {
      assert.deepEqual([session, state, revision, layer], [22, 9n, 4n, 7n]);
      assert.equal(new TextDecoder().decode(heap.subarray(name, name + nameSize)), "Group");
      return 1;
    },
    _patchy_engine_session_add_rgba8_layer(session, input) {
      assert.equal(view.getUint32(input, true), 80);
      assert.equal(view.getBigUint64(input + 8, true), 9n);
      assert.equal(view.getInt32(input + 48, true), 1);
      assert.equal(view.getInt32(input + 52, true), 1);
      assert.equal(view.getUint32(input + 60, true), 4);
      return 1;
    },
    _patchy_engine_session_apply_filter(session, input, progress) {
      assert.equal(session, 22);
      assert.equal(view.getUint32(input, true), 56);
      assert.equal(view.getBigUint64(input + 24, true), 7n);
      const filterPointer = view.getUint32(input + 32, true);
      const filterSize = view.getUint32(input + 36, true);
      assert.equal(new TextDecoder().decode(heap.subarray(filterPointer, filterPointer + filterSize)), "patchy.filters.invert");
      assert.equal(progress, 71);
      callbackReturns.push(callback(1, 2, 0, 0), callback(2, 2, 0, 0));
      return 1;
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
  engine.setLayerOpacity(session, snapshot, 7n, 0.5);
  engine.setLayerBlendMode(session, snapshot, 7n, 2);
  engine.renameLayer(session, snapshot, 7n, "Renamed");
  engine.removeLayer(session, snapshot, 7n);
  engine.resizeImage(session, snapshot, 6, 4);
  engine.resizeCanvas(session, snapshot, 8, 6);
  engine.rotateCanvas(session, snapshot, 90);
  engine.cropDocument(session, snapshot, { x: 1, y: 1, width: 4, height: 3 });
  engine.groupLayer(session, snapshot, 7n, "Group");
  engine.ungroup(session, snapshot, 7n);
  engine.addPixelLayer(session, snapshot, { name: "Pixel", width: 1, height: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, rgba: new Uint8Array([1, 2, 3, 4]) });
  const progress = [];
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  engine.applyFilter(session, snapshot, 7n, "patchy.filters.invert",
    cancellation, (value) => progress.push(value.ratio));
  assert.deepEqual(progress, [0.5, 1]);
  Atomics.store(cancellation, 0, 1);
  engine.applyFilter(session, snapshot, 7n, "patchy.filters.invert", cancellation);
  assert.deepEqual(callbackReturns, [1, 1, 0, 0]);
  assert.deepEqual(commandTypes, [2, 4, 5, 9, 10, 11, 12, 13, 16]);
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
    setLayerOpacity(session, before, layerId, opacity) { calls.push(["opacity", layerId, opacity]); revision++; },
    setLayerBlendMode(session, before, layerId, mode) { calls.push(["blend", layerId, mode]); revision++; },
    renameLayer(session, before, layerId, name) { calls.push(["rename", layerId, name]); revision++; },
    removeLayer(session, before, layerId) { calls.push(["remove", layerId]); revision++; },
    resizeImage(session, before, width, height) { calls.push(["resizeImage", width, height]); revision++; },
    resizeCanvas(session, before, width, height, anchor) { calls.push(["resizeCanvas", width, height, anchor]); revision++; },
    rotateCanvas(session, before, degrees) { calls.push(["rotate", degrees]); revision++; },
    cropDocument(session, before, crop) { calls.push(["crop", crop]); revision++; },
    applyFilter(session, before, layerId, filterId, cancellation, progress) {
      calls.push(["filter", layerId, filterId]); progress({ completed: 1, total: 1, stage: 0, ratio: 1 }); revision++;
    },
    groupLayer(session, before, layerId, name) { calls.push(["group", layerId, name]); revision++; },
    ungroup(session, before, layerId) { calls.push(["ungroup", layerId]); revision++; },
    addPixelLayer(session, before, input) { calls.push(["pixels", input.name, input.rgba.byteLength]); revision++; },
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
  await host.dispatch({ method: "setLayerOpacity", layerId: "7", opacity: 0.5 });
  await host.dispatch({ method: "setLayerBlendMode", layerId: "7", blendMode: 2 });
  await host.dispatch({ method: "renameLayer", layerId: "7", name: "Renamed" });
  await host.dispatch({ method: "removeLayer", layerId: "7" });
  await host.dispatch({ method: "resizeImage", width: 6, height: 4 });
  await host.dispatch({ method: "resizeCanvas", width: 8, height: 6, anchor: 4 });
  await host.dispatch({ method: "rotateCanvas", clockwiseDegrees: 90 });
  await host.dispatch({ method: "cropDocument", crop: { x: 1, y: 1, width: 4, height: 3 } });
  await host.dispatch({ method: "groupLayer", layerId: "7", name: "Group" });
  await host.dispatch({ method: "ungroup", layerId: "7" });
  await host.dispatch({ method: "addPixelLayer", name: "Pixels", width: 1, height: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, rgba: new Uint8Array([1, 2, 3, 4]).buffer });
  const filterProgress = [];
  await host.dispatch({ method: "invertLayer", layerId: "7",
    cancellation: new SharedArrayBuffer(4), progress: (value) => filterProgress.push(value.ratio) });
  assert.deepEqual(filterProgress, [1]);
  await host.dispatch({ method: "undo" });
  await host.dispatch({ method: "redo" });
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
  const pixelInput = new Uint8Array([1, 2, 3, 4]);
  const pixels = client.addPixelLayer({ name: "Pixels", width: 1, height: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, rgba: pixelInput });
  assert.equal(worker.sent[2].transfer.length, 1);
  worker.reply({ id: 3, ok: true, value: projection(2) });
  await pixels;
  const filterProgress = [];
  const filter = client.invertLayer(7n, (value) => filterProgress.push(value.ratio));
  const filterMessage = worker.sent[3].message;
  assert.ok(filterMessage.cancellation instanceof SharedArrayBuffer);
  worker.reply({ id: 4, progress: { completed: 1, total: 2, stage: 0, ratio: 0.5 } });
  assert.deepEqual(filterProgress, [0.5]);
  filter.cancel();
  assert.equal(Atomics.load(new Int32Array(filterMessage.cancellation), 0), 1);
  worker.reply({ id: 4, ok: true, value: projection(3) });
  await filter.promise;
  const pending = client.save();
  worker.fail("worker trap");
  await assert.rejects(pending, /worker trap/);
  assert.equal(client.state, "crashed");
  await assert.rejects(client.undo(), /crashed/);
});
