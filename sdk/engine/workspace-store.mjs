const ROOT_NAME = "patchy-workspaces-v1";
const MANIFEST_VERSION = 1;
const MANIFEST_FILES = ["manifest-a.json", "manifest-b.json"];
const SNAPSHOT_FILES = ["snapshot-a.psd", "snapshot-b.psd"];
const SELECTION_FILES = ["selection-a.bin", "selection-b.bin"];
const MAX_SELECTION_BYTES = 16 * 1024 * 1024;
const PREFERENCES_FILE = "preferences.json";
const PREFERENCES_VERSION = 1;
const ASSET_LIBRARY_FILES = ["assets-a.json", "assets-b.json"];
const ASSET_LIBRARY_VERSION = 1;
const FONT_DIRECTORY = "fonts";
const MAX_FONT_BYTES = 16 * 1024 * 1024;
const VERSION_ROOT_NAME = "patchy-versions-v1";
const VERSION_MANIFEST_VERSION = 1;
const DEFAULT_VERSION_RETENTION = 20;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_IDS = new Set(["move", "crop", "marquee", "lasso", "polygon", "magic",
  "quickSelect", "magnetic", "quickMask", "pan", "brush", "eraser", "clone",
  "heal", "spotHealing", "patch", "mixer", "patternStamp", "gradient", "pen", "text"]);
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

  async checkpoint({ id, name, revision, dirty = true, format = "psd", bytes,
    selection = null }) {
    validateId(id);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypeError("Workspace checkpoint requires non-empty PSD bytes");
    }
    const encodedFormat = layeredFormat(bytes);
    if (format !== encodedFormat) {
      throw new Error("Workspace format does not match encoded PSD/PSB bytes");
    }
    const workspace = await this.#workspace(id, true);
    const manifests = await this.#manifestCandidates(workspace, id, false);
    const generation = Math.max(0, ...manifests.map((item) => item.generation)) + 1;
    const slotIndex = generation % 2 === 1 ? 0 : 1;
    const snapshotName = SNAPSHOT_FILES[slotIndex];
    const selectionName = SELECTION_FILES[slotIndex];
    const manifestName = MANIFEST_FILES[slotIndex];
    const selectionState = normalizeSelection(selection);

    await this.#hooks.beforeSnapshotWrite?.({ id, generation, snapshotName });
    await writeFile(workspace, snapshotName, bytes);
    await this.#hooks.afterSnapshotWrite?.({ id, generation, snapshotName });
    const storedBytes = await readBytes(workspace, snapshotName);
    if (storedBytes.byteLength !== bytes.byteLength) {
      throw new Error("Workspace snapshot size verification failed");
    }
    const digest = await sha256(storedBytes);
    let storedSelection = null;
    if (selectionState) {
      await writeFile(workspace, selectionName, selectionState.gray);
      const gray = await readBytes(workspace, selectionName);
      if (gray.byteLength !== selectionState.gray.byteLength) {
        throw new Error("Workspace selection size verification failed");
      }
      storedSelection = { bounds: selectionState.bounds, size: gray.byteLength,
        sha256: await sha256(gray) };
    }
    const manifest = {
      version: MANIFEST_VERSION,
      id,
      name: normalizeName(name),
      format: encodedFormat,
      generation,
      slot: slotIndex === 0 ? "a" : "b",
      revision: String(revision),
      dirty: Boolean(dirty),
      snapshotSize: storedBytes.byteLength,
      snapshotSha256: digest,
      ...(storedSelection ? { selection: storedSelection } : {}),
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

  async createVersion({ id, versionId, label, name, revision, format = "psd", bytes,
    selection = null, keepNewest = DEFAULT_VERSION_RETENTION }) {
    validateId(id); validateId(versionId); validateVersionRetention(keepNewest);
    const normalizedLabel = normalizeVersionLabel(label);
    const normalizedName = normalizeName(name);
    const normalizedRevision = normalizeRevision(revision);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new TypeError("Local version requires non-empty PSD bytes");
    }
    const encodedFormat = layeredFormat(bytes);
    if (format !== encodedFormat) throw new Error("Local version format does not match encoded bytes");
    const versions = await this.#versions(id, true);
    const manifestName = versionFilename(versionId, "json");
    if (await fileExists(versions, manifestName)) throw new Error("Local version id already exists");
    const payloadName = versionFilename(versionId, "layered");
    const selectionName = versionFilename(versionId, "selection");
    const selectionState = normalizeSelection(selection);
    const payloadSha256 = await sha256(bytes);
    await this.#hooks.beforeVersionPayloadWrite?.({ id, versionId });
    await writeFile(versions, payloadName, bytes);
    const storedBytes = await readBytes(versions, payloadName);
    if (storedBytes.byteLength !== bytes.byteLength || await sha256(storedBytes) !== payloadSha256) {
      throw new Error("Local version payload verification failed");
    }
    let storedSelection = null;
    if (selectionState) {
      const selectionSha256 = await sha256(selectionState.gray);
      await writeFile(versions, selectionName, selectionState.gray);
      const gray = await readBytes(versions, selectionName);
      if (gray.byteLength !== selectionState.gray.byteLength || await sha256(gray) !== selectionSha256) {
        throw new Error("Local version selection verification failed");
      }
      storedSelection = { bounds: selectionState.bounds, size: gray.byteLength,
        sha256: selectionSha256 };
    }
    const manifest = {
      version: VERSION_MANIFEST_VERSION, workspaceId: id, versionId,
      label: normalizedLabel, name: normalizedName, format: encodedFormat,
      revision: normalizedRevision, payloadSize: storedBytes.byteLength,
      payloadSha256,
      ...(storedSelection ? { selection: storedSelection } : {}), createdAt: this.#clock(),
    };
    await this.#hooks.beforeVersionManifestWrite?.({ ...manifest });
    await writeFile(versions, manifestName, new TextEncoder().encode(JSON.stringify(manifest)));
    await this.#hooks.afterVersionManifestWrite?.({ ...manifest });
    const removed = await this.pruneVersions({ id, keepNewest });
    return { manifest, removed };
  }

  async listVersions(id) {
    validateId(id);
    let versions;
    try { versions = await this.#versions(id, false); } catch { return []; }
    const result = [];
    for await (const entry of versions.values()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
      try {
        const manifest = JSON.parse(new TextDecoder().decode(await readBytes(versions, entry.name)));
        if (!validVersionManifest(manifest, id) || entry.name !== versionFilename(manifest.versionId, "json")) continue;
        const restored = await this.#restoreVersionFromDirectory(versions, manifest);
        if (restored) result.push(manifest);
      } catch { /* A torn or corrupt local version is isolated. */ }
    }
    result.sort(compareVersionsNewestFirst);
    return result;
  }

  async restoreVersion(id, versionId) {
    validateId(id); validateId(versionId);
    const versions = await this.#versions(id, false);
    const manifest = JSON.parse(new TextDecoder().decode(
      await readBytes(versions, versionFilename(versionId, "json"))));
    if (!validVersionManifest(manifest, id) || manifest.versionId !== versionId) {
      throw new Error("Local version manifest is invalid");
    }
    const restored = await this.#restoreVersionFromDirectory(versions, manifest);
    if (!restored) throw new Error("Local version failed integrity validation");
    return restored;
  }

  async removeVersion(id, versionId) {
    validateId(id); validateId(versionId);
    const versions = await this.#versions(id, false);
    for (const suffix of ["json", "layered", "selection"]) {
      try { await versions.removeEntry(versionFilename(versionId, suffix)); }
      catch { /* Missing sidecars and torn payloads are already non-restorable. */ }
    }
  }

  async pruneVersions({ id, keepNewest = DEFAULT_VERSION_RETENTION,
    protectedVersionIds = [] } = {}) {
    validateId(id); validateVersionRetention(keepNewest);
    const protectedSet = new Set(protectedVersionIds);
    for (const versionId of protectedSet) validateId(versionId);
    const candidates = (await this.listVersions(id))
      .filter((manifest) => !protectedSet.has(manifest.versionId));
    const removed = candidates.slice(keepNewest);
    for (const manifest of removed) await this.removeVersion(id, manifest.versionId);
    await this.#removeInvalidVersionFiles(id, await this.listVersions(id));
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

  async loadAssetLibrary() {
    const root = await this.#root(false);
    const candidates = [];
    for (const name of ASSET_LIBRARY_FILES) {
      try {
        const value = JSON.parse(new TextDecoder().decode(await readBytes(root, name)));
        candidates.push(normalizeAssetLibrary(value, true));
      } catch { /* A missing or torn asset generation is ignored. */ }
    }
    candidates.sort((left, right) => right.generation - left.generation);
    return candidates[0] ?? emptyAssetLibrary();
  }

  async saveAssetLibrary(value) {
    const current = await this.loadAssetLibrary().catch(() => emptyAssetLibrary());
    const library = normalizeAssetLibrary({ ...value, version: ASSET_LIBRARY_VERSION,
      generation: current.generation + 1 }, true);
    const root = await this.#root(true);
    const slot = ASSET_LIBRARY_FILES[(library.generation - 1) % 2];
    await writeFile(root, slot, new TextEncoder().encode(JSON.stringify(library)));
    return library;
  }

  async installFont({ id, family, filename, bytes }) {
    validateId(id);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
        bytes.byteLength > MAX_FONT_BYTES) {
      throw new TypeError("Font bytes must be between 1 byte and 16 MiB");
    }
    const normalizedFamily = normalizeAssetName(family, "Font family", 128);
    const normalizedFilename = normalizeAssetName(filename, "Font filename", 256);
    const current = await this.loadAssetLibrary().catch(() => emptyAssetLibrary());
    if (current.fonts.some((font) => font.id === id)) {
      throw new Error("Font asset id already exists");
    }
    const root = await this.#root(true);
    const fonts = await root.getDirectoryHandle(FONT_DIRECTORY, { create: true });
    const file = `${id}.font`;
    await writeFile(fonts, file, bytes);
    const stored = await readBytes(fonts, file);
    const metadata = { id, family: normalizedFamily, filename: normalizedFilename,
      size: stored.byteLength, sha256: await sha256(stored) };
    const next = { ...current, fonts: [...current.fonts.filter((font) => font.id !== id), metadata] };
    await this.saveAssetLibrary(next);
    return metadata;
  }

  async loadFont(id) {
    validateId(id);
    const library = await this.loadAssetLibrary();
    const metadata = library.fonts.find((font) => font.id === id);
    if (!metadata) throw new Error("Font asset does not exist");
    const root = await this.#root(false);
    const fonts = await root.getDirectoryHandle(FONT_DIRECTORY);
    const bytes = await readBytes(fonts, `${id}.font`);
    if (bytes.byteLength !== metadata.size || await sha256(bytes) !== metadata.sha256) {
      throw new Error("Font asset failed integrity validation");
    }
    return { metadata, bytes };
  }

  async removeAsset(kind, id) {
    if (!["gradients", "patterns", "fonts"].includes(kind)) {
      throw new TypeError("Unknown asset family");
    }
    validateId(id);
    const current = await this.loadAssetLibrary();
    const next = { ...current, [kind]: current[kind].filter((asset) => asset.id !== id) };
    const saved = await this.saveAssetLibrary(next);
    if (kind === "fonts") {
      try {
        const root = await this.#root(false);
        const fonts = await root.getDirectoryHandle(FONT_DIRECTORY);
        await fonts.removeEntry(`${id}.font`);
      } catch { /* Manifest publication already made an orphan harmless. */ }
    }
    return saved;
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
        let selection = null;
        if (manifest.selection) {
          const gray = await readBytes(workspace, SELECTION_FILES[slotIndex]);
          if (gray.byteLength !== manifest.selection.size) continue;
          if (await sha256(gray) !== manifest.selection.sha256) continue;
          selection = { bounds: { ...manifest.selection.bounds }, gray };
        }
        return { manifest, bytes, selection };
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
        if (validManifest(manifest, id)) result.push({ ...manifest, format: manifest.format || "psd" });
      } catch { /* A torn or absent generation is not recoverable. */ }
    }
    if (!validate) return result;
    return result;
  }

  async #restoreVersionFromDirectory(versions, manifest) {
    try {
      const bytes = await readBytes(versions, versionFilename(manifest.versionId, "layered"));
      if (bytes.byteLength !== manifest.payloadSize ||
          await sha256(bytes) !== manifest.payloadSha256 || layeredFormat(bytes) !== manifest.format) return null;
      let selection = null;
      if (manifest.selection) {
        const gray = await readBytes(versions, versionFilename(manifest.versionId, "selection"));
        if (gray.byteLength !== manifest.selection.size ||
            await sha256(gray) !== manifest.selection.sha256) return null;
        selection = { bounds: { ...manifest.selection.bounds }, gray };
      }
      return { manifest, bytes, selection };
    } catch { return null; }
  }

  async #root(create) {
    const originRoot = await this.#rootProvider();
    return originRoot.getDirectoryHandle(ROOT_NAME, { create });
  }

  async #workspace(id, create) {
    return (await this.#root(create)).getDirectoryHandle(id, { create });
  }

  async #versionRoot(create) {
    const originRoot = await this.#rootProvider();
    return originRoot.getDirectoryHandle(VERSION_ROOT_NAME, { create });
  }

  async #versions(id, create) {
    return (await this.#versionRoot(create)).getDirectoryHandle(id, { create });
  }

  async #removeInvalidVersionFiles(id, manifests) {
    const versions = await this.#versions(id, false);
    const retained = new Set();
    for (const manifest of manifests) {
      retained.add(versionFilename(manifest.versionId, "json"));
      retained.add(versionFilename(manifest.versionId, "layered"));
      if (manifest.selection) retained.add(versionFilename(manifest.versionId, "selection"));
    }
    for await (const entry of versions.values()) {
      if (entry.kind === "file" && !retained.has(entry.name)) {
        try { await versions.removeEntry(entry.name); }
        catch { /* A concurrent browser cleanup may already have removed it. */ }
      }
    }
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

async function fileExists(directory, name) {
  try { await directory.getFileHandle(name); return true; } catch { return false; }
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

function normalizeVersionLabel(label) {
  const value = String(label ?? "Version").trim();
  if (!value || value.length > 128) throw new TypeError("Local version label must be 1 to 128 characters");
  return value;
}

function normalizeRevision(revision) {
  if (typeof revision === "bigint" && revision >= 0n) return String(revision);
  if (Number.isSafeInteger(revision) && revision >= 0) return String(revision);
  throw new TypeError("Local version revision must be a non-negative integer");
}

function versionFilename(versionId, suffix) {
  validateId(versionId);
  return `${versionId}.${suffix}`;
}

function validateVersionRetention(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new RangeError("Local version retention must be between 1 and 64");
  }
}

function layeredFormat(bytes) {
  if (bytes.byteLength < 6 || bytes[0] !== 56 || bytes[1] !== 66 ||
      bytes[2] !== 80 || bytes[3] !== 83 || bytes[4] !== 0 ||
      (bytes[5] !== 1 && bytes[5] !== 2)) {
    throw new TypeError("Workspace checkpoint requires encoded PSD or PSB bytes");
  }
  return bytes[5] === 2 ? "psb" : "psd";
}

function validManifest(value, id) {
  return value?.version === MANIFEST_VERSION && value.id === id &&
    Number.isSafeInteger(value.generation) && value.generation > 0 &&
    (value.slot === "a" || value.slot === "b") &&
    (value.format === undefined || value.format === "psd" || value.format === "psb") &&
    typeof value.revision === "string" && typeof value.name === "string" &&
    Number.isSafeInteger(value.snapshotSize) && value.snapshotSize > 0 &&
    /^[0-9a-f]{64}$/.test(value.snapshotSha256) &&
    (value.selection === undefined || validSelectionManifest(value.selection)) &&
    typeof value.updatedAt === "string";
}

function validSelectionManifest(value) {
  const bounds = value?.bounds;
  const area = bounds && bounds.width * bounds.height;
  return bounds && isInt32(bounds.x) && isInt32(bounds.y) &&
    isInt32(bounds.width) && bounds.width > 0 &&
    isInt32(bounds.height) && bounds.height > 0 && Number.isSafeInteger(area) &&
    Number.isSafeInteger(value.size) && value.size > 0 &&
    value.size <= MAX_SELECTION_BYTES && area === value.size &&
    typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}

function validVersionManifest(value, workspaceId) {
  return value?.version === VERSION_MANIFEST_VERSION && value.workspaceId === workspaceId &&
    typeof value.versionId === "string" && ID_PATTERN.test(value.versionId) &&
    typeof value.label === "string" && value.label.length > 0 && value.label.length <= 128 &&
    typeof value.name === "string" && value.name.length > 0 && value.name.length <= 256 &&
    (value.format === "psd" || value.format === "psb") &&
    typeof value.revision === "string" && /^(0|[1-9][0-9]*)$/.test(value.revision) &&
    Number.isSafeInteger(value.payloadSize) && value.payloadSize > 0 &&
    typeof value.payloadSha256 === "string" && /^[0-9a-f]{64}$/.test(value.payloadSha256) &&
    (value.selection === undefined || validSelectionManifest(value.selection)) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}

function compareVersionsNewestFirst(left, right) {
  return right.createdAt.localeCompare(left.createdAt) ||
    right.versionId.localeCompare(left.versionId);
}

function normalizeSelection(value) {
  if (value == null) return null;
  const bounds = value.bounds;
  const gray = value.gray;
  const area = bounds && bounds.width * bounds.height;
  if (!bounds || !isInt32(bounds.x) || !isInt32(bounds.y) ||
      !isInt32(bounds.width) || bounds.width <= 0 ||
      !isInt32(bounds.height) || bounds.height <= 0 || !Number.isSafeInteger(area) ||
      !(gray instanceof Uint8Array) || gray.byteLength === 0 ||
      gray.byteLength > MAX_SELECTION_BYTES ||
      area !== gray.byteLength) {
    throw new TypeError("Workspace selection sidecar is invalid");
  }
  return { bounds: { x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height }, gray: gray.slice() };
}

function isInt32(value) {
  return Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
}

function normalizePreferences(value, stored) {
  if (!value || typeof value !== "object" || (stored && value.version !== PREFERENCES_VERSION)) {
    throw new TypeError("Invalid workspace preferences");
  }
  const result = {};
  if (value.locale !== undefined) {
    if (!["en", "ru"].includes(value.locale)) throw new TypeError("Invalid preferred locale");
    result.locale = value.locale;
  }
  if (value.tool !== undefined) {
    if (!TOOL_IDS.has(value.tool)) throw new TypeError("Invalid preferred tool");
    result.tool = value.tool;
  }
  if (value.brushSize !== undefined) {
    const brushSize = Number(value.brushSize);
    if (!Number.isInteger(brushSize) || brushSize < 1 || brushSize > 4096) {
      throw new RangeError("Preferred brush size must be between 1 and 4096");
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
  if (result.paintPreset !== undefined && !PAINT_PRESETS.has(result.paintPreset) &&
      !/^asset:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result.paintPreset)) {
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
  if (value.guidesVisible !== undefined) result.guidesVisible = Boolean(value.guidesVisible);
  if (value.snappingEnabled !== undefined) result.snappingEnabled = Boolean(value.snappingEnabled);
  return result;
}

function emptyAssetLibrary() {
  return { version: ASSET_LIBRARY_VERSION, generation: 0,
    gradients: [], patterns: [], fonts: [] };
}

function normalizeAssetName(value, subject, maximum) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new TypeError(`${subject} is invalid`);
  }
  return value.trim();
}

function normalizeAssetLibrary(value, stored) {
  if (!value || typeof value !== "object" ||
      (stored && value.version !== ASSET_LIBRARY_VERSION) ||
      !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new TypeError("Invalid asset library");
  }
  const result = { version: ASSET_LIBRARY_VERSION, generation: value.generation,
    gradients: [], patterns: [], fonts: [] };
  const ids = new Set();
  const add = (kind, asset) => {
    if (!asset || typeof asset !== "object") throw new TypeError("Invalid asset entry");
    validateId(asset.id);
    if (ids.has(asset.id)) throw new TypeError("Asset ids must be unique");
    ids.add(asset.id);
    if (kind === "gradients") {
      result.gradients.push({ id: asset.id, name: normalizeAssetName(asset.name, "Gradient name", 128),
        start: normalizeHex(asset.start), end: normalizeHex(asset.end) });
    } else if (kind === "patterns") {
      if (!["checker", "dots"].includes(asset.kind)) throw new TypeError("Invalid pattern kind");
      const size = Number(asset.size);
      if (!Number.isInteger(size) || size < 1 || size > 128) throw new RangeError("Pattern size is invalid");
      result.patterns.push({ id: asset.id, name: normalizeAssetName(asset.name, "Pattern name", 128),
        kind: asset.kind, foreground: normalizeHex(asset.foreground),
        background: normalizeHex(asset.background), size });
    } else {
      if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_FONT_BYTES ||
          typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
        throw new TypeError("Invalid font asset metadata");
      }
      result.fonts.push({ id: asset.id, family: normalizeAssetName(asset.family, "Font family", 128),
        filename: normalizeAssetName(asset.filename, "Font filename", 256),
        size: asset.size, sha256: asset.sha256 });
    }
  };
  for (const kind of ["gradients", "patterns", "fonts"]) {
    if (!Array.isArray(value[kind]) || value[kind].length > 128) {
      throw new TypeError(`Invalid ${kind} asset list`);
    }
    for (const asset of value[kind]) add(kind, asset);
  }
  return result;
}

function normalizeHex(value) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new TypeError("Invalid asset colour");
  }
  return value.toLowerCase();
}
