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
  const build = new URL(location.href).searchParams.get("build") || "wasm-sdk";
  frame.src = `../../build/${encodeURIComponent(build)}/site/patchy.html?retouch-ui-smoke=${Date.now()}`;
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
  const pointer = (type, point, pointerId, buttons) => {
    const canvas = byId("documentCanvas"); const rect = canvas.getBoundingClientRect();
    return canvas.dispatchEvent(new frame.contentWindow.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: rect.left + point.x * rect.width / canvas.width,
      clientY: rect.top + point.y * rect.height / canvas.height,
    }));
  };
  const drag = (start, end, pointerId, release = true) => {
    const canvas = byId("documentCanvas"); canvas.setPointerCapture = () => {};
    pointer("pointerdown", start, pointerId, 1); pointer("pointermove", end, pointerId, 1);
    if (release) { pointer("pointerup", end, pointerId, 0); delete canvas.setPointerCapture; }
  };
  const release = (point, pointerId) => {
    pointer("pointerup", point, pointerId, 0); delete byId("documentCanvas").setPointerCapture;
  };
  const feedbackVisible = () => {
    const pixels = byId("gestureCanvas").getContext("2d").getImageData(0, 0,
      byId("gestureCanvas").width, byId("gestureCanvas").height).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  };

  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize its pthread-WASM worker");
  byId("newButton").click();
  await waitFor(() => idle() && byId("detailRevision").textContent === "0" &&
    !byId("importLayerButton").disabled, "New did not create the production document");
  const svg = new frame.contentWindow.File([
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#3178c6"/><rect x="32" width="32" height="48" fill="#f0c34e"/><circle cx="16" cy="24" r="8" fill="#dc3e50"/><path d="M32 0v48" stroke="#1b2733" stroke-width="4"/></svg>',
  ], "retouch.svg", { type: "image/svg+xml" });
  const transfer = new frame.contentWindow.DataTransfer(); transfer.items.add(svg);
  Object.defineProperty(byId("imageInput"), "files", { configurable: true, value: transfer.files });
  byId("imageInput").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  await waitFor(() => idle() && !byId("spotHealingToolButton").disabled,
    "production editor did not import/select a retouch target");

  byId("brushSizeInput").value = "10";
  byId("brushSizeInput").dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
  byId("spotHealingToolButton").click();
  check(!byId("retouchSoftnessInput").closest("label").hidden,
    "Spot Healing controls were not exposed");
  const beforeSpot = revision();
  drag({ x: 14, y: 24 }, { x: 20, y: 24 }, 101, false);
  check(feedbackVisible(), "Spot Healing did not show its raw footprint feedback");
  check(revision() === beforeSpot, "Spot Healing feedback mutated canonical state");
  release({ x: 20, y: 24 }, 101);
  await waitFor(() => { failOnEditorError(); return idle() && revision() === beforeSpot + 1n; },
    "Spot Healing did not commit exactly one canonical revision");
  const healedPixels = byId("documentCanvas").toDataURL();
  byId("undoButton").click();
  await waitFor(() => idle() && byId("redoButton").disabled === false,
    "Undo did not restore the pre-healing document");
  check(byId("documentCanvas").toDataURL() !== healedPixels,
    "Undo retained the Spot Healing pixels");

  byId("marqueeToolButton").click();
  let before = revision();
  drag({ x: 8, y: 15 }, { x: 25, y: 34 }, 102);
  await waitFor(() => idle() && revision() === before + 1n && !byId("selectionOverlay").hidden,
    "Patch selection fixture did not commit");
  const selectionLeft = byId("selectionOverlay").style.left;
  byId("patchToolButton").click();
  byId("patchModeInput").value = "2";
  byId("patchModeInput").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  check(!byId("patchModeInput").closest("label").hidden,
    "Patch controls were not exposed");
  before = revision();
  drag({ x: 16, y: 24 }, { x: 40, y: 24 }, 103, false);
  check(feedbackVisible(), "Patch did not show translated raw-pixel feedback");
  check(revision() === before, "Patch feedback mutated canonical state");
  release({ x: 40, y: 24 }, 103);
  await waitFor(() => { failOnEditorError(); return idle() && revision() === before + 1n; },
    "Patch Destination did not commit exactly one canonical revision");
  check(byId("selectionOverlay").style.left !== selectionLeft,
    "Patch Destination did not move the selection atomically");
  const patchedPixels = byId("documentCanvas").toDataURL();
  const patchedSelectionLeft = byId("selectionOverlay").style.left;
  byId("undoButton").click();
  await waitFor(() => idle() && byId("selectionOverlay").style.left === selectionLeft,
    "Undo did not restore Patch pixels and selection together");
  byId("redoButton").click();
  await waitFor(() => idle() && byId("selectionOverlay").style.left === patchedSelectionLeft &&
    byId("documentCanvas").toDataURL() === patchedPixels,
  "Redo did not restore Patch pixels and selection together");
  body.dataset.result = "PASS"; body.dataset.revision = String(revision());
} catch (error) {
  body.dataset.result = "FAIL"; body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre"); failure.textContent = body.dataset.error;
  body.prepend(failure);
}
