import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const baseUrl = process.argv[2];
const browserName = process.argv[3] || "chromium";
if (!baseUrl || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node tests/sdk/wasm_browser_tool_runtime_smoke.mjs <served-repository-url> [chromium|firefox|webkit]");
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
const launchOptions = process.env.PATCHY_BROWSER_EXECUTABLE
  ? { executablePath: process.env.PATCHY_BROWSER_EXECUTABLE }
  : browserName === "chromium" && process.env.PATCHY_BROWSER_CHANNEL
    ? { channel: process.env.PATCHY_BROWSER_CHANNEL } : {};
if (browserName === "firefox") launchOptions.firefoxUserPrefs = { "network.proxy.type": 0 };
const browser = await playwright[browserName].launch({ headless: true, ...launchOptions });
const context = await browser.newContext({ viewport: { width: 1731, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
const failedRequests = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("requestfailed", (request) => failedRequests.push(
  `${request.url()} ${request.failure()?.errorText || "failed"}`));

const firstRaster = fileURLToPath(new URL(
  "../../test-fixtures/readme/stylized_sunset_cc0.png", import.meta.url));
const secondRaster = fileURLToPath(new URL(
  "../../test-fixtures/readme/san_francisco_cityscape_cc0.jpg", import.meta.url));
const editorPath = process.env.PATCHY_EDITOR_PATH || "build/wasm-sdk/site/patchy.html";
const editorUrl = `${baseUrl.replace(/\/$/, "")}/${editorPath.replace(/^\//, "")}?browser-tool-runtime=1`;

const revision = async () => Number((await page.textContent("#detailRevision")).trim());
const idle = () => page.waitForFunction(() =>
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

async function revealTool(buttonId) {
  const button = page.locator(`#${buttonId}`);
  if (!await button.isVisible()) {
    const group = await button.evaluate((node) => node.closest(".tool-cluster")?.dataset.toolGroup);
    assert.ok(group, `${buttonId} is hidden outside a tool group`);
    await page.click(`[data-tool-group="${group}"] .tool-group-toggle`);
  }
  return button;
}

async function selectTool(buttonId) {
  const button = await revealTool(buttonId);
  await page.click(`#${buttonId}`);
  assert.equal(await button.getAttribute("aria-pressed"), "true", `${buttonId} did not activate`);
  assert.ok((await page.textContent("#toolInstruction")).trim().length > 0,
    `${buttonId} has no usage description`);
  assert.equal(await page.locator("#errorBanner").isHidden(), true,
    `${buttonId} surfaced ${await page.textContent("#errorMessage")}`);
}

async function dragCanvas(from, to, { steps = 12, modifiers = [] } = {}) {
  const box = await page.locator("#documentCanvas").boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "document canvas is not visible");
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to.x, box.y + box.height * to.y, { steps });
  await page.mouse.up();
  for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier);
}

async function canvasDigest() {
  return page.locator("#documentCanvas").evaluate((canvas) => canvas.toDataURL());
}

async function runPixelTool({ buttonId, label, from, to, prepare }) {
  await selectTool(buttonId);
  await prepare?.();
  const beforeRevision = await revision();
  const beforePixels = await canvasDigest();
  await dragCanvas(from, to);
  await waitForMutation(beforeRevision, label);
  assert.notEqual(await canvasDigest(), beforePixels, `${buttonId} committed without changing rendered pixels`);
  assert.equal(await page.locator("#errorBanner").isHidden(), true,
    `${buttonId} surfaced ${await page.textContent("#errorMessage")}`);
}

try {
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });

  await page.evaluate(() => Object.defineProperty(window, "showOpenFilePicker", {
    configurable: true, value: undefined,
  }));
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#openButton"),
  ]);
  assert.equal(chooser.isMultiple(), true, "Open fallback did not allow multiple files");
  await chooser.setFiles([firstRaster, secondRaster]);
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 2 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  assert.deepEqual((await page.locator('#documentTabs [role="tab"]').allTextContents())
    .map((value) => value.replace(/^\s*•\s*/, "")),
  ["stylized_sunset_cc0.psd", "san_francisco_cityscape_cc0.psd"]);
  await idle();

  await selectTool("brushToolButton");
  const measureOptionsLayout = () => page.evaluate(() => {
    const stage = document.querySelector(".stage-meta").getBoundingClientRect();
    const options = document.querySelector("#toolOptions").getBoundingClientRect();
    const metrics = document.querySelector("#documentMetrics").getBoundingClientRect();
    const labels = [...document.querySelectorAll("#toolOptions label:not([hidden])")]
      .map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > 0);
    return { stageRight: stage.right, optionsLeft: options.left, optionsRight: options.right,
      optionsClientWidth: document.querySelector("#toolOptions").clientWidth,
      optionsScrollWidth: document.querySelector("#toolOptions").scrollWidth,
      metricsLeft: metrics.left,
      stageHeight: stage.height,
      labels: labels.map((rect) => ({ left: rect.left, right: rect.right,
        top: rect.top, bottom: rect.bottom })) };
  });
  const assertOptionsLayout = (optionsLayout) => {
    assert.ok(optionsLayout.optionsRight <= optionsLayout.stageRight + .5,
      `tool options escape the stage: ${JSON.stringify(optionsLayout)}`);
    assert.ok(optionsLayout.labels.every((rect) => rect.left >= optionsLayout.optionsLeft - .5 &&
      rect.right <= optionsLayout.optionsRight + .5),
    `brush controls are clipped: ${JSON.stringify(optionsLayout.labels)}`);
    for (let index = 0; index < optionsLayout.labels.length; ++index) {
      for (let other = index + 1; other < optionsLayout.labels.length; ++other) {
        const a = optionsLayout.labels[index]; const b = optionsLayout.labels[other];
        assert.equal(a.left < b.right - .5 && a.right > b.left + .5 &&
          a.top < b.bottom - .5 && a.bottom > b.top + .5, false,
        `brush controls overlap: ${JSON.stringify(optionsLayout.labels)}`);
      }
    }
  };
  assertOptionsLayout(await measureOptionsLayout());
  const stableStageHeight = (await measureOptionsLayout()).stageHeight;
  await page.locator("#brushSizeInput").evaluate((input) => {
    input.value = "1748"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal((await measureOptionsLayout()).stageHeight, stableStageHeight,
    "large brush radius moved the top options menu");
  await page.locator("#brushSizeInput").evaluate((input) => {
    input.value = "17"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  assertOptionsLayout(await measureOptionsLayout());

  const toolInventory = await page.locator("[data-tool-contract]").evaluateAll((buttons) =>
    buttons.map((button) => ({ id: button.id, contract: button.dataset.toolContract,
      description: button.getAttribute("aria-description") || "" })));
  assert.equal(toolInventory.length, 30, "the browser tool catalog changed without runtime coverage");
  assert.equal(new Set(toolInventory.map(({ contract }) => contract)).size, 30,
    "the browser tool catalog contains duplicate contracts");
  assert.equal(toolInventory.every(({ id, contract, description }) =>
    id && contract && description.trim().length > 0), true,
  `a browser tool lacks its usage contract: ${JSON.stringify(toolInventory)}`);
  for (const buttonId of [
    "moveToolButton", "cropToolButton", "marqueeToolButton", "lassoToolButton",
    "polygonToolButton", "magicToolButton", "quickSelectToolButton", "magneticToolButton",
    "quickMaskToolButton", "panToolButton", "brushToolButton", "mixerToolButton",
    "patternStampToolButton", "eraserToolButton", "cloneToolButton", "healToolButton",
    "spotHealingToolButton", "smudgeToolButton", "dodgeToolButton", "burnToolButton",
    "spongeToolButton", "blurToolButton", "sharpenToolButton", "gradientToolButton",
    "eyedropperToolButton", "penToolButton", "shapeToolButton", "textToolButton",
  ]) await selectTool(buttonId);

  await page.locator("#brushSizeInput").evaluate((input) => {
    input.value = "17"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await selectTool("brushToolButton");
  const hoverRevision = await revision();
  const hoverCanvas = await page.locator("#documentCanvas").boundingBox();
  assert.ok(hoverCanvas, "document canvas is not visible for brush hover");
  await page.mouse.move(hoverCanvas.x + hoverCanvas.width * .52,
    hoverCanvas.y + hoverCanvas.height * .48);
  await page.waitForFunction(() => !document.querySelector("#brushCursorOverlay")?.hidden);
  const hoverRing = await page.locator("#brushCursorOverlay").boundingBox();
  const hoverZoom = hoverCanvas.width / await page.locator("#documentCanvas")
    .evaluate((node) => node.width);
  assert.ok(hoverRing && Math.abs(hoverRing.width - 17 * hoverZoom) < 1.5,
    `brush hover radius is not tied to the selected size: ${JSON.stringify({ hoverRing, hoverZoom })}`);
  assert.equal(await revision(), hoverRevision, "hovering the brush mutated the document");
  await page.locator("#brushPresetSelect").selectOption("color-scatter");
  await page.locator("#brushOpacityInput").evaluate((input) => {
    input.value = "10"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#brushSettingsButton");
  assert.equal(await page.locator("#brushSettingsDialog").getAttribute("open"), "",
    "Brush settings did not open in the contextual inspector");
  assert.equal(await page.locator("#brushColorDynamicsEnabledInput").isChecked(), true);
  assert.equal(await page.locator("#brushForegroundBackgroundJitterInput").inputValue(), "60");
  assert.equal(await page.locator("#brushOpacityInput").inputValue(), "10",
    "Color Dynamics replaced the selected Brush Opacity cap");
  await page.locator('#brushSettingsDialog button[value="cancel"]').click();
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => document.querySelector("#brushCursorOverlay")?.hidden);
  const tools = [
    { buttonId: "brushToolButton", label: "Painting pixels",
      from: { x: .18, y: .2 }, to: { x: .4, y: .2 } },
    { buttonId: "eraserToolButton", label: "Erasing pixels",
      from: { x: .18, y: .2 }, to: { x: .4, y: .2 } },
    { buttonId: "smudgeToolButton", label: "Applying Smudge Brush",
      from: { x: .4, y: .5 }, to: { x: .6, y: .5 } },
    { buttonId: "dodgeToolButton", label: "Applying Dodge Brush",
      from: { x: .25, y: .4 }, to: { x: .45, y: .4 } },
    { buttonId: "burnToolButton", label: "Applying Burn Brush",
      from: { x: .6, y: .4 }, to: { x: .8, y: .4 } },
    { buttonId: "spongeToolButton", label: "Applying Sponge Brush",
      from: { x: .25, y: .65 }, to: { x: .45, y: .65 } },
    { buttonId: "blurToolButton", label: "Applying Blur Brush",
      from: { x: .4, y: .5 }, to: { x: .6, y: .5 } },
    { buttonId: "sharpenToolButton", label: "Applying Sharpen Brush",
      from: { x: .4, y: .5 }, to: { x: .6, y: .5 } },
    { buttonId: "mixerToolButton", label: "Applying Mixer Brush",
      from: { x: .2, y: .75 }, to: { x: .5, y: .75 } },
    { buttonId: "patternStampToolButton", label: "Applying Pattern Stamp",
      from: { x: .55, y: .75 }, to: { x: .8, y: .75 } },
  ];
  for (const tool of tools) await runPixelTool(tool);

  await selectTool("cloneToolButton");
  await dragCanvas({ x: .18, y: .3 }, { x: .18, y: .3 }, { steps: 1, modifiers: ["Alt"] });
  await runPixelTool({ buttonId: "cloneToolButton", label: "Painting pixels",
    from: { x: .55, y: .3 }, to: { x: .72, y: .3 } });
  await selectTool("healToolButton");
  await dragCanvas({ x: .2, y: .6 }, { x: .2, y: .6 }, { steps: 1, modifiers: ["Alt"] });
  await runPixelTool({ buttonId: "healToolButton", label: "Painting pixels",
    from: { x: .58, y: .6 }, to: { x: .74, y: .6 } });
  await runPixelTool({ buttonId: "spotHealingToolButton", label: "Applying Spot Healing",
    from: { x: .3, y: .32 }, to: { x: .45, y: .32 } });

  await selectTool("marqueeToolButton");
  let before = await revision();
  await dragCanvas({ x: .18, y: .18 }, { x: .42, y: .42 });
  await waitForMutation(before, "Selecting area");
  await runPixelTool({ buttonId: "patchToolButton", label: "Applying Patch",
    from: { x: .3, y: .3 }, to: { x: .48, y: .48 } });
  await page.locator("#paintPresetSelect").evaluate((select) => {
    select.value = "solid"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await selectTool("gradientToolButton");
  await (async () => {
    const beforeGradient = await revision();
    {
      assert.equal(await page.locator("#paintPresetSelect").inputValue(), "foreground-transparent",
        "Gradient kept an incompatible fill-only preset");
      assert.equal(await page.locator('#paintPresetSelect option[value="solid"]')
        .evaluate((option) => option.disabled && option.hidden), true,
        "Gradient left the Solid fill preset enabled");
      await page.locator("#paintPresetSelect").selectOption("black-white");
      await page.locator("#gradientTypeInput").selectOption("1");
      await dragCanvas({ x: .2, y: .22 }, { x: .4, y: .4 });
      assert.equal(await revision(), beforeGradient, "Gradient committed before Apply");
      assert.equal(await page.locator("#applyGradientButton").isEnabled(), true,
        "Gradient draft did not enable Apply");
      await dragCanvas({ x: .3, y: .31 }, { x: .3, y: .31 }, { steps: 1 });
      assert.equal(await page.locator("#gradientStopInput option").count(), 3,
        "Gradient line did not add a colour stop");
      await page.locator("#gradientStopOpacityInput").evaluate((input) => {
        input.value = "55"; input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click("#applyGradientButton");
      await waitForMutation(beforeGradient, "Applying gradient");
    }
  })();
  const beforeRepeatedGradient = await revision();
  await dragCanvas({ x: .2, y: .22 }, { x: .4, y: .4 });
  await page.click("#cancelGradientButton");
  assert.equal(await revision(), beforeRepeatedGradient,
    "cancelling a Gradient unexpectedly created a revision");
  assert.equal(await page.locator("#errorBanner").isHidden(), true,
    `repeated Gradient surfaced ${await page.textContent("#errorMessage")}`);

  const beforeFillRevision = await revision();
  const beforeFillPixels = await canvasDigest();
  await page.locator("#brushColorInput").evaluate((input) => {
    input.value = "#ff00aa"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await revealTool("fillToolButton");
  await page.click("#fillToolButton");
  assert.equal(await revision(), beforeFillRevision, "Fill ran while selecting the tool");
  await dragCanvas({ x: .28, y: .28 }, { x: .28, y: .28 }, { steps: 1 });
  await waitForMutation(beforeFillRevision, "Filling pixels");
  assert.notEqual(await canvasDigest(), beforeFillPixels, "Fill committed without changing rendered pixels");
  assert.equal(await page.locator("#errorBanner").isHidden(), true,
    `fillToolButton surfaced ${await page.textContent("#errorMessage")}`);

  const wandFixture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">' +
    '<rect width="40" height="60" fill="#ef2020"/><rect x="40" width="40" height="60" fill="#ffffff"/>' +
    '<rect x="80" width="40" height="60" fill="#ef2020"/></svg>');
  await page.locator("#fileInput").setInputFiles({ name: "magic-wand-fixture.svg",
    mimeType: "image/svg+xml", buffer: wandFixture });
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 3 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  await idle();
  await selectTool("magicToolButton");
  assert.equal(await page.locator("#wandContiguousInput").isVisible(), true,
    "Magic Wand did not expose the Contiguous option");
  assert.equal(await page.locator("#wandSampleAllInput").isVisible(), true,
    "Magic Wand did not expose the Sample all layers option");
  before = await revision();
  const wandCanvas = await page.locator("#documentCanvas").boundingBox();
  assert.ok(wandCanvas, "document canvas is not visible for Magic Wand");
  await page.locator("#selectionToleranceInput").evaluate((input) => {
    input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.mouse.click(wandCanvas.x + wandCanvas.width * .16,
    wandCanvas.y + wandCanvas.height * .5);
  await waitForMutation(before, "Selecting color with Magic Wand");
  assert.equal(await page.locator("#selectionOverlay").isHidden(), false,
    "Magic Wand did not render its committed selection");
  const contiguousPath = await page.locator("#selectionMarchPath").getAttribute("d");
  assert.ok(contiguousPath, "contiguous Magic Wand selection has no visible boundary");
  await page.locator("#wandContiguousInput").uncheck();
  await page.locator("#wandSampleAllInput").uncheck();
  before = await revision();
  await page.mouse.click(wandCanvas.x + wandCanvas.width * .16,
    wandCanvas.y + wandCanvas.height * .5);
  await waitForMutation(before, "Selecting color with Magic Wand");
  const nonContiguousPath = await page.locator("#selectionMarchPath").getAttribute("d");
  assert.notEqual(nonContiguousPath, contiguousPath,
    "non-contiguous Magic Wand did not add the disconnected matching colour");
  before = await revision();
  await page.mouse.click(wandCanvas.x + wandCanvas.width * .5,
    wandCanvas.y + wandCanvas.height * .5);
  await waitForMutation(before, "Selecting color with Magic Wand");
  assert.equal(await page.locator("#selectionOverlay").isHidden(), false,
    "Magic Wand did not select the white region");
  assert.equal(await page.locator("#errorBanner").isHidden(), true,
    `Magic Wand surfaced ${await page.textContent("#errorMessage")}`);

  await selectTool("eyedropperToolButton");
  const sampleRevision = await revision();
  await page.mouse.click(wandCanvas.x + wandCanvas.width * .5,
    wandCanvas.y + wandCanvas.height * .5);
  assert.equal(await page.locator("#foregroundSwatchInput").inputValue(), "#ffffff",
    "Eyedropper did not sample the visible white composite");
  assert.equal(await revision(), sampleRevision, "Eyedropper mutated the document");

  await selectTool("shapeToolButton");
  assert.equal(await page.locator("#shapeToolKindInput").isVisible(), true,
    "Shape did not expose a visible kind picker");
  assert.ok((await page.locator("#shapeToolKindInput").boundingBox())?.width >= 120,
    "Shape kind picker is not readable");
  await page.locator("#shapeToolKindInput").selectOption("star");
  await page.locator("#shapeToolSidesInput").fill("5");
  before = await revision();
  await dragCanvas({ x: .48, y: .15 }, { x: .75, y: .48 }, { modifiers: ["Shift"] });
  await waitForMutation(before, "Creating vector shape");
  assert.equal(await page.locator("#errorBanner").isHidden(), true,
    `Shape surfaced ${await page.textContent("#errorMessage")}`);

  await selectTool("textToolButton");
  await page.locator("#textToolFontInput").fill("Georgia");
  await page.locator("#textToolSizeInput").fill("28");
  await page.locator("#textToolStyleInput").selectOption("bold");
  await page.locator("#textToolAlignmentInput").selectOption("2");
  await page.click("#textSettingsButton");
  assert.equal(await page.locator("#textSettingsPopover").isVisible(), true,
    "Character settings did not open");
  assert.equal(await page.locator("#characterSettingsTab").getAttribute("aria-selected"), "true");
  await page.locator("#textToolPanelTrackingInput").fill("40");
  await page.locator("#textToolPanelLeadingInput").fill("34");
  await page.click("#paragraphSettingsTab");
  assert.equal(await page.locator("#paragraphSettingsPanel").isVisible(), true,
    "Paragraph settings did not open");
  await page.locator('input[name="textToolPanelAlignment"][value="2"]').check();
  await page.locator("#textToolPanelFirstIndentInput").fill("7");
  await page.click("#closeTextSettingsButton");
  const textCanvas = await page.locator("#documentCanvas").boundingBox();
  assert.ok(textCanvas, "document canvas is not visible for text");
  const clickX = textCanvas.x + textCanvas.width * .1;
  const clickY = textCanvas.y + textCanvas.height * .58;
  await page.mouse.click(clickX, clickY);
  await page.waitForFunction(() => !document.querySelector("#inlineTextEditor")?.hidden);
  const inlineBox = await page.locator("#inlineTextEditor").boundingBox();
  assert.ok(inlineBox && Math.abs(inlineBox.x - clickX) < 3 && Math.abs(inlineBox.y - clickY) < 3,
    `Text editor did not appear at the clicked point: ${JSON.stringify({ inlineBox, clickX, clickY })}`);
  const inlineStyle = await page.locator("#inlineTextEditor").evaluate((node) => ({
    family: node.style.fontFamily, size: node.style.fontSize, weight: node.style.fontWeight,
    align: node.style.textAlign, tracking: node.style.letterSpacing,
  }));
  assert.match(inlineStyle.family, /Georgia/);
  assert.equal(inlineStyle.weight, "700");
  assert.equal(inlineStyle.align, "center");
  assert.notEqual(inlineStyle.tracking, "0px");
  await page.locator("#inlineTextEditor").fill("Editable browser text");
  before = await revision();
  await page.locator("#inlineTextEditor").press("Control+Enter");
  await waitForMutation(before, "Creating text");
  await page.waitForFunction(() => document.querySelector("#inlineTextEditor")?.hidden);
  assert.equal(await page.locator("#errorBanner").isHidden(), true,
    `Text surfaced ${await page.textContent("#errorMessage")}`);
  await page.locator("#textLayerButton").evaluate((button) => button.click());
  await page.waitForFunction(() => document.querySelector("#textDialog")?.open);
  assert.equal(await page.locator("#textFontInput").inputValue(), "Georgia");
  assert.equal(await page.locator("#textSizeInput").inputValue(), "28");
  assert.equal(await page.locator("#textTrackingInput").inputValue(), "40");
  assert.equal(await page.locator("#textLeadingInput").inputValue(), "34");
  assert.equal(await page.locator("#textAlignmentInput").inputValue(), "2");
  assert.equal(await page.locator("#textFirstIndentInput").inputValue(), "7");
  await page.locator('#textDialog button.button[value="cancel"]').click();

  const layerCountBeforeSecondText = await page.locator("#layerList [data-layer-id]").count();
  await dragCanvas({ x: .74, y: .58 }, { x: .92, y: .76 });
  await page.waitForFunction(() => !document.querySelector("#inlineTextEditor")?.hidden);
  await page.locator("#inlineTextEditor").fill("Second text layer");
  before = await revision();
  await page.locator("#inlineTextEditor").evaluate((node) => node.blur());
  await waitForMutation(before, "Creating text");
  assert.equal(await page.locator("#layerList [data-layer-id]").count(),
    layerCountBeforeSecondText + 1, "The second text gesture did not create a new layer");
  const revisionBeforeCancel = await revision();
  const layerCountBeforeCancel = await page.locator("#layerList [data-layer-id]").count();
  await page.mouse.click(textCanvas.x + textCanvas.width * .48,
    textCanvas.y + textCanvas.height * .55);
  await page.waitForFunction(() => !document.querySelector("#inlineTextEditor")?.hidden);
  await page.locator("#inlineTextEditor").fill("Cancel me");
  await page.locator("#inlineTextEditor").press("Escape");
  assert.equal(await revision(), revisionBeforeCancel, "Escape committed inline text");
  assert.equal(await page.locator("#layerList [data-layer-id]").count(), layerCountBeforeCancel,
    "Escape created an inline text layer");

  await page.click("#newButton");
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 4 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  before = await revision();
  await page.click("#createPixelLayerButton");
  await waitForMutation(before, "Creating pixel layer");
  await selectTool("brushToolButton");
  await page.locator("#brushPresetSelect").selectOption("color-scatter");
  await page.locator("#brushOpacityInput").evaluate((input) => {
    input.value = "10"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  before = await revision();
  await dragCanvas({ x: .5, y: .5 }, { x: .5, y: .5 }, { steps: 1 });
  await waitForMutation(before, "Painting pixels");
  const maximumStrokeAlpha = await page.locator("#documentCanvas").evaluate((canvas) => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let maximum = 0;
    for (let index = 3; index < pixels.length; index += 4) maximum = Math.max(maximum, pixels[index]);
    return maximum;
  });
  assert.ok(maximumStrokeAlpha <= 26,
    `Color Dynamics Count dabs exceeded the 10% stroke-opacity cap: ${maximumStrokeAlpha}`);

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  console.log(`BROWSER-TOOL-RUNTIME browser=${browserName} open=png-jpeg-two-tabs layout=contained tools=30-described-activated ` +
    "hover=idle-brush-radius wand=contiguous-all-layers-active-layer-svg gradient=preset-guard-noop-neutral " +
    `brush=color-dynamics-opacity-cap-${maximumStrokeAlpha} ` +
    "paint=advanced-brush-eraser-clone-heal-spot-patch-smudge-dodge-burn-sponge-blur-sharpen-mixer-pattern-gradient-fill " +
    "authoring=eyedropper-shape-text real-pointer=pass");
} catch (error) {
  const diagnostic = await page.evaluate(() => ({
    state: document.querySelector(".editor-shell")?.dataset.state,
    busy: document.querySelector(".editor-shell")?.getAttribute("aria-busy"),
    tool: document.querySelector("#canvasViewport")?.dataset.tool,
    revision: document.querySelector("#detailRevision")?.textContent,
    error: document.querySelector("#errorMessage")?.textContent,
  })).catch(() => null);
  console.error("BROWSER-TOOL-RUNTIME-DIAGNOSTIC",
    JSON.stringify({ diagnostic, pageErrors, failedRequests }));
  throw error;
} finally {
  await browser.close();
}
