#pragma once

#include "core/adjustment_layer.hpp"
#include "core/document.hpp"
#include "core/vector_compound.hpp"
#include "core/vector_raster_workspace.hpp"
#include "render/layer_compositor_workspace.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

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

template <typename T>
inline std::uint64_t logical_vector_bytes(
    const std::vector<T>& values) noexcept {
  return multiply_saturated(static_cast<std::uint64_t>(values.size()),
                            static_cast<std::uint64_t>(sizeof(T)));
}

inline void add_gradient_storage(const LayerStyleGradient& gradient,
                                 std::uint64_t& total) noexcept {
  add_saturated(total, logical_vector_bytes(gradient.color_stops));
  add_saturated(total, logical_vector_bytes(gradient.alpha_stops));
}

inline void add_fill_storage(const VectorFill& fill,
                             std::uint64_t& total) noexcept {
  add_gradient_storage(fill.gradient, total);
}

inline void add_stroke_storage(const VectorStroke& stroke,
                               std::uint64_t& total) noexcept {
  add_saturated(total, logical_vector_bytes(stroke.dashes));
  add_fill_storage(stroke.content, total);
}

inline void add_path_storage(const VectorPath& path,
                             std::uint64_t& total) noexcept {
  add_saturated(total, logical_vector_bytes(path.subpaths));
  for (const auto& subpath : path.subpaths) {
    add_saturated(total, logical_vector_bytes(subpath.anchors));
  }
}

inline std::uint64_t vector_shape_storage(
    const VectorShapeContent& shape) noexcept {
  std::uint64_t total = 0U;
  add_path_storage(shape.path, total);
  add_fill_storage(shape.fill, total);
  add_stroke_storage(shape.stroke, total);
  add_saturated(total, logical_vector_bytes(shape.origination));
  for (const auto& origin : shape.origination) {
    add_saturated(total, logical_vector_bytes(origin.raw_descriptor));
  }
  add_saturated(total, logical_vector_bytes(shape.parts));
  for (const auto& part : shape.parts) {
    add_saturated(total, logical_vector_bytes(part.groups));
    add_fill_storage(part.fill, total);
    add_stroke_storage(part.stroke, total);
  }
  return total;
}

inline void add_contour_storage(const StyleContour& contour,
                                std::uint64_t& total) noexcept {
  add_saturated(total, logical_vector_bytes(contour.points));
}

inline void add_layer_style_storage(const LayerStyle& style,
                                    std::uint64_t& total) noexcept {
  add_saturated(total, logical_vector_bytes(style.drop_shadows));
  add_saturated(total, logical_vector_bytes(style.inner_shadows));
  add_saturated(total, logical_vector_bytes(style.outer_glows));
  add_saturated(total, logical_vector_bytes(style.inner_glows));
  add_saturated(total, logical_vector_bytes(style.color_overlays));
  add_saturated(total, logical_vector_bytes(style.gradient_fills));
  for (const auto& effect : style.gradient_fills) {
    add_gradient_storage(effect.gradient, total);
  }
  add_saturated(total, logical_vector_bytes(style.pattern_overlays));
  add_saturated(total, logical_vector_bytes(style.strokes));
  for (const auto& effect : style.strokes) {
    add_gradient_storage(effect.gradient, total);
  }
  add_saturated(total, logical_vector_bytes(style.bevels));
  for (const auto& effect : style.bevels) {
    add_contour_storage(effect.gloss_contour, total);
    add_contour_storage(effect.contour.contour, total);
  }
  add_saturated(total, logical_vector_bytes(style.satins));
}

inline void add_unknown_blocks_storage(
    const std::vector<UnknownPsdBlock>& blocks,
    std::uint64_t& total) noexcept {
  add_saturated(total, logical_vector_bytes(blocks));
  for (const auto& block : blocks) {
    add_saturated(total, logical_vector_bytes(block.payload));
  }
}

inline void add_layer_clone_storage(const Layer& layer,
                                    std::uint64_t& total) noexcept {
  add_saturated(total, logical_vector_bytes(layer.raw_psd_blending_ranges()));
  add_saturated(
      total,
      logical_vector_bytes(layer.raw_psd_group_boundary_blending_ranges()));
  add_unknown_blocks_storage(layer.unknown_psd_blocks(), total);
  add_layer_style_storage(layer.layer_style(), total);
  add_saturated(total, logical_vector_bytes(layer.children()));
  for (const auto& child : layer.children()) {
    add_layer_clone_storage(child, total);
  }
}

// Document copy keeps PixelBuffer/vector/filter models shared, but all value
// vectors below allocate new contiguous owners. Strings, maps, allocator
// capacity and shared backing stores remain the explicit DP-008B exclusions.
inline std::uint64_t document_clone_storage(
    const Document& document) noexcept {
  std::uint64_t total = 0U;
  add_saturated(total,
                logical_vector_bytes(document.color_state().embedded_icc_profile));
  add_unknown_blocks_storage(document.metadata().unknown_psd_resources, total);
  add_saturated(
      total,
      logical_vector_bytes(document.metadata().raw_psd_global_layer_mask_info));
  add_saturated(total,
                logical_vector_bytes(document.metadata().raw_psd_image_resources));

  add_saturated(total,
                logical_vector_bytes(document.metadata().smart_objects.blocks));
  for (const auto& block : document.metadata().smart_objects.blocks) {
    add_saturated(total, logical_vector_bytes(block.sources));
  }
  add_saturated(
      total, logical_vector_bytes(document.metadata().smart_filter_effects.blocks));
  for (const auto& block : document.metadata().smart_filter_effects.blocks) {
    add_saturated(total, logical_vector_bytes(block.records));
  }
  add_saturated(total, logical_vector_bytes(document.metadata().patterns.patterns));

  if (document.indexed_palette().has_value()) {
    add_saturated(total,
                  logical_vector_bytes(document.indexed_palette()->colors));
    add_saturated(total,
                  logical_vector_bytes(document.indexed_palette()->names));
  }
  if (document.palette_editing().has_value()) {
    add_saturated(total,
                  logical_vector_bytes(document.palette_editing()->palette.colors));
    add_saturated(total,
                  logical_vector_bytes(document.palette_editing()->palette.names));
  }
  add_saturated(total, logical_vector_bytes(document.guides()));
  add_saturated(total, logical_vector_bytes(document.layers()));
  for (const auto& layer : document.layers()) {
    add_layer_clone_storage(layer, total);
  }
  add_saturated(total, logical_vector_bytes(document.channels()));
  for (const auto& channel : document.channels()) {
    add_saturated(total,
                  logical_vector_bytes(channel.raw_photoshop_display_info()));
  }
  add_saturated(total, logical_vector_bytes(document.paths()));
  for (const auto& path : document.paths()) {
    add_path_storage(path.path(), total);
  }
  return total;
}

struct PathGeometryLimit {
  std::uint64_t subpaths{0U};
  std::uint64_t fill_edges{0U};
  std::uint64_t stroke_points{0U};
};

inline std::uint64_t segment_edge_limit(const PathAnchor& from,
                                        const PathAnchor& to) noexcept {
  const bool straight = from.out_x == from.anchor_x &&
                        from.out_y == from.anchor_y &&
                        to.in_x == to.anchor_x && to.in_y == to.anchor_y;
  return straight ? 1U : 256U;
}

inline PathGeometryLimit path_geometry_limit(const VectorPath& path) noexcept {
  PathGeometryLimit result;
  for (const auto& subpath : path.subpaths) {
    const auto count = subpath.anchors.size();
    if (count < 2U) {
      continue;
    }
    add_saturated(result.subpaths, 1U);
    std::uint64_t stroke_segments = 0U;
    const auto stroke_segment_count = subpath.closed ? count : count - 1U;
    for (std::size_t index = 0U; index < count; ++index) {
      const auto& from = subpath.anchors[index];
      const auto& to = subpath.anchors[(index + 1U) % count];
      const auto edge_limit =
          index + 1U == count && !subpath.closed
              ? 1U
              : segment_edge_limit(from, to);
      add_saturated(result.fill_edges, edge_limit);
      if (index < stroke_segment_count) {
        add_saturated(stroke_segments, edge_limit);
      }
    }
    add_saturated(result.stroke_points, stroke_segments);
    add_saturated(result.stroke_points, 1U);
  }
  return result;
}

inline std::uint64_t vector_path_geometry_scratch(
    const VectorPath& path, const VectorStroke* stroke) noexcept {
  const auto geometry = path_geometry_limit(path);
  // Edge owner plus bucket-next/min/max and active-index tables. Canvas-sized
  // heads/cells/coverage are already covered by the per-pixel envelope.
  std::uint64_t total = multiply_saturated(geometry.fill_edges, 32U);
  add_saturated(total, multiply_saturated(geometry.subpaths, 32U));
  // The rasterizer groups every consecutive shape_group run before it rejects
  // degenerate geometry. One-anchor subpaths therefore still own entries; the
  // number of source subpaths is a conservative allocation-free run bound.
  add_saturated(
      total,
      multiply_saturated(
          static_cast<std::uint64_t>(path.subpaths.size()),
          static_cast<std::uint64_t>(
              sizeof(vector_raster_detail::PathGroup))));
  if (stroke == nullptr || !stroke->enabled || !(stroke->width > 0.0) ||
      path.empty()) {
    return total;
  }

  constexpr std::uint64_t kMaxDashBoundaries = 262144U;
  const auto dash_boundaries = stroke->dashes.empty()
                                   ? 0U
                                   : multiply_saturated(geometry.subpaths,
                                                        kMaxDashBoundaries);
  std::uint64_t run_points = geometry.stroke_points;
  add_saturated(run_points, multiply_saturated(dash_boundaries, 2U));
  std::uint64_t runs = geometry.subpaths;
  add_saturated(runs, dash_boundaries);

  const std::uint64_t join_edges =
      stroke->join == VectorStrokeJoin::Round
          ? 192U
          : (stroke->join == VectorStrokeJoin::Miter ? 4U : 3U);
  const std::uint64_t cap_edges =
      stroke->cap == VectorStrokeCap::Round
          ? 768U
          : (stroke->cap == VectorStrokeCap::Square ? 8U : 0U);
  std::uint64_t outline_edges = multiply_saturated(
      run_points, 4U + join_edges);
  add_saturated(outline_edges, multiply_saturated(runs, cap_edges));

  add_saturated(total, multiply_saturated(outline_edges, 32U));
  // Polyline, dash walk/run points, direction vectors, run descriptors, two
  // dash copies, and one maximum-depth cubic's transient edge vector.
  add_saturated(total, multiply_saturated(run_points, 64U));
  add_saturated(total, multiply_saturated(runs, 32U));
  add_saturated(total,
                multiply_saturated(
                    static_cast<std::uint64_t>(stroke->dashes.size()), 16U));
  add_saturated(total, 256U * 16U);
  return total;
}

inline std::uint64_t vector_shape_geometry_scratch(
    const VectorShapeContent& shape) noexcept {
  std::uint64_t total = 0U;
  if (shape.parts.empty()) {
    return vector_path_geometry_scratch(shape.path, &shape.stroke);
  }
  for (const auto& part : shape.parts) {
    add_saturated(total,
                  vector_path_geometry_scratch(shape.path, &part.stroke));
  }
  // The multi-paint renderer builds one value-owned single-part content for
  // each recursive raster call. Its PixelBuffers stay in the per-pixel term;
  // account the copied path/appearance vectors here.
  add_saturated(
      total,
      multiply_saturated(vector_shape_storage(shape),
                         static_cast<std::uint64_t>(shape.parts.size())));
  return total;
}

inline std::uint64_t adjustment_model_scratch() noexcept {
  // adjustment_settings_from_layer may overlap the caller's default curves,
  // four parsed metadata vectors, and the returned rich Curves model while a
  // value copy is installed. The public model clamps every channel to nineteen
  // points. Three complete owner sets also dominate one LUT build's normalized
  // point copy plus its two double work vectors, without parsing metadata or
  // allocating during this census.
  constexpr std::uint64_t kCurveChannels = 4U;
  constexpr std::uint64_t kMaximumCurveControlPoints = 19U;
  constexpr std::uint64_t kOverlappingOwnerSets = 3U;
  return multiply_saturated(
      multiply_saturated(kOverlappingOwnerSets, kCurveChannels),
      multiply_saturated(
          kMaximumCurveControlPoints,
          static_cast<std::uint64_t>(sizeof(CurveControlPoint))));
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

inline std::uint64_t interior_overlay_owner_bytes(
    const LayerStyle& style) noexcept {
  std::uint64_t count = 0U;
  add_saturated(count,
                static_cast<std::uint64_t>(style.pattern_overlays.size()));
  add_saturated(count,
                static_cast<std::uint64_t>(style.gradient_fills.size()));
  add_saturated(count,
                static_cast<std::uint64_t>(style.color_overlays.size()));
  return multiply_saturated(
      count, static_cast<std::uint64_t>(
                 sizeof(render_detail::PreparedInteriorOverlay)));
}

struct LayerCensus {
  std::uint64_t generated_vector_layers{0U};
  std::uint64_t generated_vector_owner_bytes{0U};
  std::uint64_t normalization_geometry_bytes{0U};
  std::uint64_t renderer_bytes_per_canvas_pixel{0U};
  std::uint64_t renderer_geometry_bytes{0U};
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
    add_saturated(census.renderer_geometry_bytes,
                  vector_path_geometry_scratch(layer.vector_mask()->path,
                                               nullptr));
  }
  if (layer.vector_shape() != nullptr) {
    // Coverage, raster, paint, and stroke-distance workspaces.
    add_saturated(census.renderer_bytes_per_canvas_pixel, 64U);
    // Multi-paint shapes retain every part raster until the final composite.
    add_saturated(
        census.renderer_bytes_per_canvas_pixel,
        multiply_saturated(
            static_cast<std::uint64_t>(layer.vector_shape()->parts.size()),
            24U));
    add_saturated(census.renderer_geometry_bytes,
                  vector_shape_geometry_scratch(*layer.vector_shape()));
  }
  if (!layer.raw_psd_blending_ranges().empty() ||
      layer.kind() == LayerKind::Adjustment) {
    add_saturated(census.renderer_bytes_per_canvas_pixel, 16U);
  }
  if (layer.kind() == LayerKind::Adjustment) {
    add_saturated(census.renderer_geometry_bytes,
                  adjustment_model_scratch());
  }
  // One enabled distance/blur/stroke/bevel effect gets a 192-byte-per-pixel
  // envelope. Effects are normally sequential; summing them intentionally
  // remains safe if a future renderer retains more than one prepared mask.
  add_saturated(
      census.renderer_bytes_per_canvas_pixel,
      multiply_saturated(enabled_effect_count(layer.layer_style()), 192U));
  // prepare_interior_overlays reserves one platform-sized value slot for every
  // source overlay before filtering disabled/unresolved entries.
  add_saturated(census.renderer_geometry_bytes,
                interior_overlay_owner_bytes(layer.layer_style()));

  std::uint64_t generated_here = 0U;
  if (layer_is_compound_vector(layer)) {
    census.normalization_needed = true;
    const auto* shape = layer.vector_shape();
    add_saturated(generated_here,
                  static_cast<std::uint64_t>(shape->parts.size()));
    for (const auto& part : shape->parts) {
      const auto expansion = open_path_stroke_expansion_plan(*shape, part);
      if (!expansion.expands) {
        continue;
      }
      add_saturated(generated_here, expansion.subpath_count);
      add_saturated(generated_here,
                    expansion.fill_carrier ? 1U : 0U);
    }
  } else {
    const auto expansion = open_path_stroke_expansion_plan(layer);
    if (expansion.expands) {
      census.normalization_needed = true;
      add_saturated(generated_here, expansion.subpath_count);
      add_saturated(generated_here,
                    expansion.fill_carrier ? 1U : 0U);
    }
  }
  add_saturated(census.generated_vector_layers, generated_here);
  if (generated_here != 0U && layer.vector_shape() != nullptr) {
    add_saturated(
        census.generated_vector_owner_bytes,
        multiply_saturated(vector_shape_storage(*layer.vector_shape()),
                           generated_here));
    add_saturated(
        census.generated_vector_owner_bytes,
        multiply_saturated(
            static_cast<std::uint64_t>(sizeof(Layer)),
            generated_here > std::numeric_limits<std::uint64_t>::max() - 4U
                ? std::numeric_limits<std::uint64_t>::max()
                : generated_here + 4U));
    add_saturated(
        census.normalization_geometry_bytes,
        multiply_saturated(
            vector_shape_geometry_scratch(*layer.vector_shape()),
            generated_here));
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
  add_saturated(result.renderer_scratch_bytes,
                layers.renderer_geometry_bytes);
  if (document.layers().empty()) {
    // write_layered_rgb8_impl clones a layer-empty document and retains the
    // clone plus one synthetic 1x1 RGBA layer through the recursive write.
    result.normalization_owner_bytes = document_clone_storage(document);
    add_saturated(result.normalization_owner_bytes,
                  static_cast<std::uint64_t>(sizeof(Layer)));
    add_saturated(result.normalization_owner_bytes, 4U);
    return result;
  }
  if (!layers.normalization_needed) {
    return result;
  }

  // Up to two normalization clones (compound then open-stroke) plus the
  // missing-native-id repair can overlap the caller document. Each generated
  // vector paint can retain separate fill and stroke RGBA caches in more than
  // one overlapping clone, so reserve three eight-byte-per-pixel pairs.
  result.normalization_owner_bytes = multiply_saturated(source_bytes, 3U);
  add_saturated(result.normalization_owner_bytes,
                multiply_saturated(document_clone_storage(document), 3U));
  add_saturated(result.normalization_owner_bytes,
                multiply_saturated(multiply_saturated(canvas_pixels, 24U),
                                   layers.generated_vector_layers));
  add_saturated(result.normalization_owner_bytes,
                layers.generated_vector_owner_bytes);
  // Vector rasterization uses coverage/paint/stroke/distance intermediates.
  // They die before recursive serialization, so keep them in a separate
  // reservation and release it immediately after normalization.
  result.normalization_scratch_bytes = multiply_saturated(
      multiply_saturated(canvas_pixels, 96U),
      layers.generated_vector_layers);
  add_saturated(result.normalization_scratch_bytes,
                layers.normalization_geometry_bytes);
  return result;
}

}  // namespace patchy::psd
