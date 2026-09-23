const LAYERED_TYPES = [{
  description: "Layered Photoshop document",
  accept: { "application/octet-stream": [".psd", ".psb"] },
}];

function abortError(error) {
  return error?.name === "AbortError";
}

function finiteDocumentId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("documentId must be a positive safe integer");
  }
  return value;
}

function layeredFormat(value) {
  if (value !== "psd" && value !== "psb") throw new TypeError("format must be psd or psb");
  return value;
}

export function supportsFileSystemAccess(scope = globalThis) {
  return typeof scope?.showOpenFilePicker === "function" &&
    typeof scope?.showSaveFilePicker === "function";
}

export function layeredFilename(name, format) {
  layeredFormat(format);
  const fallback = `Untitled.${format}`;
  if (typeof name !== "string") return fallback;
  const base = name.trim().replace(/[\\/\0]/g, "_").replace(/\.(?:psd|psb)$/i, "");
  return `${base || "Untitled"}.${format}`;
}

export class BrowserFileLifecycle {
  #scope;
  #download;
  #bindings = new Map();

  constructor({ scope = globalThis, download } = {}) {
    this.#scope = scope;
    this.#download = download;
  }

  get supported() { return supportsFileSystemAccess(this.#scope); }

  async pickOpen() {
    if (!this.supported) return { kind: "fallback" };
    try {
      const handles = await this.#scope.showOpenFilePicker({ multiple: false, types: LAYERED_TYPES,
        excludeAcceptAllOption: true });
      const handle = handles?.[0];
      if (!handle || typeof handle.getFile !== "function") throw new TypeError("Open picker returned no file handle");
      return { kind: "handle", handle, file: await handle.getFile() };
    } catch (error) {
      if (abortError(error)) return { kind: "cancelled" };
      throw error;
    }
  }

  bindOpened(documentId, handle, projection, format) {
    finiteDocumentId(documentId); layeredFormat(format);
    this.#bindings.set(documentId, { handle: handle || null, format,
      name: projection?.documentName || handle?.name || "Document.psd" });
  }

  register(documentId, projection, format) {
    finiteDocumentId(documentId); layeredFormat(format);
    const previous = this.#bindings.get(documentId);
    this.#bindings.set(documentId, { handle: previous?.handle || null, format: previous?.format || format,
      name: previous?.name || projection?.documentName || `Untitled.${format}` });
  }

  release(documentId) { this.#bindings.delete(documentId); }

  remapAll(items) {
    if (!Array.isArray(items)) throw new TypeError("remap items must be an array");
    const captured = items.map((item) => {
      finiteDocumentId(item.previousDocumentId); finiteDocumentId(item.documentId);
      layeredFormat(item.format);
      return { ...item, previous: this.#bindings.get(item.previousDocumentId) };
    });
    for (const item of captured) this.#bindings.delete(item.previousDocumentId);
    for (const { documentId, projection, format, previous } of captured) {
      this.#bindings.set(documentId, { handle: previous?.handle || null, format,
        name: previous?.name || projection?.documentName || `Untitled.${format}` });
    }
  }

  hasHandle(documentId) { return Boolean(this.#bindings.get(documentId)?.handle); }

  async save({ documentId, projection, format, name, createBlob, saveAs = false }) {
    finiteDocumentId(documentId); layeredFormat(format);
    if (typeof createBlob !== "function") throw new TypeError("createBlob callback is required");
    const suggestedName = layeredFilename(name, format);
    let binding = this.#bindings.get(documentId) || { handle: null,
      name: suggestedName, format };
    let handle = !saveAs && binding.format === format ? binding.handle : null;
    if (this.supported) {
      if (!handle) {
        try {
          handle = await this.#scope.showSaveFilePicker({ suggestedName, types: LAYERED_TYPES,
            excludeAcceptAllOption: true });
        } catch (error) {
          if (abortError(error)) return { kind: "cancelled", durable: false };
          throw error;
        }
      }
      const permission = await this.#writePermission(handle);
      if (permission !== "granted") return { kind: "permission-denied", durable: false };
      const blob = await createBlob();
      if (!(blob instanceof Blob) || blob.size <= 0) throw new TypeError("encoder returned an empty non-Blob output");
      const writable = await handle.createWritable({ keepExistingData: false });
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        try { await writable.abort?.(error); } catch { /* Preserve the original write failure. */ }
        throw error;
      }
      binding = { handle, format, name: handle.name || suggestedName };
      this.#bindings.set(documentId, binding);
      return { kind: "file", durable: true, name: binding.name, bytes: blob.size };
    }
    const blob = await createBlob();
    if (!(blob instanceof Blob) || blob.size <= 0) throw new TypeError("encoder returned an empty non-Blob output");
    if (typeof this.#download !== "function") throw new Error("download fallback is unavailable");
    this.#download(blob, suggestedName);
    return { kind: "download", durable: false, name: suggestedName, bytes: blob.size };
  }

  async #writePermission(handle) {
    if (!handle || typeof handle.createWritable !== "function") throw new TypeError("Invalid file handle");
    const options = { mode: "readwrite" };
    const current = typeof handle.queryPermission === "function"
      ? await handle.queryPermission(options) : "prompt";
    if (current === "granted") return current;
    return typeof handle.requestPermission === "function"
      ? handle.requestPermission(options) : "denied";
  }
}
