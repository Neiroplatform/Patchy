import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

const baseUrl = process.argv[2];
const browserName = process.argv[3] || "chromium";
if (!baseUrl || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node tests/sdk/wasm_editor_control_corrective_smoke.mjs <served-repository-url> [chromium|firefox|webkit]");
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; ++bit) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

const WIDTH = 160;
const HEIGHT = 100;
function splitColorPng(width = WIDTH, height = HEIGHT) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; ++y) {
    const row = y * (width * 4 + 1); rows[row] = 0;
    for (let x = 0; x < width; ++x) {
      const pixel = row + 1 + x * 4;
      rows[pixel] = x < width / 2 ? 230 : 30;
      rows[pixel + 1] = 35;
      rows[pixel + 2] = x < width / 2 ? 40 : 225;
      rows[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const playwright = await loadPlaywright();
const launchOptions = process.env.PATCHY_BROWSER_EXECUTABLE
  ? { executablePath: process.env.PATCHY_BROWSER_EXECUTABLE }
  : browserName === "chromium" && process.env.PATCHY_BROWSER_CHANNEL
    ? { channel: process.env.PATCHY_BROWSER_CHANNEL } : {};
if (browserName === "firefox") launchOptions.firefoxUserPrefs = { "network.proxy.type": 0 };
const browser = await playwright[browserName].launch({ headless: true, ...launchOptions });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const expectedOrigin = new URL(baseUrl).origin;
const unexpectedNetwork = [];
const failedRequests = [];
const pageErrors = [];
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith("http") && new URL(url).origin !== expectedOrigin) unexpectedNetwork.push(url);
});
page.on("requestfailed", (request) => failedRequests.push(
  `${request.url()} ${request.failure()?.errorText || "failed"}`));
page.on("pageerror", (error) => pageErrors.push(String(error)));

const revision = async () => Number((await page.textContent("#detailRevision")).trim());
const ready = () => page.waitForFunction(() =>
  document.querySelector(".editor-shell")?.dataset.state === "document" &&
  document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
{ timeout: 90_000 });
async function waitForMutation(before, label) {
  await page.waitForFunction(({ before, label }) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true" &&
    [...document.querySelectorAll("#historyList .history-label")]
      .some((node) => node.textContent === label), { before, label }, { timeout: 90_000 });
}

async function dragCanvas(toolButtonId, from, to, pointerId = 71) {
  await page.evaluate(({ toolButtonId, from, to, pointerId }) => {
    document.getElementById(toolButtonId).click();
    const canvas = document.getElementById("documentCanvas");
    const box = canvas.getBoundingClientRect();
    canvas.setPointerCapture = () => {};
    const dispatch = (type, point, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: box.left + box.width * point.x,
      clientY: box.top + box.height * point.y,
    }));
    dispatch("pointerdown", from, 1); dispatch("pointermove", to, 1); dispatch("pointerup", to, 0);
    delete canvas.setPointerCapture;
  }, { toolButtonId, from, to, pointerId });
}

async function clickCanvasPoints(toolButtonId, points) {
  await page.evaluate(({ toolButtonId, points }) => {
    document.getElementById(toolButtonId).click();
    const canvas = document.getElementById("documentCanvas");
    const box = canvas.getBoundingClientRect();
    for (const [index, point] of points.entries()) {
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, pointerId: 90 + index, pointerType: "mouse",
        isPrimary: true, button: 0, buttons: 1,
        clientX: box.left + box.width * point[0], clientY: box.top + box.height * point[1],
      }));
    }
  }, { toolButtonId, points });
}

async function canvasPixel(x, y) {
  return page.evaluate(({ x, y }) => [...document.getElementById("documentCanvas")
    .getContext("2d").getImageData(x, y, 1, 1).data], { x, y });
}

async function canvasPixels() {
  return page.evaluate(() => {
    const canvas = document.getElementById("documentCanvas");
    return [...canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data];
  });
}

const editorUrl = `${baseUrl.replace(/\/$/, "")}/build/wasm-sdk/site/patchy.html?editor-control-corrective=1`;
try {
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  await page.setInputFiles("#fileInput", {
    name: "clipboard-source.png", mimeType: "image/png", buffer: splitColorPng(),
  });
  await ready();
  await page.waitForFunction(() => document.querySelector("#detailCanvas")?.textContent === "160 × 100" &&
    document.querySelectorAll("#layerList .layer-row").length === 1, null, { timeout: 90_000 });

  await page.click('[aria-controls="commandMenu-layer"]');
  await page.click('#commandMenu-layer .command-submenu-trigger[data-label="Masks"]');
  const submenuStack = await page.evaluate(() => {
    const panel = document.querySelector('#commandMenu-layer .command-submenu-panel:not([hidden])');
    const box = panel.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + Math.min(24, box.width / 2),
      box.top + Math.min(24, box.height / 2));
    return { panel: Boolean(panel), containsHit: panel?.contains(hit) || false,
      topbarZ: getComputedStyle(document.querySelector(".topbar")).zIndex,
      rulerZ: getComputedStyle(document.getElementById("horizontalRuler")).zIndex };
  });
  assert.deepEqual(submenuStack, { panel: true, containsHit: true, topbarZ: "100", rulerZ: "5" });
  if (process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR) {
    await mkdir(process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR}/${browserName}-submenu-stacking.png`,
      fullPage: true,
    });
  }
  await page.keyboard.press("Escape");

  await page.click("#addVerticalGuideButton");
  const guideVisual = await page.evaluate(() => {
    const guide = document.querySelector('.guide-line[data-orientation="vertical"]');
    const line = getComputedStyle(guide, "::after");
    return { targetWidth: getComputedStyle(guide).width, lineWidth: line.width,
      shadow: line.boxShadow };
  });
  assert.equal(guideVisual.targetWidth, "24px");
  assert.equal(guideVisual.lineWidth, "1px");
  assert.equal(guideVisual.shadow, "none");
  await page.click("#clearGuidesButton");

  const footer = await page.evaluate(() => {
    const panel = document.getElementById("workspacePanelLayers").getBoundingClientRect();
    const actions = document.querySelector("#workspacePanelLayers > .layer-actions").getBoundingClientRect();
    const create = document.getElementById("createPixelLayerButton").getBoundingClientRect();
    const remove = document.getElementById("removeLayerButton").getBoundingClientRect();
    return { panel: { top: panel.top, bottom: panel.bottom }, actions: { top: actions.top, bottom: actions.bottom },
      create: { width: create.width, height: create.height }, remove: { width: remove.width, height: remove.height } };
  });
  assert.ok(footer.create.width >= 48 && footer.create.height >= 30, JSON.stringify(footer));
  assert.ok(footer.remove.width >= 48 && footer.remove.height >= 30, JSON.stringify(footer));
  assert.ok(footer.actions.top >= footer.panel.top && footer.actions.bottom <= footer.panel.bottom + .5,
    JSON.stringify(footer));

  let before = await revision();
  await page.click("#createPixelLayerButton");
  await waitForMutation(before, "Creating pixel layer");
  assert.equal(await page.locator("#layerList .layer-row").count(), 2);
  assert.equal(await page.locator('.layer-row[data-active="true"] .layer-name').textContent(), "Layer 1");
  before = await revision();
  await page.locator('.layer-row[data-active="true"] .layer-select-button').press("F2");
  await page.fill('.layer-row[data-active="true"] .layer-inline-name', "Retouch copy");
  await page.locator('.layer-row[data-active="true"] .layer-inline-name').press("Enter");
  await waitForMutation(before, "Renaming layer");
  assert.equal(await page.locator('.layer-row[data-active="true"] .layer-name').textContent(), "Retouch copy");
  before = await revision();
  await page.click("#removeLayerButton");
  await waitForMutation(before, "Deleting layer");
  assert.equal(await page.locator("#layerList .layer-row").count(), 1);
  await page.locator("#layerList .layer-select-button").click();

  before = await revision();
  await page.fill("#quickLayerOpacityInput", "40");
  await page.locator("#quickLayerOpacityInput").dispatchEvent("change");
  await waitForMutation(before, "Changing opacity");
  assert.equal(await page.inputValue("#quickLayerOpacityInput"), "40");
  await page.click("#workspacePanelPropertiesButton");
  assert.equal(await page.inputValue("#layerOpacityInput"), "40");
  before = await revision();
  await page.locator("#layerOpacityInput").evaluate((input) => {
    input.value = "65";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForMutation(before, "Changing opacity");
  assert.equal(await page.textContent("#layerOpacityOutput"), "65%");
  assert.equal(await page.inputValue("#quickLayerOpacityInput"), "65");
  before = await revision();
  await page.fill("#quickLayerOpacityInput", "100");
  await page.locator("#quickLayerOpacityInput").dispatchEvent("change");
  await waitForMutation(before, "Changing opacity");

  before = await revision();
  await page.fill("#quickLayerFillInput", "55");
  await page.locator("#quickLayerFillInput").dispatchEvent("change");
  await waitForMutation(before, "Changing fill opacity");
  assert.equal(await page.inputValue("#layerFillInput"), "55");
  assert.equal(await page.textContent("#layerFillOutput"), "55%");
  before = await revision();
  await page.fill("#quickLayerFillInput", "100");
  await page.locator("#quickLayerFillInput").dispatchEvent("change");
  await waitForMutation(before, "Changing fill opacity");

  const toolBeforeWorkspace = await page.locator("#canvasViewport").getAttribute("data-tool");
  await page.selectOption("#workspaceModeSelect", "painting");
  assert.equal(await page.locator("#workspacePanelControls").isVisible(), true);
  assert.equal(await page.locator("#authoringBrushPanel").isVisible(), true);
  assert.equal(await page.locator("#canvasViewport").getAttribute("data-tool"), toolBeforeWorkspace);
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("patchy.workspace-deck.v1"))).mode,
    "painting");
  const restoredWorkspacePage = await context.newPage();
  await restoredWorkspacePage.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await restoredWorkspacePage.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null, { timeout: 90_000 });
  assert.equal(await restoredWorkspacePage.inputValue("#workspaceModeSelect"), "painting");
  assert.equal(await restoredWorkspacePage.locator("#authoringBrushPanel").isVisible(), true);
  assert.equal(await restoredWorkspacePage.locator("#canvasViewport").getAttribute("data-tool"), toolBeforeWorkspace);
  await restoredWorkspacePage.close();
  await page.click("#workspacePanelStructureButton");
  assert.equal(await page.inputValue("#workspaceModeSelect"), "custom");
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("patchy.workspace-deck.v1"))).panel,
    "workspacePanelStructure");
  await page.click("#workspaceResetButton");
  assert.equal(await page.inputValue("#workspaceModeSelect"), "editing");
  assert.equal(await page.locator("#workspacePanelProperties").isVisible(), true);
  await page.selectOption("#workspaceModeSelect", "typography");
  assert.equal(await page.locator("#authoringTypePanel").isVisible(), true);
  await page.click("#workspaceCollapseButton");
  assert.equal(await page.locator(".editor-shell").evaluate((node) => node.classList.contains("panels-hidden")), true);
  assert.equal(await page.locator("#togglePanelsButton").getAttribute("aria-pressed"), "true");
  await page.click("#togglePanelsButton");
  assert.equal(await page.locator(".editor-shell").evaluate((node) => node.classList.contains("panels-hidden")), false);
  await page.setViewportSize({ width: 760, height: 900 });
  await page.selectOption("#workspaceModeSelect", "review");
  assert.equal(await page.locator('[data-workspace-panel]:visible').count(), 1);
  assert.equal(await page.locator("#workspacePanelInfo").isVisible(), true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.selectOption("#workspaceModeSelect", "painting");
  if (process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR) {
    await mkdir(process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR}/${browserName}-workspace-painting.png` });
  }

  await page.click("#brushToolButton");
  assert.equal(await page.locator("#brushPresetSelect").isVisible(), true);
  await page.click("#brushQuickPickerButton");
  assert.equal(await page.locator("#brushQuickPicker").isVisible(), true);
  await page.locator("#brushQuickSizeInput").evaluate((input) => {
    input.value = "31"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#brushQuickHardnessInput").evaluate((input) => {
    input.value = "72"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await page.inputValue("#brushSizeInput"), "31");
  assert.equal(await page.inputValue("#brushSoftnessInput"), "28");
  await page.click('[data-brush-preset="marker"]');
  assert.equal(await page.inputValue("#brushPresetSelect"), "marker");
  assert.equal(await page.locator('[data-brush-preset="marker"]').getAttribute("aria-selected"), "true");
  await page.locator('[data-brush-preset="marker"]').dblclick();
  assert.equal(await page.locator("#brushQuickPicker").isHidden(), true);
  await page.locator("#documentCanvas").dispatchEvent("contextmenu", { button: 2 });
  assert.equal(await page.locator("#brushQuickPicker").isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#brushQuickPicker").isHidden(), true);
  await page.selectOption("#brushPresetSelect", "soft-round");
  assert.equal(await page.inputValue("#brushSizeInput"), "80");
  assert.equal(await page.inputValue("#brushSoftnessInput"), "100");
  assert.equal(await page.inputValue("#brushOpacityInput"), "100");
  await page.locator("#brushSoftnessInput").evaluate((input) => {
    input.value = "65"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await page.inputValue("#brushPresetSelect"), "custom");
  assert.equal(await page.textContent("#brushSoftnessOutput"), "65%");
  await page.locator("#brushOpacityInput").evaluate((input) => {
    input.value = "45"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await page.inputValue("#brushPresetSelect"), "custom");
  assert.equal(await page.textContent("#brushOpacityOutput"), "45%");
  await page.selectOption("#brushPresetSelect", "hard-round");

  await page.click("#brushSettingsButton");
  assert.equal(await page.locator("#workspacePanelControls").isVisible(), true);
  assert.equal(await page.locator("#authoringBrushPanel").isVisible(), true);
  assert.equal(await page.locator("#authoringBrushTab").getAttribute("aria-selected"), "true");
  await page.click("#authoringColorTab");
  assert.equal(await page.locator("#authoringColorPanel").isVisible(), true);
  await page.click("#authoringSwatchesLibraryTab");
  await page.locator('#authoringSwatches [data-color="#ff0000"]').click();
  assert.equal(await page.inputValue("#authoringForegroundInput"), "#ff0000");
  assert.equal(await page.inputValue("#foregroundSwatchInput"), "#ff0000");
  assert.equal(await page.inputValue("#brushColorInput"), "#ff0000");
  await page.locator('#authoringSwatches [data-color="#0057ff"]').click({ modifiers: ["Alt"] });
  assert.equal(await page.inputValue("#authoringBackgroundInput"), "#0057ff");
  assert.equal(await page.inputValue("#backgroundSwatchInput"), "#0057ff");
  assert.ok(await page.locator("#authoringRecentSwatches [data-color]").count() >= 2);
  await page.click('[aria-controls="commandMenu-file"]');
  await page.click('#commandMenu-file [data-command-target="assetsButton"]');
  await page.fill("#assetGradientNameInput", "Browser gradient");
  await page.fill("#assetPatternNameInput", "Browser pattern");
  await page.selectOption("#assetPatternKindInput", "dots");
  await page.click("#saveGradientAssetButton");
  await page.waitForFunction(() =>
    document.querySelectorAll("#authoringGradientPresets [data-preset]").length >= 5);
  await page.click("#savePatternAssetButton");
  await page.waitForFunction(() =>
    document.querySelectorAll("#authoringGradientPresets [data-preset]").length >= 5 &&
    document.querySelectorAll("#authoringPatternPresets [data-preset]").length >= 3);
  assert.match(await page.locator('#authoringGradientPresets [aria-label="Gradient: Browser gradient"] .preset-library-preview')
    .getAttribute("style"), /#111111.*#ffffff/);
  await page.locator("#assetLibraryList .dialog-actions").filter({ hasText: "gradient · Browser gradient" })
    .getByRole("button", { name: "Remove" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#authoringGradientPresets [data-preset]").length === 4);
  await page.locator("#assetLibraryList .dialog-actions").filter({ hasText: "pattern · Browser pattern" })
    .getByRole("button", { name: "Remove" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#authoringPatternPresets [data-preset]").length === 2);
  await page.click('#assetsDialog button[aria-label="Close"]');
  before = await revision();
  await page.click('[aria-controls="commandMenu-window"]');
  await page.click('#commandMenu-window [data-command-target="authoringGradientsLibraryTab"]');
  assert.equal(await page.locator("#authoringGradientsLibraryPanel").isVisible(), true);
  assert.equal(await page.locator("#authoringGradientPresets [data-preset]").count(), 4);
  await page.click('#authoringGradientPresets [data-preset="sunset"]');
  assert.equal(await page.locator("#canvasViewport").getAttribute("data-tool"), "gradient");
  assert.equal(await page.inputValue("#paintPresetSelect"), "sunset");
  assert.equal(await page.locator("#gradientStopInput option").count(), 3);
  assert.equal(await revision(), before);
  await page.locator("#authoringGradientsLibraryTab").press("ArrowRight");
  assert.equal(await page.locator("#authoringPatternsLibraryPanel").isVisible(), true);
  await page.click('#authoringPatternPresets [data-preset="dots"]');
  assert.equal(await page.locator("#canvasViewport").getAttribute("data-tool"), "patternStamp");
  assert.equal(await page.inputValue("#advancedPatternInput"), "dots");
  assert.equal(await revision(), before);
  if (process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR) {
    await mkdir(process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR}/${browserName}-authoring-color.png` });
  }

  await page.locator("#authoringColorTab").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#authoringBrushTab").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#brushSettingsDialog").isVisible(), true);
  assert.equal(await page.locator(".brush-section-navigation [role=tab]").count(), 5);
  assert.equal(await page.locator(".brush-section-body > section:visible").count(), 1);
  await page.locator('.brush-section-navigation [role=tab]').first().focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator("#brush-section-1").isVisible(), true);
  const previewBefore = await page.locator("#authoringBrushPreview").getAttribute("data-preview-signature");
  await page.locator("#brushAngleInput").evaluate((input) => {
    input.value = "35"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const previewAfter = await page.locator("#authoringBrushPreview").getAttribute("data-preview-signature");
  assert.notEqual(previewAfter, previewBefore);
  await page.locator("#brushSoftnessInput").evaluate((input) => {
    input.value = "40"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.match(await page.locator("#authoringBrushPreview").getAttribute("data-preview-signature"), /^24:60:/);
  await page.locator('.brush-section-navigation [role=tab]').nth(3).click();
  assert.equal(await page.locator("#brush-section-3").isVisible(), true);
  assert.equal(await page.locator('.brush-section-navigation [role=tab]').nth(3).getAttribute("data-enabled"), "false");
  await page.check("#brushTextureEnabledInput");
  assert.equal(await page.locator('.brush-section-navigation [role=tab]').nth(3).getAttribute("data-enabled"), "true");
  if (process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR}/${browserName}-authoring-brush.png` });
  }

  if (await page.locator("#textToolButton").isHidden()) {
    await page.click('[data-tool-group="draw"] .tool-group-toggle');
  }
  await page.click("#textToolButton");
  await page.click("#textSettingsButton");
  assert.equal(await page.locator("#authoringTypeTab").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#textSettingsPopover").isVisible(), true);
  assert.equal(await page.locator("#characterSettingsPanel").isVisible(), true);
  await page.click("#paragraphSettingsTab");
  assert.equal(await page.locator("#paragraphSettingsPanel").isVisible(), true);
  const controlDeckLayout = await page.evaluate(() => {
    const inspector = document.getElementById("inspector").getBoundingClientRect();
    const panel = document.getElementById("workspacePanelControls").getBoundingClientRect();
    return { inspector: { left: inspector.left, right: inspector.right, top: inspector.top, bottom: inspector.bottom },
      panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom } };
  });
  assert.ok(controlDeckLayout.panel.left >= controlDeckLayout.inspector.left &&
    controlDeckLayout.panel.right <= controlDeckLayout.inspector.right + .5 &&
    controlDeckLayout.panel.top >= controlDeckLayout.inspector.top &&
    controlDeckLayout.panel.bottom <= controlDeckLayout.inspector.bottom + .5, JSON.stringify(controlDeckLayout));
  if (process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR}/${browserName}-authoring-type.png` });
  }

  const paintedBefore = await canvasPixel(80, 50);
  before = await revision();
  await dragCanvas("brushToolButton", { x: .48, y: .5 }, { x: .52, y: .5 }, 72);
  await waitForMutation(before, "Painting pixels");
  const paintedAfter = await canvasPixel(80, 50);
  assert.notDeepEqual(paintedAfter.slice(0, 3), paintedBefore.slice(0, 3));

  assert.equal(await page.locator("#eraserToolButton").isHidden(), true);
  await page.click('[data-tool-group="paint"] .tool-group-toggle');
  const eraserHitTarget = await page.evaluate(() => {
    const button = document.getElementById("eraserToolButton");
    const box = button.getBoundingClientRect();
    return { visible: getComputedStyle(button).display !== "none" && !button.hidden,
      hit: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.id,
      width: box.width, height: box.height };
  });
  assert.equal(eraserHitTarget.visible, true);
  assert.equal(eraserHitTarget.hit, "eraserToolButton");
  assert.ok(eraserHitTarget.width >= 24 && eraserHitTarget.height >= 24, JSON.stringify(eraserHitTarget));
  await page.click("#eraserToolButton");
  assert.equal(await page.locator('[data-tool-group="paint"] > #eraserToolButton').count(), 1);
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("patchy.tool-families.v1"))).paint,
    "eraserToolButton");
  const pixelsBeforeErase = await canvasPixels();
  before = await revision();
  await dragCanvas("eraserToolButton", { x: .48, y: .5 }, { x: .52, y: .5 }, 73);
  await waitForMutation(before, "Erasing pixels");
  const pixelsAfterErase = await canvasPixels();
  const erasedAlphaCount = pixelsAfterErase.reduce((count, value, index) =>
    index % 4 === 3 && value < pixelsBeforeErase[index] ? count + 1 : count, 0);
  assert.ok(erasedAlphaCount > 0, `eraser did not lower alpha in any rendered pixel; center=${paintedAfter}`);

  await page.click('[data-tool-group="paint"] .tool-group-toggle');
  await page.click("#mixerToolButton");
  assert.equal(await page.locator("#mixerWetInput").isVisible(), true);
  before = await revision();
  await dragCanvas("mixerToolButton", { x: .18, y: .32 }, { x: .4, y: .32 }, 75);
  await waitForMutation(before, "Applying Mixer Brush");
  assert.equal(await page.locator("#errorBanner").isHidden(), true);
  await page.click('[data-tool-group="paint"] .tool-group-toggle');
  await page.click("#patternStampToolButton");
  assert.equal(await page.locator("#advancedPatternInput").isVisible(), true);
  before = await revision();
  await dragCanvas("patternStampToolButton", { x: .55, y: .68 }, { x: .78, y: .68 }, 76);
  await waitForMutation(before, "Applying Pattern Stamp");
  assert.equal(await page.locator("#errorBanner").isHidden(), true);

  if (await page.locator("#penToolButton").isHidden()) {
    await page.click('[data-tool-group="draw"] .tool-group-toggle');
  }
  await page.click("#penToolButton");
  const penActivation = await page.evaluate(() => ({
    tool: document.getElementById("canvasViewport").dataset.tool,
    optionsTool: document.getElementById("toolOptions").dataset.tool,
    penHidden: document.getElementById("penToolButton").hidden,
    penDisabled: document.getElementById("penToolButton").disabled,
    finishHidden: document.getElementById("finishPenPathButton").hidden,
    finishDisabled: document.getElementById("finishPenPathButton").disabled,
  }));
  assert.equal(penActivation.finishHidden, false, JSON.stringify(penActivation));
  await clickCanvasPoints("penToolButton", [[.18, .2]]);
  await page.evaluate(() => {
    const canvas = document.getElementById("documentCanvas"); const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse",
      isPrimary: true, buttons: 0, clientX: box.left + box.width * .42,
      clientY: box.top + box.height * .72 }));
  });
  assert.match(await page.locator("#pathOverlayRubberBand").getAttribute("d"), /^M.+L.+/);
  assert.notEqual(await page.locator("#pathOverlayRubberBand").evaluate((node) =>
    getComputedStyle(node).strokeDasharray), "none");
  if (process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR) {
    await mkdir(process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR}/${browserName}-pen-rubber-band.png`,
      fullPage: true,
    });
  }
  await clickCanvasPoints("penToolButton", [[.42, .72], [.7, .28]]);
  const penOverlay = await page.evaluate(() => {
    const overlay = document.getElementById("pathOverlay"); const box = overlay.getBoundingClientRect();
    return { tool: document.getElementById("canvasViewport").dataset.tool, hidden: overlay.hidden,
      display: getComputedStyle(overlay).display, width: box.width, height: box.height,
      anchors: document.querySelectorAll("#pathOverlayAnchors circle").length,
      path: document.getElementById("pathOverlayLine").getAttribute("d") };
  });
  assert.equal(await page.locator("#pathOverlay").isVisible(), true, JSON.stringify(penOverlay));
  assert.equal(await page.locator("#pathOverlayAnchors circle").count(), 3);
  assert.equal(await page.locator("#finishPenPathButton").isEnabled(), true);
  const penControlLayout = await page.evaluate(() => {
    const toolbar = document.getElementById("toolOptions").getBoundingClientRect();
    const control = document.getElementById("finishPenPathButton").getBoundingClientRect();
    return { toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom },
      control: { left: control.left, right: control.right, top: control.top, bottom: control.bottom },
      scrollLeft: document.getElementById("toolOptions").scrollLeft,
      scrollWidth: document.getElementById("toolOptions").scrollWidth };
  });
  assert.ok(penControlLayout.control.left >= penControlLayout.toolbar.left &&
    penControlLayout.control.right <= penControlLayout.toolbar.right &&
    penControlLayout.control.top >= penControlLayout.toolbar.top &&
    penControlLayout.control.bottom <= penControlLayout.toolbar.bottom, JSON.stringify(penControlLayout));
  before = await revision();
  await page.click("#finishPenPathButton");
  await waitForMutation(before, "Creating Pen path");
  assert.equal(await page.locator("#pathList button").count(), 1);
  assert.equal(await page.locator("#pathList button").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#pathList button").textContent(), "Work Path");

  before = await revision();
  await dragCanvas("marqueeToolButton", { x: .65, y: .3 }, { x: .92, y: .7 }, 77);
  await waitForMutation(before, "Selecting area");
  await page.selectOption("#selectionModeInput", "add");

  await clickCanvasPoints("penToolButton", [[.08, .15], [.48, .15], [.48, .85], [.08, .85]]);
  assert.equal(await page.locator("#closePenPathButton").isEnabled(), true);
  await page.evaluate(() => {
    const canvas = document.getElementById("documentCanvas"); const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse",
      isPrimary: true, buttons: 0, clientX: box.left + box.width * .08,
      clientY: box.top + box.height * .15 }));
  });
  assert.equal(await page.locator("#pathOverlay").getAttribute("data-close-target"), "true");
  assert.equal(await page.locator("#pathOverlayAnchors circle").first().getAttribute("class"),
    "path-close-target");
  before = await revision();
  await clickCanvasPoints("penToolButton", [[.08, .15]]);
  await waitForMutation(before, "Creating Pen path");
  assert.equal(await page.locator("#pathList button").count(), 1);
  assert.equal(await page.locator("#pathList button").textContent(), "Work Path");
  assert.match(await page.locator("#pathOverlayLine").getAttribute("d"), /Z$/);

  before = await revision();
  await page.evaluate(() => {
    const canvas = document.getElementById("documentCanvas"); const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
      button: 2, buttons: 2, clientX: box.left + box.width * .25,
      clientY: box.top + box.height * .5 }));
  });
  const makeSelectionAction = page.locator('button[data-pen-path-action="make-selection"]');
  assert.equal(await makeSelectionAction.isVisible(), true);
  assert.equal(await makeSelectionAction.isEnabled(), true);
  await makeSelectionAction.click();
  await waitForMutation(before, "Loading path selection");
  assert.equal(await page.inputValue("#selectionModeInput"), "replace");
  await page.locator("#canvasViewport").focus();
  await page.keyboard.press("Control+c");
  await page.waitForFunction(() => /selected pixels copied locally/.test(
    document.querySelector("#sessionIndicator")?.lastElementChild?.textContent || ""), null,
  { timeout: 30_000 });
  before = await revision();
  await page.keyboard.press("Control+v");
  await waitForMutation(before, "Pasting selected pixels");
  assert.equal(await page.locator("#layerList .layer-row").count(), 2);
  assert.equal(await page.locator('.layer-row[data-active="true"] .layer-name').textContent(), "Pasted pixels");

  const sourceRow = page.locator("#layerList .layer-row").filter({
    has: page.locator(".layer-name", { hasText: "clipboard-source" }),
  });
  assert.equal(await sourceRow.count(), 1);
  before = await revision();
  await sourceRow.locator(".visibility-button").click();
  await waitForMutation(before, "Updating layer");
  const selectedPixel = await canvasPixel(30, 50);
  const outsidePixel = await canvasPixel(130, 50);
  assert.ok(selectedPixel[3] > 0, `selected area lost: ${selectedPixel}`);
  assert.equal(outsidePixel[3], 0, `copy/paste leaked the full source layer: ${outsidePixel}`);

  await page.click("#workspacePanelStructureButton");
  assert.equal(await page.locator("#pathSelectionButton").isEnabled(), true);
  assert.equal(await page.locator("#pathStrokeButton").isEnabled(), true);
  assert.equal(await page.locator("#pathFillButton").isEnabled(), true);
  assert.equal(await page.locator("#pathVectorMaskButton").isEnabled(), true);
  before = await revision();
  await page.click("#pathStrokeButton");
  await waitForMutation(before, "Stroking path");
  before = await revision();
  await page.click("#pathFillButton");
  await page.waitForFunction((before) => Number(document.querySelector("#detailRevision")?.textContent) >= before + 1 &&
    [...document.querySelectorAll("#historyList .history-label")].some((node) => node.textContent === "Filling path") &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", before, { timeout: 90_000 });
  before = await revision();
  await page.click("#pathVectorMaskButton");
  await waitForMutation(before, "Creating vector mask");

  await page.setInputFiles("#fileInput", {
    name: "scaled-selection-erase.png", mimeType: "image/png", buffer: splitColorPng(756, 718),
  });
  await ready();
  await page.waitForFunction(() => document.querySelector("#detailCanvas")?.textContent === "756 × 718" &&
    document.querySelectorAll("#layerList .layer-row").length === 1, null, { timeout: 90_000 });
  const navigatorRevision = await revision();
  await page.click("#workspacePanelInfoButton");
  await page.waitForFunction(() => document.querySelector("#navigatorCanvas")?.dataset.preview === "ready");
  const previewEvidence = await page.evaluate(() => {
    const canvas = document.getElementById("navigatorCanvas");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] !== pixels[index + 1] || pixels[index + 1] !== pixels[index + 2]) { colored++; break; }
    }
    return { colored, width: canvas.width, height: canvas.height };
  });
  assert.ok(previewEvidence.colored > 0, JSON.stringify(previewEvidence));
  await page.click("#histogramTab");
  await page.waitForFunction(() => Number(document.querySelector("#histogramCanvas")?.dataset.samplePixels) > 0);
  assert.ok(Number(await page.locator("#histogramCanvas").getAttribute("data-sample-pixels")) <= 65_536);
  await page.locator("#histogramTab").press("ArrowRight");
  assert.equal(await page.locator("#documentInfoTab").getAttribute("aria-selected"), "true");
  assert.equal((await page.textContent("#detailCanvas")).trim(), "756 × 718");
  await page.locator("#documentInfoTab").press("Home");
  assert.equal(await page.locator("#navigatorTab").getAttribute("aria-selected"), "true");
  await page.click("#navigatorDoubleButton");
  await page.waitForFunction(() => document.querySelector("#zoomLabel")?.textContent === "200%" &&
    document.querySelector("#navigatorZoomOutput")?.textContent === "200%");
  const scrollBeforeNavigatorPan = await page.evaluate(() => ({
    left: document.getElementById("canvasViewport").scrollLeft,
    top: document.getElementById("canvasViewport").scrollTop,
  }));
  await page.locator("#navigatorCanvas").evaluate((canvas) => {
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 501,
      pointerType: "mouse", button: 0, buttons: 1, clientX: box.right - 12, clientY: box.bottom - 12 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 501,
      pointerType: "mouse", button: 0, buttons: 0, clientX: box.right - 12, clientY: box.bottom - 12 }));
  });
  await page.waitForFunction((before) => {
    const viewport = document.getElementById("canvasViewport");
    return viewport.scrollLeft !== before.left || viewport.scrollTop !== before.top;
  }, scrollBeforeNavigatorPan);
  assert.equal(await revision(), navigatorRevision);
  await page.click("#navigatorFitButton");
  await page.waitForFunction(() => document.querySelector("#zoomLabel")?.textContent.startsWith("Fit ·"));
  assert.equal(await revision(), navigatorRevision);
  const scaledCanvas = await page.evaluate(() => {
    const canvas = document.getElementById("documentCanvas");
    const box = canvas.getBoundingClientRect();
    return { intrinsicWidth: canvas.width, intrinsicHeight: canvas.height,
      cssWidth: box.width, cssHeight: box.height };
  });
  assert.ok(scaledCanvas.cssHeight < scaledCanvas.intrinsicHeight, JSON.stringify(scaledCanvas));
  before = await revision();
  await dragCanvas("marqueeToolButton", { x: .08, y: .12 }, { x: .48, y: .68 }, 80);
  await waitForMutation(before, "Selecting area");
  if (await page.locator("#eraserToolButton").isHidden()) {
    await page.click('[data-tool-group="paint"] .tool-group-toggle');
    await page.click("#eraserToolButton");
  }
  await page.locator("#brushSizeInput").evaluate((input) => {
    input.value = "24"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const selectedEraseBefore = await canvasPixel(189, 215);
  before = await revision();
  await dragCanvas("eraserToolButton", { x: .25, y: .3 }, { x: .25, y: .3 }, 81);
  await waitForMutation(before, "Erasing pixels");
  const selectedEraseAfter = await canvasPixel(189, 215);
  assert.ok(selectedEraseAfter[3] < selectedEraseBefore[3],
    `scaled selected erase did not lower alpha: before=${selectedEraseBefore} after=${selectedEraseAfter}`);
  assert.equal(await page.locator("#errorBanner").isHidden(), true);

  if (process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR) {
    await mkdir(process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.PATCHY_CORRECTIVE_SCREENSHOT_DIR}/${browserName}-editor-control-corrective.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(unexpectedNetwork, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(`EDITOR-CONTROL-CORRECTIVE browser=${browserName} menus=submenu-over-ruler guides=thin pen=rubber-band-anchor-close-open-selection-fill-stroke-mask clipboard=path-selection-only layers=add-delete opacity-fill=quick-properties authoring=color-swatches-gradient-pattern-assets-configure-first-no-revision-brush-type-docked-preview navigator=preview-bounded-histogram-pan-zoom-no-revision brush=preset-softness-opacity mixer-pattern=pass eraser=plain-scaled-selected-pass`);
} catch (error) {
  const diagnostic = await page.evaluate(() => ({
    state: document.querySelector(".editor-shell")?.dataset.state,
    busy: document.querySelector(".editor-shell")?.getAttribute("aria-busy"),
    session: document.querySelector("#sessionIndicator")?.textContent,
    error: document.querySelector("#errorBanner")?.textContent,
    errorMessage: document.querySelector("#errorMessage")?.textContent,
  })).catch(() => null);
  console.error("EDITOR-CONTROL-CORRECTIVE-DIAGNOSTIC", JSON.stringify({ diagnostic, pageErrors, failedRequests }));
  throw error;
} finally {
  await browser.close();
}
