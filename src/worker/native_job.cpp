#include "worker/native_job_internal.hpp"

#include "engine/host_protocol.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <unistd.h>
#endif

#if !defined(_WIN32)
extern char** environ;
#endif

namespace patchy::worker::detail {
namespace {

constexpr std::array<std::uint8_t, 4> kInputMagic{'P', 'N', 'J', 'I'};
constexpr std::array<std::uint8_t, 4> kResultMagic{'P', 'N', 'J', 'R'};

void append_u32(std::vector<std::uint8_t>& bytes, std::uint32_t value) {
  for (unsigned int shift = 0U; shift < 32U; shift += 8U) {
    bytes.push_back(static_cast<std::uint8_t>(value >> shift));
  }
}

void append_u64(std::vector<std::uint8_t>& bytes, std::uint64_t value) {
  for (unsigned int shift = 0U; shift < 64U; shift += 8U) {
    bytes.push_back(static_cast<std::uint8_t>(value >> shift));
  }
}

bool read_u32(std::span<const std::uint8_t> bytes, std::size_t offset,
              std::uint32_t& value) {
  if (offset > bytes.size() || bytes.size() - offset < 4U) {
    return false;
  }
  value = 0U;
  for (unsigned int index = 0U; index < 4U; ++index) {
    value |= static_cast<std::uint32_t>(bytes[offset + index]) << (index * 8U);
  }
  return true;
}

bool read_u64(std::span<const std::uint8_t> bytes, std::size_t offset,
              std::uint64_t& value) {
  if (offset > bytes.size() || bytes.size() - offset < 8U) {
    return false;
  }
  value = 0U;
  for (unsigned int index = 0U; index < 8U; ++index) {
    value |= static_cast<std::uint64_t>(bytes[offset + index]) << (index * 8U);
  }
  return true;
}

bool parse_unsigned(std::string_view text, std::uint64_t& value) {
  if (text.empty()) {
    return false;
  }
  const auto result =
      std::from_chars(text.data(), text.data() + text.size(), value);
  return result.ec == std::errc{} && result.ptr == text.data() + text.size();
}

bool parse_probe(std::string_view text, NativeJobProbe& probe) {
  constexpr std::array<std::pair<std::string_view, NativeJobProbe>, 9> values{{
      {"none", NativeJobProbe::None},
      {"network", NativeJobProbe::Network},
      {"file-read", NativeJobProbe::FileRead},
      {"file-write", NativeJobProbe::FileWrite},
      {"environment", NativeJobProbe::Environment},
      {"process", NativeJobProbe::Process},
      {"crash", NativeJobProbe::Crash},
      {"timeout", NativeJobProbe::Timeout},
      {"memory", NativeJobProbe::Memory},
  }};
  for (const auto& [name, value] : values) {
    if (name == text) {
      probe = value;
      return true;
    }
  }
  return false;
}

bool parse_worker_arguments(int argc, char** argv, WorkerArguments& parsed) {
  bool saw_worker = false;
  bool saw_input = false;
  bool saw_result = false;
  for (int index = 1; index < argc; ++index) {
    const std::string_view argument(argv[index]);
    if (argument == "--worker") {
      saw_worker = true;
      continue;
    }
    const auto assign_u64 = [&](std::string_view prefix,
                                std::uint64_t& destination) {
      if (!argument.starts_with(prefix)) {
        return false;
      }
      return parse_unsigned(argument.substr(prefix.size()), destination);
    };
    if (argument.starts_with("--input-handle=")) {
      std::uint64_t value = 0U;
      saw_input = parse_unsigned(argument.substr(15U), value) &&
                  value <= static_cast<std::uint64_t>(
                               std::numeric_limits<std::intptr_t>::max());
      if (saw_input) {
        parsed.input_handle = static_cast<std::intptr_t>(value);
      }
    } else if (argument.starts_with("--result-handle=")) {
      std::uint64_t value = 0U;
      saw_result = parse_unsigned(argument.substr(16U), value) &&
                   value <= static_cast<std::uint64_t>(
                                std::numeric_limits<std::intptr_t>::max());
      if (saw_result) {
        parsed.result_handle = static_cast<std::intptr_t>(value);
      }
    } else if (argument.starts_with("--max-input=")) {
      if (!assign_u64("--max-input=", parsed.limits.max_input_bytes)) {
        return false;
      }
    } else if (argument.starts_with("--max-output=")) {
      if (!assign_u64("--max-output=", parsed.limits.max_output_bytes)) {
        return false;
      }
    } else if (argument.starts_with("--memory=")) {
      if (!assign_u64("--memory=", parsed.limits.max_address_space_bytes)) {
        return false;
      }
    } else if (argument.starts_with("--cpu-seconds=")) {
      std::uint64_t value = 0U;
      if (!assign_u64("--cpu-seconds=", value) ||
          value > std::numeric_limits<std::uint32_t>::max()) {
        return false;
      }
      parsed.limits.cpu_seconds = static_cast<std::uint32_t>(value);
    } else if (argument.starts_with("--probe=")) {
      if (!parse_probe(argument.substr(8U), parsed.probe)) {
        return false;
      }
    } else if (argument.starts_with("--probe-path=")) {
      parsed.probe_path = std::string(argument.substr(13U));
    } else {
      return false;
    }
  }
  return saw_worker && saw_input && saw_result && parsed.input_handle >= 0 &&
         parsed.result_handle >= 0 && parsed.limits.max_input_bytes > 0U &&
         parsed.limits.max_output_bytes > 0U &&
         parsed.limits.max_output_bytes <=
             std::numeric_limits<std::size_t>::max() - kResultHeaderSize -
                 kMaximumDetailBytes &&
         parsed.limits.max_address_space_bytes >= 64U * 1024U * 1024U &&
         parsed.limits.max_address_space_bytes <=
             std::numeric_limits<std::size_t>::max() &&
         parsed.limits.cpu_seconds > 0U;
}

void send_result(std::intptr_t handle, WireStatus status,
                 std::span<const std::uint8_t> payload,
                 std::string_view detail) {
  const auto frame = make_result_frame(status, payload, detail);
  (void)write_all_handle(handle, frame);
}

struct RuntimeDeleter {
  void operator()(patchy_engine_runtime* value) const noexcept {
    patchy_engine_runtime_destroy(value);
  }
};

struct SessionDeleter {
  void operator()(patchy_engine_session* value) const noexcept {
    patchy_engine_session_destroy(value);
  }
};

bool run_engine_job(std::span<const std::uint8_t> input,
                    std::uint64_t max_output,
                    std::vector<std::uint8_t>& output, std::string& detail) {
  if (input.size() < 6U || input[0] != '8' || input[1] != 'B' ||
      input[2] != 'P' || input[3] != 'S' || input[4] != 0U ||
      (input[5] != 1U && input[5] != 2U)) {
    detail = "input is not a supported PSD/PSB stream";
    return false;
  }

  patchy_engine_error error{};
  std::unique_ptr<patchy_engine_runtime, RuntimeDeleter> runtime(
      patchy_engine_runtime_create(PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error));
  if (!runtime) {
    detail = "engine runtime creation failed";
    return false;
  }
  std::unique_ptr<patchy_engine_session, SessionDeleter> session(
      patchy_engine_session_open_psd(runtime.get(), input.data(), input.size(),
                                     &error));
  if (!session) {
    detail = "engine rejected input";
    return false;
  }

  patchy_engine_document_projection document{};
  document.struct_size = sizeof(document);
  if (patchy_engine_session_document(session.get(), &document, &error) != 1 ||
      document.width <= 0 || document.height <= 0) {
    detail = "document projection failed";
    return false;
  }

  patchy_engine_buffer rendered{};
  patchy_engine_event event{};
  if (patchy_engine_session_render_region(session.get(), 0, 0, 1, 1,
                                          &rendered, &event, &error) != 1 ||
      rendered.size != 4U) {
    patchy_engine_buffer_release(&rendered);
    detail = "bounded render failed";
    return false;
  }
  patchy_engine_buffer_release(&rendered);

  patchy_engine_buffer saved{};
  const auto large_document = static_cast<std::uint8_t>(input[5] == 2U);
  if (patchy_engine_session_save_psd_as(session.get(), large_document, &saved,
                                        &event, &error) != 1) {
    detail = "layered save failed";
    return false;
  }
  if (saved.size == 0U || saved.size > max_output) {
    patchy_engine_buffer_release(&saved);
    detail = "saved output exceeds result limit";
    return false;
  }

  std::unique_ptr<patchy_engine_session, SessionDeleter> reopened(
      patchy_engine_session_open_psd(runtime.get(), saved.data, saved.size,
                                     &error));
  patchy_engine_document_projection reopened_document{};
  reopened_document.struct_size = sizeof(reopened_document);
  if (!reopened ||
      patchy_engine_session_document(reopened.get(), &reopened_document,
                                     &error) != 1 ||
      reopened_document.width != document.width ||
      reopened_document.height != document.height) {
    patchy_engine_buffer_release(&saved);
    detail = "saved output failed semantic reopen";
    return false;
  }

  output.assign(saved.data, saved.data + saved.size);
  patchy_engine_buffer_release(&saved);
  detail = "engine open-render-save-reopen complete";
  return true;
}

}  // namespace

std::vector<std::uint8_t> make_input_header(std::uint64_t input_size) {
  std::vector<std::uint8_t> bytes;
  bytes.reserve(kInputHeaderSize);
  bytes.insert(bytes.end(), kInputMagic.begin(), kInputMagic.end());
  append_u32(bytes, kProtocolVersion);
  append_u64(bytes, input_size);
  return bytes;
}

bool parse_input_header(std::span<const std::uint8_t> header,
                        std::uint64_t& input_size) {
  std::uint32_t version = 0U;
  return header.size() == kInputHeaderSize &&
         std::equal(kInputMagic.begin(), kInputMagic.end(), header.begin()) &&
         read_u32(header, 4U, version) && version == kProtocolVersion &&
         read_u64(header, 8U, input_size);
}

std::vector<std::uint8_t> make_result_frame(
    WireStatus status, std::span<const std::uint8_t> payload,
    std::string_view detail) {
  const auto bounded_detail = detail.substr(0U, kMaximumDetailBytes);
  std::vector<std::uint8_t> bytes;
  bytes.reserve(kResultHeaderSize + payload.size() + bounded_detail.size());
  bytes.insert(bytes.end(), kResultMagic.begin(), kResultMagic.end());
  append_u32(bytes, kProtocolVersion);
  append_u32(bytes, static_cast<std::uint32_t>(status));
  append_u64(bytes, payload.size());
  append_u32(bytes, static_cast<std::uint32_t>(bounded_detail.size()));
  append_u32(bytes, 0U);
  bytes.insert(bytes.end(), payload.begin(), payload.end());
  bytes.insert(bytes.end(), bounded_detail.begin(), bounded_detail.end());
  return bytes;
}

bool parse_result_frame(std::span<const std::uint8_t> frame,
                        WireStatus& status,
                        std::span<const std::uint8_t>& payload,
                        std::string& detail) {
  std::uint32_t version = 0U;
  std::uint32_t raw_status = 0U;
  std::uint64_t payload_size = 0U;
  std::uint32_t detail_size = 0U;
  std::uint32_t reserved = 0U;
  if (frame.size() < kResultHeaderSize ||
      !std::equal(kResultMagic.begin(), kResultMagic.end(), frame.begin()) ||
      !read_u32(frame, 4U, version) || version != kProtocolVersion ||
      !read_u32(frame, 8U, raw_status) ||
      raw_status > static_cast<std::uint32_t>(WireStatus::InternalError) ||
      !read_u64(frame, 12U, payload_size) ||
      !read_u32(frame, 20U, detail_size) || detail_size > kMaximumDetailBytes ||
      !read_u32(frame, 24U, reserved) || reserved != 0U ||
      payload_size > frame.size() - kResultHeaderSize ||
      detail_size > frame.size() - kResultHeaderSize - payload_size ||
      kResultHeaderSize + payload_size + detail_size != frame.size()) {
    return false;
  }
  status = static_cast<WireStatus>(raw_status);
  payload = frame.subspan(kResultHeaderSize,
                          static_cast<std::size_t>(payload_size));
  const auto detail_bytes = frame.subspan(
      kResultHeaderSize + static_cast<std::size_t>(payload_size), detail_size);
  detail.assign(reinterpret_cast<const char*>(detail_bytes.data()),
                detail_bytes.size());
  return true;
}

bool write_all_handle(std::intptr_t handle,
                      std::span<const std::uint8_t> bytes) {
  std::size_t offset = 0U;
  while (offset < bytes.size()) {
#if defined(_WIN32)
    DWORD count = 0U;
    const auto wanted = static_cast<DWORD>(std::min<std::size_t>(
        bytes.size() - offset, 1U << 20U));
    const auto succeeded = ::WriteFile(
        reinterpret_cast<HANDLE>(handle), bytes.data() + offset, wanted,
        &count, nullptr);
#else
    const auto count = ::write(static_cast<int>(handle), bytes.data() + offset,
                               bytes.size() - offset);
#endif
#if defined(_WIN32)
    if (succeeded == 0 || count == 0U) {
      return false;
    }
#else
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      return false;
    }
#endif
    offset += static_cast<std::size_t>(count);
  }
  return true;
}

bool read_exact_handle(std::intptr_t handle, std::span<std::uint8_t> bytes) {
  std::size_t offset = 0U;
  while (offset < bytes.size()) {
#if defined(_WIN32)
    DWORD count = 0U;
    const auto wanted = static_cast<DWORD>(std::min<std::size_t>(
        bytes.size() - offset, 1U << 20U));
    const auto succeeded = ::ReadFile(
        reinterpret_cast<HANDLE>(handle), bytes.data() + offset, wanted,
        &count, nullptr);
#else
    const auto count = ::read(static_cast<int>(handle), bytes.data() + offset,
                              bytes.size() - offset);
#endif
#if defined(_WIN32)
    if (succeeded == 0 || count == 0U) {
      return false;
    }
#else
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      return false;
    }
#endif
    offset += static_cast<std::size_t>(count);
  }
  return true;
}

}  // namespace patchy::worker::detail

namespace patchy::worker {

int native_job_worker_main(int argc, char** argv) {
  using namespace detail;
#if defined(_WIN32)
  char* child_marker_value = nullptr;
  std::size_t child_marker_size = 0U;
  const auto marker_error =
      _dupenv_s(&child_marker_value, &child_marker_size,
                "PATCHY_NATIVE_JOB_CHILD");
  const auto valid_child_marker = marker_error == 0 &&
                                  child_marker_value != nullptr &&
                                  std::string_view(child_marker_value) == "1";
  std::free(child_marker_value);
  if (!valid_child_marker) {
    return 64;
  }
#else
  const auto* child_marker = std::getenv("PATCHY_NATIVE_JOB_CHILD");
  if (child_marker == nullptr || std::string_view(child_marker) != "1") {
    return 64;
  }
#endif

  WorkerArguments arguments;
  if (!parse_worker_arguments(argc, argv, arguments)) {
    return 64;
  }

#if defined(_WIN32)
  _putenv_s("PATCHY_NATIVE_JOB_CHILD", "");
#elif defined(__APPLE__)
  if (environ != nullptr) {
    environ[0] = nullptr;
  }
#else
  if (clearenv() != 0) {
    return 70;
  }
#endif

  std::string sandbox_name;
  std::string sandbox_error;
  if (!enter_platform_sandbox(arguments, sandbox_name, sandbox_error)) {
    send_result(arguments.result_handle, WireStatus::SandboxUnavailable, {},
                sandbox_error);
    return 78;
  }

  if (arguments.probe != NativeJobProbe::None) {
    std::string probe_detail;
    if (run_platform_probe(arguments, probe_detail)) {
      send_result(arguments.result_handle, WireStatus::ProbePassed, {},
                  sandbox_name + ":" + probe_detail);
      return 0;
    }
    send_result(arguments.result_handle, WireStatus::InternalError, {},
                sandbox_name + ":" + probe_detail);
    return 1;
  }

  std::array<std::uint8_t, kInputHeaderSize> header{};
  std::uint64_t input_size = 0U;
  if (!read_exact_handle(arguments.input_handle, header) ||
      !parse_input_header(header, input_size) || input_size == 0U ||
      input_size > arguments.limits.max_input_bytes ||
      input_size > std::numeric_limits<std::size_t>::max()) {
    send_result(arguments.result_handle, WireStatus::Rejected, {},
                "invalid or oversized input frame");
    return 65;
  }

  std::vector<std::uint8_t> input;
  try {
    input.resize(static_cast<std::size_t>(input_size));
  } catch (const std::bad_alloc&) {
    send_result(arguments.result_handle, WireStatus::Rejected, {},
                "input allocation rejected");
    return 65;
  }
  if (!read_exact_handle(arguments.input_handle, input)) {
    send_result(arguments.result_handle, WireStatus::Rejected, {},
                "truncated input frame");
    return 65;
  }

  std::vector<std::uint8_t> output;
  std::string detail_message;
  if (!run_engine_job(input, arguments.limits.max_output_bytes, output,
                      detail_message)) {
    send_result(arguments.result_handle, WireStatus::Rejected, {},
                detail_message);
    return 65;
  }
  send_result(arguments.result_handle, WireStatus::Success, output,
              sandbox_name + ":" + detail_message);
  return 0;
}

}  // namespace patchy::worker
