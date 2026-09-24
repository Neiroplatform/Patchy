#pragma once

#include "core/vector_shape.hpp"

#include <cstddef>

namespace patchy::vector_raster_detail {

// Value stored by rasterize_vector_path for every consecutive shape-group
// run. Shared with the save census so its platform-specific logical owner size
// cannot drift from the renderer allocation.
struct PathGroup {
  std::size_t first{0};
  std::size_t end{0};
  PathCombineOp op{PathCombineOp::Add};
};

}  // namespace patchy::vector_raster_detail
