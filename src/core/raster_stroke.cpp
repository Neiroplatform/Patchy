#include "core/raster_stroke.hpp"

#include "core/rect_utils.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <string_view>

namespace patchy {
namespace {
constexpr std::size_t kMaximumStrokePoints = 65536;
constexpr std::int32_t kMaximumBrushSize = 4096;
bool fail(std::string* error, std::string_view message) {
  if (error != nullptr) *error = std::string(message);
  return false;
}
std::uint8_t blend_byte(std::uint8_t destination, std::uint8_t source,
                        double alpha) {
  return static_cast<std::uint8_t>(std::clamp(
      std::lround(source * alpha + destination * (1.0 - alpha)), 0L, 255L));
}
}  // namespace

bool apply_raster_stroke(Document& document, LayerId layer_id,
                         const RasterStrokeRequest& request,
                         RasterStrokeResult* result, std::string* error) {
  auto* layer = document.find_layer(layer_id);
  if (layer == nullptr || layer->kind() != LayerKind::Pixel) {
    return fail(error, "raster stroke requires a pixel layer");
  }
  const auto format = layer->pixels().format();
  if (format.channels != 4 || format.bit_depth != BitDepth::UInt8) {
    return fail(error, "raster stroke requires an RGBA8 layer");
  }
  if ((layer->lock_flags() & kLayerLockImagePixels) != 0U) {
    return fail(error, "raster stroke target pixels are locked");
  }
  if (request.points.empty() || request.points.size() > kMaximumStrokePoints ||
      request.brush_size < 1 || request.brush_size > kMaximumBrushSize) {
    return fail(error, "raster stroke geometry exceeds its bounded contract");
  }
  for (const auto& point : request.points) {
    if (!std::isfinite(point.x) || !std::isfinite(point.y)) {
      return fail(error, "raster stroke points must be finite");
    }
  }
  if ((request.mode == RasterStrokeMode::Clone ||
       request.mode == RasterStrokeMode::Heal) &&
      (!std::isfinite(request.source.x) || !std::isfinite(request.source.y))) {
    return fail(error, "clone source must be finite");
  }
  if (request.selection_mask.has_value() &&
      (request.selection_mask->format().channels != 1 ||
       request.selection_mask->format().bit_depth != BitDepth::UInt8 ||
       request.selection_mask->width() != request.selection_mask_bounds.width ||
       request.selection_mask->height() != request.selection_mask_bounds.height)) {
    return fail(error, "selection mask must be bounded Gray8 data");
  }

  const auto source_bounds = layer->bounds();
  const auto source_pixels = layer->pixels();
  const auto source_offset_x = request.source.x - request.points.front().x;
  const auto source_offset_y = request.source.y - request.points.front().y;
  EditOptions options;
  options.primary = request.color;
  options.brush_size = request.brush_size;
  options.lock_transparent_pixels =
      (layer->lock_flags() & kLayerLockTransparentPixels) != 0U;
  if (options.lock_transparent_pixels) {
    options.stroke_pixel_gate = [layer, source_bounds](std::int32_t x,
                                                        std::int32_t y) {
      if (!source_bounds.contains(x, y)) return false;
      return layer->pixels().pixel(x - source_bounds.x,
                                   y - source_bounds.y)[3] != 0;
    };
  }
  if (request.selection_mask.has_value()) {
    options.selection_coverage = [&request](std::int32_t x, std::int32_t y) {
      const auto local_x = x - request.selection_mask_bounds.x;
      const auto local_y = y - request.selection_mask_bounds.y;
      if (local_x < 0 || local_y < 0 ||
          local_x >= request.selection_mask->width() ||
          local_y >= request.selection_mask->height()) return 0.0F;
      return static_cast<float>(request.selection_mask->pixel(local_x, local_y)[0]) /
             255.0F;
    };
  } else if (!request.selection.empty()) {
    options.selection_mask = [&request](std::int32_t x, std::int32_t y) {
      return std::any_of(request.selection.begin(), request.selection.end(),
                         [x, y](const Rect& rect) { return rect.contains(x, y); });
    };
  }
  if (request.mode == RasterStrokeMode::Clone ||
      request.mode == RasterStrokeMode::Heal) {
    const auto opacity = request.mode == RasterStrokeMode::Heal ? 0.65 : 1.0;
    options.stroke_pixel_writer =
        [source_bounds, source_pixels, source_offset_x, source_offset_y,
         opacity](std::int32_t x, std::int32_t y, std::uint8_t* target,
                  std::uint16_t channels, float coverage, const EditColor&) {
          const auto sx = static_cast<std::int32_t>(
              std::floor(static_cast<double>(x) + source_offset_x));
          const auto sy = static_cast<std::int32_t>(
              std::floor(static_cast<double>(y) + source_offset_y));
          if (!source_bounds.contains(sx, sy) || channels != 4) return false;
          const auto* source = source_pixels.pixel(sx - source_bounds.x,
                                                   sy - source_bounds.y);
          const auto alpha = std::clamp(
              static_cast<double>(coverage) * opacity * source[3] / 255.0,
              0.0, 1.0);
          if (alpha <= 0.0) return false;
          const auto before = std::array<std::uint8_t, 4>{target[0], target[1],
                                                         target[2], target[3]};
          for (std::size_t channel = 0; channel < 3; ++channel) {
            target[channel] = blend_byte(target[channel], source[channel], alpha);
          }
          target[3] = blend_byte(target[3], 255, alpha);
          return !std::equal(before.begin(), before.end(), target);
        };
  }

  Rect affected;
  for (std::size_t index = 0; index < request.points.size(); ++index) {
    if (request.continue_operation && !request.continue_operation()) {
      return fail(error, "raster stroke was cancelled");
    }
    const auto& from = request.points[index == 0 ? 0 : index - 1U];
    const auto& to = request.points[index];
    affected = unite_rect(
        affected,
        paint_brush_segment(document, layer_id, from.x, from.y, to.x, to.y,
                            options, request.mode == RasterStrokeMode::Eraser));
  }
  if (affected.empty()) return fail(error, "raster stroke did not affect the target layer");
  if (result != nullptr) result->affected_region = affected;
  if (error != nullptr) error->clear();
  return true;
}

}  // namespace patchy
