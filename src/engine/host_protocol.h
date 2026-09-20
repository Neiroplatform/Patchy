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
};

enum patchy_engine_error_code {
  PATCHY_ENGINE_ERROR_NONE = 0,
  PATCHY_ENGINE_ERROR_INVALID_ARGUMENT = 1,
  PATCHY_ENGINE_ERROR_UNSUPPORTED_VERSION = 2,
  PATCHY_ENGINE_ERROR_ENGINE = 3,
  PATCHY_ENGINE_ERROR_ALLOCATION = 4,
  PATCHY_ENGINE_ERROR_INTERNAL = 5,
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

typedef struct patchy_engine_layer_projection {
  uint64_t id;
  uint64_t parent_id;
  uint32_t kind;
  uint8_t visible;
  float opacity;
  uint32_t name_size;
  char name[256];
} patchy_engine_layer_projection;

enum patchy_engine_command_type {
  PATCHY_ENGINE_COMMAND_SET_LAYER_VISIBILITY = 1,
};

typedef struct patchy_engine_command {
  uint32_t struct_size;
  uint32_t protocol_version;
  uint32_t type;
  uint32_t reserved;
  union {
    struct {
      uint64_t layer_id;
      uint8_t visible;
    } set_layer_visibility;
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
void patchy_engine_session_destroy(patchy_engine_session *session);

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
void patchy_engine_buffer_release(patchy_engine_buffer *buffer);

#ifdef __cplusplus
}
#endif
