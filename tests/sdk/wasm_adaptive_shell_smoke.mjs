import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const baseUrl = process.argv[2];
const browserName = process.argv[3] || "chromium";
if (!baseUrl || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node tests/sdk/wasm_adaptive_shell_smoke.mjs <served-repository-url> [chromium|firefox|webkit]");
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
const launchOptions = browserName === "chromium" && process.env.PATCHY_BROWSER_CHANNEL
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

const editorUrl = `${baseUrl.replace(/\/$/, "")}/build/wasm-sdk/site/patchy.html?adaptive-shell-smoke=1`;
const screenshotDir = process.env.PATCHY_ADAPTIVE_SHELL_SCREENSHOT_DIR;
const viewports = [
  { width: 1440, height: 900, placement: "side" },
  { width: 1024, height: 768, placement: "side" },
  { width: 760, height: 900, placement: "bottom" },
  { width: 390, height: 844, placement: "bottom" },
  { width: 320, height: 720, placement: "bottom" },
];

try {
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".tool-cluster").length === 8 &&
    document.querySelector(".editor-shell")?.dataset.state === "ready", null, { timeout: 90_000 });
  const emptyLayout = await page.evaluate(() => {
    const stage = document.querySelector(".stage").getBoundingClientRect();
    const canvas = document.querySelector(".canvas-viewport").getBoundingClientRect();
    const footer = document.querySelector(".stage-footer").getBoundingClientRect();
    return {
      canvasStartsAtStage: Math.abs(canvas.top - stage.top) <= .5,
      footerEndsAtStage: Math.abs(footer.bottom - stage.bottom) <= .5,
      canvasFillsRemainder: Math.abs(canvas.bottom - footer.top) <= .5,
    };
  });
  assert.deepEqual(emptyLayout, {
    canvasStartsAtStage: true,
    footerEndsAtStage: true,
    canvasFillsRemainder: true,
  }, "empty workspace must fill the stage instead of leaving an implicit grid row");
  await page.click("#emptyNewButton");
  await page.click('[data-starter-preset="blank"]');
  await page.waitForFunction(() =>
    document.querySelector(".editor-shell")?.dataset.state === "document" &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  null, { timeout: 90_000 });

  assert.equal(await page.locator("#documentStructureLayersTab #layerCount").count(), 1,
    "Layers count must be integrated into its active tab");
  assert.equal(await page.locator("#historyHistoryTab #historyCount").count(), 1,
    "History count must be integrated into its active tab");
  assert.equal(await page.locator("#documentStructureLayersPane > .panel-header").count(), 0,
    "Layers must not repeat its active tab as a second heading");
  assert.equal(await page.locator("#historyHistoryPane > .panel-header").count(), 0,
    "History must not repeat its active tab as a second heading");

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.evaluate((expectedPlacement) => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height };
      };
      const topbar = box(".topbar");
      const workspace = box(".workspace");
      const stage = box(".stage");
      const inspector = box(".inspector");
      const meta = box(".stage-meta");
      const optionRows = [...document.querySelector("#toolOptions").children]
        .filter((node) => !node.hidden && getComputedStyle(node).display !== "none")
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return Math.round((rect.top + rect.bottom) / 2);
        });
      const primaryTools = [...document.querySelectorAll(".tool-cluster > .tool-button")]
        .map((button) => button.getBoundingClientRect());
      const activeTool = document.querySelector("#activeToolContext").getBoundingClientRect();
      const command = document.querySelector("#commandPaletteButton").getBoundingClientRect();
      const actions = document.querySelector(".document-actions");
      return {
        expectedPlacement,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + .5,
        topbarOwnsWorkspaceEdge: Math.abs(topbar.bottom - workspace.top) <= .5,
        stageContained: stage.left >= -.5 && stage.right <= innerWidth + .5,
        placement: stage.right <= inspector.left + .5 ? "side" :
          stage.bottom <= inspector.top + .5 ? "bottom" : "overlap",
        metaHeight: meta.height,
        optionRows: new Set(optionRows).size,
        activeToolVisible: activeTool.width > 0 && activeTool.height > 0 &&
          activeTool.left >= 0 && activeTool.right <= innerWidth + .5,
        commandVisible: command.width > 0 && command.height >= 24,
        actionOverflowIsScrollable: actions.scrollWidth <= actions.clientWidth + .5 ||
          ["auto", "scroll"].includes(getComputedStyle(actions).overflowX),
        touchTargets: innerWidth > 560 || primaryTools.every((rect) => rect.width >= 40 && rect.height >= 40),
      };
    }, viewport.placement);
    assert.equal(layout.horizontalOverflow, false, `${viewport.width}px has page overflow`);
    assert.equal(layout.topbarOwnsWorkspaceEdge, true, `${viewport.width}px topbar overlaps workspace`);
    assert.equal(layout.stageContained, true, `${viewport.width}px stage escapes viewport`);
    assert.equal(layout.placement, viewport.placement,
      `${viewport.width}px inspector placement is ${layout.placement}`);
    assert.ok(layout.metaHeight <= 64.5, `${viewport.width}px contextual strip is ${layout.metaHeight}px`);
    assert.equal(layout.optionRows, 1, `${viewport.width}px tool controls are not a stable single row`);
    assert.equal(layout.activeToolVisible, true, `${viewport.width}px hides the active-tool identity`);
    assert.equal(layout.commandVisible, true, `${viewport.width}px hides the command fallback`);
    assert.equal(layout.actionOverflowIsScrollable, true, `${viewport.width}px traps document actions`);
    assert.equal(layout.touchTargets, true, `${viewport.width}px has undersized primary tool targets`);
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({
        path: `${screenshotDir}/${browserName}-${viewport.width}x${viewport.height}.png`,
        fullPage: true,
      });
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const beforeRevision = await page.textContent("#detailRevision");
  await page.click("#workspacePanelHistoryButton");
  await page.selectOption("#workspaceModeSelect", "painting");
  await page.click("#workspacePanelPropertiesButton");
  assert.equal(await page.textContent("#detailRevision"), beforeRevision,
    "layout-only panel and workspace routing changed document revision");
  assert.equal(await page.getAttribute("#workspacePanelPropertiesButton", "aria-selected"), "true");
  assert.deepEqual(unexpectedNetwork, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(`ADAPTIVE-SHELL-SOURCE-SMOKE browser=${browserName} viewports=${viewports.length} revision=${beforeRevision}`);
} finally {
  await browser.close();
}
