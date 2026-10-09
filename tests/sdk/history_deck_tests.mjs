import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeHistoryTab } from "../../sdk/engine/site/history-deck.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("history deck normalizes only real Patchy local-state capabilities", () => {
  assert.equal(normalizeHistoryTab("history"), "history");
  assert.equal(normalizeHistoryTab("versions"), "versions");
  assert.equal(normalizeHistoryTab("recovery"), "recovery");
  assert.equal(normalizeHistoryTab("actions"), "history");
  assert.equal(normalizeHistoryTab("layer-comps"), "history");
});

test("production shell exposes one History Versions Recovery deck without fake tabs", async () => {
  const html = await source("sdk/engine/site/patchy.html");
  assert.match(html, /class="history-deck-tabs" role="tablist" aria-label="History and local state"/);
  for (const [tab, target, mode] of [
    ["historyHistoryTab", "historyHistoryPane", "history"],
    ["historyVersionsTab", "versionHistoryDialog", "versions"],
    ["historyRecoveryTab", "recoveryDialog", "recovery"],
  ]) assert.match(html, new RegExp(`id="${tab}"[^>]+aria-controls="${target}"[^>]+data-history-tab="${mode}"`));
  assert.doesNotMatch(html, /data-history-tab="(?:actions|layer-comps)"/);
  for (const id of ["historyList", "recoveryDialog", "recoveryList", "cleanupRecoveryButton",
    "versionHistoryDialog", "versionLabelInput", "createVersionButton", "versionHistoryList"])
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, "g"))].length, 1, id);
});

test("existing local-state functions and all inventories own the docked deck", async () => {
  const [command, editor, cmake, release, releaseTests, operationsTests] = await Promise.all([
    source("sdk/engine/site/command-surface.mjs"), source("sdk/engine/site/editor.mjs"),
    source("CMakeLists.txt"), source("scripts/release/build-self-hosted-release.mjs"),
    source("tests/sdk/self_hosted_release_tests.mjs"), source("tests/sdk/self_hosted_operations_tests.mjs"),
  ]);
  for (const id of ["historyHistoryTab", "historyVersionsTab", "historyRecoveryTab"])
    assert.match(command, new RegExp(`\\["${id}"`));
  assert.match(editor, /import \{ installHistoryDeck \} from "\.\/history-deck\.mjs"/);
  assert.match(editor, /showVersions: \(\) => showVersionHistoryPanel\(\)/);
  assert.match(editor, /showRecovery: \(\) => showRecoveryPanel\(\)/);
  assert.match(editor, /workspaceStore\.createVersion/);
  assert.match(editor, /workspaceStore\.restoreVersion/);
  assert.match(editor, /workspaceStore\.restore\(/);
  assert.match(cmake, /sdk\/engine\/site\/history-deck\.mjs/);
  assert.match(release, /"history-deck\.mjs"/);
  assert.match(releaseTests, /"history-deck\.mjs"/);
  assert.match(operationsTests, /"history-deck\.mjs"/);
});
