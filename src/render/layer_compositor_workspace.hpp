#pragma once

#include "core/pattern_sampler.hpp"

#include <cstdint>
#include <optional>

namespace patchy::render_detail {

// One value-owned preview/group override. Styled isolated groups allocate a
// one-element vector and retain it through their recursive pixel-layer pass;
// the save census shares this exact type for native/WASM owner accounting.
struct LayerBoundsOverride {
  LayerId layer_id{};
  Rect bounds{};
  const PixelBuffer* pixels{nullptr};
  std::optional<Rect> mask_bounds{};
  std::optional<bool> visible{};
};

// One resolved interior overlay owned by the compositor while it folds a
// layer's Pattern, Gradient and Color overlays into straight RGB. The save
// census shares this exact type to derive the logical vector owner size on
// native and WASM targets.
struct PreparedInteriorOverlay {
  enum class Kind : std::uint8_t { Pattern, Gradient, Color };

  Kind kind{Kind::Color};
  BlendMode blend_mode{BlendMode::Normal};
  float opacity{1.0F};
  RgbColor color{};
  std::optional<PatternTileSampler> pattern{};
  const LayerStyleGradient* gradient{nullptr};
  Rect gradient_bounds{};
};

}  // namespace patchy::render_detail
