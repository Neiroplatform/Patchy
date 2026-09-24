#pragma once

#include "core/document.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace patchy {

enum class LocalAdjustmentBrushMode : std::uint8_t {
  Smudge,
  Dodge,
  Burn,
  Sponge,
  Blur,
  Sharpen,
};

enum class LocalAdjustmentToneRange : std::uint8_t {
  Shadows,
  Midtones,
  Highlights,
};

struct LocalAdjustmentBrushPoint {
  double x{0.0};
  double y{0.0};
};

// Binding legal boundary: every mode is a fixed local operation selected only
// by the user-authored brush footprint and explicit controls. Do not add edge
// ranking, content classification, patch/source search, deconvolution, or any
// other adaptive source/kernel selection. See docs/brushes.md and
// docs/patent-research.md.
struct LocalAdjustmentBrushRequest {
  LocalAdjustmentBrushMode mode{LocalAdjustmentBrushMode::Smudge};
  std::vector<LocalAdjustmentBrushPoint> points{};
  std::int32_t brush_size{24};
  std::int32_t softness{50};
  std::int32_t strength{50};
  LocalAdjustmentToneRange tone_range{LocalAdjustmentToneRange::Midtones};
  bool protect_tones{true};
  bool sponge_saturate{false};
  bool sponge_vibrance{true};
  std::vector<Rect> selection{};
  Rect selection_mask_bounds{};
  std::optional<PixelBuffer> selection_mask{};
  std::function<bool()> continue_operation{};
};

struct LocalAdjustmentBrushResult {
  Rect affected_region{};
};

[[nodiscard]] bool apply_local_adjustment_brush(
    Document& document, LayerId layer_id,
    const LocalAdjustmentBrushRequest& request,
    LocalAdjustmentBrushResult* result, std::string* error);

}  // namespace patchy
