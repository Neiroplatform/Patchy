export const MIB = 1024 ** 2;

export const BROWSER_PERFORMANCE_THRESHOLDS = Object.freeze({
  panZoomP95Ms: 16.7,
  brushPreviewP95Ms: 50,
  stressDurationMs: 30 * 60 * 1000,
  applicationMemoryCeilingBytes: 256 * MIB,
  plateauWindowSamples: 5,
  plateauToleranceBytes: 32 * MIB,
});

export function percentile(samples, fraction) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("percentile requires at least one sample");
  }
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("percentile fraction must be between zero and one");
  }
  const sorted = samples.map(Number).sort((left, right) => left - right);
  if (!sorted.every(Number.isFinite)) throw new TypeError("percentile samples must be finite");
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function parseDisplayedBytes(label) {
  const match = String(label).match(/([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)\s+retained\b/i);
  if (!match) throw new Error(`memory label does not expose retained bytes: ${label}`);
  const units = { B: 1, KB: 1024, MB: MIB, GB: 1024 * MIB };
  return Math.round(Number(match[1]) * units[match[2].toUpperCase()]);
}

export function assessApplicationMemory(samples, thresholds = BROWSER_PERFORMANCE_THRESHOLDS) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new TypeError("application memory assessment requires at least two samples");
  }
  const values = samples.map((sample) => Number(sample.applicationBytes));
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new TypeError("application memory samples must contain finite non-negative bytes");
  }
  const windowSize = Math.min(thresholds.plateauWindowSamples, values.length);
  const tail = values.slice(-windowSize);
  const maximumBytes = Math.max(...values);
  const plateauSpanBytes = Math.max(...tail) - Math.min(...tail);
  return {
    maximumBytes,
    finalBytes: values.at(-1),
    growthBytes: values.at(-1) - values[0],
    plateauSpanBytes,
    ceilingBytes: thresholds.applicationMemoryCeilingBytes,
    plateauToleranceBytes: thresholds.plateauToleranceBytes,
    bounded: maximumBytes <= thresholds.applicationMemoryCeilingBytes &&
      (values.length < thresholds.plateauWindowSamples ||
        plateauSpanBytes <= thresholds.plateauToleranceBytes),
  };
}
