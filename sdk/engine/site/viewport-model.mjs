const finite = (value) => Number.isFinite(value);

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export function clampZoom(value) {
  const zoom = Number(value);
  if (!finite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function fitZoom(documentSize, viewportSize, padding = 48) {
  const width = Number(documentSize?.width);
  const height = Number(documentSize?.height);
  const viewportWidth = Number(viewportSize?.width);
  const viewportHeight = Number(viewportSize?.height);
  const inset = finite(Number(padding)) ? Math.max(0, Number(padding)) : 48;
  if (![width, height, viewportWidth, viewportHeight].every((value) => finite(value) && value > 0)) {
    return 1;
  }
  return Math.min(1, clampZoom(Math.min(
    Math.max(1, viewportWidth - inset * 2) / width,
    Math.max(1, viewportHeight - inset * 2) / height,
  )));
}

export function anchoredScrollDelta(before, after, anchor) {
  const values = [before?.left, before?.top, before?.width, before?.height,
    after?.left, after?.top, after?.width, after?.height, anchor?.x, anchor?.y].map(Number);
  if (!values.every(finite) || before.width <= 0 || before.height <= 0 ||
      after.width <= 0 || after.height <= 0) return { x: 0, y: 0 };
  const documentX = (anchor.x - before.left) / before.width;
  const documentY = (anchor.y - before.top) / before.height;
  return {
    x: after.left + documentX * after.width - anchor.x,
    y: after.top + documentY * after.height - anchor.y,
  };
}

export function clampScrollPosition(position, contentSize, viewportSize) {
  const x = Number(position?.x);
  const y = Number(position?.y);
  const contentWidth = Number(contentSize?.width);
  const contentHeight = Number(contentSize?.height);
  const viewportWidth = Number(viewportSize?.width);
  const viewportHeight = Number(viewportSize?.height);
  const maxX = [contentWidth, viewportWidth].every(finite)
    ? Math.max(0, contentWidth - viewportWidth) : 0;
  const maxY = [contentHeight, viewportHeight].every(finite)
    ? Math.max(0, contentHeight - viewportHeight) : 0;
  return {
    x: finite(x) ? Math.min(maxX, Math.max(0, x)) : 0,
    y: finite(y) ? Math.min(maxY, Math.max(0, y)) : 0,
  };
}

export function rulerStep(zoom, minimumScreenSpacing = 56) {
  const scale = clampZoom(zoom);
  const required = Math.max(1, Number(minimumScreenSpacing) || 56) / scale;
  const magnitude = 10 ** Math.floor(Math.log10(required));
  for (const multiplier of [1, 2, 5, 10]) {
    const step = multiplier * magnitude;
    if (step >= required) return step;
  }
  return 10 * magnitude;
}

export function rulerTicks({ start, end, zoom, screenOrigin = 0, maximum = 512 }) {
  const first = Number(start);
  const last = Number(end);
  const scale = clampZoom(zoom);
  if (![first, last, screenOrigin].every(finite) || last < first) return [];
  const step = rulerStep(scale);
  const limit = Math.max(1, Math.min(2048, Math.trunc(Number(maximum) || 512)));
  const initial = Math.max(0, Math.ceil(first / step) * step);
  const ticks = [];
  for (let value = initial; value <= last && ticks.length < limit; value += step) {
    ticks.push({ value, screen: screenOrigin + (value - first) * scale, major: true });
  }
  return ticks;
}
