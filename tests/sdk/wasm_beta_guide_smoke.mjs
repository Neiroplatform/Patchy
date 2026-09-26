import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
const failedRequests = [];
const unexpectedNetwork = [];
const expectedOrigin = new URL(baseUrl).origin;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("requestfailed", (request) => failedRequests.push(
  `${request.url()} ${request.failure()?.errorText || "failed"}`));
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith("http") && new URL(url).origin !== expectedOrigin) unexpectedNetwork.push(url);
});

const editorUrl = `${baseUrl.replace(/\/$/, "")}/build/wasm-sdk/site/patchy.html?beta-guide-smoke=1`;
const waitUntilReady = () => page.waitForFunction(() =>
  document.querySelector(".editor-shell")?.dataset.state === "ready" &&
  document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true", null,
{ timeout: 90_000 });

try {
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await waitUntilReady();
  assert.equal((await page.textContent("#helpButton")).trim(), "Getting started");

  await page.click("#emptyNewButton");
  await page.waitForSelector("#starterDialog[open]");
  await page.click('#starterDialog button[value="cancel"]');
  await page.waitForSelector("#starterDialog[open]", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "emptyNewButton",
    "closing the starter did not return focus to its invoker");
  await page.click("#emptyNewButton");
  await page.fill("#starterWidthInput", "0");
  await page.click("#starterCustomCreateButton");
  assert.equal(await page.isVisible("#starterError"), true,
    "invalid starter dimensions did not fail before document creation");
  assert.equal((await page.textContent("#detailRevision")).trim(), "-");
  await page.click('[data-starter-preset="social"]');
  await page.waitForFunction(() => document.querySelector("#detailCanvas")?.textContent === "1080 × 1080" &&
    document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");

  await page.click("#helpButton");
  await page.waitForSelector("#helpDialog[open]");
  assert.equal((await page.textContent("#helpDialogTitle")).trim(), "Start editing locally");
  assert.match(await page.textContent("#helpDialog"), /1,000-file corpus acceptance/);
  assert.equal(await page.getAttribute('#helpDialog a[href="./capabilities.html"]', "target"), "_blank");
  await page.click("#helpNewButton");
  await page.waitForFunction(() => document.querySelector("#detailRevision")?.textContent === "0" &&
    document.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true");

  await page.click("#helpButton");
  await page.click("#completeGuideButton");
  assert.equal((await page.textContent("#helpButton")).trim(), "Help");
  assert.equal(await page.evaluate(() => localStorage.getItem("patchy.beta-guide.v1")), "complete");

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitUntilReady();
  assert.equal((await page.textContent("#helpButton")).trim(), "Help");
  await page.selectOption("#localeSelect", "ru");
  assert.equal((await page.textContent("#helpButton")).trim(), "Помощь");
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
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(unexpectedNetwork, []);
  console.log(`PASS browser=${browserName} beta-guide=local-first responsive=390x844`);
} finally {
  await browser.close();
}
