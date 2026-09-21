#pragma once

#include "core/layer.hpp"
#include "core/pixel_buffer.hpp"

#include <cstdint>
#include <limits>
#include <optional>
#include <unordered_map>

namespace patchy {

struct TileKey {
  std::int32_t x{0};
  std::int32_t y{0};
  std::int32_t mip{0};

  [[nodiscard]] bool operator==(const TileKey& other) const noexcept;
};

struct TileKeyHash {
  [[nodiscard]] std::size_t operator()(const TileKey& key) const noexcept;
};

class TileCache {
public:
  explicit TileCache(std::int32_t tile_size = 256,
                     std::size_t maximum_bytes = 64U * 1024U * 1024U);

  [[nodiscard]] std::int32_t tile_size() const noexcept;
  [[nodiscard]] std::size_t size() const noexcept;
  [[nodiscard]] std::size_t retained_bytes() const noexcept;
  [[nodiscard]] std::size_t maximum_bytes() const noexcept;
  [[nodiscard]] std::uint64_t hits() const noexcept;
  [[nodiscard]] std::uint64_t misses() const noexcept;
  [[nodiscard]] std::uint64_t evictions() const noexcept;
  [[nodiscard]] std::optional<PixelBuffer> find(TileKey key);

  void put(TileKey key, PixelBuffer tile);
  void invalidate(TileKey key);
  void invalidate(Rect region);
  void set_maximum_bytes(std::size_t maximum_bytes);
  void clear();

private:
  struct Entry {
    PixelBuffer pixels{};
    std::uint64_t last_use{0};
  };

  void evict_to_budget();

  std::int32_t tile_size_{256};
  std::size_t maximum_bytes_{64U * 1024U * 1024U};
  std::size_t retained_bytes_{0};
  std::uint64_t clock_{0};
  std::uint64_t hits_{0};
  std::uint64_t misses_{0};
  std::uint64_t evictions_{0};
  std::unordered_map<TileKey, Entry, TileKeyHash> tiles_;
};

}  // namespace patchy
