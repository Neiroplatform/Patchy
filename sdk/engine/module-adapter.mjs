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
const RECT_SIZE = 16;
const LAYER_MASK_INPUT_SIZE = 72;
const LAYER_MASK_SIZE = 24;
const TEXT_INPUT_SIZE = 96;
const TEXT_PROJECTION_SIZE = 1312;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

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
        };
        result.layers = this.#layers(session, result.layerCount, error);
        result.selection = this.#selection(session, error);
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
        if (kind === 3) {
          this.#view(text, TEXT_PROJECTION_SIZE).setUint32(0, TEXT_PROJECTION_SIZE, true);
          this.#check(this.#module._patchy_engine_session_text(
            session, u64(view, 0), text, error), error);
          const textView = this.#view(text, TEXT_PROJECTION_SIZE);
          const valueSize = textView.getUint32(4, true);
          const fontSize = textView.getUint32(1032, true);
          textValue = {
            value: decoder.decode(this.#module.HEAPU8.subarray(text + 8, text + 8 + valueSize)),
            font: decoder.decode(this.#module.HEAPU8.subarray(text + 1036, text + 1036 + fontSize)),
            sizePixels: textView.getFloat64(1296, true),
            color: [textView.getUint8(1304), textView.getUint8(1305), textView.getUint8(1306)],
            bold: textView.getUint8(1307) !== 0, italic: textView.getUint8(1308) !== 0,
            boxText: textView.getUint8(1309) !== 0,
          };
        }
        layers.push({
          id: u64(view, 0),
          parentId: u64(view, 8),
          kind,
          visible: view.getUint8(20) !== 0,
          opacity: view.getFloat32(24, true),
          name: decoder.decode(this.#module.HEAPU8.subarray(
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
        });
      }
      return layers;
    } finally {
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
      return result;
    } finally {
      this.#module._free(rect);
      this.#module._free(selection);
    }
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
    throw new PatchyEngineError(code, decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)));
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
