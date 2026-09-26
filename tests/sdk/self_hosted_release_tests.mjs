import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assessCapabilities, capabilityReport } from "../../sdk/engine/site/capabilities.mjs";
import { buildRelease, verifyRelease } from "../../scripts/release/build-self-hosted-release.mjs";
import {
  assessApplicationMemory,
  BROWSER_PERFORMANCE_THRESHOLDS,
  MIB,
  parseDisplayedBytes,
  percentile,
} from "../../scripts/release/browser-performance-policy.mjs";

const RELEASE_ID = "r1-2026.09.25";
const SOURCE_SHA = "b1d0883f1a3641d4a177832057b2045544204bc6";
const REQUIRED = [
  ".htaccess",
  "capabilities.css",
  "capabilities.html",
  "capabilities.mjs",
  "editor.css",
  "editor.mjs",
  "engine/client.mjs",
  "engine/index.mjs",
  "engine/protocol.mjs",
  "engine/worker.mjs",
  "patchy-engine.mjs",
  "patchy-engine.wasm",
  "patchy.html",
];

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "patchy-self-hosted-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function stagedSite(root) {
  const site = join(root, "site");
  for (const path of REQUIRED) {
    const absolute = join(site, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    const contents = path.endsWith(".wasm") ? Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) : `fixture:${path}\n`;
    await writeFile(absolute, contents);
  }
  return site;
}

async function allFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else result.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  await visit(root);
  return result.sort();
}

test("self-hosted release is deterministic, immutable and independently verifiable", async (t) => {
  const root = await sandbox(t);
  const site = await stagedSite(root);
  const first = join(root, "first", RELEASE_ID);
  const second = join(root, "second", RELEASE_ID);
  const options = { siteDir: site, releaseId: RELEASE_ID, sourceSha: SOURCE_SHA, previousReleaseId: "r0-2026.09.24" };
  const built = await buildRelease({ ...options, outputDir: first });
  assert.equal(built.releaseId, RELEASE_ID);
  assert.ok(built.fileCount > REQUIRED.length);
  assert.deepEqual(await verifyRelease(first), built);
  await buildRelease({ ...options, outputDir: second });
  const paths = await allFiles(first);
  assert.deepEqual(await allFiles(second), paths);
  for (const path of paths) {
    assert.deepEqual(await readFile(join(first, path)), await readFile(join(second, path)), path);
  }

  const manifest = JSON.parse(await readFile(join(first, "release-manifest.json"), "utf8"));
  assert.equal(manifest.immutableReleasePath, `/releases/${RELEASE_ID}/`);
  assert.equal(manifest.sourceSha, SOURCE_SHA);
  assert.deepEqual(manifest.files.map((entry) => entry.path), [...manifest.files.map((entry) => entry.path)].sort());
  assert.equal(manifest.files.some((entry) => entry.path === "release-manifest.json"), false);
  assert.equal(manifest.files.some((entry) => entry.path === "patchy-engine.wasm.br"), true);
  assert.equal(manifest.files.some((entry) => entry.path === "engine/worker.mjs.gz"), true);
  assert.equal(manifest.securityHeaders["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.match(manifest.securityHeaders["Content-Security-Policy"], /connect-src 'self'/);
  assert.match(manifest.securityHeaders["Content-Security-Policy"], /'wasm-unsafe-eval'/);
  assert.doesNotMatch(manifest.securityHeaders["Content-Security-Policy"], /(?<!wasm-)unsafe-eval/);
  const rollback = JSON.parse(await readFile(join(first, "rollback.json"), "utf8"));
  assert.equal(rollback.previousReleasePath, "/releases/r0-2026.09.24/");
  assert.match(rollback.switchContract, /never mutate/);
  const policy = JSON.parse(await readFile(join(first, "release-policy.json"), "utf8"));
  assert.deepEqual(policy.support.targetReleaseMatrix, ["Chrome", "Edge", "Firefox"]);
  assert.equal(policy.support.limited.length, 1);
  assert.equal(policy.support.limited[0].browser, "Safari");
  assert.equal(policy.support.limited[0].tier, "limited");
  assert.match(policy.support.limited[0].reason, /two-hour Safari memory-soak gate is not accepted/);
  assert.match(policy.support.limited[0].promotionGate, /exact release candidate/);
  const [caddy, nginx, apache, sourceApache] = await Promise.all([
    readFile(join(first, "deploy/Caddyfile"), "utf8"),
    readFile(join(first, "deploy/nginx.conf"), "utf8"),
    readFile(join(first, "deploy/apache.htaccess"), "utf8"),
    readFile(join(first, ".htaccess"), "utf8"),
  ]);
  assert.match(caddy, /precompressed br gzip/);
  assert.match(nginx, /root \/srv\/patchy/);
  assert.match(nginx, /gzip_static on/);
  assert.equal((nginx.match(/location /g) ?? []).length, 1);
  assert.equal(apache, sourceApache);
});

test("release verifier rejects tampering and untracked files", async (t) => {
  const root = await sandbox(t);
  const site = await stagedSite(root);
  const release = join(root, RELEASE_ID);
  await buildRelease({ siteDir: site, outputDir: release, releaseId: RELEASE_ID, sourceSha: SOURCE_SHA });
  await writeFile(join(release, "editor.mjs"), "tampered\n");
  await assert.rejects(verifyRelease(release), /integrity verification/);

  const clean = join(root, "clean", RELEASE_ID);
  await buildRelease({ siteDir: site, outputDir: clean, releaseId: RELEASE_ID, sourceSha: SOURCE_SHA });
  await writeFile(join(clean, "untracked.txt"), "unexpected\n");
  await assert.rejects(verifyRelease(clean), /closed manifest inventory/);
});

test("release builder rejects incomplete, reserved and mutable staged trees", async (t) => {
  const root = await sandbox(t);
  const incomplete = await stagedSite(join(root, "incomplete"));
  await rm(join(incomplete, "patchy-engine.wasm"));
  await assert.rejects(buildRelease({
    siteDir: incomplete,
    outputDir: join(root, "missing", RELEASE_ID),
    releaseId: RELEASE_ID,
    sourceSha: SOURCE_SHA,
  }), /missing required file/);

  const reserved = await stagedSite(join(root, "reserved"));
  await writeFile(join(reserved, "release-policy.json"), "{}\n");
  await assert.rejects(buildRelease({
    siteDir: reserved,
    outputDir: join(root, "reserved-output", RELEASE_ID),
    releaseId: RELEASE_ID,
    sourceSha: SOURCE_SHA,
  }), /reserved release metadata/);

  const linked = await stagedSite(join(root, "linked"));
  try {
    await symlink(join(linked, "editor.mjs"), join(linked, "linked-editor.mjs"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.diagnostic(`symlink assertion unavailable on this runner: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(buildRelease({
    siteDir: linked,
    outputDir: join(root, "linked-output", RELEASE_ID),
    releaseId: RELEASE_ID,
    sourceSha: SOURCE_SHA,
  }), /symbolic links are forbidden/);
});

test("release identity prevents ambiguous paths and accidental overwrite", async (t) => {
  const root = await sandbox(t);
  const site = await stagedSite(root);
  await assert.rejects(buildRelease({
    siteDir: site,
    outputDir: join(root, "escape"),
    releaseId: "../escape",
    sourceSha: SOURCE_SHA,
  }), /invalid release id/);
  await assert.rejects(buildRelease({
    siteDir: site,
    outputDir: join(root, RELEASE_ID),
    releaseId: RELEASE_ID,
    sourceSha: "not-a-sha",
  }), /source SHA/);
  await assert.rejects(buildRelease({
    siteDir: site,
    outputDir: join(site, RELEASE_ID),
    releaseId: RELEASE_ID,
    sourceSha: SOURCE_SHA,
  }), /outside the staged site/);
  const release = join(root, RELEASE_ID);
  await buildRelease({ siteDir: site, outputDir: release, releaseId: RELEASE_ID, sourceSha: SOURCE_SHA });
  await assert.rejects(buildRelease({ siteDir: site, outputDir: release, releaseId: RELEASE_ID, sourceSha: SOURCE_SHA }), /already exists/);
});

test("capability policy blocks unsafe runtime and distinguishes enhanced limits", () => {
  const full = {
    webAssembly: true,
    worker: true,
    sharedArrayBuffer: true,
    crossOriginIsolated: true,
    opfs: true,
    offscreenCanvas: true,
    imageBitmap: true,
    fileSystemAccess: true,
  };
  assert.equal(assessCapabilities(full).tier, "ready");
  assert.equal(assessCapabilities({ ...full, opfs: false }).tier, "limited");
  const blocked = assessCapabilities({ ...full, crossOriginIsolated: false });
  assert.equal(blocked.tier, "blocked");
  assert.deepEqual(blocked.missingRequired, ["crossOriginIsolated"]);
  const report = capabilityReport(full);
  assert.equal(report.length, 8);
  assert.equal(report.filter((item) => item.required).length, 4);
});

test("capability page preserves local-first and strict-CSP contracts", async () => {
  const root = new URL("../../", import.meta.url);
  const [html, script, apache, browserVerifier] = await Promise.all([
    readFile(new URL("sdk/engine/site/capabilities.html", root), "utf8"),
    readFile(new URL("sdk/engine/site/capabilities.mjs", root), "utf8"),
    readFile(new URL("packaging/web/.htaccess", root), "utf8"),
    readFile(new URL("scripts/release/verify-self-hosted-release-browser.mjs", root), "utf8"),
  ]);
  assert.match(html, /does not upload a file/);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/);
  assert.doesNotMatch(html, /style=/);
  assert.doesNotMatch(script, /fetch\s*\(/);
  assert.doesNotMatch(script, /userAgent/);
  for (const header of [
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Embedder-Policy",
    "Cross-Origin-Resource-Policy",
    "Content-Security-Policy",
    "Permissions-Policy",
    "Referrer-Policy",
    "X-Content-Type-Options",
  ]) assert.match(apache, new RegExp(header));
  assert.match(apache, /mjs/);
  assert.match(browserVerifier, /verifyRelease\(releaseRoot\)/);
  assert.match(browserVerifier, /externalRequests/);
  assert.match(browserVerifier, /forbiddenRequests/);
  assert.match(browserVerifier, /PATCHY_RELEASE_SOAK_DURATION_MS/);
  assert.match(browserVerifier, /PATCHY_RELEASE_PERFORMANCE_DURATION_MS/);
  assert.match(browserVerifier, /patchy\.browser-performance-audit\/v1/);
  assert.match(browserVerifier, /#gestureCanvas/);
  assert.match(browserVerifier, /context\.fill = instrumentedFill/);
  assert.match(browserVerifier, /pointer-handler-to-overlay-fill/);
  assert.match(browserVerifier, /brushPreviewSamplesMs/);
  assert.match(browserVerifier, /scrollIntoView\(\{ block: "nearest"/);
  assert.doesNotMatch(browserVerifier, /scrollIntoViewIfNeeded/);
  assert.match(browserVerifier, /pan\/zoom requested an authoritative document recomposite/);
  assert.match(browserVerifier, /page\.waitForEvent\("download"/);
  assert.match(browserVerifier, /local-first-audit-/);
  assert.match(browserVerifier, /crossOriginIsolated/);
  assert.match(browserVerifier, /precompressed asset was not served/);
});

test("browser performance policy calculates p95 and rejects unbounded retained memory", () => {
  assert.equal(percentile([4, 1, 3, 2, 5], 0.95), 5);
  assert.equal(percentile([4, 1, 3, 2, 5], 0.5), 3);
  assert.equal(parseDisplayedBytes("12.5 MB retained · 8.0 MB history"), Math.round(12.5 * MIB));
  const stable = assessApplicationMemory([
    { applicationBytes: 64 * MIB },
    { applicationBytes: 96 * MIB },
    { applicationBytes: 128 * MIB },
    { applicationBytes: 127 * MIB },
    { applicationBytes: 129 * MIB },
    { applicationBytes: 128 * MIB },
    { applicationBytes: 130 * MIB },
  ]);
  assert.equal(stable.bounded, true);
  const growing = assessApplicationMemory([
    { applicationBytes: 64 * MIB },
    { applicationBytes: 120 * MIB },
    { applicationBytes: 180 * MIB },
    { applicationBytes: 230 * MIB },
    { applicationBytes: BROWSER_PERFORMANCE_THRESHOLDS.applicationMemoryCeilingBytes + 1 },
  ]);
  assert.equal(growing.bounded, false);
});
