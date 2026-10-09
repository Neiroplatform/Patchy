export const DOCK_LAYOUT_STORAGE_KEY = "patchy.dock-layout.v1";
export const DEFAULT_DOCK_LAYOUT = Object.freeze({ inspectorWidth: 316, primaryShare: 0.56 });

const WIDTH_MIN = 260;
const WIDTH_MAX = 520;
const SHARE_MIN = 0.30;
const SHARE_MAX = 0.70;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function normalizeDockLayout(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_DOCK_LAYOUT };
  const inspectorWidth = Number.isFinite(value.inspectorWidth)
    ? clamp(Math.round(value.inspectorWidth), WIDTH_MIN, WIDTH_MAX) : DEFAULT_DOCK_LAYOUT.inspectorWidth;
  const primaryShare = Number.isFinite(value.primaryShare)
    ? clamp(value.primaryShare, SHARE_MIN, SHARE_MAX) : DEFAULT_DOCK_LAYOUT.primaryShare;
  return { inspectorWidth, primaryShare: Math.round(primaryShare * 100) / 100 };
}

function loadLayout(storage) {
  try { return normalizeDockLayout(JSON.parse(storage?.getItem?.(DOCK_LAYOUT_STORAGE_KEY) || "null")); }
  catch { return { ...DEFAULT_DOCK_LAYOUT }; }
}

function saveLayout(storage, layout) {
  try { storage?.setItem?.(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch {
    /* Layout persistence is optional and must never block editor startup. */
  }
}

export function installDockLayout(document) {
  const view = document.defaultView;
  const root = document.documentElement;
  const inspector = document.getElementById("inspector");
  const widthSeparator = document.getElementById("inspectorResizer");
  const splitSeparator = document.getElementById("inspectorSplitResizer");
  const reset = document.getElementById("workspaceResetButton");
  if (!view || !root || !inspector || !widthSeparator || !splitSeparator || !reset) return null;
  let storage = null;
  try { storage = view.localStorage; } catch { /* optional */ }
  let layout = loadLayout(storage);
  const narrow = view.matchMedia("(max-width: 820px)");

  const desktopWidthMax = () => Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, view.innerWidth - 424));
  const render = () => {
    const appliedWidth = clamp(layout.inspectorWidth, WIDTH_MIN, desktopWidthMax());
    root.style.setProperty("--inspector-width", `${appliedWidth}px`);
    root.style.setProperty("--primary-panel-weight", `${layout.primaryShare}fr`);
    root.style.setProperty("--secondary-panel-weight", `${1 - layout.primaryShare}fr`);
    widthSeparator.setAttribute("aria-valuemin", String(WIDTH_MIN));
    widthSeparator.setAttribute("aria-valuemax", String(desktopWidthMax()));
    widthSeparator.setAttribute("aria-valuenow", String(appliedWidth));
    splitSeparator.setAttribute("aria-valuemin", String(Math.round(SHARE_MIN * 100)));
    splitSeparator.setAttribute("aria-valuemax", String(Math.round(SHARE_MAX * 100)));
    splitSeparator.setAttribute("aria-valuenow", String(Math.round(layout.primaryShare * 100)));
    for (const separator of [widthSeparator, splitSeparator]) {
      separator.tabIndex = narrow.matches ? -1 : 0;
      separator.setAttribute("aria-hidden", String(narrow.matches));
    }
  };
  const commit = (next, persist = true) => {
    layout = normalizeDockLayout(next);
    render();
    if (persist) saveLayout(storage, layout);
    return { ...layout };
  };
  const setWidth = (inspectorWidth, persist = true) => commit({ ...layout, inspectorWidth }, persist);
  const setShare = (primaryShare, persist = true) => commit({ ...layout, primaryShare }, persist);

  widthSeparator.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || narrow.matches) return;
    event.preventDefault();
    widthSeparator.setPointerCapture(event.pointerId);
    const move = (nextEvent) => setWidth(view.innerWidth - nextEvent.clientX, false);
    const finish = () => {
      saveLayout(storage, layout);
      widthSeparator.removeEventListener("pointermove", move);
      widthSeparator.removeEventListener("pointerup", finish);
      widthSeparator.removeEventListener("pointercancel", finish);
    };
    widthSeparator.addEventListener("pointermove", move);
    widthSeparator.addEventListener("pointerup", finish);
    widthSeparator.addEventListener("pointercancel", finish);
  });
  widthSeparator.addEventListener("keydown", (event) => {
    if (narrow.matches || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? 40 : 10;
    const width = event.key === "Home" ? WIDTH_MIN : event.key === "End" ? desktopWidthMax() :
      layout.inspectorWidth + (event.key === "ArrowLeft" ? delta : -delta);
    setWidth(width);
  });

  splitSeparator.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || narrow.matches) return;
    event.preventDefault();
    splitSeparator.setPointerCapture(event.pointerId);
    const move = (nextEvent) => {
      const box = inspector.getBoundingClientRect();
      const fixed = [...inspector.children].filter((node) => node !== splitSeparator && node !== widthSeparator &&
        !node.matches?.("[data-primary-panel], [data-secondary-panel]"))
        .reduce((height, node) => height + node.getBoundingClientRect().height, 0);
      const available = Math.max(1, box.height - fixed - splitSeparator.getBoundingClientRect().height);
      setShare((nextEvent.clientY - box.top) / available, false);
    };
    const finish = () => {
      saveLayout(storage, layout);
      splitSeparator.removeEventListener("pointermove", move);
      splitSeparator.removeEventListener("pointerup", finish);
      splitSeparator.removeEventListener("pointercancel", finish);
    };
    splitSeparator.addEventListener("pointermove", move);
    splitSeparator.addEventListener("pointerup", finish);
    splitSeparator.addEventListener("pointercancel", finish);
  });
  splitSeparator.addEventListener("keydown", (event) => {
    if (narrow.matches || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? 0.08 : 0.02;
    const share = event.key === "Home" ? SHARE_MIN : event.key === "End" ? SHARE_MAX :
      layout.primaryShare + (event.key === "ArrowDown" ? delta : -delta);
    setShare(share);
  });

  reset.addEventListener("click", () => commit(DEFAULT_DOCK_LAYOUT));
  const responsive = () => render();
  narrow.addEventListener?.("change", responsive);
  view.addEventListener("resize", responsive);
  render();
  return Object.freeze({
    reset: () => commit(DEFAULT_DOCK_LAYOUT),
    snapshot: () => ({ ...layout }),
    disconnect: () => {
      narrow.removeEventListener?.("change", responsive);
      view.removeEventListener("resize", responsive);
    },
  });
}
