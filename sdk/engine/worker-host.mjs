import { EmscriptenPatchyEngine } from "./module-adapter.mjs";

const MAX_OPEN_DOCUMENTS = 16;
const DEFAULT_DOCUMENT_HISTORY_BUDGET = 256 * 1024 * 1024;
const DEFAULT_GLOBAL_HISTORY_BUDGET = 768 * 1024 * 1024;

export class PatchyWorkerHost {
  #engine;
  #session = 0;
  #activeDocumentId = 0;
  #nextDocumentId = 1;
  #sessions = new Map();
  #documentHistoryBudget = DEFAULT_DOCUMENT_HISTORY_BUDGET;
  #globalHistoryBudget = DEFAULT_GLOBAL_HISTORY_BUDGET;

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
      case "copyLayerToDocument": {
        const sourceId = Number(message.sourceDocumentId);
        const targetId = Number(message.targetDocumentId);
        const source = this.#sessions.get(sourceId);
        const target = this.#sessions.get(targetId);
        if (!source || !target) throw new Error("Patchy source or target document does not exist");
        const sourceSnapshot = this.#engine.snapshot(source.session);
        const targetSnapshot = this.#engine.snapshot(target.session);
        if (sourceSnapshot.stateId !== BigInt(message.expectedSourceStateId) ||
            sourceSnapshot.revision !== BigInt(message.expectedSourceRevision) ||
            targetSnapshot.stateId !== BigInt(message.expectedTargetStateId) ||
            targetSnapshot.revision !== BigInt(message.expectedTargetRevision)) {
          const error = new Error("Layer transfer was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6;
          throw error;
        }
        this.#engine.copyLayerToSession(target.session, targetSnapshot,
          source.session, sourceSnapshot, BigInt(message.layerId));
        this.#activateDocument(targetId);
        return this.#snapshot();
      }
      case "copyLayersToDocument": {
        const sourceId = Number(message.sourceDocumentId);
        const targetId = Number(message.targetDocumentId);
        const source = this.#sessions.get(sourceId);
        const target = this.#sessions.get(targetId);
        if (!source || !target) throw new Error("Patchy source or target document does not exist");
        const sourceSnapshot = this.#engine.snapshot(source.session);
        const targetSnapshot = this.#engine.snapshot(target.session);
        if (sourceSnapshot.stateId !== BigInt(message.expectedSourceStateId) ||
            sourceSnapshot.revision !== BigInt(message.expectedSourceRevision) ||
            targetSnapshot.stateId !== BigInt(message.expectedTargetStateId) ||
            targetSnapshot.revision !== BigInt(message.expectedTargetRevision)) {
          const error = new Error("Layer transfer was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6;
          throw error;
        }
        if (!Array.isArray(message.layerIds)) throw new TypeError("Layer transfer requires a layer id array");
        this.#engine.copyLayersToSession(target.session, targetSnapshot,
          source.session, sourceSnapshot, message.layerIds.map(BigInt));
        this.#activateDocument(targetId);
        return this.#snapshot();
      }
      case "previewLayerTransform": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Layer transform was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6;
          throw error;
        }
        return this.#engine.previewLayerTransform(this.#requireSession(), before,
          BigInt(message.layerId), message.quad, message.interpolation,
          new Int32Array(message.cancellation));
      }
      case "transformLayer": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Layer transform was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6;
          throw error;
        }
        this.#engine.transformLayer(this.#requireSession(), before,
          BigInt(message.layerId), message.quad, message.interpolation);
        return this.#snapshot();
      }
      case "previewRasterStroke": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Raster stroke was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        return this.#engine.previewRasterStroke(this.#requireSession(), before,
          { ...message, layerId: BigInt(message.layerId) },
          new Int32Array(message.cancellation));
      }
      case "applyRasterStroke": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Raster stroke was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        this.#engine.applyRasterStroke(this.#requireSession(), before,
          { ...message, layerId: BigInt(message.layerId) });
        return this.#snapshot();
      }
      case "previewLayerMaskStroke": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Layer-mask stroke was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        return this.#engine.previewLayerMaskStroke(this.#requireSession(), before,
          { ...message, layerId: BigInt(message.layerId) },
          new Int32Array(message.cancellation));
      }
      case "applyLayerMaskStroke": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Layer-mask stroke was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        this.#engine.applyLayerMaskStroke(this.#requireSession(), before,
          { ...message, layerId: BigInt(message.layerId) });
        return this.#snapshot();
      }
      case "previewRasterFill": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Raster fill was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        return this.#engine.previewRasterFill(this.#requireSession(), before,
          { ...message, layerId: BigInt(message.layerId) },
          new Int32Array(message.cancellation));
      }
      case "applyRasterFill": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Raster fill was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        this.#engine.applyRasterFill(this.#requireSession(), before,
          { ...message, layerId: BigInt(message.layerId) });
        return this.#snapshot();
      }
      case "previewLayerWarp": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Layer warp was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        return this.#engine.previewLayerWarp(this.#requireSession(), before,
          { ...message, layerId: BigInt(message.layerId) },
          new Int32Array(message.cancellation));
      }
      case "warpLayer": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Layer warp was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        this.#engine.warpLayer(this.#requireSession(), before,
          { ...message, layerId: BigInt(message.layerId) });
        return this.#snapshot();
      }
      case "closeDocument": return this.#closeDocument(message.documentId);
      case "addPsdSmartObject": {
        const parent = this.#sessions.get(this.#activeDocumentId);
        const replacementId = message.layerId == null ? null : BigInt(message.layerId);
        if (replacementId != null &&
            this.#linkedSmartObjectChild(this.#activeDocumentId, replacementId)) {
          throw new Error("Close the open Smart Object contents before replacing its source");
        }
        const sourceBytes = new Uint8Array(message.bytes);
        const sourceSession = this.#engine.open(sourceBytes);
        let source;
        try {
          const projected = this.#engine.snapshot(sourceSession);
          source = { width: projected.width, height: projected.height,
            rgba: this.#engine.render(sourceSession, {
              x: 0, y: 0, width: projected.width, height: projected.height,
            }) };
        } finally {
          this.#engine.close(sourceSession);
        }
        const before = this.#snapshot();
        const replacement = replacementId == null ? null : before.layers.find(
          (candidate) => candidate.id === replacementId);
        if (replacementId != null && (!parent.contentsEditableLayerIds.has(replacementId) ||
            !replacement?.smartObject?.contentsEditable)) {
          throw new Error("PSD/PSB replacement requires a Smart Object placed by this browser session");
        }
        if (replacement && (replacement.bounds.width !== source.width ||
            replacement.bounds.height !== source.height)) {
          throw new Error("PSD/PSB replacement dimensions must match the current Smart Object");
        }
        const input = {
          name: message.name, filename: message.filename,
          filetype: message.filetype, width: source.width, height: source.height,
          bounds: replacement ? { ...replacement.bounds } :
            { x: 0, y: 0, width: source.width, height: source.height },
          rgba: source.rgba, sourceBytes,
        };
        if (replacementId == null) this.#engine.addSmartObject(parent.session, before, input);
        else this.#engine.replaceSmartObject(parent.session, before, replacementId, input);
        const authored = replacementId ?? this.#engine.snapshot(parent.session).activeLayerId;
        parent.contentsEditableLayerIds.add(authored);
        return this.#snapshot();
      }
      case "openSmartObjectContents": {
        const parentDocumentId = this.#activeDocumentId;
        const parent = this.#sessions.get(parentDocumentId);
        const before = this.#snapshot();
        const layerId = BigInt(message.layerId);
        const layer = before.layers.find((candidate) => candidate.id === layerId);
        if (!layer?.smartObject?.contentsEditable) {
          throw new Error("Smart Object contents require one unwarped embedded PSD/PSB instance");
        }
        const existing = this.#linkedSmartObjectChild(parentDocumentId, layerId);
        if (existing) {
          this.#activateDocument(existing[0]);
          return this.#snapshot();
        }
        const bytes = this.#engine.smartObjectBytes(parent.session, layerId);
        const child = this.#engine.open(bytes);
        const childId = this.#addSession(
          child, `${layer.smartObject.filename || layer.name} — Smart Object`);
        this.#sessions.get(childId).smartObjectLink = {
          parentDocumentId, layerId, expectedStateId: before.stateId,
          expectedRevision: before.revision, filename: layer.smartObject.filename,
          filetype: layer.smartObject.filetype, name: layer.name,
          bounds: { ...layer.bounds }, width: before.layers.find(
            (candidate) => candidate.id === layerId).bounds.width,
          height: before.layers.find((candidate) => candidate.id === layerId).bounds.height,
        };
        return this.#snapshot();
      }
      case "saveSmartObjectContents": {
        const childId = Number(message.documentId || this.#activeDocumentId);
        const child = this.#sessions.get(childId);
        const link = child?.smartObjectLink;
        if (!child || !link) throw new Error("Document is not linked Smart Object contents");
        const parent = this.#sessions.get(link.parentDocumentId);
        if (!parent) throw new Error("The parent Smart Object document is closed");
        const parentBefore = this.#engine.snapshot(parent.session);
        if (parentBefore.stateId !== link.expectedStateId ||
            parentBefore.revision !== link.expectedRevision) {
          throw new Error("The parent document changed after Smart Object contents were opened");
        }
        const parentLayer = parentBefore.layers.find((candidate) => candidate.id === link.layerId);
        if (!parent.contentsEditableLayerIds.has(link.layerId) ||
            !parentLayer?.smartObject?.editable ||
            parentLayer.smartObject.filename !== link.filename ||
            parentLayer.smartObject.filetype !== link.filetype) {
          throw new Error("The parent Smart Object is no longer safely editable");
        }
        const childBefore = this.#engine.snapshot(child.session);
        if (childBefore.width !== link.width || childBefore.height !== link.height) {
          throw new Error("Resized Smart Object contents require the full transform resampler");
        }
        const rgba = this.#engine.render(child.session, {
          x: 0, y: 0, width: childBefore.width, height: childBefore.height,
        });
        const sourceBytes = this.#engine.save(child.session, {
          largeDocument: link.filetype === "8BPB",
        });
        const childAfter = this.#engine.snapshot(child.session);
        child.dirty = childAfter.dirty; child.revision = childAfter.revision;
        this.#engine.replaceSmartObject(parent.session, {
          ...parentBefore, stateId: link.expectedStateId,
          revision: link.expectedRevision,
        }, link.layerId, {
          name: link.name, filename: link.filename, filetype: link.filetype,
          width: childBefore.width, height: childBefore.height,
          bounds: { ...link.bounds }, rgba, sourceBytes,
        });
        const parentAfter = this.#engine.snapshot(parent.session);
        parent.dirty = parentAfter.dirty; parent.revision = parentAfter.revision;
        link.expectedStateId = parentAfter.stateId;
        link.expectedRevision = parentAfter.revision;
        this.#activateDocument(link.parentDocumentId);
        return this.#snapshot();
      }
      case "setMemoryBudget": {
        const documentBytes = Number(message.documentBytes);
        const globalBytes = Number(message.globalBytes);
        if (!Number.isSafeInteger(documentBytes) || !Number.isSafeInteger(globalBytes) ||
            documentBytes < 16 * 1024 * 1024 || globalBytes < documentBytes ||
            globalBytes > 3 * 1024 * 1024 * 1024) {
          throw new RangeError("Memory budgets must be safe bytes with global >= document and <= 3 GB");
        }
        this.#documentHistoryBudget = documentBytes;
        this.#globalHistoryBudget = globalBytes;
        return this.#sessions.size ? this.#snapshot() : { memoryBudget: {
          documentBytes: this.#documentHistoryBudget, globalBytes: this.#globalHistoryBudget } };
      }
      case "setLayerVisibility":
        this.#engine.setLayerVisibility(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.visible);
        return this.#snapshot();
      case "editLayers":
        this.#engine.editLayers(this.#requireSession(), this.#snapshot(),
          message.layerIds.map(BigInt), message.property, {
            opacity: message.opacity, value: message.value,
          });
        return this.#snapshot();
      case "removeLayers":
        this.#engine.removeLayers(this.#requireSession(), this.#snapshot(),
          message.layerIds.map(BigInt));
        return this.#snapshot();
      case "groupLayers":
        this.#engine.groupLayers(this.#requireSession(), this.#snapshot(),
          message.layerIds.map(BigInt), message.name);
        return this.#snapshot();
      case "ungroupLayers":
        this.#engine.ungroupLayers(this.#requireSession(), this.#snapshot(),
          message.layerIds.map(BigInt));
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
      case "setEssentialLayerStyle":
        this.#engine.setEssentialLayerStyle(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), message.input);
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
      case "quickSelect": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Quick Select was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        this.#engine.quickSelect(this.#requireSession(), before, message);
        return this.#snapshot();
      }
      case "magneticLasso": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("Magnetic Lasso was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        this.#engine.magneticLasso(this.#requireSession(), before, message);
        return this.#snapshot();
      }
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
      case "setLayerMaskLinked":
        this.#engine.setLayerMaskLinked(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          Boolean(message.linked));
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
      case "layerThumbnail": {
        const before = this.#snapshot();
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          throw new Error("Layer thumbnail request is stale");
        }
        return this.#engine.layerThumbnail(
          this.#requireSession(), BigInt(message.layerId), message.maximumEdge);
      }
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
        if (["8BPS", "8BPB"].includes(message.input.filetype)) {
          const activeLayerId = this.#engine.snapshot(this.#requireSession()).activeLayerId;
          this.#sessions.get(this.#activeDocumentId).contentsEditableLayerIds.add(activeLayerId);
        }
        return this.#snapshot();
      case "replaceSmartObject":
        if (this.#linkedSmartObjectChild(this.#activeDocumentId, BigInt(message.layerId))) {
          throw new Error("Close the open Smart Object contents before replacing its source");
        }
        this.#engine.replaceSmartObject(this.#requireSession(), this.#snapshot(),
          BigInt(message.layerId), {
            ...message.input, rgba: new Uint8Array(message.input.rgba),
            sourceBytes: new Uint8Array(message.input.sourceBytes),
          });
        if (["8BPS", "8BPB"].includes(message.input.filetype)) {
          this.#sessions.get(this.#activeDocumentId).contentsEditableLayerIds.add(
            BigInt(message.layerId));
        } else {
          this.#sessions.get(this.#activeDocumentId).contentsEditableLayerIds.delete(
            BigInt(message.layerId));
        }
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
      case "moveLayers":
        this.#engine.moveLayers(this.#requireSession(), this.#snapshot(),
          message.layerIds.map(BigInt),
          message.targetLayerId == null ? null : BigInt(message.targetLayerId),
          message.position);
        return this.#snapshot();
      case "undo": this.#engine.undo(this.#requireSession()); return this.#snapshot();
      case "redo": this.#engine.redo(this.#requireSession()); return this.#snapshot();
      case "historyTravel": {
        const before = this.#snapshot();
        const steps = Number(message.steps);
        if (before.stateId !== BigInt(message.expectedStateId) ||
            before.revision !== BigInt(message.expectedRevision)) {
          const error = new Error("History navigation was prepared from a stale document state");
          error.name = "PatchyEngineError"; error.code = 6; throw error;
        }
        if (!Number.isSafeInteger(steps) || steps === 0 || Math.abs(steps) > 40) {
          throw new TypeError("History navigation requires 1..40 whole steps");
        }
        const available = steps < 0 ? before.memory?.undoStates : before.memory?.redoStates;
        if (!Number.isSafeInteger(available) || available < Math.abs(steps)) {
          throw new RangeError("History navigation exceeds the available states");
        }
        for (let index = 0; index < Math.abs(steps); ++index) {
          if (steps < 0) this.#engine.undo(this.#requireSession());
          else this.#engine.redo(this.#requireSession());
        }
        return this.#snapshot();
      }
      case "applyFilter":
        this.#engine.applyFilter(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          message.filterId, message.parameters || [], new Int32Array(message.cancellation),
          message.progress);
        return this.#snapshot();
      case "invertLayer":
        this.#engine.applyFilter(
          this.#requireSession(), this.#snapshot(), BigInt(message.layerId),
          "patchy.filters.invert", [], new Int32Array(message.cancellation), message.progress);
        return this.#snapshot();
      case "render":
        return this.#engine.render(this.#requireSession(), message.region);
      case "save": return this.#engine.save(
        this.#requireSession(), layeredSaveOptions(message.format));
      case "saveDocument": {
        const record = this.#sessions.get(Number(message.documentId));
        if (!record) throw new Error("Patchy document does not exist");
        return this.#engine.save(record.session, layeredSaveOptions(message.format));
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
    this.#enforceMemoryBudget();
    const projection = this.#engine.snapshot(this.#requireSession());
    const active = this.#sessions.get(this.#activeDocumentId);
    active.dirty = projection.dirty; active.revision = projection.revision;
    const memory = this.#engine.memoryUsage?.(this.#requireSession()) || null;
    const dirtyRegion = this.#engine.pendingRenderRegion?.(this.#requireSession()) || null;
    const layers = projection.layers.map((layer) => ({ ...layer,
      smartObject: layer.smartObject == null ? null : { ...layer.smartObject,
        contentsEditable: active.contentsEditableLayerIds.has(layer.id) &&
          layer.smartObject.editable && ["8BPS", "8BPB"].includes(layer.smartObject.filetype) } }));
    return { ...projection, layers, documentId: this.#activeDocumentId,
      documentName: active.name, documents: this.#documentList(), memory,
      dirtyRegion, memoryBudget: { documentBytes: this.#documentHistoryBudget,
        globalBytes: this.#globalHistoryBudget } };
  }

  #enforceMemoryBudget() {
    if (typeof this.#engine.memoryUsage !== "function" ||
        typeof this.#engine.evictOldestUndo !== "function") return;
    for (const record of this.#sessions.values()) {
      let usage = this.#engine.memoryUsage(record.session);
      while (usage.historyRetainedBytes > this.#documentHistoryBudget && usage.undoStates > 1) {
        if (!this.#engine.evictOldestUndo(record.session)) break;
        usage = this.#engine.memoryUsage(record.session);
      }
    }
    for (;;) {
      const candidates = [...this.#sessions.values()].map((record) => ({ record,
        usage: this.#engine.memoryUsage(record.session) }));
      const total = candidates.reduce((sum, item) => sum + item.usage.historyRetainedBytes, 0);
      if (total <= this.#globalHistoryBudget) break;
      candidates.sort((left, right) => right.usage.historyRetainedBytes - left.usage.historyRetainedBytes);
      const target = candidates.find((item) => item.usage.undoStates > 1);
      if (!target || !this.#engine.evictOldestUndo(target.record.session)) break;
    }
  }

  #requireSession() {
    if (!this.#session) throw new Error("No Patchy document is open");
    return this.#session;
  }

  #linkedSmartObjectChild(parentDocumentId, layerId) {
    return [...this.#sessions.entries()].find(([, record]) =>
      record.smartObjectLink?.parentDocumentId === parentDocumentId &&
      record.smartObjectLink?.layerId === layerId);
  }

  #addSession(session, name) {
    if (this.#sessions.size >= MAX_OPEN_DOCUMENTS) {
      this.#engine.close(session);
      throw new RangeError(`Patchy supports at most ${MAX_OPEN_DOCUMENTS} open browser documents`);
    }
    const documentId = this.#nextDocumentId++;
    this.#sessions.set(documentId, { session, name, dirty: false, revision: 1n,
      contentsEditableLayerIds: new Set() });
    this.#activeDocumentId = documentId; this.#session = session;
    return documentId;
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
    return [...this.#sessions.entries()].map(([id, record]) => {
      const memory = this.#engine.memoryUsage?.(record.session);
      return { id, name: record.name, dirty: record.dirty, revision: record.revision,
        active: id === this.#activeDocumentId,
        retainedBytes: memory?.totalRetainedBytes || 0,
        historyBytes: memory?.historyRetainedBytes || 0,
        ...(record.smartObjectLink
          ? { smartObjectParentId: record.smartObjectLink.parentDocumentId }
          : {}) };
    });
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

function layeredSaveOptions(format = "psd") {
  if (format !== "psd" && format !== "psb") {
    throw new TypeError("Layered save format must be psd or psb");
  }
  return { largeDocument: format === "psb" };
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
