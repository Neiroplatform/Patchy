#include "worker/native_job_internal.hpp"

#include "psd/psd_atomic_file_internal.hpp"

#include <algorithm>
#include <arpa/inet.h>
#include <array>
#include <cerrno>
#include <chrono>
#include <climits>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <filesystem>
#include <limits>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <span>
#include <string>
#include <string_view>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

#if defined(__APPLE__)
#include <libproc.h>
#include <sandbox.h>
#elif defined(__linux__)
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#endif

extern char** environ;

namespace patchy::worker {
namespace {

class FileDescriptor {
 public:
  FileDescriptor() = default;
  explicit FileDescriptor(int value) : value_(value) {}
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  FileDescriptor(FileDescriptor&& other) noexcept
      : value_(std::exchange(other.value_, -1)) {}
  FileDescriptor& operator=(FileDescriptor&& other) noexcept {
    if (this != &other) {
      reset();
      value_ = std::exchange(other.value_, -1);
    }
    return *this;
  }
  ~FileDescriptor() { reset(); }

  [[nodiscard]] int get() const noexcept { return value_; }
  [[nodiscard]] bool valid() const noexcept { return value_ >= 0; }
  int release() noexcept { return std::exchange(value_, -1); }
  void reset(int value = -1) noexcept {
    if (value_ >= 0) {
      (void)::close(value_);
    }
    value_ = value;
  }

 private:
  int value_{-1};
};

bool set_close_on_exec(int descriptor) {
  const auto flags = ::fcntl(descriptor, F_GETFD);
  return flags >= 0 && ::fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0;
}

bool set_nonblocking(int descriptor) {
  const auto flags = ::fcntl(descriptor, F_GETFL);
  return flags >= 0 && ::fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0;
}

class ScopedSigpipeBlock {
 public:
  ScopedSigpipeBlock() {
    (void)sigemptyset(&set_);
    (void)sigaddset(&set_, SIGPIPE);
    active_ = ::pthread_sigmask(SIG_BLOCK, &set_, &previous_) == 0;
  }
  ScopedSigpipeBlock(const ScopedSigpipeBlock&) = delete;
  ScopedSigpipeBlock& operator=(const ScopedSigpipeBlock&) = delete;
  ~ScopedSigpipeBlock() {
    if (!active_) {
      return;
    }
    sigset_t pending{};
    if (::sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE) == 1 &&
        sigismember(&previous_, SIGPIPE) == 0) {
      int consumed_signal = 0;
      (void)::sigwait(&set_, &consumed_signal);
    }
    (void)::pthread_sigmask(SIG_SETMASK, &previous_, nullptr);
  }

  [[nodiscard]] bool active() const noexcept { return active_; }

 private:
  sigset_t set_{};
  sigset_t previous_{};
  bool active_{false};
};

void close_unneeded_descriptors() {
#if defined(__linux__)
#if defined(__NR_close_range)
  if (::syscall(__NR_close_range, 5U, UINT_MAX, 0U) == 0) {
    return;
  }
#endif
#endif
  const auto open_max = ::sysconf(_SC_OPEN_MAX);
  const auto upper = open_max > 5 ? open_max : 1024;
  for (long descriptor = 5; descriptor < upper; ++descriptor) {
    (void)::close(static_cast<int>(descriptor));
  }
}

bool make_pipe(FileDescriptor& read_end, FileDescriptor& write_end) {
  std::array<int, 2> values{-1, -1};
  if (::pipe(values.data()) != 0) {
    return false;
  }
  read_end.reset(values[0]);
  write_end.reset(values[1]);
  return set_close_on_exec(read_end.get()) && set_close_on_exec(write_end.get());
}

bool set_limit(int resource, std::uint64_t value) {
  const auto bounded = static_cast<rlim_t>(
      std::min<std::uint64_t>(value, std::numeric_limits<rlim_t>::max()));
  const rlimit limit{bounded, bounded};
  return ::setrlimit(resource, &limit) == 0;
}

std::string probe_name(NativeJobProbe probe) {
  switch (probe) {
    case NativeJobProbe::None:
      return "none";
    case NativeJobProbe::Network:
      return "network";
    case NativeJobProbe::FileRead:
      return "file-read";
    case NativeJobProbe::FileWrite:
      return "file-write";
    case NativeJobProbe::Environment:
      return "environment";
    case NativeJobProbe::Process:
      return "process";
    case NativeJobProbe::Crash:
      return "crash";
    case NativeJobProbe::Timeout:
      return "timeout";
    case NativeJobProbe::Memory:
      return "memory";
  }
  return "invalid";
}

std::vector<std::string> worker_arguments(const NativeJobRequest& request) {
  return {
      request.worker_executable.string(),
      "--worker",
      "--input-handle=3",
      "--result-handle=4",
      "--max-input=" + std::to_string(request.limits.max_input_bytes),
      "--max-output=" + std::to_string(request.limits.max_output_bytes),
      "--memory=" +
          std::to_string(request.limits.max_address_space_bytes),
      "--cpu-seconds=" + std::to_string(request.limits.cpu_seconds),
      "--probe=" + probe_name(request.probe),
      "--probe-path=" + request.probe_path.string(),
  };
}

[[noreturn]] void launch_child(const NativeJobRequest& request,
                               int input_read, int input_write,
                               int result_read, int result_write) {
  (void)::setpgid(0, 0);
  if (::dup2(input_read, 3) < 0 || ::dup2(result_write, 4) < 0) {
    _exit(125);
  }
  close_unneeded_descriptors();
  for (const auto descriptor :
       {input_read, input_write, result_read, result_write}) {
    if (descriptor != 3 && descriptor != 4) {
      (void)::close(descriptor);
    }
  }

  if (!set_limit(RLIMIT_CORE, 0U)) {
    _exit(124);
  }
  if (!set_limit(RLIMIT_CPU, request.limits.cpu_seconds)) {
    _exit(122);
  }
  if (!set_limit(RLIMIT_NOFILE, 8U)) {
    _exit(121);
  }

  auto arguments = worker_arguments(request);
  std::vector<char*> raw_arguments;
  raw_arguments.reserve(arguments.size() + 1U);
  for (auto& argument : arguments) {
    raw_arguments.push_back(argument.data());
  }
  raw_arguments.push_back(nullptr);
  std::array<char*, 2> environment{
      const_cast<char*>("PATCHY_NATIVE_JOB_CHILD=1"), nullptr};
  ::execve(arguments.front().c_str(), raw_arguments.data(), environment.data());
  _exit(127);
}

bool valid_psd_header(std::span<const std::uint8_t> bytes) {
  return bytes.size() >= 6U && bytes[0] == '8' && bytes[1] == 'B' &&
         bytes[2] == 'P' && bytes[3] == 'S' && bytes[4] == 0U &&
         (bytes[5] == 1U || bytes[5] == 2U);
}

NativeJobResult collect_child(const NativeJobRequest& request,
                              int source_descriptor, std::uint64_t source_size,
                              pid_t child, FileDescriptor input_write,
                              FileDescriptor result_read) {
  NativeJobResult result;
  result.input_bytes = source_size;

  if (!set_nonblocking(input_write.get()) ||
      !set_nonblocking(result_read.get())) {
    (void)::kill(-child, SIGKILL);
    (void)::waitpid(child, nullptr, 0);
    result.detail = "could not configure supervisor pipes";
    return result;
  }

  const auto input_header = detail::make_input_header(source_size);
  std::array<std::uint8_t, 64U * 1024U> input_chunk{};
  std::size_t header_offset = 0U;
  std::size_t chunk_offset = 0U;
  std::size_t chunk_size = 0U;
  std::uint64_t source_offset = 0U;
  bool input_complete = request.probe != NativeJobProbe::None;
  if (input_complete) {
    input_write.reset();
  }

  std::vector<std::uint8_t> output;
  const auto result_limit = detail::kResultHeaderSize +
                            request.limits.max_output_bytes +
                            detail::kMaximumDetailBytes;
  const auto deadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(
                            request.limits.wall_milliseconds);
  bool output_eof = false;
  bool timed_out = false;
  bool resource_exceeded = false;
  bool oversized_result = false;
  int child_status = 0;
  bool child_reaped = false;

  while (!child_reaped || !output_eof) {
    if (std::chrono::steady_clock::now() >= deadline && !child_reaped) {
      timed_out = true;
      (void)::kill(-child, SIGKILL);
    }
#if defined(__APPLE__)
    if (!child_reaped && !resource_exceeded) {
      rusage_info_v4 usage{};
      if (::proc_pid_rusage(child, RUSAGE_INFO_V4,
                            reinterpret_cast<rusage_info_t*>(&usage)) == 0 &&
          usage.ri_resident_size > request.limits.max_address_space_bytes) {
        resource_exceeded = true;
        (void)::kill(-child, SIGKILL);
      }
    }
#endif

    std::array<pollfd, 2> descriptors{{
        {input_write.valid() ? input_write.get() : -1,
         static_cast<short>(input_write.valid() ? POLLOUT : 0), 0},
        {result_read.valid() ? result_read.get() : -1,
         static_cast<short>(result_read.valid() ? POLLIN | POLLHUP : 0), 0},
    }};
    (void)::poll(descriptors.data(), descriptors.size(), 20);

    if (input_write.valid() &&
        (descriptors[0].revents & (POLLOUT | POLLERR | POLLHUP)) != 0) {
      const std::uint8_t* data = nullptr;
      std::size_t remaining = 0U;
      if (header_offset < input_header.size()) {
        data = input_header.data() + header_offset;
        remaining = input_header.size() - header_offset;
      } else {
        if (chunk_offset == chunk_size && source_offset < source_size) {
          const auto wanted = static_cast<std::size_t>(
              std::min<std::uint64_t>(input_chunk.size(),
                                      source_size - source_offset));
          const auto count = ::read(source_descriptor, input_chunk.data(), wanted);
          if (count <= 0) {
            (void)::kill(-child, SIGKILL);
            input_write.reset();
            result.detail = "input changed or became unreadable";
            break;
          }
          chunk_size = static_cast<std::size_t>(count);
          chunk_offset = 0U;
        }
        if (source_offset < source_size) {
          data = input_chunk.data() + chunk_offset;
          remaining = chunk_size - chunk_offset;
        }
      }
      if (remaining > 0U) {
        const auto count = ::write(input_write.get(), data, remaining);
        if (count > 0) {
          const auto written = static_cast<std::size_t>(count);
          if (header_offset < input_header.size()) {
            header_offset += written;
          } else {
            chunk_offset += written;
            source_offset += written;
          }
        } else if (count < 0 && errno != EAGAIN && errno != EINTR) {
          input_write.reset();
        }
      }
      if (header_offset == input_header.size() && source_offset == source_size) {
        input_complete = true;
        input_write.reset();
      }
    }

    if (result_read.valid() &&
        (descriptors[1].revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
      std::array<std::uint8_t, 64U * 1024U> chunk{};
      while (true) {
        const auto count = ::read(result_read.get(), chunk.data(), chunk.size());
        if (count > 0) {
          if (output.size() + static_cast<std::size_t>(count) > result_limit) {
            oversized_result = true;
            (void)::kill(-child, SIGKILL);
          } else {
            output.insert(output.end(), chunk.begin(),
                          chunk.begin() + count);
          }
          continue;
        }
        if (count == 0) {
          output_eof = true;
          result_read.reset();
        }
        break;
      }
    }

    if (!child_reaped) {
      const auto waited = ::waitpid(child, &child_status, WNOHANG);
      if (waited == child) {
        child_reaped = true;
      }
    }
    if (child_reaped && !result_read.valid()) {
      output_eof = true;
    }
  }

  if (!child_reaped) {
    (void)::kill(-child, SIGKILL);
    (void)::waitpid(child, &child_status, 0);
  }
  result.child_status = child_status;

  if (timed_out) {
    result.outcome = NativeJobOutcome::TimedOut;
    result.detail = "worker exceeded wall deadline";
    return result;
  }
  if (resource_exceeded) {
    result.outcome = NativeJobOutcome::ResourceLimit;
    result.detail = "worker exceeded resident-memory limit";
    return result;
  }
  if (oversized_result) {
    result.outcome = NativeJobOutcome::Rejected;
    result.detail = "worker result exceeded supervisor limit";
    return result;
  }
  if (!input_complete && request.probe == NativeJobProbe::None) {
    result.outcome = NativeJobOutcome::Rejected;
    if (result.detail.empty()) {
      result.detail = "input stream did not complete";
    }
    return result;
  }

  detail::WireStatus wire_status{};
  std::span<const std::uint8_t> payload;
  std::string wire_detail;
  if (!detail::parse_result_frame(output, wire_status, payload, wire_detail)) {
    if (WIFSIGNALED(child_status)) {
      const auto signal = WTERMSIG(child_status);
      result.outcome = request.probe == NativeJobProbe::Memory
                           ? NativeJobOutcome::ResourceLimit
                           : NativeJobOutcome::Crashed;
      result.detail = "worker terminated by signal " + std::to_string(signal);
    } else {
      result.outcome = NativeJobOutcome::Rejected;
      result.detail = "worker returned no valid terminal frame (exit " +
                      std::to_string(WIFEXITED(child_status)
                                         ? WEXITSTATUS(child_status)
                                         : -1) +
                      ", bytes " + std::to_string(output.size()) + ")";
    }
    return result;
  }

  result.detail = wire_detail;
  if (const auto separator = wire_detail.find(':');
      separator != std::string::npos) {
    result.sandbox = wire_detail.substr(0U, separator);
  }
  if (wire_status == detail::WireStatus::SandboxUnavailable) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    return result;
  }
  if (request.probe != NativeJobProbe::None) {
    result.outcome = wire_status == detail::WireStatus::ProbePassed
                         ? NativeJobOutcome::Success
                         : NativeJobOutcome::Rejected;
    return result;
  }
  if (wire_status != detail::WireStatus::Success ||
      payload.size() > request.limits.max_output_bytes ||
      !valid_psd_header(payload)) {
    result.outcome = NativeJobOutcome::Rejected;
    return result;
  }

  try {
    patchy::psd::write_sandboxed_result_bytes(request.output_path, payload);
  } catch (...) {
    result.outcome = NativeJobOutcome::InternalError;
    result.detail = "atomic result publication failed";
    return result;
  }
  result.output_bytes = payload.size();
  result.outcome = NativeJobOutcome::Success;
  return result;
}

}  // namespace

NativeJobResult run_native_job(const NativeJobRequest& request) {
  NativeJobResult result;
  if (request.worker_executable.empty() ||
      request.limits.max_input_bytes == 0U ||
      request.limits.max_output_bytes == 0U ||
      request.limits.max_address_space_bytes < 64U * 1024U * 1024U ||
      request.limits.cpu_seconds == 0U ||
      request.limits.wall_milliseconds == 0U) {
    result.detail = "invalid native job request";
    return result;
  }

  ScopedSigpipeBlock sigpipe_block;
  if (!sigpipe_block.active()) {
    result.detail = "could not isolate supervisor pipe signals";
    return result;
  }

  FileDescriptor source;
  std::uint64_t source_size = 0U;
  if (request.probe == NativeJobProbe::None) {
    source.reset(::open(request.input_path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
    struct stat metadata {};
    if (!source.valid() || ::fstat(source.get(), &metadata) != 0 ||
        !S_ISREG(metadata.st_mode) || metadata.st_size <= 0) {
      result.outcome = NativeJobOutcome::Rejected;
      result.detail = "input must be a non-empty regular file";
      return result;
    }
    source_size = static_cast<std::uint64_t>(metadata.st_size);
    if (source_size > request.limits.max_input_bytes) {
      result.outcome = NativeJobOutcome::Rejected;
      result.detail = "input exceeds supervisor limit";
      return result;
    }
  }

  FileDescriptor input_read;
  FileDescriptor input_write;
  FileDescriptor result_read;
  FileDescriptor result_write;
  if (!make_pipe(input_read, input_write) ||
      !make_pipe(result_read, result_write)) {
    result.detail = "could not create supervisor pipes";
    return result;
  }

  const auto child = ::fork();
  if (child < 0) {
    result.detail = "could not create disposable worker";
    return result;
  }
  if (child == 0) {
    launch_child(request, input_read.get(), input_write.get(), result_read.get(),
                 result_write.get());
  }

  (void)::setpgid(child, child);
  input_read.reset();
  result_write.reset();
  return collect_child(request, source.get(), source_size, child,
                       std::move(input_write), std::move(result_read));
}

}  // namespace patchy::worker

namespace patchy::worker::detail {
namespace {

#if defined(__linux__)

bool install_landlock(std::string& error) {
#if defined(__NR_landlock_create_ruleset) && defined(__NR_landlock_restrict_self)
  const auto abi = static_cast<int>(::syscall(
      __NR_landlock_create_ruleset, nullptr, 0U,
      LANDLOCK_CREATE_RULESET_VERSION));
  if (abi < 1) {
    error = "Landlock is unavailable";
    return false;
  }
  std::uint64_t handled = LANDLOCK_ACCESS_FS_EXECUTE |
                          LANDLOCK_ACCESS_FS_WRITE_FILE |
                          LANDLOCK_ACCESS_FS_READ_FILE |
                          LANDLOCK_ACCESS_FS_READ_DIR |
                          LANDLOCK_ACCESS_FS_REMOVE_DIR |
                          LANDLOCK_ACCESS_FS_REMOVE_FILE |
                          LANDLOCK_ACCESS_FS_MAKE_CHAR |
                          LANDLOCK_ACCESS_FS_MAKE_DIR |
                          LANDLOCK_ACCESS_FS_MAKE_REG |
                          LANDLOCK_ACCESS_FS_MAKE_SOCK |
                          LANDLOCK_ACCESS_FS_MAKE_FIFO |
                          LANDLOCK_ACCESS_FS_MAKE_BLOCK |
                          LANDLOCK_ACCESS_FS_MAKE_SYM;
#ifdef LANDLOCK_ACCESS_FS_REFER
  if (abi >= 2) {
    handled |= LANDLOCK_ACCESS_FS_REFER;
  }
#endif
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
  if (abi >= 3) {
    handled |= LANDLOCK_ACCESS_FS_TRUNCATE;
  }
#endif
  landlock_ruleset_attr ruleset{};
  ruleset.handled_access_fs = handled;
  const auto ruleset_fd = static_cast<int>(::syscall(
      __NR_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0U));
  if (ruleset_fd < 0) {
    error = "Landlock ruleset creation failed";
    return false;
  }
  if (::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      ::syscall(__NR_landlock_restrict_self, ruleset_fd, 0U) != 0) {
    (void)::close(ruleset_fd);
    error = "Landlock restriction failed";
    return false;
  }
  (void)::close(ruleset_fd);
  return true;
#else
  error = "Landlock syscall definitions are unavailable";
  return false;
#endif
}

bool install_seccomp(std::string& error) {
  constexpr auto deny = SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA);
  constexpr auto absent = SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA);
  std::vector<sock_filter> filter;
  filter.push_back(BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                            offsetof(seccomp_data, arch)));
#if defined(__x86_64__)
  filter.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0));
#elif defined(__aarch64__)
  filter.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0));
#else
  error = "unsupported seccomp architecture";
  return false;
#endif
  filter.push_back(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
  filter.push_back(BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                            offsetof(seccomp_data, nr)));

  const auto deny_syscall = [&](int number, std::uint32_t action = deny) {
    filter.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K,
                              static_cast<std::uint32_t>(number), 0, 1));
    filter.push_back(BPF_STMT(BPF_RET | BPF_K, action));
  };
#ifdef __NR_socket
  deny_syscall(__NR_socket);
#endif
#ifdef __NR_socketpair
  deny_syscall(__NR_socketpair);
#endif
#ifdef __NR_connect
  deny_syscall(__NR_connect);
#endif
#ifdef __NR_bind
  deny_syscall(__NR_bind);
#endif
#ifdef __NR_listen
  deny_syscall(__NR_listen);
#endif
#ifdef __NR_accept
  deny_syscall(__NR_accept);
#endif
#ifdef __NR_accept4
  deny_syscall(__NR_accept4);
#endif
#ifdef __NR_sendto
  deny_syscall(__NR_sendto);
#endif
#ifdef __NR_sendmsg
  deny_syscall(__NR_sendmsg);
#endif
#ifdef __NR_recvfrom
  deny_syscall(__NR_recvfrom);
#endif
#ifdef __NR_recvmsg
  deny_syscall(__NR_recvmsg);
#endif
#ifdef __NR_execve
  deny_syscall(__NR_execve);
#endif
#ifdef __NR_execveat
  deny_syscall(__NR_execveat);
#endif
#ifdef __NR_fork
  deny_syscall(__NR_fork);
#endif
#ifdef __NR_vfork
  deny_syscall(__NR_vfork);
#endif
#ifdef __NR_clone3
  deny_syscall(__NR_clone3, absent);
#endif
#ifdef __NR_ptrace
  deny_syscall(__NR_ptrace);
#endif
#ifdef __NR_mount
  deny_syscall(__NR_mount);
#endif
#ifdef __NR_umount2
  deny_syscall(__NR_umount2);
#endif
#ifdef __NR_unshare
  deny_syscall(__NR_unshare);
#endif
#ifdef __NR_setns
  deny_syscall(__NR_setns);
#endif
#ifdef __NR_clone
  filter.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 3));
  filter.push_back(BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                            offsetof(seccomp_data, args[0])));
  filter.push_back(BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0));
  filter.push_back(BPF_STMT(BPF_RET | BPF_K, deny));
#endif
  filter.push_back(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

  sock_fprog program{static_cast<unsigned short>(filter.size()), filter.data()};
  if (::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      ::prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) {
    error = "seccomp installation failed";
    return false;
  }
  return true;
}

#endif

}  // namespace

bool enter_platform_sandbox(const WorkerArguments& arguments,
                            std::string& sandbox_name, std::string& error) {
  if (!set_limit(RLIMIT_CORE, 0U) ||
#if defined(__linux__)
      !set_limit(RLIMIT_AS, arguments.limits.max_address_space_bytes) ||
#endif
      !set_limit(RLIMIT_CPU, arguments.limits.cpu_seconds) ||
      !set_limit(RLIMIT_NOFILE, 8U)) {
    error = "resource limit installation failed";
    return false;
  }

#if defined(__APPLE__)
  constexpr std::string_view profile = R"SANDBOX(
(version 1)
(deny default)
(allow process-info*)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
(allow ipc-posix-shm)
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib"))
)SANDBOX";
  char* sandbox_message = nullptr;
  if (::sandbox_init(profile.data(), 0U, &sandbox_message) != 0) {
    error = sandbox_message == nullptr ? "Seatbelt installation failed"
                                       : std::string(sandbox_message);
    if (sandbox_message != nullptr) {
      ::sandbox_free_error(sandbox_message);
    }
    return false;
  }
  sandbox_name = "macos-seatbelt-rss-cpu";
  return true;
#elif defined(__linux__)
  if (!install_landlock(error) || !install_seccomp(error)) {
    return false;
  }
  sandbox_name = "linux-landlock-seccomp-rlimit";
  return true;
#else
  (void)arguments;
  error = "unsupported POSIX sandbox";
  return false;
#endif
}

bool run_platform_probe(const WorkerArguments& arguments, std::string& detail) {
  switch (arguments.probe) {
    case NativeJobProbe::None:
      detail = "no probe requested";
      return false;
    case NativeJobProbe::Network: {
      const auto descriptor = ::socket(AF_INET, SOCK_STREAM, 0);
      if (descriptor < 0) {
        detail = "network socket creation denied";
        return errno == EACCES || errno == EPERM;
      }
      sockaddr_in destination{};
      destination.sin_family = AF_INET;
      destination.sin_port = htons(9U);
      destination.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      const auto connected = ::connect(
          descriptor, reinterpret_cast<const sockaddr*>(&destination),
          sizeof(destination));
      const auto connect_error = errno;
      (void)::close(descriptor);
      if (connected == 0) {
        detail = "network connect unexpectedly succeeded";
        return false;
      }
      detail = "network connect denied";
      return connect_error == EACCES || connect_error == EPERM;
    }
    case NativeJobProbe::FileRead: {
      const auto descriptor = ::open(arguments.probe_path.c_str(), O_RDONLY);
      if (descriptor >= 0) {
        (void)::close(descriptor);
        detail = "unrelated file read unexpectedly succeeded";
        return false;
      }
      detail = "unrelated file read denied";
      return errno == EACCES || errno == EPERM;
    }
    case NativeJobProbe::FileWrite: {
      const auto descriptor = ::open(arguments.probe_path.c_str(),
                                     O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (descriptor >= 0) {
        (void)::close(descriptor);
        detail = "unrelated file write unexpectedly succeeded";
        return false;
      }
      detail = "unrelated file write denied";
      return errno == EACCES || errno == EPERM;
    }
    case NativeJobProbe::Environment:
      if (std::getenv("PATCHY_NATIVE_JOB_SECRET_PROBE") != nullptr ||
          (environ != nullptr && environ[0] != nullptr)) {
        detail = "environment was not empty";
        return false;
      }
      detail = "environment empty";
      return true;
    case NativeJobProbe::Process: {
      const auto child = ::fork();
      if (child == 0) {
        _exit(91);
      }
      if (child > 0) {
        (void)::waitpid(child, nullptr, 0);
        detail = "child process creation unexpectedly succeeded";
        return false;
      }
      detail = "child process creation denied";
      return errno == EACCES || errno == EPERM || errno == ENOSYS;
    }
    case NativeJobProbe::Crash:
      std::raise(SIGSEGV);
      detail = "crash probe unexpectedly survived";
      return false;
    case NativeJobProbe::Timeout:
      while (true) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
    case NativeJobProbe::Memory: {
      try {
        std::vector<std::uint8_t> bytes(
            static_cast<std::size_t>(arguments.limits.max_address_space_bytes),
            0xA5U);
        for (std::size_t offset = 0U; offset < bytes.size(); offset += 4096U) {
          bytes[offset] ^= 0xFFU;
        }
      } catch (const std::bad_alloc&) {
        detail = "address-space limit enforced";
        return true;
      }
      detail = "address-space limit was not enforced";
      return false;
    }
  }
  detail = "unknown probe";
  return false;
}

}  // namespace patchy::worker::detail
