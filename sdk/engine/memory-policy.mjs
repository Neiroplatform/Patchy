const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

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

export function validateInt32Rect(rect) {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
      rect.x < INT32_MIN || rect.x > INT32_MAX || rect.y < INT32_MIN || rect.y > INT32_MAX ||
      rect.width <= 0 || rect.width > INT32_MAX || rect.height <= 0 || rect.height > INT32_MAX) {
    throw new TypeError("Rectangle must use signed 32-bit coordinates and positive dimensions");
  }
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (!Number.isSafeInteger(right) || !Number.isSafeInteger(bottom) ||
      right < INT32_MIN || right > INT32_MAX || bottom < INT32_MIN || bottom > INT32_MAX) {
    throw new RangeError("Rectangle edges must fit signed 32-bit coordinates");
  }
  return { ...rect, right, bottom };
}

export function layeredGeometrySize(width, height, format = "psd") {
  if (format !== "psd" && format !== "psb") {
    throw new TypeError("Layered document format must be psd or psb");
  }
  const limit = format === "psb" ? 300000 : 30000;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 || width > limit || height > limit) {
    throw new RangeError(`${format.toUpperCase()} dimensions must be between 1 and ${limit} pixels`);
  }
  return { width, height, format, limit };
}

export function rotatedGeometrySize(width, height, clockwiseDegrees) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
      width > INT32_MAX || height > INT32_MAX || !Number.isFinite(clockwiseDegrees)) {
    throw new TypeError("Rotation requires positive 32-bit dimensions and a finite angle");
  }
  const normalized = clockwiseDegrees % 360;
  if (Math.abs(normalized) < .01) return { width, height };
  if (Math.abs(normalized - 90) < .01 || Math.abs(normalized + 270) < .01 ||
      Math.abs(normalized + 90) < .01 || Math.abs(normalized - 270) < .01) {
    return { width: height, height: width };
  }
  const radians = normalized * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const rotatedWidth = Math.max(1, Math.round(width * cos + height * sin));
  const rotatedHeight = Math.max(1, Math.round(width * sin + height * cos));
  if (rotatedWidth > INT32_MAX || rotatedHeight > INT32_MAX) {
    throw new RangeError("Rotated document dimensions exceed signed 32-bit storage");
  }
  return { width: rotatedWidth, height: rotatedHeight };
}

export function cropGeometrySize(crop, { clipToCanvas = true, canvasWidth, canvasHeight } = {}) {
  const validated = validateInt32Rect(crop);
  if (!clipToCanvas) return { width: crop.width, height: crop.height };
  if (!Number.isInteger(canvasWidth) || !Number.isInteger(canvasHeight) ||
      canvasWidth <= 0 || canvasHeight <= 0 ||
      canvasWidth > INT32_MAX || canvasHeight > INT32_MAX) {
    throw new TypeError("Crop clipping requires positive 32-bit canvas dimensions");
  }
  const left = Math.max(0, crop.x);
  const top = Math.max(0, crop.y);
  const right = Math.min(canvasWidth, validated.right);
  const bottom = Math.min(canvasHeight, validated.bottom);
  if (right <= left || bottom <= top) {
    throw new RangeError("Crop rectangle is outside the canvas");
  }
  return { width: right - left, height: bottom - top };
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

export { INT32_MAX, INT32_MIN, MIB };
