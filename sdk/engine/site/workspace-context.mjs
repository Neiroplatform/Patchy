const descriptor = (family, label, controls = [], target = "document", interaction = "") =>
  ({ family, label, controls, target, interaction });

const contexts = {
  move: descriptor("transform", "Move layer", ["cancelTransformButton", "applyTransformButton"], "document",
    "Drag the selected layer on the canvas; release commits one move."),
  crop: descriptor("transform", "Crop document", ["cropRatioInput", "cancelCropButton", "applyCropButton"], "document",
    "Drag a crop frame, adjust its handles, then Apply or press Enter; Cancel or Escape preserves the document."),
  marquee: descriptor("selection", "Rectangular selection", ["selectionModeInput", "selectionQuickFeatherInput"], "document",
    "Drag a rectangle on the canvas; release commits the selection."),
  lasso: descriptor("selection", "Freehand lasso", ["selectionModeInput", "selectionQuickFeatherInput"], "document",
    "Drag around an area; release closes and commits the freehand selection."),
  polygon: descriptor("selection", "Polygonal lasso", ["selectionModeInput", "selectionQuickFeatherInput"], "document",
    "Click corner points, then press Enter or double-click to commit; Escape cancels the draft."),
  magic: descriptor("selection", "Magic Wand", ["selectionModeInput", "selectionQuickFeatherInput",
    "selectionToleranceInput", "wandContiguousInput", "wandSampleAllInput"], "document",
    "Click a color to select matching pixels. Contiguous limits the result to the connected region; Sample all layers uses the visible composite."),
  quickSelect: descriptor("selection", "Quick Select", ["brushSizeInput", "selectionToleranceInput", "edgeContrastInput", "enhanceEdgeInput"], "document",
    "Drag over the subject to grow the selection; hold Alt to subtract."),
  magnetic: descriptor("selection", "Magnetic Lasso", ["selectionModeInput", "selectionQuickFeatherInput", "edgeContrastInput"], "document",
    "Click edge anchors, then press Enter or double-click to close; Escape cancels the draft."),
  quickMask: descriptor("selection", "Quick Mask", ["brushSizeInput"], "selection-mask",
    "Drag to paint the selection mask; hold Alt to remove mask coverage."),
  pan: descriptor("navigation", "Pan canvas", [], "document",
    "Drag the workspace to pan without changing document pixels."),
  brush: descriptor("paint", "Brush", ["brushPresetSelect", "brushSizeInput", "brushSoftnessInput",
    "brushOpacityInput", "brushColorInput", "paintTargetSelect", "brushSettingsButton"], "layer-or-mask",
    "Drag to paint the selected pixel layer or mask; an empty document creates its first paint layer."),
  eraser: descriptor("paint", "Eraser", ["brushPresetSelect", "brushSizeInput", "brushSoftnessInput",
    "brushOpacityInput", "paintTargetSelect"], "layer-or-mask",
    "Drag to erase the selected pixel layer or reveal its mask."),
  mixer: descriptor("paint", "Mixer Brush", ["brushSizeInput", "advancedPaintSoftnessInput", "advancedPaintFlowInput",
    "mixerWetInput", "mixerLoadInput", "mixerMixInput", "mixerSampleAllInput"], "layer",
    "Drag on a selected pixel layer to mix loaded color with existing pixels; release commits once."),
  patternStamp: descriptor("paint", "Pattern Stamp", ["brushSizeInput", "brushColorInput", "advancedPaintSoftnessInput",
    "advancedPaintFlowInput", "advancedPatternInput", "advancedPatternSizeInput", "advancedPatternSecondaryInput",
    "advancedPatternAlignedInput"], "layer",
    "Drag on a selected pixel layer to stamp the chosen local pattern; release commits once."),
  clone: descriptor("retouch", "Clone stamp", ["brushSizeInput"], "layer",
    "Alt-click to set a source, then drag on the selected pixel layer to clone it."),
  heal: descriptor("retouch", "Healing brush", ["brushSizeInput"], "layer",
    "Alt-click to set a source, then drag to blend that source into the selected pixel layer."),
  spotHealing: descriptor("retouch", "Spot Healing Brush", ["brushSizeInput", "retouchSoftnessInput", "retouchSampleAllInput"], "layer",
    "Drag over an imperfection; release computes and commits one repair."),
  patch: descriptor("retouch", "Patch Tool", ["patchModeInput", "retouchSampleAllInput", "patchTransparentInput"], "selection",
    "Create a selection first, then drag it between source and destination; release commits the repair."),
  smudge: descriptor("tone", "Smudge Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput"], "layer",
    "Drag on a selected pixel layer to push nearby color; release commits once."),
  blur: descriptor("tone", "Blur Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput"], "layer",
    "Drag on a selected pixel layer to soften local detail; release commits once."),
  sharpen: descriptor("tone", "Sharpen Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput"], "layer",
    "Drag on a selected pixel layer to increase local contrast; release commits once."),
  dodge: descriptor("tone", "Dodge Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput",
    "localToneRangeInput", "localProtectTonesInput"], "layer",
    "Drag on a selected pixel layer to lighten the chosen tonal range; release commits once."),
  burn: descriptor("tone", "Burn Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput",
    "localToneRangeInput", "localProtectTonesInput"], "layer",
    "Drag on a selected pixel layer to darken the chosen tonal range; release commits once."),
  sponge: descriptor("tone", "Sponge Brush", ["brushSizeInput", "localBrushSoftnessInput", "localBrushStrengthInput",
    "localSpongeModeInput", "localSpongeVibranceInput"], "layer",
    "Drag on a selected pixel layer to change local saturation; release commits once."),
  gradient: descriptor("fill", "Gradient", ["paintPresetSelect", "gradientTypeInput", "gradientStopInput",
    "gradientStopColorInput", "gradientStopOpacityInput", "addGradientStopButton", "removeGradientStopButton",
    "cancelGradientButton", "applyGradientButton"], "layer-or-mask",
    "Drag from the first point to the second, edit colour and opacity stops, then Apply; Escape cancels the draft."),
  fill: descriptor("fill", "Fill selection", ["brushColorInput", "paintTargetSelect", "paintPresetSelect"], "layer-or-mask",
    "Select the tool, configure it, then click the canvas. A current selection is filled; otherwise the clicked colour region is selected and filled."),
  eyedropper: descriptor("sample", "Eyedropper", [], "document",
    "Click the visible composite to set the foreground colour. Painting tools can temporarily sample with Alt-click."),
  pen: descriptor("draw", "Pen path", ["cancelPenPathButton", "finishPenPathButton", "closePenPathButton",
    "makePenSelectionButton"], "path",
    "Click anchors while the dotted rubber band previews the next segment. Click the first anchor to close the path, then make a selection, fill, stroke or vector mask."),
  shape: descriptor("draw", "Shape", ["shapeToolKindInput", "shapeToolFillInput",
    "shapeToolStrokeInput", "shapeToolStrokeWidthInput", "shapeToolSidesInput"], "shape-layer",
    "Drag on the canvas to create a vector rectangle, ellipse, line, polygon or star. Hold Shift to constrain proportions."),
  text: descriptor("draw", "Text", ["textToolFontInput", "textToolStyleInput", "textToolSizeInput",
    "textToolColorInput", "textToolAlignmentInput", "textSettingsButton", "paragraphSettingsButton"], "text-layer",
    "Click to type directly at that point, or drag a paragraph box. Text uses the current Character and Paragraph settings; Ctrl+Enter commits and Escape cancels."),
};

export const WORKSPACE_TOOL_CONTEXTS = Object.freeze(Object.fromEntries(
  Object.entries(contexts).map(([tool, value]) => [tool, Object.freeze({
    ...value, controls: Object.freeze([...value.controls]),
  })])));

export const WORKSPACE_OPTION_CONTROL_IDS = Object.freeze([...new Set(
  Object.values(WORKSPACE_TOOL_CONTEXTS).flatMap(({ controls }) => controls))]);

export const WORKSPACE_TOOL_BUTTONS = Object.freeze({
  move: "moveToolButton", crop: "cropToolButton", marquee: "marqueeToolButton",
  lasso: "lassoToolButton", polygon: "polygonToolButton", magic: "magicToolButton",
  quickSelect: "quickSelectToolButton", magnetic: "magneticToolButton",
  quickMask: "quickMaskToolButton", pan: "panToolButton", brush: "brushToolButton",
  mixer: "mixerToolButton", patternStamp: "patternStampToolButton",
  eraser: "eraserToolButton", clone: "cloneToolButton", heal: "healToolButton",
  spotHealing: "spotHealingToolButton", patch: "patchToolButton",
  smudge: "smudgeToolButton", blur: "blurToolButton", sharpen: "sharpenToolButton",
  dodge: "dodgeToolButton", burn: "burnToolButton", sponge: "spongeToolButton",
  gradient: "gradientToolButton", fill: "fillToolButton", pen: "penToolButton",
  eyedropper: "eyedropperToolButton", shape: "shapeToolButton", text: "textToolButton",
});

export function workspaceContextForTool(tool) {
  return WORKSPACE_TOOL_CONTEXTS[tool] || WORKSPACE_TOOL_CONTEXTS.marquee;
}

export function installWorkspaceContext(document, { translate = (value) => value } = {}) {
  const toolbar = document.getElementById("toolOptions");
  const label = document.getElementById("activeToolContext");
  const instruction = document.getElementById("toolInstruction");
  if (!toolbar || !label || !instruction) return null;
  const optionNodes = new Map();
  let currentTool = "marquee";
  for (const id of WORKSPACE_OPTION_CONTROL_IDS) {
    const control = document.getElementById(id);
    const node = control?.closest("label, .direct-operation-actions, .tool-option-button");
    if (!node) continue;
    node.dataset.toolOption = id;
    optionNodes.set(id, node);
  }
  const renderButtonContracts = () => {
    for (const [tool, buttonId] of Object.entries(WORKSPACE_TOOL_BUTTONS)) {
      const button = document.getElementById(buttonId);
      const context = WORKSPACE_TOOL_CONTEXTS[tool];
      if (!button || !context) continue;
      button.dataset.toolContract = tool;
      button.setAttribute("aria-description", translate(context.interaction));
    }
  };
  renderButtonContracts();
  const render = (tool) => {
    currentTool = tool;
    const descriptor = workspaceContextForTool(tool);
    const visible = new Set(descriptor.controls);
    label.textContent = translate(descriptor.label);
    instruction.textContent = translate(descriptor.interaction);
    toolbar.setAttribute("aria-label", `${translate(descriptor.label)} · ${translate("Tool options")}`);
    toolbar.setAttribute("aria-description", translate(descriptor.interaction));
    toolbar.dataset.tool = tool;
    for (const [id, node] of optionNodes) node.hidden = !visible.has(id);
    toolbar.dataset.empty = "false";
    return descriptor;
  };
  document.addEventListener("patchy:localechange", () => {
    renderButtonContracts();
    render(currentTool);
  });
  return { render };
}
