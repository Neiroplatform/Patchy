import assert from "node:assert/strict";
import test from "node:test";
import { OBJECT_SEGMENTATION_MODEL, OBJECT_SEGMENTATION_RUNTIME, ObjectSegmentationClient,
  clickPromptStroke, normalizedPromptPoint, proposalMatchesSnapshot, rectanglePromptStroke,
  scaleConfidenceMask, combineSelectionMasks, objectSegmentationDelegate,
  objectSelectionIdentityMatches } from "../../sdk/engine/site/object-segmentation.mjs";
import { ACTION_PLAN_PLANNER, ActionPlanClarificationError, DeterministicPlannerAdapter,
  actionPlanSummary, planPrompt, validateActionPlan } from "../../sdk/engine/site/action-harness.mjs";
import { installSameOriginFetch } from "../../sdk/engine/site/ml-network-policy.mjs";

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
});

test("object inference rejects software WebGL delegates before model initialization", () => {
  assert.equal(objectSegmentationDelegate("ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Ultra)"), "gpu");
  assert.equal(objectSegmentationDelegate("ANGLE (Google, Vulkan 1.3 (SwiftShader Device))"), "wasm");
  assert.equal(objectSegmentationDelegate("Microsoft Basic Render Driver"), "wasm");
  assert.equal(objectSegmentationDelegate("llvmpipe (LLVM 18.1.8)"), "wasm");
  assert.equal(objectSegmentationDelegate(""), "wasm");
});

test("inference Worker fetch policy permits same-origin assets and blocks telemetry origins", async () => {
  const calls = []; const stored = new Map(); let online = true;
  const scope = { location: { href: "https://editor.test/runtime/worker.mjs" },
    caches: { async open() { return { async match(key) { return stored.get(key); },
      async put(key, response) { stored.set(key, response); } }; } },
    fetch(input) { calls.push(String(input));
      return online ? Promise.resolve(new Response("model")) : Promise.reject(new Error("offline")); } };
  const restore = installSameOriginFetch(scope, { cacheName: "patchy-ml-test" });
  assert.equal(await (await scope.fetch("./model.task")).text(), "model");
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
  assert.equal(client.timeouts.setImage, 120_000);
  assert.equal(client.timeouts.segment, 15_000);
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

test("object proposals combine through replace, add, subtract and intersect coverage", () => {
  const current = new Uint8Array([0, 64, 128, 255]);
  const proposed = new Uint8Array([255, 128, 64, 0]);
  assert.deepEqual([...combineSelectionMasks(current, proposed, "replace")], [255, 128, 64, 0]);
  assert.deepEqual([...combineSelectionMasks(current, proposed, "add")], [255, 128, 128, 255]);
  assert.deepEqual([...combineSelectionMasks(current, proposed, "subtract")], [0, 32, 96, 255]);
  assert.deepEqual([...combineSelectionMasks(current, proposed, "intersect")], [0, 64, 64, 0]);
  assert.throws(() => combineSelectionMasks(current, new Uint8Array(2), "add"), /equal/);
});

test("point and box prompts are normalized and bounded", () => {
  assert.deepEqual(normalizedPromptPoint({ x: -2, y: 200 }, 100, 100), { x: 0, y: 1 });
  assert.deepEqual(clickPromptStroke({ x: 50, y: 50 }, 100, 100),
    [{ x: .46, y: .5 }, { x: .48, y: .5 }, { x: .5, y: .5 },
      { x: .52, y: .5 }, { x: .54, y: .5 }]);
  const box = rectanglePromptStroke({ x: 80, y: 70 }, { x: 20, y: 10 }, 100, 100);
  assert.equal(box.length, 5); assert.deepEqual(box[0], { x: .2, y: .1 });
  assert.deepEqual(box.at(-1), box[0]);
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
  assert.throws(() => planPrompt("нарисуй космический корабль", context),
    (error) => error instanceof ActionPlanClarificationError && error.code === "CLARIFICATION_REQUIRED");
  assert.throws(() => planPrompt("resize document", context), /Specify resize dimensions/);
});
