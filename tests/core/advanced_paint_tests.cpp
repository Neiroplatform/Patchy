#include "core/advanced_paint_stroke.hpp"

#include "core_test_support.hpp"
#include "test_groups.hpp"
#include "test_harness.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace {

using patchy::test::active_tool_layer;
using patchy::test::make_tool_document;
using patchy::test::solid_rgb;
using patchy::test::solid_rgba;

patchy::AdvancedPaintStrokeRequest base_request() {
  patchy::AdvancedPaintStrokeRequest request;
  request.points = {{10.0, 10.0}};
  request.brush_size = 7;
  request.softness = 0;
  request.flow = 100;
  request.color = {240, 20, 30, 255};
  request.secondary_color = {20, 40, 230, 255};
  return request;
}

void pattern_stamp_is_anchored_and_selection_bounded() {
  auto document = make_tool_document();
  const auto layer_id = active_tool_layer(document);
  auto request = base_request();
  request.mode = patchy::AdvancedPaintMode::PatternStamp;
  request.pattern = patchy::AdvancedPaintPattern::Checker;
  request.pattern_size = 2;
  request.pattern_anchor_x = 0;
  request.pattern_anchor_y = 0;
  request.selection = {patchy::Rect{8, 8, 5, 5}};

  patchy::AdvancedPaintStrokeResult result;
  std::string error;
  CHECK(patchy::apply_advanced_paint_stroke(document, layer_id, request,
                                             &result, &error));
  CHECK(error.empty());
  CHECK(!result.affected_region.empty());
  const auto& pixels = document.find_layer(layer_id)->pixels();
  const auto* first = pixels.pixel(10, 10);
  const auto* second = pixels.pixel(12, 10);
  CHECK(first[0] == 240);
  CHECK(first[2] == 30);
  CHECK(second[0] == 20);
  CHECK(second[2] == 230);
  CHECK(pixels.pixel(7, 10)[3] == 0);
  CHECK(pixels.pixel(13, 10)[3] == 0);
}

void mixer_sample_all_layers_changes_canvas_pickup() {
  patchy::Document active_only(24, 20, patchy::PixelFormat::rgb8());
  active_only.add_pixel_layer("Background", solid_rgb(24, 20, 20, 220, 40));
  active_only.add_pixel_layer("Paint", solid_rgba(24, 20, 0, 0, 0, 0));
  auto sample_all = active_only;
  const auto layer_id = active_tool_layer(active_only);

  auto request = base_request();
  request.mode = patchy::AdvancedPaintMode::MixerBrush;
  request.points = {{10.0, 10.0}, {14.0, 10.0}};
  request.brush_size = 5;
  request.wet = 100;
  request.load = 100;
  request.mix = 60;
  request.color = {230, 20, 20, 255};
  std::string error;
  CHECK(patchy::apply_advanced_paint_stroke(active_only, layer_id, request,
                                             nullptr, &error));
  request.sample_all_layers = true;
  CHECK(patchy::apply_advanced_paint_stroke(sample_all, layer_id, request,
                                             nullptr, &error));

  const auto* active_pixel = active_only.find_layer(layer_id)->pixels().pixel(10, 10);
  const auto* merged_pixel = sample_all.find_layer(layer_id)->pixels().pixel(10, 10);
  CHECK(merged_pixel[1] > active_pixel[1]);
  CHECK(merged_pixel[3] > active_pixel[3]);
}

void cancellation_leaves_the_document_atomic() {
  auto document = make_tool_document();
  const auto layer_id = active_tool_layer(document);
  const auto before_span = document.find_layer(layer_id)->pixels().data();
  const std::vector<std::uint8_t> before(before_span.begin(), before_span.end());
  auto request = base_request();
  request.mode = patchy::AdvancedPaintMode::PatternStamp;
  request.points = {{4.0, 4.0}, {40.0, 30.0}};
  request.brush_size = 9;
  std::size_t callbacks = 0;
  request.continue_operation = [&callbacks]() { return ++callbacks < 6U; };
  std::string error;
  CHECK(!patchy::apply_advanced_paint_stroke(document, layer_id, request,
                                              nullptr, &error));
  CHECK(error == "advanced-paint stroke was cancelled");
  const auto after = document.find_layer(layer_id)->pixels().data();
  CHECK(std::equal(after.begin(), after.end(), before.begin(), before.end()));
}

void invalid_request_is_rejected_without_mutation() {
  auto document = make_tool_document();
  const auto layer_id = active_tool_layer(document);
  const auto before_span = document.find_layer(layer_id)->pixels().data();
  const std::vector<std::uint8_t> before(before_span.begin(), before_span.end());
  auto request = base_request();
  request.mode = patchy::AdvancedPaintMode::PatternStamp;
  request.pattern_size = 129;
  std::string error;
  CHECK(!patchy::apply_advanced_paint_stroke(document, layer_id, request,
                                              nullptr, &error));
  CHECK(error == "advanced-paint stroke exceeds its bounded contract");
  const auto after = document.find_layer(layer_id)->pixels().data();
  CHECK(std::equal(after.begin(), after.end(), before.begin(), before.end()));
}

}  // namespace

std::vector<patchy::test::TestCase> advanced_paint_tests() {
  return {
      {"advanced_paint_pattern_stamp_is_anchored_and_selection_bounded",
       pattern_stamp_is_anchored_and_selection_bounded},
      {"advanced_paint_mixer_sample_all_layers_changes_canvas_pickup",
       mixer_sample_all_layers_changes_canvas_pickup},
      {"advanced_paint_cancellation_leaves_the_document_atomic",
       cancellation_leaves_the_document_atomic},
      {"advanced_paint_invalid_request_is_rejected_without_mutation",
       invalid_request_is_rejected_without_mutation},
  };
}
