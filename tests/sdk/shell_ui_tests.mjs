import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chooseRovingLayerId, isEditableTarget,
  translateMessage } from "../../sdk/engine/site/shell-ui.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("English and Russian presentation strings share one deterministic boundary", () => {
  assert.equal(translateMessage("New", "en"), "New");
  assert.equal(translateMessage("New", "ru"), "Новый");
  assert.equal(translateMessage("Download PSB", "ru"), "Скачать PSB");
  assert.equal(translateMessage("Undo (Ctrl+Z)", "ru"), "Отменить (Ctrl+Z)");
  assert.equal(translateMessage("Revision 42", "ru"), "Ревизия 42");
  assert.equal(translateMessage("Layer name from user", "ru"), "Layer name from user");
  for (const dynamic of [
    "Remove", "No local assets yet.", "Filtering selected layer · 42%",
    "Live engine preview · 64 × 48px", "Pixels · Mask off", "Revision 4 · 2 MB",
    "Rendering engine preview…", "Cancelling at the next safe filter checkpoint…",
  ]) assert.notEqual(translateMessage(dynamic, "ru"), dynamic, dynamic);
});

test("virtualized layers always expose one visible roving target", () => {
  const layers = Array.from({ length: 300 }, (_, id) => ({ id }));
  assert.equal(chooseRovingLayerId(layers.slice(0, 10), 299), 0);
  assert.equal(chooseRovingLayerId(layers.slice(90, 100), 95), 95);
  assert.equal(chooseRovingLayerId([], 95), null);
});

test("editable and IME events are protected from global editor shortcuts", () => {
  const target = (selector, isContentEditable = false) => ({ isContentEditable,
    matches: (query) => query.includes(selector) });
  assert.equal(isEditableTarget({ target: target("input") }), true);
  assert.equal(isEditableTarget({ target: target("textarea") }), true);
  assert.equal(isEditableTarget({ target: target("button", true) }), true);
  assert.equal(isEditableTarget({ target: target("button"), isComposing: true }), true);
  assert.equal(isEditableTarget({ target: target("button") }), false);
});

test("production shell exposes keyboard, localization, responsive and motion contracts", async () => {
  const [html, css, editor, shell] = await Promise.all([
    source("sdk/engine/site/patchy.html"), source("sdk/engine/site/editor.css"),
    source("sdk/engine/site/editor.mjs"), source("sdk/engine/site/shell-ui.mjs"),
  ]);
  for (const contract of [
    /class="skip-link"/, /role="toolbar"/, /role="status"/, /aria-atomic="true"/,
    /id="localeSelect"/, /value="en"/, /value="ru"/, /id="workspaceTitle"/,
  ]) assert.match(html, contract);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.spinner, \.selection-overlay \{ animation: none !important; \}/);
  assert.match(css, /transition-duration: \.001ms !important/);
  assert.match(editor, /locale: localizer\.locale/);
  assert.match(editor, /localizer\.setLocale/);
  assert.match(editor, /event\.isComposing/);
  assert.match(editor, /isEditableTarget\(event\)/);
  assert.match(editor, /const editingField = isEditableTarget\(event\);\s*if \(editingField\) return;\s*if \(key === "o"\)/);
  assert.match(editor, /\["ArrowUp", "ArrowDown", "Home", "End"\]/);
  assert.match(editor, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(shell, /installDialogFocusReturn/);
  assert.match(shell, /queueMicrotask\(\(\) => lastExternalFocus\.focus/);
  assert.match(shell, /event\.key === "Escape"/);
  assert.match(shell, /event\.shiftKey && document\.activeElement === first/);
});

test("shell contrast tokens meet text and non-text contrast floors", async () => {
  const css = await source("sdk/engine/site/editor.css");
  const token = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const rgb = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const luminance = (hex) => rgb(hex).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = (left, right) => {
    const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);
    return (high + .05) / (low + .05);
  };
  for (const surface of [token("surface-0"), token("surface-1")]) {
    assert.ok(contrast(token("text-faint"), surface) >= 4.5, `faint text on ${surface}`);
    assert.ok(contrast(token("line"), surface) >= 3, `line on ${surface}`);
    assert.ok(contrast(token("line-strong"), surface) >= 3, `strong line on ${surface}`);
  }
});

test("every static production UI string has an explicit Russian translation", async () => {
  const html = await source("sdk/engine/site/patchy.html");
  const decode = (value) => value.replaceAll("&amp;", "&").replaceAll("&hellip;", "…")
    .replace(/\s+/g, " ").trim();
  const strings = new Set();
  for (const match of html.matchAll(/>([^<>]+)</g)) {
    const value = decode(match[1]);
    if (value) strings.add(value);
  }
  for (const match of html.matchAll(/(?:aria-label|title|placeholder)="([^"]+)"/g)) {
    strings.add(decode(match[1]));
  }
  const invariant = new Set(["Patchy", "EN", "RU", "PSD", "PSB", "PNG", "JPEG", "WebP", "Arial"]);
  const missing = [...strings].filter((value) => /[A-Za-z]{2}/.test(value))
    .filter((value) => !invariant.has(value))
    .filter((value) => !/^\d+(?:\.\d+)?\s*(?:px|%|MB|GB)?$/i.test(value))
    .filter((value) => translateMessage(value, "ru") === value)
    .sort();
  assert.deepEqual(missing, []);
});

test("every literal production status and error has an explicit Russian translation", async () => {
  const editor = await source("sdk/engine/site/editor.mjs");
  const messages = new Set();
  for (const pattern of [
    /(?:setSessionState|showError|localizer\.setText)\([^,\n]+,\s*["`]([^"`$\n]+)["`]/g,
    /setBusy\([^,\n]+,\s*["`]([^"`$\n]+)["`]/g,
    /setBusy\([^,\n]+,\s*["`][^"`$\n]+["`],\s*["`]([^"`$\n]+)["`]/g,
  ]) for (const match of editor.matchAll(pattern)) messages.add(match[1]);
  const missing = [...messages].filter((value) => /[A-Za-z]{2}/.test(value))
    .filter((value) => translateMessage(value, "ru") === value).sort();
  assert.deepEqual(missing, []);
});
