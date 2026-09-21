import { PatchyWorkerClient } from "./engine/client.mjs";
import { recoverWorkerSession } from "./engine/recovery-controller.mjs";
import { PatchyCheckpointQueue, PatchyWorkspaceStore } from "./engine/workspace-store.mjs";
import { browserWorkingSetLimit, chooseRenderRegion, documentPreflight, MIB } from "./engine/memory-policy.mjs";
import { encodeFlatDocument } from "./engine/flat-export.mjs";
import { applyParagraphStyleRange, justifiedSpaceAdvance } from "./text-layout.mjs";

const $ = (id) => document.getElementById(id);
const shell = document.querySelector(".editor-shell");
const moduleUrl = new URL("./patchy-engine.mjs", location.href).href;
let client = null;
const workspaceStore = new PatchyWorkspaceStore();
const canvas = $("documentCanvas");
const context = canvas.getContext("2d", { alpha: true });
let snapshot = null;
let selectedLayerId = null;
let selectedLayerIds = new Set();
let layerSelectionAnchorId = null;
let selectedChannelId = null;
let selectedPathId = null;
let documentName = "Untitled.psd";
let busy = false;
let dragDepth = 0;
let cancelActiveOperation = null;
let canvasTool = "marquee";
let zoomMode = "fit";
let zoom = 1;
let marqueeDraft = null;
let panStart = null;
let moveDraft = null;
let transformDraft = null;
let transformDialogDraft = null;
let warpDialogDraft = null;
let transformPreviewPending = null;
let transformPreviewInFlight = false;
let transformPreviewGeneration = 0;
let transformPreviewRestore = null;
let transformPreviewCancellation = null;
let paintDraft = null;
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
let quickSelectDraft = null;
let magneticDraft = null;
let quickMaskDraft = null;
let clipboardImageBlob = null;
let layerClipboard = null;
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
const LAYER_ROW_HEIGHT = 48;
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
  const next = new PatchyWorkerClient(new Worker(
    new URL("./engine/worker.mjs", import.meta.url), { type: "module", name: "patchy-engine" }));
  next.addStateListener((state) => {
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
  command.run();
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

function setSingleLayerSelection(layerId) {
  selectedLayerId = layerId ?? null;
  selectedLayerIds = layerId == null ? new Set() : new Set([layerId]);
  layerSelectionAnchorId = layerId ?? null;
}

function clearLayerSelection() { setSingleLayerSelection(null); }

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
  const list = $("historyList"); list.replaceChildren();
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
    button.disabled = busy || row.steps === 0;
    const marker = document.createElement("span"); marker.className = "history-marker";
    marker.textContent = row.steps === 0 ? "●" : row.direction === "undo" ? "↶" : "↷";
    const label = document.createElement("span"); label.className = "history-label"; label.textContent = row.label;
    button.append(marker, label);
    if (row.steps) button.addEventListener("click", () => navigateHistory(row.steps));
    list.append(button);
  }
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function setSessionState(state, label) {
  shell.dataset.state = state;
  $("sessionIndicator").lastElementChild.textContent = label;
}

function setBusy(active, title = "Working", detail = "The engine is updating the document") {
  busy = active;
  shell.setAttribute("aria-busy", String(active));
  $("busyState").hidden = !active;
  $("busyTitle").textContent = title;
  $("busyDetail").textContent = detail;
  if (!active) {
    cancelActiveOperation = null;
    $("busyProgress").hidden = true;
    $("cancelOperationButton").hidden = true;
    $("cancelOperationButton").disabled = false;
    $("busyProgress").value = 0;
  }
  for (const button of [$("openButton"), $("newButton"), $("recoveryButton"), $("saveButton"), $("undoButton"), $("redoButton")]) {
    button.dataset.busyDisabled = active ? "true" : "false";
  }
  updateControls();
}

function updateControls() {
  const layer = selectedLayer();
  const layers = selectedLayers();
  const single = layers.length === 1;
  $("saveButton").disabled = busy || !snapshot;
  $("saveFormatSelect").disabled = busy || !snapshot;
  if (snapshot) {
    const format = documentSaveFormats.get(snapshot.documentId) || "psd";
    $("saveFormatSelect").value = format;
    $("saveButton").querySelector(".download-label").textContent = `Download ${format.toUpperCase()}`;
  }
  $("exportFormatSelect").disabled = busy || !snapshot;
  $("exportButton").disabled = busy || !snapshot;
  $("copyPixelsButton").disabled = busy || !snapshot;
  $("pastePixelsButton").disabled = busy || !snapshot ||
    (!layerClipboard && !clipboardImageBlob && !navigator.clipboard?.read);
  $("undoButton").disabled = busy || !snapshot?.canUndo;
  $("redoButton").disabled = busy || !snapshot?.canRedo;
  $("openButton").disabled = busy;
  $("newButton").disabled = busy;
  $("recoveryButton").disabled = busy;
  $("memoryBudgetSelect").disabled = busy;
  $("importLayerButton").disabled = busy || !snapshot;
  $("groupLayerButton").disabled = busy || !layers.length;
  $("ungroupLayerButton").disabled = busy || !layers.length || layers.some((item) => item.kind !== 1);
  $("removeLayerButton").disabled = busy || !layers.length;
  $("invertLayerButton").disabled = busy || !single || layer?.kind !== 0;
  $("filterLayerButton").disabled = busy || !single || layer?.kind !== 0;
  $("textLayerButton").disabled = busy || !snapshot;
  $("textLayerButton").textContent = single && layer?.kind === 3 ? "Edit text" : "Add text";
  $("layerTransformButton").disabled = busy || !single || ![0, 3, 5].includes(layer?.kind) ||
    Boolean(layer?.mask && !layer.mask.linked) || Boolean(layer?.vectorMask);
  $("layerWarpButton").disabled = busy || !single || ![0, 3, 5].includes(layer?.kind) ||
    Boolean(layer?.vectorMask) || Boolean(layer?.mask && !layer.mask.linked);
  $("shapeLayerButton").disabled = busy || !snapshot;
  $("adjustmentLayerButton").disabled = busy || !snapshot;
  $("smartObjectButton").disabled = busy || !snapshot;
  $("smartObjectButton").textContent = layer?.kind === 5 ? "Replace Smart Object" : "Place Smart Object";
  $("openSmartObjectButton").disabled = busy || !single || layer?.kind !== 5 ||
    !layer?.smartObject?.contentsEditable;
  $("smartFilterButton").disabled = busy || !single || layer?.kind !== 5 || !layer?.smartObject?.editable;
  const hasVectorMaskSource = Boolean(selectedPath()?.subpaths?.length || snapshot?.selection?.length);
  $("createVectorMaskButton").disabled = busy || !single || !layer || layer.kind === 1 ||
    layer.kind === 4 || !hasVectorMaskSource;
  $("createMaskButton").disabled = busy || !single || layer?.kind !== 0 || Boolean(layer?.mask);
  $("toggleMaskButton").disabled = busy || !single || !layer?.mask;
  $("toggleMaskButton").textContent = layer?.mask?.disabled ? "Enable mask" : "Disable mask";
  $("linkMaskButton").disabled = busy || !single || !layer?.mask;
  $("linkMaskButton").textContent = layer?.mask?.linked === false ? "Link mask" : "Unlink mask";
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
  $("layerBlendSelect").disabled = busy || !layers.length;
  $("layerClipInput").disabled = busy || !single;
  $("layerLockInput").disabled = busy || !layers.length;
  $("layerStyleSelect").disabled = busy || !single;
  $("applyLayerStyleButton").disabled = busy || !single;
  $("editLayerStyleButton").disabled = busy || !single;
  for (const id of ["invertSelectionButton", "expandSelectionButton", "contractSelectionButton",
    "borderSelectionButton", "growSelectionButton", "similarSelectionButton",
    "smoothSelectionButton", "featherSelectionButton", "saveChannelButton", "savePathButton"]) {
    $(id).disabled = busy || !snapshot?.selection?.length;
  }
  $("rasterizeLayerButton").disabled = busy || !single || ![3, 4, 5].includes(layer?.kind);
  $("mergeVisibleButton").disabled = busy || !snapshot?.layers?.length;
  for (const id of ["channelRenameButton", "channelInvertButton", "channelUpButton",
    "channelDownButton", "channelDeleteButton"]) $(id).disabled = busy || !selectedChannel();
  for (const id of ["pathRenameButton", "pathClipButton", "pathUpButton", "pathDownButton",
    "pathDeleteButton", "pathAnchorApplyButton"]) $(id).disabled = busy || !selectedPath();
  $("pathAnchorXInput").disabled = busy || !selectedPath()?.anchors?.length;
  $("pathAnchorYInput").disabled = busy || !selectedPath()?.anchors?.length;
  syncCommands();
  renderHistory();
}

function openDocumentDialog() {
  if (busy || !snapshot) return;
  for (const id of ["documentWidthInput", "cropWidthInput"]) $(id).value = String(snapshot.width);
  for (const id of ["documentHeightInput", "cropHeightInput"]) $(id).value = String(snapshot.height);
  $("cropXInput").value = "0";
  $("cropYInput").value = "0";
  $("documentDialog").showModal();
}

function integerInput(id, positive = false) {
  const input = $(id);
  if (!input.reportValidity()) return null;
  const value = Number(input.value);
  if (!Number.isInteger(value) || (positive && value <= 0)) {
    input.setCustomValidity(positive ? "Enter a positive whole number" : "Enter a whole number");
    input.reportValidity();
    input.setCustomValidity("");
    return null;
  }
  return value;
}

function documentMutation(title, operation) {
  $("documentDialog").close();
  mutate(title, operation);
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
  $("errorTitle").textContent = title;
  $("errorMessage").textContent = error?.message || String(error);
  $("errorBanner").hidden = false;
  if (client.state === "crashed") setSessionState("crashed", "Worker crashed");
  else setSessionState(snapshot ? "document" : "error", snapshot ? "Document ready" : "Engine error");
}

function clearError() { $("errorBanner").hidden = true; }

function newWorkspaceId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint32Array(4));
  return `workspace-${[...random].map((value) => value.toString(16).padStart(8, "0")).join("")}`;
}

function setRecoveryLabel(state, label) {
  const output = $("recoveryLabel");
  output.dataset.state = state;
  output.textContent = label;
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
    tool: canvasTool,
    brushSize: Number($("brushSizeInput").value),
    color: $("brushColorInput").value,
    paintPreset: $("paintPresetSelect").value,
    font: $("textFontInput").value.trim() || "Arial",
    selectionTolerance: Number($("selectionToleranceInput").value),
    historyBudgetMiB: Number($("memoryBudgetSelect").value),
    panelsHidden: shell.classList.contains("panels-hidden"),
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
  $("brushSizeInput").value = String(preferences.brushSize);
  $("brushSizeOutput").textContent = `${preferences.brushSize} px`;
  $("brushColorInput").value = preferences.color;
  $("paintPresetSelect").value = preferences.paintPreset;
  $("textFontInput").value = preferences.font;
  $("selectionToleranceInput").value = String(preferences.selectionTolerance);
  $("selectionToleranceOutput").textContent = String(preferences.selectionTolerance);
  $("memoryBudgetSelect").value = String(preferences.historyBudgetMiB);
  shell.classList.toggle("panels-hidden", preferences.panelsHidden);
  $("togglePanelsButton").setAttribute("aria-pressed", String(preferences.panelsHidden));
  setCanvasTool(preferences.tool);
}

async function recoverEngineAfterCrash() {
  if (recoveryPromise) return recoveryPromise;
  const documents = (snapshot?.documents || []).map((documentTab) => ({
    documentId: documentTab.id,
    workspaceId: workspaceIds.get(documentTab.id),
    active: documentTab.active,
    confirmed: checkpointStates.get(documentTab.id) === "confirmed",
  })).filter((documentTab) => documentTab.workspaceId);
  automaticRecoveryEnabled = false;
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
      for (const item of result.restored) {
        workspaceIds.set(item.documentId, item.workspaceId);
        checkpointStates.set(item.documentId, "confirmed");
        documentSaveFormats.set(item.documentId, item.format);
      }
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
      layerClipboard = null; draggedLayer = null;
      await acceptSnapshot(result.activeSnapshot);
      automaticRecoveryEnabled = true;
      const reverted = result.restored.filter((item) => !item.confirmedAtCrash);
      if (result.failed.length || reverted.length) {
        const names = result.failed.map((item) => item.workspaceId).join(", ");
        showError("Editor restarted with partial recovery",
          new Error(`${result.restored.length} workspace(s) restored from confirmed snapshots; ${result.failed.length} could not be restored${names ? `: ${names}` : ""}${reverted.length ? `; ${reverted.length} had unconfirmed changes and were rolled back` : ""}.`));
      } else {
        setSessionState(result.activeSnapshot ? "document" : "ready",
          result.restored.length ? `Recovered ${result.restored.length} workspace${result.restored.length === 1 ? "" : "s"}` : "Engine restarted");
      }
    } catch (error) {
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
        dirty: checkpoint.dirty, format: checkpoint.format, bytes }),
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

function ensureMemorySafe(input, label) {
  const preflight = documentPreflight({ ...input, limitBytes: workingSetLimit });
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
    const next = await client.open(recovered.bytes, recovered.manifest.name,
      { transferOwnership: true });
    workspaceIds.set(next.documentId, id);
    checkpointStates.set(next.documentId, "confirmed");
    documentSaveFormats.set(next.documentId, recovered.manifest.format || "psd");
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
  } catch (error) { showError("Could not recover workspace", error); }
  finally { setBusy(false); }
}

async function removeWorkspace(manifest) {
  if (!confirm(`Delete the local recovery snapshot for ${manifest.name}?`)) return;
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

async function cleanupRecoveryWorkspaces() {
  if (busy || !workspaceAvailable) return;
  const protectedIds = [...new Set(workspaceIds.values())];
  const removable = (await workspaceStore.list()).filter((item) => !protectedIds.includes(item.id)).slice(8);
  if (!removable.length) {
    $("recoverySummary").textContent = "No older recovery workspaces are outside the keep-newest boundary.";
    return;
  }
  if (!confirm(`Delete ${removable.length} older recovery workspace${removable.length === 1 ? "" : "s"}? Open workspaces and the 8 newest closed workspaces are protected.`)) return;
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
  list.replaceChildren();
  const layers = snapshot ? [...snapshot.layers].reverse() : [];
  $("layerCount").textContent = String(layers.length);
  $("layersEmpty").hidden = layers.length > 0;
  $("layersEmpty").textContent = snapshot ? "This document has no layers." : "Open a document to inspect its layers.";
  const viewportRows = Math.max(1, Math.ceil((list.clientHeight || 480) / LAYER_ROW_HEIGHT));
  const first = Math.max(0, Math.floor(scrollTop / LAYER_ROW_HEIGHT) - LAYER_OVERSCAN);
  const last = Math.min(layers.length, first + viewportRows + LAYER_OVERSCAN * 2);
  const topSpacer = document.createElement("div");
  topSpacer.className = "layer-spacer"; topSpacer.style.height = `${first * LAYER_ROW_HEIGHT}px`;
  list.append(topSpacer);
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  for (let index = first; index < last; ++index) {
    const layer = layers[index];
    const row = document.createElement("div");
    row.className = "layer-row";
    row.draggable = true;
    row.setAttribute("role", "option");
    row.setAttribute("aria-setsize", String(layers.length));
    row.setAttribute("aria-posinset", String(index + 1));
    row.dataset.active = String(selectedLayerIds.has(layer.id));
    row.dataset.layerId = String(layer.id);
    row.setAttribute("aria-selected", String(selectedLayerIds.has(layer.id)));
    row.style.paddingLeft = `${5 + layerDepth(layer, byId) * 12}px`;
    row.innerHTML = `
      <button class="visibility-button" type="button" aria-label="${layer.visible ? "Hide" : "Show"} ${escapeHtml(layer.name)}">${layer.visible ? "◉" : "○"}</button>
      <canvas class="layer-thumb" width="32" height="32" aria-hidden="true"></canvas>
      <button class="layer-copy layer-select-button" type="button"><span class="layer-name"></span><span class="layer-kind"></span></button>
      <button class="reorder-button" type="button" aria-label="Move layer up" ${index === 0 ? "disabled" : ""}>↑</button>
      <button class="reorder-button" type="button" aria-label="Move layer down" ${index === layers.length - 1 ? "disabled" : ""}>↓</button>`;
    row.querySelector(".layer-name").textContent = layer.name || "Unnamed layer";
    row.querySelector(".layer-kind").textContent = `${formatKind(layer)}${layer.mask ? ` · Mask${layer.mask.disabled ? " off" : ""}` : ""}${layer.adjustment ? ` · ${adjustmentName(layer.adjustment.kind)}` : ""}${layer.smartObject ? ` · ${layer.smartObject.filename}` : ""}`;
    row.querySelector(".layer-select-button").setAttribute("aria-label", `Select ${layer.name || "unnamed layer"}`);
    row.querySelector(".layer-select-button").addEventListener("click", (event) => {
      selectLayerFromEvent(layer, event, layers);
      renderLayers();
      renderLayerProperties();
    });
    row.addEventListener("dragstart", (event) => {
      if (!selectedLayerIds.has(layer.id)) setSingleLayerSelection(layer.id);
      draggedLayer = captureLayerReference(layer);
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
  bottomSpacer.className = "layer-spacer";
  bottomSpacer.style.height = `${Math.max(0, layers.length - last) * LAYER_ROW_HEIGHT}px`;
  list.append(bottomSpacer);
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
      mutate("Loading path selection", () => client.selectPath(path.id));
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
  $("detailState").textContent = snapshot ? (snapshot.dirty ? "Modified" : "Saved") : "No document";
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
  const tabs = $("documentTabs"); tabs.replaceChildren();
  const documents = snapshot?.documents || [];
  tabs.hidden = documents.length === 0;
  for (const documentTab of documents) {
    const item = document.createElement("span"); item.className = "document-tab";
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
    activate.title = documentTab.name;
    activate.textContent = `${documentTab.dirty ? "• " : ""}${documentTab.name}`;
    activate.addEventListener("click", () => activateDocumentTab(documentTab.id));
    const close = document.createElement("button"); close.type = "button";
    close.setAttribute("aria-label", `Close ${documentTab.name}`); close.textContent = "×";
    close.addEventListener("click", () => closeDocumentTab(documentTab));
    item.append(activate, close); tabs.append(item);
  }
}

async function renderDocument() {
  if (!snapshot) return;
  const region = chooseRenderRegion(snapshot, renderedDocument && {
    ...renderedDocument, currentDocumentId: snapshot.documentId,
  });
  if (!region) {
    applyViewport(); renderSelection(); renderTransformOverlay(); return;
  }
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
    try { context.drawImage(frame.bitmap, region.x, region.y); }
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
  renderTransformOverlay();
  await acceptSnapshot(await client.snapshot(), false);
}

function applyViewport() {
  if (!snapshot) return;
  const viewport = $("canvasViewport");
  if (zoomMode === "fit") {
    zoom = Math.min(1, Math.max(0.02,
      Math.min((viewport.clientWidth - 80) / snapshot.width,
        (viewport.clientHeight - 80) / snapshot.height)));
  }
  $("canvasFrame").style.width = `${Math.max(1, snapshot.width * zoom)}px`;
  $("canvasFrame").style.height = `${Math.max(1, snapshot.height * zoom)}px`;
  $("zoomLabel").textContent = zoomMode === "fit" ? `Fit · ${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}%`;
}

function renderSelection(rect = marqueeDraft) {
  const overlay = $("selectionOverlay");
  const rects = rect ? [rect] : snapshot?.selection || [];
  if (canvasTool === "quickMask") { overlay.hidden = true; renderQuickMask(); return; }
  if (!snapshot || !rects.length) { overlay.hidden = true; return; }
  const left = Math.min(...rects.map((item) => item.x));
  const top = Math.min(...rects.map((item) => item.y));
  const right = Math.max(...rects.map((item) => item.x + item.width));
  const bottom = Math.max(...rects.map((item) => item.y + item.height));
  overlay.style.left = `${left / snapshot.width * 100}%`;
  overlay.style.top = `${top / snapshot.height * 100}%`;
  overlay.style.width = `${(right - left) / snapshot.width * 100}%`;
  overlay.style.height = `${(bottom - top) / snapshot.height * 100}%`;
  overlay.hidden = false;
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
  if (tool !== "pen" && penDraft) { penDraft = null; previewPolygon([]); }
  if (tool !== "magnetic") magneticDraft = null;
  if (tool !== "quickSelect") quickSelectDraft = null;
  if (tool !== "quickMask") quickMaskDraft = null;
  canvasTool = tool;
  $("canvasViewport").dataset.tool = tool;
  for (const [id, value] of [["moveToolButton", "move"], ["marqueeToolButton", "marquee"],
    ["lassoToolButton", "lasso"], ["polygonToolButton", "polygon"], ["magicToolButton", "magic"],
    ["quickSelectToolButton", "quickSelect"], ["magneticToolButton", "magnetic"],
    ["quickMaskToolButton", "quickMask"],
    ["panToolButton", "pan"], ["brushToolButton", "brush"],
    ["eraserToolButton", "eraser"], ["cloneToolButton", "clone"],
    ["healToolButton", "heal"], ["gradientToolButton", "gradient"], ["penToolButton", "pen"],
    ["textToolButton", "text"]]) {
    $(id).setAttribute("aria-pressed", String(tool === value));
  }
  if (tool === "quickMask") renderQuickMask();
  else if (quickMaskDraft == null) $("gestureCanvas").getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
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
  return mutate(title, () => client.setSelectionMask(
    { x: 0, y: 0, width: snapshot.width, height: snapshot.height }, gray,
    { transferOwnership: true }));
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
  return event.shiftKey && event.altKey ? "intersect" : event.shiftKey ? "add" : event.altKey ? "subtract" : "replace";
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

function boxBlurMask(source, width, height, radius) {
  const horizontal = new Uint32Array(source.length); const result = new Uint8Array(source.length);
  for (let y = 0; y < height; ++y) {
    let sum = 0;
    for (let x = -radius; x <= radius; ++x) sum += source[y * width + Math.max(0, Math.min(width - 1, x))];
    for (let x = 0; x < width; ++x) {
      horizontal[y * width + x] = Math.round(sum / (radius * 2 + 1));
      sum += source[y * width + Math.min(width - 1, x + radius + 1)] -
        source[y * width + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; ++x) {
    let sum = 0;
    for (let y = -radius; y <= radius; ++y) sum += horizontal[Math.max(0, Math.min(height - 1, y)) * width + x];
    for (let y = 0; y < height; ++y) {
      result[y * width + x] = Math.round(sum / (radius * 2 + 1));
      sum += horizontal[Math.min(height - 1, y + radius + 1) * width + x] -
        horizontal[Math.max(0, y - radius) * width + x];
    }
  }
  return result;
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
  if (!snapshot || !quad) { overlay.hidden = true; return; }
  overlay.setAttribute("viewBox", `0 0 ${snapshot.width} ${snapshot.height}`);
  $("transformPolygon").setAttribute("points", Array.from({ length: 4 }, (_, index) =>
    `${quad[index * 2]},${quad[index * 2 + 1]}`).join(" "));
  [...overlay.querySelectorAll("circle")].forEach((handle, index) => {
    handle.setAttribute("cx", String(quad[index * 2]));
    handle.setAttribute("cy", String(quad[index * 2 + 1]));
    handle.setAttribute("r", String(Math.max(3, 6 / Math.max(zoom, .05))));
  });
  overlay.hidden = false;
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

function scheduleTransformPreview(layer, quad) {
  if (!snapshot || !layer || quad.some((value) => !Number.isFinite(value))) return;
  if (transformPreviewCancellation) Atomics.store(transformPreviewCancellation, 0, 1);
  transformPreviewCancellation = new Int32Array(new SharedArrayBuffer(4));
  const generation = ++transformPreviewGeneration;
  transformPreviewPending = { layer, quad: [...quad], stateId: snapshot.stateId,
    revision: snapshot.revision, generation,
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

function setZoom(next) {
  zoomMode = next === "fit" ? "fit" : "manual";
  if (next !== "fit") zoom = Math.min(8, Math.max(0.05, next));
  applyViewport();
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

async function acceptSnapshot(next, rerender = true) {
  if (!next) {
    snapshot = null; clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    renderedDocument = null;
    $("emptyState").hidden = false; setSessionState("ready", "Engine ready");
    renderLayers(); renderLayerProperties(); renderStructure(); renderMetadata(); renderDocumentTabs(); renderHistory();
    renderRecoveryStatus();
    return;
  }
  snapshot = next;
  documentName = snapshot.documentName || documentName;
  if (!documentSaveFormats.has(snapshot.documentId)) {
    documentSaveFormats.set(snapshot.documentId,
      documentName.toLowerCase().endsWith(".psb") ? "psb" : "psd");
  }
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
  const recoveryWarning = checkpointStates.get(documentTab.id) === "confirmed"
    ? "Its latest confirmed local recovery snapshot will remain available."
    : "Local recovery is not confirmed, so recent changes may be lost.";
  if (documentTab.dirty && !confirm(`Close ${documentTab.name}? ${recoveryWarning}`)) return;
  clearError(); setBusy(true, "Closing document", "Releasing its canonical Worker session");
  try {
    if (snapshot?.documentId === documentTab.id) {
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    }
    await checkpointQueues.get(documentTab.id)?.whenIdle();
    const next = await client.closeDocument(documentTab.id);
    workspaceIds.delete(documentTab.id); checkpointStates.delete(documentTab.id);
    documentSaveFormats.delete(documentTab.id);
    checkpointQueues.delete(documentTab.id);
    documentHistoryLabels.delete(documentTab.id);
    await acceptSnapshot(next);
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
  }
  catch (error) { showError(`${title} failed`, error); }
  finally { setBusy(false); }
}

async function navigateHistory(steps) {
  if (busy || !snapshot || !Number.isSafeInteger(steps) || steps === 0) return;
  const before = snapshot;
  clearError(); setBusy(true, "Navigating history", `Moving ${Math.abs(steps)} state${Math.abs(steps) === 1 ? "" : "s"}`);
  try {
    const next = await client.historyTravel(steps, before.stateId, before.revision);
    recordHistoryTravel(before, next, steps);
    await acceptSnapshot(next); scheduleCheckpoint(next);
  } catch (error) { showError("History navigation failed", error); }
  finally { setBusy(false); }
}

async function openFile(file) {
  if (!file || busy) return;
  clearError();
  setBusy(true, "Opening document", "Transferring bytes to the isolated Worker");
  try {
    const header = await client.inspectBlob(file);
    ensureMemorySafe(header, file.name || "Document");
    const next = await client.openBlob(file, file.name || "Document.psd");
    documentSaveFormats.set(next.documentId, header.version === 2 ? "psb" : "psd");
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  } catch (error) { showError("Could not open document", error); }
  finally { setBusy(false); }
}

async function newDocument() {
  if (busy) return;
  clearError();
  setBusy(true, "Creating document", "Preparing a 1600 × 1000 RGBA workspace");
  try {
    ensureMemorySafe({ width: 1600, height: 1000 }, "New document");
    const next = await client.create(1600, 1000, "Untitled.psd");
    clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  } catch (error) { showError("Could not create document", error); }
  finally { setBusy(false); }
}

async function saveDocument() {
  if (busy || !snapshot) return;
  clearError();
  const activeTab = snapshot.documents.find((item) => item.active);
  const applyingContents = activeTab?.smartObjectParentId != null;
  const format = documentSaveFormats.get(snapshot.documentId) || "psd";
  setBusy(true, applyingContents ? "Applying Smart Object contents" : `Encoding ${format.toUpperCase()}`,
    applyingContents ? "Committing one guarded parent revision" : "Preparing a local browser download");
  try {
    if (applyingContents) {
      const before = snapshot;
      const next = await client.saveSmartObjectContents(snapshot.documentId);
      recordHistoryMutation(before, next, "Applying Smart Object contents");
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
      await acceptSnapshot(next);
      scheduleCheckpoint(next);
      return;
    }
    const blob = await client.saveBlob(format);
    downloadBlob(blob, `${exportBaseName()}.${format}`);
  } catch (error) { showError("Could not encode layered document", error); }
  finally { setBusy(false); }
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
  } catch (error) { showError("Could not open Smart Object contents", error); }
  finally { setBusy(false); }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
  } catch (error) { showError("Could not export document", error); }
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

async function copyRenderedPixels() {
  if (busy || !snapshot) return;
  try {
    const layer = selectedLayer();
    if (layer) {
      layerClipboard = captureLayerReference(layer);
      updateControls(); setSessionState("document", "Editable layer copied locally");
      return;
    }
    clipboardImageBlob = await canvasBlob(renderedSelectionCanvas(), "image/png");
    if (navigator.clipboard?.write && globalThis.ClipboardItem) {
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardImageBlob })]); }
      catch { /* The in-memory clipboard remains available across opened documents. */ }
    }
    updateControls(); setSessionState("document", "Pixels copied locally");
  } catch (error) { showError("Could not copy pixels", error); }
}

async function pastePixels() {
  if (busy || !snapshot) return;
  try {
    if (layerClipboard) {
      await transferLayerReference(layerClipboard, snapshot.documentId);
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
  } catch (error) { showError("Could not paste pixels", error); }
}

function captureLayerReference(layer) {
  return { sourceDocumentId: snapshot.documentId, layerId: layer.id,
    expectedSourceStateId: snapshot.stateId,
    expectedSourceRevision: snapshot.revision, name: layer.name };
}

async function transferLayerReference(reference, targetDocumentId) {
  if (busy || !snapshot || !reference) return;
  clearError(); setBusy(true, "Copying editable layer", "Committing one canonical target revision");
  try {
    let target = snapshot;
    if (target.documentId !== targetDocumentId) {
      target = await client.activateDocument(targetDocumentId);
      clearLayerSelection(); selectedChannelId = null; selectedPathId = null;
    }
    const next = await client.copyLayerToDocument({ ...reference,
      targetDocumentId, expectedTargetStateId: target.stateId,
      expectedTargetRevision: target.revision });
    recordHistoryMutation(target, next, "Copying editable layer");
    setSingleLayerSelection(next.activeLayerId);
    await acceptSnapshot(next); scheduleCheckpoint(next);
  } catch (error) { showError("Could not copy editable layer", error); }
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
    if (!snapshot) {
      await acceptSnapshot(await client.create(image.width, image.height, `${name}.psd`));
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

function commitPenPath() {
  const draft = penDraft; penDraft = null; previewPolygon([]);
  if (!draft || draft.points.length < 3) return;
  mutate("Creating Pen path", () => client.addDocumentPath({
    name: `Path ${snapshot.paths.length + 1}`, kind: 0,
    path: { subpaths: [{ anchors: draft.points, shapeGroup: 0,
      combine: 1, closed: draft.closed }] } }));
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
  $("shapeDialog").showModal();
}

function commitShape() {
  const x = integerInput("shapeXInput"); const y = integerInput("shapeYInput");
  const width = integerInput("shapeWidthInput", true); const height = integerInput("shapeHeightInput", true);
  const strokeWidth = Number($("shapeStrokeWidthInput").value);
  if ([x, y, width, height].some((value) => value == null) || !Number.isFinite(strokeWidth) || strokeWidth < 0) return;
  $("shapeDialog").close();
  const bounds = { x, y, width, height };
  const layer = selectedLayer();
  const input = { name: layer?.name || "Shape",
    path: geometricShapePath($("shapeKindInput").value, bounds),
    fill: colorBytes($("shapeFillInput").value), strokeEnabled: strokeWidth > 0,
    stroke: colorBytes($("shapeStrokeInput").value), strokeWidth };
  mutate(layer?.kind === 4 ? "Updating vector points" : "Creating vector shape", () => layer?.kind === 4
    ? client.updateVectorShape(layer.id, input) : client.addVectorShape(input));
}

function openAdjustmentDialog() {
  if (busy || !snapshot) return;
  const layer = selectedLayer();
  const editing = layer?.kind === 2;
  $("adjustmentDialogTitle").textContent = editing ? "Edit adjustment layer" : "Create adjustment layer";
  $("commitAdjustmentButton").textContent = editing ? "Update adjustment" : "Create adjustment";
  $("adjustmentKindInput").value = String(layer?.adjustment?.kind ?? 7);
  renderAdjustmentParameters(editing ? layer.adjustment : null);
  $("adjustmentDialog").showModal();
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

function commitAdjustment() {
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
  $("adjustmentDialog").close();
  mutate(layer?.kind === 2 ? "Updating adjustment" : "Creating adjustment", () => layer?.kind === 2
    ? client.updateAdjustment(layer.id, input) : client.addAdjustment(input));
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
  $("textDialog").showModal();
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
  $("textDialog").close();
  const editing = textEditingId; textEditingId = null;
  await mutate(editing ? "Updating text" : "Creating text", () => editing
    ? client.updateTextLayer(editing, payload, { transferOwnership: true })
    : client.addTextLayer(payload, { transferOwnership: true }));
}

function openLayerTransformDialog() {
  const layer = selectedLayer();
  if (busy || ![0, 3, 5].includes(layer?.kind) || layer?.vectorMask ||
      (layer?.mask && !layer.mask.linked)) return;
  for (const [id, value] of [["layerXInput", layer.bounds.x], ["layerYInput", layer.bounds.y],
    ["layerWidthInput", layer.bounds.width], ["layerHeightInput", layer.bounds.height]]) $(id).value = String(value);
  $("layerAngleInput").value = "0";
  $("layerFlipXInput").checked = false; $("layerFlipYInput").checked = false;
  $("layerTransformModeInput").value = "affine";
  $("layerTransformModeInput").querySelector('option[value="perspective"]').disabled = layer.kind === 3;
  transformDialogDraft = { layer, quad: quadFromBounds(layer.bounds) };
  updateTransformDialogPreview();
  $("layerTransformDialog").show();
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
  scheduleTransformPreview(transformDialogDraft.layer, quad);
}

function commitLayerQuad(layer, quad, title = "Transforming layer") {
  if (!snapshot) return;
  const expectedStateId = snapshot.stateId; const expectedRevision = snapshot.revision;
  clearTransformPreview(true);
  return mutate(title, () => client.transformLayer({ layerId: layer.id, quad,
    interpolation: 1, expectedStateId, expectedRevision }));
}

function drawPaintSegment(draft, from, to) {
  const size = draft.brushSize;
  const erase = draft.tool === "eraser";
  const paint = (target, a, b, color, composite) => {
    target.save(); target.lineCap = "round"; target.lineJoin = "round";
    target.lineWidth = size; target.globalCompositeOperation = composite;
    target.strokeStyle = color; target.beginPath(); target.moveTo(a.x, a.y); target.lineTo(b.x, b.y); target.stroke();
    target.beginPath(); target.arc(b.x, b.y, size / 2, 0, Math.PI * 2); target.fillStyle = color; target.fill(); target.restore();
  };
  paint(draft.overlay, from, to, erase ? "#ffffff88" : $("brushColorInput").value,
    "source-over");
}

function rasterStrokePayload(draft) {
  return { layerId: draft.layer.id,
    mode: { brush: 0, eraser: 1, clone: 2, heal: 3 }[draft.tool],
    brushSize: draft.brushSize, color: draft.color,
    points: draft.points.map(({ x, y }) => [x, y]),
    source: draft.source ? [draft.source.x, draft.source.y] : [0, 0],
    expectedStateId: draft.stateId, expectedRevision: draft.revision };
}

function layerMaskStrokePayload(draft) {
  return { layerId: draft.layer.id, mode: draft.tool === "eraser" ? 1 : 0,
    brushSize: draft.brushSize, color: draft.color,
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
  const draft = { pointerId: event.pointerId, tool: canvasTool, layer, last: point,
    start: point, source: cloneSource, ready: true, points: [point],
    maskTarget,
    stateId: snapshot.stateId, revision: snapshot.revision,
    brushSize: Math.round(Number($("brushSizeInput").value)),
    color: [...colorBytes($("brushColorInput").value), 255],
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
  await mutate("Filling pixels", () => client.applyRasterFill(rasterFillPayload(draft)));
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function openPicker() { if (!busy) $("fileInput").click(); }
registerCommand("document.open", "openButton", openPicker, () => !busy);
registerCommand("document.new", "newButton", newDocument, () => !busy);
registerCommand("document.recovery", "recoveryButton", openRecoveryDialog, () => !busy);
registerCommand("document.assets", "assetsButton", () => $("assetsDialog").showModal(),
  () => !busy && workspaceAvailable);
registerCommand("document.save", "saveButton", saveDocument, () => !busy && Boolean(snapshot));
registerCommand("layer.openSmartObject", "openSmartObjectButton", openSmartObjectContents,
  () => !busy && Boolean(selectedLayer()?.smartObject?.contentsEditable));
registerCommand("layer.filter", "filterLayerButton", openFilterDialog,
  () => !busy && selectedLayer()?.kind === 0);
registerCommand("document.export", "exportButton", exportDocument, () => !busy && Boolean(snapshot));
registerCommand("document.copyPixels", "copyPixelsButton", copyRenderedPixels, () => !busy && Boolean(snapshot));
registerCommand("document.pastePixels", "pastePixelsButton", pastePixels, () => !busy && Boolean(snapshot) &&
  Boolean(layerClipboard || clipboardImageBlob || navigator.clipboard?.read));
registerCommand("history.undo", "undoButton", () => navigateHistory(-1), () => !busy && Boolean(snapshot?.canUndo));
registerCommand("history.redo", "redoButton", () => navigateHistory(1), () => !busy && Boolean(snapshot?.canRedo));
registerCommand("document.canvas", "transformButton", openDocumentDialog, () => !busy && Boolean(snapshot));
registerCommand("tool.move", "moveToolButton", () => setCanvasTool("move"));
registerCommand("tool.marquee", "marqueeToolButton", () => setCanvasTool("marquee"));
registerCommand("tool.lasso", "lassoToolButton", () => setCanvasTool("lasso"));
registerCommand("tool.polygon", "polygonToolButton", () => setCanvasTool("polygon"));
registerCommand("tool.magic", "magicToolButton", () => setCanvasTool("magic"));
registerCommand("tool.quickSelect", "quickSelectToolButton", () => setCanvasTool("quickSelect"));
registerCommand("tool.magnetic", "magneticToolButton", () => setCanvasTool("magnetic"));
registerCommand("tool.quickMask", "quickMaskToolButton", () => setCanvasTool("quickMask"));
registerCommand("tool.pan", "panToolButton", () => setCanvasTool("pan"));
registerCommand("tool.brush", "brushToolButton", () => setCanvasTool("brush"));
registerCommand("tool.eraser", "eraserToolButton", () => setCanvasTool("eraser"));
registerCommand("tool.clone", "cloneToolButton", () => setCanvasTool("clone"));
registerCommand("tool.heal", "healToolButton", () => setCanvasTool("heal"));
registerCommand("tool.gradient", "gradientToolButton", () => setCanvasTool("gradient"));
registerCommand("tool.fill", "fillToolButton", fillSelectedPixels, () => !busy && selectedLayer()?.kind === 0);
registerCommand("tool.pen", "penToolButton", () => setCanvasTool("pen"));
registerCommand("tool.text", "textToolButton", () => { setCanvasTool("text"); openTextDialog(); });
registerCommand("selection.all", "selectAllButton", () => {
  mutate("Selecting all", () => client.setSelection([{ x: 0, y: 0, width: snapshot.width, height: snapshot.height }]));
}, () => !busy && Boolean(snapshot));
registerCommand("selection.clear", "clearSelectionButton", () => mutate("Clearing selection", () => client.clearSelection()),
  () => !busy && Boolean(snapshot?.selection?.length));
registerCommand("view.zoomOut", "zoomOutButton", () => setZoom(zoom / 1.25), () => Boolean(snapshot));
registerCommand("view.zoomIn", "zoomInButton", () => setZoom(zoom * 1.25), () => Boolean(snapshot));
registerCommand("view.fit", "zoomFitButton", () => setZoom("fit"), () => Boolean(snapshot));
for (const [id, command] of commandRegistry) {
  command.button?.addEventListener("click", () => executeCommand(id));
}

$("emptyOpenButton").addEventListener("click", openPicker);
$("saveFormatSelect").addEventListener("change", () => {
  if (!snapshot) return;
  documentSaveFormats.set(snapshot.documentId, $("saveFormatSelect").value);
  updateControls(); scheduleCheckpoint(snapshot);
});
$("fileInput").addEventListener("change", () => { openFile($("fileInput").files[0]); $("fileInput").value = ""; });
$("dismissErrorButton").addEventListener("click", clearError);
$("importLayerButton").addEventListener("click", () => { if (!busy && snapshot) $("imageInput").click(); });
$("imageInput").addEventListener("change", () => { importPixelLayer($("imageInput").files[0]); $("imageInput").value = ""; });
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
$("commitAdjustmentButton").addEventListener("click", () => {
  try { commitAdjustment(); } catch (error) { showError("Could not apply adjustment", error); }
});
$("textLayerButton").addEventListener("click", openTextDialog);
$("shapeLayerButton").addEventListener("click", openShapeDialog);
$("adjustmentLayerButton").addEventListener("click", openAdjustmentDialog);
$("smartObjectButton").addEventListener("click", () => $("smartObjectInput").click());
$("smartObjectInput").addEventListener("change", () => { placeSmartObject($("smartObjectInput").files[0]); $("smartObjectInput").value = ""; });
$("smartFilterButton").addEventListener("click", openSmartFilterDialog);
$("commitShapeButton").addEventListener("click", commitShape);
$("commitSmartFilterButton").addEventListener("click", commitSmartFilter);
$("layerTransformButton").addEventListener("click", openLayerTransformDialog);
$("layerWarpButton").addEventListener("click", openLayerWarpDialog);
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
  if (!draft?.layer || !Array.isArray(draft.quad) ||
      draft.quad.some((value) => !Number.isFinite(value))) return;
  const quad = [...draft.quad]; transformDialogDraft = null;
  $("layerTransformDialog").close();
  commitLayerQuad(draft.layer, quad);
});
$("commitLayerWarpButton").addEventListener("click", commitLayerWarp);
for (const id of ["layerWarpStyleInput", "layerWarpBendInput", "layerWarpHorizontalInput",
  "layerWarpVerticalInput", "layerWarpRotateInput"]) $(id).addEventListener("input", scheduleWarpPreview);
$("layerWarpDialog").addEventListener("close", () => {
  if (warpDialogDraft) { warpDialogDraft = null; clearTransformPreview(); }
});
for (const id of ["layerXInput", "layerYInput", "layerWidthInput", "layerHeightInput",
  "layerAngleInput", "layerFlipXInput", "layerFlipYInput", "layerTransformModeInput",
  ...layerCornerInputIds]) $(id).addEventListener("input", updateTransformDialogPreview);
$("layerTransformDialog").addEventListener("close", () => {
  if (transformDialogDraft) { transformDialogDraft = null; clearTransformPreview(true); }
});
for (const handle of $("transformOverlay").querySelectorAll("circle")) {
  handle.addEventListener("pointerdown", (event) => {
    if (!transformDialogDraft || busy || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    transformDraft = { pointerId: event.pointerId,
      index: Number(handle.dataset.transformHandle), layer: transformDialogDraft.layer,
      quad: [...transformDialogDraft.quad] };
  });
  handle.addEventListener("pointermove", (event) => {
    if (transformDraft?.pointerId !== event.pointerId || !transformDialogDraft) return;
    const point = canvasPointUnclamped(event); const index = transformDraft.index;
    if (transformDraft.layer.kind === 3) {
      const opposite = (index + 2) % 4;
      const oppositeX = transformDraft.quad[opposite * 2];
      const oppositeY = transformDraft.quad[opposite * 2 + 1];
      $("layerXInput").value = String(Math.min(point.x, oppositeX));
      $("layerYInput").value = String(Math.min(point.y, oppositeY));
      $("layerWidthInput").value = String(Math.max(.01, Math.abs(point.x - oppositeX)));
      $("layerHeightInput").value = String(Math.max(.01, Math.abs(point.y - oppositeY)));
      $("layerAngleInput").value = "0"; $("layerFlipXInput").checked = false;
      $("layerFlipYInput").checked = false; updateTransformDialogPreview();
      return;
    }
    const quad = [...transformDraft.quad]; quad[index * 2] = point.x; quad[index * 2 + 1] = point.y;
    $("layerTransformModeInput").value = "perspective";
    layerCornerInputIds.forEach((id, coordinate) => { $(id).readOnly = false; $(id).value = quad[coordinate].toFixed(2); });
    transformDialogDraft.quad = quad; renderTransformOverlay(quad);
    scheduleTransformPreview(transformDialogDraft.layer, quad);
  });
  const finishHandle = (event) => {
    if (transformDraft?.pointerId === event.pointerId) transformDraft = null;
  };
  handle.addEventListener("pointerup", finishHandle);
  handle.addEventListener("pointercancel", finishHandle);
}
$("brushSizeInput").addEventListener("input", () => {
  $("brushSizeOutput").textContent = `${$("brushSizeInput").value} px`;
  persistPreferences();
});
$("brushColorInput").addEventListener("input", persistPreferences);
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
  const path = saved?.subpaths?.length ? { subpaths: saved.subpaths } : selectionPath();
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
  if (width != null && height != null) documentMutation("Scaling image", () => client.resizeImage(width, height));
});
$("resizeCanvasButton").addEventListener("click", () => {
  const width = integerInput("documentWidthInput", true);
  const height = integerInput("documentHeightInput", true);
  if (width != null && height != null) documentMutation("Resizing canvas", () => client.resizeCanvas(width, height));
});
$("rotateLeftButton").addEventListener("click", () => documentMutation("Rotating canvas", () => client.rotateCanvas(-90)));
$("rotateRightButton").addEventListener("click", () => documentMutation("Rotating canvas", () => client.rotateCanvas(90)));
$("cropButton").addEventListener("click", () => {
  const x = integerInput("cropXInput");
  const y = integerInput("cropYInput");
  const width = integerInput("cropWidthInput", true);
  const height = integerInput("cropHeightInput", true);
  if ([x, y, width, height].every((value) => value != null)) {
    documentMutation("Cropping document", () => client.cropDocument({ x, y, width, height }));
  }
});
$("layerNameInput").addEventListener("change", () => {
  const layer = selectedLayer();
  const name = $("layerNameInput").value.trim();
  if (layer && name && name !== layer.name) mutate("Renaming layer", () => client.renameLayer(layer.id, name));
  else renderLayerProperties();
});
$("layerOpacityInput").addEventListener("input", () => {
  $("layerOpacityOutput").textContent = `${$("layerOpacityInput").value}%`;
});
$("layerOpacityInput").addEventListener("change", () => {
  const ids = selectedLayerIdsTopToBottom();
  if (ids.length) mutate("Changing opacity", () => client.editLayers(ids, 1,
    { opacity: Number($("layerOpacityInput").value) / 100 }));
});
$("layerFillInput").addEventListener("input", () => {
  $("layerFillOutput").textContent = `${$("layerFillInput").value}%`;
});
$("layerFillInput").addEventListener("change", () => {
  const ids = selectedLayerIdsTopToBottom();
  if (ids.length) mutate("Changing fill opacity", () => client.editLayers(ids, 2,
    { opacity: Number($("layerFillInput").value) / 100 }));
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
$("smoothSelectionButton").addEventListener("click", () => {
  const blurred = boxBlurMask(fullSelectionMask(), snapshot.width, snapshot.height, 4);
  for (let index = 0; index < blurred.length; ++index) blurred[index] = blurred[index] >= 128 ? 255 : 0;
  commitSelectionMask("Smoothing selection", blurred);
});
$("featherSelectionButton").addEventListener("click", () => commitSelectionMask(
  "Feathering selection", boxBlurMask(fullSelectionMask(), snapshot.width, snapshot.height, 4)));
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
  const channel = selectedChannel(); const name = channel && prompt("Channel name", channel.name);
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
  const path = selectedPath(); const name = path && prompt("Path name", path.name);
  if (name?.trim()) mutate("Renaming path", () => client.renamePath(path.id, name.trim()));
});
$("pathClipButton").addEventListener("click", () => {
  const path = selectedPath(); if (path) mutate("Changing clipping path", () => client.setClippingPath(path.id, !path.clipping));
});
$("pathDeleteButton").addEventListener("click", () => {
  const path = selectedPath(); if (path) mutate("Deleting path", () => client.removePath(path.id));
});
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
$("togglePanelsButton").addEventListener("click", () => {
  const hidden = shell.classList.toggle("panels-hidden");
  $("togglePanelsButton").setAttribute("aria-pressed", String(hidden));
  persistPreferences();
});
$("cleanupRecoveryButton").addEventListener("click", cleanupRecoveryWorkspaces);
$("saveGradientAssetButton").addEventListener("click", () => saveFillAsset("gradient")
  .catch((error) => showError("Could not save gradient", error)));
$("savePatternAssetButton").addEventListener("click", () => saveFillAsset("pattern")
  .catch((error) => showError("Could not save pattern", error)));
$("installFontAssetButton").addEventListener("click", () => installFontAsset()
  .catch((error) => showError("Could not install font", error)));

canvas.addEventListener("pointerdown", (event) => {
  if (busy || !snapshot || event.button !== 0) return;
  if (["brush", "eraser", "clone", "heal"].includes(canvasTool)) { beginPaint(event); return; }
  if (canvasTool === "gradient") { beginGradient(event); return; }
  if (canvasTool === "text") { openTextDialog(); return; }
  if (canvasTool === "pen") {
    const point = canvasPoint(event);
    penDraft ??= { points: [], closed: false };
    if (event.detail > 1 && penDraft.points.length >= 3) {
      penDraft.closed = event.shiftKey; commitPenPath();
    } else {
      penDraft.points.push(point); previewPolygon(penDraft.points);
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
    const layer = selectedLayer();
    if (![0, 3].includes(layer?.kind) ||
        (layer?.mask && !(layer.kind === 0 && layer.mask.linked))) return;
    const start = canvasPoint(event);
    canvas.setPointerCapture(event.pointerId);
    moveDraft = { layer, start, quad: quadFromBounds(layer.bounds),
      originalQuad: quadFromBounds(layer.bounds) };
    renderTransformOverlay();
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
    if (selection) mutate("Selecting area", () => client.setSelection([selection]));
  };
  const cancel = () => { marqueeDraft = null; renderSelection(); finish(); };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", cancel);
});

canvas.addEventListener("pointermove", (event) => {
  movePaint(event);
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
  moveDraft.quad = moveDraft.originalQuad.map((coordinate, index) => coordinate + (index % 2 ? dy : dx));
  renderTransformOverlay();
  scheduleTransformPreview(moveDraft.layer, moveDraft.quad);
});
canvas.addEventListener("pointerup", (event) => {
  finishPaint(event);
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
  commitLayerQuad(draft.layer, draft.quad, "Moving layer");
});
canvas.addEventListener("pointercancel", (event) => {
  finishPaint(event, true); gradientDraft = null; clearRasterPreview(); moveDraft = null; lassoDraft = null;
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
  if (canvasTool !== "pan" || event.button !== 0) return;
  const viewport = $("canvasViewport");
  viewport.setPointerCapture(event.pointerId);
  viewport.dataset.panning = "true";
  panStart = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
});
$("canvasViewport").addEventListener("pointermove", (event) => {
  if (!panStart) return;
  const viewport = $("canvasViewport");
  viewport.scrollLeft = panStart.left - (event.clientX - panStart.x);
  viewport.scrollTop = panStart.top - (event.clientY - panStart.y);
});
for (const type of ["pointerup", "pointercancel"]) {
  $("canvasViewport").addEventListener(type, () => {
    panStart = null; delete $("canvasViewport").dataset.panning;
  });
}
$("canvasViewport").addEventListener("wheel", (event) => {
  if (!snapshot || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
}, { passive: false });
window.addEventListener("resize", applyViewport);
$("layerList").addEventListener("scroll", scheduleLayerWindowRender, { passive: true });
window.addEventListener("beforeunload", (event) => {
  if ([...checkpointStates.values()].some((state) => state === "pending")) event.preventDefault();
});

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  const editingField = event.target?.matches?.("input, select, textarea, [contenteditable]");
  if (key === "o") { event.preventDefault(); executeCommand("document.open"); }
  if (key === "s") { event.preventDefault(); executeCommand("document.save"); }
  if (key === "c" && !editingField && snapshot) { event.preventDefault(); executeCommand("document.copyPixels"); }
  if (key === "v" && !editingField && snapshot) { event.preventDefault(); executeCommand("document.pastePixels"); }
  if (key === "z") {
    event.preventDefault();
    const redo = event.shiftKey;
    executeCommand(redo ? "history.redo" : "history.undo");
  }
  if (key === "a") { event.preventDefault(); executeCommand("selection.all"); }
  if (key === "d") { event.preventDefault(); executeCommand("selection.clear"); }
});

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target?.matches?.("input, select, textarea")) return;
  if (event.key.toLowerCase() === "m") executeCommand("tool.marquee");
  if (event.key.toLowerCase() === "l") executeCommand(event.shiftKey ? "tool.magnetic" : "tool.lasso");
  if (event.key.toLowerCase() === "w") executeCommand(event.shiftKey ? "tool.quickSelect" : "tool.magic");
  if (event.key.toLowerCase() === "q") executeCommand("tool.quickMask");
  if (event.key.toLowerCase() === "h") executeCommand("tool.pan");
  if (event.key.toLowerCase() === "v") executeCommand("tool.move");
  if (event.key.toLowerCase() === "b") executeCommand("tool.brush");
  if (event.key.toLowerCase() === "e") executeCommand("tool.eraser");
  if (event.key.toLowerCase() === "t") executeCommand("tool.text");
  if (event.key.toLowerCase() === "p") executeCommand("tool.pen");
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
  if (event.key === "Enter" && penDraft) commitPenPath();
  if (event.key === "Escape" && penDraft) { penDraft = null; previewPolygon([]); }
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
  if (/\.(psd|psb)$/i.test(file.name)) openFile(file);
  else if (file.type.startsWith("image/") || /\.svg$/i.test(file.name)) importPixelLayer(file, !snapshot);
  else showError("Unsupported drop", new Error("Drop a PSD, PSB, PNG, JPEG, WebP, AVIF, or SVG file."));
});

try {
  client = createEngineClient();
  await client.initialize(moduleUrl);
  workspaceAvailable = await workspaceStore.available();
  if (workspaceAvailable) {
    await loadLocalAssets();
    applyPreferences(await workspaceStore.loadPreferences({ tool: "marquee", brushSize: 24,
      color: "#111111", paintPreset: "solid", font: "Arial",
      selectionTolerance: 32, historyBudgetMiB: 256, panelsHidden: false }));
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
