#include "psd/psd_atomic_file_internal.hpp"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <system_error>
#include <utility>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

namespace patchy::psd::atomic_file_detail {
namespace {

class NativeFile {
 public:
  explicit NativeFile(HANDLE handle) : handle_(handle) {}
  NativeFile(const NativeFile&) = delete;
  NativeFile& operator=(const NativeFile&) = delete;
  ~NativeFile() {
    if (handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
    }
  }

  [[nodiscard]] HANDLE get() const noexcept { return handle_; }

  void close_checked() {
    const auto handle = handle_;
    handle_ = INVALID_HANDLE_VALUE;
    if (CloseHandle(handle) == FALSE) {
      throw_write_error();
    }
  }

 private:
  HANDLE handle_{INVALID_HANDLE_VALUE};
};

std::pair<std::filesystem::path, HANDLE> create_temporary_file(
    const std::filesystem::path& destination) {
  const auto process_id = static_cast<std::uint64_t>(GetCurrentProcessId());
  for (std::size_t attempt = 0; attempt < 256U; ++attempt) {
    auto candidate = next_temporary_candidate(destination, process_id);
    const auto handle = CreateFileW(candidate.c_str(), GENERIC_WRITE, 0, nullptr,
                                    CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
                                    nullptr);
    if (handle != INVALID_HANDLE_VALUE) {
      return {std::move(candidate), handle};
    }
    if (GetLastError() != ERROR_FILE_EXISTS &&
        GetLastError() != ERROR_ALREADY_EXISTS) {
      throw_write_error();
    }
  }
  throw_write_error();
}

std::filesystem::path unused_backup_path(
    const std::filesystem::path& destination) {
  const auto process_id = static_cast<std::uint64_t>(GetCurrentProcessId());
  for (std::size_t attempt = 0; attempt < 256U; ++attempt) {
    auto candidate = next_temporary_candidate(destination, process_id);
    const auto attributes = GetFileAttributesW(candidate.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      const auto error = GetLastError();
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
        return candidate;
      }
      throw_write_error();
    }
  }
  throw_write_error();
}

bool path_exists(const std::filesystem::path& path) noexcept {
  return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
}

struct FileIdentity {
  DWORD volume_serial_number{0U};
  DWORD file_index_high{0U};
  DWORD file_index_low{0U};

  friend bool operator==(const FileIdentity&, const FileIdentity&) = default;
};

std::optional<FileIdentity> file_identity(
    const std::filesystem::path& path) noexcept {
  const auto handle = CreateFileW(
      path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    return std::nullopt;
  }
  BY_HANDLE_FILE_INFORMATION information{};
  const auto succeeded = GetFileInformationByHandle(handle, &information);
  CloseHandle(handle);
  if (succeeded == FALSE) {
    return std::nullopt;
  }
  return FileIdentity{information.dwVolumeSerialNumber,
                      information.nFileIndexHigh,
                      information.nFileIndexLow};
}

bool restore_backup(const std::filesystem::path& backup,
                    const std::filesystem::path& destination) noexcept {
  if (!path_exists(backup)) {
    return path_exists(destination);
  }
  return MoveFileExW(backup.c_str(), destination.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
}

void write_all(NativeFile& file, std::span<const std::uint8_t> bytes,
               const AtomicWriteTestControl& control) {
  std::size_t offset = 0U;
  while (offset < bytes.size()) {
    const auto requested =
        next_requested_write_size(offset, bytes.size(), control);
    const auto system_count =
        std::min(requested, control.max_bytes_per_write);
    if (system_count == 0U) {
      throw_write_error();
    }
    DWORD written = 0U;
    if (WriteFile(file.get(), bytes.data() + offset,
                  static_cast<DWORD>(system_count), &written, nullptr) == FALSE ||
        written == 0U) {
      throw_write_error();
    }
    offset += written;
  }
}

void flush_file(NativeFile& file, const AtomicWriteTestControl& control) {
  if (control.fail_flush || FlushFileBuffers(file.get()) == FALSE) {
    throw_write_error();
  }
}

}  // namespace

std::filesystem::path write_temporary_file(
    const std::filesystem::path& destination,
    std::span<const std::uint8_t> bytes,
    const AtomicWriteTestControl& control) {
  auto [temporary_path, handle] = create_temporary_file(destination);
  try {
    NativeFile file(handle);
    call_stage_hook(control, AtomicWriteStage::TemporaryCreated,
                    temporary_path);
    write_all(file, bytes, control);
    call_stage_hook(control, AtomicWriteStage::BytesWritten, temporary_path);
    flush_file(file, control);
    file.close_checked();
    call_stage_hook(control, AtomicWriteStage::TemporaryFlushed,
                    temporary_path);
    return temporary_path;
  } catch (...) {
    std::error_code ignored;
    std::filesystem::remove(temporary_path, ignored);
    throw;
  }
}

void replace_destination(const std::filesystem::path& temporary,
                         const std::filesystem::path& destination,
                         const AtomicWriteTestControl& control) {
  const auto attributes = GetFileAttributesW(destination.c_str());
  if (attributes != INVALID_FILE_ATTRIBUTES) {
    const auto original_identity = file_identity(destination);
    if (!original_identity.has_value()) {
      throw_write_error();
    }
    const auto backup = unused_backup_path(destination);
    call_stage_hook(control, AtomicWriteStage::ReplacementBackupSelected,
                    backup);
    if (path_exists(backup)) {
      // ReplaceFileW may reuse an occupied backup path. Fail closed rather
      // than overwrite a file that this save did not create.
      throw_write_error();
    }
    if (ReplaceFileW(destination.c_str(), temporary.c_str(), backup.c_str(), 0U,
                     nullptr, nullptr) != FALSE) {
      DeleteFileW(backup.c_str());
      return;
    }
    const auto replace_error = GetLastError();
    const auto backup_identity = file_identity(backup);
    const auto backup_is_original =
        backup_identity.has_value() && *backup_identity == *original_identity;
    if (!path_exists(destination) && backup_is_original) {
      if (!restore_backup(backup, destination)) {
        throw_write_error();
      }
    } else if (path_exists(destination) && backup_is_original) {
      DeleteFileW(backup.c_str());
    }
    if (replace_error != ERROR_FILE_NOT_FOUND &&
        replace_error != ERROR_PATH_NOT_FOUND) {
      throw_write_error();
    }
  } else {
    const auto attribute_error = GetLastError();
    if (attribute_error != ERROR_FILE_NOT_FOUND &&
        attribute_error != ERROR_PATH_NOT_FOUND) {
      throw_write_error();
    }
  }

  if (path_exists(destination)) {
    // A concurrent creator won the absent-path race. Preserve it rather than
    // replacing a file that was not part of this save's pre-commit state.
    throw_write_error();
  }

  if (MoveFileExW(temporary.c_str(), destination.c_str(),
                  MOVEFILE_WRITE_THROUGH) != FALSE) {
    return;
  }
  throw_write_error();
}

void sync_parent_directory_best_effort(
    const std::filesystem::path&) noexcept {}

}  // namespace patchy::psd::atomic_file_detail
