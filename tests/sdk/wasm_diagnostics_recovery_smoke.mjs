import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error("usage: node tests/sdk/wasm_diagnostics_recovery_smoke.mjs <served-repository-url>");
  process.exit(2);
}

async function loadPlaywright() {
  try { return await import("playwright"); }
  catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) throw new Error("Install playwright or set PATCHY_PLAYWRIGHT_ROOT to its package directory", { cause: error });
    return createRequire(import.meta.url)(root);
  }
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; ++bit) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
  return Buffer.concat([length, name, payload, checksum]);
}

function rgbaPng(width, height, rgba) {
  assert.equal(rgba.length, width * height * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; ++y) {
    rows[y * (1 + width * 4)] = 0;
    rgba.copy(rows, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

const { chromium } = await loadPlaywright();
const repository = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const temporary = await mkdtemp(join(tmpdir(), "patchy-diagnostics-browser-"));
const bundlePath = join(temporary, "patchy-diagnostics.json");
const browser = await chromium.launch({
  channel: process.env.PATCHY_BROWSER_CHANNEL || "chrome",
  headless: true,
});

try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()} ${request.failure()?.errorText || "failed"}`));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: async () => [] },
    });
  });
  await page.goto(`${baseUrl.replace(/\/$/, "")}/build/wasm-sdk/site/patchy.html?diagnostics-recovery-smoke=1`,
    { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");

  await page.selectOption("#localeSelect", "ru");
  await page.click("#diagnosticsButton");
  assert.equal(await page.textContent("#diagnosticsSummary"), "Документ не открыт");
  await page.click('#diagnosticsDialog button[value="cancel"]');

  await page.click("#newButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  const pixelText = Buffer.from("PRIVATE_PIXEL_SENTINEL", "ascii");
  const pixelWidth = Math.ceil(pixelText.length / 4);
  const pixelBytes = Buffer.alloc(pixelWidth * 4, 0);
  pixelText.copy(pixelBytes);
  assert.equal(pixelBytes.subarray(0, pixelText.length).toString("ascii"), "PRIVATE_PIXEL_SENTINEL");
  await page.setInputFiles("#imageInput", {
    name: "PRIVATE_FILENAME_SENTINEL.png",
    mimeType: "image/png",
    buffer: rgbaPng(pixelWidth, 1, pixelBytes),
  });
  await page.waitForFunction(() => Number(document.querySelector("#layerCount")?.textContent) >= 1 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await page.click("#textToolButton");
  await page.waitForSelector("#textDialog[open]");
  await page.fill("#textValueInput", "PRIVATE_TEXT_STORY_SENTINEL");
  await page.click("#commitTextButton");
  await page.waitForFunction(() => Number(document.querySelector("#layerCount")?.textContent) >= 2 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await page.click("#selectAllButton");
  await page.waitForFunction(() => Number(document.querySelector("#detailRevision")?.textContent) >= 2 &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");

  await page.click("#pastePixelsButton");
  await page.waitForSelector("#errorBanner:not([hidden])");
  await page.click("#dismissErrorButton");
  await page.waitForFunction(() => document.querySelector("#recoveryLabel")?.dataset.state === "confirmed");

  const engineWorker = page.workers().find((worker) => /\/engine\/worker\.mjs(?:\?|$)/.test(worker.url()));
  assert.ok(engineWorker, "production engine Worker was not found");
  await engineWorker.evaluate(() => {
    setTimeout(() => { throw new Error("PRIVATE_CRASH_ERROR_SENTINEL"); }, 0);
  });
  await page.waitForFunction(() => document.querySelector("#recoveryLabel")?.dataset.state === "confirmed" &&
    document.querySelector(".editor-shell")?.dataset.state === "document" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null, { timeout: 45_000 });

  await page.click("#diagnosticsButton");
  assert.equal(await page.isDisabled("#downloadDiagnosticsButton"), true);
  await page.check("#diagnosticsConsentInput");
  const downloadPromise = page.waitForEvent("download");
  await page.click("#downloadDiagnosticsButton");
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "patchy-diagnostics.json");
  await download.saveAs(bundlePath);

  const validator = join(repository, "scripts", "validate-browser-diagnostics.mjs");
  const validated = spawnSync(process.execPath, [validator, bundlePath], { encoding: "utf8" });
  assert.equal(validated.status, 0, validated.stderr);
  const summary = JSON.parse(validated.stdout);
  const bytes = await readFile(bundlePath, "utf8");
  const bundle = JSON.parse(bytes);
  assert.ok(summary.crashes >= 1, "offline summary omitted the Worker crash");
  assert.ok(summary.recoveries >= 1, "offline summary omitted automatic recovery");
  assert.ok(summary.failedCommands >= 1, "offline summary omitted a failed production command");
  assert.ok(bundle.events.some((event) => event.kind === "command" &&
    event.operation === "document.pastePixels" && event.outcome === "failed"));
  assert.equal(bundle.events.some((event) => event.kind === "command" &&
    event.operation === "document.pastePixels" && event.outcome === "succeeded"), false);
  assert.ok(bundle.events.some((event) => event.kind === "worker" && event.state === "crashed"));
  assert.ok(bundle.events.some((event) => event.kind === "recovery" &&
    ["succeeded", "partial"].includes(event.phase)));
  assert.doesNotMatch(bytes, /PRIVATE_|PRIVATE_FILENAME_SENTINEL|PRIVATE_TEXT_STORY_SENTINEL|PRIVATE_CRASH_ERROR_SENTINEL/);
  for (const encodedPixelMarker of [pixelBytes.toString("latin1"), pixelBytes.toString("base64"),
    pixelText.toString("base64"), pixelText.toString("hex")]) {
    assert.equal(bytes.includes(encodedPixelMarker), false, "diagnostics leaked real raster pixel bytes");
  }
  const numericValues = [];
  const collectNumbers = (value) => {
    if (typeof value === "number") numericValues.push(value);
    else if (Array.isArray(value)) value.forEach(collectNumbers);
    else if (value && typeof value === "object") Object.values(value).forEach(collectNumbers);
  };
  collectNumbers(bundle);
  const numericNeedle = [...pixelText];
  const hasNumericPixelLeak = numericValues.some((_, offset) => numericNeedle.every(
    (value, index) => numericValues[offset + index] === value));
  assert.equal(hasNumericPixelLeak, false, "diagnostics leaked raster pixels as a formatted numeric array");
  assert.deepEqual(failedRequests, []);
  assert.ok(pageErrors.length >= 1 && pageErrors.every((error) => error.includes("PRIVATE_CRASH_ERROR_SENTINEL")),
    `unexpected browser errors: ${pageErrors.join(" | ")}`);
  console.log(`PASS events=${summary.events} failed=${summary.failedCommands} crashes=${summary.crashes} recoveries=${summary.recoveries}`);
  await context.close();
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
