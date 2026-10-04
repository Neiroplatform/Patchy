const body = document.body;
const frame = document.querySelector("#editorFrame");
const check = (value, message) => { if (!value) throw new Error(message); };
const delay = (milliseconds = 25) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message, timeout = 45_000) {
  const deadline = performance.now() + timeout;
  let lastError;
  while (performance.now() < deadline) {
    try { if (await predicate()) return; } catch (error) { lastError = error; }
    await delay();
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

try {
  body.dataset.phase = "loading-editor";
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("editor iframe failed to load")), { once: true });
  });
  frame.src = `../../build/wasm-sdk/site/patchy.html?multi-layer-ui-smoke=${Date.now()}`;
  await loaded;
  body.dataset.phase = "editor-loaded";
  const view = frame.contentWindow;
  const doc = frame.contentDocument;
  const byId = (id) => doc.getElementById(id);
  const shell = () => doc.querySelector(".editor-shell");
  const idle = () => shell()?.getAttribute("aria-busy") !== "true";
  const revision = () => BigInt(byId("detailRevision").textContent);
  const layerCount = () => Number(byId("layerCount").textContent);
  const rows = () => [...doc.querySelectorAll("#layerList .layer-row")];
  const rowName = (row) => row.querySelector(".layer-name")?.textContent;
  const rowByName = (name) => rows().find((row) => rowName(row) === name);
  const selectedNames = () => rows().filter((row) =>
    row.querySelector(".layer-select-button")?.getAttribute("aria-pressed") === "true")
    .map(rowName);
  const rowOrder = () => rows().map(rowName).join(",");
  const dispatchShortcut = (key, options = {}, target = view) => target.dispatchEvent(
    new view.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true,
      ctrlKey: true, metaKey: false, ...options }));
  const clickLayer = (name, modifiers = {}) => {
    const button = rowByName(name)?.querySelector(".layer-select-button");
    check(button, `layer row ${name} is missing`);
    button.dispatchEvent(new view.MouseEvent("click", {
      bubbles: true, cancelable: true, view, ...modifiers,
    }));
  };
  const waitForRevision = async (before, message) => {
    await waitFor(() => idle() && revision() === before + 1n, message);
  };
  const addLayerThroughDialog = async (buttonId, dialogId, commitId, expectedName, prepare = () => {}) => {
    const before = revision();
    byId(buttonId).click();
    await waitFor(() => byId(dialogId).open, `${dialogId} did not open`);
    prepare();
    byId(commitId).click();
    await waitForRevision(before, `${expectedName} did not commit one revision`);
    check(rowByName(expectedName), `${expectedName} was not rendered in the Layers panel`);
  };

  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize its pthread-WASM worker");
  body.dataset.phase = "engine-ready";
  byId("newButton").click();
  await waitFor(() => idle() && byId("detailRevision").textContent === "0" &&
    !byId("shapeLayerButton").disabled,
    "New did not create the production document");
  body.dataset.phase = "document-created";

  check(getComputedStyle(byId("saveAsButton")).display !== "none" &&
    getComputedStyle(byId("exportButton")).display !== "none" &&
    getComputedStyle(byId("createPixelLayerButton")).display !== "none" &&
    getComputedStyle(byId("mergeLayersButton")).display !== "none",
  "primary save/export/layer actions are not visibly discoverable");

  let before = revision();
  byId("createPixelLayerButton").click();
  await waitForRevision(before, "New layer button did not commit one revision");
  check(rowByName("Layer 1"), "New layer button did not create Layer 1");
  before = revision();
  dispatchShortcut("N", { shiftKey: true });
  await waitForRevision(before, "Ctrl+Shift+N did not create one pixel layer revision");
  check(rowByName("Layer 2"), "Ctrl+Shift+N did not create a uniquely named layer");

  const layerTwoVisibility = rowByName("Layer 2").querySelector(".visibility-button");
  before = revision();
  layerTwoVisibility.click();
  await waitForRevision(before, "visibility toggle did not commit one revision");
  check(rowByName("Layer 2").querySelector(".visibility-button").getAttribute("aria-label").startsWith("Show"),
    "visibility toggle did not expose the hidden state");
  before = revision();
  rowByName("Layer 2").querySelector(".visibility-button").click();
  await waitForRevision(before, "visibility restore did not commit one revision");

  clickLayer("Layer 1");
  check(byId("toggleClippingButton").disabled &&
    byId("toggleClippingButton").title.includes("pixel layer below"),
  "invalid bottom-layer clipping state did not fail closed with an explanation");
  clickLayer("Layer 2");
  check(!byId("toggleClippingButton").disabled,
    "valid clipping layer above a pixel base was not enabled");
  before = revision();
  byId("toggleClippingButton").click();
  await waitForRevision(before, "clipping mask did not commit one revision");
  check(rowByName("Layer 2").querySelector(".layer-kind").textContent.includes("Clipped") &&
    byId("toggleClippingButton").textContent.includes("Release"),
  "clipping mask state was not projected into the Layers panel");
  before = revision();
  byId("createMaskButton").click();
  await waitForRevision(before, "layer mask did not commit one revision");
  check(rowByName("Layer 2").querySelector(".layer-kind").textContent.includes("Mask"),
    "layer mask state was not projected into the Layers panel");

  clickLayer("Layer 2");
  clickLayer("Layer 1", { ctrlKey: true, metaKey: true });
  const countBeforeMerge = layerCount();
  before = revision();
  byId("mergeLayersButton").click();
  await waitForRevision(before, "Merge layers did not commit one revision");
  check(layerCount() === countBeforeMerge - 1 && rowByName("Merged"),
    "Merge layers did not replace the selected roots with one pixel layer");
  const mergedRevision = revision();
  dispatchShortcut("z");
  await waitFor(() => idle() && revision() === mergedRevision + 1n && rowByName("Layer 1") && rowByName("Layer 2"),
    "Ctrl+Z did not undo the merged layer");
  dispatchShortcut("z", { shiftKey: true });
  await waitFor(() => idle() && rowByName("Merged") && !rowByName("Layer 1") && !rowByName("Layer 2"),
    "Ctrl+Shift+Z did not redo the merged layer");
  dispatchShortcut("z");
  await waitFor(() => idle() && rowByName("Layer 1") && rowByName("Layer 2"),
    "second Ctrl+Z did not expose a state for the Ctrl+Y route");
  dispatchShortcut("y");
  await waitFor(() => idle() && rowByName("Merged") && !rowByName("Layer 1") && !rowByName("Layer 2"),
    "Ctrl+Y did not redo the merged layer");

  clickLayer("Merged");
  before = revision();
  byId("fillToolButton").click();
  await waitFor(() => idle() && revision() > before,
    "Fill did not prepare non-transparent pixels for the Cut shortcut");
  before = revision();
  dispatchShortcut("x");
  await waitForRevision(before, "Ctrl+X did not cut the selected pixel layer in one revision");
  const countBeforePaste = layerCount();
  dispatchShortcut("c");
  await waitFor(() => !byId("pastePixelsButton").disabled, "Ctrl+C did not populate the local layer clipboard");
  before = revision();
  dispatchShortcut("v");
  await waitForRevision(before, "Ctrl+V did not paste one editable layer revision");
  check(layerCount() === countBeforePaste + 1, "Ctrl+V did not add an editable layer");
  body.dataset.phase = "layer-basics-verified";

  const viewport = byId("canvasViewport");
  viewport.focus();
  for (let index = 0; index < 5; ++index) {
    viewport.dispatchEvent(new view.KeyboardEvent("keydown", {
      key: "-", bubbles: true, cancelable: true }));
    await delay();
  }
  await waitFor(() => {
    const viewportRect = viewport.getBoundingClientRect();
    const horizontal = byId("horizontalRuler").getBoundingClientRect();
    const vertical = byId("verticalRuler").getBoundingClientRect();
    return horizontal.width >= viewportRect.width - 19 && vertical.height >= viewportRect.height - 19;
  }, "rulers did not continue across the zoomed-out viewport");

  const dragGuide = async (rulerId, orientation, pointerId, destination) => {
    const ruler = byId(rulerId);
    ruler.setPointerCapture = () => {};
    const rulerRect = ruler.getBoundingClientRect();
    const start = { clientX: rulerRect.left + Math.min(60, rulerRect.width / 2),
      clientY: rulerRect.top + Math.min(8, rulerRect.height / 2) };
    ruler.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true,
      pointerId, pointerType: "mouse", button: 0, ...start }));
    ruler.dispatchEvent(new view.PointerEvent("pointermove", { bubbles: true, cancelable: true,
      pointerId, pointerType: "mouse", button: 0, ...destination }));
    ruler.dispatchEvent(new view.PointerEvent("pointerup", { bubbles: true, cancelable: true,
      pointerId, pointerType: "mouse", button: 0, ...destination }));
    await waitFor(() => doc.querySelector(`.guide-line[data-orientation="${orientation}"]`),
      `${orientation} ruler drag did not create a guide`);
    return doc.querySelector(`.guide-line[data-orientation="${orientation}"]`);
  };
  let canvasRect = byId("documentCanvas").getBoundingClientRect();
  let guide = await dragGuide("horizontalRuler", "horizontal", 41,
    { clientX: canvasRect.left + canvasRect.width / 2, clientY: canvasRect.top + canvasRect.height / 3 });
  const firstGuidePosition = guide.dataset.position;
  guide.setPointerCapture = () => {};
  let guideRect = guide.getBoundingClientRect();
  const movedPoint = { clientX: canvasRect.left + canvasRect.width / 2,
    clientY: canvasRect.top + canvasRect.height * .7 };
  guide.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true,
    pointerId: 42, pointerType: "mouse", button: 0, clientX: guideRect.left + 2, clientY: guideRect.top + 2 }));
  guide.dispatchEvent(new view.PointerEvent("pointermove", { bubbles: true, cancelable: true,
    pointerId: 42, pointerType: "mouse", button: 0, ...movedPoint }));
  guide.dispatchEvent(new view.PointerEvent("pointerup", { bubbles: true, cancelable: true,
    pointerId: 42, pointerType: "mouse", button: 0, ...movedPoint }));
  await waitFor(() => guide.dataset.position !== firstGuidePosition,
    "existing horizontal guide did not move");
  guide = doc.querySelector('.guide-line[data-orientation="horizontal"]');
  guide.setPointerCapture = () => {};
  const horizontalRulerRect = byId("horizontalRuler").getBoundingClientRect();
  guideRect = guide.getBoundingClientRect();
  guide.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true,
    pointerId: 43, pointerType: "mouse", button: 0, clientX: guideRect.left + 2, clientY: guideRect.top + 2 }));
  const returnPoint = { clientX: horizontalRulerRect.left + 40, clientY: horizontalRulerRect.top + 8 };
  guide.dispatchEvent(new view.PointerEvent("pointermove", { bubbles: true, cancelable: true,
    pointerId: 43, pointerType: "mouse", button: 0, ...returnPoint }));
  guide.dispatchEvent(new view.PointerEvent("pointerup", { bubbles: true, cancelable: true,
    pointerId: 43, pointerType: "mouse", button: 0, ...returnPoint }));
  await waitFor(() => !doc.querySelector('.guide-line[data-orientation="horizontal"]'),
    "guide was not removed when returned to its parent ruler");
  canvasRect = byId("documentCanvas").getBoundingClientRect();
  guide = await dragGuide("verticalRuler", "vertical", 44,
    { clientX: canvasRect.left + canvasRect.width / 2, clientY: canvasRect.top + canvasRect.height / 2 });
  check(guide.getAttribute("aria-label").includes("Vertical guide"),
    "vertical ruler did not create an accessible vertical guide");
  guide.focus();
  guide.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
  await waitFor(() => !doc.querySelector('.guide-line[data-orientation="vertical"]'),
    "Delete did not remove the focused guide");
  body.dataset.phase = "rulers-guides-verified";

  Object.defineProperty(view, "showOpenFilePicker", { configurable: true, value: undefined });
  Object.defineProperty(view, "showSaveFilePicker", { configurable: true, value: undefined });
  const downloads = [];
  const anchorPrototype = view.HTMLAnchorElement.prototype;
  const originalAnchorClick = anchorPrototype.click;
  anchorPrototype.click = function clickDownloadUnderTest() {
    if (!this.download) return originalAnchorClick.call(this);
    downloads.push({ name: this.download,
      bytes: view.fetch(this.href).then((response) => response.arrayBuffer()) });
  };
  const downloadThrough = async (action, expectedSuffix, message) => {
    const count = downloads.length;
    action();
    await waitFor(() => idle() && downloads.length === count + 1, message);
    const record = downloads.at(-1);
    check(record.name.toLowerCase().endsWith(expectedSuffix), `${message}: wrong filename ${record.name}`);
    return new Uint8Array(await record.bytes);
  };
  byId("saveFormatSelect").value = "psd";
  byId("saveFormatSelect").dispatchEvent(new view.Event("change", { bubbles: true }));
  let bytes = await downloadThrough(() => dispatchShortcut("s", { shiftKey: true }), ".psd",
    "Ctrl+Shift+S did not create a Save As PSD download");
  check(new TextDecoder().decode(bytes.slice(0, 4)) === "8BPS" && bytes[5] === 1,
    "Save As PSD download signature is invalid");
  byId("saveFormatSelect").value = "psb";
  byId("saveFormatSelect").dispatchEvent(new view.Event("change", { bubbles: true }));
  bytes = await downloadThrough(() => dispatchShortcut("s"), ".psb",
    "Ctrl+S did not create a PSB download");
  check(new TextDecoder().decode(bytes.slice(0, 4)) === "8BPS" && bytes[5] === 2,
    "Save As PSB download signature is invalid");
  const signatures = {
    png: (value) => value[0] === 0x89 && value[1] === 0x50,
    jpeg: (value) => value[0] === 0xff && value[1] === 0xd8,
    webp: (value) => new TextDecoder().decode(value.slice(0, 12)).endsWith("WEBP"),
    svg: (value) => new TextDecoder().decode(value.slice(0, 200)).includes("<svg"),
  };
  for (const [format, suffix] of [["png", ".png"], ["jpeg", ".jpg"],
    ["webp", ".webp"], ["svg", ".svg"]]) {
    byId("exportFormatSelect").value = format;
    bytes = await downloadThrough(() => byId("exportButton").click(), suffix,
      `Export ${format} did not create a download`);
    check(signatures[format](bytes), `Export ${format} signature is invalid`);
  }
  anchorPrototype.click = originalAnchorClick;
  body.dataset.phase = "downloads-verified";

  await addLayerThroughDialog("shapeLayerButton", "shapeDialog", "commitShapeButton", "Shape");
  await addLayerThroughDialog("textLayerButton", "textDialog", "commitTextButton", "Text");
  await addLayerThroughDialog("adjustmentLayerButton", "adjustmentDialog",
    "commitAdjustmentButton", "Brightness / Contrast");
  clickLayer("Text");
  await addLayerThroughDialog("adjustmentLayerButton", "adjustmentDialog",
    "commitAdjustmentButton", "Hue / Saturation", () => {
      byId("adjustmentKindInput").value = "2";
      byId("adjustmentKindInput").dispatchEvent(new view.Event("change", { bubbles: true }));
    });
  body.dataset.phase = "layers-authored";

  clickLayer("Shape");
  clickLayer("Brightness / Contrast", { shiftKey: true });
  check(selectedNames().join(",") === "Brightness / Contrast,Text,Shape",
    "Shift range selection did not select the contiguous UI range");
  clickLayer("Text", { metaKey: true, ctrlKey: true });
  check(selectedNames().join(",") === "Brightness / Contrast,Shape",
    "Ctrl/Cmd toggle did not create a disjoint UI selection");
  check(byId("propertiesTitle").textContent === "2 selected layers" && byId("layerNameInput").disabled,
    "multi-selection properties state was not exposed to the user");
  body.dataset.phase = "selection-verified";

  before = revision();
  byId("layerOpacityInput").value = "42";
  byId("layerOpacityInput").dispatchEvent(new view.Event("input", { bubbles: true }));
  byId("layerOpacityInput").dispatchEvent(new view.Event("change", { bubbles: true }));
  await waitForRevision(before, "selected-set opacity edit did not commit one revision");
  check(selectedNames().join(",") === "Brightness / Contrast,Shape" &&
    byId("layerOpacityOutput").textContent === "42%",
  "selected set was not retained by the property edit");
  body.dataset.phase = "properties-edited";

  const destination = rowByName("Hue / Saturation");
  check(destination, "unselected layer for the drag destination is missing");
  const orderBeforeDrag = rowOrder();
  const source = rowByName("Brightness / Contrast");
  const transfer = new view.DataTransfer();
  source.dispatchEvent(new view.DragEvent("dragstart", { bubbles: true, cancelable: true, view, dataTransfer: transfer }));
  const destinationBounds = destination.getBoundingClientRect();
  const dragOptions = { bubbles: true, cancelable: true, view, dataTransfer: transfer,
    clientX: destinationBounds.left + 2, clientY: destinationBounds.bottom - 1 };
  destination.dispatchEvent(new view.DragEvent("dragover", dragOptions));
  before = revision();
  destination.dispatchEvent(new view.DragEvent("drop", dragOptions));
  source.dispatchEvent(new view.DragEvent("dragend", { bubbles: true, view, dataTransfer: transfer }));
  await waitForRevision(before, "selected-set drag did not commit one revision");
  check(rowOrder() !== orderBeforeDrag && selectedNames().join(",") === "Brightness / Contrast,Shape",
    "selected-set drag did not reorder the real Layers panel or retain selection");
  body.dataset.phase = "drag-verified";

  before = revision();
  byId("groupLayerButton").click();
  await waitForRevision(before, "Group button did not commit one revision");
  check(rowByName("Group") && rowByName("Brightness / Contrast") && rowByName("Shape"),
    "Group button did not project the selected topology");
  clickLayer("Group");
  check(!byId("ungroupLayerButton").disabled, "selected group did not enable Ungroup");
  before = revision();
  byId("ungroupLayerButton").click();
  await waitForRevision(before, "Ungroup button did not commit one revision");
  check(!rowByName("Group") && rowByName("Brightness / Contrast") && rowByName("Shape"),
    "Ungroup button did not restore the authored layers");
  body.dataset.phase = "topology-verified";

  clickLayer("Brightness / Contrast");
  clickLayer("Shape", { metaKey: true, ctrlKey: true });
  before = revision();
  const deletionTarget = rowByName("Brightness / Contrast").querySelector(".layer-select-button");
  deletionTarget.focus();
  deletionTarget.dispatchEvent(new view.KeyboardEvent("keydown", {
    key: "Delete", bubbles: true, cancelable: true }));
  await waitForRevision(before, "Delete key did not remove the selected set in one revision");
  check(!rowByName("Brightness / Contrast") && !rowByName("Shape"),
    "Delete button left part of the selected set behind");
  byId("undoButton").click();
  await waitFor(() => idle() && rowByName("Brightness / Contrast") && rowByName("Shape"),
    "Undo did not restore both UI-authored layers");
  byId("redoButton").click();
  await waitFor(() => idle() && !rowByName("Brightness / Contrast") && !rowByName("Shape"),
    "Redo did not remove both UI-authored layers again");

  body.dataset.result = "PASS";
  body.dataset.revision = String(revision());
  body.dataset.layers = String(layerCount());
} catch (error) {
  body.dataset.result = "FAIL";
  body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre");
  failure.textContent = body.dataset.error;
  body.prepend(failure);
}
