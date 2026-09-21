#include "render/tile_cache.hpp"

#include "core/rect_utils.hpp"
#include "support/translate_noop.hpp"

#include <algorithm>
#include <functional>
#include <stdexcept>
#include <utility>

namespace patchy {

bool TileKey::operator==(const TileKey& other) const noexcept {
  return x == other.x && y == other.y && mip == other.mip;
}

std::size_t TileKeyHash::operator()(const TileKey& key) const noexcept {
  auto seed = std::hash<std::int32_t>{}(key.x);
  seed ^= std::hash<std::int32_t>{}(key.y) + 0x9e3779b9U + (seed << 6U) + (seed >> 2U);
  seed ^= std::hash<std::int32_t>{}(key.mip) + 0x9e3779b9U + (seed << 6U) + (seed >> 2U);
  return seed;
}

TileCache::TileCache(std::int32_t tile_size, std::size_t maximum_bytes)
    : tile_size_(tile_size), maximum_bytes_(maximum_bytes) {
  if (tile_size <= 0) {
    throw std::invalid_argument(PATCHY_TRANSLATE_NOOP("QObject", "Tile size must be positive"));
  }
}

std::int32_t TileCache::tile_size() const noexcept {
  return tile_size_;
}

std::size_t TileCache::size() const noexcept {
  return tiles_.size();
}

std::size_t TileCache::retained_bytes() const noexcept { return retained_bytes_; }
std::size_t TileCache::maximum_bytes() const noexcept { return maximum_bytes_; }
std::uint64_t TileCache::hits() const noexcept { return hits_; }
std::uint64_t TileCache::misses() const noexcept { return misses_; }
std::uint64_t TileCache::evictions() const noexcept { return evictions_; }

std::optional<PixelBuffer> TileCache::find(TileKey key) {
  auto found = tiles_.find(key);
  if (found == tiles_.end()) {
    ++misses_;
    return std::nullopt;
  }
  ++hits_;
  found->second.last_use = ++clock_;
  return found->second.pixels;
}

void TileCache::put(TileKey key, PixelBuffer tile) {
  const auto bytes = tile.byte_size();
  if (const auto found = tiles_.find(key); found != tiles_.end()) {
    retained_bytes_ -= found->second.pixels.byte_size();
    tiles_.erase(found);
  }
  if (bytes > maximum_bytes_) return;
  retained_bytes_ += bytes;
  tiles_.emplace(key, Entry{std::move(tile), ++clock_});
  evict_to_budget();
}

void TileCache::invalidate(TileKey key) {
  const auto found = tiles_.find(key);
  if (found == tiles_.end()) return;
  retained_bytes_ -= found->second.pixels.byte_size();
  tiles_.erase(found);
}

void TileCache::invalidate(Rect region) {
  for (auto iterator = tiles_.begin(); iterator != tiles_.end();) {
    const auto scale = std::int64_t{1} << std::clamp(iterator->first.mip, 0, 30);
    const auto extent = static_cast<std::int64_t>(tile_size_) * scale;
    const Rect tile_region{
        static_cast<std::int32_t>(iterator->first.x * extent),
        static_cast<std::int32_t>(iterator->first.y * extent),
        static_cast<std::int32_t>(std::min<std::int64_t>(
            extent, std::numeric_limits<std::int32_t>::max())),
        static_cast<std::int32_t>(std::min<std::int64_t>(
            extent, std::numeric_limits<std::int32_t>::max()))};
    if (intersect_rect(tile_region, region).empty()) { ++iterator; continue; }
    retained_bytes_ -= iterator->second.pixels.byte_size();
    iterator = tiles_.erase(iterator);
  }
}

void TileCache::set_maximum_bytes(std::size_t maximum_bytes) {
  maximum_bytes_ = maximum_bytes;
  evict_to_budget();
}

void TileCache::clear() {
  tiles_.clear();
  retained_bytes_ = 0;
}

void TileCache::evict_to_budget() {
  while (retained_bytes_ > maximum_bytes_ && !tiles_.empty()) {
    const auto oldest = std::min_element(tiles_.begin(), tiles_.end(),
      [](const auto &left, const auto &right) {
        return left.second.last_use < right.second.last_use;
      });
    retained_bytes_ -= oldest->second.pixels.byte_size();
    tiles_.erase(oldest);
    ++evictions_;
  }
}

}  // namespace patchy
