#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PATCHY_ENGINE_HOST_PROTOCOL_VERSION 1u

typedef struct patchy_engine_runtime patchy_engine_runtime;
typedef struct patchy_engine_session patchy_engine_session;

enum patchy_engine_capability {
  PATCHY_ENGINE_CAP_LAYER_PROJECTION = UINT64_C(1) << 0,
  PATCHY_ENGINE_CAP_LAYER_VISIBILITY = UINT64_C(1) << 1,
  PATCHY_ENGINE_CAP_HISTORY = UINT64_C(1) << 2,
  PATCHY_ENGINE_CAP_BOUNDED_RENDER = UINT64_C(1) << 3,
  PATCHY_ENGINE_CAP_PSD_SAVE = UINT64_C(1) << 4,
  PATCHY_ENGINE_CAP_DOCUMENT_PROJECTION = UINT64_C(1) << 5,
  PATCHY_ENGINE_CAP_LAYER_APPEARANCE = UINT64_C(1) << 6,
  PATCHY_ENGINE_CAP_LAYER_LIFECYCLE = UINT64_C(1) << 7,
  PATCHY_ENGINE_CAP_DOCUMENT_GEOMETRY = UINT64_C(1) << 8,
  PATCHY_ENGINE_CAP_OPTIMISTIC_COMMANDS = UINT64_C(1) << 9,
  PATCHY_ENGINE_CAP_SAVE_STATE = UINT64_C(1) << 10,
};

enum patchy_engine_error_code {
  PATCHY_ENGINE_ERROR_NONE = 0,
  PATCHY_ENGINE_ERROR_INVALID_ARGUMENT = 1,
  PATCHY_ENGINE_ERROR_UNSUPPORTED_VERSION = 2,
  PATCHY_ENGINE_ERROR_ENGINE = 3,
  PATCHY_ENGINE_ERROR_ALLOCATION = 4,
  PATCHY_ENGINE_ERROR_INTERNAL = 5,
  PATCHY_ENGINE_ERROR_STALE_STATE = 6,
};

typedef struct patchy_engine_error {
  uint32_t code;
  char message[256];
} patchy_engine_error;

typedef struct patchy_engine_protocol_info {
  uint32_t struct_size;
  uint32_t protocol_version;
  uint64_t capabilities;
} patchy_engine_protocol_info;

typedef struct patchy_engine_buffer {
  /* Outputs must be zero-initialized; release every successful result here. */
  uint8_t *data;
  size_t size;
} patchy_engine_buffer;

typedef struct patchy_engine_rect {
  int32_t x;
  int32_t y;
  int32_t width;
  int32_t height;
} patchy_engine_rect;

enum patchy_engine_color_mode {
  PATCHY_ENGINE_COLOR_MODE_GRAYSCALE = 0,
  PATCHY_ENGINE_COLOR_MODE_RGB = 1,
  PATCHY_ENGINE_COLOR_MODE_CMYK = 2,
  PATCHY_ENGINE_COLOR_MODE_LAB = 3,
};

enum patchy_engine_bit_depth {
  PATCHY_ENGINE_BIT_DEPTH_UINT8 = 8,
  PATCHY_ENGINE_BIT_DEPTH_UINT16 = 16,
  PATCHY_ENGINE_BIT_DEPTH_FLOAT32 = 32,
};

enum patchy_engine_layer_kind {
  PATCHY_ENGINE_LAYER_PIXEL = 0,
  PATCHY_ENGINE_LAYER_GROUP = 1,
  PATCHY_ENGINE_LAYER_ADJUSTMENT = 2,
  PATCHY_ENGINE_LAYER_TEXT = 3,
  PATCHY_ENGINE_LAYER_VECTOR = 4,
  PATCHY_ENGINE_LAYER_SMART_OBJECT = 5,
};

enum patchy_engine_layer_lock {
  PATCHY_ENGINE_LAYER_LOCK_NONE = 0,
  PATCHY_ENGINE_LAYER_LOCK_TRANSPARENT_PIXELS = 1u << 0,
  PATCHY_ENGINE_LAYER_LOCK_IMAGE_PIXELS = 1u << 1,
  PATCHY_ENGINE_LAYER_LOCK_POSITION = 1u << 2,
  PATCHY_ENGINE_LAYER_LOCK_ALL =
      PATCHY_ENGINE_LAYER_LOCK_TRANSPARENT_PIXELS |
      PATCHY_ENGINE_LAYER_LOCK_IMAGE_PIXELS |
      PATCHY_ENGINE_LAYER_LOCK_POSITION,
};

enum patchy_engine_blend_mode {
  PATCHY_ENGINE_BLEND_PASS_THROUGH = 0,
  PATCHY_ENGINE_BLEND_NORMAL = 1,
  PATCHY_ENGINE_BLEND_MULTIPLY = 2,
  PATCHY_ENGINE_BLEND_SCREEN = 3,
  PATCHY_ENGINE_BLEND_OVERLAY = 4,
  PATCHY_ENGINE_BLEND_DARKEN = 5,
  PATCHY_ENGINE_BLEND_LIGHTEN = 6,
  PATCHY_ENGINE_BLEND_COLOR_DODGE = 7,
  PATCHY_ENGINE_BLEND_COLOR_BURN = 8,
  PATCHY_ENGINE_BLEND_HARD_LIGHT = 9,
  PATCHY_ENGINE_BLEND_SOFT_LIGHT = 10,
  PATCHY_ENGINE_BLEND_DIFFERENCE = 11,
  PATCHY_ENGINE_BLEND_LINEAR_BURN = 12,
  PATCHY_ENGINE_BLEND_PIN_LIGHT = 13,
  PATCHY_ENGINE_BLEND_SATURATION = 14,
  PATCHY_ENGINE_BLEND_LUMINOSITY = 15,
  PATCHY_ENGINE_BLEND_EXCLUSION = 16,
  PATCHY_ENGINE_BLEND_HUE = 17,
  PATCHY_ENGINE_BLEND_COLOR = 18,
  PATCHY_ENGINE_BLEND_LINEAR_DODGE = 19,
  PATCHY_ENGINE_BLEND_SUBTRACT = 20,
  PATCHY_ENGINE_BLEND_DIVIDE = 21,
  PATCHY_ENGINE_BLEND_VIVID_LIGHT = 22,
  PATCHY_ENGINE_BLEND_LINEAR_LIGHT = 23,
  PATCHY_ENGINE_BLEND_HARD_MIX = 24,
  PATCHY_ENGINE_BLEND_DARKER_COLOR = 25,
  PATCHY_ENGINE_BLEND_LIGHTER_COLOR = 26,
  PATCHY_ENGINE_BLEND_DISSOLVE = 27,
};

typedef struct patchy_engine_layer_projection {
  uint64_t id;
  uint64_t parent_id;
  uint32_t kind;
  uint8_t visible;
  float opacity;
  uint32_t name_size;
  char name[256];
  uint8_t clipped;
  float fill_opacity;
  uint32_t blend_mode;
  uint32_t lock_flags;
  patchy_engine_rect bounds;
} patchy_engine_layer_projection;

typedef struct patchy_engine_document_projection {
  uint32_t struct_size;
  int32_t width;
  int32_t height;
  uint32_t color_mode;
  uint32_t bit_depth;
  uint32_t channels;
  uint64_t active_layer_id;
  uint64_t revision;
  uint64_t state_id;
  size_t layer_count;
  uint8_t has_active_layer;
  uint8_t dirty;
  uint8_t can_undo;
  uint8_t can_redo;
} patchy_engine_document_projection;

enum patchy_engine_canvas_anchor {
  PATCHY_ENGINE_ANCHOR_TOP_LEFT = 0,
  PATCHY_ENGINE_ANCHOR_TOP = 1,
  PATCHY_ENGINE_ANCHOR_TOP_RIGHT = 2,
  PATCHY_ENGINE_ANCHOR_LEFT = 3,
  PATCHY_ENGINE_ANCHOR_CENTER = 4,
  PATCHY_ENGINE_ANCHOR_RIGHT = 5,
  PATCHY_ENGINE_ANCHOR_BOTTOM_LEFT = 6,
  PATCHY_ENGINE_ANCHOR_BOTTOM = 7,
  PATCHY_ENGINE_ANCHOR_BOTTOM_RIGHT = 8,
};

enum patchy_engine_layer_drop_position {
  PATCHY_ENGINE_DROP_ON_ITEM = 0,
  PATCHY_ENGINE_DROP_ABOVE_ITEM = 1,
  PATCHY_ENGINE_DROP_BELOW_ITEM = 2,
  PATCHY_ENGINE_DROP_ON_VIEWPORT = 3,
};

enum patchy_engine_command_type {
  PATCHY_ENGINE_COMMAND_SET_LAYER_VISIBILITY = 1,
  PATCHY_ENGINE_COMMAND_SET_LAYER_OPACITY = 2,
  PATCHY_ENGINE_COMMAND_SET_LAYER_FILL_OPACITY = 3,
  PATCHY_ENGINE_COMMAND_SET_LAYER_BLEND_MODE = 4,
  PATCHY_ENGINE_COMMAND_RENAME_LAYER = 5,
  PATCHY_ENGINE_COMMAND_SET_LAYER_LOCKS = 6,
  PATCHY_ENGINE_COMMAND_SET_LAYER_CLIPPING = 7,
  PATCHY_ENGINE_COMMAND_ADD_SOLID_LAYER = 8,
  PATCHY_ENGINE_COMMAND_REMOVE_LAYER = 9,
  PATCHY_ENGINE_COMMAND_RESIZE_IMAGE = 10,
  PATCHY_ENGINE_COMMAND_RESIZE_CANVAS = 11,
  PATCHY_ENGINE_COMMAND_ROTATE_CANVAS = 12,
  PATCHY_ENGINE_COMMAND_CROP_DOCUMENT = 13,
  PATCHY_ENGINE_COMMAND_ADD_GROUP = 14,
  PATCHY_ENGINE_COMMAND_MOVE_LAYER = 15,
  PATCHY_ENGINE_COMMAND_UNGROUP = 16,
};

typedef struct patchy_engine_command {
  uint32_t struct_size;
  uint32_t protocol_version;
  uint32_t type;
  uint32_t flags;
  uint64_t expected_state_id;
  union {
    struct {
      uint64_t layer_id;
      uint8_t visible;
    } set_layer_visibility;
    struct {
      uint64_t layer_id;
      float opacity;
    } set_layer_opacity;
    struct {
      uint64_t layer_id;
      float opacity;
    } set_layer_fill_opacity;
    struct {
      uint64_t layer_id;
      uint32_t blend_mode;
    } set_layer_blend_mode;
    struct {
      uint64_t layer_id;
      uint32_t name_size;
      char name[256];
    } rename_layer;
    struct {
      uint64_t layer_id;
      uint32_t lock_flags;
    } set_layer_locks;
    struct {
      uint64_t layer_id;
      uint8_t clipped;
    } set_layer_clipping;
    struct {
      uint32_t name_size;
      char name[256];
      uint8_t red;
      uint8_t green;
      uint8_t blue;
      uint8_t alpha;
    } add_solid_layer;
    struct {
      uint64_t layer_id;
    } remove_layer;
    struct {
      int32_t width;
      int32_t height;
    } resize_image;
    struct {
      int32_t width;
      int32_t height;
      uint32_t anchor;
      uint8_t red;
      uint8_t green;
      uint8_t blue;
      uint8_t alpha;
    } resize_canvas;
    struct {
      double clockwise_degrees;
      uint8_t red;
      uint8_t green;
      uint8_t blue;
      uint8_t alpha;
    } rotate_canvas;
    struct {
      patchy_engine_rect crop;
      double clockwise_degrees;
      uint8_t red;
      uint8_t green;
      uint8_t blue;
      uint8_t alpha;
      uint8_t clip_to_canvas;
    } crop_document;
    struct {
      uint32_t name_size;
      char name[256];
    } add_group;
    struct {
      uint64_t layer_id;
      uint64_t target_layer_id;
      uint32_t position;
      uint8_t has_target_layer;
    } move_layer;
    struct {
      uint64_t group_id;
    } ungroup;
  } payload;
} patchy_engine_command;

typedef struct patchy_engine_event {
  uint32_t struct_size;
  uint32_t protocol_version;
  uint64_t revision;
  uint64_t state_id;
  uint64_t affected_layer_id;
  uint8_t changed;
  uint8_t dirty;
  uint8_t has_affected_region;
  patchy_engine_rect affected_region;
} patchy_engine_event;

int patchy_engine_get_protocol_info(patchy_engine_protocol_info *info,
                                    patchy_engine_error *error);
patchy_engine_runtime *patchy_engine_runtime_create(uint32_t requested_version,
                                                    patchy_engine_error *error);
void patchy_engine_runtime_destroy(patchy_engine_runtime *runtime);

patchy_engine_session *patchy_engine_session_open_psd(
    patchy_engine_runtime *runtime, const uint8_t *data, size_t size,
    patchy_engine_error *error);
patchy_engine_session *patchy_engine_session_create_rgba8(
    patchy_engine_runtime *runtime, int32_t width, int32_t height,
    patchy_engine_error *error);
void patchy_engine_session_destroy(patchy_engine_session *session);

int patchy_engine_session_document(const patchy_engine_session *session,
                                   patchy_engine_document_projection *document,
                                   patchy_engine_error *error);

int patchy_engine_session_layer_count(const patchy_engine_session *session,
                                      size_t *count,
                                      patchy_engine_error *error);
int patchy_engine_session_layer_at(const patchy_engine_session *session,
                                   size_t index,
                                   patchy_engine_layer_projection *layer,
                                   patchy_engine_error *error);
int patchy_engine_session_execute(patchy_engine_session *session,
                                  const patchy_engine_command *command,
                                  patchy_engine_event *event,
                                  patchy_engine_error *error);
int patchy_engine_session_undo(patchy_engine_session *session,
                               patchy_engine_event *event,
                               patchy_engine_error *error);
int patchy_engine_session_redo(patchy_engine_session *session,
                               patchy_engine_event *event,
                               patchy_engine_error *error);
int patchy_engine_session_render(patchy_engine_session *session,
                                 patchy_engine_rect region,
                                 patchy_engine_buffer *rgba,
                                 patchy_engine_event *event,
                                 patchy_engine_error *error);
int patchy_engine_session_save_psd(patchy_engine_session *session,
                                   patchy_engine_buffer *psd,
                                   patchy_engine_event *event,
                                   patchy_engine_error *error);
int patchy_engine_session_mark_saved(patchy_engine_session *session,
                                     uint64_t expected_state_id,
                                     patchy_engine_event *event,
                                     patchy_engine_error *error);
void patchy_engine_buffer_release(patchy_engine_buffer *buffer);

#ifdef __cplusplus
}
#endif
