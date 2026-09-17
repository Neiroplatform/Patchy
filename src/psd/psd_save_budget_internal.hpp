#pragma once

#include "psd/psd_binary.hpp"
#include "psd/psd_document_io.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <utility>
#include <vector>

namespace patchy::psd {

// Save-reachable compatibility fallbacks catch std::exception. Keep the
// internal signal outside that hierarchy so a budget rejection cannot be
// mistaken for a damaged optional payload; public write boundaries translate it
// to SaveBudgetExceeded.
struct SaveLiveBudgetSignal final {};

class SaveLiveBudgetTracker {
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
      if (tracker_ == nullptr || bytes == 0U) {
        return;
      }
      if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
        if (bytes > std::numeric_limits<std::uint64_t>::max()) {
          tracker_->reject();
        }
      }
      const auto increment = static_cast<std::uint64_t>(bytes);
      if (increment > std::numeric_limits<std::uint64_t>::max() - bytes_) {
        tracker_->reject();
      }
      tracker_->grow(increment);
      bytes_ += increment;
    }

    void resize_size(std::size_t bytes) {
      if (tracker_ == nullptr) {
        return;
      }
      if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
        if (bytes > std::numeric_limits<std::uint64_t>::max()) {
          tracker_->reject();
        }
      }
      const auto next = static_cast<std::uint64_t>(bytes);
      if (next > bytes_) {
        grow_size(static_cast<std::size_t>(next - bytes_));
      } else if (next < bytes_) {
        tracker_->release(bytes_ - next);
        bytes_ = next;
      }
    }

    void release() noexcept {
      if (tracker_ != nullptr) {
        tracker_->release(bytes_);
        tracker_ = nullptr;
        bytes_ = 0U;
      }
    }

    [[nodiscard]] std::uint64_t bytes() const noexcept { return bytes_; }

  private:
    friend class SaveLiveBudgetTracker;
    Reservation(SaveLiveBudgetTracker* tracker, std::uint64_t bytes) noexcept
        : tracker_(tracker), bytes_(bytes) {}

    SaveLiveBudgetTracker* tracker_{nullptr};
    std::uint64_t bytes_{0};
  };

  SaveLiveBudgetTracker(std::uint64_t limit, std::uint64_t* current_usage,
                        std::uint64_t* high_water_usage)
      : limit_(limit), current_usage_(current_usage),
        high_water_usage_(high_water_usage) {}

  SaveLiveBudgetTracker(const SaveLiveBudgetTracker&) = delete;
  SaveLiveBudgetTracker& operator=(const SaveLiveBudgetTracker&) = delete;
  SaveLiveBudgetTracker(SaveLiveBudgetTracker&&) = delete;
  SaveLiveBudgetTracker& operator=(SaveLiveBudgetTracker&&) = delete;

  [[nodiscard]] Reservation reserve(std::uint64_t bytes) {
    if (bytes > limit_ - current_) {
      reject();
    }
    current_ += bytes;
    high_water_ = std::max(high_water_, current_);
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
    if (element_size != 0U &&
        count > std::numeric_limits<std::size_t>::max() / element_size) {
      reject();
    }
    return reserve_size(count * element_size);
  }

  [[noreturn]] void reject() const { throw SaveLiveBudgetSignal{}; }

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

// Reservation precedes storage so the allocation dies before its charge is
// released. The type is deliberately move-only to prevent uncharged copies.
class SaveTrackedByteBuffer {
private:
  SaveLiveBudgetTracker::Reservation reservation_;

public:
  SaveTrackedByteBuffer() = default;
  SaveTrackedByteBuffer(SaveLiveBudgetTracker::Reservation reservation,
                        std::vector<std::uint8_t> value)
      : reservation_(std::move(reservation)), bytes(std::move(value)) {}
  SaveTrackedByteBuffer(const SaveTrackedByteBuffer&) = delete;
  SaveTrackedByteBuffer& operator=(const SaveTrackedByteBuffer&) = delete;
  SaveTrackedByteBuffer(SaveTrackedByteBuffer&& other) noexcept
      : reservation_(std::move(other.reservation_)), bytes(std::move(other.bytes)) {}
  SaveTrackedByteBuffer& operator=(SaveTrackedByteBuffer&& other) noexcept {
    if (this != &other) {
      bytes = std::move(other.bytes);
      reservation_ = std::move(other.reservation_);
    }
    return *this;
  }

  [[nodiscard]] SaveLiveBudgetTracker::Reservation take_reservation() noexcept {
    return std::move(reservation_);
  }

  std::vector<std::uint8_t> bytes;
};

// Charges the logical byte owner before allocating its copy. This is used for
// save-time payloads borrowed from the document (for example ICC profiles and
// clean relocated paths) so admission never happens after allocation.
inline SaveTrackedByteBuffer save_tracked_byte_copy(std::span<const std::uint8_t> source,
                                                    SaveLiveBudgetTracker& tracker) {
  auto reservation = tracker.reserve_size(source.size());
  std::vector<std::uint8_t> bytes(source.begin(), source.end());
  return SaveTrackedByteBuffer(std::move(reservation), std::move(bytes));
}

// Incrementally charges logical bytes before BigEndianWriter grows.
class SaveTrackedWriter {
public:
  explicit SaveTrackedWriter(SaveLiveBudgetTracker& tracker)
      : reservation_(tracker.reserve(0U)),
        writer_(&SaveTrackedWriter::before_write, &reservation_) {}

  SaveTrackedWriter(const SaveTrackedWriter&) = delete;
  SaveTrackedWriter& operator=(const SaveTrackedWriter&) = delete;
  SaveTrackedWriter(SaveTrackedWriter&&) = delete;
  SaveTrackedWriter& operator=(SaveTrackedWriter&&) = delete;

  [[nodiscard]] BigEndianWriter& writer() noexcept { return writer_; }
  [[nodiscard]] const BigEndianWriter& writer() const noexcept { return writer_; }
  [[nodiscard]] SaveTrackedByteBuffer take_buffer() && {
    return SaveTrackedByteBuffer(std::move(reservation_),
                                 std::move(writer_).take_bytes());
  }

private:
  static void before_write(void* context, std::size_t bytes) {
    static_cast<SaveLiveBudgetTracker::Reservation*>(context)->grow_size(bytes);
  }

  SaveLiveBudgetTracker::Reservation reservation_;
  BigEndianWriter writer_;
};

}  // namespace patchy::psd
