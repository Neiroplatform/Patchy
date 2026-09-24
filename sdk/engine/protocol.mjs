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
  layerAppearance: capability(6),
  layerLifecycle: capability(7),
  documentGeometry: capability(8),
  optimisticCommands: capability(9),
  saveState: capability(10),
  selectionProjection: capability(11),
  savedChannels: capability(12),
  pixelAuthoring: capability(13),
  pathProjection: capability(14),
  vectorAuthoring: capability(15),
  layerMaskAuthoring: capability(16),
  filterAuthoring: capability(17),
  progressCancellation: capability(18),
  eventDrain: capability(19),
  textAuthoring: capability(20),
  smartObjectAuthoring: capability(21),
  adjustmentAuthoring: capability(22),
  vectorMaskAuthoring: capability(23),
  smartFilterAuthoring: capability(24),
  selectionAuthoring: capability(25),
  memoryControl: capability(26),
  crossDocumentLayers: capability(27),
  layerTransform: capability(28),
  rasterStroke: capability(29),
  rasterFill: capability(30),
  layerWarp: capability(31),
  essentialLayerStyle: capability(32),
  psbSaveAs: capability(33),
  layerMaskStroke: capability(34),
  richTextAuthoring: capability(35),
  multiLayerAuthoring: capability(36),
  multiLayerTransfer: capability(37),
  multiLayerTransform: capability(38),
  layerArrange: capability(39),
  selectionRefinement: capability(40),
  liquifyAuthoring: capability(41),
  retouchRepair: capability(42),
  localAdjustmentBrush: capability(43),
  advancedPaintStroke: capability(44),
});

export const PATCHY_ENGINE_REQUIRED_CAPABILITIES =
  PATCHY_ENGINE_CAPABILITIES.layerProjection |
  PATCHY_ENGINE_CAPABILITIES.layerVisibility |
  PATCHY_ENGINE_CAPABILITIES.history |
  PATCHY_ENGINE_CAPABILITIES.boundedRender |
  PATCHY_ENGINE_CAPABILITIES.psdSave |
  PATCHY_ENGINE_CAPABILITIES.documentProjection |
  PATCHY_ENGINE_CAPABILITIES.progressCancellation;
