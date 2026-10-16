export const ACTION_PLAN_VERSION = 1;
export const ACTION_PLAN_PLANNER = "patchy.local-recipes.v1";
export const ACTION_IDS = Object.freeze([
  "select-object", "invert-selection", "copy-selection", "cut-selection",
  "copy-selection-to-layer", "isolate-selection", "mask-selection", "fill-selection",
  "filter-selection", "crop-selection", "resize-document",
  "clear-selection", "export-document",
]);
const ACTIONS = new Set(ACTION_IDS);
const PLAN_KEYS = new Set(["version", "plannerId", "prompt", "summary", "expectedEffect",
  "modelCost", "warnings", "outputs", "confirmation", "document", "steps"]);
const DOCUMENT_KEYS = new Set(["documentId", "stateId", "revision"]);
const MODEL_COST_KEYS = new Set(["downloadBytes", "memoryClass", "execution"]);
const FILTERS = new Set([
  "patchy.filters.gaussian_blur", "patchy.filters.grayscale",
  "patchy.filters.brightness_contrast",
]);
const STEP_KEYS = Object.freeze({
  "select-object": ["action", "requiresInput", "source", "autoTarget"],
  "invert-selection": ["action"],
  "copy-selection": ["action"],
  "copy-selection-to-layer": ["action", "name"],
  "isolate-selection": ["action", "name"],
  "cut-selection": ["action"],
  "mask-selection": ["action"],
  "fill-selection": ["action", "color"],
  "filter-selection": ["action", "filterId", "parameters"],
  "crop-selection": ["action", "padding"],
  "resize-document": ["action", "width", "height"],
  "clear-selection": ["action"],
  "export-document": ["action", "format", "filename"],
});
const FILTER_PARAMETER_RULES = Object.freeze({
  "patchy.filters.gaussian_blur": { radius: ["integer", 1, 12] },
  "patchy.filters.grayscale": { amount: ["integer", 0, 100] },
  "patchy.filters.brightness_contrast": {
    brightness: ["integer", -100, 100], contrast: ["integer", -100, 100],
  },
});

export class ActionPlanClarificationError extends Error {
  constructor(message) { super(message); this.name = "ActionPlanClarificationError";
    this.code = "CLARIFICATION_REQUIRED"; }
}

const includesAny = (text, words) => words.some((word) => text.includes(word));

function boundedInteger(text, expression, fallback, minimum, maximum) {
  const match = text.match(expression);
  const value = match ? Number(match[1]) : fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function objectStep(source = "visible", autoTarget = null) {
  return { action: "select-object", requiresInput: !autoTarget, source,
    ...(autoTarget ? { autoTarget } : {}) };
}

function filterStep(filterId, parameters) {
  return { action: "filter-selection", filterId, parameters };
}

export function planPrompt(prompt, context = {}) {
  const text = String(prompt || "").trim().toLocaleLowerCase();
  if (!text) throw new Error("Describe the edit first.");
  const steps = [];
  const mentionsObject = includesAny(text,
    ["объект", "человек", "предмет", "субъект", "subject", "object", "person"]);
  const mentionsBackground = includesAny(text, ["фон", "background"]);
  const removesBackground = mentionsBackground && includesAny(text,
    ["удал", "убер", "remove", "delete"]);
  const explicitlyUsesSelection = includesAny(text,
    ["по выделению", "вокруг выделения", "из выделения", "selected area", "selection", "selected object"]);
  const mutatesSelection = mentionsObject || mentionsBackground;
  const needsFreshSubject = removesBackground && !explicitlyUsesSelection;
  if (mutatesSelection && (!context.hasSelection || needsFreshSubject)) steps.push(objectStep(
    context.objectSource || "visible", mentionsBackground ? "center" : null));

  if (mutatesSelection && includesAny(text, ["маск", "mask"])) {
    steps.push({ action: "mask-selection" });
  } else if (removesBackground) {
    steps.push({ action: "isolate-selection", name: "Background removed" });
  } else if (mentionsBackground && includesAny(text, ["размыт", "блюр", "blur"])) {
    const radius = boundedInteger(text, /(?:radius|радиус|blur|размыт\S*)\s*(\d+)/u, 8, 1, 12);
    steps.push({ action: "invert-selection" }, filterStep("patchy.filters.gaussian_blur",
      [{ key: "radius", kind: "integer", value: radius }]));
  } else if (mentionsBackground && includesAny(text,
    ["обесцвет", "чёрно-бел", "черно-бел", "grayscale", "desaturat"])) {
    steps.push({ action: "invert-selection" }, filterStep("patchy.filters.grayscale",
      [{ key: "amount", kind: "integer", value: 100 }]));
  } else if (mentionsBackground && includesAny(text, ["затемн", "darken"])) {
    const brightness = -boundedInteger(text, /(?:затемн\S*|darken)\s*(\d+)/u, 25, 1, 100);
    steps.push({ action: "invert-selection" }, filterStep("patchy.filters.brightness_contrast",
      [{ key: "brightness", kind: "integer", value: brightness },
        { key: "contrast", kind: "integer", value: 0 }]));
  } else if (includesAny(text, ["копир", "copy"]) && mutatesSelection) {
    steps.push({ action: "copy-selection-to-layer", name: "Selected object" });
  } else if (includesAny(text, ["копир", "copy"])) {
    steps.push({ action: "copy-selection" });
  } else if (includesAny(text, ["выреж", "cut"])) {
    steps.push({ action: "cut-selection" });
  } else if (includesAny(text, ["зал", "fill", "перекрас", "цвет", "color"])) {
    steps.push({ action: "fill-selection", color: context.foregroundColor || "#111111" });
  }

  if (includesAny(text, ["обреж", "кадрир", "crop"])) {
    const padding = boundedInteger(text, /(?:padding|отступ)\s*(\d+)/u, 0, 0, 4096);
    steps.push({ action: "crop-selection", padding });
  }
  const dimensions = text.match(/(?:размер|resize)?\s*(\d{1,6})\s*[xх×]\s*(\d{1,6})/u);
  if (dimensions) steps.push({ action: "resize-document",
    width: Number(dimensions[1]), height: Number(dimensions[2]) });
  else if (includesAny(text, ["resize", "изменить размер", "измени размер"])) {
    throw new ActionPlanClarificationError("Specify resize dimensions, for example 1920 × 1080.");
  }
  if (includesAny(text, ["экспорт", "скача", "export", "download"]))
    steps.push({ action: "export-document", format: context.exportFormat || "png",
      filename: String(context.exportFilename || "edited") });
  if (!steps.length) throw new ActionPlanClarificationError(
    "This local harness needs a supported target and action. Try ‘blur background’ or ‘fill selected object’."
  );
  return { version: ACTION_PLAN_VERSION, plannerId: ACTION_PLAN_PLANNER,
    prompt: String(prompt).trim(),
    summary: `Run ${steps.length} bounded local action${steps.length === 1 ? "" : "s"}`,
    expectedEffect: steps.map((step) => step.action).join(" → "),
    modelCost: { downloadBytes: steps.some((step) => step.action === "select-object") ? 30525312 : 0,
      memoryClass: steps.some((step) => step.action === "select-object") ? "large" : "none",
      execution: "local-only" },
    warnings: steps.some((step) => ["cut-selection", "isolate-selection", "crop-selection",
      "resize-document"].includes(step.action))
      ? ["This plan changes document pixels or geometry. One Undo restores the complete plan."] : [],
    outputs: steps.filter((step) => step.action === "export-document")
      .map((step) => `${step.filename}.${step.format === "jpeg" ? "jpg" : step.format}`),
    confirmation: "document-mutation",
    document: { documentId: String(context.documentId || ""), stateId: String(context.stateId || ""),
      revision: Number(context.revision || 0) }, steps };
}

export function validateActionPlan(plan, context = {}) {
  if (!plan || plan.version !== ACTION_PLAN_VERSION || !Array.isArray(plan.steps) || !plan.steps.length)
    throw new Error("Invalid action plan.");
  if (Object.keys(plan).some((key) => !PLAN_KEYS.has(key)) ||
      Object.keys(plan.document || {}).some((key) => !DOCUMENT_KEYS.has(key)) ||
      Object.keys(plan.modelCost || {}).some((key) => !MODEL_COST_KEYS.has(key))) {
    throw new Error("Action plan contains an unsupported field.");
  }
  if (plan.plannerId !== ACTION_PLAN_PLANNER || plan.confirmation !== "document-mutation" ||
      typeof plan.prompt !== "string" || !plan.prompt.trim() || plan.prompt.length > 2000 ||
      typeof plan.summary !== "string" || !plan.summary || plan.summary.length > 256 ||
      typeof plan.expectedEffect !== "string" || !plan.expectedEffect || plan.expectedEffect.length > 512 ||
      !plan.modelCost || !Number.isSafeInteger(plan.modelCost.downloadBytes) || plan.modelCost.downloadBytes < 0 ||
      !["none", "large"].includes(plan.modelCost.memoryClass) || plan.modelCost.execution !== "local-only" ||
      !Array.isArray(plan.warnings) || plan.warnings.length > 8 ||
      plan.warnings.some((value) => typeof value !== "string" || value.length > 512) ||
      !Array.isArray(plan.outputs) || plan.outputs.length > 8 ||
      plan.outputs.some((value) => typeof value !== "string" || value.length > 256)) {
    throw new Error("Action plan metadata is invalid.");
  }
  if (plan.steps.length > 8) throw new Error("Action plan is too long.");
  if (String(plan.document?.documentId) !== String(context.documentId) ||
      String(plan.document?.stateId) !== String(context.stateId) ||
      Number(plan.document?.revision) !== Number(context.revision)) throw new Error("Action plan is stale.");
  for (const step of plan.steps) {
    if (!step || !ACTIONS.has(step.action)) throw new Error("Action plan contains a forbidden action.");
    const keys = Object.keys(step);
    if (keys.some((key) => !STEP_KEYS[step.action].includes(key)))
      throw new Error("Action plan contains an unsupported parameter.");
    if (step.action === "select-object") {
      const manual = step.requiresInput === true && step.autoTarget === undefined;
      const automatic = step.requiresInput === false && step.autoTarget === "center";
      if ((!manual && !automatic) || !["active", "visible"].includes(step.source))
        throw new Error("Object selection requires a bounded canvas or automatic subject prompt.");
    }
    if (step.action === "fill-selection" && !/^#[0-9a-f]{6}$/i.test(step.color || ""))
      throw new Error("Fill color is invalid.");
    if (step.action === "filter-selection" &&
        (!FILTERS.has(step.filterId) || !Array.isArray(step.parameters) || step.parameters.length > 8 ||
          step.parameters.some((parameter) => !parameter ||
            Object.keys(parameter).some((key) => !["key", "kind", "value"].includes(key)) ||
            !["integer", "double", "boolean", "option"].includes(parameter.kind))))
      throw new Error("Filter parameters are invalid.");
    if (step.action === "filter-selection") {
      const rules = FILTER_PARAMETER_RULES[step.filterId];
      const seen = new Set();
      for (const parameter of step.parameters) {
        const rule = rules?.[parameter.key];
        if (!rule || seen.has(parameter.key) || parameter.kind !== rule[0] ||
            !Number.isSafeInteger(parameter.value) || parameter.value < rule[1] || parameter.value > rule[2]) {
          throw new Error("Filter parameters are outside the bounded recipe contract.");
        }
        seen.add(parameter.key);
      }
      if (seen.size !== Object.keys(rules).length) throw new Error("Filter parameters are incomplete.");
    }
    if (step.action === "crop-selection" &&
        (!Number.isSafeInteger(step.padding) || step.padding < 0 || step.padding > 4096))
      throw new Error("Crop padding is invalid.");
    if (step.action === "resize-document" &&
        (![step.width, step.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 30000) ||
          step.width * step.height > 268435456))
      throw new Error("Resize dimensions are invalid.");
    if (step.action === "copy-selection-to-layer" &&
        (typeof step.name !== "string" || !step.name.trim() || step.name.length > 128))
      throw new Error("Output layer name is invalid.");
    if (step.action === "isolate-selection" &&
        (typeof step.name !== "string" || !step.name.trim() || step.name.length > 128))
      throw new Error("Output layer name is invalid.");
    if (step.action === "export-document" && !["png", "jpeg", "webp", "svg"].includes(step.format))
      throw new Error("Export format is invalid.");
    if (step.action === "export-document" &&
        (!/^[^/\\\0]{1,128}$/.test(step.filename || "") || step.filename === "." || step.filename === ".."))
      throw new Error("Export filename is invalid.");
  }
  return plan;
}

export class DeterministicPlannerAdapter {
  plan(prompt, context) { return planPrompt(prompt, context); }
}

export function actionPlanSummary(plan) {
  return plan.steps.map((step, index) => `${index + 1}. ${step.action}${step.requiresInput ? " · needs a canvas prompt" :
    step.autoTarget ? " · automatic subject" : ""}${
    step.filterId ? ` · ${step.filterId}` : ""}${step.format ? ` · ${step.format}` : ""}`);
}
