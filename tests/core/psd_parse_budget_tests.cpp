#include "core/document.hpp"
#include "core/pattern_resource.hpp"
#include "formats/miniz/miniz.h"
#include "psd/psd_binary.hpp"
#include "psd/psd_descriptor.hpp"
#include "psd/psd_document_io.hpp"
#include "psd/psd_filter_effects.hpp"
#include "psd/psd_patterns.hpp"
#include "test_groups.hpp"
#include "test_harness.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace {

void write_ascii4(patchy::psd::BigEndianWriter& writer,
                  const char (&value)[5]) {
  writer.write_bytes(std::span(
      reinterpret_cast<const std::uint8_t*>(value), 4U));
}

void write_pascal_padded(patchy::psd::BigEndianWriter& writer,
                         std::string_view value, std::size_t multiple) {
  CHECK(value.size() <= 255U);
  writer.write_u8(static_cast<std::uint8_t>(value.size()));
  writer.write_bytes(std::span(
      reinterpret_cast<const std::uint8_t*>(value.data()), value.size()));
  auto encoded_size = value.size() + 1U;
  while (encoded_size % multiple != 0U) {
    writer.write_u8(0U);
    ++encoded_size;
  }
}

std::vector<std::uint8_t> zlib_deflate(
    std::span<const std::uint8_t> source) {
  std::vector<std::uint8_t> compressed(
      mz_compressBound(static_cast<mz_ulong>(source.size())));
  mz_ulong compressed_size = static_cast<mz_ulong>(compressed.size());
  CHECK(mz_compress(compressed.data(), &compressed_size, source.data(),
                    static_cast<mz_ulong>(source.size())) == MZ_OK);
  compressed.resize(compressed_size);
  return compressed;
}

std::vector<std::uint8_t> flat_psd(std::uint16_t depth,
                                   std::uint16_t compression) {
  constexpr std::int32_t kWidth = 2;
  constexpr std::int32_t kHeight = 1;
  constexpr std::uint16_t kChannels = 3;
  const auto bytes_per_sample = static_cast<std::size_t>(depth / 8U);
  const auto row_bytes = static_cast<std::size_t>(kWidth) * bytes_per_sample;

  patchy::psd::BigEndianWriter writer;
  patchy::psd::write_header(
      writer, patchy::psd::Header{false, kChannels, kHeight, kWidth, depth, 3});
  writer.write_u32(0U);
  writer.write_u32(0U);
  writer.write_u32(0U);
  writer.write_u16(compression);

  if (compression == 0U) {
    for (std::uint16_t channel = 0; channel < kChannels; ++channel) {
      for (std::size_t byte = 0; byte < row_bytes; ++byte) {
        writer.write_u8(static_cast<std::uint8_t>(channel * 17U + byte));
      }
    }
  } else if (compression == 1U) {
    std::array<std::vector<std::uint8_t>, kChannels> rows;
    for (std::uint16_t channel = 0; channel < kChannels; ++channel) {
      std::vector<std::uint8_t> raw(row_bytes);
      for (std::size_t byte = 0; byte < row_bytes; ++byte) {
        raw[byte] = static_cast<std::uint8_t>(channel * 17U + byte);
      }
      rows[channel] = patchy::psd::encode_packbits_row(raw);
      CHECK(rows[channel].size() <= std::numeric_limits<std::uint16_t>::max());
      writer.write_u16(static_cast<std::uint16_t>(rows[channel].size()));
    }
    for (const auto& row : rows) {
      writer.write_bytes(row);
    }
  }
  return writer.bytes();
}

std::vector<std::uint8_t> deep_layer_psd(std::uint16_t depth,
                                         bool corrupt_zip = false) {
  CHECK(depth == 16U || depth == 32U);
  const auto sample_bytes = static_cast<std::size_t>(depth / 8U);
  const std::vector<std::uint8_t> raw_plane(2U * sample_bytes, 0U);
  auto predicted_plane = raw_plane;
  if (!predicted_plane.empty()) {
    predicted_plane.front() = depth == 16U ? 0x80U : 0x3fU;
  }
  auto zip = zlib_deflate(raw_plane);
  if (corrupt_zip && !zip.empty()) {
    zip.back() ^= 0xffU;
  }
  const auto zip_prediction = zlib_deflate(predicted_plane);

  struct ChannelData {
    std::int16_t id;
    std::uint16_t compression;
    const std::vector<std::uint8_t>* payload;
  };
  const std::array<ChannelData, 4> channels{{
      {-1, 0U, &raw_plane},
      {0, 3U, &zip_prediction},
      {1, 0U, &raw_plane},
      {2, 2U, &zip},
  }};

  patchy::psd::BigEndianWriter extra;
  extra.write_u32(0U);
  extra.write_u32(0U);
  write_pascal_padded(extra, depth == 16U ? "Deep 16" : "Deep 32", 4U);

  patchy::psd::BigEndianWriter layer_info;
  layer_info.write_u16(1U);
  layer_info.write_u32(0U);
  layer_info.write_u32(0U);
  layer_info.write_u32(1U);
  layer_info.write_u32(2U);
  layer_info.write_u16(static_cast<std::uint16_t>(channels.size()));
  for (const auto& channel : channels) {
    layer_info.write_u16(static_cast<std::uint16_t>(channel.id));
    layer_info.write_u32(
        static_cast<std::uint32_t>(2U + channel.payload->size()));
  }
  write_ascii4(layer_info, "8BIM");
  write_ascii4(layer_info, "norm");
  layer_info.write_u8(255U);
  layer_info.write_u8(0U);
  layer_info.write_u8(0U);
  layer_info.write_u8(0U);
  layer_info.write_u32(static_cast<std::uint32_t>(extra.bytes().size()));
  layer_info.write_bytes(extra.bytes());
  for (const auto& channel : channels) {
    layer_info.write_u16(channel.compression);
    layer_info.write_bytes(*channel.payload);
  }

  patchy::psd::BigEndianWriter layer_mask;
  layer_mask.write_u32(0U);
  layer_mask.write_u32(0U);
  write_ascii4(layer_mask, "8BIM");
  write_ascii4(layer_mask, depth == 16U ? "Lr16" : "Lr32");
  layer_mask.write_u32(static_cast<std::uint32_t>(layer_info.bytes().size()));
  layer_mask.write_bytes(layer_info.bytes());
  while (layer_mask.bytes().size() % 4U != 0U) {
    layer_mask.write_u8(0U);
  }

  patchy::psd::BigEndianWriter writer;
  patchy::psd::write_header(
      writer, patchy::psd::Header{false, 3, 1, 2, depth, 3});
  writer.write_u32(0U);
  writer.write_u32(0U);
  writer.write_u32(static_cast<std::uint32_t>(layer_mask.bytes().size()));
  writer.write_bytes(layer_mask.bytes());
  writer.write_u16(0U);
  for (std::size_t byte = 0; byte < 3U * 2U * sample_bytes; ++byte) {
    writer.write_u8(0U);
  }
  return writer.bytes();
}

std::vector<std::uint8_t> damaged_rle_layer_psd() {
  constexpr std::int32_t kWidth = 2;
  constexpr std::int32_t kHeight = 1;
  std::array<std::vector<std::uint8_t>, 3> channel_data;
  for (std::size_t channel = 0; channel < channel_data.size(); ++channel) {
    const std::array<std::uint8_t, 2> raw{
        static_cast<std::uint8_t>(10U + channel),
        static_cast<std::uint8_t>(20U + channel)};
    auto encoded = patchy::psd::encode_packbits_row(raw);
    if (channel == 2U) {
      encoded = {0x03U, 0x55U};  // Claims four literals but contains one.
    }
    patchy::psd::BigEndianWriter bytes;
    bytes.write_u16(1U);
    bytes.write_u16(static_cast<std::uint16_t>(encoded.size()));
    bytes.write_bytes(encoded);
    channel_data[channel] = bytes.bytes();
  }

  patchy::psd::BigEndianWriter extra;
  extra.write_u32(0U);
  extra.write_u32(0U);
  write_pascal_padded(extra, "Damaged", 4U);

  patchy::psd::BigEndianWriter layer_info;
  layer_info.write_u16(1U);
  layer_info.write_u32(0U);
  layer_info.write_u32(0U);
  layer_info.write_u32(kHeight);
  layer_info.write_u32(kWidth);
  layer_info.write_u16(3U);
  for (std::uint16_t channel = 0; channel < 3U; ++channel) {
    layer_info.write_u16(channel);
    layer_info.write_u32(
        static_cast<std::uint32_t>(channel_data[channel].size()));
  }
  write_ascii4(layer_info, "8BIM");
  write_ascii4(layer_info, "norm");
  layer_info.write_u8(255U);
  layer_info.write_u8(0U);
  layer_info.write_u8(0U);
  layer_info.write_u8(0U);
  layer_info.write_u32(static_cast<std::uint32_t>(extra.bytes().size()));
  layer_info.write_bytes(extra.bytes());
  for (const auto& channel : channel_data) {
    layer_info.write_bytes(channel);
  }
  if (layer_info.bytes().size() % 2U != 0U) {
    layer_info.write_u8(0U);
  }

  patchy::psd::BigEndianWriter layer_mask;
  layer_mask.write_u32(static_cast<std::uint32_t>(layer_info.bytes().size()));
  layer_mask.write_bytes(layer_info.bytes());
  layer_mask.write_u32(0U);

  patchy::psd::BigEndianWriter writer;
  patchy::psd::write_header(
      writer, patchy::psd::Header{false, 3, kHeight, kWidth, 8, 3});
  writer.write_u32(0U);
  writer.write_u32(0U);
  writer.write_u32(static_cast<std::uint32_t>(layer_mask.bytes().size()));
  writer.write_bytes(layer_mask.bytes());
  writer.write_u16(0U);
  for (std::size_t byte = 0; byte < 6U; ++byte) {
    writer.write_u8(0U);
  }
  return writer.bytes();
}

patchy::PixelBuffer rgb_pixels(std::int32_t width, std::int32_t height) {
  patchy::PixelBuffer pixels(width, height, patchy::PixelFormat::rgb8());
  for (std::int32_t y = 0; y < height; ++y) {
    for (std::int32_t x = 0; x < width; ++x) {
      auto* pixel = pixels.pixel(x, y);
      pixel[0] = static_cast<std::uint8_t>(10 + x);
      pixel[1] = static_cast<std::uint8_t>(20 + y);
      pixel[2] = 30U;
    }
  }
  return pixels;
}

void expect_decompressed_rejection(
    std::span<const std::uint8_t> bytes, std::uint64_t limit,
    std::uint64_t accepted_before_failure,
    patchy::psd::ReadOptions options = {}) {
  patchy::psd::ParseUsage usage;
  options.budget.max_decompressed_bytes = limit;
  options.usage = &usage;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::DecompressedBytes);
    CHECK(std::string(error.what()) ==
          "This PSD/PSB document is too large to import safely.");
  }
  CHECK(usage.input_bytes == bytes.size());
  CHECK(usage.decompressed_bytes == accepted_before_failure);
}

patchy::psd::ParseUsage read_with_exact_decompressed_limit(
    std::span<const std::uint8_t> bytes, std::uint64_t exact,
    patchy::psd::ReadOptions options = {}) {
  patchy::psd::ParseUsage usage;
  options.budget.max_decompressed_bytes = exact;
  options.usage = &usage;
  (void)patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.input_bytes == bytes.size());
  CHECK(usage.decompressed_bytes == exact);
  return usage;
}

void psd_decompressed_budget_api_defaults_and_usage_reset() {
  CHECK(patchy::psd::ParseBudget{}.max_decompressed_bytes ==
        std::numeric_limits<std::uint64_t>::max());
  const patchy::psd::ParseBudget positional{11U, 22U};
  CHECK(positional.max_primary_pixel_bytes == 11U);
  CHECK(positional.max_input_bytes == 22U);
  CHECK(positional.max_decompressed_bytes ==
        std::numeric_limits<std::uint64_t>::max());
  CHECK(static_cast<std::underlying_type_t<patchy::psd::ParseBudgetDimension>>(
            patchy::psd::ParseBudgetDimension::InputBytes) == 0U);
  CHECK(static_cast<std::underlying_type_t<patchy::psd::ParseBudgetDimension>>(
            patchy::psd::ParseBudgetDimension::PrimaryPixelBytes) == 1U);
  CHECK(static_cast<std::underlying_type_t<patchy::psd::ParseBudgetDimension>>(
            patchy::psd::ParseBudgetDimension::DecompressedBytes) == 2U);

  const auto valid = flat_psd(8U, 0U);
  patchy::psd::ParseUsage usage{41U, 42U, 43U};
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  CHECK(patchy::psd::DocumentIo::read(valid, options).width() == 2);
  CHECK(usage.input_bytes == valid.size());
  CHECK(usage.primary_pixel_bytes == 6U);
  CHECK(usage.decompressed_bytes == 6U);

  const std::array<std::uint8_t, 4> malformed{'8', 'B', 'P', 'S'};
  bool rejected = false;
  try {
    (void)patchy::psd::DocumentIo::read(malformed, options);
  } catch (const patchy::psd::ParseBudgetExceeded&) {
    CHECK(false);
  } catch (const std::exception&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(usage.input_bytes == malformed.size());
  CHECK(usage.primary_pixel_bytes == 0U);
  CHECK(usage.decompressed_bytes == 0U);
}

void psd_decompressed_budget_flat_depths_and_compressions_are_exact() {
  for (const auto depth : {8U, 16U, 32U}) {
    for (const auto compression : {0U, 1U}) {
      const auto bytes = flat_psd(static_cast<std::uint16_t>(depth),
                                  static_cast<std::uint16_t>(compression));
      const auto expected = 3U * 2U * (depth / 8U);
      (void)read_with_exact_decompressed_limit(bytes, expected);
      expect_decompressed_rejection(bytes, expected - 1U,
                                    2U * 2U * (depth / 8U));
    }
  }
}

void psd_decompressed_budget_deep_layers_cover_raw_zip_and_prediction() {
  for (const auto depth : {16U, 32U}) {
    const auto bytes = deep_layer_psd(static_cast<std::uint16_t>(depth));
    const auto plane_bytes = 2U * (depth / 8U);
    const auto expected = 4U * plane_bytes;
    (void)read_with_exact_decompressed_limit(bytes, expected);
    expect_decompressed_rejection(bytes, expected - 1U, 3U * plane_bytes);
  }

  const auto corrupt = deep_layer_psd(16U, true);
  // All four planes are admitted at four source bytes each. The corrupt final
  // ZIP plane is recovered by the layer parser but keeps its successful charge.
  (void)read_with_exact_decompressed_limit(corrupt, 16U);
  expect_decompressed_rejection(corrupt, 15U, 12U);
}

void psd_decompressed_budget_layer_mask_and_saved_channel_aggregate() {
  patchy::Document masked(2, 1, patchy::PixelFormat::rgb8());
  auto& masked_layer = masked.add_pixel_layer("Masked", rgb_pixels(2, 1));
  patchy::PixelBuffer mask_pixels(1, 1, patchy::PixelFormat::gray8());
  mask_pixels.clear(128U);
  masked_layer.set_mask(patchy::LayerMask{
      patchy::Rect{0, 0, 1, 1}, std::move(mask_pixels), 255U, false});
  const auto masked_bytes = patchy::psd::DocumentIo::write_layered_rgb8(masked);
  (void)read_with_exact_decompressed_limit(masked_bytes, 7U);
  expect_decompressed_rejection(masked_bytes, 6U, 6U);

  patchy::Document saved(2, 1, patchy::PixelFormat::rgb8());
  saved.add_pixel_layer("Layer", rgb_pixels(2, 1));
  patchy::PixelBuffer alpha(2, 1, patchy::PixelFormat::gray8());
  alpha.clear(77U);
  saved.add_channel(patchy::DocumentChannel(
      saved.allocate_channel_id(), "Saved Alpha",
      patchy::DocumentChannelKind::Alpha, std::move(alpha)));
  const auto saved_bytes = patchy::psd::DocumentIo::write_layered_rgb8(saved);
  (void)read_with_exact_decompressed_limit(saved_bytes, 8U);
  expect_decompressed_rejection(saved_bytes, 7U, 6U);

  patchy::psd::ReadOptions retain_options;
  retain_options.retain_flat_composite = true;
  (void)read_with_exact_decompressed_limit(saved_bytes, 14U,
                                           retain_options);

  patchy::psd::ReadOptions prefer_options;
  prefer_options.prefer_flat_composite = true;
  (void)read_with_exact_decompressed_limit(saved_bytes, 8U,
                                           prefer_options);
}

void psd_decompressed_budget_charges_admitted_damaged_rle_planes() {
  const auto bytes = damaged_rle_layer_psd();
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.budget.max_decompressed_bytes = 6U;
  options.usage = &usage;
  std::vector<std::string> notices;
  options.notices = &notices;
  CHECK(patchy::psd::DocumentIo::read(bytes, options).layers().size() == 1U);
  CHECK(usage.decompressed_bytes == 6U);
  CHECK(std::any_of(notices.begin(), notices.end(), [](const std::string& notice) {
    return notice.find("damaged") != std::string::npos;
  }));

  const auto unsupported = flat_psd(8U, 9U);
  patchy::psd::ParseUsage unsupported_usage{41U, 42U, 43U};
  patchy::psd::ReadOptions unsupported_options;
  unsupported_options.usage = &unsupported_usage;
  bool rejected = false;
  try {
    (void)patchy::psd::DocumentIo::read(unsupported, unsupported_options);
  } catch (const patchy::psd::ParseBudgetExceeded&) {
    CHECK(false);
  } catch (const std::exception&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(unsupported_usage.decompressed_bytes == 0U);

  auto truncated = flat_psd(8U, 0U);
  truncated.pop_back();
  patchy::psd::ParseUsage truncated_usage{41U, 42U, 43U};
  patchy::psd::ReadOptions truncated_options;
  truncated_options.usage = &truncated_usage;
  rejected = false;
  try {
    (void)patchy::psd::DocumentIo::read(truncated, truncated_options);
  } catch (const patchy::psd::ParseBudgetExceeded&) {
    CHECK(false);
  } catch (const std::exception&) {
    rejected = true;
  }
  CHECK(rejected);
  // The two complete planes stay charged; the truncated third plane is rejected
  // before budget admission.
  CHECK(truncated_usage.decompressed_bytes == 4U);
}

void psd_decompressed_budget_pattern_planes_escape_recovery_catches() {
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  document.add_pixel_layer("Layer", rgb_pixels(1, 1));

  patchy::PatternResource pattern;
  pattern.id = "11111111-2222-3333-4444-555555555555";
  pattern.name = "Budget pattern";
  pattern.provenance = patchy::PatternProvenance::Authored;
  pattern.tile = patchy::PixelBuffer(2, 1, patchy::PixelFormat::rgba8());
  for (std::int32_t x = 0; x < 2; ++x) {
    auto* pixel = pattern.tile.pixel(x, 0);
    pixel[0] = static_cast<std::uint8_t>(10 + x);
    pixel[1] = static_cast<std::uint8_t>(20 + x);
    pixel[2] = static_cast<std::uint8_t>(30 + x);
    pixel[3] = x == 0 ? 255U : 0U;
  }
  const std::array<patchy::PatternResource, 1> patterns{pattern};
  document.metadata().unknown_psd_resources.push_back(patchy::UnknownPsdBlock{
      "Patt", patchy::psd::serialize_patterns_block(patterns)});

  const auto bytes = patchy::psd::DocumentIo::write_layered_rgb8(document);
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.budget.max_decompressed_bytes = 11U;
  options.usage = &usage;
  const auto read = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(read.metadata().patterns.find(pattern.id) != nullptr);
  CHECK(usage.decompressed_bytes == 11U);  // RGB layer 3 + RGBA pattern 8.

  expect_decompressed_rejection(bytes, 10U, 9U);
}

void psd_decompressed_budget_filter_mask_excludes_cache_planes() {
  patchy::Document document(2, 1, patchy::PixelFormat::rgb8());
  auto source = rgb_pixels(2, 1);
  document.add_pixel_layer("Layer", source);

  patchy::SmartFilterMask mask;
  mask.bounds = patchy::Rect{0, 0, 2, 1};
  mask.pixels = patchy::PixelBuffer(2, 1, patchy::PixelFormat::gray8());
  mask.pixels.pixel(0, 0)[0] = 0U;
  mask.pixels.pixel(1, 0)[0] = 255U;
  const auto authored = patchy::psd::author_filter_effects_record(
      "01234567-89ab-cdef-8123-456789abcdef", mask.bounds, source,
      mask.bounds, mask);
  CHECK(authored.has_value());
  CHECK(document.metadata().smart_filter_effects.upsert_authored(*authored));

  const auto bytes = patchy::psd::DocumentIo::write_layered_rgb8(document);
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.budget.max_decompressed_bytes = 8U;
  options.usage = &usage;
  const auto read = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(read.metadata().smart_filter_effects.blocks.size() == 1U);
  CHECK(read.metadata().smart_filter_effects.blocks.front().records.size() == 1U);
  CHECK(read.metadata().smart_filter_effects.blocks.front()
            .records.front().mask_decoded);
  // The RGB layer contributes 6 bytes and the decoded mask contributes 2.
  // Four 2-byte FEid cache planes are validated and skipped, not decompressed.
  CHECK(usage.decompressed_bytes == 8U);

  expect_decompressed_rejection(bytes, 7U, 6U);
}

}  // namespace

std::vector<patchy::test::TestCase> psd_parse_budget_tests() {
  return {
      {"psd_decompressed_budget_api_defaults_and_usage_reset",
       psd_decompressed_budget_api_defaults_and_usage_reset},
      {"psd_decompressed_budget_flat_depths_and_compressions_are_exact",
       psd_decompressed_budget_flat_depths_and_compressions_are_exact},
      {"psd_decompressed_budget_deep_layers_cover_raw_zip_and_prediction",
       psd_decompressed_budget_deep_layers_cover_raw_zip_and_prediction},
      {"psd_decompressed_budget_layer_mask_and_saved_channel_aggregate",
       psd_decompressed_budget_layer_mask_and_saved_channel_aggregate},
      {"psd_decompressed_budget_charges_admitted_damaged_rle_planes",
       psd_decompressed_budget_charges_admitted_damaged_rle_planes},
      {"psd_decompressed_budget_pattern_planes_escape_recovery_catches",
       psd_decompressed_budget_pattern_planes_escape_recovery_catches},
      {"psd_decompressed_budget_filter_mask_excludes_cache_planes",
       psd_decompressed_budget_filter_mask_excludes_cache_planes},
  };
}
