import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { brushPreviewModel, gradientPreviewCss, normalizeAuthoringLibraryTab, normalizeAuthoringTab,
  patternPreviewCss,
  swatchTargetFromModifiers } from "../../sdk/engine/site/authoring-deck.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("authoring deck routes only declared stable control modes", () => {
  assert.equal(normalizeAuthoringTab("color"), "color");
  assert.equal(normalizeAuthoringTab("brush"), "brush");
  assert.equal(normalizeAuthoringTab("type"), "type");
  assert.equal(normalizeAuthoringTab("unknown"), "color");
});

test("color library routes only declared PhotoCraft-derived tabs", () => {
  for (const tab of ["color", "swatches", "gradients", "patterns"])
    assert.equal(normalizeAuthoringLibraryTab(tab), tab);
  assert.equal(normalizeAuthoringLibraryTab("hostile"), "color");
});

test("gradient and pattern previews are deterministic and sanitize projected colors", () => {
  assert.equal(gradientPreviewCss("black-white"), "linear-gradient(90deg, #000000, #ffffff)");
  assert.match(gradientPreviewCss("foreground-transparent", "#336699"), /#336699, transparent/);
  assert.equal(gradientPreviewCss("asset:test", "#010203", {
    previewStart: "#123456", previewEnd: "javascript:alert(1)",
  }), "linear-gradient(90deg, #123456, #010203)");
  assert.match(patternPreviewCss("dots", "#123456", "bad"), /#123456.*#ffffff/);
  assert.match(patternPreviewCss("checker", "bad", "#abcdef"), /#111111.*#abcdef/);
});

test("swatches default to foreground and modifiers explicitly select background", () => {
  assert.equal(swatchTargetFromModifiers({}), "foreground");
  assert.equal(swatchTargetFromModifiers({ altKey: true }), "background");
  assert.equal(swatchTargetFromModifiers({ metaKey: true }), "background");
  assert.equal(swatchTargetFromModifiers({ ctrlKey: true }), "background");
});

test("brush preview model is deterministic and bounded", () => {
  assert.deepEqual(brushPreviewModel({
    size: "8192", hardness: "-4", spacing: "0", angle: "240", roundness: "0", color: "invalid",
  }), { size: 4096, hardness: 0, spacing: 1, angle: 180, roundness: 1, color: "#111111" });
  assert.deepEqual(brushPreviewModel({
    size: "32", hardness: "70", spacing: "18", angle: "-35", roundness: "55", color: "#aabbcc",
  }), { size: 32, hardness: 70, spacing: 18, angle: -35, roundness: 55, color: "#aabbcc" });
});

test("production shell exposes one docked PhotoCraft-derived authoring deck", () => {
  const html = read("sdk/engine/site/patchy.html");
  const editor = read("sdk/engine/site/editor.mjs");
  const commands = read("sdk/engine/site/command-surface.mjs");
  for (const id of ["workspacePanelControls", "authoringColorPanel", "authoringBrushPanel",
    "authoringTypePanel", "authoringForegroundInput", "authoringBackgroundInput",
    "authoringSwatches", "authoringRecentSwatches", "authoringColorLibraryTab",
    "authoringSwatchesLibraryTab", "authoringGradientsLibraryTab", "authoringPatternsLibraryTab",
    "authoringGradientPresets", "authoringPatternPresets"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(editor, /installAuthoringDeck/);
  assert.match(editor, /authoringDeck\?\.reveal\("brush"\)/);
  assert.match(editor, /authoringDeck\?\.reveal\("type"\)/);
  assert.match(commands, /\["workspacePanelControlsButton", "Controls"\]/);
  assert.match(commands, /\["authoringGradientsLibraryTab", "Gradients"\]/);
  assert.match(commands, /\["authoringPatternsLibraryTab", "Patterns"\]/);
  assert.match(editor, /option\.dataset\.previewStart = asset\.start/);
  assert.match(editor, /option\.dataset\.previewKind = asset\.kind/);
});

test("development and self-hosted release inventories ship the authoring deck", () => {
  assert.match(read("CMakeLists.txt"), /sdk\/engine\/site\/authoring-deck\.mjs/);
  assert.match(read("scripts/release/build-self-hosted-release.mjs"), /"authoring-deck\.mjs"/);
  assert.match(read("sdk/engine/site/editor.mjs"), /from "\.\/authoring-deck\.mjs"/);
});

test("inline text remains explicit while settings and unrelated UI receive focus", () => {
  const editor = read("sdk/engine/site/editor.mjs");
  assert.doesNotMatch(editor, /inlineTextEditor"\)\.addEventListener\("blur"/);
  assert.match(editor,
    /if \(tool !== "text" && inlineTextDraft\) void commitInlineText\(\{ restoreFocus: false \}\)/);
  assert.match(editor,
    /if \(inlineTextDraft\) \{ void commitInlineText\(\{ restoreFocus: false \}\); return; \}/);
  assert.match(editor, /applyInlineTextButton"\)\.addEventListener\("click"/);
  assert.match(editor, /cancelInlineTextButton"\)\.addEventListener\("click"/);
});
