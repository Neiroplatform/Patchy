import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_DOCK_LAYOUT, DOCK_LAYOUT_STORAGE_KEY, normalizeDockLayout } from "../../sdk/engine/site/dock-layout.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("dock layout normalization is bounded and fails hostile storage closed", () => {
  assert.equal(DOCK_LAYOUT_STORAGE_KEY, "patchy.dock-layout.v1");
  assert.deepEqual(normalizeDockLayout(null), DEFAULT_DOCK_LAYOUT);
  assert.deepEqual(normalizeDockLayout({ inspectorWidth: "1000", primaryShare: [] }), DEFAULT_DOCK_LAYOUT);
  assert.deepEqual(normalizeDockLayout({ inspectorWidth: 900, primaryShare: 0.95 }),
    { inspectorWidth: 520, primaryShare: 0.7 });
  assert.deepEqual(normalizeDockLayout({ inspectorWidth: 100, primaryShare: 0.02 }),
    { inspectorWidth: 260, primaryShare: 0.3 });
});

test("production shell exposes both accessible workspace separators", async () => {
  const html = await source("sdk/engine/site/patchy.html");
  assert.match(html, /id="inspectorResizer" role="separator"[^>]+aria-orientation="vertical"[^>]+aria-valuenow="316"/);
  assert.match(html, /id="inspectorSplitResizer" role="separator"[^>]+aria-label="Resize layer and panel areas"[^>]+aria-orientation="horizontal"[^>]+aria-valuenow="56"/);
  assert.equal([...html.matchAll(/id="inspectorResizer"/g)].length, 1);
  assert.equal([...html.matchAll(/id="inspectorSplitResizer"/g)].length, 1);
});

test("dock layout ships in development and immutable release inventories", async () => {
  const [editor, cmake, release, releaseTests, operationsTests] = await Promise.all([
    source("sdk/engine/site/editor.mjs"), source("CMakeLists.txt"),
    source("scripts/release/build-self-hosted-release.mjs"), source("tests/sdk/self_hosted_release_tests.mjs"),
    source("tests/sdk/self_hosted_operations_tests.mjs"),
  ]);
  assert.match(editor, /import \{ installDockLayout \} from "\.\/dock-layout\.mjs"/);
  assert.match(editor, /installDockLayout\(document\)/);
  for (const content of [cmake, release, releaseTests, operationsTests]) assert.match(content, /dock-layout\.mjs/);
});
