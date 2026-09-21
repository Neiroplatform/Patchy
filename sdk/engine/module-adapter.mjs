const PROTOCOL_VERSION = 1;
const ERROR_SIZE = 260;
const EVENT_SIZE = 64;
const DOCUMENT_SIZE = 56;
const LAYER_SIZE = 320;
const BUFFER_SIZE = 8;

const decoder = new TextDecoder();

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

  constructor(module) {
    this.#module = module;
    const error = this.#alloc(ERROR_SIZE);
    try {
      this.#runtime = module._patchy_engine_runtime_create(PROTOCOL_VERSION, error);
      if (!this.#runtime) this.#throwError(error);
    } finally {
      module._free(error);
    }
  }

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
        };
        result.layers = this.#layers(session, result.layerCount, error);
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
    try {
      const layers = [];
      for (let index = 0; index < count; ++index) {
        this.#check(this.#module._patchy_engine_session_layer_at(
          session, index, layer, error), error);
        const view = this.#view(layer, LAYER_SIZE);
        const nameSize = view.getUint32(28, true);
        layers.push({
          id: u64(view, 0),
          parentId: u64(view, 8),
          kind: view.getUint32(16, true),
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
        });
      }
      return layers;
    } finally {
      this.#module._free(layer);
    }
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
