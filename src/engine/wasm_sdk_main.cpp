#include "engine/host_protocol.h"

#include <cstddef>

// These are the wasm32 layouts consumed by sdk/engine/module-adapter.mjs.
// A toolchain ABI change must fail the SDK build instead of corrupting memory.
static_assert(sizeof(patchy_engine_error) == 260);
static_assert(sizeof(patchy_engine_buffer) == 8);
static_assert(sizeof(patchy_engine_document_projection) == 56);
static_assert(offsetof(patchy_engine_document_projection, layer_count) == 48);
static_assert(sizeof(patchy_engine_layer_projection) == 320);
static_assert(offsetof(patchy_engine_layer_projection, name) == 32);
static_assert(offsetof(patchy_engine_layer_projection, bounds) == 304);
static_assert(sizeof(patchy_engine_event) == 64);

// The browser SDK is a no-entry Emscripten module. Its public surface is the
// versioned C ABI listed in sdk/engine/exports.json.
namespace patchy::engine {
void keep_wasm_sdk_translation_unit() {}
}
