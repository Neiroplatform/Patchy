import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { installWorkspaceContext, WORKSPACE_OPTION_CONTROL_IDS,
  WORKSPACE_TOOL_CONTEXTS, workspaceContextForTool } from "../../sdk/engine/site/workspace-context.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("workspace contexts cover every shipped persistent and one-shot tool family", () => {
  assert.deepEqual(Object.keys(WORKSPACE_TOOL_CONTEXTS), [
    "move", "crop", "marquee", "lasso", "polygon", "magic", "quickSelect", "magnetic",
    "quickMask", "pan", "brush", "eraser", "mixer", "patternStamp", "clone", "heal",
    "spotHealing", "patch", "smudge", "blur", "sharpen", "dodge", "burn", "sponge",
    "gradient", "fill", "pen", "text",
  ]);
  assert.deepEqual(new Set(Object.values(WORKSPACE_TOOL_CONTEXTS).map(({ family }) => family)),
    new Set(["transform", "selection", "navigation", "paint", "retouch", "tone", "fill", "draw"]));
  for (const [tool, context] of Object.entries(WORKSPACE_TOOL_CONTEXTS)) {
    assert.ok(context.label, tool);
    assert.ok(context.target, tool);
    assert.ok(context.interaction, tool);
    assert.equal(new Set(context.controls).size, context.controls.length, tool);
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.controls));
  }
  assert.equal(workspaceContextForTool("unsupported"), WORKSPACE_TOOL_CONTEXTS.marquee);
});

test("selection, paint, retouch and tone contexts expose only relevant existing controls", () => {
  assert.deepEqual(WORKSPACE_TOOL_CONTEXTS.magic.controls,
    ["selectionModeInput", "selectionQuickFeatherInput", "selectionToleranceInput",
      "edgeContrastInput", "enhanceEdgeInput"]);
  assert.deepEqual(WORKSPACE_TOOL_CONTEXTS.brush.controls,
    ["brushPresetSelect", "brushSizeInput", "brushSoftnessInput", "brushOpacityInput",
      "brushColorInput", "paintTargetSelect"]);
  assert.deepEqual(WORKSPACE_TOOL_CONTEXTS.patch.controls,
    ["patchModeInput", "retouchSampleAllInput", "patchTransparentInput"]);
  assert.ok(WORKSPACE_TOOL_CONTEXTS.dodge.controls.includes("localToneRangeInput"));
  assert.ok(!WORKSPACE_TOOL_CONTEXTS.sponge.controls.includes("localToneRangeInput"));
  assert.ok(WORKSPACE_TOOL_CONTEXTS.sponge.controls.includes("localSpongeModeInput"));
  assert.ok(!WORKSPACE_TOOL_CONTEXTS.text.controls.includes("brushColorInput"));
});

test("renderer removes irrelevant controls from layout and the accessibility tree", () => {
  const toolbar = { dataset: {}, attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); } };
  const heading = { textContent: "" };
  const instruction = { textContent: "" };
  const labels = new Map(WORKSPACE_OPTION_CONTROL_IDS.map((id) => [id, { dataset: {}, hidden: false }]));
  const controls = new Map([...labels].map(([id, label]) => [id, { closest: () => label }]));
  const document = { getElementById(id) {
    if (id === "toolOptions") return toolbar;
    if (id === "activeToolContext") return heading;
    if (id === "toolInstruction") return instruction;
    return controls.get(id) || null;
  }, addEventListener() {} };
  const renderer = installWorkspaceContext(document, { translate: (value) => `t:${value}` });
  renderer.render("spotHealing");
  assert.equal(heading.textContent, "t:Spot Healing Brush");
  assert.match(instruction.textContent, /^t:Drag over an imperfection/);
  assert.equal(toolbar.dataset.tool, "spotHealing");
  assert.equal(toolbar.dataset.empty, "false");
  assert.equal(labels.get("retouchSoftnessInput").hidden, false);
  assert.equal(labels.get("selectionToleranceInput").hidden, true);
  renderer.render("pan");
  assert.equal(toolbar.dataset.empty, "false");
  assert.match(instruction.textContent, /^t:Drag the workspace/);
  assert.ok([...labels.values()].every(({ hidden }) => hidden));
});

test("production and release inventories ship the contextual workspace module", async () => {
  const [html, editor, cmake, release] = await Promise.all([
    source("sdk/engine/site/patchy.html"), source("sdk/engine/site/editor.mjs"),
    source("CMakeLists.txt"), source("scripts/release/build-self-hosted-release.mjs"),
  ]);
  assert.match(html, /id="toolOptions" role="toolbar"/);
  assert.match(html, /id="activeToolContext"/);
  assert.match(editor, /import \{ installWorkspaceContext \} from "\.\/workspace-context\.mjs"/);
  assert.match(editor, /workspaceContext\?\.render\(tool\)/);
  assert.match(cmake, /sdk\/engine\/site\/workspace-context\.mjs/);
  assert.match(release, /"workspace-context\.mjs"/);
});
