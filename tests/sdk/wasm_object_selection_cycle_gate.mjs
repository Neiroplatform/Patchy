import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("usage: node wasm_object_selection_cycle_gate.mjs <site-url>");

async function loadPlaywright() {
  try { return await import("playwright"); }
  catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) throw error;
    return createRequire(import.meta.url)(root);
  }
}

const manifest = JSON.parse(await readFile(
  new URL("../fixtures/object-selection/manifest.json", import.meta.url)));
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true,
  args: ["--enable-precise-memory-info",
    ...(process.env.PATCHY_SOFTWARE_GL === "1" ? ["--use-angle=swiftshader"] : [])],
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

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready",
    null, { timeout: 90_000 });
  const measured = await page.evaluate(async ({ cycleCount, longEdge }) => {
    const module = await import("./object-segmentation.mjs");
    const width = longEdge; const height = Math.round(longEdge * .75);
    const client = new module.ObjectSegmentationClient();
    const heapSamples = []; const embeddings = []; const refinements = [];
    const runtimeTiers = new Set(); let cancellations = 0;
    const measurementStartedAt = performance.now();
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= measurementStartedAt) longTasks.push(entry.duration);
      }
    });
    try { observer.observe({ type: "longtask" }); } catch {}

    function makeFixture(cycle) {
      const canvas = new OffscreenCanvas(width, height); const ctx = canvas.getContext("2d");
      const hue = (cycle * 37) % 360;
      ctx.fillStyle = `hsl(${hue} 55% 88%)`; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = `hsl(${(hue + 170) % 360} 65% 24%)`;
      ctx.beginPath(); ctx.arc(width * .5, height * .28, height * .12, 0, Math.PI * 2);
      ctx.roundRect(width * .34, height * .39, width * .32, height * .42, height * .08);
      ctx.fill();
      return canvas.transferToImageBitmap();
    }

    for (let cycle = 0; cycle < cycleCount; ++cycle) {
      const identity = { documentId: `cycle-${cycle}`, stateId: String(cycle + 1),
        revision: 0, width, height };
      const started = performance.now();
      const ready = await client.setImage(makeFixture(cycle), identity);
      const embedded = performance.now();
      const positive = { isCompleted: true, brushMode: 1,
        point: module.clickPromptStroke({ x: width * .5, y: height * .5 }, width, height) };
      const negative = { isCompleted: true, brushMode: 2,
        point: module.clickPromptStroke({ x: 18, y: 18 }, width, height) };
      await client.segment([positive], identity);
      const refinementStarted = performance.now();
      const refined = await client.segment([positive, negative], identity);
      refinements.push(performance.now() - refinementStarted);
      embeddings.push(embedded - started);
      runtimeTiers.add(refined.runtimeTier || ready.runtimeTier);

      const pending = client.segment([positive, negative, { isCompleted: true, brushMode: 1,
        point: module.clickPromptStroke({ x: width * .54, y: height * .54 }, width, height) }], identity);
      client.cancel();
      try { await pending; } catch (error) {
        if (error.name !== "AbortError") throw error;
        cancellations += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      heapSamples.push(performance.memory?.usedJSHeapSize ?? 0);
    }
    client.close(); observer.disconnect();
    return { heapSamples, embeddings, refinements, cancellations,
      runtimeTiers: [...runtimeTiers], longTasks };
  }, { cycleCount: manifest.cycleCount, longEdge: manifest.referenceLongEdge });

  const percentile95 = (values) => [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * .95) - 1)];
  const nonzeroHeap = measured.heapSamples.filter(Boolean);
  const heapPlateau = nonzeroHeap.length ? Math.max(...nonzeroHeap) - Math.min(...nonzeroHeap) : 0;
  const evidence = { cycles: manifest.cycleCount, cancellations: measured.cancellations,
    referenceLongEdge: manifest.referenceLongEdge,
    embeddingP95Ms: Math.round(percentile95(measured.embeddings)),
    refinementP95Ms: Math.round(percentile95(measured.refinements)),
    mainHeapPlateauBytes: heapPlateau,
    maxLongTaskMs: Math.round(Math.max(0, ...measured.longTasks)),
    runtimeTiers: measured.runtimeTiers };
  const refinementBudget = measured.runtimeTiers.every((value) => value === "gpu") ?
    manifest.acceptedFloors.gpuRefinementP95Ms : manifest.acceptedFloors.wasmRefinementP95Ms;
  console.log(JSON.stringify({ status: "MEASURED", ...evidence }));
  assert.equal(measured.cancellations, manifest.cycleCount);
  assert.ok(evidence.embeddingP95Ms <= manifest.acceptedFloors.embeddingP95Ms,
    `embedding p95 ${evidence.embeddingP95Ms}ms`);
  assert.ok(evidence.refinementP95Ms <= refinementBudget,
    `refinement p95 ${evidence.refinementP95Ms}ms exceeds ${refinementBudget}ms tier budget`);
  assert.ok(heapPlateau <= manifest.acceptedFloors.mainHeapGrowthBytes,
    `main heap plateau ${heapPlateau}`);
  assert.ok(evidence.maxLongTaskMs <= manifest.acceptedFloors.mainThreadLongTaskMs,
    `main-thread long task ${evidence.maxLongTaskMs}ms`);
  assert.deepEqual(remoteRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: "PASS", ...evidence }));
} finally {
  await browser.close();
}
