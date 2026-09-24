#pragma once

#include "core/document.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace patchy {

enum class RetouchRepairMode : std::uint8_t {
  SpotHealing,
  PatchSource,
  PatchDestination,
};

struct RetouchRepairPoint {
  double x{0.0};
  double y{0.0};
};

// Binding legal boundary: Spot Healing chooses one coherent rigid source map
// from footprint GEOMETRY only; Patch uses only the user's explicit drag
// offset. Pixel content must never participate in source selection. Do not add
// patch search, synthesis-by-example, reshuffling, source-gradient compositing,
// or live healed preview. See docs/legal-constraints.md.
struct RetouchRepairRequest {
  RetouchRepairMode mode{RetouchRepairMode::SpotHealing};
  std::vector<RetouchRepairPoint> points{};
  std::int32_t brush_size{24};
  std::int32_t softness{50};
  std::int32_t delta_x{0};
  std::int32_t delta_y{0};
  bool transparent{false};
  bool sample_all_layers{true};
  std::vector<Rect> selection{};
  Rect selection_mask_bounds{};
  std::optional<PixelBuffer> selection_mask{};
  std::function<bool()> continue_operation{};
};

struct RetouchRepairResult {
  Rect affected_region{};
  // Patch Destination follows the copied selection by this offset. The engine
  // host publishes it atomically with the prepared document state.
  std::int32_t selection_delta_x{0};
  std::int32_t selection_delta_y{0};
};

[[nodiscard]] bool apply_retouch_repair(Document& document, LayerId layer_id,
                                        const RetouchRepairRequest& request,
                                        RetouchRepairResult* result,
                                        std::string* error);

}  // namespace patchy
