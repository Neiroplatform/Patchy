#pragma once

#include "core/document.hpp"
#include "core/layer_transform.hpp"

#include <cstdint>
#include <functional>
#include <string>

namespace patchy {

struct LayerWarpRequest {
  std::string style{"warpArc"};
  double bend{0.0};
  double horizontal_distortion{0.0};
  double vertical_distortion{0.0};
  bool rotate_vertical{false};
  LayerTransformInterpolation interpolation{LayerTransformInterpolation::Bilinear};
  // Checked between surface rows and output scanlines. False cancels without
  // changing the document.
  std::function<bool()> continue_operation{};
};

struct LayerWarpResult {
  Rect previous_bounds{};
  Rect warped_bounds{};
  Rect affected_region{};
};

// Applies a Photoshop-compatible preset warp to one RGBA8 pixel or Smart Object
// cache. A linked raster mask is warped atomically when it shares the layer's
// geometry. Unsupported masks/metadata and excessive allocations fail closed.
[[nodiscard]] bool warp_layer(Document& document, LayerId layer_id,
                              const LayerWarpRequest& request,
                              LayerWarpResult* result, std::string* error);

}  // namespace patchy
