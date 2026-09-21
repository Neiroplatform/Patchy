#include "engine/host_protocol.h"

#include "engine/document_session.hpp"
#include "core/adjustment_layer.hpp"
#include "core/layer_metadata.hpp"
#include "core/layer_transform.hpp"
#include "core/layer_warp.hpp"
#include "core/magnetic_lasso.hpp"
#include "core/quick_select.hpp"
#include "core/raster_stroke.hpp"
#include "core/pattern_resource.hpp"
#include "core/rect_utils.hpp"
#include "core/smart_object.hpp"
#include "filters/smart_filter_renderer.hpp"
#include "formats/document_flatten.hpp"
#include "psd/psd_filter_effects.hpp"
#include "psd/psd_smart_objects.hpp"
#include "psd/psd_text_runs.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <limits>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <vector>

struct patchy_engine_runtime {
  std::uint32_t protocol_version{PATCHY_ENGINE_HOST_PROTOCOL_VERSION};
};

struct patchy_engine_session {
  std::unique_ptr<patchy::engine::DocumentSession> value;
  std::array<patchy_engine_event, 256> events{};
  std::size_t event_start{0};
  std::size_t event_count{0};
  std::uint64_t dropped_events{0};
};

struct patchy_engine_cancellation {
  patchy::engine::CancellationToken value;
};

namespace {

using patchy::engine::CommandResult;
using patchy::engine::DocumentSession;
using patchy::engine::SessionError;

void enqueue_event(patchy_engine_session &session,
                   const patchy::engine::SessionEvent &source) noexcept {
  patchy_engine_event event{};
  event.struct_size = sizeof(event);
  event.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  event.kind = static_cast<std::uint32_t>(source.kind);
  event.revision = source.revision;
  event.state_id = source.state_id;
  event.affected_layer_id = source.layer_id;
  event.changed = 1U;
  event.dirty = source.dirty ? 1U : 0U;
  if (source.affected_region.has_value()) {
    event.has_affected_region = 1U;
    event.affected_region = {source.affected_region->x, source.affected_region->y,
                             source.affected_region->width,
                             source.affected_region->height};
  }
  if (session.event_count == session.events.size()) {
    session.event_start = (session.event_start + 1U) % session.events.size();
    --session.event_count;
    ++session.dropped_events;
  }
  const auto index =
      (session.event_start + session.event_count) % session.events.size();
  session.events[index] = event;
  ++session.event_count;
}

patchy_engine_session *make_session(
    std::unique_ptr<patchy::engine::DocumentSession> value) {
  auto result = std::make_unique<patchy_engine_session>();
  result->value = std::move(value);
  auto *raw = result.get();
  raw->value->set_event_sink(
      [raw](const patchy::engine::SessionEvent &event) noexcept {
        enqueue_event(*raw, event);
      });
  return result.release();
}

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
static_assert(sizeof(patchy_engine_raster_fill) == 64U);
static_assert(offsetof(patchy_engine_raster_fill, secondary_red) == 20U);
static_assert(offsetof(patchy_engine_raster_fill, pattern_size) == 24U);
static_assert(offsetof(patchy_engine_raster_fill, start_x) == 32U);
static_assert(sizeof(patchy_engine_essential_layer_style_projection) == 296U);
static_assert(offsetof(patchy_engine_essential_layer_style_projection,
                       drop_shadow_present) == 36U);
static_assert(offsetof(patchy_engine_essential_layer_style_projection,
                       stroke_overprint) == 124U);
static_assert(offsetof(patchy_engine_essential_layer_style_projection,
                       inner_shadow_count) == 128U);
static_assert(offsetof(patchy_engine_essential_layer_style_projection,
                       satin_invert) == 288U);
static_assert(offsetof(patchy_engine_command,
                       payload.set_essential_layer_style.layer_id) == 32U);
static_assert(offsetof(patchy_engine_command,
                       payload.set_essential_layer_style.stroke_overprint) ==
              136U);
static_assert(offsetof(patchy_engine_command,
                       payload.set_essential_layer_style.inner_shadow_present) ==
              140U);
static_assert(offsetof(patchy_engine_command,
                       payload.set_essential_layer_style.satin_invert) == 284U);

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
    PATCHY_ENGINE_CAP_VECTOR_AUTHORING |
    PATCHY_ENGINE_CAP_LAYER_MASK_AUTHORING |
    PATCHY_ENGINE_CAP_FILTER_AUTHORING |
    PATCHY_ENGINE_CAP_PROGRESS_CANCELLATION |
    PATCHY_ENGINE_CAP_EVENT_DRAIN |
    PATCHY_ENGINE_CAP_TEXT_AUTHORING |
    PATCHY_ENGINE_CAP_SMART_OBJECT_AUTHORING |
    PATCHY_ENGINE_CAP_ADJUSTMENT_AUTHORING |
    PATCHY_ENGINE_CAP_VECTOR_MASK_AUTHORING |
    PATCHY_ENGINE_CAP_SMART_FILTER_AUTHORING |
    PATCHY_ENGINE_CAP_SELECTION_AUTHORING |
    PATCHY_ENGINE_CAP_MEMORY_CONTROL |
    PATCHY_ENGINE_CAP_CROSS_DOCUMENT_LAYERS |
    PATCHY_ENGINE_CAP_LAYER_TRANSFORM |
    PATCHY_ENGINE_CAP_RASTER_STROKE |
    PATCHY_ENGINE_CAP_RASTER_FILL |
    PATCHY_ENGINE_CAP_LAYER_WARP |
    PATCHY_ENGINE_CAP_ESSENTIAL_LAYER_STYLE |
    PATCHY_ENGINE_CAP_PSB_SAVE_AS |
    PATCHY_ENGINE_CAP_LAYER_MASK_STROKE |
    PATCHY_ENGINE_CAP_RICH_TEXT_AUTHORING;

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
  const auto code =
      session_error.code == patchy::engine::SessionErrorCode::Cancelled
          ? PATCHY_ENGINE_ERROR_CANCELLED
          : PATCHY_ENGINE_ERROR_ENGINE;
  return fail(error, code, session_error.message);
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

bool transferable_layer_tree(const patchy::Layer &layer,
                             patchy_engine_error *error) {
  if (patchy::layer_is_smart_object(layer) ||
      patchy::layer_is_vector_shape(layer) ||
      layer.smart_filter_stack() != nullptr) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "Smart Objects, Smart Filters and vector shapes require document resources and cannot be transferred yet");
    return false;
  }
  std::vector<std::string> pattern_ids;
  patchy::collect_referenced_pattern_ids(layer, pattern_ids);
  if (!pattern_ids.empty()) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "layers with pattern resources cannot be transferred yet");
    return false;
  }
  return std::all_of(layer.children().begin(), layer.children().end(),
                     [error](const patchy::Layer &child) {
                       return transferable_layer_tree(child, error);
                     });
}

patchy::Layer clone_transferable_layer(const patchy::Layer &source,
                                       patchy::Document &target,
                                       std::set<std::uint32_t> &photoshop_ids,
                                       std::uint32_t &next_photoshop_id) {
  auto clone = source.clone_with_id(target.allocate_layer_id());
  clone.children().clear();
  if (patchy::photoshop_layer_id(source).has_value()) {
    while (next_photoshop_id == 0 || photoshop_ids.contains(next_photoshop_id)) {
      ++next_photoshop_id;
    }
    patchy::set_photoshop_layer_id(clone, next_photoshop_id);
    photoshop_ids.insert(next_photoshop_id++);
  }
  for (const auto &child : source.children()) {
    clone.children().push_back(
        clone_transferable_layer(child, target, photoshop_ids,
                                 next_photoshop_id));
  }
  return clone;
}

bool valid_rgba_payload(const std::uint8_t *rgba, std::size_t rgba_size,
                        std::int32_t width, std::int32_t height,
                        const patchy_engine_rect &bounds,
                        patchy_engine_error *error) noexcept {
  if (rgba == nullptr || width <= 0 || height <= 0 || bounds.width != width ||
      bounds.height != height) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "RGBA8 pixels and matching geometry are required");
    return false;
  }
  const auto pixel_width = static_cast<std::size_t>(width);
  const auto pixel_height = static_cast<std::size_t>(height);
  if (pixel_width > std::numeric_limits<std::size_t>::max() / pixel_height /
                        4U ||
      rgba_size != pixel_width * pixel_height * 4U) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "RGBA8 byte length does not match its geometry");
    return false;
  }
  return true;
}

template <std::size_t Capacity>
void project_text(std::string_view source, char (&destination)[Capacity],
                  std::uint32_t &size) noexcept {
  auto count = std::min(source.size(), Capacity - 1U);
  while (count > 0 && count < source.size() &&
         (static_cast<unsigned char>(source[count]) & 0xC0U) == 0x80U) {
    --count;
  }
  std::memcpy(destination, source.data(), count);
  destination[count] = '\0';
  size = static_cast<std::uint32_t>(count);
}

std::optional<std::string_view> metadata_value(const patchy::Layer &layer,
                                               const char *key) {
  const auto found = layer.metadata().find(key);
  if (found == layer.metadata().end()) {
    return std::nullopt;
  }
  return found->second;
}

int utf16_code_units(std::string_view text) noexcept {
  int units = 0;
  for (std::size_t index = 0; index < text.size();) {
    const auto lead = static_cast<unsigned char>(text[index]);
    std::size_t consumed = 1;
    std::uint32_t codepoint = 0xFFFDU;
    if (lead < 0x80U) {
      codepoint = lead;
    } else if ((lead & 0xE0U) == 0xC0U && index + 1U < text.size()) {
      codepoint = ((lead & 0x1FU) << 6U) |
                  (static_cast<unsigned char>(text[index + 1U]) & 0x3FU);
      consumed = 2;
    } else if ((lead & 0xF0U) == 0xE0U && index + 2U < text.size()) {
      codepoint = ((lead & 0x0FU) << 12U) |
                  ((static_cast<unsigned char>(text[index + 1U]) & 0x3FU) << 6U) |
                  (static_cast<unsigned char>(text[index + 2U]) & 0x3FU);
      consumed = 3;
    } else if ((lead & 0xF8U) == 0xF0U && index + 3U < text.size()) {
      codepoint = ((lead & 0x07U) << 18U) |
                  ((static_cast<unsigned char>(text[index + 1U]) & 0x3FU) << 12U) |
                  ((static_cast<unsigned char>(text[index + 2U]) & 0x3FU) << 6U) |
                  (static_cast<unsigned char>(text[index + 3U]) & 0x3FU);
      consumed = 4;
    }
    units += codepoint > 0xFFFFU ? 2 : 1;
    index += consumed;
  }
  return units;
}

bool finite_text_metric(double value, double minimum, double maximum) noexcept {
  return std::isfinite(value) && value >= minimum && value <= maximum;
}

bool collect_text_runs(const patchy_engine_text_layer_input &input,
                       std::string_view text,
                       const patchy::psd::PsdTextStyleRun &fallback,
                       std::vector<patchy::psd::PsdTextStyleRun> &styles,
                       std::vector<patchy::psd::PsdTextParagraphRun> &paragraphs,
                       patchy_engine_error *error) {
  constexpr std::size_t kMaximumRuns = 128U;
  constexpr std::uint32_t kLegacyInputSize = static_cast<std::uint32_t>(
      offsetof(patchy_engine_text_layer_input, style_runs));
  const bool has_typed_runs = input.struct_size > kLegacyInputSize;
  const auto style_run_count = has_typed_runs ? input.style_run_count : 0U;
  const auto paragraph_run_count = has_typed_runs ? input.paragraph_run_count : 0U;
  const auto story_length = utf16_code_units(text);
  if (story_length <= 0) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "text story must not be empty");
    return false;
  }
  if (style_run_count > kMaximumRuns || paragraph_run_count > kMaximumRuns ||
      (style_run_count != 0U && input.style_runs == nullptr) ||
      (paragraph_run_count != 0U && input.paragraph_runs == nullptr)) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "text run arrays exceed the supported bounds");
    return false;
  }
  if (style_run_count == 0U) {
    auto run = fallback;
    run.start = 0;
    run.length = story_length;
    styles.push_back(std::move(run));
  } else {
    styles.reserve(style_run_count);
    int covered = 0;
    for (std::size_t index = 0; index < style_run_count; ++index) {
      const auto &source = input.style_runs[index];
      if (source.struct_size != sizeof(source) || source.start != covered ||
          source.length <= 0 || source.start > story_length - source.length ||
          source.font_size == 0U || source.font_size > sizeof(source.font) ||
          source.style_size > sizeof(source.style) ||
          std::memchr(source.font, '\0', source.font_size) != nullptr ||
          std::memchr(source.style, '\0', source.style_size) != nullptr ||
          !finite_text_metric(source.size_pixels, 1.0, 512.0) ||
          !finite_text_metric(source.leading, 0.0, 4096.0) ||
          !finite_text_metric(source.tracking, -10000.0, 10000.0) ||
          !finite_text_metric(source.horizontal_scale, 0.01, 100.0) ||
          !finite_text_metric(source.vertical_scale, 0.01, 100.0)) {
        fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
             "text style runs must be finite, contiguous, and bounded");
        return false;
      }
      patchy::psd::PsdTextStyleRun run;
      run.start = source.start;
      run.length = source.length;
      run.family.assign(source.font, source.font + source.font_size);
      run.style.assign(source.style, source.style + source.style_size);
      run.size = source.size_pixels;
      run.color = {source.red, source.green, source.blue};
      run.bold = source.bold != 0;
      run.italic = source.italic != 0;
      run.faux_bold = source.faux_bold != 0;
      run.faux_italic = source.faux_italic != 0;
      run.auto_leading = source.auto_leading != 0;
      if (!run.auto_leading && source.leading > 0.0) run.leading = source.leading;
      run.tracking = source.tracking;
      run.horizontal_scale = source.horizontal_scale;
      run.vertical_scale = source.vertical_scale;
      styles.push_back(std::move(run));
      covered += source.length;
    }
    if (covered != story_length) {
      fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
           "text style runs must cover the complete UTF-16 story");
      return false;
    }
  }
  if (paragraph_run_count == 0U) {
    paragraphs.push_back({0, story_length, PATCHY_ENGINE_TEXT_LEFT});
  } else {
    paragraphs.reserve(paragraph_run_count);
    int covered = 0;
    for (std::size_t index = 0; index < paragraph_run_count; ++index) {
      const auto &source = input.paragraph_runs[index];
      const bool metrics_valid =
          finite_text_metric(source.first_line_indent, -1000000.0, 1000000.0) &&
          finite_text_metric(source.start_indent, -1000000.0, 1000000.0) &&
          finite_text_metric(source.end_indent, -1000000.0, 1000000.0) &&
          finite_text_metric(source.space_before, -1000000.0, 1000000.0) &&
          finite_text_metric(source.space_after, -1000000.0, 1000000.0) &&
          finite_text_metric(source.auto_leading_fraction, 0.01, 10.0);
      if (source.struct_size != sizeof(source) || source.start != covered ||
          source.length <= 0 || source.start > story_length - source.length ||
          source.justification > PATCHY_ENGINE_TEXT_JUSTIFY || !metrics_valid) {
        fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
             "text paragraph runs must be finite, contiguous, and bounded");
        return false;
      }
      paragraphs.push_back({source.start, source.length,
                            static_cast<int>(source.justification),
                            source.first_line_indent, source.start_indent,
                            source.end_indent, source.space_before,
                            source.space_after, source.auto_leading_fraction});
      covered += source.length;
    }
    if (covered != story_length) {
      fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
           "text paragraph runs must cover the complete UTF-16 story");
      return false;
    }
  }
  return true;
}

patchy::psd::PsdTextStyleRun text_fallback(const patchy::Layer &layer) {
  patchy::psd::PsdTextStyleRun run;
  if (const auto value = metadata_value(layer, patchy::kLayerMetadataTextFont))
    run.family = std::string(*value);
  if (const auto value = metadata_value(layer, patchy::kLayerMetadataTextSize))
    run.size = std::stod(std::string(*value));
  if (const auto value = metadata_value(layer, patchy::kLayerMetadataTextColor)) {
    unsigned red = 0, green = 0, blue = 0;
    std::sscanf(std::string(*value).c_str(), "#%02x%02x%02x", &red, &green, &blue);
    run.color = {static_cast<std::uint8_t>(red), static_cast<std::uint8_t>(green),
                 static_cast<std::uint8_t>(blue)};
  }
  run.bold = metadata_value(layer, patchy::kLayerMetadataTextBold)
                 .value_or(std::string_view{}) == "true";
  run.italic = metadata_value(layer, patchy::kLayerMetadataTextItalic)
                   .value_or(std::string_view{}) == "true";
  return run;
}

std::vector<patchy::psd::PsdTextStyleRun> projected_style_runs(
    const patchy::Layer &layer) {
  const auto text = metadata_value(layer, patchy::kLayerMetadataText)
                        .value_or(std::string_view{});
  return patchy::psd::parse_patchy_text_runs(
      metadata_value(layer, patchy::kLayerMetadataTextRuns)
          .value_or(std::string_view{}),
      text, text_fallback(layer));
}

std::vector<patchy::psd::PsdTextParagraphRun> projected_paragraph_runs(
    const patchy::Layer &layer) {
  const auto text = metadata_value(layer, patchy::kLayerMetadataText)
                        .value_or(std::string_view{});
  return patchy::psd::parse_patchy_paragraph_runs(
      metadata_value(layer, patchy::kLayerMetadataTextParagraphRuns)
          .value_or(std::string_view{}),
      text);
}

void store_authored_text_metadata(
    patchy::Layer &layer, const patchy_engine_text_layer_input &input,
    std::string_view text,
    std::span<const patchy::psd::PsdTextStyleRun> styles,
    std::span<const patchy::psd::PsdTextParagraphRun> paragraphs) {
  auto &metadata = layer.metadata();
  const auto &primary = styles.front();
  metadata[patchy::kLayerMetadataText] = text;
  metadata[patchy::kLayerMetadataTextFont] = primary.family;
  metadata[patchy::kLayerMetadataTextSize] = std::to_string(primary.size);
  char color[8]{};
  std::snprintf(color, sizeof(color), "#%02x%02x%02x", primary.color.red,
                primary.color.green, primary.color.blue);
  metadata[patchy::kLayerMetadataTextColor] = color;
  metadata[patchy::kLayerMetadataTextBold] = primary.bold ? "true" : "false";
  metadata[patchy::kLayerMetadataTextItalic] = primary.italic ? "true" : "false";
  metadata[patchy::kLayerMetadataTextFlow] = input.box_text != 0 ? "box" : "point";
  metadata[patchy::kLayerMetadataTextBoxWidth] = std::to_string(input.bounds.width);
  metadata[patchy::kLayerMetadataTextBoxHeight] = std::to_string(input.bounds.height);
  metadata[patchy::kLayerMetadataTextRuns] =
      patchy::psd::serialize_patchy_text_runs(styles);
  metadata[patchy::kLayerMetadataTextParagraphRuns] =
      patchy::psd::serialize_patchy_paragraph_runs(paragraphs);
  metadata[patchy::kLayerMetadataTextHtml] =
      patchy::psd::html_from_text_runs(text, styles, paragraphs);
  metadata[patchy::kLayerMetadataTextAntiAlias] = "3";
  metadata[patchy::kLayerMetadataTextRasterStatus] = "patchy_raster";
  if (!metadata.contains(patchy::kLayerMetadataTextTransform)) {
    metadata[patchy::kLayerMetadataTextTransform] =
        "1 0 0 1 " + std::to_string(input.bounds.x) + " " +
        std::to_string(input.bounds.y);
  }
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

patchy::engine::SelectionSnapshot selection_from_mask(
    patchy::PixelBuffer pixels, patchy::Rect bounds) {
  patchy::engine::SelectionSnapshot result;
  result.selection = rects_from_gray8(pixels, 1U);
  result.display_region = rects_from_gray8(pixels, 128U);
  for (auto *rects : {&result.selection, &result.display_region}) {
    for (auto &rect : *rects) {
      rect.x += bounds.x;
      rect.y += bounds.y;
    }
  }
  const bool partial = std::any_of(
      pixels.data().begin(), pixels.data().end(),
      [](std::uint8_t value) { return value != 0U && value != 255U; });
  if (partial && !result.selection.empty()) {
    result.mask_bounds = bounds;
    result.mask_alpha = std::move(pixels);
  }
  return result;
}

constexpr std::size_t kAdvancedSelectionPixelLimit = 16U * 1024U * 1024U;
constexpr std::size_t kQuickSelectPointLimit = 65536U;
constexpr std::size_t kMagneticAnchorLimit = 256U;
constexpr std::size_t kMagneticPathPointLimit = 262144U;

std::vector<std::uint8_t> materialize_selection_mask(
    const patchy::engine::SelectionSnapshot &selection, std::int32_t width,
    std::int32_t height) {
  std::vector<std::uint8_t> result(static_cast<std::size_t>(width) * height, 0U);
  if (!selection.mask_alpha.empty()) {
    const auto bounds = selection.mask_bounds;
    for (std::int32_t y = 0; y < bounds.height; ++y) {
      std::copy_n(selection.mask_alpha.pixel(0, y), bounds.width,
                  result.data() + static_cast<std::size_t>(bounds.y + y) * width + bounds.x);
    }
    return result;
  }
  for (const auto rect : selection.selection) {
    for (std::int32_t y = rect.y; y < rect.y + rect.height; ++y) {
      std::fill_n(result.data() + static_cast<std::size_t>(y) * width + rect.x,
                  rect.width, 255U);
    }
  }
  return result;
}

patchy::PathAnchor corner_anchor(patchy::PointI32 point) {
  patchy::PathAnchor result;
  result.anchor_x = result.in_x = result.out_x = point.x + 0.5;
  result.anchor_y = result.in_y = result.out_y = point.y + 0.5;
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
  event->kind = PATCHY_ENGINE_EVENT_COMMAND_APPLIED;
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

std::optional<patchy::LayerTransformRequest> layer_transform_request(
    const patchy_engine_layer_transform *input, patchy_engine_error *error) {
  if (input == nullptr || input->struct_size != sizeof(*input) ||
      input->layer_id == 0 ||
      input->interpolation > PATCHY_ENGINE_TRANSFORM_BILINEAR) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "a versioned layer transform is required");
    return std::nullopt;
  }
  patchy::LayerTransformRequest request;
  std::copy(std::begin(input->quad), std::end(input->quad),
            request.quad.begin());
  request.interpolation =
      input->interpolation == PATCHY_ENGINE_TRANSFORM_NEAREST
          ? patchy::LayerTransformInterpolation::Nearest
          : patchy::LayerTransformInterpolation::Bilinear;
  return request;
}

std::optional<patchy::RasterStrokeRequest> raster_stroke_request(
    const patchy_engine_session *session,
    const patchy_engine_raster_stroke *input, patchy_engine_error *error) {
  if (input == nullptr || input->struct_size != sizeof(*input) ||
      input->layer_id == 0 || input->mode > PATCHY_ENGINE_RASTER_HEAL ||
      input->points == nullptr || input->point_count == 0 ||
      input->point_count > 65536U) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "a bounded versioned raster stroke is required");
    return std::nullopt;
  }
  patchy::RasterStrokeRequest request;
  request.mode = static_cast<patchy::RasterStrokeMode>(input->mode);
  request.brush_size = input->brush_size;
  request.color = {input->red, input->green, input->blue, input->alpha};
  request.source = {input->source_x, input->source_y};
  request.points.reserve(input->point_count);
  for (std::size_t index = 0; index < input->point_count; ++index) {
    request.points.push_back({input->points[index].x, input->points[index].y});
  }
  const auto &selection = session->value->selection();
  request.selection = selection.selection;
  if (!selection.mask_alpha.empty()) {
    request.selection_mask_bounds = selection.mask_bounds;
    request.selection_mask = selection.mask_alpha;
  }
  return request;
}

std::optional<patchy::RasterFillRequest> raster_fill_request(
    const patchy_engine_session *session,
    const patchy_engine_raster_fill *input, patchy_engine_error *error) {
  if (input == nullptr || input->struct_size != sizeof(*input) ||
      input->layer_id == 0 || input->mode > 9U || input->pattern_size > 256U ||
      (input->mode >= PATCHY_ENGINE_RASTER_FILL_CUSTOM_CHECKER &&
       input->pattern_size < 1U)) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "a bounded versioned raster fill is required");
    return std::nullopt;
  }
  patchy::RasterFillRequest request;
  request.mode = static_cast<patchy::RasterFillMode>(input->mode);
  request.color = {input->red, input->green, input->blue, input->alpha};
  request.secondary_color = {input->secondary_red, input->secondary_green,
                             input->secondary_blue, input->secondary_alpha};
  request.pattern_size = input->pattern_size == 0U
                             ? 8
                             : static_cast<std::int32_t>(input->pattern_size);
  request.start = {input->start_x, input->start_y};
  request.end = {input->end_x, input->end_y};
  const auto &selection = session->value->selection();
  request.selection = selection.selection;
  if (!selection.mask_alpha.empty()) {
    request.selection_mask_bounds = selection.mask_bounds;
    request.selection_mask = selection.mask_alpha;
  }
  return request;
}

std::optional<patchy::LayerWarpRequest> layer_warp_request(
    const patchy_engine_layer_warp *input, patchy_engine_error *error) {
  static constexpr std::array<std::string_view, 15> kStyles{
      "warpArc", "warpArch", "warpBulge", "warpFlag", "warpWave",
      "warpRise", "warpArcLower", "warpArcUpper", "warpShellLower",
      "warpShellUpper", "warpFish", "warpFisheye", "warpInflate",
      "warpSqueeze", "warpTwist"};
  if (input == nullptr || input->struct_size != sizeof(*input) ||
      input->layer_id == 0 || input->style >= kStyles.size() ||
      input->interpolation > PATCHY_ENGINE_TRANSFORM_BILINEAR ||
      input->rotate_vertical > 1U) {
    fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
         "a bounded versioned layer warp is required");
    return std::nullopt;
  }
  patchy::LayerWarpRequest request;
  request.style = kStyles[input->style];
  request.bend = input->bend;
  request.horizontal_distortion = input->horizontal_distortion;
  request.vertical_distortion = input->vertical_distortion;
  request.rotate_vertical = input->rotate_vertical != 0;
  request.interpolation =
      input->interpolation == PATCHY_ENGINE_TRANSFORM_NEAREST
          ? patchy::LayerTransformInterpolation::Nearest
          : patchy::LayerTransformInterpolation::Bilinear;
  return request;
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

patchy_engine_cancellation *patchy_engine_cancellation_create(
    patchy_engine_error *error) {
  clear_error(error);
  try {
    return new patchy_engine_cancellation{};
  } catch (const std::bad_alloc &) {
    fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
         "could not allocate cancellation token");
  } catch (...) {
    fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
         "unknown cancellation token failure");
  }
  return nullptr;
}

void patchy_engine_cancellation_cancel(
    patchy_engine_cancellation *cancellation) {
  if (cancellation != nullptr) {
    cancellation->value.cancel();
  }
}

void patchy_engine_cancellation_destroy(
    patchy_engine_cancellation *cancellation) {
  delete cancellation;
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
    return make_session(std::move(opened.session));
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
    return make_session(std::make_unique<DocumentSession>(
        patchy::Document(width, height, patchy::PixelFormat::rgba8())));
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

int patchy_engine_session_set_selection(
    patchy_engine_session *session,
    const patchy_engine_selection_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->rect_count > 1U ||
      (input->rect_count != 0 && input->rects == nullptr)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "zero or one rectangular selection is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  try {
    patchy::engine::SelectionSnapshot selection;
    selection.selection.reserve(input->rect_count);
    for (std::size_t index = 0; index < input->rect_count; ++index) {
      const auto &source = input->rects[index];
      selection.selection.push_back(
          {source.x, source.y, source.width, source.height});
    }
    selection.display_region = selection.selection;
    const auto result = session->value->execute(
        patchy::engine::SetSelection{std::move(selection)});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate selection rectangles");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown selection authoring failure");
  }
}

int patchy_engine_session_set_selection_mask(
    patchy_engine_session *session,
    const patchy_engine_selection_mask_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->gray == nullptr ||
      input->width <= 0 || input->height <= 0 ||
      input->bounds.width != input->width ||
      input->bounds.height != input->height ||
      static_cast<std::size_t>(input->width) >
          std::numeric_limits<std::size_t>::max() /
              static_cast<std::size_t>(input->height) ||
      input->gray_size != static_cast<std::size_t>(input->width) *
                              static_cast<std::size_t>(input->height)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "selection mask dimensions are invalid");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  try {
    patchy::PixelBuffer pixels(input->width, input->height,
                               patchy::PixelFormat::gray8());
    std::copy_n(input->gray, input->gray_size, pixels.data().begin());
    const auto result = session->value->execute(patchy::engine::SetSelection{
        selection_from_mask(std::move(pixels),
                            {input->bounds.x, input->bounds.y,
                             input->bounds.width, input->bounds.height})});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate selection mask");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown selection mask authoring failure");
  }
}

int patchy_engine_session_quick_select(
    patchy_engine_session *session,
    const patchy_engine_quick_select_input *input,
    patchy_engine_cancellation *cancellation,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->points == nullptr ||
      input->point_count == 0 || input->point_count > kQuickSelectPointLimit ||
      input->brush_radius < 1 || input->brush_radius > 256 ||
      input->spread < 0 || input->spread > 100) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "bounded Quick Select input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  if (cancellation != nullptr && cancellation->value.cancelled()) {
    return fail(error, PATCHY_ENGINE_ERROR_CANCELLED,
                "Quick Select was cancelled");
  }
  const auto &document = session->value->document();
  const auto width = document.width();
  const auto height = document.height();
  const auto pixel_count = static_cast<std::size_t>(width) * height;
  if (pixel_count > kAdvancedSelectionPixelLimit) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "Quick Select canvas exceeds the browser safety limit");
  }
  try {
    const auto before = session->value->selection();
    auto base = materialize_selection_mask(before, width, height);
    std::vector<std::uint8_t> seeds(pixel_count, 0U);
    patchy::Rect seed_bounds{};
    bool has_seed = false;
    const auto radius = input->brush_radius;
    for (std::size_t index = 0; index < input->point_count; ++index) {
      const auto point = input->points[index];
      if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "Quick Select points must be inside the document");
      }
      const auto left = std::max(0, point.x - radius);
      const auto top = std::max(0, point.y - radius);
      const auto right = std::min(width - 1, point.x + radius);
      const auto bottom = std::min(height - 1, point.y + radius);
      const auto circle = patchy::Rect{left, top, right - left + 1, bottom - top + 1};
      seed_bounds = has_seed ? patchy::unite_rect(seed_bounds, circle) : circle;
      has_seed = true;
      const auto squared_radius = radius * radius;
      for (std::int32_t y = top; y <= bottom; ++y) {
        for (std::int32_t x = left; x <= right; ++x) {
          const auto dx = x - point.x;
          const auto dy = y - point.y;
          if (dx * dx + dy * dy <= squared_radius) {
            seeds[static_cast<std::size_t>(y) * width + x] = 255U;
          }
        }
      }
    }
    const auto flattened = patchy::flatten_document_rgba8(document);
    patchy::QuickSelectParams params;
    params.brush_radius = radius;
    params.spread = input->spread;
    params.subtract = input->subtract != 0;
    params.enhance_edge = input->enhance_edge != 0;
    const auto segmented = patchy::quick_select_segment(
        flattened.data().data(), width, height,
        static_cast<std::ptrdiff_t>(flattened.stride_bytes()), base.data(),
        seeds.data(), seed_bounds, params);
    if (cancellation != nullptr && cancellation->value.cancelled()) {
      return fail(error, PATCHY_ENGINE_ERROR_CANCELLED,
                  "Quick Select was cancelled");
    }
    for (const auto run : segmented.delta_runs) {
      std::fill(base.begin() + static_cast<std::size_t>(run.y) * width + run.x0,
                base.begin() + static_cast<std::size_t>(run.y) * width + run.x1 + 1,
                input->subtract != 0 ? 0U : 255U);
    }
    patchy::PixelBuffer mask(width, height, patchy::PixelFormat::gray8());
    std::copy(base.begin(), base.end(), mask.data().begin());
    auto result = session->value->execute(patchy::engine::CommitPreparedSelection{
        before, selection_from_mask(std::move(mask), patchy::Rect::from_size(width, height))});
    if (!result) return fail(error, result.error);
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate Quick Select working memory");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_ENGINE, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown Quick Select failure");
  }
}

int patchy_engine_session_magnetic_lasso(
    patchy_engine_session *session,
    const patchy_engine_magnetic_lasso_input *input,
    patchy_engine_cancellation *cancellation,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->anchors == nullptr ||
      input->anchor_count < 3 || input->anchor_count > kMagneticAnchorLimit ||
      input->width < 1 || input->width > 256 || input->edge_contrast < 1 ||
      input->edge_contrast > 100 || input->node_budget < 1024 ||
      input->node_budget > 1000000 || input->combine > 3U) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "bounded Magnetic Lasso input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) return 0;
  if (cancellation != nullptr && cancellation->value.cancelled()) {
    return fail(error, PATCHY_ENGINE_ERROR_CANCELLED,
                "Magnetic Lasso was cancelled");
  }
  const auto &document = session->value->document();
  const auto width = document.width();
  const auto height = document.height();
  if (static_cast<std::size_t>(width) * height > kAdvancedSelectionPixelLimit) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "Magnetic Lasso canvas exceeds the browser safety limit");
  }
  try {
    const auto flattened = patchy::flatten_document_rgba8(document);
    patchy::LiveWireEngine live_wire;
    live_wire.set_image(flattened.data().data(), width, height,
                        static_cast<std::ptrdiff_t>(flattened.stride_bytes()));
    live_wire.set_params({input->width, input->edge_contrast, input->node_budget});
    std::vector<patchy::PointI32> anchors;
    anchors.reserve(input->anchor_count);
    for (std::size_t index = 0; index < input->anchor_count; ++index) {
      const patchy::PointI32 point{input->anchors[index].x, input->anchors[index].y};
      if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "Magnetic Lasso anchors must be inside the document");
      }
      // Manual anchors are corrections chosen by the user. Keep them exact;
      // only the live-wire segment between anchors is edge optimized.
      anchors.push_back(point);
    }
    patchy::PathSubpath subpath;
    for (std::size_t index = 0; index < anchors.size(); ++index) {
      if (cancellation != nullptr && cancellation->value.cancelled()) {
        return fail(error, PATCHY_ENGINE_ERROR_CANCELLED,
                    "Magnetic Lasso was cancelled");
      }
      live_wire.set_anchor(anchors[index]);
      const auto path = live_wire.path_to(anchors[(index + 1U) % anchors.size()]);
      for (std::size_t point_index = 0; point_index + 1U < path.size(); ++point_index) {
        if (subpath.anchors.size() >= kMagneticPathPointLimit) {
          return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                      "Magnetic Lasso path exceeds the browser safety limit");
        }
        if (subpath.anchors.empty() ||
            subpath.anchors.back().anchor_x != path[point_index].x + 0.5 ||
            subpath.anchors.back().anchor_y != path[point_index].y + 0.5) {
          subpath.anchors.push_back(corner_anchor(path[point_index]));
        }
      }
    }
    subpath.closed = true;
    patchy::VectorPath path;
    path.subpaths.push_back(std::move(subpath));
    auto result = session->value->execute(patchy::engine::SelectVectorPath{
        std::move(path), 0.0, true,
        static_cast<patchy::engine::SelectionCombineMode>(input->combine)});
    if (!result) return fail(error, result.error);
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate Magnetic Lasso working memory");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_ENGINE, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown Magnetic Lasso failure");
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
    const auto *document_layer =
        session->value->document().find_layer(source.id);
    if (document_layer == nullptr) {
      return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                  "projected layer is missing from the document");
    }
    layer->kind = patchy::layer_is_text(*document_layer)
                      ? PATCHY_ENGINE_LAYER_TEXT
                      : patchy::layer_is_smart_object(*document_layer)
                            ? PATCHY_ENGINE_LAYER_SMART_OBJECT
                            : patchy::layer_is_vector_shape(*document_layer)
                                  ? PATCHY_ENGINE_LAYER_VECTOR
                                  : static_cast<std::uint32_t>(source.kind);
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

int patchy_engine_session_essential_layer_style(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_essential_layer_style_projection *style,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || style == nullptr ||
      style->struct_size != sizeof(*style)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and exact essential layer style output are required");
  }
  try {
    const auto *layer = session->value->document().find_layer(layer_id);
    if (layer == nullptr) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "layer style target does not exist");
    }
    const auto pack_rgb = [](patchy::RgbColor color) {
      return (static_cast<std::uint32_t>(color.red) << 16U) |
             (static_cast<std::uint32_t>(color.green) << 8U) |
             static_cast<std::uint32_t>(color.blue);
    };
    const auto &source = layer->layer_style();
    *style = {};
    style->struct_size = sizeof(*style);
    style->layer_id = layer_id;
    style->effects_visible = source.effects_visible ? 1U : 0U;
    style->layer_mask_hides_effects =
        source.layer_mask_hides_effects ? 1U : 0U;
    style->drop_shadow_count =
        static_cast<std::uint32_t>(source.drop_shadows.size());
    style->color_overlay_count =
        static_cast<std::uint32_t>(source.color_overlays.size());
    style->stroke_count = static_cast<std::uint32_t>(source.strokes.size());
    style->inner_shadow_count =
        static_cast<std::uint32_t>(source.inner_shadows.size());
    style->outer_glow_count =
        static_cast<std::uint32_t>(source.outer_glows.size());
    style->inner_glow_count =
        static_cast<std::uint32_t>(source.inner_glows.size());
    style->satin_count = static_cast<std::uint32_t>(source.satins.size());
    if (!source.drop_shadows.empty()) {
      const auto &value = source.drop_shadows.front();
      style->drop_shadow_present = 1U;
      style->drop_shadow_enabled = value.enabled ? 1U : 0U;
      style->drop_shadow_blend_mode =
          static_cast<std::uint32_t>(value.blend_mode);
      style->drop_shadow_rgb = pack_rgb(value.color);
      style->drop_shadow_opacity = value.opacity;
      style->drop_shadow_angle = value.angle_degrees;
      style->drop_shadow_distance = value.distance;
      style->drop_shadow_spread = value.spread;
      style->drop_shadow_size = value.size;
      style->drop_shadow_layer_conceals = value.layer_conceals ? 1U : 0U;
    }
    if (!source.color_overlays.empty()) {
      const auto &value = source.color_overlays.front();
      style->color_overlay_present = 1U;
      style->color_overlay_enabled = value.enabled ? 1U : 0U;
      style->color_overlay_blend_mode =
          static_cast<std::uint32_t>(value.blend_mode);
      style->color_overlay_rgb = pack_rgb(value.color);
      style->color_overlay_opacity = value.opacity;
    }
    if (!source.strokes.empty()) {
      const auto &value = source.strokes.front();
      style->stroke_present = 1U;
      style->stroke_enabled = value.enabled ? 1U : 0U;
      style->stroke_blend_mode = static_cast<std::uint32_t>(value.blend_mode);
      style->stroke_rgb = pack_rgb(value.color);
      style->stroke_opacity = value.opacity;
      style->stroke_size = value.size;
      style->stroke_position = static_cast<std::uint32_t>(value.position);
      style->stroke_overprint = value.overprint ? 1U : 0U;
    }
    if (!source.inner_shadows.empty()) {
      const auto &value = source.inner_shadows.front();
      style->inner_shadow_present = 1U;
      style->inner_shadow_enabled = value.enabled ? 1U : 0U;
      style->inner_shadow_blend_mode =
          static_cast<std::uint32_t>(value.blend_mode);
      style->inner_shadow_rgb = pack_rgb(value.color);
      style->inner_shadow_opacity = value.opacity;
      style->inner_shadow_angle = value.angle_degrees;
      style->inner_shadow_distance = value.distance;
      style->inner_shadow_choke = value.choke;
      style->inner_shadow_size = value.size;
    }
    if (!source.outer_glows.empty()) {
      const auto &value = source.outer_glows.front();
      style->outer_glow_present = 1U;
      style->outer_glow_enabled = value.enabled ? 1U : 0U;
      style->outer_glow_blend_mode =
          static_cast<std::uint32_t>(value.blend_mode);
      style->outer_glow_rgb = pack_rgb(value.color);
      style->outer_glow_opacity = value.opacity;
      style->outer_glow_spread = value.spread;
      style->outer_glow_size = value.size;
      style->outer_glow_technique =
          static_cast<std::uint32_t>(value.technique);
      style->outer_glow_range = value.range;
    }
    if (!source.inner_glows.empty()) {
      const auto &value = source.inner_glows.front();
      style->inner_glow_present = 1U;
      style->inner_glow_enabled = value.enabled ? 1U : 0U;
      style->inner_glow_blend_mode =
          static_cast<std::uint32_t>(value.blend_mode);
      style->inner_glow_rgb = pack_rgb(value.color);
      style->inner_glow_opacity = value.opacity;
      style->inner_glow_choke = value.choke;
      style->inner_glow_size = value.size;
      style->inner_glow_source = static_cast<std::uint32_t>(value.source);
      style->inner_glow_technique =
          static_cast<std::uint32_t>(value.technique);
      style->inner_glow_range = value.range;
    }
    if (!source.satins.empty()) {
      const auto &value = source.satins.front();
      style->satin_present = 1U;
      style->satin_enabled = value.enabled ? 1U : 0U;
      style->satin_blend_mode = static_cast<std::uint32_t>(value.blend_mode);
      style->satin_rgb = pack_rgb(value.color);
      style->satin_opacity = value.opacity;
      style->satin_angle = value.angle_degrees;
      style->satin_distance = value.distance;
      style->satin_size = value.size;
      style->satin_invert = value.invert ? 1U : 0U;
    }
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown essential layer style projection failure");
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

int patchy_engine_session_replace_rgba8_layer_and_mask(
    patchy_engine_session *session,
    const patchy_engine_pixel_layer_input *pixels,
    const patchy_engine_layer_mask_input *mask,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || pixels == nullptr ||
      mask == nullptr || pixels->struct_size != sizeof(*pixels) ||
      mask->struct_size != sizeof(*mask) || pixels->layer_id == 0 ||
      pixels->layer_id != mask->layer_id || pixels->expected_state_id != mask->expected_state_id ||
      pixels->expected_revision != mask->expected_revision || pixels->rgba == nullptr ||
      mask->gray == nullptr || pixels->width <= 0 || pixels->height <= 0 ||
      mask->width <= 0 || mask->height <= 0 || mask->has_mask == 0 ||
      pixels->bounds.width != pixels->width || pixels->bounds.height != pixels->height ||
      mask->bounds.width != mask->width || mask->bounds.height != mask->height) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete linked pixels and mask replacement is required");
  }
  if (!expected_state(session, pixels->expected_state_id,
                      pixels->expected_revision, error)) return 0;
  const auto pixel_count = static_cast<std::size_t>(pixels->width) *
                           static_cast<std::size_t>(pixels->height);
  const auto mask_count = static_cast<std::size_t>(mask->width) *
                          static_cast<std::size_t>(mask->height);
  if (pixel_count > std::numeric_limits<std::size_t>::max() / 4U ||
      pixels->rgba_size != pixel_count * 4U || mask->gray_size != mask_count) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "linked pixels or mask byte length is invalid");
  }
  try {
    const auto *current = session->value->document().find_layer(pixels->layer_id);
    if (current == nullptr || !current->mask() ||
        !patchy::layer_mask_linked(*current)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "an existing linked raster mask is required");
    }
    patchy::Layer updated = *current;
    patchy::PixelBuffer rgba(pixels->width, pixels->height,
                             patchy::PixelFormat::rgba8());
    std::copy_n(pixels->rgba, pixels->rgba_size, rgba.data().begin());
    updated.set_pixels(std::move(rgba));
    updated.set_bounds({pixels->bounds.x, pixels->bounds.y, pixels->bounds.width,
                        pixels->bounds.height});
    patchy::PixelBuffer gray(mask->width, mask->height,
                             patchy::PixelFormat::gray8());
    std::copy_n(mask->gray, mask->gray_size, gray.data().begin());
    updated.set_mask(patchy::LayerMask{
        {mask->bounds.x, mask->bounds.y, mask->bounds.width, mask->bounds.height},
        std::move(gray), mask->default_color, mask->disabled != 0});
    patchy::set_layer_mask_linked(updated, true);
    const auto result = session->value->execute(
        patchy::engine::CommitPreviewedLayerStates{
            {{pixels->layer_id, std::move(updated)}}, {}, std::nullopt});
    if (!result) return fail(error, result.error);
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate linked transform pixels");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown linked transform failure");
  }
}

int patchy_engine_session_layer_rgba8_pixels(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_buffer *rgba, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || rgba == nullptr ||
      layer_id == 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, layer and pixel output are required");
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  if (layer == nullptr || layer->pixels().empty() ||
      layer->pixels().format() != patchy::PixelFormat::rgba8()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "layer has no editable RGBA8 pixels");
  }
  return copy_buffer(layer->pixels().data(), rgba, error);
}

int patchy_engine_session_layer_thumbnail_rgba8(
    const patchy_engine_session *session, std::uint64_t layer_id,
    std::uint32_t maximum_edge, std::uint32_t *width, std::uint32_t *height,
    patchy_engine_buffer *rgba, patchy_engine_error *error) {
  clear_error(error);
  if (width != nullptr) *width = 0;
  if (height != nullptr) *height = 0;
  if (session == nullptr || session->value == nullptr || layer_id == 0 ||
      maximum_edge == 0 || maximum_edge > 128 || width == nullptr ||
      height == nullptr || rgba == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, layer, 1..128 edge and thumbnail outputs are required");
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  if (layer == nullptr || layer->pixels().empty() ||
      layer->pixels().format() != patchy::PixelFormat::rgba8()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "layer has no thumbnail-compatible RGBA8 pixels");
  }
  try {
    const auto source_width = static_cast<std::uint32_t>(layer->pixels().width());
    const auto source_height = static_cast<std::uint32_t>(layer->pixels().height());
    const auto longest = std::max(source_width, source_height);
    const auto target_edge = std::min(maximum_edge, longest);
    *width = std::max(1U, static_cast<std::uint32_t>(
        (static_cast<std::uint64_t>(source_width) * target_edge + longest - 1U) /
        longest));
    *height = std::max(1U, static_cast<std::uint32_t>(
        (static_cast<std::uint64_t>(source_height) * target_edge + longest - 1U) /
        longest));
    std::vector<std::uint8_t> thumbnail(
        static_cast<std::size_t>(*width) * *height * 4U);
    for (std::uint32_t y = 0; y < *height; ++y) {
      const auto source_y = std::min(source_height - 1U,
          static_cast<std::uint32_t>((static_cast<std::uint64_t>(2U * y + 1U) *
                                      source_height) / (2U * *height)));
      for (std::uint32_t x = 0; x < *width; ++x) {
        const auto source_x = std::min(source_width - 1U,
            static_cast<std::uint32_t>((static_cast<std::uint64_t>(2U * x + 1U) *
                                        source_width) / (2U * *width)));
        const auto *source = layer->pixels().pixel(source_x, source_y);
        auto *target = thumbnail.data() +
            (static_cast<std::size_t>(y) * *width + x) * 4U;
        std::copy_n(source, 4U, target);
      }
    }
    return copy_buffer(thumbnail, rgba, error);
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate bounded layer thumbnail");
  }
}

int patchy_engine_session_set_layer_mask(
    patchy_engine_session *session,
    const patchy_engine_layer_mask_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->layer_id == 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete layer mask input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  try {
    std::optional<patchy::LayerMask> mask;
    if (input->has_mask != 0) {
      if (input->gray == nullptr || input->width <= 0 || input->height <= 0 ||
          input->bounds.width != input->width ||
          input->bounds.height != input->height) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "mask pixels and matching geometry are required");
      }
      const auto width = static_cast<std::size_t>(input->width);
      const auto height = static_cast<std::size_t>(input->height);
      if (width > std::numeric_limits<std::size_t>::max() / height ||
          input->gray_size != width * height) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "mask byte length does not match its geometry");
      }
      patchy::PixelBuffer pixels(input->width, input->height,
                                 patchy::PixelFormat::gray8());
      std::copy_n(input->gray, input->gray_size, pixels.data().begin());
      mask = patchy::LayerMask{
          {input->bounds.x, input->bounds.y, input->bounds.width,
           input->bounds.height},
          std::move(pixels), input->default_color, input->disabled != 0};
    }
    const auto result = session->value->execute(patchy::engine::SetLayerMaskState{
        input->layer_id, std::move(mask), input->linked != 0});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate layer mask pixels");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer mask authoring failure");
  }
}

int patchy_engine_session_set_layer_mask_linked(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, std::uint64_t layer_id,
    std::uint8_t linked, patchy_engine_event *event,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || layer_id == 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and layer are required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) {
    return 0;
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  if (layer == nullptr || !layer->mask().has_value()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "layer-mask link state requires an existing raster mask");
  }
  try {
    auto mask = *layer->mask();
    const auto result = session->value->execute(patchy::engine::SetLayerMaskState{
        layer_id, std::move(mask), linked != 0});
    if (!result) return fail(error, result.error);
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not preserve layer mask while changing link state");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer-mask link-state failure");
  }
}

int patchy_engine_session_layer_mask(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_layer_mask_projection *mask, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || mask == nullptr ||
      mask->struct_size != sizeof(*mask) || layer_id == 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, layer and initialized mask projection are required");
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  if (layer == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "mask layer does not exist");
  }
  const auto struct_size = mask->struct_size;
  *mask = {};
  mask->struct_size = struct_size;
  const auto *source = layer->mask() ? &*layer->mask() : nullptr;
  if (source == nullptr) {
    return 1;
  }
  mask->bounds = {source->bounds.x, source->bounds.y, source->bounds.width,
                  source->bounds.height};
  mask->default_color = source->default_color;
  mask->disabled = source->disabled ? 1U : 0U;
  mask->linked = patchy::layer_mask_linked(*layer) ? 1U : 0U;
  mask->has_mask = 1U;
  return 1;
}

int patchy_engine_session_layer_mask_pixels(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_buffer *gray, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || gray == nullptr ||
      layer_id == 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, layer and mask output are required");
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  if (layer == nullptr || !layer->mask()) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "layer has no raster mask");
  }
  return copy_buffer(layer->mask()->pixels.data(), gray, error);
}

int patchy_engine_session_apply_filter(
    patchy_engine_session *session, const patchy_engine_filter_input *input,
    patchy_engine_filter_progress_fn progress, void *progress_user_data,
    patchy_engine_cancellation *cancellation, patchy_engine_event *event,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->layer_id == 0 ||
      input->parameter_count > 256U || input->selection_count > 65536U ||
      (input->parameter_count != 0 && input->parameters == nullptr) ||
      (input->selection_count != 0 && input->selection == nullptr)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete filter input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  if (cancellation != nullptr && cancellation->value.cancelled()) {
    return fail(error, PATCHY_ENGINE_ERROR_CANCELLED,
                "filter operation was cancelled");
  }
  try {
    patchy::FilterInvocation invocation;
    if (!copy_command_text(input->filter_id, input->filter_id_size, 128U,
                           invocation.filter_id, error)) {
      return 0;
    }
    for (std::size_t index = 0; index < input->parameter_count; ++index) {
      const auto &source = input->parameters[index];
      std::string key;
      if (!copy_command_text(source.key, source.key_size, sizeof(source.key),
                             key, error)) {
        return 0;
      }
      switch (source.kind) {
      case PATCHY_ENGINE_FILTER_PARAMETER_INTEGER:
        invocation.parameters.emplace(std::move(key),
                                      source.value.integer_value);
        break;
      case PATCHY_ENGINE_FILTER_PARAMETER_DOUBLE:
        invocation.parameters.emplace(std::move(key),
                                      source.value.double_value);
        break;
      case PATCHY_ENGINE_FILTER_PARAMETER_BOOLEAN:
        invocation.parameters.emplace(std::move(key),
                                      source.value.boolean_value != 0);
        break;
      case PATCHY_ENGINE_FILTER_PARAMETER_OPTION: {
        std::string value;
        if (!copy_command_text(source.value.option_value.value,
                               source.value.option_value.size,
                               sizeof(source.value.option_value.value), value,
                               error)) {
          return 0;
        }
        invocation.parameters.emplace(std::move(key), std::move(value));
        break;
      }
      default:
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "filter parameter kind is invalid");
      }
    }
    std::vector<patchy::Rect> selection;
    selection.reserve(input->selection_count);
    for (std::size_t index = 0; index < input->selection_count; ++index) {
      const auto &rect = input->selection[index];
      if (rect.width <= 0 || rect.height <= 0) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "filter selection rectangles must be positive");
      }
      selection.push_back({rect.x, rect.y, rect.width, rect.height});
    }
    patchy::FilterProgress filter_progress{
        [progress, progress_user_data, cancellation](
            int completed, int total, patchy::FilterProgressStage stage) {
          if (cancellation != nullptr && cancellation->value.cancelled()) {
            return false;
          }
          return progress == nullptr ||
                 progress(completed, total, static_cast<std::uint32_t>(stage),
                          progress_user_data) != 0;
        }};
    const auto result = session->value->execute(
        patchy::engine::ApplyFilter{input->layer_id, std::move(invocation),
                                   std::move(selection)},
        &filter_progress);
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate filter payload");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown filter authoring failure");
  }
}

int patchy_engine_session_add_text_layer(
    patchy_engine_session *session,
    const patchy_engine_text_layer_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      (input->struct_size != offsetof(patchy_engine_text_layer_input, style_runs) &&
       input->struct_size != sizeof(*input)) ||
      input->size_pixels <= 0.0 ||
      !std::isfinite(input->size_pixels) ||
      !valid_rgba_payload(input->rgba, input->rgba_size, input->width,
                          input->height, input->bounds, error)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete text layer input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  std::string name;
  std::string text_value;
  std::string font;
  if (!copy_command_text(input->name, input->name_size, 256U, name, error) ||
      !copy_command_text(input->text, input->text_size, 1024U, text_value,
                         error) ||
      !copy_command_text(input->font, input->font_size, 256U, font, error)) {
    return 0;
  }
  patchy::psd::PsdTextStyleRun fallback;
  fallback.family = font;
  fallback.size = input->size_pixels;
  fallback.color = {input->red, input->green, input->blue};
  fallback.bold = input->bold != 0;
  fallback.italic = input->italic != 0;
  std::vector<patchy::psd::PsdTextStyleRun> styles;
  std::vector<patchy::psd::PsdTextParagraphRun> paragraphs;
  if (!collect_text_runs(*input, text_value, fallback, styles, paragraphs,
                         error)) {
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
    store_authored_text_metadata(layer, *input, text_value, styles,
                                 paragraphs);
    prepared.add_layer(std::move(layer));
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::Text,
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
                "could not allocate text layer payload");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown text layer authoring failure");
  }
}

int patchy_engine_session_update_text_layer(
    patchy_engine_session *session, std::uint64_t layer_id,
    const patchy_engine_text_layer_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      layer_id == 0 ||
      (input->struct_size != offsetof(patchy_engine_text_layer_input, style_runs) &&
       input->struct_size != sizeof(*input)) ||
      input->size_pixels <= 0.0 || !std::isfinite(input->size_pixels) ||
      !valid_rgba_payload(input->rgba, input->rgba_size, input->width,
                          input->height, input->bounds, error)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete text layer update is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  std::string name;
  std::string text_value;
  std::string font;
  if (!copy_command_text(input->name, input->name_size, 256U, name, error) ||
      !copy_command_text(input->text, input->text_size, 1024U, text_value,
                         error) ||
      !copy_command_text(input->font, input->font_size, 256U, font, error)) {
    return 0;
  }
  patchy::psd::PsdTextStyleRun fallback;
  fallback.family = font;
  fallback.size = input->size_pixels;
  fallback.color = {input->red, input->green, input->blue};
  fallback.bold = input->bold != 0;
  fallback.italic = input->italic != 0;
  std::vector<patchy::psd::PsdTextStyleRun> styles;
  std::vector<patchy::psd::PsdTextParagraphRun> paragraphs;
  if (!collect_text_runs(*input, text_value, fallback, styles, paragraphs,
                         error)) {
    return 0;
  }
  try {
    auto prepared = session->value->document();
    auto *layer = prepared.find_layer(layer_id);
    if (layer == nullptr || !patchy::layer_is_text(*layer)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "layer is not editable text");
    }
    patchy::PixelBuffer pixels(input->width, input->height,
                               patchy::PixelFormat::rgba8());
    std::copy_n(input->rgba, input->rgba_size, pixels.data().begin());
    const auto previous_bounds = layer->bounds();
    const auto previous_transform = metadata_value(
        *layer, patchy::kLayerMetadataTextTransform);
    auto translated_transform = previous_transform.has_value()
        ? patchy::parse_layer_affine_transform(*previous_transform)
        : std::nullopt;
    if (translated_transform.has_value()) {
      (*translated_transform)[4] += input->bounds.x - previous_bounds.x;
      (*translated_transform)[5] += input->bounds.y - previous_bounds.y;
    }
    layer->set_name(std::move(name));
    layer->set_pixels(std::move(pixels));
    layer->set_bounds({input->bounds.x, input->bounds.y, input->bounds.width,
                       input->bounds.height});
    auto &metadata = layer->metadata();
    metadata.erase(patchy::kLayerMetadataTextSourceBlock);
    metadata.erase(patchy::kLayerMetadataTextLayoutMode);
    if (translated_transform.has_value()) {
      metadata[patchy::kLayerMetadataTextTransform] =
          patchy::serialize_layer_affine_transform(*translated_transform);
    }
    store_authored_text_metadata(*layer, *input, text_value, styles,
                                 paragraphs);
    const patchy::Rect affected{0, 0, prepared.width(), prepared.height()};
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::Text,
            input->expected_state_id, std::move(prepared), affected});
    if (!result) return fail(error, result.error);
    result.affected_layer_id = layer_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate text layer update");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown text layer update failure");
  }
}

int patchy_engine_session_text(const patchy_engine_session *session,
                               std::uint64_t layer_id,
                               patchy_engine_text_projection *text,
                               patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || text == nullptr ||
      (text->struct_size != offsetof(patchy_engine_text_projection,
                                     style_run_count) &&
       text->struct_size != sizeof(*text))) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and initialized text projection are required");
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  if (layer == nullptr || !patchy::layer_is_text(*layer)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "layer is not text");
  }
  try {
    const auto struct_size = text->struct_size;
    std::memset(text, 0, struct_size);
    text->struct_size = struct_size;
    project_text(metadata_value(*layer, patchy::kLayerMetadataText)
                     .value_or(std::string_view{}),
                 text->text, text->text_size);
    project_text(metadata_value(*layer, patchy::kLayerMetadataTextFont)
                     .value_or(std::string_view{}),
                 text->font, text->font_size);
    const auto size = metadata_value(
        *layer, patchy::kLayerMetadataTextSize);
    text->size_pixels = size.has_value() ? std::stod(std::string(*size)) : 0.0;
    unsigned red = 0;
    unsigned green = 0;
    unsigned blue = 0;
    const auto color = metadata_value(
        *layer, patchy::kLayerMetadataTextColor);
    if (color.has_value()) {
      std::sscanf(std::string(*color).c_str(), "#%02x%02x%02x", &red, &green,
                  &blue);
    }
    text->red = static_cast<std::uint8_t>(red);
    text->green = static_cast<std::uint8_t>(green);
    text->blue = static_cast<std::uint8_t>(blue);
    text->bold = metadata_value(*layer, patchy::kLayerMetadataTextBold)
                         .value_or(std::string_view{}) == "true";
    text->italic =
        metadata_value(*layer, patchy::kLayerMetadataTextItalic)
            .value_or(std::string_view{}) == "true";
    text->box_text =
        metadata_value(*layer, patchy::kLayerMetadataTextFlow)
            .value_or(std::string_view{}) == "box";
    const auto styles = projected_style_runs(*layer);
    const auto paragraphs = projected_paragraph_runs(*layer);
    if (struct_size == sizeof(*text)) {
      text->style_run_count = static_cast<std::uint32_t>(styles.size());
      text->paragraph_run_count =
          static_cast<std::uint32_t>(paragraphs.size());
    }
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown text projection failure");
  }
}

int patchy_engine_session_text_style_run_at(
    const patchy_engine_session *session, std::uint64_t layer_id,
    std::size_t index, patchy_engine_text_style_run *run,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || run == nullptr ||
      run->struct_size != sizeof(*run)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and initialized text style run are required");
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  if (layer == nullptr || !patchy::layer_is_text(*layer)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "layer is not text");
  }
  try {
    const auto styles = projected_style_runs(*layer);
    if (index >= styles.size()) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "text style run index is out of range");
    }
    const auto struct_size = run->struct_size;
    *run = {};
    run->struct_size = struct_size;
    const auto &source = styles[index];
    run->start = source.start;
    run->length = source.length;
    project_text(source.family, run->font, run->font_size);
    project_text(source.style, run->style, run->style_size);
    run->size_pixels = source.size;
    run->leading = source.leading.value_or(0.0);
    run->tracking = source.tracking;
    run->horizontal_scale = source.horizontal_scale;
    run->vertical_scale = source.vertical_scale;
    run->red = source.color.red;
    run->green = source.color.green;
    run->blue = source.color.blue;
    run->bold = source.bold ? 1U : 0U;
    run->italic = source.italic ? 1U : 0U;
    run->faux_bold = source.faux_bold ? 1U : 0U;
    run->faux_italic = source.faux_italic ? 1U : 0U;
    run->auto_leading = source.auto_leading ? 1U : 0U;
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown text style projection failure");
  }
}

int patchy_engine_session_text_paragraph_run_at(
    const patchy_engine_session *session, std::uint64_t layer_id,
    std::size_t index, patchy_engine_text_paragraph_run *run,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || run == nullptr ||
      run->struct_size != sizeof(*run)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and initialized text paragraph run are required");
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  if (layer == nullptr || !patchy::layer_is_text(*layer)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "layer is not text");
  }
  try {
    const auto paragraphs = projected_paragraph_runs(*layer);
    if (index >= paragraphs.size()) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "text paragraph run index is out of range");
    }
    const auto struct_size = run->struct_size;
    *run = {};
    run->struct_size = struct_size;
    const auto &source = paragraphs[index];
    run->start = source.start;
    run->length = source.length;
    run->justification = static_cast<std::uint32_t>(source.justification);
    run->first_line_indent = source.first_line_indent;
    run->start_indent = source.start_indent;
    run->end_indent = source.end_indent;
    run->space_before = source.space_before;
    run->space_after = source.space_after;
    run->auto_leading_fraction = source.auto_leading_fraction;
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown text paragraph projection failure");
  }
}

int patchy_engine_session_add_smart_object(
    patchy_engine_session *session,
    const patchy_engine_smart_object_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) ||
      input->source_kind > PATCHY_ENGINE_SMART_OBJECT_EXTERNAL ||
      !valid_rgba_payload(input->rgba, input->rgba_size, input->width,
                          input->height, input->bounds, error)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete smart object input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  std::string name;
  std::string filename;
  if (!copy_command_text(input->name, input->name_size, 256U, name, error) ||
      !copy_command_text(input->filename, input->filename_size, 256U, filename,
                         error)) {
    return 0;
  }
  if (std::memchr(input->filetype, '\0', sizeof(input->filetype)) != nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "smart object filetype must contain four bytes");
  }
  try {
    std::string external_uri;
    std::string external_path;
    std::string relative_path;
    if (input->source_kind == PATCHY_ENGINE_SMART_OBJECT_EMBEDDED) {
      if (input->source_bytes == nullptr || input->source_size == 0) {
        return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                    "embedded smart object bytes are required");
      }
    } else {
      if (!copy_command_text(input->external_uri, input->external_uri_size,
                             4096U, external_uri, error) ||
          !copy_command_text(input->external_path, input->external_path_size,
                             4096U, external_path, error) ||
          !copy_command_text(input->relative_path, input->relative_path_size,
                             4096U, relative_path, error)) {
        return 0;
      }
    }
    patchy::PixelBuffer pixels(input->width, input->height,
                               patchy::PixelFormat::rgba8());
    std::copy_n(input->rgba, input->rgba_size, pixels.data().begin());
    auto prepared = session->value->document();
    const auto source_uuid = patchy::generate_smart_object_uuid();
    const std::string filetype(input->filetype, sizeof(input->filetype));
    if (input->source_kind == PATCHY_ENGINE_SMART_OBJECT_EMBEDDED) {
      prepared.metadata().smart_objects.add_embedded(
          source_uuid, filename, filetype,
          std::make_shared<const std::vector<std::uint8_t>>(
              input->source_bytes, input->source_bytes + input->source_size));
    } else {
      patchy::SmartObjectSource source;
      source.kind = patchy::SmartObjectSourceKind::ExternalFile;
      source.uuid = source_uuid;
      source.filename = filename;
      source.filetype = filetype;
      source.external_full_path = std::move(external_uri);
      source.external_original_path = std::move(external_path);
      source.external_rel_path = std::move(relative_path);
      source.external_file_size = input->source_size;
      source.dirty = true;
      patchy::SmartObjectLinkBlock block;
      block.key = "lnkE";
      block.sources.push_back(std::move(source));
      prepared.metadata().smart_objects.blocks.push_back(std::move(block));
    }
    const auto layer_id = prepared.allocate_layer_id();
    patchy::Layer layer(layer_id, std::move(name), std::move(pixels));
    layer.set_bounds({input->bounds.x, input->bounds.y, input->bounds.width,
                      input->bounds.height});
    patchy::SmartObjectPlacement placement;
    placement.uuid = source_uuid;
    placement.transform = {
        static_cast<double>(input->bounds.x),
        static_cast<double>(input->bounds.y),
        static_cast<double>(input->bounds.x + input->bounds.width),
        static_cast<double>(input->bounds.y),
        static_cast<double>(input->bounds.x + input->bounds.width),
        static_cast<double>(input->bounds.y + input->bounds.height),
        static_cast<double>(input->bounds.x),
        static_cast<double>(input->bounds.y + input->bounds.height)};
    placement.width = input->width;
    placement.height = input->height;
    patchy::set_layer_smart_object_metadata(
        layer, placement, patchy::generate_smart_object_uuid(),
        input->source_kind == PATCHY_ENGINE_SMART_OBJECT_EMBEDDED ? "SoLd"
                                                                  : "SoLE",
        input->source_kind == PATCHY_ENGINE_SMART_OBJECT_EMBEDDED ? ""
                                                                  : "external",
        patchy::kSmartObjectRasterStatusPatchy);
    const auto placed_uuid = patchy::smart_object_placed_uuid(layer);
    layer.unknown_psd_blocks().push_back(patchy::UnknownPsdBlock{
        input->source_kind == PATCHY_ENGINE_SMART_OBJECT_EMBEDDED ? "SoLd"
                                                                  : "SoLE",
        patchy::psd::author_placed_layer_sold_payload(placement, placed_uuid)});
    patchy::mark_layer_smart_object_block_dirty(layer);
    prepared.add_layer(std::move(layer));
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::SmartObject,
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
                "could not allocate smart object payload");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown smart object authoring failure");
  }
}

int patchy_engine_session_replace_smart_object(
    patchy_engine_session *session, std::uint64_t layer_id,
    const patchy_engine_smart_object_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || layer_id == 0 ||
      input->source_kind != PATCHY_ENGINE_SMART_OBJECT_EMBEDDED ||
      input->source_bytes == nullptr || input->source_size == 0 ||
      !valid_rgba_payload(input->rgba, input->rgba_size, input->width,
                          input->height, input->bounds, error)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete embedded Smart Object replacement is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  std::string name;
  std::string filename;
  if (!copy_command_text(input->name, input->name_size, 256U, name, error) ||
      !copy_command_text(input->filename, input->filename_size, 256U, filename,
                         error)) {
    return 0;
  }
  if (std::memchr(input->filetype, '\0', sizeof(input->filetype)) != nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "smart object filetype must contain four bytes");
  }
  try {
    auto prepared = session->value->document();
    auto *layer = prepared.find_layer(layer_id);
    if (layer == nullptr || !patchy::layer_is_smart_object(*layer) ||
        !patchy::smart_object_lock_reason(*layer).empty()) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "editable embedded Smart Object is required");
    }
    const auto placed_uuid = patchy::smart_object_placed_uuid(*layer);
    if (placed_uuid.empty()) {
      return fail(error, PATCHY_ENGINE_ERROR_ENGINE,
                  "Smart Object placement is incomplete");
    }
    patchy::PixelBuffer pixels(input->width, input->height,
                               patchy::PixelFormat::rgba8());
    std::copy_n(input->rgba, input->rgba_size, pixels.data().begin());
    const auto source_uuid = patchy::generate_smart_object_uuid();
    prepared.metadata().smart_objects.add_embedded(
        source_uuid, filename,
        std::string(input->filetype, sizeof(input->filetype)),
        std::make_shared<const std::vector<std::uint8_t>>(
            input->source_bytes, input->source_bytes + input->source_size));
    layer = prepared.find_layer(layer_id);
    layer->set_name(std::move(name));
    layer->set_pixels(std::move(pixels));
    layer->set_bounds({input->bounds.x, input->bounds.y, input->bounds.width,
                       input->bounds.height});
    patchy::SmartObjectPlacement placement;
    placement.uuid = source_uuid;
    placement.transform = {
        static_cast<double>(input->bounds.x), static_cast<double>(input->bounds.y),
        static_cast<double>(input->bounds.x + input->bounds.width), static_cast<double>(input->bounds.y),
        static_cast<double>(input->bounds.x + input->bounds.width),
        static_cast<double>(input->bounds.y + input->bounds.height),
        static_cast<double>(input->bounds.x), static_cast<double>(input->bounds.y + input->bounds.height)};
    placement.width = input->width;
    placement.height = input->height;
    patchy::set_layer_smart_object_metadata(
        *layer, placement, placed_uuid, "SoLd", "",
        patchy::kSmartObjectRasterStatusPatchy);
    if (const auto *stack = layer->smart_filter_stack(); stack != nullptr) {
      const auto document_bounds = patchy::Rect::from_size(
          prepared.width(), prepared.height());
      auto effects = prepared.metadata().smart_filter_effects;
      auto record = patchy::psd::author_filter_effects_record(
          placed_uuid, document_bounds, layer->pixels(), layer->bounds(),
          stack->mask);
      if (!record.has_value() || !effects.upsert_authored(std::move(*record))) {
        return fail(error, PATCHY_ENGINE_ERROR_ENGINE,
                    "could not replace Smart Filter cache");
      }
      const auto rendered = patchy::render_smart_filter_stack(
          layer->pixels(), layer->bounds(), document_bounds, *stack);
      prepared.metadata().smart_filter_effects = std::move(effects);
      layer->set_pixels(rendered.pixels);
      layer->set_bounds(rendered.bounds);
    }
    auto &blocks = layer->unknown_psd_blocks();
    blocks.erase(std::remove_if(blocks.begin(), blocks.end(),
                                [](const patchy::UnknownPsdBlock &block) {
                                  return block.key == "SoLd" || block.key == "SoLE" ||
                                         block.key == "PlLd" || block.key == "plLd";
                                }),
                 blocks.end());
    blocks.push_back(patchy::UnknownPsdBlock{
        "SoLd", patchy::psd::author_placed_layer_sold_payload(
                    placement, placed_uuid, layer->smart_filter_stack())});
    patchy::mark_layer_smart_object_block_dirty(*layer);
    const auto dirty_bounds = layer->bounds();
    const auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::SmartObject,
            input->expected_state_id, std::move(prepared),
            dirty_bounds});
    if (!result) return fail(error, result.error);
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate Smart Object replacement");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_ENGINE, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown Smart Object replacement failure");
  }
}

int patchy_engine_session_smart_object(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_smart_object_projection *smart_object,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr ||
      smart_object == nullptr || smart_object->struct_size != sizeof(*smart_object)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and initialized smart object projection are required");
  }
  try {
    const auto *layer = session->value->document().find_layer(layer_id);
    if (layer == nullptr || !patchy::layer_is_smart_object(*layer)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "layer is not a smart object");
    }
    const auto *source =
        session->value->document().metadata().smart_objects.find(
            patchy::smart_object_source_uuid(*layer));
    if (source == nullptr) {
      return fail(error, PATCHY_ENGINE_ERROR_ENGINE,
                  "smart object source is missing");
    }
    const auto struct_size = smart_object->struct_size;
    *smart_object = {};
    smart_object->struct_size = struct_size;
    smart_object->source_kind =
        source->kind == patchy::SmartObjectSourceKind::Embedded
            ? PATCHY_ENGINE_SMART_OBJECT_EMBEDDED
            : PATCHY_ENGINE_SMART_OBJECT_EXTERNAL;
    project_text(source->filename, smart_object->filename,
                 smart_object->filename_size);
    std::copy_n(
        source->filetype.data(),
        std::min(source->filetype.size(), sizeof(smart_object->filetype)),
        smart_object->filetype);
    smart_object->source_size = source->file_bytes != nullptr
                                    ? source->file_bytes->size()
                                    : source->external_file_size;
    smart_object->editable =
        source->kind == patchy::SmartObjectSourceKind::Embedded &&
        source->file_bytes != nullptr &&
        patchy::smart_object_lock_reason(*layer).empty();
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate smart object projection");
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown smart object projection failure");
  }
}

int patchy_engine_session_smart_object_bytes(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_buffer *bytes, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  try {
    const auto *layer = session->value->document().find_layer(layer_id);
    if (layer == nullptr || !patchy::layer_is_smart_object(*layer)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "layer is not a smart object");
    }
    const auto *source =
        session->value->document().metadata().smart_objects.find(
            patchy::smart_object_source_uuid(*layer));
    if (source == nullptr || source->file_bytes == nullptr) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "smart object has no embedded bytes");
    }
    return copy_buffer(*source->file_bytes, bytes, error);
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not project smart object bytes");
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown smart object byte projection failure");
  }
}

int patchy_engine_session_set_adjustment(
    patchy_engine_session *session,
    const patchy_engine_adjustment_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) ||
      input->kind > PATCHY_ENGINE_ADJUSTMENT_BRIGHTNESS_CONTRAST ||
      input->curve_point_count > 64U ||
      (input->curve_point_count != 0 && input->curve_points == nullptr) ||
      (input->update_existing != 0 && input->layer_id == 0)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete adjustment input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  try {
    patchy::AdjustmentSettings settings;
    settings.kind = static_cast<patchy::AdjustmentKind>(input->kind);
    switch (input->kind) {
    case PATCHY_ENGINE_ADJUSTMENT_LEVELS:
      settings.levels = {input->values[0], input->values[1], input->values[2],
                         input->values[3], input->values[4]};
      break;
    case PATCHY_ENGINE_ADJUSTMENT_CURVES:
      settings.curves.rgb.clear();
      settings.curves.rgb.reserve(input->curve_point_count);
      for (std::size_t index = 0; index < input->curve_point_count; ++index) {
        settings.curves.rgb.push_back({input->curve_points[index].input,
                                       input->curve_points[index].output});
      }
      break;
    case PATCHY_ENGINE_ADJUSTMENT_HUE_SATURATION:
      settings.hue_saturation = {
          input->values[0], input->values[1], input->values[2],
          input->values[3] != 0, input->values[4], input->values[5],
          input->values[6]};
      break;
    case PATCHY_ENGINE_ADJUSTMENT_COLOR_BALANCE:
      settings.color_balance = {input->values[0], input->values[1],
                                input->values[2]};
      break;
    case PATCHY_ENGINE_ADJUSTMENT_INVERT:
      break;
    case PATCHY_ENGINE_ADJUSTMENT_POSTERIZE:
      settings.posterize.levels = input->values[0];
      break;
    case PATCHY_ENGINE_ADJUSTMENT_THRESHOLD:
      settings.threshold.level = input->values[0];
      break;
    case PATCHY_ENGINE_ADJUSTMENT_BRIGHTNESS_CONTRAST:
      settings.brightness_contrast = {input->values[0], input->values[1],
                                      input->values[2] != 0};
      break;
    default:
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "adjustment kind is invalid");
    }
    CommandResult result;
    if (input->update_existing != 0) {
      result = session->value->execute(
          patchy::engine::UpdateAdjustmentLayer{input->layer_id, settings});
    } else {
      std::string name;
      if (!copy_command_text(input->name, input->name_size, 256U, name,
                             error)) {
        return 0;
      }
      result = session->value->execute(
          patchy::engine::AddAdjustmentLayer{std::move(name), settings, {}});
    }
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate adjustment payload");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown adjustment authoring failure");
  }
}

int patchy_engine_session_adjustment(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_adjustment_projection *adjustment,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || adjustment == nullptr ||
      adjustment->struct_size != sizeof(*adjustment)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and initialized adjustment projection are required");
  }
  try {
    const auto *layer = session->value->document().find_layer(layer_id);
    const auto settings = layer == nullptr
                              ? std::optional<patchy::AdjustmentSettings>{}
                              : patchy::adjustment_settings_from_layer(*layer);
    if (!settings.has_value()) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "layer is not an adjustment");
    }
    const auto struct_size = adjustment->struct_size;
    *adjustment = {};
    adjustment->struct_size = struct_size;
    adjustment->kind = static_cast<std::uint32_t>(settings->kind);
    switch (settings->kind) {
    case patchy::AdjustmentKind::Levels:
      adjustment->values[0] = settings->levels.black_input;
      adjustment->values[1] = settings->levels.white_input;
      adjustment->values[2] = settings->levels.gamma_percent;
      adjustment->values[3] = settings->levels.black_output;
      adjustment->values[4] = settings->levels.white_output;
      break;
    case patchy::AdjustmentKind::Curves:
      adjustment->curve_point_count = settings->curves.rgb.size();
      break;
    case patchy::AdjustmentKind::HueSaturation:
      adjustment->values[0] = settings->hue_saturation.hue_shift;
      adjustment->values[1] = settings->hue_saturation.saturation_delta;
      adjustment->values[2] = settings->hue_saturation.lightness_delta;
      adjustment->values[3] = settings->hue_saturation.colorize;
      adjustment->values[4] = settings->hue_saturation.colorize_hue;
      adjustment->values[5] = settings->hue_saturation.colorize_saturation;
      adjustment->values[6] = settings->hue_saturation.colorize_lightness;
      break;
    case patchy::AdjustmentKind::ColorBalance:
      adjustment->values[0] = settings->color_balance.cyan_red;
      adjustment->values[1] = settings->color_balance.magenta_green;
      adjustment->values[2] = settings->color_balance.yellow_blue;
      break;
    case patchy::AdjustmentKind::Invert:
      break;
    case patchy::AdjustmentKind::Posterize:
      adjustment->values[0] = settings->posterize.levels;
      break;
    case patchy::AdjustmentKind::Threshold:
      adjustment->values[0] = settings->threshold.level;
      break;
    case patchy::AdjustmentKind::BrightnessContrast:
      adjustment->values[0] = settings->brightness_contrast.brightness;
      adjustment->values[1] = settings->brightness_contrast.contrast;
      adjustment->values[2] = settings->brightness_contrast.use_legacy;
      break;
    }
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not project adjustment payload");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown adjustment projection failure");
  }
}

int patchy_engine_session_adjustment_curve_point_at(
    const patchy_engine_session *session, std::uint64_t layer_id,
    std::size_t index, patchy_engine_curve_point *point,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || point == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and curve point output are required");
  }
  try {
    const auto *layer = session->value->document().find_layer(layer_id);
    const auto settings = layer == nullptr
                              ? std::optional<patchy::AdjustmentSettings>{}
                              : patchy::adjustment_settings_from_layer(*layer);
    if (!settings.has_value() ||
        settings->kind != patchy::AdjustmentKind::Curves ||
        index >= settings->curves.rgb.size()) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "RGB curve point index is invalid");
    }
    *point = {settings->curves.rgb[index].input,
              settings->curves.rgb[index].output};
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not project curve point");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown curve point projection failure");
  }
}

int patchy_engine_session_set_vector_mask(
    patchy_engine_session *session,
    const patchy_engine_vector_mask_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->layer_id == 0 ||
      !std::isfinite(input->feather) || input->feather < 0.0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete vector mask input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  try {
    std::optional<patchy::LayerVectorMask> mask;
    if (input->has_mask != 0) {
      const auto path = vector_path_from_input(input->path, error);
      if (!path.has_value()) {
        return 0;
      }
      mask.emplace();
      mask->path = *path;
      mask->feather = input->feather;
      mask->density = input->density;
      mask->disabled = input->disabled != 0;
      mask->inverted = input->inverted != 0;
      mask->unlinked = input->unlinked != 0;
      mask->hides_effects = input->hides_effects != 0;
    }
    const auto result = session->value->execute(
        patchy::engine::SetVectorMaskState{input->layer_id, std::move(mask)});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate vector mask payload");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown vector mask authoring failure");
  }
}

int patchy_engine_session_vector_mask(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_vector_mask_projection *mask, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || mask == nullptr ||
      mask->struct_size != sizeof(*mask)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and initialized vector mask projection are required");
  }
  const auto *layer = session->value->document().find_layer(layer_id);
  const auto *source = layer == nullptr ? nullptr : layer->vector_mask();
  if (source == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "layer has no vector mask");
  }
  const auto struct_size = mask->struct_size;
  *mask = {};
  mask->struct_size = struct_size;
  mask->subpath_count = source->path.subpaths.size();
  for (const auto &subpath : source->path.subpaths) {
    mask->anchor_count += subpath.anchors.size();
  }
  mask->feather = source->feather;
  mask->density = source->density;
  mask->disabled = source->disabled;
  mask->inverted = source->inverted;
  mask->unlinked = source->unlinked;
  mask->hides_effects = source->hides_effects;
  return 1;
}

int patchy_engine_session_set_smart_filter(
    patchy_engine_session *session,
    const patchy_engine_smart_filter_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || input->layer_id == 0 ||
      input->kind < PATCHY_ENGINE_SMART_FILTER_GAUSSIAN_BLUR ||
      input->kind > PATCHY_ENGINE_SMART_FILTER_BOX_BLUR ||
      !std::isfinite(input->amount)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete Smart Filter input is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) {
    return 0;
  }
  try {
    const auto *layer = session->value->document().find_layer(input->layer_id);
    if (layer == nullptr || !patchy::layer_is_smart_object(*layer) ||
        patchy::smart_object_lock_reason(*layer) != "") {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "editable embedded Smart Object is required");
    }
    const auto placement = patchy::smart_object_placement_from_layer(*layer);
    const auto placed_uuid = patchy::smart_object_placed_uuid(*layer);
    if (!placement.has_value() || placed_uuid.empty()) {
      return fail(error, PATCHY_ENGINE_ERROR_ENGINE,
                  "Smart Object placement is incomplete");
    }
    patchy::SmartFilterEntry entry;
    entry.enabled = input->enabled != 0;
    entry.native_name = "Gaussian Blur...";
    entry.native_class_id = "GsnB";
    entry.native_filter_id = 0x47736e42U;
    switch (input->kind) {
    case PATCHY_ENGINE_SMART_FILTER_GAUSSIAN_BLUR:
      entry.kind = patchy::SmartFilterKind::GaussianBlur;
      entry.parameters = patchy::GaussianBlurSmartFilter{
          std::clamp(input->amount, 0.1, 1000.0)};
      break;
    case PATCHY_ENGINE_SMART_FILTER_HIGH_PASS:
      entry.kind = patchy::SmartFilterKind::HighPass;
      entry.native_name = "High Pass...";
      entry.native_class_id = "HghP";
      entry.native_filter_id = 0x48676850U;
      entry.parameters = patchy::HighPassSmartFilter{
          std::clamp(input->amount, 0.1, 1000.0)};
      break;
    case PATCHY_ENGINE_SMART_FILTER_MEDIAN:
      entry.kind = patchy::SmartFilterKind::Median;
      entry.native_name = "Median...";
      entry.native_class_id = "Mdn ";
      entry.native_filter_id = 0x4d646e20U;
      entry.parameters = patchy::MedianSmartFilter{
          std::clamp(input->amount, 1.0, 500.0)};
      break;
    case PATCHY_ENGINE_SMART_FILTER_MOSAIC:
      entry.kind = patchy::SmartFilterKind::Mosaic;
      entry.native_name = "Mosaic...";
      entry.native_class_id = "Msc ";
      entry.native_filter_id = 0x4d736320U;
      entry.parameters = patchy::MosaicSmartFilter{static_cast<std::int32_t>(
          std::clamp(std::lround(input->amount), 2L, 200L))};
      break;
    case PATCHY_ENGINE_SMART_FILTER_BOX_BLUR:
      entry.kind = patchy::SmartFilterKind::BoxBlur;
      entry.native_name = "Box Blur...";
      entry.native_class_id = "boxblur";
      entry.native_filter_id = 843U;
      entry.parameters = patchy::BoxBlurSmartFilter{
          std::clamp(input->amount, 1.0, 2000.0)};
      break;
    default:
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "Smart Filter kind is invalid");
    }
    patchy::SmartFilterStack stack;
    stack.support = patchy::SmartFilterStackSupport::Supported;
    stack.entries.push_back(std::move(entry));
    stack.mask.bounds = patchy::Rect::from_size(
        session->value->document().width(), session->value->document().height());
    stack.mask.pixels = patchy::PixelBuffer(
        session->value->document().width(), session->value->document().height(),
        patchy::PixelFormat::gray8());
    stack.mask.pixels.clear(255U);
    stack.mask.linked = false;
    const auto document_bounds = patchy::Rect::from_size(
        session->value->document().width(), session->value->document().height());
    const auto rendered = patchy::render_smart_filter_stack(
        layer->pixels(), layer->bounds(), document_bounds, stack);
    std::vector<std::pair<std::size_t, std::vector<std::uint8_t>>> blocks;
    const auto &unknown = layer->unknown_psd_blocks();
    for (std::size_t index = 0; index < unknown.size(); ++index) {
      if (unknown[index].key == "SoLd") {
        blocks.emplace_back(
            index, patchy::psd::author_placed_layer_sold_payload(
                       *placement, placed_uuid, &stack));
      }
    }
    if (blocks.empty()) {
      return fail(error, PATCHY_ENGINE_ERROR_ENGINE,
                  "Smart Object has no editable SoLd block");
    }
    auto effects =
        session->value->document().metadata().smart_filter_effects;
    auto record = patchy::psd::author_filter_effects_record(
        placed_uuid, document_bounds, layer->pixels(), layer->bounds(),
        stack.mask);
    if (!record.has_value() || !effects.upsert_authored(std::move(*record))) {
      return fail(error, PATCHY_ENGINE_ERROR_ENGINE,
                  "could not author Smart Filter cache");
    }
    const auto result = session->value->execute(
        patchy::engine::CommitSmartFilterState{
            input->layer_id, stack, rendered.pixels, rendered.bounds,
            std::move(blocks), std::move(effects)});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const patchy::FilterCancelled &) {
    return fail(error, PATCHY_ENGINE_ERROR_CANCELLED,
                "Smart Filter rendering was cancelled");
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate Smart Filter payload");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_ENGINE, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown Smart Filter authoring failure");
  }
}

int patchy_engine_session_smart_filter(
    const patchy_engine_session *session, std::uint64_t layer_id,
    patchy_engine_smart_filter_projection *filter,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || filter == nullptr ||
      filter->struct_size != sizeof(*filter)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and initialized Smart Filter projection are required");
  }
  try {
    const auto *layer = session->value->document().find_layer(layer_id);
    const auto *stack =
        layer == nullptr ? nullptr : layer->smart_filter_stack();
    if (stack == nullptr || stack->entries.empty()) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "layer has no Smart Filters");
    }
    const auto struct_size = filter->struct_size;
    *filter = {};
    filter->struct_size = struct_size;
    filter->entry_count = stack->entries.size();
    const auto &entry = stack->entries.front();
    filter->enabled = entry.enabled;
    switch (entry.kind) {
    case patchy::SmartFilterKind::GaussianBlur:
      filter->first_kind = PATCHY_ENGINE_SMART_FILTER_GAUSSIAN_BLUR;
      filter->first_amount =
          std::get<patchy::GaussianBlurSmartFilter>(entry.parameters)
              .radius_pixels;
      break;
    case patchy::SmartFilterKind::HighPass:
      filter->first_kind = PATCHY_ENGINE_SMART_FILTER_HIGH_PASS;
      filter->first_amount =
          std::get<patchy::HighPassSmartFilter>(entry.parameters).radius_pixels;
      break;
    case patchy::SmartFilterKind::Median:
      filter->first_kind = PATCHY_ENGINE_SMART_FILTER_MEDIAN;
      filter->first_amount =
          std::get<patchy::MedianSmartFilter>(entry.parameters).radius_pixels;
      break;
    case patchy::SmartFilterKind::Mosaic:
      filter->first_kind = PATCHY_ENGINE_SMART_FILTER_MOSAIC;
      filter->first_amount =
          std::get<patchy::MosaicSmartFilter>(entry.parameters)
              .cell_size_pixels;
      break;
    case patchy::SmartFilterKind::BoxBlur:
      filter->first_kind = PATCHY_ENGINE_SMART_FILTER_BOX_BLUR;
      filter->first_amount =
          std::get<patchy::BoxBlurSmartFilter>(entry.parameters).radius_pixels;
      break;
    default:
      return fail(error, PATCHY_ENGINE_ERROR_ENGINE,
                  "first Smart Filter kind is not projectable");
    }
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not project Smart Filter payload");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown Smart Filter projection failure");
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

int patchy_engine_session_update_document_path(
    patchy_engine_session *session, std::uint64_t path_id,
    const patchy_engine_document_path_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || path_id == 0 ||
      input->kind > PATCHY_ENGINE_PATH_WORK) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete document-path update is required");
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
    auto prepared = session->value->document();
    auto *target = prepared.find_path(path_id);
    if (target == nullptr) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "updated document path does not exist");
    }
    patchy::DocumentPath updated(
        path_id, std::move(name),
        static_cast<patchy::DocumentPathKind>(input->kind), std::move(*path));
    updated.set_clipping_path(input->clipping != 0);
    *target = std::move(updated);
    if (input->clipping != 0) {
      for (auto &candidate : prepared.paths()) {
        if (candidate.id() != path_id) {
          candidate.set_clipping_path(false);
        }
      }
    }
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::Path,
            input->expected_state_id, std::move(prepared), {}});
    if (!result) {
      return fail(error, result.error);
    }
    result.affected_layer_id = path_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate updated document path");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown document-path update failure");
  }
}

int patchy_engine_session_merge_visible_copy(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, const char *name, std::size_t name_size,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) {
    return 0;
  }
  std::string layer_name;
  if (!copy_command_text(name, name_size, 256U, layer_name, error)) {
    return 0;
  }
  try {
    const auto pixels =
        patchy::flatten_document_rgba8(session->value->document());
    auto prepared = session->value->document();
    const auto layer_id = prepared.allocate_layer_id();
    prepared.add_layer(patchy::Layer(layer_id, std::move(layer_name), pixels));
    prepared.set_active_layer(layer_id);
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::MergeRasterize,
            expected_state_id, std::move(prepared),
            patchy::Rect::from_size(pixels.width(), pixels.height())});
    if (!result) {
      return fail(error, result.error);
    }
    result.affected_layer_id = layer_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate merged visible copy");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown merge-visible failure");
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

int patchy_engine_session_update_vector_shape(
    patchy_engine_session *session, std::uint64_t layer_id,
    const patchy_engine_vector_shape_input *input,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || input == nullptr ||
      input->struct_size != sizeof(*input) || layer_id == 0 ||
      !std::isfinite(input->stroke_width) || input->stroke_width < 0.0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "complete vector-shape update is required");
  }
  if (!expected_state(session, input->expected_state_id,
                      input->expected_revision, error)) return 0;
  auto path = vector_path_from_input(input->path, error);
  if (!path.has_value()) return 0;
  try {
    patchy::VectorShapeContent content;
    content.path = std::move(*path);
    content.fill.kind = patchy::VectorFillKind::Solid;
    content.fill.color = {input->fill_red, input->fill_green, input->fill_blue};
    content.stroke.enabled = input->stroke_enabled != 0;
    content.stroke.width = input->stroke_width;
    content.stroke.content.kind = patchy::VectorFillKind::Solid;
    content.stroke.content.color = {input->stroke_red, input->stroke_green,
                                    input->stroke_blue};
    const auto result = session->value->execute(
        patchy::engine::UpdateVectorShapeLayer{
            layer_id, std::move(content),
            session->value->document().metadata().patterns});
    if (!result) return fail(error, result.error);
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate vector-shape update");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown vector-shape update failure");
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
    case PATCHY_ENGINE_COMMAND_GROW_SELECTION:
      result = session->value->execute(patchy::engine::SelectByColorSimilarity{
          patchy::engine::SelectionSimilarityMode::Grow,
          command->payload.selection_tolerance.tolerance});
      break;
    case PATCHY_ENGINE_COMMAND_SELECT_SIMILAR:
      result = session->value->execute(patchy::engine::SelectByColorSimilarity{
          patchy::engine::SelectionSimilarityMode::Similar,
          command->payload.selection_tolerance.tolerance});
      break;
    case PATCHY_ENGINE_COMMAND_SET_LAYER_STYLE_PRESET: {
      std::string preset_id;
      if (command->payload.set_layer_style_preset.preset_id_size != 0 &&
          !copy_command_text(
              command->payload.set_layer_style_preset.preset_id,
              command->payload.set_layer_style_preset.preset_id_size,
              sizeof(command->payload.set_layer_style_preset.preset_id),
              preset_id, error)) {
        return 0;
      }
      result = session->value->execute(patchy::engine::SetLayerStylePreset{
          command->payload.set_layer_style_preset.layer_id,
          std::move(preset_id)});
      break;
    }
    case PATCHY_ENGINE_COMMAND_SET_ESSENTIAL_LAYER_STYLE: {
      const auto &input = command->payload.set_essential_layer_style;
      const auto rgb = [](std::uint32_t value) {
        return patchy::RgbColor{
            static_cast<std::uint8_t>((value >> 16U) & 0xFFU),
            static_cast<std::uint8_t>((value >> 8U) & 0xFFU),
            static_cast<std::uint8_t>(value & 0xFFU)};
      };
      patchy::engine::SetEssentialLayerStyle value{};
      value.layer_id = input.layer_id;
      value.effects_visible = input.effects_visible != 0U;
      value.layer_mask_hides_effects =
          input.layer_mask_hides_effects != 0U;
      if (input.drop_shadow_present != 0U) {
        patchy::LayerDropShadow shadow{};
        shadow.enabled = input.drop_shadow_enabled != 0U;
        shadow.blend_mode =
            static_cast<patchy::BlendMode>(input.drop_shadow_blend_mode);
        shadow.color = rgb(input.drop_shadow_rgb);
        shadow.opacity = input.drop_shadow_opacity;
        shadow.angle_degrees = input.drop_shadow_angle;
        shadow.distance = input.drop_shadow_distance;
        shadow.spread = input.drop_shadow_spread;
        shadow.size = input.drop_shadow_size;
        shadow.layer_conceals = input.drop_shadow_layer_conceals != 0U;
        value.drop_shadow = shadow;
      }
      if (input.color_overlay_present != 0U) {
        patchy::LayerColorOverlay overlay{};
        overlay.enabled = input.color_overlay_enabled != 0U;
        overlay.blend_mode =
            static_cast<patchy::BlendMode>(input.color_overlay_blend_mode);
        overlay.color = rgb(input.color_overlay_rgb);
        overlay.opacity = input.color_overlay_opacity;
        value.color_overlay = overlay;
      }
      if (input.stroke_present != 0U) {
        patchy::LayerStroke stroke{};
        stroke.enabled = input.stroke_enabled != 0U;
        stroke.blend_mode =
            static_cast<patchy::BlendMode>(input.stroke_blend_mode);
        stroke.color = rgb(input.stroke_rgb);
        stroke.opacity = input.stroke_opacity;
        stroke.size = input.stroke_size;
        stroke.position =
            static_cast<patchy::LayerStrokePosition>(input.stroke_position);
        stroke.overprint = input.stroke_overprint != 0U;
        value.stroke = stroke;
      }
      if (input.inner_shadow_present != 0U) {
        patchy::LayerInnerShadow shadow{};
        shadow.enabled = input.inner_shadow_enabled != 0U;
        shadow.blend_mode =
            static_cast<patchy::BlendMode>(input.inner_shadow_blend_mode);
        shadow.color = rgb(input.inner_shadow_rgb);
        shadow.opacity = input.inner_shadow_opacity;
        shadow.angle_degrees = input.inner_shadow_angle;
        shadow.distance = input.inner_shadow_distance;
        shadow.choke = input.inner_shadow_choke;
        shadow.size = input.inner_shadow_size;
        value.inner_shadow = shadow;
      }
      if (input.outer_glow_present != 0U) {
        patchy::LayerOuterGlow glow{};
        glow.enabled = input.outer_glow_enabled != 0U;
        glow.blend_mode =
            static_cast<patchy::BlendMode>(input.outer_glow_blend_mode);
        glow.color = rgb(input.outer_glow_rgb);
        glow.opacity = input.outer_glow_opacity;
        glow.spread = input.outer_glow_spread;
        glow.size = input.outer_glow_size;
        glow.technique =
            static_cast<patchy::LayerGlowTechnique>(input.outer_glow_technique);
        glow.range = input.outer_glow_range;
        value.outer_glow = glow;
      }
      if (input.inner_glow_present != 0U) {
        patchy::LayerInnerGlow glow{};
        glow.enabled = input.inner_glow_enabled != 0U;
        glow.blend_mode =
            static_cast<patchy::BlendMode>(input.inner_glow_blend_mode);
        glow.color = rgb(input.inner_glow_rgb);
        glow.opacity = input.inner_glow_opacity;
        glow.choke = input.inner_glow_choke;
        glow.size = input.inner_glow_size;
        glow.source =
            static_cast<patchy::LayerInnerGlowSource>(input.inner_glow_source);
        glow.technique =
            static_cast<patchy::LayerGlowTechnique>(input.inner_glow_technique);
        glow.range = input.inner_glow_range;
        value.inner_glow = glow;
      }
      if (input.satin_present != 0U) {
        patchy::LayerSatin satin{};
        satin.enabled = input.satin_enabled != 0U;
        satin.blend_mode =
            static_cast<patchy::BlendMode>(input.satin_blend_mode);
        satin.color = rgb(input.satin_rgb);
        satin.opacity = input.satin_opacity;
        satin.angle_degrees = input.satin_angle;
        satin.distance = input.satin_distance;
        satin.size = input.satin_size;
        satin.invert = input.satin_invert != 0U;
        value.satin = satin;
      }
      result = session->value->execute(value);
      break;
    }
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

int patchy_engine_session_set_layer_visibility(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, std::uint64_t layer_id,
    std::uint8_t visible, patchy_engine_event *event,
    patchy_engine_error *error) {
  patchy_engine_command command{};
  command.struct_size = sizeof(command);
  command.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  command.type = PATCHY_ENGINE_COMMAND_SET_LAYER_VISIBILITY;
  command.expected_state_id = expected_state_id;
  command.expected_revision = expected_revision;
  command.payload.set_layer_visibility = {layer_id,
                                          static_cast<std::uint8_t>(visible != 0)};
  return patchy_engine_session_execute(session, &command, event, error);
}

int patchy_engine_session_move_layer(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, std::uint64_t layer_id,
    std::uint64_t target_layer_id, std::uint32_t position,
    std::uint8_t has_target_layer, patchy_engine_event *event,
    patchy_engine_error *error) {
  patchy_engine_command command{};
  command.struct_size = sizeof(command);
  command.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  command.type = PATCHY_ENGINE_COMMAND_MOVE_LAYER;
  command.expected_state_id = expected_state_id;
  command.expected_revision = expected_revision;
  command.payload.move_layer = {layer_id, target_layer_id, position,
                                static_cast<std::uint8_t>(has_target_layer != 0)};
  return patchy_engine_session_execute(session, &command, event, error);
}

int patchy_engine_session_group_layer(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, std::uint64_t layer_id,
    const char *name, std::size_t name_size, patchy_engine_event *event,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || layer_id == 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and layer are required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) {
    return 0;
  }
  std::string group_name;
  if (!copy_command_text(name, name_size, 256U, group_name, error)) {
    return 0;
  }
  try {
    auto result = session->value->execute(
        patchy::engine::AddGroup{std::move(group_name), {layer_id}});
    if (!result) {
      return fail(error, result.error);
    }
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown group-layer failure");
  }
}

int patchy_engine_session_copy_layer(
    patchy_engine_session *target, std::uint64_t expected_target_state_id,
    std::uint64_t expected_target_revision,
    const patchy_engine_session *source,
    std::uint64_t expected_source_state_id,
    std::uint64_t expected_source_revision, std::uint64_t source_layer_id,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (target == nullptr || target->value == nullptr || source == nullptr ||
      source->value == nullptr || source_layer_id == 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "source, target and source layer are required");
  }
  if (!expected_state(target, expected_target_state_id,
                      expected_target_revision, error) ||
      !expected_state(source, expected_source_state_id,
                      expected_source_revision, error)) {
    return 0;
  }
  try {
    const auto &source_document = source->value->document();
    const auto *source_layer = source_document.find_layer(source_layer_id);
    if (source_layer == nullptr) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "source layer does not exist");
    }
    if (source_document.format() != target->value->document().format()) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  "source and target pixel formats must match");
    }
    if (!transferable_layer_tree(*source_layer, error)) {
      return 0;
    }

    auto prepared = target->value->document();
    std::set<std::uint32_t> photoshop_ids;
    const auto collect_ids = [&photoshop_ids](
                                 const auto &self,
                                 const std::vector<patchy::Layer> &layers) -> void {
      for (const auto &layer : layers) {
        if (const auto id = patchy::photoshop_layer_id(layer); id.has_value()) {
          photoshop_ids.insert(*id);
        }
        self(self, layer.children());
      }
    };
    collect_ids(collect_ids, prepared.layers());
    auto next_photoshop_id =
        patchy::next_photoshop_layer_id(prepared.layers());
    auto clone = clone_transferable_layer(*source_layer, prepared,
                                          photoshop_ids, next_photoshop_id);
    const auto new_layer_id = clone.id();
    const auto affected = clone.bounds();
    prepared.add_layer(std::move(clone));
    auto result = target->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::CopyLayerTree,
            expected_target_state_id, std::move(prepared), affected});
    if (!result) {
      return fail(error, result.error);
    }
    result.affected_layer_id = new_layer_id;
    publish_event(*target->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate transferred layer tree");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown cross-document layer transfer failure");
  }
}

int patchy_engine_session_preview_layer_transform(
    const patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision,
    const patchy_engine_layer_transform *transform,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || region == nullptr ||
      rgba == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, preview region and buffer are required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) {
    return 0;
  }
  auto request = layer_transform_request(transform, error);
  if (!request.has_value()) {
    return 0;
  }
  std::int32_t completed_rows = 0;
  request->continue_operation = [progress, progress_user_data,
                                 &completed_rows]() {
    ++completed_rows;
    return progress == nullptr ||
           progress(completed_rows, 0, progress_user_data) != 0;
  };
  try {
    auto preview_document = session->value->document();
    patchy::LayerTransformResult transformed;
    std::string transform_error;
    if (!patchy::transform_layer(preview_document, transform->layer_id, *request,
                                 &transformed, &transform_error)) {
      return fail(error,
                  transform_error == "layer transform was cancelled"
                      ? PATCHY_ENGINE_ERROR_CANCELLED
                      : PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  transform_error.c_str());
    }
    const auto preview_region = patchy::intersect_rect(
        transformed.affected_region,
        patchy::Rect::from_size(preview_document.width(),
                                preview_document.height()));
    if (preview_region.empty()) {
      *region = {};
      return 1;
    }
    DocumentSession preview(std::move(preview_document));
    const auto rendered = preview.render(preview_region);
    if (!rendered) {
      return fail(error, rendered.error);
    }
    if (!copy_buffer(rendered.pixels.data(), rgba, error)) {
      return 0;
    }
    *region = {preview_region.x, preview_region.y, preview_region.width,
               preview_region.height};
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate layer-transform preview");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer-transform preview failure");
  }
}

int patchy_engine_session_transform_layer(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision,
    const patchy_engine_layer_transform *transform, patchy_engine_event *event,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) {
    return 0;
  }
  const auto request = layer_transform_request(transform, error);
  if (!request.has_value()) {
    return 0;
  }
  try {
    auto prepared = session->value->document();
    patchy::LayerTransformResult transformed;
    std::string transform_error;
    if (!patchy::transform_layer(prepared, transform->layer_id, *request,
                                 &transformed, &transform_error)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  transform_error.c_str());
    }
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::TransformLayer,
            expected_state_id, std::move(prepared),
            transformed.affected_region});
    if (!result) {
      return fail(error, result.error);
    }
    result.affected_layer_id = transform->layer_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate transformed layer");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer-transform failure");
  }
}

int patchy_engine_session_preview_raster_stroke(
    const patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision,
    const patchy_engine_raster_stroke *stroke,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || region == nullptr ||
      rgba == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, preview region and buffer are required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) return 0;
  auto request = raster_stroke_request(session, stroke, error);
  if (!request.has_value()) return 0;
  std::int32_t completed_points = 0;
  request->continue_operation = [progress, progress_user_data,
                                 &completed_points]() {
    ++completed_points;
    return progress == nullptr ||
           progress(completed_points, 0, progress_user_data) != 0;
  };
  try {
    auto preview_document = session->value->document();
    patchy::RasterStrokeResult stroked;
    std::string stroke_error;
    if (!patchy::apply_raster_stroke(preview_document, stroke->layer_id,
                                     *request, &stroked, &stroke_error)) {
      return fail(error,
                  stroke_error == "raster stroke was cancelled"
                      ? PATCHY_ENGINE_ERROR_CANCELLED
                      : PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  stroke_error.c_str());
    }
    const auto preview_region = patchy::intersect_rect(
        stroked.affected_region,
        patchy::Rect::from_size(preview_document.width(),
                                preview_document.height()));
    if (preview_region.empty()) { *region = {}; return 1; }
    DocumentSession preview(std::move(preview_document));
    const auto rendered = preview.render(preview_region);
    if (!rendered) return fail(error, rendered.error);
    if (!copy_buffer(rendered.pixels.data(), rgba, error)) return 0;
    *region = {preview_region.x, preview_region.y, preview_region.width,
               preview_region.height};
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate raster-stroke preview");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown raster-stroke preview failure");
  }
}

int patchy_engine_session_apply_raster_stroke(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision,
    const patchy_engine_raster_stroke *stroke, patchy_engine_event *event,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) return 0;
  const auto request = raster_stroke_request(session, stroke, error);
  if (!request.has_value()) return 0;
  try {
    auto prepared = session->value->document();
    patchy::RasterStrokeResult stroked;
    std::string stroke_error;
    if (!patchy::apply_raster_stroke(prepared, stroke->layer_id, *request,
                                     &stroked, &stroke_error)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  stroke_error.c_str());
    }
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::RasterStroke,
            expected_state_id, std::move(prepared), stroked.affected_region});
    if (!result) return fail(error, result.error);
    result.affected_layer_id = stroke->layer_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate raster stroke");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown raster-stroke failure");
  }
}

int patchy_engine_session_preview_layer_mask_stroke(
    const patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision,
    const patchy_engine_raster_stroke *stroke,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || region == nullptr ||
      rgba == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, preview region and buffer are required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) return 0;
  auto request = raster_stroke_request(session, stroke, error);
  if (!request.has_value()) return 0;
  std::int32_t completed_points = 0;
  request->continue_operation = [progress, progress_user_data,
                                 &completed_points]() {
    ++completed_points;
    return progress == nullptr ||
           progress(completed_points, 0, progress_user_data) != 0;
  };
  try {
    auto preview_document = session->value->document();
    patchy::RasterStrokeResult stroked;
    std::string stroke_error;
    if (!patchy::apply_layer_mask_stroke(preview_document, stroke->layer_id,
                                         *request, &stroked, &stroke_error)) {
      return fail(error,
                  stroke_error == "raster stroke was cancelled"
                      ? PATCHY_ENGINE_ERROR_CANCELLED
                      : PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  stroke_error.c_str());
    }
    const auto preview_region = patchy::intersect_rect(
        stroked.affected_region,
        patchy::Rect::from_size(preview_document.width(),
                                preview_document.height()));
    if (preview_region.empty()) { *region = {}; return 1; }
    DocumentSession preview(std::move(preview_document));
    const auto rendered = preview.render(preview_region);
    if (!rendered) return fail(error, rendered.error);
    if (!copy_buffer(rendered.pixels.data(), rgba, error)) return 0;
    *region = {preview_region.x, preview_region.y, preview_region.width,
               preview_region.height};
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate layer-mask stroke preview");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer-mask stroke preview failure");
  }
}

int patchy_engine_session_apply_layer_mask_stroke(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision,
    const patchy_engine_raster_stroke *stroke, patchy_engine_event *event,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session is required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) return 0;
  const auto request = raster_stroke_request(session, stroke, error);
  if (!request.has_value()) return 0;
  try {
    auto prepared = session->value->document();
    patchy::RasterStrokeResult stroked;
    std::string stroke_error;
    if (!patchy::apply_layer_mask_stroke(prepared, stroke->layer_id, *request,
                                         &stroked, &stroke_error)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  stroke_error.c_str());
    }
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::RasterStroke,
            expected_state_id, std::move(prepared), stroked.affected_region});
    if (!result) return fail(error, result.error);
    result.affected_layer_id = stroke->layer_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate layer-mask stroke");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer-mask stroke failure");
  }
}

int patchy_engine_session_preview_raster_fill(
    const patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, const patchy_engine_raster_fill *fill,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || region == nullptr ||
      rgba == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, preview region and buffer are required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) return 0;
  auto request = raster_fill_request(session, fill, error);
  if (!request.has_value()) return 0;
  std::int32_t completed_rows = 0;
  request->continue_operation = [progress, progress_user_data,
                                 &completed_rows]() {
    ++completed_rows;
    return progress == nullptr ||
           progress(completed_rows, 0, progress_user_data) != 0;
  };
  try {
    auto preview_document = session->value->document();
    patchy::RasterStrokeResult filled;
    std::string fill_error;
    if (!patchy::apply_raster_fill(preview_document, fill->layer_id, *request,
                                   &filled, &fill_error)) {
      return fail(error, fill_error == "raster fill was cancelled"
                             ? PATCHY_ENGINE_ERROR_CANCELLED
                             : PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  fill_error.c_str());
    }
    const auto preview_region = patchy::intersect_rect(
        filled.affected_region,
        patchy::Rect::from_size(preview_document.width(), preview_document.height()));
    DocumentSession preview(std::move(preview_document));
    const auto rendered = preview.render(preview_region);
    if (!rendered) return fail(error, rendered.error);
    if (!copy_buffer(rendered.pixels.data(), rgba, error)) return 0;
    *region = {preview_region.x, preview_region.y, preview_region.width,
               preview_region.height};
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate raster-fill preview");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown raster-fill preview failure");
  }
}

int patchy_engine_session_apply_raster_fill(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, const patchy_engine_raster_fill *fill,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT, "session is required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) return 0;
  const auto request = raster_fill_request(session, fill, error);
  if (!request.has_value()) return 0;
  try {
    auto prepared = session->value->document();
    patchy::RasterStrokeResult filled;
    std::string fill_error;
    if (!patchy::apply_raster_fill(prepared, fill->layer_id, *request,
                                   &filled, &fill_error)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  fill_error.c_str());
    }
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::RasterFill,
            expected_state_id, std::move(prepared), filled.affected_region});
    if (!result) return fail(error, result.error);
    result.affected_layer_id = fill->layer_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate raster fill");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown raster-fill failure");
  }
}

int patchy_engine_session_preview_layer_warp(
    const patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, const patchy_engine_layer_warp *warp,
    patchy_engine_transform_progress_fn progress, void *progress_user_data,
    patchy_engine_rect *region, patchy_engine_buffer *rgba,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || region == nullptr ||
      rgba == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session, preview region and buffer are required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) return 0;
  auto request = layer_warp_request(warp, error);
  if (!request.has_value()) return 0;
  std::int32_t completed_rows = 0;
  request->continue_operation = [progress, progress_user_data,
                                 &completed_rows]() {
    ++completed_rows;
    return progress == nullptr ||
           progress(completed_rows, 0, progress_user_data) != 0;
  };
  try {
    auto preview_document = session->value->document();
    patchy::LayerWarpResult warped;
    std::string warp_error;
    if (!patchy::warp_layer(preview_document, warp->layer_id, *request, &warped,
                            &warp_error)) {
      return fail(error, warp_error == "layer warp was cancelled"
                             ? PATCHY_ENGINE_ERROR_CANCELLED
                             : PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  warp_error.c_str());
    }
    const auto preview_region = patchy::intersect_rect(
        warped.affected_region,
        patchy::Rect::from_size(preview_document.width(), preview_document.height()));
    if (preview_region.empty()) { *region = {}; return 1; }
    DocumentSession preview(std::move(preview_document));
    const auto rendered = preview.render(preview_region);
    if (!rendered) return fail(error, rendered.error);
    if (!copy_buffer(rendered.pixels.data(), rgba, error)) return 0;
    *region = {preview_region.x, preview_region.y, preview_region.width,
               preview_region.height};
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate layer-warp preview");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer-warp preview failure");
  }
}

int patchy_engine_session_warp_layer(
    patchy_engine_session *session, std::uint64_t expected_state_id,
    std::uint64_t expected_revision, const patchy_engine_layer_warp *warp,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT, "session is required");
  }
  if (!expected_state(session, expected_state_id, expected_revision, error)) return 0;
  const auto request = layer_warp_request(warp, error);
  if (!request.has_value()) return 0;
  try {
    auto prepared = session->value->document();
    patchy::LayerWarpResult warped;
    std::string warp_error;
    if (!patchy::warp_layer(prepared, warp->layer_id, *request, &warped,
                            &warp_error)) {
      return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                  warp_error.c_str());
    }
    auto result = session->value->execute(
        patchy::engine::CommitPreparedDocumentState{
            patchy::engine::PreparedDocumentMutationKind::LayerWarp,
            expected_state_id, std::move(prepared), warped.affected_region});
    if (!result) return fail(error, result.error);
    result.affected_layer_id = warp->layer_id;
    publish_event(*session->value, result, event);
    return 1;
  } catch (const std::bad_alloc &) {
    return fail(error, PATCHY_ENGINE_ERROR_ALLOCATION,
                "could not allocate warped layer");
  } catch (const std::exception &exception) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL, exception.what());
  } catch (...) {
    return fail(error, PATCHY_ENGINE_ERROR_INTERNAL,
                "unknown layer-warp failure");
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

int patchy_engine_session_memory_usage(
    const patchy_engine_session *session, patchy_engine_memory_usage *usage,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || usage == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and memory usage output are required");
  }
  if (usage->struct_size != sizeof(*usage)) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "memory usage structure size mismatch");
  }
  const auto value = session->value->memory_usage();
  *usage = {};
  usage->struct_size = sizeof(*usage);
  usage->protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  usage->document_pixel_bytes = value.document_pixel_bytes;
  usage->history_pixel_bytes = value.history_pixel_bytes;
  usage->preview_pixel_bytes = value.preview_pixel_bytes;
  usage->selection_bytes = value.selection_bytes;
  usage->history_selection_bytes = value.history_selection_bytes;
  usage->preview_selection_bytes = value.preview_selection_bytes;
  usage->history_retained_bytes = value.history_retained_bytes;
  usage->total_retained_bytes = value.total_retained_bytes;
  usage->undo_states = value.undo_states;
  usage->redo_states = value.redo_states;
  usage->render_cache_bytes = value.render_cache_bytes;
  usage->render_cache_entries = value.render_cache_entries;
  usage->render_cache_hits = value.render_cache_hits;
  usage->render_cache_misses = value.render_cache_misses;
  usage->render_cache_evictions = value.render_cache_evictions;
  return 1;
}

int patchy_engine_session_pending_render_region(
    const patchy_engine_session *session, patchy_engine_rect *region,
    std::uint8_t *has_region, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || region == nullptr ||
      has_region == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and dirty-region outputs are required");
  }
  *region = {};
  *has_region = 0U;
  const auto pending = session->value->pending_render_region();
  if (pending.has_value()) {
    *region = {pending->x, pending->y, pending->width, pending->height};
    *has_region = 1U;
  }
  return 1;
}

int patchy_engine_session_evict_oldest_undo(
    patchy_engine_session *session, std::uint8_t *evicted,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || evicted == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and eviction output are required");
  }
  *evicted = session->value->evict_oldest_undo() ? 1U : 0U;
  return 1;
}

int patchy_engine_session_render(patchy_engine_session *session,
                                 patchy_engine_rect region,
                                 patchy_engine_buffer *rgba,
                                 patchy_engine_event *event,
                                 patchy_engine_error *error) {
  return patchy_engine_session_render_with_progress(
      session, region, nullptr, nullptr, nullptr, rgba, event, error);
}

int patchy_engine_session_render_with_progress(
    patchy_engine_session *session, patchy_engine_rect region,
    patchy_engine_render_progress_fn progress, void *progress_user_data,
    patchy_engine_cancellation *cancellation, patchy_engine_buffer *rgba,
    patchy_engine_event *event, patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || rgba == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and render output are required");
  }
  if (cancellation != nullptr && cancellation->value.cancelled()) {
    return fail(error, PATCHY_ENGINE_ERROR_CANCELLED,
                "render operation was cancelled");
  }
  try {
    const patchy::engine::OperationProgress operation_progress{
        [progress, progress_user_data, cancellation](std::int32_t completed,
                                                     std::int32_t total) {
          if (cancellation != nullptr && cancellation->value.cancelled()) {
            return false;
          }
          return progress == nullptr ||
                 progress(completed, total, progress_user_data) != 0;
        }};
    const auto rendered = session->value->render(
        {region.x, region.y, region.width, region.height},
        cancellation == nullptr ? nullptr : &cancellation->value,
        &operation_progress);
    if (!rendered) {
      return fail(error, rendered.error);
    }
    if (!copy_buffer(rendered.pixels.data(), rgba, error)) {
      return 0;
    }
    const auto pending = session->value->pending_render_region();
    if (pending.has_value()) {
      const auto render_right = static_cast<std::int64_t>(region.x) + region.width;
      const auto render_bottom = static_cast<std::int64_t>(region.y) + region.height;
      const auto pending_right = static_cast<std::int64_t>(pending->x) + pending->width;
      const auto pending_bottom = static_cast<std::int64_t>(pending->y) + pending->height;
      if (region.x <= pending->x && region.y <= pending->y &&
          render_right >= pending_right && render_bottom >= pending_bottom) {
        (void)session->value->take_pending_render_region();
      }
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

int patchy_engine_session_render_region(
    patchy_engine_session *session, std::int32_t x, std::int32_t y,
    std::int32_t width, std::int32_t height, patchy_engine_buffer *rgba,
    patchy_engine_event *event, patchy_engine_error *error) {
  return patchy_engine_session_render(session, {x, y, width, height}, rgba,
                                      event, error);
}

int patchy_engine_session_save_psd(patchy_engine_session *session,
                                   patchy_engine_buffer *psd,
                                   patchy_engine_event *event,
                                   patchy_engine_error *error) {
  return patchy_engine_session_save_psd_with_progress(
      session, nullptr, nullptr, nullptr, psd, event, error);
}

int patchy_engine_session_save_psd_as(patchy_engine_session *session,
                                      std::uint8_t large_document,
                                      patchy_engine_buffer *psd,
                                      patchy_engine_event *event,
                                      patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || psd == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and save output are required");
  }
  if (large_document > 1) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "large-document flag must be zero or one");
  }
  try {
    const auto saved = session->value->encode_psd(large_document != 0);
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

int patchy_engine_session_save_psd_with_progress(
    patchy_engine_session *session, patchy_engine_save_progress_fn progress,
    void *progress_user_data, patchy_engine_cancellation *cancellation,
    patchy_engine_buffer *psd, patchy_engine_event *event,
    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || psd == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and save output are required");
  }
  if (cancellation != nullptr && cancellation->value.cancelled()) {
    return fail(error, PATCHY_ENGINE_ERROR_CANCELLED,
                "save operation was cancelled");
  }
  try {
    const patchy::engine::SaveOperationProgress save_progress{
        [progress, progress_user_data, cancellation](
            patchy::engine::SavePhase phase,
            std::uint64_t logical_output_bytes) {
          if (cancellation != nullptr && cancellation->value.cancelled()) {
            return false;
          }
          return progress == nullptr ||
                 progress(static_cast<std::uint32_t>(phase),
                          logical_output_bytes, progress_user_data) != 0;
        }};
    const auto saved = session->value->encode_psd(
        false, cancellation == nullptr ? nullptr : &cancellation->value,
        &save_progress);
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

int patchy_engine_session_event_count(const patchy_engine_session *session,
                                      std::size_t *count,
                                      std::uint64_t *dropped,
                                      patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || count == nullptr ||
      dropped == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and event counters are required");
  }
  *count = session->event_count;
  *dropped = session->dropped_events;
  return 1;
}

int patchy_engine_session_pop_event(patchy_engine_session *session,
                                    patchy_engine_event *event,
                                    patchy_engine_error *error) {
  clear_error(error);
  if (session == nullptr || session->value == nullptr || event == nullptr) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session and event output are required");
  }
  if (session->event_count == 0) {
    return fail(error, PATCHY_ENGINE_ERROR_INVALID_ARGUMENT,
                "session event queue is empty");
  }
  *event = session->events[session->event_start];
  session->event_start =
      (session->event_start + 1U) % session->events.size();
  --session->event_count;
  return 1;
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
