#include "core/document.hpp"
#include "core/layer.hpp"
#include "core/smart_object.hpp"
#include "core/vector_compound.hpp"
#include "psd/psd_io_internal.hpp"
#include "psd/psd_save_budget_internal.hpp"

#include "core_test_support.hpp"
#include "psd_test_support.hpp"
#include "test_harness.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
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

patchy::SmartObjectLinkBlock make_budget_authored_link_block() {
  patchy::SmartObjectLinkBlock block;
  patchy::SmartObjectSource source;
  source.uuid = "11111111-2222-3333-4444-555555555555";
  source.filename = "inner.psb";
  source.filetype = "8BPB";
  source.file_bytes = std::make_shared<const std::vector<std::uint8_t>>(
      patchy::test::odd_composite_mini_psb());
  source.dirty = true;
  block.sources.push_back(std::move(source));
  return block;
}

patchy::SmartObjectLinkBlock make_budget_external_link_block() {
  patchy::SmartObjectLinkBlock block;
  patchy::SmartObjectSource source;
  source.kind = patchy::SmartObjectSourceKind::ExternalFile;
  source.uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  source.filename = "linked.psb";
  source.filetype = "8BPB";
  source.external_full_path = "file:///tmp/linked.psb";
  source.external_original_path = "/tmp/linked.psb";
  source.external_rel_path = "linked.psb";
  source.external_mod_year = 2026;
  source.external_mod_month = 9;
  source.external_mod_day = 17;
  source.external_file_size = 123U;
  source.dirty = true;
  block.sources.push_back(std::move(source));
  return block;
}

std::vector<std::uint8_t> make_budget_foreign_embedded_element(
    std::span<const std::uint8_t> embedded,
    bool with_name_reference = false) {
  patchy::psd::BigEndianWriter body;
  for (const char ch : {'l', 'i', 'F', 'D'}) {
    body.write_u8(static_cast<std::uint8_t>(ch));
  }
  body.write_u32(7U);
  body.write_u8(36U);
  for (const char ch :
       std::string_view("22222222-3333-4444-5555-666666666666")) {
    body.write_u8(static_cast<std::uint8_t>(ch));
  }
  body.write_u32(6U);
  for (const char ch : std::string_view("in.psb")) {
    body.write_u16(static_cast<std::uint16_t>(ch));
  }
  for (const char ch : std::string_view("8BPB8BIM")) {
    body.write_u8(static_cast<std::uint8_t>(ch));
  }
  body.write_u64(embedded.size());
  body.write_u8(with_name_reference ? 1U : 0U);
  if (with_name_reference) {
    patchy::psd::DescriptorObject descriptor;
    descriptor.class_id = "null";
    patchy::psd::DescriptorValue reference;
    reference.type = patchy::psd::DescriptorValue::Type::Reference;
    patchy::psd::DescriptorReferenceItem item;
    item.form = "name";
    item.class_id = "null";
    item.name_value = "name-reference-sentinel";
    reference.reference_items.push_back(std::move(item));
    descriptor.key_order.push_back(
        patchy::psd::DescriptorObject::KeyEntry{"Ref ", false});
    descriptor.values.emplace("Ref ", std::move(reference));
    body.write_u32(16U);
    patchy::psd::write_descriptor(body, descriptor);
  }
  body.write_bytes(embedded);
  body.write_u32(0U);
  patchy::psd::write_f64(body, 0.0);
  body.write_u8(0U);
  for (int i = 0; i < 5; ++i) {
    body.write_u8(0xABU);
  }

  patchy::psd::BigEndianWriter element;
  element.write_u64(body.bytes().size());
  element.write_bytes(body.bytes());
  const auto padding = (4U - (body.bytes().size() % 4U)) % 4U;
  for (std::size_t i = 0U; i < padding; ++i) {
    element.write_u8(0U);
  }
  return std::move(element).take_bytes();
}

std::vector<std::uint8_t> make_psd_with_max_odd_row_count() {
  patchy::psd::BigEndianWriter writer;
  for (const char ch : {'8', 'B', 'P', 'S'}) {
    writer.write_u8(static_cast<std::uint8_t>(ch));
  }
  writer.write_u16(1U);
  for (int i = 0; i < 6; ++i) {
    writer.write_u8(0U);
  }
  writer.write_u16(1U);
  writer.write_u32(1U);
  writer.write_u32(1U);
  writer.write_u16(8U);
  writer.write_u16(3U);
  writer.write_u32(0U);
  writer.write_u32(0U);
  writer.write_u32(0U);
  writer.write_u16(1U);
  writer.write_u16(0xFFFFU);
  writer.write_u8(1U);
  writer.write_u8(0U);
  for (std::size_t i = 2U; i < 0xFFFFU; ++i) {
    writer.write_u8(0U);
  }
  return std::move(writer).take_bytes();
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

void psd_save_link_normalization_is_tracked_and_byte_stable() {
  const auto odd_psb = patchy::test::odd_composite_mini_psb();
  CHECK(odd_psb.size() == 71U);

  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  std::vector<std::uint8_t> normalized_bytes;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(74U, &current, &high_water);
    auto normalized = patchy::psd::even_composite_rows_normalized_tracked(
        odd_psb, tracker);
    CHECK(normalized.has_value());
    CHECK(normalized->bytes.size() == 74U);
    CHECK(patchy::test::fnv1a_hash_bytes(normalized->bytes) ==
          0x6fef8cec82673920ULL);
    CHECK(current == 74U);
    CHECK(high_water == 74U);
    normalized_bytes = normalized->bytes;
  }
  CHECK(current == 0U);

  // Preserve the old defined rewrite for a foreign row whose positive literal
  // over-declares its physical bytes: the split touches only the flag and the
  // first literal byte.
  auto truncated_literal = odd_psb;
  truncated_literal[56] = 5U;
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(74U, &current, &high_water);
    CHECK(patchy::psd::even_composite_rows_normalized_tracked(
              truncated_literal, tracker)
              .has_value());
  }
  CHECK(current == 0U);

  for (const auto limit : std::array<std::uint64_t, 2>{73U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current, &high_water);
      (void)patchy::psd::even_composite_rows_normalized_tracked(odd_psb,
                                                                tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water <= limit);
  }

  const auto odd_psd = patchy::test::odd_composite_mini_psd();
  CHECK(odd_psd.size() == 61U);
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(64U, &current, &high_water);
    const auto normalized =
        patchy::psd::even_composite_rows_normalized_tracked(odd_psd,
                                                            tracker);
    CHECK(normalized.has_value());
    CHECK(normalized->bytes.size() == 64U);
    CHECK(patchy::test::fnv1a_hash_bytes(normalized->bytes) ==
          0xf3cf2b65da3eda5dULL);
    CHECK(current == 64U);
    CHECK(high_water == 64U);
  }
  CHECK(current == 0U);

  // Validation completes before allocating: compliant and malformed inputs do
  // not consume even a zero-byte tracker.
  for (const auto& bytes :
       std::array<std::vector<std::uint8_t>, 2>{
           normalized_bytes, std::vector<std::uint8_t>{'n', 'o', 'p', 'e'}}) {
    current = 0U;
    high_water = 0U;
    patchy::psd::SaveLiveBudgetTracker tracker(0U, &current, &high_water);
    CHECK(!patchy::psd::even_composite_rows_normalized_tracked(bytes, tracker)
               .has_value());
    CHECK(current == 0U);
    CHECK(high_water == 0U);
  }

  auto hostile = odd_psb;
  hostile[12] = 0xFFU;
  hostile[13] = 0xFFU;
  hostile[14] = 0xFFU;
  hostile[15] = 0xFFU;
  hostile[16] = 0xFFU;
  hostile[17] = 0xFFU;
  auto truncated_table = odd_psb;
  truncated_table.resize(48U);
  auto unsplittable = odd_psb;
  std::fill(unsplittable.begin() + 56, unsplittable.begin() + 61,
            0x80U);
  auto trailing = odd_psb;
  trailing.push_back(0U);
  auto max_psd_row = make_psd_with_max_odd_row_count();
  for (const auto& malformed :
       std::array<std::vector<std::uint8_t>, 5>{
           hostile, truncated_table, unsplittable, trailing, max_psd_row}) {
    current = 0U;
    high_water = 0U;
    patchy::psd::SaveLiveBudgetTracker tracker(0U, &current, &high_water);
    CHECK(!patchy::psd::even_composite_rows_normalized_tracked(malformed,
                                                               tracker)
               .has_value());
    CHECK(current == 0U);
    CHECK(high_water == 0U);
  }
}

void psd_save_link_payload_owners_overlap_without_byte_drift() {
  patchy::SmartObjectLinkBlock raw;
  raw.opaque = true;
  raw.original_payload = std::make_shared<const std::vector<std::uint8_t>>(
      std::vector<std::uint8_t>{9U, 8U, 7U, 6U, 5U, 4U, 3U});

  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(7U, &current, &high_water);
    const auto payload = patchy::psd::serialize_linked_layer_block_tracked(
        raw, tracker);
    CHECK(payload.bytes == *raw.original_payload);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0x496ef57bd256f9d5ULL);
    CHECK(current == 7U);
    CHECK(high_water == 7U);
  }
  CHECK(current == 0U);
  for (const auto limit : std::array<std::uint64_t, 2>{6U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current, &high_water);
      (void)patchy::psd::serialize_linked_layer_block_tracked(raw, tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water == 0U);
  }

  const auto authored = make_budget_authored_link_block();
  constexpr std::uint64_t kAuthoredPayloadBytes = 184U;
  constexpr std::uint64_t kAuthoredPeak = 258U;  // normalized PSB + link payload
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(kAuthoredPeak, &current,
                                               &high_water);
    const auto payload = patchy::psd::serialize_linked_layer_block_tracked(
        authored, tracker);
    CHECK(payload.bytes.size() == kAuthoredPayloadBytes);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0x9d12c9f317164adaULL);
    CHECK(payload.bytes ==
          patchy::psd::serialize_linked_layer_block(authored));
    CHECK(current == kAuthoredPayloadBytes);
    CHECK(high_water == kAuthoredPeak);
  }
  CHECK(current == 0U);

  for (const auto limit :
       std::array<std::uint64_t, 2>{kAuthoredPeak - 1U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current, &high_water);
      (void)patchy::psd::serialize_linked_layer_block_tracked(authored,
                                                              tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water <= limit);
  }

  auto aliased = make_budget_authored_link_block();
  aliased.sources.push_back(aliased.sources.front());
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(516U, &current, &high_water);
    const auto payload = patchy::psd::serialize_linked_layer_block_tracked(
        aliased, tracker);
    CHECK(payload.bytes.size() == 368U);
    CHECK(current == 368U);
    CHECK(high_water == 516U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  bool alias_rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(515U, &current, &high_water);
    (void)patchy::psd::serialize_linked_layer_block_tracked(aliased, tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    alias_rejected = true;
  }
  CHECK(alias_rejected);
  CHECK(current == 0U);
  CHECK(high_water <= 515U);

  const auto odd_psb = patchy::test::odd_composite_mini_psb();
  patchy::SmartObjectLinkBlock wrapped;
  patchy::SmartObjectSource wrapped_source;
  wrapped_source.uuid = "11111111-2222-3333-4444-555555555555";
  wrapped_source.filename = "inner.psb";
  wrapped_source.filetype = "8BPB";
  wrapped_source.file_bytes =
      std::make_shared<const std::vector<std::uint8_t>>(odd_psb);
  wrapped_source.original_element_bytes =
      std::make_shared<const std::vector<std::uint8_t>>(
          make_budget_foreign_embedded_element(odd_psb));
  wrapped.sources.push_back(std::move(wrapped_source));
  wrapped.original_payload = wrapped.sources.front().original_element_bytes;
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(254U, &current, &high_water);
    const auto payload = patchy::psd::serialize_linked_layer_block_tracked(
        wrapped, tracker);
    CHECK(payload.bytes.size() == 180U);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0x3fb7e13c29962473ULL);
    CHECK(std::search_n(payload.bytes.begin(), payload.bytes.end(), 5U,
                        0xABU) != payload.bytes.end());
    CHECK(current == 180U);
    CHECK(high_water == 254U);
  }
  CHECK(current == 0U);
  current = 0U;
  high_water = 0U;
  bool wrapped_rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(253U, &current, &high_water);
    (void)patchy::psd::serialize_linked_layer_block_tracked(wrapped, tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    wrapped_rejected = true;
  }
  CHECK(wrapped_rejected);
  CHECK(current == 0U);
  CHECK(high_water <= 253U);

  patchy::SmartObjectLinkBlock named_reference_wrapper;
  auto named_source = wrapped.sources.front();
  named_source.original_element_bytes =
      std::make_shared<const std::vector<std::uint8_t>>(
          make_budget_foreign_embedded_element(
              odd_psb, /*with_name_reference=*/true));
  named_reference_wrapper.sources.push_back(std::move(named_source));
  named_reference_wrapper.original_payload =
      named_reference_wrapper.sources.front().original_element_bytes;
  const auto named_payload = patchy::psd::serialize_linked_layer_block(
      named_reference_wrapper);
  CHECK(std::search_n(named_payload.begin(), named_payload.end(), 5U,
                      0xABU) != named_payload.end());
  const auto named_parsed =
      patchy::psd::parse_linked_layer_block(named_payload);
  CHECK(named_parsed.has_value());
  CHECK(named_parsed->size() == 1U);
  CHECK(named_parsed->front().file_bytes != nullptr);
  CHECK(named_parsed->front().file_bytes->size() == 74U);
  patchy::SmartObjectLinkBlock named_round_trip;
  named_round_trip.sources = *named_parsed;
  named_round_trip.original_payload =
      std::make_shared<const std::vector<std::uint8_t>>(named_payload);
  CHECK(patchy::psd::serialize_linked_layer_block(named_round_trip) ==
        named_payload);

  const auto external = make_budget_external_link_block();
  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(496U, &current, &high_water);
    const auto payload = patchy::psd::serialize_linked_layer_block_tracked(
        external, tracker);
    CHECK(payload.bytes.size() == 496U);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) ==
          0x7713bac86f810fc4ULL);
    CHECK(current == 496U);
    CHECK(high_water == 496U);
  }
  CHECK(current == 0U);
}

void psd_save_link_globals_reach_the_public_live_budget() {
  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  document.metadata().smart_objects.blocks.push_back(
      make_budget_authored_link_block());
  document.metadata().smart_objects.blocks.push_back(
      make_budget_external_link_block());
  document.metadata().smart_filter_effects.blocks.push_back(
      make_filter_effects_block());

  patchy::psd::SaveUsage measured_usage;
  patchy::psd::WriteOptions measured_options;
  measured_options.usage = &measured_usage;
  const auto baseline = patchy::psd::DocumentIo::write_layered_rgb8(
      document, measured_options);
  CHECK(baseline.size() == 1070U);
  CHECK(patchy::test::fnv1a_hash_bytes(baseline) ==
        0x9a03676658d006f7ULL);
  CHECK(measured_usage.tracked_live_bytes == 0U);
  CHECK(measured_usage.tracked_live_bytes_high_water == 1680U);

  patchy::psd::SaveUsage exact_usage;
  auto exact_options = measured_options;
  exact_options.budget.max_tracked_live_bytes = 1680U;
  exact_options.usage = &exact_usage;
  CHECK(patchy::psd::DocumentIo::write_layered_rgb8(document,
                                                     exact_options) ==
        baseline);
  CHECK(exact_usage.tracked_live_bytes == 0U);
  CHECK(exact_usage.tracked_live_bytes_high_water == 1680U);

  for (const auto limit : std::array<std::uint64_t, 2>{1679U, 0U}) {
    patchy::psd::SaveUsage rejected_usage;
    auto rejected_options = measured_options;
    rejected_options.budget.max_tracked_live_bytes = limit;
    rejected_options.usage = &rejected_usage;
    bool rejected = false;
    try {
      (void)patchy::psd::DocumentIo::write_layered_rgb8(
          document, rejected_options);
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
      {"psd_save_link_normalization_is_tracked_and_byte_stable",
       psd_save_link_normalization_is_tracked_and_byte_stable},
      {"psd_save_link_payload_owners_overlap_without_byte_drift",
       psd_save_link_payload_owners_overlap_without_byte_drift},
      {"psd_save_link_globals_reach_the_public_live_budget",
       psd_save_link_globals_reach_the_public_live_budget},
  };
}
