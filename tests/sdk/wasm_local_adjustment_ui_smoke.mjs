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
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("editor iframe failed to load")), { once: true });
  });
  const build = new URL(location.href).searchParams.get("build") || "wasm-sdk";
  frame.src = `../../build/${encodeURIComponent(build)}/site/patchy.html?local-ui-smoke=${Date.now()}`;
  await loaded;
  const doc = frame.contentDocument; const byId = (id) => doc.getElementById(id);
  const idle = () => doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true";
  const revision = () => BigInt(byId("detailRevision").textContent);
  const pointer = (type, point, pointerId, buttons) => {
    const canvas = byId("documentCanvas"); const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new frame.contentWindow.PointerEvent(type, { bubbles: true, cancelable: true,
      pointerId, pointerType: "mouse", isPrimary: true, button: 0, buttons,
      clientX: rect.left + point.x * rect.width / canvas.width,
      clientY: rect.top + point.y * rect.height / canvas.height }));
  };
  const drag = (start, end, pointerId) => {
    const canvas = byId("documentCanvas"); canvas.setPointerCapture = () => {};
    pointer("pointerdown", start, pointerId, 1); pointer("pointermove", end, pointerId, 1);
    pointer("pointerup", end, pointerId, 0); delete canvas.setPointerCapture;
  };
  await waitFor(() => byId("sessionIndicator")?.textContent.includes("Engine ready") && idle(),
    "production editor did not initialize");
  byId("newButton").click();
  await waitFor(() => idle() && !byId("importLayerButton").disabled, "New did not create document");
  const svg = new frame.contentWindow.File([
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><defs><linearGradient id="g"><stop stop-color="#184c92"/><stop offset="1" stop-color="#f3c54f"/></linearGradient></defs><rect width="64" height="48" fill="url(#g)"/><circle cx="20" cy="24" r="9" fill="#d63d55"/></svg>',
  ], "local.svg", { type: "image/svg+xml" });
  const transfer = new frame.contentWindow.DataTransfer(); transfer.items.add(svg);
  Object.defineProperty(byId("imageInput"), "files", { configurable: true, value: transfer.files });
  byId("imageInput").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  await waitFor(() => idle() && !byId("smudgeToolButton").disabled, "target layer was not imported");
  byId("brushSizeInput").value = "9";
  const tools = ["smudge", "dodge", "burn", "sponge", "blur", "sharpen"];
  let pointerId = 200;
  for (const tool of tools) {
    byId(`${tool}ToolButton`).click();
    check(!byId("localBrushStrengthInput").closest("label").hidden,
      `${tool} controls were not exposed`);
    const before = revision();
    drag({ x: 12, y: 24 }, { x: 48, y: 24 }, pointerId++);
    await waitFor(() => idle() && revision() === before + 1n && byId("errorBanner").hidden,
      `${tool} did not commit exactly one revision`);
  }
  const pixels = byId("documentCanvas").toDataURL();
  byId("undoButton").click();
  await waitFor(() => idle() && byId("documentCanvas").toDataURL() !== pixels,
    "undo retained final local-brush pixels");
  byId("redoButton").click();
  await waitFor(() => idle() && byId("documentCanvas").toDataURL() === pixels,
    "redo did not restore final local-brush pixels");
  body.dataset.result = "PASS"; body.dataset.revision = String(revision());
} catch (error) {
  body.dataset.result = "FAIL"; body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre"); failure.textContent = body.dataset.error; body.prepend(failure);
}
