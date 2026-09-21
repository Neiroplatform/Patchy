#include "core/layer_warp.hpp"

#include "core/layer_metadata.hpp"
#include "core/smart_object.hpp"
#include "core/text_warp.hpp"
#include "core/warp_mesh.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>
#include <vector>

namespace patchy {
namespace {

constexpr std::int32_t kMaximumWarpDimension = 32768;
constexpr std::uint64_t kMaximumWarpPixels = 268435456ULL;
constexpr std::uint64_t kMaximumWarpBytes = 512ULL * 1024ULL * 1024ULL;

bool fail(std::string* error, std::string_view message) {
  if (error != nullptr) *error = std::string(message);
  return false;
}

Rect unite(Rect first, Rect second) {
  const auto left = std::min(first.x, second.x);
  const auto top = std::min(first.y, second.y);
  const auto right = std::max<std::int64_t>(
      static_cast<std::int64_t>(first.x) + first.width,
      static_cast<std::int64_t>(second.x) + second.width);
  const auto bottom = std::max<std::int64_t>(
      static_cast<std::int64_t>(first.y) + first.height,
      static_cast<std::int64_t>(second.y) + second.height);
  return Rect{left, top, static_cast<std::int32_t>(right - left),
              static_cast<std::int32_t>(bottom - top)};
}

struct Sample {
  double c0{0.0};
  double c1{0.0};
  double c2{0.0};
  double alpha{0.0};
};

Sample rgba_sample(const PixelBuffer& source, std::int32_t x, std::int32_t y) {
  if (x < 0 || y < 0 || x >= source.width() || y >= source.height()) return {};
  const auto* pixel = source.pixel(x, y);
  const auto alpha = static_cast<double>(pixel[3]);
  return {static_cast<double>(pixel[0]) * alpha / 255.0,
          static_cast<double>(pixel[1]) * alpha / 255.0,
          static_cast<double>(pixel[2]) * alpha / 255.0, alpha};
}

Sample weighted(Sample total, const Sample& sample, double weight) {
  total.c0 += sample.c0 * weight;
  total.c1 += sample.c1 * weight;
  total.c2 += sample.c2 * weight;
  total.alpha += sample.alpha * weight;
  return total;
}

Sample sample_rgba(const PixelBuffer& source, double x, double y,
                   LayerTransformInterpolation interpolation) {
  if (interpolation == LayerTransformInterpolation::Nearest) {
    return rgba_sample(source, static_cast<std::int32_t>(std::floor(x)),
                       static_cast<std::int32_t>(std::floor(y)));
  }
  const auto centered_x = x - 0.5;
  const auto centered_y = y - 0.5;
  const auto x0 = static_cast<std::int32_t>(std::floor(centered_x));
  const auto y0 = static_cast<std::int32_t>(std::floor(centered_y));
  const auto tx = centered_x - x0;
  const auto ty = centered_y - y0;
  Sample total;
  total = weighted(total, rgba_sample(source, x0, y0), (1.0 - tx) * (1.0 - ty));
  total = weighted(total, rgba_sample(source, x0 + 1, y0), tx * (1.0 - ty));
  total = weighted(total, rgba_sample(source, x0, y0 + 1), (1.0 - tx) * ty);
  return weighted(total, rgba_sample(source, x0 + 1, y0 + 1), tx * ty);
}

double gray_sample(const PixelBuffer& source, std::int32_t x, std::int32_t y,
                   std::uint8_t outside) {
  if (x < 0 || y < 0 || x >= source.width() || y >= source.height()) return outside;
  return source.pixel(x, y)[0];
}

std::uint8_t sample_gray(const PixelBuffer& source, double x, double y,
                         LayerTransformInterpolation interpolation,
                         std::uint8_t outside) {
  if (interpolation == LayerTransformInterpolation::Nearest) {
    return static_cast<std::uint8_t>(gray_sample(
        source, static_cast<std::int32_t>(std::floor(x)),
        static_cast<std::int32_t>(std::floor(y)), outside));
  }
  const auto centered_x = x - 0.5;
  const auto centered_y = y - 0.5;
  const auto x0 = static_cast<std::int32_t>(std::floor(centered_x));
  const auto y0 = static_cast<std::int32_t>(std::floor(centered_y));
  const auto tx = centered_x - x0;
  const auto ty = centered_y - y0;
  const auto top = gray_sample(source, x0, y0, outside) * (1.0 - tx) +
                   gray_sample(source, x0 + 1, y0, outside) * tx;
  const auto bottom = gray_sample(source, x0, y0 + 1, outside) * (1.0 - tx) +
                      gray_sample(source, x0 + 1, y0 + 1, outside) * tx;
  return static_cast<std::uint8_t>(std::clamp(
      std::lround(top * (1.0 - ty) + bottom * ty), 0L, 255L));
}

std::optional<Rect> grid_bounds(const WarpSurfaceGrid& grid) {
  if (grid.doc_xs.empty() || grid.doc_ys.empty()) return std::nullopt;
  const auto [min_x, max_x] = std::minmax_element(grid.doc_xs.begin(), grid.doc_xs.end());
  const auto [min_y, max_y] = std::minmax_element(grid.doc_ys.begin(), grid.doc_ys.end());
  const auto left = std::floor(*min_x) - 1.0;
  const auto top = std::floor(*min_y) - 1.0;
  const auto right = std::ceil(*max_x) + 1.0;
  const auto bottom = std::ceil(*max_y) + 1.0;
  if (left < std::numeric_limits<std::int32_t>::min() ||
      top < std::numeric_limits<std::int32_t>::min() ||
      right > std::numeric_limits<std::int32_t>::max() ||
      bottom > std::numeric_limits<std::int32_t>::max()) return std::nullopt;
  const auto width = right - left;
  const auto height = bottom - top;
  if (width < 1.0 || height < 1.0 || width > kMaximumWarpDimension ||
      height > kMaximumWarpDimension || width * height > kMaximumWarpPixels) {
    return std::nullopt;
  }
  return Rect{static_cast<std::int32_t>(left), static_cast<std::int32_t>(top),
              static_cast<std::int32_t>(width), static_cast<std::int32_t>(height)};
}

std::optional<PixelBuffer> resample_grid(
    const PixelBuffer& source, const WarpSurfaceGrid& grid, const Rect& bounds,
    LayerTransformInterpolation interpolation, std::uint8_t outside,
    const std::function<bool()>& continue_operation) {
  PixelBuffer target(bounds.width, bounds.height, source.format());
  target.clear(outside);
  std::vector<std::uint8_t> covered(
      static_cast<std::size_t>(bounds.width) * bounds.height, 0);
  const bool rgba = source.format() == PixelFormat::rgba8();
  const bool gray = source.format() == PixelFormat::gray8();
  if (!rgba && !gray) return std::nullopt;

  for (int cell_row = 0; cell_row + 1 < grid.rows; ++cell_row) {
    if (continue_operation && !continue_operation()) return std::nullopt;
    for (int cell_column = 0; cell_column + 1 < grid.columns; ++cell_column) {
      const auto i00 = static_cast<std::size_t>(cell_row * grid.columns + cell_column);
      const auto i10 = i00 + 1;
      const auto i01 = i00 + static_cast<std::size_t>(grid.columns);
      const auto i11 = i01 + 1;
      const auto cell_min_x = std::min({grid.doc_xs[i00], grid.doc_xs[i10],
                                        grid.doc_xs[i11], grid.doc_xs[i01]});
      const auto cell_max_x = std::max({grid.doc_xs[i00], grid.doc_xs[i10],
                                        grid.doc_xs[i11], grid.doc_xs[i01]});
      const auto cell_min_y = std::min({grid.doc_ys[i00], grid.doc_ys[i10],
                                        grid.doc_ys[i11], grid.doc_ys[i01]});
      const auto cell_max_y = std::max({grid.doc_ys[i00], grid.doc_ys[i10],
                                        grid.doc_ys[i11], grid.doc_ys[i01]});
      const auto x0 = std::max(bounds.x, static_cast<std::int32_t>(std::floor(cell_min_x)));
      const auto x1 = std::min(bounds.x + bounds.width,
                               static_cast<std::int32_t>(std::ceil(cell_max_x)) + 1);
      const auto y0 = std::max(bounds.y, static_cast<std::int32_t>(std::floor(cell_min_y)));
      const auto y1 = std::min(bounds.y + bounds.height,
                               static_cast<std::int32_t>(std::ceil(cell_max_y)) + 1);
      for (auto y = y0; y < y1; ++y) {
        for (auto x = x0; x < x1; ++x) {
          const auto target_index = static_cast<std::size_t>(y - bounds.y) * bounds.width +
                                    static_cast<std::size_t>(x - bounds.x);
          if (covered[target_index] != 0) continue;
          const auto st = invert_bilinear_cell(
              x + 0.5, y + 0.5, grid.doc_xs[i00], grid.doc_ys[i00],
              grid.doc_xs[i10], grid.doc_ys[i10], grid.doc_xs[i11],
              grid.doc_ys[i11], grid.doc_xs[i01], grid.doc_ys[i01]);
          if (!st.has_value()) continue;
          const auto s = (*st)[0];
          const auto t = (*st)[1];
          const auto source_x =
              (1.0 - t) * ((1.0 - s) * grid.source_xs[i00] + s * grid.source_xs[i10]) +
              t * ((1.0 - s) * grid.source_xs[i01] + s * grid.source_xs[i11]);
          const auto source_y =
              (1.0 - t) * ((1.0 - s) * grid.source_ys[i00] + s * grid.source_ys[i10]) +
              t * ((1.0 - s) * grid.source_ys[i01] + s * grid.source_ys[i11]);
          auto* pixel = target.pixel(x - bounds.x, y - bounds.y);
          if (rgba) {
            const auto sample = sample_rgba(source, source_x, source_y, interpolation);
            const auto alpha = static_cast<std::uint8_t>(
                std::clamp(std::lround(sample.alpha), 0L, 255L));
            pixel[3] = alpha;
            if (alpha == 0) {
              pixel[0] = pixel[1] = pixel[2] = 0;
            } else {
              pixel[0] = static_cast<std::uint8_t>(std::clamp(
                  std::lround(sample.c0 * 255.0 / alpha), 0L, 255L));
              pixel[1] = static_cast<std::uint8_t>(std::clamp(
                  std::lround(sample.c1 * 255.0 / alpha), 0L, 255L));
              pixel[2] = static_cast<std::uint8_t>(std::clamp(
                  std::lround(sample.c2 * 255.0 / alpha), 0L, 255L));
            }
          } else {
            pixel[0] = sample_gray(source, source_x, source_y, interpolation, outside);
          }
          covered[target_index] = 1;
        }
      }
    }
  }
  return target;
}

}  // namespace

bool warp_layer(Document& document, LayerId layer_id,
                const LayerWarpRequest& request, LayerWarpResult* result,
                std::string* error) {
  auto* current = document.find_layer(layer_id);
  if (current == nullptr) return fail(error, "warp target layer does not exist");
  const bool editable_text = layer_is_text(*current);
  const bool editable_smart_object = layer_is_smart_object(*current);
  if ((current->kind() != LayerKind::Pixel &&
       current->kind() != LayerKind::SmartObject && !editable_text) ||
      current->pixels().format() != PixelFormat::rgba8() ||
      current->pixels().empty() || current->bounds().empty()) {
    return fail(error, "only RGBA8 pixel, editable text and Smart Object layers can be warped");
  }
  if (!can_generate_style_warp_mesh(request.style) ||
      !std::isfinite(request.bend) ||
      !std::isfinite(request.horizontal_distortion) ||
      !std::isfinite(request.vertical_distortion) || request.bend < -100.0 ||
      request.bend > 100.0 || request.horizontal_distortion < -100.0 ||
      request.horizontal_distortion > 100.0 ||
      request.vertical_distortion < -100.0 ||
      request.vertical_distortion > 100.0) {
    return fail(error, "warp controls must be finite values in [-100, 100]");
  }
  if (current->lock_flags() != kLayerLockNone) {
    return fail(error, "a locked layer cannot be warped");
  }
  if (current->vector_mask() != nullptr) {
    return fail(error, "vector-mask warps are not supported");
  }
  if (current->mask().has_value() &&
      (!layer_mask_linked(*current) || current->mask()->bounds.x != current->bounds().x ||
       current->mask()->bounds.y != current->bounds().y ||
       current->mask()->bounds.width != current->bounds().width ||
       current->mask()->bounds.height != current->bounds().height ||
       current->mask()->pixels.format() != PixelFormat::gray8())) {
    return fail(error, "warp requires a linked raster mask with matching geometry");
  }
  if (editable_smart_object &&
      (!smart_object_placement_from_layer(*current).has_value() ||
       !smart_object_lock_reason(*current).empty() ||
       smart_object_warp_from_layer(*current).has_value() ||
       current->smart_filter_stack() != nullptr)) {
    return fail(error, "Smart Object warp metadata is unavailable or locked");
  }
  if (editable_text && text_warp_from_layer(*current).has_value()) {
    return fail(error, "an existing editable text warp must be rerendered before replacement");
  }

  const auto old_bounds = current->bounds();
  auto mesh = generate_style_warp_mesh(
      request.style, request.bend, request.rotate_vertical,
      static_cast<double>(old_bounds.width), static_cast<double>(old_bounds.height));
  if (!mesh.has_value()) return fail(error, "warp style could not be generated");
  apply_warp_distortion(*mesh, request.horizontal_distortion,
                        request.vertical_distortion);
  const auto [min_x, max_x] = std::minmax_element(mesh->xs.begin(), mesh->xs.end());
  const auto [min_y, max_y] = std::minmax_element(mesh->ys.begin(), mesh->ys.end());
  const std::array<double, 8> quad{
      old_bounds.x + *min_x, old_bounds.y + *min_y,
      old_bounds.x + *max_x, old_bounds.y + *min_y,
      old_bounds.x + *max_x, old_bounds.y + *max_y,
      old_bounds.x + *min_x, old_bounds.y + *max_y};
  const auto grid = build_warp_surface_grid(
      *mesh, quad, current->pixels().width(), current->pixels().height(), 4.0, 128);
  if (!grid.has_value()) return fail(error, "warp surface is degenerate");
  const auto target_bounds = grid_bounds(*grid);
  if (!target_bounds.has_value()) {
    return fail(error, "warp output exceeds the allocation budget");
  }
  const auto retained_bytes =
      static_cast<std::uint64_t>(target_bounds->width) * target_bounds->height *
      (current->mask().has_value() ? 5ULL : 4ULL);
  if (retained_bytes > kMaximumWarpBytes) {
    return fail(error, "warped layer exceeds the 512 MiB allocation budget");
  }

  auto transformed = *current;
  auto pixels = resample_grid(current->pixels(), *grid, *target_bounds,
                              request.interpolation, 0,
                              request.continue_operation);
  if (!pixels.has_value()) return fail(error, "layer warp was cancelled");
  transformed.set_pixels(std::move(*pixels));
  transformed.set_bounds(*target_bounds);
  if (current->mask().has_value()) {
    auto mask = *current->mask();
    auto mask_pixels = resample_grid(mask.pixels, *grid, *target_bounds,
                                     request.interpolation, mask.default_color,
                                     request.continue_operation);
    if (!mask_pixels.has_value()) return fail(error, "layer warp was cancelled");
    mask.pixels = std::move(*mask_pixels);
    mask.bounds = *target_bounds;
    transformed.set_mask(std::move(mask));
  }

  if (editable_smart_object) {
    SmartObjectWarp warp;
    warp.style = request.style;
    warp.value = request.bend;
    warp.perspective = request.horizontal_distortion;
    warp.perspective_other = request.vertical_distortion;
    warp.rotate = request.rotate_vertical ? "Vrtc" : "Hrzn";
    warp.bounds_bottom = old_bounds.height;
    warp.bounds_right = old_bounds.width;
    warp.u_order = mesh->u_order;
    warp.v_order = mesh->v_order;
    warp.mesh_xs = mesh->xs;
    warp.mesh_ys = mesh->ys;
    warp.mesh_generated = true;
    transformed.metadata()[kLayerMetadataSmartObjectWarp] =
        serialize_smart_object_warp(warp);
    auto placement = *smart_object_placement_from_layer(transformed);
    placement.transform = quad;
    store_smart_object_placement(transformed, placement);
    mark_layer_smart_object_block_dirty(transformed);
    transformed.metadata()[kLayerMetadataSmartObjectRasterStatus] =
        kSmartObjectRasterStatusPatchy;
  } else if (editable_text) {
    TextWarp warp;
    warp.style = request.style;
    warp.value = request.bend;
    warp.perspective = request.horizontal_distortion;
    warp.perspective_other = request.vertical_distortion;
    warp.rotate = request.rotate_vertical ? "Vrtc" : "Hrzn";
    warp.bounds_right = old_bounds.width;
    warp.bounds_bottom = old_bounds.height;
    transformed.metadata()[kLayerMetadataTextWarp] = serialize_text_warp(warp);
    transformed.metadata()[kLayerMetadataTextRasterStatus] = "patchy_raster";
  }

  *current = std::move(transformed);
  if (result != nullptr) {
    *result = LayerWarpResult{old_bounds, *target_bounds,
                              unite(old_bounds, *target_bounds)};
  }
  if (error != nullptr) error->clear();
  return true;
}

}  // namespace patchy
