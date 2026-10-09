export const WORKSPACE_STORAGE_KEY = "patchy.workspace-deck.v1";

export const WORKSPACE_MODES = Object.freeze({
  editing: Object.freeze({ panel: "workspacePanelProperties", authoring: null }),
  painting: Object.freeze({ panel: "workspacePanelControls", authoring: "brush" }),
  typography: Object.freeze({ panel: "workspacePanelControls", authoring: "type" }),
  review: Object.freeze({ panel: "workspacePanelHistory", authoring: null }),
});

export function normalizeWorkspaceSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mode: "editing", panel: WORKSPACE_MODES.editing.panel, authoring: null };
  }
  if (Object.hasOwn(WORKSPACE_MODES, value.mode)) {
    const preset = WORKSPACE_MODES[value.mode];
    return { mode: value.mode, panel: preset.panel, authoring: preset.authoring };
  }
  if (typeof value.panel !== "string" || !/^workspacePanel[A-Z][A-Za-z]+$/.test(value.panel)) {
    return { mode: "editing", panel: WORKSPACE_MODES.editing.panel, authoring: null };
  }
  const panel = value.panel;
  const authoring = ["color", "brush", "type"].includes(value.authoring) ? value.authoring : null;
  return { mode: "custom", panel, authoring };
}

export function workspaceModeForState(panel, authoring = null) {
  for (const [mode, preset] of Object.entries(WORKSPACE_MODES)) {
    if (preset.panel === panel && preset.authoring === (panel === "workspacePanelControls" ? authoring : null)) return mode;
  }
  return "custom";
}

function loadSnapshot(storage) {
  try { return normalizeWorkspaceSnapshot(JSON.parse(storage?.getItem?.(WORKSPACE_STORAGE_KEY) || "null")); }
  catch { return normalizeWorkspaceSnapshot(null); }
}

function saveSnapshot(storage, snapshot) {
  try { storage?.setItem?.(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot)); } catch {
    /* Workspace persistence is optional and must never block editor startup. */
  }
}

export function installWorkspaceDeck(document, {
  activatePanel = () => false,
  selectAuthoring = () => "color",
} = {}) {
  const byId = (id) => document.getElementById(id);
  const shell = document.querySelector(".editor-shell");
  const select = byId("workspaceModeSelect");
  const reset = byId("workspaceResetButton");
  const collapse = byId("workspaceCollapseButton");
  if (!shell || !select || !reset || !collapse) return null;
  let storage = null;
  try { storage = document.defaultView?.localStorage; } catch { /* optional */ }
  let applying = false;
  let snapshot = loadSnapshot(storage);

  const render = () => {
    select.value = Object.hasOwn(WORKSPACE_MODES, snapshot.mode) ? snapshot.mode : "custom";
    shell.dataset.workspaceMode = select.value;
    collapse.setAttribute("aria-pressed", String(shell.classList.contains("panels-hidden")));
  };
  const persist = () => saveSnapshot(storage, snapshot);
  const applySnapshot = (next, { save = true } = {}) => {
    snapshot = normalizeWorkspaceSnapshot(next);
    applying = true;
    if (snapshot.authoring) selectAuthoring(snapshot.authoring);
    const tab = byId(`${snapshot.panel}Button`);
    const activated = Boolean(tab && activatePanel(tab));
    applying = false;
    if (!activated) {
      snapshot = normalizeWorkspaceSnapshot(null);
      activatePanel(byId(`${snapshot.panel}Button`));
    }
    if (save) persist();
    render();
    return snapshot;
  };
  const applyMode = (mode) => applySnapshot({ mode });

  select.addEventListener("change", () => {
    if (select.value === "custom") { render(); return; }
    applyMode(select.value);
  });
  reset.addEventListener("click", () => applyMode(select.value === "custom" ? "editing" : select.value));
  collapse.addEventListener("click", () => byId("togglePanelsButton")?.click());

  document.addEventListener("patchy:workspacepanelchange", (event) => {
    if (applying) return;
    const panel = event.detail?.target;
    const authoring = panel === "workspacePanelControls"
      ? byId("workspacePanelControls")?.dataset.authoringMode || "color" : null;
    snapshot = normalizeWorkspaceSnapshot({ mode: workspaceModeForState(panel, authoring), panel, authoring });
    persist(); render();
  });
  document.addEventListener("patchy:authoringtabchange", (event) => {
    if (applying || byId("workspacePanelControls")?.hidden) return;
    const panel = "workspacePanelControls";
    const authoring = event.detail?.tab || "color";
    snapshot = normalizeWorkspaceSnapshot({ mode: workspaceModeForState(panel, authoring), panel, authoring });
    persist(); render();
  });
  const Observer = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = Observer ? new Observer(render) : null;
  observer?.observe(shell, { attributes: true, attributeFilter: ["class"] });
  applySnapshot(snapshot, { save: false });
  return Object.freeze({ applyMode, applySnapshot, snapshot: () => ({ ...snapshot }), disconnect: () => observer?.disconnect() });
}
