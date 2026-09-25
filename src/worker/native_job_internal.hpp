#pragma once

#include "worker/native_job.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace patchy::worker::detail {

constexpr std::uint32_t kProtocolVersion = 1U;
constexpr std::size_t kInputHeaderSize = 16U;
constexpr std::size_t kResultHeaderSize = 28U;
constexpr std::size_t kMaximumDetailBytes = 512U;

enum class WireStatus : std::uint32_t {
  Success = 0U,
  Rejected = 1U,
  ProbePassed = 2U,
  SandboxUnavailable = 3U,
  InternalError = 4U,
};

struct WorkerArguments {
  std::intptr_t input_handle{-1};
  std::intptr_t result_handle{-1};
  NativeJobLimits limits{};
  NativeJobProbe probe{NativeJobProbe::None};
  std::string probe_path;
};

[[nodiscard]] std::vector<std::uint8_t> make_input_header(
    std::uint64_t input_size);
[[nodiscard]] bool parse_input_header(std::span<const std::uint8_t> header,
                                      std::uint64_t& input_size);
[[nodiscard]] std::vector<std::uint8_t> make_result_frame(
    WireStatus status, std::span<const std::uint8_t> payload,
    std::string_view detail);
[[nodiscard]] bool parse_result_frame(
    std::span<const std::uint8_t> frame, WireStatus& status,
    std::span<const std::uint8_t>& payload, std::string& detail);

[[nodiscard]] bool enter_platform_sandbox(const WorkerArguments& arguments,
                                           std::string& sandbox_name,
                                           std::string& error);
[[nodiscard]] bool run_platform_probe(const WorkerArguments& arguments,
                                      std::string& detail);

[[nodiscard]] bool write_all_handle(std::intptr_t handle,
                                    std::span<const std::uint8_t> bytes);
[[nodiscard]] bool read_exact_handle(std::intptr_t handle,
                                     std::span<std::uint8_t> bytes);

}  // namespace patchy::worker::detail
