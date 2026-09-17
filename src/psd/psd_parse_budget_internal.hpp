#pragma once

#include "psd/psd_document_io.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <utility>
#include <vector>

namespace patchy {
class CmykToRgbTransform;
struct PatternResource;
struct SmartFilterEffectsBlock;
struct SmartObjectSource;
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

class ParseLiveBudgetTracker {
public:
  class Reservation {
  public:
    Reservation() = default;
    Reservation(const Reservation&) = delete;
    Reservation& operator=(const Reservation&) = delete;

    Reservation(Reservation&& other) noexcept
        : tracker_(std::exchange(other.tracker_, nullptr)),
          bytes_(std::exchange(other.bytes_, 0U)) {}

    Reservation& operator=(Reservation&& other) noexcept {
      if (this != &other) {
        release();
        tracker_ = std::exchange(other.tracker_, nullptr);
        bytes_ = std::exchange(other.bytes_, 0U);
      }
      return *this;
    }

    ~Reservation() { release(); }

    void grow_size(std::size_t bytes) {
      if (tracker_ == nullptr) {
        return;
      }
      if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
        if (bytes > std::numeric_limits<std::uint64_t>::max()) {
          tracker_->reject();
        }
      }
      const auto increment = static_cast<std::uint64_t>(bytes);
      tracker_->grow(increment);
      bytes_ += increment;
    }

    void release() noexcept {
      if (tracker_ != nullptr) {
        tracker_->release(bytes_);
        tracker_ = nullptr;
        bytes_ = 0U;
      }
    }

  private:
    friend class ParseLiveBudgetTracker;
    Reservation(ParseLiveBudgetTracker* tracker, std::uint64_t bytes) noexcept
        : tracker_(tracker), bytes_(bytes) {}

    ParseLiveBudgetTracker* tracker_{nullptr};
    std::uint64_t bytes_{0};
  };

  ParseLiveBudgetTracker(std::uint64_t limit, std::uint64_t* current_usage,
                         std::uint64_t* high_water_usage)
      : limit_(limit), current_usage_(current_usage),
        high_water_usage_(high_water_usage) {}

  ParseLiveBudgetTracker(const ParseLiveBudgetTracker&) = delete;
  ParseLiveBudgetTracker& operator=(const ParseLiveBudgetTracker&) = delete;
  ParseLiveBudgetTracker(ParseLiveBudgetTracker&&) = delete;
  ParseLiveBudgetTracker& operator=(ParseLiveBudgetTracker&&) = delete;

  [[nodiscard]] Reservation reserve(std::uint64_t bytes) {
    if (bytes > limit_ - current_) {
      reject();
    }
    const auto next = current_ + bytes;
    current_ = next;
    high_water_ = std::max(high_water_, next);
    publish();
    return Reservation(this, bytes);
  }

  [[nodiscard]] Reservation reserve_size(std::size_t bytes) {
    if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
      if (bytes > std::numeric_limits<std::uint64_t>::max()) {
        reject();
      }
    }
    return reserve(static_cast<std::uint64_t>(bytes));
  }

  [[nodiscard]] Reservation reserve_product(std::size_t count,
                                            std::size_t element_size) {
    if (element_size != 0U && count > std::numeric_limits<std::size_t>::max() / element_size) {
      reject();
    }
    return reserve_size(count * element_size);
  }

  [[noreturn]] void reject() const {
    throw ParseBudgetExceeded(ParseBudgetDimension::TrackedLiveBytes);
  }

private:
  void grow(std::uint64_t bytes) {
    if (bytes > limit_ - current_) {
      reject();
    }
    current_ += bytes;
    high_water_ = std::max(high_water_, current_);
    publish();
  }

  void release(std::uint64_t bytes) noexcept {
    current_ -= bytes;
    publish();
  }

  void publish() noexcept {
    if (current_usage_ != nullptr) {
      *current_usage_ = current_;
    }
    if (high_water_usage_ != nullptr) {
      *high_water_usage_ = high_water_;
    }
  }

  std::uint64_t limit_;
  std::uint64_t current_{0};
  std::uint64_t high_water_{0};
  std::uint64_t* current_usage_;
  std::uint64_t* high_water_usage_;
};

// The reservation is declared before the vector so destruction releases the
// logical charge only after the allocation itself has died. Move assignment
// similarly replaces the vector before transferring the reservation.
class TrackedByteBuffer {
private:
  ParseLiveBudgetTracker::Reservation reservation_;

public:
  TrackedByteBuffer() = default;
  TrackedByteBuffer(ParseLiveBudgetTracker::Reservation reservation,
                    std::vector<std::uint8_t> value)
      : reservation_(std::move(reservation)), bytes(std::move(value)) {}
  TrackedByteBuffer(const TrackedByteBuffer&) = delete;
  TrackedByteBuffer& operator=(const TrackedByteBuffer&) = delete;
  TrackedByteBuffer(TrackedByteBuffer&& other) noexcept
      : reservation_(std::move(other.reservation_)), bytes(std::move(other.bytes)) {}
  TrackedByteBuffer& operator=(TrackedByteBuffer&& other) noexcept {
    if (this != &other) {
      bytes = std::move(other.bytes);
      reservation_ = std::move(other.reservation_);
    }
    return *this;
  }

  void release_reservation() noexcept { reservation_.release(); }

  std::vector<std::uint8_t> bytes;
};

// PSD descriptor helpers are reused by ABR/ASL/GRD and several recovery-oriented
// codecs. A scoped, thread-local tracker lets a DocumentIo read aggregate every
// descriptor node without changing those other formats or threading an option
// through every semantic decoder. The private signal deliberately does not derive
// from std::exception, so legacy "damaged optional block" catches cannot turn a
// structural-budget rejection into a silent fallback; DocumentIo translates it
// back to the public typed ParseBudgetExceeded at its boundary.
struct DescriptorNodeBudgetSignal final {};

class DescriptorNodeBudgetScope {
public:
  explicit DescriptorNodeBudgetScope(ParseBudgetTracker& tracker) noexcept;
  ~DescriptorNodeBudgetScope();
  DescriptorNodeBudgetScope(const DescriptorNodeBudgetScope&) = delete;
  DescriptorNodeBudgetScope& operator=(const DescriptorNodeBudgetScope&) = delete;

private:
  ParseBudgetTracker* previous_{nullptr};
};

void charge_active_descriptor_nodes(std::uint64_t count);

[[nodiscard]] std::vector<PatternResource> parse_patterns_block(
    std::span<const std::uint8_t> payload, const CmykToRgbTransform* cmyk_icc,
    ParseBudgetTracker& decompressed_budget,
    ParseLiveBudgetTracker& tracked_live_budget,
    ParseBudgetTracker& pattern_record_budget,
    ParseBudgetTracker& retained_payload_budget);

[[nodiscard]] SmartFilterEffectsBlock parse_filter_effects_block(
    std::string key, std::shared_ptr<const std::vector<std::uint8_t>> payload,
    bool long_length, std::size_t original_global_index,
    ParseBudgetTracker& decompressed_budget,
    ParseLiveBudgetTracker& tracked_live_budget,
    ParseBudgetTracker& retained_payload_budget);

[[nodiscard]] std::optional<std::vector<SmartObjectSource>>
parse_linked_layer_block(
    std::span<const std::uint8_t> payload,
    ParseBudgetTracker& retained_payload_budget,
    bool preserve_original_payloads);

}  // namespace patchy::psd
