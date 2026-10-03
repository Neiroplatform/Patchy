import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const baseUrl = process.argv[2];
const browserName = process.argv[3] || "chromium";
if (!baseUrl || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node tests/sdk/wasm_iconography_ui_smoke.mjs <served-repository-url> [chromium|firefox|webkit]");
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
const expectedOrigin = new URL(baseUrl).origin;
const unexpectedNetwork = [];
const failedRequests = [];
const pageErrors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith("http") && new URL(url).origin !== expectedOrigin) unexpectedNetwork.push(url);
});
page.on("requestfailed", (request) => failedRequests.push(
  `${request.url()} ${request.failure()?.errorText || "failed"}`));
page.on("pageerror", (error) => pageErrors.push(String(error)));

const editorUrl = `${baseUrl.replace(/\/$/, "")}/build/wasm-sdk/site/patchy.html?iconography-smoke=1`;
const screenshotDir = process.env.PATCHY_ICON_SCREENSHOT_DIR;

try {
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".tool-cluster").length === 8,
    null, { timeout: 15_000 });

  const inventory = await page.evaluate(() => [...document.querySelectorAll(".tool-button")].map((button) => {
    const icon = button.querySelector(".ui-icon");
    const use = icon?.querySelector("use");
    const box = icon?.getBBox();
    return {
      id: button.id,
      label: button.getAttribute("aria-label"),
      title: button.title,
      href: use?.getAttribute("href"),
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      visible: getComputedStyle(button).display !== "none",
      stroke: icon ? getComputedStyle(icon).stroke : "",
      color: getComputedStyle(button).color,
    };
  }));
  assert.equal(inventory.length, 31);
  assert.equal(new Set(inventory.map(({ href }) => href)).size, 31);
  for (const icon of inventory) {
    assert.ok(icon.id && icon.label && icon.title, JSON.stringify(icon));
    assert.match(icon.href, /^#icon-/);
    if (icon.visible) assert.ok(icon.width >= 9 && icon.height >= 9,
      `${icon.id} has an empty or illegible SVG box`);
    assert.equal(icon.stroke, icon.color, `${icon.id} does not follow currentColor`);
  }

  for (const group of ["transform", "selection", "paint", "retouch", "tone", "fill", "draw", "navigation"]) {
    const cluster = page.locator(`[data-tool-group="${group}"]`);
    const toggle = cluster.locator(":scope > .tool-group-toggle");
    const primary = cluster.locator(":scope > .tool-button");
    assert.ok(await toggle.getAttribute("aria-label"));
    await primary.hover();
    await page.waitForTimeout(150);
    const tooltip = await primary.evaluate((button) => ({
      content: getComputedStyle(button, "::after").content,
      opacity: getComputedStyle(button, "::after").opacity,
    }));
    assert.equal(tooltip.content.replaceAll('"', ""), await primary.getAttribute("aria-label"));
    assert.equal(tooltip.opacity, "1");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await cluster.locator(".tool-group-menu").isVisible(), true);
    assert.equal(await cluster.locator(".tool-group-menu .tool-button").evaluateAll((buttons) =>
      buttons.every((button) => {
        const label = getComputedStyle(button, "::after").content.replaceAll('"', "");
        const box = button.getBoundingClientRect();
        return label === button.getAttribute("aria-label") && box.height >= 24 && box.width >= 24;
      })), true, `${group} menu lost a visible name or target floor`);
    assert.equal(await cluster.locator(".tool-group-menu").evaluate((menu) => {
      const box = menu.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + .5;
    }), true, `${group} menu overflows the viewport`);
    await toggle.click();
  }

  for (const viewport of [
    { width: 1440, height: 900 }, { width: 820, height: 1180 },
    { width: 390, height: 844 }, { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `${viewport.width}x${viewport.height} has horizontal overflow`);
    const selectionToggle = page.locator('[data-tool-group="selection"] > .tool-group-toggle');
    await selectionToggle.click();
    assert.equal(await page.locator('[data-tool-group="selection"] .tool-group-menu').evaluate((menu) => {
      const box = menu.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + .5;
    }), true, `selection menu overflows ${viewport.width}px`);
    await selectionToggle.click();
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.ok(await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.querySelector(".tool-button")).transitionDuration) <= 0.000001),
  "reduced motion no longer reaches icon controls");

  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-tool-group="retouch"] > .tool-group-toggle').click();
    await page.screenshot({ path: `${screenshotDir}/${browserName}-retouch-1440.png`, fullPage: true });
    await page.locator('[data-tool-group="retouch"] > .tool-group-toggle').click();
    await page.locator('[data-tool-group="selection"] > .tool-button').hover();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${screenshotDir}/${browserName}-tooltip-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.screenshot({ path: `${screenshotDir}/${browserName}-compact-search-820.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-tool-group="paint"] > .tool-group-toggle').click();
    await page.screenshot({ path: `${screenshotDir}/${browserName}-paint-390.png`, fullPage: true });
  }

  if (process.env.PATCHY_ICON_ENGINE_QA === "1") {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready" &&
      document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
    { timeout: 90_000 });
    await page.click("#emptyNewButton");
    await page.click('[data-starter-preset="blank"]');
    await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "document" &&
      document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
    { timeout: 90_000 });
    await page.click("#textLayerButton");
    await page.fill("#textValueInput", "Icon QA");
    await page.click("#commitTextButton");
    await page.waitForSelector(".layer-row", { state: "visible", timeout: 30_000 });
    assert.equal(await page.locator(".visibility-button").count(), 1);
    assert.equal(await page.locator(".reorder-button").count(), 2);
    if (screenshotDir) await page.screenshot({
      path: `${screenshotDir}/${browserName}-layer-controls-1440.png`, fullPage: true,
    });
  }

  assert.deepEqual(unexpectedNetwork, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(`ICONOGRAPHY-SOURCE-SMOKE browser=${browserName} tools=${inventory.length} groups=8 viewports=4`);
} finally {
  await browser.close();
}
