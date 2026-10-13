import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { BUNDLED_FONT_CATALOG, BUNDLED_FONT_FAMILIES,
  loadBundledFontFamily } from "../../sdk/engine/site/font-catalog.mjs";

const root = new URL("../../", import.meta.url);

test("bundled browser catalog exposes 13 unique families and 35 licensed faces", async () => {
  assert.equal(BUNDLED_FONT_CATALOG.length, 13);
  assert.equal(BUNDLED_FONT_FAMILIES.length, 13);
  assert.equal(new Set(BUNDLED_FONT_FAMILIES).size, 13);
  assert.equal(BUNDLED_FONT_CATALOG.reduce((count, entry) => count + entry.faces.length, 0), 35);
  for (const entry of BUNDLED_FONT_CATALOG) {
    assert.ok(entry.family);
    assert.ok(Object.isFrozen(entry));
    const directories = new Set();
    for (const face of entry.faces) {
      assert.match(face.source, /^fonts\/[a-z0-9_]+\/[A-Za-z0-9-]+\.ttf$/);
      assert.ok(["400", "700"].includes(face.weight));
      assert.ok(["normal", "italic"].includes(face.style));
      const relative = face.source.replace(/^fonts\//, "third_party/fonts-web/");
      await access(new URL(relative, root));
      directories.add(relative.split("/").slice(0, -1).join("/"));
    }
    for (const directory of directories) await access(new URL(`${directory}/OFL.txt`, root));
  }
});

test("font loader uses same-origin immutable package URLs and registers every face", async () => {
  const constructed = [];
  class FakeFontFace {
    constructor(family, source, descriptors) {
      this.family = family; this.source = source; this.descriptors = descriptors; constructed.push(this);
    }
    async load() { this.loaded = true; return this; }
  }
  const added = []; const fontSet = { add(face) { added.push(face); } };
  const loaded = await loadBundledFontFamily("Montserrat", { FontFaceClass: FakeFontFace, fontSet,
    baseUrl: "https://editor.example/assets/font-catalog.mjs" });
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded, added);
  assert.ok(constructed.every(({ family, source, loaded: ready }) => family === "Montserrat" && ready &&
    source.startsWith('url("https://editor.example/assets/fonts/montserrat/')));
  assert.deepEqual(await loadBundledFontFamily("Not installed", { FontFaceClass: FakeFontFace, fontSet,
    baseUrl: "https://editor.example/assets/font-catalog.mjs" }), []);
});

test("production package stages the font catalog and complete local font tree", async () => {
  const [cmake, editor, html] = await Promise.all([
    readFile(new URL("CMakeLists.txt", root), "utf8"),
    readFile(new URL("sdk/engine/site/editor.mjs", root), "utf8"),
    readFile(new URL("sdk/engine/site/patchy.html", root), "utf8"),
  ]);
  assert.match(cmake, /sdk\/engine\/site\/font-catalog\.mjs/);
  assert.match(cmake, /copy_directory[\s\S]*PATCHY_BUNDLED_FONTS_WEB_DIR[\s\S]*PATCHY_WASM_SDK_SITE_DIR\}\/fonts/);
  assert.match(editor, /loadBundledFontFamily/);
  for (const id of ["textToolFontInput", "textToolPanelFontInput", "textFontInput"])
    assert.match(html, new RegExp(`<select id="${id}"`));
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|fontPresetList/);
});
