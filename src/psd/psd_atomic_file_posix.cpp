#include "psd/psd_atomic_file_internal.hpp"

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <filesystem>
#include <system_error>
#include <utility>

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

namespace patchy::psd::atomic_file_detail {
namespace {

class NativeFile {
 public:
  explicit NativeFile(int descriptor) : descriptor_(descriptor) {}
  NativeFile(const NativeFile&) = delete;
  NativeFile& operator=(const NativeFile&) = delete;
  ~NativeFile() {
    if (descriptor_ >= 0) {
      ::close(descriptor_);
    }
  }

  [[nodiscard]] int get() const noexcept { return descriptor_; }

  void close_checked() {
    const auto descriptor = descriptor_;
    descriptor_ = -1;
    if (::close(descriptor) != 0) {
      throw_write_error();
    }
  }

 private:
  int descriptor_{-1};
};

int exclusive_create_flags() noexcept {
  int flags = O_WRONLY | O_CREAT | O_EXCL;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  return flags;
}

std::pair<std::filesystem::path, int> create_temporary_file(
    const std::filesystem::path& destination) {
  const auto process_id = static_cast<std::uint64_t>(::getpid());
  for (std::size_t attempt = 0; attempt < 256U; ++attempt) {
    auto candidate = next_temporary_candidate(destination, process_id);
    const auto descriptor = ::open(candidate.c_str(), exclusive_create_flags(),
                                   S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP |
                                       S_IROTH | S_IWOTH);
    if (descriptor >= 0) {
      struct stat destination_status {};
      if (::stat(destination.c_str(), &destination_status) == 0) {
        if (::fchmod(descriptor, destination_status.st_mode & 07777) != 0) {
          ::close(descriptor);
          std::error_code ignored;
          std::filesystem::remove(candidate, ignored);
          throw_write_error();
        }
      } else if (errno != ENOENT) {
        ::close(descriptor);
        std::error_code ignored;
        std::filesystem::remove(candidate, ignored);
        throw_write_error();
      }
      return {std::move(candidate), descriptor};
    }
    if (errno != EEXIST) {
      throw_write_error();
    }
  }
  throw_write_error();
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
    const auto written =
        ::write(file.get(), bytes.data() + offset, system_count);
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written <= 0) {
      throw_write_error();
    }
    offset += static_cast<std::size_t>(written);
  }
}

void flush_file(NativeFile& file, const AtomicWriteTestControl& control) {
  if (control.fail_flush) {
    throw_write_error();
  }
#if defined(__APPLE__) && defined(F_FULLFSYNC)
  while (::fcntl(file.get(), F_FULLFSYNC) != 0) {
    if (errno == EINVAL || errno == ENOTSUP) {
      break;
    }
    if (errno != EINTR) {
      throw_write_error();
    }
  }
#endif
  while (::fsync(file.get()) != 0) {
    if (errno != EINTR) {
      throw_write_error();
    }
  }
}

}  // namespace

std::filesystem::path write_temporary_file(
    const std::filesystem::path& destination,
    std::span<const std::uint8_t> bytes,
    const AtomicWriteTestControl& control) {
  auto [temporary_path, descriptor] = create_temporary_file(destination);
  try {
    NativeFile file(descriptor);
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
                         const AtomicWriteTestControl&) {
  if (::rename(temporary.c_str(), destination.c_str()) != 0) {
    throw_write_error();
  }
}

void sync_parent_directory_best_effort(
    const std::filesystem::path& destination) noexcept {
  auto flags = O_RDONLY;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
#ifdef O_DIRECTORY
  flags |= O_DIRECTORY;
#endif
  const auto parent = destination_parent(destination);
  const auto descriptor = ::open(parent.c_str(), flags);
  if (descriptor >= 0) {
    while (::fsync(descriptor) != 0 && errno == EINTR) {
    }
    ::close(descriptor);
  }
}

}  // namespace patchy::psd::atomic_file_detail
