const GROUPS = [
  { id: "file", label: "File", commands: [
    ["openButton", "Open…", "Ctrl+O"], ["newButton", "New document…"],
    ["saveButton", "Save", "Ctrl+S"], ["saveAsButton", "Save as…", "Ctrl+Shift+S"],
    ["exportButton", "Export…"], ["recoveryButton", "Recovery"],
    ["versionsButton", "Versions"], ["assetsButton", "Assets"],
    ["diagnosticsButton", "Diagnostics"],
  ] },
  { id: "edit", label: "Edit", commands: [
    ["undoButton", "Undo", "Ctrl+Z"], ["redoButton", "Redo", "Ctrl+Shift+Z"],
    ["copyPixelsButton", "Copy selected layer", "Ctrl+C"],
    ["cutPixelsButton", "Cut selected pixels", "Ctrl+X"],
    ["pastePixelsButton", "Paste layer or image", "Ctrl+V"],
  ] },
  { id: "image", label: "Image", commands: [
    ["transformButton", "Image and canvas size…"],
    ["cropToolButton", "Crop tool", "C"],
  ] },
  { id: "layer", label: "Layer", commands: [
    ["createPixelLayerButton", "New pixel layer", "Ctrl+Shift+N"],
    ["importLayerButton", "Import pixels…"], ["layerViaCopyButton", "Layer via copy", "Ctrl+J"],
    ["groupLayerButton", "Group layers"],
    ["ungroupLayerButton", "Ungroup layers"], ["removeLayerButton", "Delete layer"],
    ["textLayerButton", "Add text"], ["shapeLayerButton", "Add shape"],
    ["adjustmentLayerButton", "Add adjustment"],
    ["smartObjectButton", "Place Smart Object…"],
    ["openSmartObjectButton", "Open Smart Object contents"],
    ["layerTransformButton", "Transform…"],
    ["layerWarpButton", "Warp…"], ["arrangeLayersButton", "Arrange layers"],
    ["toggleClippingButton", "Create or release clipping mask"],
    ["createMaskButton", "Add layer mask"], ["createVectorMaskButton", "Add vector mask"],
    ["rasterizeLayerButton", "Rasterize layer"], ["mergeLayersButton", "Merge selected layers", "Ctrl+E"],
    ["mergeVisibleButton", "Merge visible copy"],
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
  { id: "filter", label: "Filter", commands: [
    ["filterLayerButton", "Pixel filters…"],
    ["smartFilterButton", "Smart Filter…"],
    ["liquifyLayerButton", "Liquify…"],
  ] },
  { id: "view", label: "View", commands: [
    ["zoomOutButton", "Zoom out", "−"], ["zoomFitButton", "Fit canvas", "0"],
    ["zoomActualButton", "Actual pixels", "1"], ["zoomInButton", "Zoom in", "+"],
    ["toggleGuidesButton", "Toggle guides"], ["toggleSnapButton", "Toggle snapping"],
  ] },
  { id: "window", label: "Window", commands: [
    ["togglePanelsButton", "Toggle panels"],
    ["workspacePanelLayersButton", "Layers"],
    ["workspacePanelPropertiesButton", "Properties"],
    ["workspacePanelHistoryButton", "History"],
    ["workspacePanelStructureButton", "Channels and paths"],
    ["workspacePanelInfoButton", "Document info"],
  ] },
  { id: "help", label: "Help", commands: [
    ["helpButton", "Getting started", "?"], ["systemCheckLink", "System check"],
  ] },
];

const MENU_SUBGROUPS = Object.freeze({
  image: [
    { label: "Geometry", targets: ["transformButton", "cropToolButton"] },
  ],
  layer: [
    { label: "Create", targets: ["createPixelLayerButton", "importLayerButton", "textLayerButton", "shapeLayerButton",
      "adjustmentLayerButton", "smartObjectButton"] },
    { label: "Transform", targets: ["layerTransformButton", "layerWarpButton", "arrangeLayersButton"] },
    { label: "Masks", targets: ["toggleClippingButton", "createMaskButton", "createVectorMaskButton"] },
  ],
  select: [
    { label: "Modify", targets: ["expandSelectionButton", "contractSelectionButton", "borderSelectionButton"] },
  ],
});

export const COMMAND_GROUPS = Object.freeze(GROUPS.map((group) => Object.freeze({
  ...group,
  commands: Object.freeze(group.commands.map(([targetId, label, shortcut = ""]) =>
    Object.freeze({ id: `${group.id}.${targetId}`, group: group.id, targetId, label, shortcut }))),
})));

function placeFloatingMenu(panel, anchor, { submenu = false } = {}) {
  panel.hidden = false;
  panel.style.visibility = "hidden";
  panel.style.left = "0px";
  panel.style.top = "0px";
  const anchorBox = anchor.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  const viewportWidth = panel.ownerDocument.defaultView?.innerWidth ?? panelBox.width;
  const viewportHeight = panel.ownerDocument.defaultView?.innerHeight ?? panelBox.height;
  const gap = submenu ? 5 : 3;
  const preferredLeft = submenu ? anchorBox.right + gap : anchorBox.left;
  const fallbackLeft = submenu ? anchorBox.left - panelBox.width - gap : preferredLeft;
  const left = preferredLeft + panelBox.width <= viewportWidth - 4
    ? preferredLeft : Math.max(4, Math.min(fallbackLeft, viewportWidth - panelBox.width - 4));
  const preferredTop = submenu ? anchorBox.top - 5 : anchorBox.bottom + gap;
  const top = Math.max(4, Math.min(preferredTop, viewportHeight - panelBox.height - 4));
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = "";
}

export const TOOL_GROUPS = Object.freeze([
  { id: "transform", label: "Move and crop tools", members: ["moveToolButton", "cropToolButton"] },
  { id: "selection", label: "Selection tools", members: ["marqueeToolButton", "lassoToolButton",
    "polygonToolButton", "magicToolButton", "quickSelectToolButton", "magneticToolButton", "quickMaskToolButton"] },
  { id: "paint", label: "Paint tools", members: ["brushToolButton", "mixerToolButton",
    "patternStampToolButton", "eraserToolButton"] },
  { id: "retouch", label: "Retouch tools", members: ["healToolButton", "spotHealingToolButton",
    "patchToolButton", "cloneToolButton"] },
  { id: "tone", label: "Local adjustment tools", members: ["smudgeToolButton", "dodgeToolButton",
    "burnToolButton", "spongeToolButton", "blurToolButton", "sharpenToolButton"] },
  { id: "fill", label: "Fill tools", members: ["gradientToolButton", "fillToolButton"] },
  { id: "draw", label: "Drawing tools", members: ["penToolButton", "textToolButton"] },
  { id: "navigation", label: "Navigation tools", members: ["panToolButton"] },
].map((group) => Object.freeze({ ...group, members: Object.freeze(group.members) })));

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

function installToolGroups(document, translate) {
  const rail = document.querySelector(".tool-rail");
  if (!rail || rail.dataset.grouped === "true") return null;
  rail.dataset.grouped = "true";
  const clusters = [];
  let openCluster = null;

  const closeCluster = ({ focus = false } = {}) => {
    const previous = openCluster;
    openCluster = null;
    for (const cluster of clusters) {
      cluster.wrapper.dataset.open = "false";
      cluster.toggle.setAttribute("aria-expanded", "false");
      cluster.menu.hidden = true;
      for (const button of cluster.secondary) button.hidden = true;
    }
    if (focus) previous?.toggle.focus();
  };

  const open = (cluster) => {
    closeCluster();
    openCluster = cluster;
    cluster.wrapper.dataset.open = "true";
    cluster.toggle.setAttribute("aria-expanded", "true");
    cluster.menu.hidden = false;
    for (const button of cluster.secondary) button.hidden = false;
    cluster.secondary[0]?.focus();
  };

  for (const group of TOOL_GROUPS) {
    const buttons = group.members.map((id) => document.getElementById(id)).filter(Boolean);
    if (!buttons.length) continue;
    const [primary, ...secondary] = buttons;
    const wrapper = document.createElement("div");
    wrapper.className = "tool-cluster";
    wrapper.dataset.toolGroup = group.id;
    wrapper.dataset.open = "false";
    primary.before(wrapper);
    wrapper.append(primary);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tool-group-toggle";
    toggle.textContent = "◢";
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "tool-group-menu";
    menu.id = `toolGroup-${group.id}`;
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    toggle.setAttribute("aria-controls", menu.id);
    const cluster = { group, wrapper, toggle, menu, primary, secondary, promote: null };
    clusters.push(cluster);
    const syncLabels = () => {
      const label = translate(group.label);
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
      menu.setAttribute("aria-label", label);
    };
    syncLabels();
    const promote = (button) => {
      if (button === cluster.primary || !buttons.includes(button)) return;
      cluster.primary = button;
      cluster.secondary = buttons.filter((item) => item !== button);
      button.hidden = false;
      button.removeAttribute("role");
      wrapper.insertBefore(button, toggle);
      menu.replaceChildren();
      for (const item of cluster.secondary) {
        item.hidden = true;
        item.setAttribute("role", "menuitem");
        menu.append(item);
      }
    };
    cluster.promote = promote;
    for (const button of buttons) {
      button.addEventListener("click", () => {
        promote(button);
        queueMicrotask(() => closeCluster());
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); closeCluster({ focus: true }); }
        else if (event.key === "ArrowRight" && button === cluster.primary) {
          event.preventDefault(); open(cluster);
        } else if (cluster.menu.contains(button) && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const available = [...cluster.menu.querySelectorAll(".tool-button:not([hidden])")];
          if (!available.length) return;
          event.preventDefault();
          const index = available.indexOf(button);
          const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 :
            (index + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
          available[next].focus();
        }
      });
    }
    for (const button of secondary) {
      button.hidden = true;
      button.setAttribute("role", "menuitem");
      menu.append(button);
    }
    wrapper.append(toggle, menu);
    toggle.addEventListener("click", () => openCluster === cluster ? closeCluster() : open(cluster));
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); open(cluster); }
      else if (event.key === "Escape") { event.preventDefault(); closeCluster(); }
    });
    document.addEventListener("patchy:localechange", syncLabels);
  }
  const spacer = rail.querySelector(".tool-spacer");
  for (const group of TOOL_GROUPS) {
    const cluster = clusters.find((entry) => entry.group.id === group.id);
    if (cluster) rail.insertBefore(cluster.wrapper, spacer);
  }
  document.addEventListener("click", (event) => {
    if (openCluster && !openCluster.wrapper.contains(event.target)) closeCluster();
  });
  return {
    close: closeCluster,
    promote(target) {
      const cluster = clusters.find((entry) => entry.primary === target || entry.secondary.includes(target));
      if (!cluster || !target) return false;
      cluster.promote(target);
      return true;
    },
  };
}

function installWorkspacePanels(document) {
  const shell = document.querySelector(".editor-shell");
  const tablist = document.querySelector(".workspace-panel-tabs");
  if (!shell || !tablist) return null;
  const tabs = [...tablist.querySelectorAll("[data-panel-target]")];
  const panels = [...document.querySelectorAll("[data-workspace-panel]")];
  const narrowViewport = document.defaultView?.matchMedia?.("(max-width: 820px)");
  const primaryTab = tabs.find((tab) => tab.hasAttribute("data-primary-tab"));
  const primaryPanel = panels.find((panel) => panel.hasAttribute("data-primary-panel"));
  const secondaryTabs = tabs.filter((tab) => tab !== primaryTab);
  let activeTab = secondaryTabs.find((tab) => tab.getAttribute("aria-selected") === "true") || secondaryTabs[0];
  let secondaryTarget = "workspacePanelProperties";
  const activate = (tab, { focus = false } = {}) => {
    const target = tab?.dataset.panelTarget;
    if (!target || !document.getElementById(target)) return false;
    const narrow = Boolean(narrowViewport?.matches);
    if (!narrow && tab === primaryTab) {
      shell.classList.remove("panels-hidden");
      primaryPanel.hidden = false;
      if (focus) primaryPanel.querySelector("button:not(:disabled), [tabindex='0']")?.focus();
      return true;
    }
    activeTab = tab;
    if (target !== "workspacePanelLayers") secondaryTarget = target;
    shell.classList.remove("panels-hidden");
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) {
      panel.hidden = narrow ? panel.id !== target :
        !(panel.hasAttribute("data-primary-panel") || panel.id === secondaryTarget);
    }
    shell.dataset.inspectorMode = narrow ? "single" : "dual";
    if (focus) tab.focus();
    return true;
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const available = tabs.filter((item) => !item.hidden);
      const index = available.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 :
        (index + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
      activate(available[next], { focus: true });
    });
  }
  const syncLayout = () => {
    const narrow = Boolean(narrowViewport?.matches);
    if (primaryTab) primaryTab.hidden = !narrow;
    if (primaryPanel) {
      primaryPanel.setAttribute("role", narrow ? "tabpanel" : "region");
      if (narrow) {
        primaryPanel.setAttribute("aria-labelledby", primaryTab.id);
        primaryPanel.removeAttribute("aria-label");
      } else {
        primaryPanel.removeAttribute("aria-labelledby");
        primaryPanel.setAttribute("aria-label", "Layers");
      }
    }
    if (!narrow && activeTab === primaryTab) {
      activeTab = secondaryTabs.find((tab) => tab.dataset.panelTarget === secondaryTarget) || secondaryTabs[0];
    }
    activate(activeTab);
  };
  narrowViewport?.addEventListener?.("change", syncLayout);
  syncLayout();
  return { activate };
}

export function installCommandSurface(document, { translate = (value) => value } = {}) {
  const menubar = document.getElementById("commandMenuBar");
  const dialog = document.getElementById("commandPalette");
  const paletteButton = document.getElementById("commandPaletteButton");
  const search = document.getElementById("commandSearchInput");
  const results = document.getElementById("commandResults");
  const close = document.getElementById("commandPaletteClose");
  if (!menubar || !dialog || !paletteButton || !search || !results || !close) return null;

  const toolGroups = installToolGroups(document, translate);
  const workspacePanels = installWorkspacePanels(document);

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
      for (const submenu of entry.menu.querySelectorAll(".command-submenu-panel")) submenu.hidden = true;
      for (const trigger of entry.menu.querySelectorAll(".command-submenu-trigger")) trigger.setAttribute("aria-expanded", "false");
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
    const focusTarget = dialog.open ? returnFocus : openGroup?.trigger;
    if (dialog.open) {
      returnFocus = null;
      dialog.close("command");
    }
    closeMenus();
    const stableFocus = focusTarget?.isConnected && !focusTarget.disabled ? focusTarget : paletteButton;
    stableFocus.focus({ preventScroll: true });
    command.target.click();
    return true;
  };

  const directMenuItems = (menu) => [...menu.children].map((child) =>
    child.matches?.('[role="menuitem"]') ? child : child.querySelector?.(":scope > .command-submenu-trigger"))
    .filter((item) => item && !item.disabled);

  const focusMenuItem = (menu, index) => {
    const available = directMenuItems(menu);
    if (!available.length) return;
    available[(index + available.length) % available.length].focus();
  };

  const openMenu = (entry, edge = "first") => {
    closeMenus();
    openGroup = entry;
    entry.trigger.setAttribute("aria-expanded", "true");
    placeFloatingMenu(entry.menu, entry.trigger);
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

    const appendCommand = (command, parent, { nested = false, submenuTrigger = null } = {}) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "command-menu-item";
      item.dataset.commandTarget = command.targetId;
      item.setAttribute("role", "menuitem");
      item.innerHTML = '<span class="command-label"></span><kbd class="command-shortcut"></kbd>';
      syncItem(item, command);
      item.addEventListener("click", () => runCommand(command));
      item.addEventListener("keydown", (event) => {
        const available = directMenuItems(parent);
        const index = available.indexOf(item);
        if (event.key === "ArrowDown") { event.preventDefault(); focusMenuItem(parent, index + 1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); focusMenuItem(parent, index - 1); }
        else if (event.key === "Home") { event.preventDefault(); focusMenuItem(parent, 0); }
        else if (event.key === "End") { event.preventDefault(); focusMenuItem(parent, -1); }
        else if (event.key === "Escape") { event.preventDefault(); closeMenus({ focus: true }); }
        else if (nested && event.key === "ArrowLeft") {
          event.preventDefault(); parent.hidden = true; submenuTrigger.setAttribute("aria-expanded", "false"); submenuTrigger.focus();
        } else if (!nested && event.key === "ArrowRight") { event.preventDefault(); moveTrigger(entry, 1, true); }
        else if (!nested && event.key === "ArrowLeft") { event.preventDefault(); moveTrigger(entry, -1, true); }
      });
      parent.append(item);
      menuItems.push({ item, command });
      return item;
    };

    const commands = descriptors.filter((item) => item.group === group.id);
    const subgroupDefinitions = MENU_SUBGROUPS[group.id] || [];
    const rendered = new Set();
    for (const command of commands) {
      const subgroup = subgroupDefinitions.find(({ targets }) => targets.includes(command.targetId));
      if (!subgroup) { appendCommand(command, menu); continue; }
      if (rendered.has(subgroup.label)) continue;
      rendered.add(subgroup.label);
      const holder = document.createElement("div"); holder.className = "command-submenu";
      const submenuTrigger = document.createElement("button"); submenuTrigger.type = "button";
      submenuTrigger.className = "command-menu-item command-submenu-trigger";
      submenuTrigger.dataset.label = subgroup.label;
      submenuTrigger.setAttribute("role", "menuitem"); submenuTrigger.setAttribute("aria-haspopup", "menu");
      submenuTrigger.setAttribute("aria-expanded", "false");
      submenuTrigger.innerHTML = `<span class="command-label">${translate(subgroup.label)}</span><span aria-hidden="true">›</span>`;
      const submenu = document.createElement("div"); submenu.className = "command-menu-panel command-submenu-panel";
      submenu.setAttribute("role", "menu"); submenu.setAttribute("aria-label", translate(subgroup.label)); submenu.hidden = true;
      const openSubmenu = () => {
        for (const panel of menu.querySelectorAll(".command-submenu-panel")) if (panel !== submenu) panel.hidden = true;
        for (const item of menu.querySelectorAll(".command-submenu-trigger")) if (item !== submenuTrigger) item.setAttribute("aria-expanded", "false");
        placeFloatingMenu(submenu, submenuTrigger, { submenu: true });
        submenuTrigger.setAttribute("aria-expanded", "true"); focusMenuItem(submenu, 0);
      };
      submenuTrigger.addEventListener("click", openSubmenu);
      submenuTrigger.addEventListener("keydown", (event) => {
        const available = directMenuItems(menu); const index = available.indexOf(submenuTrigger);
        if (["ArrowRight", "Enter", " "].includes(event.key)) { event.preventDefault(); openSubmenu(); }
        else if (event.key === "ArrowDown") { event.preventDefault(); focusMenuItem(menu, index + 1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); focusMenuItem(menu, index - 1); }
        else if (event.key === "Escape") { event.preventDefault(); closeMenus({ focus: true }); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); moveTrigger(entry, -1, true); }
      });
      for (const nestedCommand of commands.filter(({ targetId }) => subgroup.targets.includes(targetId))) {
        appendCommand(nestedCommand, submenu, { nested: true, submenuTrigger });
      }
      holder.append(submenuTrigger, submenu); menu.append(holder);
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
      for (const submenuTrigger of entry.menu.querySelectorAll(".command-submenu-trigger")) {
        submenuTrigger.querySelector(".command-label").textContent = translate(submenuTrigger.dataset.label);
        submenuTrigger.nextElementSibling?.setAttribute("aria-label", translate(submenuTrigger.dataset.label));
      }
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

  return { openPalette, closeMenus, toolGroups, workspacePanels, refresh: () => {
    for (const { item, command } of menuItems) syncItem(item, command);
    renderPalette();
  }, disconnect: () => observer?.disconnect() };
}
