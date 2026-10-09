const SAMPLE_SIDE = 256;
export const NAVIGATOR_SAMPLE_LIMIT = SAMPLE_SIDE ** 2;

export function containedRect(sourceWidth, sourceHeight, width, height, inset = 8) {
  if (!(sourceWidth > 0 && sourceHeight > 0 && width > inset * 2 && height > inset * 2)) return null;
  const scale = Math.min((width - inset * 2) / sourceWidth, (height - inset * 2) / sourceHeight);
  const w = sourceWidth * scale; const h = sourceHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h, scale };
}

export function navigatorDocumentPoint(point, rect, documentSize) {
  if (!rect || !documentSize) return null;
  return {
    x: Math.max(0, Math.min(documentSize.width, (point.x - rect.x) / rect.width * documentSize.width)),
    y: Math.max(0, Math.min(documentSize.height, (point.y - rect.y) / rect.height * documentSize.height)),
  };
}

export function installNavigatorPanel(document, { getZoom = () => 1, setZoom = () => {} } = {}) {
  const byId = (id) => document.getElementById(id);
  const source = byId("documentCanvas"); const viewport = byId("canvasViewport");
  const frame = byId("canvasFrame"); const navigator = byId("navigatorCanvas");
  const histogram = byId("histogramCanvas");
  if (!source || !viewport || !frame || !navigator || !histogram) return null;
  let destination = null; let scheduled = 0;

  const sizeCanvas = (canvas, cssHeight) => {
    const ratio = Math.min(2, Math.max(1, document.defaultView?.devicePixelRatio || 1));
    const width = Math.max(180, Math.round(canvas.getBoundingClientRect().width || 260));
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(cssHeight * ratio);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width, height: cssHeight };
  };
  const drawHistogram = () => {
    const sized = sizeCanvas(histogram, 150);
    if (!sized) return;
    const { context, width, height } = sized;
    context.clearRect(0, 0, width, height); context.fillStyle = "#101214"; context.fillRect(0, 0, width, height);
    context.strokeStyle = "#343a40"; context.lineWidth = 1; context.beginPath();
    for (const fraction of [.25, .5, .75]) {
      const x = Math.round(width * fraction) + .5;
      const y = Math.round(height * fraction) + .5;
      context.moveTo(x, 0); context.lineTo(x, height);
      context.moveTo(0, y); context.lineTo(width, y);
    }
    context.stroke();
    if (!source.width || !source.height) return;
    const scratch = document.createElement("canvas");
    const scale = Math.min(1, SAMPLE_SIDE / Math.max(source.width, source.height));
    scratch.width = Math.max(1, Math.round(source.width * scale)); scratch.height = Math.max(1, Math.round(source.height * scale));
    const sample = scratch.getContext("2d", { willReadFrequently: true });
    if (!sample) return;
    sample.drawImage(source, 0, 0, scratch.width, scratch.height);
    const pixels = sample.getImageData(0, 0, scratch.width, scratch.height).data;
    const bins = Array.from({ length: 4 }, () => new Uint32Array(256)); let peak = 1;
    for (let index = 0; index < pixels.length; index += 4) {
      if (!pixels[index + 3]) continue;
      for (let channel = 0; channel < 3; ++channel)
        peak = Math.max(peak, ++bins[channel][pixels[index + channel]]);
      const luminance = Math.round(pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722);
      peak = Math.max(peak, ++bins[3][luminance]);
    }
    for (const [channel, color] of ["#ff5b5b", "#62e572", "#5d8dff", "#e7ecef"].entries()) {
      context.strokeStyle = color; context.globalAlpha = .8; context.beginPath();
      for (let bin = 0; bin < 256; ++bin) {
        const x = bin / 255 * width; const y = height - bins[channel][bin] / peak * (height - 8) - 4;
        if (!bin) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
    context.globalAlpha = 1; histogram.dataset.samplePixels = String(scratch.width * scratch.height);
  };
  const draw = () => {
    scheduled = 0;
    const sized = sizeCanvas(navigator, 150);
    if (!sized) return;
    const { context, width, height } = sized;
    context.clearRect(0, 0, width, height); context.fillStyle = "#101214"; context.fillRect(0, 0, width, height);
    destination = containedRect(source.width, source.height, width, height);
    if (!destination) return;
    context.drawImage(source, destination.x, destination.y, destination.width, destination.height);
    const vr = viewport.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    const left = Math.max(vr.left, fr.left); const top = Math.max(vr.top, fr.top);
    const right = Math.min(vr.right, fr.right); const bottom = Math.min(vr.bottom, fr.bottom);
    if (right > left && bottom > top) {
      context.strokeStyle = "#ff5454"; context.lineWidth = 1.5;
      context.strokeRect(destination.x + (left - fr.left) / fr.width * destination.width,
        destination.y + (top - fr.top) / fr.height * destination.height,
        (right - left) / fr.width * destination.width, (bottom - top) / fr.height * destination.height);
    }
    navigator.dataset.preview = "ready";
    const zoom = Math.round(getZoom() * 100); byId("navigatorZoomInput").value = String(Math.max(6, Math.min(3200, zoom)));
    byId("navigatorZoomOutput").textContent = `${zoom}%`; drawHistogram();
  };
  const refresh = () => { if (!scheduled) scheduled = document.defaultView.requestAnimationFrame(draw); };
  const pan = (event) => {
    if (!destination || !source.width) return;
    const box = navigator.getBoundingClientRect();
    const point = navigatorDocumentPoint({ x: event.clientX - box.left, y: event.clientY - box.top }, destination,
      { width: source.width, height: source.height });
    const vr = viewport.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
    viewport.scrollBy({ left: fr.left + point.x / source.width * fr.width - (vr.left + vr.width / 2),
      top: fr.top + point.y / source.height * fr.height - (vr.top + vr.height / 2) });
    refresh();
  };
  navigator.addEventListener("pointerdown", (event) => {
    try { navigator.setPointerCapture(event.pointerId); } catch { /* Synthetic or cancelled pointers still pan once. */ }
    pan(event);
  });
  navigator.addEventListener("pointermove", (event) => { if (event.buttons & 1) pan(event); });
  navigator.addEventListener("pointerup", (event) => {
    try { if (navigator.hasPointerCapture(event.pointerId)) navigator.releasePointerCapture(event.pointerId); } catch { /* no active pointer */ }
  });
  viewport.addEventListener("scroll", refresh, { passive: true });
  document.addEventListener("patchy:workspacepanelchange", refresh);
  byId("navigatorFitButton").addEventListener("click", () => byId("zoomFitButton").click());
  byId("navigatorActualButton").addEventListener("click", () => byId("zoomActualButton").click());
  byId("navigatorDoubleButton").addEventListener("click", () => setZoom(2));
  byId("navigatorZoomInput").addEventListener("input", (event) => setZoom(Number(event.currentTarget.value) / 100));
  const tabs = [...document.querySelectorAll(".inspection-tabs [role=tab]")];
  const selectTab = (tab) => {
    for (const item of tabs) { const active = item === tab; item.setAttribute("aria-selected", String(active)); item.tabIndex = active ? 0 : -1; byId(item.getAttribute("aria-controls")).hidden = !active; }
    refresh();
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const current = tabs.indexOf(tab);
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[index]); tabs[index].focus();
    });
  }
  document.defaultView.addEventListener("resize", refresh); refresh();
  return Object.freeze({ refresh, sampleLimit: NAVIGATOR_SAMPLE_LIMIT });
}
