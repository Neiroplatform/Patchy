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
};

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

typedef int (*patchy_engine_transform_progress_fn)(int32_t completed_rows,
                                                   int32_t total_rows,
                                                   void *user_data);

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

int patchy_engine_session_layer_count(const patchy_engine_session *session,
                                      size_t *count,
                                      patchy_engine_error *error);
int patchy_engine_session_layer_at(const patchy_engine_session *session,
                                   size_t index,
                                   patchy_engine_layer_projection *layer,
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
int patchy_engine_session_set_layer_mask(
    patchy_engine_session *session,
    const patchy_engine_layer_mask_input *input,
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
int patchy_engine_session_copy_layer(
    patchy_engine_session *target, uint64_t expected_target_state_id,
    uint64_t expected_target_revision, const patchy_engine_session *source,
    uint64_t expected_source_state_id, uint64_t expected_source_revision,
    uint64_t source_layer_id, patchy_engine_event *event,
    patchy_engine_error *error);
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
int patchy_engine_session_render_with_progress(
    patchy_engine_session *session, patchy_engine_rect region,
    patchy_engine_render_progress_fn progress, void *progress_user_data,
    patchy_engine_cancellation *cancellation, patchy_engine_buffer *rgba,
    patchy_engine_event *event, patchy_engine_error *error);
int patchy_engine_session_save_psd(patchy_engine_session *session,
                                   patchy_engine_buffer *psd,
                                   patchy_engine_event *event,
                                   patchy_engine_error *error);
int patchy_engine_session_save_psd_with_progress(
    patchy_engine_session *session, patchy_engine_save_progress_fn progress,
    void *progress_user_data, patchy_engine_cancellation *cancellation,
    patchy_engine_buffer *psd, patchy_engine_event *event,
    patchy_engine_error *error);
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
