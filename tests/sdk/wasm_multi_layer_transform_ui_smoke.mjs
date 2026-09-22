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
  frame.src = `../../build/wasm-sdk/site/patchy.html?multi-layer-transform-ui-smoke=${Date.now()}`;
  await loaded;
  const view = frame.contentWindow;
  const doc = frame.contentDocument;
  const byId = (id) => doc.getElementById(id);
  const idle = () => doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true";
  const revision = () => BigInt(byId("detailRevision").textContent);
  const rows = () => [...doc.querySelectorAll("#layerList .layer-row")];
  const rowName = (row) => row.querySelector(".layer-name")?.textContent;
  const rowByName = (name) => rows().find((row) => rowName(row) === name);
  const selectedRows = () => rows().filter((row) => row.getAttribute("aria-selected") === "true");
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
    const before = revision();
    byId("textLayerButton").click();
    await waitFor(() => byId("textDialog").open, `${name} text dialog did not open`);
    byId("textValueInput").value = name;
    byId("textXInput").value = String(x);
    byId("textYInput").value = "1";
    byId("textWidthInput").value = "2";
    byId("textHeightInput").value = "2";
    byId("commitTextButton").click();
    await waitFor(() => idle() && revision() === before + 1n && rowByName(name),
      `${name} did not commit one text revision`);
  };

  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize its pthread-WASM worker");
  byId("newButton").click();
  await waitFor(() => idle() && revision() === 0n,
    "New did not create the production document");
  await addText("Alpha", 1);
  const adjustmentBefore = revision();
  byId("adjustmentLayerButton").click();
  await waitFor(() => byId("adjustmentDialog").open,
    "fixture adjustment dialog did not open");
  byId("commitAdjustmentButton").click();
  await waitFor(() => idle() && revision() === adjustmentBefore + 1n,
    "fixture adjustment did not commit one revision");
  clickLayer("Brightness / Contrast");
  await addText("Beta", 5);

  clickLayer("Alpha");
  clickLayer("Beta", { metaKey: true, ctrlKey: true });
  check(selectedRows().length === 2 && !byId("layerTransformButton").disabled,
    "multi-selection did not enable Free Transform");
  byId("layerTransformButton").click();
  await waitFor(() => byId("layerTransformDialog").open,
    "multi-layer Free Transform dialog did not open");
  check(byId("layerTransformTitle").textContent.includes("2 layers") &&
    Number(byId("layerXInput").value) === 1 &&
    Number(byId("layerWidthInput").value) === 6,
  "Free Transform did not expose selected-set union bounds");
  byId("layerXInput").value = "2";
  byId("layerYInput").value = "2";
  byId("layerWidthInput").value = "12";
  byId("layerHeightInput").value = "4";
  byId("layerWidthInput").dispatchEvent(new view.Event("input", { bubbles: true }));
  await delay(150);
  failOnEditorError();
  const before = revision();
  byId("commitLayerTransformButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === before + 1n; },
    "multi-layer Free Transform did not publish one revision");
  check(selectedRows().length === 2,
    "multi-layer Free Transform did not preserve the selected roots");

  clickLayer("Alpha");
  byId("layerTransformButton").click();
  await waitFor(() => byId("layerTransformDialog").open,
    "transformed Alpha layer did not reopen Free Transform");
  check(Number(byId("layerXInput").value) === 2 &&
    Number(byId("layerYInput").value) === 2 &&
    Number(byId("layerWidthInput").value) === 4 &&
    Number(byId("layerHeightInput").value) === 4,
  "Alpha did not retain the collective scale geometry");
  byId("layerTransformDialog").close();
  clickLayer("Beta");
  byId("layerTransformButton").click();
  await waitFor(() => byId("layerTransformDialog").open,
    "transformed Beta layer did not reopen Free Transform");
  check(Number(byId("layerXInput").value) === 10 &&
    Number(byId("layerWidthInput").value) === 4,
  "Beta lost relative placement under the collective scale");
  byId("layerTransformDialog").close();

  const transformedRevision = revision();
  byId("undoButton").click();
  await waitFor(() => idle() && revision() > transformedRevision,
    "Undo did not restore the multi-layer transform atomically");
  byId("redoButton").click();
  await waitFor(() => idle() && revision() > transformedRevision + 1n,
    "Redo did not restore the multi-layer transform atomically");

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
