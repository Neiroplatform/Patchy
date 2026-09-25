#pragma once

// Private atomic-publication fault seam shared only by the PSD implementation
// and its core tests. This is not part of Patchy's public document I/O API.

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <span>

namespace patchy::psd {

enum class AtomicWriteStage {
  TemporaryCreated,
  BytesWritten,
  TemporaryFlushed,
  TemporaryValidated,
  ReplacementBackupSelected,
};

using AtomicWriteStageHook = void (*)(AtomicWriteStage stage,
                                      const std::filesystem::path& temporary_path,
                                      void* context);

// Production callers have no injected limits or callbacks. The byte cap makes
// the native write return less than the transaction's requested chunk and
// exercises the real short-write loop; injected failures occur before the
// atomic replacement and therefore must never touch the prior destination.
struct AtomicWriteTestControl {
  std::size_t max_bytes_per_write{static_cast<std::size_t>(-1)};
  std::optional<std::size_t> fail_after_bytes;
  bool fail_flush{false};
  AtomicWriteStageHook stage_hook{nullptr};
  void* context{nullptr};
};

void write_file_bytes_for_testing(const std::filesystem::path& path,
                                  std::span<const std::uint8_t> bytes,
                                  const AtomicWriteTestControl& control);

// Native-job results have already completed a semantic reopen inside the
// sandbox. The privileged supervisor must not parse untrusted child output, so
// it uses the same durable same-directory publication transaction with exact
// byte readback but without invoking the PSD parser again.
void write_sandboxed_result_bytes(const std::filesystem::path& path,
                                  std::span<const std::uint8_t> bytes);

namespace atomic_file_detail {

constexpr std::size_t kWriteChunkBytes = 1024U * 1024U;

[[noreturn]] void throw_write_error();
std::filesystem::path destination_parent(const std::filesystem::path& path);
std::filesystem::path next_temporary_candidate(
    const std::filesystem::path& destination, std::uint64_t process_id);
void call_stage_hook(const AtomicWriteTestControl& control,
                     AtomicWriteStage stage,
                     const std::filesystem::path& temporary_path);
std::size_t next_requested_write_size(
    std::size_t offset, std::size_t total,
    const AtomicWriteTestControl& control);
std::filesystem::path write_temporary_file(
    const std::filesystem::path& destination,
    std::span<const std::uint8_t> bytes,
    const AtomicWriteTestControl& control);
void replace_destination(const std::filesystem::path& temporary,
                         const std::filesystem::path& destination,
                         const AtomicWriteTestControl& control);
void sync_parent_directory_best_effort(
    const std::filesystem::path& destination) noexcept;

}  // namespace atomic_file_detail

}  // namespace patchy::psd
