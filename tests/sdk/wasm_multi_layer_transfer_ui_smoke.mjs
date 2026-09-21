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
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("editor iframe failed to load")), { once: true });
  });
  frame.src = `../../build/wasm-sdk/site/patchy.html?multi-layer-transfer-ui-smoke=${Date.now()}`;
  await loaded;
  const view = frame.contentWindow;
  const doc = frame.contentDocument;
  const byId = (id) => doc.getElementById(id);
  const idle = () => doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true";
  const failOnEditorError = () => {
    if (!byId("errorBanner").hidden) {
      throw new Error(`${byId("errorTitle").textContent}: ${byId("errorMessage").textContent}`);
    }
  };
  const revision = () => BigInt(byId("detailRevision").textContent);
  const rows = () => [...doc.querySelectorAll("#layerList .layer-row")];
  const rowName = (row) => row.querySelector(".layer-name")?.textContent;
  const rowByName = (name) => rows().find((row) => rowName(row) === name);
  const selectedRows = () => rows().filter((row) => row.getAttribute("aria-selected") === "true");
  const tabs = () => [...doc.querySelectorAll("#documentTabs .document-tab")];
  const activeTabIndex = () => tabs().findIndex((tab) => tab.dataset.active === "true");
  const clickLayer = (name, modifiers = {}) => {
    const button = rowByName(name)?.querySelector(".layer-select-button");
    check(button, `layer row ${name} is missing`);
    button.dispatchEvent(new view.MouseEvent("click", {
      bubbles: true, cancelable: true, view, ...modifiers,
    }));
  };
  const addLayerThroughDialog = async (buttonId, dialogId, commitId, expectedName, prepare = () => {}) => {
    const before = revision();
    byId(buttonId).click();
    await waitFor(() => byId(dialogId).open, `${dialogId} did not open`);
    prepare();
    byId(commitId).click();
    await waitFor(() => idle() && revision() === before + 1n,
      `${expectedName} did not commit one revision`);
    check(rowByName(expectedName), `${expectedName} was not rendered in the Layers panel`);
  };
  const activateTab = async (index) => {
    tabs()[index].querySelector('[role="tab"]').click();
    await waitFor(() => idle() && activeTabIndex() === index, `document tab ${index} did not activate`);
  };
  const shortcut = (key) => view.dispatchEvent(new view.KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true, metaKey: true, ctrlKey: true,
  }));

  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize its pthread-WASM worker");
  byId("newButton").click();
  await waitFor(() => idle() && revision() === 0n && tabs().length === 1,
    "source document was not created");
  await addLayerThroughDialog("shapeLayerButton", "shapeDialog", "commitShapeButton", "Shape");
  await addLayerThroughDialog("textLayerButton", "textDialog", "commitTextButton", "Text");
  await addLayerThroughDialog("adjustmentLayerButton", "adjustmentDialog",
    "commitAdjustmentButton", "Brightness / Contrast");
  const sourceRevision = revision();

  byId("newButton").click();
  await waitFor(() => idle() && revision() === 0n && tabs().length === 2 && activeTabIndex() === 1,
    "target document was not created");
  await activateTab(0);
  check(revision() === sourceRevision && rows().length === 3,
    "source document changed while creating the target");
  clickLayer("Text");
  clickLayer("Brightness / Contrast", { metaKey: true, ctrlKey: true });
  check(selectedRows().length === 2, "disjoint source selection was not established");
  shortcut("c");
  await waitFor(() => byId("sessionIndicator").textContent.includes("2 editable layers copied"),
    "Ctrl/Cmd+C did not capture the selected roots");

  await activateTab(1);
  const targetBeforePaste = revision();
  shortcut("v");
  await waitFor(() => { failOnEditorError(); return idle() &&
    revision() === targetBeforePaste + 1n && rows().length === 2; },
    "Ctrl/Cmd+V did not publish one target revision");
  check(selectedRows().length === 2 && rowByName("Text") && rowByName("Brightness / Contrast"),
    "Paste did not restore the complete transferred selection");
  byId("undoButton").click();
  await waitFor(() => idle() && rows().length === 0, "Undo left part of the pasted set behind");
  byId("redoButton").click();
  await waitFor(() => idle() && rows().length === 2, "Redo did not restore the pasted set");
  const targetBeforeDrop = revision();

  await activateTab(0);
  check(revision() === sourceRevision && rows().length === 3,
    "copy/paste mutated the source document");
  clickLayer("Text");
  clickLayer("Brightness / Contrast", { metaKey: true, ctrlKey: true });
  const sourceRow = rowByName("Brightness / Contrast");
  const transfer = new view.DataTransfer();
  sourceRow.dispatchEvent(new view.DragEvent("dragstart", {
    bubbles: true, cancelable: true, view, dataTransfer: transfer,
  }));
  const targetTab = tabs()[1];
  targetTab.dispatchEvent(new view.DragEvent("dragover", {
    bubbles: true, cancelable: true, view, dataTransfer: transfer,
  }));
  targetTab.dispatchEvent(new view.DragEvent("drop", {
    bubbles: true, cancelable: true, view, dataTransfer: transfer,
  }));
  sourceRow.dispatchEvent(new view.DragEvent("dragend", {
    bubbles: true, view, dataTransfer: transfer,
  }));
  await waitFor(() => { failOnEditorError(); return idle() && activeTabIndex() === 1 &&
    revision() === targetBeforeDrop + 1n && rows().length === 4; },
  "selected-set document-tab drop did not publish one target revision");
  check(selectedRows().length === 2,
    "document-tab drop did not restore the transferred selection");

  shortcut("c");
  await waitFor(() => byId("sessionIndicator").textContent.includes("2 editable layers copied"),
    "same-document copy did not capture the selected roots");
  let sameDocumentBefore = revision();
  shortcut("v");
  await waitFor(() => { failOnEditorError(); return idle() &&
    revision() === sameDocumentBefore + 1n && rows().length === 6; },
  "same-document Paste did not copy the selected set atomically");
  sameDocumentBefore = revision();
  shortcut("v");
  await waitFor(() => { failOnEditorError(); return idle() &&
    revision() === sameDocumentBefore + 1n && rows().length === 8; },
  "repeated same-document Paste used a stale clipboard state");
  check(selectedRows().length === 2,
    "same-document Paste did not retain the newest copied selection");

  body.dataset.result = "PASS";
  body.dataset.revision = String(revision());
  body.dataset.layers = String(rows().length);
} catch (error) {
  body.dataset.result = "FAIL";
  body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre");
  failure.textContent = body.dataset.error;
  body.prepend(failure);
}
