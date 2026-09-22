import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isEditableTarget, translateMessage } from "../../sdk/engine/site/shell-ui.mjs";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("English and Russian presentation strings share one deterministic boundary", () => {
  assert.equal(translateMessage("New", "en"), "New");
  assert.equal(translateMessage("New", "ru"), "Новый");
  assert.equal(translateMessage("Download PSB", "ru"), "Скачать PSB");
  assert.equal(translateMessage("Undo (Ctrl+Z)", "ru"), "Отменить (Ctrl+Z)");
  assert.equal(translateMessage("Revision 42", "ru"), "Ревизия 42");
  assert.equal(translateMessage("Layer name from user", "ru"), "Layer name from user");
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
  assert.match(css, /animation-duration: \.001ms !important/);
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
});
