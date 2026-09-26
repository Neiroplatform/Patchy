import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const baseUrl = process.argv[2];
const browserName = process.argv[3] || "chromium";
if (!baseUrl || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node tests/sdk/wasm_beta_guide_smoke.mjs <served-repository-url> [chromium|firefox|webkit]");
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

const playwright = await loadPlaywright();
const browserType = playwright[browserName];
const launchOptions = browserName === "chromium" && process.env.PATCHY_BROWSER_CHANNEL
  ? { channel: process.env.PATCHY_BROWSER_CHANNEL } : {};
const browser = await browserType.launch({ headless: true, ...launchOptions });
async function closeBrowserWithDeadline() {
  const teardownWatchdog = setTimeout(() => {
    console.error(`BETA-GUIDE-SOURCE-TEARDOWN-TIMEOUT browser=${browserName}`);
    process.exit(1);
  }, 15_000);
  try {
    await browser.close();
  } finally {
    clearTimeout(teardownWatchdog);
  }
}

let page;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
} catch (error) {
  console.error(`BETA-GUIDE-SOURCE-ERROR browser=${browserName} ${error?.stack || error}`);
  await closeBrowserWithDeadline();
  throw error;
}
const pageErrors = [];
const failedRequests = [];
const unexpectedNetwork = [];
let acceptedDialogs = 0;
const expectedOrigin = new URL(baseUrl).origin;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("requestfailed", (request) => failedRequests.push(
  `${request.url()} ${request.failure()?.errorText || "failed"}`));
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith("http") && new URL(url).origin !== expectedOrigin) unexpectedNetwork.push(url);
});
page.on("dialog", async (dialog) => {
  acceptedDialogs++;
  await dialog.accept();
});
await page.addInitScript(() => {
  Object.defineProperty(globalThis, "showOpenFilePicker", { configurable: true, value: undefined });
  Object.defineProperty(globalThis, "showSaveFilePicker", { configurable: true, value: undefined });
});

const editorUrl = `${baseUrl.replace(/\/$/, "")}/build/wasm-sdk/site/patchy.html?beta-guide-smoke=1`;
const waitUntilReady = () => page.waitForFunction(() =>
  document.querySelector(".editor-shell")?.dataset.state === "ready" &&
  document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
{ timeout: 90_000 });

async function closeActiveDocument() {
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=close-start dialogs=${acceptedDialogs}`);
  await page.click('#documentTabs .document-tab[data-active="true"] button[aria-hidden="true"]');
  await page.waitForFunction(() =>
    document.querySelectorAll('#documentTabs [role="tab"]').length === 0 &&
    document.querySelector(".editor-shell")?.dataset.state === "ready" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=close-complete dialogs=${acceptedDialogs}`);
}

async function createStarterPreset(id, width, height) {
  await page.click("#emptyNewButton");
  await page.click(`[data-starter-preset="${id}"]`);
  await page.waitForFunction(({ expectedWidth, expectedHeight }) =>
    document.querySelector("#detailCanvas")?.textContent === `${expectedWidth} × ${expectedHeight}` &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  { expectedWidth: width, expectedHeight: height }, { timeout: 90_000 });
  await closeActiveDocument();
}

async function createCustomStarter(width, height, format, { keyboard = false } = {}) {
  await page.click("#emptyNewButton");
  await page.fill("#starterWidthInput", String(width));
  await page.fill("#starterHeightInput", String(height));
  if (keyboard) await page.locator("#starterHeightInput").press("Enter");
  else await page.click("#starterCustomCreateButton");
  await page.waitForTimeout(250);
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=custom-${width}x${height} state=${JSON.stringify(await page.evaluate(() => ({
    dialogOpen: document.querySelector("#starterDialog")?.open,
    canvas: document.querySelector("#detailCanvas")?.textContent,
    revision: document.querySelector("#detailRevision")?.textContent,
    format: document.querySelector("#saveFormatSelect")?.value,
    recovery: document.querySelector("#recoveryLabel")?.dataset.state,
    busy: document.querySelector(".editor-shell")?.getAttribute("aria-busy"),
    error: document.querySelector("#errorPanel")?.textContent,
  })))}`);
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

try {
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await waitUntilReady();
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=ready`);
  assert.equal((await page.textContent("#helpButton")).trim(), "Getting started");

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
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log(`BETA-GUIDE-SOURCE-PHASE browser=${browserName} phase=starter-layout`);

  await page.focus("#emptyNewButton");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#starterDialog[open]");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#starterDialog[open]", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "emptyNewButton",
    "closing the starter did not return focus to its invoker");
  await page.click("#emptyNewButton");
  await page.fill("#starterWidthInput", "0");
  await page.click("#starterCustomCreateButton");
  assert.equal(await page.isVisible("#starterError"), true,
    "invalid starter dimensions did not fail before document creation");
  assert.equal((await page.textContent("#detailRevision")).trim(), "-");
  await page.click('[data-starter-preset="blank"]');
  await page.waitForFunction(() => document.querySelector("#detailCanvas")?.textContent === "1600 × 1000" &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
  { timeout: 90_000 });
  await closeActiveDocument();
  await createStarterPreset("social", 1080, 1080);
  await createStarterPreset("presentation", 1920, 1080);
  await createStarterPreset("print-a4", 2480, 3508);
  assert.equal(acceptedDialogs, 0,
    "clean starter documents must close without a destructive-change confirmation");
  const starterRecoveryState = await createCustomStarter(640, 480, "psd", { keyboard: true });
  await closeActiveDocument();
  assert.equal(await createCustomStarter(30000, 1, "psd"), starterRecoveryState);
  await closeActiveDocument();
  assert.equal(await createCustomStarter(30001, 1, "psb"), starterRecoveryState);
  const [psbDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    page.click("#saveAsButton"),
  ]);
  const psbBytes = await readFile(await psbDownload.path());
  assert.equal(psbDownload.suggestedFilename().endsWith(".psb"), true);
  assert.equal(psbBytes.subarray(0, 4).toString("ascii"), "8BPS");
  assert.equal(psbBytes.readUInt16BE(4), 2, "large starter did not encode PSB version 2");
  await psbDownload.delete();
  await closeActiveDocument();
  assert.equal(acceptedDialogs, 0,
    "checkpointed clean starters must not invent destructive-change confirmations");

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
    await closeActiveDocument();
  } else {
    assert.match(await page.locator("#recoverySummary").textContent(), /unavailable/i);
    await page.click('#recoveryDialog button[value="cancel"]');
  }
  assert.equal(acceptedDialogs, 0,
    "recovering an unchanged checkpoint must not invent a dirty-close confirmation");

  await page.click("#helpButton");
  await page.waitForSelector("#helpDialog[open]");
  assert.equal((await page.textContent("#helpDialogTitle")).trim(), "Start editing locally");
  assert.match(await page.textContent("#helpDialog"), /1,000-file corpus acceptance/);
  assert.equal(await page.getAttribute('#helpDialog a[href="./capabilities.html"]', "target"), "_blank");
  await page.click("#helpNewButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await closeActiveDocument();

  await page.click("#helpButton");
  await page.click("#completeGuideButton");
  assert.equal((await page.textContent("#helpButton")).trim(), "Help");
  assert.equal(await page.evaluate(() => localStorage.getItem("patchy.beta-guide.v1")), "complete");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitUntilReady();
  assert.equal((await page.textContent("#helpButton")).trim(), "Help");
  await page.selectOption("#localeSelect", "ru");
  assert.equal((await page.textContent("#helpButton")).trim(), "Помощь");
  await page.click("#emptyNewButton");
  assert.equal((await page.textContent("#starterDialogTitle")).trim(), "Создать локальный документ");
  await page.click("#starterCloseButton");
  await page.click("#helpButton");
  assert.equal((await page.textContent("#helpDialogTitle")).trim(), "Начните редактировать локально");
  await page.click('#helpDialog button[value="cancel"]');
  await page.waitForSelector("#helpDialog[open]", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "helpButton",
    "closing Help did not return focus to its invoker");

  await page.click("#newButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");
  await page.locator("#layerNameInput").dispatchEvent("keydown", { key: "?" });
  assert.equal(await page.isVisible("#helpDialog[open]"), false,
    "the global Help shortcut captured an editable field");
  await page.locator("body").press("?");
  await page.waitForSelector("#helpDialog[open]");

  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector("#helpDialog");
    const shortcut = document.querySelector(".shortcut-grid");
    const columns = document.querySelector(".help-columns");
    const rect = dialog.getBoundingClientRect();
    return {
      dialogWidth: rect.width,
      viewportWidth: innerWidth,
      shortcutColumns: getComputedStyle(shortcut).gridTemplateColumns.split(" ").length,
      helpColumns: getComputedStyle(columns).gridTemplateColumns.split(" ").length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.ok(layout.dialogWidth <= layout.viewportWidth, "Help dialog overflows the mobile viewport");
  assert.equal(layout.shortcutColumns, 1);
  assert.equal(layout.helpColumns, 1);
  assert.equal(layout.horizontalOverflow, false);

  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.$eval("#helpDialog", (node) =>
    Number.parseFloat(getComputedStyle(node).transitionDuration) <= .001), true);
  await page.click('#helpDialog button[value="cancel"]');
  await closeActiveDocument();
  assert.equal(acceptedDialogs, 0,
    "beta guide must not invent confirmations for unchanged documents");
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(unexpectedNetwork, []);
  console.log(`PASS browser=${browserName} beta-guide=local-first starter-psb=1 recovery=${starterRecoveryState} responsive=390x844`);
} catch (error) {
  console.error(`BETA-GUIDE-SOURCE-ERROR browser=${browserName} ${error?.stack || error}`);
  throw error;
} finally {
  await closeBrowserWithDeadline();
}
