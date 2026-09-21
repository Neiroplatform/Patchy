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
let moveDraft = null;
let paintDraft = null;
let textEditingId = null;
let cloneSource = null;
let gradientDraft = null;

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
  for (const id of ["invertSelectionButton", "expandSelectionButton", "contractSelectionButton",
    "borderSelectionButton", "saveChannelButton", "savePathButton"]) {
    $(id).disabled = busy || !snapshot?.selection?.length;
  }
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
    button.addEventListener("click", () => mutate("Loading channel selection", () => client.selectChannel(channel.id)));
    channelList.append(button);
  }
  for (const path of snapshot?.paths || []) {
    const button = document.createElement("button"); button.type = "button";
    button.textContent = path.name || (path.kind === 1 ? "Work path" : "Saved path");
    button.addEventListener("click", () => mutate("Loading path selection", () => client.selectPath(path.id)));
    pathList.append(button);
  }
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
  $("gestureCanvas").width = snapshot.width;
  $("gestureCanvas").height = snapshot.height;
  const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  context.putImageData(new ImageData(pixels, snapshot.width, snapshot.height), 0, 0);
  $("gestureCanvas").getContext("2d").clearRect(0, 0, snapshot.width, snapshot.height);
  applyViewport();
  renderSelection();
  renderTransformOverlay();
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
    ["panToolButton", "pan"], ["brushToolButton", "brush"],
    ["eraserToolButton", "eraser"], ["cloneToolButton", "clone"],
    ["healToolButton", "heal"], ["gradientToolButton", "gradient"],
    ["textToolButton", "text"]]) {
    $(id).setAttribute("aria-pressed", String(tool === value));
  }
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
  snapshot = next;
  if (selectedLayerId == null || !snapshot.layers.some((layer) => layer.id === selectedLayerId)) {
    selectedLayerId = snapshot.activeLayerId || snapshot.layers.at(-1)?.id || null;
  }
  $("emptyState").hidden = true;
  setSessionState("document", snapshot.dirty ? "Modified locally" : "Document ready");
  renderLayers();
  renderLayerProperties();
  renderStructure();
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

function rectanglePath(bounds) {
  return { anchors: [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ] };
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
    target.fillStyle = $("brushColorInput").value;
    const rects = snapshot.selection?.length ? snapshot.selection : [layer.bounds];
    for (const rect of rects) target.fillRect(rect.x - layer.bounds.x, rect.y - layer.bounds.y, rect.width, rect.height);
    const rgba = new Uint8Array(target.getImageData(0, 0, scratch.width, scratch.height).data);
    return client.replacePixelLayer(layer.id, { name: layer.name, width: scratch.width,
      height: scratch.height, bounds: layer.bounds, rgba });
  });
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
    const gradient = target.createLinearGradient(start.x, start.y, end.x || start.x + 1, end.y);
    gradient.addColorStop(0, $("brushColorInput").value); gradient.addColorStop(1, "transparent");
    target.fillStyle = gradient;
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
registerCommand("document.save", "saveButton", saveDocument, () => !busy && Boolean(snapshot));
registerCommand("history.undo", "undoButton", () => mutate("Undo", () => client.undo()), () => !busy && Boolean(snapshot?.canUndo));
registerCommand("history.redo", "redoButton", () => mutate("Redo", () => client.redo()), () => !busy && Boolean(snapshot?.canRedo));
registerCommand("document.canvas", "transformButton", openDocumentDialog, () => !busy && Boolean(snapshot));
registerCommand("tool.move", "moveToolButton", () => setCanvasTool("move"));
registerCommand("tool.marquee", "marqueeToolButton", () => setCanvasTool("marquee"));
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
  const layer = selectedLayer(); const bounds = snapshot?.selection?.[0];
  if (layer && bounds) mutate("Creating vector mask", () => client.setVectorMask(layer.id,
    { path: rectanglePath(bounds), feather: 0, density: 255 }));
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
$("invertSelectionButton").addEventListener("click", () => mutate("Inverting selection", () => client.invertSelection()));
$("expandSelectionButton").addEventListener("click", () => mutate("Expanding selection", () => client.expandSelection(4)));
$("contractSelectionButton").addEventListener("click", () => mutate("Contracting selection", () => client.contractSelection(4)));
$("borderSelectionButton").addEventListener("click", () => mutate("Bordering selection", () => client.borderSelection(4)));
$("saveChannelButton").addEventListener("click", () => mutate("Saving alpha channel", () => client.addAlphaChannel(`Alpha ${snapshot.channels.length + 1}`)));
$("savePathButton").addEventListener("click", () => {
  const bounds = snapshot?.selection?.[0];
  if (bounds) mutate("Saving document path", () => client.addDocumentPath({
    name: `Path ${snapshot.paths.length + 1}`, kind: 0, path: rectanglePath(bounds) }));
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
  if (busy || !snapshot || event.button !== 0) return;
  if (["brush", "eraser", "clone", "heal"].includes(canvasTool)) { beginPaint(event); return; }
  if (canvasTool === "gradient") { beginGradient(event); return; }
  if (canvasTool === "text") { openTextDialog(); return; }
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
  if (!moveDraft) return;
  const draft = moveDraft; moveDraft = null; renderTransformOverlay();
  commitLayerBounds(draft.layer, draft.bounds, "Moving layer");
});
canvas.addEventListener("pointercancel", (event) => {
  finishPaint(event, true); gradientDraft = null; moveDraft = null; renderTransformOverlay();
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
  if (event.key.toLowerCase() === "v") executeCommand("tool.move");
  if (event.key.toLowerCase() === "b") executeCommand("tool.brush");
  if (event.key.toLowerCase() === "e") executeCommand("tool.eraser");
  if (event.key.toLowerCase() === "t") executeCommand("tool.text");
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
