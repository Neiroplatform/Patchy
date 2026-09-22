import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BrowserDiagnosticRecorder, collectRuntimeProfile, serializeDiagnosticBundle,
  summarizeDiagnosticBundle, validateDiagnosticBundle } from "../../sdk/engine/support-diagnostics.mjs";

const runtime = { browserFamily: "chromium", platformFamily: "macos",
  crossOriginIsolated: true, sharedArrayBuffer: true, offscreenCanvas: true,
  imageBitmap: true, opfs: true, hardwareConcurrency: 8, deviceMemoryGiB: 8 };

test("diagnostic bundle is deterministic, bounded and support-readable", () => {
  let clock = 1000;
  const recorder = new BrowserDiagnosticRecorder({ runtime, now: () => clock,
    sessionId: "session-12345678" });
  recorder.recordWorkerState("starting");
  clock += 132; recorder.recordWorkerState("ready");
  recorder.recordCommand("document.new", "started");
  recorder.recordCommand("document.new", "succeeded", 33);
  recorder.setDocument({ width: 1600, height: 1000, revision: 2n, dirty: true,
    layers: [{ name: "SECRET-LAYER" }], selection: [{ x: 0, y: 0, width: 1, height: 1 }],
    documents: [{ name: "SECRET-FILE.psd" }], memory: { totalRetainedBytes: 6400,
      historyRetainedBytes: 3200 } }, "psd");
  const bundle = recorder.createBundle({ locale: "en", capabilities: 31n });
  const first = serializeDiagnosticBundle(bundle);
  const second = serializeDiagnosticBundle(JSON.parse(first));
  assert.equal(first, second);
  const summary = summarizeDiagnosticBundle(first);
  assert.equal(summary.document.layers, 1);
  assert.equal(summary.events, 4);
  assert.equal(summary.failedCommands, 0);
  assert.doesNotMatch(first, /SECRET|filename|layerName|documentName/);
});

test("diagnostic recorder never serializes error text, paths, urls or content", () => {
  const recorder = new BrowserDiagnosticRecorder({ runtime, now: () => 0,
    sessionId: "privacy-12345678" });
  const error = new Error("SENTINEL /Users/private/file.psd https://secret.invalid pixel-text");
  error.name = "PatchyEngineError"; error.code = 6;
  recorder.recordError("document.open", error);
  recorder.recordCommand("document.open", "failed", 12);
  const bytes = serializeDiagnosticBundle(recorder.createBundle({ capabilities: 1n }));
  assert.doesNotMatch(bytes, /SENTINEL|Users|secret\.invalid|pixel-text|file\.psd/);
  assert.match(bytes, /"category": "engine"/);
  assert.match(bytes, /"code": 6/);
});

test("diagnostic event ring keeps only the newest 256 typed events", () => {
  let clock = 0;
  const recorder = new BrowserDiagnosticRecorder({ runtime, now: () => clock++,
    sessionId: "bounded-12345678" });
  for (let index = 0; index < 400; ++index) recorder.recordCommand("document.mutate", "succeeded", index);
  const bundle = recorder.createBundle({ capabilities: 0n });
  assert.equal(bundle.events.length, 256);
  assert.equal(bundle.events[0].sequence, 145);
  assert.equal(bundle.events.at(-1).sequence, 400);
});

test("validator rejects unknown fields, events and non-monotonic timelines", () => {
  const recorder = new BrowserDiagnosticRecorder({ runtime, now: () => 0,
    sessionId: "reject-12345678" });
  recorder.recordWorkerState("ready");
  const baseline = recorder.createBundle({ capabilities: 0n });
  assert.throws(() => validateDiagnosticBundle({ ...baseline, filename: "secret.psd" }), /unknown or missing/);
  assert.throws(() => validateDiagnosticBundle({ ...baseline,
    events: [{ ...baseline.events[0], arbitrary: "secret" }] }), /unknown or missing/);
  assert.throws(() => validateDiagnosticBundle({ ...baseline,
    events: [baseline.events[0], { ...baseline.events[0] }] }), /not monotonic/);
});

test("runtime profile exposes coarse families and capability buckets only", () => {
  const profile = collectRuntimeProfile({ crossOriginIsolated: true,
    SharedArrayBuffer, OffscreenCanvas: function () {}, createImageBitmap() {},
    navigator: { userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit Chrome/151.0 secret-build",
      platform: "MacIntel", hardwareConcurrency: 12, deviceMemory: 6,
      storage: { getDirectory() {} } } });
  assert.deepEqual(profile, { browserFamily: "chromium", platformFamily: "macos",
    crossOriginIsolated: true, sharedArrayBuffer: true, offscreenCanvas: true,
    imageBitmap: true, opfs: true, hardwareConcurrency: 16, deviceMemoryGiB: 8 });
  assert.doesNotMatch(JSON.stringify(profile), /151|secret-build|MacIntel/);
});

test("offline support command validates a bundle and rejects extra content", () => {
  const directory = mkdtempSync(join(tmpdir(), "patchy-diagnostics-"));
  try {
    const recorder = new BrowserDiagnosticRecorder({ runtime, now: () => 0,
      sessionId: "offline-12345678" });
    recorder.recordWorkerState("ready");
    const path = join(directory, "bundle.json");
    writeFileSync(path, serializeDiagnosticBundle(recorder.createBundle({ capabilities: 3n })));
    const script = fileURLToPath(new URL("../../scripts/validate-browser-diagnostics.mjs", import.meta.url));
    const accepted = spawnSync(process.execPath, [script, path], { encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).events, 1);
    writeFileSync(path, JSON.stringify({ ...recorder.createBundle({ capabilities: 3n }),
      sourcePath: "/private/secret.psd" }));
    const rejected = spawnSync(process.execPath, [script, path], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /^REJECTED:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
