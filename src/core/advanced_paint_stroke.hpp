#pragma once

#include "core/document.hpp"
#include "core/pixel_tools.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace patchy {

enum class AdvancedPaintMode : std::uint8_t { MixerBrush, PatternStamp };
enum class AdvancedPaintPattern : std::uint8_t { Checker, Dots };

struct AdvancedPaintPoint {
  double x{0.0};
  double y{0.0};
};

// Binding legal boundary: Mixer keeps exactly one canvas-derived running
// premultiplied average; Pattern Stamp reads one explicit static tile. Do not
// add per-pixel/bristle reservoirs, fluid simulation, content-adaptive pattern
// synthesis or destination-derived source selection. See docs/legal-constraints.md.
struct AdvancedPaintStrokeRequest {
  AdvancedPaintMode mode{AdvancedPaintMode::MixerBrush};
  std::vector<AdvancedPaintPoint> points{};
  std::int32_t brush_size{24};
  std::int32_t softness{50};
  std::int32_t flow{100};
  EditColor color{};
  std::int32_t wet{50};
  std::int32_t load{50};
  std::int32_t mix{50};
  bool sample_all_layers{false};
  AdvancedPaintPattern pattern{AdvancedPaintPattern::Checker};
  std::int32_t pattern_size{8};
  EditColor secondary_color{255, 255, 255, 255};
  std::int32_t pattern_anchor_x{0};
  std::int32_t pattern_anchor_y{0};
  bool pattern_aligned{true};
  std::vector<Rect> selection{};
  Rect selection_mask_bounds{};
  std::optional<PixelBuffer> selection_mask{};
  std::function<bool()> continue_operation{};
};

struct AdvancedPaintStrokeResult {
  Rect affected_region{};
};

[[nodiscard]] bool apply_advanced_paint_stroke(
    Document& document, LayerId layer_id,
    const AdvancedPaintStrokeRequest& request,
    AdvancedPaintStrokeResult* result, std::string* error);

}  // namespace patchy
