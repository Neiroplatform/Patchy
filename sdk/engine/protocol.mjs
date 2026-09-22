export const PATCHY_ENGINE_SDK_VERSION = "0.1.0";
export const PATCHY_WORKER_RPC_VERSION = 1;
export const PATCHY_ENGINE_PROTOCOL_VERSION = 1;

const capability = (bit) => 1n << BigInt(bit);

export const PATCHY_ENGINE_CAPABILITIES = Object.freeze({
  layerProjection: capability(0),
  layerVisibility: capability(1),
  history: capability(2),
  boundedRender: capability(3),
  psdSave: capability(4),
  documentProjection: capability(5),
  progressCancellation: capability(18),
  psbSaveAs: capability(33),
});

export const PATCHY_ENGINE_REQUIRED_CAPABILITIES =
  PATCHY_ENGINE_CAPABILITIES.layerProjection |
  PATCHY_ENGINE_CAPABILITIES.layerVisibility |
  PATCHY_ENGINE_CAPABILITIES.history |
  PATCHY_ENGINE_CAPABILITIES.boundedRender |
  PATCHY_ENGINE_CAPABILITIES.psdSave |
  PATCHY_ENGINE_CAPABILITIES.documentProjection |
  PATCHY_ENGINE_CAPABILITIES.progressCancellation;

