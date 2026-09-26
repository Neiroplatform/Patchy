#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import {
  assessApplicationMemory,
  BROWSER_PERFORMANCE_THRESHOLDS,
  parseDisplayedBytes,
  percentile,
} from "./browser-performance-policy.mjs";
import { verifyRelease } from "./build-self-hosted-release.mjs";

const releaseArgument = process.argv[2];
const browserName = process.argv[3] ?? "chromium";
if (!releaseArgument || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node verify-self-hosted-release-browser.mjs <release-dir> [chromium|firefox|webkit]");
  process.exit(2);
}

function environmentInteger(name, fallback, { minimum = 0 } = {}) {
  const source = process.env[name];
  if (source === undefined || source === "") return fallback;
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

const minimumIterations = environmentInteger("PATCHY_RELEASE_SOAK_ITERATIONS", 1, { minimum: 1 });
const minimumDurationMs = environmentInteger("PATCHY_RELEASE_SOAK_DURATION_MS", 0);
const summaryPath = process.env.PATCHY_RELEASE_SOAK_SUMMARY;
const performanceDurationMs = environmentInteger("PATCHY_RELEASE_PERFORMANCE_DURATION_MS", 0);
const performanceSummaryPath = process.env.PATCHY_RELEASE_PERFORMANCE_SUMMARY;
const performancePanZoomSamples = environmentInteger("PATCHY_RELEASE_PERFORMANCE_PAN_ZOOM_SAMPLES", 120, { minimum: 20 });
const performanceBrushSamples = environmentInteger("PATCHY_RELEASE_PERFORMANCE_BRUSH_SAMPLES", 12, { minimum: 5 });
const requireFullPerformanceGate = environmentInteger("PATCHY_RELEASE_PERFORMANCE_REQUIRE_FULL_GATE", 0, { minimum: 0 });
if (![0, 1].includes(requireFullPerformanceGate)) {
  throw new Error("PATCHY_RELEASE_PERFORMANCE_REQUIRE_FULL_GATE must be 0 or 1");
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) {
      throw new Error("Install playwright or set PATCHY_PLAYWRIGHT_ROOT to its package directory", { cause: error });
    }
    return createRequire(import.meta.url)(root);
  }
}

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
});

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

async function dropSvg(page, { name, width, height, fill }) {
  const contents = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`;
  await page.evaluate(({ fileName, svg }) => {
    const file = new File([svg], fileName, { type: "image/svg+xml" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    globalThis.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, { fileName: name, svg: contents });
  await page.waitForFunction(({ expectedWidth, expectedHeight }) =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 1 &&
    document.querySelector("#documentCanvas")?.width === expectedWidth &&
    document.querySelector("#documentCanvas")?.height === expectedHeight &&
    Number(document.querySelector("#layerCount")?.textContent) === 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { expectedWidth: width, expectedHeight: height }, { timeout: 90_000 });
}

async function closeActiveDocument(page) {
  await page.click('#documentTabs .document-tab[data-active="true"] button[aria-hidden="true"]');
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 0 &&
    document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  null, { timeout: 90_000 });
}

async function createStarterPreset(page, id, width, height) {
  await page.click("#emptyNewButton");
  await page.click(`[data-starter-preset="${id}"]`);
  await page.waitForFunction(({ expectedWidth, expectedHeight }) =>
    document.querySelector("#detailCanvas")?.textContent === `${expectedWidth} × ${expectedHeight}` &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { expectedWidth: width, expectedHeight: height }, { timeout: 90_000 });
  await closeActiveDocument(page);
}

async function createCustomStarter(page, width, height, format, { keyboard = false } = {}) {
  await page.click("#emptyNewButton");
  await page.fill("#starterWidthInput", String(width));
  await page.fill("#starterHeightInput", String(height));
  if (keyboard) await page.locator("#starterHeightInput").press("Enter");
  else await page.click("#starterCustomCreateButton");
  await page.waitForFunction(({ expectedWidth, expectedHeight, expectedFormat }) =>
    document.querySelector("#detailCanvas")?.textContent === `${expectedWidth} × ${expectedHeight}` &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector("#saveFormatSelect")?.value === expectedFormat &&
    ["confirmed", "error"].includes(document.querySelector("#recoveryLabel")?.dataset.state) &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { expectedWidth: width, expectedHeight: height, expectedFormat: format }, { timeout: 90_000 });
  if (keyboard) {
    assert.equal(await page.evaluate(() => document.activeElement?.id), "canvasViewport",
      "keyboard starter creation did not move focus to the document canvas");
  }
  return page.locator("#recoveryLabel").getAttribute("data-state");
}

async function verifyBetaGuide(page) {
  const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };
  assert.equal((await page.locator("#helpButton").textContent()).trim(), "Getting started");
  console.log(`BETA-GUIDE-PHASE browser=${browserName} phase=quick-actions`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.click("#emptyNewButton");
  const starterLayout = await page.evaluate(() => {
    const dialog = document.querySelector("#starterDialog");
    return {
      dialogWidth: dialog.getBoundingClientRect().width,
      presetColumns: getComputedStyle(document.querySelector(".starter-presets"))
        .gridTemplateColumns.split(" ").length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      transitionMs: Number.parseFloat(getComputedStyle(dialog).transitionDuration),
      targetHeights: [...dialog.querySelectorAll("button, input")]
        .map((button) => button.getBoundingClientRect().height),
    };
  });
  assert.ok(starterLayout.dialogWidth <= 390, "Starter dialog overflows the mobile viewport");
  assert.equal(starterLayout.presetColumns, 1);
  assert.equal(starterLayout.horizontalOverflow, false);
  assert.ok(starterLayout.transitionMs <= .001);
  assert.equal(starterLayout.targetHeights.every((height) => height >= 24), true,
    "Starter controls violate the WCAG 2.2 minimum target size");
  await page.click("#starterCloseButton");
  await page.setViewportSize(originalViewport);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.focus("#emptyNewButton");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#starterDialog[open]");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#starterDialog[open]", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "emptyNewButton",
    "closing the packaged starter did not return focus to its invoker");
  await page.click("#emptyNewButton");
  await page.fill("#starterWidthInput", "0");
  await page.click("#starterCustomCreateButton");
  assert.equal(await page.isVisible("#starterError"), true,
    "packaged starter accepted invalid dimensions");
  assert.equal((await page.locator("#detailRevision").textContent()).trim(), "-");
  await page.click('[data-starter-preset="blank"]');
  await page.waitForFunction(() => document.querySelector("#detailCanvas")?.textContent === "1600 × 1000" &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  await closeActiveDocument(page);
  await createStarterPreset(page, "social", 1080, 1080);
  await createStarterPreset(page, "presentation", 1920, 1080);
  await createStarterPreset(page, "print-a4", 2480, 3508);
  const starterRecoveryState = await createCustomStarter(page, 640, 480, "psd", { keyboard: true });
  await closeActiveDocument(page);
  assert.equal(await createCustomStarter(page, 30000, 1, "psd"), starterRecoveryState);
  await closeActiveDocument(page);
  assert.equal(await createCustomStarter(page, 30001, 1, "psb"), starterRecoveryState);
  const [psbDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    page.click("#saveAsButton"),
  ]);
  const psbBytes = await readFile(await psbDownload.path());
  assert.equal(psbDownload.suggestedFilename().endsWith(".psb"), true);
  assert.equal(psbBytes.subarray(0, 4).toString("ascii"), "8BPS");
  assert.equal(psbBytes.readUInt16BE(4), 2, "large starter did not encode PSB version 2");
  await psbDownload.delete();
  await closeActiveDocument(page);

  await page.click("#recoveryButton");
  if (starterRecoveryState === "confirmed") {
    const psbRecovery = page.locator(".recovery-row", { hasText: "Untitled.psb" });
    await psbRecovery.getByRole("button", { name: "Recover" }).click();
    await page.waitForFunction(() =>
      document.querySelector("#detailCanvas")?.textContent === "30001 × 1" &&
      document.querySelector("#saveFormatSelect")?.value === "psb" &&
      document.querySelector("#recoveryLabel")?.dataset.state === "confirmed" &&
      document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
    null, { timeout: 90_000 });
    await closeActiveDocument(page);
  } else {
    assert.match(await page.locator("#recoverySummary").textContent(), /unavailable/i);
    await page.click('#recoveryDialog button[value="cancel"]');
  }

  await page.click("#helpButton");
  await page.waitForSelector("#helpDialog[open]");
  assert.equal((await page.locator("#helpDialogTitle").textContent()).trim(), "Start editing locally");
  assert.match(await page.locator("#helpDialog").textContent(), /1,000-file corpus acceptance/);
  assert.equal(await page.locator('#helpDialog a[href="./capabilities.html"]').getAttribute("target"), "_blank");

  await page.evaluate(() => {
    globalThis.__patchyOpenInputClicks = 0;
    document.querySelector("#fileInput").addEventListener("click", () => {
      globalThis.__patchyOpenInputClicks++;
    });
  });
  await page.click("#helpOpenButton");
  await page.waitForFunction(() => globalThis.__patchyOpenInputClicks === 1);

  await page.click("#helpButton");
  await page.click("#helpRecoveryButton");
  await page.waitForSelector("#recoveryDialog[open]");
  await page.click('#recoveryDialog button[value="cancel"]');
  await page.waitForSelector("#recoveryDialog[open]", { state: "hidden" });

  await page.click("#helpButton");
  await page.click("#helpNewButton");
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 1 &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  null, { timeout: 90_000 });
  await closeActiveDocument(page);

  await page.click("#helpButton");
  await page.click("#completeGuideButton");
  assert.equal((await page.locator("#helpButton").textContent()).trim(), "Help");
  assert.equal(await page.evaluate(() => localStorage.getItem("patchy.beta-guide.v1")), "complete");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  assert.equal((await page.locator("#helpButton").textContent()).trim(), "Help");
  console.log(`BETA-GUIDE-PHASE browser=${browserName} phase=persistence-reload`);

  await page.selectOption("#localeSelect", "ru");
  await page.waitForFunction(() => document.querySelector("#helpButton")?.textContent.trim() === "Помощь");
  await page.click("#emptyNewButton");
  assert.equal((await page.locator("#starterDialogTitle").textContent()).trim(), "Создать локальный документ");
  await page.click("#starterCloseButton");
  await page.click("#helpButton");
  assert.equal((await page.locator("#helpDialogTitle").textContent()).trim(), "Начните редактировать локально");
  await page.click('#helpDialog button[value="cancel"]');
  await page.waitForSelector("#helpDialog[open]", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "helpButton",
    "closing Help did not return focus to its invoker");
  console.log(`BETA-GUIDE-PHASE browser=${browserName} phase=localization-focus`);

  await page.click("#newButton");
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 1 &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  null, { timeout: 90_000 });

  await page.locator("#layerNameInput").dispatchEvent("keydown", { key: "?" });
  assert.equal(await page.isVisible("#helpDialog[open]"), false,
    "the global Help shortcut captured an editable field");
  await closeActiveDocument(page);
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", {
    key: "?", bubbles: true, cancelable: true,
  })));
  await page.waitForSelector("#helpDialog[open]");

  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector("#helpDialog");
    const rect = dialog.getBoundingClientRect();
    return {
      dialogWidth: rect.width,
      shortcutColumns: getComputedStyle(document.querySelector(".shortcut-grid")).gridTemplateColumns.split(" ").length,
      helpColumns: getComputedStyle(document.querySelector(".help-columns")).gridTemplateColumns.split(" ").length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.ok(layout.dialogWidth <= 390, "Help dialog overflows the mobile viewport");
  assert.equal(layout.shortcutColumns, 1);
  assert.equal(layout.helpColumns, 1);
  assert.equal(layout.horizontalOverflow, false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator("#helpDialog").evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).transitionDuration) <= .001), true);
  await page.click('#helpDialog button[value="cancel"]');
  await page.setViewportSize(originalViewport);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.selectOption("#localeSelect", "en");
  console.log(`BETA-GUIDE-PHASE browser=${browserName} phase=keyboard-reflow`);
}

async function waitForEditorIdle(page) {
  await page.waitForFunction(() =>
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  null, { timeout: 90_000 });
}

async function configureBrush(page, color, size) {
  await page.click("#brushToolButton");
  await page.evaluate(({ nextColor, nextSize }) => {
    const colorInput = document.querySelector("#brushColorInput");
    const sizeInput = document.querySelector("#brushSizeInput");
    colorInput.value = nextColor;
    colorInput.dispatchEvent(new Event("input", { bubbles: true }));
    sizeInput.value = String(nextSize);
    sizeInput.dispatchEvent(new Event("input", { bubbles: true }));
  }, { nextColor: color, nextSize: size });
}

async function brushPoint(page, index, total, { measurePreview = false, commit = true } = {}) {
  await page.locator("#documentCanvas").evaluate((element) =>
    element.scrollIntoView({ block: "nearest", inline: "nearest" }));
  const bounds = await page.locator("#documentCanvas").boundingBox();
  const viewportBounds = await page.locator("#canvasViewport").boundingBox();
  assert.ok(bounds?.width > 0 && bounds?.height > 0, "document canvas has no visible bounds");
  assert.ok(viewportBounds?.width > 0 && viewportBounds?.height > 0, "canvas viewport has no visible bounds");
  const intersectionWidth = Math.min(bounds.x + bounds.width, viewportBounds.x + viewportBounds.width) -
    Math.max(bounds.x, viewportBounds.x);
  const intersectionHeight = Math.min(bounds.y + bounds.height, viewportBounds.y + viewportBounds.height) -
    Math.max(bounds.y, viewportBounds.y);
  const inset = Math.max(2, Math.min(24, intersectionWidth / 8, intersectionHeight / 8));
  const visible = {
    left: Math.max(bounds.x, viewportBounds.x) + inset,
    top: Math.max(bounds.y, viewportBounds.y) + inset,
    right: Math.min(bounds.x + bounds.width, viewportBounds.x + viewportBounds.width) - inset,
    bottom: Math.min(bounds.y + bounds.height, viewportBounds.y + viewportBounds.height) - inset,
  };
  assert.ok(visible.right > visible.left && visible.bottom > visible.top,
    "document canvas has no safely interactive visible area");
  const columns = Math.max(3, Math.ceil(Math.sqrt(total)));
  const rows = Math.ceil(total / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const clientX = visible.left + (visible.right - visible.left) * ((column + 1) / (columns + 1));
  const clientY = visible.top + (visible.bottom - visible.top) * ((row + 1) / (rows + 1));
  if (measurePreview) {
    await page.evaluate(({ x, y }) => {
      const target = document.querySelector("#gestureCanvas");
      globalThis.__patchyBrushPreviewProbe = new Promise((resolveProbe, rejectProbe) => {
        document.querySelector("#documentCanvas").addEventListener("pointerdown", (event) => {
          globalThis.__patchyBrushPointerId = event.pointerId;
          const bounds = target.getBoundingClientRect();
          const pixelX = Math.max(0, Math.min(target.width - 1,
            Math.floor((x - bounds.left) * target.width / bounds.width)));
          const pixelY = Math.max(0, Math.min(target.height - 1,
            Math.floor((y - bounds.top) * target.height / bounds.height)));
          const context = target.getContext("2d", { alpha: true });
          const before = [...context.getImageData(pixelX, pixelY, 1, 1).data];
          const originalFill = context.fill;
          const started = performance.now();
          let settled = false;
          const restore = () => {
            if (context.fill === instrumentedFill) context.fill = originalFill;
          };
          const timeout = setTimeout(() => {
            if (!settled) {
              restore();
              rejectProbe(new Error("brush preview did not update the visible gesture canvas"));
            }
          }, 15_000);
          function instrumentedFill(...args) {
            const result = Reflect.apply(originalFill, this, args);
            const elapsedMs = performance.now() - started;
            const after = context.getImageData(pixelX, pixelY, 1, 1).data;
            if (before.some((value, channel) => value !== after[channel])) {
              settled = true;
              clearTimeout(timeout);
              restore();
              resolveProbe(elapsedMs);
            }
            return result;
          }
          context.fill = instrumentedFill;
        }, { capture: true, once: true });
      });
    }, { x: clientX, y: clientY });
  }
  await page.mouse.move(clientX, clientY);
  await page.mouse.down();
  const previewMs = measurePreview
    ? await page.evaluate(() => globalThis.__patchyBrushPreviewProbe)
    : null;
  const revision = commit ? await page.locator("#detailRevision").textContent() : null;
  if (commit) {
    await page.mouse.move(clientX + Math.min(4, bounds.width / 100), clientY + Math.min(4, bounds.height / 100));
  } else {
    await page.evaluate(() => {
      document.querySelector("#documentCanvas").dispatchEvent(new PointerEvent("pointercancel", {
        bubbles: true,
        pointerId: globalThis.__patchyBrushPointerId,
        pointerType: "mouse",
      }));
    });
  }
  await page.mouse.up();
  if (commit) {
    await page.waitForFunction((previousRevision) =>
      document.querySelector("#detailRevision")?.textContent !== previousRevision,
    revision, { timeout: 30_000 });
  }
  await waitForEditorIdle(page);
  return previewMs;
}

async function applicationMemorySample(page, startedAt) {
  const label = await page.locator("#memoryLabel").textContent();
  const heapBytes = await page.evaluate(() => Number(performance.memory?.usedJSHeapSize ?? 0));
  return {
    elapsedMs: Date.now() - startedAt,
    applicationBytes: parseDisplayedBytes(label),
    heapBytes: heapBytes || null,
  };
}

async function runPerformanceAudit(page, browserLabel, manifest) {
  await dropSvg(page, {
    name: "performance-4k.svg",
    width: 3840,
    height: 2160,
    fill: "#f0f0f0",
  });
  await page.selectOption("#memoryBudgetSelect", "128");
  await waitForEditorIdle(page);

  const panZoom = await page.evaluate(async ({ sampleCount }) => {
    const diagnostics = globalThis.__patchyViewportDiagnostics;
    diagnostics.samples.length = 0;
    const rendersBefore = diagnostics.renderRequests;
    const viewport = document.querySelector("#canvasViewport");
    for (let index = 0; index < sampleCount; index++) {
      if (index % 4 === 0) document.querySelector("#zoomActualButton").click();
      else if (index % 4 === 1) document.querySelector("#zoomInButton").click();
      else if (index % 4 === 2) {
        viewport.scrollTo({ left: (index * 37) % Math.max(1, viewport.scrollWidth),
          top: (index * 23) % Math.max(1, viewport.scrollHeight) });
      } else document.querySelector("#zoomOutButton").click();
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    }
    return {
      samples: [...diagnostics.samples],
      rendersBefore,
      rendersAfter: diagnostics.renderRequests,
    };
  }, { sampleCount: performancePanZoomSamples });
  assert.ok(panZoom.samples.length >= performancePanZoomSamples,
    `expected ${performancePanZoomSamples} viewport samples, received ${panZoom.samples.length}`);
  const panZoomP95Ms = percentile(panZoom.samples, 0.95);
  assert.ok(panZoomP95Ms <= BROWSER_PERFORMANCE_THRESHOLDS.panZoomP95Ms,
    `pan/zoom p95 ${panZoomP95Ms.toFixed(2)} ms exceeds ${BROWSER_PERFORMANCE_THRESHOLDS.panZoomP95Ms} ms`);
  assert.equal(panZoom.rendersAfter, panZoom.rendersBefore,
    "pan/zoom requested an authoritative document recomposite");

  const brushPreviewSamples = [];
  await configureBrush(page, "#111111", 48);
  for (let index = 0; index < performanceBrushSamples; index++) {
    await configureBrush(page, index % 2 ? "#e11d48" : "#111111", 48);
    brushPreviewSamples.push(await brushPoint(page, index, performanceBrushSamples,
      { measurePreview: true, commit: true }));
  }
  const brushPreviewP95Ms = percentile(brushPreviewSamples, 0.95);
  console.log(`PERFORMANCE browser=${browserLabel} brushPreviewSamplesMs=${JSON.stringify(brushPreviewSamples)} p95Ms=${brushPreviewP95Ms.toFixed(2)}`);
  assert.ok(brushPreviewP95Ms <= BROWSER_PERFORMANCE_THRESHOLDS.brushPreviewP95Ms,
    `brush preview p95 ${brushPreviewP95Ms.toFixed(2)} ms exceeds ${BROWSER_PERFORMANCE_THRESHOLDS.brushPreviewP95Ms} ms`);
  await closeActiveDocument(page);

  await dropSvg(page, {
    name: "performance-memory.svg",
    width: 512,
    height: 512,
    fill: "#dbeafe",
  });
  await page.selectOption("#memoryBudgetSelect", "128");
  await waitForEditorIdle(page);
  await configureBrush(page, "#111111", 24);
  const stressStartedAt = Date.now();
  let nextSampleAt = stressStartedAt + 60_000;
  let stressIterations = 0;
  const applicationMemorySamples = [await applicationMemorySample(page, stressStartedAt)];
  const stressColors = ["#111111", "#2563eb", "#e11d48"];
  do {
    await configureBrush(page, stressColors[stressIterations % stressColors.length], 24);
    await brushPoint(page, stressIterations % 64, 64);
    stressIterations++;
    const observedAt = Date.now();
    if (observedAt >= nextSampleAt) {
      applicationMemorySamples.push(await applicationMemorySample(page, stressStartedAt));
      console.log(`PERFORMANCE browser=${browserLabel} stressIterations=${stressIterations} elapsedMs=${observedAt - stressStartedAt} applicationBytes=${applicationMemorySamples.at(-1).applicationBytes}`);
      while (nextSampleAt <= observedAt) nextSampleAt += 60_000;
    }
  } while (Date.now() - stressStartedAt < performanceDurationMs);
  applicationMemorySamples.push(await applicationMemorySample(page, stressStartedAt));
  const stressElapsedMs = Date.now() - stressStartedAt;
  const memory = assessApplicationMemory(applicationMemorySamples);
  assert.ok(memory.maximumBytes <= memory.ceilingBytes,
    `application-owned memory ${memory.maximumBytes} exceeds ${memory.ceilingBytes}`);
  if (stressElapsedMs >= BROWSER_PERFORMANCE_THRESHOLDS.stressDurationMs) {
    assert.equal(memory.bounded, true, "30-minute stress did not reach a bounded retained-memory plateau");
  }
  const memoryGateQualified = stressElapsedMs >= BROWSER_PERFORMANCE_THRESHOLDS.stressDurationMs && memory.bounded;
  if (requireFullPerformanceGate) {
    assert.equal(memoryGateQualified, true,
      `full performance gate requires ${BROWSER_PERFORMANCE_THRESHOLDS.stressDurationMs} ms and bounded memory`);
  }
  await closeActiveDocument(page);
  return {
    schema: "patchy.browser-performance-audit/v1",
    browser: browserLabel,
    browserChannel: process.env.PATCHY_BROWSER_CHANNEL ?? null,
    releaseId: manifest.releaseId,
    sourceSha: manifest.sourceSha,
    canvas: { width: 3840, height: 2160 },
    panZoom: {
      samples: panZoom.samples.length,
      p95Ms: panZoomP95Ms,
      thresholdMs: BROWSER_PERFORMANCE_THRESHOLDS.panZoomP95Ms,
      renderRequests: panZoom.rendersAfter - panZoom.rendersBefore,
    },
    brushPreview: {
      samples: brushPreviewSamples.length,
      sampleValuesMs: brushPreviewSamples,
      measurement: "pointer-handler-to-overlay-fill",
      p95Ms: brushPreviewP95Ms,
      thresholdMs: BROWSER_PERFORMANCE_THRESHOLDS.brushPreviewP95Ms,
    },
    memoryStress: {
      elapsedMs: stressElapsedMs,
      iterations: stressIterations,
      samples: applicationMemorySamples,
      ...memory,
      qualified: memoryGateQualified,
    },
  };
}

const releaseRoot = resolve(releaseArgument);
await verifyRelease(releaseRoot);
const manifest = JSON.parse(await readFile(join(releaseRoot, "release-manifest.json"), "utf8"));
const releasePolicy = JSON.parse(await readFile(join(releaseRoot, manifest.policy), "utf8"));
const safariPolicy = releasePolicy.support?.limited?.find((entry) => entry.browser === "Safari");
assert.equal(safariPolicy?.tier, "limited", "release policy must publish Safari's official limited tier");
assert.match(safariPolicy.promotionGate, /two-hour Safari memory soak/i);
const declared = new Set(["release-manifest.json", ...manifest.files.map((entry) => entry.path)]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!pathname) pathname = manifest.entrypoint;
    const normalized = normalize(pathname);
    const posixPath = normalized.split(sep).join("/");
    const absolute = resolve(releaseRoot, normalized);
    const fromRoot = relative(releaseRoot, absolute);
    if (!declared.has(posixPath) || fromRoot.startsWith(`..${sep}`) || fromRoot === "..") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    let body;
    let contentEncoding;
    const acceptEncoding = String(request.headers["accept-encoding"] ?? "");
    for (const [token, suffix] of [["br", ".br"], ["gzip", ".gz"]]) {
      if (body === undefined && acceptEncoding.includes(token) && declared.has(`${posixPath}${suffix}`)) {
        body = await readFile(`${absolute}${suffix}`);
        contentEncoding = token;
      }
    }
    body ??= await readFile(absolute);
    const immutable = /\.(?:css|data|ico|js|mjs|png|svg|wasm)$/i.test(posixPath);
    response.writeHead(200, {
      ...manifest.securityHeaders,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "Content-Type": MIME_TYPES[extname(posixPath).toLowerCase()] ?? "application/octet-stream",
      ...(contentEncoding ? { "Content-Encoding": contentEncoding, Vary: "Accept-Encoding" } : {}),
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error.message);
  }
});

const address = await listen(server);
const baseUrl = `http://127.0.0.1:${address.port}/`;
const baseOrigin = new URL(baseUrl).origin;
let browser;
let primaryFailure = null;
try {
  const playwright = await loadPlaywright();
  const browserType = playwright[browserName];
  const launchOptions = { headless: true };
  if (browserName === "chromium" && process.env.PATCHY_BROWSER_CHANNEL) {
    launchOptions.channel = process.env.PATCHY_BROWSER_CHANNEL;
  }
  browser = await browserType.launch(launchOptions);
} catch (error) {
  await close(server);
  throw error;
}

try {
  const page = await browser.newPage();
  const pageErrors = [];
  const failedRequests = [];
  const externalRequests = [];
  const forbiddenRequests = [];
  const pageCrashes = [];
  let disconnected = false;
  let acceptedDialogs = 0;
  browser.on("disconnected", () => { disconnected = true; });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("crash", () => pageCrashes.push("page crashed"));
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? "failed"}`));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== baseOrigin) externalRequests.push(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      forbiddenRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on("dialog", async (dialog) => {
    acceptedDialogs++;
    await dialog.accept();
  });
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "showOpenFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "showSaveFilePicker", { configurable: true, value: undefined });
  });

  const capabilityResponse = await page.goto(`${baseUrl}capabilities.html`, { waitUntil: "domcontentloaded" });
  assert.equal(capabilityResponse.status(), 200);
  assert.equal(capabilityResponse.headers()["content-security-policy"], manifest.securityHeaders["Content-Security-Policy"]);
  assert.equal(capabilityResponse.headers()["cache-control"], "no-cache");
  await page.waitForFunction(() => document.querySelector(".result-card")?.dataset.tier);
  const capabilityTier = await page.locator(".result-card").getAttribute("data-tier");
  assert.notEqual(capabilityTier, "blocked", "release runtime is missing a required capability");
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), true);

  const assetResponse = await page.request.get(`${baseUrl}editor.mjs`);
  assert.equal(assetResponse.status(), 200);
  assert.equal(assetResponse.headers()["cache-control"], "public, max-age=31536000, immutable");
  assert.ok(["br", "gzip"].includes(assetResponse.headers()["content-encoding"]), "precompressed asset was not served");

  const editorResponse = await page.goto(`${baseUrl}${manifest.entrypoint}`, { waitUntil: "domcontentloaded" });
  assert.equal(editorResponse.status(), 200);
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready", null, { timeout: 90_000 });
  assert.equal(await page.locator("#systemCheckLink").getAttribute("href"), "./capabilities.html");
  const browserManifest = await page.evaluate(async () => (await fetch("./release-manifest.json")).json());
  assert.equal(browserManifest.releaseId, manifest.releaseId);
  assert.equal(browserManifest.sourceSha, manifest.sourceSha);

  const betaGuideDialogsBefore = acceptedDialogs;
  await verifyBetaGuide(page);
  const betaGuideAcceptedDialogs = acceptedDialogs - betaGuideDialogsBefore;
  assert.equal(betaGuideAcceptedDialogs, 0,
    "beta guide must not invent confirmations for unchanged documents");
  console.log(`BETA-GUIDE browser=${browserName} local-first=1 starter-presets=4 quick-actions=3 help-shortcut=1 responsive=390x844`);

  const performanceDialogsBefore = acceptedDialogs;
  const performance = performanceDurationMs > 0
    ? await runPerformanceAudit(page, browserName, manifest)
    : null;
  const performanceAcceptedDialogs = acceptedDialogs - performanceDialogsBefore;
  if (performance) {
    assert.equal(performanceAcceptedDialogs, 2,
      "performance audit must explicitly confirm both dirty local document closes");
    if (performanceSummaryPath) {
      await writeFile(performanceSummaryPath, `${JSON.stringify(performance, null, 2)}\n`);
    }
  }

  const startedAt = Date.now();
  let nextHeartbeatAt = startedAt + 60_000;
  let iterations = 0;
  let downloadedBytes = 0;
  let maximumHeapBytes = 0;
  const memorySamples = [];
  do {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#${(iterations + 1).toString(16).padStart(6, "0").slice(-6)}"/><text x="2" y="16" font-size="8">${iterations + 1}</text></svg>`;
    await page.evaluate(({ name, contents }) => {
      const file = new File([contents], name, { type: "image/svg+xml" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      globalThis.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
    }, { name: `local-first-audit-${iterations + 1}.svg`, contents: svg });
    await page.waitForFunction(() =>
      document.querySelectorAll('#documentTabs [role="tab"]').length === 1 &&
      Number(document.querySelector("#layerCount")?.textContent) === 1 &&
      document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true" &&
      document.querySelector("#saveAsButton")?.disabled === false,
    null, { timeout: 90_000 });

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 90_000 }),
      page.click("#saveAsButton"),
    ]);
    const downloadPath = await download.path();
    assert.ok(download.suggestedFilename().endsWith(".psd"), "local save did not produce a PSD filename");
    const downloadStatus = await stat(downloadPath);
    assert.ok(downloadStatus.size > 0, "local save produced an empty PSD");
    assert.equal((await readFile(downloadPath)).subarray(0, 4).toString("ascii"), "8BPS",
      "local save did not produce a layered Photoshop document");
    downloadedBytes += downloadStatus.size;
    await download.delete();
    await page.waitForFunction(() =>
      document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");

    await page.click('#documentTabs .document-tab[data-active="true"] button[aria-hidden="true"]');
    await page.waitForFunction(() =>
      document.querySelectorAll('#documentTabs [role="tab"]').length === 0 &&
      document.querySelector(".editor-shell")?.dataset.state === "ready" &&
      document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
    null, { timeout: 90_000 });
    const heapBytes = await page.evaluate(() => Number(performance.memory?.usedJSHeapSize ?? 0));
    maximumHeapBytes = Math.max(maximumHeapBytes, heapBytes);
    iterations++;
    const observedAt = Date.now();
    if (memorySamples.length === 0 || observedAt >= nextHeartbeatAt) {
      memorySamples.push({ elapsedMs: observedAt - startedAt, heapBytes: heapBytes || null });
      if (observedAt >= nextHeartbeatAt) {
        console.log(`SOAK browser=${browserName} iterations=${iterations} elapsedMs=${observedAt - startedAt} heapBytes=${heapBytes || "unavailable"}`);
        while (nextHeartbeatAt <= observedAt) nextHeartbeatAt += 60_000;
      }
    }
  } while (iterations < minimumIterations || Date.now() - startedAt < minimumDurationMs);

  const finishedAt = Date.now();
  if (memorySamples.at(-1)?.elapsedMs !== finishedAt - startedAt) {
    const heapBytes = await page.evaluate(() => Number(performance.memory?.usedJSHeapSize ?? 0));
    maximumHeapBytes = Math.max(maximumHeapBytes, heapBytes);
    memorySamples.push({ elapsedMs: finishedAt - startedAt, heapBytes: heapBytes || null });
  }

  const summary = {
    schema: "patchy.self-hosted-browser-audit/v1",
    browser: browserName,
    browserChannel: process.env.PATCHY_BROWSER_CHANNEL ?? null,
    releaseId: manifest.releaseId,
    sourceSha: manifest.sourceSha,
    capabilityTier,
    iterations,
    elapsedMs: finishedAt - startedAt,
    downloadedBytes,
    maximumHeapBytes: maximumHeapBytes || null,
    memorySamples,
    acceptedDialogs,
    pageErrors,
    failedRequests,
    externalRequests,
    forbiddenRequests,
    pageCrashes,
    disconnected,
  };
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(forbiddenRequests, []);
  assert.deepEqual(pageCrashes, []);
  assert.equal(disconnected, false);
  assert.equal(acceptedDialogs - performanceAcceptedDialogs - betaGuideAcceptedDialogs, iterations,
    "each dirty local document must require explicit close confirmation");
  if (summaryPath) await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`PASS browser=${browserName} release=${manifest.releaseId} capability=${capabilityTier} files=${manifest.files.length} iterations=${iterations} elapsedMs=${summary.elapsedMs} downloadedBytes=${downloadedBytes}`);
} catch (error) {
  primaryFailure = error;
  console.error(`BROWSER-VERIFY-ERROR browser=${browserName} ${error?.stack || error}`);
  throw error;
} finally {
  const teardownWatchdog = setTimeout(() => {
    console.error(`BROWSER-VERIFY-TEARDOWN-TIMEOUT browser=${browserName} primaryFailure=${Boolean(primaryFailure)}`);
    process.exit(1);
  }, 15_000);
  try {
    await close(server);
    await browser.close();
  } finally {
    clearTimeout(teardownWatchdog);
  }
}
