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

patchy::PatternResource make_one_pixel_pattern(
    std::string id, std::string name,
    std::array<std::uint8_t, 4> rgba) {
  patchy::PatternResource pattern;
  pattern.id = std::move(id);
  pattern.name = std::move(name);
  pattern.tile = patchy::PixelBuffer(1, 1, patchy::PixelFormat::rgba8());
  std::copy(rgba.begin(), rgba.end(), pattern.tile.data().begin());
  return pattern;
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

void psd_save_pattern_payload_owns_budget_without_plane_copies() {
  const auto opaque = make_one_pixel_pattern("p", "n", {1U, 2U, 3U, 255U});
  const auto transparent =
      make_one_pixel_pattern("p", "n", {1U, 2U, 3U, 4U});
  const auto second_opaque =
      make_one_pixel_pattern("q", "m", {4U, 5U, 6U, 255U});

  constexpr std::uint64_t kOpaqueBytes = 244U;
  constexpr std::uint64_t kOpaqueHash = 0x0f38ddfcb47f4f62ULL;
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(kOpaqueBytes, &current,
                                                &high_water);
    const auto payload = patchy::psd::serialize_patterns_block_tracked(
        std::span(&opaque, 1U), tracker);
    CHECK(payload.bytes.size() == kOpaqueBytes);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) == kOpaqueHash);
    CHECK(current == kOpaqueBytes);
    CHECK(high_water == kOpaqueBytes);
    CHECK(patchy::psd::serialize_patterns_block(std::span(&opaque, 1U)) ==
          payload.bytes);
  }
  CHECK(current == 0U);

  for (const auto limit : std::array<std::uint64_t, 2>{kOpaqueBytes - 1U,
                                                       0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current,
                                                  &high_water);
      (void)patchy::psd::serialize_patterns_block_tracked(
          std::span(&opaque, 1U), tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water == limit);
  }

  constexpr std::uint64_t kTransparentBytes = 272U;
  constexpr std::uint64_t kTransparentHash = 0xd95f573c96b763d8ULL;
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(kTransparentBytes, &current,
                                                &high_water);
    const auto payload = patchy::psd::serialize_patterns_block_tracked(
        std::span(&transparent, 1U), tracker);
    CHECK(payload.bytes.size() == kTransparentBytes);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) == kTransparentHash);
    CHECK(current == kTransparentBytes);
    CHECK(high_water == kTransparentBytes);
  }
  CHECK(current == 0U);

  const std::array patterns{opaque, second_opaque};
  constexpr std::uint64_t kTwoPatternBytes = 488U;
  constexpr std::uint64_t kTwoPatternHash = 0x81e83f3ce32294baULL;
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(kTwoPatternBytes, &current,
                                                &high_water);
    const auto payload = patchy::psd::serialize_patterns_block_tracked(
        patterns, tracker);
    CHECK(payload.bytes.size() == kTwoPatternBytes);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) == kTwoPatternHash);
    CHECK(current == kTwoPatternBytes);
    CHECK(high_water == kTwoPatternBytes);
  }
  CHECK(current == 0U);

  const auto unicode = make_one_pixel_pattern(
      "u", std::string("\xC3\xA9\xF0\x9F\x98\x80", 6U),
      {1U, 2U, 3U, 255U});
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(248U, &current, &high_water);
    const auto payload = patchy::psd::serialize_patterns_block_tracked(
        std::span(&unicode, 1U), tracker);
    CHECK(payload.bytes.size() == 248U);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0x30caffae51de62cbULL);
    CHECK(current == 248U);
    CHECK(high_water == 248U);
  }
  CHECK(current == 0U);
}

void psd_save_pattern_payload_overlap_skip_and_unwind_are_stable() {
  const auto opaque = make_one_pixel_pattern("p", "n", {1U, 2U, 3U, 255U});
  const auto second = make_one_pixel_pattern("q", "m", {4U, 5U, 6U, 255U});

  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(251U, &current, &high_water);
    auto sentinel = tracker.reserve(7U);
    {
      const auto payload = patchy::psd::serialize_patterns_block_tracked(
          std::span(&opaque, 1U), tracker);
      CHECK(payload.bytes.size() == 244U);
      CHECK(current == 251U);
      CHECK(high_water == 251U);
    }
    CHECK(current == 7U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(488U, &current, &high_water);
    const auto first = patchy::psd::serialize_patterns_block_tracked(
        std::span(&opaque, 1U), tracker);
    const auto second_payload = patchy::psd::serialize_patterns_block_tracked(
        std::span(&second, 1U), tracker);
    CHECK(first.bytes.size() == 244U && second_payload.bytes.size() == 244U);
    CHECK(current == 488U);
    CHECK(high_water == 488U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(487U, &current, &high_water);
    const auto first = patchy::psd::serialize_patterns_block_tracked(
        std::span(&opaque, 1U), tracker);
    bool rejected = false;
    try {
      (void)patchy::psd::serialize_patterns_block_tracked(
          std::span(&second, 1U), tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 244U);
    CHECK(high_water == 487U);
  }
  CHECK(current == 0U);

  auto empty_tile = opaque;
  empty_tile.tile = {};
  auto wrong_format = opaque;
  wrong_format.tile = patchy::PixelBuffer(1, 1, patchy::PixelFormat::rgb8());
  auto empty_id = opaque;
  empty_id.id.clear();
  auto long_id = opaque;
  long_id.id.assign(256U, 'x');
  const std::array mixed{opaque, empty_tile, wrong_format, empty_id, long_id,
                         second};
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(488U, &current, &high_water);
    const auto payload =
        patchy::psd::serialize_patterns_block_tracked(mixed, tracker);
    CHECK(payload.bytes.size() == 488U);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0x81e83f3ce32294baULL);
    CHECK(current == 488U);
    CHECK(high_water == 488U);
  }
  CHECK(current == 0U);

  const std::array invalid{empty_tile, wrong_format, empty_id, long_id};
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(0U, &current, &high_water);
    const auto payload =
        patchy::psd::serialize_patterns_block_tracked(invalid, tracker);
    CHECK(payload.bytes.empty());
    CHECK(current == 0U);
    CHECK(high_water == 0U);
  }

  const std::array valid{opaque, second};
  current = 0U;
  high_water = 0U;
  bool rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(487U, &current, &high_water);
    (void)patchy::psd::serialize_patterns_block_tracked(valid, tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(current == 0U);
  CHECK(high_water == 487U);

  const auto transparent =
      make_one_pixel_pattern("p", "n", {1U, 2U, 3U, 4U});
  current = 0U;
  high_water = 0U;
  rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(271U, &current, &high_water);
    (void)patchy::psd::serialize_patterns_block_tracked(
        std::span(&transparent, 1U), tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(current == 0U);
  CHECK(high_water == 271U);

  patchy::PatternResource chunked;
  chunked.id = "p";
  chunked.name = "n";
  chunked.tile = patchy::PixelBuffer(4097, 1, patchy::PixelFormat::rgba8());
  for (std::size_t index = 0U; index < 4097U; ++index) {
    auto* pixel = chunked.tile.pixel(static_cast<std::int32_t>(index), 0);
    pixel[0] = static_cast<std::uint8_t>(index);
    pixel[1] = static_cast<std::uint8_t>(3U * index);
    pixel[2] = static_cast<std::uint8_t>(7U * index);
    pixel[3] = 255U;
  }
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(12532U, &current,
                                                &high_water);
    const auto payload = patchy::psd::serialize_patterns_block_tracked(
        std::span(&chunked, 1U), tracker);
    CHECK(payload.bytes.size() == 12532U);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0xe3a0f2d448fa0b82ULL);
    CHECK(current == 12532U);
    CHECK(high_water == 12532U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(12531U, &current,
                                                &high_water);
    (void)patchy::psd::serialize_patterns_block_tracked(
        std::span(&chunked, 1U), tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    rejected = true;
  }
  CHECK(rejected);
  CHECK(current == 0U);
  CHECK(high_water == 12531U);
}

void psd_save_referenced_unencodable_pattern_fails_without_dangling_id() {
  const auto make_document = [](std::string id, bool add_rgb_tile) {
    patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
    auto& layer = document.add_pixel_layer(
        "L", patchy::test::solid_rgba(1, 1, 20U, 30U, 40U, 255U));
    patchy::LayerPatternOverlay overlay;
    overlay.enabled = true;
    overlay.pattern_id = id;
    layer.layer_style().pattern_overlays.push_back(std::move(overlay));
    if (add_rgb_tile) {
      patchy::PatternResource pattern;
      pattern.id = std::move(id);
      pattern.name = "unsupported";
      pattern.tile = patchy::PixelBuffer(1, 1, patchy::PixelFormat::rgb8());
      document.metadata().patterns.adopt(pattern);
    }
    return document;
  };

  const std::array documents{
      make_document("p", true),
      make_document(std::string(256U, 'x'), false),
  };
  for (const auto& document : documents) {
    patchy::psd::SaveUsage usage;
    patchy::psd::WriteOptions options;
    options.usage = &usage;
    bool threw = false;
    try {
      (void)patchy::psd::DocumentIo::write_layered_rgb8(document, options);
    } catch (const std::runtime_error&) {
      threw = true;
    }
    CHECK(threw);
    CHECK(usage.tracked_live_bytes == 0U);
  }
}

void psd_save_pattern_raw_coverage_and_malformed_prefix_are_stable() {
  const auto p = make_one_pixel_pattern("p", "n", {1U, 2U, 3U, 255U});
  const auto q = make_one_pixel_pattern("q", "m", {4U, 5U, 6U, 255U});
  const auto r = make_one_pixel_pattern("r", "o", {7U, 8U, 9U, 255U});
  const auto s = make_one_pixel_pattern("s", "a", {10U, 11U, 12U, 4U});
  const auto t = make_one_pixel_pattern("t", "b", {13U, 14U, 15U, 255U});

  const std::array p_only{p};
  const std::array q_only{q};
  const std::array r_only{r};
  auto raw_p = patchy::psd::serialize_patterns_block(p_only);
  auto raw_q = patchy::psd::serialize_patterns_block(q_only);
  auto raw_r_malformed = patchy::psd::serialize_patterns_block(r_only);
  raw_r_malformed.insert(raw_r_malformed.end(),
                         {0U, 0U, 0U, 32U, 0U, 0U, 0U, 0U, 0U, 0U, 0U, 0U});

  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  auto& layer = document.add_pixel_layer(
      "L", patchy::test::solid_rgba(1, 1, 20U, 30U, 40U, 255U));
  for (const auto id : {"p", "q", "r", "s", "t"}) {
    patchy::LayerPatternOverlay overlay;
    overlay.pattern_id = id;
    layer.layer_style().pattern_overlays.push_back(std::move(overlay));
  }
  document.metadata().patterns.adopt(s);
  document.metadata().patterns.adopt(t);
  document.metadata().unknown_psd_resources.push_back(
      patchy::UnknownPsdBlock{"Patt", raw_p, false, 0U});
  document.metadata().unknown_psd_resources.push_back(
      patchy::UnknownPsdBlock{"Pat2", raw_q, false, 1U});
  document.metadata().unknown_psd_resources.push_back(
      patchy::UnknownPsdBlock{"Pat3", raw_r_malformed, false, 2U});

  patchy::psd::SaveUsage measured_usage;
  patchy::psd::WriteOptions measured_options;
  measured_options.usage = &measured_usage;
  const auto baseline = patchy::psd::DocumentIo::write_layered_rgb8(
      document, measured_options);
  CHECK(baseline.size() == 1489U);
  CHECK(patchy::test::fnv1a_hash_bytes(baseline) ==
        0xf5caba85bfa20e4aULL);
  CHECK(measured_usage.tracked_live_bytes == 0U);
  CHECK(measured_usage.tracked_live_bytes_high_water == 2044U);

  const auto reread = patchy::psd::DocumentIo::read(baseline);
  std::vector<const patchy::UnknownPsdBlock*> pattern_blocks;
  for (const auto& block : reread.metadata().unknown_psd_resources) {
    if (block.key == "Patt" || block.key == "Pat2" || block.key == "Pat3") {
      pattern_blocks.push_back(&block);
    }
  }
  CHECK(pattern_blocks.size() == 4U);
  CHECK(pattern_blocks[0]->key == "Patt" && pattern_blocks[0]->payload == raw_p);
  CHECK(pattern_blocks[1]->key == "Pat2" && pattern_blocks[1]->payload == raw_q);
  CHECK(pattern_blocks[2]->key == "Pat3" &&
        pattern_blocks[2]->payload == raw_r_malformed);
  CHECK(pattern_blocks[3]->key == "Patt");
  CHECK(pattern_blocks[3]->payload.size() == 516U);
  CHECK(patchy::test::fnv1a_hash_bytes(pattern_blocks[3]->payload) ==
        0xbfd7d7e1f9b35c10ULL);
  for (const auto id : {"p", "q", "r", "s", "t"}) {
    CHECK(reread.metadata().patterns.find(id) != nullptr);
  }

  patchy::psd::SaveUsage exact_usage;
  auto exact_options = measured_options;
  exact_options.budget.max_tracked_live_bytes =
      2044U;
  exact_options.usage = &exact_usage;
  CHECK(patchy::psd::DocumentIo::write_layered_rgb8(document, exact_options) ==
        baseline);
  CHECK(exact_usage.tracked_live_bytes == 0U);
  CHECK(exact_usage.tracked_live_bytes_high_water ==
        2044U);

  patchy::psd::SaveUsage rejected_usage;
  auto rejected_options = measured_options;
  rejected_options.budget.max_tracked_live_bytes =
      2043U;
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
}

void psd_save_pattern_global_copy_and_placeholder_reach_public_budget() {
  const auto make_document = [](bool missing_tile) {
    patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
    auto& layer = document.add_pixel_layer(
        "L", patchy::test::solid_rgba(1, 1, 20U, 30U, 40U, 255U));
    patchy::LayerPatternOverlay overlay;
    overlay.enabled = true;
    overlay.pattern_id = "p";
    overlay.pattern_name = "n";
    layer.layer_style().pattern_overlays.push_back(std::move(overlay));
    auto pattern = make_one_pixel_pattern("p", "n", {1U, 2U, 3U, 255U});
    if (missing_tile) {
      pattern.tile = {};
    }
    document.metadata().patterns.adopt(pattern);
    return document;
  };

  struct Expected {
    bool missing_tile;
    std::size_t output_bytes;
    std::uint64_t output_hash;
    std::uint64_t peak;
  };
  constexpr std::array expected_cases{
      Expected{false, 873U, 0x36993e59b220e6beULL, 1592U},
      Expected{true, 901U, 0x9825d7023a1506cdULL, 1652U},
  };
  for (const auto& expected : expected_cases) {
    const auto document = make_document(expected.missing_tile);
    patchy::psd::SaveUsage measured_usage;
    patchy::psd::WriteOptions measured_options;
    measured_options.usage = &measured_usage;
    const auto baseline = patchy::psd::DocumentIo::write_layered_rgb8(
        document, measured_options);
    CHECK(baseline.size() == expected.output_bytes);
    CHECK(patchy::test::fnv1a_hash_bytes(baseline) == expected.output_hash);
    CHECK(measured_usage.tracked_live_bytes == 0U);
    CHECK(measured_usage.tracked_live_bytes_high_water == expected.peak);

    patchy::psd::SaveUsage exact_usage;
    auto exact_options = measured_options;
    exact_options.budget.max_tracked_live_bytes =
        expected.peak;
    exact_options.usage = &exact_usage;
    CHECK(patchy::psd::DocumentIo::write_layered_rgb8(document,
                                                       exact_options) ==
          baseline);
    CHECK(exact_usage.tracked_live_bytes == 0U);
    CHECK(exact_usage.tracked_live_bytes_high_water ==
          expected.peak);

    patchy::psd::SaveUsage rejected_usage;
    auto rejected_options = measured_options;
    rejected_options.budget.max_tracked_live_bytes =
        expected.peak - 1U;
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
    CHECK(rejected_usage.tracked_live_bytes_high_water <
          expected.peak);
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
      {"psd_save_pattern_payload_owns_budget_without_plane_copies",
       psd_save_pattern_payload_owns_budget_without_plane_copies},
      {"psd_save_pattern_payload_overlap_skip_and_unwind_are_stable",
       psd_save_pattern_payload_overlap_skip_and_unwind_are_stable},
      {"psd_save_referenced_unencodable_pattern_fails_without_dangling_id",
       psd_save_referenced_unencodable_pattern_fails_without_dangling_id},
      {"psd_save_pattern_raw_coverage_and_malformed_prefix_are_stable",
       psd_save_pattern_raw_coverage_and_malformed_prefix_are_stable},
      {"psd_save_pattern_global_copy_and_placeholder_reach_public_budget",
       psd_save_pattern_global_copy_and_placeholder_reach_public_budget},
  };
}
