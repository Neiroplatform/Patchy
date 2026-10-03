function intersect(left, right) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edgeX = Math.min(left.x + left.width, right.x + right.width);
  const edgeY = Math.min(left.y + left.height, right.y + right.height);
  return { x, y, width: Math.max(0, edgeX - x), height: Math.max(0, edgeY - y) };
}

export function copyLayerSelection({ layer, rgba, selectionMask, selectionBounds,
  documentWidth, documentHeight }) {
  if (!layer || layer.kind !== 0 || !layer.visible || !layer.bounds ||
      !(rgba instanceof Uint8Array) || !(selectionMask instanceof Uint8Array) ||
      !Number.isInteger(documentWidth) || !Number.isInteger(documentHeight) ||
      documentWidth <= 0 || documentHeight <= 0 ||
      selectionMask.byteLength !== documentWidth * documentHeight) {
    throw new TypeError("A visible pixel layer and complete document selection are required");
  }
  const bounds = layer.bounds;
  if (bounds.width <= 0 || bounds.height <= 0 || rgba.byteLength !== bounds.width * bounds.height * 4) {
    throw new TypeError("Selected layer pixels do not match their bounds");
  }
  const documentBounds = { x: 0, y: 0, width: documentWidth, height: documentHeight };
  const copyBounds = intersect(intersect(bounds, selectionBounds), documentBounds);
  if (copyBounds.width <= 0 || copyBounds.height <= 0) return null;

  const output = new Uint8Array(copyBounds.width * copyBounds.height * 4);
  let visible = false;
  for (let y = 0; y < copyBounds.height; ++y) {
    for (let x = 0; x < copyBounds.width; ++x) {
      const documentX = copyBounds.x + x;
      const documentY = copyBounds.y + y;
      const source = ((documentY - bounds.y) * bounds.width + documentX - bounds.x) * 4;
      const target = (y * copyBounds.width + x) * 4;
      const coverage = selectionMask[documentY * documentWidth + documentX];
      output[target] = rgba[source];
      output[target + 1] = rgba[source + 1];
      output[target + 2] = rgba[source + 2];
      output[target + 3] = Math.round(rgba[source + 3] * coverage / 255);
      visible ||= output[target + 3] !== 0;
    }
  }
  return visible ? { bounds: copyBounds, rgba: output } : null;
}
