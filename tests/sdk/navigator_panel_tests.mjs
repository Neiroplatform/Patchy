import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { containedRect, navigatorDocumentPoint,
  NAVIGATOR_SAMPLE_LIMIT } from "../../sdk/engine/site/navigator-panel.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("navigator preview preserves the document aspect ratio inside a bounded surface", () => {
  assert.deepEqual(containedRect(100, 50, 200, 200, 10), {
    x: 10, y: 55, width: 180, height: 90, scale: 1.8,
  });
  assert.deepEqual(containedRect(50, 100, 200, 200, 10), {
    x: 55, y: 10, width: 90, height: 180, scale: 1.8,
  });
  assert.equal(containedRect(0, 100, 200, 200), null);
});

test("navigator pointer mapping is document-relative and clamps outside drags", () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };
  const size = { width: 1000, height: 500 };
  assert.deepEqual(navigatorDocumentPoint({ x: 60, y: 45 }, rect, size), { x: 500, y: 250 });
  assert.deepEqual(navigatorDocumentPoint({ x: -50, y: 100 }, rect, size), { x: 0, y: 500 });
});

test("inspection surface keeps histogram readback bounded and ships in every inventory", () => {
  const module = read("sdk/engine/site/navigator-panel.mjs");
  const html = read("sdk/engine/site/patchy.html");
  assert.equal(NAVIGATOR_SAMPLE_LIMIT, 65_536);
  assert.match(module, /SAMPLE_SIDE \/ Math\.max\(source\.width, source\.height\)/);
  assert.match(module, /sample\.getImageData\(0, 0, scratch\.width, scratch\.height\)/);
  assert.match(module, /\.2126.*\.7152.*\.0722/);
  assert.doesNotMatch(module, /source\.getContext[\s\S]*getImageData/);
  for (const id of ["navigatorCanvas", "histogramCanvas", "navigatorZoomInput", "documentInfoPanel"])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.match(read("CMakeLists.txt"), /sdk\/engine\/site\/navigator-panel\.mjs/);
  assert.match(read("scripts/release/build-self-hosted-release.mjs"), /"navigator-panel\.mjs"/);
  assert.match(read("sdk/engine/site/editor.mjs"), /from "\.\/navigator-panel\.mjs"/);
});
