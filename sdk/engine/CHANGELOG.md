# Engine SDK changelog

## 0.1.0

- Added the package-root `createPatchyWorkerClient` entrypoint and stable
  TypeScript declarations.
- Added exact SDK, Worker RPC and engine protocol negotiation with mandatory
  capability validation.
- Added named capability constants for feature negotiation.
- Added progressive, cooperatively cancellable bounded rendering.
- Added progressive, cooperatively cancellable layered PSD and PSB encoding.
- Added exact-state `markSaved(documentId, expectedStateId)` acknowledgement so
  a host advances the canonical savepoint only after durable persistence.
- Added exact-state `captureLayerPixels` for a bounded, selection-aware browser
  clipboard without exposing the generic canonical layer-pixel API to UI code.
- Extended ordinary Brush/Eraser stroke input with bounded procedural softness.
- Extended Brush stroke input with optional bounded deterministic tip shape,
  shape/scatter/transfer dynamics, static generated texture and direct
  foreground/background colour dynamics while retaining legacy struct sizes;
  advanced construction is cancellable, cached by size/softness and rejected
  for Eraser/Clone/Heal modes.
- Documented pre-1.0 compatibility, ownership and distribution policy.
