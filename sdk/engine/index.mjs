export { PatchyWorkerClient } from "./client.mjs";
export {
  PATCHY_ENGINE_CAPABILITIES,
  PATCHY_ENGINE_PROTOCOL_VERSION,
  PATCHY_ENGINE_REQUIRED_CAPABILITIES,
  PATCHY_ENGINE_SDK_VERSION,
  PATCHY_WORKER_RPC_VERSION,
} from "./protocol.mjs";

import { PatchyWorkerClient } from "./client.mjs";

export function createPatchyWorkerClient(workerUrl, options = {}) {
  const WorkerConstructor = options.WorkerConstructor ?? globalThis.Worker;
  if (typeof WorkerConstructor !== "function") {
    throw new TypeError("A Worker constructor is required");
  }
  const workerOptions = { ...(options.workerOptions ?? {}), type: "module" };
  return new PatchyWorkerClient(new WorkerConstructor(workerUrl, workerOptions));
}
