function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob?.type === type ? resolve(blob) : reject(new Error(`Browser could not encode ${type}`)),
    type, quality));
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function sourceCanvas(rgba, width, height) {
  const expectedBytes = width * height * 4;
  if (!(rgba instanceof Uint8Array) || !Number.isSafeInteger(expectedBytes) ||
      expectedBytes <= 0 || rgba.byteLength !== expectedBytes) {
    throw new TypeError("Flattened export requires one complete RGBA8 document render");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Browser could not allocate the export canvas");
  context.putImageData(new ImageData(
    new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
  return canvas;
}

export async function encodeFlatDocument({ rgba, width, height, format, title = "Patchy export" }) {
  if (!["png", "jpeg", "webp", "svg"].includes(format)) {
    throw new TypeError("Flat export format is unsupported");
  }
  const source = sourceCanvas(rgba, width, height);
  if (format === "svg") {
    const svgNamespace = "http" + "://www.w3.org/2000/svg";
    const svg = `<svg xmlns="${svgNamespace}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeXml(title)}</title><image width="100%" height="100%" href="${source.toDataURL("image/png")}"/></svg>`;
    return new Blob([svg], { type: "image/svg+xml" });
  }
  let output = source;
  if (format === "jpeg") {
    output = document.createElement("canvas");
    output.width = width; output.height = height;
    const context = output.getContext("2d", { alpha: false });
    if (!context) throw new Error("Browser could not allocate the JPEG export canvas");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0);
  }
  return canvasBlob(output, `image/${format}`, format === "jpeg" ? .92 : undefined);
}
