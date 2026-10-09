const PROPERTY_TABS = Object.freeze(["properties", "adjustments"]);

export function normalizePropertiesTab(value) {
  return PROPERTY_TABS.includes(value) ? value : "properties";
}

export function installPropertiesDeck(document, {
  activatePropertiesPanel = () => false,
  openAdjustmentPreset = () => false,
} = {}) {
  const deck = document.getElementById("workspacePanelProperties");
  const tablist = deck?.querySelector(".properties-deck-tabs");
  if (!deck || !tablist) return null;
  const tabs = [...tablist.querySelectorAll("[data-properties-tab]")];
  const panes = [...deck.querySelectorAll("[data-properties-pane]")];
  const contextualEditors = [...deck.querySelectorAll(".context-editor-dialog")];
  const presets = [...deck.querySelectorAll("[data-adjustment-preset]")];

  const select = (value, { focus = false, reveal = true } = {}) => {
    const selected = normalizePropertiesTab(value);
    if (selected === "adjustments") {
      for (const dialog of contextualEditors) if (dialog.open) dialog.close("switch");
    }
    if (reveal) activatePropertiesPanel();
    for (const tab of tabs) {
      const active = tab.dataset.propertiesTab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const pane of panes) pane.hidden = pane.dataset.propertiesPane !== selected;
    deck.dataset.propertiesMode = selected;
    return selected;
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab.dataset.propertiesTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      select(tabs[index].dataset.propertiesTab, { focus: true });
    });
  }

  for (const preset of presets) {
    preset.addEventListener("click", () => {
      const kind = Number(preset.dataset.adjustmentPreset);
      if (!Number.isInteger(kind) || kind < 0 || kind > 7) return;
      if (openAdjustmentPreset(kind) === false) return;
      for (const item of presets) item.setAttribute("aria-selected", String(item === preset));
    });
  }

  select("properties", { reveal: false });
  return Object.freeze({ select });
}
