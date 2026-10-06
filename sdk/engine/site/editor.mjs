import { PatchyWorkerClient } from "./engine/client.mjs";
import { applyRecoveredSelection, checkpointSelection,
  recoverWorkerSession } from "./engine/recovery-controller.mjs";
import { PatchyCheckpointQueue, PatchyWorkspaceStore } from "./engine/workspace-store.mjs";
import { BrowserDiagnosticRecorder, collectRuntimeProfile, DIAGNOSTIC_COMMAND_FAILED,
  recordDiagnosticCommand, serializeDiagnosticBundle } from "./engine/support-diagnostics.mjs";
import { browserWorkingSetLimit, chooseRenderRegion, cropGeometrySize,
  documentPreflight, geometryMutationPreflight, INT32_MAX, INT32_MIN, layeredGeometrySize, MIB,
  rotatedGeometrySize } from "./engine/memory-policy.mjs";
import { encodeFlatDocument } from "./engine/flat-export.mjs";
import { BrowserFileLifecycle } from "./engine/file-lifecycle.mjs";
import { guidePositionFromPointer, normalizeGuides, pointInGuideParentRuler,
  snapTranslatedQuad } from "./guide-model.mjs";
import { anchoredScrollDelta, clampScrollPosition, clampZoom, fitZoom,
  rulerTicks } from "./viewport-model.mjs";
import { applyParagraphStyleRange, justifiedSpaceAdvance } from "./text-layout.mjs";
import { chooseRovingLayerId, createLocalizer, installDialogFocusReturn, installRovingToolbar,
  isEditableTarget } from "./shell-ui.mjs";
import { starterDocumentRequest, starterPreset } from "./starter-model.mjs";
import { installCommandSurface } from "./command-surface.mjs";
import { installWorkspaceContext } from "./workspace-context.mjs";
import { openFileKind } from "./reference-workflow.mjs";

const $ = (id) => document.getElementById(id);
const shell = document.querySelector(".editor-shell");
const contextualEditorIds = ["textDialog", "shapeDialog", "adjustmentDialog"];
const propertiesPanel = $("workspacePanelProperties");
for (const id of contextualEditorIds) {
  const dialog = $(id);
  dialog.classList.add("context-editor-dialog");
  propertiesPanel.append(dialog);
  dialog.addEventListener("close", () => {
    if (propertiesPanel.dataset.contextEditor === id) delete propertiesPanel.dataset.contextEditor;
  });
}
const localizer = createLocalizer(document, document.documentElement.lang);
const diagnostics = new BrowserDiagnosticRecorder({ runtime: collectRuntimeProfile(globalThis) });
localizer.localize(document);
installDialogFocusReturn(document);
const commandSurface = installCommandSurface(document, { translate: (value) => localizer.text(value) });
const workspaceContext = installWorkspaceContext(document, { translate: (value) => localizer.text(value) });
const syncToolRoving = installRovingToolbar(document.querySelector(".tool-rail"), ".tool-button:not([hidden])");
const inspectorResizer = $("inspectorResizer");
const setInspectorWidth = (width) => document.documentElement.style.setProperty(
  "--inspector-width", `${Math.max(240, Math.min(480, Math.round(width)))}px`);
inspectorResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault(); inspectorResizer.setPointerCapture(event.pointerId);
  const move = (nextEvent) => setInspectorWidth(innerWidth - nextEvent.clientX);
  const finish = () => {
    inspectorResizer.removeEventListener("pointermove", move);
    inspectorResizer.removeEventListener("pointerup", finish);
    inspectorResizer.removeEventListener("pointercancel", finish);
  };
  inspectorResizer.addEventListener("pointermove", move);
  inspectorResizer.addEventListener("pointerup", finish);
  inspectorResizer.addEventListener("pointercancel", finish);
});
inspectorResizer.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--inspector-width")) || 316;
  setInspectorWidth(current + (event.key === "ArrowLeft" ? (event.shiftKey ? 40 : 10) : -(event.shiftKey ? 40 : 10)));
});
const moduleUrl = new URL("./patchy-engine.mjs", location.href).href;
let client = null;
let errorReturnFocus = null;
const workspaceStore = new PatchyWorkspaceStore();
const fileLifecycle = new BrowserFileLifecycle({ download: downloadBlob });
const canvas = $("documentCanvas");
const context = canvas.getContext("2d", { alpha: true });
let snapshot = null;
let selectedLayerId = null;
let selectedLayerIds = new Set();
let layerSelectionAnchorId = null;
let lastLayerActivation = { id: null, at: 0 };
let selectedChannelId = null;
let selectedPathId = null;
let documentName = "Untitled.psd";
let busy = false;
let busyPresentationTimer = 0;
let toastTimer = 0;
let dragDepth = 0;
let cancelActiveOperation = null;
let canvasTool = "marquee";
let zoomMode = "fit";
let zoom = 1;
const documentViewports = new Map();
let pendingViewportFrame = 0;
let pendingViewportAnchor = null;
let pendingPan = null;
let spacePanActive = false;
const viewportDiagnostics = { updates: 0, renderRequests: 0, samples: [],
  lastReason: "startup", trackedDocuments: 0 };
globalThis.__patchyViewportDiagnostics = viewportDiagnostics;
let guidesVisible = true;
let snappingEnabled = true;
const documentGuides = new Map();
let marqueeDraft = null;
let cropDraft = null;
let resizeAspectRatio = 1;
let panStart = null;
let moveDraft = null;
let transformDraft = null;
let transformDialogDraft = null;
let warpDialogDraft = null;
let liquifyDraft = null;
let liquifyPreviewGeneration = 0;
let liquifyPreviewTimer = 0;
let liquifyPreviewCancellation = null;
let transformPreviewPending = null;
let transformPreviewInFlight = false;
let transformPreviewGeneration = 0;
let transformPreviewRestore = null;
let transformPreviewCancellation = null;
let paintDraft = null;
let retouchDraft = null;
let localBrushDraft = null;
let advancedPaintDraft = null;
let rasterPreviewPending = null;
let rasterPreviewInFlight = false;
let rasterPreviewGeneration = 0;
let rasterPreviewRestore = null;
let rasterPreviewCancellation = null;
let textEditingId = null;
let textDialogRuns = [];
let textDialogParagraphRuns = [];
let textDialogOriginalValue = "";
let textDialogOriginalRuns = [];
let textDialogOriginalParagraphRuns = [];
let textDialogStyleDirty = false;
let textDialogParagraphDirty = false;
let cloneSource = null;
let gradientDraft = null;
let lassoDraft = null;
let polygonDraft = null;
let penDraft = null;
let penHoverPoint = null;
let quickSelectDraft = null;
let magneticDraft = null;
let quickMaskDraft = null;
let selectionRefinementDraft = null;
let selectionRefinementGeneration = 0;
let selectionRefinementPreviewTimer = 0;
let selectionRefinementCancellation = null;
let clipboardImageBlob = null;
let layerClipboard = null;
let pixelClipboard = null;
let pendingLayerAppearance = null;
let layerAppearanceTimer = 0;
let draggedLayer = null;
let workspaceAvailable = false;
let automaticRecoveryEnabled = false;
let recoveryPromise = null;
let preferenceTimer = null;
let assetLibrary = { version: 1, generation: 0, gradients: [], patterns: [], fonts: [] };
const loadedFontFaces = new Map();
let renderedDocument = null;
let frameTransport = "waiting";
let layerWindowFrame = 0;
const layerThumbnailCache = new Map();
const documentHistoryLabels = new Map();
const documentSaveFormats = new Map();
const LAYER_ROW_HEIGHT = 40;
const LAYER_OVERSCAN = 5;
const MAX_LAYER_THUMBNAILS = 256;
const workingSetLimit = browserWorkingSetLimit({
  heapLimitBytes: performance.memory?.jsHeapSizeLimit,
  deviceMemoryGiB: navigator.deviceMemory,
});
const workspaceIds = new Map();
const checkpointStates = new Map();
const checkpointQueues = new Map();
const knownWorkspaceIds = new Set();

const layerKinds = ["Pixels", "Group", "Adjustment", "Text", "Shape", "Smart object"];
const blendModes = new Set([0, 1, 2, 3, 4, 5, 6, 11, 27]);
const commandRegistry = new Map();

function createEngineClient() {
  diagnostics.recordWorkerState("starting");
  const next = new PatchyWorkerClient(new Worker(
    new URL("./engine/worker.mjs", import.meta.url), { type: "module", name: "patchy-engine" }));
  next.addStateListener((state) => {
    diagnostics.recordWorkerState(state);
    if (state === "crashed" && automaticRecoveryEnabled && client === next) {
      queueMicrotask(() => recoverEngineAfterCrash());
    }
  });
  return next;
}

function registerCommand(id, buttonId, run, enabled = () => true) {
  commandRegistry.set(id, { run, enabled, button: buttonId ? $(buttonId) : null });
}

function executeCommand(id) {
  const command = commandRegistry.get(id);
  if (!command || !command.enabled()) return;
  return recordDiagnosticCommand(diagnostics, id, command.run);
}

function syncCommands() {
  for (const command of commandRegistry.values()) {
    if (command.button) command.button.disabled = !command.enabled();
  }
}

function selectedLayer() {
  return snapshot?.layers.find((layer) => layer.id === selectedLayerId) || null;
}

function selectedLayers() {
  if (!snapshot) return [];
  return snapshot.layers.filter((layer) => selectedLayerIds.has(layer.id));
}

function canToggleLayerClipping(layer) {
  if (!snapshot || !layer || layer.kind === 1) return false;
  if (layer.clipped) return true;
  const siblings = snapshot.layers.filter((candidate) => candidate.parentId === layer.parentId);
  let index = siblings.findIndex((candidate) => candidate.id === layer.id);
  while (index > 0) {
    const candidate = siblings[index - 1];
    if (candidate.clipped && candidate.kind !== 1) { index--; continue; }
    return candidate.kind === 0;
  }
  return false;
}

function setSingleLayerSelection(layerId) {
  selectedLayerId = layerId ?? null;
  selectedLayerIds = layerId == null ? new Set() : new Set([layerId]);
  layerSelectionAnchorId = layerId ?? null;
}

function clearLayerSelection() { setSingleLayerSelection(null); }

function revealLayerProperties() {
  commandSurface?.workspacePanels?.activate($("workspacePanelPropertiesButton"));
}

function openContextEditor(dialogId) {
  revealLayerProperties();
  for (const id of contextualEditorIds) {
    const dialog = $(id);
    if (id !== dialogId && dialog.open) dialog.close("switch");
  }
  propertiesPanel.dataset.contextEditor = dialogId;
  const dialog = $(dialogId);
  if (!dialog.open) dialog.show();
  queueMicrotask(() => dialog.querySelector(
    "input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus());
}

function focusSelectedLayerRow() {
  if (selectedLayerId == null) return;
  const row = $("layerList").querySelector(`[data-layer-id="${String(selectedLayerId)}"] .layer-select-button`);
  row?.focus({ preventScroll: true });
}

function selectCreatedLayer(kind, operation) {
  const previous = new Set(snapshot?.layers.map((layer) => layer.id) || []);
  return async () => {
    const next = await operation();
    const created = [...(next?.layers || [])].reverse()
      .find((layer) => layer.kind === kind && !previous.has(layer.id));
    if (created) {
      setSingleLayerSelection(created.id);
      revealLayerProperties();
    }
    return next;
  };
}

function editSelectedLayerType() {
  const layer = selectedLayer();
  if (busy || !layer) return;
  revealLayerProperties();
  if (layer.kind === 2) openAdjustmentDialog();
  else if (layer.kind === 3) openTextDialog();
  else if (layer.kind === 4) openShapeDialog();
}

function selectedLayerIdsTopToBottom({ rootsOnly = false } = {}) {
  if (!snapshot) return [];
  const ordered = [...snapshot.layers].reverse()
    .filter((layer) => selectedLayerIds.has(layer.id));
  if (!rootsOnly) return ordered.map((layer) => layer.id);
  const byId = new Map(snapshot.layers.map((layer) => [layer.id, layer]));
  return ordered.filter((layer) => {
    let parentId = layer.parentId;
    while (parentId && parentId !== 0n) {
      if (selectedLayerIds.has(parentId)) return false;
      parentId = byId.get(parentId)?.parentId ?? 0n;
    }
    return true;
  }).map((layer) => layer.id);
}

function transformSelection() {
  if (!snapshot) return null;
  const layerIds = selectedLayerIdsTopToBottom({ rootsOnly: true });
  if (!layerIds.length || layerIds.length > 256) return null;
  const byId = new Map(snapshot.layers.map((layer) => [layer.id, layer]));
  const roots = new Set(layerIds);
  if (layerIds.some((id) => !byId.has(id))) return null;
  const belongsToForest = (layer) => {
    let current = layer;
    while (current) {
      if (roots.has(current.id)) return true;
      current = current.parentId && current.parentId !== 0n
        ? byId.get(current.parentId) : null;
    }
    return false;
  };
  const forest = snapshot.layers.filter(belongsToForest);
  if (forest.some((layer) => layer.kind === 1 &&
      (layer.vectorMask || (layer.mask && !layer.mask.linked)))) return null;
  const leaves = forest.filter((layer) => layer.kind !== 1);
  if (!leaves.length || leaves.length > 256 || leaves.some((layer) =>
    ![0, 3, 5].includes(layer.kind) || layer.bounds.width <= 0 ||
    layer.bounds.height <= 0 || layer.vectorMask ||
    (layer.mask && !layer.mask.linked))) return null;
  const left = Math.min(...leaves.map((layer) => layer.bounds.x));
  const top = Math.min(...leaves.map((layer) => layer.bounds.y));
  const right = Math.max(...leaves.map((layer) => layer.bounds.x + layer.bounds.width));
  const bottom = Math.max(...leaves.map((layer) => layer.bounds.y + layer.bounds.height));
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  if (Object.values(bounds).some((value) => !Number.isSafeInteger(value)) ||
      bounds.width <= 0 || bounds.height <= 0) return null;
  const primary = byId.get(layerIds[0]);
  return { layerIds, leaves, bounds, primary,
    stateId: snapshot.stateId, revision: snapshot.revision,
    batch: layerIds.length > 1 || primary?.kind === 1,
    hasText: leaves.some((layer) => layer.kind === 3) };
}

function selectLayerFromEvent(layer, event, displayLayers) {
  if (event.shiftKey && layerSelectionAnchorId != null) {
    const anchor = displayLayers.findIndex((item) => item.id === layerSelectionAnchorId);
    const target = displayLayers.findIndex((item) => item.id === layer.id);
    if (anchor >= 0 && target >= 0) {
      const [first, last] = anchor < target ? [anchor, target] : [target, anchor];
      selectedLayerIds = new Set(displayLayers.slice(first, last + 1).map((item) => item.id));
      selectedLayerId = layer.id;
      return;
    }
  }
  if (event.metaKey || event.ctrlKey) {
    const next = new Set(selectedLayerIds);
    if (next.has(layer.id) && next.size > 1) next.delete(layer.id);
    else next.add(layer.id);
    selectedLayerIds = next;
    selectedLayerId = next.has(layer.id) ? layer.id : [...next].at(-1) ?? null;
    layerSelectionAnchorId = selectedLayerId;
    return;
  }
  setSingleLayerSelection(layer.id);
}

function selectedChannel() { return snapshot?.channels.find((item) => item.id === selectedChannelId) || null; }
function selectedPath() { return snapshot?.paths.find((item) => item.id === selectedPathId) || null; }

function historyLabels(documentId = snapshot?.documentId) {
  if (documentId == null) return { undo: [], redo: [] };
  let labels = documentHistoryLabels.get(documentId);
  if (!labels) { labels = { undo: [], redo: [] }; documentHistoryLabels.set(documentId, labels); }
  return labels;
}

function reconcileHistoryLabels(projection, labels = historyLabels(projection?.documentId)) {
  const undoCount = projection?.memory?.undoStates || 0;
  const redoCount = projection?.memory?.redoStates || 0;
  if (labels.undo.length > undoCount) labels.undo.splice(0, labels.undo.length - undoCount);
  while (labels.undo.length < undoCount) labels.undo.unshift("Earlier edit");
  if (labels.redo.length > redoCount) labels.redo.splice(0, labels.redo.length - redoCount);
  while (labels.redo.length < redoCount) labels.redo.unshift("Later edit");
  return labels;
}

function recordHistoryMutation(before, after, title) {
  if (!after || (before?.documentId === after.documentId && before.revision === after.revision)) return;
  const labels = historyLabels(after.documentId);
  labels.undo.push(title); labels.redo.length = 0;
  reconcileHistoryLabels(after, labels);
}

function recordHistoryTravel(before, after, steps) {
  const labels = historyLabels(after.documentId);
  reconcileHistoryLabels(before, labels);
  for (let index = 0; index < Math.abs(steps); ++index) {
    if (steps < 0) labels.redo.push(labels.undo.pop() || "Earlier edit");
    else labels.undo.push(labels.redo.pop() || "Later edit");
  }
  reconcileHistoryLabels(after, labels);
}

function renderHistory() {
  const list = $("historyList");
  const restoreFocus = list.contains(document.activeElement);
  list.replaceChildren();
  const undoCount = snapshot?.memory?.undoStates || 0;
  const redoCount = snapshot?.memory?.redoStates || 0;
  $("historyCount").textContent = String(undoCount + redoCount + (snapshot ? 1 : 0));
  $("historyEmpty").hidden = Boolean(snapshot && (undoCount || redoCount));
  if (!snapshot) return;
  const labels = reconcileHistoryLabels(snapshot);
  const rows = [
    { label: "Opened document", steps: -undoCount, direction: undoCount ? "undo" : "current" },
    ...labels.undo.map((label, index) => ({ label,
      steps: -(undoCount - index - 1), direction: index === undoCount - 1 ? "current" : "undo" })),
    ...labels.redo.slice().reverse().map((label, index) => ({ label, steps: index + 1, direction: "redo" })),
  ];
  for (const row of rows) {
    const button = document.createElement("button"); button.type = "button";
    button.className = "history-row"; button.dataset.direction = row.direction;
    button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(row.steps === 0));
    button.disabled = busy;
    button.setAttribute("aria-disabled", String(busy || row.steps === 0));
    const marker = document.createElement("span"); marker.className = "history-marker";
    marker.textContent = row.steps === 0 ? "●" : row.direction === "undo" ? "↶" : "↷";
    const label = document.createElement("span"); label.className = "history-label";
    localizer.setText(label, row.label);
    button.append(marker, label);
    if (row.steps) button.addEventListener("click", () => navigateHistory(row.steps));
    list.append(button);
  }
  const current = list.querySelector('[aria-selected="true"]');
  for (const button of list.querySelectorAll(".history-row")) {
    button.tabIndex = button === current ? 0 : -1;
  }
  current?.scrollIntoView({ block: "nearest" });
  if (restoreFocus) current?.focus({ preventScroll: true });
}

function setSessionState(state, label) {
  shell.dataset.state = state;
  localizer.setText($("sessionIndicator").lastElementChild, label);
}

function showToast(label) {
  const toast = $("actionToast");
  clearTimeout(toastTimer); localizer.setText(toast, label); toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
}

function setBusy(active, title = "Working", detail = "The engine is updating the document") {
  busy = active;
  shell.setAttribute("aria-busy", String(active));
  clearTimeout(busyPresentationTimer);
  if (active) {
    $("busyState").hidden = true;
    busyPresentationTimer = setTimeout(() => { if (busy) $("busyState").hidden = false; }, 180);
  } else $("busyState").hidden = true;
  localizer.setText($("busyTitle"), title);
  localizer.setText($("busyDetail"), detail);
  if (!active) {
    cancelActiveOperation = null;
    $("busyProgress").hidden = true;
    $("cancelOperationButton").hidden = true;
    $("cancelOperationButton").disabled = false;
    $("busyProgress").value = 0;
  }
  for (const button of [$("openButton"), $("newButton"), $("recoveryButton"), $("versionsButton"), $("saveButton"), $("saveAsButton"), $("undoButton"), $("redoButton")]) {
    button.dataset.busyDisabled = active ? "true" : "false";
  }
  updateControls();
}

function updateControls() {
  const layer = selectedLayer();
  const layers = selectedLayers();
  const single = layers.length === 1;
  $("saveButton").disabled = busy || !snapshot;
  $("saveAsButton").disabled = busy || !snapshot;
  $("saveFormatSelect").disabled = busy || !snapshot;
  if (snapshot) {
    const format = documentSaveFormats.get(snapshot.documentId) || "psd";
    $("saveFormatSelect").value = format;
    localizer.setText($("saveButton").querySelector(".download-label"),
      fileLifecycle.supported ? `Save ${format.toUpperCase()}` : `Download ${format.toUpperCase()}`);
  }
  $("exportFormatSelect").disabled = busy || !snapshot;
  $("exportButton").disabled = busy || !snapshot;
  $("copyPixelsButton").disabled = busy || !snapshot;
  $("cutPixelsButton").disabled = busy || !single || layer?.kind !== 0 || !layer.visible || Boolean(layer.lockFlags);
  $("pastePixelsButton").disabled = busy || !snapshot ||
    (!layerClipboard && !pixelClipboard && !clipboardImageBlob && !navigator.clipboard?.read);
  $("undoButton").disabled = busy || !snapshot?.canUndo;
  $("redoButton").disabled = busy || !snapshot?.canRedo;
  $("openButton").disabled = busy;
  $("newButton").disabled = busy;
  $("emptyNewButton").disabled = busy;
  $("starterCustomCreateButton").disabled = busy;
  for (const button of document.querySelectorAll("[data-starter-preset]")) button.disabled = busy;
  $("recoveryButton").disabled = busy;
  $("versionsButton").disabled = busy || !snapshot || !workspaceAvailable;
  $("createVersionButton").disabled = busy || !snapshot || !workspaceAvailable;
  $("memoryBudgetSelect").disabled = busy;
  $("importLayerButton").disabled = busy || !snapshot;
  $("createPixelLayerButton").disabled = busy || !snapshot;
  $("layerViaCopyButton").disabled = busy || !snapshot?.selection?.length || !single ||
    layer?.kind !== 0 || !layer.visible;
  $("groupLayerButton").disabled = busy || !layers.length;
  $("ungroupLayerButton").disabled = busy || !layers.length || layers.some((item) => item.kind !== 1);
  $("removeLayerButton").disabled = busy || !layers.length;
  $("invertLayerButton").disabled = busy || !single || layer?.kind !== 0;
  $("filterLayerButton").disabled = busy || !single || layer?.kind !== 0;
  $("liquifyLayerButton").disabled = busy || !single || layer?.kind !== 0 ||
    !layer?.bounds || layer.bounds.width <= 0 || layer.bounds.height <= 0;
  $("textLayerButton").disabled = busy || !snapshot;
  localizer.setText($("textLayerButton"), single && layer?.kind === 3 ? "Edit text" : "Create text");
  $("layerTransformButton").disabled = busy || !transformSelection();
  const arrangement = transformSelection();
  const arrangementMode = Number($("layerArrangeModeInput").value);
  const arrangementMinimum = arrangementMode >= 6 ? 3 : 2;
  const canArrange = Boolean(arrangement && arrangement.layerIds.length >= arrangementMinimum);
  $("layerArrangeModeInput").disabled = busy || !snapshot;
  $("layerArrangeReferenceInput").disabled = busy || !canArrange || arrangementMode >= 6;
  if (arrangementMode >= 6) $("layerArrangeReferenceInput").value = "0";
  $("arrangeLayersButton").disabled = busy || !canArrange;
  $("layerWarpButton").disabled = busy || !single || ![0, 3, 5].includes(layer?.kind) ||
    Boolean(layer?.vectorMask) || Boolean(layer?.mask && !layer.mask.linked);
  $("shapeLayerButton").disabled = busy || !snapshot;
  $("adjustmentLayerButton").disabled = busy || !snapshot;
  localizer.setText($("shapeLayerButton"), single && layer?.kind === 4 ? "Edit shape" : "Create shape");
  localizer.setText($("adjustmentLayerButton"), single && layer?.kind === 2 ? "Edit adjustment" : "Create adjustment");
  const editableType = single && [2, 3, 4].includes(layer?.kind);
  $("editLayerTypeButton").hidden = !editableType;
  $("editLayerTypeButton").disabled = busy || !editableType;
  if (editableType) localizer.setText($("editLayerTypeButton"), layer.kind === 2 ? "Edit adjustment" :
    layer.kind === 3 ? "Edit text" : "Edit shape");
  $("smartObjectButton").disabled = busy || !snapshot;
  localizer.setText($("smartObjectButton"), layer?.kind === 5 ? "Replace Smart Object" : "Place Smart Object");
  $("openSmartObjectButton").disabled = busy || !single || layer?.kind !== 5 ||
    !layer?.smartObject?.contentsEditable;
  $("smartFilterButton").disabled = busy || !single || layer?.kind !== 5 || !layer?.smartObject?.editable;
  const hasVectorMaskSource = Boolean(selectedPath()?.subpaths?.length || snapshot?.selection?.length);
  $("createVectorMaskButton").disabled = busy || !single || !layer || layer.kind === 1 ||
    layer.kind === 4 || !hasVectorMaskSource;
  $("createMaskButton").disabled = busy || !single || layer?.kind !== 0 || Boolean(layer?.mask);
  const canToggleClipping = single && canToggleLayerClipping(layer);
  $("toggleClippingButton").disabled = busy || !canToggleClipping;
  localizer.setText($("toggleClippingButton"), layer?.clipped ? "Release clipping mask" : "Create clipping mask");
  localizer.setAttribute($("toggleClippingButton"), "title", canToggleClipping
    ? (layer?.clipped ? "Release clipping mask" : "Create clipping mask")
    : "A clipping mask needs a pixel layer below it");
  const mergeRoots = selectedLayerIdsTopToBottom({ rootsOnly: true });
  const mergeParents = new Set(layers.map((item) => String(item.parentId)));
  $("mergeLayersButton").disabled = busy || mergeRoots.length < 2 || mergeParents.size !== 1 ||
    layers.some((item) => !item.visible);
  $("toggleMaskButton").disabled = busy || !single || !layer?.mask;
  localizer.setText($("toggleMaskButton"), layer?.mask?.disabled ? "Enable mask" : "Disable mask");
  $("linkMaskButton").disabled = busy || !single || !layer?.mask;
  localizer.setText($("linkMaskButton"), layer?.mask?.linked === false ? "Link mask" : "Unlink mask");
  $("invertMaskButton").disabled = busy || !single || !layer?.mask;
  $("removeMaskButton").disabled = busy || !single || !layer?.mask;
  const canPaintMask = Boolean(layer?.mask && !layer.mask.disabled &&
    (canvasTool === "brush" || canvasTool === "eraser"));
  $("paintTargetSelect").disabled = busy || !canPaintMask;
  if (!canPaintMask) {
    $("paintTargetSelect").value = "pixels";
  }
  $("transformButton").disabled = busy || !snapshot;
  $("selectAllButton").disabled = busy || !snapshot;
  $("clearSelectionButton").disabled = busy || !snapshot?.selection?.length;
  $("layerNameInput").disabled = busy || !single;
  $("layerOpacityInput").disabled = busy || !layers.length;
  $("layerFillInput").disabled = busy || !layers.length || layers.some((item) => item.kind === 1);
  const penReady = !busy && canvasTool === "pen" && (penDraft?.points.length || 0) >= 3;
  $("finishPenPathButton").disabled = !penReady;
  $("closePenPathButton").disabled = !penReady;
  $("cancelPenPathButton").disabled = busy || canvasTool !== "pen" || !penDraft?.points.length;
  $("layerBlendSelect").disabled = busy || !layers.length;
  $("layerClipInput").disabled = busy || !single;
  $("layerLockInput").disabled = busy || !layers.length;
  $("quickLayerOpacityInput").disabled = busy || !layers.length;
  $("quickLayerFillInput").disabled = busy || !layers.length || layers.some((item) => item.kind === 1);
  $("quickLayerBlendSelect").disabled = busy || !layers.length;
  $("quickLayerLockInput").disabled = busy || !layers.length;
  $("layerStyleSelect").disabled = busy || !single;
  $("applyLayerStyleButton").disabled = busy || !single;
  $("editLayerStyleButton").disabled = busy || !single;
  for (const id of ["invertSelectionButton", "expandSelectionButton", "contractSelectionButton",
    "borderSelectionButton", "growSelectionButton", "similarSelectionButton",
    "smoothSelectionButton", "saveChannelButton", "savePathButton"]) {
    $(id).disabled = busy || !snapshot?.selection?.length;
  }
  $("rasterizeLayerButton").disabled = busy || !single || ![3, 4, 5].includes(layer?.kind);
  $("mergeVisibleButton").disabled = busy || !snapshot?.layers?.length;
  for (const id of ["channelRenameButton", "channelInvertButton", "channelUpButton",
    "channelDownButton", "channelDeleteButton"]) $(id).disabled = busy || !selectedChannel();
  const path = selectedPath();
  const closedPath = Boolean(path?.subpaths?.some((subpath) =>
    subpath.closed && (subpath.anchors?.length || 0) >= 3));
  for (const id of ["pathRenameButton", "pathClipButton", "pathUpButton", "pathDownButton",
    "pathDeleteButton", "pathAnchorApplyButton"]) $(id).disabled = busy || !path;
  $("pathSelectionButton").disabled = busy || !closedPath;
  $("makePenSelectionButton").disabled = busy || !closedPath || Boolean(penDraft?.points.length);
  $("pathFillButton").disabled = busy || !closedPath || layer?.kind !== 0 || Boolean(layer?.lockFlags);
  $("pathStrokeButton").disabled = busy || !path || layer?.kind !== 0 || Boolean(layer?.lockFlags);
  $("pathVectorMaskButton").disabled = busy || !closedPath || !single || !layer ||
    layer.kind === 1 || layer.kind === 4;
  $("pathAnchorXInput").disabled = busy || !selectedPath()?.anchors?.length;
  $("pathAnchorYInput").disabled = busy || !selectedPath()?.anchors?.length;
  syncCommands();
  renderHistory();
}

function openDocumentDialog(crop = null) {
  if (busy || !snapshot) return;
  for (const id of ["documentWidthInput", "canvasWidthInput"]) $(id).value = String(snapshot.width);
  for (const id of ["documentHeightInput", "canvasHeightInput"]) $(id).value = String(snapshot.height);
  resizeAspectRatio = snapshot.width / snapshot.height;
  const cropBounds = crop || selectionBounds() ||
    { x: 0, y: 0, width: snapshot.width, height: snapshot.height };
  $("cropXInput").value = String(cropBounds.x);
  $("cropYInput").value = String(cropBounds.y);
  $("cropWidthInput").value = String(cropBounds.width);
  $("cropHeightInput").value = String(cropBounds.height);
  $("cropFromSelectionButton").disabled = !selectionBounds();
  $("documentDialog").showModal();
}

function integerInput(id, positive = false) {
  const input = $(id);
  if (!input.reportValidity()) return null;
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX ||
      (positive && value <= 0)) {
    input.setCustomValidity(localizer.text(positive ?
      "Enter a positive signed 32-bit whole number" : "Enter a signed 32-bit whole number"));
    input.reportValidity();
    input.setCustomValidity("");
    return null;
  }
  return value;
}

function finiteInput(id) {
  const input = $(id);
  if (!input.reportValidity()) return null;
  const value = Number(input.value);
  if (!Number.isFinite(value)) {
    input.setCustomValidity(localizer.text("Enter a finite number")); input.reportValidity();
    input.setCustomValidity(""); return null;
  }
  return value;
}

function geometryFillColor() {
  return [...colorBytes($("geometryColorInput").value),
    $("geometryTransparentInput").checked ? 0 : 255];
}

function documentMutation(title, operation) {
  $("documentDialog").close();
  mutate(title, operation);
}

function geometryMutation(title, targetSize, operation) {
  try {
    const target = typeof targetSize === "function" ? targetSize() : targetSize;
    const format = documentSaveFormats.get(snapshot.documentId) || "psd";
    layeredGeometrySize(target.width, target.height, format);
    ensureMemorySafe(
      { currentWidth: snapshot.width, currentHeight: snapshot.height,
        targetWidth: target.width, targetHeight: target.height,
        documentPixelBytes: snapshot.memory?.documentPixelBytes,
        pixelLayerCount: snapshot.layers.filter((layer) => layer.kind === 0).length,
        maskCount: snapshot.layers.filter((layer) => layer.mask != null).length },
      title, geometryMutationPreflight);
  } catch (error) {
    showError(`${title} rejected`, error);
    return;
  }
  documentMutation(title, operation);
}

async function invertSelectedLayer() {
  const layer = selectedLayer();
  if (busy || !snapshot || layer?.kind !== 0) return;
  await applyPixelFilter(layer, "patchy.filters.invert", []);
}

async function applyPixelFilter(layer, filterId, parameters) {
  clearError();
  const definition = PIXEL_FILTERS.find((item) => item.id === filterId);
  setBusy(true, `Applying ${definition?.name || "filter"}`, "Filtering selected layer locally");
  $("busyProgress").hidden = false;
  $("cancelOperationButton").hidden = false;
  $("cancelOperationButton").disabled = false;
  const operation = client.applyFilter(layer.id, filterId, parameters, (progress) => {
    $("busyProgress").value = progress.ratio;
    $("busyDetail").textContent = `Filtering selected layer · ${Math.round(progress.ratio * 100)}%`;
  });
  cancelActiveOperation = operation.cancel;
  try {
    const next = await operation.promise;
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  } catch (error) {
    if (error?.code !== 7) showError("Could not apply filter", error);
    else setSessionState("document", "Filter cancelled");
  } finally {
    setBusy(false);
  }
}

function showError(title, error) {
  diagnostics.recordError(client?.state === "crashed" ? "worker.crash" : "ui.error", error);
  const banner = $("errorBanner");
  if (!banner.contains(document.activeElement)) errorReturnFocus = document.activeElement;
  localizer.setText($("errorTitle"), title);
  localizer.setText($("errorMessage"), error?.message || String(error));
  banner.hidden = false;
  queueMicrotask(() => $("dismissErrorButton").focus({ preventScroll: true }));
  if (client.state === "crashed") setSessionState("crashed", "Worker crashed");
  else setSessionState(snapshot ? "document" : "error", snapshot ? "Document ready" : "Engine error");
}

function clearError() {
  const banner = $("errorBanner");
  const restore = !banner.hidden && banner.contains(document.activeElement) ? errorReturnFocus : null;
  banner.hidden = true; errorReturnFocus = null;
  if (restore?.isConnected && !restore.disabled) {
    queueMicrotask(() => restore.focus({ preventScroll: true }));
  }
}

function newWorkspaceId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint32Array(4));
  return `workspace-${[...random].map((value) => value.toString(16).padStart(8, "0")).join("")}`;
}

function setRecoveryLabel(state, label) {
  const output = $("recoveryLabel");
  output.dataset.state = state;
  localizer.setText(output, label);
}

function renderRecoveryStatus(documentId = snapshot?.documentId) {
  if (!workspaceAvailable) { setRecoveryLabel("error", "Recovery unavailable"); return; }
  if (!documentId) { setRecoveryLabel("confirmed", "Local recovery ready"); return; }
  const state = checkpointStates.get(documentId);
  if (state === "pending") setRecoveryLabel("pending", "Protecting revision…");
  else if (state === "error") setRecoveryLabel("error", "Recovery needs attention");
  else if (state === "confirmed") setRecoveryLabel("confirmed", "Document protected locally");
  else setRecoveryLabel("pending", "Recovery not captured yet");
}

function updateRecoveryCount() { $("recoveryCount").textContent = String(knownWorkspaceIds.size); }

function preferenceSnapshot() {
  return {
    locale: localizer.locale,
    tool: canvasTool,
    brushSize: Number($("brushSizeInput").value),
    color: $("brushColorInput").value,
    paintPreset: $("paintPresetSelect").value,
    font: $("textFontInput").value.trim() || "Arial",
    selectionTolerance: Number($("selectionToleranceInput").value),
    historyBudgetMiB: Number($("memoryBudgetSelect").value),
    panelsHidden: shell.classList.contains("panels-hidden"),
    guidesVisible,
    snappingEnabled,
  };
}

function assetId(prefix) {
  const suffix = crypto.randomUUID ? crypto.randomUUID() :
    [...crypto.getRandomValues(new Uint32Array(4))].map((value) => value.toString(16)).join("-");
  return `${prefix}-${suffix}`;
}

function renderAssetLibrary() {
  const select = $("paintPresetSelect");
  for (const option of [...select.querySelectorAll('option[data-local-asset="true"]')]) option.remove();
  for (const asset of [...assetLibrary.gradients, ...assetLibrary.patterns]) {
    const option = document.createElement("option"); option.value = `asset:${asset.id}`;
    option.dataset.localAsset = "true";
    option.textContent = `${assetLibrary.gradients.includes(asset) ? "Gradient" : "Pattern"}: ${asset.name}`;
    select.append(option);
  }
  const advancedPattern = $("advancedPatternInput");
  const selectedAdvancedPattern = advancedPattern.value;
  for (const option of [...advancedPattern.querySelectorAll('option[data-local-asset="true"]')]) option.remove();
  for (const asset of assetLibrary.patterns) {
    const option = document.createElement("option"); option.value = `asset:${asset.id}`;
    option.dataset.localAsset = "true"; option.textContent = `Pattern: ${asset.name}`;
    advancedPattern.append(option);
  }
  if ([...advancedPattern.options].some((option) => option.value === selectedAdvancedPattern)) {
    advancedPattern.value = selectedAdvancedPattern;
  }
  const fonts = $("fontPresetList");
  for (const option of [...fonts.querySelectorAll('option[data-local-asset="true"]')]) option.remove();
  for (const font of assetLibrary.fonts) {
    const option = document.createElement("option"); option.value = font.family;
    option.dataset.localAsset = "true"; fonts.append(option);
  }
  const list = $("assetLibraryList"); list.replaceChildren();
  for (const [kind, assets] of [["gradients", assetLibrary.gradients],
    ["patterns", assetLibrary.patterns], ["fonts", assetLibrary.fonts]]) {
    for (const asset of assets) {
      const row = document.createElement("div"); row.className = "dialog-actions";
      const label = document.createElement("span"); label.textContent =
        `${kind.slice(0, -1)} · ${asset.name || asset.family}`;
      const remove = document.createElement("button"); remove.type = "button";
      remove.className = "button"; remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        try {
          assetLibrary = await workspaceStore.removeAsset(kind, asset.id);
          if (kind === "fonts") {
            const face = loadedFontFaces.get(asset.id);
            if (face) document.fonts.delete(face);
            loadedFontFaces.delete(asset.id);
          }
          renderAssetLibrary(); persistPreferences();
        } catch (error) { showError("Could not remove local asset", error); }
      });
      row.append(label, remove); list.append(row);
    }
  }
  if (!list.children.length) list.textContent = "No local assets yet.";
}

async function loadLocalAssets() {
  assetLibrary = await workspaceStore.loadAssetLibrary();
  for (const font of assetLibrary.fonts) {
    try {
      const stored = await workspaceStore.loadFont(font.id);
      const face = await new FontFace(font.family, stored.bytes.buffer).load();
      document.fonts.add(face); loadedFontFaces.set(font.id, face);
    } catch { /* Invalid local fonts stay unavailable and visible for removal. */ }
  }
  renderAssetLibrary();
}

async function saveFillAsset(kind) {
  const isGradient = kind === "gradient";
  const asset = isGradient ? {
    id: assetId("gradient"), name: $("assetGradientNameInput").value,
    start: $("assetGradientStartInput").value, end: $("assetGradientEndInput").value,
  } : {
    id: assetId("pattern"), name: $("assetPatternNameInput").value,
    kind: $("assetPatternKindInput").value,
    foreground: $("assetPatternForegroundInput").value,
    background: $("assetPatternBackgroundInput").value,
    size: Number($("assetPatternSizeInput").value),
  };
  const key = isGradient ? "gradients" : "patterns";
  assetLibrary = await workspaceStore.saveAssetLibrary({ ...assetLibrary,
    [key]: [...assetLibrary[key], asset] });
  renderAssetLibrary(); $("paintPresetSelect").value = `asset:${asset.id}`; persistPreferences();
}

async function installFontAsset() {
  const file = $("assetFontFileInput").files?.[0];
  if (!file) throw new Error("Choose a TTF, OTF, WOFF or WOFF2 font file.");
  if (file.size <= 0 || file.size > 16 * 1024 * 1024) throw new Error("Font must be between 1 byte and 16 MiB.");
  const family = $("assetFontFamilyInput").value.trim();
  if (!family) throw new Error("Enter a font family name.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const face = await new FontFace(family, bytes.buffer.slice(0)).load();
  const id = assetId("font");
  const metadata = await workspaceStore.installFont({ id, family, filename: file.name, bytes });
  document.fonts.add(face); loadedFontFaces.set(id, face);
  assetLibrary = await workspaceStore.loadAssetLibrary();
  renderAssetLibrary(); $("textFontInput").value = metadata.family; persistPreferences();
}

function persistPreferences() {
  if (!workspaceAvailable) return;
  clearTimeout(preferenceTimer);
  preferenceTimer = setTimeout(async () => {
    try { await workspaceStore.savePreferences(preferenceSnapshot()); }
    catch (error) { showError("Could not save local preferences", error); }
  }, 120);
}

function applyPreferences(preferences) {
  const locale = preferences.locale === "ru" ? "ru" : "en";
  $("localeSelect").value = locale;
  localizer.setLocale(locale);
  $("brushSizeInput").value = String(preferences.brushSize);
  $("brushSizeOutput").textContent = `${preferences.brushSize} px`;
  $("brushColorInput").value = preferences.color;
  $("foregroundSwatchInput").value = preferences.color;
  $("paintPresetSelect").value = preferences.paintPreset;
  $("textFontInput").value = preferences.font;
  $("selectionToleranceInput").value = String(preferences.selectionTolerance);
  $("selectionToleranceOutput").textContent = String(preferences.selectionTolerance);
  $("memoryBudgetSelect").value = String(preferences.historyBudgetMiB);
  shell.classList.toggle("panels-hidden", preferences.panelsHidden);
  $("togglePanelsButton").setAttribute("aria-pressed", String(preferences.panelsHidden));
  guidesVisible = preferences.guidesVisible !== false;
  snappingEnabled = preferences.snappingEnabled !== false;
  setCanvasTool(preferences.tool);
  renderGuides();
}

function renderLocalizedShell() {
  renderHistory();
  renderLayers();
  renderLayerProperties();
  renderStructure();
  renderMetadata();
  renderDocumentTabs();
  renderRecoveryStatus();
  renderGuides();
  localizer.localize(document);
  syncToolRoving();
}

async function recoverEngineAfterCrash() {
  if (recoveryPromise) return recoveryPromise;
  const openDocuments = (snapshot?.documents || []).map((documentTab) => ({
    documentId: documentTab.id,
    workspaceId: workspaceIds.get(documentTab.id),
    active: documentTab.active,
    confirmed: checkpointStates.get(documentTab.id) === "confirmed",
  }));
  const documents = openDocuments.filter((documentTab) => documentTab.workspaceId);
  automaticRecoveryEnabled = false;
  diagnostics.recordRecovery("started");
  recoveryPromise = (async () => {
    setBusy(true, "Restarting editor engine", "Restoring confirmed local workspaces");
    setSessionState("crashed", "Worker crashed · recovering");
    try {
      const result = await recoverWorkerSession({ createClient: createEngineClient,
        moduleUrl, workspaceStore, documents });
      client = result.client;
      const historyBytes = Number($("memoryBudgetSelect").value) * MIB;
      await client.setMemoryBudget(historyBytes, Math.min(3 * 1024 * MIB, historyBytes * 3));
      workspaceIds.clear(); checkpointStates.clear(); checkpointQueues.clear();
      documentHistoryLabels.clear(); documentSaveFormats.clear();
      documentViewports.clear(); viewportDiagnostics.trackedDocuments = 0;
      fileLifecycle.remapAll(result.restored.map((item) => ({
        previousDocumentId: item.previousDocumentId, documentId: item.documentId,
        projection: item.snapshot, format: item.format,
      })), openDocuments.map((item) => item.documentId));
      for (const item of result.restored) {
        workspaceIds.set(item.documentId, item.workspaceId);
        checkpointStates.set(item.documentId, "confirmed");
        documentSaveFormats.set(item.documentId, item.format);
      }
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
      layerClipboard = null; pixelClipboard = null; draggedLayer = null;
      await acceptSnapshot(result.activeSnapshot, true, false);
      automaticRecoveryEnabled = true;
      const reverted = result.restored.filter((item) => !item.confirmedAtCrash);
      diagnostics.recordRecovery(result.failed.length || reverted.length ? "partial" : "succeeded", {
        restored: result.restored.length, failed: result.failed.length, rolledBack: reverted.length });
      if (result.failed.length || reverted.length) {
        const names = result.failed.map((item) => item.workspaceId).join(", ");
        showError("Editor restarted with partial recovery",
          new Error(`${result.restored.length} workspace(s) restored from confirmed snapshots; ${result.failed.length} could not be restored${names ? `: ${names}` : ""}${reverted.length ? `; ${reverted.length} had unconfirmed changes and were rolled back` : ""}.`));
      } else {
        setSessionState(result.activeSnapshot ? "document" : "ready",
          result.restored.length ? `Recovered ${result.restored.length} workspace${result.restored.length === 1 ? "" : "s"}` : "Engine restarted");
      }
    } catch (error) {
      diagnostics.recordRecovery("failed", { failed: Math.min(16, documents.length) });
      showError("Could not restart editor engine", error);
    } finally {
      setBusy(false);
      recoveryPromise = null;
    }
  })();
  return recoveryPromise;
}

function scheduleCheckpoint(next) {
  if (!workspaceAvailable || !next?.documentId) { renderRecoveryStatus(next?.documentId); return Promise.resolve(); }
  const workspaceId = workspaceIds.get(next.documentId) || newWorkspaceId();
  workspaceIds.set(next.documentId, workspaceId);
  let queue = checkpointQueues.get(next.documentId);
  if (!queue) {
    queue = new PatchyCheckpointQueue({
      save: (checkpoint) => client.saveDocument(checkpoint.documentId, checkpoint.format),
      write: (checkpoint, bytes) => workspaceStore.checkpoint({ id: workspaceId,
        name: checkpoint.documentName, revision: checkpoint.revision,
        dirty: checkpoint.dirty, format: checkpoint.format, bytes,
        selection: checkpointSelection(checkpoint) }),
      onState: (state, checkpoint, value) => {
        checkpointStates.set(next.documentId, state);
        if (state === "confirmed") {
          knownWorkspaceIds.add(workspaceId); updateRecoveryCount();
        } else if (state === "error") {
          showError("Local recovery checkpoint failed", value);
        }
        renderRecoveryStatus(snapshot?.documentId);
      },
    });
    checkpointQueues.set(next.documentId, queue);
  }
  return queue.schedule({ ...next,
    format: documentSaveFormats.get(next.documentId) || "psd" });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function ensureMemorySafe(input, label, policy = documentPreflight) {
  const preflight = policy({ ...input, limitBytes: workingSetLimit });
  const retainedBytes = (snapshot?.documents || []).reduce(
    (sum, documentTab) => sum + Number(documentTab.retainedBytes || 0), 0);
  const combinedBytes = preflight.estimatedBytes + retainedBytes;
  if (!preflight.allowed || combinedBytes > preflight.limitBytes) {
    throw new RangeError(`${label} needs an estimated ${formatBytes(preflight.estimatedBytes)} plus ${formatBytes(retainedBytes)} already retained, above this browser's ${formatBytes(preflight.limitBytes)} safety limit.`);
  }
  return preflight;
}

async function applyMemoryBudget(render = true) {
  const documentBytes = Number($("memoryBudgetSelect").value) * MIB;
  const next = await client.setMemoryBudget(documentBytes, Math.min(3 * 1024 * MIB, documentBytes * 3));
  if (next?.documentId) await acceptSnapshot(next, render);
}

async function restoreWorkspace(id) {
  if (busy) return;
  $("recoveryDialog").close(); clearError();
  setBusy(true, "Recovering document", "Validating and opening its latest complete local snapshot");
  try {
    const existing = [...workspaceIds.entries()].find(([, workspaceId]) => workspaceId === id);
    if (existing) {
      await acceptSnapshot(await client.activateDocument(existing[0]));
      return;
    }
    const recovered = await workspaceStore.restore(id);
    let next = await client.open(recovered.bytes, recovered.manifest.name,
      { transferOwnership: true });
    if (recovered.selection) next = await applyRecoveredSelection(client, recovered.selection);
    workspaceIds.set(next.documentId, id);
    checkpointStates.set(next.documentId, "confirmed");
    documentSaveFormats.set(next.documentId, recovered.manifest.format || "psd");
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
  } catch (error) { showError("Could not recover workspace", error); }
  finally { setBusy(false); }
}

async function removeWorkspace(manifest) {
  if (!confirm(`${localizer.text("Delete the local recovery snapshot for")} ${manifest.name}?`)) return;
  try {
    const activeDocument = [...workspaceIds.entries()].find(([, id]) => id === manifest.id)?.[0];
    if (activeDocument) await checkpointQueues.get(activeDocument)?.whenIdle();
    await workspaceStore.remove(manifest.id);
    knownWorkspaceIds.delete(manifest.id);
    for (const [documentId, workspaceId] of workspaceIds) {
      if (workspaceId === manifest.id) checkpointStates.delete(documentId);
    }
    updateRecoveryCount();
    await refreshRecoveryList();
    renderRecoveryStatus();
  } catch (error) { showError("Could not delete local recovery", error); }
}

async function refreshRecoveryList() {
  const list = $("recoveryList"); list.replaceChildren();
  if (!workspaceAvailable) {
    $("recoverySummary").textContent = "Origin-private storage is unavailable in this browser context.";
    list.append(Object.assign(document.createElement("p"), { className: "recovery-empty",
      textContent: "Recovery snapshots cannot be stored here." }));
    $("recoveryQuota").textContent = "Use a secure origin with persistent browser storage enabled.";
    return;
  }
  try {
    const manifests = await workspaceStore.list();
    knownWorkspaceIds.clear();
    for (const manifest of manifests) knownWorkspaceIds.add(manifest.id);
    updateRecoveryCount();
    $("recoverySummary").textContent = manifests.length
      ? `${manifests.length} recoverable workspace${manifests.length === 1 ? "" : "s"} on this device.`
      : "No recoverable workspaces are stored on this device yet.";
    if (!manifests.length) list.append(Object.assign(document.createElement("p"), {
      className: "recovery-empty", textContent: "Completed checkpoints will appear here." }));
    for (const manifest of manifests) {
      const row = document.createElement("article"); row.className = "recovery-row";
      const copy = document.createElement("div"); copy.className = "recovery-copy";
      const title = document.createElement("strong"); title.textContent = manifest.name;
      const details = document.createElement("span");
      details.textContent = `Revision ${manifest.revision} · ${formatBytes(manifest.snapshotSize)} · ${new Date(manifest.updatedAt).toLocaleString()}`;
      copy.append(title, details);
      const actions = document.createElement("div"); actions.className = "recovery-actions";
      const restore = document.createElement("button"); restore.type = "button";
      restore.className = "button button-primary"; restore.textContent = "Recover";
      restore.addEventListener("click", () => restoreWorkspace(manifest.id));
      const remove = document.createElement("button"); remove.type = "button";
      remove.className = "button"; remove.textContent = "Delete";
      remove.addEventListener("click", () => removeWorkspace(manifest));
      actions.append(restore, remove); row.append(copy, actions); list.append(row);
    }
    const estimate = await workspaceStore.estimate();
    $("recoveryQuota").textContent = estimate.quota
      ? `${formatBytes(estimate.usage)} used of approximately ${formatBytes(estimate.quota)} browser storage.`
      : "The browser did not report a storage quota.";
  } catch (error) {
    $("recoverySummary").textContent = "Recovery storage could not be read.";
    list.append(Object.assign(document.createElement("p"), { className: "recovery-empty",
      textContent: error?.message || String(error) }));
  }
}

async function openRecoveryDialog() {
  if (busy) return;
  $("recoveryDialog").showModal();
  await refreshRecoveryList();
}

async function refreshVersionHistoryList() {
  const list = $("versionHistoryList");
  list.replaceChildren();
  const workspaceId = snapshot?.documentId ? workspaceIds.get(snapshot.documentId) : null;
  if (!workspaceAvailable || !snapshot) {
    $("versionHistorySummary").textContent = "Local version history is unavailable here.";
    list.append(Object.assign(document.createElement("p"), { className: "recovery-empty",
      textContent: "Open a document in a secure browser context first." }));
    return;
  }
  try {
    const manifests = workspaceId ? await workspaceStore.listVersions(workspaceId) : [];
    $("versionHistorySummary").textContent = manifests.length
      ? `${manifests.length} immutable local version${manifests.length === 1 ? "" : "s"}. The newest 20 are retained.`
      : "No named versions exist for this document yet.";
    if (!manifests.length) list.append(Object.assign(document.createElement("p"), {
      className: "recovery-empty", textContent: "Create a named version to preserve the current layered state." }));
    for (const manifest of manifests) {
      const row = document.createElement("article"); row.className = "recovery-row";
      const copy = document.createElement("div"); copy.className = "recovery-copy";
      const title = document.createElement("strong"); title.textContent = manifest.label;
      const details = document.createElement("span");
      details.textContent = `${manifest.format.toUpperCase()} · Revision ${manifest.revision} · ${formatBytes(manifest.payloadSize)} · ${new Date(manifest.createdAt).toLocaleString()}`;
      copy.append(title, details);
      const actions = document.createElement("div"); actions.className = "recovery-actions";
      const restore = document.createElement("button"); restore.type = "button";
      restore.className = "button button-primary"; restore.textContent = "Restore as new";
      restore.addEventListener("click", () => restoreLocalVersion(workspaceId, manifest));
      const remove = document.createElement("button"); remove.type = "button";
      remove.className = "button"; remove.textContent = "Delete";
      remove.addEventListener("click", () => removeLocalVersion(workspaceId, manifest));
      actions.append(restore, remove); row.append(copy, actions); list.append(row);
    }
    localizer.localize(list);
  } catch (error) {
    $("versionHistorySummary").textContent = "Local version history could not be read.";
    list.append(Object.assign(document.createElement("p"), { className: "recovery-empty",
      textContent: error?.message || String(error) }));
  }
}

async function openVersionHistoryDialog() {
  if (busy || !snapshot || !workspaceAvailable) return;
  $("versionHistoryDialog").showModal();
  await refreshVersionHistoryList();
  $("versionLabelInput").focus();
}

async function createLocalVersion() {
  if (busy || !snapshot || !workspaceAvailable) return;
  const label = $("versionLabelInput").value.trim();
  if (!label) {
    $("versionLabelInput").setCustomValidity("Enter a version name.");
    $("versionLabelInput").reportValidity();
    return;
  }
  $("versionLabelInput").setCustomValidity("");
  const source = snapshot;
  const format = documentSaveFormats.get(source.documentId) || "psd";
  const workspaceId = workspaceIds.get(source.documentId) || newWorkspaceId();
  workspaceIds.set(source.documentId, workspaceId);
  clearError();
  setBusy(true, "Creating local version", "Encoding and verifying one immutable layered snapshot");
  try {
    const bytes = await client.saveDocument(source.documentId, format);
    await workspaceStore.createVersion({ id: workspaceId, versionId: `version-${newWorkspaceId()}`,
      label, name: source.documentName || documentName, revision: source.revision,
      format, bytes, selection: checkpointSelection(source), keepNewest: 20 });
    $("versionLabelInput").value = "";
    await refreshVersionHistoryList();
    setSessionState("document", "Local version created");
  } catch (error) {
    $("versionHistoryDialog").close();
    showError("Could not create local version", error);
  } finally { setBusy(false); }
}

async function restoreLocalVersion(workspaceId, manifest) {
  if (busy || !snapshot || !workspaceAvailable) return;
  $("versionHistoryDialog").close(); clearError();
  setBusy(true, "Restoring local version", "Validating and opening an independent layered document");
  try {
    const recovered = await workspaceStore.restoreVersion(workspaceId, manifest.versionId);
    let next = await client.open(recovered.bytes, recovered.manifest.name, { transferOwnership: true });
    if (recovered.selection) next = await applyRecoveredSelection(client, recovered.selection);
    const format = recovered.manifest.format || "psd";
    workspaceIds.set(next.documentId, newWorkspaceId());
    documentSaveFormats.set(next.documentId, format);
    fileLifecycle.register(next.documentId, next, format);
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
    setSessionState("document", "Version restored as new document");
  } catch (error) { showError("Could not restore local version", error); }
  finally { setBusy(false); }
}

async function removeLocalVersion(workspaceId, manifest) {
  if (busy || !confirm(`${localizer.text("Delete")} ${manifest.label}?`)) return;
  try {
    await workspaceStore.removeVersion(workspaceId, manifest.versionId);
    await refreshVersionHistoryList();
  } catch (error) {
    $("versionHistoryDialog").close();
    showError("Could not delete local version", error);
  }
}

async function cleanupRecoveryWorkspaces() {
  if (busy || !workspaceAvailable) return;
  const protectedIds = [...new Set(workspaceIds.values())];
  const removable = (await workspaceStore.list()).filter((item) => !protectedIds.includes(item.id)).slice(8);
  if (!removable.length) {
    $("recoverySummary").textContent = "No older recovery workspaces are outside the keep-newest boundary.";
    return;
  }
  const recoveryKind = localizer.text(removable.length === 1
    ? "older recovery workspace" : "older recovery workspaces");
  const protectedCopy = localizer.text(
    "Open workspaces and the 8 newest closed workspaces are protected.");
  if (!confirm(`${localizer.text("Delete")} ${removable.length} ${recoveryKind}? ${protectedCopy}`)) return;
  try {
    const removed = await workspaceStore.cleanup({ protectedIds, keepNewest: 8 });
    for (const manifest of removed) knownWorkspaceIds.delete(manifest.id);
    await refreshRecoveryList();
  } catch (error) { showError("Could not clean recovery workspaces", error); }
}

function formatKind(layer) { return layerKinds[layer.kind] || `Layer ${layer.kind}`; }

function layerDepth(layer, byId) {
  let depth = 0; let parentId = layer.parentId; const visited = new Set([layer.id]);
  while (parentId && parentId !== 0n && depth < 32 && !visited.has(parentId)) {
    visited.add(parentId); const parent = byId.get(parentId);
    if (!parent) break;
    depth++; parentId = parent.parentId;
  }
  return depth;
}

function rememberLayerThumbnail(key, value) {
  layerThumbnailCache.delete(key); layerThumbnailCache.set(key, value);
  while (layerThumbnailCache.size > MAX_LAYER_THUMBNAILS) {
    layerThumbnailCache.delete(layerThumbnailCache.keys().next().value);
  }
}

function paintLayerThumbnail(canvas, thumbnail) {
  const target = canvas.getContext("2d", { alpha: true });
  const image = new ImageData(new Uint8ClampedArray(thumbnail.rgba),
    thumbnail.width, thumbnail.height);
  const scratch = document.createElement("canvas");
  scratch.width = thumbnail.width; scratch.height = thumbnail.height;
  scratch.getContext("2d", { alpha: true }).putImageData(image, 0, 0);
  target.clearRect(0, 0, 32, 32);
  target.imageSmoothingEnabled = true;
  const scale = Math.min(30 / thumbnail.width, 30 / thumbnail.height);
  const width = Math.max(1, Math.round(thumbnail.width * scale));
  const height = Math.max(1, Math.round(thumbnail.height * scale));
  target.drawImage(scratch, Math.floor((32 - width) / 2),
    Math.floor((32 - height) / 2), width, height);
  canvas.dataset.ready = "true";
}

async function loadLayerThumbnail(canvas, layer, key, stateId, revision) {
  const cached = layerThumbnailCache.get(key);
  if (cached) { rememberLayerThumbnail(key, cached); paintLayerThumbnail(canvas, cached); return; }
  if (layer.kind === 1 || layer.bounds.width <= 0 || layer.bounds.height <= 0) return;
  try {
    const thumbnail = await client.layerThumbnail(layer.id, 32, stateId, revision);
    if (thumbnail.rgba.byteLength !== thumbnail.width * thumbnail.height * 4 ||
        thumbnail.rgba.byteLength > 32 * 32 * 4) return;
    rememberLayerThumbnail(key, thumbnail);
    if (canvas.isConnected && canvas.dataset.thumbnailKey === key) {
      paintLayerThumbnail(canvas, thumbnail);
    }
  } catch { /* A stale or non-raster row keeps its bounded kind placeholder. */ }
}

function scheduleLayerWindowRender() {
  if (layerWindowFrame) return;
  layerWindowFrame = requestAnimationFrame(() => { layerWindowFrame = 0; renderLayers(); });
}

function renderLayers() {
  const list = $("layerList");
  const scrollTop = list.scrollTop;
  const restoreFocus = list.contains(document.activeElement);
  list.replaceChildren();
  const layers = snapshot ? [...snapshot.layers].reverse() : [];
  $("layerCount").textContent = String(layers.length);
  $("layersEmpty").hidden = layers.length > 0;
  $("layersEmpty").textContent = snapshot ? "This document has no layers." : "Open a document to inspect its layers.";
  const viewportRows = Math.max(1, Math.ceil((list.clientHeight || 480) / LAYER_ROW_HEIGHT));
  const first = Math.max(0, Math.floor(scrollTop / LAYER_ROW_HEIGHT) - LAYER_OVERSCAN);
  const last = Math.min(layers.length, first + viewportRows + LAYER_OVERSCAN * 2);
  const visibleLayers = layers.slice(first, last);
  const rovingLayerId = chooseRovingLayerId(visibleLayers, selectedLayerId);
  const topSpacer = document.createElement("div");
  topSpacer.className = "layer-spacer"; topSpacer.setAttribute("aria-hidden", "true");
  topSpacer.style.height = `${first * LAYER_ROW_HEIGHT}px`;
  list.append(topSpacer);
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  for (let index = first; index < last; ++index) {
    const layer = layers[index];
    const row = document.createElement("div");
    row.className = "layer-row";
    row.draggable = true;
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-setsize", String(layers.length));
    row.setAttribute("aria-posinset", String(index + 1));
    row.dataset.active = String(selectedLayerIds.has(layer.id));
    row.dataset.layerId = String(layer.id);
    if (selectedLayerId === layer.id) row.setAttribute("aria-current", "true");
    row.style.paddingLeft = `${5 + layerDepth(layer, byId) * 12}px`;
    row.innerHTML = `
      <span class="layer-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
      <button class="visibility-button" type="button" aria-label="${layer.visible ? "Hide" : "Show"} ${escapeHtml(layer.name)}">${layer.visible ? "◉" : "○"}</button>
      <canvas class="layer-thumb" width="32" height="32" aria-hidden="true"></canvas>
      <button class="layer-copy layer-select-button" type="button"><span class="layer-name"></span><span class="layer-kind"></span></button>
      <button class="reorder-button" type="button" aria-label="Move layer up" ${index === 0 ? "disabled" : ""}>↑</button>
      <button class="reorder-button" type="button" aria-label="Move layer down" ${index === layers.length - 1 ? "disabled" : ""}>↓</button>`;
    if (layer.name) row.querySelector(".layer-name").textContent = layer.name;
    else localizer.setText(row.querySelector(".layer-name"), "Unnamed layer");
    row.querySelector(".layer-kind").textContent = `${formatKind(layer)}${layer.clipped ? ` · ${localizer.text("Clipped")}` : ""}${layer.mask ? ` · Mask${layer.mask.disabled ? " off" : ""}` : ""}${layer.adjustment ? ` · ${adjustmentName(layer.adjustment.kind)}` : ""}${layer.smartObject ? ` · ${layer.smartObject.filename}` : ""}`;
    const selectButton = row.querySelector(".layer-select-button");
    selectButton.tabIndex = rovingLayerId === layer.id ? 0 : -1;
    selectButton.setAttribute("aria-pressed", String(selectedLayerIds.has(layer.id)));
    localizer.setAttribute(selectButton, "aria-label", `Select ${layer.name || "unnamed layer"}`);
    selectButton.addEventListener("click", (event) => {
      const now = performance.now();
      const repeated = lastLayerActivation.id === layer.id && now - lastLayerActivation.at < 500;
      lastLayerActivation = { id: layer.id, at: now };
      selectLayerFromEvent(layer, event, layers);
      renderLayers();
      renderLayerProperties();
      if (repeated && !event.shiftKey && !(event.ctrlKey || event.metaKey)) {
        queueMicrotask(editSelectedLayerType);
      }
    });
    row.addEventListener("dragstart", (event) => {
      if (!selectedLayerIds.has(layer.id)) setSingleLayerSelection(layer.id);
      draggedLayer = captureLayerReference();
      event.dataTransfer?.setData("application/x-patchy-layer", String(layer.id));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
    });
    row.addEventListener("dragend", () => { draggedLayer = null; });
    row.addEventListener("dragover", (event) => {
      if (draggedLayer?.sourceDocumentId !== snapshot?.documentId) return;
      event.preventDefault();
      row.dataset.dropTarget = event.offsetY < row.clientHeight / 2 ? "above" : "below";
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("dragleave", () => { delete row.dataset.dropTarget; });
    row.addEventListener("drop", (event) => {
      if (draggedLayer?.sourceDocumentId !== snapshot?.documentId) return;
      event.preventDefault(); event.stopPropagation(); delete row.dataset.dropTarget;
      const ids = selectedLayerIdsTopToBottom({ rootsOnly: true });
      if (!ids.length || ids.includes(layer.id)) return;
      const position = event.offsetY < row.clientHeight / 2 ? 1 : 2;
      mutate("Moving layers", () => client.moveLayers(ids, layer.id, position));
      draggedLayer = null;
    });
    row.querySelector(".visibility-button").addEventListener("click", () => {
      const ids = selectedLayerIds.has(layer.id) ? selectedLayerIdsTopToBottom() : [layer.id];
      mutate(ids.length > 1 ? "Updating layers" : "Updating layer",
        () => client.editLayers(ids, 0, { value: layer.visible ? 0 : 1 }));
    });
    const reorder = async (direction) => {
      const ids = selectedLayerIds.has(layer.id)
        ? selectedLayerIdsTopToBottom({ rootsOnly: true }) : [layer.id];
      let targetIndex = index + direction;
      while (targetIndex >= 0 && targetIndex < layers.length &&
             ids.includes(layers[targetIndex].id)) targetIndex += direction;
      const target = layers[targetIndex];
      if (!target) return;
      const position = direction < 0 ? 1 : 2;
      await mutate(ids.length > 1 ? "Moving layers" : "Moving layer",
        () => client.moveLayers(ids, target.id, position));
    };
    row.querySelectorAll(".reorder-button")[0].addEventListener("click", () => reorder(-1));
    row.querySelectorAll(".reorder-button")[1].addEventListener("click", () => reorder(1));
    list.append(row);
    const thumbnail = row.querySelector(".layer-thumb");
    const key = `${snapshot.documentId}:${snapshot.revision}:${layer.id}`;
    thumbnail.dataset.thumbnailKey = key;
    loadLayerThumbnail(thumbnail, layer, key, snapshot.stateId, snapshot.revision);
  }
  const bottomSpacer = document.createElement("div");
  bottomSpacer.className = "layer-spacer"; bottomSpacer.setAttribute("aria-hidden", "true");
  bottomSpacer.style.height = `${Math.max(0, layers.length - last) * LAYER_ROW_HEIGHT}px`;
  list.append(bottomSpacer);
  localizer.localize(list);
  if (restoreFocus) list.querySelector('.layer-select-button[tabindex="0"]')?.focus({ preventScroll: true });
}

function renderLayerProperties() {
  const layer = selectedLayer();
  const layers = selectedLayers();
  const mixed = (property) => layers.length > 1 &&
    layers.some((item) => item[property] !== layers[0][property]);
  $("propertiesTitle").textContent = layers.length > 1
    ? `${layers.length} selected layers` : "Selected layer";
  $("layerNameInput").value = layers.length === 1 ? layer?.name || "" : "";
  $("layerOpacityInput").value = layer ? String(Math.round(layer.opacity * 100)) : "100";
  $("layerOpacityOutput").textContent = mixed("opacity") ? "Mixed" : `${$("layerOpacityInput").value}%`;
  $("layerFillInput").value = layer ? String(Math.round(layer.fillOpacity * 100)) : "100";
  $("layerFillOutput").textContent = mixed("fillOpacity") ? "Mixed" : `${$("layerFillInput").value}%`;
  $("layerClipInput").checked = Boolean(layer?.clipped);
  $("layerLockInput").checked = Boolean(layer?.lockFlags) && !mixed("lockFlags");
  $("layerLockInput").indeterminate = mixed("lockFlags");
  const blendSelect = $("layerBlendSelect");
  blendSelect.querySelectorAll("[data-current-mode]").forEach((option) => option.remove());
  if (layer && !blendModes.has(layer.blendMode)) {
    const option = new Option(`Engine mode ${layer.blendMode}`, String(layer.blendMode));
    option.dataset.currentMode = "true";
    blendSelect.prepend(option);
  }
  blendSelect.value = layer ? String(layer.blendMode) : "1";
  $("quickLayerOpacityInput").value = layer ? String(Math.round(layer.opacity * 100)) : "100";
  $("quickLayerFillInput").value = layer ? String(Math.round(layer.fillOpacity * 100)) : "100";
  $("quickLayerLockInput").checked = Boolean(layer?.lockFlags) && !mixed("lockFlags");
  $("quickLayerLockInput").indeterminate = mixed("lockFlags");
  const quickBlend = $("quickLayerBlendSelect");
  quickBlend.querySelectorAll("[data-current-mode]").forEach((option) => option.remove());
  if (layer && !blendModes.has(layer.blendMode)) {
    const option = new Option(`Engine mode ${layer.blendMode}`, String(layer.blendMode));
    option.dataset.currentMode = "true"; quickBlend.prepend(option);
  }
  quickBlend.value = layer ? String(layer.blendMode) : "1";
  updateControls();
}

function colorHex(color, fallback) {
  if (!Array.isArray(color) || color.length !== 3) return fallback;
  return `#${color.map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function setEffectBlend(id, value) {
  const select = $(id);
  select.querySelectorAll("[data-imported-mode]").forEach((option) => option.remove());
  if (![...select.options].some((option) => Number(option.value) === value)) {
    const option = new Option(`Imported mode ${value}`, String(value));
    option.dataset.importedMode = "true";
    select.append(option);
  }
  select.value = String(value);
}

function openLayerStyleDialog() {
  const style = selectedLayer()?.layerStyle;
  if (busy || !style) return;
  $("styleEffectsVisibleInput").checked = style.effectsVisible;
  $("styleMaskHidesInput").checked = style.layerMaskHidesEffects;
  const shadow = style.dropShadow;
  $("styleShadowEnabledInput").checked = Boolean(shadow?.enabled);
  setEffectBlend("styleShadowBlendInput", shadow?.blendMode ?? 2);
  $("styleShadowColorInput").value = colorHex(shadow?.color, "#000000");
  $("styleShadowOpacityInput").value = String(Math.round((shadow?.opacity ?? .75) * 100));
  $("styleShadowAngleInput").value = String(shadow?.angle ?? 120);
  $("styleShadowDistanceInput").value = String(shadow?.distance ?? 5);
  $("styleShadowSpreadInput").value = String(Math.round((shadow?.spread ?? 0) * 100));
  $("styleShadowSizeInput").value = String(shadow?.size ?? 5);
  $("styleShadowConcealsInput").checked = shadow?.layerConceals !== false;
  const innerShadow = style.innerShadow;
  $("styleInnerShadowEnabledInput").checked = Boolean(innerShadow?.enabled);
  setEffectBlend("styleInnerShadowBlendInput", innerShadow?.blendMode ?? 2);
  $("styleInnerShadowColorInput").value = colorHex(innerShadow?.color, "#000000");
  $("styleInnerShadowOpacityInput").value = String(Math.round((innerShadow?.opacity ?? .75) * 100));
  $("styleInnerShadowAngleInput").value = String(innerShadow?.angle ?? 120);
  $("styleInnerShadowDistanceInput").value = String(innerShadow?.distance ?? 5);
  $("styleInnerShadowChokeInput").value = String(Math.round((innerShadow?.choke ?? 0) * 100));
  $("styleInnerShadowSizeInput").value = String(innerShadow?.size ?? 5);
  const outerGlow = style.outerGlow;
  $("styleOuterGlowEnabledInput").checked = Boolean(outerGlow?.enabled);
  setEffectBlend("styleOuterGlowBlendInput", outerGlow?.blendMode ?? 1);
  $("styleOuterGlowColorInput").value = colorHex(outerGlow?.color, "#ffffbe");
  $("styleOuterGlowOpacityInput").value = String(Math.round((outerGlow?.opacity ?? .75) * 100));
  $("styleOuterGlowSpreadInput").value = String(Math.round((outerGlow?.spread ?? 0) * 100));
  $("styleOuterGlowSizeInput").value = String(outerGlow?.size ?? 5);
  $("styleOuterGlowTechniqueInput").value = String(outerGlow?.technique ?? 0);
  $("styleOuterGlowRangeInput").value = String(outerGlow?.range ?? 50);
  const innerGlow = style.innerGlow;
  $("styleInnerGlowEnabledInput").checked = Boolean(innerGlow?.enabled);
  setEffectBlend("styleInnerGlowBlendInput", innerGlow?.blendMode ?? 3);
  $("styleInnerGlowColorInput").value = colorHex(innerGlow?.color, "#ffffbe");
  $("styleInnerGlowOpacityInput").value = String(Math.round((innerGlow?.opacity ?? .75) * 100));
  $("styleInnerGlowChokeInput").value = String(Math.round((innerGlow?.choke ?? 0) * 100));
  $("styleInnerGlowSizeInput").value = String(innerGlow?.size ?? 5);
  $("styleInnerGlowSourceInput").value = String(innerGlow?.source ?? 1);
  $("styleInnerGlowTechniqueInput").value = String(innerGlow?.technique ?? 0);
  $("styleInnerGlowRangeInput").value = String(innerGlow?.range ?? 50);
  const satin = style.satin;
  $("styleSatinEnabledInput").checked = Boolean(satin?.enabled);
  setEffectBlend("styleSatinBlendInput", satin?.blendMode ?? 2);
  $("styleSatinColorInput").value = colorHex(satin?.color, "#000000");
  $("styleSatinOpacityInput").value = String(Math.round((satin?.opacity ?? .5) * 100));
  $("styleSatinAngleInput").value = String(satin?.angle ?? 19);
  $("styleSatinDistanceInput").value = String(satin?.distance ?? 11);
  $("styleSatinSizeInput").value = String(satin?.size ?? 14);
  $("styleSatinInvertInput").checked = satin?.invert !== false;
  const stroke = style.stroke;
  $("styleStrokeEnabledInput").checked = Boolean(stroke?.enabled);
  setEffectBlend("styleStrokeBlendInput", stroke?.blendMode ?? 1);
  $("styleStrokeColorInput").value = colorHex(stroke?.color, "#000000");
  $("styleStrokeOpacityInput").value = String(Math.round((stroke?.opacity ?? 1) * 100));
  $("styleStrokeSizeInput").value = String(stroke?.size ?? 3);
  $("styleStrokePositionInput").value = String(stroke?.position ?? 0);
  $("styleStrokeOverprintInput").checked = Boolean(stroke?.overprint);
  const overlay = style.colorOverlay;
  $("styleOverlayEnabledInput").checked = Boolean(overlay?.enabled);
  setEffectBlend("styleOverlayBlendInput", overlay?.blendMode ?? 1);
  $("styleOverlayColorInput").value = colorHex(overlay?.color, "#ff0000");
  $("styleOverlayOpacityInput").value = String(Math.round((overlay?.opacity ?? 1) * 100));
  const extras = Object.entries(style.counts || {}).filter(([, count]) => count > 1)
    .map(([family, count]) => `${family}: ${count - 1} additional`);
  $("styleStackedEffectsNote").textContent = extras.length
    ? `Imported stacked effects preserved — ${extras.join(", ")}.`
    : "The first instance of each common family is editable.";
  $("layerStyleDialog").showModal();
}

function essentialLayerStyleInput() {
  const form = $("layerStyleDialog").querySelector("form");
  if (!form.reportValidity()) return null;
  const percent = (id) => Number($(id).value) / 100;
  return {
    effectsVisible: $("styleEffectsVisibleInput").checked,
    layerMaskHidesEffects: $("styleMaskHidesInput").checked,
    dropShadow: $("styleShadowEnabledInput").checked ? {
      enabled: true, blendMode: Number($("styleShadowBlendInput").value),
      color: colorBytes($("styleShadowColorInput").value),
      opacity: percent("styleShadowOpacityInput"), angle: Number($("styleShadowAngleInput").value),
      distance: Number($("styleShadowDistanceInput").value),
      spread: percent("styleShadowSpreadInput"), size: Number($("styleShadowSizeInput").value),
      layerConceals: $("styleShadowConcealsInput").checked,
    } : null,
    innerShadow: $("styleInnerShadowEnabledInput").checked ? {
      enabled: true, blendMode: Number($("styleInnerShadowBlendInput").value),
      color: colorBytes($("styleInnerShadowColorInput").value),
      opacity: percent("styleInnerShadowOpacityInput"),
      angle: Number($("styleInnerShadowAngleInput").value),
      distance: Number($("styleInnerShadowDistanceInput").value),
      choke: percent("styleInnerShadowChokeInput"),
      size: Number($("styleInnerShadowSizeInput").value),
    } : null,
    outerGlow: $("styleOuterGlowEnabledInput").checked ? {
      enabled: true, blendMode: Number($("styleOuterGlowBlendInput").value),
      color: colorBytes($("styleOuterGlowColorInput").value),
      opacity: percent("styleOuterGlowOpacityInput"),
      spread: percent("styleOuterGlowSpreadInput"),
      size: Number($("styleOuterGlowSizeInput").value),
      technique: Number($("styleOuterGlowTechniqueInput").value),
      range: Number($("styleOuterGlowRangeInput").value),
    } : null,
    innerGlow: $("styleInnerGlowEnabledInput").checked ? {
      enabled: true, blendMode: Number($("styleInnerGlowBlendInput").value),
      color: colorBytes($("styleInnerGlowColorInput").value),
      opacity: percent("styleInnerGlowOpacityInput"),
      choke: percent("styleInnerGlowChokeInput"),
      size: Number($("styleInnerGlowSizeInput").value),
      source: Number($("styleInnerGlowSourceInput").value),
      technique: Number($("styleInnerGlowTechniqueInput").value),
      range: Number($("styleInnerGlowRangeInput").value),
    } : null,
    satin: $("styleSatinEnabledInput").checked ? {
      enabled: true, blendMode: Number($("styleSatinBlendInput").value),
      color: colorBytes($("styleSatinColorInput").value),
      opacity: percent("styleSatinOpacityInput"),
      angle: Number($("styleSatinAngleInput").value),
      distance: Number($("styleSatinDistanceInput").value),
      size: Number($("styleSatinSizeInput").value),
      invert: $("styleSatinInvertInput").checked,
    } : null,
    stroke: $("styleStrokeEnabledInput").checked ? {
      enabled: true, blendMode: Number($("styleStrokeBlendInput").value),
      color: colorBytes($("styleStrokeColorInput").value),
      opacity: percent("styleStrokeOpacityInput"), size: Number($("styleStrokeSizeInput").value),
      position: Number($("styleStrokePositionInput").value),
      overprint: $("styleStrokeOverprintInput").checked,
    } : null,
    colorOverlay: $("styleOverlayEnabledInput").checked ? {
      enabled: true, blendMode: Number($("styleOverlayBlendInput").value),
      color: colorBytes($("styleOverlayColorInput").value),
      opacity: percent("styleOverlayOpacityInput"),
    } : null,
  };
}

function renderStructure() {
  const channelList = $("channelList"); const pathList = $("pathList");
  channelList.replaceChildren(); pathList.replaceChildren();
  for (const channel of snapshot?.channels || []) {
    const button = document.createElement("button"); button.type = "button";
    button.textContent = channel.name || "Alpha channel";
    button.setAttribute("aria-pressed", String(channel.id === selectedChannelId));
    button.addEventListener("click", () => {
      selectedChannelId = channel.id; renderStructure(); updateControls();
      mutate("Loading channel selection", () => client.selectChannel(channel.id));
    });
    channelList.append(button);
  }
  for (const path of snapshot?.paths || []) {
    const button = document.createElement("button"); button.type = "button";
    button.textContent = path.name || (path.kind === 1 ? "Work path" : "Saved path");
    button.setAttribute("aria-pressed", String(path.id === selectedPathId));
    button.addEventListener("click", () => {
      selectedPathId = path.id; renderStructure(); updateControls();
      renderPenPath();
    });
    pathList.append(button);
  }
  const path = selectedPath(); const anchor = path?.anchors?.[0];
  $("pathAnchorXInput").value = anchor ? String(anchor.x) : "";
  $("pathAnchorYInput").value = anchor ? String(anchor.y) : "";
  $("pathClipButton").textContent = path?.clipping ? "Clear clipping" : "Set clipping";
  updateControls();
}

function renderMetadata() {
  $("stageMeta").hidden = !snapshot;
  $("documentName").textContent = documentName;
  $("documentMetrics").textContent = snapshot ? `${snapshot.width} × ${snapshot.height} px` : "";
  localizer.setText($("detailState"), snapshot
    ? (snapshot.dirty ? "Modified" : "Saved") : "No document");
  $("detailFormat").textContent = snapshot ? `${snapshot.bitDepth}-bit RGB` : "-";
  $("detailCanvas").textContent = snapshot ? `${snapshot.width} × ${snapshot.height}` : "-";
  $("detailRevision").textContent = snapshot ? String(snapshot.revision) : "-";
  const memory = snapshot?.memory;
  $("memoryLabel").textContent = memory
    ? `${formatBytes(memory.totalRetainedBytes)} retained · ${formatBytes(memory.historyRetainedBytes)} history · ${formatBytes(memory.renderCacheBytes)} cache · ${formatBytes(workingSetLimit)} limit · ${frameTransport === "bitmap" ? "bitmap frames" : frameTransport === "rgba" ? "RGBA fallback" : "frame transport waiting"}`
    : "Memory ready";
  updateControls();
}

function renderDocumentTabs() {
  const tabs = $("documentTabs");
  const restoreFocus = tabs.contains(document.activeElement);
  tabs.replaceChildren();
  const documents = snapshot?.documents || [];
  tabs.hidden = documents.length === 0;
  for (const documentTab of documents) {
    const item = document.createElement("span"); item.className = "document-tab";
    item.setAttribute("role", "presentation");
    item.dataset.active = String(documentTab.active);
    item.addEventListener("dragover", (event) => {
      if (!draggedLayer) return;
      event.preventDefault(); event.stopPropagation();
      item.dataset.dropTarget = "true";
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    item.addEventListener("dragleave", () => { delete item.dataset.dropTarget; });
    item.addEventListener("drop", (event) => {
      if (!draggedLayer) return;
      event.preventDefault(); event.stopPropagation(); delete item.dataset.dropTarget;
      transferLayerReference(draggedLayer, documentTab.id);
      draggedLayer = null;
    });
    const activate = document.createElement("button"); activate.type = "button";
    activate.setAttribute("role", "tab"); activate.setAttribute("aria-selected", String(documentTab.active));
    activate.setAttribute("aria-keyshortcuts", "Delete");
    activate.tabIndex = documentTab.active ? 0 : -1;
    activate.title = documentTab.name;
    activate.textContent = `${documentTab.dirty ? "• " : ""}${documentTab.name}`;
    activate.addEventListener("click", () => activateDocumentTab(documentTab.id));
    const close = document.createElement("button"); close.type = "button";
    close.tabIndex = -1; close.setAttribute("aria-hidden", "true");
    localizer.setAttribute(close, "aria-label", `Close ${documentTab.name}`); close.textContent = "×";
    close.addEventListener("click", () => closeDocumentTab(documentTab));
    item.append(activate, close); tabs.append(item);
  }
  localizer.localize(tabs);
  if (restoreFocus) tabs.querySelector('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
}

async function renderDocument() {
  if (!snapshot) return;
  const region = chooseRenderRegion(snapshot, renderedDocument && {
    ...renderedDocument, currentDocumentId: snapshot.documentId,
  });
  if (!region) {
    applyViewport(); renderSelection(); renderPenPath(); renderTransformOverlay(); return;
  }
  viewportDiagnostics.renderRequests++;
  const frame = await client.renderFrame(region);
  const expected = region.width * region.height * 4;
  if (frame.width !== region.width || frame.height !== region.height) {
    frame.bitmap?.close();
    throw new Error(`Engine returned a ${frame.width} × ${frame.height} frame, expected ${region.width} × ${region.height}`);
  }
  if (canvas.width !== snapshot.width || canvas.height !== snapshot.height ||
      renderedDocument?.documentId !== snapshot.documentId) {
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    $("gestureCanvas").width = snapshot.width;
    $("gestureCanvas").height = snapshot.height;
  }
  if (frame.kind === "bitmap") {
    frameTransport = "bitmap";
    try {
      // A partial frame is replacement RGBA, not a source-over overlay. Clear
      // the destination first so newly transparent Eraser pixels replace the
      // previous opaque canvas contents just like the RGBA putImageData path.
      context.clearRect(region.x, region.y, region.width, region.height);
      context.drawImage(frame.bitmap, region.x, region.y);
    }
    finally { frame.bitmap.close(); }
  } else if (frame.kind === "rgba") {
    if (frame.bytes.byteLength !== expected) {
      throw new Error(`Engine returned ${frame.bytes.byteLength} RGBA bytes, expected ${expected}`);
    }
    frameTransport = "rgba";
    const pixels = new Uint8ClampedArray(
      frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
    context.putImageData(new ImageData(pixels, region.width, region.height), region.x, region.y);
  } else {
    throw new Error(`Engine returned an unsupported frame transport: ${frame.kind}`);
  }
  renderedDocument = { documentId: snapshot.documentId, width: snapshot.width, height: snapshot.height };
  $("gestureCanvas").getContext("2d").clearRect(region.x, region.y, region.width, region.height);
  applyViewport();
  renderSelection();
  renderPenPath();
  renderTransformOverlay();
  await acceptSnapshot(await client.snapshot(), false);
}

function applyViewport() {
  if (!snapshot) return;
  const viewport = $("canvasViewport");
  if (zoomMode === "fit") {
    zoom = fitZoom(snapshot, { width: viewport.clientWidth, height: viewport.clientHeight }, 40);
  }
  $("canvasFrame").style.width = `${Math.max(1, snapshot.width * zoom)}px`;
  $("canvasFrame").style.height = `${Math.max(1, snapshot.height * zoom)}px`;
  $("zoomLabel").textContent = zoomMode === "fit" ? `Fit · ${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}%`;
  renderGuides();
  renderRulers();
}

function drawRuler(target, horizontal, viewportRect, frameRect) {
  const width = horizontal ? Math.max(1, Math.floor(viewportRect.width - 18)) : 18;
  const height = horizontal ? 18 : Math.max(1, Math.floor(viewportRect.height - 18));
  const ratio = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  target.style.width = `${width}px`; target.style.height = `${height}px`;
  target.width = Math.ceil(width * ratio); target.height = Math.ceil(height * ratio);
  const ruler = target.getContext("2d");
  ruler.setTransform(ratio, 0, 0, ratio, 0, 0);
  ruler.clearRect(0, 0, width, height);
  if (!snapshot || frameRect.width <= 0 || frameRect.height <= 0) return;
  const frameStart = horizontal ? frameRect.left : frameRect.top;
  const rulerStart = (horizontal ? viewportRect.left : viewportRect.top) + 18;
  const rulerLength = horizontal ? width : height;
  const documentOrigin = frameStart - rulerStart;
  const start = -documentOrigin / zoom;
  const end = (rulerLength - documentOrigin) / zoom;
  const ticks = rulerTicks({ start, end, zoom, screenOrigin: 0 });
  ruler.strokeStyle = "#7f8992"; ruler.fillStyle = "#aeb6bd";
  ruler.lineWidth = 1; ruler.font = "8px system-ui, sans-serif";
  ruler.beginPath();
  for (const tick of ticks) {
    const position = Math.round(tick.screen) + .5;
    if (horizontal) {
      ruler.moveTo(position, height); ruler.lineTo(position, 8);
      ruler.fillText(String(tick.value), position + 2, 8);
    } else {
      ruler.moveTo(width, position); ruler.lineTo(8, position);
      ruler.save(); ruler.translate(7, position + 2); ruler.rotate(-Math.PI / 2);
      ruler.fillText(String(tick.value), 0, 0); ruler.restore();
    }
  }
  ruler.stroke();
}

function renderRulers() {
  const viewport = $("canvasViewport");
  const viewportRect = viewport.getBoundingClientRect();
  const frameRect = $("canvasFrame").getBoundingClientRect();
  const offset = `translate(${viewport.scrollLeft}px, ${viewport.scrollTop}px)`;
  $("horizontalRuler").style.transform = offset;
  $("verticalRuler").style.transform = offset;
  drawRuler($("horizontalRuler"), true, viewportRect, frameRect);
  drawRuler($("verticalRuler"), false, viewportRect, frameRect);
}

function rememberViewport() {
  if (!snapshot) return;
  const viewport = $("canvasViewport");
  documentViewports.set(snapshot.documentId, {
    mode: zoomMode, zoom, left: viewport.scrollLeft, top: viewport.scrollTop,
  });
  viewportDiagnostics.trackedDocuments = documentViewports.size;
}

function flushViewportUpdate() {
  pendingViewportFrame = 0;
  const started = performance.now();
  const viewport = $("canvasViewport");
  const anchor = pendingViewportAnchor;
  pendingViewportAnchor = null;
  const before = anchor ? canvas.getBoundingClientRect() : null;
  applyViewport();
  if (anchor && before?.width > 0 && before?.height > 0) {
    const delta = anchoredScrollDelta(before, canvas.getBoundingClientRect(), anchor);
    viewport.scrollLeft += delta.x; viewport.scrollTop += delta.y;
  }
  if (pendingPan) {
    const bounded = clampScrollPosition(
      { x: pendingPan.left, y: pendingPan.top },
      { width: viewport.scrollWidth, height: viewport.scrollHeight },
      { width: viewport.clientWidth, height: viewport.clientHeight });
    viewport.scrollLeft = bounded.x; viewport.scrollTop = bounded.y;
    pendingPan = null;
  }
  renderRulers(); rememberViewport();
  viewportDiagnostics.updates++;
  viewportDiagnostics.samples.push(performance.now() - started);
  if (viewportDiagnostics.samples.length > 512) viewportDiagnostics.samples.shift();
}

function scheduleViewportUpdate(reason, anchor = null) {
  viewportDiagnostics.lastReason = reason;
  if (anchor) pendingViewportAnchor = anchor;
  if (!pendingViewportFrame) pendingViewportFrame = requestAnimationFrame(flushViewportUpdate);
}

function activeGuides(create = false) {
  if (!snapshot) return [];
  if (create && !documentGuides.has(snapshot.documentId)) documentGuides.set(snapshot.documentId, []);
  return documentGuides.get(snapshot.documentId) || [];
}

function setActiveGuides(guides) {
  if (!snapshot) return;
  documentGuides.set(snapshot.documentId, normalizeGuides(guides, snapshot.width, snapshot.height));
  renderGuides();
}

function removeGuide(guide) {
  setActiveGuides(activeGuides().filter((candidate) => candidate !== guide));
}

function parentRulerRects() {
  return {
    horizontal: $("horizontalRuler").getBoundingClientRect(),
    vertical: $("verticalRuler").getBoundingClientRect(),
  };
}

function beginGuideDrag(guide, event, captureTarget, { created = false } = {}) {
  if (!snapshot || event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const originalPosition = guide.position;
  let enteredCanvas = !created;
  let removeOnRelease = false;
  captureTarget.dataset.dragging = "true";
  captureTarget.setPointerCapture?.(event.pointerId);
  const lineForGuide = [...$("guidesOverlay").querySelectorAll(".guide-line")].find((candidate) =>
    candidate.dataset.orientation === guide.orientation && Number(candidate.dataset.position) === guide.position);
  const update = (nextEvent) => {
    const rulers = parentRulerRects();
    removeOnRelease = pointInGuideParentRuler(guide.orientation,
      { x: nextEvent.clientX, y: nextEvent.clientY }, rulers.horizontal, rulers.vertical);
    if (!removeOnRelease) {
      enteredCanvas = true;
      guide.position = guidePositionFromPointer(guide.orientation,
        { x: nextEvent.clientX, y: nextEvent.clientY }, canvas.getBoundingClientRect(), snapshot);
    }
    const line = lineForGuide;
    if (line) {
      line.dataset.remove = String(removeOnRelease);
      line.dataset.position = String(guide.position);
      const limit = guide.orientation === "vertical" ? snapshot.width : snapshot.height;
      line.style[guide.orientation === "vertical" ? "left" : "top"] = `${guide.position / limit * 100}%`;
      line.setAttribute("aria-label", guideAccessibleText(guide));
      line.title = removeOnRelease ? localizer.text("Release to remove guide") : guideAccessibleText(guide, true);
    }
  };
  const cleanup = () => {
    captureTarget.removeEventListener("pointermove", update);
    captureTarget.removeEventListener("pointerup", finish);
    captureTarget.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", keydown, true);
    delete captureTarget.dataset.dragging;
  };
  const cancel = () => {
    cleanup();
    if (created) removeGuide(guide);
    else { guide.position = originalPosition; setActiveGuides(activeGuides()); }
  };
  const finish = (nextEvent) => {
    update(nextEvent); cleanup();
    if (!enteredCanvas || removeOnRelease) removeGuide(guide);
    else setActiveGuides(activeGuides());
  };
  const keydown = (keyEvent) => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault(); cancel();
  };
  captureTarget.addEventListener("pointermove", update);
  captureTarget.addEventListener("pointerup", finish);
  captureTarget.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", keydown, true);
}

function createGuideFromRuler(orientation, event) {
  if (!snapshot || busy || event.button !== 0) return;
  guidesVisible = true;
  const position = guidePositionFromPointer(orientation,
    { x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), snapshot);
  setActiveGuides([...activeGuides(true), { orientation, position }]);
  const guide = activeGuides().find((candidate) =>
    candidate.orientation === orientation && candidate.position === position);
  if (guide) beginGuideDrag(guide, event, event.currentTarget, { created: true });
}

function guideAccessibleText(guide, includeHint = false) {
  const orientation = localizer.text(
    guide.orientation === "vertical" ? "Vertical guide" : "Horizontal guide");
  const position = `${guide.position} ${localizer.text("pixels")}`;
  return includeHint
    ? `${orientation} · ${position} · ${localizer.text("drag or press Delete")}`
    : `${orientation}: ${position}`;
}

function renderGuides() {
  const overlay = $("guidesOverlay");
  overlay.replaceChildren();
  overlay.hidden = !snapshot || !guidesVisible;
  const guides = snapshot
    ? normalizeGuides(activeGuides(), snapshot.width, snapshot.height)
    : [];
  if (snapshot) documentGuides.set(snapshot.documentId, guides);
  for (const guide of guides) {
    const line = document.createElement("button");
    line.type = "button"; line.className = "guide-line";
    line.dataset.orientation = guide.orientation;
    line.dataset.position = String(guide.position);
    line.setAttribute("aria-label", guideAccessibleText(guide));
    line.title = guideAccessibleText(guide, true);
    line.style[guide.orientation === "vertical" ? "left" : "top"] =
      `${guide.position / (guide.orientation === "vertical" ? snapshot.width : snapshot.height) * 100}%`;
    line.addEventListener("keydown", (event) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      event.preventDefault(); removeGuide(guide);
    });
    line.addEventListener("dblclick", (event) => { event.stopPropagation(); removeGuide(guide); });
    line.addEventListener("pointerdown", (event) => {
      beginGuideDrag(guide, event, line);
    });
    overlay.append(line);
  }
  $("addVerticalGuideButton").disabled = !snapshot;
  $("addHorizontalGuideButton").disabled = !snapshot;
  $("clearGuidesButton").disabled = !snapshot || activeGuides().length === 0;
  $("toggleGuidesButton").setAttribute("aria-pressed", String(guidesVisible));
  $("toggleSnapButton").setAttribute("aria-pressed", String(snappingEnabled));
}

function addCenteredGuide(orientation) {
  if (!snapshot) return;
  const position = Math.round((orientation === "vertical" ? snapshot.width : snapshot.height) / 2);
  setActiveGuides([...activeGuides(true), { orientation, position }]);
  $("guidesOverlay").querySelector(`.guide-line[data-orientation="${orientation}"]`)?.focus();
}

function renderSelection(rect = marqueeDraft) {
  const overlay = $("selectionOverlay");
  if (cropDraft || transformDialogDraft) { overlay.setAttribute("hidden", ""); return; }
  if (canvasTool === "quickMask") { overlay.setAttribute("hidden", ""); renderQuickMask(); return; }
  if (!snapshot || (!rect && !snapshot.selection?.length)) { overlay.setAttribute("hidden", ""); return; }
  const path = rect ? rectanglePath(rect) : selectionPath();
  if (!path?.subpaths?.length) { overlay.setAttribute("hidden", ""); return; }
  const data = path.subpaths.map(({ anchors, closed }) => anchors.length
    ? `M ${anchors.map((point) => `${point.x} ${point.y}`).join(" L ")}${closed ? " Z" : ""}`
    : "").filter(Boolean).join(" ");
  overlay.setAttribute("viewBox", `0 0 ${snapshot.width} ${snapshot.height}`);
  $("selectionShadowPath").setAttribute("d", data);
  $("selectionMarchPath").setAttribute("d", data);
  overlay.removeAttribute("hidden");
}

function geometryHud(bounds, label = "") {
  const hud = $("geometryHud");
  if (!snapshot || !bounds) { hud.hidden = true; return; }
  hud.textContent = `${label ? `${label} · ` : ""}${Math.round(bounds.width)} × ${Math.round(bounds.height)} px`;
  hud.style.left = `${Math.min(96, Math.max(2, (bounds.x + bounds.width) / snapshot.width * 100))}%`;
  hud.style.top = `${Math.min(96, Math.max(2, (bounds.y + bounds.height) / snapshot.height * 100))}%`;
  hud.hidden = false;
}

function cropRatio() {
  if (!snapshot) return null;
  const value = $("cropRatioInput").value;
  if (value === "original") return snapshot.width / snapshot.height;
  if (value.includes(":")) {
    const [width, height] = value.split(":").map(Number);
    if (width > 0 && height > 0) return width / height;
  }
  return null;
}

function constrainedCrop(start, point) {
  let deltaX = point.x - start.x; let deltaY = point.y - start.y;
  const ratio = cropRatio();
  if (ratio) {
    const signX = Math.sign(deltaX) || 1; const signY = Math.sign(deltaY) || 1;
    if (Math.abs(deltaX) / Math.max(1, Math.abs(deltaY)) > ratio) deltaY = signY * Math.abs(deltaX) / ratio;
    else deltaX = signX * Math.abs(deltaY) * ratio;
  }
  const target = { x: Math.min(start.x, start.x + deltaX), y: Math.min(start.y, start.y + deltaY),
    width: Math.abs(deltaX), height: Math.abs(deltaY) };
  const x = Math.max(0, Math.floor(target.x)); const y = Math.max(0, Math.floor(target.y));
  return { x, y, width: Math.max(1, Math.min(snapshot.width - x, Math.ceil(target.width))),
    height: Math.max(1, Math.min(snapshot.height - y, Math.ceil(target.height))) };
}

function renderCropOverlay() {
  const overlay = $("cropOverlay");
  if (!snapshot || !cropDraft) {
    overlay.setAttribute("hidden", ""); $("applyCropButton").disabled = true; $("cancelCropButton").disabled = true;
    if (!transformDialogDraft) geometryHud(null);
    renderSelection();
    return;
  }
  const { x, y, width, height } = cropDraft; const right = x + width; const bottom = y + height;
  overlay.setAttribute("viewBox", `0 0 ${snapshot.width} ${snapshot.height}`);
  $("cropDimPath").setAttribute("d", `M0 0H${snapshot.width}V${snapshot.height}H0Z M${x} ${y}V${bottom}H${right}V${y}Z`);
  for (const [attribute, value] of Object.entries({ x, y, width, height })) $("cropBoundary").setAttribute(attribute, String(value));
  $("cropGrid").setAttribute("d", `M${x + width / 3} ${y}V${bottom} M${x + width * 2 / 3} ${y}V${bottom} M${x} ${y + height / 3}H${right} M${x} ${y + height * 2 / 3}H${right}`);
  const positions = [[x, y], [x + width / 2, y], [right, y], [right, y + height / 2],
    [right, bottom], [x + width / 2, bottom], [x, bottom], [x, y + height / 2]];
  [...$("cropHandles").querySelectorAll("circle")].forEach((handle, index) => {
    handle.setAttribute("cx", String(positions[index][0])); handle.setAttribute("cy", String(positions[index][1]));
    handle.setAttribute("r", String(Math.max(3, 5 / Math.max(zoom, .05))));
  });
  overlay.removeAttribute("hidden"); $("applyCropButton").disabled = false; $("cancelCropButton").disabled = false;
  renderSelection();
  geometryHud(cropDraft, "Crop");
}

function renderQuickMask(gray = null) {
  const overlay = $("gestureCanvas");
  const target = overlay.getContext("2d");
  target.clearRect(0, 0, overlay.width, overlay.height);
  if (!snapshot || canvasTool !== "quickMask") return;
  gray ??= fullSelectionMask();
  const image = target.createImageData(snapshot.width, snapshot.height);
  for (let index = 0; index < gray.length; ++index) {
    image.data[index * 4] = 232; image.data[index * 4 + 1] = 38;
    image.data[index * 4 + 2] = 80;
    image.data[index * 4 + 3] = Math.round((255 - gray[index]) * .48);
  }
  target.putImageData(image, 0, 0);
}

function setCanvasTool(tool) {
  if (tool !== "pen") { penDraft = null; penHoverPoint = null; previewPolygon([]); }
  if (tool !== "magnetic") magneticDraft = null;
  if (tool !== "quickSelect") quickSelectDraft = null;
  if (tool !== "quickMask") quickMaskDraft = null;
  if (tool !== "crop" && cropDraft) { cropDraft = null; renderCropOverlay(); }
  canvasTool = tool;
  $("canvasViewport").dataset.tool = tool;
  let activeToolButton = null;
  for (const [id, value] of [["moveToolButton", "move"], ["cropToolButton", "crop"],
    ["marqueeToolButton", "marquee"],
    ["lassoToolButton", "lasso"], ["polygonToolButton", "polygon"], ["magicToolButton", "magic"],
    ["quickSelectToolButton", "quickSelect"], ["magneticToolButton", "magnetic"],
    ["quickMaskToolButton", "quickMask"],
    ["panToolButton", "pan"], ["brushToolButton", "brush"],
    ["mixerToolButton", "mixer"], ["patternStampToolButton", "patternStamp"],
    ["eraserToolButton", "eraser"], ["cloneToolButton", "clone"],
    ["healToolButton", "heal"], ["spotHealingToolButton", "spotHealing"],
    ["patchToolButton", "patch"], ["smudgeToolButton", "smudge"],
    ["dodgeToolButton", "dodge"], ["burnToolButton", "burn"],
    ["spongeToolButton", "sponge"], ["blurToolButton", "blur"],
    ["sharpenToolButton", "sharpen"], ["gradientToolButton", "gradient"], ["penToolButton", "pen"],
    ["textToolButton", "text"]]) {
    $(id).setAttribute("aria-pressed", String(tool === value));
    if (tool === value) activeToolButton = $(id);
  }
  commandSurface?.toolGroups?.promote(activeToolButton);
  workspaceContext?.render(tool);
  renderCropOverlay();
  renderPenPath();
  if (tool === "quickMask") renderQuickMask();
  else if (quickMaskDraft == null) $("gestureCanvas").getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  syncToolRoving(document.querySelector('.tool-rail [aria-pressed="true"]') || document.activeElement);
  updateControls();
  persistPreferences();
}

function fullSelectionMask() {
  const gray = new Uint8Array(snapshot.width * snapshot.height);
  if (snapshot.selectionMask) {
    const { bounds, gray: source } = snapshot.selectionMask;
    for (let y = 0; y < bounds.height; ++y) {
      gray.set(source.subarray(y * bounds.width, (y + 1) * bounds.width),
        (bounds.y + y) * snapshot.width + bounds.x);
    }
  } else {
    for (const rect of snapshot.selection || []) {
      for (let y = rect.y; y < rect.y + rect.height; ++y) {
        gray.fill(255, y * snapshot.width + rect.x, y * snapshot.width + rect.x + rect.width);
      }
    }
  }
  return gray;
}

function commitSelectionMask(title, gray) {
  const feather = Number($("selectionQuickFeatherInput").value);
  return mutate(title, async () => {
    let next = await client.setSelectionMask(
      { x: 0, y: 0, width: snapshot.width, height: snapshot.height }, gray,
      { transferOwnership: true });
    if (Number.isFinite(feather) && feather > 0) next = await client.refineSelection({
      smooth: 0, feather: Math.min(250, feather), contrast: 0, shiftEdge: 0,
      output: "selection", layerId: null,
      expectedStateId: next.stateId, expectedRevision: next.revision,
    });
    return next;
  });
}

function selectionRefinementInput({ report = false } = {}) {
  if (!selectionRefinementDraft) return null;
  const values = {
    smooth: Number($("selectionSmoothInput").value),
    feather: Number($("selectionFeatherInput").value),
    contrast: Number($("selectionContrastInput").value),
    shiftEdge: Number($("selectionShiftInput").value),
  };
  const valid = Number.isInteger(values.smooth) && values.smooth >= 0 && values.smooth <= 250 &&
    Number.isFinite(values.feather) && values.feather >= 0 && values.feather <= 250 &&
    Number.isInteger(values.contrast) && values.contrast >= 0 && values.contrast <= 100 &&
    Number.isInteger(values.shiftEdge) && values.shiftEdge >= -250 && values.shiftEdge <= 250 &&
    (values.smooth !== 0 || values.feather !== 0 || values.contrast !== 0 || values.shiftEdge !== 0);
  if (!valid) {
    if (report) $("selectionRefinementStatus").textContent =
      "Use bounded values and change at least one refinement setting.";
    return null;
  }
  const output = $("selectionOutputInput").value;
  const layerId = output === "layerMask" ? BigInt($("selectionLayerInput").value || 0) : null;
  if (output === "layerMask" && layerId <= 0n) {
    if (report) $("selectionRefinementStatus").textContent = "Choose a non-group target layer.";
    return null;
  }
  return { ...values, output, layerId,
    expectedStateId: selectionRefinementDraft.stateId,
    expectedRevision: selectionRefinementDraft.revision };
}

function clearSelectionRefinementPreview() {
  ++selectionRefinementGeneration;
  if (selectionRefinementPreviewTimer) {
    clearTimeout(selectionRefinementPreviewTimer);
    selectionRefinementPreviewTimer = 0;
  }
  if (selectionRefinementCancellation) {
    Atomics.store(selectionRefinementCancellation, 0, 1);
    selectionRefinementCancellation = null;
  }
  const target = $("gestureCanvas").getContext("2d");
  target.clearRect(0, 0, $("gestureCanvas").width, $("gestureCanvas").height);
}

async function runSelectionRefinementPreview(input, generation) {
  selectionRefinementPreviewTimer = 0;
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  selectionRefinementCancellation = cancellation;
  try {
    const preview = await client.previewSelectionRefinement({ ...input, cancellation });
    if (generation !== selectionRefinementGeneration ||
        !$("selectionRefinementDialog").open) return;
    const overlay = $("gestureCanvas");
    const target = overlay.getContext("2d");
    target.clearRect(0, 0, overlay.width, overlay.height);
    const image = target.createImageData(preview.bounds.width, preview.bounds.height);
    for (let index = 0; index < preview.gray.length; ++index) {
      image.data[index * 4] = 52;
      image.data[index * 4 + 1] = 168;
      image.data[index * 4 + 2] = 255;
      image.data[index * 4 + 3] = Math.round(preview.gray[index] * .55);
    }
    target.putImageData(image, preview.bounds.x, preview.bounds.y);
    $("selectionRefinementStatus").textContent =
      `Live engine preview · ${preview.bounds.width} × ${preview.bounds.height}px`;
  } catch (error) {
    if (generation !== selectionRefinementGeneration || error.code === 7) return;
    clearSelectionRefinementPreview();
    $("selectionRefinementStatus").textContent = error.message;
    $("commitSelectionRefinementButton").disabled = true;
  } finally {
    if (selectionRefinementCancellation === cancellation) {
      selectionRefinementCancellation = null;
    }
  }
}

function previewSelectionRefinement({ immediate = false } = {}) {
  const input = selectionRefinementInput();
  const generation = ++selectionRefinementGeneration;
  if (selectionRefinementPreviewTimer) clearTimeout(selectionRefinementPreviewTimer);
  selectionRefinementPreviewTimer = 0;
  if (selectionRefinementCancellation) {
    Atomics.store(selectionRefinementCancellation, 0, 1);
    selectionRefinementCancellation = null;
  }
  $("commitSelectionRefinementButton").disabled = !input;
  if (!input) {
    const target = $("gestureCanvas").getContext("2d");
    target.clearRect(0, 0, $("gestureCanvas").width, $("gestureCanvas").height);
    $("selectionRefinementStatus").textContent =
      "Use bounded values and change at least one refinement setting.";
    return;
  }
  $("selectionRefinementStatus").textContent = "Rendering engine preview…";
  selectionRefinementPreviewTimer = setTimeout(
    () => runSelectionRefinementPreview(input, generation), immediate ? 0 : 75);
}

function openSelectionRefinementDialog() {
  if (busy || !snapshot?.selection?.length) return;
  selectionRefinementDraft = { stateId: snapshot.stateId, revision: snapshot.revision };
  const target = $("selectionLayerInput");
  target.replaceChildren();
  for (const layer of [...snapshot.layers].reverse().filter((item) => item.kind !== 1)) {
    const option = document.createElement("option");
    option.value = String(layer.id); option.textContent = layer.name;
    option.selected = layer.id === selectedLayerId;
    target.append(option);
  }
  $("selectionOutputInput").value = "selection";
  $("selectionLayerField").hidden = true;
  $("selectionRefinementDialog").showModal();
  previewSelectionRefinement({ immediate: true });
}

function combinedSelectionMask(next, mode = "replace") {
  if (mode === "replace") return next;
  const current = fullSelectionMask();
  for (let index = 0; index < next.length; ++index) {
    if (mode === "add") next[index] = Math.max(current[index], next[index]);
    else if (mode === "subtract") next[index] = Math.round(current[index] * (255 - next[index]) / 255);
    else next[index] = Math.min(current[index], next[index]);
  }
  return next;
}

function selectionMode(event) {
  return event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : event.altKey ? "subtract" :
    ($("selectionModeInput").value || "replace");
}

function selectionCombineValue(mode) {
  return ({ replace: 0, add: 1, subtract: 2, intersect: 3 })[mode] ?? 0;
}

function paintMaskPoint(gray, point, radius, value) {
  const centerX = Math.round(point.x); const centerY = Math.round(point.y);
  for (let y = Math.max(0, centerY - radius); y <= Math.min(snapshot.height - 1, centerY + radius); ++y) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(snapshot.width - 1, centerX + radius); ++x) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) gray[y * snapshot.width + x] = value;
    }
  }
}

function polygonMask(points) {
  const target = document.createElement("canvas"); target.width = snapshot.width; target.height = snapshot.height;
  const targetContext = target.getContext("2d", { alpha: true, willReadFrequently: true });
  targetContext.fillStyle = "#fff"; targetContext.beginPath();
  targetContext.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) targetContext.lineTo(point.x, point.y);
  targetContext.closePath(); targetContext.fill();
  const rgba = targetContext.getImageData(0, 0, snapshot.width, snapshot.height).data;
  const gray = new Uint8Array(snapshot.width * snapshot.height);
  for (let index = 0; index < gray.length; ++index) gray[index] = rgba[index * 4 + 3];
  return gray;
}

function rectangleMask(rect) {
  const gray = new Uint8Array(snapshot.width * snapshot.height);
  const left = Math.max(0, Math.floor(rect.x)); const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(snapshot.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(snapshot.height, Math.ceil(rect.y + rect.height));
  for (let y = top; y < bottom; ++y) gray.fill(255, y * snapshot.width + left, y * snapshot.width + right);
  return gray;
}

function previewPolygon(points, closed = false) {
  const overlay = $("gestureCanvas").getContext("2d");
  overlay.clearRect(0, 0, canvas.width, canvas.height);
  if (!points.length) return;
  overlay.strokeStyle = "#fff"; overlay.lineWidth = Math.max(1, 1 / zoom);
  overlay.setLineDash([Math.max(2, 4 / zoom), Math.max(2, 4 / zoom)]);
  overlay.beginPath(); overlay.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) overlay.lineTo(point.x, point.y);
  if (closed) overlay.closePath(); overlay.stroke(); overlay.setLineDash([]);
}

function vectorPathData(subpaths) {
  const commands = [];
  for (const subpath of subpaths || []) {
    const anchors = subpath.anchors || [];
    if (!anchors.length) continue;
    commands.push(`M${anchors[0].x} ${anchors[0].y}`);
    for (let index = 1; index < anchors.length; ++index) {
      const previous = anchors[index - 1]; const anchor = anchors[index];
      commands.push(`C${previous.outX ?? previous.x} ${previous.outY ?? previous.y} ` +
        `${anchor.inX ?? anchor.x} ${anchor.inY ?? anchor.y} ${anchor.x} ${anchor.y}`);
    }
    if (subpath.closed && anchors.length > 1) {
      const previous = anchors.at(-1); const anchor = anchors[0];
      commands.push(`C${previous.outX ?? previous.x} ${previous.outY ?? previous.y} ` +
        `${anchor.inX ?? anchor.x} ${anchor.inY ?? anchor.y} ${anchor.x} ${anchor.y}Z`);
    }
  }
  return commands.join(" ");
}

function penCloseTarget(point) {
  if (!point || !snapshot || (penDraft?.points.length || 0) < 3) return false;
  const first = penDraft.points[0];
  const bounds = canvas.getBoundingClientRect();
  if (!(bounds.width > 0) || !(bounds.height > 0)) return false;
  const screenX = (point.x - first.x) * bounds.width / snapshot.width;
  const screenY = (point.y - first.y) * bounds.height / snapshot.height;
  return Math.hypot(screenX, screenY) <= 10;
}

function renderPenPath() {
  const overlay = $("pathOverlay");
  const committed = canvasTool === "pen" ? selectedPath() : null;
  const subpaths = penDraft?.points.length
    ? [{ anchors: penDraft.points, closed: Boolean(penDraft.closed) }]
    : committed?.subpaths;
  const anchors = (subpaths || []).flatMap((subpath) => subpath.anchors || []);
  const closeTarget = penCloseTarget(penHoverPoint);
  overlay.dataset.closeTarget = String(closeTarget);
  if (closeTarget) $("canvasViewport").dataset.penClose = "true";
  else delete $("canvasViewport").dataset.penClose;
  if (!snapshot || canvasTool !== "pen" || !anchors.length) {
    overlay.setAttribute("hidden", ""); $("pathOverlayLine").setAttribute("d", "");
    $("pathOverlayRubberBand").setAttribute("d", "");
    $("pathOverlayAnchors").replaceChildren(); return;
  }
  overlay.setAttribute("viewBox", `0 0 ${snapshot.width} ${snapshot.height}`);
  $("pathOverlayLine").setAttribute("d", vectorPathData(subpaths));
  const rubberStart = penDraft?.points.at(-1);
  const rubberEnd = closeTarget ? penDraft.points[0] : penHoverPoint;
  $("pathOverlayRubberBand").setAttribute("d", rubberStart && rubberEnd
    ? `M${rubberStart.x} ${rubberStart.y}L${rubberEnd.x} ${rubberEnd.y}` : "");
  const radius = Math.max(2.5, 4 / Math.max(zoom, .05));
  const nodes = anchors.map((anchor, index) => {
    const circle = document.createElementNS(overlay.namespaceURI, "circle");
    circle.setAttribute("cx", String(anchor.x)); circle.setAttribute("cy", String(anchor.y));
    if (index === 0 && closeTarget) circle.setAttribute("class", "path-close-target");
    circle.setAttribute("r", String(radius)); return circle;
  });
  $("pathOverlayAnchors").replaceChildren(...nodes); overlay.removeAttribute("hidden");
}

function magicMask(point) {
  const pixels = context.getImageData(0, 0, snapshot.width, snapshot.height).data;
  const x = Math.min(snapshot.width - 1, Math.max(0, Math.floor(point.x)));
  const y = Math.min(snapshot.height - 1, Math.max(0, Math.floor(point.y)));
  const seed = (y * snapshot.width + x) * 4;
  const target = [pixels[seed], pixels[seed + 1], pixels[seed + 2], pixels[seed + 3]];
  const tolerance = Number($("selectionToleranceInput").value); const limit = tolerance * tolerance * 4;
  const gray = new Uint8Array(snapshot.width * snapshot.height); const queue = [y * snapshot.width + x]; gray[queue[0]] = 255;
  const matches = (index) => { let distance = 0; const offset = index * 4;
    for (let channel = 0; channel < 4; ++channel) { const delta = pixels[offset + channel] - target[channel]; distance += delta * delta; }
    return distance <= limit; };
  for (let offset = 0; offset < queue.length; ++offset) {
    const index = queue[offset]; const px = index % snapshot.width; const py = Math.floor(index / snapshot.width);
    for (const next of [px > 0 ? index - 1 : -1, px + 1 < snapshot.width ? index + 1 : -1,
      py > 0 ? index - snapshot.width : -1, py + 1 < snapshot.height ? index + snapshot.width : -1]) {
      if (next >= 0 && gray[next] === 0 && matches(next)) { gray[next] = 255; queue.push(next); }
    }
  }
  return gray;
}

function quadFromBounds(bounds) {
  return [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y,
    bounds.x + bounds.width, bounds.y + bounds.height, bounds.x, bounds.y + bounds.height];
}

function renderTransformOverlay(quad = moveDraft?.quad || transformDraft?.quad || transformDialogDraft?.quad) {
  const overlay = $("transformOverlay");
  if (!snapshot || !quad) {
    overlay.setAttribute("hidden", ""); $("applyTransformButton").disabled = true; $("cancelTransformButton").disabled = true;
    if (!cropDraft) geometryHud(null);
    renderSelection();
    return;
  }
  overlay.setAttribute("viewBox", `0 0 ${snapshot.width} ${snapshot.height}`);
  $("transformPolygon").setAttribute("points", Array.from({ length: 4 }, (_, index) =>
    `${quad[index * 2]},${quad[index * 2 + 1]}`).join(" "));
  const pointForHandle = (name) => {
    if (name?.startsWith("corner-")) {
      const index = Number(name.slice(7)); return [quad[index * 2], quad[index * 2 + 1]];
    }
    const pairs = { "edge-top": [0, 1], "edge-right": [1, 2], "edge-bottom": [2, 3], "edge-left": [3, 0] };
    const pair = pairs[name];
    if (!pair) return [quad.filter((_, index) => index % 2 === 0).reduce((a, b) => a + b, 0) / 4,
      quad.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b, 0) / 4];
    return [(quad[pair[0] * 2] + quad[pair[1] * 2]) / 2,
      (quad[pair[0] * 2 + 1] + quad[pair[1] * 2 + 1]) / 2];
  };
  [...overlay.querySelectorAll("circle")].forEach((handle) => {
    const [x, y] = pointForHandle(handle.dataset.transformHandle);
    handle.setAttribute("cx", String(x));
    handle.setAttribute("cy", String(y));
    handle.setAttribute("r", String(Math.max(3, 6 / Math.max(zoom, .05))));
  });
  overlay.removeAttribute("hidden"); $("applyTransformButton").disabled = !transformDialogDraft;
  $("cancelTransformButton").disabled = !transformDialogDraft;
  renderSelection();
  const xs = quad.filter((_, index) => index % 2 === 0); const ys = quad.filter((_, index) => index % 2 === 1);
  geometryHud({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys) }, "Transform");
}

function clearTransformPreview(clearOverlay = false) {
  ++transformPreviewGeneration; transformPreviewPending = null;
  if (transformPreviewCancellation) Atomics.store(transformPreviewCancellation, 0, 1);
  transformPreviewCancellation = null;
  if (transformPreviewRestore) {
    context.putImageData(transformPreviewRestore.pixels,
      transformPreviewRestore.region.x, transformPreviewRestore.region.y);
    transformPreviewRestore = null;
  }
  $("gestureCanvas").getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  if (clearOverlay) {
    transformDraft = null; transformDialogDraft = null; renderTransformOverlay(null);
  }
}

async function drainTransformPreview() {
  if (transformPreviewInFlight) return;
  transformPreviewInFlight = true;
  try {
    while (transformPreviewPending) {
      const pending = transformPreviewPending; transformPreviewPending = null;
      try {
        const preview = pending.warp
          ? await client.previewLayerWarp({ ...pending.warp,
            layerId: pending.layer.id, expectedStateId: pending.stateId,
            expectedRevision: pending.revision, cancellation: pending.cancellation })
          : pending.batch
            ? await client.previewLayersTransform({ layerIds: pending.layerIds,
              quad: pending.quad, interpolation: 1, expectedStateId: pending.stateId,
              expectedRevision: pending.revision, cancellation: pending.cancellation })
            : await client.previewLayerTransform({ layerId: pending.layer.id,
            quad: pending.quad, interpolation: 1, expectedStateId: pending.stateId,
            expectedRevision: pending.revision, cancellation: pending.cancellation });
        if (pending.generation !== transformPreviewGeneration || transformPreviewPending) continue;
        if (transformPreviewRestore) {
          context.putImageData(transformPreviewRestore.pixels,
            transformPreviewRestore.region.x, transformPreviewRestore.region.y);
          transformPreviewRestore = null;
        }
        if (preview.region.width <= 0 || preview.region.height <= 0) continue;
        transformPreviewRestore = { region: preview.region,
          pixels: context.getImageData(preview.region.x, preview.region.y,
            preview.region.width, preview.region.height) };
        context.putImageData(new ImageData(new Uint8ClampedArray(
          preview.rgba.buffer, preview.rgba.byteOffset, preview.rgba.byteLength),
        preview.region.width, preview.region.height), preview.region.x, preview.region.y);
      } catch (error) {
        if (error?.code !== 7 && pending.generation === transformPreviewGeneration) {
          showError("Transform preview failed", error);
        }
      }
    }
  } finally { transformPreviewInFlight = false; }
}

function scheduleTransformPreview(target, quad) {
  const layer = target?.primary || target;
  if (!snapshot || !layer || quad.some((value) => !Number.isFinite(value))) return;
  if (transformPreviewCancellation) Atomics.store(transformPreviewCancellation, 0, 1);
  transformPreviewCancellation = new Int32Array(new SharedArrayBuffer(4));
  const generation = ++transformPreviewGeneration;
  transformPreviewPending = { layer, layerIds: target?.layerIds || [layer.id],
    batch: Boolean(target?.batch), quad: [...quad],
    stateId: target?.stateId ?? snapshot.stateId,
    revision: target?.revision ?? snapshot.revision, generation,
    cancellation: transformPreviewCancellation };
  drainTransformPreview();
}

function layerWarpPayload() {
  const values = [Number($("layerWarpBendInput").value),
    Number($("layerWarpHorizontalInput").value), Number($("layerWarpVerticalInput").value)];
  const style = Number($("layerWarpStyleInput").value);
  if (!Number.isInteger(style) || style < 0 || style > 14 ||
      values.some((value) => !Number.isFinite(value) || value < -100 || value > 100)) return null;
  return { style, bend: values[0], horizontalDistortion: values[1],
    verticalDistortion: values[2], rotateVertical: $("layerWarpRotateInput").checked,
    interpolation: 1 };
}

function scheduleWarpPreview() {
  if (!snapshot || !warpDialogDraft) return;
  const warp = layerWarpPayload(); if (!warp) return;
  if (transformPreviewCancellation) Atomics.store(transformPreviewCancellation, 0, 1);
  transformPreviewCancellation = new Int32Array(new SharedArrayBuffer(4));
  transformPreviewPending = { layer: warpDialogDraft.layer, warp,
    stateId: snapshot.stateId, revision: snapshot.revision,
    generation: ++transformPreviewGeneration, cancellation: transformPreviewCancellation };
  drainTransformPreview();
}

function setZoom(next, anchor = null) {
  zoomMode = next === "fit" ? "fit" : "manual";
  if (next !== "fit") zoom = clampZoom(next);
  const viewport = $("canvasViewport");
  scheduleViewportUpdate("zoom", anchor || {
    x: viewport.getBoundingClientRect().left + viewport.clientWidth / 2,
    y: viewport.getBoundingClientRect().top + viewport.clientHeight / 2,
  });
}

function canvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(snapshot.width, (event.clientX - bounds.left) / bounds.width * snapshot.width)),
    y: Math.max(0, Math.min(snapshot.height, (event.clientY - bounds.top) / bounds.height * snapshot.height)),
  };
}

function canvasPointUnclamped(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) / bounds.width * snapshot.width,
    y: (event.clientY - bounds.top) / bounds.height * snapshot.height };
}

async function acceptSnapshot(next, rerender = true, rememberPrevious = true) {
  if (!next) {
    diagnostics.setDocument(null);
    snapshot = null; clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    renderedDocument = null;
    $("emptyState").hidden = false; setSessionState("ready", "Engine ready");
    renderLayers(); renderLayerProperties(); renderStructure(); renderMetadata(); renderDocumentTabs(); renderHistory();
    renderRecoveryStatus();
    return;
  }
  const previousDocumentId = snapshot?.documentId;
  if (rememberPrevious && previousDocumentId && previousDocumentId !== next.documentId) rememberViewport();
  snapshot = next;
  const restoredViewport = previousDocumentId !== next.documentId
    ? documentViewports.get(next.documentId) : null;
  if (previousDocumentId !== next.documentId) {
    zoomMode = restoredViewport?.mode === "manual" ? "manual" : "fit";
    zoom = clampZoom(restoredViewport?.zoom ?? 1);
  }
  documentName = snapshot.documentName || documentName;
  if (!documentSaveFormats.has(snapshot.documentId)) {
    documentSaveFormats.set(snapshot.documentId,
      documentName.toLowerCase().endsWith(".psb") ? "psb" : "psd");
  }
  diagnostics.setDocument(snapshot, documentSaveFormats.get(snapshot.documentId) || "unknown");
  const liveLayerIds = new Set(snapshot.layers.map((layer) => layer.id));
  selectedLayerIds = new Set([...selectedLayerIds].filter((id) => liveLayerIds.has(id)));
  if (!selectedLayerIds.size) {
    setSingleLayerSelection(snapshot.activeLayerId || snapshot.layers.at(-1)?.id || null);
  } else if (selectedLayerId == null || !selectedLayerIds.has(selectedLayerId)) {
    selectedLayerId = [...selectedLayerIds].at(-1) ?? null;
  }
  if (layerSelectionAnchorId == null || !liveLayerIds.has(layerSelectionAnchorId)) {
    layerSelectionAnchorId = selectedLayerId;
  }
  if (!snapshot.channels.some((item) => item.id === selectedChannelId)) selectedChannelId = null;
  if (!snapshot.paths.some((item) => item.id === selectedPathId)) selectedPathId = null;
  $("emptyState").hidden = true;
  setSessionState("document", snapshot.dirty ? "Modified locally" : "Document ready");
  renderLayers();
  renderLayerProperties();
  renderStructure();
  renderMetadata();
  renderDocumentTabs();
  renderHistory();
  renderRecoveryStatus(snapshot.documentId);
  if (rerender) await renderDocument();
  if (restoredViewport) {
    const viewport = $("canvasViewport");
    const bounded = clampScrollPosition(
      { x: restoredViewport.left, y: restoredViewport.top },
      { width: viewport.scrollWidth, height: viewport.scrollHeight },
      { width: viewport.clientWidth, height: viewport.clientHeight });
    viewport.scrollLeft = bounded.x; viewport.scrollTop = bounded.y;
    renderRulers();
  }
}

async function activateDocumentTab(documentId) {
  if (busy || snapshot?.documentId === documentId) return;
  clearError(); setBusy(true, "Switching document", "Activating its canonical Worker session");
  try {
    const next = await client.activateDocument(documentId);
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
  } catch (error) { showError("Could not switch document", error); }
  finally { setBusy(false); }
}

async function closeDocumentTab(documentTab) {
  if (busy) return;
  const recoveryWarning = localizer.text(checkpointStates.get(documentTab.id) === "confirmed"
    ? "Its latest confirmed local recovery snapshot will remain available."
    : "Local recovery is not confirmed, so recent changes may be lost.");
  if (documentTab.dirty && !confirm(`${localizer.text("Close")} ${documentTab.name}? ${recoveryWarning}`)) return;
  clearError(); setBusy(true, "Closing document", "Releasing its canonical Worker session");
  try {
    const closingActiveDocument = snapshot?.documentId === documentTab.id;
    if (closingActiveDocument) {
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    }
    await checkpointQueues.get(documentTab.id)?.whenIdle();
    const next = await client.closeDocument(documentTab.id);
    workspaceIds.delete(documentTab.id); checkpointStates.delete(documentTab.id);
    documentSaveFormats.delete(documentTab.id);
    checkpointQueues.delete(documentTab.id);
    documentHistoryLabels.delete(documentTab.id);
    documentGuides.delete(documentTab.id);
    fileLifecycle.release(documentTab.id);
    await acceptSnapshot(next, true, !closingActiveDocument);
    documentViewports.delete(documentTab.id);
    viewportDiagnostics.trackedDocuments = documentViewports.size;
  } catch (error) { showError("Could not close document", error); }
  finally { setBusy(false); }
}

async function mutate(title, operation) {
  if (busy || !snapshot) return;
  clearError();
  setBusy(true, title, "Committing one canonical engine revision");
  try {
    const before = snapshot;
    const next = await operation();
    recordHistoryMutation(before, next, title);
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
    showToast(title);
    return next;
  }
  catch (error) {
    showError(`${title} failed`, error);
    return DIAGNOSTIC_COMMAND_FAILED;
  }
  finally { setBusy(false); }
}

async function navigateHistory(steps) {
  if (busy || !snapshot || !Number.isSafeInteger(steps) || steps === 0) return;
  const before = snapshot;
  const restoreHistoryFocus = $("historyList").contains(document.activeElement);
  clearError(); setBusy(true, "Navigating history", `Moving ${Math.abs(steps)} state${Math.abs(steps) === 1 ? "" : "s"}`);
  try {
    const next = await client.historyTravel(steps, before.stateId, before.revision);
    recordHistoryTravel(before, next, steps);
    await acceptSnapshot(next); scheduleCheckpoint(next);
  } catch (error) { showError("History navigation failed", error); return DIAGNOSTIC_COMMAND_FAILED; }
  finally {
    setBusy(false);
    if (restoreHistoryFocus) {
      $("historyList").querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    }
  }
}

async function openFile(file, handle = null) {
  if (!file || busy) return;
  const kind = openFileKind(file);
  if (kind === "raster") return importPixelLayer(file, true);
  if (kind !== "layered") {
    showError("Unsupported file", new Error("Open a PSD, PSB, PNG, JPEG, WebP, AVIF, or SVG file."));
    return DIAGNOSTIC_COMMAND_FAILED;
  }
  clearError();
  setBusy(true, "Opening document", "Transferring bytes to the isolated Worker");
  try {
    const header = await client.inspectBlob(file);
    ensureMemorySafe(header, file.name || "Document");
    const next = await client.openBlob(file, file.name || "Document.psd");
    documentSaveFormats.set(next.documentId, header.version === 2 ? "psb" : "psd");
    const format = documentSaveFormats.get(next.documentId);
    fileLifecycle.bindOpened(next.documentId, handle, next, format);
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  } catch (error) { showError("Could not open document", error); }
  finally { setBusy(false); }
}

async function newDocument(input = starterPreset("blank")) {
  if (busy) return;
  let request;
  try { request = starterDocumentRequest(input); }
  catch (error) { showError("Could not create document", error); return DIAGNOSTIC_COMMAND_FAILED; }
  clearError();
  setBusy(true, "Creating document", `Preparing a ${request.width} × ${request.height} RGBA workspace`);
  try {
    ensureMemorySafe(request, "New document");
    const next = await client.create(request.width, request.height, request.name);
    documentSaveFormats.set(next.documentId, request.format);
    fileLifecycle.register(next.documentId, next, request.format);
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  } catch (error) { showError("Could not create document", error); return DIAGNOSTIC_COMMAND_FAILED; }
  finally { setBusy(false); }
}

async function createPixelLayer({ activateTool = null } = {}) {
  if (busy || !snapshot) return;
  clearError();
  setBusy(true, "Creating pixel layer", "Adding a transparent full-canvas layer");
  try {
    ensureMemorySafe(snapshot, "Pixel layer");
    const pixelCount = snapshot.width * snapshot.height;
    if (!Number.isSafeInteger(pixelCount * 4)) throw new Error("Pixel layer dimensions cannot be represented safely");
    const before = snapshot;
    const usedNames = new Set(before.layers.map((item) => item.name));
    const baseName = localizer.text("Layer"); let suffix = 1;
    while (usedNames.has(`${baseName} ${suffix}`)) suffix++;
    const next = await client.addPixelLayer({
      name: `${baseName} ${suffix}`, width: before.width, height: before.height,
      bounds: { x: 0, y: 0, width: before.width, height: before.height },
      rgba: new Uint8Array(pixelCount * 4),
    }, { transferOwnership: true });
    recordHistoryMutation(before, next, "Creating pixel layer");
    const previousIds = new Set(before.layers.map((item) => item.id));
    const created = next.layers.find((item) => item.kind === 0 && !previousIds.has(item.id));
    if (created) setSingleLayerSelection(created.id);
    await acceptSnapshot(next); scheduleCheckpoint(next);
    if (activateTool) setCanvasTool(activateTool);
    showToast("Pixel layer created");
  } catch (error) {
    showError("Could not create pixel layer", error);
    return DIAGNOSTIC_COMMAND_FAILED;
  } finally { setBusy(false); }
}

async function activateRasterTool(tool) {
  if (busy || !snapshot) return;
  if (selectedLayer()?.kind === 0) { setCanvasTool(tool); return; }
  if (snapshot.layers.length) return;
  return createPixelLayer({ activateTool: tool });
}

function activatePenTool() {
  setCanvasTool("pen");
  showToast("Click at least three anchors, then press Enter");
}

function setStarterError(error = null) {
  const output = $("starterError");
  output.hidden = !error;
  if (error) localizer.setText(output, error?.message || String(error));
}

let starterReturnFocus = $("emptyNewButton");

function openStarterDialog(event) {
  if (busy) return;
  const invoker = event?.currentTarget ?? document.activeElement;
  starterReturnFocus = invoker?.focus && !invoker.closest?.("dialog")
    ? invoker : $("emptyNewButton");
  setStarterError();
  $("starterWidthInput").value = "1600";
  $("starterHeightInput").value = "1000";
  $("starterDialog").showModal();
}

async function createStarter(input) {
  let request;
  try { request = starterDocumentRequest(input); }
  catch (error) { setStarterError(error); return; }
  $("starterDialog").close("create");
  const result = await newDocument(request);
  if (result !== DIAGNOSTIC_COMMAND_FAILED) {
    $("canvasViewport").focus({ preventScroll: true });
  }
}

async function saveDocument(saveAs = false) {
  if (busy || !snapshot) return;
  clearError();
  const savingClient = client;
  const savingSnapshot = snapshot;
  const recoveryWasEnabled = automaticRecoveryEnabled;
  const activeTab = savingSnapshot.documents.find((item) => item.active);
  const applyingContents = activeTab?.smartObjectParentId != null;
  const format = documentSaveFormats.get(savingSnapshot.documentId) || "psd";
  automaticRecoveryEnabled = false;
  setBusy(true, applyingContents ? "Applying Smart Object contents" : `Encoding ${format.toUpperCase()}`,
    applyingContents ? "Committing one guarded parent revision" :
      (fileLifecycle.supported ? "Writing after permission to a local file" : "Preparing a local browser download"));
  try {
    if (applyingContents) {
      const before = savingSnapshot;
      const next = await savingClient.saveSmartObjectContents(savingSnapshot.documentId);
      recordHistoryMutation(before, next, "Applying Smart Object contents");
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
      await acceptSnapshot(next);
      scheduleCheckpoint(next);
      return;
    }
    const result = await fileLifecycle.save({ documentId: savingSnapshot.documentId,
      projection: savingSnapshot, format, name: `${exportBaseName()}.${format}`, saveAs,
      createBlob: () => savingClient.saveBlob(format) });
    if (result.kind === "permission-denied") {
      throw new Error("Write permission was not granted; the document remains modified.");
    }
    if (result.kind === "cancelled") return;
    if (result.durable) {
      const next = await savingClient.markSaved(
        savingSnapshot.documentId, savingSnapshot.stateId);
      await acceptSnapshot(next, false);
      scheduleCheckpoint(next);
      setSessionState("document", "Saved to local file");
    } else {
      setSessionState("document", "Download created · document remains modified");
    }
  } catch (error) { showError("Could not encode layered document", error); return DIAGNOSTIC_COMMAND_FAILED; }
  finally {
    automaticRecoveryEnabled = recoveryWasEnabled;
    setBusy(false);
    if (recoveryWasEnabled && savingClient.state === "crashed" && client === savingClient) {
      queueMicrotask(() => recoverEngineAfterCrash());
    }
  }
}

async function openSmartObjectContents() {
  const layer = selectedLayer();
  if (busy || layer?.kind !== 5 || !layer.smartObject?.contentsEditable) return;
  clearError();
  setBusy(true, "Opening Smart Object contents", "Creating a linked canonical Worker session");
  try {
    const next = await client.openSmartObjectContents(layer.id);
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
  } catch (error) { showError("Could not open Smart Object contents", error); return DIAGNOSTIC_COMMAND_FAILED; }
  finally { setBusy(false); }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openDiagnosticsDialog() {
  const consent = $("diagnosticsConsentInput");
  consent.checked = false;
  $("downloadDiagnosticsButton").disabled = true;
  localizer.setText($("diagnosticsSummary"), snapshot
    ? `${snapshot.width} × ${snapshot.height} · ${snapshot.layers.length} layers · Revision ${snapshot.revision}`
    : "No document is open");
  $("diagnosticsDialog").showModal();
}

function downloadDiagnostics() {
  if (!$("diagnosticsConsentInput").checked) return;
  diagnostics.setDocument(snapshot, snapshot
    ? documentSaveFormats.get(snapshot.documentId) || "unknown" : "unknown");
  const text = serializeDiagnosticBundle(diagnostics.createBundle({
    locale: localizer.locale, capabilities: client?.capabilities || 0n }));
  downloadBlob(new Blob([text], { type: "application/json" }), "patchy-diagnostics.json");
  $("diagnosticsDialog").close("exported");
}

function canvasBlob(source, type, quality) {
  return new Promise((resolve, reject) => source.toBlob(
    (blob) => blob?.type === type ? resolve(blob) : reject(new Error(`Browser could not encode ${type}`)),
    type, quality));
}

function exportBaseName() {
  return (documentName.replace(/\.[^.]+$/, "") || "Patchy export").replace(/[\\/:*?"<>|]/g, "-");
}

async function exportDocument() {
  if (busy || !snapshot) return;
  clearError(); setBusy(true, "Exporting document", "Encoding the rendered composite locally");
  try {
    const format = $("exportFormatSelect").value;
    const rgba = await client.render({ x: 0, y: 0, width: snapshot.width, height: snapshot.height });
    const expectedBytes = snapshot.width * snapshot.height * 4;
    if (!(rgba instanceof Uint8Array) || rgba.byteLength !== expectedBytes) {
      throw new Error("Engine returned an incomplete flattened export");
    }
    const blob = await encodeFlatDocument({ rgba, width: snapshot.width, height: snapshot.height,
      format, title: exportBaseName() });
    downloadBlob(blob, `${exportBaseName()}.${format === "jpeg" ? "jpg" : format}`);
  } catch (error) { showError("Could not export document", error); return DIAGNOSTIC_COMMAND_FAILED; }
  finally { setBusy(false); }
}

function renderedSelectionCanvas() {
  const bounds = selectionBounds() || { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const output = document.createElement("canvas"); output.width = bounds.width; output.height = bounds.height;
  const outputContext = output.getContext("2d", { alpha: true, willReadFrequently: true });
  outputContext.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height,
    0, 0, bounds.width, bounds.height);
  if (snapshot.selection?.length) {
    const mask = fullSelectionMask();
    const pixels = outputContext.getImageData(0, 0, bounds.width, bounds.height);
    for (let y = 0; y < bounds.height; ++y) {
      for (let x = 0; x < bounds.width; ++x) {
        const coverage = mask[(bounds.y + y) * snapshot.width + bounds.x + x] / 255;
        pixels.data[(y * bounds.width + x) * 4 + 3] = Math.round(
          pixels.data[(y * bounds.width + x) * 4 + 3] * coverage);
      }
    }
    outputContext.putImageData(pixels, 0, 0);
  }
  return output;
}

async function captureSelectedLayerPixels(layer) {
  const payload = await client.captureLayerPixels(layer.id, snapshot.stateId, snapshot.revision);
  if (!(payload?.rgba instanceof Uint8Array) || payload.rgba.byteLength !==
      payload.width * payload.height * 4) throw new Error("Pixel clipboard returned inconsistent RGBA data");
  const output = document.createElement("canvas"); output.width = payload.width; output.height = payload.height;
  output.getContext("2d", { alpha: true }).putImageData(
    new ImageData(new Uint8ClampedArray(payload.rgba), payload.width, payload.height), 0, 0);
  const blob = await canvasBlob(output, "image/png");
  return { ...payload, blob };
}

async function copyRenderedPixels() {
  if (busy || !snapshot) return;
  try {
    const layer = selectedLayer();
    if (layer && (snapshot.selection?.length || snapshot.selectionMask)) {
      if (selectedLayers().length !== 1 || layer.kind !== 0 || !layer.visible) {
        throw new Error("Copying selected pixels requires one visible pixel layer");
      }
      pixelClipboard = await captureSelectedLayerPixels(layer);
      clipboardImageBlob = pixelClipboard.blob; layerClipboard = null;
      if (navigator.clipboard?.write && globalThis.ClipboardItem) {
        try { await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardImageBlob })]); }
        catch { /* The positioned in-memory clipboard remains available. */ }
      }
      updateControls(); setSessionState("document",
        `${pixelClipboard.width} × ${pixelClipboard.height} selected pixels copied locally`);
      return;
    }
    if (layer) {
      layerClipboard = captureLayerReference();
      pixelClipboard = null; clipboardImageBlob = null;
      updateControls(); setSessionState("document",
        `${layerClipboard.layerIds.length} editable layer${layerClipboard.layerIds.length === 1 ? "" : "s"} copied locally`);
      return;
    }
    clipboardImageBlob = await canvasBlob(renderedSelectionCanvas(), "image/png");
    pixelClipboard = null; layerClipboard = null;
    if (navigator.clipboard?.write && globalThis.ClipboardItem) {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardImageBlob })]); }
      catch { /* The in-memory clipboard remains available across opened documents. */ }
    }
    updateControls(); setSessionState("document", "Pixels copied locally");
  } catch (error) { showError("Could not copy pixels", error); return DIAGNOSTIC_COMMAND_FAILED; }
}

async function cutSelectedPixels() {
  const layer = selectedLayer();
  if (busy || !snapshot || selectedLayers().length !== 1 || layer?.kind !== 0 ||
      !layer.visible || layer.lockFlags) return;
  clearError(); setBusy(true, "Cutting selected pixels", "Copying pixels and committing one cleared layer revision");
  try {
    const before = snapshot;
    pixelClipboard = await captureSelectedLayerPixels(layer);
    clipboardImageBlob = pixelClipboard.blob; layerClipboard = null;
    if (navigator.clipboard?.write && globalThis.ClipboardItem) {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardImageBlob })]); }
      catch { /* The in-memory pixel clipboard remains available. */ }
    }
    const next = await client.cutLayerPixels(layer.id);
    recordHistoryMutation(before, next, "Cutting selected pixels");
    await acceptSnapshot(next); scheduleCheckpoint(next);
    showToast("Selected pixels cut");
  } catch (error) {
    showError("Could not cut selected pixels", error);
    return DIAGNOSTIC_COMMAND_FAILED;
  } finally { setBusy(false); }
}

async function pastePixels() {
  if (busy || !snapshot) return;
  try {
    if (layerClipboard) {
      await transferLayerReference(layerClipboard, snapshot.documentId);
      return;
    }
    if (pixelClipboard) {
      clearError(); setBusy(true, "Pasting selected pixels", "Creating one positioned pixel layer");
      try {
        const before = snapshot; const previousIds = new Set(before.layers.map((layer) => layer.id));
        const next = await client.addPixelLayer({
          name: "Pasted pixels", width: pixelClipboard.width, height: pixelClipboard.height,
          bounds: { ...pixelClipboard.bounds }, rgba: pixelClipboard.rgba,
        });
        recordHistoryMutation(before, next, "Pasting selected pixels");
        const created = next.layers.find((layer) => layer.kind === 0 && !previousIds.has(layer.id));
        if (created) setSingleLayerSelection(created.id);
        await acceptSnapshot(next); scheduleCheckpoint(next); showToast("Pasted selected pixels");
      } finally { setBusy(false); }
      return;
    }
    let blob = null;
    if (navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        const item = items.find((candidate) => candidate.types.some((type) => type.startsWith("image/")));
        const type = item?.types.find((candidate) => candidate.startsWith("image/"));
        if (item && type) blob = await item.getType(type);
      } catch { blob = null; }
    }
    blob ||= clipboardImageBlob;
    if (!blob) throw new Error("Clipboard does not contain an image");
    const file = new File([blob], "Clipboard pixels.png", { type: blob.type || "image/png" });
    await importPixelLayer(file);
  } catch (error) { showError("Could not paste pixels", error); return DIAGNOSTIC_COMMAND_FAILED; }
}

function captureLayerReference() {
  const layerIds = selectedLayerIdsTopToBottom({ rootsOnly: true });
  return { sourceDocumentId: snapshot.documentId, layerIds,
    expectedSourceStateId: snapshot.stateId,
    expectedSourceRevision: snapshot.revision };
}

async function transferLayerReference(reference, targetDocumentId) {
  if (busy || !snapshot || !reference) return;
  const count = reference.layerIds?.length || 0;
  const originalDocumentId = snapshot.documentId;
  let activatedTarget = false;
  clearError(); setBusy(true, count === 1 ? "Copying editable layer" : "Copying editable layers",
    "Committing one canonical target revision");
  try {
    let target = snapshot;
    if (target.documentId !== targetDocumentId) {
      target = await client.activateDocument(targetDocumentId);
      activatedTarget = true;
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    }
    const priorTargetIds = new Set(target.layers.map((layer) => layer.id));
    const next = await client.copyLayersToDocument({ ...reference,
      targetDocumentId, expectedTargetStateId: target.stateId,
      expectedTargetRevision: target.revision });
    recordHistoryMutation(target, next, count === 1 ? "Copying editable layer" : "Copying editable layers");
    const copiedIds = next.layers.filter((layer) =>
      !priorTargetIds.has(layer.id) && layer.parentId === 0n).map((layer) => layer.id);
    selectedLayerIds = new Set(copiedIds);
    selectedLayerId = copiedIds.includes(next.activeLayerId) ? next.activeLayerId : copiedIds.at(-1) ?? null;
    layerSelectionAnchorId = selectedLayerId;
    if (reference.sourceDocumentId === targetDocumentId) {
      reference.expectedSourceStateId = next.stateId;
      reference.expectedSourceRevision = next.revision;
    }
    await acceptSnapshot(next); scheduleCheckpoint(next);
  } catch (error) {
    if (activatedTarget) {
      try {
        const restored = await client.activateDocument(originalDocumentId);
        await acceptSnapshot(restored);
      } catch (restoreError) {
        try { await acceptSnapshot(await client.snapshot()); }
        catch { /* Keep the original transfer error visible; Worker recovery remains available. */ }
        error = new AggregateError([error, restoreError],
          `${error?.message || error}; could not restore the source document`);
      }
    }
    showError("Could not copy editable layers", error);
  }
  finally { setBusy(false); }
}

async function decodeLocalImage(file) {
  try { return await createImageBitmap(file); }
  catch (bitmapError) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.decoding = "async";
      await new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(bitmapError), { once: true });
        image.src = url;
      });
      return image;
    } finally { URL.revokeObjectURL(url); }
  }
}

async function importPixelLayer(file, createDocument = false) {
  if (!file || busy || (!snapshot && !createDocument)) return;
  clearError();
  setBusy(true, "Importing pixels", "Decoding the image outside canonical document state");
  let image;
  try {
    image = await decodeLocalImage(file);
    if (image.width <= 0 || image.height <= 0 ||
        !Number.isSafeInteger(image.width * image.height * 4)) {
      throw new Error("Image dimensions cannot be represented safely");
    }
    ensureMemorySafe({ width: image.width, height: image.height }, file.name || "Imported image");
    const scratch = document.createElement("canvas");
    scratch.width = image.width;
    scratch.height = image.height;
    const scratchContext = scratch.getContext("2d", { alpha: true, willReadFrequently: true });
    scratchContext.drawImage(image, 0, 0);
    const rgba = new Uint8Array(scratchContext.getImageData(0, 0, image.width, image.height).data);
    const name = file.name.replace(/\.[^.]+$/, "") || "Imported pixels";
    if (createDocument || !snapshot) {
      const created = await client.create(image.width, image.height, `${name}.psd`);
      documentSaveFormats.set(created.documentId, "psd");
      fileLifecycle.register(created.documentId, created, "psd");
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
      await acceptSnapshot(created);
    }
    const before = snapshot;
    const next = await client.addPixelLayer({
      name, width: image.width, height: image.height,
      bounds: { x: 0, y: 0, width: image.width, height: image.height }, rgba,
    }, { transferOwnership: true });
    recordHistoryMutation(before, next, "Importing pixels");
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  } catch (error) { showError("Could not import pixels", error); }
  finally { image?.close?.(); setBusy(false); }
}

async function layerViaCopy() {
  const layer = selectedLayer();
  const selectedBounds = selectionBounds();
  if (busy || !snapshot || layer?.kind !== 0 || !layer.visible || !selectedBounds) return;
  clearError();
  setBusy(true, "Creating layer from selection", "Copying selected pixels into one editable layer");
  try {
    const before = snapshot;
    const usedNames = new Set(before.layers.map((item) => item.name));
    const baseName = localizer.text("Layer"); let suffix = 1;
    while (usedNames.has(`${baseName} ${suffix}`)) suffix++;
    const next = await client.copyLayerSelection(layer.id, `${baseName} ${suffix}`);
    recordHistoryMutation(before, next, "Layer via copy");
    const previousIds = new Set(before.layers.map((item) => item.id));
    const created = next.layers.find((item) => item.kind === 0 && !previousIds.has(item.id));
    if (created) setSingleLayerSelection(created.id);
    await acceptSnapshot(next); scheduleCheckpoint(next);
    setSessionState("document", "Selection copied to a new layer");
    showToast("Selection copied to a new layer");
  } catch (error) {
    showError("Could not create layer from selection", error);
    return DIAGNOSTIC_COMMAND_FAILED;
  } finally { setBusy(false); }
}

function rectanglePath(bounds) {
  return { anchors: [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ] };
}

function geometricShapePath(kind, bounds) {
  if (kind === "rectangle") return rectanglePath(bounds);
  const count = kind === "polygon" ? 6 : 24;
  const cx = bounds.x + bounds.width / 2; const cy = bounds.y + bounds.height / 2;
  return { anchors: Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return { x: cx + Math.cos(angle) * bounds.width / 2,
      y: cy + Math.sin(angle) * bounds.height / 2 };
  }) };
}

function pathHasClosedArea(path) {
  return Boolean(path?.subpaths?.some((subpath) =>
    subpath.closed && (subpath.anchors?.length || 0) >= 3));
}

function cubicCoordinate(start, controlA, controlB, end, time) {
  const inverse = 1 - time;
  return inverse ** 3 * start + 3 * inverse ** 2 * time * controlA +
    3 * inverse * time ** 2 * controlB + time ** 3 * end;
}

function sampledPathSubpath(subpath, brushSize) {
  const anchors = subpath?.anchors || [];
  if (anchors.length < 2) return [];
  const points = [{ x: anchors[0].x, y: anchors[0].y }];
  const segmentCount = anchors.length - 1 + (subpath.closed ? 1 : 0);
  for (let index = 0; index < segmentCount; ++index) {
    const start = anchors[index]; const end = anchors[(index + 1) % anchors.length];
    const controlA = { x: start.outX ?? start.x, y: start.outY ?? start.y };
    const controlB = { x: end.inX ?? end.x, y: end.inY ?? end.y };
    const controlLength = Math.hypot(controlA.x - start.x, controlA.y - start.y) +
      Math.hypot(controlB.x - controlA.x, controlB.y - controlA.y) +
      Math.hypot(end.x - controlB.x, end.y - controlB.y);
    const steps = Math.max(2, Math.min(256,
      Math.ceil(controlLength / Math.max(1, brushSize / 3))));
    for (let step = 1; step <= steps; ++step) {
      const time = step / steps;
      points.push({
        x: cubicCoordinate(start.x, controlA.x, controlB.x, end.x, time),
        y: cubicCoordinate(start.y, controlA.y, controlB.y, end.y, time),
      });
    }
  }
  return points.slice(0, 65536);
}

async function makeSelectedPathSelection({ combine: combineOverride = null } = {}) {
  const path = selectedPath();
  if (!pathHasClosedArea(path)) return null;
  const feather = Number($("selectionQuickFeatherInput").value);
  const combine = combineOverride ?? selectionCombineValue($("selectionModeInput").value || "replace");
  return mutate("Loading path selection", () => client.selectPath(path.id,
    Number.isFinite(feather) ? feather : 0, combine, true));
}

async function fillSelectedPath() {
  const selected = await makeSelectedPathSelection();
  if (!selected || selected === DIAGNOSTIC_COMMAND_FAILED) return;
  const layer = selectedLayer();
  if (layer?.kind !== 0) return;
  const draft = { layer, preset: "solid",
    color: [...colorBytes($("brushColorInput").value), 255],
    start: { x: layer.bounds.x, y: layer.bounds.y },
    end: { x: layer.bounds.x + layer.bounds.width, y: layer.bounds.y },
    stateId: snapshot.stateId, revision: snapshot.revision };
  return mutate("Filling path", () => client.applyRasterFill(rasterFillPayload(draft)));
}

async function strokeSelectedPath() {
  const path = selectedPath(); const layer = selectedLayer();
  if (!path || layer?.kind !== 0) return;
  const brushSize = Math.round(Number($("brushSizeInput").value));
  const softness = Math.round(Number($("brushSoftnessInput").value));
  const opacity = Math.round(Number($("brushOpacityInput").value));
  if (!Number.isInteger(brushSize) || brushSize < 1 || brushSize > 4096 ||
      !Number.isInteger(softness) || softness < 0 || softness > 100 ||
      !Number.isInteger(opacity) || opacity < 1 || opacity > 100) return;
  for (const subpath of path.subpaths || []) {
    const points = sampledPathSubpath(subpath, brushSize);
    if (points.length < 2) continue;
    const before = snapshot;
    const next = await mutate("Stroking path", () => client.applyRasterStroke({
      layerId: layer.id, mode: 0, brushSize, softness,
      color: [...colorBytes($("brushColorInput").value), Math.round(opacity * 2.55)],
      points: points.map(({ x, y }) => [x, y]), source: [0, 0],
      expectedStateId: before.stateId, expectedRevision: before.revision,
    }));
    if (!next || next === DIAGNOSTIC_COMMAND_FAILED) return;
  }
}

function createVectorMaskFromSelectedPath() {
  const layer = selectedLayer(); const path = selectedPath();
  if (layer && pathHasClosedArea(path)) return mutate("Creating vector mask", () =>
    client.setVectorMask(layer.id, { path: { subpaths: path.subpaths }, feather: 0, density: 255 }));
}

async function commitPenPath(closed = penDraft?.closed ?? false) {
  const draft = penDraft;
  if (!draft || draft.points.length < 3) return;
  const workPath = snapshot.paths.find((path) => path.kind === 1);
  const priorIds = new Set(snapshot.paths.map((path) => path.id));
  penDraft = null; penHoverPoint = null; previewPolygon([]); renderPenPath(); updateControls();
  const input = { name: "Work Path", kind: 1,
    path: { subpaths: [{ anchors: draft.points, shapeGroup: 0,
      combine: 1, closed: Boolean(closed) }] } };
  const next = await mutate("Creating Pen path", () => workPath
    ? client.updateDocumentPath(workPath.id, input) : client.addDocumentPath(input));
  if (next === DIAGNOSTIC_COMMAND_FAILED || !next) return;
  const committed = workPath
    ? next.paths.find((path) => path.id === workPath.id)
    : next.paths.find((path) => path.kind === 1 && !priorIds.has(path.id));
  if (committed) selectedPathId = committed.id;
  renderStructure(); renderPenPath(); updateControls();
}

function selectionBounds() {
  const rects = snapshot?.selection || [];
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function selectionPath() {
  const bounds = selectionBounds();
  if (!bounds) return null;
  const mask = fullSelectionMask(); const width = snapshot.width; const vertexWidth = width + 1;
  const edges = new Map();
  const addEdge = (ax, ay, bx, by) => {
    const start = ay * vertexWidth + ax; const end = by * vertexWidth + bx;
    const values = edges.get(start) || []; values.push(end); edges.set(start, values);
  };
  const selected = (x, y) => x >= 0 && y >= 0 && x < width && y < snapshot.height &&
    mask[y * width + x] >= 128;
  for (let y = bounds.y; y < bounds.y + bounds.height; ++y) {
    for (let x = bounds.x; x < bounds.x + bounds.width; ++x) {
      if (!selected(x, y)) continue;
      if (!selected(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!selected(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!selected(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!selected(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }
  const loops = [];
  while (edges.size) {
    const start = edges.keys().next().value; let cursor = start; const points = [];
    do {
      points.push({ x: cursor % vertexWidth, y: Math.floor(cursor / vertexWidth) });
      const choices = edges.get(cursor);
      if (!choices?.length) break;
      cursor = choices.pop(); if (!choices.length) edges.delete(points.at(-1).y * vertexWidth + points.at(-1).x);
    } while (cursor !== start && points.length <= mask.length * 4);
    if (cursor === start && points.length >= 3) {
      const simplified = points.filter((point, index) => {
        const before = points[(index + points.length - 1) % points.length];
        const after = points[(index + 1) % points.length];
        return (point.x - before.x) * (after.y - point.y) !==
          (point.y - before.y) * (after.x - point.x);
      });
      if (simplified.length >= 3) loops.push(simplified);
    }
  }
  const anchorCount = loops.reduce((sum, loop) => sum + loop.length, 0);
  if (!loops.length || anchorCount > 4096) return rectanglePath(bounds);
  return { subpaths: loops.map((anchors) => ({ anchors, shapeGroup: 0, combine: 1, closed: true })) };
}

function adjustmentName(kind) {
  return ADJUSTMENTS.find((item) => item.kind === kind)?.name || "Adjustment";
}

const ADJUSTMENTS = [
  { kind: 0, name: "Levels", parameters: [
    { key: "black_input", label: "Black input", index: 0, min: 0, max: 254, value: 0 },
    { key: "white_input", label: "White input", index: 1, min: 1, max: 255, value: 255 },
    { key: "gamma", label: "Gamma %", index: 2, min: 10, max: 999, value: 100 },
    { key: "black_output", label: "Black output", index: 3, min: 0, max: 255, value: 0 },
    { key: "white_output", label: "White output", index: 4, min: 0, max: 255, value: 255 },
  ] },
  { kind: 1, name: "Curves", parameters: [
    { key: "curve", label: "RGB points (input:output)", curve: true, value: "0:0, 255:255" },
  ] },
  { kind: 2, name: "Hue / Saturation", parameters: [
    { key: "hue", label: "Hue", index: 0, min: -180, max: 180, value: 0 },
    { key: "saturation", label: "Saturation", index: 1, min: -100, max: 100, value: 0 },
    { key: "lightness", label: "Lightness", index: 2, min: -100, max: 100, value: 0 },
    { key: "colorize", label: "Colorize", index: 3, boolean: true, value: false },
    { key: "colorize_hue", label: "Colorize hue", index: 4, min: 0, max: 360, value: 0 },
    { key: "colorize_saturation", label: "Colorize saturation", index: 5, min: 0, max: 100, value: 25 },
    { key: "colorize_lightness", label: "Colorize lightness", index: 6, min: -100, max: 100, value: 0 },
  ] },
  { kind: 3, name: "Color Balance", parameters: [
    { key: "cyan_red", label: "Cyan / Red", index: 0, min: -100, max: 100, value: 0 },
    { key: "magenta_green", label: "Magenta / Green", index: 1, min: -100, max: 100, value: 0 },
    { key: "yellow_blue", label: "Yellow / Blue", index: 2, min: -100, max: 100, value: 0 },
  ] },
  { kind: 4, name: "Invert", parameters: [] },
  { kind: 5, name: "Posterize", parameters: [
    { key: "levels", label: "Levels", index: 0, min: 2, max: 255, value: 4 },
  ] },
  { kind: 6, name: "Threshold", parameters: [
    { key: "threshold", label: "Threshold", index: 0, min: 1, max: 255, value: 128 },
  ] },
  { kind: 7, name: "Brightness / Contrast", parameters: [
    { key: "brightness", label: "Brightness", index: 0, min: -150, max: 150, value: 0 },
    { key: "contrast", label: "Contrast", index: 1, min: -50, max: 100, value: 0 },
    { key: "legacy", label: "Legacy mode", index: 2, boolean: true, value: false },
  ] },
];

const PIXEL_FILTERS = [
  { id: "patchy.filters.brightness_contrast", name: "Brightness / Contrast", parameters: [
    { key: "brightness", label: "Brightness", kind: "integer", min: -100, max: 100, value: 0 },
    { key: "contrast", label: "Contrast", kind: "integer", min: -100, max: 100, value: 0 },
  ] },
  { id: "patchy.filters.invert", name: "Invert", parameters: [
    { key: "amount", label: "Amount", kind: "integer", min: 0, max: 100, value: 100 },
  ] },
  { id: "patchy.filters.grayscale", name: "Grayscale", parameters: [
    { key: "amount", label: "Amount", kind: "integer", min: 0, max: 100, value: 100 },
  ] },
  { id: "patchy.filters.sepia", name: "Sepia", parameters: [
    { key: "amount", label: "Amount", kind: "integer", min: 0, max: 100, value: 100 },
  ] },
  { id: "patchy.filters.threshold", name: "Threshold", parameters: [
    { key: "threshold", label: "Threshold", kind: "integer", min: 0, max: 255, value: 128 },
  ] },
  { id: "patchy.filters.posterize", name: "Posterize", parameters: [
    { key: "levels", label: "Levels", kind: "integer", min: 2, max: 16, value: 4 },
  ] },
  { id: "patchy.filters.gaussian_blur", name: "Gaussian Blur", parameters: [
    { key: "radius", label: "Radius", kind: "integer", min: 1, max: 12, value: 2 },
  ] },
  { id: "patchy.filters.sharpen", name: "Sharpen", parameters: [
    { key: "amount", label: "Amount", kind: "integer", min: 0, max: 300, value: 100 },
  ] },
  { id: "patchy.filters.unsharp_mask", name: "Unsharp Mask", parameters: [
    { key: "amount", label: "Amount", kind: "integer", min: 1, max: 500, value: 150 },
    { key: "radius", label: "Radius", kind: "double", min: 0.1, max: 1000, step: 0.1, value: 2 },
    { key: "threshold", label: "Threshold", kind: "integer", min: 0, max: 255, value: 8 },
  ] },
  { id: "patchy.filters.pixelate", name: "Pixel Mosaic", parameters: [
    { key: "block_size", label: "Block size", kind: "integer", min: 2, max: 32, value: 4 },
  ] },
  { id: "patchy.filters.add_noise", name: "Add Noise", parameters: [
    { key: "amount", label: "Amount", kind: "double", min: 0.1, max: 400, step: 0.1, value: 12.5 },
    { key: "distribution", label: "Distribution", kind: "option", value: "uniform",
      options: [["uniform", "Uniform"], ["gaussian", "Gaussian"]] },
    { key: "monochromatic", label: "Monochromatic", kind: "boolean", value: false },
    { key: "seed", label: "Seed", kind: "integer", min: 0, max: 999999999, value: 1 },
  ] },
];

function renderFilterParameters() {
  const definition = PIXEL_FILTERS.find((item) => item.id === $("filterKindInput").value);
  const container = $("filterParameterFields"); container.replaceChildren();
  for (const parameter of definition?.parameters || []) {
    const label = document.createElement("label"); const caption = document.createElement("span");
    caption.textContent = parameter.label; label.append(caption);
    let input;
    if (parameter.kind === "option") {
      input = document.createElement("select");
      for (const [value, text] of parameter.options) {
        const option = document.createElement("option"); option.value = value;
        option.textContent = text; input.append(option);
      }
      input.value = parameter.value;
    } else {
      input = document.createElement("input"); input.type = parameter.kind === "boolean" ? "checkbox" : "number";
      if (parameter.kind === "boolean") input.checked = parameter.value;
      else {
        input.value = String(parameter.value); input.min = String(parameter.min);
        input.max = String(parameter.max); input.step = String(parameter.step || 1);
      }
    }
    input.dataset.filterParameter = parameter.key; label.append(input); container.append(label);
  }
}

function openFilterDialog() {
  if (busy || selectedLayer()?.kind !== 0) return;
  renderFilterParameters(); $("filterDialog").showModal();
}

function commitFilter() {
  const layer = selectedLayer();
  const definition = PIXEL_FILTERS.find((item) => item.id === $("filterKindInput").value);
  if (!layer || !definition) return;
  const parameters = definition.parameters.map((parameter) => {
    const input = $("filterParameterFields").querySelector(`[data-filter-parameter="${parameter.key}"]`);
    const value = parameter.kind === "boolean" ? input.checked : parameter.kind === "option" ? input.value : Number(input.value);
    if ((parameter.kind === "integer" && !Number.isSafeInteger(value)) ||
        (parameter.kind === "double" && !Number.isFinite(value)) ||
        (typeof value === "number" && (value < parameter.min || value > parameter.max))) {
      throw new RangeError(`${parameter.label} is outside the supported range`);
    }
    return { key: parameter.key, kind: parameter.kind, value };
  });
  $("filterDialog").close(); applyPixelFilter(layer, definition.id, parameters);
}

function openShapeDialog() {
  if (busy || !snapshot) return;
  const layer = selectedLayer();
  const bounds = layer?.kind === 4 ? layer.bounds : snapshot.selection?.[0] || { x: Math.round(snapshot.width * .2),
    y: Math.round(snapshot.height * .2), width: Math.max(40, Math.round(snapshot.width * .35)),
    height: Math.max(40, Math.round(snapshot.height * .35)) };
  for (const [id, value] of [["shapeXInput", bounds.x], ["shapeYInput", bounds.y],
    ["shapeWidthInput", bounds.width], ["shapeHeightInput", bounds.height]]) $(id).value = String(value);
  $("shapeDialogTitle").textContent = layer?.kind === 4 ? "Edit vector points" : "Create vector shape";
  $("commitShapeButton").textContent = layer?.kind === 4 ? "Update shape" : "Create shape";
  openContextEditor("shapeDialog");
}

async function commitShape() {
  const x = integerInput("shapeXInput"); const y = integerInput("shapeYInput");
  const width = integerInput("shapeWidthInput", true); const height = integerInput("shapeHeightInput", true);
  const strokeWidth = Number($("shapeStrokeWidthInput").value);
  if ([x, y, width, height].some((value) => value == null) || !Number.isFinite(strokeWidth) || strokeWidth < 0) return;
  const bounds = { x, y, width, height };
  const layer = selectedLayer();
  const input = { name: layer?.kind === 4 ? layer.name : "Shape",
    path: geometricShapePath($("shapeKindInput").value, bounds),
    fill: colorBytes($("shapeFillInput").value), strokeEnabled: strokeWidth > 0,
    stroke: colorBytes($("shapeStrokeInput").value), strokeWidth };
  const operation = layer?.kind === 4
    ? () => client.updateVectorShape(layer.id, input)
    : selectCreatedLayer(4, () => client.addVectorShape(input));
  const next = await mutate(layer?.kind === 4 ? "Updating vector points" : "Creating vector shape", operation);
  if (next !== DIAGNOSTIC_COMMAND_FAILED) {
    $("shapeDialog").close("apply");
    queueMicrotask(focusSelectedLayerRow);
  }
}

function openAdjustmentDialog() {
  if (busy || !snapshot) return;
  const layer = selectedLayer();
  const editing = layer?.kind === 2;
  $("adjustmentDialogTitle").textContent = editing ? "Edit adjustment layer" : "Create adjustment layer";
  $("commitAdjustmentButton").textContent = editing ? "Update adjustment" : "Create adjustment";
  $("adjustmentKindInput").value = String(layer?.adjustment?.kind ?? 7);
  renderAdjustmentParameters(editing ? layer.adjustment : null);
  openContextEditor("adjustmentDialog");
}

function renderAdjustmentParameters(existing = null) {
  const definition = ADJUSTMENTS.find((item) => item.kind === Number($("adjustmentKindInput").value));
  const container = $("adjustmentParameterFields"); container.replaceChildren();
  for (const parameter of definition?.parameters || []) {
    const label = document.createElement("label"); const caption = document.createElement("span");
    caption.textContent = parameter.label; label.append(caption);
    const input = document.createElement("input"); input.dataset.adjustmentParameter = parameter.key;
    if (parameter.curve) {
      input.type = "text";
      input.value = existing?.kind === 1 && existing.curvePoints?.length
        ? existing.curvePoints.map((point) => `${point.input}:${point.output}`).join(", ")
        : parameter.value;
    } else if (parameter.boolean) {
      input.type = "checkbox";
      input.checked = existing?.kind === definition.kind
        ? Boolean(existing.values?.[parameter.index]) : parameter.value;
    } else {
      input.type = "number"; input.step = "1";
      input.min = String(parameter.min); input.max = String(parameter.max);
      input.value = String(existing?.kind === definition.kind
        ? existing.values?.[parameter.index] ?? parameter.value : parameter.value);
    }
    label.append(input); container.append(label);
  }
}

async function commitAdjustment() {
  const kind = Number($("adjustmentKindInput").value);
  const definition = ADJUSTMENTS.find((item) => item.kind === kind);
  if (!definition) return;
  const values = Array(8).fill(0); let curvePoints = [];
  for (const parameter of definition.parameters) {
    const control = $("adjustmentParameterFields").querySelector(
      `[data-adjustment-parameter="${parameter.key}"]`);
    if (parameter.curve) {
      curvePoints = control.value.split(",").map((entry) => entry.trim().split(":").map(Number))
        .map(([input, output]) => ({ input, output }));
      if (curvePoints.length < 2 || curvePoints.length > 64 ||
          curvePoints.some((point) => !Number.isInteger(point.input) || !Number.isInteger(point.output) ||
            point.input < 0 || point.input > 255 || point.output < 0 || point.output > 255) ||
          curvePoints.some((point, index) => index > 0 && point.input <= curvePoints[index - 1].input)) {
        throw new RangeError("Curves require 2–64 ordered input:output points in the 0–255 range");
      }
    } else {
      const value = parameter.boolean ? Number(control.checked) : Number(control.value);
      if (!Number.isSafeInteger(value) || (!parameter.boolean &&
          (value < parameter.min || value > parameter.max))) {
        throw new RangeError(`${parameter.label} is outside the supported range`);
      }
      values[parameter.index] = value;
    }
  }
  if (kind === 0 && (values[1] <= values[0] || values[4] < values[3])) {
    throw new RangeError("Levels white points must not precede black points");
  }
  if (kind === 7 && values[2] &&
      (values[0] < -100 || values[0] > 100 || values[1] < -100 || values[1] > 100)) {
    throw new RangeError("Legacy brightness and contrast must stay in the -100–100 range");
  }
  const input = { name: adjustmentName(kind), kind, values, curvePoints };
  const layer = selectedLayer();
  const operation = layer?.kind === 2
    ? () => client.updateAdjustment(layer.id, input)
    : selectCreatedLayer(2, () => client.addAdjustment(input));
  const next = await mutate(layer?.kind === 2 ? "Updating adjustment" : "Creating adjustment", operation);
  if (next !== DIAGNOSTIC_COMMAND_FAILED) {
    $("adjustmentDialog").close("apply");
    queueMicrotask(focusSelectedLayerRow);
  }
}

async function placeSmartObject(file) {
  if (!file || busy || !snapshot) return;
  clearError(); setBusy(true, "Placing Smart Object", "Embedding source bytes and raster preview");
  let image;
  try {
    if (/\.(?:psd|psb)$/i.test(file.name)) {
      const layer = selectedLayer();
      const before = snapshot;
      const next = await client.placePsdSmartObject(
        file, file.name, layer?.kind === 5 ? layer.id : null);
      recordHistoryMutation(before, next,
        layer?.kind === 5 ? "Replacing Smart Object" : "Placing Smart Object");
      await acceptSnapshot(next);
      return;
    }
    const sourceBytes = new Uint8Array(await file.arrayBuffer());
    image = await createImageBitmap(file);
    const byteLength = image.width * image.height * 4;
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 512 * 1024 * 1024) {
      throw new RangeError("Smart Object preview exceeds the 512 MB browser editing limit");
    }
    const scratch = document.createElement("canvas"); scratch.width = image.width; scratch.height = image.height;
    const scratchContext = scratch.getContext("2d", { alpha: true, willReadFrequently: true });
    scratchContext.drawImage(image, 0, 0);
    const rgba = new Uint8Array(scratchContext.getImageData(0, 0, image.width, image.height).data);
    const filetype = file.type === "image/png" ? "PNG " : file.type === "image/jpeg" ? "JPEG" : "WEBP";
    const input = { name: file.name.replace(/\.[^.]+$/, "") || "Smart Object",
      filename: file.name, filetype, width: image.width, height: image.height,
      bounds: selectedLayer()?.kind === 5 ? selectedLayer().bounds :
        { x: 0, y: 0, width: image.width, height: image.height }, rgba, sourceBytes };
    const layer = selectedLayer();
    const before = snapshot;
    const next = await (layer?.kind === 5
      ? client.replaceSmartObject(layer.id, input, { transferOwnership: true })
      : client.addSmartObject(input, { transferOwnership: true }));
    recordHistoryMutation(before, next,
      layer?.kind === 5 ? "Replacing Smart Object" : "Placing Smart Object");
    await acceptSnapshot(next);
  } catch (error) { showError("Could not place Smart Object", error); }
  finally { image?.close?.(); setBusy(false); }
}

function openSmartFilterDialog() {
  if (!busy && selectedLayer()?.kind === 5) $("smartFilterDialog").showModal();
}

function commitSmartFilter() {
  const layer = selectedLayer(); const kind = Number($("smartFilterKindInput").value);
  const amount = Number($("smartFilterAmountInput").value);
  if (layer?.kind !== 5 || !Number.isInteger(kind) || !Number.isFinite(amount)) return;
  $("smartFilterDialog").close();
  mutate("Applying Smart Filter", () => client.setSmartFilter(layer.id, { kind, amount, enabled: true }));
}

function colorBytes(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new TypeError("Color must be a six-digit hex value");
  const number = Number.parseInt(match[1], 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function textStyleFromControls() {
  const sizePixels = Number($("textSizeInput").value);
  const font = $("textFontInput").value.trim();
  const leading = Number($("textLeadingInput").value);
  const tracking = Number($("textTrackingInput").value);
  const horizontalScale = Number($("textHorizontalScaleInput").value) / 100;
  const verticalScale = Number($("textVerticalScaleInput").value) / 100;
  if (!font || !Number.isFinite(sizePixels) || sizePixels < 1 || sizePixels > 512 ||
      !Number.isFinite(leading) || leading < 0 || leading > 4096 ||
      !Number.isFinite(tracking) || tracking < -1000 || tracking > 1000 ||
      !Number.isFinite(horizontalScale) || horizontalScale < .01 || horizontalScale > 10 ||
      !Number.isFinite(verticalScale) || verticalScale < .01 || verticalScale > 10) {
    throw new RangeError("Text style metrics are outside the supported range");
  }
  return { font, style: "", sizePixels, color: colorBytes($("textColorInput").value),
    bold: $("textBoldInput").checked, italic: $("textItalicInput").checked,
    fauxBold: false, fauxItalic: false, leading, autoLeading: leading === 0,
    tracking, horizontalScale, verticalScale };
}

function sameTextStyle(left, right) {
  return ["font", "style", "sizePixels", "bold", "italic", "fauxBold", "fauxItalic",
    "leading", "autoLeading", "tracking", "horizontalScale", "verticalScale"]
    .every((key) => left[key] === right[key]) && left.color.every((value, index) => value === right.color[index]);
}

function mergeTextRuns(runs) {
  const merged = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous && previous.start + previous.length === run.start && sameTextStyle(previous, run))
      previous.length += run.length;
    else merged.push({ ...run, color: [...run.color] });
  }
  return merged;
}

function baseTextRun(value, style = textStyleFromControls()) {
  return { start: 0, length: value.length, ...style };
}

function textRunsCover(value, runs) {
  let covered = 0;
  return value.length > 0 && Array.isArray(runs) && runs.length > 0 && runs.every((run) => {
    const valid = run.start === covered && Number.isInteger(run.length) && run.length > 0;
    covered += run.length;
    return valid;
  }) && covered === value.length;
}

function renderTextRunList() {
  const list = $("textRunList"); list.replaceChildren();
  for (const run of textDialogRuns) {
    const row = document.createElement("div");
    const range = document.createElement("code"); range.textContent = `${run.start}–${run.start + run.length}`;
    const summary = document.createElement("span");
    summary.textContent = `${run.font} ${run.sizePixels}px · rgb(${run.color.join(" ")})${run.bold ? " · bold" : ""}${run.italic ? " · italic" : ""}`;
    row.append(range, summary); list.append(row);
  }
}

function renderParagraphRunList() {
  const list = $("textParagraphRunList"); list.replaceChildren();
  const names = ["left", "right", "center", "justify"];
  for (const run of textDialogParagraphRuns) {
    const row = document.createElement("div");
    const range = document.createElement("code"); range.textContent = `${run.start}–${run.start + run.length}`;
    const summary = document.createElement("span");
    summary.textContent = `${names[run.justification] || "left"} · indents ${run.firstLineIndent}/${run.startIndent}/${run.endIndent}`;
    row.append(range, summary); list.append(row);
  }
}

function applyTextStyleRange(start, end) {
  const value = $("textValueInput").value.replace(/\r\n?/g, "\n");
  if (!textRunsCover(value, textDialogRuns)) textDialogRuns = [baseTextRun(value)];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > value.length || start >= end)
    throw new RangeError("Select a non-empty text range first");
  const style = textStyleFromControls(); const next = [];
  for (const run of textDialogRuns) {
    const runEnd = run.start + run.length;
    if (runEnd <= start || run.start >= end) { next.push(run); continue; }
    if (run.start < start) next.push({ ...run, length: start - run.start });
    const selectedStart = Math.max(run.start, start); const selectedEnd = Math.min(runEnd, end);
    next.push({ start: selectedStart, length: selectedEnd - selectedStart, ...style });
    if (runEnd > end) next.push({ ...run, start: end, length: runEnd - end });
  }
  textDialogRuns = mergeTextRuns(next);
  textDialogStyleDirty = false;
  renderTextRunList();
}

function paragraphFromControls(start, length) {
  const values = ["textFirstIndentInput", "textStartIndentInput", "textEndIndentInput",
    "textSpaceBeforeInput", "textSpaceAfterInput"].map((id) => Number($(id).value));
  const autoLeadingFraction = Number($("textAutoLeadingInput").value) / 100;
  const justification = Number($("textAlignmentInput").value);
  if (!values.every(Number.isFinite) || !Number.isFinite(autoLeadingFraction) ||
      autoLeadingFraction < .01 || autoLeadingFraction > 10 || ![0, 1, 2, 3].includes(justification))
    throw new RangeError("Paragraph metrics are outside the supported range");
  return { start, length, justification, firstLineIndent: values[0], startIndent: values[1],
    endIndent: values[2], spaceBefore: values[3], spaceAfter: values[4], autoLeadingFraction };
}

function applyParagraphRange(start, end) {
  const value = $("textValueInput").value.replace(/\r\n?/g, "\n");
  if (!textRunsCover(value, textDialogParagraphRuns))
    textDialogParagraphRuns = [paragraphFromControls(0, value.length)];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > value.length)
    throw new RangeError("Text selection is outside the story");
  const rangeStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const searchFrom = Math.max(rangeStart, end > start && value[end - 1] === "\n" ? end - 1 : end);
  const newline = value.indexOf("\n", searchFrom);
  const rangeEnd = newline < 0 ? value.length : newline + 1;
  if (rangeStart >= rangeEnd) throw new RangeError("Select a paragraph first");
  const paragraph = paragraphFromControls(rangeStart, rangeEnd - rangeStart);
  textDialogParagraphRuns = applyParagraphStyleRange(
    textDialogParagraphRuns, rangeStart, rangeEnd, paragraph);
  textDialogParagraphDirty = false;
  renderParagraphRunList();
}

function canvasFont(run) {
  const family = String(run.font).replace(/["\\]/g, "");
  return `${run.italic ? "italic " : ""}${run.bold ? "700 " : ""}${run.sizePixels}px "${family}"`;
}

function paragraphForOffset(paragraphs, offset) {
  return paragraphs.find((run) => offset >= run.start && offset < run.start + run.length) || paragraphs.at(-1);
}

function lineSegments(value, start, length, runs) {
  const end = start + length; const result = [];
  for (const run of runs) {
    const segmentStart = Math.max(start, run.start); const segmentEnd = Math.min(end, run.start + run.length);
    if (segmentStart < segmentEnd) result.push({ ...run, value: value.slice(segmentStart, segmentEnd) });
  }
  return result;
}

function segmentAdvance(ctx, segment, justifiedSpace = 0) {
  ctx.font = canvasFont(segment);
  const glyphs = Array.from(segment.value);
  const tracking = segment.sizePixels * segment.tracking / 1000;
  const spaces = glyphs.filter((glyph) => glyph === " ").length;
  return (ctx.measureText(segment.value).width + Math.max(0, glyphs.length - 1) * tracking) *
    segment.horizontalScale + spaces * justifiedSpace;
}

function drawTextSegment(ctx, segment, x, y, justifiedSpace = 0) {
  ctx.save(); ctx.translate(x, y); ctx.scale(segment.horizontalScale, segment.verticalScale);
  ctx.font = canvasFont(segment); ctx.fillStyle = `rgb(${segment.color.join(" ")})`;
  const tracking = segment.sizePixels * segment.tracking / 1000; let localX = 0;
  for (const glyph of Array.from(segment.value)) {
    ctx.fillText(glyph, localX, 0);
    localX += ctx.measureText(glyph).width + tracking +
      (glyph === " " ? justifiedSpace / segment.horizontalScale : 0);
  }
  ctx.restore();
}

function textLayerPayload(style, bounds, name, runs, paragraphs) {
  const byteLength = bounds.width * bounds.height * 4;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 512 * 1024 * 1024) {
    throw new RangeError("Text raster exceeds the 512 MB browser editing limit");
  }
  const scratch = document.createElement("canvas");
  scratch.width = bounds.width;
  scratch.height = bounds.height;
  const scratchContext = scratch.getContext("2d", { alpha: true, willReadFrequently: true });
  scratchContext.clearRect(0, 0, bounds.width, bounds.height);
  scratchContext.textBaseline = "top";
  let offset = 0; let y = 0;
  const lines = String(style.value).split("\n");
  lines.forEach((line, lineIndex) => {
    const paragraph = paragraphForOffset(paragraphs, Math.min(offset, Math.max(0, style.value.length - 1))) ||
      { justification: 0, firstLineIndent: 0, startIndent: 0, endIndent: 0,
        spaceBefore: 0, spaceAfter: 0, autoLeadingFraction: 1.2 };
    const segments = lineSegments(style.value, offset, line.length, runs);
    const effective = segments.length ? segments : [{ ...runs[0], value: " " }];
    y += paragraph.spaceBefore;
    const width = effective.reduce((sum, segment) => sum + segmentAdvance(scratchContext, segment), 0);
    const firstIndent = offset === paragraph.start ? paragraph.firstLineIndent : 0;
    let x = paragraph.startIndent + firstIndent;
    const available = Math.max(0, bounds.width - paragraph.startIndent - paragraph.endIndent - firstIndent);
    if (paragraph.justification === 2) x += Math.max(0, (available - width) / 2);
    else if (paragraph.justification === 1) x += Math.max(0, available - width);
    const justifiedSpace = justifiedSpaceAdvance(
      paragraph.justification, available, width, effective);
    for (const segment of effective) {
      drawTextSegment(scratchContext, segment, x, y, justifiedSpace);
      x += segmentAdvance(scratchContext, segment, justifiedSpace);
    }
    const lineHeight = Math.max(...effective.map((segment) =>
      (segment.leading > 0 ? segment.leading : segment.sizePixels * paragraph.autoLeadingFraction) * segment.verticalScale));
    y += lineHeight + paragraph.spaceAfter;
    offset += line.length + (lineIndex + 1 < lines.length ? 1 : 0);
  });
  return { name, text: style.value, font: style.font, sizePixels: style.sizePixels,
    color: style.color, bold: style.bold, italic: style.italic, boxText: true,
    width: bounds.width, height: bounds.height, bounds,
    styleRuns: runs, paragraphRuns: paragraphs,
    rgba: new Uint8Array(scratchContext.getImageData(0, 0, bounds.width, bounds.height).data) };
}

function openTextDialog() {
  if (busy || !snapshot) return;
  const layer = selectedLayer();
  textEditingId = layer?.kind === 3 ? layer.id : null;
  const selectedBounds = snapshot.selection?.[0];
  const bounds = textEditingId ? layer.bounds : selectedBounds || {
    x: Math.round(snapshot.width * .1), y: Math.round(snapshot.height * .1),
    width: Math.max(160, Math.round(snapshot.width * .5)),
    height: Math.max(80, Math.round(snapshot.height * .2)),
  };
  const style = layer?.text || { value: "Text", font: "Arial", sizePixels: 48,
    color: [17, 17, 17], bold: false, italic: false };
  $("textDialogTitle").textContent = textEditingId ? "Edit text layer" : "Create text layer";
  $("commitTextButton").textContent = textEditingId ? "Update text" : "Create text";
  $("textValueInput").value = style.value;
  $("textFontInput").value = style.font;
  $("textSizeInput").value = String(style.sizePixels);
  $("textColorInput").value = `#${style.color.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  $("textBoldInput").checked = style.bold;
  $("textItalicInput").checked = style.italic;
  textDialogOriginalValue = style.value;
  textDialogRuns = textRunsCover(style.value, style.styleRuns) ? style.styleRuns.map((run) =>
    ({ ...run, color: [...run.color] })) : [baseTextRun(style.value, {
      font: style.font, style: "", sizePixels: style.sizePixels, color: [...style.color],
      bold: style.bold, italic: style.italic, fauxBold: false, fauxItalic: false,
      leading: 0, autoLeading: true, tracking: 0, horizontalScale: 1, verticalScale: 1 })];
  textDialogParagraphRuns = Array.isArray(style.paragraphRuns) && style.paragraphRuns.length
    ? style.paragraphRuns.map((run) => ({ ...run }))
    : [{ start: 0, length: style.value.length, justification: 0, firstLineIndent: 0,
      startIndent: 0, endIndent: 0, spaceBefore: 0, spaceAfter: 0, autoLeadingFraction: 1.2 }];
  textDialogOriginalRuns = textDialogRuns.map((run) => ({ ...run, color: [...run.color] }));
  textDialogOriginalParagraphRuns = textDialogParagraphRuns.map((run) => ({ ...run }));
  const firstRun = textDialogRuns[0];
  $("textFontInput").value = firstRun.font;
  $("textSizeInput").value = String(firstRun.sizePixels);
  $("textColorInput").value = `#${firstRun.color.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  $("textBoldInput").checked = firstRun.bold;
  $("textItalicInput").checked = firstRun.italic;
  $("textTrackingInput").value = String(firstRun.tracking || 0);
  $("textLeadingInput").value = String(firstRun.autoLeading ? 0 : firstRun.leading || 0);
  $("textHorizontalScaleInput").value = String((firstRun.horizontalScale || 1) * 100);
  $("textVerticalScaleInput").value = String((firstRun.verticalScale || 1) * 100);
  const paragraph = textDialogParagraphRuns[0];
  $("textAlignmentInput").value = String(paragraph.justification || 0);
  for (const [id, value] of [["textFirstIndentInput", paragraph.firstLineIndent],
    ["textStartIndentInput", paragraph.startIndent], ["textEndIndentInput", paragraph.endIndent],
    ["textSpaceBeforeInput", paragraph.spaceBefore], ["textSpaceAfterInput", paragraph.spaceAfter]])
    $(id).value = String(value || 0);
  $("textAutoLeadingInput").value = String((paragraph.autoLeadingFraction || 1.2) * 100);
  textDialogStyleDirty = false; textDialogParagraphDirty = false;
  renderTextRunList(); renderParagraphRunList();
  for (const [id, value] of [["textXInput", bounds.x], ["textYInput", bounds.y],
    ["textWidthInput", bounds.width], ["textHeightInput", bounds.height]]) $(id).value = String(value);
  openContextEditor("textDialog");
}

async function commitTextDialog() {
  const x = integerInput("textXInput"); const y = integerInput("textYInput");
  const width = integerInput("textWidthInput", true); const height = integerInput("textHeightInput", true);
  const value = $("textValueInput").value.replace(/\r\n?/g, "\n");
  if ([x, y, width, height].some((item) => item == null) || !value) return;
  const layer = selectedLayer();
  let payload;
  try {
    if (!textRunsCover(value, textDialogRuns) || textDialogStyleDirty)
      textDialogRuns = [baseTextRun(value)];
    if (textDialogParagraphDirty || !textRunsCover(value, textDialogParagraphRuns))
      textDialogParagraphRuns = [paragraphFromControls(0, value.length)];
    const primary = textDialogRuns[0];
    payload = textLayerPayload({ value, font: primary.font, sizePixels: primary.sizePixels,
      color: primary.color, bold: primary.bold, italic: primary.italic }, { x, y, width, height },
      textEditingId ? layer?.name || "Text" : value.split(/\s+/)[0] || "Text",
      textDialogRuns, textDialogParagraphRuns);
  } catch (error) { showError("Could not prepare text", error); return; }
  const editing = textEditingId; textEditingId = null;
  const operation = editing
    ? () => client.updateTextLayer(editing, payload, { transferOwnership: true })
    : selectCreatedLayer(3, () => client.addTextLayer(payload, { transferOwnership: true }));
  const next = await mutate(editing ? "Updating text" : "Creating text", operation);
  if (next !== DIAGNOSTIC_COMMAND_FAILED) {
    $("textDialog").close("apply");
    queueMicrotask(focusSelectedLayerRow);
  } else {
    textEditingId = editing;
  }
}

function openLayerTransformDialog() {
  const target = transformSelection();
  if (busy || !target) return;
  if (canvasTool !== "move") setCanvasTool("move");
  for (const [id, value] of [["layerXInput", target.bounds.x], ["layerYInput", target.bounds.y],
    ["layerWidthInput", target.bounds.width], ["layerHeightInput", target.bounds.height]]) $(id).value = String(value);
  $("layerAngleInput").value = "0";
  $("layerFlipXInput").checked = false; $("layerFlipYInput").checked = false;
  $("layerTransformModeInput").value = "affine";
  $("layerTransformModeInput").querySelector('option[value="perspective"]').disabled = target.hasText;
  $("layerTransformTitle").textContent = target.leaves.length > 1
    ? `Free transform · ${target.leaves.length} layers` : "Free transform";
  transformDialogDraft = { ...target, quad: quadFromBounds(target.bounds) };
  updateTransformDialogPreview();
  $("layerTransformDialog").show();
  $("applyTransformButton").disabled = false;
  $("cancelTransformButton").disabled = false;
}

function openLayerWarpDialog() {
  const layer = selectedLayer();
  if (busy || ![0, 3, 5].includes(layer?.kind) || layer?.vectorMask ||
      (layer?.mask && !layer.mask.linked)) return;
  warpDialogDraft = { layer, stateId: snapshot.stateId, revision: snapshot.revision };
  $("layerWarpStyleInput").value = "0"; $("layerWarpBendInput").value = "50";
  $("layerWarpHorizontalInput").value = "0"; $("layerWarpVerticalInput").value = "0";
  $("layerWarpRotateInput").checked = false;
  $("layerWarpDialog").showModal(); scheduleWarpPreview();
}

async function commitLayerWarp() {
  const draft = warpDialogDraft; const warp = layerWarpPayload();
  if (!draft || !warp) return;
  warpDialogDraft = null; $("layerWarpDialog").close(); clearTransformPreview();
  await mutate("Warping layer", () => client.warpLayer({ ...warp, layerId: draft.layer.id,
    expectedStateId: draft.stateId, expectedRevision: draft.revision }));
}

function liquifyControls() {
  const tool = Number($("liquifyToolInput").value);
  const size = Number($("liquifySizeInput").value);
  const pressure = Number($("liquifyPressureInput").value);
  const density = Number($("liquifyDensityInput").value);
  if (!Number.isInteger(tool) || tool < 0 || tool > 8 ||
      !Number.isFinite(size) || size < 1 || size > 4096 ||
      !Number.isFinite(pressure) || pressure < 1 || pressure > 100 ||
      !Number.isFinite(density) || density < 1 || density > 100) return null;
  return { tool, size, pressure, density };
}

function liquifyPoint(event) {
  const target = $("liquifyCanvas");
  const rect = target.getBoundingClientRect();
  const bounds = liquifyDraft.layer.bounds;
  return {
    x: bounds.x + Math.max(0, Math.min(target.width,
      (event.clientX - rect.left) * target.width / rect.width)),
    y: bounds.y + Math.max(0, Math.min(target.height,
      (event.clientY - rect.top) * target.height / rect.height)),
  };
}

function drawLiquifySource() {
  if (!liquifyDraft) return;
  const target = $("liquifyCanvas");
  const mask = $("liquifyMaskCanvas");
  const bounds = liquifyDraft.layer.bounds;
  target.width = mask.width = bounds.width;
  target.height = mask.height = bounds.height;
  const output = target.getContext("2d");
  output.clearRect(0, 0, target.width, target.height);
  const left = Math.max(0, bounds.x); const top = Math.max(0, bounds.y);
  const right = Math.min(snapshot.width, bounds.x + bounds.width);
  const bottom = Math.min(snapshot.height, bounds.y + bounds.height);
  if (right > left && bottom > top) {
    output.drawImage(canvas, left, top, right - left, bottom - top,
      left - bounds.x, top - bounds.y, right - left, bottom - top);
  }
  renderLiquifyMask();
}

function renderLiquifyMask() {
  const overlay = $("liquifyMaskCanvas");
  const output = overlay.getContext("2d");
  output.clearRect(0, 0, overlay.width, overlay.height);
  if (!liquifyDraft) return;
  const bounds = liquifyDraft.layer.bounds;
  if ($("liquifyShowMaskInput").checked) {
    for (const stroke of liquifyDraft.strokes) {
      if (stroke.tool !== 7 && stroke.tool !== 8) continue;
      output.save();
      output.globalCompositeOperation = stroke.tool === 8 ? "destination-out" : "source-over";
      output.globalAlpha = Math.max(.08, stroke.density / 100 * .58);
      output.strokeStyle = "#36a8ff"; output.fillStyle = "#36a8ff";
      output.lineCap = "round"; output.lineJoin = "round"; output.lineWidth = stroke.size;
      output.beginPath();
      output.moveTo(stroke.from[0] - bounds.x, stroke.from[1] - bounds.y);
      output.lineTo(stroke.to[0] - bounds.x, stroke.to[1] - bounds.y);
      output.stroke();
      output.beginPath();
      output.arc(stroke.to[0] - bounds.x, stroke.to[1] - bounds.y,
        stroke.size / 2, 0, Math.PI * 2);
      output.fill();
      output.restore();
    }
  }
  const controls = liquifyControls();
  if (liquifyDraft.hover && controls) {
    output.save(); output.globalAlpha = .92; output.strokeStyle = "#ffffff";
    output.lineWidth = 1.5;
    output.setLineDash([4, 3]); output.beginPath();
    output.arc(liquifyDraft.hover.x - bounds.x, liquifyDraft.hover.y - bounds.y,
      controls.size / 2, 0, Math.PI * 2); output.stroke(); output.restore();
  }
}

function clearLiquifyPreview() {
  ++liquifyPreviewGeneration;
  if (liquifyPreviewTimer) clearTimeout(liquifyPreviewTimer);
  liquifyPreviewTimer = 0;
  if (liquifyPreviewCancellation) Atomics.store(liquifyPreviewCancellation, 0, 1);
  liquifyPreviewCancellation = null;
}

async function runLiquifyPreview(generation) {
  liquifyPreviewTimer = 0;
  if (!liquifyDraft?.strokes.length) return;
  const draft = liquifyDraft;
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  liquifyPreviewCancellation = cancellation;
  try {
    const preview = await client.previewLiquify({ layerId: draft.layer.id,
      strokes: draft.strokes.map((stroke) => ({ ...stroke, from: [...stroke.from], to: [...stroke.to] })),
      expectedStateId: draft.stateId, expectedRevision: draft.revision, cancellation });
    if (generation !== liquifyPreviewGeneration || liquifyDraft !== draft ||
        !$("liquifyDialog").open) return;
    drawLiquifySource();
    if (preview.region.width > 0 && preview.region.height > 0) {
      const pixels = new ImageData(new Uint8ClampedArray(preview.rgba),
        preview.region.width, preview.region.height);
      $("liquifyCanvas").getContext("2d").putImageData(pixels,
        preview.region.x - draft.layer.bounds.x,
        preview.region.y - draft.layer.bounds.y);
    }
    renderLiquifyMask();
    $("liquifyStatus").textContent =
      `Live engine preview · ${draft.strokes.length} stroke${draft.strokes.length === 1 ? "" : "s"}`;
  } catch (error) {
    if (generation !== liquifyPreviewGeneration || error.code === 7) return;
    $("liquifyStatus").textContent = error.message;
  } finally {
    if (liquifyPreviewCancellation === cancellation) liquifyPreviewCancellation = null;
  }
}

function scheduleLiquifyPreview({ immediate = false } = {}) {
  if (!liquifyDraft) return;
  const generation = ++liquifyPreviewGeneration;
  if (liquifyPreviewTimer) clearTimeout(liquifyPreviewTimer);
  if (liquifyPreviewCancellation) Atomics.store(liquifyPreviewCancellation, 0, 1);
  liquifyPreviewCancellation = null;
  $("commitLiquifyButton").disabled = !liquifyDraft.strokes.length;
  $("restoreLiquifyButton").disabled = !liquifyDraft.strokes.length;
  if (!liquifyDraft.strokes.length) return;
  $("liquifyStatus").textContent = "Rendering engine preview…";
  liquifyPreviewTimer = setTimeout(() => runLiquifyPreview(generation), immediate ? 0 : 55);
}

function openLiquifyDialog() {
  const layer = selectedLayer();
  if (busy || layer?.kind !== 0 || !layer.bounds ||
      layer.bounds.width <= 0 || layer.bounds.height <= 0) return;
  liquifyDraft = { layer, stateId: snapshot.stateId, revision: snapshot.revision,
    strokes: [], active: null, hover: null };
  $("liquifyToolInput").value = "0";
  $("liquifySizeInput").value = String(Math.max(8, Math.min(4096,
    Math.round(Math.min(layer.bounds.width, layer.bounds.height) / 4))));
  $("liquifyPressureInput").value = "50"; $("liquifyDensityInput").value = "50";
  $("liquifyShowMaskInput").checked = true;
  $("commitLiquifyButton").disabled = true; $("restoreLiquifyButton").disabled = true;
  $("liquifyStatus").textContent = "Drag over the preview. Cancel leaves pixels and history unchanged.";
  $("liquifyDialog").showModal();
  drawLiquifySource();
}

async function commitLiquify() {
  const draft = liquifyDraft;
  if (!draft?.strokes.length || !liquifyControls()) return;
  const input = { layerId: draft.layer.id,
    strokes: draft.strokes.map((stroke) => ({ ...stroke, from: [...stroke.from], to: [...stroke.to] })),
    expectedStateId: draft.stateId, expectedRevision: draft.revision };
  clearLiquifyPreview(); liquifyDraft = null; $("liquifyDialog").close();
  await mutate("Applying Liquify", () => client.applyLiquify(input));
}

const layerCornerInputIds = ["layerTlXInput", "layerTlYInput", "layerTrXInput", "layerTrYInput",
  "layerBrXInput", "layerBrYInput", "layerBlXInput", "layerBlYInput"];

function affineDialogQuad() {
  const x = Number($("layerXInput").value); const y = Number($("layerYInput").value);
  const width = Number($("layerWidthInput").value); const height = Number($("layerHeightInput").value);
  const angle = Number($("layerAngleInput").value) * Math.PI / 180;
  if (![x, y, width, height, angle].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const centerX = x + width / 2; const centerY = y + height / 2;
  const flipX = $("layerFlipXInput").checked ? -1 : 1;
  const flipY = $("layerFlipYInput").checked ? -1 : 1;
  const cosine = Math.cos(angle); const sine = Math.sin(angle);
  return [[-width / 2, -height / 2], [width / 2, -height / 2],
    [width / 2, height / 2], [-width / 2, height / 2]].flatMap(([localX, localY]) => {
    const px = localX * flipX; const py = localY * flipY;
    return [centerX + px * cosine - py * sine, centerY + px * sine + py * cosine];
  });
}

function updateTransformDialogPreview() {
  if (!transformDialogDraft) return;
  const perspective = $("layerTransformModeInput").value === "perspective";
  let quad = perspective ? layerCornerInputIds.map((id) => Number($(id).value)) : affineDialogQuad();
  if (!quad || quad.some((value) => !Number.isFinite(value))) {
    transformDialogDraft.quad = null; clearTransformPreview(); renderTransformOverlay(null); return;
  }
  if (!perspective) layerCornerInputIds.forEach((id, index) => { $(id).value = quad[index].toFixed(2); });
  layerCornerInputIds.forEach((id) => { $(id).readOnly = !perspective; });
  transformDialogDraft.quad = quad; renderTransformOverlay(quad);
  scheduleTransformPreview(transformDialogDraft, quad);
}

function commitLayerQuad(target, quad, title = "Transforming layer") {
  if (!snapshot) return;
  const expectedStateId = target?.stateId ?? snapshot.stateId;
  const expectedRevision = target?.revision ?? snapshot.revision;
  clearTransformPreview(true);
  const layer = target?.primary || target;
  return mutate(title, () => target?.batch
    ? client.transformLayers({ layerIds: target.layerIds, quad, interpolation: 1,
      expectedStateId, expectedRevision })
    : client.transformLayer({ layerId: layer.id, quad,
      interpolation: 1, expectedStateId, expectedRevision }));
}

function arrangeSelectedLayers() {
  const target = transformSelection();
  const mode = Number($("layerArrangeModeInput").value);
  const reference = mode >= 6 ? 0 : Number($("layerArrangeReferenceInput").value);
  const minimum = mode >= 6 ? 3 : 2;
  if (!target || target.layerIds.length < minimum || !Number.isInteger(mode) ||
      mode < 0 || mode > 7 || ![0, 1].includes(reference)) return;
  return mutate(mode >= 6 ? "Distributing layers" : "Aligning layers", () =>
    client.arrangeLayers({ layerIds: target.layerIds, mode, reference,
      expectedStateId: target.stateId, expectedRevision: target.revision }));
}

function drawPaintSegment(draft, from, to) {
  const size = draft.brushSize;
  const erase = draft.tool === "eraser";
  const paint = (target, a, b, color, composite) => {
    target.save(); target.lineCap = "round"; target.lineJoin = "round";
    target.lineWidth = size; target.globalCompositeOperation = composite;
    target.globalAlpha = draft.opacity / 100;
    target.strokeStyle = color; target.beginPath(); target.moveTo(a.x, a.y); target.lineTo(b.x, b.y); target.stroke();
    target.beginPath(); target.arc(b.x, b.y, size / 2, 0, Math.PI * 2); target.fillStyle = color; target.fill(); target.restore();
  };
  paint(draft.overlay, from, to, erase ? "#ffffff88" : $("brushColorInput").value,
    "source-over");
}

function rasterStrokePayload(draft) {
  return { layerId: draft.layer.id,
    mode: { brush: 0, eraser: 1, clone: 2, heal: 3 }[draft.tool],
    brushSize: draft.brushSize, softness: draft.softness, color: draft.color,
    points: draft.points.map(({ x, y }) => [x, y]),
    source: draft.source ? [draft.source.x, draft.source.y] : [0, 0],
    expectedStateId: draft.stateId, expectedRevision: draft.revision };
}

function layerMaskStrokePayload(draft) {
  return { layerId: draft.layer.id, mode: draft.tool === "eraser" ? 1 : 0,
    brushSize: draft.brushSize, softness: draft.softness, color: draft.color,
    points: draft.points.map(({ x, y }) => [x, y]), source: [0, 0],
    expectedStateId: draft.stateId, expectedRevision: draft.revision };
}

function clearRasterPreview() {
  ++rasterPreviewGeneration; rasterPreviewPending = null;
  if (rasterPreviewCancellation) Atomics.store(rasterPreviewCancellation, 0, 1);
  rasterPreviewCancellation = null;
  if (rasterPreviewRestore) {
    context.putImageData(rasterPreviewRestore.pixels,
      rasterPreviewRestore.region.x, rasterPreviewRestore.region.y);
    rasterPreviewRestore = null;
  }
  $("gestureCanvas").getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

async function drainRasterPreview() {
  if (rasterPreviewInFlight) return;
  rasterPreviewInFlight = true;
  try {
    while (rasterPreviewPending) {
      const pending = rasterPreviewPending; rasterPreviewPending = null;
      try {
        const preview = await (pending.kind === "fill"
          ? client.previewRasterFill({ ...pending.payload, cancellation: pending.cancellation })
          : pending.kind === "mask"
            ? client.previewLayerMaskStroke({ ...pending.payload, cancellation: pending.cancellation })
            : client.previewRasterStroke({ ...pending.payload, cancellation: pending.cancellation }));
        if (pending.generation !== rasterPreviewGeneration || rasterPreviewPending) continue;
        if (rasterPreviewRestore) {
          context.putImageData(rasterPreviewRestore.pixels,
            rasterPreviewRestore.region.x, rasterPreviewRestore.region.y);
          rasterPreviewRestore = null;
        }
        if (preview.region.width <= 0 || preview.region.height <= 0) continue;
        rasterPreviewRestore = { region: preview.region,
          pixels: context.getImageData(preview.region.x, preview.region.y,
            preview.region.width, preview.region.height) };
        context.putImageData(new ImageData(new Uint8ClampedArray(preview.rgba),
          preview.region.width, preview.region.height), preview.region.x, preview.region.y);
      } catch (error) {
        if (error?.code !== 7 && pending.generation === rasterPreviewGeneration) {
          showError("Raster preview failed", error);
        }
      }
    }
  } finally { rasterPreviewInFlight = false; }
}

function scheduleRasterPreview(draft) {
  if (rasterPreviewCancellation) Atomics.store(rasterPreviewCancellation, 0, 1);
  rasterPreviewCancellation = new Int32Array(new SharedArrayBuffer(4));
  rasterPreviewPending = { kind: draft.maskTarget ? "mask" : "stroke",
    payload: draft.maskTarget ? layerMaskStrokePayload(draft) : rasterStrokePayload(draft),
    cancellation: rasterPreviewCancellation, generation: ++rasterPreviewGeneration };
  drainRasterPreview();
}

function rasterFillPayload(draft) {
  const modes = { "foreground-transparent": 0, "black-white": 1, sunset: 2,
    ocean: 3, solid: 4, checker: 5, dots: 6 };
  const assetId = draft.preset.startsWith("asset:") ? draft.preset.slice(6) : null;
  const gradient = assetLibrary.gradients.find((item) => item.id === assetId);
  const pattern = assetLibrary.patterns.find((item) => item.id === assetId);
  const custom = gradient ? { mode: 7, color: [...colorBytes(gradient.start), 255],
    secondaryColor: [...colorBytes(gradient.end), 255], patternSize: 8 } : pattern ? {
    mode: pattern.kind === "checker" ? 8 : 9,
    color: [...colorBytes(pattern.foreground), 255],
    secondaryColor: [...colorBytes(pattern.background), 255], patternSize: pattern.size,
  } : null;
  return { layerId: draft.layer.id, mode: custom?.mode ?? modes[draft.preset],
    color: custom?.color ?? draft.color,
    secondaryColor: custom?.secondaryColor, patternSize: custom?.patternSize,
    start: [draft.start.x, draft.start.y], end: [draft.end.x, draft.end.y],
    expectedStateId: draft.stateId, expectedRevision: draft.revision };
}

function scheduleRasterFillPreview(draft) {
  if (rasterPreviewCancellation) Atomics.store(rasterPreviewCancellation, 0, 1);
  rasterPreviewCancellation = new Int32Array(new SharedArrayBuffer(4));
  rasterPreviewPending = { kind: "fill", payload: rasterFillPayload(draft),
    cancellation: rasterPreviewCancellation, generation: ++rasterPreviewGeneration };
  drainRasterPreview();
}

function beginPaint(event) {
  const layer = selectedLayer();
  const maskTarget = $("paintTargetSelect").value === "mask";
  if (busy || event.button !== 0 ||
      (maskTarget ? !layer?.mask || layer.mask.disabled ||
        (canvasTool !== "brush" && canvasTool !== "eraser") : layer?.kind !== 0)) return;
  const point = canvasPoint(event);
  if ((canvasTool === "clone" || canvasTool === "heal") && event.altKey) {
    cloneSource = point; setSessionState("document", "Clone source set"); return;
  }
  if ((canvasTool === "clone" || canvasTool === "heal") && !cloneSource) {
    showError("Set a source first", new Error("Alt-click the canvas to choose a clone/heal source.")); return;
  }
  canvas.setPointerCapture(event.pointerId);
  const opacity = Math.round(Number($("brushOpacityInput").value));
  const softness = Math.round(Number($("brushSoftnessInput").value));
  if (!Number.isInteger(opacity) || opacity < 1 || opacity > 100 ||
      !Number.isInteger(softness) || softness < 0 || softness > 100) return;
  const draft = { pointerId: event.pointerId, tool: canvasTool, layer, last: point,
    start: point, source: cloneSource, ready: true, points: [point],
    maskTarget,
    stateId: snapshot.stateId, revision: snapshot.revision,
    brushSize: Math.round(Number($("brushSizeInput").value)), softness, opacity,
    color: [...colorBytes($("brushColorInput").value), Math.round(opacity * 2.55)],
    overlay: $("gestureCanvas").getContext("2d") };
  paintDraft = draft;
  drawPaintSegment(draft, point, point); scheduleRasterPreview(draft);
}

async function fillSelectedPixels() {
  const layer = selectedLayer();
  if (busy || layer?.kind !== 0) return;
  const draft = { layer, preset: $("paintPresetSelect").value,
    color: [...colorBytes($("brushColorInput").value), 255],
    start: { x: layer.bounds.x, y: layer.bounds.y },
    end: { x: layer.bounds.x + layer.bounds.width, y: layer.bounds.y },
    stateId: snapshot.stateId, revision: snapshot.revision };
  return mutate("Filling pixels", () => client.applyRasterFill(rasterFillPayload(draft)));
}

async function beginGradient(event) {
  const layer = selectedLayer();
  if (busy || layer?.kind !== 0 || event.button !== 0) return;
  const start = canvasPoint(event); canvas.setPointerCapture(event.pointerId);
  gradientDraft = { pointerId: event.pointerId, layer, start, end: start,
    preset: $("paintPresetSelect").value,
    color: [...colorBytes($("brushColorInput").value), 255],
    stateId: snapshot.stateId, revision: snapshot.revision };
  scheduleRasterFillPreview(gradientDraft);
}

async function finishGradient(event) {
  const draft = gradientDraft;
  if (!draft || event.pointerId !== draft.pointerId) return;
  gradientDraft = null;
  clearRasterPreview();
  await mutate("Applying gradient", () => client.applyRasterFill(rasterFillPayload(draft)));
}

function movePaint(event) {
  if (!paintDraft?.ready || event.pointerId !== paintDraft.pointerId) return;
  const point = canvasPoint(event);
  if (Math.hypot(point.x - paintDraft.last.x, point.y - paintDraft.last.y) < .5) return;
  if (paintDraft.points.length >= 65536) {
    finishPaint(event, true);
    showError("Raster stroke cancelled", new Error("A stroke cannot exceed 65,536 sampled points."));
    return;
  }
  drawPaintSegment(paintDraft, paintDraft.last, point); paintDraft.last = point;
  paintDraft.points.push(point); scheduleRasterPreview(paintDraft);
}

function finishPaint(event, cancelled = false) {
  const draft = paintDraft;
  if (!draft || event.pointerId !== draft.pointerId) return;
  paintDraft = null;
  clearRasterPreview();
  if (cancelled || !draft.ready) return;
  mutate(draft.maskTarget ? (draft.tool === "eraser" ? "Revealing layer mask" : "Painting layer mask")
    : draft.tool === "eraser" ? "Erasing pixels" : "Painting pixels", () =>
    draft.maskTarget
      ? client.applyLayerMaskStroke(layerMaskStrokePayload(draft))
      : client.applyRasterStroke(rasterStrokePayload(draft)));
}

function retouchControls() {
  const brushSize = Math.round(Number($("brushSizeInput").value));
  const softness = Math.round(Number($("retouchSoftnessInput").value));
  const mode = Number($("patchModeInput").value);
  if (!Number.isInteger(brushSize) || brushSize < 1 || brushSize > 4096 ||
      !Number.isInteger(softness) || softness < 0 || softness > 100 ||
      ![1, 2].includes(mode)) return null;
  return { brushSize, softness,
    sampleAllLayers: $("retouchSampleAllInput").checked,
    transparent: $("patchTransparentInput").checked,
    mode };
}

function drawSpotHealingFeedback(draft, from, to) {
  const target = draft.overlay;
  target.save(); target.lineCap = "round"; target.lineJoin = "round";
  target.lineWidth = draft.brushSize;
  target.strokeStyle = "#d7ff554d"; target.fillStyle = "#d7ff554d";
  target.beginPath(); target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke();
  target.beginPath(); target.arc(to.x, to.y, draft.brushSize / 2, 0, Math.PI * 2); target.fill();
  target.lineWidth = 1 / Math.max(zoom, .01); target.strokeStyle = "#f5ffd5";
  target.beginPath(); target.arc(to.x, to.y, draft.brushSize / 2, 0, Math.PI * 2); target.stroke();
  target.restore();
}

function renderPatchFeedback(draft) {
  const target = draft.overlay;
  target.clearRect(0, 0, canvas.width, canvas.height);
  const dx = draft.deltaX; const dy = draft.deltaY;
  target.save(); target.globalAlpha = .68;
  for (const rect of snapshot.selection || []) {
    if (draft.mode === 2) {
      target.drawImage(canvas, rect.x, rect.y, rect.width, rect.height,
        rect.x + dx, rect.y + dy, rect.width, rect.height);
    } else {
      target.drawImage(canvas, rect.x + dx, rect.y + dy, rect.width, rect.height,
        rect.x, rect.y, rect.width, rect.height);
    }
  }
  target.globalAlpha = 1; target.setLineDash([6 / Math.max(zoom, .01), 4 / Math.max(zoom, .01)]);
  target.lineWidth = 1 / Math.max(zoom, .01); target.strokeStyle = "#d7ff55";
  for (const rect of snapshot.selection || []) {
    target.strokeRect(rect.x + dx, rect.y + dy, rect.width, rect.height);
  }
  target.restore();
}

function beginRetouch(event) {
  const layer = selectedLayer(); const controls = retouchControls();
  if (busy || event.button !== 0 || layer?.kind !== 0 || !controls) return;
  if (canvasTool === "patch" && !snapshot.selection?.length) {
    showError("Patch Tool", new Error("Select an area before using Patch Tool.")); return;
  }
  const point = canvasPoint(event); canvas.setPointerCapture(event.pointerId);
  retouchDraft = { pointerId: event.pointerId, tool: canvasTool, layer,
    stateId: snapshot.stateId, revision: snapshot.revision, start: point, last: point,
    points: canvasTool === "spotHealing" ? [point] : [], deltaX: 0, deltaY: 0,
    mode: controls.mode, ...controls, overlay: $("gestureCanvas").getContext("2d") };
  if (canvasTool === "spotHealing") drawSpotHealingFeedback(retouchDraft, point, point);
  else renderPatchFeedback(retouchDraft);
}

function moveRetouch(event) {
  const draft = retouchDraft;
  if (!draft || draft.pointerId !== event.pointerId) return;
  const point = canvasPoint(event);
  if (draft.tool === "spotHealing") {
    if (Math.hypot(point.x - draft.last.x, point.y - draft.last.y) < .5) return;
    if (draft.points.length >= 4096) return;
    drawSpotHealingFeedback(draft, draft.last, point); draft.last = point; draft.points.push(point);
  } else {
    draft.deltaX = Math.round(point.x - draft.start.x);
    draft.deltaY = Math.round(point.y - draft.start.y);
    renderPatchFeedback(draft);
  }
}

async function commitRetouch(draft) {
  clearError();
  const spot = draft.tool === "spotHealing";
  const title = spot ? "Applying Spot Healing" : "Applying Patch";
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  setBusy(true, title, "Committing one canonical engine revision");
  $("cancelOperationButton").hidden = false; $("cancelOperationButton").disabled = false;
  cancelActiveOperation = () => Atomics.store(cancellation, 0, 1);
  try {
    const before = snapshot;
    const next = await client.applyRetouchRepair({ layerId: draft.layer.id,
      mode: spot ? 0 : draft.mode,
      points: spot ? draft.points.map(({ x, y }) => [x, y]) : [],
      brushSize: draft.brushSize, softness: draft.softness,
      deltaX: draft.deltaX, deltaY: draft.deltaY,
      transparent: !spot && draft.transparent,
      sampleAllLayers: draft.sampleAllLayers, cancellation,
      expectedStateId: draft.stateId, expectedRevision: draft.revision });
    recordHistoryMutation(before, next, title); await acceptSnapshot(next); scheduleCheckpoint(next);
  } catch (error) {
    if (error?.code === 7) setSessionState("document", spot ? "Spot Healing cancelled" : "Patch cancelled");
    else showError("Retouch repair failed", error);
  } finally { setBusy(false); }
}

function finishRetouch(event, cancelled = false) {
  const draft = retouchDraft;
  if (!draft || draft.pointerId !== event.pointerId) return;
  retouchDraft = null;
  draft.overlay.clearRect(0, 0, canvas.width, canvas.height);
  if (cancelled || (draft.tool === "patch" && draft.deltaX === 0 && draft.deltaY === 0)) return;
  commitRetouch(draft);
}

const localBrushModes = Object.freeze({ smudge: 0, dodge: 1, burn: 2,
  sponge: 3, blur: 4, sharpen: 5 });
const localBrushTitles = Object.freeze({
  smudge: "Applying Smudge Brush",
  dodge: "Applying Dodge Brush",
  burn: "Applying Burn Brush",
  sponge: "Applying Sponge Brush",
  blur: "Applying Blur Brush",
  sharpen: "Applying Sharpen Brush",
});

function localBrushControls() {
  const brushSize = Math.round(Number($("brushSizeInput").value));
  const softness = Math.round(Number($("localBrushSoftnessInput").value));
  const strength = Math.round(Number($("localBrushStrengthInput").value));
  const toneRange = Number($("localToneRangeInput").value);
  if (!Number.isInteger(brushSize) || brushSize < 1 || brushSize > 4096 ||
      !Number.isInteger(softness) || softness < 0 || softness > 100 ||
      !Number.isInteger(strength) || strength < 1 || strength > 100 ||
      ![0, 1, 2].includes(toneRange)) return null;
  return { brushSize, softness, strength, toneRange,
    protectTones: $("localProtectTonesInput").checked,
    spongeSaturate: $("localSpongeModeInput").value === "1",
    spongeVibrance: $("localSpongeVibranceInput").checked };
}

function drawLocalBrushFeedback(draft, from, to) {
  const target = draft.overlay;
  target.save(); target.lineCap = "round"; target.lineJoin = "round";
  target.lineWidth = draft.brushSize; target.strokeStyle = "#70d7ff3d";
  target.beginPath(); target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke();
  target.lineWidth = 1 / Math.max(zoom, .01); target.strokeStyle = "#bdeeff";
  target.beginPath(); target.arc(to.x, to.y, draft.brushSize / 2, 0, Math.PI * 2);
  target.stroke(); target.restore();
}

function localBrushPoint(event) {
  const point = canvasPoint(event);
  return { x: Math.min(snapshot.width - 1, point.x),
    y: Math.min(snapshot.height - 1, point.y) };
}

function beginLocalBrush(event) {
  const layer = selectedLayer(); const controls = localBrushControls();
  if (busy || event.button !== 0 || layer?.kind !== 0 || !controls) return;
  const point = localBrushPoint(event); canvas.setPointerCapture(event.pointerId);
  localBrushDraft = { pointerId: event.pointerId, tool: canvasTool, layer,
    stateId: snapshot.stateId, revision: snapshot.revision, points: [point], last: point,
    ...controls, overlay: $("gestureCanvas").getContext("2d") };
  drawLocalBrushFeedback(localBrushDraft, point, point);
}

function moveLocalBrush(event) {
  const draft = localBrushDraft;
  if (!draft || draft.pointerId !== event.pointerId) return;
  const point = localBrushPoint(event);
  if (Math.hypot(point.x - draft.last.x, point.y - draft.last.y) < .5 ||
      draft.points.length >= 4096) return;
  drawLocalBrushFeedback(draft, draft.last, point);
  draft.last = point; draft.points.push(point);
}

async function commitLocalBrush(draft) {
  const title = localBrushTitles[draft.tool];
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  clearError(); setBusy(true, title, "Committing one canonical engine revision");
  $("cancelOperationButton").hidden = false; $("cancelOperationButton").disabled = false;
  cancelActiveOperation = () => Atomics.store(cancellation, 0, 1);
  try {
    const before = snapshot;
    const next = await client.applyLocalAdjustmentBrush({ layerId: draft.layer.id,
      mode: localBrushModes[draft.tool],
      points: draft.points.map(({ x, y }) => [x, y]), brushSize: draft.brushSize,
      softness: draft.softness, strength: draft.strength, toneRange: draft.toneRange,
      protectTones: draft.protectTones, spongeSaturate: draft.spongeSaturate,
      spongeVibrance: draft.spongeVibrance, cancellation,
      expectedStateId: draft.stateId, expectedRevision: draft.revision });
    recordHistoryMutation(before, next, title); await acceptSnapshot(next); scheduleCheckpoint(next);
  } catch (error) {
    if (error?.code === 7) setSessionState("document", "Local brush cancelled");
    else showError("Local brush failed", error);
  } finally { setBusy(false); }
}

function finishLocalBrush(event, cancelled = false) {
  const draft = localBrushDraft;
  if (!draft || draft.pointerId !== event.pointerId) return;
  localBrushDraft = null;
  draft.overlay.clearRect(0, 0, canvas.width, canvas.height);
  if (!cancelled && (draft.tool !== "smudge" || draft.points.length > 1)) commitLocalBrush(draft);
}

function advancedPaintControls(tool) {
  const brushSize = Math.round(Number($("brushSizeInput").value));
  const softness = Math.round(Number($("advancedPaintSoftnessInput").value));
  const flow = Math.round(Number($("advancedPaintFlowInput").value));
  const wet = Math.round(Number($("mixerWetInput").value));
  const load = Math.round(Number($("mixerLoadInput").value));
  const mix = Math.round(Number($("mixerMixInput").value));
  const patternSize = Math.round(Number($("advancedPatternSizeInput").value));
  if (!Number.isInteger(brushSize) || brushSize < 1 || brushSize > 4096 ||
      !Number.isInteger(softness) || softness < 0 || softness > 100 ||
      !Number.isInteger(flow) || flow < 1 || flow > 100 ||
      !Number.isInteger(wet) || wet < 0 || wet > 100 ||
      !Number.isInteger(load) || load < 1 || load > 100 ||
      !Number.isInteger(mix) || mix < 0 || mix > 100 ||
      !Number.isInteger(patternSize) || patternSize < 1 || patternSize > 128) return null;
  const selectedPattern = $("advancedPatternInput").value;
  const asset = selectedPattern.startsWith("asset:")
    ? assetLibrary.patterns.find((item) => item.id === selectedPattern.slice(6)) : null;
  const kind = asset?.kind ?? selectedPattern;
  if (tool === "patternStamp" && !["checker", "dots"].includes(kind)) return null;
  return { brushSize, softness, flow, wet, load, mix,
    sampleAllLayers: $("mixerSampleAllInput").checked,
    pattern: kind === "dots" ? 1 : 0,
    patternSize: asset?.size ?? patternSize,
    color: asset ? [...colorBytes(asset.foreground), 255]
      : [...colorBytes($("brushColorInput").value), 255],
    secondaryColor: asset ? [...colorBytes(asset.background), 255]
      : [...colorBytes($("advancedPatternSecondaryInput").value), 255],
    patternAligned: $("advancedPatternAlignedInput").checked };
}

function advancedPaintPoint(event) {
  const point = canvasPoint(event);
  return { x: Math.max(0, Math.min(snapshot.width - 1, point.x)),
    y: Math.max(0, Math.min(snapshot.height - 1, point.y)) };
}

function drawAdvancedPaintFeedback(draft, from, to) {
  const target = draft.overlay;
  target.save(); target.lineCap = "round"; target.lineJoin = "round";
  target.lineWidth = draft.brushSize;
  target.strokeStyle = draft.tool === "mixer" ? "#ffb54742" : "#bd8cff42";
  target.beginPath(); target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke();
  target.lineWidth = 1 / Math.max(zoom, .01);
  target.strokeStyle = draft.tool === "mixer" ? "#ffd7a3" : "#e5ceff";
  target.beginPath(); target.arc(to.x, to.y, draft.brushSize / 2, 0, Math.PI * 2);
  target.stroke(); target.restore();
}

function beginAdvancedPaint(event) {
  const layer = selectedLayer(); const controls = advancedPaintControls(canvasTool);
  if (busy || event.button !== 0 || layer?.kind !== 0 || !controls) return;
  const point = advancedPaintPoint(event); canvas.setPointerCapture(event.pointerId);
  advancedPaintDraft = { pointerId: event.pointerId, tool: canvasTool, layer,
    stateId: snapshot.stateId, revision: snapshot.revision, points: [point], last: point,
    patternAnchor: controls.patternAligned ? [0, 0] : [Math.floor(point.x), Math.floor(point.y)],
    ...controls, overlay: $("gestureCanvas").getContext("2d") };
  drawAdvancedPaintFeedback(advancedPaintDraft, point, point);
}

function moveAdvancedPaint(event) {
  const draft = advancedPaintDraft;
  if (!draft || draft.pointerId !== event.pointerId) return;
  const point = advancedPaintPoint(event);
  if (Math.hypot(point.x - draft.last.x, point.y - draft.last.y) < .5 ||
      draft.points.length >= 4096) return;
  drawAdvancedPaintFeedback(draft, draft.last, point);
  draft.last = point; draft.points.push(point);
}

async function commitAdvancedPaint(draft) {
  const title = draft.tool === "mixer" ? "Applying Mixer Brush" : "Applying Pattern Stamp";
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  clearError(); setBusy(true, title, "Committing one canonical engine revision");
  $("cancelOperationButton").hidden = false; $("cancelOperationButton").disabled = false;
  cancelActiveOperation = () => Atomics.store(cancellation, 0, 1);
  try {
    const before = snapshot;
    const next = await client.applyAdvancedPaintStroke({ layerId: draft.layer.id,
      mode: draft.tool === "mixer" ? 0 : 1,
      points: draft.points.map(({ x, y }) => [x, y]), brushSize: draft.brushSize,
      softness: draft.softness, flow: draft.flow, color: draft.color,
      wet: draft.wet, load: draft.load, mix: draft.mix,
      sampleAllLayers: draft.sampleAllLayers, pattern: draft.pattern,
      patternSize: draft.patternSize, secondaryColor: draft.secondaryColor,
      patternAnchor: draft.patternAnchor, patternAligned: draft.patternAligned,
      cancellation, expectedStateId: draft.stateId, expectedRevision: draft.revision });
    recordHistoryMutation(before, next, title); await acceptSnapshot(next); scheduleCheckpoint(next);
  } catch (error) {
    if (error?.code === 7) setSessionState("document", "Advanced paint cancelled");
    else showError("Advanced paint failed", error);
  } finally { setBusy(false); }
}

function finishAdvancedPaint(event, cancelled = false) {
  const draft = advancedPaintDraft;
  if (!draft || draft.pointerId !== event.pointerId) return;
  advancedPaintDraft = null;
  draft.overlay.clearRect(0, 0, canvas.width, canvas.height);
  if (!cancelled) commitAdvancedPaint(draft);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

async function openPicker() {
  if (busy) return;
  try {
    const picked = await fileLifecycle.pickOpen();
    if (picked.kind === "fallback") $("fileInput").click();
    else if (picked.kind === "handle") await openFile(picked.file, picked.handle);
  } catch (error) { showError("Could not open document", error); }
}
registerCommand("document.open", "openButton", openPicker, () => !busy);
registerCommand("document.new", "newButton", newDocument, () => !busy);
registerCommand("document.recovery", "recoveryButton", openRecoveryDialog, () => !busy);
registerCommand("document.versions", "versionsButton", openVersionHistoryDialog,
  () => !busy && Boolean(snapshot) && workspaceAvailable);
registerCommand("document.assets", "assetsButton", () => $("assetsDialog").showModal(),
  () => !busy && workspaceAvailable);
registerCommand("support.diagnostics", "diagnosticsButton", openDiagnosticsDialog, () => !busy);
registerCommand("document.save", "saveButton", saveDocument, () => !busy && Boolean(snapshot));
registerCommand("document.saveAs", "saveAsButton", () => saveDocument(true),
  () => !busy && Boolean(snapshot));
registerCommand("layer.openSmartObject", "openSmartObjectButton", openSmartObjectContents,
  () => !busy && Boolean(selectedLayer()?.smartObject?.contentsEditable));
registerCommand("layer.filter", "filterLayerButton", openFilterDialog,
  () => !busy && selectedLayer()?.kind === 0);
registerCommand("layer.liquify", "liquifyLayerButton", openLiquifyDialog,
  () => !busy && selectedLayer()?.kind === 0);
registerCommand("document.export", "exportButton", exportDocument, () => !busy && Boolean(snapshot));
registerCommand("document.copyPixels", "copyPixelsButton", copyRenderedPixels, () => !busy && Boolean(snapshot));
registerCommand("document.cutPixels", "cutPixelsButton", cutSelectedPixels, () => !busy &&
  selectedLayers().length === 1 && selectedLayer()?.kind === 0 && selectedLayer()?.visible &&
  !selectedLayer()?.lockFlags);
registerCommand("document.pastePixels", "pastePixelsButton", pastePixels, () => !busy && Boolean(snapshot) &&
  Boolean(layerClipboard || pixelClipboard || clipboardImageBlob || navigator.clipboard?.read));
registerCommand("layer.newPixel", "createPixelLayerButton", createPixelLayer,
  () => !busy && Boolean(snapshot));
registerCommand("layer.toggleClipping", "toggleClippingButton", () => {
  const layer = selectedLayer();
  return layer ? mutate(layer.clipped ? "Releasing clipping mask" : "Creating clipping mask",
    () => client.setLayerClipping(layer.id, !layer.clipped)) : undefined;
}, () => !busy && selectedLayers().length === 1 && canToggleLayerClipping(selectedLayer()));
registerCommand("layer.mergeSelected", "mergeLayersButton", () => {
  const ids = selectedLayerIdsTopToBottom({ rootsOnly: true });
  return ids.length >= 2 ? mutate("Merging selected layers", () => client.mergeLayers(ids, "Merged")) : undefined;
}, () => !busy && selectedLayerIdsTopToBottom({ rootsOnly: true }).length >= 2 &&
  new Set(selectedLayers().map((item) => String(item.parentId))).size === 1 &&
  selectedLayers().every((item) => item.visible));
registerCommand("layer.layerViaCopy", "layerViaCopyButton", layerViaCopy, () => !busy &&
  Boolean(snapshot?.selection?.length) && selectedLayers().length === 1 &&
  selectedLayer()?.kind === 0 && selectedLayer()?.visible);
registerCommand("history.undo", "undoButton", () => navigateHistory(-1), () => !busy && Boolean(snapshot?.canUndo));
registerCommand("history.redo", "redoButton", () => navigateHistory(1), () => !busy && Boolean(snapshot?.canRedo));
registerCommand("document.canvas", "transformButton", openDocumentDialog, () => !busy && Boolean(snapshot));
registerCommand("tool.move", "moveToolButton", () => setCanvasTool("move"),
  () => !busy && Boolean(selectedLayer()));
registerCommand("tool.crop", "cropToolButton", () => setCanvasTool("crop"),
  () => !busy && Boolean(snapshot));
for (const tool of ["marquee", "lasso", "polygon", "magic", "quickSelect", "magnetic", "quickMask"])
  registerCommand(`tool.${tool}`, `${tool}ToolButton`, () => setCanvasTool(tool),
    () => !busy && Boolean(snapshot));
registerCommand("tool.pan", "panToolButton", () => setCanvasTool("pan"),
  () => !busy && Boolean(snapshot));
registerCommand("tool.brush", "brushToolButton", () => activateRasterTool("brush"),
  () => !busy && Boolean(snapshot) && (selectedLayer()?.kind === 0 || snapshot.layers.length === 0));
registerCommand("tool.mixer", "mixerToolButton", () => setCanvasTool("mixer"),
  () => !busy && selectedLayer()?.kind === 0);
registerCommand("tool.patternStamp", "patternStampToolButton", () => setCanvasTool("patternStamp"),
  () => !busy && selectedLayer()?.kind === 0);
registerCommand("tool.eraser", "eraserToolButton", () => activateRasterTool("eraser"),
  () => !busy && Boolean(snapshot) && (selectedLayer()?.kind === 0 || snapshot.layers.length === 0));
registerCommand("tool.clone", "cloneToolButton", () => setCanvasTool("clone"),
  () => !busy && selectedLayer()?.kind === 0);
registerCommand("tool.heal", "healToolButton", () => setCanvasTool("heal"),
  () => !busy && selectedLayer()?.kind === 0);
registerCommand("tool.spotHealing", "spotHealingToolButton", () => setCanvasTool("spotHealing"),
  () => !busy && selectedLayer()?.kind === 0);
registerCommand("tool.patch", "patchToolButton", () => setCanvasTool("patch"),
  () => !busy && selectedLayer()?.kind === 0 && Boolean(snapshot?.selection?.length));
for (const tool of ["smudge", "dodge", "burn", "sponge", "blur", "sharpen"]) {
  registerCommand(`tool.${tool}`, `${tool}ToolButton`, () => setCanvasTool(tool),
    () => !busy && selectedLayer()?.kind === 0);
}
registerCommand("tool.gradient", "gradientToolButton", () => activateRasterTool("gradient"),
  () => !busy && Boolean(snapshot) && (selectedLayer()?.kind === 0 || snapshot.layers.length === 0));
registerCommand("tool.fill", "fillToolButton", fillSelectedPixels, () => !busy && selectedLayer()?.kind === 0);
registerCommand("tool.pen", "penToolButton", activatePenTool, () => !busy && Boolean(snapshot));
registerCommand("tool.text", "textToolButton", () => { setCanvasTool("text"); openTextDialog(); },
  () => !busy && Boolean(snapshot));
registerCommand("selection.all", "selectAllButton", () => {
  return mutate("Selecting all", () => client.setSelection([{ x: 0, y: 0, width: snapshot.width, height: snapshot.height }]));
}, () => !busy && Boolean(snapshot));
registerCommand("selection.clear", "clearSelectionButton", () => mutate("Clearing selection", () => client.clearSelection()),
  () => !busy && Boolean(snapshot?.selection?.length));
registerCommand("view.zoomOut", "zoomOutButton", () => setZoom(zoom / 1.25), () => Boolean(snapshot));
registerCommand("view.zoomIn", "zoomInButton", () => setZoom(zoom * 1.25), () => Boolean(snapshot));
registerCommand("view.fit", "zoomFitButton", () => setZoom("fit"), () => Boolean(snapshot));
registerCommand("view.actualPixels", "zoomActualButton", () => setZoom(1), () => Boolean(snapshot));
registerCommand("view.panels", "togglePanelsButton", () => {
  const hidden = shell.classList.toggle("panels-hidden");
  $("togglePanelsButton").setAttribute("aria-pressed", String(hidden));
  persistPreferences();
});
registerCommand("view.guide.vertical", "addVerticalGuideButton", () => addCenteredGuide("vertical"),
  () => !busy && Boolean(snapshot));
registerCommand("view.guide.horizontal", "addHorizontalGuideButton", () => addCenteredGuide("horizontal"),
  () => !busy && Boolean(snapshot));
for (const [id, command] of commandRegistry) {
  command.button?.addEventListener("click", () => executeCommand(id));
}

$("emptyOpenButton").addEventListener("click", openPicker);
$("starterDialog").addEventListener("close", () => {
  const target = starterReturnFocus?.isConnected === false || starterReturnFocus?.disabled
    ? $("emptyNewButton") : starterReturnFocus;
  queueMicrotask(() => target?.focus?.({ preventScroll: true }));
});
$("starterCloseButton").addEventListener("click", () => $("starterDialog").close("cancel"));
$("emptyNewButton").addEventListener("click", openStarterDialog);
for (const button of document.querySelectorAll("[data-starter-preset]")) {
  button.addEventListener("click", () => createStarter(starterPreset(button.dataset.starterPreset)));
}
$("starterForm").addEventListener("submit", (event) => {
  event.preventDefault();
  createStarter({
    width: $("starterWidthInput").value,
    height: $("starterHeightInput").value,
  });
});
$("starterForm").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || !event.target.matches("input")) return;
  event.preventDefault();
  $("starterForm").requestSubmit($("starterCustomCreateButton"));
});
for (const [sourceId, targetId] of [["starterOpenButton", "openButton"],
  ["starterRecoveryButton", "recoveryButton"], ["starterHelpButton", "helpButton"]]) {
  $(sourceId).addEventListener("click", () => {
    $("starterDialog").close("action");
    queueMicrotask(() => $(targetId).click());
  });
}
$("createVersionButton").addEventListener("click", createLocalVersion);
$("versionLabelInput").addEventListener("input", () => $("versionLabelInput").setCustomValidity(""));
$("saveFormatSelect").addEventListener("change", () => {
  if (!snapshot) return;
  documentSaveFormats.set(snapshot.documentId, $("saveFormatSelect").value);
  updateControls(); scheduleCheckpoint(snapshot);
});
$("fileInput").addEventListener("change", () => { openFile($("fileInput").files[0]); $("fileInput").value = ""; });
$("dismissErrorButton").addEventListener("click", clearError);
$("importLayerButton").addEventListener("click", () => { if (!busy && snapshot) $("imageInput").click(); });
$("imageInput").addEventListener("change", () => { importPixelLayer($("imageInput").files[0]); $("imageInput").value = ""; });

const canvasContextMenu = $("canvasContextMenu");
function closeCanvasContextMenu({ restoreFocus = false } = {}) {
  if (canvasContextMenu.hidden) return;
  canvasContextMenu.hidden = true;
  if (restoreFocus) $("canvasViewport").focus({ preventScroll: true });
}
function syncCanvasContextMenu() {
  const penPathActionAvailable = canvasTool === "pen" && !penDraft?.points.length &&
    pathHasClosedArea(selectedPath());
  for (const item of canvasContextMenu.querySelectorAll('[data-pen-path-action="make-selection"]')) {
    item.hidden = !penPathActionAvailable;
  }
  for (const button of canvasContextMenu.querySelectorAll("button")) {
    const command = button.dataset.commandProxy && commandRegistry.get(button.dataset.commandProxy);
    const target = button.dataset.targetProxy && $(button.dataset.targetProxy);
    button.disabled = button.dataset.penPathAction ? !penPathActionAvailable :
      command ? !command.enabled() : !target || target.disabled;
  }
}
canvasContextMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  closeCanvasContextMenu();
  if (button.dataset.penPathAction === "make-selection") {
    $("selectionModeInput").value = "replace";
    makeSelectedPathSelection({ combine: 0 });
  } else if (button.dataset.commandProxy) executeCommand(button.dataset.commandProxy);
  else $(button.dataset.targetProxy)?.click();
});
canvasContextMenu.addEventListener("keydown", (event) => {
  const buttons = [...canvasContextMenu.querySelectorAll("button:not([hidden]):not(:disabled)")];
  const index = buttons.indexOf(document.activeElement);
  if (event.key === "Escape") { event.preventDefault(); closeCanvasContextMenu({ restoreFocus: true }); }
  if (["ArrowDown", "ArrowUp"].includes(event.key) && buttons.length) {
    event.preventDefault();
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
  }
});
canvas.addEventListener("contextmenu", (event) => {
  if (!snapshot) return;
  event.preventDefault(); syncCanvasContextMenu();
  canvasContextMenu.hidden = false;
  const rect = canvasContextMenu.getBoundingClientRect();
  canvasContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - rect.width - 8))}px`;
  canvasContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - rect.height - 8))}px`;
  canvasContextMenu.querySelector("button:not([hidden]):not(:disabled)")?.focus({ preventScroll: true });
});
window.addEventListener("pointerdown", (event) => {
  if (!canvasContextMenu.hidden && !canvasContextMenu.contains(event.target)) closeCanvasContextMenu();
});
$("removeLayerButton").addEventListener("click", () => {
  const ids = selectedLayerIdsTopToBottom({ rootsOnly: true });
  if (ids.length) mutate(ids.length > 1 ? "Deleting layers" : "Deleting layer",
    () => client.removeLayers(ids));
});
$("groupLayerButton").addEventListener("click", () => {
  const ids = selectedLayerIdsTopToBottom({ rootsOnly: true });
  if (ids.length) mutate(ids.length > 1 ? "Grouping layers" : "Grouping layer",
    () => client.groupLayers(ids, "Group"));
});
$("ungroupLayerButton").addEventListener("click", () => {
  const ids = selectedLayers().filter((layer) => layer.kind === 1).map((layer) => layer.id);
  if (ids.length) mutate("Ungrouping layers", () => client.ungroupLayers(ids));
});
$("invertLayerButton").addEventListener("click", invertSelectedLayer);
$("filterKindInput").addEventListener("change", renderFilterParameters);
$("adjustmentKindInput").addEventListener("change", () => renderAdjustmentParameters());
$("commitFilterButton").addEventListener("click", () => {
  try { commitFilter(); } catch (error) { showError("Could not apply filter", error); }
});
$("commitAdjustmentButton").addEventListener("click", async () => {
  try { await commitAdjustment(); } catch (error) { showError("Could not apply adjustment", error); }
});
$("textLayerButton").addEventListener("click", openTextDialog);
$("shapeLayerButton").addEventListener("click", openShapeDialog);
$("adjustmentLayerButton").addEventListener("click", openAdjustmentDialog);
$("editLayerTypeButton").addEventListener("click", editSelectedLayerType);
$("smartObjectButton").addEventListener("click", () => $("smartObjectInput").click());
$("smartObjectInput").addEventListener("change", () => { placeSmartObject($("smartObjectInput").files[0]); $("smartObjectInput").value = ""; });
$("smartFilterButton").addEventListener("click", openSmartFilterDialog);
$("commitShapeButton").addEventListener("click", async () => {
  try { await commitShape(); } catch (error) { showError("Could not apply shape", error); }
});
$("commitSmartFilterButton").addEventListener("click", commitSmartFilter);
$("layerTransformButton").addEventListener("click", openLayerTransformDialog);
$("layerWarpButton").addEventListener("click", openLayerWarpDialog);
$("arrangeLayersButton").addEventListener("click", arrangeSelectedLayers);
$("layerArrangeModeInput").addEventListener("change", updateControls);
$("commitTextButton").addEventListener("click", commitTextDialog);
for (const id of ["textFontInput", "textSizeInput", "textColorInput", "textBoldInput",
  "textItalicInput", "textTrackingInput", "textLeadingInput", "textHorizontalScaleInput",
  "textVerticalScaleInput"]) $(id).addEventListener("input", () => { textDialogStyleDirty = true; });
for (const id of ["textAlignmentInput", "textFirstIndentInput", "textStartIndentInput",
  "textEndIndentInput", "textSpaceBeforeInput", "textSpaceAfterInput", "textAutoLeadingInput"])
  $(id).addEventListener("input", () => { textDialogParagraphDirty = true; });
$("textValueInput").addEventListener("input", () => {
  const value = $("textValueInput").value.replace(/\r\n?/g, "\n");
  if (value === textDialogOriginalValue) {
    textDialogRuns = textDialogOriginalRuns.map((run) => ({ ...run, color: [...run.color] }));
    textDialogParagraphRuns = textDialogOriginalParagraphRuns.map((run) => ({ ...run }));
    textDialogStyleDirty = false; textDialogParagraphDirty = false;
    renderTextRunList(); renderParagraphRunList();
    return;
  }
  textDialogRuns = []; textDialogParagraphRuns = [];
  textDialogStyleDirty = true; textDialogParagraphDirty = true;
  renderTextRunList(); renderParagraphRunList();
});
$("applyTextRangeButton").addEventListener("click", () => {
  try { applyTextStyleRange($("textValueInput").selectionStart, $("textValueInput").selectionEnd); }
  catch (error) { showError("Could not apply text range", error); }
});
$("applyTextAllButton").addEventListener("click", () => {
  try { applyTextStyleRange(0, $("textValueInput").value.replace(/\r\n?/g, "\n").length); }
  catch (error) { showError("Could not apply text style", error); }
});
$("resetTextRunsButton").addEventListener("click", () => {
  try {
    const value = $("textValueInput").value.replace(/\r\n?/g, "\n");
    textDialogRuns = [baseTextRun(value)]; textDialogStyleDirty = false; renderTextRunList();
  } catch (error) { showError("Could not reset text ranges", error); }
});
$("applyParagraphRangeButton").addEventListener("click", () => {
  try { applyParagraphRange($("textValueInput").selectionStart, $("textValueInput").selectionEnd); }
  catch (error) { showError("Could not apply paragraph range", error); }
});
$("applyParagraphAllButton").addEventListener("click", () => {
  try {
    const value = $("textValueInput").value.replace(/\r\n?/g, "\n");
    textDialogParagraphRuns = [paragraphFromControls(0, value.length)];
    textDialogParagraphDirty = false; renderParagraphRunList();
  } catch (error) { showError("Could not apply paragraph style", error); }
});
$("commitLayerTransformButton").addEventListener("click", () => {
  const draft = transformDialogDraft;
  if (!draft?.primary || !Array.isArray(draft.quad) ||
      draft.quad.some((value) => !Number.isFinite(value))) return;
  const quad = [...draft.quad]; transformDialogDraft = null;
  $("layerTransformDialog").close();
  commitLayerQuad(draft, quad, draft.leaves.length > 1
    ? "Transforming layers" : "Transforming layer");
});
$("applyTransformButton").addEventListener("click", () => $("commitLayerTransformButton").click());
$("cancelTransformButton").addEventListener("click", () => {
  transformDialogDraft = null; transformDraft = null; clearTransformPreview(true);
  if ($("layerTransformDialog").open) $("layerTransformDialog").close("cancel");
});
$("commitLayerWarpButton").addEventListener("click", commitLayerWarp);
for (const id of ["layerWarpStyleInput", "layerWarpBendInput", "layerWarpHorizontalInput",
  "layerWarpVerticalInput", "layerWarpRotateInput"]) $(id).addEventListener("input", scheduleWarpPreview);
$("layerWarpDialog").addEventListener("close", () => {
  if (warpDialogDraft) { warpDialogDraft = null; clearTransformPreview(); }
});
$("commitLiquifyButton").addEventListener("click", commitLiquify);
$("restoreLiquifyButton").addEventListener("click", () => {
  if (!liquifyDraft) return;
  liquifyDraft.strokes = []; liquifyDraft.active = null; clearLiquifyPreview();
  drawLiquifySource();
  $("commitLiquifyButton").disabled = true; $("restoreLiquifyButton").disabled = true;
  $("liquifyStatus").textContent = "All Liquify strokes restored.";
});
$("liquifyShowMaskInput").addEventListener("change", renderLiquifyMask);
$("liquifyDialog").addEventListener("close", () => {
  clearLiquifyPreview(); liquifyDraft = null;
});
$("liquifyCanvas").addEventListener("pointerdown", (event) => {
  if (!liquifyDraft || event.button !== 0) return;
  if (liquifyDraft.strokes.length >= 4096) {
    $("liquifyStatus").textContent = "Liquify stroke limit reached.";
    return;
  }
  const controls = liquifyControls();
  if (!controls) {
    $("liquifyStatus").textContent = "Use bounded brush controls.";
    return;
  }
  event.preventDefault();
  $("liquifyCanvas").setPointerCapture(event.pointerId);
  const point = liquifyPoint(event);
  liquifyDraft.hover = point;
  liquifyDraft.active = { pointerId: event.pointerId, last: point };
  liquifyDraft.strokes.push({ ...controls, from: [point.x, point.y], to: [point.x, point.y] });
  scheduleLiquifyPreview(); renderLiquifyMask();
});
$("liquifyCanvas").addEventListener("pointermove", (event) => {
  if (!liquifyDraft) return;
  const point = liquifyPoint(event); liquifyDraft.hover = point; renderLiquifyMask();
  const active = liquifyDraft.active;
  if (!active || active.pointerId !== event.pointerId || liquifyDraft.strokes.length >= 4096) return;
  const controls = liquifyControls(); if (!controls) return;
  if (Math.hypot(point.x - active.last.x, point.y - active.last.y) < .35) return;
  liquifyDraft.strokes.push({ ...controls,
    from: [active.last.x, active.last.y], to: [point.x, point.y] });
  active.last = point; scheduleLiquifyPreview(); renderLiquifyMask();
});
$("liquifyCanvas").addEventListener("pointerleave", () => {
  if (liquifyDraft && !liquifyDraft.active) {
    liquifyDraft.hover = null; renderLiquifyMask();
  }
});
for (const type of ["pointerup", "pointercancel"]) {
  $("liquifyCanvas").addEventListener(type, (event) => {
    if (liquifyDraft?.active?.pointerId !== event.pointerId) return;
    liquifyDraft.active = null; scheduleLiquifyPreview({ immediate: true });
  });
}
for (const id of ["layerXInput", "layerYInput", "layerWidthInput", "layerHeightInput",
  "layerAngleInput", "layerFlipXInput", "layerFlipYInput", "layerTransformModeInput",
  ...layerCornerInputIds]) $(id).addEventListener("input", updateTransformDialogPreview);
$("layerTransformDialog").addEventListener("close", () => {
  if (transformDialogDraft) { transformDialogDraft = null; clearTransformPreview(true); }
});
for (const handle of $("transformOverlay").querySelectorAll("circle[data-transform-handle]")) {
  handle.addEventListener("pointerdown", (event) => {
    if (!transformDialogDraft || busy || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    transformDraft = { pointerId: event.pointerId,
      handle: handle.dataset.transformHandle, hasText: transformDialogDraft.hasText,
      quad: [...transformDialogDraft.quad] };
  });
  handle.addEventListener("pointermove", (event) => {
    if (transformDraft?.pointerId !== event.pointerId || !transformDialogDraft) return;
    const point = canvasPointUnclamped(event); const name = transformDraft.handle;
    const cornerIndex = name.startsWith("corner-") ? Number(name.slice(7)) : null;
    if (transformDraft.hasText) {
      const xs = transformDraft.quad.filter((_, index) => index % 2 === 0);
      const ys = transformDraft.quad.filter((_, index) => index % 2 === 1);
      let left = Math.min(...xs); let right = Math.max(...xs); let top = Math.min(...ys); let bottom = Math.max(...ys);
      if (cornerIndex != null) {
        const opposite = (cornerIndex + 2) % 4;
        const oppositeX = transformDraft.quad[opposite * 2]; const oppositeY = transformDraft.quad[opposite * 2 + 1];
        left = Math.min(point.x, oppositeX); right = Math.max(point.x, oppositeX);
        top = Math.min(point.y, oppositeY); bottom = Math.max(point.y, oppositeY);
      } else if (name === "edge-left") left = Math.min(point.x, right - .01);
      else if (name === "edge-right") right = Math.max(point.x, left + .01);
      else if (name === "edge-top") top = Math.min(point.y, bottom - .01);
      else if (name === "edge-bottom") bottom = Math.max(point.y, top + .01);
      $("layerXInput").value = String(left); $("layerYInput").value = String(top);
      $("layerWidthInput").value = String(Math.max(.01, right - left));
      $("layerHeightInput").value = String(Math.max(.01, bottom - top));
      $("layerAngleInput").value = "0"; $("layerFlipXInput").checked = false;
      $("layerFlipYInput").checked = false; updateTransformDialogPreview();
      return;
    }
    const quad = [...transformDraft.quad];
    if (cornerIndex != null) { quad[cornerIndex * 2] = point.x; quad[cornerIndex * 2 + 1] = point.y; }
    else if (name === "edge-top") { quad[1] = point.y; quad[3] = point.y; }
    else if (name === "edge-right") { quad[2] = point.x; quad[4] = point.x; }
    else if (name === "edge-bottom") { quad[5] = point.y; quad[7] = point.y; }
    else if (name === "edge-left") { quad[0] = point.x; quad[6] = point.x; }
    $("layerTransformModeInput").value = "perspective";
    layerCornerInputIds.forEach((id, coordinate) => { $(id).readOnly = false; $(id).value = quad[coordinate].toFixed(2); });
    transformDialogDraft.quad = quad; renderTransformOverlay(quad);
    scheduleTransformPreview(transformDialogDraft, quad);
  });
  const finishHandle = (event) => {
    if (transformDraft?.pointerId === event.pointerId) transformDraft = null;
  };
  handle.addEventListener("pointerup", finishHandle);
  handle.addEventListener("pointercancel", finishHandle);
  handle.addEventListener("keydown", (event) => {
    if (!transformDialogDraft || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const amount = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0;
    const dy = event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0;
    const name = handle.dataset.transformHandle; const quad = [...transformDialogDraft.quad];
    const cornerIndex = name.startsWith("corner-") ? Number(name.slice(7)) : null;
    if (cornerIndex != null) { quad[cornerIndex * 2] += dx; quad[cornerIndex * 2 + 1] += dy; }
    else if (name === "edge-top") { quad[1] += dy; quad[3] += dy; }
    else if (name === "edge-right") { quad[2] += dx; quad[4] += dx; }
    else if (name === "edge-bottom") { quad[5] += dy; quad[7] += dy; }
    else if (name === "edge-left") { quad[0] += dx; quad[6] += dx; }
    if (transformDialogDraft.hasText) {
      const xs = quad.filter((_, index) => index % 2 === 0); const ys = quad.filter((_, index) => index % 2 === 1);
      $("layerXInput").value = String(Math.min(...xs)); $("layerYInput").value = String(Math.min(...ys));
      $("layerWidthInput").value = String(Math.max(.01, Math.max(...xs) - Math.min(...xs)));
      $("layerHeightInput").value = String(Math.max(.01, Math.max(...ys) - Math.min(...ys)));
      updateTransformDialogPreview(); return;
    }
    $("layerTransformModeInput").value = "perspective";
    layerCornerInputIds.forEach((id, coordinate) => { $(id).readOnly = false; $(id).value = quad[coordinate].toFixed(2); });
    transformDialogDraft.quad = quad; renderTransformOverlay(quad); scheduleTransformPreview(transformDialogDraft, quad);
  });
}
$("brushSizeInput").addEventListener("input", () => {
  $("brushSizeOutput").textContent = `${$("brushSizeInput").value} px`;
  if (["brush", "eraser"].includes(canvasTool)) $("brushPresetSelect").value = "custom";
  persistPreferences();
});
for (const [input, output] of [
  ["brushSoftnessInput", "brushSoftnessOutput"],
  ["brushOpacityInput", "brushOpacityOutput"],
]) {
  $(input).addEventListener("input", (event) => {
    $(output).textContent = `${event.currentTarget.value}%`;
    $("brushPresetSelect").value = "custom";
  });
}
const brushPresets = Object.freeze({
  "hard-round": { size: 24, softness: 0, opacity: 100 },
  "soft-round": { size: 80, softness: 100, opacity: 100 },
  pencil: { size: 4, softness: 0, opacity: 100 },
  marker: { size: 36, softness: 30, opacity: 45 },
});
$("brushPresetSelect").addEventListener("change", (event) => {
  const preset = brushPresets[event.currentTarget.value];
  if (!preset) return;
  $("brushSizeInput").value = String(preset.size); $("brushSizeOutput").textContent = `${preset.size} px`;
  $("brushSoftnessInput").value = String(preset.softness);
  $("brushSoftnessOutput").textContent = `${preset.softness}%`;
  $("brushOpacityInput").value = String(preset.opacity);
  $("brushOpacityOutput").textContent = `${preset.opacity}%`;
  persistPreferences();
});
$("retouchSoftnessInput").addEventListener("input", (event) => {
  $("retouchSoftnessOutput").textContent = `${event.currentTarget.value}%`;
});
$("localBrushSoftnessInput").addEventListener("input", (event) => {
  $("localBrushSoftnessOutput").textContent = `${event.currentTarget.value}%`;
});
$("localBrushStrengthInput").addEventListener("input", (event) => {
  $("localBrushStrengthOutput").textContent = `${event.currentTarget.value}%`;
});
for (const [input, output, suffix] of [
  ["advancedPaintSoftnessInput", "advancedPaintSoftnessOutput", "%"],
  ["advancedPaintFlowInput", "advancedPaintFlowOutput", "%"],
  ["mixerWetInput", "mixerWetOutput", "%"],
  ["mixerLoadInput", "mixerLoadOutput", "%"],
  ["mixerMixInput", "mixerMixOutput", "%"],
  ["advancedPatternSizeInput", "advancedPatternSizeOutput", " px"],
]) {
  $(input).addEventListener("input", (event) => { $(output).textContent = `${event.currentTarget.value}${suffix}`; });
}
$("brushColorInput").addEventListener("input", () => {
  $("foregroundSwatchInput").value = $("brushColorInput").value; persistPreferences();
});
$("foregroundSwatchInput").addEventListener("input", () => {
  $("brushColorInput").value = $("foregroundSwatchInput").value; persistPreferences();
});
$("swapSwatchesButton").addEventListener("click", () => {
  const foreground = $("foregroundSwatchInput").value;
  $("foregroundSwatchInput").value = $("backgroundSwatchInput").value;
  $("backgroundSwatchInput").value = foreground;
  $("brushColorInput").value = $("foregroundSwatchInput").value; persistPreferences();
});
$("defaultSwatchesButton").addEventListener("click", () => {
  $("foregroundSwatchInput").value = "#111111"; $("backgroundSwatchInput").value = "#ffffff";
  $("brushColorInput").value = "#111111"; persistPreferences();
});
$("paintTargetSelect").addEventListener("change", updateControls);
$("paintPresetSelect").addEventListener("change", persistPreferences);
$("textFontInput").addEventListener("change", persistPreferences);
$("memoryBudgetSelect").addEventListener("change", async () => {
  if (busy) return;
  clearError(); setBusy(true, "Applying memory budget", "Trimming retained history if necessary");
  try { await applyMemoryBudget(false); persistPreferences(); }
  catch (error) { showError("Could not apply memory budget", error); }
  finally { setBusy(false); }
});
$("createMaskButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer) mutate("Creating layer mask", () => client.createLayerMask(layer.id));
});
$("toggleMaskButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer?.mask) mutate(layer.mask.disabled ? "Enabling layer mask" : "Disabling layer mask", () => client.toggleLayerMask(layer.id));
});
$("linkMaskButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer?.mask) mutate(layer.mask.linked === false ? "Linking layer mask" : "Unlinking layer mask",
    () => client.setLayerMaskLinked(layer.id, layer.mask.linked === false));
});
$("invertMaskButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer?.mask) mutate("Inverting layer mask", () => client.invertLayerMask(layer.id));
});
$("removeMaskButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer?.mask) mutate("Removing layer mask", () => client.removeLayerMask(layer.id));
});
$("createVectorMaskButton").addEventListener("click", () => {
  const layer = selectedLayer(); const saved = selectedPath();
  if (saved?.subpaths?.length) { createVectorMaskFromSelectedPath(); return; }
  const path = selectionPath();
  if (layer && path) mutate("Creating vector mask", () => client.setVectorMask(layer.id,
    { path, feather: 0, density: 255 }));
});
$("cancelOperationButton").addEventListener("click", () => {
  cancelActiveOperation?.();
  $("cancelOperationButton").disabled = true;
  $("busyDetail").textContent = "Cancelling at the next safe filter checkpoint…";
});
$("resizeImageButton").addEventListener("click", () => {
  const width = integerInput("documentWidthInput", true);
  const height = integerInput("documentHeightInput", true);
  if (width != null && height != null) {
    geometryMutation("Scaling image", { width, height }, () => client.resizeImage(width, height));
  }
});
$("resizeCanvasButton").addEventListener("click", () => {
  const width = integerInput("canvasWidthInput", true);
  const height = integerInput("canvasHeightInput", true);
  const anchor = Number($("canvasAnchorInput").value);
  if (width != null && height != null && Number.isInteger(anchor)) {
    geometryMutation("Resizing canvas", { width, height }, () => client.resizeCanvas(width, height,
      { anchor, color: geometryFillColor() }));
  }
});
$("rotateLeftButton").addEventListener("click", () => geometryMutation("Rotating canvas",
  rotatedGeometrySize(snapshot.width, snapshot.height, -90), () =>
    client.rotateCanvas(-90, geometryFillColor())));
$("rotateRightButton").addEventListener("click", () => geometryMutation("Rotating canvas",
  rotatedGeometrySize(snapshot.width, snapshot.height, 90), () =>
    client.rotateCanvas(90, geometryFillColor())));
$("rotateArbitraryButton").addEventListener("click", () => {
  const degrees = finiteInput("rotateDegreesInput");
  if (degrees != null && Math.abs(degrees % 360) >= .01) {
    geometryMutation("Rotating canvas",
      () => rotatedGeometrySize(snapshot.width, snapshot.height, degrees),
      () => client.rotateCanvas(degrees, geometryFillColor()));
  }
});

const cropHandleGroup = $("cropHandles");
const cropHandleLabels = ["Top-left crop handle", "Top crop handle", "Top-right crop handle",
  "Right crop handle", "Bottom-right crop handle", "Bottom crop handle",
  "Bottom-left crop handle", "Left crop handle"];
for (let index = 0; index < 8; ++index) {
  const handle = document.createElementNS(cropHandleGroup.namespaceURI, "circle");
  handle.dataset.cropHandle = String(index); handle.setAttribute("role", "button");
  localizer.setAttribute(handle, "aria-label", cropHandleLabels[index]);
  handle.setAttribute("tabindex", "0");
  cropHandleGroup.append(handle);
  let drag = null;
  handle.addEventListener("pointerdown", (event) => {
    if (!cropDraft || busy || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); handle.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, bounds: { ...cropDraft } };
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = canvasPointUnclamped(event); const start = drag.bounds;
    if ([0, 2, 4, 6].includes(index) && cropRatio()) {
      const opposite = { 0: { x: start.x + start.width, y: start.y + start.height },
        2: { x: start.x, y: start.y + start.height },
        4: { x: start.x, y: start.y }, 6: { x: start.x + start.width, y: start.y } }[index];
      cropDraft = constrainedCrop(opposite, point); renderCropOverlay(); return;
    }
    let left = start.x; let top = start.y; let right = start.x + start.width; let bottom = start.y + start.height;
    if ([0, 6, 7].includes(index)) left = Math.max(0, Math.min(point.x, right - 1));
    if ([2, 3, 4].includes(index)) right = Math.min(snapshot.width, Math.max(point.x, left + 1));
    if ([0, 1, 2].includes(index)) top = Math.max(0, Math.min(point.y, bottom - 1));
    if ([4, 5, 6].includes(index)) bottom = Math.min(snapshot.height, Math.max(point.y, top + 1));
    cropDraft = { x: Math.round(left), y: Math.round(top), width: Math.max(1, Math.round(right - left)),
      height: Math.max(1, Math.round(bottom - top)) }; renderCropOverlay();
  });
  const finish = (event) => { if (drag?.pointerId === event.pointerId) drag = null; };
  handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (event) => {
    if (!cropDraft || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const amount = event.shiftKey ? 10 : 1; const next = { ...cropDraft };
    const dx = event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0;
    const dy = event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0;
    if ([0, 6, 7].includes(index) && dx) { const right = next.x + next.width; next.x = Math.max(0, Math.min(right - 1, next.x + dx)); next.width = right - next.x; }
    if ([2, 3, 4].includes(index) && dx) next.width = Math.max(1, Math.min(snapshot.width - next.x, next.width + dx));
    if ([0, 1, 2].includes(index) && dy) { const bottom = next.y + next.height; next.y = Math.max(0, Math.min(bottom - 1, next.y + dy)); next.height = bottom - next.y; }
    if ([4, 5, 6].includes(index) && dy) next.height = Math.max(1, Math.min(snapshot.height - next.y, next.height + dy));
    cropDraft = next; renderCropOverlay();
  });
}

function cancelCropDraft() { cropDraft = null; renderCropOverlay(); }
function commitCropDraft() {
  if (!cropDraft || busy) return;
  const crop = { ...cropDraft }; cropDraft = null; renderCropOverlay();
  geometryMutation("Cropping document", () => cropGeometrySize(crop,
    { clipToCanvas: true, canvasWidth: snapshot.width, canvasHeight: snapshot.height }),
  () => client.cropDocument(crop, { clockwiseDegrees: 0, color: geometryFillColor(), clipToCanvas: true }));
}
$("cancelCropButton").addEventListener("click", cancelCropDraft);
$("applyCropButton").addEventListener("click", commitCropDraft);
$("finishPenPathButton").addEventListener("click", () => commitPenPath(false));
$("closePenPathButton").addEventListener("click", () => commitPenPath(true));
$("cancelPenPathButton").addEventListener("click", () => {
  penDraft = null; penHoverPoint = null; previewPolygon([]); renderPenPath(); updateControls();
});
$("cropRatioInput").addEventListener("change", () => {
  if (!cropDraft || !cropRatio()) return;
  cropDraft = constrainedCrop({ x: cropDraft.x, y: cropDraft.y },
    { x: cropDraft.x + cropDraft.width, y: cropDraft.y + cropDraft.height });
  renderCropOverlay();
});

$("cropButton").addEventListener("click", () => {
  const x = integerInput("cropXInput");
  const y = integerInput("cropYInput");
  const width = integerInput("cropWidthInput", true);
  const height = integerInput("cropHeightInput", true);
  const clockwiseDegrees = finiteInput("cropAngleInput");
  if ([x, y, width, height, clockwiseDegrees].every((value) => value != null)) {
    const crop = { x, y, width, height };
    const clipToCanvas = !$("cropExpandInput").checked;
    geometryMutation("Cropping document", () => cropGeometrySize(crop,
      { clipToCanvas, canvasWidth: snapshot.width, canvasHeight: snapshot.height }),
      () => client.cropDocument(crop,
        { clockwiseDegrees: clockwiseDegrees % 360, color: geometryFillColor(), clipToCanvas }));
  }
});
$("cropFromSelectionButton").addEventListener("click", () => {
  const bounds = selectionBounds();
  if (!bounds) return;
  $("cropXInput").value = String(bounds.x); $("cropYInput").value = String(bounds.y);
  $("cropWidthInput").value = String(bounds.width); $("cropHeightInput").value = String(bounds.height);
});
$("resizeConstrainInput").addEventListener("change", () => {
  const width = Number($("documentWidthInput").value);
  const height = Number($("documentHeightInput").value);
  if (width > 0 && height > 0) resizeAspectRatio = width / height;
});
$("documentWidthInput").addEventListener("input", () => {
  if (!$("resizeConstrainInput").checked || !(resizeAspectRatio > 0)) return;
  const width = Number($("documentWidthInput").value);
  if (Number.isFinite(width) && width > 0) {
    $("documentHeightInput").value = String(Math.max(1, Math.round(width / resizeAspectRatio)));
  }
});
$("documentHeightInput").addEventListener("input", () => {
  if (!$("resizeConstrainInput").checked || !(resizeAspectRatio > 0)) return;
  const height = Number($("documentHeightInput").value);
  if (Number.isFinite(height) && height > 0) {
    $("documentWidthInput").value = String(Math.max(1, Math.round(height * resizeAspectRatio)));
  }
});
$("layerNameInput").addEventListener("change", () => {
  const layer = selectedLayer();
  const name = $("layerNameInput").value.trim();
  if (layer && name && name !== layer.name) mutate("Renaming layer", () => client.renameLayer(layer.id, name));
  else renderLayerProperties();
});

function queueLayerAppearance(title, mask, value, delay = 180) {
  const ids = selectedLayerIdsTopToBottom();
  if (!ids.length || !Number.isFinite(value) || value < 0 || value > 1) return;
  clearTimeout(layerAppearanceTimer);
  pendingLayerAppearance = { title, mask, value, ids };
  layerAppearanceTimer = setTimeout(flushLayerAppearance, delay);
}

async function flushLayerAppearance() {
  clearTimeout(layerAppearanceTimer); layerAppearanceTimer = 0;
  if (!pendingLayerAppearance) return;
  if (busy) { layerAppearanceTimer = setTimeout(flushLayerAppearance, 80); return; }
  const pending = pendingLayerAppearance; pendingLayerAppearance = null;
  await mutate(pending.title, () => client.editLayers(pending.ids, pending.mask,
    { opacity: pending.value }));
}

$("layerOpacityInput").addEventListener("input", () => {
  $("layerOpacityOutput").textContent = `${$("layerOpacityInput").value}%`;
  queueLayerAppearance("Changing opacity", 1, Number($("layerOpacityInput").value) / 100);
});
$("layerOpacityInput").addEventListener("change", () => {
  queueLayerAppearance("Changing opacity", 1, Number($("layerOpacityInput").value) / 100, 0);
});
$("layerFillInput").addEventListener("input", () => {
  $("layerFillOutput").textContent = `${$("layerFillInput").value}%`;
  queueLayerAppearance("Changing fill opacity", 2, Number($("layerFillInput").value) / 100);
});
$("layerFillInput").addEventListener("change", () => {
  queueLayerAppearance("Changing fill opacity", 2, Number($("layerFillInput").value) / 100, 0);
});
$("layerClipInput").addEventListener("change", () => {
  const layer = selectedLayer();
  if (layer) mutate("Changing clipping", () => client.setLayerClipping(layer.id, $("layerClipInput").checked));
});
$("layerLockInput").addEventListener("change", () => {
  const ids = selectedLayerIdsTopToBottom();
  if (ids.length) mutate("Changing layer lock", () => client.editLayers(ids, 4,
    { value: $("layerLockInput").checked ? 7 : 0 }));
});
$("quickLayerOpacityInput").addEventListener("input", () => {
  queueLayerAppearance("Changing opacity", 1, Number($("quickLayerOpacityInput").value) / 100);
});
$("quickLayerOpacityInput").addEventListener("change", () => {
  queueLayerAppearance("Changing opacity", 1, Number($("quickLayerOpacityInput").value) / 100, 0);
});
$("quickLayerFillInput").addEventListener("input", () => {
  queueLayerAppearance("Changing fill opacity", 2, Number($("quickLayerFillInput").value) / 100);
});
$("quickLayerFillInput").addEventListener("change", () => {
  queueLayerAppearance("Changing fill opacity", 2, Number($("quickLayerFillInput").value) / 100, 0);
});
$("quickLayerBlendSelect").addEventListener("change", () => {
  const ids = selectedLayerIdsTopToBottom();
  if (ids.length) mutate("Changing blend mode", () => client.editLayers(ids, 0,
    { blendMode: Number($("quickLayerBlendSelect").value) }));
});
$("quickLayerLockInput").addEventListener("change", () => {
  const ids = selectedLayerIdsTopToBottom();
  if (ids.length) mutate("Changing layer lock", () => client.editLayers(ids, 4,
    { value: $("quickLayerLockInput").checked ? 7 : 0 }));
});
$("applyLayerStyleButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer) mutate("Applying layer style", () =>
    client.setLayerStylePreset(layer.id, $("layerStyleSelect").value));
});
$("editLayerStyleButton").addEventListener("click", openLayerStyleDialog);
$("commitLayerStyleButton").addEventListener("click", () => {
  const layer = selectedLayer();
  const input = essentialLayerStyleInput();
  if (!layer || !input) return;
  $("layerStyleDialog").close();
  mutate("Editing layer effects", () => client.setEssentialLayerStyle(layer.id, input));
});
$("invertSelectionButton").addEventListener("click", () => mutate("Inverting selection", () => client.invertSelection()));
$("expandSelectionButton").addEventListener("click", () => mutate("Expanding selection", () => client.expandSelection(4)));
$("contractSelectionButton").addEventListener("click", () => mutate("Contracting selection", () => client.contractSelection(4)));
$("borderSelectionButton").addEventListener("click", () => mutate("Bordering selection", () => client.borderSelection(4)));
$("growSelectionButton").addEventListener("click", () => mutate("Growing selection by color", () =>
  client.growSelection(Number($("selectionToleranceInput").value))));
$("similarSelectionButton").addEventListener("click", () => mutate("Selecting similar colors", () =>
  client.selectSimilar(Number($("selectionToleranceInput").value))));
$("smoothSelectionButton").addEventListener("click", openSelectionRefinementDialog);
for (const id of ["selectionSmoothInput", "selectionFeatherInput",
  "selectionContrastInput", "selectionShiftInput"]) {
  $(id).addEventListener("input", previewSelectionRefinement);
}
$("selectionOutputInput").addEventListener("change", () => {
  $("selectionLayerField").hidden = $("selectionOutputInput").value !== "layerMask";
  previewSelectionRefinement();
});
$("selectionLayerInput").addEventListener("change", previewSelectionRefinement);
$("selectionRefinementDialog").addEventListener("close", () => {
  selectionRefinementDraft = null;
  clearSelectionRefinementPreview();
  renderSelection();
});
$("commitSelectionRefinementButton").addEventListener("click", () => {
  const input = selectionRefinementInput({ report: true });
  if (!input) return;
  $("selectionRefinementDialog").close();
  mutate(input.output === "layerMask" ? "Refining selection to layer mask" : "Refining selection",
    () => client.refineSelection(input));
});
$("selectionToleranceInput").addEventListener("input", () => {
  $("selectionToleranceOutput").textContent = $("selectionToleranceInput").value;
  persistPreferences();
});
$("edgeContrastInput").addEventListener("input", () => {
  $("edgeContrastOutput").textContent = `${$("edgeContrastInput").value}%`;
});
$("saveChannelButton").addEventListener("click", () => mutate("Saving alpha channel", () => client.addAlphaChannel(`Alpha ${snapshot.channels.length + 1}`)));
$("savePathButton").addEventListener("click", () => {
  const path = selectionPath();
  if (path) mutate("Saving document path", () => client.addDocumentPath({
    name: `Path ${snapshot.paths.length + 1}`, kind: 0, path }));
});
$("rasterizeLayerButton").addEventListener("click", () => {
  const layer = selectedLayer(); if (layer) mutate("Rasterizing layer", () => client.rasterizeLayer(layer.id));
});
$("mergeVisibleButton").addEventListener("click", () =>
  mutate("Merging visible copy", () => client.mergeVisibleCopy("Merged Visible (Copy)")));
$("channelRenameButton").addEventListener("click", () => {
  const channel = selectedChannel();
  const name = channel && prompt(localizer.text("Channel name"), channel.name);
  if (name?.trim()) mutate("Renaming channel", () => client.renameChannel(channel.id, name.trim()));
});
$("channelInvertButton").addEventListener("click", () => {
  const channel = selectedChannel(); if (channel) mutate("Inverting channel", () => client.invertChannel(channel.id));
});
$("channelDeleteButton").addEventListener("click", () => {
  const channel = selectedChannel(); if (channel) mutate("Deleting channel", () => client.removeChannel(channel.id));
});
for (const [id, delta] of [["channelUpButton", -1], ["channelDownButton", 1]]) {
  $(id).addEventListener("click", () => {
    const channel = selectedChannel(); const index = snapshot.channels.findIndex((item) => item.id === channel?.id);
    const destination = Math.max(0, Math.min(snapshot.channels.length - 1, index + delta));
    if (channel && destination !== index) mutate("Reordering channel", () => client.moveChannel(channel.id, destination));
  });
}
$("pathRenameButton").addEventListener("click", () => {
  const path = selectedPath();
  const name = path && prompt(localizer.text("Path name"), path.name);
  if (name?.trim()) mutate("Renaming path", () => client.renamePath(path.id, name.trim()));
});
$("pathClipButton").addEventListener("click", () => {
  const path = selectedPath(); if (path) mutate("Changing clipping path", () => client.setClippingPath(path.id, !path.clipping));
});
$("pathDeleteButton").addEventListener("click", () => {
  const path = selectedPath(); if (path) mutate("Deleting path", () => client.removePath(path.id));
});
$("pathSelectionButton").addEventListener("click", () => makeSelectedPathSelection());
$("makePenSelectionButton").addEventListener("click", () => makeSelectedPathSelection());
$("pathFillButton").addEventListener("click", fillSelectedPath);
$("pathStrokeButton").addEventListener("click", strokeSelectedPath);
$("pathVectorMaskButton").addEventListener("click", createVectorMaskFromSelectedPath);
for (const [id, delta] of [["pathUpButton", -1], ["pathDownButton", 1]]) {
  $(id).addEventListener("click", () => {
    const path = selectedPath(); const index = snapshot.paths.findIndex((item) => item.id === path?.id);
    const destination = Math.max(0, Math.min(snapshot.paths.length - 1, index + delta));
    if (path && destination !== index) mutate("Reordering path", () => client.movePath(path.id, destination));
  });
}
$("pathAnchorApplyButton").addEventListener("click", () => {
  const path = selectedPath(); const x = Number($("pathAnchorXInput").value);
  const y = Number($("pathAnchorYInput").value);
  if (!path?.subpaths?.[0]?.anchors?.length || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const subpaths = path.subpaths.map((subpath) => ({ ...subpath,
    anchors: subpath.anchors.map((anchor) => ({ ...anchor })) }));
  const anchor = subpaths[0].anchors[0]; const dx = x - anchor.x; const dy = y - anchor.y;
  Object.assign(anchor, { x, y, inX: anchor.inX + dx, inY: anchor.inY + dy,
    outX: anchor.outX + dx, outY: anchor.outY + dy });
  mutate("Editing path anchor", () => client.updateDocumentPath(path.id, {
    name: path.name, kind: path.kind, clipping: path.clipping, path: { subpaths } }));
});
$("layerBlendSelect").addEventListener("change", () => {
  const ids = selectedLayerIdsTopToBottom();
  if (ids.length) mutate("Changing blend mode", () => client.editLayers(ids, 3,
    { value: Number($("layerBlendSelect").value) }));
});
$("cleanupRecoveryButton").addEventListener("click", cleanupRecoveryWorkspaces);
$("diagnosticsConsentInput").addEventListener("change", () => {
  $("downloadDiagnosticsButton").disabled = !$("diagnosticsConsentInput").checked;
});
$("downloadDiagnosticsButton").addEventListener("click", downloadDiagnostics);
$("saveGradientAssetButton").addEventListener("click", () => saveFillAsset("gradient")
  .catch((error) => showError("Could not save gradient", error)));
$("savePatternAssetButton").addEventListener("click", () => saveFillAsset("pattern")
  .catch((error) => showError("Could not save pattern", error)));
$("installFontAssetButton").addEventListener("click", () => installFontAsset()
  .catch((error) => showError("Could not install font", error)));
$("toggleGuidesButton").addEventListener("click", () => {
  guidesVisible = !guidesVisible; renderGuides(); persistPreferences();
});
$("toggleSnapButton").addEventListener("click", () => {
  snappingEnabled = !snappingEnabled; renderGuides(); persistPreferences();
});
$("clearGuidesButton").addEventListener("click", () => setActiveGuides([]));

canvas.addEventListener("pointerdown", (event) => {
  if (busy || !snapshot || event.button !== 0) return;
  if (spacePanActive) return;
  if (["brush", "eraser", "clone", "heal"].includes(canvasTool)) { beginPaint(event); return; }
  if (["spotHealing", "patch"].includes(canvasTool)) { beginRetouch(event); return; }
  if (["smudge", "dodge", "burn", "sponge", "blur", "sharpen"].includes(canvasTool)) {
    beginLocalBrush(event); return;
  }
  if (canvasTool === "mixer" || canvasTool === "patternStamp") {
    beginAdvancedPaint(event); return;
  }
  if (canvasTool === "gradient") { beginGradient(event); return; }
  if (canvasTool === "text") { openTextDialog(); return; }
  if (canvasTool === "pen") {
    const point = canvasPoint(event);
    penDraft ??= { points: [], closed: false };
    if (penCloseTarget(point)) {
      commitPenPath(true);
    } else if (event.detail > 1 && penDraft.points.length >= 3) {
      commitPenPath(event.shiftKey);
    } else {
      penDraft.points.push(point); penHoverPoint = point; renderPenPath(); updateControls();
    }
    return;
  }
  if (canvasTool === "quickSelect") {
    canvas.setPointerCapture(event.pointerId);
    quickSelectDraft = { pointerId: event.pointerId, points: [canvasPoint(event)], subtract: event.altKey };
    previewPolygon(quickSelectDraft.points);
    return;
  }
  if (canvasTool === "magnetic") {
    const point = canvasPoint(event);
    magneticDraft ??= { anchors: [], mode: selectionMode(event) };
    const last = magneticDraft.anchors.at(-1);
    if (magneticDraft.anchors.length < 256 &&
        (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1)) magneticDraft.anchors.push(point);
    previewPolygon(magneticDraft.anchors);
    return;
  }
  if (canvasTool === "quickMask") {
    canvas.setPointerCapture(event.pointerId);
    const gray = fullSelectionMask(); const point = canvasPoint(event);
    quickMaskDraft = { pointerId: event.pointerId, gray, value: event.altKey ? 0 : 255,
      radius: Math.max(1, Math.round(Number($("brushSizeInput").value) / 2)), last: point };
    paintMaskPoint(gray, point, quickMaskDraft.radius, quickMaskDraft.value); renderQuickMask(gray);
    return;
  }
  if (canvasTool === "magic") {
    commitSelectionMask("Selecting connected color", combinedSelectionMask(
      magicMask(canvasPoint(event)), selectionMode(event)));
    return;
  }
  if (canvasTool === "polygon") {
    const point = canvasPoint(event);
    polygonDraft ??= { points: [], mode: selectionMode(event) };
    polygonDraft.points.push(point); previewPolygon(polygonDraft.points);
    return;
  }
  if (canvasTool === "lasso") {
    canvas.setPointerCapture(event.pointerId);
    lassoDraft = { pointerId: event.pointerId, points: [canvasPoint(event)], mode: selectionMode(event) };
    previewPolygon(lassoDraft.points);
    return;
  }
  if (canvasTool === "move") {
    const target = transformSelection();
    if (!target) return;
    const start = canvasPoint(event);
    canvas.setPointerCapture(event.pointerId);
    moveDraft = { target, start, quad: quadFromBounds(target.bounds),
      originalQuad: quadFromBounds(target.bounds) };
    renderTransformOverlay();
    return;
  }
  if (canvasTool === "crop") {
    const start = canvasPoint(event);
    canvas.setPointerCapture(event.pointerId);
    cropDraft = { x: Math.floor(start.x), y: Math.floor(start.y), width: 1, height: 1 };
    renderCropOverlay();
    const move = (nextEvent) => {
      const point = canvasPoint(nextEvent);
      cropDraft = constrainedCrop(start, point);
      renderCropOverlay();
    };
    const finish = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", finish);
      canvas.removeEventListener("pointercancel", cancel);
      renderCropOverlay();
    };
    const cancel = () => { cropDraft = null; renderCropOverlay(); finish(); };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", cancel);
    return;
  }
  if (canvasTool !== "marquee") return;
  const start = canvasPoint(event);
  canvas.setPointerCapture(event.pointerId);
  marqueeDraft = { x: Math.floor(start.x), y: Math.floor(start.y), width: 1, height: 1 };
  const move = (nextEvent) => {
    const point = canvasPoint(nextEvent);
    const x = Math.floor(Math.min(start.x, point.x));
    const y = Math.floor(Math.min(start.y, point.y));
    marqueeDraft = { x, y, width: Math.max(1, Math.ceil(Math.max(start.x, point.x)) - x),
      height: Math.max(1, Math.ceil(Math.max(start.y, point.y)) - y) };
    renderSelection();
  };
  const finish = () => {
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", finish);
    canvas.removeEventListener("pointercancel", cancel);
    const selection = marqueeDraft;
    marqueeDraft = null;
    if (selection) commitSelectionMask("Selecting area", combinedSelectionMask(
      rectangleMask(selection), selectionMode(event)));
  };
  const cancel = () => { marqueeDraft = null; renderSelection(); finish(); };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", cancel);
});

canvas.addEventListener("pointermove", (event) => {
  if (canvasTool === "pen" && penDraft?.points.length && event.buttons === 0) {
    penHoverPoint = canvasPoint(event); renderPenPath();
  }
  movePaint(event);
  moveRetouch(event);
  moveLocalBrush(event);
  moveAdvancedPaint(event);
  if (lassoDraft?.pointerId === event.pointerId) {
    const point = canvasPoint(event); const last = lassoDraft.points.at(-1);
    if (Math.hypot(point.x - last.x, point.y - last.y) >= 1) lassoDraft.points.push(point);
    previewPolygon(lassoDraft.points);
  }
  if (quickSelectDraft?.pointerId === event.pointerId) {
    const point = canvasPoint(event); const last = quickSelectDraft.points.at(-1);
    if (Math.hypot(point.x - last.x, point.y - last.y) >= 1 && quickSelectDraft.points.length < 65536) {
      quickSelectDraft.points.push(point); previewPolygon(quickSelectDraft.points);
    }
  }
  if (quickMaskDraft?.pointerId === event.pointerId) {
    const point = canvasPoint(event); const distance = Math.hypot(point.x - quickMaskDraft.last.x, point.y - quickMaskDraft.last.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, quickMaskDraft.radius / 2)));
    for (let step = 1; step <= steps; ++step) paintMaskPoint(quickMaskDraft.gray, {
      x: quickMaskDraft.last.x + (point.x - quickMaskDraft.last.x) * step / steps,
      y: quickMaskDraft.last.y + (point.y - quickMaskDraft.last.y) * step / steps,
    }, quickMaskDraft.radius, quickMaskDraft.value);
    quickMaskDraft.last = point; renderQuickMask(quickMaskDraft.gray);
  }
  if (gradientDraft?.pointerId === event.pointerId) {
    gradientDraft.end = canvasPoint(event); scheduleRasterFillPreview(gradientDraft);
  }
  if (!moveDraft) return;
  const point = canvasPoint(event);
  const dx = Math.round(point.x - moveDraft.start.x); const dy = Math.round(point.y - moveDraft.start.y);
  moveDraft.quad = snappingEnabled
    ? snapTranslatedQuad(moveDraft.originalQuad, dx, dy, activeGuides(), snapshot,
      { threshold: Math.max(1, 6 / zoom), bypass: event.altKey }).quad
    : moveDraft.originalQuad.map((coordinate, index) => coordinate + (index % 2 ? dy : dx));
  renderTransformOverlay();
  scheduleTransformPreview(moveDraft.target, moveDraft.quad);
});

canvas.addEventListener("pointerleave", () => {
  if (canvasTool !== "pen" || !penHoverPoint) return;
  penHoverPoint = null; renderPenPath();
});
canvas.addEventListener("pointerup", (event) => {
  finishPaint(event);
  finishRetouch(event);
  finishLocalBrush(event);
  finishAdvancedPaint(event);
  finishGradient(event);
  if (lassoDraft?.pointerId === event.pointerId) {
    const draft = lassoDraft; lassoDraft = null; previewPolygon([]);
    if (draft.points.length >= 3) commitSelectionMask("Selecting freehand area",
      combinedSelectionMask(polygonMask(draft.points), draft.mode));
  }
  if (quickSelectDraft?.pointerId === event.pointerId) {
    const draft = quickSelectDraft; quickSelectDraft = null; previewPolygon([]);
    mutate(draft.subtract ? "Subtracting with Quick Select" : "Applying Quick Select", () => client.quickSelect({
      points: draft.points.map((point) => [Math.round(point.x), Math.round(point.y)]),
      brushRadius: Math.max(1, Math.round(Number($("brushSizeInput").value) / 2)),
      spread: 50, subtract: draft.subtract, enhanceEdge: $("enhanceEdgeInput").checked,
      expectedStateId: snapshot.stateId, expectedRevision: snapshot.revision,
    }));
  }
  if (quickMaskDraft?.pointerId === event.pointerId) {
    const draft = quickMaskDraft; quickMaskDraft = null;
    commitSelectionMask("Committing Quick Mask stroke", draft.gray);
  }
  if (!moveDraft) return;
  const draft = moveDraft; moveDraft = null;
  commitLayerQuad(draft.target, draft.quad,
    draft.target.leaves.length > 1 ? "Moving layers" : "Moving layer");
});
canvas.addEventListener("pointercancel", (event) => {
  finishPaint(event, true); gradientDraft = null; clearRasterPreview(); moveDraft = null; lassoDraft = null;
  finishRetouch(event, true);
  finishLocalBrush(event, true);
  finishAdvancedPaint(event, true);
  quickSelectDraft = null; quickMaskDraft = null; previewPolygon([]); clearTransformPreview(true);
  if (canvasTool === "quickMask") renderQuickMask();
});
canvas.addEventListener("dblclick", (event) => {
  if (canvasTool === "magnetic" && magneticDraft) {
    event.preventDefault(); const draft = magneticDraft; magneticDraft = null; previewPolygon([]);
    if (draft.anchors.length >= 3) mutate("Closing Magnetic Lasso", () => client.magneticLasso({
      anchors: draft.anchors.map((point) => [Math.round(point.x), Math.round(point.y)]),
      width: Math.max(1, Math.round(Number($("brushSizeInput").value))),
      edgeContrast: Number($("edgeContrastInput").value), nodeBudget: 600000,
      combine: selectionCombineValue(draft.mode),
      expectedStateId: snapshot.stateId, expectedRevision: snapshot.revision,
    }));
    return;
  }
  if (canvasTool !== "polygon" || !polygonDraft) return;
  event.preventDefault(); const draft = polygonDraft; polygonDraft = null; previewPolygon([]);
  if (draft.points.length >= 3) commitSelectionMask("Selecting polygonal area",
    combinedSelectionMask(polygonMask(draft.points), draft.mode));
});

$("canvasViewport").addEventListener("pointerdown", (event) => {
  if ((canvasTool !== "pan" && !spacePanActive) || event.button !== 0) return;
  const viewport = $("canvasViewport");
  event.preventDefault();
  viewport.setPointerCapture(event.pointerId);
  viewport.dataset.panning = "true";
  panStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
    left: viewport.scrollLeft, top: viewport.scrollTop };
});
$("canvasViewport").addEventListener("pointermove", (event) => {
  if (!panStart || panStart.pointerId !== event.pointerId) return;
  pendingPan = { left: panStart.left - (event.clientX - panStart.x),
    top: panStart.top - (event.clientY - panStart.y) };
  scheduleViewportUpdate("pointer-pan");
});
for (const type of ["pointerup", "pointercancel"]) {
  $("canvasViewport").addEventListener(type, () => {
    panStart = null; delete $("canvasViewport").dataset.panning;
  });
}
$("canvasViewport").addEventListener("wheel", (event) => {
  if (!snapshot || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX, y: event.clientY });
}, { passive: false });
$("canvasViewport").addEventListener("scroll", () => scheduleViewportUpdate("scroll"), { passive: true });
$("horizontalRuler").addEventListener("pointerdown", (event) => createGuideFromRuler("horizontal", event));
$("verticalRuler").addEventListener("pointerdown", (event) => createGuideFromRuler("vertical", event));
for (const [id, orientation] of [["horizontalRuler", "horizontal"], ["verticalRuler", "vertical"]]) {
  $(id).addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key) || !snapshot) return;
    event.preventDefault(); addCenteredGuide(orientation);
  });
}
window.addEventListener("resize", () => scheduleViewportUpdate("resize"));
$("layerList").addEventListener("scroll", scheduleLayerWindowRender, { passive: true });
window.addEventListener("beforeunload", (event) => {
  const modified = (snapshot?.documents || []).some((documentTab) => documentTab.dirty);
  if (modified || [...checkpointStates.values()].some((state) => state === "pending")) event.preventDefault();
});

$("localeSelect").addEventListener("change", () => {
  localizer.setLocale($("localeSelect").value);
  renderLocalizedShell();
  persistPreferences();
});

$("layerList").addEventListener("keydown", (event) => {
  if (!event.target.closest?.(".layer-select-button") ||
      !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const layers = snapshot ? [...snapshot.layers].reverse() : [];
  const currentId = event.target.closest(".layer-row")?.dataset.layerId;
  const current = layers.findIndex((layer) => String(layer.id) === currentId);
  if (current < 0 || !layers.length) return;
  event.preventDefault();
  const index = event.key === "Home" ? 0 : event.key === "End" ? layers.length - 1 :
    Math.max(0, Math.min(layers.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  selectLayerFromEvent(layers[index], event, layers);
  $("layerList").scrollTop = Math.max(0, index * LAYER_ROW_HEIGHT - LAYER_ROW_HEIGHT);
  renderLayers(); renderLayerProperties(); updateControls();
});

$("historyList").addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const rows = [...$("historyList").querySelectorAll(".history-row:not(:disabled)")];
  const current = rows.indexOf(document.activeElement);
  if (current < 0 || !rows.length) return;
  event.preventDefault();
  const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 :
    Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  for (const row of rows) row.tabIndex = row === rows[index] ? 0 : -1;
  rows[index].focus();
});

$("documentTabs").addEventListener("keydown", (event) => {
  if (!event.target.matches?.('[role="tab"]')) return;
  if (event.key === "Delete") {
    event.preventDefault();
    event.target.closest(".document-tab")?.querySelector('button[aria-hidden="true"]')?.click();
    return;
  }
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...$("documentTabs").querySelectorAll('[role="tab"]')];
  const current = tabs.indexOf(event.target);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
    (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[index].focus(); tabs[index].click();
});

window.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  const editingField = isEditableTarget(event);
  if (editingField) return;
  if (key === "o") { event.preventDefault(); executeCommand("document.open"); }
  if (key === "s") {
    event.preventDefault(); executeCommand(event.shiftKey ? "document.saveAs" : "document.save");
  }
  if (key === "c" && snapshot) { event.preventDefault(); executeCommand("document.copyPixels"); }
  if (key === "x" && snapshot) { event.preventDefault(); executeCommand("document.cutPixels"); }
  if (key === "v" && snapshot) { event.preventDefault(); executeCommand("document.pastePixels"); }
  if (key === "z") {
    event.preventDefault();
    const redo = event.shiftKey;
    executeCommand(redo ? "history.redo" : "history.undo");
  }
  if (key === "y") { event.preventDefault(); executeCommand("history.redo"); }
  if (key === "n" && event.shiftKey && snapshot) {
    event.preventDefault(); executeCommand("layer.newPixel");
  }
  if (key === "e" && snapshot) { event.preventDefault(); executeCommand("layer.mergeSelected"); }
  if (key === "a") { event.preventDefault(); executeCommand("selection.all"); }
  if (key === "d") { event.preventDefault(); executeCommand("selection.clear"); }
  if (key === "j" && snapshot?.selection?.length) {
    event.preventDefault(); executeCommand("layer.layerViaCopy");
  }
});

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event)) return;
  if ((event.key === "Delete" || event.key === "Backspace") &&
      event.target instanceof Element && event.target.closest("#layerList")) {
    event.preventDefault(); $("removeLayerButton").click(); return;
  }
  const viewport = $("canvasViewport");
  const viewportFocused = event.target === viewport || viewport.contains(event.target);
  if (snapshot && viewportFocused && event.key === " ") {
    event.preventDefault(); spacePanActive = true; viewport.dataset.spacePan = "true";
  }
  if (snapshot && viewportFocused && ["+", "="].includes(event.key)) {
    event.preventDefault(); setZoom(zoom * 1.25);
  }
  if (snapshot && viewportFocused && event.key === "-") {
    event.preventDefault(); setZoom(zoom / 1.25);
  }
  if (snapshot && viewportFocused && event.key === "0") {
    event.preventDefault(); setZoom("fit");
  }
  if (snapshot && viewportFocused && event.key === "1") {
    event.preventDefault(); setZoom(1);
  }
  if (snapshot && viewportFocused && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    const amount = event.shiftKey ? 80 : 24;
    pendingPan = { left: viewport.scrollLeft + (event.key === "ArrowRight" ? amount : event.key === "ArrowLeft" ? -amount : 0),
      top: viewport.scrollTop + (event.key === "ArrowDown" ? amount : event.key === "ArrowUp" ? -amount : 0) };
    scheduleViewportUpdate("keyboard-pan");
  }
  if (event.key.toLowerCase() === "m") executeCommand("tool.marquee");
  if (event.key.toLowerCase() === "l") executeCommand(event.shiftKey ? "tool.magnetic" : "tool.lasso");
  if (event.key.toLowerCase() === "w") executeCommand(event.shiftKey ? "tool.quickSelect" : "tool.magic");
  if (event.key.toLowerCase() === "q") executeCommand("tool.quickMask");
  if (event.key.toLowerCase() === "h") executeCommand("tool.pan");
  if (event.key.toLowerCase() === "v") executeCommand("tool.move");
  if (event.key.toLowerCase() === "c") executeCommand("tool.crop");
  if (event.key.toLowerCase() === "b") executeCommand("tool.brush");
  if (event.key.toLowerCase() === "e") executeCommand("tool.eraser");
  if (event.key.toLowerCase() === "j") executeCommand(event.shiftKey ? "tool.patch" : "tool.spotHealing");
  if (event.key.toLowerCase() === "t") executeCommand("tool.text");
  if (event.key.toLowerCase() === "p") executeCommand("tool.pen");
  if (event.key === "Enter" && cropDraft) { event.preventDefault(); commitCropDraft(); return; }
  if (event.key === "Escape" && cropDraft) { event.preventDefault(); cancelCropDraft(); return; }
  if (event.key === "Enter" && transformDialogDraft) {
    event.preventDefault(); $("commitLayerTransformButton").click(); return;
  }
  if (event.key === "Escape" && transformDialogDraft) {
    event.preventDefault(); $("cancelTransformButton").click(); return;
  }
  if (event.key === "Enter" && polygonDraft) {
    const draft = polygonDraft; polygonDraft = null; previewPolygon([]);
    if (draft.points.length >= 3) commitSelectionMask("Selecting polygonal area",
      combinedSelectionMask(polygonMask(draft.points), draft.mode));
  }
  if (event.key === "Enter" && magneticDraft) {
    const draft = magneticDraft; magneticDraft = null; previewPolygon([]);
    if (draft.anchors.length >= 3) mutate("Closing Magnetic Lasso", () => client.magneticLasso({
      anchors: draft.anchors.map((point) => [Math.round(point.x), Math.round(point.y)]),
      width: Math.max(1, Math.round(Number($("brushSizeInput").value))),
      edgeContrast: Number($("edgeContrastInput").value), nodeBudget: 600000,
      combine: selectionCombineValue(draft.mode), expectedStateId: snapshot.stateId,
      expectedRevision: snapshot.revision,
    }));
  }
  if (event.key === "Escape" && polygonDraft) { polygonDraft = null; previewPolygon([]); }
  if (event.key === "Escape" && magneticDraft) { magneticDraft = null; previewPolygon([]); }
  if (event.key === "Enter" && penDraft) { event.preventDefault(); commitPenPath(false); }
  if (event.key === "Escape" && penDraft) {
    event.preventDefault(); penDraft = null; penHoverPoint = null;
    previewPolygon([]); renderPenPath(); updateControls();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key !== " ") return;
  spacePanActive = false; delete $("canvasViewport").dataset.spacePan;
});
window.addEventListener("blur", () => {
  spacePanActive = false; delete $("canvasViewport").dataset.spacePan;
});

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (event) => {
    if (event.dataTransfer?.types?.includes("application/x-patchy-layer")) return;
    event.preventDefault();
    if (type === "dragenter") dragDepth++;
    $("dropState").hidden = false;
  });
}
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropState").hidden = true; } });
window.addEventListener("drop", (event) => {
  if (event.dataTransfer?.types?.includes("application/x-patchy-layer")) return;
  event.preventDefault(); dragDepth = 0; $("dropState").hidden = true;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (openFileKind(file) === "layered") openFile(file);
  else if (openFileKind(file) === "raster") importPixelLayer(file, !snapshot);
  else showError("Unsupported drop", new Error("Drop a PSD, PSB, PNG, JPEG, WebP, AVIF, or SVG file."));
});

try {
  client = createEngineClient();
  await client.initialize(moduleUrl);
  workspaceAvailable = await workspaceStore.available();
  if (workspaceAvailable) {
    await loadLocalAssets();
    applyPreferences(await workspaceStore.loadPreferences({ locale: "en", tool: "marquee", brushSize: 24,
      color: "#111111", paintPreset: "solid", font: "Arial",
      selectionTolerance: 32, historyBudgetMiB: 256, panelsHidden: false,
      guidesVisible: true, snappingEnabled: true }));
    await refreshRecoveryList();
  } else {
    setCanvasTool("marquee");
  }
  await applyMemoryBudget(false);
  automaticRecoveryEnabled = true;
  renderRecoveryStatus();
  setSessionState("ready", "Engine ready");
  $("busyState").hidden = true;
  updateControls();
} catch (error) {
  showError("Could not start engine", error);
  $("busyState").hidden = true;
}
