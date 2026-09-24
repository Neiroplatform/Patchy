#include "core/document.hpp"
#include "core/layer.hpp"
#include "core/layer_metadata.hpp"
#include "core/smart_object.hpp"
#include "core/vector_compound.hpp"
#include "core/vector_live_shapes.hpp"
#include "psd/psd_io_internal.hpp"
#include "psd/psd_save_budget_internal.hpp"
#include "psd/psd_save_workspace.hpp"
#include "render/compositor.hpp"

#include "core_test_support.hpp"
#include "psd_test_support.hpp"
#include "test_harness.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <limits>
#include <memory>
#include <sstream>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

void write_s1_psd_artifact_atomic(const std::filesystem::path& path,
                                  std::span<const std::uint8_t> bytes) {
  CHECK(bytes.size() <=
        static_cast<std::size_t>(
            std::numeric_limits<std::streamsize>::max()));
  std::filesystem::create_directories(path.parent_path());
  auto temporary = path;
  temporary += ".tmp";
  std::filesystem::remove(temporary);
  {
    std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
    CHECK(output.good());
    output.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
    output.flush();
    CHECK(output.good());
    output.close();
    CHECK(!output.fail());
  }
  CHECK(std::filesystem::file_size(temporary) == bytes.size());
  std::vector<std::uint8_t> stored(bytes.size());
  {
    std::ifstream input(temporary, std::ios::binary);
    CHECK(input.good());
    input.read(reinterpret_cast<char*>(stored.data()),
               static_cast<std::streamsize>(stored.size()));
    CHECK(input.gcount() == static_cast<std::streamsize>(stored.size()));
    CHECK(input.good());
  }
  CHECK(stored.size() == bytes.size());
  CHECK(std::equal(stored.begin(), stored.end(), bytes.begin(), bytes.end()));
  std::filesystem::remove(path);
  std::filesystem::rename(temporary, path);
}

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

template <typename BuildPayload>
void check_adjustment_payload_budget(std::size_t expected_bytes,
                                     std::uint64_t expected_hash,
                                     std::uint64_t expected_peak,
                                     BuildPayload&& build_payload) {
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(expected_peak, &current,
                                                &high_water);
    const auto payload = build_payload(tracker);
    CHECK(payload.bytes.size() == expected_bytes);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) == expected_hash);
    CHECK(current == expected_bytes);
    CHECK(high_water == expected_peak);
  }
  CHECK(current == 0U);

  for (const auto limit :
       std::array<std::uint64_t, 2>{expected_peak - 1U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current,
                                                  &high_water);
      (void)build_payload(tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water <= limit);
  }
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

void psd_save_native_adjustment_payloads_own_exact_budget() {
  patchy::LevelsAdjustment levels;
  levels.black_input = 12;
  levels.white_input = 240;
  levels.gamma_percent = 125;
  levels.black_output = 4;
  levels.white_output = 250;
  levels.red = {5, 230, 90, 11, 244};
  levels.green = {9, 220, 110, 13, 242};
  levels.blue = {17, 210, 140, 19, 238};
  check_adjustment_payload_budget(
      292U, 0xbdeb9efaf6e93c5aULL, 292U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_levels_payload_tracked(levels, tracker);
      });

  patchy::CurvesAdjustment curves;
  curves.rgb = {{0, 10}, {128, 200}, {255, 250}};
  check_adjustment_payload_budget(
      48U, 0x4cfe755d7e6f8419ULL, 48U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_curves_payload_tracked(curves, nullptr,
                                                             tracker);
      });

  patchy::HueSaturationAdjustment hue;
  hue.colorize = true;
  hue.colorize_hue = 203;
  hue.colorize_saturation = 52;
  check_adjustment_payload_budget(
      136U, 0xad4d7772401a6809ULL, 136U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_hue2_payload_tracked(hue, nullptr,
                                                           tracker);
      });

  patchy::PosterizeAdjustment posterize;
  posterize.levels = 6;
  check_adjustment_payload_budget(
      4U, 0x192c947f805e1bf3ULL, 4U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_posterize_payload_tracked(
            posterize, nullptr, tracker);
      });

  patchy::ThresholdAdjustment threshold;
  threshold.level = 96;
  check_adjustment_payload_budget(
      4U, 0x37f6167f00ce3e95ULL, 4U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_threshold_payload_tracked(
            threshold, nullptr, tracker);
      });

  patchy::ColorBalanceAdjustment color_balance;
  color_balance.cyan_red = -10;
  color_balance.magenta_green = 20;
  color_balance.yellow_blue = -30;
  check_adjustment_payload_budget(
      20U, 0x7183ad462ceed3d1ULL, 20U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_color_balance_payload_tracked(
            color_balance, nullptr, tracker);
      });

  patchy::BrightnessContrastAdjustment brightness_contrast;
  brightness_contrast.brightness = 25;
  brightness_contrast.contrast = 15;
  patchy::Layer layer(1U, "Brightness/Contrast",
                      patchy::LayerKind::Adjustment);
  check_adjustment_payload_budget(
      8U, 0xa8c7f832281a39c5ULL, 8U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_brightness_contrast_payload_tracked(
            brightness_contrast, layer, tracker);
      });

  constexpr std::size_t kDescriptorBytes = 131U;
  constexpr std::uint64_t kDescriptorHash = 0xa04b391817bca1a9ULL;
  check_adjustment_payload_budget(
      kDescriptorBytes, kDescriptorHash, kDescriptorBytes,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        auto payload = patchy::psd::
            photoshop_brightness_contrast_descriptor_payload_tracked(
                brightness_contrast, layer, tracker);
        CHECK(payload.has_value());
        return std::move(*payload);
      });
}

void psd_save_hue_payload_patch_tail_and_budget_are_stable() {
  patchy::HueSaturationAdjustment hue;
  hue.colorize = true;
  hue.colorize_hue = 203;
  hue.colorize_saturation = 52;
  auto imported = patchy::psd::photoshop_hue2_payload(hue, nullptr);
  CHECK(imported.size() == 136U);
  imported.resize(4096U);
  for (std::size_t index = 136U; index < imported.size(); ++index) {
    imported[index] = static_cast<std::uint8_t>(index & 0xffU);
  }
  const patchy::UnknownPsdBlock original{"hue2", imported};

  constexpr std::uint64_t kPayloadBytes = 4096U;
  constexpr std::uint64_t kHeaderBytes = 100U;
  constexpr std::uint64_t kExactPeak = kPayloadBytes + kHeaderBytes;
  constexpr std::uint64_t kHash = 0xa16e223bc030b531ULL;
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(kExactPeak, &current,
                                                &high_water);
    const auto payload = patchy::psd::photoshop_hue2_payload_tracked(
        hue, &original, tracker);
    CHECK(payload.bytes == imported);
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) == kHash);
    CHECK(std::equal(payload.bytes.begin() + 136, payload.bytes.end(),
                     imported.begin() + 136));
    CHECK(current == kPayloadBytes);
    CHECK(high_water == kExactPeak);
  }
  CHECK(current == 0U);

  for (const auto limit :
       std::array<std::uint64_t, 2>{kExactPeak - 1U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current,
                                                  &high_water);
      (void)patchy::psd::photoshop_hue2_payload_tracked(hue, &original,
                                                        tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water <= limit);
  }
}

void psd_save_adjustment_raw_copy_and_malformed_paths_are_stable() {
  patchy::PosterizeAdjustment posterize;
  posterize.levels = 6;
  std::vector<std::uint8_t> posterize_bytes(257U);
  posterize_bytes[0] = 0U;
  posterize_bytes[1] = 6U;
  for (std::size_t index = 2U; index < posterize_bytes.size(); ++index) {
    posterize_bytes[index] = static_cast<std::uint8_t>(index & 0xffU);
  }
  const patchy::UnknownPsdBlock posterize_original{"post", posterize_bytes};
  check_adjustment_payload_budget(
      257U, 0x21f686a69d4ed7d8ULL, 257U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_posterize_payload_tracked(
            posterize, &posterize_original, tracker);
      });

  patchy::CurvesAdjustment curves;
  curves.rgb = {{0, 10}, {128, 200}, {255, 250}};
  const patchy::UnknownPsdBlock malformed_curves{
      "curv", {0xffU, 0x00U, 0x01U, 0x02U, 0x03U}};
  check_adjustment_payload_budget(
      48U, 0x4cfe755d7e6f8419ULL, 48U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_curves_payload_tracked(
            curves, &malformed_curves, tracker);
      });

  patchy::ColorBalanceAdjustment color_balance;
  color_balance.cyan_red = -10;
  color_balance.magenta_green = 20;
  color_balance.yellow_blue = -30;
  std::vector<std::uint8_t> balance_bytes(64U);
  for (std::size_t index = 0U; index < balance_bytes.size(); ++index) {
    balance_bytes[index] =
        static_cast<std::uint8_t>((index * 37U + 11U) & 0xffU);
  }
  const patchy::UnknownPsdBlock balance_original{"blnc", balance_bytes};
  check_adjustment_payload_budget(
      64U, 0x9055ccc52090f2f6ULL, 64U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_color_balance_payload_tracked(
            color_balance, &balance_original, tracker);
      });

  patchy::BrightnessContrastAdjustment legacy;
  legacy.brightness = 11;
  legacy.contrast = -12;
  legacy.use_legacy = true;
  patchy::Layer layer(2U, "Imported brightness", patchy::LayerKind::Adjustment);
  std::vector<std::uint8_t> brit_bytes(64U);
  for (std::size_t index = 0U; index < brit_bytes.size(); ++index) {
    brit_bytes[index] = static_cast<std::uint8_t>((index * 13U) & 0xffU);
  }
  brit_bytes[0] = 0U;
  brit_bytes[1] = 11U;
  brit_bytes[2] = 0xffU;
  brit_bytes[3] = 0xf4U;
  layer.unknown_psd_blocks().push_back(
      patchy::UnknownPsdBlock{"brit", brit_bytes});
  constexpr std::array<std::uint8_t, 7> kMalformedCgEd{
      0xdeU, 0xadU, 0xbeU, 0xefU, 1U, 2U, 3U};
  layer.unknown_psd_blocks().push_back(patchy::UnknownPsdBlock{
      "CgEd", std::vector<std::uint8_t>(kMalformedCgEd.begin(),
                                        kMalformedCgEd.end())});

  check_adjustment_payload_budget(
      64U, 0xeee77cdb858cfbebULL, 64U,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_brightness_contrast_payload_tracked(
            legacy, layer, tracker);
      });
  check_adjustment_payload_budget(
      kMalformedCgEd.size(), 0x5796f337d1dc7f4dULL,
      kMalformedCgEd.size(),
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        auto payload = patchy::psd::
            photoshop_brightness_contrast_descriptor_payload_tracked(
                legacy, layer, tracker);
        CHECK(payload.has_value());
        return std::move(*payload);
      });
}

void psd_save_adjustment_payload_owners_stage_and_unwind() {
  patchy::LevelsAdjustment levels;
  patchy::ColorBalanceAdjustment color_balance;
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(312U, &current, &high_water);
    const auto levels_payload =
        patchy::psd::photoshop_levels_payload_tracked(levels, tracker);
    CHECK(current == 292U);
    {
      const auto balance_payload =
          patchy::psd::photoshop_color_balance_payload_tracked(
              color_balance, nullptr, tracker);
      CHECK(levels_payload.bytes.size() == 292U);
      CHECK(balance_payload.bytes.size() == 20U);
      CHECK(current == 312U);
      CHECK(high_water == 312U);
    }
    CHECK(current == 292U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(311U, &current, &high_water);
    const auto levels_payload =
        patchy::psd::photoshop_levels_payload_tracked(levels, tracker);
    bool rejected = false;
    try {
      (void)patchy::psd::photoshop_color_balance_payload_tracked(
          color_balance, nullptr, tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(levels_payload.bytes.size() == 292U);
    CHECK(current == 292U);
    CHECK(high_water == 292U);
  }
  CHECK(current == 0U);
}

void psd_save_adjustment_payload_reaches_public_live_budget() {
  patchy::HueSaturationAdjustment hue;
  hue.colorize = true;
  hue.colorize_hue = 203;
  hue.colorize_saturation = 52;
  auto imported = patchy::psd::photoshop_hue2_payload(hue, nullptr);
  imported.resize(4096U);
  for (std::size_t index = 136U; index < imported.size(); ++index) {
    imported[index] = static_cast<std::uint8_t>(index & 0xffU);
  }

  patchy::Document document(1, 1, patchy::PixelFormat::rgb8());
  document.add_pixel_layer(
      "Base", patchy::test::solid_rgb(1, 1, 20U, 30U, 40U));
  patchy::AdjustmentSettings settings;
  settings.kind = patchy::AdjustmentKind::HueSaturation;
  settings.hue_saturation = hue;
  patchy::Layer adjustment(document.allocate_layer_id(), "Hue",
                           patchy::LayerKind::Adjustment);
  adjustment.set_bounds(patchy::Rect::from_size(1, 1));
  patchy::configure_adjustment_layer(adjustment, settings);
  adjustment.unknown_psd_blocks().push_back(
      patchy::UnknownPsdBlock{"hue2", imported});
  document.add_layer(std::move(adjustment));

  patchy::psd::SaveUsage measured_usage;
  patchy::psd::WriteOptions measured_options;
  measured_options.usage = &measured_usage;
  const auto baseline = patchy::psd::DocumentIo::write_layered_rgb8(
      document, measured_options);
  constexpr std::size_t kOutputBytes = 4359U;
  constexpr std::uint64_t kOutputHash = 0x3cfe5cfb993ec789ULL;
  constexpr std::uint64_t kExactPeak = 8619U;
  CHECK(baseline.size() == kOutputBytes);
  CHECK(patchy::test::fnv1a_hash_bytes(baseline) == kOutputHash);
  CHECK(measured_usage.tracked_live_bytes == 0U);
  CHECK(measured_usage.tracked_live_bytes_high_water == kExactPeak);

  patchy::psd::SaveUsage exact_usage;
  auto exact_options = measured_options;
  exact_options.budget.max_tracked_live_bytes = kExactPeak;
  exact_options.usage = &exact_usage;
  CHECK(patchy::psd::DocumentIo::write_layered_rgb8(document,
                                                     exact_options) ==
        baseline);
  CHECK(exact_usage.tracked_live_bytes == 0U);
  CHECK(exact_usage.tracked_live_bytes_high_water == kExactPeak);

  for (const auto limit :
       std::array<std::uint64_t, 2>{kExactPeak - 1U, 0U}) {
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

template <typename BuildPayload>
void check_layer_payload_budget_matches_bytes(
    std::span<const std::uint8_t> expected, BuildPayload&& build_payload,
    bool expect_nested_peak = false) {
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  std::uint64_t exact_peak = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(
        std::numeric_limits<std::uint64_t>::max(), &current, &high_water);
    const auto payload = build_payload(tracker);
    CHECK(payload.bytes.size() == expected.size());
    CHECK(std::equal(payload.bytes.begin(), payload.bytes.end(),
                     expected.begin(), expected.end()));
    CHECK(current == payload.bytes.size());
    CHECK(high_water >= current);
    if (expect_nested_peak) {
      CHECK(high_water > current);
    }
    exact_peak = high_water;
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(exact_peak, &current,
                                                &high_water);
    const auto payload = build_payload(tracker);
    CHECK(payload.bytes.size() == expected.size());
    CHECK(std::equal(payload.bytes.begin(), payload.bytes.end(),
                     expected.begin(), expected.end()));
    CHECK(high_water == exact_peak);
  }
  CHECK(current == 0U);

  for (const auto limit :
       std::array<std::uint64_t, 2>{exact_peak - 1U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current,
                                                  &high_water);
      (void)build_payload(tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water <= limit);
  }
}

void psd_save_luni_and_lfx2_payloads_own_budget() {
  const std::string name = "A\xF0\x9F\x99\x82";
  const auto legacy_luni = patchy::psd::unicode_string_payload(name);
  CHECK(legacy_luni.size() == 10U);
  check_layer_payload_budget_matches_bytes(
      legacy_luni,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::unicode_string_payload_tracked(name, tracker);
      },
      true);

  patchy::LayerStyle style;
  patchy::LayerGradientFill fill;
  fill.enabled = true;
  fill.gradient.form = patchy::GradientDefinitionForm::Noise;
  for (int index = 0; index < 64; ++index) {
    const auto location = static_cast<float>(63 - index) / 63.0F;
    fill.gradient.color_stops.push_back(patchy::GradientColorStop{
        location,
        patchy::RgbColor{static_cast<std::uint8_t>(index), 40U, 90U}});
    fill.gradient.alpha_stops.push_back(
        patchy::GradientAlphaStop{location, index % 2 == 0 ? 0.25F : 1.0F});
  }
  style.gradient_fills.push_back(fill);
  patchy::LayerStroke gradient_stroke;
  gradient_stroke.enabled = true;
  gradient_stroke.uses_gradient = true;
  gradient_stroke.size = 4.0F;
  // Empty stop arrays deliberately exercise the two-stop normalization path.
  style.strokes.push_back(gradient_stroke);
  const auto legacy_lfx2 =
      patchy::psd::photoshop_lfx2_layer_style_payload(style);
  check_layer_payload_budget_matches_bytes(
      legacy_lfx2,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::photoshop_lfx2_layer_style_payload_tracked(
            style, tracker);
      },
      true);
}

void psd_save_patched_fill_opacity_owns_budget() {
  constexpr std::array<std::uint8_t, 4> kOriginal{
      0xEEU, 0xA1U, 0xB2U, 0xC3U};
  constexpr std::array<std::uint8_t, 4> kExpected{
      0x80U, 0xA1U, 0xB2U, 0xC3U};
  constexpr std::uint64_t kExpectedHash = 0xaa3ab6adc3791f41ULL;
  std::uint64_t current = 0U;
  std::uint64_t high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(4U, &current, &high_water);
    const auto payload =
        patchy::psd::patched_fill_opacity_payload_tracked(
            kOriginal, kExpected[0], tracker);
    CHECK(std::equal(payload.bytes.begin(), payload.bytes.end(),
                     kExpected.begin(), kExpected.end()));
    CHECK(patchy::test::fnv1a_hash_bytes(payload.bytes) == kExpectedHash);
    CHECK(current == 4U);
    CHECK(high_water == 4U);
  }
  CHECK(current == 0U);

  current = 0U;
  high_water = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(11U, &current, &high_water);
    auto enclosing_extra = tracker.reserve(7U);
    {
      const auto payload =
          patchy::psd::patched_fill_opacity_payload_tracked(
              kOriginal, kExpected[0], tracker);
      CHECK(current == 11U);
      CHECK(high_water == 11U);
    }
    CHECK(current == 7U);
  }
  CHECK(current == 0U);

  for (const auto limit : std::array<std::uint64_t, 2>{3U, 0U}) {
    current = 0U;
    high_water = 0U;
    bool rejected = false;
    try {
      patchy::psd::SaveLiveBudgetTracker tracker(limit, &current,
                                                  &high_water);
      (void)patchy::psd::patched_fill_opacity_payload_tracked(
          kOriginal, kExpected[0], tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      rejected = true;
    }
    CHECK(rejected);
    CHECK(current == 0U);
    CHECK(high_water <= limit);
  }
}

void psd_save_vector_and_placed_payloads_own_budget() {
  patchy::LiveShapeParams live_rect;
  live_rect.kind = patchy::LiveShapeKind::Rectangle;
  live_rect.left = 8.0;
  live_rect.top = 6.0;
  live_rect.right = 44.0;
  live_rect.bottom = 30.0;
  live_rect.index = 0;
  patchy::populate_live_shape_box_corners(live_rect);
  patchy::VectorPath path;
  path.subpaths = patchy::generate_live_shape_subpaths(live_rect);
  const auto legacy_mask = patchy::psd::vector_mask_block_payload(
      path, true, false, true, 64, 48);
  check_layer_payload_budget_matches_bytes(
      legacy_mask,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_mask_block_payload_tracked(
            path, true, false, true, 64, 48, tracker);
      });

  patchy::VectorFill fill;
  fill.kind = patchy::VectorFillKind::Solid;
  fill.color = patchy::RgbColor{17, 34, 51};
  const auto legacy_fill =
      patchy::psd::vector_fill_block_payload(fill, nullptr);
  check_layer_payload_budget_matches_bytes(
      legacy_fill,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_fill_block_payload_tracked(
            fill, nullptr, tracker);
      });

  patchy::VectorStroke stroke;
  stroke.enabled = true;
  stroke.width = 3.5;
  stroke.dashes = {2.0, 1.0};
  stroke.content.kind = patchy::VectorFillKind::Solid;
  stroke.content.color = patchy::RgbColor{90, 120, 210};
  const auto legacy_stroke =
      patchy::psd::vector_stroke_block_payload(stroke, nullptr);
  check_layer_payload_budget_matches_bytes(
      legacy_stroke,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_stroke_block_payload_tracked(
            stroke, nullptr, tracker);
      });

  const std::array<patchy::LiveShapeParams, 1> origination{live_rect};
  const auto legacy_origination =
      patchy::psd::vector_origination_block_payload(origination, nullptr);
  check_layer_payload_budget_matches_bytes(
      legacy_origination,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_origination_block_payload_tracked(
            origination, nullptr, tracker);
      });

  // Preserved branches must own their raw copy just like generated branches.
  const patchy::UnknownPsdBlock preserved_fill{
      patchy::psd::vector_fill_block_key(fill.kind), legacy_fill};
  const patchy::UnknownPsdBlock preserved_stroke{"vstk", legacy_stroke};
  const patchy::UnknownPsdBlock preserved_origination{"vogk",
                                                       legacy_origination};
  check_layer_payload_budget_matches_bytes(
      legacy_fill,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_fill_block_payload_tracked(
            fill, &preserved_fill, tracker);
      });
  check_layer_payload_budget_matches_bytes(
      legacy_stroke,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_stroke_block_payload_tracked(
            stroke, &preserved_stroke, tracker);
      });
  check_layer_payload_budget_matches_bytes(
      legacy_origination,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_origination_block_payload_tracked(
            origination, &preserved_origination, tracker);
      });

  auto patched_fill = fill;
  patched_fill.color = patchy::RgbColor{70, 80, 90};
  const auto legacy_patched_fill =
      patchy::psd::vector_fill_block_payload(patched_fill, &preserved_fill);
  check_layer_payload_budget_matches_bytes(
      legacy_patched_fill,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_fill_block_payload_tracked(
            patched_fill, &preserved_fill, tracker);
      },
      true);

  auto patched_stroke = stroke;
  patched_stroke.width = 7.0;
  const auto legacy_patched_stroke =
      patchy::psd::vector_stroke_block_payload(patched_stroke,
                                                &preserved_stroke);
  check_layer_payload_budget_matches_bytes(
      legacy_patched_stroke,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_stroke_block_payload_tracked(
            patched_stroke, &preserved_stroke, tracker);
      },
      true);

  auto patched_origination = origination;
  patched_origination[0].right += 2.0;
  const auto legacy_patched_origination =
      patchy::psd::vector_origination_block_payload(
          patched_origination, &preserved_origination);
  check_layer_payload_budget_matches_bytes(
      legacy_patched_origination,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_origination_block_payload_tracked(
            patched_origination, &preserved_origination, tracker);
      });

  patchy::psd::DescriptorObject custom_descriptor;
  custom_descriptor.class_id = "null";
  patchy::psd::DescriptorValue custom_raw;
  custom_raw.type = patchy::psd::DescriptorValue::Type::Raw;
  custom_raw.raw_value.resize(4096U, 0x5AU);
  custom_descriptor.key_order.push_back({"Data", false});
  custom_descriptor.values.emplace("Data", std::move(custom_raw));
  patchy::psd::BigEndianWriter custom_writer;
  patchy::psd::write_descriptor(custom_writer, custom_descriptor);
  patchy::LiveShapeParams custom_shape;
  custom_shape.kind = patchy::LiveShapeKind::Custom;
  custom_shape.index = 0;
  custom_shape.raw_descriptor = std::move(custom_writer).take_bytes();
  const std::array<patchy::LiveShapeParams, 1> custom_origination{
      std::move(custom_shape)};
  const auto legacy_custom_origination =
      patchy::psd::vector_origination_block_payload(custom_origination,
                                                     nullptr);
  check_layer_payload_budget_matches_bytes(
      legacy_custom_origination,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        return patchy::psd::vector_origination_block_payload_tracked(
            custom_origination, nullptr, tracker);
      },
      true);

  std::uint64_t coverage_current = 0U;
  std::uint64_t coverage_peak = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(
        custom_origination[0].raw_descriptor.size(), &coverage_current,
        &coverage_peak);
    CHECK(patchy::psd::origination_covers_path_groups(
        path, custom_origination, &tracker));
  }
  CHECK(coverage_current == 0U);
  CHECK(coverage_peak == custom_origination[0].raw_descriptor.size());
  bool coverage_rejected = false;
  try {
    patchy::psd::SaveLiveBudgetTracker tracker(
        custom_origination[0].raw_descriptor.size() - 1U,
        &coverage_current, &coverage_peak);
    (void)patchy::psd::origination_covers_path_groups(
        path, custom_origination, &tracker);
  } catch (const patchy::psd::SaveLiveBudgetSignal&) {
    coverage_rejected = true;
  }
  CHECK(coverage_rejected);
  CHECK(coverage_current == 0U);

  // Two returned payload owners can be staged at once by the layer writer.
  std::uint64_t staged_current = 0U;
  std::uint64_t staged_peak = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(
        std::numeric_limits<std::uint64_t>::max(), &staged_current,
        &staged_peak);
    const auto fill_owner =
        patchy::psd::vector_fill_block_payload_tracked(fill, nullptr, tracker);
    const auto mask_owner = patchy::psd::vector_mask_block_payload_tracked(
        path, false, false, false, 64, 48, tracker);
    CHECK(staged_current == fill_owner.bytes.size() + mask_owner.bytes.size());
    CHECK(staged_peak >= staged_current);
  }
  CHECK(staged_current == 0U);
  CHECK(staged_peak > std::max(legacy_fill.size(), legacy_mask.size()));
  staged_current = 0U;
  std::uint64_t rejected_peak = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(
        staged_peak - 1U, &staged_current, &rejected_peak);
    const auto fill_owner =
        patchy::psd::vector_fill_block_payload_tracked(fill, nullptr, tracker);
    bool staged_rejected = false;
    try {
      (void)patchy::psd::vector_mask_block_payload_tracked(
          path, false, false, false, 64, 48, tracker);
    } catch (const patchy::psd::SaveLiveBudgetSignal&) {
      staged_rejected = true;
    }
    CHECK(staged_rejected);
    CHECK(staged_current == fill_owner.bytes.size());
    CHECK(rejected_peak <= staged_peak - 1U);
  }
  CHECK(staged_current == 0U);

  patchy::SmartObjectPlacement placement;
  placement.uuid = "source-uuid";
  placement.transform = {1.0, 2.0, 21.0, 2.0, 21.0, 12.0, 1.0, 12.0};
  placement.width = 20.0;
  placement.height = 10.0;
  placement.resolution = 72.0;
  const auto source = patchy::psd::author_placed_layer_sold_payload(
      placement, "placed-uuid", nullptr);
  placement.transform[0] += 5.0;
  placement.transform[1] += 3.0;
  const auto legacy_placed = patchy::psd::regenerate_placed_layer_payload(
      "SoLd", source, placement, nullptr, "placed-uuid", {});
  CHECK(legacy_placed.has_value());
  check_layer_payload_budget_matches_bytes(
      *legacy_placed,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        auto payload = patchy::psd::regenerate_placed_layer_payload_tracked(
            "SoLd", source, placement, nullptr, "placed-uuid", {}, tracker);
        CHECK(payload.has_value());
        return std::move(*payload);
      });

  const auto legacy_sole = patchy::psd::regenerate_placed_layer_payload(
      "SoLE", source, placement, nullptr, "placed-uuid", {});
  CHECK(legacy_sole.has_value());
  check_layer_payload_budget_matches_bytes(
      *legacy_sole,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        auto payload = patchy::psd::regenerate_placed_layer_payload_tracked(
            "SoLE", source, placement, nullptr, "placed-uuid", {}, tracker);
        CHECK(payload.has_value());
        return std::move(*payload);
      });

  patchy::psd::BigEndianWriter plld_writer;
  for (const char ch : {'p', 'l', 'c', 'L'}) {
    plld_writer.write_u8(static_cast<std::uint8_t>(ch));
  }
  plld_writer.write_u32(3U);
  const std::string old_uuid = "old-placed-uuid";
  plld_writer.write_u8(static_cast<std::uint8_t>(old_uuid.size()));
  for (const char ch : old_uuid) {
    plld_writer.write_u8(static_cast<std::uint8_t>(ch));
  }
  plld_writer.write_u32(1U);
  plld_writer.write_u32(1U);
  plld_writer.write_u32(0U);
  plld_writer.write_u32(1U);
  for (const auto value :
       std::array<double, 8>{0.0, 0.0, 20.0, 0.0, 20.0, 10.0, 0.0, 10.0}) {
    patchy::psd::write_f64(plld_writer, value);
  }
  plld_writer.write_u32(0x01020304U);
  const auto plld_source = std::move(plld_writer).take_bytes();
  for (const std::string_view key : {"PlLd", "plLd"}) {
    const auto legacy = patchy::psd::regenerate_placed_layer_payload(
        key, plld_source, placement, nullptr, "placed-uuid", {});
    CHECK(legacy.has_value());
    CHECK(legacy->size() >= 4U);
    CHECK((*legacy)[legacy->size() - 4U] == 0x01U);
    CHECK((*legacy)[legacy->size() - 3U] == 0x02U);
    CHECK((*legacy)[legacy->size() - 2U] == 0x03U);
    CHECK((*legacy)[legacy->size() - 1U] == 0x04U);
    check_layer_payload_budget_matches_bytes(
        *legacy,
        [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
          auto payload =
              patchy::psd::regenerate_placed_layer_payload_tracked(
                  key, plld_source, placement, nullptr, "placed-uuid", {},
                  tracker);
          CHECK(payload.has_value());
          return std::move(*payload);
        });
  }

  for (const std::string_view key : {"SoLd", "SoLE", "PlLd", "plLd"}) {
    std::uint64_t malformed_current = 0U;
    std::uint64_t malformed_peak = 0U;
    patchy::psd::SaveLiveBudgetTracker tracker(
        0U, &malformed_current, &malformed_peak);
    CHECK(!patchy::psd::regenerate_placed_layer_payload_tracked(
               key, std::array<std::uint8_t, 3>{1U, 2U, 3U}, placement,
               nullptr, "placed-uuid", {}, tracker)
               .has_value());
    CHECK(malformed_current == 0U);
    CHECK(malformed_peak == 0U);
  }
}

void psd_save_tysh_payload_owns_budget_and_unwinds() {
  patchy::Layer layer(1U, "Text", patchy::test::solid_rgba(
                                      80, 32, 0U, 0U, 0U, 0U));
  layer.set_bounds(patchy::Rect{4, 6, 80, 32});
  layer.metadata()[patchy::kLayerMetadataText] = "Hi\xF0\x9F\x99\x82";
  layer.metadata()[patchy::kLayerMetadataTextRuns] =
      "v1\n0\t4\t24\t0\t0\t#112233\tArial";
  layer.metadata()[patchy::kLayerMetadataTextParagraphRuns] =
      "v1\n0\t4\tleft";
  layer.metadata()[patchy::kLayerMetadataTextFont] = "Arial";
  layer.metadata()[patchy::kLayerMetadataTextSize] = "24";
  layer.metadata()[patchy::kLayerMetadataTextColor] = "#112233";
  layer.metadata()[patchy::kLayerMetadataTextRasterStatus] = "patchy_raster";

  const auto legacy = patchy::psd::photoshop_type_tool_payload_for_layer(
      layer, layer.bounds());
  CHECK(legacy.has_value());
  CHECK((legacy->size() % 2U) == 0U);
  {
    std::uint64_t current = 0U;
    std::uint64_t high_water = 0U;
    patchy::psd::TypeToolPayloadTrace trace;
    patchy::psd::SaveLiveBudgetTracker tracker(
        std::numeric_limits<std::uint64_t>::max(), &current, &high_water);
    const auto traced =
        patchy::psd::photoshop_type_tool_payload_for_layer_tracked(
            layer, layer.bounds(), tracker, &trace);
    CHECK(traced.has_value());
    CHECK(traced->bytes == *legacy);
    CHECK(trace.odd_rebuild_performed);
    CHECK((trace.odd_candidate_bytes % 2U) == 1U);
    CHECK(trace.current_after_odd_candidate_release ==
          trace.engine_bytes_before_first_candidate);
  }
  check_layer_payload_budget_matches_bytes(
      *legacy,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        auto payload =
            patchy::psd::photoshop_type_tool_payload_for_layer_tracked(
                layer, layer.bounds(), tracker);
        CHECK(payload.has_value());
        return std::move(*payload);
      },
      true);

  // Imported same-length text exercises template extraction, unescape
  // ownership, old/new UTF-16 owners, and the copied TySh payload together.
  patchy::Layer templated = layer;
  templated.metadata()[patchy::kLayerMetadataText] =
      "Ho\xF0\x9F\x99\x82";
  templated.metadata()[patchy::kLayerMetadataTextSourceBlock] = "TySh";
  templated.metadata()[patchy::kLayerMetadataTextRasterStatus] =
      "psd_raster_preview";
  templated.unknown_psd_blocks().push_back(
      patchy::UnknownPsdBlock{"TySh", *legacy});
  const auto legacy_templated =
      patchy::psd::photoshop_type_tool_payload_for_layer(
          templated, templated.bounds());
  CHECK(legacy_templated.has_value());
  CHECK(*legacy_templated != *legacy);
  check_layer_payload_budget_matches_bytes(
      *legacy_templated,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        auto payload =
            patchy::psd::photoshop_type_tool_payload_for_layer_tracked(
                templated, templated.bounds(), tracker);
        CHECK(payload.has_value());
        return std::move(*payload);
      },
      true);

  // Malformed and no-match templates must fall back to a fresh authored TySh
  // without leaking a failed candidate's reservation.
  patchy::Layer malformed = templated;
  malformed.unknown_psd_blocks().clear();
  malformed.unknown_psd_blocks().push_back(
      patchy::UnknownPsdBlock{"TySh", {1U, 2U, 3U}});
  const auto malformed_fallback =
      patchy::psd::photoshop_type_tool_payload_for_layer(
          malformed, malformed.bounds());
  CHECK(malformed_fallback.has_value());
  check_layer_payload_budget_matches_bytes(
      *malformed_fallback,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        auto payload =
            patchy::psd::photoshop_type_tool_payload_for_layer_tracked(
                malformed, malformed.bounds(), tracker);
        CHECK(payload.has_value());
        return std::move(*payload);
      },
      true);

  patchy::Layer no_match = templated;
  no_match.metadata()[patchy::kLayerMetadataText] = "Longer text";
  const auto no_match_fallback =
      patchy::psd::photoshop_type_tool_payload_for_layer(
          no_match, no_match.bounds());
  CHECK(no_match_fallback.has_value());
  check_layer_payload_budget_matches_bytes(
      *no_match_fallback,
      [&](patchy::psd::SaveLiveBudgetTracker& tracker) {
        auto payload =
            patchy::psd::photoshop_type_tool_payload_for_layer_tracked(
                no_match, no_match.bounds(), tracker);
        CHECK(payload.has_value());
        return std::move(*payload);
      },
      true);
}

void psd_save_staged_layer_records_release_and_aliases_count() {
  const auto make_text_layer = [](std::uint32_t id, std::string name,
                                  std::string text) {
    patchy::Layer layer(id, std::move(name), patchy::test::solid_rgba(
                                                80, 32, 0U, 0U, 0U, 0U));
    layer.set_bounds(patchy::Rect{4, 6, 80, 32});
    layer.metadata()[patchy::kLayerMetadataText] = std::move(text);
    layer.metadata()[patchy::kLayerMetadataTextRuns] =
        "v1\n0\t4\t24\t0\t0\t#112233\tArial";
    layer.metadata()[patchy::kLayerMetadataTextParagraphRuns] =
        "v1\n0\t4\tleft";
    layer.metadata()[patchy::kLayerMetadataTextFont] = "Arial";
    layer.metadata()[patchy::kLayerMetadataTextSize] = "24";
    layer.metadata()[patchy::kLayerMetadataTextColor] = "#112233";
    layer.metadata()[patchy::kLayerMetadataTextRasterStatus] =
        "patchy_raster";
    return layer;
  };
  auto first = make_text_layer(1U, "First \xF0\x9F\x99\x82",
                               "Hi\xF0\x9F\x99\x82");
  auto second = make_text_layer(2U, "Second \xF0\x9F\x99\x82",
                                "Ho\xF0\x9F\x99\x82");

  const auto write_record = [](const patchy::Layer& layer,
                               patchy::psd::SaveLiveBudgetTracker& tracker) {
    patchy::psd::EncodedLayer encoded;
    encoded.layer = &layer;
    encoded.kind = patchy::psd::EncodedLayerKind::Pixel;
    encoded.bounds = layer.bounds();
    encoded.blending_ranges = &layer.raw_psd_blending_ranges();
    patchy::psd::BigEndianWriter writer;
    patchy::psd::write_layer_record(
        writer, encoded, false, false, 0U, patchy::Rect{0, 0, 96, 48},
        tracker);
    return std::move(writer).take_bytes();
  };
  const auto measure_record_peak = [&](const patchy::Layer& layer) {
    std::uint64_t current = 0U;
    std::uint64_t high_water = 0U;
    {
      patchy::psd::SaveLiveBudgetTracker tracker(
          std::numeric_limits<std::uint64_t>::max(), &current, &high_water);
      CHECK(!write_record(layer, tracker).empty());
      CHECK(current == 0U);
    }
    CHECK(current == 0U);
    return high_water;
  };
  const auto first_peak = measure_record_peak(first);
  const auto second_peak = measure_record_peak(second);
  CHECK(first_peak > 0U);
  CHECK(second_peak > 0U);

  std::uint64_t staged_current = 0U;
  std::uint64_t staged_peak = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(
        std::numeric_limits<std::uint64_t>::max(), &staged_current,
        &staged_peak);
    CHECK(!write_record(first, tracker).empty());
    CHECK(staged_current == 0U);
    CHECK(staged_peak == first_peak);
    CHECK(!write_record(second, tracker).empty());
    CHECK(staged_current == 0U);
    CHECK(staged_peak == std::max(first_peak, second_peak));
  }
  CHECK(staged_current == 0U);

  // The same source span represents two real owners. Pointer identity must not
  // deduplicate concurrent reservations, and each owner releases independently.
  std::vector<std::uint8_t> shared_source(257U, 0x5AU);
  std::uint64_t alias_current = 0U;
  std::uint64_t alias_peak = 0U;
  {
    patchy::psd::SaveLiveBudgetTracker tracker(
        2U * shared_source.size(), &alias_current, &alias_peak);
    const auto first_owner = patchy::psd::save_tracked_byte_copy(
        shared_source, tracker);
    CHECK(alias_current == shared_source.size());
    {
      const auto second_owner = patchy::psd::save_tracked_byte_copy(
          shared_source, tracker);
      CHECK(first_owner.bytes.data() != second_owner.bytes.data());
      CHECK(alias_current == 2U * shared_source.size());
      CHECK(alias_peak == 2U * shared_source.size());
    }
    CHECK(alias_current == shared_source.size());
  }
  CHECK(alias_current == 0U);
}

patchy::Document make_generated_layer_payload_budget_document() {
  patchy::Document document(96, 48, patchy::PixelFormat::rgb8());
  document.add_pixel_layer(
      "Base", patchy::test::solid_rgb(96, 48, 8U, 12U, 16U));
  patchy::Layer text_layer(
      document.allocate_layer_id(), "Text \xF0\x9F\x99\x82",
      patchy::test::solid_rgba(80, 32, 0U, 0U, 0U, 0U));
  text_layer.set_bounds(patchy::Rect{4, 6, 80, 32});
  text_layer.metadata()[patchy::kLayerMetadataText] = "Hi\xF0\x9F\x99\x82";
  text_layer.metadata()[patchy::kLayerMetadataTextRuns] =
      "v1\n0\t4\t24\t0\t0\t#112233\tArial";
  text_layer.metadata()[patchy::kLayerMetadataTextParagraphRuns] =
      "v1\n0\t4\tleft";
  text_layer.metadata()[patchy::kLayerMetadataTextFont] = "Arial";
  text_layer.metadata()[patchy::kLayerMetadataTextSize] = "24";
  text_layer.metadata()[patchy::kLayerMetadataTextColor] = "#112233";
  text_layer.metadata()[patchy::kLayerMetadataTextRasterStatus] =
      "patchy_raster";
  patchy::LayerColorOverlay overlay;
  overlay.enabled = true;
  overlay.color = patchy::RgbColor{90U, 40U, 180U};
  text_layer.layer_style().color_overlays.push_back(overlay);
  text_layer.set_fill_opacity(0.5F);
  text_layer.unknown_psd_blocks().push_back(
      patchy::UnknownPsdBlock{"iOpa", {0xEEU, 0xA1U, 0xB2U, 0xC3U}});
  document.add_layer(std::move(text_layer));

  patchy::Layer vector_layer(document.allocate_layer_id(), "Vector",
                             patchy::PixelBuffer());
  vector_layer.metadata()[patchy::kLayerMetadataVectorShape] = "1";
  patchy::VectorShapeContent vector_content;
  vector_content.fill.kind = patchy::VectorFillKind::Solid;
  vector_content.fill.color = patchy::RgbColor{17U, 34U, 51U};
  patchy::PathSubpath subpath;
  subpath.closed = true;
  subpath.anchors = {
      patchy::PathAnchor{12.0, 10.0, 12.0, 10.0, 12.0, 10.0, false},
      patchy::PathAnchor{60.0, 10.0, 60.0, 10.0, 60.0, 10.0, false},
      patchy::PathAnchor{36.0, 38.0, 36.0, 38.0, 36.0, 38.0, false}};
  vector_content.path.subpaths.push_back(std::move(subpath));
  vector_content.stroke.enabled = true;
  vector_content.stroke.width = 2.0;
  vector_content.stroke.content.kind = patchy::VectorFillKind::Solid;
  vector_content.stroke.content.color = patchy::RgbColor{220U, 180U, 20U};
  patchy::LiveShapeParams live_shape;
  live_shape.kind = patchy::LiveShapeKind::Rectangle;
  live_shape.left = 12.0;
  live_shape.top = 10.0;
  live_shape.right = 60.0;
  live_shape.bottom = 38.0;
  live_shape.index = 0;
  patchy::populate_live_shape_box_corners(live_shape);
  vector_content.origination.push_back(live_shape);
  vector_layer.set_vector_shape(std::move(vector_content));
  document.add_layer(std::move(vector_layer));

  patchy::Layer placed_layer(
      document.allocate_layer_id(), "Placed",
      patchy::test::solid_rgba(20, 10, 20U, 30U, 40U, 255U));
  placed_layer.set_bounds(patchy::Rect{20, 16, 20, 10});
  document.metadata().smart_objects.add_embedded(
      "source-uuid", "source.psb", "8BPB",
      std::make_shared<const std::vector<std::uint8_t>>(
          patchy::test::odd_composite_mini_psb()));
  patchy::SmartObjectPlacement placement;
  placement.uuid = "source-uuid";
  placement.transform = {20.0, 16.0, 40.0, 16.0, 40.0, 26.0, 20.0, 26.0};
  placement.width = 20.0;
  placement.height = 10.0;
  placement.resolution = 72.0;
  patchy::set_layer_smart_object_metadata(
      placed_layer, placement, "placed-uuid", "SoLd", "",
      patchy::kSmartObjectRasterStatusPhotoshop);
  placed_layer.unknown_psd_blocks().push_back(patchy::UnknownPsdBlock{
      "SoLd", patchy::psd::author_placed_layer_sold_payload(
                  placement, "placed-uuid", nullptr)});
  placement.transform[0] += 1.0;
  placement.transform[1] += 1.0;
  patchy::store_smart_object_placement(placed_layer, placement);
  patchy::mark_layer_smart_object_block_dirty(placed_layer);
  document.add_layer(std::move(placed_layer));

  patchy::AdjustmentSettings levels;
  levels.kind = patchy::AdjustmentKind::Levels;
  levels.levels.red.black_output = 24;
  patchy::Layer adjustment(document.allocate_layer_id(), "Levels",
                           patchy::LayerKind::Adjustment);
  adjustment.set_bounds(
      patchy::Rect::from_size(document.width(), document.height()));
  patchy::configure_adjustment_layer(adjustment, levels);
  document.add_layer(std::move(adjustment));
  return document;
}

void psd_save_generated_layer_payloads_reach_public_budget() {
  const auto document = make_generated_layer_payload_budget_document();
  struct Expected {
    bool large_document;
    std::size_t output_bytes;
    std::uint64_t output_hash;
    std::uint64_t exact_peak;
  };
#ifdef _WIN32
  constexpr std::array expected_cases{
      Expected{false, 11448U, 0xe3f3e0d4d890c0dcULL, 415648U},
      Expected{true, 12432U, 0x06509563506089ebULL, 415648U},
  };
#else
  constexpr std::array expected_cases{
      Expected{false, 11440U, 0xa46a8dbbd3169900ULL, 415648U},
      Expected{true, 12424U, 0x74b0d895c5bb7ad7ULL, 415648U},
  };
#endif
  const auto artifact_directory = std::filesystem::path("test-artifacts");
  const auto artifact_manifest =
      artifact_directory / "s1-generated-layer-payloads.manifest";
  std::filesystem::create_directories(artifact_directory);
  // The manifest is the publication marker. Invalidate an older pair before
  // running any acceptance assertion so a failed run cannot look successful.
  std::filesystem::remove(artifact_manifest);
  std::array<std::vector<std::uint8_t>, 2> accepted_artifacts;
  for (std::size_t index = 0U; index < expected_cases.size(); ++index) {
    const auto& expected = expected_cases[index];
    patchy::psd::SaveUsage measured_usage;
    patchy::psd::WriteOptions measured_options;
    measured_options.large_document = expected.large_document;
    measured_options.usage = &measured_usage;
    const auto baseline = patchy::psd::DocumentIo::write_layered_rgb8(
        document, measured_options);
    const auto baseline_hash = patchy::test::fnv1a_hash_bytes(baseline);
    if (baseline.size() != expected.output_bytes ||
        baseline_hash != expected.output_hash ||
        measured_usage.tracked_live_bytes_high_water != expected.exact_peak) {
      throw std::runtime_error(
          "S1 public canary mismatch: format=" +
          std::string(expected.large_document ? "PSB" : "PSD") +
          " expected_size=" + std::to_string(expected.output_bytes) +
          " actual_size=" + std::to_string(baseline.size()) +
          " expected_fnv=" + std::to_string(expected.output_hash) +
          " actual_fnv=" + std::to_string(baseline_hash) +
          " expected_peak=" + std::to_string(expected.exact_peak) +
          " actual_peak=" + std::to_string(
              measured_usage.tracked_live_bytes_high_water));
    }
    CHECK(baseline.size() == expected.output_bytes);
    CHECK(baseline_hash == expected.output_hash);
    CHECK(measured_usage.tracked_live_bytes == 0U);
    CHECK(measured_usage.tracked_live_bytes_high_water == expected.exact_peak);
    accepted_artifacts[index] = baseline;

    const auto reopened = patchy::psd::DocumentIo::read(baseline);
    CHECK(reopened.layers().size() == 5U);
    const auto* reopened_text =
        patchy::test::find_layer_named(reopened.layers(),
                                       "Text \xF0\x9F\x99\x82");
    const auto* reopened_vector =
        patchy::test::find_layer_named(reopened.layers(), "Vector");
    const auto* reopened_placed =
        patchy::test::find_layer_named(reopened.layers(), "Placed");
    const auto* reopened_adjustment =
        patchy::test::find_layer_named(reopened.layers(), "Levels");
    CHECK(reopened_text != nullptr);
    CHECK(reopened_text->metadata().contains(patchy::kLayerMetadataText));
    CHECK(reopened_text->metadata().at(patchy::kLayerMetadataText)
              .starts_with("Hi"));
    CHECK(reopened_text->fill_opacity() > 0.49F &&
          reopened_text->fill_opacity() < 0.51F);
    CHECK(reopened_vector != nullptr);
    CHECK(reopened_vector->vector_shape() != nullptr);
    CHECK(reopened_vector->vector_shape()->stroke.enabled);
    CHECK(reopened_vector->vector_shape()->origination.size() == 1U);
    CHECK(reopened_placed != nullptr);
    CHECK(patchy::smart_object_placement_from_layer(*reopened_placed)
              .has_value());
    const auto reopened_placement =
        patchy::smart_object_placement_from_layer(*reopened_placed);
    CHECK(reopened_placement->transform[0] == 21.0);
    CHECK(reopened_placement->transform[1] == 17.0);
    CHECK(reopened.metadata().smart_objects.find("source-uuid") != nullptr);
    CHECK(reopened_adjustment != nullptr);
    CHECK(reopened_adjustment->kind() == patchy::LayerKind::Adjustment);

    patchy::psd::SaveUsage exact_usage;
    auto exact_options = measured_options;
    exact_options.budget.max_tracked_live_bytes =
        expected.exact_peak;
    exact_options.usage = &exact_usage;
    CHECK(patchy::psd::DocumentIo::write_layered_rgb8(document,
                                                       exact_options) ==
          baseline);
    CHECK(exact_usage.tracked_live_bytes == 0U);
    CHECK(exact_usage.tracked_live_bytes_high_water == expected.exact_peak);

    for (const auto limit : std::array<std::uint64_t, 2>{
             expected.exact_peak - 1U, 0U}) {
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
  write_s1_psd_artifact_atomic(
      artifact_directory / "s1-generated-layer-payloads.psd",
      accepted_artifacts[0]);
  write_s1_psd_artifact_atomic(
      artifact_directory / "s1-generated-layer-payloads.psb",
      accepted_artifacts[1]);
  std::ostringstream manifest_stream;
  manifest_stream << "version=1\n";
  for (std::size_t index = 0U; index < accepted_artifacts.size(); ++index) {
    manifest_stream
        << (expected_cases[index].large_document ? "psb" : "psd")
        << " size=" << std::dec << accepted_artifacts[index].size()
        << " fnv1a=" << std::hex << std::setw(16) << std::setfill('0')
        << patchy::test::fnv1a_hash_bytes(accepted_artifacts[index]) << '\n';
  }
  const auto manifest = manifest_stream.str();
  write_s1_psd_artifact_atomic(
      artifact_manifest,
      std::span<const std::uint8_t>(
          reinterpret_cast<const std::uint8_t*>(manifest.data()),
          manifest.size()));
}

patchy::PathSubpath s2_subpath(std::initializer_list<std::array<double, 2>> points,
                               bool closed, std::int32_t group) {
  patchy::PathSubpath path;
  path.closed = closed;
  path.shape_group = group;
  for (const auto point : points) {
    path.anchors.push_back(patchy::PathAnchor{
        point[0], point[1], point[0], point[1], point[0], point[1], false});
  }
  return path;
}

patchy::PixelBuffer s2_gray(std::int32_t width, std::int32_t height,
                            std::uint8_t value) {
  patchy::PixelBuffer result(width, height, patchy::PixelFormat::gray8());
  std::fill(result.data().begin(), result.data().end(), value);
  return result;
}

patchy::Document make_s2_workspace_document() {
  patchy::Document document(48, 40, patchy::PixelFormat::rgb8());
  document.add_pixel_layer("Base", patchy::test::solid_rgb(48, 40, 12U, 18U, 24U));

  patchy::Layer outer(document.allocate_layer_id(), "Outer", patchy::LayerKind::Group);
  patchy::Layer inner(document.allocate_layer_id(), "Inner", patchy::LayerKind::Group);

  patchy::Layer carrier(document.allocate_layer_id(), "Carrier",
                        patchy::test::solid_rgba(20, 16, 30U, 80U, 150U, 255U));
  carrier.set_bounds(patchy::Rect{8, 8, 20, 16});
  carrier.set_mask(patchy::LayerMask{patchy::Rect{8, 8, 20, 16},
                                     s2_gray(20, 16, 220U), 0U, false});
  patchy::LayerVectorMask vector_mask;
  vector_mask.path.subpaths.push_back(s2_subpath(
      {{8.0, 8.0}, {28.0, 8.0}, {28.0, 24.0}, {8.0, 24.0}}, true, 0));
  vector_mask.density = 220U;
  vector_mask.feather = 3.0;
  vector_mask.cache = s2_gray(48, 40, 255U);
  carrier.set_vector_mask(std::move(vector_mask));
  inner.add_child(std::move(carrier));

  patchy::Layer styled(document.allocate_layer_id(), "Styled",
                       patchy::test::solid_rgba(20, 16, 180U, 45U, 70U, 230U));
  styled.set_bounds(patchy::Rect{10, 10, 20, 16});
  styled.set_clipped(true);
  styled.set_mask(patchy::LayerMask{patchy::Rect{10, 10, 20, 16},
                                    s2_gray(20, 16, 210U), 0U, false});
  patchy::LayerDropShadow shadow;
  shadow.enabled = true;
  shadow.distance = 5.0F;
  shadow.size = 18.0F;
  shadow.spread = 0.2F;
  styled.layer_style().drop_shadows.push_back(shadow);
  patchy::LayerOuterGlow glow;
  glow.enabled = true;
  glow.size = 24.0F;
  glow.spread = 0.15F;
  styled.layer_style().outer_glows.push_back(glow);
  patchy::LayerStroke stroke;
  stroke.enabled = true;
  stroke.size = 4.0F;
  stroke.position = patchy::LayerStrokePosition::Outside;
  stroke.color = patchy::RgbColor{240U, 180U, 30U};
  styled.layer_style().strokes.push_back(stroke);
  patchy::LayerBevelEmboss bevel;
  bevel.enabled = true;
  bevel.size = 8.0F;
  bevel.soften = 3.0F;
  styled.layer_style().bevels.push_back(bevel);
  patchy::LayerSatin satin;
  satin.enabled = true;
  satin.size = 11.0F;
  styled.layer_style().satins.push_back(satin);
  inner.add_child(std::move(styled));

  patchy::Layer open_vector(document.allocate_layer_id(), "Open strokes",
                            patchy::PixelBuffer());
  open_vector.metadata()[patchy::kLayerMetadataVectorShape] = "1";
  patchy::VectorShapeContent shape;
  shape.fill.kind = patchy::VectorFillKind::Solid;
  shape.fill.color = patchy::RgbColor{20U, 170U, 90U};
  shape.path.subpaths.push_back(s2_subpath(
      {{5.0, 30.0}, {20.0, 26.0}, {34.0, 32.0}}, false, 0));
  shape.path.subpaths.push_back(s2_subpath(
      {{12.0, 35.0}, {28.0, 28.0}, {43.0, 35.0}}, false, 1));
  shape.stroke.enabled = true;
  shape.stroke.fill_enabled = true;
  shape.stroke.width = 3.0;
  shape.stroke.alignment = patchy::VectorStrokeAlignment::Center;
  shape.stroke.content.kind = patchy::VectorFillKind::Solid;
  shape.stroke.content.color = patchy::RgbColor{245U, 210U, 40U};
  open_vector.set_vector_shape(std::move(shape));
  inner.add_child(std::move(open_vector));

  patchy::Layer compound(document.allocate_layer_id(), "Compound",
                         patchy::PixelBuffer());
  compound.metadata()[patchy::kLayerMetadataVectorShape] = "1";
  patchy::VectorShapeContent compound_shape;
  compound_shape.path.subpaths.push_back(s2_subpath(
      {{4.0, 4.0}, {12.0, 4.0}, {12.0, 12.0}, {4.0, 12.0}}, true, 10));
  compound_shape.path.subpaths.push_back(s2_subpath(
      {{32.0, 5.0}, {43.0, 5.0}, {43.0, 15.0}, {32.0, 15.0}}, true, 11));
  patchy::VectorShapePart first_part;
  first_part.groups.push_back(10);
  first_part.fill.kind = patchy::VectorFillKind::Solid;
  first_part.fill.color = patchy::RgbColor{30U, 120U, 230U};
  patchy::VectorShapePart second_part;
  second_part.groups.push_back(11);
  second_part.fill.kind = patchy::VectorFillKind::Solid;
  second_part.fill.color = patchy::RgbColor{220U, 80U, 40U};
  compound_shape.parts.push_back(std::move(first_part));
  compound_shape.parts.push_back(std::move(second_part));
  compound.set_vector_shape(std::move(compound_shape));
  inner.add_child(std::move(compound));
  outer.add_child(std::move(inner));
  document.add_layer(std::move(outer));
  return document;
}

void psd_save_s2_normalization_and_renderer_workspace_whole_gate() {
  const auto document = make_s2_workspace_document();
  const auto census = patchy::psd::save_workspace_census(document);
  if (census.normalization_owner_bytes != 290972U ||
      census.normalization_scratch_bytes != 949088U ||
      census.renderer_scratch_bytes != 2560496U) {
    throw std::runtime_error(
        "S2 workspace census mismatch: owner=" +
        std::to_string(census.normalization_owner_bytes) +
        " normalization_scratch=" +
        std::to_string(census.normalization_scratch_bytes) +
        " renderer_scratch=" +
        std::to_string(census.renderer_scratch_bytes));
  }
  CHECK(census.normalization_owner_bytes == 290972U);
  CHECK(census.normalization_scratch_bytes == 949088U);
  CHECK(census.renderer_scratch_bytes == 2560496U);

  const auto normalized = patchy::psd::prepare_compound_vector_psd(document);
  CHECK(normalized.has_value());
  const auto render = patchy::Compositor{}.flatten_rgb8_with_policy(
      *normalized, nullptr, patchy::CompositorExecutionPolicy::Sequential);
  const auto render_hash = patchy::test::fnv1a_hash_bytes(render.data());
  CHECK(render_hash == 0x501ebd773ac1f3bcULL);

  for (const bool large_document : {false, true}) {
    patchy::psd::SaveUsage measured;
    patchy::psd::WriteOptions options;
    options.large_document = large_document;
    options.usage = &measured;
    const auto baseline = patchy::psd::DocumentIo::write_layered_rgb8(document, options);
    CHECK(baseline.size() == (large_document ? 12660U : 11720U));
    CHECK(patchy::test::fnv1a_hash_bytes(baseline) ==
          (large_document ? 0xa6eecbb0a2011eb3ULL
                          : 0xa90e17b0e1df7606ULL));
    CHECK(measured.tracked_live_bytes == 0U);
    const auto peak = measured.tracked_live_bytes_high_water;
    if (peak != 3268540U) {
      throw std::runtime_error("S2 public peak mismatch: " +
                               std::to_string(peak));
    }
    CHECK(peak == 3268540U);

    const auto repeated = patchy::psd::DocumentIo::write_layered_rgb8(document, options);
    CHECK(repeated == baseline);
    CHECK(measured.tracked_live_bytes == 0U);
    CHECK(measured.tracked_live_bytes_high_water == peak);

    const auto reopened = patchy::psd::DocumentIo::read(baseline);
    CHECK(reopened.width() == document.width());
    CHECK(reopened.height() == document.height());
    CHECK(patchy::test::find_layer_named(reopened.layers(), "Outer") != nullptr);
    CHECK(patchy::test::find_layer_named(reopened.layers(), "Styled") != nullptr);
    CHECK(patchy::test::find_layer_named(reopened.layers(), "Open strokes") != nullptr);
    CHECK(patchy::test::find_layer_named(reopened.layers(), "Compound") != nullptr);
    const auto reopened_render = patchy::Compositor{}.flatten_rgb8_with_policy(
        reopened, nullptr, patchy::CompositorExecutionPolicy::Sequential);
    const auto reopened_hash =
        patchy::test::fnv1a_hash_bytes(reopened_render.data());
    CHECK(reopened_hash == 0x47648a1ddc27a07bULL);

    patchy::psd::SaveUsage exact;
    auto exact_options = options;
    exact_options.budget.max_tracked_live_bytes = peak;
    exact_options.usage = &exact;
    CHECK(patchy::psd::DocumentIo::write_layered_rgb8(document, exact_options) == baseline);
    CHECK(exact.tracked_live_bytes == 0U);
    CHECK(exact.tracked_live_bytes_high_water == peak);

    for (const auto limit : std::array<std::uint64_t, 2>{peak - 1U, 0U}) {
      patchy::psd::SaveUsage rejected;
      auto rejected_options = options;
      rejected_options.budget.max_tracked_live_bytes = limit;
      rejected_options.usage = &rejected;
      bool did_reject = false;
      try {
        (void)patchy::psd::DocumentIo::write_layered_rgb8(document,
                                                           rejected_options);
      } catch (const patchy::psd::SaveBudgetExceeded& error) {
        did_reject = true;
        CHECK(error.dimension() ==
              patchy::psd::SaveBudgetDimension::TrackedLiveBytes);
      }
      CHECK(did_reject);
      CHECK(rejected.tracked_live_bytes == 0U);
      CHECK(rejected.tracked_live_bytes_high_water <= limit);
    }
  }
}

void psd_save_s2_clone_and_geometry_census_rejects_before_workspace() {
  patchy::Document clone_document(2, 2, patchy::PixelFormat::rgb8());
  clone_document.metadata().raw_psd_image_resources.resize(131072U, 0x5AU);
  patchy::Layer marked(clone_document.allocate_layer_id(), "Marked",
                       patchy::LayerKind::Group);
  marked.raw_psd_blending_ranges().resize(32768U, 0x6BU);
  marked.unknown_psd_blocks().push_back(
      patchy::UnknownPsdBlock{"zzzz", std::vector<std::uint8_t>(65536U, 0x7CU)});
  patchy::set_compound_vector_group_kind(
      marked, patchy::CompoundVectorGroupKind::Content);
  clone_document.add_layer(std::move(marked));

  const auto clone_census =
      patchy::psd::save_workspace_census(clone_document);
  const auto copied_payload_bytes = 131072U + 32768U + 65536U;
  CHECK(clone_census.normalization_owner_bytes >=
        3U * copied_payload_bytes);
  patchy::psd::SaveUsage clone_rejected;
  patchy::psd::WriteOptions clone_rejected_options;
  clone_rejected_options.budget.max_tracked_live_bytes =
      clone_census.normalization_owner_bytes - 1U;
  clone_rejected_options.usage = &clone_rejected;
  bool clone_did_reject = false;
  try {
    (void)patchy::psd::DocumentIo::write_layered_rgb8(
        clone_document, clone_rejected_options);
  } catch (const patchy::psd::SaveBudgetExceeded& error) {
    clone_did_reject = true;
    CHECK(error.dimension() ==
          patchy::psd::SaveBudgetDimension::TrackedLiveBytes);
  }
  CHECK(clone_did_reject);
  CHECK(clone_rejected.tracked_live_bytes == 0U);
  CHECK(clone_rejected.tracked_live_bytes_high_water <=
        clone_census.normalization_owner_bytes - 1U);

  patchy::Document geometry_document(8, 8, patchy::PixelFormat::rgb8());
  patchy::Layer vector(geometry_document.allocate_layer_id(), "Hostile geometry",
                       patchy::PixelBuffer());
  vector.metadata()[patchy::kLayerMetadataVectorShape] = "1";
  patchy::VectorShapeContent shape;
  patchy::PathSubpath dense;
  dense.closed = false;
  dense.shape_group = 0;
  for (std::size_t index = 0U; index < 128U; ++index) {
    const auto x = static_cast<double>(index % 8U);
    const auto y = static_cast<double>((index / 8U) % 8U);
    dense.anchors.push_back(
        patchy::PathAnchor{x, y, x, y, x, y, false});
  }
  shape.path.subpaths.push_back(std::move(dense));
  shape.path.subpaths.push_back(
      s2_subpath({{0.0, 0.0}, {7.0, 7.0}}, false, 1));
  shape.fill.kind = patchy::VectorFillKind::None;
  shape.stroke.enabled = true;
  shape.stroke.fill_enabled = false;
  shape.stroke.width = 1.0;
  shape.stroke.alignment = patchy::VectorStrokeAlignment::Center;
  shape.stroke.cap = patchy::VectorStrokeCap::Butt;
  shape.stroke.join = patchy::VectorStrokeJoin::Miter;
  shape.stroke.content.kind = patchy::VectorFillKind::Solid;
  vector.set_vector_shape(shape);
  geometry_document.add_layer(std::move(vector));

  const auto geometry_census =
      patchy::psd::save_workspace_census(geometry_document);
  CHECK(geometry_census.normalization_scratch_bytes >
        8U * 8U * 96U * 2U);
  CHECK(geometry_census.renderer_scratch_bytes > 8U * 8U * 64U);

  auto dashed_document = geometry_document;
  auto dashed_shape = *dashed_document.layers().front().vector_shape();
  dashed_shape.stroke.dashes = {0.25, 0.25};
  dashed_document.layers().front().set_vector_shape(std::move(dashed_shape));
  const auto dashed_census =
      patchy::psd::save_workspace_census(dashed_document);
  CHECK(dashed_census.normalization_scratch_bytes >
        geometry_census.normalization_scratch_bytes);
  CHECK(dashed_census.renderer_scratch_bytes >
        geometry_census.renderer_scratch_bytes);

  patchy::psd::SaveUsage measured;
  patchy::psd::WriteOptions options;
  options.usage = &measured;
  const auto baseline = patchy::psd::DocumentIo::write_layered_rgb8(
      geometry_document, options);
  CHECK(!baseline.empty());
  CHECK(measured.tracked_live_bytes == 0U);
  const auto exact_peak = measured.tracked_live_bytes_high_water;
  CHECK(exact_peak >= geometry_census.normalization_scratch_bytes);

  patchy::psd::SaveUsage exact;
  auto exact_options = options;
  exact_options.budget.max_tracked_live_bytes = exact_peak;
  exact_options.usage = &exact;
  CHECK(patchy::psd::DocumentIo::write_layered_rgb8(
            geometry_document, exact_options) == baseline);
  CHECK(exact.tracked_live_bytes == 0U);
  CHECK(exact.tracked_live_bytes_high_water == exact_peak);

  patchy::psd::SaveUsage one_short;
  auto one_short_options = options;
  one_short_options.budget.max_tracked_live_bytes = exact_peak - 1U;
  one_short_options.usage = &one_short;
  bool geometry_did_reject = false;
  try {
    (void)patchy::psd::DocumentIo::write_layered_rgb8(
        geometry_document, one_short_options);
  } catch (const patchy::psd::SaveBudgetExceeded& error) {
    geometry_did_reject = true;
    CHECK(error.dimension() ==
          patchy::psd::SaveBudgetDimension::TrackedLiveBytes);
  }
  CHECK(geometry_did_reject);
  CHECK(one_short.tracked_live_bytes == 0U);
  CHECK(one_short.tracked_live_bytes_high_water <= exact_peak - 1U);
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
      {"psd_save_native_adjustment_payloads_own_exact_budget",
       psd_save_native_adjustment_payloads_own_exact_budget},
      {"psd_save_hue_payload_patch_tail_and_budget_are_stable",
       psd_save_hue_payload_patch_tail_and_budget_are_stable},
      {"psd_save_adjustment_raw_copy_and_malformed_paths_are_stable",
       psd_save_adjustment_raw_copy_and_malformed_paths_are_stable},
      {"psd_save_adjustment_payload_owners_stage_and_unwind",
       psd_save_adjustment_payload_owners_stage_and_unwind},
      {"psd_save_adjustment_payload_reaches_public_live_budget",
       psd_save_adjustment_payload_reaches_public_live_budget},
      {"psd_save_luni_and_lfx2_payloads_own_budget",
       psd_save_luni_and_lfx2_payloads_own_budget},
      {"psd_save_patched_fill_opacity_owns_budget",
       psd_save_patched_fill_opacity_owns_budget},
      {"psd_save_vector_and_placed_payloads_own_budget",
       psd_save_vector_and_placed_payloads_own_budget},
      {"psd_save_tysh_payload_owns_budget_and_unwinds",
       psd_save_tysh_payload_owns_budget_and_unwinds},
      {"psd_save_staged_layer_records_release_and_aliases_count",
       psd_save_staged_layer_records_release_and_aliases_count},
      {"psd_save_generated_layer_payloads_reach_public_budget",
       psd_save_generated_layer_payloads_reach_public_budget},
      {"psd_save_s2_normalization_and_renderer_workspace_whole_gate",
       psd_save_s2_normalization_and_renderer_workspace_whole_gate},
      {"psd_save_s2_clone_and_geometry_census_rejects_before_workspace",
       psd_save_s2_clone_and_geometry_census_rejects_before_workspace},
  };
}
