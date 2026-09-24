#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PATCHY_ENGINE_HOST_PROTOCOL_VERSION 1u

typedef struct patchy_engine_runtime patchy_engine_runtime;
typedef struct patchy_engine_session patchy_engine_session;
typedef struct patchy_engine_cancellation patchy_engine_cancellation;

#ifdef __cplusplus
enum patchy_engine_capability : uint64_t {
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
  PATCHY_ENGINE_CAP_SELECTION_PROJECTION = UINT64_C(1) << 11,
  PATCHY_ENGINE_CAP_SAVED_CHANNELS = UINT64_C(1) << 12,
  PATCHY_ENGINE_CAP_PIXEL_AUTHORING = UINT64_C(1) << 13,
  PATCHY_ENGINE_CAP_PATH_PROJECTION = UINT64_C(1) << 14,
  PATCHY_ENGINE_CAP_VECTOR_AUTHORING = UINT64_C(1) << 15,
  PATCHY_ENGINE_CAP_LAYER_MASK_AUTHORING = UINT64_C(1) << 16,
  PATCHY_ENGINE_CAP_FILTER_AUTHORING = UINT64_C(1) << 17,
  PATCHY_ENGINE_CAP_PROGRESS_CANCELLATION = UINT64_C(1) << 18,
  PATCHY_ENGINE_CAP_EVENT_DRAIN = UINT64_C(1) << 19,
  PATCHY_ENGINE_CAP_TEXT_AUTHORING = UINT64_C(1) << 20,
  PATCHY_ENGINE_CAP_SMART_OBJECT_AUTHORING = UINT64_C(1) << 21,
  PATCHY_ENGINE_CAP_ADJUSTMENT_AUTHORING = UINT64_C(1) << 22,
  PATCHY_ENGINE_CAP_VECTOR_MASK_AUTHORING = UINT64_C(1) << 23,
  PATCHY_ENGINE_CAP_SMART_FILTER_AUTHORING = UINT64_C(1) << 24,
  PATCHY_ENGINE_CAP_SELECTION_AUTHORING = UINT64_C(1) << 25,
  PATCHY_ENGINE_CAP_MEMORY_CONTROL = UINT64_C(1) << 26,
  PATCHY_ENGINE_CAP_CROSS_DOCUMENT_LAYERS = UINT64_C(1) << 27,
  PATCHY_ENGINE_CAP_LAYER_TRANSFORM = UINT64_C(1) << 28,
  PATCHY_ENGINE_CAP_RASTER_STROKE = UINT64_C(1) << 29,
  PATCHY_ENGINE_CAP_RASTER_FILL = UINT64_C(1) << 30,
  PATCHY_ENGINE_CAP_LAYER_WARP = UINT64_C(1) << 31,
  PATCHY_ENGINE_CAP_ESSENTIAL_LAYER_STYLE = UINT64_C(1) << 32,
  PATCHY_ENGINE_CAP_PSB_SAVE_AS = UINT64_C(1) << 33,
  PATCHY_ENGINE_CAP_LAYER_MASK_STROKE = UINT64_C(1) << 34,
  PATCHY_ENGINE_CAP_RICH_TEXT_AUTHORING = UINT64_C(1) << 35,
  PATCHY_ENGINE_CAP_MULTI_LAYER_AUTHORING = UINT64_C(1) << 36,
  PATCHY_ENGINE_CAP_MULTI_LAYER_TRANSFER = UINT64_C(1) << 37,
  PATCHY_ENGINE_CAP_MULTI_LAYER_TRANSFORM = UINT64_C(1) << 38,
  PATCHY_ENGINE_CAP_LAYER_ARRANGE = UINT64_C(1) << 39,
  PATCHY_ENGINE_CAP_SELECTION_REFINEMENT = UINT64_C(1) << 40,
  PATCHY_ENGINE_CAP_LIQUIFY_AUTHORING = UINT64_C(1) << 41,
  PATCHY_ENGINE_CAP_RETOUCH_REPAIR = UINT64_C(1) << 42,
};
#else
enum patchy_engine_capability {
  PATCHY_ENGINE_CAPABILITY_NONE = 0,
};
typedef uint64_t patchy_engine_capability;

#define PATCHY_ENGINE_CAP_LAYER_PROJECTION (UINT64_C(1) << 0)
#define PATCHY_ENGINE_CAP_LAYER_VISIBILITY (UINT64_C(1) << 1)
#define PATCHY_ENGINE_CAP_HISTORY (UINT64_C(1) << 2)
#define PATCHY_ENGINE_CAP_BOUNDED_RENDER (UINT64_C(1) << 3)
#define PATCHY_ENGINE_CAP_PSD_SAVE (UINT64_C(1) << 4)
#define PATCHY_ENGINE_CAP_DOCUMENT_PROJECTION (UINT64_C(1) << 5)
#define PATCHY_ENGINE_CAP_LAYER_APPEARANCE (UINT64_C(1) << 6)
#define PATCHY_ENGINE_CAP_LAYER_LIFECYCLE (UINT64_C(1) << 7)
#define PATCHY_ENGINE_CAP_DOCUMENT_GEOMETRY (UINT64_C(1) << 8)
#define PATCHY_ENGINE_CAP_OPTIMISTIC_COMMANDS (UINT64_C(1) << 9)
#define PATCHY_ENGINE_CAP_SAVE_STATE (UINT64_C(1) << 10)
#define PATCHY_ENGINE_CAP_SELECTION_PROJECTION (UINT64_C(1) << 11)
#define PATCHY_ENGINE_CAP_SAVED_CHANNELS (UINT64_C(1) << 12)
#define PATCHY_ENGINE_CAP_PIXEL_AUTHORING (UINT64_C(1) << 13)
#define PATCHY_ENGINE_CAP_PATH_PROJECTION (UINT64_C(1) << 14)
#define PATCHY_ENGINE_CAP_VECTOR_AUTHORING (UINT64_C(1) << 15)
#define PATCHY_ENGINE_CAP_LAYER_MASK_AUTHORING (UINT64_C(1) << 16)
#define PATCHY_ENGINE_CAP_FILTER_AUTHORING (UINT64_C(1) << 17)
#define PATCHY_ENGINE_CAP_PROGRESS_CANCELLATION (UINT64_C(1) << 18)
#define PATCHY_ENGINE_CAP_EVENT_DRAIN (UINT64_C(1) << 19)
#define PATCHY_ENGINE_CAP_TEXT_AUTHORING (UINT64_C(1) << 20)
#define PATCHY_ENGINE_CAP_SMART_OBJECT_AUTHORING (UINT64_C(1) << 21)
#define PATCHY_ENGINE_CAP_ADJUSTMENT_AUTHORING (UINT64_C(1) << 22)
#define PATCHY_ENGINE_CAP_VECTOR_MASK_AUTHORING (UINT64_C(1) << 23)
#define PATCHY_ENGINE_CAP_SMART_FILTER_AUTHORING (UINT64_C(1) << 24)
#define PATCHY_ENGINE_CAP_SELECTION_AUTHORING (UINT64_C(1) << 25)
#define PATCHY_ENGINE_CAP_MEMORY_CONTROL (UINT64_C(1) << 26)
#define PATCHY_ENGINE_CAP_CROSS_DOCUMENT_LAYERS (UINT64_C(1) << 27)
#define PATCHY_ENGINE_CAP_LAYER_TRANSFORM (UINT64_C(1) << 28)
#define PATCHY_ENGINE_CAP_RASTER_STROKE (UINT64_C(1) << 29)
#define PATCHY_ENGINE_CAP_RASTER_FILL (UINT64_C(1) << 30)
#define PATCHY_ENGINE_CAP_LAYER_WARP (UINT64_C(1) << 31)
#define PATCHY_ENGINE_CAP_ESSENTIAL_LAYER_STYLE (UINT64_C(1) << 32)
#define PATCHY_ENGINE_CAP_PSB_SAVE_AS (UINT64_C(1) << 33)
#define PATCHY_ENGINE_CAP_LAYER_MASK_STROKE (UINT64_C(1) << 34)
#define PATCHY_ENGINE_CAP_RICH_TEXT_AUTHORING (UINT64_C(1) << 35)
#define PATCHY_ENGINE_CAP_MULTI_LAYER_AUTHORING (UINT64_C(1) << 36)
#define PATCHY_ENGINE_CAP_MULTI_LAYER_TRANSFER (UINT64_C(1) << 37)
#define PATCHY_ENGINE_CAP_MULTI_LAYER_TRANSFORM (UINT64_C(1) << 38)
#define PATCHY_ENGINE_CAP_LAYER_ARRANGE (UINT64_C(1) << 39)
#define PATCHY_ENGINE_CAP_SELECTION_REFINEMENT (UINT64_C(1) << 40)
#define PATCHY_ENGINE_CAP_LIQUIFY_AUTHORING (UINT64_C(1) << 41)
#define PATCHY_ENGINE_CAP_RETOUCH_REPAIR (UINT64_C(1) << 42)
#endif

enum patchy_engine_error_code {
  PATCHY_ENGINE_ERROR_NONE = 0,
  PATCHY_ENGINE_ERROR_INVALID_ARGUMENT = 1,
  PATCHY_ENGINE_ERROR_UNSUPPORTED_VERSION = 2,
  PATCHY_ENGINE_ERROR_ENGINE = 3,
  PATCHY_ENGINE_ERROR_ALLOCATION = 4,
  PATCHY_ENGINE_ERROR_INTERNAL = 5,
  PATCHY_ENGINE_ERROR_STALE_STATE = 6,
  PATCHY_ENGINE_ERROR_CANCELLED = 7,
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

enum patchy_engine_transform_interpolation {
  PATCHY_ENGINE_TRANSFORM_NEAREST = 0,
  PATCHY_ENGINE_TRANSFORM_BILINEAR = 1,
};

typedef struct patchy_engine_layer_transform {
  uint32_t struct_size;
  uint32_t interpolation;
  uint64_t layer_id;
  /* top-left, top-right, bottom-right, bottom-left document-space x/y pairs */
  double quad[8];
} patchy_engine_layer_transform;

enum patchy_engine_layer_batch_property {
  PATCHY_ENGINE_LAYER_BATCH_VISIBILITY = 0,
  PATCHY_ENGINE_LAYER_BATCH_OPACITY = 1,
  PATCHY_ENGINE_LAYER_BATCH_FILL_OPACITY = 2,
  PATCHY_ENGINE_LAYER_BATCH_BLEND_MODE = 3,
  PATCHY_ENGINE_LAYER_BATCH_LOCKS = 4,
};

typedef struct patchy_engine_layer_batch {
  uint32_t struct_size;
  uint32_t reserved;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const uint64_t *layer_ids;
  size_t layer_count;
} patchy_engine_layer_batch;

typedef struct patchy_engine_layer_batch_edit {
  uint32_t struct_size;
  uint32_t property;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const uint64_t *layer_ids;
  size_t layer_count;
  float opacity;
  uint32_t value;
} patchy_engine_layer_batch_edit;

typedef struct patchy_engine_layer_batch_transform {
  uint32_t struct_size;
  uint32_t interpolation;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const uint64_t *layer_ids;
  size_t layer_count;
  /* collective top-left, top-right, bottom-right, bottom-left x/y pairs */
  double quad[8];
} patchy_engine_layer_batch_transform;

enum patchy_engine_layer_arrange_mode {
  PATCHY_ENGINE_LAYER_ALIGN_LEFT = 0,
  PATCHY_ENGINE_LAYER_ALIGN_HORIZONTAL_CENTER = 1,
  PATCHY_ENGINE_LAYER_ALIGN_RIGHT = 2,
  PATCHY_ENGINE_LAYER_ALIGN_TOP = 3,
  PATCHY_ENGINE_LAYER_ALIGN_VERTICAL_CENTER = 4,
  PATCHY_ENGINE_LAYER_ALIGN_BOTTOM = 5,
  PATCHY_ENGINE_LAYER_DISTRIBUTE_HORIZONTAL_GAPS = 6,
  PATCHY_ENGINE_LAYER_DISTRIBUTE_VERTICAL_GAPS = 7,
};

enum patchy_engine_layer_arrange_reference {
  PATCHY_ENGINE_LAYER_ARRANGE_SELECTION = 0,
  PATCHY_ENGINE_LAYER_ARRANGE_CANVAS = 1,
};

typedef struct patchy_engine_layer_arrange {
  uint32_t struct_size;
  uint32_t mode;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const uint64_t *layer_ids;
  size_t layer_count;
  uint32_t reference;
  uint32_t reserved;
} patchy_engine_layer_arrange;

typedef int (*patchy_engine_transform_progress_fn)(int32_t completed_rows,
                                                   int32_t total_rows,
                                                   void *user_data);

enum patchy_engine_raster_stroke_mode {
  PATCHY_ENGINE_RASTER_BRUSH = 0,
  PATCHY_ENGINE_RASTER_ERASER = 1,
  PATCHY_ENGINE_RASTER_CLONE = 2,
  PATCHY_ENGINE_RASTER_HEAL = 3,
};

typedef struct patchy_engine_stroke_point {
  double x;
  double y;
} patchy_engine_stroke_point;

typedef struct patchy_engine_raster_stroke {
  uint32_t struct_size;
  uint32_t mode;
  uint64_t layer_id;
  int32_t brush_size;
  uint8_t red;
  uint8_t green;
  uint8_t blue;
  uint8_t alpha;
  double source_x;
  double source_y;
  const patchy_engine_stroke_point *points;
  size_t point_count;
} patchy_engine_raster_stroke;

enum patchy_engine_raster_fill_mode {
  PATCHY_ENGINE_RASTER_FILL_FOREGROUND_TRANSPARENT = 0,
  PATCHY_ENGINE_RASTER_FILL_BLACK_WHITE = 1,
  PATCHY_ENGINE_RASTER_FILL_SUNSET = 2,
  PATCHY_ENGINE_RASTER_FILL_OCEAN = 3,
  PATCHY_ENGINE_RASTER_FILL_SOLID = 4,
  PATCHY_ENGINE_RASTER_FILL_CHECKER = 5,
  PATCHY_ENGINE_RASTER_FILL_DOTS = 6,
  PATCHY_ENGINE_RASTER_FILL_CUSTOM_GRADIENT = 7,
  PATCHY_ENGINE_RASTER_FILL_CUSTOM_CHECKER = 8,
  PATCHY_ENGINE_RASTER_FILL_CUSTOM_DOTS = 9,
};

typedef struct patchy_engine_raster_fill {
  uint32_t struct_size;
  uint32_t mode;
  uint64_t layer_id;
  uint8_t red;
  uint8_t green;
  uint8_t blue;
  uint8_t alpha;
  uint8_t secondary_red;
  uint8_t secondary_green;
  uint8_t secondary_blue;
  uint8_t secondary_alpha;
  uint32_t pattern_size;
  double start_x;
  double start_y;
  double end_x;
  double end_y;
} patchy_engine_raster_fill;

enum patchy_engine_warp_style {
  PATCHY_ENGINE_WARP_ARC = 0,
  PATCHY_ENGINE_WARP_ARCH = 1,
  PATCHY_ENGINE_WARP_BULGE = 2,
  PATCHY_ENGINE_WARP_FLAG = 3,
  PATCHY_ENGINE_WARP_WAVE = 4,
  PATCHY_ENGINE_WARP_RISE = 5,
  PATCHY_ENGINE_WARP_ARC_LOWER = 6,
  PATCHY_ENGINE_WARP_ARC_UPPER = 7,
  PATCHY_ENGINE_WARP_SHELL_LOWER = 8,
  PATCHY_ENGINE_WARP_SHELL_UPPER = 9,
  PATCHY_ENGINE_WARP_FISH = 10,
  PATCHY_ENGINE_WARP_FISHEYE = 11,
  PATCHY_ENGINE_WARP_INFLATE = 12,
  PATCHY_ENGINE_WARP_SQUEEZE = 13,
  PATCHY_ENGINE_WARP_TWIST = 14,
};

typedef struct patchy_engine_layer_warp {
  uint32_t struct_size;
  uint32_t style;
  uint64_t layer_id;
  double bend;
  double horizontal_distortion;
  double vertical_distortion;
  uint32_t interpolation;
  uint8_t rotate_vertical;
  uint8_t reserved[3];
} patchy_engine_layer_warp;

enum patchy_engine_liquify_tool {
  PATCHY_ENGINE_LIQUIFY_FORWARD_WARP = 0,
  PATCHY_ENGINE_LIQUIFY_RECONSTRUCT = 1,
  PATCHY_ENGINE_LIQUIFY_SMOOTH = 2,
  PATCHY_ENGINE_LIQUIFY_TWIRL_CLOCKWISE = 3,
  PATCHY_ENGINE_LIQUIFY_TWIRL_COUNTER_CLOCKWISE = 4,
  PATCHY_ENGINE_LIQUIFY_PUCKER = 5,
  PATCHY_ENGINE_LIQUIFY_BLOAT = 6,
  PATCHY_ENGINE_LIQUIFY_FREEZE_MASK = 7,
  PATCHY_ENGINE_LIQUIFY_THAW_MASK = 8,
};

typedef struct patchy_engine_liquify_stroke {
  uint32_t tool;
  uint32_t reserved;
  double from_x;
  double from_y;
  double to_x;
  double to_y;
  double size;
  double pressure;
  double density;
} patchy_engine_liquify_stroke;

typedef struct patchy_engine_liquify {
  uint32_t struct_size;
  uint32_t reserved;
  uint64_t layer_id;
  const patchy_engine_liquify_stroke *strokes;
  size_t stroke_count;
} patchy_engine_liquify;

enum patchy_engine_retouch_repair_mode {
  PATCHY_ENGINE_RETOUCH_SPOT_HEALING = 0,
  PATCHY_ENGINE_RETOUCH_PATCH_SOURCE = 1,
  PATCHY_ENGINE_RETOUCH_PATCH_DESTINATION = 2,
};

typedef struct patchy_engine_retouch_repair {
  uint32_t struct_size;
  uint32_t mode;
  uint64_t layer_id;
  const patchy_engine_stroke_point *points;
  size_t point_count;
  int32_t brush_size;
  int32_t softness;
  int32_t delta_x;
  int32_t delta_y;
  uint8_t transparent;
  uint8_t sample_all_layers;
  uint8_t reserved[6];
} patchy_engine_retouch_repair;

typedef struct patchy_engine_memory_usage {
  uint32_t struct_size;
  uint32_t protocol_version;
  uint64_t document_pixel_bytes;
  uint64_t history_pixel_bytes;
  uint64_t preview_pixel_bytes;
  uint64_t selection_bytes;
  uint64_t history_selection_bytes;
  uint64_t preview_selection_bytes;
  uint64_t history_retained_bytes;
  uint64_t total_retained_bytes;
  uint64_t undo_states;
  uint64_t redo_states;
  uint64_t render_cache_bytes;
  uint64_t render_cache_entries;
  uint64_t render_cache_hits;
  uint64_t render_cache_misses;
  uint64_t render_cache_evictions;
} patchy_engine_memory_usage;

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

/* Editable first-instance projection for the browser's common Layer Style
 * workflow. Counts disclose preserved stacked instances to the shell. */
typedef struct patchy_engine_essential_layer_style_projection {
  uint32_t struct_size;
  uint32_t reserved;
  uint64_t layer_id;
  uint32_t effects_visible;
  uint32_t layer_mask_hides_effects;
  uint32_t drop_shadow_count;
  uint32_t color_overlay_count;
  uint32_t stroke_count;
  uint32_t drop_shadow_present;
  uint32_t drop_shadow_enabled;
  uint32_t drop_shadow_blend_mode;
  uint32_t drop_shadow_rgb;
  float drop_shadow_opacity;
  float drop_shadow_angle;
  float drop_shadow_distance;
  float drop_shadow_spread;
  float drop_shadow_size;
  uint32_t drop_shadow_layer_conceals;
  uint32_t color_overlay_present;
  uint32_t color_overlay_enabled;
  uint32_t color_overlay_blend_mode;
  uint32_t color_overlay_rgb;
  float color_overlay_opacity;
  uint32_t stroke_present;
  uint32_t stroke_enabled;
  uint32_t stroke_blend_mode;
  uint32_t stroke_rgb;
  float stroke_opacity;
  float stroke_size;
  uint32_t stroke_position;
  uint32_t stroke_overprint;
  uint32_t inner_shadow_count;
  uint32_t outer_glow_count;
  uint32_t inner_glow_count;
  uint32_t satin_count;
  uint32_t inner_shadow_present;
  uint32_t inner_shadow_enabled;
  uint32_t inner_shadow_blend_mode;
  uint32_t inner_shadow_rgb;
  float inner_shadow_opacity;
  float inner_shadow_angle;
  float inner_shadow_distance;
  float inner_shadow_choke;
  float inner_shadow_size;
  uint32_t outer_glow_present;
  uint32_t outer_glow_enabled;
  uint32_t outer_glow_blend_mode;
  uint32_t outer_glow_rgb;
  float outer_glow_opacity;
  float outer_glow_spread;
  float outer_glow_size;
  uint32_t outer_glow_technique;
  float outer_glow_range;
  uint32_t inner_glow_present;
  uint32_t inner_glow_enabled;
  uint32_t inner_glow_blend_mode;
  uint32_t inner_glow_rgb;
  float inner_glow_opacity;
  float inner_glow_choke;
  float inner_glow_size;
  uint32_t inner_glow_source;
  uint32_t inner_glow_technique;
  float inner_glow_range;
  uint32_t satin_present;
  uint32_t satin_enabled;
  uint32_t satin_blend_mode;
  uint32_t satin_rgb;
  float satin_opacity;
  float satin_angle;
  float satin_distance;
  float satin_size;
  uint32_t satin_invert;
} patchy_engine_essential_layer_style_projection;

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

typedef struct patchy_engine_selection_projection {
  uint32_t struct_size;
  size_t selection_rect_count;
  size_t display_rect_count;
  patchy_engine_rect mask_bounds;
  uint8_t has_mask;
  uint8_t empty;
} patchy_engine_selection_projection;

enum patchy_engine_channel_kind {
  PATCHY_ENGINE_CHANNEL_ALPHA = 0,
  PATCHY_ENGINE_CHANNEL_SPOT = 1,
};

enum patchy_engine_channel_color_indicates {
  PATCHY_ENGINE_CHANNEL_MASKED_AREAS = 0,
  PATCHY_ENGINE_CHANNEL_SELECTED_AREAS = 1,
  PATCHY_ENGINE_CHANNEL_SPOT_COLOR = 2,
};

typedef struct patchy_engine_channel_projection {
  uint64_t id;
  uint32_t kind;
  uint32_t name_size;
  char name[256];
  uint8_t display_red;
  uint8_t display_green;
  uint8_t display_blue;
  float display_opacity;
  uint32_t color_indicates;
} patchy_engine_channel_projection;

typedef struct patchy_engine_pixel_layer_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  uint64_t layer_id;
  patchy_engine_rect bounds;
  int32_t width;
  int32_t height;
  const uint8_t *rgba;
  size_t rgba_size;
  const char *name;
  size_t name_size;
  uint8_t rasterize_smart_object;
} patchy_engine_pixel_layer_input;

typedef struct patchy_engine_layer_mask_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  uint64_t layer_id;
  patchy_engine_rect bounds;
  int32_t width;
  int32_t height;
  const uint8_t *gray;
  size_t gray_size;
  uint8_t default_color;
  uint8_t disabled;
  uint8_t linked;
  uint8_t has_mask;
} patchy_engine_layer_mask_input;

typedef struct patchy_engine_selection_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const patchy_engine_rect *rects;
  size_t rect_count;
} patchy_engine_selection_input;

typedef struct patchy_engine_selection_mask_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  patchy_engine_rect bounds;
  int32_t width;
  int32_t height;
  const uint8_t *gray;
  size_t gray_size;
} patchy_engine_selection_mask_input;

typedef struct patchy_engine_point {
  int32_t x;
  int32_t y;
} patchy_engine_point;

typedef struct patchy_engine_quick_select_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const patchy_engine_point *points;
  size_t point_count;
  int32_t brush_radius;
  int32_t spread;
  uint8_t subtract;
  uint8_t enhance_edge;
} patchy_engine_quick_select_input;

typedef struct patchy_engine_magnetic_lasso_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const patchy_engine_point *anchors;
  size_t anchor_count;
  int32_t width;
  int32_t edge_contrast;
  int32_t node_budget;
  uint32_t combine;
} patchy_engine_magnetic_lasso_input;

enum patchy_engine_selection_refinement_output {
  PATCHY_ENGINE_SELECTION_REFINEMENT_SELECTION = 0,
  PATCHY_ENGINE_SELECTION_REFINEMENT_LAYER_MASK = 1,
};

typedef struct patchy_engine_selection_refinement_input {
  uint32_t struct_size;
  uint32_t output;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  int32_t smooth;
  int32_t contrast;
  int32_t shift_edge;
  uint32_t reserved;
  double feather;
  uint64_t layer_id;
} patchy_engine_selection_refinement_input;

typedef struct patchy_engine_layer_mask_projection {
  uint32_t struct_size;
  patchy_engine_rect bounds;
  uint8_t default_color;
  uint8_t disabled;
  uint8_t linked;
  uint8_t has_mask;
} patchy_engine_layer_mask_projection;

enum patchy_engine_filter_parameter_kind {
  PATCHY_ENGINE_FILTER_PARAMETER_INTEGER = 0,
  PATCHY_ENGINE_FILTER_PARAMETER_DOUBLE = 1,
  PATCHY_ENGINE_FILTER_PARAMETER_BOOLEAN = 2,
  PATCHY_ENGINE_FILTER_PARAMETER_OPTION = 3,
};

typedef struct patchy_engine_filter_parameter {
  uint32_t kind;
  uint32_t key_size;
  char key[64];
  union {
    int64_t integer_value;
    double double_value;
    uint8_t boolean_value;
    struct {
      uint32_t size;
      char value[128];
    } option_value;
  } value;
} patchy_engine_filter_parameter;

typedef struct patchy_engine_filter_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  uint64_t layer_id;
  const char *filter_id;
  size_t filter_id_size;
  const patchy_engine_filter_parameter *parameters;
  size_t parameter_count;
  const patchy_engine_rect *selection;
  size_t selection_count;
} patchy_engine_filter_input;

typedef struct patchy_engine_text_style_run {
  uint32_t struct_size;
  int32_t start;
  int32_t length;
  uint32_t font_size;
  char font[256];
  uint32_t style_size;
  char style[128];
  double size_pixels;
  double leading;
  double tracking;
  double horizontal_scale;
  double vertical_scale;
  uint8_t red;
  uint8_t green;
  uint8_t blue;
  uint8_t bold;
  uint8_t italic;
  uint8_t faux_bold;
  uint8_t faux_italic;
  uint8_t auto_leading;
} patchy_engine_text_style_run;

enum patchy_engine_text_justification {
  PATCHY_ENGINE_TEXT_LEFT = 0,
  PATCHY_ENGINE_TEXT_RIGHT = 1,
  PATCHY_ENGINE_TEXT_CENTER = 2,
  PATCHY_ENGINE_TEXT_JUSTIFY = 3,
};

typedef struct patchy_engine_text_paragraph_run {
  uint32_t struct_size;
  int32_t start;
  int32_t length;
  uint32_t justification;
  double first_line_indent;
  double start_indent;
  double end_indent;
  double space_before;
  double space_after;
  double auto_leading_fraction;
} patchy_engine_text_paragraph_run;

typedef struct patchy_engine_text_layer_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  patchy_engine_rect bounds;
  int32_t width;
  int32_t height;
  const uint8_t *rgba;
  size_t rgba_size;
  const char *name;
  size_t name_size;
  const char *text;
  size_t text_size;
  const char *font;
  size_t font_size;
  double size_pixels;
  uint8_t red;
  uint8_t green;
  uint8_t blue;
  uint8_t bold;
  uint8_t italic;
  uint8_t box_text;
  const patchy_engine_text_style_run *style_runs;
  size_t style_run_count;
  const patchy_engine_text_paragraph_run *paragraph_runs;
  size_t paragraph_run_count;
} patchy_engine_text_layer_input;

enum patchy_engine_smart_object_source_kind {
  PATCHY_ENGINE_SMART_OBJECT_EMBEDDED = 0,
  PATCHY_ENGINE_SMART_OBJECT_EXTERNAL = 1,
};

typedef struct patchy_engine_smart_object_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  patchy_engine_rect bounds;
  int32_t width;
  int32_t height;
  const uint8_t *rgba;
  size_t rgba_size;
  const char *name;
  size_t name_size;
  uint32_t source_kind;
  const char *filename;
  size_t filename_size;
  char filetype[4];
  const uint8_t *source_bytes;
  size_t source_size;
  const char *external_uri;
  size_t external_uri_size;
  const char *external_path;
  size_t external_path_size;
  const char *relative_path;
  size_t relative_path_size;
} patchy_engine_smart_object_input;

typedef struct patchy_engine_text_projection {
  uint32_t struct_size;
  uint32_t text_size;
  char text[1024];
  uint32_t font_size;
  char font[256];
  double size_pixels;
  uint8_t red;
  uint8_t green;
  uint8_t blue;
  uint8_t bold;
  uint8_t italic;
  uint8_t box_text;
  uint32_t style_run_count;
  uint32_t paragraph_run_count;
} patchy_engine_text_projection;

typedef struct patchy_engine_smart_object_projection {
  uint32_t struct_size;
  uint32_t source_kind;
  uint32_t filename_size;
  char filename[256];
  char filetype[4];
  uint64_t source_size;
  uint8_t editable;
} patchy_engine_smart_object_projection;

enum patchy_engine_adjustment_kind {
  PATCHY_ENGINE_ADJUSTMENT_LEVELS = 0,
  PATCHY_ENGINE_ADJUSTMENT_CURVES = 1,
  PATCHY_ENGINE_ADJUSTMENT_HUE_SATURATION = 2,
  PATCHY_ENGINE_ADJUSTMENT_COLOR_BALANCE = 3,
  PATCHY_ENGINE_ADJUSTMENT_INVERT = 4,
  PATCHY_ENGINE_ADJUSTMENT_POSTERIZE = 5,
  PATCHY_ENGINE_ADJUSTMENT_THRESHOLD = 6,
  PATCHY_ENGINE_ADJUSTMENT_BRIGHTNESS_CONTRAST = 7,
};

typedef struct patchy_engine_curve_point {
  int32_t input;
  int32_t output;
} patchy_engine_curve_point;

typedef struct patchy_engine_adjustment_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  uint64_t layer_id;
  const char *name;
  size_t name_size;
  uint32_t kind;
  int32_t values[8];
  const patchy_engine_curve_point *curve_points;
  size_t curve_point_count;
  uint8_t update_existing;
} patchy_engine_adjustment_input;

typedef struct patchy_engine_adjustment_projection {
  uint32_t struct_size;
  uint32_t kind;
  int32_t values[8];
  size_t curve_point_count;
} patchy_engine_adjustment_projection;

enum patchy_engine_smart_filter_kind {
  PATCHY_ENGINE_SMART_FILTER_GAUSSIAN_BLUR = 1,
  PATCHY_ENGINE_SMART_FILTER_HIGH_PASS = 2,
  PATCHY_ENGINE_SMART_FILTER_MEDIAN = 3,
  PATCHY_ENGINE_SMART_FILTER_MOSAIC = 4,
  PATCHY_ENGINE_SMART_FILTER_BOX_BLUR = 5,
};

typedef struct patchy_engine_smart_filter_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  uint64_t layer_id;
  uint32_t kind;
  double amount;
  uint8_t enabled;
} patchy_engine_smart_filter_input;

typedef struct patchy_engine_smart_filter_projection {
  uint32_t struct_size;
  size_t entry_count;
  uint32_t first_kind;
  double first_amount;
  uint8_t enabled;
} patchy_engine_smart_filter_projection;

typedef int (*patchy_engine_render_progress_fn)(int32_t completed,
                                                int32_t total,
                                                void *user_data);
typedef int (*patchy_engine_save_progress_fn)(uint32_t phase,
                                              uint64_t logical_output_bytes,
                                              void *user_data);
typedef int (*patchy_engine_filter_progress_fn)(int32_t completed,
                                                int32_t total,
                                                uint32_t stage,
                                                void *user_data);

typedef struct patchy_engine_alpha_channel_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const uint8_t *gray;
  size_t gray_size;
  const char *name;
  size_t name_size;
} patchy_engine_alpha_channel_input;

enum patchy_engine_path_kind {
  PATCHY_ENGINE_PATH_SAVED = 0,
  PATCHY_ENGINE_PATH_WORK = 1,
};

enum patchy_engine_path_combine {
  PATCHY_ENGINE_PATH_XOR = 0,
  PATCHY_ENGINE_PATH_ADD = 1,
  PATCHY_ENGINE_PATH_SUBTRACT = 2,
  PATCHY_ENGINE_PATH_INTERSECT = 3,
};

enum patchy_engine_selection_combine {
  PATCHY_ENGINE_SELECTION_REPLACE = 0,
  PATCHY_ENGINE_SELECTION_ADD = 1,
  PATCHY_ENGINE_SELECTION_SUBTRACT = 2,
  PATCHY_ENGINE_SELECTION_INTERSECT = 3,
};

typedef struct patchy_engine_path_anchor {
  double anchor_x;
  double anchor_y;
  double in_x;
  double in_y;
  double out_x;
  double out_y;
  uint8_t smooth;
} patchy_engine_path_anchor;

typedef struct patchy_engine_path_subpath_input {
  size_t first_anchor;
  size_t anchor_count;
  int32_t shape_group;
  uint32_t combine;
  uint8_t closed;
} patchy_engine_path_subpath_input;

typedef struct patchy_engine_path_input {
  const patchy_engine_path_subpath_input *subpaths;
  size_t subpath_count;
  const patchy_engine_path_anchor *anchors;
  size_t anchor_count;
} patchy_engine_path_input;

typedef struct patchy_engine_vector_mask_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  uint64_t layer_id;
  patchy_engine_path_input path;
  double feather;
  uint8_t density;
  uint8_t disabled;
  uint8_t inverted;
  uint8_t unlinked;
  uint8_t hides_effects;
  uint8_t has_mask;
} patchy_engine_vector_mask_input;

typedef struct patchy_engine_vector_mask_projection {
  uint32_t struct_size;
  size_t subpath_count;
  size_t anchor_count;
  double feather;
  uint8_t density;
  uint8_t disabled;
  uint8_t inverted;
  uint8_t unlinked;
  uint8_t hides_effects;
} patchy_engine_vector_mask_projection;

typedef struct patchy_engine_document_path_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const char *name;
  size_t name_size;
  uint32_t kind;
  uint8_t clipping;
  patchy_engine_path_input path;
} patchy_engine_document_path_input;

typedef struct patchy_engine_vector_shape_input {
  uint32_t struct_size;
  uint64_t expected_state_id;
  uint64_t expected_revision;
  const char *name;
  size_t name_size;
  patchy_engine_path_input path;
  uint8_t fill_red;
  uint8_t fill_green;
  uint8_t fill_blue;
  uint8_t stroke_enabled;
  uint8_t stroke_red;
  uint8_t stroke_green;
  uint8_t stroke_blue;
  double stroke_width;
} patchy_engine_vector_shape_input;

typedef struct patchy_engine_document_path_projection {
  uint64_t id;
  uint32_t kind;
  uint32_t name_size;
  char name[256];
  size_t subpath_count;
  size_t anchor_count;
  uint8_t clipping;
} patchy_engine_document_path_projection;

typedef struct patchy_engine_path_subpath_projection {
  size_t anchor_count;
  int32_t shape_group;
  uint32_t combine;
  uint8_t closed;
} patchy_engine_path_subpath_projection;

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
  PATCHY_ENGINE_COMMAND_SELECT_ALL = 17,
  PATCHY_ENGINE_COMMAND_CLEAR_SELECTION = 18,
  PATCHY_ENGINE_COMMAND_INVERT_SELECTION = 19,
  PATCHY_ENGINE_COMMAND_EXPAND_SELECTION = 20,
  PATCHY_ENGINE_COMMAND_CONTRACT_SELECTION = 21,
  PATCHY_ENGINE_COMMAND_BORDER_SELECTION = 22,
  PATCHY_ENGINE_COMMAND_SELECT_CHANNEL = 23,
  PATCHY_ENGINE_COMMAND_RENAME_CHANNEL = 24,
  PATCHY_ENGINE_COMMAND_INVERT_CHANNEL = 25,
  PATCHY_ENGINE_COMMAND_REMOVE_CHANNEL = 26,
  PATCHY_ENGINE_COMMAND_MOVE_CHANNEL = 27,
  PATCHY_ENGINE_COMMAND_SELECT_DOCUMENT_PATH = 28,
  PATCHY_ENGINE_COMMAND_RENAME_DOCUMENT_PATH = 29,
  PATCHY_ENGINE_COMMAND_REMOVE_DOCUMENT_PATH = 30,
  PATCHY_ENGINE_COMMAND_MOVE_DOCUMENT_PATH = 31,
  PATCHY_ENGINE_COMMAND_SET_CLIPPING_PATH = 32,
  PATCHY_ENGINE_COMMAND_GROW_SELECTION = 33,
  PATCHY_ENGINE_COMMAND_SELECT_SIMILAR = 34,
  PATCHY_ENGINE_COMMAND_SET_LAYER_STYLE_PRESET = 35,
  PATCHY_ENGINE_COMMAND_SET_ESSENTIAL_LAYER_STYLE = 36,
};

typedef struct patchy_engine_command {
  uint32_t struct_size;
  uint32_t protocol_version;
  uint32_t type;
  uint32_t flags;
  uint64_t expected_state_id;
  uint64_t expected_revision;
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
    struct {
      int32_t pixels;
    } selection_radius;
    struct {
      int32_t tolerance;
    } selection_tolerance;
    struct {
      uint64_t layer_id;
      uint32_t preset_id_size;
      char preset_id[64];
    } set_layer_style_preset;
    struct {
      uint64_t layer_id;
      uint32_t effects_visible;
      uint32_t layer_mask_hides_effects;
      uint32_t drop_shadow_present;
      uint32_t drop_shadow_enabled;
      uint32_t drop_shadow_blend_mode;
      uint32_t drop_shadow_rgb;
      float drop_shadow_opacity;
      float drop_shadow_angle;
      float drop_shadow_distance;
      float drop_shadow_spread;
      float drop_shadow_size;
      uint32_t drop_shadow_layer_conceals;
      uint32_t color_overlay_present;
      uint32_t color_overlay_enabled;
      uint32_t color_overlay_blend_mode;
      uint32_t color_overlay_rgb;
      float color_overlay_opacity;
      uint32_t stroke_present;
      uint32_t stroke_enabled;
      uint32_t stroke_blend_mode;
      uint32_t stroke_rgb;
      float stroke_opacity;
      float stroke_size;
      uint32_t stroke_position;
      uint32_t stroke_overprint;
      uint32_t inner_shadow_present;
      uint32_t inner_shadow_enabled;
      uint32_t inner_shadow_blend_mode;
      uint32_t inner_shadow_rgb;
      float inner_shadow_opacity;
      float inner_shadow_angle;
      float inner_shadow_distance;
      float inner_shadow_choke;
      float inner_shadow_size;
      uint32_t outer_glow_present;
      uint32_t outer_glow_enabled;
      uint32_t outer_glow_blend_mode;
      uint32_t outer_glow_rgb;
      float outer_glow_opacity;
      float outer_glow_spread;
      float outer_glow_size;
      uint32_t outer_glow_technique;
      float outer_glow_range;
      uint32_t inner_glow_present;
      uint32_t inner_glow_enabled;
      uint32_t inner_glow_blend_mode;
      uint32_t inner_glow_rgb;
      float inner_glow_opacity;
      float inner_glow_choke;
      float inner_glow_size;
      uint32_t inner_glow_source;
      uint32_t inner_glow_technique;
      float inner_glow_range;
      uint32_t satin_present;
      uint32_t satin_enabled;
      uint32_t satin_blend_mode;
      uint32_t satin_rgb;
      float satin_opacity;
      float satin_angle;
      float satin_distance;
      float satin_size;
      uint32_t satin_invert;
    } set_essential_layer_style;
    struct {
      uint64_t channel_id;
    } select_channel;
    struct {
      uint64_t channel_id;
      uint32_t name_size;
      char name[256];
    } rename_channel;
    struct {
      uint64_t channel_id;
    } invert_channel;
    struct {
      uint64_t channel_id;
    } remove_channel;
    struct {
      uint64_t channel_id;
      size_t final_index;
    } move_channel;
    struct {
      uint64_t path_id;
      double feather;
      uint32_t combine;
      uint8_t antialias;
    } select_document_path;
    struct {
      uint64_t path_id;
      uint32_t name_size;
      char name[256];
    } rename_document_path;
    struct {
      uint64_t path_id;
    } remove_document_path;
    struct {
      uint64_t path_id;
      size_t final_index;
    } move_document_path;
    struct {
      uint64_t path_id;
      uint8_t clipping;
    } set_clipping_path;
  } payload;
} patchy_engine_command;

enum patchy_engine_event_kind {
  PATCHY_ENGINE_EVENT_COMMAND_APPLIED = 0,
  PATCHY_ENGINE_EVENT_SELECTION_CHANGED = 1,
  PATCHY_ENGINE_EVENT_PREVIEW_STARTED = 2,
  PATCHY_ENGINE_EVENT_PREVIEW_UPDATED = 3,
  PATCHY_ENGINE_EVENT_PREVIEW_ENDED = 4,
  PATCHY_ENGINE_EVENT_UNDO_APPLIED = 5,
  PATCHY_ENGINE_EVENT_REDO_APPLIED = 6,
  PATCHY_ENGINE_EVENT_SAVED = 7,
};

typedef struct patchy_engine_event {
  uint32_t struct_size;
  uint32_t protocol_version;
  uint32_t kind;
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
patchy_engine_cancellation *patchy_engine_cancellation_create(
    patchy_engine_error *error);
void patchy_engine_cancellation_cancel(patchy_engine_cancellation *cancellation);
void patchy_engine_cancellation_destroy(
    patchy_engine_cancellation *cancellation);

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
int patchy_engine_session_selection(
    const patchy_engine_session *session,
    patchy_engine_selection_projection *selection,
    patchy_engine_error *error);
int patchy_engine_session_selection_rect_at(
    const patchy_engine_session *session, size_t index,
    patchy_engine_rect *rect, patchy_engine_error *error);
int patchy_engine_session_selection_display_rect_at(
    const patchy_engine_session *session, size_t index,
    patchy_engine_rect *rect, patchy_engine_error *error);
int patchy_engine_session_selection_mask(
    const patchy_engine_session *session, patchy_engine_buffer *gray,
    patchy_engine_error *error);
int patchy_engine_session_set_selection(
    patchy_engine_session *session,
    const patchy_engine_selection_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_set_selection_mask(
    patchy_engine_session *session,
    const patchy_engine_selection_mask_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_quick_select(
    patchy_engine_session *session,
    const patchy_engine_quick_select_input *input,
    patchy_engine_cancellation *cancellation,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_magnetic_lasso(
    patchy_engine_session *session,
    const patchy_engine_magnetic_lasso_input *input,
    patchy_engine_cancellation *cancellation,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_preview_selection_refinement(
    const patchy_engine_session *session,
    const patchy_engine_selection_refinement_input *input,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *bounds, patchy_engine_buffer *gray,
    patchy_engine_error *error);
int patchy_engine_session_apply_selection_refinement(
    patchy_engine_session *session,
    const patchy_engine_selection_refinement_input *input,
    patchy_engine_event *event, patchy_engine_error *error);

int patchy_engine_session_layer_count(const patchy_engine_session *session,
                                      size_t *count,
                                      patchy_engine_error *error);
int patchy_engine_session_layer_at(const patchy_engine_session *session,
                                   size_t index,
                                   patchy_engine_layer_projection *layer,
                                   patchy_engine_error *error);
int patchy_engine_session_essential_layer_style(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_essential_layer_style_projection *style,
    patchy_engine_error *error);
int patchy_engine_session_channel_count(const patchy_engine_session *session,
                                        size_t *count,
                                        patchy_engine_error *error);
int patchy_engine_session_channel_at(const patchy_engine_session *session,
                                     size_t index,
                                     patchy_engine_channel_projection *channel,
                                     patchy_engine_error *error);
int patchy_engine_session_channel_pixels(
    const patchy_engine_session *session, uint64_t channel_id,
    patchy_engine_buffer *gray, patchy_engine_error *error);
int patchy_engine_session_add_rgba8_layer(
    patchy_engine_session *session,
    const patchy_engine_pixel_layer_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_replace_rgba8_layer(
    patchy_engine_session *session,
    const patchy_engine_pixel_layer_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_replace_rgba8_layer_and_mask(
    patchy_engine_session *session,
    const patchy_engine_pixel_layer_input *pixels,
    const patchy_engine_layer_mask_input *mask,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_layer_rgba8_pixels(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_buffer *rgba, patchy_engine_error *error);
int patchy_engine_session_layer_thumbnail_rgba8(
    const patchy_engine_session *session, uint64_t layer_id,
    uint32_t maximum_edge, uint32_t *width, uint32_t *height,
    patchy_engine_buffer *rgba, patchy_engine_error *error);
int patchy_engine_session_set_layer_mask(
    patchy_engine_session *session,
    const patchy_engine_layer_mask_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_set_layer_mask_linked(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, uint64_t layer_id, uint8_t linked,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_layer_mask(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_layer_mask_projection *mask, patchy_engine_error *error);
int patchy_engine_session_layer_mask_pixels(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_buffer *gray, patchy_engine_error *error);
int patchy_engine_session_apply_filter(
    patchy_engine_session *session, const patchy_engine_filter_input *input,
    patchy_engine_filter_progress_fn progress, void *progress_user_data,
    patchy_engine_cancellation *cancellation, patchy_engine_event *event,
    patchy_engine_error *error);
int patchy_engine_session_add_text_layer(
    patchy_engine_session *session,
    const patchy_engine_text_layer_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_update_text_layer(
    patchy_engine_session *session, uint64_t layer_id,
    const patchy_engine_text_layer_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_text(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_text_projection *text, patchy_engine_error *error);
int patchy_engine_session_text_style_run_at(
    const patchy_engine_session *session, uint64_t layer_id, size_t index,
    patchy_engine_text_style_run *run, patchy_engine_error *error);
int patchy_engine_session_text_paragraph_run_at(
    const patchy_engine_session *session, uint64_t layer_id, size_t index,
    patchy_engine_text_paragraph_run *run, patchy_engine_error *error);
int patchy_engine_session_add_smart_object(
    patchy_engine_session *session,
    const patchy_engine_smart_object_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_replace_smart_object(
    patchy_engine_session *session, uint64_t layer_id,
    const patchy_engine_smart_object_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_smart_object(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_smart_object_projection *smart_object,
    patchy_engine_error *error);
int patchy_engine_session_smart_object_bytes(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_buffer *bytes, patchy_engine_error *error);
int patchy_engine_session_set_adjustment(
    patchy_engine_session *session,
    const patchy_engine_adjustment_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_adjustment(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_adjustment_projection *adjustment,
    patchy_engine_error *error);
int patchy_engine_session_adjustment_curve_point_at(
    const patchy_engine_session *session, uint64_t layer_id, size_t index,
    patchy_engine_curve_point *point, patchy_engine_error *error);
int patchy_engine_session_set_vector_mask(
    patchy_engine_session *session,
    const patchy_engine_vector_mask_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_vector_mask(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_vector_mask_projection *mask, patchy_engine_error *error);
int patchy_engine_session_set_smart_filter(
    patchy_engine_session *session,
    const patchy_engine_smart_filter_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_smart_filter(
    const patchy_engine_session *session, uint64_t layer_id,
    patchy_engine_smart_filter_projection *filter,
    patchy_engine_error *error);
int patchy_engine_session_add_alpha_channel(
    patchy_engine_session *session,
    const patchy_engine_alpha_channel_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_path_count(const patchy_engine_session *session,
                                     size_t *count,
                                     patchy_engine_error *error);
int patchy_engine_session_path_at(
    const patchy_engine_session *session, size_t index,
    patchy_engine_document_path_projection *path,
    patchy_engine_error *error);
int patchy_engine_session_path_subpath_at(
    const patchy_engine_session *session, uint64_t path_id, size_t index,
    patchy_engine_path_subpath_projection *subpath,
    patchy_engine_error *error);
int patchy_engine_session_path_anchor_at(
    const patchy_engine_session *session, uint64_t path_id,
    size_t subpath_index, size_t anchor_index,
    patchy_engine_path_anchor *anchor, patchy_engine_error *error);
int patchy_engine_session_add_document_path(
    patchy_engine_session *session,
    const patchy_engine_document_path_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_update_document_path(
    patchy_engine_session *session, uint64_t path_id,
    const patchy_engine_document_path_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_merge_visible_copy(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const char *name, size_t name_size,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_add_vector_shape(
    patchy_engine_session *session,
    const patchy_engine_vector_shape_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_update_vector_shape(
    patchy_engine_session *session, uint64_t layer_id,
    const patchy_engine_vector_shape_input *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_execute(patchy_engine_session *session,
                                  const patchy_engine_command *command,
                                  patchy_engine_event *event,
                                  patchy_engine_error *error);
int patchy_engine_session_set_layer_visibility(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, uint64_t layer_id, uint8_t visible,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_move_layer(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, uint64_t layer_id, uint64_t target_layer_id,
    uint32_t position, uint8_t has_target_layer, patchy_engine_event *event,
    patchy_engine_error *error);
int patchy_engine_session_group_layer(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, uint64_t layer_id, const char *name,
    size_t name_size, patchy_engine_event *event,
    patchy_engine_error *error);
int patchy_engine_session_edit_layers(
    patchy_engine_session *session,
    const patchy_engine_layer_batch_edit *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_remove_layers(
    patchy_engine_session *session, const patchy_engine_layer_batch *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_move_layers(
    patchy_engine_session *session, const patchy_engine_layer_batch *input,
    uint64_t target_layer_id, uint32_t position, uint8_t has_target_layer,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_group_layers(
    patchy_engine_session *session, const patchy_engine_layer_batch *input,
    const char *name, size_t name_size, patchy_engine_event *event,
    patchy_engine_error *error);
int patchy_engine_session_ungroup_layers(
    patchy_engine_session *session, const patchy_engine_layer_batch *input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_copy_layer(
    patchy_engine_session *target, uint64_t expected_target_state_id,
    uint64_t expected_target_revision, const patchy_engine_session *source,
    uint64_t expected_source_state_id, uint64_t expected_source_revision,
    uint64_t source_layer_id, patchy_engine_event *event,
    patchy_engine_error *error);
int patchy_engine_session_copy_layers(
    patchy_engine_session *target, uint64_t expected_target_state_id,
    uint64_t expected_target_revision, const patchy_engine_session *source,
    const patchy_engine_layer_batch *source_input,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_preview_layer_transform(
    const patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_layer_transform *transform,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error);
int patchy_engine_session_transform_layer(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_layer_transform *transform,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_preview_layers_transform(
    const patchy_engine_session *session,
    const patchy_engine_layer_batch_transform *transform,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error);
int patchy_engine_session_transform_layers(
    patchy_engine_session *session,
    const patchy_engine_layer_batch_transform *transform,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_arrange_layers(
    patchy_engine_session *session,
    const patchy_engine_layer_arrange *arrangement,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_preview_raster_stroke(
    const patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_raster_stroke *stroke,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error);
int patchy_engine_session_apply_raster_stroke(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_raster_stroke *stroke,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_preview_layer_mask_stroke(
    const patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_raster_stroke *stroke,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error);
int patchy_engine_session_apply_layer_mask_stroke(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_raster_stroke *stroke,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_preview_raster_fill(
    const patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_raster_fill *fill,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error);
int patchy_engine_session_apply_raster_fill(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_raster_fill *fill,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_preview_layer_warp(
    const patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_layer_warp *warp,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error);
int patchy_engine_session_warp_layer(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_layer_warp *warp,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_preview_liquify(
    const patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_liquify *liquify,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error);
int patchy_engine_session_apply_liquify(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision, const patchy_engine_liquify *liquify,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_apply_retouch_repair(
    patchy_engine_session *session, uint64_t expected_state_id,
    uint64_t expected_revision,
    const patchy_engine_retouch_repair *repair,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_undo(patchy_engine_session *session,
                               patchy_engine_event *event,
                               patchy_engine_error *error);
int patchy_engine_session_redo(patchy_engine_session *session,
                               patchy_engine_event *event,
                               patchy_engine_error *error);
int patchy_engine_session_memory_usage(
    const patchy_engine_session *session, patchy_engine_memory_usage *usage,
    patchy_engine_error *error);
int patchy_engine_session_pending_render_region(
    const patchy_engine_session *session, patchy_engine_rect *region,
    uint8_t *has_region, patchy_engine_error *error);
int patchy_engine_session_evict_oldest_undo(
    patchy_engine_session *session, uint8_t *evicted,
    patchy_engine_error *error);
int patchy_engine_session_render(patchy_engine_session *session,
                                 patchy_engine_rect region,
                                 patchy_engine_buffer *rgba,
                                 patchy_engine_event *event,
                                 patchy_engine_error *error);
int patchy_engine_session_render_region(
    patchy_engine_session *session, int32_t x, int32_t y, int32_t width,
    int32_t height, patchy_engine_buffer *rgba, patchy_engine_event *event,
    patchy_engine_error *error);
int patchy_engine_session_render_region_with_progress(
    patchy_engine_session *session, int32_t x, int32_t y, int32_t width,
    int32_t height, patchy_engine_render_progress_fn progress,
    void *progress_user_data, patchy_engine_cancellation *cancellation,
    patchy_engine_buffer *rgba, patchy_engine_event *event,
    patchy_engine_error *error);
int patchy_engine_session_render_with_progress(
    patchy_engine_session *session, patchy_engine_rect region,
    patchy_engine_render_progress_fn progress, void *progress_user_data,
    patchy_engine_cancellation *cancellation, patchy_engine_buffer *rgba,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_save_psd(patchy_engine_session *session,
                                   patchy_engine_buffer *psd,
                                   patchy_engine_event *event,
                                   patchy_engine_error *error);
int patchy_engine_session_save_psd_as(patchy_engine_session *session,
                                      uint8_t large_document,
                                      patchy_engine_buffer *psd,
                                      patchy_engine_event *event,
                                      patchy_engine_error *error);
int patchy_engine_session_save_psd_with_progress(
    patchy_engine_session *session, patchy_engine_save_progress_fn progress,
    void *progress_user_data, patchy_engine_cancellation *cancellation,
    patchy_engine_buffer *psd, patchy_engine_event *event,
    patchy_engine_error *error);
int patchy_engine_session_save_psd_as_with_progress(
    patchy_engine_session *session, uint8_t large_document,
    patchy_engine_save_progress_fn progress, void *progress_user_data,
    patchy_engine_cancellation *cancellation, patchy_engine_buffer *psd,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_event_count(const patchy_engine_session *session,
                                      size_t *count, uint64_t *dropped,
                                      patchy_engine_error *error);
int patchy_engine_session_pop_event(patchy_engine_session *session,
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
