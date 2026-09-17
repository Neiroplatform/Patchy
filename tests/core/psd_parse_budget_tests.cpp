#include "core/document.hpp"
#include "core/pattern_resource.hpp"
#include "core/smart_object.hpp"
#include "color/color_management.hpp"
#include "formats/miniz/miniz.h"
#include "psd/psd_binary.hpp"
#include "psd/psd_descriptor.hpp"
#include "psd/psd_document_io.hpp"
#include "psd/psd_filter_effects.hpp"
#include "psd/psd_patterns.hpp"
#include "psd/psd_parse_budget_internal.hpp"
#include "psd/psd_smart_objects.hpp"
#include "psd/psd_io_internal.hpp"
#include "core_test_support.hpp"
#include "psd_test_support.hpp"
#include "test_groups.hpp"
#include "test_harness.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <memory>
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

std::vector<std::uint8_t> flat_cmyk_raw_psd(std::uint16_t depth) {
  constexpr std::int32_t kWidth = 2;
  constexpr std::int32_t kHeight = 1;
  constexpr std::uint16_t kChannels = 4;
  const auto plane_bytes = static_cast<std::size_t>(kWidth) *
                           static_cast<std::size_t>(depth / 8U);
  patchy::psd::BigEndianWriter writer;
  patchy::psd::write_header(
      writer,
      patchy::psd::Header{false, kChannels, kHeight, kWidth, depth, 4U});
  writer.write_u32(0U);
  writer.write_u32(0U);
  writer.write_u32(0U);
  writer.write_u16(0U);
  for (std::uint16_t channel = 0; channel < kChannels; ++channel) {
    for (std::size_t byte = 0; byte < plane_bytes; ++byte) {
      writer.write_u8(static_cast<std::uint8_t>(255U - channel * 17U - byte));
    }
  }
  return writer.bytes();
}

std::vector<std::uint8_t> deep_layer_psd(
    std::uint16_t depth, bool corrupt_zip = false,
    bool dummy_global_before_deep = false) {
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
  if (dummy_global_before_deep) {
    write_ascii4(layer_mask, "8BIM");
    write_ascii4(layer_mask, "zzzz");
    layer_mask.write_u32(0U);
  }
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

void write_tagged_block(patchy::psd::BigEndianWriter& writer,
                        const char (&key)[5],
                        std::span<const std::uint8_t> payload) {
  write_ascii4(writer, "8BIM");
  write_ascii4(writer, key);
  CHECK(payload.size() <= std::numeric_limits<std::uint32_t>::max());
  writer.write_u32(static_cast<std::uint32_t>(payload.size()));
  writer.write_bytes(payload);
  if (payload.size() % 2U != 0U) {
    writer.write_u8(0U);
  }
}

std::vector<std::uint8_t> structural_records_psd(
    std::span<const std::uint8_t> layer_block_payload = {},
    const char (&layer_block_key)[5] = "zzzz",
    std::span<const std::uint8_t> global_block_payload = {},
    const char (&global_block_key)[5] = "zzzy",
    std::span<const std::uint8_t> global_mask_payload = {},
    std::size_t layer_block_repeat = 1U) {
  patchy::psd::BigEndianWriter image_resources;
  write_ascii4(image_resources, "8BIM");
  image_resources.write_u16(0x7fffU);
  write_pascal_padded(image_resources, "", 2U);
  image_resources.write_u32(0U);

  patchy::psd::BigEndianWriter extra;
  extra.write_u32(0U);
  extra.write_u32(0U);
  write_pascal_padded(extra, "Structural", 4U);
  for (std::size_t index = 0; index < layer_block_repeat; ++index) {
    write_tagged_block(extra, layer_block_key, layer_block_payload);
  }

  patchy::psd::BigEndianWriter layer_info;
  layer_info.write_u16(1U);
  layer_info.write_u32(0U);
  layer_info.write_u32(0U);
  layer_info.write_u32(1U);
  layer_info.write_u32(1U);
  layer_info.write_u16(3U);
  for (std::uint16_t channel = 0; channel < 3U; ++channel) {
    layer_info.write_u16(channel);
    layer_info.write_u32(3U);  // RAW marker plus one sample.
  }
  write_ascii4(layer_info, "8BIM");
  write_ascii4(layer_info, "norm");
  layer_info.write_u8(255U);
  layer_info.write_u8(0U);
  layer_info.write_u8(0U);
  layer_info.write_u8(0U);
  layer_info.write_u32(static_cast<std::uint32_t>(extra.bytes().size()));
  layer_info.write_bytes(extra.bytes());
  for (std::uint16_t channel = 0; channel < 3U; ++channel) {
    layer_info.write_u16(0U);
    layer_info.write_u8(static_cast<std::uint8_t>(10U + channel));
  }
  if (layer_info.bytes().size() % 2U != 0U) {
    layer_info.write_u8(0U);
  }

  patchy::psd::BigEndianWriter layer_mask;
  layer_mask.write_u32(static_cast<std::uint32_t>(layer_info.bytes().size()));
  layer_mask.write_bytes(layer_info.bytes());
  layer_mask.write_u32(static_cast<std::uint32_t>(global_mask_payload.size()));
  layer_mask.write_bytes(global_mask_payload);
  write_tagged_block(layer_mask, global_block_key, global_block_payload);

  patchy::psd::BigEndianWriter writer;
  patchy::psd::write_header(
      writer, patchy::psd::Header{false, 3, 1, 1, 8, 3});
  writer.write_u32(0U);
  writer.write_u32(static_cast<std::uint32_t>(image_resources.bytes().size()));
  writer.write_bytes(image_resources.bytes());
  writer.write_u32(static_cast<std::uint32_t>(layer_mask.bytes().size()));
  writer.write_bytes(layer_mask.bytes());
  writer.write_u16(0U);
  writer.write_u8(10U);
  writer.write_u8(11U);
  writer.write_u8(12U);
  return writer.bytes();
}

std::vector<std::uint8_t> descriptor_block_payload() {
  patchy::psd::DescriptorObject descriptor;
  descriptor.class_id = "null";
  patchy::psd::DescriptorValue value;
  value.type = patchy::psd::DescriptorValue::Type::Integer;
  value.integer_value = 7;
  descriptor.values["value"] = value;

  patchy::psd::BigEndianWriter writer;
  writer.write_u32(16U);
  patchy::psd::write_descriptor(writer, descriptor);
  return writer.bytes();
}

std::vector<std::uint8_t> descriptor_object_array_block_payload(
    std::int32_t row_count) {
  auto rows = std::make_shared<patchy::psd::DescriptorObject>();
  rows->class_id = "null";

  patchy::psd::DescriptorValue value;
  value.type = patchy::psd::DescriptorValue::Type::ObjectArray;
  value.integer_value = row_count;
  value.object_value = std::move(rows);

  patchy::psd::DescriptorObject descriptor;
  descriptor.class_id = "null";
  descriptor.values["rows"] = std::move(value);

  patchy::psd::BigEndianWriter writer;
  writer.write_u32(16U);
  patchy::psd::write_descriptor(writer, descriptor);
  return writer.bytes();
}

patchy::PatternResource budget_pattern(std::string id, std::uint8_t value) {
  patchy::PatternResource pattern;
  pattern.id = std::move(id);
  pattern.name = "Structural budget pattern";
  pattern.provenance = patchy::PatternProvenance::Authored;
  pattern.tile = patchy::PixelBuffer(1, 1, patchy::PixelFormat::rgba8());
  auto* pixel = pattern.tile.pixel(0, 0);
  pixel[0] = value;
  pixel[1] = static_cast<std::uint8_t>(value + 1U);
  pixel[2] = static_cast<std::uint8_t>(value + 2U);
  pixel[3] = 255U;
  return pattern;
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

void expect_tracked_live_rejection(
    std::span<const std::uint8_t> bytes, std::uint64_t limit,
    std::uint64_t expected_high_water,
    patchy::psd::ReadOptions options = {}) {
  patchy::psd::ParseUsage usage;
  options.budget.max_tracked_live_bytes = limit;
  options.usage = &usage;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
    CHECK(std::string(error.what()) ==
          "This PSD/PSB document is too large to import safely.");
  }
  CHECK(usage.input_bytes == bytes.size());
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == expected_high_water);
}

void expect_retained_payload_rejection(
    std::span<const std::uint8_t> bytes, std::uint64_t limit,
    std::uint64_t accepted_before_failure,
    patchy::psd::ReadOptions options = {}) {
  patchy::psd::ParseUsage usage;
  options.budget.max_retained_payload_bytes = limit;
  options.usage = &usage;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::RetainedPayloadBytes);
    CHECK(std::string(error.what()) ==
          "This PSD/PSB document is too large to import safely.");
  }
  CHECK(usage.input_bytes == bytes.size());
  CHECK(usage.retained_payload_bytes == accepted_before_failure);
}

void psd_decompressed_budget_api_defaults_and_usage_reset() {
  CHECK(patchy::psd::ParseBudget{}.max_decompressed_bytes ==
        std::numeric_limits<std::uint64_t>::max());
  CHECK(patchy::psd::ParseBudget{}.max_tracked_live_bytes ==
        std::numeric_limits<std::uint64_t>::max());
  const patchy::psd::ParseBudget positional{11U, 22U};
  CHECK(positional.max_primary_pixel_bytes == 11U);
  CHECK(positional.max_input_bytes == 22U);
  CHECK(positional.max_decompressed_bytes ==
        std::numeric_limits<std::uint64_t>::max());
  CHECK(positional.max_tracked_live_bytes ==
        std::numeric_limits<std::uint64_t>::max());
  CHECK(static_cast<std::underlying_type_t<patchy::psd::ParseBudgetDimension>>(
            patchy::psd::ParseBudgetDimension::InputBytes) == 0U);
  CHECK(static_cast<std::underlying_type_t<patchy::psd::ParseBudgetDimension>>(
            patchy::psd::ParseBudgetDimension::PrimaryPixelBytes) == 1U);
  CHECK(static_cast<std::underlying_type_t<patchy::psd::ParseBudgetDimension>>(
            patchy::psd::ParseBudgetDimension::DecompressedBytes) == 2U);
  CHECK(static_cast<std::underlying_type_t<patchy::psd::ParseBudgetDimension>>(
            patchy::psd::ParseBudgetDimension::TrackedLiveBytes) == 3U);

  const auto valid = flat_psd(8U, 0U);
  patchy::psd::ParseUsage usage{41U, 42U, 43U};
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  CHECK(patchy::psd::DocumentIo::read(valid, options).width() == 2);
  CHECK(usage.input_bytes == valid.size());
  CHECK(usage.primary_pixel_bytes == 6U);
  CHECK(usage.decompressed_bytes == 6U);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 6U);

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
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 0U);
}

void psd_structural_budget_api_defaults_enum_and_usage_reset() {
  const auto unlimited = std::numeric_limits<std::uint64_t>::max();
  const patchy::psd::ParseBudget defaults;
  CHECK(defaults.max_layer_records == unlimited);
  CHECK(defaults.max_channel_records == unlimited);
  CHECK(defaults.max_resource_records == unlimited);
  CHECK(defaults.max_descriptor_nodes == unlimited);
  CHECK(defaults.max_pattern_records == unlimited);
  CHECK(defaults.max_retained_payload_bytes == unlimited);

  const patchy::psd::ParseBudget positional{11U, 22U, 33U, 44U};
  CHECK(positional.max_primary_pixel_bytes == 11U);
  CHECK(positional.max_input_bytes == 22U);
  CHECK(positional.max_decompressed_bytes == 33U);
  CHECK(positional.max_tracked_live_bytes == 44U);
  CHECK(positional.max_layer_records == unlimited);
  CHECK(positional.max_channel_records == unlimited);
  CHECK(positional.max_resource_records == unlimited);
  CHECK(positional.max_descriptor_nodes == unlimited);
  CHECK(positional.max_pattern_records == unlimited);
  CHECK(positional.max_retained_payload_bytes == unlimited);

  const patchy::psd::ParseUsage positional_usage{1U, 2U, 3U, 4U, 5U};
  CHECK(positional_usage.layer_records == 0U);
  CHECK(positional_usage.channel_records == 0U);
  CHECK(positional_usage.resource_records == 0U);
  CHECK(positional_usage.descriptor_nodes == 0U);
  CHECK(positional_usage.pattern_records == 0U);
  CHECK(positional_usage.retained_payload_bytes == 0U);

  using DimensionType =
      std::underlying_type_t<patchy::psd::ParseBudgetDimension>;
  CHECK(static_cast<DimensionType>(
            patchy::psd::ParseBudgetDimension::LayerRecords) == 4U);
  CHECK(static_cast<DimensionType>(
            patchy::psd::ParseBudgetDimension::ChannelRecords) == 5U);
  CHECK(static_cast<DimensionType>(
            patchy::psd::ParseBudgetDimension::ResourceRecords) == 6U);
  CHECK(static_cast<DimensionType>(
            patchy::psd::ParseBudgetDimension::DescriptorNodes) == 7U);
  CHECK(static_cast<DimensionType>(
            patchy::psd::ParseBudgetDimension::PatternRecords) == 8U);
  CHECK(static_cast<DimensionType>(
            patchy::psd::ParseBudgetDimension::RetainedPayloadBytes) == 9U);

  const auto valid = flat_psd(8U, 0U);
  patchy::psd::ParseUsage usage;
  usage.layer_records = 51U;
  usage.channel_records = 52U;
  usage.resource_records = 53U;
  usage.descriptor_nodes = 54U;
  usage.pattern_records = 55U;
  usage.retained_payload_bytes = 56U;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  CHECK(patchy::psd::DocumentIo::read(valid, options).width() == 2);
  CHECK(usage.layer_records == 0U);
  CHECK(usage.channel_records == 3U);
  CHECK(usage.resource_records == 0U);
  CHECK(usage.descriptor_nodes == 0U);
  CHECK(usage.pattern_records == 0U);
  CHECK(usage.retained_payload_bytes == 0U);

  usage.layer_records = 61U;
  usage.channel_records = 62U;
  usage.resource_records = 63U;
  usage.descriptor_nodes = 64U;
  usage.pattern_records = 65U;
  usage.retained_payload_bytes = 66U;
  const std::array<std::uint8_t, 4> malformed{'8', 'B', 'P', 'S'};
  bool malformed_rejected = false;
  try {
    (void)patchy::psd::DocumentIo::read(malformed, options);
  } catch (const patchy::psd::ParseBudgetExceeded&) {
    CHECK(false);
  } catch (const std::exception&) {
    malformed_rejected = true;
  }
  CHECK(malformed_rejected);
  CHECK(usage.layer_records == 0U);
  CHECK(usage.channel_records == 0U);
  CHECK(usage.resource_records == 0U);
  CHECK(usage.descriptor_nodes == 0U);
  CHECK(usage.pattern_records == 0U);
  CHECK(usage.retained_payload_bytes == 0U);
}

void psd_structural_budget_layers_channels_and_resources_are_exact() {
  const auto bytes = structural_records_psd();
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_layer_records = 1U;
  options.budget.max_channel_records = 6U;
  options.budget.max_resource_records = 3U;
  CHECK(patchy::psd::DocumentIo::read(bytes, options).layers().size() == 1U);
  CHECK(usage.layer_records == 1U);
  CHECK(usage.channel_records == 6U);
  CHECK(usage.resource_records == 3U);

  const auto expect_rejection = [&](patchy::psd::ParseBudgetDimension dimension,
                                    std::uint64_t expected_layers,
                                    std::uint64_t expected_channels,
                                    std::uint64_t expected_resources) {
    try {
      (void)patchy::psd::DocumentIo::read(bytes, options);
      CHECK(false);
    } catch (const patchy::psd::ParseBudgetExceeded& error) {
      CHECK(error.dimension() == dimension);
      CHECK(std::string(error.what()) ==
            "This PSD/PSB document is too large to import safely.");
    }
    CHECK(usage.layer_records == expected_layers);
    CHECK(usage.channel_records == expected_channels);
    CHECK(usage.resource_records == expected_resources);
  };

  options.budget.max_layer_records = 0U;
  expect_rejection(patchy::psd::ParseBudgetDimension::LayerRecords,
                   0U, 3U, 1U);
  options.budget.max_layer_records = 1U;
  options.budget.max_channel_records = 5U;
  expect_rejection(patchy::psd::ParseBudgetDimension::ChannelRecords,
                   1U, 3U, 1U);
  options.budget.max_channel_records = 6U;
  options.budget.max_resource_records = 2U;
  expect_rejection(patchy::psd::ParseBudgetDimension::ResourceRecords,
                   1U, 6U, 2U);
}

void psd_structural_budget_descriptor_rejection_escapes_recovery() {
  const auto payload = descriptor_block_payload();
  const auto bytes = structural_records_psd(payload, "SoCo");
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_descriptor_nodes = 2U;
  CHECK(patchy::psd::DocumentIo::read(bytes, options).layers().size() == 1U);
  CHECK(usage.descriptor_nodes == 2U);

  options.budget.max_descriptor_nodes = 1U;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::DescriptorNodes);
    CHECK(std::string(error.what()) ==
          "This PSD/PSB document is too large to import safely.");
  }
  // Root plus declared fields are one admission, so the rejected aggregate
  // leaves the usage unchanged.
  CHECK(usage.descriptor_nodes == 0U);
}

void psd_structural_budget_object_array_charges_rows_before_nested_descriptor() {
  const auto payload = descriptor_object_array_block_payload(3);
  const auto bytes = structural_records_psd(payload, "SoCo");
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_descriptor_nodes = 6U;
  CHECK(patchy::psd::DocumentIo::read(bytes, options).layers().size() == 1U);
  CHECK(usage.descriptor_nodes == 6U);

  options.budget.max_descriptor_nodes = 5U;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::DescriptorNodes);
    CHECK(std::string(error.what()) ==
          "This PSD/PSB document is too large to import safely.");
  }
  // The outer descriptor and the independently validated ObAr row count are
  // admitted first. The nested empty descriptor is one atomic rejected node.
  CHECK(usage.descriptor_nodes == 5U);
}

void psd_structural_budget_layer_count_uses_declared_subsection() {
  auto bytes = structural_records_psd();
  // Header (26), color-mode length (4), image-resource length + bytes (16),
  // then the outer layer/mask length (4). Leave only the signed layer count in
  // the declared layer-info subsection while retaining ample trailing bytes.
  constexpr std::size_t kLayerInfoLengthOffset = 50U;
  CHECK(bytes.size() > kLayerInfoLengthOffset + 4U);
  bytes[kLayerInfoLengthOffset + 0U] = 0U;
  bytes[kLayerInfoLengthOffset + 1U] = 0U;
  bytes[kLayerInfoLengthOffset + 2U] = 0U;
  bytes[kLayerInfoLengthOffset + 3U] = 2U;

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_layer_records = 0U;
  bool malformed_rejected = false;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
  } catch (const patchy::psd::ParseBudgetExceeded&) {
    CHECK(false);
  } catch (const std::exception&) {
    malformed_rejected = true;
  }
  CHECK(malformed_rejected);
  CHECK(usage.layer_records == 0U);
}

void psd_structural_budget_prefer_flat_charges_only_traversed_records() {
  const auto descriptor_payload = descriptor_block_payload();
  const std::array<patchy::PatternResource, 1> patterns{
      budget_pattern("33333333-3333-3333-3333-333333333333", 30U)};
  const auto pattern_payload = patchy::psd::serialize_patterns_block(patterns);
  const auto bytes = structural_records_psd(
      descriptor_payload, "SoCo", pattern_payload, "Patt");

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.prefer_flat_composite = true;
  options.usage = &usage;
  options.budget.max_layer_records = 0U;
  options.budget.max_channel_records = 3U;
  options.budget.max_resource_records = 1U;
  options.budget.max_descriptor_nodes = 0U;
  options.budget.max_pattern_records = 0U;
  CHECK(patchy::psd::DocumentIo::read(bytes, options).width() == 1);
  CHECK(usage.layer_records == 0U);
  CHECK(usage.channel_records == 3U);
  CHECK(usage.resource_records == 1U);
  CHECK(usage.descriptor_nodes == 0U);
  CHECK(usage.pattern_records == 0U);
}

void psd_structural_budget_prefer_flat_deep_headers_are_exact() {
  for (const auto depth : {16U, 32U}) {
    const auto bytes = deep_layer_psd(
        static_cast<std::uint16_t>(depth), false, true);
    patchy::psd::ParseUsage usage;
    patchy::psd::ReadOptions options;
    options.prefer_flat_composite = true;
    options.usage = &usage;
    options.budget.max_layer_records = 0U;
    options.budget.max_channel_records = 3U;
    options.budget.max_resource_records = 2U;
    options.budget.max_descriptor_nodes = 0U;
    options.budget.max_pattern_records = 0U;
    CHECK(patchy::psd::DocumentIo::read(bytes, options).width() == 2);
    CHECK(usage.layer_records == 0U);
    CHECK(usage.channel_records == 3U);
    CHECK(usage.resource_records == 2U);
    CHECK(usage.descriptor_nodes == 0U);
    CHECK(usage.pattern_records == 0U);

    options.budget.max_resource_records = 1U;
    try {
      (void)patchy::psd::DocumentIo::read(bytes, options);
      CHECK(false);
    } catch (const patchy::psd::ParseBudgetExceeded& error) {
      CHECK(error.dimension() ==
            patchy::psd::ParseBudgetDimension::ResourceRecords);
      CHECK(std::string(error.what()) ==
            "This PSD/PSB document is too large to import safely.");
    }
    CHECK(usage.layer_records == 0U);
    CHECK(usage.channel_records == 3U);
    CHECK(usage.resource_records == 1U);
    CHECK(usage.descriptor_nodes == 0U);
    CHECK(usage.pattern_records == 0U);
  }
}

void psd_structural_budget_patterns_aggregate_and_validate_before_charge() {
  const std::array<patchy::PatternResource, 2> patterns{
      budget_pattern("11111111-1111-1111-1111-111111111111", 10U),
      budget_pattern("22222222-2222-2222-2222-222222222222", 20U)};
  const auto payload = patchy::psd::serialize_patterns_block(patterns);
  const auto bytes = structural_records_psd({}, "zzzz", payload, "Patt");
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_pattern_records = 2U;
  CHECK(patchy::psd::DocumentIo::read(bytes, options)
            .metadata().patterns.patterns.size() == 2U);
  CHECK(usage.pattern_records == 2U);

  options.budget.max_pattern_records = 1U;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::PatternRecords);
    CHECK(std::string(error.what()) ==
          "This PSD/PSB document is too large to import safely.");
  }
  CHECK(usage.pattern_records == 1U);

  const std::array<patchy::PatternResource, 1> first_pattern{patterns.front()};
  auto malformed_payload =
      patchy::psd::serialize_patterns_block(first_pattern);
  patchy::psd::BigEndianWriter invalid_record;
  invalid_record.write_u32(32U);
  for (std::size_t byte = 0; byte < 12U; ++byte) {
    invalid_record.write_u8(0U);
  }
  malformed_payload.insert(malformed_payload.end(),
                           invalid_record.bytes().begin(),
                           invalid_record.bytes().end());
  const auto malformed_bytes =
      structural_records_psd({}, "zzzz", malformed_payload, "Patt");
  options.budget.max_pattern_records = 1U;
  const auto recovered =
      patchy::psd::DocumentIo::read(malformed_bytes, options);
  CHECK(recovered.metadata().patterns.patterns.size() == 1U);
  CHECK(usage.pattern_records == 1U);
}

void psd_retained_payload_budget_raw_owners_and_lossy_mode_are_exact() {
  const std::array<std::uint8_t, 3> layer_payload{1U, 2U, 3U};
  const std::array<std::uint8_t, 5> global_payload{4U, 5U, 6U, 7U, 8U};
  const std::array<std::uint8_t, 4> global_mask{9U, 10U, 11U, 12U};
  const auto bytes = structural_records_psd(
      layer_payload, "zzzz", global_payload, "zzzy", global_mask);
  constexpr std::uint64_t kImageResources = 12U;
  constexpr std::uint64_t kExact =
      kImageResources + layer_payload.size() + global_payload.size() +
      global_mask.size();

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_retained_payload_bytes = kExact;
  const auto preserved = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == kExact);
  CHECK(preserved.metadata().raw_psd_image_resources.size() ==
        kImageResources);
  CHECK(preserved.metadata().raw_psd_global_layer_mask_info.size() ==
        global_mask.size());
  CHECK(preserved.layers().front().unknown_psd_blocks().size() == 1U);
  CHECK(preserved.metadata().unknown_psd_resources.size() == 1U);

  expect_retained_payload_rejection(bytes, kExact - 1U,
                                    kExact - global_payload.size());

  options.preserve_unknown_blocks = false;
  options.budget.max_retained_payload_bytes = 0U;
  const auto lossy = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == 0U);
  CHECK(lossy.metadata().raw_psd_image_resources.empty());
  CHECK(lossy.metadata().raw_psd_global_layer_mask_info.empty());
  CHECK(lossy.layers().front().unknown_psd_blocks().empty());
  CHECK(lossy.metadata().unknown_psd_resources.empty());
  CHECK(lossy.layers().front().pixels().data().size() ==
        preserved.layers().front().pixels().data().size());
  CHECK(std::equal(lossy.layers().front().pixels().data().begin(),
                   lossy.layers().front().pixels().data().end(),
                   preserved.layers().front().pixels().data().begin()));

  options.prefer_flat_composite = true;
  options.preserve_unknown_blocks = true;
  options.budget.max_retained_payload_bytes = kImageResources;
  const auto flat = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(flat.width() == 1);
  CHECK(usage.retained_payload_bytes == kImageResources);
  expect_retained_payload_rejection(bytes, kImageResources - 1U, 0U,
                                    options);
}

void psd_retained_payload_budget_patterns_count_raw_and_decoded_owners() {
  const std::array<patchy::PatternResource, 2> patterns{
      budget_pattern("11111111-1111-1111-1111-111111111111", 10U),
      budget_pattern("22222222-2222-2222-2222-222222222222", 20U)};
  const auto payload = patchy::psd::serialize_patterns_block(patterns);
  const auto bytes = structural_records_psd({}, "zzzz", payload, "Patt");
  constexpr std::uint64_t kImageResources = 12U;
  constexpr std::uint64_t kTiles = 2U * 4U;
  const auto exact = kImageResources + kTiles + payload.size();

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_retained_payload_bytes = exact;
  const auto preserved = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == exact);
  CHECK(preserved.metadata().patterns.patterns.size() == 2U);
  CHECK(preserved.metadata().unknown_psd_resources.size() == 1U);
  expect_retained_payload_rejection(bytes, exact - 1U,
                                    kImageResources + kTiles);

  options.preserve_unknown_blocks = false;
  options.budget.max_retained_payload_bytes = kTiles;
  const auto lossy = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == kTiles);
  CHECK(lossy.metadata().patterns.patterns.size() == 2U);
  CHECK(lossy.metadata().unknown_psd_resources.empty());
  expect_retained_payload_rejection(bytes, kTiles - 1U, 4U, options);

  const std::array<patchy::PatternResource, 2> duplicate_patterns{
      budget_pattern("33333333-3333-3333-3333-333333333333", 30U),
      budget_pattern("33333333-3333-3333-3333-333333333333", 40U)};
  const auto duplicate_payload =
      patchy::psd::serialize_patterns_block(duplicate_patterns);
  const auto duplicate_bytes =
      structural_records_psd({}, "zzzz", duplicate_payload, "Patt");
  const auto duplicate_exact =
      kImageResources + kTiles + duplicate_payload.size();
  options.preserve_unknown_blocks = true;
  options.budget.max_retained_payload_bytes = duplicate_exact;
  const auto deduplicated =
      patchy::psd::DocumentIo::read(duplicate_bytes, options);
  CHECK(deduplicated.metadata().patterns.patterns.size() == 1U);
  CHECK(usage.retained_payload_bytes == duplicate_exact);
  expect_retained_payload_rejection(
      duplicate_bytes, duplicate_exact - 1U,
      kImageResources + kTiles, options);
}

void psd_retained_payload_budget_saved_channel_display_is_exact() {
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  document.add_pixel_layer("Layer", rgb_pixels(1, 1));
  patchy::PixelBuffer samples(1, 1, patchy::PixelFormat::gray8());
  samples.data()[0] = 127U;
  patchy::DocumentChannel channel(
      document.allocate_channel_id(), "Alpha", patchy::DocumentChannelKind::Alpha,
      std::move(samples));
  patchy::psd::BigEndianWriter display;
  display.write_u16(0U);      // RGB color space.
  display.write_u16(257U);    // red = 1
  display.write_u16(514U);    // green = 2
  display.write_u16(771U);    // blue = 3
  display.write_u16(0U);
  display.write_u16(50U);     // opacity percent
  display.write_u8(0U);       // masked areas
  const auto display_record = display.bytes();
  channel.set_raw_photoshop_display_info(display_record);
  document.add_channel(std::move(channel));
  const auto bytes = patchy::psd::DocumentIo::write_layered_rgb8(document);

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  const auto measured = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(measured.channels().size() == 1U);
  CHECK(measured.channels().front().raw_photoshop_display_info() ==
        display_record);
  const auto exact = usage.retained_payload_bytes;
  CHECK(exact >= display_record.size());

  options.budget.max_retained_payload_bytes = exact;
  CHECK(patchy::psd::DocumentIo::read(bytes, options)
            .channels()
            .front()
            .raw_photoshop_display_info() == display_record);
  CHECK(usage.retained_payload_bytes == exact);
  expect_retained_payload_rejection(
      bytes, exact - 1U, exact - display_record.size(), options);

  options.preserve_unknown_blocks = false;
  const auto lossy = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(lossy.channels().size() == 1U);
  CHECK(lossy.channels().front().raw_photoshop_display_info().empty());
}

void psd_retained_payload_budget_document_path_source_is_exact() {
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  document.add_pixel_layer("Layer", rgb_pixels(1, 1));
  document.add_path(patchy::DocumentPath(
      document.allocate_path_id(), "Budget Path",
      patchy::DocumentPathKind::Saved, patchy::VectorPath{}));
  const auto bytes = patchy::psd::DocumentIo::write_layered_rgb8(document);

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  const auto measured = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(measured.paths().size() == 1U);
  CHECK(measured.paths().front().raw_payload() != nullptr);
  const auto path_bytes = measured.paths().front().raw_payload()->size();
  CHECK(path_bytes > 0U);
  const auto exact = usage.retained_payload_bytes;

  options.budget.max_retained_payload_bytes = exact;
  CHECK(patchy::psd::DocumentIo::read(bytes, options)
            .paths()
            .front()
            .raw_payload() != nullptr);
  CHECK(usage.retained_payload_bytes == exact);
  expect_retained_payload_rejection(bytes, exact - 1U,
                                    exact - path_bytes, options);

  options.preserve_unknown_blocks = false;
  const auto lossy = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(lossy.paths().size() == 1U);
  CHECK(lossy.paths().front().raw_payload() == nullptr);
}

void psd_retained_payload_budget_lossy_keeps_effects_reference_point() {
  patchy::psd::BigEndianWriter payload;
  patchy::psd::write_f64(payload, 12.5);
  patchy::psd::write_f64(payload, -3.25);
  const auto bytes = structural_records_psd(payload.bytes(), "fxrp");

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.preserve_unknown_blocks = false;
  options.budget.max_retained_payload_bytes = payload.bytes().size();
  options.usage = &usage;
  const auto read = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == payload.bytes().size());
  CHECK(read.layers().front().unknown_psd_blocks().size() == 1U);
  CHECK(read.layers().front().unknown_psd_blocks().front().key == "fxrp");
  const auto point =
      patchy::layer_effects_reference_point(read.layers().front());
  CHECK(point[0] == 12.5);
  CHECK(point[1] == -3.25);
  expect_retained_payload_rejection(bytes, payload.bytes().size() - 1U,
                                    0U, options);

  const std::array<std::uint8_t, 8> compound_payload{
      'P', 'V', 'C', 'L', 0U, 0U, 0U, 1U};
  for (const auto& compound_bytes : {
           structural_records_psd(compound_payload, "pvcl"),
           structural_records_psd(compound_payload, "pvfi")}) {
    options.budget.max_retained_payload_bytes = compound_payload.size();
    const auto compound =
        patchy::psd::DocumentIo::read(compound_bytes, options);
    CHECK(usage.retained_payload_bytes == compound_payload.size());
    CHECK(compound.layers().front().unknown_psd_blocks().size() == 1U);
    expect_retained_payload_rejection(
        compound_bytes, compound_payload.size() - 1U, 0U, options);
  }

  const std::array<std::uint8_t, 4> layer_id{0U, 0U, 0U, 7U};
  const auto layer_id_bytes = structural_records_psd(layer_id, "lyid");
  options.budget.max_retained_payload_bytes = layer_id.size();
  const auto identified =
      patchy::psd::DocumentIo::read(layer_id_bytes, options);
  CHECK(usage.retained_payload_bytes == layer_id.size());
  CHECK(patchy::photoshop_layer_id(identified.layers().front()) == 7U);
  expect_retained_payload_rejection(layer_id_bytes, layer_id.size() - 1U,
                                    0U, options);

  const std::array<std::uint8_t, 2> short_payload{1U, 2U};
  const std::array<std::uint8_t, 8> wrong_compound{
      'N', 'O', 'T', '!', 0U, 0U, 0U, 1U};
  const std::array<std::uint8_t, 4> zero_layer_id{};
  for (const auto& malformed_bytes : {
           structural_records_psd(short_payload, "fxrp"),
           structural_records_psd(wrong_compound, "pvcl"),
           structural_records_psd(wrong_compound, "pvfi"),
           structural_records_psd(zero_layer_id, "lyid")}) {
    options.budget.max_retained_payload_bytes = 0U;
    const auto malformed =
        patchy::psd::DocumentIo::read(malformed_bytes, options);
    CHECK(usage.retained_payload_bytes == 0U);
    CHECK(malformed.layers().front().unknown_psd_blocks().empty());
  }
}

void psd_retained_payload_folder_state_transfer_keeps_shared_owners() {
  patchy::Layer source(0U, "Folder source", patchy::LayerKind::Pixel);
  auto stack = patchy::test::test_gaussian_smart_filter_stack(1.0);
  stack.mask.pixels =
      patchy::PixelBuffer(2, 1, patchy::PixelFormat::gray8());
  source.set_smart_filter_stack(std::move(stack));
  patchy::VectorShapeContent shape;
  shape.origination.push_back(patchy::LiveShapeParams{});
  source.set_vector_shape(std::move(shape));
  patchy::LayerVectorMask mask;
  mask.cache = patchy::PixelBuffer(2, 1, patchy::PixelFormat::gray8());
  source.set_vector_mask(std::move(mask));

  const auto* stack_owner = source.smart_filter_stack();
  const auto* shape_owner = source.vector_shape();
  const auto* mask_owner = source.vector_mask();
  patchy::Layer folder(0U, "Folder", patchy::LayerKind::Group);
  folder.move_shared_models_from(source);
  CHECK(folder.smart_filter_stack() == stack_owner);
  CHECK(folder.vector_shape() == shape_owner);
  CHECK(folder.vector_mask() == mask_owner);
  CHECK(source.smart_filter_stack() == nullptr);
  CHECK(source.vector_shape() == nullptr);
  CHECK(source.vector_mask() == nullptr);
}

void psd_retained_payload_live_shape_descriptor_is_admitted_before_growth() {
  patchy::psd::DescriptorObject entry;
  entry.class_id = "null";
  patchy::psd::DescriptorValue type;
  type.type = patchy::psd::DescriptorValue::Type::Integer;
  type.integer_value = 0;
  entry.values.emplace("keyOriginType", std::move(type));
  entry.key_order.push_back({"keyOriginType", true});
  for (int index = 0; index < 12; ++index) {
    const auto key = "customField" + std::to_string(index);
    patchy::psd::DescriptorValue value;
    value.type = patchy::psd::DescriptorValue::Type::String;
    value.string_value = "descriptor-value-" + std::to_string(index);
    entry.values.emplace(key, std::move(value));
    entry.key_order.push_back({key, true});
  }
  patchy::psd::BigEndianWriter raw_writer;
  patchy::psd::write_descriptor(raw_writer, entry);
  patchy::LiveShapeParams custom;
  custom.kind = patchy::LiveShapeKind::Custom;
  custom.raw_descriptor = raw_writer.bytes();
  const std::array<patchy::LiveShapeParams, 1> source{custom};
  const auto payload =
      patchy::psd::vector_origination_block_payload(source, nullptr);

  const auto parse_with_limits = [&](std::uint64_t retained_limit,
                                     std::uint64_t live_limit,
                                     std::uint64_t& retained_usage,
                                     std::uint64_t& live_current,
                                     std::uint64_t& live_high) {
    patchy::psd::ParseBudgetTracker retained(
        retained_limit, &retained_usage,
        patchy::psd::ParseBudgetDimension::RetainedPayloadBytes);
    patchy::psd::ParseLiveBudgetTracker live(
        live_limit, &live_current, &live_high);
    return patchy::psd::parse_vector_origination_block(
        payload, &retained, &live);
  };

  std::uint64_t retained_usage = 0U;
  std::uint64_t live_current = 0U;
  std::uint64_t live_high = 0U;
  const auto exact = custom.raw_descriptor.size();
  const auto parsed = parse_with_limits(
      exact, exact, retained_usage, live_current, live_high);
  CHECK(parsed.has_value() && parsed->size() == 1U);
  CHECK(parsed->front().raw_descriptor == custom.raw_descriptor);
  CHECK(retained_usage == exact);
  CHECK(live_current == 0U);
  CHECK(live_high == exact);

  retained_usage = live_current = live_high = 0U;
  try {
    (void)parse_with_limits(exact - 1U, exact, retained_usage,
                            live_current, live_high);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::RetainedPayloadBytes);
  }
  CHECK(retained_usage <= exact - 1U);
  CHECK(live_current == 0U);

  retained_usage = live_current = live_high = 0U;
  try {
    (void)parse_with_limits(exact, exact - 1U, retained_usage,
                            live_current, live_high);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
  }
  CHECK(live_current == 0U);
  CHECK(live_high <= exact - 1U);
}

void psd_retained_payload_budget_many_small_owners_are_aggregate() {
  constexpr std::size_t kOwnerCount = 64U;
  const std::array<std::uint8_t, 2> payload{0x5aU, 0xa5U};
  const auto bytes = structural_records_psd(
      payload, "zzzz", {}, "zzzy", {}, kOwnerCount);
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  const auto read = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(read.layers().front().unknown_psd_blocks().size() == kOwnerCount);
  const auto exact = usage.retained_payload_bytes;
  CHECK(exact >= kOwnerCount);

  options.budget.max_retained_payload_bytes = exact;
  CHECK(patchy::psd::DocumentIo::read(bytes, options)
            .layers()
            .front()
            .unknown_psd_blocks()
            .size() == kOwnerCount);
  CHECK(usage.retained_payload_bytes == exact);
  expect_retained_payload_rejection(bytes, exact - 1U, exact - 2U,
                                    options);

  options.preserve_unknown_blocks = false;
  options.budget.max_retained_payload_bytes = 0U;
  const auto lossy = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == 0U);
  CHECK(lossy.layers().front().unknown_psd_blocks().empty());
}

void psd_retained_payload_budget_palette_counts_distinct_color_arrays() {
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  document.add_pixel_layer("Layer", rgb_pixels(1, 1));
  const std::vector<patchy::RgbColor> colors{
      {1U, 2U, 3U}, {4U, 5U, 6U}, {7U, 8U, 9U}};
  const std::vector<std::string> names{"One", "Two", "Three"};
  document.indexed_palette() =
      patchy::DocumentIndexedPalette{colors, 2U, names};
  patchy::DocumentPaletteEditing editing;
  editing.palette.colors = colors;
  editing.palette.names = names;
  editing.alpha_threshold = 91U;
  document.palette_editing() = std::move(editing);
  const auto bytes = patchy::psd::DocumentIo::write_layered_rgb8(document);

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  const auto measured = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(measured.indexed_palette().has_value());
  CHECK(measured.palette_editing().has_value());
  const auto color_bytes = colors.size() * sizeof(patchy::RgbColor);
  std::uint64_t exact = measured.metadata().raw_psd_image_resources.size() +
                        2U * color_bytes;
  for (const auto& layer : measured.layers()) {
    exact += layer.raw_psd_blending_ranges().size();
    for (const auto& block : layer.unknown_psd_blocks()) {
      exact += block.payload.size();
    }
  }
  CHECK(usage.retained_payload_bytes == exact);

  options.budget.max_retained_payload_bytes = exact;
  CHECK(patchy::psd::DocumentIo::read(bytes, options)
            .palette_editing()
            .has_value());
  expect_retained_payload_rejection(bytes, exact - 1U,
                                    exact - color_bytes, options);

  options.preserve_unknown_blocks = false;
  options.budget.max_retained_payload_bytes = 2U * color_bytes;
  const auto lossy = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == 2U * color_bytes);
  CHECK(lossy.metadata().raw_psd_image_resources.empty());
  CHECK(lossy.indexed_palette().has_value());
  CHECK(lossy.palette_editing().has_value());
}

void psd_retained_payload_budget_smart_object_distinct_owners_are_exact() {
  constexpr std::size_t kEmbeddedBytes = 7U;
  patchy::SmartObjectSource source;
  source.kind = patchy::SmartObjectSourceKind::Embedded;
  source.uuid = "01234567-89ab-cdef-8123-456789abcdef";
  source.filename = "Budget.bin";
  source.filetype = "    ";
  source.file_bytes = std::make_shared<const std::vector<std::uint8_t>>(
      std::vector<std::uint8_t>{1U, 2U, 3U, 4U, 5U, 6U, 7U});
  patchy::SmartObjectLinkBlock block;
  block.key = "lnk2";
  block.sources.push_back(std::move(source));
  const auto payload = patchy::psd::serialize_linked_layer_block(block);
  CHECK(!payload.empty());
  const auto bytes = structural_records_psd({}, "zzzz", payload, "lnk2");
  constexpr std::uint64_t kImageResources = 12U;
  const auto exact = kImageResources + 2U * payload.size() + kEmbeddedBytes;

  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_retained_payload_bytes = exact;
  const auto preserved = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == exact);
  CHECK(preserved.metadata().smart_objects.blocks.size() == 1U);
  const auto& preserved_block =
      preserved.metadata().smart_objects.blocks.front();
  CHECK(preserved_block.original_payload != nullptr);
  CHECK(preserved_block.sources.size() == 1U);
  CHECK(preserved_block.sources.front().original_element_bytes != nullptr);
  CHECK(preserved_block.sources.front().file_bytes->size() == kEmbeddedBytes);
  expect_retained_payload_rejection(bytes, exact - 1U,
                                    kImageResources + payload.size() +
                                        kEmbeddedBytes);

  options.preserve_unknown_blocks = false;
  options.budget.max_retained_payload_bytes = kEmbeddedBytes;
  const auto lossy = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(usage.retained_payload_bytes == kEmbeddedBytes);
  CHECK(lossy.metadata().smart_objects.blocks.size() == 1U);
  const auto& lossy_block = lossy.metadata().smart_objects.blocks.front();
  CHECK(lossy_block.original_payload == nullptr);
  CHECK(lossy_block.sources.front().original_element_bytes == nullptr);
  CHECK(lossy_block.sources.front().file_bytes->size() == kEmbeddedBytes);
  expect_retained_payload_rejection(bytes, kEmbeddedBytes - 1U, 0U,
                                    options);

  patchy::SmartObjectSource external;
  external.kind = patchy::SmartObjectSourceKind::ExternalFile;
  external.uuid = "fedcba98-7654-3210-8fed-cba987654321";
  external.filename = "External.psb";
  external.filetype = "8BPS";
  external.external_full_path = "file:///tmp/External.psb";
  external.external_original_path = "/tmp/External.psb";
  external.external_rel_path = "External.psb";
  external.external_file_size = std::numeric_limits<std::uint64_t>::max();
  patchy::SmartObjectLinkBlock external_block;
  external_block.key = "lnk2";
  external_block.sources.push_back(std::move(external));
  const auto external_payload =
      patchy::psd::serialize_linked_layer_block(external_block);
  CHECK(!external_payload.empty());
  const auto external_bytes =
      structural_records_psd({}, "zzzz", external_payload, "lnk2");
  const auto external_exact =
      kImageResources + 2U * external_payload.size();
  options.preserve_unknown_blocks = true;
  options.budget.max_retained_payload_bytes = external_exact;
  const auto external_read =
      patchy::psd::DocumentIo::read(external_bytes, options);
  CHECK(usage.retained_payload_bytes == external_exact);
  CHECK(external_read.metadata().smart_objects.blocks.size() == 1U);
  const auto& external_source =
      external_read.metadata().smart_objects.blocks.front().sources.front();
  CHECK(external_source.kind == patchy::SmartObjectSourceKind::ExternalFile);
  CHECK(external_source.file_bytes == nullptr);
  CHECK(external_source.external_file_size ==
        std::numeric_limits<std::uint64_t>::max());
  expect_retained_payload_rejection(
      external_bytes, external_exact - 1U,
      kImageResources + external_payload.size(), options);

  options.preserve_unknown_blocks = false;
  options.budget.max_retained_payload_bytes = 0U;
  const auto external_lossy =
      patchy::psd::DocumentIo::read(external_bytes, options);
  CHECK(usage.retained_payload_bytes == 0U);
  CHECK(external_lossy.metadata().smart_objects.blocks.size() == 1U);
  CHECK(external_lossy.metadata().smart_objects.blocks.front()
            .sources.front()
            .external_file_size ==
        std::numeric_limits<std::uint64_t>::max());
}

void psd_retained_payload_budget_smart_filter_mask_copy_is_exact() {
  patchy::Document document(2, 1, patchy::PixelFormat::rgb8());
  auto source = rgb_pixels(2, 1);
  auto& layer = document.add_pixel_layer("Layer", source);

  const std::string placed_uuid =
      "01234567-89ab-cdef-8123-456789abcdef";
  patchy::SmartObjectPlacement placement;
  placement.uuid = "11111111-2222-3333-8444-555555555555";
  placement.transform = {0.0, 0.0, 2.0, 0.0, 2.0, 1.0, 0.0, 1.0};
  placement.width = 2.0;
  placement.height = 1.0;
  placement.resolution = 72.0;
  auto stack = patchy::test::test_gaussian_smart_filter_stack(1.0);
  layer.unknown_psd_blocks().push_back(patchy::UnknownPsdBlock{
      "SoLd", patchy::psd::author_placed_layer_sold_payload(
                  placement, placed_uuid, &stack)});
  patchy::set_layer_smart_object_metadata(
      layer, placement, placed_uuid, "SoLd", "",
      patchy::kSmartObjectRasterStatusPhotoshop);
  layer.set_smart_filter_stack(stack);
  document.metadata().smart_objects.add_embedded(
      placement.uuid, "source.raw", "    ",
      std::make_shared<const std::vector<std::uint8_t>>(
          std::vector<std::uint8_t>{0U}));

  patchy::SmartFilterMask mask;
  mask.bounds = patchy::Rect{0, 0, 2, 1};
  mask.pixels = patchy::PixelBuffer(2, 1, patchy::PixelFormat::gray8());
  mask.pixels.pixel(0, 0)[0] = 0U;
  mask.pixels.pixel(1, 0)[0] = 255U;
  const auto authored = patchy::psd::author_filter_effects_record(
      placed_uuid, mask.bounds, source, mask.bounds, mask);
  CHECK(authored.has_value());
  CHECK(document.metadata().smart_filter_effects.upsert_authored(*authored));

  const auto bytes = patchy::psd::DocumentIo::write_layered_rgb8(document);
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  const auto measured = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(measured.layers().front().smart_filter_stack() != nullptr);
  CHECK(measured.layers().front().smart_filter_stack()->mask.pixels.data().size() ==
        2U);
  const auto exact = usage.retained_payload_bytes;
  CHECK(exact >= 4U);

  options.budget.max_retained_payload_bytes = exact;
  const auto exact_read = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(exact_read.layers().front().smart_filter_stack() != nullptr);
  CHECK(usage.retained_payload_bytes == exact);
  expect_retained_payload_rejection(bytes, exact - 1U, exact - 2U, options);
}

void psd_tracked_live_budget_raii_is_exact_and_move_safe() {
  std::uint64_t current = 99U;
  std::uint64_t high_water = 99U;
  patchy::psd::ParseLiveBudgetTracker tracker(10U, &current, &high_water);
  {
    auto outer = tracker.reserve(4U);
    CHECK(current == 4U);
    CHECK(high_water == 4U);
    {
      auto nested = tracker.reserve(3U);
      CHECK(current == 7U);
      CHECK(high_water == 7U);
      auto moved = std::move(nested);
      CHECK(current == 7U);
      moved.release();
      CHECK(current == 4U);
      CHECK(high_water == 7U);
      moved.release();
      CHECK(current == 4U);
    }
    bool rejected = false;
    try {
      (void)tracker.reserve(7U);
    } catch (const patchy::psd::ParseBudgetExceeded& error) {
      rejected = true;
      CHECK(error.dimension() ==
            patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
    }
    CHECK(rejected);
    CHECK(current == 4U);
    CHECK(high_water == 7U);
  }
  CHECK(current == 0U);
  CHECK(high_water == 7U);

  {
    auto growing = tracker.reserve(0U);
    growing.grow_size(6U);
    CHECK(current == 6U);
    CHECK(high_water == 7U);
    bool growth_rejected = false;
    try {
      growing.grow_size(5U);
    } catch (const patchy::psd::ParseBudgetExceeded& error) {
      growth_rejected = true;
      CHECK(error.dimension() ==
            patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
    }
    CHECK(growth_rejected);
    CHECK(current == 6U);
    auto moved = std::move(growing);
    moved.grow_size(1U);
    CHECK(current == 7U);
  }
  CHECK(current == 0U);
  CHECK(high_water == 7U);

  {
    auto first = tracker.reserve(4U);
    auto second = tracker.reserve(2U);
    CHECK(current == 6U);
    first = std::move(second);
    CHECK(current == 2U);
  }
  CHECK(current == 0U);
  CHECK(high_water == 7U);

  {
    patchy::psd::TrackedByteBuffer first(
        tracker.reserve(4U), std::vector<std::uint8_t>(4U));
    patchy::psd::TrackedByteBuffer second(
        tracker.reserve(2U), std::vector<std::uint8_t>(2U));
    CHECK(current == 6U);
    first = std::move(second);
    CHECK(current == 2U);
  }
  CHECK(current == 0U);
  CHECK(high_water == 7U);

  bool overflow_rejected = false;
  try {
    (void)tracker.reserve_product(std::numeric_limits<std::size_t>::max(),
                                  2U);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    overflow_rejected = true;
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
  }
  CHECK(overflow_rejected);
  CHECK(current == 0U);
  CHECK(high_water == 7U);
}

void psd_tracked_live_budget_flat_raw_precedence_and_unwind() {
  const auto bytes = flat_psd(8U, 0U);
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_decompressed_bytes = 5U;
  options.budget.max_tracked_live_bytes = 5U;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::DecompressedBytes);
  }
  CHECK(usage.decompressed_bytes == 4U);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 4U);

  options.budget.max_decompressed_bytes = 6U;
  try {
    (void)patchy::psd::DocumentIo::read(bytes, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
  }
  CHECK(usage.decompressed_bytes == 6U);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 4U);

  options.budget.max_tracked_live_bytes = 6U;
  CHECK(patchy::psd::DocumentIo::read(bytes, options).width() == 2);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 6U);
}

void psd_tracked_live_budget_rle_and_deep_prediction_are_exact() {
  const auto rle = flat_psd(8U, 1U);
  patchy::psd::ParseUsage usage;
  patchy::psd::ReadOptions options;
  options.usage = &usage;
  options.budget.max_tracked_live_bytes = 20U;
  CHECK(patchy::psd::DocumentIo::read(rle, options).width() == 2);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 20U);

  options.budget.max_tracked_live_bytes = 19U;
  try {
    (void)patchy::psd::DocumentIo::read(rle, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
  }
  CHECK(usage.decompressed_bytes == 6U);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 18U);

  const auto deep = deep_layer_psd(32U);
  options.budget.max_tracked_live_bytes = 16U;
  CHECK(patchy::psd::DocumentIo::read(deep, options).layers().size() == 1U);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 16U);

  options.budget.max_tracked_live_bytes = 15U;
  try {
    (void)patchy::psd::DocumentIo::read(deep, options);
    CHECK(false);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
  }
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 8U);

  auto truncated_table = flat_psd(8U, 1U);
  // Header + three empty length blocks + compression marker = 40 bytes;
  // retain only five of the six required u16 row counts.
  truncated_table.resize(45U);
  usage = {};
  options.budget.max_tracked_live_bytes =
      std::numeric_limits<std::uint64_t>::max();
  bool malformed_rejected = false;
  try {
    (void)patchy::psd::DocumentIo::read(truncated_table, options);
  } catch (const patchy::psd::ParseBudgetExceeded&) {
    CHECK(false);
  } catch (const std::exception&) {
    malformed_rejected = true;
  }
  CHECK(malformed_rejected);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 0U);
}

void psd_tracked_live_budget_cmyk_scratch_is_topology_independent() {
  const auto source = patchy::psd::DocumentIo::read_file(
      patchy::test::committed_psd_fixture_path(
          "photoshop-cmyk-style-colors.psd"));
  const auto profile = patchy::psd::find_image_resource_payload(
      source.metadata().raw_psd_image_resources,
      patchy::psd::kImageResourceIccProfile);
  CHECK(profile.has_value());
  const auto transform =
      patchy::CmykToRgbTransform::from_icc_profile(*profile);
  CHECK(transform.has_value());

  const std::array<std::uint8_t, 2> cyan{255U, 0U};
  const std::array<std::uint8_t, 2> magenta{255U, 255U};
  const std::array<std::uint8_t, 2> yellow{255U, 255U};
  const std::array<std::uint8_t, 2> black{255U, 255U};
  patchy::PixelBuffer pixels(2, 1, patchy::PixelFormat::rgb8());
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  patchy::psd::ParseLiveBudgetTracker small_tracker(14U, &current,
                                                    &high_water);
  patchy::psd::convert_cmyk_planes_to_rgb(
      pixels, cyan.data(), magenta.data(), yellow.data(), black.data(), 2U,
      &*transform, small_tracker);
  CHECK(current == 0U);
  CHECK(high_water == 14U);

  current = 0U;
  high_water = 0U;
  patchy::psd::ParseLiveBudgetTracker no_icc_tracker(0U, &current,
                                                     &high_water);
  patchy::psd::convert_cmyk_planes_to_rgb(
      pixels, cyan.data(), magenta.data(), yellow.data(), black.data(), 2U,
      nullptr, no_icc_tracker);
  CHECK(current == 0U);
  CHECK(high_water == 0U);

  constexpr std::size_t kParallelThresholdPixels = 4U << 20U;
  constexpr std::uint64_t kParallelScratchBytes = 16ULL * 65536ULL * 7ULL;
  current = 0U;
  high_water = 0U;
  patchy::psd::ParseLiveBudgetTracker parallel_tracker(
      kParallelScratchBytes - 1U, &current, &high_water);
  bool rejected = false;
  try {
    patchy::psd::convert_cmyk_planes_to_rgb(
        pixels, cyan.data(), magenta.data(), yellow.data(), black.data(),
        kParallelThresholdPixels, &*transform, parallel_tracker);
  } catch (const patchy::psd::ParseBudgetExceeded& error) {
    rejected = true;
    CHECK(error.dimension() ==
          patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
  }
  CHECK(rejected);
  CHECK(current == 0U);
  CHECK(high_water == 0U);

  patchy::PixelBuffer parallel_pixels(
      static_cast<std::int32_t>(kParallelThresholdPixels), 1,
      patchy::PixelFormat::rgb8());
  const std::vector<std::uint8_t> parallel_plane(kParallelThresholdPixels,
                                                  255U);
  current = 0U;
  high_water = 0U;
  patchy::psd::ParseLiveBudgetTracker exact_parallel_tracker(
      kParallelScratchBytes, &current, &high_water);
  patchy::psd::convert_cmyk_planes_to_rgb(
      parallel_pixels, parallel_plane.data(), parallel_plane.data(),
      parallel_plane.data(), parallel_plane.data(), kParallelThresholdPixels,
      &*transform, exact_parallel_tracker);
  CHECK(current == 0U);
  CHECK(high_water == kParallelScratchBytes);
}

void psd_tracked_live_budget_cmyk_planes_retain_source_capacity() {
  for (const auto depth : {16U, 32U}) {
    const auto bytes = flat_cmyk_raw_psd(static_cast<std::uint16_t>(depth));
    const auto plane_bytes = 2U * (depth / 8U);
    const auto exact = 4U * plane_bytes;
    patchy::psd::ParseUsage usage;
    patchy::psd::ReadOptions options;
    options.usage = &usage;
    options.budget.max_tracked_live_bytes = exact;
    CHECK(patchy::psd::DocumentIo::read(bytes, options).width() == 2);
    CHECK(usage.tracked_live_bytes == 0U);
    CHECK(usage.tracked_live_bytes_high_water == exact);

    options.budget.max_tracked_live_bytes = exact - 1U;
    try {
      (void)patchy::psd::DocumentIo::read(bytes, options);
      CHECK(false);
    } catch (const patchy::psd::ParseBudgetExceeded& error) {
      CHECK(error.dimension() ==
            patchy::psd::ParseBudgetDimension::TrackedLiveBytes);
    }
    CHECK(usage.decompressed_bytes == exact);
    CHECK(usage.tracked_live_bytes == 0U);
    CHECK(usage.tracked_live_bytes_high_water == 3U * plane_bytes);
  }
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
  const auto corrupt_usage = read_with_exact_decompressed_limit(corrupt, 16U);
  CHECK(corrupt_usage.tracked_live_bytes == 0U);
  CHECK(corrupt_usage.tracked_live_bytes_high_water == 4U);
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
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 8U);
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
  options.budget.max_tracked_live_bytes = 16U;
  options.usage = &usage;
  const auto read = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(read.metadata().patterns.find(pattern.id) != nullptr);
  CHECK(usage.decompressed_bytes == 11U);  // RGB layer 3 + RGBA pattern 8.
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 16U);

  expect_decompressed_rejection(bytes, 10U, 9U);
  expect_tracked_live_rejection(bytes, 15U, 8U);
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
  options.budget.max_tracked_live_bytes = 8U;
  options.usage = &usage;
  const auto read = patchy::psd::DocumentIo::read(bytes, options);
  CHECK(read.metadata().smart_filter_effects.blocks.size() == 1U);
  CHECK(read.metadata().smart_filter_effects.blocks.front().records.size() == 1U);
  CHECK(read.metadata().smart_filter_effects.blocks.front()
            .records.front().mask_decoded);
  // The RGB layer contributes 6 bytes and the decoded mask contributes 2.
  // Four 2-byte FEid cache planes are validated and skipped, not decompressed.
  CHECK(usage.decompressed_bytes == 8U);
  CHECK(usage.tracked_live_bytes == 0U);
  CHECK(usage.tracked_live_bytes_high_water == 8U);

  expect_decompressed_rejection(bytes, 7U, 6U);
  expect_tracked_live_rejection(bytes, 7U, 6U);
}

}  // namespace

std::vector<patchy::test::TestCase> psd_parse_budget_tests() {
  return {
      {"psd_decompressed_budget_api_defaults_and_usage_reset",
       psd_decompressed_budget_api_defaults_and_usage_reset},
      {"psd_structural_budget_api_defaults_enum_and_usage_reset",
       psd_structural_budget_api_defaults_enum_and_usage_reset},
      {"psd_structural_budget_layers_channels_and_resources_are_exact",
       psd_structural_budget_layers_channels_and_resources_are_exact},
      {"psd_structural_budget_descriptor_rejection_escapes_recovery",
       psd_structural_budget_descriptor_rejection_escapes_recovery},
      {"psd_structural_budget_object_array_charges_rows_before_nested_descriptor",
       psd_structural_budget_object_array_charges_rows_before_nested_descriptor},
      {"psd_structural_budget_layer_count_uses_declared_subsection",
       psd_structural_budget_layer_count_uses_declared_subsection},
      {"psd_structural_budget_prefer_flat_charges_only_traversed_records",
       psd_structural_budget_prefer_flat_charges_only_traversed_records},
      {"psd_structural_budget_prefer_flat_deep_headers_are_exact",
       psd_structural_budget_prefer_flat_deep_headers_are_exact},
      {"psd_structural_budget_patterns_aggregate_and_validate_before_charge",
       psd_structural_budget_patterns_aggregate_and_validate_before_charge},
      {"psd_retained_payload_budget_raw_owners_and_lossy_mode_are_exact",
       psd_retained_payload_budget_raw_owners_and_lossy_mode_are_exact},
      {"psd_retained_payload_budget_patterns_count_raw_and_decoded_owners",
       psd_retained_payload_budget_patterns_count_raw_and_decoded_owners},
      {"psd_retained_payload_budget_saved_channel_display_is_exact",
       psd_retained_payload_budget_saved_channel_display_is_exact},
      {"psd_retained_payload_budget_document_path_source_is_exact",
       psd_retained_payload_budget_document_path_source_is_exact},
      {"psd_retained_payload_budget_lossy_keeps_effects_reference_point",
       psd_retained_payload_budget_lossy_keeps_effects_reference_point},
      {"psd_retained_payload_folder_state_transfer_keeps_shared_owners",
       psd_retained_payload_folder_state_transfer_keeps_shared_owners},
      {"psd_retained_payload_live_shape_descriptor_is_admitted_before_growth",
       psd_retained_payload_live_shape_descriptor_is_admitted_before_growth},
      {"psd_retained_payload_budget_many_small_owners_are_aggregate",
       psd_retained_payload_budget_many_small_owners_are_aggregate},
      {"psd_retained_payload_budget_palette_counts_distinct_color_arrays",
       psd_retained_payload_budget_palette_counts_distinct_color_arrays},
      {"psd_retained_payload_budget_smart_object_distinct_owners_are_exact",
       psd_retained_payload_budget_smart_object_distinct_owners_are_exact},
      {"psd_retained_payload_budget_smart_filter_mask_copy_is_exact",
       psd_retained_payload_budget_smart_filter_mask_copy_is_exact},
      {"psd_tracked_live_budget_raii_is_exact_and_move_safe",
       psd_tracked_live_budget_raii_is_exact_and_move_safe},
      {"psd_tracked_live_budget_flat_raw_precedence_and_unwind",
       psd_tracked_live_budget_flat_raw_precedence_and_unwind},
      {"psd_tracked_live_budget_rle_and_deep_prediction_are_exact",
       psd_tracked_live_budget_rle_and_deep_prediction_are_exact},
      {"psd_tracked_live_budget_cmyk_scratch_is_topology_independent",
       psd_tracked_live_budget_cmyk_scratch_is_topology_independent},
      {"psd_tracked_live_budget_cmyk_planes_retain_source_capacity",
       psd_tracked_live_budget_cmyk_planes_retain_source_capacity},
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
