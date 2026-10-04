import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { guidePositionFromPointer, normalizeGuides, pointInGuideParentRuler,
  snapTranslatedQuad } from "../../sdk/engine/site/guide-model.mjs";

test("guides are bounded, de-duplicated and deterministic", () => {
  assert.deepEqual(normalizeGuides([
    { orientation: "vertical", position: 50.4 },
    { orientation: "horizontal", position: 10 },
    { orientation: "vertical", position: 50 },
    { orientation: "horizontal", position: -1 },
    { orientation: "diagonal", position: 4 },
    { orientation: "toString", position: 4 },
    { orientation: "__proto__", position: 4 },
  ], 100, 80), [
    { orientation: "horizontal", position: 10 },
    { orientation: "vertical", position: 50 },
  ]);
});

test("translation snaps independently to guides and document geometry", () => {
  const original = [10, 10, 30, 10, 30, 30, 10, 30];
  const result = snapTranslatedQuad(original, 18, 17,
    [{ orientation: "vertical", position: 50 }, { orientation: "horizontal", position: 50 }],
    { width: 100, height: 100 }, { threshold: 4 });
  assert.deepEqual(result.quad, [30, 30, 50, 30, 50, 50, 30, 50]);
  assert.equal(result.dx, 20);
  assert.equal(result.dy, 20);
});

test("alt bypass preserves the raw translation", () => {
  const original = [0, 0, 10, 0, 10, 10, 0, 10];
  const result = snapTranslatedQuad(original, 39, 39,
    [{ orientation: "vertical", position: 50 }, { orientation: "horizontal", position: 50 }],
    { width: 100, height: 100 }, { threshold: 8, bypass: true });
  assert.deepEqual(result.quad, [39, 39, 49, 39, 49, 49, 39, 49]);
  assert.equal(result.snappedX, null);
  assert.equal(result.snappedY, null);
});

test("invalid document geometry drops guides fail closed", () => {
  assert.deepEqual(normalizeGuides([{ orientation: "vertical", position: 1 }], 0, 10), []);
  assert.throws(() => snapTranslatedQuad([], 0, 0, [], { width: 10, height: 10 }),
    /finite four-corner quad/);
  const quad = [0, 0, 10, 0, 10, 10, 0, 10];
  for (const documentSize of [null, { width: 0, height: 10 }, { width: 10.5, height: 10 },
    { width: 10, height: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => snapTranslatedQuad(quad, 0, 0, [], documentSize),
      /positive safe-integer document size/);
  }
});

test("ruler pointer placement and return-to-parent removal geometry are deterministic", () => {
  const canvas = { left: 100, top: 80, width: 800, height: 400 };
  assert.equal(guidePositionFromPointer("vertical", { x: 300, y: 10 }, canvas,
    { width: 1600, height: 1000 }), 400);
  assert.equal(guidePositionFromPointer("horizontal", { x: 10, y: 180 }, canvas,
    { width: 1600, height: 1000 }), 250);
  assert.equal(guidePositionFromPointer("horizontal", { x: 10, y: -40 }, canvas,
    { width: 1600, height: 1000 }), 0);
  assert.throws(() => guidePositionFromPointer("diagonal", { x: 0, y: 0 }, canvas,
    { width: 10, height: 10 }), /valid orientation/);
  const horizontal = { left: 18, top: 0, width: 982, height: 18 };
  const vertical = { left: 0, top: 18, width: 18, height: 582 };
  assert.equal(pointInGuideParentRuler("horizontal", { x: 400, y: 9 }, horizontal, vertical), true);
  assert.equal(pointInGuideParentRuler("horizontal", { x: 9, y: 200 }, horizontal, vertical), false);
  assert.equal(pointInGuideParentRuler("vertical", { x: 9, y: 200 }, horizontal, vertical), true);
});

test("production shell stages accessible guide controls and snap integration", async () => {
  const root = new URL("../../", import.meta.url);
  const [cmake, html, editor, css] = await Promise.all([
    readFile(new URL("CMakeLists.txt", root), "utf8"),
    readFile(new URL("sdk/engine/site/patchy.html", root), "utf8"),
    readFile(new URL("sdk/engine/site/editor.mjs", root), "utf8"),
    readFile(new URL("sdk/engine/site/editor.css", root), "utf8"),
  ]);
  assert.match(cmake, /sdk\/engine\/site\/guide-model\.mjs/);
  for (const id of ["guidesOverlay", "addVerticalGuideButton", "addHorizontalGuideButton",
    "toggleGuidesButton", "toggleSnapButton", "clearGuidesButton"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(editor, /snapTranslatedQuad\(moveDraft\.originalQuad/);
  assert.match(editor, /bypass: event\.altKey/);
  assert.match(editor, /createGuideFromRuler\("horizontal"/);
  assert.match(editor, /pointInGuideParentRuler/);
  assert.match(css, /\.guide-line:focus-visible/);
});
