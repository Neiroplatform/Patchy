import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("usage: node wasm_object_selection_quality_gate.mjs <site-url>");
async function loadPlaywright() {
  try { return await import("playwright"); }
  catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) throw error;
    return createRequire(import.meta.url)(root);
  }
}

const manifest = JSON.parse(await readFile(new URL("../fixtures/object-selection/manifest.json", import.meta.url)));
assert.equal(manifest.cases.length, 40);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true,
  ...(process.env.PATCHY_SOFTWARE_GL === "1" ? { args: ["--use-angle=swiftshader"] } : {}),
  ...(process.env.PATCHY_BROWSER_CHANNEL ? { channel: process.env.PATCHY_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
  extraHTTPHeaders: { "Accept-Encoding": "identity" } });
const page = await context.newPage();
const pageErrors = []; const remoteRequests = [];
const expectedOrigin = new URL(baseUrl).origin;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith("http") && new URL(url).origin !== expectedOrigin) remoteRequests.push(url);
});
await page.exposeFunction("__patchyQualityProgress", ({ completed, id }) => {
  if (completed === 1 || completed % 10 === 0 || completed === manifest.cases.length)
    console.log(JSON.stringify({ status: "PROGRESS", completed, total: manifest.cases.length, id }));
});

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready",
    null, { timeout: 90_000 });
  const result = await page.evaluate(async ({ cases, width, height }) => {
    const module = await import("./object-segmentation.mjs");
    const measurementStartedAt = performance.now();
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= measurementStartedAt) longTasks.push(entry.duration);
      }
    });
    try { observer.observe({ type: "longtask" }); } catch {}

    function subjectPath(target, category, variant) {
      const dx = (variant % 3 - 1) * 5; const dy = (variant % 2) * 4;
      target.beginPath();
      if (category === "person" || category === "hair-fine-edges" || category === "occlusion") {
        target.arc(96 + dx, 50 + dy, 20, 0, Math.PI * 2);
        target.roundRect(70 + dx, 70 + dy, 52, 65, 18);
        target.roundRect(47 + dx, 78 + dy, 28, 15, 7);
        target.roundRect(117 + dx, 78 + dy, 28, 15, 7);
        target.roundRect(72 + dx, 125 + dy, 18, 48, 8);
        target.roundRect(102 + dx, 125 + dy, 18, 48, 8);
      } else if (category === "animal") {
        target.ellipse(100 + dx, 105 + dy, 52, 31, 0, 0, Math.PI * 2);
        target.arc(52 + dx, 91 + dy, 24, 0, Math.PI * 2);
        target.moveTo(35 + dx, 75 + dy); target.lineTo(43 + dx, 52 + dy); target.lineTo(55 + dx, 72 + dy);
        target.moveTo(54 + dx, 70 + dy); target.lineTo(65 + dx, 51 + dy); target.lineTo(72 + dx, 78 + dy);
        target.roundRect(68 + dx, 126 + dy, 15, 38, 6);
        target.roundRect(119 + dx, 126 + dy, 15, 38, 6);
      } else if (category === "vehicle") {
        target.roundRect(31 + dx, 85 + dy, 132, 51, 14);
        target.moveTo(57 + dx, 85 + dy); target.lineTo(79 + dx, 59 + dy);
        target.lineTo(128 + dx, 59 + dy); target.lineTo(150 + dx, 85 + dy); target.closePath();
        target.arc(62 + dx, 137 + dy, 17, 0, Math.PI * 2);
        target.arc(137 + dx, 137 + dy, 17, 0, Math.PI * 2);
      } else if (category === "small-object") {
        target.roundRect(78 + dx, 77 + dy, 36, 38, 10);
        target.arc(96 + dx, 77 + dy, 11, 0, Math.PI * 2);
      } else {
        target.roundRect(66 + dx, 50 + dy, 60, 116, 16);
        target.roundRect(78 + dx, 34 + dy, 36, 24, 8);
        target.arc(96 + dx, 108 + dy, 18, 0, Math.PI * 2);
      }
      return { x: 96 + dx, y: 96 + dy };
    }

    function fixture(testCase) {
      const image = new OffscreenCanvas(width, height); const ctx = image.getContext("2d");
      const expected = new OffscreenCanvas(width, height); const mask = expected.getContext("2d");
      const low = testCase.category === "low-contrast";
      const white = testCase.category === "white-on-white";
      const background = white ? "#f7f7f4" : low ? "#7f8990" : ["#dbeafe", "#fee2e2", "#dcfce7"][testCase.variant % 3];
      const foreground = white ? "#ffffff" : low ? "#89949b" : ["#172554", "#7c2d12", "#14532d"][testCase.variant % 3];
      ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = white ? "#d4d4d0" : "rgba(255,255,255,.28)"; ctx.lineWidth = white ? 2 : 1;
      for (let x = 12; x < width; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 30, height); ctx.stroke(); }
      const point = subjectPath(ctx, testCase.category, testCase.variant);
      ctx.fillStyle = foreground; ctx.fill();
      if (white) ctx.stroke();
      subjectPath(mask, testCase.category, testCase.variant); mask.fillStyle = "#fff"; mask.fill();
      if (testCase.category === "hair-fine-edges") {
        ctx.strokeStyle = foreground; mask.strokeStyle = "#fff"; ctx.lineWidth = 3; mask.lineWidth = 3;
        for (let index = -5; index <= 5; ++index) {
          for (const target of [ctx, mask]) { target.beginPath(); target.moveTo(point.x + index * 3, 37);
            target.quadraticCurveTo(point.x + index * 5, 16 + Math.abs(index) * 2, point.x + index * 7, 5); target.stroke(); }
        }
      }
      if (testCase.category === "animal") {
        ctx.strokeStyle = foreground;
        for (const target of [ctx, mask]) { target.beginPath(); target.lineWidth = 10;
          target.moveTo(147, 100); target.quadraticCurveTo(180, 70, 177, 118); target.stroke(); }
      }
      if (testCase.category === "occlusion") {
        ctx.fillStyle = background; ctx.fillRect(0, 92, width, 21);
        mask.clearRect(0, 92, width, 21);
        // Keep the positive prompt on a visible subject fragment. The generic
        // centre point is intentionally covered by the occluder in this case.
        point.y = 78 + (testCase.variant % 2) * 4;
      }
      return { image, expected: mask.getImageData(0, 0, width, height).data, point };
    }

    function strokesFor(testCase, point) {
      if (testCase.prompt === "box") return [{ isCompleted: true, brushMode: 1,
        point: module.rectanglePromptStroke({ x: point.x - 48, y: point.y - 65 },
          { x: point.x + 48, y: point.y + 70 }, width, height) }];
      const strokes = [{ isCompleted: true, brushMode: 1,
        point: module.clickPromptStroke(point, width, height) }];
      if (testCase.prompt === "points") strokes.push({ isCompleted: true, brushMode: 2,
        point: module.clickPromptStroke({ x: 12, y: 12 }, width, height) });
      return strokes;
    }

    const client = new module.ObjectSegmentationClient();
    const results = []; const heapBefore = performance.memory?.usedJSHeapSize ?? 0;
    for (const [index, testCase] of cases.entries()) {
      const generated = fixture(testCase); const identity = { documentId: testCase.id,
        stateId: String(index + 1), revision: 0, width, height };
      const started = performance.now();
      const ready = await client.setImage(generated.image.transferToImageBitmap(), identity);
      const segmented = await client.segment(strokesFor(testCase, generated.point), identity);
      const refinementStarted = performance.now();
      const refined = await client.segment([...strokesFor(testCase, generated.point),
        { isCompleted: true, brushMode: 2,
          point: module.clickPromptStroke({ x: 8, y: 8 }, width, height) }], identity);
      const refinementMs = performance.now() - refinementStarted;
      let intersection = 0; let union = 0;
      for (let pixel = 0; pixel < width * height; ++pixel) {
        const predicted = refined.confidence[pixel] >= .5;
        const actual = generated.expected[pixel * 4 + 3] >= 128;
        if (predicted && actual) intersection += 1;
        if (predicted || actual) union += 1;
      }
      results.push({ id: testCase.id, category: testCase.category,
        iou: union ? intersection / union : 0, embeddingMs: refinementStarted - started,
        refinementMs, segmentMs: segmented.latencyMs,
        runtimeTier: refined.runtimeTier || segmented.runtimeTier || ready.runtimeTier });
      await globalThis.__patchyQualityProgress({ completed: index + 1, id: testCase.id });
    }
    client.close(); observer.disconnect();
    const heapAfter = performance.memory?.usedJSHeapSize ?? heapBefore;
    return { results, heapBefore, heapAfter, longTasks };
  }, { cases: manifest.cases, width: manifest.width, height: manifest.height });

  const floors = manifest.acceptedFloors;
  const mean = result.results.reduce((sum, value) => sum + value.iou, 0) / result.results.length;
  const successful = result.results.filter((value) => value.iou >= floors.successfulCaseIou).length;
  const categories = new Map();
  for (const value of result.results) {
    const list = categories.get(value.category) || []; list.push(value.iou); categories.set(value.category, list);
  }
  const categoryMeans = Object.fromEntries([...categories].map(([category, values]) =>
    [category, values.reduce((sum, value) => sum + value, 0) / values.length]));
  const embedding = result.results.map((value) => value.embeddingMs).sort((a, b) => a - b);
  const refinement = result.results.map((value) => value.refinementMs).sort((a, b) => a - b);
  const embeddingP95 = embedding[Math.min(embedding.length - 1, Math.ceil(embedding.length * .95) - 1)];
  const refinementP95 = refinement[Math.min(refinement.length - 1, Math.ceil(refinement.length * .95) - 1)];
  const refinementBudget = result.results.every((value) => value.runtimeTier === "gpu") ?
    floors.gpuRefinementP95Ms : floors.wasmRefinementP95Ms;
  const heapGrowth = Math.max(0, result.heapAfter - result.heapBefore);
  const evidence = { modelCases: result.results.length, meanIou: Number(mean.toFixed(4)),
    successful, categoryMeans, embeddingP95Ms: Math.round(embeddingP95),
    refinementP95Ms: Math.round(refinementP95), heapGrowth,
    maxLongTaskMs: Math.round(Math.max(0, ...result.longTasks)),
    runtimeTiers: [...new Set(result.results.map((value) => value.runtimeTier))],
    failedCases: result.results.filter((value) => value.iou < floors.successfulCaseIou)
      .map((value) => ({ id: value.id, iou: Number(value.iou.toFixed(4)) })) };
  console.log(JSON.stringify({ status: "MEASURED", ...evidence }));
  assert.ok(mean >= floors.meanIou, `mean IoU ${mean}`);
  assert.ok(successful / result.results.length >= floors.successfulCaseRatio,
    `successful ratio ${successful}/${result.results.length}`);
  for (const [category, value] of Object.entries(categoryMeans))
    assert.ok(value >= floors.categoryMeanIou, `${category} mean IoU ${value}`);
  assert.ok(embeddingP95 <= floors.embeddingP95Ms, `embedding p95 ${embeddingP95}ms`);
  assert.ok(refinementP95 <= refinementBudget,
    `refinement p95 ${refinementP95}ms exceeds ${refinementBudget}ms tier budget`);
  assert.ok(heapGrowth <= floors.mainHeapGrowthBytes, `main heap growth ${heapGrowth}`);
  assert.ok(Math.max(0, ...result.longTasks) <= floors.mainThreadLongTaskMs,
    `main-thread long task ${Math.max(0, ...result.longTasks)}ms`);
  assert.deepEqual(remoteRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: "PASS", ...evidence }));
} finally {
  await browser.close();
}
