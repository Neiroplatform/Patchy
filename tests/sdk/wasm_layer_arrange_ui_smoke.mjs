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
  frame.src = `../../build/wasm-sdk/site/patchy.html?layer-arrange-ui-smoke=${Date.now()}`;
  await loaded;
  const view = frame.contentWindow;
  const doc = frame.contentDocument;
  const byId = (id) => doc.getElementById(id);
  const idle = () => doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true";
  const revision = () => BigInt(byId("detailRevision").textContent);
  const rows = () => [...doc.querySelectorAll("#layerList .layer-row")];
  const rowByName = (name) => rows().find((row) =>
    row.querySelector(".layer-name")?.textContent === name);
  const selectedRows = () => rows().filter((row) =>
    row.querySelector(".layer-select-button")?.getAttribute("aria-pressed") === "true");
  const failOnEditorError = () => {
    if (!byId("errorBanner").hidden) {
      throw new Error(`${byId("errorTitle").textContent}: ${byId("errorMessage").textContent}`);
    }
  };
  const clickLayer = (name, modifiers = {}) => {
    const button = rowByName(name)?.querySelector(".layer-select-button");
    check(button, `layer row ${name} is missing`);
    button.dispatchEvent(new view.MouseEvent("click", {
      bubbles: true, cancelable: true, view, ...modifiers,
    }));
  };
  const addText = async (name, x) => {
    if (rowByName("Brightness / Contrast")) clickLayer("Brightness / Contrast");
    const before = revision();
    byId("textLayerButton").click();
    await waitFor(() => byId("textDialog").open, `${name} text dialog did not open`);
    byId("textValueInput").value = name;
    byId("textXInput").value = String(x); byId("textYInput").value = "1";
    byId("textWidthInput").value = "2"; byId("textHeightInput").value = "2";
    byId("commitTextButton").click();
    await waitFor(() => idle() && revision() === before + 1n && rowByName(name),
      `${name} did not commit one text revision`);
  };
  const inspectBounds = async (name) => {
    clickLayer(name);
    byId("layerTransformButton").click();
    await waitFor(() => byId("layerTransformDialog").open,
      `${name} transform dialog did not open`);
    const bounds = { x: Number(byId("layerXInput").value),
      y: Number(byId("layerYInput").value) };
    byId("layerTransformDialog").close();
    return bounds;
  };

  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize its pthread-WASM worker");
  byId("newButton").click();
  await waitFor(() => idle() && revision() === 0n, "New did not create the document");
  await addText("Alpha", 1);
  const beforeFixture = revision();
  byId("adjustmentLayerButton").click();
  await waitFor(() => byId("adjustmentDialog").open,
    "fixture adjustment dialog did not open");
  byId("commitAdjustmentButton").click();
  await waitFor(() => idle() && revision() === beforeFixture + 1n &&
    rowByName("Brightness / Contrast"), "fixture adjustment did not commit");
  await addText("Beta", 6); await addText("Gamma", 15);
  clickLayer("Alpha");
  clickLayer("Beta", { metaKey: true, ctrlKey: true });
  clickLayer("Gamma", { metaKey: true, ctrlKey: true });
  check(selectedRows().length === 3, "three roots were not selected");
  byId("layerArrangeModeInput").value = "6";
  byId("layerArrangeModeInput").dispatchEvent(new view.Event("change", { bubbles: true }));
  check(!byId("arrangeLayersButton").disabled && byId("layerArrangeReferenceInput").disabled,
    "gap distribution controls did not expose the selection-only contract");
  const beforeDistribution = revision();
  byId("arrangeLayersButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === beforeDistribution + 1n; },
    "production UI did not distribute in one revision");
  check(selectedRows().length === 3, "distribution did not preserve selected roots");
  check((await inspectBounds("Beta")).x === 8,
    "production UI did not expose deterministic equal gaps");

  clickLayer("Alpha"); clickLayer("Beta", { metaKey: true, ctrlKey: true });
  clickLayer("Gamma", { metaKey: true, ctrlKey: true });
  byId("layerArrangeModeInput").value = "5";
  byId("layerArrangeModeInput").dispatchEvent(new view.Event("change", { bubbles: true }));
  byId("layerArrangeReferenceInput").value = "1";
  const beforeAlignment = revision();
  byId("arrangeLayersButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === beforeAlignment + 1n; },
    "production UI did not align in one revision");
  const canvasHeight = Number(byId("detailCanvas").textContent.split("×").at(-1).trim());
  check(Number.isSafeInteger(canvasHeight) &&
    (await inspectBounds("Alpha")).y === canvasHeight - 2,
    "canvas-bottom alignment did not use the production document bounds");
  const arrangedRevision = revision();
  byId("undoButton").click();
  await waitFor(() => idle() && revision() > arrangedRevision,
    "Undo did not restore arrangement atomically");
  byId("redoButton").click();
  await waitFor(() => idle() && revision() > arrangedRevision + 1n,
    "Redo did not restore arrangement atomically");
  body.dataset.result = "PASS";
  body.dataset.revision = String(revision());
  body.dataset.layers = String(rows().length);
} catch (error) {
  body.dataset.result = "FAIL";
  body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre"); failure.textContent = body.dataset.error;
  body.prepend(failure);
}
