const GROUPS = [
  { id: "file", label: "File", commands: [
    ["openButton", "Open…", "Ctrl+O"], ["newButton", "New document…"],
    ["saveButton", "Save", "Ctrl+S"], ["saveAsButton", "Save as…"],
    ["exportButton", "Export…"], ["recoveryButton", "Recovery"],
    ["versionsButton", "Versions"], ["assetsButton", "Assets"],
    ["diagnosticsButton", "Diagnostics"],
  ] },
  { id: "edit", label: "Edit", commands: [
    ["undoButton", "Undo", "Ctrl+Z"], ["redoButton", "Redo", "Ctrl+Shift+Z"],
    ["copyPixelsButton", "Copy selected layer", "Ctrl+C"],
    ["pastePixelsButton", "Paste layer or image", "Ctrl+V"],
  ] },
  { id: "layer", label: "Layer", commands: [
    ["importLayerButton", "Import pixels…"], ["groupLayerButton", "Group layers"],
    ["ungroupLayerButton", "Ungroup layers"], ["removeLayerButton", "Delete layer"],
    ["textLayerButton", "Add text"], ["shapeLayerButton", "Add shape"],
    ["adjustmentLayerButton", "Add adjustment"],
    ["smartObjectButton", "Place Smart Object…"],
    ["openSmartObjectButton", "Open Smart Object contents"],
    ["filterLayerButton", "Filters…"], ["smartFilterButton", "Smart Filter…"],
    ["liquifyLayerButton", "Liquify…"], ["layerTransformButton", "Transform…"],
    ["layerWarpButton", "Warp…"], ["arrangeLayersButton", "Arrange layers"],
    ["createMaskButton", "Add layer mask"], ["createVectorMaskButton", "Add vector mask"],
    ["rasterizeLayerButton", "Rasterize layer"], ["mergeVisibleButton", "Merge visible copy"],
  ] },
  { id: "select", label: "Select", commands: [
    ["selectAllButton", "Select all", "Ctrl+A"],
    ["clearSelectionButton", "Clear selection", "Ctrl+D"],
    ["invertSelectionButton", "Invert selection"],
    ["expandSelectionButton", "Expand selection"],
    ["contractSelectionButton", "Contract selection"],
    ["borderSelectionButton", "Border selection"],
    ["growSelectionButton", "Grow by color"],
    ["similarSelectionButton", "Select similar"],
    ["smoothSelectionButton", "Select and Mask…"],
  ] },
  { id: "view", label: "View", commands: [
    ["zoomOutButton", "Zoom out", "−"], ["zoomFitButton", "Fit canvas", "0"],
    ["zoomActualButton", "Actual pixels", "1"], ["zoomInButton", "Zoom in", "+"],
    ["toggleGuidesButton", "Toggle guides"], ["toggleSnapButton", "Toggle snapping"],
    ["togglePanelsButton", "Toggle panels"], ["transformButton", "Canvas size and rotation…"],
  ] },
  { id: "help", label: "Help", commands: [
    ["helpButton", "Getting started", "?"], ["systemCheckLink", "System check"],
  ] },
];

export const COMMAND_GROUPS = Object.freeze(GROUPS.map((group) => Object.freeze({
  ...group,
  commands: Object.freeze(group.commands.map(([targetId, label, shortcut = ""]) =>
    Object.freeze({ id: `${group.id}.${targetId}`, group: group.id, targetId, label, shortcut }))),
})));

const normalized = (value) => String(value ?? "").normalize("NFKD").toLocaleLowerCase().trim();

export function filterCommandItems(commands, query) {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [...commands];
  return commands.filter((command) => {
    const haystack = normalized(`${command.label} ${command.groupLabel} ${command.shortcut}`);
    return terms.every((term) => haystack.includes(term));
  });
}

function targetLabel(target, fallback) {
  return target?.getAttribute?.("aria-label")?.trim() ||
    (target?.childElementCount ? "" : target?.textContent?.replace(/\s+/g, " ").trim()) || fallback;
}

export function installCommandSurface(document, { translate = (value) => value } = {}) {
  const menubar = document.getElementById("commandMenuBar");
  const dialog = document.getElementById("commandPalette");
  const paletteButton = document.getElementById("commandPaletteButton");
  const search = document.getElementById("commandSearchInput");
  const results = document.getElementById("commandResults");
  const close = document.getElementById("commandPaletteClose");
  if (!menubar || !dialog || !paletteButton || !search || !results || !close) return null;

  let openGroup = null;
  let returnFocus = null;
  const triggers = [];
  const menuItems = [];
  const descriptors = COMMAND_GROUPS.flatMap((group) => group.commands.map((command) => ({
    ...command, groupLabel: group.label, target: document.getElementById(command.targetId),
  }))).filter((command) => command.target);

  const liveCommand = (command) => ({ ...command,
    label: targetLabel(command.target, translate(command.label)),
    groupLabel: translate(command.groupLabel),
  });
  const commandEnabled = (command) => !command.target.disabled && !command.target.hidden &&
    command.target.getAttribute?.("aria-disabled") !== "true";

  const closeMenus = ({ focus = false } = {}) => {
    const previous = openGroup;
    openGroup = null;
    for (const entry of triggers) {
      entry.trigger.setAttribute("aria-expanded", "false");
      entry.menu.hidden = true;
    }
    if (focus) previous?.trigger.focus();
  };

  const syncItem = (item, command) => {
    const current = liveCommand(command);
    item.querySelector(".command-label").textContent = current.label;
    item.querySelector(".command-shortcut").textContent = command.shortcut;
    item.disabled = !commandEnabled(command);
  };

  const runCommand = (command) => {
    if (!commandEnabled(command)) return false;
    closeMenus();
    if (dialog.open) dialog.close("command");
    command.target.click();
    return true;
  };

  const focusMenuItem = (menu, index) => {
    const available = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (!available.length) return;
    available[(index + available.length) % available.length].focus();
  };

  const openMenu = (entry, edge = "first") => {
    closeMenus();
    openGroup = entry;
    entry.trigger.setAttribute("aria-expanded", "true");
    entry.menu.hidden = false;
    for (const { item, command } of menuItems) syncItem(item, command);
    if (edge) focusMenuItem(entry.menu, edge === "last" ? -1 : 0);
  };

  const moveTrigger = (entry, delta, open = false) => {
    const index = triggers.indexOf(entry);
    const next = triggers[(index + delta + triggers.length) % triggers.length];
    if (open) openMenu(next, "first");
    else next.trigger.focus();
  };

  for (const group of COMMAND_GROUPS) {
    const wrapper = document.createElement("div");
    wrapper.className = "command-menu";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "command-menu-trigger";
    trigger.textContent = translate(group.label);
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "command-menu-panel";
    menu.id = `commandMenu-${group.id}`;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", translate(group.label));
    menu.hidden = true;
    trigger.setAttribute("aria-controls", menu.id);
    const entry = { group, trigger, menu };
    triggers.push(entry);

    for (const command of descriptors.filter((item) => item.group === group.id)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "command-menu-item";
      item.dataset.commandTarget = command.targetId;
      item.setAttribute("role", "menuitem");
      item.innerHTML = '<span class="command-label"></span><kbd class="command-shortcut"></kbd>';
      syncItem(item, command);
      item.addEventListener("click", () => runCommand(command));
      item.addEventListener("keydown", (event) => {
        const available = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
        const index = available.indexOf(item);
        if (event.key === "ArrowDown") { event.preventDefault(); focusMenuItem(menu, index + 1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); focusMenuItem(menu, index - 1); }
        else if (event.key === "Home") { event.preventDefault(); focusMenuItem(menu, 0); }
        else if (event.key === "End") { event.preventDefault(); focusMenuItem(menu, -1); }
        else if (event.key === "Escape") { event.preventDefault(); closeMenus({ focus: true }); }
        else if (event.key === "ArrowRight") { event.preventDefault(); moveTrigger(entry, 1, true); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); moveTrigger(entry, -1, true); }
      });
      menu.append(item);
      menuItems.push({ item, command });
    }

    trigger.addEventListener("click", () => openGroup === entry ? closeMenus() : openMenu(entry, null));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); openMenu(entry, "first"); }
      else if (event.key === "ArrowUp") { event.preventDefault(); openMenu(entry, "last"); }
      else if (event.key === "ArrowRight") { event.preventDefault(); moveTrigger(entry, 1); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); moveTrigger(entry, -1); }
      else if (event.key === "Escape") { event.preventDefault(); closeMenus(); }
    });
    wrapper.append(trigger, menu);
    menubar.insertBefore(wrapper, paletteButton);
  }

  const renderPalette = () => {
    const commands = descriptors.map(liveCommand);
    const filtered = filterCommandItems(commands, search.value).slice(0, 40);
    results.replaceChildren();
    for (const command of filtered) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "command-result";
      item.dataset.commandTarget = command.targetId;
      item.setAttribute("role", "option");
      item.disabled = !commandEnabled(command);
      item.innerHTML = `<span><small></small><strong></strong></span><kbd></kbd>`;
      item.querySelector("small").textContent = command.groupLabel;
      item.querySelector("strong").textContent = command.label;
      item.querySelector("kbd").textContent = command.shortcut;
      item.addEventListener("click", () => runCommand(command));
      results.append(item);
    }
    const empty = document.getElementById("commandEmptyState");
    empty.hidden = filtered.length > 0;
  };

  const openPalette = (invoker = document.activeElement) => {
    closeMenus();
    returnFocus = invoker;
    search.value = "";
    renderPalette();
    if (!dialog.open) dialog.showModal();
    queueMicrotask(() => search.focus());
  };

  search.addEventListener("input", renderPalette);
  paletteButton.addEventListener("click", () => openPalette(paletteButton));
  search.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown") return;
    const first = results.querySelector("button:not(:disabled)");
    if (first) { event.preventDefault(); first.focus(); }
  });
  results.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const available = [...results.querySelectorAll("button:not(:disabled)")];
    const index = available.indexOf(document.activeElement);
    if (!available.length) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 :
      (index + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
    available[next].focus();
  });
  close.addEventListener("click", () => dialog.close("cancel"));
  dialog.addEventListener("close", () => {
    const focusTarget = returnFocus;
    returnFocus = null;
    if (focusTarget?.isConnected && !focusTarget.disabled) queueMicrotask(() => focusTarget.focus());
  });
  document.addEventListener("click", (event) => {
    if (openGroup && !menubar.contains(event.target)) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    if (dialog.open) dialog.close("toggle"); else openPalette(event.target);
  });
  document.addEventListener("patchy:localechange", () => {
    for (const entry of triggers) {
      entry.trigger.textContent = translate(entry.group.label);
      entry.menu.setAttribute("aria-label", translate(entry.group.label));
    }
    renderPalette();
  });

  const Observer = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = Observer ? new Observer(() => {
    for (const { item, command } of menuItems) syncItem(item, command);
    if (dialog.open) renderPalette();
  }) : null;
  for (const command of descriptors) observer?.observe(command.target, {
    attributes: true, attributeFilter: ["disabled", "hidden", "aria-disabled", "aria-label"],
    childList: true, characterData: true, subtree: true,
  });

  return { openPalette, closeMenus, refresh: () => {
    for (const { item, command } of menuItems) syncItem(item, command);
    renderPalette();
  }, disconnect: () => observer?.disconnect() };
}
