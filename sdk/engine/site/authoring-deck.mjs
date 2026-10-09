const BUILTIN_SWATCHES = Object.freeze([
  "#000000", "#ffffff", "#7f7f7f", "#c3c3c3", "#7f0000", "#ff0000",
  "#7f3f00", "#ff7f00", "#7f7f00", "#ffff00", "#007f00", "#00c853",
  "#007f7f", "#00ffff", "#00007f", "#0057ff", "#3f007f", "#7f00ff",
  "#7f007f", "#ff00ff", "#7f003f", "#ff4f81", "#5c4033", "#f3d7b3",
]);

const RECENT_STORAGE_KEY = "patchy.authoring-recent-colors.v1";
const LIBRARY_TABS = Object.freeze(["color", "swatches", "gradients", "patterns"]);

export function normalizeAuthoringTab(value) {
  return ["color", "brush", "type"].includes(value) ? value : "color";
}

export function normalizeAuthoringLibraryTab(value) {
  return LIBRARY_TABS.includes(value) ? value : "color";
}

const validColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;

export function gradientPreviewCss(preset, foreground = "#111111", metadata = {}) {
  const fg = validColor(foreground, "#111111");
  if (metadata.previewKind === "foreground-transparent" || preset === "foreground-transparent")
    return `linear-gradient(90deg, ${fg}, transparent), repeating-conic-gradient(#c9c9c9 0 25%, #fff 0 50%) 0 0 / 10px 10px`;
  const builtins = {
    "black-white": ["#000000", "#ffffff"],
    sunset: ["#ff3d77", "#ff9a3d", "#ffe66d"],
    ocean: ["#082f49", "#0284c7", "#67e8f9"],
  };
  const colors = [metadata.previewStart, metadata.previewMiddle, metadata.previewEnd].filter(Boolean)
    .map((color) => validColor(color, fg));
  const stops = colors.length >= 2 ? colors : (builtins[preset] || [fg, "#ffffff"]);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export function patternPreviewCss(kind, foreground = "#111111", background = "#ffffff") {
  const fg = validColor(foreground, "#111111");
  const bg = validColor(background, "#ffffff");
  return kind === "dots"
    ? `radial-gradient(circle, ${fg} 0 24%, transparent 26%), linear-gradient(${bg}, ${bg})`
    : `conic-gradient(${fg} 0 25%, ${bg} 0 50%, ${fg} 0 75%, ${bg} 0)`;
}

export function swatchTargetFromModifiers(event = {}) {
  return event.altKey || event.metaKey || event.ctrlKey ? "background" : "foreground";
}

export function brushPreviewModel(values = {}) {
  const number = (key, fallback, min, max) => Math.max(min, Math.min(max,
    Number.isFinite(Number(values[key])) ? Number(values[key]) : fallback));
  return Object.freeze({
    size: number("size", 24, 1, 4096),
    hardness: number("hardness", 100, 0, 100),
    spacing: number("spacing", 25, 1, 1000),
    angle: number("angle", 0, -180, 180),
    roundness: number("roundness", 100, 1, 100),
    color: /^#[0-9a-f]{6}$/i.test(values.color || "") ? values.color : "#111111",
  });
}

function readRecentColors(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(RECENT_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 12) : [];
  } catch { return []; }
}

function writeRecentColors(storage, colors) {
  try { storage?.setItem?.(RECENT_STORAGE_KEY, JSON.stringify(colors.slice(0, 12))); } catch {
    /* A blocked preference store must not disable authoring controls. */
  }
}

function emitInput(input, value) {
  if (!input) return;
  input.value = value;
  const InputEvent = input.ownerDocument.defaultView.Event;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  input.dispatchEvent(new InputEvent("change", { bubbles: true }));
}

function installRovingTabs(container, selector, activate) {
  container?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) ||
        !event.target.matches(selector)) return;
    const tabs = [...container.querySelectorAll(selector)];
    const current = tabs.indexOf(event.target);
    const backwards = ["ArrowLeft", "ArrowUp"].includes(event.key);
    const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
      (current + (backwards ? -1 : 1) + tabs.length) % tabs.length;
    event.preventDefault();
    activate(tabs[index].dataset.authoringTab || tabs[index].dataset.brushSection || tabs[index].dataset.libraryTab);
    tabs[index].focus();
  });
}

function drawBrushPreview(document, canvas) {
  if (!canvas) return;
  const model = brushPreviewModel({
    size: document.getElementById("brushSizeInput")?.value,
    hardness: 100 - Number(document.getElementById("brushSoftnessInput")?.value || 0),
    spacing: document.getElementById("brushSpacingInput")?.value,
    angle: document.getElementById("brushAngleInput")?.value,
    roundness: document.getElementById("brushRoundnessInput")?.value,
    color: document.getElementById("brushColorInput")?.value,
  });
  const scale = document.defaultView?.devicePixelRatio || 1;
  const width = Math.max(220, Math.round(canvas.getBoundingClientRect().width || 260));
  const height = 76;
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#101214"; context.fillRect(0, 0, width, height);
  const radius = Math.max(2, Math.min(27, model.size / 2));
  const step = Math.max(2, radius * 2 * model.spacing / 100);
  context.save();
  context.translate(18, height / 2);
  for (let x = 0; x <= width - 36; x += step) {
    context.save(); context.translate(x, 0); context.rotate(model.angle * Math.PI / 180);
    context.scale(1, model.roundness / 100);
    if (model.hardness >= 99) { context.fillStyle = model.color; }
    else {
      const gradient = context.createRadialGradient(0, 0, radius * model.hardness / 100, 0, 0, radius);
      gradient.addColorStop(0, model.color); gradient.addColorStop(1, `${model.color}00`);
      context.fillStyle = gradient;
    }
    context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill(); context.restore();
  }
  context.restore();
  canvas.dataset.previewSignature = `${model.size}:${model.hardness}:${model.spacing}:${model.angle}:${model.roundness}:${model.color}`;
}

export function installAuthoringDeck(document, { activateWorkspacePanel = () => {}, translate = (value) => value } = {}) {
  const byId = (id) => document.getElementById(id);
  const deck = byId("workspacePanelControls");
  if (!deck) return null;
  let storage = null;
  try { storage = document.defaultView?.localStorage; } catch { /* optional */ }
  let recentColors = readRecentColors(storage);
  const foreground = byId("foregroundSwatchInput");
  const background = byId("backgroundSwatchInput");
  const deckForeground = byId("authoringForegroundInput");
  const deckBackground = byId("authoringBackgroundInput");
  const recentGrid = byId("authoringRecentSwatches");
  const swatchGrid = byId("authoringSwatches");
  const gradientGrid = byId("authoringGradientPresets");
  const patternGrid = byId("authoringPatternPresets");
  const paintPreset = byId("paintPresetSelect");
  const advancedPattern = byId("advancedPatternInput");

  const syncColors = () => {
    deckForeground.value = foreground.value;
    deckBackground.value = background.value;
  };
  const renderSwatches = (container, colors) => {
    container.replaceChildren(...colors.map((color) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "color-swatch"; button.dataset.color = color;
      button.style.setProperty("--swatch-color", color); button.setAttribute("aria-label", color);
      button.title = color; return button;
    }));
  };
  const renderRecent = () => {
    renderSwatches(recentGrid, recentColors);
    recentGrid.toggleAttribute("data-empty", !recentColors.length);
    if (!recentColors.length) {
      const empty = document.createElement("span"); empty.className = "swatch-empty";
      empty.textContent = translate("No recent colors"); recentGrid.append(empty);
    }
  };
  const remember = (color) => {
    recentColors = [color, ...recentColors.filter((entry) => entry !== color)].slice(0, 12);
    writeRecentColors(storage, recentColors); renderRecent();
  };
  const applyColor = (target, color) => {
    emitInput(target === "background" ? background : foreground, color);
    syncColors(); remember(color);
  };
  renderSwatches(swatchGrid, BUILTIN_SWATCHES); renderRecent(); syncColors();
  for (const grid of [recentGrid, swatchGrid]) grid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-color]");
    if (button) applyColor(swatchTargetFromModifiers(event), button.dataset.color);
  });
  deckForeground.addEventListener("input", () => applyColor("foreground", deckForeground.value));
  deckBackground.addEventListener("input", () => applyColor("background", deckBackground.value));
  foreground.addEventListener("input", syncColors); background.addEventListener("input", syncColors);
  byId("authoringSwapColorsButton").addEventListener("click", () => {
    byId("swapSwatchesButton").click(); syncColors(); remember(foreground.value); remember(background.value);
  });
  byId("authoringDefaultColorsButton").addEventListener("click", () => {
    byId("defaultSwatchesButton").click(); syncColors(); remember(foreground.value); remember(background.value);
  });

  const presetButton = (option, kind) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "preset-library-item";
    button.dataset.preset = option.value;
    button.setAttribute("aria-selected", String(option.selected));
    const preview = document.createElement("span");
    preview.className = `preset-library-preview ${kind}-library-preview`;
    if (kind === "gradient") {
      preview.style.setProperty("--preset-gradient", gradientPreviewCss(option.value, foreground.value, option.dataset));
    } else {
      preview.style.setProperty("--preset-pattern", patternPreviewCss(option.dataset.previewKind || option.value,
        option.dataset.previewForeground, option.dataset.previewBackground));
      preview.style.setProperty("--preset-size", `${Math.max(4, Math.min(32, Number(option.dataset.previewSize) || 8))}px`);
    }
    const name = document.createElement("span"); name.className = "preset-library-name";
    name.textContent = option.textContent.replace(/^(Gradient|Pattern):\s*/, "");
    button.setAttribute("aria-label", option.textContent); button.title = option.textContent;
    button.append(preview, name); return button;
  };
  const renderPresetLibraries = () => {
    const gradients = [...paintPreset.options].filter((option) => option.dataset.presetKind === "gradient");
    gradientGrid.replaceChildren(...gradients.map((option) => presetButton(option, "gradient")));
    patternGrid.replaceChildren(...[...advancedPattern.options].map((option) => presetButton(option, "pattern")));
  };
  const syncPresetSelection = () => {
    for (const button of gradientGrid.querySelectorAll("[data-preset]"))
      button.setAttribute("aria-selected", String(button.dataset.preset === paintPreset.value));
    for (const button of patternGrid.querySelectorAll("[data-preset]"))
      button.setAttribute("aria-selected", String(button.dataset.preset === advancedPattern.value));
  };
  gradientGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) return;
    byId("gradientToolButton").click(); emitInput(paintPreset, button.dataset.preset); syncPresetSelection();
  });
  patternGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) return;
    byId("patternStampToolButton").click(); emitInput(advancedPattern, button.dataset.preset); syncPresetSelection();
  });
  paintPreset.addEventListener("change", syncPresetSelection);
  advancedPattern.addEventListener("change", syncPresetSelection);
  const presetObserver = new document.defaultView.MutationObserver(renderPresetLibraries);
  presetObserver.observe(paintPreset, { childList: true, subtree: true, attributes: true });
  presetObserver.observe(advancedPattern, { childList: true, subtree: true, attributes: true });
  foreground.addEventListener("input", renderPresetLibraries);
  renderPresetLibraries(); syncPresetSelection();

  const brushDialog = byId("brushSettingsDialog");
  const brushForm = brushDialog.querySelector("form");
  const brushSections = [...brushForm.querySelectorAll(":scope > section")];
  const brushLayout = document.createElement("div"); brushLayout.className = "brush-settings-layout";
  const brushNavigation = document.createElement("div"); brushNavigation.className = "brush-section-navigation";
  brushNavigation.setAttribute("role", "tablist");
  brushNavigation.setAttribute("aria-label", translate("Brush setting categories"));
  const brushBody = document.createElement("div"); brushBody.className = "brush-section-body";
  const preview = document.createElement("canvas"); preview.id = "authoringBrushPreview";
  preview.className = "brush-live-preview"; preview.setAttribute("aria-label", translate("Brush preview"));
  brushForm.insertBefore(preview, brushSections[0]);
  brushForm.insertBefore(brushLayout, brushSections[0]); brushLayout.append(brushNavigation, brushBody);
  const optionalSectionInputs = [null, null, null, byId("brushTextureEnabledInput"), byId("brushColorDynamicsEnabledInput")];
  const selectBrushSection = (value) => {
    const index = Math.max(0, brushSections.findIndex((section) => section.dataset.brushSection === value));
    brushSections.forEach((section, candidate) => { section.hidden = candidate !== index; });
    [...brushNavigation.children].forEach((button, candidate) => {
      button.setAttribute("aria-selected", String(candidate === index)); button.tabIndex = candidate === index ? 0 : -1;
    });
  };
  brushSections.forEach((section, index) => {
    const id = `brush-section-${index}`; const buttonId = `brush-section-tab-${index}`;
    section.dataset.brushSection = id; section.id = id; section.setAttribute("role", "tabpanel");
    section.setAttribute("aria-labelledby", buttonId); brushBody.append(section);
    const button = document.createElement("button"); button.type = "button"; button.dataset.brushSection = id;
    button.id = buttonId;
    button.setAttribute("role", "tab"); button.setAttribute("aria-controls", id);
    button.innerHTML = `<span>${section.querySelector("h3")?.textContent || `Section ${index + 1}`}</span><i aria-hidden="true"></i>`;
    button.addEventListener("click", () => selectBrushSection(id)); brushNavigation.append(button);
    const syncEnabled = () => {
      const enabled = optionalSectionInputs[index]?.checked !== false;
      button.dataset.enabled = String(enabled);
      button.setAttribute("aria-description", translate(enabled ? "Enabled" : "Disabled"));
    };
    optionalSectionInputs[index]?.addEventListener("input", syncEnabled); syncEnabled();
  });
  selectBrushSection(brushSections[0].dataset.brushSection);
  installRovingTabs(brushNavigation, "[data-brush-section]", selectBrushSection);
  byId("authoringBrushHost").append(brushDialog);
  const previewInputIds = ["brushSizeInput", "brushSoftnessInput", "brushSpacingInput", "brushAngleInput",
    "brushRoundnessInput", "brushColorInput"];
  const refreshPreview = () => drawBrushPreview(document, preview);
  for (const id of previewInputIds) byId(id)?.addEventListener("input", refreshPreview);
  document.defaultView?.addEventListener("resize", refreshPreview); refreshPreview();

  const textSettings = byId("textSettingsPopover");
  byId("authoringTypeHost").append(textSettings);

  const select = (value, { focus = false } = {}) => {
    const selected = normalizeAuthoringTab(value);
    for (const tab of deck.querySelectorAll("[data-authoring-tab]")) {
      const active = tab.dataset.authoringTab === selected;
      tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const pane of deck.querySelectorAll("[data-authoring-pane]")) pane.hidden = pane.dataset.authoringPane !== selected;
    deck.dataset.authoringMode = selected;
    if (selected === "brush") {
      if (!brushDialog.open) brushDialog.show();
      document.defaultView?.requestAnimationFrame(refreshPreview);
    }
    if (selected === "type") textSettings.hidden = false;
    document.dispatchEvent(new document.defaultView.CustomEvent("patchy:authoringtabchange", {
      detail: { tab: selected },
    }));
    return selected;
  };
  for (const tab of deck.querySelectorAll("[data-authoring-tab]")) tab.addEventListener("click", () => select(tab.dataset.authoringTab));
  installRovingTabs(deck.querySelector(".authoring-tabs"), "[data-authoring-tab]", select);

  const selectLibrary = (value, { focus = false } = {}) => {
    const selected = normalizeAuthoringLibraryTab(value);
    for (const tab of deck.querySelectorAll("[data-library-tab]")) {
      const active = tab.dataset.libraryTab === selected;
      tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const pane of deck.querySelectorAll("[data-library-pane]")) pane.hidden = pane.dataset.libraryPane !== selected;
    deck.dataset.libraryMode = selected;
    return selected;
  };
  for (const tab of deck.querySelectorAll("[data-library-tab]")) tab.addEventListener("click", () => {
    activateWorkspacePanel(); select("color"); selectLibrary(tab.dataset.libraryTab);
  });
  installRovingTabs(deck.querySelector(".color-library-tabs"), "[data-library-tab]", selectLibrary);
  selectLibrary("color");

  const reveal = (tab) => { activateWorkspacePanel(); return select(tab); };
  return Object.freeze({ select, selectLibrary, reveal, syncColors, refreshPreview, renderPresetLibraries });
}
