import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeWorkspaceSnapshot, WORKSPACE_MODES,
  workspaceModeForState } from "../../sdk/engine/site/workspace-deck.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("workspace presets route only existing canonical panel surfaces", () => {
  assert.deepEqual(WORKSPACE_MODES.editing, { panel: "workspacePanelProperties", authoring: null });
  assert.deepEqual(WORKSPACE_MODES.painting, { panel: "workspacePanelControls", authoring: "brush" });
  assert.deepEqual(WORKSPACE_MODES.typography, { panel: "workspacePanelControls", authoring: "type" });
  assert.deepEqual(WORKSPACE_MODES.review, { panel: "workspacePanelInfo", authoring: null });
});

test("workspace persistence fails soft and retains bounded custom panel state", () => {
  assert.deepEqual(normalizeWorkspaceSnapshot(null), {
    mode: "editing", panel: "workspacePanelProperties", authoring: null,
  });
  assert.deepEqual(normalizeWorkspaceSnapshot({ mode: "painting", panel: "hostile", authoring: "color" }), {
    mode: "painting", panel: "workspacePanelControls", authoring: "brush",
  });
  assert.deepEqual(normalizeWorkspaceSnapshot({
    mode: "custom", panel: "workspacePanelStructure", authoring: "color",
  }), { mode: "custom", panel: "workspacePanelStructure", authoring: "color" });
  assert.deepEqual(normalizeWorkspaceSnapshot({ mode: "custom", panel: "../../etc", authoring: "hostile" }), {
    mode: "editing", panel: "workspacePanelProperties", authoring: null,
  });
});

test("manual panel and authoring navigation maps to named modes only on exact matches", () => {
  assert.equal(workspaceModeForState("workspacePanelProperties"), "editing");
  assert.equal(workspaceModeForState("workspacePanelControls", "brush"), "painting");
  assert.equal(workspaceModeForState("workspacePanelControls", "type"), "typography");
  assert.equal(workspaceModeForState("workspacePanelInfo"), "review");
  assert.equal(workspaceModeForState("workspacePanelHistory"), "custom");
  assert.equal(workspaceModeForState("workspacePanelControls", "color"), "custom");
});

test("production shell exposes one task-oriented workspace bar and delegates collapse", () => {
  const html = read("sdk/engine/site/patchy.html");
  const editor = read("sdk/engine/site/editor.mjs");
  const workspace = read("sdk/engine/site/workspace-deck.mjs");
  for (const id of ["workspaceModeSelect", "workspaceResetButton", "workspaceCollapseButton"])
    assert.match(html, new RegExp(`id="${id}"`));
  for (const value of ["editing", "painting", "typography", "review", "custom"])
    assert.match(html, new RegExp(`value="${value}"`));
  assert.match(editor, /installWorkspaceDeck/);
  assert.match(workspace, /byId\("togglePanelsButton"\)\?\.click\(\)/);
  assert.doesNotMatch(workspace, /classList\.toggle\("panels-hidden"\)/);
});

test("development and release inventories ship the workspace deck", () => {
  assert.match(read("CMakeLists.txt"), /sdk\/engine\/site\/workspace-deck\.mjs/);
  assert.match(read("scripts/release/build-self-hosted-release.mjs"), /"workspace-deck\.mjs"/);
  assert.match(read("sdk/engine/site/editor.mjs"), /from "\.\/workspace-deck\.mjs"/);
});
