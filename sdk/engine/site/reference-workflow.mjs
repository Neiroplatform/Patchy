const RASTER_EXTENSIONS = /\.(?:png|jpe?g|webp|avif|svg)$/i;
const RASTER_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/avif", "image/svg+xml",
]);

export function openFileKind(file) {
  const name = typeof file?.name === "string" ? file.name : "";
  const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
  if (/\.(?:psd|psb)$/i.test(name)) return "layered";
  if (RASTER_TYPES.has(type) || RASTER_EXTENSIONS.test(name)) return "raster";
  return "unsupported";
}
