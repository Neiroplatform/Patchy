import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { betaGuideStorageKey, chooseRovingLayerId, installBetaGuide, isEditableTarget,
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
    "Moving 3 states", "New document needs an estimated 1 MB plus 2 MB already retained, above this browser's 3 MB safety limit.",
    "Engine returned a 4 × 5 frame, expected 6 × 7", "Engine returned 8 RGBA bytes, expected 16",
    "Engine returned an unsupported frame transport: stream", "Browser could not encode image/webp",
    "Brightness is outside the supported range",
    "2 workspace(s) restored from confirmed snapshots; 1 could not be restored: abc; 1 had unconfirmed changes and were rolled back.",
    "1 recoverable workspace on this device.", "2 editable layers copied locally",
    "2 MB retained", "1 MB history", "512 KB cache", "3 GB limit",
    "Gradient: User sunset", "Pattern: User dots",
  ]) assert.notEqual(translateMessage(dynamic, "ru"), dynamic, dynamic);
  assert.equal(translateMessage("Gradient: User sunset", "ru"), "Градиент: User sunset");
  assert.equal(translateMessage("Applying Gaussian Blur", "ru"), "Применение: Размытие по Гауссу");
  assert.equal(translateMessage("Applying Brightness / Contrast", "ru"),
    "Применение: Яркость / Контраст");
  assert.equal(translateMessage("Applying filter", "ru"), "Применение: фильтр");
  assert.equal(translateMessage("Scaling image rejected", "ru"), "Масштабирование изображения: отклонено");
  assert.equal(translateMessage("Moving layers failed", "ru"), "Перемещение слоёв: ошибка");
  assert.equal(translateMessage("Encoding PSD", "ru"), "Кодирование PSD");
  assert.equal(translateMessage("Engine mode 9", "ru"), "Режим движка 9");
  assert.equal(translateMessage("Imported mode 4", "ru"), "Импортированный режим 4");
  assert.equal(translateMessage("Layer 7", "ru"), "Слой 7");
  assert.equal(translateMessage("3 layers", "ru"), "Слоёв: 3");
  assert.equal(translateMessage("8-bit RGB", "ru"), "8-бит RGB");
  assert.equal(translateMessage("Drop Shadow: 2 additional", "ru"), "Тень: дополнительных — 2");
  assert.equal(
    translateMessage("Imported stacked effects preserved — dropShadow: 2 additional, stroke: 1 additional.", "ru"),
    "Импортированные составные эффекты сохранены — Тень: дополнительных — 2, Обводка: дополнительных — 1.",
  );
  assert.equal(translateMessage("Free transform · 3 layers", "ru"), "Свободная трансформация · Слоёв: 3");
  assert.equal(translateMessage("right · indents 1/2/3", "ru"), "справа · отступы 1/2/3");
  assert.equal(translateMessage("center · indents 1/2/3", "ru"), "по центру · отступы 1/2/3");
  assert.equal(translateMessage("justify · indents 1/2/3", "ru"), "по ширине · отступы 1/2/3");
  assert.equal(
    translateMessage("Clipboard does not contain an image; could not restore the source document", "ru"),
    "В буфере обмена нет изображения; не удалось восстановить исходный документ",
  );
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

test("local-first beta guide stays available and delegates to real editor actions", async () => {
  const elements = new Map();
  const element = (id, extra = {}) => {
    const listeners = new Map();
    const value = {
      id, dataset: {}, disabled: false, open: false, textContent: "", clicks: 0, focusCalls: 0,
      addEventListener: (type, listener) => listeners.set(type, listener),
      dispatch(type, event = {}) { listeners.get(type)?.({ currentTarget: this, target: this, ...event }); },
      click() { this.clicks += 1; this.dispatch("click"); },
      focus() { this.focusCalls += 1; },
      showModal() { this.open = true; },
      close(returnValue) { this.open = false; this.returnValue = returnValue; this.dispatch("close"); },
      ...extra,
    };
    elements.set(id, value);
    return value;
  };
  const help = element("helpButton");
  const dialog = element("helpDialog");
  const emptyGuide = element("gettingStartedButton");
  const openGuide = element("helpOpenButton");
  const newGuide = element("helpNewButton");
  const recoveryGuide = element("helpRecoveryButton");
  const complete = element("completeGuideButton");
  const open = element("openButton");
  const create = element("newButton");
  const recovery = element("recoveryButton");
  const documentListeners = new Map();
  const document = {
    getElementById: (id) => elements.get(id) ?? null,
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    querySelector: () => null,
  };
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.ok(installBetaGuide(document, storage));
  assert.equal(help.textContent, "Getting started");
  help.click();
  assert.equal(dialog.open, true);
  openGuide.click();
  await new Promise(queueMicrotask);
  assert.equal(open.clicks, 1);
  assert.equal(dialog.returnValue, "action");
  emptyGuide.click();
  assert.equal(dialog.open, true);
  newGuide.click();
  await new Promise(queueMicrotask);
  assert.equal(create.clicks, 1);
  help.click();
  recoveryGuide.click();
  await new Promise(queueMicrotask);
  assert.equal(recovery.clicks, 1);
  help.click();
  complete.click();
  await new Promise(queueMicrotask);
  assert.equal(values.get(betaGuideStorageKey), "complete");
  assert.equal(help.textContent, "Help");
  assert.equal(dialog.returnValue, "complete");
  assert.ok(help.focusCalls > 0, "closing Help must restore focus to its invoker");
  assert.equal(installBetaGuide(document, storage), null);

  let prevented = false;
  documentListeners.get("keydown")({
    defaultPrevented: false, key: "?", metaKey: false, ctrlKey: false, altKey: false,
    target: { isContentEditable: false, matches: () => false },
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(dialog.open, true);
});

test("beta guide publishes support boundaries and responsive contracts", async () => {
  const [html, css, shell] = await Promise.all([
    source("sdk/engine/site/patchy.html"), source("sdk/engine/site/editor.css"),
    source("sdk/engine/site/shell-ui.mjs"),
  ]);
  for (const contract of [
    /id="helpButton"/, /id="helpDialog"/, /id="helpOpenButton"/,
    /id="helpRecoveryButton"/, /id="completeGuideButton"/,
    /Photoshop warning-free and 1,000-file corpus acceptance are still external release gates/,
  ]) assert.match(html, contract);
  assert.match(css, /\.shortcut-grid, \.help-columns \{ grid-template-columns: 1fr; \}/);
  assert.match(shell, /patchy\.beta-guide\.v1/);
  assert.match(shell, /document\.querySelector\("dialog\[open\]"\)/);
  assert.match(shell, /isEditableTarget\(event\)/);
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
  assert.match(editor, /localizer\.setText\(\$\("errorMessage"\)/);
  assert.match(editor, /setCustomValidity\(localizer\.text/);
  assert.match(editor, /event\.isComposing/);
  assert.match(editor, /isEditableTarget\(event\)/);
  assert.match(editor, /const editingField = isEditableTarget\(event\);\s*if \(editingField\) return;\s*if \(key === "o"\)/);
  assert.match(editor, /registerCommand\("view\.panels", "togglePanelsButton"/);
  assert.doesNotMatch(editor, /if \(key === "n"\).*executeCommand\("document\.new"\)/);
  assert.doesNotMatch(editor, /if \(event\.key === "F4"\).*executeCommand\("view\.panels"\)/);
  assert.doesNotMatch(html, /<dt>New document<\/dt><dd>.*<kbd>N<\/kbd>/);
  assert.doesNotMatch(html, /<dt>Show or hide panels<\/dt><dd><kbd>F4<\/kbd>/);
  assert.doesNotMatch(html, /<dt>Show or hide panels<\/dt><dd><kbd>Tab<\/kbd>/);
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
  const invariant = new Set([
    "Patchy", "EN", "RU", "PSD", "PSB", "PNG", "JPEG", "WebP", "Arial",
    "Ctrl", "Shift", "Space", "Tab",
  ]);
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

test("every literal textContent presentation branch has an explicit Russian translation", async () => {
  const editor = await source("sdk/engine/site/editor.mjs");
  const messages = new Set();
  for (const assignment of editor.matchAll(/\.textContent\s*=\s*([^;\n]+)/g)) {
    for (const literal of assignment[1].matchAll(/["`]([^"`$]+)["`]/g)) messages.add(literal[1]);
  }
  const implementationTokens = new Set([
    "undo", "fit", "opacity", "fillOpacity", "brushSizeInput", "edgeContrastInput",
    "layerFillInput", "layerOpacityInput", "selectionToleranceInput",
  ]);
  const missing = [...messages].map((value) => value.trim().replace(/^·\s*/, ""))
    .filter((value) => /[A-Za-z]{2}/.test(value))
    .filter((value) => !implementationTokens.has(value))
    .filter((value) => translateMessage(value, "ru") === value).sort();
  assert.deepEqual(missing, []);
});

test("every literal production action title has an explicit Russian translation", async () => {
  const editor = await source("sdk/engine/site/editor.mjs");
  const actions = [...editor.matchAll(/["`]([A-Z][A-Za-z]+ing(?: [^"`$\n]+)?)["`]/g)]
    .map((match) => match[1]);
  const missing = [...new Set(actions)].filter((value) => translateMessage(value, "ru") === value).sort();
  assert.deepEqual(missing, []);
  const mutationTitles = new Set();
  for (const name of ["mutate", "geometryMutation", "commitSelectionMask"]) {
    const pattern = new RegExp(`${name}\\(\\s*["\\x60]([^"\\x60$\\n]+)["\\x60]`, "g");
    for (const match of editor.matchAll(pattern)) mutationTitles.add(match[1]);
  }
  assert.deepEqual([...mutationTitles]
    .filter((value) => translateMessage(value, "ru") === value).sort(), []);
});

test("native prompt and confirmation copy crosses the localization boundary", async () => {
  const editor = await source("sdk/engine/site/editor.mjs");
  for (const match of editor.matchAll(/\b(?:confirm|prompt)\(([^\n]+)/g)) {
    assert.match(match[1], /localizer\.text/, match[0]);
  }
});

test("authored error details, generated labels and accessible names are inventoried", async () => {
  const editor = await source("sdk/engine/site/editor.mjs");
  const authoredErrors = [...editor.matchAll(/new (?:Error|RangeError|TypeError)\(["']([^"']+)["']\)/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(authoredErrors)]
    .filter((value) => translateMessage(value, "ru") === value).sort(), []);
  const objectLabels = [...editor.matchAll(/\blabel:\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(objectLabels)]
    .filter((value) => translateMessage(value, "ru") === value).sort(), []);
  const generatedNames = [...editor.matchAll(/(?:aria-label|title|placeholder)=\\?"([^"$]+)\\?"/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(generatedNames)]
    .filter((value) => /[A-Za-z]{2}/.test(value))
    .filter((value) => translateMessage(value, "ru") === value).sort(), []);
  for (const value of ["Uniform", "Gaussian", "Earlier edit", "Later edit"]) {
    assert.notEqual(translateMessage(value, "ru"), value, value);
  }
});
