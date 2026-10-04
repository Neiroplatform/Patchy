import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { COMMAND_GROUPS, TOOL_GROUPS, filterCommandItems } from "../../sdk/engine/site/command-surface.mjs";
import { WORKSPACE_TOOL_BUTTONS, WORKSPACE_TOOL_CONTEXTS } from "../../sdk/engine/site/workspace-context.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("command surface exposes one deterministic route to high-value editor actions", () => {
  assert.deepEqual(COMMAND_GROUPS.map(({ id }) => id),
    ["file", "edit", "image", "layer", "select", "filter", "view", "window", "help"]);
  const commands = COMMAND_GROUPS.flatMap(({ commands }) => commands);
  assert.ok(commands.length >= 55);
  assert.equal(new Set(commands.map(({ id }) => id)).size, commands.length);
  assert.equal(new Set(commands.map(({ targetId }) => targetId)).size, commands.length);
  for (const targetId of [
    "openButton", "newButton", "saveButton", "undoButton", "redoButton",
    "filterLayerButton", "layerTransformButton", "createMaskButton",
    "layerViaCopyButton",
    "selectAllButton", "smoothSelectionButton", "zoomFitButton", "helpButton",
    "transformButton", "workspacePanelLayersButton", "workspacePanelHistoryButton",
  ]) assert.ok(commands.some((command) => command.targetId === targetId), targetId);
});

test("tool rail exposes every existing tool through bounded semantic groups", () => {
  assert.deepEqual(TOOL_GROUPS.map(({ id }) => id),
    ["transform", "selection", "paint", "retouch", "tone", "fill", "draw", "navigation"]);
  const members = TOOL_GROUPS.flatMap(({ members }) => members);
  assert.equal(new Set(members).size, members.length);
  for (const targetId of ["moveToolButton", "cropToolButton", "quickMaskToolButton",
    "brushToolButton", "spotHealingToolButton", "sharpenToolButton", "fillToolButton",
    "textToolButton", "panToolButton"]) assert.ok(members.includes(targetId), targetId);
  assert.deepEqual(new Set(Object.values(WORKSPACE_TOOL_BUTTONS)), new Set(members));
  assert.deepEqual(new Set(Object.keys(WORKSPACE_TOOL_CONTEXTS)),
    new Set(Object.keys(WORKSPACE_TOOL_BUTTONS)));
  for (const [tool, context] of Object.entries(WORKSPACE_TOOL_CONTEXTS)) {
    assert.ok(context.label, `${tool} is missing a readable label`);
    assert.ok(context.interaction, `${tool} is missing an interaction contract`);
    assert.ok(context.target, `${tool} is missing a target contract`);
  }
});

test("icon-only actions use a complete readable first-party SVG vocabulary", async () => {
  const [html, css] = await Promise.all([
    source("sdk/engine/site/patchy.html"), source("sdk/engine/site/editor.css"),
  ]);
  const symbols = [...html.matchAll(/<symbol id="(icon-[^"]+)"/g)].map((match) => match[1]);
  const tools = [...html.matchAll(/<button class="tool-button"([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.equal(tools.length, 31);
  const toolIcons = [];
  for (const [, attributes, body] of tools) {
    assert.match(attributes, /aria-label="[^"]+"/);
    assert.match(attributes, /title="[^"]+"/);
    assert.match(body, /<svg class="ui-icon" aria-hidden="true"><use href="#(icon-[^"]+)"><\/use><\/svg>/);
    toolIcons.push(body.match(/href="#(icon-[^"]+)"/)?.[1]);
    assert.equal(body.replace(/<[^>]+>/g, "").trim(), "");
  }
  assert.equal(new Set(toolIcons).size, 31, "every rail action needs a distinct silhouette");
  for (const icon of toolIcons) assert.ok(symbols.includes(icon), icon);
  for (const id of ["undoButton", "redoButton", "copyPixelsButton", "pastePixelsButton"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*><svg class="ui-icon" aria-hidden="true">`));
  }
  assert.match(css, /\.ui-icon \{[\s\S]+stroke: currentColor/);
  assert.match(css, /\.tool-cluster > \.tool-button::after[\s\S]+content: attr\(aria-label\)/);
  assert.match(css, /\.visibility-button\[aria-label\^="Hide"\]::after/);
  assert.match(css, /\.layer-row \.reorder-button:nth-last-child\(2\)::before/);
  assert.match(css, /\.history-row\[aria-selected="true"\] \.history-marker::before/);
});

test("command filtering requires every normalized term and preserves source order", () => {
  const commands = [
    { label: "Place Smart Object", groupLabel: "Layer", shortcut: "" },
    { label: "Open Smart Object contents", groupLabel: "Layer", shortcut: "" },
    { label: "Open document", groupLabel: "File", shortcut: "Ctrl+O" },
  ];
  assert.deepEqual(filterCommandItems(commands, "smart layer"), commands.slice(0, 2));
  assert.deepEqual(filterCommandItems(commands, "ctrl o"), commands.slice(2));
  assert.deepEqual(filterCommandItems(commands, "missing"), []);
  assert.deepEqual(filterCommandItems(commands, ""), commands);
});

test("production shell stages and publishes the accessible command surface", async () => {
  const [html, css, editor, cmake, release] = await Promise.all([
    source("sdk/engine/site/patchy.html"), source("sdk/engine/site/editor.css"),
    source("sdk/engine/site/editor.mjs"), source("CMakeLists.txt"),
    source("scripts/release/build-self-hosted-release.mjs"),
  ]);
  for (const contract of [
    /id="commandMenuBar" aria-label="Application menu"/,
    /id="commandPaletteButton"[^>]+aria-keyshortcuts="Control\+K Meta\+K"/,
    /id="commandPalette" aria-labelledby="commandPaletteTitle"/,
    /id="commandSearchInput" type="search"/,
    /id="commandResults" role="listbox"/,
    /class="workspace-panel-tabs" role="tablist"/,
    /id="workspacePanelLayers" role="tabpanel"/,
    /id="workspacePanelInfo" role="tabpanel"/,
  ]) assert.match(html, contract);
  assert.match(css, /\.command-menu-panel/);
  assert.match(css, /\.command-submenu-panel/);
  assert.match(css, /\.tool-group-menu/);
  assert.match(css, /\.tool-cluster[\s\S]+width: 36px/);
  assert.match(css, /\.tool-group-toggle[\s\S]+position: absolute/);
  assert.match(css, /\.workspace-panel-tabs/);
  assert.match(css, /\.command-palette::backdrop/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]+\.command-menubar/);
  assert.match(editor, /import \{ installCommandSurface \} from "\.\/command-surface\.mjs"/);
  assert.match(editor, /installCommandSurface\(document/);
  assert.match(editor, /installRovingToolbar\([^\n]+"\.tool-button:not\(\[hidden\]\)"\)/);
  assert.match(await source("sdk/engine/site/command-surface.mjs"), /const MENU_SUBGROUPS/);
  assert.match(html, /id="canvasContextMenu" role="menu"/);
  assert.match(editor, /copyLayerSelection\(/);
  assert.match(editor, /addEventListener\("contextmenu"/);
  assert.match(css, /\.canvas-context-menu/);
  assert.match(cmake, /sdk\/engine\/site\/command-surface\.mjs/);
  assert.match(release, /"command-surface\.mjs"/);
});
