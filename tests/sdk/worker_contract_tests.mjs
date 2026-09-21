import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PatchyWorkerHost } from "../../sdk/engine/worker-host.mjs";
import { PatchyWorkerClient } from "../../sdk/engine/client.mjs";
import { EmscriptenPatchyEngine } from "../../sdk/engine/module-adapter.mjs";
import { browserWorkingSetLimit, chooseRenderRegion, documentPreflight, MIB } from "../../sdk/engine/memory-policy.mjs";
import { createRenderFrame } from "../../sdk/engine/frame-transport.mjs";
import { createPsdBlob, inspectPsdBlob, MAX_BROWSER_SOURCE_BYTES, parsePsdHeader,
  readBlobInput } from "../../sdk/engine/blob-ingress.mjs";

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
  const worker = await readFile(new URL("sdk/engine/worker.mjs", root), "utf8");
  const types = await readFile(new URL("sdk/engine/index.d.ts", root), "utf8");
  const nodeServer = await readFile(new URL("scripts/wasm/serve.mjs", root), "utf8");
  const pythonServer = await readFile(new URL("scripts/wasm/serve.py", root), "utf8");
  for (const id of ["openButton", "fileInput", "imageInput", "documentCanvas", "documentTabs", "layerList",
    "exportFormatSelect", "exportButton", "copyPixelsButton", "pastePixelsButton", "paintPresetSelect",
    "importLayerButton", "groupLayerButton", "removeLayerButton", "layerNameInput",
    "layerOpacityInput", "layerBlendSelect", "invertLayerButton", "transformButton",
    "documentDialog", "resizeImageButton", "resizeCanvasButton", "rotateLeftButton",
    "rotateRightButton", "cropButton", "busyProgress", "cancelOperationButton",
    "canvasFrame", "selectionOverlay", "marqueeToolButton", "panToolButton",
    "zoomOutButton", "zoomFitButton", "zoomInButton", "createMaskButton",
    "toggleMaskButton", "invertMaskButton", "removeMaskButton",
    "gestureCanvas", "transformOverlay", "moveToolButton", "brushToolButton",
    "lassoToolButton", "polygonToolButton", "magicToolButton", "selectionToleranceInput",
    "eraserToolButton", "textToolButton", "textLayerButton", "layerTransformButton",
    "textDialog", "textFontInput", "fontPresetList", "commitTextButton", "layerTransformDialog", "commitLayerTransformButton",
    "shapeLayerButton", "adjustmentLayerButton", "smartObjectButton", "openSmartObjectButton", "smartFilterButton",
    "filterLayerButton", "filterDialog", "filterKindInput", "filterParameterFields", "commitFilterButton",
    "adjustmentParameterFields",
    "cloneToolButton", "healToolButton", "gradientToolButton", "fillToolButton",
    "layerFillInput", "layerClipInput", "layerLockInput", "layerStyleSelect",
    "applyLayerStyleButton", "invertSelectionButton",
    "expandSelectionButton", "contractSelectionButton", "borderSelectionButton",
    "growSelectionButton", "similarSelectionButton", "smoothSelectionButton", "featherSelectionButton",
    "saveChannelButton", "savePathButton", "channelList", "pathList",
    "rasterizeLayerButton", "mergeVisibleButton", "channelRenameButton",
    "channelInvertButton", "channelUpButton", "channelDownButton", "channelDeleteButton",
    "pathRenameButton", "pathClipButton", "pathUpButton", "pathDownButton",
    "pathDeleteButton", "pathAnchorXInput", "pathAnchorYInput", "pathAnchorApplyButton",
    "createVectorMaskButton", "smartObjectInput", "shapeDialog", "commitShapeButton",
    "adjustmentDialog", "commitAdjustmentButton", "smartFilterDialog", "commitSmartFilterButton",
    "undoButton", "redoButton", "saveButton", "errorBanner", "recoveryButton",
    "recoveryCount", "recoveryLabel", "recoveryDialog", "recoveryList", "recoveryQuota",
    "cleanupRecoveryButton", "memoryLabel", "memoryBudgetSelect"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const method of ["client.open", "client.activateDocument", "client.closeDocument",
    "client.copyLayerToDocument",
    "client.setLayerVisibility",
    "client.moveLayer", "client.addPixelLayer", "client.groupLayer", "client.removeLayer",
    "client.renameLayer", "client.setLayerOpacity", "client.setLayerBlendMode",
    "client.resizeImage", "client.resizeCanvas", "client.rotateCanvas",
    "client.cropDocument", "client.invertLayer",
    "client.setSelection", "client.setSelectionMask", "client.clearSelection", "client.createLayerMask",
    "client.toggleLayerMask", "client.invertLayerMask", "client.removeLayerMask",
    "client.layerPixels", "client.replacePixelLayer", "client.previewLayerTransform",
    "client.transformLayer", "client.previewRasterStroke", "client.applyRasterStroke",
    "client.addTextLayer",
    "client.updateTextLayer", "client.addVectorShape", "client.setVectorMask",
    "client.updateVectorShape",
    "client.addAdjustment", "client.updateAdjustment", "client.addSmartObject",
    "client.replaceSmartObject", "client.openSmartObjectContents", "client.applyFilter",
    "client.saveSmartObjectContents", "client.setSmartFilter",
    "client.setLayerFillOpacity", "client.setLayerLocks", "client.setLayerClipping",
    "client.setLayerStylePreset",
    "client.invertSelection", "client.expandSelection", "client.contractSelection",
    "client.borderSelection", "client.growSelection", "client.selectSimilar",
    "client.addAlphaChannel", "client.addDocumentPath",
    "client.selectChannel", "client.selectPath",
    "client.renameChannel", "client.invertChannel", "client.removeChannel", "client.moveChannel",
    "client.renamePath", "client.removePath", "client.movePath", "client.setClippingPath",
    "client.updateDocumentPath", "client.rasterizeLayer", "client.mergeVisibleCopy",
    "client.undo", "client.redo", "client.renderFrame", "client.saveBlob", "client.saveDocument",
    "client.setMemoryBudget", "client.openBlob", "client.inspectBlob", "client.placePsdSmartObject"]) {
    assert.ok(script.includes(method), `${method} is not wired`);
  }
  const rasterPreviewFlow = script.slice(script.indexOf("function rasterStrokePayload"),
    script.indexOf("async function fillSelectedPixels"));
  const rasterCommitFlow = script.slice(script.indexOf("function movePaint"),
    script.indexOf("function escapeHtml"));
  assert.doesNotMatch(`${rasterPreviewFlow}\n${rasterCommitFlow}`,
    /client\.(?:layerPixels|replacePixelLayer)/);
  assert.match(rasterPreviewFlow, /client\.previewRasterStroke/);
  assert.match(rasterCommitFlow, /client\.applyRasterStroke/);
  assert.match(script, /from "\.\/engine\/client\.mjs"/);
  assert.match(script, /from "\.\/engine\/workspace-store\.mjs"/);
  assert.match(script, /new URL\("\.\/engine\/worker\.mjs", import\.meta\.url\)/);
  assert.match(script, /recoverWorkerSession/);
  assert.match(worker, /method === "renderFrame"/);
  assert.match(worker, /method === "openBlob"/);
  assert.match(worker, /method === "inspectBlob"/);
  assert.match(worker, /method === "placePsdSmartObject"/);
  assert.match(worker, /method === "saveBlob"/);
  assert.match(worker, /createRenderFrame\(bytes, payload\.region\)/);
  assert.match(script, /context\.drawImage\(frame\.bitmap/);
  assert.match(script, /frame\.bitmap\.close\(\)/);
  assert.match(script, /transferOwnership: true/);
  assert.match(script, /loadPreferences/);
  assert.match(script, /cleanupRecoveryWorkspaces/);
  assert.match(script, /new URL\("\.\/patchy-engine\.mjs", location\.href\)/);
  assert.match(script, /const commandRegistry = new Map\(\)/);
  assert.match(script, /registerCommand\("selection\.all"/);
  assert.match(script, /registerCommand\("tool\.clone"/);
  assert.match(script, /registerCommand\("tool\.gradient"/);
  assert.match(script, /registerCommand\("document\.export"/);
  assert.match(script, /navigator\.clipboard/);
  assert.match(script, /application\/x-patchy-layer/);
  assert.match(script, /draggable = true/);
  assert.match(script, /fullSelectionMask\(\)/);
  assert.match(html, /image\/svg\+xml/);
  assert.match(html, /SVG \(flattened\)/);
  for (const preset of ["foreground-transparent", "black-white", "sunset", "ocean", "checker", "dots"]) {
    assert.match(html, new RegExp(`value="${preset}"`));
  }
  for (const contract of ["selectionMask:", "documentId:", "documents:", "setSelectionMask(",
    "activateDocument(", "closeDocument(", "saveDocument(", "openSmartObjectContents(",
    "saveSmartObjectContents(", "placePsdSmartObject(", "contentsEditable:", "growSelection(", "selectSimilar(", "setLayerStylePreset("]) {
    assert.ok(types.includes(contract), `TypeScript declaration misses ${contract}`);
  }
  assert.match(types, /addStateListener\(listener:/);
  assert.match(types, /interface TransferOptions \{ transferOwnership\?: boolean \}/);
  assert.doesNotMatch(`${html}\n${css}\n${script}`, /https?:\/\//);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /\.document-actions \{ gap: 5px; overflow-x: auto;/);
  assert.match(css, /\.inspector \{ min-width: 0; min-height: 0;[^}]+display: block; overflow-y: auto;/);
  assert.match(html, /role="alert"/);
  assert.match(nodeServer, /'\.css': 'text\/css; charset=utf-8'/);
  assert.match(pythonServer, /"\.css": "text\/css; charset=utf-8"/);
});

test("Worker Blob ingress validates before allocation and returns exact owned bytes", async () => {
  const bytes = await readBlobInput(new Blob([new Uint8Array([1, 2, 3])]));
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.ok(bytes.buffer instanceof ArrayBuffer);
  await assert.rejects(readBlobInput(new Blob([])), /empty/);
  await assert.rejects(readBlobInput(new Blob([new Uint8Array(5)]), 4), /exceeds/);
  await assert.rejects(readBlobInput({ size: 2, async arrayBuffer() {
    return new ArrayBuffer(1);
  }}), /changed/);
  assert.equal(MAX_BROWSER_SOURCE_BYTES, 1024 * 1024 * 1024);
});

function psdHeader({ version = 1, width = 10000, height = 10000,
  channels = 4, depth = 8, colorMode = 3 } = {}) {
  const bytes = new Uint8Array(26); bytes.set([56, 66, 80, 83]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, version, false); view.setUint16(12, channels, false);
  view.setUint32(14, height, false); view.setUint32(18, width, false);
  view.setUint16(22, depth, false); view.setUint16(24, colorMode, false);
  return bytes;
}

test("bounded PSD header inspection enables dimension-aware 500 MiB admission", async () => {
  const headerBytes = psdHeader();
  const parsed = parsePsdHeader(headerBytes, 500 * MIB);
  assert.deepEqual(parsed, { version: 1, width: 10000, height: 10000,
    channels: 4, depth: 8, colorMode: 3, sourceBytes: 500 * MIB });
  assert.equal(documentPreflight({ ...parsed, limitBytes: 3 * 1024 * MIB }).allowed, true);
  assert.equal(documentPreflight({ sourceBytes: 500 * MIB,
    limitBytes: 3 * 1024 * MIB }).allowed, false);
  assert.deepEqual(await inspectPsdBlob(new Blob([headerBytes])), {
    ...parsed, sourceBytes: 26,
  });
  assert.throws(() => parsePsdHeader(psdHeader({ width: 30001 }), 26), /dimensions/);
  const hostile = psdHeader(); hostile[0] = 0;
  assert.throws(() => parsePsdHeader(hostile, 26), /not a PSD/);
});

test("Worker PSD output Blob validates encoded bytes and retains no Uint8Array field", async () => {
  const encoded = new Uint8Array(40); encoded.set(psdHeader({ width: 2, height: 3 }));
  const blob = createPsdBlob(encoded);
  assert.equal(blob.type, "image/vnd.adobe.photoshop");
  assert.equal(blob.size, encoded.byteLength);
  assert.deepEqual([...new Uint8Array(await blob.slice(0, 4).arrayBuffer())], [56, 66, 80, 83]);
  assert.throws(() => createPsdBlob(new Uint8Array(26)), /not a PSD/);
});

test("Worker frame transport transfers ImageBitmap without exposing RGBA bytes", () => {
  const bitmap = { close() {} };
  let imageData;
  class FakeImageData {
    constructor(pixels, width, height) {
      Object.assign(this, { pixels, width, height }); imageData = this;
    }
  }
  class FakeOffscreenCanvas {
    constructor(width, height) { assert.deepEqual([width, height], [2, 1]); }
    getContext(kind, options) {
      assert.equal(kind, "2d"); assert.deepEqual(options, { alpha: true });
      return { putImageData(value, x, y) {
        assert.equal(value, imageData); assert.deepEqual([x, y], [0, 0]);
      } };
    }
    transferToImageBitmap() { return bitmap; }
  }
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const frame = createRenderFrame(bytes, { width: 2, height: 1 }, {
    ImageData: FakeImageData, OffscreenCanvas: FakeOffscreenCanvas,
  });
  assert.deepEqual(frame.value, { kind: "bitmap", bitmap, width: 2, height: 1 });
  assert.deepEqual(frame.transfer, [bitmap]);
  assert.equal("bytes" in frame.value, false);
  assert.equal(imageData.pixels.buffer, bytes.buffer);
});

test("Worker frame transport falls back to one transferable RGBA buffer", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const unavailable = createRenderFrame(bytes, { width: 1, height: 1 }, {});
  assert.deepEqual(unavailable.value, { kind: "rgba", bytes, width: 1, height: 1 });
  assert.deepEqual(unavailable.transfer, [bytes.buffer]);
  class BrokenCanvas { getContext() { throw new Error("allocation failed"); } }
  const failed = createRenderFrame(bytes, { width: 1, height: 1 }, {
    ImageData: class {}, OffscreenCanvas: BrokenCanvas,
  });
  assert.equal(failed.value.kind, "rgba");
  assert.equal(failed.value.bytes, bytes);
  assert.throws(() => createRenderFrame(bytes, { width: 2, height: 1 }, {}),
    /expected 8/);
});

test("Emscripten adapter owns buffers and decodes wasm32 projections", () => {
  const memory = new SharedArrayBuffer(1 << 20);
  const heap = new Uint8Array(memory);
  const view = new DataView(memory);
  let next = 1024;
  let released = 0;
  let destroyed = 0;
  let callback = null;
  let projectedLayerKind = 3;
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
      view.setBigUint64(info + 8, (1n << 28n) - 1n, true);
      return 1;
    },
    _patchy_engine_runtime_create() { return 11; },
    _patchy_engine_runtime_destroy() { destroyed++; },
    addFunction(value, signature) { assert.ok(["iiii", "iiiii"].includes(signature)); callback = value; return 71; },
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
      view.setBigUint64(output, 7n, true); view.setUint32(output + 16, projectedLayerKind, true);
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
    _patchy_engine_session_path_subpath_at(session, pathId, index, output) {
      assert.equal(pathId, 41n); assert.equal(index, 0);
      view.setUint32(output, 4, true); view.setInt32(output + 4, 0, true);
      view.setUint32(output + 8, 1, true); heap[output + 12] = 1; return 1;
    },
    _patchy_engine_session_path_anchor_at(session, pathId, subpath, index, output) {
      assert.equal(pathId, 41n); assert.equal(subpath, 0);
      const x = index === 1 || index === 2 ? 3 : 0; const y = index >= 2 ? 2 : 0;
      for (const [offset, number] of [[0, x], [8, y], [16, x], [24, y], [32, x], [40, y]])
        view.setFloat64(output + offset, number, true);
      return 1;
    },
    _patchy_engine_session_text(session, layerId, output) {
      assert.equal(layerId, 7n); assert.equal(view.getUint32(output, true), 1312);
      const value = new TextEncoder().encode("Hello"); const font = new TextEncoder().encode("Arial");
      view.setUint32(output + 4, value.length, true); heap.set(value, output + 8);
      view.setUint32(output + 1032, font.length, true); heap.set(font, output + 1036);
      view.setFloat64(output + 1296, 18, true); heap.set([10, 20, 30, 1, 0, 1], output + 1304);
      return 1;
    },
    _patchy_engine_session_adjustment(session, layerId, output) {
      assert.equal(layerId, 7n); assert.equal(view.getUint32(output, true), 44);
      view.setUint32(output + 4, 1, true); view.setUint32(output + 40, 2, true); return 1;
    },
    _patchy_engine_session_adjustment_curve_point_at(session, layerId, index, output) {
      assert.equal(layerId, 7n); view.setInt32(output, index * 255, true);
      view.setInt32(output + 4, index * 255, true); return 1;
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
    _patchy_engine_session_set_selection_mask(session, input) {
      assert.equal(session, 22); assert.equal(view.getUint32(input, true), 56);
      assert.equal(view.getBigUint64(input + 8, true), 9n);
      assert.equal(view.getBigUint64(input + 16, true), 4n);
      assert.deepEqual([view.getInt32(input + 24, true), view.getInt32(input + 28, true),
        view.getInt32(input + 32, true), view.getInt32(input + 36, true)], [0, 0, 3, 2]);
      assert.deepEqual([view.getInt32(input + 40, true), view.getInt32(input + 44, true)], [3, 2]);
      assert.equal(view.getUint32(input + 52, true), 6);
      return 1;
    },
    _patchy_engine_session_group_layer(session, state, revision, layer, name, nameSize) {
      assert.deepEqual([session, state, revision, layer], [22, 9n, 4n, 7n]);
      assert.equal(new TextDecoder().decode(heap.subarray(name, name + nameSize)), "Group");
      return 1;
    },
    _patchy_engine_session_copy_layer(target, targetState, targetRevision,
        source, sourceState, sourceRevision, layerId) {
      assert.deepEqual([target, targetState, targetRevision, source, sourceState,
        sourceRevision, layerId], [22, 9n, 4n, 22, 9n, 4n, 7n]);
      return 1;
    },
    _patchy_engine_session_preview_layer_transform(session, state, revision,
        transform, progress, progressUserData, region, output) {
      assert.deepEqual([session, state, revision], [22, 9n, 4n]);
      assert.equal(view.getUint32(transform, true), 80);
      assert.equal(view.getUint32(transform + 4, true), 1);
      assert.equal(view.getBigUint64(transform + 8, true), 7n);
      assert.deepEqual(Array.from({ length: 8 }, (_, index) =>
        view.getFloat64(transform + 16 + index * 8, true)), [0, 0, 2, 0, 2, 2, 0, 2]);
      assert.equal(progress, 71); assert.equal(progressUserData, 0);
      callbackReturns.push(callback(1, 0, 0));
      [0, 0, 2, 2].forEach((value, index) => view.setInt32(region + index * 4, value, true));
      const data = alloc(16); heap.fill(127, data, data + 16);
      view.setUint32(output, data, true); view.setUint32(output + 4, 16, true);
      return 1;
    },
    _patchy_engine_session_transform_layer(session, state, revision, transform) {
      assert.deepEqual([session, state, revision], [22, 9n, 4n]);
      assert.equal(view.getBigUint64(transform + 8, true), 7n);
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
      const parameters = view.getUint32(input + 40, true);
      const parameterCount = view.getUint32(input + 44, true);
      if (parameterCount) {
        assert.equal(parameterCount, 4);
        assert.equal(new TextDecoder().decode(heap.subarray(parameters + 8, parameters + 14)), "amount");
        assert.equal(view.getBigInt64(parameters + 72, true), 75n);
        assert.equal(view.getFloat64(parameters + 208 + 72, true), 2.5);
        assert.equal(heap[parameters + 416 + 72], 1);
        assert.equal(view.getUint32(parameters + 624 + 72, true), 7);
        assert.equal(new TextDecoder().decode(heap.subarray(parameters + 624 + 76,
          parameters + 624 + 83)), "uniform");
      }
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
      const data = alloc(24); heap.fill(0, data, data + 24); heap.set([1, 2, 3, 4], data);
      view.setUint32(output, data, true); view.setUint32(output + 4, 24, true); return 1;
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
    _patchy_engine_session_smart_object_bytes(session, layerId, output) {
      assert.equal(layerId, 7n);
      const data = alloc(6); heap.set([56, 66, 80, 83, 1, 2], data);
      view.setUint32(output, data, true); view.setUint32(output + 4, 6, true); return 1;
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
    _patchy_engine_session_update_document_path(session, pathId, input) {
      assert.equal(pathId, 41n); assert.equal(view.getUint32(input + 44, true), 1); return 1;
    },
    _patchy_engine_session_merge_visible_copy(session, state, revision, name, nameSize) {
      assert.deepEqual([state, revision], [9n, 4n]);
      assert.equal(new TextDecoder().decode(heap.subarray(name, name + nameSize)), "Merged"); return 1;
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
    _patchy_engine_session_memory_usage(session, output) {
      assert.equal(view.getUint32(output, true), 128);
      for (let index = 0; index < 15; ++index) view.setBigUint64(output + 8 + index * 8, BigInt(index + 1), true);
      return 1;
    },
    _patchy_engine_session_pending_render_region(session, region, hasRegion) {
      view.setInt32(region, 1, true); view.setInt32(region + 4, 0, true);
      view.setInt32(region + 8, 2, true); view.setInt32(region + 12, 2, true);
      heap[hasRegion] = 1; return 1;
    },
    _patchy_engine_session_evict_oldest_undo(session, evicted) { heap[evicted] = 1; return 1; },
    _patchy_engine_buffer_release() { released++; },
    _patchy_engine_session_move_layer() { return 1; },
    _patchy_engine_session_undo() { return 1; },
    _patchy_engine_session_redo() { return 1; },
  };
  const engine = new EmscriptenPatchyEngine(module);
  assert.equal(engine.capabilities, (1n << 28n) - 1n);
  const session = engine.create(3, 2);
  const snapshot = engine.snapshot(session);
  assert.equal(snapshot.layers[0].name, "Layer");
  assert.equal(snapshot.layers[0].bounds.width, 3);
  assert.deepEqual(snapshot.layers[0].text, { value: "Hello", font: "Arial", sizePixels: 18,
    color: [10, 20, 30], bold: true, italic: false, boxText: true });
  projectedLayerKind = 2;
  assert.deepEqual(engine.snapshot(session).layers[0].adjustment.curvePoints,
    [{ input: 0, output: 0 }, { input: 255, output: 255 }]);
  projectedLayerKind = 3;
  assert.deepEqual(snapshot.selection, []);
  assert.deepEqual(snapshot.channels, [{ id: 31n, kind: 0, name: "Alpha" }]);
  assert.equal(snapshot.paths[0].id, 41n);
  assert.equal(snapshot.paths[0].subpaths[0].anchors.length, 4);
  assert.deepEqual(snapshot.paths[0].anchors[2],
    { x: 3, y: 2, inX: 3, inY: 2, outX: 3, outY: 2, smooth: false });
  assert.equal(engine.memoryUsage(session).totalRetainedBytes, 8);
  assert.equal(engine.memoryUsage(session).renderCacheEvictions, 15);
  assert.deepEqual(engine.pendingRenderRegion(session), { x: 1, y: 0, width: 2, height: 2 });
  assert.equal(engine.evictOldestUndo(session), true);
  assert.deepEqual(Array.from(engine.smartObjectBytes(session, 7n)), [56, 66, 80, 83, 1, 2]);
  engine.setLayerVisibility(session, snapshot, 7n, false);
  engine.setLayerOpacity(session, snapshot, 7n, 0.5);
  engine.setLayerFillOpacity(session, snapshot, 7n, 0.75);
  engine.setLayerLocks(session, snapshot, 7n, 7);
  engine.setLayerClipping(session, snapshot, 7n, true);
  engine.setLayerStylePreset(session, snapshot, 7n, "57a1e500-0015-4c6d-8f2a-9b3d4e55c015");
  engine.setLayerBlendMode(session, snapshot, 7n, 2);
  engine.renameLayer(session, snapshot, 7n, "Renamed");
  engine.removeLayer(session, snapshot, 7n);
  engine.resizeImage(session, snapshot, 6, 4);
  engine.resizeCanvas(session, snapshot, 8, 6);
  engine.rotateCanvas(session, snapshot, 90);
  engine.cropDocument(session, snapshot, { x: 1, y: 1, width: 4, height: 3 });
  engine.setSelection(session, snapshot, [{ x: 0, y: 0, width: 2, height: 1 }]);
  engine.setSelectionMask(session, snapshot, { bounds: { x: 0, y: 0, width: 3, height: 2 },
    gray: new Uint8Array([0, 64, 255, 255, 64, 0]) });
  engine.modifySelection(session, snapshot, 20, 4);
  engine.modifySelection(session, snapshot, 33, 32);
  engine.modifySelection(session, snapshot, 34, 32);
  engine.selectChannel(session, snapshot, 31n);
  engine.selectPath(session, snapshot, 41n, 0, 0, true);
  engine.renameChannel(session, snapshot, 31n, "Renamed channel");
  engine.invertChannel(session, snapshot, 31n);
  engine.removeChannel(session, snapshot, 31n);
  engine.moveChannel(session, snapshot, 31n, 0);
  engine.renamePath(session, snapshot, 41n, "Renamed path");
  engine.removePath(session, snapshot, 41n);
  engine.movePath(session, snapshot, 41n, 0);
  engine.setClippingPath(session, snapshot, 41n, true);
  engine.addAlphaChannel(session, snapshot, { name: "Alpha", gray: new Uint8Array(6).fill(255) });
  engine.setLayerMask(session, snapshot, 7n, { bounds: { x: 0, y: 0, width: 2, height: 1 },
    gray: new Uint8Array([255, 0]), defaultColor: 0, linked: true });
  assert.deepEqual(Array.from(engine.layerMaskPixels(session, 7n)), [0, 255]);
  assert.deepEqual(Array.from(engine.layerPixels(session, 7n).subarray(0, 4)), [1, 2, 3, 4]);
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
  engine.updateDocumentPath(session, snapshot, 41n, { name: "Path", kind: 0, path });
  engine.rasterizeLayer(session, snapshot, 7n);
  engine.mergeVisibleCopy(session, snapshot, "Merged");
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
  engine.copyLayerToSession(session, snapshot, session, snapshot, 7n);
  const transformQuad = [0, 0, 2, 0, 2, 2, 0, 2];
  const transformPreview = engine.previewLayerTransform(
    session, snapshot, 7n, transformQuad, 1);
  assert.deepEqual(transformPreview.region, { x: 0, y: 0, width: 2, height: 2 });
  assert.equal(transformPreview.rgba.byteLength, 16);
  engine.transformLayer(session, snapshot, 7n, transformQuad, 1);
  engine.ungroup(session, snapshot, 7n);
  engine.addPixelLayer(session, snapshot, { name: "Pixel", width: 1, height: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, rgba: new Uint8Array([1, 2, 3, 4]) });
  const progress = [];
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  assert.throws(() => engine.applyFilter(session, snapshot, 7n, null, [], cancellation),
    /identifier must be a string/);
  assert.throws(() => engine.applyFilter(session, snapshot, 7n, "patchy.filters.add_noise",
    [{ key: "distribution", kind: "option", value: 1 }], cancellation),
  /Option filter parameters require strings/);
  assert.throws(() => engine.applyFilter(session, snapshot, 7n, "patchy.filters.invert",
    [{ kind: "integer", value: 75 }], cancellation), /require string keys/);
  engine.applyFilter(session, snapshot, 7n, "patchy.filters.invert",
    [{ key: "amount", kind: "integer", value: 75 },
      { key: "radius", kind: "double", value: 2.5 },
      { key: "monochromatic", kind: "boolean", value: true },
      { key: "distribution", kind: "option", value: "uniform" }],
    cancellation, (value) => progress.push(value.ratio));
  assert.deepEqual(progress, [0.5, 1]);
  Atomics.store(cancellation, 0, 1);
  engine.applyFilter(session, snapshot, 7n, "patchy.filters.invert", [], cancellation);
  assert.deepEqual(callbackReturns, [1, 1, 1, 0, 0]);
  assert.deepEqual(commandTypes, [2, 3, 6, 7, 35, 4, 5, 9, 10, 11, 12, 13, 20, 33, 34, 23, 28,
    24, 25, 26, 27, 29, 30, 31, 32, 16]);
  assert.equal(engine.render(session, { x: 0, y: 0, width: 3, height: 2 }).byteLength, 24);
  assert.deepEqual(Array.from(engine.save(session)), [56, 66, 80, 83]);
  assert.equal(released, 7);
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
    setLayerStylePreset(session, before, layerId, presetId) {
      calls.push(["stylePreset", layerId, presetId]); revision++;
    },
    setLayerBlendMode(session, before, layerId, mode) { calls.push(["blend", layerId, mode]); revision++; },
    renameLayer(session, before, layerId, name) { calls.push(["rename", layerId, name]); revision++; },
    removeLayer(session, before, layerId) { calls.push(["remove", layerId]); revision++; },
    resizeImage(session, before, width, height) { calls.push(["resizeImage", width, height]); revision++; },
    resizeCanvas(session, before, width, height, anchor) { calls.push(["resizeCanvas", width, height, anchor]); revision++; },
    rotateCanvas(session, before, degrees) { calls.push(["rotate", degrees]); revision++; },
    cropDocument(session, before, crop) { calls.push(["crop", crop]); revision++; },
    setSelection(session, before, rects) { calls.push(["selection", rects]); selection = rects; revision++; },
    setSelectionMask(session, before, input) {
      calls.push(["selectionMask", input.gray.byteLength]); selection = [{ x: 0, y: 0, width: 3, height: 2 }]; revision++;
    },
    modifySelection(session, before, type, pixels) { calls.push(["modifySelection", type, pixels]); revision++; },
    selectChannel(session, before, id) { calls.push(["selectChannel", id]); revision++; },
    selectPath(session, before, id) { calls.push(["selectPath", id]); revision++; },
    renameChannel(session, before, id, name) { calls.push(["renameChannel", id, name]); revision++; },
    invertChannel(session, before, id) { calls.push(["invertChannel", id]); revision++; },
    removeChannel(session, before, id) { calls.push(["removeChannel", id]); revision++; },
    moveChannel(session, before, id, index) { calls.push(["moveChannel", id, index]); revision++; },
    renamePath(session, before, id, name) { calls.push(["renamePath", id, name]); revision++; },
    removePath(session, before, id) { calls.push(["removePath", id]); revision++; },
    movePath(session, before, id, index) { calls.push(["movePath", id, index]); revision++; },
    setClippingPath(session, before, id, clipping) { calls.push(["clippingPath", id, clipping]); revision++; },
    addAlphaChannel(session, before, input) { calls.push(["alpha", input.gray.byteLength]); revision++; },
    addDocumentPath(session, before, input) { calls.push(["path", input.path.anchors.length]); revision++; },
    updateDocumentPath(session, before, id, input) { calls.push(["updatePath", id, input.path.anchors.length]); revision++; },
    rasterizeLayer(session, before, id) { calls.push(["rasterize", id]); revision++; },
    mergeVisibleCopy(session, before, name) { calls.push(["mergeVisible", name]); revision++; },
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
    applyFilter(session, before, layerId, filterId, parameters, cancellation, progress) {
      calls.push(["filter", layerId, filterId, parameters]);
      progress({ completed: 1, total: 1, stage: 0, ratio: 1 }); revision++;
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
  const firstDocument = await host.dispatch({ method: "create", width: 3, height: 2, name: "First.psd" });
  assert.equal(firstDocument.revision, 1n);
  assert.equal(firstDocument.documentName, "First.psd");
  assert.equal(firstDocument.documents.length, 1);
  assert.equal((await host.dispatch({ method: "setLayerVisibility", layerId: "7", visible: false })).layers[0].visible, false);
  await host.dispatch({ method: "moveLayer", layerId: "7", targetLayerId: null, position: 3 });
  await host.dispatch({ method: "setLayerOpacity", layerId: "7", opacity: 0.5 });
  await host.dispatch({ method: "setLayerFillOpacity", layerId: "7", opacity: 0.75 });
  await host.dispatch({ method: "setLayerLocks", layerId: "7", lockFlags: 7 });
  await host.dispatch({ method: "setLayerClipping", layerId: "7", clipped: true });
  await host.dispatch({ method: "setLayerStylePreset", layerId: "7", presetId: "" });
  await host.dispatch({ method: "setLayerBlendMode", layerId: "7", blendMode: 2 });
  await host.dispatch({ method: "renameLayer", layerId: "7", name: "Renamed" });
  await host.dispatch({ method: "removeLayer", layerId: "7" });
  await host.dispatch({ method: "resizeImage", width: 6, height: 4 });
  await host.dispatch({ method: "resizeCanvas", width: 8, height: 6, anchor: 4 });
  await host.dispatch({ method: "rotateCanvas", clockwiseDegrees: 90 });
  await host.dispatch({ method: "cropDocument", crop: { x: 1, y: 1, width: 4, height: 3 } });
  await host.dispatch({ method: "setSelection", rects: [{ x: 0, y: 0, width: 1, height: 1 }] });
  await host.dispatch({ method: "setSelectionMask", bounds: { x: 0, y: 0, width: 3, height: 2 },
    gray: new Uint8Array([0, 64, 255, 255, 64, 0]).buffer });
  await host.dispatch({ method: "modifySelection", type: 20, pixels: 4 });
  await host.dispatch({ method: "addAlphaChannel", name: "Alpha 1" });
  await host.dispatch({ method: "addDocumentPath", input: { path: { anchors: [{}, {}, {}] } } });
  await host.dispatch({ method: "selectChannel", channelId: "3" });
  await host.dispatch({ method: "selectPath", pathId: "4", feather: 0, combine: 0, antialias: true });
  await host.dispatch({ method: "renameChannel", channelId: "3", name: "Mask" });
  await host.dispatch({ method: "invertChannel", channelId: "3" });
  await host.dispatch({ method: "removeChannel", channelId: "3" });
  await host.dispatch({ method: "moveChannel", channelId: "3", finalIndex: 0 });
  await host.dispatch({ method: "renamePath", pathId: "4", name: "Outline" });
  await host.dispatch({ method: "removePath", pathId: "4" });
  await host.dispatch({ method: "movePath", pathId: "4", finalIndex: 0 });
  await host.dispatch({ method: "setClippingPath", pathId: "4", clipping: true });
  await host.dispatch({ method: "updateDocumentPath", pathId: "4",
    input: { path: { anchors: [{}, {}, {}] } } });
  await host.dispatch({ method: "rasterizeLayer", layerId: "7" });
  await host.dispatch({ method: "mergeVisibleCopy", name: "Merged" });
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
  await host.dispatch({ method: "applyFilter", layerId: "7", filterId: "patchy.filters.threshold",
    parameters: [{ key: "threshold", kind: "integer", value: 128 }],
    cancellation: new SharedArrayBuffer(4), progress: (value) => filterProgress.push(value.ratio) });
  assert.deepEqual(filterProgress, [1]);
  assert.deepEqual(calls.find((call) => call[0] === "filter").slice(1, 4),
    [7n, "patchy.filters.threshold", [{ key: "threshold", kind: "integer", value: 128 }]]);
  await host.dispatch({ method: "undo" });
  await host.dispatch({ method: "redo" });
  assert.equal((await host.dispatch({ method: "render", region: { x: 0, y: 0, width: 3, height: 2 } })).byteLength, 24);
  assert.deepEqual(Array.from(await host.dispatch({ method: "save" })), [56, 66, 80, 83]);
  const secondDocument = await host.dispatch({ method: "create", width: 1, height: 1, name: "Second.psd" });
  assert.equal(secondDocument.documents.length, 2);
  assert.equal(secondDocument.documentName, "Second.psd");
  const firstAgain = await host.dispatch({ method: "activateDocument", documentId: firstDocument.documentId });
  assert.equal(firstAgain.documentName, "First.psd");
  assert.equal((await host.dispatch({ method: "listDocuments" })).length, 2);
  const afterSecondClose = await host.dispatch({ method: "closeDocument", documentId: secondDocument.documentId });
  assert.equal(afterSecondClose.documents.length, 1);
  assert.equal(afterSecondClose.documentId, firstDocument.documentId);
  assert.equal(await host.dispatch({ method: "close" }), null);
  host.dispose();
  assert.deepEqual(calls[1], ["visibility", 1n, 7n, false]);
  assert.deepEqual(calls[2], ["move", 2n, 7n, null, 3]);
  assert.ok(calls.some(([name]) => name === "save"));
});

test("one Worker owns isolated switchable document sessions", async () => {
  let nextSession = 100;
  const revisions = new Map(); const visibility = new Map(); const closed = [];
  const engine = {
    capabilities: 0n,
    create() { const session = nextSession++; revisions.set(session, 1); visibility.set(session, true); return session; },
    snapshot(session) {
      const value = projection(revisions.get(session), visibility.get(session));
      value.dirty = revisions.get(session) > 1; return value;
    },
    setLayerVisibility(session, before, layerId, visible) {
      assert.equal(before.revision, BigInt(revisions.get(session)));
      visibility.set(session, visible); revisions.set(session, revisions.get(session) + 1);
    },
    save(session) { return new Uint8Array([session]); },
    close(session) { closed.push(session); revisions.delete(session); visibility.delete(session); },
    dispose() {},
  };
  const host = new PatchyWorkerHost(engine);
  const first = await host.dispatch({ method: "create", width: 2, height: 2, name: "First.psd" });
  const editedFirst = await host.dispatch({ method: "setLayerVisibility", layerId: "7", visible: false });
  assert.equal(editedFirst.revision, 2n);
  const second = await host.dispatch({ method: "create", width: 3, height: 3, name: "Second.psd" });
  assert.equal(second.revision, 1n);
  assert.equal(second.documents.length, 2);
  assert.deepEqual([...await host.dispatch({ method: "saveDocument", documentId: first.documentId })], [100]);
  const restoredFirst = await host.dispatch({ method: "activateDocument", documentId: first.documentId });
  assert.equal(restoredFirst.revision, 2n);
  assert.equal(restoredFirst.layers[0].visible, false);
  const restoredSecond = await host.dispatch({ method: "activateDocument", documentId: second.documentId });
  assert.equal(restoredSecond.revision, 1n);
  assert.equal(restoredSecond.layers[0].visible, true);
  const fallback = await host.dispatch({ method: "closeDocument", documentId: second.documentId });
  assert.equal(fallback.documentId, first.documentId);
  assert.deepEqual(closed, [101]);
  host.dispose();
  assert.deepEqual(closed, [101, 100]);
});

test("worker copies one exact editable layer state into one atomic target revision", async () => {
  let nextSession = 100;
  const revisions = new Map();
  const calls = [];
  const engine = {
    capabilities: 1n << 27n,
    create() { const session = nextSession++; revisions.set(session, 1n); return session; },
    snapshot(session) {
      const revision = revisions.get(session);
      return { ...projection(Number(revision)), revision, stateId: revision };
    },
    copyLayerToSession(target, targetSnapshot, source, sourceSnapshot, layerId) {
      calls.push({ target, targetSnapshot, source, sourceSnapshot, layerId });
      revisions.set(target, revisions.get(target) + 1n);
    },
    close() {}, dispose() {},
  };
  const host = new PatchyWorkerHost(engine);
  const source = await host.dispatch({ method: "create", width: 3, height: 2, name: "Source.psd" });
  const target = await host.dispatch({ method: "create", width: 3, height: 2, name: "Target.psd" });
  const copied = await host.dispatch({ method: "copyLayerToDocument",
    sourceDocumentId: source.documentId, targetDocumentId: target.documentId,
    layerId: "7", expectedSourceStateId: "1", expectedSourceRevision: "1",
    expectedTargetStateId: "1", expectedTargetRevision: "1" });
  assert.equal(copied.documentId, target.documentId);
  assert.equal(copied.revision, 2n);
  assert.equal(revisions.get(calls[0].source), 1n);
  assert.equal(calls[0].layerId, 7n);
  await assert.rejects(host.dispatch({ method: "copyLayerToDocument",
    sourceDocumentId: source.documentId, targetDocumentId: target.documentId,
    layerId: "7", expectedSourceStateId: "1", expectedSourceRevision: "1",
    expectedTargetStateId: "1", expectedTargetRevision: "1" }),
  (error) => error.name === "PatchyEngineError" && error.code === 6);
  assert.equal(calls.length, 1);
  host.dispose();
});

test("worker previews without mutation and commits one stale-guarded layer transform", async () => {
  let revision = 4n;
  const calls = [];
  const engine = {
    capabilities: 1n << 28n,
    create() { return 100; },
    snapshot() { return { ...projection(Number(revision)), revision, stateId: revision }; },
    previewLayerTransform(session, before, layerId, quad, interpolation) {
      calls.push(["preview", session, before.revision, layerId, quad, interpolation]);
      return { region: { x: 0, y: 0, width: 2, height: 2 }, rgba: new Uint8Array(16) };
    },
    transformLayer(session, before, layerId, quad, interpolation) {
      calls.push(["commit", session, before.revision, layerId, quad, interpolation]);
      revision += 1n;
    },
    close() {}, dispose() {},
  };
  const host = new PatchyWorkerHost(engine);
  await host.dispatch({ method: "create", width: 4, height: 4, name: "Transform.psd" });
  const quad = [0, 0, 3, 0, 3, 3, 0, 3];
  const preview = await host.dispatch({ method: "previewLayerTransform", layerId: "7", quad,
    interpolation: 1, expectedStateId: "4", expectedRevision: "4",
    cancellation: new SharedArrayBuffer(4) });
  assert.equal(preview.rgba.byteLength, 16);
  assert.equal(revision, 4n);
  const committed = await host.dispatch({ method: "transformLayer", layerId: "7", quad,
    interpolation: 1, expectedStateId: "4", expectedRevision: "4" });
  assert.equal(committed.revision, 5n);
  await assert.rejects(host.dispatch({ method: "transformLayer", layerId: "7", quad,
    interpolation: 1, expectedStateId: "4", expectedRevision: "4" }),
  (error) => error.name === "PatchyEngineError" && error.code === 6);
  assert.deepEqual(calls.map(([kind]) => kind), ["preview", "commit"]);
  host.dispose();
});

test("worker previews and commits one exact-state raster stroke", async () => {
  let revision = 4n;
  const calls = [];
  const engine = {
    capabilities: 1n << 29n,
    create() { return 100; },
    snapshot() { return { ...projection(Number(revision)), revision, stateId: revision }; },
    previewRasterStroke(session, before, input) {
      calls.push(["preview", session, before.revision, input]);
      return { region: { x: 1, y: 1, width: 3, height: 2 }, rgba: new Uint8Array(24) };
    },
    applyRasterStroke(session, before, input) {
      calls.push(["commit", session, before.revision, input]); revision += 1n;
    },
    close() {}, dispose() {},
  };
  const host = new PatchyWorkerHost(engine);
  await host.dispatch({ method: "create", width: 8, height: 4, name: "Paint.psd" });
  const message = { layerId: "7", mode: 0, brushSize: 4, color: [255, 0, 0, 255],
    points: [[1, 1], [4, 2]], source: [0, 0], expectedStateId: "4",
    expectedRevision: "4" };
  const preview = await host.dispatch({ method: "previewRasterStroke", ...message,
    cancellation: new SharedArrayBuffer(4) });
  assert.equal(preview.rgba.byteLength, 24); assert.equal(revision, 4n);
  const committed = await host.dispatch({ method: "applyRasterStroke", ...message });
  assert.equal(committed.revision, 5n);
  await assert.rejects(host.dispatch({ method: "applyRasterStroke", ...message }),
    (error) => error.name === "PatchyEngineError" && error.code === 6);
  assert.deepEqual(calls.map(([kind]) => kind), ["preview", "commit"]);
  host.dispose();
});

test("Smart Object contents open once and save back as one stale-guarded parent revision", async () => {
  const revisions = new Map([[1, 4], [2, 1]]);
  let parentHasSmartObject = false;
  let replacements = 0;
  const parentProjection = () => ({ ...projection(revisions.get(1)), width: 3, height: 2,
    layers: [{ ...projection(1).layers[0],
      ...(parentHasSmartObject ? { kind: 5, name: "embedded",
        smartObject: { sourceKind: 0, filename: "embedded.psd", filetype: "8BPS",
          sourceSize: 128n, editable: true } } : { smartObject: null }) }] });
  const childProjection = () => ({ ...projection(revisions.get(2)), width: 3, height: 2 });
  const engine = {
    capabilities: 0n,
    create() { return 1; },
    open(bytes) { assert.deepEqual(Array.from(bytes), [56, 66, 80, 83]); return 2; },
    snapshot(session) { return session === 1 ? parentProjection() : childProjection(); },
    addSmartObject(session, before, input) {
      assert.equal(session, 1); assert.equal(input.filetype, "8BPS");
      assert.equal(input.rgba.byteLength, 24); parentHasSmartObject = true;
      revisions.set(1, revisions.get(1) + 1);
    },
    smartObjectBytes(session, layerId) {
      assert.deepEqual([session, layerId], [1, 7n]); return new Uint8Array([56, 66, 80, 83]);
    },
    render(session, region) {
      assert.equal(session, 2); assert.deepEqual(region, { x: 0, y: 0, width: 3, height: 2 });
      return new Uint8Array(24).fill(17);
    },
    save(session) { assert.equal(session, 2); return new Uint8Array([56, 66, 80, 83, 0, 1]); },
    replaceSmartObject(session, before, layerId, input) {
      assert.equal(session, 1); assert.equal(before.stateId, BigInt(revisions.get(1)));
      assert.equal(before.revision, BigInt(revisions.get(1)));
      assert.equal(layerId, 7n); assert.equal(input.filetype, "8BPS");
      assert.equal(input.rgba.byteLength, 24);
      assert.equal(input.sourceBytes.byteLength, replacements === 0 ? 4 : 6);
      replacements++; revisions.set(1, revisions.get(1) + 1);
    },
    close() {}, dispose() {},
  };
  const host = new PatchyWorkerHost(engine);
  const parent = await host.dispatch({ method: "create", width: 3, height: 2, name: "Parent.psd" });
  const placed = await host.dispatch({ method: "addPsdSmartObject",
    bytes: new Uint8Array([56, 66, 80, 83]).buffer,
    name: "embedded", filename: "embedded.psd", filetype: "8BPS" });
  assert.equal(placed.layers[0].smartObject.contentsEditable, true);
  const replaced = await host.dispatch({ method: "addPsdSmartObject", layerId: "7",
    bytes: new Uint8Array([56, 66, 80, 83]).buffer,
    name: "embedded", filename: "embedded.psd", filetype: "8BPS" });
  assert.equal(replaced.layers.length, 1);
  assert.equal(replaced.layers[0].smartObject.contentsEditable, true);
  const child = await host.dispatch({ method: "openSmartObjectContents", layerId: "7" });
  assert.equal(child.documents.length, 2);
  assert.equal(child.documents.find((item) => item.active).smartObjectParentId, parent.documentId);
  await host.dispatch({ method: "activateDocument", documentId: parent.documentId });
  await assert.rejects(
    host.dispatch({ method: "addPsdSmartObject", layerId: "7",
      bytes: new Uint8Array([56, 66, 80, 83]).buffer,
      name: "replacement", filename: "replacement.psd", filetype: "8BPS" }),
    /Close the open Smart Object contents/);
  const reopened = await host.dispatch({ method: "openSmartObjectContents", layerId: "7" });
  assert.equal(reopened.documentId, child.documentId);
  assert.equal(reopened.documents.length, 2);

  const committed = await host.dispatch({ method: "saveSmartObjectContents", documentId: child.documentId });
  assert.equal(committed.documentId, parent.documentId);
  assert.equal(committed.revision, 7n);
  assert.equal(replacements, 2);

  await host.dispatch({ method: "activateDocument", documentId: child.documentId });
  revisions.set(1, 8);
  await assert.rejects(
    host.dispatch({ method: "saveSmartObjectContents", documentId: child.documentId }),
    /parent document changed/);
  assert.equal(replacements, 2);
  await host.dispatch({ method: "closeDocument", documentId: child.documentId });
  assert.equal(replacements, 2);
  host.dispose();
});

test("Worker enforces per-document and global history budgets with one undo-state floor", async () => {
  let nextSession = 1;
  const histories = new Map(); const undoStates = new Map();
  const engine = {
    capabilities: 0n,
    create() { const session = nextSession++; histories.set(session, 40 * MIB); undoStates.set(session, 3); return session; },
    snapshot() { return projection(1); },
    memoryUsage(session) { const historyRetainedBytes = histories.get(session); return {
      documentPixelBytes: MIB, historyPixelBytes: historyRetainedBytes,
      previewPixelBytes: 0, selectionBytes: 0, historySelectionBytes: 0,
      previewSelectionBytes: 0, historyRetainedBytes,
      totalRetainedBytes: historyRetainedBytes + MIB,
      undoStates: undoStates.get(session), redoStates: 0,
    }; },
    pendingRenderRegion() { return { x: 1, y: 1, width: 1, height: 1 }; },
    evictOldestUndo(session) {
      if (undoStates.get(session) <= 1) return false;
      undoStates.set(session, undoStates.get(session) - 1);
      histories.set(session, histories.get(session) - 16 * MIB);
      return true;
    },
    close() {}, dispose() {},
  };
  const host = new PatchyWorkerHost(engine);
  assert.deepEqual(await host.dispatch({ method: "setMemoryBudget",
    documentBytes: 24 * MIB, globalBytes: 32 * MIB }),
  { memoryBudget: { documentBytes: 24 * MIB, globalBytes: 32 * MIB } });
  const first = await host.dispatch({ method: "create", width: 1, height: 1, name: "First" });
  const second = await host.dispatch({ method: "create", width: 1, height: 1, name: "Second" });
  assert.equal(first.memory.historyRetainedBytes, 24 * MIB);
  assert.equal(second.documents.reduce((sum, item) => sum + item.historyBytes, 0), 32 * MIB);
  assert.ok([...undoStates.values()].every((count) => count >= 1));
  assert.deepEqual(second.dirtyRegion, { x: 1, y: 1, width: 1, height: 1 });
  await assert.rejects(host.dispatch({ method: "setMemoryBudget",
    documentBytes: 8 * MIB, globalBytes: 32 * MIB }), /Memory budgets/);
  host.dispose();
});

test("browser memory policy preflights working sets and selects bounded dirty renders", () => {
  assert.equal(browserWorkingSetLimit({ heapLimitBytes: 2 * 1024 * MIB, deviceMemoryGiB: 8 }),
    Math.floor(2 * 1024 * MIB * 0.7));
  assert.equal(documentPreflight({ width: 1000, height: 1000, limitBytes: 256 * MIB }).allowed, true);
  assert.equal(documentPreflight({ sourceBytes: 512 * MIB, limitBytes: 2 * 1024 * MIB }).allowed, false);
  assert.deepEqual(chooseRenderRegion({ width: 100, height: 100, dirtyRegion: { x: 4, y: 5, width: 10, height: 12 } },
    { documentId: 1, currentDocumentId: 1, width: 100, height: 100 }),
  { x: 4, y: 5, width: 10, height: 12 });
  assert.equal(chooseRenderRegion({ width: 100, height: 100, dirtyRegion: null },
    { documentId: 1, currentDocumentId: 1, width: 100, height: 100 }), null);
  assert.deepEqual(chooseRenderRegion({ width: 100, height: 100, dirtyRegion: null },
    { documentId: 1, currentDocumentId: 2, width: 100, height: 100 }),
  { x: 0, y: 0, width: 100, height: 100 });
});

class FakeWorker extends EventTarget {
  sent = [];
  postMessage(message, transfer = []) {
    this.sent.push({ message: structuredClone(message, { transfer }), transfer });
  }
  terminate() {}
  reply(message) { this.dispatchEvent(new MessageEvent("message", { data: message })); }
  fail(message) {
    const event = new Event("error");
    Object.defineProperty(event, "message", { value: message });
    this.dispatchEvent(event);
  }
}

test("client byte ingress copies by default and transfers explicit whole-buffer ownership", async () => {
  const worker = new FakeWorker();
  const client = new PatchyWorkerClient(worker);
  const safe = new Uint8Array([1, 2, 3]);
  const safeOpen = client.open(safe);
  assert.equal(safe.byteLength, 3);
  assert.notEqual(worker.sent[0].message.bytes, safe.buffer);
  worker.reply({ id: 1, ok: true, value: projection(1) }); await safeOpen;

  const owned = new Uint8Array([4, 5, 6]);
  const ownedOpen = client.open(owned, "Owned.psd", { transferOwnership: true });
  assert.equal(owned.byteLength, 0);
  assert.deepEqual([...new Uint8Array(worker.sent[1].message.bytes)], [4, 5, 6]);
  worker.reply({ id: 2, ok: true, value: projection(1) }); await ownedOpen;

  const backing = new Uint8Array([7, 8, 9, 10]);
  const subview = backing.subarray(1, 3);
  const subviewOpen = client.open(subview, "Subview.psd", { transferOwnership: true });
  assert.equal(backing.byteLength, 4);
  assert.deepEqual([...new Uint8Array(worker.sent[2].message.bytes)], [8, 9]);
  worker.reply({ id: 3, ok: true, value: projection(1) }); await subviewOpen;

  const shared = new Uint8Array(new SharedArrayBuffer(2)); shared.set([11, 12]);
  const sharedOpen = client.open(shared, "Shared.psd", { transferOwnership: true });
  assert.equal(shared.byteLength, 2);
  assert.ok(worker.sent[3].message.bytes instanceof ArrayBuffer);
  worker.reply({ id: 4, ok: true, value: projection(1) }); await sharedOpen;

  const rgba = new Uint8Array([1, 2, 3, 4]);
  const sourceBytes = new Uint8Array([5, 6]);
  const smart = client.addSmartObject({ name: "Smart", filename: "smart.png",
    filetype: "PNG ", width: 1, height: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, rgba, sourceBytes },
  { transferOwnership: true });
  assert.equal(rgba.byteLength, 0); assert.equal(sourceBytes.byteLength, 0);
  assert.equal(worker.sent[4].transfer.length, 2);
  worker.reply({ id: 5, ok: true, value: projection(2) }); await smart;
});

test("client sends Blob handles without main-thread byte materialization", async () => {
  const worker = new FakeWorker(); const client = new PatchyWorkerClient(worker);
  const blob = new Blob([new Uint8Array([56, 66, 80, 83])]);
  const opened = client.openBlob(blob, "Local.psd");
  assert.equal(worker.sent[0].message.method, "openBlob");
  assert.equal(worker.sent[0].message.name, "Local.psd");
  assert.equal(worker.sent[0].message.blob.size, 4);
  assert.equal(worker.sent[0].transfer.length, 0);
  worker.reply({ id: 1, ok: true, value: projection(1) });
  assert.equal((await opened).revision, 1n);
  const inspected = client.inspectBlob(blob);
  assert.equal(worker.sent[1].message.method, "inspectBlob");
  worker.reply({ id: 2, ok: true, value: { version: 1, width: 1, height: 1,
    channels: 4, depth: 8, colorMode: 3, sourceBytes: 4 } });
  assert.equal((await inspected).width, 1);
  const placed = client.placePsdSmartObject(blob, "Placed.psd", 7n);
  assert.equal(worker.sent[2].message.method, "placePsdSmartObject");
  assert.equal(worker.sent[2].message.blob.size, 4);
  assert.equal(worker.sent[2].message.layerId, "7");
  assert.equal(worker.sent[2].transfer.length, 0);
  worker.reply({ id: 3, ok: true, value: projection(2) });
  assert.equal((await placed).revision, 2n);
});

test("client receives Worker-native PSD Blobs without byte transfer lists", async () => {
  const worker = new FakeWorker(); const client = new PatchyWorkerClient(worker);
  const saved = client.saveBlob();
  assert.equal(worker.sent[0].message.method, "saveBlob");
  worker.reply({ id: 1, ok: true, value: new Blob([psdHeader()]) });
  assert.ok((await saved) instanceof Blob);
  const documentSaved = client.saveDocumentBlob(17);
  assert.equal(worker.sent[1].message.method, "saveDocumentBlob");
  assert.equal(worker.sent[1].message.documentId, 17);
  worker.reply({ id: 2, ok: true, value: new Blob([psdHeader()]) });
  assert.equal((await documentSaved).size, 26);
});

test("client correlates RPC, transfers input and rejects all requests on crash", async () => {
  const worker = new FakeWorker();
  const client = new PatchyWorkerClient(worker);
  const states = [];
  const removeStateListener = client.addStateListener((state, error) =>
    states.push([state, error?.message]));
  const init = client.initialize("./patchy-engine.mjs");
  worker.reply({ id: 1, ok: true, value: { capabilities: (1n << 26n) - 1n } });
  await init;
  assert.equal(client.state, "ready");
  assert.equal(client.capabilities, (1n << 26n) - 1n);
  const source = new Uint8Array([1, 2, 3]);
  const opened = client.open(source);
  assert.equal(worker.sent[1].transfer.length, 1);
  assert.equal(worker.sent[1].message.name, "Document.psd");
  worker.reply({ id: 2, ok: true, value: projection(1) });
  assert.equal((await opened).layers[0].id, 7n);
  const pixelInput = new Uint8Array([1, 2, 3, 4]);
  const pixels = client.addPixelLayer({ name: "Pixels", width: 1, height: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, rgba: pixelInput });
  assert.equal(worker.sent[2].transfer.length, 1);
  worker.reply({ id: 3, ok: true, value: projection(2) });
  await pixels;
  const renderedFrame = client.renderFrame({ x: 0, y: 0, width: 1, height: 1 });
  assert.equal(worker.sent[3].message.method, "renderFrame");
  worker.reply({ id: 4, ok: true, value: { kind: "rgba",
    bytes: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 } });
  assert.equal((await renderedFrame).kind, "rgba");
  const filterProgress = [];
  const filter = client.applyFilter(7n, "patchy.filters.gaussian_blur",
    [{ key: "radius", kind: "integer", value: 3 }],
    (value) => filterProgress.push(value.ratio));
  const filterMessage = worker.sent[4].message;
  assert.equal(filterMessage.method, "applyFilter");
  assert.equal(filterMessage.filterId, "patchy.filters.gaussian_blur");
  assert.deepEqual(filterMessage.parameters, [{ key: "radius", kind: "integer", value: 3 }]);
  assert.ok(filterMessage.cancellation instanceof SharedArrayBuffer);
  worker.reply({ id: 5, progress: { completed: 1, total: 2, stage: 0, ratio: 0.5 } });
  assert.deepEqual(filterProgress, [0.5]);
  filter.cancel();
  assert.equal(Atomics.load(new Int32Array(filterMessage.cancellation), 0), 1);
  worker.reply({ id: 5, ok: true, value: projection(3) });
  await filter.promise;
  const savedDocument = client.saveDocument(23);
  assert.equal(worker.sent[5].message.method, "saveDocument");
  assert.equal(worker.sent[5].message.documentId, 23);
  worker.reply({ id: 6, ok: true, value: new Uint8Array([56, 66, 80, 83]) });
  assert.equal((await savedDocument).byteLength, 4);
  const pending = client.save();
  worker.fail("worker trap");
  await assert.rejects(pending, /worker trap/);
  assert.equal(client.state, "crashed");
  assert.deepEqual(states, [["ready", undefined], ["crashed", "worker trap"]]);
  removeStateListener();
  await assert.rejects(client.undo(), /crashed/);
});
