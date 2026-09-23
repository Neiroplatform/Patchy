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
  frame.src = `../../build/wasm-sdk/site/patchy.html?liquify-ui-smoke=${Date.now()}`;
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
  const dragLiquify = (start, end, pointerId) => {
    const target = byId("liquifyCanvas"); const rect = target.getBoundingClientRect();
    const PointerEvent = frame.contentWindow.PointerEvent; target.setPointerCapture = () => {};
    const dispatch = (type, point, buttons) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: rect.left + point.x * rect.width / target.width,
      clientY: rect.top + point.y * rect.height / target.height,
    }));
    dispatch("pointerdown", start, 1); dispatch("pointermove", end, 1);
    dispatch("pointerup", end, 0); delete target.setPointerCapture;
  };

  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize its pthread-WASM worker");
  byId("newButton").click();
  await waitFor(() => idle() && byId("detailRevision").textContent === "0" &&
    !byId("importLayerButton").disabled, "New did not create the production document");
  const svg = new frame.contentWindow.File([
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><defs><linearGradient id="g"><stop stop-color="#df3344"/><stop offset="1" stop-color="#247bd7"/></linearGradient></defs><rect width="64" height="48" fill="url(#g)"/><circle cx="19" cy="24" r="9" fill="#f7da4e"/></svg>',
  ], "liquify.svg", { type: "image/svg+xml" });
  const transfer = new frame.contentWindow.DataTransfer(); transfer.items.add(svg);
  Object.defineProperty(byId("imageInput"), "files", { configurable: true, value: transfer.files });
  byId("imageInput").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  await waitFor(() => idle() && !byId("liquifyLayerButton").disabled,
    "production editor did not import/select a Liquify target");

  const beforeCancel = revision(); byId("liquifyLayerButton").click();
  await waitFor(() => byId("liquifyDialog").open && byId("liquifyCanvas").width === 64,
    "Liquify dialog did not open with the selected layer");
  dragLiquify({ x: 18, y: 24 }, { x: 34, y: 24 }, 91);
  await waitFor(() => byId("liquifyStatus").textContent.includes("Live engine preview"),
    "Liquify did not show an engine-owned preview");
  check(revision() === beforeCancel, "Liquify preview mutated document state");
  byId("restoreLiquifyButton").click();
  check(byId("commitLiquifyButton").disabled && byId("restoreLiquifyButton").disabled,
    "Restore all did not clear the disposable Liquify session");
  dragLiquify({ x: 22, y: 24 }, { x: 38, y: 24 }, 92);
  await waitFor(() => byId("liquifyStatus").textContent.includes("Live engine preview"),
    "Liquify preview did not recover after restore");
  byId("liquifyDialog").close(); await delay(50);
  check(revision() === beforeCancel, "cancelling Liquify mutated pixels or history");

  byId("liquifyLayerButton").click();
  await waitFor(() => byId("liquifyDialog").open, "Liquify did not reopen");
  byId("liquifyToolInput").value = "7";
  dragLiquify({ x: 8, y: 10 }, { x: 13, y: 10 }, 93);
  const maskPixels = byId("liquifyMaskCanvas").getContext("2d").getImageData(0, 0, 64, 48).data;
  check(maskPixels.some((value, index) => index % 4 === 3 && value > 0),
    "freeze-mask overlay was not visible");
  byId("liquifyToolInput").value = "0";
  dragLiquify({ x: 22, y: 24 }, { x: 42, y: 24 }, 94);
  await waitFor(() => byId("liquifyStatus").textContent.includes("Live engine preview"),
    "combined freeze/warp session did not preview");
  const beforeCommit = revision(); byId("commitLiquifyButton").click();
  await waitFor(() => { failOnEditorError(); return idle() && revision() === beforeCommit + 1n; },
    "Liquify did not commit exactly one revision");
  const committed = revision(); byId("undoButton").click();
  await waitFor(() => idle() && byId("redoButton").disabled === false,
    "Undo did not restore the pre-Liquify document");
  byId("redoButton").click();
  await waitFor(() => idle() && revision() > committed,
    "Redo did not restore the Liquify result");
  body.dataset.result = "PASS"; body.dataset.revision = String(revision());
} catch (error) {
  body.dataset.result = "FAIL"; body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre"); failure.textContent = body.dataset.error;
  body.prepend(failure);
}
