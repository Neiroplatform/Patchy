#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { verifyRelease } from "./build-self-hosted-release.mjs";

const releaseArgument = process.argv[2];
const browserName = process.argv[3] ?? "chromium";
if (!releaseArgument || !["chromium", "firefox", "webkit"].includes(browserName)) {
  console.error("usage: node verify-self-hosted-release-browser.mjs <release-dir> [chromium|firefox|webkit]");
  process.exit(2);
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
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? "failed"}`));
  page.on("request", (request) => {
    if (!request.url().startsWith(baseUrl)) externalRequests.push(request.url());
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
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(externalRequests, []);
  console.log(`PASS browser=${browserName} release=${manifest.releaseId} capability=${capabilityTier} files=${manifest.files.length}`);
} finally {
  await browser.close();
  await close(server);
}
