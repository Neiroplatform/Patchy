import assert from "node:assert/strict";
import { createRequire } from "node:module";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("usage: node wasm_object_selection_harness_smoke.mjs <site-url>");
async function loadPlaywright() {
  try { return await import("playwright"); }
  catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) throw error;
    return createRequire(import.meta.url)(root);
  }
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true,
  ...(process.env.PATCHY_SOFTWARE_GL === "1" ? { args: ["--use-angle=swiftshader"] } : {}),
  ...(process.env.PATCHY_BROWSER_CHANNEL ? { channel: process.env.PATCHY_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
  extraHTTPHeaders: { "Accept-Encoding": "identity" } });
const page = await context.newPage();
const errors = []; const remoteRequests = []; const allRequests = [];
const expectedOrigin = new URL(baseUrl).origin;
page.on("pageerror", (error) => errors.push(String(error)));
page.on("request", (request) => {
  const url = request.url();
  allRequests.push(url);
  if (url.startsWith("http") && new URL(url).origin !== expectedOrigin) remoteRequests.push(url);
});

async function dropSvg(name, contents, { width = 256, height = 256 } = {}) {
  const tabCountBefore = await page.locator('#documentTabs [role="tab"]').count();
  await page.evaluate(({ name, contents }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([contents], name, { type: "image/svg+xml" }));
    globalThis.dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true, dataTransfer: transfer,
    }));
  }, { name, contents });
  await page.waitForFunction(({ tabCountBefore, width, height }) =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === tabCountBefore + 1 &&
    document.querySelector("#documentCanvas")?.width === width &&
    document.querySelector("#documentCanvas")?.height === height &&
    Number(document.querySelector("#layerCount")?.textContent) === 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { tabCountBefore, width, height }, { timeout: 90_000 });
}

async function canvasPixel(x, y) {
  return page.evaluate(({ x, y }) => [...document.querySelector("#documentCanvas")
    .getContext("2d").getImageData(x, y, 1, 1).data], { x, y });
}

async function selectObjectTool() {
  if (!(await page.locator("#objectSelectToolButton").isVisible())) {
    await page.click('.tool-cluster[data-tool-group="selection"] > .tool-group-toggle');
  }
  await page.click("#objectSelectToolButton");
}

async function waitForObjectPreview(timeout = 90_000) {
  await page.waitForFunction(() => {
    const status = document.querySelector("#objectSelectionStatus")?.textContent || "";
    const toast = document.querySelector("#actionToast")?.textContent || "";
    return /preview ready|preview unavailable|cancelled/i.test(status) ||
      /object select unavailable|failed/i.test(toast);
  }, null, { timeout });
  const state = await page.evaluate(() => ({
    status: document.querySelector("#objectSelectionStatus")?.textContent || "",
    toast: document.querySelector("#actionToast")?.textContent || "",
    applyDisabled: Boolean(document.querySelector("#applyObjectSelectionButton")?.disabled),
  }));
  assert.match(state.status, /preview ready/i, JSON.stringify(state));
  assert.equal(state.applyDisabled, false, JSON.stringify(state));
  return state;
}

try {
  await page.goto(new URL("./capabilities.html", baseUrl).href, { waitUntil: "domcontentloaded" });
  const poisonedCache = await page.evaluate(async () => {
    const { OBJECT_SEGMENTATION_MODEL, OBJECT_SEGMENTATION_RUNTIME } =
      await import("./object-segmentation.mjs");
    const cacheName = `patchy-ml-${OBJECT_SEGMENTATION_MODEL.sha256.slice(0, 12)}-${
      OBJECT_SEGMENTATION_RUNTIME.bundleSha256.slice(0, 12)}`;
    const modelUrl = new URL(OBJECT_SEGMENTATION_MODEL.path, location.href).href;
    const cache = await caches.open(cacheName);
    await cache.put(modelUrl, new Response(new Uint8Array(32), {
      status: 200, headers: { "Content-Type": "application/octet-stream" },
    }));
    return (await (await cache.match(modelUrl)).arrayBuffer()).byteLength;
  });
  assert.equal(poisonedCache, 32, "the startup cache fixture did not install a truncated model");
  await page.route("**/magic-touch-int8-v1.task", async (route) => route.fulfill({
    status: 200, contentType: "application/octet-stream", body: Buffer.alloc(32),
  }), { times: 1 });
  const startupModelRequest = page.waitForRequest((request) =>
    request.url().includes("magic-touch-int8-v1.task"), { timeout: 90_000 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready",
    null, { timeout: 90_000 });
  await startupModelRequest;
  assert.equal(allRequests.some((url) => url.includes("magic-touch-int8-v1.task")), true,
    "local Object Select model did not start background loading after editor readiness");
  assert.equal(await page.locator("#objectSelectToolButton").count(), 1);
  assert.equal(await page.locator("#actionHarnessButton").count(), 1);
  await dropSvg("object-select-atomic.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
    <rect width="256" height="256" fill="#ffffff"/>
    <circle cx="30" cy="128" r="16" fill="#0066ff"/>
    <rect x="72" y="56" width="112" height="144" rx="20" fill="#111111"/>
    <circle cx="128" cy="128" r="18" fill="#f97316"/>
  </svg>`);
  await page.waitForFunction(() => !document.querySelector("#actionHarnessButton")?.disabled,
    null, { timeout: 90_000 });
  await selectObjectTool();

  const inference = await page.evaluate(async () => {
    const { ObjectSegmentationClient, clickPromptStroke, rectanglePromptStroke } =
      await import("./object-segmentation.mjs");
    const source = new OffscreenCanvas(96, 96); const target = source.getContext("2d");
    target.fillStyle = "#fff"; target.fillRect(0, 0, 96, 96);
    target.fillStyle = "#111"; target.fillRect(24, 20, 48, 56);
    const identity = { documentId: "fixture", stateId: "1", revision: 0, width: 96, height: 96 };
    const client = new ObjectSegmentationClient(); const progress = [];
    try { await client.setImage(source.transferToImageBitmap(), identity,
      ({ phase }) => progress.push(phase)); }
    catch (error) { throw new Error(`${error.message}; progress=${progress.join(",")}`); }
    const positive = { isCompleted: true, brushMode: 1,
      point: clickPromptStroke({ x: 48, y: 48 }, 96, 96) };
    const result = await client.segment([positive], identity);
    const refined = await client.segment([positive, { isCompleted: true, brushMode: 2,
      point: clickPromptStroke({ x: 8, y: 8 }, 96, 96) }], identity);
    const boxed = await client.segment([{ isCompleted: true, brushMode: 3,
      point: rectanglePromptStroke({ x: 20, y: 16 }, { x: 76, y: 80 }, 96, 96) }], identity);
    const range = (mask) => ({ maximum: mask.reduce((value, next) => Math.max(value, next), 0),
      minimum: mask.reduce((value, next) => Math.min(value, next), 1) });
    const clickRange = range(result.confidence); const refinedRange = range(refined.confidence);
    const boxRange = range(boxed.confidence);
    const resized = new OffscreenCanvas(112, 96); const resizedTarget = resized.getContext("2d");
    resizedTarget.fillStyle = "#fff"; resizedTarget.fillRect(0, 0, 112, 96);
    resizedTarget.fillStyle = "#111"; resizedTarget.fillRect(32, 20, 48, 56);
    const resizedIdentity = { ...identity, stateId: "2", width: 112 };
    const recreatedReady = await client.setImage(resized.transferToImageBitmap(), resizedIdentity);
    const recreated = await client.segment([{ isCompleted: true, brushMode: 1,
      point: clickPromptStroke({ x: 56, y: 48 }, 112, 96) }], resizedIdentity);
    const recreatedRange = range(recreated.confidence);
    client.close();
    return { width: result.width, height: result.height, ...clickRange,
      refinedRange, boxRange, recreatedReady, recreatedRange, latencyMs: result.latencyMs,
      refinementMs: refined.latencyMs, boxMs: boxed.latencyMs };
  });
  assert.ok(inference.width > 0 && inference.height > 0);
  assert.ok(inference.maximum > inference.minimum, JSON.stringify(inference));
  assert.ok(inference.refinedRange.maximum > inference.refinedRange.minimum, JSON.stringify(inference));
  assert.ok(inference.boxRange.maximum > inference.boxRange.minimum, JSON.stringify(inference));
  assert.equal(inference.recreatedReady.previewWidth, 112, JSON.stringify(inference));
  assert.equal(inference.recreatedReady.previewHeight, 96, JSON.stringify(inference));
  assert.ok(inference.recreatedRange.maximum > inference.recreatedRange.minimum,
    JSON.stringify(inference));
  assert.ok(inference.latencyMs >= 0);

  assert.equal(allRequests.some((url) => url.includes("magic-touch-int8-v1.task")), true);
  const backgroundBefore = await canvasPixel(16, 16);
  const upperSubjectBefore = await canvasPixel(100, 80);
  const lowerSubjectBefore = await canvasPixel(156, 180);
  const revisionBefore = Number((await page.locator("#detailRevision").textContent()).trim());
  await page.click("#actionHarnessButton");
  await page.fill("#actionPromptInput", "Удали фон");
  await page.click("#buildActionPlanButton");
  assert.deepEqual(await page.locator("#actionPlanSteps li").allTextContents(),
    ["1. select-object · automatic subject", "2. isolate-selection"]);
  assert.match(await page.locator("#actionPlanStatus").textContent(), /One Undo restores/i);
  await page.click("#executeActionPlanButton");
  await page.waitForFunction(() =>
    /one Undo restores/i.test(document.querySelector("#actionToast")?.textContent || "") &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  null, { timeout: 90_000 });
  const revisionAfter = Number((await page.locator("#detailRevision").textContent()).trim());
  assert.ok(revisionAfter >= revisionBefore + 3, `${revisionBefore}->${revisionAfter}`);
  assert.equal(await page.locator("#undoButton").isEnabled(), true);
  assert.equal((await page.locator("#historyList .history-label").allTextContents())
    .filter((label) => label === "AI edit · Удали фон").length, 1);
  const backgroundAfter = await canvasPixel(16, 16);
  assert.ok(backgroundAfter[3] < backgroundBefore[3],
    `background was not removed: ${backgroundBefore} -> ${backgroundAfter}`);
  assert.deepEqual(await canvasPixel(100, 80), upperSubjectBefore,
    "automatic foreground collapsed to the small object covering the centre");
  assert.deepEqual(await canvasPixel(156, 180), lowerSubjectBefore,
    "automatic foreground lost the distant extent of the main subject");
  assert.equal(Number(await page.locator("#layerCount").textContent()), 2,
    "background removal did not create an isolated foreground layer");
  assert.equal(await page.locator('#layerList .visibility-button[aria-label^="Show "]').count(), 1,
    "background removal did not hide its source layer");

  await page.click("#undoButton");
  await page.waitForFunction(({ revisionAfter }) =>
    Number(document.querySelector("#detailRevision")?.textContent) > revisionAfter &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { revisionAfter }, { timeout: 90_000 });
  assert.deepEqual(await canvasPixel(16, 16), backgroundBefore,
    "one Undo did not restore the pre-plan document");
  assert.equal(Number(await page.locator("#layerCount").textContent()), 1,
    "one Undo did not remove the isolated foreground layer");
  assert.equal(await page.locator("#redoButton").isEnabled(), true);

  await page.keyboard.press("Control+a");
  await page.click("#actionHarnessButton");
  await page.fill("#actionPromptInput", "Удали фон");
  await page.click("#buildActionPlanButton");
  assert.deepEqual(await page.locator("#actionPlanSteps li").allTextContents(),
    ["1. select-object · automatic subject", "2. isolate-selection"],
    "a full-canvas selection was incorrectly reused as an object mask");
  await page.click("#discardActionPlanButton");
  await page.click('#actionHarnessDialog button[aria-label="Close"]');
  await page.keyboard.press("Control+d");

  await page.selectOption("#objectPromptModeInput", "click");
  await page.selectOption("#selectionModeInput", "replace");
  const clickCanvas = async (x, y, id, { shiftKey = false } = {}) => page.evaluate(
    ({ x, y, id, shiftKey }) => {
      const canvas = document.querySelector("#documentCanvas"); const rect = canvas.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, pointerId: id,
        pointerType: "mouse", isPrimary: true, button: 0, shiftKey,
        clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y };
      canvas.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
    }, { x, y, id, shiftKey });
  await clickCanvas(.5, .5, 901);
  await waitForObjectPreview();
  await clickCanvas(30 / 256, .5, 902, { shiftKey: true });
  const additive = await waitForObjectPreview();
  assert.match(additive.status, /^Add preview ready/i);
  assert.equal(await page.locator("#selectionModeInput").inputValue(), "replace",
    "Shift-add changed the stored selection mode");
  const layersBeforeClipboard = Number(await page.locator("#layerCount").textContent());
  // Ctrl+C on a reviewed Object Select preview commits that preview through
  // the canonical selection command before copying, matching direct-editor UX.
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForFunction(({ layersBeforeClipboard }) =>
    Number(document.querySelector("#layerCount")?.textContent) === layersBeforeClipboard + 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { layersBeforeClipboard }, { timeout: 10_000 });
  await page.keyboard.press("Control+z");
  await page.waitForFunction(({ layersBeforeClipboard }) =>
    Number(document.querySelector("#layerCount")?.textContent) === layersBeforeClipboard &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { layersBeforeClipboard }, { timeout: 10_000 });
  await page.keyboard.press("Control+v");
  await page.waitForFunction(({ layersBeforeClipboard }) =>
    Number(document.querySelector("#layerCount")?.textContent) === layersBeforeClipboard + 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { layersBeforeClipboard }, { timeout: 10_000 });
  const layersBeforeRemoval = Number(await page.locator("#layerCount").textContent());
  const leftBeforeCut = await canvasPixel(30, 128);
  const centerBeforeCut = await canvasPixel(128, 128);
  const lowerBeforeCut = await canvasPixel(156, 180);
  const backgroundBeforeReuse = await canvasPixel(220, 20);
  await page.click("#actionHarnessButton");
  await page.fill("#actionPromptInput", "Удали фон");
  await page.click("#buildActionPlanButton");
  assert.deepEqual(await page.locator("#actionPlanSteps li").allTextContents(),
    ["1. select-object · automatic subject", "2. isolate-selection"],
    "plain background removal incorrectly reused a stale object selection");
  const revisionBeforeReuse = Number((await page.locator("#detailRevision").textContent()).trim());
  await page.click("#executeActionPlanButton");
  await page.waitForFunction(({ revisionBeforeReuse }) =>
    Number(document.querySelector("#detailRevision")?.textContent) >= revisionBeforeReuse + 2 &&
    [...document.querySelectorAll("#historyList .history-label")]
      .some((item) => item.textContent === "AI edit · Удали фон") &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { revisionBeforeReuse }, { timeout: 90_000 });
  assert.ok((await canvasPixel(30, 128))[3] < leftBeforeCut[3],
    "stale Shift-added object survived automatic foreground replacement");
  assert.deepEqual(await canvasPixel(128, 128), centerBeforeCut,
    "automatic foreground subject was lost");
  assert.deepEqual(await canvasPixel(156, 180), lowerBeforeCut,
    "automatic foreground narrowed to the nested centre detail");
  assert.ok((await canvasPixel(220, 20))[3] < backgroundBeforeReuse[3],
    "background was not removed around the additive selection");
  assert.equal(Number(await page.locator("#layerCount").textContent()), layersBeforeRemoval + 1,
    "background removal did not isolate the visible composite above duplicate layers");
  assert.equal(await page.locator('#layerList .visibility-button[aria-label^="Show "]').count(),
    layersBeforeRemoval, "background removal left a duplicate source visible");
  await page.click("#undoButton");
  await page.waitForFunction(() =>
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  assert.equal(Number(await page.locator("#layerCount").textContent()), layersBeforeRemoval,
    "one Undo did not restore the duplicate-layer source document");
  await page.click("#actionHarnessButton");
  await page.fill("#actionPromptInput", "Удали фон по выделению");
  await page.click("#buildActionPlanButton");
  assert.deepEqual(await page.locator("#actionPlanSteps li").allTextContents(),
    ["1. isolate-selection"],
    "an explicit request to use the committed selection triggered new inference");
  await page.click("#discardActionPlanButton");
  await page.click('#actionHarnessDialog button[aria-label="Close"]');

  await page.selectOption("#objectPromptModeInput", "points");
  await page.evaluate(() => {
    const canvas = document.querySelector("#documentCanvas"); const rect = canvas.getBoundingClientRect();
    const fire = (x, y, id) => {
      const init = { bubbles: true, cancelable: true, pointerId: id, pointerType: "mouse",
        isPrimary: true, button: 0, clientX: rect.left + rect.width * x,
        clientY: rect.top + rect.height * y };
      canvas.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
    };
    fire(.5, .5, 903);
  });
  await page.waitForFunction(() => /preview ready/i.test(
    document.querySelector("#objectSelectionStatus")?.textContent || ""), null, { timeout: 90_000 });
  await page.selectOption("#objectPromptPolarityInput", "negative");
  await page.evaluate(() => {
    globalThis.__objectStatusObserver?.disconnect(); globalThis.__objectStatusChanges = 0;
    globalThis.__objectStatusValues = [];
    globalThis.__objectStatusObserver = new MutationObserver(() => {
      globalThis.__objectStatusChanges += 1;
      globalThis.__objectStatusValues.push(document.querySelector("#objectSelectionStatus")?.textContent || "");
    });
    globalThis.__objectStatusObserver.observe(document.querySelector("#objectSelectionStatus"),
      { childList: true, characterData: true, subtree: true });
  });
  const modelRequestsBeforeRefinement = allRequests.filter((url) =>
    url.includes("magic-touch-int8-v1.task")).length;
  await page.evaluate(() => {
    const canvas = document.querySelector("#documentCanvas"); const rect = canvas.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, pointerId: 904, pointerType: "mouse",
      isPrimary: true, button: 0, clientX: rect.left + rect.width * .08,
      clientY: rect.top + rect.height * .08 };
    canvas.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  });
  await page.waitForFunction(() => globalThis.__objectStatusChanges >= 2 && /preview ready/i.test(
    document.querySelector("#objectSelectionStatus")?.textContent || "") &&
    !document.querySelector("#applyObjectSelectionButton")?.disabled,
  null, { timeout: 10_000 });
  assert.equal(allRequests.filter((url) => url.includes("magic-touch-int8-v1.task")).length,
    modelRequestsBeforeRefinement, "point refinement re-requested the immutable model");
  const refinementEvidence = await page.evaluate(() => ({
    status: document.querySelector("#objectSelectionStatus")?.textContent || "",
    values: globalThis.__objectStatusValues || [],
  }));
  assert.equal(refinementEvidence.values.some((value) => /loading local|initializing/i.test(value)), false,
    `point refinement rebuilt the image embedding: ${refinementEvidence.values.join(" | ")}`);
  const refinementTiming = refinementEvidence.status.match(/\b(gpu|wasm)\s*·\s*(\d+)\s*ms/i);
  assert.ok(refinementTiming, refinementEvidence.status);
  assert.ok(Number(refinementTiming[2]) <= (refinementTiming[1].toLowerCase() === "gpu" ? 2500 : 10_000),
    `point refinement exceeded its ${refinementTiming[1]} tier budget: ${refinementEvidence.status}`);

  await page.selectOption("#objectPromptModeInput", "box");
  await page.evaluate(() => { globalThis.__objectStatusChanges = 0; globalThis.__objectStatusValues = []; });
  const modelRequestsBeforeBox = allRequests.filter((url) => url.includes("magic-touch-int8-v1.task")).length;
  const canvasBounds = await page.locator("#documentCanvas").boundingBox();
  assert.ok(canvasBounds, "document canvas has no browser bounds");
  await page.mouse.move(canvasBounds.x + canvasBounds.width * .2,
    canvasBounds.y + canvasBounds.height * .15);
  await page.mouse.down();
  await page.mouse.move(canvasBounds.x + canvasBounds.width * .8,
    canvasBounds.y + canvasBounds.height * .85, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(() => globalThis.__objectStatusChanges >= 2 && /preview ready/i.test(
    document.querySelector("#objectSelectionStatus")?.textContent || "") &&
    !document.querySelector("#applyObjectSelectionButton")?.disabled,
  null, { timeout: 10_000 });
  assert.equal(allRequests.filter((url) => url.includes("magic-touch-int8-v1.task")).length,
    modelRequestsBeforeBox, "box prompt re-requested the immutable model");
  const boxEvidence = await page.evaluate(() => ({
    status: document.querySelector("#objectSelectionStatus")?.textContent || "",
    values: globalThis.__objectStatusValues || [],
  }));
  assert.equal(boxEvidence.values.some((value) => /loading local|initializing/i.test(value)), false,
    `box prompt rebuilt the image embedding: ${boxEvidence.values.join(" | ")}`);
  const boxTiming = boxEvidence.status.match(/\b(gpu|wasm)\s*·\s*(\d+)\s*ms/i);
  assert.ok(boxTiming, boxEvidence.status);
  assert.ok(Number(boxTiming[2]) <= (boxTiming[1].toLowerCase() === "gpu" ? 2500 : 10_000),
    `box prompt exceeded its ${boxTiming[1]} tier budget: ${boxEvidence.status}`);
  await page.click("#cancelObjectSelectionButton");

  await dropSvg("object-select-off-centre-product.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
    <rect width="1600" height="1000" fill="#caa574"/>
    <g fill="#358b2d">
      <ellipse cx="330" cy="220" rx="160" ry="90"/>
      <ellipse cx="500" cy="180" rx="180" ry="110"/>
      <ellipse cx="600" cy="310" rx="160" ry="100"/>
      <ellipse cx="360" cy="360" rx="190" ry="110"/>
    </g>
    <rect x="330" y="420" width="300" height="350" fill="#eee1cb"/>
    <rect x="900" y="670" width="600" height="220" fill="#fafafa"/>
  </svg>`, { width: 1600, height: 1000 });
  const productLeafBefore = await canvasPixel(400, 250);
  const productPotBefore = await canvasPixel(450, 600);
  const productBackgroundBefore = await canvasPixel(1200, 200);
  const productDistractorBefore = await canvasPixel(1200, 760);
  const productRevisionBefore = Number((await page.locator("#detailRevision").textContent()).trim());
  await page.click("#actionHarnessButton");
  await page.fill("#actionPromptInput", "Удали фон");
  await page.click("#buildActionPlanButton");
  await page.click("#executeActionPlanButton");
  await page.waitForFunction(({ productRevisionBefore }) =>
    Number(document.querySelector("#detailRevision")?.textContent) >= productRevisionBefore + 3 &&
    /one Undo restores/i.test(document.querySelector("#actionToast")?.textContent || "") &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { productRevisionBefore }, { timeout: 90_000 });
  assert.deepEqual(await canvasPixel(400, 250), productLeafBefore,
    "off-centre non-person crown was removed");
  assert.deepEqual(await canvasPixel(450, 600), productPotBefore,
    "split lower part of the non-person subject was not joined");
  assert.ok((await canvasPixel(1200, 200))[3] < productBackgroundBefore[3],
    "off-centre product background remained opaque");
  assert.ok((await canvasPixel(1200, 760))[3] < productDistractorBefore[3],
    "separate product-scene distractor was retained");
  await page.click("#undoButton");
  await page.waitForFunction(() =>
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  assert.deepEqual(await canvasPixel(1200, 760), productDistractorBefore,
    "one Undo did not restore the non-person source scene");

  await dropSvg("object-select-production-size.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
    <rect width="1600" height="1000" fill="#263038"/>
    <rect x="590" y="120" width="560" height="820" rx="170" fill="#d7b7a2"/>
    <rect x="500" y="470" width="760" height="470" rx="150" fill="#20262c"/>
    <rect x="480" y="520" width="210" height="390" rx="95" fill="#20262c"/>
    <rect x="1070" y="520" width="210" height="390" rx="95" fill="#20262c"/>
    <ellipse cx="690" cy="555" rx="115" ry="78" fill="#14191d"/>
  </svg>`, { width: 1600, height: 1000 });
  const productionBackgroundBefore = await canvasPixel(40, 40);
  const productionSubjectBefore = await canvasPixel(850, 700);
  const productionRevisionBefore = Number((await page.locator("#detailRevision").textContent()).trim());
  await page.click("#actionHarnessButton");
  await page.fill("#actionPromptInput", "Удали фон");
  await page.click("#buildActionPlanButton");
  await page.click("#executeActionPlanButton");
  await page.waitForFunction(({ productionRevisionBefore }) =>
    Number(document.querySelector("#detailRevision")?.textContent) >= productionRevisionBefore + 3 &&
    Number(document.querySelector("#layerCount")?.textContent) === 2 &&
    /one Undo restores/i.test(document.querySelector("#actionToast")?.textContent || "") &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { productionRevisionBefore }, { timeout: 90_000 });
  assert.ok((await canvasPixel(40, 40))[3] < productionBackgroundBefore[3],
    "production-size background removal did not become transparent");
  assert.deepEqual(await canvasPixel(850, 700), productionSubjectBefore,
    "production-size background removal lost the main subject");
  assert.equal(await page.locator('#layerList .visibility-button[aria-label^="Show "]').count(), 1,
    "production-size background removal did not hide its source layer");
  const productionLayersAfterRemoval = Number(await page.locator("#layerCount").textContent());
  const revisionBeforeClearingPostActionSelection = Number(
    (await page.locator("#detailRevision").textContent()).trim());
  await page.keyboard.press("Control+d");
  await page.waitForFunction(({ revisionBeforeClearingPostActionSelection }) =>
    Number(document.querySelector("#detailRevision")?.textContent) >
      revisionBeforeClearingPostActionSelection &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { revisionBeforeClearingPostActionSelection }, { timeout: 10_000 });
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForFunction(({ productionLayersAfterRemoval }) =>
    Number(document.querySelector("#layerCount")?.textContent) === productionLayersAfterRemoval + 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { productionLayersAfterRemoval }, { timeout: 10_000 });
  assert.doesNotMatch(await page.locator("#actionToast").textContent(),
    /stale document state|request is stale/i,
    "the first clipboard operation after the atomic action used a stale snapshot");
  await page.click("#undoButton");
  await page.waitForFunction(({ productionLayersAfterRemoval }) =>
    Number(document.querySelector("#layerCount")?.textContent) === productionLayersAfterRemoval &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { productionLayersAfterRemoval }, { timeout: 10_000 });
  await page.click("#undoButton");
  await page.waitForFunction(() =>
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await page.click("#undoButton");
  await page.waitForFunction(() =>
    Number(document.querySelector("#layerCount")?.textContent) === 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  null, { timeout: 90_000 });
  assert.deepEqual(await canvasPixel(40, 40), productionBackgroundBefore,
    "production-size one-step Undo did not restore the source document");
  assert.deepEqual(remoteRequests, []);
  assert.deepEqual(errors, []);
  console.log(`OBJECT-SELECTION-HARNESS PASS model=${inference.width}x${inference.height} latencyMs=${Math.round(inference.latencyMs)} refinementMs=${Math.round(inference.refinementMs)} boxMs=${Math.round(inference.boxMs)} atomicUndo=1`);
} finally {
  await browser.close();
}
