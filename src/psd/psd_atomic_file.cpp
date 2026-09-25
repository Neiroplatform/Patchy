#include "psd/psd_atomic_file_internal.hpp"
#include "psd/psd_document_io.hpp"

#include "support/translate_noop.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <fstream>
#include <stdexcept>
#include <string>
#include <system_error>

namespace patchy::psd {
namespace atomic_file_detail {
namespace {

std::atomic<std::uint64_t> temporary_sequence{0U};

std::filesystem::path::string_type native_ascii(std::string_view value) {
  std::filesystem::path::string_type native;
  native.reserve(value.size());
  for (const auto ch : value) {
    native.push_back(static_cast<std::filesystem::path::value_type>(ch));
  }
  return native;
}

}  // namespace

[[noreturn]] void throw_write_error() {
  throw std::runtime_error(
      PATCHY_TRANSLATE_NOOP("QObject", "Could not open PSD file for writing"));
}

std::filesystem::path destination_parent(const std::filesystem::path& path) {
  const auto parent = path.parent_path();
  return parent.empty() ? std::filesystem::path(".") : parent;
}

std::filesystem::path next_temporary_candidate(
    const std::filesystem::path& destination, std::uint64_t process_id) {
  if (destination.filename().empty()) {
    throw_write_error();
  }
  const auto sequence =
      temporary_sequence.fetch_add(1U, std::memory_order_relaxed);
  const auto destination_name = destination.filename().native();
  const char prefix =
      destination_name.front() ==
              static_cast<std::filesystem::path::value_type>('.')
          ? '_'
          : '.';
  const auto suffix = std::string(1U, prefix) + "patchy-save-" +
                      std::to_string(process_id) + "-" +
                      std::to_string(sequence) + ".tmp";
  return destination_parent(destination) /
         std::filesystem::path(native_ascii(suffix));
}

void call_stage_hook(const AtomicWriteTestControl& control,
                     AtomicWriteStage stage,
                     const std::filesystem::path& temporary_path) {
  if (control.stage_hook != nullptr) {
    control.stage_hook(stage, temporary_path, control.context);
  }
}

std::size_t next_requested_write_size(
    std::size_t offset, std::size_t total,
    const AtomicWriteTestControl& control) {
  if (control.fail_after_bytes.has_value() &&
      offset >= *control.fail_after_bytes) {
    throw_write_error();
  }
  auto count = std::min(kWriteChunkBytes, total - offset);
  if (control.fail_after_bytes.has_value()) {
    count = std::min(count, *control.fail_after_bytes - offset);
  }
  if (count == 0U) {
    throw_write_error();
  }
  return count;
}

}  // namespace atomic_file_detail

namespace {

class TemporaryPathGuard {
 public:
  explicit TemporaryPathGuard(std::filesystem::path path)
      : path_(std::move(path)) {}
  TemporaryPathGuard(const TemporaryPathGuard&) = delete;
  TemporaryPathGuard& operator=(const TemporaryPathGuard&) = delete;
  ~TemporaryPathGuard() {
    if (active_) {
      std::error_code ignored;
      std::filesystem::remove(path_, ignored);
    }
  }
  void release() noexcept { active_ = false; }

 private:
  std::filesystem::path path_;
  bool active_{true};
};

std::filesystem::path publication_destination(
    const std::filesystem::path& requested) {
  std::error_code error;
  const auto status = std::filesystem::symlink_status(requested, error);
  if (!error && std::filesystem::is_symlink(status)) {
    auto target = std::filesystem::read_symlink(requested, error);
    if (error) {
      atomic_file_detail::throw_write_error();
    }
    if (target.is_relative()) {
      target = atomic_file_detail::destination_parent(requested) / target;
    }
    auto resolved = std::filesystem::weakly_canonical(target, error);
    if (error || resolved.filename().empty()) {
      atomic_file_detail::throw_write_error();
    }
    return resolved;
  }
  if (error && error != std::errc::no_such_file_or_directory) {
    atomic_file_detail::throw_write_error();
  }
  return requested;
}

bool file_bytes_equal(const std::filesystem::path& path,
                      std::span<const std::uint8_t> expected) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    return false;
  }
  std::array<std::uint8_t, 64U * 1024U> chunk{};
  std::size_t offset = 0U;
  while (offset < expected.size()) {
    const auto wanted = std::min(chunk.size(), expected.size() - offset);
    file.read(reinterpret_cast<char*>(chunk.data()),
              static_cast<std::streamsize>(wanted));
    const auto count = file.gcount();
    if (count <= 0 || static_cast<std::size_t>(count) != wanted ||
        !std::equal(chunk.begin(), chunk.begin() + count,
                    expected.begin() + static_cast<std::ptrdiff_t>(offset))) {
      return false;
    }
    offset += wanted;
  }
  char extra = 0;
  file.read(&extra, 1);
  return file.gcount() == 0 && file.eof();
}

void validate_temporary_file(const std::filesystem::path& path,
                             std::span<const std::uint8_t> expected,
                             bool semantic_reopen) {
  if (!file_bytes_equal(path, expected)) {
    atomic_file_detail::throw_write_error();
  }
  if (semantic_reopen) {
    (void)DocumentIo::read_file(path);
  }
}

void write_file_bytes_impl(const std::filesystem::path& path,
                           std::span<const std::uint8_t> bytes,
                           const AtomicWriteTestControl& control,
                           bool semantic_reopen) {
  const auto destination = publication_destination(path);
  auto temporary_path =
      atomic_file_detail::write_temporary_file(destination, bytes, control);
  TemporaryPathGuard cleanup(temporary_path);

  validate_temporary_file(temporary_path, bytes, semantic_reopen);
  atomic_file_detail::call_stage_hook(
      control, AtomicWriteStage::TemporaryValidated, temporary_path);

  atomic_file_detail::replace_destination(temporary_path, destination, control);
  cleanup.release();
  // Replacement is the commit point. A later directory-sync error cannot be
  // reported as a rolled-back save, so the durability upgrade is best-effort.
  atomic_file_detail::sync_parent_directory_best_effort(destination);
}

}  // namespace

void write_file_bytes(const std::filesystem::path& path,
                      std::span<const std::uint8_t> bytes) {
  write_file_bytes_impl(path, bytes, AtomicWriteTestControl{}, true);
}

void write_file_bytes_for_testing(const std::filesystem::path& path,
                                  std::span<const std::uint8_t> bytes,
                                  const AtomicWriteTestControl& control) {
  write_file_bytes_impl(path, bytes, control, true);
}

void write_sandboxed_result_bytes(const std::filesystem::path& path,
                                  std::span<const std::uint8_t> bytes) {
  write_file_bytes_impl(path, bytes, AtomicWriteTestControl{}, false);
}

}  // namespace patchy::psd
