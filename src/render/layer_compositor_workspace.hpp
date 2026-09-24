#pragma once

#include "core/pattern_sampler.hpp"

#include <cstdint>
#include <optional>

namespace patchy::render_detail {

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
