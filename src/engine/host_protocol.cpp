#include "engine/host_protocol.h"

#include "engine/document_session.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <span>
#include <string_view>

struct patchy_engine_runtime {
  std::uint32_t protocol_version{PATCHY_ENGINE_HOST_PROTOCOL_VERSION};
};

struct patchy_engine_session {
  std::unique_ptr<patchy::engine::DocumentSession> value;
};

namespace {

using patchy::engine::CommandResult;
using patchy::engine::DocumentSession;
using patchy::engine::SessionError;

constexpr std::uint64_t kCapabilities =
    PATCHY_ENGINE_CAP_LAYER_PROJECTION |
    PATCHY_ENGINE_CAP_LAYER_VISIBILITY | PATCHY_ENGINE_CAP_HISTORY |
    PATCHY_ENGINE_CAP_BOUNDED_RENDER | PATCHY_ENGINE_CAP_PSD_SAVE;

void clear_error(patchy_engine_error *error) noexcept {
  if (error != nullptr) {
    *error = {};
  }
}

int fail(patchy_engine_error *error, std::uint32_t code,
         std::string_view message) noexcept {
  if (error != nullptr) {
    error->code = code;
    const auto count = std::min(message.size(), sizeof(error->message) - 1U);
    std::memcpy(error->message, message.data(), count);
    error->message[count] = '\0';
  }
  return 0;
}

int fail(patchy_engine_error *error, const SessionError &session_error) noexcept {
  return fail(error, PATCHY_ENGINE_ERROR_ENGINE, session_error.message);
}

void publish_event(const DocumentSession &session, const CommandResult &result,
                   patchy_engine_event *event) noexcept {
  if (event == nullptr) {
    return;
  }
  *event = {};
  event->struct_size = sizeof(*event);
  event->protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  event->revision = session.revision();
  event->state_id = session.state_id();
  event->affected_layer_id = result.affected_layer_id;
  event->changed = result.changed ? 1U : 0U;
  event->dirty = session.dirty() ? 1U : 0U;
  if (result.affected_region.has_value()) {
    event->has_affected_region = 1U;
    event->affected_region = {result.affected_region->x,
                              result.affected_region->y,
                              result.affected_region->width,
                              result.affected_region->height};
  }
}

int copy_buffer(std::span<const std::uint8_t> source,
                patchy_engine_buffer *destination,
                patchy_engine_error *error) noexcept {
  if (destination == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "output buffer is required");
  }
  if (destination->data != nullptr || destination->size != 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "output buffer must be zero-initialized");
  }
  *destination = {};
  if (source.empty()) {
    return 1;
  }
  auto *data = static_cast<std::uint8_t *>(std::malloc(source.size()));
  if (data == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate output buffer");
  }
  std::memcpy(data, source.data(), source.size());
  destination->data = data;
  destination->size = source.size();
  return 1;
}

template <typename Operation>
int history_operation(patchy_engine_session *session, patchy_engine_event *event,
                      patchy_engine_error *error, Operation operation) noexcept {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  try {
    const auto result = operation(*session->value);
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown engine failure");
  }
}

} // namespace

extern "C" {

int patchy_engine_get_protocol_info(patchy_engine_protocol_info *info,
                                    patchy_engine_error *error) {
  clear_error(error);
  if (info == nullptr || info->struct_size != sizeof(*info)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "protocol info has an invalid struct size");
  }
  info->protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  info->capabilities = kCapabilities;
  return 1;
}

patchy_engine_runtime *patchy_engine_runtime_create(
    std::uint32_t requested_version, patchy_engine_error *error) {
  clear_error(error);
  if (requested_version != PATCHY_ENGINE_HOST_PROTOCOL_VERSION) {
    fail(error, PATCHY_ENGINE_ERROR_UNSUPPORTED_VERSION,
         "unsupported Patchy engine host protocol version");
    return nullptr;
  }
  try {
    return new patchy_engine_runtime{};
  } catch (const std::bad_alloc &) {
    fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
         "could not allocate engine runtime");
  } catch (...) {
    fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
         "unknown engine runtime failure");
  }
  return nullptr;
}

void patchy_engine_runtime_destroy(patchy_engine_runtime *runtime) {
  delete runtime;
}

patchy_engine_session *patchy_engine_session_open_psd(
    patchy_engine_runtime *runtime, const std::uint8_t *data, std::size_t size,
    patchy_engine_error *error) {
  clear_error(error);
  if (runtime == nullptr || data == nullptr || size == 0) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "runtime and non-empty PSD bytes are required");
    return nullptr;
  }
  try {
    auto opened = patchy::engine::open_psd({data, size});
    if (!opened) {
      fail(error, opened.error);
      return nullptr;
    }
    return new patchy_engine_session{std::move(opened.session)};
  } catch (const std::bad_alloc &) {
    fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
         "could not allocate engine session");
  } catch (const std::exception &exception) {
    fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    fail(error, PATCHY_ENGINE_ERROR_INTERNAL, "unknown PSD open failure");
  }
  return nullptr;
}

void patchy_engine_session_destroy(patchy_engine_session *session) {
  delete session;
}

int patchy_engine_session_layer_count(const patchy_engine_session *session,
                                      std::size_t *count,
                                      patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || count == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and layer count output are required");
  }
  try {
    *count = session->value->layers().size();
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer projection failure");
  }
}

int patchy_engine_session_layer_at(const patchy_engine_session *session,
                                   std::size_t index,
                                   patchy_engine_layer_projection *layer,
                                   patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || layer == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and layer output are required");
  }
  try {
    const auto layers = session->value->layers();
    if (index >= layers.size()) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "layer index is outside the projection");
    }
    const auto &source = layers[index];
    *layer = {};
    layer->id = source.id;
    layer->parent_id = source.parent_id;
    layer->kind = static_cast<std::uint32_t>(source.kind);
    layer->visible = source.visible ? 1U : 0U;
    layer->opacity = source.opacity;
    auto count = std::min(source.name.size(), sizeof(layer->name) - 1U);
    while (count > 0 && count < source.name.size() &&
           (static_cast<unsigned char>(source.name[count]) & 0xC0U) == 0x80U) {
      --count;
    }
    std::memcpy(layer->name, source.name.data(), count);
    layer->name[count] = '\0';
    layer->name_size = static_cast<std::uint32_t>(count);
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer projection failure");
  }
}

int patchy_engine_session_execute(patchy_engine_session *session,
                                  const patchy_engine_command *command,
                                  patchy_engine_event *event,
                                  patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || command == nullptr ||
      command->struct_size != sizeof(*command)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and a complete command envelope are required");
  }
  if (command->protocol_version != PATCHY_ENGINE_HOST_PROTOCOL_VERSION) {
    return fail(error, PATCHY_ENGINE_ERROR_UNSUPPORTED_VERSION,
                "command protocol version is unsupported");
  }
  try {
    CommandResult result;
    switch (command->type) {
    case PATCHY_ENGINE_COMMAND_SET_LAYER_VISIBILITY:
      result = session->value->execute(patchy::engine::SetLayerVisibility{
          command->payload.set_layer_visibility.layer_id,
          command->payload.set_layer_visibility.visible != 0});
      break;
    default:
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "command type is unsupported");
    }
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown command failure");
  }
}

int patchy_engine_session_undo(patchy_engine_session *session,
                               patchy_engine_event *event,
                               patchy_engine_error *error) {
  return history_operation(session, event, error,
                           [](DocumentSession &value) { return value.undo(); });
}

int patchy_engine_session_redo(patchy_engine_session *session,
                               patchy_engine_event *event,
                               patchy_engine_error *error) {
  return history_operation(session, event, error,
                           [](DocumentSession &value) { return value.redo(); });
}

int patchy_engine_session_render(patchy_engine_session *session,
                                 patchy_engine_rect region,
                                 patchy_engine_buffer *rgba,
                                 patchy_engine_event *event,
                                 patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || rgba == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and render output are required");
  }
  try {
    const auto rendered = session->value->render(
        {region.x, region.y, region.width, region.height});
    if (!rendered) {
      return fail(error, rendered.error);
    }
    if (!copy_buffer(rendered.pixels.data(), rgba, error)) {
      return 0;
    }
    publish_event(*session->value, CommandResult{}, event);
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown render failure");
  }
}

int patchy_engine_session_save_psd(patchy_engine_session *session,
                                   patchy_engine_buffer *psd,
                                   patchy_engine_event *event,
                                   patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || psd == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and save output are required");
  }
  try {
    const auto saved = session->value->encode_psd();
    if (!saved) {
      return fail(error, saved.error);
    }
    if (!copy_buffer(saved.bytes, psd, error)) {
      return 0;
    }
    publish_event(*session->value, CommandResult{}, event);
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown save failure");
  }
}

void patchy_engine_buffer_release(patchy_engine_buffer *buffer) {
  if (buffer != nullptr) {
    std::free(buffer->data);
    *buffer = {};
  }
}

} // extern "C"
