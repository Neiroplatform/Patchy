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

async function dropSvg(name, contents) {
  await page.evaluate(({ name, contents }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([contents], name, { type: "image/svg+xml" }));
    globalThis.dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true, dataTransfer: transfer,
    }));
  }, { name, contents });
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 1 &&
    document.querySelector("#documentCanvas")?.width === 256 &&
    document.querySelector("#documentCanvas")?.height === 256 &&
    Number(document.querySelector("#layerCount")?.textContent) === 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  null, { timeout: 90_000 });
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
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready",
    null, { timeout: 90_000 });
  assert.equal(allRequests.some((url) => url.includes("magic-touch-int8-v1.task")), false,
    "optional model was included in the initial editor load");
  assert.equal(await page.locator("#objectSelectToolButton").count(), 1);
  assert.equal(await page.locator("#actionHarnessButton").count(), 1);
  await dropSvg("object-select-atomic.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
    <rect width="256" height="256" fill="#ffffff"/>
    <circle cx="30" cy="128" r="16" fill="#0066ff"/>
    <rect x="72" y="56" width="112" height="144" rx="20" fill="#111111"/>
  </svg>`);
  await page.waitForFunction(() => !document.querySelector("#actionHarnessButton")?.disabled,
    null, { timeout: 90_000 });
  await selectObjectTool();
  assert.equal(allRequests.some((url) => url.includes("magic-touch-int8-v1.task")), false,
    "selecting Object Select must not download the optional model before a prompt");

  const inference = await page.evaluate(async () => {
    const { ObjectSegmentationClient, clickPromptStroke, rectanglePromptStroke } =
      await import("./object-segmentation.mjs");
    const source = new OffscreenCanvas(96, 96); const target = source.getContext("2d");
    target.fillStyle = "#fff"; target.fillRect(0, 0, 96, 96);
    target.fillStyle = "#111"; target.fillRect(24, 20, 48, 56);
    const bitmap = source.transferToImageBitmap();
    const identity = { documentId: "fixture", stateId: "1", revision: 0, width: 96, height: 96 };
    const client = new ObjectSegmentationClient(); const progress = [];
    try { await client.setImage(bitmap, identity, ({ phase }) => progress.push(phase)); }
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
    client.close();
    return { width: result.width, height: result.height, ...clickRange,
      refinedRange, boxRange, latencyMs: result.latencyMs,
      refinementMs: refined.latencyMs, boxMs: boxed.latencyMs };
  });
  assert.ok(inference.width > 0 && inference.height > 0);
  assert.ok(inference.maximum > inference.minimum, JSON.stringify(inference));
  assert.ok(inference.refinedRange.maximum > inference.refinedRange.minimum, JSON.stringify(inference));
  assert.ok(inference.boxRange.maximum > inference.boxRange.minimum, JSON.stringify(inference));
  assert.ok(inference.latencyMs >= 0);

  assert.equal(allRequests.some((url) => url.includes("magic-touch-int8-v1.task")), true,
    "direct inference smoke above should have loaded the optional model lazily");
  const backgroundBefore = await canvasPixel(16, 16);
  const revisionBefore = Number((await page.locator("#detailRevision").textContent()).trim());
  await page.click("#actionHarnessButton");
  await page.fill("#actionPromptInput", "Удали фон");
  await page.click("#buildActionPlanButton");
  assert.deepEqual(await page.locator("#actionPlanSteps li").allTextContents(),
    ["1. select-object · automatic subject", "2. invert-selection", "3. cut-selection"]);
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

  await page.click("#undoButton");
  await page.waitForFunction(({ revisionAfter }) =>
    Number(document.querySelector("#detailRevision")?.textContent) > revisionAfter &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { revisionAfter }, { timeout: 90_000 });
  assert.deepEqual(await canvasPixel(16, 16), backgroundBefore,
    "one Undo did not restore the pre-plan document");
  assert.equal(await page.locator("#redoButton").isEnabled(), true);

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
  await page.click("#applyObjectSelectionButton");
  await page.waitForFunction(() =>
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await clickCanvas(30 / 256, .5, 902, { shiftKey: true });
  const additive = await waitForObjectPreview();
  assert.match(additive.status, /^Add preview ready/i);
  assert.equal(await page.locator("#selectionModeInput").inputValue(), "replace",
    "Shift-add changed the stored selection mode");
  await page.click("#applyObjectSelectionButton");
  await page.waitForFunction(() =>
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  const leftBeforeCut = await canvasPixel(30, 128);
  const centerBeforeCut = await canvasPixel(128, 128);
  const backgroundBeforeReuse = await canvasPixel(220, 20);
  const modelRequestsBeforeReuse = allRequests.filter((url) =>
    url.includes("magic-touch-int8-v1.task")).length;
  await page.click("#actionHarnessButton");
  await page.fill("#actionPromptInput", "Удали фон");
  await page.click("#buildActionPlanButton");
  assert.deepEqual(await page.locator("#actionPlanSteps li").allTextContents(),
    ["1. invert-selection", "2. cut-selection"],
    "a committed additive selection was not reused by the action plan");
  const revisionBeforeReuse = Number((await page.locator("#detailRevision").textContent()).trim());
  await page.click("#executeActionPlanButton");
  await page.waitForFunction(({ revisionBeforeReuse }) =>
    Number(document.querySelector("#detailRevision")?.textContent) >= revisionBeforeReuse + 2 &&
    [...document.querySelectorAll("#historyList .history-label")]
      .some((item) => item.textContent === "AI edit · Удали фон") &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { revisionBeforeReuse }, { timeout: 90_000 });
  assert.equal(allRequests.filter((url) => url.includes("magic-touch-int8-v1.task")).length,
    modelRequestsBeforeReuse, "existing-selection recipe reran object inference");
  assert.deepEqual(await canvasPixel(30, 128), leftBeforeCut, "Shift-added object was lost");
  assert.deepEqual(await canvasPixel(128, 128), centerBeforeCut, "original selection was replaced");
  assert.ok((await canvasPixel(220, 20))[3] < backgroundBeforeReuse[3],
    "background was not removed around the additive selection");
  await page.click("#undoButton");
  await page.waitForFunction(() =>
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");

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
  assert.deepEqual(remoteRequests, []);
  assert.deepEqual(errors, []);
  console.log(`OBJECT-SELECTION-HARNESS PASS model=${inference.width}x${inference.height} latencyMs=${Math.round(inference.latencyMs)} refinementMs=${Math.round(inference.refinementMs)} boxMs=${Math.round(inference.boxMs)} atomicUndo=1`);
} finally {
  await browser.close();
}
