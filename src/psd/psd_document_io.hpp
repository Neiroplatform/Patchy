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
  // Conservative logical reservations for instrumented parser-owned temporary
  // buffers. This is not an RSS, allocator-capacity, or committed-WASM-heap cap.
  std::uint64_t max_tracked_live_bytes{std::numeric_limits<std::uint64_t>::max()};
  // Serialized layer records, including group-boundary records.
  std::uint64_t max_layer_records{std::numeric_limits<std::uint64_t>::max()};
  // Composite/saved channel declarations plus every per-layer channel record.
  std::uint64_t max_channel_records{std::numeric_limits<std::uint64_t>::max()};
  // Complete image-resource plus per-layer/document-global tagged records.
  std::uint64_t max_resource_records{std::numeric_limits<std::uint64_t>::max()};
  // Descriptor object/value/list/reference/array nodes parsed during import.
  std::uint64_t max_descriptor_nodes{std::numeric_limits<std::uint64_t>::max()};
  // Complete records admitted from document-global Patt/Pat2/Pat3 blocks.
  std::uint64_t max_pattern_records{std::numeric_limits<std::uint64_t>::max()};
  // Source-derived byte/sample payloads promoted into distinct persistent
  // owners reachable from the returned Document. Shared aliases count once;
  // input, primary pixels, transient workspace and container overhead do not.
  std::uint64_t max_retained_payload_bytes{std::numeric_limits<std::uint64_t>::max()};
};

struct ParseUsage {
  std::uint64_t primary_pixel_bytes{0};
  std::uint64_t input_bytes{0};
  std::uint64_t decompressed_bytes{0};
  // Current successfully reserved parser workspace and its monotonic high-water.
  // A completed or unwound read always leaves tracked_live_bytes at zero.
  std::uint64_t tracked_live_bytes{0};
  std::uint64_t tracked_live_bytes_high_water{0};
  std::uint64_t layer_records{0};
  std::uint64_t channel_records{0};
  std::uint64_t resource_records{0};
  std::uint64_t descriptor_nodes{0};
  std::uint64_t pattern_records{0};
  std::uint64_t retained_payload_bytes{0};
};

enum class ParseBudgetDimension : std::uint8_t {
  InputBytes = 0,
  PrimaryPixelBytes = 1,
  DecompressedBytes = 2,
  TrackedLiveBytes = 3,
  LayerRecords = 4,
  ChannelRecords = 5,
  ResourceRecords = 6,
  DescriptorNodes = 7,
  PatternRecords = 8,
  RetainedPayloadBytes = 9,
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
  // False is a deliberately lossy, lower-retention read: semantic models remain,
  // but preservation-only image resources, tagged blocks, path source bytes,
  // Smart Object wrappers and saved-channel display records are not promoted.
  // Known Smart Filter record storage, the layer-effects reference point
  // ('fxrp'), Photoshop layer ids ('lyid'), and Patchy compound-vector markers
  // remain because modeled editing/rendering depends on them.
  // A Document read this way is render/inspection state, not authoritative
  // byte-preserving save state.
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

struct SaveBudget {
  // Exact bytes admitted to the final PSD/PSB byte stream. Intermediate
  // serialization buffers are workspace and are deliberately not counted.
  std::uint64_t max_logical_output_bytes{std::numeric_limits<std::uint64_t>::max()};
  // Exact width * height of the document admitted once per public save.
  std::uint64_t max_canvas_pixels{std::numeric_limits<std::uint64_t>::max()};
  // Logical bytes in caller-supplied PixelBuffers reachable from the source
  // layer tree and saved document channels. Generated normalization,
  // compositor, encoding, and serialization buffers are excluded.
  std::uint64_t max_source_pixel_bytes{std::numeric_limits<std::uint64_t>::max()};
  // Physical layer records reserved for the effective PSD graph after
  // compound/open-stroke normalization, including group boundaries.
  std::uint64_t max_layer_records{std::numeric_limits<std::uint64_t>::max()};
  // Conservative physical channel-record slots. This includes a possible
  // merged-alpha slot and possible derived vector-mask planes because their
  // actual emission is data-dependent and only known after rasterization.
  std::uint64_t max_channel_records{std::numeric_limits<std::uint64_t>::max()};
};

struct SaveUsage {
  std::uint64_t logical_output_bytes{0};
  std::uint64_t canvas_pixels{0};
  std::uint64_t source_pixel_bytes{0};
  std::uint64_t layer_records{0};
  std::uint64_t channel_records{0};
};

enum class SaveBudgetDimension : std::uint8_t {
  LogicalOutputBytes = 0,
  CanvasPixels = 1,
  SourcePixelBytes = 2,
  LayerRecords = 3,
  ChannelRecords = 4,
};

class SaveBudgetExceeded final : public std::length_error {
public:
  explicit SaveBudgetExceeded(SaveBudgetDimension dimension);

  [[nodiscard]] SaveBudgetDimension dimension() const noexcept {
    return dimension_;
  }

private:
  SaveBudgetDimension dimension_;
};

struct WriteOptions {
  bool large_document{false};
  SaveBudget budget{};
  // Optional observation hook. Reset at the start of every public write.
  // Preflight fields update only after their dimension is admitted; final
  // output bytes update incrementally as the stream is serialized.
  SaveUsage* usage{nullptr};
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
