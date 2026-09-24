#include "core/advanced_paint_stroke.hpp"

#include "core/layer_metadata.hpp"
#include "core/palette.hpp"
#include "core/rect_utils.hpp"
#include "formats/document_flatten.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>
#include <unordered_map>

namespace patchy {
namespace {

constexpr std::size_t kMaximumPoints = 4096U;
constexpr std::int32_t kMaximumBrushSize = 4096;
constexpr std::int32_t kMaximumPatternSize = 128;
constexpr std::uint64_t kMaximumStrokeWork = UINT64_C(67'108'864);

struct AdvancedPaintCancelled {};

bool fail(std::string* error, std::string_view message) {
  if (error != nullptr) *error = std::string(message);
  return false;
}

bool cancelled(const AdvancedPaintStrokeRequest& request) {
  return request.continue_operation && !request.continue_operation();
}

std::int32_t positive_mod(std::int32_t value, std::int32_t modulus) {
  const auto remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

std::uint8_t blend_byte(std::uint8_t destination, std::uint8_t source,
                        double alpha) {
  return static_cast<std::uint8_t>(std::clamp(
      std::lround(source * alpha + destination * (1.0 - alpha)), 0L, 255L));
}

bool validate_request(const Document& document,
                      const AdvancedPaintStrokeRequest& request,
                      std::string* error) {
  if (request.mode > AdvancedPaintMode::PatternStamp ||
      request.points.empty() || request.points.size() > kMaximumPoints ||
      request.selection.size() > kMaximumPoints ||
      request.brush_size < 1 || request.brush_size > kMaximumBrushSize ||
      request.softness < 0 || request.softness > 100 ||
      request.flow < 1 || request.flow > 100 ||
      request.wet < 0 || request.wet > 100 || request.load < 1 ||
      request.load > 100 || request.mix < 0 || request.mix > 100 ||
      request.pattern > AdvancedPaintPattern::Dots ||
      request.pattern_size < 1 ||
      request.pattern_size > kMaximumPatternSize) {
    return fail(error, "advanced-paint stroke exceeds its bounded contract");
  }
  for (const auto& point : request.points) {
    if (!std::isfinite(point.x) || !std::isfinite(point.y) || point.x < 0.0 ||
        point.y < 0.0 || point.x > document.width() - 1.0 ||
        point.y > document.height() - 1.0) {
      return fail(error,
                  "advanced-paint points must be finite document coordinates");
    }
  }
  for (const auto& rect : request.selection) {
    if (rect.empty() || rect.x < 0 || rect.y < 0 ||
        static_cast<std::int64_t>(rect.x) + rect.width > document.width() ||
        static_cast<std::int64_t>(rect.y) + rect.height > document.height()) {
      return fail(error,
                  "advanced-paint selection must be bounded document geometry");
    }
  }
  if (request.selection_mask.has_value() &&
      (request.selection_mask->format() != PixelFormat::gray8() ||
       request.selection_mask->width() != request.selection_mask_bounds.width ||
       request.selection_mask->height() != request.selection_mask_bounds.height ||
       request.selection_mask_bounds.x < 0 ||
       request.selection_mask_bounds.y < 0 ||
       static_cast<std::int64_t>(request.selection_mask_bounds.x) +
               request.selection_mask_bounds.width > document.width() ||
       static_cast<std::int64_t>(request.selection_mask_bounds.y) +
               request.selection_mask_bounds.height > document.height())) {
    return fail(error, "selection mask must be bounded Gray8 data");
  }

  const auto diameter = static_cast<std::uint64_t>(request.brush_size + 2);
  const auto spacing = std::max(1.0, request.brush_size * 0.125);
  std::uint64_t dab_count = 1U;
  for (std::size_t index = 1; index < request.points.size(); ++index) {
    const auto dx = request.points[index].x - request.points[index - 1].x;
    const auto dy = request.points[index].y - request.points[index - 1].y;
    const auto steps = static_cast<std::uint64_t>(
        std::max(1.0, std::ceil(std::hypot(dx, dy) / spacing)));
    if (steps > kMaximumStrokeWork - dab_count) {
      return fail(error,
                  "advanced-paint stroke work exceeds its bounded contract");
    }
    dab_count += steps;
  }
  if (diameter > kMaximumStrokeWork / diameter ||
      dab_count > kMaximumStrokeWork / (diameter * diameter)) {
    return fail(error,
                "advanced-paint stroke work exceeds its bounded contract");
  }
  return true;
}

EditColor sample_average(const PixelBuffer& pixels, Rect bounds, double x,
                         double y) {
  constexpr std::int32_t radius = 4;
  double premultiplied_red = 0.0;
  double premultiplied_green = 0.0;
  double premultiplied_blue = 0.0;
  double alpha_sum = 0.0;
  std::int32_t samples = 0;
  const auto center_x = static_cast<std::int32_t>(std::lround(x));
  const auto center_y = static_cast<std::int32_t>(std::lround(y));
  for (std::int32_t offset_y = -radius; offset_y <= radius; ++offset_y) {
    for (std::int32_t offset_x = -radius; offset_x <= radius; ++offset_x) {
      if (offset_x * offset_x + offset_y * offset_y > radius * radius) continue;
      ++samples;
      const auto document_x = center_x + offset_x;
      const auto document_y = center_y + offset_y;
      if (!bounds.contains(document_x, document_y)) continue;
      const auto* pixel = pixels.pixel(document_x - bounds.x,
                                       document_y - bounds.y);
      const auto alpha = static_cast<double>(pixel[3]) / 255.0;
      premultiplied_red += pixel[0] * alpha;
      premultiplied_green += pixel[1] * alpha;
      premultiplied_blue += pixel[2] * alpha;
      alpha_sum += alpha;
    }
  }
  if (samples == 0 || alpha_sum <= std::numeric_limits<double>::epsilon()) {
    return {0, 0, 0, 0};
  }
  const auto channel = [alpha_sum](double value) {
    return static_cast<std::uint8_t>(
        std::clamp(std::lround(value / alpha_sum), 0L, 255L));
  };
  return {channel(premultiplied_red), channel(premultiplied_green),
          channel(premultiplied_blue),
          static_cast<std::uint8_t>(std::clamp(
              std::lround(alpha_sum * 255.0 / samples), 0L, 255L))};
}

EditColor pattern_color(const AdvancedPaintStrokeRequest& request,
                        std::int32_t x, std::int32_t y) {
  const auto local_x = positive_mod(x - request.pattern_anchor_x,
                                    request.pattern_size * 2);
  const auto local_y = positive_mod(y - request.pattern_anchor_y,
                                    request.pattern_size * 2);
  if (request.pattern == AdvancedPaintPattern::Checker) {
    return ((local_x / request.pattern_size) +
            (local_y / request.pattern_size)) % 2 == 0
               ? request.color
               : request.secondary_color;
  }
  const auto radius = std::max(1, request.pattern_size / 2);
  const auto center = request.pattern_size;
  const auto dx = local_x - center;
  const auto dy = local_y - center;
  return dx * dx + dy * dy <= radius * radius ? request.color
                                               : request.secondary_color;
}

PaletteSnapContext palette_context(const Document& document, PaletteLut& lut) {
  PaletteSnapContext context;
  if (document.palette_editing().has_value()) {
    lut.build(document.palette_editing()->palette.colors);
    context.lut = &lut;
    context.alpha_threshold = document.palette_editing()->alpha_threshold;
  }
  return context;
}

}  // namespace

bool apply_advanced_paint_stroke(Document& document, LayerId layer_id,
                                 const AdvancedPaintStrokeRequest& request,
                                 AdvancedPaintStrokeResult* result,
                                 std::string* error) {
  const auto* source_layer = document.find_layer(layer_id);
  if (source_layer == nullptr || source_layer->kind() != LayerKind::Pixel) {
    return fail(error, "advanced-paint stroke requires a pixel layer");
  }
  if (source_layer->pixels().format() != PixelFormat::rgba8() ||
      source_layer->pixels().empty() || source_layer->bounds().empty()) {
    return fail(error, "advanced-paint stroke requires a non-empty RGBA8 layer");
  }
  if (layer_is_effectively_locked(document.layers(), layer_id) ||
      (source_layer->lock_flags() & kLayerLockImagePixels) != 0U) {
    return fail(error, "advanced-paint target pixels are locked");
  }
  if (!validate_request(document, request, error)) return false;
  if (cancelled(request)) return fail(error, "advanced-paint stroke was cancelled");

  try {
    const auto active_source = source_layer->pixels();
    const auto active_bounds = source_layer->bounds();
    const auto merged_source = request.mode == AdvancedPaintMode::MixerBrush &&
                                       request.sample_all_layers
                                   ? std::optional<PixelBuffer>(
                                         flatten_document_rgba8(document))
                                   : std::nullopt;
    const auto sample_bounds = merged_source.has_value()
                                   ? Rect{0, 0, document.width(), document.height()}
                                   : active_bounds;
    const auto& sample_pixels = merged_source.has_value() ? *merged_source
                                                           : active_source;

    auto working = document;
    auto* target_layer = working.find_layer(layer_id);
    EditOptions options;
    options.brush_size = request.brush_size;
    options.brush_softness = request.softness;
    options.primary = request.color;
    options.primary.a = static_cast<std::uint8_t>(std::clamp(
        std::lround(request.color.a * request.flow / 100.0), 1L, 255L));
    options.lock_transparent_pixels =
        (target_layer->lock_flags() & kLayerLockTransparentPixels) != 0U;
    if (options.lock_transparent_pixels) {
      options.stroke_pixel_gate = [target_layer, bounds = target_layer->bounds()](
                                      std::int32_t x, std::int32_t y) {
        return bounds.contains(x, y) &&
               target_layer->pixels().pixel(x - bounds.x, y - bounds.y)[3] != 0;
      };
    }
    if (request.selection_mask.has_value()) {
      options.selection = request.selection_mask_bounds;
      options.selection_coverage = [&request](std::int32_t x, std::int32_t y) {
        const auto local_x = x - request.selection_mask_bounds.x;
        const auto local_y = y - request.selection_mask_bounds.y;
        if (local_x < 0 || local_y < 0 ||
            local_x >= request.selection_mask->width() ||
            local_y >= request.selection_mask->height()) return 0.0F;
        return request.selection_mask->pixel(local_x, local_y)[0] / 255.0F;
      };
    } else if (!request.selection.empty()) {
      for (const auto& rect : request.selection) {
        options.selection = options.selection.has_value()
                                ? unite_rect(*options.selection, rect)
                                : rect;
      }
      options.selection_mask = [&request](std::int32_t x, std::int32_t y) {
        return std::any_of(request.selection.begin(), request.selection.end(),
                           [x, y](const Rect& rect) {
                             return rect.contains(x, y);
                           });
      };
    }
    PaletteLut palette_lut;
    const auto palette = palette_context(working, palette_lut);
    options.palette_snap = palette.lut == nullptr ? nullptr : &palette;
    options.progress_callback = [&request]() {
      if (cancelled(request)) throw AdvancedPaintCancelled{};
    };

    MixerBrushState mixer_state;
    begin_mixer_brush_stroke(mixer_state);
    if (request.mode == AdvancedPaintMode::MixerBrush) {
      options.dab_primary_provider = [&](double x, double y,
                                         const EditColor& loaded) {
        return mixer_brush_dab_color(
            mixer_state, x, y, request.brush_size, loaded,
            sample_average(sample_pixels, sample_bounds, x, y), request.wet,
            request.load, request.mix);
      };
    }

    std::unordered_map<std::uint64_t, float> alpha_caps;
    options.stroke_pixel_writer = [&](std::int32_t x, std::int32_t y,
                                      std::uint8_t* destination,
                                      std::uint16_t channels, float coverage,
                                      const EditColor& dab_color) {
      if (channels != 4U) return false;
      auto source = request.mode == AdvancedPaintMode::PatternStamp
                        ? pattern_color(request, x, y)
                        : dab_color;
      const auto flow = request.mode == AdvancedPaintMode::PatternStamp
                            ? request.flow / 100.0F
                            : 1.0F;
      auto target_alpha = coverage * flow * source.a / 255.0F;
      if (palette.lut != nullptr) {
        if (coverage < palette.coverage_threshold) return false;
        target_alpha = source.a == 0U ? 0.0F : flow;
      }
      const auto key =
          (static_cast<std::uint64_t>(static_cast<std::uint32_t>(y)) << 32U) |
          static_cast<std::uint32_t>(x);
      auto& previous_alpha = alpha_caps[key];
      if (target_alpha <= previous_alpha + 0.0005F) return false;
      const auto incremental =
          (target_alpha - previous_alpha) /
          std::max(0.0005F, 1.0F - previous_alpha);
      previous_alpha = target_alpha;
      const auto before = std::array<std::uint8_t, 4>{
          destination[0], destination[1], destination[2], destination[3]};
      for (std::size_t channel = 0; channel < 3; ++channel) {
        const std::array<std::uint8_t, 3> source_channels{
            source.r, source.g, source.b};
        destination[channel] =
            blend_byte(destination[channel], source_channels[channel], incremental);
      }
      destination[3] = blend_byte(destination[3], 255, incremental);
      if (palette.lut != nullptr) {
        snap_pixel_to_palette(destination, channels, palette);
      }
      return !std::equal(before.begin(), before.end(), destination);
    };

    Rect affected;
    const auto spacing = std::max(1.0, request.brush_size * 0.125);
    const auto paint_dab = [&](double x, double y) {
      if (cancelled(request)) throw AdvancedPaintCancelled{};
      affected = unite_rect(
          affected, paint_brush_dab(working, layer_id, x, y, options, false));
    };
    paint_dab(request.points.front().x, request.points.front().y);
    for (std::size_t index = 1; index < request.points.size(); ++index) {
      const auto& from = request.points[index - 1];
      const auto& to = request.points[index];
      const auto dx = to.x - from.x;
      const auto dy = to.y - from.y;
      const auto steps = static_cast<std::int32_t>(
          std::max(1.0, std::ceil(std::hypot(dx, dy) / spacing)));
      for (std::int32_t step = 1; step <= steps; ++step) {
        const auto amount = static_cast<double>(step) / steps;
        paint_dab(from.x + dx * amount, from.y + dy * amount);
      }
    }
    if (cancelled(request)) throw AdvancedPaintCancelled{};
    if (affected.empty()) {
      return fail(error, "advanced-paint stroke made no pixel change");
    }
    document = std::move(working);
    if (result != nullptr) result->affected_region = affected;
    if (error != nullptr) error->clear();
    return true;
  } catch (const AdvancedPaintCancelled&) {
    return fail(error, "advanced-paint stroke was cancelled");
  }
}

}  // namespace patchy
