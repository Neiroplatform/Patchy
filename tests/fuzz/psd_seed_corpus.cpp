#include "core/document.hpp"
#include "core/pixel_buffer.hpp"
#include "psd/psd_document_io.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <span>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

namespace {

using Bytes = std::vector<std::uint8_t>;
using Seed = std::pair<std::string_view, Bytes>;

constexpr std::size_t kHeaderSize = 26U;

void set_u16_be(Bytes& bytes, std::size_t offset, std::uint16_t value) {
  if (offset > bytes.size() || bytes.size() - offset < 2U) {
    throw std::runtime_error("seed mutation is outside the generated file");
  }
  bytes[offset] = static_cast<std::uint8_t>(value >> 8U);
  bytes[offset + 1U] = static_cast<std::uint8_t>(value);
}

void set_u32_be(Bytes& bytes, std::size_t offset, std::uint32_t value) {
  if (offset > bytes.size() || bytes.size() - offset < 4U) {
    throw std::runtime_error("seed mutation is outside the generated file");
  }
  bytes[offset] = static_cast<std::uint8_t>(value >> 24U);
  bytes[offset + 1U] = static_cast<std::uint8_t>(value >> 16U);
  bytes[offset + 2U] = static_cast<std::uint8_t>(value >> 8U);
  bytes[offset + 3U] = static_cast<std::uint8_t>(value);
}

std::uint32_t read_u32_be(std::span<const std::uint8_t> bytes,
                          std::size_t offset) {
  if (offset > bytes.size() || bytes.size() - offset < 4U) {
    throw std::runtime_error("generated PSD section length is truncated");
  }
  return (static_cast<std::uint32_t>(bytes[offset]) << 24U) |
         (static_cast<std::uint32_t>(bytes[offset + 1U]) << 16U) |
         (static_cast<std::uint32_t>(bytes[offset + 2U]) << 8U) |
         static_cast<std::uint32_t>(bytes[offset + 3U]);
}

std::uint64_t read_u64_be(std::span<const std::uint8_t> bytes,
                          std::size_t offset) {
  if (offset > bytes.size() || bytes.size() - offset < 8U) {
    throw std::runtime_error("generated PSB section length is truncated");
  }
  std::uint64_t value = 0U;
  for (std::size_t index = 0; index < 8U; ++index) {
    value = (value << 8U) | bytes[offset + index];
  }
  return value;
}

std::size_t checked_advance(std::size_t offset, std::uint64_t amount,
                            std::size_t size) {
  if (amount > std::numeric_limits<std::size_t>::max() - offset) {
    throw std::runtime_error("generated PSD section offset overflows");
  }
  const auto next = offset + static_cast<std::size_t>(amount);
  if (next > size) {
    throw std::runtime_error("generated PSD section extends past the file");
  }
  return next;
}

std::size_t layer_and_mask_length_offset(std::span<const std::uint8_t> bytes) {
  auto offset = kHeaderSize;
  const auto color_mode_length = read_u32_be(bytes, offset);
  offset = checked_advance(offset + 4U, color_mode_length, bytes.size());
  const auto image_resources_length = read_u32_be(bytes, offset);
  return checked_advance(offset + 4U, image_resources_length, bytes.size());
}

std::size_t composite_offset(std::span<const std::uint8_t> bytes,
                             bool large_document) {
  const auto length_offset = layer_and_mask_length_offset(bytes);
  const auto length_bytes = large_document ? 8U : 4U;
  const auto section_length = large_document
                                  ? read_u64_be(bytes, length_offset)
                                  : read_u32_be(bytes, length_offset);
  return checked_advance(length_offset + length_bytes, section_length,
                         bytes.size());
}

patchy::Document make_document() {
  patchy::Document document(4, 3, patchy::PixelFormat::rgb8());
  patchy::PixelBuffer pixels(4, 3, patchy::PixelFormat::rgba8());
  auto data = pixels.data();
  for (std::size_t index = 0; index < data.size(); index += 4U) {
    const auto pixel = static_cast<std::uint8_t>(index / 4U);
    data[index] = static_cast<std::uint8_t>(17U + pixel * 11U);
    data[index + 1U] = static_cast<std::uint8_t>(29U + pixel * 7U);
    data[index + 2U] = static_cast<std::uint8_t>(43U + pixel * 5U);
    data[index + 3U] = static_cast<std::uint8_t>(255U - pixel * 9U);
  }
  document.add_pixel_layer("Fuzz seed", std::move(pixels));
  return document;
}

Bytes mutate(Bytes bytes, std::size_t offset, std::uint8_t value) {
  if (offset >= bytes.size()) {
    throw std::runtime_error("seed mutation is outside the generated file");
  }
  bytes[offset] = value;
  return bytes;
}

std::vector<Seed> make_seeds() {
  const auto document = make_document();
  const auto psd = patchy::psd::DocumentIo::write_layered_rgb8(document);
  patchy::psd::WriteOptions psb_options;
  psb_options.large_document = true;
  const auto psb =
      patchy::psd::DocumentIo::write_layered_rgb8(document, psb_options);

  std::vector<Seed> seeds;
  seeds.emplace_back("valid-layered.psd", psd);
  seeds.emplace_back("valid-layered.psb", psb);
  seeds.emplace_back("empty.bin", Bytes{});
  seeds.emplace_back("psd-header-only.bin",
                     Bytes(psd.begin(), psd.begin() + kHeaderSize));
  seeds.emplace_back("psd-truncated-half.bin",
                     Bytes(psd.begin(), psd.begin() + psd.size() / 2U));
  seeds.emplace_back("psb-truncated-half.bin",
                     Bytes(psb.begin(), psb.begin() + psb.size() / 2U));
  seeds.emplace_back("bad-signature.bin", mutate(psd, 0U, 'X'));

  auto invalid_version = psd;
  set_u16_be(invalid_version, 4U, 3U);
  seeds.emplace_back("invalid-version.bin", std::move(invalid_version));

  seeds.emplace_back("nonzero-reserved.bin", mutate(psd, 6U, 1U));

  auto too_many_channels = psd;
  set_u16_be(too_many_channels, 12U, 57U);
  seeds.emplace_back("too-many-channels.bin", std::move(too_many_channels));

  auto zero_height = psd;
  set_u32_be(zero_height, 14U, 0U);
  seeds.emplace_back("zero-height.bin", std::move(zero_height));

  auto oversized_width = psd;
  set_u32_be(oversized_width, 18U, 0xffffffffU);
  seeds.emplace_back("oversized-width.bin", std::move(oversized_width));

  auto invalid_depth = psd;
  set_u16_be(invalid_depth, 22U, 7U);
  seeds.emplace_back("invalid-depth.bin", std::move(invalid_depth));

  auto invalid_color_mode = psd;
  set_u16_be(invalid_color_mode, 24U, 42U);
  seeds.emplace_back("invalid-color-mode.bin", std::move(invalid_color_mode));

  auto oversized_color_section = psd;
  set_u32_be(oversized_color_section, 26U, 0xffffffffU);
  seeds.emplace_back("oversized-color-section.bin",
                     std::move(oversized_color_section));

  auto oversized_resources = psd;
  const auto color_length = read_u32_be(oversized_resources, kHeaderSize);
  const auto resources_offset =
      checked_advance(kHeaderSize + 4U, color_length,
                      oversized_resources.size());
  set_u32_be(oversized_resources, resources_offset, 0xffffffffU);
  seeds.emplace_back("oversized-resource-section.bin",
                     std::move(oversized_resources));

  auto oversized_layer_mask = psd;
  set_u32_be(oversized_layer_mask,
             layer_and_mask_length_offset(oversized_layer_mask),
             0xffffffffU);
  seeds.emplace_back("oversized-layer-mask-section.bin",
                     std::move(oversized_layer_mask));

  auto invalid_compression = psd;
  set_u16_be(invalid_compression, composite_offset(invalid_compression, false),
             0xffffU);
  seeds.emplace_back("invalid-composite-compression.bin",
                     std::move(invalid_compression));

  auto invalid_psb_compression = psb;
  set_u16_be(invalid_psb_compression,
             composite_offset(invalid_psb_compression, true), 0xffffU);
  seeds.emplace_back("invalid-psb-compression.bin",
                     std::move(invalid_psb_compression));
  return seeds;
}

void write_seed(const std::filesystem::path& directory, const Seed& seed) {
  const auto path = directory / seed.first;
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output) {
    throw std::runtime_error("could not create seed file");
  }
  const auto& bytes = seed.second;
  if (!bytes.empty()) {
    output.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
  }
  if (!output) {
    throw std::runtime_error("could not write seed file");
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: patchy_psd_seed_corpus <new-output-directory>\n";
    return 2;
  }

  try {
    const std::filesystem::path output_directory(argv[1]);
    if (!std::filesystem::create_directory(output_directory)) {
      throw std::runtime_error("output directory already exists");
    }
    const auto seeds = make_seeds();
    for (const auto& seed : seeds) {
      write_seed(output_directory, seed);
    }
    std::cout << "generated " << seeds.size() << " deterministic PSD/PSB seeds\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "seed generation failed: " << error.what() << '\n';
    return 1;
  }
}
