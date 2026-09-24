#include "core/local_adjustment_brush.hpp"

#include "core/blend_math.hpp"
#include "core/layer_metadata.hpp"
#include "core/palette.hpp"
#include "core/pixel_tools.hpp"
#include "core/rect_utils.hpp"

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

constexpr std::size_t kMaximumPoints = 4096;
constexpr std::int32_t kMaximumBrushSize = 4096;
constexpr std::uint64_t kMaximumCoveragePixels = 16'777'216ULL;
constexpr std::uint64_t kMaximumStrokeWork = 67'108'864ULL;

bool fail(std::string* error, std::string_view message) {
  if (error != nullptr) *error = std::string(message);
  return false;
}

bool cancelled(const LocalAdjustmentBrushRequest& request) {
  return request.continue_operation && !request.continue_operation();
}

std::uint8_t selection_alpha(const LocalAdjustmentBrushRequest& request,
                             std::int32_t x, std::int32_t y) {
  if (request.selection_mask.has_value()) {
    const auto local_x = x - request.selection_mask_bounds.x;
    const auto local_y = y - request.selection_mask_bounds.y;
    if (local_x < 0 || local_y < 0 ||
        local_x >= request.selection_mask->width() ||
        local_y >= request.selection_mask->height()) return 0;
    return request.selection_mask->pixel(local_x, local_y)[0];
  }
  if (request.selection.empty()) return 255;
  return std::any_of(request.selection.begin(), request.selection.end(),
                     [x, y](const Rect& rect) { return rect.contains(x, y); })
             ? 255
             : 0;
}

float brush_coverage(double distance_squared, std::int32_t radius,
                     std::int32_t softness) {
  if (radius <= 0) return distance_squared <= 0.0 ? 1.0F : 0.0F;
  const auto radius_squared = static_cast<double>(radius) * radius;
  if (distance_squared > radius_squared) return 0.0F;
  if (softness == 0) return 1.0F;
  const auto edge_width = std::max(1.0, static_cast<double>(radius) * softness / 100.0);
  const auto inner_radius = std::max(0.0, static_cast<double>(radius) - edge_width);
  const auto distance = std::sqrt(distance_squared);
  if (distance <= inner_radius) return 1.0F;
  const auto t = std::clamp((distance - inner_radius) / edge_width, 0.0, 1.0);
  const auto smooth = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  return static_cast<float>(1.0 - smooth);
}

std::array<std::uint8_t, 4> source_pixel(const Layer& layer, std::int32_t x,
                                         std::int32_t y) {
  const auto bounds = layer.bounds();
  x = std::clamp(x, bounds.x, bounds.x + bounds.width - 1);
  y = std::clamp(y, bounds.y, bounds.y + bounds.height - 1);
  const auto* pixel = layer.pixels().pixel(x - bounds.x, y - bounds.y);
  return {pixel[0], pixel[1], pixel[2], pixel[3]};
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

std::array<std::uint8_t, 3> adjusted_pixel(
    const Layer& source, std::int32_t x, std::int32_t y,
    const LocalAdjustmentBrushRequest& request) {
  const auto center = source_pixel(source, x, y);
  std::array<std::uint8_t, 3> result{center[0], center[1], center[2]};
  if (request.mode == LocalAdjustmentBrushMode::Blur ||
      request.mode == LocalAdjustmentBrushMode::Sharpen) {
    constexpr std::array<int, 3> gaussian{1, 2, 1};
    std::array<double, 3> premultiplied{};
    double alpha_weight = 0.0;
    for (int offset_y = -1; offset_y <= 1; ++offset_y) {
      for (int offset_x = -1; offset_x <= 1; ++offset_x) {
        const auto sample = source_pixel(source, x + offset_x, y + offset_y);
        const auto weight = static_cast<double>(
            gaussian[static_cast<std::size_t>(offset_x + 1)] *
            gaussian[static_cast<std::size_t>(offset_y + 1)]);
        const auto alpha = static_cast<double>(sample[3]) / 255.0;
        alpha_weight += weight * alpha;
        for (std::size_t channel = 0; channel < 3; ++channel) {
          premultiplied[channel] += weight * alpha * sample[channel];
        }
      }
    }
    if (alpha_weight <= std::numeric_limits<double>::epsilon()) return result;
    for (std::size_t channel = 0; channel < 3; ++channel) {
      const auto blurred = premultiplied[channel] / alpha_weight;
      result[channel] = request.mode == LocalAdjustmentBrushMode::Blur
                            ? clamp_byte(static_cast<float>(blurred))
                            : clamp_byte(static_cast<float>(center[channel] * 2.0 - blurred));
    }
    return result;
  }

  const auto red = static_cast<double>(center[0]);
  const auto green = static_cast<double>(center[1]);
  const auto blue = static_cast<double>(center[2]);
  const auto lightness = (54.0 * red + 183.0 * green + 19.0 * blue) /
                         (256.0 * 255.0);
  if (request.mode == LocalAdjustmentBrushMode::Dodge ||
      request.mode == LocalAdjustmentBrushMode::Burn) {
    double range_weight = 1.0;
    switch (request.tone_range) {
      case LocalAdjustmentToneRange::Shadows: range_weight = 1.0 - lightness; break;
      case LocalAdjustmentToneRange::Midtones:
        range_weight = 1.0 - std::abs(lightness * 2.0 - 1.0); break;
      case LocalAdjustmentToneRange::Highlights: range_weight = lightness; break;
    }
    const auto source_lightness = lightness * 255.0;
    const auto target_lightness = request.mode == LocalAdjustmentBrushMode::Dodge
        ? source_lightness + (255.0 - source_lightness) * range_weight
        : source_lightness * (1.0 - range_weight);
    for (std::size_t channel = 0; channel < 3; ++channel) {
      const auto value = static_cast<double>(center[channel]);
      const auto adjusted = request.protect_tones
          ? value + (target_lightness - source_lightness)
          : (request.mode == LocalAdjustmentBrushMode::Dodge
                 ? value + (255.0 - value) * range_weight
                 : value * (1.0 - range_weight));
      result[channel] = clamp_byte(static_cast<float>(adjusted));
    }
    return result;
  }

  if (request.mode == LocalAdjustmentBrushMode::Sponge) {
    const auto maximum = static_cast<double>(std::max({center[0], center[1], center[2]}));
    const auto minimum = static_cast<double>(std::min({center[0], center[1], center[2]}));
    const auto saturation = (maximum - minimum) / 255.0;
    const auto vibrance_scale = request.sponge_vibrance ? 1.0 - saturation : 1.0;
    const auto luma = lightness * 255.0;
    const auto chroma_scale = request.sponge_saturate ? 1.0 + vibrance_scale
                                                      : 1.0 - vibrance_scale;
    for (std::size_t channel = 0; channel < 3; ++channel) {
      result[channel] = clamp_byte(static_cast<float>(
          luma + (static_cast<double>(center[channel]) - luma) * chroma_scale));
    }
  }
  return result;
}

bool validate_request(const Document& document,
                      const LocalAdjustmentBrushRequest& request,
                      std::string* error) {
  if (request.points.empty() || request.points.size() > kMaximumPoints ||
      request.selection.size() > kMaximumPoints ||
      request.brush_size < 1 || request.brush_size > kMaximumBrushSize ||
      request.softness < 0 || request.softness > 100 ||
      request.strength < 1 || request.strength > 100 ||
      request.mode > LocalAdjustmentBrushMode::Sharpen ||
      request.tone_range > LocalAdjustmentToneRange::Highlights) {
    return fail(error, "local-adjustment brush exceeds its bounded contract");
  }
  for (const auto& rect : request.selection) {
    if (rect.empty() || rect.x < 0 || rect.y < 0 ||
        static_cast<std::int64_t>(rect.x) + rect.width > document.width() ||
        static_cast<std::int64_t>(rect.y) + rect.height > document.height()) {
      return fail(error, "local-adjustment selection must be bounded document geometry");
    }
  }
  std::uint64_t work = 0;
  const auto work_limit = request.mode == LocalAdjustmentBrushMode::Smudge
                              ? kMaximumStrokeWork
                              : kMaximumCoveragePixels;
  const auto selection_multiplier = request.selection_mask.has_value()
      ? UINT64_C(1)
      : std::max<std::uint64_t>(1U, request.selection.size());
  const auto radius = std::max(1, request.brush_size) / 2;
  for (std::size_t index = 0; index < request.points.size(); ++index) {
    const auto& point = request.points[index];
    if (!std::isfinite(point.x) || !std::isfinite(point.y) || point.x < 0.0 ||
        point.y < 0.0 || point.x > document.width() - 1.0 ||
        point.y > document.height() - 1.0) {
      return fail(error, "local-adjustment points must be finite document coordinates");
    }
    const auto& from = request.points[index == 0 ? 0 : index - 1];
    const auto width = static_cast<std::uint64_t>(
        std::ceil(std::abs(point.x - from.x)) + radius * 2 + 3);
    const auto height = static_cast<std::uint64_t>(
        std::ceil(std::abs(point.y - from.y)) + radius * 2 + 3);
    auto segment_work = width * height;
    if (request.mode == LocalAdjustmentBrushMode::Smudge && index != 0U) {
      const auto dx = point.x - from.x;
      const auto dy = point.y - from.y;
      const auto distance = std::sqrt(dx * dx + dy * dy);
      const auto spacing = std::max(1.0, static_cast<double>(radius) * 0.2);
      const auto steps = static_cast<std::uint64_t>(std::max(1.0, std::ceil(distance / spacing)));
      const auto diameter = static_cast<std::uint64_t>(radius * 2 + 1);
      if (steps > work_limit / diameter / diameter) {
        return fail(error, "local-adjustment stroke work exceeds its bounded contract");
      }
      segment_work = steps * diameter * diameter;
    }
    if (segment_work > (work_limit - work) / selection_multiplier) {
      return fail(error, "local-adjustment stroke work exceeds its bounded contract");
    }
    work += segment_work * selection_multiplier;
  }
  if (request.selection_mask.has_value() &&
      (request.selection_mask->format() != PixelFormat::gray8() ||
       request.selection_mask->width() != request.selection_mask_bounds.width ||
       request.selection_mask->height() != request.selection_mask_bounds.height ||
       request.selection_mask_bounds.x < 0 || request.selection_mask_bounds.y < 0 ||
       static_cast<std::int64_t>(request.selection_mask_bounds.x) +
               request.selection_mask_bounds.width > document.width() ||
       static_cast<std::int64_t>(request.selection_mask_bounds.y) +
               request.selection_mask_bounds.height > document.height())) {
    return fail(error, "selection mask must be bounded Gray8 data");
  }
  return true;
}

bool apply_smudge(Document& working, LayerId layer_id,
                  const LocalAdjustmentBrushRequest& request, Rect* affected,
                  std::string* error) {
  EditOptions options;
  options.brush_size = request.brush_size;
  options.brush_softness = request.softness;
  options.primary.a = clamp_byte(request.strength * 255.0F / 100.0F);
  const auto* layer = working.find_layer(layer_id);
  options.lock_transparent_pixels =
      (layer->lock_flags() & kLayerLockTransparentPixels) != 0U;
  PaletteLut palette_lut;
  auto palette = palette_context(working, palette_lut);
  options.palette_snap = palette.lut == nullptr ? nullptr : &palette;
  options.selection_coverage = [&request](std::int32_t x, std::int32_t y) {
    return static_cast<float>(selection_alpha(request, x, y)) / 255.0F;
  };
  if (request.selection_mask.has_value()) {
    options.selection = request.selection_mask_bounds;
  } else {
    for (const auto& rect : request.selection) {
      options.selection = options.selection.has_value()
                              ? unite_rect(*options.selection, rect)
                              : rect;
    }
  }
  SmudgeState state;
  bool was_cancelled = false;
  options.stroke_progress = [&](Rect) {
    was_cancelled = cancelled(request);
    return was_cancelled;
  };
  if (request.points.size() == 1) {
    const auto& point = request.points.front();
    *affected = unite_rect(*affected, smudge_brush_segment(
        working, layer_id, static_cast<std::int32_t>(std::lround(point.x)),
        static_cast<std::int32_t>(std::lround(point.y)),
        static_cast<std::int32_t>(std::lround(point.x)),
        static_cast<std::int32_t>(std::lround(point.y)), options, state));
  }
  for (std::size_t index = 1; index < request.points.size(); ++index) {
    if (cancelled(request)) return fail(error, "local-adjustment brush was cancelled");
    const auto& from = request.points[index - 1];
    const auto& to = request.points[index];
    *affected = unite_rect(*affected, smudge_brush_segment(
        working, layer_id, static_cast<std::int32_t>(std::lround(from.x)),
        static_cast<std::int32_t>(std::lround(from.y)),
        static_cast<std::int32_t>(std::lround(to.x)),
        static_cast<std::int32_t>(std::lround(to.y)), options, state));
    if (was_cancelled) return fail(error, "local-adjustment brush was cancelled");
  }
  return true;
}

bool apply_fixed_adjustment(Document& working, LayerId layer_id,
                            const LocalAdjustmentBrushRequest& request,
                            Rect* affected, std::string* error) {
  auto* layer = working.find_layer(layer_id);
  const auto source = *layer;
  auto& pixels = layer->pixels();
  const auto bounds = layer->bounds();
  const auto radius = std::max(1, request.brush_size) / 2;
  const auto strength = static_cast<float>(request.strength) / 100.0F;
  PaletteLut palette_lut;
  const auto palette = palette_context(working, palette_lut);
  std::unordered_map<std::uint64_t, float> alpha_caps;
  for (std::size_t index = 0; index < request.points.size(); ++index) {
    if (cancelled(request)) return fail(error, "local-adjustment brush was cancelled");
    const auto& from = request.points[index == 0 ? 0 : index - 1];
    const auto& to = request.points[index];
    const auto left = std::max(bounds.x, static_cast<std::int32_t>(
        std::floor(std::min(from.x, to.x))) - radius);
    const auto top = std::max(bounds.y, static_cast<std::int32_t>(
        std::floor(std::min(from.y, to.y))) - radius);
    const auto right = std::min(bounds.x + bounds.width, static_cast<std::int32_t>(
        std::ceil(std::max(from.x, to.x))) + radius + 1);
    const auto bottom = std::min(bounds.y + bounds.height, static_cast<std::int32_t>(
        std::ceil(std::max(from.y, to.y))) + radius + 1);
    const auto dx = to.x - from.x;
    const auto dy = to.y - from.y;
    const auto length_squared = dx * dx + dy * dy;
    for (auto y = top; y < bottom; ++y) {
      if ((y - top) % 64 == 0 && cancelled(request)) {
        return fail(error, "local-adjustment brush was cancelled");
      }
      for (auto x = left; x < right; ++x) {
        const auto along = length_squared <= std::numeric_limits<double>::epsilon()
            ? 0.0
            : std::clamp(((x - from.x) * dx + (y - from.y) * dy) /
                             length_squared, 0.0, 1.0);
        const auto nearest_x = from.x + dx * along;
        const auto nearest_y = from.y + dy * along;
        auto coverage = brush_coverage((x - nearest_x) * (x - nearest_x) +
                                           (y - nearest_y) * (y - nearest_y),
                                       radius, request.softness);
        coverage *= static_cast<float>(selection_alpha(request, x, y)) / 255.0F;
        if (coverage <= 0.0F) continue;
        if (palette.lut != nullptr) {
          if (coverage < palette.coverage_threshold) continue;
          coverage = 1.0F;
        }
        const auto key = (static_cast<std::uint64_t>(static_cast<std::uint32_t>(y)) << 32U) |
                         static_cast<std::uint32_t>(x);
        const auto target_alpha = strength * coverage;
        auto& previous_alpha = alpha_caps[key];
        if (target_alpha <= previous_alpha + 0.0005F) continue;
        const auto incremental = (target_alpha - previous_alpha) /
                                 std::max(0.0005F, 1.0F - previous_alpha);
        previous_alpha = target_alpha;
        auto* destination = pixels.pixel(x - bounds.x, y - bounds.y);
        if (destination[3] == 0) continue;
        const auto adjusted = adjusted_pixel(source, x, y, request);
        const auto before = std::array<std::uint8_t, 4>{destination[0], destination[1],
                                                        destination[2], destination[3]};
        for (std::size_t channel = 0; channel < 3; ++channel) {
          destination[channel] = clamp_byte(adjusted[channel] * incremental +
              destination[channel] * (1.0F - incremental));
        }
        if (palette.lut != nullptr) snap_pixel_to_palette(destination, 4, palette);
        if (!std::equal(before.begin(), before.end(), destination)) {
          *affected = unite_rect(*affected, {x, y, 1, 1});
        }
      }
    }
  }
  return true;
}

}  // namespace

bool apply_local_adjustment_brush(Document& document, LayerId layer_id,
                                  const LocalAdjustmentBrushRequest& request,
                                  LocalAdjustmentBrushResult* result,
                                  std::string* error) {
  auto* layer = document.find_layer(layer_id);
  if (layer == nullptr || layer->kind() != LayerKind::Pixel) {
    return fail(error, "local-adjustment brush requires a pixel layer");
  }
  if (layer->pixels().format() != PixelFormat::rgba8()) {
    return fail(error, "local-adjustment brush requires an RGBA8 layer");
  }
  if (layer->pixels().empty() || layer->bounds().empty()) {
    return fail(error, "local-adjustment brush requires non-empty pixels");
  }
  if (layer_is_effectively_locked(document.layers(), layer_id) ||
      (layer->lock_flags() & kLayerLockImagePixels) != 0U) {
    return fail(error, "local-adjustment brush target pixels are locked");
  }
  if (!validate_request(document, request, error)) return false;
  auto working = document;
  Rect affected;
  const auto applied = request.mode == LocalAdjustmentBrushMode::Smudge
      ? apply_smudge(working, layer_id, request, &affected, error)
      : apply_fixed_adjustment(working, layer_id, request, &affected, error);
  if (!applied) return false;
  if (cancelled(request)) return fail(error, "local-adjustment brush was cancelled");
  if (affected.empty()) return fail(error, "local-adjustment brush made no pixel change");
  document = std::move(working);
  if (result != nullptr) result->affected_region = affected;
  return true;
}

}  // namespace patchy
