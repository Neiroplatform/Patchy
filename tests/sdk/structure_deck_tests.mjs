import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeStructureTab } from "../../sdk/engine/site/structure-deck.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("document structure deck normalizes only its three bounded views", () => {
  assert.equal(normalizeStructureTab("layers"), "layers");
  assert.equal(normalizeStructureTab("channels"), "channels");
  assert.equal(normalizeStructureTab("paths"), "paths");
  assert.equal(normalizeStructureTab("../../hostile"), "layers");
  assert.equal(normalizeStructureTab(null), "layers");
});

test("production shell exposes one accessible Layers Channels Paths deck", async () => {
  const html = await source("sdk/engine/site/patchy.html");
  assert.match(html, /class="document-structure-tabs" role="tablist" aria-label="Document structure"/);
  for (const [tab, pane, mode] of [
    ["documentStructureLayersTab", "documentStructureLayersPane", "layers"],
    ["documentStructureChannelsTab", "documentStructureChannelsPane", "channels"],
    ["documentStructurePathsTab", "documentStructurePathsPane", "paths"],
  ]) {
    assert.match(html, new RegExp(`id="${tab}"[^>]+aria-controls="${pane}"[^>]+data-structure-tab="${mode}"`));
    assert.match(html, new RegExp(`id="${pane}"[^>]+aria-labelledby="${tab}"[^>]+data-structure-pane="${mode}"`));
  }
  assert.doesNotMatch(html, /workspacePanelStructure/);
  for (const id of [
    "createPixelLayerButton", "removeLayerButton", "toggleClippingButton", "mergeLayersButton",
    "saveChannelButton", "channelList", "channelRenameButton", "channelInvertButton",
    "channelUpButton", "channelDownButton", "channelDeleteButton", "savePathButton", "pathList",
    "pathRenameButton", "pathClipButton", "pathUpButton", "pathDownButton", "pathDeleteButton",
    "pathSelectionButton", "pathFillButton", "pathStrokeButton", "pathVectorMaskButton",
    "pathAnchorXInput", "pathAnchorYInput", "pathAnchorApplyButton",
  ]) assert.equal([...html.matchAll(new RegExp(`id="${id}"`, "g"))].length, 1, id);
});

test("Window routes and release inventories ship the structure deck", async () => {
  const [command, editor, cmake, release, releaseTests, operationsTests] = await Promise.all([
    source("sdk/engine/site/command-surface.mjs"), source("sdk/engine/site/editor.mjs"),
    source("CMakeLists.txt"), source("scripts/release/build-self-hosted-release.mjs"),
    source("tests/sdk/self_hosted_release_tests.mjs"), source("tests/sdk/self_hosted_operations_tests.mjs"),
  ]);
  for (const id of ["documentStructureLayersTab", "documentStructureChannelsTab", "documentStructurePathsTab"])
    assert.match(command, new RegExp(`\\["${id}"`));
  assert.match(editor, /import \{ installStructureDeck \} from "\.\/structure-deck\.mjs"/);
  assert.match(editor, /installStructureDeck\(document/);
  assert.match(cmake, /sdk\/engine\/site\/structure-deck\.mjs/);
  assert.match(release, /"structure-deck\.mjs"/);
  assert.match(releaseTests, /"structure-deck\.mjs"/);
  assert.match(operationsTests, /"structure-deck\.mjs"/);
});
