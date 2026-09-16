#pragma once

#include "psd/psd_document_io.hpp"

#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <span>
#include <string>
#include <vector>

namespace patchy {
class CmykToRgbTransform;
struct PatternResource;
struct SmartFilterEffectsBlock;
}  // namespace patchy

namespace patchy::psd {

class ParseBudgetTracker {
public:
  ParseBudgetTracker(std::uint64_t limit, std::uint64_t* usage,
                     ParseBudgetDimension dimension)
      : remaining_(limit), usage_(usage), dimension_(dimension) {}

  void charge_dimensions(std::int32_t width, std::int32_t height,
                          std::size_t channels) {
    charge_size(checked_allocation_dimensions(width, height, channels, 1U));
  }

  void charge_decompressed_dimensions(std::int32_t width, std::int32_t height,
                                      std::size_t channels,
                                      std::size_t bytes_per_sample) {
    charge_size(checked_decompressed_dimensions(
        width, height, channels, bytes_per_sample));
  }

  [[nodiscard]] std::size_t checked_decompressed_dimensions(
      std::int32_t width, std::int32_t height, std::size_t channels,
      std::size_t bytes_per_sample) const {
    return checked_allocation_dimensions(
        width, height, channels, bytes_per_sample);
  }

  [[nodiscard]] std::size_t checked_allocation_dimensions(
      std::int32_t width, std::int32_t height, std::size_t channels,
      std::size_t bytes_per_sample) const {
    const auto bytes = checked_dimensions(
        width, height, channels, bytes_per_sample);
    if constexpr (sizeof(std::size_t) < sizeof(std::uint64_t)) {
      if (bytes > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        reject();
      }
    }
    const auto result = static_cast<std::size_t>(bytes);
    if (result > std::vector<std::uint8_t>{}.max_size()) {
      reject();
    }
    return result;
  }

  void charge_size(std::size_t bytes) {
    if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
      if (bytes > std::numeric_limits<std::uint64_t>::max()) {
        reject();
      }
    }
    charge(static_cast<std::uint64_t>(bytes));
  }

  void charge(std::uint64_t bytes) {
    if (bytes > remaining_) {
      reject();
    }
    if (usage_ != nullptr && bytes > std::numeric_limits<std::uint64_t>::max() - *usage_) {
      reject();
    }
    remaining_ -= bytes;
    if (usage_ != nullptr) {
      *usage_ += bytes;
    }
  }

  [[noreturn]] void reject() const {
    throw ParseBudgetExceeded(dimension_);
  }

private:
  [[nodiscard]] std::uint64_t checked_dimensions(
      std::int32_t width, std::int32_t height, std::size_t channels,
      std::size_t bytes_per_sample) const {
    if (width <= 0 || height <= 0 || channels == 0U || bytes_per_sample == 0U) {
      return 0U;
    }
    const auto width_u64 = static_cast<std::uint64_t>(width);
    const auto height_u64 = static_cast<std::uint64_t>(height);
    if (height_u64 > std::numeric_limits<std::uint64_t>::max() / width_u64) {
      reject();
    }
    const auto pixels = width_u64 * height_u64;
    if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
      if (channels > std::numeric_limits<std::uint64_t>::max() ||
          bytes_per_sample > std::numeric_limits<std::uint64_t>::max()) {
        reject();
      }
    }
    const auto channels_u64 = static_cast<std::uint64_t>(channels);
    const auto sample_bytes_u64 = static_cast<std::uint64_t>(bytes_per_sample);
    if (channels_u64 > std::numeric_limits<std::uint64_t>::max() / pixels) {
      reject();
    }
    const auto samples = pixels * channels_u64;
    if (sample_bytes_u64 > std::numeric_limits<std::uint64_t>::max() / samples) {
      reject();
    }
    return samples * sample_bytes_u64;
  }

  std::uint64_t remaining_;
  std::uint64_t* usage_;
  ParseBudgetDimension dimension_;
};

[[nodiscard]] std::vector<PatternResource> parse_patterns_block(
    std::span<const std::uint8_t> payload, const CmykToRgbTransform* cmyk_icc,
    ParseBudgetTracker& decompressed_budget);

[[nodiscard]] SmartFilterEffectsBlock parse_filter_effects_block(
    std::string key, std::shared_ptr<const std::vector<std::uint8_t>> payload,
    bool long_length, std::size_t original_global_index,
    ParseBudgetTracker& decompressed_budget);

}  // namespace patchy::psd
