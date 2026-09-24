const body = document.body; const frame = document.querySelector("#editorFrame");
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
  const build = new URL(location.href).searchParams.get("build") || "wasm-sdk";
  const siteUrl = new URL(`../../build/${encodeURIComponent(build)}/site/`, import.meta.url);
  const { PatchyWorkspaceStore } = await import(new URL("engine/workspace-store.mjs", siteUrl));
  const store = new PatchyWorkspaceStore();
  let library = await store.loadAssetLibrary().catch(() =>
    ({ version: 1, generation: 0, gradients: [], patterns: [], fonts: [] }));
  library = await store.saveAssetLibrary({ ...library,
    patterns: [...library.patterns.filter((item) => item.id !== "advanced-ui-pattern"), {
      id: "advanced-ui-pattern", name: "UI cobalt checker", kind: "checker",
      foreground: "#f4c542", background: "#253891", size: 5,
    }] });
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("editor iframe failed to load")), { once: true });
  });
  frame.src = `../../build/${encodeURIComponent(build)}/site/patchy.html?advanced-paint-ui-smoke=${Date.now()}`;
  await loaded;
  const doc = frame.contentDocument; const byId = (id) => doc.getElementById(id);
  const idle = () => doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true";
  const revision = () => BigInt(byId("detailRevision").textContent);
  const drag = (start, end, pointerId) => {
    const canvas = byId("documentCanvas"); const rect = canvas.getBoundingClientRect();
    canvas.setPointerCapture = () => {};
    for (const [type, point, buttons] of [["pointerdown", start, 1], ["pointermove", end, 1],
      ["pointerup", end, 0]]) {
      canvas.dispatchEvent(new frame.contentWindow.PointerEvent(type, { bubbles: true, cancelable: true,
        pointerId, pointerType: "mouse", isPrimary: true, button: 0, buttons,
        clientX: rect.left + point.x * rect.width / canvas.width,
        clientY: rect.top + point.y * rect.height / canvas.height }));
    }
    delete canvas.setPointerCapture;
  };
  const cancelStroke = (start, end, pointerId) => {
    const canvas = byId("documentCanvas"); const rect = canvas.getBoundingClientRect();
    canvas.setPointerCapture = () => {};
    for (const [type, point, buttons] of [["pointerdown", start, 1], ["pointermove", end, 1],
      ["pointercancel", end, 0]]) {
      canvas.dispatchEvent(new frame.contentWindow.PointerEvent(type, { bubbles: true, cancelable: true,
        pointerId, pointerType: "mouse", isPrimary: true, button: 0, buttons,
        clientX: rect.left + point.x * rect.width / canvas.width,
        clientY: rect.top + point.y * rect.height / canvas.height }));
    }
    delete canvas.setPointerCapture;
  };
  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize");
  byId("newButton").click();
  await waitFor(() => idle() && !byId("importLayerButton").disabled, "New did not create document");
  const svg = new frame.contentWindow.File([
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#2878b8"/><circle cx="22" cy="24" r="12" fill="#e35644"/></svg>',
  ], "advanced.svg", { type: "image/svg+xml" });
  const transfer = new frame.contentWindow.DataTransfer(); transfer.items.add(svg);
  Object.defineProperty(byId("imageInput"), "files", { configurable: true, value: transfer.files });
  byId("imageInput").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  await waitFor(() => idle() && !byId("mixerToolButton").disabled, "advanced-paint target was not imported");
  byId("brushSizeInput").value = "9";
  byId("mixerToolButton").click();
  check(!byId("mixerWetInput").closest("label").hidden, "Mixer controls were not exposed");
  let before = revision(); drag({ x: 12, y: 24 }, { x: 48, y: 24 }, 310);
  await waitFor(() => idle() && revision() === before + 1n && byId("errorBanner").hidden,
    "Mixer Brush did not commit one revision");
  before = revision(); cancelStroke({ x: 8, y: 8 }, { x: 30, y: 8 }, 312);
  await delay(100);
  check(idle() && revision() === before && byId("errorBanner").hidden,
    "cancelled Mixer Brush gesture changed canonical state");
  byId("patternStampToolButton").click();
  check(!byId("advancedPatternInput").closest("label").hidden, "Pattern controls were not exposed");
  check([...byId("advancedPatternInput").options].some((item) => item.value === "asset:advanced-ui-pattern"),
    "local pattern asset was not available to Pattern Stamp");
  byId("advancedPatternInput").value = "asset:advanced-ui-pattern";
  before = revision(); drag({ x: 10, y: 10 }, { x: 50, y: 36 }, 311);
  await waitFor(() => idle() && revision() === before + 1n && byId("errorBanner").hidden,
    "Pattern Stamp did not commit one revision");
  const pixels = byId("documentCanvas").toDataURL();
  byId("undoButton").click();
  await waitFor(() => idle() && byId("documentCanvas").toDataURL() !== pixels,
    "undo retained Pattern Stamp pixels");
  byId("redoButton").click();
  await waitFor(() => idle() && byId("documentCanvas").toDataURL() === pixels,
    "redo did not restore Pattern Stamp pixels");
  await store.saveAssetLibrary({ ...library,
    patterns: library.patterns.filter((item) => item.id !== "advanced-ui-pattern") });
  body.dataset.result = "PASS"; body.dataset.revision = String(revision());
} catch (error) {
  body.dataset.result = "FAIL"; body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre"); failure.textContent = body.dataset.error; body.prepend(failure);
}
