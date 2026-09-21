import { PatchyWorkerClient } from "./engine/client.mjs";

const $ = (id) => document.getElementById(id);
const shell = document.querySelector(".editor-shell");
const worker = new Worker(new URL("./engine/worker.mjs", import.meta.url), { type: "module", name: "patchy-engine" });
const client = new PatchyWorkerClient(worker);
const canvas = $("documentCanvas");
const context = canvas.getContext("2d", { alpha: true });
let snapshot = null;
let selectedLayerId = null;
let documentName = "Untitled.psd";
let busy = false;
let dragDepth = 0;
let cancelActiveOperation = null;
let canvasTool = "marquee";
let zoomMode = "fit";
let zoom = 1;
let marqueeDraft = null;
let panStart = null;

const layerKinds = ["Pixels", "Group", "Adjustment", "Text", "Shape", "Smart object"];
const blendModes = new Set([0, 1, 2, 3, 4, 5, 6, 11, 27]);
const commandRegistry = new Map();

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
  for (const button of [$("openButton"), $("newButton"), $("saveButton"), $("undoButton"), $("redoButton")]) {
    button.dataset.busyDisabled = active ? "true" : "false";
  }
  updateControls();
}

function updateControls() {
  const layer = selectedLayer();
  $("saveButton").disabled = busy || !snapshot;
  $("undoButton").disabled = busy || !snapshot?.canUndo;
  $("redoButton").disabled = busy || !snapshot?.canRedo;
  $("openButton").disabled = busy;
  $("newButton").disabled = busy;
  $("importLayerButton").disabled = busy || !snapshot;
  $("groupLayerButton").disabled = busy || !layer;
  $("ungroupLayerButton").disabled = busy || layer?.kind !== 1;
  $("removeLayerButton").disabled = busy || !layer;
  $("invertLayerButton").disabled = busy || layer?.kind !== 0;
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
  $("layerBlendSelect").disabled = busy || !layer;
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
    await acceptSnapshot(await operation.promise);
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
    row.querySelector(".layer-kind").textContent = `${formatKind(layer)}${layer.mask ? ` · Mask${layer.mask.disabled ? " off" : ""}` : ""}`;
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

function renderMetadata() {
  $("stageMeta").hidden = !snapshot;
  $("documentName").textContent = documentName;
  $("documentMetrics").textContent = snapshot ? `${snapshot.width} × ${snapshot.height} px` : "";
  $("detailState").textContent = snapshot ? (snapshot.dirty ? "Modified" : "Saved") : "No document";
  $("detailFormat").textContent = snapshot ? `${snapshot.bitDepth}-bit RGB` : "-";
  $("detailCanvas").textContent = snapshot ? `${snapshot.width} × ${snapshot.height}` : "-";
  $("detailRevision").textContent = snapshot ? String(snapshot.revision) : "-";
  updateControls();
}

async function renderDocument() {
  if (!snapshot) return;
  const bytes = await client.render({ x: 0, y: 0, width: snapshot.width, height: snapshot.height });
  const expected = snapshot.width * snapshot.height * 4;
  if (bytes.byteLength !== expected) throw new Error(`Engine returned ${bytes.byteLength} RGBA bytes, expected ${expected}`);
  canvas.width = snapshot.width;
  canvas.height = snapshot.height;
  const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  context.putImageData(new ImageData(pixels, snapshot.width, snapshot.height), 0, 0);
  applyViewport();
  renderSelection();
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
  $("marqueeToolButton").setAttribute("aria-pressed", String(tool === "marquee"));
  $("panToolButton").setAttribute("aria-pressed", String(tool === "pan"));
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
  snapshot = next;
  if (selectedLayerId == null || !snapshot.layers.some((layer) => layer.id === selectedLayerId)) {
    selectedLayerId = snapshot.activeLayerId || snapshot.layers.at(-1)?.id || null;
  }
  $("emptyState").hidden = true;
  setSessionState("document", snapshot.dirty ? "Modified locally" : "Document ready");
  renderLayers();
  renderLayerProperties();
  renderMetadata();
  if (rerender) await renderDocument();
}

async function mutate(title, operation) {
  if (busy || !snapshot) return;
  clearError();
  setBusy(true, title, "Committing one canonical engine revision");
  try { await acceptSnapshot(await operation()); }
  catch (error) { showError(`${title} failed`, error); }
  finally { setBusy(false); }
}

async function openFile(file) {
  if (!file || busy) return;
  clearError();
  setBusy(true, "Opening document", "Transferring bytes to the isolated Worker");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    documentName = file.name || "Document.psd";
    await acceptSnapshot(await client.open(bytes));
  } catch (error) { showError("Could not open document", error); }
  finally { setBusy(false); }
}

async function newDocument() {
  if (busy) return;
  clearError();
  setBusy(true, "Creating document", "Preparing a 1600 × 1000 RGBA workspace");
  try {
    documentName = "Untitled.psd";
    await acceptSnapshot(await client.create(1600, 1000));
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

async function importPixelLayer(file) {
  if (!file || busy || !snapshot) return;
  clearError();
  setBusy(true, "Importing pixels", "Decoding the image outside canonical document state");
  let image;
  try {
    image = await createImageBitmap(file);
    if (image.width <= 0 || image.height <= 0 ||
        !Number.isSafeInteger(image.width * image.height * 4)) {
      throw new Error("Image dimensions cannot be represented safely");
    }
    const scratch = document.createElement("canvas");
    scratch.width = image.width;
    scratch.height = image.height;
    const scratchContext = scratch.getContext("2d", { alpha: true, willReadFrequently: true });
    scratchContext.drawImage(image, 0, 0);
    const rgba = new Uint8Array(scratchContext.getImageData(0, 0, image.width, image.height).data);
    const name = file.name.replace(/\.[^.]+$/, "") || "Imported pixels";
    await acceptSnapshot(await client.addPixelLayer({
      name, width: image.width, height: image.height,
      bounds: { x: 0, y: 0, width: image.width, height: image.height }, rgba,
    }));
  } catch (error) { showError("Could not import pixels", error); }
  finally { image?.close?.(); setBusy(false); }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function openPicker() { if (!busy) $("fileInput").click(); }
registerCommand("document.open", "openButton", openPicker, () => !busy);
registerCommand("document.new", "newButton", newDocument, () => !busy);
registerCommand("document.save", "saveButton", saveDocument, () => !busy && Boolean(snapshot));
registerCommand("history.undo", "undoButton", () => mutate("Undo", () => client.undo()), () => !busy && Boolean(snapshot?.canUndo));
registerCommand("history.redo", "redoButton", () => mutate("Redo", () => client.redo()), () => !busy && Boolean(snapshot?.canRedo));
registerCommand("document.canvas", "transformButton", openDocumentDialog, () => !busy && Boolean(snapshot));
registerCommand("tool.marquee", "marqueeToolButton", () => setCanvasTool("marquee"));
registerCommand("tool.pan", "panToolButton", () => setCanvasTool("pan"));
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
$("layerBlendSelect").addEventListener("change", () => {
  const layer = selectedLayer();
  if (layer) mutate("Changing blend mode", () => client.setLayerBlendMode(layer.id, Number($("layerBlendSelect").value)));
});
$("togglePanelsButton").addEventListener("click", () => {
  const hidden = shell.classList.toggle("panels-hidden");
  $("togglePanelsButton").setAttribute("aria-pressed", String(hidden));
});

canvas.addEventListener("pointerdown", (event) => {
  if (busy || !snapshot || canvasTool !== "marquee" || event.button !== 0) return;
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

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === "o") { event.preventDefault(); executeCommand("document.open"); }
  if (key === "s") { event.preventDefault(); executeCommand("document.save"); }
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
  if (event.key.toLowerCase() === "h") executeCommand("tool.pan");
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
  openFile(event.dataTransfer?.files?.[0]);
});

try {
  await client.initialize(new URL("./patchy-engine.mjs", location.href).href);
  setSessionState("ready", "Engine ready");
  $("busyState").hidden = true;
  updateControls();
  setCanvasTool("marquee");
} catch (error) {
  showError("Could not start engine", error);
  $("busyState").hidden = true;
}
