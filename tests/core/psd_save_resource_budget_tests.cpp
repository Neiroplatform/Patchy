#include "core/document.hpp"
#include "core/layer.hpp"
#include "core/vector_compound.hpp"
#include "psd/psd_io_internal.hpp"
#include "psd/psd_save_budget_internal.hpp"

#include "core_test_support.hpp"
#include "psd_test_support.hpp"
#include "test_harness.hpp"

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace {

void psd_save_generated_path_and_clipping_resources_own_budget() {
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  patchy::DocumentPath path(document.allocate_path_id(), "A", patchy::DocumentPathKind::Saved, patchy::VectorPath{});
  path.set_clipping_path(true);
  document.add_path(std::move(path));

  constexpr std::uint64_t kResourceBytes = 112U;
  constexpr std::uint64_t kExactPeak = 187U;
  constexpr std::uint64_t kHash = 0x8c80bb3a8d7de046ULL;
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(kExactPeak, &current, &high_water);
    const auto resources = patchy::psd::image_resources_for_document(document, {}, tracker);
    CHECK(resources.bytes.size() == kResourceBytes);
    CHECK(patchy::test::fnv1a_hash_bytes(resources.bytes) == kHash);
    CHECK(current == kResourceBytes);
    CHECK(high_water == kExactPeak);
  }
  CHECK(current == 0U);

  for (const auto [limit, expected_high] :
       std::array<std::pair<std::uint64_t, std::uint64_t>, 4>{{{186U, 0U}, {74U, 73U}, {51U, 51U}, {0U, 0U}}}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current, &high_water);
      (void)patchy::psd::image_resources_for_document(document, {}, tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water <= limit);
    if (expected_high != 0U) {
      CHECK(high_water == expected_high);
    }
  }
}

void psd_save_generated_resource_replacement_owns_budget() {
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  patchy::psd::BigEndianWriter raw;
  for (const auto byte : std::array<std::uint8_t, 4>{'8', 'B', 'I', 'M'}) {
    raw.write_u8(byte);
  }
  raw.write_u16(patchy::psd::kImageResourceResolutionInfo);
  raw.write_u16(0U);
  raw.write_u32(32U);
  for (std::uint8_t byte = 0U; byte < 32U; ++byte) {
    raw.write_u8(byte);
  }
  document.metadata().raw_psd_image_resources = raw.bytes();

  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(48U, &current, &high_water);
    const auto resources = patchy::psd::image_resources_for_document(document, {}, tracker);
    CHECK(resources.bytes.size() == 28U);
    CHECK(patchy::test::fnv1a_hash_bytes(resources.bytes) == 0x89d7e6821196bcadULL);
    CHECK(current == 28U);
    CHECK(high_water == 48U);
  }
  CHECK(current == 0U);
  current = 0U;
  high_water = 0U;
  bool rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(47U, &current, &high_water);
    (void)patchy::psd::image_resources_for_document(document, {}, tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(current == 0U);
  CHECK(high_water == 46U);
}

void psd_save_generated_resource_families_share_budget() {
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  document.guides().push_back(patchy::DocumentGuide{patchy::GuideOrientation::Horizontal, 32});
  document.color_state().embedded_icc_profile = {1U, 2U, 3U, 4U, 5U};
  document.indexed_palette() =
      patchy::DocumentIndexedPalette{{patchy::RgbColor{1U, 2U, 3U}, patchy::RgbColor{4U, 5U, 6U}}, 8U, {"A", ""}};
  patchy::Layer marked(document.allocate_layer_id(), "marked", patchy::LayerKind::Group);
  patchy::set_photoshop_layer_id(marked, 9U);
  patchy::set_compound_vector_group_kind(marked, patchy::CompoundVectorGroupKind::Content);
  document.add_layer(std::move(marked));

  const std::string channel_name = "A";
  patchy::psd::CompositeChannelInfo channel;
  channel.name = channel_name;
  channel.alpha_identifier_eligible = true;
  const std::array channels{channel};

  constexpr std::uint64_t kResourceBytes = 262U;
  constexpr std::uint64_t kPayloadBytes = 138U;
  constexpr std::uint64_t kExactPeak = kPayloadBytes + kResourceBytes;
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(kExactPeak, &current, &high_water);
    const auto resources = patchy::psd::image_resources_for_document(document, channels, tracker);
    CHECK(resources.bytes.size() == kResourceBytes);
    CHECK(patchy::test::fnv1a_hash_bytes(resources.bytes) == 0x418121ae3cb2da15ULL);
    CHECK(current == kResourceBytes);
    CHECK(high_water == kExactPeak);
  }
  CHECK(current == 0U);
  current = 0U;
  high_water = 0U;
  bool rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(kExactPeak - 1U, &current, &high_water);
    (void)patchy::psd::image_resources_for_document(document, channels, tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(current == 0U);
  CHECK(high_water <= kExactPeak - 1U);
}

void psd_save_path_resource_deletion_validator_preserves_opaque_bytes() {
  const auto record = [](std::uint16_t selector, std::uint16_t value, std::uint16_t operation = 0U) {
    patchy::psd::BigEndianWriter writer;
    writer.write_u16(selector);
    writer.write_u16(value);
    writer.write_u16(operation);
    for (std::size_t index = 6U; index < 26U; ++index) {
      writer.write_u8(0U);
    }
    return std::move(writer).take_bytes();
  };
  std::vector<patchy::psd::ImageResource> resources;
  const auto add = [&](std::uint16_t id, std::vector<std::uint8_t> payload) {
    patchy::psd::ImageResource resource;
    resource.id = id;
    resource.payload =
        patchy::psd::SaveTrackedByteBuffer(patchy::psd::SaveLiveBudgetTracker::Reservation{}, std::move(payload));
    resources.push_back(std::move(resource));
  };
  add(2000U, record(6U, 0U));
  auto trailing = record(7U, 0U);
  trailing.push_back(0xffU);  // the parser deliberately ignores a short tail
  add(2001U, std::move(trailing));
  add(2002U, record(0U, 0U, 0xffffU));
  add(2003U, record(0U, 1U));      // missing knot
  add(2004U, record(0U, 0U, 4U));  // invalid combine operation
  add(2005U, record(1U, 0U));      // knot without a length record
  add(2006U, record(9U, 0U));      // unknown selector

  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  patchy::psd::SaveLiveBudgetTracker tracker(0U, &current, &high_water);
  patchy::psd::upsert_document_path_resources(resources, document, tracker);
  CHECK(resources.size() == 4U);
  CHECK(resources[0].id == 2003U);
  CHECK(resources[1].id == 2004U);
  CHECK(resources[2].id == 2005U);
  CHECK(resources[3].id == 2006U);
  CHECK(current == 0U);
  CHECK(high_water == 0U);
}

void psd_save_clean_relocated_path_copy_owns_budget() {
  patchy::psd::BigEndianWriter raw_writer;
  for (std::size_t record = 0U; record < 2U; ++record) {
    raw_writer.write_u16(record == 0U ? 6U : 8U);
    for (std::size_t index = 2U; index < 26U; ++index) {
      raw_writer.write_u8(0U);
    }
  }
  auto raw = std::make_shared<const std::vector<std::uint8_t>>(std::move(raw_writer).take_bytes());
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  patchy::DocumentPath path(document.allocate_path_id(), "", patchy::DocumentPathKind::Work, patchy::VectorPath{});
  path.set_resource_source(2000U, raw);
  path.reset_dirty();
  document.add_path(std::move(path));

  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(160U, &current, &high_water);
    const auto resources = patchy::psd::image_resources_for_document(document, {}, tracker);
    CHECK(resources.bytes.size() == 92U);
    CHECK(patchy::test::fnv1a_hash_bytes(resources.bytes) == 0xe22cbc5668acb4d4ULL);
    CHECK(current == 92U);
    CHECK(high_water == 160U);
  }
  CHECK(current == 0U);
  current = 0U;
  high_water = 0U;
  bool rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(159U, &current, &high_water);
    (void)patchy::psd::image_resources_for_document(document, {}, tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(current == 0U);
  CHECK(high_water <= 159U);
}

}  // namespace

std::vector<patchy::test::TestCase> psd_save_resource_budget_tests() {
  return {
      {"psd_save_generated_path_and_clipping_resources_own_budget",
       psd_save_generated_path_and_clipping_resources_own_budget},
      {"psd_save_generated_resource_replacement_owns_budget", psd_save_generated_resource_replacement_owns_budget},
      {"psd_save_generated_resource_families_share_budget", psd_save_generated_resource_families_share_budget},
      {"psd_save_path_resource_deletion_validator_preserves_opaque_bytes",
       psd_save_path_resource_deletion_validator_preserves_opaque_bytes},
      {"psd_save_clean_relocated_path_copy_owns_budget", psd_save_clean_relocated_path_copy_owns_budget},
  };
}
