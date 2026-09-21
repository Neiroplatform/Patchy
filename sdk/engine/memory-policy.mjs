const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export function browserWorkingSetLimit({ heapLimitBytes, deviceMemoryGiB } = {}) {
  const heapLimit = Number(heapLimitBytes);
  const deviceBytes = Number(deviceMemoryGiB) * GIB;
  const candidates = [3 * GIB];
  if (Number.isFinite(heapLimit) && heapLimit > 0) candidates.push(Math.floor(heapLimit * 0.7));
  if (Number.isFinite(deviceBytes) && deviceBytes > 0) candidates.push(Math.floor(deviceBytes * 0.5));
  return Math.min(...candidates);
}

export function documentPreflight({ sourceBytes = 0, width = 0, height = 0, limitBytes }) {
  const pixels = Number(width) * Number(height);
  if (![sourceBytes, width, height, limitBytes].every(Number.isFinite) ||
      sourceBytes < 0 || width < 0 || height < 0 || limitBytes <= 0 ||
      !Number.isSafeInteger(pixels)) {
    throw new TypeError("Document memory preflight requires safe non-negative dimensions and bytes");
  }
  const decodedBytes = pixels ? pixels * 8 : sourceBytes * 6;
  const estimatedBytes = Math.ceil(Math.max(sourceBytes + decodedBytes, decodedBytes + 64 * MIB));
  return { allowed: estimatedBytes <= limitBytes, estimatedBytes, limitBytes };
}

export function chooseRenderRegion({ width, height, dirtyRegion }, rendered) {
  const full = { x: 0, y: 0, width, height };
  if (!rendered || rendered.documentId !== rendered.currentDocumentId ||
      rendered.width !== width || rendered.height !== height) return full;
  if (!dirtyRegion) return null;
  const x = Math.max(0, dirtyRegion.x);
  const y = Math.max(0, dirtyRegion.y);
  const right = Math.min(width, dirtyRegion.x + dirtyRegion.width);
  const bottom = Math.min(height, dirtyRegion.y + dirtyRegion.height);
  if (right <= x || bottom <= y) return null;
  const region = { x, y, width: right - x, height: bottom - y };
  return region.width * region.height >= width * height * 0.6 ? full : region;
}

export { MIB };
