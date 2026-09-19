#pragma once

#include "core/document.hpp"
#include "core/vector_compound.hpp"

#include <algorithm>
#include <cstdint>
#include <limits>

namespace patchy::psd {

// DP-008B deliberately accounts logical contiguous storage rather than STL
// nodes, capacity slack, strings, or allocator metadata. Saturation turns an
// unrepresentable envelope into a deterministic budget rejection.
struct SaveWorkspaceCensus {
  std::uint64_t normalization_owner_bytes{0U};
  std::uint64_t normalization_scratch_bytes{0U};
  std::uint64_t renderer_scratch_bytes{0U};
};

namespace save_workspace_detail {

inline void add_saturated(std::uint64_t& total, std::uint64_t amount) noexcept {
  if (amount > std::numeric_limits<std::uint64_t>::max() - total) {
    total = std::numeric_limits<std::uint64_t>::max();
  } else {
    total += amount;
  }
}

inline std::uint64_t multiply_saturated(std::uint64_t lhs,
                                        std::uint64_t rhs) noexcept {
  if (lhs != 0U && rhs > std::numeric_limits<std::uint64_t>::max() / lhs) {
    return std::numeric_limits<std::uint64_t>::max();
  }
  return lhs * rhs;
}

inline void add_source_pixels(const Layer& layer,
                              std::uint64_t& total) noexcept {
  add_saturated(total, static_cast<std::uint64_t>(layer.pixels().byte_size()));
  if (layer.mask().has_value()) {
    add_saturated(total,
                  static_cast<std::uint64_t>(layer.mask()->pixels.byte_size()));
  }
  if (const auto* filters = layer.smart_filter_stack()) {
    add_saturated(total,
                  static_cast<std::uint64_t>(filters->mask.pixels.byte_size()));
  }
  if (const auto* shape = layer.vector_shape()) {
    add_saturated(total,
                  static_cast<std::uint64_t>(shape->fill_cache.byte_size()));
    add_saturated(total,
                  static_cast<std::uint64_t>(shape->stroke_cache.byte_size()));
  }
  if (const auto* mask = layer.vector_mask()) {
    add_saturated(total,
                  static_cast<std::uint64_t>(mask->cache.byte_size()));
  }
  for (const auto& child : layer.children()) {
    add_source_pixels(child, total);
  }
}

inline std::uint64_t enabled_effect_count(const LayerStyle& style) noexcept {
  const auto enabled = [](const auto& effect) { return effect.enabled; };
  std::uint64_t count = 0U;
  const auto add = [&](const auto& effects) {
    add_saturated(count, static_cast<std::uint64_t>(
                             std::count_if(effects.begin(), effects.end(), enabled)));
  };
  add(style.drop_shadows);
  add(style.inner_shadows);
  add(style.outer_glows);
  add(style.inner_glows);
  add(style.strokes);
  add(style.bevels);
  add(style.satins);
  return count;
}

struct LayerCensus {
  std::uint64_t generated_vector_layers{0U};
  std::uint64_t renderer_bytes_per_canvas_pixel{0U};
  bool normalization_needed{false};
};

inline void inspect_layer(const Layer& layer, LayerCensus& census) noexcept {
  // Group targets retain RGB/alpha/clipping planes while a child is rendered;
  // snapshots and knockout silhouettes share this conservative 32-byte plane.
  if (layer.kind() == LayerKind::Group) {
    add_saturated(census.renderer_bytes_per_canvas_pixel, 32U);
  }
  if (layer.clipped()) {
    add_saturated(census.renderer_bytes_per_canvas_pixel, 16U);
  }
  if (layer.mask().has_value()) {
    add_saturated(census.renderer_bytes_per_canvas_pixel, 8U);
  }
  if (layer.vector_mask() != nullptr) {
    // Coverage, feather blur, and distance intermediates can coexist with the
    // retained mask cache.
    add_saturated(census.renderer_bytes_per_canvas_pixel, 96U);
  }
  if (layer.vector_shape() != nullptr) {
    // Coverage, raster, paint, and stroke-distance workspaces.
    add_saturated(census.renderer_bytes_per_canvas_pixel, 64U);
  }
  if (!layer.raw_psd_blending_ranges().empty() ||
      layer.kind() == LayerKind::Adjustment) {
    add_saturated(census.renderer_bytes_per_canvas_pixel, 16U);
  }
  // One enabled distance/blur/stroke/bevel effect gets a 192-byte-per-pixel
  // envelope. Effects are normally sequential; summing them intentionally
  // remains safe if a future renderer retains more than one prepared mask.
  add_saturated(
      census.renderer_bytes_per_canvas_pixel,
      multiply_saturated(enabled_effect_count(layer.layer_style()), 192U));

  if (layer_is_compound_vector(layer)) {
    census.normalization_needed = true;
    const auto* shape = layer.vector_shape();
    add_saturated(census.generated_vector_layers,
                  static_cast<std::uint64_t>(shape->parts.size()));
    for (const auto& part : shape->parts) {
      const auto expansion = open_path_stroke_expansion_plan(*shape, part);
      if (!expansion.expands) {
        continue;
      }
      add_saturated(census.generated_vector_layers, expansion.subpath_count);
      add_saturated(census.generated_vector_layers,
                    expansion.fill_carrier ? 1U : 0U);
    }
  } else {
    const auto expansion = open_path_stroke_expansion_plan(layer);
    if (expansion.expands) {
      census.normalization_needed = true;
      add_saturated(census.generated_vector_layers, expansion.subpath_count);
      add_saturated(census.generated_vector_layers,
                    expansion.fill_carrier ? 1U : 0U);
    }
  }
  if (compound_vector_group_kind(layer) != CompoundVectorGroupKind::None) {
    // prepare_compound_vector_psd may clone an already-normalized document to
    // add a missing native id or repair a duplicate one. Duplicate detection
    // is intentionally left to that function; charging every marked group is
    // allocation-free and conservative.
    census.normalization_needed = true;
  }
  for (const auto& child : layer.children()) {
    inspect_layer(child, census);
  }
}

}  // namespace save_workspace_detail

[[nodiscard]] inline SaveWorkspaceCensus save_workspace_census(
    const Document& document) noexcept {
  using namespace save_workspace_detail;
  LayerCensus layers;
  std::uint64_t source_bytes = 0U;
  for (const auto& layer : document.layers()) {
    inspect_layer(layer, layers);
    add_source_pixels(layer, source_bytes);
  }
  for (const auto& channel : document.channels()) {
    add_saturated(source_bytes,
                  static_cast<std::uint64_t>(channel.pixels().byte_size()));
  }
  const auto canvas_pixels = multiply_saturated(
      static_cast<std::uint64_t>(std::max(0, document.width())),
      static_cast<std::uint64_t>(std::max(0, document.height())));

  SaveWorkspaceCensus result;
  result.renderer_scratch_bytes = multiply_saturated(
      canvas_pixels, layers.renderer_bytes_per_canvas_pixel);
  if (!layers.normalization_needed) {
    return result;
  }

  // Up to two normalization clones (compound then open-stroke) plus the
  // missing-native-id repair can overlap the caller document. Each generated
  // vector paint can retain separate fill and stroke RGBA caches in more than
  // one overlapping clone, so reserve three eight-byte-per-pixel pairs.
  result.normalization_owner_bytes = multiply_saturated(source_bytes, 3U);
  add_saturated(result.normalization_owner_bytes,
                multiply_saturated(multiply_saturated(canvas_pixels, 24U),
                                   layers.generated_vector_layers));
  // Vector rasterization uses coverage/paint/stroke/distance intermediates.
  // They die before recursive serialization, so keep them in a separate
  // reservation and release it immediately after normalization.
  result.normalization_scratch_bytes = multiply_saturated(
      multiply_saturated(canvas_pixels, 96U),
      layers.generated_vector_layers);
  return result;
}

}  // namespace patchy::psd
