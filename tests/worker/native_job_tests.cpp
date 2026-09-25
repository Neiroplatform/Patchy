#include "engine/host_protocol.h"
#include "worker/native_job.hpp"
#include "worker/native_job_internal.hpp"

#include <chrono>
#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <process.h>
#else
#include <unistd.h>
#endif

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

std::uint64_t process_id() {
#if defined(_WIN32)
  return static_cast<std::uint64_t>(_getpid());
#else
  return static_cast<std::uint64_t>(::getpid());
#endif
}

void write_bytes(const std::filesystem::path& path,
                 std::span<const std::uint8_t> bytes) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  require(static_cast<bool>(output), "could not create test file");
  output.write(reinterpret_cast<const char*>(bytes.data()),
               static_cast<std::streamsize>(bytes.size()));
  require(static_cast<bool>(output), "could not write test file");
}

std::vector<std::uint8_t> read_bytes(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  require(static_cast<bool>(input), "could not read test file");
  return {std::istreambuf_iterator<char>(input),
          std::istreambuf_iterator<char>()};
}

std::vector<std::uint8_t> make_fixture() {
  patchy_engine_error error{};
  auto* runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  require(runtime != nullptr, "could not create fixture runtime");
  auto* session = patchy_engine_session_create_rgba8(runtime, 8, 6, &error);
  require(session != nullptr, "could not create fixture session");

  patchy_engine_document_projection document{};
  document.struct_size = sizeof(document);
  require(patchy_engine_session_document(session, &document, &error) == 1,
          "could not project fixture document");
  patchy_engine_command command{};
  command.struct_size = sizeof(command);
  command.protocol_version = PATCHY_ENGINE_HOST_PROTOCOL_VERSION;
  command.type = PATCHY_ENGINE_COMMAND_ADD_SOLID_LAYER;
  command.expected_state_id = document.state_id;
  command.expected_revision = document.revision;
  constexpr char name[] = "NW1 fixture";
  command.payload.add_solid_layer.name_size = sizeof(name) - 1U;
  std::memcpy(command.payload.add_solid_layer.name, name, sizeof(name) - 1U);
  command.payload.add_solid_layer.red = 30U;
  command.payload.add_solid_layer.green = 90U;
  command.payload.add_solid_layer.blue = 150U;
  command.payload.add_solid_layer.alpha = 255U;
  patchy_engine_event event{};
  require(patchy_engine_session_execute(session, &command, &event, &error) == 1,
          "could not author fixture layer");

  patchy_engine_buffer saved{};
  require(patchy_engine_session_save_psd(session, &saved, &event, &error) == 1,
          "could not save fixture");
  std::vector<std::uint8_t> result(saved.data, saved.data + saved.size);
  patchy_engine_buffer_release(&saved);
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
  return result;
}

void verify_reopen(const std::filesystem::path& path) {
  const auto bytes = read_bytes(path);
  patchy_engine_error error{};
  auto* runtime = patchy_engine_runtime_create(
      PATCHY_ENGINE_HOST_PROTOCOL_VERSION, &error);
  require(runtime != nullptr, "could not create reopen runtime");
  auto* session = patchy_engine_session_open_psd(runtime, bytes.data(),
                                                 bytes.size(), &error);
  require(session != nullptr, "worker output did not reopen");
  patchy_engine_document_projection document{};
  document.struct_size = sizeof(document);
  require(patchy_engine_session_document(session, &document, &error) == 1,
          "worker output projection failed");
  require(document.width == 8 && document.height == 6 &&
              document.layer_count == 1,
          "worker output semantics changed");
  patchy_engine_session_destroy(session);
  patchy_engine_runtime_destroy(runtime);
}

patchy::worker::NativeJobRequest base_request(
    const std::filesystem::path& input, const std::filesystem::path& output) {
  patchy::worker::NativeJobRequest request;
  request.worker_executable = PATCHY_NATIVE_JOB_EXECUTABLE;
  request.input_path = input;
  request.output_path = output;
  request.limits.max_input_bytes = 4U * 1024U * 1024U;
  request.limits.max_output_bytes = 8U * 1024U * 1024U;
  request.limits.max_address_space_bytes = 512U * 1024U * 1024U;
  request.limits.cpu_seconds = 5U;
  request.limits.wall_milliseconds = 5000U;
  return request;
}

void verify_wire_protocol() {
  using patchy::worker::detail::WireStatus;
  constexpr std::array<std::uint8_t, 3> expected_payload{1U, 2U, 3U};
  auto frame = patchy::worker::detail::make_result_frame(
      WireStatus::Success, expected_payload, "sandbox:complete");
  WireStatus status{};
  std::span<const std::uint8_t> payload;
  std::string detail;
  require(patchy::worker::detail::parse_result_frame(frame, status, payload,
                                                      detail),
          "valid result frame was rejected");
  require(status == WireStatus::Success &&
              std::vector<std::uint8_t>(payload.begin(), payload.end()) ==
                  std::vector<std::uint8_t>(expected_payload.begin(),
                                            expected_payload.end()) &&
              detail == "sandbox:complete",
          "valid result frame changed in transit");

  const auto rejects = [&](std::vector<std::uint8_t> malformed,
                           const char* message) {
    std::span<const std::uint8_t> rejected_payload;
    std::string rejected_detail;
    WireStatus rejected_status{};
    require(!patchy::worker::detail::parse_result_frame(
                malformed, rejected_status, rejected_payload,
                rejected_detail),
            message);
  };
  auto malformed = frame;
  malformed[0] ^= 0xFFU;
  rejects(std::move(malformed), "bad result magic was accepted");
  malformed = frame;
  malformed[4] = 2U;
  rejects(std::move(malformed), "unknown result version was accepted");
  malformed = frame;
  malformed[8] = 0xFFU;
  rejects(std::move(malformed), "unknown result status was accepted");
  malformed = frame;
  malformed[24] = 1U;
  rejects(std::move(malformed), "nonzero reserved field was accepted");
  malformed = frame;
  malformed[12] = 0xFFU;
  rejects(std::move(malformed), "oversized payload field was accepted");
  malformed = frame;
  malformed.pop_back();
  rejects(std::move(malformed), "truncated result frame was accepted");
  malformed = frame;
  malformed.push_back(0U);
  rejects(std::move(malformed), "trailing result bytes were accepted");

  auto input_header = patchy::worker::detail::make_input_header(73U);
  std::uint64_t input_size = 0U;
  require(patchy::worker::detail::parse_input_header(input_header, input_size) &&
              input_size == 73U,
          "valid input header was rejected");
  input_header[0] ^= 0xFFU;
  require(!patchy::worker::detail::parse_input_header(input_header, input_size),
          "bad input magic was accepted");
}

}  // namespace

int main() {
  const auto root = std::filesystem::temp_directory_path() /
                    ("patchy-native-job-tests-" + std::to_string(process_id()));
  std::filesystem::remove_all(root);
  std::filesystem::create_directories(root);
  try {
    verify_wire_protocol();
    const auto input = root / "input.psd";
    const auto output = root / "output.psd";
    const auto fixture = make_fixture();
    write_bytes(input, fixture);

    auto request = base_request(input, output);
    const auto success = patchy::worker::run_native_job(request);
    require(success.outcome == patchy::worker::NativeJobOutcome::Success,
            success.detail.c_str());
    require(success.input_bytes == fixture.size(), "input byte count mismatch");
    require(success.output_bytes > 0U, "missing output byte count");
    require(!success.sandbox.empty(), "missing sandbox identity");
    verify_reopen(output);

    constexpr std::array<std::uint8_t, 5> prior{'p', 'r', 'i', 'o', 'r'};
    write_bytes(output, prior);
    const auto malformed = root / "malformed.psd";
    constexpr std::array<std::uint8_t, 8> bad{'8', 'B', 'P', 'S', 0, 1, 0, 0};
    write_bytes(malformed, bad);
    request = base_request(malformed, output);
    const auto rejected = patchy::worker::run_native_job(request);
    require(rejected.outcome == patchy::worker::NativeJobOutcome::Rejected,
            "malformed input was not rejected");
    require(read_bytes(output) == std::vector<std::uint8_t>(prior.begin(), prior.end()),
            "rejected input changed prior destination");

    request = base_request(input, output);
    request.limits.max_input_bytes = fixture.size() - 1U;
    const auto oversized_input = patchy::worker::run_native_job(request);
    require(oversized_input.outcome == patchy::worker::NativeJobOutcome::Rejected,
            "oversized input was not rejected before spawn");
    require(read_bytes(output) == std::vector<std::uint8_t>(prior.begin(), prior.end()),
            "oversized input changed prior destination");

    request = base_request(input, output);
    request.limits.max_output_bytes = 16U;
    const auto oversized_output = patchy::worker::run_native_job(request);
    require(oversized_output.outcome == patchy::worker::NativeJobOutcome::Rejected,
            "oversized result was not rejected");
    require(read_bytes(output) == std::vector<std::uint8_t>(prior.begin(), prior.end()),
            "oversized result changed prior destination");

    const auto read_sentinel = root / "read-sentinel";
    write_bytes(read_sentinel, prior);
    const auto write_sentinel = root / "write-sentinel";
    for (const auto probe : {patchy::worker::NativeJobProbe::Network,
                             patchy::worker::NativeJobProbe::Environment,
                             patchy::worker::NativeJobProbe::Process}) {
      request = base_request({}, {});
      request.probe = probe;
      const auto probe_result = patchy::worker::run_native_job(request);
      require(probe_result.outcome == patchy::worker::NativeJobOutcome::Success,
              probe_result.detail.c_str());
      require(!probe_result.sandbox.empty(), "probe omitted sandbox identity");
    }

    request = base_request({}, {});
    request.probe = patchy::worker::NativeJobProbe::FileRead;
    request.probe_path = read_sentinel;
    require(patchy::worker::run_native_job(request).outcome ==
                patchy::worker::NativeJobOutcome::Success,
            "sandbox allowed unrelated file read");
    request.probe = patchy::worker::NativeJobProbe::FileWrite;
    request.probe_path = write_sentinel;
    require(patchy::worker::run_native_job(request).outcome ==
                patchy::worker::NativeJobOutcome::Success,
            "sandbox allowed unrelated file write");
    require(!std::filesystem::exists(write_sentinel),
            "file-write probe created a side effect");

    request = base_request({}, {});
    request.probe = patchy::worker::NativeJobProbe::Crash;
    const auto crashed = patchy::worker::run_native_job(request);
    require(crashed.outcome == patchy::worker::NativeJobOutcome::Crashed,
            "crash did not stay inside disposable worker");

    request = base_request({}, {});
    request.probe = patchy::worker::NativeJobProbe::Timeout;
    request.limits.wall_milliseconds = 200U;
    const auto timed_out = patchy::worker::run_native_job(request);
    require(timed_out.outcome == patchy::worker::NativeJobOutcome::TimedOut,
            "wall deadline did not terminate worker");

    request = base_request({}, {});
    request.probe = patchy::worker::NativeJobProbe::Memory;
    request.limits.max_address_space_bytes = 256U * 1024U * 1024U;
    const auto memory = patchy::worker::run_native_job(request);
    require(memory.outcome == patchy::worker::NativeJobOutcome::Success ||
                memory.outcome == patchy::worker::NativeJobOutcome::ResourceLimit,
            "address-space limit was not enforced");

    std::cout << "native worker isolation: 21/21 PASS\n";
  } catch (const std::exception& error) {
    std::cerr << "[FAIL] " << error.what() << '\n';
    std::filesystem::remove_all(root);
    return 1;
  }
  std::filesystem::remove_all(root);
  return 0;
}
