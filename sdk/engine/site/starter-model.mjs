export const STARTER_DIMENSION_LIMIT = 32_767;
export const STARTER_PSD_DIMENSION_LIMIT = 30_000;

export const STARTER_PRESETS = Object.freeze([
  Object.freeze({ id: "blank", width: 1600, height: 1000, label: "Blank", detail: "1600 × 1000 px" }),
  Object.freeze({ id: "social", width: 1080, height: 1080, label: "Social square", detail: "1080 × 1080 px" }),
  Object.freeze({ id: "presentation", width: 1920, height: 1080, label: "Presentation", detail: "1920 × 1080 px" }),
  Object.freeze({ id: "print-a4", width: 2480, height: 3508, label: "Print A4-like", detail: "2480 × 3508 px" }),
]);

const presetsById = new Map(STARTER_PRESETS.map((preset) => [preset.id, preset]));

function boundedDimension(value, label) {
  const number = typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > STARTER_DIMENSION_LIMIT) {
    throw new RangeError(`${label} must be a whole number from 1 to ${STARTER_DIMENSION_LIMIT}`);
  }
  return number;
}

export function starterPreset(id) {
  const preset = presetsById.get(String(id));
  if (!preset) throw new RangeError("Unknown starter preset");
  return preset;
}

export function starterDocumentRequest(input = starterPreset("blank")) {
  const width = boundedDimension(input.width, "Width");
  const height = boundedDimension(input.height, "Height");
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels * 4 > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Starter dimensions exceed the safe pixel limit");
  }
  const format = width > STARTER_PSD_DIMENSION_LIMIT || height > STARTER_PSD_DIMENSION_LIMIT
    ? "psb" : "psd";
  return Object.freeze({ width, height, format, name: `Untitled.${format}` });
}
