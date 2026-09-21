import { EmscriptenPatchyEngine } from "./module-adapter.mjs";

const MAX_OPEN_DOCUMENTS = 16;

export class PatchyWorkerHost {
  #engine;
  #session = 0;
  #activeDocumentId = 0;
  #nextDocumentId = 1;
  #sessions = new Map();

  constructor(engine) { this.#engine = engine; }

  get capabilities() { return this.#engine.capabilities; }

  async dispatch(message) {
    switch (message.method) {
      case "open":
        this.#addSession(this.#engine.open(new Uint8Array(message.bytes)),
          message.name || "Document.psd");
        return this.#snapshot();
      case "create":
        this.#addSession(this.#engine.create(message.width, message.height),
          message.name || "Untitled.psd");
        return this.#snapshot();
      case "snapshot": return this.#snapshot();
      case "listDocuments": return this.#documentList();
      case "activateDocument":
        this.#activateDocument(message.documentId);
        return this.#snapshot();
      case "closeDocument": return this.#closeDocument(message.documentId);
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
      case "setLayerFillOpacity":
        this.#engine.setLayerFillOpacity(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.opacity);
        return this.#snapshot();
      case "setLayerLocks":
        this.#engine.setLayerLocks(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.lockFlags);
        return this.#snapshot();
      case "setLayerClipping":
        this.#engine.setLayerClipping(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.clipped);
        return this.#snapshot();
      case "setLayerStylePreset":
        this.#engine.setLayerStylePreset(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.presetId);
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
      case "resizeImage":
        this.#engine.resizeImage(
          this.#requireSession(), this.#snapshot(), message.width, message.height);
        return this.#snapshot();
      case "resizeCanvas":
        this.#engine.resizeCanvas(
          this.#requireSession(), this.#snapshot(), message.width, message.height,
          message.anchor);
        return this.#snapshot();
      case "rotateCanvas":
        this.#engine.rotateCanvas(
          this.#requireSession(), this.#snapshot(), message.clockwiseDegrees);
        return this.#snapshot();
      case "cropDocument":
        this.#engine.cropDocument(
          this.#requireSession(), this.#snapshot(), message.crop);
        return this.#snapshot();
      case "setSelection":
        this.#engine.setSelection(
          this.#requireSession(), this.#snapshot(), message.rects);
        return this.#snapshot();
      case "setSelectionMask":
        this.#engine.setSelectionMask(this.#requireSession(), this.#snapshot(), {
          bounds: message.bounds, gray: new Uint8Array(message.gray),
        });
        return this.#snapshot();
      case "modifySelection":
        this.#engine.modifySelection(this.#requireSession(), this.#snapshot(), message.type, message.pixels);
        return this.#snapshot();
      case "selectChannel":
        this.#engine.selectChannel(this.#requireSession(), this.#snapshot(), BigInt(message.channelId));
        return this.#snapshot();
      case "selectPath":
        this.#engine.selectPath(this.#requireSession(), this.#snapshot(), BigInt(message.pathId),
          message.feather, message.combine, message.antialias);
        return this.#snapshot();
      case "renameChannel":
        this.#engine.renameChannel(this.#requireSession(), this.#snapshot(),
          BigInt(message.channelId), message.name); return this.#snapshot();
      case "invertChannel":
        this.#engine.invertChannel(this.#requireSession(), this.#snapshot(),
          BigInt(message.channelId)); return this.#snapshot();
      case "removeChannel":
        this.#engine.removeChannel(this.#requireSession(), this.#snapshot(),
          BigInt(message.channelId)); return this.#snapshot();
      case "moveChannel":
        this.#engine.moveChannel(this.#requireSession(), this.#snapshot(),
          BigInt(message.channelId), message.finalIndex); return this.#snapshot();
      case "renamePath":
        this.#engine.renamePath(this.#requireSession(), this.#snapshot(),
          BigInt(message.pathId), message.name); return this.#snapshot();
      case "removePath":
        this.#engine.removePath(this.#requireSession(), this.#snapshot(),
          BigInt(message.pathId)); return this.#snapshot();
      case "movePath":
        this.#engine.movePath(this.#requireSession(), this.#snapshot(),
          BigInt(message.pathId), message.finalIndex); return this.#snapshot();
      case "setClippingPath":
        this.#engine.setClippingPath(this.#requireSession(), this.#snapshot(),
          BigInt(message.pathId), message.clipping); return this.#snapshot();
      case "addAlphaChannel": {
        const before = this.#snapshot(); const gray = selectionGray(before);
        this.#engine.addAlphaChannel(this.#requireSession(), before, { name: message.name, gray });
        return this.#snapshot();
      }
      case "addDocumentPath":
        this.#engine.addDocumentPath(this.#requireSession(), this.#snapshot(), message.input);
        return this.#snapshot();
      case "updateDocumentPath":
        this.#engine.updateDocumentPath(this.#requireSession(), this.#snapshot(),
          BigInt(message.pathId), message.input); return this.#snapshot();
      case "rasterizeLayer":
        this.#engine.rasterizeLayer(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId)); return this.#snapshot();
      case "mergeVisibleCopy":
        this.#engine.mergeVisibleCopy(this.#requireSession(), this.#snapshot(), message.name);
        return this.#snapshot();
      case "createLayerMask": {
        const before = this.#snapshot();
        const mask = selectionMask(before);
        this.#engine.setLayerMask(
          this.#requireSession(), before, BigInt(message.layerId), mask);
        return this.#snapshot();
      }
      case "toggleLayerMask":
        this.#mutateExistingMask(message.layerId, (mask) => {
          mask.disabled = !mask.disabled;
        });
        return this.#snapshot();
      case "invertLayerMask":
        this.#mutateExistingMask(message.layerId, (mask) => {
          for (let index = 0; index < mask.gray.length; ++index) {
            mask.gray[index] = 255 - mask.gray[index];
          }
          mask.defaultColor = 255 - mask.defaultColor;
        });
        return this.#snapshot();
      case "removeLayerMask":
        this.#engine.setLayerMask(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId), null);
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
      case "layerPixels":
        return this.#engine.layerPixels(
          this.#requireSession(), BigInt(message.layerId));
      case "layerMaskPixels":
        return this.#engine.layerMaskPixels(
          this.#requireSession(), BigInt(message.layerId));
      case "replacePixelLayer": {
        const before = this.#snapshot();
        const layer = before.layers.find((candidate) => candidate.id === BigInt(message.layerId));
        if (!layer) throw new Error("Editable layer does not exist");
        this.#engine.replacePixelLayer(this.#requireSession(), before, layer.id, {
          name: message.name ?? layer.name, width: message.width, height: message.height,
          bounds: message.bounds, rgba: new Uint8Array(message.rgba),
        });
        return this.#snapshot();
      }
      case "replacePixelLayerAndMask": {
        const before = this.#snapshot();
        const layer = before.layers.find((candidate) => candidate.id === BigInt(message.layerId));
        if (!layer?.mask?.linked) throw new Error("Editable linked raster mask does not exist");
        this.#engine.replacePixelLayerAndMask(this.#requireSession(), before, layer.id,
          { ...message.input, rgba: new Uint8Array(message.input.rgba) },
          { ...message.mask, gray: new Uint8Array(message.mask.gray) });
        return this.#snapshot();
      }
      case "addTextLayer":
        this.#engine.addTextLayer(this.#requireSession(), this.#snapshot(), {
          ...message.input, rgba: new Uint8Array(message.input.rgba),
        });
        return this.#snapshot();
      case "updateTextLayer":
        this.#engine.updateTextLayer(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          { ...message.input, rgba: new Uint8Array(message.input.rgba) });
        return this.#snapshot();
      case "addAdjustment":
        this.#engine.addAdjustment(this.#requireSession(), this.#snapshot(), message.input);
        return this.#snapshot();
      case "updateAdjustment":
        this.#engine.updateAdjustment(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.input);
        return this.#snapshot();
      case "addVectorShape":
        this.#engine.addVectorShape(this.#requireSession(), this.#snapshot(), message.input);
        return this.#snapshot();
      case "updateVectorShape":
        this.#engine.updateVectorShape(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.input);
        return this.#snapshot();
      case "setVectorMask":
        this.#engine.setVectorMask(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.input);
        return this.#snapshot();
      case "addSmartObject":
        this.#engine.addSmartObject(this.#requireSession(), this.#snapshot(), {
          ...message.input, rgba: new Uint8Array(message.input.rgba),
          sourceBytes: new Uint8Array(message.input.sourceBytes),
        });
        return this.#snapshot();
      case "replaceSmartObject":
        this.#engine.replaceSmartObject(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), {
            ...message.input, rgba: new Uint8Array(message.input.rgba),
            sourceBytes: new Uint8Array(message.input.sourceBytes),
          });
        return this.#snapshot();
      case "setSmartFilter":
        this.#engine.setSmartFilter(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.input);
        return this.#snapshot();
      case "moveLayer":
        this.#engine.moveLayer(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.targetLayerId == null ? null : BigInt(message.targetLayerId),
          message.position);
        return this.#snapshot();
      case "undo": this.#engine.undo(this.#requireSession()); return this.#snapshot();
      case "redo": this.#engine.redo(this.#requireSession()); return this.#snapshot();
      case "invertLayer":
        this.#engine.applyFilter(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          "patchy.filters.invert", new Int32Array(message.cancellation), message.progress);
        return this.#snapshot();
      case "render":
        return this.#engine.render(this.#requireSession(), message.region);
      case "save": return this.#engine.save(this.#requireSession());
      case "saveDocument": {
        const record = this.#sessions.get(Number(message.documentId));
        if (!record) throw new Error("Patchy document does not exist");
        return this.#engine.save(record.session);
      }
      case "close": return this.#closeDocument(this.#activeDocumentId);
      default: throw new TypeError(`Unknown Patchy worker method: ${message.method}`);
    }
  }

  dispose() {
    for (const { session } of this.#sessions.values()) this.#engine.close(session);
    this.#sessions.clear(); this.#session = 0; this.#activeDocumentId = 0;
    this.#engine.dispose();
  }

  #snapshot() {
    const projection = this.#engine.snapshot(this.#requireSession());
    const active = this.#sessions.get(this.#activeDocumentId);
    active.dirty = projection.dirty; active.revision = projection.revision;
    return { ...projection, documentId: this.#activeDocumentId,
      documentName: active.name, documents: this.#documentList() };
  }

  #requireSession() {
    if (!this.#session) throw new Error("No Patchy document is open");
    return this.#session;
  }

  #addSession(session, name) {
    if (this.#sessions.size >= MAX_OPEN_DOCUMENTS) {
      this.#engine.close(session);
      throw new RangeError(`Patchy supports at most ${MAX_OPEN_DOCUMENTS} open browser documents`);
    }
    const documentId = this.#nextDocumentId++;
    this.#sessions.set(documentId, { session, name, dirty: false, revision: 1n });
    this.#activeDocumentId = documentId; this.#session = session;
  }

  #activateDocument(documentId) {
    const id = Number(documentId); const record = this.#sessions.get(id);
    if (!record) throw new Error("Patchy document does not exist");
    this.#activeDocumentId = id; this.#session = record.session;
  }

  #closeDocument(documentId) {
    const id = Number(documentId || this.#activeDocumentId);
    const record = this.#sessions.get(id);
    if (!record) throw new Error("Patchy document does not exist");
    this.#engine.close(record.session); this.#sessions.delete(id);
    if (id === this.#activeDocumentId) {
      const remaining = [...this.#sessions.keys()];
      this.#activeDocumentId = remaining.at(-1) || 0;
      this.#session = this.#sessions.get(this.#activeDocumentId)?.session || 0;
    }
    return this.#session ? this.#snapshot() : null;
  }

  #documentList() {
    return [...this.#sessions.entries()].map(([id, record]) => ({ id,
      name: record.name, dirty: record.dirty, revision: record.revision,
      active: id === this.#activeDocumentId }));
  }

  #mutateExistingMask(layerId, change) {
    const before = this.#snapshot();
    const id = BigInt(layerId);
    const layer = before.layers.find((candidate) => candidate.id === id);
    if (!layer?.mask) throw new Error("Selected layer has no raster mask");
    const mask = { ...layer.mask, bounds: { ...layer.mask.bounds },
      gray: this.#engine.layerMaskPixels(this.#requireSession(), id) };
    change(mask);
    this.#engine.setLayerMask(this.#requireSession(), before, id, mask);
  }
}

function selectionMask(snapshot) {
  if (snapshot.selectionMask) {
    return { bounds: { ...snapshot.selectionMask.bounds },
      gray: snapshot.selectionMask.gray.slice(), defaultColor: 0,
      disabled: false, linked: true };
  }
  if (!snapshot.selection.length) {
    const pixelCount = checkedMaskPixelCount(snapshot.width, snapshot.height);
    return { bounds: { x: 0, y: 0, width: snapshot.width, height: snapshot.height },
      gray: new Uint8Array(pixelCount).fill(255),
      defaultColor: 255, disabled: false, linked: true };
  }
  const left = Math.min(...snapshot.selection.map((rect) => rect.x));
  const top = Math.min(...snapshot.selection.map((rect) => rect.y));
  const right = Math.max(...snapshot.selection.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...snapshot.selection.map((rect) => rect.y + rect.height));
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  const gray = new Uint8Array(checkedMaskPixelCount(bounds.width, bounds.height));
  for (const rect of snapshot.selection) {
    const x0 = Math.max(rect.x, left);
    const y0 = Math.max(rect.y, top);
    const x1 = Math.min(rect.x + rect.width, right);
    const y1 = Math.min(rect.y + rect.height, bottom);
    for (let y = y0; y < y1; ++y) {
      gray.fill(255, (y - top) * bounds.width + x0 - left,
        (y - top) * bounds.width + x1 - left);
    }
  }
  return { bounds, gray, defaultColor: 0, disabled: false, linked: true };
}

function checkedMaskPixelCount(width, height) {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0) {
    throw new RangeError("Raster mask dimensions exceed the browser allocation limit");
  }
  return pixelCount;
}

function selectionGray(snapshot) {
  if (snapshot.selectionMask) {
    const gray = new Uint8Array(checkedMaskPixelCount(snapshot.width, snapshot.height));
    const { bounds, gray: source } = snapshot.selectionMask;
    for (let y = 0; y < bounds.height; ++y) {
      gray.set(source.subarray(y * bounds.width, (y + 1) * bounds.width),
        (bounds.y + y) * snapshot.width + bounds.x);
    }
    return gray;
  }
  const gray = new Uint8Array(checkedMaskPixelCount(snapshot.width, snapshot.height));
  for (const rect of snapshot.selection) {
    const x0 = Math.max(0, rect.x); const y0 = Math.max(0, rect.y);
    const x1 = Math.min(snapshot.width, rect.x + rect.width);
    const y1 = Math.min(snapshot.height, rect.y + rect.height);
    for (let y = y0; y < y1; ++y) gray.fill(255, y * snapshot.width + x0, y * snapshot.width + x1);
  }
  return gray;
}

export async function createWorkerHost(moduleUrl, moduleOptions = {}) {
  const imported = await import(moduleUrl);
  const module = await imported.default(moduleOptions);
  return new PatchyWorkerHost(new EmscriptenPatchyEngine(module));
}
