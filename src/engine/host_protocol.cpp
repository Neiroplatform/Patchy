#include "engine/host_protocol.h"

#include "engine/document_session.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <span>
#include <string>
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

static_assert(static_cast<std::uint32_t>(patchy::ColorMode::RGB) ==
              PATCHY_ENGINE_COLOR_MODE_RGB);
static_assert(static_cast<std::uint32_t>(patchy::BitDepth::UInt8) ==
              PATCHY_ENGINE_BIT_DEPTH_UINT8);
static_assert(static_cast<std::uint32_t>(patchy::LayerKind::SmartObject) ==
              PATCHY_ENGINE_LAYER_SMART_OBJECT);
static_assert(static_cast<std::uint32_t>(patchy::BlendMode::Dissolve) ==
              PATCHY_ENGINE_BLEND_DISSOLVE);
static_assert(patchy::kLayerLockAll == PATCHY_ENGINE_LAYER_LOCK_ALL);
static_assert(static_cast<std::uint32_t>(patchy::LayerDropPosition::OnViewport) ==
              PATCHY_ENGINE_DROP_ON_VIEWPORT);

constexpr std::uint64_t kCapabilities =
    PATCHY_ENGINE_CAP_LAYER_PROJECTION |
    PATCHY_ENGINE_CAP_LAYER_VISIBILITY | PATCHY_ENGINE_CAP_HISTORY |
    PATCHY_ENGINE_CAP_BOUNDED_RENDER | PATCHY_ENGINE_CAP_PSD_SAVE |
    PATCHY_ENGINE_CAP_DOCUMENT_PROJECTION |
    PATCHY_ENGINE_CAP_LAYER_APPEARANCE |
    PATCHY_ENGINE_CAP_LAYER_LIFECYCLE |
    PATCHY_ENGINE_CAP_DOCUMENT_GEOMETRY |
    PATCHY_ENGINE_CAP_OPTIMISTIC_COMMANDS |
    PATCHY_ENGINE_CAP_SAVE_STATE;

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

patchy::EditColor edit_color(std::uint8_t red, std::uint8_t green,
                             std::uint8_t blue, std::uint8_t alpha) noexcept {
  return {red, green, blue, alpha};
}

bool valid_utf8(std::string_view text) noexcept {
  const auto continuation = [](unsigned char value) {
    return (value & 0xC0U) == 0x80U;
  };
  for (std::size_t index = 0; index < text.size();) {
    const auto first = static_cast<unsigned char>(text[index]);
    if (first <= 0x7FU) {
      ++index;
      continue;
    }
    if (first >= 0xC2U && first <= 0xDFU && index + 1U < text.size() &&
        continuation(static_cast<unsigned char>(text[index + 1U]))) {
      index += 2U;
      continue;
    }
    if (index + 2U < text.size()) {
      const auto second = static_cast<unsigned char>(text[index + 1U]);
      const auto third = static_cast<unsigned char>(text[index + 2U]);
      if (((first == 0xE0U && second >= 0xA0U && second <= 0xBFU) ||
           ((first >= 0xE1U && first <= 0xECU) && continuation(second)) ||
           (first == 0xEDU && second >= 0x80U && second <= 0x9FU) ||
           ((first >= 0xEEU && first <= 0xEFU) && continuation(second))) &&
          continuation(third)) {
        index += 3U;
        continue;
      }
    }
    if (index + 3U < text.size()) {
      const auto second = static_cast<unsigned char>(text[index + 1U]);
      const auto third = static_cast<unsigned char>(text[index + 2U]);
      const auto fourth = static_cast<unsigned char>(text[index + 3U]);
      if (((first == 0xF0U && second >= 0x90U && second <= 0xBFU) ||
           ((first >= 0xF1U && first <= 0xF3U) && continuation(second)) ||
           (first == 0xF4U && second >= 0x80U && second <= 0x8FU)) &&
          continuation(third) && continuation(fourth)) {
        index += 4U;
        continue;
      }
    }
    return false;
  }
  return true;
}

bool copy_command_text(const char *source, std::uint32_t size,
                       std::size_t capacity, std::string &destination,
                       patchy_engine_error *error) {
  if (size == 0 || size >= capacity) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "command text length is invalid");
    return false;
  }
  if (std::memchr(source, '\0', size) != nullptr) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "command text contains an embedded null byte");
    return false;
  }
  if (!valid_utf8(std::string_view(source, size))) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "command text is not valid UTF-8");
    return false;
  }
  destination.assign(source, source + size);
  return true;
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

patchy_engine_session *patchy_engine_session_create_rgba8(
    patchy_engine_runtime *runtime, std::int32_t width, std::int32_t height,
    patchy_engine_error *error) {
  clear_error(error);
  if (runtime == nullptr || width <= 0 || height <= 0) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "runtime and positive document dimensions are required");
    return nullptr;
  }
  try {
    return new patchy_engine_session{std::make_unique<DocumentSession>(
        patchy::Document(width, height, patchy::PixelFormat::rgba8()))};
  } catch (const std::bad_alloc &) {
    fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
         "could not allocate engine session");
  } catch (const std::exception &exception) {
    fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
         "unknown document creation failure");
  }
  return nullptr;
}

void patchy_engine_session_destroy(patchy_engine_session *session) {
  delete session;
}

int patchy_engine_session_document(
    const patchy_engine_session *session,
    patchy_engine_document_projection *document,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || document == nullptr ||
      document->struct_size != sizeof(*document)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and a complete document projection are required");
  }
  try {
    const auto &source = session->value->document();
    const auto format = source.format();
    const auto active_layer = source.active_layer_id();
    const auto layer_count = session->value->layers().size();
    *document = {};
    document->struct_size = sizeof(*document);
    document->width = source.width();
    document->height = source.height();
    document->color_mode = static_cast<std::uint32_t>(format.color_mode);
    document->bit_depth = static_cast<std::uint32_t>(format.bit_depth);
    document->channels = format.channels;
    document->active_layer_id = active_layer.value_or(0);
    document->revision = session->value->revision();
    document->state_id = session->value->state_id();
    document->layer_count = layer_count;
    document->has_active_layer = active_layer.has_value() ? 1U : 0U;
    document->dirty = session->value->dirty() ? 1U : 0U;
    document->can_undo = session->value->can_undo() ? 1U : 0U;
    document->can_redo = session->value->can_redo() ? 1U : 0U;
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown document projection failure");
  }
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
    const auto *document_layer =
        session->value->document().find_layer(source.id);
    if (document_layer == nullptr) {
      return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                  "projected layer is missing from the document");
    }
    auto count = std::min(source.name.size(), sizeof(layer->name) - 1U);
    while (count > 0 && count < source.name.size() &&
           (static_cast<unsigned char>(source.name[count]) & 0xC0U) == 0x80U) {
      --count;
    }
    std::memcpy(layer->name, source.name.data(), count);
    layer->name[count] = '\0';
    layer->name_size = static_cast<std::uint32_t>(count);
    layer->clipped = document_layer->clipped() ? 1U : 0U;
    layer->fill_opacity = document_layer->fill_opacity();
    layer->blend_mode =
        static_cast<std::uint32_t>(document_layer->blend_mode());
    layer->lock_flags = document_layer->lock_flags();
    const auto bounds = document_layer->bounds();
    layer->bounds = {bounds.x, bounds.y, bounds.width, bounds.height};
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
  if (command->flags != 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "command flags are unsupported");
  }
  if (command->expected_state_id == 0 ||
      command->expected_state_id != session->value->state_id()) {
    return fail(error, PATCHY_ENGINE_ERROR_STALE_STATE,
                "command was prepared from a stale document state");
  }
  try {
    CommandResult result;
    switch (command->type) {
    case PATCHY_ENGINE_COMMAND_SET_LAYER_VISIBILITY:
      result = session->value->execute(patchy::engine::SetLayerVisibility{
          command->payload.set_layer_visibility.layer_id,
          command->payload.set_layer_visibility.visible != 0});
      break;
    case PATCHY_ENGINE_COMMAND_SET_LAYER_OPACITY:
      result = session->value->execute(patchy::engine::SetLayerOpacity{
          command->payload.set_layer_opacity.layer_id,
          command->payload.set_layer_opacity.opacity});
      break;
    case PATCHY_ENGINE_COMMAND_SET_LAYER_FILL_OPACITY:
      result = session->value->execute(patchy::engine::SetLayerFillOpacity{
          command->payload.set_layer_fill_opacity.layer_id,
          command->payload.set_layer_fill_opacity.opacity});
      break;
    case PATCHY_ENGINE_COMMAND_SET_LAYER_BLEND_MODE:
      if (command->payload.set_layer_blend_mode.blend_mode >
          static_cast<std::uint32_t>(patchy::BlendMode::Dissolve)) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "blend mode is unsupported");
      }
      result = session->value->execute(patchy::engine::SetLayerBlendMode{
          command->payload.set_layer_blend_mode.layer_id,
          static_cast<patchy::BlendMode>(
              command->payload.set_layer_blend_mode.blend_mode)});
      break;
    case PATCHY_ENGINE_COMMAND_RENAME_LAYER: {
      std::string name;
      if (!copy_command_text(command->payload.rename_layer.name,
                             command->payload.rename_layer.name_size,
                             sizeof(command->payload.rename_layer.name), name,
                             error)) {
        return 0;
      }
      result = session->value->execute(patchy::engine::RenameLayer{
          command->payload.rename_layer.layer_id, std::move(name)});
      break;
    }
    case PATCHY_ENGINE_COMMAND_SET_LAYER_LOCKS:
      if ((command->payload.set_layer_locks.lock_flags &
           ~patchy::kLayerLockAll) != 0U) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "layer lock flags are unsupported");
      }
      result = session->value->execute(patchy::engine::SetLayerLockStates{{
          {command->payload.set_layer_locks.layer_id,
           command->payload.set_layer_locks.lock_flags}}});
      break;
    case PATCHY_ENGINE_COMMAND_SET_LAYER_CLIPPING:
      result = session->value->execute(patchy::engine::SetLayerClipping{
          command->payload.set_layer_clipping.layer_id,
          command->payload.set_layer_clipping.clipped != 0});
      break;
    case PATCHY_ENGINE_COMMAND_ADD_SOLID_LAYER: {
      std::string name;
      if (!copy_command_text(command->payload.add_solid_layer.name,
                             command->payload.add_solid_layer.name_size,
                             sizeof(command->payload.add_solid_layer.name),
                             name, error)) {
        return 0;
      }
      const auto &document = session->value->document();
      const auto format = document.format();
      if (format.color_mode != patchy::ColorMode::RGB ||
          format.bit_depth != patchy::BitDepth::UInt8) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "solid layers require an RGB8 document");
      }
      patchy::PixelBuffer pixels(document.width(), document.height(),
                                 patchy::PixelFormat::rgba8());
      for (std::int32_t y = 0; y < pixels.height(); ++y) {
        for (std::int32_t x = 0; x < pixels.width(); ++x) {
          auto *pixel = pixels.pixel(x, y);
          pixel[0] = command->payload.add_solid_layer.red;
          pixel[1] = command->payload.add_solid_layer.green;
          pixel[2] = command->payload.add_solid_layer.blue;
          pixel[3] = command->payload.add_solid_layer.alpha;
        }
      }
      result = session->value->execute(
          patchy::engine::AddPixelLayer{std::move(name), std::move(pixels)});
      break;
    }
    case PATCHY_ENGINE_COMMAND_REMOVE_LAYER:
      result = session->value->execute(patchy::engine::RemoveLayers{
          {command->payload.remove_layer.layer_id}});
      break;
    case PATCHY_ENGINE_COMMAND_RESIZE_IMAGE:
      result = session->value->execute(patchy::engine::ResizeImage{
          command->payload.resize_image.width,
          command->payload.resize_image.height});
      break;
    case PATCHY_ENGINE_COMMAND_RESIZE_CANVAS:
      if (command->payload.resize_canvas.anchor >
          PATCHY_ENGINE_ANCHOR_BOTTOM_RIGHT) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "canvas anchor is unsupported");
      }
      result = session->value->execute(patchy::engine::ResizeCanvas{
          command->payload.resize_canvas.width,
          command->payload.resize_canvas.height,
          static_cast<patchy::CanvasAnchor>(
              command->payload.resize_canvas.anchor),
          edit_color(command->payload.resize_canvas.red,
                     command->payload.resize_canvas.green,
                     command->payload.resize_canvas.blue,
                     command->payload.resize_canvas.alpha)});
      break;
    case PATCHY_ENGINE_COMMAND_ROTATE_CANVAS:
      result = session->value->execute(patchy::engine::RotateCanvas{
          command->payload.rotate_canvas.clockwise_degrees,
          edit_color(command->payload.rotate_canvas.red,
                     command->payload.rotate_canvas.green,
                     command->payload.rotate_canvas.blue,
                     command->payload.rotate_canvas.alpha)});
      break;
    case PATCHY_ENGINE_COMMAND_CROP_DOCUMENT: {
      const auto crop = command->payload.crop_document.crop;
      result = session->value->execute(patchy::engine::CropDocument{
          {crop.x, crop.y, crop.width, crop.height},
          command->payload.crop_document.clockwise_degrees,
          edit_color(command->payload.crop_document.red,
                     command->payload.crop_document.green,
                     command->payload.crop_document.blue,
                     command->payload.crop_document.alpha),
          command->payload.crop_document.clip_to_canvas != 0});
      break;
    }
    case PATCHY_ENGINE_COMMAND_ADD_GROUP: {
      std::string name;
      if (!copy_command_text(command->payload.add_group.name,
                             command->payload.add_group.name_size,
                             sizeof(command->payload.add_group.name), name,
                             error)) {
        return 0;
      }
      result = session->value->execute(
          patchy::engine::AddGroup{std::move(name), {}});
      break;
    }
    case PATCHY_ENGINE_COMMAND_MOVE_LAYER:
      if (command->payload.move_layer.position >
          PATCHY_ENGINE_DROP_ON_VIEWPORT) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "layer drop position is unsupported");
      }
      result = session->value->execute(patchy::engine::MoveLayers{
          {command->payload.move_layer.layer_id},
          command->payload.move_layer.has_target_layer != 0
              ? std::optional<patchy::LayerId>{
                    command->payload.move_layer.target_layer_id}
              : std::nullopt,
          static_cast<patchy::LayerDropPosition>(
              command->payload.move_layer.position)});
      break;
    case PATCHY_ENGINE_COMMAND_UNGROUP:
      result = session->value->execute(
          patchy::engine::UngroupLayers{{command->payload.ungroup.group_id}});
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

int patchy_engine_session_mark_saved(patchy_engine_session *session,
                                     std::uint64_t expected_state_id,
                                     patchy_engine_event *event,
                                     patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  if (expected_state_id == 0 ||
      expected_state_id != session->value->state_id()) {
    return fail(error, PATCHY_ENGINE_ERROR_STALE_STATE,
                "save acknowledgement refers to a stale document state");
  }
  try {
    session->value->mark_saved();
    publish_event(*session->value, CommandResult{}, event);
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown save acknowledgement failure");
  }
}

void patchy_engine_buffer_release(patchy_engine_buffer *buffer) {
  if (buffer != nullptr) {
    std::free(buffer->data);
    *buffer = {};
  }
}

} // extern "C"
