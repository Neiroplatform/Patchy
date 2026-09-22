import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  await page.setInputFiles("#imageInput", {
    name: "PRIVATE_FILENAME_SENTINEL.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><title>PRIVATE_TEXT_SENTINEL</title><rect width="32" height="24" fill="#123456" data-private="PRIVATE_PIXEL_SENTINEL"/></svg>'),
  });
  await page.waitForFunction(() => Number(document.querySelector("#layerCount")?.textContent) >= 1 &&
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
  assert.doesNotMatch(bytes, /PRIVATE_|PRIVATE_FILENAME_SENTINEL|PRIVATE_TEXT_SENTINEL|PRIVATE_PIXEL_SENTINEL|PRIVATE_CRASH_ERROR_SENTINEL/);
  assert.deepEqual(failedRequests, []);
  assert.ok(pageErrors.length >= 1 && pageErrors.every((error) => error.includes("PRIVATE_CRASH_ERROR_SENTINEL")),
    `unexpected browser errors: ${pageErrors.join(" | ")}`);
  console.log(`PASS events=${summary.events} failed=${summary.failedCommands} crashes=${summary.crashes} recoveries=${summary.recoveries}`);
  await context.close();
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
