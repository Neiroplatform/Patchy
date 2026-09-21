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

const layerKinds = ["Pixels", "Group", "Adjustment", "Text", "Shape", "Smart object"];
const blendModes = new Set([0, 1, 2, 3, 4, 5, 6, 11, 27]);

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
  $("layerNameInput").disabled = busy || !layer;
  $("layerOpacityInput").disabled = busy || !layer;
  $("layerBlendSelect").disabled = busy || !layer;
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
    row.querySelector(".layer-kind").textContent = formatKind(layer);
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
$("openButton").addEventListener("click", openPicker);
$("emptyOpenButton").addEventListener("click", openPicker);
$("newButton").addEventListener("click", newDocument);
$("saveButton").addEventListener("click", saveDocument);
$("undoButton").addEventListener("click", () => mutate("Undo", () => client.undo()));
$("redoButton").addEventListener("click", () => mutate("Redo", () => client.redo()));
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

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === "o") { event.preventDefault(); openPicker(); }
  if (key === "s") { event.preventDefault(); saveDocument(); }
  if (key === "z") {
    event.preventDefault();
    const redo = event.shiftKey;
    mutate(redo ? "Redo" : "Undo", () => redo ? client.redo() : client.undo());
  }
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
} catch (error) {
  showError("Could not start engine", error);
  $("busyState").hidden = true;
}
