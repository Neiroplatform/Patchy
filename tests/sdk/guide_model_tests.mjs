import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGuides, snapTranslatedQuad } from "../../sdk/engine/site/guide-model.mjs";

test("guides are bounded, de-duplicated and deterministic", () => {
  assert.deepEqual(normalizeGuides([
    { orientation: "vertical", position: 50.4 },
    { orientation: "horizontal", position: 10 },
    { orientation: "vertical", position: 50 },
    { orientation: "horizontal", position: -1 },
    { orientation: "diagonal", position: 4 },
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
  assert.match(css, /\.guide-line:focus-visible/);
});
