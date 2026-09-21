function frameDimensions(region) {
  const width = Number(region?.width);
  const height = Number(region?.height);
  if (!Number.isSafeInteger(width) || width <= 0 ||
      !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("Render frame dimensions must be positive integers");
  }
  return { width, height };
}

export function createRenderFrame(bytes, region, environment = globalThis) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Render frame pixels must be a Uint8Array");
  }
  const { width, height } = frameDimensions(region);
  const expectedBytes = width * height * 4;
  if (!Number.isSafeInteger(expectedBytes) || bytes.byteLength !== expectedBytes) {
    throw new RangeError(
      `Render frame has ${bytes.byteLength} RGBA bytes, expected ${expectedBytes}`);
  }

  const { ImageData: ImageDataClass, OffscreenCanvas: OffscreenCanvasClass } = environment;
  if (typeof ImageDataClass === "function" && typeof OffscreenCanvasClass === "function") {
    try {
      const canvas = new OffscreenCanvasClass(width, height);
      const context = canvas.getContext("2d", { alpha: true });
      if (!context || typeof canvas.transferToImageBitmap !== "function") {
        throw new Error("Worker bitmap canvas is unavailable");
      }
      const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      context.putImageData(new ImageDataClass(pixels, width, height), 0, 0);
      const bitmap = canvas.transferToImageBitmap();
      return {
        value: { kind: "bitmap", bitmap, width, height },
        transfer: [bitmap],
      };
    } catch {
      // A browser may expose the APIs but reject the canvas allocation or transfer.
    }
  }

  return {
    value: { kind: "rgba", bytes, width, height },
    transfer: [bytes.buffer],
  };
}
