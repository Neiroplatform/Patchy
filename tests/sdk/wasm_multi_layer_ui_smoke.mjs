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
  const selectedNames = () => rows().filter((row) => row.getAttribute("aria-selected") === "true")
    .map(rowName);
  const rowOrder = () => rows().map(rowName).join(",");
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

  let before = revision();
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
  byId("removeLayerButton").click();
  await waitForRevision(before, "Delete button did not remove the selected set in one revision");
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
