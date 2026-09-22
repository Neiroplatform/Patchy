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
  frame.src = `../../build/wasm-sdk/site/patchy.html?image-geometry-ui-smoke=${Date.now()}`;
  await loaded;
  const doc = frame.contentDocument;
  const byId = (id) => doc.getElementById(id);
  const idle = () => doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true";
  const revision = () => BigInt(byId("detailRevision").textContent);
  const canvasSize = () => byId("detailCanvas").textContent.replaceAll(" ", "");
  const failOnEditorError = () => {
    if (!byId("errorBanner").hidden) {
      throw new Error(`${byId("errorTitle").textContent}: ${byId("errorMessage").textContent}`);
    }
  };
  const openGeometry = async () => {
    byId("transformButton").click();
    await waitFor(() => byId("documentDialog").open, "Image Geometry dialog did not open");
  };
  const dragCanvas = async (toolButtonId, start, end) => {
    byId(toolButtonId).click();
    const canvas = byId("documentCanvas");
    const rect = canvas.getBoundingClientRect();
    const PointerEvent = frame.contentWindow.PointerEvent;
    canvas.setPointerCapture = () => {};
    try {
      const dispatch = (type, point, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 71, pointerType: "mouse", isPrimary: true,
        button: 0, buttons, clientX: rect.left + point.x, clientY: rect.top + point.y,
      }));
      dispatch("pointerdown", start, 1);
      dispatch("pointermove", end, 1);
      dispatch("pointerup", end, 0);
    } finally { delete canvas.setPointerCapture; }
  };

  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize its pthread-WASM worker");
  byId("newButton").click();
  await waitFor(() => idle() && revision() === 0n, "New did not create the document");

  await openGeometry();
  let before = revision();
  byId("resizeConstrainInput").checked = false;
  byId("documentWidthInput").value = "30001"; byId("documentHeightInput").value = "1";
  byId("resizeImageButton").click();
  await waitFor(() => revision() === before && byId("documentDialog").open &&
    !byId("errorBanner").hidden && byId("errorMessage").textContent.includes("PSD dimensions"),
  "production geometry preflight did not reject an unsaveable PSD size before mutation");
  byId("resizeConstrainInput").checked = false;
  byId("documentWidthInput").value = "16"; byId("documentHeightInput").value = "12";
  before = revision(); byId("resizeImageButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === before + 1n && canvasSize() === "16×12"; },
    "production Image Size did not commit one revision");

  await openGeometry();
  byId("canvasWidthInput").value = "20"; byId("canvasHeightInput").value = "16";
  byId("canvasAnchorInput").value = "8"; byId("geometryColorInput").value = "#123456";
  byId("geometryTransparentInput").checked = false;
  before = revision(); byId("resizeCanvasButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === before + 1n && canvasSize() === "20×16"; },
    "production Canvas Size did not commit anchor/fill options");

  await openGeometry();
  byId("rotateDegreesInput").value = "90";
  before = revision(); byId("rotateArbitraryButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === before + 1n && canvasSize() === "16×20"; },
    "production arbitrary Rotate did not commit one revision");

  await dragCanvas("cropToolButton", { x: 3.2, y: 4.1 }, { x: 12.7, y: 15.4 });
  check(byId("cropToolButton").getAttribute("aria-pressed") === "true",
    "production Crop tool did not become active");
  await waitFor(() => byId("documentDialog").open && Number(byId("cropWidthInput").value) > 0 &&
    Number(byId("cropHeightInput").value) > 0, "visual Crop gesture did not open bounded geometry controls");
  check(byId("cropXInput").value === "3" && byId("cropYInput").value === "4" &&
    byId("cropWidthInput").value === "10" && byId("cropHeightInput").value === "12",
  "visual Crop gesture did not retain document-space coordinates");
  byId("documentDialog").close();

  before = revision();
  await dragCanvas("marqueeToolButton", { x: 2.2, y: 3.2 }, { x: 10.6, y: 14.6 });
  await waitFor(() => idle() && revision() === before + 1n && !byId("selectionOverlay").hidden,
    "selection fixture for crop-to-selection did not commit");
  await openGeometry();
  check(!byId("cropFromSelectionButton").disabled, "crop-to-selection remained disabled");
  const selectionCrop = ["cropXInput", "cropYInput", "cropWidthInput", "cropHeightInput"]
    .map((id) => byId(id).value);
  byId("cropXInput").value = "0"; byId("cropYInput").value = "0";
  byId("cropWidthInput").value = "1"; byId("cropHeightInput").value = "1";
  byId("cropFromSelectionButton").click();
  check(["cropXInput", "cropYInput", "cropWidthInput", "cropHeightInput"]
    .every((id, index) => byId(id).value === selectionCrop[index]),
  "Use selection did not restore the canonical selection bounds");
  byId("cropXInput").value = "-2"; byId("cropYInput").value = "-1";
  byId("cropWidthInput").value = "20"; byId("cropHeightInput").value = "23";
  byId("cropAngleInput").value = "0"; byId("cropExpandInput").checked = true;
  before = revision(); byId("cropButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === before + 1n && canvasSize() === "20×23"; },
    "production expanding Crop did not commit one revision");

  const finalRevision = revision(); byId("undoButton").click();
  await waitFor(() => idle() && canvasSize() === "16×20", "Undo did not restore pre-crop geometry");
  byId("redoButton").click();
  await waitFor(() => idle() && canvasSize() === "20×23" && revision() > finalRevision,
    "Redo did not restore final geometry");
  body.dataset.result = "PASS";
  body.dataset.revision = String(revision()); body.dataset.canvas = canvasSize();
} catch (error) {
  body.dataset.result = "FAIL"; body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre"); failure.textContent = body.dataset.error;
  body.prepend(failure);
}
