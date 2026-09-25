#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
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
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

const releaseRoot = resolve(releaseArgument);
await verifyRelease(releaseRoot);
const manifest = JSON.parse(await readFile(join(releaseRoot, "release-manifest.json"), "utf8"));
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
const playwright = await loadPlaywright();
const browserType = playwright[browserName];
const launchOptions = { headless: true };
if (browserName === "chromium" && process.env.PATCHY_BROWSER_CHANNEL) {
  launchOptions.channel = process.env.PATCHY_BROWSER_CHANNEL;
}
const browser = await browserType.launch(launchOptions);

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
  assert.equal(acceptedDialogs, iterations, "each dirty local document must require explicit close confirmation");
  if (summaryPath) await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`PASS browser=${browserName} release=${manifest.releaseId} capability=${capabilityTier} files=${manifest.files.length} iterations=${iterations} elapsedMs=${summary.elapsedMs} downloadedBytes=${downloadedBytes}`);
} finally {
  await browser.close();
  await close(server);
}
