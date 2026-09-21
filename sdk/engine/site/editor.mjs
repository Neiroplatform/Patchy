import { PatchyWorkerClient } from "./engine/client.mjs";
import { recoverWorkerSession } from "./engine/recovery-controller.mjs";
import { PatchyCheckpointQueue, PatchyWorkspaceStore } from "./engine/workspace-store.mjs";
import { browserWorkingSetLimit, chooseRenderRegion, documentPreflight, MIB } from "./engine/memory-policy.mjs";

const $ = (id) => document.getElementById(id);
const shell = document.querySelector(".editor-shell");
const moduleUrl = new URL("./patchy-engine.mjs", location.href).href;
let client = null;
const workspaceStore = new PatchyWorkspaceStore();
const canvas = $("documentCanvas");
const context = canvas.getContext("2d", { alpha: true });
let snapshot = null;
let selectedLayerId = null;
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
let paintDraft = null;
let textEditingId = null;
let cloneSource = null;
let gradientDraft = null;
let lassoDraft = null;
let polygonDraft = null;
let clipboardImageBlob = null;
let workspaceAvailable = false;
let automaticRecoveryEnabled = false;
let recoveryPromise = null;
let preferenceTimer = null;
let renderedDocument = null;
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

function selectedChannel() { return snapshot?.channels.find((item) => item.id === selectedChannelId) || null; }
function selectedPath() { return snapshot?.paths.find((item) => item.id === selectedPathId) || null; }

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
  $("saveButton").disabled = busy || !snapshot;
  $("exportFormatSelect").disabled = busy || !snapshot;
  $("exportButton").disabled = busy || !snapshot;
  $("copyPixelsButton").disabled = busy || !snapshot;
  $("pastePixelsButton").disabled = busy || !snapshot ||
    (!clipboardImageBlob && !navigator.clipboard?.read);
  $("undoButton").disabled = busy || !snapshot?.canUndo;
  $("redoButton").disabled = busy || !snapshot?.canRedo;
  $("openButton").disabled = busy;
  $("newButton").disabled = busy;
  $("recoveryButton").disabled = busy;
  $("memoryBudgetSelect").disabled = busy;
  $("importLayerButton").disabled = busy || !snapshot;
  $("groupLayerButton").disabled = busy || !layer;
  $("ungroupLayerButton").disabled = busy || layer?.kind !== 1;
  $("removeLayerButton").disabled = busy || !layer;
  $("invertLayerButton").disabled = busy || layer?.kind !== 0;
  $("textLayerButton").disabled = busy || !snapshot;
  $("textLayerButton").textContent = layer?.kind === 3 ? "Edit text" : "Add text";
  $("layerTransformButton").disabled = busy || ![0, 3].includes(layer?.kind) ||
    Boolean(layer?.mask && !(layer.kind === 0 && layer.mask.linked));
  $("shapeLayerButton").disabled = busy || !snapshot;
  $("adjustmentLayerButton").disabled = busy || !snapshot;
  $("smartObjectButton").disabled = busy || !snapshot;
  $("smartObjectButton").textContent = layer?.kind === 5 ? "Replace Smart Object" : "Place Smart Object";
  $("smartFilterButton").disabled = busy || layer?.kind !== 5 || !layer?.smartObject?.editable;
  $("createVectorMaskButton").disabled = busy || !layer || layer.kind === 1 || layer.kind === 4 || !snapshot?.selection?.length;
  $("createMaskButton").disabled = busy || layer?.kind !== 0 || Boolean(layer?.mask);
  $("toggleMaskButton").disabled = busy || !layer?.mask;
  $("toggleMaskButton").textContent = layer?.mask?.disabled ? "Enable mask" : "Disable mask";
  $("invertMaskButton").disabled = busy || !layer?.mask;
  $("removeMaskButton").disabled = busy || !layer?.mask;
  $("transformButton").disabled = busy || !snapshot;
  $("selectAllButton").disabled = busy || !snapshot;
  $("clearSelectionButton").disabled = busy || !snapshot?.selection?.length;
  $("layerNameInput").disabled = busy || !layer;
  $("layerOpacityInput").disabled = busy || !layer;
  $("layerFillInput").disabled = busy || !layer;
  $("layerBlendSelect").disabled = busy || !layer;
  $("layerClipInput").disabled = busy || !layer;
  $("layerLockInput").disabled = busy || !layer;
  $("layerStyleSelect").disabled = busy || !layer;
  $("applyLayerStyleButton").disabled = busy || !layer;
  for (const id of ["invertSelectionButton", "expandSelectionButton", "contractSelectionButton",
    "borderSelectionButton", "growSelectionButton", "similarSelectionButton",
    "smoothSelectionButton", "featherSelectionButton", "saveChannelButton", "savePathButton"]) {
    $(id).disabled = busy || !snapshot?.selection?.length;
  }
  $("rasterizeLayerButton").disabled = busy || ![3, 4, 5].includes(layer?.kind);
  $("mergeVisibleButton").disabled = busy || !snapshot?.layers?.length;
  for (const id of ["channelRenameButton", "channelInvertButton", "channelUpButton",
    "channelDownButton", "channelDeleteButton"]) $(id).disabled = busy || !selectedChannel();
  for (const id of ["pathRenameButton", "pathClipButton", "pathUpButton", "pathDownButton",
    "pathDeleteButton", "pathAnchorApplyButton"]) $(id).disabled = busy || !selectedPath();
  $("pathAnchorXInput").disabled = busy || !selectedPath()?.anchors?.length;
  $("pathAnchorYInput").disabled = busy || !selectedPath()?.anchors?.length;
  syncCommands();
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
  clearError();
  setBusy(true, "Inverting pixels", "Filtering selected layer locally");
  $("busyProgress").hidden = false;
  $("cancelOperationButton").hidden = false;
  $("cancelOperationButton").disabled = false;
  const operation = client.invertLayer(layer.id, (progress) => {
    $("busyProgress").value = progress.ratio;
    $("busyDetail").textContent = `Filtering selected layer · ${Math.round(progress.ratio * 100)}%`;
  });
  cancelActiveOperation = operation.cancel;
  try {
    const next = await operation.promise;
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  } catch (error) {
    if (error?.code !== 7) showError("Could not invert layer", error);
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
      for (const item of result.restored) {
        workspaceIds.set(item.documentId, item.workspaceId);
        checkpointStates.set(item.documentId, "confirmed");
      }
      selectedLayerId = null; selectedChannelId = null; selectedPathId = null;
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
      save: (checkpoint) => client.saveDocument(checkpoint.documentId),
      write: (checkpoint, bytes) => workspaceStore.checkpoint({ id: workspaceId,
        name: checkpoint.documentName, revision: checkpoint.revision,
        dirty: checkpoint.dirty, bytes }),
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
  return queue.schedule(next);
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
    const next = await client.open(recovered.bytes, recovered.manifest.name);
    workspaceIds.set(next.documentId, id);
    checkpointStates.set(next.documentId, "confirmed");
    selectedLayerId = null; selectedChannelId = null; selectedPathId = null;
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

function renderLayers() {
  const list = $("layerList");
  list.replaceChildren();
  const layers = snapshot ? [...snapshot.layers].reverse() : [];
  $("layerCount").textContent = String(layers.length);
  $("layersEmpty").hidden = layers.length > 0;
  $("layersEmpty").textContent = snapshot ? "This document has no layers." : "Open a document to inspect its layers.";
  for (const [index, layer] of layers.entries()) {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.setAttribute("role", "listitem");
    row.dataset.active = String(selectedLayerId === layer.id);
    row.innerHTML = `
      <button class="visibility-button" type="button" aria-label="${layer.visible ? "Hide" : "Show"} ${escapeHtml(layer.name)}">${layer.visible ? "◉" : "○"}</button>
      <span class="layer-thumb" aria-hidden="true"></span>
      <button class="layer-copy layer-select-button" type="button"><span class="layer-name"></span><span class="layer-kind"></span></button>
      <button class="reorder-button" type="button" aria-label="Move layer up" ${index === 0 ? "disabled" : ""}>↑</button>
      <button class="reorder-button" type="button" aria-label="Move layer down" ${index === layers.length - 1 ? "disabled" : ""}>↓</button>`;
    row.querySelector(".layer-name").textContent = layer.name || "Unnamed layer";
    row.querySelector(".layer-kind").textContent = `${formatKind(layer)}${layer.mask ? ` · Mask${layer.mask.disabled ? " off" : ""}` : ""}${layer.adjustment ? ` · ${adjustmentName(layer.adjustment.kind)}` : ""}${layer.smartObject ? ` · ${layer.smartObject.filename}` : ""}`;
    row.querySelector(".layer-select-button").setAttribute("aria-label", `Select ${layer.name || "unnamed layer"}`);
    row.querySelector(".layer-select-button").addEventListener("click", () => {
      selectedLayerId = layer.id;
      renderLayers();
      renderLayerProperties();
    });
    row.querySelector(".visibility-button").addEventListener("click", () =>
      mutate("Updating layer", async () => client.setLayerVisibility(layer.id, !layer.visible)));
    const reorder = async (direction) => {
      const target = layers[index + direction];
      if (!target) return;
      const position = direction < 0 ? 1 : 2;
      await mutate("Moving layer", () => client.moveLayer(layer.id, target.id, position));
    };
    row.querySelectorAll(".reorder-button")[0].addEventListener("click", () => reorder(-1));
    row.querySelectorAll(".reorder-button")[1].addEventListener("click", () => reorder(1));
    list.append(row);
  }
}

function renderLayerProperties() {
  const layer = selectedLayer();
  $("layerNameInput").value = layer?.name || "";
  $("layerOpacityInput").value = layer ? String(Math.round(layer.opacity * 100)) : "100";
  $("layerOpacityOutput").textContent = `${$("layerOpacityInput").value}%`;
  $("layerFillInput").value = layer ? String(Math.round(layer.fillOpacity * 100)) : "100";
  $("layerFillOutput").textContent = `${$("layerFillInput").value}%`;
  $("layerClipInput").checked = Boolean(layer?.clipped);
  $("layerLockInput").checked = Boolean(layer?.lockFlags);
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
    ? `${formatBytes(memory.totalRetainedBytes)} retained · ${formatBytes(memory.historyRetainedBytes)} history · ${formatBytes(memory.renderCacheBytes)} cache`
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
  const bytes = await client.render(region);
  const expected = region.width * region.height * 4;
  if (bytes.byteLength !== expected) throw new Error(`Engine returned ${bytes.byteLength} RGBA bytes, expected ${expected}`);
  if (canvas.width !== snapshot.width || canvas.height !== snapshot.height ||
      renderedDocument?.documentId !== snapshot.documentId) {
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    $("gestureCanvas").width = snapshot.width;
    $("gestureCanvas").height = snapshot.height;
  }
  const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  context.putImageData(new ImageData(pixels, region.width, region.height), region.x, region.y);
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

function setCanvasTool(tool) {
  canvasTool = tool;
  $("canvasViewport").dataset.tool = tool;
  for (const [id, value] of [["moveToolButton", "move"], ["marqueeToolButton", "marquee"],
    ["lassoToolButton", "lasso"], ["polygonToolButton", "polygon"], ["magicToolButton", "magic"],
    ["panToolButton", "pan"], ["brushToolButton", "brush"],
    ["eraserToolButton", "eraser"], ["cloneToolButton", "clone"],
    ["healToolButton", "heal"], ["gradientToolButton", "gradient"],
    ["textToolButton", "text"]]) {
    $(id).setAttribute("aria-pressed", String(tool === value));
  }
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
    { x: 0, y: 0, width: snapshot.width, height: snapshot.height }, gray));
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

function renderTransformOverlay(bounds = moveDraft?.bounds) {
  const overlay = $("transformOverlay");
  if (!snapshot || !bounds) { overlay.hidden = true; return; }
  overlay.style.left = `${bounds.x / snapshot.width * 100}%`;
  overlay.style.top = `${bounds.y / snapshot.height * 100}%`;
  overlay.style.width = `${bounds.width / snapshot.width * 100}%`;
  overlay.style.height = `${bounds.height / snapshot.height * 100}%`;
  overlay.hidden = false;
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

async function acceptSnapshot(next, rerender = true) {
  if (!next) {
    snapshot = null; selectedLayerId = null; selectedChannelId = null; selectedPathId = null;
    renderedDocument = null;
    $("emptyState").hidden = false; setSessionState("ready", "Engine ready");
    renderLayers(); renderLayerProperties(); renderStructure(); renderMetadata(); renderDocumentTabs();
    renderRecoveryStatus();
    return;
  }
  snapshot = next;
  documentName = snapshot.documentName || documentName;
  if (selectedLayerId == null || !snapshot.layers.some((layer) => layer.id === selectedLayerId)) {
    selectedLayerId = snapshot.activeLayerId || snapshot.layers.at(-1)?.id || null;
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
  renderRecoveryStatus(snapshot.documentId);
  if (rerender) await renderDocument();
}

async function activateDocumentTab(documentId) {
  if (busy || snapshot?.documentId === documentId) return;
  clearError(); setBusy(true, "Switching document", "Activating its canonical Worker session");
  try {
    const next = await client.activateDocument(documentId);
    selectedLayerId = null; selectedChannelId = null; selectedPathId = null;
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
      selectedLayerId = null; selectedChannelId = null; selectedPathId = null;
    }
    await checkpointQueues.get(documentTab.id)?.whenIdle();
    const next = await client.closeDocument(documentTab.id);
    workspaceIds.delete(documentTab.id); checkpointStates.delete(documentTab.id);
    checkpointQueues.delete(documentTab.id);
    await acceptSnapshot(next);
  } catch (error) { showError("Could not close document", error); }
  finally { setBusy(false); }
}

async function mutate(title, operation) {
  if (busy || !snapshot) return;
  clearError();
  setBusy(true, title, "Committing one canonical engine revision");
  try {
    const next = await operation();
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  }
  catch (error) { showError(`${title} failed`, error); }
  finally { setBusy(false); }
}

async function openFile(file) {
  if (!file || busy) return;
  clearError();
  setBusy(true, "Opening document", "Transferring bytes to the isolated Worker");
  try {
    ensureMemorySafe({ sourceBytes: file.size }, file.name || "Document");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const next = await client.open(bytes, file.name || "Document.psd");
    selectedLayerId = null; selectedChannelId = null; selectedPathId = null;
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
    selectedLayerId = null; selectedChannelId = null; selectedPathId = null;
    await acceptSnapshot(next);
    scheduleCheckpoint(next);
  } catch (error) { showError("Could not create document", error); }
  finally { setBusy(false); }
}

async function saveDocument() {
  if (busy || !snapshot) return;
  clearError();
  setBusy(true, "Encoding PSD", "Preparing a local browser download");
  try {
    const bytes = await client.save();
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = documentName.toLowerCase().endsWith(".psd") ? documentName : `${documentName}.psd`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) { showError("Could not encode PSD", error); }
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
    (blob) => blob ? resolve(blob) : reject(new Error(`Browser could not encode ${type}`)), type, quality));
}

function exportBaseName() {
  return (documentName.replace(/\.[^.]+$/, "") || "Patchy export").replace(/[\\/:*?"<>|]/g, "-");
}

async function exportDocument() {
  if (busy || !snapshot) return;
  clearError(); setBusy(true, "Exporting document", "Encoding the rendered composite locally");
  try {
    const format = $("exportFormatSelect").value;
    if (format === "svg") {
      const dataUrl = canvas.toDataURL("image/png");
      const svgNamespace = "http" + "://www.w3.org/2000/svg";
      const svg = `<svg xmlns="${svgNamespace}" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><title>${escapeHtml(exportBaseName())}</title><image width="100%" height="100%" href="${dataUrl}"/></svg>`;
      downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${exportBaseName()}.svg`);
    } else {
      const type = `image/${format}`;
      const blob = await canvasBlob(canvas, type, format === "jpeg" ? .92 : undefined);
      downloadBlob(blob, `${exportBaseName()}.${format === "jpeg" ? "jpg" : format}`);
    }
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
    const next = await client.addPixelLayer({
      name, width: image.width, height: image.height,
      bounds: { x: 0, y: 0, width: image.width, height: image.height }, rgba,
    });
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
  return ["Levels", "Curves", "Hue/Saturation", "Color Balance", "Invert",
    "Posterize", "Threshold", "Brightness/Contrast"][kind] || "Adjustment";
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
  const input = { name: layer?.name || "Shape", path: rectanglePath(bounds),
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
  $("adjustmentValueOne").value = String(layer?.adjustment?.values?.[0] ?? 0);
  $("adjustmentValueTwo").value = String(layer?.adjustment?.values?.[1] ?? 0);
  $("adjustmentDialog").showModal();
}

function commitAdjustment() {
  const kind = Number($("adjustmentKindInput").value);
  const first = Number($("adjustmentValueOne").value);
  const second = Number($("adjustmentValueTwo").value);
  if (![kind, first, second].every(Number.isInteger)) return;
  const defaults = kind === 0 ? [first, second || 255, 100, 0, 255] : kind === 5 ? [Math.max(2, first || 4)]
    : kind === 6 ? [Math.max(0, first || 128)] : [first, second];
  const input = { name: adjustmentName(kind), kind, values: defaults,
    curvePoints: kind === 1 ? [{ input: 0, output: 0 }, { input: 255, output: 255 }] : [] };
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
    await acceptSnapshot(await (layer?.kind === 5
      ? client.replaceSmartObject(layer.id, input) : client.addSmartObject(input)));
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

function textLayerPayload(style, bounds, name) {
  const byteLength = bounds.width * bounds.height * 4;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 512 * 1024 * 1024) {
    throw new RangeError("Text raster exceeds the 512 MB browser editing limit");
  }
  const scratch = document.createElement("canvas");
  scratch.width = bounds.width;
  scratch.height = bounds.height;
  const scratchContext = scratch.getContext("2d", { alpha: true, willReadFrequently: true });
  scratchContext.clearRect(0, 0, bounds.width, bounds.height);
  scratchContext.fillStyle = `rgb(${style.color.join(" ")})`;
  scratchContext.textBaseline = "top";
  scratchContext.font = `${style.italic ? "italic " : ""}${style.bold ? "700 " : ""}${style.sizePixels}px ${style.font}`;
  const lineHeight = style.sizePixels * 1.2;
  String(style.value).split(/\r?\n/).forEach((line, index) =>
    scratchContext.fillText(line || " ", 0, index * lineHeight, bounds.width));
  return { name, text: style.value, font: style.font, sizePixels: style.sizePixels,
    color: style.color, bold: style.bold, italic: style.italic, boxText: true,
    width: bounds.width, height: bounds.height, bounds,
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
  for (const [id, value] of [["textXInput", bounds.x], ["textYInput", bounds.y],
    ["textWidthInput", bounds.width], ["textHeightInput", bounds.height]]) $(id).value = String(value);
  $("textDialog").showModal();
}

async function commitTextDialog() {
  const x = integerInput("textXInput"); const y = integerInput("textYInput");
  const width = integerInput("textWidthInput", true); const height = integerInput("textHeightInput", true);
  const sizePixels = Number($("textSizeInput").value);
  const value = $("textValueInput").value; const font = $("textFontInput").value.trim();
  if ([x, y, width, height].some((item) => item == null) || !value || !font ||
      !Number.isFinite(sizePixels) || sizePixels <= 0) return;
  const layer = selectedLayer();
  let payload;
  try {
    payload = textLayerPayload({ value, font, sizePixels,
      color: colorBytes($("textColorInput").value), bold: $("textBoldInput").checked,
      italic: $("textItalicInput").checked }, { x, y, width, height },
      textEditingId ? layer?.name || "Text" : value.split(/\s+/)[0] || "Text");
  } catch (error) { showError("Could not prepare text", error); return; }
  $("textDialog").close();
  const editing = textEditingId; textEditingId = null;
  await mutate(editing ? "Updating text" : "Creating text", () => editing
    ? client.updateTextLayer(editing, payload) : client.addTextLayer(payload));
}

function openLayerTransformDialog() {
  const layer = selectedLayer();
  if (busy || ![0, 3].includes(layer?.kind) ||
      (layer?.mask && !(layer.kind === 0 && layer.mask.linked))) return;
  for (const [id, value] of [["layerXInput", layer.bounds.x], ["layerYInput", layer.bounds.y],
    ["layerWidthInput", layer.bounds.width], ["layerHeightInput", layer.bounds.height]]) $(id).value = String(value);
  $("layerTransformDialog").showModal();
}

async function transformedLayerSnapshot(layer, bounds) {
  const byteLength = bounds.width * bounds.height * 4;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 512 * 1024 * 1024) {
    throw new RangeError("Transformed layer exceeds the 512 MB browser editing limit");
  }
  if (layer.kind === 3) {
    return client.updateTextLayer(layer.id,
      textLayerPayload(layer.text, bounds, layer.name));
  }
  const sourceBytes = await client.layerPixels(layer.id);
  const source = document.createElement("canvas");
  source.width = layer.bounds.width; source.height = layer.bounds.height;
  source.getContext("2d").putImageData(new ImageData(
    new Uint8ClampedArray(sourceBytes.buffer, sourceBytes.byteOffset, sourceBytes.byteLength),
    source.width, source.height), 0, 0);
  const target = document.createElement("canvas");
  target.width = bounds.width; target.height = bounds.height;
  const targetContext = target.getContext("2d", { alpha: true, willReadFrequently: true });
  targetContext.drawImage(source, 0, 0, bounds.width, bounds.height);
  const rgba = new Uint8Array(targetContext.getImageData(0, 0, bounds.width, bounds.height).data);
  const layerInput = { name: layer.name, width: bounds.width, height: bounds.height, bounds, rgba };
  if (!layer.mask?.linked) return client.replacePixelLayer(layer.id, layerInput);
  const maskBytes = await client.layerMaskPixels(layer.id);
  const oldMask = document.createElement("canvas");
  oldMask.width = layer.mask.bounds.width; oldMask.height = layer.mask.bounds.height;
  const oldMaskContext = oldMask.getContext("2d");
  const grayRgba = new Uint8ClampedArray(maskBytes.byteLength * 4);
  maskBytes.forEach((value, index) => grayRgba.set([value, value, value, 255], index * 4));
  oldMaskContext.putImageData(new ImageData(grayRgba, oldMask.width, oldMask.height), 0, 0);
  const scaleX = bounds.width / layer.bounds.width; const scaleY = bounds.height / layer.bounds.height;
  const maskBounds = { x: Math.round(bounds.x + (layer.mask.bounds.x - layer.bounds.x) * scaleX),
    y: Math.round(bounds.y + (layer.mask.bounds.y - layer.bounds.y) * scaleY),
    width: Math.max(1, Math.round(layer.mask.bounds.width * scaleX)),
    height: Math.max(1, Math.round(layer.mask.bounds.height * scaleY)) };
  const nextMask = document.createElement("canvas"); nextMask.width = maskBounds.width; nextMask.height = maskBounds.height;
  const nextMaskContext = nextMask.getContext("2d", { willReadFrequently: true });
  nextMaskContext.drawImage(oldMask, 0, 0, maskBounds.width, maskBounds.height);
  const maskPixels = nextMaskContext.getImageData(0, 0, maskBounds.width, maskBounds.height).data;
  const gray = new Uint8Array(maskBounds.width * maskBounds.height);
  for (let index = 0; index < gray.length; ++index) gray[index] = maskPixels[index * 4];
  return client.replacePixelLayerAndMask(layer.id, layerInput, { width: maskBounds.width,
    height: maskBounds.height, bounds: maskBounds, gray, defaultColor: layer.mask.defaultColor,
    disabled: layer.mask.disabled });
}

function commitLayerBounds(layer, bounds, title = "Transforming layer") {
  return mutate(title, () => transformedLayerSnapshot(layer, bounds));
}

function drawPaintSegment(draft, from, to) {
  const size = Number($("brushSizeInput").value);
  const erase = draft.tool === "eraser";
  const localFrom = { x: from.x - draft.layer.bounds.x, y: from.y - draft.layer.bounds.y };
  const localTo = { x: to.x - draft.layer.bounds.x, y: to.y - draft.layer.bounds.y };
  const paint = (target, a, b, color, composite) => {
    target.save(); target.lineCap = "round"; target.lineJoin = "round";
    target.lineWidth = size; target.globalCompositeOperation = composite;
    target.strokeStyle = color; target.beginPath(); target.moveTo(a.x, a.y); target.lineTo(b.x, b.y); target.stroke();
    target.beginPath(); target.arc(b.x, b.y, size / 2, 0, Math.PI * 2); target.fillStyle = color; target.fill(); target.restore();
  };
  if (draft.tool === "clone" || draft.tool === "heal") {
    const offset = { x: draft.source.x - draft.start.x, y: draft.source.y - draft.start.y };
    const sample = { x: to.x + offset.x - draft.layer.bounds.x,
      y: to.y + offset.y - draft.layer.bounds.y };
    draft.context.save();
    draft.context.beginPath(); draft.context.arc(localTo.x, localTo.y, size / 2, 0, Math.PI * 2);
    draft.context.clip(); draft.context.globalAlpha = draft.tool === "heal" ? .65 : 1;
    draft.context.drawImage(draft.original, sample.x - size / 2, sample.y - size / 2, size, size,
      localTo.x - size / 2, localTo.y - size / 2, size, size);
    draft.context.restore();
  } else {
    paint(draft.context, localFrom, localTo, $("brushColorInput").value,
      erase ? "destination-out" : "source-over");
  }
  paint(draft.overlay, from, to, erase ? "#ffffff88" : $("brushColorInput").value,
    "source-over");
}

async function beginPaint(event) {
  const layer = selectedLayer();
  if (busy || layer?.kind !== 0 || event.button !== 0) return;
  const point = canvasPoint(event);
  if ((canvasTool === "clone" || canvasTool === "heal") && event.altKey) {
    cloneSource = point; setSessionState("document", "Clone source set"); return;
  }
  if ((canvasTool === "clone" || canvasTool === "heal") && !cloneSource) {
    showError("Set a source first", new Error("Alt-click the canvas to choose a clone/heal source.")); return;
  }
  canvas.setPointerCapture(event.pointerId);
  const draft = { pointerId: event.pointerId, tool: canvasTool, layer, last: point,
    start: point, source: cloneSource, ready: false };
  paintDraft = draft;
  try {
    const bytes = await client.layerPixels(layer.id);
    if (paintDraft !== draft) return;
    const scratch = document.createElement("canvas");
    scratch.width = layer.bounds.width; scratch.height = layer.bounds.height;
    draft.context = scratch.getContext("2d", { alpha: true, willReadFrequently: true });
    draft.context.putImageData(new ImageData(
      new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      scratch.width, scratch.height), 0, 0);
    draft.original = document.createElement("canvas");
    draft.original.width = scratch.width; draft.original.height = scratch.height;
    draft.original.getContext("2d").drawImage(scratch, 0, 0);
    draft.overlay = $("gestureCanvas").getContext("2d");
    draft.ready = true;
    drawPaintSegment(draft, point, point);
  } catch (error) { paintDraft = null; showError("Could not start painting", error); }
}

async function fillSelectedPixels() {
  const layer = selectedLayer();
  if (busy || layer?.kind !== 0) return;
  await mutate("Filling pixels", async () => {
    const bytes = await client.layerPixels(layer.id);
    const scratch = document.createElement("canvas"); scratch.width = layer.bounds.width; scratch.height = layer.bounds.height;
    const target = scratch.getContext("2d", { alpha: true, willReadFrequently: true });
    target.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      scratch.width, scratch.height), 0, 0);
    target.fillStyle = paintStyle(target, $("paintPresetSelect").value,
      { x: 0, y: 0 }, { x: scratch.width, y: 0 });
    const rects = snapshot.selection?.length ? snapshot.selection : [layer.bounds];
    for (const rect of rects) target.fillRect(rect.x - layer.bounds.x, rect.y - layer.bounds.y, rect.width, rect.height);
    const rgba = new Uint8Array(target.getImageData(0, 0, scratch.width, scratch.height).data);
    return client.replacePixelLayer(layer.id, { name: layer.name, width: scratch.width,
      height: scratch.height, bounds: layer.bounds, rgba });
  });
}

function paintStyle(target, preset, start, end) {
  if (preset === "solid") return $("brushColorInput").value;
  if (preset === "checker" || preset === "dots") {
    const tile = document.createElement("canvas"); tile.width = 16; tile.height = 16;
    const tileContext = tile.getContext("2d");
    if (preset === "checker") {
      tileContext.fillStyle = "#f1f3f5"; tileContext.fillRect(0, 0, 16, 16);
      tileContext.fillStyle = $("brushColorInput").value;
      tileContext.fillRect(0, 0, 8, 8); tileContext.fillRect(8, 8, 8, 8);
    } else {
      tileContext.fillStyle = "transparent"; tileContext.clearRect(0, 0, 16, 16);
      tileContext.fillStyle = $("brushColorInput").value;
      tileContext.beginPath(); tileContext.arc(4, 4, 3, 0, Math.PI * 2); tileContext.fill();
      tileContext.beginPath(); tileContext.arc(12, 12, 3, 0, Math.PI * 2); tileContext.fill();
    }
    return target.createPattern(tile, "repeat");
  }
  const gradient = target.createLinearGradient(start.x, start.y,
    end.x === start.x && end.y === start.y ? end.x + 1 : end.x, end.y);
  const stops = preset === "black-white" ? [[0, "#000000"], [1, "#ffffff"]]
    : preset === "sunset" ? [[0, "#ff3d77"], [.48, "#ff9a3d"], [1, "#ffe66d"]]
    : preset === "ocean" ? [[0, "#082f49"], [.5, "#0284c7"], [1, "#67e8f9"]]
    : [[0, $("brushColorInput").value], [1, "transparent"]];
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  return gradient;
}

async function beginGradient(event) {
  const layer = selectedLayer();
  if (busy || layer?.kind !== 0 || event.button !== 0) return;
  const start = canvasPoint(event); canvas.setPointerCapture(event.pointerId);
  gradientDraft = { pointerId: event.pointerId, layer, start, end: start };
}

async function finishGradient(event) {
  const draft = gradientDraft;
  if (!draft || event.pointerId !== draft.pointerId) return;
  gradientDraft = null;
  await mutate("Applying gradient", async () => {
    const bytes = await client.layerPixels(draft.layer.id);
    const scratch = document.createElement("canvas"); scratch.width = draft.layer.bounds.width; scratch.height = draft.layer.bounds.height;
    const target = scratch.getContext("2d", { alpha: true, willReadFrequently: true });
    target.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      scratch.width, scratch.height), 0, 0);
    const local = (point) => ({ x: point.x - draft.layer.bounds.x, y: point.y - draft.layer.bounds.y });
    const start = local(draft.start); const end = local(draft.end);
    target.fillStyle = paintStyle(target, $("paintPresetSelect").value, start, end);
    const rects = snapshot.selection?.length ? snapshot.selection : [draft.layer.bounds];
    for (const rect of rects) target.fillRect(rect.x - draft.layer.bounds.x, rect.y - draft.layer.bounds.y, rect.width, rect.height);
    const rgba = new Uint8Array(target.getImageData(0, 0, scratch.width, scratch.height).data);
    return client.replacePixelLayer(draft.layer.id, { name: draft.layer.name, width: scratch.width,
      height: scratch.height, bounds: draft.layer.bounds, rgba });
  });
}

function movePaint(event) {
  if (!paintDraft?.ready || event.pointerId !== paintDraft.pointerId) return;
  const point = canvasPoint(event); drawPaintSegment(paintDraft, paintDraft.last, point); paintDraft.last = point;
}

function finishPaint(event, cancelled = false) {
  const draft = paintDraft;
  if (!draft || event.pointerId !== draft.pointerId) return;
  paintDraft = null;
  $("gestureCanvas").getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  if (cancelled || !draft.ready) return;
  const rgba = new Uint8Array(draft.context.getImageData(
    0, 0, draft.layer.bounds.width, draft.layer.bounds.height).data);
  mutate(draft.tool === "eraser" ? "Erasing pixels" : "Painting pixels", () =>
    client.replacePixelLayer(draft.layer.id, { name: draft.layer.name,
      width: draft.layer.bounds.width, height: draft.layer.bounds.height,
      bounds: draft.layer.bounds, rgba }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function openPicker() { if (!busy) $("fileInput").click(); }
registerCommand("document.open", "openButton", openPicker, () => !busy);
registerCommand("document.new", "newButton", newDocument, () => !busy);
registerCommand("document.recovery", "recoveryButton", openRecoveryDialog, () => !busy);
registerCommand("document.save", "saveButton", saveDocument, () => !busy && Boolean(snapshot));
registerCommand("document.export", "exportButton", exportDocument, () => !busy && Boolean(snapshot));
registerCommand("document.copyPixels", "copyPixelsButton", copyRenderedPixels, () => !busy && Boolean(snapshot));
registerCommand("document.pastePixels", "pastePixelsButton", pastePixels, () => !busy && Boolean(snapshot) &&
  Boolean(clipboardImageBlob || navigator.clipboard?.read));
registerCommand("history.undo", "undoButton", () => mutate("Undo", () => client.undo()), () => !busy && Boolean(snapshot?.canUndo));
registerCommand("history.redo", "redoButton", () => mutate("Redo", () => client.redo()), () => !busy && Boolean(snapshot?.canRedo));
registerCommand("document.canvas", "transformButton", openDocumentDialog, () => !busy && Boolean(snapshot));
registerCommand("tool.move", "moveToolButton", () => setCanvasTool("move"));
registerCommand("tool.marquee", "marqueeToolButton", () => setCanvasTool("marquee"));
registerCommand("tool.lasso", "lassoToolButton", () => setCanvasTool("lasso"));
registerCommand("tool.polygon", "polygonToolButton", () => setCanvasTool("polygon"));
registerCommand("tool.magic", "magicToolButton", () => setCanvasTool("magic"));
registerCommand("tool.pan", "panToolButton", () => setCanvasTool("pan"));
registerCommand("tool.brush", "brushToolButton", () => setCanvasTool("brush"));
registerCommand("tool.eraser", "eraserToolButton", () => setCanvasTool("eraser"));
registerCommand("tool.clone", "cloneToolButton", () => setCanvasTool("clone"));
registerCommand("tool.heal", "healToolButton", () => setCanvasTool("heal"));
registerCommand("tool.gradient", "gradientToolButton", () => setCanvasTool("gradient"));
registerCommand("tool.fill", "fillToolButton", fillSelectedPixels, () => !busy && selectedLayer()?.kind === 0);
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
$("fileInput").addEventListener("change", () => { openFile($("fileInput").files[0]); $("fileInput").value = ""; });
$("dismissErrorButton").addEventListener("click", clearError);
$("importLayerButton").addEventListener("click", () => { if (!busy && snapshot) $("imageInput").click(); });
$("imageInput").addEventListener("change", () => { importPixelLayer($("imageInput").files[0]); $("imageInput").value = ""; });
$("removeLayerButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer) mutate("Deleting layer", () => client.removeLayer(layer.id));
});
$("groupLayerButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer) mutate("Grouping layer", () => client.groupLayer(layer.id, "Group"));
});
$("ungroupLayerButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer?.kind === 1) mutate("Ungrouping layers", () => client.ungroup(layer.id));
});
$("invertLayerButton").addEventListener("click", invertSelectedLayer);
$("textLayerButton").addEventListener("click", openTextDialog);
$("shapeLayerButton").addEventListener("click", openShapeDialog);
$("adjustmentLayerButton").addEventListener("click", openAdjustmentDialog);
$("smartObjectButton").addEventListener("click", () => $("smartObjectInput").click());
$("smartObjectInput").addEventListener("change", () => { placeSmartObject($("smartObjectInput").files[0]); $("smartObjectInput").value = ""; });
$("smartFilterButton").addEventListener("click", openSmartFilterDialog);
$("commitShapeButton").addEventListener("click", commitShape);
$("commitAdjustmentButton").addEventListener("click", commitAdjustment);
$("commitSmartFilterButton").addEventListener("click", commitSmartFilter);
$("layerTransformButton").addEventListener("click", openLayerTransformDialog);
$("commitTextButton").addEventListener("click", commitTextDialog);
$("commitLayerTransformButton").addEventListener("click", () => {
  const layer = selectedLayer();
  const x = integerInput("layerXInput"); const y = integerInput("layerYInput");
  const width = integerInput("layerWidthInput", true); const height = integerInput("layerHeightInput", true);
  if (!layer || [x, y, width, height].some((value) => value == null)) return;
  $("layerTransformDialog").close();
  commitLayerBounds(layer, { x, y, width, height });
});
$("brushSizeInput").addEventListener("input", () => {
  $("brushSizeOutput").textContent = `${$("brushSizeInput").value} px`;
  persistPreferences();
});
$("brushColorInput").addEventListener("input", persistPreferences);
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
$("invertMaskButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer?.mask) mutate("Inverting layer mask", () => client.invertLayerMask(layer.id));
});
$("removeMaskButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer?.mask) mutate("Removing layer mask", () => client.removeLayerMask(layer.id));
});
$("createVectorMaskButton").addEventListener("click", () => {
  const layer = selectedLayer(); const path = selectionPath();
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
  const layer = selectedLayer();
  if (layer) mutate("Changing opacity", () => client.setLayerOpacity(layer.id, Number($("layerOpacityInput").value) / 100));
});
$("layerFillInput").addEventListener("input", () => {
  $("layerFillOutput").textContent = `${$("layerFillInput").value}%`;
});
$("layerFillInput").addEventListener("change", () => {
  const layer = selectedLayer();
  if (layer) mutate("Changing fill opacity", () => client.setLayerFillOpacity(layer.id,
    Number($("layerFillInput").value) / 100));
});
$("layerClipInput").addEventListener("change", () => {
  const layer = selectedLayer();
  if (layer) mutate("Changing clipping", () => client.setLayerClipping(layer.id, $("layerClipInput").checked));
});
$("layerLockInput").addEventListener("change", () => {
  const layer = selectedLayer();
  if (layer) mutate("Changing layer lock", () => client.setLayerLocks(layer.id,
    $("layerLockInput").checked ? 7 : 0));
});
$("applyLayerStyleButton").addEventListener("click", () => {
  const layer = selectedLayer();
  if (layer) mutate("Applying layer style", () =>
    client.setLayerStylePreset(layer.id, $("layerStyleSelect").value));
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
  const layer = selectedLayer();
  if (layer) mutate("Changing blend mode", () => client.setLayerBlendMode(layer.id, Number($("layerBlendSelect").value)));
});
$("togglePanelsButton").addEventListener("click", () => {
  const hidden = shell.classList.toggle("panels-hidden");
  $("togglePanelsButton").setAttribute("aria-pressed", String(hidden));
  persistPreferences();
});
$("cleanupRecoveryButton").addEventListener("click", cleanupRecoveryWorkspaces);

canvas.addEventListener("pointerdown", (event) => {
  if (busy || !snapshot || event.button !== 0) return;
  if (["brush", "eraser", "clone", "heal"].includes(canvasTool)) { beginPaint(event); return; }
  if (canvasTool === "gradient") { beginGradient(event); return; }
  if (canvasTool === "text") { openTextDialog(); return; }
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
    moveDraft = { layer, start, bounds: { ...layer.bounds } };
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
  if (gradientDraft?.pointerId === event.pointerId) gradientDraft.end = canvasPoint(event);
  if (!moveDraft) return;
  const point = canvasPoint(event);
  moveDraft.bounds = { ...moveDraft.layer.bounds,
    x: Math.round(moveDraft.layer.bounds.x + point.x - moveDraft.start.x),
    y: Math.round(moveDraft.layer.bounds.y + point.y - moveDraft.start.y) };
  renderTransformOverlay();
});
canvas.addEventListener("pointerup", (event) => {
  finishPaint(event);
  finishGradient(event);
  if (lassoDraft?.pointerId === event.pointerId) {
    const draft = lassoDraft; lassoDraft = null; previewPolygon([]);
    if (draft.points.length >= 3) commitSelectionMask("Selecting freehand area",
      combinedSelectionMask(polygonMask(draft.points), draft.mode));
  }
  if (!moveDraft) return;
  const draft = moveDraft; moveDraft = null; renderTransformOverlay();
  commitLayerBounds(draft.layer, draft.bounds, "Moving layer");
});
canvas.addEventListener("pointercancel", (event) => {
  finishPaint(event, true); gradientDraft = null; moveDraft = null; lassoDraft = null;
  previewPolygon([]); renderTransformOverlay();
});
canvas.addEventListener("dblclick", (event) => {
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
  if (event.key.toLowerCase() === "l") executeCommand(event.shiftKey ? "tool.polygon" : "tool.lasso");
  if (event.key.toLowerCase() === "w") executeCommand("tool.magic");
  if (event.key.toLowerCase() === "h") executeCommand("tool.pan");
  if (event.key.toLowerCase() === "v") executeCommand("tool.move");
  if (event.key.toLowerCase() === "b") executeCommand("tool.brush");
  if (event.key.toLowerCase() === "e") executeCommand("tool.eraser");
  if (event.key.toLowerCase() === "t") executeCommand("tool.text");
  if (event.key === "Enter" && polygonDraft) {
    const draft = polygonDraft; polygonDraft = null; previewPolygon([]);
    if (draft.points.length >= 3) commitSelectionMask("Selecting polygonal area",
      combinedSelectionMask(polygonMask(draft.points), draft.mode));
  }
  if (event.key === "Escape" && polygonDraft) { polygonDraft = null; previewPolygon([]); }
});

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === "dragenter") dragDepth++;
    $("dropState").hidden = false;
  });
}
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropState").hidden = true; } });
window.addEventListener("drop", (event) => {
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
