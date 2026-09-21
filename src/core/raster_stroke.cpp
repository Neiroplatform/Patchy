#include "core/raster_stroke.hpp"

#include "core/layer_metadata.hpp"
#include "core/rect_utils.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>

namespace patchy {
namespace {
constexpr std::size_t kMaximumStrokePoints = 65536;
constexpr std::int32_t kMaximumBrushSize = 4096;
constexpr std::uint64_t kMaximumLayerMaskStrokePixels = 268435456ULL;
struct LayerMaskStrokeCancelled {};
bool fail(std::string* error, std::string_view message) {
  if (error != nullptr) *error = std::string(message);
  return false;
}
std::uint8_t blend_byte(std::uint8_t destination, std::uint8_t source,
                        double alpha) {
  return static_cast<std::uint8_t>(std::clamp(
      std::lround(source * alpha + destination * (1.0 - alpha)), 0L, 255L));
}

std::uint8_t mask_luminance(EditColor color) {
  return static_cast<std::uint8_t>(std::clamp(
      std::lround(color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722),
      0L, 255L));
}

float selection_coverage(const RasterFillRequest& request, std::int32_t x,
                         std::int32_t y) {
  if (request.selection_mask.has_value()) {
    const auto local_x = x - request.selection_mask_bounds.x;
    const auto local_y = y - request.selection_mask_bounds.y;
    if (local_x < 0 || local_y < 0 ||
        local_x >= request.selection_mask->width() ||
        local_y >= request.selection_mask->height()) return 0.0F;
    return static_cast<float>(request.selection_mask->pixel(local_x, local_y)[0]) /
           255.0F;
  }
  if (request.selection.empty()) return 1.0F;
  return std::any_of(request.selection.begin(), request.selection.end(),
                     [x, y](const Rect& rect) { return rect.contains(x, y); })
             ? 1.0F
             : 0.0F;
}

EditColor fill_color(const RasterFillRequest& request, std::int32_t x,
                     std::int32_t y) {
  if (request.mode == RasterFillMode::Solid) return request.color;
  if (request.mode == RasterFillMode::Checker ||
      request.mode == RasterFillMode::CustomChecker) {
    const auto size = request.mode == RasterFillMode::Checker
                          ? 8
                          : request.pattern_size;
    return ((x / size) + (y / size)) % 2 == 0
               ? request.color
               : request.mode == RasterFillMode::Checker
                     ? EditColor{241, 243, 245, 255}
                     : request.secondary_color;
  }
  if (request.mode == RasterFillMode::Dots) {
    const auto dx = ((x % 16) + 16) % 16 - 4;
    const auto dy = ((y % 16) + 16) % 16 - 4;
    const auto dx2 = ((x % 16) + 16) % 16 - 12;
    const auto dy2 = ((y % 16) + 16) % 16 - 12;
    return dx * dx + dy * dy <= 9 || dx2 * dx2 + dy2 * dy2 <= 9
               ? request.color
               : EditColor{0, 0, 0, 0};
  }
  if (request.mode == RasterFillMode::CustomDots) {
    const auto cell = request.pattern_size * 2;
    const auto radius = std::max(1, cell / 5);
    const auto center = cell / 2;
    const auto dx = ((x % cell) + cell) % cell - center;
    const auto dy = ((y % cell) + cell) % cell - center;
    return dx * dx + dy * dy <= radius * radius
               ? request.color
               : request.secondary_color;
  }
  auto vx = request.end.x - request.start.x;
  auto vy = request.end.y - request.start.y;
  auto length = vx * vx + vy * vy;
  if (length <= 0.0) { vx = 1.0; vy = 0.0; length = 1.0; }
  const auto t = std::clamp(
      ((x - request.start.x) * vx + (y - request.start.y) * vy) / length,
      0.0, 1.0);
  const auto interpolate = [](EditColor a, EditColor b, double amount) {
    const auto channel = [amount](std::uint8_t x, std::uint8_t y) {
      return static_cast<std::uint8_t>(std::lround(x + (y - x) * amount));
    };
    return EditColor{channel(a.r, b.r), channel(a.g, b.g), channel(a.b, b.b),
                     channel(a.a, b.a)};
  };
  switch (request.mode) {
    case RasterFillMode::ForegroundTransparent:
      return interpolate(request.color,
                         EditColor{request.color.r, request.color.g,
                                   request.color.b, 0}, t);
    case RasterFillMode::BlackWhite:
      return interpolate({0, 0, 0, 255}, {255, 255, 255, 255}, t);
    case RasterFillMode::Sunset:
      return t < 0.48
          ? interpolate({255, 61, 119, 255}, {255, 154, 61, 255}, t / 0.48)
          : interpolate({255, 154, 61, 255}, {255, 230, 109, 255},
                        (t - 0.48) / 0.52);
    case RasterFillMode::Ocean: {
      const auto u = t < 0.5 ? t * 2.0 : (t - 0.5) * 2.0;
      const auto a = t < 0.5 ? EditColor{8, 47, 73, 255} : EditColor{2, 132, 199, 255};
      const auto b = t < 0.5 ? EditColor{2, 132, 199, 255} : EditColor{103, 232, 249, 255};
      const auto ch = [u](int p, int q) { return static_cast<std::uint8_t>(std::lround(p + (q-p)*u)); };
      return {ch(a.r,b.r), ch(a.g,b.g), ch(a.b,b.b), 255};
    }
    case RasterFillMode::CustomGradient:
      return interpolate(request.color, request.secondary_color, t);
    default: return request.color;
  }
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

bool apply_layer_mask_stroke(Document& document, LayerId layer_id,
                             const RasterStrokeRequest& request,
                             RasterStrokeResult* result, std::string* error) {
  auto* layer = document.find_layer(layer_id);
  if (layer == nullptr || !layer->mask().has_value()) {
    return fail(error, "layer-mask stroke requires an existing raster mask");
  }
  if (request.mode != RasterStrokeMode::Brush &&
      request.mode != RasterStrokeMode::Eraser) {
    return fail(error, "layer-mask stroke supports Brush and Eraser only");
  }
  if (request.points.empty() || request.points.size() > kMaximumStrokePoints ||
      request.brush_size < 1 || request.brush_size > kMaximumBrushSize ||
      std::any_of(request.points.begin(), request.points.end(),
                  [](const RasterStrokePoint& point) {
                    return !std::isfinite(point.x) || !std::isfinite(point.y);
                  })) {
    return fail(error, "layer-mask stroke geometry exceeds its bounded contract");
  }
  if (request.selection_mask.has_value() &&
      (request.selection_mask->format() != PixelFormat::gray8() ||
       request.selection_mask->width() != request.selection_mask_bounds.width ||
       request.selection_mask->height() != request.selection_mask_bounds.height)) {
    return fail(error, "selection mask must be bounded Gray8 data");
  }
  if (layer_is_effectively_locked(document.layers(), layer_id)) {
    return fail(error, "layer-mask stroke target is locked");
  }
  const auto& source_mask = *layer->mask();
  if (source_mask.disabled) {
    return fail(error, "layer-mask stroke requires an enabled raster mask");
  }
  if (source_mask.pixels.empty() ||
      source_mask.pixels.format() != PixelFormat::gray8() ||
      source_mask.pixels.width() != source_mask.bounds.width ||
      source_mask.pixels.height() != source_mask.bounds.height ||
      source_mask.bounds.width <= 0 || source_mask.bounds.height <= 0 ||
      document.width() <= 0 || document.height() <= 0) {
    return fail(error, "layer-mask stroke requires bounded Gray8 mask data");
  }

  const auto continue_or_cancel = [&request]() {
    if (request.continue_operation && !request.continue_operation()) {
      throw LayerMaskStrokeCancelled{};
    }
  };

  try {
    // Cancellation precedes any allocation or scan. The temporary Gray8 layer
    // keeps mask painting at one byte per pixel instead of expanding it to RGBA.
    continue_or_cancel();
    const auto padding = std::max(1, request.brush_size) / 2 + 1;
    auto minimum_x = request.points.front().x;
    auto minimum_y = request.points.front().y;
    auto maximum_x = minimum_x;
    auto maximum_y = minimum_y;
    for (const auto& point : request.points) {
      minimum_x = std::min(minimum_x, point.x);
      minimum_y = std::min(minimum_y, point.y);
      maximum_x = std::max(maximum_x, point.x);
      maximum_y = std::max(maximum_y, point.y);
    }
    const auto bounded_x = [width = document.width()](double value) {
      return std::clamp(value, 0.0, static_cast<double>(width));
    };
    const auto bounded_y = [height = document.height()](double value) {
      return std::clamp(value, 0.0, static_cast<double>(height));
    };
    const auto left = static_cast<std::int32_t>(
        std::floor(bounded_x(minimum_x - padding)));
    const auto top = static_cast<std::int32_t>(
        std::floor(bounded_y(minimum_y - padding)));
    const auto right = static_cast<std::int32_t>(
        std::ceil(bounded_x(maximum_x + padding + 1)));
    const auto bottom = static_cast<std::int32_t>(
        std::ceil(bounded_y(maximum_y + padding + 1)));
    const Rect stroke_bounds{left, top, std::max(0, right - left),
                             std::max(0, bottom - top)};
    const auto source_right = static_cast<std::int64_t>(source_mask.bounds.x) +
                              source_mask.bounds.width;
    const auto source_bottom = static_cast<std::int64_t>(source_mask.bounds.y) +
                               source_mask.bounds.height;
    const auto stroke_right = static_cast<std::int64_t>(stroke_bounds.x) +
                              stroke_bounds.width;
    const auto stroke_bottom = static_cast<std::int64_t>(stroke_bounds.y) +
                               stroke_bounds.height;
    const auto working_left = std::min<std::int64_t>(source_mask.bounds.x,
                                                     stroke_bounds.x);
    const auto working_top = std::min<std::int64_t>(source_mask.bounds.y,
                                                    stroke_bounds.y);
    const auto working_right = std::max(source_right, stroke_right);
    const auto working_bottom = std::max(source_bottom, stroke_bottom);
    const auto working_width = working_right - working_left;
    const auto working_height = working_bottom - working_top;
    const auto coordinate_min =
        static_cast<std::int64_t>(std::numeric_limits<std::int32_t>::min());
    const auto coordinate_max =
        static_cast<std::int64_t>(std::numeric_limits<std::int32_t>::max());
    if (working_left < coordinate_min || working_top < coordinate_min ||
        working_right > coordinate_max || working_bottom > coordinate_max ||
        working_width <= 0 || working_height <= 0 ||
        static_cast<std::uint64_t>(working_width) >
            kMaximumLayerMaskStrokePixels /
                static_cast<std::uint64_t>(working_height)) {
      return fail(error,
                  "layer-mask stroke working area exceeds its bounded contract");
    }
    const Rect working_bounds{
        static_cast<std::int32_t>(working_left),
        static_cast<std::int32_t>(working_top),
        static_cast<std::int32_t>(working_width),
        static_cast<std::int32_t>(working_height)};
    const auto same_bounds = working_bounds.x == source_mask.bounds.x &&
                             working_bounds.y == source_mask.bounds.y &&
                             working_bounds.width == source_mask.bounds.width &&
                             working_bounds.height == source_mask.bounds.height;
    PixelBuffer gray;
    if (same_bounds) {
      gray = source_mask.pixels;
    } else {
      gray = PixelBuffer(working_bounds.width, working_bounds.height,
                         PixelFormat::gray8());
      for (std::int32_t y = 0; y < working_bounds.height; ++y) {
        continue_or_cancel();
        auto row = gray.row(y);
        for (std::int32_t x = 0; x < working_bounds.width; ++x) {
          auto value = source_mask.default_color;
          const auto source_x = static_cast<std::int64_t>(x) +
                                working_bounds.x - source_mask.bounds.x;
          const auto source_y = static_cast<std::int64_t>(y) +
                                working_bounds.y - source_mask.bounds.y;
          if (source_x >= 0 && source_y >= 0 &&
              source_x < source_mask.pixels.width() &&
              source_y < source_mask.pixels.height()) {
            value = source_mask.pixels.pixel(
                static_cast<std::int32_t>(source_x),
                static_cast<std::int32_t>(source_y))[0];
          }
          row[static_cast<std::size_t>(x)] = value;
        }
      }
    }

    Document mask_document(document.width(), document.height(),
                           PixelFormat::gray8());
    const auto mask_layer_id = mask_document.allocate_layer_id();
    Layer mask_layer(mask_layer_id, "Layer mask", std::move(gray));
    mask_layer.set_bounds(working_bounds);
    mask_document.add_layer(std::move(mask_layer));

    const auto target = request.mode == RasterStrokeMode::Eraser
                            ? static_cast<std::uint8_t>(255)
                            : mask_luminance(request.color);
    const auto opacity = static_cast<double>(request.color.a) / 255.0;
    std::size_t coverage_checks = 0;
    EditOptions options;
    options.primary = {target, target, target, request.color.a};
    options.brush_size = request.brush_size;
    options.lock_transparent_pixels = true;
    options.progress_callback = continue_or_cancel;
    options.selection_coverage =
        [&request, &continue_or_cancel,
         &coverage_checks](std::int32_t x, std::int32_t y) {
          if ((coverage_checks++ & 1023U) == 0U) continue_or_cancel();
          if (request.selection_mask.has_value()) {
            const auto local_x = static_cast<std::int64_t>(x) -
                                 request.selection_mask_bounds.x;
            const auto local_y = static_cast<std::int64_t>(y) -
                                 request.selection_mask_bounds.y;
            if (local_x < 0 || local_y < 0 ||
                local_x >= request.selection_mask->width() ||
                local_y >= request.selection_mask->height()) {
              return 0.0F;
            }
            return static_cast<float>(
                       request.selection_mask
                           ->pixel(static_cast<std::int32_t>(local_x),
                                   static_cast<std::int32_t>(local_y))[0]) /
                   255.0F;
          }
          if (request.selection.empty()) return 1.0F;
          return std::any_of(
                     request.selection.begin(), request.selection.end(),
                     [x, y](const Rect& rect) { return rect.contains(x, y); })
                     ? 1.0F
                     : 0.0F;
        };
    options.stroke_pixel_writer =
        [target, opacity](std::int32_t, std::int32_t, std::uint8_t* pixel,
                          std::uint16_t channels, float coverage,
                          const EditColor&) {
          if (channels != 1U) return false;
          const auto before = pixel[0];
          pixel[0] = blend_byte(
              before, target,
              std::clamp(static_cast<double>(coverage) * opacity, 0.0, 1.0));
          return pixel[0] != before;
        };

    Rect affected;
    for (std::size_t index = 0; index < request.points.size(); ++index) {
      continue_or_cancel();
      const auto& from = request.points[index == 0 ? 0 : index - 1U];
      const auto& to = request.points[index];
      affected = unite_rect(
          affected,
          paint_brush_segment(mask_document, mask_layer_id, from.x, from.y,
                              to.x, to.y, options, false));
    }
    if (affected.empty()) {
      return fail(error, "raster stroke did not affect the target layer");
    }
    continue_or_cancel();
    const auto* painted = mask_document.find_layer(mask_layer_id);
    auto updated = source_mask;
    updated.bounds = painted->bounds();
    updated.pixels = painted->pixels();
    layer->set_mask(std::move(updated));
    if (result != nullptr) result->affected_region = affected;
    if (error != nullptr) error->clear();
    return true;
  } catch (const LayerMaskStrokeCancelled&) {
    return fail(error, "raster stroke was cancelled");
  }
}

bool apply_raster_fill(Document& document, LayerId layer_id,
                       const RasterFillRequest& request,
                       RasterStrokeResult* result, std::string* error) {
  auto* layer = document.find_layer(layer_id);
  if (layer == nullptr || layer->kind() != LayerKind::Pixel ||
      layer->pixels().format() != PixelFormat::rgba8()) {
    return fail(error, "raster fill requires an RGBA8 pixel layer");
  }
  if ((layer->lock_flags() & kLayerLockImagePixels) != 0U) {
    return fail(error, "raster fill target pixels are locked");
  }
  if (request.mode > RasterFillMode::CustomDots ||
      request.pattern_size < 1 || request.pattern_size > 256 ||
      !std::isfinite(request.start.x) ||
      !std::isfinite(request.start.y) || !std::isfinite(request.end.x) ||
      !std::isfinite(request.end.y)) {
    return fail(error, "raster fill requires finite bounded input");
  }
  if (request.selection_mask.has_value() &&
      (request.selection_mask->format() != PixelFormat::gray8() ||
       request.selection_mask->width() != request.selection_mask_bounds.width ||
       request.selection_mask->height() != request.selection_mask_bounds.height)) {
    return fail(error, "selection mask must be bounded Gray8 data");
  }
  const auto layer_bounds = layer->bounds();
  const auto bounds = intersect_rect(layer_bounds, Rect::from_size(
      document.width(), document.height()));
  auto& pixels = layer->pixels();
  const auto transparent_lock =
      (layer->lock_flags() & kLayerLockTransparentPixels) != 0U;
  Rect affected;
  for (std::int32_t y = bounds.y; y < bounds.y + bounds.height; ++y) {
    if (request.continue_operation && !request.continue_operation()) {
      return fail(error, "raster fill was cancelled");
    }
    for (std::int32_t x = bounds.x; x < bounds.x + bounds.width; ++x) {
      const auto coverage = selection_coverage(request, x, y);
      if (coverage <= 0.0F) continue;
      auto* target = pixels.pixel(x - layer_bounds.x, y - layer_bounds.y);
      if (transparent_lock && target[3] == 0) continue;
      const auto color = fill_color(request, x, y);
      const auto alpha = static_cast<double>(coverage) * color.a / 255.0;
      if (alpha <= 0.0) continue;
      const auto before = std::array<std::uint8_t, 4>{target[0], target[1],
                                                     target[2], target[3]};
      const auto destination_alpha = static_cast<double>(target[3]) / 255.0;
      const auto output_alpha = transparent_lock
          ? destination_alpha
          : alpha + destination_alpha * (1.0 - alpha);
      for (std::size_t channel = 0; channel < 3; ++channel) {
        const auto source = channel == 0 ? color.r : channel == 1 ? color.g : color.b;
        const auto value = transparent_lock
            ? source * alpha + target[channel] * (1.0 - alpha)
            : (source * alpha + target[channel] * destination_alpha *
               (1.0 - alpha)) / std::max(output_alpha, 1e-9);
        target[channel] = static_cast<std::uint8_t>(std::clamp(
            std::lround(value), 0L, 255L));
      }
      if (!transparent_lock) {
        target[3] = static_cast<std::uint8_t>(std::clamp(
            std::lround(output_alpha * 255.0), 0L, 255L));
      }
      if (!std::equal(before.begin(), before.end(), target)) {
        affected = unite_rect(affected, {x, y, 1, 1});
      }
    }
  }
  if (affected.empty()) return fail(error, "raster fill did not affect the target layer");
  if (result != nullptr) result->affected_region = affected;
  if (error != nullptr) error->clear();
  return true;
}

}  // namespace patchy
