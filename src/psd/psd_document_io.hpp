#pragma once

#include "core/document.hpp"

#include <filesystem>
#include <cstdint>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace patchy::psd {

struct ParseBudget {
  // Aggregate bytes requested for primary PixelBuffers from PSD/PSB layer,
  // flat-composite, layer-mask, merged-transparency, and saved-channel geometry.
  // This deliberately does not claim to cover decoder working memory, patterns,
  // Smart Filter masks/caches, or render-time previews; future budget fields can
  // cover those independently.
  std::uint64_t max_primary_pixel_bytes{std::numeric_limits<std::uint64_t>::max()};
  // Encoded PSD/PSB source bytes accepted by read()/read_file(). Kept after the
  // original field so existing aggregate initialization retains its meaning.
  std::uint64_t max_input_bytes{std::numeric_limits<std::uint64_t>::max()};
  // Aggregate source-depth bytes admitted for raster decompression. This counts
  // decoded source planes once, independently of their on-disk compression,
  // and deliberately excludes converted output buffers and retained raw data.
  std::uint64_t max_decompressed_bytes{std::numeric_limits<std::uint64_t>::max()};
};

struct ParseUsage {
  std::uint64_t primary_pixel_bytes{0};
  std::uint64_t input_bytes{0};
  std::uint64_t decompressed_bytes{0};
};

enum class ParseBudgetDimension : std::uint8_t {
  InputBytes = 0,
  PrimaryPixelBytes = 1,
  DecompressedBytes = 2,
};

class ParseBudgetExceeded final : public std::length_error {
public:
  explicit ParseBudgetExceeded(ParseBudgetDimension dimension);

  [[nodiscard]] ParseBudgetDimension dimension() const noexcept {
    return dimension_;
  }

private:
  ParseBudgetDimension dimension_;
};

struct ReadOptions {
  bool preserve_unknown_blocks{true};
  bool prefer_flat_composite{false};
  bool retain_flat_composite{false};
  // When set, the reader appends plain-English import notes (smart-object handling,
  // etc.) for the UI's import-notices dialog.
  std::vector<std::string>* notices{nullptr};
  ParseBudget budget{};
  // Optional observation hook. Every field is reset to zero at the start of every
  // read and updated only after the corresponding budget charge succeeds.
  ParseUsage* usage{nullptr};
};

struct WriteOptions {
  bool large_document{false};
};

class DocumentIo {
public:
  [[nodiscard]] static bool can_read(std::span<const std::uint8_t> bytes) noexcept;
  [[nodiscard]] static Document read(std::span<const std::uint8_t> bytes, ReadOptions options = {});
  [[nodiscard]] static Document read_file(const std::filesystem::path& path, ReadOptions options = {});

  [[nodiscard]] static std::vector<std::uint8_t> write_flat_rgb8(const Document& document,
                                                                 WriteOptions options = {});
  static void write_flat_rgb8_file(const Document& document, const std::filesystem::path& path,
                                   WriteOptions options = {});

  [[nodiscard]] static std::vector<std::uint8_t> write_layered_rgb8(const Document& document,
                                                                    WriteOptions options = {});
  static void write_layered_rgb8_file(const Document& document, const std::filesystem::path& path,
                                      WriteOptions options = {});
};

}  // namespace patchy::psd
