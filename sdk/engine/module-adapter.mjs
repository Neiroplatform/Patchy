const PROTOCOL_VERSION = 1;
const ERROR_SIZE = 260;
const PROTOCOL_INFO_SIZE = 16;
const EVENT_SIZE = 64;
const DOCUMENT_SIZE = 56;
const LAYER_SIZE = 320;
const BUFFER_SIZE = 8;
const COMMAND_SIZE = 304;
const PIXEL_LAYER_INPUT_SIZE = 80;
const FILTER_INPUT_SIZE = 56;
const SELECTION_SIZE = 32;
const SELECTION_INPUT_SIZE = 32;
const SELECTION_MASK_INPUT_SIZE = 56;
const RECT_SIZE = 16;
const LAYER_MASK_INPUT_SIZE = 72;
const LAYER_MASK_SIZE = 24;
const TEXT_INPUT_SIZE = 96;
const TEXT_PROJECTION_SIZE = 1312;
const SMART_OBJECT_INPUT_SIZE = 112;
const SMART_OBJECT_PROJECTION_SIZE = 288;
const ADJUSTMENT_INPUT_SIZE = 88;
const ADJUSTMENT_PROJECTION_SIZE = 44;
const SMART_FILTER_INPUT_SIZE = 56;
const VECTOR_MASK_INPUT_SIZE = 64;
const VECTOR_SHAPE_INPUT_SIZE = 64;
const PATH_SUBPATH_SIZE = 20;
const PATH_ANCHOR_SIZE = 56;
const CHANNEL_PROJECTION_SIZE = 288;
const ALPHA_CHANNEL_INPUT_SIZE = 40;
const DOCUMENT_PATH_INPUT_SIZE = 56;
const DOCUMENT_PATH_PROJECTION_SIZE = 288;
const PATH_SUBPATH_PROJECTION_SIZE = 16;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// Pthread Emscripten modules expose HEAPU8 over SharedArrayBuffer. Browsers
// reject shared views in TextDecoder even for immutable projected strings, so
// copy only the bounded text slice into an ordinary ArrayBuffer first.
function decodeHeap(bytes) {
  return decoder.decode(Uint8Array.from(bytes));
}

function u64(view, offset) {
  return view.getBigUint64(offset, true);
}

export class PatchyEngineError extends Error {
  constructor(code, message) {
    super(message || `Patchy engine error ${code}`);
    this.name = "PatchyEngineError";
    this.code = code;
  }
}

export class EmscriptenPatchyEngine {
  #module;
  #runtime = 0;
  #sessions = new Set();
  #capabilities = 0n;

  constructor(module) {
    this.#module = module;
    const error = this.#alloc(ERROR_SIZE);
    try {
      const info = this.#alloc(PROTOCOL_INFO_SIZE);
      try {
        this.#view(info, PROTOCOL_INFO_SIZE).setUint32(0, PROTOCOL_INFO_SIZE, true);
        this.#check(module._patchy_engine_get_protocol_info(info, error), error);
        const view = this.#view(info, PROTOCOL_INFO_SIZE);
        if (view.getUint32(4, true) !== PROTOCOL_VERSION) {
          throw new PatchyEngineError(2, "Patchy engine protocol version mismatch");
        }
        this.#capabilities = u64(view, 8);
      } finally {
        module._free(info);
      }
      this.#runtime = module._patchy_engine_runtime_create(PROTOCOL_VERSION, error);
      if (!this.#runtime) this.#throwError(error);
    } finally {
      module._free(error);
    }
  }

  get capabilities() { return this.#capabilities; }

  open(bytes) {
    const input = this.#alloc(bytes.byteLength || 1);
    const error = this.#alloc(ERROR_SIZE);
    try {
      this.#module.HEAPU8.set(bytes, input);
      const session = this.#module._patchy_engine_session_open_psd(
        this.#runtime, input, bytes.byteLength, error);
      if (!session) this.#throwError(error);
      this.#sessions.add(session);
      return session;
    } finally {
      this.#module._free(error);
      this.#module._free(input);
    }
  }

  create(width, height) {
    return this.#withError((error) => {
      const session = this.#module._patchy_engine_session_create_rgba8(
        this.#runtime, width, height, error);
      if (!session) this.#throwError(error);
      this.#sessions.add(session);
      return session;
    });
  }

  snapshot(session) {
    return this.#withError((error) => {
      const document = this.#alloc(DOCUMENT_SIZE);
      try {
        this.#view(document, DOCUMENT_SIZE).setUint32(0, DOCUMENT_SIZE, true);
        this.#check(this.#module._patchy_engine_session_document(
          session, document, error), error);
        const view = this.#view(document, DOCUMENT_SIZE);
        const result = {
          width: view.getInt32(4, true),
          height: view.getInt32(8, true),
          colorMode: view.getUint32(12, true),
          bitDepth: view.getUint32(16, true),
          channels: view.getUint32(20, true),
          activeLayerId: u64(view, 24),
          revision: u64(view, 32),
          stateId: u64(view, 40),
          layerCount: view.getUint32(48, true),
          hasActiveLayer: view.getUint8(52) !== 0,
          dirty: view.getUint8(53) !== 0,
          canUndo: view.getUint8(54) !== 0,
          canRedo: view.getUint8(55) !== 0,
          layers: [],
          selection: [],
          selectionMask: null,
          channels: [],
          paths: [],
        };
        result.layers = this.#layers(session, result.layerCount, error);
        const selection = this.#selection(session, error);
        result.selection = selection.rects;
        result.selectionMask = selection.mask;
        result.channels = this.#channels(session, error);
        result.paths = this.#paths(session, error);
        return result;
      } finally {
        this.#module._free(document);
      }
    });
  }

  setLayerVisibility(session, snapshot, layerId, visible) {
    return this.#mutation((event, error) =>
      this.#module._patchy_engine_session_set_layer_visibility(
        session, snapshot.stateId, snapshot.revision, layerId,
        visible ? 1 : 0, event, error));
  }

  setLayerOpacity(session, snapshot, layerId, opacity) {
    return this.#command(session, snapshot, 2, (view) => {
      view.setBigUint64(32, layerId, true);
      view.setFloat32(40, opacity, true);
    });
  }

  setLayerFillOpacity(session, snapshot, layerId, opacity) {
    return this.#command(session, snapshot, 3, (view) => {
      view.setBigUint64(32, layerId, true); view.setFloat32(40, opacity, true);
    });
  }

  setLayerLocks(session, snapshot, layerId, lockFlags) {
    return this.#command(session, snapshot, 6, (view) => {
      view.setBigUint64(32, layerId, true); view.setUint32(40, lockFlags, true);
    });
  }

  setLayerClipping(session, snapshot, layerId, clipped) {
    return this.#command(session, snapshot, 7, (view) => {
      view.setBigUint64(32, layerId, true); view.setUint8(40, clipped ? 1 : 0);
    });
  }

  setLayerStylePreset(session, snapshot, layerId, presetId) {
    const bytes = this.#text(presetId, "Layer style preset ids", 64);
    return this.#command(session, snapshot, 35, (view, command) => {
      view.setBigUint64(32, layerId, true); view.setUint32(40, bytes.byteLength, true);
      this.#module.HEAPU8.set(bytes, command + 44);
    });
  }

  setLayerBlendMode(session, snapshot, layerId, blendMode) {
    return this.#command(session, snapshot, 4, (view) => {
      view.setBigUint64(32, layerId, true);
      view.setUint32(40, blendMode, true);
    });
  }

  renameLayer(session, snapshot, layerId, name) {
    const bytes = this.#text(name);
    return this.#command(session, snapshot, 5, (view, command) => {
      view.setBigUint64(32, layerId, true);
      view.setUint32(40, bytes.byteLength, true);
      this.#module.HEAPU8.set(bytes, command + 44);
    });
  }

  removeLayer(session, snapshot, layerId) {
    return this.#command(session, snapshot, 9, (view) =>
      view.setBigUint64(32, layerId, true));
  }

  resizeImage(session, snapshot, width, height) {
    this.#dimensions(width, height);
    return this.#command(session, snapshot, 10, (view) => {
      view.setInt32(32, width, true);
      view.setInt32(36, height, true);
    });
  }

  resizeCanvas(session, snapshot, width, height, anchor = 4, color = [0, 0, 0, 0]) {
    this.#dimensions(width, height);
    if (!Number.isInteger(anchor) || anchor < 0 || anchor > 8) {
      throw new TypeError("Canvas anchor must be an integer from 0 through 8");
    }
    const rgba = this.#color(color);
    return this.#command(session, snapshot, 11, (view) => {
      view.setInt32(32, width, true);
      view.setInt32(36, height, true);
      view.setUint32(40, anchor, true);
      rgba.forEach((component, index) => view.setUint8(44 + index, component));
    });
  }

  rotateCanvas(session, snapshot, clockwiseDegrees, color = [0, 0, 0, 0]) {
    if (!Number.isFinite(clockwiseDegrees)) throw new TypeError("Rotation must be finite");
    const rgba = this.#color(color);
    return this.#command(session, snapshot, 12, (view) => {
      view.setFloat64(32, clockwiseDegrees, true);
      rgba.forEach((component, index) => view.setUint8(40 + index, component));
    });
  }

  cropDocument(session, snapshot, crop, clockwiseDegrees = 0,
               color = [0, 0, 0, 0], clipToCanvas = true) {
    this.#rect(crop);
    if (!Number.isFinite(clockwiseDegrees)) throw new TypeError("Crop rotation must be finite");
    const rgba = this.#color(color);
    return this.#command(session, snapshot, 13, (view) => {
      view.setInt32(32, crop.x, true);
      view.setInt32(36, crop.y, true);
      view.setInt32(40, crop.width, true);
      view.setInt32(44, crop.height, true);
      view.setFloat64(48, clockwiseDegrees, true);
      rgba.forEach((component, index) => view.setUint8(56 + index, component));
      view.setUint8(60, clipToCanvas ? 1 : 0);
    });
  }

  setSelection(session, snapshot, rects) {
    if (!Array.isArray(rects) || rects.length > 1) {
      throw new TypeError("Selection must contain at most one rectangle");
    }
    rects.forEach((rect) => this.#rect(rect));
    const values = this.#alloc(Math.max(1, rects.length * RECT_SIZE));
    const input = this.#alloc(SELECTION_INPUT_SIZE);
    try {
      const rectView = this.#view(values, Math.max(1, rects.length * RECT_SIZE));
      rects.forEach((rect, index) => {
        const offset = index * RECT_SIZE;
        rectView.setInt32(offset, rect.x, true);
        rectView.setInt32(offset + 4, rect.y, true);
        rectView.setInt32(offset + 8, rect.width, true);
        rectView.setInt32(offset + 12, rect.height, true);
      });
      const view = this.#view(input, SELECTION_INPUT_SIZE);
      view.setUint32(0, SELECTION_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true);
      view.setBigUint64(16, snapshot.revision, true);
      view.setUint32(24, rects.length ? values : 0, true);
      view.setUint32(28, rects.length, true);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_set_selection(
          session, input, event, error));
    } finally {
      this.#module._free(input);
      this.#module._free(values);
    }
  }

  setSelectionMask(session, snapshot, input) {
    this.#rect(input?.bounds);
    if (!(input?.gray instanceof Uint8Array) ||
        input.gray.byteLength !== input.bounds.width * input.bounds.height) {
      throw new TypeError("Selection mask requires one gray byte per bounded pixel");
    }
    const gray = this.#alloc(input.gray.byteLength);
    const value = this.#alloc(SELECTION_MASK_INPUT_SIZE);
    try {
      this.#module.HEAPU8.set(input.gray, gray);
      const view = this.#view(value, SELECTION_MASK_INPUT_SIZE);
      view.setUint32(0, SELECTION_MASK_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true);
      view.setBigUint64(16, snapshot.revision, true);
      view.setInt32(24, input.bounds.x, true); view.setInt32(28, input.bounds.y, true);
      view.setInt32(32, input.bounds.width, true); view.setInt32(36, input.bounds.height, true);
      view.setInt32(40, input.bounds.width, true); view.setInt32(44, input.bounds.height, true);
      view.setUint32(48, gray, true); view.setUint32(52, input.gray.byteLength, true);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_set_selection_mask(session, value, event, error));
    } finally { this.#module._free(value); this.#module._free(gray); }
  }

  modifySelection(session, snapshot, type, pixels = 0) {
    if (![19, 20, 21, 22, 33, 34].includes(type) || !Number.isInteger(pixels)) {
      throw new TypeError("Supported selection morphology command is required");
    }
    return this.#command(session, snapshot, type, (view) => view.setInt32(32, pixels, true));
  }

  selectChannel(session, snapshot, channelId) {
    return this.#command(session, snapshot, 23, (view) => view.setBigUint64(32, channelId, true));
  }

  renameChannel(session, snapshot, channelId, name) {
    const bytes = this.#text(name, "Channel names");
    return this.#command(session, snapshot, 24, (view, command) => {
      view.setBigUint64(32, channelId, true); view.setUint32(40, bytes.byteLength, true);
      this.#module.HEAPU8.set(bytes, command + 44);
    });
  }

  invertChannel(session, snapshot, channelId) {
    return this.#command(session, snapshot, 25, (view) => view.setBigUint64(32, channelId, true));
  }

  removeChannel(session, snapshot, channelId) {
    return this.#command(session, snapshot, 26, (view) => view.setBigUint64(32, channelId, true));
  }

  moveChannel(session, snapshot, channelId, finalIndex) {
    this.#index(finalIndex, snapshot.channels.length, "Channel destination");
    return this.#command(session, snapshot, 27, (view) => {
      view.setBigUint64(32, channelId, true); view.setUint32(40, finalIndex, true);
    });
  }

  selectPath(session, snapshot, pathId, feather = 0, combine = 0, antialias = true) {
    if (!Number.isFinite(feather) || feather < 0 || !Number.isInteger(combine) || combine < 0 || combine > 3) {
      throw new TypeError("Supported path selection settings are required");
    }
    return this.#command(session, snapshot, 28, (view) => {
      view.setBigUint64(32, pathId, true); view.setFloat64(40, feather, true);
      view.setUint32(48, combine, true); view.setUint8(52, antialias ? 1 : 0);
    });
  }

  renamePath(session, snapshot, pathId, name) {
    const bytes = this.#text(name, "Path names");
    return this.#command(session, snapshot, 29, (view, command) => {
      view.setBigUint64(32, pathId, true); view.setUint32(40, bytes.byteLength, true);
      this.#module.HEAPU8.set(bytes, command + 44);
    });
  }

  removePath(session, snapshot, pathId) {
    return this.#command(session, snapshot, 30, (view) => view.setBigUint64(32, pathId, true));
  }

  movePath(session, snapshot, pathId, finalIndex) {
    this.#index(finalIndex, snapshot.paths.length, "Path destination");
    return this.#command(session, snapshot, 31, (view) => {
      view.setBigUint64(32, pathId, true); view.setUint32(40, finalIndex, true);
    });
  }

  setClippingPath(session, snapshot, pathId, clipping) {
    return this.#command(session, snapshot, 32, (view) => {
      view.setBigUint64(32, pathId, true); view.setUint8(40, clipping ? 1 : 0);
    });
  }

  addAlphaChannel(session, snapshot, input) {
    const name = this.#text(input.name);
    if (!(input.gray instanceof Uint8Array) || input.gray.byteLength !== snapshot.width * snapshot.height) {
      throw new TypeError("Alpha channel requires one gray byte per canvas pixel");
    }
    const gray = this.#alloc(input.gray.byteLength); const namePointer = this.#alloc(name.byteLength || 1);
    const value = this.#alloc(ALPHA_CHANNEL_INPUT_SIZE);
    try {
      this.#module.HEAPU8.set(input.gray, gray); this.#module.HEAPU8.set(name, namePointer);
      const view = this.#view(value, ALPHA_CHANNEL_INPUT_SIZE);
      view.setUint32(0, ALPHA_CHANNEL_INPUT_SIZE, true); view.setBigUint64(8, snapshot.stateId, true);
      view.setBigUint64(16, snapshot.revision, true); view.setUint32(24, gray, true);
      view.setUint32(28, input.gray.byteLength, true); view.setUint32(32, namePointer, true);
      view.setUint32(36, name.byteLength, true);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_add_alpha_channel(session, value, event, error));
    } finally { this.#module._free(value); this.#module._free(namePointer); this.#module._free(gray); }
  }

  addDocumentPath(session, snapshot, input) {
    return this.#documentPathMutation("_patchy_engine_session_add_document_path",
      session, snapshot, null, input);
  }

  updateDocumentPath(session, snapshot, pathId, input) {
    return this.#documentPathMutation("_patchy_engine_session_update_document_path",
      session, snapshot, pathId, input);
  }

  mergeVisibleCopy(session, snapshot, name = "Merged Visible (Copy)") {
    const bytes = this.#text(name);
    const pointer = this.#alloc(bytes.byteLength || 1);
    try {
      this.#module.HEAPU8.set(bytes, pointer);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_merge_visible_copy(
          session, snapshot.stateId, snapshot.revision, pointer,
          bytes.byteLength, event, error));
    } finally { this.#module._free(pointer); }
  }

  rasterizeLayer(session, snapshot, layerId) {
    const layer = snapshot.layers.find((candidate) => candidate.id === layerId);
    if (!layer || ![3, 4, 5].includes(layer.kind) ||
        layer.bounds.width <= 0 || layer.bounds.height <= 0) {
      throw new TypeError("Rasterizable layer is required");
    }
    return this.replacePixelLayer(session, snapshot, layerId, {
      name: layer.name, width: layer.bounds.width, height: layer.bounds.height,
      bounds: layer.bounds, rgba: this.layerPixels(session, layerId), rasterize: true,
    });
  }

  #documentPathMutation(symbol, session, snapshot, pathId, input) {
    const name = this.#text(input.name);
    const path = this.#path(input.path); const namePointer = this.#alloc(name.byteLength || 1);
    const value = this.#alloc(DOCUMENT_PATH_INPUT_SIZE);
    try {
      this.#module.HEAPU8.set(name, namePointer);
      const view = this.#view(value, DOCUMENT_PATH_INPUT_SIZE);
      view.setUint32(0, DOCUMENT_PATH_INPUT_SIZE, true); view.setBigUint64(8, snapshot.stateId, true);
      view.setBigUint64(16, snapshot.revision, true); view.setUint32(24, namePointer, true);
      view.setUint32(28, name.byteLength, true); view.setUint32(32, input.kind ?? 0, true);
      view.setUint8(36, input.clipping ? 1 : 0); this.#writePath(view, 40, path);
      return this.#mutation((event, error) => pathId == null
        ? this.#module[symbol](session, value, event, error)
        : this.#module[symbol](session, pathId, value, event, error));
    } finally { this.#module._free(value); this.#module._free(namePointer); this.#releasePath(path); }
  }

  setLayerMask(session, snapshot, layerId, mask) {
    const gray = mask?.gray;
    if (mask) {
      this.#rect(mask.bounds);
      if (!(gray instanceof Uint8Array) ||
          gray.byteLength !== mask.bounds.width * mask.bounds.height) {
        throw new TypeError("Layer mask must contain one gray byte per bounded pixel");
      }
    }
    const pixels = this.#alloc(gray?.byteLength || 1);
    const input = this.#alloc(LAYER_MASK_INPUT_SIZE);
    try {
      if (gray) this.#module.HEAPU8.set(gray, pixels);
      const view = this.#view(input, LAYER_MASK_INPUT_SIZE);
      view.setUint32(0, LAYER_MASK_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true);
      view.setBigUint64(16, snapshot.revision, true);
      view.setBigUint64(24, layerId, true);
      if (mask) {
        view.setInt32(32, mask.bounds.x, true);
        view.setInt32(36, mask.bounds.y, true);
        view.setInt32(40, mask.bounds.width, true);
        view.setInt32(44, mask.bounds.height, true);
        view.setInt32(48, mask.bounds.width, true);
        view.setInt32(52, mask.bounds.height, true);
        view.setUint32(56, pixels, true);
        view.setUint32(60, gray.byteLength, true);
        view.setUint8(64, mask.defaultColor ?? 0);
        view.setUint8(65, mask.disabled ? 1 : 0);
        view.setUint8(66, mask.linked === false ? 0 : 1);
        view.setUint8(67, 1);
      }
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_set_layer_mask(
          session, input, event, error));
    } finally {
      this.#module._free(input);
      this.#module._free(pixels);
    }
  }

  layerMaskPixels(session, layerId) {
    return this.#bufferCall((buffer, event, error) =>
      this.#module._patchy_engine_session_layer_mask_pixels(
        session, layerId, buffer, error));
  }

  replacePixelLayerAndMask(session, snapshot, layerId, input, mask) {
    const name = this.#text(input.name);
    const expected = input.width * input.height * 4;
    if (!(input.rgba instanceof Uint8Array) || input.rgba.byteLength !== expected ||
        !(mask.gray instanceof Uint8Array) || mask.gray.byteLength !== mask.width * mask.height) {
      throw new TypeError("Complete linked layer and mask pixels are required");
    }
    this.#rect(input.bounds); this.#rect(mask.bounds);
    const pointers = [input.rgba, name, mask.gray].map((bytes) => this.#alloc(bytes.byteLength || 1));
    const pixelValue = this.#alloc(PIXEL_LAYER_INPUT_SIZE);
    const maskValue = this.#alloc(LAYER_MASK_INPUT_SIZE);
    try {
      [input.rgba, name, mask.gray].forEach((bytes, index) => this.#module.HEAPU8.set(bytes, pointers[index]));
      const pixels = this.#view(pixelValue, PIXEL_LAYER_INPUT_SIZE);
      pixels.setUint32(0, PIXEL_LAYER_INPUT_SIZE, true); pixels.setBigUint64(8, snapshot.stateId, true);
      pixels.setBigUint64(16, snapshot.revision, true); pixels.setBigUint64(24, layerId, true);
      pixels.setInt32(32, input.bounds.x, true); pixels.setInt32(36, input.bounds.y, true);
      pixels.setInt32(40, input.bounds.width, true); pixels.setInt32(44, input.bounds.height, true);
      pixels.setInt32(48, input.width, true); pixels.setInt32(52, input.height, true);
      pixels.setUint32(56, pointers[0], true); pixels.setUint32(60, input.rgba.byteLength, true);
      pixels.setUint32(64, pointers[1], true); pixels.setUint32(68, name.byteLength, true);
      const value = this.#view(maskValue, LAYER_MASK_INPUT_SIZE);
      value.setUint32(0, LAYER_MASK_INPUT_SIZE, true); value.setBigUint64(8, snapshot.stateId, true);
      value.setBigUint64(16, snapshot.revision, true); value.setBigUint64(24, layerId, true);
      value.setInt32(32, mask.bounds.x, true); value.setInt32(36, mask.bounds.y, true);
      value.setInt32(40, mask.bounds.width, true); value.setInt32(44, mask.bounds.height, true);
      value.setInt32(48, mask.width, true); value.setInt32(52, mask.height, true);
      value.setUint32(56, pointers[2], true); value.setUint32(60, mask.gray.byteLength, true);
      value.setUint8(64, mask.defaultColor ?? 0); value.setUint8(65, mask.disabled ? 1 : 0);
      value.setUint8(66, 1); value.setUint8(67, 1);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_replace_rgba8_layer_and_mask(
          session, pixelValue, maskValue, event, error));
    } finally {
      this.#module._free(maskValue); this.#module._free(pixelValue);
      pointers.forEach((pointer) => this.#module._free(pointer));
    }
  }

  applyFilter(session, snapshot, layerId, filterId, cancellation, onProgress) {
    const filter = this.#text(filterId, "Filter identifiers", 128);
    if (filter.byteLength === 0) throw new TypeError("Filter identifier is required");
    if (!(cancellation instanceof Int32Array) ||
        !(cancellation.buffer instanceof SharedArrayBuffer) || cancellation.length < 1) {
      throw new TypeError("Filter cancellation must use shared Int32 storage");
    }
    const filterPointer = this.#alloc(filter.byteLength || 1);
    const input = this.#alloc(FILTER_INPUT_SIZE);
    const selection = snapshot.selection || [];
    const selectionPointer = this.#alloc(Math.max(1, selection.length * RECT_SIZE));
    this.#module.HEAPU8.set(filter, filterPointer);
    const selectionView = this.#view(selectionPointer, Math.max(1, selection.length * RECT_SIZE));
    selection.forEach((rect, index) => {
      const offset = index * RECT_SIZE;
      selectionView.setInt32(offset, rect.x, true);
      selectionView.setInt32(offset + 4, rect.y, true);
      selectionView.setInt32(offset + 8, rect.width, true);
      selectionView.setInt32(offset + 12, rect.height, true);
    });
    const view = this.#view(input, FILTER_INPUT_SIZE);
    view.setUint32(0, FILTER_INPUT_SIZE, true);
    view.setBigUint64(8, snapshot.stateId, true);
    view.setBigUint64(16, snapshot.revision, true);
    view.setBigUint64(24, layerId, true);
    view.setUint32(32, filterPointer, true);
    view.setUint32(36, filter.byteLength, true);
    view.setUint32(48, selection.length ? selectionPointer : 0, true);
    view.setUint32(52, selection.length, true);
    const callback = this.#module.addFunction((completed, total, stage) => {
      onProgress?.({ completed, total, stage,
        ratio: total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0 });
      return Atomics.load(cancellation, 0) === 0 ? 1 : 0;
    }, "iiiii");
    try {
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_apply_filter(
          session, input, callback, 0, 0, event, error));
    } finally {
      this.#module.removeFunction(callback);
      this.#module._free(input);
      this.#module._free(filterPointer);
      this.#module._free(selectionPointer);
    }
  }

  groupLayer(session, snapshot, layerId, name) {
    const bytes = this.#text(name);
    const namePointer = this.#alloc(bytes.byteLength || 1);
    try {
      this.#module.HEAPU8.set(bytes, namePointer);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_group_layer(
          session, snapshot.stateId, snapshot.revision, layerId,
          namePointer, bytes.byteLength, event, error));
    } finally {
      this.#module._free(namePointer);
    }
  }

  ungroup(session, snapshot, layerId) {
    return this.#command(session, snapshot, 16, (view) =>
      view.setBigUint64(32, layerId, true));
  }

  addPixelLayer(session, snapshot, input) {
    const name = this.#text(input.name);
    const rgba = input.rgba;
    const expected = input.width * input.height * 4;
    if (!(rgba instanceof Uint8Array) || !Number.isSafeInteger(expected) ||
        input.width <= 0 || input.height <= 0 || rgba.byteLength !== expected) {
      throw new TypeError("Complete RGBA8 pixel layer input is required");
    }
    const pixels = this.#alloc(rgba.byteLength);
    const namePointer = this.#alloc(name.byteLength || 1);
    const value = this.#alloc(PIXEL_LAYER_INPUT_SIZE);
    try {
      this.#module.HEAPU8.set(rgba, pixels);
      this.#module.HEAPU8.set(name, namePointer);
      const view = this.#view(value, PIXEL_LAYER_INPUT_SIZE);
      view.setUint32(0, PIXEL_LAYER_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true);
      view.setBigUint64(16, snapshot.revision, true);
      view.setInt32(32, input.bounds.x, true);
      view.setInt32(36, input.bounds.y, true);
      view.setInt32(40, input.bounds.width, true);
      view.setInt32(44, input.bounds.height, true);
      view.setInt32(48, input.width, true);
      view.setInt32(52, input.height, true);
      view.setUint32(56, pixels, true);
      view.setUint32(60, rgba.byteLength, true);
      view.setUint32(64, namePointer, true);
      view.setUint32(68, name.byteLength, true);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_add_rgba8_layer(
          session, value, event, error));
    } finally {
      this.#module._free(value);
      this.#module._free(namePointer);
      this.#module._free(pixels);
    }
  }

  replacePixelLayer(session, snapshot, layerId, input) {
    return this.#pixelLayerMutation(
      "_patchy_engine_session_replace_rgba8_layer", session, snapshot,
      { ...input, layerId });
  }

  layerPixels(session, layerId) {
    return this.#bufferCall((buffer, event, error) =>
      this.#module._patchy_engine_session_layer_rgba8_pixels(
        session, layerId, buffer, error));
  }

  addTextLayer(session, snapshot, input) {
    return this.#textLayerMutation(
      "_patchy_engine_session_add_text_layer", session, snapshot, null, input);
  }

  updateTextLayer(session, snapshot, layerId, input) {
    return this.#textLayerMutation(
      "_patchy_engine_session_update_text_layer", session, snapshot, layerId, input);
  }

  addAdjustment(session, snapshot, input) {
    return this.#adjustmentMutation(session, snapshot, null, input);
  }

  updateAdjustment(session, snapshot, layerId, input) {
    return this.#adjustmentMutation(session, snapshot, layerId, input);
  }

  addVectorShape(session, snapshot, input) {
    return this.#vectorShapeMutation(
      "_patchy_engine_session_add_vector_shape", session, snapshot, null, input);
  }

  updateVectorShape(session, snapshot, layerId, input) {
    return this.#vectorShapeMutation(
      "_patchy_engine_session_update_vector_shape", session, snapshot, layerId, input);
  }

  #vectorShapeMutation(symbol, session, snapshot, layerId, input) {
    const name = this.#text(input.name);
    const path = this.#path(input.path);
    const value = this.#alloc(VECTOR_SHAPE_INPUT_SIZE);
    const namePointer = this.#alloc(name.byteLength || 1);
    try {
      this.#module.HEAPU8.set(name, namePointer);
      const view = this.#view(value, VECTOR_SHAPE_INPUT_SIZE);
      view.setUint32(0, VECTOR_SHAPE_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true);
      view.setBigUint64(16, snapshot.revision, true);
      view.setUint32(24, namePointer, true); view.setUint32(28, name.byteLength, true);
      this.#writePath(view, 32, path);
      const fill = this.#rgb(input.fill, "Shape fill");
      const stroke = this.#rgb(input.stroke ?? [0, 0, 0], "Shape stroke");
      fill.forEach((component, index) => view.setUint8(48 + index, component));
      view.setUint8(51, input.strokeEnabled ? 1 : 0);
      stroke.forEach((component, index) => view.setUint8(52 + index, component));
      if (!Number.isFinite(input.strokeWidth) || input.strokeWidth < 0) {
        throw new TypeError("Shape stroke width must be finite and non-negative");
      }
      view.setFloat64(56, input.strokeWidth, true);
      return this.#mutation((event, error) => layerId == null
        ? this.#module[symbol](session, value, event, error)
        : this.#module[symbol](session, layerId, value, event, error));
    } finally {
      this.#releasePath(path); this.#module._free(namePointer); this.#module._free(value);
    }
  }

  setVectorMask(session, snapshot, layerId, input) {
    const path = input == null ? null : this.#path(input.path);
    const value = this.#alloc(VECTOR_MASK_INPUT_SIZE);
    try {
      const view = this.#view(value, VECTOR_MASK_INPUT_SIZE);
      view.setUint32(0, VECTOR_MASK_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true); view.setBigUint64(16, snapshot.revision, true);
      view.setBigUint64(24, layerId, true);
      if (path) {
        this.#writePath(view, 32, path);
        if (!Number.isFinite(input.feather ?? 0) || (input.feather ?? 0) < 0) {
          throw new TypeError("Vector mask feather must be finite and non-negative");
        }
        view.setFloat64(48, input.feather ?? 0, true);
        view.setUint8(56, input.density ?? 255); view.setUint8(57, input.disabled ? 1 : 0);
        view.setUint8(58, input.inverted ? 1 : 0); view.setUint8(59, input.unlinked ? 1 : 0);
        view.setUint8(60, input.hidesEffects ? 1 : 0); view.setUint8(61, 1);
      }
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_set_vector_mask(session, value, event, error));
    } finally {
      if (path) this.#releasePath(path); this.#module._free(value);
    }
  }

  addSmartObject(session, snapshot, input) {
    return this.#smartObjectMutation(
      "_patchy_engine_session_add_smart_object", session, snapshot, null, input);
  }

  replaceSmartObject(session, snapshot, layerId, input) {
    return this.#smartObjectMutation(
      "_patchy_engine_session_replace_smart_object", session, snapshot, layerId, input);
  }

  #smartObjectMutation(symbol, session, snapshot, layerId, input) {
    const name = this.#text(input.name);
    const filename = this.#text(input.filename, "Smart Object filename", 256);
    const rgba = input.rgba;
    const source = input.sourceBytes;
    const expected = input.width * input.height * 4;
    if (!(rgba instanceof Uint8Array) || rgba.byteLength !== expected ||
        !(source instanceof Uint8Array) || source.byteLength === 0 || !Number.isSafeInteger(expected)) {
      throw new TypeError("Embedded Smart Object requires preview RGBA and source bytes");
    }
    this.#rect(input.bounds);
    const filetype = String(input.filetype || "    ");
    if (encoder.encode(filetype).byteLength !== 4) throw new TypeError("Smart Object filetype must be four ASCII bytes");
    const pointers = [rgba, name, filename, source].map((bytes) => this.#alloc(bytes.byteLength || 1));
    const value = this.#alloc(SMART_OBJECT_INPUT_SIZE);
    try {
      [rgba, name, filename, source].forEach((bytes, index) => this.#module.HEAPU8.set(bytes, pointers[index]));
      const view = this.#view(value, SMART_OBJECT_INPUT_SIZE);
      view.setUint32(0, SMART_OBJECT_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true); view.setBigUint64(16, snapshot.revision, true);
      view.setInt32(24, input.bounds.x, true); view.setInt32(28, input.bounds.y, true);
      view.setInt32(32, input.bounds.width, true); view.setInt32(36, input.bounds.height, true);
      view.setInt32(40, input.width, true); view.setInt32(44, input.height, true);
      view.setUint32(48, pointers[0], true); view.setUint32(52, rgba.byteLength, true);
      view.setUint32(56, pointers[1], true); view.setUint32(60, name.byteLength, true);
      view.setUint32(64, 0, true); view.setUint32(68, pointers[2], true);
      view.setUint32(72, filename.byteLength, true);
      encoder.encode(filetype).forEach((byte, index) => view.setUint8(76 + index, byte));
      view.setUint32(80, pointers[3], true); view.setUint32(84, source.byteLength, true);
      return this.#mutation((event, error) => layerId == null
        ? this.#module[symbol](session, value, event, error)
        : this.#module[symbol](session, layerId, value, event, error));
    } finally {
      this.#module._free(value); pointers.forEach((pointer) => this.#module._free(pointer));
    }
  }

  setSmartFilter(session, snapshot, layerId, input) {
    if (!Number.isInteger(input.kind) || input.kind < 1 || input.kind > 5 ||
        !Number.isFinite(input.amount)) throw new TypeError("Supported Smart Filter settings are required");
    const value = this.#alloc(SMART_FILTER_INPUT_SIZE);
    try {
      const view = this.#view(value, SMART_FILTER_INPUT_SIZE);
      view.setUint32(0, SMART_FILTER_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true); view.setBigUint64(16, snapshot.revision, true);
      view.setBigUint64(24, layerId, true); view.setUint32(32, input.kind, true);
      view.setFloat64(40, input.amount, true); view.setUint8(48, input.enabled === false ? 0 : 1);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_set_smart_filter(session, value, event, error));
    } finally { this.#module._free(value); }
  }

  moveLayer(session, snapshot, layerId, targetLayerId, position) {
    return this.#mutation((event, error) =>
      this.#module._patchy_engine_session_move_layer(
        session, snapshot.stateId, snapshot.revision, layerId,
        targetLayerId ?? 0n, position, targetLayerId == null ? 0 : 1,
        event, error));
  }

  undo(session) {
    return this.#mutation((event, error) =>
      this.#module._patchy_engine_session_undo(session, event, error));
  }

  redo(session) {
    return this.#mutation((event, error) =>
      this.#module._patchy_engine_session_redo(session, event, error));
  }

  render(session, region) {
    return this.#bufferCall((buffer, event, error) =>
      this.#module._patchy_engine_session_render_region(
        session, region.x, region.y, region.width, region.height,
        buffer, event, error));
  }

  save(session) {
    return this.#bufferCall((buffer, event, error) =>
      this.#module._patchy_engine_session_save_psd(
        session, buffer, event, error));
  }

  close(session) {
    if (this.#sessions.delete(session)) {
      this.#module._patchy_engine_session_destroy(session);
    }
  }

  dispose() {
    for (const session of this.#sessions) {
      this.#module._patchy_engine_session_destroy(session);
    }
    this.#sessions.clear();
    if (this.#runtime) {
      this.#module._patchy_engine_runtime_destroy(this.#runtime);
      this.#runtime = 0;
    }
  }

  #layers(session, count, error) {
    const layer = this.#alloc(LAYER_SIZE);
    const mask = this.#alloc(LAYER_MASK_SIZE);
    const text = this.#alloc(TEXT_PROJECTION_SIZE);
    const adjustment = this.#alloc(ADJUSTMENT_PROJECTION_SIZE);
    const smartObject = this.#alloc(SMART_OBJECT_PROJECTION_SIZE);
    try {
      const layers = [];
      for (let index = 0; index < count; ++index) {
        this.#check(this.#module._patchy_engine_session_layer_at(
          session, index, layer, error), error);
        const view = this.#view(layer, LAYER_SIZE);
        const nameSize = view.getUint32(28, true);
        this.#view(mask, LAYER_MASK_SIZE).setUint32(0, LAYER_MASK_SIZE, true);
        this.#check(this.#module._patchy_engine_session_layer_mask(
          session, u64(view, 0), mask, error), error);
        const maskView = this.#view(mask, LAYER_MASK_SIZE);
        const kind = view.getUint32(16, true);
        let textValue = null;
        let adjustmentValue = null;
        let smartObjectValue = null;
        if (kind === 3) {
          this.#view(text, TEXT_PROJECTION_SIZE).setUint32(0, TEXT_PROJECTION_SIZE, true);
          this.#check(this.#module._patchy_engine_session_text(
            session, u64(view, 0), text, error), error);
          const textView = this.#view(text, TEXT_PROJECTION_SIZE);
          const valueSize = textView.getUint32(4, true);
          const fontSize = textView.getUint32(1032, true);
          textValue = {
            value: decodeHeap(this.#module.HEAPU8.subarray(text + 8, text + 8 + valueSize)),
            font: decodeHeap(this.#module.HEAPU8.subarray(text + 1036, text + 1036 + fontSize)),
            sizePixels: textView.getFloat64(1296, true),
            color: [textView.getUint8(1304), textView.getUint8(1305), textView.getUint8(1306)],
            bold: textView.getUint8(1307) !== 0, italic: textView.getUint8(1308) !== 0,
            boxText: textView.getUint8(1309) !== 0,
          };
        }
        if (kind === 2) {
          this.#view(adjustment, ADJUSTMENT_PROJECTION_SIZE).setUint32(0, ADJUSTMENT_PROJECTION_SIZE, true);
          this.#check(this.#module._patchy_engine_session_adjustment(
            session, u64(view, 0), adjustment, error), error);
          const projected = this.#view(adjustment, ADJUSTMENT_PROJECTION_SIZE);
          adjustmentValue = { kind: projected.getUint32(4, true), values: Array.from(
            { length: 8 }, (_, valueIndex) => projected.getInt32(8 + valueIndex * 4, true)) };
        }
        if (kind === 5) {
          this.#view(smartObject, SMART_OBJECT_PROJECTION_SIZE).setUint32(0, SMART_OBJECT_PROJECTION_SIZE, true);
          this.#check(this.#module._patchy_engine_session_smart_object(
            session, u64(view, 0), smartObject, error), error);
          const projected = this.#view(smartObject, SMART_OBJECT_PROJECTION_SIZE);
          const filenameSize = projected.getUint32(8, true);
          smartObjectValue = { sourceKind: projected.getUint32(4, true),
            filename: decodeHeap(this.#module.HEAPU8.subarray(smartObject + 12, smartObject + 12 + filenameSize)),
            filetype: decodeHeap(this.#module.HEAPU8.subarray(smartObject + 268, smartObject + 272)),
            sourceSize: u64(projected, 272), editable: projected.getUint8(280) !== 0 };
        }
        layers.push({
          id: u64(view, 0),
          parentId: u64(view, 8),
          kind,
          visible: view.getUint8(20) !== 0,
          opacity: view.getFloat32(24, true),
          name: decodeHeap(this.#module.HEAPU8.subarray(
            layer + 32, layer + 32 + nameSize)),
          clipped: view.getUint8(288) !== 0,
          fillOpacity: view.getFloat32(292, true),
          blendMode: view.getUint32(296, true),
          lockFlags: view.getUint32(300, true),
          bounds: {
            x: view.getInt32(304, true), y: view.getInt32(308, true),
            width: view.getInt32(312, true), height: view.getInt32(316, true),
          },
          mask: maskView.getUint8(23) ? {
            bounds: { x: maskView.getInt32(4, true), y: maskView.getInt32(8, true),
              width: maskView.getInt32(12, true), height: maskView.getInt32(16, true) },
            defaultColor: maskView.getUint8(20), disabled: maskView.getUint8(21) !== 0,
            linked: maskView.getUint8(22) !== 0,
          } : null,
          text: textValue,
          adjustment: adjustmentValue,
          smartObject: smartObjectValue,
        });
      }
      return layers;
    } finally {
      this.#module._free(smartObject);
      this.#module._free(adjustment);
      this.#module._free(text);
      this.#module._free(mask);
      this.#module._free(layer);
    }
  }

  #selection(session, error) {
    const selection = this.#alloc(SELECTION_SIZE);
    const rect = this.#alloc(RECT_SIZE);
    try {
      this.#view(selection, SELECTION_SIZE).setUint32(0, SELECTION_SIZE, true);
      this.#check(this.#module._patchy_engine_session_selection(
        session, selection, error), error);
      const count = this.#view(selection, SELECTION_SIZE).getUint32(4, true);
      const result = [];
      for (let index = 0; index < count; ++index) {
        this.#check(this.#module._patchy_engine_session_selection_rect_at(
          session, index, rect, error), error);
        const view = this.#view(rect, RECT_SIZE);
        result.push({ x: view.getInt32(0, true), y: view.getInt32(4, true),
          width: view.getInt32(8, true), height: view.getInt32(12, true) });
      }
      const projection = this.#view(selection, SELECTION_SIZE);
      let mask = null;
      if (projection.getUint8(28) !== 0) {
        const buffer = this.#alloc(BUFFER_SIZE);
        try {
          this.#check(this.#module._patchy_engine_session_selection_mask(
            session, buffer, error), error);
          const bufferView = this.#view(buffer, BUFFER_SIZE);
          const data = bufferView.getUint32(0, true); const size = bufferView.getUint32(4, true);
          mask = { bounds: { x: projection.getInt32(12, true), y: projection.getInt32(16, true),
            width: projection.getInt32(20, true), height: projection.getInt32(24, true) },
          gray: this.#module.HEAPU8.slice(data, data + size) };
        } finally { this.#module._patchy_engine_buffer_release(buffer); this.#module._free(buffer); }
      }
      return { rects: result, mask };
    } finally {
      this.#module._free(rect);
      this.#module._free(selection);
    }
  }

  #channels(session, error) {
    const countPointer = this.#alloc(4); const value = this.#alloc(CHANNEL_PROJECTION_SIZE);
    try {
      this.#check(this.#module._patchy_engine_session_channel_count(session, countPointer, error), error);
      const count = this.#view(countPointer, 4).getUint32(0, true); const result = [];
      for (let index = 0; index < count; ++index) {
        this.#check(this.#module._patchy_engine_session_channel_at(session, index, value, error), error);
        const view = this.#view(value, CHANNEL_PROJECTION_SIZE); const nameSize = view.getUint32(12, true);
        result.push({ id: u64(view, 0), kind: view.getUint32(8, true),
          name: decodeHeap(this.#module.HEAPU8.subarray(value + 16, value + 16 + nameSize)) });
      }
      return result;
    } finally { this.#module._free(value); this.#module._free(countPointer); }
  }

  #paths(session, error) {
    const countPointer = this.#alloc(4); const value = this.#alloc(DOCUMENT_PATH_PROJECTION_SIZE);
    const subpathValue = this.#alloc(PATH_SUBPATH_PROJECTION_SIZE);
    const anchorValue = this.#alloc(PATH_ANCHOR_SIZE);
    try {
      this.#check(this.#module._patchy_engine_session_path_count(session, countPointer, error), error);
      const count = this.#view(countPointer, 4).getUint32(0, true); const result = [];
      for (let index = 0; index < count; ++index) {
        this.#check(this.#module._patchy_engine_session_path_at(session, index, value, error), error);
        const view = this.#view(value, DOCUMENT_PATH_PROJECTION_SIZE); const nameSize = view.getUint32(12, true);
        const pathId = u64(view, 0); const subpaths = [];
        const subpathCount = view.getUint32(272, true);
        for (let subpathIndex = 0; subpathIndex < subpathCount; ++subpathIndex) {
          this.#check(this.#module._patchy_engine_session_path_subpath_at(
            session, pathId, subpathIndex, subpathValue, error), error);
          const subpathView = this.#view(subpathValue, PATH_SUBPATH_PROJECTION_SIZE);
          const anchors = [];
          for (let anchorIndex = 0; anchorIndex < subpathView.getUint32(0, true); ++anchorIndex) {
            this.#check(this.#module._patchy_engine_session_path_anchor_at(
              session, pathId, subpathIndex, anchorIndex, anchorValue, error), error);
            const anchorView = this.#view(anchorValue, PATH_ANCHOR_SIZE);
            anchors.push({ x: anchorView.getFloat64(0, true), y: anchorView.getFloat64(8, true),
              inX: anchorView.getFloat64(16, true), inY: anchorView.getFloat64(24, true),
              outX: anchorView.getFloat64(32, true), outY: anchorView.getFloat64(40, true),
              smooth: anchorView.getUint8(48) !== 0 });
          }
          subpaths.push({ anchors, shapeGroup: subpathView.getInt32(4, true),
            combine: subpathView.getUint32(8, true), closed: subpathView.getUint8(12) !== 0 });
        }
        result.push({ id: pathId, kind: view.getUint32(8, true),
          name: decodeHeap(this.#module.HEAPU8.subarray(value + 16, value + 16 + nameSize)),
          subpathCount, anchorCount: view.getUint32(276, true),
          clipping: view.getUint8(280) !== 0, subpaths,
          anchors: subpaths.flatMap((subpath) => subpath.anchors) });
      }
      return result;
    } finally { this.#module._free(anchorValue); this.#module._free(subpathValue);
      this.#module._free(value); this.#module._free(countPointer); }
  }

  #command(session, snapshot, type, writePayload) {
    const command = this.#alloc(COMMAND_SIZE);
    try {
      const view = this.#view(command, COMMAND_SIZE);
      view.setUint32(0, COMMAND_SIZE, true);
      view.setUint32(4, PROTOCOL_VERSION, true);
      view.setUint32(8, type, true);
      view.setBigUint64(16, snapshot.stateId, true);
      view.setBigUint64(24, snapshot.revision, true);
      writePayload(view, command);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_execute(
          session, command, event, error));
    } finally {
      this.#module._free(command);
    }
  }

  #pixelLayerMutation(symbol, session, snapshot, input) {
    const name = this.#text(input.name);
    const rgba = input.rgba;
    const expected = input.width * input.height * 4;
    if (!(rgba instanceof Uint8Array) || !Number.isSafeInteger(expected) ||
        input.width <= 0 || input.height <= 0 || rgba.byteLength !== expected) {
      throw new TypeError("Complete RGBA8 pixel layer input is required");
    }
    this.#rect(input.bounds);
    const pixels = this.#alloc(rgba.byteLength);
    const namePointer = this.#alloc(name.byteLength || 1);
    const value = this.#alloc(PIXEL_LAYER_INPUT_SIZE);
    try {
      this.#module.HEAPU8.set(rgba, pixels);
      this.#module.HEAPU8.set(name, namePointer);
      const view = this.#view(value, PIXEL_LAYER_INPUT_SIZE);
      view.setUint32(0, PIXEL_LAYER_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true);
      view.setBigUint64(16, snapshot.revision, true);
      view.setBigUint64(24, input.layerId ?? 0n, true);
      view.setInt32(32, input.bounds.x, true); view.setInt32(36, input.bounds.y, true);
      view.setInt32(40, input.bounds.width, true); view.setInt32(44, input.bounds.height, true);
      view.setInt32(48, input.width, true); view.setInt32(52, input.height, true);
      view.setUint32(56, pixels, true); view.setUint32(60, rgba.byteLength, true);
      view.setUint32(64, namePointer, true); view.setUint32(68, name.byteLength, true);
      view.setUint8(72, input.rasterize ? 1 : 0);
      return this.#mutation((event, error) =>
        this.#module[symbol](session, value, event, error));
    } finally {
      this.#module._free(value); this.#module._free(namePointer); this.#module._free(pixels);
    }
  }

  #textLayerMutation(symbol, session, snapshot, layerId, input) {
    const name = this.#text(input.name);
    const text = this.#text(input.text, "Text content", 1024);
    const font = this.#text(input.font, "Font family", 256);
    const rgba = input.rgba;
    const expected = input.width * input.height * 4;
    const color = input.color;
    if (!(rgba instanceof Uint8Array) || rgba.byteLength !== expected ||
        !Number.isSafeInteger(expected) || !Number.isFinite(input.sizePixels) ||
        input.sizePixels <= 0 || !Array.isArray(color) || color.length !== 3 ||
        !color.every((component) => Number.isInteger(component) && component >= 0 && component <= 255)) {
      throw new TypeError("Complete text layer input is required");
    }
    this.#rect(input.bounds);
    const pointers = [rgba, name, text, font].map((bytes) => this.#alloc(bytes.byteLength || 1));
    const value = this.#alloc(TEXT_INPUT_SIZE);
    try {
      [rgba, name, text, font].forEach((bytes, index) => this.#module.HEAPU8.set(bytes, pointers[index]));
      const view = this.#view(value, TEXT_INPUT_SIZE);
      view.setUint32(0, TEXT_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true); view.setBigUint64(16, snapshot.revision, true);
      view.setInt32(24, input.bounds.x, true); view.setInt32(28, input.bounds.y, true);
      view.setInt32(32, input.bounds.width, true); view.setInt32(36, input.bounds.height, true);
      view.setInt32(40, input.width, true); view.setInt32(44, input.height, true);
      view.setUint32(48, pointers[0], true); view.setUint32(52, rgba.byteLength, true);
      view.setUint32(56, pointers[1], true); view.setUint32(60, name.byteLength, true);
      view.setUint32(64, pointers[2], true); view.setUint32(68, text.byteLength, true);
      view.setUint32(72, pointers[3], true); view.setUint32(76, font.byteLength, true);
      view.setFloat64(80, input.sizePixels, true);
      color.forEach((component, index) => view.setUint8(88 + index, component));
      view.setUint8(91, input.bold ? 1 : 0); view.setUint8(92, input.italic ? 1 : 0);
      view.setUint8(93, input.boxText ? 1 : 0);
      return this.#mutation((event, error) => layerId == null
        ? this.#module[symbol](session, value, event, error)
        : this.#module[symbol](session, layerId, value, event, error));
    } finally {
      this.#module._free(value); pointers.forEach((pointer) => this.#module._free(pointer));
    }
  }

  #adjustmentMutation(session, snapshot, layerId, input) {
    const name = this.#text(input.name ?? "Adjustment");
    const values = input.values ?? [];
    if (!Number.isInteger(input.kind) || input.kind < 0 || input.kind > 7 ||
        !Array.isArray(values) || values.length > 8 || !values.every(Number.isInteger)) {
      throw new TypeError("Supported adjustment settings are required");
    }
    const curves = input.curvePoints ?? [];
    if (!Array.isArray(curves) || curves.length > 64 ||
        !curves.every((point) => Number.isInteger(point.input) && Number.isInteger(point.output))) {
      throw new TypeError("Adjustment curve points must contain integer input/output pairs");
    }
    const namePointer = this.#alloc(name.byteLength || 1);
    const curvePointer = this.#alloc(Math.max(1, curves.length * 8));
    const value = this.#alloc(ADJUSTMENT_INPUT_SIZE);
    try {
      this.#module.HEAPU8.set(name, namePointer);
      const curveView = this.#view(curvePointer, Math.max(1, curves.length * 8));
      curves.forEach((point, index) => { curveView.setInt32(index * 8, point.input, true);
        curveView.setInt32(index * 8 + 4, point.output, true); });
      const view = this.#view(value, ADJUSTMENT_INPUT_SIZE);
      view.setUint32(0, ADJUSTMENT_INPUT_SIZE, true);
      view.setBigUint64(8, snapshot.stateId, true); view.setBigUint64(16, snapshot.revision, true);
      view.setBigUint64(24, layerId ?? 0n, true); view.setUint32(32, namePointer, true);
      view.setUint32(36, name.byteLength, true); view.setUint32(40, input.kind, true);
      values.forEach((item, index) => view.setInt32(44 + index * 4, item, true));
      view.setUint32(76, curves.length ? curvePointer : 0, true); view.setUint32(80, curves.length, true);
      view.setUint8(84, layerId == null ? 0 : 1);
      return this.#mutation((event, error) =>
        this.#module._patchy_engine_session_set_adjustment(session, value, event, error));
    } finally {
      this.#module._free(value); this.#module._free(curvePointer); this.#module._free(namePointer);
    }
  }

  #path(input) {
    const subpaths = Array.isArray(input?.subpaths) ? input.subpaths :
      [{ anchors: input?.anchors, shapeGroup: 0, combine: 1, closed: true }];
    const anchors = subpaths.flatMap((subpath) => subpath.anchors || []);
    if (!subpaths.length || !subpaths.every((subpath) =>
        Array.isArray(subpath.anchors) && subpath.anchors.length >= 2) ||
        anchors.length < 3 || anchors.length > 4096) {
      throw new TypeError("Vector path requires between 3 and 4096 anchors");
    }
    const anchorPointer = this.#alloc(anchors.length * PATH_ANCHOR_SIZE);
    const subpathPointer = this.#alloc(subpaths.length * PATH_SUBPATH_SIZE);
    try {
      const anchorView = this.#view(anchorPointer, anchors.length * PATH_ANCHOR_SIZE);
      anchors.forEach((anchor, index) => {
        const values = [anchor.x, anchor.y, anchor.inX ?? anchor.x, anchor.inY ?? anchor.y,
          anchor.outX ?? anchor.x, anchor.outY ?? anchor.y];
        if (!values.every(Number.isFinite)) throw new TypeError("Vector path coordinates must be finite");
        values.forEach((number, valueIndex) => anchorView.setFloat64(
          index * PATH_ANCHOR_SIZE + valueIndex * 8, number, true));
        anchorView.setUint8(index * PATH_ANCHOR_SIZE + 48, anchor.smooth ? 1 : 0);
      });
      const subpathView = this.#view(subpathPointer, subpaths.length * PATH_SUBPATH_SIZE);
      let firstAnchor = 0;
      subpaths.forEach((subpath, index) => {
        const offset = index * PATH_SUBPATH_SIZE;
        subpathView.setUint32(offset, firstAnchor, true);
        subpathView.setUint32(offset + 4, subpath.anchors.length, true);
        subpathView.setInt32(offset + 8, subpath.shapeGroup ?? index, true);
        subpathView.setUint32(offset + 12, subpath.combine ?? 1, true);
        subpathView.setUint8(offset + 16, subpath.closed === false ? 0 : 1);
        firstAnchor += subpath.anchors.length;
      });
      return { anchorPointer, anchorCount: anchors.length, subpathPointer,
        subpathCount: subpaths.length };
    } catch (error) {
      this.#module._free(subpathPointer); this.#module._free(anchorPointer); throw error;
    }
  }

  #writePath(view, offset, path) {
    view.setUint32(offset, path.subpathPointer, true);
    view.setUint32(offset + 4, path.subpathCount, true);
    view.setUint32(offset + 8, path.anchorPointer, true); view.setUint32(offset + 12, path.anchorCount, true);
  }

  #releasePath(path) {
    this.#module._free(path.subpathPointer); this.#module._free(path.anchorPointer);
  }

  #index(value, length, subject) {
    if (!Number.isInteger(value) || value < 0 || value >= length) {
      throw new TypeError(`${subject} index is invalid`);
    }
  }

  #rgb(color, subject) {
    if (!Array.isArray(color) || color.length !== 3 ||
        !color.every((component) => Number.isInteger(component) && component >= 0 && component <= 255)) {
      throw new TypeError(`${subject} must contain three byte values`);
    }
    return color;
  }

  #text(value, subject = "Layer names", maximum = 256) {
    const bytes = encoder.encode(String(value));
    if (bytes.byteLength > maximum || bytes.includes(0)) {
      throw new TypeError(`${subject} must be valid UTF-8 without NUL and at most ${maximum} bytes`);
    }
    return bytes;
  }

  #dimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) {
      throw new TypeError("Document dimensions must be positive 32-bit integers");
    }
  }

  #rect(rect) {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
        rect.width <= 0 || rect.height <= 0) {
      throw new TypeError("Crop rectangle must contain integer coordinates and positive dimensions");
    }
  }

  #color(color) {
    if (!Array.isArray(color) || color.length !== 4 ||
        !color.every((component) => Number.isInteger(component) && component >= 0 && component <= 255)) {
      throw new TypeError("Fill color must contain four byte values");
    }
    return color;
  }

  #mutation(call) {
    return this.#withError((error) => {
      const event = this.#alloc(EVENT_SIZE);
      try {
        this.#view(event, EVENT_SIZE).setUint32(0, EVENT_SIZE, true);
        this.#check(call(event, error), error);
        const view = this.#view(event, EVENT_SIZE);
        return { revision: u64(view, 16), stateId: u64(view, 24),
          affectedLayerId: u64(view, 32), changed: view.getUint8(40) !== 0,
          dirty: view.getUint8(41) !== 0 };
      } finally {
        this.#module._free(event);
      }
    });
  }

  #bufferCall(call) {
    return this.#withError((error) => {
      const buffer = this.#alloc(BUFFER_SIZE);
      const event = this.#alloc(EVENT_SIZE);
      try {
        this.#check(call(buffer, event, error), error);
        const view = this.#view(buffer, BUFFER_SIZE);
        const data = view.getUint32(0, true);
        const size = view.getUint32(4, true);
        return this.#module.HEAPU8.slice(data, data + size);
      } finally {
        this.#module._patchy_engine_buffer_release(buffer);
        this.#module._free(event);
        this.#module._free(buffer);
      }
    });
  }

  #withError(action) {
    const error = this.#alloc(ERROR_SIZE);
    try { return action(error); } finally { this.#module._free(error); }
  }

  #check(ok, error) { if (!ok) this.#throwError(error); }

  #throwError(error) {
    const view = this.#view(error, ERROR_SIZE);
    const code = view.getUint32(0, true);
    const bytes = this.#module.HEAPU8.subarray(error + 4, error + ERROR_SIZE);
    const end = bytes.indexOf(0);
    throw new PatchyEngineError(code, decodeHeap(end < 0 ? bytes : bytes.subarray(0, end)));
  }

  #alloc(size) {
    const pointer = this.#module._malloc(size);
    if (!pointer) throw new PatchyEngineError(4, "Could not allocate WASM memory");
    this.#module.HEAPU8.fill(0, pointer, pointer + size);
    return pointer;
  }

  #view(pointer, size) {
    return new DataView(this.#module.HEAPU8.buffer, pointer, size);
  }
}

export { PROTOCOL_VERSION };
