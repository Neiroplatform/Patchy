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

patchy::SmartFilterEffectsBlock make_filter_effects_block(
    std::string placed_uuid = "x") {
  auto storage = std::make_shared<const std::vector<std::uint8_t>>(
      std::vector<std::uint8_t>{1U, 'x', 0U, 0U, 0U, 1U});
  patchy::SmartFilterEffectsRecord record;
  record.placed_uuid = std::move(placed_uuid);
  record.original_placed_uuid = "x";
  record.raw_storage = std::move(storage);
  record.raw_body_length = 6U;

  patchy::SmartFilterEffectsBlock block;
  block.records.push_back(std::move(record));
  return block;
}

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

void psd_save_filter_effects_payload_owns_budget() {
  const auto block = make_filter_effects_block();
  constexpr std::uint64_t kPayloadBytes = 20U;
  constexpr std::uint64_t kHash = 0x71386559776f89b4ULL;

  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(kPayloadBytes, &current,
                                                &high_water);
    const auto payload =
        patchy::psd::serialize_filter_effects_block_tracked(block, tracker);
    CHECK(payload.bytes.size() == kPayloadBytes);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) == kHash);
    CHECK(current == kPayloadBytes);
    CHECK(high_water == kPayloadBytes);
    CHECK(patchy::psd::serialize_filter_effects_block(block) == payload.bytes);
  }
  CHECK(current == 0U);

  for (const auto limit : std::array<std::uint64_t, 2>{19U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current,
                                                  &high_water);
      (void)patchy::psd::serialize_filter_effects_block_tracked(block,
                                                                tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water == limit);
  }

  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(27U, &current, &high_water);
    auto sentinel = tracker.reserve(7U);
    {
      const auto payload =
          patchy::psd::serialize_filter_effects_block_tracked(block, tracker);
      CHECK(payload.bytes.size() == kPayloadBytes);
      CHECK(current == 27U);
      CHECK(high_water == 27U);
    }
    CHECK(current == 7U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(40U, &current, &high_water);
    const auto first =
        patchy::psd::serialize_filter_effects_block_tracked(block, tracker);
    {
      const auto second =
          patchy::psd::serialize_filter_effects_block_tracked(block, tracker);
      CHECK(first.bytes == second.bytes);
      CHECK(current == 40U);
      CHECK(high_water == 40U);
    }
    CHECK(current == 20U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(39U, &current, &high_water);
    const auto first =
        patchy::psd::serialize_filter_effects_block_tracked(block, tracker);
    bool rejected = false;
    try {
      (void)patchy::psd::serialize_filter_effects_block_tracked(block,
                                                                tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 20U);
    CHECK(high_water == 39U);
  }
  CHECK(current == 0U);
}

void psd_save_filter_effects_rekey_copy_and_unwind_are_stable() {
  const auto rekeyed = make_filter_effects_block("yz");
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(20U, &current, &high_water);
    const auto payload =
        patchy::psd::serialize_filter_effects_block_tracked(rekeyed, tracker);
    CHECK(payload.bytes.size() == 20U);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0x5976b3c78a774ddbULL);
    CHECK(current == 20U);
    CHECK(high_water == 20U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  bool rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(19U, &current, &high_water);
    (void)patchy::psd::serialize_filter_effects_block_tracked(rekeyed,
                                                              tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(current == 0U);
  CHECK(high_water == 19U);

  patchy::SmartFilterEffectsBlock copied;
  copied.opaque = true;
  copied.original_payload =
      std::make_shared<const std::vector<std::uint8_t>>(
          std::vector<std::uint8_t>{9U, 8U, 7U});
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(3U, &current, &high_water);
    const auto payload =
        patchy::psd::serialize_filter_effects_block_tracked(copied, tracker);
    CHECK(payload.bytes.size() == 3U);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0x160a9e188e7e3df9ULL);
    CHECK(current == 3U);
    CHECK(high_water == 3U);
  }
  CHECK(current == 0U);

  for (const auto limit : std::array<std::uint64_t, 2>{2U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current,
                                                  &high_water);
      (void)patchy::psd::serialize_filter_effects_block_tracked(copied,
                                                                tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water == 0U);
  }

  auto invalid_opaque = copied;
  invalid_opaque.original_payload.reset();
  current = 0U;
  high_water = 0U;
  bool opaque_threw = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(0U, &current, &high_water);
    (void)patchy::psd::serialize_filter_effects_block_tracked(invalid_opaque,
                                                              tracker);
  } catch (const std::runtime_error&) {
    opaque_threw = true;
  }
  CHECK(opaque_threw);
  CHECK(current == 0U);
  CHECK(high_water == 0U);

  auto malformed = make_filter_effects_block();
  auto invalid = malformed.records.front();
  invalid.raw_body_length = 7U;
  malformed.records.push_back(std::move(invalid));
  current = 0U;
  high_water = 0U;
  bool threw = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(20U, &current, &high_water);
    (void)patchy::psd::serialize_filter_effects_block_tracked(malformed,
                                                              tracker);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
  CHECK(current == 0U);
  CHECK(high_water == 20U);
}

void psd_save_filter_effects_global_copy_reaches_public_budget() {
  patchy::Document baseline_document(1, 1, patchy::PixelFormat::rgb8());
  patchy::psd::SaveUsage baseline_usage;
  patchy::psd::WriteOptions baseline_options;
  baseline_options.usage = &baseline_usage;
  (void)patchy::psd::DocumentIo::write_layered_rgb8(baseline_document,
                                                     baseline_options);
  CHECK(baseline_usage.tracked_live_bytes_high_water == 506U);

  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  patchy::SmartFilterEffectsBlock block;
  block.original_payload =
      std::make_shared<const std::vector<std::uint8_t>>(4096U, 0x5aU);
  document.metadata().smart_filter_effects.blocks.push_back(std::move(block));
  patchy::SmartFilterEffectsBlock second_block;
  second_block.key = "FXid";
  second_block.long_length = true;
  second_block.original_payload =
      std::make_shared<const std::vector<std::uint8_t>>(2048U, 0xa5U);
  document.metadata().smart_filter_effects.blocks.push_back(
      std::move(second_block));

  patchy::psd::SaveUsage measured_usage;
  patchy::psd::WriteOptions measured_options;
  measured_options.usage = &measured_usage;
  const auto baseline = patchy::psd::DocumentIo::write_layered_rgb8(
      document, measured_options);
  CHECK(baseline.size() == 6502U);
  CHECK(patchy::test::fnv1a_hash_bytes(baseline) ==
        0x39ef3ca4deed6e01ULL);
  CHECK(measured_usage.tracked_live_bytes == 0U);
  CHECK(measured_usage.tracked_live_bytes_high_water == 12556U);

  patchy::psd::SaveUsage exact_usage;
  auto exact_options = measured_options;
  exact_options.budget.max_tracked_live_bytes = 12556U;
  exact_options.usage = &exact_usage;
  CHECK(patchy::psd::DocumentIo::write_layered_rgb8(document, exact_options) ==
        baseline);
  CHECK(exact_usage.tracked_live_bytes == 0U);
  CHECK(exact_usage.tracked_live_bytes_high_water == 12556U);

  for (const auto limit : std::array<std::uint64_t, 2>{12555U, 4095U}) {
    patchy::psd::SaveUsage rejected_usage;
    auto rejected_options = measured_options;
    rejected_options.budget.max_tracked_live_bytes = limit;
    rejected_options.usage = &rejected_usage;
    bool rejected = false;
    try {
      (void)patchy::psd::DocumentIo::write_layered_rgb8(document,
                                                         rejected_options);
    } catch (const patchy::psd::SaveBudgetExceeded& error) {
      rejected = true;
      CHECK(error.dimension() ==
            patchy::psd::SaveBudgetDimension::TrackedLiveBytes);
    }
    CHECK(rejected);
    CHECK(rejected_usage.tracked_live_bytes == 0U);
    CHECK(rejected_usage.tracked_live_bytes_high_water <= limit);
  }
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
      {"psd_save_filter_effects_payload_owns_budget",
       psd_save_filter_effects_payload_owns_budget},
      {"psd_save_filter_effects_rekey_copy_and_unwind_are_stable",
       psd_save_filter_effects_rekey_copy_and_unwind_are_stable},
      {"psd_save_filter_effects_global_copy_reaches_public_budget",
       psd_save_filter_effects_global_copy_reaches_public_budget},
  };
}
