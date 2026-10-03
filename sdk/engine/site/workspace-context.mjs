const descriptor = (family, label, controls = [], target = "document") => ({ family, label, controls, target });

const contexts = {
  move: descriptor("transform", "Move layer", ["cancelTransformButton", "applyTransformButton"]),
  crop: descriptor("transform", "Crop document", ["cropRatioInput", "cancelCropButton", "applyCropButton"]),
  marquee: descriptor("selection", "Rectangular selection", ["selectionModeInput", "selectionQuickFeatherInput"]),
  lasso: descriptor("selection", "Freehand lasso", ["selectionModeInput", "selectionQuickFeatherInput"]),
  polygon: descriptor("selection", "Polygonal lasso", ["selectionModeInput", "selectionQuickFeatherInput"]),
  magic: descriptor("selection", "Magic selection", ["selectionModeInput", "selectionQuickFeatherInput", "selectionToleranceInput", "edgeContrastInput", "enhanceEdgeInput"]),
  quickSelect: descriptor("selection", "Quick Select", ["brushSizeInput", "selectionToleranceInput", "edgeContrastInput", "enhanceEdgeInput"]),
  magnetic: descriptor("selection", "Magnetic Lasso", ["selectionModeInput", "selectionQuickFeatherInput", "edgeContrastInput"]),
  quickMask: descriptor("selection", "Quick Mask", ["brushSizeInput"], "selection-mask"),
  pan: descriptor("navigation", "Pan canvas"),
  brush: descriptor("paint", "Brush", ["brushSizeInput", "brushColorInput", "paintTargetSelect"], "layer-or-mask"),
  eraser: descriptor("paint", "Eraser", ["brushSizeInput", "paintTargetSelect"], "layer-or-mask"),
  mixer: descriptor("paint", "Mixer Brush", ["brushSizeInput", "advancedPaintSoftnessInput", "advancedPaintFlowInput",
    "mixerWetInput", "mixerLoadInput", "mixerMixInput", "mixerSampleAllInput"], "layer"),
  patternStamp: descriptor("paint", "Pattern Stamp", ["brushSizeInput", "brushColorInput", "advancedPaintSoftnessInput",
    "advancedPaintFlowInput", "advancedPatternInput", "advancedPatternSizeInput", "advancedPatternSecondaryInput",
    "advancedPatternAlignedInput"], "layer"),
  clone: descriptor("retouch", "Clone stamp", ["brushSizeInput"], "layer"),
  heal: descriptor("retouch", "Healing brush", ["brushSizeInput"], "layer"),
  spotHealing: descriptor("retouch", "Spot Healing Brush", ["brushSizeInput", "retouchSoftnessInput", "retouchSampleAllInput"], "layer"),
  patch: descriptor("retouch", "Patch Tool", ["patchModeInput", "retouchSampleAllInput", "patchTransparentInput"], "selection"),
  smudge: descriptor("tone", "Smudge Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput"], "layer"),
  blur: descriptor("tone", "Blur Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput"], "layer"),
  sharpen: descriptor("tone", "Sharpen Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput"], "layer"),
  dodge: descriptor("tone", "Dodge Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput",
    "localToneRangeInput", "localProtectTonesInput"], "layer"),
  burn: descriptor("tone", "Burn Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput",
    "localToneRangeInput", "localProtectTonesInput"], "layer"),
  sponge: descriptor("tone", "Sponge Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput",
    "localSpongeModeInput", "localSpongeVibranceInput"], "layer"),
  gradient: descriptor("fill", "Gradient", ["brushColorInput", "paintTargetSelect", "paintPresetSelect"], "layer-or-mask"),
  fill: descriptor("fill", "Fill selection", ["brushColorInput", "paintTargetSelect", "paintPresetSelect"], "layer-or-mask"),
  pen: descriptor("draw", "Pen path", [], "path"),
  text: descriptor("draw", "Text", [], "text-layer"),
};

export const WORKSPACE_TOOL_CONTEXTS = Object.freeze(Object.fromEntries(
  Object.entries(contexts).map(([tool, value]) => [tool, Object.freeze({
    ...value, controls: Object.freeze([...value.controls]),
  })])));

export const WORKSPACE_OPTION_CONTROL_IDS = Object.freeze([...new Set(
  Object.values(WORKSPACE_TOOL_CONTEXTS).flatMap(({ controls }) => controls))]);

export function workspaceContextForTool(tool) {
  return WORKSPACE_TOOL_CONTEXTS[tool] || WORKSPACE_TOOL_CONTEXTS.marquee;
}

export function installWorkspaceContext(document, { translate = (value) => value } = {}) {
  const toolbar = document.getElementById("toolOptions");
  const label = document.getElementById("activeToolContext");
  if (!toolbar || !label) return null;
  const optionNodes = new Map();
  for (const id of WORKSPACE_OPTION_CONTROL_IDS) {
    const control = document.getElementById(id);
    const node = control?.closest("label, .direct-operation-actions");
    if (!node) continue;
    node.dataset.toolOption = id;
    optionNodes.set(id, node);
  }
  const render = (tool) => {
    const descriptor = workspaceContextForTool(tool);
    const visible = new Set(descriptor.controls);
    label.textContent = translate(descriptor.label);
    toolbar.setAttribute("aria-label", `${translate(descriptor.label)} · ${translate("Tool options")}`);
    toolbar.dataset.tool = tool;
    for (const [id, node] of optionNodes) node.hidden = !visible.has(id);
    toolbar.dataset.empty = String(visible.size === 0);
    return descriptor;
  };
  return { render };
}
