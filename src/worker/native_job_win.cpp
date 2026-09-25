#include "worker/native_job_internal.hpp"

#include "psd/psd_atomic_file_internal.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <aclapi.h>
#include <appmodel.h>
#include <sddl.h>
#include <userenv.h>
#include <ws2tcpip.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <limits>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace patchy::worker {
namespace {

class WindowsHandle {
 public:
  WindowsHandle() = default;
  explicit WindowsHandle(HANDLE value) : value_(value) {}
  WindowsHandle(const WindowsHandle&) = delete;
  WindowsHandle& operator=(const WindowsHandle&) = delete;
  WindowsHandle(WindowsHandle&& other) noexcept
      : value_(std::exchange(other.value_, nullptr)) {}
  WindowsHandle& operator=(WindowsHandle&& other) noexcept {
    if (this != &other) {
      reset();
      value_ = std::exchange(other.value_, nullptr);
    }
    return *this;
  }
  ~WindowsHandle() { reset(); }

  [[nodiscard]] HANDLE get() const noexcept { return value_; }
  [[nodiscard]] bool valid() const noexcept {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  HANDLE release() noexcept { return std::exchange(value_, nullptr); }
  void reset(HANDLE value = nullptr) noexcept {
    if (valid()) {
      (void)::CloseHandle(value_);
    }
    value_ = value;
  }

 private:
  HANDLE value_{nullptr};
};

class LocalMemory {
 public:
  LocalMemory() = default;
  explicit LocalMemory(void* value) : value_(value) {}
  LocalMemory(const LocalMemory&) = delete;
  LocalMemory& operator=(const LocalMemory&) = delete;
  ~LocalMemory() {
    if (value_ != nullptr) {
      (void)::LocalFree(value_);
    }
  }
  [[nodiscard]] void* get() const noexcept { return value_; }
  void reset(void* value = nullptr) noexcept {
    if (value_ != nullptr) {
      (void)::LocalFree(value_);
    }
    value_ = value;
  }

 private:
  void* value_{nullptr};
};

class AppContainerProfile {
 public:
  AppContainerProfile() = default;
  AppContainerProfile(const AppContainerProfile&) = delete;
  AppContainerProfile& operator=(const AppContainerProfile&) = delete;
  ~AppContainerProfile() {
    if (sid_ != nullptr) {
      ::FreeSid(sid_);
    }
    if (!name_.empty()) {
      (void)::DeleteAppContainerProfile(name_.c_str());
    }
  }

  bool create(const std::wstring& name) {
    name_ = name;
    const auto created = ::CreateAppContainerProfile(
        name.c_str(), name.c_str(), L"Disposable Patchy native job", nullptr,
        0U, &sid_);
    if (created == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
      return SUCCEEDED(
          ::DeriveAppContainerSidFromAppContainerName(name.c_str(), &sid_));
    }
    return SUCCEEDED(created) && sid_ != nullptr;
  }

  [[nodiscard]] PSID sid() const noexcept { return sid_; }

 private:
  std::wstring name_;
  PSID sid_{nullptr};
};

class AttributeList {
 public:
  AttributeList() = default;
  AttributeList(const AttributeList&) = delete;
  AttributeList& operator=(const AttributeList&) = delete;
  ~AttributeList() {
    if (value_ != nullptr) {
      ::DeleteProcThreadAttributeList(value_);
      ::HeapFree(::GetProcessHeap(), 0U, value_);
    }
  }

  bool initialize(DWORD count) {
    SIZE_T bytes = 0U;
    (void)::InitializeProcThreadAttributeList(nullptr, count, 0U, &bytes);
    value_ = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
        ::HeapAlloc(::GetProcessHeap(), 0U, bytes));
    return value_ != nullptr &&
           ::InitializeProcThreadAttributeList(value_, count, 0U, &bytes) != 0;
  }

  [[nodiscard]] LPPROC_THREAD_ATTRIBUTE_LIST get() const noexcept {
    return value_;
  }

 private:
  LPPROC_THREAD_ATTRIBUTE_LIST value_{nullptr};
};

std::wstring quote_argument(const std::wstring& argument) {
  std::wstring quoted(1U, L'"');
  std::size_t slashes = 0U;
  for (const auto character : argument) {
    if (character == L'\\') {
      ++slashes;
      continue;
    }
    if (character == L'"') {
      quoted.append(slashes * 2U + 1U, L'\\');
      quoted.push_back(L'"');
      slashes = 0U;
      continue;
    }
    quoted.append(slashes, L'\\');
    slashes = 0U;
    quoted.push_back(character);
  }
  quoted.append(slashes * 2U, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

std::wstring probe_name(NativeJobProbe probe) {
  switch (probe) {
    case NativeJobProbe::None:
      return L"none";
    case NativeJobProbe::Network:
      return L"network";
    case NativeJobProbe::FileRead:
      return L"file-read";
    case NativeJobProbe::FileWrite:
      return L"file-write";
    case NativeJobProbe::Environment:
      return L"environment";
    case NativeJobProbe::Process:
      return L"process";
    case NativeJobProbe::Crash:
      return L"crash";
    case NativeJobProbe::Timeout:
      return L"timeout";
    case NativeJobProbe::Memory:
      return L"memory";
  }
  return L"invalid";
}

std::wstring make_command_line(const std::filesystem::path& executable,
                               HANDLE input, HANDLE result,
                               const NativeJobRequest& request) {
  std::vector<std::wstring> arguments{
      executable.wstring(),
      L"--worker",
      L"--input-handle=" +
          std::to_wstring(reinterpret_cast<std::uintptr_t>(input)),
      L"--result-handle=" +
          std::to_wstring(reinterpret_cast<std::uintptr_t>(result)),
      L"--max-input=" + std::to_wstring(request.limits.max_input_bytes),
      L"--max-output=" + std::to_wstring(request.limits.max_output_bytes),
      L"--memory=" +
          std::to_wstring(request.limits.max_address_space_bytes),
      L"--cpu-seconds=" + std::to_wstring(request.limits.cpu_seconds),
      L"--probe=" + probe_name(request.probe),
      L"--probe-path=" + request.probe_path.wstring(),
  };
  std::wstring command;
  for (const auto& argument : arguments) {
    if (!command.empty()) {
      command.push_back(L' ');
    }
    command += quote_argument(argument);
  }
  return command;
}

bool grant_appcontainer_access(const std::filesystem::path& path, PSID sid) {
  PACL old_acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const auto queried = ::GetNamedSecurityInfoW(
      const_cast<wchar_t*>(path.c_str()), SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION, nullptr, nullptr, &old_acl, nullptr,
      &descriptor);
  LocalMemory descriptor_guard(descriptor);
  if (queried != ERROR_SUCCESS) {
    return false;
  }

  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = GENERIC_READ | GENERIC_EXECUTE;
  access.grfAccessMode = GRANT_ACCESS;
  access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  PACL combined = nullptr;
  const auto merged = ::SetEntriesInAclW(1U, &access, old_acl, &combined);
  LocalMemory combined_guard(combined);
  if (merged != ERROR_SUCCESS) {
    return false;
  }
  return ::SetNamedSecurityInfoW(
             const_cast<wchar_t*>(path.c_str()), SE_FILE_OBJECT,
             DACL_SECURITY_INFORMATION, nullptr, nullptr, combined, nullptr) ==
         ERROR_SUCCESS;
}

std::filesystem::path make_private_worker_copy(
    const std::filesystem::path& source, PSID sid) {
  std::array<wchar_t, MAX_PATH + 1U> temporary{};
  const auto count = ::GetTempPathW(static_cast<DWORD>(temporary.size()),
                                    temporary.data());
  if (count == 0U || count >= temporary.size()) {
    return {};
  }
  const auto directory = std::filesystem::path(temporary.data()) /
                         (L"patchy-native-job-" +
                          std::to_wstring(::GetCurrentProcessId()) + L"-" +
                          std::to_wstring(::GetTickCount64()));
  if (!::CreateDirectoryW(directory.c_str(), nullptr)) {
    return {};
  }
  const auto destination = directory / L"patchy-native-job.exe";
  if (!::CopyFileW(source.c_str(), destination.c_str(), TRUE) ||
      !grant_appcontainer_access(directory, sid) ||
      !grant_appcontainer_access(destination, sid)) {
    std::error_code ignored;
    std::filesystem::remove_all(directory, ignored);
    return {};
  }
  return destination;
}

bool configure_job(HANDLE job, const NativeJobLimits& limits) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION information{};
  information.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
      JOB_OBJECT_LIMIT_PROCESS_MEMORY |
      JOB_OBJECT_LIMIT_JOB_MEMORY |
      JOB_OBJECT_LIMIT_PROCESS_TIME;
  information.BasicLimitInformation.ActiveProcessLimit = 1U;
  information.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart =
      static_cast<LONGLONG>(limits.cpu_seconds) * 10'000'000LL;
  information.ProcessMemoryLimit =
      static_cast<SIZE_T>(limits.max_address_space_bytes);
  information.JobMemoryLimit =
      static_cast<SIZE_T>(limits.max_address_space_bytes);
  if (::SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                &information, sizeof(information)) == 0) {
    return false;
  }
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
  ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_DESKTOP |
                           JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                           JOB_OBJECT_UILIMIT_EXITWINDOWS |
                           JOB_OBJECT_UILIMIT_GLOBALATOMS |
                           JOB_OBJECT_UILIMIT_HANDLES |
                           JOB_OBJECT_UILIMIT_READCLIPBOARD |
                           JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS |
                           JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
  return ::SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui,
                                   sizeof(ui)) != 0;
}

bool valid_psd_header(std::span<const std::uint8_t> bytes) {
  return bytes.size() >= 6U && bytes[0] == '8' && bytes[1] == 'B' &&
         bytes[2] == 'P' && bytes[3] == 'S' && bytes[4] == 0U &&
         (bytes[5] == 1U || bytes[5] == 2U);
}

bool write_input(HANDLE pipe, HANDLE source, std::uint64_t size) {
  const auto header = detail::make_input_header(size);
  if (!detail::write_all_handle(reinterpret_cast<std::intptr_t>(pipe), header)) {
    return false;
  }
  std::array<std::uint8_t, 64U * 1024U> bytes{};
  std::uint64_t offset = 0U;
  while (offset < size) {
    const auto wanted = static_cast<DWORD>(std::min<std::uint64_t>(
        bytes.size(), size - offset));
    DWORD count = 0U;
    if (::ReadFile(source, bytes.data(), wanted, &count, nullptr) == 0 ||
        count == 0U ||
        !detail::write_all_handle(reinterpret_cast<std::intptr_t>(pipe),
                                  std::span(bytes.data(), count))) {
      return false;
    }
    offset += count;
  }
  return true;
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

  WindowsHandle source;
  std::uint64_t source_size = 0U;
  if (request.probe == NativeJobProbe::None) {
    source.reset(::CreateFileW(
        request.input_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        nullptr));
    LARGE_INTEGER size{};
    if (!source.valid() || ::GetFileType(source.get()) != FILE_TYPE_DISK ||
        ::GetFileSizeEx(source.get(), &size) == 0 || size.QuadPart <= 0) {
      result.outcome = NativeJobOutcome::Rejected;
      result.detail = "input must be a non-empty regular file";
      return result;
    }
    source_size = static_cast<std::uint64_t>(size.QuadPart);
    if (source_size > request.limits.max_input_bytes) {
      result.outcome = NativeJobOutcome::Rejected;
      result.detail = "input exceeds supervisor limit";
      return result;
    }
  }
  result.input_bytes = source_size;

  SECURITY_ATTRIBUTES pipe_security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE raw_input_read = nullptr;
  HANDLE raw_input_write = nullptr;
  HANDLE raw_result_read = nullptr;
  HANDLE raw_result_write = nullptr;
  if (::CreatePipe(&raw_input_read, &raw_input_write, &pipe_security, 0U) == 0 ||
      ::CreatePipe(&raw_result_read, &raw_result_write, &pipe_security, 0U) ==
          0) {
    result.detail = "could not create supervisor pipes";
    return result;
  }
  WindowsHandle input_read(raw_input_read);
  WindowsHandle input_write(raw_input_write);
  WindowsHandle result_read(raw_result_read);
  WindowsHandle result_write(raw_result_write);
  if (::SetHandleInformation(input_write.get(), HANDLE_FLAG_INHERIT, 0U) == 0 ||
      ::SetHandleInformation(result_read.get(), HANDLE_FLAG_INHERIT, 0U) == 0) {
    result.detail = "could not restrict inherited pipe handles";
    return result;
  }

  const auto profile_name =
      L"Patchy.NativeJob." + std::to_wstring(::GetCurrentProcessId()) + L"." +
      std::to_wstring(::GetTickCount64());
  AppContainerProfile profile;
  if (!profile.create(profile_name)) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not create AppContainer profile";
    return result;
  }
  const auto private_worker =
      make_private_worker_copy(request.worker_executable, profile.sid());
  if (private_worker.empty()) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not stage AppContainer worker executable";
    return result;
  }
  const auto cleanup_directory = private_worker.parent_path();

  WindowsHandle job(::CreateJobObjectW(nullptr, nullptr));
  if (!job.valid() || !configure_job(job.get(), request.limits)) {
    std::error_code ignored;
    std::filesystem::remove_all(cleanup_directory, ignored);
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not configure worker Job Object";
    return result;
  }

  AttributeList attributes;
  if (!attributes.initialize(2U)) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not initialize worker attributes";
    return result;
  }
  std::array<HANDLE, 2> inherited{input_read.get(), result_write.get()};
  if (::UpdateProcThreadAttribute(
          attributes.get(), 0U, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          inherited.data(), sizeof(inherited), nullptr, nullptr) == 0) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not restrict inherited worker handles";
    return result;
  }
  SECURITY_CAPABILITIES capabilities{};
  capabilities.AppContainerSid = profile.sid();
  if (::UpdateProcThreadAttribute(
          attributes.get(), 0U, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
          &capabilities, sizeof(capabilities), nullptr, nullptr) == 0) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not apply AppContainer security capabilities";
    return result;
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attributes.get();
  PROCESS_INFORMATION process_info{};
  auto command_line = make_command_line(private_worker, input_read.get(),
                                        result_write.get(), request);
  std::array<wchar_t, MAX_PATH + 1U> windows_directory{};
  const auto windows_count = ::GetWindowsDirectoryW(
      windows_directory.data(), static_cast<UINT>(windows_directory.size()));
  if (windows_count == 0U || windows_count >= windows_directory.size()) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not resolve Windows directory";
    return result;
  }
  std::wstring environment = L"PATCHY_NATIVE_JOB_CHILD=1";
  environment.push_back(L'\0');
  environment += L"SystemRoot=";
  environment += windows_directory.data();
  environment.push_back(L'\0');
  environment.push_back(L'\0');

  const auto created = ::CreateProcessW(
      private_worker.c_str(), command_line.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |
          CREATE_SUSPENDED | CREATE_NO_WINDOW,
      environment.data(), cleanup_directory.c_str(), &startup.StartupInfo,
      &process_info);
  WindowsHandle process(process_info.hProcess);
  WindowsHandle thread(process_info.hThread);
  if (created == 0 || !process.valid() ||
      ::AssignProcessToJobObject(job.get(), process.get()) == 0 ||
      ::ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
    if (process.valid()) {
      (void)::TerminateProcess(process.get(), 126U);
    }
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not start AppContainer worker in Job Object";
    return result;
  }
  thread.reset();
  input_read.reset();
  result_write.reset();

  std::atomic_bool timed_out{false};
  std::jthread watchdog([&] {
    const auto waited =
        ::WaitForSingleObject(process.get(), request.limits.wall_milliseconds);
    if (waited == WAIT_TIMEOUT) {
      timed_out.store(true, std::memory_order_release);
      (void)::TerminateJobObject(job.get(), 124U);
    }
  });

  bool input_complete = request.probe != NativeJobProbe::None;
  if (!input_complete) {
    input_complete = write_input(input_write.get(), source.get(), source_size);
  }
  input_write.reset();

  std::vector<std::uint8_t> output;
  const auto result_limit = detail::kResultHeaderSize +
                            request.limits.max_output_bytes +
                            detail::kMaximumDetailBytes;
  bool oversized_result = false;
  std::array<std::uint8_t, 64U * 1024U> chunk{};
  while (true) {
    DWORD count = 0U;
    if (::ReadFile(result_read.get(), chunk.data(),
                   static_cast<DWORD>(chunk.size()), &count, nullptr) == 0) {
      break;
    }
    if (count == 0U) {
      break;
    }
    if (output.size() + count > result_limit) {
      oversized_result = true;
      (void)::TerminateJobObject(job.get(), 125U);
      break;
    }
    output.insert(output.end(), chunk.begin(), chunk.begin() + count);
  }
  result_read.reset();
  (void)::WaitForSingleObject(process.get(), INFINITE);
  DWORD child_status = 0U;
  (void)::GetExitCodeProcess(process.get(), &child_status);
  result.child_status = static_cast<int>(child_status);
  watchdog.join();
  process.reset();
  job.reset();
  std::error_code ignored;
  std::filesystem::remove_all(cleanup_directory, ignored);

  if (timed_out.load(std::memory_order_acquire)) {
    result.outcome = NativeJobOutcome::TimedOut;
    result.detail = "worker exceeded wall deadline";
    return result;
  }
  if (!input_complete) {
    result.outcome = NativeJobOutcome::Rejected;
    result.detail = "input stream did not complete";
    return result;
  }
  if (oversized_result) {
    result.outcome = NativeJobOutcome::Rejected;
    result.detail = "worker result exceeded supervisor limit";
    return result;
  }

  detail::WireStatus wire_status{};
  std::span<const std::uint8_t> payload;
  std::string wire_detail;
  if (!detail::parse_result_frame(output, wire_status, payload, wire_detail)) {
    result.outcome = request.probe == NativeJobProbe::Memory
                         ? NativeJobOutcome::ResourceLimit
                         : NativeJobOutcome::Crashed;
    result.detail = "worker returned no valid terminal frame";
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

}  // namespace patchy::worker

namespace patchy::worker::detail {

bool enter_platform_sandbox(const WorkerArguments& arguments,
                            std::string& sandbox_name, std::string& error) {
  (void)arguments;
  WindowsHandle token;
  HANDLE raw_token = nullptr;
  if (::OpenProcessToken(::GetCurrentProcess(), TOKEN_QUERY, &raw_token) == 0) {
    error = "could not inspect worker token";
    return false;
  }
  token.reset(raw_token);
  DWORD appcontainer = 0U;
  DWORD returned = 0U;
  if (::GetTokenInformation(token.get(), TokenIsAppContainer, &appcontainer,
                            sizeof(appcontainer), &returned) == 0 ||
      appcontainer == 0U) {
    error = "worker is not running in an AppContainer";
    return false;
  }
  BOOL in_job = FALSE;
  if (::IsProcessInJob(::GetCurrentProcess(), nullptr, &in_job) == 0 ||
      in_job == FALSE) {
    error = "worker is not running in a Job Object";
    return false;
  }
  DWORD capability_bytes = 0U;
  (void)::GetTokenInformation(token.get(), TokenCapabilities, nullptr, 0U,
                              &capability_bytes);
  std::vector<std::uint8_t> capability_storage(capability_bytes);
  auto* capabilities = reinterpret_cast<TOKEN_GROUPS*>(capability_storage.data());
  if (capability_bytes == 0U ||
      ::GetTokenInformation(token.get(), TokenCapabilities, capabilities,
                            capability_bytes, &returned) == 0 ||
      capabilities->GroupCount != 0U) {
    error = "worker AppContainer has ambient capabilities";
    return false;
  }
  sandbox_name = "windows-appcontainer-job";
  return true;
}

bool run_platform_probe(const WorkerArguments& arguments, std::string& detail) {
  switch (arguments.probe) {
    case NativeJobProbe::None:
      detail = "no probe requested";
      return false;
    case NativeJobProbe::Network: {
      WSADATA winsock{};
      if (::WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
        detail = "Winsock initialization failed closed";
        return true;
      }
      const auto socket_handle = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
      if (socket_handle == INVALID_SOCKET) {
        const auto denied = ::WSAGetLastError() == WSAEACCES;
        (void)::WSACleanup();
        detail = "network socket creation denied";
        return denied;
      }
      sockaddr_in destination{};
      destination.sin_family = AF_INET;
      destination.sin_port = htons(9U);
      destination.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      const auto connected = ::connect(
          socket_handle, reinterpret_cast<const sockaddr*>(&destination),
          sizeof(destination));
      const auto connect_error = ::WSAGetLastError();
      (void)::closesocket(socket_handle);
      (void)::WSACleanup();
      detail = connected == SOCKET_ERROR ? "network connect denied"
                                          : "network connect unexpectedly succeeded";
      return connected == SOCKET_ERROR && connect_error == WSAEACCES;
    }
    case NativeJobProbe::FileRead: {
      WindowsHandle file(::CreateFileW(arguments.probe_path.c_str(), GENERIC_READ,
                                       FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                       FILE_ATTRIBUTE_NORMAL, nullptr));
      detail = file.valid() ? "unrelated file read unexpectedly succeeded"
                            : "unrelated file read denied";
      return !file.valid() && ::GetLastError() == ERROR_ACCESS_DENIED;
    }
    case NativeJobProbe::FileWrite: {
      WindowsHandle file(::CreateFileW(
          arguments.probe_path.c_str(), GENERIC_WRITE, 0U, nullptr,
          CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
      detail = file.valid() ? "unrelated file write unexpectedly succeeded"
                            : "unrelated file write denied";
      return !file.valid() && ::GetLastError() == ERROR_ACCESS_DENIED;
    }
    case NativeJobProbe::Environment: {
      std::array<wchar_t, 2> secret{};
      const auto count = ::GetEnvironmentVariableW(
          L"PATCHY_NATIVE_JOB_SECRET_PROBE", secret.data(),
          static_cast<DWORD>(secret.size()));
      const auto absent = count == 0U &&
                          ::GetLastError() == ERROR_ENVVAR_NOT_FOUND;
      detail = absent ? "secret environment absent"
                      : "secret environment leaked";
      return absent;
    }
    case NativeJobProbe::Process: {
      std::array<wchar_t, 32768U> executable{};
      if (::GetModuleFileNameW(nullptr, executable.data(),
                               static_cast<DWORD>(executable.size())) == 0U) {
        detail = "process probe could not resolve executable";
        return false;
      }
      auto command = quote_argument(executable.data());
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      PROCESS_INFORMATION process{};
      const auto created = ::CreateProcessW(
          executable.data(), command.data(), nullptr, nullptr, FALSE,
          CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup,
          &process);
      if (created != 0) {
        (void)::TerminateProcess(process.hProcess, 91U);
        (void)::CloseHandle(process.hThread);
        (void)::CloseHandle(process.hProcess);
        detail = "child process creation unexpectedly succeeded";
        return false;
      }
      detail = "child process creation denied";
      return ::GetLastError() == ERROR_ACCESS_DENIED;
    }
    case NativeJobProbe::Crash:
      ::RaiseException(EXCEPTION_ACCESS_VIOLATION, EXCEPTION_NONCONTINUABLE, 0U,
                       nullptr);
      detail = "crash probe unexpectedly survived";
      return false;
    case NativeJobProbe::Timeout:
      (void)::SleepEx(INFINITE, FALSE);
      detail = "timeout probe unexpectedly survived";
      return false;
    case NativeJobProbe::Memory: {
      try {
        std::vector<std::uint8_t> bytes(
            static_cast<std::size_t>(arguments.limits.max_address_space_bytes),
            0xA5U);
        for (std::size_t offset = 0U; offset < bytes.size(); offset += 4096U) {
          bytes[offset] ^= 0xFFU;
        }
      } catch (const std::bad_alloc&) {
        detail = "job memory limit enforced";
        return true;
      }
      detail = "job memory limit was not enforced";
      return false;
    }
  }
  detail = "unknown probe";
  return false;
}

}  // namespace patchy::worker::detail
