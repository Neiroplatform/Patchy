const body = document.body;
const frame = document.querySelector("#editorFrame");
const check = (value, message) => { if (!value) throw new Error(message); };
const delay = (milliseconds = 25) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message, timeout = 45_000) {
  const deadline = performance.now() + timeout; let lastError;
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
  frame.src = `../../build/wasm-sdk/site/patchy.html?selection-refinement-ui-smoke=${Date.now()}`;
  await loaded;
  const doc = frame.contentDocument;
  const byId = (id) => doc.getElementById(id);
  const idle = () => doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true";
  const revision = () => BigInt(byId("detailRevision").textContent);
  const failOnEditorError = () => {
    if (!byId("errorBanner").hidden) {
      throw new Error(`${byId("errorTitle").textContent}: ${byId("errorMessage").textContent}`);
    }
  };
  const dragSelection = async (start, end) => {
    byId("marqueeToolButton").click();
    const canvas = byId("documentCanvas"); const rect = canvas.getBoundingClientRect();
    const PointerEvent = frame.contentWindow.PointerEvent; canvas.setPointerCapture = () => {};
    try {
      const dispatch = (type, point, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 81, pointerType: "mouse", isPrimary: true,
        button: 0, buttons, clientX: rect.left + point.x, clientY: rect.top + point.y,
      }));
      dispatch("pointerdown", start, 1); dispatch("pointermove", end, 1); dispatch("pointerup", end, 0);
    } finally { delete canvas.setPointerCapture; }
  };

  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize its pthread-WASM worker");
  byId("newButton").click();
  await waitFor(() => idle() && byId("detailRevision").textContent === "0" &&
    !byId("importLayerButton").disabled,
  "New did not create the production document");
  const svg = new frame.contentWindow.File([
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#4b91e2"/></svg>',
  ], "target.svg", { type: "image/svg+xml" });
  const transfer = new frame.contentWindow.DataTransfer(); transfer.items.add(svg);
  Object.defineProperty(byId("imageInput"), "files", { configurable: true, value: transfer.files });
  byId("imageInput").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  await waitFor(() => idle() && !byId("createMaskButton").disabled,
    "production editor did not import/select a raster target");

  let before = revision();
  await dragSelection({ x: 12, y: 10 }, { x: 44, y: 34 });
  await waitFor(() => idle() && revision() === before + 1n && !byId("selectionOverlay").hidden,
    "selection fixture did not commit");

  byId("smoothSelectionButton").click();
  await waitFor(() => byId("selectionRefinementDialog").open &&
    byId("selectionRefinementStatus").textContent.includes("Live engine preview"),
  "Select and Mask did not show live engine preview");
  before = revision();
  byId("selectionFeatherInput").value = "3";
  byId("selectionFeatherInput").dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
  await waitFor(() => byId("selectionRefinementStatus").textContent.includes("Live engine preview"),
    "refinement controls did not refresh preview");
  byId("selectionRefinementDialog").close();
  await delay(50);
  check(revision() === before, "Cancel mutated selection, history, or document state");

  byId("smoothSelectionButton").click();
  await waitFor(() => byId("selectionRefinementStatus").textContent.includes("Live engine preview"),
    "Select and Mask did not reopen");
  before = revision(); byId("commitSelectionRefinementButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === before + 1n; },
    "selection output did not commit one revision");

  byId("smoothSelectionButton").click();
  await waitFor(() => byId("selectionRefinementDialog").open, "Select and Mask did not open for mask output");
  byId("selectionOutputInput").value = "layerMask";
  byId("selectionOutputInput").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  await waitFor(() => !byId("selectionLayerField").hidden &&
    byId("selectionRefinementStatus").textContent.includes("Live engine preview"),
  "layer-mask output target did not preview");
  before = revision(); byId("commitSelectionRefinementButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === before + 1n &&
    !byId("toggleMaskButton").disabled; }, "layer-mask output did not commit one revision");
  const finalRevision = revision(); byId("undoButton").click();
  await waitFor(() => idle() && byId("toggleMaskButton").disabled,
    "Undo did not remove refined layer mask");
  byId("redoButton").click();
  await waitFor(() => idle() && revision() > finalRevision && !byId("toggleMaskButton").disabled,
    "Redo did not restore refined layer mask");
  body.dataset.result = "PASS"; body.dataset.revision = String(revision());
} catch (error) {
  body.dataset.result = "FAIL"; body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre"); failure.textContent = body.dataset.error;
  body.prepend(failure);
}
