import { createWorkerHost } from "./worker-host.mjs";
import { createRenderFrame } from "./frame-transport.mjs";
import { readBlobInput } from "./blob-ingress.mjs";

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
    if (method === "openBlob") {
      const bytes = await readBlobInput(payload.blob);
      const value = await host.dispatch({ method: "open", bytes: bytes.buffer, name: payload.name });
      self.postMessage({ id, ok: true, value });
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
