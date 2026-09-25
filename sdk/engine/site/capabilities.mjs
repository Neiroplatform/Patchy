const DEFINITIONS = Object.freeze([
  { id: "webAssembly", label: "WebAssembly", detail: "Runs the Patchy engine in the browser.", required: true },
  { id: "worker", label: "Web Worker", detail: "Keeps engine work outside the interface thread.", required: true },
  { id: "sharedArrayBuffer", label: "SharedArrayBuffer", detail: "Provides shared memory to the multithreaded engine.", required: true },
  { id: "crossOriginIsolated", label: "Cross-origin isolation", detail: "Confirms that the host supplied COOP and COEP headers.", required: true },
  { id: "opfs", label: "Origin-private storage", detail: "Enables local recovery and named versions on this device.", required: false },
  { id: "offscreenCanvas", label: "OffscreenCanvas", detail: "Enables efficient canvas work away from the interface thread.", required: false },
  { id: "imageBitmap", label: "ImageBitmap", detail: "Enables efficient frame transfer from the engine.", required: false },
  { id: "fileSystemAccess", label: "File System Access", detail: "Adds direct save when the browser supports it; downloads remain available otherwise.", required: false },
]);

export function detectCapabilities(scope = globalThis) {
  const navigator = scope.navigator ?? {};
  return {
    webAssembly: typeof scope.WebAssembly === "object",
    worker: typeof scope.Worker === "function",
    sharedArrayBuffer: typeof scope.SharedArrayBuffer === "function",
    crossOriginIsolated: scope.crossOriginIsolated === true,
    opfs: typeof navigator.storage?.getDirectory === "function",
    offscreenCanvas: typeof scope.OffscreenCanvas === "function",
    imageBitmap: typeof scope.createImageBitmap === "function",
    fileSystemAccess: typeof scope.showSaveFilePicker === "function",
  };
}

export function assessCapabilities(capabilities) {
  const missingRequired = DEFINITIONS.filter((item) => item.required && !capabilities[item.id]).map((item) => item.id);
  const missingEnhanced = DEFINITIONS.filter((item) => !item.required && !capabilities[item.id]).map((item) => item.id);
  if (missingRequired.length) {
    return {
      tier: "blocked",
      label: "ACTION REQUIRED",
      title: "This browser or host is not ready",
      detail: "Fix every required capability before opening documents. Patchy does not fall back to an unisolated engine.",
      missingRequired,
      missingEnhanced,
    };
  }
  if (missingEnhanced.length) {
    return {
      tier: "limited",
      label: "READY WITH LIMITS",
      title: "The editor can start",
      detail: "Core editing is available. Some local recovery, direct-save or accelerated transfer features may be limited.",
      missingRequired,
      missingEnhanced,
    };
  }
  return {
    tier: "ready",
    label: "READY",
    title: "This runtime is ready",
    detail: "Required and enhanced local-first capabilities are available.",
    missingRequired,
    missingEnhanced,
  };
}

export function capabilityReport(capabilities) {
  return DEFINITIONS.map((definition) => ({ ...definition, ready: capabilities[definition.id] === true }));
}

function render(document) {
  const capabilities = detectCapabilities(document.defaultView ?? globalThis);
  const assessment = assessCapabilities(capabilities);
  const card = document.querySelector(".result-card");
  card.dataset.tier = assessment.tier;
  document.getElementById("resultLabel").textContent = assessment.label;
  document.getElementById("resultTitle").textContent = assessment.title;
  document.getElementById("resultDetail").textContent = assessment.detail;
  const list = document.getElementById("capabilityList");
  for (const item of capabilityReport(capabilities)) {
    const row = document.createElement("li");
    row.dataset.ready = String(item.ready);
    row.dataset.required = String(item.required);
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    const result = document.createElement("output");
    title.textContent = item.label;
    detail.textContent = `${item.detail} ${item.required ? "Required." : "Enhanced."}`;
    result.textContent = item.ready ? "Available" : item.required ? "Missing" : "Optional";
    copy.append(title, detail);
    row.append(copy, result);
    list.append(row);
  }
}

if (typeof document !== "undefined") render(document);
