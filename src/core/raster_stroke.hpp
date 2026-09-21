#pragma once

#include "core/document.hpp"
#include "core/pixel_tools.hpp"

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace patchy {

enum class RasterStrokeMode : std::uint8_t { Brush, Eraser, Clone, Heal };
enum class RasterFillMode : std::uint8_t {
  ForegroundTransparent,
  BlackWhite,
  Sunset,
  Ocean,
  Solid,
  Checker,
  Dots,
  CustomGradient,
  CustomChecker,
  CustomDots,
};
struct RasterStrokePoint { double x{0.0}; double y{0.0}; };
struct RasterStrokeRequest {
  RasterStrokeMode mode{RasterStrokeMode::Brush};
  std::vector<RasterStrokePoint> points{};
  std::int32_t brush_size{12};
  EditColor color{};
  RasterStrokePoint source{};
  std::vector<Rect> selection{};
  Rect selection_mask_bounds{};
  std::optional<PixelBuffer> selection_mask{};
  std::function<bool()> continue_operation{};
};
struct RasterStrokeResult { Rect affected_region{}; };
struct RasterFillRequest {
  RasterFillMode mode{RasterFillMode::Solid};
  EditColor color{};
  EditColor secondary_color{255, 255, 255, 255};
  std::int32_t pattern_size{8};
  RasterStrokePoint start{};
  RasterStrokePoint end{};
  std::vector<Rect> selection{};
  Rect selection_mask_bounds{};
  std::optional<PixelBuffer> selection_mask{};
  std::function<bool()> continue_operation{};
};

[[nodiscard]] bool apply_raster_stroke(Document& document, LayerId layer_id,
                                       const RasterStrokeRequest& request,
                                       RasterStrokeResult* result,
                                       std::string* error);
[[nodiscard]] bool apply_layer_mask_stroke(Document& document, LayerId layer_id,
                                           const RasterStrokeRequest& request,
                                           RasterStrokeResult* result,
                                           std::string* error);
[[nodiscard]] bool apply_raster_fill(Document& document, LayerId layer_id,
                                     const RasterFillRequest& request,
                                     RasterStrokeResult* result,
                                     std::string* error);

}  // namespace patchy
