#include "core/layer_transform.hpp"

#include "core/layer_metadata.hpp"
#include "core/smart_object.hpp"
#include "core/warp_mesh.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <set>
#include <string_view>
#include <utility>

namespace patchy {
namespace {

constexpr std::int32_t kMaximumTransformDimension = 32768;
constexpr std::uint64_t kMaximumTransformPixels = 268435456ULL;
constexpr std::uint64_t kMaximumTransformBytes = 512ULL * 1024ULL * 1024ULL;
constexpr double kGeometryEpsilon = 1.0e-7;

bool fail(std::string* error, std::string_view message) {
  if (error != nullptr) {
    *error = std::string(message);
  }
  return false;
}

double cross(double ax, double ay, double bx, double by, double cx, double cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

bool finite_convex_quad(const std::array<double, 8>& quad) {
  for (const auto coordinate : quad) {
    if (!std::isfinite(coordinate)) {
      return false;
    }
  }
  double sign = 0.0;
  for (std::size_t index = 0; index < 4; ++index) {
    const auto next = (index + 1U) % 4U;
    const auto after = (index + 2U) % 4U;
    const auto value = cross(quad[index * 2U], quad[index * 2U + 1U],
                             quad[next * 2U], quad[next * 2U + 1U],
                             quad[after * 2U], quad[after * 2U + 1U]);
    if (std::abs(value) <= kGeometryEpsilon) {
      return false;
    }
    if (sign == 0.0) {
      sign = value;
    } else if ((sign < 0.0) != (value < 0.0)) {
      return false;
    }
  }
  return true;
}

bool affine_quad(const std::array<double, 8>& quad) {
  return std::abs((quad[0] + quad[4]) - (quad[2] + quad[6])) <= kGeometryEpsilon &&
         std::abs((quad[1] + quad[5]) - (quad[3] + quad[7])) <= kGeometryEpsilon;
}

std::optional<Rect> bounds_for_points(const std::array<double, 8>& points) {
  const auto [min_x_it, max_x_it] =
      std::minmax({points[0], points[2], points[4], points[6]});
  const auto [min_y_it, max_y_it] =
      std::minmax({points[1], points[3], points[5], points[7]});
  // Homography round-trips can put an authored integral edge a few ulps on the
  // other side of that integer. Bias only at the geometry epsilon so identical
  // layer/mask rectangles keep byte-for-byte identical output bounds.
  const auto left = std::floor(min_x_it + kGeometryEpsilon);
  const auto top = std::floor(min_y_it + kGeometryEpsilon);
  const auto right = std::ceil(max_x_it - kGeometryEpsilon);
  const auto bottom = std::ceil(max_y_it - kGeometryEpsilon);
  if (left < static_cast<double>(std::numeric_limits<std::int32_t>::min()) ||
      top < static_cast<double>(std::numeric_limits<std::int32_t>::min()) ||
      right > static_cast<double>(std::numeric_limits<std::int32_t>::max()) ||
      bottom > static_cast<double>(std::numeric_limits<std::int32_t>::max())) {
    return std::nullopt;
  }
  const auto width = right - left;
  const auto height = bottom - top;
  if (width < 1.0 || height < 1.0 || width > kMaximumTransformDimension ||
      height > kMaximumTransformDimension ||
      width * height > static_cast<double>(kMaximumTransformPixels)) {
    return std::nullopt;
  }
  return Rect{static_cast<std::int32_t>(left), static_cast<std::int32_t>(top),
              static_cast<std::int32_t>(width), static_cast<std::int32_t>(height)};
}

std::array<double, 8> transformed_rect(const Rect& rect,
                                       const std::array<double, 9>& matrix) {
  const auto left = static_cast<double>(rect.x);
  const auto top = static_cast<double>(rect.y);
  const auto right = left + static_cast<double>(rect.width);
  const auto bottom = top + static_cast<double>(rect.height);
  const auto top_left = apply_homography(matrix, left, top);
  const auto top_right = apply_homography(matrix, right, top);
  const auto bottom_right = apply_homography(matrix, right, bottom);
  const auto bottom_left = apply_homography(matrix, left, bottom);
  return {top_left[0], top_left[1], top_right[0], top_right[1],
          bottom_right[0], bottom_right[1], bottom_left[0], bottom_left[1]};
}

void copy_sample(const PixelBuffer& source, double source_x, double source_y,
                 LayerTransformInterpolation interpolation, std::uint8_t outside,
                 std::uint8_t* target) {
  const auto channels = static_cast<std::size_t>(source.format().channels);
  const auto bytes = bytes_per_channel(source.format().bit_depth);
  const auto pixel_bytes = channels * bytes;
  if (interpolation == LayerTransformInterpolation::Nearest ||
      source.format().bit_depth != BitDepth::UInt8) {
    const auto x = static_cast<std::int32_t>(std::floor(source_x));
    const auto y = static_cast<std::int32_t>(std::floor(source_y));
    if (x < 0 || y < 0 || x >= source.width() || y >= source.height()) {
      std::fill_n(target, pixel_bytes, outside);
      return;
    }
    std::copy_n(source.pixel(x, y), pixel_bytes, target);
    return;
  }

  const auto center_x = source_x - 0.5;
  const auto center_y = source_y - 0.5;
  const auto x0 = static_cast<std::int32_t>(std::floor(center_x));
  const auto y0 = static_cast<std::int32_t>(std::floor(center_y));
  const auto fraction_x = center_x - static_cast<double>(x0);
  const auto fraction_y = center_y - static_cast<double>(y0);
  const auto sample = [&](std::int32_t x, std::int32_t y,
                          std::size_t channel) -> double {
    if (x < 0 || y < 0 || x >= source.width() || y >= source.height()) {
      return outside;
    }
    return source.pixel(x, y)[channel];
  };
  for (std::size_t channel = 0; channel < channels; ++channel) {
    const auto top = sample(x0, y0, channel) * (1.0 - fraction_x) +
                     sample(x0 + 1, y0, channel) * fraction_x;
    const auto bottom = sample(x0, y0 + 1, channel) * (1.0 - fraction_x) +
                        sample(x0 + 1, y0 + 1, channel) * fraction_x;
    target[channel] = static_cast<std::uint8_t>(
        std::clamp(std::lround(top * (1.0 - fraction_y) + bottom * fraction_y),
                   0L, 255L));
  }
}

std::optional<PixelBuffer> resample(
    const PixelBuffer& source, const Rect& source_bounds,
    const Rect& target_bounds, const std::array<double, 9>& inverse,
    LayerTransformInterpolation interpolation, std::uint8_t outside,
    const std::function<bool()>& continue_operation) {
  PixelBuffer target(target_bounds.width, target_bounds.height, source.format());
  for (std::int32_t y = 0; y < target.height(); ++y) {
    if (continue_operation && !continue_operation()) {
      return std::nullopt;
    }
    for (std::int32_t x = 0; x < target.width(); ++x) {
      const auto source_point = apply_homography(
          inverse, static_cast<double>(target_bounds.x + x) + 0.5,
          static_cast<double>(target_bounds.y + y) + 0.5);
      copy_sample(source, source_point[0] - static_cast<double>(source_bounds.x),
                  source_point[1] - static_cast<double>(source_bounds.y),
                  interpolation, outside, target.pixel(x, y));
    }
  }
  return target;
}

Rect unite(Rect first, Rect second) {
  if (first.empty()) {
    return second;
  }
  if (second.empty()) {
    return first;
  }
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

std::optional<Rect> bounded_unite(Rect first, Rect second) {
  if (first.empty()) return second;
  if (second.empty()) return first;
  const auto left = std::min<std::int64_t>(first.x, second.x);
  const auto top = std::min<std::int64_t>(first.y, second.y);
  const auto right = std::max<std::int64_t>(
      static_cast<std::int64_t>(first.x) + first.width,
      static_cast<std::int64_t>(second.x) + second.width);
  const auto bottom = std::max<std::int64_t>(
      static_cast<std::int64_t>(first.y) + first.height,
      static_cast<std::int64_t>(second.y) + second.height);
  const auto width = right - left;
  const auto height = bottom - top;
  if (left < std::numeric_limits<std::int32_t>::min() ||
      top < std::numeric_limits<std::int32_t>::min() ||
      right > std::numeric_limits<std::int32_t>::max() ||
      bottom > std::numeric_limits<std::int32_t>::max() || width < 1 ||
      height < 1 || width > std::numeric_limits<std::int32_t>::max() ||
      height > std::numeric_limits<std::int32_t>::max()) {
    return std::nullopt;
  }
  return Rect{static_cast<std::int32_t>(left), static_cast<std::int32_t>(top),
              static_cast<std::int32_t>(width),
              static_cast<std::int32_t>(height)};
}

bool collect_transform_leaves(const Layer& layer,
                              std::vector<std::pair<LayerId, Rect>>& leaves,
                              std::vector<LayerId>& groups,
                              std::set<LayerId>& unique,
                              std::string* error) {
  if (layer.kind() == LayerKind::Group) {
    if (layer.children().empty()) {
      return fail(error, "transform group has no editable leaves");
    }
    if (groups.size() >= 256U) {
      return fail(error, "multi-layer transform supports at most 256 groups");
    }
    if (layer.vector_mask() != nullptr) {
      return fail(error, "vector-mask transforms are not supported");
    }
    if (layer.mask().has_value() && !layer_mask_linked(layer)) {
      return fail(error, "an unlinked raster mask cannot share the layer transform");
    }
    groups.push_back(layer.id());
    for (const auto& child : layer.children()) {
      if (!collect_transform_leaves(child, leaves, groups, unique, error)) {
        return false;
      }
    }
    return true;
  }
  if (leaves.size() >= 256U) {
    return fail(error, "multi-layer transform supports at most 256 editable leaves");
  }
  if (!unique.insert(layer.id()).second) {
    return fail(error,
                "multi-layer transform roots cannot overlap or contain duplicate leaves");
  }
  leaves.emplace_back(layer.id(), layer.bounds());
  return true;
}

bool validate_transform_leaf(const Layer& layer,
                             const std::array<double, 8>& quad,
                             std::string* error) {
  const bool editable_text = layer_is_text(layer);
  const bool editable_smart_object = layer_is_smart_object(layer);
  if (layer.kind() != LayerKind::Pixel && !editable_text &&
      !editable_smart_object) {
    return fail(error,
                "only pixel, editable text and Smart Object layers can be transformed");
  }
  if (layer.bounds().empty() || layer.pixels().empty()) {
    return fail(error, "transform target has no raster bounds");
  }
  if (layer.vector_mask() != nullptr) {
    return fail(error, "vector-mask transforms are not supported");
  }
  if (layer.mask().has_value() && !layer_mask_linked(layer)) {
    return fail(error, "an unlinked raster mask cannot share the layer transform");
  }
  if (editable_text && !affine_quad(quad)) {
    return fail(error, "editable text supports affine transforms only");
  }
  if (editable_smart_object &&
      (!smart_object_placement_from_layer(layer).has_value() ||
       !smart_object_lock_reason(layer).empty())) {
    return fail(error, "Smart Object transform metadata is unavailable or locked");
  }
  return true;
}

std::optional<Rect> bounded_union(const std::vector<std::pair<LayerId, Rect>>& leaves) {
  if (leaves.empty()) return std::nullopt;
  std::int64_t left = std::numeric_limits<std::int64_t>::max();
  std::int64_t top = std::numeric_limits<std::int64_t>::max();
  std::int64_t right = std::numeric_limits<std::int64_t>::min();
  std::int64_t bottom = std::numeric_limits<std::int64_t>::min();
  for (const auto& [id, bounds] : leaves) {
    (void)id;
    if (bounds.empty()) return std::nullopt;
    left = std::min(left, static_cast<std::int64_t>(bounds.x));
    top = std::min(top, static_cast<std::int64_t>(bounds.y));
    right = std::max(right, static_cast<std::int64_t>(bounds.x) + bounds.width);
    bottom = std::max(bottom, static_cast<std::int64_t>(bounds.y) + bounds.height);
  }
  const auto width = right - left;
  const auto height = bottom - top;
  if (left < std::numeric_limits<std::int32_t>::min() ||
      top < std::numeric_limits<std::int32_t>::min() ||
      right > std::numeric_limits<std::int32_t>::max() ||
      bottom > std::numeric_limits<std::int32_t>::max() ||
      left > std::numeric_limits<std::int32_t>::max() ||
      top > std::numeric_limits<std::int32_t>::max() || width < 1 || height < 1 ||
      width > std::numeric_limits<std::int32_t>::max() ||
      height > std::numeric_limits<std::int32_t>::max()) {
    return std::nullopt;
  }
  return Rect{static_cast<std::int32_t>(left), static_cast<std::int32_t>(top),
              static_cast<std::int32_t>(width), static_cast<std::int32_t>(height)};
}

struct ArrangeRoot {
  LayerId id{0};
  Rect bounds{};
  std::int64_t dx{0};
  std::int64_t dy{0};
};

std::int64_t divide_nearest(std::int64_t numerator,
                            std::int64_t denominator) {
  const auto magnitude = numerator < 0 ? -numerator : numerator;
  const auto rounded = (magnitude + denominator / 2) / denominator;
  return numerator < 0 ? -rounded : rounded;
}

bool checked_translated_rect(Rect source, std::int64_t dx, std::int64_t dy,
                             Rect* translated) {
  if (source.empty()) {
    if (translated != nullptr) *translated = source;
    return true;
  }
  const auto left = static_cast<std::int64_t>(source.x);
  const auto top = static_cast<std::int64_t>(source.y);
  const auto right = left + source.width;
  const auto bottom = top + source.height;
  const auto moved_left = left + dx;
  const auto moved_top = top + dy;
  const auto moved_right = right + dx;
  const auto moved_bottom = bottom + dy;
  if (left < std::numeric_limits<std::int32_t>::min() ||
      top < std::numeric_limits<std::int32_t>::min() ||
      right > std::numeric_limits<std::int32_t>::max() ||
      bottom > std::numeric_limits<std::int32_t>::max() ||
      moved_left < std::numeric_limits<std::int32_t>::min() ||
      moved_top < std::numeric_limits<std::int32_t>::min() ||
      moved_right > std::numeric_limits<std::int32_t>::max() ||
      moved_bottom > std::numeric_limits<std::int32_t>::max()) {
    return false;
  }
  if (translated != nullptr) {
    *translated = Rect{static_cast<std::int32_t>(moved_left),
                       static_cast<std::int32_t>(moved_top), source.width,
                       source.height};
  }
  return true;
}

bool validate_arrange_leaf(const Layer& layer, std::string* error) {
  const bool editable_text = layer_is_text(layer);
  const bool editable_smart_object = layer_is_smart_object(layer);
  if (layer.kind() != LayerKind::Pixel && !editable_text &&
      !editable_smart_object) {
    return fail(error,
                "only pixel, editable text and Smart Object layers can be arranged");
  }
  if (layer.bounds().empty() || layer.pixels().empty()) {
    return fail(error, "arrange target has no raster bounds");
  }
  if (layer.vector_mask() != nullptr) {
    return fail(error, "vector-mask arrangement is not supported");
  }
  if (layer.mask().has_value() && !layer_mask_linked(layer)) {
    return fail(error,
                "an unlinked raster mask cannot share the layer arrangement");
  }
  if (editable_text) {
    const auto found = layer.metadata().find(kLayerMetadataTextTransform);
    if (found != layer.metadata().end() &&
        !parse_layer_affine_transform(found->second).has_value()) {
      return fail(error, "editable text transform metadata is malformed");
    }
  }
  if (editable_smart_object &&
      (!smart_object_placement_from_layer(layer).has_value() ||
       !smart_object_lock_reason(layer).empty())) {
    return fail(error,
                "Smart Object transform metadata is unavailable or locked");
  }
  return true;
}

bool validate_arrange_translation(const Layer& layer, std::int64_t dx,
                                  std::int64_t dy, Rect& affected,
                                  std::string* error) {
  Rect moved{};
  if (!checked_translated_rect(layer.bounds(), dx, dy, &moved)) {
    return fail(error, "layer arrangement exceeds int32 bounds");
  }
  for (const auto bounds : {layer.bounds(), moved}) {
    if (bounds.empty()) continue;
    const auto combined = bounded_unite(affected, bounds);
    if (!combined.has_value()) {
      return fail(error, "layer arrangement affected region exceeds int32 bounds");
    }
    affected = *combined;
  }
  if (layer.mask().has_value()) {
    Rect moved_mask{};
    if (!checked_translated_rect(layer.mask()->bounds, dx, dy, &moved_mask)) {
      return fail(error, "layer arrangement mask exceeds int32 bounds");
    }
    for (const auto bounds : {layer.mask()->bounds, moved_mask}) {
      if (bounds.empty()) continue;
      const auto combined = bounded_unite(affected, bounds);
      if (!combined.has_value()) {
        return fail(error,
                    "layer arrangement affected region exceeds int32 bounds");
      }
      affected = *combined;
    }
  }
  for (const auto& child : layer.children()) {
    if (!validate_arrange_translation(child, dx, dy, affected, error)) {
      return false;
    }
  }
  return true;
}

void translate_arrange_tree(Layer& layer, std::int32_t dx, std::int32_t dy,
                            std::int32_t document_width,
                            std::int32_t document_height) {
  for (auto& child : layer.children()) {
    translate_arrange_tree(child, dx, dy, document_width, document_height);
  }
  translate_moved_layer_metadata(layer, dx, dy, document_width,
                                 document_height);
  if (!layer.bounds().empty()) {
    const auto bounds = layer.bounds();
    layer.set_bounds(Rect{bounds.x + dx, bounds.y + dy, bounds.width,
                          bounds.height});
  }
}

}  // namespace

bool transform_layer(Document& document, LayerId layer_id,
                     const LayerTransformRequest& request,
                     LayerTransformResult* result, std::string* error) {
  auto* current = document.find_layer(layer_id);
  if (current == nullptr) {
    return fail(error, "transform target layer does not exist");
  }
  const bool editable_text = layer_is_text(*current);
  const bool editable_smart_object = layer_is_smart_object(*current);
  if (current->kind() != LayerKind::Pixel && !editable_text &&
      !editable_smart_object) {
    return fail(error, "only pixel, editable text and Smart Object layers can be transformed");
  }
  if (current->bounds().empty() || current->pixels().empty()) {
    return fail(error, "transform target has no raster bounds");
  }
  if (current->vector_mask() != nullptr) {
    return fail(error, "vector-mask transforms are not supported");
  }
  if (current->mask().has_value() && !layer_mask_linked(*current)) {
    return fail(error, "an unlinked raster mask cannot share the layer transform");
  }
  if (!finite_convex_quad(request.quad)) {
    return fail(error, "transform quad must be finite, convex and non-degenerate");
  }
  if (editable_text && !affine_quad(request.quad)) {
    return fail(error, "editable text supports affine transforms only");
  }
  if (editable_smart_object &&
      (!smart_object_placement_from_layer(*current).has_value() ||
       !smart_object_lock_reason(*current).empty())) {
    return fail(error, "Smart Object transform metadata is unavailable or locked");
  }

  const auto bounds = current->bounds();
  const auto matrix = homography_from_rect_to_quad(
      static_cast<double>(bounds.x), static_cast<double>(bounds.y),
      static_cast<double>(bounds.x + bounds.width),
      static_cast<double>(bounds.y + bounds.height), request.quad);
  if (!matrix.has_value()) {
    return fail(error, "transform quad does not define an invertible mapping");
  }
  const auto inverse = invert_homography(*matrix);
  const auto target_bounds = bounds_for_points(request.quad);
  if (!inverse.has_value() || !target_bounds.has_value()) {
    return fail(error, "transform output is singular or exceeds the allocation budget");
  }

  const auto pixel_count = static_cast<std::uint64_t>(target_bounds->width) *
                           static_cast<std::uint64_t>(target_bounds->height);
  auto retained_bytes = pixel_count * bytes_per_pixel(current->pixels().format());
  std::optional<Rect> transformed_mask_bounds;
  if (current->mask().has_value()) {
    const auto mask_quad = transformed_rect(current->mask()->bounds, *matrix);
    transformed_mask_bounds = bounds_for_points(mask_quad);
    if (!transformed_mask_bounds.has_value()) {
      return fail(error, "transformed mask exceeds the allocation budget");
    }
    retained_bytes +=
        static_cast<std::uint64_t>(transformed_mask_bounds->width) *
        static_cast<std::uint64_t>(transformed_mask_bounds->height);
  }
  if (retained_bytes > kMaximumTransformBytes) {
    return fail(error, "transformed layer exceeds the 512 MiB allocation budget");
  }

  auto transformed = *current;
  auto transformed_pixels = resample(
      current->pixels(), bounds, *target_bounds, *inverse,
      request.interpolation, 0, request.continue_operation);
  if (!transformed_pixels.has_value()) {
    return fail(error, "layer transform was cancelled");
  }
  transformed.set_pixels(std::move(*transformed_pixels));
  transformed.set_bounds(*target_bounds);

  if (current->mask().has_value()) {
    const auto& source_mask = *current->mask();
    auto mask = source_mask;
    auto transformed_mask = resample(
        source_mask.pixels, source_mask.bounds, *transformed_mask_bounds,
        *inverse, request.interpolation, source_mask.default_color,
        request.continue_operation);
    if (!transformed_mask.has_value()) {
      return fail(error, "layer transform was cancelled");
    }
    mask.pixels = std::move(*transformed_mask);
    mask.bounds = *transformed_mask_bounds;
    transformed.set_mask(std::move(mask));
  }

  if (editable_text) {
    // LayerAffineTransform follows QTransform order (a, b, c, d, tx, ty):
    // x' = ax + cy + tx, y' = bx + dy + ty.
    const LayerAffineTransform outer{(*matrix)[0], (*matrix)[3], (*matrix)[1],
                                     (*matrix)[4], (*matrix)[2], (*matrix)[5]};
    auto stored = LayerAffineTransform{1.0, 0.0, 0.0, 1.0, 0.0, 0.0};
    const auto found = current->metadata().find(kLayerMetadataTextTransform);
    if (found != current->metadata().end()) {
      const auto parsed = parse_layer_affine_transform(found->second);
      if (!parsed.has_value()) {
        return fail(error, "editable text transform metadata is malformed");
      }
      stored = *parsed;
    }
    transformed.metadata()[kLayerMetadataTextTransform] =
        serialize_layer_affine_transform(
            compose_layer_affine_transform(outer, stored));
  } else if (editable_smart_object) {
    auto placement = *smart_object_placement_from_layer(*current);
    const auto map_quad = [&matrix](std::array<double, 8>& quad) {
      for (std::size_t index = 0; index < quad.size(); index += 2U) {
        const auto mapped = apply_homography(*matrix, quad[index], quad[index + 1U]);
        quad[index] = mapped[0];
        quad[index + 1U] = mapped[1];
      }
    };
    map_quad(placement.transform);
    if (placement.non_affine_transform.has_value()) {
      map_quad(*placement.non_affine_transform);
    }
    store_smart_object_placement(transformed, placement);
    mark_layer_smart_object_block_dirty(transformed);
    transformed.metadata()[kLayerMetadataSmartObjectRasterStatus] =
        kSmartObjectRasterStatusPatchy;
  }

  const auto affected = unite(bounds, *target_bounds);
  *current = std::move(transformed);
  if (result != nullptr) {
    *result = LayerTransformResult{bounds, *target_bounds, affected};
  }
  if (error != nullptr) {
    error->clear();
  }
  return true;
}

bool transform_layers(Document& document,
                      const LayerBatchTransformRequest& request,
                      LayerTransformResult* result, std::string* error) {
  if (request.layer_ids.empty() || request.layer_ids.size() > 256U) {
    return fail(error, "multi-layer transform requires 1 through 256 roots");
  }
  if (!finite_convex_quad(request.quad)) {
    return fail(error, "transform quad must be finite, convex and non-degenerate");
  }
  std::vector<std::pair<LayerId, Rect>> leaves;
  leaves.reserve(request.layer_ids.size());
  std::vector<LayerId> groups;
  std::set<LayerId> unique_leaves;
  for (const auto id : request.layer_ids) {
    const auto* root = std::as_const(document).find_layer(id);
    if (root == nullptr) return fail(error, "transform root layer does not exist");
    if (!collect_transform_leaves(*root, leaves, groups, unique_leaves, error)) {
      return false;
    }
  }
  const auto collective = bounded_union(leaves);
  if (!collective.has_value()) {
    return fail(error, "multi-layer transform requires finite non-empty union bounds");
  }
  const auto matrix = homography_from_rect_to_quad(
      static_cast<double>(collective->x), static_cast<double>(collective->y),
      static_cast<double>(collective->x + collective->width),
      static_cast<double>(collective->y + collective->height), request.quad);
  const auto transformed_collective = bounds_for_points(request.quad);
  const auto inverse = matrix.has_value() ? invert_homography(*matrix)
                                          : std::nullopt;
  if (!matrix.has_value() || !inverse.has_value() ||
      !transformed_collective.has_value()) {
    return fail(error, "multi-layer transform output is singular or exceeds the allocation budget");
  }

  std::uint64_t aggregate_bytes = 0;
  Rect affected{};
  const auto include_affected = [&affected](Rect bounds) {
    const auto combined = bounded_unite(affected, bounds);
    if (!combined.has_value()) return false;
    affected = *combined;
    return true;
  };
  std::vector<std::array<double, 8>> leaf_quads;
  leaf_quads.reserve(leaves.size());
  for (const auto& [id, bounds] : leaves) {
    const auto* layer = std::as_const(document).find_layer(id);
    if (layer == nullptr) return fail(error, "transform leaf layer does not exist");
    const auto quad = transformed_rect(bounds, *matrix);
    const auto target_bounds = bounds_for_points(quad);
    if (!target_bounds.has_value()) {
      return fail(error, "multi-layer transform leaf exceeds the allocation budget");
    }
    if (!include_affected(bounds) || !include_affected(*target_bounds)) {
      return fail(error, "multi-layer transform affected region exceeds int32 bounds");
    }
    if (!validate_transform_leaf(*layer, quad, error)) return false;
    const auto pixels = static_cast<std::uint64_t>(target_bounds->width) *
                        static_cast<std::uint64_t>(target_bounds->height);
    const auto pixel_bytes = pixels * bytes_per_pixel(layer->pixels().format());
    if (pixel_bytes > kMaximumTransformBytes - aggregate_bytes) {
      return fail(error, "multi-layer transform exceeds the 512 MiB aggregate output budget");
    }
    aggregate_bytes += pixel_bytes;
    if (layer->mask().has_value()) {
      const auto mask_bounds = bounds_for_points(
          transformed_rect(layer->mask()->bounds, *matrix));
      if (!mask_bounds.has_value()) {
        return fail(error, "multi-layer transformed mask exceeds the allocation budget");
      }
      if (!include_affected(layer->mask()->bounds) ||
          !include_affected(*mask_bounds)) {
        return fail(error, "multi-layer transform affected region exceeds int32 bounds");
      }
      const auto mask_bytes = static_cast<std::uint64_t>(mask_bounds->width) *
                              static_cast<std::uint64_t>(mask_bounds->height);
      if (mask_bytes > kMaximumTransformBytes - aggregate_bytes) {
        return fail(error, "multi-layer transform exceeds the 512 MiB aggregate output budget");
      }
      aggregate_bytes += mask_bytes;
    }
    leaf_quads.push_back(quad);
  }
  for (const auto id : groups) {
    const auto* group = std::as_const(document).find_layer(id);
    if (group == nullptr) return fail(error, "transform group layer does not exist");
    if (!group->bounds().empty() && !include_affected(group->bounds())) {
      return fail(error, "multi-layer transform affected region exceeds int32 bounds");
    }
    if (!group->mask().has_value()) continue;
    const auto mask_bounds = bounds_for_points(
        transformed_rect(group->mask()->bounds, *matrix));
    if (!mask_bounds.has_value()) {
      return fail(error, "multi-layer transformed group mask exceeds the allocation budget");
    }
    if (!include_affected(group->mask()->bounds) ||
        !include_affected(*mask_bounds)) {
      return fail(error, "multi-layer transform affected region exceeds int32 bounds");
    }
    const auto mask_bytes = static_cast<std::uint64_t>(mask_bounds->width) *
                            static_cast<std::uint64_t>(mask_bounds->height);
    if (mask_bytes > kMaximumTransformBytes - aggregate_bytes) {
      return fail(error, "multi-layer transform exceeds the 512 MiB aggregate output budget");
    }
    aggregate_bytes += mask_bytes;
  }

  for (std::size_t index = 0; index < leaves.size(); ++index) {
    LayerTransformRequest leaf_request;
    leaf_request.quad = leaf_quads[index];
    leaf_request.interpolation = request.interpolation;
    leaf_request.continue_operation = request.continue_operation;
    if (!transform_layer(document, leaves[index].first, leaf_request,
                         nullptr, error)) {
      return false;
    }
  }
  // Children are transformed first. Refresh nested group geometry and masks
  // bottom-up so every parent observes the final child bounds.
  for (auto iterator = groups.rbegin(); iterator != groups.rend(); ++iterator) {
    auto* group = document.find_layer(*iterator);
    if (group == nullptr) return fail(error, "transform group layer does not exist");
    std::vector<std::pair<LayerId, Rect>> child_bounds;
    child_bounds.reserve(group->children().size());
    for (const auto& child : group->children()) {
      child_bounds.emplace_back(child.id(), child.bounds());
    }
    const auto transformed_group_bounds = bounded_union(child_bounds);
    if (!transformed_group_bounds.has_value()) {
      return fail(error, "transformed group has invalid child bounds");
    }
    group->set_bounds(*transformed_group_bounds);
    if (group->mask().has_value()) {
      const auto source_mask = *group->mask();
      const auto transformed_mask_bounds = bounds_for_points(
          transformed_rect(source_mask.bounds, *matrix));
      if (!transformed_mask_bounds.has_value()) {
        return fail(error, "multi-layer transformed group mask exceeds the allocation budget");
      }
      auto transformed_mask = resample(
          source_mask.pixels, source_mask.bounds, *transformed_mask_bounds,
          *inverse, request.interpolation, source_mask.default_color,
          request.continue_operation);
      if (!transformed_mask.has_value()) {
        return fail(error, "layer transform was cancelled");
      }
      auto mask = source_mask;
      mask.bounds = *transformed_mask_bounds;
      mask.pixels = std::move(*transformed_mask);
      group->set_mask(std::move(mask));
    }
  }
  if (result != nullptr) {
    *result = LayerTransformResult{*collective, *transformed_collective, affected};
  }
  if (error != nullptr) error->clear();
  return true;
}

bool arrange_layers(Document& document, const LayerArrangeRequest& request,
                    LayerTransformResult* result, std::string* error) {
  if (static_cast<std::uint8_t>(request.mode) >
          static_cast<std::uint8_t>(LayerArrangeMode::DistributeVerticalGaps) ||
      static_cast<std::uint8_t>(request.reference) >
          static_cast<std::uint8_t>(LayerArrangeReference::Canvas)) {
    return fail(error, "layer arrangement mode or reference is invalid");
  }
  const bool distribution =
      request.mode == LayerArrangeMode::DistributeHorizontalGaps ||
      request.mode == LayerArrangeMode::DistributeVerticalGaps;
  const auto minimum_roots = distribution ? 3U : 2U;
  if (request.layer_ids.size() < minimum_roots ||
      request.layer_ids.size() > 256U) {
    return fail(error, distribution
                           ? "layer distribution requires 3 through 256 roots"
                           : "layer alignment requires 2 through 256 roots");
  }
  if (distribution && request.reference != LayerArrangeReference::Selection) {
    return fail(error, "layer distribution uses selection geometry only");
  }

  std::vector<ArrangeRoot> roots;
  roots.reserve(request.layer_ids.size());
  std::set<LayerId> unique_leaves;
  std::set<LayerId> unique_roots;
  std::size_t total_leaves = 0;
  std::size_t total_groups = 0;
  for (const auto id : request.layer_ids) {
    if (!unique_roots.insert(id).second) {
      return fail(error, "layer arrangement roots must be unique");
    }
    const auto* root = std::as_const(document).find_layer(id);
    if (root == nullptr) return fail(error, "arrange root layer does not exist");
    std::vector<std::pair<LayerId, Rect>> leaves;
    std::vector<LayerId> groups;
    if (!collect_transform_leaves(*root, leaves, groups, unique_leaves, error)) {
      return false;
    }
    total_leaves += leaves.size();
    total_groups += groups.size();
    if (total_leaves > 256U || total_groups > 256U) {
      return fail(error,
                  "layer arrangement supports at most 256 leaves and 256 groups");
    }
    for (const auto& [leaf_id, bounds] : leaves) {
      (void)bounds;
      const auto* leaf = std::as_const(document).find_layer(leaf_id);
      if (leaf == nullptr || !validate_arrange_leaf(*leaf, error)) return false;
    }
    const auto bounds = bounded_union(leaves);
    if (!bounds.has_value()) {
      return fail(error, "layer arrangement requires finite non-empty root bounds");
    }
    roots.push_back(ArrangeRoot{id, *bounds});
  }

  std::vector<std::pair<LayerId, Rect>> root_bounds;
  root_bounds.reserve(roots.size());
  for (const auto& root : roots) root_bounds.emplace_back(root.id, root.bounds);
  const auto selection_bounds = bounded_union(root_bounds);
  if (!selection_bounds.has_value()) {
    return fail(error, "layer arrangement requires finite selection bounds");
  }
  const Rect reference = request.reference == LayerArrangeReference::Canvas
                             ? Rect::from_size(document.width(), document.height())
                             : *selection_bounds;
  if (reference.empty()) return fail(error, "layer arrangement reference is empty");

  const auto align_axis = [&](ArrangeRoot& root, bool horizontal,
                              int edge) {
    const auto root_start = static_cast<std::int64_t>(
        horizontal ? root.bounds.x : root.bounds.y);
    const auto root_extent = static_cast<std::int64_t>(
        horizontal ? root.bounds.width : root.bounds.height);
    const auto reference_start = static_cast<std::int64_t>(
        horizontal ? reference.x : reference.y);
    const auto reference_extent = static_cast<std::int64_t>(
        horizontal ? reference.width : reference.height);
    std::int64_t delta = 0;
    if (edge < 0) {
      delta = reference_start - root_start;
    } else if (edge > 0) {
      delta = (reference_start + reference_extent) -
              (root_start + root_extent);
    } else {
      delta = divide_nearest(
          (reference_start * 2 + reference_extent) -
              (root_start * 2 + root_extent),
          2);
    }
    if (horizontal) root.dx = delta;
    else root.dy = delta;
  };

  switch (request.mode) {
    case LayerArrangeMode::AlignLeft:
      for (auto& root : roots) align_axis(root, true, -1);
      break;
    case LayerArrangeMode::AlignHorizontalCenter:
      for (auto& root : roots) align_axis(root, true, 0);
      break;
    case LayerArrangeMode::AlignRight:
      for (auto& root : roots) align_axis(root, true, 1);
      break;
    case LayerArrangeMode::AlignTop:
      for (auto& root : roots) align_axis(root, false, -1);
      break;
    case LayerArrangeMode::AlignVerticalCenter:
      for (auto& root : roots) align_axis(root, false, 0);
      break;
    case LayerArrangeMode::AlignBottom:
      for (auto& root : roots) align_axis(root, false, 1);
      break;
    case LayerArrangeMode::DistributeHorizontalGaps:
    case LayerArrangeMode::DistributeVerticalGaps: {
      const bool horizontal =
          request.mode == LayerArrangeMode::DistributeHorizontalGaps;
      std::vector<std::size_t> order(roots.size());
      for (std::size_t index = 0; index < order.size(); ++index) order[index] = index;
      std::stable_sort(order.begin(), order.end(), [&](std::size_t first,
                                                       std::size_t second) {
        return (horizontal ? roots[first].bounds.x : roots[first].bounds.y) <
               (horizontal ? roots[second].bounds.x : roots[second].bounds.y);
      });
      const auto axis_start = [&](const ArrangeRoot& root) -> std::int64_t {
        return horizontal ? root.bounds.x : root.bounds.y;
      };
      const auto axis_extent = [&](const ArrangeRoot& root) -> std::int64_t {
        return horizontal ? root.bounds.width : root.bounds.height;
      };
      const auto first_start = axis_start(roots[order.front()]);
      const auto last_end = axis_start(roots[order.back()]) +
                            axis_extent(roots[order.back()]);
      std::int64_t total_extent = 0;
      for (const auto index : order) total_extent += axis_extent(roots[index]);
      const auto total_gap = last_end - first_start - total_extent;
      std::int64_t preceding_extent = 0;
      for (std::size_t position = 0; position < order.size(); ++position) {
        auto& root = roots[order[position]];
        const auto target = first_start + preceding_extent +
                            divide_nearest(total_gap *
                                               static_cast<std::int64_t>(position),
                                           static_cast<std::int64_t>(order.size() - 1U));
        const auto delta = target - axis_start(root);
        if (horizontal) root.dx = delta;
        else root.dy = delta;
        preceding_extent += axis_extent(root);
      }
      break;
    }
  }

  Rect affected{};
  std::vector<std::pair<LayerId, Rect>> translated_root_bounds;
  translated_root_bounds.reserve(roots.size());
  for (const auto& root : roots) {
    const auto* layer = std::as_const(document).find_layer(root.id);
    if (layer == nullptr ||
        !validate_arrange_translation(*layer, root.dx, root.dy, affected, error)) {
      return false;
    }
    Rect moved{};
    if (!checked_translated_rect(root.bounds, root.dx, root.dy, &moved) ||
        root.dx < std::numeric_limits<std::int32_t>::min() ||
        root.dx > std::numeric_limits<std::int32_t>::max() ||
        root.dy < std::numeric_limits<std::int32_t>::min() ||
        root.dy > std::numeric_limits<std::int32_t>::max()) {
      return fail(error, "layer arrangement translation exceeds int32 bounds");
    }
    translated_root_bounds.emplace_back(root.id, moved);
  }

  for (const auto& root : roots) {
    auto* layer = document.find_layer(root.id);
    translate_arrange_tree(*layer, static_cast<std::int32_t>(root.dx),
                           static_cast<std::int32_t>(root.dy), document.width(),
                           document.height());
  }
  const auto transformed_bounds = bounded_union(translated_root_bounds);
  if (result != nullptr) {
    *result = LayerTransformResult{*selection_bounds, *transformed_bounds,
                                   affected};
  }
  if (error != nullptr) error->clear();
  return true;
}

}  // namespace patchy
