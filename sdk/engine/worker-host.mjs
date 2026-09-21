import { EmscriptenPatchyEngine } from "./module-adapter.mjs";

export class PatchyWorkerHost {
  #engine;
  #session = 0;

  constructor(engine) { this.#engine = engine; }

  async dispatch(message) {
    switch (message.method) {
      case "open":
        this.#replaceSession(this.#engine.open(new Uint8Array(message.bytes)));
        return this.#engine.snapshot(this.#session);
      case "create":
        this.#replaceSession(this.#engine.create(message.width, message.height));
        return this.#engine.snapshot(this.#session);
      case "snapshot": return this.#snapshot();
      case "setLayerVisibility":
        this.#engine.setLayerVisibility(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.visible);
        return this.#snapshot();
      case "setLayerOpacity":
        this.#engine.setLayerOpacity(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.opacity);
        return this.#snapshot();
      case "setLayerBlendMode":
        this.#engine.setLayerBlendMode(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.blendMode);
        return this.#snapshot();
      case "renameLayer":
        this.#engine.renameLayer(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.name);
        return this.#snapshot();
      case "removeLayer":
        this.#engine.removeLayer(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId));
        return this.#snapshot();
      case "groupLayer":
        this.#engine.groupLayer(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.name);
        return this.#snapshot();
      case "ungroup":
        this.#engine.ungroup(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId));
        return this.#snapshot();
      case "addPixelLayer":
        this.#engine.addPixelLayer(this.#requireSession(), this.#snapshot(), {
          name: message.name, width: message.width, height: message.height,
          bounds: message.bounds, rgba: new Uint8Array(message.rgba),
        });
        return this.#snapshot();
      case "moveLayer":
        this.#engine.moveLayer(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.targetLayerId == null ? null : BigInt(message.targetLayerId),
          message.position);
        return this.#snapshot();
      case "undo": this.#engine.undo(this.#requireSession()); return this.#snapshot();
      case "redo": this.#engine.redo(this.#requireSession()); return this.#snapshot();
      case "render":
        return this.#engine.render(this.#requireSession(), message.region);
      case "save": return this.#engine.save(this.#requireSession());
      case "close": this.#replaceSession(0); return null;
      default: throw new TypeError(`Unknown Patchy worker method: ${message.method}`);
    }
  }

  dispose() {
    this.#replaceSession(0);
    this.#engine.dispose();
  }

  #snapshot() { return this.#engine.snapshot(this.#requireSession()); }

  #requireSession() {
    if (!this.#session) throw new Error("No Patchy document is open");
    return this.#session;
  }

  #replaceSession(next) {
    if (this.#session) this.#engine.close(this.#session);
    this.#session = next;
  }
}

export async function createWorkerHost(moduleUrl, moduleOptions = {}) {
  const imported = await import(moduleUrl);
  const module = await imported.default(moduleOptions);
  return new PatchyWorkerHost(new EmscriptenPatchyEngine(module));
}
