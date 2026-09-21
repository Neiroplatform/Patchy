const ROOT_NAME = "patchy-workspaces-v1";
const MANIFEST_VERSION = 1;
const MANIFEST_FILES = ["manifest-a.json", "manifest-b.json"];
const SNAPSHOT_FILES = ["snapshot-a.psd", "snapshot-b.psd"];
const PREFERENCES_FILE = "preferences.json";
const PREFERENCES_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_IDS = new Set(["move", "marquee", "lasso", "polygon", "magic", "pan",
  "brush", "eraser", "clone", "heal", "gradient", "text"]);
const PAINT_PRESETS = new Set(["solid", "foreground-transparent", "black-white",
  "sunset", "ocean", "checker", "dots"]);

export class PatchyCheckpointQueue {
  #save;
  #write;
  #onState;
  #pending = null;
  #running = false;
  #idle = Promise.resolve();

  constructor({ save, write, onState = () => {} }) {
    if (typeof save !== "function" || typeof write !== "function") {
      throw new TypeError("Checkpoint queue requires save and write functions");
    }
    this.#save = save;
    this.#write = write;
    this.#onState = onState;
  }

  schedule(checkpoint) {
    this.#pending = checkpoint;
    this.#onState("pending", checkpoint);
    if (!this.#running) {
      this.#running = true;
      this.#idle = this.#drain();
    }
    return this.#idle;
  }

  whenIdle() { return this.#idle; }

  async #drain() {
    try {
      while (this.#pending) {
        const checkpoint = this.#pending;
        this.#pending = null;
        const bytes = await this.#save(checkpoint);
        const manifest = await this.#write(checkpoint, bytes);
        this.#onState("confirmed", checkpoint, manifest);
      }
    } catch (error) {
      this.#pending = null;
      this.#onState("error", null, error);
    } finally {
      this.#running = false;
    }
  }
}

export class PatchyWorkspaceStore {
  #rootProvider;
  #clock;
  #hooks;

  constructor({ rootProvider = defaultRootProvider, clock = () => new Date().toISOString(), hooks = {} } = {}) {
    this.#rootProvider = rootProvider;
    this.#clock = clock;
    this.#hooks = hooks;
  }

  async available() {
    try { await this.#root(true); return true; } catch { return false; }
  }

  async checkpoint({ id, name, revision, dirty = true, bytes }) {
    validateId(id);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypeError("Workspace checkpoint requires non-empty PSD bytes");
    }
    const workspace = await this.#workspace(id, true);
    const manifests = await this.#manifestCandidates(workspace, id, false);
    const generation = Math.max(0, ...manifests.map((item) => item.generation)) + 1;
    const slotIndex = generation % 2 === 1 ? 0 : 1;
    const snapshotName = SNAPSHOT_FILES[slotIndex];
    const manifestName = MANIFEST_FILES[slotIndex];

    await this.#hooks.beforeSnapshotWrite?.({ id, generation, snapshotName });
    await writeFile(workspace, snapshotName, bytes);
    await this.#hooks.afterSnapshotWrite?.({ id, generation, snapshotName });
    const storedBytes = await readBytes(workspace, snapshotName);
    if (storedBytes.byteLength !== bytes.byteLength) {
      throw new Error("Workspace snapshot size verification failed");
    }
    const digest = await sha256(storedBytes);
    const manifest = {
      version: MANIFEST_VERSION,
      id,
      name: normalizeName(name),
      generation,
      slot: slotIndex === 0 ? "a" : "b",
      revision: String(revision),
      dirty: Boolean(dirty),
      snapshotSize: storedBytes.byteLength,
      snapshotSha256: digest,
      updatedAt: this.#clock(),
    };
    await this.#hooks.beforeManifestWrite?.({ ...manifest });
    await writeFile(workspace, manifestName, new TextEncoder().encode(JSON.stringify(manifest)));
    await this.#hooks.afterManifestWrite?.({ ...manifest });
    return manifest;
  }

  async list() {
    const root = await this.#root(false);
    const workspaces = [];
    for await (const entry of root.values()) {
      if (entry.kind !== "directory" || !ID_PATTERN.test(entry.name)) continue;
      const recovered = await this.#restoreFromDirectory(entry, entry.name, false);
      if (recovered) workspaces.push(recovered.manifest);
    }
    workspaces.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return workspaces;
  }

  async restore(id) {
    validateId(id);
    const workspace = await this.#workspace(id, false);
    const restored = await this.#restoreFromDirectory(workspace, id, true);
    if (!restored) throw new Error("No valid Patchy workspace generation exists");
    return restored;
  }

  async remove(id) {
    validateId(id);
    const root = await this.#root(false);
    await root.removeEntry(id, { recursive: true });
  }

  async cleanup({ protectedIds = [], keepNewest = 8 } = {}) {
    if (!Number.isSafeInteger(keepNewest) || keepNewest < 0 || keepNewest > 128) {
      throw new RangeError("Workspace cleanup keepNewest must be between 0 and 128");
    }
    const protectedSet = new Set(protectedIds);
    for (const id of protectedSet) validateId(id);
    const candidates = (await this.list()).filter((manifest) => !protectedSet.has(manifest.id));
    const removed = candidates.slice(keepNewest);
    for (const manifest of removed) await this.remove(manifest.id);
    return removed;
  }

  async loadPreferences(fallback = {}) {
    try {
      const root = await this.#root(false);
      const value = JSON.parse(new TextDecoder().decode(await readBytes(root, PREFERENCES_FILE)));
      return { ...fallback, ...normalizePreferences(value, true) };
    } catch {
      return { ...fallback };
    }
  }

  async savePreferences(value) {
    const preferences = normalizePreferences(value, false);
    const root = await this.#root(true);
    await writeFile(root, PREFERENCES_FILE,
      new TextEncoder().encode(JSON.stringify({ version: PREFERENCES_VERSION, ...preferences })));
    return preferences;
  }

  async estimate() {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    return { usage: Number(estimate?.usage || 0), quota: Number(estimate?.quota || 0) };
  }

  async #restoreFromDirectory(workspace, id, required) {
    const candidates = await this.#manifestCandidates(workspace, id, true);
    for (const manifest of candidates.sort((left, right) => right.generation - left.generation)) {
      try {
        const slotIndex = manifest.slot === "a" ? 0 : 1;
        const bytes = await readBytes(workspace, SNAPSHOT_FILES[slotIndex]);
        if (bytes.byteLength !== manifest.snapshotSize) continue;
        if (await sha256(bytes) !== manifest.snapshotSha256) continue;
        return { manifest, bytes };
      } catch { /* Try the previous complete generation. */ }
    }
    if (required) throw new Error("Patchy workspace generations failed integrity validation");
    return null;
  }

  async #manifestCandidates(workspace, id, validate) {
    const result = [];
    for (const name of MANIFEST_FILES) {
      try {
        const manifest = JSON.parse(new TextDecoder().decode(await readBytes(workspace, name)));
        if (validManifest(manifest, id)) result.push(manifest);
      } catch { /* A torn or absent generation is not recoverable. */ }
    }
    if (!validate) return result;
    return result;
  }

  async #root(create) {
    const originRoot = await this.#rootProvider();
    return originRoot.getDirectoryHandle(ROOT_NAME, { create });
  }

  async #workspace(id, create) {
    return (await this.#root(create)).getDirectoryHandle(id, { create });
  }
}

async function defaultRootProvider() {
  if (!globalThis.navigator?.storage?.getDirectory) {
    throw new Error("Origin-private file storage is unavailable");
  }
  return navigator.storage.getDirectory();
}

async function writeFile(directory, name, bytes) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try { await writable.write(bytes); await writable.close(); }
  catch (error) { try { await writable.abort?.(); } catch {} throw error; }
}

async function readBytes(directory, name) {
  const handle = await directory.getFileHandle(name);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError("Invalid workspace id");
}

function normalizeName(name) {
  const value = String(name || "Recovered.psd").trim();
  return (value || "Recovered.psd").slice(0, 256);
}

function validManifest(value, id) {
  return value?.version === MANIFEST_VERSION && value.id === id &&
    Number.isSafeInteger(value.generation) && value.generation > 0 &&
    (value.slot === "a" || value.slot === "b") &&
    typeof value.revision === "string" && typeof value.name === "string" &&
    Number.isSafeInteger(value.snapshotSize) && value.snapshotSize > 0 &&
    /^[0-9a-f]{64}$/.test(value.snapshotSha256) &&
    typeof value.updatedAt === "string";
}

function normalizePreferences(value, stored) {
  if (!value || typeof value !== "object" || (stored && value.version !== PREFERENCES_VERSION)) {
    throw new TypeError("Invalid workspace preferences");
  }
  const result = {};
  if (value.tool !== undefined) {
    if (!TOOL_IDS.has(value.tool)) throw new TypeError("Invalid preferred tool");
    result.tool = value.tool;
  }
  if (value.brushSize !== undefined) {
    const brushSize = Number(value.brushSize);
    if (!Number.isInteger(brushSize) || brushSize < 1 || brushSize > 512) {
      throw new RangeError("Preferred brush size must be between 1 and 512");
    }
    result.brushSize = brushSize;
  }
  if (value.color !== undefined) {
    if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) {
      throw new TypeError("Invalid preferred colour");
    }
    result.color = value.color.toLowerCase();
  }
  for (const [key, limit] of [["paintPreset", 64], ["font", 256]]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > limit) {
      throw new TypeError(`Invalid preferred ${key}`);
    }
    result[key] = value[key].trim();
  }
  if (result.paintPreset !== undefined && !PAINT_PRESETS.has(result.paintPreset)) {
    throw new TypeError("Invalid preferred paint preset");
  }
  if (value.selectionTolerance !== undefined) {
    const tolerance = Number(value.selectionTolerance);
    if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
      throw new RangeError("Selection tolerance must be between 0 and 255");
    }
    result.selectionTolerance = tolerance;
  }
  if (value.historyBudgetMiB !== undefined) {
    const historyBudgetMiB = Number(value.historyBudgetMiB);
    if (![128, 256, 512, 1024].includes(historyBudgetMiB)) {
      throw new RangeError("History memory budget must be 128, 256, 512, or 1024 MiB");
    }
    result.historyBudgetMiB = historyBudgetMiB;
  }
  if (value.panelsHidden !== undefined) result.panelsHidden = Boolean(value.panelsHidden);
  return result;
}
