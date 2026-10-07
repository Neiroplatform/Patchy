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
      labels: labels.map((rect) => ({ left: rect.left, right: rect.right })) };
  });
  const assertOptionsLayout = (optionsLayout) => {
    assert.ok(optionsLayout.optionsRight <= optionsLayout.stageRight + .5,
      `tool options escape the stage: ${JSON.stringify(optionsLayout)}`);
    assert.ok(optionsLayout.optionsScrollWidth <= optionsLayout.optionsClientWidth + 1,
      `brush controls require hidden horizontal scrolling: ${JSON.stringify(optionsLayout)}`);
    assert.ok(optionsLayout.labels.every((rect) => rect.left >= optionsLayout.optionsLeft - .5 &&
      rect.right <= optionsLayout.optionsRight + .5),
    `brush controls are clipped: ${JSON.stringify(optionsLayout.labels)}`);
    for (let index = 1; index < optionsLayout.labels.length; ++index) {
      assert.ok(optionsLayout.labels[index].left >= optionsLayout.labels[index - 1].right - .5,
        `brush controls overlap: ${JSON.stringify(optionsLayout.labels)}`);
    }
  };
  assertOptionsLayout(await measureOptionsLayout());
  await page.setViewportSize({ width: 1280, height: 900 });
  assertOptionsLayout(await measureOptionsLayout());

  const toolInventory = await page.locator("[data-tool-contract]").evaluateAll((buttons) =>
    buttons.map((button) => ({ id: button.id, contract: button.dataset.toolContract,
      description: button.getAttribute("aria-description") || "" })));
  assert.equal(toolInventory.length, 28, "the browser tool catalog changed without runtime coverage");
  assert.equal(new Set(toolInventory.map(({ contract }) => contract)).size, 28,
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
    "penToolButton",
  ]) await selectTool(buttonId);
  await selectTool("textToolButton");
  await page.locator("#textDialog").press("Escape");
  await page.waitForFunction(() => !document.querySelector("#textDialog")?.open);

  await page.locator("#brushSizeInput").evaluate((input) => {
    input.value = "17"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
  await runPixelTool({ buttonId: "gradientToolButton", label: "Applying gradient",
    from: { x: .2, y: .22 }, to: { x: .4, y: .4 } });

  const beforeFillRevision = await revision();
  const beforeFillPixels = await canvasDigest();
  await page.locator("#brushColorInput").evaluate((input) => {
    input.value = "#ff00aa"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await revealTool("fillToolButton");
  await page.click("#fillToolButton");
  await waitForMutation(beforeFillRevision, "Filling pixels");
  assert.notEqual(await canvasDigest(), beforeFillPixels, "Fill committed without changing rendered pixels");
  assert.equal(await page.locator("#errorBanner").isHidden(), true,
    `fillToolButton surfaced ${await page.textContent("#errorMessage")}`);

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  console.log(`BROWSER-TOOL-RUNTIME browser=${browserName} open=png-jpeg-two-tabs layout=contained tools=28-described-activated ` +
    "paint=brush-eraser-clone-heal-spot-patch-smudge-dodge-burn-sponge-blur-sharpen-mixer-pattern-gradient-fill real-pointer=pass");
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
