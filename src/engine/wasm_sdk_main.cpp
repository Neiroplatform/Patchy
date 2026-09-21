#include "engine/host_protocol.h"

#include <cstddef>

// These are the wasm32 layouts consumed by sdk/engine/module-adapter.mjs.
// A toolchain ABI change must fail the SDK build instead of corrupting memory.
static_assert(sizeof(patchy_engine_error) == 260);
static_assert(sizeof(patchy_engine_protocol_info) == 16);
static_assert(sizeof(patchy_engine_buffer) == 8);
static_assert(sizeof(patchy_engine_document_projection) == 56);
static_assert(offsetof(patchy_engine_document_projection, layer_count) == 48);
static_assert(sizeof(patchy_engine_layer_projection) == 320);
static_assert(offsetof(patchy_engine_layer_projection, name) == 32);
static_assert(offsetof(patchy_engine_layer_projection, bounds) == 304);
static_assert(sizeof(patchy_engine_event) == 64);
static_assert(sizeof(patchy_engine_command) == 304);
static_assert(offsetof(patchy_engine_command, payload) == 32);
static_assert(offsetof(patchy_engine_command, payload.resize_image.width) == 32);
static_assert(offsetof(patchy_engine_command, payload.resize_canvas.anchor) == 40);
static_assert(offsetof(patchy_engine_command,
                       payload.rotate_canvas.clockwise_degrees) == 32);
static_assert(offsetof(patchy_engine_command, payload.crop_document.crop) == 32);
static_assert(offsetof(patchy_engine_command,
                       payload.crop_document.clockwise_degrees) == 48);
static_assert(sizeof(patchy_engine_pixel_layer_input) == 80);
static_assert(offsetof(patchy_engine_pixel_layer_input, bounds) == 32);
static_assert(offsetof(patchy_engine_pixel_layer_input, rgba) == 56);
static_assert(offsetof(patchy_engine_pixel_layer_input, name) == 64);
static_assert(sizeof(patchy_engine_text_layer_input) == 96);
static_assert(offsetof(patchy_engine_text_layer_input, rgba) == 48);
static_assert(offsetof(patchy_engine_text_layer_input, text) == 64);
static_assert(offsetof(patchy_engine_text_layer_input, size_pixels) == 80);
static_assert(sizeof(patchy_engine_text_projection) == 1312);
static_assert(offsetof(patchy_engine_text_projection, font) == 1036);
static_assert(offsetof(patchy_engine_text_projection, size_pixels) == 1296);
static_assert(sizeof(patchy_engine_selection_projection) == 32);
static_assert(offsetof(patchy_engine_selection_projection, mask_bounds) == 12);
static_assert(sizeof(patchy_engine_selection_input) == 32);
static_assert(offsetof(patchy_engine_selection_input, rects) == 24);
static_assert(sizeof(patchy_engine_layer_mask_input) == 72);
static_assert(offsetof(patchy_engine_layer_mask_input, bounds) == 32);
static_assert(offsetof(patchy_engine_layer_mask_input, gray) == 56);
static_assert(sizeof(patchy_engine_layer_mask_projection) == 24);
static_assert(sizeof(patchy_engine_filter_parameter) == 208);
static_assert(offsetof(patchy_engine_filter_parameter, value) == 72);
static_assert(sizeof(patchy_engine_filter_input) == 56);
static_assert(offsetof(patchy_engine_filter_input, layer_id) == 24);
static_assert(offsetof(patchy_engine_filter_input, filter_id) == 32);
static_assert(offsetof(patchy_engine_filter_input, parameters) == 40);
static_assert(offsetof(patchy_engine_filter_input, selection) == 48);

// The browser SDK is a no-entry Emscripten module. Its public surface is the
// versioned C ABI listed in sdk/engine/exports.json.
namespace patchy::engine {
void keep_wasm_sdk_translation_unit() {}
}
