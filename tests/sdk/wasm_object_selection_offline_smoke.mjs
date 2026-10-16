import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { extname, normalize, relative, resolve, sep } from "node:path";
import { verifyRelease } from "../../scripts/release/build-self-hosted-release.mjs";

const releaseArgument = process.argv[2];
if (!releaseArgument) throw new Error("usage: node wasm_object_selection_offline_smoke.mjs <release-dir>");
async function loadPlaywright() {
  try { return await import("playwright"); }
  catch (error) {
    const root = process.env.PATCHY_PLAYWRIGHT_ROOT;
    if (!root) throw error;
    return createRequire(import.meta.url)(root);
  }
}
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm", ".json": "application/json; charset=utf-8",
  ".task": "application/octet-stream", ".svg": "image/svg+xml" };
const releaseRoot = resolve(releaseArgument);
await verifyRelease(releaseRoot);
const manifest = JSON.parse(await readFile(resolve(releaseRoot, "release-manifest.json"), "utf8"));
const declared = new Set(["release-manifest.json", ...manifest.files.map(({ path }) => path)]);
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname)
      .replace(/^\/+/, "");
    if (!pathname) pathname = manifest.entrypoint;
    const normalized = normalize(pathname); const absolute = resolve(releaseRoot, normalized);
    const fromRoot = relative(releaseRoot, absolute); const posix = normalized.split(sep).join("/");
    if (!declared.has(posix) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      response.writeHead(404); response.end(); return;
    }
    const body = await readFile(absolute);
    const immutable = /\.(?:css|js|mjs|wasm|task|json|svg)$/i.test(posix);
    response.writeHead(200, { ...manifest.securityHeaders,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "Content-Type": types[extname(posix).toLowerCase()] || "application/octet-stream" });
    response.end(body);
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise((resolveListen, reject) => {
  server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen);
});

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true,
  ...(process.env.PATCHY_SOFTWARE_GL === "1" ? { args: ["--use-angle=swiftshader"] } : {}),
  ...(process.env.PATCHY_BROWSER_CHANNEL ? { channel: process.env.PATCHY_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ extraHTTPHeaders: { "Accept-Encoding": "identity" } });
const page = await context.newPage(); const remoteRequests = []; const errors = [];
const baseUrl = `http://127.0.0.1:${server.address().port}/${manifest.entrypoint}`;
const expectedOrigin = new URL(baseUrl).origin;
page.on("request", (request) => {
  if (request.url().startsWith("http") && new URL(request.url()).origin !== expectedOrigin)
    remoteRequests.push(request.url());
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("requestfailed", (request) => errors.push(
  `${request.failure()?.errorText || "request failed"}: ${request.url()}`));

async function infer(label) {
  return page.evaluate(async (label) => {
    const { ObjectSegmentationClient, clickPromptStroke } = await import("./object-segmentation.mjs");
    const canvas = new OffscreenCanvas(96, 96); const target = canvas.getContext("2d");
    target.fillStyle = "#fff"; target.fillRect(0, 0, 96, 96);
    target.fillStyle = "#111"; target.fillRect(24, 20, 48, 56);
    const identity = { documentId: label, stateId: "1", revision: 0, width: 96, height: 96,
      source: "visible", sourceLayerIds: ["1"] };
    const client = new ObjectSegmentationClient();
    const ready = await client.setImage(canvas.transferToImageBitmap(), identity);
    const result = await client.segment([{ isCompleted: true, brushMode: 1,
      point: clickPromptStroke({ x: 48, y: 48 }, 96, 96) }], identity);
    client.close();
    return { runtimeTier: result.runtimeTier || ready.runtimeTier,
      range: Math.max(...result.confidence) - Math.min(...result.confidence) };
  }, label);
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.state === "ready",
    null, { timeout: 90_000 });
  // The product now warms the immutable local assets immediately after editor
  // readiness. Let that single owner finish before the explicit online/offline
  // clients exercise cache reuse, avoiding concurrent writes to the same
  // CacheStorage entries on Edge.
  await page.waitForFunction(() => document.querySelector(".editor-shell")?.dataset.objectModel === "ready",
    null, { timeout: 90_000 });
  const online = await infer("online");
  await context.setOffline(true);
  let offline;
  try { offline = await infer("offline"); }
  catch (error) { throw new Error(`${error.message}; network=${errors.join(" | ")}`); }
  assert.ok(online.range > 0 && offline.range > 0);
  assert.equal(offline.runtimeTier, online.runtimeTier);
  assert.deepEqual(remoteRequests, []); assert.deepEqual(errors, []);
  console.log(`OBJECT-SELECTION-OFFLINE PASS tier=${offline.runtimeTier} online=1 offline=1`);
} finally {
  await context.setOffline(false).catch(() => {});
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
