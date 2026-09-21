import { createWorkerHost } from "./worker-host.mjs";
import { createRenderFrame } from "./frame-transport.mjs";
import { createPsdBlob, inspectPsdBlob, readBlobInput } from "./blob-ingress.mjs";
import { documentPreflight } from "./memory-policy.mjs";

const WORKER_WORKING_SET_LIMIT = 3 * 1024 * 1024 * 1024;

let hostPromise;

self.onmessage = async ({ data }) => {
  const { id, method, moduleUrl, moduleOptions, ...payload } = data;
  try {
    if (method === "initialize") {
      if (hostPromise) throw new Error("Patchy worker is already initialized");
      hostPromise = createWorkerHost(moduleUrl, moduleOptions);
      const host = await hostPromise;
      self.postMessage({ id, ok: true, value: { capabilities: host.capabilities } });
      return;
    }
    if (!hostPromise) throw new Error("Patchy worker is not initialized");
    const host = await hostPromise;
    if (method === "inspectBlob") {
      const value = await inspectPsdBlob(payload.blob);
      self.postMessage({ id, ok: true, value });
      return;
    }
    if (method === "openBlob") {
      const header = await inspectPsdBlob(payload.blob);
      const admission = documentPreflight({ ...header, limitBytes: WORKER_WORKING_SET_LIMIT });
      if (!admission.allowed) {
        throw new RangeError("PSD/PSB exceeds the Worker working-set safety limit");
      }
      const bytes = await readBlobInput(payload.blob);
      const value = await host.dispatch({ method: "open", bytes: bytes.buffer, name: payload.name });
      self.postMessage({ id, ok: true, value });
      return;
    }
    if (method === "placePsdSmartObject") {
      const header = await inspectPsdBlob(payload.blob);
      const admission = documentPreflight({ ...header, limitBytes: WORKER_WORKING_SET_LIMIT });
      if (!admission.allowed) {
        throw new RangeError("Smart Object PSD/PSB exceeds the Worker working-set safety limit");
      }
      const bytes = await readBlobInput(payload.blob);
      const filename = payload.name || "Smart Object.psd";
      const value = await host.dispatch({ method: "addPsdSmartObject",
        bytes: bytes.buffer, filename, name: filename.replace(/\.[^.]+$/, "") || "Smart Object",
        filetype: header.version === 2 ? "8BPB" : "8BPS", layerId: payload.layerId });
      self.postMessage({ id, ok: true, value });
      return;
    }
    if (method === "saveBlob" || method === "saveDocumentBlob") {
      const bytes = await host.dispatch({
        method: method === "saveBlob" ? "save" : "saveDocument",
        ...(method === "saveDocumentBlob" ? { documentId: payload.documentId } : {}),
      });
      self.postMessage({ id, ok: true, value: createPsdBlob(bytes) });
      return;
    }
    if (method === "renderFrame") {
      const bytes = await host.dispatch({ method: "render", ...payload });
      const frame = createRenderFrame(bytes, payload.region);
      try {
        self.postMessage({ id, ok: true, value: frame.value }, frame.transfer);
      } catch (error) {
        frame.value.bitmap?.close();
        throw error;
      }
      return;
    }
    const value = await host.dispatch({ method, ...payload,
      progress: (progress) => self.postMessage({ id, progress }) });
    const transfer = value instanceof Uint8Array ? [value.buffer] : [];
    self.postMessage({ id, ok: true, value }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: {
      name: error?.name || "Error", message: error?.message || String(error),
      code: error?.code,
    }});
  }
};
