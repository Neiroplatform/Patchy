#include "engine/document_session.hpp"

#include "formats/document_flatten.hpp"
#include "core/layer_metadata.hpp"
#include "core/layer_render_utils.hpp"
#include "core/smart_object.hpp"
#include "core/vector_raster.hpp"
#include "psd/psd_document_io.hpp"
#include "psd/psd_filter_effects.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <exception>
#include <iterator>
#include <type_traits>
#include <utility>

namespace patchy::engine {

namespace {

constexpr auto kTileSeamOffsetMetadataKey = "patchy.tile.seamOffset";

SessionError make_error(SessionErrorCode code, std::string message) {
  return SessionError{code, std::move(message)};
}

bool pixel_buffers_equal(const PixelBuffer &left, const PixelBuffer &right) {
  return left.width() == right.width() && left.height() == right.height() &&
         left.format() == right.format() &&
         std::equal(left.data().begin(), left.data().end(),
                    right.data().begin(), right.data().end());
}

bool rects_equal(Rect left, Rect right) {
  return left.x == right.x && left.y == right.y &&
         left.width == right.width && left.height == right.height;
}

bool rect_lists_equal(const std::vector<Rect> &left,
                      const std::vector<Rect> &right) {
  return left.size() == right.size() &&
         std::equal(left.begin(), left.end(), right.begin(),
                    [](Rect first, Rect second) {
                      return rects_equal(first, second);
                    });
}

bool selection_snapshots_equal(const SelectionSnapshot &left,
                               const SelectionSnapshot &right) {
  if (!rect_lists_equal(left.selection, right.selection) ||
      !rect_lists_equal(left.display_region, right.display_region) ||
      !rects_equal(left.mask_bounds, right.mask_bounds) ||
      !pixel_buffers_equal(left.mask_alpha, right.mask_alpha) ||
      left.quick_mask_pixels.has_value() !=
          right.quick_mask_pixels.has_value()) {
    return false;
  }
  return !left.quick_mask_pixels.has_value() ||
         pixel_buffers_equal(*left.quick_mask_pixels,
                             *right.quick_mask_pixels);
}

bool adjustment_settings_equal(const AdjustmentSettings &left,
                               const AdjustmentSettings &right) {
  if (left.kind != right.kind) {
    return false;
  }
  const auto records_equal = [](const LevelsRecord &first,
                                const LevelsRecord &second) {
    return first.black_input == second.black_input &&
           first.white_input == second.white_input &&
           first.gamma_percent == second.gamma_percent &&
           first.black_output == second.black_output &&
           first.white_output == second.white_output;
  };
  const auto levels_equal = [&records_equal](const LevelsAdjustment &first,
                                              const LevelsAdjustment &second) {
    return first.channel == second.channel &&
           records_equal(levels_master_record(first),
                         levels_master_record(second)) &&
           records_equal(first.red, second.red) &&
           records_equal(first.green, second.green) &&
           records_equal(first.blue, second.blue);
  };
  switch (left.kind) {
  case AdjustmentKind::Levels:
    return levels_equal(left.levels, right.levels);
  case AdjustmentKind::Curves:
    return left.curves == right.curves;
  case AdjustmentKind::HueSaturation:
    return left.hue_saturation.hue_shift ==
               right.hue_saturation.hue_shift &&
           left.hue_saturation.saturation_delta ==
               right.hue_saturation.saturation_delta &&
           left.hue_saturation.lightness_delta ==
               right.hue_saturation.lightness_delta &&
           left.hue_saturation.colorize == right.hue_saturation.colorize &&
           left.hue_saturation.colorize_hue ==
               right.hue_saturation.colorize_hue &&
           left.hue_saturation.colorize_saturation ==
               right.hue_saturation.colorize_saturation &&
           left.hue_saturation.colorize_lightness ==
               right.hue_saturation.colorize_lightness &&
           left.hue_saturation.bands == right.hue_saturation.bands;
  case AdjustmentKind::ColorBalance:
    return left.color_balance.cyan_red == right.color_balance.cyan_red &&
           left.color_balance.magenta_green ==
               right.color_balance.magenta_green &&
           left.color_balance.yellow_blue == right.color_balance.yellow_blue;
  case AdjustmentKind::Invert:
    return true;
  case AdjustmentKind::Posterize:
    return left.posterize.levels == right.posterize.levels;
  case AdjustmentKind::Threshold:
    return left.threshold.level == right.threshold.level;
  case AdjustmentKind::BrightnessContrast:
    return left.brightness_contrast.brightness ==
               right.brightness_contrast.brightness &&
           left.brightness_contrast.contrast ==
               right.brightness_contrast.contrast &&
           left.brightness_contrast.use_legacy ==
               right.brightness_contrast.use_legacy;
  }
  return false;
}

std::optional<AdjustmentSettings>
normalized_adjustment_settings(const AdjustmentSettings &settings) {
  Layer scratch(1, "Adjustment", LayerKind::Adjustment);
  configure_adjustment_layer(scratch, settings);
  return adjustment_settings_from_layer(scratch);
}

bool valid_adjustment_mask(const LayerMask &mask, const Document &document) {
  return mask.bounds.width > 0 && mask.bounds.height > 0 &&
         mask.bounds.x >= 0 && mask.bounds.y >= 0 &&
         mask.bounds.x <= document.width() - mask.bounds.width &&
         mask.bounds.y <= document.height() - mask.bounds.height &&
         mask.pixels.format() == PixelFormat::gray8() &&
         mask.pixels.width() == mask.bounds.width &&
         mask.pixels.height() == mask.bounds.height;
}

bool smart_filter_stacks_equal(const SmartFilterStack &left,
                               const SmartFilterStack &right) {
  const auto entries_equal = [](const SmartFilterEntry &first,
                                const SmartFilterEntry &second) {
    return first.kind == second.kind &&
           first.native_name == second.native_name &&
           first.native_class_id == second.native_class_id &&
           first.native_filter_id == second.native_filter_id &&
           first.enabled == second.enabled &&
           first.has_options == second.has_options &&
           first.opacity == second.opacity &&
           first.blend_mode == second.blend_mode &&
           first.foreground == second.foreground &&
           first.background == second.background &&
           first.parameters == second.parameters;
  };
  return left.enabled == right.enabled &&
         left.valid_at_position == right.valid_at_position &&
         left.support == right.support &&
         left.entries.size() == right.entries.size() &&
         std::equal(left.entries.begin(), left.entries.end(),
                    right.entries.begin(), entries_equal) &&
         rects_equal(left.mask.bounds, right.mask.bounds) &&
         pixel_buffers_equal(left.mask.pixels, right.mask.pixels) &&
         left.mask.default_color == right.mask.default_color &&
         left.mask.enabled == right.mask.enabled &&
         left.mask.linked == right.mask.linked &&
         left.mask.extend_with_white == right.mask.extend_with_white;
}

bool smart_filter_effects_equal(const SmartFilterEffectsStore &left,
                                const SmartFilterEffectsStore &right) {
  const auto bytes_equal = [](const auto &first, const auto &second) {
    return first == second ||
           (first != nullptr && second != nullptr && *first == *second);
  };
  const auto masks_equal = [&bytes_equal](const auto &first,
                                          const auto &second) {
    return rects_equal(first.bounds, second.bounds) &&
           bytes_equal(first.samples, second.samples);
  };
  const auto records_equal = [&bytes_equal, &masks_equal](
                                 const SmartFilterEffectsRecord &first,
                                 const SmartFilterEffectsRecord &second) {
    const bool mask_equal =
        first.mask.has_value() == second.mask.has_value() &&
        (!first.mask.has_value() || masks_equal(*first.mask, *second.mask));
    return first.source_block_key == second.source_block_key &&
           first.source_block_version == second.source_block_version &&
           first.source_long_length == second.source_long_length &&
           first.placed_uuid == second.placed_uuid &&
           first.original_placed_uuid == second.original_placed_uuid &&
           first.record_version == second.record_version &&
           bytes_equal(first.raw_storage, second.raw_storage) &&
           first.raw_body_offset == second.raw_body_offset &&
           first.raw_body_length == second.raw_body_length &&
           rects_equal(first.cache_bounds, second.cache_bounds) &&
           first.cache_depth == second.cache_depth &&
           first.cache_max_channels == second.cache_max_channels &&
           first.cache_layout_valid == second.cache_layout_valid &&
           first.mask_present == second.mask_present &&
           first.mask_decoded == second.mask_decoded && mask_equal &&
           first.data_supported == second.data_supported &&
           first.association_unique == second.association_unique;
  };
  const auto blocks_equal = [&bytes_equal, &records_equal](
                                const SmartFilterEffectsBlock &first,
                                const SmartFilterEffectsBlock &second) {
    return first.key == second.key &&
           first.long_length == second.long_length &&
           first.original_global_index == second.original_global_index &&
           first.version == second.version &&
           first.opaque == second.opaque &&
           bytes_equal(first.original_payload, second.original_payload) &&
           first.records.size() == second.records.size() &&
           std::equal(first.records.begin(), first.records.end(),
                      second.records.begin(), records_equal);
  };
  return left.blocks.size() == right.blocks.size() &&
         std::equal(left.blocks.begin(), left.blocks.end(),
                    right.blocks.begin(), blocks_equal);
}

using SelectionIntervals =
    std::vector<std::pair<std::int32_t, std::int32_t>>;
using SelectionRows = std::vector<SelectionIntervals>;

void normalize_intervals(SelectionIntervals &intervals) {
  std::sort(intervals.begin(), intervals.end());
  SelectionIntervals merged;
  for (const auto interval : intervals) {
    if (interval.first >= interval.second) {
      continue;
    }
    if (merged.empty() || interval.first > merged.back().second) {
      merged.push_back(interval);
    } else {
      merged.back().second = std::max(merged.back().second, interval.second);
    }
  }
  intervals = std::move(merged);
}

SelectionRows selection_rows(const std::vector<Rect> &rects,
                             std::int32_t width, std::int32_t height) {
  SelectionRows rows(static_cast<std::size_t>(height));
  for (const auto rect : rects) {
    const auto clipped = intersect_rect(rect, Rect::from_size(width, height));
    for (auto y = clipped.y; y < clipped.y + clipped.height; ++y) {
      rows[static_cast<std::size_t>(y)].emplace_back(
          clipped.x, clipped.x + clipped.width);
    }
  }
  for (auto &row : rows) {
    normalize_intervals(row);
  }
  return rows;
}

std::vector<Rect> rects_from_rows(const SelectionRows &rows) {
  std::vector<Rect> result;
  SelectionIntervals previous;
  std::int32_t run_start = 0;
  const auto flush = [&result, &previous, &run_start](std::int32_t y) {
    for (const auto [x0, x1] : previous) {
      result.push_back(Rect{x0, run_start, x1 - x0, y - run_start});
    }
  };
  for (std::int32_t y = 0; y < static_cast<std::int32_t>(rows.size()); ++y) {
    const auto &current = rows[static_cast<std::size_t>(y)];
    if (current != previous) {
      flush(y);
      previous = current;
      run_start = y;
    }
  }
  flush(static_cast<std::int32_t>(rows.size()));
  return result;
}

std::vector<Rect> invert_rect_selection(const std::vector<Rect> &selection,
                                        std::int32_t width,
                                        std::int32_t height) {
  auto rows = selection_rows(selection, width, height);
  for (auto &row : rows) {
    SelectionIntervals inverted;
    std::int32_t cursor = 0;
    for (const auto [start, end] : row) {
      if (start > cursor) {
        inverted.emplace_back(cursor, start);
      }
      cursor = end;
    }
    if (cursor < width) {
      inverted.emplace_back(cursor, width);
    }
    row = std::move(inverted);
  }
  return rects_from_rows(rows);
}

SelectionIntervals intersect_intervals(const SelectionIntervals &left,
                                       const SelectionIntervals &right) {
  SelectionIntervals result;
  std::size_t left_index = 0;
  std::size_t right_index = 0;
  while (left_index < left.size() && right_index < right.size()) {
    const auto start =
        std::max(left[left_index].first, right[right_index].first);
    const auto end =
        std::min(left[left_index].second, right[right_index].second);
    if (start < end) {
      result.emplace_back(start, end);
    }
    if (left[left_index].second < right[right_index].second) {
      ++left_index;
    } else {
      ++right_index;
    }
  }
  return result;
}

SelectionRows dilate_selection(const std::vector<Rect> &selection,
                               std::int32_t width, std::int32_t height,
                               std::int32_t pixels) {
  SelectionRows rows(static_cast<std::size_t>(height));
  for (const auto rect : selection) {
    const auto expanded = intersect_rect(
        Rect{rect.x - pixels, rect.y - pixels, rect.width + pixels * 2,
             rect.height + pixels * 2},
        Rect::from_size(width, height));
    for (auto y = expanded.y; y < expanded.y + expanded.height; ++y) {
      rows[static_cast<std::size_t>(y)].emplace_back(
          expanded.x, expanded.x + expanded.width);
    }
  }
  for (auto &row : rows) {
    normalize_intervals(row);
  }
  return rows;
}

SelectionRows erode_selection(const std::vector<Rect> &selection,
                              std::int32_t width, std::int32_t height,
                              std::int32_t pixels) {
  auto source = selection_rows(selection, width, height);
  for (auto &row : source) {
    for (auto &interval : row) {
      interval.first += pixels;
      interval.second -= pixels;
    }
    normalize_intervals(row);
  }
  SelectionRows eroded(static_cast<std::size_t>(height));
  for (std::int32_t y = pixels; y < height - pixels; ++y) {
    auto row = source[static_cast<std::size_t>(y - pixels)];
    for (auto sample_y = y - pixels + 1; sample_y <= y + pixels && !row.empty();
         ++sample_y) {
      row = intersect_intervals(
          row, source[static_cast<std::size_t>(sample_y)]);
    }
    eroded[static_cast<std::size_t>(y)] = std::move(row);
  }
  return eroded;
}

SelectionRows subtract_rows(const SelectionRows &left,
                            const SelectionRows &right) {
  SelectionRows result(left.size());
  for (std::size_t y = 0; y < left.size(); ++y) {
    for (const auto [left_start, left_end] : left[y]) {
      auto cursor = left_start;
      for (const auto [right_start, right_end] : right[y]) {
        if (right_end <= cursor || right_start >= left_end) {
          continue;
        }
        if (right_start > cursor) {
          result[y].emplace_back(cursor, std::min(right_start, left_end));
        }
        cursor = std::max(cursor, right_end);
        if (cursor >= left_end) {
          break;
        }
      }
      if (cursor < left_end) {
        result[y].emplace_back(cursor, left_end);
      }
    }
  }
  return result;
}

std::vector<Rect> rects_from_gray_mask(const PixelBuffer &mask, Rect bounds,
                                       std::uint8_t minimum_alpha) {
  SelectionRows rows(static_cast<std::size_t>(mask.height()));
  for (std::int32_t y = 0; y < mask.height(); ++y) {
    const auto source = mask.row(y);
    auto &intervals = rows[static_cast<std::size_t>(y)];
    std::int32_t start = -1;
    for (std::int32_t x = 0; x <= mask.width(); ++x) {
      const bool selected =
          x < mask.width() && source[static_cast<std::size_t>(x)] >= minimum_alpha;
      if (selected && start < 0) {
        start = x;
      } else if (!selected && start >= 0) {
        intervals.emplace_back(start, x);
        start = -1;
      }
    }
  }
  auto rects = rects_from_rows(rows);
  for (auto &rect : rects) {
    rect.x += bounds.x;
    rect.y += bounds.y;
  }
  return rects;
}

SelectionSnapshot selection_from_gray_mask(PixelBuffer alpha, Rect bounds) {
  SelectionSnapshot result;
  if (alpha.empty()) {
    return result;
  }
  result.selection = rects_from_gray_mask(alpha, bounds, 1U);
  result.display_region = rects_from_gray_mask(alpha, bounds, 128U);
  const bool partial = std::any_of(alpha.data().begin(), alpha.data().end(),
                                   [](std::uint8_t value) {
                                     return value != 0U && value != 255U;
                                   });
  if (partial && !result.selection.empty()) {
    result.mask_bounds = bounds;
    result.mask_alpha = std::move(alpha);
  }
  return result;
}

std::uint8_t pixel_alpha8(const PixelBuffer &pixels, std::int32_t x,
                          std::int32_t y) {
  const auto format = pixels.format();
  const auto alpha_channel = format.channels == 2 ? 1U : 3U;
  if (format.channels != 2 && format.channels < 4) {
    return 255U;
  }
  const auto channel_bytes = bytes_per_channel(format.bit_depth);
  const auto *source =
      pixels.pixel(x, y) + static_cast<std::size_t>(alpha_channel) * channel_bytes;
  if (format.bit_depth == BitDepth::UInt8) {
    return source[0];
  }
  if (format.bit_depth == BitDepth::UInt16) {
    std::uint16_t value = 0;
    std::memcpy(&value, source, sizeof(value));
    return static_cast<std::uint8_t>(
        (static_cast<std::uint32_t>(value) + 128U) / 257U);
  }
  float value = 0.0F;
  std::memcpy(&value, source, sizeof(value));
  return static_cast<std::uint8_t>(
      std::lround(std::clamp(value, 0.0F, 1.0F) * 255.0F));
}

PixelBuffer materialize_selection_alpha(const SelectionSnapshot &selection,
                                        std::int32_t width,
                                        std::int32_t height) {
  PixelBuffer alpha(width, height, PixelFormat::gray8());
  if (!selection.mask_alpha.empty() &&
      selection.mask_alpha.format() == PixelFormat::gray8()) {
    const auto copy = intersect_rect(selection.mask_bounds,
                                     Rect::from_size(width, height));
    for (std::int32_t y = 0; y < copy.height; ++y) {
      std::copy_n(selection.mask_alpha.pixel(
                      copy.x - selection.mask_bounds.x,
                      copy.y + y - selection.mask_bounds.y),
                  copy.width, alpha.pixel(copy.x, copy.y + y));
    }
    return alpha;
  }
  for (const auto rect : selection.selection) {
    const auto clipped = intersect_rect(rect, Rect::from_size(width, height));
    for (std::int32_t y = 0; y < clipped.height; ++y) {
      std::fill_n(alpha.pixel(clipped.x, clipped.y + y), clipped.width, 255U);
    }
  }
  return alpha;
}

void blur_selection_alpha(PixelBuffer &coverage, double feather) {
  if (feather <= 0.0 || coverage.empty()) {
    return;
  }
  const auto radius =
      std::max(1, static_cast<std::int32_t>(std::lround(feather * 0.5)));
  PixelBuffer scratch(coverage.width(), coverage.height(), PixelFormat::gray8());
  for (int pass = 0; pass < 3; ++pass) {
    for (std::int32_t y = 0; y < coverage.height(); ++y) {
      std::int32_t sum = 0;
      std::int32_t count = 0;
      for (std::int32_t x = -radius; x <= radius; ++x) {
        if (x >= 0 && x < coverage.width()) {
          sum += *coverage.pixel(x, y);
          ++count;
        }
      }
      for (std::int32_t x = 0; x < coverage.width(); ++x) {
        *scratch.pixel(x, y) =
            static_cast<std::uint8_t>(sum / std::max(1, count));
        const auto add_x = x + radius + 1;
        const auto remove_x = x - radius;
        if (add_x < coverage.width()) {
          sum += *coverage.pixel(add_x, y);
          ++count;
        }
        if (remove_x >= 0) {
          sum -= *coverage.pixel(remove_x, y);
          --count;
        }
      }
    }
    for (std::int32_t x = 0; x < coverage.width(); ++x) {
      std::int32_t sum = 0;
      std::int32_t count = 0;
      for (std::int32_t y = -radius; y <= radius; ++y) {
        if (y >= 0 && y < coverage.height()) {
          sum += *scratch.pixel(x, y);
          ++count;
        }
      }
      for (std::int32_t y = 0; y < coverage.height(); ++y) {
        *coverage.pixel(x, y) =
            static_cast<std::uint8_t>(sum / std::max(1, count));
        const auto add_y = y + radius + 1;
        const auto remove_y = y - radius;
        if (add_y < coverage.height()) {
          sum += *scratch.pixel(x, add_y);
          ++count;
        }
        if (remove_y >= 0) {
          sum -= *scratch.pixel(x, remove_y);
          --count;
        }
      }
    }
  }
}

void restore_pixels_outside_rect_selection(
    PixelBuffer &filtered, const PixelBuffer &original, Rect bounds,
    const std::vector<Rect> &selection) {
  if (selection.empty()) {
    return;
  }
  if (filtered.width() != original.width() ||
      filtered.height() != original.height() ||
      filtered.format() != original.format()) {
    throw std::invalid_argument(
        "selection-limited filters cannot expand layer bounds");
  }
  auto selected_pixels = std::move(filtered);
  filtered = original;
  const auto pixel_bytes = bytes_per_pixel(filtered.format());
  const auto layer_bounds = Rect{bounds.x, bounds.y, filtered.width(),
                                 filtered.height()};
  for (const auto &rect : selection) {
    const auto clipped = intersect_rect(rect, layer_bounds);
    if (clipped.empty()) {
      continue;
    }
    const auto local_x = clipped.x - bounds.x;
    const auto local_y = clipped.y - bounds.y;
    const auto row_bytes = static_cast<std::size_t>(clipped.width) * pixel_bytes;
    for (std::int32_t row = 0; row < clipped.height; ++row) {
      const auto *source = selected_pixels.pixel(local_x, local_y + row);
      auto *destination = filtered.pixel(local_x, local_y + row);
      std::copy_n(source, row_bytes, destination);
    }
  }
}

void insert_layer_after_anchor(Document &document, Layer layer,
                               std::optional<LayerId> anchor_id) {
  if (anchor_id.has_value()) {
    if (auto location = find_layer_location(document.layers(), *anchor_id);
        location.has_value() && location->siblings != nullptr) {
      location->siblings->insert(
          location->siblings->begin() +
              static_cast<std::ptrdiff_t>(location->index + 1U),
          std::move(layer));
      return;
    }
  }
  document.add_layer(std::move(layer));
}

struct GroupingDestination {
  std::vector<Layer> *siblings{nullptr};
  std::size_t insert_index{0};
};

std::optional<GroupingDestination>
grouping_destination(std::vector<Layer> &layers,
                     const std::vector<LayerId> &ids) {
  if (ids.empty()) {
    return std::nullopt;
  }
  std::vector<LayerSiblingLocation> locations;
  std::vector<Layer> *siblings = nullptr;
  for (const auto id : ids) {
    auto location = find_layer_location(layers, id);
    if (!location.has_value() || location->siblings == nullptr ||
        (siblings != nullptr && siblings != location->siblings)) {
      return std::nullopt;
    }
    siblings = location->siblings;
    locations.push_back(*location);
  }
  const auto topmost = std::max_element(
      locations.begin(), locations.end(),
      [](const auto &left, const auto &right) { return left.index < right.index; });
  const auto moved_below = std::count_if(
      locations.begin(), locations.end(),
      [topmost](const auto &location) { return location.index < topmost->index; });
  return GroupingDestination{
      siblings, topmost->index - static_cast<std::size_t>(moved_below)};
}

} // namespace

DocumentSession::DocumentSession(Document document)
    : document_(std::move(document)) {
  register_builtin_filters(filter_registry_);
}

std::size_t SelectionSnapshot::retained_bytes() const noexcept {
  return selection.capacity() * sizeof(Rect) +
         display_region.capacity() * sizeof(Rect) + mask_alpha.data().size() +
         (quick_mask_pixels.has_value()
              ? quick_mask_pixels->data().size()
              : 0U);
}

OpenResult open_psd(std::span<const std::uint8_t> bytes) {
  try {
    return OpenResult{
        std::make_unique<DocumentSession>(psd::DocumentIo::read(bytes)), {}};
  } catch (const std::exception &exception) {
    return OpenResult{
        {}, make_error(SessionErrorCode::DecodeFailed, exception.what())};
  }
}

void DocumentSession::push_undo_state() {
  undo_stack_.push_back(HistoryState{document_, selection_, state_id_});
  if (undo_stack_.size() > kMaxUndoStates) {
    undo_stack_.erase(undo_stack_.begin());
  }
  redo_stack_.clear();
}

void DocumentSession::prepare_mutation(bool record_history) {
  if (record_history) {
    push_undo_state();
  } else {
    redo_stack_.clear();
  }
}

void DocumentSession::publish(SessionEventKind kind, LayerId layer_id) {
  if (event_sink_) {
    event_sink_(SessionEvent{kind, revision_, state_id_, dirty(), layer_id});
  }
}

CommandResult DocumentSession::execute(const DocumentCommand &command,
                                       const FilterProgress *filter_progress) {
  return execute_impl(command, true, filter_progress);
}

CommandResult
DocumentSession::execute_external(const DocumentCommand &command,
                                  const FilterProgress *filter_progress) {
  return execute_impl(command, false, filter_progress);
}

CommandResult DocumentSession::execute_impl(const DocumentCommand &command,
                                            bool record_history,
                                            const FilterProgress *filter_progress) {
  LayerId layer_id = 0;
  bool changed = false;
  bool affects_document = true;
  SessionError error{};
  std::optional<Rect> affected_region;
  SessionEventKind event_kind = SessionEventKind::CommandApplied;

  try {
    std::visit(
        [this, record_history, filter_progress, &layer_id, &changed,
         &affects_document, &error, &affected_region,
         &event_kind](const auto &concrete) {
          using Command = std::decay_t<decltype(concrete)>;
          if constexpr (std::is_same_v<Command, CropDocument>) {
            if (concrete.crop.width <= 0 || concrete.crop.height <= 0 ||
                !std::isfinite(concrete.clockwise_degrees)) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "crop rectangle and angle must be valid");
              return;
            }
            auto crop = concrete.crop;
            if (concrete.clip_to_canvas) {
              crop = intersect_rect(
                  crop, Rect::from_size(document_.width(), document_.height()));
              if (crop.empty()) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "crop rectangle is outside the canvas");
                return;
              }
            }
            if (crop.x == 0 && crop.y == 0 &&
                crop.width == document_.width() &&
                crop.height == document_.height() &&
                std::abs(concrete.clockwise_degrees) < 0.01) {
              return;
            }
            auto cropped_document = document_;
            if (!crop_document(cropped_document, crop,
                               concrete.clockwise_degrees,
                               concrete.extension_color)) {
              error = make_error(SessionErrorCode::CommandFailed,
                                 "document crop failed");
              return;
            }
            prepare_mutation(record_history);
            document_ = std::move(cropped_document);
            selection_ = {};
            affected_region =
                Rect::from_size(document_.width(), document_.height());
            changed = true;
            return;
          } else if constexpr (std::is_same_v<Command,
                                               WrapOffsetDocument>) {
            if (concrete.dx == 0 && concrete.dy == 0) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "wrap offset must move the document");
              return;
            }
            auto shifted_document = document_;
            wrap_offset_document(shifted_document, concrete.dx, concrete.dy);
            auto &metadata = shifted_document.metadata().values;
            if (concrete.seam_offset_metadata.has_value()) {
              metadata[kTileSeamOffsetMetadataKey] =
                  *concrete.seam_offset_metadata;
            } else {
              metadata.erase(kTileSeamOffsetMetadataKey);
            }
            prepare_mutation(record_history);
            document_ = std::move(shifted_document);
            selection_ = {};
            affected_region =
                Rect::from_size(document_.width(), document_.height());
            changed = true;
            return;
          } else if constexpr (std::is_same_v<Command, RotateCanvas>) {
            if (!std::isfinite(concrete.clockwise_degrees)) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "rotation must be finite");
              return;
            }
            const auto normalized = std::fmod(concrete.clockwise_degrees, 360.0);
            if (std::abs(normalized) < 0.01) {
              return;
            }
            auto rotated_document = document_;
            if (std::abs(normalized - 90.0) < 0.01 ||
                std::abs(normalized + 270.0) < 0.01) {
              rotate_document_clockwise(rotated_document);
            } else if (std::abs(normalized + 90.0) < 0.01 ||
                       std::abs(normalized - 270.0) < 0.01) {
              rotate_document_counterclockwise(rotated_document);
            } else if (!rotate_document_arbitrary(rotated_document, normalized,
                                                   concrete.extension_color)) {
              error = make_error(SessionErrorCode::CommandFailed,
                                 "document rotation failed");
              return;
            }
            prepare_mutation(record_history);
            document_ = std::move(rotated_document);
            selection_ = {};
            changed = true;
            return;
          } else if constexpr (std::is_same_v<Command, ResizeImage> ||
                               std::is_same_v<Command, ResizeCanvas>) {
            if (concrete.width <= 0 || concrete.height <= 0) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "document dimensions must be positive");
              return;
            }
            if (concrete.width == document_.width() &&
                concrete.height == document_.height()) {
              return;
            }
            auto resized_document = document_;
            if constexpr (std::is_same_v<Command, ResizeImage>) {
              resize_image_and_layers(resized_document, concrete.width,
                                      concrete.height);
            } else {
              resize_canvas_and_layers(resized_document, concrete.width,
                                       concrete.height, concrete.anchor,
                                       concrete.extension_color);
            }
            prepare_mutation(record_history);
            document_ = std::move(resized_document);
            selection_ = {};
            changed = true;
            return;
          } else if constexpr (std::is_same_v<Command, AddPixelLayer> ||
                               std::is_same_v<Command, AddAdjustmentLayer> ||
                               std::is_same_v<Command, AddGroup>) {
            auto added_document = document_;
            if constexpr (std::is_same_v<Command, AddPixelLayer>) {
              layer_id = added_document.allocate_layer_id();
              insert_layer_after_anchor(
                  added_document,
                  Layer(layer_id, concrete.name, concrete.pixels),
                  concrete.anchor_layer_id);
              added_document.set_active_layer(layer_id);
            } else if constexpr (std::is_same_v<Command,
                                                AddAdjustmentLayer>) {
              if (concrete.name.empty() ||
                  (concrete.mask.has_value() &&
                   !valid_adjustment_mask(*concrete.mask, document_)) ||
                  !normalized_adjustment_settings(concrete.settings)
                       .has_value()) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "adjustment layer state is invalid");
                return;
              }
              layer_id = added_document.allocate_layer_id();
              Layer layer(layer_id, concrete.name, LayerKind::Adjustment);
              layer.set_bounds(Rect::from_size(added_document.width(),
                                               added_document.height()));
              configure_adjustment_layer(layer, concrete.settings);
              if (concrete.mask.has_value()) {
                layer.set_mask(*concrete.mask);
              }
              added_document.add_layer(std::move(layer));
              affected_region = Rect::from_size(added_document.width(),
                                                added_document.height());
            } else {
              const auto roots = root_drop_layer_ids(
                  added_document.layers(),
                  concrete.grouped_layer_ids_top_to_bottom);
              const auto destination =
                  grouping_destination(added_document.layers(), roots);
              if (!roots.empty() && !destination.has_value()) {
                error = make_error(
                    SessionErrorCode::InvalidArgument,
                    "grouped layers must exist in one sibling list");
                return;
              }
              layer_id = added_document.allocate_layer_id();
              Layer group(layer_id, concrete.name, LayerKind::Group);
              group.set_blend_mode(BlendMode::PassThrough);
              std::vector<Layer> grouped_top_to_bottom;
              for (const auto id : roots) {
                auto grouped = take_layer_from_tree(added_document.layers(), id);
                if (grouped.has_value()) {
                  grouped_top_to_bottom.push_back(std::move(*grouped));
                }
              }
              for (auto it = grouped_top_to_bottom.rbegin();
                   it != grouped_top_to_bottom.rend(); ++it) {
                group.add_child(std::move(*it));
              }
              if (destination.has_value()) {
                destination->siblings->insert(
                    destination->siblings->begin() +
                        static_cast<std::ptrdiff_t>(destination->insert_index),
                    std::move(group));
              } else {
                added_document.add_layer(std::move(group));
              }
              added_document.set_active_layer(layer_id);
            }
            prepare_mutation(record_history);
            document_ = std::move(added_document);
            changed = true;
            return;
          } else if constexpr (std::is_same_v<Command,
                                                UpdateAdjustmentLayer>) {
            const auto *current = document_.find_layer(concrete.layer_id);
            if (current == nullptr) {
              error = make_error(SessionErrorCode::LayerNotFound,
                                 "adjustment layer does not exist");
              return;
            }
            if (current->kind() != LayerKind::Adjustment) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "target is not an adjustment layer");
              return;
            }
            const auto normalized =
                normalized_adjustment_settings(concrete.settings);
            if (!normalized.has_value()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "adjustment settings are invalid");
              return;
            }
            const auto existing = adjustment_settings_from_layer(*current);
            if (existing.has_value() &&
                adjustment_settings_equal(*existing, *normalized)) {
              return;
            }
            auto updated_document = document_;
            configure_adjustment_layer(
                *updated_document.find_layer(concrete.layer_id), *normalized);
            prepare_mutation(record_history);
            document_ = std::move(updated_document);
            changed = true;
            layer_id = concrete.layer_id;
            affected_region =
                Rect::from_size(document_.width(), document_.height());
            return;
          } else if constexpr (std::is_same_v<Command, UngroupLayers>) {
            if (concrete.group_ids.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "ungroup requires at least one group");
              return;
            }
            auto ungrouped_document = document_;
            std::optional<LayerId> first_released;
            for (const auto id : concrete.group_ids) {
              const auto *group = ungrouped_document.find_layer(id);
              if (group == nullptr || group->kind() != LayerKind::Group) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "ungroup target is not a group");
                return;
              }
              auto released = ungroup_layer(ungrouped_document.layers(), id);
              if (!released.has_value()) {
                error = make_error(SessionErrorCode::CommandFailed,
                                   "could not ungroup layer");
                return;
              }
              if (!first_released.has_value() && !released->empty()) {
                first_released = released->front();
              }
            }
            if (first_released.has_value()) {
              ungrouped_document.set_active_layer(*first_released);
              layer_id = *first_released;
            }
            prepare_mutation(record_history);
            document_ = std::move(ungrouped_document);
            changed = true;
            return;
          } else if constexpr (std::is_same_v<Command, FlipLayers>) {
            if (concrete.layer_ids.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "flip requires at least one layer");
              return;
            }
            auto flipped_document = document_;
            Rect affected{};
            for (const auto id : concrete.layer_ids) {
              if (flipped_document.find_layer(id) == nullptr) {
                error = make_error(SessionErrorCode::LayerNotFound,
                                   "flipped layer does not exist");
                return;
              }
              const auto current = concrete.axis == FlipAxis::Horizontal
                                       ? flip_layer_horizontal(flipped_document, id)
                                       : flip_layer_vertical(flipped_document, id);
              affected = unite_rect(affected, current);
            }
            prepare_mutation(record_history);
            document_ = std::move(flipped_document);
            changed = true;
            layer_id = concrete.layer_ids.front();
            affected_region = affected;
            return;
          } else if constexpr (std::is_same_v<Command, RemoveLayers>) {
            if (concrete.layer_ids.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "remove requires at least one layer");
              return;
            }
            for (const auto id : concrete.layer_ids) {
              if (document_.find_layer(id) == nullptr) {
                error = make_error(SessionErrorCode::LayerNotFound,
                                   "removed layer does not exist");
                return;
              }
            }
            auto removed_document = document_;
            const auto roots = root_drop_layer_ids(removed_document.layers(),
                                                   concrete.layer_ids);
            for (const auto id : roots) {
              (void)removed_document.remove_layer(id);
            }
            prepare_mutation(record_history);
            document_ = std::move(removed_document);
            changed = true;
            layer_id = roots.front();
            return;
          } else if constexpr (std::is_same_v<Command, MoveLayers>) {
            if (concrete.layer_ids_top_to_bottom.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "move requires at least one layer");
              return;
            }
            auto moved_document = document_;
            const LayerDropRequest request{concrete.layer_ids_top_to_bottom,
                                           concrete.target_layer_id,
                                           concrete.position, false};
            if (!move_layers_for_drop(moved_document.layers(), request)) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "layer move is not valid");
              return;
            }
            prepare_mutation(record_history);
            document_ = std::move(moved_document);
            changed = true;
            layer_id = concrete.layer_ids_top_to_bottom.front();
            return;
          } else if constexpr (std::is_same_v<Command, PlaceLayers>) {
            if (concrete.layer_ids_bottom_to_top.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "placement requires at least one layer");
              return;
            }
            auto placed_document = document_;
            if (concrete.parent_group_id.has_value()) {
              const auto *parent = placed_document.find_layer(
                  *concrete.parent_group_id);
              if (parent == nullptr || parent->kind() != LayerKind::Group) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "placement parent is not a group");
                return;
              }
              for (const auto id : concrete.layer_ids_bottom_to_top) {
                const auto *source = placed_document.find_layer(id);
                if (source == nullptr || id == *concrete.parent_group_id ||
                    layer_contains_descendant(*source,
                                              *concrete.parent_group_id)) {
                  error = make_error(SessionErrorCode::InvalidArgument,
                                     "placement would create a cycle");
                  return;
                }
              }
            }
            std::vector<Layer> moved;
            moved.reserve(concrete.layer_ids_bottom_to_top.size());
            for (const auto id : concrete.layer_ids_bottom_to_top) {
              auto item = take_layer_from_tree(placed_document.layers(), id);
              if (!item.has_value()) {
                error = make_error(SessionErrorCode::LayerNotFound,
                                   "placed layer does not exist");
                return;
              }
              moved.push_back(std::move(*item));
            }
            auto *siblings = &placed_document.layers();
            if (concrete.parent_group_id.has_value()) {
              siblings = &placed_document
                              .find_layer(*concrete.parent_group_id)
                              ->children();
            }
            if (concrete.index > siblings->size()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "placement index is out of range");
              return;
            }
            siblings->insert(
                siblings->begin() +
                    static_cast<std::ptrdiff_t>(concrete.index),
                std::make_move_iterator(moved.begin()),
                std::make_move_iterator(moved.end()));
            prepare_mutation(record_history);
            document_ = std::move(placed_document);
            changed = true;
            layer_id = concrete.layer_ids_bottom_to_top.front();
            return;
          } else if constexpr (std::is_same_v<Command, ReplaceLayerPixels>) {
            const auto *current = document_.find_layer(concrete.layer_id);
            if (current == nullptr) {
              error = make_error(SessionErrorCode::LayerNotFound,
                                 "pixel target layer does not exist");
              return;
            }
            if (current->kind() == LayerKind::Group) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "group layers do not own editable pixels");
              return;
            }
            if (concrete.bounds.width != concrete.pixels.width() ||
                concrete.bounds.height != concrete.pixels.height()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "pixel bounds do not match the buffer");
              return;
            }
            if (!concrete.rasterize_smart_object &&
                pixel_buffers_equal(current->pixels(), concrete.pixels) &&
                rects_equal(current->bounds(), concrete.bounds)) {
              return;
            }
            const auto old_bounds = layer_render_bounds(*current);
            prepare_mutation(record_history);
            auto *layer = document_.find_layer(concrete.layer_id);
            if (concrete.rasterize_smart_object) {
              strip_layer_smart_object_data(document_, *layer);
            }
            layer->set_pixels(concrete.pixels);
            layer->set_bounds(concrete.bounds);
            changed = true;
            layer_id = concrete.layer_id;
            affected_region = unite_rect(old_bounds, layer_render_bounds(*layer));
            return;
          } else if constexpr (std::is_same_v<Command, ApplyFilter>) {
            const auto *current = document_.find_layer(concrete.layer_id);
            if (current == nullptr) {
              error = make_error(SessionErrorCode::LayerNotFound,
                                 "filter target layer does not exist");
              return;
            }
            if (current->kind() == LayerKind::Group) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "group layers cannot receive filters");
              return;
            }
            const auto &original = current->pixels();
            if (original.empty() || original.format().bit_depth != BitDepth::UInt8 ||
                original.format().channels < 3) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "filter target must be a non-empty RGB8 layer");
              return;
            }
            const auto invocation = filter_registry_.normalize(concrete.invocation);
            if (!invocation.has_value()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "filter invocation is not supported");
              return;
            }
            const auto old_bounds = current->bounds();
            const auto old_render_bounds = layer_render_bounds(*current);
            FilterRenderResult rendered{original, old_bounds};
            if (concrete.selection.empty()) {
              rendered = filter_registry_.render(*invocation, original,
                                                  old_bounds, true,
                                                  filter_progress);
            } else {
              filter_registry_.apply(*invocation, rendered.pixels,
                                     filter_progress);
              restore_pixels_outside_rect_selection(
                  rendered.pixels, original, old_bounds, concrete.selection);
            }
            if (pixel_buffers_equal(rendered.pixels, original) &&
                rects_equal(rendered.bounds, old_bounds)) {
              return;
            }
            prepare_mutation(record_history);
            auto *layer = document_.find_layer(concrete.layer_id);
            layer->set_pixels(std::move(rendered.pixels));
            layer->set_bounds(rendered.bounds);
            changed = true;
            layer_id = concrete.layer_id;
            affected_region =
                unite_rect(old_render_bounds, layer_render_bounds(*layer));
            return;
          } else if constexpr (std::is_same_v<Command,
                                              SelectByColorSimilarity>) {
            if (concrete.mode != SelectionSimilarityMode::Grow &&
                concrete.mode != SelectionSimilarityMode::Similar) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "color similarity mode is invalid");
              return;
            }
            if (selection_.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "color similarity requires a selection");
              return;
            }
            if (concrete.tolerance < 0 || concrete.tolerance > 255) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "color similarity tolerance must be in [0, 255]");
              return;
            }
            const auto width = document_.width();
            const auto height = document_.height();
            const auto flattened = flatten_document_rgba8(document_);
            std::array<std::int64_t, 4> sum{};
            std::int64_t sample_count = 0;
            for (const auto rect : selection_.selection) {
              const auto clipped =
                  intersect_rect(rect, Rect::from_size(width, height));
              for (std::int32_t y = clipped.y;
                   y < clipped.y + clipped.height; ++y) {
                for (std::int32_t x = clipped.x;
                     x < clipped.x + clipped.width; ++x) {
                  const auto *color = flattened.pixel(x, y);
                  for (std::size_t channel = 0; channel < 4; ++channel) {
                    sum[channel] += color[channel];
                  }
                  ++sample_count;
                }
              }
            }
            if (sample_count == 0) {
              return;
            }
            std::array<std::int32_t, 4> target{};
            for (std::size_t channel = 0; channel < 4; ++channel) {
              target[channel] =
                  static_cast<std::int32_t>(sum[channel] / sample_count);
            }
            const auto tolerance_squared =
                concrete.tolerance * concrete.tolerance * 4;
            const auto matches = [&](std::int32_t x, std::int32_t y) {
              const auto *color = flattened.pixel(x, y);
              std::int32_t distance = 0;
              for (std::size_t channel = 0; channel < 4; ++channel) {
                const auto delta = static_cast<std::int32_t>(color[channel]) -
                                   target[channel];
                distance += delta * delta;
              }
              return distance <= tolerance_squared;
            };
            PixelBuffer alpha(width, height, PixelFormat::gray8());
            if (concrete.mode == SelectionSimilarityMode::Similar) {
              for (std::int32_t y = 0; y < height; ++y) {
                for (std::int32_t x = 0; x < width; ++x) {
                  if (matches(x, y)) {
                    *alpha.pixel(x, y) = 255U;
                  }
                }
              }
            } else {
              std::vector<std::int32_t> queue;
              queue.reserve(std::min<std::size_t>(
                  static_cast<std::size_t>(width) *
                      static_cast<std::size_t>(height),
                  1'000'000U));
              const auto mark = [&](std::int32_t x, std::int32_t y) {
                auto *value = alpha.pixel(x, y);
                if (*value != 0U) {
                  return false;
                }
                *value = 255U;
                queue.push_back(y * width + x);
                return true;
              };
              for (const auto rect : selection_.selection) {
                const auto clipped =
                    intersect_rect(rect, Rect::from_size(width, height));
                for (std::int32_t y = clipped.y;
                     y < clipped.y + clipped.height; ++y) {
                  for (std::int32_t x = clipped.x;
                       x < clipped.x + clipped.width; ++x) {
                    mark(x, y);
                  }
                }
              }
              for (std::size_t offset = 0; offset < queue.size(); ++offset) {
                const auto x = queue[offset] % width;
                const auto y = queue[offset] / width;
                const auto maybe_mark = [&](std::int32_t next_x,
                                            std::int32_t next_y) {
                  if (*alpha.pixel(next_x, next_y) == 0U &&
                      matches(next_x, next_y)) {
                    mark(next_x, next_y);
                  }
                };
                if (x + 1 < width) {
                  maybe_mark(x + 1, y);
                }
                if (x > 0) {
                  maybe_mark(x - 1, y);
                }
                if (y + 1 < height) {
                  maybe_mark(x, y + 1);
                }
                if (y > 0) {
                  maybe_mark(x, y - 1);
                }
              }
            }
            auto modified = selection_from_gray_mask(
                std::move(alpha), Rect::from_size(width, height));
            if (selection_snapshots_equal(selection_, modified)) {
              return;
            }
            prepare_mutation(record_history);
            selection_ = std::move(modified);
            changed = true;
            affects_document = false;
            event_kind = SessionEventKind::SelectionChanged;
            return;
          } else if constexpr (std::is_same_v<Command,
                                                CommitSmartFilterState>) {
            if (concrete.rendered_pixels.empty() ||
                concrete.rendered_bounds.width !=
                    concrete.rendered_pixels.width() ||
                concrete.rendered_bounds.height !=
                    concrete.rendered_pixels.height() ||
                concrete.regenerated_blocks.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "prepared Smart Filter state is incomplete");
              return;
            }
            if (concrete.stack.has_value() &&
                (concrete.stack->support !=
                     SmartFilterStackSupport::Supported ||
                 concrete.stack->entries.empty())) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "prepared Smart Filter stack is unsupported");
              return;
            }
            const auto *current_layer =
                document_.find_layer(concrete.layer_id);
            if (current_layer == nullptr) {
              error = make_error(SessionErrorCode::LayerNotFound,
                                 "Smart Filter layer does not exist");
              return;
            }
            if (!layer_is_smart_object(*current_layer)) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "Smart Filter state requires a Smart Object layer");
              return;
            }
            std::vector<std::size_t> block_indexes;
            block_indexes.reserve(concrete.regenerated_blocks.size());
            for (const auto &[index, payload] : concrete.regenerated_blocks) {
              static_cast<void>(payload);
              block_indexes.push_back(index);
            }
            std::sort(block_indexes.begin(), block_indexes.end(),
                      std::less<>{});
            if (std::adjacent_find(block_indexes.begin(),
                                   block_indexes.end()) !=
                block_indexes.end()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "Smart Filter block indexes must be unique");
              return;
            }
            const auto &current_blocks = current_layer->unknown_psd_blocks();
            for (const auto &[index, payload] : concrete.regenerated_blocks) {
              if (index >= current_blocks.size() ||
                  (current_blocks[index].key != "SoLd" &&
                   current_blocks[index].key != "SoLE") ||
                  payload.empty()) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "prepared Smart Filter block is invalid");
                return;
              }
            }
            const auto *current_stack = current_layer->smart_filter_stack();
            const bool stack_equal =
                current_stack == nullptr
                    ? !concrete.stack.has_value()
                    : concrete.stack.has_value() &&
                          smart_filter_stacks_equal(*current_stack,
                                                   *concrete.stack);
            const bool blocks_equal = std::all_of(
                concrete.regenerated_blocks.begin(),
                concrete.regenerated_blocks.end(),
                [&current_blocks](const auto &replacement) {
                  return current_blocks[replacement.first].payload ==
                         replacement.second;
                });
            if (stack_equal && blocks_equal &&
                smart_filter_effects_equal(
                    document_.metadata().smart_filter_effects,
                    concrete.filter_effects) &&
                rects_equal(current_layer->bounds(),
                            concrete.rendered_bounds) &&
                pixel_buffers_equal(current_layer->pixels(),
                                    concrete.rendered_pixels)) {
              return;
            }
            auto updated_document = document_;
            auto *updated_layer =
                updated_document.find_layer(concrete.layer_id);
            auto &updated_blocks = updated_layer->unknown_psd_blocks();
            for (const auto &[index, payload] : concrete.regenerated_blocks) {
              updated_blocks[index].payload = payload;
            }
            updated_document.metadata().smart_filter_effects =
                concrete.filter_effects;
            if (concrete.stack.has_value()) {
              updated_layer->set_smart_filter_stack(*concrete.stack);
            } else {
              updated_layer->clear_smart_filter_stack();
            }
            updated_layer->set_pixels(concrete.rendered_pixels);
            updated_layer->set_bounds(concrete.rendered_bounds);
            mark_layer_smart_object_block_dirty(*updated_layer);
            updated_layer->metadata()[kLayerMetadataSmartObjectRasterStatus] =
                kSmartObjectRasterStatusPatchy;
            const auto affected = unite_rect(current_layer->bounds(),
                                             updated_layer->bounds());
            prepare_mutation(record_history);
            document_ = std::move(updated_document);
            changed = true;
            layer_id = concrete.layer_id;
            affected_region = affected;
            return;
          } else if constexpr (std::is_same_v<Command,
                                                TransformVectorLayers>) {
            if (concrete.layer_ids.empty() ||
                !std::all_of(concrete.matrix.begin(), concrete.matrix.end(),
                             [](double value) { return std::isfinite(value); }) ||
                !std::isfinite(concrete.stroke_scale) ||
                concrete.stroke_scale <= 0.0 ||
                concrete.stroke_scale > 10000.0) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "vector transform parameters are invalid");
              return;
            }
            auto unique_ids = concrete.layer_ids;
            std::sort(unique_ids.begin(), unique_ids.end());
            if (std::adjacent_find(unique_ids.begin(), unique_ids.end()) !=
                unique_ids.end()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "vector transform layer ids must be unique");
              return;
            }
            for (const auto id : concrete.layer_ids) {
              const auto *candidate = document_.find_layer(id);
              if (candidate == nullptr) {
                error = make_error(SessionErrorCode::LayerNotFound,
                                   "vector transform layer does not exist");
                return;
              }
              const bool supported =
                  concrete.target == VectorTransformTarget::VectorMaskOnly
                      ? candidate->vector_mask() != nullptr
                      : candidate->vector_shape() != nullptr ||
                            candidate->vector_mask() != nullptr;
              if (!supported) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "layer has no requested vector data");
                return;
              }
            }
            const bool identity =
                concrete.matrix ==
                    std::array<double, 6>{1.0, 0.0, 0.0, 1.0, 0.0, 0.0} &&
                concrete.stroke_scale == 1.0;
            if (identity) {
              return;
            }
            Rect affected{};
            const auto canvas =
                Rect::from_size(document_.width(), document_.height());
            for (const auto id : concrete.layer_ids) {
              affected = unite_rect(
                  affected,
                  layer_render_bounds(*document_.find_layer(id)));
            }
            auto transformed_document = document_;
            for (const auto id : concrete.layer_ids) {
              auto *target = transformed_document.find_layer(id);
              if (concrete.target == VectorTransformTarget::VectorMaskOnly) {
                auto mask = *target->vector_mask();
                transform_vector_path(mask.path, concrete.matrix);
                target->set_vector_mask(std::move(mask));
                update_vector_mask_raster(*target, canvas);
                mark_layer_vector_block_dirty(*target);
              } else {
                transform_layer_vector_data(transformed_document, *target,
                                            concrete.matrix, canvas,
                                            concrete.stroke_scale);
              }
              affected = unite_rect(affected, layer_render_bounds(*target));
            }
            prepare_mutation(record_history);
            document_ = std::move(transformed_document);
            changed = true;
            layer_id = concrete.layer_ids.front();
            affected_region = affected;
            return;
          } else if constexpr (std::is_same_v<Command, SelectVectorPath>) {
            if (concrete.combine != SelectionCombineMode::Replace &&
                concrete.combine != SelectionCombineMode::Add &&
                concrete.combine != SelectionCombineMode::Subtract &&
                concrete.combine != SelectionCombineMode::Intersect) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "selection combine mode is invalid");
              return;
            }
            if (concrete.path.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "selection source path is empty");
              return;
            }
            if (!std::isfinite(concrete.feather) || concrete.feather < 0.0 ||
                concrete.feather > 250.0) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "selection feather must be in [0, 250]");
              return;
            }
            const auto canvas =
                Rect::from_size(document_.width(), document_.height());
            const auto rasterized = rasterize_vector_path(
                concrete.path, VectorRasterOptions{.clip = canvas});
            PixelBuffer alpha(canvas.width, canvas.height,
                              PixelFormat::gray8());
            if (!rasterized.pixels.empty()) {
              const auto copy = intersect_rect(rasterized.bounds, canvas);
              for (std::int32_t y = 0; y < copy.height; ++y) {
                std::copy_n(rasterized.pixels.pixel(
                                copy.x - rasterized.bounds.x,
                                copy.y + y - rasterized.bounds.y),
                            copy.width, alpha.pixel(copy.x, copy.y + y));
              }
            }
            blur_selection_alpha(alpha, concrete.feather);
            if (!concrete.antialias) {
              for (auto &value : alpha.data()) {
                value = value >= 128U ? 255U : 0U;
              }
            }
            if (concrete.combine != SelectionCombineMode::Replace) {
              const auto existing = materialize_selection_alpha(
                  selection_, canvas.width, canvas.height);
              for (std::size_t index = 0; index < alpha.data().size(); ++index) {
                auto &value = alpha.data()[index];
                const auto current = existing.data()[index];
                if (concrete.combine == SelectionCombineMode::Add) {
                  value = std::max(value, current);
                } else if (concrete.combine == SelectionCombineMode::Subtract) {
                  value = static_cast<std::uint8_t>(
                      (current * (255U - value)) / 255U);
                } else {
                  value = static_cast<std::uint8_t>(
                      (current * value) / 255U);
                }
              }
            }
            auto modified =
                selection_from_gray_mask(std::move(alpha), canvas);
            if (selection_snapshots_equal(selection_, modified)) {
              return;
            }
            prepare_mutation(record_history);
            selection_ = std::move(modified);
            changed = true;
            affects_document = false;
            event_kind = SessionEventKind::SelectionChanged;
            return;
          } else if constexpr (std::is_same_v<Command, SelectLayerAlpha> ||
                               std::is_same_v<Command, SelectLayerMask> ||
                               std::is_same_v<Command, SelectLayerVectorMask> ||
                               std::is_same_v<Command, SelectSmartFilterMask>) {
            const auto *layer = document_.find_layer(concrete.layer_id);
            if (layer == nullptr) {
              error = make_error(SessionErrorCode::LayerNotFound,
                                 "selection source layer does not exist");
              return;
            }
            SelectionSnapshot modified;
            if constexpr (std::is_same_v<Command, SelectLayerAlpha>) {
              if (layer->kind() != LayerKind::Pixel) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "selection alpha source must be a pixel layer");
                return;
              }
              const auto bounds = intersect_rect(
                  layer->bounds(),
                  Rect::from_size(document_.width(), document_.height()));
              if (!bounds.empty() && !layer->pixels().empty()) {
                PixelBuffer alpha(bounds.width, bounds.height,
                                  PixelFormat::gray8());
                for (std::int32_t y = 0; y < bounds.height; ++y) {
                  for (std::int32_t x = 0; x < bounds.width; ++x) {
                    *alpha.pixel(x, y) = pixel_alpha8(
                        layer->pixels(), bounds.x + x - layer->bounds().x,
                        bounds.y + y - layer->bounds().y);
                  }
                }
                modified = selection_from_gray_mask(std::move(alpha), bounds);
              }
            } else if constexpr (std::is_same_v<Command, SelectLayerMask>) {
              if (!layer->mask().has_value()) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "selection source layer has no mask");
                return;
              }
              const auto &mask = *layer->mask();
              const auto canvas =
                  Rect::from_size(document_.width(), document_.height());
              const auto bounds = mask.default_color != 0U
                                      ? canvas
                                      : intersect_rect(mask.bounds, canvas);
              if (!bounds.empty()) {
                PixelBuffer alpha(bounds.width, bounds.height,
                                  PixelFormat::gray8());
                alpha.clear(mask.default_color);
                if (!mask.pixels.empty() &&
                    mask.pixels.format() == PixelFormat::gray8()) {
                  const auto copy = intersect_rect(mask.bounds, bounds);
                  for (std::int32_t y = 0; y < copy.height; ++y) {
                    const auto *source = mask.pixels.pixel(
                        copy.x - mask.bounds.x, copy.y + y - mask.bounds.y);
                    auto *destination = alpha.pixel(
                        copy.x - bounds.x, copy.y + y - bounds.y);
                    std::copy_n(source, copy.width, destination);
                  }
                }
                modified = selection_from_gray_mask(std::move(alpha), bounds);
              }
            } else if constexpr (std::is_same_v<Command,
                                                SelectLayerVectorMask>) {
              const auto *mask = layer->vector_mask();
              if (mask == nullptr || mask->cache.empty() ||
                  mask->cache.format() != PixelFormat::gray8()) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "selection source layer has no rasterized vector mask");
                return;
              }
              const auto bounds = intersect_rect(
                  mask->cache_bounds,
                  Rect::from_size(document_.width(), document_.height()));
              if (!bounds.empty()) {
                PixelBuffer alpha(bounds.width, bounds.height,
                                  PixelFormat::gray8());
                const auto source_x = bounds.x - mask->cache_bounds.x;
                const auto source_y = bounds.y - mask->cache_bounds.y;
                for (std::int32_t y = 0; y < bounds.height; ++y) {
                  std::copy_n(mask->cache.pixel(source_x, source_y + y),
                              bounds.width, alpha.pixel(0, y));
                }
                modified = selection_from_gray_mask(std::move(alpha), bounds);
              }
            } else {
              const auto *stack = layer->smart_filter_stack();
              if (stack == nullptr || stack->mask.pixels.empty() ||
                  stack->mask.pixels.format() != PixelFormat::gray8() ||
                  stack->mask.bounds.width != stack->mask.pixels.width() ||
                  stack->mask.bounds.height != stack->mask.pixels.height()) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "selection source layer has no editable Smart Filter mask");
                return;
              }
              const auto canvas =
                  Rect::from_size(document_.width(), document_.height());
              const auto pixel_count =
                  static_cast<std::uint64_t>(document_.width()) *
                  static_cast<std::uint64_t>(document_.height());
              if (pixel_count > psd::kMaximumEditableSmartFilterMaskPixels) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "Smart Filter mask exceeds the editable pixel limit");
                return;
              }
              PixelBuffer alpha(canvas.width, canvas.height,
                                PixelFormat::gray8());
              alpha.clear(stack->mask.extend_with_white
                              ? 255U
                              : stack->mask.default_color);
              const auto copy = intersect_rect(stack->mask.bounds, canvas);
              for (std::int32_t y = 0; y < copy.height; ++y) {
                std::copy_n(
                    stack->mask.pixels.pixel(copy.x - stack->mask.bounds.x,
                                             copy.y + y - stack->mask.bounds.y),
                    copy.width, alpha.pixel(copy.x, copy.y + y));
              }
              modified = selection_from_gray_mask(std::move(alpha), canvas);
            }
            if (selection_snapshots_equal(selection_, modified)) {
              return;
            }
            prepare_mutation(record_history);
            selection_ = std::move(modified);
            changed = true;
            affects_document = false;
            event_kind = SessionEventKind::SelectionChanged;
            layer_id = concrete.layer_id;
            return;
          } else if constexpr (std::is_same_v<Command, ModifySelection>) {
            const bool morphology =
                concrete.operation == SelectionOperation::Expand ||
                concrete.operation == SelectionOperation::Contract ||
                concrete.operation == SelectionOperation::Border;
            if (morphology && (concrete.pixels < 1 || concrete.pixels > 250)) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "selection radius must be in [1, 250]");
              return;
            }
            SelectionSnapshot modified;
            switch (concrete.operation) {
            case SelectionOperation::SelectAll:
              modified.selection = {
                  Rect::from_size(document_.width(), document_.height())};
              modified.display_region = modified.selection;
              break;
            case SelectionOperation::Clear:
              break;
            case SelectionOperation::Invert:
              modified.selection = invert_rect_selection(
                  selection_.selection, document_.width(), document_.height());
              modified.display_region = modified.selection;
              break;
            case SelectionOperation::Expand: {
              const auto rows = dilate_selection(
                  selection_.selection, document_.width(), document_.height(),
                  concrete.pixels);
              modified.selection = rects_from_rows(rows);
              modified.display_region = modified.selection;
              break;
            }
            case SelectionOperation::Contract: {
              const auto rows = erode_selection(
                  selection_.selection, document_.width(), document_.height(),
                  concrete.pixels);
              modified.selection = rects_from_rows(rows);
              modified.display_region = modified.selection;
              break;
            }
            case SelectionOperation::Border: {
              const auto outside = dilate_selection(
                  selection_.selection, document_.width(), document_.height(),
                  concrete.pixels);
              const auto inside = erode_selection(
                  selection_.selection, document_.width(), document_.height(),
                  concrete.pixels);
              modified.selection = rects_from_rows(subtract_rows(outside, inside));
              modified.display_region = modified.selection;
              break;
            }
            }
            if (selection_snapshots_equal(selection_, modified)) {
              return;
            }
            prepare_mutation(record_history);
            selection_ = std::move(modified);
            changed = true;
            affects_document = false;
            event_kind = SessionEventKind::SelectionChanged;
            return;
          } else if constexpr (std::is_same_v<Command, SetSelection>) {
            const auto valid_rect = [this](Rect rect) {
              return rect.width > 0 && rect.height > 0 && rect.x >= 0 &&
                     rect.y >= 0 && rect.x <= document_.width() - rect.width &&
                     rect.y <= document_.height() - rect.height;
            };
            if (!std::all_of(concrete.selection.selection.begin(),
                             concrete.selection.selection.end(), valid_rect) ||
                !std::all_of(concrete.selection.display_region.begin(),
                             concrete.selection.display_region.end(),
                             valid_rect)) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "selection rectangles must be inside the document");
              return;
            }
            if (!concrete.selection.mask_alpha.empty() &&
                (concrete.selection.mask_alpha.format() != PixelFormat::gray8() ||
                 concrete.selection.mask_alpha.width() !=
                     concrete.selection.mask_bounds.width ||
                 concrete.selection.mask_alpha.height() !=
                     concrete.selection.mask_bounds.height ||
                 !valid_rect(concrete.selection.mask_bounds))) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "selection mask does not match its bounds");
              return;
            }
            if (concrete.selection.quick_mask_pixels.has_value() &&
                (!concrete.selection.quick_mask_pixels->empty()) &&
                (concrete.selection.quick_mask_pixels->format() !=
                     PixelFormat::gray8() ||
                 concrete.selection.quick_mask_pixels->width() !=
                     document_.width() ||
                 concrete.selection.quick_mask_pixels->height() !=
                     document_.height())) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "quick mask must cover the document");
              return;
            }
            if (selection_snapshots_equal(selection_, concrete.selection)) {
              return;
            }
            prepare_mutation(record_history);
            selection_ = concrete.selection;
            changed = true;
            affects_document = false;
            event_kind = SessionEventKind::SelectionChanged;
            return;
          } else if constexpr (std::is_same_v<Command, SetLayersOpacity> ||
                               std::is_same_v<Command, SetLayersFillOpacity> ||
                               std::is_same_v<Command, SetLayersBlendMode>) {
            if (concrete.layer_ids.empty()) {
              error = make_error(SessionErrorCode::InvalidArgument,
                                 "property edit requires at least one layer");
              return;
            }
            if constexpr (!std::is_same_v<Command, SetLayersBlendMode>) {
              if (!std::isfinite(concrete.opacity) || concrete.opacity < 0.0F ||
                  concrete.opacity > 1.0F) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "opacity must be finite and in [0, 1]");
                return;
              }
            }
            Rect affected{};
            for (const auto id : concrete.layer_ids) {
              const auto *layer = document_.find_layer(id);
              if (layer == nullptr) {
                error = make_error(SessionErrorCode::LayerNotFound,
                                   "edited layer does not exist");
                return;
              }
              if constexpr (std::is_same_v<Command,
                                           SetLayersFillOpacity>) {
                if (layer->kind() == LayerKind::Group) {
                  error = make_error(SessionErrorCode::InvalidArgument,
                                     "group fill opacity is not supported");
                  return;
                }
              }
            }
            prepare_mutation(record_history);
            for (const auto id : concrete.layer_ids) {
              auto *layer = document_.find_layer(id);
              affected = unite_rect(affected, layer_render_bounds(*layer));
              if constexpr (std::is_same_v<Command, SetLayersOpacity>) {
                layer->set_opacity(concrete.opacity);
              } else if constexpr (std::is_same_v<Command,
                                                  SetLayersFillOpacity>) {
                layer->set_fill_opacity(concrete.opacity);
              } else {
                layer->set_blend_mode(concrete.blend_mode);
              }
              affected = unite_rect(affected, layer_render_bounds(*layer));
            }
            changed = true;
            layer_id = concrete.layer_ids.front();
            affected_region = affected;
            return;
          } else {
            layer_id = concrete.layer_id;
            auto *layer = document_.find_layer(concrete.layer_id);
            if (layer == nullptr) {
              error = make_error(SessionErrorCode::LayerNotFound,
                                 "layer does not exist");
              return;
            }

            if constexpr (std::is_same_v<Command, SetLayerVisibility>) {
              if (layer->visible() != concrete.visible) {
                prepare_mutation(record_history);
                layer = document_.find_layer(concrete.layer_id);
                layer->set_visible(concrete.visible);
                changed = true;
              }
            } else if constexpr (std::is_same_v<Command, SetLayerOpacity>) {
              if (!std::isfinite(concrete.opacity) || concrete.opacity < 0.0F ||
                  concrete.opacity > 1.0F) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "opacity must be finite and in [0, 1]");
                return;
              }
              if (layer->opacity() != concrete.opacity) {
                prepare_mutation(record_history);
                layer = document_.find_layer(concrete.layer_id);
                layer->set_opacity(concrete.opacity);
                changed = true;
              }
            } else if constexpr (std::is_same_v<Command, SetLayerFillOpacity>) {
              if (!std::isfinite(concrete.opacity) || concrete.opacity < 0.0F ||
                  concrete.opacity > 1.0F) {
                error = make_error(SessionErrorCode::InvalidArgument,
                                   "fill opacity must be finite and in [0, 1]");
                return;
              }
              if (layer->fill_opacity() != concrete.opacity) {
                prepare_mutation(record_history);
                layer = document_.find_layer(concrete.layer_id);
                layer->set_fill_opacity(concrete.opacity);
                changed = true;
              }
            } else if constexpr (std::is_same_v<Command, SetLayerBlendMode>) {
              if (layer->blend_mode() != concrete.blend_mode) {
                prepare_mutation(record_history);
                layer = document_.find_layer(concrete.layer_id);
                layer->set_blend_mode(concrete.blend_mode);
                changed = true;
              }
            } else if constexpr (std::is_same_v<Command, RenameLayer>) {
              if (layer->name() != concrete.name) {
                prepare_mutation(record_history);
                layer = document_.find_layer(concrete.layer_id);
                layer->set_name(concrete.name);
                changed = true;
              }
            }
          }
        },
        command);
  } catch (const FilterCancelled &exception) {
    error = make_error(SessionErrorCode::Cancelled, exception.what());
  } catch (const std::exception &exception) {
    error = make_error(SessionErrorCode::CommandFailed, exception.what());
  }

  if (error) {
    return CommandResult{false, std::move(error)};
  }
  if (changed) {
    if (affects_document) {
      state_id_ = next_state_id_++;
    }
    ++revision_;
    publish(event_kind, layer_id);
  }
  return CommandResult{changed, {}, layer_id, affected_region};
}

std::vector<LayerInfo> DocumentSession::layers() const {
  std::vector<LayerInfo> result;
  const auto append = [&result](const auto &self,
                                const std::vector<Layer> &layers,
                                LayerId parent_id) -> void {
    for (const auto &layer : layers) {
      result.push_back(LayerInfo{layer.id(), parent_id, layer.kind(),
                                 layer.name(), layer.visible(),
                                 layer.opacity()});
      self(self, layer.children(), layer.id());
    }
  };
  append(append, document_.layers(), 0);
  return result;
}

CommandResult DocumentSession::restore(bool backward) {
  auto &source = backward ? undo_stack_ : redo_stack_;
  auto &destination = backward ? redo_stack_ : undo_stack_;
  if (source.empty()) {
    return CommandResult{
        false, make_error(backward ? SessionErrorCode::NoUndoState
                                   : SessionErrorCode::NoRedoState,
                          backward ? "no undo state" : "no redo state")};
  }

  destination.push_back(
      HistoryState{std::move(document_), std::move(selection_), state_id_});
  auto restored = std::move(source.back());
  source.pop_back();
  document_ = std::move(restored.document);
  selection_ = std::move(restored.selection);
  state_id_ = restored.state_id;
  ++revision_;
  publish(backward ? SessionEventKind::UndoApplied
                   : SessionEventKind::RedoApplied);
  return CommandResult{true, {}};
}

CommandResult DocumentSession::undo() { return restore(true); }

CommandResult DocumentSession::redo() { return restore(false); }

SaveResult DocumentSession::encode_psd(bool large_document) const {
  try {
    return SaveResult{
        psd::DocumentIo::write_layered_rgb8(
            document_, psd::WriteOptions{.large_document = large_document}),
        {}};
  } catch (const std::exception &exception) {
    return SaveResult{
        {}, make_error(SessionErrorCode::EncodeFailed, exception.what())};
  }
}

RenderResult
DocumentSession::render(Rect region,
                        const CancellationToken *cancellation) const {
  if (region.width <= 0 || region.height <= 0 || region.x < 0 || region.y < 0 ||
      region.x > document_.width() - region.width ||
      region.y > document_.height() - region.height) {
    return RenderResult{{},
                        region,
                        revision_,
                        make_error(SessionErrorCode::InvalidArgument,
                                   "render region is outside the document")};
  }
  if (cancellation != nullptr && cancellation->cancelled()) {
    return RenderResult{
        {},
        region,
        revision_,
        make_error(SessionErrorCode::Cancelled, "render cancelled")};
  }
  try {
    auto output = flatten_document_region_rgba8(document_, region);
    if (cancellation != nullptr && cancellation->cancelled()) {
      return RenderResult{
          {},
          region,
          revision_,
          make_error(SessionErrorCode::Cancelled, "render cancelled")};
    }
    return RenderResult{std::move(output), region, revision_, {}};
  } catch (const std::exception &exception) {
    return RenderResult{
        {},
        region,
        revision_,
        make_error(SessionErrorCode::RenderFailed, exception.what())};
  }
}

void DocumentSession::mark_saved() {
  saved_state_id_ = state_id_;
  publish(SessionEventKind::Saved);
}

void DocumentSession::mark_external_modified() {
  redo_stack_.clear();
  state_id_ = next_state_id_++;
  ++revision_;
  publish(SessionEventKind::CommandApplied);
}

void DocumentSession::restore_external(Document document,
                                       std::uint64_t state_id,
                                       SelectionSnapshot selection) {
  document_ = std::move(document);
  selection_ = std::move(selection);
  undo_stack_.clear();
  redo_stack_.clear();
  state_id_ = state_id;
  next_state_id_ = std::max(next_state_id_, state_id + 1U);
  ++revision_;
}

void DocumentSession::replace_external(Document document, bool saved) {
  document_ = std::move(document);
  selection_ = {};
  undo_stack_.clear();
  redo_stack_.clear();
  state_id_ = next_state_id_++;
  ++revision_;
  if (saved) {
    saved_state_id_ = state_id_;
  }
}

} // namespace patchy::engine
