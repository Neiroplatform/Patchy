#include "engine/host_protocol.h"

#include "engine/document_session.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

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
static_assert(static_cast<std::uint32_t>(patchy::DocumentChannelKind::Spot) ==
              PATCHY_ENGINE_CHANNEL_SPOT);
static_assert(static_cast<std::uint32_t>(
                  patchy::DocumentChannelColorIndicates::SpotColor) ==
              PATCHY_ENGINE_CHANNEL_SPOT_COLOR);
static_assert(static_cast<std::uint32_t>(patchy::DocumentPathKind::Work) ==
              PATCHY_ENGINE_PATH_WORK);
static_assert(static_cast<std::uint32_t>(patchy::PathCombineOp::Intersect) ==
              PATCHY_ENGINE_PATH_INTERSECT);
static_assert(static_cast<std::uint32_t>(
                  patchy::engine::SelectionCombineMode::Intersect) ==
              PATCHY_ENGINE_SELECTION_INTERSECT);

constexpr std::uint64_t kCapabilities =
    PATCHY_ENGINE_CAP_LAYER_PROJECTION |
    PATCHY_ENGINE_CAP_LAYER_VISIBILITY | PATCHY_ENGINE_CAP_HISTORY |
    PATCHY_ENGINE_CAP_BOUNDED_RENDER | PATCHY_ENGINE_CAP_PSD_SAVE |
    PATCHY_ENGINE_CAP_DOCUMENT_PROJECTION |
    PATCHY_ENGINE_CAP_LAYER_APPEARANCE |
    PATCHY_ENGINE_CAP_LAYER_LIFECYCLE |
    PATCHY_ENGINE_CAP_DOCUMENT_GEOMETRY |
    PATCHY_ENGINE_CAP_OPTIMISTIC_COMMANDS |
    PATCHY_ENGINE_CAP_SAVE_STATE |
    PATCHY_ENGINE_CAP_SELECTION_PROJECTION |
    PATCHY_ENGINE_CAP_SAVED_CHANNELS |
    PATCHY_ENGINE_CAP_PIXEL_AUTHORING |
    PATCHY_ENGINE_CAP_PATH_PROJECTION |
    PATCHY_ENGINE_CAP_VECTOR_AUTHORING;

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

bool copy_command_text(const char *source, std::size_t size,
                       std::size_t capacity, std::string &destination,
                       patchy_engine_error *error) {
  if (source == nullptr || size == 0 || size >= capacity) {
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
  try {
    destination.assign(source, source + size);
    return true;
  } catch (const std::bad_alloc &) {
    fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
         "could not allocate command text");
  } catch (...) {
    fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
         "unknown command text failure");
  }
  return false;
}

bool expected_state(const patchy_engine_session *session,
                    std::uint64_t state_id, std::uint64_t revision,
                    patchy_engine_error *error) {
  if (state_id == 0 || state_id != session->value->state_id() ||
      revision != session->value->revision()) {
    fail(error, PATCHY_ENGINE_ERROR_STALE_STATE,
         "operation was prepared from a stale session projection");
    return false;
  }
  return true;
}

std::vector<patchy::Rect> rects_from_gray8(const patchy::PixelBuffer &pixels,
                                           std::uint8_t threshold) {
  std::vector<patchy::Rect> result;
  for (std::int32_t y = 0; y < pixels.height(); ++y) {
    const auto row = pixels.row(y);
    std::int32_t start = -1;
    for (std::int32_t x = 0; x <= pixels.width(); ++x) {
      const bool selected = x < pixels.width() &&
                            row[static_cast<std::size_t>(x)] >= threshold;
      if (selected && start < 0) {
        start = x;
      } else if (!selected && start >= 0) {
        result.push_back({start, y, x - start, 1});
        start = -1;
      }
    }
  }
  return result;
}

patchy::engine::SelectionSnapshot
selection_from_channel(const patchy::DocumentChannel &channel) {
  patchy::engine::SelectionSnapshot result;
  const auto &pixels = channel.pixels();
  result.selection = rects_from_gray8(pixels, 1U);
  result.display_region = rects_from_gray8(pixels, 128U);
  const bool partial = std::any_of(
      pixels.data().begin(), pixels.data().end(),
      [](std::uint8_t value) { return value != 0U && value != 255U; });
  if (partial && !result.selection.empty()) {
    result.mask_bounds =
        patchy::Rect::from_size(pixels.width(), pixels.height());
    result.mask_alpha = pixels;
  }
  return result;
}

std::optional<patchy::VectorPath>
vector_path_from_input(const patchy_engine_path_input &input,
                       patchy_engine_error *error) {
  if (input.subpaths == nullptr || input.subpath_count == 0 ||
      input.anchors == nullptr || input.anchor_count == 0) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "path requires subpaths and anchors");
    return std::nullopt;
  }
  try {
    patchy::VectorPath path;
    path.subpaths.reserve(input.subpath_count);
    for (std::size_t subpath_index = 0; subpath_index < input.subpath_count;
         ++subpath_index) {
      const auto &source = input.subpaths[subpath_index];
      if (source.combine > PATCHY_ENGINE_PATH_INTERSECT ||
          source.first_anchor > input.anchor_count ||
          source.anchor_count > input.anchor_count - source.first_anchor ||
          source.anchor_count < (source.closed != 0 ? 3U : 2U)) {
        fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
             "path subpath topology is invalid");
        return std::nullopt;
      }
      patchy::PathSubpath subpath;
      subpath.closed = source.closed != 0;
      subpath.op = static_cast<patchy::PathCombineOp>(source.combine);
      subpath.shape_group = source.shape_group;
      subpath.anchors.reserve(source.anchor_count);
      for (std::size_t anchor_index = 0; anchor_index < source.anchor_count;
           ++anchor_index) {
        const auto &anchor = input.anchors[source.first_anchor + anchor_index];
        if (!std::isfinite(anchor.anchor_x) ||
            !std::isfinite(anchor.anchor_y) || !std::isfinite(anchor.in_x) ||
            !std::isfinite(anchor.in_y) || !std::isfinite(anchor.out_x) ||
            !std::isfinite(anchor.out_y)) {
          fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
               "path anchor coordinates must be finite");
          return std::nullopt;
        }
        subpath.anchors.push_back(
            {anchor.anchor_x, anchor.anchor_y, anchor.in_x, anchor.in_y,
             anchor.out_x, anchor.out_y, anchor.smooth != 0});
      }
      path.subpaths.push_back(std::move(subpath));
    }
    return path;
  } catch (const std::bad_alloc &) {
    fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
         "could not allocate path payload");
  } catch (...) {
    fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
         "unknown path payload failure");
  }
  return std::nullopt;
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

int patchy_engine_session_selection(
    const patchy_engine_session *session,
    patchy_engine_selection_projection *selection,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || selection == nullptr ||
      selection->struct_size != sizeof(*selection)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and a complete selection projection are required");
  }
  const auto &source = session->value->selection();
  *selection = {};
  selection->struct_size = sizeof(*selection);
  selection->selection_rect_count = source.selection.size();
  selection->display_rect_count = source.display_region.size();
  selection->mask_bounds = {source.mask_bounds.x, source.mask_bounds.y,
                            source.mask_bounds.width,
                            source.mask_bounds.height};
  selection->has_mask = source.mask_alpha.empty() ? 0U : 1U;
  selection->empty = source.empty() ? 1U : 0U;
  return 1;
}

int patchy_engine_session_selection_rect_at(
    const patchy_engine_session *session, std::size_t index,
    patchy_engine_rect *rect, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || rect == nullptr ||
      index >= session->value->selection().selection.size()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "selection rectangle index is invalid");
  }
  const auto source = session->value->selection().selection[index];
  *rect = {source.x, source.y, source.width, source.height};
  return 1;
}

int patchy_engine_session_selection_display_rect_at(
    const patchy_engine_session *session, std::size_t index,
    patchy_engine_rect *rect, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || rect == nullptr ||
      index >= session->value->selection().display_region.size()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "selection display rectangle index is invalid");
  }
  const auto source = session->value->selection().display_region[index];
  *rect = {source.x, source.y, source.width, source.height};
  return 1;
}

int patchy_engine_session_selection_mask(
    const patchy_engine_session *session, patchy_engine_buffer *gray,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  return copy_buffer(session->value->selection().mask_alpha.data(), gray,
                     error);
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

int patchy_engine_session_channel_count(const patchy_engine_session *session,
                                        std::size_t *count,
                                        patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || count == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and channel count output are required");
  }
  *count = session->value->document().channels().size();
  return 1;
}

int patchy_engine_session_channel_at(const patchy_engine_session *session,
                                     std::size_t index,
                                     patchy_engine_channel_projection *channel,
                                     patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || channel == nullptr ||
      index >= session->value->document().channels().size()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "channel projection index is invalid");
  }
  const auto &source = session->value->document().channels()[index];
  *channel = {};
  channel->id = source.id();
  channel->kind = static_cast<std::uint32_t>(source.kind());
  auto count = std::min(source.name().size(), sizeof(channel->name) - 1U);
  while (count > 0 && count < source.name().size() &&
         (static_cast<unsigned char>(source.name()[count]) & 0xC0U) == 0x80U) {
    --count;
  }
  std::memcpy(channel->name, source.name().data(), count);
  channel->name[count] = '\0';
  channel->name_size = static_cast<std::uint32_t>(count);
  const auto &display = source.display_info();
  channel->display_red = display.color.red;
  channel->display_green = display.color.green;
  channel->display_blue = display.color.blue;
  channel->display_opacity = display.opacity;
  channel->color_indicates =
      static_cast<std::uint32_t>(display.color_indicates);
  return 1;
}

int patchy_engine_session_channel_pixels(
    const patchy_engine_session *session, std::uint64_t channel_id,
    patchy_engine_buffer *gray, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  const auto *channel = session->value->document().find_channel(channel_id);
  if (channel == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "saved channel does not exist");
  }
  return copy_buffer(channel->pixels().data(), gray, error);
}

int patchy_engine_session_add_rgba8_layer(
    patchy_engine_session *session,
    const patchy_engine_pixel_layer_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->rgba == nullptr ||
      input->width <= 0 || input->height <= 0 ||
      input->bounds.width != input->width ||
      input->bounds.height != input->height) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete RGBA8 layer input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  const auto width = static_cast<std::size_t>(input->width);
  const auto height = static_cast<std::size_t>(input->height);
  if (width > std::numeric_limits<std::size_t>::max() / height / 4U ||
      input->rgba_size != width * height * 4U) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "RGBA8 byte length does not match its geometry");
  }
  std::string name;
  if (!copy_command_text(input->name, input->name_size, 256U, name, error)) {
    return 0;
  }
  try {
    patchy::PixelBuffer pixels(input->width, input->height,
                               patchy::PixelFormat::rgba8());
    std::copy_n(input->rgba, input->rgba_size, pixels.data().begin());
    auto prepared = session->value->document();
    const auto layer_id = prepared.allocate_layer_id();
    patchy::Layer layer(layer_id, std::move(name), std::move(pixels));
    layer.set_bounds({input->bounds.x, input->bounds.y, input->bounds.width,
                      input->bounds.height});
    prepared.add_layer(std::move(layer));
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::MergeRasterize,
            input->expected_state_id, std::move(prepared),
            {input->bounds.x, input->bounds.y, input->bounds.width,
             input->bounds.height}});
    if (!result) {
      return fail(error, result.error);
    }
    result.affected_layer_id = layer_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate RGBA8 layer pixels");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown RGBA8 layer authoring failure");
  }
}

int patchy_engine_session_replace_rgba8_layer(
    patchy_engine_session *session,
    const patchy_engine_pixel_layer_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->rgba == nullptr ||
      input->layer_id == 0 || input->width <= 0 || input->height <= 0 ||
      input->bounds.width != input->width ||
      input->bounds.height != input->height) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete RGBA8 replacement input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  const auto width = static_cast<std::size_t>(input->width);
  const auto height = static_cast<std::size_t>(input->height);
  if (width > std::numeric_limits<std::size_t>::max() / height / 4U ||
      input->rgba_size != width * height * 4U) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "RGBA8 byte length does not match its geometry");
  }
  try {
    patchy::PixelBuffer pixels(input->width, input->height,
                               patchy::PixelFormat::rgba8());
    std::copy_n(input->rgba, input->rgba_size, pixels.data().begin());
    const auto result = session->value->execute(
        patchy::engine::ReplaceLayerPixels{
            input->layer_id, std::move(pixels),
            {input->bounds.x, input->bounds.y, input->bounds.width,
             input->bounds.height},
            input->rasterize_smart_object != 0});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate RGBA8 replacement pixels");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown RGBA8 replacement failure");
  }
}

int patchy_engine_session_add_alpha_channel(
    patchy_engine_session *session,
    const patchy_engine_alpha_channel_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->gray == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete alpha-channel input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  const auto &document = session->value->document();
  const auto width = static_cast<std::size_t>(document.width());
  const auto height = static_cast<std::size_t>(document.height());
  if (width > std::numeric_limits<std::size_t>::max() / height ||
      input->gray_size != width * height) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "alpha-channel byte length does not match the document");
  }
  std::string name;
  if (!copy_command_text(input->name, input->name_size, 256U, name, error)) {
    return 0;
  }
  try {
    patchy::ChannelId id = 1;
    for (const auto &channel : document.channels()) {
      if (channel.id() == std::numeric_limits<patchy::ChannelId>::max()) {
        return fail(error, PATCHY_ENGINE_ERROR_ENGINE,
                    "saved channel identifier space is exhausted");
      }
      id = std::max(id, channel.id() + 1U);
    }
    patchy::PixelBuffer pixels(document.width(), document.height(),
                               patchy::PixelFormat::gray8());
    std::copy_n(input->gray, input->gray_size, pixels.data().begin());
    const auto result = session->value->execute(
        patchy::engine::AddDocumentChannel{patchy::DocumentChannel(
            id, std::move(name), patchy::DocumentChannelKind::Alpha,
            std::move(pixels))});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate alpha-channel pixels");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown alpha-channel authoring failure");
  }
}

int patchy_engine_session_path_count(const patchy_engine_session *session,
                                     std::size_t *count,
                                     patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || count == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and path count output are required");
  }
  *count = session->value->document().paths().size();
  return 1;
}

int patchy_engine_session_path_at(
    const patchy_engine_session *session, std::size_t index,
    patchy_engine_document_path_projection *path,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || path == nullptr ||
      index >= session->value->document().paths().size()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "path projection index is invalid");
  }
  const auto &source = session->value->document().paths()[index];
  *path = {};
  path->id = source.id();
  path->kind = static_cast<std::uint32_t>(source.kind());
  auto count = std::min(source.name().size(), sizeof(path->name) - 1U);
  while (count > 0 && count < source.name().size() &&
         (static_cast<unsigned char>(source.name()[count]) & 0xC0U) == 0x80U) {
    --count;
  }
  std::memcpy(path->name, source.name().data(), count);
  path->name[count] = '\0';
  path->name_size = static_cast<std::uint32_t>(count);
  path->subpath_count = source.path().subpaths.size();
  for (const auto &subpath : source.path().subpaths) {
    path->anchor_count += subpath.anchors.size();
  }
  path->clipping = source.is_clipping_path() ? 1U : 0U;
  return 1;
}

int patchy_engine_session_path_subpath_at(
    const patchy_engine_session *session, std::uint64_t path_id,
    std::size_t index, patchy_engine_path_subpath_projection *subpath,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || subpath == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and subpath projection are required");
  }
  const auto *path = session->value->document().find_path(path_id);
  if (path == nullptr || index >= path->path().subpaths.size()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "path or subpath index is invalid");
  }
  const auto &source = path->path().subpaths[index];
  *subpath = {source.anchors.size(), source.shape_group,
              static_cast<std::uint32_t>(source.op),
              static_cast<std::uint8_t>(source.closed ? 1U : 0U)};
  return 1;
}

int patchy_engine_session_path_anchor_at(
    const patchy_engine_session *session, std::uint64_t path_id,
    std::size_t subpath_index, std::size_t anchor_index,
    patchy_engine_path_anchor *anchor, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || anchor == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and path anchor output are required");
  }
  const auto *path = session->value->document().find_path(path_id);
  if (path == nullptr || subpath_index >= path->path().subpaths.size() ||
      anchor_index >= path->path().subpaths[subpath_index].anchors.size()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "path anchor index is invalid");
  }
  const auto &source =
      path->path().subpaths[subpath_index].anchors[anchor_index];
  *anchor = {source.anchor_x, source.anchor_y, source.in_x, source.in_y,
             source.out_x, source.out_y,
             static_cast<std::uint8_t>(source.smooth ? 1U : 0U)};
  return 1;
}

int patchy_engine_session_add_document_path(
    patchy_engine_session *session,
    const patchy_engine_document_path_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) ||
      input->kind > PATCHY_ENGINE_PATH_WORK) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete document-path input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  auto path = vector_path_from_input(input->path, error);
  if (!path.has_value()) {
    return 0;
  }
  std::string name;
  if (input->kind == PATCHY_ENGINE_PATH_SAVED) {
    if (!copy_command_text(input->name, input->name_size, 256U, name, error)) {
      return 0;
    }
  } else if (input->name_size != 0 &&
             !copy_command_text(input->name, input->name_size, 256U, name,
                                error)) {
    return 0;
  }
  try {
    auto prepared = session->value->document();
    const auto id = prepared.allocate_path_id();
    patchy::DocumentPath added(
        id, std::move(name), static_cast<patchy::DocumentPathKind>(input->kind),
        std::move(*path));
    added.set_clipping_path(input->clipping != 0);
    prepared.add_path(std::move(added));
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::Path,
            input->expected_state_id, std::move(prepared), {}});
    if (!result) {
      return fail(error, result.error);
    }
    result.affected_layer_id = id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate document path");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown document-path authoring failure");
  }
}

int patchy_engine_session_add_vector_shape(
    patchy_engine_session *session,
    const patchy_engine_vector_shape_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) ||
      !std::isfinite(input->stroke_width) || input->stroke_width < 0.0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete vector-shape input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  auto path = vector_path_from_input(input->path, error);
  if (!path.has_value()) {
    return 0;
  }
  std::string name;
  if (!copy_command_text(input->name, input->name_size, 256U, name, error)) {
    return 0;
  }
  try {
    patchy::VectorShapeContent content;
    content.path = std::move(*path);
    content.fill.kind = patchy::VectorFillKind::Solid;
    content.fill.color = {input->fill_red, input->fill_green,
                          input->fill_blue};
    content.stroke.enabled = input->stroke_enabled != 0;
    content.stroke.width = input->stroke_width;
    content.stroke.content.kind = patchy::VectorFillKind::Solid;
    content.stroke.content.color = {input->stroke_red, input->stroke_green,
                                    input->stroke_blue};
    const auto result = session->value->execute(
        patchy::engine::AddVectorShapeLayer{
            std::move(name), std::move(content),
            session->value->document().metadata().patterns, std::nullopt});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate vector shape");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown vector-shape authoring failure");
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
  if (!expected_state(session, command->expected_state_id,
                      command->expected_revision, error)) {
    return 0;
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
    case PATCHY_ENGINE_COMMAND_SELECT_ALL:
      result = session->value->execute(patchy::engine::ModifySelection{
          patchy::engine::SelectionOperation::SelectAll});
      break;
    case PATCHY_ENGINE_COMMAND_CLEAR_SELECTION:
      result = session->value->execute(patchy::engine::ModifySelection{
          patchy::engine::SelectionOperation::Clear});
      break;
    case PATCHY_ENGINE_COMMAND_INVERT_SELECTION:
      result = session->value->execute(patchy::engine::ModifySelection{
          patchy::engine::SelectionOperation::Invert});
      break;
    case PATCHY_ENGINE_COMMAND_EXPAND_SELECTION:
      result = session->value->execute(patchy::engine::ModifySelection{
          patchy::engine::SelectionOperation::Expand,
          command->payload.selection_radius.pixels});
      break;
    case PATCHY_ENGINE_COMMAND_CONTRACT_SELECTION:
      result = session->value->execute(patchy::engine::ModifySelection{
          patchy::engine::SelectionOperation::Contract,
          command->payload.selection_radius.pixels});
      break;
    case PATCHY_ENGINE_COMMAND_BORDER_SELECTION:
      result = session->value->execute(patchy::engine::ModifySelection{
          patchy::engine::SelectionOperation::Border,
          command->payload.selection_radius.pixels});
      break;
    case PATCHY_ENGINE_COMMAND_SELECT_CHANNEL: {
      const auto *channel = session->value->document().find_channel(
          command->payload.select_channel.channel_id);
      if (channel == nullptr) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "selection source channel does not exist");
      }
      result = session->value->execute(patchy::engine::SetSelection{
          selection_from_channel(*channel)});
      break;
    }
    case PATCHY_ENGINE_COMMAND_RENAME_CHANNEL: {
      std::string name;
      if (!copy_command_text(command->payload.rename_channel.name,
                             command->payload.rename_channel.name_size,
                             sizeof(command->payload.rename_channel.name),
                             name, error)) {
        return 0;
      }
      result = session->value->execute(patchy::engine::RenameDocumentChannel{
          command->payload.rename_channel.channel_id, std::move(name)});
      break;
    }
    case PATCHY_ENGINE_COMMAND_INVERT_CHANNEL:
      result = session->value->execute(patchy::engine::InvertDocumentChannel{
          command->payload.invert_channel.channel_id});
      break;
    case PATCHY_ENGINE_COMMAND_REMOVE_CHANNEL:
      result = session->value->execute(patchy::engine::RemoveDocumentChannel{
          command->payload.remove_channel.channel_id});
      break;
    case PATCHY_ENGINE_COMMAND_MOVE_CHANNEL: {
      const auto &channels = session->value->document().channels();
      if (command->payload.move_channel.final_index >= channels.size()) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "channel destination index is invalid");
      }
      std::vector<patchy::ChannelId> order;
      order.reserve(channels.size());
      for (const auto &channel : channels) {
        order.push_back(channel.id());
      }
      const auto found = std::find(
          order.begin(), order.end(), command->payload.move_channel.channel_id);
      if (found == order.end()) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "moved channel does not exist");
      }
      const auto id = *found;
      order.erase(found);
      order.insert(order.begin() + static_cast<std::ptrdiff_t>(
                                      command->payload.move_channel.final_index),
                   id);
      result = session->value->execute(
          patchy::engine::ReorderDocumentChannels{std::move(order)});
      break;
    }
    case PATCHY_ENGINE_COMMAND_SELECT_DOCUMENT_PATH: {
      const auto *path = session->value->document().find_path(
          command->payload.select_document_path.path_id);
      if (path == nullptr ||
          command->payload.select_document_path.combine >
              PATCHY_ENGINE_PATH_INTERSECT) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "selection source path or combine mode is invalid");
      }
      result = session->value->execute(patchy::engine::SelectVectorPath{
          path->path(), command->payload.select_document_path.feather,
          command->payload.select_document_path.antialias != 0,
          static_cast<patchy::engine::SelectionCombineMode>(
              command->payload.select_document_path.combine)});
      break;
    }
    case PATCHY_ENGINE_COMMAND_RENAME_DOCUMENT_PATH: {
      std::string name;
      if (!copy_command_text(command->payload.rename_document_path.name,
                             command->payload.rename_document_path.name_size,
                             sizeof(command->payload.rename_document_path.name),
                             name, error)) {
        return 0;
      }
      auto prepared = session->value->document();
      auto *path = prepared.find_path(
          command->payload.rename_document_path.path_id);
      if (path == nullptr) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "renamed document path does not exist");
      }
      path->set_name(std::move(name));
      result = session->value->execute(
          patchy::engine::CommitPreparedDocumentState{
              patchy::engine::PreparedDocumentMutationKind::Path,
              command->expected_state_id, std::move(prepared), {}});
      break;
    }
    case PATCHY_ENGINE_COMMAND_REMOVE_DOCUMENT_PATH: {
      auto prepared = session->value->document();
      if (!prepared.remove_path(
              command->payload.remove_document_path.path_id)) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "removed document path does not exist");
      }
      result = session->value->execute(
          patchy::engine::CommitPreparedDocumentState{
              patchy::engine::PreparedDocumentMutationKind::Path,
              command->expected_state_id, std::move(prepared), {}});
      break;
    }
    case PATCHY_ENGINE_COMMAND_MOVE_DOCUMENT_PATH: {
      auto prepared = session->value->document();
      auto &paths = prepared.paths();
      if (command->payload.move_document_path.final_index >= paths.size()) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "path destination index is invalid");
      }
      const auto found = std::find_if(
          paths.begin(), paths.end(), [&](const patchy::DocumentPath &path) {
            return path.id() == command->payload.move_document_path.path_id;
          });
      if (found == paths.end()) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "moved document path does not exist");
      }
      auto moved = std::move(*found);
      paths.erase(found);
      paths.insert(paths.begin() + static_cast<std::ptrdiff_t>(
                                       command->payload.move_document_path
                                           .final_index),
                   std::move(moved));
      result = session->value->execute(
          patchy::engine::CommitPreparedDocumentState{
              patchy::engine::PreparedDocumentMutationKind::Path,
              command->expected_state_id, std::move(prepared), {}});
      break;
    }
    case PATCHY_ENGINE_COMMAND_SET_CLIPPING_PATH: {
      auto prepared = session->value->document();
      auto *target = prepared.find_path(
          command->payload.set_clipping_path.path_id);
      if (target == nullptr || target->kind() != patchy::DocumentPathKind::Saved) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "clipping target must be a saved path");
      }
      if (command->payload.set_clipping_path.clipping != 0) {
        for (auto &path : prepared.paths()) {
          path.set_clipping_path(false);
        }
      }
      target = prepared.find_path(command->payload.set_clipping_path.path_id);
      target->set_clipping_path(
          command->payload.set_clipping_path.clipping != 0);
      result = session->value->execute(
          patchy::engine::CommitPreparedDocumentState{
              patchy::engine::PreparedDocumentMutationKind::Path,
              command->expected_state_id, std::move(prepared), {}});
      break;
    }
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
