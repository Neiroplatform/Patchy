#include "core/vector_compound.hpp"
#include "psd/psd_document_io.hpp"
#include "psd/psd_io_internal.hpp"

#include "color/color_management.hpp"
#include "core/adjustment_layer.hpp"
#include "core/layer_metadata.hpp"
#include "core/pattern_resource.hpp"
#include "core/smart_filter.hpp"
#include "core/smart_object.hpp"
#include "core/style_contour.hpp"
#include "core/text_warp.hpp"
#include "formats/acv_curves_io.hpp"
#include "psd/psd_binary.hpp"
#include "psd/psd_descriptor.hpp"
#include "psd/psd_filter_effects.hpp"
#include "psd/psd_layer_effects.hpp"
#include "psd/psd_patterns.hpp"
#include "psd/psd_save_budget_internal.hpp"
#include "psd/psd_save_workspace.hpp"
#include "psd/psd_smart_objects.hpp"
#include "render/compositor.hpp"
#include "support/string_utils.hpp"
#include "support/translate_noop.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cctype>
#include <climits>
#include <cstdlib>
#include <fstream>
#include <future>
#include <iomanip>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dwrite.h>
#include <wrl/client.h>
#endif

namespace patchy::psd {

ParseBudgetExceeded::ParseBudgetExceeded(ParseBudgetDimension dimension)
    : std::length_error(PATCHY_TRANSLATE_NOOP(
          "QObject", "This PSD/PSB document is too large to import safely.")),
      dimension_(dimension) {}

SaveBudgetExceeded::SaveBudgetExceeded(SaveBudgetDimension dimension)
    // DP-010 owns translated product policy and UI copy. This engine-level
    // diagnostic deliberately stays out of the translation catalog until a
    // finite product caller can surface a dimension-specific message.
    : std::length_error("PSD/PSB save budget exceeded"),
      dimension_(dimension) {}

SaveCancelled::SaveCancelled() : std::runtime_error("PSD/PSB save cancelled") {}

namespace {

void report_save_progress(const WriteOptions& options, SavePhase phase,
                          std::uint64_t logical_output_bytes = 0) {
  if (options.progress &&
      !options.progress(SaveProgress{phase, logical_output_bytes})) {
    throw SaveCancelled();
  }
}

void reset_parse_usage(ParseUsage* usage) {
  if (usage != nullptr) {
    *usage = {};
  }
}

void reset_save_usage(SaveUsage* usage) {
  if (usage != nullptr) {
    *usage = {};
  }
}

class SaveOutputBudgetTracker {
public:
  explicit SaveOutputBudgetTracker(const WriteOptions& options)
      : remaining_(options.budget.max_logical_output_bytes),
        usage_(options.usage != nullptr ? &options.usage->logical_output_bytes
                                       : nullptr),
        progress_(&options.progress) {}

  static void before_write(void* context, std::size_t bytes) {
    static_cast<SaveOutputBudgetTracker*>(context)->charge_size(bytes);
  }

private:
  void charge_size(std::size_t bytes) {
    if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
      if (bytes > std::numeric_limits<std::uint64_t>::max()) {
        reject();
      }
    }
    const auto bytes_u64 = static_cast<std::uint64_t>(bytes);
    if (bytes_u64 > remaining_ ||
        bytes_u64 > std::numeric_limits<std::uint64_t>::max() - written_) {
      reject();
    }
    const auto next_written = written_ + bytes_u64;
    if (*progress_ &&
        !(*progress_)(SaveProgress{SavePhase::Serializing, next_written})) {
      throw SaveCancelled();
    }
    remaining_ -= bytes_u64;
    written_ = next_written;
    if (usage_ != nullptr) {
      *usage_ = written_;
    }
  }

  [[noreturn]] static void reject() {
    throw SaveBudgetExceeded(SaveBudgetDimension::LogicalOutputBytes);
  }

  std::uint64_t remaining_;
  std::uint64_t* usage_;
  const std::function<bool(const SaveProgress&)>* progress_;
  std::uint64_t written_{0};
};

struct SaveBudgetTotal {
  std::uint64_t value{0};
  bool overflow{false};

  void add(std::uint64_t amount) noexcept {
    if (overflow || amount > std::numeric_limits<std::uint64_t>::max() - value) {
      overflow = true;
      return;
    }
    value += amount;
  }

  void add_size(std::size_t amount) noexcept {
    if constexpr (sizeof(std::size_t) > sizeof(std::uint64_t)) {
      if (amount > std::numeric_limits<std::uint64_t>::max()) {
        overflow = true;
        return;
      }
    }
    add(static_cast<std::uint64_t>(amount));
  }
};

struct SavePreflightPlan {
  SaveBudgetTotal canvas_pixels;
  SaveBudgetTotal source_pixel_bytes;
  SaveBudgetTotal layer_records;
  SaveBudgetTotal channel_records;
};

void add_source_pixel_buffers(const Layer& layer, SaveBudgetTotal& total) noexcept {
  total.add_size(layer.pixels().byte_size());
  if (layer.mask().has_value()) {
    total.add_size(layer.mask()->pixels.byte_size());
  }
  if (const auto* filters = layer.smart_filter_stack()) {
    total.add_size(filters->mask.pixels.byte_size());
  }
  if (const auto* shape = layer.vector_shape()) {
    total.add_size(shape->fill_cache.byte_size());
    total.add_size(shape->stroke_cache.byte_size());
  }
  if (const auto* mask = layer.vector_mask()) {
    total.add_size(mask->cache.byte_size());
  }
  for (const auto& child : layer.children()) {
    add_source_pixel_buffers(child, total);
  }
}

[[nodiscard]] std::uint64_t raster_mask_channel(const Layer& layer) noexcept {
  return layer.mask().has_value() && !layer.mask()->pixels.empty() ? 1U : 0U;
}

[[nodiscard]] std::uint64_t derived_mask_channel(const Layer& layer,
                                                 bool empty_raster_mask_blocks) noexcept {
  if ((empty_raster_mask_blocks ? layer.mask().has_value()
                                : raster_mask_channel(layer) != 0U)) {
    return 0U;
  }
  const auto* mask = layer.vector_mask();
  return mask != nullptr && mask->path.bounds().has_value() &&
      (mask->density != 255U || mask->feather > 0.0)
      ? 1U : 0U;
}

void add_open_path_expansion(const OpenPathStrokeExpansionPlan& expansion,
                             std::uint64_t outer_mask_channels,
                             SavePreflightPlan& plan) noexcept {
  plan.layer_records.add(2U);  // outer folder and its boundary
  plan.layer_records.add(expansion.subpath_count);
  if (expansion.fill_carrier) { plan.layer_records.add(1U); }
  if (expansion.grouped_strokes) { plan.layer_records.add(2U); }
  if (expansion.fill_opacity_boundary) { plan.layer_records.add(2U); }
  plan.channel_records.add(outer_mask_channels);
  if (expansion.subpath_count_overflow) {
    plan.layer_records.overflow = true;
    plan.channel_records.overflow = true;
    return;
  }
  if (expansion.subpath_count >
      std::numeric_limits<std::uint64_t>::max() / 4U) {
    plan.channel_records.overflow = true;
  } else {
    plan.channel_records.add(expansion.subpath_count * 4U);
  }
  if (expansion.fill_carrier) { plan.channel_records.add(4U); }
}

void add_effective_layer_records(const Layer& layer,
                                 SavePreflightPlan& plan) noexcept {
  if (layer_is_compound_vector(layer)) {
    const auto& shape = *layer.vector_shape();
    plan.layer_records.add(2U);  // outer folder and its boundary
    plan.channel_records.add(raster_mask_channel(layer));
    if (raster_mask_channel(layer) == 0U) {
      plan.channel_records.add(derived_mask_channel(layer, false));
    }
    if (layer.fill_opacity() != 1.0F) { plan.layer_records.add(2U); }
    for (const auto& part : shape.parts) {
      const auto expansion = open_path_stroke_expansion_plan(shape, part);
      if (expansion.subpath_count_overflow) {
        plan.layer_records.overflow = true;
        plan.channel_records.overflow = true;
        return;
      }
      if (expansion.expands) {
        add_open_path_expansion(expansion, 0U, plan);
      } else {
        plan.layer_records.add(1U);
        plan.channel_records.add(4U);
      }
    }
    return;
  }

  const auto open_path = open_path_stroke_expansion_plan(layer);
  if (open_path.subpath_count_overflow) {
    plan.layer_records.overflow = true;
    plan.channel_records.overflow = true;
    return;
  }
  if (open_path.expands) {
    const auto mask_channels = raster_mask_channel(layer) != 0U
        ? 1U : derived_mask_channel(layer, false);
    add_open_path_expansion(open_path, mask_channels, plan);
    return;
  }

  switch (layer.kind()) {
    case LayerKind::Group:
      plan.layer_records.add(2U);
      if (raster_mask_channel(layer) != 0U) {
        plan.channel_records.add(1U);
      } else {
        plan.channel_records.add(derived_mask_channel(layer, false));
      }
      for (const auto& child : layer.children()) {
        add_effective_layer_records(child, plan);
      }
      return;
    case LayerKind::Adjustment:
      plan.layer_records.add(1U);
      if (raster_mask_channel(layer) != 0U) {
        plan.channel_records.add(1U);
      } else {
        plan.channel_records.add(derived_mask_channel(layer, false));
      }
      return;
    case LayerKind::Pixel:
      plan.layer_records.add(1U);
      if (layer_is_vector_shape(layer)) {
        plan.channel_records.add(4U);
        plan.channel_records.add(raster_mask_channel(layer));
        return;
      }
      plan.channel_records.add(layer.pixels().format().channels >= 4U ? 4U : 3U);
      if (raster_mask_channel(layer) != 0U) {
        plan.channel_records.add(1U);
      } else {
        // A present-but-empty raster mask suppresses the derived plane only for
        // ordinary pixel layers; mirror encode_layer exactly.
        plan.channel_records.add(derived_mask_channel(layer, true));
      }
      return;
    case LayerKind::Text:
    case LayerKind::Vector:
    case LayerKind::SmartObject:
      // The existing encoder reports these unsupported kinds later. Model one
      // record here so a finite structural budget still protects preflight,
      // while unlimited callers retain the established format error.
      plan.layer_records.add(1U);
      return;
  }
}

[[nodiscard]] SavePreflightPlan build_save_preflight_plan(
    const Document& document, bool layered) noexcept {
  SavePreflightPlan plan;
  const auto width = static_cast<std::uint64_t>(document.width());
  const auto height = static_cast<std::uint64_t>(document.height());
  if (height != 0U && width > std::numeric_limits<std::uint64_t>::max() / height) {
    plan.canvas_pixels.overflow = true;
  } else {
    plan.canvas_pixels.value = width * height;
  }

  for (const auto& layer : document.layers()) {
    add_source_pixel_buffers(layer, plan.source_pixel_bytes);
  }
  for (const auto& channel : document.channels()) {
    plan.source_pixel_bytes.add_size(channel.pixels().byte_size());
  }

  // RGB plus a possible merged-alpha record and every saved document channel.
  plan.channel_records.add(4U);
  plan.channel_records.add_size(document.channels().size());
  if (!layered) { return plan; }

  if (document.layers().empty()) {
    plan.layer_records.add(1U);
    plan.channel_records.add(4U);
    return plan;
  }
  for (const auto& layer : document.layers()) {
    add_effective_layer_records(layer, plan);
  }
  return plan;
}

void admit_save_preflight_total(const SaveBudgetTotal& total,
                                std::uint64_t limit,
                                std::uint64_t* usage,
                                SaveBudgetDimension dimension) {
  if (total.overflow || total.value > limit) {
    throw SaveBudgetExceeded(dimension);
  }
  if (usage != nullptr) { *usage = total.value; }
}

void preflight_save(const Document& document, const WriteOptions& options,
                    bool layered) {
  const auto plan = build_save_preflight_plan(document, layered);
  // The format validity error predates configurable budgets and remains
  // primary for every caller, including one with a smaller finite record cap.
  if (layered && !plan.layer_records.overflow &&
      plan.layer_records.value > 8000U) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP(
        "QObject", "Photoshop supports at most 8000 layer records, including group boundaries"));
  }
  auto* usage = options.usage;
  admit_save_preflight_total(plan.canvas_pixels, options.budget.max_canvas_pixels,
                             usage != nullptr ? &usage->canvas_pixels : nullptr,
                             SaveBudgetDimension::CanvasPixels);
  admit_save_preflight_total(plan.source_pixel_bytes,
                             options.budget.max_source_pixel_bytes,
                             usage != nullptr ? &usage->source_pixel_bytes : nullptr,
                             SaveBudgetDimension::SourcePixelBytes);
  admit_save_preflight_total(plan.layer_records, options.budget.max_layer_records,
                             usage != nullptr ? &usage->layer_records : nullptr,
                             SaveBudgetDimension::LayerRecords);
  admit_save_preflight_total(plan.channel_records,
                             options.budget.max_channel_records,
                             usage != nullptr ? &usage->channel_records : nullptr,
                             SaveBudgetDimension::ChannelRecords);
}

std::vector<std::uint8_t> read_file_bytes_with_budget(const std::filesystem::path& path,
                                                      const ParseBudget& budget) {
  ParseBudgetTracker input_budget(budget.max_input_bytes, nullptr,
                                  ParseBudgetDimension::InputBytes);
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "Could not open PSD file for reading"));
  }

  std::vector<std::uint8_t> bytes;
  std::array<std::uint8_t, 64U * 1024U> chunk{};
  while (file) {
    file.read(reinterpret_cast<char*>(chunk.data()), static_cast<std::streamsize>(chunk.size()));
    const auto count = file.gcount();
    if (count <= 0) {
      break;
    }
    const auto count_size = static_cast<std::size_t>(count);
    if (count_size > bytes.max_size() - bytes.size()) {
      input_budget.reject();
    }
    input_budget.charge_size(count_size);
    bytes.insert(bytes.end(), chunk.begin(), chunk.begin() + count_size);
  }
  if (file.fail() && !file.eof()) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "Could not open PSD file for reading"));
  }
  return bytes;
}

void append_document_channels_for_write(
    const Document& document, std::vector<std::span<const std::uint8_t>>& planes,
    std::vector<CompositeChannelInfo>& channel_info) {
  planes.reserve(planes.size() + document.channels().size());
  channel_info.reserve(channel_info.size() + document.channels().size());
  for (const auto& channel : document.channels()) {
    const auto& pixels = channel.pixels();
    if (pixels.format() != PixelFormat::gray8() || pixels.width() != document.width() ||
        pixels.height() != document.height()) {
      throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "PSD saved channels must be full-canvas 8-bit grayscale images"));
    }
    planes.emplace_back(pixels.data());
    channel_info.push_back(CompositeChannelInfo{channel.name(), false,
                                                channel.kind() == DocumentChannelKind::Alpha,
                                                channel.photoshop_identifier(),
                                                channel.display_info(),
                                                channel.raw_photoshop_display_info()});
  }
}

void check_composite_channel_limit(std::size_t extra_channel_count) {
  if (3U + extra_channel_count > kMaximumPhotoshopChannelCount) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "PSD files support at most 56 total channels, including merged transparency"));
  }
}

bool is_background_layer_name(const std::string& name) {
  return ascii_lower_copy(name) == "background";
}

bool is_full_canvas_background(const Layer& layer, std::int32_t canvas_width, std::int32_t canvas_height) {
  if (!is_background_layer_name(layer.name())) {
    return false;
  }
  const auto bounds = layer.bounds();
  return bounds.x == 0 && bounds.y == 0 && bounds.width >= canvas_width && bounds.height >= canvas_height;
}

bool records_look_like_legacy_top_to_bottom(const std::vector<Layer>& layers, std::int32_t canvas_width,
                                            std::int32_t canvas_height) {
  return !layers.empty() && is_full_canvas_background(layers.back(), canvas_width, canvas_height);
}

Document read_flat_composite(BigEndianReader& reader, const Header& header,
                             const CmykToRgbTransform* cmyk_icc,
                             const ParsedCompositeChannelResources& channel_resources,
                             bool has_merged_transparency, ParseBudgetTracker& budget,
                             ParseBudgetTracker& decompressed_budget,
                             ParseLiveBudgetTracker& tracked_live_budget,
                             ParseBudgetTracker& retained_payload_budget,
                             bool preserve_original_payloads,
                             std::size_t* damaged_rows = nullptr) {
  const auto format = format_from_header(header);
  const auto compression = reader.read_u16();
  const auto source_is_cmyk = is_cmyk_color_mode(header.color_mode);
  const auto color_channel_count = composite_color_channel_count(header.color_mode);
  const auto first_saved_channel = static_cast<std::uint16_t>(
      color_channel_count + (has_merged_transparency ? 1U : 0U));
  if (first_saved_channel > header.channels) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "PSD merged transparency flag has no matching composite channel"));
  }
  budget.charge_dimensions(static_cast<std::int32_t>(header.width),
                           static_cast<std::int32_t>(header.height), format.channels);
  if (has_merged_transparency) {
    budget.charge_dimensions(static_cast<std::int32_t>(header.width),
                             static_cast<std::int32_t>(header.height),
                             PixelFormat::gray8().channels);
  }
  budget.charge_dimensions(
      static_cast<std::int32_t>(header.width), static_cast<std::int32_t>(header.height),
      static_cast<std::size_t>(header.channels - first_saved_channel));
  auto channel_data = read_flat_image_channels(
      reader, header, compression, decompressed_budget, tracked_live_budget,
      damaged_rows);
  Document document(static_cast<std::int32_t>(header.width), static_cast<std::int32_t>(header.height), format);
  PixelBuffer pixels(static_cast<std::int32_t>(header.width), static_cast<std::int32_t>(header.height), format);
  const auto channel_pixels = static_cast<std::size_t>(header.width) * static_cast<std::size_t>(header.height);

  if (source_is_cmyk) {
    convert_cmyk_planes_to_rgb(
        pixels, channel_data[0].bytes.data(), channel_data[1].bytes.data(),
        channel_data[2].bytes.data(), channel_data[3].bytes.data(), channel_pixels,
        cmyk_icc, tracked_live_budget);
  } else {
    for (std::uint16_t channel = 0; channel < 3; ++channel) {
      for (std::size_t i = 0; i < channel_pixels; ++i) {
        pixels.data()[i * 3 + channel] = channel_data[channel].bytes[i];
      }
    }
  }

  Layer& background = document.add_pixel_layer("Background", std::move(pixels));
  if (has_merged_transparency) {
    const auto& merged_alpha = channel_data[color_channel_count].bytes;
    if (merged_alpha.size() != channel_pixels) {
      throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "PSD merged transparency dimensions do not match the document"));
    }
    PixelBuffer mask_pixels(document.width(), document.height(), PixelFormat::gray8());
    std::copy(merged_alpha.begin(), merged_alpha.end(), mask_pixels.data().begin());
    background.set_mask(LayerMask{Rect::from_size(document.width(), document.height()),
                                  std::move(mask_pixels), 255, false});
    set_layer_mask_is_document_alpha(background, true);
  }
  std::vector<TrackedByteBuffer> saved_channels;
  saved_channels.reserve(static_cast<std::size_t>(header.channels - first_saved_channel));
  for (std::uint16_t channel = first_saved_channel; channel < header.channels; ++channel) {
    saved_channels.push_back(std::move(channel_data[channel]));
  }
  if (!saved_channels.empty()) {
    add_saved_composite_channels(document, std::move(saved_channels), first_saved_channel, header,
                                 channel_resources, retained_payload_budget,
                                 preserve_original_payloads);
  }

  return document;
}

struct SmartObjectImportCounts {
  std::size_t editable{0};
  std::size_t preview_locked{0};
  std::size_t external{0};
  std::size_t dangling{0};
};

void finalize_smart_filter_layers(std::vector<Layer>& layers,
                                  const SmartFilterEffectsStore& store,
                                  ParseBudgetTracker& retained_payload_budget) {
  for (auto& layer : layers) {
    if (!std::as_const(layer).children().empty()) {
      finalize_smart_filter_layers(layer.children(), store,
                                   retained_payload_budget);
    }
    const auto* imported = std::as_const(layer).smart_filter_stack();
    if (imported == nullptr) {
      continue;
    }

    auto stack = *imported;
    const auto placed_uuid = smart_object_placed_uuid(std::as_const(layer));
    const auto* record = store.find_unique(placed_uuid);
    if (record == nullptr || !record->semantic_supported()) {
      stack.support = SmartFilterStackSupport::Unsupported;
      layer.set_smart_filter_stack(std::move(stack));
      continue;
    }

    if (record->mask_present) {
      if (!record->mask_decoded || !record->mask.has_value() ||
          record->mask->samples == nullptr) {
        stack.support = SmartFilterStackSupport::Unsupported;
      } else {
        const auto& native_mask = *record->mask;
        const auto expected = static_cast<std::size_t>(native_mask.bounds.width) *
                              static_cast<std::size_t>(native_mask.bounds.height);
        if (native_mask.bounds.empty() || native_mask.samples->size() != expected) {
          stack.support = SmartFilterStackSupport::Unsupported;
        } else {
          retained_payload_budget.charge_size(expected);
          PixelBuffer mask_pixels(native_mask.bounds.width, native_mask.bounds.height,
                                  PixelFormat::gray8());
          std::copy(native_mask.samples->begin(), native_mask.samples->end(),
                    mask_pixels.data().begin());
          stack.mask.bounds = native_mask.bounds;
          stack.mask.pixels = std::move(mask_pixels);
        }
      }
    }
    const bool executable =
        stack.support == SmartFilterStackSupport::Supported;
    layer.set_smart_filter_stack(std::move(stack));
    if (executable && smart_object_lock_reason(std::as_const(layer)) == "filters") {
      layer.metadata().erase(kLayerMetadataSmartObjectLock);
    }
  }
}

// Resolves each smart-object layer's uuid against the parsed source store: layers with
// missing sources drop their metadata (the preserved blobs stay; the writer's existing
// dangling-reference strip keeps the file Photoshop-safe), and layers whose source is
// not embedded become preview-locked with reason "external".
void finalize_smart_object_layers(std::vector<Layer>& layers, const SmartObjectStore& store,
                                  SmartObjectImportCounts& counts) {
  for (auto& layer : layers) {
    if (!layer.children().empty()) {
      finalize_smart_object_layers(layer.children(), store, counts);
    }
    if (!layer_is_smart_object(std::as_const(layer))) {
      continue;
    }
    const auto uuid = smart_object_source_uuid(std::as_const(layer));
    if (uuid.empty() && smart_object_lock_reason(std::as_const(layer)) == "unparsed") {
      // Unreadable SoLd: the uuid is unknown BY DESIGN (empty), so the dangling
      // cleanup below must not strip the badge/protection metadata.
      ++counts.preview_locked;
      continue;
    }
    const auto* source = store.find(uuid);
    if (source == nullptr) {
      clear_layer_smart_object_metadata(layer);
      ++counts.dangling;
      continue;
    }
    auto lock = smart_object_lock_reason(std::as_const(layer));
    if (source->kind != SmartObjectSourceKind::Embedded && lock.empty()) {
      layer.metadata()[kLayerMetadataSmartObjectLock] = "external";
      lock = "external";
    }
    if (lock.empty()) {
      ++counts.editable;
    } else if (lock == "external") {
      ++counts.external;
    } else {
      ++counts.preview_locked;
    }
  }
}

void append_smart_object_notices(const SmartObjectImportCounts& counts, std::vector<std::string>* notices) {
  if (notices == nullptr) {
    return;
  }
  const auto plural = [](std::size_t count) { return count == 1 ? "" : "s"; };
  if (counts.editable > 0) {
    notices->push_back("Imported " + std::to_string(counts.editable) + " smart object layer" +
                       plural(counts.editable) + "; click a layer's smart-object badge to edit its embedded contents.");
  }
  if (counts.preview_locked > 0) {
    notices->push_back(std::to_string(counts.preview_locked) + " smart object layer" +
                       plural(counts.preview_locked) +
                       " use warp, perspective, smart filters, or unsupported data; Photoshop's preview is "
                       "shown (rasterize the layer to edit it in Patchy).");
  }
  if (counts.external > 0) {
    notices->push_back(std::to_string(counts.external) + " smart object layer" + plural(counts.external) +
                       " reference external files; the embedded preview is shown.");
  }
  if (counts.dangling > 0) {
    notices->push_back(std::to_string(counts.dangling) + " smart object layer" + plural(counts.dangling) +
                       " reference missing source data and were imported as regular layers.");
  }
}

bool is_section_divider_folder(std::uint32_t type) noexcept {
  return type == 1U || type == 2U;
}

bool is_section_divider_boundary(std::uint32_t type) noexcept {
  return type == 3U;
}

void move_layer_state(Layer& target, Layer& source) {
  target.set_bounds(source.bounds());
  target.set_blend_mode(source.blend_mode());
  target.set_opacity(source.opacity());
  target.set_fill_opacity(source.fill_opacity());
  target.set_visible(source.visible());
  target.set_clipped(source.clipped());
  target.set_lock_flags(source.lock_flags());
  target.layer_style() = std::move(source.layer_style());
  target.metadata() = std::move(source.metadata());
  target.mask() = std::move(source.mask());
  target.raw_psd_blending_ranges() =
      std::move(source.raw_psd_blending_ranges());
  target.set_blend_if_rgb_compatible(source.blend_if_rgb_compatible());
  if (source.channel_restriction_supported()) {
    target.set_restricted_channels(source.restricted_channels());
  } else {
    target.set_channel_restriction_unsupported();
  }
  target.raw_psd_group_boundary_blending_ranges() =
      std::move(source.raw_psd_group_boundary_blending_ranges());
  target.unknown_psd_blocks() = std::move(source.unknown_psd_blocks());
  target.move_shared_models_from(source);
}

std::vector<Layer> build_group_hierarchy(std::vector<DecodedLayer> flat_layers) {
  struct GroupFrame {
    std::vector<Layer> children;
    std::vector<std::uint8_t> boundary_blending_ranges;
  };

  // Photoshop nests groups at most ten deep. Every walk over the finished tree (cloning,
  // the vector/smart-object finalizers, the Layer destructor) recurses once per level, so a
  // file that opens boundary records without end would overflow the loader thread's stack
  // long before it ran out of bytes. Groups past the cap are flattened into the deepest
  // kept group; their folder records are dropped.
  constexpr std::size_t kMaxGroupDepth = 64;
  std::size_t dropped_boundaries = 0;

  std::vector<GroupFrame> stack;
  stack.emplace_back();

  for (auto& decoded : flat_layers) {
    if (is_section_divider_boundary(decoded.section_divider_type)) {
      if (stack.size() > kMaxGroupDepth) {
        ++dropped_boundaries;
        continue;
      }
      stack.push_back(GroupFrame{
          {}, std::move(decoded.layer.raw_psd_blending_ranges())});
      continue;
    }

    if (is_section_divider_folder(decoded.section_divider_type)) {
      if (dropped_boundaries > 0) {
        --dropped_boundaries;
        continue;
      }
      std::vector<Layer> children;
      std::vector<std::uint8_t> boundary_blending_ranges;
      if (stack.size() > 1U) {
        children = std::move(stack.back().children);
        boundary_blending_ranges = std::move(stack.back().boundary_blending_ranges);
        stack.pop_back();
      }

      Layer group(0, decoded.layer.name(), LayerKind::Group);
      move_layer_state(group, decoded.layer);
      group.raw_psd_group_boundary_blending_ranges() = std::move(boundary_blending_ranges);
      set_layer_group_expanded(group, decoded.section_divider_type == 1U);
      group.children() = std::move(children);
      stack.back().children.push_back(std::move(group));
      continue;
    }

    stack.back().children.push_back(std::move(decoded.layer));
  }

  while (stack.size() > 1U) {
    auto orphaned_children = std::move(stack.back().children);
    stack.pop_back();
    stack.back().children.insert(stack.back().children.end(), std::make_move_iterator(orphaned_children.begin()),
                                 std::make_move_iterator(orphaned_children.end()));
  }

  return std::move(stack.front().children);
}

Layer move_layer_with_document_ids(Document& document, Layer source) {
  auto children = std::move(source.children());
  source.children().clear();
  auto moved = std::move(source).move_with_id(document.allocate_layer_id());
  for (auto& child : children) {
    moved.add_child(move_layer_with_document_ids(document, std::move(child)));
  }
  return moved;
}

std::size_t live_shape_raw_descriptor_bytes_in_layer(const Layer& layer) {
  std::size_t total = 0U;
  if (const auto* shape = layer.vector_shape(); shape != nullptr) {
    for (const auto& params : shape->origination) {
      if (params.raw_descriptor.size() >
          std::numeric_limits<std::size_t>::max() - total) {
        throw ParseBudgetExceeded(ParseBudgetDimension::TrackedLiveBytes);
      }
      total += params.raw_descriptor.size();
    }
  }
  for (const auto& child : layer.children()) {
    const auto child_bytes = live_shape_raw_descriptor_bytes_in_layer(child);
    if (child_bytes > std::numeric_limits<std::size_t>::max() - total) {
      throw ParseBudgetExceeded(ParseBudgetDimension::TrackedLiveBytes);
    }
    total += child_bytes;
  }
  return total;
}

std::size_t compound_collapse_descriptor_workspace_bytes(
    const std::vector<Layer>& layers) {
  std::size_t total = 0U;
  for (const auto& layer : layers) {
    const auto kind = compound_vector_group_kind(layer);
    const auto bytes =
        kind == CompoundVectorGroupKind::Content ||
                kind == CompoundVectorGroupKind::OpenPathStrokes
            ? live_shape_raw_descriptor_bytes_in_layer(layer)
            : compound_collapse_descriptor_workspace_bytes(layer.children());
    if (bytes > std::numeric_limits<std::size_t>::max() - total) {
      throw ParseBudgetExceeded(ParseBudgetDimension::TrackedLiveBytes);
    }
    total += bytes;
  }
  return total;
}

// Decodes a layer-info payload starting at the layer-count i16. This is the body of
// the standard layer info section, and byte-identical inside the Lr16/Lr32/Layr
// global tagged blocks that carry the layers of 16/32-bit files.
std::vector<Layer> read_layer_info_records(BigEndianReader& layer_reader, std::int32_t canvas_width,
                                           std::int32_t canvas_height, std::uint16_t source_color_mode,
                                           std::uint16_t depth, float global_light_angle,
                                           float global_light_altitude, bool large_document,
                                           const CmykToRgbTransform* cmyk_icc,
                                           bool& has_merged_transparency,
                                           std::vector<std::string>* notices,
                                           std::size_t* damaged_rows,
                                           ParseBudgetTracker& budget,
                                           ParseBudgetTracker& decompressed_budget,
                                           ParseLiveBudgetTracker& tracked_live_budget,
                                           ParseBudgetTracker& layer_record_budget,
                                           ParseBudgetTracker& channel_record_budget,
                                           ParseBudgetTracker& resource_record_budget,
                                           ParseBudgetTracker& retained_payload_budget,
                                           bool preserve_original_payloads) {
  has_merged_transparency = false;
  int unrendered_color_balance_count = 0;
  const auto layer_count_raw = static_cast<std::int16_t>(layer_reader.read_u16());
  has_merged_transparency = layer_count_raw < 0;
  const auto layer_count = static_cast<std::uint16_t>(
      layer_count_raw < 0 ? -static_cast<std::int32_t>(layer_count_raw)
                          : static_cast<std::int32_t>(layer_count_raw));
  constexpr std::size_t kMinimumLayerRecordBytes = 34U;
  if (static_cast<std::size_t>(layer_count) >
      layer_reader.remaining() / kMinimumLayerRecordBytes) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP(
        "QObject", "PSD layer record list is truncated"));
  }
  layer_record_budget.charge(layer_count);
  const CmykColorConverter cmyk_converter{cmyk_icc};
  std::vector<LayerRecord> records;
  records.reserve(layer_count);
  for (std::uint16_t i = 0; i < layer_count; ++i) {
    records.push_back(read_layer_record(layer_reader, large_document, cmyk_converter,
                                        channel_record_budget,
                                        resource_record_budget, tracked_live_budget,
                                        retained_payload_budget,
                                        preserve_original_payloads));
  }

  std::vector<DecodedLayer> decoded_layers;
  decoded_layers.reserve(layer_count);
  for (auto& record : records) {
    const auto width = std::max(0, record.bounds.width);
    const auto height = std::max(0, record.bounds.height);
    const auto source_is_cmyk = is_cmyk_color_mode(source_color_mode);
    const auto pixel_count = static_cast<std::size_t>(width) * static_cast<std::size_t>(height);
    const auto has_color = std::any_of(record.channels.begin(), record.channels.end(), [source_color_mode](LayerChannelInfo channel) {
      return is_source_color_channel(channel.id, source_color_mode);
    });
    const auto has_alpha = std::any_of(record.channels.begin(), record.channels.end(), [](LayerChannelInfo channel) {
      return channel.id == kChannelTransparency;
    });
    const auto pixel_format = (has_alpha || !has_color) ? PixelFormat::rgba8() : PixelFormat::rgb8();
    budget.charge_dimensions(width, height, pixel_format.channels);
    PixelBuffer pixels(width, height, pixel_format);
    if (has_alpha) {
      for (std::int32_t y = 0; y < height; ++y) {
        for (std::int32_t x = 0; x < width; ++x) {
          pixels.pixel(x, y)[3] = 255;
        }
      }
    }
    std::array<TrackedByteBuffer, 4> cmyk_channels;

    std::optional<LayerMask> decoded_mask;
    for (const auto channel : record.channels) {
      if (channel.length == 0) {
        // Old Photoshop writes zero-length channel data (no compression marker at
        // all) for empty layers; treat it as an empty channel.
        continue;
      }
      if (channel.length < 2) {
        throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "Invalid PSD layer channel length"));
      }
      if (channel.length > layer_reader.remaining()) {
        throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "PSD layer channel data is truncated"));
      }
      BigEndianReader channel_reader(layer_reader.read_span(static_cast<std::size_t>(channel.length)));
      const auto compression = channel_reader.read_u16();
      const auto payload_length = channel.length - 2;
      if (channel.id == kChannelRealUserMask) {
        // Patchy does not model Photoshop's separate real-user-mask plane. A
        // complete -2 plane carries the rendered mask in files that also contain
        // -3. Skip the declared -3 bytes exactly instead of decoding them against
        // the layer bounds, which are not the real mask's dimensions.
        continue;
      }
      if (compression != kCompressionRaw && compression != kCompressionRle &&
          compression != kCompressionZip && compression != kCompressionZipPrediction) {
        continue;
      }
      const auto channel_width = channel.id == kChannelUserMask && record.mask.has_value()
                                     ? std::max(0, record.mask->bounds.width)
                                     : width;
      const auto channel_height = channel.id == kChannelUserMask && record.mask.has_value()
                                      ? std::max(0, record.mask->bounds.height)
                                      : height;
      const auto sample_bytes = static_cast<std::size_t>(depth / 8U);
      if (channel.id == kChannelUserMask && record.mask.has_value() && channel_width > 0 && channel_height > 0) {
        budget.charge_dimensions(channel_width, channel_height, PixelFormat::gray8().channels);
      }
      const auto source_byte_count = decompressed_budget.checked_decompressed_dimensions(
          channel_width, channel_height, 1U, sample_bytes);
      if (compression == kCompressionRaw && payload_length < source_byte_count) {
        throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "PSD layer channel data is truncated"));
      }
      decompressed_budget.charge_size(source_byte_count);
      TrackedByteBuffer channel_data;
      try {
        channel_data = read_channel_data(
          channel_reader, compression, channel_width, channel_height, large_document,
          tracked_live_budget,
          ChannelDecodeInfo{depth, is_source_color_channel(channel.id, source_color_mode), payload_length},
          damaged_rows);
      } catch (const ParseBudgetExceeded&) {
        throw;
      } catch (const std::runtime_error&) {
        if (damaged_rows != nullptr) {
          *damaged_rows += static_cast<std::size_t>(channel_height);
        }
        continue;  // the next channel starts at its declared boundary
      }
      if (channel.id == kChannelUserMask && record.mask.has_value() && channel_width > 0 && channel_height > 0) {
        PixelBuffer mask_pixels(channel_width, channel_height, PixelFormat::gray8());
        std::copy(channel_data.bytes.begin(), channel_data.bytes.end(),
                  mask_pixels.data().begin());
        decoded_mask = LayerMask{record.mask->bounds, std::move(mask_pixels), record.mask->default_color,
                                 record.mask->disabled};
      }
      const auto target_channel = channel.id == kChannelRed      ? 0
                                  : channel.id == kChannelGreen  ? 1
                                  : channel.id == kChannelBlue   ? 2
                                  : channel.id == kChannelTransparency ? 3
                                                                       : -1;
      if (source_is_cmyk) {
        if (channel.id <= kChannelBlack && channel_data.bytes.size() == pixel_count) {
          cmyk_channels[channel.id] = std::move(channel_data);
        } else if (target_channel == 3) {
          for (std::size_t i = 0; i < channel_data.bytes.size(); ++i) {
            pixels.data()[i * pixels.format().channels + 3U] = channel_data.bytes[i];
          }
        }
      } else {
        for (std::size_t i = 0; i < channel_data.bytes.size(); ++i) {
          if (target_channel >= 0 && target_channel < pixels.format().channels) {
            pixels.data()[i * pixels.format().channels + static_cast<std::size_t>(target_channel)] =
                channel_data.bytes[i];
          }
        }
      }
    }
    if (source_is_cmyk) {
      for (auto& component : cmyk_channels) {
        if (component.bytes.empty() && pixel_count != 0U) {
          auto reservation = tracked_live_budget.reserve_size(pixel_count);
          std::vector<std::uint8_t> zeros(pixel_count, 0);
          component =
              TrackedByteBuffer(std::move(reservation), std::move(zeros));
        }
      }
      convert_cmyk_planes_to_rgb(
          pixels, cmyk_channels[0].bytes.data(), cmyk_channels[1].bytes.data(),
          cmyk_channels[2].bytes.data(), cmyk_channels[3].bytes.data(), pixel_count,
          cmyk_icc, tracked_live_budget);
    }

    bool text_placeholder_rendered = false;
    bool text_regenerated_rendered = false;
    if (record.text.has_value() && !has_visible_alpha(pixels)) {
      pixels = render_placeholder_text(*record.text, width, height);
      text_placeholder_rendered = true;
    } else if (should_regenerate_imported_text_preview(record, pixels)) {
      if (auto regenerated = render_regenerated_imported_text_pixels(record, width, height);
          regenerated.has_value() && has_visible_alpha(*regenerated)) {
        pixels = std::move(*regenerated);
        text_regenerated_rendered = true;
      }
    }

    std::optional<AdjustmentSettings> native_adjustment_settings;
    std::optional<AdjustmentSettings> native_curves_settings;
    std::optional<AdjustmentSettings> patchy_adjustment_settings;
    std::optional<AdjustmentSettings> brit_adjustment_settings;
    std::optional<AdjustmentSettings> cged_adjustment_settings;
    bool has_native_curves = false;
    std::optional<ParsedVectorMaskBlock> vector_mask_block;
    std::optional<VectorFill> vector_fill;
    std::optional<VectorStroke> vector_stroke;
    std::optional<std::vector<LiveShapeParams>> vector_origination;
    bool vector_parse_failed = false;
    bool has_legacy_vscg = false;
    bool vector_stroke_has_content = false;
    // CS6-era 'vscg' (vector stroke content): the stroke paint of a shape layer
    // whose stroke settings live in vstk. Payload = 4-byte content key
    // (SoCo/GdFl/PtFl) + descriptorVersion 16 + the paint descriptor.
    std::optional<VectorFill> legacy_stroke_content;
    bool drop_partial_origination_blocks = false;
    for (const auto& block : record.additional_blocks) {
      if (block.key == "vmsk" || block.key == "vsms") {
        // PS 27.8 writes vmsk; vsms is the legacy alternate with the same
        // payload. First parseable block wins (vmsk sorts first in practice).
        if (!vector_mask_block.has_value()) {
          if (auto parsed = parse_vector_mask_block(block.payload, canvas_width, canvas_height);
              parsed.has_value()) {
            vector_mask_block = std::move(*parsed);
          } else {
            vector_parse_failed = true;
          }
        }
      } else if (block.key == "SoCo" || block.key == "GdFl" || block.key == "PtFl") {
        if (auto fill = parse_vector_fill_block(block.key, block.payload, cmyk_converter); fill.has_value()) {
          vector_fill = std::move(*fill);
        } else {
          vector_parse_failed = true;
        }
      } else if (block.key == "vstk") {
        if (auto stroke = parse_vector_stroke_block(block.payload, cmyk_converter, &vector_stroke_has_content);
            stroke.has_value()) {
          vector_stroke = std::move(*stroke);
        } else {
          vector_parse_failed = true;
        }
      } else if (block.key == "vogk") {
        // A corrupt origination block is not fatal: the path is the render
        // source of truth and the raw bytes stay preserved.
        vector_origination = parse_vector_origination_block(
            block.payload, &retained_payload_budget,
            &tracked_live_budget);
      } else if (block.key == "vscg") {
        has_legacy_vscg = true;
        if (block.payload.size() > 8U) {
          const std::string content_key(block.payload.begin(), block.payload.begin() + 4);
          legacy_stroke_content = parse_vector_fill_block(content_key, block.payload, cmyk_converter);
        }
      }
      if (block.key == "levl") {
        native_adjustment_settings = parse_photoshop_levels_adjustment(block.payload);
      } else if (block.key == "hue2") {
        if (auto parsed = parse_photoshop_hue2_adjustment(block.payload); parsed.has_value()) {
          native_adjustment_settings = parsed;
        }
      } else if (block.key == "curv") {
        has_native_curves = true;
        if (auto parsed = parse_photoshop_curves_adjustment(block.payload); parsed.has_value()) {
          native_curves_settings = parsed;
        }
      } else if (block.key == "nvrt") {
        // Invert has no settings; Photoshop writes the block with an empty
        // payload, so any payload length is accepted.
        AdjustmentSettings invert_settings;
        invert_settings.kind = AdjustmentKind::Invert;
        native_adjustment_settings = invert_settings;
      } else if (block.key == "post") {
        if (auto parsed = parse_photoshop_posterize_adjustment(block.payload); parsed.has_value()) {
          native_adjustment_settings = parsed;
        }
      } else if (block.key == "thrs") {
        if (auto parsed = parse_photoshop_threshold_adjustment(block.payload); parsed.has_value()) {
          native_adjustment_settings = parsed;
        }
      } else if (block.key == "blnc") {
        if (auto parsed = parse_photoshop_color_balance_adjustment(block.payload); parsed.has_value()) {
          native_adjustment_settings = parsed;
          if (photoshop_color_balance_payload_has_unrendered_data(block.payload)) {
            ++unrendered_color_balance_count;
          }
        }
      } else if (block.key == "brit") {
        brit_adjustment_settings = parse_photoshop_brightness_contrast_adjustment(block.payload);
      } else if (block.key == "CgEd") {
        if (auto parsed = parse_photoshop_brightness_contrast_descriptor(block.payload); parsed.has_value()) {
          cged_adjustment_settings = parsed->settings;
        }
      } else if (block.key == "plAD") {
        patchy_adjustment_settings = parse_patchy_adjustment(block.payload);
      }
    }
    // Brightness/Contrast resolution is order-independent: a parseable CgEd
    // descriptor (modern PS writes an all-zero compatibility 'brit' beside it)
    // is authoritative; legacy-mode files carry 'brit' only.
    if (cged_adjustment_settings.has_value()) {
      native_adjustment_settings = cged_adjustment_settings;
    } else if (brit_adjustment_settings.has_value()) {
      native_adjustment_settings = brit_adjustment_settings;
    }
    // Native Photoshop adjustment data is authoritative over Patchy's private
    // fallback. A valid curv block is editable; an unrecognized one deliberately
    // stays on the opaque regular-layer path so a stale plAD can never shadow it.
    auto adjustment_settings = has_native_curves
                                   ? native_curves_settings
                                   : (native_adjustment_settings.has_value() ? native_adjustment_settings
                                                                             : patchy_adjustment_settings);
    if (adjustment_settings.has_value() && native_adjustment_settings.has_value() &&
        patchy_adjustment_settings.has_value() && adjustment_settings->kind == AdjustmentKind::Levels &&
        patchy_adjustment_settings->kind == AdjustmentKind::Levels) {
      adjustment_settings->levels.channel = patchy_adjustment_settings->levels.channel;
    }

    Layer layer = adjustment_settings.has_value() ? Layer(0, record.name, LayerKind::Adjustment)
                                                  : Layer(0, record.name, std::move(pixels));
    if (adjustment_settings.has_value()) {
      configure_adjustment_layer(layer, *adjustment_settings);
    }
    if (adjustment_settings.has_value()) {
      // Photoshop writes adjustment layer records with an empty rect; Patchy's
      // convention (matching its own authored adjustment layers) is canvas-sized
      // bounds. Empty bounds render fine (the compositor treats them as
      // unbounded) but starve rect-based invalidation - the canvas and the undo
      // render diff would repaint nothing for an adjustment-only change.
      layer.set_bounds(Rect::from_size(canvas_width, canvas_height));
    } else {
      const auto layer_width = std::max(width, layer.pixels().width());
      const auto layer_height = std::max(height, layer.pixels().height());
      // Keep the recorded origin: layers legitimately sit far outside the
      // canvas and Photoshop composites the off-canvas slice in place. The
      // old [-canvas, 2*canvas] clamp silently SHIFTED such content (a frame
      // layer at top -780 on a 240-tall canvas rendered a slice 540 px off,
      // and a resave would have baked the shift in). Only guard against
      // corrupt coordinates that could overflow later rect math.
      constexpr std::int32_t kMaxLayerOffset = 1 << 23;
      layer.set_bounds(Rect{std::clamp(record.bounds.x, -kMaxLayerOffset, kMaxLayerOffset),
                            std::clamp(record.bounds.y, -kMaxLayerOffset, kMaxLayerOffset), layer_width,
                            layer_height});
    }
    layer.set_blend_mode(record.blend_mode);
    layer.set_opacity(static_cast<float>(record.opacity) / 255.0F);
    layer.set_fill_opacity(static_cast<float>(record.fill_opacity.value_or(255U)) / 255.0F);
    layer.set_visible(record.visible);
    layer.set_blend_if_payload(std::move(record.blending_ranges),
                               source_color_mode == kColorModeRgb);
    if (record.channel_restrictions.has_value() || record.channel_restrictions_malformed) {
      const bool rgb_indices =
          record.channel_restrictions.has_value() &&
          std::all_of(record.channel_restrictions->begin(), record.channel_restrictions->end(),
                      [](std::uint32_t index) { return index <= 2U; });
      if (!record.channel_restrictions_malformed && rgb_indices && source_color_mode == kColorModeRgb) {
        std::uint8_t restricted = 0;
        for (const auto index : *record.channel_restrictions) {
          restricted |= static_cast<std::uint8_t>(1U << index);
        }
        layer.set_restricted_channels(restricted);
      } else {
        // Non-RGB channel indices (or an unknown payload shape) cannot map onto
        // the RGB model: keep the preserved raw block authoritative.
        layer.set_channel_restriction_unsupported();
      }
    }
    if (record.section_divider_type == 0U) {
      // Divider/folder records never carry the clipping flag into the model, so
      // groups always build unclipped even from stray bytes.
      layer.set_clipped(record.clipping);
    }
    layer.layer_style() = record.layer_style;
    layer.layer_style().layer_mask_hides_effects = record.layer_mask_hides_effects;
    layer.layer_style().blend_interior_elements = record.blend_interior_elements;
    resolve_global_light(layer.layer_style(), global_light_angle, global_light_altitude);
    set_layer_lock_flags(layer,
                         record.protection_flags &
                             (kPsdProtectTransparency | kPsdProtectComposite | kPsdProtectPosition));
    if (!vector_parse_failed && has_legacy_vscg && !vector_fill.has_value() && vector_mask_block.has_value() &&
        vector_stroke.has_value()) {
      // CS6 shape layer with Fill: None. That era wrote no fill block at all
      // (modern PS writes SoCo plus fillEnabled false for the same thing) and
      // kept the stroke paint in vscg, which vstk's strokeStyleContent later
      // duplicated. Build the editable stroke-only shape instead of locking
      // the layer: a vector lock refuses Free Transform, and one locked leaf
      // refuses the whole folder or multi-selection session (September 2026,
      // the bath-controls PSD).
      VectorFill none;
      none.kind = VectorFillKind::None;
      vector_fill = std::move(none);
      if (!vector_stroke_has_content && legacy_stroke_content.has_value()) {
        vector_stroke->content = *legacy_stroke_content;
      }
    }
    if (vector_parse_failed || (has_legacy_vscg && !vector_fill.has_value())) {
      // A vector block failed to parse (or a legacy vscg carries paint with no
      // vstk/vmsk pair to build a shape from): everything stays byte-preserved
      // and the layer locks, mirroring the preview-locked smart-object pattern.
      layer.metadata()[kLayerMetadataVectorLock] = "unparsed";
    } else if (vector_fill.has_value()) {
      // Shape/fill layer: fill content block, optional path, stroke, and
      // origination assemble into the editable model. Rasterization happens in
      // finalize_vector_layers once global pattern blocks have decoded.
      VectorShapeContent content;
      content.fill = std::move(*vector_fill);
      if (vector_stroke.has_value()) {
        content.stroke = std::move(*vector_stroke);
      }
      if (vector_mask_block.has_value()) {
        content.path = std::move(vector_mask_block->path);
        content.path_disabled = vector_mask_block->disabled;
        content.path_inverted = vector_mask_block->inverted;
      }
      if (vector_origination.has_value()) {
        content.origination = std::move(*vector_origination);
      }
      if (!content.origination.empty() &&
          !origination_covers_path_groups(content.path, content.origination)) {
        // A keyDescriptorList covering only some subpath groups can only come
        // from a damaged file — Photoshop refuses to open one. Keep the raw
        // vogk/vowv out of unknown_psd_blocks below so the untouched-layer
        // re-emission cannot write the partial vogk back out; the parsed
        // origination stays in the model for this session's live editing,
        // and the writer's coverage gate keeps it out of regenerated saves.
        drop_partial_origination_blocks = true;
      }
      layer.set_vector_shape(std::move(content));
      layer.metadata()[kLayerMetadataVectorShape] = "1";
      layer.metadata()[kLayerMetadataVectorRasterStatus] = kVectorRasterStatusPhotoshop;
    } else if (vector_mask_block.has_value()) {
      // Vector mask on an ordinary layer. When Photoshop baked a derived plane
      // (density/feather set: mask-data flags bit 3), that plane seeds the
      // coverage cache instead of becoming a raster user mask.
      LayerVectorMask vector_mask;
      vector_mask.path = std::move(vector_mask_block->path);
      vector_mask.disabled = vector_mask_block->disabled;
      vector_mask.inverted = vector_mask_block->inverted;
      vector_mask.unlinked = vector_mask_block->unlinked;
      if (record.mask.has_value()) {
        if (record.mask->vector_density.has_value()) {
          vector_mask.density = *record.mask->vector_density;
        }
        if (record.mask->vector_feather.has_value()) {
          vector_mask.feather = *record.mask->vector_feather;
        }
        if (record.mask->from_rendering) {
          // Photoshop's baked bit-3 plane holds the UNFEATHERED path coverage
          // (the both-masks fixture proves the feather applies at render
          // time), so it never becomes a raster user mask and Patchy
          // re-derives its own feathered cache in finalize_vector_layers.
          decoded_mask.reset();
        }
      }
      layer.set_vector_mask(std::move(vector_mask));
    }
    if (decoded_mask.has_value()) {
      layer.set_mask(std::move(*decoded_mask));
      if (record.mask.has_value() && !record.mask->linked) {
        set_layer_mask_linked(layer, false);
      }
    }
    for (auto& block : record.additional_blocks) {
      if (preserve_original_payloads ||
          layer_block_required_for_modeled_semantics(block.key, block.payload)) {
        if (drop_partial_origination_blocks && (block.key == "vogk" || block.key == "vowv")) {
          continue;
        }
        layer.unknown_psd_blocks().push_back(std::move(block));
      }
    }
    if (record.placed.has_value()) {
      set_layer_smart_object_metadata(layer, record.placed->placement, record.placed->placed_uuid,
                                      record.placed_source_block, record.placed->lock_reason,
                                      kSmartObjectRasterStatusPhotoshop);
      if (record.placed->smart_filters.has_value()) {
        layer.set_smart_filter_stack(*record.placed->smart_filters);
      }
      if (record.placed->warp.has_value() && record.placed->lock_reason.empty()) {
        // A supported (re-renderable) warp rides layer metadata so every re-render
        // and regeneration path sees it.
        layer.metadata()[kLayerMetadataSmartObjectWarp] = serialize_smart_object_warp(*record.placed->warp);
      }
    } else if (record.placed_parse_failed) {
      // An unreadable SoLd (e.g. Photoshop's ObAr warp-mesh values): the layer still
      // gets the smart-object badge and edit/move protection ("unparsed", empty
      // uuid), so its pixels can never drift from the verbatim blobs PS re-renders.
      layer.metadata()[kLayerMetadataSmartObject] = "";
      layer.metadata()[kLayerMetadataSmartObjectLock] = "unparsed";
      layer.metadata()[kLayerMetadataSmartObjectRasterStatus] = kSmartObjectRasterStatusPhotoshop;
    }
    if (record.text.has_value()) {
      layer.metadata()[kLayerMetadataText] = *record.text;
      if (record.text_html.has_value()) {
        layer.metadata()[kLayerMetadataTextHtml] = *record.text_html;
      }
      if (record.text_runs.has_value()) {
        layer.metadata()[kLayerMetadataTextRuns] = *record.text_runs;
      }
      if (record.text_paragraph_runs.has_value()) {
        layer.metadata()[kLayerMetadataTextParagraphRuns] = *record.text_paragraph_runs;
      }
      const auto text_box_width = record.text_box.has_value() ? std::max(1, record.text_box->width)
                                                              : std::max(1, layer.bounds().width);
      const auto text_box_height = record.text_box.has_value() ? std::max(1, record.text_box->height)
                                                               : std::max(1, layer.bounds().height);
      layer.metadata()[kLayerMetadataTextFlow] = record.text_box.has_value() ? "box" : "point";
      layer.metadata()[kLayerMetadataTextBoxWidth] = std::to_string(text_box_width);
      layer.metadata()[kLayerMetadataTextBoxHeight] = std::to_string(text_box_height);
      layer.metadata()[kLayerMetadataTextFont] = record.text_font.value_or(std::string("PSD Text"));
      layer.metadata()[kLayerMetadataTextSize] =
          std::to_string(record.text_size.value_or(estimate_text_size_from_alpha(layer.pixels())));
      layer.metadata()[kLayerMetadataTextColor] =
          record.text_color.has_value() ? rgb_hex_color(*record.text_color) : "#000000";
      if (record.text_bold.has_value()) {
        layer.metadata()[kLayerMetadataTextBold] = *record.text_bold ? "true" : "false";
      }
      if (record.text_italic.has_value()) {
        layer.metadata()[kLayerMetadataTextItalic] = *record.text_italic ? "true" : "false";
      }
      if (record.text_anti_alias.has_value()) {
        layer.metadata()[kLayerMetadataTextAntiAlias] = std::to_string(*record.text_anti_alias);
      }
      if (record.text_source_block.has_value()) {
        layer.metadata()[kLayerMetadataTextSourceBlock] = *record.text_source_block;
        layer.metadata()[kLayerMetadataTextRasterStatus] = text_regenerated_rendered ||
                                                                  record.text_patchy_generated_type_block
                                                              ? "patchy_raster"
                                                          : text_placeholder_rendered ? "placeholder"
                                                                                      : "psd_raster_preview";
        // Photoshop-authored type layers re-render with the Photoshop leading model; Patchy's
        // own exported type blocks keep native layout (see kLayerMetadataTextLayoutMode) --
        // EXCEPT converted-then-saved layers, whose regenerated (Patchy-signed) engine data
        // still carries fixed leading/tracking that only a Photoshop import can produce.
        if (record.text_runs.has_value() &&
            (!record.text_patchy_generated_type_block ||
             serialized_runs_have_photoshop_leading_signals(*record.text_runs))) {
          layer.metadata()[kLayerMetadataTextLayoutMode] = kTextLayoutModePhotoshop;
        }
      }
      if (record.text_geometry.has_value()) {
        layer.metadata()[kLayerMetadataTextTransform] = serialize_double_array(record.text_geometry->transform);
        layer.metadata()[kLayerMetadataPsdTextTransform] = serialize_double_array(record.text_geometry->transform);
        layer.metadata()[kLayerMetadataPsdTextBounds] = serialize_text_bounds(record.text_geometry->bounds);
        layer.metadata()[kLayerMetadataPsdTextBoundingBox] = serialize_text_bounds(record.text_geometry->bounding_box);
        layer.metadata()[kLayerMetadataPsdTextBoxBounds] = serialize_text_bounds(record.text_geometry->box_bounds);
        layer.metadata()[kLayerMetadataPsdTextTailBounds] = serialize_int_array(record.text_geometry->tail_bounds);
        layer.metadata()[kLayerMetadataPsdTextIndex] = std::to_string(record.text_geometry->text_index);
        if (record.text_geometry->warp.has_value()) {
          layer.metadata()[kLayerMetadataTextWarp] = serialize_text_warp(*record.text_geometry->warp);
        }
      }
    }
    decoded_layers.push_back(DecodedLayer{std::move(layer), record.section_divider_type});
  }

  if (unrendered_color_balance_count > 0 && notices != nullptr) {
    notices->push_back(std::to_string(unrendered_color_balance_count) + " Color Balance layer" +
                       (unrendered_color_balance_count == 1 ? " carries" : "s carry") +
                       " shadow/highlight or preserve-luminosity settings that Patchy preserves but does "
                       "not render.");
  }
  return build_group_hierarchy(std::move(decoded_layers));
}

std::vector<Layer> read_layers(BigEndianReader& layer_reader, std::int32_t canvas_width, std::int32_t canvas_height,
                               std::uint16_t source_color_mode, std::uint16_t depth, float global_light_angle,
                               float global_light_altitude, bool large_document,
                               const CmykToRgbTransform* cmyk_icc,
                               bool& has_merged_transparency,
                               std::vector<std::string>* notices,
                               std::size_t* damaged_rows,
                               ParseBudgetTracker& budget,
                               ParseBudgetTracker& decompressed_budget,
                               ParseLiveBudgetTracker& tracked_live_budget,
                               ParseBudgetTracker& layer_record_budget,
                               ParseBudgetTracker& channel_record_budget,
                               ParseBudgetTracker& resource_record_budget,
                               ParseBudgetTracker& retained_payload_budget,
                               bool preserve_original_payloads) {
  has_merged_transparency = false;
  const auto layer_info_length = large_document
                                     ? read_section_length_u64(layer_reader, "layer info")
                                     : static_cast<std::uint64_t>(read_section_length(layer_reader, "layer info"));
  if (layer_info_length == 0) {
    return {};
  }
  if (layer_info_length > layer_reader.remaining()) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP(
        "QObject", "PSD layer info exceeds the layer and mask section"));
  }
  BigEndianReader layer_info_reader(
      layer_reader.read_span(static_cast<std::size_t>(layer_info_length)));
  auto layers = read_layer_info_records(layer_info_reader, canvas_width, canvas_height, source_color_mode, depth,
                                        global_light_angle, global_light_altitude, large_document, cmyk_icc,
                                        has_merged_transparency, notices, damaged_rows, budget,
                                        decompressed_budget, tracked_live_budget,
                                        layer_record_budget, channel_record_budget,
                                        resource_record_budget,
                                        retained_payload_budget,
                                        preserve_original_payloads);
  if ((layer_info_length % 2U) != 0 && layer_reader.remaining() > 0) {
    layer_reader.skip(1);
  }
  return layers;
}

bool read_merged_transparency_flag_and_skip_layer_mask(BigEndianReader& reader,
                                                        std::uint64_t layer_mask_length,
                                                        const Header& header,
                                                        ParseBudgetTracker& resource_record_budget) {
  if (layer_mask_length > reader.remaining()) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "Invalid PSD layer and mask information length"));
  }
  if (layer_mask_length == 0U) {
    return false;
  }
  const auto prefix_size = header.large_document ? 8U : 4U;
  if (layer_mask_length < prefix_size) {
    reader.skip(static_cast<std::size_t>(layer_mask_length));
    return false;
  }
  const auto section_end = reader.position() + static_cast<std::size_t>(layer_mask_length);
  const auto layer_info_length =
      header.large_document ? reader.read_u64() : static_cast<std::uint64_t>(reader.read_u32());
  bool has_merged_transparency = false;
  if (layer_info_length >= 2U && section_end - reader.position() >= 2U) {
    has_merged_transparency = static_cast<std::int16_t>(reader.read_u16()) < 0;
  } else if (header.depth != 8 && layer_info_length == 0U) {
    // 16/32-bit files keep an empty standard layer info section; the layer count
    // whose sign carries the merged-transparency flag lives in the Lr16/Lr32
    // global tagged block, so walk past the global mask info to find it.
    const std::string deep_key = header.depth == 16 ? "Lr16" : "Lr32";
    if (section_end - reader.position() >= 4U) {
      const auto global_mask_length = reader.read_u32();
      reader.skip(std::min<std::size_t>(global_mask_length, section_end - reader.position()));
      while (section_end - reader.position() >= 12U) {
        const auto block_signature = read_signature(reader);
        if (block_signature != std::array<char, 4>{'8', 'B', 'I', 'M'} &&
            block_signature != std::array<char, 4>{'8', 'B', '6', '4'}) {
          break;
        }
        const auto block_key = read_signature(reader);
        const auto key = std::string(block_key.begin(), block_key.end());
        const bool wide_length = block_signature == std::array<char, 4>{'8', 'B', '6', '4'} ||
                                 (header.large_document && tagged_block_length_is_u64(key));
        if (wide_length && section_end - reader.position() < 8U) {
          break;
        }
        const auto block_length =
            wide_length ? reader.read_u64() : static_cast<std::uint64_t>(reader.read_u32());
        if (block_length > section_end - reader.position()) {
          break;
        }
        resource_record_budget.charge(1U);
        if (key == deep_key) {
          if (block_length >= 2U) {
            has_merged_transparency = static_cast<std::int16_t>(reader.read_u16()) < 0;
          }
          break;
        }
        const auto padding = (4U - (block_length % 4U)) % 4U;
        reader.skip(std::min<std::size_t>(
            static_cast<std::size_t>(block_length) + static_cast<std::size_t>(padding),
            section_end - reader.position()));
      }
    }
  }
  reader.skip(section_end - reader.position());
  return has_merged_transparency;
}

}  // namespace

bool DocumentIo::can_read(std::span<const std::uint8_t> bytes) noexcept {
  return bytes.size() >= 4 && bytes[0] == '8' && bytes[1] == 'B' && bytes[2] == 'P' && bytes[3] == 'S';
}

Document DocumentIo::read(std::span<const std::uint8_t> bytes,
                          ReadOptions options) try {
  reset_parse_usage(options.usage);
  ParseBudgetTracker input_budget(options.budget.max_input_bytes,
                                  options.usage != nullptr ? &options.usage->input_bytes : nullptr,
                                  ParseBudgetDimension::InputBytes);
  input_budget.charge_size(bytes.size());
  ParseBudgetTracker primary_pixel_budget(
      options.budget.max_primary_pixel_bytes,
      options.usage != nullptr ? &options.usage->primary_pixel_bytes : nullptr,
      ParseBudgetDimension::PrimaryPixelBytes);
  ParseBudgetTracker decompressed_budget(
      options.budget.max_decompressed_bytes,
      options.usage != nullptr ? &options.usage->decompressed_bytes : nullptr,
      ParseBudgetDimension::DecompressedBytes);
  ParseLiveBudgetTracker tracked_live_budget(
      options.budget.max_tracked_live_bytes,
      options.usage != nullptr ? &options.usage->tracked_live_bytes : nullptr,
      options.usage != nullptr ? &options.usage->tracked_live_bytes_high_water
                               : nullptr);
  ParseBudgetTracker layer_record_budget(
      options.budget.max_layer_records,
      options.usage != nullptr ? &options.usage->layer_records : nullptr,
      ParseBudgetDimension::LayerRecords);
  ParseBudgetTracker channel_record_budget(
      options.budget.max_channel_records,
      options.usage != nullptr ? &options.usage->channel_records : nullptr,
      ParseBudgetDimension::ChannelRecords);
  ParseBudgetTracker resource_record_budget(
      options.budget.max_resource_records,
      options.usage != nullptr ? &options.usage->resource_records : nullptr,
      ParseBudgetDimension::ResourceRecords);
  ParseBudgetTracker descriptor_node_budget(
      options.budget.max_descriptor_nodes,
      options.usage != nullptr ? &options.usage->descriptor_nodes : nullptr,
      ParseBudgetDimension::DescriptorNodes);
  ParseBudgetTracker pattern_record_budget(
      options.budget.max_pattern_records,
      options.usage != nullptr ? &options.usage->pattern_records : nullptr,
      ParseBudgetDimension::PatternRecords);
  ParseBudgetTracker retained_payload_budget(
      options.budget.max_retained_payload_bytes,
      options.usage != nullptr ? &options.usage->retained_payload_bytes : nullptr,
      ParseBudgetDimension::RetainedPayloadBytes);
  DescriptorNodeBudgetScope descriptor_scope(descriptor_node_budget);
  BigEndianReader reader(bytes);
  const auto header = read_header(reader);
  {
    // Validate the canvas before anything sizes a buffer from it: the flat composite and every
    // layer plane allocate width x height up front, and a damaged header would request
    // terabytes (a bad_alloc at best, an OOM kill on overcommitting systems).
    const auto limit = static_cast<std::uint32_t>(header.large_document ? kMaxPsbDimension : kMaxPsdDimension);
    if (header.width == 0 || header.height == 0 || header.width > limit || header.height > limit) {
      throw std::runtime_error(header.large_document ? "Invalid PSB canvas size" : "Invalid PSD canvas size");
    }
  }
  const auto format = format_from_header(header);
  channel_record_budget.charge(header.channels);
  if (header.depth != 8 && options.notices != nullptr) {
    options.notices->push_back(header.depth == 32
                                   ? "Converted 32-bit (HDR) color to 8-bit; precision and dynamic "
                                     "range beyond the 8-bit gamut were lost."
                                   : "Converted 16-bit color to 8-bit; some precision was lost.");
  }

  skip_length_block(reader, "color mode data");
  const auto image_resources_length =
      read_section_length(reader, "image resources");
  const auto image_resources = reader.read_span(image_resources_length);
  charge_image_resource_records(image_resources, resource_record_budget);
  const auto channel_resources = parse_composite_channel_resources(image_resources);

  Document document(static_cast<std::int32_t>(header.width), static_cast<std::int32_t>(header.height), format);
  if (auto icc_profile = find_image_resource_payload_view(image_resources, kImageResourceIccProfile);
      header.color_mode == kColorModeRgb && icc_profile.has_value()) {
    retained_payload_budget.charge_size(icc_profile->size());
    document.color_state().embedded_icc_profile.assign(icc_profile->begin(),
                                                       icc_profile->end());
  }
  // CMYK sources convert through the file's embedded ICC profile when one is usable,
  // matching Photoshop; otherwise the naive ink mix is the fallback. The CMYK profile is
  // deliberately NOT promoted into color_state() (it does not describe the converted RGB
  // pixels and is stripped from RGB re-exports).
  std::optional<CmykToRgbTransform> cmyk_icc_transform;
  if (is_cmyk_color_mode(header.color_mode)) {
    if (auto icc_profile = find_image_resource_payload_view(image_resources, kImageResourceIccProfile);
        icc_profile.has_value()) {
      cmyk_icc_transform = CmykToRgbTransform::from_icc_profile(*icc_profile);
      if (options.notices != nullptr) {
        if (cmyk_icc_transform.has_value()) {
          const auto& description = cmyk_icc_transform->profile_description();
          options.notices->push_back(
              "Converted CMYK colors to RGB using the document's embedded color profile" +
              (description.empty() ? std::string(".") : " '" + description + "'."));
        } else {
          options.notices->push_back(
              "The document's embedded CMYK color profile could not be used; colors were "
              "converted with a basic CMYK-to-RGB formula.");
        }
      }
    }
  }
  const auto* cmyk_icc = cmyk_icc_transform.has_value() ? &*cmyk_icc_transform : nullptr;
  if (auto resolution = find_image_resource_payload_view(image_resources, kImageResourceResolutionInfo);
      resolution.has_value()) {
    if (auto print_settings = print_settings_from_resolution_resource(*resolution); print_settings.has_value()) {
      document.print_settings() = *print_settings;
    }
  }
  if (auto grid_guides = find_image_resource_payload_view(image_resources, kImageResourceGridAndGuidesInfo);
      grid_guides.has_value()) {
    if (auto parsed_grid_guides = grid_guides_from_resource(*grid_guides); parsed_grid_guides.has_value()) {
      document.grid_settings() = parsed_grid_guides->first;
      document.guides() = std::move(parsed_grid_guides->second);
    }
  }
  // Document-wide light direction for effects marked "use global light" (signed degrees).
  auto global_light_angle = kDefaultGlobalLightAngle;
  auto global_light_altitude = kDefaultGlobalLightAltitude;
  if (auto angle = find_image_resource_payload_view(image_resources, kImageResourceGlobalLightAngle);
      angle.has_value() && angle->size() >= 4U) {
    global_light_angle = static_cast<float>(static_cast<std::int32_t>(BigEndianReader(*angle).read_u32()));
  }
  if (auto altitude = find_image_resource_payload_view(image_resources, kImageResourceGlobalLightAltitude);
      altitude.has_value() && altitude->size() >= 4U) {
    global_light_altitude = static_cast<float>(static_cast<std::int32_t>(BigEndianReader(*altitude).read_u32()));
  }
  if (options.preserve_unknown_blocks) {
    retained_payload_budget.charge_size(image_resources.size());
    document.metadata().raw_psd_image_resources.assign(image_resources.begin(),
                                                       image_resources.end());
  }
  const auto layer_mask_length =
      header.large_document
          ? read_section_length_u64(reader, "layer and mask information")
          : static_cast<std::uint64_t>(read_section_length(reader, "layer and mask information"));
  bool has_merged_transparency = false;
  // Counts scanlines this file could not decode cleanly, across layers and the composite,
  // so one recovery notice covers the whole document.
  std::size_t damaged_rows = 0;
  if (options.prefer_flat_composite) {
    has_merged_transparency =
        read_merged_transparency_flag_and_skip_layer_mask(
            reader, layer_mask_length, header, resource_record_budget);

    auto metadata = std::move(document.metadata());
    auto color_state = std::move(document.color_state());
    auto print_settings = document.print_settings();
    auto grid_settings = document.grid_settings();
    auto guides = std::move(document.guides());
    document = read_flat_composite(reader, header, cmyk_icc, channel_resources,
                                   has_merged_transparency, primary_pixel_budget,
                                   decompressed_budget, tracked_live_budget,
                                   retained_payload_budget,
                                   options.preserve_unknown_blocks,
                                   &damaged_rows);
    document.metadata() = std::move(metadata);
    document.color_state().embedded_icc_profile = std::move(color_state.embedded_icc_profile);
    document.color_state().ocio_view = std::move(color_state.ocio_view);
    document.print_settings() = print_settings;
    document.grid_settings() = grid_settings;
    document.guides() = std::move(guides);
    document.metadata().values["psd.version"] = header.large_document ? "PSB" : "PSD";
    document.metadata().values["psd.color_mode"] = color_mode_name(header.color_mode);
    if (auto palette = find_image_resource_payload_view(
            image_resources, kImageResourcePatchyPalette);
        palette.has_value()) {
      apply_patchy_palette_resource(document, *palette,
                                    retained_payload_budget);
    }
    append_damaged_row_notice(damaged_rows, options.notices);
    return document;
  }

  if (layer_mask_length > 0) {
    auto layer_mask_payload = reader.read_span(static_cast<std::size_t>(layer_mask_length));
    BigEndianReader layer_reader(layer_mask_payload);
    auto layers = read_layers(layer_reader, document.width(), document.height(), header.color_mode,
                              header.depth, global_light_angle, global_light_altitude, header.large_document,
                              cmyk_icc, has_merged_transparency, options.notices, &damaged_rows,
                              primary_pixel_budget, decompressed_budget,
                              tracked_live_budget, layer_record_budget,
                              channel_record_budget, resource_record_budget,
                              retained_payload_budget,
                              options.preserve_unknown_blocks);
    const auto add_layer = [&document](Layer source) {
      document.add_layer(
          move_layer_with_document_ids(document, std::move(source)));
    };

    // Photoshop stores layer records bottom-to-top. Older Patchy builds wrote
    // them top-to-bottom, which is detectable when a full Background record is last.
    if (records_look_like_legacy_top_to_bottom(layers, document.width(), document.height())) {
      for (auto it = layers.rbegin(); it != layers.rend(); ++it) {
        add_layer(std::move(*it));
      }
    } else {
      for (auto& source : layers) {
        add_layer(std::move(source));
      }
    }

    // Preserve what follows the layer info: the global layer mask info and the
    // document-global tagged blocks. Dropping these orphans smart-object layers —
    // their 'PlLd'/'SoLd' blocks reference embedded sources stored in the global
    // 'lnk2' block, and Photoshop can open but no longer save a file where those
    // references dangle.
    if (layer_reader.remaining() >= 4U) {
      const auto global_mask_length = layer_reader.read_u32();
      if (global_mask_length <= layer_reader.remaining()) {
        if (options.preserve_unknown_blocks) {
          retained_payload_budget.charge(global_mask_length);
          document.metadata().raw_psd_global_layer_mask_info =
              layer_reader.read_bytes(global_mask_length);
        } else {
          layer_reader.skip(global_mask_length);
        }
      }
    }
    std::size_t global_block_index = 0;
    while (layer_reader.remaining() >= 12U) {
      const auto block_signature = read_signature(layer_reader);
      if (block_signature != std::array<char, 4>{'8', 'B', 'I', 'M'} &&
          block_signature != std::array<char, 4>{'8', 'B', '6', '4'}) {
        break;
      }
      const auto block_key = read_signature(layer_reader);
      const auto key = std::string(block_key.begin(), block_key.end());
      // Same width rule as the per-layer walk: '8B64' signature OR (PSB and the key
      // is in the documented 8-byte set). PS 2023 writes 'lnk2' as '8BIM' + u64.
      const bool wide_length = block_signature == std::array<char, 4>{'8', 'B', '6', '4'} ||
                               (header.large_document && tagged_block_length_is_u64(key));
      if (wide_length && layer_reader.remaining() < 8U) {
        break;
      }
      const auto block_length =
          wide_length ? layer_reader.read_u64() : static_cast<std::uint64_t>(layer_reader.read_u32());
      if (block_length > layer_reader.remaining()) {
        break;
      }
      resource_record_budget.charge(1U);
      const auto payload =
          layer_reader.read_span(static_cast<std::size_t>(block_length));
      const auto* layer_info_key = header.depth == 16   ? "Lr16"
                                   : header.depth == 32 ? "Lr32"
                                                        : "Layr";
      if (key == layer_info_key && document.layers().empty() && payload.size() >= 2U) {
        // 16/32-bit files store their layers here instead of the (empty) standard
        // layer info section ('Layr' is the same structure for 8-bit files). The
        // layers convert to 8-bit, so the block is consumed and deliberately NOT
        // preserved: re-emitting a stale deep layer block from an 8-bit re-save
        // would mislead Photoshop.
        BigEndianReader block_reader(payload);
        auto deep_layers = read_layer_info_records(
            block_reader, document.width(), document.height(), header.color_mode, header.depth,
            global_light_angle, global_light_altitude, header.large_document, cmyk_icc,
            has_merged_transparency, options.notices, &damaged_rows, primary_pixel_budget,
            decompressed_budget, tracked_live_budget, layer_record_budget,
            channel_record_budget, resource_record_budget,
            retained_payload_budget, options.preserve_unknown_blocks);
        // Always Photoshop's bottom-to-top order: legacy Patchy never wrote these
        // blocks, so the legacy-order heuristic used for the standard section
        // could only misfire here.
        for (auto& source : deep_layers) {
          add_layer(std::move(source));
        }
      } else if ((key == "Mt16" && header.depth == 16) || (key == "Mt32" && header.depth == 32)) {
        // Deep merged-transparency planes have no place in the converted 8-bit
        // document; drop them rather than re-emit them from an 8-bit save.
      } else if (key.rfind("lnk", 0) == 0 || key.rfind("Lnk", 0) == 0) {
        // Smart-object source blocks parse into the store (payloads shared_ptr-held so
        // undo snapshots stop duplicating embedded files); unparseable ones stay opaque.
        SmartObjectLinkBlock link_block;
        link_block.key = key;
        link_block.long_length = wide_length;
        link_block.original_global_index = global_block_index;
        if (options.preserve_unknown_blocks) {
          retained_payload_budget.charge_size(payload.size());
          link_block.original_payload =
              std::make_shared<const std::vector<std::uint8_t>>(
                  payload.begin(), payload.end());
        }
        if (auto sources = parse_linked_layer_block(
                payload, retained_payload_budget,
                options.preserve_unknown_blocks);
            sources.has_value()) {
          link_block.sources = std::move(*sources);
        } else if (options.preserve_unknown_blocks) {
          link_block.opaque = true;
        }
        if (options.preserve_unknown_blocks || !link_block.sources.empty()) {
          document.metadata().smart_objects.blocks.push_back(std::move(link_block));
        }
      } else if (key == "FEid" || key == "FXid") {
        // Native Smart Filter caches are per placed-layer INSTANCE (SoLd
        // `placed`), not per shared embedded source (`Idnt`). Keep each record's
        // large byte ranges shared across undo snapshots and preserve opaque
        // variants verbatim.
        // Parsed Smart Filter records use ranges into this shared storage for
        // semantics and future edits, so the owner is retained even when
        // generic unknown preservation is disabled. Opaque blocks are dropped
        // in that mode below.
        retained_payload_budget.charge_size(payload.size());
        auto shared_payload =
            std::make_shared<const std::vector<std::uint8_t>>(payload.begin(),
                                                              payload.end());
        auto parsed = parse_filter_effects_block(
            key, std::move(shared_payload), wide_length, global_block_index,
            decompressed_budget, tracked_live_budget,
            retained_payload_budget);
        if (!parsed.opaque || options.preserve_unknown_blocks) {
          document.metadata().smart_filter_effects.add_block(std::move(parsed));
        }
      } else if (key == "Patt" || key == "Pat2" || key == "Pat3") {
        // Pattern pixel data: decode into the store so pattern overlays / bevel
        // textures can render, AND keep the raw block preserved verbatim (Patchy
        // never rewrites imported pattern blocks). Decode into a local before the
        // payload moves — the argument-evaluation-order rule.
        auto decoded = parse_patterns_block(payload, cmyk_icc,
                                            decompressed_budget,
                                            tracked_live_budget,
                                            pattern_record_budget,
                                            retained_payload_budget);
        for (auto& resource : decoded) {
          document.metadata().patterns.adopt(resource);
        }
        if (options.preserve_unknown_blocks) {
          retained_payload_budget.charge_size(payload.size());
          document.metadata().unknown_psd_resources.push_back(
              UnknownPsdBlock{key,
                              std::vector<std::uint8_t>(payload.begin(), payload.end()),
                              wide_length, global_block_index});
        }
      } else if (options.preserve_unknown_blocks) {
        retained_payload_budget.charge_size(payload.size());
        document.metadata().unknown_psd_resources.push_back(
            UnknownPsdBlock{key,
                            std::vector<std::uint8_t>(payload.begin(), payload.end()),
                            wide_length, global_block_index});
      }
      ++global_block_index;
      // Global tagged blocks are padded to 4-byte boundaries.
      const auto padding = (4U - (block_length % 4U)) % 4U;
      layer_reader.skip(std::min<std::size_t>(static_cast<std::size_t>(padding), layer_reader.remaining()));
    }
  }

  if (document.layers().empty()) {
    auto metadata = std::move(document.metadata());
    auto color_state = std::move(document.color_state());
    auto print_settings = document.print_settings();
    auto grid_settings = document.grid_settings();
    auto guides = std::move(document.guides());
    document = read_flat_composite(reader, header, cmyk_icc, channel_resources,
                                   has_merged_transparency, primary_pixel_budget,
                                   decompressed_budget, tracked_live_budget,
                                   retained_payload_budget,
                                   options.preserve_unknown_blocks,
                                   &damaged_rows);
    document.metadata() = std::move(metadata);
    document.color_state().embedded_icc_profile = std::move(color_state.embedded_icc_profile);
    document.color_state().ocio_view = std::move(color_state.ocio_view);
    document.print_settings() = print_settings;
    document.grid_settings() = grid_settings;
    document.guides() = std::move(guides);
  } else {
    // The editable layer data is authoritative. Decode RGB only for the optional
    // first-paint cache; when only saved channels are needed, raw color planes and
    // encoded RLE rows are skipped without allocating a base composite.
    const auto color_channel_count = composite_color_channel_count(header.color_mode);
    const auto first_saved_channel = static_cast<std::uint16_t>(
        color_channel_count + (has_merged_transparency ? 1U : 0U));
    if (first_saved_channel > header.channels) {
      throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "PSD merged transparency flag has no matching composite channel"));
    }
    const auto saved_channel_count = static_cast<std::size_t>(header.channels - first_saved_channel);
    if (options.retain_flat_composite) {
      try {
        auto flat_composite = read_flat_composite(reader, header, cmyk_icc, channel_resources,
                                                  has_merged_transparency, primary_pixel_budget,
                                                  decompressed_budget, tracked_live_budget,
                                                  retained_payload_budget,
                                                  options.preserve_unknown_blocks,
                                                  &damaged_rows);
        if (!flat_composite.layers().empty() && flat_composite.layers().front().kind() == LayerKind::Pixel) {
          document.metadata().psd_flat_composite =
              std::as_const(flat_composite).layers().front().pixels();
          for (auto& channel : flat_composite.channels()) {
            document.add_channel(std::move(channel));
          }
        }
      } catch (const ParseBudgetExceeded&) {
        throw;
      } catch (const std::exception&) {
        document.metadata().psd_flat_composite.reset();
        if (saved_channel_count != 0U) {
          throw;
        }
      }
    } else if (saved_channel_count != 0U) {
      if (reader.remaining() < 2U) {
        throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "PSD composite image data is missing"));
      }
      const auto compression = reader.read_u16();
      primary_pixel_budget.charge_dimensions(document.width(), document.height(), saved_channel_count);
      auto saved_channels = read_flat_image_channels_from(reader, header, compression,
                                                          first_saved_channel,
                                                          decompressed_budget,
                                                          tracked_live_budget,
                                                          &damaged_rows);
      add_saved_composite_channels(document, std::move(saved_channels), first_saved_channel, header,
                                   channel_resources, retained_payload_budget,
                                   options.preserve_unknown_blocks);
    }
  }

  append_damaged_row_notice(damaged_rows, options.notices);
  finalize_smart_filter_layers(document.layers(),
                               document.metadata().smart_filter_effects,
                               retained_payload_budget);
  SmartObjectImportCounts smart_object_counts;
  finalize_smart_object_layers(document.layers(), document.metadata().smart_objects, smart_object_counts);
  append_smart_object_notices(smart_object_counts, options.notices);
  // Vector shape layers rasterize here (after the pattern blocks decoded so
  // pattern fills resolve); saved/work/clipping paths parse from the preserved
  // image resources.
  finalize_vector_layers(document);
  if (const auto compound = find_image_resource_payload_view(
          image_resources,
          kImageResourcePatchyCompoundVectors)) {
    apply_compound_vector_resource(document, *compound);
  }
  auto compound_descriptor_workspace = tracked_live_budget.reserve_size(
      compound_collapse_descriptor_workspace_bytes(document.layers()));
  collapse_compound_vector_groups(document);
  compound_descriptor_workspace.release();
  parse_document_path_resources(document, image_resources,
                                retained_payload_budget,
                                options.preserve_unknown_blocks);

  document.metadata().values["psd.version"] = header.large_document ? "PSB" : "PSD";
  document.metadata().values["psd.color_mode"] = color_mode_name(header.color_mode);
  if (auto palette = find_image_resource_payload_view(
          image_resources,
          kImageResourcePatchyPalette);
      palette.has_value()) {
    apply_patchy_palette_resource(document, *palette,
                                  retained_payload_budget);
  }
  return document;
} catch (const DescriptorNodeBudgetSignal&) {
  throw ParseBudgetExceeded(ParseBudgetDimension::DescriptorNodes);
}

Document DocumentIo::read_file(const std::filesystem::path& path, ReadOptions options) {
  reset_parse_usage(options.usage);
  const auto bytes = read_file_bytes_with_budget(path, options.budget);
  return read(bytes, options);
}

std::vector<std::uint8_t> DocumentIo::write_flat_rgb8(const Document& document, WriteOptions options) {
  reset_save_usage(options.usage);
  report_save_progress(options, SavePhase::Started);
  check_write_dimensions(document, options.large_document);
  preflight_save(document, options, false);
  SaveLiveBudgetTracker tracked_live_budget(
      options.budget.max_tracked_live_bytes,
      options.usage != nullptr ? &options.usage->tracked_live_bytes : nullptr,
      options.usage != nullptr
          ? &options.usage->tracked_live_bytes_high_water
          : nullptr);

  try {
    report_save_progress(options, SavePhase::Compositing);
    auto composite = document_alpha_composite(document, tracked_live_budget);
    if (!composite.has_value()) {
      composite = merged_flatten_composite(document, tracked_live_budget);
      // A flat file has no layer section to carry the spec's negative-layer-count
      // "merged transparency" flag, so its alpha exports under the saved-channel
      // convention instead; the flat reader imports "Alpha 1" as a DocumentChannel.
      if (!composite->channel_name.empty()) {
        composite->channel_name = "Alpha 1";
      }
    }

    std::vector<std::span<const std::uint8_t>> extra_channels;
    std::vector<CompositeChannelInfo> channel_info;
    if (!composite->channel_name.empty()) {
      extra_channels.emplace_back(composite->alpha);
      channel_info.push_back(CompositeChannelInfo{
          composite->channel_name, false, true, std::nullopt,
          DocumentChannelDisplayInfo{}, {}});
    }
    append_document_channels_for_write(document, extra_channels, channel_info);
    check_composite_channel_limit(extra_channels.size());

    SaveOutputBudgetTracker output_budget(options);
    BigEndianWriter writer(&SaveOutputBudgetTracker::before_write,
                           &output_budget);
    write_header(writer,
                 Header{options.large_document,
                        static_cast<std::uint16_t>(3U + extra_channels.size()),
                        static_cast<std::uint32_t>(composite->rgb.height()),
                        static_cast<std::uint32_t>(composite->rgb.width()), 8,
                        kColorModeRgb});

    writer.write_u32(0);  // Color mode data section.
    {
      const auto image_resources = image_resources_for_document(
          document, channel_info, tracked_live_budget);
      write_length_prefixed_block(writer, image_resources.bytes);
    }
    if (options.large_document) {
      writer.write_u64(0);  // Layer and mask information section.
    } else {
      writer.write_u32(0);  // Layer and mask information section.
    }
    if (!extra_channels.empty()) {
      write_rgb8_image_data_with_extra_channels(
          writer, composite->rgb, extra_channels, options.large_document,
          tracked_live_budget);
    } else {
      write_rgb8_image_data(writer, composite->rgb, options.large_document,
                            tracked_live_budget);
    }

    auto bytes = std::move(writer).take_bytes();
    report_save_progress(options, SavePhase::Complete, bytes.size());
    return bytes;
  } catch (const SaveLiveBudgetSignal&) {
    throw SaveBudgetExceeded(SaveBudgetDimension::TrackedLiveBytes);
  }
}

void DocumentIo::write_flat_rgb8_file(const Document& document, const std::filesystem::path& path,
                                      WriteOptions options) {
  const auto bytes = write_flat_rgb8(document, options);
  write_file_bytes(path, bytes);
}

namespace {

std::vector<std::uint8_t> write_layered_rgb8_impl(const Document& document,
                                                  WriteOptions options,
                                                  SaveLiveBudgetTracker& tracked_live_budget) {
  check_write_dimensions(document, options.large_document);
  report_save_progress(options, SavePhase::Normalizing);
  const auto workspace = save_workspace_census(document);
  auto normalization_owner = tracked_live_budget.reserve(
      workspace.normalization_owner_bytes);
  auto normalization_scratch = tracked_live_budget.reserve(
      workspace.normalization_scratch_bytes);
  if (auto prepared = prepare_compound_vector_psd(document)) {
    normalization_scratch.release();
    return write_layered_rgb8_impl(*prepared, options, tracked_live_budget);
  }
  normalization_scratch.release();
  if (document.layers().empty()) {
    // The signed record count carries merged transparency. Supply one empty
    // record in the file without inventing a layer in the live document.
    auto writable = document;
    writable.add_layer(Layer(writable.allocate_layer_id(), "Layer", PixelBuffer(1, 1, PixelFormat::rgba8())));
    return write_layered_rgb8_impl(writable, options, tracked_live_budget);
  }
  normalization_owner.release();
  std::size_t record_count = 0;
  const auto count_records = [&](auto&& self, const std::vector<Layer>& layers) -> void {
    for (const auto& layer : layers) {
      record_count += layer.kind() == LayerKind::Group ? 2U : 1U;
      // The format's signed count holds more, but Photoshop rejects 8001
      // records with a composite-only fallback. Folder boundaries count too.
      if (record_count > 8000U) {
        throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "Photoshop supports at most 8000 layer records, including group boundaries"));
      }
      self(self, layer.children());
    }
  };
  count_records(count_records, document.layers());

  report_save_progress(options, SavePhase::Compositing);
  auto composite = merged_flatten_composite(document, tracked_live_budget);

  const bool merged_transparency_channel = composite.channel_name == "Transparency";
  std::vector<std::span<const std::uint8_t>> extra_channels;
  std::vector<CompositeChannelInfo> channel_info;
  if (!composite.channel_name.empty()) {
    DocumentChannelDisplayInfo display_info;
    if (merged_transparency_channel) {
      display_info.opacity = 1.0F;
    }
    extra_channels.emplace_back(composite.alpha);
    channel_info.push_back(CompositeChannelInfo{composite.channel_name, merged_transparency_channel,
                                                !merged_transparency_channel, std::nullopt,
                                                display_info, {}});
  }
  append_document_channels_for_write(document, extra_channels, channel_info);
  check_composite_channel_limit(extra_channels.size());

  std::vector<EncodedLayer> encoded_layers;
  encoded_layers.reserve(document.layers().size());
  report_save_progress(options, SavePhase::EncodingLayers);
  // Photoshop stores layer records in stack order from bottom to top. Patchy's
  // document model uses the same order, so write it directly instead of reversing.
  for (const auto& layer : document.layers()) {
    append_encoded_layers(layer, encoded_layers, options.large_document,
                          tracked_live_budget);
  }

  SaveTrackedWriter tracked_layer_info(tracked_live_budget);
  auto& layer_info = tracked_layer_info.writer();
  // A NEGATIVE layer count is the spec's "first alpha channel contains the merged
  // transparency" flag: without it Photoshop surfaces the composite's 4th channel as
  // a phantom saved channel named "Transparency" in the Channels panel (PS's own
  // transparent-canvas files write the negative form, verified July 2026 via COM
  // channel counts). Saved document channels follow this derived plane.
  const auto layer_count = static_cast<std::int16_t>(encoded_layers.size());
  if (merged_transparency_channel && layer_count == 0) {
    throw std::runtime_error(PATCHY_TRANSLATE_NOOP("QObject", "A layered PSD needs a layer record to identify merged transparency"));
  }
  layer_info.write_u16(static_cast<std::uint16_t>(merged_transparency_channel ? -layer_count : layer_count));
  const auto& global_blocks = document.metadata().unknown_psd_resources;
  const auto has_smart_object_sources =
      !document.metadata().smart_objects.blocks.empty() ||
      std::any_of(global_blocks.begin(), global_blocks.end(), [](const UnknownPsdBlock& block) {
        return block.key.rfind("lnk", 0) == 0 || block.key.rfind("Lnk", 0) == 0;
      });
  // Smart-object layers must carry a 'lyid' layer id or Photoshop rejects the
  // file once a Smart Filter cache is present (see write_layer_record). Fresh
  // ids continue above the largest preserved one; assignment follows record
  // order so repeated saves stay deterministic.
  auto next_layer_id = next_photoshop_layer_id(document.layers());
  for (const auto& encoded : encoded_layers) {
    const bool needs_layer_id = has_smart_object_sources && encoded.layer != nullptr &&
                                layer_is_smart_object(*encoded.layer) &&
                                !photoshop_layer_id(*encoded.layer).has_value();
    write_layer_record(layer_info, encoded, !has_smart_object_sources, options.large_document,
                       needs_layer_id ? next_layer_id++ : 0U,
                       Rect::from_size(document.width(), document.height()),
                       tracked_live_budget);
  }
  for (const auto& encoded : encoded_layers) {
    for (const auto& channel : encoded.channels) {
      layer_info.write_u16(channel.compression);
      layer_info.write_bytes(channel.data);
    }
  }
  // The layer info section is rounded up to an even length; Photoshop's own PSB output
  // pads to 2 as well (verified against a PS 2026 PSB), not to 4.
  if ((layer_info.bytes().size() % 2U) != 0) {
    layer_info.write_u8(0);
  }

  SaveTrackedWriter tracked_layer_mask(tracked_live_budget);
  auto& layer_mask = tracked_layer_mask.writer();
  if (options.large_document) {
    layer_mask.write_u64(layer_info.bytes().size());
    layer_mask.write_bytes(layer_info.bytes());
  } else {
    write_length_prefixed_block(layer_mask, layer_info.bytes());
  }
  write_length_prefixed_block(layer_mask, document.metadata().raw_psd_global_layer_mask_info);
  // Re-interleave the smart-object source blocks (parsed into the store on read) with
  // the preserved unknown blocks in their original file order; authored store blocks
  // (original_global_index == SIZE_MAX) land after everything else.
  const auto emit_global_payload = [&layer_mask, &options](std::string_view key_text,
                                                           std::span<const std::uint8_t> payload,
                                                           bool long_length) {
    const auto key = block_key_from_string(key_text);
    if (!key.has_value()) {
      return;
    }
    // Global blocks 4-align outside the declared length below, so the per-layer
    // even-padding must stay off here or the alignment math shifts by one byte.
    write_additional_layer_block(layer_mask, *key, payload, options.large_document, long_length,
                                 /*pad_payload_to_even=*/false);
    // Global tagged blocks are padded to 4-byte boundaries.
    const auto padding = (4U - (payload.size() % 4U)) % 4U;
    for (std::size_t i = 0; i < padding; ++i) {
      layer_mask.write_u8(0);
    }
  };
  {
    const auto& store = document.metadata().smart_objects;
    const auto& filter_store = document.metadata().smart_filter_effects;
    std::vector<SaveTrackedByteBuffer> link_payloads;
    link_payloads.reserve(store.blocks.size());
    for (std::size_t i = 0; i < store.blocks.size(); ++i) {
      link_payloads.push_back(serialize_linked_layer_block_tracked(
          store.blocks[i], tracked_live_budget));
    }
    std::vector<SaveTrackedByteBuffer> filter_payloads;
    filter_payloads.reserve(filter_store.blocks.size());
    for (std::size_t i = 0; i < filter_store.blocks.size(); ++i) {
      filter_payloads.push_back(serialize_filter_effects_block_tracked(
          filter_store.blocks[i], tracked_live_budget));
    }
    enum class GlobalEmissionKind { Unknown, Link, Filter };
    struct GlobalEmission {
      std::size_t original_index;
      GlobalEmissionKind kind;
      std::size_t item_index;
    };
    std::vector<GlobalEmission> emissions;
    emissions.reserve(global_blocks.size() + store.blocks.size() + filter_store.blocks.size());
    // The insertion order below intentionally matches the old authored-block
    // behavior for SIZE_MAX entries: unknown globals, then links, then filters.
    for (std::size_t i = 0; i < global_blocks.size(); ++i) {
      emissions.push_back(
          {global_blocks[i].original_global_index, GlobalEmissionKind::Unknown, i});
    }
    for (std::size_t i = 0; i < store.blocks.size(); ++i) {
      emissions.push_back(
          {store.blocks[i].original_global_index, GlobalEmissionKind::Link, i});
    }
    for (std::size_t i = 0; i < filter_store.blocks.size(); ++i) {
      emissions.push_back({filter_store.blocks[i].original_global_index,
                           GlobalEmissionKind::Filter, i});
    }
    std::stable_sort(emissions.begin(), emissions.end(),
                     [](const GlobalEmission& lhs, const GlobalEmission& rhs) {
                       return lhs.original_index < rhs.original_index;
                     });
    for (const auto& emission : emissions) {
      switch (emission.kind) {
        case GlobalEmissionKind::Unknown: {
          const auto& block = global_blocks[emission.item_index];
          emit_global_payload(block.key, block.payload, block.long_length);
          break;
        }
        case GlobalEmissionKind::Link: {
          const auto& block = store.blocks[emission.item_index];
          emit_global_payload(block.key,
                              link_payloads[emission.item_index].bytes,
                              block.long_length);
          break;
        }
        case GlobalEmissionKind::Filter: {
          const auto& block = filter_store.blocks[emission.item_index];
          emit_global_payload(block.key,
                              filter_payloads[emission.item_index].bytes,
                              block.long_length);
          break;
        }
      }
    }
  }
  {
    // Patchy-authored pattern tiles: embed every pattern referenced by some
    // layer — its style (enabled or not, matching Photoshop) plus its vector
    // fill/stroke content — that the preserved raw pattern blocks do not
    // already cover. The raw-block id scan is the authority — a cross-document
    // adoption may claim ImportedRaw provenance this document's blocks never
    // contained. Unreferenced store entries are simply not written (orphans
    // prune at save).
    std::vector<std::string> referenced_ids;
    const auto collect_layer_ids = [&referenced_ids](const Layer& layer, const auto& recurse) -> void {
      collect_referenced_pattern_ids(layer, referenced_ids);
      for (const auto& child : layer.children()) {
        recurse(child, recurse);
      }
    };
    for (const auto& layer : document.layers()) {
      collect_layer_ids(layer, collect_layer_ids);
    }
    if (!referenced_ids.empty()) {
      std::vector<std::string> covered_ids;
      for (const auto& block : global_blocks) {
        if (block.key == "Patt" || block.key == "Pat2" || block.key == "Pat3") {
          auto ids = pattern_ids_in_block(block.payload);
          covered_ids.insert(covered_ids.end(), ids.begin(), ids.end());
        }
      }
      // Reservation precedes its resource so the PixelBuffer dies before its
      // charge is released, including exceptional unwinds and vector teardown.
      struct GeneratedPatternOwner {
        SaveLiveBudgetTracker::Reservation reservation;
        PatternResource resource;
      };
      std::vector<GeneratedPatternOwner> generated_patterns;
      generated_patterns.reserve(referenced_ids.size());
      // Declared after generated_patterns so these shared PixelBuffer views die
      // before their generated owners and reservations.
      std::vector<PatternResource> patterns_to_write;
      patterns_to_write.reserve(referenced_ids.size());
      for (const auto& id : referenced_ids) {
        if (std::find(covered_ids.begin(), covered_ids.end(), id) != covered_ids.end()) {
          continue;
        }
        const auto* resource = document.metadata().patterns.find(id);
        if (resource != nullptr && !pattern_tile_is_unrenderable(resource->tile)) {
          if (!pattern_resource_is_serializable(*resource)) {
            throw std::runtime_error(PATCHY_TRANSLATE_NOOP(
                "QObject", "PSD pattern length is invalid"));
          }
          patterns_to_write.push_back(*resource);
          continue;
        }
        // No usable tile anywhere for this id (a damaged import or a poisoned
        // store entry). Photoshop hard-refuses to open a file whose pattern
        // reference resolves nowhere ("program error", July 2026 bisection),
        // so the reference must never dangle: embed a 1x1 fully transparent
        // placeholder. It renders as no paint — exactly Patchy's
        // missing-pattern render — and PatternStore::adopt treats it as
        // heal-able if the real pattern is ever re-applied.
        if (id.size() > 255U) {
          throw std::runtime_error(PATCHY_TRANSLATE_NOOP(
              "QObject", "PSD pattern length is invalid"));
        }
        GeneratedPatternOwner placeholder{
            tracked_live_budget.reserve_product(1U, 4U), {}};
        placeholder.resource.id = id;
        placeholder.resource.name =
            resource != nullptr && !resource->name.empty() ? resource->name : id;
        placeholder.resource.tile = PixelBuffer(1, 1, PixelFormat::rgba8());
        placeholder.resource.provenance = PatternProvenance::Authored;
        generated_patterns.push_back(std::move(placeholder));
        patterns_to_write.push_back(generated_patterns.back().resource);
      }
      if (!patterns_to_write.empty()) {
        std::sort(patterns_to_write.begin(), patterns_to_write.end(),
                  [](const PatternResource& lhs, const PatternResource& rhs) { return lhs.id < rhs.id; });
        const auto payload = serialize_patterns_block_tracked(
            patterns_to_write, tracked_live_budget);
        if (!payload.bytes.empty()) {
          emit_global_payload("Patt", payload.bytes, false);
        }
      }
    }
  }

  SaveOutputBudgetTracker output_budget(options);
  BigEndianWriter writer(&SaveOutputBudgetTracker::before_write, &output_budget);
  write_header(writer, Header{options.large_document,
                              static_cast<std::uint16_t>(3U + extra_channels.size()),
                              static_cast<std::uint32_t>(document.height()),
                              static_cast<std::uint32_t>(document.width()),
                              8,
                              kColorModeRgb});
  writer.write_u32(0);
  {
    const auto image_resources = image_resources_for_document(
        document, channel_info, tracked_live_budget);
    write_length_prefixed_block(writer, image_resources.bytes);
  }
  if (options.large_document) {
    writer.write_u64(layer_mask.bytes().size());
    writer.write_bytes(layer_mask.bytes());
  } else {
    write_length_prefixed_block(writer, layer_mask.bytes());
  }
  if (!extra_channels.empty()) {
    write_rgb8_image_data_with_extra_channels(writer, composite.rgb, extra_channels,
                                              options.large_document,
                                              tracked_live_budget);
  } else {
    write_rgb8_image_data(writer, composite.rgb, options.large_document,
                          tracked_live_budget);
  }
  auto bytes = std::move(writer).take_bytes();
  report_save_progress(options, SavePhase::Complete, bytes.size());
  return bytes;
}

}  // namespace

std::vector<std::uint8_t> DocumentIo::write_layered_rgb8(const Document& document,
                                                          WriteOptions options) {
  reset_save_usage(options.usage);
  report_save_progress(options, SavePhase::Started);
  check_write_dimensions(document, options.large_document);
  preflight_save(document, options, true);
  SaveLiveBudgetTracker tracked_live_budget(
      options.budget.max_tracked_live_bytes,
      options.usage != nullptr ? &options.usage->tracked_live_bytes : nullptr,
      options.usage != nullptr
          ? &options.usage->tracked_live_bytes_high_water
          : nullptr);
  try {
    return write_layered_rgb8_impl(document, options, tracked_live_budget);
  } catch (const SaveLiveBudgetSignal&) {
    throw SaveBudgetExceeded(SaveBudgetDimension::TrackedLiveBytes);
  }
}

void DocumentIo::write_layered_rgb8_file(const Document& document, const std::filesystem::path& path,
                                         WriteOptions options) {
  const auto bytes = write_layered_rgb8(document, options);
  write_file_bytes(path, bytes);
}

}  // namespace patchy::psd
