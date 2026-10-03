import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

const baseUrl = process.argv[2];
const browserName = process.argv[3] || "chromium";
if (!baseUrl || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node tests/sdk/wasm_reference_workflow_smoke.mjs <served-repository-url> [chromium|firefox|webkit]");
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

const SOURCE_WIDTH = 640;
const SOURCE_HEIGHT = 480;

function referencePng(width = SOURCE_WIDTH, height = SOURCE_HEIGHT) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; ++y) {
    const row = y * (width * 4 + 1); rows[row] = 0;
    for (let x = 0; x < width; ++x) {
      const pixel = row + 1 + x * 4;
      rows[pixel] = Math.round(255 * x / (width - 1));
      rows[pixel + 1] = Math.round(255 * y / (height - 1));
      rows[pixel + 2] = (x * 13 + y * 7) % 256;
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
let capturedDownload = null;
let resolveCapturedDownload;
const capturedDownloadPromise = new Promise((resolve) => { resolveCapturedDownload = resolve; });
await page.exposeFunction("__patchyCaptureDownload", (payload) => {
  capturedDownload = payload; resolveCapturedDownload(payload);
});
await page.addInitScript(() => {
  Object.defineProperty(globalThis, "showOpenFilePicker", { configurable: true, value: undefined });
  Object.defineProperty(globalThis, "showSaveFilePicker", { configurable: true, value: undefined });
  const blobs = new Map(); const createObjectUrl = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { const url = createObjectUrl(blob); blobs.set(url, blob); return url; };
  const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => { setTimeout(() => blobs.delete(url), 0); revokeObjectUrl(url); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function captureDownloadClick() {
    const blob = blobs.get(this.href);
    if (blob && this.download) {
      const reader = new FileReader();
      reader.addEventListener("load", () => globalThis.__patchyCaptureDownload({ name: this.download, dataUrl: reader.result }));
      reader.readAsDataURL(blob);
      return;
    }
    return click.call(this);
  };
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function captureCreatedAnchor(name, options) {
    const element = createElement.call(this, name, options);
    if (String(name).toLowerCase() !== "a") return element;
    Object.defineProperty(element, "click", { configurable: true, value() {
      const blob = blobs.get(element.href);
      if (!blob || !element.download) return click.call(element);
      const reader = new FileReader();
      reader.addEventListener("load", () => globalThis.__patchyCaptureDownload({ name: element.download, dataUrl: reader.result }));
      reader.readAsDataURL(blob);
    } });
    return element;
  };
});

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

const editorUrl = `${baseUrl.replace(/\/$/, "")}/build/wasm-sdk/site/patchy.html?reference-workflow-smoke=1`;
const ready = () => page.waitForFunction(() =>
  document.querySelector(".editor-shell")?.dataset.state === "document" &&
  document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
{ timeout: 90_000 });
const revision = async () => Number((await page.textContent("#detailRevision")).trim());
const historyLabels = () => page.locator("#historyList .history-label").allTextContents();

async function dragCanvas(toolButtonId, from, to) {
  await page.evaluate(({ toolButtonId, from, to }) => {
    document.getElementById(toolButtonId).click();
    const canvas = document.getElementById("documentCanvas");
    const rect = canvas.getBoundingClientRect();
    canvas.setPointerCapture = () => {};
    const dispatch = (type, point, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 83, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: rect.left + rect.width * point.x,
      clientY: rect.top + rect.height * point.y,
    }));
    dispatch("pointerdown", from, 1); dispatch("pointermove", to, 1); dispatch("pointerup", to, 0);
    delete canvas.setPointerCapture;
  }, { toolButtonId, from, to });
}

async function lassoCanvas(points) {
  await page.evaluate((points) => {
    document.getElementById("lassoToolButton").click();
    const canvas = document.getElementById("documentCanvas"); const rect = canvas.getBoundingClientRect();
    canvas.setPointerCapture = () => {};
    const dispatch = (type, point, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 84, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: rect.left + rect.width * point.x, clientY: rect.top + rect.height * point.y,
    }));
    dispatch("pointerdown", points[0], 1);
    for (const point of points.slice(1)) dispatch("pointermove", point, 1);
    dispatch("pointerup", points.at(-1), 0); delete canvas.setPointerCapture;
  }, points);
}

async function openCanvasMenu(position = { x: 0.55, y: 0.55 }) {
  await page.evaluate((position) => {
    const canvas = document.getElementById("documentCanvas");
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2, buttons: 2,
      clientX: rect.left + rect.width * position.x,
      clientY: rect.top + rect.height * position.y,
    }));
  }, position);
  await page.waitForSelector("#canvasContextMenu:not([hidden])");
}

try {
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });

  await page.setInputFiles("#fileInput", {
    name: "reference-photo.png", mimeType: "image/png", buffer: referencePng(),
  });
  await ready();
  await page.waitForFunction(() =>
    document.querySelector("#detailCanvas")?.textContent === "640 × 480" &&
    document.querySelectorAll("#layerList .layer-row").length === 1 &&
    document.querySelector("#detailRevision")?.textContent === "1", null, { timeout: 90_000 });
  assert.match(await page.locator('#documentTabs [aria-selected="true"]').getAttribute("title"),
    /reference-photo\.psd/);
  assert.ok((await historyLabels()).includes("Importing pixels"));
  assert.equal(await page.locator("#workspacePanelLayers").isVisible(), true);
  assert.equal(await page.locator("#workspacePanelHistory").isVisible(), true);
  const layerMenuTrigger = page.locator(".command-menu-trigger", { hasText: "Layer" });
  await layerMenuTrigger.click();
  assert.equal(await page.locator(".command-menu-panel:not([hidden]) > .command-submenu").count(), 3);
  await page.locator(".command-submenu-trigger", { hasText: "Transform" }).click();
  assert.equal(await page.locator(".command-submenu-panel:not([hidden])").count(), 1);
  await page.keyboard.press("Escape");

  const beforeSelection = await revision();
  await dragCanvas("marqueeToolButton", { x: .18, y: .2 }, { x: .76, y: .78 });
  await page.waitForFunction((before) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 1 &&
    !document.querySelector("#selectionOverlay")?.hidden &&
    !document.querySelector("#layerViaCopyButton")?.disabled,
  beforeSelection, { timeout: 90_000 });
  assert.ok((await page.locator("#selectionMarchPath").getAttribute("d"))?.length > 8);

  await openCanvasMenu();
  assert.equal(await page.locator("#canvasContextMenu").getAttribute("role"), "menu");
  assert.equal(await page.locator('#canvasContextMenu [data-command-proxy="layer.layerViaCopy"]').isDisabled(), false);
  assert.equal(await page.evaluate(() => document.activeElement ===
    document.querySelector('#canvasContextMenu [data-target-proxy="clearSelectionButton"]')), true);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.targetProxy), "invertSelectionButton");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#canvasContextMenu").isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "canvasViewport");

  await openCanvasMenu();
  const beforeCopy = await revision();
  await page.click('#canvasContextMenu [data-command-proxy="layer.layerViaCopy"]');
  await page.waitForFunction((before) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 1 &&
    document.querySelectorAll("#layerList .layer-row").length === 2 &&
    document.querySelector('.layer-row[data-active="true"] .layer-name')?.textContent === "Layer 1",
  beforeCopy, { timeout: 90_000 });
  await ready();
  assert.ok((await historyLabels()).includes("Layer via copy"));

  const beforeLasso = await revision();
  await lassoCanvas([{ x: .18, y: .16 }, { x: .78, y: .22 }, { x: .68, y: .76 }, { x: .24, y: .7 }]);
  await page.waitForFunction((before) => Number(document.querySelector("#detailRevision")?.textContent) === before + 1,
    beforeLasso, { timeout: 90_000 });
  await ready();
  assert.ok((await historyLabels()).includes("Selecting freehand area"));
  if (process.env.PATCHY_REFERENCE_SCREENSHOT_DIR) {
    await mkdir(process.env.PATCHY_REFERENCE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.PATCHY_REFERENCE_SCREENSHOT_DIR}/${browserName}-selection-contour.png` });
  }

  const beforeMagic = await revision();
  await page.evaluate(() => {
    document.getElementById("magicToolButton").click();
    const canvas = document.getElementById("documentCanvas"); const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 85,
      pointerType: "mouse", isPrimary: true, button: 0, buttons: 1,
      clientX: rect.left + rect.width * .5, clientY: rect.top + rect.height * .5 }));
  });
  await page.waitForFunction((before) => Number(document.querySelector("#detailRevision")?.textContent) === before + 1,
    beforeMagic, { timeout: 90_000 });
  await ready();
  assert.ok((await historyLabels()).includes("Selecting connected color"));

  const background = page.locator("#layerList .layer-row").filter({
    has: page.locator(".layer-name", { hasText: "reference-photo" }),
  });
  const beforeVisibility = await revision();
  await background.locator(".visibility-button").click();
  await page.waitForFunction((before) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 1,
  beforeVisibility, { timeout: 90_000 });
  await ready();
  assert.equal(await background.locator(".visibility-button").textContent(), "○");

  await openCanvasMenu();
  await page.click('#canvasContextMenu [data-target-proxy="layerTransformButton"]');
  await page.waitForSelector("#layerTransformDialog[open]");
  assert.equal(await page.locator('#transformOverlay [data-transform-handle]').count(), 8);
  const transformCancelRevision = await revision();
  await page.click("#cancelTransformButton");
  assert.equal(await revision(), transformCancelRevision);
  await openCanvasMenu();
  await page.click('#canvasContextMenu [data-target-proxy="layerTransformButton"]');
  await page.waitForSelector("#layerTransformDialog[open]");
  await page.selectOption("#layerTransformModeInput", "perspective");
  await page.evaluate(() => {
    const handle = document.querySelector('[data-transform-handle="corner-0"]');
    const canvas = document.querySelector("#documentCanvas"); const box = canvas.getBoundingClientRect();
    const x = Number(handle.getAttribute("cx")); const y = Number(handle.getAttribute("cy"));
    handle.setPointerCapture = () => {};
    const dispatch = (type, dx, buttons) => handle.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 91, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: box.left + (x + dx) / canvas.width * box.width,
      clientY: box.top + y / canvas.height * box.height,
    }));
    dispatch("pointerdown", 0, 1); dispatch("pointermove", 3, 1); dispatch("pointerup", 3, 0);
    delete handle.setPointerCapture;
  });
  if (process.env.PATCHY_REFERENCE_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.PATCHY_REFERENCE_SCREENSHOT_DIR}/${browserName}-transform-direct.png` });
  }
  const beforeTransform = await revision();
  await page.click("#applyTransformButton");
  await page.waitForFunction((before) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 1 &&
    !document.querySelector("#layerTransformDialog")?.open,
  beforeTransform, { timeout: 90_000 });
  await ready();
  assert.ok((await historyLabels()).includes("Transforming layer"));

  await dragCanvas("cropToolButton", { x: .1, y: .1 }, { x: .86, y: .84 });
  const cropCancelRevision = await revision();
  await page.click("#cancelCropButton");
  assert.equal(await revision(), cropCancelRevision);
  assert.equal(await page.locator("#cropOverlay").getAttribute("hidden"), "");

  const beforeCrop = await revision();
  await dragCanvas("cropToolButton", { x: .06, y: .08 }, { x: .92, y: .9 });
  const cropUi = await page.evaluate(() => ({ tool: document.querySelector("#canvasViewport")?.dataset.tool,
    hidden: document.querySelector("#cropOverlay")?.hasAttribute("hidden"),
    boundary: [...document.querySelector("#cropBoundary")?.attributes || []].map((item) => [item.name, item.value]),
    box: (() => { const box = document.querySelector("#cropOverlay")?.getBoundingClientRect();
      return box ? { width: box.width, height: box.height } : null; })(),
    frameBox: (() => { const box = document.querySelector("#canvasFrame")?.getBoundingClientRect();
      return box ? { width: box.width, height: box.height } : null; })(),
    style: (() => { const style = getComputedStyle(document.querySelector("#cropOverlay"));
      return { display: style.display, position: style.position, width: style.width, height: style.height }; })(),
  }));
  assert.equal(cropUi.tool, "crop", `crop UI state ${JSON.stringify(cropUi)}`);
  assert.equal(cropUi.hidden, false, `crop UI state ${JSON.stringify(cropUi)}`);
  assert.ok(cropUi.box?.width > 0 && cropUi.box?.height > 0, `crop UI state ${JSON.stringify(cropUi)}`);
  assert.equal(await page.locator("#cropHandles circle").count(), 8);
  assert.match(await page.locator("#cropGrid").getAttribute("d"), /M/);
  if (process.env.PATCHY_REFERENCE_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.PATCHY_REFERENCE_SCREENSHOT_DIR}/${browserName}-crop-direct.png` });
  }
  const cropSize = await page.evaluate(() => {
    const boundary = document.querySelector("#cropBoundary");
    return { width: Number(boundary.getAttribute("width")), height: Number(boundary.getAttribute("height")) };
  });
  assert.ok(cropSize.width > 0 && cropSize.width < SOURCE_WIDTH && cropSize.height > 0 && cropSize.height < SOURCE_HEIGHT,
    `crop gesture produced ${JSON.stringify(cropSize)}`);
  await page.click("#applyCropButton");
  await page.waitForFunction(({ before, width, height }) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 1 &&
    document.querySelector("#detailCanvas")?.textContent === `${width} × ${height}`,
  { before: beforeCrop, ...cropSize }, { timeout: 90_000 });

  const croppedRevision = await revision();
  await page.click("#undoButton");
  await page.waitForFunction((before) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 1 &&
    document.querySelector("#detailCanvas")?.textContent === "640 × 480",
  croppedRevision, { timeout: 90_000 });
  await page.click("#redoButton");
  await page.waitForFunction(({ before, width, height }) =>
    Number(document.querySelector("#detailRevision")?.textContent) === before + 2 &&
    document.querySelector("#detailCanvas")?.textContent === `${width} × ${height}`,
  { before: croppedRevision, ...cropSize }, { timeout: 90_000 });

  await page.evaluate(() => document.querySelector("#saveAsButton").click());
  let downloadTimeout;
  await Promise.race([capturedDownloadPromise, new Promise((_, reject) => {
    downloadTimeout = setTimeout(() => reject(new Error("layered download capture timed out")), 90_000);
  })]);
  clearTimeout(downloadTimeout);
  const layeredBytes = Buffer.from(capturedDownload.dataUrl.split(",", 2)[1], "base64");
  assert.equal(layeredBytes.subarray(0, 4).toString("ascii"), "8BPS");
  await page.setInputFiles("#fileInput", {
    name: capturedDownload.name, mimeType: "image/vnd.adobe.photoshop", buffer: layeredBytes,
  });
  await ready();
  await page.waitForFunction(({ width, height }) =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 2 &&
    document.querySelectorAll("#layerList .layer-row").length === 2 &&
    document.querySelector("#detailCanvas")?.textContent === `${width} × ${height}`,
  cropSize, { timeout: 90_000 });

  for (const viewport of [
    { width: 1440, height: 900 }, { width: 820, height: 1180 },
    { width: 390, height: 844 }, { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `${viewport.width}x${viewport.height} has horizontal overflow`);
    await openCanvasMenu({ x: .98, y: .98 });
    assert.equal(await page.locator("#canvasContextMenu").evaluate((menu) => {
      const box = menu.getBoundingClientRect();
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + .5 && box.bottom <= innerHeight + .5;
    }), true, `canvas menu overflows ${viewport.width}x${viewport.height}`);
    await page.keyboard.press("Escape");
  }

  const screenshotDir = process.env.PATCHY_REFERENCE_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvasMenu();
    await page.screenshot({ path: `${screenshotDir}/${browserName}-reference-workflow.png`, fullPage: true });
  }

  assert.deepEqual(unexpectedNetwork, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(`REFERENCE-WORKFLOW-SOURCE-SMOKE browser=${browserName} open=raster layers=2 context=pass perspective=pass crop=${cropSize.width}x${cropSize.height} roundtrip=psd viewports=4`);
} finally {
  await browser.close();
}
