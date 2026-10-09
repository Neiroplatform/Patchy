const STRUCTURE_TABS = Object.freeze(["layers", "channels", "paths"]);

export function normalizeStructureTab(value) {
  return STRUCTURE_TABS.includes(value) ? value : "layers";
}

export function installStructureDeck(document, { activateLayersPanel = () => false } = {}) {
  const deck = document.getElementById("workspacePanelLayers");
  const tablist = deck?.querySelector(".document-structure-tabs");
  if (!deck || !tablist) return null;
  const tabs = [...tablist.querySelectorAll("[data-structure-tab]")];
  const panes = [...deck.querySelectorAll("[data-structure-pane]")];
  const select = (value, { focus = false, reveal = true } = {}) => {
    const selected = normalizeStructureTab(value);
    if (reveal) activateLayersPanel();
    for (const tab of tabs) {
      const active = tab.dataset.structureTab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const pane of panes) pane.hidden = pane.dataset.structurePane !== selected;
    deck.dataset.structureMode = selected;
    return selected;
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab.dataset.structureTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      select(tabs[index].dataset.structureTab, { focus: true });
    });
  }
  select("layers", { reveal: false });
  return Object.freeze({ select });
}
