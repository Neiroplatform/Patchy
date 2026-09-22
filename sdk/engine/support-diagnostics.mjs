const SCHEMA = "patchy.browser-diagnostics";
const VERSION = 1;
const MAX_EVENTS = 256;
const MAX_BYTES = 128 * 1024;
const STATES = new Set(["starting", "ready", "crashed", "closed"]);
const OUTCOMES = new Set(["started", "succeeded", "failed", "cancelled", "rejected"]);
const RECOVERY_PHASES = new Set(["started", "succeeded", "partial", "failed"]);
const ERROR_CATEGORIES = new Set(["engine", "input", "memory", "storage", "worker", "unknown"]);
const BROWSER_FAMILIES = new Set(["chromium", "edge", "firefox", "safari", "other"]);
const PLATFORM_FAMILIES = new Set(["windows", "macos", "linux", "ios", "android", "other"]);
const OPERATION = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){0,4}$/;

function finiteInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside the diagnostic schema`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function operation(value) {
  if (typeof value !== "string" || value.length > 64 || !OPERATION.test(value)) {
    throw new TypeError("Diagnostic operation id is invalid");
  }
  return value;
}

function bucket(value, choices) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  for (const choice of choices) if (value <= choice) return choice;
  return choices.at(-1);
}

function browserFamily(navigatorLike) {
  const ua = String(navigatorLike?.userAgent || "").toLowerCase();
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("firefox/")) return "firefox";
  if (ua.includes("chrome/") || ua.includes("chromium/")) return "chromium";
  if (ua.includes("safari/") && !ua.includes("chrome/")) return "safari";
  return "other";
}

function platformFamily(navigatorLike) {
  const source = `${navigatorLike?.userAgent || ""} ${navigatorLike?.platform || ""}`.toLowerCase();
  if (source.includes("iphone") || source.includes("ipad")) return "ios";
  if (source.includes("android")) return "android";
  if (source.includes("win")) return "windows";
  if (source.includes("mac")) return "macos";
  if (source.includes("linux")) return "linux";
  return "other";
}

export function collectRuntimeProfile(scope = globalThis) {
  const navigatorLike = scope.navigator || {};
  return Object.freeze({
    browserFamily: browserFamily(navigatorLike),
    platformFamily: platformFamily(navigatorLike),
    crossOriginIsolated: scope.crossOriginIsolated === true,
    sharedArrayBuffer: typeof scope.SharedArrayBuffer === "function",
    offscreenCanvas: typeof scope.OffscreenCanvas === "function",
    imageBitmap: typeof scope.createImageBitmap === "function",
    opfs: typeof navigatorLike.storage?.getDirectory === "function",
    hardwareConcurrency: bucket(Number(navigatorLike.hardwareConcurrency), [1, 2, 4, 8, 16, 32]),
    deviceMemoryGiB: bucket(Number(navigatorLike.deviceMemory), [1, 2, 4, 8, 16]),
  });
}

function normalizeRuntime(value) {
  exactKeys(value, ["browserFamily", "platformFamily", "crossOriginIsolated",
    "sharedArrayBuffer", "offscreenCanvas", "imageBitmap", "opfs",
    "hardwareConcurrency", "deviceMemoryGiB"], "Diagnostic runtime");
  if (!BROWSER_FAMILIES.has(value.browserFamily) || !PLATFORM_FAMILIES.has(value.platformFamily)) {
    throw new TypeError("Diagnostic runtime family is invalid");
  }
  for (const key of ["crossOriginIsolated", "sharedArrayBuffer", "offscreenCanvas", "imageBitmap", "opfs"]) {
    if (typeof value[key] !== "boolean") throw new TypeError(`Diagnostic runtime ${key} must be boolean`);
  }
  return { browserFamily: value.browserFamily, platformFamily: value.platformFamily,
    crossOriginIsolated: value.crossOriginIsolated, sharedArrayBuffer: value.sharedArrayBuffer,
    offscreenCanvas: value.offscreenCanvas, imageBitmap: value.imageBitmap, opfs: value.opfs,
    hardwareConcurrency: finiteInteger(value.hardwareConcurrency, 0, 32, "Hardware concurrency bucket"),
    deviceMemoryGiB: finiteInteger(value.deviceMemoryGiB, 0, 16, "Device memory bucket") };
}

function normalizeDocument(value) {
  if (value == null) return null;
  exactKeys(value, ["width", "height", "layers", "openDocuments", "selectionRegions",
    "revision", "dirty", "retainedBytes", "historyBytes", "format"], "Diagnostic document");
  if (typeof value.dirty !== "boolean" || !["psd", "psb", "unknown"].includes(value.format) ||
      typeof value.revision !== "string" || !/^\d{1,20}$/.test(value.revision)) {
    throw new TypeError("Diagnostic document state is invalid");
  }
  return {
    width: finiteInteger(value.width, 0, 300000, "Document width"),
    height: finiteInteger(value.height, 0, 300000, "Document height"),
    layers: finiteInteger(value.layers, 0, 100000, "Layer count"),
    openDocuments: finiteInteger(value.openDocuments, 0, 16, "Open document count"),
    selectionRegions: finiteInteger(value.selectionRegions, 0, 100000, "Selection region count"),
    revision: value.revision, dirty: value.dirty,
    retainedBytes: finiteInteger(value.retainedBytes, 0, 0x400000000, "Retained bytes"),
    historyBytes: finiteInteger(value.historyBytes, 0, 0x400000000, "History bytes"),
    format: value.format,
  };
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("Diagnostic event must be an object");
  }
  const base = { sequence: finiteInteger(event.sequence, 1, 0xffffffff, "Event sequence"),
    atMs: finiteInteger(event.atMs, 0, 86400000, "Event time") };
  if (event.kind === "worker") {
    exactKeys(event, ["sequence", "atMs", "kind", "state"], "Worker event");
    if (!STATES.has(event.state)) throw new TypeError("Worker event state is invalid");
    return { ...base, kind: "worker", state: event.state };
  }
  if (event.kind === "command") {
    exactKeys(event, ["sequence", "atMs", "kind", "operation", "outcome", "durationMs"], "Command event");
    if (!OUTCOMES.has(event.outcome)) throw new TypeError("Command outcome is invalid");
    return { ...base, kind: "command", operation: operation(event.operation),
      outcome: event.outcome,
      durationMs: finiteInteger(event.durationMs, 0, 600000, "Command duration") };
  }
  if (event.kind === "recovery") {
    exactKeys(event, ["sequence", "atMs", "kind", "phase", "restored", "failed", "rolledBack"], "Recovery event");
    if (!RECOVERY_PHASES.has(event.phase)) throw new TypeError("Recovery phase is invalid");
    return { ...base, kind: "recovery", phase: event.phase,
      restored: finiteInteger(event.restored, 0, 16, "Restored count"),
      failed: finiteInteger(event.failed, 0, 16, "Recovery failure count"),
      rolledBack: finiteInteger(event.rolledBack, 0, 16, "Rollback count") };
  }
  if (event.kind === "error") {
    exactKeys(event, ["sequence", "atMs", "kind", "category", "code", "operation"], "Error event");
    if (!ERROR_CATEGORIES.has(event.category)) throw new TypeError("Error category is invalid");
    return { ...base, kind: "error", category: event.category,
      code: finiteInteger(event.code, -1, 65535, "Error code"), operation: operation(event.operation) };
  }
  throw new TypeError("Unknown diagnostic event kind");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function errorCategory(error) {
  if (/memory|allocation|heap/i.test(`${error?.name || ""} ${error?.message || ""}`)) return "memory";
  if (error?.name === "RangeError") return "input";
  if (error?.name === "TypeError") return "input";
  if (error?.name === "QuotaExceededError") return "storage";
  if (error?.name === "PatchyEngineError") return "engine";
  return "unknown";
}

export class BrowserDiagnosticRecorder {
  #events = [];
  #sequence = 0;
  #started;
  #now;
  #runtime;
  #sessionId;
  #document = null;

  constructor({ runtime = collectRuntimeProfile(), now = () => performance.now(),
    sessionId = null } = {}) {
    this.#runtime = normalizeRuntime(runtime);
    this.#now = now;
    this.#started = Number(now());
    const generated = sessionId || globalThis.crypto?.randomUUID?.() ||
      `session-${Math.trunc(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`;
    if (typeof generated !== "string" || generated.length < 8 || generated.length > 64 ||
        !/^[a-zA-Z0-9-]+$/.test(generated)) throw new TypeError("Diagnostic session id is invalid");
    this.#sessionId = generated;
  }

  #append(event) {
    this.#events.push({ sequence: ++this.#sequence,
      atMs: Math.min(86400000, Math.max(0, Math.round((Number(this.#now()) - this.#started) / 100) * 100)),
      ...event });
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
  }

  recordWorkerState(state) {
    if (!STATES.has(state)) throw new TypeError("Worker state is invalid");
    this.#append({ kind: "worker", state });
  }

  recordCommand(operationId, outcome, durationMs = 0) {
    if (!OUTCOMES.has(outcome)) throw new TypeError("Command outcome is invalid");
    this.#append({ kind: "command", operation: operation(operationId), outcome,
      durationMs: Math.min(600000, Math.max(0, Math.round(Number(durationMs) / 25) * 25)) });
  }

  recordRecovery(phase, { restored = 0, failed = 0, rolledBack = 0 } = {}) {
    if (!RECOVERY_PHASES.has(phase)) throw new TypeError("Recovery phase is invalid");
    this.#append({ kind: "recovery", phase,
      restored: finiteInteger(restored, 0, 16, "Restored count"),
      failed: finiteInteger(failed, 0, 16, "Recovery failure count"),
      rolledBack: finiteInteger(rolledBack, 0, 16, "Rollback count") });
  }

  recordError(operationId, error) {
    const numeric = Number(error?.code);
    this.#append({ kind: "error", category: errorCategory(error),
      code: Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 65535 ? numeric : -1,
      operation: operation(operationId) });
  }

  setDocument(snapshot, format = "unknown") {
    this.#document = snapshot ? normalizeDocument({
      width: Number(snapshot.width), height: Number(snapshot.height),
      layers: Number(snapshot.layers?.length || 0),
      openDocuments: Number(snapshot.documents?.length || 1),
      selectionRegions: Number(snapshot.selection?.length || 0),
      revision: String(snapshot.revision ?? 0), dirty: snapshot.dirty === true,
      retainedBytes: Number(snapshot.memory?.totalRetainedBytes || 0),
      historyBytes: Number(snapshot.memory?.historyRetainedBytes || 0),
      format: ["psd", "psb"].includes(format) ? format : "unknown",
    }) : null;
  }

  createBundle({ locale = "en", capabilities = 0n } = {}) {
    if (locale !== "en" && locale !== "ru") throw new TypeError("Diagnostic locale is invalid");
    const bundle = { schema: SCHEMA, version: VERSION, sessionId: this.#sessionId,
      elapsedMs: Math.min(86400000, Math.max(0, Math.round(Number(this.#now()) - this.#started))),
      locale, capabilities: String(capabilities), runtime: this.#runtime,
      document: this.#document, events: this.#events.map((event) => ({ ...event })) };
    return validateDiagnosticBundle(bundle);
  }
}

export function validateDiagnosticBundle(input) {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  exactKeys(value, ["schema", "version", "sessionId", "elapsedMs", "locale", "capabilities",
    "runtime", "document", "events"], "Diagnostic bundle");
  if (value.schema !== SCHEMA || value.version !== VERSION ||
      typeof value.sessionId !== "string" || value.sessionId.length < 8 || value.sessionId.length > 64 ||
      !/^[a-zA-Z0-9-]+$/.test(value.sessionId) || !["en", "ru"].includes(value.locale) ||
      typeof value.capabilities !== "string" || !/^\d{1,20}$/.test(value.capabilities) ||
      !Array.isArray(value.events) || value.events.length > MAX_EVENTS) {
    throw new TypeError("Diagnostic bundle header is invalid");
  }
  const events = value.events.map(normalizeEvent);
  for (let index = 1; index < events.length; ++index) {
    if (events[index].sequence <= events[index - 1].sequence || events[index].atMs < events[index - 1].atMs) {
      throw new TypeError("Diagnostic events are not monotonic");
    }
  }
  const normalized = { schema: SCHEMA, version: VERSION, sessionId: value.sessionId,
    elapsedMs: finiteInteger(value.elapsedMs, 0, 86400000, "Diagnostic elapsed time"),
    locale: value.locale, capabilities: value.capabilities,
    runtime: normalizeRuntime(value.runtime), document: normalizeDocument(value.document), events };
  if (new TextEncoder().encode(JSON.stringify(stable(normalized))).byteLength > MAX_BYTES) {
    throw new RangeError("Diagnostic bundle exceeds the size limit");
  }
  return normalized;
}

export function serializeDiagnosticBundle(bundle) {
  return `${JSON.stringify(stable(validateDiagnosticBundle(bundle)), null, 2)}\n`;
}

export function summarizeDiagnosticBundle(bundle) {
  const value = validateDiagnosticBundle(bundle);
  const failedCommands = value.events.filter((event) => event.kind === "command" &&
    ["failed", "rejected"].includes(event.outcome)).length;
  const crashes = value.events.filter((event) => event.kind === "worker" && event.state === "crashed").length;
  const recoveries = value.events.filter((event) => event.kind === "recovery" &&
    ["succeeded", "partial"].includes(event.phase)).length;
  return { schema: `${value.schema}@${value.version}`, sessionId: value.sessionId,
    runtime: value.runtime, document: value.document,
    events: value.events.length, failedCommands, crashes, recoveries };
}
