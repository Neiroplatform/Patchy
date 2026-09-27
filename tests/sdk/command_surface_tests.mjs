import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { COMMAND_GROUPS, filterCommandItems } from "../../sdk/engine/site/command-surface.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("command surface exposes one deterministic route to high-value editor actions", () => {
  assert.deepEqual(COMMAND_GROUPS.map(({ id }) => id), ["file", "edit", "layer", "select", "view", "help"]);
  const commands = COMMAND_GROUPS.flatMap(({ commands }) => commands);
  assert.ok(commands.length >= 45);
  assert.equal(new Set(commands.map(({ id }) => id)).size, commands.length);
  assert.equal(new Set(commands.map(({ targetId }) => targetId)).size, commands.length);
  for (const targetId of [
    "openButton", "newButton", "saveButton", "undoButton", "redoButton",
    "filterLayerButton", "layerTransformButton", "createMaskButton",
    "selectAllButton", "smoothSelectionButton", "zoomFitButton", "helpButton",
  ]) assert.ok(commands.some((command) => command.targetId === targetId), targetId);
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
  ]) assert.match(html, contract);
  assert.match(css, /\.command-menu-panel/);
  assert.match(css, /\.command-palette::backdrop/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]+\.command-menubar/);
  assert.match(editor, /import \{ installCommandSurface \} from "\.\/command-surface\.mjs"/);
  assert.match(editor, /installCommandSurface\(document/);
  assert.match(cmake, /sdk\/engine\/site\/command-surface\.mjs/);
  assert.match(release, /"command-surface\.mjs"/);
});
