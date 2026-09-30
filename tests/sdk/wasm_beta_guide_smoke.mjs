import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const baseUrl = process.argv[2];
const browserName = process.argv[3] || "chromium";
if (!baseUrl || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node tests/sdk/wasm_beta_guide_smoke.mjs <served-repository-url> [chromium|firefox|webkit]");
  process.exit(2);
}

async function loadPlaywright() {
  try { return await import("playwright"); }
  catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) throw new Error(
      "Install playwright or set PATCHY_PLAYWRIGHT_ROOT to its package directory", { cause: error });
    return createRequire(import.meta.url)(root);
  }
}

const playwright = await loadPlaywright();
const browserType = playwright[browserName];
const launchOptions = browserName === "chromium" && process.env.PATCHY_BROWSER_CHANNEL
  ? { channel: process.env.PATCHY_BROWSER_CHANNEL } : {};
const browser = await browserType.launch({ headless: true, ...launchOptions });
async function closeBrowserWithDeadline() {
  const teardownWatchdog = setTimeout(() => {
    console.error(`BETA-GUIDE-SOURCE-TEARDOWN-TIMEOUT browser=${browserName}`);
    process.exit(1);
  }, 15_000);
  try {
    await browser.close();
  } finally {
    clearTimeout(teardownWatchdog);
  }
}

let page;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "showOpenFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "showSaveFilePicker", { configurable: true, value: undefined });
  });
} catch (error) {
  console.error(`BETA-GUIDE-SOURCE-ERROR browser=${browserName} ${error?.stack || error}`);
  await closeBrowserWithDeadline();
  throw error;
}
const pageErrors = [];
const failedRequests = [];
const unexpectedNetwork = [];
let acceptedDialogs = 0;
const expectedOrigin = new URL(baseUrl).origin;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("requestfailed", (request) => failedRequests.push(
  `${request.url()} ${request.failure()?.errorText || "failed"}`));
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith("http") && new URL(url).origin !== expectedOrigin) unexpectedNetwork.push(url);
});
page.on("dialog", async (dialog) => {
  acceptedDialogs++;
  await dialog.accept();
});

const editorUrl = `${baseUrl.replace(/\/$/, "")}/build/wasm-sdk/site/patchy.html?beta-guide-smoke=1`;
const waitUntilReady = () => page.waitForFunction(() =>
  document.querySelector(".editor-shell")?.dataset.state === "ready" &&
  document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
{ timeout: 90_000 });

async function closeActiveDocument() {
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=close-start dialogs=${acceptedDialogs}`);
  await page.click('#documentTabs .document-tab[data-active="true"] button[aria-hidden="true"]');
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 0 &&
    document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=close-complete dialogs=${acceptedDialogs}`);
}

async function runPaletteCommand(targetId) {
  await page.click("#commandPaletteButton");
  await page.click(`#commandResults [data-command-target="${targetId}"]:not(:disabled)`);
}

async function createStarterPreset(id, width, height) {
  await page.click("#emptyNewButton");
  await page.click(`[data-starter-preset="${id}"]`);
  await page.waitForFunction(({ expectedWidth, expectedHeight }) =>
    document.querySelector("#detailCanvas")?.textContent === `${expectedWidth} × ${expectedHeight}` &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { expectedWidth: width, expectedHeight: height }, { timeout: 90_000 });
  await closeActiveDocument();
}

async function createCustomStarter(width, height, format, { keyboard = false } = {}) {
  await page.click("#emptyNewButton");
  await page.fill("#starterWidthInput", String(width));
  await page.fill("#starterHeightInput", String(height));
  if (keyboard) await page.locator("#starterHeightInput").press("Enter");
  else await page.click("#starterCustomCreateButton");
  await page.waitForTimeout(250);
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=custom-${width}x${height} state=${JSON.stringify(await page.evaluate(() => ({
    dialogOpen: document.querySelector("#starterDialog")?.open,
    canvas: document.querySelector("#detailCanvas")?.textContent,
    revision: document.querySelector("#detailRevision")?.textContent,
    format: document.querySelector("#saveFormatSelect")?.value,
    recovery: document.querySelector("#recoveryLabel")?.dataset.state,
    busy: document.querySelector(".editor-shell")?.getAttribute("aria-busy"),
    error: document.querySelector("#errorPanel")?.textContent,
  })))}`);
  await page.waitForFunction(({ expectedWidth, expectedHeight, expectedFormat }) =>
    document.querySelector("#detailCanvas")?.textContent === `${expectedWidth} × ${expectedHeight}` &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector("#saveFormatSelect")?.value === expectedFormat &&
    ["confirmed", "error"].includes(document.querySelector("#recoveryLabel")?.dataset.state) &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { expectedWidth: width, expectedHeight: height, expectedFormat: format }, { timeout: 90_000 });
  if (keyboard) {
    assert.equal(await page.evaluate(() => document.activeElement?.id), "canvasViewport",
      "keyboard starter creation did not move focus to the document canvas");
  }
  return page.locator("#recoveryLabel").getAttribute("data-state");
}

try {
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await waitUntilReady();
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=ready`);
  assert.equal((await page.textContent("#helpButton")).trim(), "Getting started");
  assert.deepEqual(await page.locator(".command-menu-trigger").allTextContents(),
    ["File", "Edit", "Image", "Layer", "Select", "Filter", "View", "Window", "Help"]);
  assert.equal(await page.locator(".tool-cluster").count(), 8,
    "workspace tools were not collapsed into the expected semantic groups");
  assert.equal(await page.locator(".tool-group-toggle").evaluateAll((toggles) =>
    toggles.every((toggle) => toggle.getBoundingClientRect().width >= 24 &&
      toggle.getBoundingClientRect().height >= 24)), true,
  "tool group disclosures violate the WCAG 2.2 minimum target size");
  assert.equal(await page.locator(".tool-cluster").evaluateAll((clusters) => clusters.every((cluster) => {
    const primary = cluster.querySelector(":scope > .tool-button").getBoundingClientRect();
    const disclosure = cluster.querySelector(":scope > .tool-group-toggle").getBoundingClientRect();
    return primary.right <= disclosure.left && primary.width >= 24 && primary.height >= 24;
  })), true, "primary tools and disclosures overlap or violate the target floor");
  assert.deepEqual(await page.evaluate(() =>
    [...document.querySelectorAll("[data-workspace-panel]")].filter((panel) => !panel.hidden)
      .map((panel) => panel.id)), ["workspacePanelLayers", "workspacePanelProperties"]);
  assert.equal(await page.getAttribute("#workspacePanelLayers", "role"), "region");
  assert.equal(await page.isHidden("#workspacePanelLayersButton"), true,
    "desktop Layers primary region must not masquerade as an inactive tab");
  assert.equal(await page.evaluate(() => {
    const stage = document.querySelector(".stage").getBoundingClientRect();
    const inspector = document.querySelector(".inspector").getBoundingClientRect();
    return stage.right <= inspector.left + .5;
  }), true, "active stage content overlaps the inspector column");

  await page.click('[data-tool-group="selection"] .tool-group-toggle');
  assert.equal(await page.locator('[data-tool-group="selection"] .tool-group-menu [role="menuitem"]')
    .count(), 6);
  await page.click("#lassoToolButton");
  assert.equal(await page.$eval('[data-tool-group="selection"] > .tool-button', (button) => button.id),
    "lassoToolButton", "selected nested tool was not promoted to the visible rail slot");
  assert.equal(await page.getAttribute('[data-tool-group="selection"] .tool-group-toggle', "aria-expanded"),
    "false");
  const selectionDisclosure = page.locator('[data-tool-group="selection"] .tool-group-toggle');
  await selectionDisclosure.focus();
  await selectionDisclosure.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "menuitem",
    "keyboard disclosure did not focus the first nested tool");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("tool-group-toggle")), true,
    "closing a tool flyout did not return focus to its disclosure");

  await page.click("#workspacePanelHistoryButton");
  assert.deepEqual(await page.evaluate(() =>
    [...document.querySelectorAll("[data-workspace-panel]")].filter((panel) => !panel.hidden)
      .map((panel) => panel.id)), ["workspacePanelLayers", "workspacePanelHistory"]);
  await page.getByRole("button", { name: "Window", exact: true }).click();
  await page.click('#commandMenu-window [data-command-target="workspacePanelPropertiesButton"]');
  assert.deepEqual(await page.evaluate(() =>
    [...document.querySelectorAll("[data-workspace-panel]")].filter((panel) => !panel.hidden)
      .map((panel) => panel.id)), ["workspacePanelLayers", "workspacePanelProperties"]);
  await page.locator("#workspacePanelPropertiesButton").press("ArrowRight");
  assert.equal(await page.getAttribute("#workspacePanelHistoryButton", "aria-selected"), "true",
    "ArrowRight did not move between workspace panel tabs");
  await page.locator("#workspacePanelHistoryButton").press("Home");
  assert.equal(await page.getAttribute("#workspacePanelPropertiesButton", "aria-selected"), "true",
    "Home did not return to the first secondary workspace panel tab");
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=workspace-ia`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.click("#emptyNewButton");
  const starterLayout = await page.evaluate(() => {
    const dialog = document.querySelector("#starterDialog");
    return {
      dialogWidth: dialog.getBoundingClientRect().width,
      presetColumns: getComputedStyle(document.querySelector(".starter-presets"))
        .gridTemplateColumns.split(" ").length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      transitionMs: Number.parseFloat(getComputedStyle(dialog).transitionDuration),
      targetHeights: [...dialog.querySelectorAll("button, input")]
        .map((button) => button.getBoundingClientRect().height),
    };
  });
  assert.ok(starterLayout.dialogWidth <= 390, "Starter dialog overflows the mobile viewport");
  assert.equal(starterLayout.presetColumns, 1);
  assert.equal(starterLayout.horizontalOverflow, false);
  assert.ok(starterLayout.transitionMs <= .001);
  assert.equal(starterLayout.targetHeights.every((height) => height >= 24), true,
    "Starter controls violate the WCAG 2.2 minimum target size");
  await page.click("#starterCloseButton");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=starter-layout`);

  await page.focus("#emptyNewButton");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#starterDialog[open]");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#starterDialog[open]", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "emptyNewButton",
    "closing the starter did not return focus to its invoker");
  await page.click("#emptyNewButton");
  await page.fill("#starterWidthInput", "0");
  await page.click("#starterCustomCreateButton");
  assert.equal(await page.isVisible("#starterError"), true,
    "invalid starter dimensions did not fail before document creation");
  assert.equal((await page.textContent("#detailRevision")).trim(), "-");
  await page.click('[data-starter-preset="blank"]');
  await page.waitForFunction(() => document.querySelector("#detailCanvas")?.textContent === "1600 × 1000" &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  assert.equal(await page.evaluate(() => {
    const stage = document.querySelector(".stage").getBoundingClientRect();
    const inspector = document.querySelector(".inspector").getBoundingClientRect();
    return stage.right <= inspector.left + .5;
  }), true, "document tool options overlap the inspector column");

  await page.focus("#canvasViewport");
  await page.keyboard.press("Shift+W");
  assert.equal(await page.$eval('[data-tool-group="selection"] > .tool-button', (button) => button.id),
    "quickSelectToolButton", "shortcut selection did not promote the active tool");
  assert.deepEqual(await page.locator("#toolOptions [data-tool-option]:not([hidden])")
    .evaluateAll((labels) => labels.map((label) => label.dataset.toolOption)),
  ["brushSizeInput", "selectionToleranceInput", "edgeContrastInput", "enhanceEdgeInput"]);
  await page.keyboard.press("b");
  assert.deepEqual(await page.locator("#toolOptions [data-tool-option]:not([hidden])")
    .evaluateAll((labels) => labels.map((label) => label.dataset.toolOption)),
  ["brushSizeInput", "brushColorInput", "paintTargetSelect"]);
  assert.equal(await page.locator("#toolOptions [data-tool-option][hidden] input, #toolOptions [data-tool-option][hidden] select")
    .evaluateAll((controls) => controls.every((control) => control.getClientRects().length === 0)), true,
  "irrelevant tool controls remain in layout or the accessibility surface");

  const revisionBeforeCancel = (await page.textContent("#detailRevision")).trim();
  await page.click("#shapeLayerButton");
  await page.click('#shapeDialog button[value="cancel"]');
  assert.equal((await page.textContent("#detailRevision")).trim(), revisionBeforeCancel,
    "cancelling shape creation changed the document revision");
  await page.click("#shapeLayerButton");
  await page.click("#commitShapeButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "1" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null, { timeout: 90_000 });
  assert.equal((await page.textContent("#shapeLayerButton")).trim(), "Edit shape");
  assert.equal((await page.textContent("#editLayerTypeButton")).trim(), "Edit shape");
  await page.click("#editLayerTypeButton");
  assert.equal(await page.isVisible("#shapeDialog[open]"), true);
  await page.click('#shapeDialog button[value="cancel"]');
  assert.equal((await page.textContent("#detailRevision")).trim(), "1");
  const selectedShape = page.locator('.layer-row[data-active="true"] .layer-select-button');
  await selectedShape.click();
  await page.locator('.layer-row[data-active="true"] .layer-select-button').click();
  await page.waitForSelector("#shapeDialog[open]");
  await page.click('#shapeDialog button[value="cancel"]');

  await page.click("#adjustmentLayerButton");
  await page.click("#commitAdjustmentButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "2" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null, { timeout: 90_000 });
  assert.equal((await page.textContent("#adjustmentLayerButton")).trim(), "Edit adjustment");
  assert.equal((await page.textContent("#editLayerTypeButton")).trim(), "Edit adjustment");
  await page.click("#editLayerTypeButton");
  assert.equal(await page.isVisible("#adjustmentDialog[open]"), true);
  await page.click('#adjustmentDialog button[value="cancel"]');

  await page.click("#textLayerButton");
  await page.fill("#textValueInput", "Contextual workspace");
  await page.click("#commitTextButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "3" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null, { timeout: 90_000 });
  assert.equal((await page.textContent("#textLayerButton")).trim(), "Edit text");
  assert.equal((await page.textContent("#editLayerTypeButton")).trim(), "Edit text");

  for (const viewport of [
    { width: 1440, height: 900, panels: 2 }, { width: 1024, height: 768, panels: 2 },
    { width: 820, height: 900, panels: 1 }, { width: 390, height: 844, panels: 1 },
    { width: 320, height: 720, panels: 1 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      visiblePanels: [...document.querySelectorAll("[data-workspace-panel]")]
        .filter((panel) => !panel.hidden).map((panel) => panel.id),
      primaryTabHidden: document.querySelector("#workspacePanelLayersButton").hidden,
      primaryRole: document.querySelector("#workspacePanelLayers").getAttribute("role"),
      stageRight: document.querySelector(".stage").getBoundingClientRect().right,
      viewportWidth: innerWidth,
    }));
    assert.equal(state.overflow, false, `workspace overflows at ${viewport.width}px`);
    assert.equal(state.visiblePanels.length, viewport.panels,
      `workspace panel composition is wrong at ${viewport.width}px: ${state.visiblePanels}`);
    assert.equal(state.primaryTabHidden, viewport.width > 820);
    assert.equal(state.primaryRole, viewport.width > 820 ? "region" : "tabpanel");
    assert.ok(state.stageRight <= state.viewportWidth + .5,
      `stage exceeds viewport at ${viewport.width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal(acceptedDialogs, 0,
    "contextual create, edit and responsive checks must not invent confirmation dialogs");
  const [contextualDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    runPaletteCommand("saveAsButton"),
  ]);
  const contextualPath = await contextualDownload.path();
  const contextualBytes = await readFile(contextualPath);
  assert.equal(contextualBytes.subarray(0, 4).toString("ascii"), "8BPS");
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true" &&
    document.querySelector(".editor-shell")?.dataset.state === "document", null, { timeout: 90_000 });
  await closeActiveDocument();
  const dialogsAfterContextualDownload = acceptedDialogs;
  await page.setInputFiles("#fileInput", {
    name: "contextual-workspace.psd", mimeType: "image/vnd.adobe.photoshop", buffer: contextualBytes,
  });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "document" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true" &&
    document.querySelectorAll(".layer-row").length >= 3, null, { timeout: 90_000 });
  for (const [kind, dialog, expected] of [
    ["Shape", "shapeDialog", "Create shape"],
    ["Adjustment", "adjustmentDialog", "Brightness / Contrast"],
    ["Text", "textDialog", "Contextual workspace"],
  ]) {
    const row = page.locator(".layer-row").filter({ has: page.locator(".layer-kind", { hasText: kind }) }).first();
    await row.locator(".layer-select-button").click();
    await page.click("#editLayerTypeButton");
    assert.equal(await page.isVisible(`#${dialog}[open]`), true, `${kind} did not reopen after layered save`);
    if (kind === "Shape") assert.ok(Number(await page.inputValue("#shapeWidthInput")) > 0);
    if (kind === "Adjustment") assert.equal((await page.locator("#adjustmentKindInput option:checked").textContent()).trim(), expected);
    if (kind === "Text") assert.equal(await page.inputValue("#textValueInput"), expected);
    await page.click(`#${dialog} button[value="cancel"]`);
  }
  await closeActiveDocument();
  await contextualDownload.delete();
  await createStarterPreset("social", 1080, 1080);
  await createStarterPreset("presentation", 1920, 1080);
  await createStarterPreset("print-a4", 2480, 3508);
  assert.equal(acceptedDialogs, dialogsAfterContextualDownload,
    "clean starter documents must close without a destructive-change confirmation");
  const starterRecoveryState = await createCustomStarter(640, 480, "psd", { keyboard: true });
  await closeActiveDocument();
  assert.equal(await createCustomStarter(30000, 1, "psd"), starterRecoveryState);
  await closeActiveDocument();
  assert.equal(await createCustomStarter(30001, 1, "psb"), starterRecoveryState);
  const [psbDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    runPaletteCommand("saveAsButton"),
  ]);
  const psbBytes = await readFile(await psbDownload.path());
  const psbFilename = psbDownload.suggestedFilename();
  assert.equal(psbFilename.endsWith(".psb"), true,
    `large starter download lost its PSB filename: ${psbFilename}`);
  assert.equal(psbBytes.subarray(0, 4).toString("ascii"), "8BPS");
  assert.equal(psbBytes.readUInt16BE(4), 2, "large starter did not encode PSB version 2");
  await psbDownload.delete();
  await closeActiveDocument();
  assert.equal(acceptedDialogs, dialogsAfterContextualDownload,
    "checkpointed clean starters must not invent destructive-change confirmations");

  await runPaletteCommand("recoveryButton");
  if (starterRecoveryState === "confirmed") {
    const psbRecovery = page.locator(".recovery-row", { hasText: "Untitled.psb" });
    await psbRecovery.getByRole("button", { name: "Recover" }).click();
    await page.waitForFunction(() =>
      document.querySelector("#detailCanvas")?.textContent === "30001 × 1" &&
      document.querySelector("#saveFormatSelect")?.value === "psb" &&
      document.querySelector("#recoveryLabel")?.dataset.state === "confirmed" &&
      document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
    null, { timeout: 90_000 });
    await closeActiveDocument();
  } else {
    assert.match(await page.locator("#recoverySummary").textContent(), /unavailable/i);
    await page.click('#recoveryDialog button[value="cancel"]');
  }
  assert.equal(acceptedDialogs, dialogsAfterContextualDownload,
    "recovering an unchanged checkpoint must not invent a dirty-close confirmation");

  await page.click("#helpButton");
  await page.waitForSelector("#helpDialog[open]");
  assert.equal((await page.textContent("#helpDialogTitle")).trim(), "Start editing locally");
  assert.match(await page.textContent("#helpDialog"), /1,000-file corpus acceptance/);
  assert.equal(await page.getAttribute('#helpDialog a[href="./capabilities.html"]', "target"), "_blank");
  await page.click("#helpNewButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await closeActiveDocument();

  await page.click("#helpButton");
  await page.click("#completeGuideButton");
  assert.equal((await page.textContent("#helpButton")).trim(), "Help");
  assert.equal(await page.evaluate(() => localStorage.getItem("patchy.beta-guide.v1")), "complete");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitUntilReady();
  assert.equal((await page.textContent("#helpButton")).trim(), "Help");

  await page.keyboard.press("Control+K");
  await page.waitForSelector("#commandPalette[open]");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "commandSearchInput",
    "the command palette did not focus its search field");
  await page.fill("#commandSearchInput", "new");
  const newCommand = page.locator('#commandResults [data-command-target="newButton"]:not(:disabled)');
  assert.match(await newCommand.textContent(), /New/i);
  await newCommand.click();
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await page.keyboard.press("Control+K");
  await page.fill("#commandSearchInput", "save");
  const saveCommand = page.locator('#commandResults [data-command-target="saveButton"]');
  assert.equal(await saveCommand.isDisabled(), false,
    "the command palette did not mirror the enabled document Save action");
  await page.keyboard.press("Escape");

  const fileMenu = page.locator(".command-menu").filter({ has: page.getByRole("button", { name: "File" }) });
  const fileTrigger = fileMenu.getByRole("button", { name: "File" });
  await fileTrigger.focus();
  await fileTrigger.press("ArrowDown");
  assert.equal(await fileTrigger.getAttribute("aria-expanded"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "menuitem",
    "opening a command menu did not focus its first enabled item");
  await page.keyboard.press("ArrowRight");
  const editTrigger = page.getByRole("button", { name: "Edit", exact: true });
  assert.equal(await editTrigger.getAttribute("aria-expanded"), "true",
    "ArrowRight did not move between command menus");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Edit",
    "closing a command menu did not return focus to its trigger");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const commandLayout = await page.evaluate(() => {
    const trigger = document.querySelector("#commandPaletteButton");
    const menus = [...document.querySelectorAll(".command-menu")];
    const stage = document.querySelector(".stage").getBoundingClientRect();
    return {
      paletteVisible: getComputedStyle(trigger).display !== "none",
      menusHidden: menus.every((menu) => getComputedStyle(menu).display === "none"),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      panelTabsFit: document.querySelector(".workspace-panel-tabs").scrollWidth <=
        document.querySelector(".workspace-panel-tabs").clientWidth,
      stageContained: stage.left >= 0 && stage.right <= innerWidth + .5,
    };
  });
  assert.deepEqual(commandLayout, {
    paletteVisible: true,
    menusHidden: true,
    horizontalOverflow: false,
    panelTabsFit: true,
    stageContained: true,
  });
  await page.click('[data-tool-group="selection"] .tool-group-toggle');
  const toolMenuBounds = await page.$eval('[data-tool-group="selection"] .tool-group-menu', (menu) => {
    const rect = menu.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  });
  assert.ok(toolMenuBounds.left >= 0 && toolMenuBounds.right <= 390,
    `tool flyout overflows the mobile viewport: ${JSON.stringify(toolMenuBounds)}`);
  await page.keyboard.press("Escape");
  await page.click("#commandPaletteButton");
  const paletteWidth = await page.$eval("#commandPalette", (node) => node.getBoundingClientRect().width);
  assert.ok(paletteWidth <= 390, "command palette overflows the mobile viewport");
  await page.click("#commandPaletteClose");
  await page.setViewportSize({ width: 320, height: 720 });
  const edgeLayout = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    commandTargetHeight: document.querySelector("#commandPaletteButton").getBoundingClientRect().height,
  }));
  assert.equal(edgeLayout.horizontalOverflow, false, "command surface overflows at the 320px edge case");
  assert.ok(edgeLayout.commandTargetHeight >= 24, "mobile command entry violates the minimum target size");
  await page.click("#commandPaletteButton");
  assert.ok(await page.$eval("#commandPalette", (node) => node.getBoundingClientRect().width) <= 320,
    "command palette overflows the 320px edge case");
  await page.click("#commandPaletteClose");
  await page.setViewportSize({ width: 1280, height: 800 });
  await closeActiveDocument();
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=command-surface`);

  await page.selectOption("#localeSelect", "ru");
  assert.equal((await page.textContent("#helpButton")).trim(), "Помощь");
  assert.deepEqual(await page.locator(".command-menu-trigger").allTextContents(),
    ["Файл", "Правка", "Изображение", "Слой", "Выделение", "Фильтр", "Вид", "Окно", "Помощь"]);
  assert.equal(await page.getAttribute('[data-tool-group="selection"] .tool-group-toggle', "aria-label"),
    "Инструменты выделения");
  await page.click("#emptyNewButton");
  assert.equal((await page.textContent("#starterDialogTitle")).trim(), "Создать локальный документ");
  await page.click("#starterCloseButton");
  await page.click("#helpButton");
  assert.equal((await page.textContent("#helpDialogTitle")).trim(), "Начните редактировать локально");
  await page.click('#helpDialog button[value="cancel"]');
  await page.waitForSelector("#helpDialog[open]", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "helpButton",
    "closing Help did not return focus to its invoker");

  await page.click("#newButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await page.locator("#layerNameInput").dispatchEvent("keydown", { key: "?" });
  assert.equal(await page.isVisible("#helpDialog[open]"), false,
    "the global Help shortcut captured an editable field");
  await page.locator("body").press("?");
  await page.waitForSelector("#helpDialog[open]");

  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector("#helpDialog");
    const shortcut = document.querySelector(".shortcut-grid");
    const columns = document.querySelector(".help-columns");
    const rect = dialog.getBoundingClientRect();
    return {
      dialogWidth: rect.width,
      viewportWidth: innerWidth,
      shortcutColumns: getComputedStyle(shortcut).gridTemplateColumns.split(" ").length,
      helpColumns: getComputedStyle(columns).gridTemplateColumns.split(" ").length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.ok(layout.dialogWidth <= layout.viewportWidth, "Help dialog overflows the mobile viewport");
  assert.equal(layout.shortcutColumns, 1);
  assert.equal(layout.helpColumns, 1);
  assert.equal(layout.horizontalOverflow, false);

  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.$eval("#helpDialog", (node) =>
    Number.parseFloat(getComputedStyle(node).transitionDuration) <= .001), true);
  await page.click('#helpDialog button[value="cancel"]');
  await closeActiveDocument();
  assert.equal(acceptedDialogs, dialogsAfterContextualDownload,
    "beta guide must not invent confirmations for unchanged documents");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(unexpectedNetwork, []);
  console.log(`PASS browser=${browserName} beta-guide=local-first starter-psb=1 recovery=${starterRecoveryState} responsive=390x844`);
} catch (error) {
  console.error(`BETA-GUIDE-SOURCE-ERROR browser=${browserName} ${error?.stack || error}`);
  throw error;
} finally {
  await closeBrowserWithDeadline();
}
