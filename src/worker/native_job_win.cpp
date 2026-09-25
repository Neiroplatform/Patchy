#include "worker/native_job_internal.hpp"

#include "psd/psd_atomic_file_internal.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <aclapi.h>
#include <appmodel.h>
#include <combaseapi.h>
#include <sddl.h>
#include <userenv.h>
#include <ws2tcpip.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <filesystem>
#include <limits>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
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

class WindowsSocket {
 public:
  WindowsSocket() = default;
  explicit WindowsSocket(SOCKET value) : value_(value) {}
  WindowsSocket(const WindowsSocket&) = delete;
  WindowsSocket& operator=(const WindowsSocket&) = delete;
  ~WindowsSocket() {
    if (value_ != INVALID_SOCKET) {
      (void)::closesocket(value_);
    }
  }
  [[nodiscard]] SOCKET get() const noexcept { return value_; }
  [[nodiscard]] bool valid() const noexcept {
    return value_ != INVALID_SOCKET;
  }
  void reset(SOCKET value = INVALID_SOCKET) noexcept {
    if (value_ != INVALID_SOCKET) {
      (void)::closesocket(value_);
    }
    value_ = value;
  }

 private:
  SOCKET value_{INVALID_SOCKET};
};

class WinsockSession {
 public:
  WinsockSession() = default;
  WinsockSession(const WinsockSession&) = delete;
  WinsockSession& operator=(const WinsockSession&) = delete;
  ~WinsockSession() {
    if (active_) {
      (void)::WSACleanup();
    }
  }
  bool initialize() {
    if (active_) {
      return true;
    }
    WSADATA winsock{};
    active_ = ::WSAStartup(MAKEWORD(2, 2), &winsock) == 0;
    return active_;
  }

 private:
  bool active_{false};
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

class CoTaskMemory {
 public:
  CoTaskMemory() = default;
  explicit CoTaskMemory(void* value) : value_(value) {}
  CoTaskMemory(const CoTaskMemory&) = delete;
  CoTaskMemory& operator=(const CoTaskMemory&) = delete;
  ~CoTaskMemory() {
    if (value_ != nullptr) {
      ::CoTaskMemFree(value_);
    }
  }
  [[nodiscard]] void* get() const noexcept { return value_; }

 private:
  void* value_{nullptr};
};

class TemporaryDirectory {
 public:
  explicit TemporaryDirectory(std::filesystem::path path)
      : path_(std::move(path)) {}
  TemporaryDirectory(const TemporaryDirectory&) = delete;
  TemporaryDirectory& operator=(const TemporaryDirectory&) = delete;
  ~TemporaryDirectory() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }

 private:
  std::filesystem::path path_;
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

bool make_appcontainer_environment(PSID sid,
                                   std::wstring_view windows_directory,
                                   std::wstring& environment) {
  LPWSTR raw_sid = nullptr;
  if (::ConvertSidToStringSidW(sid, &raw_sid) == 0) {
    return false;
  }
  LocalMemory sid_guard(raw_sid);
  PWSTR raw_local_app_data = nullptr;
  if (FAILED(::GetAppContainerFolderPath(raw_sid, &raw_local_app_data)) ||
      raw_local_app_data == nullptr) {
    return false;
  }
  CoTaskMemory local_app_data_guard(raw_local_app_data);
  const std::filesystem::path local_app_data(raw_local_app_data);
  const auto temporary = local_app_data / L"Temp";
  if (!::CreateDirectoryW(temporary.c_str(), nullptr) &&
      ::GetLastError() != ERROR_ALREADY_EXISTS) {
    return false;
  }

  // CreateProcess expects the AppContainer profile variables that Windows
  // normally redirects when the parent environment is inherited. Keep the
  // explicit block sorted and limited to that private disposable profile, the
  // loader root, and the one-shot child marker; no caller variables cross the
  // boundary.
  const auto append = [&](std::wstring_view name, std::wstring_view value) {
    environment.append(name);
    environment.push_back(L'=');
    environment.append(value);
    environment.push_back(L'\0');
  };
  environment.clear();
  append(L"LOCALAPPDATA", local_app_data.native());
  append(L"PATCHY_NATIVE_JOB_CHILD", L"1");
  append(L"SystemRoot", windows_directory);
  append(L"TEMP", temporary.native());
  append(L"TMP", temporary.native());
  environment.push_back(L'\0');
  return true;
}

std::wstring environment_variable(const wchar_t* name) {
  const auto required = ::GetEnvironmentVariableW(name, nullptr, 0U);
  if (required == 0U) {
    return {};
  }
  std::vector<wchar_t> value(required);
  const auto written = ::GetEnvironmentVariableW(
      name, value.data(), static_cast<DWORD>(value.size()));
  if (written == 0U || written >= value.size()) {
    return {};
  }
  return std::wstring(value.data(), written);
}

bool restricted_appcontainer_environment() {
  const auto local_app_data = environment_variable(L"LOCALAPPDATA");
  const auto system_root = environment_variable(L"SystemRoot");
  const auto temporary = environment_variable(L"TEMP");
  const auto temporary_alias = environment_variable(L"TMP");
  if (local_app_data.empty() || system_root.empty() || temporary.empty() ||
      temporary_alias.empty() ||
      ::CompareStringOrdinal(temporary.c_str(), -1, temporary_alias.c_str(),
                             -1, TRUE) != CSTR_EQUAL) {
    return false;
  }
  const auto temporary_parent =
      std::filesystem::path(temporary).parent_path().native();
  if (::CompareStringOrdinal(local_app_data.c_str(), -1,
                             temporary_parent.c_str(), -1,
                             TRUE) != CSTR_EQUAL) {
    return false;
  }

  const auto allowed = [](std::wstring_view name) {
    for (const auto candidate : {L"LOCALAPPDATA", L"SystemRoot", L"TEMP",
                                 L"TMP"}) {
      if (::CompareStringOrdinal(name.data(), static_cast<int>(name.size()),
                                 candidate, -1, TRUE) == CSTR_EQUAL) {
        return true;
      }
    }
    return false;
  };
  auto* block = ::GetEnvironmentStringsW();
  if (block == nullptr) {
    return false;
  }
  bool restricted = true;
  for (auto* entry = block; *entry != L'\0';
       entry += std::wcslen(entry) + 1U) {
    const std::wstring_view value(entry);
    const auto separator = value.find(L'=');
    if (separator == std::wstring_view::npos ||
        (separator != 0U && !allowed(value.substr(0U, separator)))) {
      restricted = false;
      break;
    }
  }
  (void)::FreeEnvironmentStringsW(block);
  return restricted;
}

bool prepare_network_probe_endpoint(std::filesystem::path& probe_path,
                                    WinsockSession& winsock,
                                    WindowsSocket& listener) {
  if (!winsock.initialize()) {
    return false;
  }
  listener.reset(::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
  if (!listener.valid()) {
    return false;
  }
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0U;
  if (::bind(listener.get(), reinterpret_cast<const sockaddr*>(&address),
             sizeof(address)) == SOCKET_ERROR ||
      ::listen(listener.get(), 1) == SOCKET_ERROR) {
    return false;
  }
  int address_bytes = sizeof(address);
  if (::getsockname(listener.get(), reinterpret_cast<sockaddr*>(&address),
                    &address_bytes) == SOCKET_ERROR ||
      address.sin_port == 0U) {
    return false;
  }

  // Prove that the endpoint is live for a normal process before asking the
  // zero-capability AppContainer to reach it. This distinguishes network
  // isolation from a merely closed loopback port.
  WindowsSocket control(::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
  if (!control.valid() ||
      ::connect(control.get(), reinterpret_cast<const sockaddr*>(&address),
                sizeof(address)) == SOCKET_ERROR) {
    return false;
  }
  WindowsSocket accepted(::accept(listener.get(), nullptr, nullptr));
  if (!accepted.valid()) {
    return false;
  }
  probe_path = std::to_wstring(ntohs(address.sin_port));
  return true;
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
  // A hosted supervisor can itself belong to a Job Object. Windows permits a
  // child to join a nested job only when the child job has no basic UI limits.
  // The zero-capability AppContainer owns the UI boundary; this Job Object owns
  // resource limits and descendant termination.
  return true;
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
      request.limits.max_output_bytes >
          std::numeric_limits<std::size_t>::max() -
              detail::kResultHeaderSize - detail::kMaximumDetailBytes ||
      request.limits.max_address_space_bytes < 64U * 1024U * 1024U ||
      request.limits.max_address_space_bytes >
          std::numeric_limits<std::size_t>::max() ||
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
  const auto worker_directory = private_worker.parent_path();
  [[maybe_unused]] TemporaryDirectory staged_worker(worker_directory);

  WindowsHandle job(::CreateJobObjectW(nullptr, nullptr));
  if (!job.valid() || !configure_job(job.get(), request.limits)) {
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
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
  startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
  startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
  startup.lpAttributeList = attributes.get();
  PROCESS_INFORMATION process_info{};
  NativeJobRequest worker_request = request;
  WinsockSession network_probe_winsock;
  WindowsSocket network_probe_listener;
  if (request.probe == NativeJobProbe::Network &&
      !prepare_network_probe_endpoint(worker_request.probe_path,
                                      network_probe_winsock,
                                      network_probe_listener)) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not prepare controlled network probe endpoint";
    return result;
  }
  auto command_line = make_command_line(private_worker, input_read.get(),
                                        result_write.get(), worker_request);
  std::array<wchar_t, MAX_PATH + 1U> windows_directory{};
  const auto windows_count = ::GetWindowsDirectoryW(
      windows_directory.data(), static_cast<UINT>(windows_directory.size()));
  if (windows_count == 0U || windows_count >= windows_directory.size()) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not resolve Windows directory";
    return result;
  }
  std::wstring environment;
  if (!make_appcontainer_environment(profile.sid(), windows_directory.data(),
                                     environment)) {
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = "could not construct AppContainer environment";
    return result;
  }

  const auto created = ::CreateProcessW(
      private_worker.c_str(), command_line.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |
          CREATE_SUSPENDED | CREATE_NO_WINDOW,
      environment.data(), worker_directory.c_str(), &startup.StartupInfo,
      &process_info);
  WindowsHandle process(process_info.hProcess);
  WindowsHandle thread(process_info.hThread);
  const auto launch_failed = [&](std::string_view operation, DWORD error) {
    if (process.valid()) {
      (void)::TerminateProcess(process.get(), 126U);
    }
    result.outcome = NativeJobOutcome::SandboxUnavailable;
    result.detail = std::string(operation) + " failed (Win32 " +
                    std::to_string(error) + ")";
  };
  if (created == 0) {
    launch_failed("CreateProcessW for AppContainer worker", ::GetLastError());
    return result;
  }
  if (!process.valid() || !thread.valid()) {
    launch_failed("CreateProcessW returned invalid worker handles",
                  ERROR_INVALID_HANDLE);
    return result;
  }
  if (::AssignProcessToJobObject(job.get(), process.get()) == 0) {
    launch_failed("AssignProcessToJobObject for AppContainer worker",
                  ::GetLastError());
    return result;
  }
  if (::ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
    launch_failed("ResumeThread for AppContainer worker", ::GetLastError());
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
  const auto result_limit =
      detail::kResultHeaderSize +
      static_cast<std::size_t>(request.limits.max_output_bytes) +
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
    const auto count_size = static_cast<std::size_t>(count);
    if (output.size() > result_limit ||
        count_size > result_limit - output.size()) {
      oversized_result = true;
      (void)::TerminateJobObject(job.get(), 125U);
      break;
    }
    output.insert(output.end(), chunk.begin(), chunk.begin() + count_size);
  }
  result_read.reset();
  (void)::WaitForSingleObject(process.get(), INFINITE);
  DWORD child_status = 0U;
  (void)::GetExitCodeProcess(process.get(), &child_status);
  result.child_status = static_cast<int>(child_status);
  watchdog.join();
  process.reset();
  job.reset();

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
  for (const auto standard_handle :
       {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) {
    const auto handle = ::GetStdHandle(standard_handle);
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) {
      error = "worker inherited an ambient standard handle";
      return false;
    }
  }
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
      std::uint16_t port = 0U;
      const auto parsed = std::from_chars(arguments.probe_path.data(),
                                          arguments.probe_path.data() +
                                              arguments.probe_path.size(),
                                          port);
      if (parsed.ec != std::errc{} ||
          parsed.ptr != arguments.probe_path.data() +
                            arguments.probe_path.size() ||
          port == 0U) {
        detail = "network probe endpoint was invalid";
        return false;
      }
      WinsockSession winsock;
      if (!winsock.initialize()) {
        detail = "Winsock initialization failed before network probe";
        return false;
      }
      WindowsSocket socket_handle(
          ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
      if (!socket_handle.valid()) {
        detail = "network socket creation failed before controlled connect";
        return false;
      }
      u_long nonblocking = 1U;
      if (::ioctlsocket(socket_handle.get(), FIONBIO, &nonblocking) ==
          SOCKET_ERROR) {
        detail = "network socket could not enter nonblocking mode";
        return false;
      }
      sockaddr_in destination{};
      destination.sin_family = AF_INET;
      destination.sin_port = htons(port);
      destination.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      const auto connected = ::connect(
          socket_handle.get(), reinterpret_cast<const sockaddr*>(&destination),
          sizeof(destination));
      if (connected == 0) {
        detail = "controlled network connect unexpectedly succeeded";
        return false;
      }
      auto connect_error = ::WSAGetLastError();
      if (connect_error != WSAEWOULDBLOCK &&
          connect_error != WSAEINPROGRESS && connect_error != WSAEALREADY) {
        detail = "controlled network connect denied (WSA " +
                 std::to_string(connect_error) + ")";
        return true;
      }

      fd_set writable{};
      fd_set failed{};
      FD_SET(socket_handle.get(), &writable);
      FD_SET(socket_handle.get(), &failed);
      timeval bounded_wait{0L, 250'000L};
      const auto selected =
          ::select(0, nullptr, &writable, &failed, &bounded_wait);
      if (selected == SOCKET_ERROR) {
        detail = "controlled network probe select failed (WSA " +
                 std::to_string(::WSAGetLastError()) + ")";
        return false;
      }
      if (selected == 0) {
        detail = "controlled network connect denied within bounded wait";
        return true;
      }
      int option_bytes = sizeof(connect_error);
      if (::getsockopt(socket_handle.get(), SOL_SOCKET, SO_ERROR,
                       reinterpret_cast<char*>(&connect_error),
                       &option_bytes) == SOCKET_ERROR) {
        detail = "controlled network probe status failed (WSA " +
                 std::to_string(::WSAGetLastError()) + ")";
        return false;
      }
      if (connect_error == 0) {
        detail = "controlled network connect unexpectedly succeeded";
        return false;
      }
      detail = "controlled network connect denied (WSA " +
               std::to_string(connect_error) + ")";
      return true;
    }
    case NativeJobProbe::FileRead: {
      WindowsHandle file(::CreateFileA(arguments.probe_path.c_str(), GENERIC_READ,
                                       FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                                       FILE_ATTRIBUTE_NORMAL, nullptr));
      detail = file.valid() ? "unrelated file read unexpectedly succeeded"
                            : "unrelated file read denied";
      return !file.valid() && ::GetLastError() == ERROR_ACCESS_DENIED;
    }
    case NativeJobProbe::FileWrite: {
      WindowsHandle file(::CreateFileA(
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
      const auto restricted = restricted_appcontainer_environment();
      detail = absent && restricted
                   ? "secret environment absent and profile environment bounded"
                   : "worker environment escaped bounded profile";
      return absent && restricted;
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
