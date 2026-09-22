# Engine SDK compatibility

The private `@patchy/engine-sdk` package is the supported JavaScript entrypoint
for a self-hosted Patchy engine Worker. Version `0.1.0` is pre-1.0: it is
intended for pinned application deployments, not public npm distribution.

## Version handshake

Initialization succeeds only when all three contract versions match exactly:

- SDK package version: `PATCHY_ENGINE_SDK_VERSION`;
- Worker RPC version: `PATCHY_WORKER_RPC_VERSION`;
- native/Wasm C ABI version: `PATCHY_ENGINE_PROTOCOL_VERSION`.

The client sends all three values before the Worker creates an engine host. The
Worker rejects an incompatible client before loading the module, and the client
rejects an incompatible Worker or engine response, terminates that Worker and
enters the observable `crashed` state. There is no best-effort downgrade.

After the version handshake, the client requires the capability mask exported
as `PATCHY_ENGINE_REQUIRED_CAPABILITIES`. Missing mandatory capabilities fail
initialization. Optional capabilities are exposed through
`PATCHY_ENGINE_CAPABILITIES` and the client's `capabilities` value.

## Compatibility policy

- Patch releases may fix behavior without changing exported TypeScript
  signatures, RPC envelopes or C ABI layout.
- Minor pre-1.0 releases may add APIs and capabilities. A breaking TypeScript,
  RPC or C ABI change must increment the affected version constant and record
  the migration in `sdk/engine/CHANGELOG.md`.
- A C ABI struct may only grow through a versioned `struct_size` contract. Its
  existing field offsets, enum values and ownership rules remain stable within
  one engine protocol version.
- RPC request and response fields are immutable within one RPC version. New
  optional fields must preserve old behavior when absent.
- `Uint8Array` outputs are caller-owned JavaScript copies. Input bytes are
  copied unless the caller explicitly requests whole-buffer ownership transfer.
- One Worker owns its runtime and sessions. Canonical document state, Wasm
  pointers and C++ objects never cross into the UI thread.

## Progress and cancellation

`renderCancellable` and `saveCancellable` use shared `Int32` cancellation
storage sampled by the C callback while the Worker is synchronously inside
Wasm. Render progress is monotonic by completed rows. PSD and PSB save progress
is monotonic by phase and logical output bytes. Cancellation returns no partial
buffer and does not mutate document state.

The synchronous `render` and `save` methods remain available for callers that
do not need progress. Progressive output must remain byte-identical to the
corresponding synchronous operation.

## Distribution boundary

The package remains marked `private`. A hosted application must pin the SDK,
Worker, generated Emscripten module and `.wasm` from one verified build. Public
npm publication, CDN loading and compatibility with independently upgraded
artifacts require a separate distribution gate.
