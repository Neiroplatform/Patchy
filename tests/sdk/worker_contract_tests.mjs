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
    "canvasFrame", "selectionOverlay", "marqueeToolButton", "panToolButton",
    "zoomOutButton", "zoomFitButton", "zoomInButton", "createMaskButton",
    "toggleMaskButton", "invertMaskButton", "removeMaskButton",
    "gestureCanvas", "transformOverlay", "moveToolButton", "brushToolButton",
    "eraserToolButton", "textToolButton", "textLayerButton", "layerTransformButton",
    "textDialog", "commitTextButton", "layerTransformDialog", "commitLayerTransformButton",
    "shapeLayerButton", "adjustmentLayerButton", "smartObjectButton", "smartFilterButton",
    "cloneToolButton", "healToolButton", "gradientToolButton", "fillToolButton",
    "layerFillInput", "layerClipInput", "layerLockInput", "invertSelectionButton",
    "expandSelectionButton", "contractSelectionButton", "borderSelectionButton",
    "saveChannelButton", "savePathButton", "channelList", "pathList",
    "createVectorMaskButton", "smartObjectInput", "shapeDialog", "commitShapeButton",
    "adjustmentDialog", "commitAdjustmentButton", "smartFilterDialog", "commitSmartFilterButton",
    "undoButton", "redoButton", "saveButton", "errorBanner"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const method of ["client.open", "client.setLayerVisibility",
    "client.moveLayer", "client.addPixelLayer", "client.groupLayer", "client.removeLayer",
    "client.renameLayer", "client.setLayerOpacity", "client.setLayerBlendMode",
    "client.resizeImage", "client.resizeCanvas", "client.rotateCanvas",
    "client.cropDocument", "client.invertLayer",
    "client.setSelection", "client.clearSelection", "client.createLayerMask",
    "client.toggleLayerMask", "client.invertLayerMask", "client.removeLayerMask",
    "client.layerPixels", "client.layerMaskPixels", "client.replacePixelLayer",
    "client.replacePixelLayerAndMask", "client.addTextLayer",
    "client.updateTextLayer", "client.addVectorShape", "client.setVectorMask",
    "client.updateVectorShape",
    "client.addAdjustment", "client.updateAdjustment", "client.addSmartObject",
    "client.replaceSmartObject", "client.setSmartFilter",
    "client.setLayerFillOpacity", "client.setLayerLocks", "client.setLayerClipping",
    "client.invertSelection", "client.expandSelection", "client.contractSelection",
    "client.borderSelection", "client.addAlphaChannel", "client.addDocumentPath",
    "client.selectChannel", "client.selectPath",
    "client.undo", "client.redo", "client.render", "client.save"]) {
    assert.ok(script.includes(method), `${method} is not wired`);
  }
  assert.match(script, /from "\.\/engine\/client\.mjs"/);
  assert.match(script, /new URL\("\.\/engine\/worker\.mjs", import\.meta\.url\)/);
  assert.match(script, /new URL\("\.\/patchy-engine\.mjs", location\.href\)/);
  assert.match(script, /const commandRegistry = new Map\(\)/);
  assert.match(script, /registerCommand\("selection\.all"/);
  assert.match(script, /registerCommand\("tool\.clone"/);
  assert.match(script, /registerCommand\("tool\.gradient"/);
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
    _patchy_engine_get_protocol_info(info) {
      assert.equal(view.getUint32(info, true), 16);
      view.setUint32(info + 4, 1, true);
      view.setBigUint64(info + 8, (1n << 26n) - 1n, true);
      return 1;
    },
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
      view.setBigUint64(output, 7n, true); view.setUint32(output + 16, 3, true);
      heap[output + 20] = 1; view.setFloat32(output + 24, 1, true);
      view.setUint32(output + 28, 5, true); heap.set(new TextEncoder().encode("Layer"), output + 32);
      view.setFloat32(output + 292, 1, true); view.setInt32(output + 312, 3, true);
      view.setInt32(output + 316, 2, true); return 1;
    },
    _patchy_engine_session_layer_mask(session, layerId, output) {
      assert.equal(layerId, 7n); view.setUint32(output, 24, true); return 1;
    },
    _patchy_engine_session_channel_count(session, output) { view.setUint32(output, 1, true); return 1; },
    _patchy_engine_session_channel_at(session, index, output) {
      assert.equal(index, 0); view.setBigUint64(output, 31n, true); view.setUint32(output + 8, 0, true);
      view.setUint32(output + 12, 5, true); heap.set(new TextEncoder().encode("Alpha"), output + 16); return 1;
    },
    _patchy_engine_session_path_count(session, output) { view.setUint32(output, 1, true); return 1; },
    _patchy_engine_session_path_at(session, index, output) {
      assert.equal(index, 0); view.setBigUint64(output, 41n, true); view.setUint32(output + 8, 0, true);
      view.setUint32(output + 12, 4, true); heap.set(new TextEncoder().encode("Path"), output + 16);
      view.setUint32(output + 272, 1, true); view.setUint32(output + 276, 4, true); return 1;
    },
    _patchy_engine_session_text(session, layerId, output) {
      assert.equal(layerId, 7n); assert.equal(view.getUint32(output, true), 1312);
      const value = new TextEncoder().encode("Hello"); const font = new TextEncoder().encode("Arial");
      view.setUint32(output + 4, value.length, true); heap.set(value, output + 8);
      view.setUint32(output + 1032, font.length, true); heap.set(font, output + 1036);
      view.setFloat64(output + 1296, 18, true); heap.set([10, 20, 30, 1, 0, 1], output + 1304);
      return 1;
    },
    _patchy_engine_session_selection(session, output) {
      assert.equal(session, 22); assert.equal(view.getUint32(output, true), 32);
      view.setUint32(output + 4, 0, true); heap[output + 29] = 1; return 1;
    },
    _patchy_engine_session_selection_rect_at() { throw new Error("no selection rectangles expected"); },
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
    _patchy_engine_session_set_selection(session, input) {
      assert.equal(view.getUint32(input, true), 32);
      assert.equal(view.getUint32(input + 28, true), 1);
      const rect = view.getUint32(input + 24, true);
      assert.deepEqual([view.getInt32(rect, true), view.getInt32(rect + 4, true),
        view.getInt32(rect + 8, true), view.getInt32(rect + 12, true)], [0, 0, 2, 1]);
      return 1;
    },
    _patchy_engine_session_set_layer_mask(session, input) {
      assert.equal(view.getUint32(input, true), 72);
      assert.equal(view.getBigUint64(input + 24, true), 7n);
      assert.equal(heap[input + 67], 1);
      return 1;
    },
    _patchy_engine_session_layer_mask_pixels(session, layerId, output) {
      const data = alloc(2); heap.set([0, 255], data);
      view.setUint32(output, data, true); view.setUint32(output + 4, 2, true); return 1;
    },
    _patchy_engine_session_layer_rgba8_pixels(session, layerId, output) {
      const data = alloc(4); heap.set([1, 2, 3, 4], data);
      view.setUint32(output, data, true); view.setUint32(output + 4, 4, true); return 1;
    },
    _patchy_engine_session_replace_rgba8_layer(session, input) {
      assert.equal(view.getBigUint64(input + 24, true), 7n); return 1;
    },
    _patchy_engine_session_replace_rgba8_layer_and_mask(session, input, maskInput) {
      assert.equal(view.getBigUint64(input + 24, true), 7n);
      assert.equal(view.getBigUint64(maskInput + 24, true), 7n); return 1;
    },
    _patchy_engine_session_add_text_layer(session, input) {
      assert.equal(view.getUint32(input, true), 96);
      assert.equal(view.getFloat64(input + 80, true), 12); return 1;
    },
    _patchy_engine_session_update_text_layer(session, layerId, input) {
      assert.equal(layerId, 7n); assert.equal(heap[input + 91], 1); return 1;
    },
    _patchy_engine_session_set_adjustment(session, input) {
      assert.equal(view.getUint32(input, true), 88); assert.equal(view.getUint32(input + 40, true), 7); return 1;
    },
    _patchy_engine_session_add_vector_shape(session, input) {
      assert.equal(view.getUint32(input, true), 64); assert.equal(view.getUint32(input + 36, true), 1); return 1;
    },
    _patchy_engine_session_update_vector_shape(session, layerId, input) {
      assert.equal(layerId, 7n); assert.equal(view.getUint32(input + 36, true), 1); return 1;
    },
    _patchy_engine_session_set_vector_mask(session, input) {
      assert.equal(view.getBigUint64(input + 24, true), 7n); assert.equal(heap[input + 61], 1); return 1;
    },
    _patchy_engine_session_add_smart_object(session, input) {
      assert.equal(view.getUint32(input, true), 112); assert.equal(view.getUint32(input + 84, true), 4); return 1;
    },
    _patchy_engine_session_replace_smart_object(session, layerId, input) {
      assert.equal(layerId, 7n); assert.equal(view.getUint32(input + 84, true), 4); return 1;
    },
    _patchy_engine_session_set_smart_filter(session, input) {
      assert.equal(view.getUint32(input + 32, true), 1); assert.equal(view.getFloat64(input + 40, true), 4); return 1;
    },
    _patchy_engine_session_add_alpha_channel(session, input) {
      assert.equal(view.getUint32(input, true), 40); assert.equal(view.getUint32(input + 28, true), 6); return 1;
    },
    _patchy_engine_session_add_document_path(session, input) {
      assert.equal(view.getUint32(input, true), 56); assert.equal(view.getUint32(input + 44, true), 1); return 1;
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
  assert.equal(engine.capabilities, (1n << 26n) - 1n);
  const session = engine.create(3, 2);
  const snapshot = engine.snapshot(session);
  assert.equal(snapshot.layers[0].name, "Layer");
  assert.equal(snapshot.layers[0].bounds.width, 3);
  assert.deepEqual(snapshot.layers[0].text, { value: "Hello", font: "Arial", sizePixels: 18,
    color: [10, 20, 30], bold: true, italic: false, boxText: true });
  assert.deepEqual(snapshot.selection, []);
  assert.deepEqual(snapshot.channels, [{ id: 31n, kind: 0, name: "Alpha" }]);
  assert.deepEqual(snapshot.paths, [{ id: 41n, kind: 0, name: "Path", subpathCount: 1,
    anchorCount: 4, clipping: false }]);
  engine.setLayerVisibility(session, snapshot, 7n, false);
  engine.setLayerOpacity(session, snapshot, 7n, 0.5);
  engine.setLayerFillOpacity(session, snapshot, 7n, 0.75);
  engine.setLayerLocks(session, snapshot, 7n, 7);
  engine.setLayerClipping(session, snapshot, 7n, true);
  engine.setLayerBlendMode(session, snapshot, 7n, 2);
  engine.renameLayer(session, snapshot, 7n, "Renamed");
  engine.removeLayer(session, snapshot, 7n);
  engine.resizeImage(session, snapshot, 6, 4);
  engine.resizeCanvas(session, snapshot, 8, 6);
  engine.rotateCanvas(session, snapshot, 90);
  engine.cropDocument(session, snapshot, { x: 1, y: 1, width: 4, height: 3 });
  engine.setSelection(session, snapshot, [{ x: 0, y: 0, width: 2, height: 1 }]);
  engine.modifySelection(session, snapshot, 20, 4);
  engine.selectChannel(session, snapshot, 31n);
  engine.selectPath(session, snapshot, 41n, 0, 0, true);
  engine.addAlphaChannel(session, snapshot, { name: "Alpha", gray: new Uint8Array(6).fill(255) });
  engine.setLayerMask(session, snapshot, 7n, { bounds: { x: 0, y: 0, width: 2, height: 1 },
    gray: new Uint8Array([255, 0]), defaultColor: 0, linked: true });
  assert.deepEqual(Array.from(engine.layerMaskPixels(session, 7n)), [0, 255]);
  assert.deepEqual(Array.from(engine.layerPixels(session, 7n)), [1, 2, 3, 4]);
  engine.replacePixelLayer(session, snapshot, 7n, { name: "Layer", width: 1, height: 1,
    bounds: { x: 1, y: 1, width: 1, height: 1 }, rgba: new Uint8Array([1, 2, 3, 4]) });
  engine.replacePixelLayerAndMask(session, snapshot, 7n,
    { name: "Layer", width: 1, height: 1, bounds: { x: 1, y: 1, width: 1, height: 1 },
      rgba: new Uint8Array([1, 2, 3, 4]) },
    { width: 1, height: 1, bounds: { x: 1, y: 1, width: 1, height: 1 },
      gray: new Uint8Array([255]), defaultColor: 0, disabled: false });
  const textInput = { name: "Text", text: "Hi", font: "Arial", sizePixels: 12,
    color: [1, 2, 3], bold: true, italic: false, boxText: true, width: 1, height: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, rgba: new Uint8Array([1, 2, 3, 4]) };
  engine.addTextLayer(session, snapshot, textInput);
  engine.updateTextLayer(session, snapshot, 7n, textInput);
  engine.addAdjustment(session, snapshot, { name: "Brightness", kind: 7, values: [10, 5] });
  engine.updateAdjustment(session, snapshot, 7n, { kind: 7, values: [20, 10] });
  const path = { anchors: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] };
  engine.addDocumentPath(session, snapshot, { name: "Path", kind: 0, path });
  engine.addVectorShape(session, snapshot, { name: "Shape", path, fill: [1, 2, 3],
    strokeEnabled: true, stroke: [4, 5, 6], strokeWidth: 2 });
  engine.updateVectorShape(session, snapshot, 7n, { name: "Shape", path, fill: [1, 2, 3],
    strokeEnabled: false, stroke: [4, 5, 6], strokeWidth: 0 });
  engine.setVectorMask(session, snapshot, 7n, { path, density: 255 });
  engine.addSmartObject(session, snapshot, { name: "Embedded", filename: "asset.png", filetype: "PNG ",
    width: 1, height: 1, bounds: { x: 0, y: 0, width: 1, height: 1 },
    rgba: new Uint8Array([1, 2, 3, 4]), sourceBytes: new Uint8Array([5, 6, 7, 8]) });
  engine.replaceSmartObject(session, snapshot, 7n, { name: "Replaced", filename: "new.png", filetype: "PNG ",
    width: 1, height: 1, bounds: { x: 0, y: 0, width: 1, height: 1 },
    rgba: new Uint8Array([1, 2, 3, 4]), sourceBytes: new Uint8Array([5, 6, 7, 8]) });
  engine.setSmartFilter(session, snapshot, 7n, { kind: 1, amount: 4 });
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
  assert.deepEqual(commandTypes, [2, 3, 6, 7, 4, 5, 9, 10, 11, 12, 13, 20, 23, 28, 16]);
  assert.equal(engine.render(session, { x: 0, y: 0, width: 3, height: 2 }).byteLength, 24);
  assert.deepEqual(Array.from(engine.save(session)), [56, 66, 80, 83]);
  assert.equal(released, 4);
  engine.dispose();
  assert.equal(destroyed, 2);
});

function projection(revision, visible = true, mask = null, selection = []) {
  return {
    width: 3, height: 2, colorMode: 3, bitDepth: 8, channels: 4,
    activeLayerId: 7n, revision: BigInt(revision), stateId: BigInt(revision),
    layerCount: 1, hasActiveLayer: true, dirty: revision > 1,
    canUndo: revision > 1, canRedo: false,
    layers: [{ id: 7n, parentId: 0n, kind: 0, visible, opacity: 1,
      name: "Layer", clipped: false, fillOpacity: 1, blendMode: 0,
      lockFlags: 0, bounds: { x: 0, y: 0, width: 3, height: 2 }, mask, text: null }],
    selection, channels: [], paths: [],
  };
}

test("worker host runs the minimal browser editing vertical workflow", async () => {
  let revision = 1;
  let visible = true;
  let selection = [];
  let mask = null;
  let maskPixels = new Uint8Array();
  const calls = [];
  const engine = {
    capabilities: (1n << 26n) - 1n,
    create(width, height) { calls.push(["create", width, height]); return 41; },
    snapshot(session) { assert.equal(session, 41); return projection(revision, visible, mask, selection); },
    setLayerVisibility(session, before, layerId, next) {
      calls.push(["visibility", before.revision, layerId, next]);
      visible = next; revision++;
    },
    moveLayer(session, before, layerId, target, position) {
      calls.push(["move", before.revision, layerId, target, position]); revision++;
    },
    setLayerOpacity(session, before, layerId, opacity) { calls.push(["opacity", layerId, opacity]); revision++; },
    setLayerFillOpacity(session, before, layerId, opacity) { calls.push(["fillOpacity", layerId, opacity]); revision++; },
    setLayerLocks(session, before, layerId, flags) { calls.push(["locks", layerId, flags]); revision++; },
    setLayerClipping(session, before, layerId, clipped) { calls.push(["clipping", layerId, clipped]); revision++; },
    setLayerBlendMode(session, before, layerId, mode) { calls.push(["blend", layerId, mode]); revision++; },
    renameLayer(session, before, layerId, name) { calls.push(["rename", layerId, name]); revision++; },
    removeLayer(session, before, layerId) { calls.push(["remove", layerId]); revision++; },
    resizeImage(session, before, width, height) { calls.push(["resizeImage", width, height]); revision++; },
    resizeCanvas(session, before, width, height, anchor) { calls.push(["resizeCanvas", width, height, anchor]); revision++; },
    rotateCanvas(session, before, degrees) { calls.push(["rotate", degrees]); revision++; },
    cropDocument(session, before, crop) { calls.push(["crop", crop]); revision++; },
    setSelection(session, before, rects) { calls.push(["selection", rects]); selection = rects; revision++; },
    modifySelection(session, before, type, pixels) { calls.push(["modifySelection", type, pixels]); revision++; },
    selectChannel(session, before, id) { calls.push(["selectChannel", id]); revision++; },
    selectPath(session, before, id) { calls.push(["selectPath", id]); revision++; },
    addAlphaChannel(session, before, input) { calls.push(["alpha", input.gray.byteLength]); revision++; },
    addDocumentPath(session, before, input) { calls.push(["path", input.path.anchors.length]); revision++; },
    setLayerMask(session, before, layerId, next) {
      calls.push(["mask", layerId, next]);
      mask = next ? { bounds: next.bounds, defaultColor: next.defaultColor,
        disabled: next.disabled, linked: next.linked } : null;
      maskPixels = next?.gray?.slice() || new Uint8Array(); revision++;
    },
    layerMaskPixels() { return maskPixels.slice(); },
    layerPixels() { return new Uint8Array(24).fill(9); },
    replacePixelLayer(session, before, layerId, input) {
      calls.push(["replacePixels", layerId, input.bounds]); revision++;
    },
    replacePixelLayerAndMask(session, before, layerId, input, nextMask) {
      calls.push(["replacePixelsAndMask", layerId, input.bounds, nextMask.bounds]); revision++;
    },
    addTextLayer(session, before, input) { calls.push(["addText", input.text]); revision++; },
    updateTextLayer(session, before, layerId, input) {
      calls.push(["updateText", layerId, input.text]); revision++;
    },
    addAdjustment(session, before, input) { calls.push(["addAdjustment", input.kind]); revision++; },
    updateAdjustment(session, before, layerId, input) { calls.push(["updateAdjustment", layerId, input.kind]); revision++; },
    addVectorShape(session, before, input) { calls.push(["shape", input.path.anchors.length]); revision++; },
    updateVectorShape(session, before, layerId, input) { calls.push(["updateShape", layerId, input.path.anchors.length]); revision++; },
    setVectorMask(session, before, layerId, input) { calls.push(["vectorMask", layerId, input]); revision++; },
    addSmartObject(session, before, input) { calls.push(["smartObject", input.sourceBytes.byteLength]); revision++; },
    replaceSmartObject(session, before, layerId, input) { calls.push(["replaceSmartObject", layerId, input.sourceBytes.byteLength]); revision++; },
    setSmartFilter(session, before, layerId, input) { calls.push(["smartFilter", layerId, input.kind]); revision++; },
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
  await host.dispatch({ method: "setLayerFillOpacity", layerId: "7", opacity: 0.75 });
  await host.dispatch({ method: "setLayerLocks", layerId: "7", lockFlags: 7 });
  await host.dispatch({ method: "setLayerClipping", layerId: "7", clipped: true });
  await host.dispatch({ method: "setLayerBlendMode", layerId: "7", blendMode: 2 });
  await host.dispatch({ method: "renameLayer", layerId: "7", name: "Renamed" });
  await host.dispatch({ method: "removeLayer", layerId: "7" });
  await host.dispatch({ method: "resizeImage", width: 6, height: 4 });
  await host.dispatch({ method: "resizeCanvas", width: 8, height: 6, anchor: 4 });
  await host.dispatch({ method: "rotateCanvas", clockwiseDegrees: 90 });
  await host.dispatch({ method: "cropDocument", crop: { x: 1, y: 1, width: 4, height: 3 } });
  await host.dispatch({ method: "setSelection", rects: [{ x: 0, y: 0, width: 1, height: 1 }] });
  await host.dispatch({ method: "modifySelection", type: 20, pixels: 4 });
  await host.dispatch({ method: "addAlphaChannel", name: "Alpha 1" });
  await host.dispatch({ method: "addDocumentPath", input: { path: { anchors: [{}, {}, {}] } } });
  await host.dispatch({ method: "selectChannel", channelId: "3" });
  await host.dispatch({ method: "selectPath", pathId: "4", feather: 0, combine: 0, antialias: true });
  assert.equal((await host.dispatch({ method: "createLayerMask", layerId: "7" })).layers[0].mask.defaultColor, 0);
  assert.equal((await host.dispatch({ method: "toggleLayerMask", layerId: "7" })).layers[0].mask.disabled, true);
  await host.dispatch({ method: "invertLayerMask", layerId: "7" });
  assert.equal(maskPixels[0], 0);
  assert.equal((await host.dispatch({ method: "removeLayerMask", layerId: "7" })).layers[0].mask, null);
  assert.equal((await host.dispatch({ method: "layerPixels", layerId: "7" })).byteLength, 24);
  mask = { bounds: { x: 0, y: 0, width: 3, height: 2 }, defaultColor: 0,
    disabled: false, linked: true };
  maskPixels = new Uint8Array(6).fill(255);
  assert.equal((await host.dispatch({ method: "layerMaskPixels", layerId: "7" })).byteLength, 6);
  await host.dispatch({ method: "replacePixelLayer", layerId: "7", name: "Layer",
    width: 3, height: 2, bounds: { x: 1, y: 1, width: 3, height: 2 },
    rgba: new Uint8Array(24).buffer });
  await host.dispatch({ method: "replacePixelLayerAndMask", layerId: "7",
    input: { name: "Layer", width: 3, height: 2, bounds: { x: 1, y: 1, width: 3, height: 2 },
      rgba: new Uint8Array(24).buffer },
    mask: { width: 3, height: 2, bounds: { x: 1, y: 1, width: 3, height: 2 },
      gray: new Uint8Array(6).buffer, defaultColor: 0, disabled: false } });
  const browserText = { name: "Text", text: "Browser", font: "Arial", sizePixels: 20,
    color: [0, 0, 0], bold: false, italic: false, boxText: true, width: 1, height: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, rgba: new Uint8Array(4).buffer };
  await host.dispatch({ method: "addTextLayer", input: browserText });
  await host.dispatch({ method: "updateTextLayer", layerId: "7", input: browserText });
  await host.dispatch({ method: "addAdjustment", input: { kind: 7, values: [1, 2] } });
  await host.dispatch({ method: "updateAdjustment", layerId: "7", input: { kind: 7, values: [3, 4] } });
  const browserPath = { anchors: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] };
  await host.dispatch({ method: "addVectorShape", input: { path: browserPath } });
  await host.dispatch({ method: "updateVectorShape", layerId: "7", input: { path: browserPath } });
  await host.dispatch({ method: "setVectorMask", layerId: "7", input: { path: browserPath } });
  await host.dispatch({ method: "addSmartObject", input: { rgba: new Uint8Array(4).buffer,
    sourceBytes: new Uint8Array(8).buffer } });
  await host.dispatch({ method: "replaceSmartObject", layerId: "7", input: { rgba: new Uint8Array(4).buffer,
    sourceBytes: new Uint8Array(8).buffer } });
  await host.dispatch({ method: "setSmartFilter", layerId: "7", input: { kind: 1, amount: 4 } });
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
  worker.reply({ id: 1, ok: true, value: { capabilities: (1n << 26n) - 1n } });
  await init;
  assert.equal(client.state, "ready");
  assert.equal(client.capabilities, (1n << 26n) - 1n);
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
