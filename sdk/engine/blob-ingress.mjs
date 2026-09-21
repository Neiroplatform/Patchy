export const MAX_BROWSER_SOURCE_BYTES = 1024 * 1024 * 1024;
export const PSD_HEADER_BYTES = 26;

function validateBlob(blob, maximumBytes) {
  const size = Number(blob?.size);
  if (typeof blob?.arrayBuffer !== "function" || !Number.isSafeInteger(size) || size < 0) {
    throw new TypeError("Worker file input must be a finite Blob");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("Worker file input limit must be a positive safe integer");
  }
  if (size === 0) throw new RangeError("Worker file input is empty");
  if (size > maximumBytes) {
    throw new RangeError(`Worker file input exceeds the ${maximumBytes}-byte limit`);
  }
  return size;
}

export function parsePsdHeader(bytes, sourceBytes = bytes?.byteLength) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== PSD_HEADER_BYTES) {
    throw new TypeError(`PSD header must contain exactly ${PSD_HEADER_BYTES} bytes`);
  }
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "8BPS") {
    throw new TypeError("File is not a PSD or PSB document");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, false);
  if (version !== 1 && version !== 2) throw new TypeError("PSD/PSB version is unsupported");
  for (let index = 6; index < 12; ++index) {
    if (bytes[index] !== 0) throw new TypeError("PSD/PSB reserved header bytes are nonzero");
  }
  const channels = view.getUint16(12, false);
  const height = view.getUint32(14, false);
  const width = view.getUint32(18, false);
  const depth = view.getUint16(22, false);
  const colorMode = view.getUint16(24, false);
  const dimensionLimit = version === 1 ? 30000 : 300000;
  if (channels < 1 || channels > 56 || width < 1 || height < 1 ||
      width > dimensionLimit || height > dimensionLimit) {
    throw new RangeError("PSD/PSB header dimensions or channel count are invalid");
  }
  if (![1, 8, 16, 32].includes(depth)) throw new TypeError("PSD/PSB bit depth is unsupported");
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < PSD_HEADER_BYTES) {
    throw new RangeError("PSD/PSB source size is invalid");
  }
  return { version, width, height, channels, depth, colorMode, sourceBytes };
}

export async function inspectPsdBlob(blob, maximumBytes = MAX_BROWSER_SOURCE_BYTES) {
  const size = validateBlob(blob, maximumBytes);
  if (size < PSD_HEADER_BYTES || typeof blob.slice !== "function") {
    throw new RangeError("PSD/PSB source is shorter than its header");
  }
  const header = await blob.slice(0, PSD_HEADER_BYTES).arrayBuffer();
  if (!(header instanceof ArrayBuffer) || header.byteLength !== PSD_HEADER_BYTES) {
    throw new Error("PSD/PSB header changed while being read");
  }
  return parsePsdHeader(new Uint8Array(header), size);
}

export function createPsdBlob(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < PSD_HEADER_BYTES) {
    throw new TypeError("PSD Blob output requires complete encoded bytes");
  }
  parsePsdHeader(bytes.subarray(0, PSD_HEADER_BYTES), bytes.byteLength);
  return new Blob([bytes], { type: "image/vnd.adobe.photoshop" });
}

export async function readBlobInput(blob, maximumBytes = MAX_BROWSER_SOURCE_BYTES) {
  const size = validateBlob(blob, maximumBytes);
  const buffer = await blob.arrayBuffer();
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== size) {
    throw new Error("Worker file input changed while being read");
  }
  return new Uint8Array(buffer);
}
