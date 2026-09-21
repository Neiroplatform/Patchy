import { createWorkerHost } from "./worker-host.mjs";

let hostPromise;

self.onmessage = async ({ data }) => {
  const { id, method, moduleUrl, moduleOptions, ...payload } = data;
  try {
    if (method === "initialize") {
      if (hostPromise) throw new Error("Patchy worker is already initialized");
      hostPromise = createWorkerHost(moduleUrl, moduleOptions);
      await hostPromise;
      self.postMessage({ id, ok: true, value: null });
      return;
    }
    if (!hostPromise) throw new Error("Patchy worker is not initialized");
    const host = await hostPromise;
    const value = await host.dispatch({ method, ...payload });
    const transfer = value instanceof Uint8Array ? [value.buffer] : [];
    self.postMessage({ id, ok: true, value }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, error: {
      name: error?.name || "Error", message: error?.message || String(error),
      code: error?.code,
    }});
  }
};
