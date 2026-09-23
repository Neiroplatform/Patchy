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
- Documented pre-1.0 compatibility, ownership and distribution policy.
