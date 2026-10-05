import assert from "node:assert/strict";
import test from "node:test";

import { copyLayerSelection } from "../../sdk/engine/selection-copy.mjs";
import { openFileKind } from "../../sdk/engine/site/reference-workflow.mjs";

test("open classifies layered and supported raster documents without trusting MIME alone", () => {
  assert.equal(openFileKind({ name: "work.PSB", type: "" }), "layered");
  assert.equal(openFileKind({ name: "photo.bin", type: "image/jpeg" }), "raster");
  assert.equal(openFileKind({ name: "graphic.SVG", type: "text/plain" }), "raster");
  assert.equal(openFileKind({ name: "notes.txt", type: "text/plain" }), "unsupported");
});

test("layer via copy crops one pixel layer and multiplies alpha by soft selection coverage", () => {
  const rgba = new Uint8Array([
    10, 20, 30, 255, 40, 50, 60, 200,
    70, 80, 90, 128, 100, 110, 120, 255,
  ]);
  const selectionMask = new Uint8Array(4 * 3);
  selectionMask[1 * 4 + 1] = 255;
  selectionMask[1 * 4 + 2] = 128;
  selectionMask[2 * 4 + 1] = 64;
  selectionMask[2 * 4 + 2] = 0;
  const result = copyLayerSelection({
    layer: { kind: 0, visible: true, bounds: { x: 1, y: 1, width: 2, height: 2 } },
    rgba, selectionMask, selectionBounds: { x: 1, y: 1, width: 2, height: 2 },
    documentWidth: 4, documentHeight: 3,
  });
  assert.deepEqual(result.bounds, { x: 1, y: 1, width: 2, height: 2 });
  assert.deepEqual([...result.rgba], [
    10, 20, 30, 255, 40, 50, 60, 100,
    70, 80, 90, 32, 100, 110, 120, 0,
  ]);
});

test("layer via copy rejects incomplete inputs and returns null for empty overlap", () => {
  const layer = { kind: 0, visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 } };
  assert.throws(() => copyLayerSelection({ layer, rgba: new Uint8Array(3),
    selectionMask: new Uint8Array(1), selectionBounds: layer.bounds,
    documentWidth: 1, documentHeight: 1 }), /do not match/);
  assert.equal(copyLayerSelection({ layer, rgba: new Uint8Array([1, 2, 3, 255]),
    selectionMask: new Uint8Array(1), selectionBounds: layer.bounds,
    documentWidth: 1, documentHeight: 1 }), null);
});

test("layer via copy tightens a broad canonical mask bound to nonzero coverage", () => {
  const selectionMask = new Uint8Array(6 * 4);
  selectionMask[1 * 6 + 2] = 255;
  selectionMask[2 * 6 + 3] = 128;
  const result = copyLayerSelection({
    layer: { kind: 0, visible: true, bounds: { x: 0, y: 0, width: 6, height: 4 } },
    rgba: new Uint8Array(6 * 4 * 4).fill(255), selectionMask,
    selectionBounds: { x: 0, y: 0, width: 6, height: 4 },
    documentWidth: 6, documentHeight: 4,
  });
  assert.deepEqual(result.bounds, { x: 2, y: 1, width: 2, height: 2 });
  assert.equal(result.rgba.byteLength, 16);
  assert.deepEqual([result.rgba[3], result.rgba[7], result.rgba[11], result.rgba[15]],
    [255, 0, 0, 128]);
});
