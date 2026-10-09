const HISTORY_TABS = Object.freeze(["history", "versions", "recovery"]);

export function normalizeHistoryTab(value) {
  return HISTORY_TABS.includes(value) ? value : "history";
}

export function installHistoryDeck(document, {
  activateHistoryPanel = () => false,
  showVersions = () => false,
  showRecovery = () => false,
} = {}) {
  const deck = document.getElementById("workspacePanelHistory");
  const tablist = deck?.querySelector(".history-deck-tabs");
  const historyPane = document.getElementById("historyHistoryPane");
  const versionDialog = document.getElementById("versionHistoryDialog");
  const recoveryDialog = document.getElementById("recoveryDialog");
  if (!deck || !tablist || !historyPane || !versionDialog || !recoveryDialog) return null;
  const tabs = [...tablist.querySelectorAll("[data-history-tab]")];
  for (const dialog of [versionDialog, recoveryDialog]) {
    dialog.classList.add("history-dock-dialog");
    deck.append(dialog);
  }

  const select = (value, { focus = false, reveal = true } = {}) => {
    const selected = normalizeHistoryTab(value);
    if (reveal) activateHistoryPanel();
    for (const tab of tabs) {
      const active = tab.dataset.historyTab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    historyPane.hidden = selected !== "history";
    deck.dataset.historyMode = selected;
    if (selected !== "versions" && versionDialog.open) versionDialog.close("switch");
    if (selected !== "recovery" && recoveryDialog.open) recoveryDialog.close("switch");
    if (selected === "versions") showVersions();
    if (selected === "recovery") showRecovery();
    return selected;
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab.dataset.historyTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      select(tabs[index].dataset.historyTab, { focus: true });
    });
  }
  for (const dialog of [versionDialog, recoveryDialog]) {
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "switch") return;
      if (deck.dataset.historyMode !== "history") select("history", { focus: true });
    });
  }
  select("history", { reveal: false });
  return Object.freeze({ select });
}
