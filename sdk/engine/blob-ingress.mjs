export const MAX_BROWSER_SOURCE_BYTES = 1024 * 1024 * 1024;

export async function readBlobInput(blob, maximumBytes = MAX_BROWSER_SOURCE_BYTES) {
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
  const buffer = await blob.arrayBuffer();
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== size) {
    throw new Error("Worker file input changed while being read");
  }
  return new Uint8Array(buffer);
}
