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

async function loadEditor(tag) {
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("editor iframe failed to load")), { once: true });
  });
  frame.src = `../../build/wasm-sdk/site/patchy.html?shell-accessibility=${tag}-${Date.now()}`;
  await loaded;
  const doc = frame.contentDocument;
  await waitFor(() => doc.querySelector(".editor-shell")?.dataset.state === "ready" &&
    doc.querySelector(".editor-shell")?.getAttribute("aria-busy") !== "true",
  "production editor did not initialize its pthread-WASM worker");
  return doc;
}

try {
  let doc = await loadEditor("initial");
  let byId = (id) => doc.getElementById(id);
  byId("localeSelect").value = "ru";
  byId("localeSelect").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  await waitFor(() => doc.documentElement.lang === "ru" && byId("newButton").textContent.trim() === "Новый",
    "runtime Russian localization did not apply");
  byId("toggleSnapButton").click();
  check(byId("toggleSnapButton").getAttribute("aria-pressed") === "false",
    "snap preference did not publish its disabled state");
  await delay(300);

  doc = await loadEditor("persisted"); byId = (id) => doc.getElementById(id);
  check(doc.documentElement.lang === "ru", "Russian locale preference did not survive reload");
  check(byId("newButton").textContent.trim() === "Новый", "persisted locale did not render the shell");
  check(byId("sessionIndicator").textContent.includes("Движок готов"),
    "dynamic ready status bypassed localization");
  check(byId("toggleSnapButton").getAttribute("aria-pressed") === "false",
    "snap preference did not survive reload");
  byId("toggleSnapButton").click();
  check(byId("toggleSnapButton").getAttribute("aria-pressed") === "true",
    "snap preference did not re-enable");
  await delay(300);

  const toolbar = doc.querySelector(".tool-rail");
  const initialTool = toolbar.querySelector('button[tabindex="0"]');
  check(initialTool, "toolbar has no reachable roving item");
  initialTool.focus();
  initialTool.dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: "ArrowDown", bubbles: true, cancelable: true,
  }));
  check(doc.activeElement !== initialTool && doc.activeElement?.closest(".tool-rail"),
    "toolbar ArrowDown did not move focus");
  check(toolbar.querySelectorAll('button[tabindex="0"]').length === 1,
    "toolbar roving focus exposed multiple tab stops");

  byId("newButton").click();
  await waitFor(() => byId("detailRevision").textContent === "0" && !byId("importLayerButton").disabled,
    "New did not create a production document");
  byId("addVerticalGuideButton").click(); byId("addHorizontalGuideButton").click();
  let guides = [...byId("guidesOverlay").querySelectorAll(".guide-line")];
  check(guides.length === 2 && guides.every((guide) => /[Нн]аправляющая/.test(guide.getAttribute("aria-label"))),
    "center guides were not created with localized accessible names");
  byId("localeSelect").value = "en";
  byId("localeSelect").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  guides = [...byId("guidesOverlay").querySelectorAll(".guide-line")];
  check(guides.every((guide) => /guide/i.test(guide.getAttribute("aria-label")) &&
    !/[\u0400-\u04ff]/.test(guide.getAttribute("aria-label"))),
  "existing guide accessible names did not follow the runtime locale");
  byId("localeSelect").value = "ru";
  byId("localeSelect").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  guides = [...byId("guidesOverlay").querySelectorAll(".guide-line")];
  check(guides.every((guide) => /[Нн]аправляющая/.test(guide.getAttribute("aria-label"))),
    "existing guide accessible names did not return to Russian");

  const geometryRevision = Number(byId("detailRevision").textContent);
  byId("transformButton").click();
  await waitFor(() => byId("documentDialog").open, "Canvas operations did not open for guide bounds test");
  byId("resizeConstrainInput").checked = false;
  byId("documentWidthInput").value = "400"; byId("documentHeightInput").value = "250";
  byId("resizeImageButton").click();
  await waitFor(() => Number(byId("detailRevision").textContent) === geometryRevision + 1 &&
    byId("detailCanvas").textContent.replaceAll(" ", "") === "400×250" &&
    doc.querySelector(".editor-shell").getAttribute("aria-busy") !== "true" &&
    !byId("documentDialog").open,
  "guide bounds fixture did not shrink the document");
  check(byId("guidesOverlay").querySelectorAll(".guide-line").length === 0,
    "geometry shrink retained guides outside the document bounds");
  byId("transformButton").click();
  await waitFor(() => byId("documentDialog").open, "Canvas operations did not reopen for guide fixture restore");
  byId("resizeConstrainInput").checked = false;
  byId("documentWidthInput").value = "1600"; byId("documentHeightInput").value = "1000";
  byId("resizeImageButton").click();
  await waitFor(() => Number(byId("detailRevision").textContent) === geometryRevision + 2 &&
    byId("detailCanvas").textContent.replaceAll(" ", "") === "1600×1000" &&
    doc.querySelector(".editor-shell").getAttribute("aria-busy") !== "true" &&
    !byId("documentDialog").open,
  "guide bounds fixture did not restore the document");
  byId("addVerticalGuideButton").click(); byId("addHorizontalGuideButton").click();
  guides = [...byId("guidesOverlay").querySelectorAll(".guide-line")];
  guides[0].focus();
  guides[0].dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: "Delete", bubbles: true, cancelable: true,
  }));
  check(byId("guidesOverlay").querySelectorAll(".guide-line").length === 1,
    "guide keyboard deletion did not remove exactly one guide");
  byId("addHorizontalGuideButton").click();
  const importSvg = async (name, color) => {
    const file = new frame.contentWindow.File([
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="${color}"/></svg>`,
    ], name, { type: "image/svg+xml" });
    const transfer = new frame.contentWindow.DataTransfer(); transfer.items.add(file);
    Object.defineProperty(byId("imageInput"), "files", { configurable: true, value: transfer.files });
    byId("imageInput").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
    await waitFor(() => doc.querySelector(".editor-shell").getAttribute("aria-busy") !== "true" &&
      Number(byId("layerCount").textContent) >= (name.includes("two") ? 2 : 1), `${name} did not import`);
  };
  await importSvg("one.svg", "#4b91e2");
  await importSvg("two.svg", "#df6e46");

  byId("moveToolButton").click();
  const moveCanvas = byId("documentCanvas");
  moveCanvas.setPointerCapture = () => {};
  const canvasRect = moveCanvas.getBoundingClientRect();
  const pointer = (type, x, y, buttons) => new frame.contentWindow.PointerEvent(type, {
    pointerId: 71, pointerType: "mouse", button: 0, buttons, bubbles: true, cancelable: true,
    clientX: canvasRect.left + x * canvasRect.width / 1600,
    clientY: canvasRect.top + y * canvasRect.height / 1000,
  });
  const moveRevision = Number(byId("detailRevision").textContent);
  const start = { x: 200, y: 200 };
  moveCanvas.dispatchEvent(pointer("pointerdown", start.x, start.y, 1));
  const originalPoints = byId("transformPolygon").getAttribute("points").trim().split(/[ ,]+/).map(Number);
  const originalRight = Math.max(originalPoints[0], originalPoints[2], originalPoints[4], originalPoints[6]);
  const nearCenterDelta = 800 - originalRight - 1;
  moveCanvas.dispatchEvent(pointer("pointermove", start.x + nearCenterDelta, start.y, 1));
  const snappedPoints = byId("transformPolygon").getAttribute("points").trim().split(/[ ,]+/).map(Number);
  check(Math.max(snappedPoints[0], snappedPoints[2], snappedPoints[4], snappedPoints[6]) === 800,
    "Move preview did not snap the selected layer edge to the center guide");
  moveCanvas.dispatchEvent(pointer("pointerup", start.x + nearCenterDelta, start.y, 0));
  await waitFor(() => Number(byId("detailRevision").textContent) === moveRevision + 1 &&
    doc.querySelector(".editor-shell").getAttribute("aria-busy") !== "true",
  "snapped Move did not commit exactly one document revision");

  const selected = byId("layerList").querySelector('.layer-row[data-active="true"] .layer-select-button');
  selected.focus(); const beforeLayer = selected.closest(".layer-row").dataset.layerId;
  const layerRows = [...byId("layerList").querySelectorAll(".layer-row")];
  const layerKey = selected.closest(".layer-row") === layerRows.at(-1) ? "ArrowUp" : "ArrowDown";
  selected.dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: layerKey, bubbles: true, cancelable: true,
  }));
  await delay();
  const afterLayer = byId("layerList").querySelector('.layer-row[data-active="true"]')?.dataset.layerId;
  const focusedLayer = doc.activeElement?.closest?.(".layer-row")?.dataset.layerId;
  check(afterLayer && afterLayer !== beforeLayer && focusedLayer === afterLayer,
    `virtualized Layers ArrowDown did not retain focus on the new selection (${beforeLayer} -> ${afterLayer || "none"}, focus=${focusedLayer || "none"})`);

  const historyCurrent = byId("historyList").querySelector('[aria-selected="true"]');
  historyCurrent.focus();
  historyCurrent.dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: "ArrowUp", bubbles: true, cancelable: true,
  }));
  check(doc.activeElement?.classList.contains("history-row") && doc.activeElement !== historyCurrent,
    "History ArrowUp did not move its roving focus");
  doc.activeElement.click();
  await waitFor(() => doc.querySelector(".editor-shell").getAttribute("aria-busy") !== "true" &&
    doc.activeElement === byId("historyList").querySelector('[aria-selected="true"]'),
  "History activation did not retain focus on the resulting current state");

  const revision = byId("detailRevision").textContent;
  byId("layerNameInput").focus();
  byId("layerNameInput").dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: "z", ctrlKey: true, isComposing: true, bubbles: true, cancelable: true,
  }));
  byId("layerNameInput").dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: "a", ctrlKey: true, bubbles: true, cancelable: true,
  }));
  const saveEvent = new frame.contentWindow.KeyboardEvent("keydown", {
    key: "s", ctrlKey: true, bubbles: true, cancelable: true,
  });
  byId("layerNameInput").dispatchEvent(saveEvent);
  check(!saveEvent.defaultPrevented, "editable Ctrl+S was captured by the global save shortcut");
  await delay(80);
  check(byId("detailRevision").textContent === revision, "IME/editable shortcut changed document state");

  byId("assetsButton").focus(); byId("assetsButton").click();
  await waitFor(() => byId("assetsDialog").open, "Assets dialog did not open");
  byId("assetsDialog").querySelector('button[value="cancel"]').click();
  await delay();
  check(doc.activeElement === byId("assetsButton"), "dialog close did not return focus to its invoker");

  const transformRevision = byId("detailRevision").textContent;
  byId("layerTransformButton").focus(); byId("layerTransformButton").click();
  await waitFor(() => byId("layerTransformDialog").open, "Transform dialog did not open");
  const dialogControls = [...byId("layerTransformDialog").querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled)")]
    .filter((item) => item.getClientRects().length);
  dialogControls[0].focus();
  dialogControls[0].dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: "Tab", shiftKey: true, bubbles: true, cancelable: true,
  }));
  check(doc.activeElement === dialogControls.at(-1), "dialog focus did not wrap from first to last control");
  doc.activeElement.dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true,
  }));
  await waitFor(() => !byId("layerTransformDialog").open && doc.activeElement === byId("layerTransformButton"),
    "Escape did not close dialog and return focus");
  check(byId("detailRevision").textContent === transformRevision, "dialog Escape committed document state");

  byId("newButton").click();
  await waitFor(() => doc.querySelectorAll('#documentTabs [role="tab"]').length === 2 &&
    doc.querySelector(".editor-shell").getAttribute("aria-busy") !== "true",
  "second document tab was not created");
  check(byId("documentTabs").querySelectorAll('[role="tab"][tabindex="0"]').length === 1,
    "document tablist exposed more than one sequential tab stop");
  check([...byId("documentTabs").querySelectorAll('.document-tab > button[aria-hidden="true"]')]
    .every((button) => button.tabIndex === -1), "document close actions polluted tablist navigation");
  const activeTab = byId("documentTabs").querySelector('[role="tab"][aria-selected="true"]');
  activeTab.focus();
  const priorTabIndex = [...byId("documentTabs").querySelectorAll('[role="tab"]')].indexOf(activeTab);
  activeTab.dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", {
    key: "ArrowLeft", bubbles: true, cancelable: true,
  }));
  await waitFor(() => {
    const selectedTab = byId("documentTabs").querySelector('[role="tab"][aria-selected="true"]');
    return doc.querySelector(".editor-shell").getAttribute("aria-busy") !== "true" &&
      [...byId("documentTabs").querySelectorAll('[role="tab"]')].indexOf(selectedTab) !== priorTabIndex &&
      doc.activeElement === selectedTab;
  }, "document-tab activation did not retain focus on the newly active tab");

  const errorReturn = doc.activeElement;
  const unsupported = new frame.contentWindow.File(["x"], "unsupported.txt", { type: "text/plain" });
  const unsupportedTransfer = new frame.contentWindow.DataTransfer(); unsupportedTransfer.items.add(unsupported);
  frame.contentWindow.dispatchEvent(new frame.contentWindow.DragEvent("drop", {
    dataTransfer: unsupportedTransfer, bubbles: true, cancelable: true,
  }));
  await waitFor(() => !byId("errorBanner").hidden && doc.activeElement === byId("dismissErrorButton"),
    "error banner did not move focus to its dismiss action");
  const dismissRect = byId("dismissErrorButton").getBoundingClientRect();
  check(dismissRect.top >= 0 && dismissRect.bottom <= frame.contentWindow.innerHeight,
    "focused error dismissal action was outside the viewport");
  byId("dismissErrorButton").click();
  await waitFor(() => byId("errorBanner").hidden && doc.activeElement === errorReturn,
    "dismissing an error did not return focus to the prior control");

  let diagnosticBlob = null; let diagnosticFilename = null;
  const originalCreateObjectUrl = frame.contentWindow.URL.createObjectURL;
  const originalRevokeObjectUrl = frame.contentWindow.URL.revokeObjectURL;
  const originalAnchorClick = frame.contentWindow.HTMLAnchorElement.prototype.click;
  frame.contentWindow.URL.createObjectURL = (blob) => { diagnosticBlob = blob; return "blob:diagnostic-smoke"; };
  frame.contentWindow.URL.revokeObjectURL = () => {};
  frame.contentWindow.HTMLAnchorElement.prototype.click = function () { diagnosticFilename = this.download; };
  byId("diagnosticsButton").focus(); byId("diagnosticsButton").click();
  await waitFor(() => byId("diagnosticsDialog").open, "Diagnostics dialog did not open");
  check(byId("diagnosticsDialogTitle").textContent === "Экспорт диагностики",
    "Diagnostics dialog bypassed Russian localization");
  check(byId("downloadDiagnosticsButton").disabled,
    "Diagnostics export was enabled without explicit consent");
  byId("diagnosticsConsentInput").click();
  check(!byId("downloadDiagnosticsButton").disabled,
    "Diagnostics consent did not enable local export");
  byId("downloadDiagnosticsButton").click();
  await waitFor(() => diagnosticBlob && !byId("diagnosticsDialog").open,
    "Diagnostics export did not create and close its local dialog");
  const diagnosticText = await diagnosticBlob.text();
  const diagnostic = JSON.parse(diagnosticText);
  check(diagnosticFilename === "patchy-diagnostics.json", "Diagnostics download name drifted");
  check(diagnostic.schema === "patchy.browser-diagnostics" && diagnostic.version === 1,
    "Diagnostics bundle schema drifted");
  check(Array.isArray(diagnostic.events) && diagnostic.events.length > 0 &&
    diagnostic.events.length <= 256, "Diagnostics timeline is empty or unbounded");
  check(diagnostic.document?.width === 1600 && diagnostic.document?.layers >= 1,
    "Diagnostics omitted anonymous document shape");
  check(!/one\.svg|two\.svg|unsupported\.txt|Drop a PSD|https?:|\/Users\//i.test(diagnosticText),
    "Diagnostics leaked a filename, error message, URL or path");
  check(doc.activeElement === byId("diagnosticsButton"),
    "Diagnostics close did not return focus to its invoker");
  frame.contentWindow.URL.createObjectURL = originalCreateObjectUrl;
  frame.contentWindow.URL.revokeObjectURL = originalRevokeObjectUrl;
  frame.contentWindow.HTMLAnchorElement.prototype.click = originalAnchorClick;

  frame.style.width = "520px"; await delay(80);
  check(doc.documentElement.scrollWidth <= doc.documentElement.clientWidth,
    "narrow shell introduced document-level horizontal overflow");
  check(doc.querySelector(".inspector").getBoundingClientRect().width > 0,
    "narrow-width policy made document panels unreachable");
  for (const id of ["brushSizeInput", "brushColorInput", "paintTargetSelect", "paintPresetSelect",
    "selectionToleranceInput", "edgeContrastInput"]) {
    check(byId(id).getClientRects().length, `narrow-width policy hid P0 tool control ${id}`);
  }
  const hasReducedMotionRule = [...doc.styleSheets].some((sheet) => {
    try { return [...sheet.cssRules].some((rule) => rule.conditionText?.includes("prefers-reduced-motion")); }
    catch { return false; }
  });
  check(hasReducedMotionRule, "staged browser CSS omitted reduced-motion policy");
  doc.documentElement.dataset.motion = "reduced";
  check(frame.contentWindow.getComputedStyle(doc.querySelector(".spinner")).animationName === "none",
    "reduced-motion activation left the progress animation running");
  doc.documentElement.style.zoom = "2"; frame.style.width = "1040px"; await delay(80);
  check(doc.documentElement.scrollWidth <= doc.documentElement.clientWidth,
    "200% zoom introduced document-level horizontal overflow");
  doc.documentElement.style.zoom = ""; frame.style.width = "520px";

  const unlabeled = [...doc.querySelectorAll("input, select, textarea")].filter((control) => {
    if (control.hidden || control.type === "hidden") return false;
    return !control.labels?.length && !control.getAttribute("aria-label") &&
      !control.getAttribute("aria-labelledby") && !control.title;
  });
  check(!unlabeled.length, `visible form controls lack names: ${unlabeled.map((item) => item.id).join(", ")}`);
  const undersized = [...doc.querySelectorAll('button:not([hidden]):not(:disabled), select:not([hidden]):not(:disabled), input[type="checkbox"]:not([hidden]):not(:disabled)')]
    .filter((control) => control.offsetParent !== null)
    .filter((control) => {
      const direct = control.getBoundingClientRect();
      const rect = control.type === "checkbox" && control.closest("label")
        ? control.closest("label").getBoundingClientRect() : direct;
      return rect.width < 24 || rect.height < 24;
    });
  check(!undersized.length, `visible pointer targets below 24px: ${undersized.map((item) => item.id || item.className).join(", ")}`);

  const samples = [];
  for (let index = 0; index < 160; ++index) {
    const before = performance.now(); byId("togglePanelsButton").click();
    const expected = String(index % 2 === 0);
    check(byId("togglePanelsButton").getAttribute("aria-pressed") === expected,
      "panel command did not synchronously publish state");
    samples.push(performance.now() - before);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * .95) - 1];
  check(p95 < 100, `non-render UI command p95 ${p95.toFixed(2)}ms exceeds 100ms`);

  byId("localeSelect").value = "en";
  byId("localeSelect").dispatchEvent(new frame.contentWindow.Event("change", { bubbles: true }));
  await waitFor(() => doc.documentElement.lang === "en" && byId("newButton").textContent.trim() === "New" &&
    !/[\u0400-\u04ff]/.test(byId("sessionIndicator").textContent),
  "switching back to English did not restore canonical static and dynamic strings");
  body.dataset.result = "PASS"; body.dataset.p95 = p95.toFixed(2);
  body.textContent = `PASS locale=ru-persisted keyboard=toolbar,layers,history,dialog diagnostics=private narrow=520 p95=${p95.toFixed(2)}ms`;
} catch (error) {
  body.dataset.result = "FAIL"; body.dataset.error = String(error?.stack || error);
  const failure = document.createElement("pre"); failure.textContent = body.dataset.error;
  body.prepend(failure);
}
