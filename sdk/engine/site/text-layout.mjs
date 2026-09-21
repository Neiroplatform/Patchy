const PARAGRAPH_KEYS = ["justification", "firstLineIndent", "startIndent",
  "endIndent", "spaceBefore", "spaceAfter", "autoLeadingFraction"];

export function mergeParagraphRuns(runs) {
  const merged = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous && previous.start + previous.length === run.start &&
        PARAGRAPH_KEYS.every((key) => previous[key] === run[key])) {
      previous.length += run.length;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

export function applyParagraphStyleRange(runs, start, end, paragraph) {
  if (!Array.isArray(runs) || !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || start >= end || !paragraph) {
    throw new TypeError("A non-empty paragraph range and style are required");
  }
  const next = [];
  for (const run of runs) {
    const runEnd = run.start + run.length;
    if (runEnd <= start || run.start >= end) { next.push({ ...run }); continue; }
    if (run.start < start) next.push({ ...run, length: start - run.start });
    const selectedStart = Math.max(run.start, start);
    const selectedEnd = Math.min(runEnd, end);
    next.push({ ...paragraph, start: selectedStart, length: selectedEnd - selectedStart });
    if (runEnd > end) next.push({ ...run, start: end, length: runEnd - end });
  }
  return mergeParagraphRuns(next);
}

export function justifiedSpaceAdvance(justification, available, measured, segments) {
  if (justification !== 3 || !Number.isFinite(available) ||
      !Number.isFinite(measured) || !Array.isArray(segments)) return 0;
  const spaces = segments.reduce((sum, segment) => sum +
    Array.from(segment.value || "").filter((glyph) => glyph === " ").length, 0);
  return spaces > 0 ? Math.max(0, available - measured) / spaces : 0;
}
