const finite = (value) => Number.isFinite(value);

export function normalizeGuides(guides, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return [];
  }
  const limits = { vertical: width, horizontal: height };
  const seen = new Set();
  const normalized = [];
  for (const guide of Array.isArray(guides) ? guides : []) {
    const orientation = guide?.orientation;
    const position = Math.round(Number(guide?.position));
    if (!(orientation in limits) || !finite(position) || position < 0 || position > limits[orientation]) continue;
    const key = `${orientation}:${position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ orientation, position });
  }
  return normalized.sort((left, right) =>
    left.orientation.localeCompare(right.orientation) || left.position - right.position);
}

function translatedQuad(quad, dx, dy) {
  return quad.map((value, index) => value + (index % 2 ? dy : dx));
}

function axisAnchors(quad, offset) {
  const values = [quad[offset], quad[offset + 2], quad[offset + 4], quad[offset + 6]];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return [minimum, (minimum + maximum) / 2, maximum];
}

function closestSnap(anchors, targets, threshold) {
  let best = null;
  for (const anchor of anchors) {
    for (const target of targets) {
      const delta = target - anchor;
      if (Math.abs(delta) > threshold) continue;
      if (best == null || Math.abs(delta) < Math.abs(best)) best = delta;
    }
  }
  return best ?? 0;
}

export function snapTranslatedQuad(originalQuad, dx, dy, guides, documentSize,
  { threshold = 6, bypass = false } = {}) {
  if (!Array.isArray(originalQuad) || originalQuad.length !== 8 ||
      originalQuad.some((value) => !finite(value)) || !finite(dx) || !finite(dy) ||
      !finite(threshold) || threshold < 0) {
    throw new TypeError("Snapping requires a finite four-corner quad, translation and threshold.");
  }
  if (bypass) {
    return { quad: translatedQuad(originalQuad, dx, dy), dx, dy, snappedX: null, snappedY: null };
  }
  const moved = translatedQuad(originalQuad, dx, dy);
  const normalized = normalizeGuides(guides, documentSize.width, documentSize.height);
  const vertical = [0, documentSize.width / 2, documentSize.width,
    ...normalized.filter((guide) => guide.orientation === "vertical").map((guide) => guide.position)];
  const horizontal = [0, documentSize.height / 2, documentSize.height,
    ...normalized.filter((guide) => guide.orientation === "horizontal").map((guide) => guide.position)];
  const adjustX = closestSnap(axisAnchors(moved, 0), vertical, threshold);
  const adjustY = closestSnap(axisAnchors(moved, 1), horizontal, threshold);
  return {
    quad: translatedQuad(moved, adjustX, adjustY),
    dx: dx + adjustX,
    dy: dy + adjustY,
    snappedX: adjustX ? dx + adjustX : null,
    snappedY: adjustY ? dy + adjustY : null,
  };
}
