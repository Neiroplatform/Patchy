#include "core/retouch_repair.hpp"

#include "core/blend_math.hpp"
#include "core/heal_membrane.hpp"
#include "core/layer_metadata.hpp"
#include "core/palette.hpp"
#include "core/pixel_tools.hpp"
#include "core/rect_utils.hpp"
#include "core/spot_heal.hpp"
#include "formats/document_flatten.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>
#include <vector>

namespace patchy {
namespace {

constexpr std::size_t kMaximumSpotPoints = 4096;
constexpr std::int32_t kMaximumBrushSize = 4096;
constexpr std::uint64_t kMaximumWorkingPixels = 16'777'216ULL;
constexpr std::uint64_t kMaximumStampWork = 67'108'864ULL;
constexpr double kPi = 3.14159265358979323846;

bool fail(std::string* error, std::string_view message) {
  if (error != nullptr) *error = std::string(message);
  return false;
}

bool cancelled(const RetouchRepairRequest& request) {
  return request.continue_operation && !request.continue_operation();
}

bool bounded_area(Rect bounds) {
  return bounds.width > 0 && bounds.height > 0 &&
         static_cast<std::uint64_t>(bounds.width) <=
             kMaximumWorkingPixels / static_cast<std::uint64_t>(bounds.height);
}

std::optional<Rect> translated_clipped_rect(Rect source, std::int32_t dx,
                                            std::int32_t dy,
                                            std::int32_t canvas_width,
                                            std::int32_t canvas_height) {
  const auto left = static_cast<std::int64_t>(source.x) + dx;
  const auto top = static_cast<std::int64_t>(source.y) + dy;
  const auto right = left + source.width;
  const auto bottom = top + source.height;
  const auto clipped_left = std::max<std::int64_t>(0, left);
  const auto clipped_top = std::max<std::int64_t>(0, top);
  const auto clipped_right =
      std::min<std::int64_t>(canvas_width, right);
  const auto clipped_bottom =
      std::min<std::int64_t>(canvas_height, bottom);
  if (clipped_right <= clipped_left || clipped_bottom <= clipped_top) {
    return std::nullopt;
  }
  return Rect{static_cast<std::int32_t>(clipped_left),
              static_cast<std::int32_t>(clipped_top),
              static_cast<std::int32_t>(clipped_right - clipped_left),
              static_cast<std::int32_t>(clipped_bottom - clipped_top)};
}

float brush_coverage(double distance_squared, std::int32_t radius,
                     std::int32_t softness) {
  if (radius <= 0) return distance_squared <= 0.0 ? 1.0F : 0.0F;
  const auto radius_squared = static_cast<double>(radius) * radius;
  if (distance_squared > radius_squared) return 0.0F;
  softness = std::clamp(softness, 0, 100);
  if (softness == 0) return 1.0F;
  const auto edge_width = std::max(
      1.0, static_cast<double>(radius) * softness / 100.0);
  const auto inner_radius =
      std::max(0.0, static_cast<double>(radius) - edge_width);
  const auto distance = std::sqrt(distance_squared);
  if (distance <= inner_radius) return 1.0F;
  const auto t =
      std::clamp((distance - inner_radius) / edge_width, 0.0, 1.0);
  const auto smooth = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  return static_cast<float>(1.0 - smooth);
}

std::uint8_t selection_alpha(const RetouchRepairRequest& request,
                             std::int32_t x, std::int32_t y) {
  if (request.selection_mask.has_value()) {
    const auto local_x = x - request.selection_mask_bounds.x;
    const auto local_y = y - request.selection_mask_bounds.y;
    if (local_x < 0 || local_y < 0 ||
        local_x >= request.selection_mask->width() ||
        local_y >= request.selection_mask->height()) {
      return 0;
    }
    return request.selection_mask->pixel(local_x, local_y)[0];
  }
  if (request.selection.empty()) return 255;
  return std::any_of(request.selection.begin(), request.selection.end(),
                     [x, y](const Rect& rect) { return rect.contains(x, y); })
             ? 255
             : 0;
}

PixelBuffer source_snapshot(const Document& document, const Layer& layer,
                            bool sample_all_layers) {
  if (sample_all_layers) return flatten_document_rgba8(document);
  Document isolated(document.width(), document.height(), document.format());
  auto copy = layer;
  copy.set_visible(true);
  copy.set_clipped(false);
  copy.set_blend_mode(BlendMode::Normal);
  isolated.add_layer(std::move(copy));
  return flatten_document_rgba8(isolated);
}

void blend_straight_rgba(std::uint8_t* destination,
                         const std::uint8_t* source, float coverage,
                         bool preserve_alpha) {
  coverage = std::clamp(coverage, 0.0F, 1.0F);
  if (preserve_alpha) {
    const auto effective = coverage * static_cast<float>(source[3]) / 255.0F;
    for (std::size_t channel = 0; channel < 3; ++channel) {
      destination[channel] = clamp_byte(
          static_cast<float>(source[channel]) * effective +
          static_cast<float>(destination[channel]) * (1.0F - effective));
    }
    return;
  }
  const auto source_alpha = coverage * static_cast<float>(source[3]) / 255.0F;
  const auto destination_alpha = static_cast<float>(destination[3]) / 255.0F;
  const auto output_alpha = source_alpha + destination_alpha * (1.0F - source_alpha);
  if (output_alpha <= 0.0F) {
    destination[0] = destination[1] = destination[2] = destination[3] = 0;
    return;
  }
  for (std::size_t channel = 0; channel < 3; ++channel) {
    const auto premultiplied = static_cast<float>(source[channel]) * source_alpha +
        static_cast<float>(destination[channel]) * destination_alpha *
            (1.0F - source_alpha);
    destination[channel] = clamp_byte(premultiplied / output_alpha);
  }
  destination[3] = clamp_byte(output_alpha * 255.0F);
}

struct RepairMask {
  Rect bounds{};
  std::vector<std::uint8_t> alpha{};
};

std::optional<RepairMask> spot_mask(const Document& document,
                                    const RetouchRepairRequest& request,
                                    std::string* error) {
  if (request.points.empty() || request.points.size() > kMaximumSpotPoints ||
      request.brush_size < 1 || request.brush_size > kMaximumBrushSize ||
      request.softness < 0 || request.softness > 100) {
    fail(error, "spot healing geometry exceeds its bounded contract");
    return std::nullopt;
  }
  for (const auto& point : request.points) {
    if (!std::isfinite(point.x) || !std::isfinite(point.y) || point.x < 0.0 ||
        point.y < 0.0 || point.x > document.width() - 1.0 ||
        point.y > document.height() - 1.0) {
      fail(error, "spot healing points must be finite document coordinates");
      return std::nullopt;
    }
  }
  const auto radius = std::max(1, request.brush_size / 2);
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
  const auto pad = radius + 3;
  const auto canvas = Rect::from_size(document.width(), document.height());
  const Rect raw{static_cast<std::int32_t>(std::floor(minimum_x)) - pad,
                 static_cast<std::int32_t>(std::floor(minimum_y)) - pad,
                 static_cast<std::int32_t>(std::ceil(maximum_x - minimum_x)) +
                     pad * 2 + 1,
                 static_cast<std::int32_t>(std::ceil(maximum_y - minimum_y)) +
                     pad * 2 + 1};
  RepairMask result;
  result.bounds = intersect_rect(raw, canvas);
  if (!bounded_area(result.bounds)) {
    fail(error, "spot healing working area exceeds its bounded contract");
    return std::nullopt;
  }
  result.alpha.assign(static_cast<std::size_t>(result.bounds.width) *
                          static_cast<std::size_t>(result.bounds.height),
                      0);
  std::uint64_t work = 0;
  for (std::size_t index = 0; index < request.points.size(); ++index) {
    if (cancelled(request)) {
      fail(error, "retouch repair was cancelled");
      return std::nullopt;
    }
    const auto& from = request.points[index == 0 ? 0 : index - 1U];
    const auto& to = request.points[index];
    const auto left = std::max(
        result.bounds.x,
        static_cast<std::int32_t>(std::floor(std::min(from.x, to.x))) - radius - 1);
    const auto top = std::max(
        result.bounds.y,
        static_cast<std::int32_t>(std::floor(std::min(from.y, to.y))) - radius - 1);
    const auto right = std::min(
        result.bounds.x + result.bounds.width,
        static_cast<std::int32_t>(std::ceil(std::max(from.x, to.x))) + radius + 2);
    const auto bottom = std::min(
        result.bounds.y + result.bounds.height,
        static_cast<std::int32_t>(std::ceil(std::max(from.y, to.y))) + radius + 2);
    const auto segment_work = static_cast<std::uint64_t>(std::max(0, right - left)) *
                              static_cast<std::uint64_t>(std::max(0, bottom - top));
    if (segment_work > kMaximumStampWork - work) {
      fail(error, "spot healing stamp work exceeds its bounded contract");
      return std::nullopt;
    }
    work += segment_work;
    const auto ab_x = to.x - from.x;
    const auto ab_y = to.y - from.y;
    const auto ab_length_squared = ab_x * ab_x + ab_y * ab_y;
    for (auto y = top; y < bottom; ++y) {
      for (auto x = left; x < right; ++x) {
        auto t = 0.0;
        if (ab_length_squared > 0.0) {
          t = std::clamp(((static_cast<double>(x) - from.x) * ab_x +
                          (static_cast<double>(y) - from.y) * ab_y) /
                             ab_length_squared,
                         0.0, 1.0);
        }
        const auto nearest_x = from.x + t * ab_x;
        const auto nearest_y = from.y + t * ab_y;
        const auto dx = static_cast<double>(x) - nearest_x;
        const auto dy = static_cast<double>(y) - nearest_y;
        const auto coverage = brush_coverage(dx * dx + dy * dy, radius,
                                             request.softness);
        const auto value = static_cast<std::uint8_t>(
            std::clamp(std::lround(coverage * 255.0F), 0L, 255L));
        const auto mask_index =
            static_cast<std::size_t>(y - result.bounds.y) *
                static_cast<std::size_t>(result.bounds.width) +
            static_cast<std::size_t>(x - result.bounds.x);
        result.alpha[mask_index] = std::max(result.alpha[mask_index], value);
      }
    }
  }
  if (std::none_of(result.alpha.begin(), result.alpha.end(),
                   [](std::uint8_t value) { return value != 0; })) {
    fail(error, "spot healing did not cover the document");
    return std::nullopt;
  }
  return result;
}

std::optional<RepairMask> patch_mask(const Document& document,
                                     const RetouchRepairRequest& request,
                                     std::string* error) {
  RepairMask result;
  const auto canvas = Rect::from_size(document.width(), document.height());
  if (request.selection_mask.has_value()) {
    if (request.selection_mask->format() != PixelFormat::gray8() ||
        request.selection_mask->width() != request.selection_mask_bounds.width ||
        request.selection_mask->height() != request.selection_mask_bounds.height) {
      fail(error, "Patch selection mask must be bounded Gray8 data");
      return std::nullopt;
    }
    result.bounds = intersect_rect(request.selection_mask_bounds, canvas);
    if (!bounded_area(result.bounds)) {
      fail(error, "Patch selection exceeds its bounded contract");
      return std::nullopt;
    }
    result.alpha.resize(static_cast<std::size_t>(result.bounds.width) *
                        static_cast<std::size_t>(result.bounds.height));
    for (std::int32_t y = 0; y < result.bounds.height; ++y) {
      for (std::int32_t x = 0; x < result.bounds.width; ++x) {
        result.alpha[static_cast<std::size_t>(y) * result.bounds.width + x] =
            request.selection_mask
                ->pixel(result.bounds.x + x - request.selection_mask_bounds.x,
                        result.bounds.y + y - request.selection_mask_bounds.y)[0];
      }
    }
  } else {
    for (const auto& rect : request.selection) {
      result.bounds = unite_rect(result.bounds, intersect_rect(rect, canvas));
    }
    if (!bounded_area(result.bounds)) {
      fail(error, "Patch requires a bounded non-empty selection");
      return std::nullopt;
    }
    result.alpha.resize(static_cast<std::size_t>(result.bounds.width) *
                            static_cast<std::size_t>(result.bounds.height),
                        0);
    for (std::int32_t y = 0; y < result.bounds.height; ++y) {
      for (std::int32_t x = 0; x < result.bounds.width; ++x) {
        const auto doc_x = result.bounds.x + x;
        const auto doc_y = result.bounds.y + y;
        if (std::any_of(request.selection.begin(), request.selection.end(),
                        [doc_x, doc_y](const Rect& rect) {
                          return rect.contains(doc_x, doc_y);
                        })) {
          result.alpha[static_cast<std::size_t>(y) * result.bounds.width + x] = 255;
        }
      }
    }
  }
  if (std::none_of(result.alpha.begin(), result.alpha.end(),
                   [](std::uint8_t value) { return value != 0; })) {
    fail(error, "Patch requires a non-empty selection");
    return std::nullopt;
  }
  return result;
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

bool apply_spot(Document& document, LayerId layer_id,
                const RetouchRepairRequest& request,
                RetouchRepairResult* result, std::string* error) {
  auto mask = spot_mask(document, request, error);
  if (!mask.has_value()) return false;
  if (cancelled(request)) return fail(error, "retouch repair was cancelled");
  auto* layer = document.find_layer(layer_id);
  const auto source = source_snapshot(document, *layer, request.sample_all_layers);
  const auto source_map = spot_heal_source_map(
      mask->alpha.data(), mask->bounds, document.width(), document.height());
  if (!source_map.valid) {
    return fail(error, "Spot healing needs unpainted pixels around the stroke");
  }
  const auto cells = mask->alpha.size();
  std::vector<std::uint8_t> interior(cells);
  std::vector<std::int16_t> membrane(cells * 3U);
  const auto snapshot_pixel = [&](std::int32_t x, std::int32_t y) {
    x = std::clamp(x, 0, document.width() - 1);
    y = std::clamp(y, 0, document.height() - 1);
    return source.pixel(x, y);
  };
  for (std::int32_t y = 0; y < mask->bounds.height; ++y) {
    if (cancelled(request)) return fail(error, "retouch repair was cancelled");
    for (std::int32_t x = 0; x < mask->bounds.width; ++x) {
      const auto index = static_cast<std::size_t>(y) * mask->bounds.width + x;
      interior[index] = mask->alpha[index] == 0 ? 0 : 1;
      if (interior[index] != 0) continue;
      const auto doc_x = mask->bounds.x + x;
      const auto doc_y = mask->bounds.y + y;
      const auto [source_x, source_y] = source_map.map(doc_x, doc_y);
      const auto* destination = snapshot_pixel(doc_x, doc_y);
      const auto* source_pixel = snapshot_pixel(source_x, source_y);
      for (std::size_t channel = 0; channel < 3; ++channel) {
        membrane[index * 3U + channel] = static_cast<std::int16_t>(
            static_cast<int>(destination[channel]) -
            static_cast<int>(source_pixel[channel]));
      }
    }
  }
  if (!solve_heal_membrane_cancellable(
          interior.data(), mask->bounds.width, mask->bounds.height,
          membrane.data(), request.continue_operation)) {
    return fail(error, "retouch repair was cancelled");
  }
  if (cancelled(request)) return fail(error, "retouch repair was cancelled");

  const auto lock_transparent =
      (layer->lock_flags() & kLayerLockTransparentPixels) != 0U;
  if (!lock_transparent) expand_layer_to_include_rect(*layer, mask->bounds);
  auto& pixels = layer->pixels();
  const auto layer_bounds = layer->bounds();
  PaletteLut palette_lut;
  const auto snap = palette_context(document, palette_lut);
  Rect affected;
  for (std::int32_t y = 0; y < mask->bounds.height; ++y) {
    if (cancelled(request)) return fail(error, "retouch repair was cancelled");
    for (std::int32_t x = 0; x < mask->bounds.width; ++x) {
      const auto index = static_cast<std::size_t>(y) * mask->bounds.width + x;
      if (mask->alpha[index] == 0) continue;
      const auto doc_x = mask->bounds.x + x;
      const auto doc_y = mask->bounds.y + y;
      const auto selected = selection_alpha(request, doc_x, doc_y);
      if (selected == 0 || !layer_bounds.contains(doc_x, doc_y)) continue;
      auto* destination = pixels.pixel(doc_x - layer_bounds.x,
                                       doc_y - layer_bounds.y);
      if (lock_transparent && destination[3] == 0) continue;
      const auto [source_x, source_y] = source_map.map(doc_x, doc_y);
      const auto* sampled = snapshot_pixel(source_x, source_y);
      std::array<std::uint8_t, 4> healed{};
      for (std::size_t channel = 0; channel < 3; ++channel) {
        healed[channel] = clamp_byte(
            static_cast<float>(sampled[channel]) + membrane[index * 3U + channel]);
      }
      healed[3] = sampled[3];
      const auto before = std::array<std::uint8_t, 4>{
          destination[0], destination[1], destination[2], destination[3]};
      auto coverage = static_cast<float>(mask->alpha[index]) / 255.0F *
                      static_cast<float>(selected) / 255.0F;
      if (snap.lut != nullptr) {
        if (coverage < snap.coverage_threshold) continue;
        coverage = 1.0F;
      }
      blend_straight_rgba(destination, healed.data(), coverage,
                          lock_transparent);
      if (snap.lut != nullptr) {
        snap_pixel_to_palette(destination, pixels.format().channels, snap);
      }
      if (!std::equal(before.begin(), before.end(), destination)) {
        affected = unite_rect(affected, {doc_x, doc_y, 1, 1});
      }
    }
  }
  if (affected.empty()) return fail(error, "retouch repair made no pixel change");
  result->affected_region = affected;
  return true;
}

bool apply_patch(Document& document, LayerId layer_id,
                 const RetouchRepairRequest& request,
                 RetouchRepairResult* result, std::string* error) {
  if (request.delta_x == 0 && request.delta_y == 0) {
    return fail(error, "Patch requires a non-zero drag offset");
  }
  auto mask = patch_mask(document, request, error);
  if (!mask.has_value()) return false;
  if (cancelled(request)) return fail(error, "retouch repair was cancelled");
  auto* layer = document.find_layer(layer_id);
  const auto source = source_snapshot(document, *layer, request.sample_all_layers);
  const auto destination_offset_x =
      request.mode == RetouchRepairMode::PatchDestination ? request.delta_x : 0;
  const auto destination_offset_y =
      request.mode == RetouchRepairMode::PatchDestination ? request.delta_y : 0;
  const auto source_offset_x =
      request.mode == RetouchRepairMode::PatchDestination
          ? -static_cast<std::int64_t>(request.delta_x)
          : static_cast<std::int64_t>(request.delta_x);
  const auto source_offset_y =
      request.mode == RetouchRepairMode::PatchDestination
          ? -static_cast<std::int64_t>(request.delta_y)
          : static_cast<std::int64_t>(request.delta_y);
  const auto translated_bounds = translated_clipped_rect(
      mask->bounds, destination_offset_x, destination_offset_y,
      document.width(), document.height());
  if (!translated_bounds.has_value() || !bounded_area(*translated_bounds)) {
    return fail(error, "Patch destination exceeds its bounded contract");
  }
  const auto destination_bounds = *translated_bounds;
  const auto solve_left = std::max(0, destination_bounds.x - 1);
  const auto solve_top = std::max(0, destination_bounds.y - 1);
  const auto solve_right = std::min(
      document.width(), destination_bounds.x + destination_bounds.width + 1);
  const auto solve_bottom = std::min(
      document.height(), destination_bounds.y + destination_bounds.height + 1);
  const Rect solve_bounds{solve_left, solve_top, solve_right - solve_left,
                          solve_bottom - solve_top};
  if (!bounded_area(solve_bounds)) {
    return fail(error, "Patch solve area exceeds its bounded contract");
  }
  const auto solve_cells = static_cast<std::size_t>(solve_bounds.width) *
                           static_cast<std::size_t>(solve_bounds.height);
  const auto mask_area = static_cast<std::uint64_t>(std::count_if(
      mask->alpha.begin(), mask->alpha.end(),
      [](std::uint8_t value) { return value != 0; }));
  const auto diameter = std::clamp(
      static_cast<std::int32_t>(std::lround(
          2.0 * std::sqrt(static_cast<double>(mask_area) / kPi))),
      4, kMaximumBrushSize);
  const auto tone_radius = std::max(2, (diameter * 4 + 15) / 16);
  const auto snapshot_pixel = [&](std::int64_t x, std::int64_t y) {
    x = std::clamp<std::int64_t>(x, 0, document.width() - 1);
    y = std::clamp<std::int64_t>(y, 0, document.height() - 1);
    return source.pixel(static_cast<std::int32_t>(x),
                        static_cast<std::int32_t>(y));
  };

  std::vector<std::uint8_t> low_pass;
  if (request.transparent) {
    std::vector<std::uint8_t> source_patch(solve_cells * 3U);
    for (std::int32_t y = 0; y < solve_bounds.height; ++y) {
      if (cancelled(request)) return fail(error, "retouch repair was cancelled");
      for (std::int32_t x = 0; x < solve_bounds.width; ++x) {
        const auto* sampled = snapshot_pixel(solve_bounds.x + x + source_offset_x,
                                             solve_bounds.y + y + source_offset_y);
        const auto index = (static_cast<std::size_t>(y) * solve_bounds.width + x) * 3U;
        std::copy_n(sampled, 3, source_patch.data() + index);
      }
    }
    std::vector<std::uint8_t> horizontal(solve_cells * 3U);
    std::vector<std::uint32_t> prefix(
        (static_cast<std::size_t>(std::max(solve_bounds.width,
                                          solve_bounds.height)) + 1U) * 3U);
    for (std::int32_t y = 0; y < solve_bounds.height; ++y) {
      const auto row = static_cast<std::size_t>(y) * solve_bounds.width;
      prefix[0] = prefix[1] = prefix[2] = 0;
      for (std::int32_t x = 0; x < solve_bounds.width; ++x) {
        for (std::size_t channel = 0; channel < 3; ++channel) {
          prefix[(static_cast<std::size_t>(x) + 1U) * 3U + channel] =
              prefix[static_cast<std::size_t>(x) * 3U + channel] +
              source_patch[(row + x) * 3U + channel];
        }
      }
      for (std::int32_t x = 0; x < solve_bounds.width; ++x) {
        const auto first = std::max(0, x - tone_radius);
        const auto last = std::min(solve_bounds.width - 1, x + tone_radius);
        const auto count = last - first + 1;
        for (std::size_t channel = 0; channel < 3; ++channel) {
          horizontal[(row + x) * 3U + channel] = static_cast<std::uint8_t>(
              (prefix[(static_cast<std::size_t>(last) + 1U) * 3U + channel] -
               prefix[static_cast<std::size_t>(first) * 3U + channel]) /
              count);
        }
      }
    }
    low_pass.resize(solve_cells * 3U);
    for (std::int32_t x = 0; x < solve_bounds.width; ++x) {
      prefix[0] = prefix[1] = prefix[2] = 0;
      for (std::int32_t y = 0; y < solve_bounds.height; ++y) {
        const auto index = static_cast<std::size_t>(y) * solve_bounds.width + x;
        for (std::size_t channel = 0; channel < 3; ++channel) {
          prefix[(static_cast<std::size_t>(y) + 1U) * 3U + channel] =
              prefix[static_cast<std::size_t>(y) * 3U + channel] +
              horizontal[index * 3U + channel];
        }
      }
      for (std::int32_t y = 0; y < solve_bounds.height; ++y) {
        const auto first = std::max(0, y - tone_radius);
        const auto last = std::min(solve_bounds.height - 1, y + tone_radius);
        const auto count = last - first + 1;
        const auto index = static_cast<std::size_t>(y) * solve_bounds.width + x;
        for (std::size_t channel = 0; channel < 3; ++channel) {
          low_pass[index * 3U + channel] = static_cast<std::uint8_t>(
              (prefix[(static_cast<std::size_t>(last) + 1U) * 3U + channel] -
               prefix[static_cast<std::size_t>(first) * 3U + channel]) /
              count);
        }
      }
    }
  }

  std::vector<std::uint8_t> interior(solve_cells);
  std::vector<std::int16_t> membrane(solve_cells * 3U);
  for (std::int32_t y = 0; y < solve_bounds.height; ++y) {
    if (cancelled(request)) return fail(error, "retouch repair was cancelled");
    for (std::int32_t x = 0; x < solve_bounds.width; ++x) {
      const auto index = static_cast<std::size_t>(y) * solve_bounds.width + x;
      const auto doc_x = solve_bounds.x + x;
      const auto doc_y = solve_bounds.y + y;
      const auto mask_x = doc_x - destination_offset_x - mask->bounds.x;
      const auto mask_y = doc_y - destination_offset_y - mask->bounds.y;
      const auto coverage =
          mask_x >= 0 && mask_y >= 0 && mask_x < mask->bounds.width &&
                  mask_y < mask->bounds.height
              ? mask->alpha[static_cast<std::size_t>(mask_y) *
                                mask->bounds.width +
                            mask_x]
              : 0;
      interior[index] = coverage == 0 ? 0 : 1;
      if (coverage != 0) continue;
      const auto* sampled = snapshot_pixel(
          static_cast<std::int64_t>(doc_x) + source_offset_x,
          static_cast<std::int64_t>(doc_y) + source_offset_y);
      if (request.transparent) {
        for (std::size_t channel = 0; channel < 3; ++channel) {
          membrane[index * 3U + channel] = static_cast<std::int16_t>(
              static_cast<int>(low_pass[index * 3U + channel]) -
              static_cast<int>(sampled[channel]));
        }
      } else {
        const auto* destination = snapshot_pixel(doc_x, doc_y);
        for (std::size_t channel = 0; channel < 3; ++channel) {
          membrane[index * 3U + channel] = static_cast<std::int16_t>(
              static_cast<int>(destination[channel]) -
              static_cast<int>(sampled[channel]));
        }
      }
    }
  }
  if (!solve_heal_membrane_cancellable(
          interior.data(), solve_bounds.width, solve_bounds.height,
          membrane.data(), request.continue_operation)) {
    return fail(error, "retouch repair was cancelled");
  }
  if (cancelled(request)) return fail(error, "retouch repair was cancelled");

  const auto lock_transparent =
      (layer->lock_flags() & kLayerLockTransparentPixels) != 0U;
  if (!lock_transparent) expand_layer_to_include_rect(*layer, destination_bounds);
  auto& pixels = layer->pixels();
  const auto layer_bounds = layer->bounds();
  PaletteLut palette_lut;
  const auto snap = palette_context(document, palette_lut);
  Rect affected;
  for (std::int32_t y = destination_bounds.y;
       y < destination_bounds.y + destination_bounds.height; ++y) {
    if (cancelled(request)) return fail(error, "retouch repair was cancelled");
    for (std::int32_t x = destination_bounds.x;
         x < destination_bounds.x + destination_bounds.width; ++x) {
      const auto mask_x = x - destination_offset_x - mask->bounds.x;
      const auto mask_y = y - destination_offset_y - mask->bounds.y;
      if (mask_x < 0 || mask_y < 0 || mask_x >= mask->bounds.width ||
          mask_y >= mask->bounds.height) continue;
      const auto coverage_byte =
          mask->alpha[static_cast<std::size_t>(mask_y) * mask->bounds.width + mask_x];
      if (coverage_byte == 0 || !layer_bounds.contains(x, y)) continue;
      const auto source_x_wide = static_cast<std::int64_t>(x) + source_offset_x;
      const auto source_y_wide = static_cast<std::int64_t>(y) + source_offset_y;
      if (source_x_wide < 0 || source_y_wide < 0 ||
          source_x_wide >= document.width() ||
          source_y_wide >= document.height()) {
        continue;
      }
      const auto source_x = static_cast<std::int32_t>(source_x_wide);
      const auto source_y = static_cast<std::int32_t>(source_y_wide);
      auto* destination = pixels.pixel(x - layer_bounds.x, y - layer_bounds.y);
      if (lock_transparent && destination[3] == 0) continue;
      const auto* sampled = source.pixel(source_x, source_y);
      const auto solve_index =
          static_cast<std::size_t>(y - solve_bounds.y) * solve_bounds.width +
          static_cast<std::size_t>(x - solve_bounds.x);
      std::array<std::uint8_t, 4> healed{};
      if (request.transparent) {
        const auto* original = source.pixel(x, y);
        for (std::size_t channel = 0; channel < 3; ++channel) {
          const auto detail = static_cast<int>(sampled[channel]) -
                              static_cast<int>(low_pass[solve_index * 3U + channel]) +
                              membrane[solve_index * 3U + channel];
          healed[channel] = clamp_byte(static_cast<float>(
              static_cast<int>(original[channel]) + detail));
        }
        healed[3] = original[3];
      } else {
        for (std::size_t channel = 0; channel < 3; ++channel) {
          healed[channel] = clamp_byte(
              static_cast<float>(sampled[channel]) +
              membrane[solve_index * 3U + channel]);
        }
        healed[3] = sampled[3];
      }
      const auto before = std::array<std::uint8_t, 4>{
          destination[0], destination[1], destination[2], destination[3]};
      auto coverage = static_cast<float>(coverage_byte) / 255.0F;
      if (snap.lut != nullptr) {
        if (coverage < snap.coverage_threshold) continue;
        coverage = 1.0F;
      }
      blend_straight_rgba(destination, healed.data(), coverage,
                          lock_transparent);
      if (snap.lut != nullptr) {
        snap_pixel_to_palette(destination, pixels.format().channels, snap);
      }
      if (!std::equal(before.begin(), before.end(), destination)) {
        affected = unite_rect(affected, {x, y, 1, 1});
      }
    }
  }
  if (affected.empty()) return fail(error, "retouch repair made no pixel change");
  result->affected_region = affected;
  if (request.mode == RetouchRepairMode::PatchDestination) {
    result->selection_delta_x = request.delta_x;
    result->selection_delta_y = request.delta_y;
  }
  return true;
}

}  // namespace

bool apply_retouch_repair(Document& document, LayerId layer_id,
                          const RetouchRepairRequest& request,
                          RetouchRepairResult* result, std::string* error) {
  auto* layer = document.find_layer(layer_id);
  if (layer == nullptr || layer->kind() != LayerKind::Pixel) {
    return fail(error, "retouch repair requires a pixel layer");
  }
  if (layer->pixels().format() != PixelFormat::rgba8()) {
    return fail(error, "retouch repair requires an RGBA8 layer");
  }
  if (layer_is_effectively_locked(document.layers(), layer_id) ||
      (layer->lock_flags() & kLayerLockImagePixels) != 0U) {
    return fail(error, "retouch repair target pixels are locked");
  }
  if (request.mode != RetouchRepairMode::SpotHealing &&
      request.mode != RetouchRepairMode::PatchSource &&
      request.mode != RetouchRepairMode::PatchDestination) {
    return fail(error, "retouch repair mode is invalid");
  }
  if (request.selection_mask.has_value() &&
      (request.selection_mask->format() != PixelFormat::gray8() ||
       request.selection_mask->width() != request.selection_mask_bounds.width ||
       request.selection_mask->height() != request.selection_mask_bounds.height)) {
    return fail(error, "selection mask must be bounded Gray8 data");
  }
  if (request.mode == RetouchRepairMode::SpotHealing && request.transparent) {
    return fail(error, "Spot healing does not support transparent Patch mode");
  }
  if (cancelled(request)) return fail(error, "retouch repair was cancelled");
  try {
    auto prepared = document;
    RetouchRepairResult repaired;
    const auto ok = request.mode == RetouchRepairMode::SpotHealing
                        ? apply_spot(prepared, layer_id, request, &repaired, error)
                        : apply_patch(prepared, layer_id, request, &repaired, error);
    if (!ok) return false;
    if (cancelled(request)) return fail(error, "retouch repair was cancelled");
    document = std::move(prepared);
    if (result != nullptr) *result = repaired;
    if (error != nullptr) error->clear();
    return true;
  } catch (const std::bad_alloc&) {
    return fail(error, "retouch repair allocation failed");
  }
}

}  // namespace patchy
