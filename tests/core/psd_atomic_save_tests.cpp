#include "core/document.hpp"
#include "psd/psd_atomic_file_internal.hpp"
#include "psd/psd_document_io.hpp"

#include "test_groups.hpp"
#include "test_harness.hpp"

#include <array>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#elif !defined(__EMSCRIPTEN__)
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

#ifndef __EMSCRIPTEN__
constexpr int kCrashProbeExitCode = 73;
#endif
#if !defined(_WIN32) && !defined(__EMSCRIPTEN__)
std::filesystem::path test_executable;
#endif

patchy::Document sample_document() {
  patchy::Document document(5, 4, patchy::PixelFormat::rgba8());
  patchy::PixelBuffer pixels(5, 4, patchy::PixelFormat::rgba8());
  for (std::int32_t y = 0; y < 4; ++y) {
    for (std::int32_t x = 0; x < 5; ++x) {
      auto* pixel = pixels.pixel(x, y);
      pixel[0] = static_cast<std::uint8_t>(20 + x * 17);
      pixel[1] = static_cast<std::uint8_t>(30 + y * 23);
      pixel[2] = static_cast<std::uint8_t>(200 - x * 11);
      pixel[3] = static_cast<std::uint8_t>(160 + y * 20);
    }
  }
  document.add_pixel_layer("Atomic save", std::move(pixels));
  return document;
}

std::vector<std::uint8_t> encoded_document(bool layered = true,
                                           bool large_document = false) {
  patchy::psd::WriteOptions options;
  options.large_document = large_document;
  const auto document = sample_document();
  return layered ? patchy::psd::DocumentIo::write_layered_rgb8(document, options)
                 : patchy::psd::DocumentIo::write_flat_rgb8(document, options);
}

std::filesystem::path fresh_directory(std::string_view name) {
  const auto root = std::filesystem::path("test-artifacts") /
                    "psd-atomic-save" / std::string(name);
  std::error_code ignored;
  std::filesystem::remove_all(root, ignored);
  std::filesystem::create_directories(root);
  return root;
}

void write_direct(const std::filesystem::path& path,
                  std::span<const std::uint8_t> bytes) {
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  CHECK(static_cast<bool>(file));
  file.write(reinterpret_cast<const char*>(bytes.data()),
             static_cast<std::streamsize>(bytes.size()));
  CHECK(static_cast<bool>(file));
}

std::vector<std::uint8_t> read_direct(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  CHECK(static_cast<bool>(file));
  return {std::istreambuf_iterator<char>(file),
          std::istreambuf_iterator<char>()};
}

std::set<std::filesystem::path> directory_entries(
    const std::filesystem::path& directory) {
  std::set<std::filesystem::path> entries;
  for (const auto& entry : std::filesystem::directory_iterator(directory)) {
    entries.insert(entry.path().filename());
  }
  return entries;
}

template <typename Function>
void check_throws(Function&& function) {
  bool threw = false;
  try {
    function();
  } catch (const std::exception&) {
    threw = true;
  }
  CHECK(threw);
}

void write_public_file(const patchy::Document& document,
                       const std::filesystem::path& path, bool layered,
                       bool large_document) {
  patchy::psd::WriteOptions options;
  options.large_document = large_document;
  if (layered) {
    patchy::psd::DocumentIo::write_layered_rgb8_file(document, path, options);
  } else {
    patchy::psd::DocumentIo::write_flat_rgb8_file(document, path, options);
  }
}

void check_published_file_attributes(const std::filesystem::path& path) {
#ifdef _WIN32
  const auto attributes = GetFileAttributesW(path.c_str());
  CHECK(attributes != INVALID_FILE_ATTRIBUTES);
  CHECK((attributes & FILE_ATTRIBUTE_TEMPORARY) == 0U);
#else
  (void)path;
#endif
}

void psd_atomic_save_public_matrix_and_unicode_paths() {
  const auto directory = fresh_directory("public-matrix");
  const auto document = sample_document();
  const std::vector<std::uint8_t> sentinel{9U, 8U, 7U, 6U, 5U};
  for (const bool layered : {false, true}) {
    for (const bool large_document : {false, true}) {
      const auto stem = std::string(layered ? "layered" : "flat") +
                        (large_document ? "-psb" : "-psd");
      const auto path = directory / (stem + (large_document ? ".psb" : ".psd"));
      const auto expected = encoded_document(layered, large_document);

      write_direct(path, sentinel);
      write_public_file(document, path, layered, large_document);
      CHECK(read_direct(path) == expected);
      check_published_file_attributes(path);
      const auto reopened = patchy::psd::DocumentIo::read_file(path);
      CHECK(reopened.width() == 5 && reopened.height() == 4);

      std::filesystem::remove(path);
      write_public_file(document, path, layered, large_document);
      CHECK(read_direct(path) == expected);
      check_published_file_attributes(path);
    }
  }

  const auto unicode_path =
      directory / std::filesystem::path(u8"атомарный-保存.psd");
  write_public_file(document, unicode_path, true, false);
  CHECK(std::filesystem::exists(unicode_path));
  check_published_file_attributes(unicode_path);
  CHECK(patchy::psd::DocumentIo::read_file(unicode_path).layers().size() == 1U);
}

void psd_atomic_save_retries_short_writes() {
  const auto directory = fresh_directory("short-write");
  const auto path = directory / "short-write.psd";
  const auto bytes = encoded_document();
  patchy::psd::AtomicWriteTestControl control;
  control.max_bytes_per_write = 7U;
  patchy::psd::write_file_bytes_for_testing(path, bytes, control);
  CHECK(read_direct(path) == bytes);
  CHECK(patchy::psd::DocumentIo::read_file(path).width() == 5);
}

void capture_created_temporary(patchy::psd::AtomicWriteStage stage,
                               const std::filesystem::path& path,
                               void* context) {
  if (stage == patchy::psd::AtomicWriteStage::TemporaryCreated) {
    *static_cast<std::filesystem::path*>(context) = path;
  }
}

void psd_atomic_save_temporary_name_cannot_alias_destination() {
  const auto directory = fresh_directory("temporary-name");
  const auto bytes = encoded_document();
  for (const auto* name : {"normal.psd", ".patchy-save-shadow.tmp"}) {
    const auto destination = directory / name;
    std::filesystem::path temporary;
    patchy::psd::AtomicWriteTestControl control;
    control.stage_hook = &capture_created_temporary;
    control.context = &temporary;
    patchy::psd::write_file_bytes_for_testing(destination, bytes, control);
    CHECK(!temporary.empty());
    CHECK(temporary.parent_path() == destination.parent_path());
    CHECK(temporary.filename().native().front() !=
          destination.filename().native().front());
    CHECK(read_direct(destination) == bytes);
  }
}

void corrupt_temporary(patchy::psd::AtomicWriteStage stage,
                       const std::filesystem::path& path, void*) {
  if (stage != patchy::psd::AtomicWriteStage::TemporaryFlushed) {
    return;
  }
  std::fstream file(path, std::ios::binary | std::ios::in | std::ios::out);
  CHECK(static_cast<bool>(file));
  const char corrupt = 0;
  file.write(&corrupt, 1);
  file.flush();
  CHECK(static_cast<bool>(file));
}

void fail_after_validation(patchy::psd::AtomicWriteStage stage,
                           const std::filesystem::path&, void*) {
  if (stage == patchy::psd::AtomicWriteStage::TemporaryValidated) {
    throw std::runtime_error("injected pre-commit failure");
  }
}

#ifdef _WIN32
struct BackupRaceContext {
  std::filesystem::path path;
  std::vector<std::uint8_t> bytes{71U, 72U, 73U, 74U};
};

void occupy_selected_backup(patchy::psd::AtomicWriteStage stage,
                            const std::filesystem::path& path, void* context) {
  if (stage != patchy::psd::AtomicWriteStage::ReplacementBackupSelected) {
    return;
  }
  auto& race = *static_cast<BackupRaceContext*>(context);
  race.path = path;
  write_direct(path, race.bytes);
}
#endif

void check_failure_preserves(const std::filesystem::path& directory,
                             std::string_view name,
                             const patchy::psd::AtomicWriteTestControl& control,
                             bool existing) {
  const auto path = directory / (std::string(name) + ".psd");
  const std::vector<std::uint8_t> sentinel{41U, 42U, 43U, 44U, 45U};
  if (existing) {
    write_direct(path, sentinel);
  } else {
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
  }
  const auto before = directory_entries(directory);
  const auto bytes = encoded_document();
  check_throws([&] {
    patchy::psd::write_file_bytes_for_testing(path, bytes, control);
  });
  CHECK(directory_entries(directory) == before);
  if (existing) {
    CHECK(read_direct(path) == sentinel);
  } else {
    CHECK(!std::filesystem::exists(path));
  }
}

void psd_atomic_save_precommit_failures_preserve_destination_and_cleanup() {
  const auto directory = fresh_directory("failures");

  patchy::psd::AtomicWriteTestControl disk_full;
  disk_full.fail_after_bytes = 31U;
  check_failure_preserves(directory, "disk-full-existing", disk_full, true);
  check_failure_preserves(directory, "disk-full-absent", disk_full, false);

  patchy::psd::AtomicWriteTestControl flush_failure;
  flush_failure.fail_flush = true;
  check_failure_preserves(directory, "flush-existing", flush_failure, true);

  patchy::psd::AtomicWriteTestControl corrupt_readback;
  corrupt_readback.stage_hook = &corrupt_temporary;
  check_failure_preserves(directory, "readback-existing", corrupt_readback, true);

  patchy::psd::AtomicWriteTestControl validated_failure;
  validated_failure.stage_hook = &fail_after_validation;
  check_failure_preserves(directory, "validated-existing", validated_failure, true);

  const auto invalid_target = directory / "parse-invalid.psd";
  const std::vector<std::uint8_t> sentinel{51U, 52U, 53U};
  const std::vector<std::uint8_t> invalid_psd{1U, 2U, 3U, 4U};
  write_direct(invalid_target, sentinel);
  const auto before_invalid = directory_entries(directory);
  check_throws([&] {
    patchy::psd::write_file_bytes_for_testing(
        invalid_target, invalid_psd, patchy::psd::AtomicWriteTestControl{});
  });
  CHECK(directory_entries(directory) == before_invalid);
  CHECK(read_direct(invalid_target) == sentinel);

  const auto replacement_target = directory / "replace-target";
  std::filesystem::create_directory(replacement_target);
  write_direct(replacement_target / "keep.bin",
               std::array<std::uint8_t, 2>{11U, 12U});
  const auto before = directory_entries(directory);
  const auto bytes = encoded_document();
  check_throws([&] {
    patchy::psd::write_file_bytes_for_testing(
        replacement_target, bytes, patchy::psd::AtomicWriteTestControl{});
  });
  CHECK(directory_entries(directory) == before);
  CHECK(read_direct(replacement_target / "keep.bin") ==
        std::vector<std::uint8_t>({11U, 12U}));
}

#ifdef _WIN32
void psd_atomic_save_does_not_delete_unowned_backup_race_file() {
  const auto directory = fresh_directory("backup-race");
  const auto destination = directory / "destination.psd";
  const std::vector<std::uint8_t> sentinel{81U, 82U, 83U, 84U};
  write_direct(destination, sentinel);

  BackupRaceContext race;
  patchy::psd::AtomicWriteTestControl control;
  control.stage_hook = &occupy_selected_backup;
  control.context = &race;
  check_throws([&] {
    patchy::psd::write_file_bytes_for_testing(destination, encoded_document(),
                                              control);
  });
  CHECK(read_direct(destination) == sentinel);
  CHECK(!race.path.empty());
  CHECK(read_direct(race.path) == race.bytes);
}
#endif

#if !defined(_WIN32) && !defined(__EMSCRIPTEN__)
void psd_atomic_save_preserves_existing_posix_mode_and_symlink_target() {
  const auto directory = fresh_directory("mode");
  const auto mode_reference = directory / "new-file-mode-reference.bin";
  write_direct(mode_reference, std::array<std::uint8_t, 1>{6U});
  struct stat reference_status {};
  CHECK(::stat(mode_reference.c_str(), &reference_status) == 0);

  const auto absent = directory / "absent-mode.psd";
  patchy::psd::DocumentIo::write_layered_rgb8_file(sample_document(), absent);
  struct stat absent_status {};
  CHECK(::stat(absent.c_str(), &absent_status) == 0);
  CHECK((absent_status.st_mode & 0777) ==
        (reference_status.st_mode & 0777));

  const auto path = directory / "mode.psd";
  write_direct(path, std::array<std::uint8_t, 1>{7U});
  CHECK(::chmod(path.c_str(), 0640) == 0);
  patchy::psd::DocumentIo::write_layered_rgb8_file(sample_document(), path);
  struct stat status {};
  CHECK(::stat(path.c_str(), &status) == 0);
  CHECK((status.st_mode & 0777) == 0640);

  const auto target = directory / "symlink-target.psd";
  const auto alias = directory / "symlink-alias.psd";
  write_direct(target, std::array<std::uint8_t, 1>{8U});
  std::filesystem::create_symlink(target.filename(), alias);
  const auto expected = encoded_document();
  patchy::psd::DocumentIo::write_layered_rgb8_file(sample_document(), alias);
  CHECK(std::filesystem::is_symlink(alias));
  CHECK(read_direct(target) == expected);
  CHECK(read_direct(alias) == expected);
}
#endif

#ifndef __EMSCRIPTEN__
void terminate_at_validated(
    patchy::psd::AtomicWriteStage stage, const std::filesystem::path&, void*) {
  if (stage != patchy::psd::AtomicWriteStage::TemporaryValidated) {
    return;
  }
#ifdef _WIN32
  TerminateProcess(GetCurrentProcess(), kCrashProbeExitCode);
#else
  _exit(kCrashProbeExitCode);
#endif
  std::abort();
}

#ifdef _WIN32
std::wstring quote_windows_argument(std::wstring_view argument) {
  std::wstring quoted(1U, L'\"');
  std::size_t backslashes = 0U;
  for (const auto ch : argument) {
    if (ch == L'\\') {
      ++backslashes;
      continue;
    }
    if (ch == L'\"') {
      quoted.append(backslashes * 2U + 1U, L'\\');
      quoted.push_back(L'\"');
      backslashes = 0U;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0U;
    quoted.push_back(ch);
  }
  quoted.append(backslashes * 2U, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

int launch_crash_probe(const std::filesystem::path& destination) {
  std::array<wchar_t, 32768> module{};
  const auto length = GetModuleFileNameW(nullptr, module.data(),
                                        static_cast<DWORD>(module.size()));
  CHECK(length > 0U && length < module.size());
  const std::wstring executable(module.data(), length);
  auto command = quote_windows_argument(executable) +
                 L" --psd-atomic-save-crash-probe " +
                 quote_windows_argument(destination.native());
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  CHECK(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr,
                       FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup,
                       &process) != FALSE);
  CHECK(WaitForSingleObject(process.hProcess, 30000U) == WAIT_OBJECT_0);
  DWORD exit_code = 0U;
  CHECK(GetExitCodeProcess(process.hProcess, &exit_code) != FALSE);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return static_cast<int>(exit_code);
}
#else
int launch_crash_probe(const std::filesystem::path& destination) {
  CHECK(!test_executable.empty());
  const auto child = ::fork();
  CHECK(child >= 0);
  if (child == 0) {
    const auto executable = test_executable.string();
    const auto target = destination.string();
    ::execl(executable.c_str(), executable.c_str(),
            "--psd-atomic-save-crash-probe", target.c_str(),
            static_cast<char*>(nullptr));
    _exit(127);
  }
  int status = 0;
  CHECK(::waitpid(child, &status, 0) == child);
  CHECK(WIFEXITED(status));
  return WEXITSTATUS(status);
}
#endif

void psd_atomic_save_process_crash_before_replace_preserves_destination() {
  const auto directory = fresh_directory("crash");
  const std::vector<std::uint8_t> sentinel{90U, 91U, 92U, 93U};

  const auto existing = directory / "existing.psd";
  write_direct(existing, sentinel);
  CHECK(launch_crash_probe(existing) == kCrashProbeExitCode);
  CHECK(read_direct(existing) == sentinel);

  const auto absent = directory / "absent.psd";
  CHECK(!std::filesystem::exists(absent));
  CHECK(launch_crash_probe(absent) == kCrashProbeExitCode);
  CHECK(!std::filesystem::exists(absent));

  // A hard stop can leave only an unreferenced owned temporary file. It must
  // never become the destination, and the test removes its private directory.
  std::error_code ignored;
  std::filesystem::remove_all(directory, ignored);
}
#endif

}  // namespace

void set_psd_atomic_save_test_executable(const char* executable) {
#if !defined(_WIN32) && !defined(__EMSCRIPTEN__)
  if (executable != nullptr) {
    test_executable = std::filesystem::absolute(executable);
  }
#else
  (void)executable;
#endif
}

int run_psd_atomic_save_crash_probe(const char* destination) {
#ifndef __EMSCRIPTEN__
  if (destination == nullptr) {
    return 2;
  }
  patchy::psd::AtomicWriteTestControl control;
  control.stage_hook = &terminate_at_validated;
  patchy::psd::write_file_bytes_for_testing(destination, encoded_document(), control);
  return 3;
#else
  (void)destination;
  return 2;
#endif
}

std::vector<patchy::test::TestCase> psd_atomic_save_tests() {
  std::vector<patchy::test::TestCase> tests{
      {"psd_atomic_save_public_matrix_and_unicode_paths",
       psd_atomic_save_public_matrix_and_unicode_paths},
      {"psd_atomic_save_retries_short_writes",
       psd_atomic_save_retries_short_writes},
      {"psd_atomic_save_temporary_name_cannot_alias_destination",
       psd_atomic_save_temporary_name_cannot_alias_destination},
      {"psd_atomic_save_precommit_failures_preserve_destination_and_cleanup",
       psd_atomic_save_precommit_failures_preserve_destination_and_cleanup},
  };
#if !defined(_WIN32) && !defined(__EMSCRIPTEN__)
  tests.push_back(
      {"psd_atomic_save_preserves_existing_posix_mode_and_symlink_target",
       psd_atomic_save_preserves_existing_posix_mode_and_symlink_target});
#endif
#ifndef __EMSCRIPTEN__
  tests.push_back(
      {"psd_atomic_save_process_crash_before_replace_preserves_destination",
       psd_atomic_save_process_crash_before_replace_preserves_destination});
#endif
#ifdef _WIN32
  tests.push_back(
      {"psd_atomic_save_does_not_delete_unowned_backup_race_file",
       psd_atomic_save_does_not_delete_unowned_backup_race_file});
#endif
  return tests;
}
