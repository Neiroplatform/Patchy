import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizePropertiesTab } from "../../sdk/engine/site/properties-deck.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("properties deck normalizes only Properties and Adjustments", () => {
  assert.equal(normalizePropertiesTab("properties"), "properties");
  assert.equal(normalizePropertiesTab("adjustments"), "adjustments");
  assert.equal(normalizePropertiesTab("../../hostile"), "properties");
  assert.equal(normalizePropertiesTab(null), "properties");
});

test("production shell exposes one bounded Properties Adjustments deck", async () => {
  const html = await source("sdk/engine/site/patchy.html");
  assert.match(html, /class="properties-deck-tabs" role="tablist" aria-label="Layer properties and adjustments"/);
  for (const [tab, pane, mode] of [
    ["propertiesPropertiesTab", "propertiesPropertiesPane", "properties"],
    ["propertiesAdjustmentsTab", "propertiesAdjustmentsPane", "adjustments"],
  ]) {
    assert.match(html, new RegExp(`id="${tab}"[^>]+aria-controls="${pane}"[^>]+data-properties-tab="${mode}"`));
    assert.match(html, new RegExp(`id="${pane}"[^>]+aria-labelledby="${tab}"[^>]+data-properties-pane="${mode}"`));
  }
  const kinds = [...html.matchAll(/data-adjustment-preset="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(kinds.sort((left, right) => left - right), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const id of ["layerNameInput", "layerOpacityInput", "layerFillInput", "layerBlendSelect",
    "layerClipInput", "layerLockInput", "layerStyleSelect", "applyLayerStyleButton",
    "editLayerStyleButton", "editLayerTypeButton", "adjustmentDialog", "adjustmentKindInput",
    "adjustmentParameterFields", "commitAdjustmentButton"])
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, "g"))].length, 1, id);
});

test("Window routes and release inventories ship the properties deck", async () => {
  const [command, editor, cmake, release, releaseTests, operationsTests] = await Promise.all([
    source("sdk/engine/site/command-surface.mjs"), source("sdk/engine/site/editor.mjs"),
    source("CMakeLists.txt"), source("scripts/release/build-self-hosted-release.mjs"),
    source("tests/sdk/self_hosted_release_tests.mjs"), source("tests/sdk/self_hosted_operations_tests.mjs"),
  ]);
  for (const id of ["propertiesPropertiesTab", "propertiesAdjustmentsTab"])
    assert.match(command, new RegExp(`\\["${id}"`));
  assert.match(editor, /import \{ installPropertiesDeck \} from "\.\/properties-deck\.mjs"/);
  assert.match(editor, /openAdjustmentPreset: \(kind\) => openAdjustmentDialog\(\{ kind, forceCreate: true \}\)/);
  assert.match(editor, /const editing = !forceCreate && layer\?\.kind === 2/);
  assert.match(cmake, /sdk\/engine\/site\/properties-deck\.mjs/);
  assert.match(release, /"properties-deck\.mjs"/);
  assert.match(releaseTests, /"properties-deck\.mjs"/);
  assert.match(operationsTests, /"properties-deck\.mjs"/);
});
