import assert from "node:assert/strict";
import { createRequire } from "node:module";

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("usage: node wasm_object_selection_detail_recovery_gate.mjs <site-url>");
async function loadPlaywright() {
  try { return await import("playwright"); }
  catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) throw error;
    return createRequire(import.meta.url)(root);
  }
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader"],
  ...(process.env.PATCHY_BROWSER_CHANNEL ? { channel: process.env.PATCHY_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
  extraHTTPHeaders: { "Accept-Encoding": "identity" } });
const page = await context.newPage();
const pageErrors = []; const remoteRequests = []; const expectedOrigin = new URL(baseUrl).origin;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith("http") && new URL(url).origin !== expectedOrigin) remoteRequests.push(url);
});

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready",
    null, { timeout: 90_000 });
  const result = await page.evaluate(async () => {
    const module = await import("./object-segmentation.mjs");
    const width = 1600; const height = 1000; const scaleX = width / 512; const scaleY = height / 512;
    const image = new OffscreenCanvas(width, height); const target = image.getContext("2d");
    target.scale(scaleX, scaleY);
    target.fillStyle = "#20262d"; target.fillRect(0, 0, 512, 512);
    target.fillStyle = "#d4a17d"; target.beginPath(); target.arc(270, 105, 63, 0, Math.PI * 2); target.fill();
    target.fillStyle = "#313943"; target.roundRect(155, 160, 230, 270, 55); target.fill();
    target.roundRect(90, 215, 105, 80, 35); target.fill();
    target.roundRect(340, 245, 125, 78, 35); target.fill();
    target.fillStyle = "#d4a17d"; target.roundRect(425, 270, 55, 70, 22); target.fill();
    target.fillStyle = "#101317"; target.roundRect(430, 273, 38, 42, 10); target.fill();
    target.fillStyle = "#0d1013"; target.save(); target.translate(150, 260); target.rotate(-.35);
    target.roundRect(-28, -75, 56, 150, 26); target.fill(); target.restore();

    const points = Object.fromEntries(Object.entries({ watch: [449, 294], microphone: [150, 260],
      person: [270, 250] }).map(([key, [x, y]]) => [key, { x: x * scaleX, y: y * scaleY }]));
    const identity = { documentId: "nested-detail", stateId: "1", revision: 0, width, height };
    const client = new module.ObjectSegmentationClient();
    const ready = await client.setImage(image.transferToImageBitmap(), identity);
    const selections = {};
    for (const [name, point] of Object.entries(points)) {
      const segmented = await client.segment([{ isCompleted: true, brushMode: 1,
        point: module.clickPromptStroke(point, width, height) }], identity);
      const gray = module.scaleConfidenceMask(segmented.confidence, segmented.width, segmented.height,
        width, height);
      const area = gray.reduce((sum, coverage) => sum + (coverage >= 128 ? 1 : 0), 0);
      selections[name] = { areaRatio: area / gray.length,
        selected: Object.fromEntries(Object.entries(points).map(([pointName, sample]) =>
          [pointName, gray[Math.min(height - 1, Math.floor(sample.y)) * width +
            Math.min(width - 1, Math.floor(sample.x))] >= 128])),
        automaticDetailApplied: Boolean(segmented.automaticDetailApplied),
        runtimeTier: segmented.runtimeTier };
    }
    client.close();
    return { ready, selections };
  });

  assert.equal(result.ready.previewWidth, 1024);
  assert.equal(result.ready.previewHeight, 640);
  for (const name of ["watch", "microphone"]) {
    const selection = result.selections[name];
    assert.equal(selection.selected[name], true, `${name} prompt was not selected`);
    assert.equal(selection.selected.person, false, `${name} collapsed into the person`);
    assert.ok(selection.areaRatio > .002 && selection.areaRatio < .08,
      `${name} area ratio ${selection.areaRatio}`);
  }
  assert.equal(result.selections.microphone.automaticDetailApplied, true);
  assert.equal(result.selections.person.selected.person, true);
  assert.ok(result.selections.person.areaRatio > .2 && result.selections.person.areaRatio < .5,
    `person area ratio ${result.selections.person.areaRatio}`);
  assert.deepEqual(remoteRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log(`OBJECT-SELECTION-DETAIL-RECOVERY PASS preview=${result.ready.previewWidth}x${result.ready.previewHeight}` +
    ` watch=${result.selections.watch.areaRatio.toFixed(4)}` +
    ` microphone=${result.selections.microphone.areaRatio.toFixed(4)}` +
    ` person=${result.selections.person.areaRatio.toFixed(4)}` +
    ` detail=${Number(result.selections.microphone.automaticDetailApplied)}` +
    ` tier=${result.selections.microphone.runtimeTier}`);
} finally { await browser.close(); }
