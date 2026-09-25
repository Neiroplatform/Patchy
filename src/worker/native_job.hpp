#pragma once

#include <cstdint>
#include <filesystem>
#include <string>

namespace patchy::worker {

enum class NativeJobOutcome : std::uint8_t {
  Success = 0,
  Rejected = 1,
  SandboxUnavailable = 2,
  TimedOut = 3,
  Crashed = 4,
  ResourceLimit = 5,
  InternalError = 6,
};

enum class NativeJobProbe : std::uint8_t {
  None = 0,
  Network = 1,
  FileRead = 2,
  FileWrite = 3,
  Environment = 4,
  Process = 5,
  Crash = 6,
  Timeout = 7,
  Memory = 8,
};

struct NativeJobLimits {
  std::uint64_t max_input_bytes{64U * 1024U * 1024U};
  std::uint64_t max_output_bytes{128U * 1024U * 1024U};
  std::uint64_t max_address_space_bytes{512U * 1024U * 1024U};
  std::uint32_t cpu_seconds{10U};
  std::uint32_t wall_milliseconds{15000U};
};

struct NativeJobRequest {
  std::filesystem::path worker_executable;
  std::filesystem::path input_path;
  std::filesystem::path output_path;
  NativeJobLimits limits{};
  NativeJobProbe probe{NativeJobProbe::None};
  std::filesystem::path probe_path;
};

struct NativeJobResult {
  NativeJobOutcome outcome{NativeJobOutcome::InternalError};
  std::string detail;
  std::string sandbox;
  std::uint64_t input_bytes{0U};
  std::uint64_t output_bytes{0U};
  int child_status{0};
};

[[nodiscard]] NativeJobResult run_native_job(const NativeJobRequest& request);

// Internal executable entry point. It is public only so the tiny CLI target and
// focused tests use exactly the same parser and worker implementation.
int native_job_worker_main(int argc, char** argv);

}  // namespace patchy::worker
