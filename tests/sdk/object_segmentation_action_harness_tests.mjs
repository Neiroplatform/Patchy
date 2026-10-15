import assert from "node:assert/strict";
import test from "node:test";
import { OBJECT_SEGMENTATION_MODEL, OBJECT_SEGMENTATION_RUNTIME, ObjectSegmentationClient,
  OBJECT_SEGMENTATION_DETAIL_MIN_SHORT_EDGE, OBJECT_SEGMENTATION_PREVIEW_MAX_LONG_EDGE,
  OBJECT_SEGMENTATION_REQUEST_TIMEOUT_MS, automaticDetailPromptStroke,
  automaticSubjectPromptStroke,
  boundedObjectPreviewSize, chooseAutomaticDetailConfidence,
  clickPromptStroke, normalizedPromptPoint, proposalMatchesSnapshot, rectanglePromptStroke,
  scaleConfidenceMask, refineObjectSelectionMask, combineSelectionMasks, hasSelectableObjectCoverage, objectSegmentationDelegate,
  objectSelectionIdentityMatches,
  readResponseBytesWithProgress,
  selectionCombineModeForPointer,
  shouldAttemptAutomaticDetailConfidence,
  withObjectSegmentationRuntimeFallback } from "../../sdk/engine/site/object-segmentation.mjs";
import { ACTION_PLAN_PLANNER, ActionPlanClarificationError, DeterministicPlannerAdapter,
  actionPlanSummary, planPrompt, validateActionPlan } from "../../sdk/engine/site/action-harness.mjs";
import { installSameOriginFetch,
  responseCacheCommit } from "../../sdk/engine/site/ml-network-policy.mjs";

test("object proposals are exact-state bound", () => {
  const snapshot = { documentId: 7n, stateId: 9n, revision: 11, width: 2, height: 2 };
  const proposal = { documentId: "7", stateId: "9", revision: 11, width: 2, height: 2 };
  assert.equal(proposalMatchesSnapshot(proposal, snapshot), true);
  assert.equal(proposalMatchesSnapshot({ ...proposal, revision: 12 }, snapshot), false);
});

test("object embedding reuse is bound to exact document source identity", () => {
  const identity = { documentId: "7", stateId: "9", revision: 11, width: 20, height: 10,
    source: "active", sourceLayerIds: ["3"] };
  assert.equal(objectSelectionIdentityMatches(identity, structuredClone(identity)), true);
  assert.equal(objectSelectionIdentityMatches(identity, { ...identity, revision: 12 }), false);
  assert.equal(objectSelectionIdentityMatches(identity, { ...identity, source: "visible" }), false);
  assert.equal(objectSelectionIdentityMatches(identity, { ...identity, sourceLayerIds: ["4"] }), false);
});

test("object model and runtime identities are immutable release inputs", () => {
  assert.match(OBJECT_SEGMENTATION_MODEL.sha256, /^[0-9a-f]{64}$/);
  assert.equal(OBJECT_SEGMENTATION_MODEL.bytes, 30525312);
  assert.match(OBJECT_SEGMENTATION_RUNTIME.bundleSha256, /^[0-9a-f]{64}$/);
  assert.match(OBJECT_SEGMENTATION_RUNTIME.wasmModuleSha256, /^[0-9a-f]{64}$/);
  assert.equal(OBJECT_SEGMENTATION_RUNTIME.wasmModuleBytes, 12997272);
});

test("object inference rejects software WebGL delegates before model initialization", () => {
  assert.equal(objectSegmentationDelegate("ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Ultra)"), "gpu");
  assert.equal(objectSegmentationDelegate("ANGLE (Google, Vulkan 1.3 (SwiftShader Device))"), "wasm");
  assert.equal(objectSegmentationDelegate("Microsoft Basic Render Driver"), "wasm");
  assert.equal(objectSegmentationDelegate("llvmpipe (LLVM 18.1.8)"), "wasm");
  assert.equal(objectSegmentationDelegate(""), "wasm");
});

test("GPU inference failure retries once on WASM while WASM failure stays fail closed", async () => {
  const calls = [];
  assert.equal(await withObjectSegmentationRuntimeFallback("gpu", () => {
    calls.push("gpu"); throw new Error("RET_CHECK failure");
  }, () => { calls.push("wasm"); return "recovered"; }), "recovered");
  assert.deepEqual(calls, ["gpu", "wasm"]);
  await assert.rejects(withObjectSegmentationRuntimeFallback("wasm",
    () => { throw new Error("cpu failure"); }, () => "must not run"), /cpu failure/);
});

test("object inference preview is aspect preserving and bounded before runtime initialization", () => {
  assert.equal(OBJECT_SEGMENTATION_PREVIEW_MAX_LONG_EDGE, 1024);
  assert.deepEqual(boundedObjectPreviewSize(1600, 1000), { width: 1024, height: 640 });
  assert.deepEqual(boundedObjectPreviewSize(640, 480), { width: 640, height: 480 });
  assert.deepEqual(boundedObjectPreviewSize(1, 2000), { width: 1, height: 1024 });
  assert.throws(() => boundedObjectPreviewSize(0, 10), /positive integers/);
});

test("inference Worker fetch policy permits same-origin assets and blocks telemetry origins", async () => {
  const calls = []; const stored = new Map(); let online = true;
  const scope = { location: { href: "https://editor.test/runtime/worker.mjs" },
    caches: { async open() { return { async match(key) { return stored.get(key); },
      async put(key, response) { stored.set(key, response); } }; } },
    fetch(input) { calls.push(String(input));
      return online ? Promise.resolve(new Response("model")) : Promise.reject(new Error("offline")); } };
  const restore = installSameOriginFetch(scope, { cacheName: "patchy-ml-test" });
  const firstResponse = await scope.fetch("./model.task");
  assert.equal(await firstResponse.text(), "model");
  await responseCacheCommit(firstResponse);
  online = false;
  assert.equal(await (await scope.fetch("./model.task")).text(), "model");
  const telemetry = await scope.fetch("https://odml.pa.googleapis.com/v1/log");
  assert.equal(telemetry.status, 200);
  await assert.rejects(scope.fetch("https://example.test/model.task"),
    { code: "REMOTE_FETCH_BLOCKED" });
  assert.deepEqual(calls, ["./model.task"]);
  restore();
  online = true; await scope.fetch("https://odml.pa.googleapis.com/v1/log");
  assert.equal(calls.length, 2);
});

test("model bytes stream with bounded progress while cache publication completes concurrently", async () => {
  let releaseCache;
  const cacheGate = new Promise((resolve) => { releaseCache = resolve; });
  const stored = new Map();
  const scope = { location: { href: "https://editor.test/runtime/worker.mjs" },
    caches: { async open() { return { async match(key) { return stored.get(key); },
      async put(key, response) { const body = await response.arrayBuffer(); await cacheGate;
        stored.set(key, new Response(body)); } }; } },
    fetch() { return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]))); } };
  installSameOriginFetch(scope, { cacheName: "patchy-ml-stream" });
  const response = await scope.fetch("./model.task");
  const progress = [];
  assert.deepEqual([...await readResponseBytesWithProgress(response, 4,
    (ratio) => progress.push(ratio))], [1, 2, 3, 4]);
  assert.equal(progress.at(-1), 1);
  let committed = false;
  responseCacheCommit(response).then(() => { committed = true; });
  await Promise.resolve(); assert.equal(committed, false);
  releaseCache(); await responseCacheCommit(response);
  assert.equal(await (await scope.fetch("./model.task")).arrayBuffer().then(
    (buffer) => new Uint8Array(buffer)[3]), 4);
  await assert.rejects(readResponseBytesWithProgress(
    new Response(new Uint8Array([1, 2, 3])), 4), /byte count mismatch/i);
});

test("object selection cancellation rejects work and terminates the synchronous inference Worker", async () => {
  const listeners = new Map();
  const worker = { terminated: false, addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage() {}, terminate() { this.terminated = true; } };
  const client = new ObjectSegmentationClient(worker);
  const pending = client.segment([], {});
  client.cancel();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(worker.terminated, true);
  await assert.rejects(client.segment([], {}), /closed|terminated|cancelled/i);
});

test("cold object setup allows the hosted model transfer and initialization budget", () => {
  const worker = { addEventListener() {}, postMessage() {}, terminate() {} };
  const client = new ObjectSegmentationClient(worker);
  assert.equal(client.timeouts.setImage, 600_000);
  assert.equal(OBJECT_SEGMENTATION_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(client.timeouts.segment, OBJECT_SEGMENTATION_REQUEST_TIMEOUT_MS);
  client.close();
});

test("stalled inference fails closed and terminates its Worker", async () => {
  const worker = { terminated: false, addEventListener() {}, postMessage() {},
    terminate() { this.terminated = true; } };
  const client = new ObjectSegmentationClient(worker, { segment: 5 });
  await assert.rejects(client.segment([], {}), { code: "INFERENCE_TIMEOUT" });
  assert.equal(worker.terminated, true);
  await assert.rejects(client.segment([], {}), /closed/i);
});

test("object model loading reports progress without resolving the request early", async () => {
  let messageListener = null; const progress = [];
  const worker = { addEventListener(type, listener) { if (type === "message") messageListener = listener; },
    postMessage(message) { queueMicrotask(() => {
      messageListener({ data: { type: "progress", requestId: message.requestId,
        phase: "model", ratio: .2 } });
      messageListener({ data: { type: "image-ready", requestId: message.requestId,
        identity: message.identity, runtimeTier: "wasm" } });
    }); }, terminate() {} };
  const client = new ObjectSegmentationClient(worker);
  const ready = await client.setImage({}, { documentId: "fixture" }, (event) => progress.push(event.phase));
  assert.deepEqual(progress, ["model"]); assert.equal(ready.runtimeTier, "wasm");
  client.close();
});

test("confidence masks scale deterministically to document coverage", () => {
  assert.deepEqual([...scaleConfidenceMask(new Float32Array([0, .25, .5, 1]), 2, 2, 4, 2)],
    [0, 0, 64, 64, 128, 128, 255, 255]);
  assert.throws(() => scaleConfidenceMask(new Float32Array(3), 2, 2, 2, 2), /invalid/);
});

test("automatic object-mask cleanup fills pinholes and removes detached noise", () => {
  const width = 15; const height = 15; const source = new Uint8Array(width * height);
  for (let y = 3; y <= 11; ++y)
    for (let x = 3; x <= 11; ++x) source[y * width + x] = 255;
  source[7 * width + 7] = 0;
  source[0] = 255;
  const refined = refineObjectSelectionMask(source, width, height);
  assert.equal(refined[7 * width + 7], 255, "small enclosed hole was not filled");
  assert.equal(refined[0], 0, "detached one-pixel island was not removed");
  assert.equal(refined[6 * width + 6], 255, "main object was damaged");
});

test("automatic object-mask cleanup prunes weak spurs but preserves confident fine detail", () => {
  const width = 21; const height = 21; const source = new Uint8Array(width * height);
  for (let y = 5; y <= 15; ++y)
    for (let x = 5; x <= 15; ++x) source[y * width + x] = 255;
  source[10 * width + 16] = 160;
  source[10 * width + 17] = 160;
  source[8 * width + 16] = 240;
  source[8 * width + 17] = 240;
  const refined = refineObjectSelectionMask(source, width, height);
  assert.equal(refined[10 * width + 17], 0, "low-confidence protrusion survived cleanup");
  assert.equal(refined[8 * width + 17], 240, "high-confidence fine detail was removed");
});

test("automatic object-mask cleanup preserves Gray8 soft-edge coverage", () => {
  const width = 9; const height = 9; const source = new Uint8Array(width * height);
  for (let y = 3; y <= 5; ++y)
    for (let x = 3; x <= 5; ++x) source[y * width + x] = 255;
  for (const [x, y] of [[2, 3], [2, 4], [2, 5], [6, 3], [6, 4], [6, 5]])
    source[y * width + x] = 64;
  const refined = refineObjectSelectionMask(source, width, height);
  for (const [x, y] of [[2, 3], [2, 4], [2, 5], [6, 3], [6, 4], [6, 5]])
    assert.equal(refined[y * width + x], 64, `soft edge ${x},${y} was quantized away`);
});

test("automatic object-mask cleanup preserves the primary tiny object and fails closed on emptying", () => {
  const width = 9; const height = 9;
  for (const size of [1, 2, 3]) {
    const source = new Uint8Array(width * height);
    for (let x = 0; x < size; ++x) source[4 * width + 3 + x] = 255;
    source[0] = 255;
    const refined = refineObjectSelectionMask(source, width, height);
    assert.equal(refined[4 * width + 3], 255, `primary ${size}-pixel object was removed`);
    if (size > 1) assert.equal(refined[0], 0, "smaller detached noise survived");
  }
  const weakHalo = new Uint8Array(width * height); weakHalo[4 * width + 4] = 160;
  for (const [x, y] of [[4, 3], [3, 4], [5, 4], [4, 5]]) weakHalo[y * width + x] = 64;
  assert.throws(() => refineObjectSelectionMask(weakHalo, width, height), /emptied proposal/);
  assert.equal(hasSelectableObjectCoverage(new Uint8Array([0, 64, 127])), false);
  assert.equal(hasSelectableObjectCoverage(new Uint8Array([0, 128])), true);
});

test("automatic object-mask cleanup leaves large semantic openings intact", () => {
  const width = 30; const height = 30; const source = new Uint8Array(width * height);
  for (let y = 4; y <= 25; ++y)
    for (let x = 4; x <= 25; ++x) source[y * width + x] = 255;
  for (let y = 10; y <= 19; ++y)
    for (let x = 10; x <= 19; ++x) source[y * width + x] = 0;
  const refined = refineObjectSelectionMask(source, width, height);
  assert.equal(refined[15 * width + 15], 0,
    "large real opening was incorrectly filled as a pinhole");
});

test("object proposals combine through replace, add, subtract and intersect coverage", () => {
  const current = new Uint8Array([0, 64, 128, 255]);
  const proposed = new Uint8Array([255, 128, 64, 0]);
  assert.deepEqual([...combineSelectionMasks(current, proposed, "replace")], [255, 128, 64, 0]);
  assert.deepEqual([...combineSelectionMasks(current, proposed, "add")], [255, 128, 128, 255]);
  assert.deepEqual([...combineSelectionMasks(current, proposed, "subtract")], [0, 32, 96, 255]);
  assert.deepEqual([...combineSelectionMasks(current, proposed, "intersect")], [0, 64, 64, 0]);
  assert.throws(() => combineSelectionMasks(current, new Uint8Array(2), "add"), /equal/);
});

test("Object Select captures Photoshop-style pointer modifier combine modes", () => {
  assert.equal(selectionCombineModeForPointer({}, "replace"), "replace");
  assert.equal(selectionCombineModeForPointer({}, "add"), "add");
  assert.equal(selectionCombineModeForPointer({ shiftKey: true }, "replace"), "add");
  assert.equal(selectionCombineModeForPointer({ altKey: true }, "replace"), "subtract");
  assert.equal(selectionCombineModeForPointer({ shiftKey: true, altKey: true }, "replace"),
    "intersect");
  assert.throws(() => selectionCombineModeForPointer({}, "invalid"), /invalid/);
});

test("point and box prompts are normalized and bounded", () => {
  assert.deepEqual(normalizedPromptPoint({ x: -2, y: 200 }, 100, 100), { x: 0, y: 1 });
  assert.deepEqual(clickPromptStroke({ x: 50, y: 50 }, 100, 100),
    [{ x: .46, y: .5 }, { x: .48, y: .5 }, { x: .5, y: .5 },
      { x: .52, y: .5 }, { x: .54, y: .5 }]);
  const box = rectanglePromptStroke({ x: 80, y: 70 }, { x: 20, y: 10 }, 100, 100);
  assert.equal(box.length, 5); assert.deepEqual(box[0], { x: .2, y: .1 });
  assert.deepEqual(box.at(-1), box[0]);
  assert.deepEqual(automaticSubjectPromptStroke(100, 80), [{ isCompleted: true, brushMode: 1,
    point: clickPromptStroke({ x: 50, y: 40 }, 100, 80) }]);
  assert.throws(() => automaticSubjectPromptStroke(0, 80), /positive integers/);
});

test("automatic click detail uses a bounded box and keeps only a valid tighter prompted object", () => {
  const click = [{ isCompleted: true, brushMode: 1,
    point: clickPromptStroke({ x: 320, y: 200 }, 800, 400) }];
  assert.equal(OBJECT_SEGMENTATION_DETAIL_MIN_SHORT_EDGE, 256);
  const detailPrompt = automaticDetailPromptStroke(click, 800, 400);
  assert.equal(detailPrompt.length, 1); assert.equal(detailPrompt[0].brushMode, 3);
  assert.deepEqual(detailPrompt[0].point[0], { x: .3625, y: .425 });
  assert.deepEqual(detailPrompt[0].point[2], { x: .4375, y: .575 });
  assert.equal(automaticDetailPromptStroke(click, 800, 200), null,
    "low-resolution previews must not pay for a second semantic solve");
  assert.equal(automaticDetailPromptStroke([...click, click[0]], 800, 400), null);
  assert.equal(automaticDetailPromptStroke([{ isCompleted: true, brushMode: 1,
    point: rectanglePromptStroke({ x: 10, y: 10 }, { x: 90, y: 90 }, 800, 400) }],
  800, 400), null);

  const width = 20; const height = 10; const primary = new Float32Array(width * height);
  const detail = new Float32Array(width * height);
  for (let y = 1; y < 9; ++y) for (let x = 2; x < 18; ++x) primary[y * width + x] = .9;
  for (let y = 4; y < 7; ++y) for (let x = 7; x < 11; ++x) detail[y * width + x] = .95;
  const chosen = chooseAutomaticDetailConfidence(primary, detail, width, height, { x: .4, y: .5 });
  assert.equal(chosen.automaticDetailApplied, true); assert.equal(chosen.confidence, detail);
  assert.equal(shouldAttemptAutomaticDetailConfidence(primary, width, height, { x: .4, y: .5 }), true);
  const compact = new Float32Array(width * height); compact[5 * width + 8] = 1;
  assert.equal(shouldAttemptAutomaticDetailConfidence(compact, width, height, { x: .4, y: .5 }), false);
  detail.fill(0); detail[0] = 1;
  assert.equal(chooseAutomaticDetailConfidence(primary, detail, width, height,
    { x: .4, y: .5 }).automaticDetailApplied, false);
  detail.fill(1);
  assert.equal(chooseAutomaticDetailConfidence(new Float32Array(width * height), detail,
    width, height, { x: .4, y: .5 }).automaticDetailApplied, false);
});

test("prompt planner emits only validated, state-bound recipes", () => {
  const context = { documentId: "7", stateId: "9", revision: 11,
    foregroundColor: "#aabbcc", exportFormat: "png" };
  const plan = planPrompt("Выдели человека и скопируй", context);
  assert.equal(plan.plannerId, ACTION_PLAN_PLANNER);
  assert.deepEqual(plan.steps.map((step) => step.action), ["select-object", "copy-selection-to-layer"]);
  assert.equal(validateActionPlan(plan, context), plan);
  assert.match(actionPlanSummary(plan)[0], /needs a canvas prompt/);
  assert.throws(() => validateActionPlan({ ...plan, steps: [{ action: "run-javascript" }] }, context), /forbidden/);
  assert.throws(() => validateActionPlan(plan, { ...context, revision: 12 }), /stale/);
  assert.throws(() => validateActionPlan({ ...plan, unexpected: true }, context), /unsupported field/);
  assert.equal(new DeterministicPlannerAdapter().plan("copy object", context).version, 1);
});

test("RU and EN recipes cover background, geometry, fill and export safely", () => {
  const context = { documentId: "7", stateId: "9", revision: 11,
    foregroundColor: "#aabbcc", exportFormat: "webp", exportFilename: "result" };
  const cases = [
    ["Удали фон", ["select-object", "invert-selection", "cut-selection"]],
    ["Сделай маску объекта", ["select-object", "mask-selection"]],
    ["Blur background radius 7", ["select-object", "invert-selection", "filter-selection"]],
    ["Обесцветь фон", ["select-object", "invert-selection", "filter-selection"]],
    ["Darken background 30", ["select-object", "invert-selection", "filter-selection"]],
    ["Залей объект цветом", ["select-object", "fill-selection"]],
    ["Crop object with padding 12", ["select-object", "crop-selection"]],
    ["Resize 640x480 and export", ["resize-document", "export-document"]],
  ];
  for (const [prompt, actions] of cases) {
    const plan = planPrompt(prompt, context);
    assert.deepEqual(plan.steps.map((step) => step.action), actions, prompt);
    assert.equal(validateActionPlan(plan, context), plan);
  }
  const removeBackground = planPrompt("Удали фон", context);
  assert.deepEqual(removeBackground.steps[0], { action: "select-object", requiresInput: false,
    source: "visible", autoTarget: "center" });
  assert.match(actionPlanSummary(removeBackground)[0], /automatic subject/);
  const reuseSelection = planPrompt("Удали фон", { ...context, hasSelection: true });
  assert.deepEqual(reuseSelection.steps.map((step) => step.action),
    ["invert-selection", "cut-selection"]);
  assert.throws(() => validateActionPlan({ ...removeBackground,
    steps: [{ action: "select-object", requiresInput: false, source: "visible" }] }, context),
  /bounded canvas or automatic subject/);
  assert.throws(() => planPrompt("нарисуй космический корабль", context),
    (error) => error instanceof ActionPlanClarificationError && error.code === "CLARIFICATION_REQUIRED");
  assert.throws(() => planPrompt("resize document", context), /Specify resize dimensions/);
});
