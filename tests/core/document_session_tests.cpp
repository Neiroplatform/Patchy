#include "engine/document_session.hpp"

#include "core/smart_filter.hpp"
#include "core/layer_metadata.hpp"
#include "psd/psd_document_io.hpp"
#include "test_groups.hpp"
#include "test_harness.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <utility>
#include <vector>

using patchy::Document;
using patchy::PixelBuffer;
using patchy::PixelFormat;
using patchy::engine::AddGroup;
using patchy::engine::AddPixelLayer;
using patchy::engine::ApplyFilter;
using patchy::engine::CancellationToken;
using patchy::engine::CropDocument;
using patchy::engine::DocumentSession;
using patchy::engine::FlipAxis;
using patchy::engine::FlipLayers;
using patchy::engine::MoveLayers;
using patchy::engine::ModifySelection;
using patchy::engine::open_psd;
using patchy::engine::PlaceLayers;
using patchy::engine::RemoveLayers;
using patchy::engine::RenameLayer;
using patchy::engine::ReplaceLayerPixels;
using patchy::engine::ResizeCanvas;
using patchy::engine::ResizeImage;
using patchy::engine::RotateCanvas;
using patchy::engine::SessionErrorCode;
using patchy::engine::SessionEvent;
using patchy::engine::SessionEventKind;
using patchy::engine::SelectionSnapshot;
using patchy::engine::SelectionOperation;
using patchy::engine::SelectLayerAlpha;
using patchy::engine::SelectLayerMask;
using patchy::engine::SelectLayerVectorMask;
using patchy::engine::SelectSmartFilterMask;
using patchy::engine::SelectByColorSimilarity;
using patchy::engine::SelectionSimilarityMode;
using patchy::engine::SelectVectorPath;
using patchy::engine::SelectionCombineMode;
using patchy::engine::SetLayerBlendMode;
using patchy::engine::SetLayerFillOpacity;
using patchy::engine::SetLayerOpacity;
using patchy::engine::SetLayerVisibility;
using patchy::engine::SetLayersBlendMode;
using patchy::engine::SetLayersFillOpacity;
using patchy::engine::SetLayersOpacity;
using patchy::engine::SetSelection;
using patchy::engine::UngroupLayers;
using patchy::engine::WrapOffsetDocument;
using patchy::test::TestCase;

namespace {

Document make_session_document() {
  Document document(2, 2, PixelFormat::rgba8());
  PixelBuffer pixels(2, 2, PixelFormat::rgba8());
  for (std::int32_t y = 0; y < pixels.height(); ++y) {
    for (std::int32_t x = 0; x < pixels.width(); ++x) {
      auto *pixel = pixels.pixel(x, y);
      pixel[0] = 12;
      pixel[1] = 34;
      pixel[2] = 56;
      pixel[3] = 255;
    }
  }
  document.add_pixel_layer("Layer 1", std::move(pixels));
  return document;
}

void engine_session_commands_history_dirty_and_events() {
  DocumentSession session(make_session_document());
  const auto layer_id = session.document().layers().front().id();
  std::vector<SessionEvent> events;
  session.set_event_sink(
      [&events](const SessionEvent &event) { events.push_back(event); });

  CHECK(!session.dirty());
  CHECK(
      static_cast<bool>(session.execute(SetLayerVisibility{layer_id, false})));
  CHECK(session.dirty());
  CHECK(!session.document().layers().front().visible());
  CHECK(session.undo_size() == 1);
  CHECK(events.back().kind == SessionEventKind::CommandApplied);

  CHECK(static_cast<bool>(session.undo()));
  CHECK(!session.dirty());
  CHECK(session.document().layers().front().visible());
  CHECK(static_cast<bool>(session.redo()));
  CHECK(session.dirty());
  CHECK(!session.document().layers().front().visible());

  session.mark_saved();
  CHECK(!session.dirty());
  CHECK(static_cast<bool>(session.execute(RenameLayer{layer_id, "Renamed"})));
  CHECK(session.dirty());
  CHECK(static_cast<bool>(session.undo()));
  CHECK(!session.dirty());
  CHECK(session.document().layers().front().name() == "Layer 1");
  CHECK(events.back().revision == session.revision());
}

void engine_session_rejects_invalid_commands_without_mutation() {
  DocumentSession session(make_session_document());
  const auto revision = session.revision();
  const auto state_id = session.state_id();
  const auto missing = session.execute(SetLayerVisibility{999999, false});
  CHECK(!missing);
  CHECK(missing.error.code == SessionErrorCode::LayerNotFound);
  const auto invalid = session.execute(
      SetLayerOpacity{session.document().layers().front().id(), std::nanf("")});
  CHECK(!invalid);
  CHECK(invalid.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision);
  CHECK(session.state_id() == state_id);
  CHECK(!session.dirty());
  CHECK(session.undo_size() == 0);
}

void engine_session_projects_and_moves_layer_tree() {
  auto document = make_session_document();
  PixelBuffer second_pixels(2, 2, PixelFormat::rgba8());
  second_pixels.clear(255);
  const auto second_id =
      document.add_pixel_layer("Layer 2", std::move(second_pixels)).id();
  DocumentSession session(std::move(document));
  const auto first_id = session.document().layers().front().id();

  auto projection = session.layers();
  CHECK(projection.size() == 2);
  CHECK(projection[0].id == first_id);
  CHECK(projection[1].id == second_id);
  CHECK(static_cast<bool>(session.execute(MoveLayers{
      {second_id}, first_id, patchy::LayerDropPosition::BelowItem})));
  projection = session.layers();
  CHECK(projection[0].id == second_id);
  CHECK(projection[1].id == first_id);
  CHECK(static_cast<bool>(session.undo()));
  projection = session.layers();
  CHECK(projection[0].id == first_id);
  CHECK(projection[1].id == second_id);
}

void engine_session_layer_lifecycle_and_document_geometry_are_atomic() {
  DocumentSession session(make_session_document());
  const auto added_result = session.execute(AddGroup{"Added"});
  CHECK(static_cast<bool>(added_result));
  const auto added_id = added_result.affected_layer_id;
  CHECK(added_id != 0);
  CHECK(session.document().find_layer(added_id) != nullptr);
  CHECK(session.document().active_layer_id() == added_id);
  PixelBuffer added_pixels(2, 2, PixelFormat::rgba8());
  added_pixels.clear(255);
  const auto pixel_result =
      session.execute(AddPixelLayer{"Added pixels", std::move(added_pixels)});
  CHECK(static_cast<bool>(pixel_result));
  CHECK(pixel_result.affected_layer_id != 0);
  CHECK(
      static_cast<bool>(session.execute(SetLayerFillOpacity{added_id, 0.25F})));
  CHECK(static_cast<bool>(session.execute(
      SetLayerBlendMode{added_id, patchy::BlendMode::Multiply})));
  CHECK(static_cast<bool>(session.execute(ResizeImage{4, 3})));
  CHECK(session.document().width() == 4);
  CHECK(session.document().height() == 3);
  CHECK(static_cast<bool>(session.execute(ResizeCanvas{
      6, 5, patchy::CanvasAnchor::Center, patchy::EditColor{1, 2, 3, 255}})));
  CHECK(session.document().width() == 6);
  CHECK(session.document().height() == 5);
  CHECK(static_cast<bool>(session.execute(
      RotateCanvas{90.0, patchy::EditColor{255, 255, 255, 255}})));
  CHECK(session.document().width() == 5);
  CHECK(session.document().height() == 6);
  CHECK(static_cast<bool>(session.execute(
      RemoveLayers{{added_id, pixel_result.affected_layer_id}})));
  CHECK(session.document().find_layer(added_id) == nullptr);

  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().find_layer(added_id) != nullptr);
  while (session.can_undo()) {
    CHECK(static_cast<bool>(session.undo()));
  }
  CHECK(session.document().width() == 2);
  CHECK(session.document().height() == 2);
  CHECK(session.document().layers().size() == 1);
  CHECK(!session.dirty());
}

void engine_session_crop_and_wrap_geometry_are_atomic_and_restore_selection() {
  DocumentSession session(make_session_document());
  SelectionSnapshot selected;
  selected.selection = {{1, 1, 1, 1}};
  selected.display_region = selected.selection;
  CHECK(static_cast<bool>(session.execute(SetSelection{selected})));
  session.mark_saved();

  const auto cropped = session.execute(CropDocument{
      {-1, 0, 4, 3}, 0.0, patchy::EditColor{9, 8, 7, 255}, false});
  CHECK(static_cast<bool>(cropped));
  CHECK(cropped.affected_region.has_value());
  CHECK(session.document().width() == 4);
  CHECK(session.document().height() == 3);
  CHECK(session.selection().empty());
  CHECK(session.dirty());
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().width() == 2);
  CHECK(session.document().height() == 2);
  CHECK(session.selection().selection.size() == 1);
  CHECK(!session.dirty());
  CHECK(static_cast<bool>(session.redo()));
  CHECK(session.document().width() == 4);
  CHECK(session.selection().empty());

  CHECK(static_cast<bool>(session.execute(
      WrapOffsetDocument{2, 1, std::string{"2,1"}})));
  CHECK(session.document().metadata().values.at("patchy.tile.seamOffset") ==
        "2,1");
  CHECK(static_cast<bool>(session.undo()));
  CHECK(!session.document().metadata().values.contains(
      "patchy.tile.seamOffset"));
  CHECK(static_cast<bool>(session.redo()));
  CHECK(session.document().metadata().values.at("patchy.tile.seamOffset") ==
        "2,1");
  CHECK(static_cast<bool>(session.execute(
      WrapOffsetDocument{-2, -1, std::nullopt})));
  CHECK(!session.document().metadata().values.contains(
      "patchy.tile.seamOffset"));
}

void engine_session_rejects_non_atomic_lifecycle_commands() {
  DocumentSession session(make_session_document());
  const auto original_state = session.state_id();
  const auto original_id = session.document().layers().front().id();

  CHECK(
      !static_cast<bool>(session.execute(RemoveLayers{{original_id, 999999}})));
  CHECK(!static_cast<bool>(session.execute(ResizeImage{0, 10})));
  CHECK(!static_cast<bool>(session.execute(
      RotateCanvas{std::nan(""), patchy::EditColor{}})));
  CHECK(!static_cast<bool>(session.execute(CropDocument{
      {20, 20, 2, 2}, 0.0, patchy::EditColor{}, true})));
  CHECK(!static_cast<bool>(
      session.execute(WrapOffsetDocument{0, 0, std::nullopt})));
  CHECK(session.state_id() == original_state);
  CHECK(session.undo_size() == 0);
  CHECK(session.document().layers().size() == 1);
}

void engine_session_headless_psd_open_edit_save_reopen() {
  const auto source =
      patchy::psd::DocumentIo::write_layered_rgb8(make_session_document());
  auto opened = open_psd(source);
  CHECK(static_cast<bool>(opened));
  auto &session = *opened.session;
  const auto layer_id = session.document().layers().front().id();
  CHECK(static_cast<bool>(session.execute(SetLayerOpacity{layer_id, 0.5F})));
  CHECK(static_cast<bool>(session.undo()));
  CHECK(static_cast<bool>(session.redo()));

  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  CHECK(!encoded.bytes.empty());
  session.mark_saved();
  CHECK(!session.dirty());

  const auto reopened = patchy::psd::DocumentIo::read(encoded.bytes);
  CHECK(reopened.layers().size() == 1);
  CHECK(std::abs(reopened.layers().front().opacity() - 0.5F) < 0.01F);

  const std::vector<std::uint8_t> invalid{0x00, 0x01, 0x02};
  const auto rejected = open_psd(invalid);
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::DecodeFailed);
}

void engine_session_renders_bounded_rgba_regions_and_cancels() {
  DocumentSession session(make_session_document());
  const auto full = session.render(patchy::Rect{0, 0, 2, 2});
  CHECK(static_cast<bool>(full));
  const auto rendered = session.render(patchy::Rect{1, 0, 1, 2});
  CHECK(static_cast<bool>(rendered));
  CHECK(rendered.pixels.width() == 1);
  CHECK(rendered.pixels.height() == 2);
  CHECK(rendered.pixels.pixel(0, 0)[0] == 12);
  CHECK(rendered.pixels.pixel(0, 0)[1] == 34);
  CHECK(rendered.pixels.pixel(0, 0)[2] == 56);
  CHECK(rendered.pixels.pixel(0, 0)[3] == 255);
  CHECK(std::equal(rendered.pixels.row(0).begin(),
                   rendered.pixels.row(0).end(), full.pixels.pixel(1, 0)));
  CHECK(std::equal(rendered.pixels.row(1).begin(),
                   rendered.pixels.row(1).end(), full.pixels.pixel(1, 1)));

  Document alpha_document(4, 3, PixelFormat::rgba8());
  PixelBuffer alpha_source(4, 3, PixelFormat::rgba8());
  for (std::int32_t y = 0; y < 3; ++y) {
    for (std::int32_t x = 0; x < 4; ++x) {
      auto *pixel = alpha_source.pixel(x, y);
      pixel[0] = static_cast<std::uint8_t>(30 + x);
      pixel[1] = static_cast<std::uint8_t>(60 + y);
      pixel[2] = 90;
      pixel[3] = 255;
    }
  }
  const auto alpha_layer_id = alpha_document.allocate_layer_id();
  patchy::Layer alpha_layer(alpha_layer_id, "Document alpha",
                            std::move(alpha_source));
  PixelBuffer alpha_mask(4, 3, PixelFormat::gray8());
  *alpha_mask.pixel(1, 1) = 0;
  *alpha_mask.pixel(2, 1) = 128;
  alpha_layer.set_mask(
      patchy::LayerMask{{0, 0, 4, 3}, std::move(alpha_mask), 0, false});
  patchy::set_layer_mask_is_document_alpha(alpha_layer, true);
  alpha_document.add_layer(std::move(alpha_layer));
  DocumentSession alpha_session(std::move(alpha_document));
  const auto alpha_region = alpha_session.render({1, 1, 2, 1});
  CHECK(static_cast<bool>(alpha_region));
  CHECK(alpha_region.pixels.pixel(0, 0)[0] == 31);
  CHECK(alpha_region.pixels.pixel(0, 0)[1] == 61);
  CHECK(alpha_region.pixels.pixel(0, 0)[3] == 0);
  CHECK(alpha_region.pixels.pixel(1, 0)[3] == 128);

  Document layered_document(6, 4, PixelFormat::rgba8());
  PixelBuffer backdrop(6, 4, PixelFormat::rgba8());
  for (std::int32_t y = 0; y < 4; ++y) {
    for (std::int32_t x = 0; x < 6; ++x) {
      auto *pixel = backdrop.pixel(x, y);
      pixel[0] = static_cast<std::uint8_t>(80 + x * 10);
      pixel[1] = static_cast<std::uint8_t>(100 + y * 15);
      pixel[2] = 180;
      pixel[3] = 255;
    }
  }
  layered_document.add_pixel_layer("Backdrop", std::move(backdrop));
  PixelBuffer overlay(4, 3, PixelFormat::rgba8());
  overlay.clear(160);
  const auto overlay_id = layered_document.allocate_layer_id();
  patchy::Layer overlay_layer(overlay_id, "Overlay", std::move(overlay));
  overlay_layer.set_bounds({1, 0, 4, 3});
  overlay_layer.set_blend_mode(patchy::BlendMode::Multiply);
  overlay_layer.set_opacity(0.75F);
  layered_document.add_layer(std::move(overlay_layer));
  DocumentSession layered_session(std::move(layered_document));
  const auto layered_full = layered_session.render({0, 0, 6, 4});
  const auto layered_region = layered_session.render({2, 1, 3, 2});
  CHECK(static_cast<bool>(layered_full));
  CHECK(static_cast<bool>(layered_region));
  for (std::int32_t y = 0; y < 2; ++y) {
    CHECK(std::equal(layered_region.pixels.row(y).begin(),
                     layered_region.pixels.row(y).end(),
                     layered_full.pixels.pixel(2, y + 1)));
  }

  const auto outside = session.render(patchy::Rect{2, 0, 1, 1});
  CHECK(!static_cast<bool>(outside));
  CHECK(outside.error.code == SessionErrorCode::InvalidArgument);
  CancellationToken cancellation;
  cancellation.cancel();
  const auto cancelled =
      session.render(patchy::Rect{0, 0, 2, 2}, &cancellation);
  CHECK(!static_cast<bool>(cancelled));
  CHECK(cancelled.error.code == SessionErrorCode::Cancelled);
}

void engine_session_external_shell_adapter_preserves_state_identity() {
  DocumentSession session(make_session_document());
  const auto initial_state = session.state_id();
  const auto layer_id = session.document().layers().front().id();
  CHECK(static_cast<bool>(
      session.execute_external(SetLayerVisibility{layer_id, false})));
  CHECK(session.undo_size() == 0);
  CHECK(session.dirty());

  session.replace_external(make_session_document(), true);
  CHECK(!session.dirty());
  session.mark_external_modified();
  const auto edited_state = session.state_id();
  CHECK(edited_state != initial_state);
  CHECK(session.dirty());
  session.mark_saved();
  CHECK(!session.dirty());

  auto snapshot = session.document();
  session.mark_external_modified();
  CHECK(session.dirty());
  session.restore_external(std::move(snapshot), edited_state);
  CHECK(!session.dirty());
  CHECK(session.state_id() == edited_state);

  session.replace_external(make_session_document(), true);
  CHECK(!session.dirty());
  CHECK(session.state_id() != edited_state);
}

void engine_selection_snapshot_is_qt_free_and_accounts_retained_bytes() {
  SelectionSnapshot snapshot;
  snapshot.selection = {{1, 2, 3, 4}, {8, 9, 2, 2}};
  snapshot.display_region = {{1, 2, 3, 4}};
  snapshot.mask_bounds = {1, 2, 3, 4};
  snapshot.mask_alpha = PixelBuffer(3, 4, PixelFormat::gray8());
  snapshot.quick_mask_pixels = PixelBuffer(2, 2, PixelFormat::gray8());

  CHECK(!snapshot.empty());
  CHECK(snapshot.retained_bytes() >= 16);
  snapshot.selection.clear();
  CHECK(snapshot.empty());
}

void engine_session_selection_is_canonical_undoable_and_not_dirty() {
  DocumentSession session(make_session_document());
  const auto initial_state_id = session.state_id();
  const auto initial_revision = session.revision();
  std::vector<SessionEvent> events;
  session.set_event_sink(
      [&events](const SessionEvent &event) { events.push_back(event); });

  SelectionSnapshot selected;
  selected.selection = {{0, 0, 1, 1}};
  selected.display_region = selected.selection;
  selected.mask_bounds = {0, 0, 1, 1};
  selected.mask_alpha = PixelBuffer(1, 1, PixelFormat::gray8());
  selected.mask_alpha.pixel(0, 0)[0] = 127;
  selected.quick_mask_pixels = PixelBuffer(2, 2, PixelFormat::gray8());
  selected.quick_mask_pixels->clear(255);

  CHECK(static_cast<bool>(session.execute(SetSelection{selected})));
  CHECK(session.selection().selection.size() == 1);
  CHECK(session.selection().mask_alpha.pixel(0, 0)[0] == 127);
  CHECK(session.selection().quick_mask_pixels.has_value());
  CHECK(session.state_id() == initial_state_id);
  CHECK(session.revision() == initial_revision + 1);
  CHECK(!session.dirty());
  CHECK(session.undo_size() == 1);
  CHECK(events.back().kind == SessionEventKind::SelectionChanged);

  const auto layer_id = session.document().layers().front().id();
  CHECK(static_cast<bool>(session.execute(RenameLayer{layer_id, "Renamed"})));
  CHECK(session.dirty());
  CHECK(session.selection().selection.size() == 1);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(!session.dirty());
  CHECK(session.document().layers().front().name() == "Layer 1");
  CHECK(session.selection().selection.size() == 1);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.selection().empty());
  CHECK(!session.dirty());
  CHECK(static_cast<bool>(session.redo()));
  CHECK(session.selection().selection.size() == 1);
  CHECK(!session.dirty());

  const auto revision_before_rejection = session.revision();
  const auto undo_before_rejection = session.undo_size();
  SelectionSnapshot outside;
  outside.selection = {{1, 1, 2, 2}};
  const auto rejected = session.execute(SetSelection{std::move(outside)});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.revision() == revision_before_rejection);
  CHECK(session.undo_size() == undo_before_rejection);
  CHECK(session.selection().selection.size() == 1);

  CHECK(static_cast<bool>(session.execute(ResizeCanvas{
      3, 3, patchy::CanvasAnchor::Center, patchy::EditColor{}})));
  CHECK(session.selection().empty());
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().width() == 2);
  CHECK(session.selection().selection.size() == 1);

  DocumentSession shell_session(make_session_document());
  CHECK(static_cast<bool>(
      shell_session.execute_external(SetSelection{std::move(selected)})));
  CHECK(shell_session.selection().selection.size() == 1);
  CHECK(shell_session.undo_size() == 0);
  CHECK(!shell_session.dirty());
}

void engine_session_selection_operations_are_qt_free_and_undoable() {
  DocumentSession session(make_session_document());
  const auto initial_state = session.state_id();

  CHECK(static_cast<bool>(session.execute(
      ModifySelection{SelectionOperation::SelectAll})));
  CHECK(session.selection().selection.size() == 1);
  CHECK(session.selection().selection.front().width == 2);
  CHECK(session.selection().selection.front().height == 2);
  CHECK(session.state_id() == initial_state);
  CHECK(!session.dirty());

  CHECK(static_cast<bool>(
      session.execute(ModifySelection{SelectionOperation::Invert})));
  CHECK(session.selection().empty());
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.selection().selection.size() == 1);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.selection().empty());

  SelectionSnapshot corner;
  corner.selection = {{0, 0, 1, 1}};
  corner.display_region = corner.selection;
  CHECK(static_cast<bool>(session.execute(SetSelection{corner})));
  CHECK(static_cast<bool>(
      session.execute(ModifySelection{SelectionOperation::Invert})));
  CHECK(session.selection().selection.size() == 2);
  CHECK(static_cast<bool>(
      session.execute(ModifySelection{SelectionOperation::Clear})));
  CHECK(session.selection().empty());
  CHECK(!session.dirty());

  DocumentSession morphology(
      Document(8, 8, PixelFormat::rgba8()));
  SelectionSnapshot square;
  square.selection = {{2, 2, 4, 4}};
  square.display_region = square.selection;
  CHECK(static_cast<bool>(morphology.execute(SetSelection{square})));
  CHECK(static_cast<bool>(morphology.execute(
      ModifySelection{SelectionOperation::Expand, 1})));
  CHECK(morphology.selection().selection.size() == 1);
  CHECK(morphology.selection().selection.front().x == 1);
  CHECK(morphology.selection().selection.front().y == 1);
  CHECK(morphology.selection().selection.front().width == 6);
  CHECK(morphology.selection().selection.front().height == 6);
  CHECK(static_cast<bool>(morphology.undo()));
  CHECK(static_cast<bool>(morphology.execute(
      ModifySelection{SelectionOperation::Contract, 1})));
  CHECK(morphology.selection().selection.size() == 1);
  CHECK(morphology.selection().selection.front().x == 3);
  CHECK(morphology.selection().selection.front().y == 3);
  CHECK(morphology.selection().selection.front().width == 2);
  CHECK(morphology.selection().selection.front().height == 2);
  CHECK(static_cast<bool>(morphology.undo()));
  CHECK(static_cast<bool>(morphology.execute(
      ModifySelection{SelectionOperation::Border, 1})));
  const auto contains = [&morphology](std::int32_t x, std::int32_t y) {
    return std::any_of(
        morphology.selection().selection.begin(),
        morphology.selection().selection.end(), [x, y](patchy::Rect rect) {
          return x >= rect.x && y >= rect.y && x < rect.x + rect.width &&
                 y < rect.y + rect.height;
        });
  };
  CHECK(contains(1, 1));
  CHECK(contains(2, 2));
  CHECK(!contains(3, 3));
  const auto revision = morphology.revision();
  CHECK(!static_cast<bool>(morphology.execute(
      ModifySelection{SelectionOperation::Expand, 251})));
  CHECK(morphology.revision() == revision);
}

void engine_session_layer_derived_selection_preserves_soft_coverage() {
  Document document(4, 3, PixelFormat::rgba8());
  PixelBuffer pixels(2, 2, PixelFormat::rgba8());
  pixels.pixel(0, 0)[3] = 0;
  pixels.pixel(1, 0)[3] = 64;
  pixels.pixel(0, 1)[3] = 255;
  pixels.pixel(1, 1)[3] = 255;
  const auto layer_id = document.allocate_layer_id();
  patchy::Layer layer(layer_id, "Alpha source", std::move(pixels));
  layer.set_bounds({1, 1, 2, 2});
  PixelBuffer mask(2, 2, PixelFormat::gray8());
  *mask.pixel(0, 0) = 0;
  *mask.pixel(1, 0) = 128;
  *mask.pixel(0, 1) = 255;
  *mask.pixel(1, 1) = 255;
  layer.set_mask(patchy::LayerMask{{0, 0, 2, 2}, std::move(mask), 0, false});
  patchy::LayerVectorMask vector_mask;
  vector_mask.cache_bounds = {2, 0, 2, 1};
  vector_mask.cache = PixelBuffer(2, 1, PixelFormat::gray8());
  *vector_mask.cache.pixel(0, 0) = 32;
  *vector_mask.cache.pixel(1, 0) = 255;
  layer.set_vector_mask(std::move(vector_mask));
  patchy::SmartFilterStack smart_filters;
  smart_filters.mask.bounds = {0, 2, 2, 1};
  smart_filters.mask.pixels = PixelBuffer(2, 1, PixelFormat::gray8());
  *smart_filters.mask.pixels.pixel(0, 0) = 255;
  *smart_filters.mask.pixels.pixel(1, 0) = 32;
  smart_filters.mask.default_color = 0;
  smart_filters.mask.extend_with_white = false;
  layer.set_smart_filter_stack(std::move(smart_filters));
  document.add_layer(std::move(layer));
  DocumentSession session(std::move(document));

  CHECK(static_cast<bool>(session.execute(SelectLayerAlpha{layer_id})));
  CHECK(session.selection().mask_bounds.x == 1);
  CHECK(session.selection().mask_bounds.y == 1);
  CHECK(session.selection().mask_alpha.pixel(1, 0)[0] == 64);
  const auto contains = [](const std::vector<patchy::Rect> &rects,
                           std::int32_t x, std::int32_t y) {
    return std::any_of(rects.begin(), rects.end(), [x, y](patchy::Rect rect) {
      return x >= rect.x && y >= rect.y && x < rect.x + rect.width &&
             y < rect.y + rect.height;
    });
  };
  CHECK(!contains(session.selection().selection, 1, 1));
  CHECK(contains(session.selection().selection, 2, 1));
  CHECK(!contains(session.selection().display_region, 2, 1));
  CHECK(contains(session.selection().display_region, 1, 2));
  CHECK(!session.dirty());

  CHECK(static_cast<bool>(session.execute(SelectLayerMask{layer_id})));
  CHECK(session.selection().mask_bounds.x == 0);
  CHECK(session.selection().mask_alpha.pixel(1, 0)[0] == 128);
  CHECK(contains(session.selection().selection, 1, 0));
  CHECK(contains(session.selection().display_region, 1, 0));

  CHECK(static_cast<bool>(session.execute(SelectLayerVectorMask{layer_id})));
  CHECK(session.selection().mask_bounds.x == 2);
  CHECK(session.selection().mask_bounds.y == 0);
  CHECK(session.selection().mask_alpha.pixel(0, 0)[0] == 32);
  CHECK(contains(session.selection().selection, 2, 0));
  CHECK(!contains(session.selection().display_region, 2, 0));
  CHECK(contains(session.selection().display_region, 3, 0));

  CHECK(static_cast<bool>(session.execute(SelectSmartFilterMask{layer_id})));
  CHECK(session.selection().mask_bounds.x == 0);
  CHECK(session.selection().mask_bounds.y == 0);
  CHECK(session.selection().mask_alpha.pixel(1, 2)[0] == 32);
  CHECK(contains(session.selection().display_region, 0, 2));
  CHECK(!contains(session.selection().display_region, 1, 2));
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.selection().mask_bounds.x == 2);
  CHECK(!session.dirty());
}

void engine_session_similarity_and_path_selection_are_canonical() {
  Document document(8, 6, PixelFormat::rgba8());
  PixelBuffer pixels(8, 6, PixelFormat::rgba8());
  for (std::int32_t y = 0; y < 6; ++y) {
    for (std::int32_t x = 0; x < 8; ++x) {
      auto *pixel = pixels.pixel(x, y);
      const bool red = x < 2 || (x >= 4 && x < 6);
      pixel[0] = red ? 220U : 20U;
      pixel[1] = red ? 20U : 80U;
      pixel[2] = red ? 40U : 220U;
      pixel[3] = 255U;
    }
  }
  document.add_pixel_layer("Similarity", std::move(pixels));
  DocumentSession session(std::move(document));
  CHECK(static_cast<bool>(session.execute(
      SetSelection{SelectionSnapshot{{{0, 0, 1, 1}}, {{0, 0, 1, 1}}}})));

  const auto contains = [&session](std::int32_t x, std::int32_t y) {
    return std::any_of(
        session.selection().selection.begin(),
        session.selection().selection.end(), [x, y](patchy::Rect rect) {
          return x >= rect.x && y >= rect.y && x < rect.x + rect.width &&
                 y < rect.y + rect.height;
        });
  };
  CHECK(static_cast<bool>(session.execute(SelectByColorSimilarity{
      SelectionSimilarityMode::Grow, 0})));
  CHECK(contains(1, 5));
  CHECK(!contains(4, 0));
  CHECK(static_cast<bool>(session.execute(SelectByColorSimilarity{
      SelectionSimilarityMode::Similar, 0})));
  CHECK(contains(1, 5));
  CHECK(contains(4, 0));
  CHECK(!contains(7, 0));

  const auto corner = [](double x, double y) {
    patchy::PathAnchor anchor;
    anchor.anchor_x = anchor.in_x = anchor.out_x = x;
    anchor.anchor_y = anchor.in_y = anchor.out_y = y;
    return anchor;
  };
  patchy::PathSubpath rectangle;
  rectangle.anchors =
      {corner(2, 1), corner(7, 1), corner(7, 5), corner(2, 5)};
  patchy::VectorPath path;
  path.subpaths.push_back(std::move(rectangle));
  CHECK(static_cast<bool>(session.execute(SelectVectorPath{
      path, 0.0, false, SelectionCombineMode::Replace})));
  CHECK(!contains(0, 0));
  CHECK(contains(4, 3));
  CHECK(static_cast<bool>(session.execute(SelectVectorPath{
      path, 2.0, true, SelectionCombineMode::Add})));
  CHECK(!session.selection().mask_alpha.empty());
  CHECK(!session.dirty());
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.selection().mask_alpha.empty());
  const auto revision = session.revision();
  CHECK(!static_cast<bool>(session.execute(SelectByColorSimilarity{
      SelectionSimilarityMode::Similar, 256})));
  CHECK(session.revision() == revision);
}

void engine_session_layer_editing_vertical_slice_is_atomic_and_undoable() {
  DocumentSession session(make_session_document());
  const auto original_id = session.document().layers().front().id();
  PixelBuffer pixels(2, 1, PixelFormat::rgba8());
  pixels.pixel(0, 0)[0] = 10;
  pixels.pixel(0, 0)[3] = 255;
  pixels.pixel(1, 0)[0] = 20;
  pixels.pixel(1, 0)[3] = 255;
  const auto added = session.execute(
      AddPixelLayer{"Second", std::move(pixels), original_id});
  CHECK(static_cast<bool>(added));
  const auto second_id = added.affected_layer_id;

  CHECK(static_cast<bool>(
      session.execute(SetLayersOpacity{{original_id, second_id}, 0.5F})));
  CHECK(static_cast<bool>(session.execute(
      SetLayersFillOpacity{{original_id, second_id}, 0.75F})));
  CHECK(static_cast<bool>(session.execute(SetLayersBlendMode{
      {original_id, second_id}, patchy::BlendMode::Multiply})));
  CHECK(session.document().find_layer(second_id)->opacity() == 0.5F);

  const auto grouped =
      session.execute(AddGroup{"Group", {second_id, original_id}});
  CHECK(static_cast<bool>(grouped));
  const auto group_id = grouped.affected_layer_id;
  const auto *group = session.document().find_layer(group_id);
  CHECK(group != nullptr);
  CHECK(group->children().size() == 2);
  CHECK(group->children().front().id() == original_id);
  CHECK(group->children().back().id() == second_id);

  CHECK(static_cast<bool>(session.execute(UngroupLayers{{group_id}})));
  CHECK(session.document().find_layer(group_id) == nullptr);
  const auto destination = session.execute(AddGroup{"Destination", {}});
  CHECK(static_cast<bool>(destination));
  CHECK(static_cast<bool>(session.execute(PlaceLayers{
      {second_id}, destination.affected_layer_id, 0})));
  CHECK(session.document().find_layer(destination.affected_layer_id)
            ->children()
            .front()
            .id() == second_id);
  CHECK(static_cast<bool>(
      session.execute(FlipLayers{{second_id}, FlipAxis::Horizontal})));
  const auto *flipped = session.document().find_layer(second_id);
  CHECK(flipped != nullptr);
  CHECK(flipped->pixels().pixel(0, 0)[0] == 20);
  CHECK(flipped->pixels().pixel(1, 0)[0] == 10);

  const auto state_before_rejection = session.state_id();
  CHECK(!static_cast<bool>(
      session.execute(SetLayersOpacity{{second_id, 999999}, 0.25F})));
  CHECK(session.state_id() == state_before_rejection);
  CHECK(session.document().find_layer(second_id)->opacity() == 0.5F);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().find_layer(second_id)->pixels().pixel(0, 0)[0] ==
        10);
}

void engine_session_filter_and_pixel_commands_share_atomic_history() {
  DocumentSession session(make_session_document());
  const auto layer_id = session.document().layers().front().id();
  patchy::FilterRegistry registry;
  patchy::register_builtin_filters(registry);
  auto invert = registry.default_invocation("patchy.filters.invert");

  auto blur = registry.default_invocation("patchy.filters.gaussian_blur");
  patchy::FilterProgress cancelled_progress{
      [](int, int, patchy::FilterProgressStage) { return false; }};
  const auto state_before_cancel = session.state_id();
  const auto cancelled = session.execute(
      ApplyFilter{layer_id, std::move(blur), {}}, &cancelled_progress);
  CHECK(!static_cast<bool>(cancelled));
  CHECK(cancelled.error.code == SessionErrorCode::Cancelled);
  CHECK(session.state_id() == state_before_cancel);
  CHECK(session.undo_size() == 0);

  const auto filtered = session.execute(
      ApplyFilter{layer_id, std::move(invert), {{0, 0, 1, 1}}});
  CHECK(static_cast<bool>(filtered));
  CHECK(filtered.affected_region.has_value());
  const auto *layer = session.document().find_layer(layer_id);
  CHECK(layer != nullptr);
  CHECK(layer->pixels().pixel(0, 0)[0] == 243);
  CHECK(layer->pixels().pixel(1, 0)[0] == 12);
  CHECK(static_cast<bool>(session.undo()));
  CHECK(session.document().find_layer(layer_id)->pixels().pixel(0, 0)[0] ==
        12);

  auto replacement = session.document().find_layer(layer_id)->pixels();
  replacement.pixel(1, 1)[1] = 99;
  const auto replaced = session.execute(ReplaceLayerPixels{
      layer_id, std::move(replacement), {4, 5, 2, 2}});
  CHECK(static_cast<bool>(replaced));
  CHECK(session.document().find_layer(layer_id)->bounds().x == 4);
  const auto encoded = session.encode_psd();
  CHECK(static_cast<bool>(encoded));
  const auto reopened = open_psd(encoded.bytes);
  CHECK(static_cast<bool>(reopened));
  const auto *reopened_layer = reopened.session->document().find_layer(layer_id);
  CHECK(reopened_layer != nullptr);
  CHECK(reopened_layer->bounds().x == 4);
  CHECK(reopened_layer->pixels().pixel(1, 1)[1] == 99);
  const auto state_before_rejection = session.state_id();
  const auto rejected = session.execute(ReplaceLayerPixels{
      layer_id, PixelBuffer(1, 1, PixelFormat::rgba8()), {0, 0, 2, 2}});
  CHECK(!static_cast<bool>(rejected));
  CHECK(rejected.error.code == SessionErrorCode::InvalidArgument);
  CHECK(session.state_id() == state_before_rejection);
  CHECK(session.document().find_layer(layer_id)->bounds().x == 4);
}

} // namespace

std::vector<TestCase> document_session_tests() {
  return {
      {"engine_session_commands_history_dirty_and_events",
       engine_session_commands_history_dirty_and_events},
      {"engine_session_rejects_invalid_commands_without_mutation",
       engine_session_rejects_invalid_commands_without_mutation},
      {"engine_session_projects_and_moves_layer_tree",
       engine_session_projects_and_moves_layer_tree},
      {"engine_session_layer_lifecycle_and_document_geometry_are_atomic",
       engine_session_layer_lifecycle_and_document_geometry_are_atomic},
      {"engine_session_crop_and_wrap_geometry_are_atomic_and_restore_selection",
       engine_session_crop_and_wrap_geometry_are_atomic_and_restore_selection},
      {"engine_session_rejects_non_atomic_lifecycle_commands",
       engine_session_rejects_non_atomic_lifecycle_commands},
      {"engine_session_headless_psd_open_edit_save_reopen",
       engine_session_headless_psd_open_edit_save_reopen},
      {"engine_session_renders_bounded_rgba_regions_and_cancels",
       engine_session_renders_bounded_rgba_regions_and_cancels},
      {"engine_session_external_shell_adapter_preserves_state_identity",
       engine_session_external_shell_adapter_preserves_state_identity},
      {"engine_selection_snapshot_is_qt_free_and_accounts_retained_bytes",
       engine_selection_snapshot_is_qt_free_and_accounts_retained_bytes},
      {"engine_session_selection_is_canonical_undoable_and_not_dirty",
       engine_session_selection_is_canonical_undoable_and_not_dirty},
      {"engine_session_selection_operations_are_qt_free_and_undoable",
       engine_session_selection_operations_are_qt_free_and_undoable},
      {"engine_session_layer_derived_selection_preserves_soft_coverage",
       engine_session_layer_derived_selection_preserves_soft_coverage},
      {"engine_session_similarity_and_path_selection_are_canonical",
       engine_session_similarity_and_path_selection_are_canonical},
      {"engine_session_layer_editing_vertical_slice_is_atomic_and_undoable",
       engine_session_layer_editing_vertical_slice_is_atomic_and_undoable},
      {"engine_session_filter_and_pixel_commands_share_atomic_history",
       engine_session_filter_and_pixel_commands_share_atomic_history},
  };
}
