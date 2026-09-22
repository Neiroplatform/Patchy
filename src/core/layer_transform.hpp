#pragma once

#include "core/document.hpp"

#include <array>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace patchy {

enum class LayerTransformInterpolation : std::uint8_t {
  Nearest,
  Bilinear,
};

struct LayerTransformRequest {
  // Document-space corners in top-left, top-right, bottom-right, bottom-left
  // order. Pixel layers accept a general convex perspective quad. Editable text
  // accepts only an affine parallelogram so its TySh transform stays editable.
  std::array<double, 8> quad{};
  LayerTransformInterpolation interpolation{LayerTransformInterpolation::Bilinear};
  // Checked between output rows. False cancels without changing the document.
  std::function<bool()> continue_operation{};
};

struct LayerTransformResult {
  Rect previous_bounds{};
  Rect transformed_bounds{};
  Rect affected_region{};
};

struct LayerBatchTransformRequest {
  // Unique selected roots. Group roots expand recursively, with at most 256
  // transformable leaves across the complete forest.
  std::vector<LayerId> layer_ids;
  // Collective destination corners for the pre-transform union bounds.
  std::array<double, 8> quad{};
  LayerTransformInterpolation interpolation{LayerTransformInterpolation::Bilinear};
  std::function<bool()> continue_operation{};
};

enum class LayerArrangeMode : std::uint8_t {
  AlignLeft,
  AlignHorizontalCenter,
  AlignRight,
  AlignTop,
  AlignVerticalCenter,
  AlignBottom,
  DistributeHorizontalGaps,
  DistributeVerticalGaps,
};

enum class LayerArrangeReference : std::uint8_t {
  Selection,
  Canvas,
};

struct LayerArrangeRequest {
  // Unique selected roots in stable top-to-bottom order. Group roots expand
  // recursively; descendants cannot also be submitted as roots.
  std::vector<LayerId> layer_ids;
  LayerArrangeMode mode{LayerArrangeMode::AlignLeft};
  LayerArrangeReference reference{LayerArrangeReference::Selection};
};

// Applies one engine-owned transform to a pixel, editable text or editable
// Smart Object layer. Smart Object placement/non-affine quads are mapped with
// the same homography while embedded source, filters and warp state survive. The
// raster and a linked raster mask use the exact same document-space homography.
// Unsupported layer kinds, unlinked masks, vector masks, degenerate/non-convex
// quads and excessive output allocations fail closed without changing document.
[[nodiscard]] bool transform_layer(Document& document, LayerId layer_id,
                                   const LayerTransformRequest& request,
                                   LayerTransformResult* result,
                                   std::string* error);

// Applies one collective homography to a bounded selected forest. Relative
// placement is preserved by mapping every leaf's original bounds through the
// union-bounds homography. The caller owns publication: failure may alter this
// prepared Document but never a canonical session state.
[[nodiscard]] bool transform_layers(Document& document,
                                    const LayerBatchTransformRequest& request,
                                    LayerTransformResult* result,
                                    std::string* error);

// Aligns or distributes a bounded selected forest using exact integral
// translations. Pixel bytes are never resampled; linked masks and editable
// Text/Smart Object placement metadata move with their owning roots. Every
// translation is validated before the document is changed.
[[nodiscard]] bool arrange_layers(Document& document,
                                  const LayerArrangeRequest& request,
                                  LayerTransformResult* result,
                                  std::string* error);

}  // namespace patchy
