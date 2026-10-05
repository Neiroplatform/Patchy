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
function splitColorPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; ++y) {
    const row = y * (WIDTH * 4 + 1); rows[row] = 0;
    for (let x = 0; x < WIDTH; ++x) {
      const pixel = row + 1 + x * 4;
      rows[pixel] = x < WIDTH / 2 ? 230 : 30;
      rows[pixel + 1] = 35;
      rows[pixel + 2] = x < WIDTH / 2 ? 40 : 225;
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

  await page.click("#brushToolButton");
  assert.equal(await page.locator("#brushPresetSelect").isVisible(), true);
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
  const paintedBefore = await canvasPixel(80, 50);
  before = await revision();
  await dragCanvas("brushToolButton", { x: .48, y: .5 }, { x: .52, y: .5 }, 72);
  await waitForMutation(before, "Painting pixels");
  const paintedAfter = await canvasPixel(80, 50);
  assert.notDeepEqual(paintedAfter.slice(0, 3), paintedBefore.slice(0, 3));

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
  const pixelsBeforeErase = await canvasPixels();
  before = await revision();
  await dragCanvas("eraserToolButton", { x: .48, y: .5 }, { x: .52, y: .5 }, 73);
  await waitForMutation(before, "Erasing pixels");
  const pixelsAfterErase = await canvasPixels();
  const erasedAlphaCount = pixelsAfterErase.reduce((count, value, index) =>
    index % 4 === 3 && value < pixelsBeforeErase[index] ? count + 1 : count, 0);
  assert.ok(erasedAlphaCount > 0, `eraser did not lower alpha in any rendered pixel; center=${paintedAfter}`);

  await page.click("#penToolButton");
  assert.equal(await page.locator("#finishPenPathButton").isVisible(), true);
  await clickCanvasPoints("penToolButton", [[.18, .2], [.42, .72], [.7, .28]]);
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
  before = await revision();
  await page.click("#finishPenPathButton");
  await waitForMutation(before, "Creating Pen path");
  assert.equal(await page.locator("#pathList button").count(), 1);
  assert.equal(await page.locator("#pathList button").getAttribute("aria-pressed"), "true");

  await clickCanvasPoints("penToolButton", [[.22, .25], [.46, .76], [.74, .34]]);
  assert.equal(await page.locator("#closePenPathButton").isEnabled(), true);
  before = await revision();
  await page.click("#closePenPathButton");
  await waitForMutation(before, "Creating Pen path");
  assert.equal(await page.locator("#pathList button").count(), 2);
  assert.match(await page.locator("#pathOverlayLine").getAttribute("d"), /Z$/);

  before = await revision();
  await dragCanvas("marqueeToolButton", { x: .06, y: .16 }, { x: .4, y: .84 }, 74);
  await waitForMutation(before, "Selecting area");
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
  console.log(`EDITOR-CONTROL-CORRECTIVE browser=${browserName} pen=open-closed clipboard=selection-only layers=add-delete opacity-fill=quick-properties brush=preset-softness-opacity eraser=pass`);
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
