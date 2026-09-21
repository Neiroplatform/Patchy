#pragma once

#include "core/document.hpp"

#include <array>
#include <cstdint>
#include <functional>
#include <string>

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

// Applies one engine-owned transform to a pixel or editable text layer. The
// raster and a linked raster mask use the exact same document-space homography.
// Unsupported layer kinds, unlinked masks, vector masks, degenerate/non-convex
// quads and excessive output allocations fail closed without changing document.
[[nodiscard]] bool transform_layer(Document& document, LayerId layer_id,
                                   const LayerTransformRequest& request,
                                   LayerTransformResult* result,
                                   std::string* error);

}  // namespace patchy
