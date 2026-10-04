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

const revision = async () => Number((await page.textContent("#detailRevision")).trim());
async function waitForMutation(before, label) {
  await page.waitForFunction(({ before, label }) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true" &&
    [...document.querySelectorAll("#historyList .history-label")]
      .some((node) => node.textContent === label), { before, label }, { timeout: 30_000 });
}

async function dragTool(toolButtonId, from, to, { source = null } = {}) {
  await page.evaluate(({ toolButtonId, from, to, source }) => {
    document.getElementById(toolButtonId).click();
    const canvas = document.getElementById("documentCanvas"); const box = canvas.getBoundingClientRect();
    canvas.setPointerCapture = () => {};
    const dispatch = (type, point, buttons, pointerId, altKey = false) =>
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId, pointerType: "mouse", isPrimary: true,
        button: 0, buttons, altKey,
        clientX: box.left + box.width * point.x, clientY: box.top + box.height * point.y,
      }));
    if (source) dispatch("pointerdown", source, 1, 70, true);
    dispatch("pointerdown", from, 1, 71); dispatch("pointermove", to, 1, 71);
    dispatch("pointerup", to, 0, 71); delete canvas.setPointerCapture;
  }, { toolButtonId, from, to, source });
}

async function clickToolPoints(toolButtonId, points) {
  await page.evaluate(({ toolButtonId, points }) => {
    document.getElementById(toolButtonId).click();
    const canvas = document.getElementById("documentCanvas"); const box = canvas.getBoundingClientRect();
    for (const [index, point] of points.entries()) canvas.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerId: 80 + index, pointerType: "mouse",
      isPrimary: true, button: 0, buttons: 1,
      clientX: box.left + box.width * point[0], clientY: box.top + box.height * point[1],
    }));
  }, { toolButtonId, points });
  await page.keyboard.press("Enter");
}

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
      contract: button.dataset.toolContract || "",
      interaction: button.getAttribute("aria-description") || "",
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
  const interactionContracts = inventory.filter(({ contract }) => contract);
  assert.equal(interactionContracts.length, 28);
  assert.equal(new Set(interactionContracts.map(({ contract }) => contract)).size, 28);
  for (const tool of interactionContracts) {
    assert.ok(tool.interaction.length >= 24, `${tool.id} is missing a usable interaction description`);
  }
  await page.selectOption("#localeSelect", "ru");
  const russianContracts = await page.locator("[data-tool-contract]").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-description") || ""));
  assert.equal(russianContracts.length, 28);
  assert.equal(russianContracts.every((value, index) => value.length >= 24 &&
    value !== interactionContracts[index].interaction), true,
  "every tool contract must be readable and translated in Russian");
  await page.selectOption("#localeSelect", "en");

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
    assert.equal(await page.locator("#layerList .layer-row").count(), 0);
    assert.equal(await page.locator("#brushToolButton").isDisabled(), false);
    await page.click("#brushToolButton");
    await page.waitForFunction(() => document.querySelectorAll("#layerList .layer-row").length === 1 &&
      document.querySelector("#detailRevision")?.textContent === "1" &&
      document.querySelector("#canvasViewport")?.dataset.tool === "brush", null, { timeout: 90_000 });
    assert.match(await page.locator("#toolInstruction").textContent(), /Drag to paint/);
    await dragTool("brushToolButton", { x: .35, y: .35 }, { x: .65, y: .65 });
    await waitForMutation(1, "Painting pixels");

    for (const contract of [
      ["eraserToolButton", "Erasing pixels", { x: .48, y: .48 }, { x: .54, y: .54 }, null],
      ["cloneToolButton", "Painting pixels", { x: .22, y: .42 }, { x: .34, y: .54 }, { x: .5, y: .5 }],
      ["healToolButton", "Painting pixels", { x: .7, y: .42 }, { x: .76, y: .54 }, { x: .52, y: .52 }],
      ["gradientToolButton", "Applying gradient", { x: .1, y: .1 }, { x: .9, y: .9 }, null],
      ["quickSelectToolButton", "Applying Quick Select", { x: .3, y: .3 }, { x: .62, y: .62 }, null],
      ["quickMaskToolButton", "Committing Quick Mask stroke", { x: .25, y: .7 }, { x: .7, y: .7 }, null],
    ]) {
      const [button, label, from, to, source] = contract;
      const before = await revision();
      await dragTool(button, from, to, { source });
      await waitForMutation(before, label);
    }

    let before = await revision();
    await clickToolPoints("polygonToolButton", [[.2, .2], [.8, .25], [.55, .75]]);
    await waitForMutation(before, "Selecting polygonal area");

    before = await revision();
    await clickToolPoints("magneticToolButton", [[.22, .22], [.78, .3], [.52, .72]]);
    await waitForMutation(before, "Closing Magnetic Lasso");

    await page.evaluate(() => document.getElementById("penToolButton").click());
    assert.match(await page.locator("#toolInstruction").textContent(), /at least three anchor points/);
    before = await revision();
    await clickToolPoints("penToolButton", [[.3, .3], [.7, .35], [.55, .72]]);
    await waitForMutation(before, "Creating Pen path");
    await page.evaluate(() => document.getElementById("textToolButton").click());
    await page.waitForSelector("#textDialog[open]");
    await page.fill("#textValueInput", "Icon QA");
    await page.click("#commitTextButton");
    await page.waitForFunction(() => document.querySelectorAll(".layer-row").length === 2 &&
      document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
    { timeout: 30_000 });
    assert.equal(await page.locator(".visibility-button").count(), 2);
    assert.equal(await page.locator(".reorder-button").count(), 4);
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
